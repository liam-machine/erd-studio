/**
 * The canvas's one relationship write path (issue #133): every relationship
 * message goes through `planRelationshipCommit` and one WorkspaceEdit, in the
 * project's mode, finding a link by core's `linkKey` (either way round,
 * without case); a model file it cannot safely write is refused by name; the
 * editable logical payload carries where relationships live, what needs
 * attention and dbt's test evidence; the banner's `repairRelationships`
 * message runs the command; and a commit that changes only a model file is
 * still one step of the canvas's undo.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { stripRelationshipProvenance } from '@erd-studio/core';

import {
  createMockWebviewPanel,
  createMockTextDocument,
  _resetMockWorkspace,
  _appliedEdits,
  type MockTextDocument,
  type WorkspaceEdit as MockWorkspaceEdit,
} from '../__mocks__/vscode';
import { PHYSICAL_READ_ONLY_MESSAGE, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { DisplayDomain } from '../../src/types/display';
import type { Relationship, SemanticModel } from '../../src/types/semantic';

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, dataType: 'string', description: '', ...extra });
const FCT_ORDER: SemanticModel = {
  name: 'fct_order',
  columns: [col('order_key', { isPrimaryKey: true }), col('customer_key'), col('date_key')],
};
const DIM_CUSTOMER: SemanticModel = { name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true })] };
const DIM_DATE: SemanticModel = { name: 'dim_date', columns: [col('date_key', { isPrimaryKey: true })] };

const EDGE = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' } as const;
const REVERSED = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' } as const;
const ENTRY = { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' } as const;

interface Panel {
  send: (message: unknown) => Promise<void>;
  errors: () => string[];
  posted: () => Array<{ type: string; payload?: unknown }>;
  document: MockTextDocument;
}

interface Harness {
  root: string;
  domainService: DomainService;
  models: LogicalModelService;
  domainPath: (name: string) => string;
  modelPath: (name: string) => string;
  open: (name: string) => Promise<Panel>;
  readDomain: (name: string) => { logical: { models: string[]; relationships: Relationship[] }; viewConfig: { positions: Record<string, { x: number; y: number }> } };
  shown: (name: string) => Relationship[];
  model: (name: string) => SemanticModel | null;
}

async function createHarness(options: { orders?: Relationship[]; reporting?: Relationship[]; library?: Record<string, SemanticModel['relationships']> } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rel-commit-'));
  const semanticDir = '.erd-studio';
  const layerService = new LayerService(root, semanticDir);
  const domainService = new DomainService(layerService);
  const models = new LogicalModelService(root, semanticDir);
  domainService.setLogicalModelService(models);
  const selectorsService = new SelectorsService(domainService, root, semanticDir);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);

  for (const model of [FCT_ORDER, DIM_CUSTOMER, DIM_DATE]) {
    const relationships = options.library?.[model.name];
    models.saveModel({ ...structuredClone(model), ...(relationships ? { relationships } : {}) });
  }

  const domainDir = path.join(root, semanticDir, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPath = (name: string) => path.join(domainDir, `${name}.json`);
  const writeDomain = (name: string, names: string[], relationships: Relationship[] = []) =>
    fs.writeFileSync(domainPath(name), JSON.stringify({
      schemaVersion: 5, domain: name, layer: 'silver', description: '',
      logical: { models: names, relationships },
      viewConfig: { positions: Object.fromEntries(names.map((m, i) => [m, { x: i * 300, y: 0 }])) },
    }, null, 2) + '\n');
  writeDomain('orders', ['fct_order', 'dim_customer', 'dim_date'], options.orders);
  writeDomain('reporting', ['fct_order', 'dim_customer'], options.reporting);

  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => undefined, update: async () => undefined },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, models, new OwnWriteTracker(),
  );

  return {
    root,
    domainService,
    models,
    domainPath,
    modelPath: (name) => models.modelPath(name),
    open: async (name) => {
      const document = createMockTextDocument(domainPath(name), fs.readFileSync(domainPath(name), 'utf-8'), { persist: true });
      const panel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
      );
      return {
        document,
        send: async (message) => {
          _appliedEdits.length = 0;
          panel._postedMessages.length = 0;
          await panel._simulateMessage(message);
        },
        errors: () => panel._postedMessages
          .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
          .map((m) => m.payload.message),
        posted: () => panel._postedMessages as Array<{ type: string; payload?: unknown }>,
      };
    },
    readDomain: (name) => JSON.parse(fs.readFileSync(domainPath(name), 'utf-8')),
    shown: (name) => {
      models.invalidateCache();
      return domainService.getDomain(domainPath(name)).logical.relationships.map((rel) => stripRelationshipProvenance(rel) as Relationship);
    },
    model: (name) => {
      models.invalidateCache();
      return models.getModel(name);
    },
  };
}

let h: Harness;
beforeEach(() => { _resetMockWorkspace(); });
afterEach(() => {
  vi.restoreAllMocks();
  if (h) fs.rmSync(h.root, { recursive: true, force: true });
});

describe('one write path, in the project\'s mode', () => {
  it('removing a link stored twice — on the fact, and on the dimension as one-to-many — removes both in one edit (D6)', async () => {
    h = await createHarness({
      library: {
        fct_order: [{ ...ENTRY }],
        dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }],
      },
    });
    const orders = await h.open('orders');
    await orders.send({ type: 'removeRelationship', payload: EDGE });

    expect(orders.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(h.model('fct_order')?.relationships).toBeUndefined();
    expect(h.model('dim_customer')?.relationships).toBeUndefined();
    expect(h.shown('reporting')).toEqual([]);
  });

  it('removing by the stored ends (the dimension\'s one-to-many) works the same', async () => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
    });
    const orders = await h.open('orders');
    await orders.send({ type: 'removeRelationship', payload: { ...EDGE, stored: REVERSED } });
    expect(orders.errors()).toEqual([]);
    expect(h.model('dim_customer')?.relationships).toBeUndefined();
  });

  it('refuses stored ends that name another link', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    const orders = await h.open('orders');
    await orders.send({ type: 'removeRelationship', payload: { ...EDGE, stored: { ...REVERSED, toColumn: 'order_key' } } });
    expect(orders.errors()).toEqual(['Failed to remove relationship: the stored ends name a different relationship from the one drawn.']);
    expect(h.model('fct_order')?.relationships).toEqual([ENTRY]);
  });

  it('refuses a payload whose ends are not text', async () => {
    h = await createHarness();
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...EDGE, toColumn: 3, cardinality: 'many-to-one' } });
    expect(orders.errors()).toEqual(["Failed to add relationship: the relationship's ends are not valid."]);
    expect(_appliedEdits).toHaveLength(0);
  });

  it('per-domain project: an update rewrites the domain record canonical, in place, and never writes the library (R3)', async () => {
    const other: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    h = await createHarness({ orders: [{ ...REVERSED, cardinality: 'one-to-many', role: 'buyer' }, other] });
    const fctBefore = fs.readFileSync(h.modelPath('fct_order'), 'utf-8');
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });

    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...EDGE, cardinality: 'one-to-one', role: 'buyer' }, other]);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(fctBefore);
  });

  it('per-domain project: an entry the reader skips keeps its slot through a remove, an update and an add', async () => {
    const unreadable = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', note: 'no toColumn' };
    const toCustomer: Relationship = { ...EDGE, cardinality: 'many-to-one' };
    const toDate: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    h = await createHarness({ orders: [unreadable as unknown as Relationship, toCustomer, toDate] });
    const orders = await h.open('orders');

    await orders.send({ type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key' } });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([unreadable, toCustomer]);

    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([unreadable, { ...EDGE, cardinality: 'one-to-one' }]);

    await orders.send({ type: 'addRelationship', payload: { ...toDate } });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([unreadable, { ...EDGE, cardinality: 'one-to-one' }, toDate]);
  });

  it('per-domain project: an update in place keeps an unreadable entry that follows it where it was', async () => {
    const unreadable = { fromModel: 'fct_order', fromColumn: 'customer_key', note: 'no to end' };
    const toCustomer: Relationship = { ...EDGE, cardinality: 'many-to-one' };
    const toDate: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    h = await createHarness({ orders: [toCustomer, unreadable as unknown as Relationship, toDate] });
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...EDGE, cardinality: 'one-to-one' }, unreadable, toDate]);
  });

  it('per-domain project: a column rename and a model removal follow relationships spelled in another case (D7)', async () => {
    h = await createHarness({ orders: [{ fromModel: 'FCT_ORDER', fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }] });
    const orders = await h.open('orders');
    await orders.send({
      type: 'updateColumn',
      payload: { modelName: 'fct_order', oldColumnName: 'customer_key', column: { name: 'cust_key', dataType: 'string', description: '' } },
    });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships[0].fromColumn).toBe('cust_key');
    await orders.send({ type: 'removeModels', payload: { modelNames: ['dim_customer'] } });
    expect(h.readDomain('orders').logical.relationships).toEqual([]);
  });

  it('marks the dialog\'s key in the same commit — one WorkspaceEdit, one undo step', async () => {
    h = await createHarness();
    const dim = h.model('dim_customer')!;
    h.models.saveModel({ ...dim, columns: [col('customer_key')] });
    const orders = await h.open('orders');
    await orders.send({
      type: 'addRelationship',
      payload: { ...EDGE, cardinality: 'many-to-one', markKey: { model: 'dim_customer', column: 'customer_key' } },
    });

    expect(orders.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(h.model('dim_customer')?.columns?.[0].isPrimaryKey).toBe(true);
    expect(h.model('fct_order')?.relationships).toEqual([ENTRY]);
  });

  it('after a remove, names other diagrams still drawing the link from their own copy', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] }, reporting: [{ ...REVERSED, cardinality: 'one-to-many' }] });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await h.open('orders');
    await orders.send({ type: 'removeRelationship', payload: EDGE });

    expect(orders.errors()).toEqual([]);
    expect(info).toHaveBeenCalledWith(
      'Still drawn in silver/reporting.json from its own copy — Repair Relationships… removes it.',
      'Repair Relationships…',
    );
    expect(h.readDomain('reporting').logical.relationships).toHaveLength(1);
  });
});

describe('model files a commit may not write are refused, by name', () => {
  it('an endpoint file open with unsaved changes', async () => {
    h = await createHarness();
    const yml = await vscode.workspace.openTextDocument(h.modelPath('fct_order')) as unknown as MockTextDocument;
    yml._setText(`${yml.getText()}# typing…\n`);
    const before = fs.readFileSync(h.modelPath('fct_order'), 'utf-8');
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

    expect(orders.errors()).toEqual([
      'Failed to add relationship: logical-models/fct_order.yml has unsaved changes. Save or revert it first, then try again.',
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(before);
  });

  it('an endpoint file that cannot be read', async () => {
    h = await createHarness();
    fs.writeFileSync(h.modelPath('dim_customer'), 'name: dim_customer\ncolumns: [\n');
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

    expect(orders.errors()).toHaveLength(1);
    expect(orders.errors()[0]).toMatch(/^Failed to add relationship: logical-models\/dim_customer\.yml has a YAML error( on line \d+)?\. Fix the file first, then try again\.$/);
    expect(_appliedEdits).toHaveLength(0);
  });
});

describe('a commit never destroys what it did not understand (D4, end to end)', () => {
  const FCT_FILE = `name: fct_order
columns:
  - name: order_key
    dataType: string
    isPrimaryKey: true
  - name: customer_key
    dataType: string
  - name: date_key
    dataType: string
relationships:
  - fromColumn: customer_key # the buyer
    toModel: dim_customer
    toColumn: customer_key
    cardinality: one_to_many
    x-owner: sales
  - ask Sam about this one
`;

  it('adding another relationship keeps the typo, the comment, the unknown key and the unreadable entry', async () => {
    h = await createHarness();
    fs.writeFileSync(h.modelPath('fct_order'), FCT_FILE);
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } });

    expect(orders.errors()).toEqual([]);
    const text = fs.readFileSync(h.modelPath('fct_order'), 'utf-8');
    expect(text.startsWith(FCT_FILE)).toBe(true);
    expect(text.slice(FCT_FILE.length)).toBe('  - fromColumn: date_key\n    toModel: dim_date\n    toColumn: date_key\n    cardinality: many-to-one\n');
  });

  it('editing the entry with the typo rewrites that entry\'s cardinality, and nothing else', async () => {
    h = await createHarness();
    fs.writeFileSync(h.modelPath('fct_order'), FCT_FILE);
    const orders = await h.open('orders');
    const original = { originalFromModel: EDGE.fromModel, originalFromColumn: EDGE.fromColumn, originalToModel: EDGE.toModel, originalToColumn: EDGE.toColumn };
    await orders.send({ type: 'editRelationship', payload: { ...original, ...EDGE, cardinality: 'many-to-one', role: '' } });

    expect(orders.errors()).toEqual([]);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(FCT_FILE.replace('cardinality: one_to_many', 'cardinality: many-to-one'));
  });
});

describe('the editable logical payload (#133, R5 / R7)', () => {
  it('says where relationships live, what needs attention, and what dbt\'s tests say per column', async () => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
    });
    const empty = await new YmlParserService().loadYmlData(h.root, undefined);
    vi.spyOn(YmlParserService.prototype, 'loadYmlData').mockResolvedValue({
      ...empty,
      uniqueColumns: new Map([['dim_customer', new Set(['customer_key'])]]),
      compositeUniqueGroups: new Map([['fct_order', [['order_key', 'date_key']]]]),
      relationshipTests: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' }],
    });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await h.open('orders');
    await orders.send({ type: 'ready' });

    const loaded = orders.posted().find((m) => m.type === 'domainLoaded')!.payload as DisplayDomain;
    expect(loaded.relationshipHome).toBe('library');
    expect(loaded.relationshipIssues?.map((i) => i.code)).toEqual(['REL002']);
    expect(loaded.relationshipIssues?.[0].message).toContain('.erd-studio/logical-models/dim_customer.yml');
    const columns = (model: string) => loaded.models.find((m) => m.name === model)!.columns;
    expect(columns('dim_customer')[0].dbtEvidence).toEqual({ unique: true });
    expect(columns('fct_order').find((c) => c.name === 'customer_key')?.dbtEvidence).toEqual({
      relationshipsTest: true,
      relationshipsTo: [{ model: 'dim_customer', column: 'customer_key' }],
    });
    expect(columns('fct_order').find((c) => c.name === 'order_key')?.dbtEvidence).toEqual({ inCompositeUnique: true });
    expect(loaded.relationships.map((r) => r.issues)).toEqual([['REL002']]);
  });

  it('a project keeping relationships per diagram says so, and a clean one carries no issues', async () => {
    h = await createHarness({ orders: [{ ...EDGE, cardinality: 'many-to-one' }] });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await h.open('orders');
    await orders.send({ type: 'ready' });
    const loaded = orders.posted().find((m) => m.type === 'domainLoaded')!.payload as DisplayDomain;
    expect(loaded.relationshipHome).toBe('domain');
    expect(loaded.relationshipIssues).toBeUndefined();
  });
});

describe('the canvas banner: repairRelationships', () => {
  it('runs Repair Relationships… on the logical stage', async () => {
    h = await createHarness();
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const orders = await h.open('orders');
    await orders.send({ type: 'repairRelationships' });
    expect(orders.errors()).toEqual([]);
    expect(run).toHaveBeenCalledWith('erdStudio.repairRelationships');
  });

  it('is refused with a payload, and on the physical stage (it is not on the allowlist)', async () => {
    h = await createHarness();
    const run = vi.spyOn(vscode.commands, 'executeCommand');
    const orders = await h.open('orders');
    await orders.send({ type: 'repairRelationships', payload: { all: true } });
    expect(orders.errors()).toEqual(['Repair Relationships takes no payload.']);
    await orders.send({ type: 'switchStage', payload: { stage: 'physical' } });
    await orders.send({ type: 'repairRelationships' });
    expect(orders.errors()).toEqual([PHYSICAL_READ_ONLY_MESSAGE]);
    expect(run).not.toHaveBeenCalledWith('erdStudio.repairRelationships');
  });
});

describe('undo (R12)', () => {
  /**
   * VS Code's custom-editor undo acts on the domain document's undo stack; a
   * WorkspaceEdit touching the domain and a model file is ONE element of it
   * and undoing it reverts both. Simulated here: every applied edit that
   * includes the domain document is pushed, and `undo` restores the texts the
   * last one replaced.
   */
  it('a commit that changes only a model file is undone by the canvas undo — not the domain edit before it', async () => {
    h = await createHarness();
    const domainFile = h.domainPath('orders');
    const stack: Array<Map<string, string>> = [];
    const apply = vscode.workspace.applyEdit.bind(vscode.workspace);
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      const before = new Map<string, string>();
      for (const op of (edit as unknown as MockWorkspaceEdit)._ops) {
        if (op.kind !== 'replace') continue;
        const doc = await vscode.workspace.openTextDocument(op.uri.fsPath);
        before.set(op.uri.fsPath, doc.getText());
      }
      const ok = await apply(edit);
      if (ok && before.has(domainFile)) stack.push(before);
      return ok;
    });
    const undo = vscode.commands.registerCommand('undo', async () => {
      const group = stack.pop();
      for (const [file, text] of group ?? []) {
        const doc = await vscode.workspace.openTextDocument(file) as unknown as MockTextDocument;
        doc._setText(text);
      }
    });
    try {
      const orders = await h.open('orders');
      // 1. A domain-only edit.
      await orders.send({ type: 'updatePositions', payload: { positions: { fct_order: { x: 999, y: 111 } } } });
      // 2. A relationship commit that changes only fct_order.yml (library mode).
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      expect(h.model('fct_order')?.relationships).toEqual([ENTRY]);
      expect(h.readDomain('orders').logical.relationships).toEqual([]);
      // 3. Undo on the canvas.
      await orders.send({ type: 'undo' });

      expect(orders.errors()).toEqual([]);
      expect(h.model('fct_order')?.relationships).toBeUndefined();
      expect(h.readDomain('orders').viewConfig.positions.fct_order).toEqual({ x: 999, y: 111 });
    } finally {
      undo.dispose();
    }
  });

  it('an undo refreshes every other open diagram that draws the reverted model files', async () => {
    h = await createHarness();
    const domainFile = h.domainPath('orders');
    const stack: Array<Map<string, string>> = [];
    const apply = vscode.workspace.applyEdit.bind(vscode.workspace);
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      const before = new Map<string, string>();
      for (const op of (edit as unknown as MockWorkspaceEdit)._ops) {
        if (op.kind !== 'replace') continue;
        const doc = await vscode.workspace.openTextDocument(op.uri.fsPath);
        before.set(op.uri.fsPath, doc.getText());
      }
      const ok = await apply(edit);
      if (ok && before.has(domainFile)) stack.push(before);
      return ok;
    });
    const undo = vscode.commands.registerCommand('undo', async () => {
      for (const [file, text] of stack.pop() ?? []) {
        (await vscode.workspace.openTextDocument(file) as unknown as MockTextDocument)._setText(text);
      }
    });
    const lastDrawn = (panel: Panel): Relationship[] | undefined => {
      const loaded = panel.posted().filter((m) => m.type === 'domainLoaded');
      return (loaded[loaded.length - 1]?.payload as DisplayDomain | undefined)?.relationships as Relationship[] | undefined;
    };
    try {
      const orders = await h.open('orders');
      const reporting = await h.open('reporting');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      expect(lastDrawn(reporting)?.map((r) => r.fromModel)).toEqual(['fct_order']);
      reporting.posted().length = 0;
      await orders.send({ type: 'undo' });
      expect(h.model('fct_order')?.relationships).toBeUndefined();
      // The other diagram no longer draws the link the undo took away.
      expect(lastDrawn(reporting)).toEqual([]);
    } finally {
      undo.dispose();
    }
  });
});

