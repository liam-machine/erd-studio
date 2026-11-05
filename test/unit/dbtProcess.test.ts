/**
 * dbtProcess — the child process behind Run dbt parse / compile / deps: its
 * exit code and an in-memory tail of its output, stop and kill, and an
 * absolute taskkill on Windows.
 */
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DBT_KILL_GRACE_MS,
  DBT_OUTPUT_TAIL_CHARS,
  defaultKillTree,
  startDbtProcess,
  taskkillPath,
  type SpawnLike,
} from '../../src/services/dbtProcess';
import type { DbtSpawnPlan } from '../../src/services/dbtLaunch';

const PLAN: DbtSpawnPlan = { file: '/p/.venv/bin/dbt', args: ['parse'], shell: false, env: { PATH: '/usr/bin' }, cwd: '/p', display: '.venv/bin/dbt parse' };

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  close(code: number | null, signal: string | null = null): void {
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
}

function fakeSpawn(child = new FakeChild()): { spawn: SpawnLike; child: FakeChild; calls: Array<[string, string[], unknown]> } {
  const calls: Array<[string, string[], unknown]> = [];
  const spawn = ((file: string, args: string[], opts: unknown) => { calls.push([file, args, opts]); return child; }) as unknown as SpawnLike;
  return { spawn, child, calls };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startDbtProcess', () => {
  it('spawns the plan with no shell and piped output', () => {
    const f = fakeSpawn();
    startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'darwin', killTree: () => {} });
    expect(f.calls[0][0]).toBe('/p/.venv/bin/dbt');
    expect(f.calls[0][1]).toEqual(['parse']);
    expect(f.calls[0][2]).toMatchObject({ cwd: '/p', env: PLAN.env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const w = fakeSpawn();
    startDbtProcess(PLAN, () => {}, { spawn: w.spawn, platform: 'win32', killTree: () => {} });
    expect(w.calls[0][2]).toMatchObject({ detached: false });
  });

  it('forwards output in order and reports the exit code with the tail', async () => {
    const f = fakeSpawn();
    const seen: string[] = [];
    const h = startDbtProcess(PLAN, (t) => seen.push(t), { spawn: f.spawn, platform: 'linux', killTree: () => {} });
    expect(h.running).toBe(true);
    f.child.stdout.write('one\n');
    f.child.stderr.write('two\n');
    f.child.stdout.write('three\n');
    await new Promise((r) => setImmediate(r));
    f.child.close(2);
    const r = await h.done;
    expect(seen.join('')).toBe('one\ntwo\nthree\n');
    expect(r).toMatchObject({ outcome: 'exited', exitCode: 2, tail: 'one\ntwo\nthree\n' });
    expect(h.running).toBe(false);
  });

  it('bounds the tail and keeps its end', async () => {
    const f = fakeSpawn();
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree: () => {} });
    f.child.stdout.write('a'.repeat(DBT_OUTPUT_TAIL_CHARS));
    f.child.stdout.write('END');
    await new Promise((r) => setImmediate(r));
    f.child.close(0);
    const r = await h.done;
    expect(r.tail.length).toBe(DBT_OUTPUT_TAIL_CHARS);
    expect(r.tail.endsWith('END')).toBe(true);
  });

  it('a close by signal is exited with no exit code', async () => {
    const f = fakeSpawn();
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree: () => {} });
    f.child.close(null, 'SIGSEGV');
    expect(await h.done).toMatchObject({ outcome: 'exited', exitCode: null });
  });

  it('ENOENT before spawn is notStarted with the code only, settled once', async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const f = fakeSpawn(child);
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree: () => {} });
    child.emit('error', Object.assign(new Error('spawn /secret/path ENOENT'), { code: 'ENOENT' }));
    child.close(-2);
    const r = await h.done;
    expect(r).toMatchObject({ outcome: 'notStarted', exitCode: null, startError: 'ENOENT' });
    expect(JSON.stringify(r)).not.toContain('/secret/path');
  });

  it('spawn throwing is notStarted', async () => {
    const spawn = (() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }) as unknown as SpawnLike;
    expect(await startDbtProcess(PLAN, () => {}, { spawn, platform: 'linux' }).done).toMatchObject({ outcome: 'notStarted', startError: 'EACCES' });
  });

  it('stop() ends it as stopped through killTree', async () => {
    const f = fakeSpawn();
    const killTree = vi.fn();
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree });
    h.stop();
    h.stop();
    expect(killTree).toHaveBeenCalledTimes(1);
    expect(killTree).toHaveBeenCalledWith(4242, 'linux', 'SIGTERM');
    f.child.close(null, 'SIGTERM');
    expect(await h.done).toMatchObject({ outcome: 'stopped', exitCode: null });
  });

  it('stop() after settling does nothing and keeps the outcome', async () => {
    const f = fakeSpawn();
    const killTree = vi.fn();
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree });
    f.child.close(0);
    await h.done;
    h.stop();
    h.kill();
    expect(killTree).not.toHaveBeenCalled();
    expect(await h.done).toMatchObject({ outcome: 'exited', exitCode: 0 });
  });

  it('posix: SIGKILL after the grace when the child has not closed, none when it has', async () => {
    vi.useFakeTimers();
    const f = fakeSpawn();
    const killTree = vi.fn();
    const h = startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'darwin', killTree });
    h.stop();
    vi.advanceTimersByTime(DBT_KILL_GRACE_MS + 1);
    expect(killTree.mock.calls.map((c) => c[2])).toEqual(['SIGTERM', 'SIGKILL']);

    const g = fakeSpawn();
    const killTree2 = vi.fn();
    const h2 = startDbtProcess(PLAN, () => {}, { spawn: g.spawn, platform: 'darwin', killTree: killTree2 });
    h2.stop();
    g.child.stdout.end();
    g.child.stderr.end();
    g.child.emit('close', null, 'SIGTERM');
    await h2.done;
    vi.advanceTimersByTime(DBT_KILL_GRACE_MS + 1);
    expect(killTree2.mock.calls.map((c) => c[2])).toEqual(['SIGTERM']);
    void h;
  });

  it('kill() sends SIGKILL at once', () => {
    const f = fakeSpawn();
    const killTree = vi.fn();
    startDbtProcess(PLAN, () => {}, { spawn: f.spawn, platform: 'linux', killTree }).kill();
    expect(killTree).toHaveBeenCalledWith(4242, 'linux', 'SIGKILL');
  });
});

describe('defaultKillTree', () => {
  it('win32 spawns the absolute System32 taskkill.exe with /T /F', () => {
    const f = fakeSpawn();
    defaultKillTree(f.spawn, { SystemRoot: 'D:\\Win' })(77, 'win32', 'SIGTERM');
    expect(f.calls[0][0]).toBe('D:\\Win\\System32\\taskkill.exe');
    expect(f.calls[0][1]).toEqual(['/pid', '77', '/T', '/F']);
    expect(taskkillPath({})).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(taskkillPath({ windir: 'E:\\W\\' })).toBe('E:\\W\\System32\\taskkill.exe');
  });

  it('posix signals the process group, ignoring ESRCH', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    defaultKillTree(fakeSpawn().spawn, {})(77, 'linux', 'SIGTERM');
    expect(kill).toHaveBeenCalledWith(-77, 'SIGTERM');
    kill.mockImplementation(() => { throw Object.assign(new Error('x'), { code: 'ESRCH' }); });
    expect(() => defaultKillTree(fakeSpawn().spawn, {})(77, 'linux', 'SIGKILL')).not.toThrow();
  });
});
