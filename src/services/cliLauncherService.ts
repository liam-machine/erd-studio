/**
 * The `~/.erd-studio-cli` launcher — how Claude Code reaches the bundled
 * `erd-studio` CLI from a terminal that knows nothing about VS Code.
 *
 * Layout (spec D4):
 *   ~/.erd-studio-cli/lib/cli.js        a copy of the extension's dist/cli.js
 *   ~/.erd-studio-cli/launcher.json     { extensionVersion, execPath, cliSha256, writtenAt, runtimeVerified }
 *   ~/.erd-studio-cli/bin/erd-studio    POSIX sh shim (every platform — Claude's Bash tool is Git Bash on Windows)
 *   ~/.erd-studio-cli/bin/erd-studio.cmd  Windows only
 *
 * The CLI is COPIED out of the extension folder because an extension update
 * deletes the old version folder; a shim pointing into it would break between
 * the update and the next activation. The shims prefer a Node >= 18 on PATH
 * and fall back to VS Code's own Electron with ELECTRON_RUN_AS_NODE — set only
 * on the exec line (sh) or inside `setlocal` (cmd), never exported.
 *
 * Writes happen only when the user clicks Set Up My AI Helper (`install`), or
 * on activation when that was done before (`refreshIfInstalled`) — the second
 * documented exception to "no unprompted writes". Every write is atomic (a
 * uniquely named temp file, then rename).
 *
 * No `vscode` import: every input (home dir, versions, execPath, the CLI
 * source) is injected, so this is unit-testable and host-agnostic.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { compareVersions } from '../types/feedback';

export const LAUNCHER_DIR_NAME = '.erd-studio-cli';
export const LAUNCHER_RECORD_FILE = 'launcher.json';
/** How long the Electron runtime check may take before it counts as failed. */
export const RUNTIME_VERIFY_TIMEOUT_MS = 5_000;

export interface CliLauncherOptions {
  /** The home directory the launcher lives under (the remote one in Remote/WSL). */
  homeDir: string;
  /** The running extension's package.json version. */
  extensionVersion: string;
  /** The extension host's `process.execPath` — VS Code's Electron (or a Node in tests). */
  execPath: string;
  /** Absolute path of the extension's `dist/cli.js`. */
  cliSourcePath: string;
  platform?: NodeJS.Platform;
}

export interface LauncherRecord {
  extensionVersion: string;
  execPath: string;
  cliSha256: string;
  writtenAt: string;
  /** Whether `execPath` ran a script under ELECTRON_RUN_AS_NODE at install time. */
  runtimeVerified: boolean;
}

export type CliLauncherStatus = 'missing' | 'ready' | 'stale';

export interface CliLauncherInstallResult {
  ok: boolean;
  /** The POSIX shim — the path the skill calls. */
  binPath: string;
  /** Absolute paths written by this call. */
  filesWritten: string[];
  runtimeVerified: boolean;
  error?: string;
}

export type CliLauncherRefreshOutcome =
  | 'not-installed'   // no launcher.json: the user never opted in, nothing is written
  | 'unchanged'       // everything already matches this extension
  | 'refreshed'
  | 'skipped-newer'   // a newer extension (another VS Code install) owns it and its runtime still exists
  | 'failed';

export interface CliLauncherRefreshResult {
  outcome: CliLauncherRefreshOutcome;
  filesWritten: string[];
  error?: string;
}

export interface LauncherPaths {
  root: string;
  lib: string;
  cli: string;
  record: string;
  bin: string;
  shim: string;
  cmdShim: string;
}

/** Where the launcher's files live under `homeDir` (native separators — these are real fs paths). */
export function launcherPaths(homeDir: string): LauncherPaths {
  const root = path.join(homeDir, LAUNCHER_DIR_NAME);
  const bin = path.join(root, 'bin');
  return {
    root,
    lib: path.join(root, 'lib'),
    cli: path.join(root, 'lib', 'cli.js'),
    record: path.join(root, LAUNCHER_RECORD_FILE),
    bin,
    shim: path.join(bin, 'erd-studio'),
    cmdShim: path.join(bin, 'erd-studio.cmd'),
  };
}

