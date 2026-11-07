/**
 * Run dbt parse (#110, and the 2.0 reliability fixes): dbt is found with the
 * `doctor` candidate list and the venv trust rule, run as its own executable
 * in a pseudoterminal (never an activate line), and its exit is read: a
 * success offers Open Physical view, a failure names its cause and the next
 * step, and Parse without your credentials writes a placeholder profile into
 * ERD Studio's storage only, never reading the user's profiles.yml.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';

import {
  _resetDbtFlowsForTests,
  _resetDbtIdentityCacheForTests,
  claimDbtFlow,
  isDbtFlowStarting,
  releaseDbtFlow,
  type DbtIdentity,
} from '../../src/commands/dbtCandidate';
import type { DbtRunHost } from '../../src/commands/dbtRunHost';
import { _resetDbtRunsForTests, type runDbtInTerminal } from '../../src/commands/dbtTerminal';
import {
  _resetDbtParseLaunchForTests,
  ADAPTER_DOCS_ACTION,
  DBT_BUSY_MESSAGE,
  DBT_CLOUD_CLI_MESSAGE,
  DBT_STARTING_MESSAGE,
  DBT_DOCS_URLS,
  DBT_INSTALL_ACTION,
  DBT_NOT_FOUND_MESSAGE,
  getLastDbtParseLaunchAt,
  NO_CREDS_ACTION,
  NO_CREDS_UNSUPPORTED_MESSAGE,
  NO_PROFILES_MESSAGE,
  OPEN_PHYSICAL_ACTION,
  PARSE_NO_CREDS_OK_MESSAGE,
  PARSE_OK_MESSAGE,
  PARSE_OK_ON_PHYSICAL_MESSAGE,
  PARSE_REFRESH_MESSAGE,
  PROFILE_DOCS_ACTION,
  PROFILE_WRITE_FAILED_MESSAGE,
  REPLACE_MANIFEST_ACTION,
  RUN_DBT_DEPS_ACTION,
  runDbtParse,
  SHOW_OUTPUT_ACTION,
  type DbtParseFs,
  type RunDbtParseDeps,
} from '../../src/commands/runDbtParse';
import { MANIFEST_FAILURE_CODES, manifestFailureCode } from '../../src/extension';
import { throwawayProfileYaml } from '../../src/services/dbtAdapters';
import type { DbtCandidate } from '../../src/services/dbtEnv';
import { LOG_ARGS, THROWAWAY_MARKER_ENV, type DbtCommandKind, type DbtRunMode, type DbtSpawnPlan } from '../../src/services/dbtLaunch';
import type { DbtProcessResult } from '../../src/services/dbtProcess';
import { defaultDbtProjectConfig } from '../../src/services/dbtProjectConfig';
import { log } from '../../src/services/logger';
import { manifestAppearanceFeature } from '../../src/services/manifestMissingReasons';
import { telemetry } from '../../src/services/telemetryService';
import { GETTING_STARTED_EXTERNAL_URLS } from '../../src/types/gettingStarted';
import { DBT_FAILURE_OUTPUTS as OUT } from './dbtOutputFixtures';

const onPath: DbtCandidate = { executable: '/usr/local/bin/dbt', source: 'path' };
const CORE: DbtIdentity = { flavour: 'core-v1', adapters: ['duckdb'], via: 'stat' };
const SENTINEL = 'SENTINEL_OUTPUT_9f2c';

let root: string;
let home: string;
let storage: string;
let reads: string[];

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-dbt-parse-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-dbt-home-')));
  storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-dbt-storage-')));
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: proj\nprofile: proj\n');
  // A profiles.yml dbt would find (its content is never read).
  fs.mkdirSync(path.join(home, '.dbt'));
  fs.writeFileSync(path.join(home, '.dbt', 'profiles.yml'), `proj: ${SENTINEL}\n`);
  reads = [];
  vscode.window.terminals.length = 0;
  _resetDbtRunsForTests();
  _resetDbtFlowsForTests();
  _resetDbtIdentityCacheForTests();
  _resetDbtParseLaunchForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of [root, home, storage]) fs.rmSync(d, { recursive: true, force: true });
});

interface RunCall { kind: DbtCommandKind; mode: DbtRunMode; plan: DbtSpawnPlan; finish: (r?: Partial<DbtProcessResult>) => void }

function fakeRun(): { run: typeof runDbtInTerminal; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = ((_root: string, kind: DbtCommandKind, mode: DbtRunMode, plan: DbtSpawnPlan) => {
    let resolve!: (r: DbtProcessResult) => void;
    const result = new Promise<DbtProcessResult>((r) => { resolve = r; });
    calls.push({ kind, mode, plan, finish: (r = {}) => resolve({ outcome: 'exited', exitCode: 0, tail: '', durationMs: 1, ...r }) });
    return { kind: 'started', run: { terminal: {} as vscode.Terminal, result } };
  }) as unknown as typeof runDbtInTerminal;
  return { run, calls };
}

function fakeHost(over: Partial<DbtRunHost> = {}): DbtRunHost & { opened: vscode.Uri[] } {
  const opened: vscode.Uri[] = [];
  return {
    storageDir: storage,
    dbtConfig: () => defaultDbtProjectConfig(),
    physicalTarget: (origin) => origin,
    originIsPhysical: () => false,
    openPhysical: async (uri) => { opened.push(uri); return true; },
    opened,
    ...over,
  };
}

/** The real file system, with every read recorded. */
function recordingFs(over: Partial<DbtParseFs> = {}): Partial<DbtParseFs> {
  return {
    readTextStart: async (p, chars) => { reads.push(p); const { readTextStart } = await import('../../src/services/readFileStart'); return readTextStart(p, chars); },
    readFileSync: (p, enc) => { reads.push(p); return fs.readFileSync(p, enc); },
    readdirSync: (p) => { reads.push(p); return fs.readdirSync(p); },
    ...over,
  };
}

