/**
 * Run dbt compile: the same runner and trust rules as Run dbt parse. The
 * Windows bug — `"…\activate.bat" && dbt compile` typed into PowerShell — is
 * gone: the venv's own Scripts\dbt.exe runs directly, and now only after the
 * trust modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetDbtFlowsForTests } from '../../src/commands/dbtCandidate';
import { _resetDbtRunsForTests, type runDbtInTerminal } from '../../src/commands/dbtTerminal';
import { COMPILE_OK_MESSAGE, DBT_COMPILE_NOT_FOUND_MESSAGE, runDbtCompile, type RunDbtCompileDeps } from '../../src/commands/runDbtCompile';
import { DBT_BUSY_MESSAGE, RUN_DBT_DEPS_ACTION } from '../../src/commands/runDbtParse';
import type { DbtCandidate } from '../../src/services/dbtEnv';
import { LOG_ARGS, type DbtCommandKind, type DbtRunMode, type DbtSpawnPlan } from '../../src/services/dbtLaunch';
import type { DbtProcessResult } from '../../src/services/dbtProcess';
import { telemetry } from '../../src/services/telemetryService';
import { DBT_FAILURE_OUTPUTS as OUT } from './dbtOutputFixtures';

const ROOT = 'C:\\proj';
const winVenv: DbtCandidate = { executable: 'C:\\proj\\.venv\\Scripts\\dbt.exe', source: 'venv' };
const onPath: DbtCandidate = { executable: 'C:\\Python\\Scripts\\dbt.exe', source: 'path' };

interface RunCall { kind: DbtCommandKind; mode: DbtRunMode; plan: DbtSpawnPlan; finish: (r?: Partial<DbtProcessResult>) => void }

function deps(over: RunDbtCompileDeps = {}): RunDbtCompileDeps & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = ((_root: string, kind: DbtCommandKind, mode: DbtRunMode, plan: DbtSpawnPlan) => {
    let resolve!: (r: DbtProcessResult) => void;
    const result = new Promise<DbtProcessResult>((r) => { resolve = r; });
    calls.push({ kind, mode, plan, finish: (r = {}) => resolve({ outcome: 'exited', exitCode: 0, tail: '', durationMs: 1, ...r }) });
    return { kind: 'started', run: { terminal: {} as vscode.Terminal, result } };
  }) as unknown as typeof runDbtInTerminal;
  return {
    candidates: () => [winVenv, onPath], isTrusted: () => true, run, env: { Path: 'C:\\Windows' }, platform: 'win32',
    readProjectFile: () => 'name: p\n', ...over, calls,
  } as RunDbtCompileDeps & { calls: RunCall[] };
}

function answer(answers: Record<string, string | undefined> = {}) {
  const shown: Array<{ message: string; items: unknown[] }> = [];
  const respond = (async (message: string, ...items: unknown[]) => {
    shown.push({ message, items });
    const key = Object.keys(answers).find((k) => message.startsWith(k));
    return key ? answers[key] : undefined;
  }) as never;
  vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation(respond);
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(respond);
  vi.spyOn(vscode.window, 'showErrorMessage').mockImplementation(respond);
  return shown;
}

const TRUST = 'Run dbt compile with the dbt inside this project?';

beforeEach(() => {
  _resetDbtRunsForTests();
  _resetDbtFlowsForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('runDbtCompile', () => {
  it('Windows venv: the venv\'s Scripts\\dbt.exe, no shell, no activate line — after the trust modal', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer({ [TRUST]: 'Use the project\'s dbt' });
    const d = deps();
    const start = await runDbtCompile(ROOT, d);
    expect(start.started).toBe(true);
    expect(shown[0].message).toBe(TRUST);
    expect(d.calls[0].plan).toMatchObject({ file: winVenv.executable, args: ['compile'], shell: false });
    for (const a of d.calls[0].plan.args) expect(a).not.toMatch(/&&|activate/i);
    expect(feature).toHaveBeenCalledWith('dbtCompileLaunched');
  });

  it('declining the trust modal records dbtCompileVenvDeclined', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    answer();
    const d = deps();
    await runDbtCompile(ROOT, d);
    expect(feature).toHaveBeenCalledWith('dbtCompileVenvDeclined');
    expect(d.calls).toHaveLength(0);
  });

  it('an untrusted workspace filters out the venv', async () => {
    const shown = answer();
    const d = deps({ isTrusted: () => false });
    await runDbtCompile(ROOT, d);
    expect(shown).toHaveLength(0);
    expect(d.calls[0].plan.file).toBe(onPath.executable);
  });

  it('no dbt: dbtCompileNoDbt', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    await runDbtCompile(ROOT, deps({ candidates: () => [] }));
    expect(feature).toHaveBeenCalledWith('dbtCompileNoDbt');
    expect(shown[0].message).toBe(DBT_COMPILE_NOT_FOUND_MESSAGE);
  });

  it('the not-found message never says to activate an environment (the runner cannot see one)', () => {
    expect(DBT_COMPILE_NOT_FOUND_MESSAGE).not.toMatch(/activate/i);
    expect(DBT_COMPILE_NOT_FOUND_MESSAGE).toContain('restart VS Code');
  });

  it('an unanswered dbt-not-found notice never holds the project: the next click runs', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((() => new Promise(() => {})) as never);
    expect((await runDbtCompile(ROOT, deps({ candidates: () => [] }))).started).toBe(false);
    const d = deps({ candidates: () => [onPath] });
    expect((await runDbtCompile(ROOT, d)).started).toBe(true);
    expect(feature).not.toHaveBeenCalledWith('dbtParseBusy');
  });

  it('an env var a model file uses says the project uses it; one in the profile says to set it and restart', async () => {
    const shown = answer();
    const d = deps({ candidates: () => [onPath] });
    const start = await runDbtCompile(ROOT, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.E3_envmodel });
    await start.settled;
    expect(shown.at(-1)?.message).toBe(
      'dbt needs the environment variable ERD_MODEL_VAR, which your project\'s files use. Set it where VS Code starts, restart VS Code, and try Run dbt compile again.',
    );
    _resetDbtFlowsForTests();
    const d2 = deps({ candidates: () => [onPath] });
    const start2 = await runDbtCompile(ROOT, d2);
    d2.calls[0].finish({ exitCode: 2, tail: OUT.D_envprofiles });
    await start2.settled;
    expect(shown.at(-1)).toEqual({
      message: 'dbt needs the environment variable ERD_PROTO_DUCKDB_PATH, which isn\'t set where VS Code started. Set it, restart VS Code, and try Run dbt compile again.',
      items: ['Show output'],
    });
  });

  it.each([
    [{ exitCode: 0 }, 'dbtCompileExitOk'],
    [{ exitCode: 2, tail: OUT.H_jinja }, 'dbtCompileExitFail'],
    [{ exitCode: null }, 'dbtCompileExitFail'],
    [{ outcome: 'stopped' as const, exitCode: null }, 'dbtCompileStopped'],
    [{ outcome: 'notStarted' as const, exitCode: null, startError: 'ENOENT' }, 'dbtCompileNoStart'],
  ])('%o records %s', async (r, key) => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const d = deps({ candidates: () => [onPath] });
    const start = await runDbtCompile(ROOT, d);
    d.calls[0].finish(r);
    await start.settled;
    expect(feature).toHaveBeenCalledWith(key);
    if (key === 'dbtCompileExitOk') expect(shown.at(-1)?.message).toBe(COMPILE_OK_MESSAGE);
    // No per-category telemetry for compile.
    expect(feature.mock.calls.some(([k]) => String(k).startsWith('dbtParseFail'))).toBe(false);
  });

  it('a failure never offers Parse without your credentials', async () => {
    const shown = answer();
    const d = deps({ candidates: () => [onPath] });
    const start = await runDbtCompile(ROOT, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.B_profilename });
    await start.settled;
    expect(shown.at(-1)?.message).toBe('dbt compile needs a dbt profile for this project, and dbt couldn\'t find one.');
    expect(shown.at(-1)?.items).toEqual(['How to set up a profile', 'Show output']);
  });

  it('missing packages: Run dbt deps, then compile again', async () => {
    answer({ 'This project uses dbt packages': RUN_DBT_DEPS_ACTION });
    const d = deps({ candidates: () => [onPath] });
    const start = await runDbtCompile(ROOT, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.G_packages });
    await vi.waitFor(() => expect(d.calls).toHaveLength(2));
    expect(d.calls[1].kind).toBe('deps');
    d.calls[1].finish({ exitCode: 0 });
    await vi.waitFor(() => expect(d.calls).toHaveLength(3));
    expect(d.calls[2].kind).toBe('compile');
    d.calls[2].finish({ exitCode: 0 });
    await start.settled;
  });

  it('a dbt Core install found by stat gets the log flags; any other dbt (maybe Fusion) does not', async () => {
    const d = deps({ candidates: () => [onPath], isCoreInstall: () => true });
    await runDbtCompile(ROOT, d);
    expect(d.calls[0].plan.args).toEqual(['compile', ...LOG_ARGS]);
    _resetDbtFlowsForTests();
    const d2 = deps({ candidates: () => [onPath], isCoreInstall: () => false });
    await runDbtCompile(ROOT, d2);
    expect(d2.calls[0].plan.args).toEqual(['compile']);
  });

  it('an env var packages.yml uses says the project uses it', async () => {
    const shown = answer();
    const files: string[] = [];
    const d = deps({
      candidates: () => [onPath],
      readProjectFile: (_r, f) => {
        files.push(f);
        if (f === 'packages.yml') return 'packages:\n  - git: "https://{{ env_var(\'DBT_ENV_SECRET_GIT_TOKEN\') }}@github.com/a/b.git"\n';
        return 'name: p\n';
      },
    });
    const start = await runDbtCompile(ROOT, d);
    d.calls[0].finish({ exitCode: 2, tail: OUT.D_envprofiles.replace('ERD_PROTO_DUCKDB_PATH', 'DBT_ENV_SECRET_GIT_TOKEN') });
    await start.settled;
    expect(shown.at(-1)?.message).toBe(
      'dbt needs the environment variable DBT_ENV_SECRET_GIT_TOKEN, which your project\'s files use. Set it where VS Code starts, restart VS Code, and try Run dbt compile again.',
    );
    expect(files).not.toContain('profiles.yml');
  });

  it('busy gives dbtParseBusy (the shared "a dbt run was already going" key)', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const shown = answer();
    const run = (() => ({ kind: 'busy', terminal: undefined })) as unknown as typeof runDbtInTerminal;
    await runDbtCompile(ROOT, deps({ candidates: () => [onPath], run }));
    expect(feature).toHaveBeenCalledWith('dbtParseBusy');
    expect(shown.at(-1)?.message).toBe(DBT_BUSY_MESSAGE);
  });
});