// ---------------------------------------------------------------------------
// Shim text
// ---------------------------------------------------------------------------

/** Paths are embedded in scripts: a newline (or, for cmd, a quote) could break out of the quoting. */
function assertEmbeddable(value: string, what: string, forCmd: boolean): void {
  if (/[\r\n\0]/.test(value)) { throw new Error(`${what} contains a line break and cannot be written into a launcher script.`); }
  if (forCmd && value.includes('"')) { throw new Error(`${what} contains a double quote and cannot be written into a .cmd script.`); }
}

/** A POSIX single-quoted literal: `'` becomes `'\''`. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A value safe inside `set "X=…"` / `"…"` in a .cmd file: `%` doubled (cmd expands it even inside quotes). */
export function cmdEscape(value: string): string {
  return value.replace(/%/g, '%%');
}

/** Forward slashes — what Git Bash accepts for `C:/…` paths. */
function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** A version string safe to print in a comment. */
function safeVersion(version: string): string {
  return /^[\w.+-]{1,64}$/.test(version) ? version : 'unknown';
}

/** The Node version probe both shims run: exits 0 only on Node >= 18 (addendum C1). */
export const NODE_PROBE_SCRIPT = 'process.exit(parseInt(process.versions.node,10) >= 18 ? 0 : 1)';

const STALE_JSON_SH =
  '{"error":{"code":"launcher-stale","message":"ERD Studio helper needs refreshing: open this project in VS Code once, or run the ERD Studio: Set Up My AI Helper command."}}';
const STALE_JSON_CMD =
  '{"error":{"code":"launcher-stale","message":"Open this project in VS Code once to refresh the ERD Studio helper."}}';

/**
 * The POSIX shim. `runtime` is VS Code's Electron, or null when it failed
 * verification — the Electron branch is then left out entirely.
 */
export function buildPosixShim(opts: { cliPath: string; runtime: string | null; version: string; platform?: NodeJS.Platform }): string {
  const win = (opts.platform ?? process.platform) === 'win32';
  const cli = win ? forwardSlashes(opts.cliPath) : opts.cliPath;
  assertEmbeddable(cli, 'The CLI path', false);
  const lines = [
    '#!/bin/sh',
    `# ERD Studio CLI launcher — written by the ERD Studio VS Code extension v${safeVersion(opts.version)}.`,
    '# Refreshed whenever the extension starts. Safe to delete ~/.erd-studio-cli at any time.',
    `CLI=${shSingleQuote(cli)}`,
    `if command -v node >/dev/null 2>&1 && node -e '${NODE_PROBE_SCRIPT}' 2>/dev/null; then`,
    '  exec node "$CLI" "$@"',
    'fi',
  ];
  if (opts.runtime) {
    const runtime = win ? forwardSlashes(opts.runtime) : opts.runtime;
    assertEmbeddable(runtime, 'The VS Code runtime path', false);
    lines.push(
      `RUNTIME=${shSingleQuote(runtime)}`,
      'if [ -x "$RUNTIME" ]; then',
      '  unset NODE_OPTIONS',
      '  ELECTRON_RUN_AS_NODE=1 exec "$RUNTIME" "$CLI" "$@"',
      'fi',
    );
  }
  lines.push(`echo '${STALE_JSON_SH}'`, 'exit 5', '');
  return lines.join('\n');
}

/**
 * The Windows `.cmd` shim (addendum C2): `goto` labels instead of
 * parenthesised blocks (so `%errorlevel%` is never expanded early), a bare
 * `exit /b` after each call to pass its exit code through, and `%` doubled in
 * the embedded paths. CRLF line endings.
 */
