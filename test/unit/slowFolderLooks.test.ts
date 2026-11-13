/**
 * #295: the bounded looks at the user's folder (the host's dbt search on
 * activation, the start screen's look) and what a slow folder costs.
 *
 * A slow activation names the stretch that held it (the wait on the host's
 * dbt search, the folder walk, the rest of Discovery, or Services: the only
 * stretches before the measurement), the retry after a timeout that turns the
 * blank start suggestion into an import is counted (that retry only), and activation does not wait for the host's search when
 * nothing it could find can change the project that opens. The last block
 * pins facts the rule has to keep in mind.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, ACTIVATION_DBT_SEARCH_MS, findHostDbtProjects, SELECTED_PROJECT_KEY, _resetFirstRunGuardForTests } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import { ownWrites } from '../../src/services/ownWriteTracker';
import { FEATURES } from '../../src/services/telemetryPayload';
import { ACTIVATION_SLOW, SLOW_ACTIVATION_MS, slowActivationFeature } from '../../src/services/runtimeTelemetry';
import { hostSearchCannotChangeRoot, resolveDbtProject, withHostCandidates } from '../../src/services/projectDiscovery';
import { StartIntentTracker, START_LOOK_FRESH_MS, START_LOOK_TIMEOUT_MS } from '../../src/commands/startIntent';
import { isDirectImport, START_ACTIONS, START_INTENTS, type DetectedImportSource } from '../../src/types/startActions';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };
type Context = import('vscode').ExtensionContext;

function makeContext(root: string, onGlobalUpdate?: () => void, onWorkspaceGet?: (key: string) => void): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    ['erdStudio.startSuggestion', { shown: 1, answered: true }],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { onGlobalUpdate?.(); globalState.set(k, v); } },
    workspaceState: { get: (k: string) => { onWorkspaceGet?.(k); return workspaceState.get(k); }, update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

let root: string;
let context: Context;
const keys = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-295-'));
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode.workspace.workspaceFolders = [];
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Date.now() that jumps ahead by `skew` whenever the test says so. */
function skewableClock() {
  const real = Date.now.bind(Date);
  let skew = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + skew);
  return { jump: (ms: number) => { skew += ms; } };
}

/** A folder holding dbt_project.yml (and, with `erd`, an `.erd-studio` folder) at `rel` under the test root. */
function dbtAt(rel: string, erd = false): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(erd ? path.join(dir, '.erd-studio') : dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dbt_project.yml'), `name: ${path.basename(dir) || 'root'}\n`);
  return dir;
}

function openRoot(): void {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
}

const lastContext = (exec: { mock: { calls: unknown[][] } }, key: string): unknown =>
  exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === key).at(-1)?.[2];

