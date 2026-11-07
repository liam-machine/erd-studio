/**
 * The Compare overlay, drawn, on either storage. dbtLoop.storage checks that
 * the `discrepancyReport` the host posts is the same on YAML/JSON and DBML;
 * this test goes one step further and runs that report, with the diagram the
 * host posted, through the renderer's own `transformSubjectArea` (what
 * `useCanvasGraph` calls), so the badges, ghost lines and edge statuses the
 * user sees are compared, not just the report. The overlay matches on exact
 * names and `relationshipDisplayKey`, so a DBML diagram that spelled a table
 * or turned a Ref round differently from the report would lose its badges
 * here even when the reports agree.
 *
 * Each run is a temp copy of `test/fixtures/dbt-project` or its DBML twin
 * `dbt-project-dbml`, with the same dbt-side changes made to the manifest so
 * every kind of overlay mark appears: a relationship test only dbt has (a
 * ghost line), a column only dbt has, and the fixture's own relationships
 * only the logical model draws.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { _resetMockWorkspace, createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { transformSubjectArea } from '../../packages/renderer/src/lib/graphTransformer';
import { relationshipDisplayKey } from '../../packages/renderer/src/lib/relationshipDisplayKey';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import { DBT_FIXTURES, SEMANTIC_DIR, copyDbtFixture, diagramPath, type DbtStorage } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TASK_EVENT = 'model.my_dbt_project.fct_task_event';

type Posted = { type: string; payload?: any; requestId?: number };
type Panel = ReturnType<typeof createMockWebviewPanel>;

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** dbt's side moved on: a relationship test and a column the logical model lacks. */
function changeDbt(root: string): void {
  const file = path.join(root, 'target', 'manifest.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  json.nodes['test.my_dbt_project.relationships_fct_task_event_event_date__date_key__ref_dim_date_'] = {
    unique_id: 'test.my_dbt_project.relationships_fct_task_event_event_date__date_key__ref_dim_date_',
    name: 'relationships_fct_task_event_event_date__date_key__ref_dim_date_',
    resource_type: 'test',
    schema: 'gold',
    description: '',
    test_metadata: { name: 'relationships', kwargs: { column_name: 'event_date', field: 'date_key', to: "ref('dim_date')" } },
    attached_node: TASK_EVENT,
    depends_on: { nodes: [TASK_EVENT, 'model.my_dbt_project.dim_date'] },
    columns: {},
    config: {},
  };
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  // The column goes in the schema yml, which dbt's columns are read from first.
  const yml = path.join(root, 'models', 'gold', 'fct_task_event.yml');
  fs.appendFileSync(yml, '      - name: is_reopened\n        description: Reopened after closing\n');
}

function buildProvider(root: string): SemanticEditorProvider {
  const layerService = new LayerService(root, SEMANTIC_DIR);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, SEMANTIC_DIR);
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, root, SEMANTIC_DIR);
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
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
    context, subjectAreaService, new ManifestService({ parseInProcess: true }), new YmlParserService(),
    new TemplateService(), layerService, root, selectorsService, tableLibraryService,
  );
  provider.setCatalogService(new CatalogService());
  return provider;
}

const posted = (panel: Panel): Posted[] => panel._postedMessages as Posted[];
async function waitFor(panel: Panel, type: string, test: (m: Posted) => boolean = () => true): Promise<Posted> {
  await vi.waitFor(() => expect(posted(panel).some((m) => m.type === type && test(m))).toBe(true), { timeout: 8000, interval: 10 });
  return posted(panel).filter((m) => m.type === type && test(m)).at(-1)!;
}

