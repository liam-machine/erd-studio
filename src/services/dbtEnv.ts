/**
 * dbtEnv — where the dbt project, its Python environment, the `dbt`
 * executable and `profiles.yml` are, and which dbt this is.
 *
 * Used by the canvas (venv activation before `dbt compile` / Claude sync) and
 * by the `erd-studio doctor` CLI. Every function takes its environment
 * (env vars, platform, home dir) as optional inputs so it can be tested
 * without touching the real machine.
 *
 * All knowledge of dbt flavours (Core 1.x, Fusion 2.x, Cloud CLI) lives in
 * `classifyDbtVersion` and `dbtCommands` — they change often, so keep it here.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

// ---------------------------------------------------------------------------
// Project discovery
// ---------------------------------------------------------------------------

/**
 * Directories never descended into when searching down for a dbt project.
 * Same list as `DBT_SEARCH_SKIP_DIRS` in `extension.ts`; dot-directories are
 * skipped as well.
 */
export const DBT_SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'dbt_packages', '.git', 'target', '.venv', 'venv',
]);

/** Maximum depth below the start directory searched for `dbt_project.yml`. */
export const DBT_SEARCH_MAX_DEPTH = 3;

function hasDbtProjectFile(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, 'dbt_project.yml')).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the dbt project a command run from `start` belongs to: `start` itself,
 * then each ancestor up to the filesystem root, then a breadth-first search
 * up to `DBT_SEARCH_MAX_DEPTH` levels below `start` (shallowest match wins,
 * siblings in name order). Null when there is none.
 */
export function findDbtProjectDir(start: string, maxDepth = DBT_SEARCH_MAX_DEPTH): string | null {
  const origin = path.resolve(start);

  for (let dir = origin; ; dir = path.dirname(dir)) {
    if (hasDbtProjectFile(dir)) { return dir; }
    if (path.dirname(dir) === dir) { break; }
  }

  let frontier = [origin];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!entry.isDirectory() || DBT_SEARCH_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue;
        }
        const child = path.join(dir, entry.name);
        if (hasDbtProjectFile(child)) { return child; }
        next.push(child);
      }
    }
    frontier = next;
  }

  return null;
}

export interface DbtProjectIdentity {
  /** `name:` from dbt_project.yml. */
  name: string | null;
  /** `profile:` from dbt_project.yml — the key looked up in profiles.yml. */
  profile: string | null;
  /** `packages-install-path:` (dbt's default `dbt_packages`), project-relative. */
  packagesInstallPath: string;
}

/**
 * Read the non-path identity keys of `dbt_project.yml`. A missing or
 * malformed file yields nulls and the default install path — never throws.
 */
export function readDbtProjectIdentity(root: string): DbtProjectIdentity {
  const identity: DbtProjectIdentity = { name: null, profile: null, packagesInstallPath: 'dbt_packages' };
  const doc = readYamlMap(path.join(root, 'dbt_project.yml'));
  if (!doc) { return identity; }

  if (typeof doc.name === 'string' && doc.name.trim()) { identity.name = doc.name.trim(); }
  if (typeof doc.profile === 'string' && doc.profile.trim()) { identity.profile = doc.profile.trim(); }
  const installPath = doc['packages-install-path'];
  if (typeof installPath === 'string' && installPath.trim()) {
    identity.packagesInstallPath = installPath.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Virtual environments
// ---------------------------------------------------------------------------

/** Project-local venv folder names, in the order they are tried. */
export const VENV_CANDIDATES: readonly string[] = ['.venv', 'venv', 'env'];

/** Path helpers for `platform`, so a Windows layout can be reasoned about anywhere. */
function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The first project-local venv (`.venv`, `venv`, `env`) that has an activate
 * script for `platform` — `Scripts\activate.bat` on Windows, `bin/activate`
 * elsewhere. Returns the venv's absolute directory, or null.
 */
export function findVenvDir(root: string, platform: NodeJS.Platform = process.platform): string | null {
  for (const dir of VENV_CANDIDATES) {
    const venvDir = path.join(root, dir);
    const script = platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'activate.bat')
      : path.join(venvDir, 'bin', 'activate');
    if (fs.existsSync(script)) { return venvDir; }
  }
  return null;
}

/**
 * The shell command that activates `venvDir` in a terminal: a quoted
 * `activate.bat` on Windows, `source '<dir>/bin/activate'` elsewhere (single
 * quotes escaped).
 */
export function venvActivateCommand(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const bat = p.join(venvDir, 'Scripts', 'activate.bat');
    return `"${bat.replace(/"/g, '')}"`;
  }
  const sh = p.join(venvDir, 'bin', 'activate');
  return `source '${sh.replace(/'/g, "'\\''")}'`;
}

