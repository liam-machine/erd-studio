/**
 * Welcome panel ("Welcome to ERD Studio") — the protocol between the panel's
 * webview and `GettingStartedPanel` (host), plus the pure HTML builder.
 *
 * Deliberately NOT part of the canvas `WebviewMessage` union: the canvas union
 * carries the physical-stage allowlist and the "every type has a live sender
 * and handler" invariant for a different webview and host class. The only
 * canvas-side addition is `openGettingStarted` in `messages.ts`.
 *
 * Pure: no `vscode`, no DOM types, nothing from `src/services/**`. The panel
 * HTML is a self-contained string (inline nonce'd `<style>` + `<script>`) and
 * does not load the React bundle.
 */

import type { FileState } from './harness';
import {
  AI_ASSISTANTS,
  assistantInfo,
  assistantNames,
  isAiAssistantId,
  joinNames,
  recommendedSkillTargets,
  type AiAssistantId,
  type SkillHarnessTarget,
} from './aiAssistants';

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Fixed destinations for `openExternal`. The webview names one; it never sends a URL. */
export type GettingStartedExternalTarget =
  | 'claudeCodeDocs' | 'copilotDocs' | 'codexDocs' | 'geminiCliDocs' | 'cursorDocs'
  | 'videoOnline' | 'dbtInstallDocs' | 'sampleRepo';

/**
 * The public sample dbt project (`erdStudio.trySampleProject`): a Kimball
 * jaffle-shop on DuckDB that ships `target/manifest.json` + `catalog.json`, so
 * both stages render with nothing installed. Not bundled in the VSIX. Fixed
 * constants — never a URL from a webview.
 */
export const SAMPLE_REPO_URL = 'https://github.com/liam-machine/erd-studio-sample';
export const SAMPLE_REPO_CLONE_URL = `${SAMPLE_REPO_URL}.git`;

export const GETTING_STARTED_EXTERNAL_URLS: Readonly<Record<GettingStartedExternalTarget, string>> = {
  claudeCodeDocs: 'https://docs.claude.com/en/docs/claude-code/setup',
  copilotDocs: 'https://code.visualstudio.com/docs/copilot/setup',
  codexDocs: 'https://developers.openai.com/codex',
  geminiCliDocs: 'https://github.com/google-gemini/gemini-cli',
  cursorDocs: 'https://cursor.com/downloads',
  // jsDelivr serves the repo file as video/mp4, so a browser plays it in place.
  // The github.com blob page refuses to preview a file this size.
  videoOnline: 'https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started.mp4',
  dbtInstallDocs: 'https://docs.getdbt.com/docs/core/installation-overview',
  sampleRepo: SAMPLE_REPO_URL,
};

/** Where each assistant's "get it" link in step 1 goes (a fixed target, never a URL from the webview). */
export const ASSISTANT_INSTALL_TARGETS: Readonly<Record<AiAssistantId, GettingStartedExternalTarget>> = {
  claude: 'claudeCodeDocs',
  copilot: 'copilotDocs',
  codex: 'codexDocs',
  gemini: 'geminiCliDocs',
  cursor: 'cursorDocs',
};

export type GettingStartedToHost =
  | { type: 'ready' }
  /** Re-run detection (Claude Code, harness, helper) — the "Re-check" button. Never cached. */
  | { type: 'refreshStatus' }
  | { type: 'setupAiHelper' }
  /**
   * Host writes what to type in `assistant` to the clipboard (`promptFor`):
   * for Claude Code (the default when omitted) "/erd-studio-setup" or the
   * `cd … && claude …` line, see `copyText`.
   */
  | { type: 'copyPrompt'; assistant?: AiAssistantId }
  /** Modal → terminal `claude "/erd-studio-setup"` (cwd = dbt root), or the Claude Code extension. */
  | { type: 'openClaude' }
  /** Copy "/erd-studio-setup" and open Copilot Chat (`workbench.action.chat.open`). */
  | { type: 'openCopilotChat' }
  /** Open a domain canvas, or create the first one. */
  | { type: 'openDomain' }
  | { type: 'openExternal'; target: GettingStartedExternalTarget }
  /** Runs `erdStudio.trySampleProject` (confirm, then clone the fixed sample repo). No payload. */
  | { type: 'trySample' }
  /** No project: VS Code's own folder picker (`vscode.openFolder` with no URI). No payload. */
  | { type: 'openFolder' }
  /** Logged only; the webview has already switched to the poster fallback. */
  | { type: 'videoError'; code: number };

export type GettingStartedToHostType = GettingStartedToHost['type'];

/** Every host-bound type, for the validator and the "every type is handled" test. */
export const GETTING_STARTED_TO_HOST_TYPES: readonly GettingStartedToHostType[] = [
  'ready', 'refreshStatus', 'setupAiHelper', 'copyPrompt', 'openClaude', 'openCopilotChat', 'openDomain', 'openExternal',
  'trySample', 'openFolder', 'videoError',
];

/** How Claude Code was found. `cli` wins when both are present (it can take the prompt as an argument). */
export type ClaudeAvailability = 'missing' | 'extension' | 'cli';

/** Summary of the skill harness + launcher, as the panel's step card shows it. */
export type AiHelperState = 'missing' | 'ready' | 'update' | 'unmanaged';

/** One skill folder's two SKILL.md files. */
export interface SkillFolderState {
  schemaSkill: FileState;
  setupSkill: FileState;
}