function deps(over: RunDbtParseDeps = {}): RunDbtParseDeps & { calls: RunCall[] } {
  const r = fakeRun();
  return {
    candidates: () => [onPath],
    isTrusted: () => true,
    identify: async () => CORE,
    run: r.run,
    host: fakeHost(),
    env: { PATH: '/usr/bin' },
    homeDir: home,
    platform: 'darwin',
    fs: recordingFs(),
    ...over,
    calls: r.calls,
  } as RunDbtParseDeps & { calls: RunCall[] };
}

/** Answer each notification with `answers[message prefix]`, recording every one. */
function answer(answers: Record<string, string | undefined> = {}) {
  const shown: Array<{ kind: string; message: string; items: unknown[] }> = [];
  const respond = (kind: string) => (async (message: string, ...items: unknown[]) => {
    shown.push({ kind, message, items });
    const key = Object.keys(answers).find((k) => message.startsWith(k));
    return key ? answers[key] : undefined;
  }) as never;
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(respond('info'));
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(respond('warning'));
  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(respond('error'));
  return shown;
}

/** Each write gets a later modification time, as a real dbt run (seconds long) would. */
let manifestWrites = 0;
const writeManifest = (marker = false, adapterType = 'duckdb') => {
  fs.mkdirSync(path.join(root, 'target'), { recursive: true });
  const file = path.join(root, 'target', 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({
    metadata: { adapter_type: adapterType, env: marker ? { ERD_STUDIO_THROWAWAY_PROFILE: '1' } : {} }, nodes: {},
  }));
  const t = new Date(Date.UTC(2026, 0, 1) + (++manifestWrites) * 1000);
  fs.utimesSync(file, t, t);
};

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

