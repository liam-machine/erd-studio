/**
 * Pure half of the usage telemetry: the daily counters, the reducers that
 * update them, and the one function that turns a finished day into the
 * heartbeat body the telemetry Worker accepts.
 *
 * Keep this module free of `vscode` and of Node built-ins. Everything the
 * heartbeat can say is decided here, by type: a feature or error is one of the
 * fixed keys below or it cannot be recorded at all, and every size is a bucket
 * rather than a number. There is no field that could carry a name, a path or a
 * message, so there is nothing to scrub. `TelemetryService` owns storage,
 * timing and the network.
 *
 * The shape is a contract with `telemetry/` (the Worker) — change both
 * together, and bump `HEARTBEAT_VERSION` when a field changes meaning.
 */

import type { ModelLoadErrorKind } from '@erd-studio/core';

export const HEARTBEAT_VERSION = 1;

/** Features whose use is counted. The Worker drops any key not in this list. */
export const FEATURES = [
  'physicalStage',
  'compare',
  'syncPlan',
  'launchClaude',
  'dbtCompile',
  'annotation',
  'autoLayout',
  'addModel',
  'addRelationship',
  'harnessInstallClaude',
  'harnessInstallCopilot',
  'harnessInstallGemini',
  'harnessInstallCodex',
  'migrateV5',
  'feedbackOpened',
  'drawFromDbt',
  'addFromDbt',
  'emptyCanvas',
  'dbtParse',
  // Once per day at most (recordFeatureOnce): an ERD Studio AI harness file
  // is installed in the open project. A presence flag, not a usage count.
  'harnessPresent',
  // #113 — where a missing manifest is met (once per day each, featureOnce).
  'manifestMissingCanvas',
  'manifestMissingPhysical',
  'manifestMissingDraw',
  'manifestMissingWelcome',
  'manifestMissingRefresh',
  // #113 — why it is missing (once per day each; booleans only, never a path).
  'manifestNoTargetDir',
  'manifestCustomTargetPath',
  'manifestNoDbtFound',
  // #113 — a manifest.json appeared after being missing: within 10 minutes of
  // a Run dbt parse launch, or otherwise.
  'manifestAfterParse',
  'manifestAppeared',
  // #113 — the Logical-stage missing-manifest hint was dismissed.
  'manifestHintDismissed',
  // Canvas edit requests, one per accepted message, by kind (EDIT_FEATURES).
  'editModel',
  'editColumn',
  'editKey',
  'editDetails',
  'editRelationship',
  'editLayout',
  'editAnnotation',
  'editUndo',
  // How long an auto layout took in the webview, or that it failed.
  'layoutUnder1s',
  'layout1to5s',
  'layoutOver5s',
  'layoutFailed',
  // Where diagrams come from: the New Domain command, or a domain file that
  // appeared on disk without ERD Studio writing it (an AI assistant, a hand
  // edit, a git pull).
  'domainCreated',
  'domainCreatedExternal',
  // Onboarding steps.
  'walkthroughOpened',
  'gettingStartedOpened',
  'videoHalf',
  'videoEnded',
  'videoError',
  'trySample',
  'setupAiHelper',
  'copyPrompt',
  'openClaude',
  'openCopilotChat',
  // The generic Agent Skills target (.agents/skills/), installed for Copilot,
  // Codex, Gemini CLI or Cursor.
  'harnessInstallAgents',
  // Getting-started funnel: where a new user stops, and the routes taken.
  // User choices and project states only — anything that broke is an ERROR_CODE.
  // Draw from dbt (the command, also reached from the Welcome panel and the walkthrough).
  'drawStarted',
  'drawNoModels',
  'drawNoLayers',
  'drawCancelScope',
  'drawCancelLayer',
  'drawCancelName',
  'drawNothingDrawable',
  // Add models from dbt on a canvas (the empty-canvas card and the toolbar).
  'addFromDbtStarted',
  'addFromDbtNeedsV5',
  'addFromDbtNoModels',
  'addFromDbtAllPresent',
  'addFromDbtCancelled',
  'addFromDbtNothingDrawable',
  // Try the Sample Project.
  'trySampleCancelled',
  'trySampleNoGit',
  // Set Up My AI Helper: a hand-written skill was in the way, and the Replace /
  // Keep mine modal was dismissed.
  'setupHelperConflict',
  'setupHelperCancelled',
  // An assistant launch button was pressed before the helper was set up.
  'helperFirstPrompt',
  // Which route Open Claude Code took, or that its confirm was dismissed.
  'openClaudeCli',
  'openClaudeExtension',
  'openClaudeNotFound',
  'openClaudeCancelled',
  // Open Copilot Chat: no chat command (docs opened instead), or only the bare open worked.
  'copilotChatNotFound',
  'copilotChatNoArgs',
  // Welcome panel buttons that lead to a diagram.
  'welcomeDrawFromDbt',
  'welcomeOpenDiagram',
  // Move Relationships to Model Library (#126): the canvas offer and its
  // answers, then the command's own route.
  'relMoveOffered',
  'relMoveReview',
  'relMoveNotNow',
  'relMoveDeclined',
  'relMoveStarted',
  'relMoveCancelled',
  'relMoveNothingToMove',
  'relMoveCompleted',
  'relMoveLeftover',
  // Relationship rework (#133). Use of the new behaviour, one per action:
  // a drag from the "one" side stored turned round on the many side; ⇄ moved
  // the record to the other model's file; ⇄ refused because it would make a
  // whole key the many side; a delete removed more than one stored copy; the
  // notice that another diagram still draws its own copy of a deleted link; a
  // role set or changed; the New Relationship dialog's "Create anyway"
  // against key evidence; the dialog asked for the direction (no evidence);
  // "Mark as key" used; a composite link or a self-reference created; and
  // (once a day, on canvas open) a link drawn whose ends are spelled in
  // another case than the real names.
  'relDragTurned',
  'relSwapMoved',
  'relSwapRefusedKey',
  'relDeleteCopies',
  'relDeleteStillDrawn',
  'relRoleSet',
  'relCreateAnyway',
  'relDirectionAsked',
  'relMarkKey',
  'relComposite',
  'relSelfReference',
  'relCaseRespelled',
  // Move Relationships (#133), once per completed run that did each: moved a
  // one-to-many to its many side, turned a backwards many-to-one round, showed
  // a conflict picker, left two disagreeing model-file copies, left a model
  // file alone (it would lose a comment or an unreadable entry), kept the
  // model library's version over a diagram copy that differed.
  'relMoveRehomed',
  'relMoveTurned',
  'relMoveConflictShown',
  'relMoveDisagreementLeft',
  'relMoveFileLocked',
  'relMoveKeptLibrary',
  // The state of the user's relationships, once a day each, on canvas open
  // (relationshipHealth.surveyLibrary). Their files, not our failures — a
  // write that produces one of these is caught by a relInv* error instead.
  'relStateStoredTwice',
  'relStateOneToMany',
  'relStateBackwards',
  'relStateDanglingModel',
  'relStateDanglingColumn',
  'relStateUnreadable',
  'relStatePartialComposite',
  'relStateDomainCopy',
] as const;
export type TelemetryFeature = (typeof FEATURES)[number];

