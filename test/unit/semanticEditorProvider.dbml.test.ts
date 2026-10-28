/**
 * Every canvas edit on a native DBML diagram (§5.3 handler table, §9.5 of
 * docs/plans/native-dbml-storage.md, stage S5), run on a copy of the
 * `dbml-native` fixture through the real SemanticEditorProvider:
 *
 * - exactly one `applyEdit`, writing the expected set of paths;
 * - every `.dbml` file of the project still compiles in 9.1.1, 10.3.1 and
 *   11.0.0 with no diagnostic it did not have before;
 * - re-reading through a fresh TableLibraryService / SubjectAreaService gives
 *   the intended state;
 * - a no-op edit leaves every byte unchanged;
 * - a file open with unsaved changes refuses the edit by name;
 * - every written path is in `editedTablePaths` and recorded as an own write;
 * - D20 (a YAML table, or a DBML relationship to one) and the reserved name
 *   `_relationships` are refused.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { SemanticTable } from '../../src/types/semantic';
import { projectDiagnostics } from '../../packages/core/test/dbmlWriterSupport';
import { TABLE_NAME_RULE } from '../../src/types/naming';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let root: string;
const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const relOf = (abs: string): string => path.relative(path.join(root, '.erd-studio'), abs).split(path.sep).join('/');

function buildProvider(tracker: OwnWriteTracker, options: { offers?: boolean } = {}): { provider: SemanticEditorProvider; tables: TableLibraryService } {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tables = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tables);
  const context = {
    extensionUri: vscode.Uri.file(path.join(root, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    // `true` answers every "Don't Ask Again" key, so no offer is made unless a test asks for them.
    workspaceState: { get: () => !options.offers, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const provider = new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty, getRelationshipTests: () => [] } as unknown as ManifestService,
    { loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }) } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    root,
    selectors,
    tables,
    tracker,
  );
  return { provider, tables };
}

/** Every file under the semantic dir, relative path → text. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[relOf(abs)] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

/** The `.dbml` files of a snapshot, and their diagnostics in every parser as one project. */
function diagnosticsOf(files: Record<string, string>): string[] {
  const dbml = Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.dbml')));
  return projectDiagnostics(dbml).map((d) => `${d.parser} ${d.file} ${d.type} ${d.text}`).sort();
}

interface Run {
  errors: string[];
  written: string[];
  before: Record<string, string>;
  after: Record<string, string>;
  provider: SemanticEditorProvider;
  tracker: OwnWriteTracker;
  recorded: string[];
}