export function buildCmdShim(opts: { cliPath: string; runtime: string | null; version: string }): string {
  assertEmbeddable(opts.cliPath, 'The CLI path', true);
  const lines = [
    '@echo off',
    `rem ERD Studio CLI launcher - written by the ERD Studio VS Code extension v${safeVersion(opts.version)}.`,
    'setlocal',
    `set "CLI=${cmdEscape(opts.cliPath)}"`,
    'where node >nul 2>nul',
    'if errorlevel 1 goto electron',
    `node -e "${NODE_PROBE_SCRIPT}" >nul 2>nul`,
    'if errorlevel 1 goto electron',
    'node "%CLI%" %*',
    'exit /b',
    ':electron',
  ];
  if (opts.runtime) {
    assertEmbeddable(opts.runtime, 'The VS Code runtime path', true);
    lines.push(
      `set "RUNTIME=${cmdEscape(opts.runtime)}"`,
      'if not exist "%RUNTIME%" goto stale',
      'set "NODE_OPTIONS="',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"%RUNTIME%" "%CLI%" %*',
      'exit /b',
    );
  }
  lines.push(':stale', `echo ${STALE_JSON_CMD}`, 'exit /b 5', '');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** A temp name no concurrent writer (another window, another process) can share. */
function tempNameFor(target: string): string {
  return `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

/** Write `content` to a unique temp file beside `target`, then rename it over `target`. */
export function writeFileAtomic(target: string, content: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = tempNameFor(target);
  try {
    fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    if (mode !== undefined) { fs.chmodSync(tmp, mode); } // umask may have narrowed it
    fs.renameSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw err;
  }
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** The recorded launcher.json, or null when absent or unreadable. */
export function readLauncherRecord(homeDir: string): LauncherRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(launcherPaths(homeDir).record, 'utf-8')) as Partial<LauncherRecord>;
    if (typeof raw.extensionVersion !== 'string' || typeof raw.execPath !== 'string' || typeof raw.cliSha256 !== 'string') {
      return null;
    }
    return {
      extensionVersion: raw.extensionVersion,
      execPath: raw.execPath,
      cliSha256: raw.cliSha256,
      writtenAt: typeof raw.writtenAt === 'string' ? raw.writtenAt : '',
      runtimeVerified: raw.runtimeVerified === true,
    };
  } catch {
    return null;
  }
}

/**
 * Does `execPath` run a script under ELECTRON_RUN_AS_NODE (addendum C3)?
 * Spawns `execPath -e "process.stdout.write('ok')"` with a 5 s timeout.
 * Never rejects.
 */
export function verifyElectronRuntime(execPath: string, timeoutMs = RUNTIME_VERIFY_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
      delete env.NODE_OPTIONS;
      execFile(execPath, ['-e', "process.stdout.write('ok')"], { env, timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        resolve(!err && String(stdout).trim() === 'ok');
      });
    } catch {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CliLauncherDeps {
  /** Runtime check (C3); `verifyElectronRuntime` by default. */
  verifyRuntime?: (execPath: string) => Promise<boolean>;
  /** Where refresh failures are logged; console.warn by default (never a toast). */
  log?: (message: string) => void;
  now?: () => Date;
}

export class CliLauncherService {
  private readonly verifyRuntime: (execPath: string) => Promise<boolean>;
  private readonly log: (message: string) => void;
  private readonly now: () => Date;

  constructor(deps: CliLauncherDeps = {}) {
    this.verifyRuntime = deps.verifyRuntime ?? ((p) => verifyElectronRuntime(p));
    this.log = deps.log ?? ((m) => console.warn(`[CliLauncher] ${m}`));
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Write (or rewrite) the whole launcher. Runs on a user click only.
   * Never throws — a failure comes back as `{ ok: false, error }`.
   */
  async install(opts: CliLauncherOptions): Promise<CliLauncherInstallResult> {
    const platform = opts.platform ?? process.platform;
    const paths = launcherPaths(opts.homeDir);
    const filesWritten: string[] = [];
    try {
      const cli = fs.readFileSync(opts.cliSourcePath);
      const runtimeVerified = await this.verifyRuntime(opts.execPath);
      const runtime = runtimeVerified ? opts.execPath : null;

      // cli.js and the shims first, launcher.json last: its presence means a complete install.
      writeFileAtomic(paths.cli, cli);
      filesWritten.push(paths.cli);
      writeFileAtomic(paths.shim, buildPosixShim({ cliPath: paths.cli, runtime, version: opts.extensionVersion, platform }), 0o755);
      filesWritten.push(paths.shim);
      if (platform === 'win32') {
        writeFileAtomic(paths.cmdShim, buildCmdShim({ cliPath: paths.cli, runtime, version: opts.extensionVersion }));
        filesWritten.push(paths.cmdShim);
      }
      const record: LauncherRecord = {
        extensionVersion: opts.extensionVersion,
        execPath: opts.execPath,
        cliSha256: sha256(cli),
        writtenAt: this.now().toISOString(),
        runtimeVerified,
      };
      writeFileAtomic(paths.record, JSON.stringify(record, null, 2) + '\n');
      filesWritten.push(paths.record);
      return { ok: true, binPath: paths.shim, filesWritten, runtimeVerified };
    } catch (err) {
      return {
        ok: false,
        binPath: paths.shim,
        filesWritten,
        runtimeVerified: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * On activation: rewrite the launcher only if the user installed it before
   * and it no longer matches this extension. Rules (spec B.5, addendum C4):
   * - no launcher.json → nothing (the user never opted in);
   * - recorded by a NEWER extension whose runtime still exists → leave it
   *   (a second VS Code install must not downgrade it);
   * - otherwise rewrite when the version, the CLI bytes or a missing file
   *   says so, or when the recorded runtime is gone. A different execPath
   *   alone at the same version is not a reason while the recorded one still
   *   runs — two VS Code installs would otherwise take turns rewriting it.
   * Never throws; failures are logged, never shown.
   */
  async refreshIfInstalled(opts: CliLauncherOptions): Promise<CliLauncherRefreshResult> {
    try {
      const platform = opts.platform ?? process.platform;
      const paths = launcherPaths(opts.homeDir);
      if (!fs.existsSync(paths.record)) { return { outcome: 'not-installed', filesWritten: [] }; }

      const record = readLauncherRecord(opts.homeDir);
      const recordedRuntimeExists = record !== null && fs.existsSync(record.execPath);
      if (record && recordedRuntimeExists && compareVersions(opts.extensionVersion, record.extensionVersion) < 0) {
        return { outcome: 'skipped-newer', filesWritten: [] };
      }

      const needsRewrite =
        record === null
        || !recordedRuntimeExists
        || compareVersions(opts.extensionVersion, record.extensionVersion) !== 0
        || record.cliSha256 !== sha256(fs.readFileSync(opts.cliSourcePath))
        || !fs.existsSync(paths.cli)
        || !fs.existsSync(paths.shim)
        || (platform === 'win32' && !fs.existsSync(paths.cmdShim));
      if (!needsRewrite) { return { outcome: 'unchanged', filesWritten: [] }; }

      const result = await this.install(opts);
      if (!result.ok) {
        this.log(`refresh failed: ${result.error}`);
        return { outcome: 'failed', filesWritten: result.filesWritten, error: result.error };
      }
      return { outcome: 'refreshed', filesWritten: result.filesWritten };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log(`refresh failed: ${error}`);
      return { outcome: 'failed', filesWritten: [], error };
    }
  }

  /**
   * - `missing`: never installed, or a launcher file is gone;
   * - `stale`: installed by another extension version, from other CLI bytes,
   *   or for a runtime that no longer exists;
   * - `ready`: matches this extension.
   */
  status(opts: CliLauncherOptions): CliLauncherStatus {
    const platform = opts.platform ?? process.platform;
    const paths = launcherPaths(opts.homeDir);
    const record = readLauncherRecord(opts.homeDir);
    if (!record || !fs.existsSync(paths.cli) || !fs.existsSync(paths.shim)
      || (platform === 'win32' && !fs.existsSync(paths.cmdShim))) {
      return 'missing';
    }
    if (compareVersions(opts.extensionVersion, record.extensionVersion) !== 0) { return 'stale'; }
    if (!fs.existsSync(record.execPath)) { return 'stale'; }
    try {
      if (record.cliSha256 !== sha256(fs.readFileSync(opts.cliSourcePath))) { return 'stale'; }
    } catch {
      // No source to compare against (dev host without a build): versions matched, call it ready.
    }
    return 'ready';
  }
}
