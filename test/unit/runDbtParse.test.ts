/**
 * Run dbt parse (#110) — the physical stage's and the "no manifest"
 * notifications' way to write manifest.json. dbt is found with the same
 * candidate list `doctor` uses; a project-local venv dbt that is not on PATH
 * is never run without a modal, never in an untrusted workspace, and no dbt
 * at all points at the install docs. Also: a missing manifest is no longer a
 * telemetry error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  _resetDbtParseLaunchForTests,
  dbtParseLaunch,
  DBT_INSTALL_ACTION,
  DBT_NOT_FOUND_MESSAGE,
  getLastDbtParseLaunchAt,
  runDbtParse,
} from '../../src/commands/runDbtParse';
import { MANIFEST_FAILURE_CODES, manifestFailureCode } from '../../src/extension';
import type { DbtCandidate } from '../../src/services/dbtEnv';
import { GETTING_STARTED_EXTERNAL_URLS } from '../../src/types/gettingStarted';
import { telemetry } from '../../src/services/telemetryService';

const ROOT = '/proj';
const onPath: DbtCandidate = { executable: '/usr/local/bin/dbt', source: 'path' };
const venv: DbtCandidate = { executable: '/proj/.venv/bin/dbt', source: 'venv' };
const shim: DbtCandidate = { executable: '/home/u/.local/bin/dbt', source: 'shim' };

beforeEach(() => {
  vscode.window.terminals.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('dbtParseLaunch', () => {
  it('types bare `dbt parse` for the dbt on PATH', () => {
    expect(dbtParseLaunch(onPath, null)).toEqual({ kind: 'text', text: 'dbt parse' });
    expect(dbtParseLaunch({ ...venv, onPath: true }, "source '/proj/.venv/bin/activate'"))
      .toEqual({ kind: 'text', text: 'dbt parse' });
  });

  it('activates the venv first, like Run dbt compile', () => {
    expect(dbtParseLaunch(venv, "source '/proj/.venv/bin/activate'"))
      .toEqual({ kind: 'text', text: "source '/proj/.venv/bin/activate' && dbt parse" });
  });

  it('runs an absolute executable as the terminal process, never through a shell', () => {
    expect(dbtParseLaunch(shim, null)).toEqual({ kind: 'process', shellPath: shim.executable, shellArgs: ['parse'] });
  });
});

describe('runDbtParse', () => {
  it('opens a terminal in the project root running dbt parse', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    const ok = await runDbtParse(ROOT, { candidates: () => [onPath], isTrusted: () => true });
    expect(ok).toBe(true);
    expect(vscode.window.terminals).toHaveLength(1);
    const t = vscode.window.terminals[0];
    expect(t._options).toMatchObject({ name: 'dbt parse', cwd: ROOT });
    expect(t._sentText).toEqual(['dbt parse']);
    expect(feature).toHaveBeenCalledWith('dbtParse');
  });

  it('points at the install docs when no dbt is found', async () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(DBT_INSTALL_ACTION as never);
    const open = vi.spyOn(vscode.env, 'openExternal');
    const ok = await runDbtParse(ROOT, { candidates: () => [], isTrusted: () => true });
    expect(ok).toBe(false);
    expect(info).toHaveBeenCalledWith(DBT_NOT_FOUND_MESSAGE, DBT_INSTALL_ACTION);
    expect(String(open.mock.calls[0][0])).toContain(new URL(GETTING_STARTED_EXTERNAL_URLS.dbtInstallDocs).host);
    expect(vscode.window.terminals).toHaveLength(0);
  });

  it('asks before running a project-local venv dbt, and runs nothing on dismiss', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const ok = await runDbtParse(ROOT, { candidates: () => [venv, onPath], isTrusted: () => true, venvActivate: () => 'act' });
    expect(ok).toBe(false);
    const [, options] = warn.mock.calls[0] as unknown as [string, { modal: boolean; detail: string }];
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('.venv/bin/dbt');
    expect(vscode.window.terminals).toHaveLength(0);
  });

  it('uses the venv once the user agrees', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Use the project\'s dbt' as never);
    await runDbtParse(ROOT, { candidates: () => [venv, onPath], isTrusted: () => true, venvActivate: () => 'act' });
    expect(vscode.window.terminals[0]._sentText).toEqual(['act && dbt parse']);
  });

  it('can use the PATH dbt instead of the venv', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Use my dbt' as never);
    await runDbtParse(ROOT, { candidates: () => [venv, onPath], isTrusted: () => true, venvActivate: () => 'act' });
    expect(vscode.window.terminals[0]._sentText).toEqual(['dbt parse']);
  });

  it('never uses the project venv in an untrusted workspace', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    await runDbtParse(ROOT, { candidates: () => [venv, onPath], isTrusted: () => false, venvActivate: () => 'act' });
    expect(warn).not.toHaveBeenCalled();
    expect(vscode.window.terminals[0]._sentText).toEqual(['dbt parse']);
  });

  it('a venv dbt that is also on PATH runs without a prompt', async () => {
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    await runDbtParse(ROOT, { candidates: () => [{ ...venv, onPath: true }], isTrusted: () => true });
    expect(warn).not.toHaveBeenCalled();
    expect(vscode.window.terminals[0]._sentText).toEqual(['dbt parse']);
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
  beforeEach(() => _resetDbtParseLaunchForTests());

  it('is recorded when the terminal actually launches', async () => {
    const before = Date.now();
    await runDbtParse(ROOT, { candidates: () => [onPath], isTrusted: () => true });
    expect(getLastDbtParseLaunchAt()).toBeGreaterThanOrEqual(before);
  });

  it('is recorded for a terminal that runs dbt as its own process', async () => {
    await runDbtParse(ROOT, { candidates: () => [shim], isTrusted: () => true });
    expect(getLastDbtParseLaunchAt()).toBeTypeOf('number');
  });

  it('is not recorded when no dbt is found', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await runDbtParse(ROOT, { candidates: () => [], isTrusted: () => true });
    expect(getLastDbtParseLaunchAt()).toBeUndefined();
  });

  it('is not recorded when the venv prompt is dismissed', async () => {
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    await runDbtParse(ROOT, { candidates: () => [venv], isTrusted: () => true, venvActivate: () => 'act' });
    expect(getLastDbtParseLaunchAt()).toBeUndefined();
  });
});
