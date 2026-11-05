/**
 * GettingStartedPanel — the "ERD Studio Tour" webview panel (the Welcome tab): the
 * getting-started video (the tour), a one-line project summary, the optional
 * AI cards (your AI assistant, set up the AI helper, start the guided setup)
 * and a **Show Me Around** button (the interactive guide). Draft-first (`docs/dev/draft-first.md`
 * §10): it holds no start, Convert or "Open your diagrams" card — the draft,
 * the sidebar and the Convert offer are the starts.
 *
 * A singleton, independent of the domain canvas: it has its own protocol
 * (`src/types/gettingStarted.ts`) and its own self-contained HTML — no React
 * bundle. Project-specific behaviour is injected through `GettingStartedDeps`.
 * The page has three states (`GettingStartedPageMode`): no folder open
 * (`workspaceRoot: null`: "Open the folder your data model lives in", or an
 * example), a folder without dbt (`logicalOnly`: the AI cards with the guided
 * setup's no-dbt wording — no dbt text at all), and a dbt project (the
 * guided setup and the sample project).
 * The dbt page plays the default cut (the DBML tour plus a short dbt beat); the other two play the logical-first cut
 * (`GETTING_STARTED_MEDIA`). It autoplays in an open folder.
 *
 * Also home to the host-side pieces the panel and `erdStudio.setupAiHelper`
 * share: AI assistant detection (installed extensions, a PATH scan and the
 * editor's name — no assistant is ever spawned), the `setupAiHelper` flow and
 * the "Open Claude Code" / "Open Copilot Chat" launches, and
 * `trySampleProject()` behind `erdStudio.trySampleProject`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  GETTING_STARTED_EXTERNAL_URLS,
  GETTING_STARTED_PASSIVE_TYPES,
  SAMPLE_REPO_CLONE_URL,
  SAMPLE_REPO_URL,
  SAMPLE_REPO_ZIP_URL,
  SETUP_PROMPT,
  buildGettingStartedHtml,
  describeWrittenFiles,
  gettingStartedPageMode,
  formatProjectSummary,
  isGettingStartedToHost,
  setupReadyMessage,
  type ClaudeAvailability,
  type GettingStartedPageMode,
  type GettingStartedStatus,
  type GettingStartedToHost,
  type GettingStartedToWebview,
  type ProjectSummary,
  type SetupOutcome,
  GETTING_STARTED_TAB_TITLE,
  SHOW_ME_AROUND_COMMAND,
} from '../types/gettingStarted';
import {
  START_ACTION_COMMANDS,
  startActionArgs,
  startActionsForIntent,
  startIntentFor,
  type StartIntent,
} from '../types/startActions';
import { recordStart } from '../commands/start';
import { GETTING_STARTED_CUES, GETTING_STARTED_TRANSCRIPT } from '../types/gettingStartedTranscript';
import { LOGICAL_GETTING_STARTED_CUES, LOGICAL_GETTING_STARTED_TRANSCRIPT } from '../types/gettingStartedLogicalTranscript';
import type { RecommendedInstallResult } from '../types/harness';
import {
  AI_ASSISTANTS,
  detectAssistants,
  recommendedSkillTargets,
  type AiAssistantId,
  type SkillHarnessTarget,
} from '../types/aiAssistants';
import type { CliLauncherInstallResult, CliLauncherOptions } from '../services/cliLauncherService';
import { telemetry } from '../services/telemetryService';
import type { DraftModelEntry } from '../services/dbtDraft';
import type { ManifestData } from '../types/manifest';
import { normaliseName } from '../services/nameUtils';
import { detectConventions, type ConventionModel } from '../cli/conventions';
import { log } from '../services/logger';
import { hasDbtProjectFile } from '../services/projectDiscovery';
import { venvActivateCommand } from '../services/dbtEnv';

export const GETTING_STARTED_VIEW_TYPE = 'erdStudio.gettingStarted';
export const GETTING_STARTED_TITLE = GETTING_STARTED_TAB_TITLE;

/**
 * Shipped media, relative to the extension root (spec addendum V4/V5): the
 * default cut, the DBML tour plus a short dbt beat (`video`, `poster`), for the dbt page, and the logical-first cut
 * (`logicalVideo`, `logicalPoster`) for the no-folder and logical pages.
 */
export const GETTING_STARTED_MEDIA = {
  dir: ['media', 'onboarding'],
  video: 'getting-started.mp4',
  poster: 'getting-started-poster.jpg',
  logicalVideo: 'getting-started-logical.mp4',
  logicalPoster: 'getting-started-logical-poster.jpg',
} as const;

/** The cut, poster, captions and transcript a page plays: the default cut (with its dbt beat) only on the dbt page. */
export function gettingStartedCut(mode: GettingStartedPageMode): {
  video: string;
  poster: string;
  cues: ReadonlyArray<{ start: number; end: number; text: string }>;
  transcript: string;
} {
  return mode === 'dbt'
    ? { video: GETTING_STARTED_MEDIA.video, poster: GETTING_STARTED_MEDIA.poster, cues: GETTING_STARTED_CUES, transcript: GETTING_STARTED_TRANSCRIPT }
    : {
      video: GETTING_STARTED_MEDIA.logicalVideo,
      poster: GETTING_STARTED_MEDIA.logicalPoster,
      cues: LOGICAL_GETTING_STARTED_CUES,
      transcript: LOGICAL_GETTING_STARTED_TRANSCRIPT,
    };
}

/** Marketplace id of the Claude Code VS Code extension. */
export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

/**
 * Commands the Claude Code extension has contributed over time to open its
 * panel, most specific first. Only ones VS Code actually reports are run.
 */