/** Failure classes that are counted. Anything else is `other`. */
export const ERROR_CODES = [
  // No longer recorded since 1.6.2 (#110): a missing manifest is the normal
  // state of a fresh clone, already reported by the canvas-open `manifest`
  // field. Kept for older clients and so the list order never shifts.
  'manifestMissing',
  'manifestMalformed',
  'manifestTimeout',
  'catalogUnreadable',
  'domainLoad',
  'modelFileParse',
  'layersInvalid',
  'editRejected',
  'migrationFailed',
  'other',
  // Why a logical-models file failed (#110), recorded beside `modelFileParse`,
  // which stays the total. One per ModelFileErrorKind, via modelFileErrorCode().
  'modelFileRead',
  'modelFileYamlIndent',
  'modelFileYamlScalar',
  'modelFileYamlStructure',
  'modelFileYamlDuplicateKey',
  'modelFileYamlOther',
  // Getting started: each one means something broke on a new user's path.
  // The walkthrough command threw (the Welcome panel opened instead).
  'walkthroughFailed',
  // Draw from dbt threw, or could not write the diagram.
  'drawFromDbtFailed',
  'drawWriteFailed',
  // Add models from dbt on a canvas threw (a rejected edit is `editRejected`).
  'addFromDbtFailed',
  // An auto layout failed in the webview; `firstLayoutFailed` is the subset
  // that was the first-open layout of a fresh diagram.
  'layoutFailed',
  'firstLayoutFailed',
  // git.clone of the sample project threw (the GitHub page was offered instead).
  'sampleCloneFailed',
  // Set Up My AI Helper: the skill install failed, the launcher install failed,
  // the launcher's VS Code runtime check failed, or the flow threw.
  'setupHarnessFailed',
  'launcherInstallFailed',
  'launcherRuntimeUnverified',
  'setupFailed',
  // Open Claude Code: the extension is installed but none of the known open
  // commands exists, or the one found threw.
  'claudeOpenCommandMissing',
  'claudeOpenFailed',
  // Open Copilot Chat: the chat command exists but both ways of opening it threw.
  'copilotChatOpenFailed',
  // A Welcome panel message handler or status check threw.
  'welcomePanelFailed',
  // erdStudio.projectPath names a folder with no dbt_project.yml.
  'projectPathInvalid',
  // Why a canvas failed to load, recorded beside `domainLoad`, which stays the
  // total. One per DomainLoadFailure, via domainLoadErrorCode().
  'domainLoadNotDomain',
  'domainLoadMissing',
  'domainLoadUnreadable',
  'domainLoadJson',
  'domainLoadInvalid',
  'domainLoadInternal',
  // Move Relationships to Model Library (#126): refused because a file it
  // would change had unsaved edits, a write failed (every file restored), or
  // the command threw.
  'relMoveDirtyFiles',
  'relMoveWriteFailed',
  'relMoveFailed',
  // A canvas edit (or the duplicate-model rename) could not save a file.
  'saveFailed',
  // Relationship rework (#133). A relationship write whose edit or save
  // failed; a relationship handler threw something other than a refusal it
  // explains; a model file's relationships: list could not be rewritten in
  // place, so the edit was refused; a Move write failed and some file could
  // not be put back.
  'relWriteFailed',
  'relHandlerFailed',
  'relSyncRefused',
  'relMoveRestoreFailed',
  // A relationship write broke an invariant (relationshipHealth
  // .checkRelationshipWrite). Recorded, logged, never blocking: the written
  // link is not one canonical copy in its home, not the cardinality or
  // direction asked for, lost its role; a deleted (or re-keyed) link left a
  // copy; another link vanished or changed; a file gained a duplicate entry;
  // the canvas draws a link twice; the check itself threw.
  'relInvNotCanonical',
  'relInvNotAsIntended',
  'relInvRoleLost',
  'relInvCopyLeft',
  'relInvOtherLost',
  'relInvOtherChanged',
  'relInvDuplicateInFile',
  'relInvDrawnTwice',
  'relInvCheckFailed',
] as const;
export type TelemetryErrorCode = (typeof ERROR_CODES)[number];

