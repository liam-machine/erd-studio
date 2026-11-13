/**
 * The 2.0 runtime failure keys (telemetry plan items B4, B10, B12, B16, B18
 * and B19): fixed tables from what failed to the key that counts it, so a
 * call site records with one line and a name, path or message can never be
 * one of the keys. Pure and vscode-free; the call sites hand the keys to the
 * `telemetry` facade.
 *
 * Every key here is written out as a literal, so `tsc` rejects a key that is
 * not in the allowlists (`telemetryPayload.ts`) and a search finds its use.
 */

import { writeFailureKey } from './importTelemetry';
import { ERROR_CODES, type TelemetryErrorCode, type TelemetryFeature } from './telemetryPayload';
import type { WebviewMessageType } from '../types/messages';
import type { AssistantHookSkipReason, SkippedAssistantHook } from '../types/harness';
import type { GettingStartedToHostType } from '../types/gettingStarted';

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/** Whether `key` is an error code (else it is a feature). */
export function isTelemetryErrorCode(key: TelemetryErrorCode | TelemetryFeature): key is TelemetryErrorCode {
  return ERROR_CODE_SET.has(key);
}

// ---------------------------------------------------------------------------
// B4: activation
// ---------------------------------------------------------------------------

/** The stretch of `activate()` that was running (checkpoints in `extension.ts`). */
export type ActivationPhase = 'Discovery' | 'Services' | 'Views' | 'Watchers' | 'Commands' | 'Prompts';

export const ACTIVATION_FAILED: Record<ActivationPhase, TelemetryErrorCode> = {
  Discovery: 'activationFailedDiscovery',
  Services: 'activationFailedServices',
  Views: 'activationFailedViews',
  Watchers: 'activationFailedWatchers',
  Commands: 'activationFailedCommands',
  Prompts: 'activationFailedPrompts',
};

/** `activationFailed` and its phase, for an `activate()` that threw. */
export function activationFailureCodes(phase: ActivationPhase): TelemetryErrorCode[] {
  return ['activationFailed', ACTIVATION_FAILED[phase]];
}

/** Project read later than this into activation counts `activationOver10s`. */
export const SLOW_ACTIVATION_MS = 10_000;

/** How the host's own search for dbt_project.yml ended. */
export type DbtSearchOutcome = 'ok' | 'timeout' | 'error';

/**
 * Why a search that ended in `error` failed (#304): `findFiles` rejected,
 * the code that sorts what it returned threw, or `findFiles` threw before
 * returning a promise.
 */
export type DbtSearchFailure = 'rejected' | 'sort' | 'threw';

/** What `findHostDbtProjects` returns: paths only when it answered, a reason only when it failed. */
export type DbtSearchResult =
  | { paths: string[]; outcome: 'ok' }
  | { paths?: undefined; outcome: 'timeout' }
  | { paths?: undefined; outcome: 'error'; reason: DbtSearchFailure };

export const DBT_SEARCH_FAILED: Record<DbtSearchFailure, TelemetryErrorCode> = {
  rejected: 'dbtSearchFailedRejected',
  sort: 'dbtSearchFailedSort',
  threw: 'dbtSearchFailedThrew',
};

/** `dbtSearchFailed` (the total) and why, for a search that ended in `error`. */
export function dbtSearchFailureCodes(reason: DbtSearchFailure): TelemetryErrorCode[] {
  return ['dbtSearchFailed', DBT_SEARCH_FAILED[reason]];
}

// ---------------------------------------------------------------------------
// B10 and B16: a write the environment refused
// ---------------------------------------------------------------------------

/**
 * The write class of a failure the user can fix (permissions, a full disk),
 * as a feature; undefined for anything else. Reads only the error's code (or
 * an errno in its message), never a path.
 */
export function writeFailureFeature(err: unknown): TelemetryFeature | undefined {
  // One mapping for every write class: importTelemetry's writeFailureKey.
  const key = writeFailureKey(err);
  return 'feature' in key ? key.feature : undefined;
}