/** `findVenvDir` + `venvActivateCommand`: the activate command for the project's venv, or null. */
export function findVenvActivate(root: string, platform: NodeJS.Platform = process.platform): string | null {
  const venvDir = findVenvDir(root, platform);
  return venvDir ? venvActivateCommand(venvDir, platform) : null;
}

// ---------------------------------------------------------------------------
// dbt executables
// ---------------------------------------------------------------------------

/**
 * Where a dbt executable was found. `override` is an explicit `--dbt <path>`;
 * `venv` a project-local venv; `virtual-env` / `conda` the activated
 * `$VIRTUAL_ENV` / `$CONDA_PREFIX`; `path` the first `dbt` on `$PATH`;
 * `shim` a pyenv shim or pipx/`~/.local/bin` install that is not on `$PATH`
 * for this process.
 */
export type DbtSource = 'override' | 'venv' | 'virtual-env' | 'conda' | 'path' | 'shim';

export interface DbtCandidate {
  /** Absolute path of the executable. */
  executable: string;
  source: DbtSource;
  /**
   * The first `dbt` on `$PATH` is this same file (an activated venv or conda
   * env, say), so a shell in the project root runs it as bare `dbt`.
   */
  onPath?: boolean;
}

export interface DbtEnvOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Test seam: whether `file` exists and is a runnable file. */
  isExecutable?: (file: string) => boolean;
}

function defaultIsExecutable(platform: NodeJS.Platform): (file: string) => boolean {
  return (file) => {
    try {
      if (!fs.statSync(file).isFile()) { return false; }
      if (platform !== 'win32') { fs.accessSync(file, fs.constants.X_OK); }
      return true;
    } catch {
      return false;
    }
  };
}

/** File names a `dbt` executable can have on `platform` (PATHEXT order on Windows). */
function dbtFileNames(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform !== 'win32') { return ['dbt']; }
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return exts.map((e) => `dbt${e}`);
}

/** The first runnable `dbt` in `dir`, or null. */
function dbtIn(
  dir: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isExecutable: (file: string) => boolean,
): string | null {
  const p = pathFor(platform);
  for (const name of dbtFileNames(platform, env)) {
    const file = p.join(dir, name);
    if (isExecutable(file)) { return file; }
  }
  return null;
}

/** The directory an environment keeps its executables in: `Scripts` on Windows venvs. */
function envBinDirs(prefix: string, platform: NodeJS.Platform): string[] {
  const p = pathFor(platform);
  // Conda on Windows puts entry points in Scripts; a bare prefix holds python.exe.
  return platform === 'win32' ? [p.join(prefix, 'Scripts'), prefix] : [p.join(prefix, 'bin')];
}

/**
 * Every dbt executable worth trying, most specific first, de-duplicated:
 * an explicit `override` path (an executable, or a directory holding one),
 * the project venv, `$VIRTUAL_ENV`, `$CONDA_PREFIX`, the first `dbt` on
 * `$PATH`, then pyenv shims and `~/.local/bin` (pipx) when those are not
 * already on `$PATH`. Only files that exist (and are executable off
 * Windows) are returned. Never runs anything.
 */