describe('runDbtParse: before the run', () => {
  it('always records the click', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer();
    await runDbtParse(root, {}, deps({ candidates: () => [] }));
    expect(feature).toHaveBeenCalledWith('dbtParse');
  });

  it('no dbt: dbtParseNoDbt and the install docs', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ [DBT_NOT_FOUND_MESSAGE]: DBT_INSTALL_ACTION });
    const open = vi.spyOn(vscode.env, 'openExternal');
    const d = deps({ candidates: () => [] });
    const start = await runDbtParse(root, {}, d);
    expect(start.started).toBe(false);
    expect(feature).toHaveBeenCalledWith('dbtParseNoDbt');
    expect(shown[0]).toMatchObject({ message: DBT_NOT_FOUND_MESSAGE, items: [DBT_INSTALL_ACTION] });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    expect(String(open.mock.calls[0][0])).toContain(new URL(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs).host);
    expect(d.calls).toHaveLength(0);
  });

  it('the not-found message never tells the user to activate an environment (the runner cannot see one)', () => {
    expect(DBT_NOT_FOUND_MESSAGE).not.toMatch(/activate/i);
    expect(DBT_NOT_FOUND_MESSAGE).toContain('restart VS Code');
  });

  it('an unanswered notice never holds the project: a later click runs (dbt not found, the Cloud CLI, no profiles.yml)', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    // Every non-modal notice stays pending, as one waiting in the notification centre does.
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((() => new Promise(() => {})) as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((() => new Promise(() => {})) as never);

    const noDbt = await runDbtParse(root, {}, deps({ candidates: () => [] }));
    expect(noDbt.started).toBe(false);
    const d = deps();
    expect((await runDbtParse(root, {}, d)).started).toBe(true);
    expect(feature).not.toHaveBeenCalledWith('dbtParseBusy');
    d.calls[0].finish({ outcome: 'stopped', exitCode: null });
    _resetDbtRunsForTests();

    const cloud = await runDbtParse(root, {}, deps({ identify: async () => ({ flavour: 'cloud-cli', adapters: [], via: 'version' }) }));
    expect(cloud.started).toBe(false);
    expect(feature).toHaveBeenCalledWith('dbtParseCloudCli');
    const d2 = deps();
    expect((await runDbtParse(root, {}, d2)).started).toBe(true);
    expect(feature).not.toHaveBeenCalledWith('dbtParseBusy');
    _resetDbtRunsForTests();

    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    void runDbtParse(root, {}, deps()); // M2 waits, unanswered
    await vi.waitFor(() => expect(feature).toHaveBeenCalledWith('dbtParseNoProfiles'));
    fs.mkdirSync(path.join(home, '.dbt'));
    fs.writeFileSync(path.join(home, '.dbt', 'profiles.yml'), `proj: ${SENTINEL}\n`);
    const d3 = deps();
    expect((await runDbtParse(root, {}, d3)).started).toBe(true);
    expect(d3.calls[0].mode).toBe('normal');
    expect(feature).not.toHaveBeenCalledWith('dbtParseBusy');
  });

  it('M2 answered after another click started dbt: busy, not a second run', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    const feature = vi.spyOn(telemetry, 'feature');
    let answerM2!: (v: unknown) => void;
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(((message: string) =>
      (message === NO_PROFILES_MESSAGE ? new Promise((r) => { answerM2 = r; }) : Promise.resolve(undefined))) as never);
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const shared = fakeRun();
    const first = runDbtParse(root, {}, deps({ run: shared.run }));
    await vi.waitFor(() => expect(answerM2).toBeDefined());
    // A second click meanwhile is not blocked: it reaches M2 too and is answered there.
    const firstAnswer = answerM2;
    const second = runDbtParse(root, {}, deps({ run: shared.run }));
    await vi.waitFor(() => expect(answerM2).not.toBe(firstAnswer));
    answerM2(NO_CREDS_ACTION);
    expect((await second).started).toBe(true);
    expect(shared.calls).toHaveLength(1);
    expect(shared.calls[0].mode).toBe('noCreds');
    // The first notice answered while another flow holds the project: its follow-up re-checks and is busy.
    const held = claimDbtFlow(root);
    firstAnswer(NO_CREDS_ACTION);
    expect((await first).started).toBe(false);
    expect(feature).toHaveBeenCalledWith('dbtParseBusy');
    expect(shared.calls).toHaveLength(1);
    // The first click's own release (its finally) left the other flow's claim alone.
    expect(isDbtFlowStarting(root)).toBe(true);
    releaseDbtFlow(held);
  });

  it('asks before a project venv dbt; dismissing records dbtParseVenvDeclined and runs nothing', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const identify = vi.fn(async () => CORE);
    const d = deps({ candidates: () => [{ executable: `${root}/.venv/bin/dbt`, source: 'venv' }, onPath], identify });
    await runDbtParse(root, {}, d);
    expect(shown[0].message).toBe('Run dbt parse with the dbt inside this project?');
    expect((shown[0].items[0] as { modal: boolean; detail: string }).modal).toBe(true);
    expect((shown[0].items[0] as { detail: string }).detail).toContain('.venv/bin/dbt');
    expect(feature).toHaveBeenCalledWith('dbtParseVenvDeclined');
    // The trust modal comes before identify: an unvetted venv is never probed.
    expect(identify).not.toHaveBeenCalled();
    expect(d.calls).toHaveLength(0);
  });

  it('uses the venv\'s own dbt once the user agrees, or the other one', async () => {
    const venv: DbtCandidate = { executable: `${root}/.venv/bin/dbt`, source: 'venv' };
    answer({ 'Run dbt parse with the dbt inside this project?': 'Use the project\'s dbt' });
    const d = deps({ candidates: () => [venv, onPath] });
    await runDbtParse(root, {}, d);
    expect(d.calls[0].plan.file).toBe(venv.executable);
    expect(d.calls[0].plan.args).toEqual(['parse', ...LOG_ARGS]);
    _resetDbtFlowsForTests();
    vi.restoreAllMocks();
    answer({ 'Run dbt parse with the dbt inside this project?': 'Use my dbt' });
    const d2 = deps({ candidates: () => [venv, onPath] });
    await runDbtParse(root, {}, d2);
    expect(d2.calls[0].plan.file).toBe(onPath.executable);
  });

  it('an untrusted workspace never uses the project venv', async () => {
    const shown = answer();
    const d = deps({ candidates: () => [{ executable: `${root}/.venv/bin/dbt`, source: 'venv' }, onPath], isTrusted: () => false });
    await runDbtParse(root, {}, d);
    expect(shown).toHaveLength(0);
    expect(d.calls[0].plan.file).toBe(onPath.executable);
  });

  it('skips a dbt Cloud CLI for a later dbt Core; only the Cloud CLI gives dbtParseCloudCli', async () => {
    const cloud: DbtCandidate = { executable: '/opt/homebrew/bin/dbt', source: 'path' };
    const core: DbtCandidate = { executable: '/home/u/.local/bin/dbt', source: 'shim' };
    const identify = async (c: DbtCandidate): Promise<DbtIdentity> =>
      (c === cloud ? { flavour: 'cloud-cli', adapters: [], via: 'version' } : CORE);
    answer();
    const d = deps({ candidates: () => [cloud, core], identify });
    await runDbtParse(root, {}, d);
    expect(d.calls[0].plan.file).toBe(core.executable);

    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d2 = deps({ candidates: () => [cloud], identify });
    await runDbtParse(root, {}, d2);
    expect(d2.calls).toHaveLength(0);
    expect(feature).toHaveBeenCalledWith('dbtParseCloudCli');
    expect(shown.at(-1)?.message).toBe(DBT_CLOUD_CLI_MESSAGE);
  });

  it('a second click while the first waits at the trust modal is busy, with no second modal', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    let release!: (v: unknown) => void;
    const modal = vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation((() => new Promise((r) => { release = r; })) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const d = deps({ candidates: () => [{ executable: `${root}/.venv/bin/dbt`, source: 'venv' }] });
    const first = runDbtParse(root, {}, d);
    await vi.waitFor(() => expect(modal).toHaveBeenCalledTimes(1));
    await runDbtParse(root, {}, d);
    expect(modal).toHaveBeenCalledTimes(1);
    expect(feature).toHaveBeenCalledWith('dbtParseBusy');
    // No dbt process and no terminal yet: the notice doesn't point at one.
    expect(info).toHaveBeenCalledWith(DBT_STARTING_MESSAGE);
    expect(info).not.toHaveBeenCalledWith(DBT_BUSY_MESSAGE);
    release(undefined);
    await first;
  });

  it('a second click while the adapter list is open says ERD Studio is starting dbt, not that a terminal shows it', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    const feature = vi.spyOn(telemetry, 'feature');
    let pickAdapter!: (v: unknown) => void;
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((() => new Promise((r) => { pickAdapter = r; })) as never);
    const shown = answer({ [NO_PROFILES_MESSAGE]: NO_CREDS_ACTION });
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['duckdb', 'postgres'], via: 'stat' }) });
    const first = runDbtParse(root, {}, d);
    await vi.waitFor(() => expect(quickPick).toHaveBeenCalledTimes(1));
    await runDbtParse(root, {}, d);
    expect(feature).toHaveBeenCalledWith('dbtParseBusy');
    expect(shown.at(-1)?.message).toBe(DBT_STARTING_MESSAGE);
    pickAdapter(undefined);
    await first;
  });

  it('busy when the terminal runner says a run is going', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const run = (() => ({ kind: 'busy', terminal: undefined })) as unknown as typeof runDbtInTerminal;
    const start = await runDbtParse(root, {}, deps({ run }));
    expect(start.started).toBe(false);
    expect(feature).toHaveBeenCalledWith('dbtParseBusy');
    expect(feature).not.toHaveBeenCalledWith('dbtParseLaunched');
    expect(shown.at(-1)?.message).toBe(DBT_BUSY_MESSAGE);
  });
});