/** Open `diagram` on the canvas, send `message`, and report what happened. */
async function run(message: unknown, diagram = 'gold/sales.dbml', prepare?: () => void): Promise<Run> {
  const tracker = new OwnWriteTracker();
  const recorded: string[] = [];
  vi.spyOn(tracker, 'recordWrite').mockImplementation((p: string) => { recorded.push(relOf(p)); });
  vi.spyOn(tracker, 'recordDelete').mockImplementation((p: string) => { recorded.push(relOf(p)); });
  const { provider } = buildProvider(tracker);
  const document = createMockTextDocument(at(diagram), fs.readFileSync(at(diagram), 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  prepare?.();
  _appliedEdits.length = 0;
  panel._postedMessages.length = 0;
  recorded.length = 0;
  const before = snapshot();
  await panel._simulateMessage(message);
  const errors = panel._postedMessages
    .filter((m): m is { type: 'error'; payload: { message: string } } => (m as { type: string }).type === 'error')
    .map((m) => m.payload.message);
  const written = [...new Set(_appliedEdits.flatMap((e) => (e as unknown as { _ops: Array<{ uri: { fsPath: string } }> })._ops.map((op) => relOf(op.uri.fsPath))))].sort();
  return { errors, written, before, after: snapshot(), provider, tracker, recorded };
}

/** A fresh read of the library (no cache shared with the provider). */
const library = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');
const table = (name: string): SemanticTable => library().getTable(name)!;

/** The common checks of a row that writes. */
function expectWrote(r: Run, paths: string[]): void {
  expect(r.errors).toEqual([]);
  expect(_appliedEdits).toHaveLength(1);
  expect(r.written).toEqual([...paths].sort());
  // Every file still compiles everywhere, with nothing new to report.
  const before = new Set(diagnosticsOf(r.before));
  expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  // Undo flushes, and the watchers skip, every path this edit wrote.
  const edited = [...((r.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths.values())]
    .flatMap((set) => [...set]).map(relOf);
  for (const p of paths) {
    const deleted = !(p in r.after);
    expect(r.recorded, `own write for ${p}`).toContain(p);
    if (!deleted && p !== 'gold/sales.dbml' && p !== 'silver/staging.dbml') expect(edited, `editedTablePaths has ${p}`).toContain(p);
  }
  // Nothing outside the written paths changed.
  for (const file of new Set([...Object.keys(r.before), ...Object.keys(r.after)])) {
    if (!paths.includes(file)) expect(r.after[file], `${file} is unchanged`).toBe(r.before[file]);
  }
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-edit-'));
  fs.cpSync(NATIVE, root, { recursive: true });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('table edits (applyTableEdit): the table file is spliced, the diagram keeps its bytes', () => {
  it('addColumn', async () => {
    const r = await run({ type: 'addColumn', payload: { modelName: 'fct_order', column: { name: 'discount', dataType: 'DECIMAL', description: '' } } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/fct_order.dbml']);
    expect(r.after['gold/sales.dbml']).toBe(r.before['gold/sales.dbml']);
    expect(table('fct_order').columns.map((c) => c.name)).toContain('discount');
    // Comments and DBML-only settings survive.
    expect(r.after['tables/gold/fct_order.dbml']).toContain('// Order lines from the shop.');
    expect(r.after['tables/gold/fct_order.dbml']).toContain('default: `now()`');
  });

  it('updateColumn (a description)', async () => {
    const r = await run({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'amount', column: { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Line total incl. tax' } } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/fct_order.dbml']);
    expect(table('fct_order').columns.find((c) => c.name === 'amount')?.description).toBe('Line total incl. tax');
  });

  it('updateColumn (a rename): its relationships follow, in the relationships file', async () => {
    const r = await run({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'customer_key', column: { name: 'cust_key', dataType: 'INT', description: '', isForeignKey: true } } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/fct_order.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).toContain('Ref: fct_order.cust_key >? dim_customer.customer_key');
    expect(table('fct_order').relationships?.some((rel) => rel.fromColumn === 'cust_key' && rel.toModel === 'dim_customer')).toBe(true);
  });

  it('removeColumn: its Ref is cut', async () => {
    const r = await run({ type: 'removeColumn', payload: { modelName: 'fct_order', columnName: 'ship_date_key' } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/fct_order.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).not.toContain('ship date');
    expect(table('fct_order').columns.map((c) => c.name)).not.toContain('ship_date_key');
  });

  it('toggleColumnKey', async () => {
    const r = await run({ type: 'toggleColumnKey', payload: { modelName: 'dim_region', columnName: 'region_name', keyType: 'NK', value: true } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/dim_region.dbml']);
    expect(table('dim_region').columns.find((c) => c.name === 'region_name')?.isNaturalKey).toBe(true);
  });

  it('reorderColumns', async () => {
    const r = await run({ type: 'reorderColumns', payload: { modelName: 'dim_date', orderedNames: ['calendar_date', 'date_key', 'previous_date_key', 'is_weekend'] } });
    expectWrote(r, ['gold/sales.dbml', 'tables/dim_date.dbml']);
    expect(table('dim_date').columns.map((c) => c.name)).toEqual(['calendar_date', 'date_key', 'previous_date_key', 'is_weekend']);
  });

  it.each([
    ['updateModelRationale', { modelName: 'dim_region', rationale: { purpose: 'Regions for reporting' } }, (t: SemanticTable) => expect(t.rationale?.purpose).toBe('Regions for reporting')],
    ['updateModelDescription', { modelName: 'dim_region', description: 'Sales regions' }, (t: SemanticTable) => expect(t.description).toBe('Sales regions')],
    ['updateModelGrain', { modelName: 'dim_region', grain: 'One row per region' }, (t: SemanticTable) => expect(t.grain).toBe('One row per region')],
    ['updateModelAlias', { modelName: 'dim_region', alias: 'regions' }, (t: SemanticTable) => expect(t.alias).toBe('regions')],
    ['updateMeta', { modelName: 'dim_region', set: { owner: 'finance' } }, (t: SemanticTable) => expect(t.meta).toMatchObject({ owner: 'finance' })],
    ['updateModelRole', { modelName: 'dim_region', modelRole: 'conformed-dim' }, (t: SemanticTable) => expect(t.modelRole).toBe('conformed-dim')],
  ] as const)('%s', async (type, payload, check) => {
    const r = await run({ type, payload });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/dim_region.dbml']);
    check(table('dim_region'));
  });

  it('a no-op edit leaves every byte unchanged', async () => {
    const r = await run({ type: 'updateModelDescription', payload: { modelName: 'fct_order', description: 'Order lines' } });
    expect(r.errors).toEqual([]);
    expect(r.after).toEqual(r.before);
  });
});

describe('after an edit, only the files it wrote are read again', () => {
  it('an edit to one table keeps every other table\'s cached reading and the library index', async () => {
    // The copy's directories just changed: put their times in the past, so the index is not in its racy window.
    const past = new Date(Date.now() - 60_000);
    const age = (dir: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) age(path.join(dir, d.name));
      fs.utimesSync(dir, past, past);
    };
    age(path.join(root, '.erd-studio'));
    fs.utimesSync(at('layers.json'), past, past);
    const { provider, tables } = buildProvider(new OwnWriteTracker());
    const document = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const cache = (tables as unknown as { dbmlCache: Map<string, unknown> }).dbmlCache;
    const customer = cache.get(at('tables/gold/dim_customer.dbml'));
    const order = cache.get(at('tables/gold/fct_order.dbml'));
    expect(customer).toBeDefined();
    expect(order).toBeDefined();
    const builds = tables.indexBuilds;
    const wipe = vi.spyOn(tables, 'invalidateCache');

    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'addColumn', payload: { modelName: 'fct_order', column: { name: 'discount', dataType: 'DECIMAL', description: '' } } });
    expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'error')).toEqual([]);
    expect(wipe.mock.calls.filter((args) => args.length === 0 || args[0] === undefined)).toEqual([]);
    // fct_order was written and read again; dim_customer is the very same reading.
    expect(cache.get(at('tables/gold/fct_order.dbml'))).not.toBe(order);
    expect(cache.get(at('tables/gold/dim_customer.dbml'))).toBe(customer);
    // No table file appeared or went: the library was not listed again.
    expect(tables.indexBuilds).toBe(builds);
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { models: Array<{ name: string; columns: Array<{ name: string }> }> } };
    expect(loaded.payload.models.find((m) => m.name === 'fct_order')?.columns.map((c) => c.name)).toContain('discount');
  });
});

describe('relationship edits: always in the library (D5), in the owner\'s folder file', () => {
  it('addRelationship', async () => {
    const r = await run({ type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_region', toColumn: 'region_name', cardinality: 'many-to-one' } });
    // The relationships file only: the column is no key, and the table file holds no Ref (D3).
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['gold/sales.dbml']).toBe(r.before['gold/sales.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).toContain('Ref: customer_profile.loyalty_tier >? dim_region.region_name');
    expect(table('customer_profile').relationships?.some((rel) => rel.fromColumn === 'loyalty_tier')).toBe(true);
  });

  it('updateRelationship (a cardinality)', async () => {
    const r = await run({ type: 'updateRelationship', payload: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-many' } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).toContain('Ref: fct_order.customer_key <>? dim_customer.customer_key');
  });

  it('editRelationship (a role)', async () => {
    const r = await run({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'fct_order', originalFromColumn: 'order_date_key', originalToModel: 'dim_date', originalToColumn: 'date_key',
        fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'booked',
      },
    });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).toContain('Ref booked: fct_order.order_date_key >? dim_date.date_key');
  });

  it('removeRelationship', async () => {
    const r = await run({ type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).not.toContain('order date');
  });

  it('removeRelationships (two at once, one edit)', async () => {
    const r = await run({ type: 'removeRelationships', payload: { relationships: [
      { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' },
      { fromModel: 'dim_date', fromColumn: 'previous_date_key', toModel: 'dim_date', toColumn: 'date_key' },
    ] } });
    expectWrote(r, ['gold/sales.dbml', 'tables/_relationships.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['tables/_relationships.dbml']).not.toMatch(/^Ref/m);
    expect(table('dim_date').relationships).toBeUndefined();
  });

  it('a relationships file open with unsaved changes refuses the edit by name, and nothing is written', async () => {
    const r = await run(
      { type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' } },
      'gold/sales.dbml',
      () => {
        const doc = createMockTextDocument(at('tables/gold/_relationships.dbml'), fs.readFileSync(at('tables/gold/_relationships.dbml'), 'utf-8'));
        doc._setText(`${doc.getText()}// typing\n`);
        (vscode.workspace.textDocuments as unknown[]).push(doc);
      },
    );
    expect(r.errors.join(' ')).toContain('.erd-studio/tables/gold/_relationships.dbml has unsaved changes');
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });
});

describe('adding, renaming and removing tables', () => {
  it('addModel: a new .dbml table in the layer\'s folder, its use line and its position', async () => {
    const r = await run({ type: 'addModel', payload: { name: 'dim_store', description: '', columns: [{ name: 'store_key', dataType: 'INT', description: '', isPrimaryKey: true }] } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml', 'tables/gold/dim_store.dbml']);
    expect(r.after['gold/sales.dbml']).toContain("use { table dim_store } from '../tables/gold/dim_store.dbml'");
    expect(r.after['gold/sales.dbdiagram']).toContain('"name": "dim_store"');
    expect(table('dim_store').columns[0]).toMatchObject({ name: 'store_key', isPrimaryKey: true });
  });

  it('addExistingModel: a use line, and a layout file created for its position', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: 'dim_customer' } }, 'silver/staging.dbml');
    expectWrote(r, ['silver/staging.dbdiagram', 'silver/staging.dbml']);
    expect(r.after['silver/staging.dbml']).toContain("use { table dim_customer } from '../tables/gold/dim_customer.dbml'");
    expect(new SubjectAreaService(new LayerService(root, '.erd-studio')).listSubjectAreas(root, '.erd-studio').length).toBe(2);
  });

  it('addExistingModels: several in one edit', async () => {
    const r = await run({ type: 'addExistingModels', payload: { modelNames: ['dim_customer', 'dim_region'] } }, 'silver/staging.dbml');
    expectWrote(r, ['silver/staging.dbdiagram', 'silver/staging.dbml']);
    expect(r.after['silver/staging.dbml']).toContain('use { table dim_customer }');
    expect(r.after['silver/staging.dbml']).toContain('use { table dim_region }');
  });

  it('renameModel: the file, the Refs and use lines naming it, and the layout key follow', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/dim_area.dbml', 'tables/gold/dim_region.dbml']);
    expect('tables/gold/dim_region.dbml' in r.after).toBe(false);
    expect(r.after['tables/gold/dim_area.dbml']).toMatch(/^Table dim_area /);
    expect(r.after['tables/gold/_relationships.dbml']).toContain("use { table dim_area } from './dim_area.dbml'");
    expect(r.after['tables/gold/_relationships.dbml']).toContain('dim_area.(region_code, country_code)');
    expect(r.after['tables/gold/_relationships.dbml']).not.toMatch(/dim_region/);
    expect(r.after['gold/sales.dbml']).toContain("use { table dim_area } from '../tables/gold/dim_area.dbml'");
    expect(r.after['gold/sales.dbdiagram']).toContain('"name": "dim_area"');
    expect(table('fct_order').relationships?.some((rel) => rel.toModel === 'dim_area')).toBe(true);
  });

  it('renameModel reaches every other diagram that uses the table', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } });
    expect(r.errors).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(r.written).toEqual(expect.arrayContaining(['silver/staging.dbml', 'gold/sales.dbml', 'tables/_relationships.dbml', 'tables/gold/_relationships.dbml', 'tables/dim_day.dbml', 'tables/dim_date.dbml']));
    expect(r.after['silver/staging.dbml']).toContain("use { table dim_day } from '../tables/dim_day.dbml'");
    // Re-spelled only: the operator as the file had it (a bare `>`) is kept.
    expect(r.after['tables/_relationships.dbml']).toContain('Ref "previous day": dim_day.previous_date_key > dim_day.date_key');
    const before = new Set(diagnosticsOf(r.before));
    expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  });

  it('removeModels of a folder\'s last member: its relationships file\'s use line goes too', async () => {
    const r = await run({ type: 'removeModels', payload: { modelNames: ['dim_date'] } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).not.toContain("use { table dim_date }");
    // No member is left at the top of tables/, so its relationships file is no longer imported;
    // the gold folder's still is.
    expect(r.after['gold/sales.dbml']).not.toContain("use * from '../tables/_relationships.dbml'");
    expect(r.after['gold/sales.dbml']).toContain("use * from '../tables/gold/_relationships.dbml'");
    expect(r.after['gold/sales.dbdiagram']).not.toContain('"dim_date"');
    expect('tables/dim_date.dbml' in r.after).toBe(true);
  });

  it('removeModels: the use line and the position go; the table file stays', async () => {
    const r = await run({ type: 'removeModels', payload: { modelNames: ['bridge_empty'] } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).not.toContain('bridge_empty');
    expect('tables/gold/bridge_empty.dbml' in r.after).toBe(true);
  });
});

describe('the settle pass (§5.3 step 4)', () => {
  it('a relationships file the edit creates gets a use line in this diagram and in every other diagram with a member in its folder', async () => {
    const add = await run({ type: 'addModel', payload: { name: 'fct_visit', description: '', columns: [
      { name: 'visit_id', dataType: 'INT', description: '', isPrimaryKey: true },
      { name: 'date_key', dataType: 'INT', description: '' },
    ] } }, 'silver/staging.dbml');
    expect(add.errors).toEqual([]);
    expect('tables/silver/fct_visit.dbml' in add.after).toBe(true);
    _resetMockWorkspace();
    const join = await run({ type: 'addExistingModel', payload: { modelName: 'fct_visit' } });
    expect(join.errors).toEqual([]);
    _resetMockWorkspace();
    const r = await run({ type: 'addRelationship', payload: { fromModel: 'fct_visit', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } }, 'silver/staging.dbml');
    expectWrote(r, ['gold/sales.dbml', 'silver/staging.dbml', 'tables/silver/_relationships.dbml']);
    expect(r.after['tables/silver/_relationships.dbml']).toContain('Ref: fct_visit.date_key >? dim_date.date_key');
    expect(r.after['silver/staging.dbml']).toContain("use * from '../tables/silver/_relationships.dbml'");
    expect(r.after['gold/sales.dbml']).toContain("use * from '../tables/silver/_relationships.dbml'");
  });
});

describe('positions and sticky notes', () => {
  it('updatePositions: the layout only', async () => {
    const r = await run({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).toBe(r.before['gold/sales.dbml']);
  });

  it('updatePositions with the same positions writes nothing new', async () => {
    const r = await run({ type: 'updatePositions', payload: { positions: { fct_order: { x: 400, y: 200 } } } });
    expect(r.errors).toEqual([]);
    expect(r.after).toEqual(r.before);
  });

  it('addAnnotation: a Note block and its box', async () => {
    const r = await run({ type: 'addAnnotation', payload: { id: '11111111-2222-4333-8444-555555555555', text: 'New note', x: 100, y: 900, color: 'yellow' } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).toContain('Note "11111111-2222-4333-8444-555555555555"');
  });

  it('updateAnnotation: the Note text', async () => {
    const r = await run({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Grain agreed' } });
    expectWrote(r, ['gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).toContain("'Grain agreed'");
  });

  it('removeAnnotations: the Note block and its box', async () => {
    const r = await run({ type: 'removeAnnotations', payload: { ids: ['9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f'] } });
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).not.toContain('9a0d2b77');
    expect(r.after['gold/sales.dbdiagram']).not.toContain('9a0d2b77');
  });
});

describe('undo (§5.8): the toolbar Undo flushes every file the canvas wrote, layout files included', () => {
  it.each([
    ['a drag (layout only)', { type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } }],
    ['a column edit', { type: 'updateModelDescription', payload: { modelName: 'dim_region', description: 'Regions' } }],
    ['a relationship add', { type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_region', toColumn: 'region_name', cardinality: 'many-to-one' } }],
  ] as const)('%s: rewinding the documents and pressing Undo puts every file back on disk', async (_label, message) => {
    const tracker = new OwnWriteTracker();
    const { provider } = buildProvider(tracker);
    const document = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    const before = snapshot();
    await panel._simulateMessage(message);
    const changed = Object.keys(before).filter((p) => snapshot()[p] !== before[p]);
    expect(changed.length).toBeGreaterThan(0);
    // VS Code's undo rewinds each edited document in memory (the mock's `undo` command does nothing):
    // do that by hand, then press the toolbar's Undo, which must save every one of them.
    for (const p of changed) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === at(p)) as unknown as { _setText(t: string): void } | undefined;
      expect(doc, `${p} was edited through an open document`).toBeDefined();
      doc!._setText(before[p]);
    }
    await panel._simulateMessage({ type: 'undo' });
    expect(snapshot()).toEqual(before);
  });
});

describe('refusals (D20, §2.1)', () => {
  beforeEach(() => {
    fs.writeFileSync(at('tables/gold/dim_yaml.yml'), 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n    isPrimaryKey: true\n');
    fs.writeFileSync(at('gold/mixed.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'mixed', layer: 'gold',
      logical: { models: ['customer_profile', 'dim_yaml'], relationships: [] }, viewConfig: {},
    }, null, 2)}\n`);
  });

  it('a YAML table cannot join a DBML diagram', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: 'dim_yaml' } });
    expect(r.errors.join(' ')).toContain('"dim_yaml" is a YAML table');
    expect(r.errors.join(' ')).toContain('Convert Project to DBML');
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });

  it('a DBML owner cannot get a relationship to a YAML table', async () => {
    const r = await run(
      { type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_yaml', toColumn: 'id', cardinality: 'many-to-one' } },
      'gold/mixed.json',
    );
    expect(r.errors.join(' ')).toContain('dim_yaml is a YAML table');
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });

  it('a new DBML table may not be named _relationships', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: '_Relationships' } });
    expect(r.errors.join(' ')).toContain('‘_relationships’ is the name of the relationships file');
    expect(_appliedEdits).toHaveLength(0);
  });

  it('a DBML table may not be renamed to _relationships: the authoring rule (a letter first) refuses it', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'bridge_empty', newName: '_relationships' } });
    // A typed name always starts with a letter, so it can never be the reserved
    // one; the planner refuses it for every other caller (dbmlLibraryWrites.test.ts).
    expect(r.errors).toEqual([expect.stringContaining(TABLE_NAME_RULE)]);
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });

  it('a new table may not be named _relationships: the authoring rule refuses it', async () => {
    const r = await run({ type: 'addModel', payload: { name: '_relationships', description: '', columns: [{ name: 'id', dataType: 'INT', description: '' }] } });
    expect(r.errors).toEqual([expect.stringContaining(TABLE_NAME_RULE)]);
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });
});

describe('a partial apply is put back (D23)', () => {
  it('VS Code applying only some of the steps leaves every file as it was, and the edit reports failure', async () => {
    const { _mockWorkspaceState } = await import('../__mocks__/vscode');
    const r = await run(
      { type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } },
      'gold/sales.dbml',
      () => { _mockWorkspaceState.applyEditPrefixes.push(3); },
    );
    expect(r.errors.length).toBeGreaterThan(0);
    expect(_appliedEdits).toHaveLength(2);
    expect(r.after).toEqual(r.before);
  });
});

describe('Turn Round (commitRelationshipWrite) on a DBML diagram', () => {
  it('stores a backwards many-to-one the right way round: it moves to its new owner\'s folder file, as one edit', async () => {
    // Drawn from dim_date's key, so the canvas flags it as backwards; stored
    // where that (wrong) owner lives, at the top of tables/.
    const gold = at('tables/gold/_relationships.dbml');
    fs.writeFileSync(gold, fs.readFileSync(gold, 'utf-8').replace('Ref "ship date": fct_order.ship_date_key >? dim_date.date_key\n', ''));
    const top = at('tables/_relationships.dbml');
    fs.writeFileSync(top, fs.readFileSync(top, 'utf-8')
      .replace("use { table dim_date } from './dim_date.dbml'\n", "use { table dim_date } from './dim_date.dbml'\nuse { table fct_order } from './gold/fct_order.dbml'\n")
      .concat('Ref "ship date": dim_date.date_key > fct_order.ship_date_key\n'));
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (text: string) =>
      (String(text).includes('drawn backwards') ? 'Turn Round' : undefined)) as never);
    const tracker = new OwnWriteTracker();
    const { provider } = buildProvider(tracker, { offers: true });
    const document = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    const before = snapshot();
    await panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(table('fct_order').relationships?.some((r) => r.fromColumn === 'ship_date_key' && r.toModel === 'dim_date')).toBe(true));
    await vi.waitFor(() => expect(snapshot()['tables/gold/_relationships.dbml']).toContain('Ref "ship date": fct_order.ship_date_key >? dim_date.date_key'));

    expect(_appliedEdits).toHaveLength(1);
    const written = [...new Set(_appliedEdits[0]._ops.map((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath)))].sort();
    expect(written).toEqual(['gold/sales.dbml', 'tables/_relationships.dbml', 'tables/gold/_relationships.dbml']);
    const after = snapshot();
    expect(after['gold/sales.dbml']).toBe(before['gold/sales.dbml']);
    expect(after['tables/_relationships.dbml']).not.toContain('dim_date.date_key > fct_order');
    expect(table('dim_date').relationships?.some((r) => r.toModel === 'fct_order') ?? false).toBe(false);
    expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'error')).toEqual([]);
    const diagnostics = new Set(diagnosticsOf(before));
    expect(diagnosticsOf(after).filter((d) => !diagnostics.has(d))).toEqual([]);
  });
});

describe('the ready load\'s position save (autoPositionNewTables, §5.3)', () => {
  /** sales.dbdiagram without bridge_empty's position: a partially positioned diagram. */
  const dropPosition = (): void => {
    const layout = JSON.parse(fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8'));
    layout.defaultView.tablePositions = layout.defaultView.tablePositions.filter((p: { name: string }) => p.name !== 'bridge_empty');
    fs.writeFileSync(at('gold/sales.dbdiagram'), `${JSON.stringify(layout, null, 2)}\n`);
  };
  async function openAndReady(prepare?: () => void): Promise<{ r: Run; posted: Array<{ type: string; payload?: unknown }> }> {
    const tracker = new OwnWriteTracker();
    const recorded: string[] = [];
    vi.spyOn(tracker, 'recordWrite').mockImplementation((p: string) => { recorded.push(relOf(p)); });
    vi.spyOn(tracker, 'recordDelete').mockImplementation((p: string) => { recorded.push(relOf(p)); });
    const { provider } = buildProvider(tracker);
    const document = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    prepare?.();
    _appliedEdits.length = 0;
    panel._postedMessages.length = 0;
    const before = snapshot();
    await panel._simulateMessage({ type: 'ready' });
    const posted = panel._postedMessages as Array<{ type: string; payload?: unknown }>;
    const errors = posted.filter((m) => m.type === 'error').map((m) => (m.payload as { message: string }).message);
    const written = [...new Set(_appliedEdits.flatMap((e) => e._ops.map((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath))))].sort();
    return { r: { errors, written, before, after: snapshot(), provider, tracker, recorded }, posted };
  }

  it('a partially positioned diagram: only the layout changes, the .dbml keeps its bytes', async () => {
    dropPosition();
    const { r, posted } = await openAndReady();
    expectWrote(r, ['gold/sales.dbdiagram', 'gold/sales.dbml']);
    expect(r.after['gold/sales.dbml']).toBe(r.before['gold/sales.dbml']);
    expect(r.after['gold/sales.dbdiagram']).toContain('"name": "bridge_empty"');
    expect(posted.some((m) => m.type === 'domainLoaded')).toBe(true);
  });

  it.each([
    ['the diagram is read-only (a second Project)', () => {
      fs.appendFileSync(at('gold/sales.dbml'), "\nProject other {\n  Note: 'x'\n}\n");
    }, undefined],
    ['its layout file is open with unsaved changes', undefined, () => {
      const doc = createMockTextDocument(at('gold/sales.dbdiagram'), fs.readFileSync(at('gold/sales.dbdiagram'), 'utf-8'));
      doc._setText(`${doc.getText()} `);
      (vscode.workspace.textDocuments as unknown[]).push(doc);
    }],
    ['its layout file is not a JSON object', () => {
      fs.writeFileSync(at('gold/sales.dbdiagram'), '[]\n');
    }, undefined],
  ] as const)('%s: nothing is written, and the canvas still loads with the computed positions', async (_label, onDisk, whileOpen) => {
    dropPosition();
    (onDisk as (() => void) | undefined)?.();
    const { r, posted } = await openAndReady(whileOpen as (() => void) | undefined);
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
    expect(r.errors).toEqual([]);
    const domain = posted.find((m) => m.type === 'domainLoaded') as { payload: { viewConfig: { positions: Record<string, unknown> } } } | undefined;
    expect(domain).toBeDefined();
    expect(Object.keys(domain!.payload.viewConfig.positions)).toContain('bridge_empty');
  });
});

describe('Delete Table (File): the D16 cascade', () => {
  beforeEach(() => {
    // A YAML table with a relationship to the DBML dim_date, and a JSON diagram showing both.
    fs.writeFileSync(at('tables/gold/fct_y.yml'), [
      'name: fct_y', 'columns:', '  - name: id', '    dataType: INT', '    isPrimaryKey: true', '  - name: date_key', '    dataType: INT',
      'relationships:', '  - fromColumn: date_key', '    toModel: dim_date', '    toColumn: date_key', '    cardinality: many-to-one', '',
    ].join('\n'));
    fs.writeFileSync(at('gold/mixed.json'), `${JSON.stringify({
      schemaVersion: 5, domain: 'mixed', layer: 'gold',
      logical: { models: ['fct_y', 'dim_date'], relationships: [] }, viewConfig: {},
    }, null, 2)}\n`);
  });

  it('deletes a DBML table a YAML table points at: DBML Refs and use lines go, the yml and JSON diagrams are left alone', async () => {
    const { provider } = buildProvider(new OwnWriteTracker());
    // A JSON diagram open with unsaved changes is never written, so it does not refuse the delete.
    const json = createMockTextDocument(at('gold/mixed.json'), fs.readFileSync(at('gold/mixed.json'), 'utf-8'));
    json._setText(`${json.getText()} `);
    (vscode.workspace.textDocuments as unknown[]).push(json);
    // The prompt counts what the cascade removes: dim_date's own Ref and fct_order's two; fct_y keeps its own.
    expect(provider.describeDbmlDeleteCascade(['dim_date'], false))
      .toBe(" This removes the table's file, its 3 relationships and its place in 2 diagrams.");
    const before = snapshot();
    expect(await provider.deleteTablesWithCascade(['dim_date'])).toEqual({ ok: true, unrestored: [] });
    const after = snapshot();
    expect('tables/dim_date.dbml' in after).toBe(false);
    expect(after['tables/gold/fct_y.yml']).toBe(before['tables/gold/fct_y.yml']);
    expect(after['gold/mixed.json']).toBe(before['gold/mixed.json']);
    for (const diagram of ['gold/sales.dbml', 'silver/staging.dbml']) {
      expect(after[diagram]).not.toContain('dim_date');
      expect(after[diagram]).not.toContain("use * from '../tables/_relationships.dbml'");
    }
    expect(after['tables/gold/_relationships.dbml']).not.toContain('dim_date');
    expect(after['tables/_relationships.dbml']).not.toMatch(/^Ref/m);
    const diagnostics = new Set(diagnosticsOf(before));
    expect(diagnosticsOf(after).filter((d) => !diagnostics.has(d))).toEqual([]);
  });

  it('the fs Delete Table (TableLibraryService.deleteTable) with a YAML owner deletes too, leaving the yml as it is', () => {
    const before = snapshot();
    library().deleteTable('dim_date');
    const after = snapshot();
    expect('tables/dim_date.dbml' in after).toBe(false);
    expect(after['tables/gold/fct_y.yml']).toBe(before['tables/gold/fct_y.yml']);
    expect(after['tables/gold/_relationships.dbml']).not.toContain('dim_date');
  });

  it('a delete VS Code applies part of reports what could not be put back, so callers say nothing contradictory', async () => {
    const { _mockWorkspaceState } = await import('../__mocks__/vscode');
    vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
    const { provider } = buildProvider(new OwnWriteTracker());
    // Put back: nothing changed, and nothing is left half-deleted.
    _mockWorkspaceState.applyEditPrefixes.push(1);
    expect(await provider.deleteTablesWithCascade(['dim_date'])).toEqual({ ok: false, unrestored: [] });
    // Not put back: the files the reconcile could not restore are named.
    _mockWorkspaceState.applyEditPrefixes.push(1, 0);
    const result = await provider.deleteTablesWithCascade(['dim_date']);
    expect(result.ok).toBe(false);
    expect(result.unrestored.length).toBeGreaterThan(0);
  });

  it('a file that could not be saved afterwards is reported by name', async () => {
    const { _failMockSave } = await import('../__mocks__/vscode');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation((async () => undefined) as never);
    const { provider } = buildProvider(new OwnWriteTracker());
    _failMockSave(at('tables/gold/_relationships.dbml'));
    expect(await provider.deleteTablesWithCascade(['dim_date'])).toEqual({ ok: true, unrestored: [] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save .erd-studio/tables/gold/_relationships.dbml'));
  });
});

describe('another diagram with a byte-order mark (D7)', () => {
  it('is re-rendered without one: VS Code keeps the BOM as the encoding, so the text never carries a second', async () => {
    fs.writeFileSync(at('silver/staging.dbml'), `﻿${fs.readFileSync(at('silver/staging.dbml'), 'utf-8')}`);
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } });
    expect(r.errors).toEqual([]);
    const ops = _appliedEdits[0]._ops.filter((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath) === 'silver/staging.dbml');
    expect(ops).toHaveLength(1);
    const text = (ops[0] as { newText: string }).newText;
    expect(text.startsWith('﻿')).toBe(false);
    expect(text).toContain("use { table dim_day } from '../tables/dim_day.dbml'");
  });
});

describe('messages name the project\'s own table library', () => {
  it('a table with no file is named where a new one goes: tables/<name>.dbml, never logical-models/<name>.yml', () => {
    const { provider } = buildProvider(new OwnWriteTracker());
    const named = (provider as unknown as { libraryRelativePath(name: string): string }).libraryRelativePath('dim_missing');
    expect(named).toBe('tables/dim_missing.dbml');
    expect((provider as unknown as { libraryRelativePath(name: string): string }).libraryRelativePath('dim_date')).toBe('tables/dim_date.dbml');
  });

  it('adding a table found nowhere says so without naming logical-models/', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: 'dim_nowhere' } });
    expect(r.errors).toEqual(['Table "dim_nowhere" not found in your dbt .yml files, the manifest or the table library.']);
  });
});

describe('a diagram with a member with no table file and pending relationships (D26/D27): the canvas draws and edits it', () => {
  const withMissing = (): void => {
    fs.writeFileSync(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8')
      .replace('  erd_layout_options', "  erd_unlinked_tables: 'gld_fct_risk_child'\n  erd_layout_options")
      .concat('\n// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? dim_customer.customer_key\n'));
    fs.appendFileSync(at('tables/gold/_relationships.dbml'), '\n// erd-studio pending: Ref: fct_order.customer_key >? gld_fct_risk_child.customer_key\n');
  };

  it('draws the missing member as a placeholder and both pending relationships, like a JSON diagram', async () => {
    withMissing();
    const tracker = new OwnWriteTracker();
    const { provider } = buildProvider(tracker);
    const document = createMockTextDocument(at('gold/sales.dbml'), fs.readFileSync(at('gold/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { models: Array<{ name: string; columns: unknown[] }>; relationships: Array<Record<string, string>> } };
    expect(loaded.payload.models.at(-1)).toMatchObject({ name: 'gld_fct_risk_child', columns: [] });
    expect(loaded.payload.relationships.filter((r) => /risk/.test(`${r.fromModel} ${r.toModel}`))).toEqual([
      { fromModel: 'gld_fct_risk_child', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'gld_fct_risk_child', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
  });

  it('a relationship edit of the owner keeps its pending line; the diagram keeps its bytes', async () => {
    withMissing();
    const r = await run({ type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' } });
    expectWrote(r, ['gold/sales.dbml', 'tables/gold/_relationships.dbml']);
    expect(r.after['gold/sales.dbml']).toBe(r.before['gold/sales.dbml']);
    expect(r.after['tables/gold/_relationships.dbml']).toContain('// erd-studio pending: Ref: fct_order.customer_key >? gld_fct_risk_child.customer_key\n');
    expect(r.after['tables/gold/_relationships.dbml']).not.toContain('Ref "order date"');
  });

  it('removing the missing member drops it from erd_unlinked_tables (the key goes) and cuts the diagram\'s pending line with its relationship', async () => {
    withMissing();
    const r = await run({ type: 'removeModels', payload: { modelNames: ['gld_fct_risk_child'] } });
    expect(r.errors).toEqual([]);
    expect(r.after['gold/sales.dbml']).not.toContain('erd_unlinked_tables');
    expect(r.after['gold/sales.dbml']).not.toContain('erd-studio pending');
    expect(r.after['gold/sales.dbml'].endsWith("  ''\n}\n")).toBe(true);
  });

  it('a new table with that name, made in another diagram, gives it a use line here (the settle pass) and turns the pending Ref to it live', async () => {
    withMissing();
    const r = await run({ type: 'addModel', payload: { name: 'gld_fct_risk_child', description: '', columns: [{ name: 'customer_key', dataType: 'INT', description: '' }] } }, 'silver/staging.dbml');
    expect(r.errors).toEqual([]);
    expect(r.after['gold/sales.dbml']).not.toContain('erd_unlinked_tables');
    expect(r.after['gold/sales.dbml']).toContain("use { table gld_fct_risk_child } from '../tables/silver/gld_fct_risk_child.dbml'");
    const relationships = r.after['tables/gold/_relationships.dbml'];
    expect(relationships).toContain('Ref: fct_order.customer_key >? gld_fct_risk_child.customer_key\n');
    expect(relationships).not.toContain('// erd-studio pending: Ref: fct_order.customer_key');
    expect(relationships).toContain("use { table gld_fct_risk_child } from '../silver/gld_fct_risk_child.dbml'");
    // The diagram's own pending line (its owner had no file) stays until Convert moves it to the library.
    expect(r.after['gold/sales.dbml']).toContain('// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? dim_customer.customer_key');
    const before = new Set(diagnosticsOf(r.before));
    expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  });
});
