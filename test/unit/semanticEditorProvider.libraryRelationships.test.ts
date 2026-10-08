/**
 * Relationships defined once in the model library (issue #126).
 *
 * A relationship lives in its from-model's logical-models/*.yml, and every
 * domain holding both ends draws it. New relationships go there by default
 * for a project whose domain files hold none; a project that keeps them per
 * domain carries on doing so until it opts in (the library holds one).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  createMockWebviewPanel,
  createMockTextDocument,
  _resetMockWorkspace,
  _appliedEdits,
  _mockDocuments,
  _fireDidChangeTextDocument,
  TextDocumentChangeReason,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { Relationship } from '../../src/types/semantic';

const FCT_ORDER = {
  name: 'fct_order',
  columns: [
    { name: 'order_key', dataType: 'string', description: '', isPrimaryKey: true },
    { name: 'customer_key', dataType: 'string', description: '' },
  ],
};
const DIM_CUSTOMER = {
  name: 'dim_customer',
  columns: [{ name: 'customer_key', dataType: 'string', description: '', isPrimaryKey: true }],
};
const DIM_DATE = {
  name: 'dim_date',
  columns: [{ name: 'date_key', dataType: 'date', description: '', isPrimaryKey: true }],
};

const EDGE = {
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
} as const;

interface Harness {
  root: string;
  domainService: DomainService;
  logicalModelService: LogicalModelService;
  domainPath: (name: string) => string;
  /** Open a domain in a canvas panel; its messages go through `send`. */
  open: (name: string) => Promise<{
    send: (message: unknown) => Promise<void>;
    errors: () => string[];
    panel: ReturnType<typeof createMockWebviewPanel>;
  }>;
  readDomain: (name: string) => { logical: { models: string[]; relationships: Relationship[] } };
  shown: (name: string) => Relationship[];
}

/** A silver layer with three domains over one shared library; `ownRelationships` seeds `orders`. */
async function createHarness(ownRelationships: Relationship[] = []): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-shared-rels-'));
  const semanticDir = '.erd-studio';
  const layerService = new LayerService(root, semanticDir);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, semanticDir);
  domainService.setLogicalModelService(logicalModelService);
  const selectorsService = new SelectorsService(domainService, root, semanticDir);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);

  for (const model of [FCT_ORDER, DIM_CUSTOMER, DIM_DATE]) logicalModelService.saveModel(model);

  const domainDir = path.join(root, semanticDir, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPath = (name: string) => path.join(domainDir, `${name}.json`);
  const writeDomain = (name: string, models: string[], relationships: Relationship[] = []) =>
    fs.writeFileSync(domainPath(name), JSON.stringify({
      schemaVersion: 5, domain: name, layer: 'silver', description: '',
      logical: { models, relationships },
      viewConfig: { positions: Object.fromEntries(models.map((m, i) => [m, { x: i * 300, y: 0 }])) },
    }, null, 2) + '\n');
  writeDomain('orders', ['fct_order', 'dim_customer'], ownRelationships);
  writeDomain('reporting', ['fct_order', 'dim_customer', 'dim_date']);
  writeDomain('finance', ['fct_order', 'dim_date']);

  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => undefined, update: async () => undefined },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, domainService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, logicalModelService, new OwnWriteTracker(),
  );

  return {
    root,
    domainService,
    logicalModelService,
    domainPath,
    open: async (name) => {
      const document = createMockTextDocument(domainPath(name), fs.readFileSync(domainPath(name), 'utf-8'), { persist: true });
      const panel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
      );
      return {
        send: async (message) => {
          _appliedEdits.length = 0;
          panel._postedMessages.length = 0;
          await panel._simulateMessage(message);
        },
        errors: () => panel._postedMessages
          .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
          .map((m) => m.payload.message),
        panel,
      };
    },
    readDomain: (name) => JSON.parse(fs.readFileSync(domainPath(name), 'utf-8')),
    shown: (name) => {
      logicalModelService.invalidateCache();
      return domainService.getDomain(domainPath(name)).logical.relationships;
    },
  };
}