export type ActivationOutcome = 'project_found' | 'no_project';
export type TenureBucket = '0' | '1-7' | '8-30' | '31-90' | '90+';
export type DomainCountBucket = '0' | '1-3' | '4-10' | '10+';
/** `none` means no canvas with a model in it was opened that day. */
export type ModelCountBucket = 'none' | '1-10' | '11-50' | '51+';
export type ManifestState = 'ok' | 'missing' | 'stale' | 'unknown';
export type TelemetryStage = 'logical' | 'physical';
export type TelemetrySchemaFormat = 'v5' | 'v4';
export type TelemetryOs = 'darwin' | 'win32' | 'linux' | 'other';

export const MAX_ACTIVATIONS = 50;
export const MAX_CANVAS_OPENS = 200;
export const MAX_COUNTER = 100;

/** The Worker refuses a day older than this, so a heartbeat for one is not sent. */
export const MAX_HEARTBEAT_AGE_DAYS = 7;

/** How far back the on-device retention counts look, in days (including the reported day). */
export const RETENTION_WINDOW_DAYS = 28;

/**
 * The editor app the extension runs in, from `vscode.env.appName`. A fixed
 * list: an app not named here is `other`, never its name.
 */
export const HOSTS = [
  'vscode',
  'vscodeInsiders',
  'cursor',
  'windsurf',
  'vscodium',
  'trae',
  'kiro',
  'positron',
  'antigravity',
  'other',
] as const;
export type TelemetryHost = (typeof HOSTS)[number];

