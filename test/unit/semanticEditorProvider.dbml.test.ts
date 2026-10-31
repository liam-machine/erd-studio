/**
 * Every canvas edit on a native DBML diagram in the layer-first tree (ERD
 * Studio 2.0: `<L>/diagrams/`, `<L>/tables/<S>/`, `<L>/relationships/`),
 * run on a copy of the `dbml-native` fixture through the real
 * SemanticEditorProvider:
 *
 * - exactly one `applyEdit`, writing the expected set of paths;
 * - every `.dbml` file of the project still compiles in 9.1.1, 10.3.1 and
 *   11.0.0 with no diagnostic it did not have before;
 * - re-reading through a fresh TableLibraryService / SubjectAreaService gives
 *   the intended state;
 * - a no-op edit leaves every byte unchanged;
 * - a file open with unsaved changes refuses the edit by name;
 * - every written path is in `editedTablePaths` and recorded as an own write;
 * - D20 (a YAML table, or a DBML relationship to one) is refused;
 * - every diagram imports exactly the relationships files holding a Ref
 *   between two of its tables (or a pending line between two tables it
 *   draws), settled in the same edit (§2.6).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _fireDidChangeTextDocument,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
  TextDocumentChangeReason,
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
import { convertOnDisk } from '../../scripts/convert-on-disk';

/** A `use { table … } from '…'` line, however far the formatter pads its `from` (consecutive use lines align). */
function useLine(table: string, from: string): RegExp {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^use \\{ table ${esc(table)} \\} +from '${esc(from)}'$`, 'm');
}

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
async function run(message: unknown, diagram = 'gold/diagrams/sales.dbml', prepare?: () => void): Promise<Run> {
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

/** The common checks of a row that writes; `primary` is the diagram the edit was made on. */
function expectWrote(r: Run, paths: string[], primary = 'gold/diagrams/sales.dbml'): void {
  expect(r.errors).toEqual([]);
  expect(_appliedEdits).toHaveLength(1);
  expect(r.written).toEqual([...paths].sort());
  // Every file still compiles everywhere, with nothing new to report.
  const before = new Set(diagnosticsOf(r.before));
  expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  // Undo flushes, and the watchers skip, every path this edit wrote: other
  // diagrams it settled included (the edited diagram is the undo anchor).
  const edited = [...((r.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths.values())]
    .flatMap((set) => [...set]).map(relOf);
  for (const p of paths) {
    const deleted = !(p in r.after);
    expect(r.recorded, `own write for ${p}`).toContain(p);
    if (!deleted && p !== primary) expect(edited, `editedTablePaths has ${p}`).toContain(p);
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
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml']);
    expect(table('fct_order').columns.map((c) => c.name)).toContain('discount');
    // Comments and DBML-only settings survive.
    expect(r.after['gold/tables/gold/fct_order.dbml']).toContain('// Order lines from the shop.');
    expect(r.after['gold/tables/gold/fct_order.dbml']).toContain('default: `now()`');
  });

  it('updateColumn (a description)', async () => {
    const r = await run({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'amount', column: { name: 'amount', dataType: 'DECIMAL(18,2)', description: 'Line total incl. tax' } } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(table('fct_order').columns.find((c) => c.name === 'amount')?.description).toBe('Line total incl. tax');
  });

  it('updateColumn (a rename): its relationships follow, in the relationships file', async () => {
    const r = await run({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'customer_key', column: { name: 'cust_key', dataType: 'INT', description: '', isForeignKey: true } } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).toContain('Ref: gold.fct_order.cust_key >? gold.dim_customer.customer_key');
    expect(table('fct_order').relationships?.some((rel) => rel.fromColumn === 'cust_key' && rel.toModel === 'dim_customer')).toBe(true);
  });

  it('removeColumn: its Ref is cut', async () => {
    const r = await run({ type: 'removeColumn', payload: { modelName: 'fct_order', columnName: 'ship_date_key' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/fct_order.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).not.toContain('ship date');
    expect(table('fct_order').columns.map((c) => c.name)).not.toContain('ship_date_key');
  });

  it('toggleColumnKey', async () => {
    const r = await run({ type: 'toggleColumnKey', payload: { modelName: 'dim_region', columnName: 'region_name', keyType: 'NK', value: true } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/dim_region.dbml']);
    expect(table('dim_region').columns.find((c) => c.name === 'region_name')?.isNaturalKey).toBe(true);
  });

  it('reorderColumns', async () => {
    const r = await run({ type: 'reorderColumns', payload: { modelName: 'dim_date', orderedNames: ['calendar_date', 'date_key', 'previous_date_key', 'is_weekend'] } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'silver/tables/calendar/dim_date.dbml']);
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
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/dim_region.dbml']);
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
    const document = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const cache = (tables as unknown as { dbmlCache: Map<string, unknown> }).dbmlCache;
    const customer = cache.get(at('gold/tables/gold/dim_customer.dbml'));
    const order = cache.get(at('gold/tables/gold/fct_order.dbml'));
    expect(customer).toBeDefined();
    expect(order).toBeDefined();
    const builds = tables.indexBuilds;
    const wipe = vi.spyOn(tables, 'invalidateCache');

    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'addColumn', payload: { modelName: 'fct_order', column: { name: 'discount', dataType: 'DECIMAL', description: '' } } });
    expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'error')).toEqual([]);
    expect(wipe.mock.calls.filter((args) => args.length === 0 || args[0] === undefined)).toEqual([]);
    // fct_order was written and read again; dim_customer is the very same reading.
    expect(cache.get(at('gold/tables/gold/fct_order.dbml'))).not.toBe(order);
    expect(cache.get(at('gold/tables/gold/dim_customer.dbml'))).toBe(customer);
    // No table file appeared or went: the library was not listed again.
    expect(tables.indexBuilds).toBe(builds);
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { models: Array<{ name: string; columns: Array<{ name: string }> }> } };
    expect(loaded.payload.models.find((m) => m.name === 'fct_order')?.columns.map((c) => c.name)).toContain('discount');
  });
});

describe('relationship edits: always in the library (D5), placed by decision 5, never moved', () => {
  it('addRelationship: in the file holding most of the owner\'s Refs (customers.dbml, split by hand)', async () => {
    const r = await run({ type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_region', toColumn: 'region_name', cardinality: 'many-to-one' } });
    // The relationships file only: the column is no key, and the table file holds no Ref (D3).
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/customers.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml']);
    expect(r.after['gold/relationships/customers.dbml']).toContain('Ref: gold.customer_profile.loyalty_tier >? gold.dim_region.region_name');
    expect(table('customer_profile').relationships?.some((rel) => rel.fromColumn === 'loyalty_tier')).toBe(true);
  });

  it('updateRelationship (a cardinality)', async () => {
    const r = await run({ type: 'updateRelationship', payload: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-many' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).toContain('Ref: gold.fct_order.customer_key <>? gold.dim_customer.customer_key');
  });

  it('editRelationship (a role)', async () => {
    const r = await run({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'fct_order', originalFromColumn: 'order_date_key', originalToModel: 'dim_date', originalToColumn: 'date_key',
        fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'booked',
      },
    });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).toContain('Ref booked: gold.fct_order.order_date_key >? calendar.dim_date.date_key');
  });

  it('removeRelationship', async () => {
    const r = await run({ type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).not.toContain('order date');
  });

  it('removeRelationships (two at once, one edit): a file left with no Ref between a diagram\'s tables is no longer imported, by any diagram', async () => {
    const r = await run({ type: 'removeRelationships', payload: { relationships: [
      { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' },
      { fromModel: 'dim_date', fromColumn: 'previous_date_key', toModel: 'dim_date', toColumn: 'date_key' },
    ] } });
    // staging.dbml (another layer's diagram) is settled in the same edit.
    expectWrote(r, ['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml', 'silver/relationships/calendar.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['silver/relationships/calendar.dbml']).not.toMatch(/^Ref/m);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain("use * from '../../silver/relationships/calendar.dbml'");
    expect(r.after['silver/diagrams/staging.dbml']).not.toContain("use * from '../relationships/calendar.dbml'");
    expect(r.after['silver/diagrams/staging.dbml']).toContain("use * from '../../gold/relationships/gold.dbml'");
    expect(table('dim_date').relationships).toBeUndefined();
  });

  it('a relationships file open with unsaved changes refuses the edit by name, and nothing is written', async () => {
    const r = await run(
      { type: 'removeRelationship', payload: { fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key' } },
      'gold/diagrams/sales.dbml',
      () => {
        const doc = createMockTextDocument(at('gold/relationships/gold.dbml'), fs.readFileSync(at('gold/relationships/gold.dbml'), 'utf-8'));
        doc._setText(`${doc.getText()}// typing\n`);
        (vscode.workspace.textDocuments as unknown[]).push(doc);
      },
    );
    expect(r.errors.join(' ')).toContain('.erd-studio/gold/relationships/gold.dbml has unsaved changes');
    expect(_appliedEdits).toHaveLength(0);
    expect(r.after).toEqual(r.before);
  });
});

