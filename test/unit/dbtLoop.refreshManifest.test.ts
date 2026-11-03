/**
 * Refresh Manifest on either storage: the real `erdStudio.refreshManifest`
 * command (registered by the real `activate()`), reached the way the canvas
 * reaches it, through the webview's `refreshManifest` message. After
 * `target/manifest.json` changes (a column, a model), the open diagram picks
 * the change up only on a refresh, on whichever stage it shows:
 *
 * - the logical stage's dbt model list (the Add Table dialog);
 * - the Physical tab's relationships (from dbt's relationship tests);
 * - an open Compare overlay: its report and the staleness banner are worked
 *   out again, so the overlay and the sync plan never use the old manifest.
 *
 * Runs on `test/fixtures/dbt-project` (YAML/JSON) and its DBML twin
 * `test/fixtures/dbt-project-dbml`, each on a temp copy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { allSelections } from '../../src/services/syncPlanBuilder';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { SyncPlan } from '../../src/types/syncPlan';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(REPO_ROOT, 'test', 'fixtures');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

type Storage = 'yaml' | 'dbml';
type Posted = { type: string; payload?: any; requestId?: number };
type Panel = ReturnType<typeof vscode.createMockWebviewPanel>;

const SHOWCASE: Record<Storage, string> = { yaml: 'silver/showcase.json', dbml: 'silver/diagrams/showcase.dbml' };
const TASK_EVENT = 'model.my_dbt_project.fct_task_event';

function makeContext(root: string): vscode.ExtensionContext {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as vscode.ExtensionContext;
}

const posted = (panel: Panel): Posted[] => panel._postedMessages as Posted[];
const errorsOf = (panel: Panel): string[] => posted(panel).filter((m) => m.type === 'error').map((m) => String(m.payload?.message));

async function waitFor(panel: Panel, type: string, test: (m: Posted) => boolean = () => true): Promise<Posted> {
  await vi.waitFor(() => expect(posted(panel).some((m) => m.type === type && test(m))).toBe(true), { timeout: 8000, interval: 10 });
  return posted(panel).filter((m) => m.type === type && test(m)).at(-1)!;
}

/** Every `.sql` / `.yml` under `dir`: what `findFiles` hands the staleness check (the mock's own lists nothing). */
function modelFiles(dir: string): vscode.Uri[] {
  const out: vscode.Uri[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (/\.(sql|ya?ml)$/.test(e.name)) out.push(vscode.Uri.file(abs));
    }
  };
  walk(dir);
  return out;
}