describe('every other writer of a model file refuses the same files a commit does', () => {
  const dirty = async (name: string): Promise<string> => {
    const yml = await vscode.workspace.openTextDocument(h.modelPath(name)) as unknown as MockTextDocument;
    yml._setText(`${yml.getText()}# typing…\n`);
    return fs.readFileSync(h.modelPath(name), 'utf-8');
  };
  /** dbt says fct_order.customer_key → dim_customer.customer_key. */
  const dbtSaysFactToCustomer = () => {
    const tests = {
      relationshipTests: [{ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' }],
      uniqueColumns: new Map([['dim_customer', new Set(['customer_key'])]]),
      compositeUniqueGroups: new Map(),
    };
    vi.spyOn(YmlParserService.prototype, 'loadYmlData').mockResolvedValue({ models: new Map(), sourceFiles: new Map(), ...tests } as never);
    vi.spyOn(ManifestService.prototype, 'loadManifest').mockResolvedValue({ models: new Map(), disabledModels: new Set(), ...tests, relationshipTests: [] } as never);
  };
  const writeSolo = () => fs.writeFileSync(h.domainPath('solo'), JSON.stringify({
    schemaVersion: 5, domain: 'solo', layer: 'silver', description: '',
    logical: { models: ['dim_customer'], relationships: [] },
    viewConfig: { positions: { dim_customer: { x: 0, y: 0 } } },
  }, null, 2) + '\n');

  it('a column rename does not overwrite the unsaved edits of a model whose relationship follows it', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    const before = await dirty('fct_order');
    const orders = await h.open('orders');
    await orders.send({
      type: 'updateColumn',
      payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } },
    });

    expect(orders.errors().join(' ')).toContain('logical-models/fct_order.yml has unsaved changes. Save or revert it first, then try again.');
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(before);
    expect(h.model('dim_customer')?.columns?.[0].name).toBe('customer_key');
  });

  it('a model rename does not overwrite the unsaved edits of a model pointing at it', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    const before = await dirty('fct_order');
    const orders = await h.open('orders');
    await orders.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });

    expect(orders.errors().join(' ')).toContain('logical-models/fct_order.yml has unsaved changes.');
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(before);
    expect(h.model('dim_customer')).not.toBeNull();
  });

  it('Add Existing Model does not overwrite the unsaved edits of the model its relationship is routed into', async () => {
    h = await createHarness();
    dbtSaysFactToCustomer();
    writeSolo();
    const before = await dirty('fct_order');
    const solo = await h.open('solo');
    await solo.send({ type: 'addExistingModel', payload: { modelName: 'fct_order' } });

    expect(solo.errors().join(' ')).toContain('logical-models/fct_order.yml has unsaved changes.');
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.modelPath('fct_order'), 'utf-8')).toBe(before);
    expect(h.readDomain('solo').logical.models).toEqual(['dim_customer']);
  });

  it('Add Existing Model refuses, by name, a from-model file it cannot read rather than storing the link in the diagram', async () => {
    h = await createHarness();
    dbtSaysFactToCustomer();
    writeSolo();
    fs.writeFileSync(h.modelPath('fct_order'), 'name: fct_order\ncolumns: [\n');
    const solo = await h.open('solo');
    await solo.send({ type: 'addExistingModel', payload: { modelName: 'fct_order' } });

    expect(solo.errors()).toHaveLength(1);
    expect(solo.errors()[0]).toMatch(/logical-models\/fct_order\.yml has a YAML error( on line \d+)?\. Fix the file first, then try again\.$/);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.readDomain('solo').logical).toEqual({ models: ['dim_customer'], relationships: [] });
  });

  it('Add Existing Model refuses a to-model file it cannot read, which might already store the link', async () => {
    h = await createHarness();
    dbtSaysFactToCustomer();
    fs.writeFileSync(h.domainPath('solo'), JSON.stringify({
      schemaVersion: 5, domain: 'solo', layer: 'silver', description: '',
      logical: { models: ['dim_date'], relationships: [] },
      viewConfig: { positions: { dim_date: { x: 0, y: 0 } } },
    }, null, 2) + '\n');
    // dim_customer is not in this domain, so no relationship is added: nothing to refuse.
    fs.writeFileSync(h.modelPath('dim_customer'), 'name: dim_customer\ncolumns: [\n');
    const solo = await h.open('solo');
    await solo.send({ type: 'addExistingModel', payload: { modelName: 'fct_order' } });
    expect(solo.errors()).toEqual([]);

    // With dim_customer in the domain, the link is added — and its other end cannot be read.
    writeSolo();
    const fresh = await h.open('solo');
    await fresh.send({ type: 'addExistingModel', payload: { modelName: 'fct_order' } });
    expect(fresh.errors()).toHaveLength(1);
    expect(fresh.errors()[0]).toMatch(/logical-models\/dim_customer\.yml has a YAML error/);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.model('fct_order')?.relationships).toBeUndefined();
  });
});

