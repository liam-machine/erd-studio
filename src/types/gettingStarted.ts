/**
 * Welcome panel (the "ERD Studio Tour" tab) — the protocol between the panel's
 * webview and `GettingStartedPanel` (host), plus the pure HTML builder.
 *
 * Deliberately NOT part of the canvas `WebviewMessage` union: the canvas union
 * carries the physical-stage allowlist and the "every type has a live sender
 * and handler" invariant for a different webview and host class. The only
 * canvas-side addition is `openGettingStarted` in `messages.ts`.
 *
 * Pure: no `vscode`, no DOM types, nothing from `src/services/**` (the
 * glass look is the import-free `glassPageStyle.ts` beside this file). The
 * panel HTML is a self-contained string (inline nonce'd `<style>` +
 * `<script>`) and does not load the React bundle.
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
import {
  OPEN_FOLDER_LABEL,
  START_ACTIONS,
  START_ACTION_LABELS,
  TOUR_LABEL,
  type StartAction,
  type StartIntent,
  type StartStorage,
} from './startActions';
import { SHOW_ME_AROUND_COMMAND, SHOW_ME_AROUND_LABEL } from './onboardingGuide';
// The glass tokens and kit shared by the standalone pages: plain strings, no
// imports of its own, so this module stays pure (nothing vscode, no DOM types).
import { GLASS_PAGE_STYLE } from './glassPageStyle';

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/** Fixed destinations for `openExternal`. The webview names one; it never sends a URL. */
export type GettingStartedExternalTarget =
  | 'claudeCodeDocs' | 'copilotDocs' | 'codexDocs' | 'geminiCliDocs' | 'cursorDocs'
  | 'videoOnline' | 'videoOnlineLogical' | 'dbtInstallDocs' | 'sampleRepo' | 'sampleCodespaces';

/**
 * The public sample dbt project (`erdStudio.trySampleProject`): a Kimball
 * jaffle-shop on DuckDB that ships `target/manifest.json` + `catalog.json`, so
 * both stages render with nothing installed. Not bundled in the VSIX. Fixed
 * constants — never a URL from a webview.
 */
export const SAMPLE_REPO_URL = 'https://github.com/liam-machine/erd-studio-sample';
export const SAMPLE_REPO_CLONE_URL = `${SAMPLE_REPO_URL}.git`;
/** GitHub's archive of the sample's `main` — unzips to `erd-studio-sample-main/`. */
export const SAMPLE_REPO_ZIP_URL = `${SAMPLE_REPO_URL}/archive/refs/heads/main.zip`;
/** The same sample opened in a GitHub Codespace (its devcontainer installs dbt and ERD Studio). */
export const SAMPLE_CODESPACES_URL = 'https://codespaces.new/liam-machine/erd-studio-sample?quickstart=1';
/**
 * Whether the panel offers the Codespaces button. Off until the sample repo's
 * devcontainer and diagram are on its `main`: before that the link starts a
 * bare Codespace with no ERD Studio, no dbt and no diagram. The release order
 * is: publish this extension (the devcontainer installs the Marketplace build,
 * and the sample's README names Import from dbt), merge the sample branch, then
 * flip this and restore the walkthrough / README links in a follow-up release.
 */
export const SAMPLE_CODESPACES_LIVE = false;