/** The erd_layout value of a diagram's text (its lines), or '' when it has none. */
const layoutIn = (text: string | undefined): string => /erd_layout: '''([^]*?)'''/.exec(text ?? '')?.[1] ?? '';

describe('adding, renaming and removing tables', () => {
  it('addModel: a new .dbml table in <layer>/tables/<layer>/, its use line and its position', async () => {
    const r = await run({ type: 'addModel', payload: { name: 'dim_store', description: '', columns: [{ name: 'store_key', dataType: 'INT', description: '', isPrimaryKey: true }] } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/dim_store.dbml']);
    expect(r.after['gold/tables/gold/dim_store.dbml']).toMatch(/^Table gold\.dim_store /m);
    expect(r.after['gold/diagrams/sales.dbml']).toMatch(useLine('gold.dim_store', '../tables/gold/dim_store.dbml'));
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).toMatch(/\n {4}dim_store -?\d/);
    expect(table('dim_store').columns[0]).toMatchObject({ name: 'store_key', isPrimaryKey: true });
  });

  it('addExistingModel: a use line, the relationships file its new pairs need, and erd_layout added to the Project for its position', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: 'dim_customer' } }, 'silver/diagrams/staging.dbml');
    expectWrote(r, ['silver/diagrams/staging.dbml'], 'silver/diagrams/staging.dbml');
    expect(r.after['silver/diagrams/staging.dbml']).toMatch(useLine('gold.dim_customer', '../../gold/tables/gold/dim_customer.dbml'));
    // dim_customer's parent Ref (a self-reference) is in customers.dbml: imported now; gold.dbml was already.
    expect(r.after['silver/diagrams/staging.dbml']).toContain("use * from '../../gold/relationships/customers.dbml'");
    expect(layoutIn(r.after['silver/diagrams/staging.dbml'])).toMatch(/\n {4}dim_customer -?\d/);
    expect(new SubjectAreaService(new LayerService(root, '.erd-studio')).listSubjectAreas(root, '.erd-studio').length).toBe(2);
  });

  it('addExistingModels: several in one edit', async () => {
    const r = await run({ type: 'addExistingModels', payload: { modelNames: ['dim_customer', 'dim_region'] } }, 'silver/diagrams/staging.dbml');
    expectWrote(r, ['silver/diagrams/staging.dbml'], 'silver/diagrams/staging.dbml');
    expect(r.after['silver/diagrams/staging.dbml']).toContain('use { table gold.dim_customer }');
    expect(r.after['silver/diagrams/staging.dbml']).toContain('use { table gold.dim_region }');
  });

  it('renameModel: the file, the Refs and use lines naming it (in every relationships file), and the erd_layout key follow', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/dim_area.dbml', 'gold/tables/gold/dim_region.dbml']);
    expect('gold/tables/gold/dim_region.dbml' in r.after).toBe(false);
    expect(r.after['gold/tables/gold/dim_area.dbml']).toMatch(/^Table gold\.dim_area /m);
    for (const file of ['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml']) {
      expect(r.after[file]).toMatch(useLine('gold.dim_area', '../tables/gold/dim_area.dbml'));
      expect(r.after[file]).not.toMatch(/dim_region/);
    }
    expect(r.after['gold/relationships/gold.dbml']).toContain('gold.dim_area.(region_code, country_code)');
    expect(r.after['gold/relationships/customers.dbml']).toContain('gold.dim_area.region_code');
    expect(r.after['gold/diagrams/sales.dbml']).toMatch(useLine('gold.dim_area', '../tables/gold/dim_area.dbml'));
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).toContain('\n    dim_area 760 40\n');
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).not.toContain('dim_region');
    expect(table('fct_order').relationships?.some((rel) => rel.toModel === 'dim_area')).toBe(true);
  });

  it('renameModel reaches every other diagram that uses the table', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } });
    expect(r.errors).toEqual([]);
    expect(_appliedEdits).toHaveLength(1);
    expect(r.written).toEqual(['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml', 'silver/diagrams/staging.dbml', 'silver/relationships/calendar.dbml', 'silver/tables/calendar/dim_date.dbml', 'silver/tables/calendar/dim_day.dbml']);
    expect(r.after['silver/diagrams/staging.dbml']).toMatch(useLine('calendar.dim_day', '../tables/calendar/dim_day.dbml'));
    expect(r.after['gold/diagrams/sales.dbml']).toMatch(useLine('calendar.dim_day', '../../silver/tables/calendar/dim_day.dbml'));
    // Re-spelled only: the operator as the file had it (a bare `>`) is kept.
    expect(r.after['silver/relationships/calendar.dbml']).toContain('Ref "previous day": calendar.dim_day.previous_date_key > calendar.dim_day.date_key');
    expect(r.after['gold/relationships/gold.dbml']).toContain('Ref "order date": gold.fct_order.order_date_key >? calendar.dim_day.date_key');
    // Settled diagrams are undone with the edit.
    const edited = [...((r.provider as unknown as { editedTablePaths: Map<string, Set<string>> }).editedTablePaths.values())].flatMap((set) => [...set]).map(relOf);
    expect(edited).toContain('silver/diagrams/staging.dbml');
    const before = new Set(diagnosticsOf(r.before));
    expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  });

  it('removeModels: a relationships file with no Ref left between the diagram\'s tables is no longer imported', async () => {
    const r = await run({ type: 'removeModels', payload: { modelNames: ['dim_date'] } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('use { table calendar.dim_date }');
    // calendar.dbml holds only dim_date's own Ref; gold.dbml still holds fct_order's to dim_customer.
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain("use * from '../../silver/relationships/calendar.dbml'");
    expect(r.after['gold/diagrams/sales.dbml']).toContain("use * from '../relationships/gold.dbml'");
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).not.toContain('dim_date');
    expect('silver/tables/calendar/dim_date.dbml' in r.after).toBe(true);
  });

  it('removeModels: the use line and the position go; the table file stays', async () => {
    const r = await run({ type: 'removeModels', payload: { modelNames: ['bridge_empty'] } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('bridge_empty');
    expect('gold/tables/gold/bridge_empty.dbml' in r.after).toBe(true);
  });
});

/** The value of a diagram's first erd_layout entry, from its key line to its closing quotes. */
const layoutEntry = (text: string | undefined): string => /erd_layout: '''[^]*?'''/.exec(text ?? '')?.[0] ?? '';

/** staging.dbml with one more member: gold.customer_profile. */
const stagingWithProfile = (): void => {
  fs.writeFileSync(at('silver/diagrams/staging.dbml'), fs.readFileSync(at('silver/diagrams/staging.dbml'), 'utf-8').replace(
    "use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\n",
    "use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\nuse { table gold.customer_profile } from '../../gold/tables/gold/customer_profile.dbml'\n",
  ));
};

describe('the settle (§2.6): every diagram imports exactly the files holding a Ref between two of its tables', () => {
  it('a relationship added to an EXISTING file of another layer rewrites every diagram holding both ends, in the same WorkspaceEdit', async () => {
    stagingWithProfile();
    const r = await run({ type: 'addRelationship', payload: { fromModel: 'customer_profile', fromColumn: 'loyalty_tier', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' } });
    // Placed by rule 1 in customers.dbml (gold), never a new file; sales already imports it, staging (silver) now does.
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/customers.dbml', 'silver/diagrams/staging.dbml']);
    expect(r.after['gold/relationships/customers.dbml']).toContain('Ref: gold.customer_profile.loyalty_tier >? calendar.dim_date.date_key');
    expect(r.after['gold/relationships/customers.dbml']).toMatch(useLine('calendar.dim_date', '../../silver/tables/calendar/dim_date.dbml'));
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml']);
    expect(r.after['silver/diagrams/staging.dbml']).toContain("use * from '../../gold/relationships/customers.dbml'");
    expect(Object.keys(r.after).filter((f) => f.includes('/relationships/')).sort())
      .toEqual(['gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'silver/relationships/calendar.dbml']);
  });

  it('a removal drops the import from every diagram that no longer needs it', async () => {
    const r = await run({ type: 'removeRelationship', payload: { fromModel: 'dim_date', fromColumn: 'previous_date_key', toModel: 'dim_date', toColumn: 'date_key' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml', 'silver/relationships/calendar.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('calendar.dbml');
    expect(r.after['silver/diagrams/staging.dbml']).not.toContain('calendar.dbml');
    // The file itself is never deleted (D15).
    expect('silver/relationships/calendar.dbml' in r.after).toBe(true);
  });

  it('a drag never settles: a diagram missing an import keeps missing it, only erd_layout changes', async () => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8').replace("use * from '../relationships/customers.dbml'\n", ''));
    const r = await run({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml'].replace('    fct_order 400 200\n', '    fct_order 420 220\n'));
  });

  it('an edit on a diagram with a hidden (non-imported) Ref keeps that Ref in its file, and adds the import', async () => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8').replace("use * from '../relationships/customers.dbml'\n", ''));
    // dim_customer owns two of the hidden Refs (its parent and its profile).
    const r = await run({ type: 'updateModelDescription', payload: { modelName: 'dim_customer', description: 'Customers, one row each' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/tables/gold/dim_customer.dbml']);
    expect(r.after['gold/relationships/customers.dbml']).toBe(r.before['gold/relationships/customers.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toContain("use * from '../relationships/customers.dbml'");
  });

  it('a relationship edit on a diagram with a hidden Ref never reads the hidden Ref as deleted', async () => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8').replace("use * from '../relationships/customers.dbml'\n", ''));
    const r = await run({ type: 'updateRelationship', payload: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-many' } });
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['gold/relationships/customers.dbml']).toBe(r.before['gold/relationships/customers.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toContain("use * from '../relationships/customers.dbml'");
  });
});

describe('cascades across diagrams (§2.6, §2.8)', () => {
  it('rename: Ref ends, use lines, the erd_layout key and a sticky note\'s linked_table follow, in every diagram', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'fct_order', newName: 'fct_sale' } });
    expectWrote(r, [
      'gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/fct_order.dbml', 'gold/tables/gold/fct_sale.dbml', 'silver/diagrams/staging.dbml',
    ]);
    expect(r.after['gold/relationships/gold.dbml']).toContain('Ref: gold.fct_sale.customer_key >? gold.dim_customer.customer_key');
    expect(r.after['gold/diagrams/sales.dbml']).toMatch(useLine('gold.fct_sale', '../tables/gold/fct_sale.dbml'));
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).toContain('\n    fct_sale 400 200\n');
    expect(r.after['gold/diagrams/sales.dbml']).toContain("linked_table: 'fct_sale'");
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('fct_order');
    expect(r.after['silver/diagrams/staging.dbml']).toMatch(useLine('gold.fct_sale', '../../gold/tables/gold/fct_sale.dbml'));
  });

  it('a rename while another diagram\'s erd_layout holds a merge conflict goes through: that diagram\'s use line follows, its erd_layout bytes stay', async () => {
    fs.writeFileSync(at('silver/diagrams/staging.dbml'), fs.readFileSync(at('silver/diagrams/staging.dbml'), 'utf-8').replace(
      "  erd_schema_version: '7'\n",
      "  erd_schema_version: '7'\n  erd_layout: '''\n<<<<<<< HEAD\n    dim_date 10 10\n=======\n    dim_date 20 20\n>>>>>>> theirs\n    fct_order 300 10\n  '''\n",
    ));
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } });
    expect(r.errors).toEqual([]);
    expect(r.written).toContain('silver/diagrams/staging.dbml');
    expect(r.after['silver/diagrams/staging.dbml']).toMatch(useLine('calendar.dim_day', '../tables/calendar/dim_day.dbml'));
    expect(layoutEntry(r.after['silver/diagrams/staging.dbml'])).toBe(layoutEntry(r.before['silver/diagrams/staging.dbml']));
    expect(layoutEntry(r.after['silver/diagrams/staging.dbml'])).toContain('<<<<<<< HEAD');
  });

  it.each([
    ['a rename', { type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } }],
    ['a delete (Delete Table File)', undefined],
  ] as const)('%s while another diagram listing the table does not parse is refused, naming that file; nothing is written', async (_label, message) => {
    fs.appendFileSync(at('silver/diagrams/staging.dbml'), '\nTable {\n');
    const text = 'silver/diagrams/staging.dbml does not read';
    const keeps = 'fix it first, or it would keep a use line to silver/tables/calendar/dim_date.dbml';
    if (message) {
      const r = await run(message);
      expect(r.errors.join(' ')).toContain(text);
      expect(r.errors.join(' ')).toContain(keeps);
      // The problem names no file of its own: no absolute path in the toast, the same words as the settle's.
      expect(r.errors.join(' ')).toMatch(/does not read \(Invalid DBML at line \d+, column \d+: /);
      expect(r.errors.join(' ')).not.toContain(root);
      expect(_appliedEdits).toHaveLength(0);
      expect(r.after).toEqual(r.before);
      return;
    }
    const { provider } = buildProvider(new OwnWriteTracker());
    const before = snapshot();
    await expect(provider.deleteTablesWithCascade(['dim_date'])).rejects.toThrow(/silver\/diagrams\/staging\.dbml does not read \(Invalid DBML at line \d+, column \d+: /);
    expect(_appliedEdits).toHaveLength(0);
    expect(snapshot()).toEqual(before);
  });

  it('a diagram that does not parse but names no table the edit moves is left as it is', async () => {
    fs.appendFileSync(at('silver/diagrams/staging.dbml'), '\nTable {\n');
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expect(r.errors).toEqual([]);
    expect(r.written).not.toContain('silver/diagrams/staging.dbml');
    expect(r.after['silver/diagrams/staging.dbml']).toBe(r.before['silver/diagrams/staging.dbml']);
  });
});

describe('cascades reach a diagram whose layer folder layers.json does not list', () => {
  /** A diagram in `layer` drawing gold's dim_region and fct_order, with the relationships file that joins them. */
  function strayDiagram(layer: string): string {
    const rel = `${layer}/diagrams/old.dbml`;
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    fs.writeFileSync(at(rel), [
      "use { table gold.dim_region } from '../../gold/tables/gold/dim_region.dbml'",
      "use { table gold.fct_order } from '../../gold/tables/gold/fct_order.dbml'",
      "use * from '../../gold/relationships/gold.dbml'",
      '',
      'Project old {',
      "  erd_schema_version: '7'",
      '}',
      '',
    ].join('\n'));
    return rel;
  }
  /** layers.json with a merge conflict: LayerService falls back to the default layers (silver, gold). */
  function conflictLayers(): void {
    const text = fs.readFileSync(at('layers.json'), 'utf-8');
    fs.writeFileSync(at('layers.json'), text.replace('"layers": [', '"layers": [\n<<<<<<< HEAD\n    { "id": "bronze", "label": "Bronze", "abbreviation": "BRZ", "color": "#cd7f32", "creatable": true, "order": 0 },\n=======\n>>>>>>> other'));
  }

  it('a canvas rename rewrites a diagram in a folder layers.json does not list', async () => {
    const stray = strayDiagram('archive');
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expectWrote(r, [stray, 'gold/diagrams/sales.dbml', 'gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/dim_area.dbml', 'gold/tables/gold/dim_region.dbml']);
    expect(r.after[stray]).toMatch(useLine('gold.dim_area', '../../gold/tables/gold/dim_area.dbml'));
    expect(r.after[stray]).not.toContain('dim_region');
  });

  it('a canvas rename rewrites a diagram in a layer that only a conflicted layers.json listed', async () => {
    const stray = strayDiagram('bronze');
    conflictLayers();
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_region', newName: 'dim_area' } });
    expectWrote(r, [stray, 'gold/diagrams/sales.dbml', 'gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/dim_area.dbml', 'gold/tables/gold/dim_region.dbml']);
    expect(r.after[stray]).toMatch(useLine('gold.dim_area', '../../gold/tables/gold/dim_area.dbml'));
  });

  it('Delete Table (File) drops the use line from such diagrams too, and counts them', async () => {
    const archive = strayDiagram('archive');
    const bronze = strayDiagram('bronze');
    conflictLayers();
    const { provider } = buildProvider(new OwnWriteTracker());
    expect(provider.describeDbmlDeleteCascade(['dim_region'], false)).toMatch(/its place in 3 diagrams\.$/);
    const before = snapshot();
    expect(await provider.deleteTablesWithCascade(['dim_region'])).toEqual({ ok: true, unrestored: [] });
    const after = snapshot();
    for (const diagram of [archive, bronze]) expect(after[diagram]).not.toContain('dim_region');
    const diagnostics = new Set(diagnosticsOf(before));
    expect(diagnosticsOf(after).filter((d) => !diagnostics.has(d))).toEqual([]);
  });
});

describe('a JSON diagram in a mixed project (flat YAML library plus DBML tables)', () => {
  beforeEach(() => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), text);
    };
    write('layers.json', `${JSON.stringify({ schemaVersion: 1, layers: [
      { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 0 },
      { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
      { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
    ] }, null, 2)}\n`);
    write('logical-models/dim_a.yml', 'name: dim_a\ncolumns:\n  - name: a_key\n    dataType: INT\n    isPrimaryKey: true\n');
    write('gold/tables/gold/fct_x.dbml', 'Table gold.fct_x {\n  x_key INT [pk]\n}\n');
    write('gold/s.json', `${JSON.stringify({
      schemaVersion: 5, domain: 's', layer: 'gold', description: 's',
      logical: { models: ['dim_a', 'fct_x'], relationships: [] },
      viewConfig: { positions: { dim_a: { x: 0, y: 0 }, fct_x: { x: 300, y: 0 } } },
    }, null, 2)}\n`);
  });

  it('Add Table puts the new DBML table in the diagram\'s layer, not the first configured one', async () => {
    expect(library().projectStorage()).toBe('mixed');
    const r = await run({ type: 'addModel', payload: { name: 'dim_new', description: '', columns: [{ name: 'new_key', dataType: 'INT', description: '', isPrimaryKey: true }] } }, 'gold/s.json');
    expect(r.errors).toEqual([]);
    expect(r.written).toEqual(['gold/s.json', 'gold/tables/gold/dim_new.dbml']);
    expect(r.after['gold/tables/gold/dim_new.dbml']).toMatch(/^Table gold\.dim_new /m);
    expect(r.after['logical-models/dim_a.yml']).toBe(r.before['logical-models/dim_a.yml']);
  });
});

describe('positions and sticky notes', () => {
  it('updatePositions: erd_layout only', async () => {
    const r = await run({ type: 'updatePositions', payload: { positions: { fct_order: { x: 420, y: 220 } } } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml'].replace('    fct_order 400 200\n', '    fct_order 420 220\n'));
  });

  it('updatePositions with the same positions writes nothing new', async () => {
    const r = await run({ type: 'updatePositions', payload: { positions: { fct_order: { x: 400, y: 200 } } } });
    expect(r.errors).toEqual([]);
    expect(r.after).toEqual(r.before);
  });

  it('addAnnotation: a Note block and its box', async () => {
    const r = await run({ type: 'addAnnotation', payload: { id: '11111111-2222-4333-8444-555555555555', text: 'New note', x: 100, y: 900, color: 'yellow' } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toContain('Note "11111111-2222-4333-8444-555555555555"');
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).toContain('\n    note/11111111-2222-4333-8444-555555555555 100 900');
  });

  it('updateAnnotation: the Note text', async () => {
    const r = await run({ type: 'updateAnnotation', payload: { id: '3f2b6c1e-8a4d-4f7e-9c1b-2d5e6f7a8b9c', text: 'Grain agreed' } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toContain("'Grain agreed'");
  });

  it('removeAnnotations: the Note block and its box', async () => {
    const r = await run({ type: 'removeAnnotations', payload: { ids: ['9a0d2b77-1c55-4e0b-8f3e-5a6b7c8d9e0f'] } });
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('9a0d2b77');
  });
});

describe('refusals (D20, §2.1)', () => {
  beforeEach(() => {
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/dim_yaml.yml'), 'name: dim_yaml\ncolumns:\n  - name: id\n    dataType: INT\n    isPrimaryKey: true\n');
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

  it('a DBML table may not be renamed to _relationships: the authoring rule (a letter first) refuses it', async () => {
    const r = await run({ type: 'renameModel', payload: { oldName: 'bridge_empty', newName: '_relationships' } });
    // A typed name always starts with a letter.
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
      'gold/diagrams/sales.dbml',
      () => { _mockWorkspaceState.applyEditPrefixes.push(3); },
    );
    expect(r.errors.length).toBeGreaterThan(0);
    expect(_appliedEdits).toHaveLength(2);
    expect(r.after).toEqual(r.before);
  });
});

describe('Turn Round (commitRelationshipWrite) on a DBML diagram', () => {
  it('stores a backwards many-to-one the right way round, in the file that holds it (a Ref is never moved), as one edit', async () => {
    // Drawn from dim_date's key, so the canvas flags it as backwards; stored in calendar.dbml.
    const gold = at('gold/relationships/gold.dbml');
    fs.writeFileSync(gold, fs.readFileSync(gold, 'utf-8').replace('Ref "ship date": gold.fct_order.ship_date_key >? calendar.dim_date.date_key\n', ''));
    const calendar = at('silver/relationships/calendar.dbml');
    fs.writeFileSync(calendar, fs.readFileSync(calendar, 'utf-8')
      .replace("use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\n", "use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\nuse { table gold.fct_order } from '../../gold/tables/gold/fct_order.dbml'\n")
      .concat('Ref "ship date": calendar.dim_date.date_key > gold.fct_order.ship_date_key\n'));
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (text: string) =>
      (String(text).includes('drawn backwards') ? 'Turn Round' : undefined)) as never);
    const tracker = new OwnWriteTracker();
    const { provider } = buildProvider(tracker, { offers: true });
    const document = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    const before = snapshot();
    await panel._simulateMessage({ type: 'ready' });
    await vi.waitFor(() => expect(table('fct_order').relationships?.some((r) => r.fromColumn === 'ship_date_key' && r.toModel === 'dim_date')).toBe(true));
    await vi.waitFor(() => expect(snapshot()['silver/relationships/calendar.dbml']).toContain('Ref "ship date": gold.fct_order.ship_date_key >? calendar.dim_date.date_key'));

    expect(_appliedEdits).toHaveLength(1);
    const written = [...new Set(_appliedEdits[0]._ops.map((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath)))].sort();
    expect(written).toEqual(['gold/diagrams/sales.dbml', 'silver/relationships/calendar.dbml']);
    const after = snapshot();
    expect(after['gold/diagrams/sales.dbml']).toBe(before['gold/diagrams/sales.dbml']);
    expect(after['gold/relationships/gold.dbml']).toBe(before['gold/relationships/gold.dbml']);
    expect(after['silver/relationships/calendar.dbml']).not.toContain('dim_date.date_key > gold.fct_order');
    expect(table('dim_date').relationships?.some((r) => r.toModel === 'fct_order') ?? false).toBe(false);
    expect(panel._postedMessages.filter((m) => (m as { type: string }).type === 'error')).toEqual([]);
    const diagnostics = new Set(diagnosticsOf(before));
    expect(diagnosticsOf(after).filter((d) => !diagnostics.has(d))).toEqual([]);
  });
});

describe('the ready load\'s position save (autoPositionNewTables, §5.3)', () => {
  /** sales.dbml without bridge_empty's erd_layout line: a partially positioned diagram. */
  const dropPosition = (): void => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8').replace('    bridge_empty 760 400\n', ''));
  };
  async function openAndReady(prepare?: () => void): Promise<{ r: Run; posted: Array<{ type: string; payload?: unknown }> }> {
    const tracker = new OwnWriteTracker();
    const recorded: string[] = [];
    vi.spyOn(tracker, 'recordWrite').mockImplementation((p: string) => { recorded.push(relOf(p)); });
    vi.spyOn(tracker, 'recordDelete').mockImplementation((p: string) => { recorded.push(relOf(p)); });
    const { provider } = buildProvider(tracker);
    const document = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
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

  it('a partially positioned diagram: only erd_layout changes, every other byte of the .dbml stays', async () => {
    dropPosition();
    const { r, posted } = await openAndReady();
    expectWrote(r, ['gold/diagrams/sales.dbml']);
    const cut = (t: string): string => t.replace(/ {2}erd_layout: '''[^]*?'''\n/, '');
    expect(cut(r.after['gold/diagrams/sales.dbml'])).toBe(cut(r.before['gold/diagrams/sales.dbml']));
    expect(layoutIn(r.after['gold/diagrams/sales.dbml'])).toMatch(/\n {4}bridge_empty -?\d/);
    expect(posted.some((m) => m.type === 'domainLoaded')).toBe(true);
  });

  it.each([
    ['the diagram is read-only (a second Project)', () => {
      fs.appendFileSync(at('gold/diagrams/sales.dbml'), "\nProject other {\n  Note: 'x'\n}\n");
    }, undefined],
    ['its erd_layout holds a git merge conflict', () => {
      fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')
        .replace('    fct_order 400 200\n', '<<<<<<< HEAD\n    fct_order 400 200\n=======\n    fct_order 500 200\n>>>>>>> theirs\n'));
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
    fs.mkdirSync(at('logical-models'), { recursive: true });
    fs.writeFileSync(at('logical-models/fct_y.yml'), [
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
    expect('silver/tables/calendar/dim_date.dbml' in after).toBe(false);
    expect(after['logical-models/fct_y.yml']).toBe(before['logical-models/fct_y.yml']);
    expect(after['gold/mixed.json']).toBe(before['gold/mixed.json']);
    for (const diagram of ['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml']) {
      expect(after[diagram]).not.toContain('dim_date');
      expect(after[diagram]).not.toContain('calendar.dbml');
    }
    expect(after['gold/relationships/gold.dbml']).not.toContain('dim_date');
    expect(after['silver/relationships/calendar.dbml']).not.toMatch(/^Ref/m);
    const diagnostics = new Set(diagnosticsOf(before));
    expect(diagnosticsOf(after).filter((d) => !diagnostics.has(d))).toEqual([]);
  });

  it('announces its writes before the edit and records the delete before saving the diagrams, so no watcher takes them for outside changes', async () => {
    const tracker = new OwnWriteTracker();
    const events: string[] = [];
    const deleted = at('silver/tables/calendar/dim_date.dbml');
    const expectWrite = tracker.expectWrite.bind(tracker);
    vi.spyOn(tracker, 'expectWrite').mockImplementation((paths) => {
      const list = [...paths];
      events.push(`expect:${list.some((p) => path.resolve(p) === deleted) ? 'deleted-file' : 'other'}`);
      return expectWrite(list);
    });
    const recordWrite = tracker.recordWrite.bind(tracker);
    vi.spyOn(tracker, 'recordWrite').mockImplementation((p) => { events.push(`write:${relOf(p)}`); recordWrite(p); });
    const recordDelete = tracker.recordDelete.bind(tracker);
    vi.spyOn(tracker, 'recordDelete').mockImplementation((p) => { events.push(`delete:${relOf(p)}`); recordDelete(p); });
    const { provider } = buildProvider(tracker);
    expect(await provider.deleteTablesWithCascade(['dim_date'])).toEqual({ ok: true, unrestored: [] });
    expect(events[0]).toBe('expect:deleted-file');
    const firstSave = events.findIndex((e) => e.startsWith('write:'));
    expect(events.indexOf('delete:silver/tables/calendar/dim_date.dbml')).toBeGreaterThan(0);
    expect(events.indexOf('delete:silver/tables/calendar/dim_date.dbml')).toBeLessThan(firstSave);
    // Settled: nothing is left holding a watcher back.
    expect(tracker.isPending(deleted)).toBe(false);
    expect(tracker.isPending(at('gold/diagrams/sales.dbml'))).toBe(false);
  });

  it('the fs Delete Table (TableLibraryService.deleteTable) with a YAML owner deletes too, leaving the yml as it is', () => {
    const before = snapshot();
    library().deleteTable('dim_date');
    const after = snapshot();
    expect('silver/tables/calendar/dim_date.dbml' in after).toBe(false);
    expect(after['logical-models/fct_y.yml']).toBe(before['logical-models/fct_y.yml']);
    expect(after['gold/relationships/gold.dbml']).not.toContain('dim_date');
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
    _failMockSave(at('gold/relationships/gold.dbml'));
    expect(await provider.deleteTablesWithCascade(['dim_date'])).toEqual({ ok: true, unrestored: [] });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save .erd-studio/gold/relationships/gold.dbml'));
  });
});

describe('another diagram with a byte-order mark (D7)', () => {
  it('is re-rendered without one: VS Code keeps the BOM as the encoding, so the text never carries a second', async () => {
    fs.writeFileSync(at('silver/diagrams/staging.dbml'), `﻿${fs.readFileSync(at('silver/diagrams/staging.dbml'), 'utf-8')}`);
    const r = await run({ type: 'renameModel', payload: { oldName: 'dim_date', newName: 'dim_day' } });
    expect(r.errors).toEqual([]);
    const ops = _appliedEdits[0]._ops.filter((op) => relOf((op as { uri: { fsPath: string } }).uri.fsPath) === 'silver/diagrams/staging.dbml');
    expect(ops).toHaveLength(1);
    const text = (ops[0] as { newText: string }).newText;
    expect(text.startsWith('﻿')).toBe(false);
    expect(text).toMatch(useLine('calendar.dim_day', '../tables/calendar/dim_day.dbml'));
  });
});

describe('messages name the project\'s own table library', () => {
  it('a table with no file is named where a new one goes: <layer>/tables/<layer>/<name>.dbml, never logical-models/<name>.yml', () => {
    const { provider } = buildProvider(new OwnWriteTracker());
    const named = (provider as unknown as { libraryRelativePath(name: string): string }).libraryRelativePath('dim_missing');
    // The first layer of layers.json.
    expect(named).toBe('silver/tables/silver/dim_missing.dbml');
    expect((provider as unknown as { libraryRelativePath(name: string): string }).libraryRelativePath('dim_date')).toBe('silver/tables/calendar/dim_date.dbml');
  });

  it('adding a table found nowhere says so without naming logical-models/', async () => {
    const r = await run({ type: 'addExistingModel', payload: { modelName: 'dim_nowhere' } });
    expect(r.errors).toEqual(['Table "dim_nowhere" not found in your dbt .yml files, the manifest or the table library.']);
  });
});

describe('a diagram with a member with no table file and pending relationships (D26/D27): the canvas draws and edits it', () => {
  const withMissing = (): void => {
    fs.writeFileSync(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8')
      .replace('  erd_layout_options', "  erd_unlinked_tables: 'gld_fct_risk_child'\n  erd_layout_options")
      .concat('\n// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? dim_customer.customer_key\n'));
    fs.appendFileSync(at('gold/relationships/gold.dbml'), '\n// erd-studio pending: Ref: fct_order.customer_key >? gld_fct_risk_child.customer_key\n');
  };

  it('draws the missing member as a placeholder and both pending relationships, like a JSON diagram', async () => {
    withMissing();
    const tracker = new OwnWriteTracker();
    const { provider } = buildProvider(tracker);
    const document = createMockTextDocument(at('gold/diagrams/sales.dbml'), fs.readFileSync(at('gold/diagrams/sales.dbml'), 'utf-8'), { persist: true });
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
    expectWrote(r, ['gold/diagrams/sales.dbml', 'gold/relationships/gold.dbml']);
    expect(r.after['gold/diagrams/sales.dbml']).toBe(r.before['gold/diagrams/sales.dbml']);
    expect(r.after['gold/relationships/gold.dbml']).toContain('// erd-studio pending: Ref: fct_order.customer_key >? gld_fct_risk_child.customer_key\n');
    expect(r.after['gold/relationships/gold.dbml']).not.toContain('Ref "order date"');
  });

  it('removing the missing member drops it from erd_unlinked_tables (the key goes) and cuts the diagram\'s pending line with its relationship', async () => {
    withMissing();
    const r = await run({ type: 'removeModels', payload: { modelNames: ['gld_fct_risk_child'] } });
    expect(r.errors).toEqual([]);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('erd_unlinked_tables');
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('erd-studio pending');
    expect(r.after['gold/diagrams/sales.dbml'].endsWith("  ''\n}\n")).toBe(true);
  });

  it('a new table with that name, made in another diagram, gives it a use line here (the settle pass) and turns the pending Ref to it live', async () => {
    withMissing();
    const r = await run({ type: 'addModel', payload: { name: 'gld_fct_risk_child', description: '', columns: [{ name: 'customer_key', dataType: 'INT', description: '' }] } }, 'silver/diagrams/staging.dbml');
    expect(r.errors).toEqual([]);
    expect(r.after['gold/diagrams/sales.dbml']).not.toContain('erd_unlinked_tables');
    // Made in silver's diagram: its file is silver/tables/silver/.
    expect(r.after['gold/diagrams/sales.dbml']).toMatch(useLine('silver.gld_fct_risk_child', '../../silver/tables/silver/gld_fct_risk_child.dbml'));
    const relationships = r.after['gold/relationships/gold.dbml'];
    expect(relationships).toContain('Ref: gold.fct_order.customer_key >? silver.gld_fct_risk_child.customer_key\n');
    expect(relationships).not.toContain('// erd-studio pending: Ref: fct_order.customer_key');
    expect(relationships).toMatch(useLine('silver.gld_fct_risk_child', '../../silver/tables/silver/gld_fct_risk_child.dbml'));
    // The diagram's own pending line (its owner had no file) stays until Convert moves it to the library.
    expect(r.after['gold/diagrams/sales.dbml']).toContain('// erd-studio pending: Ref: gld_fct_risk_child.customer_key >? dim_customer.customer_key');
    const before = new Set(diagnosticsOf(r.before));
    expect(diagnosticsOf(r.after).filter((d) => !before.has(d))).toEqual([]);
  });
});

describe('a converted diagram\'s pending relationship (D27) in a relationships file: the import that draws it survives unrelated edits (§2.4)', () => {
  const DIAGRAM = 'gold/diagrams/s.dbml';
  const IMPORT = "use * from '../relationships/gold.dbml'";
  const PENDING = '// erd-studio pending: Ref: public.fct.x_key >? dim_x.x_key';

  /** A YAML project whose fct has a relationship to dim_x, which has no table file, on one diagram; then Convert. */
  const converted = async (): Promise<void> => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const write = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
      fs.writeFileSync(at(rel), text);
    };
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 1 }] }, null, 2));
    write('logical-models/fct.yml', [
      'name: fct', 'columns:', '  - name: fct_key', '    dataType: INT', '    isPrimaryKey: true', '  - name: x_key', '    dataType: INT',
      'relationships:', '  - fromColumn: x_key', '    toModel: dim_x', '    toColumn: x_key', '    cardinality: many-to-one', '',
    ].join('\n'));
    write('gold/s.json', JSON.stringify({
      schemaVersion: 5, domain: 's', layer: 'gold', description: 's diagram',
      logical: { models: ['fct', 'dim_x'], relationships: [] },
      viewConfig: { positions: { fct: { x: 40, y: 40 }, dim_x: { x: 340, y: 40 } } },
    }, null, 2));
    const plan = await convertOnDisk(root);
    expect(plan.refusals).toEqual([]);
    const text = fs.readFileSync(at(DIAGRAM), 'utf-8');
    expect(text).toContain(`${IMPORT}\n`);
    expect(text).toContain("erd_unlinked_tables: 'dim_x'");
    expect(fs.readFileSync(at('gold/relationships/gold.dbml'), 'utf-8')).toContain(`${PENDING}\n`);
  };

  /** The relationships the canvas draws on `diagram`, opened fresh. */
  const drawnOn = async (diagram: string): Promise<string[]> => {
    const { provider } = buildProvider(new OwnWriteTracker());
    const document = createMockTextDocument(at(diagram), fs.readFileSync(at(diagram), 'utf-8'), { persist: true });
    const panel = createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { relationships: Array<Record<string, string>> } };
    return loaded.payload.relationships.map((r) => `${r.fromModel}.${r.fromColumn} > ${r.toModel}.${r.toColumn}`);
  };

  it('Convert imports the file, and the canvas draws the relationship to the missing table', async () => {
    await converted();
    expect(await drawnOn(DIAGRAM)).toEqual(['fct.x_key > dim_x.x_key']);
  });

  it('adding a table keeps the import (the edited diagram\'s refresh asks the same rule), and the relationship is still drawn', async () => {
    await converted();
    const r = await run({ type: 'addModel', payload: { name: 'dim_store', description: '', columns: [{ name: 'store_key', dataType: 'INT', description: '', isPrimaryKey: true }] } }, DIAGRAM);
    expect(r.errors).toEqual([]);
    const after = r.after[DIAGRAM];
    expect(after).toMatch(useLine('gold.dim_store', '../tables/gold/dim_store.dbml'));
    expect(after).toContain(`${IMPORT}\n`);
    expect(after).toContain("erd_unlinked_tables: 'dim_x'");
    expect(r.after['gold/relationships/gold.dbml']).toBe(r.before['gold/relationships/gold.dbml']);
    expect(await drawnOn(DIAGRAM)).toEqual(['fct.x_key > dim_x.x_key']);
  });

  it('a drag changes erd_layout only: the import stays, and the relationship is still drawn', async () => {
    await converted();
    const r = await run({ type: 'updatePositions', payload: { positions: { fct: { x: 60, y: 80 } } } }, DIAGRAM);
    expect(r.errors).toEqual([]);
    expect(r.written).toEqual([DIAGRAM]);
    expect(r.after[DIAGRAM]).toBe(r.before[DIAGRAM].replace('    fct 40 40\n', '    fct 60 80\n'));
    expect(await drawnOn(DIAGRAM)).toEqual(['fct.x_key > dim_x.x_key']);
  });

  it('removing the missing table drops the import with it: no pending line is left between the tables it draws', async () => {
    await converted();
    const r = await run({ type: 'removeModels', payload: { modelNames: ['dim_x'] } }, DIAGRAM);
    expect(r.errors).toEqual([]);
    expect(r.after[DIAGRAM]).not.toContain('erd_unlinked_tables');
    expect(r.after[DIAGRAM]).not.toContain('relationships/gold.dbml');
    // The pending line stays in the library: removing a table from a diagram never deletes its relationships.
    expect(r.after['gold/relationships/gold.dbml']).toContain(`${PENDING}\n`);
  });
});