describe('the relationship checks on each payload read the domain files once', () => {
  it('builds the mode from the same scan as the findings — no second pass over every domain file', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const orders = await h.open('orders');
    await orders.send({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 20));
    const count = vi.spyOn(DomainService.prototype, 'countDomainFileRelationships');
    await orders.send({ type: 'switchStage', payload: { stage: 'logical', requestId: 1 } });
    const payload = orders.posted().find((m) => m.type === 'stageData' || m.type === 'domainLoaded')?.payload as DisplayDomain | undefined;
    expect(payload?.relationshipHome).toBe('library');
    expect(count).not.toHaveBeenCalled();
  });
});

describe('nothing the user wrote is lost by a canvas commit (#133 review 6)', () => {
  it('per-domain project: a cardinality change keeps the entry\'s own keys', async () => {
    const toDate: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const mine = { ...EDGE, cardinality: 'many-to-one', role: 'x', description: 'keep me', tests: ['a'] };
    h = await createHarness({ orders: [mine as unknown as Relationship, toDate] });
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...mine, cardinality: 'one-to-one' }, toDate]);
  });

  it('per-domain project: adding to a logical.relationships that is not a list is refused, and the file is untouched', async () => {
    const toDate: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    h = await createHarness({ reporting: [toDate] });
    const handWritten = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
    const raw = JSON.parse(fs.readFileSync(h.domainPath('orders'), 'utf-8'));
    raw.logical.relationships = handWritten;
    fs.writeFileSync(h.domainPath('orders'), JSON.stringify(raw, null, 2) + '\n');
    const before = fs.readFileSync(h.domainPath('orders'), 'utf-8');
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...toDate } });
    expect(orders.errors()).toEqual([
      'Failed to add relationship: orders.json: "logical.relationships" is not a list, so ERD Studio cannot write to it. Fix it by hand first.',
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.domainPath('orders'), 'utf-8')).toBe(before);
  });

  it('library project: turning a relationship whose entry carries a comment into another model file is refused, by name', async () => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
    });
    // A comment inside the entry: moving it to fct_order's file would lose it.
    const file = h.modelPath('dim_customer');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('cardinality: one-to-many', 'cardinality: one-to-many # agreed with finance'));
    h.models.invalidateCache();
    const before = fs.readFileSync(file, 'utf-8');
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'many-to-many' } });
    expect(orders.errors()).toEqual([
      "Failed to update relationship: Entry 1 of dim_customer's model file has comments, which changing this relationship here would remove. " +
      'Move that text out of the entry or make the change by hand, then try again.',
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
  });

  it.each([
    ['a comment indented under the entry at its end', (text: string) => text.replace(
      /^(\s*)cardinality: one-to-many$/m, (_m, indent: string) => `${indent}cardinality: one-to-many\n${indent}# Agreed with finance 2024-03`,
    )],
    ['a flow entry\'s trailing comment', (text: string) => text.replace(
      /relationships:[\s\S]*$/,
      'relationships:\n  - { fromColumn: customer_key, toModel: fct_order, toColumn: customer_key, cardinality: one-to-many } # legacy SAP link, keep\n',
    )],
  ])('library project: an entry carrying %s is refused, never moved with the comment dropped (#133 review)', async (_label, addComment) => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
    });
    const file = h.modelPath('dim_customer');
    const commented = addComment(fs.readFileSync(file, 'utf-8'));
    expect(commented).toMatch(/# (Agreed|legacy)/);
    fs.writeFileSync(file, commented);
    h.models.invalidateCache();
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'many-to-many' } });
    expect(orders.errors()).toEqual([
      "Failed to update relationship: Entry 1 of dim_customer's model file has comments, which changing this relationship here would remove. " +
      'Move that text out of the entry or make the change by hand, then try again.',
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(commented);
  });

  it('library project: a link stored twice with different roles is refused, not quietly merged', async () => {
    h = await createHarness({
      library: {
        fct_order: [{ ...ENTRY }],
        dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many', role: 'ship date' }],
      },
    });
    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toHaveLength(1);
    expect(orders.errors()[0]).toMatch(/copies disagree.*Repair Relationships…/);
    expect(h.model('dim_customer')?.relationships?.[0]).toMatchObject({ role: 'ship date' });
    expect(h.model('fct_order')?.relationships).toEqual([ENTRY]);
  });
});

