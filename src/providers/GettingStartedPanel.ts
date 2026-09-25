/**
 * GettingStartedPanel — the "Welcome to ERD Studio" webview panel: the
 * getting-started video, then four step cards (your AI assistant, set up the
 * AI helper, start the guided setup, open the canvas).
 *
 * A singleton, independent of the domain canvas: it has its own protocol
 * (`src/types/gettingStarted.ts`) and its own self-contained HTML — no React
 * bundle. Project-specific behaviour is injected through `GettingStartedDeps`
 * so the panel also opens with no dbt project (`workspaceRoot: null`), where
 * the steps collapse to "Open a folder containing dbt_project.yml".
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
  SAMPLE_REPO_CLONE_URL,
  SAMPLE_REPO_URL,
  SETUP_PROMPT,
  buildGettingStartedHtml,
  describeWrittenFiles,
  isGettingStartedToHost,
  setupReadyMessage,
  type ClaudeAvailability,
  type GettingStartedStatus,
  type GettingStartedToHost,
  type GettingStartedToWebview,
  type SetupOutcome,
} from '../types/gettingStarted';
import { GETTING_STARTED_CUES, GETTING_STARTED_TRANSCRIPT } from '../types/gettingStartedTranscript';
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

export const GETTING_STARTED_VIEW_TYPE = 'erdStudio.gettingStarted';
export const GETTING_STARTED_TITLE = 'Welcome to ERD Studio';

/** Shipped media, relative to the extension root (spec addendum V4/V5). */
export const GETTING_STARTED_MEDIA = {
  dir: ['media', 'onboarding'],
  video: 'getting-started.mp4',
  poster: 'getting-started-poster.jpg',
} as const;

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
export const SAMPLE_FALLBACK_MESSAGE =
  "Git isn't available here, so get the sample from GitHub instead: Code \u2192 Download ZIP. " +
  'Unzip it, then File \u2192 Open Folder\u2026 and pick the erd-studio-sample folder.';

export type TrySampleOutcome = 'cancelled' | 'cloned' | 'fallback';

/**
 * Confirm, then hand the fixed sample repo URL to VS Code's built-in
 * `git.clone` — which asks where to save it and offers to open it. Without
 * the Git extension (or when the clone command throws) the user is pointed at
 * the GitHub page, whose Download ZIP needs nothing installed. The URL is a
 * constant (`SAMPLE_REPO_CLONE_URL` / `SAMPLE_REPO_URL`), never an argument.
 */