// ---------------------------------------------------------------------------
// B12: canvas handlers, watchers
// ---------------------------------------------------------------------------

/** What a canvas message does, for its handler-failure code. */
export type HandlerGroup =
  | 'model' | 'column' | 'key' | 'details' | 'layout' | 'annotation' | 'undo'
  | 'stage' | 'compare' | 'refresh' | 'relationship' | 'other';

/**
 * Every webview → host message type and its group. A full `Record`: a new
 * message type does not compile until it is placed (use `other` when no
 * group fits). Relationship handlers keep their own `relHandlerFailed`.
 */
export const HANDLER_GROUP: Record<WebviewMessageType, HandlerGroup> = {
  ready: 'refresh',
  guide: 'other',
  requestExistingTables: 'other',
  requestNewRelationshipFiles: 'other',
  dismissManifestHint: 'compare',
  addModel: 'model',
  addColumn: 'column',
  removeColumn: 'column',
  updateColumn: 'column',
  addRelationship: 'relationship',
  renameModel: 'model',
  removeModel: 'model',
  removeModels: 'model',
  removeRelationship: 'relationship',
  removeRelationships: 'relationship',
  updateRelationship: 'relationship',
  editRelationship: 'relationship',
  addExistingModel: 'model',
  addExistingModels: 'model',
  addModelsFromDbt: 'model',
  dropTables: 'model',
  updatePositions: 'layout',
  refreshManifest: 'refresh',
  undo: 'undo',
  redo: 'undo',
  toggleColumnKey: 'key',
  updateModelRationale: 'details',
  updateModelDescription: 'details',
  updateModelGrain: 'details',
  updateModelAlias: 'details',
  updateMeta: 'details',
  updateModelRole: 'details',
  switchStage: 'stage',
  toggleDiscrepancy: 'compare',
  reorderColumns: 'column',
  viewFile: 'other',
  requestFeedbackContext: 'other',
  analyzeFeedback: 'other',
  setFeedbackProvider: 'other',
  setLineStyle: 'other',
  submitFeedback: 'other',
  copyFeedbackReport: 'other',
  openFeedbackLink: 'other',
  requestReload: 'other',
  closeEditor: 'other',
  importEmbeddedTables: 'model',
  openAnotherDomain: 'other',
  openGettingStarted: 'other',
  showLogs: 'other',
  exportDiagram: 'other',
  generateSyncPlan: 'compare',
  runDbtCompile: 'other',
  runDbtParse: 'other',
  launchClaudeSync: 'other',
  addAnnotation: 'annotation',
  updateAnnotation: 'annotation',
  removeAnnotation: 'annotation',
  removeAnnotations: 'annotation',
  openModelFile: 'other',
  openFieldsFile: 'other',
  goToTable: 'other',
  showTableOnOtherDiagrams: 'other',
  moveTable: 'model',
  copyTablePath: 'other',
  revealTableInLibrary: 'other',
  layoutFinished: 'layout',
  webviewError: 'other',
  crashFallback: 'other',
  openNotedFile: 'other',
  addRelationshipsImports: 'relationship',
  reloadFromDisk: 'refresh',
};

const HANDLER_FAILED: Record<Exclude<HandlerGroup, 'relationship'>, TelemetryErrorCode> = {
  model: 'handlerFailedModel',
  column: 'handlerFailedColumn',
  key: 'handlerFailedKey',
  details: 'handlerFailedDetails',
  layout: 'handlerFailedLayout',
  annotation: 'handlerFailedAnnotation',
  undo: 'handlerFailedUndo',
  stage: 'handlerFailedStage',
  compare: 'handlerFailedCompare',
  refresh: 'handlerFailedRefresh',
  other: 'handlerFailedOther',
};