export function dbtExecutableCandidates(
  root: string,
  opts: DbtEnvOptions & { override?: string | null } = {},
): DbtCandidate[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();
  const isExecutable = opts.isExecutable ?? defaultIsExecutable(platform);
  const p = pathFor(platform);

  const out: DbtCandidate[] = [];
  const seen = new Set<string>();
  const add = (executable: string | null, source: DbtSource): void => {
    if (!executable) { return; }
    const key = platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) {
      if (source === 'path') {
        const same = out.find((c) => (platform === 'win32' ? c.executable.toLowerCase() : c.executable) === key);
        if (same) { same.onPath = true; }
      }
      return;
    }
    seen.add(key);
    out.push({ executable, source });
  };

  if (opts.override) {
    const override = p.resolve(root, opts.override);
    add(isExecutable(override) ? override : dbtIn(override, platform, env, isExecutable), 'override');
  }

  for (const dir of VENV_CANDIDATES) {
    for (const bin of envBinDirs(p.join(root, dir), platform)) {
      add(dbtIn(bin, platform, env, isExecutable), 'venv');
    }
  }

  if (env.VIRTUAL_ENV) {
    for (const bin of envBinDirs(env.VIRTUAL_ENV, platform)) {
      add(dbtIn(bin, platform, env, isExecutable), 'virtual-env');
    }
  }
  if (env.CONDA_PREFIX) {
    for (const bin of envBinDirs(env.CONDA_PREFIX, platform)) {
      add(dbtIn(bin, platform, env, isExecutable), 'conda');
    }
  }

  const pathDirs = (env.PATH ?? env.Path ?? '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  for (const dir of pathDirs) {
    const found = dbtIn(dir, platform, env, isExecutable);
    if (found) {
      add(found, 'path');
      break; // Only the one the shell would run.
    }
  }

  const pyenvRoot = env.PYENV_ROOT || p.join(homeDir, '.pyenv');
  const shimDirs = [p.join(pyenvRoot, 'shims'), p.join(homeDir, '.local', 'bin')];
  for (const dir of shimDirs) {
    add(dbtIn(dir, platform, env, isExecutable), 'shim');
  }

  return out;
}

// ---------------------------------------------------------------------------
// Version classification
// ---------------------------------------------------------------------------

export type DbtFlavour = 'core-v1' | 'fusion-v2' | 'cloud-cli' | 'unknown';

export interface DbtVersionInfo {
  flavour: DbtFlavour;
  /** e.g. "1.9.4", "2.0.1", "0.40.14"; null when the output names none. */
  version: string | null;
}

/** Terminal colour / cursor escapes, which some dbt builds print even when piped. */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Classify `dbt --version` output.
 *
 *   `dbt Cloud CLI - 0.40.14 (…)`            → cloud-cli
 *   `Core:\n  - installed: 1.9.4`            → core-v1
 *   `dbt 2.0.1` / `dbt-fusion 2.0.0-preview` → fusion-v2
 *   `installed version: 1.0.0` (dbt ≤ 1.4)  → core-v1
 *   anything else                           → unknown
 */