describe('cascades never skip a model file they cannot read (#133 review 6)', () => {
  const brokenOrders = 'name: orders\ncolumns: [\nrelationships:\n  - fromColumn: customer_id\n    toModel: dim_customer\n    toColumn: customer_key\n';
  const setUp = async (brokenText: string) => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    fs.writeFileSync(path.join(path.dirname(h.modelPath('fct_order')), 'orders.yml'), brokenText);
    h.models.invalidateCache();
    return h.open('orders');
  };

  it('refuses a column rename while an unreadable model file names the model', async () => {
    const orders = await setUp(brokenOrders);
    const before = fs.readFileSync(h.modelPath('dim_customer'), 'utf-8');
    await orders.send({
      type: 'updateColumn',
      payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'cust_key', dataType: 'string', description: '' } },
    });
    expect(orders.errors()).toEqual([
      'Failed to update column: logical-models/orders.yml could not be read, so a relationship it holds to dim_customer would keep ' +
      'pointing at the old name after this column rename. Fix that file first, then try again.',
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.modelPath('dim_customer'), 'utf-8')).toBe(before);
  });

  it('refuses a column removal and a model rename the same way', async () => {
    const orders = await setUp(brokenOrders);
    await orders.send({ type: 'removeColumn', payload: { modelName: 'dim_customer', columnName: 'customer_key' } });
    expect(orders.errors()[0]).toMatch(/^Failed to remove column: logical-models\/orders\.yml could not be read/);
    await orders.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
    expect(orders.errors()[0]).toMatch(/^Failed to rename model: logical-models\/orders\.yml could not be read.*after this rename/);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.model('dim_customer')).not.toBeNull();
  });

  it('goes ahead when the unreadable file does not name the model', async () => {
    const orders = await setUp('name: orders\ncolumns: [\n');
    await orders.send({
      type: 'updateColumn',
      payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'cust_key', dataType: 'string', description: '' } },
    });
    expect(orders.errors()).toEqual([]);
    expect(h.model('fct_order')?.relationships).toEqual([{ ...ENTRY, toColumn: 'cust_key' }]);
  });
});