/** `.claude/skills/` (Claude Code) and `.agents/skills/` (Copilot, Codex, Gemini CLI, Cursor). */
export type GettingStartedHarness = Record<SkillHarnessTarget, SkillFolderState>;

export interface GettingStartedStatus {
  hasProject: boolean;
  harness: GettingStartedHarness;
  cli: 'missing' | 'ready' | 'stale';
  /** Derived from `harness` + `cli` + `assistants` by `deriveAiHelperState()`. */
  helper: AiHelperState;
  claude: ClaudeAvailability;
  /** Detected AI assistants, in `AI_ASSISTANTS` order (`detectAssistants()`). Empty when none was found. */
  assistants: AiAssistantId[];
  domainCount: number;
  /**
   * The dbt project folder — where Claude Code must run for the skill to be
   * found. `relativePath` is its path under the first workspace folder, or
   * `null` when the workspace folder IS the dbt root (the common case).
   */
  project: { name: string; relativePath: string | null } | null;
}

/** One group of written files, explained in a sentence a beginner can follow. */
export interface SetupFileGroup {
  title: string;
  why: string;
  paths: string[];
}

export interface SetupOutcome {
  ok: boolean;
  /** Workspace-relative paths, plus `~/.erd-studio-cli/…` for the launcher. */
  filesWritten: string[];
  message: string;
}

export type GettingStartedToWebview =
  | { type: 'status'; payload: GettingStartedStatus }
  | { type: 'setupResult'; payload: SetupOutcome & { groups: SetupFileGroup[] } };