/** Where the extension host runs: `vscode.env.remoteName`, or `web` for vscode.dev-style hosts. */
export const REMOTES = ['local', 'ssh', 'wsl', 'container', 'codespaces', 'web', 'other'] as const;
export type TelemetryRemote = (typeof REMOTES)[number];

/** AI assistants, in `AI_ASSISTANTS` order (`src/types/aiAssistants.ts`). */
export const ASSISTANTS = ['claude', 'copilot', 'codex', 'gemini', 'cursor'] as const;
export type TelemetryAssistant = (typeof ASSISTANTS)[number];

/** ERD Studio harness targets, as `HARNESS_TARGETS` ids. */
export const HARNESSES = ['claude', 'agents', 'copilot', 'gemini', 'codex'] as const;
export type TelemetryHarness = (typeof HARNESSES)[number];

/** How many of the last {@link RETENTION_WINDOW_DAYS} days something happened on. */
export type RecentDaysBucket = '0' | '1' | '2-3' | '4-7' | '8-14' | '15-28';
/** Days from first activation to the first canvas open, or `never` (yet). */
export type FirstCanvasBucket = TenureBucket | 'never';

/** Everything counted for one UTC day, as kept in globalState. */
export interface DailyCounters {
  /** The UTC day (`YYYY-MM-DD`) these counts describe. */
  day: string;
  /** Most recent activation outcome; `null` until this window has activated. */
  activation: ActivationOutcome | null;
  hasSemanticDir: boolean;
  domainCount: DomainCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: ModelCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
  /**
   * The running environment, stamped on every update ({@link stampEnv}) so the
   * day is labelled with the version that counted it, not the one running when
   * the heartbeat goes out the next day. Absent in counters from older builds.
   */
  env?: CounterEnv;
  /** AI assistants detected on this machine today (union). */
  assistants?: TelemetryAssistant[];
  /** ERD Studio harness targets installed and version-marked in the open project today (union). */
  harnesses?: TelemetryHarness[];
}

/** The per-day environment facts, as stamped by {@link stampEnv}. */
export interface CounterEnv {
  extVersion: string;
  vscodeVersion: string;
  host: TelemetryHost;
  remote: TelemetryRemote;
  /** Any update today came from an Extension Development Host or a test run. */
  dev: boolean;
}

/** What the extension host knows about itself, supplied at send time. */
export interface HeartbeatEnv {
  installId: string;
  extVersion: string;
  /** `vscode.version`, e.g. `1.104.2`. Reduced to `major.minor`. */
  vscodeVersion: string;
  /** `process.platform`. */
  platform: string;
  /** The UTC day of first activation (`YYYY-MM-DD`). */
  firstSeenDay: string;
  /** Recent UTC days with an activation — kept on the device, never sent as dates. */
  activeDays?: string[];
  /** Recent UTC days with a canvas open — kept on the device, never sent as dates. */
  canvasDays?: string[];
  /** The UTC day a canvas was first opened, if ever. */
  firstCanvasDay?: string | null;
  /** Fallback when the counters carry no stamped environment (older stored state). */
  host?: TelemetryHost;
  remote?: TelemetryRemote;
  dev?: boolean;
}

