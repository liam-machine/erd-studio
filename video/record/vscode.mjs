// The isolated VS Code the default cut is recorded in. Nothing here touches your own VS Code:
// its own --user-data-dir and --extensions-dir under /tmp/erdrec (short, because macOS caps the
// length of the Unix socket path inside the profile), its own CDP port (9555, never the shared
// 9333), a mock keychain (no "Code Safe Storage" prompt), and quit() only ever signals the
// processes whose command line names this profile.
//
//   node record/vscode.mjs setup        build the VSIX from this checkout and install it into the profile
//   node record/vscode.mjs launch <dir> open <dir> in the isolated window (1440x600 at 2x, clean state)
//   node record/vscode.mjs quit
//
// The window gets its own HOME (/tmp/erdrec/home) and PATH (/tmp/erdrec/bin first, then the system
// folders), and VSCODE_CLI=1 so VS Code keeps that environment rather than reading your login
// shell's: nothing ERD Studio writes to a home folder (the CLI launcher) lands in yours, and the dbt
// it finds is the recording's own (bin/dbt, real dbt Core through uvx), never one on your PATH;
// bin/ also links PostgreSQL's pg_dump and psql (the export scene dumps the local shop database). The
// integrated terminal is a bare zsh (no rc files of yours, prompt `$ `) whose HOME is your real one,
// so Claude Code uses the login you already have, and whose `claude` runs with project and local
// settings only (none of your user settings, hooks, plugins or MCP servers; see terminalEnv()).
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT, sleep } from './driver.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
export const PROFILE = '/tmp/erdrec';
const UD = join(PROFILE, 'ud');
const EXT = join(PROFILE, 'ext');
const CODE = process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const CLI = process.env.VSCODE_CLI_BIN ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';
/** The window's own HOME, PATH folder and terminal shell config. */
const HOME = join(PROFILE, 'home');
export const BIN = join(PROFILE, 'bin');
const ZDOT = join(PROFILE, 'zdot');
/** The system folders after BIN: nothing from your own PATH. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** The window's size in CSS px. It renders at devicePixelRatio DPR (forced, whatever the display's), so the screencast's 1728x720 frames (the inset, 1.2x) are scaled down from 2880x1200, never up. */
export const WINDOW = { width: 1440, height: 600 };
/** The device pixel ratio the window renders at (--force-device-scale-factor): 2, as on a Retina display, so the footage is sharp. */
export const DPR = 2;

/** A clean, quiet editor: VS Code's light default theme (Light Modern), no AI/chat UI, no welcome page, no telemetry, DOM menus and dialogs (CDP can film and click those, not native ones). */
export const SETTINGS = {
  'workbench.startupEditor': 'none',
  'workbench.colorTheme': 'Default Light Modern',
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
  // The tour clicks its import itself: no automatic draft or start notification over the start entry.
  'erdStudio.startSuggestions': false,
  // The terminal Claude Code runs in: a bare zsh (terminalEnv), the DOM renderer (screenText reads
  // its rows, for the privacy check and the tests), no shell-integration gutter marks.
  'terminal.integrated.defaultProfile.osx': 'tour',
  'terminal.integrated.profiles.osx': { tour: { path: '/bin/zsh', args: ['-i'] } },
  'terminal.integrated.gpuAcceleration': 'off',
  'terminal.integrated.shellIntegration.enabled': false,
  'terminal.integrated.fontSize': 13,
  'terminal.integrated.enablePersistentSessions': false,
  'terminal.integrated.showExitAlert': false,
  'terminal.integrated.tabs.enabled': false,
  'terminal.integrated.stickyScroll.enabled': false,
  'terminal.integrated.suggest.enabled': false,
  'workbench.panel.defaultLocation': 'right',
};

/**
 * The terminal's environment (terminal.integrated.env.osx, written by launch): your real HOME, so
 * Claude Code finds the login you already have (it never logs in here), the recording's PATH, and a
 * ZDOTDIR whose .zshrc is ours alone.
 */
export const terminalEnv = () => ({ HOME: homedir(), ZDOTDIR: ZDOT, PATH: `${BIN}:${SYSTEM_PATH}` });

/**
 * The flags `claude` runs with in the tour's terminal: your project and local settings only (the
 * folder's .claude/settings.local.json, where Set Up My AI Helper registers its hook), no MCP
 * servers, edits accepted without asking (only inside the folder it runs in), no shell commands at
 * all (it reads and edits files, nothing else, and never stops to ask), and a fast model. The one
 * added instruction says only that: no shell here (so it does not offer to run the CLI check it
 * cannot run), and a short reply that fits the terminal.
 */
export const CLAUDE_FLAGS = ['--setting-sources', 'project,local', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--permission-mode', 'acceptEdits', '--disallowedTools', 'Bash', '--model', 'sonnet',
  '--append-system-prompt', 'Shell commands are off in this session by design. Do not run or mention erd-studio doctor, a check, or that files are unchecked. End with two short sentences on what you changed.'];

/** The bare shell config: prompt `$ `, no history, no rc file of yours; `claude` with CLAUDE_FLAGS, IS_DEMO (Claude Code hides the account it is signed in with) and no prompt suggestions. */
const ZSHRC = `# The tour's terminal (video/record/vscode.mjs): none of your own shell config.
PS1='$ '
RPROMPT=''
unsetopt PROMPT_SP
HISTFILE=/dev/null
export PATH='${BIN}:${SYSTEM_PATH}'
export IS_DEMO=1
# no prompt suggestions: a greyed-out next request under the reply would read as one the viewer typed
export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false
claude() { command claude ${CLAUDE_FLAGS.map((f) => `'${f}'`).join(' ')} "$@"; }
`;