/** A message type's group; `other` for a type this host does not know. */
export function handlerGroupOf(type: string): HandlerGroup {
  return Object.prototype.hasOwnProperty.call(HANDLER_GROUP, type) ? HANDLER_GROUP[type as WebviewMessageType] : 'other';
}

/**
 * What one canvas handler failure counts:
 * - a DBML writer overlap (`DbmlEditRefused` with reason `overlap`) is ours,
 *   whatever the user was told: `dbmlWriteOverlap`, then counted as a failure;
 * - another refusal the user was told about in plain words: `editRefused`
 *   (nothing for a relationship handler, which counts only its failures);
 * - the diagram file itself is broken, missing or locked (`userFile`, a file
 *   the user or an assistant wrote, met on a stage switch or a comparison):
 *   `handlerFileProblem`, never a failure of ours;
 * - anything else: `handlerFailed` and the group's code, or for a
 *   relationship handler only the existing `relHandlerFailed`.
 */
export function handlerFailureKeys(
  group: HandlerGroup,
  failure: { explained: boolean; overlap: boolean; userFile?: boolean },
): { errors: TelemetryErrorCode[]; features: TelemetryFeature[] } {
  const errors: TelemetryErrorCode[] = failure.overlap ? ['dbmlWriteOverlap'] : [];
  if (failure.userFile === true && !failure.overlap) return { errors, features: ['handlerFileProblem'] };
  if (failure.explained && !failure.overlap) {
    return { errors, features: group === 'relationship' ? [] : ['editRefused'] };
  }
  if (group === 'relationship') errors.push('relHandlerFailed');
  else errors.push('handlerFailed', HANDLER_FAILED[group]);
  return { errors, features: [] };
}

/** Which watcher refresh failed. */
export type RefreshKind = 'Manifest' | 'Catalog' | 'Table' | 'Diagram' | 'Layers' | 'DbtYml';

export const REFRESH_FAILED: Record<RefreshKind, TelemetryErrorCode> = {
  Manifest: 'refreshFailedManifest',
  Catalog: 'refreshFailedCatalog',
  Table: 'refreshFailedTable',
  Diagram: 'refreshFailedDiagram',
  Layers: 'refreshFailedLayers',
  DbtYml: 'refreshFailedDbtYml',
};

// ---------------------------------------------------------------------------
// B16: AI helper files
// ---------------------------------------------------------------------------

export type HarnessTargetId = 'claude' | 'agents' | 'copilot' | 'gemini' | 'codex';

export const HARNESS_INSTALL_FAILED: Record<HarnessTargetId, TelemetryErrorCode> = {
  claude: 'harnessInstallFailedClaude',
  agents: 'harnessInstallFailedAgents',
  copilot: 'harnessInstallFailedCopilot',
  gemini: 'harnessInstallFailedGemini',
  codex: 'harnessInstallFailedCodex',
};

/**
 * One failed helper install: `harnessInstallFailed`, its target and, when
 * the failure carried an errno the user can fix, the write class.
 */
export function harnessFailureKeys(
  target: HarnessTargetId | undefined,
  errno: string | undefined,
): { errors: TelemetryErrorCode[]; features: TelemetryFeature[] } {
  const errors: TelemetryErrorCode[] = ['harnessInstallFailed'];
  if (target) errors.push(HARNESS_INSTALL_FAILED[target]);
  const writeClass = errno ? writeFailureFeature({ code: errno }) : undefined;
  return { errors, features: writeClass ? [writeClass] : [] };
}

export const HOOK_SKIPPED_REASON: Record<AssistantHookSkipReason, TelemetryFeature> = {
  jsonc: 'hookSkippedJsonc',
  'not-json': 'hookSkippedNotJson',
  shape: 'hookSkippedShape',
  'own-script': 'hookSkippedOwnScript',
  'newer-script': 'hookSkippedNewerScript',
};

export const HOOK_SKIPPED_TARGET: Record<SkippedAssistantHook['id'], TelemetryFeature> = {
  copilot: 'hookSkippedCopilot',
  codex: 'hookSkippedCodex',
  gemini: 'hookSkippedGemini',
};