/** The exact request body POSTed to `/v1/heartbeat`. */
export interface HeartbeatBody {
  v: typeof HEARTBEAT_VERSION;
  installId: string;
  day: string;
  extVersion: string;
  vscodeMajor: string;
  os: TelemetryOs;
  tenure: TenureBucket;
  activation: ActivationOutcome;
  hasSemanticDir: boolean;
  domainCount: DomainCountBucket;
  activations: number;
  canvasOpens: number;
  stages: TelemetryStage[];
  schemaFormats: TelemetrySchemaFormat[];
  modelCount: ModelCountBucket;
  manifest: ManifestState;
  catalog: boolean;
  features: Partial<Record<TelemetryFeature, number>>;
  errors: Partial<Record<TelemetryErrorCode, number>>;
  host: TelemetryHost;
  remote: TelemetryRemote;
  dev: boolean;
  assistants: TelemetryAssistant[];
  harnesses: TelemetryHarness[];
  activeDays28: RecentDaysBucket;
  canvasDays28: RecentDaysBucket;
  firstCanvas: FirstCanvasBucket;
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/** The UTC day of `date` as `YYYY-MM-DD`. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

export function tenureBucket(days: number): TenureBucket {
  if (days <= 0) return '0';
  if (days <= 7) return '1-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return '90+';
}

export function domainCountBucket(count: number): DomainCountBucket {
  if (count <= 0) return '0';
  if (count <= 3) return '1-3';
  if (count <= 10) return '4-10';
  return '10+';
}

export function modelCountBucket(count: number): ModelCountBucket {
  if (count <= 0) return 'none';
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  return '51+';
}

const MODEL_COUNT_ORDER: readonly ModelCountBucket[] = ['none', '1-10', '11-50', '51+'];

export function recentDaysBucket(count: number): RecentDaysBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 7) return '4-7';
  if (count <= 14) return '8-14';
  return '15-28';
}

/** `vscode.env.appName` → a fixed host id. Order matters: Insiders before stable. */
export function hostBucket(appName: string): TelemetryHost {
  const name = appName.toLowerCase();
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('vscodium')) return 'vscodium';
  if (name.includes('trae')) return 'trae';
  if (name.includes('kiro')) return 'kiro';
  if (name.includes('positron')) return 'positron';
  if (name.includes('antigravity')) return 'antigravity';
  if (name.includes('visual studio code')) return name.includes('insiders') ? 'vscodeInsiders' : 'vscode';
  return 'other';
}

/** `vscode.env.remoteName` (undefined when local) and whether the UI is the web one. */
export function remoteBucket(remoteName: string | undefined, isWeb: boolean): TelemetryRemote {
  if (!remoteName) return isWeb ? 'web' : 'local';
  if (remoteName === 'ssh-remote') return 'ssh';
  if (remoteName === 'wsl') return 'wsl';
  if (remoteName === 'dev-container' || remoteName === 'attached-container') return 'container';
  if (remoteName === 'codespaces') return 'codespaces';
  return 'other';
}

/**
 * `days` plus `day`, dropping days more than {@link RETENTION_WINDOW_DAYS} days
 * before `day`, sorted and without duplicates. The dates stay on the device; only the
 * count ({@link recentDaysCount}) is sent.
 */
export function rememberDay(days: readonly string[] | undefined, day: string): string[] {
  // Only days that have aged out are dropped; a later day (the clock moved
  // back) is kept, and recentDaysCount ignores it until it is in the window.
  const kept = new Set((days ?? []).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && daysBetween(d, day) < RETENTION_WINDOW_DAYS));
  kept.add(day);
  return [...kept].sort();
}