describe('relationships stored once in the model library (#126)', () => {
  let h: Harness;

  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  describe('a project whose domain files hold no relationships (the default)', () => {
    beforeEach(async () => { h = await createHarness(); });

    it('is never offered the move — there is nothing per diagram to move', async () => {
      const info = vi.spyOn(vscode.window, 'showInformationMessage');
      await (await h.open('orders')).send({ type: 'ready' });
      await new Promise((r) => setTimeout(r, 20));
      expect(info.mock.calls.some(([text]) => String(text).startsWith('Relationships can now be defined once'))).toBe(false);
    });

    it('stores a new relationship in the from-model file, not the domain file, in one WorkspaceEdit', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

      expect(orders.errors()).toEqual([]);
      expect(_appliedEdits).toHaveLength(1);
      expect(h.readDomain('orders').logical.relationships).toEqual([]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([
        { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      ]);
      expect(fs.readFileSync(h.logicalModelService.modelPath('fct_order'), 'utf-8')).toMatch(/^relationships:/m);
    });

    it('is drawn by every domain holding both models, and by no domain missing one', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

      expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);
      expect(h.shown('reporting')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);
      expect(h.shown('finance')).toEqual([]);
    });

    it('a cardinality change made in one domain is what every domain shows', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      const reporting = await h.open('reporting');
      await reporting.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });

      expect(reporting.errors()).toEqual([]);
      expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'one-to-one' }]);
      expect(h.shown('reporting')).toEqual([{ ...EDGE, cardinality: 'one-to-one' }]);
    });

    it('refuses a second definition of the same relationship from another domain', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      const reporting = await h.open('reporting');
      await reporting.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });

      expect(reporting.errors()).toEqual(['Failed to add relationship: This relationship already exists.']);
      expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);
    });

    it('removing it in one domain removes it from all of them', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      const reporting = await h.open('reporting');
      await reporting.send({ type: 'removeRelationship', payload: EDGE });

      expect(reporting.errors()).toEqual([]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
      expect(h.shown('orders')).toEqual([]);
    });

    it('follows a rename of the column it points at, in the other model\'s file', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      await orders.send({
        type: 'updateColumn',
        payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } },
      });

      expect(orders.errors()).toEqual([]);
      expect(h.shown('reporting')).toEqual([{ ...EDGE, toColumn: 'customer_sk', cardinality: 'many-to-one' }]);
    });

    it('follows a rename of the model it points at', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      await orders.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });

      expect(orders.errors()).toEqual([]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships?.[0].toModel).toBe('dim_client');
    });
  });

  describe('a project that keeps relationships in its domain files', () => {
    const DATE_EDGE: Relationship = {
      fromModel: 'fct_order', fromColumn: 'order_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
    };
    beforeEach(async () => { h = await createHarness([DATE_EDGE]); });

    it('is offered the move once, when a canvas opens, because the relationship could be shared', async () => {
      const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Review the Move…' as never);
      const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
      await (await h.open('orders')).send({ type: 'ready' });
      await (await h.open('reporting')).send({ type: 'ready' });
      await vi.waitFor(() => expect(run).toHaveBeenCalledWith('erdStudio.moveRelationshipsToLibrary'));

      const offers = info.mock.calls.filter(([text]) => String(text).startsWith('Relationships can now be defined once'));
      expect(offers).toHaveLength(1);
      expect(offers[0][0]).toContain('1 relationship here is kept as a separate copy in each diagram');
      expect(offers[0].slice(1)).toEqual(['Review the Move…', 'Not Now', "Don't Ask Again"]);
    });

    it('carries on writing new relationships to the domain file until it opts in', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

      expect(orders.errors()).toEqual([]);
      expect(h.readDomain('orders').logical.relationships).toHaveLength(2);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
      expect(h.shown('reporting')).toEqual([]);
    });

    it('once the library holds one, editing a domain-file relationship moves it there', async () => {
      const model = h.logicalModelService.getModel('fct_order')!;
      h.logicalModelService.saveModel({ ...model, relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }] });
      const orders = await h.open('orders');
      await orders.send({ type: 'updateRelationship', payload: { ...DATE_EDGE, cardinality: 'one-to-one' } });

      expect(orders.errors()).toEqual([]);
      expect(h.readDomain('orders').logical.relationships).toEqual([]);
      expect(h.shown('reporting')).toContainEqual({ ...DATE_EDGE, cardinality: 'one-to-one' });
    });
  });

  describe('a model file open with unsaved edits', () => {
    beforeEach(async () => { h = await createHarness(); });

    it('refuses the edit, naming the file, instead of replacing the unsaved text', async () => {
      const ymlPath = h.logicalModelService.modelPath('fct_order');
      const onDisk = fs.readFileSync(ymlPath, 'utf-8');
      const tab = await vscode.workspace.openTextDocument(vscode.Uri.file(ymlPath)) as unknown as { _setText: (t: string) => void; getText: () => string };
      tab._setText(`${onDisk}# my unsaved note\n`);

      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

      expect(orders.errors()).toEqual([expect.stringContaining('logical-models/fct_order.yml has unsaved changes')]);
      expect(_appliedEdits).toHaveLength(0);
      expect(tab.getText()).toBe(`${onDisk}# my unsaved note\n`);
      expect(fs.readFileSync(ymlPath, 'utf-8')).toBe(onDisk);
    });

    it('finds the tab when VS Code spells its path in another case, on a file system that ignores case', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        const ymlPath = h.logicalModelService.modelPath('fct_order');
        const onDisk = fs.readFileSync(ymlPath, 'utf-8');
        // e.g. a Windows drive letter `c:` against `C:`, or a folder typed in another case on macOS
        const tab = createMockTextDocument(ymlPath.toUpperCase(), onDisk);
        (vscode.workspace.textDocuments as unknown[]).push(tab);
        tab._setText(`${onDisk}# my unsaved note\n`);

        const orders = await h.open('orders');
        await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });

        expect(orders.errors()).toEqual([expect.stringContaining('logical-models/fct_order.yml has unsaved changes')]);
        expect(_appliedEdits).toHaveLength(0);
        expect(fs.readFileSync(ymlPath, 'utf-8')).toBe(onDisk);
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });
  });

  describe('stored on the many side, however it was drawn (#133)', () => {
    const REVERSED = {
      fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
    } as const;
    const FCT_ENTRY = { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' };

    beforeEach(async () => { h = await createHarness(); });

    it('a one-to-many drawn from the dimension goes to the fact\'s file as many-to-one; the dimension file is untouched', async () => {
      const dimBefore = fs.readFileSync(h.logicalModelService.modelPath('dim_customer'), 'utf-8');
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...REVERSED, cardinality: 'one-to-many' } });

      expect(orders.errors()).toEqual([]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([FCT_ENTRY]);
      expect(fs.readFileSync(h.logicalModelService.modelPath('dim_customer'), 'utf-8')).toBe(dimBefore);
      expect(h.shown('reporting')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);
    });

    it('refuses a ⇄ swap that would make a model\'s key the many side, and changes nothing (keys win)', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-many' } });

      expect(orders.errors()).toEqual([
        'Failed to update relationship: dim_customer.customer_key is dim_customer\'s key, so each value appears only once — ' +
        'it can\'t be the "many" side. Unmark it as a key first, then try again.',
      ]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([FCT_ENTRY]);
      expect(h.logicalModelService.getModel('dim_customer')?.relationships).toBeUndefined();
    });

    it('refuses the same two columns joined the other way round — one link, one line', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      await orders.send({ type: 'addRelationship', payload: { ...REVERSED, cardinality: 'many-to-one' } });

      expect(orders.errors()).toEqual(['Failed to add relationship: This relationship already exists.']);
      expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);
    });

    it('keeps a role through a swap and an edit that leaves it, and clears it on an empty edit', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one', role: '  buyer ' } });
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([{ ...FCT_ENTRY, role: 'buyer' }]);
      expect(h.shown('reporting')).toEqual([{ ...EDGE, cardinality: 'many-to-one', role: 'buyer' }]);

      await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([{ ...FCT_ENTRY, cardinality: 'one-to-one', role: 'buyer' }]);

      const original = { originalFromModel: EDGE.fromModel, originalFromColumn: EDGE.fromColumn, originalToModel: EDGE.toModel, originalToColumn: EDGE.toColumn };
      await orders.send({ type: 'editRelationship', payload: { ...original, ...EDGE, cardinality: 'one-to-one', role: '' } });
      expect(orders.errors()).toEqual([]);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([{ ...FCT_ENTRY, cardinality: 'one-to-one' }]);
    });

    it('lifecycle: every relationship edit, across two diagrams, keeps one definition on the many side', async () => {
      const files = () => ({
        fct: h.logicalModelService.getModel('fct_order')?.relationships,
        dim: h.logicalModelService.getModel('dim_customer')?.relationships,
      });
      const orders = await h.open('orders');
      const reporting = await h.open('reporting');

      // 1. Added from the dimension end with a role: stored on the fact.
      await orders.send({ type: 'addRelationship', payload: { ...REVERSED, cardinality: 'one-to-many', role: 'buyer' } });
      expect(files()).toEqual({ fct: [{ ...FCT_ENTRY, role: 'buyer' }], dim: undefined });
      expect(h.shown('reporting')).toEqual([{ ...EDGE, cardinality: 'many-to-one', role: 'buyer' }]);

      // 2. ⇄ swap in the other diagram would make the dimension's key the many side: refused, nothing changes.
      await reporting.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-many' } });
      expect(reporting.errors()).toHaveLength(1);
      expect(files()).toEqual({ fct: [{ ...FCT_ENTRY, role: 'buyer' }], dim: undefined });

      // 3. A one-to-one from the fact's end keeps its home and its role.
      await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
      await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'many-to-one' } });
      expect(files()).toEqual({ fct: [{ ...FCT_ENTRY, role: 'buyer' }], dim: undefined });

      // 4. Edit: new cardinality and role, same ends.
      const original = { originalFromModel: EDGE.fromModel, originalFromColumn: EDGE.fromColumn, originalToModel: EDGE.toModel, originalToColumn: EDGE.toColumn };
      await reporting.send({ type: 'editRelationship', payload: { ...original, ...EDGE, cardinality: 'one-to-one', role: 'account owner' } });
      expect(files().fct).toEqual([{ ...FCT_ENTRY, cardinality: 'one-to-one', role: 'account owner' }]);

      // 5. Renaming the model it points at keeps it, role included.
      await orders.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([
        { ...FCT_ENTRY, toModel: 'dim_client', cardinality: 'one-to-one', role: 'account owner' },
      ]);

      // 6. Removing the fact's column removes the relationship everywhere.
      await orders.send({ type: 'removeColumn', payload: { modelName: 'fct_order', columnName: 'customer_key' } });
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
      expect(h.shown('reporting')).toEqual([]);
      expect([orders.errors(), reporting.errors()]).toEqual([[], []]);
    });

    it('refuses a role that is not text', async () => {
      const orders = await h.open('orders');
      await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one', role: 7 } });
      expect(orders.errors()).toEqual(['Failed to add relationship: the role must be text of at most 60 characters.']);
      expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
    });
  });
});