/** The presence flags for the assistant hooks left out on purpose (each once, in order). */
export function hookSkippedFeatures(skipped: readonly SkippedAssistantHook[] | undefined): TelemetryFeature[] {
  const out: TelemetryFeature[] = [];
  for (const s of skipped ?? []) {
    for (const f of [HOOK_SKIPPED_REASON[s.reason], HOOK_SKIPPED_TARGET[s.id]]) {
      if (f && !out.includes(f)) out.push(f);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// B18: the Welcome panel
// ---------------------------------------------------------------------------

/** The Welcome panel's failure code for the message whose handler threw. */
export function welcomeFailureCode(type: GettingStartedToHostType | string | undefined): TelemetryErrorCode {
  switch (type) {
    case 'start': return 'welcomeFailedStart';
    case 'setupAiHelper': return 'welcomeFailedSetup';
    case 'openClaude':
    case 'openCopilotChat': return 'welcomeFailedOpenAssistant';
    case 'trySample': return 'welcomeFailedSample';
    case 'ready':
    case 'refreshStatus': return 'welcomeFailedStatus';
    default: return 'welcomeFailedOther';
  }
}

// ---------------------------------------------------------------------------
// B19: every logged error, by area
// ---------------------------------------------------------------------------

export type LoggedErrorArea = 'Canvas' | 'Import' | 'Draft' | 'Sidebar' | 'Harness' | 'Dbt' | 'Other';

const LOGGED_ERROR_CODES: Record<LoggedErrorArea, TelemetryErrorCode> = {
  Canvas: 'loggedErrorCanvas',
  Import: 'loggedErrorImport',
  Draft: 'loggedErrorDraft',
  Sidebar: 'loggedErrorSidebar',
  Harness: 'loggedErrorHarness',
  Dbt: 'loggedErrorDbt',
  Other: 'loggedErrorOther',
};

/**
 * The area of each source an error line can start with: a `createLogger`
 * scope, or the `[Tag]` an unscoped `log.error` line (or the feedback error
 * buffer) starts with. Every such literal in `src/` is listed
 * (`test/unit/loggedErrorAreas.test.ts`); one not listed is `Other`. Only
 * the area's fixed code is ever recorded.
 */
export const LOGGED_ERROR_AREAS: Readonly<Record<string, LoggedErrorArea>> = {
  // createLogger scopes
  Canvas: 'Canvas',
  'Convert to DBML': 'Other',
  dbml: 'Other',
  Draft: 'Draft',
  DraftPreviewPanel: 'Draft',
  Relationships: 'Sidebar',
  'Subject Areas': 'Sidebar',
  'Table Library': 'Sidebar',
  // Tags of unscoped log lines
  'ERD Studio': 'Other',
  SemanticEditorProvider: 'Canvas',
  saveDocument: 'Canvas',
  saveDocumentByUri: 'Canvas',
  RefreshGate: 'Canvas',
  ConvertToDbmlPanel: 'Other',
  DomainTreeProvider: 'Sidebar',
  FileWatcherService: 'Other',
  GettingStarted: 'Other',
  LayerService: 'Other',
  LogicalModelService: 'Other',
  ManifestService: 'Dbt',
  MigrationService: 'Other',
  migrateNaming: 'Other',
  moveRelationshipsToLibrary: 'Other',
  SelectorsService: 'Dbt',
  CliLauncher: 'Harness',
};

/** `loggedError` and the area of `source` (unknown or empty: `Other`). */
export function loggedErrorCodes(source: string): TelemetryErrorCode[] {
  const area = Object.prototype.hasOwnProperty.call(LOGGED_ERROR_AREAS, source) ? LOGGED_ERROR_AREAS[source] : 'Other';
  return ['loggedError', LOGGED_ERROR_CODES[area]];
}