/** Rewrite the copy's manifest with `edit`, stamped `at` (epoch ms). */
function editManifest(root: string, edit: (json: any) => void, at: number): void {
  const file = path.join(root, 'target', 'manifest.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
  edit(json);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  fs.utimesSync(file, at / 1000, at / 1000);
}

/** dbt parse after a developer added `relationships: to: ref('dim_date')` on fct_task_event.event_date. */
function addDateTest(json: any): void {
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
}

type Rel = { fromModel: string; fromColumn: string; toModel: string; toColumn: string; status?: string };
const isDateLink = (r: Rel): boolean =>
  r.fromModel === 'fct_task_event' && r.fromColumn === 'event_date' && r.toModel === 'dim_date' && r.toColumn === 'date_key';
/** Every relationship a display payload draws, wherever it carries them. */
const relationshipsOf = (payload: { relationships?: Rel[]; models: Array<{ name: string; relationships?: Array<Omit<Rel, 'fromModel'>> }> }): Rel[] => [
  ...(payload.relationships ?? []),
  ...payload.models.flatMap((m) => (m.relationships ?? []).map((r) => ({ fromModel: m.name, ...r }))),
];

const dbtModelNames = (payload: { existingModels?: Array<{ name: string }>; manifestModels?: Array<{ name: string }> }): string[] =>
  [...(payload.existingModels ?? []), ...(payload.manifestModels ?? [])].map((m) => m.name);


describe.each([
  ['yaml', 'dbt-project'],
  ['dbml', 'dbt-project-dbml'],
] as Array<[Storage, string]>)('Refresh Manifest on %s storage (%s)', (storage, fixture) => {
  let ws: string;
  let context: vscode.ExtensionContext;
  let provider: SemanticEditorProvider;
  let info: ReturnType<typeof vi.spyOn>;
  let exec: ReturnType<typeof vi.spyOn>;
  /** The time the copied manifest was written: every later stamp is after it. */
  let t0: number;

  beforeEach(async () => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), `erd-refresh-${fixture}-`));
    // Timestamps kept: staleness compares the manifest's mtime with the model files'.
    fs.cpSync(path.join(FIXTURES, fixture), ws, { recursive: true, preserveTimestamps: true });
    t0 = Math.max(...modelFiles(path.join(ws, 'models')).map((u) => fs.statSync(u.fsPath).mtimeMs), fs.statSync(path.join(ws, 'target', 'manifest.json')).mtimeMs);
    context = makeContext(ws);
    vscode._resetRegisteredCommands();
    vscode._resetMockConfiguration();
    vscode._resetMockWorkspace();
    vscode._clearMockFileWatchers();
    vscode._resetMockWebviewPanels();
    _resetFirstRunGuardForTests();
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
    vi.stubEnv('HOME', ws);
    vi.stubEnv('USERPROFILE', ws);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async () => modelFiles(path.join(ws, 'models'))) as never);
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
  });

  afterEach(async () => {
    for (const sub of [...context.subscriptions].reverse()) {
      try { await (sub as { dispose(): unknown }).dispose(); } catch { /* best effort */ }
    }
    for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
    vscode._resetMockWebviewPanels();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  async function openShowcase(): Promise<Panel> {
    const file = path.join(ws, '.erd-studio', ...SHOWCASE[storage].split('/'));
    const document = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      document as unknown as vscode.TextDocument,
      panel as unknown as vscode.WebviewPanel,
      {} as vscode.CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await waitFor(panel, 'domainLoaded');
    return panel;
  }

  /** Press Refresh Manifest on the canvas and wait for its toast. */
  async function refresh(panel: Panel): Promise<void> {
    info.mockClear();
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'refreshManifest' });
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('Manifest refreshed. Graphs updated with latest dbt model data.'), { timeout: 8000, interval: 10 });
  }

  it('activation sees a dbt project stored as its fixture is: the dbt surfaces on, in that storage', () => {
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.hasDbtProject', true);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.storage', storage);
  });

  it('the logical stage lists a model dbt added, only after a refresh', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    const first = (await waitFor(panel, 'domainLoaded')).payload;
    expect(dbtModelNames(first)).not.toContain('stg_raw_chargebacks');

    editManifest(ws, (json) => {
      json.nodes['model.my_dbt_project.stg_raw_chargebacks'] = {
        unique_id: 'model.my_dbt_project.stg_raw_chargebacks', name: 'stg_raw_chargebacks', resource_type: 'model',
        schema: 'silver', description: 'Chargebacks', original_file_path: 'models/silver/stg_raw_chargebacks.sql',
        columns: { chargeback_id: { name: 'chargeback_id', data_type: 'INT', description: 'Chargeback id' } },
        depends_on: { nodes: [] }, config: { materialized: 'view' },
      };
    }, t0 + 60_000);
    // The cached manifest stands until a refresh.
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'ready' });
    expect(dbtModelNames((await waitFor(panel, 'domainLoaded')).payload)).not.toContain('stg_raw_chargebacks');

    await refresh(panel);
    const after = await waitFor(panel, 'domainLoaded');
    expect(dbtModelNames(after.payload)).toContain('stg_raw_chargebacks');
    expect(errorsOf(panel)).toEqual([]);
  });

  it('the Physical tab draws a relationship test dbt added, redrawn by the refresh itself', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    const before = (await waitFor(panel, 'stageData', (m) => m.requestId === 1)).payload;
    expect(relationshipsOf(before).some(isDateLink)).toBe(false);

    editManifest(ws, addDateTest, t0 + 60_000);
    // The cached manifest stands until a refresh.
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 2 } });
    expect(relationshipsOf((await waitFor(panel, 'stageData', (m) => m.requestId === 2)).payload).some(isDateLink)).toBe(false);

    await refresh(panel);
    // The refresh redraws the open Physical tab: no stage switch needed.
    const redrawn = await waitFor(panel, 'stageData');
    expect(redrawn.payload.stage).toBe('physical');
    expect(relationshipsOf(redrawn.payload).some(isDateLink)).toBe(true);
    expect(errorsOf(panel)).toEqual([]);
  });

  it('an open Compare overlay is worked out again, and Sync plans from the new report', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    const first = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
    expect(first.relationships.some(isDateLink)).toBe(false);

    editManifest(ws, addDateTest, t0 + 60_000);
    await refresh(panel);
    const again = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
    // Only dbt has it: missing from the logical side being viewed.
    expect(again.relationships.find(isDateLink)?.status).toBe('missing');
    expect(again.domain).toBe('showcase');

    // Sync uses the refreshed report, not the one cached before the refresh.
    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: allSelections(again, 'physical') } });
    await waitFor(panel, 'syncPlanGenerated');
    const plan = JSON.parse(fs.readFileSync(path.join(ws, '.erd-studio', '.sync-plan.json'), 'utf-8')) as SyncPlan;
    expect(plan.relationships.some((r) => isDateLink(r as unknown as Rel))).toBe(true);
    expect(errorsOf(panel)).toEqual([]);
  });

  it('the staleness banner follows the manifest: stale while a model file is newer, cleared by a new manifest and a refresh', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    // A schema yml edited after dbt last wrote the manifest.
    const yml = path.join(ws, 'models', 'gold', 'fct_task_event.yml');
    fs.utimesSync(yml, (t0 + 60_000) / 1000, (t0 + 60_000) / 1000);
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    expect((await waitFor(panel, 'manifestStaleness')).payload.isStale).toBe(true);

    // dbt parse ran: the manifest is newer again.
    editManifest(ws, addDateTest, t0 + 120_000);
    await refresh(panel);
    const now = await waitFor(panel, 'manifestStaleness');
    expect(now.payload).toMatchObject({ isStale: false, manifestMtime: t0 + 120_000 });
    expect(errorsOf(panel)).toEqual([]);
  });

  it('a refresh with no Compare open posts no report', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    editManifest(ws, addDateTest, t0 + 60_000);
    await refresh(panel);
    await waitFor(panel, 'domainLoaded');
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' || m.type === 'manifestStaleness')).toEqual([]);
  });

  it('a Compare closed before the refresh stays closed', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    await waitFor(panel, 'discrepancyReport', (m) => !!m.payload);
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: false } });
    editManifest(ws, addDateTest, t0 + 60_000);
    await refresh(panel);
    await waitFor(panel, 'domainLoaded');
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
  });

  it('a stage switch forgets the Compare: a refresh back on the logical stage posts no report', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    await waitFor(panel, 'discrepancyReport', (m) => !!m.payload);
    // The webview closes the overlay on each stage change (editorStore's setDomain).
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await waitFor(panel, 'stageData', (m) => m.requestId === 1);
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'logical', requestId: 2 } });
    await waitFor(panel, 'stageData', (m) => m.requestId === 2);

    editManifest(ws, addDateTest, t0 + 60_000);
    await refresh(panel);
    await waitFor(panel, 'domainLoaded');
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
    expect(posted(panel).filter((m) => m.type === 'manifestStaleness')).toEqual([]);
    expect(errorsOf(panel)).toEqual([]);
  });

  /**
   * Run `during` once, inside the refresh's redraw, before the redraw itself:
   * a webview message the host handles while the refresh awaits.
   */
  function duringRedraw(method: 'sendSubjectAreaData' | 'handleSwitchStage', during: () => Promise<void>): void {
    const host = provider as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const original = host[method].bind(provider);
    let fired = false;
    vi.spyOn(host, method).mockImplementation(async (...args: unknown[]) => {
      if (!fired) { fired = true; await during(); }
      return original(...args);
    });
  }

  /** Sync answers as it does with no comparison open. */
  async function expectNoCachedReport(panel: Panel): Promise<void> {
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: { 'model:fct_task_event': 'physical' } } });
    await waitFor(panel, 'error');
    expect(errorsOf(panel)).toEqual(['No discrepancy report available. Run a comparison first.']);
  }

  it('a Compare closed while the refresh redraws stays closed, on the host too', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    await waitFor(panel, 'discrepancyReport', (m) => !!m.payload);
    editManifest(ws, addDateTest, t0 + 60_000);
    duringRedraw('sendSubjectAreaData', () => panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: false } }));
    await refresh(panel);
    await waitFor(panel, 'domainLoaded');
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
    expect(posted(panel).filter((m) => m.type === 'manifestStaleness')).toEqual([]);
    await expectNoCachedReport(panel);
    // And the next refresh does not bring it back.
    vi.mocked((provider as unknown as { sendSubjectAreaData: () => void }).sendSubjectAreaData).mockRestore();
    await refresh(panel);
    await waitFor(panel, 'domainLoaded');
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
  });

  it('a stage switch while the refresh redraws caches no physical-against-physical report', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    await waitFor(panel, 'discrepancyReport', (m) => !!m.payload);
    editManifest(ws, addDateTest, t0 + 60_000);
    duringRedraw('sendSubjectAreaData', () => panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 7 } }));
    await refresh(panel);
    await waitFor(panel, 'stageData', (m) => m.requestId === 7);
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
    await expectNoCachedReport(panel);
  });

  it('a Compare closed while its comparison loads is dropped, not cached or posted', { timeout: 30_000 }, async () => {
    const panel = await openShowcase();
    const host = provider as unknown as { loadCatalog: () => Promise<unknown> };
    const original = host.loadCatalog.bind(provider);
    let fired = false;
    vi.spyOn(host, 'loadCatalog').mockImplementation(async () => {
      if (!fired) { fired = true; await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: false } }); }
      return original();
    });
    panel._postedMessages.length = 0;
    await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
    expect(fired).toBe(true);
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport' && m.payload)).toEqual([]);
    expect(posted(panel).filter((m) => m.type === 'discrepancyReport').length).toBe(1);
    await expectNoCachedReport(panel);
  });
});
