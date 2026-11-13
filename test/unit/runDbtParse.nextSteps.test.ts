/**
 * #296: three Run dbt parse failures say whose problem it is and what to do
 * next. The words are `dbtRunMessages.ts`'s (pinned in its own test); these
 * tests pin the wiring: each failure shows its notice with the right
 * buttons, and each button does what it says, from the real flow.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  _resetDbtFlowsForTests,
  _resetDbtIdentityCacheForTests,
  isDbtFlowStarting,
  type DbtIdentity,
} from '../../src/commands/dbtCandidate';
import type { DbtRunHost } from '../../src/commands/dbtRunHost';
import { _resetDbtRunsForTests, type runDbtInTerminal } from '../../src/commands/dbtTerminal';
import {
  _resetDbtParseLaunchForTests,
  DBT_INSTALL_ACTION,
  NO_CREDS_ACTION,
  PROFILE_DOCS_ACTION,
  REPLACE_MANIFEST_ACTION,
  runDbtParse,
  SHOW_OUTPUT_ACTION,
  showCouldNotStart,
  type DbtParseFs,
  type RunDbtParseDeps,
} from '../../src/commands/runDbtParse';
import { SEND_FEEDBACK_BUTTON, TRY_AGAIN_BUTTON } from '../../src/services/commandErrors';
import type { DbtCandidate } from '../../src/services/dbtEnv';
import type { DbtCommandKind, DbtRunMode, DbtSpawnPlan } from '../../src/services/dbtLaunch';
import type { DbtProcessResult } from '../../src/services/dbtProcess';
import { defaultDbtProjectConfig } from '../../src/services/dbtProjectConfig';
import { couldNotStartNotice } from '../../src/services/dbtRunMessages';
import { telemetry } from '../../src/services/telemetryService';
import { DBT_FAILURE_OUTPUTS as OUT } from './dbtOutputFixtures';

const onPath: DbtCandidate = { executable: '/usr/local/bin/dbt', source: 'path' };
const CORE: DbtIdentity = { flavour: 'core-v1', adapters: ['duckdb'], via: 'stat' };

let root: string;
let home: string;
let storage: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nextsteps-root-')));
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nextsteps-home-')));
  storage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nextsteps-storage-')));
  fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: proj\nprofile: proj\n');
  fs.mkdirSync(path.join(home, '.dbt'));
  fs.writeFileSync(path.join(home, '.dbt', 'profiles.yml'), 'proj: x\n');
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

function host(storageDir = storage): DbtRunHost {
  return { storageDir, dbtConfig: () => defaultDbtProjectConfig(), physicalTarget: (o) => o, originIsPhysical: () => false, openPhysical: async () => true };
}

function deps(over: RunDbtParseDeps = {}): RunDbtParseDeps & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = ((_root: string, kind: DbtCommandKind, mode: DbtRunMode, plan: DbtSpawnPlan) => {
    let resolve!: (r: DbtProcessResult) => void;
    const result = new Promise<DbtProcessResult>((r) => { resolve = r; });
    calls.push({ kind, mode, plan, finish: (r = {}) => resolve({ outcome: 'exited', exitCode: 0, tail: '', durationMs: 1, ...r }) });
    return { kind: 'started', run: { terminal: {} as vscode.Terminal, result } };
  }) as unknown as typeof runDbtInTerminal;
  return {
    candidates: () => [onPath], isTrusted: () => true, identify: async () => CORE, run, host: host(),
    env: { PATH: '/usr/bin' }, homeDir: home, platform: 'darwin', fs: {}, ...over, calls,
  } as RunDbtParseDeps & { calls: RunCall[] };
}

/** Answers notices by the start of their message; records every notice and modal. */
function answer(answers: Record<string, string | undefined> = {}) {
  const shown: Array<{ kind: string; message: string; items: unknown[] }> = [];
  const respond = (kind: string) => (async (message: string, ...items: unknown[]) => {
    const labels = items.filter((i) => typeof i === 'string');
    shown.push({ kind, message, items: labels });
    const key = Object.keys(answers).find((k) => message.startsWith(k));
    return key ? answers[key] : undefined;
  }) as never;
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(respond('info'));
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(respond('warning'));
  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(respond('error'));
  return shown;
}

