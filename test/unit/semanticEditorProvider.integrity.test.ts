/**
 * Handler-level tests for SemanticEditorProvider on v5 (model-library) domains.
 *
 * Covers the integrity guarantees between the domain JSON and
 * logical-models/*.yml:
 *  - a "new" or renamed model never overwrites an existing library file (H05)
 *  - yml writes travel in the same WorkspaceEdit as the domain change, so a
 *    rejected edit leaves the library untouched and undo/redo stay in sync (H04)
 *  - every applyModelEdit call site reports failure to the webview (H04)
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
  _mockWorkspaceState,
  _mockDocuments,
  _clearMockFileWatchers,
  _mockFileWatchers,
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
import { FileWatcherService } from '../../src/watchers/FileWatcherService';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface Harness {
  root: string;
  domainPath: string;
  logicalModelService: LogicalModelService;
  /** Tracker the provider records its own writes into (shared with watchers). */
  ownWrites: OwnWriteTracker;
  /** Open a second domain in another panel, sharing the same provider. */
  openSecondDomain: (models: string[]) => Promise<ReturnType<typeof createMockWebviewPanel>>;
  panel: ReturnType<typeof createMockWebviewPanel>;
  send: (message: unknown) => Promise<void>;
  readDomain: () => { logical: { models: string[]; relationships: Array<Record<string, string>> }; viewConfig: Record<string, unknown> };
  errors: () => string[];
}

const FCT_ORDER = {
  name: 'fct_order',
  description: 'Orders',
  columns: [
    { name: 'order_key', dataType: 'string', description: 'PK', isPrimaryKey: true },
    { name: 'customer_key', dataType: 'string', description: 'FK' },
    { name: 'amount', dataType: 'decimal', description: '' },
  ],
};

const DIM_TASK = {
  name: 'dim_task',
  columns: [{ name: 'task_key', dataType: 'string', description: 'PK', isPrimaryKey: true }],
};

/** A conformed dimension that lives in the library but NOT in the domain under test. */
const DIM_CUSTOMER = {
  name: 'dim_customer',
  description: 'Conformed customer dimension used by other domains',
  columns: [
    { name: 'customer_key', dataType: 'string', description: 'PK', isPrimaryKey: true },
    { name: 'customer_name', dataType: 'string', description: '', scdType: 2 as const },
  ],
};

async function createHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-provider-'));
  const semanticDir = '.erd-studio';

  const layerService = new LayerService(root, semanticDir);
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, semanticDir);
  domainService.setLogicalModelService(logicalModelService);
  const manifestService = new ManifestService();
  const ymlParserService = new YmlParserService();
  const templateService = new TemplateService();
  const selectorsService = new SelectorsService(domainService, root, semanticDir);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);

  // Library
  logicalModelService.saveModel(FCT_ORDER);
  logicalModelService.saveModel(DIM_TASK);
  logicalModelService.saveModel(DIM_CUSTOMER);

  // Domain referencing fct_order + dim_task (dim_customer is used elsewhere)
  const domainDir = path.join(root, semanticDir, 'silver');
  fs.mkdirSync(domainDir, { recursive: true });
  const domainPath = path.join(domainDir, 'orders.json');
  const domain = {
    schemaVersion: 5,
    domain: 'orders',
    layer: 'silver',
    description: 'Orders domain',
    logical: {
      models: ['fct_order', 'dim_task'],
      relationships: [
        { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_task', toColumn: 'task_key', cardinality: 'many-to-one' },
      ],
    },
    viewConfig: { positions: { fct_order: { x: 0, y: 0 }, dim_task: { x: 300, y: 0 } } },
  };
  fs.writeFileSync(domainPath, JSON.stringify(domain, null, 2) + '\n');

  const context = {
    extensionUri: vscode.Uri.file(root),
    globalState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;

  const ownWrites = new OwnWriteTracker();
  const provider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    root,
    selectorsService,
    logicalModelService,
    ownWrites,
  );

  const document = createMockTextDocument(domainPath, fs.readFileSync(domainPath, 'utf-8'), { persist: true });
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
  );

  return {
    root,
    domainPath,
    logicalModelService,
    ownWrites,
    openSecondDomain: async (models) => {
      const otherPath = path.join(domainDir, 'other.json');
      fs.writeFileSync(
        otherPath,
        JSON.stringify(
          {
            schemaVersion: 5,
            domain: 'other',
            layer: 'silver',
            description: 'Other domain',
            logical: { models, relationships: [] },
            viewConfig: { positions: {} },
          },
          null,
          2,
        ) + '\n',
      );
      const otherDoc = createMockTextDocument(otherPath, fs.readFileSync(otherPath, 'utf-8'), { persist: true });
      const otherPanel = createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        otherDoc as unknown as vscode.TextDocument,
        otherPanel as unknown as vscode.WebviewPanel,
        { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) } as unknown as vscode.CancellationToken,
      );
      return otherPanel;
    },
    panel,
    send: async (message) => {
      _appliedEdits.length = 0;
      panel._postedMessages.length = 0;
      await panel._simulateMessage(message);
    },
    readDomain: () => JSON.parse(fs.readFileSync(domainPath, 'utf-8')),
    errors: () =>
      panel._postedMessages
        .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
        .map((m) => m.payload.message),
  };
}

