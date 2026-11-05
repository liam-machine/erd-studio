/**
 * dbtLaunch — how ERD Studio spawns dbt for Run dbt parse, Run dbt compile
 * and Run dbt deps: the arguments, the child environment and the spawn plan.
 *
 * dbt is always the candidate's **absolute executable**, spawned directly
 * (no shell, except a double-quoted `.cmd` / `.bat` shim). Nothing is ever
 * typed into the user's shell and no `activate` script is run: a venv's
 * `bin/dbt` (`Scripts\dbt.exe` on Windows) has its interpreter's absolute
 * path baked in, so it runs as it is. That is the fix for the Windows bug
 * where `"…\activate.bat" && dbt parse` was typed into PowerShell.
 *
 * Pure: no `vscode`, no file access, no spawning. Every input is a parameter.
 */

import * as path from 'path';

import { dbtInvocation, dbtSpawnCommand, type DbtCandidate } from './dbtEnv';
import { THROWAWAY_MARKER_KEY } from '../types/manifest';

export type DbtCommandKind = 'parse' | 'compile' | 'deps';
/** `normal` uses the user's own dbt profile; `noCreds` is Parse without your credentials. */
export type DbtRunMode = 'normal' | 'noCreds';

/** The placeholder profile's name and target (fixed, so `dbt_project.yml`'s `profile:` is never needed). */
export const THROWAWAY_PROFILE_NAME = 'erd_studio';
export const THROWAWAY_TARGET_NAME = 'erd_studio';
/** Under the extension's global storage; one sub-folder per adapter. */
export const THROWAWAY_PROFILE_DIR_NAME = 'dbt-parse-profile';
/**
 * The child env var that marks a Parse without your credentials run. dbt
 * copies every `DBT_ENV_CUSTOM_ENV_*` variable into `manifest.metadata.env`
 * (without the prefix), so the manifest records its own origin.
 */
export const THROWAWAY_MARKER_ENV = `DBT_ENV_CUSTOM_ENV_${THROWAWAY_MARKER_KEY}`;

/**
 * Global flags that keep dbt's output plain, readable text whatever
 * `dbt_project.yml`'s `flags:`, `DBT_QUIET` or a `warn` / `none` log level
 * say: the failure classifier reads it, and `Registered adapter:` (an info
 * line) tells a project env var from a profile one. Command-line flags beat
 * env vars and project flags. dbt Core 1.5+ only (`takesLogFlags`).
 */
export const LOG_ARGS: readonly string[] = ['--log-format', 'text', '--log-level', 'info', '--no-quiet'];

/** `LOG_ARGS`, without `--log-level info` when the user asked for `debug` (more output, never less). */
export function logArgs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const win = platform === 'win32';
  const debug = Object.entries(env).some(([k, v]) => {
    const name = win ? k.toUpperCase() : k;
    return (name === 'DBT_LOG_LEVEL' || name === 'DBT_ENGINE_LOG_LEVEL') && typeof v === 'string' && v.trim().toLowerCase() === 'debug';
  });
  return debug ? ['--log-format', 'text', '--no-quiet'] : [...LOG_ARGS];
}

/**
 * dbt's arguments: the subcommand, then (noCreds `parse` only) the profile
 * flags (explicit flags beat `DBT_PROFILE`, `DBT_TARGET` and
 * `DBT_PROFILES_DIR`), then `log` (`logArgs`, or none for a dbt that may not
 * take them). `deps` never carries profile flags: dbt 1.8+ loads no profile
 * for it. A noCreds `compile`, or a noCreds `parse` without a profiles dir,
 * is a programming error.
 */
export function dbtArgs(kind: DbtCommandKind, mode: DbtRunMode, profilesDir?: string, log: readonly string[] = []): string[] {
  if (kind === 'deps') { return ['deps', ...log]; }
  if (mode === 'normal') { return [kind, ...log]; }
  if (kind !== 'parse') { throw new Error(`dbtArgs: ${kind} has no noCreds mode`); }
  if (!profilesDir) { throw new Error('dbtArgs: noCreds parse needs a profiles dir'); }
  return ['parse', '--profiles-dir', profilesDir, '--profile', THROWAWAY_PROFILE_NAME, '--target', THROWAWAY_TARGET_NAME, ...log];
}

