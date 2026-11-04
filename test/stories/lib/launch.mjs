// Build the extension once, stage a copy, and launch an isolated VS Code on it.
//
// Each story gets: a fresh profile (--user-data-dir / --extensions-dir) under a
// SHORT /tmp path (VS Code puts its IPC socket in the profile, and macOS caps a
// Unix socket path at 104 characters, past which the window silently exits),
// its own CDP port (port 0: the OS picks a free one when VS Code binds it, and
// the runner reads it back from the profile, so two runs at once can never
// drive each other's window; 9333 is shared with other tools), a fixed
// window size and a HOME of its own (so dialogs start in a clean temp folder,
// never the real home). Every process is killed by its --user-data-dir.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { WORKBENCH, attach, findTarget } from './cdp.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The window every story is filmed at (CSS pixels). */
export const WINDOW = { width: 1440, height: 900 };

/** The VS Code executable: $VSCODE_PATH, else the usual install for this OS. */
export function findCode() {
  if (process.env.VSCODE_PATH) return process.env.VSCODE_PATH;
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Code', path.join(os.homedir(), 'Applications/Visual Studio Code.app/Contents/MacOS/Code')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/Code.exe')]
      // The Electron binary, not /usr/bin/code (a launcher script that drops Chromium switches).
      : ['/usr/share/code/code', '/opt/vscode/code', '/opt/VSCode-linux-x64/code'];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`VS Code not found (looked in ${candidates.join(', ')}). Set VSCODE_PATH to its executable.`);
  return hit;
}

/** `npm run build`, unless told not to. Throws on a failed build. */
export function buildExtension({ skip = false } = {}) {
  if (skip) {
    if (!fs.existsSync(path.join(REPO, 'dist/extension.js'))) throw new Error('--no-build, but dist/extension.js does not exist');
    return;
  }
  const r = spawnSync('npm', ['run', 'build'], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`npm run build failed:\n${r.stdout}\n${r.stderr}`);
}

/**
 * Copy what the extension needs at runtime into `dir`, so a rebuild in the
 * repo while a window runs never films a half-written bundle.
 */
export function stageExtension(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of ['dist', 'media', 'schemas', 'syntaxes', 'package.json', 'LICENSE', 'README.md', 'CHANGELOG.md']) {
    const from = path.join(REPO, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(dir, entry), {
      recursive: true,
      filter: (src) => !src.endsWith('.map'),
    });
  }
  return dir;
}

/** A short temp dir: /tmp/erds-XXXXXX (never the long $TMPDIR on macOS). */
export function shortTempDir(prefix = 'erds-') {
  const base = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  return fs.mkdtempSync(path.join(base, prefix));
}

/**
 * The CDP port this profile's VS Code bound (launched with
 * `--remote-debugging-port=0`): Chromium writes it to `<ud>/DevToolsActivePort`
 * and prints "DevTools listening on ws://127.0.0.1:<port>/…" to its output.
 * Either way the port belongs to this process, never to another window that
 * happened to take a port picked in advance.
 */
export async function boundPort({ ud, logFile, proc, timeoutMs = 90000 }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const first = fs.readFileSync(path.join(ud, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      if (/^\d+$/.test(first) && Number(first) > 0) return Number(first);
    } catch { /* not written yet */ }
    try {
      const m = /DevTools listening on ws:\/\/[^:/\s]+:(\d+)\//.exec(fs.readFileSync(logFile, 'utf8'));
      if (m) return Number(m[1]);
    } catch { /* no output yet */ }
    if (proc.exitCode !== null) throw new Error(`VS Code exited (code ${proc.exitCode}) before it opened a CDP port`);
    await sleep(200);
  }
  throw new Error('VS Code never opened a CDP port');
}

