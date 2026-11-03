/**
 * Draw and Add from dbt place a new table by the schema its dbt developer
 * CONFIGURED (`config.schema`, from `+schema:` or `config(schema=…)`), never
 * the schema dbt built it in, which differs per target (2.0 decision, §2.4,
 * `configuredSchemaOf`). On DBML storage that schema names the table's folder
 * and its qualifier: `<layer>/tables/<configured schema>/<name>.dbml` holding
 * `Table <configured schema>.<name>`; a model with no custom schema goes to its
 * layer's default schema folder, `<layer>/tables/<layer>/`.
 *
 * The fixture's two manifest-only staging models are the pair:
 * `stg_raw_refunds` (config.schema `payments`, built in `staging_payments`)
 * and `stg_raw_payments` (no custom schema, built in `staging`). Each path runs
 * on both storages (`dbt-project`, `dbt-project-dbml`) through the real
 * provider and the real dbt services; only the QuickPick and the name box are
 * stubbed. A YAML library keeps a table's file in `logical-models/` whatever
 * its schema.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';

// The QuickPick of what to draw: the gold folder's scope (layer gold) plus `picker.extra`.
const picker = vi.hoisted(() => ({ extra: [] as string[], layer: 'gold', scopeOnly: true }));
vi.mock('../../src/providers/dbtDraftPicker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/dbtDraftPicker')>()),
  pickDraftScope: async (
    scopes: ReadonlyArray<{ label: string; suggestedLayer?: string; modelNames: string[] }>,
    opts: { excludeNames?: Iterable<string> },
  ) => {
    const excluded = new Set([...(opts.excludeNames ?? [])].map((n) => n.toLowerCase()));
    const scope = scopes.find((s) => s.suggestedLayer === picker.layer) ?? scopes[0];
    const modelNames = [...(picker.scopeOnly ? scope.modelNames : []), ...picker.extra].filter((n) => !excluded.has(n.toLowerCase()));
    return { scope, modelNames };
  },
}));

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { configuredSchemaOf, seedTableFromDbt } from '../../src/services/dbtDraft';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { allSelections } from '../../src/services/syncPlanBuilder';
import type { DiscrepancyReport } from '../../src/types/discrepancy';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const REPO_ROOT = path.resolve(__dirname, '../..');

type Storage = 'yaml' | 'dbml';
type Posted = { type: string; payload?: any; requestId?: number };
type Panel = ReturnType<typeof createMockWebviewPanel>;

const SHOWCASE: Record<Storage, string> = { yaml: 'silver/showcase.json', dbml: 'silver/diagrams/showcase.dbml' };

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function copyFixture(fixture: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `erd-dbt-schema-${fixture}-`));
  fs.cpSync(path.join(FIXTURES, fixture), root, { recursive: true, preserveTimestamps: true });
  roots.push(root);
  return root;
}

function services(root: string) {
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

async function open(root: string, diagram: string): Promise<Panel> {
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
  await waitFor(panel, 'domainLoaded');
  return panel;
}

/** A table's file, relative to the semantic dir. */
function fileOf(root: string, name: string): string | undefined {
  const file = services(root).tableLibraryService.findTableFile(name);
  return file ? path.relative(path.join(root, '.erd-studio'), file).split(path.sep).join('/') : undefined;
}

function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, '.erd-studio', ...rel.split('/')), 'utf-8');
}