export const GETTING_STARTED_EXTERNAL_URLS: Readonly<Record<GettingStartedExternalTarget, string>> = {
  claudeCodeDocs: 'https://docs.claude.com/en/docs/claude-code/setup',
  copilotDocs: 'https://code.visualstudio.com/docs/copilot/setup',
  codexDocs: 'https://developers.openai.com/codex',
  geminiCliDocs: 'https://github.com/google-gemini/gemini-cli',
  cursorDocs: 'https://cursor.com/downloads',
  // jsDelivr serves the repo file as video/mp4, so a browser plays it in place.
  // The github.com blob page refuses to preview a file this size.
  videoOnline: 'https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started.mp4',
  // The logical-first cut (the no-folder and logical pages), the same way.
  videoOnlineLogical: 'https://cdn.jsdelivr.net/gh/liam-machine/erd-studio@main/media/onboarding/getting-started-logical.mp4',
  dbtInstallDocs: 'https://docs.getdbt.com/docs/core/installation-overview',
  sampleRepo: SAMPLE_REPO_URL,
  sampleCodespaces: SAMPLE_CODESPACES_URL,
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
  /**
   * One of the start screen's starts (`src/types/startActions.ts`): the host
   * counts it (`recordStart(action, 'welcome')`), runs the fixed command
   * `START_ACTION_COMMANDS[action]` with its fixed argument, then posts a
   * fresh status. Draft-first: only the no-folder page's example sends it
   * (the tab holds no start card; "Open your diagrams" and the import
   * guide's link went with it). `action` is validated against `START_ACTIONS`; a command id is
   * never taken from the webview.
   */
  | { type: 'start'; action: StartAction }
  | { type: 'openExternal'; target: GettingStartedExternalTarget }
  /** Runs `erdStudio.trySampleProject` (confirm, then clone the fixed sample repo). No payload. */
  | { type: 'trySample' }
  /** No project: VS Code's own folder picker (`vscode.openFolder` with no URI). No payload. */
  | { type: 'openFolder' }
  /** Logged only; the webview has already switched to the poster fallback. */
  | { type: 'videoError'; code: number }
  /** The video reached its half-way point or its end, once each per panel. Counted by usage telemetry only. */
  | { type: 'videoProgress'; milestone: VideoMilestone }
  /**
   * **Show Me Around**: the host runs the fixed command `SHOW_ME_AROUND_COMMAND`
   * (the interactive guide, which counts itself). No payload; a choice, so not passive.
   */
  | { type: 'showMeAround' };

export type VideoMilestone = 'half' | 'end';

export type GettingStartedToHostType = GettingStartedToHost['type'];

/** Every host-bound type, for the validator and the "every type is handled" test. */
export const GETTING_STARTED_TO_HOST_TYPES: readonly GettingStartedToHostType[] = [
  'ready', 'refreshStatus', 'setupAiHelper', 'copyPrompt', 'openClaude', 'openCopilotChat', 'start',
  'openExternal', 'trySample', 'openFolder', 'videoError', 'showMeAround',
];

/**
 * Messages the page sends by itself (load, Re-check, the video's own events):
 * none of them is the viewer choosing something, so a panel closed after only
 * these counts as `welcomeLeftNoChoice`.
 */
export const GETTING_STARTED_PASSIVE_TYPES: readonly GettingStartedToHostType[] = [
  'ready', 'refreshStatus', 'videoError', 'videoProgress',
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
  /** A folder is open (the empty window is the only `false`): see `GettingStartedPageMode`. */
  hasProject: boolean;
  /**
   * The open folder has no `dbt_project.yml`: the page leads with New diagram
   * and Import in place of the dbt steps, and names no dbt anywhere.
   * Optional and additive: absent means a dbt project (the page as
   * it was before logical-only mode). The panel host fills it from
   * `GettingStartedDeps.logicalOnly` when `getStatus()` leaves it out.
   */
  logicalOnly?: boolean;
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
  /**
   * How the project stores its model (`erdStudio.storage`). Optional: absent
   * reads as `dbml`. `yaml` / `mixed` (a project from before 2.0) add the
   * Convert to DBML start.
   */
  storage?: StartStorage;
  /**
   * The start the folder suggests (`startIntentFor()`: Convert, Import from
   * dbt, one of the three direct imports when the folder's quick look found
   * that kind of file, else a blank diagram); absent with no folder open.
   * Filled by the panel host. The start card's primary button and its reason
   * line follow it.
   */
  intent?: StartIntent;
  /**
   * The starts the page offers, primary first: `startActionsForIntent(intent)`.
   * Filled by the panel host on every status it posts; the page shows
   * exactly these, in this order.
   */
  starts?: StartAction[];
  /**
   * What ERD Studio can see of the dbt project, for the one line above the
   * cards. Added by the panel host from `GettingStartedDeps.getProjectSummary`;
   * absent (or null) when there is no project or it could not be worked out.
   */
  summary?: ProjectSummary | null;
}

/** The dbt layer convention the Welcome panel names (`detectConventions().layering.style`, minus 'none'). */
export type SummaryLayering = 'medallion' | 'dbt-layered';

export interface ProjectSummary {
  /** dbt models ERD Studio can draw (yml ∪ manifest, minus disabled), or null when unknown. */
  modelCount: number | null;
  layering: SummaryLayering | null;
  /** `absent` is known (no manifest.json); `unknown` means it was not checked. */
  manifest: { state: 'present'; ageDays: number } | { state: 'absent' } | { state: 'unknown' };
  /** `formatProjectSummary()` of the fields above — the text the panel shows. Empty when there is nothing to say. */
  line: string;
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

/**
 * Which of the panel's three pages shows: `nofolder` (empty window: open a
 * folder), `logical` (a folder without dbt: design from scratch or DBML) or
 * `dbt` (a dbt project: Import from dbt and the guided setup).
 */
export type GettingStartedPageMode = 'nofolder' | 'logical' | 'dbt';

/** The page a status describes. */
export function gettingStartedPageMode(s: Pick<GettingStartedStatus, 'hasProject' | 'logicalOnly'>): GettingStartedPageMode {
  if (!s.hasProject) { return 'nofolder'; }
  return s.logicalOnly ? 'logical' : 'dbt';
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
    case 'trySample':
    case 'openFolder':
    case 'showMeAround':
      return true;
    case 'start': {
      const action = (value as { action?: unknown }).action;
      return (START_ACTIONS as readonly unknown[]).includes(action);
    }
    case 'copyPrompt': {
      const assistant = (value as { assistant?: unknown }).assistant;
      return assistant === undefined || isAiAssistantId(assistant);
    }
    case 'openExternal':
      return typeof msg.target === 'string'
        && Object.prototype.hasOwnProperty.call(GETTING_STARTED_EXTERNAL_URLS, msg.target);
    case 'videoError':
      return typeof msg.code === 'number' && Number.isFinite(msg.code);
    case 'videoProgress': {
      const milestone = (value as { milestone?: unknown }).milestone;
      return milestone === 'half' || milestone === 'end';
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const SETUP_PROMPT = '/erd-studio-setup';

/**
 * The guided-setup card's text on the logical-only page (a folder without
 * dbt_project.yml): the setup's no-dbt route designs the model with you. It
 * names no dbt: that page never mentions it.
 */
export const LOGICAL_SETUP_TEXT =
  'Your assistant asks what your business does and designs a first diagram with you — tables, keys, grain and ' +
  'how they connect — or builds on a DBML import or the tables you already have, then checks the files, ' +
  'explaining each step.';

/**
 * "Found 42 dbt models · medallion layout · manifest 3 days old" — each part
 * only when it is known. Model counts, layering and manifest age are all
 * cheap, local facts; nothing here names a model or a path.
 */
export function formatProjectSummary(s: Omit<ProjectSummary, 'line'>): string {
  const parts: string[] = [];
  if (s.modelCount !== null) {
    parts.push(s.modelCount === 0
      ? 'No documented dbt models found yet'
      : `Found ${s.modelCount} dbt model${s.modelCount === 1 ? '' : 's'}`);
  }
  if (s.layering === 'medallion') { parts.push('medallion layout'); }
  if (s.layering === 'dbt-layered') { parts.push('staging \u2192 marts layout'); }
  if (s.manifest.state === 'absent') {
    parts.push('no manifest yet');
  } else if (s.manifest.state === 'present') {
    const d = Math.max(0, Math.floor(s.manifest.ageDays));
    parts.push(d === 0 ? 'manifest from today' : `manifest ${d} day${d === 1 ? '' : 's'} old`);
  }
  return parts.join(' \u00b7 ');
}

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
  // A newer marker (a teammate on a later ERD Studio) is never replaced, so it counts as set up.
  const upToDate = (state: FileState): boolean => state === 'current' || state === 'newer';
  if (folders.every((f) => upToDate(f.schemaSkill) && upToDate(f.setupSkill)) && cli === 'ready') { return 'ready'; }
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

/**
 * The message after a successful setup, naming the assistants it was installed for.
 * `logicalOnly` (a folder without dbt_project.yml): the guided setup has a
 * no-dbt route, so the message still points at it, saying what it is for
 * there (designing the model with the assistant) rather than reading dbt.
 */
export function setupReadyMessage(assistants: readonly AiAssistantId[], opts: { logicalOnly?: boolean } = {}): string {
  const purpose = opts.logicalOnly ? ' to design your data model with you' : '';
  if (assistants.length === 0) {
    return `AI helper ready for ${joinNames(AI_ASSISTANTS.map((a) => a.name))}. ` +
      `Install one, then start the guided setup${purpose} (the ERD Studio Tour tab shows what to type).`;
  }
  if (assistants.length === 1) {
    return `AI helper ready for ${assistantInfo(assistants[0]).name}: ${startLine(assistants[0])} there${purpose} ` +
      "(restart it if it's already open).";
  }
  return `AI helper ready for ${joinNames(assistantNames(assistants))}. Start the guided setup in any of them${purpose} ` +
    "(the ERD Studio Tour tab shows what to type; restart your assistant if it's already open).";
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
 * The other assistants' pre-edit hook configs and their names (mirrors
 * `ASSISTANT_HOOKS` in `src/services/assistantHooks.ts`, which `src/types/`
 * may not import; a test keeps the two in step).
 */
export const ASSISTANT_HOOK_CONFIGS: ReadonlyArray<readonly [config: string, name: string]> = [
  ['.github/copilot/settings.local.json', 'GitHub Copilot'],
  ['.codex/hooks.json', 'Codex'],
  ['.gemini/settings.json', 'Gemini CLI'],
];

/**
 * Group the files a setup wrote under a plain explanation each, so the
 * result reads as "what just happened" rather than a list of dot-paths.
 * Order is fixed; empty groups are dropped; unknown paths go last.
 * `logicalOnly` (a folder without dbt_project.yml): no group names dbt.
 */
export function describeWrittenFiles(paths: readonly string[], opts: { logicalOnly?: boolean } = {}): SetupFileGroup[] {
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
      // Titled below by the assistants whose hook files are in the list.
      title: 'A safety check for your other assistants',
      why: 'Makes them load those rules before their first edit to your diagrams. GitHub Copilot\'s and Codex\'s files stay out of git; '
        + 'Gemini CLI\'s goes in .gemini/settings.json, its settings file for this project.',
      paths: [],
      match: (p) => p.endsWith('/erd-studio-enforce-skill.sh') || ASSISTANT_HOOK_CONFIGS.some(([config]) => p === config),
    },
    {
      title: 'A small checking tool',
      why: opts.logicalOnly
        ? 'Your assistant runs it to check your diagram files. It sits in your home folder, outside the project.'
        : 'Your assistant runs it to compare your logical data model with your dbt project. It sits in your home folder, outside the project.',
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
  const hooks = groups.find((g) => g.title === 'A safety check for your other assistants')!;
  const hooked = ASSISTANT_HOOK_CONFIGS
    .filter(([config]) => hooks.paths.some((p) => p.startsWith(config.slice(0, config.lastIndexOf('/') + 1))))
    .map(([, name]) => name);
  if (hooked.length > 0) {
    const list = (names: string[]) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
    hooks.title = `A safety check for ${list(hooked)}`;
    // Only the sentences for the files actually written.
    const ignored = hooked.filter((n) => n !== 'Gemini CLI');
    hooks.why = [
      'Makes them load those rules before their first edit to your diagrams.',
      ...(ignored.length > 0 ? [`${list(ignored.map((n) => `${n}'s`))} files stay out of git.`] : []),
      ...(hooked.includes('Gemini CLI') ? ["Gemini CLI's check is added to .gemini/settings.json, its settings file for this project."] : []),
    ].join(' ');
    if (hooked.length === 1) { hooks.why = hooks.why.replace('Makes them load', 'Makes it load'); }
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
  /**
   * Webview URI of the cut this page plays, or null when the file is missing
   * (renders the fallback): `media/onboarding/getting-started.mp4` (the dbt
   * tour) on the dbt page, `getting-started-logical.mp4` on the no-folder and
   * logical pages. The host picks it, with the matching poster, cues and
   * transcript; the fallback's online link follows `mode`.
   */
  videoUri: string | null;
  /** Webview URI of that cut's poster (`getting-started-poster.jpg` / `getting-started-logical-poster.jpg`), or null when missing. */
  posterUri: string | null;
  cues: ReadonlyArray<{ start: number; end: number; text: string }>;
  transcript: string;
  /** Offer "Open in Codespaces" next to the dbt page's sample link. Defaults to `SAMPLE_CODESPACES_LIVE`. */
  codespaces?: boolean;
  /**
   * The page the host expects before the first `status` arrives (from its
   * deps), so the headline does not flash and the video's autoplay is decided
   * at once. Omitted: the page waits for the first status. A `status` always
   * wins.
   */
  mode?: GettingStartedPageMode;
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
const ICON_PLAY = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_TERMINAL = '<svg class="gs-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1 2h14v12H1zm1 1v10h12V3zm1.6 2.3.7-.7L7.7 8l-3.4 3.4-.7-.7L6.3 8zM8 10h4v1H8z"/></svg>';

/**
 * The page's own CSS, after GLASS_PAGE_STYLE (the glass tokens, the page
 * chrome and the gp- kit). Colours come only from those tokens, the VS Code
 * theme variables or the --gs-* tokens declared on body below, so dark, light,
 * both high-contrast themes, reduced transparency and reduced motion are
 * handled by the tokens. Buttons and links use the kit (gp-button, gp-link);
 * the gs- classes name the parts the script and tests find.
 */
const PAGE_STYLE = String.raw`
body {
  /* The video stage stays dark in every theme: it frames dark footage. */
  --gs-stage: color-mix(in srgb, black 90%, var(--editor-bg));
  --gs-cue-fg: white;
  --gs-cue-bg: color-mix(in srgb, black 72%, transparent);
  --gs-scrim: color-mix(in srgb, black 38%, transparent);
  --gs-ok-edge: color-mix(in srgb, var(--ok-fg) 40%, transparent);
  --gs-display: 26px;
}

.gs {
  max-width: calc(880px + 2 * var(--space-8));
  margin: 0 auto;
  padding: var(--space-9) var(--space-8) var(--space-9);
  animation: gs-in var(--duration-slow) var(--ease-out) both;
}
@keyframes gs-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.gs-icon { width: 14px; height: 14px; fill: currentColor; flex: none; }
[hidden] { display: none !important; }

/* --- Hero ------------------------------------------------------------------ */

.gs-hero { margin-bottom: var(--space-7); }
.gs-hero__kicker {
  margin: 0 0 var(--space-3);
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-caps);
  text-transform: uppercase;
}
.gs-hero__title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--gs-display);
  font-weight: var(--weight-semibold);
  letter-spacing: -0.02em;
  line-height: var(--leading-tight);
}
.gs-hero__sub {
  margin: var(--space-3) 0 0;
  max-width: 64ch;
  color: var(--text-secondary);
  font-size: var(--text-lg);
}

/* --- The tour (video) ------------------------------------------------------ */

.gs-video {
  position: relative;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--gs-stage);
  /* The hairline sits over the page, not over the dark stage. */
  background-clip: padding-box;
  box-shadow: var(--glass-elevation-2);
}
/* Before the first play: a soft scrim so the one button reads over the poster. */
.gs-video:has(.gs-video__tour:not([hidden]))::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(60% 60% at 50% 50%, var(--gs-scrim), transparent 100%);
}
.gs-video__player { display: block; width: 100%; height: 100%; background: var(--gs-stage); }
.gs-video__player::cue {
  font-family: var(--font-ui);
  font-size: clamp(13px, 2.1vw, 20px);
  line-height: 1.35;
  color: var(--gs-cue-fg);
  background: var(--gs-cue-bg);
}
.gs-video__sound,
.gs-video__tour {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: var(--space-4);
  min-height: 40px;
  padding: 0 var(--space-7);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--text-on-accent);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: var(--glass-elevation-3);
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    transform var(--duration-instant) var(--ease-standard);
}
.gs-video__sound:hover,
.gs-video__tour:hover { background: var(--accent-hover); }
.gs-video__sound:active,
.gs-video__tour:active { transform: translate(-50%, -50%) scale(0.97); }
.gs-video__sound:focus-visible,
.gs-video__tour:focus-visible { outline: var(--focus-outline); outline-offset: 3px; }
.gs-video__sound .gs-icon,
.gs-video__tour .gs-icon { width: 16px; height: 16px; }
.gs-video__fallback {
  position: absolute;
  inset: 0;
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-8);
  text-align: center;
}
.gs-video__poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: .45; filter: blur(3px); }
.gs-video__fallback-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-5);
  max-width: 100%;
  padding: var(--space-7) var(--space-8);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  background: var(--glass-surface-3);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-3);
  color: var(--text-primary);
}
.gs-video__fallback-text { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); }
.gs-video--fallback .gs-video__player,
.gs-video--fallback .gs-video__sound,
.gs-video--fallback .gs-video__tour { display: none; }
.gs-video--fallback .gs-video__fallback { display: flex; }

/* The transcript: a quiet disclosure under the video. */
.gs-transcript { margin: var(--space-4) 0 0; }
.gs-transcript summary {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  min-height: var(--control-height);
  padding: 0 var(--space-4);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
  list-style: none;
  cursor: pointer;
  transition: background-color var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard);
}
.gs-transcript summary::-webkit-details-marker { display: none; }
.gs-transcript summary::before {
  content: '';
  width: 0;
  height: 0;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
  border-left: 5px solid currentColor;
  transition: transform var(--duration-fast) var(--ease-standard);
}
.gs-transcript[open] summary::before { transform: rotate(90deg); }
.gs-transcript summary:hover { background: var(--control-fill-hover); color: var(--text-primary); }
.gs-transcript__text {
  margin: var(--space-3) 0 0;
  max-width: 72ch;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--glass-divider);
  border-radius: var(--radius-md);
  background: var(--glass-well);
  color: var(--text-secondary);
  white-space: pre-line;
}

/* --- Sections and the three steps ----------------------------------------- */

.gs-steps-wrap { padding-top: var(--space-4); }
.gs-section-title {
  margin: var(--space-8) 0 var(--space-2);
  color: var(--text-primary);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--leading-tight);
}
.gs-section-intro { margin: 0 0 var(--space-6); max-width: 72ch; color: var(--text-secondary); }
.gs-summary {
  display: flex;
  width: fit-content;
  max-width: 100%;
  margin: var(--space-8) 0 0;
  padding: var(--space-1) var(--space-5);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--control-fill);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.gs-sample-link { margin: var(--space-5) 0 0; color: var(--text-secondary); font-size: var(--text-sm); }
.gs-sample__note { color: var(--text-tertiary); font-size: var(--text-sm); }

.gs-steps { display: flex; flex-direction: column; gap: var(--space-5); }
.gs-step {
  display: flex;
  gap: var(--space-6);
  padding: var(--space-6) var(--space-7) var(--space-7) var(--space-6);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-surface-2);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-1);
}
.gs-step__num {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin-top: 1px;
  border: 1px solid var(--control-border-selected);
  border-radius: var(--radius-pill);
  background: var(--glass-tint-accent);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-semibold);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
/* A finished step shows a tick in place of its number (the number stays in the text). */
.gs-step[data-done="true"] .gs-step__num {
  border-color: var(--gs-ok-edge);
  background: var(--glass-tint-ok);
  color: var(--ok-fg);
  font-size: 0;
}
.gs-step[data-done="true"] .gs-step__num::after {
  content: '';
  width: 9px;
  height: 5px;
  border-left: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
  transform: translateY(-1px) rotate(-45deg);
}
.gs-step__body { flex: 1; min-width: 0; }
.gs-step__title {
  margin: 2px 0 var(--space-2);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: var(--weight-semibold);
  line-height: var(--leading-tight);
}
.gs-step__text { margin: 0 0 var(--space-5); max-width: 72ch; color: var(--text-secondary); }
.gs-step__text strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
.gs-step__actions { display: flex; flex-wrap: wrap; gap: var(--space-4); }
.gs-step__hint { margin: var(--space-5) 0 0; max-width: 72ch; color: var(--text-secondary); font-size: var(--text-sm); }
.gs-step__hint strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
.gs-step__hint code,
.gs-step__text code,
.gs-result code,
.gs-noproject code,
.gs-sample__text code {
  padding: 0 var(--space-2);
  border: 1px solid var(--glass-divider);
  border-radius: var(--radius-xs);
  background: var(--glass-well);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.92em;
  overflow-wrap: anywhere;
}
/* Statuses: a capsule, tinted by what it means. */
.gs-step__status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: fit-content;
  max-width: 100%;
  margin: var(--space-5) 0 0;
  padding: var(--space-1) var(--space-5);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-pill);
  background: var(--control-fill);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.gs-step__status--ok { border-color: var(--gs-ok-edge); background: var(--glass-tint-ok); }
.gs-step__status--ok .gs-icon { color: var(--ok-fg); }
.gs-step__status--warn {
  border-color: var(--glass-tint-warning-edge);
  border-radius: var(--radius-md);
  background: var(--glass-tint-warning);
}
.gs-get,
.gs-recheck {
  margin: var(--space-5) 0 0;
  color: var(--text-secondary);
  font-size: var(--text-sm);
}
.gs-get { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-6); }
.gs-recheck em,
.gs-footer em { font-style: normal; color: var(--text-primary); }

/* Links are kit gp-link buttons; an icon sits beside the text. */
.gs-link { display: inline-flex; align-items: center; gap: var(--space-2); }
/* While the setup runs, its button says "Setting up…" and shows it is busy. */
.gs-btn[data-action="setupAiHelper"]:disabled { cursor: progress; opacity: 0.7; }

/* Assistants found: one capsule each. */
.gs-chips { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: 0 0 var(--space-5); padding: 0; list-style: none; }
.gs-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-5) var(--space-1) var(--space-4);
  border: 1px solid var(--gs-ok-edge);
  border-radius: var(--radius-pill);
  background: var(--glass-tint-ok);
  color: var(--text-primary);
  font-size: var(--text-sm);
  font-weight: var(--weight-medium);
}
.gs-chip .gs-icon { color: var(--ok-fg); }

/* The setup's result: a notice strip, green when it worked, red when not. */
.gs-result {
  margin: var(--space-5) 0 0;
  padding: var(--space-5) var(--space-6);
  border: 1px solid var(--gs-ok-edge);
  border-radius: var(--radius-md);
  background: var(--glass-tint-ok);
  font-size: var(--text-sm);
}
.gs-result--error { border-color: var(--glass-tint-error-edge); background: var(--glass-tint-error); }
.gs-result__message { margin: 0 0 var(--space-3); color: var(--text-primary); font-weight: var(--weight-semibold); }
.gs-result__message:last-child { margin-bottom: 0; }
.gs-result__list { margin: 0; padding: 0; list-style: none; }
.gs-result__item { margin: var(--space-4) 0 0; color: var(--text-secondary); }
.gs-result__item strong { color: var(--text-primary); font-weight: var(--weight-semibold); }
.gs-result__paths { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); margin-top: var(--space-2); }

/* Step 3: one row per assistant, sunk into the card. */
.gs-launch { display: flex; flex-direction: column; gap: var(--space-4); margin: 0 0 var(--space-2); }
.gs-launch__row {
  display: grid;
  grid-template-columns: 124px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2) var(--space-5);
  padding: var(--space-4) var(--space-4) var(--space-4) var(--space-5);
  border: 1px solid var(--glass-divider);
  border-radius: var(--radius-md);
  background: var(--glass-well);
}
.gs-launch__name { color: var(--text-primary); font-weight: var(--weight-semibold); }
.gs-launch__prompt {
  justify-self: start;
  max-width: 100%;
  padding: var(--space-1) var(--space-4);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-sm);
  background: var(--control-fill);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.gs-launch__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: flex-end; }
.gs-launch__where { grid-column: 2 / -1; margin: 0; color: var(--text-tertiary); font-size: var(--text-sm); }

/* --- No folder open -------------------------------------------------------- */

.gs-noproject {
  margin: var(--space-8) 0 0;
  padding: var(--space-7) var(--space-8);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-xl);
  background: var(--glass-surface-3);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-2);
}
.gs-sample__title {
  margin: 0 0 var(--space-2);
  color: var(--text-primary);
  font-size: var(--text-lg);
  font-weight: var(--weight-semibold);
  letter-spacing: var(--tracking-tight);
  line-height: var(--leading-tight);
}
.gs-sample__text { margin: 0 0 var(--space-6); max-width: 72ch; color: var(--text-secondary); }
.gs-noproject__example {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4) var(--space-5);
  margin: var(--space-6) 0 0;
  padding-top: var(--space-6);
  border-top: 1px solid var(--glass-divider);
  color: var(--text-secondary);
}

/* --- Show Me Around: a card with its one button at the end ----------------- */

.gs-around {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--space-7);
  margin: var(--space-8) 0 0;
  padding: var(--space-6) var(--space-7);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--glass-surface-2);
  -webkit-backdrop-filter: var(--glass-backdrop);
  backdrop-filter: var(--glass-backdrop);
  box-shadow: var(--glass-elevation-1);
}
.gs-around .gs-section-title { grid-column: 1; margin: 0 0 var(--space-2); }
.gs-around .gs-section-intro { grid-column: 1; margin: 0; }
.gs-around > .gs-btn { grid-column: 2; grid-row: 1 / span 2; }

.gs-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: var(--space-4) var(--space-7);
  margin-top: var(--space-9);
  padding-top: var(--space-6);
  border-top: 1px solid var(--glass-divider);
  color: var(--text-tertiary);
  font-size: var(--text-sm);
}

/* --- Page states (the script flips data-project / data-mode) --------------- */

.gs[data-project="false"] .gs-steps-wrap { display: none; }
.gs[data-project="true"] .gs-noproject { display: none; }
.gs[data-project="unknown"] .gs-noproject { display: none; }
.gs[data-project="unknown"] .gs-step__actions { visibility: hidden; }

/* --- Narrow ---------------------------------------------------------------- */

@media (max-width: 620px) {
  .gs-launch__row { grid-template-columns: minmax(0, 1fr); }
  .gs-launch__where { grid-column: auto; }
  .gs-launch__actions { justify-content: flex-start; }
  .gs-around { grid-template-columns: minmax(0, 1fr); }
  .gs-around > .gs-btn { grid-column: 1; grid-row: auto; justify-self: start; margin-top: var(--space-5); }
}
@media (max-width: 480px) {
  .gs { padding: var(--space-8) var(--space-6) var(--space-8); }
  body { --gs-display: 22px; }
  .gs-summary { border-radius: var(--radius-md); }
  .gs-hero__sub { font-size: var(--text-md); }
  .gs-step { gap: var(--space-5); padding: var(--space-5); }
  .gs-noproject { padding: var(--space-6); }
  .gs-video__sound,
  .gs-video__tour { min-height: 34px; padding: 0 var(--space-6); font-size: var(--text-md); }
}

/* --- High contrast: the tints are off, so meaning moves to the border ----- */

body.vscode-high-contrast .gs-step__num,
body.vscode-high-contrast-light .gs-step__num { border-color: var(--glass-border-strong); }
body.vscode-high-contrast .gs-step[data-done="true"] .gs-step__num,
body.vscode-high-contrast-light .gs-step[data-done="true"] .gs-step__num,
body.vscode-high-contrast .gs-chip,
body.vscode-high-contrast-light .gs-chip,
body.vscode-high-contrast .gs-step__status--ok,
body.vscode-high-contrast-light .gs-step__status--ok,
body.vscode-high-contrast .gs-result,
body.vscode-high-contrast-light .gs-result { border-color: var(--ok-fg); }
body.vscode-high-contrast .gs-step__status--warn,
body.vscode-high-contrast-light .gs-step__status--warn { border-color: var(--warning-fg); }
body.vscode-high-contrast .gs-result--error,
body.vscode-high-contrast-light .gs-result--error { border-color: var(--error-fg); }
body.vscode-high-contrast .gs-video__sound,
body.vscode-high-contrast .gs-video__tour,
body.vscode-high-contrast-light .gs-video__sound,
body.vscode-high-contrast-light .gs-video__tour { border-color: var(--vscode-button-border, var(--glass-border)); }
body.vscode-high-contrast .gs-video__sound:hover,
body.vscode-high-contrast .gs-video__tour:hover,
body.vscode-high-contrast-light .gs-video__sound:hover,
body.vscode-high-contrast-light .gs-video__tour:hover,
body.vscode-high-contrast .gs-transcript summary:hover,
body.vscode-high-contrast-light .gs-transcript summary:hover {
  border-color: var(--control-border-hover);
  border-style: dashed;
}

@media (prefers-reduced-motion: reduce) {
  .gs { animation: none; }
  .gs-video__sound:active,
  .gs-video__tour:active { transform: translate(-50%, -50%); }
}
`;

const STYLE = GLASS_PAGE_STYLE + PAGE_STYLE;

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
  var tour = document.querySelector('.gs-video__tour');
  var fellBack = false;
  var started = false;
  var startWithSound = function () {};
  var offerTour = function () {};

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
    if (tour) { tour.hidden = true; }
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

    // Never by itself: the tour waits behind its play button on every page, and plays with
    // sound once clicked. Only if the editor still refuses sound does it play muted
    // (captions still carry it) behind a clear "Turn on sound" button.
    function startMuted() {
      video.muted = true;
      sound.hidden = false;
      var q = video.play();
      if (q && q.catch) { q.catch(function () { /* the viewer can press play */ }); }
    }
    // The default cut (the DBML tour plus a short dbt beat) on the dbt page,
    // the logical-first cut elsewhere (the host picks the file by page); either
    // waits behind its play button until the viewer asks for it.
    startWithSound = function () {
      if (started || fellBack) { return; }
      started = true;
      if (tour) { tour.hidden = true; }
      video.muted = false;
      var first = video.play();
      if (first && first.catch) { first.catch(startMuted); }
    };
    offerTour = function () {
      if (!started && !fellBack && tour) { tour.hidden = false; }
    };
    video.addEventListener('play', function () {
      started = true;
      if (tour) { tour.hidden = true; }
    });
    if (tour) { tour.addEventListener('click', startWithSound); }

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

    // Usage telemetry: how far the video is watched, once per milestone.
    var reachedHalf = false;
    var reachedEnd = false;
    video.addEventListener('timeupdate', function () {
      if (!reachedHalf && video.duration > 0 && video.currentTime >= video.duration / 2) {
        reachedHalf = true;
        post({ type: 'videoProgress', milestone: 'half' });
      }
    });
    video.addEventListener('ended', function () {
      if (reachedEnd) { return; }
      reachedEnd = true;
      post({ type: 'videoProgress', milestone: 'end' });
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
    } else if (action === 'start') {
      post({ type: 'start', action: el.getAttribute('data-start') });
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

  // Cards are numbered in the order they show, so hiding one never leaves a gap.
  function numberSteps() {
    var steps = document.querySelectorAll('.gs-step');
    var n = 0;
    for (var i = 0; i < steps.length; i++) {
      if (steps[i].hidden) { continue; }
      n += 1;
      var num = steps[i].querySelector('.gs-step__num');
      if (num) { num.textContent = String(n); }
    }
  }

  function names(ids) {
    var out = [];
    for (var i = 0; i < data.assistants.length; i++) {
      if (ids.indexOf(data.assistants[i].id) >= 0) { out.push(data.assistants[i].name); }
    }
    if (out.length <= 1) { return out.join(''); }
    return out.slice(0, -1).join(', ') + ' and ' + out[out.length - 1];
  }

  // The page's three states. Elements naming modes in data-modes show only in those.
  function applyMode(mode) {
    root.setAttribute('data-mode', mode);
    var els = document.querySelectorAll('[data-modes]');
    for (var i = 0; i < els.length; i++) {
      els[i].hidden = els[i].getAttribute('data-modes').split(' ').indexOf(mode) < 0;
    }
    offerTour();
  }

  function showStep(step, show) {
    var el = document.querySelector('.gs-step[data-step="' + step + '"]');
    if (el) { el.hidden = !show; }
    return el;
  }

  function renderStatus(s) {
    var mode = !s.hasProject ? 'nofolder' : s.logicalOnly ? 'logical' : 'dbt';
    applyMode(mode);
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
    setState('start', found === 'none' ? 'none' : s.helper === 'missing' ? 'notready' : 'some');
    // The guided setup has a dbt route and a no-dbt one: it shows in both.
    // Draft-first: no start, Convert or "Open your diagrams" card here (the draft,
    // the sidebar and the Convert offer are the starts); the tour, the AI helper and Show Me Around.
    var start = showStep('start', true);
    var summary = $('.gs-summary');
    var line = mode === 'dbt' && s.summary && s.summary.line ? s.summary.line : '';
    if (summary) { summary.textContent = line; summary.hidden = line === ''; }
    numberSteps();
    var btns = document.querySelectorAll('[data-action="setupAiHelper"]');
    for (var j = 0; j < btns.length; j++) { btns[j].disabled = false; }
    text('.gs-setup-label', s.helper === 'ready' ? 'Reinstall my AI helper'
      : s.helper === 'update' ? 'Update my AI helper' : 'Set up my AI helper');
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

  applyMode(data.mode);
  post({ type: 'ready' });
})();
`;

/** What each start's button says on the tab (HTML, fixed text): the one label per action. */
export const START_LABELS: Readonly<Record<StartAction, string>> = Object.fromEntries(
  START_ACTIONS.map((action) => [action, escapeHtml(START_ACTION_LABELS[action])]),
) as Record<StartAction, string>;

/** The tab's title: distinct from VS Code's own Welcome tab (the walkthrough's), named for the tour it leads with. */
export const GETTING_STARTED_TAB_TITLE = 'ERD Studio Tour';

/** The tab's heading. */
export const GETTING_STARTED_HEADING = 'The tour';

/**
 * The Show Me Around section, on every page: the interactive guide (the
 * `erdStudio.showMeAround` command) in place of the short per-start videos.
 * No dbt word: it shows on every page.
 */
// One command id and one label (src/types/onboardingGuide.ts, the guide's own module).
export { SHOW_ME_AROUND_COMMAND, SHOW_ME_AROUND_LABEL };
export const SHOW_ME_AROUND_SECTION_TITLE = 'Find your way around';
export const SHOW_ME_AROUND_SECTION_INTRO = 'Show Me Around points at each part of ERD Studio, using your own tables: where to bring in your data model, how to edit a table, and where your files go.';

/** The upgrader's one notice (once per machine): what is new, in one line, and the tour. */
export const UPGRADE_NOTICE_MESSAGE = 'ERD Studio has a short tour, and can set up your AI assistant to work on the same files.';

/** Step 3's row for one assistant: what to type, Copy, and an Open button where the editor can open it. */
function launchRow(id: AiAssistantId): string {
  const a = assistantInfo(id);
  const copyLabel = id === 'claude' ? 'gs-copy-label gs-copy-label--claude' : 'gs-copy-label';
  const open = id === 'claude'
    ? `<button class="gs-btn gs-btn--primary gp-button gp-button--primary" type="button" data-action="openClaude">${ICON_TERMINAL}Open Claude Code</button>`
    : id === 'copilot'
      ? `<button class="gs-btn gs-btn--primary gp-button gp-button--primary" type="button" data-action="openCopilotChat">${ICON_CHAT}Open Copilot Chat</button>`
      : '';
  return `<div class="gs-launch__row" data-assistant-row="${id}" hidden>
              <span class="gs-launch__name">${escapeHtml(a.name)}</span>
              <code class="gs-launch__prompt">${escapeHtml(a.prompt)}</code>
              <span class="gs-launch__actions">${open}<button class="gs-btn gp-button" type="button" data-action="copyPrompt" data-assistant="${id}">${ICON_COPY}<span class="${copyLabel}">Copy</span></button></span>
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
  const mode: GettingStartedPageMode | 'unknown' = input.mode ?? 'unknown';
  /** `data-modes` for an element shown only on these pages, hidden up front when this is not one of them. */
  const only = (...modes: Array<GettingStartedPageMode | 'unknown'>): string =>
    `data-modes="${modes.join(' ')}"${modes.includes(mode) ? '' : ' hidden'}`;
  /**
   * One start's button (`data-action="start"`). Inside a start group it is
   * hidden until a status lists it; Import from dbt also carries the dbt-only
   * `data-modes`, so no status can make it reachable on a page without dbt.
   */
  const startButton = (action: StartAction, className: string, grouped: boolean): string => {
    const dbtOnly = action === 'drawFromDbt' ? ' data-modes="unknown dbt"' : '';
    const hidden = grouped ? ' hidden' : '';
    return `<button class="${className}" type="button" data-action="start" data-start="${action}"${dbtOnly}${hidden}>${START_LABELS[action]}</button>`;
  };
  // No folder is known up front (the empty window), so its page shows from the first paint: the
  // open-a-folder cards, never the project steps (whose dbt cards would flash before the status).
  const initialProject = mode === 'nofolder' ? 'false' : 'unknown';
  // The sample is a dbt project, so it is offered on the dbt page only (never in an empty window).
  const codespacesButton = (input.codespaces ?? SAMPLE_CODESPACES_LIVE)
    ? ` <button class="gs-link gp-link" type="button" data-action="openExternal" data-target="sampleCodespaces">Open it in Codespaces</button>
      <span class="gs-sample__note">Runs in your browser &mdash; nothing to install.</span>`
    : '';
  const n = escapeHtml(nonce);
  const poster = posterUri ? ` poster="${escapeHtml(posterUri)}"` : '';
  const player = videoUri
    ? `<video class="gs-video__player" controls playsinline preload="auto"${poster}>
        <source src="${escapeHtml(videoUri)}" type="video/mp4">
      </video>
      <button class="gs-video__sound" type="button" hidden>${ICON_SOUND}<span>Turn on sound</span></button>
      <button class="gs-video__tour" type="button" hidden>${ICON_PLAY}<span>${escapeHtml(TOUR_LABEL)}</span></button>`
    : '';
  // The online copy of the cut this page plays: the host picks the logical cut for these pages.
  const videoOnlineTarget: GettingStartedExternalTarget = mode === 'logical' || mode === 'nofolder' ? 'videoOnlineLogical' : 'videoOnline';
  const fallbackPoster = posterUri ? `<img class="gs-video__poster" src="${escapeHtml(posterUri)}" alt="">` : '';
  const chips = AI_ASSISTANTS.map((a) =>
    `<li class="gs-chip" data-assistant-row="${a.id}" hidden>${ICON_CHECK}${escapeHtml(a.name)}</li>`).join('\n            ');
  const otherLinks = AI_ASSISTANTS.filter((a) => a.id !== 'claude').map((a) =>
    `<button class="gs-link gp-link" type="button" data-action="openExternal" data-target="${ASSISTANT_INSTALL_TARGETS[a.id]}">${escapeHtml(a.name)}</button>`,
  ).join('\n              ');
  const launchRows = AI_ASSISTANTS.map((a) => launchRow(a.id)).join('\n            ');
  // Show Me Around (every page): the interactive guide replaces the short per-start videos.
  const aroundSection = `<section class="gs-around" aria-label="${escapeHtml(SHOW_ME_AROUND_SECTION_TITLE)}">
    <h2 class="gs-section-title">${escapeHtml(SHOW_ME_AROUND_SECTION_TITLE)}</h2>
    <p class="gs-section-intro">${escapeHtml(SHOW_ME_AROUND_SECTION_INTRO)}</p>
    <button class="gs-btn gp-button" type="button" data-action="showMeAround">${escapeHtml(SHOW_ME_AROUND_LABEL)}</button>
  </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(buildGettingStartedCsp(cspSource, nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(GETTING_STARTED_TAB_TITLE)}</title>
<style nonce="${n}">${STYLE}</style>
</head>
<body>
<main class="gs" data-project="${initialProject}" data-mode="${mode}">
  <header class="gs-hero">
    <p class="gs-hero__kicker">ERD Studio</p>
    <h1 class="gs-hero__title">${escapeHtml(GETTING_STARTED_HEADING)}</h1>
    <p class="gs-hero__sub" ${only('unknown', 'nofolder', 'logical')}>Design your data model in Git. Let your AI build from it.</p>
    <p class="gs-hero__sub" ${only('dbt')}>Turn the dbt project you already have into a data model you can see.</p>
  </header>

  <section class="gs-video${videoUri ? '' : ' gs-video--fallback'}" aria-label="${escapeHtml(GETTING_STARTED_HEADING)}">
    ${player}
    <div class="gs-video__fallback">
      ${fallbackPoster}
      <div class="gs-video__fallback-card">
        <p class="gs-video__fallback-text">This editor can't play the video here.</p>
        <button class="gs-btn gs-btn--primary gp-button gp-button--primary gp-button--lg" type="button" data-action="openExternal" data-target="${videoOnlineTarget}">${ICON_EXTERNAL}Watch in your browser</button>
      </div>
    </div>
  </section>
  <details class="gs-transcript">
    <summary>Transcript</summary>
    <p class="gs-transcript__text">${escapeHtml(input.transcript)}</p>
  </details>

  <section class="gs-noproject" aria-label="Open a folder">
    <h2 class="gs-sample__title">Open the folder your data model lives in</h2>
    <p class="gs-sample__text">Any folder works: ERD Studio keeps your design in <code>.erd-studio/</code>, next to your code.</p>
    <button class="gs-btn gs-btn--primary gp-button gp-button--primary gp-button--lg" type="button" data-action="openFolder">${escapeHtml(OPEN_FOLDER_LABEL)}</button>
    <p class="gs-noproject__example">Or see a finished data model first: ${startButton('example', 'gs-btn gp-button', false)}</p>
  </section>

  <div class="gs-steps-wrap">
    <p class="gs-summary" role="status" hidden></p>
    <p class="gs-sample-link" ${only('unknown', 'dbt')}><button class="gs-link gp-link" type="button" data-action="trySample">New to this? Try it on the sample project first</button>${codespacesButton}</p>

    <h2 class="gs-section-title">Enrich with your AI assistant (optional)</h2>
    <p class="gs-section-intro" ${only('unknown', 'nofolder', 'dbt')}>Your assistant adds what dbt doesn't record: keys, grain, rationale and your team's modelling style.</p>
    <p class="gs-section-intro" ${only('logical')}>Your assistant reads and writes the same files as the canvas: ask it for tables, keys, grain and rationale, and review its edits like any other change.</p>
    <div class="gs-steps">
      <section class="gs-step" data-step="assistant" data-state="loading">
        <span class="gs-step__num">1</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Your AI assistant</h3>
          <p class="gs-step__text" data-when="found" hidden><span ${only('unknown', 'nofolder', 'dbt')}>The guided setup runs inside your AI coding assistant.</span><span ${only('logical')}>ERD Studio works with the AI coding assistant you already use.</span> Found on this computer:</p>
          <ul class="gs-chips" data-when="found" hidden>
            ${chips}
          </ul>
          <p class="gs-step__text" data-when="none" hidden><span ${only('unknown', 'nofolder', 'dbt')}>The guided setup runs inside an AI coding assistant, and none</span><span ${only('logical')}>ERD Studio works with the AI coding assistant you already use, and none</span> was found on this computer. Install one, then press Re-check.<span ${only('unknown', 'nofolder', 'dbt')}> Claude Code is recommended: it's the one the guide is tested with.</span></p>
          <div class="gs-step__actions" data-when="none" hidden>
            <button class="gs-btn gs-btn--primary gp-button gp-button--primary" type="button" data-action="openExternal" data-target="claudeCodeDocs">${ICON_EXTERNAL}Get Claude Code</button>
            <button class="gs-btn gp-button" type="button" data-action="refreshStatus">Re-check</button>
          </div>
          <p class="gs-get" data-when="none" hidden>Also supported: ${otherLinks}</p>
          <p class="gs-recheck" data-when="found" hidden>Use another one? Install it, then <button class="gs-link gp-link" type="button" data-action="refreshStatus">Re-check</button>. Already installed but not listed? Command Palette &rarr; <em>ERD Studio: Install AI Helper Files…</em> &rarr; <em>Agent Skills</em>.</p>
        </div>
      </section>

      <section class="gs-step" data-step="helper" data-state="loading">
        <span class="gs-step__num">2</span>
        <div class="gs-step__body">
          <h3 class="gs-step__title">Set up my AI helper</h3>
          <p class="gs-step__text" data-when="missing ready update unmanaged" hidden><span ${only('unknown', 'nofolder', 'dbt')}>Adds the <code>/erd-studio-setup</code> guide and ERD Studio's file-format rules for </span><span ${only('logical')}>Adds ERD Studio's file-format rules for </span><strong class="gs-helper-for"></strong><span class="gs-helper-later" hidden> (so it's ready whichever you install)</span><span ${only('unknown', 'nofolder', 'dbt')}>, plus a small checking tool your assistant uses behind the scenes.</span><span ${only('logical')}>, so what your assistant writes opens on the canvas. It also adds the <code>/erd-studio-setup</code> guide and a small checking tool your assistant uses behind the scenes.</span></p>
          <div class="gs-step__actions" data-when="missing ready update unmanaged" hidden>
            <button class="gs-btn gs-btn--primary gp-button gp-button--primary" type="button" data-action="setupAiHelper"><span class="gs-setup-label">Set up my AI helper</span></button>
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
          <p class="gs-step__text" data-when="some none notready" hidden><span ${only('unknown', 'nofolder', 'dbt')}>Your assistant checks your dbt setup, fills in keys, grain and rationale, works out how your project is modelled and checks with you, then checks the result against dbt, explaining each step.</span><span ${only('logical')}>${escapeHtml(LOGICAL_SETUP_TEXT)}</span></p>
          <div class="gs-launch" data-when="some" hidden>
            ${launchRows}
          </div>
          <p class="gs-step__hint" data-when="none" hidden>Install an assistant (see Your AI assistant above) and press Re-check to see exactly what to type.</p>
          <p class="gs-step__hint" data-when="notready" hidden>First press <strong>Set up my AI helper</strong> above: it installs the guide your assistant runs.</p>
          <p class="gs-step__hint" data-when="some" hidden>Start your assistant in your <span ${only('unknown', 'nofolder', 'dbt')}>dbt </span>project folder: <code class="gs-project-path"></code><span class="gs-nested-hint" hidden>. It's a subfolder here: start a terminal assistant in that folder (Claude Code's Copy includes the <code>cd</code>), or open that folder itself (File &rarr; Open Folder&hellip;) for a chat panel inside the editor.</span></p>
          <p class="gs-step__hint" data-when="some" hidden>Guide not showing up? Restart your assistant from <code class="gs-project-name"></code>.</p>
        </div>
      </section>
    </div>
  </div>

  ${aroundSection}

  <footer class="gs-footer">
    <span>Rewatch any time: ERD Studio sidebar &#9654; button, or Command Palette &rarr; <em>ERD Studio: ${escapeHtml(TOUR_LABEL)}</em>.</span>
    <button class="gs-link gp-link" type="button" data-action="openExternal" data-target="dbtInstallDocs" ${only('unknown', 'dbt')}>New to dbt? How to install it${ICON_EXTERNAL}</button>
  </footer>
</main>
<script type="application/json" id="gs-data" nonce="${n}">${inlineJson({
  cues: input.cues,
  assistants: AI_ASSISTANTS.map((a) => ({ id: a.id, name: a.name })),
  mode,
})}</script>
<script nonce="${n}">${SCRIPT}</script>
</body>
</html>`;
}