describe('relationship ends spelled in another case (#133 L4)', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  it('⇄ on Dim_Customer.Customer_Key rewrites only that entry, spelled dim_customer.customer_key, its comment kept', async () => {
    h = await createHarness();
    const file = h.logicalModelService.modelPath('fct_order');
    const head = fs.readFileSync(file, 'utf-8');
    const other = '  - fromColumn: order_key # untouched\n    toModel: Dim_Date\n    toColumn: DATE_KEY\n    cardinality: many-to-one\n';
    fs.writeFileSync(file, `${head}relationships:\n  - fromColumn: Customer_Key # the buyer\n    toModel: Dim_Customer\n    toColumn: CUSTOMER_KEY\n    cardinality: many-to-one\n${other}`);
    h.logicalModelService.invalidateCache();
    expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'many-to-one' }]);

    const orders = await h.open('orders');
    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(orders.errors()).toEqual([]);
    expect(fs.readFileSync(file, 'utf-8')).toBe(
      `${head}relationships:\n  - fromColumn: customer_key # the buyer\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: one-to-one\n${other}`,
    );
  });

  it('per-diagram ⇄, edit and delete find an entry spelled in another case', async () => {
    const own: Relationship = { fromModel: 'FCT_ORDER', fromColumn: 'Customer_Key', toModel: 'Dim_Customer', toColumn: 'customer_KEY', cardinality: 'many-to-one' };
    h = await createHarness([{ ...own, note: 'kept' } as Relationship]);
    expect(h.shown('orders')).toEqual([{ ...EDGE, cardinality: 'many-to-one', note: 'kept' }]);
    const orders = await h.open('orders');

    await orders.send({ type: 'updateRelationship', payload: { ...EDGE, cardinality: 'one-to-one' } });
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...EDGE, cardinality: 'one-to-one', note: 'kept' }]);

    const original = { originalFromModel: 'fct_order', originalFromColumn: 'customer_key', originalToModel: 'dim_customer', originalToColumn: 'customer_key' };
    await orders.send({ type: 'editRelationship', payload: { ...original, ...EDGE, cardinality: 'many-to-one', role: 'buyer' } });
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...EDGE, cardinality: 'many-to-one', role: 'buyer', note: 'kept' }]);

    await orders.send({ type: 'removeRelationship', payload: { ...EDGE, fromModel: 'Fct_Order', toColumn: 'CUSTOMER_KEY' } });
    expect(h.readDomain('orders').logical.relationships).toEqual([]);
    expect(orders.errors()).toEqual([]);
    expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
  });
});