export interface DbtSpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
  /** The full child environment. */
  env: Record<string, string>;
  /** The dbt project root. */
  cwd: string;
  /** Shown in the terminal header, e.g. `.venv/bin/dbt parse`. */
  display: string;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Child env variables dropped in every mode. */
const ALWAYS_DROPPED = ['DBT_LOG_FORMAT', 'DBT_ENGINE_LOG_FORMAT', 'DBT_PROJECT_DIR', 'DBT_ENGINE_PROJECT_DIR'];
/** Dropped only when set to `none` (every other level is the user's choice and stays). */
const SILENCING_LOG_LEVELS = ['DBT_LOG_LEVEL', 'DBT_ENGINE_LOG_LEVEL'];
/** Dropped in noCreds mode: the flags win anyway (belt and braces). */
const NO_CREDS_DROPPED = [
  'DBT_PROFILES_DIR', 'DBT_ENGINE_PROFILES_DIR', 'DBT_PROFILE', 'DBT_TARGET', 'DBT_ENGINE_PROFILE', 'DBT_ENGINE_TARGET',
];

/**
 * The child environment for a dbt run with `candidate`. A copy of `env`
 * (undefined values dropped; key comparisons case-insensitive on Windows):
 *
 * - a project venv / `$VIRTUAL_ENV` dbt: its bin dir first on PATH,
 *   `VIRTUAL_ENV` set (only when that dir is `bin` / `Scripts`), `PYTHONHOME`
 *   removed; a conda dbt: conda's own activation dirs first on PATH (DLLs
 *   such as pyodbc's need them on Windows); any other source leaves PATH;
 * - always `PYTHONUNBUFFERED=1` (a piped stdout is block-buffered) and
 *   `PYTHONIOENCODING=utf-8`; `DBT_LOG_FORMAT` / `DBT_ENGINE_LOG_FORMAT`
 *   removed (the failure classifier reads plain text) and `DBT_PROJECT_DIR` /
 *   `DBT_ENGINE_PROJECT_DIR` removed (the cwd is the project ERD Studio
 *   reads); `DBT_LOG_LEVEL` / `DBT_ENGINE_LOG_LEVEL` removed only when
 *   set to `none`, which prints nothing (any other level stays); on Windows
 *   `NoDefaultCurrentDirectoryInExePath=1`, so cmd.exe
 *   and the executable search never pick a program out of the project root;
 * - normal mode removes an inherited placeholder marker; noCreds mode sets
 *   it, turns dbt's anonymous usage stats off, and removes every
 *   `DATABRICKS_*` variable and the profile / target overrides.
 *
 * Colour variables are never touched (the user reads the output), and
 * `DBT_TARGET_PATH` is left alone.
 */
