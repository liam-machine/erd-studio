/**
 * dbtProcess — runs one dbt command as a child process and reports how it
 * ended: its exit code and the last part of its output, kept **in memory
 * only** (the failure classifier reads it; nothing logs, stores or sends it).
 *
 * The plan comes from `planDbtSpawn` (dbtLaunch.ts): an absolute executable,
 * no shell except a quoted `.cmd` / `.bat` shim. There is no timeout — a
 * large project can parse for minutes, and the user can always stop it.
 *
 * Node only, vscode-free.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process';

import type { DbtSpawnPlan } from './dbtLaunch';

/** How much of the output the result keeps (stdout and stderr, in arrival order). */
export const DBT_OUTPUT_TAIL_CHARS = 64 * 1024;
/** How long a stopped dbt gets after SIGTERM before SIGKILL (POSIX). */
export const DBT_KILL_GRACE_MS = 5_000;

export interface DbtProcessResult {
  outcome: 'exited' | 'stopped' | 'notStarted';
  /** null when stopped, not started, or ended by a signal. */
  exitCode: number | null;
  /** The last {@link DBT_OUTPUT_TAIL_CHARS} of stdout + stderr, raw (ANSI kept). */
  tail: string;
  /** `err.code` only (ENOENT, EACCES…), never `err.message`. */
  startError?: string;
  durationMs: number;
}

export interface DbtProcessHandle {
  readonly done: Promise<DbtProcessResult>;
  /** Stop gracefully (SIGTERM, then SIGKILL after the grace). A no-op once settled. */
  stop(): void;
  /** Stop at once (deactivate). A no-op once settled. */
  kill(): void;
  readonly running: boolean;
}

export type SpawnLike = (file: string, args: string[], opts: SpawnOptions) => ChildProcess;
export type KillTree = (pid: number, platform: NodeJS.Platform, signal: 'SIGTERM' | 'SIGKILL') => void;

export interface DbtProcessDeps {
  spawn?: SpawnLike;
  platform?: NodeJS.Platform;
  now?: () => number;
  killTree?: KillTree;
  /** Read for `SystemRoot` / `windir` (the absolute taskkill path). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The absolute `taskkill.exe`. Never a bare `taskkill`: the executable search
 * would look in the current directory (the project root) first.
 */
export function taskkillPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows';
  return `${root.replace(/[\\/]+$/, '')}\\System32\\taskkill.exe`;
}

/** Kill `pid` and its children: taskkill /T /F on Windows, the process group elsewhere. */
export function defaultKillTree(
  spawn: SpawnLike,
  env: NodeJS.ProcessEnv,
): KillTree {
  return (pid, platform, signal) => {
    if (platform === 'win32') {
      // taskkill /F is already immediate; /T also ends cmd.exe's and dbt.exe's python.exe.
      try {
        const child = spawn(taskkillPath(env), ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => { /* nothing more to do */ });
      } catch { /* nothing more to do */ }
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return;
      try { process.kill(pid, signal); } catch { /* gone */ }
    }
  };
}

/** Start `plan`, forwarding every output chunk to `onOutput`. Never throws. */
export function startDbtProcess(
  plan: DbtSpawnPlan,
  onOutput: (text: string) => void,
  deps: DbtProcessDeps = {},
): DbtProcessHandle {
  const spawn = deps.spawn ?? (nodeSpawn as SpawnLike);
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const killTree = deps.killTree ?? defaultKillTree(spawn, deps.env ?? process.env);
  const started = now();

  let tail = '';
  let settled = false;
  let stopped = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone!: (r: DbtProcessResult) => void;
  const done = new Promise<DbtProcessResult>((resolve) => { resolveDone = resolve; });

  const settle = (r: Omit<DbtProcessResult, 'tail' | 'durationMs'>): void => {
    if (settled) return;
    settled = true;
    if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
    resolveDone({ ...r, tail, durationMs: Math.max(0, now() - started) });
  };

  let child: ChildProcess | undefined;
  try {
    child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: plan.shell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: platform !== 'win32',
    });
  } catch (err) {
    settle({ outcome: 'notStarted', exitCode: null, startError: errorCode(err) });
  }

  if (child) {
    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      try { onOutput(text); } catch { /* the terminal went away */ }
      tail += text;
      if (tail.length > DBT_OUTPUT_TAIL_CHARS) tail = tail.slice(tail.length - DBT_OUTPUT_TAIL_CHARS);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      // Before spawn: the executable could not be started. After it, ignore (close follows).
      if (child && child.pid === undefined) {
        settle({ outcome: 'notStarted', exitCode: null, startError: errorCode(err) });
      }
    });
    child.on('close', (code: number | null) => {
      if (stopped) settle({ outcome: 'stopped', exitCode: null });
      else settle({ outcome: 'exited', exitCode: typeof code === 'number' ? code : null });
    });
  }

  let sent: 'SIGTERM' | 'SIGKILL' | undefined;
  const end = (signal: 'SIGTERM' | 'SIGKILL'): void => {
    // Idempotent; and never once settled: a finished child's pid may belong to another process by now.
    if (settled || !child || sent === signal || sent === 'SIGKILL') return;
    sent = signal;
    stopped = true;
    const pid = child.pid;
    if (pid === undefined) return;
    killTree(pid, platform, signal);
    if (signal === 'SIGTERM' && platform !== 'win32' && !killTimer) {
      killTimer = setTimeout(() => {
        killTimer = undefined;
        if (!settled) killTree(pid, platform, 'SIGKILL');
      }, DBT_KILL_GRACE_MS);
      killTimer.unref?.();
    }
  };

  return {
    done,
    stop: () => end('SIGTERM'),
    kill: () => end('SIGKILL'),
    get running() { return !settled; },
  };
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'unknown';
}