export async function trySampleProject(): Promise<TrySampleOutcome> {
  const choice = await vscode.window.showInformationMessage(
    SAMPLE_CONFIRM_MESSAGE,
    { modal: true },
    SAMPLE_DOWNLOAD_ACTION,
  );
  if (choice !== SAMPLE_DOWNLOAD_ACTION) { return 'cancelled'; }

  if (vscode.extensions.getExtension(GIT_EXTENSION_ID)) {
    try {
      await vscode.commands.executeCommand('git.clone', SAMPLE_REPO_CLONE_URL);
      return 'cloned';
    } catch (err) {
      console.warn('[ERD Studio] git.clone of the sample project failed; offering the GitHub page instead:', err);
    }
  }

  const pick = await vscode.window.showInformationMessage(SAMPLE_FALLBACK_MESSAGE, SAMPLE_OPEN_ON_GITHUB_ACTION);
  if (pick === SAMPLE_OPEN_ON_GITHUB_ACTION) {
    await vscode.env.openExternal(vscode.Uri.parse(SAMPLE_REPO_URL));
  }
  return 'fallback';
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
 * How the terminal starts the guided setup. On PATH, `claude "/erd-studio-setup"`
 * is typed into the user's shell — that one line parses the same in bash,
 * zsh, PowerShell and cmd. An absolute path found off PATH is instead run as
 * the terminal's own process (`shellPath` + `shellArgs`), so no shell ever
 * parses it: `& "…"` would be PowerShell-only (a syntax error in cmd and Git
 * Bash) and any quoting would still expand `$` in some shell. `display` is
 * what the confirmation modal shows.
 */
export type ClaudeTerminalLaunch =
  | { kind: 'sendText'; display: string; line: string }
  | { kind: 'process'; display: string; shellPath: string; shellArgs: string[] };

export function claudeTerminalLaunch(command: string, platform: NodeJS.Platform): ClaudeTerminalLaunch {
  if (command === 'claude') {
    const line = `claude "${SETUP_PROMPT}"`;
    return { kind: 'sendText', display: line, line };
  }
  return { kind: 'process', display: claudeLaunchLine(command, platform), shellPath: command, shellArgs: [SETUP_PROMPT] };
}

/** The command as the modal shows it: an absolute CLI path quoted for reading, not for a shell. */
export function claudeLaunchLine(command: string, platform: NodeJS.Platform): string {
  const exe = command === 'claude'
    ? 'claude'
    : platform === 'win32' ? `"${command}"` : `'${command.replace(/'/g, `'\\''`)}'`;
  return `${exe} "${SETUP_PROMPT}"`;
}

// ---------------------------------------------------------------------------
// Open Claude Code
// ---------------------------------------------------------------------------

/**
 * "Open Claude Code". With the CLI: a modal naming the exact command (the
 * "Execute with Claude" rule), then a terminal in the dbt project folder —
 * `claude` takes the first prompt as an argument, so nothing is typed into
 * its TUI later. With only the VS Code extension: open its panel and put the
 * prompt on the clipboard. With neither: the install page.
 */
export async function openClaudeCode(opts: { dbtRoot: string; clipboardText: string }): Promise<void> {
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
    if (choice !== OPEN) { return; }
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
    // The extension's chat takes the prompt itself, never a `cd … && claude` line.
    await vscode.env.clipboard.writeText(SETUP_PROMPT);
    const available = new Set(await vscode.commands.getCommands(true));
    const open = CLAUDE_CODE_OPEN_COMMANDS.find((c) => available.has(c));
    if (open) {
      try {
        await vscode.commands.executeCommand(open);
      } catch (err) {
        console.warn('[GettingStarted] Could not open Claude Code:', err);
      }
    }
    const lead = `${open ? 'Claude Code is open.' : 'Open Claude Code from its icon in the sidebar.'} ` +
      `Paste ${SETUP_PROMPT} (it's on your clipboard) and press Enter. `;
    const folder = path.basename(opts.dbtRoot);
    if (opts.clipboardText === SETUP_PROMPT) {
      void vscode.window.showInformationMessage(
        `${lead}Skill not listed? Claude Code must run in your dbt project folder, ${folder}; restart it if it was already open.`,
      );
      return;
    }
    // Nested project: the extension's panel starts in the open workspace
    // folder and cannot be pointed elsewhere, so the only route is to open
    // the dbt folder itself as the workspace.
    const OPEN_FOLDER = `Open ${folder}`;
    const pick = await vscode.window.showInformationMessage(
      `${lead}Your dbt project, ${folder}, is a subfolder here, and Claude Code's panel starts in the folder VS Code has open. ` +
        `If the skill isn't listed, open ${folder} itself (File > Open Folder…) and start Claude Code again.`,
      OPEN_FOLDER,
    );
    if (pick === OPEN_FOLDER) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(opts.dbtRoot));
    }
    return;
  }

  await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.claudeCodeDocs));
}

// ---------------------------------------------------------------------------
// Open Copilot Chat
// ---------------------------------------------------------------------------

/** VS Code's own command for the chat view (a string id: no typings newer than 1.85 are needed). */
export const COPILOT_CHAT_OPEN_COMMAND = 'workbench.action.chat.open';

/** Shown when a launch button is pressed before step 2 has installed the guide. */
export const HELPER_FIRST_MESSAGE =
  'Do step 2 first: Set up my AI helper installs the guide your assistant runs.';
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
export async function openCopilotChat(opts: { dbtRoot: string | null; workspaceFolder: string | null }): Promise<void> {
  await vscode.env.clipboard.writeText(SETUP_PROMPT);
  const available = new Set(await vscode.commands.getCommands(true));
  if (!available.has(COPILOT_CHAT_OPEN_COMMAND)) {
    await vscode.env.openExternal(vscode.Uri.parse(GETTING_STARTED_EXTERNAL_URLS.copilotDocs));
    return;
  }
  try {
    await vscode.commands.executeCommand(COPILOT_CHAT_OPEN_COMMAND, { query: SETUP_PROMPT, isPartialQuery: true, mode: 'agent' });
  } catch {
    try {
      await vscode.commands.executeCommand(COPILOT_CHAT_OPEN_COMMAND);
    } catch (err) {
      console.warn('[GettingStarted] Could not open Copilot Chat:', err);
    }
  }
  const nested = opts.dbtRoot && opts.workspaceFolder
    && path.resolve(opts.dbtRoot) !== path.resolve(opts.workspaceFolder);
  void vscode.window.showInformationMessage(nested
    ? `${COPILOT_CHAT_OPENED_MESSAGE} Your dbt project, ${path.basename(opts.dbtRoot!)}, is a subfolder here and ` +
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
      const choice = await deps.confirmReplace(result.unmanaged, recommendedSkillTargets(assistants));
      if (choice === undefined) {
        return { ok: false, filesWritten: [], message: SETUP_CANCELLED_MESSAGE };
      }
      result = choice === 'replace'
        ? deps.harness.installRecommended(deps.root, { replaceUnmanaged: true, assistants })
        : deps.harness.installRecommended(deps.root, { replaceUnmanaged: false, keepUnmanaged: true, assistants });
    }
    if (result.status === 'failed' || result.status === 'needs-confirmation') {
      return {
        ok: false,
        filesWritten: result.filesWritten,
        message: `Couldn't install the setup guide: ${result.error ?? 'a hand-written skill is in the way'}.`,
      };
    }
    filesWritten.push(...result.filesWritten);
    if (result.status !== 'unchanged' && result.targets.includes('claude')) telemetry.feature('harnessInstallClaude');

    const launched = await deps.launcher.install(deps.launcherOptions);
    filesWritten.push(...launched.filesWritten.map((p) => displayLauncherPath(p, deps.launcherOptions.homeDir)));
    if (!launched.ok) {
      return {
        ok: false,
        filesWritten,
        message: `The setup guide is installed, but the checking tool couldn't be (${launched.error ?? 'unknown error'}). ` +
          'Your assistant can still check your model through the canvas, just less exactly.',
      };
    }
    return {
      ok: true,
      filesWritten,
      message: result.status === 'unchanged' && filesWritten.length === 0
        ? `Everything was already up to date. ${setupReadyMessage(assistants)}`
        : setupReadyMessage(assistants),
    };
  } catch (err) {
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
  /** Open a domain canvas, or start the first one. */
  openCanvas(): Promise<void>;
}