/** The settings every story starts from: a quiet, deterministic window. */
export const STORY_SETTINGS = {
  'workbench.startupEditor': 'none',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'update.showReleaseNotes': false,
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'extensions.ignoreRecommendations': true,
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'window.titleBarStyle': 'custom',
  'window.commandCenter': true,
  'window.zoomLevel': 0,
  'window.restoreWindows': 'none',
  'window.dialogStyle': 'custom',
  // Open/Save folder dialogs are VS Code's own in-window dialog (DOM, drivable); native ones are not.
  'files.simpleDialog.enable': true,
  'workbench.colorTheme': 'Default Dark Modern',
  'telemetry.telemetryLevel': 'off',
  'erdStudio.telemetry.enabled': false,
  // No Copilot / chat surfaces in a fresh profile.
  'chat.disableAIFeatures': true,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'git.enabled': false,
  'git.openRepositoryInParentFolders': 'never',
};

/**
 * Launch VS Code for one story. `folder` is undefined for an empty window.
 * Resolves `{ port, root, ud, home, proc, kill, logFile }` once the workbench
 * is up; `port` is the CDP port this window bound (see {@link boundPort}).
 */
export async function launchVSCode({ extDir, folder, root, settings = {}, logFile }) {
  const ud = path.join(root, 'ud');
  const exts = path.join(root, 'ex');
  const home = path.join(root, 'home');
  for (const d of [path.join(ud, 'User'), exts, home]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(ud, 'User/settings.json'), JSON.stringify({ ...STORY_SETTINGS, ...settings }, null, 2));
  // The window size: VS Code opens the first Extension Development Host window
  // at the last one's size (Electron has no CDP Browser.setWindowBounds).
  const uiState = { mode: 1, x: 40, y: 40, width: WINDOW.width, height: WINDOW.height };
  fs.mkdirSync(path.join(ud, 'User/globalStorage'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'User/globalStorage/storage.json'), JSON.stringify({
    windowsState: { lastPluginDevelopmentHostWindow: { uiState }, lastActiveWindow: { uiState }, openedWindows: [] },
  }, null, 2));

  const args = [
    `--user-data-dir=${ud}`,
    `--extensions-dir=${exts}`,
    `--extensionDevelopmentPath=${extDir}`,
    // 0: the OS picks a free port as VS Code binds it (read back by boundPort).
    '--remote-debugging-port=0',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    // Keep painting while the window is hidden behind others or minimised.
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--password-store=basic');
  // HOME is a temp folder, so macOS finds no login keychain there and pops up "A keychain
  // cannot be found to store 'Code Safe Storage'" on every launch. A mock keychain keeps
  // Code's safe storage in memory and never touches the user's Keychain.
  if (process.platform === 'darwin') args.push('--use-mock-keychain');
  if (folder) args.push(`--folder-uri=${pathToFileURL(folder).href}`);

  const env = { ...process.env, HOME: home };
  if (process.platform === 'win32') env.USERPROFILE = home;
  // Running from inside VS Code's terminal leaks these; they would make Code act as node or as a CLI.
  for (const k of Object.keys(env)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('VSCODE_') && k !== 'VSCODE_PATH') delete env[k];

  const out = fs.openSync(logFile, 'a');
  const proc = spawn(findCode(), args, { env, stdio: ['ignore', out, out], detached: process.platform !== 'win32' });
  proc.unref();
  const handle = { port: undefined, root, ud, home, proc, logFile, kill: () => killByProfile(ud) };

  try {
    handle.port = await boundPort({ ud, logFile, proc });
    const target = await findTarget(handle.port, { match: WORKBENCH, timeoutMs: 90000 });
    const wb = await attach(target);
    const until = Date.now() + 60000;
    while (!(await wb.evaluate(`!!document.querySelector('.monaco-workbench .part.activitybar, .monaco-workbench .activitybar')`).catch(() => false))) {
      if (Date.now() > until) throw new Error('the workbench never rendered');
      await sleep(250);
    }
    wb.close();
  } catch (err) {
    handle.kill();
    throw new Error(`VS Code did not start${handle.port ? ` on :${handle.port}` : ''} (${err.message}). Its output is in ${logFile}`);
  }
  return handle;
}

/** Kill every process started with this profile (main, renderers, extension host). */
export function killByProfile(ud) {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${ud}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`]);
    return;
  }
  spawnSync('pkill', ['-f', '--', ud]);
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (spawnSync('pgrep', ['-f', '--', ud]).status !== 0) return;
    spawnSync('sleep', ['0.2']);
  }
  spawnSync('pkill', ['-9', '-f', '--', ud]);
}
