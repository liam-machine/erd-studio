/**
 * Where a sync plan says a table with no file yet goes (`logicalModelPath`
 * of a member drawn as missing): where Draw from dbt and Add Tables from dbt
 * put the same table — the diagram's layer, and on a DBML diagram its dbt
 * custom schema's folder when the developer configured one (§2.4). Never the
 * first layer of `layers.json` because nothing named one. The canvas and the
 * CLI take the paths from one place (`syncPlanLibraryLookups`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { buildCliContext } from '../../src/cli/context';
import { runDiff } from '../../src/cli/diff';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { allSelections, syncPlanLibraryLookups } from '../../src/services/syncPlanBuilder';
import type { SyncPlan } from '../../src/types/syncPlan';

const FIXTURES = path.resolve(__dirname, '../fixtures');

let tmp: string;
beforeEach(() => { _resetMockWorkspace(); tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sync-home-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function copy(fixture: string): string {
  const root = path.join(tmp, fixture);
  fs.cpSync(path.join(FIXTURES, fixture), root, { recursive: true, preserveTimestamps: true });
  return root;
}

/** Give the manifest's `name` node a dbt custom schema (`+schema:` / `config(schema=…)`). */
function configureSchema(root: string, name: string, schema: string): void {
  const file = path.join(root, 'target', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as { nodes: Record<string, { name?: string; config?: Record<string, unknown> }> };
  const node = Object.values(manifest.nodes).find((n) => n.name === name)!;
  node.config = { ...(node.config ?? {}), schema };
  fs.writeFileSync(file, JSON.stringify(manifest));
}

/**
 * dbt-project-dbml with fct_task_event's table file gone and the gold
 * finance diagram listing it: the sync plan's add-column fixes then need a
 * new file for it.
 */
function dbmlWithMissingGoldMember(): string {
  const root = copy('dbt-project-dbml');
  const erd = path.join(root, '.erd-studio');
  fs.rmSync(path.join(erd, 'silver', 'tables', 'silver', 'fct_task_event.dbml'));
  const finance = path.join(erd, 'gold', 'diagrams', 'finance.dbml');
  fs.writeFileSync(finance, `${fs.readFileSync(finance, 'utf-8')}\nuse { table gold.fct_task_event } from '../tables/gold/fct_task_event.dbml'\n`);
  return root;
}

async function planPath(root: string, diagram: string, model: string): Promise<{ logical?: string; fixFiles: string[] }> {
  const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
  const { result } = runDiff(ctx, { domains: [diagram] });
  const d = result.domains[0];
  return {
    logical: d.plan?.modelContext[model]?.logicalModelPath,
    fixFiles: [...new Set(d.fixes.filter((f) => f.model === model && f.kind === 'add-column').map((f) => f.file))],
  };
}

describe('a sync plan puts a new table where Draw from dbt would', () => {
  it('DBML: the diagram\'s layer, not the first layer of layers.json', async () => {
    const root = dbmlWithMissingGoldMember();
    const got = await planPath(root, '.erd-studio/gold/diagrams/finance.dbml', 'fct_task_event');
    expect(got.logical).toBe('.erd-studio/gold/tables/gold/fct_task_event.dbml');
    expect(got.fixFiles).toEqual(['.erd-studio/gold/tables/gold/fct_task_event.dbml']);
  });

  it('DBML: the dbt custom schema\'s folder in that layer, when the developer configured one', async () => {
    const root = dbmlWithMissingGoldMember();
    configureSchema(root, 'fct_task_event', 'finance');
    const got = await planPath(root, '.erd-studio/gold/diagrams/finance.dbml', 'fct_task_event');
    expect(got.logical).toBe('.erd-studio/gold/tables/finance/fct_task_event.dbml');
  });

  it('DBML: a configured schema that is no schema folder name is left out (the layer\'s schema)', async () => {
    const root = dbmlWithMissingGoldMember();
    configureSchema(root, 'fct_task_event', '{{ env_var("X") }}');
    const got = await planPath(root, '.erd-studio/gold/diagrams/finance.dbml', 'fct_task_event');
    expect(got.logical).toBe('.erd-studio/gold/tables/gold/fct_task_event.dbml');
  });

  it('YAML grouped by layer: the diagram\'s layer folder', async () => {
    const root = copy('dbt-project');
    const lib = path.join(root, '.erd-studio', 'logical-models');
    fs.mkdirSync(path.join(lib, 'silver'));
    for (const f of fs.readdirSync(lib).filter((n) => n.endsWith('.yml'))) fs.renameSync(path.join(lib, f), path.join(lib, 'silver', f));
    fs.rmSync(path.join(lib, 'silver', 'fct_task_event.yml'));
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'events.json'), JSON.stringify({
      schemaVersion: 5, domain: 'events', layer: 'gold', description: '',
      logical: { models: ['fct_task_event'], relationships: [], viewConfig: { positions: { fct_task_event: { x: 0, y: 0 } } } },
    }, null, 2));
    const got = await planPath(root, '.erd-studio/gold/events.json', 'fct_task_event');
    expect(got.logical).toBe('.erd-studio/logical-models/gold/fct_task_event.yml');
  });

  it('YAML, flat library: the top level, as today (a flat library stays flat)', async () => {
    const root = copy('dbt-project');
    fs.rmSync(path.join(root, '.erd-studio', 'logical-models', 'fct_task_event.yml'));
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'events.json'), JSON.stringify({
      schemaVersion: 5, domain: 'events', layer: 'gold', description: '',
      logical: { models: ['fct_task_event'], relationships: [], viewConfig: { positions: { fct_task_event: { x: 0, y: 0 } } } },
    }, null, 2));
    const got = await planPath(root, '.erd-studio/gold/events.json', 'fct_task_event');
    expect(got.logical).toBe('.erd-studio/logical-models/fct_task_event.yml');
  });

  it('a table that has a file keeps it, whatever the diagram\'s layer', async () => {
    const root = copy('dbt-project-dbml');
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const lookups = syncPlanLibraryLookups(ctx.tableLibraryService, {
      diagramFile: path.join(root, '.erd-studio', 'gold', 'diagrams', 'finance.dbml'),
      layerIds: new Set(ctx.layerService.getAllLayers().map((l) => l.id)),
      manifest: ctx.manifest,
      ymlData: ctx.ymlData,
    });
    expect(lookups.tableLibraryFile!('dim_customer')).toBe('silver/tables/silver/dim_customer.dbml');
    expect(lookups.newTableFilePath!('brand_new')).toBe('gold/tables/gold/brand_new.dbml');
    expect(lookups.relationshipsFile!('fct_order')).toBe('silver/relationships/silver.dbml');
  });
});