export function classifyDbtVersion(output: string): DbtVersionInfo {
  const text = output.replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n');

  const cloud = /^\s*(dbt )?Cloud CLI - (\S+)/m.exec(text);
  if (cloud) { return { flavour: 'cloud-cli', version: cloud[2] }; }

  const core = /Core:\s*\n\s*-\s*installed:\s*(1\.\S+)/.exec(text);
  if (core) { return { flavour: 'core-v1', version: core[1] }; }

  const fusion = /^dbt(-fusion)?\s+(2\.\S+)/m.exec(text);
  if (fusion) { return { flavour: 'fusion-v2', version: fusion[2] }; }

  // dbt-core 1.0–1.4 printed "installed version: 1.x.y" before the Core: block existed.
  const legacyCore = /^\s*installed version:\s*(1\.\S+)/m.exec(text);
  if (legacyCore) { return { flavour: 'core-v1', version: legacyCore[1] }; }

  return { flavour: 'unknown', version: null };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** POSIX single-quote `value` when it holds anything a shell would split or expand. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Whether running `candidate` means running a program the project itself
 * ships: a project-local venv that is not also what `$PATH` resolves to. A
 * cloned repository can contain an executable `.venv/bin/dbt` that is
 * anything at all, so `doctor` only runs one after the user has seen its
 * path (`--trust-venv`). An activated venv (on `$PATH`) is one the user
 * chose to run, and an explicit `--dbt` is one they named.
 */
export function isUntrustedProjectExecutable(candidate: DbtCandidate): boolean {
  return candidate.source === 'venv' && candidate.onPath !== true;
}

/**
 * How to type `candidate` at a shell prompt in the project root. A `path`
 * hit (or any candidate that is also the first `dbt` on `$PATH`) is bare
 * `dbt`; an executable inside the project is project-relative
 * with forward slashes (`.venv/bin/dbt`); anything else is its absolute path
 * with forward slashes. Quoted POSIX-style, because Claude Code's Bash tool
 * runs a POSIX shell on every platform (Git Bash on Windows).
 */
export function dbtInvocation(candidate: DbtCandidate, root: string, platform: NodeJS.Platform = process.platform): string {
  if (candidate.source === 'path' || candidate.onPath === true) { return 'dbt'; }
  const p = pathFor(platform);
  const rel = p.relative(root, candidate.executable);
  const inside = rel !== '' && !rel.startsWith('..') && !p.isAbsolute(rel);
  const shown = (inside ? rel : candidate.executable).replace(/\\/g, '/');
  return shellQuote(shown);
}

export interface DbtCommands {
  parse: string | null;
  catalog: string | null;
  debug: string | null;
}

/**
 * Ready-to-run commands for `flavour` through `invocation` (see
 * `dbtInvocation`). The catalog is `docs generate` everywhere except Fusion,
 * which writes it with `compile --write-catalog`. The Cloud CLI has no
 * `dbt debug`, and its catalog is built remotely — callers should say local
 * output is not guaranteed. A null flavour (no dbt found) gives no commands.
 */
export function dbtCommands(flavour: DbtFlavour | null, invocation: string): DbtCommands {
  if (flavour === null) { return { parse: null, catalog: null, debug: null }; }
  switch (flavour) {
    case 'fusion-v2':
      return {
        parse: `${invocation} parse`,
        catalog: `${invocation} compile --write-catalog`,
        debug: `${invocation} debug`,
      };
    case 'cloud-cli':
      return { parse: `${invocation} parse`, catalog: `${invocation} docs generate`, debug: null };
    case 'core-v1':
    case 'unknown':
    default:
      return {
        parse: `${invocation} parse`,
        catalog: `${invocation} docs generate`,
        debug: `${invocation} debug`,
      };
  }
}

// ---------------------------------------------------------------------------
// Running dbt --version
// ---------------------------------------------------------------------------

/** How long `dbt --version` may take — a cold Python start on Windows can be slow. */
export const DBT_VERSION_TIMEOUT_MS = 20_000;

export interface DbtVersionRun {
  /** stdout + stderr, or null when the executable could not be run at all. */
  output: string | null;
  error?: string;
}

/**
 * How to spawn `<executable> --version`. `.cmd` / `.bat` shims (pyenv-win's
 * are `.bat`) cannot be spawned without a shell on Windows, and with
 * `shell: true` Node hands cmd.exe the command and its arguments joined by
 * spaces — so the path is double-quoted (a space in `C:\Users\John Smith`
 * would otherwise split it, and `&` in a folder name would start a second
 * command). Inside double quotes cmd still expands `%VAR%`, and a `"` or a
 * line break cannot be quoted at all, so such a path is refused (null).
 */
export function dbtVersionSpawn(executable: string): { file: string; args: string[]; shell: boolean } | null {
  if (!/\.(cmd|bat)$/i.test(executable)) {
    return { file: executable, args: ['--version'], shell: false };
  }
  if (/["%\r\n]/.test(executable)) { return null; }
  return { file: `"${executable}"`, args: ['--version'], shell: true };
}

/**
 * Run `<executable> --version` with a timeout. Never rejects. Output is kept
 * even on a non-zero exit, because some builds exit 1 when an update is
 * available but still print the version.
 */
export function runDbtVersion(
  executable: string,
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<DbtVersionRun> {
  return new Promise((resolve) => {
    const spawn = dbtVersionSpawn(executable);
    if (!spawn) {
      resolve({ output: null, error: 'unsupported path: cmd.exe cannot quote it safely' });
      return;
    }
    try {
      execFile(
        spawn.file,
        spawn.args,
        {
          cwd: opts.cwd,
          env: opts.env ?? process.env,
          timeout: opts.timeoutMs ?? DBT_VERSION_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          shell: spawn.shell,
        },
        (err, stdout, stderr) => {
          const output = `${stdout ?? ''}${stderr ?? ''}`;
          if (output.trim()) {
            resolve({ output, ...(err ? { error: err.message } : {}) });
          } else {
            resolve({ output: null, error: err ? err.message : 'no output' });
          }
        },
      );
    } catch (err) {
      resolve({ output: null, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export interface DbtProbeResult extends DbtVersionInfo {
  candidate: DbtCandidate;
  rawOutput: string;
}

/**
 * Run `--version` on each candidate in order and return the first that
 * prints anything, classified. Null when none runs.
 */
export async function probeDbt(
  candidates: readonly DbtCandidate[],
  run: (executable: string) => Promise<DbtVersionRun> = (exe) => runDbtVersion(exe),
): Promise<DbtProbeResult | null> {
  for (const candidate of candidates) {
    const { output } = await run(candidate.executable);
    if (output === null) { continue; }
    return { candidate, rawOutput: output, ...classifyDbtVersion(output) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// profiles.yml
// ---------------------------------------------------------------------------

/**
 * `file` as a user would recognise it: project-relative (forward slashes)
 * inside `root`, `~/…` inside the home directory, else absolute.
 */
export function displayPath(file: string, root: string, homeDir: string = os.homedir()): string {
  const relRoot = path.relative(root, file);
  if (relRoot && !relRoot.startsWith('..') && !path.isAbsolute(relRoot)) {
    return relRoot.replace(/\\/g, '/');
  }
  const relHome = path.relative(homeDir, file);
  if (relHome && !relHome.startsWith('..') && !path.isAbsolute(relHome)) {
    return `~/${relHome.replace(/\\/g, '/')}`;
  }
  return file.replace(/\\/g, '/');
}

export interface ProfilesInfo {
  /** False for the Cloud CLI, which keeps connection details in dbt Cloud. */
  required: boolean;
  found: boolean;
  /** The profiles.yml dbt will read, as `displayPath` shows it. */
  path: string | null;
  /** Every location looked at, in dbt's order, as `displayPath` shows them. */
  searched: string[];
  /**
   * Whether that profiles.yml has a top-level key equal to the project's
   * `profile:`. Null when there is no file, no `profile:`, or it will not parse.
   */
  profileDefined: boolean | null;
}

/**
 * Locate `profiles.yml` the way dbt does: `$DBT_PROFILES_DIR`, then
 * `$DBT_ENGINE_PROFILES_DIR`, then the project root, then `~/.dbt/`. The
 * first existing file wins. Skipped entirely for the Cloud CLI.
 */
export function findProfiles(
  root: string,
  opts: {
    flavour?: DbtFlavour | null;
    profileName?: string | null;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
  } = {},
): ProfilesInfo {
  if (opts.flavour === 'cloud-cli') {
    return { required: false, found: false, path: null, searched: [], profileDefined: null };
  }

  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  const dirs = [
    env.DBT_PROFILES_DIR,
    env.DBT_ENGINE_PROFILES_DIR,
    root,
    path.join(homeDir, '.dbt'),
  ].filter((d): d is string => typeof d === 'string' && d.trim() !== '');

  const files: string[] = [];
  for (const dir of dirs) {
    const file = path.join(path.resolve(root, dir), 'profiles.yml');
    if (!files.includes(file)) { files.push(file); }
  }

  const searched = files.map((f) => displayPath(f, root, homeDir));
  const hit = files.find((f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  });
  if (!hit) {
    return { required: true, found: false, path: null, searched, profileDefined: null };
  }

  let profileDefined: boolean | null = null;
  if (opts.profileName) {
    const doc = readYamlMap(hit);
    profileDefined = doc ? Object.prototype.hasOwnProperty.call(doc, opts.profileName) : null;
  }
  return { required: true, found: true, path: displayPath(hit, root, homeDir), searched, profileDefined };
}

// ---------------------------------------------------------------------------
// Packages (dbt deps)
// ---------------------------------------------------------------------------

export interface DepsStatus {
  /** `packages.yml` or `dependencies.yml` when it lists packages, else null. */
  packagesFile: string | null;
  /** Where `dbt deps` installs them, project-relative. */
  installPath: string;
  /** The install path exists and has something in it. */
  installed: boolean;
  /** Packages are declared but not installed — run `dbt deps` before parsing. */
  needsDeps: boolean;
}

/**
 * Whether `dbt deps` must run before `dbt parse` can succeed: a
 * `packages.yml` (or a `dependencies.yml` with a `packages:` list — one with
 * only `projects:` is dbt Mesh and installs nothing) declares packages and
 * the install path is missing or empty.
 */
export function detectDepsStatus(root: string, installPath = readDbtProjectIdentity(root).packagesInstallPath): DepsStatus {
  let packagesFile: string | null = null;
  for (const name of ['packages.yml', 'dependencies.yml']) {
    const doc = readYamlMap(path.join(root, name));
    if (doc && Array.isArray(doc.packages) && doc.packages.length > 0) {
      packagesFile = name;
      break;
    }
  }

  let installed = false;
  try {
    installed = fs.readdirSync(path.resolve(root, installPath)).some((e) => !e.startsWith('.'));
  } catch {
    installed = false;
  }

  return { packagesFile, installPath, installed, needsDeps: packagesFile !== null && !installed };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YAML file whose top level is a map; null when missing, unreadable or not a map. */
function readYamlMap(file: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const doc: unknown = parseYaml(raw);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