const errno = (code: string) => Object.assign(new Error(`${code}: open '/secret/path/profiles.yml'`), { code });
const NOT_SAVED = 'ERD Studio couldn\'t save the placeholder profile';
const NEEDS_PROFILE = 'dbt parse needs a dbt profile';

async function profileWriteFailure(code: string) {
  const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION });
  const d = deps({ fs: { writeFileSync: () => { throw errno(code); } } });
  const s = await runDbtParse(root, {}, d);
  d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
  await s.settled;
  await vi.waitFor(() => expect(shown.at(-1)?.kind).toBe('error'));
  return { notice: shown.at(-1)!, d };
}

describe('#296 row 1: the placeholder profile could not be saved', () => {
  it('ENOSPC: the disk is full, not the project; Try Again only', async () => {
    const { notice } = await profileWriteFailure('ENOSPC');
    expect(notice.message).toMatch(/^ERD Studio couldn't save the placeholder profile .* The disk is full: free up some space, then try again\. .*not in your project\.$/);
    expect(notice.items).toEqual([TRY_AGAIN_BUTTON]);
  });

  it('EACCES: names the storage folder it may not write to; Try Again only', async () => {
    const { notice } = await profileWriteFailure('EACCES');
    const dir = path.join(storage, 'dbt-parse-profile', 'duckdb');
    expect(notice.message).toContain(`ERD Studio isn't allowed to write to ${dir}, where VS Code keeps ERD Studio's files (not your project).`);
    expect(notice.items).toEqual([TRY_AGAIN_BUTTON]);
  });

  it('an unknown code: the general sentence, Try Again and Send Feedback (with the error redacted)', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION, [NOT_SAVED]: SEND_FEEDBACK_BUTTON });
    const d = deps({ fs: { writeFileSync: () => { throw errno('EIO'); } } });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.reportBug', expect.anything()));
    const notice = shown.at(-1)!;
    expect(notice.message).toMatch(/Check that the disk isn't full, then try again\.$/);
    expect(notice.message).not.toMatch(/secret|EIO/);
    expect(notice.items).toEqual([TRY_AGAIN_BUTTON, SEND_FEEDBACK_BUTTON]);
    const prefill = exec.mock.calls.find(([c]) => c === 'erdStudio.reportBug')![1] as { description: string };
    expect(prefill.description).toContain('EIO');
    expect(prefill.description).not.toContain('/secret/path');
  });

  it('while the notice waits, the project is not held: a click is not told dbt is busy', async () => {
    await profileWriteFailure('ENOSPC');
    expect(isDbtFlowStarting(root)).toBe(false);
  });

  it('Try Again saves the profile and runs Parse without your credentials with the adapter already picked', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION, [NOT_SAVED]: TRY_AGAIN_BUTTON });
    const pick = vi.spyOn(vscode.window, 'showQuickPick')
      .mockImplementation((async (items: Array<{ adapter: string }>) => items.find((i) => i.adapter === 'snowflake')) as never);
    let failOnce = true;
    let heldDuringRetry: boolean | undefined;
    const d = deps({
      identify: async () => ({ flavour: 'core-v1', adapters: ['snowflake', 'bigquery'], via: 'stat' }),
      fs: {
        writeFileSync: (p: string, data: string) => {
          if (failOnce) { failOnce = false; throw errno('ENOSPC'); }
          // The retry's pre-run steps hold the project (through followUp), so a click meanwhile is told dbt is busy.
          heldDuringRetry = isDbtFlowStarting(root);
          fs.writeFileSync(p, data);
        },
      } as Partial<DbtParseFs>,
    });
    await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 500 });
    expect(d.calls[1].mode).toBe('noCreds');
    expect(d.calls[1].plan.args[2]).toBe(path.join(storage, 'dbt-parse-profile', 'snowflake'));
    expect(pick).toHaveBeenCalledTimes(1);
    // One click of Parse without your credentials, counted once, and its adapter once.
    expect(feature.mock.calls.filter(([k]) => k === 'dbtParseNoCreds')).toHaveLength(1);
    expect(feature.mock.calls.filter(([k]) => k === 'dbtNoCredsSnowflake')).toHaveLength(1);
    expect(heldDuringRetry).toBe(true);
  });

  it('Try Again does not ask Replace again when the manifest is the one the user agreed to replace', async () => {
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(path.join(root, 'target', 'manifest.json'), '{"metadata": {"adapter_type": "duckdb"}}');
    const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION, 'Replace ': REPLACE_MANIFEST_ACTION, [NOT_SAVED]: TRY_AGAIN_BUTTON });
    let failOnce = true;
    const d = deps({
      fs: { writeFileSync: (p: string, data: string) => { if (failOnce) { failOnce = false; throw errno('ENOSPC'); } fs.writeFileSync(p, data); } } as Partial<DbtParseFs>,
    });
    await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 500 });
    expect(shown.filter((m) => m.message.startsWith('Replace '))).toHaveLength(1);
  });

  it('Try Again asks Replace when a manifest from a real profile appeared since the first attempt', async () => {
    let tryAgain!: () => void;
    const clicked = new Promise<string>((r) => { tryAgain = () => r(TRY_AGAIN_BUTTON); });
    const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION });
    vi.mocked(vscode.window.showErrorMessage).mockImplementation((async (message: string, ...items: string[]) => {
      shown.push({ kind: 'error', message, items });
      return message.startsWith(NOT_SAVED) ? clicked : undefined;
    }) as never);
    let failOnce = true;
    const d = deps({
      fs: { writeFileSync: (p: string, data: string) => { if (failOnce) { failOnce = false; throw errno('ENOSPC'); } fs.writeFileSync(p, data); } } as Partial<DbtParseFs>,
    });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    // Meanwhile, dbt parsed with the user's own profile.
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(path.join(root, 'target', 'manifest.json'), '{"metadata": {"adapter_type": "duckdb"}}');
    tryAgain();
    await vi.waitFor(() => expect(shown.some((m) => m.message.startsWith('Replace '))).toBe(true), { timeout: 500 });
    // Not answered: nothing runs, and the user's manifest stays.
    expect(d.calls).toHaveLength(1);
  });
  it('Try Again asks Replace again when the manifest the user agreed to replace was rewritten since', async () => {
    const manifest = path.join(root, 'target', 'manifest.json');
    fs.mkdirSync(path.join(root, 'target'));
    fs.writeFileSync(manifest, '{"metadata": {"adapter_type": "duckdb"}}');
    fs.utimesSync(manifest, new Date(1_000_000), new Date(1_000_000));
    let tryAgain!: () => void;
    const clicked = new Promise<string>((r) => { tryAgain = () => r(TRY_AGAIN_BUTTON); });
    const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION, 'Replace ': REPLACE_MANIFEST_ACTION });
    vi.mocked(vscode.window.showErrorMessage).mockImplementation((async (message: string, ...items: string[]) => {
      shown.push({ kind: 'error', message, items });
      return message.startsWith(NOT_SAVED) ? clicked : undefined;
    }) as never);
    let failOnce = true;
    const d = deps({
      fs: { writeFileSync: (p: string, data: string) => { if (failOnce) { failOnce = false; throw errno('ENOSPC'); } fs.writeFileSync(p, data); } } as Partial<DbtParseFs>,
    });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    await vi.waitFor(() => expect(shown.some((m) => m.message.startsWith(NOT_SAVED))).toBe(true));
    expect(shown.filter((m) => m.message.startsWith('Replace '))).toHaveLength(1);
    // Meanwhile, dbt parsed again with the user's own profile: a new manifest, not the one agreed to.
    fs.writeFileSync(manifest, '{"metadata": {"adapter_type": "duckdb"}, "nodes": {}}');
    fs.utimesSync(manifest, new Date(2_000_000), new Date(2_000_000));
    tryAgain();
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 500 });
    expect(shown.filter((m) => m.message.startsWith('Replace '))).toHaveLength(2);
  });
});

