/**
 * dbtTerminal — a dbt run in a pseudoterminal: header, output and footer;
 * Ctrl+C and closing the terminal stop it; one run per project; the last
 * output can be shown again after its terminal is gone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  _resetDbtRunsForTests,
  DBT_RUN_TOAST_GRACE_MS,
  disposeDbtRuns,
  isDbtRunActive,
  isDbtRunActiveOrRecent,
  runDbtInTerminal,
  showDbtOutput,
} from '../../src/commands/dbtTerminal';
import type { DbtSpawnPlan } from '../../src/services/dbtLaunch';
import type { DbtProcessHandle, DbtProcessResult } from '../../src/services/dbtProcess';
import { _closeTerminal, _input, _openPty } from '../__mocks__/vscode';

type MockTerminal = vscode.Terminal & { _options: Record<string, unknown>; _written: string[]; _closedWith: unknown[] };

const PLAN: DbtSpawnPlan = { file: '/p/.venv/bin/dbt', args: ['parse'], shell: false, env: {}, cwd: '/p', display: '.venv/bin/dbt parse' };

interface FakeProcess {
  handle: DbtProcessHandle;
  out: (t: string) => void;
  end: (r: Partial<DbtProcessResult>) => void;
  stop: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
}

function fakeStart(): { start: (plan: DbtSpawnPlan, onOutput: (t: string) => void) => DbtProcessHandle; procs: FakeProcess[] } {
  const procs: FakeProcess[] = [];
  const start = (_plan: DbtSpawnPlan, onOutput: (t: string) => void): DbtProcessHandle => {
    let resolve!: (r: DbtProcessResult) => void;
    const done = new Promise<DbtProcessResult>((r) => { resolve = r; });
    let tail = '';
    const stop = vi.fn();
    const kill = vi.fn();
    const handle = { done, stop, kill, running: true };
    procs.push({
      handle,
      out: (t) => { tail += t; onOutput(t); },
      end: (r) => resolve({ outcome: 'exited', exitCode: 0, tail, durationMs: 1, ...r }),
      stop,
      kill,
    });
    return handle;
  };
  return { start, procs };
}

const terminals = () => vscode.window.terminals as unknown as MockTerminal[];

beforeEach(() => {
  vscode.window.terminals.length = 0;
  _resetDbtRunsForTests();
});
afterEach(() => vi.restoreAllMocks());

describe('runDbtInTerminal', () => {
  it('opens a transient pty terminal that writes the header, CRLF output and the footer', async () => {
    const f = fakeStart();
    const s = runDbtInTerminal('/p', 'parse', 'noCreds', PLAN, { start: f.start });
    expect(s.kind).toBe('started');
    const t = terminals()[0];
    expect(t._options).toMatchObject({ name: 'dbt parse', isTransient: true });
    expect(f.procs).toHaveLength(0); // starts on open(), not before
    _openPty(t);
    f.procs[0].out('line 1\nline 2\n');
    f.procs[0].end({ exitCode: 0 });
    const r = await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
    expect(r.exitCode).toBe(0);
    const text = t._written.join('');
    expect(text).toContain('> .venv/bin/dbt parse');
    expect(text).toContain('Parsing without your credentials');
    expect(text).toContain('line 1\r\nline 2\r\n');
    expect(text).toContain('✓ dbt parse finished.');
    expect(text).toContain('Press any key to close this terminal.');
  });

  it('footers for a failure, a signal, a stop and a start error', async () => {
    const cases: Array<[Partial<DbtProcessResult>, string]> = [
      [{ exitCode: 2 }, '✗ dbt deps failed with exit code 2.'],
      [{ exitCode: null }, '✗ dbt deps ended without an exit code.'],
      [{ outcome: 'stopped', exitCode: null }, 'dbt deps was stopped.'],
      [{ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' }, 'Couldn\'t start dbt (ENOENT).'],
    ];
    for (const [r, line] of cases) {
      _resetDbtRunsForTests();
      vscode.window.terminals.length = 0;
      const f = fakeStart();
      const s = runDbtInTerminal('/p', 'deps', 'normal', PLAN, { start: f.start });
      const t = terminals()[0];
      _openPty(t);
      expect(t._written.join('')).toContain('Downloads the packages in packages.yml.');
      f.procs[0].end(r);
      await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
      expect(t._written.join('')).toContain(line);
    }
  });

  it('Ctrl+C stops; any key after finishing closes with no exit code', async () => {
    const f = fakeStart();
    const s = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    const t = terminals()[0];
    _openPty(t);
    _input(t, 'x');
    expect(f.procs[0].stop).not.toHaveBeenCalled();
    _input(t, '\x03');
    expect(f.procs[0].stop).toHaveBeenCalledTimes(1);
    f.procs[0].end({ outcome: 'stopped', exitCode: null });
    await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
    _input(t, 'q');
    expect(t._closedWith).toEqual([undefined]);
    expect(vscode.window.terminals).not.toContain(t);
  });

  it('closing the terminal while dbt runs stops it', () => {
    const f = fakeStart();
    runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    const t = terminals()[0];
    _openPty(t);
    _closeTerminal(t);
    expect(f.procs[0].stop).toHaveBeenCalled();
  });

  it('a terminal closed before open() settles as stopped and frees the project', async () => {
    const f = fakeStart();
    const s = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    expect(isDbtRunActive('/p')).toBe(true);
    _closeTerminal(terminals()[0]);
    const r = await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
    expect(r).toMatchObject({ outcome: 'stopped', exitCode: null });
    expect(isDbtRunActive('/p')).toBe(false);
    expect(runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start }).kind).toBe('started');
    expect(f.procs).toHaveLength(0);
  });

  it('one run per project: a second is busy, another project starts', async () => {
    const f = fakeStart();
    const first = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    const busy = runDbtInTerminal('/p', 'compile', 'normal', PLAN, { start: f.start });
    expect(busy.kind).toBe('busy');
    expect((busy as { terminal: unknown }).terminal).toBe((first as { run: { terminal: unknown } }).run.terminal);
    expect(runDbtInTerminal('/q', 'parse', 'normal', PLAN, { start: f.start }).kind).toBe('started');
    _openPty(terminals()[0]);
    f.procs[0].end({ exitCode: 0 });
    await (first as { run: { result: Promise<DbtProcessResult> } }).run.result;
    const again = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    expect(again.kind).toBe('started');
    // The finished run's terminal made way for the new one.
    expect(vscode.window.terminals).not.toContain((first as { run: { terminal: vscode.Terminal } }).run.terminal);
  });

  it('isDbtRunActiveOrRecent covers the run and a grace after it', async () => {
    const f = fakeStart();
    expect(isDbtRunActiveOrRecent('/p')).toBe(false);
    const s = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    expect(isDbtRunActiveOrRecent('/p')).toBe(true);
    _openPty(terminals()[0]);
    f.procs[0].end({ exitCode: 0 });
    await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
    expect(isDbtRunActive('/p')).toBe(false);
    expect(isDbtRunActiveOrRecent('/p')).toBe(true);
    expect(isDbtRunActiveOrRecent('/p', Date.now() + DBT_RUN_TOAST_GRACE_MS + 1)).toBe(false);
  });

  it('showDbtOutput shows the open terminal, else replays the tail in a new one', async () => {
    const f = fakeStart();
    const s = runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    const t = terminals()[0];
    const show = vi.spyOn(t, 'show');
    _openPty(t);
    f.procs[0].out('Encountered an error:\nboom\n');
    f.procs[0].end({ exitCode: 2 });
    await (s as { run: { result: Promise<DbtProcessResult> } }).run.result;
    showDbtOutput('/p');
    expect(show).toHaveBeenCalled();
    _closeTerminal(t);
    showDbtOutput('/p');
    const replay = terminals()[0];
    expect(replay._options).toMatchObject({ name: 'dbt parse (last output)', isTransient: true });
    _openPty(replay);
    expect(replay._written.join('')).toContain('Encountered an error:\r\nboom\r\n');
    _input(replay, 'x');
    expect(vscode.window.terminals).not.toContain(replay);
  });

  it('disposeDbtRuns kills every child and closes the terminals', () => {
    const f = fakeStart();
    runDbtInTerminal('/p', 'parse', 'normal', PLAN, { start: f.start });
    runDbtInTerminal('/q', 'compile', 'normal', PLAN, { start: f.start });
    for (const t of terminals()) _openPty(t);
    disposeDbtRuns();
    expect(f.procs.every((p) => p.kill.mock.calls.length === 1)).toBe(true);
    expect(vscode.window.terminals).toHaveLength(0);
    expect(isDbtRunActive('/p')).toBe(false);
  });
});