const ymlPath = (h: Harness, name: string) => h.logicalModelService.modelPath(name);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticEditorProvider (v5 model library integrity)', () => {
  let h: Harness;

  beforeEach(async () => {
    _resetMockWorkspace();
    h = await createHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(h.root, { recursive: true, force: true });
  });

  // ---- H05: cross-domain collision guards ---------------------------------

  describe('addModel', () => {
    it('refuses to create a model whose yml already exists in the library and points to Add Existing Model', async () => {
      const before = fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8');

      await h.send({
        type: 'addModel',
        payload: { name: 'dim_customer', schema: '', description: 'skeleton', columns: [{ name: 'dim_customer_key', dataType: 'string', description: '' }] },
      });

      expect(h.errors()).toHaveLength(1);
      expect(h.errors()[0]).toMatch(/already exists in the model library/);
      expect(h.errors()[0]).toMatch(/Add Existing Model/);
      // Nothing was written anywhere
      expect(_appliedEdits).toHaveLength(0);
      expect(fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8')).toBe(before);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });

    it('still rejects a duplicate within the domain', async () => {
      await h.send({ type: 'addModel', payload: { name: 'fct_order', schema: '', description: '', columns: [] } });
      expect(h.errors()[0]).toMatch(/already exists in this domain/);
      expect(_appliedEdits).toHaveLength(0);
    });

    it('creates the yml and the domain reference in ONE WorkspaceEdit', async () => {
      await h.send({
        type: 'addModel',
        payload: { name: 'dim_product', schema: 'silver', description: 'Products', columns: [{ name: 'product_key', dataType: 'string', description: '', isPrimaryKey: true }] },
      });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit).toBeDefined();
      expect(edit._opsFor(h.domainPath).map((op) => op.kind)).toEqual(['replace']);
      const ymlOps = edit._opsFor(ymlPath(h, 'dim_product'));
      expect(ymlOps.map((op) => op.kind)).toEqual(['createFile']);
      const createOp = ymlOps[0] as { options?: { contents?: Uint8Array; overwrite?: boolean } };
      expect(createOp.options?.overwrite).toBe(false);
      expect(Buffer.from(createOp.options!.contents!).toString('utf-8')).toContain('name: dim_product');

      // Both sides landed on disk
      expect(h.logicalModelService.getModel('dim_product')!.columns!.map((c) => c.name)).toEqual(['product_key']);
      expect(h.readDomain().logical.models).toContain('dim_product');
    });

    it('writes nothing to the library when the WorkspaceEdit is rejected', async () => {
      _mockWorkspaceState.applyEditResult = false;

      await h.send({ type: 'addModel', payload: { name: 'dim_product', schema: '', description: '', columns: [] } });

      expect(h.errors()).toEqual(['Failed to add model to domain.']);
      expect(fs.existsSync(ymlPath(h, 'dim_product'))).toBe(false);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });
  });

  describe('renameModel', () => {
    it('refuses to rename onto a model that exists in the library (other domains depend on it)', async () => {
      const before = fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8');

      await h.send({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'dim_customer' } });

      expect(h.errors()[0]).toMatch(/already exists in the model library/);
      expect(_appliedEdits).toHaveLength(0);
      expect(fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8')).toBe(before);
      expect(fs.existsSync(ymlPath(h, 'fct_order'))).toBe(true);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });

    it('refuses to rename onto a name already used in this domain', async () => {
      await h.send({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'dim_task' } });

      expect(h.errors()[0]).toMatch(/already exists in this domain/);
      expect(_appliedEdits).toHaveLength(0);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });

    it('renames via create-new + delete-old in the SAME WorkspaceEdit as the domain update', async () => {
      await h.send({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'fct_orders' } });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit._opsFor(h.domainPath).map((op) => op.kind)).toEqual(['replace']);
      expect(edit._opsFor(ymlPath(h, 'fct_order')).map((op) => op.kind)).toEqual(['deleteFile']);
      expect(edit._opsFor(ymlPath(h, 'fct_orders')).map((op) => op.kind)).toEqual(['createFile']);

      // Disk state: columns preserved under the new name, old file gone
      expect(fs.existsSync(ymlPath(h, 'fct_order'))).toBe(false);
      const renamed = h.logicalModelService.getModel('fct_orders');
      expect(renamed!.columns!.map((c) => c.name)).toEqual(['order_key', 'customer_key', 'amount']);
      expect(renamed!.description).toBe('Orders');

      const domain = h.readDomain();
      expect(domain.logical.models).toEqual(['fct_orders', 'dim_task']);
      expect(domain.logical.relationships[0].fromModel).toBe('fct_orders');
      expect((domain.viewConfig.positions as Record<string, unknown>).fct_orders).toBeDefined();
    });

    it('carries hand-written comments and unknown keys across to the new file (H29)', async () => {
      // A model file a human (or an AI agent) has edited by hand.
      const handWritten = [
        '# Owned by the data platform team',
        'name: fct_order',
        'owner: analytics-team',
        'description: Orders',
        'columns:',
        '  - name: order_key',
        '    dataType: string',
        '    description: PK # natural surrogate',
        '    isPrimaryKey: true',
        '  - name: customer_key',
        '    dataType: string',
        '    description: FK',
        '',
      ].join('\n');
      fs.writeFileSync(ymlPath(h, 'fct_order'), handWritten, 'utf-8');
      h.logicalModelService.invalidateCache('fct_order');

      await h.send({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'fct_orders' } });

      expect(h.errors()).toEqual([]);
      const renamed = fs.readFileSync(ymlPath(h, 'fct_orders'), 'utf-8');
      expect(renamed).toContain('# Owned by the data platform team');
      expect(renamed).toContain('owner: analytics-team');
      expect(renamed).toContain('# natural surrogate');
      expect(renamed).toContain('name: fct_orders');
      expect(renamed).not.toContain('name: fct_order\n');
      expect(fs.existsSync(ymlPath(h, 'fct_order'))).toBe(false);
    });

    it('leaves both files untouched when the WorkspaceEdit is rejected', async () => {
      _mockWorkspaceState.applyEditResult = false;

      await h.send({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'fct_orders' } });

      expect(h.errors()).toEqual(['Failed to rename model.']);
      expect(fs.existsSync(ymlPath(h, 'fct_order'))).toBe(true);
      expect(fs.existsSync(ymlPath(h, 'fct_orders'))).toBe(false);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });
  });

  // ---- H04: yml edits ride in the domain WorkspaceEdit ---------------------

  describe('applyModelEdit call sites', () => {
    it('addColumn replaces the yml document in the same WorkspaceEdit and saves it', async () => {
      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit._opsFor(h.domainPath).map((op) => op.kind)).toEqual(['replace']);
      expect(edit._opsFor(ymlPath(h, 'fct_order')).map((op) => op.kind)).toEqual(['replace']);

      // The yml document was saved (not left dirty) and disk reflects the change
      const ymlDoc = _mockDocuments.get(vscode.Uri.file(ymlPath(h, 'fct_order')).toString());
      expect(ymlDoc?.isDirty).toBe(false);
      expect(h.logicalModelService.getModel('fct_order')!.columns!.map((c) => c.name)).toContain('order_date');
    });

    it('updateColumn (rename with FK) cascades relationships and the yml atomically', async () => {
      await h.send({
        type: 'updateColumn',
        payload: {
          modelName: 'fct_order',
          oldColumnName: 'customer_key',
          column: { name: 'cust_key', dataType: 'string', description: 'FK' },
        },
      });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit._opsFor(h.domainPath)).toHaveLength(1);
      expect(edit._opsFor(ymlPath(h, 'fct_order'))).toHaveLength(1);
      expect(h.readDomain().logical.relationships[0].fromColumn).toBe('cust_key');
      expect(h.logicalModelService.getModel('fct_order')!.columns!.map((c) => c.name)).toEqual(['order_key', 'cust_key', 'amount']);
    });

    it('reports failure and leaves the yml untouched when the WorkspaceEdit is rejected', async () => {
      _mockWorkspaceState.applyEditResult = false;
      const before = fs.readFileSync(ymlPath(h, 'fct_order'), 'utf-8');

      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });

      expect(h.errors()).toEqual(['Failed to add column.']);
      expect(fs.readFileSync(ymlPath(h, 'fct_order'), 'utf-8')).toBe(before);
    });

    it.each([
      ['updateModelDescription', { modelName: 'fct_order', description: 'x' }, 'Failed to update description.'],
      ['updateModelGrain', { modelName: 'fct_order', grain: 'one row per order' }, 'Failed to update grain statement.'],
      ['updateModelRole', { modelName: 'fct_order', modelRole: 'transaction-fact' }, 'Failed to update model role.'],
      ['updateModelRationale', { modelName: 'fct_order', rationale: { purpose: 'p' } }, 'Failed to update design rationale.'],
      ['toggleColumnKey', { modelName: 'fct_order', columnName: 'amount', keyType: 'NK', value: true }, 'Failed to toggle key type.'],
      ['reorderColumns', { modelName: 'fct_order', orderedNames: ['amount', 'order_key', 'customer_key'] }, 'Failed to reorder columns.'],
      ['removeColumn', { modelName: 'fct_order', columnName: 'amount' }, 'Failed to remove column.'],
    ])('%s surfaces a rejected WorkspaceEdit to the webview', async (type, payload, expected) => {
      _mockWorkspaceState.applyEditResult = false;
      const before = fs.readFileSync(ymlPath(h, 'fct_order'), 'utf-8');

      await h.send({ type, payload });

      expect(h.errors()).toEqual([expected]);
      expect(fs.readFileSync(ymlPath(h, 'fct_order'), 'utf-8')).toBe(before);
    });

    it('surfaces a missing library model as an error', async () => {
      await h.send({ type: 'updateModelGrain', payload: { modelName: 'ghost', grain: 'x' } });
      expect(h.errors()).toHaveLength(1);
      expect(h.errors()[0]).toMatch(/not found in logical-models/);
    });
  });

  describe('undo / redo', () => {
    it('flushes reverted-but-dirty yml documents to disk so the library matches the domain', async () => {
      // Edit through the editor so the yml document is open in the mock workspace
      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });
      const ymlDoc = _mockDocuments.get(vscode.Uri.file(ymlPath(h, 'fct_order')).toString())!;

      // Simulate VS Code undoing the grouped text edit: in-memory content reverts, document is dirty
      const reverted = h.logicalModelService.serializeModel(FCT_ORDER);
      ymlDoc._setText(reverted);
      expect(ymlDoc.isDirty).toBe(true);

      await h.send({ type: 'undo' });

      expect(ymlDoc.isDirty).toBe(false);
      expect(fs.readFileSync(ymlPath(h, 'fct_order'), 'utf-8')).toBe(reverted);
      expect(h.logicalModelService.getModel('fct_order')!.columns!.map((c) => c.name)).toEqual(['order_key', 'customer_key', 'amount']);
    });

    it('never force-saves a dirty model buffer the provider did not edit', async () => {
      // The user is hand-editing dim_customer.yml in a normal editor tab and
      // has NOT saved. The provider never touched that file.
      const customerPath = ymlPath(h, 'dim_customer');
      const onDisk = fs.readFileSync(customerPath, 'utf-8');
      const userDoc = createMockTextDocument(customerPath, onDisk, { persist: true });
      (vscode.workspace.textDocuments as unknown[]).push(userDoc);
      userDoc._setText('# work in progress, not ready to save\n' + onDisk);
      expect(userDoc.isDirty).toBe(true);

      // An unrelated edit + undo on the domain the editor actually has open.
      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });
      const ourDoc = _mockDocuments.get(vscode.Uri.file(ymlPath(h, 'fct_order')).toString())!;
      const reverted = h.logicalModelService.serializeModel(FCT_ORDER);
      ourDoc._setText(reverted);

      await h.send({ type: 'undo' });

      // Our own document was flushed; the user's buffer was left alone.
      expect(ourDoc.isDirty).toBe(false);
      expect(userDoc.isDirty).toBe(true);
      expect(fs.readFileSync(customerPath, 'utf-8')).toBe(onDisk);
    });
  });

  // ---- H11: own-write suppression on the editor write path ----------------

  describe('own-write suppression', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('records the domain file and the model yml a column edit wrote', async () => {
      await h.send({
        type: 'updateColumn',
        payload: {
          modelName: 'fct_order',
          oldColumnName: 'amount',
          column: { name: 'amount', dataType: 'numeric', description: '' },
        },
      });

      expect(h.errors()).toEqual([]);
      expect(h.ownWrites.has(ymlPath(h, 'fct_order'))).toBe(true);
      expect(h.ownWrites.has(h.domainPath)).toBe(true);
    });

    it('makes the logical-model watcher swallow the edit instead of refreshing the domain', async () => {
      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });
      expect(h.errors()).toEqual([]);

      vi.useFakeTimers();
      _clearMockFileWatchers();
      const watcherService = new FileWatcherService(h.root, '.erd-studio', undefined, h.ownWrites);
      try {
        const listener = vi.fn();
        watcherService.onLogicalModelChanged(listener);

        // The logical-model watcher is the fourth one the service creates.
        _mockFileWatchers[3]._simulateChange(vscode.Uri.file(ymlPath(h, 'fct_order')));
        vi.advanceTimersByTime(300);

        expect(listener).not.toHaveBeenCalled();

        // An external edit to the same file is still reported (the record was consumed).
        _mockFileWatchers[3]._simulateChange(vscode.Uri.file(ymlPath(h, 'fct_order')));
        vi.advanceTimersByTime(300);
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        watcherService.dispose();
      }
    });

    it('sends the editing panel ONE domainLoaded and still refreshes the other open panel', async () => {
      const otherPanel = await h.openSecondDomain(['fct_order']);
      otherPanel._postedMessages.length = 0;

      await h.send({
        type: 'addColumn',
        payload: { modelName: 'fct_order', column: { name: 'order_date', dataType: 'date', description: '' } },
      });

      const domainLoaded = (p: typeof otherPanel) =>
        p._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded');
      // The editing panel is refreshed exactly once (a second one would clear
      // the user's column selection — the H11 symptom).
      expect(domainLoaded(h.panel)).toHaveLength(1);
      // The other domain showing the same model is refreshed too, even though
      // the watcher event for our own write is suppressed.
      expect(domainLoaded(otherPanel)).toHaveLength(1);
    });
  });

  // ---- H04: addExistingModel rides the same pipeline -----------------------

  describe('addExistingModel', () => {
    /** Seed a dbt schema.yml the model can be resolved from. */
    const seedDbtYml = () => {
      const modelsDir = path.join(h.root, 'models');
      fs.mkdirSync(modelsDir, { recursive: true });
      fs.writeFileSync(
        path.join(modelsDir, 'schema.yml'),
        [
          'version: 2',
          'models:',
          '  - name: dim_new',
          '    description: Seeded from dbt',
          '    columns:',
          '      - name: dim_new_key',
          '        description: PK',
          '',
        ].join('\n'),
        'utf-8',
      );
    };

    it('seeds the library file inside the same WorkspaceEdit as the domain reference', async () => {
      seedDbtYml();

      await h.send({ type: 'addExistingModel', payload: { modelName: 'dim_new' } });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit._opsFor(h.domainPath).map((op) => op.kind)).toEqual(['replace']);
      expect(edit._opsFor(ymlPath(h, 'dim_new')).map((op) => op.kind)).toEqual(['createFile']);
      expect(h.readDomain().logical.models).toContain('dim_new');
      expect(h.logicalModelService.getModel('dim_new')!.columns!.map((c) => c.name)).toEqual(['dim_new_key']);
    });

    it('writes nothing to the library when the WorkspaceEdit is rejected', async () => {
      seedDbtYml();
      _mockWorkspaceState.applyEditResult = false;

      await h.send({ type: 'addExistingModel', payload: { modelName: 'dim_new' } });

      expect(h.errors()).toEqual(['Failed to add model to domain.']);
      expect(fs.existsSync(ymlPath(h, 'dim_new'))).toBe(false);
      expect(h.readDomain().logical.models).toEqual(['fct_order', 'dim_task']);
    });

    it('does not rewrite the yml of a model that is already in the library', async () => {
      const before = fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8');

      await h.send({ type: 'addExistingModel', payload: { modelName: 'dim_customer' } });

      expect(h.errors()).toEqual([]);
      const edit = _appliedEdits[0];
      expect(edit._opsFor(ymlPath(h, 'dim_customer'))).toEqual([]);
      expect(fs.readFileSync(ymlPath(h, 'dim_customer'), 'utf-8')).toBe(before);
      expect(h.readDomain().logical.models).toContain('dim_customer');
    });
  });
});