export function childEnv(
  candidate: DbtCandidate,
  mode: DbtRunMode,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const win = platform === 'win32';
  const p = pathFor(platform);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') { out[k] = v; }
  }
  const same = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
  const keysOf = (name: string): string[] => Object.keys(out).filter((k) => same(k, name));
  const del = (name: string): void => { for (const k of keysOf(name)) { delete out[k]; } };
  const get = (name: string): string | undefined => {
    const k = keysOf(name)[0];
    return k === undefined ? undefined : out[k];
  };
  const set = (name: string, value: string): void => { del(name); out[name] = value; };

  // PATH: on Windows update the key that exists (usually `Path`).
  const pathKey = win ? (Object.keys(out).find((k) => /^path$/i.test(k)) ?? 'PATH') : 'PATH';
  const delimiter = win ? ';' : ':';
  const prepend = (dirs: string[]): void => {
    const current = out[pathKey] ?? '';
    const first = current.split(delimiter)[0] ?? '';
    const add = dirs.filter((d) => d !== '' && !same(d, first));
    if (add.length === 0) { return; }
    out[pathKey] = current ? `${add.join(delimiter)}${delimiter}${current}` : add.join(delimiter);
  };

  if (candidate.source === 'venv' || candidate.source === 'virtual-env') {
    const binDir = p.dirname(candidate.executable);
    prepend([binDir]);
    const base = p.basename(binDir);
    if (win ? base.toLowerCase() === 'scripts' : base === 'bin') {
      set('VIRTUAL_ENV', p.dirname(binDir));
    }
    del('PYTHONHOME');
  } else if (candidate.source === 'conda') {
    const prefix = get('CONDA_PREFIX');
    if (prefix) {
      prepend(win
        ? [
          prefix,
          p.join(prefix, 'Library', 'mingw-w64', 'bin'),
          p.join(prefix, 'Library', 'usr', 'bin'),
          p.join(prefix, 'Library', 'bin'),
          p.join(prefix, 'Scripts'),
          p.join(prefix, 'bin'),
        ]
        : [p.join(prefix, 'bin')]);
    }
  }

  set('PYTHONUNBUFFERED', '1');
  set('PYTHONIOENCODING', 'utf-8');
  for (const name of ALWAYS_DROPPED) { del(name); }
  // A log level of `none` prints nothing at all, so the failure would have no cause and no output to show
  // (belt and braces where `LOG_ARGS` are passed; the only guard for a dbt that doesn't take them).
  for (const name of SILENCING_LOG_LEVELS) {
    const v = get(name);
    if (v !== undefined && v.trim().toLowerCase() === 'none') { del(name); }
  }
  if (win) { set('NoDefaultCurrentDirectoryInExePath', '1'); }

  if (mode === 'normal') {
    del(THROWAWAY_MARKER_ENV);
  } else {
    set(THROWAWAY_MARKER_ENV, '1');
    set('DBT_SEND_ANONYMOUS_USAGE_STATS', 'false');
    for (const k of Object.keys(out)) {
      if (k.toUpperCase().startsWith('DATABRICKS_')) { delete out[k]; }
    }
    for (const name of NO_CREDS_DROPPED) { del(name); }
  }
  return out;
}

/** An argument as the header shows it: double-quoted when it holds whitespace. */
function displayArg(arg: string): string {
  return /\s/.test(arg) || arg === '' ? `"${arg}"` : arg;
}

/**
 * The spawn plan for `dbt <kind>` with `candidate` in `root`, or
 * `{ refused: 'unquotable' }` when the candidate is a `.cmd` / `.bat` shim
 * and cmd.exe cannot quote its path or an argument (`dbtSpawnCommand`).
 *
 * `file` is always the candidate's own executable and `args[0]` the dbt
 * subcommand: never an activate script, `source`, `call` or `&&`.
 */
export function planDbtSpawn(
  candidate: DbtCandidate,
  kind: DbtCommandKind,
  mode: DbtRunMode,
  opts: {
    root: string; profilesDir?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
    /** Add `logArgs` (dbt Core 1.5+ only: an older dbt or Fusion may reject them). */
    logFlags?: boolean;
  },
): DbtSpawnPlan | { refused: 'unquotable' } {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const args = dbtArgs(kind, mode, opts.profilesDir, opts.logFlags ? logArgs(env, platform) : []);
  const spawn = dbtSpawnCommand(candidate.executable, args);
  if (!spawn) { return { refused: 'unquotable' }; }
  return {
    file: spawn.file,
    args: spawn.args,
    shell: spawn.shell,
    env: childEnv(candidate, mode, env, platform),
    cwd: opts.root,
    display: `${dbtInvocation(candidate, opts.root, platform)} ${args.map(displayArg).join(' ')}`,
  };
}

/** `\r?\n` → `\r\n`: a pseudoterminal needs the carriage return. */
export function toTerminalText(chunk: string): string {
  return chunk.replace(/\r?\n/g, '\r\n');
}
