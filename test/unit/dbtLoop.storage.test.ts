/**
 * The whole dbt loop on either storage: the same dbt project with its
 * logical model as YAML/JSON (`test/fixtures/dbt-project`) and as native DBML
 * (`test/fixtures/dbt-project-dbml`, its Convert), each on a temp copy, through
 * the real SemanticEditorProvider with the real ManifestService,
 * YmlParserService and CatalogService. Only the QuickPick and the name box
 * are stubbed. Each step runs on both, and the two must agree:
 *
 * - the Physical tab: the `stageData` payload, and switching writes nothing;
 * - dragging on the Physical tab saves the shared layout (viewConfig.positions
 *   on JSON, erd_layout on DBML), as on the logical stage;
 * - Compare: the `discrepancyReport`;
 * - Sync: `.sync-plan.json`, with every path naming a real file (or, for a
 *   new table, the diagram's layer) in the storage's own layout;
 * - Add Tables from dbt on the logical stage;
 * - Draw from dbt with the real draft, and the diagram it writes opens and draws;
 * - `selectors.yml`: the same `domain_*` selectors, user selectors kept.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';

import { normaliseForStorageEquivalence } from '@erd-studio/core';
import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';

// The QuickPick of what to draw: the real scopes and models from dbt, answered
// with the gold folder's scope (layer gold) plus `picker.extra`.
// `only`, when set, is the whole answer instead.
const picker = vi.hoisted(() => ({ extra: [] as string[], offered: [] as string[], layer: 'gold', only: undefined as string[] | undefined }));
vi.mock('../../src/providers/dbtDraftPicker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/dbtDraftPicker')>()),
  pickDraftScope: async (
    scopes: ReadonlyArray<{ label: string; suggestedLayer?: string; modelNames: string[] }>,
    opts: { models: ReadonlyArray<{ name: string }>; excludeNames?: Iterable<string> },
  ) => {
    const excluded = new Set([...(opts.excludeNames ?? [])].map((n) => n.toLowerCase()));
    picker.offered = opts.models.map((m) => m.name).filter((n) => !excluded.has(n.toLowerCase()));
    const scope = scopes.find((s) => s.suggestedLayer === picker.layer) ?? scopes[0];
    const modelNames = (picker.only ?? [...scope.modelNames, ...picker.extra]).filter((n) => !excluded.has(n.toLowerCase()));
    return { scope, modelNames };
  },
}));

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { main as cliMain } from '../../src/cli/index';
import type { DiffResult } from '../../src/cli/diff';
import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { allSelections, countSyncPlanActions } from '../../src/services/syncPlanBuilder';
import { buildLogicalDisplaySubjectArea } from '../../src/services/stageDisplay';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { SyncPlan } from '../../src/types/syncPlan';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const REPO_ROOT = path.resolve(__dirname, '../..');

type Storage = 'yaml' | 'dbml';
type Posted = { type: string; payload?: any; requestId?: number };
type Panel = ReturnType<typeof createMockWebviewPanel>;

/** Where each diagram of the loop is, per storage (relative to the semantic dir). */
const DIAGRAM: Record<Storage, (layer: string, name: string) => string> = {
  yaml: (layer, name) => `${layer}/${name}.json`,
  dbml: (layer, name) => `${layer}/diagrams/${name}.dbml`,
};

/** What each run saw, for the cross-storage checks at the end. */
interface Seen {
  root: string;
  physical: unknown;
  report: DiscrepancyReport;
  plan: SyncPlan;
  dragged: { x: number; y: number } | undefined;
  added: unknown;
  drawn: unknown;
  drawnFiles: string[];
  selectors: Array<{ name: string; values: string[] }>;
  userSelectors: unknown[];
}
const seen: Partial<Record<Storage, Partial<Seen>>> = {};

