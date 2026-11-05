/**
 * dbtCandidate — which dbt the buttons run and which flavour it is: dbt Core
 * by stat when possible (redone every call), else `dbt --version`, cached per
 * executable and modification time.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as vscode from 'vscode';

import {
  _resetDbtFlowsForTests,
  chooseDbtCandidate,
  USE_VENV,
  _resetDbtIdentityCacheForTests,
  claimDbtFlow,
  identifyDbt,
  isDbtFlowStarting,
  releaseDbtFlow,
  takesLogFlags,
  trustModalTitle,
} from '../../src/commands/dbtCandidate';
import { VERSION_DBT_DATABRICKS } from './dbtOutputFixtures';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-candidate-')));
  _resetDbtIdentityCacheForTests();
  _resetDbtFlowsForTests();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A venv laid out like dbt-core's: bin/dbt (#!), lib/python3.12/site-packages/dbt/{cli/main.py,include/…}. */
function makeCoreVenv(adapters: string[]): string {
  const sp = path.join(tmp, 'venv', 'lib', 'python3.12', 'site-packages', 'dbt');
  fs.mkdirSync(path.join(sp, 'cli'), { recursive: true });
  fs.writeFileSync(path.join(sp, 'cli', 'main.py'), '');
  for (const a of ['global_project', ...adapters]) fs.mkdirSync(path.join(sp, 'include', a), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'venv', 'bin'));
  const exe = path.join(tmp, 'venv', 'bin', 'dbt');
  fs.writeFileSync(exe, '#!/venv/bin/python\n');
  return exe;
}

describe('identifyDbt', () => {
  it.skipIf(process.platform === 'win32')('finds dbt Core by stat, again on every call (an adapter installed mid-session shows up)', async () => {
    const exe = makeCoreVenv(['duckdb']);
    const runVersion = vi.fn();
    expect(await identifyDbt({ executable: exe, source: 'venv' }, tmp, { runVersion })).toEqual({ flavour: 'core-v1', adapters: ['duckdb'], via: 'stat' });
    fs.mkdirSync(path.join(tmp, 'venv', 'lib', 'python3.12', 'site-packages', 'dbt', 'include', 'snowflake'));
    expect((await identifyDbt({ executable: exe, source: 'venv' }, tmp, { runVersion })).adapters).toEqual(['duckdb', 'snowflake']);
    expect(runVersion).not.toHaveBeenCalled();
  });

  it('falls back to dbt --version, cached per executable and mtime', async () => {
    const runVersion = vi.fn(async () => ({ output: VERSION_DBT_DATABRICKS }));
    let mtime = 1;
    const c = { executable: path.join(tmp, 'shims', 'dbt'), source: 'shim' as const };
    const opts = { runVersion, mtimeMs: () => mtime, platform: 'linux' as const, env: {} };
    expect(await identifyDbt(c, tmp, opts)).toEqual({ flavour: 'core-v1', adapters: ['databricks', 'spark'], via: 'version', version: '1.10.23' });
    await identifyDbt(c, tmp, opts);
    expect(runVersion).toHaveBeenCalledTimes(1);
    mtime = 2; // reinstalled
    await identifyDbt(c, tmp, opts);
    expect(runVersion).toHaveBeenCalledTimes(2);
    // The probe runs in the run's own environment, in the project root.
    expect(runVersion.mock.calls[0]).toMatchObject([c.executable, { cwd: tmp, env: { PYTHONUNBUFFERED: '1' } }]);
  });

  it('no output is unknown; no mtime means no cache; the Cloud CLI is named', async () => {
    const none = vi.fn(async () => ({ output: null }));
    const c = { executable: '/x/dbt', source: 'path' as const };
    expect(await identifyDbt(c, tmp, { runVersion: none, mtimeMs: () => undefined })).toEqual({ flavour: 'unknown', adapters: [], via: 'version' });
    await identifyDbt(c, tmp, { runVersion: none, mtimeMs: () => undefined });
    expect(none).toHaveBeenCalledTimes(2);
    // A failed or timed-out probe (no output) is never cached, even with an mtime: the next click probes again.
    const timedOut = vi.fn(async () => ({ output: null, error: 'timeout' }));
    const shim = { executable: '/home/u/.pyenv/shims/dbt', source: 'shim' as const };
    expect((await identifyDbt(shim, tmp, { runVersion: timedOut, mtimeMs: () => 7 })).flavour).toBe('unknown');
    await identifyDbt(shim, tmp, { runVersion: timedOut, mtimeMs: () => 7 });
    expect(timedOut).toHaveBeenCalledTimes(2);
    const recovered = vi.fn(async () => ({ output: VERSION_DBT_DATABRICKS }));
    expect((await identifyDbt(shim, tmp, { runVersion: recovered, mtimeMs: () => 7 })).flavour).toBe('core-v1');
    const cloud = vi.fn(async () => ({ output: 'dbt Cloud CLI - 0.40.14 (abc)\n' }));
    expect((await identifyDbt({ executable: '/opt/homebrew/bin/dbt', source: 'path' }, tmp, { runVersion: cloud, mtimeMs: () => 5 })).flavour).toBe('cloud-cli');
  });
});