export const CLAUDE_CODE_OPEN_COMMANDS = [
  'claude-vscode.editor.open',
  'claude-vscode.sidebar.open',
  'claude-code.runClaude',
];

// ---------------------------------------------------------------------------
// Try the sample project (erdStudio.trySampleProject)
// ---------------------------------------------------------------------------

export const TRY_SAMPLE_COMMAND = 'erdStudio.trySampleProject';
export const GIT_EXTENSION_ID = 'vscode.git';
export const SAMPLE_CONFIRM_MESSAGE =
  "Download the ERD Studio sample project? It's a small dbt project with fake coffee-shop data from " +
  "github.com/liam-machine/erd-studio-sample (about 1 MB). You'll choose where to save it.";
export const SAMPLE_DOWNLOAD_ACTION = 'Download';
export const SAMPLE_OPEN_ON_GITHUB_ACTION = 'Open on GitHub';
export const SAMPLE_DOWNLOAD_ZIP_ACTION = 'Download ZIP';
export const SAMPLE_FALLBACK_MESSAGE =
  "Git isn't available here, so get the sample as a ZIP instead (Download ZIP below, or Code \u2192 Download ZIP on GitHub). " +
  'Unzip it, then File \u2192 Open Folder\u2026 and pick the erd-studio-sample-main folder.';

export type TrySampleOutcome = 'cancelled' | 'cloned' | 'fallback';

/**
 * Whether `git.clone` can run. The Git extension is built in, so it is always
 * *there* — but when no Git binary is installed (common on Windows) or
 * `git.enabled` is false it never creates its model, never registers its
 * commands, and `git.clone` throws "command not found". Activating it first
 * waits out the model's start-up, so a Git that does exist is not missed.
 */
async function gitCloneAvailable(): Promise<boolean> {
  const git = vscode.extensions.getExtension(GIT_EXTENSION_ID);
  if (!git) return false;
  try {
    await git.activate?.();
  } catch {
    return false;
  }
  return (await vscode.commands.getCommands(true)).includes('git.clone');
}

/**
 * Confirm, then hand the fixed sample repo URL to VS Code's built-in
 * `git.clone` — which asks where to save it and offers to open it. Without
 * a usable Git (or when the clone command throws) the user is offered the
 * sample as a ZIP, which needs nothing installed. The URL is a
 * constant (`SAMPLE_REPO_CLONE_URL` / `SAMPLE_REPO_ZIP_URL` / `SAMPLE_REPO_URL`), never an argument.
 */
export async function trySampleProject(): Promise<TrySampleOutcome> {
  const choice = await vscode.window.showInformationMessage(
    SAMPLE_CONFIRM_MESSAGE,
    { modal: true },
    SAMPLE_DOWNLOAD_ACTION,
  );
  if (choice !== SAMPLE_DOWNLOAD_ACTION) {
    telemetry.feature('trySampleCancelled');
    return 'cancelled';
  }

  if (await gitCloneAvailable()) {
    try {
      await vscode.commands.executeCommand('git.clone', SAMPLE_REPO_CLONE_URL);
      return 'cloned';
    } catch (err) {
      telemetry.error('sampleCloneFailed');
      log.warn('[ERD Studio] git.clone of the sample project failed; offering the GitHub page instead:', err);
    }
  } else {
    telemetry.feature('trySampleNoGit');
  }

  const pick = await vscode.window.showInformationMessage(
    SAMPLE_FALLBACK_MESSAGE,
    SAMPLE_DOWNLOAD_ZIP_ACTION,
    SAMPLE_OPEN_ON_GITHUB_ACTION,
  );
  if (pick === SAMPLE_DOWNLOAD_ZIP_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(SAMPLE_REPO_ZIP_URL));
  } else if (pick === SAMPLE_OPEN_ON_GITHUB_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(SAMPLE_REPO_URL));
  }
  return 'fallback';
}

// ---------------------------------------------------------------------------
// Project summary ("Found 42 dbt models · medallion layout · manifest 3 days old")
// ---------------------------------------------------------------------------