describe('#295: which stretch held a slow activation', () => {
  it('the allowlist has the stretch keys, startLookLateSuggestion and dbtSearchSkipped', () => {
    const list = FEATURES as readonly string[];
    for (const key of [...Object.values(ACTIVATION_SLOW), 'startLookLateSuggestion', 'dbtSearchSkipped']) {
      expect(list, key).toContain(key);
    }
  });

  it('names the longest stretch, only past SLOW_ACTIVATION_MS; a tie goes to the search, then the walk, then Discovery', () => {
    const spans = { dbtSearch: 1000, walk: 500, discovery: 8000, services: 2000 };
    expect(slowActivationFeature(spans, 11_500)).toBe('activationSlowDiscovery');
    expect(slowActivationFeature({ ...spans, services: 9000 }, 18_500)).toBe('activationSlowServices');
    expect(slowActivationFeature({ ...spans, walk: 9000 }, 20_000)).toBe('activationSlowWalk');
    expect(slowActivationFeature({ dbtSearch: 7000, walk: 0, discovery: 2000, services: 2000 }, 11_000)).toBe('activationSlowDbtSearch');
    expect(slowActivationFeature(spans, SLOW_ACTIVATION_MS)).toBeUndefined();
    expect(slowActivationFeature(spans, 9_000)).toBeUndefined();
    expect(slowActivationFeature({ dbtSearch: 5500, walk: 5500, discovery: 5500, services: 5500 }, 22_000)).toBe('activationSlowDbtSearch');
    expect(slowActivationFeature({ dbtSearch: 0, walk: 5500, discovery: 5500, services: 5500 }, 16_500)).toBe('activationSlowWalk');
    expect(slowActivationFeature({ dbtSearch: 0, walk: 0, discovery: 5500, services: 5500 }, 11_000)).toBe('activationSlowDiscovery');
  });

  it('11 s waiting on the host search records activationOver10s and activationSlowDbtSearch', async () => {
    // A root dbt project without ERD data: activation waits for the search.
    dbtAt('.');
    openRoot();
    const clock = skewableClock();
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async () => { clock.jump(11_000); return []; }) as never);
    const once = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    expect(keys(once)).toContain('activationOver10s');
    expect(keys(once).filter((k) => k.startsWith('activationSlow'))).toEqual(['activationSlowDbtSearch']);
  });

  it('11 s in the walk that finds the project records activationSlowWalk, not activationSlowDiscovery', async () => {
    // A root dbt project without ERD data: activation waits for the search, then walks.
    dbtAt('.');
    openRoot();
    const clock = skewableClock();
    let searched = false;
    let jumped = false;
    // The walk reads the picked project (resolveWorkspaceProject); the clock jumps there, after the search.
    context = makeContext(root, undefined, (key) => {
      if (key === SELECTED_PROJECT_KEY && searched && !jumped) { jumped = true; clock.jump(11_000); }
    });
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async () => { searched = true; return []; }) as never);
    const once = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    expect(jumped).toBe(true);
    expect(keys(once)).toContain('activationOver10s');
    expect(keys(once).filter((k) => k.startsWith('activationSlow'))).toEqual(['activationSlowWalk']);
  });

  it('11 s in the rest of Discovery (a globalState write before the search) records activationSlowDiscovery', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openRoot();
    const clock = skewableClock();
    let jumped = false;
    context = makeContext(root, () => { if (!jumped) { jumped = true; clock.jump(11_000); } });
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([] as never);
    const once = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    expect(keys(once)).toContain('activationOver10s');
    expect(keys(once).filter((k) => k.startsWith('activationSlow'))).toEqual(['activationSlowDiscovery']);
  });

  it('11 s in Services records activationSlowServices', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openRoot();
    const clock = skewableClock();
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([] as never);
    // ownWrites.onRecorded is wired in the Services phase (activationTelemetry.test.ts throws from it).
    const original = ownWrites.onRecorded.bind(ownWrites);
    vi.spyOn(ownWrites, 'onRecorded').mockImplementation(((...args: Parameters<typeof original>) => { clock.jump(11_000); return original(...args); }) as never);
    const once = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    expect(keys(once)).toContain('activationOver10s');
    expect(keys(once).filter((k) => k.startsWith('activationSlow'))).toEqual(['activationSlowServices']);
  });

  it('a quick activation records no stretch', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openRoot();
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([] as never);
    const once = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    expect(keys(once).filter((k) => k.startsWith('activationSlow') || k === 'activationOver10s')).toEqual([]);
  });
});