describe('takesLogFlags', () => {
  it('dbt Core 1.5+ only: by stat, or a --version of 1.5 or later', () => {
    expect(takesLogFlags({ flavour: 'core-v1', adapters: [], via: 'stat' })).toBe(true);
    expect(takesLogFlags({ flavour: 'core-v1', adapters: [], via: 'version', version: '1.10.23' })).toBe(true);
    expect(takesLogFlags({ flavour: 'core-v1', adapters: [], via: 'version', version: '1.5.0' })).toBe(true);
    expect(takesLogFlags({ flavour: 'core-v1', adapters: [], via: 'version', version: '1.4.9' })).toBe(false);
    expect(takesLogFlags({ flavour: 'core-v1', adapters: [], via: 'version' })).toBe(false);
    expect(takesLogFlags({ flavour: 'fusion-v2', adapters: [], via: 'version', version: '2.0.1' })).toBe(false);
    expect(takesLogFlags({ flavour: 'unknown', adapters: [], via: 'version' })).toBe(false);
  });
});

describe('the in-flight guard and the modal title', () => {
  it('claims a root once until released', () => {
    const p = claimDbtFlow('/p');
    expect(p).not.toBeNull();
    expect(isDbtFlowStarting('/p')).toBe(true);
    expect(claimDbtFlow('/p')).toBeNull();
    const q = claimDbtFlow('/q');
    expect(q).not.toBeNull();
    releaseDbtFlow(p);
    expect(isDbtFlowStarting('/p')).toBe(false);
    releaseDbtFlow(q);
  });

  it('only the claim that holds a root releases it', () => {
    const first = claimDbtFlow('/r');
    releaseDbtFlow(first);
    const second = claimDbtFlow('/r');
    expect(second).not.toBeNull();
    // The first flow's late release (its finally) must not drop the second's claim.
    releaseDbtFlow(first);
    expect(isDbtFlowStarting('/r')).toBe(true);
    expect(claimDbtFlow('/r')).toBeNull();
    releaseDbtFlow(second);
    expect(isDbtFlowStarting('/r')).toBe(false);
    releaseDbtFlow(null);
  });

  it('names the command', () => {
    expect(trustModalTitle('parse')).toBe('Run dbt parse with the dbt inside this project?');
    expect(trustModalTitle('compile')).toBe('Run dbt compile with the dbt inside this project?');
  });
});

describe('chooseDbtCandidate: a monorepo venv above the dbt project', () => {
  it.skipIf(process.platform === 'win32')('finds repo/.venv for repo/transform, and still asks before running it', async () => {
    const repo = path.join(tmp, 'repo');
    const root = path.join(repo, 'transform');
    fs.mkdirSync(path.join(repo, '.venv', 'bin'), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const exe = path.join(repo, '.venv', 'bin', 'dbt');
    fs.writeFileSync(exe, '', { mode: 0o755 });
    const prevPath = process.env.PATH;
    process.env.PATH = '';
    const modal = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(USE_VENV as never);
    try {
      const got = await chooseDbtCandidate(root, 'parse', { isTrusted: () => true, workspaceFolderOf: () => repo });
      expect(got).not.toBe('noDbt');
      expect(typeof got === 'object' && got.chosen).toEqual({ executable: exe, source: 'venv' });
      expect(modal).toHaveBeenCalledTimes(1);

      // An untrusted workspace never runs it, wherever the venv is.
      modal.mockClear();
      expect(await chooseDbtCandidate(root, 'parse', { isTrusted: () => false, workspaceFolderOf: () => repo })).not.toEqual(
        expect.objectContaining({ chosen: expect.objectContaining({ executable: exe }) }),
      );
      expect(modal).not.toHaveBeenCalled();
    } finally {
      process.env.PATH = prevPath;
      modal.mockRestore();
    }
  });
});