export interface ProjectSummaryInput {
  /** `listDraftModels()` — the dbt models Draw from dbt can offer (yml ∪ manifest, minus disabled). */
  models: readonly DraftModelEntry[];
  /** For each model's schema (a medallion schema token counts as a layer). */
  manifest?: ManifestData;
  /** `readManifestMtime()`: null when there is no manifest.json; undefined when it was not checked. */
  manifestMtime?: number | null;
  now: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Welcome panel's one-line picture of the project, from data the host
 * already holds: no dbt run, no spawn, no file read here. Layering comes from
 * the CLI's `detectConventions()` over folders, schemas and name prefixes
 * only — the shape half needs columns and is not worth it for one line.
 */
export function computeProjectSummary(input: ProjectSummaryInput): ProjectSummary {
  const schemaOf = new Map<string, string>();
  for (const m of input.manifest?.models.values() ?? []) { schemaOf.set(normaliseName(m.name), m.schema ?? ''); }
  const models: ConventionModel[] = input.models.map((m) => ({
    name: m.name,
    kind: 'model',
    folder: m.folder ? m.folder.split('/').filter(Boolean) : [],
    schema: schemaOf.get(normaliseName(m.name)) ?? '',
    columnCount: 0,
  }));
  const style = models.length > 0 ? detectConventions({ models, packages: [], snapshots: [] }).layering.style : 'none';
  const manifest: ProjectSummary['manifest'] = input.manifestMtime === undefined
    ? { state: 'unknown' }
    : input.manifestMtime === null
      ? { state: 'absent' }
      : { state: 'present', ageDays: Math.max(0, Math.floor((input.now - input.manifestMtime) / DAY_MS)) };
  const fields = { modelCount: input.models.length, layering: style === 'none' ? null : style, manifest };
  return { ...fields, line: formatProjectSummary(fields) };
}

// ---------------------------------------------------------------------------
// Claude Code detection
// ---------------------------------------------------------------------------

export interface ClaudeLocateInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /** Injected for tests; a regular-file check by default. */
  isFile?: (p: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the `claude` CLI without running it: scan PATH (with PATHEXT on
 * Windows), then the installer's usual homes, which a GUI-launched editor's
 * PATH can miss. Returns how to invoke it — `claude` when PATH has it, else
 * the absolute path — or null.
 */
export function locateClaudeCli(input: ClaudeLocateInput): { command: string; onPath: boolean } | null {
  const isFile = input.isFile ?? defaultIsFile;
  const win = input.platform === 'win32';
  const sep = win ? ';' : ':';
  const pathVar = input.env.PATH ?? input.env.Path ?? input.env.path ?? '';
  const exts = win
    ? (input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const join = win ? path.win32.join : path.posix.join;
  for (const dir of pathVar.split(sep)) {
    if (!dir) { continue; }
    for (const ext of exts) {
      if (isFile(join(dir, `claude${ext}`))) { return { command: 'claude', onPath: true }; }
    }
  }
  const extras = win
    ? [join(input.homeDir, '.local', 'bin', 'claude.exe')]
    : [join(input.homeDir, '.local', 'bin', 'claude'), join(input.homeDir, '.claude', 'local', 'claude')];
  for (const candidate of extras) {
    if (isFile(candidate)) { return { command: candidate, onPath: false }; }
  }
  return null;
}

/**
 * Whether an executable named `name` is on PATH (with PATHEXT on Windows).
 * A file-existence scan only — nothing is run.
 */
export function isOnPath(name: string, input: ClaudeLocateInput): boolean {
  const isFile = input.isFile ?? defaultIsFile;
  const win = input.platform === 'win32';
  const pathVar = input.env.PATH ?? input.env.Path ?? input.env.path ?? '';
  const exts = win
    ? (input.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())
    : [''];
  const join = win ? path.win32.join : path.posix.join;
  return pathVar.split(win ? ';' : ':').some((dir) => !!dir && exts.some((ext) => isFile(join(dir, `${name}${ext}`))));
}

/** Everything `detectAssistants()` needs, gathered without running any assistant. */
export interface AssistantProbe {
  locate: ClaudeLocateInput;
  /** Is this extension installed? (`vscode.extensions.getExtension` in the host.) */
  hasExtension(id: string): boolean;
  appName: string;
}

/** Detected assistants, in display order. Claude's CLI also counts from its installer's usual homes (`locateClaudeCli`). */
export function detectAiAssistantsWith(probe: AssistantProbe): AiAssistantId[] {
  const clisFound: string[] = [];
  for (const a of AI_ASSISTANTS) {
    for (const name of a.cliNames) {
      const found = name === 'claude' ? locateClaudeCli(probe.locate) !== null : isOnPath(name, probe.locate);
      if (found) { clisFound.push(name); }
    }
  }
  const extensionIds = AI_ASSISTANTS.flatMap((a) => a.extensionIds).filter((id) => probe.hasExtension(id));
  return detectAssistants({ extensionIds, clisFound, appName: probe.appName });
}

/** Live detection, never cached: the Re-check button must see an install that just happened. */
export function detectAiAssistants(): AiAssistantId[] {
  return detectAiAssistantsWith({
    locate: { env: process.env, platform: process.platform, homeDir: os.homedir() },
    hasExtension: (id) => vscode.extensions.getExtension(id) !== undefined,
    appName: vscode.env.appName ?? '',
  });
}

/** Live detection, never cached: the Re-check button must see an install that just happened. */
export function detectClaude(): { availability: ClaudeAvailability; command: string | null } {
  const cli = locateClaudeCli({ env: process.env, platform: process.platform, homeDir: os.homedir() });
  if (cli) { return { availability: 'cli', command: cli.command }; }
  if (vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)) { return { availability: 'extension', command: null }; }
  return { availability: 'missing', command: null };
}

/**
 * How a terminal starts Claude Code with a first prompt (the guided setup's
 * `/erd-studio-setup`, or Execute with Claude's sync instruction). The prompt
 * is always Claude Code's positional initial-prompt argument, never text typed
 * into its TUI later: a first run in a folder shows the folder-trust prompt
 * ("No, exit" preselected) first, and typed text would be lost there while
 * its newline confirmed the highlighted option.
 *
 * On PATH, `claude [flags] "<prompt>"` is typed into the user's shell (after
 * the project venv's activation, when `venvDir` is given). That line parses
 * the same in bash, zsh, fish, PowerShell and cmd only because the prompt
 * holds nothing any of them expands inside double quotes
 * (`isShellNeutralPrompt`). An absolute path found off PATH, or a prompt that
 * is not shell-neutral, is instead run as the terminal's own process
 * (`shellPath` + `shellArgs`), so no shell ever parses it: `& "…"` would be
 * PowerShell-only (a syntax error in cmd and Git Bash) and any quoting would
 * still expand `$` in some shell. The venv is then applied as the
 * environment its activation sets. `display` is what the confirmation modal shows.
 */
export type ClaudeTerminalLaunch =
  | { kind: 'sendText'; display: string; line: string }
  | { kind: 'process'; display: string; shellPath: string; shellArgs: string[]; env?: Record<string, string> };

export interface ClaudeLaunchOptions {
  /** The initial prompt; defaults to the guided setup's `/erd-studio-setup`. */
  prompt?: string;
  /** Flags placed before the prompt, such as `--dangerously-skip-permissions`. */
  args?: string[];
  /** A project venv to activate first, so Claude's shell finds the project's dbt. */
  venvDir?: string | null;
  /** The `PATH` a process launch extends with the venv's bin folder (default: this process's). */
  envPath?: string;
}

/** Characters no shell this extension types into (bash, zsh, fish, PowerShell, cmd) treats specially inside double quotes. */
const SHELL_NEUTRAL_PROMPT = /^[A-Za-z0-9 _.,:/+=@-]+$/;
const SHELL_NEUTRAL_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*$/;

/** Whether `prompt` can be typed as `"<prompt>"` and reach claude unchanged in every shell. */
export function isShellNeutralPrompt(prompt: string): boolean {
  return SHELL_NEUTRAL_PROMPT.test(prompt);
}

export function claudeTerminalLaunch(
  command: string,
  platform: NodeJS.Platform,
  opts: ClaudeLaunchOptions = {},
): ClaudeTerminalLaunch {
  const prompt = opts.prompt ?? SETUP_PROMPT;
  const args = opts.args ?? [];
  const venvDir = opts.venvDir ?? null;
  if (command === 'claude' && isShellNeutralPrompt(prompt) && args.every((a) => SHELL_NEUTRAL_FLAG.test(a))) {
    const claudeLine = ['claude', ...args, `"${prompt}"`].join(' ');
    const line = venvDir ? `${venvActivateCommand(venvDir, platform)} && ${claudeLine}` : claudeLine;
    return { kind: 'sendText', display: line, line };
  }
  const launch: ClaudeTerminalLaunch = {
    kind: 'process', display: claudeLaunchLine(command, platform, prompt, args), shellPath: command, shellArgs: [...args, prompt],
  };
  if (venvDir) {
    const p = platform === 'win32' ? path.win32 : path.posix;
    const bin = p.join(venvDir, platform === 'win32' ? 'Scripts' : 'bin');
    const basePath = opts.envPath ?? process.env.PATH ?? '';
    launch.env = { VIRTUAL_ENV: venvDir, PATH: basePath ? `${bin}${p.delimiter}${basePath}` : bin };
  }
  return launch;
}

/** The command as the modal shows it: an absolute CLI path quoted for reading, not for a shell. */
export function claudeLaunchLine(
  command: string,
  platform: NodeJS.Platform,
  prompt: string = SETUP_PROMPT,
  args: string[] = [],
): string {
  const exe = command === 'claude'
    ? 'claude'
    : platform === 'win32' ? `"${command}"` : `'${command.replace(/'/g, `'\\''`)}'`;
  return [exe, ...args, `"${prompt}"`].join(' ');
}

// ---------------------------------------------------------------------------
// Open Claude Code
// ---------------------------------------------------------------------------

/** "dbt project" in a dbt project, "project" in a folder without one: dbt is named only where it is. */
function projectNoun(root: string, logicalOnly: boolean | undefined): string {
  const hasDbt = logicalOnly === undefined ? hasDbtProjectFile(root) : !logicalOnly;
  return hasDbt ? 'dbt project' : 'project';
}

/**
 * "Open Claude Code". With the CLI: a modal naming the exact command (the
 * "Execute with Claude" rule), then a terminal in the dbt project folder —
 * `claude` takes the first prompt as an argument, so nothing is typed into
 * its TUI later. With only the VS Code extension: open its panel and put the
 * prompt on the clipboard. With neither: the install page.
 *
 * `logicalOnly`: the root has no dbt_project.yml, so the nested-folder note
 * says "your project" rather than "your dbt project". Omitted, it is read
 * from disk (`hasDbtProjectFile`, the check `erdStudio.hasDbtProject` and the harness use).
 */
export async function openClaudeCode(opts: { dbtRoot: string; clipboardText: string; logicalOnly?: boolean }): Promise<void> {
  const { availability, command } = detectClaude();
  if (availability === 'cli' && command) {
    const launch = claudeTerminalLaunch(command, process.platform);
    const OPEN = 'Open Terminal';
    const choice = await vscode.window.showInformationMessage(
      'Start the ERD Studio guided setup in Claude Code?',
      {
        modal: true,
        detail: `Command: ${launch.display}\nFolder: ${opts.dbtRoot}\n\n` +
          'This opens a new terminal. Claude Code asks before it edits any file.',
      },
      OPEN,
    );
    if (choice !== OPEN) { telemetry.feature('openClaudeCancelled'); return; }
    telemetry.feature('openClaudeCli');
    // Git Bash on Windows would otherwise rewrite "/erd-studio-setup" into a path.
    const env = { MSYS_NO_PATHCONV: '1' };
    if (launch.kind === 'process') {
      const terminal = vscode.window.createTerminal({
        name: 'Claude Code', cwd: opts.dbtRoot, env, shellPath: launch.shellPath, shellArgs: launch.shellArgs,
      });
      terminal.show();
      return;
    }
    const terminal = vscode.window.createTerminal({ name: 'Claude Code', cwd: opts.dbtRoot, env });
    terminal.show();
    terminal.sendText(launch.line);
    return;
  }

  if (availability === 'extension') {
    telemetry.feature('openClaudeExtension');
    // The extension's chat takes the prompt itself, never a `cd … && claude` line.
    await vscode.env.clipboard.writeText(SETUP_PROMPT);
    const available = new Set(await vscode.commands.getCommands(true));
    const open = CLAUDE_CODE_OPEN_COMMANDS.find((c) => available.has(c));
    if (open) {
      try {
        await vscode.commands.executeCommand(open);
      } catch (err) {
        telemetry.error('claudeOpenFailed');
        log.warn('[GettingStarted] Could not open Claude Code:', err);
      }
    } else {
      // CLAUDE_CODE_OPEN_COMMANDS are best guesses: this says they have gone stale.
      telemetry.error('claudeOpenCommandMissing');
    }
    const lead = `${open ? 'Claude Code is open.' : 'Open Claude Code from its icon in the sidebar.'} ` +
      `Paste ${SETUP_PROMPT} (it's on your clipboard) and press Enter. `;
    const folder = path.basename(opts.dbtRoot);
    if (opts.clipboardText === SETUP_PROMPT) {
      void vscode.window.showInformationMessage(
        `${lead}Skill not listed? Claude Code must run in your project folder, ${folder}; restart it if it was already open.`,
      );
      return;
    }
    // Nested project: the extension's panel starts in the open workspace
    // folder and cannot be pointed elsewhere, so the only route is to open
    // the project folder itself as the workspace.
    const OPEN_FOLDER = `Open ${folder}`;
    const pick = await vscode.window.showInformationMessage(
      `${lead}Your ${projectNoun(opts.dbtRoot, opts.logicalOnly)}, ${folder}, is a subfolder here, and Claude Code's panel starts in the folder VS Code has open. ` +
        `If the skill isn't listed, open ${folder} itself (File > Open Folder…) and start Claude Code again.`,
      OPEN_FOLDER,
    );
    if (pick === OPEN_FOLDER) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(opts.dbtRoot));
    }
    return;
  }