describe('"Mark … as primary key" travels with the relationship (#133 L1)', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });
  const unkeyed = () => h.logicalModelService.saveModel({ ...DIM_CUSTOMER, columns: [{ ...DIM_CUSTOMER.columns[0], isPrimaryKey: undefined }] });
  const files = (edit: { _ops: Array<{ uri?: { fsPath: string } }> }) => edit._ops.map((op) => path.basename(op.uri?.fsPath ?? '')).sort();

  it('sets isPrimaryKey in the same WorkspaceEdit as the relationship — one undo step', async () => {
    h = await createHarness();
    unkeyed();
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one', markKey: { model: 'dim_customer', columns: ['CUSTOMER_KEY'] } } });
    expect(orders.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(files(_appliedEdits[0] as never)).toEqual(['dim_customer.yml', 'fct_order.yml', 'orders.json']);
    h.logicalModelService.invalidateCache();
    expect(h.logicalModelService.getModel('dim_customer')?.columns[0].isPrimaryKey).toBe(true);
    expect(h.logicalModelService.getModel('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
  });

  it('is refused, writing nothing, when the model has a key marked by then', async () => {
    h = await createHarness();
    const orders = await h.open('orders');
    await orders.send({ type: 'addRelationship', payload: { ...EDGE, cardinality: 'many-to-one', markKey: { model: 'dim_customer', columns: ['customer_key'] } } });
    expect(orders.errors()).toEqual([
      'Failed to add relationship: dim_customer already has a key marked — the relationship was not added. Set its keys in the model first.',
    ]);
    expect(_appliedEdits).toHaveLength(0);
    expect(h.logicalModelService.getModel('fct_order')?.relationships).toBeUndefined();
  });

  it('is refused at the boundary when it is not one end of the link', async () => {
    h = await createHarness();
    const orders = await h.open('orders');
    await orders.send({ type: 'editRelationship', payload: {
      originalFromModel: 'fct_order', originalFromColumn: 'customer_key', originalToModel: 'dim_customer', originalToColumn: 'customer_key',
      ...EDGE, cardinality: 'many-to-one', markKey: { model: 'dim_date', columns: ['date_key'] },
    } });
    expect(orders.errors()).toEqual(['Failed to edit relationship: the key to mark must be one end of the relationship.']);
  });
});

describe('a self-reference (#133 L3)', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });
  const SELF = { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' };

  async function openHr() {
    h = await createHarness();
    h.logicalModelService.saveModel({ name: 'employee', columns: [
      { name: 'employee_id', dataType: 'int', description: '', isPrimaryKey: true },
      { name: 'manager_id', dataType: 'int', description: '' },
    ] });
    fs.writeFileSync(h.domainPath('hr'), JSON.stringify({
      schemaVersion: 5, domain: 'hr', layer: 'silver', description: '', logical: { models: ['employee'], relationships: [] },
      viewConfig: { positions: { employee: { x: 0, y: 0 } } },
    }, null, 2) + '\n');
    return h.open('hr');
  }

  it('is stored in its own model\'s file; a one-to-many drawn is stored swapped', async () => {
    const hr = await openHr();
    await hr.send({ type: 'addRelationship', payload: { ...SELF, fromColumn: 'employee_id', toColumn: 'manager_id', cardinality: 'one-to-many', role: 'manager' } });
    expect(hr.errors()).toEqual([]);
    h.logicalModelService.invalidateCache();
    expect(h.logicalModelService.getModel('employee')?.relationships).toEqual([
      { fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one', role: 'manager' },
    ]);
    expect(h.shown('hr')).toEqual([{ ...SELF, cardinality: 'many-to-one', role: 'manager' }]);

    // Renaming the model renames its own entry's toModel.
    await hr.send({ type: 'renameModel', payload: { oldName: 'employee', newName: 'staff' } });
    expect(h.logicalModelService.getModel('staff')?.relationships).toEqual([
      { fromColumn: 'manager_id', toModel: 'staff', toColumn: 'employee_id', cardinality: 'many-to-one', role: 'manager' },
    ]);
  });

  it('a column pointing at itself is refused at the boundary', async () => {
    const hr = await openHr();
    await hr.send({ type: 'addRelationship', payload: { ...SELF, toColumn: 'MANAGER_ID', cardinality: 'many-to-one' } });
    expect(hr.errors()).toEqual(["Failed to add relationship: a column can't point at itself."]);
  });

  it('removing either column removes it', async () => {
    const hr = await openHr();
    await hr.send({ type: 'addRelationship', payload: { ...SELF, cardinality: 'many-to-one' } });
    await hr.send({ type: 'removeColumn', payload: { modelName: 'employee', columnName: 'manager_id' } });
    expect(h.logicalModelService.getModel('employee')?.relationships).toBeUndefined();
  });
});