/** What the overlay draws: each node's mark and column marks, each edge's status. */
function overlayOf(display: any, report: DiscrepancyReport) {
  const { nodes, edges } = transformSubjectArea(display, { discrepancyReport: report });
  const tables = nodes
    .filter((n: any) => n.type !== 'annotation')
    .map((n: any) => ({
      id: n.id,
      ghost: n.data?.ghostReason ?? null,
      status: n.data?.discrepancy?.status ?? null,
      columns: (n.data?.discrepancy?.columns ?? [])
        .filter((c: any) => c.status !== 'matched')
        .map((c: any) => `${c.name}:${c.status}`)
        .sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const lines = edges
    .filter((e: any) => e.type === 'fk')
    .map((e: any) => ({ id: e.id, status: e.data?.discrepancyStatus ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { tables, lines, edges };
}

async function compare(storage: DbtStorage, fixture: string, from: 'logical' | 'physical') {
  _resetMockWorkspace();
  const root = copyDbtFixture(fixture, 'erd-overlay');
  roots.push(root);
  changeDbt(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const provider = buildProvider(root);
  const file = diagramPath(root, storage, 'silver', 'showcase');
  const document = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  let display = (await waitFor(panel, 'domainLoaded')).payload;
  if (from === 'physical') {
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    display = (await waitFor(panel, 'stageData', (m) => m.requestId === 1)).payload;
  }
  await panel._simulateMessage({
    type: 'toggleDiscrepancy',
    payload: { enabled: true, compareAgainst: from === 'logical' ? 'physical' : 'logical' },
  });
  const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
  const errors = posted(panel).filter((m) => m.type === 'error').map((m) => m.payload?.message);
  return { report, display, errors, overlay: overlayOf(display, report) };
}

describe.each(['logical', 'physical'] as const)('the Compare overlay drawn from the %s stage', (from) => {
  it('draws the same marks on both storages, and every difference lands on the canvas', { timeout: 30_000 }, async () => {
    const runs = {} as Record<DbtStorage, Awaited<ReturnType<typeof compare>>>;
    for (const [storage, fixture] of DBT_FIXTURES) runs[storage] = await compare(storage, fixture, from);

    for (const [storage] of DBT_FIXTURES) {
      const { report, overlay, errors } = runs[storage];
      expect(errors, storage).toEqual([]);
      // Every relationship difference is a line on the canvas carrying its status: drawn, or a ghost.
      const drawn = new Map(overlay.edges
        .filter((e: any) => e.type === 'fk' && e.data?.discrepancyStatus)
        .map((e: any) => [relationshipDisplayKey(e.data), e.data.discrepancyStatus]));
      const differing = report.relationships.filter((r) => r.status !== 'matched');
      expect(differing.length, storage).toBeGreaterThan(0);
      for (const r of differing) expect(drawn.get(relationshipDisplayKey(r)), `${storage}: ${relationshipDisplayKey(r)}`).toBe(r.status);
      // Every model the report has a mark for is a node carrying it.
      const byId = new Map(overlay.tables.map((t) => [t.id, t]));
      for (const m of report.models) expect(byId.get(m.name)?.status, `${storage}: ${m.name}`).toBe(m.status);
    }

    // The marks themselves.
    const { overlay } = runs.dbml;
    const taskEvent = overlay.tables.find((t) => t.id === 'fct_task_event')!;
    // The column only dbt has: missing from the logical side, extra on the physical side.
    expect(taskEvent.columns).toContain(`is_reopened:${from === 'logical' ? 'missing' : 'extra'}`);
    const dateLine = overlay.lines.find((l) => l.id.includes('event_date') && l.id.includes('dim_date'));
    // The relationship test only dbt has: a ghost line on the logical canvas, an extra line on the physical one.
    expect(dateLine?.status).toBe(from === 'logical' ? 'missing' : 'extra');
    if (from === 'logical') expect(dateLine!.id.startsWith('ghost-')).toBe(true);
    // Relationships only the logical model draws.
    expect(overlay.lines.filter((l) => l.status === (from === 'logical' ? 'extra' : 'missing')).length).toBeGreaterThan(0);

    // Both storages draw exactly the same overlay.
    expect(runs.dbml.overlay.tables).toEqual(runs.yaml.overlay.tables);
    expect(runs.dbml.overlay.lines).toEqual(runs.yaml.overlay.lines);
  });
});