describe('runDbtParse: the run and its success', () => {
  it('launch records dbtParseLaunched and the timestamp; dbtParseRefresh only with a manifest already there', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer();
    const before = Date.now();
    const d = deps();
    const start = await runDbtParse(root, {}, d);
    expect(start.started).toBe(true);
    expect(feature).toHaveBeenCalledWith('dbtParseLaunched');
    expect(feature).not.toHaveBeenCalledWith('dbtParseRefresh');
    expect(getLastDbtParseLaunchAt()).toBeGreaterThanOrEqual(before);
    // The watcher's manifestAfterParse still works with the new timestamp.
    expect(manifestAppearanceFeature(true, true, getLastDbtParseLaunchAt(), Date.now())).toBe('manifestAfterParse');

    writeManifest();
    _resetDbtFlowsForTests();
    await runDbtParse(root, {}, deps());
    expect(feature).toHaveBeenCalledWith('dbtParseRefresh');
  });

  it('the Windows venv plan runs Scripts\\dbt.exe directly', async () => {
    answer({ 'Run dbt parse with the dbt inside this project?': 'Use the project\'s dbt' });
    const d = deps({ candidates: () => [{ executable: 'C:\\proj\\.venv\\Scripts\\dbt.exe', source: 'venv' }], platform: 'win32', env: { Path: 'C:\\Windows' } });
    await runDbtParse(root, {}, d);
    expect(d.calls[0].plan).toMatchObject({ file: 'C:\\proj\\.venv\\Scripts\\dbt.exe', args: ['parse', ...LOG_ARGS], shell: false });
    expect(d.calls[0].plan.args).not.toContain('&&');
  });

  it('exit 0 with a new manifest: S1 with Open Physical view, which switches the canvas that asked', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ [PARSE_OK_MESSAGE]: OPEN_PHYSICAL_ACTION });
    const host = fakeHost();
    const origin = vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'a.dbml'));
    const d = deps({ host });
    const start = await runDbtParse(root, { origin }, d);
    writeManifest();
    d.calls[0].finish({ exitCode: 0 });
    await start.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseExitOk');
    expect(shown.at(-1)).toMatchObject({ message: PARSE_OK_MESSAGE, items: [OPEN_PHYSICAL_ACTION] });
    expect(host.opened.map(String)).toEqual([String(origin)]);
    expect(feature).toHaveBeenCalledWith('dbtParseOpenPhysical');
  });

  it('Open Physical view that switched no canvas (the diagram closed and could not reopen) is not counted', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ [PARSE_OK_MESSAGE]: OPEN_PHYSICAL_ACTION });
    const asked: vscode.Uri[] = [];
    const host = fakeHost({ openPhysical: async (uri) => { asked.push(uri); return false; } });
    const origin = vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'a.dbml'));
    const d = deps({ host });
    const start = await runDbtParse(root, { origin }, d);
    writeManifest();
    d.calls[0].finish({ exitCode: 0 });
    await start.settled;
    expect(asked.map(String)).toEqual([String(origin)]);
    expect(feature).not.toHaveBeenCalledWith('dbtParseOpenPhysical');
  });

  it('no Open Physical view without a logical canvas; S1p on Physical; S2 on a refresh', async () => {
    const shown = answer();
    const d = deps({ host: fakeHost({ physicalTarget: () => undefined }) });
    const s = await runDbtParse(root, {}, d);
    writeManifest();
    d.calls[0].finish();
    await s.settled;
    expect(shown.at(-1)).toMatchObject({ message: PARSE_OK_MESSAGE, items: [] });

    _resetDbtFlowsForTests();
    fs.rmSync(path.join(root, 'target'), { recursive: true });
    const d2 = deps({ host: fakeHost({ originIsPhysical: () => true, physicalTarget: () => undefined }) });
    const s2 = await runDbtParse(root, {}, d2);
    writeManifest();
    d2.calls[0].finish();
    await s2.settled;
    expect(shown.at(-1)?.message).toBe(PARSE_OK_ON_PHYSICAL_MESSAGE);

    _resetDbtFlowsForTests();
    const d3 = deps();
    const s3 = await runDbtParse(root, { origin: vscode.Uri.file(path.join(root, 'd.dbml')) }, d3);
    writeManifest();
    d3.calls[0].finish();
    await s3.settled;
    expect(shown.at(-1)).toMatchObject({ message: PARSE_REFRESH_MESSAGE, items: [OPEN_PHYSICAL_ACTION] });
  });

  it('exit 0 that leaves an existing manifest unchanged is not a refresh: dbtParseOkNoManifest (M4)', async () => {
    writeManifest();
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, { origin: vscode.Uri.file(path.join(root, 'd.dbml')) }, d);
    expect(feature).toHaveBeenCalledWith('dbtParseRefresh');
    d.calls[0].finish({ exitCode: 0 }); // dbt wrote somewhere else
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseExitOk');
    expect(feature).toHaveBeenCalledWith('dbtParseOkNoManifest');
    expect(shown.some((m) => m.message === PARSE_REFRESH_MESSAGE)).toBe(false);
    expect(shown.at(-1)?.message).toMatch(/^dbt parse finished, but there's no manifest at target\/manifest\.json\./);
  });

  it('exit 0 with no manifest: dbtParseOkNoManifest', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 0 });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseOkNoManifest');
    expect(shown.at(-1)?.message).toMatch(/^dbt parse finished, but there's no manifest at target\/manifest\.json\. .*DBT_TARGET_PATH/);
    expect(shown.at(-1)?.items).toEqual([SHOW_OUTPUT_ACTION]);
  });

  it('stopped and not started', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ outcome: 'stopped', exitCode: null });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseStopped');

    _resetDbtFlowsForTests();
    const d2 = deps();
    const s2 = await runDbtParse(root, {}, d2);
    d2.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    await s2.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseNoStart');
    expect(shown.at(-1)).toMatchObject({ kind: 'error', message: 'ERD Studio couldn\'t start /usr/local/bin/dbt (ENOENT).' });
  });

  it('a signal (no exit code) is a failure', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: null, tail: '' });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseExitFail');
    expect(feature).toHaveBeenCalledWith('dbtParseFailOther');
    expect(shown.at(-1)?.message).toBe('dbt parse ended without an exit code.');
  });
});