describe('composite foreign keys on the canvas (#133 L2)', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });
  async function openVault() {
    h = await createHarness();
    h.logicalModelService.saveModel({ name: 'pit_customer', columns: ['pit_id', 'customer_hk', 'as_of_date'].map((name, i) => ({ name, dataType: 'string', description: '', ...(i === 0 ? { isPrimaryKey: true } : {}) })) });
    h.logicalModelService.saveModel({ name: 'sat_customer', columns: ['customer_hk', 'load_date'].map((name) => ({ name, dataType: 'string', description: '', isPrimaryKey: true })) });
    fs.writeFileSync(h.domainPath('vault'), JSON.stringify({
      schemaVersion: 5, domain: 'vault', layer: 'silver', description: '', logical: { models: ['pit_customer', 'sat_customer'], relationships: [] },
      viewConfig: { positions: { pit_customer: { x: 0, y: 0 }, sat_customer: { x: 300, y: 0 } } },
    }, null, 2) + '\n');
    return h.open('vault');
  }
  const FIRST = { fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk' };
  const GROUP = [
    { fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', compositeKey: 'fk_sat_customer' },
    { fromColumn: 'as_of_date', toModel: 'sat_customer', toColumn: 'load_date', cardinality: 'many-to-one', compositeKey: 'fk_sat_customer' },
  ];

  it('add with extraPairs writes the group in one edit; deleting one member edge deletes it in one edit', async () => {
    const vault = await openVault();
    await vault.send({ type: 'addRelationship', payload: { ...FIRST, cardinality: 'many-to-one', extraPairs: [{ fromColumn: 'as_of_date', toColumn: 'load_date' }] } });
    expect(vault.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    h.logicalModelService.invalidateCache();
    expect(h.logicalModelService.getModel('pit_customer')?.relationships).toEqual(GROUP);
    expect(h.shown('vault').map((r) => r.compositeKey)).toEqual(['fk_sat_customer', 'fk_sat_customer']);

    await vault.send({ type: 'removeRelationship', payload: { ...FIRST, fromColumn: 'as_of_date', toColumn: 'load_date' } });
    expect(_appliedEdits).toHaveLength(1);
    expect(h.logicalModelService.getModel('pit_customer')?.relationships).toBeUndefined();
  });

  it('regroups singles a 1.6.7 save left, and says so', async () => {
    const vault = await openVault();
    h.logicalModelService.saveModel({ ...h.logicalModelService.getModel('pit_customer')!, relationships: GROUP.map(({ compositeKey: _k, ...r }) => r) as never });
    const infos = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const original = { originalFromModel: FIRST.fromModel, originalFromColumn: FIRST.fromColumn, originalToModel: FIRST.toModel, originalToColumn: FIRST.toColumn };
    await vault.send({ type: 'editRelationship', payload: { ...original, ...FIRST, cardinality: 'many-to-one', extraPairs: [{ fromColumn: 'as_of_date', toColumn: 'load_date' }] } });
    expect(vault.errors()).toEqual([]);
    h.logicalModelService.invalidateCache();
    expect(h.logicalModelService.getModel('pit_customer')?.relationships).toEqual(GROUP);
    expect(infos).toHaveBeenCalledWith('Grouped 1 existing relationship into fk_sat_customer.');
  });

  it('refuses many-to-many and a repeated column at the boundary', async () => {
    const vault = await openVault();
    await vault.send({ type: 'addRelationship', payload: { ...FIRST, cardinality: 'many-to-many', extraPairs: [{ fromColumn: 'as_of_date', toColumn: 'load_date' }] } });
    expect(vault.errors()).toEqual(["Failed to add relationship: a composite key can't be many-to-many."]);
    await vault.send({ type: 'addRelationship', payload: { ...FIRST, cardinality: 'many-to-one', extraPairs: [{ fromColumn: 'Customer_HK', toColumn: 'load_date' }] } });
    expect(vault.errors()).toEqual(['Failed to add relationship: a column is used twice in the composite key.']);
    expect(h.logicalModelService.getModel('pit_customer')?.relationships).toBeUndefined();
  });
});

describe('a rename reaches the copies other diagrams keep of their own (#133 L5)', () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });
  // A per-diagram project: orders and reporting each keep their own copy, reporting's spelled in another case.
  const OWN: Relationship = { ...EDGE, cardinality: 'many-to-one' };
  async function perDiagram() {
    h = await createHarness([OWN]);
    const reporting = JSON.parse(fs.readFileSync(h.domainPath('reporting'), 'utf-8'));
    reporting.logical.relationships = [{ ...OWN, toModel: 'Dim_Customer', toColumn: 'CUSTOMER_KEY', role: 'buyer' }];
    fs.writeFileSync(h.domainPath('reporting'), JSON.stringify(reporting, null, 2) + '\n');
    return h.open('orders');
  }
  const files = (edit: { _ops: Array<{ uri?: { fsPath: string } }> }) => [...new Set(edit._ops.map((op) => path.basename(op.uri?.fsPath ?? '')))].sort();

  it('a column rename rewrites the other diagram\'s copy in the same WorkspaceEdit — one undo step', async () => {
    const orders = await perDiagram();
    await orders.send({ type: 'updateColumn', payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } } });
    expect(orders.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(files(_appliedEdits[0] as never)).toEqual(['dim_customer.yml', 'orders.json', 'reporting.json']);
    expect(h.readDomain('orders').logical.relationships).toEqual([{ ...OWN, toColumn: 'customer_sk' }]);
    expect(h.readDomain('reporting').logical.relationships).toEqual([{ ...OWN, toModel: 'Dim_Customer', toColumn: 'customer_sk', role: 'buyer' }]);
    expect(h.shown('reporting')).toEqual([{ ...OWN, toColumn: 'customer_sk', role: 'buyer' }]);
    // The diagram that does not hold the link is not touched.
    expect(h.readDomain('finance').logical.relationships).toEqual([]);
  });

  it('one undo puts the other diagram back on disk too, not just in memory', async () => {
    const orders = await perDiagram();
    const reportingBefore = fs.readFileSync(h.domainPath('reporting'), 'utf-8');
    const ymlPath = h.logicalModelService.modelPath('dim_customer');
    const ymlBefore = fs.readFileSync(ymlPath, 'utf-8');
    await orders.send({ type: 'updateColumn', payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } } });
    expect(orders.errors()).toEqual([]);
    expect(fs.readFileSync(h.domainPath('reporting'), 'utf-8')).not.toBe(reportingBefore);

    // VS Code's undo rewinds every document of the step in memory, leaving them dirty.
    const reporting = _mockDocuments.get(vscode.Uri.file(h.domainPath('reporting')).toString())!;
    const yml = _mockDocuments.get(vscode.Uri.file(ymlPath).toString())!;
    reporting._setText(reportingBefore);
    yml._setText(ymlBefore);
    await orders.send({ type: 'undo' });

    expect(reporting.isDirty).toBe(false);
    expect(fs.readFileSync(h.domainPath('reporting'), 'utf-8')).toBe(reportingBefore);
    expect(fs.readFileSync(ymlPath, 'utf-8')).toBe(ymlBefore);
  });

  it('a model rename rewrites the other diagram\'s model list, position and copy', async () => {
    const orders = await perDiagram();
    await orders.send({ type: 'renameModel', payload: { oldName: 'dim_customer', newName: 'dim_client' } });
    expect(orders.errors()).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    const reporting = JSON.parse(fs.readFileSync(h.domainPath('reporting'), 'utf-8'));
    expect(reporting.logical.models).toEqual(['fct_order', 'dim_client', 'dim_date']);
    expect(Object.keys(reporting.viewConfig.positions).sort()).toEqual(['dim_client', 'dim_date', 'fct_order']);
    expect(reporting.logical.relationships).toEqual([{ ...OWN, toModel: 'dim_client', toColumn: 'CUSTOMER_KEY', role: 'buyer' }]);
    expect(h.readDomain('finance').logical.models).toEqual(['fct_order', 'dim_date']);
  });

  it('is refused, naming the file, when the other diagram is open with unsaved edits', async () => {
    const orders = await perDiagram();
    const onDisk = fs.readFileSync(h.domainPath('reporting'), 'utf-8');
    const tab = await vscode.workspace.openTextDocument(vscode.Uri.file(h.domainPath('reporting'))) as unknown as { _setText: (t: string) => void };
    tab._setText(onDisk.replace('"description": ""', '"description": "draft"'));
    _appliedEdits.length = 0;
    await orders.send({ type: 'updateColumn', payload: { modelName: 'dim_customer', oldColumnName: 'customer_key', column: { name: 'customer_sk', dataType: 'string', description: '' } } });
    expect(orders.errors()).toEqual([expect.stringContaining('.erd-studio/silver/reporting.json has unsaved changes. Save or revert it, then try again.')]);
    expect(_appliedEdits).toHaveLength(0);
    expect(fs.readFileSync(h.domainPath('reporting'), 'utf-8')).toBe(onDisk);
  });
});