/** Validator for messages from the panel's webview. Unknown shapes are rejected (the host warns and ignores). */
export function isGettingStartedToHost(value: unknown): value is GettingStartedToHost {
  if (!value || typeof value !== 'object') { return false; }
  const msg = value as { type?: unknown; target?: unknown; code?: unknown };
  if (typeof msg.type !== 'string') { return false; }
  switch (msg.type) {
    case 'ready':
    case 'refreshStatus':
    case 'setupAiHelper':
    case 'openClaude':
    case 'openCopilotChat':
    case 'openDomain':
    case 'trySample':
    case 'openFolder':
      return true;
    case 'copyPrompt': {
      const assistant = (value as { assistant?: unknown }).assistant;
      return assistant === undefined || isAiAssistantId(assistant);
    }
    case 'openExternal':
      return typeof msg.target === 'string'
        && Object.prototype.hasOwnProperty.call(GETTING_STARTED_EXTERNAL_URLS, msg.target);
    case 'videoError':
      return typeof msg.code === 'number' && Number.isFinite(msg.code);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const SETUP_PROMPT = '/erd-studio-setup';

/**
 * The step card's one-word state, judged over the skill folders setup would
 * write for these assistants (`recommendedSkillTargets`). An unmanaged
 * (hand-written) skill wins so the user learns before clicking that setup
 * will ask; `ready` needs every one of those skills current AND the helper
 * tool installed for this extension version. A newly detected assistant
 * whose folder is still empty therefore reads as `update`.
 */
export function deriveAiHelperState(
  harness: GettingStartedHarness,
  cli: 'missing' | 'ready' | 'stale',
  assistants: readonly AiAssistantId[],
): AiHelperState {
  const folders = recommendedSkillTargets(assistants).map((t) => harness[t]);
  if (folders.some((f) => f.schemaSkill === 'unmanaged' || f.setupSkill === 'unmanaged')) { return 'unmanaged'; }
  if (folders.every((f) => f.schemaSkill === 'current' && f.setupSkill === 'current') && cli === 'ready') { return 'ready'; }
  // Never set up: no setup skill anywhere and no helper tool (the schema skill alone is the old harness).
  if (harness.claude.setupSkill === 'missing' && harness.agents.setupSkill === 'missing' && cli === 'missing') {
    return 'missing';
  }
  return 'update';
}

/**
 * What the user types in `assistant` to start the guided setup, as the
 * Copy button puts it on the clipboard. Claude Code gets `copyText()` (a
 * whole `cd … && claude …` line for a nested dbt project, since its CLI
 * takes the prompt as an argument); every other assistant gets its prompt
 * alone — the panel tells the user which folder to start it in.
 */
export function promptFor(
  assistant: AiAssistantId,
  dbtRoot: string | null,
  workspaceFolder: string | null,
  platform: string,
): string {
  if (assistant === 'claude') { return copyText(dbtRoot, workspaceFolder, platform); }
  return assistantInfo(assistant).prompt;
}

/** The message after a successful setup, naming the assistants it was installed for. */
export function setupReadyMessage(assistants: readonly AiAssistantId[]): string {
  if (assistants.length === 0) {
    return `AI helper ready for ${joinNames(AI_ASSISTANTS.map((a) => a.name))}. ` +
      'Install one, then start the guided setup (the Welcome panel shows what to type).';
  }
  if (assistants.length === 1) {
    return `AI helper ready for ${assistantInfo(assistants[0]).name}: ${startLine(assistants[0])} there ` +
      "(restart it if it's already open).";
  }
  return `AI helper ready for ${joinNames(assistantNames(assistants))}. Start the guided setup in any of them ` +
    "(the Welcome panel shows what to type; restart your assistant if it's already open).";
}

function startLine(id: AiAssistantId): string {
  return id === 'gemini'
    ? `ask \u201c${assistantInfo(id).prompt}\u201d`
    : `run ${assistantInfo(id).prompt}`;
}

/**
 * What the Copy button puts on the clipboard. When the dbt project sits in a
 * subfolder of the workspace, a bare "/erd-studio-setup" would be typed into a
 * Claude session started in the wrong folder (where the skill does not
 * exist), so the whole start line is copied instead.
 *
 * The folder name comes from the file system (the depth-3 `dbt_project.yml`
 * search), so it is quoted as data, never as something the shell expands:
 * single quotes on POSIX (double quotes would still run `$(…)` and
 * backticks), and PowerShell's `Set-Location -LiteralPath '…';` on Windows —
 * VS Code's default Windows terminal is Windows PowerShell 5.1, which has no
 * `&&`, and its single quotes expand nothing. A root with a line break or
 * other control character cannot be pasted as one line at all, so it falls
 * back to the bare prompt (the panel still names the folder to start in).
 */
export function copyText(dbtRoot: string | null, workspaceFolder: string | null, platform: string): string {
  if (!dbtRoot || !workspaceFolder || samePath(dbtRoot, workspaceFolder, platform)) {
    return SETUP_PROMPT;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(dbtRoot)) {
    return SETUP_PROMPT;
  }
  if (platform === 'win32') {
    return `Set-Location -LiteralPath '${dbtRoot.replace(/'/g, "''")}'; claude "${SETUP_PROMPT}"`;
  }
  return `cd '${dbtRoot.replace(/'/g, `'\\''`)}' && claude "${SETUP_PROMPT}"`;
}

function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+$/, '');
    return platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * Group the files a setup wrote under a plain explanation each, so the
 * result reads as "what just happened" rather than a list of dot-paths.
 * Order is fixed; empty groups are dropped; unknown paths go last.
 */
export function describeWrittenFiles(paths: readonly string[]): SetupFileGroup[] {
  const groups: Array<SetupFileGroup & { match: (p: string) => boolean }> = [
    {
      title: 'The guided setup for Claude Code',
      why: 'The /erd-studio-setup skill: the step-by-step walkthrough Claude Code follows in this project.',
      paths: [],
      match: (p) => p.startsWith('.claude/skills/erd-studio-setup/'),
    },
    {
      title: 'The guided setup for GitHub Copilot, Codex, Gemini CLI and Cursor',
      why: 'The same walkthrough in the shared .agents/skills folder, which those assistants read.',
      paths: [],
      match: (p) => p.startsWith('.agents/skills/erd-studio-setup/'),
    },
    {
      title: "ERD Studio's file-format rules",
      why: 'Teaches your assistant how ERD Studio diagram files are laid out, so what it writes opens on the canvas.',
      paths: [],
      match: (p) => /^\.(claude|agents)\/skills\/erd-studio\/(SKILL|SYNC)\.md$/.test(p),
    },
    {
      title: 'A safety check for Claude Code',
      why: 'Makes Claude Code load those rules before it edits your diagrams. It lives in .claude/settings.local.json, which is never committed.',
      paths: [],
      match: (p) => p.endsWith('/enforce-skill.sh') || p === '.claude/settings.local.json',
    },
    {
      title: 'A small checking tool',
      why: 'Your assistant runs it to compare your logical model with your dbt project. It sits in your home folder, outside the project.',
      paths: [],
      match: (p) => p.startsWith('~/.erd-studio-cli/'),
    },
    {
      title: 'Your .gitignore',
      why: 'Lines added so these helper files stay out of git, matching how the existing ERD Studio skill is set up.',
      paths: [],
      match: (p) => p === '.gitignore',
    },
  ];
  const other: SetupFileGroup = { title: 'Other files', why: 'Also written by the setup.', paths: [] };
  for (const p of paths) {
    const group = groups.find((g) => g.match(p));
    (group ?? other).paths.push(p);
  }
  return [...groups, other]
    .filter((g) => g.paths.length > 0)
    .map(({ title, why, paths: ps }) => ({ title, why, paths: ps }));
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export interface GettingStartedHtmlInput {
  cspSource: string;
  nonce: string;
  /** Webview URI of `media/onboarding/getting-started.mp4`, or null when the file is missing (renders the fallback). */
  videoUri: string | null;
  /** Webview URI of `media/onboarding/getting-started-poster.jpg`, or null when missing. */
  posterUri: string | null;
  cues: ReadonlyArray<{ start: number; end: number; text: string }>;
  transcript: string;
}

export function buildGettingStartedCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource}`,
    `media-src ${cspSource}`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ') + ';';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe to inline in a `<script>` block (no `</script>`, no U+2028/9 surprises). */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const ICON_CHECK = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.3 11.3 3 8l1-1 2.3 2.3L12 3.6l1 1z"/></svg>';
const ICON_SOUND = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6h2.5L8 3v10L4.5 10H2zM10.5 5.2a4 4 0 0 1 0 5.6l-.7-.7a3 3 0 0 0 0-4.2zM12.3 3.4a6.5 6.5 0 0 1 0 9.2l-.7-.7a5.5 5.5 0 0 0 0-7.8z"/></svg>';
const ICON_EXTERNAL = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2h5v5h-1V3.7L7.4 9.3l-.7-.7L12.3 3H9zM3 4h4v1H4v7h7V9h1v4H3z"/></svg>';
const ICON_COPY = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 1h8l2 2v9H5zm1 1v9h8V3.4L12.6 2zM2 5h2v1H3v8h7v-1h1v2H2z"/></svg>';
const ICON_CHAT = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v9H6l-3 3v-3H2zm1 1v7h1v1.6L5.6 10H13V3z"/></svg>';
const ICON_TERMINAL = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2h14v12H1zm1 1v10h12V3zm1.6 2.3.7-.7L7.7 8l-3.4 3.4-.7-.7L6.3 8zM8 10h4v1H8z"/></svg>';

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--vscode-editor-background);
  color: var(--vscode-foreground, var(--vscode-editor-foreground));
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  line-height: 1.5;
}
.gs { max-width: 920px; margin: 0 auto; padding: 36px 28px 40px; }
.gs-icon { width: 14px; height: 14px; fill: currentColor; flex: none; }

.gs-hero { margin-bottom: 22px; }
.gs-hero__kicker {
  margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.gs-hero__title { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -.01em; line-height: 1.2; }
.gs-hero__sub { margin: 8px 0 0; font-size: 15px; color: var(--vscode-descriptionForeground); }

.gs-video {
  position: relative; aspect-ratio: 16 / 9; border-radius: 10px; overflow: hidden;
  background: #0f1114; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.gs-video__player { display: block; width: 100%; height: 100%; background: #0f1114; }
.gs-video__player::cue {
  font-family: var(--vscode-font-family); font-size: clamp(13px, 2.1vw, 20px); line-height: 1.35;
  color: #fff; background: rgba(0, 0, 0, .72);
}
.gs-video__sound {
  position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);
  display: inline-flex; align-items: center; gap: 9px;
  padding: 12px 22px; border: 0; border-radius: 999px; cursor: pointer;
  background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  font: inherit; font-size: 15px; font-weight: 600; box-shadow: 0 6px 28px rgba(0, 0, 0, .55);
}
.gs-video__sound[hidden] { display: none; }
.gs-video__sound:hover { background: var(--vscode-button-hoverBackground); }
.gs-video__sound .gs-icon { width: 16px; height: 16px; }
.gs-video__fallback {
  position: absolute; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center;
  gap: 12px; padding: 24px; text-align: center; color: #e9ecef;
}
.gs-video__poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .45; filter: blur(3px); }
.gs-video__fallback-card {
  position: relative; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 20px 28px;
  border-radius: 10px; background: rgba(15, 17, 20, .86); box-shadow: 0 10px 40px rgba(0, 0, 0, .5);
}
.gs-video__fallback-text { margin: 0; font-size: 15px; font-weight: 600; }
.gs-video--fallback .gs-video__player,
.gs-video--fallback .gs-video__sound { display: none; }
.gs-video--fallback .gs-video__fallback { display: flex; }

.gs-transcript { margin: 10px 2px 0; color: var(--vscode-descriptionForeground); }
.gs-transcript summary { cursor: pointer; width: max-content; }
.gs-transcript summary:hover { color: var(--vscode-foreground); }
.gs-transcript__text { margin: 8px 0 0; white-space: pre-line; max-width: 72ch; }

.gs-section-title { margin: 30px 0 12px; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
.gs-steps { display: flex; flex-direction: column; gap: 12px; }
.gs-step {
  display: flex; gap: 14px; padding: 16px 18px; border-radius: 8px;
  background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.gs-step__num {
  flex: none; width: 26px; height: 26px; border-radius: 50%; display: grid; place-items: center;
  font-weight: 700; font-size: 12px;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
}
.gs-step[data-done="true"] .gs-step__num { background: var(--vscode-testing-iconPassed, #2f8a48); color: var(--vscode-editor-background); }
.gs-step__body { flex: 1; min-width: 0; }
.gs-step__title { margin: 2px 0 4px; font-size: 14px; font-weight: 600; }
.gs-step__text { margin: 0 0 12px; max-width: 72ch; color: var(--vscode-descriptionForeground); }
.gs-step__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.gs-step__status { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
.gs-step__status--ok { color: var(--vscode-testing-iconPassed, #2f8a48); }
.gs-step__status--warn { color: var(--vscode-editorWarning-foreground); }
.gs-step__hint { margin: 10px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
.gs-step__hint code, .gs-step__text code, .gs-result code, .gs-noproject code {
  font-family: var(--vscode-editor-font-family); font-size: .95em; padding: 1px 5px; border-radius: 3px;
  background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, .15));
}

.gs-btn {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 14px; border-radius: 4px; cursor: pointer;
  font: inherit; line-height: 18px; border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
}
.gs-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.gs-btn--primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight: 600; }
.gs-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
.gs-btn:disabled { opacity: .6; cursor: default; }
.gs-btn:focus-visible, .gs-link:focus-visible, .gs-transcript summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.gs-link {
  display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; cursor: pointer;
  font: inherit; color: var(--vscode-textLink-foreground);
}
.gs-link:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

[hidden] { display: none !important; }

.gs-result {
  margin: 12px 0 0; padding: 10px 12px; border-radius: 6px; font-size: 12px;
  background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, .1));
  border-left: 3px solid var(--vscode-testing-iconPassed, #2f8a48);
}
.gs-result--error { border-left-color: var(--vscode-errorForeground); }
.gs-result__message { margin: 0 0 6px; font-weight: 600; color: var(--vscode-foreground); }
.gs-result__list { margin: 0; padding: 0; list-style: none; }
.gs-result__item { margin: 6px 0 0; color: var(--vscode-descriptionForeground); }
.gs-result__item strong { color: var(--vscode-foreground); font-weight: 600; }
.gs-result__paths { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 3px; }

.gs-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; padding: 0; list-style: none; }
.gs-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 11px 4px 9px; border-radius: 999px;
  font-size: 12px; font-weight: 600; color: var(--vscode-foreground);
  background: var(--vscode-badge-background, rgba(127, 127, 127, .2));
  border: 1px solid var(--vscode-widget-border, transparent);
}
.gs-chip .gs-icon { color: var(--vscode-testing-iconPassed, #2f8a48); }
.gs-get {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin: 12px 0 0;
  font-size: 12px; color: var(--vscode-descriptionForeground);
}
.gs-recheck { margin: 10px 0 0; font-size: 12px; color: var(--vscode-descriptionForeground); }

.gs-launch { display: flex; flex-direction: column; gap: 8px; margin: 0 0 4px; }
.gs-launch__row {
  display: grid; grid-template-columns: 124px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px;
  padding: 10px 12px; border-radius: 6px;
  background: var(--vscode-editor-background);
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.gs-launch__name { font-weight: 600; }
.gs-launch__prompt {
  justify-self: start; max-width: 100%; overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family); font-size: 13px; padding: 3px 8px; border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, .15));
}
.gs-launch__actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.gs-launch__where { grid-column: 2 / -1; margin: 0; font-size: 12px; color: var(--vscode-descriptionForeground); }
@media (max-width: 620px) {
  .gs-launch__row { grid-template-columns: minmax(0, 1fr); }
  .gs-launch__where { grid-column: auto; }
  .gs-launch__actions { justify-content: flex-start; }
}

.gs-noproject, .gs-sample {
  margin: 14px 0 0; padding: 16px 18px; border-radius: 8px;
  background: var(--vscode-sideBar-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
}
.gs-noproject { margin-top: 26px; }
.gs-sample__title { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: var(--vscode-foreground); }
.gs-sample__text { margin: 0 0 12px; max-width: 72ch; color: var(--vscode-descriptionForeground); }
.gs-sample-link { margin: 0 0 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.gs-footer {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 20px; margin-top: 28px; padding-top: 14px;
  border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(127, 127, 127, .3)));
  font-size: 12px; color: var(--vscode-descriptionForeground);
}
.gs-footer em { font-style: normal; color: var(--vscode-foreground); }
.gs[data-project="false"] .gs-steps-wrap { display: none; }
.gs[data-project="true"] .gs-noproject, .gs[data-project="true"] .gs-sample { display: none; }
.gs[data-project="unknown"] .gs-noproject, .gs[data-project="unknown"] .gs-sample { display: none; }
.gs[data-project="unknown"] .gs-step__actions { visibility: hidden; }
`;

// Plain ES5-style JS so it runs untranspiled in any webview. Talks only in
// GettingStartedToHost / GettingStartedToWebview shapes.
const SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var data = JSON.parse(document.getElementById('gs-data').textContent);
  var root = document.querySelector('.gs');
  var frame = document.querySelector('.gs-video');
  var video = document.querySelector('.gs-video__player');
  var sound = document.querySelector('.gs-video__sound');
  var fellBack = false;

  function post(msg) { vscode.postMessage(msg); }
  function $(sel) { return document.querySelector(sel); }
  function text(sel, value) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) { els[i].textContent = value; }
  }

  function fallBack(code) {
    if (fellBack) { return; }
    fellBack = true;
    frame.classList.add('gs-video--fallback');
    if (video) { try { video.pause(); } catch (e) { /* ignore */ } }
    post({ type: 'videoError', code: code });
  }

  if (!video) {
    fallBack(-1);
  } else {
    // Captions come from GETTING_STARTED_CUES, never a network track element.
    try {
      var track = video.addTextTrack('captions', 'English', 'en');
      for (var i = 0; i < data.cues.length; i++) {
        var c = data.cues[i];
        track.addCue(new VTTCue(c.start, c.end, c.text));
      }
      track.mode = 'showing';
    } catch (e) { /* captions are an enhancement; the transcript is always there */ }

    video.addEventListener('error', function () { fallBack(video.error ? video.error.code : 0); });
    var source = video.querySelector('source');
    if (source) { source.addEventListener('error', function () { fallBack(4); }); }
    setTimeout(function () { if (video.readyState < 1) { fallBack(0); } }, 5000);

    // The narration is the point of the video, so start with sound. Only if the editor's
    // autoplay policy refuses does it play muted (captions still carry it) behind a clear
    // "Turn on sound" button — a muted start with a small corner button read as "no audio".
    function startMuted() {
      video.muted = true;
      sound.hidden = false;
      var q = video.play();
      if (q && q.catch) { q.catch(function () { /* the viewer can press play */ }); }
    }
    video.muted = false;
    var first = video.play();
    if (first && first.catch) { first.catch(startMuted); }

    sound.addEventListener('click', function () {
      video.muted = false;
      if (video.volume === 0) { video.volume = 1; }
      video.currentTime = 0;
      var p = video.play();
      if (p && p.catch) { p.catch(function () { /* the viewer can press play */ }); }
    });
    video.addEventListener('volumechange', function () {
      sound.hidden = !video.muted && video.volume > 0;
    });
  }

  document.addEventListener('click', function (event) {
    var el = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!el) { return; }
    var action = el.getAttribute('data-action');
    if (action === 'openExternal') {
      post({ type: 'openExternal', target: el.getAttribute('data-target') });
    } else if (action === 'setupAiHelper') {
      var btns = document.querySelectorAll('[data-action="setupAiHelper"]');
      for (var j = 0; j < btns.length; j++) { btns[j].disabled = true; }
      text('.gs-setup-label', 'Setting up\\u2026');
      post({ type: 'setupAiHelper' });
    } else if (action === 'copyPrompt') {
      var assistant = el.getAttribute('data-assistant');
      post(assistant ? { type: 'copyPrompt', assistant: assistant } : { type: 'copyPrompt' });
      var label = el.querySelector('.gs-copy-label');
      if (label) {
        var before = label.textContent;
        label.textContent = 'Copied';
        setTimeout(function () { label.textContent = before; }, 1600);
      }
    } else {
      post({ type: action });
    }
  });

  // Each card renders every variant; show the ones whose data-when names the state.
  function setState(step, state) {
    var el = document.querySelector('.gs-step[data-step="' + step + '"]');
    if (!el) { return null; }
    el.setAttribute('data-state', state);
    var variants = el.querySelectorAll('[data-when]');
    for (var i = 0; i < variants.length; i++) {
      variants[i].hidden = variants[i].getAttribute('data-when').split(' ').indexOf(state) < 0;
    }
    return el;
  }

  function names(ids) {
    var out = [];
    for (var i = 0; i < data.assistants.length; i++) {
      if (ids.indexOf(data.assistants[i].id) >= 0) { out.push(data.assistants[i].name); }
    }
    if (out.length <= 1) { return out.join(''); }
    return out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1];
  }

  function renderStatus(s) {
    root.setAttribute('data-project', s.hasProject ? 'true' : 'false');
    var found = s.assistants.length > 0 ? 'found' : 'none';
    var assistant = setState('assistant', found);
    if (assistant) { assistant.setAttribute('data-done', found === 'found' ? 'true' : 'false'); }
    var perAssistant = document.querySelectorAll('[data-assistant-row]');
    for (var a = 0; a < perAssistant.length; a++) {
      perAssistant[a].hidden = s.assistants.indexOf(perAssistant[a].getAttribute('data-assistant-row')) < 0;
    }
    var helper = setState('helper', s.helper);
    if (helper) { helper.setAttribute('data-done', s.helper === 'ready' ? 'true' : 'false'); }
    text('.gs-helper-for', s.assistants.length > 0 ? names(s.assistants) : 'every supported assistant');
    var later = $('.gs-helper-later');
    if (later) { later.hidden = s.assistants.length > 0; }
    // An assistant but no guide installed yet: hide the launch rows, or "Open
    // Claude Code" would start /erd-studio-setup in a project without the skill.
    var start = setState('start', found === 'none' ? 'none' : s.helper === 'missing' ? 'notready' : 'some');
    var canvas = setState('canvas', s.domainCount > 0 ? 'some' : 'none');
    if (canvas) { canvas.setAttribute('data-done', s.domainCount > 0 ? 'true' : 'false'); }
    var btns = document.querySelectorAll('[data-action="setupAiHelper"]');
    for (var j = 0; j < btns.length; j++) { btns[j].disabled = false; }
    text('.gs-setup-label', s.helper === 'ready' ? 'Reinstall my AI helper'
      : s.helper === 'update' ? 'Update my AI helper' : 'Set up my AI helper');
    text('.gs-domain-count', s.domainCount === 1 ? 'You have 1 domain.' : 'You have ' + s.domainCount + ' domains.');
    var p = s.project;
    var nested = !!(p && p.relativePath);
    text('.gs-project-name', p ? p.name : '');
    text('.gs-project-path', p ? (p.relativePath || p.name) : '');
    text('.gs-copy-label--claude', nested ? 'Copy start command' : 'Copy');
    var nestedHints = document.querySelectorAll('.gs-nested-hint');
    for (var k = 0; k < nestedHints.length; k++) { nestedHints[k].hidden = !nested; }
    if (start) { start.setAttribute('data-nested', nested ? 'true' : 'false'); }
  }

  function renderResult(r) {
    var box = $('.gs-result');
    if (!box) { return; }
    box.hidden = false;
    box.className = 'gs-result' + (r.ok ? '' : ' gs-result--error');
    box.textContent = '';
    var msg = document.createElement('p');
    msg.className = 'gs-result__message';
    msg.textContent = r.message;
    box.appendChild(msg);
    if (r.groups && r.groups.length) {
      var list = document.createElement('ul');
      list.className = 'gs-result__list';
      for (var i = 0; i < r.groups.length; i++) {
        var g = r.groups[i];
        var li = document.createElement('li');
        li.className = 'gs-result__item';
        var strong = document.createElement('strong');
        strong.textContent = g.title + ': ';
        li.appendChild(strong);
        li.appendChild(document.createTextNode(g.why));
        var paths = document.createElement('span');
        paths.className = 'gs-result__paths';
        for (var k = 0; k < g.paths.length; k++) {
          var code = document.createElement('code');
          code.textContent = g.paths[k];
          paths.appendChild(code);
        }
        li.appendChild(paths);
        list.appendChild(li);
      }
      box.appendChild(list);
    }
  }

  window.addEventListener('message', function (event) {
    var m = event.data;
    if (!m || typeof m.type !== 'string') { return; }
    if (m.type === 'status') { renderStatus(m.payload); }
    else if (m.type === 'setupResult') { renderResult(m.payload); }
  });

  post({ type: 'ready' });
})();
`;

/** Step 3's row for one assistant: what to type, Copy, and an Open button where the editor can open it. */
function launchRow(id: AiAssistantId): string {
  const a = assistantInfo(id);
  const copyLabel = id === 'claude' ? 'gs-copy-label gs-copy-label--claude' : 'gs-copy-label';
  const open = id === 'claude'
    ? `<button class="gs-btn gs-btn--primary" type="button" data-action="openClaude">${ICON_TERMINAL}Open Claude Code</button>`
    : id === 'copilot'
      ? `<button class="gs-btn gs-btn--primary" type="button" data-action="openCopilotChat">${ICON_CHAT}Open Copilot Chat</button>`
      : '';
  return `<div class="gs-launch__row" data-assistant-row="${id}" hidden>
              <span class="gs-launch__name">${escapeHtml(a.name)}</span>
              <code class="gs-launch__prompt">${escapeHtml(a.prompt)}</code>
              <span class="gs-launch__actions">${open}<button class="gs-btn" type="button" data-action="copyPrompt" data-assistant="${id}">${ICON_COPY}<span class="${copyLabel}">Copy</span></button></span>
              <p class="gs-launch__where">${escapeHtml(a.where)}</p>
            </div>`;
}

/**
 * The whole panel document. Steps render every variant up front and CSS picks
 * one from each card's `data-state`, so the script only flips attributes and
 * sets `textContent` — no HTML is ever built from host data.
 */
export function buildGettingStartedHtml(input: GettingStartedHtmlInput): string {
  const { cspSource, nonce, videoUri, posterUri } = input;
  const n = escapeHtml(nonce);
  const poster = posterUri ? ` poster="${escapeHtml(posterUri)}"` : '';
  const player = videoUri
    ? `<video class="gs-video__player" controls playsinline preload="auto"${poster}>
        <source src="${escapeHtml(videoUri)}" type="video/mp4">
      </video>
      <button class="gs-video__sound" type="button" hidden>${ICON_SOUND}<span>Turn on sound</span></button>`
    : '';
  const fallbackPoster = posterUri ? `<img class="gs-video__poster" src="${escapeHtml(posterUri)}" alt="">` : '';
  const chips = AI_ASSISTANTS.map((a) =>
    `<li class="gs-chip" data-assistant-row="${a.id}" hidden>${ICON_CHECK}${escapeHtml(a.name)}</li>`).join('\n            ');
  const otherLinks = AI_ASSISTANTS.filter((a) => a.id !== 'claude').map((a) =>
    `<button class="gs-link" type="button" data-action="openExternal" data-target="${ASSISTANT_INSTALL_TARGETS[a.id]}">${escapeHtml(a.name)}</button>`,
  ).join('\n              ');
  const launchRows = AI_ASSISTANTS.map((a) => launchRow(a.id)).join('\n            ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildGettingStartedCsp(cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Welcome to ERD Studio</title>
<style nonce="${n}">${STYLE}</style>
</head>
<body>
<main class="gs" data-project="unknown">
  <header class="gs-hero">
    <p class="gs-hero__kicker">ERD Studio</p>
    <h1 class="gs-hero__title">Welcome to ERD Studio</h1>
    <p class="gs-hero__sub">Turn the dbt project you already have into a data model you can see.</p>
  </header>

  <section class="gs-video${videoUri ? '' : ' gs-video--fallback'}" aria-label="Getting-started video">
    ${player}
    <div class="gs-video__fallback">
      ${fallbackPoster}
      <div class="gs-video__fallback-card">
        <p class="gs-video__fallback-text">This editor can't play the video here.</p>
        <button class="gs-btn gs-btn--primary" type="button" data-action="openExternal" data-target="videoOnline">${ICON_EXTERNAL}Watch in your browser</button>
      </div>
    </div>
  </section>
  <details class="gs-transcript">
    <summary>Transcript</summary>
    <p class="gs-transcript__text">${escapeHtml(input.transcript)}</p>
  </details>

  <section class="gs-noproject" aria-label="Open your dbt project">
    <h2 class="gs-sample__title">Have a dbt project?</h2>
    <p class="gs-sample__text">Open the folder that contains its <code>dbt_project.yml</code>. This page opens again there with the setup steps.</p>
    <button class="gs-btn gs-btn--primary" type="button" data-action="openFolder">Open a folder&hellip;</button>
  </section>
  <section class="gs-sample" aria-label="Try the sample project">
    <h2 class="gs-sample__title">No dbt project yet? Try the sample</h2>
    <p class="gs-sample__text">A small Kimball-style dbt project with fake coffee-shop data &mdash; runs on your computer, no account needed.</p>
    <button class="gs-btn gs-btn--primary" type="button" data-action="trySample">Try the sample project</button>
  </section>

  <div class="gs-steps-wrap">
    <h2 class="gs-section-title">Get set up</h2>
    <p class="gs-sample-link"><button class="gs-link" type="button" data-action="trySample">New to this? Try it on the sample project first</button></p>
    <div class="gs-steps">
      <section class="gs-step" data-step="assistant" data-state="loading">
        <span class="gs-step__num">1</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Your AI assistant</h3>
          <p class="gs-step__text" data-when="found" hidden>The guided setup runs inside your AI coding assistant. Found on this computer:</p>
          <ul class="gs-chips" data-when="found" hidden>
            ${chips}
          </ul>
          <p class="gs-step__text" data-when="none" hidden>The guided setup runs inside an AI coding assistant, and none was found on this computer. Install one, then press Re-check. Claude Code is recommended: it's the one the guide is tested with.</p>
          <div class="gs-step__actions" data-when="none" hidden>
            <button class="gs-btn gs-btn--primary" type="button" data-action="openExternal" data-target="claudeCodeDocs">${ICON_EXTERNAL}Get Claude Code</button>
            <button class="gs-btn" type="button" data-action="refreshStatus">Re-check</button>
          </div>
          <p class="gs-get" data-when="none" hidden>Also supported: ${otherLinks}</p>
          <p class="gs-recheck" data-when="found" hidden>Use another one? Install it, then <button class="gs-link" type="button" data-action="refreshStatus">Re-check</button>. Already installed but not listed? Command Palette &rarr; <em>ERD Studio: Install AI Coding Harness</em> &rarr; <em>Agent Skills</em>.</p>
        </div>
      </section>

      <section class="gs-step" data-step="helper" data-state="loading">
        <span class="gs-step__num">2</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Set up my AI helper</h3>
          <p class="gs-step__text" data-when="missing ready update unmanaged" hidden>Adds the <code>/erd-studio-setup</code> guide and ERD Studio's file-format rules for <strong class="gs-helper-for"></strong><span class="gs-helper-later" hidden> (so it's ready whichever you install)</span>, plus a small checking tool your assistant uses behind the scenes.</p>
          <div class="gs-step__actions" data-when="missing ready update unmanaged" hidden>
            <button class="gs-btn gs-btn--primary" type="button" data-action="setupAiHelper"><span class="gs-setup-label">Set up my AI helper</span></button>
          </div>
          <p class="gs-step__status gs-step__status--ok" data-when="ready" hidden>${ICON_CHECK}<span>Installed</span></p>
          <p class="gs-step__status gs-step__status--warn" data-when="update" hidden>Update available</p>
          <p class="gs-step__status gs-step__status--warn" data-when="unmanaged" hidden>A hand-written skill exists. You'll be asked before it's replaced.</p>
          <div class="gs-result" role="status" hidden></div>
        </div>
      </section>

      <section class="gs-step" data-step="start" data-state="loading">
        <span class="gs-step__num">3</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Start the guided setup</h3>
          <p class="gs-step__text" data-when="some none notready" hidden>Your assistant checks your dbt setup, works out how your project is modelled and checks with you, builds your logical model and checks it against dbt, explaining each step.</p>
          <div class="gs-launch" data-when="some" hidden>
            ${launchRows}
          </div>
          <p class="gs-step__hint" data-when="none" hidden>Install an assistant (step 1) and press Re-check to see exactly what to type.</p>
          <p class="gs-step__hint" data-when="notready" hidden>Do step 2 first: <strong>Set up my AI helper</strong> installs the guide your assistant runs.</p>
          <p class="gs-step__hint" data-when="some" hidden>Start your assistant in your dbt project folder: <code class="gs-project-path"></code><span class="gs-nested-hint" hidden>. It's a subfolder here: start a terminal assistant in that folder (Claude Code's Copy includes the <code>cd</code>), or open that folder itself (File &rarr; Open Folder&hellip;) for a chat panel inside the editor.</span></p>
          <p class="gs-step__hint" data-when="some" hidden>Guide not showing up? Restart your assistant from <code class="gs-project-name"></code>.</p>
        </div>
      </section>

      <section class="gs-step" data-step="canvas" data-state="loading">
        <span class="gs-step__num">4</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Open the canvas</h3>
          <p class="gs-step__text" data-when="some" hidden><span class="gs-domain-count"></span> Open one to see your diagram, and switch between Logical and Physical.</p>
          <p class="gs-step__text" data-when="none" hidden>The guided setup creates your first domain for you, or you can start one by hand.</p>
          <div class="gs-step__actions" data-when="some" hidden>
            <button class="gs-btn" type="button" data-action="openDomain">Open a domain</button>
          </div>
          <div class="gs-step__actions" data-when="none" hidden>
            <button class="gs-btn" type="button" data-action="openDomain">Create your first domain</button>
          </div>
        </div>
      </section>
    </div>
  </div>

  <footer class="gs-footer">
    <span>Rewatch any time: ERD Studio sidebar &#9654; button, or Command Palette &rarr; <em>ERD Studio: Watch Getting Started Video</em>.</span>
    <button class="gs-link" type="button" data-action="openExternal" data-target="dbtInstallDocs">New to dbt? How to install it${ICON_EXTERNAL}</button>
  </footer>
</main>
<script type="application/json" id="gs-data" nonce="${n}">${inlineJson({
  cues: input.cues,
  assistants: AI_ASSISTANTS.map((a) => ({ id: a.id, name: a.name })),
})}</script>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