function copyFixture(fixture: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erd-dbt-loop-${fixture}-`));
  // Timestamps kept: manifest staleness compares the manifest's mtime with the model files'.
  fs.cpSync(path.join(FIXTURES, fixture), root, { recursive: true, preserveTimestamps: true });
  return root;
}

/** Every file under the semantic dir, relative path → text. */
function snapshot(root: string): Record<string, string> {
  const erd = path.join(root, '.erd-studio');
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(erd, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(erd);
  return out;
}

function services(root: string): {
  layerService: LayerService; subjectAreaService: SubjectAreaService; tableLibraryService: TableLibraryService;
  manifestService: ManifestService; ymlParserService: YmlParserService; catalogService: CatalogService; selectorsService: SelectorsService;
} {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    layerService, subjectAreaService, tableLibraryService,
    manifestService: new ManifestService({ parseInProcess: true }),
    ymlParserService: new YmlParserService(),
    catalogService: new CatalogService(),
    selectorsService: new SelectorsService(subjectAreaService, root, '.erd-studio'),
  };
}

function buildProvider(root: string): SemanticEditorProvider {
  const s = services(root);
  vi.spyOn(s.selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, s.subjectAreaService, s.manifestService, s.ymlParserService, new TemplateService(),
    s.layerService, root, s.selectorsService, s.tableLibraryService,
  );
  provider.setCatalogService(s.catalogService);
  return provider;
}

const posted = (panel: Panel): Posted[] => panel._postedMessages as Posted[];
const errorsOf = (panel: Panel): string[] => posted(panel).filter((m) => m.type === 'error').map((m) => String(m.payload?.message));

async function waitFor(panel: Panel, type: string, test: (m: Posted) => boolean = () => true): Promise<Posted> {
  await vi.waitFor(() => expect(posted(panel).some((m) => m.type === type && test(m))).toBe(true), { timeout: 8000, interval: 10 });
  return posted(panel).filter((m) => m.type === type && test(m)).at(-1)!;
}

/** Open `diagram` (relative to the semantic dir) on the canvas, loaded. */
async function open(root: string, diagram: string): Promise<{ panel: Panel; provider: SemanticEditorProvider; loaded: Posted }> {
  const provider = buildProvider(root);
  const file = path.join(root, '.erd-studio', ...diagram.split('/'));
  const document = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    document as unknown as vscode.TextDocument,
    panel as unknown as vscode.WebviewPanel,
    {} as vscode.CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  const loaded = await waitFor(panel, 'domainLoaded');
  return { panel, provider, loaded };
}

/** A table's schema as the DBML copy files it, for the comparisons (a YAML table with none reads as unset). */
function schemaFallbackOf(dbmlRoot: string): (name: string) => string | undefined {
  const lib = new TableLibraryService(dbmlRoot, '.erd-studio');
  return (name) => lib.getTable(name)?.schema;
}

/** A relationship's identity, for putting lists in one order. */
function relKey(r: { fromModel?: string; fromColumn?: string; toModel?: string; toColumn?: string }): string {
  return [r.fromModel, r.fromColumn, r.toModel, r.toColumn].map((v) => String(v ?? '').toLowerCase()).join('\u0000');
}

/**
 * `value` with every relationships list in one order: a DBML diagram draws
 * its relationships in the relationships file's order, a JSON one in the
 * table files' order. Order is all that differs.
 */
function relationshipsSorted<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key, v) => (
    key === 'relationships' && Array.isArray(v) ? [...v].sort((a, b) => relKey(a).localeCompare(relKey(b))) : v
  ));
}

/**
 * `value` with every storage-only difference removed (core's one comparator,
 * Convert rows included), relationships in one order. `newTables`: tables
 * this run created from dbt, whose schema differs by design: a new DBML
 * table's schema is its schema folder (the layer's, or the dbt custom schema
 * the developer configured), a new YAML table's the schema dbt built it in
 * (§2.4, `configuredSchemaOf`).
 */
function same(value: unknown, newTables: readonly string[] = []): unknown {
  const dbmlRoot = seen.dbml!.root!;
  const normalised = normaliseForStorageEquivalence(relationshipsSorted(value), { convert: true, schemaFallback: schemaFallbackOf(dbmlRoot) }) as { models?: Array<{ name: string; schema?: string }> };
  for (const m of normalised.models ?? []) if (newTables.includes(m.name)) delete m.schema;
  return normalised;
}

/** A payload with fields that name the storage (a file path, the format) dropped. */
function withoutStorageFields(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, v) => (
    ['filePath', 'storage', 'schemaVersion', 'sourceFile', 'modelFilePath', 'tableFilePath', 'layerConfigs', 'newTableSchemas'].includes(key) ? undefined : v
  ));
}

afterAll(() => {
  for (const s of Object.values(seen)) if (s?.root) fs.rmSync(s.root, { recursive: true, force: true });
});

describe.each([
  ['yaml', 'dbt-project'],
  ['dbml', 'dbt-project-dbml'],
] as Array<[Storage, string]>)('the dbt loop on %s storage (%s)', (storage, fixture) => {
  let root: string;
  const showcase = DIAGRAM[storage]('silver', 'showcase');
  const run = (): Partial<Seen> => seen[storage]!;

  beforeAll(() => {
    _resetMockWorkspace();
    root = copyFixture(fixture);
    seen[storage] = { root };
  });

  it('the Physical tab draws the dbt project and writes nothing', async () => {
    const { panel } = await open(root, showcase);
    const before = snapshot(root);
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    const stage = await waitFor(panel, 'stageData', (m) => m.requestId === 1);
    expect(errorsOf(panel)).toEqual([]);
    expect(stage.logicalOnly).toBeUndefined();
    expect(stage.manifestMissing).toBeFalsy();
    const physical = stage.payload as { stage?: string; models: Array<{ name: string; existsInProject?: boolean }> };
    expect(physical.models.map((m) => m.name).sort()).toEqual(['dim_customer', 'dim_date', 'dim_project', 'dim_task', 'fct_order', 'fct_task_event']);
    // Matched to dbt by name: fct_task_event, dim_task and dim_project are compiled; every one has a yml.
    expect(physical.models.every((m) => m.existsInProject !== false)).toBe(true);
    expect(snapshot(root)).toEqual(before);
    run().physical = physical;
  });

  it('dragging a table on the Physical tab saves the shared layout, as on the logical stage', async () => {
    const { panel } = await open(root, showcase);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitFor(panel, 'stageData', (m) => m.requestId === 1);
    await panel._simulateMessage({ type: 'updatePositions', payload: { positions: { dim_customer: { x: 111, y: 222 } } } });
    await vi.waitFor(() => {
      const s = services(root);
      const unified = s.subjectAreaService.getSubjectArea(path.join(root, '.erd-studio', ...showcase.split('/')));
      expect(unified.viewConfig?.positions?.dim_customer).toEqual({ x: 111, y: 222 });
    }, { timeout: 8000, interval: 20 });
    expect(errorsOf(panel)).toEqual([]);
    const text = fs.readFileSync(path.join(root, '.erd-studio', ...showcase.split('/')), 'utf-8');
    if (storage === 'dbml') expect(text).toMatch(/^ {4}dim_customer 111 222$/m);
    else expect(JSON.parse(text).viewConfig.positions.dim_customer).toEqual({ x: 111, y: 222 });
    run().dragged = { x: 111, y: 222 };
  });

  it('Compare reports the differences with dbt', async () => {
    const { panel } = await open(root, showcase);
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    const shown = await waitFor(panel, 'discrepancyReport', (m) => !!m.payload);
    expect(errorsOf(panel)).toEqual([]);
    const report = shown.payload as DiscrepancyReport;
    expect(report.models.length).toBe(6);
    expect(Object.keys(allSelections(report, 'physical')).length).toBeGreaterThan(0);
    run().report = report;
  });

  it('Sync writes .sync-plan.json naming the files in this storage', async () => {
    const { panel } = await open(root, showcase);
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, 'physical') } });
    const generated = await waitFor(panel, 'syncPlanGenerated');
    expect(errorsOf(panel)).toEqual([]);
    const planFile = path.join(root, '.erd-studio', '.sync-plan.json');
    expect(generated.payload.filePath).toBe(planFile);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf-8')) as SyncPlan;
    expect(generated.payload.totalActions).toBe(countSyncPlanActions(plan));
    expect(plan).toMatchObject({ domain: 'showcase', layer: 'silver', sourceStage: 'logical', targetStage: 'physical' });
    for (const ctx of Object.values(plan.modelContext)) {
      // Every table of the showcase has a file: the plan names it, in this storage's layout.
      expect(fs.existsSync(path.join(root, ctx.logicalModelPath)), ctx.logicalModelPath).toBe(true);
      if (storage === 'dbml') {
        expect(ctx.logicalModelPath).toMatch(/^\.erd-studio\/silver\/tables\/[^/]+\/[^/]+\.dbml$/);
        expect(ctx.relationshipsPath).toBe('.erd-studio/silver/relationships/silver.dbml');
        expect(fs.existsSync(path.join(root, ctx.relationshipsPath!))).toBe(true);
      } else {
        expect(ctx.logicalModelPath).toMatch(/^\.erd-studio\/logical-models\/[^/]+\.yml$/);
        expect(ctx.relationshipsPath).toBeUndefined();
      }
      if (ctx.dbtSchemaPath) expect(fs.existsSync(path.join(root, ctx.dbtSchemaPath)), ctx.dbtSchemaPath).toBe(true);
      // The SQL file is one that is there, or null: never a name guessed from the yml's.
      if (ctx.dbtSqlPath !== null) expect(fs.existsSync(path.join(root, ctx.dbtSqlPath)), ctx.dbtSqlPath).toBe(true);
    }
    expect(plan.modelContext.dim_customer).toMatchObject({ dbtSqlPath: null, dbtSchemaPath: 'models/silver/dim_customer.yml' });
    for (const r of plan.relationships) {
      if (storage === 'dbml' && r.storedIn) expect(fs.existsSync(path.join(root, '.erd-studio', r.storedIn.replace(/^\.erd-studio\//, ''))) || fs.existsSync(path.join(root, r.storedIn))).toBe(true);
    }
    run().plan = plan;
  });

  it('Add Tables from dbt on the logical stage adds a library table and a new one from dbt', async () => {
    const { panel } = await open(root, showcase);
    picker.layer = 'none';
    picker.extra = ['fct_sale', 'stg_raw_payments'];
    try {
      panel._postedMessages.length = 0;
      await panel._simulateMessage({ type: 'addModelsFromDbt' });
      await vi.waitFor(() => {
        const s = services(root);
        const unified = s.subjectAreaService.getSubjectArea(path.join(root, '.erd-studio', ...showcase.split('/')));
        expect(unified.logical.models.map((m) => m.name)).toEqual(expect.arrayContaining(['fct_sale', 'stg_raw_payments']));
      }, { timeout: 8000, interval: 20 });
    } finally {
      picker.extra = [];
      picker.layer = 'gold';
    }
    expect(errorsOf(panel)).toEqual([]);
    // The new table's file is in the diagram's layer, in this storage.
    const s = services(root);
    const file = s.tableLibraryService.findTableFile('stg_raw_payments')!;
    const rel = path.relative(path.join(root, '.erd-studio'), file).split(path.sep).join('/');
    expect(rel).toBe(storage === 'dbml' ? 'silver/tables/silver/stg_raw_payments.dbml' : 'logical-models/stg_raw_payments.yml');
    // The declared columns, then the one only the catalog has (Snowflake's LOADED_AT, lowercased).
    expect(s.tableLibraryService.getTable('stg_raw_payments')!.columns.map((c) => c.name)).toEqual(['payment_id', 'order_id', 'amount', 'payment_method', 'loaded_at']);
    const unified = s.subjectAreaService.getSubjectArea(path.join(root, '.erd-studio', ...showcase.split('/')));
    run().added = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
  });

  it('Draw from dbt writes a diagram and its tables in this storage, and the diagram opens and draws', async () => {
    const s = services(root);
    const before = new Set(Object.keys(snapshot(root)));
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('drawn' as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    picker.extra = ['stg_raw_payments'];
    const deps: DrawFromDbtDeps = {
      workspaceRoot: root,
      semanticDir: '.erd-studio',
      modelPaths: ['models'],
      layerService: s.layerService,
      subjectAreaService: s.subjectAreaService,
      tableLibraryService: s.tableLibraryService,
      loadDbt: async () => ({
        ymlData: await s.ymlParserService.loadYmlData(root, undefined),
        manifest: await s.manifestService.loadManifest(root),
        catalog: (await s.catalogService.loadCatalog(root)) ?? undefined,
      }),
      validateDomainName: () => undefined,
      onWritten: () => undefined,
    };
    let result;
    try {
      result = await drawFromDbt(deps);
    } finally {
      picker.extra = [];
      vi.restoreAllMocks();
    }
    expect(error).not.toHaveBeenCalled();
    // The real dbt models were offered.
    expect(picker.offered).toEqual(expect.arrayContaining(['dim_date', 'fct_task_event', 'stg_raw_payments']));
    const diagram = DIAGRAM[storage]('gold', 'drawn');
    expect(result?.domainPath).toBe(path.join(root, '.erd-studio', ...diagram.split('/')));
    const created = Object.keys(snapshot(root)).filter((f) => !before.has(f)).sort();
    // stg_raw_payments was added to the library above; dim_date and fct_task_event are library tables: only the diagram is new.
    expect(created).toEqual([diagram]);
    if (storage === 'dbml') {
      const text = fs.readFileSync(path.join(root, '.erd-studio', ...diagram.split('/')), 'utf-8');
      expect(text).toMatch(/^use \{ table silver\.fct_task_event \} +from '\.\.\/\.\.\/silver\/tables\/silver\/fct_task_event\.dbml'$/m);
      // None of the three is the foreign-key end of a Ref to another: no relationships file to import.
      expect(text).not.toMatch(/^use \* from/m);
    }
    // It opens on the canvas and draws its tables.
    const { panel, loaded } = await open(root, diagram);
    expect(errorsOf(panel)).toEqual([]);
    const names = ((loaded.payload as { models: Array<{ name: string }> }).models).map((m) => m.name).sort();
    expect(names).toEqual(['dim_date', 'fct_task_event', 'stg_raw_payments']);
    const unified = services(root).subjectAreaService.getSubjectArea(result!.domainPath);
    run().drawn = buildLogicalDisplaySubjectArea(SubjectAreaService.toLogicalStage(unified), unified.viewConfig, unified.stubColumns);
    run().drawnFiles = created;
  });

  it('Draw from dbt puts a table new to the library in the chosen layer', async () => {
    const s = services(root);
    const before = new Set(Object.keys(snapshot(root)));
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('drawn_new' as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    // A copy of the dbt project with one more model: in the gold folder, so the gold layer is chosen.
    fs.writeFileSync(path.join(root, 'models', 'gold', 'fct_payment.yml'), [
      'version: 2', 'models:', '  - name: fct_payment', '    description: Payments', '    columns:',
      '      - name: payment_key', '        data_type: integer', '        tests: [unique, not_null]',
      '      - name: customer_key', '        data_type: integer', '        tests:',
      '          - relationships:', '              to: ref(\'dim_customer\')', '              field: customer_key', '',
    ].join('\n'));
    const deps: DrawFromDbtDeps = {
      workspaceRoot: root, semanticDir: '.erd-studio', modelPaths: ['models'],
      layerService: s.layerService, subjectAreaService: s.subjectAreaService, tableLibraryService: s.tableLibraryService,
      loadDbt: async () => ({ ymlData: await s.ymlParserService.loadYmlData(root, undefined), manifest: await s.manifestService.loadManifest(root) }),
      validateDomainName: () => undefined,
      onWritten: () => undefined,
    };
    picker.extra = ['dim_customer'];
    let result;
    try {
      result = await drawFromDbt(deps);
    } finally {
      picker.extra = [];
      vi.restoreAllMocks();
      fs.rmSync(path.join(root, 'models', 'gold', 'fct_payment.yml'));
    }
    expect(error).not.toHaveBeenCalled();
    const created = Object.keys(snapshot(root)).filter((f) => !before.has(f)).sort();
    const diagram = DIAGRAM[storage]('gold', 'drawn_new');
    if (storage === 'dbml') {
      expect(created).toEqual([diagram, 'gold/relationships/gold.dbml', 'gold/tables/gold/fct_payment.dbml'].sort());
      // In the new table's layer's own relationships file (it has none yet), naming the silver table it points at.
      expect(fs.readFileSync(path.join(root, '.erd-studio', 'gold', 'relationships', 'gold.dbml'), 'utf-8'))
        .toMatch(/^Ref: gold\.fct_payment\.customer_key >\?? silver\.dim_customer\.customer_key$/m);
    } else {
      expect(created).toEqual([diagram, 'logical-models/fct_payment.yml'].sort());
    }
    const unified = services(root).subjectAreaService.getSubjectArea(result!.domainPath);
    // The gold folder's models (fct_payment is now one of them) and dim_customer.
    expect(unified.logical.models.map((m) => m.name).sort()).toEqual(['dim_customer', 'dim_date', 'fct_payment', 'fct_task_event']);
    const rels = unified.logical.models.flatMap((m) => (m.relationships ?? []).map((r) => `${m.name}.${r.fromColumn} -> ${r.toModel}.${r.toColumn}`))
      .concat((unified.logical.relationships ?? []).map((r) => `${r.fromModel}.${r.fromColumn} -> ${r.toModel}.${r.toColumn}`));
    expect(rels).toContain('fct_payment.customer_key -> dim_customer.customer_key');
  });

  it('selectors.yml lists each diagram\'s tables and keeps the user\'s selectors', () => {
    const original = parseYaml(fs.readFileSync(path.join(FIXTURES, fixture, 'selectors.yml'), 'utf-8')) as { selectors: Array<{ name: string; description?: string }> };
    const userSelectors = original.selectors.filter((sel) => !sel.name.startsWith('domain_'));
    const result = services(root).selectorsService.regenerate();
    expect(result.status).not.toBe('not-dbt-project');
    expect(result.status).not.toBe('skipped');
    const after = parseYaml(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')) as {
      selectors: Array<{ name: string; description?: string; definition: { union: Array<{ value: string }> } }>;
    };
    const managed = after.selectors.filter((sel) => sel.name.startsWith('domain_'));
    expect(managed.map((sel) => sel.name)).toEqual(expect.arrayContaining(['domain_silver_showcase', 'domain_gold_drawn', 'domain_gold_drawn_new']));
    const showcaseSel = managed.find((sel) => sel.name === 'domain_silver_showcase')!;
    expect(showcaseSel.definition.union.map((u) => u.value)).toEqual(expect.arrayContaining(['fct_sale', 'stg_raw_payments', 'dim_customer']));
    expect(after.selectors.filter((sel) => !sel.name.startsWith('domain_'))).toEqual(userSelectors);
    expect(fs.readFileSync(path.join(root, 'selectors.yml'), 'utf-8')).toContain('# Keep in sync with airflow DAG `incrementals_v2`');
    run().selectors = managed.map((sel) => ({ name: sel.name, values: sel.definition.union.map((u) => u.value).sort() }));
    run().userSelectors = userSelectors;
  });
});

/** `erd-studio diff --json --domain <diagram>`, in-process through the CLI's own `main()`. */
async function cliDiff(root: string, diagram: string): Promise<DiffResult> {
  let out = '';
  await cliMain(['diff', '--json', '--domain', diagram], {
    stdout: { write: (t: string) => { out += t; } },
    stderr: { write: () => undefined },
    cwd: root,
    env: {},
  });
  return JSON.parse(out) as DiffResult;
}

/** A table's columns as compared: normalised names, sorted (Compare keys on `normaliseName`). */
const columnKeys = (columns: ReadonlyArray<{ name: string }>): string[] => columns.map((c) => c.name.toLowerCase()).sort();

/**
 * The dev-host case: stg_raw_payments declares four columns and the
 * Snowflake catalog reports a fifth, LOADED_AT. A table drawn (or added)
 * from dbt is what the Physical tab shows, so Compare and `erd-studio diff`
 * have nothing to say right after.
 */
describe.each([
  ['yaml', 'dbt-project'],
  ['dbml', 'dbt-project-dbml'],
] as Array<[Storage, string]>)('a table drawn from dbt opens with nothing to compare (%s storage)', (storage, fixture) => {
  let root: string;
  const DECLARED_THEN_CATALOG = ['payment_id', 'order_id', 'amount', 'payment_method', 'loaded_at'];

  beforeAll(() => {
    _resetMockWorkspace();
    root = copyFixture(fixture);
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('Draw from dbt seeds the catalog-only column, the Physical tab shows the same columns, and diff is clean', async () => {
    const s = services(root);
    expect(s.tableLibraryService.tableExists('stg_raw_payments')).toBe(false);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('payments' as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    picker.only = ['stg_raw_payments'];
    let result;
    try {
      result = await drawFromDbt({
        workspaceRoot: root, semanticDir: '.erd-studio', modelPaths: ['models'],
        layerService: s.layerService, subjectAreaService: s.subjectAreaService, tableLibraryService: s.tableLibraryService,
        loadDbt: async () => ({
          ymlData: await s.ymlParserService.loadYmlData(root, undefined),
          manifest: await s.manifestService.loadManifest(root),
          catalog: (await s.catalogService.loadCatalog(root)) ?? undefined,
        }),
        validateDomainName: () => undefined,
        onWritten: () => undefined,
      });
    } finally {
      picker.only = undefined;
      vi.restoreAllMocks();
    }
    expect(error).not.toHaveBeenCalled();
    expect(result?.domainPath).toBeDefined();
    const drawn = services(root).tableLibraryService.getTable('stg_raw_payments')!;
    expect(drawn.columns.map((c) => [c.name, c.dataType])).toEqual([
      ['payment_id', 'NUMBER(38,0)'], ['order_id', 'NUMBER(38,0)'], ['amount', 'FLOAT'], ['payment_method', 'TEXT'], ['loaded_at', 'TIMESTAMP_NTZ'],
    ]);

    // The Physical tab draws the same columns (in catalog order, as the warehouse spells them).
    const diagram = path.relative(path.join(root, '.erd-studio'), result!.domainPath).split(path.sep).join('/');
    const { panel } = await open(root, diagram);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    const stage = await waitFor(panel, 'stageData', (m) => m.requestId === 1);
    const shown = (stage.payload as { models: Array<{ name: string; columns: Array<{ name: string }> }> }).models
      .find((m) => m.name === 'stg_raw_payments')!;
    expect(columnKeys(shown.columns)).toEqual(columnKeys(drawn.columns));

    // Compare on the canvas: every column matched.
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
    expect(errorsOf(panel)).toEqual([]);
    const payments = report.models.find((m) => m.name === 'stg_raw_payments')!;
    expect(payments.status).toBe('matched');
    expect(payments.columns.filter((c) => c.status !== 'matched')).toEqual([]);
    expect(payments.columns.map((c) => c.name.toLowerCase()).sort()).toEqual([...DECLARED_THEN_CATALOG].sort());

    // erd-studio diff right after drawing: clean, no fix.
    const diff = await cliDiff(root, path.relative(root, result!.domainPath));
    expect(diff.domains).toHaveLength(1);
    expect(diff.domains[0].fixes).toEqual([]);
    expect(diff.domains[0].clean).toBe(true);
  });

  it('Add Existing Model seeds the same columns as Draw from dbt, and Compare matches every one', async () => {
    // A fresh copy, so the table is new to the library and Add Existing seeds it from dbt.
    const fresh = copyFixture(fixture);
    try {
      expect(services(fresh).tableLibraryService.tableExists('stg_raw_payments')).toBe(false);
      const showcase = DIAGRAM[storage]('silver', 'showcase');
      const { panel, provider } = await open(fresh, showcase);
      // The dialog's count is what adding it gives: four declared columns and LOADED_AT. (The
      // showcase diagram lists only models/silver, so ask for the rows with no folder filter.)
      const s = services(fresh);
      const rows = (provider as unknown as { buildWebviewPayload: (...a: unknown[]) => { existingModels: Array<{ name: string; columnCount: number }> } })
        .buildWebviewPayload({ models: [] }, await s.manifestService.loadManifest(fresh), await s.ymlParserService.loadYmlData(fresh, undefined),
          undefined, { catalog: await s.catalogService.loadCatalog(fresh) }).existingModels;
      expect(rows.find((r) => r.name === 'stg_raw_payments')?.columnCount).toBe(DECLARED_THEN_CATALOG.length);
      await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'stg_raw_payments' } });
      await vi.waitFor(() => {
        const unified = services(fresh).subjectAreaService.getSubjectArea(path.join(fresh, '.erd-studio', ...showcase.split('/')));
        expect(unified.logical.models.map((m) => m.name)).toContain('stg_raw_payments');
      }, { timeout: 8000, interval: 20 });
      expect(errorsOf(panel)).toEqual([]);
      expect(services(fresh).tableLibraryService.getTable('stg_raw_payments')!.columns.map((c) => c.name)).toEqual(DECLARED_THEN_CATALOG);
      await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
      const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
      const payments = report.models.find((m) => m.name === 'stg_raw_payments')!;
      expect(payments.columns.filter((c) => c.status !== 'matched')).toEqual([]);
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('the two storages agree at every step of the dbt loop', () => {
  const both = (): [Partial<Seen>, Partial<Seen>] => [seen.yaml!, seen.dbml!];

  it('the Physical tab draws the same tables, columns and relationships', () => {
    const [yaml, dbml] = both();
    expect(same(withoutStorageFields(dbml.physical))).toEqual(same(withoutStorageFields(yaml.physical)));
  });

  it('dragging on the Physical tab saves the same position', () => {
    const [yaml, dbml] = both();
    expect(dbml.dragged).toEqual(yaml.dragged);
  });

  it('Compare reports the same differences', () => {
    const [yaml, dbml] = both();
    expect(relationshipsSorted(dbml.report)).toEqual(relationshipsSorted(yaml.report));
  });

  it('Sync plans the same changes; only the logical file paths differ', () => {
    const [yaml, dbml] = both();
    const strip = (plan: SyncPlan): unknown => ({
      ...plan,
      generatedAt: '',
      modelContext: Object.fromEntries(Object.entries(plan.modelContext).map(([k, c]) => [k, { ...c, logicalModelPath: path.posix.basename(c.logicalModelPath).replace(/\.(yml|dbml)$/, ''), relationshipsPath: undefined }])),
      relationships: plan.relationships.map((r) => ({ ...r, storedIn: undefined })),
    });
    expect(relationshipsSorted(strip(dbml.plan!))).toEqual(relationshipsSorted(strip(yaml.plan!)));
  });

  it('Add Tables from dbt leaves the same diagram', () => {
    const [yaml, dbml] = both();
    expect(same(withoutStorageFields(dbml.added), ['stg_raw_payments'])).toEqual(same(withoutStorageFields(yaml.added), ['stg_raw_payments']));
  });

  it('Draw from dbt draws the same diagram', () => {
    const [yaml, dbml] = both();
    expect(same(withoutStorageFields(dbml.drawn), ['stg_raw_payments'])).toEqual(same(withoutStorageFields(yaml.drawn), ['stg_raw_payments']));
  });

  it('selectors.yml has the same domain_* selectors and the same user selectors', () => {
    const [yaml, dbml] = both();
    expect(dbml.selectors).toEqual(yaml.selectors);
    expect(dbml.userSelectors).toEqual(yaml.userSelectors);
  });
});