/**
 * dbt for Run dbt parse: real dbt Core with the DuckDB adapter, pinned, through uvx (its own cache
 * under the profile, Python 3.12, no warnings or anonymous usage stats).
 */
export const DBT_UVX_ARGS = ['--quiet', '--python', '3.12', '--from', 'dbt-core==1.12.6', '--with', 'dbt-duckdb==1.11.1', 'dbt'];
export const DBT_ENV = { UV_CACHE_DIR: join(PROFILE, 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(PROFILE, 'uv-python'), UV_PYTHON_PREFERENCE: 'only-managed', PYTHONWARNINGS: 'ignore', DBT_SEND_ANONYMOUS_USAGE_STATS: 'false' };
const DBT_SHIM = (uvx) => `#!/bin/sh
# The recording's dbt (video/record/vscode.mjs): dbt Core with dbt-duckdb, through uvx.
${Object.entries(DBT_ENV).map(([k, v]) => `export ${k}='${v}'`).join('\n')}
exec '${uvx}' ${DBT_UVX_ARGS.map((a) => `'${a}'`).join(' ')} "$@"
`;

/** PostgreSQL's client tools on the window's PATH (the export scene runs pg_dump; fixtures.mjs runs psql). */
export const PG_TOOLS = ['pg_dump', 'psql'];

/** Runs `dbt --version` the way bin/dbt does, so the first Run dbt parse on camera finds uvx's cache warm. */
export function warmDbt() {
  execFileSync(which('uvx'), [...DBT_UVX_ARGS, '--version'], { stdio: 'ignore', env: { ...process.env, ...DBT_ENV } });
}

/** The real file a tool on your PATH runs (CLAUDE_BIN / UVX_BIN / PG_DUMP_BIN / PSQL_BIN override; terminal-app shims skipped; then Homebrew's bin), or throws. */
export function which(tool) {
  const override = process.env[`${tool.toUpperCase()}_BIN`];
  if (override) return realpathSync(override);
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || /shim/i.test(dir)) continue;
    const f = join(dir, tool);
    if (existsSync(f)) return realpathSync(f);
  }
  // Homebrew's folder, when the shell running this has not put it on PATH (PostgreSQL's tools live there)
  if (existsSync(join('/opt/homebrew/bin', tool))) return realpathSync(join('/opt/homebrew/bin', tool));
  throw new Error(`${tool} is not on your PATH`);
}

/** The recording's HOME, bin (claude, dbt, uvx) and terminal config, written fresh. */
function writeEnvironment() {
  rmSync(BIN, { recursive: true, force: true });
  mkdirSync(BIN, { recursive: true });
  mkdirSync(ZDOT, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  const uvx = which('uvx');
  symlinkSync(which('claude'), join(BIN, 'claude'));
  symlinkSync(uvx, join(BIN, 'uvx'));
  // PostgreSQL's own client tools, for the export scene's pg_dump (the shop database record/fixtures.mjs makes)
  for (const tool of PG_TOOLS) symlinkSync(which(tool), join(BIN, tool));
  writeFileSync(join(BIN, 'dbt'), DBT_SHIM(uvx));
  chmodSync(join(BIN, 'dbt'), 0o755);
  writeFileSync(join(ZDOT, '.zshrc'), ZSHRC);
  writeFileSync(join(ZDOT, '.zshenv'), '');
}

/**
 * ERD Studio's own state on a machine that has just installed it, minus the Show Me Around guide
 * (its coach marks would cover the canvas): no example shown yet, so a folder's first visit opens
 * the coffee-shop example, as it does for a new user.
 */
const EXTENSION_STATE = { 'erdStudio.gettingStartedShown': true, 'erdStudio.onboardingGuide': 'skipped' };

/** The Explorer's sections: Outline and Timeline hidden (VS Code's own view state), the file tree and Open Editors as VS Code has them. */
const EXPLORER_HIDDEN = [{ id: 'outline', isHidden: true }, { id: 'timeline', isHidden: true }, { id: 'workbench.explorer.openEditorsView', isHidden: true }, { id: 'workbench.explorer.fileView', isHidden: false }];

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

/** The window's environment: its own HOME and PATH, kept as they are (VSCODE_CLI=1: no login-shell environment). */
function windowEnv() {
  const env = { HOME, PATH: `${BIN}:${SYSTEM_PATH}`, VSCODE_CLI: '1', LANG: process.env.LANG ?? 'en_AU.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp', USER: process.env.USER ?? '' };
  return env;
}

/** Resets the profile to a first run (settings, window size, no workspace history, fresh extension state) and opens `folder`, with a take's extra Chromium `flags` (TAKES[…].chromiumFlags). */
export async function launch(folder, flags = []) {
  await quit();
  if (!existsSync(join(EXT, 'extensions.json'))) throw new Error('no ERD Studio in the isolated profile: run `node record/vscode.mjs setup` first');
  mkdirSync(join(UD, 'User', 'globalStorage'), { recursive: true });
  writeEnvironment();
  writeFileSync(join(UD, 'User', 'settings.json'), JSON.stringify({ ...SETTINGS, 'terminal.integrated.env.osx': terminalEnv() }, null, 2));
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
    // the Explorer without its Outline and Timeline sections: the file tree gets their rows
    sqlite(db, `INSERT INTO ItemTable (key, value) VALUES ('workbench.explorer.views.state.hidden', '${JSON.stringify(EXPLORER_HIDDEN)}')`);
  }
  const child = spawn(CODE, [`--user-data-dir=${UD}`, `--extensions-dir=${EXT}`, '--use-mock-keychain', `--remote-debugging-port=${PORT}`, `--force-device-scale-factor=${DPR}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    ...flags,
    '--new-window', folder], { detached: true, stdio: 'ignore', env: windowEnv() });
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