/** How many of `days` fall in the {@link RETENTION_WINDOW_DAYS} days ending on `day`. */
export function recentDaysCount(days: readonly string[] | undefined, day: string): number {
  return new Set((days ?? []).filter(d => inWindow(d, day))).size;
}

function inWindow(d: string, day: string): boolean {
  const age = daysBetween(d, day);
  return age >= 0 && age < RETENTION_WINDOW_DAYS;
}

/** Days from first activation to the first canvas, as of `day`. */
export function firstCanvasBucket(firstSeenDay: string, firstCanvasDay: string | null | undefined, day: string): FirstCanvasBucket {
  if (!firstCanvasDay || daysBetween(firstCanvasDay, day) < 0) return 'never';
  return tenureBucket(daysBetween(firstSeenDay, firstCanvasDay));
}

export function osBucket(platform: string): TelemetryOs {
  return platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'other';
}

/** `1.104.2` → `1.104`; anything unrecognisable → `0.0`. */
export function vscodeMajor(version: string): string {
  return /^(\d+\.\d+)/.exec(version)?.[1] ?? '0.0';
}

/** `1.4.0` and `1.4.0-beta.1` → `1.4.0`; anything unrecognisable → `0.0.0`. */
export function extVersion(version: string): string {
  return /^(\d+\.\d+\.\d+)/.exec(version)?.[1] ?? '0.0.0';
}

// ---------------------------------------------------------------------------
// Reducers — each returns a new DailyCounters and never mutates its input.
// ---------------------------------------------------------------------------

export function emptyCounters(day: string): DailyCounters {
  return {
    day,
    activation: null,
    hasSemanticDir: false,
    domainCount: '0',
    activations: 0,
    canvasOpens: 0,
    stages: [],
    schemaFormats: [],
    modelCount: 'none',
    manifest: 'unknown',
    catalog: false,
    features: {},
    errors: {},
  };
}

/**
 * The counters for `day` that follow `prev`. The project facts from the last
 * activation (outcome, `.erd-studio/` present, domain count) describe a window
 * that is still open, so they carry over; every count starts again.
 */
export function nextDay(prev: DailyCounters, day: string): DailyCounters {
  return {
    ...emptyCounters(day),
    activation: prev.activation,
    hasSemanticDir: prev.hasSemanticDir,
    domainCount: prev.domainCount,
    ...(prev.env ? { env: prev.env } : {}),
    ...(prev.assistants ? { assistants: prev.assistants } : {}),
    ...(prev.harnesses ? { harnesses: prev.harnesses } : {}),
  };
}

/**
 * Label the day with the environment doing the counting. `dev` sticks for the
 * day once set, so a mixed day (a dev host and the everyday window sharing one
 * install) is flagged rather than passed off as ordinary use.
 */
export function stampEnv(state: DailyCounters, env: CounterEnv): DailyCounters {
  const dev = env.dev || state.env?.dev === true;
  const same = state.env
    && state.env.extVersion === env.extVersion
    && state.env.vscodeVersion === env.vscodeVersion
    && state.env.host === env.host
    && state.env.remote === env.remote
    && state.env.dev === dev;
  return same ? state : { ...state, env: { ...env, dev } };
}

export function recordAssistants(state: DailyCounters, found: readonly TelemetryAssistant[]): DailyCounters {
  return { ...state, assistants: unionIn(state.assistants, found, ASSISTANTS) };
}

export function recordHarnesses(state: DailyCounters, found: readonly TelemetryHarness[]): DailyCounters {
  return { ...state, harnesses: unionIn(state.harnesses, found, HARNESSES) };
}

/** `a ∪ b`, restricted to `order` and in its order. */
function unionIn<T extends string>(a: readonly T[] | undefined, b: readonly T[], order: readonly T[]): T[] {
  return order.filter(v => a?.includes(v) || b.includes(v));
}

