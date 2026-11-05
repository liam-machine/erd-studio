// The isolated VS Code the default cut is recorded in. Nothing here touches your own VS Code:
// its own --user-data-dir and --extensions-dir under /tmp/erdrec (short, because macOS caps the
// length of the Unix socket path inside the profile), its own CDP port (9555, never the shared
// 9333), a mock keychain (no "Code Safe Storage" prompt), and quit() only ever signals the
// processes whose command line names this profile.
//
//   node record/vscode.mjs setup        build the VSIX from this checkout and install it into the profile
//   node record/vscode.mjs launch <dir> open <dir> in the isolated window (1440x600, clean state)
//   node record/vscode.mjs quit
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, sleep } from './driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
export const PROFILE = '/tmp/erdrec';
const UD = join(PROFILE, 'ud');
const EXT = join(PROFILE, 'ext');
const CODE = process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const CLI = process.env.VSCODE_CLI ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

/** The window's size in CSS px. At devicePixelRatio 2 the screencast scales it to the 1728x720 inset (1.2x). */
export const WINDOW = { width: 1440, height: 600 };

/** A clean, quiet editor: dark default theme, no AI/chat UI, no welcome page, no telemetry, DOM menus and dialogs (CDP can film and click those, not native ones). */
export const SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.view.alwaysShowHeaderActions': true,
  'workbench.editor.empty.hint': 'hidden',
  'window.commandCenter': true,
  'window.dialogStyle': 'custom',
  'window.menuStyle': 'custom',
  'window.titleBarStyle': 'custom',
  'window.restoreWindows': 'none',
  'window.zoomLevel': 0,
  'files.simpleDialog.enable': true,
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'extensions.autoCheckUpdates': false,
  'extensions.ignoreRecommendations': true,
  'telemetry.telemetryLevel': 'off',
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'chat.agent.enabled': false,
  'github.copilot.enable': { '*': false },
  'editor.minimap.enabled': false,
  'editor.fontSize': 14,
  'git.enabled': false,
  'scm.diffDecorations': 'none',
  'explorer.compactFolders': false,
  'erdStudio.telemetry.enabled': false,
  'erdStudio.checkKnownFixes': false,
};

/**
 * ERD Studio's own state on a machine that has just installed it, minus the Show Me Around guide
 * (its coach marks would cover the canvas): no example shown yet, so a folder's first visit opens
 * the coffee-shop example, as it does for a new user.
 */
const EXTENSION_STATE = { 'erdStudio.gettingStartedShown': true, 'erdStudio.onboardingGuide': 'skipped' };

const pids = () => {
  try { return execFileSync('pgrep', ['-f', `user-data-dir=${UD}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); }
  catch { return []; }
};

export async function quit() {
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    const list = pids();
    if (!list.length) return;
    for (const p of list) { try { process.kill(p, sig); } catch {} }
    for (let i = 0; i < 20 && pids().length; i++) await sleep(150);
  }
}

/** Builds the VSIX from this checkout (vsce runs `npm run package`) and installs it into the isolated profile. */
export function setup() {
  mkdirSync(join(UD, 'User'), { recursive: true });
  mkdirSync(EXT, { recursive: true });
  const vsix = join(PROFILE, 'erd-studio.vsix');
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '-o', vsix], { cwd: REPO, stdio: 'inherit' });
  execFileSync(CLI, [`--user-data-dir=${UD}`, `--extensions-dir=${EXT}`, '--install-extension', vsix, '--force'], { stdio: 'inherit' });
}

function sqlite(db, sql) { execFileSync('sqlite3', [db, sql]); }

/** Resets the profile to a first run (settings, window size, no workspace history, fresh extension state) and opens `folder`. */
export async function launch(folder) {
  await quit();
  if (!existsSync(join(EXT, 'extensions.json'))) throw new Error('no ERD Studio in the isolated profile: run `node record/vscode.mjs setup` first');
  mkdirSync(join(UD, 'User', 'globalStorage'), { recursive: true });
  writeFileSync(join(UD, 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  rmSync(join(UD, 'User', 'workspaceStorage'), { recursive: true, force: true });
  rmSync(join(UD, 'User', 'globalStorage', 'liamwynne.erd-studio'), { recursive: true, force: true });
  rmSync(join(UD, 'Backups'), { recursive: true, force: true });
  // the window's size and place: VS Code restores the last window's bounds from storage.json
  const storage = join(UD, 'User', 'globalStorage', 'storage.json');
  const st = existsSync(storage) ? JSON.parse(readFileSync(storage, 'utf8')) : {};
  st.windowsState = { lastActiveWindow: { uiState: { mode: 1, x: 120, y: 120, ...WINDOW } }, openedWindows: [] };
  writeFileSync(storage, JSON.stringify(st, null, 1));
  const db = join(UD, 'User', 'globalStorage', 'state.vscdb');
  if (existsSync(db)) {
    const version = JSON.parse(readFileSync(join(EXT, 'extensions.json'), 'utf8')).find((e) => e.identifier.id === 'liamwynne.erd-studio')?.version;
    const state = JSON.stringify({ lastActivatedVersion: version, ...EXTENSION_STATE }).replace(/'/g, "''");
    sqlite(db, `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('liamwynne.erd-studio', '${state}')`);
    // the side bar's view sizes and collapsed sections start from VS Code's defaults
    sqlite(db, "DELETE FROM ItemTable WHERE key LIKE 'workbench.view.extension.erd-studio%' OR key LIKE 'workbench.explorer%' OR key LIKE 'workbench.extensions%'");
  }
  const child = spawn(CODE, [`--user-data-dir=${UD}`, `--extensions-dir=${EXT}`, '--use-mock-keychain', `--remote-debugging-port=${PORT}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--new-window', folder], { detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list.some((t) => t.type === 'page' && t.url.includes('workbench'))) break;
    } catch {}
    await sleep(250);
  }
  // the port must be this profile's window, never someone else's
  const owner = execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n').map(Number);
  if (!owner.some((p) => pids().includes(p))) throw new Error(`port ${PORT} is not the isolated VS Code's`);
  await sleep(4000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'setup') setup();
  else if (cmd === 'launch') await launch(arg);
  else if (cmd === 'quit') await quit();
  else console.log('usage: node record/vscode.mjs setup | launch <folder> | quit');
}