  telemetry.feature('openClaudeNotFound');
  await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.claudeCodeDocs));
}

// ---------------------------------------------------------------------------
// Open Copilot Chat
// ---------------------------------------------------------------------------

/** VS Code's own command for the chat view (a string id: no typings newer than 1.85 are needed). */
export const COPILOT_CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/** Shown when a launch button is pressed before step 2 has installed the guide. */
export const HELPER_FIRST_MESSAGE =
  'Set up your AI helper first: it installs the guide your assistant runs.';
export const SETUP_HELPER_ACTION = 'Set Up My AI Helper';

export const COPILOT_CHAT_OPENED_MESSAGE =
  `Copilot Chat is open. If it isn't in Agent mode, switch it with the mode picker under the input, then send ${SETUP_PROMPT} (it's on your clipboard).`;

/**
 * "Open Copilot Chat": copy the prompt, then open the chat view in Agent mode
 * (`mode: 'agent'` — the skill runs tools, which Ask/Edit mode cannot) with
 * the prompt typed in but not sent (`isPartialQuery`), so the user presses
 * Enter. Builds that do not know `mode` ignore it, which is why the message
 * still says how to switch. Editors whose chat command takes no argument get
 * a bare open; with no chat command at all, the Copilot setup page.
 */
export async function openCopilotChat(opts: { dbtRoot: string | null; workspaceFolder: string | null; logicalOnly?: boolean }): Promise<void> {
  await vscode.env.clipboard.writeText(SETUP_PROMPT);
  const available = new Set(await vscode.commands.getCommands(true));
  if (!available.has(COPILOT_CHAT_OPEN_COMMAND)) {
    telemetry.feature('copilotChatNotFound');
    await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.copilotDocs));
    return;
  }
  try {
    await vscode.commands.executeCommand(COPILOT_CHAT_OPEN_COMMAND, { query: SETUP_PROMPT, isPartialQuery: true, mode: 'agent' });
  } catch {
    try {
      await vscode.commands.executeCommand(COPILOT_CHAT_OPEN_COMMAND);
      telemetry.feature('copilotChatNoArgs');
    } catch (err) {
      telemetry.error('copilotChatOpenFailed');
      log.warn('[GettingStarted] Could not open Copilot Chat:', err);
    }
  }
  const nested = opts.dbtRoot && opts.workspaceFolder
    && path.resolve(opts.dbtRoot) !== path.resolve(opts.workspaceFolder);
  void vscode.window.showInformationMessage(nested
    ? `${COPILOT_CHAT_OPENED_MESSAGE} Your ${projectNoun(opts.dbtRoot!, opts.logicalOnly)}, ${path.basename(opts.dbtRoot!)}, is a subfolder here and ` +
      `Copilot looks for skills in the folder VS Code has open — if the guide isn't found, open ` +
      `${path.basename(opts.dbtRoot!)} itself (File > Open Folder…).`
    : COPILOT_CHAT_OPENED_MESSAGE);
}