export function recordActivation(
  state: DailyCounters,
  info: { outcome: ActivationOutcome; hasSemanticDir: boolean; domainCount: number },
): DailyCounters {
  return {
    ...state,
    activation: info.outcome,
    hasSemanticDir: info.hasSemanticDir,
    domainCount: domainCountBucket(info.domainCount),
    activations: Math.min(state.activations + 1, MAX_ACTIVATIONS),
  };
}

export function recordCanvasOpen(
  state: DailyCounters,
  info: { stage: TelemetryStage; format: TelemetrySchemaFormat; modelCount: number },
): DailyCounters {
  const seen = modelCountBucket(info.modelCount);
  const largest = MODEL_COUNT_ORDER.indexOf(seen) > MODEL_COUNT_ORDER.indexOf(state.modelCount) ? seen : state.modelCount;
  return {
    ...state,
    canvasOpens: Math.min(state.canvasOpens + 1, MAX_CANVAS_OPENS),
    stages: addOnce(state.stages, info.stage),
    schemaFormats: addOnce(state.schemaFormats, info.format),
    modelCount: largest,
  };
}

export function recordStage(state: DailyCounters, stage: TelemetryStage): DailyCounters {
  return { ...state, stages: addOnce(state.stages, stage) };
}

export function recordManifest(state: DailyCounters, manifest: Exclude<ManifestState, 'unknown'>): DailyCounters {
  return { ...state, manifest };
}

export function recordCatalog(state: DailyCounters, present: boolean): DailyCounters {
  return { ...state, catalog: state.catalog || present };
}

export function recordFeature(state: DailyCounters, feature: TelemetryFeature): DailyCounters {
  return { ...state, features: bump(state.features, feature) };
}

/** Count `feature` at most once for the day — a presence flag, not a usage count. */
export function recordFeatureOnce(state: DailyCounters, feature: TelemetryFeature): DailyCounters {
  return state.features[feature] ? state : recordFeature(state, feature);
}

const MODEL_FILE_ERROR_CODES: Record<ModelLoadErrorKind, TelemetryErrorCode> = {
  read: 'modelFileRead',
  yamlIndent: 'modelFileYamlIndent',
  yamlScalar: 'modelFileYamlScalar',
  yamlStructure: 'modelFileYamlStructure',
  yamlDuplicateKey: 'modelFileYamlDuplicateKey',
  yamlOther: 'modelFileYamlOther',
};

/** The error sub-code counted for a model-file failure of `kind`; recorded alongside `modelFileParse`. */
export function modelFileErrorCode(kind: ModelLoadErrorKind): TelemetryErrorCode {
  return MODEL_FILE_ERROR_CODES[kind] ?? 'modelFileYamlOther';
}

/**
 * Why a canvas could not load its domain: not a domain path, the file is gone
 * or cannot be read, its text is not JSON (or empty), it is JSON that fails
 * validation (schema version, format, layer), or anything else threw.
 */
export type DomainLoadFailure = 'notDomain' | 'missing' | 'unreadable' | 'json' | 'invalid' | 'internal';

const DOMAIN_LOAD_ERROR_CODES: Record<DomainLoadFailure, TelemetryErrorCode> = {
  notDomain: 'domainLoadNotDomain',
  missing: 'domainLoadMissing',
  unreadable: 'domainLoadUnreadable',
  json: 'domainLoadJson',
  invalid: 'domainLoadInvalid',
  internal: 'domainLoadInternal',
};

/** The error sub-code counted for a canvas load failure of `kind`; recorded alongside `domainLoad`. */
export function domainLoadErrorCode(kind: DomainLoadFailure): TelemetryErrorCode {
  return DOMAIN_LOAD_ERROR_CODES[kind] ?? 'domainLoadInternal';
}

/** The feature key for an auto layout that took `ms` milliseconds, or failed. */
export function layoutFeature(ms: number, ok: boolean): TelemetryFeature {
  if (!ok) return 'layoutFailed';
  if (ms < 1000) return 'layoutUnder1s';
  if (ms <= 5000) return 'layout1to5s';
  return 'layoutOver5s';
}