describe('#295: the late start suggestion is counted', () => {
  /** A look that never answers the first `stalls` times (cancelled by the timeout), then finds `found`. */
  function lookThatStalls(stalls: number, found: DetectedImportSource[]) {
    let calls = 0;
    return vi.fn((signal: AbortSignal) => {
      calls++;
      if (calls <= stalls) {
        return new Promise<ReadonlySet<DetectedImportSource>>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return Promise.resolve(new Set<DetectedImportSource>(found));
    });
  }

  function trackerWith(look: ReturnType<typeof lookThatStalls>) {
    const published: string[] = [];
    const feature = vi.fn();
    const t = new StartIntentTracker({
      context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
      look,
      publish: (i) => published.push(i),
      feature,
    });
    return { t, published, feature };
  }

  it('a retry after a timeout that turns blank into an import counts startLookLateSuggestion once', async () => {
    vi.useFakeTimers();
    const { t, published, feature } = trackerWith(lookThatStalls(1, ['sqlDdl']));
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await first).toBe('blank');
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(published).toEqual(['blank', 'importSqlDdl']);
    expect(keys(feature)).toEqual(['startLookTimeout', 'startLookLateSuggestion']);
  });

  it('not when the first look answers in time', async () => {
    const { t, published, feature } = trackerWith(lookThatStalls(0, ['sqlDdl']));
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']);
    expect(keys(feature)).toEqual([]);
  });

  it('not when the retry finds nothing to import either', async () => {
    vi.useFakeTimers();
    const { t, published, feature } = trackerWith(lookThatStalls(1, []));
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    await first;
    expect(await t.refresh()).toBe('blank');
    expect(published).toEqual(['blank']);
    expect(keys(feature)).toEqual(['startLookTimeout']);
  });

  it('not when the retry finds nothing and a later look finds a file added since', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let added: DetectedImportSource[] = [];
    let calls = 0;
    const look = vi.fn((signal: AbortSignal) => {
      calls++;
      if (calls === 1) {
        return new Promise<ReadonlySet<DetectedImportSource>>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return Promise.resolve(new Set<DetectedImportSource>(added));
    });
    const published: string[] = [];
    const feature = vi.fn();
    const t = new StartIntentTracker({
      context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
      look,
      publish: (i) => published.push(i),
      feature,
      now: () => clock,
    });
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await first).toBe('blank');
    // The retry answers in time and finds nothing: the first timeout cost nothing.
    expect(await t.refresh()).toBe('blank');
    // Later the user saves a .dbml file, and a refresh past the fresh window looks again.
    added = ['dbml'];
    clock += START_LOOK_FRESH_MS + 1;
    expect(await t.refresh()).toBe('importDbmlFile');
    expect(look).toHaveBeenCalledTimes(3);
    expect(published).toEqual(['blank', 'importDbmlFile']);
    expect(keys(feature)).toEqual(['startLookTimeout']);
  });

  it('the direct imports are the suggestions that count, from the one list startActions keeps', () => {
    expect(START_INTENTS.filter(isDirectImport)).toEqual(['importSemanticModel', 'importSqlDdl', 'importDbmlFile']);
    expect(START_ACTIONS.filter(isDirectImport)).toEqual(['importSemanticModel', 'importSqlDdl', 'importDbmlFile']);
  });

  it('not when the blank came from an unreadable folder state rather than a timeout', async () => {
    let unreadable = true;
    const published: string[] = [];
    const feature = vi.fn();
    const t = new StartIntentTracker({
      context: () => {
        if (unreadable) throw new Error('unreadable');
        return { hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false };
      },
      look: async () => new Set<DetectedImportSource>(['sqlDdl']),
      publish: (i) => published.push(i),
      feature,
    });
    await t.refresh();
    unreadable = false;
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(published).toEqual(['blank', 'importSqlDdl']);
    expect(keys(feature)).toEqual([]);
  });
});