describe('a model file with a YAML error never switches where relationships are kept (#133 review)', () => {
  it('a new relationship between two healthy models still goes to the model library', async () => {
    const leftover: Relationship = { fromModel: 'fct_order', fromColumn: 'date_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] }, reporting: [leftover] });
    // The only model file holding relationships gets a merge-conflict marker.
    const fct = h.modelPath('fct_order');
    fs.writeFileSync(fct, `<<<<<<< HEAD\n${fs.readFileSync(fct, 'utf-8')}=======\nname: fct_order\n>>>>>>> theirs\n`);
    h.models.invalidateCache();
    expect(h.models.relationshipModeInputs().unreadableWithRelationships).toBe(1);

    const orders = await h.open('orders');
    await orders.send({ type: 'switchStage', payload: { stage: 'logical', requestId: 1 } });
    const payload = orders.posted().find((m) => m.type === 'stageData' || m.type === 'domainLoaded')?.payload as DisplayDomain | undefined;
    expect(payload?.relationshipHome).toBe('library');

    const before = fs.readFileSync(h.domainPath('orders'), 'utf-8');
    await orders.send({
      type: 'addRelationship',
      payload: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' },
    });
    expect(orders.errors()).toEqual([]);
    expect(fs.readFileSync(h.domainPath('orders'), 'utf-8')).toBe(before);
    expect(h.model('dim_customer')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' },
    ]);
  });
});