export function recordError(state: DailyCounters, code: TelemetryErrorCode): DailyCounters {
  return { ...state, errors: bump(state.errors, code) };
}

function addOnce<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list : [...list, value];
}

function bump<K extends string>(counts: Partial<Record<K, number>>, key: K): Partial<Record<K, number>> {
  return { ...counts, [key]: Math.min((counts[key] ?? 0) + 1, MAX_COUNTER) };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Whether the finished day `state` should be sent on `today`. A day with no
 * activation, no canvas and nothing counted (a window left open overnight) is
 * not news, and a day older than the Worker accepts would only be refused.
 */
export function heartbeatDue(state: DailyCounters, today: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.day)) return false;
  const age = daysBetween(state.day, today);
  if (!(age >= 1 && age <= MAX_HEARTBEAT_AGE_DAYS)) return false;
  if (state.activation === null) return false;
  return (
    state.activations > 0 ||
    state.canvasOpens > 0 ||
    Object.keys(state.features).length > 0 ||
    Object.keys(state.errors).length > 0
  );
}

/**
 * The heartbeat body for a finished day. Rebuilt field by field from the
 * allowlists rather than spread from `state`, so a stray key in stored state —
 * from an older build, say — can never reach the wire.
 */
export function buildHeartbeat(state: DailyCounters, env: HeartbeatEnv): HeartbeatBody {
  const stamped = state.env;
  return {
    v: HEARTBEAT_VERSION,
    installId: env.installId,
    day: state.day,
    extVersion: extVersion(stamped?.extVersion ?? env.extVersion),
    vscodeMajor: vscodeMajor(stamped?.vscodeVersion ?? env.vscodeVersion),
    os: osBucket(env.platform),
    tenure: tenureBucket(daysBetween(env.firstSeenDay, state.day)),
    activation: pick(state.activation, ['project_found', 'no_project'], 'no_project'),
    hasSemanticDir: state.hasSemanticDir === true,
    domainCount: pick(state.domainCount, ['0', '1-3', '4-10', '10+'], '0'),
    activations: clampCount(state.activations, MAX_ACTIVATIONS),
    canvasOpens: clampCount(state.canvasOpens, MAX_CANVAS_OPENS),
    stages: (['logical', 'physical'] as const).filter(s => state.stages?.includes(s)),
    schemaFormats: (['v5', 'v4'] as const).filter(f => state.schemaFormats?.includes(f)),
    modelCount: pick(state.modelCount, MODEL_COUNT_ORDER, 'none'),
    manifest: pick(state.manifest, ['ok', 'missing', 'stale', 'unknown'], 'unknown'),
    catalog: state.catalog === true,
    features: allowedCounts(state.features, FEATURES),
    errors: allowedCounts(state.errors, ERROR_CODES),
    host: pick(stamped?.host ?? env.host, HOSTS, 'other'),
    remote: pick(stamped?.remote ?? env.remote, REMOTES, 'local'),
    dev: (stamped?.dev ?? env.dev) === true,
    assistants: ASSISTANTS.filter(a => state.assistants?.includes(a)),
    harnesses: HARNESSES.filter(h => state.harnesses?.includes(h)),
    activeDays28: recentDaysBucket(recentDaysCount(env.activeDays, state.day)),
    canvasDays28: recentDaysBucket(recentDaysCount(env.canvasDays, state.day)),
    firstCanvas: firstCanvasBucket(env.firstSeenDay, env.firstCanvasDay, state.day),
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function clampCount(value: unknown, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), max)) : 0;
}

function allowedCounts<K extends string>(
  counts: Partial<Record<K, number>> | undefined,
  keys: readonly K[],
): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const n = clampCount(counts?.[key], MAX_COUNTER);
    if (n > 0) out[key] = n;
  }
  return out;
}