describe('#296 rows 2-3: dbt did not start', () => {
  it('a start error shows couldNotStartNotice\'s words, never the code, and Try Again runs the click again', async () => {
    const shown = answer({ 'ERD Studio couldn\'t start': TRY_AGAIN_BUTTON });
    let looks = 0;
    const d = deps({ candidates: () => { looks += 1; return [onPath]; }, fs: { isFile: (p) => p !== onPath.executable && fs.existsSync(p) } });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    await s.settled;
    const notice = shown.find((m) => m.kind === 'error')!;
    expect(notice.message).toBe(couldNotStartNotice('ENOENT', { shown: onPath.executable, executable: onPath.executable, executableExists: false }).message);
    expect(notice.message).not.toContain('ENOENT');
    expect(notice.items).toEqual([TRY_AGAIN_BUTTON, DBT_INSTALL_ACTION]);
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 500 });
    expect(looks).toBeGreaterThanOrEqual(2); // dbt was looked for again
  });

  it('ENOENT with dbt\'s file still there says the Python it runs with is missing', async () => {
    const shown = answer();
    const d = deps({ fs: { isFile: () => true } });
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    await s.settled;
    expect(shown.at(-1)!.message).toMatch(/the file is there, but something it needs to run is missing/);
  });

  it('Try Again after a start error is not counted as another Run dbt parse click', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer({ 'ERD Studio couldn\'t start': TRY_AGAIN_BUTTON });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    await s.settled;
    await vi.waitFor(() => expect(d.calls).toHaveLength(2), { timeout: 500 });
    expect(feature.mock.calls.filter(([k]) => k === 'dbtParse')).toHaveLength(1);
    expect(feature.mock.calls.filter(([k]) => k === 'dbtParseNoStart')).toHaveLength(1);
  });

  it('ENOENT because the project folder is gone says so, not that Python or dbt is missing', async () => {
    const shown = answer();
    const d = deps({ fs: { isFile: () => true } });
    const s = await runDbtParse(root, {}, d);
    fs.rmSync(root, { recursive: true, force: true }); // a branch switch removed the nested dbt project
    d.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    await s.settled;
    expect(shown.at(-1)!.message).toMatch(/: the dbt project folder \(.*\) is no longer there\./);
    expect(shown.at(-1)!.message).not.toMatch(/Python|virtual environment/);
    expect(shown.at(-1)!.items).toEqual([TRY_AGAIN_BUTTON]);
  });

  it('an unexplained start error offers Send Feedback, whose report carries the code', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const shown = answer({ 'ERD Studio couldn\'t start': SEND_FEEDBACK_BUTTON });
    const d = deps();
    const s = await runDbtParse(root, {}, d);
    d.calls[0].finish({ outcome: 'notStarted', exitCode: null, startError: 'EMFILE' });
    await s.settled;
    expect(shown.at(-1)!.items).toEqual([TRY_AGAIN_BUTTON, SEND_FEEDBACK_BUTTON]);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.reportBug', expect.objectContaining({ title: 'Run dbt parse failed' })));
    const prefill = exec.mock.calls.find(([c]) => c === 'erdStudio.reportBug')![1] as { description: string };
    expect(prefill.description).toContain('EMFILE');
  });

  it('showCouldNotStart never shows cmd.exe, a system code or Show output', () => {
    const spy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    for (const cause of ['refused', 'ENOENT', 'EACCES', 'EPERM', 'EMFILE', 'unknown']) {
      showCouldNotStart('C:\\proj\\.venv\\Scripts\\dbt%.cmd', 'C:\\proj', cause, { kind: 'compile', retry: () => undefined, isFile: () => false });
      const [message, ...items] = spy.mock.calls.at(-1)! as unknown as [string, ...string[]];
      expect(message, cause).not.toMatch(/cmd\.exe|\bE[A-Z]{3,}\b|unknown/);
      expect(items, cause).not.toContain(SHOW_OUTPUT_ACTION);
    }
  });

  it('a noCreds refusal caused by VS Code\'s storage path names that folder and offers How to set up a profile', async () => {
    const pctStorage = fs.mkdtempSync(path.join(storage, '100%-'));
    const shown = answer({ [NEEDS_PROFILE]: NO_CREDS_ACTION });
    const shim: DbtCandidate = { executable: '/opt/dbt/dbt.cmd', source: 'path' };
    const d = deps({ candidates: () => [shim], host: host(pctStorage) });
    const s = await runDbtParse(root, {}, d);
    expect(d.calls).toHaveLength(1); // the normal run started: dbt's path and the project are fine
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await s.settled;
    await vi.waitFor(() => expect(shown.at(-1)?.kind).toBe('error'));
    expect(d.calls).toHaveLength(1);
    const notice = shown.at(-1)!;
    expect(notice.message).toMatch(/^Parse without your credentials can't run on this machine: the folder where VS Code keeps ERD Studio's files \(.*100%-.*\) contains %,/);
    expect(notice.message).not.toMatch(/cmd\.exe|Move the project/);
    expect(notice.items).toEqual([PROFILE_DOCS_ACTION]);
  });
});