// ---------------------------------------------------------------------------
// Set Up My AI Helper
// ---------------------------------------------------------------------------

export type ReplaceChoice = 'replace' | 'keep' | undefined;

export interface SetupAiHelperDeps {
  root: string;
  /** `keepUnmanaged` is "Keep mine": install everything that is not hand-written. */
  harness: {
    installRecommended(
      root: string,
      options: { replaceUnmanaged: boolean; keepUnmanaged?: boolean; assistants?: readonly AiAssistantId[] },
    ): RecommendedInstallResult;
  };
  launcher: { install(opts: CliLauncherOptions): Promise<CliLauncherInstallResult> };
  launcherOptions: CliLauncherOptions;
  /** Detected assistants: which skill folders to install (`recommendedSkillTargets`) and whom the message names. */
  assistants: readonly AiAssistantId[];
  /** The root has no dbt_project.yml: the success message says the guided setup designs the model with the user. */
  logicalOnly?: boolean;
  /** The Replace / Keep mine modal; undefined when dismissed. */
  confirmReplace(unmanaged: string[], targets: SkillHarnessTarget[]): Promise<ReplaceChoice>;
}

export const SETUP_CANCELLED_MESSAGE = 'Setup cancelled. Nothing was changed.';

/**
 * What "Keep mine" still installs, for the modal — derived from which SKILL.md
 * files are hand-written in each skill folder being installed. The launcher
 * is named by the caller.
 */