describe('runDbtParse: failures and Parse without your credentials', () => {
  it('a profile failure offers Parse without your credentials, which writes only into ERD Studio\'s storage', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const before = walk(root);
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(feature).toHaveBeenCalledWith('dbtParseExitFail');
    expect(feature).toHaveBeenCalledWith('dbtParseFailProfile');
    expect(feature).toHaveBeenCalledWith('dbtParseNoCreds');
    expect(feature).toHaveBeenCalledWith('dbtNoCredsDuckdb');

    const dir = path.join(storage, 'dbt-parse-profile', 'duckdb');
    expect(fs.readFileSync(path.join(dir, 'profiles.yml'), 'utf8')).toBe(throwawayProfileYaml('duckdb'));
    expect(fs.readdirSync(dir)).toEqual(['profiles.yml']); // the tmp file was renamed
    expect(walk(root)).toEqual(before);
    const noCreds = d.calls[1];
    expect(noCreds.mode).toBe('noCreds');
    expect(noCreds.plan.args).toEqual(['parse', '--profiles-dir', dir, '--profile', 'erd_studio', '--target', 'erd_studio', ...LOG_ARGS]);
    expect(noCreds.plan.env[THROWAWAY_MARKER_ENV]).toBe('1');
    expect(noCreds.plan.env.DBT_SEND_ANONYMOUS_USAGE_STATS).toBe('false');

    writeManifest(true);
    noCreds.finish({ exitCode: 0 });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseNoCredsOk');
    expect(shown.at(-1)?.message).toBe(PARSE_NO_CREDS_OK_MESSAGE);
    expect(parseYaml(fs.readFileSync(path.join(dir, 'profiles.yml'), 'utf8')).erd_studio.target).toBe('erd_studio');
  });

  it('no profiles.yml anywhere with dbt Core: M2 before any run', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    const feature = vi.spyOn(telemetry, 'feature');
    const d = deps();
    let callsAtPrompt = -1;
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string) => {
      if (message === NO_PROFILES_MESSAGE) { callsAtPrompt = d.calls.length; return NO_CREDS_ACTION; }
      return undefined;
    }) as never);
    await runDbtParse(root, {}, d);
    expect(feature).toHaveBeenCalledWith('dbtParseNoProfiles');
    expect(callsAtPrompt).toBe(0);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0].mode).toBe('noCreds');
  });

  it('no profiles.yml with an unknown dbt: a normal run (dbt\'s own error is classified)', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    const feature = vi.spyOn(telemetry, 'feature');
    answer();
    const d = deps({ identify: async () => ({ flavour: 'unknown', adapters: [], via: 'version' }) });
    await runDbtParse(root, {}, d);
    expect(feature).not.toHaveBeenCalledWith('dbtParseNoProfiles');
    expect(d.calls[0].mode).toBe('normal');
  });

  it('missing packages: Run dbt deps, then parse again', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ 'This project uses dbt packages': RUN_DBT_DEPS_ACTION });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.G_packages });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(feature).toHaveBeenCalledWith('dbtParseFailDeps');
    expect(feature).toHaveBeenCalledWith('dbtParseDeps');
    expect(d.calls[1].kind).toBe('deps');
    expect(d.calls[1].plan.args).toEqual(['deps', ...LOG_ARGS]);
    d.calls[1].finish({ exitCode: 0 });
    await vi.waitFor(() => expect(d.calls).toHaveLength(3));
    expect(feature).toHaveBeenCalledWith('dbtDepsExitOk');
    expect(d.calls[2]).toMatchObject({ kind: 'parse', mode: 'normal' });
    writeManifest();
    d.calls[2].finish({ exitCode: 0 });
    await s.settled;
  });

  it('dbt deps failing says so', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ 'This project uses dbt packages': RUN_DBT_DEPS_ACTION });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.G_packages });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    d.calls[1].finish({ exitCode: 1 });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtDepsExitFail');
    expect(shown.at(-1)?.message).toMatch(/^dbt deps failed\./);
  });

  it('a missing adapter links the adapter docs', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ 'dbt can\'t load the snowflake adapter': ADAPTER_DOCS_ACTION });
    const open = vi.spyOn(vscode.env, 'openExternal');
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.F_adapter });
    await s.settled;
    expect(shown.at(-1)?.items).toEqual([ADAPTER_DOCS_ACTION, SHOW_OUTPUT_ACTION]);
    expect(String(open.mock.calls[0][0])).toBe(String(vscode.Uri.parse(DBT_DOCS_URLS.adapters)));
    expect(feature).toHaveBeenCalledWith('dbtParseAdapterDocs');
  });

  it('an env var the project file uses offers no Parse without your credentials', async () => {
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: proj\nprofile: "{{ env_var(\'ERD_PROTO_PROFILE\') }}"\n');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.E2_envproject });
    await s.settled;
    expect(shown.at(-1)?.message).toContain('ERD_PROTO_PROFILE');
    expect(shown.at(-1)?.items).toEqual([SHOW_OUTPUT_ACTION]);
  });

  it('an env var a model file uses (dbt failed after loading the profile) offers no Parse without your credentials', async () => {
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.E3_envmodel });
    await s.settled;
    expect(shown.at(-1)?.message).toBe(
      'dbt needs the environment variable ERD_MODEL_VAR, which your project\'s files use. Set it where VS Code starts, restart VS Code, and try Run dbt parse again.',
    );
    expect(shown.at(-1)?.items).toEqual([SHOW_OUTPUT_ACTION]);
  });

  it.each(['packages.yml', 'dependencies.yml'])('an env var %s uses (a private package token) offers no Parse without your credentials', async (file) => {
    // dbt renders packages.yml before it loads the profile, so a placeholder profile fails the same way.
    fs.writeFileSync(path.join(root, file), 'packages:\n  - git: "https://{{ env_var(\'DBT_ENV_SECRET_GIT_TOKEN\') }}@github.com/acme/macros.git"\n');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.D_envprofiles.replace('ERD_PROTO_DUCKDB_PATH', 'DBT_ENV_SECRET_GIT_TOKEN') });
    await s.settled;
    expect(shown.at(-1)?.message).toBe(
      'dbt needs the environment variable DBT_ENV_SECRET_GIT_TOKEN, which your project\'s files use. Set it where VS Code starts, restart VS Code, and try Run dbt parse again.',
    );
    expect(shown.at(-1)?.items).toEqual([SHOW_OUTPUT_ACTION]);
    expect(shown.at(-1)?.items).not.toContain(NO_CREDS_ACTION);
  });

  it.each([['L_profilesyaml'], ['F2_notype']] as const)('a profiles.yml dbt found but could not read (%s) is not called missing', async (key) => {
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT[key] });
    await s.settled;
    expect(shown.at(-1)).toMatchObject({
      message: 'dbt couldn\'t read your dbt profile (profiles.yml). The output shows the line.',
      items: [NO_CREDS_ACTION, SHOW_OUTPUT_ACTION],
    });
  });

  it('a profile without `schema` is a credentials failure and offers Parse without your credentials', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.min_databricks_schema });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseFailCredentials');
    expect(shown.at(-1)).toMatchObject({ message: 'dbt rejected the connection details in your dbt profile.', items: [NO_CREDS_ACTION, SHOW_OUTPUT_ACTION] });
  });

  it('a manifest written with the user\'s profile asks before it is replaced; declining writes nothing', async () => {
    writeManifest(false);
    const shown = answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    const modal = shown.find((m) => m.message === 'Replace target/manifest.json?');
    expect(modal).toBeDefined();
    expect((modal!.items[0] as { modal: boolean }).modal).toBe(true);
    expect(modal!.items[1]).toBe(REPLACE_MANIFEST_ACTION);
    expect(d.calls).toHaveLength(1);
    expect(fs.existsSync(path.join(storage, 'dbt-parse-profile'))).toBe(false);
  });

  it('a placeholder manifest is replaced without asking', async () => {
    writeManifest(true);
    const shown = answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const d = deps();
    void await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(shown.some((m) => m.message.startsWith('Replace'))).toBe(false);
  });

  it('asks which adapter when it cannot tell, and a cancel runs nothing', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['snowflake', 'bigquery'], via: 'stat' }) });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseNoCredsAsked');
    const items = (pick.mock.calls[0][0] as unknown as Array<{ label: string; description: string }>);
    expect(items.map((i) => i.label)).toEqual(['BigQuery', 'Snowflake']);
    expect(items[0].description).toBe('dbt-bigquery');
    expect(d.calls).toHaveLength(1);
  });

  it('a requirements file picks the adapter without asking', async () => {
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'dbt-core\ndbt-snowflake==1.9\n');
    answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['snowflake', 'bigquery'], via: 'stat' }) });
    void await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(pick).not.toHaveBeenCalled();
    expect(d.calls[1].plan.args[2]).toBe(path.join(storage, 'dbt-parse-profile', 'snowflake'));
  });

  it('no supported adapter: Parse without your credentials is never offered (it would end at M5)', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['oracle'], via: 'stat' }) });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    expect(shown.at(-1)?.message).toMatch(/^dbt parse needs a dbt profile/);
    expect(shown.at(-1)?.items).toEqual([PROFILE_DOCS_ACTION, SHOW_OUTPUT_ACTION]);
    expect(feature).not.toHaveBeenCalledWith('dbtParseNoCredsUnsupported');
    expect(shown.some((m) => m.message === NO_CREDS_UNSUPPORTED_MESSAGE)).toBe(false);
  });

  it('no supported adapter and no profiles.yml: a normal run, not M2 (synapse drops its implied fabric)', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['synapse', 'fabric'], via: 'stat' }) });
    await runDbtParse(root, {}, d);
    expect(feature).not.toHaveBeenCalledWith('dbtParseNoProfiles');
    expect(shown.some((m) => m.message === NO_PROFILES_MESSAGE)).toBe(false);
    expect(d.calls[0].mode).toBe('normal');
  });

  it('a requirements file naming the implied adapter alone keeps Parse without your credentials available', async () => {
    fs.rmSync(path.join(home, '.dbt'), { recursive: true });
    fs.writeFileSync(path.join(root, 'requirements.txt'), 'dbt-fabric\n');
    const feature = vi.spyOn(telemetry, 'feature');
    answer();
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['synapse', 'fabric'], via: 'stat' }) });
    await runDbtParse(root, {}, d);
    expect(feature).toHaveBeenCalledWith('dbtParseNoProfiles');
  });

  it('a placeholder manifest\'s adapter is not reused as the hint: the picker shows again', async () => {
    writeManifest(true, 'duckdb');
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined as never);
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['duckdb', 'snowflake'], via: 'stat' }) });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    expect(feature).toHaveBeenCalledWith('dbtParseNoCredsAsked');
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('a manifest written with the user\'s own profile still decides the adapter', async () => {
    writeManifest(false, 'snowflake');
    answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION, 'Replace': REPLACE_MANIFEST_ACTION });
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const d = deps({ identify: async () => ({ flavour: 'core-v1', adapters: ['duckdb', 'snowflake'], via: 'stat' }) });
    void await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(pick).not.toHaveBeenCalled();
    expect(d.calls[1].plan.args[2]).toBe(path.join(storage, 'dbt-parse-profile', 'snowflake'));
  });

  it('a profile write failure is dbtProfileWriteFailed, logged by code only', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const warn = vi.spyOn(log, 'warn');
    const shown = answer({ 'dbt parse needs a dbt profile': NO_CREDS_ACTION });
    const d = deps({ fs: recordingFs({ writeFileSync: () => { throw Object.assign(new Error(`EACCES ${storage}`), { code: 'EACCES' }); } }) });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    expect(error).toHaveBeenCalledWith('dbtProfileWriteFailed');
    expect(shown.at(-1)).toMatchObject({ kind: 'error', message: PROFILE_WRITE_FAILED_MESSAGE });
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(storage);
    expect(d.calls).toHaveLength(1);
  });

  it('our own follow-up throwing is dbtRunFailed (name only), and settled still resolves', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const warn = vi.spyOn(log, 'warn');
    answer();
    const host = fakeHost({ physicalTarget: () => { throw new TypeError(`boom ${SENTINEL}`); } });
    const d = deps({ host });
    const s = await runDbtParse(root, {}, d);
    writeManifest();
    d.calls[0].finish({ exitCode: 0 });
    await expect(s.settled).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('dbtRunFailed');
    expect(warn).toHaveBeenCalledWith('[dbt] follow-up failed: TypeError');
    for (const call of warn.mock.calls) expect(JSON.stringify(call)).not.toContain(SENTINEL);
  });

  it('a result that rejects is dbtRunFailed too', async () => {
    const error = vi.spyOn(telemetry, 'error');
    answer();
    const run = (() => ({ kind: 'started', run: { terminal: {}, result: Promise.reject(new Error('x')) } })) as unknown as typeof runDbtInTerminal;
    const s = await runDbtParse(root, {}, deps({ run }));
    await expect(s.settled).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('dbtRunFailed');
  });
});