describe('#295: the host search is not waited for when it cannot change the project that opens', () => {
  it('the rule: no projectPath, no pick, and the first dbt workspace folder holds ERD data', () => {
    const withData = dbtAt('with-data', true);
    const bare = dbtAt('bare');
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    expect(hostSearchCannotChangeRoot([withData])).toBe(true);
    // Multi-root: the first folder that is a dbt project decides, wherever it sits.
    expect(hostSearchCannotChangeRoot([plain, withData])).toBe(true);
    expect(hostSearchCannotChangeRoot([bare, withData])).toBe(false);
    // A root dbt project without ERD data: a deeper project holding some would win.
    expect(hostSearchCannotChangeRoot([bare])).toBe(false);
    expect(hostSearchCannotChangeRoot([plain])).toBe(false);
    expect(hostSearchCannotChangeRoot([])).toBe(false);
    // The user's own say goes through the full resolution.
    expect(hostSearchCannotChangeRoot([withData], { projectPath: 'bare' })).toBe(false);
    expect(hostSearchCannotChangeRoot([withData], { projectPath: '  ' })).toBe(true);
    expect(hostSearchCannotChangeRoot([withData], { picked: bare })).toBe(false);
    // A custom semantic dir is where the ERD data is looked for.
    expect(hostSearchCannotChangeRoot([withData], { semanticDir: 'models/erd' })).toBe(false);
  });

  it('skipping never changes the root: whatever deep projects the search adds, the same project opens', () => {
    const top = dbtAt('.', true);
    const deepWithData = dbtAt('a/b/c/d/e/f/g/analytics', true);
    const deepBare = dbtAt('x/y/z/u/v/w/q/staging');
    const nearWithData = dbtAt('near', true);
    for (const folders of [[top], [path.join(root, 'a'), top]]) {
      if (!hostSearchCannotChangeRoot(folders)) continue;
      const skipped = resolveDbtProject(folders, {});
      for (const host of [[deepWithData], [deepBare], [deepWithData, deepBare, nearWithData], []]) {
        expect(resolveDbtProject(folders, { hostCandidates: host }).root, host.join()).toBe(skipped.root);
      }
    }
  });

  it('the counter-case the rule keeps waiting for: a root without ERD data loses to a deep project that has some', () => {
    const top = dbtAt('.');
    const deep = dbtAt('a/b/c/d/e/f/g/analytics', true);
    expect(hostSearchCannotChangeRoot([top])).toBe(false);
    expect(resolveDbtProject([top], { hostCandidates: [deep] }).root).toBe(deep);
  });

  it('withHostCandidates appends the projects the walk missed, once each, and only those still holding dbt_project.yml', () => {
    const top = dbtAt('.', true);
    const deep = dbtAt('a/b/c/d/e/f/g/analytics');
    const gone = path.join(root, 'gone');
    expect(withHostCandidates([top], [top, deep, deep, gone])).toEqual([top, deep]);
    expect(withHostCandidates([top], [])).toEqual([top]);
  });

  it('activation in a dbt project holding ERD data neither waits for a silent search nor records dbtSearchTimedOut; it counts dbtSearchSkipped', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openRoot();
    // The host search never answers (a cold ripgrep on Windows).
    const findFiles = vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => new Promise(() => {})) as never);
    const feature = vi.spyOn(telemetry, 'feature');
    const quiet = vi.spyOn(telemetry, 'featureQuiet');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const started = performance.now();
    await activate(context);
    const ms = performance.now() - started;
    expect(keys(feature)).not.toContain('dbtSearchTimedOut');
    // Counted off the onboarding trail: it describes what activation found.
    expect(keys(quiet)).toContain('dbtSearchSkipped');
    expect(keys(feature)).not.toContain('dbtSearchSkipped');
    expect(ms).toBeLessThan(ACTIVATION_DBT_SEARCH_MS);
    // It still runs, off activation's path, to count the workspace's projects.
    expect(findFiles.mock.calls.filter((c) => c[0] === '**/dbt_project.yml')).toHaveLength(1);
    expect(lastContext(exec, 'erdStudio.hasDbtProject')).toBe(true);
  });

  it('a project only the late search finds reveals Select dbt Project, and the open project stays', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    const deep = dbtAt('a/b/c/d/e/f/g/analytics', true);
    openRoot();
    let answer: (uris: unknown[]) => void = () => {};
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(((include: unknown) =>
      (include === '**/dbt_project.yml'
        ? new Promise((resolve) => { answer = resolve; })
        : Promise.resolve([]))) as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    expect(lastContext(exec, 'erdStudio.hasMultipleDbtProjects')).toBe(false);
    answer([vscode.Uri.file(path.join(root, 'dbt_project.yml')), vscode.Uri.file(path.join(deep, 'dbt_project.yml'))]);
    await vi.waitFor(() => expect(lastContext(exec, 'erdStudio.hasMultipleDbtProjects')).toBe(true));
    expect(lastContext(exec, 'erdStudio.hasDbtProject')).toBe(true);
  });

  it('a late search that fails is still counted (dbtSearchFailed, its #304 reason, and that the walk found the project)', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openRoot();
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(((include: unknown) =>
      (include === '**/dbt_project.yml' ? Promise.reject(new Error('search broke')) : Promise.resolve([]))) as never);
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    await vi.waitFor(() => expect(keys(error)).toContain('dbtSearchFailed'));
    // Exactly one reason beside the total, as #304's contract says.
    expect(keys(error).filter((k) => k.startsWith('dbtSearchFailed'))).toEqual(['dbtSearchFailed', 'dbtSearchFailedRejected']);
    // The window opened the project the walk found, so the failure lost nothing.
    expect(keys(feature).filter((k) => k === 'dbtSearchFailedWalkFound')).toHaveLength(1);
  });

  it('a root dbt project without ERD data still waits, bounded by ACTIVATION_DBT_SEARCH_MS, and records the timeout', async () => {
    dbtAt('.');
    openRoot();
    const findFiles = vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => new Promise(() => {})) as never);
    const feature = vi.spyOn(telemetry, 'feature');
    const quiet = vi.spyOn(telemetry, 'featureQuiet');
    await activate(context);
    expect(findFiles.mock.calls.filter((c) => c[0] === '**/dbt_project.yml')).toHaveLength(1);
    expect(keys(feature)).toContain('dbtSearchTimedOut');
    expect(keys(quiet)).not.toContain('dbtSearchSkipped');
  });
});