export function keepMineInstalls(unmanaged: readonly string[], targets: readonly SkillHarnessTarget[] = ['claude']): string {
  const kept = (target: SkillHarnessTarget, setup: boolean) => unmanaged.some((p) =>
    p.startsWith(target === 'claude' ? '.claude/' : '.agents/') && p.includes('/erd-studio-setup/') === setup);
  const rulesStill = targets.some((t) => !kept(t, false));
  const guideStill = targets.some((t) => !kept(t, true));
  const parts: string[] = [];
  if (guideStill) { parts.push('the /erd-studio-setup guide'); }
  if (rulesStill) { parts.push("ERD Studio's file-format rules"); }
  if (targets.includes('claude')) { parts.push('the safety check'); }
  if (parts.length === 0) { return 'nothing else in this project'; }
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** @deprecated Claude-only wording; use `setupReadyMessage(assistants)`. Kept for the Claude-only palette path. */
export const SETUP_READY_MESSAGE = setupReadyMessage(['claude']);

/** `~/…` for launcher paths under the home dir, so nothing absolute reaches the panel. */
export function displayLauncherPath(absolute: string, homeDir: string): string {
  const rel = path.relative(homeDir, absolute);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return `~/${rel.split(path.sep).join('/')}`;
  }
  return path.basename(absolute);
}

/**
 * The `setupAiHelper` flow (spec C.4), shared by the command and the panel:
 * install the Claude harness target (asking before replacing a hand-written
 * SKILL.md), then the helper launcher in `~/.erd-studio-cli`. A launcher
 * failure is reported but never undoes the skill install. Never throws.
 */