describe('an older-format (v4) diagram with copies that disagree (#133 review)', () => {
  it('refuses the change by pointing at the migration, never at Repair Relationships… alone', async () => {
    h = await createHarness();
    const copy = { ...EDGE, cardinality: 'many-to-one' };
    fs.writeFileSync(h.domainPath('legacy'), JSON.stringify({
      schemaVersion: 4, domain: 'legacy', layer: 'silver', description: '',
      logical: { models: [structuredClone(FCT_ORDER), structuredClone(DIM_CUSTOMER)], relationships: [copy, { ...copy, role: 'buyer' }] },
      viewConfig: {},
    }, null, 2) + '\n');
    const before = fs.readFileSync(h.domainPath('legacy'), 'utf-8');
    const legacy = await h.open('legacy');
    await legacy.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(legacy.errors()).toHaveLength(1);
    expect(legacy.errors()[0]).toMatch(/older format: run "ERD Studio: Migrate Domains to Central Model Store", then "Repair Relationships…".*remove the extra entry from legacy\.json by hand\./);
    expect(fs.readFileSync(h.domainPath('legacy'), 'utf-8')).toBe(before);
  });
});

describe('the relationship checks cost one project scan, not one per model per panel (#133 review)', () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('another open diagram holding several touched models is re-sent once per edit', async () => {
    h = await createHarness({
      library: { dim_customer: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] },
    });
    const orders = await h.open('orders');
    const reporting = await h.open('reporting');
    await orders.send({ type: 'ready' });
    await reporting.send({ type: 'ready' });
    await settle();
    reporting.posted().length = 0;
    // A change that moves the entry from dim_customer.yml to fct_order.yml: both models are written.
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(h.model('dim_customer')?.relationships).toBeUndefined();
    expect(h.model('fct_order')?.relationships).toEqual([{ ...ENTRY, cardinality: 'one-to-one' }]);
    const sends = reporting.posted().filter((m) => m.type === 'domainLoaded' || m.type === 'stageData');
    expect(sends).toHaveLength(1);
  });

  it('reuses the findings between payloads while no file changed, and reads them again after an edit or a change on disk', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    const orders = await h.open('orders');
    await orders.send({ type: 'ready' });
    await settle();
    const scans = vi.spyOn(LogicalModelService.prototype, 'relationshipCheckModels');
    await orders.send({ type: 'switchStage', payload: { stage: 'logical', requestId: 1 } });
    await orders.send({ type: 'switchStage', payload: { stage: 'logical', requestId: 2 } });
    expect(scans).toHaveBeenCalledTimes(0);

    // An edit of ours: read again.
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    const afterEdit = scans.mock.calls.length;
    expect(afterEdit).toBeGreaterThan(0);

    // A model file changed on disk by someone else: read again, and the banner sees it.
    const file = h.modelPath('dim_customer');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf-8')}relationships:\n  - fromColumn: customer_key\n    toModel: fct_order\n    toColumn: customer_key\n    cardinality: one-to-many\n`);
    h.models.invalidateCache();
    await orders.send({ type: 'switchStage', payload: { stage: 'logical', requestId: 3 } });
    expect(scans.mock.calls.length).toBeGreaterThan(afterEdit);
    const payload = orders.posted().filter((m) => m.type === 'stageData').pop()?.payload as DisplayDomain | undefined;
    expect(payload?.relationshipIssues?.map((i) => i.code)).toEqual(expect.arrayContaining(['REL001']));
  });

  it('a commit in a library project does not count every domain file\'s relationships', async () => {
    h = await createHarness({ library: { fct_order: [{ ...ENTRY }] } });
    const orders = await h.open('orders');
    const count = vi.spyOn(DomainService.prototype, 'countDomainFileRelationships');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(count).not.toHaveBeenCalled();
  });
});