export class GettingStartedPanel {
  static readonly viewType = GETTING_STARTED_VIEW_TYPE;
  private static current: GettingStartedPanel | undefined;

  private deps: GettingStartedDeps;
  private readonly disposables: vscode.Disposable[] = [];

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
    panel.webview.html = GettingStartedPanel.renderHtml(panel.webview, extensionUri);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message).catch((err) => {
          console.error('[GettingStarted] Message handler failed:', err);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private static renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const media = (file: string): string | null => {
      const uri = vscode.Uri.joinPath(extensionUri, ...GETTING_STARTED_MEDIA.dir, file);
      return fs.existsSync(uri.fsPath) ? webview.asWebviewUri(uri).toString() : null;
    };
    return buildGettingStartedHtml({
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      videoUri: media(GETTING_STARTED_MEDIA.video),
      posterUri: media(GETTING_STARTED_MEDIA.poster),
      cues: GETTING_STARTED_CUES,
      transcript: GETTING_STARTED_TRANSCRIPT,
    });
  }

  private post(message: GettingStartedToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  async postStatus(): Promise<void> {
    try {
      this.post({ type: 'status', payload: await this.deps.getStatus() });
    } catch (err) {
      console.error('[GettingStarted] Status check failed:', err);
    }
  }

  /** Show a setup outcome (from the panel's button or the palette command) and refresh the cards. */
  async postSetupResult(outcome: SetupOutcome): Promise<void> {
    this.post({ type: 'setupResult', payload: { ...outcome, groups: describeWrittenFiles(outcome.filesWritten) } });
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
    const pick = await vscode.window.showInformationMessage(HELPER_FIRST_MESSAGE, SETUP_HELPER_ACTION);
    if (pick === SETUP_HELPER_ACTION) {
      await this.postSetupResult(await this.deps.runSetup());
    }
    return false;
  }

  /** Every `GettingStartedToHost` type is handled here; anything else is warned about and ignored. */
  async handleMessage(message: unknown): Promise<void> {
    if (!isGettingStartedToHost(message)) {
      console.warn('[GettingStarted] Ignoring unknown message:', message);
      return;
    }
    const msg: GettingStartedToHost = message;
    switch (msg.type) {
      case 'ready':
      case 'refreshStatus':
        await this.postStatus();
        break;
      case 'setupAiHelper':
        await this.postSetupResult(await this.deps.runSetup());
        break;
      case 'copyPrompt':
        await vscode.env.clipboard.writeText(this.deps.clipboardText(msg.assistant ?? 'claude'));
        break;
      case 'openClaude':
        if (this.deps.workspaceRoot && await this.helperInstalledOrOffer()) {
          await openClaudeCode({ dbtRoot: this.deps.workspaceRoot, clipboardText: this.deps.clipboardText('claude') });
        }
        break;
      case 'openCopilotChat':
        if (await this.helperInstalledOrOffer()) {
          await openCopilotChat({ dbtRoot: this.deps.workspaceRoot, workspaceFolder: this.deps.workspaceFolder ?? null });
        }
        break;
      case 'openDomain':
        await this.deps.openCanvas();
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
        console.warn(`[GettingStarted] Video could not play here (code ${msg.code}); showing the poster fallback.`);
        break;
      default: {
        const unhandled: never = msg;
        console.warn('[GettingStarted] Unhandled message:', unhandled);
      }
    }
  }

  dispose(): void {
    if (GettingStartedPanel.current === this) { GettingStartedPanel.current = undefined; }
    while (this.disposables.length) {
      try {
        this.disposables.pop()?.dispose();
      } catch {
        // best effort
      }
    }
  }
}