/** The plan the canvas writes for `diagram` (relative to the semantic dir): Compare, then Sync with dbt as the truth. */
async function canvasPlan(root: string, diagram: string): Promise<SyncPlan> {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectors = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => undefined);
  const context = {
    extensionUri: vscode.Uri.file(root),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService({ parseInProcess: true }), new YmlParserService(), new TemplateService(),
    layerService, root, selectors, tableLibraryService,
  );
  const file = path.join(root, '.erd-studio', ...diagram.split('/'));
  const document = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  const posted = (): Array<{ type: string; payload?: any }> => panel._postedMessages as Array<{ type: string; payload?: any }>;
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
  await vi.waitFor(() => expect(posted().some((m) => m.type === 'discrepancyReport' && m.payload)).toBe(true), { timeout: 8000 });
  const report = posted().find((m) => m.type === 'discrepancyReport' && m.payload)!.payload;
  await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(report, 'physical') } });
  await vi.waitFor(() => expect(posted().some((m) => m.type === 'syncPlanGenerated')).toBe(true), { timeout: 8000 });
  return JSON.parse(fs.readFileSync(path.join(root, '.erd-studio', '.sync-plan.json'), 'utf-8')) as SyncPlan;
}

describe('the canvas\'s sync plan names the same new-table path as the CLI', () => {
  it('DBML: the gold diagram\'s new table goes to gold, with its configured schema', async () => {
    const root = dbmlWithMissingGoldMember();
    configureSchema(root, 'fct_task_event', 'finance');
    const plan = await canvasPlan(root, 'gold/diagrams/finance.dbml');
    expect(plan.modelContext.fct_task_event.logicalModelPath).toBe('.erd-studio/gold/tables/finance/fct_task_event.dbml');
    expect(plan.modelContext.fct_task_event.logicalModelPath)
      .toBe((await planPath(root, '.erd-studio/gold/diagrams/finance.dbml', 'fct_task_event')).logical);
  });
});