describe('runDbtParse: privacy', () => {
  it('never reads a profiles.yml, and dbt\'s output, the env var, paths and start errors never reach telemetry or the log', async () => {
    fs.mkdirSync(path.join(root, 'requirements'));
    fs.writeFileSync(path.join(root, 'requirements', 'base.txt'), 'dbt-duckdb\n');
    fs.writeFileSync(path.join(root, 'profiles.yml'), `proj: ${SENTINEL}\n`);
    const feature = vi.spyOn(telemetry, 'feature');
    const error = vi.spyOn(telemetry, 'error');
    const logs = [vi.spyOn(log, 'info'), vi.spyOn(log, 'warn'), vi.spyOn(log, 'error')];
    answer({ 'dbt needs the environment variable': NO_CREDS_ACTION });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: `${SENTINEL}\n${OUT.D_envprofiles}` });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    d.calls[1].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT', tail: SENTINEL });
    await s.settled;

    expect(reads.length).toBeGreaterThan(0);
    for (const p of reads) expect(path.basename(p).toLowerCase()).not.toBe('profiles.yml');
    const sent = JSON.stringify([...feature.mock.calls, ...error.mock.calls, ...logs.flatMap((l) => l.mock.calls)]);
    for (const secret of [SENTINEL, 'ERD_PROTO_DUCKDB_PATH', storage, root, 'ENOENT']) {
      expect(sent, secret).not.toContain(secret);
    }
  });
});

describe('manifest telemetry (#110)', () => {
  it('a missing manifest is not recorded as an error', () => {
    expect(manifestFailureCode('missing')).toBeNull();
    expect('missing' in MANIFEST_FAILURE_CODES).toBe(false);
  });

  it('malformed and timed-out manifests still are', () => {
    expect(manifestFailureCode('malformed')).toBe('manifestMalformed');
    expect(manifestFailureCode('timeout')).toBe('manifestTimeout');
  });
});

describe('Run dbt parse launch timestamp (#113)', () => {
  it('is not recorded when no dbt is found', async () => {
    answer();
    await runDbtParse(root, {}, deps({ candidates: () => [] }));
    expect(getLastDbtParseLaunchAt()).toBeUndefined();
  });

  it('is not recorded when the venv prompt is dismissed', async () => {
    answer();
    await runDbtParse(root, {}, deps({ candidates: () => [{ executable: `${root}/.venv/bin/dbt`, source: 'venv' }] }));
    expect(getLastDbtParseLaunchAt()).toBeUndefined();
  });
});