function drawDeps(root: string): DrawFromDbtDeps {
  const s = services(root);
  return {
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
}

describe('the fixture has a model with a configured schema and one without', () => {
  it('stg_raw_refunds is configured as payments (built in staging_payments); stg_raw_payments has no custom schema', async () => {
    const root = path.join(FIXTURES, 'dbt-project');
    const manifest = await new ManifestService({ parseInProcess: true }).loadManifest(root);
    const ymlData = await new YmlParserService().loadYmlData(root, undefined);
    expect(manifest.models.get('stg_raw_refunds')).toMatchObject({ schema: 'staging_payments', configSchema: 'payments' });
    expect(manifest.models.get('stg_raw_payments')?.schema).toBe('staging');
    expect(configuredSchemaOf('stg_raw_refunds', ymlData, manifest)).toBe('payments');
    expect(configuredSchemaOf('stg_raw_payments', ymlData, manifest)).toBeUndefined();
    // The seed carries the BUILT schema; only a DBML write turns the configured one into a folder.
    expect(seedTableFromDbt('stg_raw_refunds', ymlData, manifest)?.schema).toBe('staging_payments');
  });

  it('the DBML twin carries the same manifest', () => {
    expect(fs.readFileSync(path.join(FIXTURES, 'dbt-project-dbml', 'target', 'manifest.json'), 'utf-8'))
      .toBe(fs.readFileSync(path.join(FIXTURES, 'dbt-project', 'target', 'manifest.json'), 'utf-8'));
  });
});

describe.each([
  ['yaml', 'dbt-project'],
  ['dbml', 'dbt-project-dbml'],
] as Array<[Storage, string]>)('new tables from dbt follow the configured schema on %s storage (%s)', (storage, fixture) => {
  it('Add Tables from dbt (logical stage) files each new table by its configured schema, else the diagram\'s layer', async () => {
    _resetMockWorkspace();
    const root = copyFixture(fixture);
    const panel = await open(root, SHOWCASE[storage]);
    picker.layer = 'none';
    picker.scopeOnly = false;
    picker.extra = ['stg_raw_refunds', 'stg_raw_payments'];
    try {
      await panel._simulateMessage({ type: 'addModelsFromDbt' });
      await vi.waitFor(() => {
        const unified = services(root).subjectAreaService.getSubjectArea(path.join(root, '.erd-studio', ...SHOWCASE[storage].split('/')));
        expect(unified.logical.models.map((m) => m.name)).toEqual(expect.arrayContaining(['stg_raw_refunds', 'stg_raw_payments']));
      }, { timeout: 8000, interval: 20 });
    } finally {
      picker.extra = [];
      picker.layer = 'gold';
      picker.scopeOnly = true;
    }
    expect(errorsOf(panel)).toEqual([]);
    const lib = services(root).tableLibraryService;
    if (storage === 'dbml') {
      expect(fileOf(root, 'stg_raw_refunds')).toBe('silver/tables/payments/stg_raw_refunds.dbml');
      expect(fileOf(root, 'stg_raw_payments')).toBe('silver/tables/silver/stg_raw_payments.dbml');
      expect(read(root, 'silver/tables/payments/stg_raw_refunds.dbml')).toMatch(/^Table payments\.stg_raw_refunds \{/m);
      expect(read(root, 'silver/tables/silver/stg_raw_payments.dbml')).toMatch(/^Table silver\.stg_raw_payments \{/m);
      // Never the built schema, as a folder or a qualifier.
      expect(fs.existsSync(path.join(root, '.erd-studio', 'silver', 'tables', 'staging_payments'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.erd-studio', 'silver', 'tables', 'staging'))).toBe(false);
      expect(lib.getTable('stg_raw_refunds')!.schema).toBe('payments');
      expect(lib.getTable('stg_raw_payments')!.schema).toBe('silver');
      // The diagram's use lines point at those files.
      const diagram = read(root, SHOWCASE.dbml);
      expect(diagram).toMatch(/^use \{ table payments\.stg_raw_refunds \} +from '\.\.\/tables\/payments\/stg_raw_refunds\.dbml'$/m);
      expect(diagram).toMatch(/^use \{ table silver\.stg_raw_payments \} +from '\.\.\/tables\/silver\/stg_raw_payments\.dbml'$/m);
    } else {
      expect(fileOf(root, 'stg_raw_refunds')).toBe('logical-models/stg_raw_refunds.yml');
      expect(fileOf(root, 'stg_raw_payments')).toBe('logical-models/stg_raw_payments.yml');
    }
    expect(lib.getTable('stg_raw_refunds')!.columns.map((c) => c.name)).toEqual(['refund_id', 'payment_id', 'amount']);
  });

  it('adding one table from dbt (Add Existing Model) files it by its configured schema', async () => {
    _resetMockWorkspace();
    const root = copyFixture(fixture);
    const panel = await open(root, SHOWCASE[storage]);
    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'stg_raw_refunds' } });
    await vi.waitFor(() => expect(fileOf(root, 'stg_raw_refunds')).toBeDefined(), { timeout: 8000, interval: 20 });
    expect(errorsOf(panel)).toEqual([]);
    expect(fileOf(root, 'stg_raw_refunds')).toBe(storage === 'dbml' ? 'silver/tables/payments/stg_raw_refunds.dbml' : 'logical-models/stg_raw_refunds.yml');
    if (storage === 'dbml') expect(read(root, 'silver/tables/payments/stg_raw_refunds.dbml')).toMatch(/^Table payments\.stg_raw_refunds \{/m);
  });

  it('Draw from dbt files each new table by its configured schema in the chosen layer, else that layer\'s default', async () => {
    _resetMockWorkspace();
    const root = copyFixture(fixture);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('payments_drawn' as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const error = vi.spyOn(vscode.window, 'showErrorMessage');
    picker.extra = ['stg_raw_refunds', 'stg_raw_payments'];
    let result;
    try {
      result = await drawFromDbt(drawDeps(root));
    } finally {
      picker.extra = [];
    }
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const diagram = storage === 'dbml' ? 'gold/diagrams/payments_drawn.dbml' : 'gold/payments_drawn.json';
    expect(result?.domainPath).toBe(path.join(root, '.erd-studio', ...diagram.split('/')));
    if (storage === 'dbml') {
      expect(fileOf(root, 'stg_raw_refunds')).toBe('gold/tables/payments/stg_raw_refunds.dbml');
      expect(fileOf(root, 'stg_raw_payments')).toBe('gold/tables/gold/stg_raw_payments.dbml');
      expect(read(root, 'gold/tables/payments/stg_raw_refunds.dbml')).toMatch(/^Table payments\.stg_raw_refunds \{/m);
      expect(read(root, 'gold/tables/gold/stg_raw_payments.dbml')).toMatch(/^Table gold\.stg_raw_payments \{/m);
      const text = read(root, diagram);
      expect(text).toMatch(/^use \{ table payments\.stg_raw_refunds \} +from '\.\.\/tables\/payments\/stg_raw_refunds\.dbml'$/m);
      expect(text).toMatch(/^use \{ table gold\.stg_raw_payments \} +from '\.\.\/tables\/gold\/stg_raw_payments\.dbml'$/m);
    } else {
      expect(fileOf(root, 'stg_raw_refunds')).toBe('logical-models/stg_raw_refunds.yml');
      expect(fileOf(root, 'stg_raw_payments')).toBe('logical-models/stg_raw_payments.yml');
    }
    const unified = services(root).subjectAreaService.getSubjectArea(result!.domainPath);
    expect(unified.logical.models.map((m) => m.name)).toEqual(expect.arrayContaining(['stg_raw_refunds', 'stg_raw_payments']));

    // The drawn diagram matches dbt by name on the Physical tab and in Compare, whatever its folder.
    const panel = await open(root, diagram);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 7 } });
    const stage = await waitFor(panel, 'stageData', (m) => m.requestId === 7);
    const physical = stage.payload as { models: Array<{ name: string; existsInProject?: boolean }> };
    expect(physical.models.find((m) => m.name === 'stg_raw_refunds')?.existsInProject).not.toBe(false);
    expect(physical.models.find((m) => m.name === 'stg_raw_payments')?.existsInProject).not.toBe(false);
    expect(errorsOf(panel)).toEqual([]);
  });

  it('a configured schema that cannot be a folder name falls back to the layer default', async () => {
    _resetMockWorkspace();
    const root = copyFixture(fixture);
    const manifestFile = path.join(root, 'target', 'manifest.json');
    const json = JSON.parse(fs.readFileSync(manifestFile, 'utf-8'));
    json.nodes['model.my_dbt_project.stg_raw_refunds'].config.schema = "{{ env_var('PAYMENTS_SCHEMA') }}";
    fs.writeFileSync(manifestFile, JSON.stringify(json, null, 2));
    const panel = await open(root, SHOWCASE[storage]);
    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'stg_raw_refunds' } });
    await vi.waitFor(() => expect(fileOf(root, 'stg_raw_refunds')).toBeDefined(), { timeout: 8000, interval: 20 });
    expect(errorsOf(panel)).toEqual([]);
    expect(fileOf(root, 'stg_raw_refunds')).toBe(storage === 'dbml' ? 'silver/tables/silver/stg_raw_refunds.dbml' : 'logical-models/stg_raw_refunds.yml');
  });

  it('Compare and the sync plan agree with the file the add wrote', async () => {
    _resetMockWorkspace();
    const root = copyFixture(fixture);
    const panel = await open(root, SHOWCASE[storage]);
    await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'stg_raw_refunds' } });
    await vi.waitFor(() => expect(fileOf(root, 'stg_raw_refunds')).toBeDefined(), { timeout: 8000, interval: 20 });
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
    // Compare matches it to dbt by name: no "missing" either side.
    const row = report.models.find((m) => m.name === 'stg_raw_refunds');
    expect(row?.status).toBe('matched');
    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, 'physical') } });
    await waitFor(panel, 'syncPlanGenerated');
    const plan = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio', '.sync-plan.json'), 'utf-8')) as { modelContext: Record<string, { logicalModelPath: string }> };
    // Every table the plan names is where the library has it (the new one under its configured schema on DBML).
    for (const [name, ctx] of Object.entries(plan.modelContext)) {
      expect(ctx.logicalModelPath, name).toBe(`.erd-studio/${fileOf(root, name)}`);
    }
    expect(errorsOf(panel)).toEqual([]);
  });
});