describe('#295: facts the rule keeps in mind', () => {
  it('a search that finished in time still reports timeout when the event loop was busy past the deadline', async () => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
    const file = path.join(root, 'dbt_project.yml');
    fs.writeFileSync(file, 'name: p\n');
    // The search answers through I/O (as the host's IPC reply does), within a few ms of real work.
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() =>
      new Promise((resolve) => fs.stat(file, () => resolve([vscode.Uri.file(file)])))) as never);
    const pending = findHostDbtProjects(1000);
    // Another extension's synchronous activation holds the shared host thread for 1.2 s
    // (here from the check phase; the loop then runs timers before it polls the reply).
    setImmediate(() => {
      const until = Date.now() + 1200;
      while (Date.now() < until) { /* busy */ }
    });
    expect(await pending).toEqual({ outcome: 'timeout' });
  });

  it('whether the host search answered decides WHICH project opens when the root holds dbt_project.yml', () => {
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: root\n');
    // A second dbt project, deeper than the walk's six levels, that already holds ERD data.
    const deep = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'analytics');
    fs.mkdirSync(path.join(deep, '.erd-studio'), { recursive: true });
    fs.writeFileSync(path.join(deep, 'dbt_project.yml'), 'name: deep\n');
    const timedOut = resolveDbtProject([root], {});
    const answered = resolveDbtProject([root], { hostCandidates: [root, deep] });
    expect(timedOut.root).toBe(root);
    expect(answered.root).toBe(deep);
    expect(timedOut.candidates).toEqual([root]);
    expect(answered.candidates).toEqual([root, deep]);
  });

  it('an ask that joins the first look when it times out gets blank too (the start prompt then shows nothing this window)', async () => {
    vi.useFakeTimers();
    const look = vi.fn((signal: AbortSignal) => new Promise<ReadonlySet<DetectedImportSource>>((_r, reject) =>
      signal.addEventListener('abort', () => reject(new Error('aborted')))));
    const t = new StartIntentTracker({
      context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
      look,
      publish: () => {},
    });
    const emptyView = t.refresh();
    const startPrompt = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await Promise.all([emptyView, startPrompt])).toEqual(['blank', 'blank']);
    expect(look).toHaveBeenCalledTimes(1);
  });
});