export async function runSetupAiHelper(deps: SetupAiHelperDeps): Promise<SetupOutcome> {
  const filesWritten: string[] = [];
  const assistants = deps.assistants;
  try {
    let result = deps.harness.installRecommended(deps.root, { replaceUnmanaged: false, assistants });
    if (result.status === 'needs-confirmation') {
      telemetry.feature('setupHelperConflict');
      const choice = await deps.confirmReplace(result.unmanaged, recommendedSkillTargets(assistants));
      if (choice === undefined) {
        telemetry.feature('setupHelperCancelled');
        return { ok: false, filesWritten: [], message: SETUP_CANCELLED_MESSAGE };
      }
      result = choice === 'replace'
        ? deps.harness.installRecommended(deps.root, { replaceUnmanaged: true, assistants })
        : deps.harness.installRecommended(deps.root, { replaceUnmanaged: false, keepUnmanaged: true, assistants });
    }
    if (result.status === 'failed' || result.status === 'needs-confirmation') {
      telemetry.error('setupHarnessFailed');
      return {
        ok: false,
        filesWritten: result.filesWritten,
        message: `Couldn't install the setup guide: ${result.error ?? 'a hand-written skill is in the way'}.`,
      };
    }
    filesWritten.push(...result.filesWritten);
    if (result.status !== 'unchanged' && result.targets.includes('claude')) telemetry.feature('harnessInstallClaude');
    if (result.status !== 'unchanged' && result.targets.includes('agents')) telemetry.feature('harnessInstallAgents');

    const launched = await deps.launcher.install(deps.launcherOptions);
    filesWritten.push(...launched.filesWritten.map((p) => displayLauncherPath(p, deps.launcherOptions.homeDir)));
    // Not fatal on its own (a node >= 18 on PATH still runs the shim), but it
    // means VS Code's own runtime could not run a script on this machine.
    if (!launched.runtimeVerified) telemetry.error('launcherRuntimeUnverified');
    if (!launched.ok) {
      telemetry.error('launcherInstallFailed');
      return {
        ok: false,
        filesWritten,
        message: `The setup guide is installed, but the checking tool couldn't be (${launched.error ?? 'unknown error'}). ` +
          'Your assistant can still check your data model through the canvas, just less exactly.',
      };
    }
    telemetry.feature('setupAiHelper');
    return {
      ok: true,
      filesWritten,
      message: result.status === 'unchanged' && filesWritten.length === 0
        ? `Everything was already up to date. ${setupReadyMessage(assistants, { logicalOnly: deps.logicalOnly })}`
        : setupReadyMessage(assistants, { logicalOnly: deps.logicalOnly }),
    };
  } catch (err) {
    telemetry.error('setupFailed');
    return {
      ok: false,
      filesWritten,
      message: `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface GettingStartedDeps {
  /** The dbt project root, or null when no project was found. */
  workspaceRoot: string | null;
  semanticDir: string;
  runSetup(): Promise<SetupOutcome>;
  getStatus(): Promise<GettingStartedStatus>;
  /** What a Copy button puts on the clipboard for `assistant` (default Claude Code; see `promptFor`). */
  clipboardText(assistant?: AiAssistantId): string;
  /** The first workspace folder, for the nested-project hint in "Open Copilot Chat". */
  workspaceFolder?: string | null;
  /**
   * The one-line project summary (`computeProjectSummary`). Optional: without
   * it, or when it throws, the line is simply not shown. Never asked for in
   * the logical-only state (it describes dbt models).
   */
  getProjectSummary?(): Promise<ProjectSummary | null>;
  /**
   * The start the folder suggests, from the host's `StartIntentTracker`:
   * `known()` at once (the first status), `refresh()` after the bounded look
   * at the folder (a second status when it changed the suggestion).
   * Optional: without it, the suggestion comes from the status alone
   * (Convert, Draw from dbt or a blank diagram; no look).
   */
  startIntent?: {
    known(): StartIntent | undefined;
    refresh(): Promise<StartIntent | undefined>;
  };
  /**
   * The open folder has no `dbt_project.yml` (contract 9): the page shows its
   * logical-only state. Used as the status's `logicalOnly` when `getStatus()`
   * does not set it, and to pick the first page before any status arrives.
   * Absent: a dbt project, as before logical-only mode.
   */
  logicalOnly?: boolean;
}

/** The page the panel expects from its deps alone (a `status` can still change it). */
export function pageModeForDeps(deps: Pick<GettingStartedDeps, 'workspaceRoot' | 'logicalOnly'>): GettingStartedPageMode {
  return gettingStartedPageMode({ hasProject: deps.workspaceRoot !== null, logicalOnly: deps.logicalOnly });
}

export class GettingStartedPanel {
  static readonly viewType = GETTING_STARTED_VIEW_TYPE;
  private static current: GettingStartedPanel | undefined;

  private deps: GettingStartedDeps;
  private readonly disposables: vscode.Disposable[] = [];
  /** Bumped by every postStatus; a call a newer one has overtaken posts nothing more. */
  private statusSeq = 0;
  /** Setups in flight from this panel; no status is posted meanwhile (it would re-enable the button). */
  private setupsRunning = 0;
  /** The viewer chose something on the page (any message but the page's own: `GETTING_STARTED_PASSIVE_TYPES`). */
  private choseSomething = false;
  private disposed = false;

  /** Open the panel, or reveal it (with fresh deps and status) when it is already open. */
  static createOrShow(context: vscode.ExtensionContext, deps: GettingStartedDeps): GettingStartedPanel {
    const existing = GettingStartedPanel.current;
    if (existing) {
      existing.deps = deps;
      existing.panel.reveal(vscode.ViewColumn.One);
      void existing.postStatus();
      return existing;
    }
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, ...GETTING_STARTED_MEDIA.dir);
    const panel = vscode.window.createWebviewPanel(
      GETTING_STARTED_VIEW_TYPE,
      GETTING_STARTED_TITLE,
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [mediaRoot], retainContextWhenHidden: false },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    telemetry.feature('gettingStartedOpened');
    GettingStartedPanel.current = new GettingStartedPanel(panel, context.extensionUri, deps);
    return GettingStartedPanel.current;
  }

  /** The open panel, if any (for the command path to post results into). */
  static get currentPanel(): GettingStartedPanel | undefined {
    return GettingStartedPanel.current;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    deps: GettingStartedDeps,
  ) {
    this.deps = deps;
    panel.webview.html = GettingStartedPanel.renderHtml(panel.webview, extensionUri, pageModeForDeps(deps));
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message).catch((err) => {
          telemetry.error('welcomePanelFailed');
          log.error('[GettingStarted] Message handler failed:', err);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private static renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, mode: GettingStartedPageMode): string {
    const media = (file: string): string | null => {
      const uri = vscode.Uri.joinPath(extensionUri, ...GETTING_STARTED_MEDIA.dir, file);
      return fs.existsSync(uri.fsPath) ? webview.asWebviewUri(uri).toString() : null;
    };
    // The mode is fixed for the window (dbt or not is decided at activation), so the cut is picked once.
    const cut = gettingStartedCut(mode);
    return buildGettingStartedHtml({
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      videoUri: media(cut.video),
      posterUri: media(cut.poster),
      cues: cut.cues,
      transcript: cut.transcript,
      mode,
    });
  }

  private post(message: GettingStartedToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  async postStatus(): Promise<void> {
    const seq = ++this.statusSeq;
    // A status render re-enables the setup button; while a setup runs, the
    // fresh status postSetupResult sends when it ends is the one that counts.
    const current = (): boolean => seq === this.statusSeq && this.setupsRunning === 0;
    try {
      const fetched = await this.deps.getStatus();
      if (!current()) { return; }
      const logicalOnly = fetched.hasProject && (fetched.logicalOnly ?? this.deps.logicalOnly === true);
      const tracker = fetched.hasProject ? this.deps.startIntent : undefined;
      // What the folder suggests (the same rule the walkthrough and the sidebar follow); no storage reads as dbml.
      const intentNow: StartIntent | undefined = !fetched.hasProject
        ? undefined
        : tracker?.known() ?? startIntentFor({
          hasProject: true, hasDbt: !logicalOnly, storage: fetched.storage, hasDiagrams: fetched.domainCount > 0,
        });
      const withIntent = (intent: StartIntent | undefined): GettingStartedStatus => {
        const s: GettingStartedStatus = { ...fetched, logicalOnly, starts: startActionsForIntent(intent, fetched.hasProject && !logicalOnly) };
        if (intent) { s.intent = intent; }
        return s;
      };
      // The cards go out at once. Two things can follow in a second status
      // rather than hold the whole panel back: the bounded look at the folder
      // (it can change the suggestion), and the summary line, which can need
      // a manifest parse (seconds on a large project). That second message is
      // dropped if a newer postStatus (or a setup) started meanwhile — its
      // `status` would be stale.
      const status = withIntent(intentNow);
      this.post({ type: 'status', payload: { ...status, summary: null } });
      // No suggestion is shown here any more (no start card): nothing is counted as suggested.
      const wantsSummary = gettingStartedPageMode(status) === 'dbt';
      if (!tracker) {
        if (!wantsSummary) { return; }
        const summaryOnly = await this.projectSummary();
        if (summaryOnly && current()) { this.post({ type: 'status', payload: { ...status, summary: summaryOnly } }); }
        return;
      }
      const [intent, summary] = await Promise.all([
        tracker.refresh().catch(() => intentNow),
        wantsSummary ? this.projectSummary() : Promise.resolve(null),
      ]);
      if (!current()) { return; }
      if (intent !== intentNow || summary) { this.post({ type: 'status', payload: { ...withIntent(intent), summary } }); }
    } catch (err) {
      telemetry.error('welcomePanelFailed');
      log.error('[GettingStarted] Status check failed:', err);
    }
  }

  /** A summary that cannot be worked out is left off the page, never an error. */
  private async projectSummary(): Promise<ProjectSummary | null> {
    if (!this.deps.getProjectSummary) { return null; }
    try {
      return await this.deps.getProjectSummary();
    } catch (err) {
      log.warn('[GettingStarted] Project summary unavailable:', err);
      return null;
    }
  }

  /** Run the setup from this panel, holding status posts back until it ends. */
  private async runSetupFromPanel(): Promise<void> {
    this.setupsRunning++;
    let outcome: SetupOutcome;
    try {
      outcome = await this.deps.runSetup();
    } finally {
      this.setupsRunning--;
    }
    await this.postSetupResult(outcome);
  }

  /** Show a setup outcome (from the panel's button or the palette command) and refresh the cards. */
  async postSetupResult(outcome: SetupOutcome): Promise<void> {
    const groups = describeWrittenFiles(outcome.filesWritten, { logicalOnly: this.deps.logicalOnly === true });
    this.post({ type: 'setupResult', payload: { ...outcome, groups } });
    await this.postStatus();
  }

  /**
   * Before launching an assistant: with no guide installed yet (`helper:
   * 'missing'`), `/erd-studio-setup` would be an unknown command. Offer step 2
   * instead and return false; a failed status check does not block the launch.
   */
  private async helperInstalledOrOffer(): Promise<boolean> {
    let helper: GettingStartedStatus['helper'] | undefined;
    try {
      helper = (await this.deps.getStatus()).helper;
    } catch {
      return true;
    }
    if (helper !== 'missing') { return true; }
    telemetry.feature('helperFirstPrompt');
    const pick = await vscode.window.showInformationMessage(HELPER_FIRST_MESSAGE, SETUP_HELPER_ACTION);
    if (pick === SETUP_HELPER_ACTION) {
      await this.runSetupFromPanel();
    }
    return false;
  }

  /** Every `GettingStartedToHost` type is handled here; anything else is warned about and ignored. */
  async handleMessage(message: unknown): Promise<void> {
    if (!isGettingStartedToHost(message)) {
      log.warn('[GettingStarted] Ignoring unknown message:', message);
      return;
    }
    const msg: GettingStartedToHost = message;
    if (!GETTING_STARTED_PASSIVE_TYPES.includes(msg.type)) { this.choseSomething = true; }
    switch (msg.type) {
      case 'ready':
      case 'refreshStatus':
        await this.postStatus();
        break;
      case 'setupAiHelper':
        await this.runSetupFromPanel();
        break;
      case 'copyPrompt':
        telemetry.feature('copyPrompt');
        await vscode.env.clipboard.writeText(this.deps.clipboardText(msg.assistant ?? 'claude'));
        break;
      case 'openClaude':
        telemetry.feature('openClaude');
        if (this.deps.workspaceRoot && await this.helperInstalledOrOffer()) {
          await openClaudeCode({
            dbtRoot: this.deps.workspaceRoot,
            clipboardText: this.deps.clipboardText('claude'),
            logicalOnly: this.deps.logicalOnly === true,
          });
        }
        break;
      case 'openCopilotChat':
        telemetry.feature('openCopilotChat');
        if (await this.helperInstalledOrOffer()) {
          await openCopilotChat({
            dbtRoot: this.deps.workspaceRoot,
            workspaceFolder: this.deps.workspaceFolder ?? null,
            logicalOnly: this.deps.logicalOnly === true,
          });
        }
        break;
      case 'start':
        recordStart(msg.action, 'welcome');
        // A fixed command per start (never an id from the webview), with a fixed argument:
        // a direct import's quick path, nothing for the others.
        await vscode.commands.executeCommand(START_ACTION_COMMANDS[msg.action], ...startActionArgs(msg.action));
        // A new diagram opens in its own tab; this one should now lead with "Open your diagrams".
        await this.postStatus();
        break;
      case 'openExternal':
        await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS[msg.target]));
        break;
      case 'trySample':
        await vscode.commands.executeCommand(TRY_SAMPLE_COMMAND);
        break;
      case 'openFolder':
        await vscode.commands.executeCommand('vscode.openFolder');
        break;
      case 'videoError':
        telemetry.feature('videoError');
        log.warn(`[GettingStarted] Video could not play here (code ${msg.code}); showing the poster fallback.`);
        break;
      case 'videoProgress':
        telemetry.feature(msg.milestone === 'half' ? 'videoHalf' : 'videoEnded');
        break;
      case 'showMeAround':
        // The fixed command (never one from the webview); it counts its own use.
        await vscode.commands.executeCommand(SHOW_ME_AROUND_COMMAND);
        break;
      default: {
        const unhandled: never = msg;
        log.warn('[GettingStarted] Unhandled message:', unhandled);
      }
    }
  }

  dispose(): void {
    if (GettingStartedPanel.current === this) { GettingStartedPanel.current = undefined; }
    if (!this.disposed) {
      this.disposed = true;
      // Closed without choosing anything (a start, Open your diagrams, the AI steps, a link): the bounce signal.
      if (!this.choseSomething) { telemetry.feature('welcomeLeftNoChoice'); }
    }
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // best effort
      }
    }
  }
}