describe("VS Code's own undo — Cmd+Z on the canvas — after an edit to two model files", () => {
  let h: Harness;
  beforeEach(() => { _resetMockWorkspace(); });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  /** A link stored at both ends, as a 1.6.7 drag from each side can leave it. */
  async function storedAtBothEnds() {
    h = await createHarness();
    h.logicalModelService.saveModel({ ...FCT_ORDER, relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }] });
    h.logicalModelService.saveModel({ ...DIM_CUSTOMER, relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' }] });
    const files = ['fct_order', 'dim_customer'].map((name) => h.logicalModelService.modelPath(name));
    const before = files.map((file) => fs.readFileSync(file, 'utf-8'));
    const orders = await h.open('orders');
    await orders.send({ type: 'removeRelationship', payload: EDGE });
    expect(orders.errors()).toEqual([]);
    const after = files.map((file) => fs.readFileSync(file, 'utf-8'));
    expect(after).not.toEqual(before);
    const docs = files.map((file) => _mockDocuments.get(vscode.Uri.file(file).toString())!);
    /** What VS Code's undo does to the model files: rewinds them in memory, each firing a change. */
    const rewind = async (texts: string[], reason: TextDocumentChangeReason) => {
      orders.panel._postedMessages.length = 0;
      docs.forEach((doc, i) => doc._setText(texts[i]));
      for (const doc of docs) await _fireDidChangeTextDocument(doc, reason);
    };
    const drawn = () => (orders.panel._postedMessages as Array<{ type: string; payload: { relationships: unknown[] } }>)
      .filter((m) => m.type === 'domainLoaded').map((m) => m.payload.relationships.length);
    return { orders, files, before, after, docs, rewind, drawn };
  }

  it('saves both model files and redraws, as the toolbar Undo does; Cmd+Shift+Z likewise', async () => {
    const { files, before, after, docs, rewind, drawn } = await storedAtBothEnds();

    await rewind(before, TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(files.map((file) => fs.readFileSync(file, 'utf-8'))).toEqual(before));
    expect(docs.map((doc) => doc.isDirty)).toEqual([false, false]);
    await vi.waitFor(() => expect(drawn()).toEqual([1]));

    await rewind(after, TextDocumentChangeReason.Redo);
    await vi.waitFor(() => expect(files.map((file) => fs.readFileSync(file, 'utf-8'))).toEqual(after));
    expect(docs.map((doc) => doc.isDirty)).toEqual([false, false]);
    await vi.waitFor(() => expect(drawn()).toEqual([0]));
  });

  it("leaves an undo typed in a model file's own tab unsaved — the canvas is not the one focused", async () => {
    const { orders, files, before, after, docs, rewind } = await storedAtBothEnds();
    orders.panel.active = false;

    await rewind(before, TextDocumentChangeReason.Undo);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(docs.map((doc) => doc.isDirty)).toEqual([true, true]);
    expect(files.map((file) => fs.readFileSync(file, 'utf-8'))).toEqual(after);
  });
});
