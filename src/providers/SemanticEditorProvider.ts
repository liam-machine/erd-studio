/**
 * SemanticEditorProvider — CustomTextEditorProvider for semantic domain JSON files.
 *
 * Opens domain files (`{semanticDir}/{layer}/{domain}.json`, v5 central model
 * store) in a React webview instead of the default JSON editor. Model bodies
 * live in `{semanticDir}/logical-models/{name}.yml` and are resolved through
 * TableLibraryService; the domain file holds model names, relationships and
 * the shared viewConfig (positions, annotations).
 *
 * Message protocol (src/types/messages.ts — every type there has a live
 * sender and a `case` below; unknown types are logged, never dropped):
 *   Webview → Extension:  ready, switchStage, refreshManifest, undo/redo,
 *                         schema mutations (addModel … removeRelationships),
 *                         canvas metadata (updatePositions, *Annotation*),
 *                         sync flow (toggleDiscrepancy, generateSyncPlan,
 *                         runDbtCompile, runDbtParse, launchClaudeSync),
 *                         feedback (requestFeedbackContext, analyzeFeedback,
 *                         submitFeedback, copyFeedbackReport,
 *                         openFeedbackLink),
 *                         viewFile, requestReload,
 *                         dismissManifestHint, openGettingStarted, showLogs,
 *                         exportDiagram, closeEditor, openAnotherDomain,
 *                         requestExistingTables
 *   Extension → Webview:  loading (first answer to ready), domainLoaded,
 *                         existingTables, stageData (echoes switchStage
 *                         requestId), discrepancyReport, manifestStaleness,
 *                         syncPlanGenerated, openFeedback, feedbackContext,
 *                         feedbackAnalysis, feedbackSubmitted, error
 *
 * Writes and save semantics:
 *   Every domain-file write goes through `applySubjectAreaEdit` — the ONLY place a
 *   domain WorkspaceEdit is built (parse → mutate → replace → applyEdit →
 *   document.save() → refresh). logical-models/*.yml changes ride in the same
 *   WorkspaceEdit (`applyTableEdit` / `addTableFileEdits`) so a model edit and
 *   its domain change are atomic and one undo step. Edits are saved
 *   immediately after applying — the custom editor never sits dirty. Multi-
 *   select messages (removeModels, removeRelationships, removeAnnotations,
 *   updatePositions with annotations) are one edit, one save, one domainLoaded.
 *
 * Guards:
 *   - Payloads are validated at the boundary (providers/payloadValidation.ts)
 *     before anything reaches disk.
 *   - While a panel shows the physical stage only NON_MUTATION_TYPES (see
 *     resolveCustomTextEditor) are accepted — positions, annotations, the
 *     sync-plan flow and every feedback message are allowed (the first two
 *     write only to the shared viewConfig, feedback writes nothing at all);
 *     schema mutations and undo/redo are answered with
 *     PHYSICAL_READ_ONLY_MESSAGE.
 *   - `withMessageErrorBoundary` turns a throwing/rejecting handler into an
 *     `error` message instead of an unhandled rejection.
 *   - Refresh paths (watchers, external edits, stage switches) never write;
 *     only the initial `ready` load persists auto-computed positions.
 *
 * Update loop prevention:
 *   `pendingUpdates` is held for the whole applySubjectAreaEdit / undo / redo so the
 *   onDidChangeTextDocument listener does not save and re-send on its own.
 *   External edits (guard not held) are saved if dirty and re-sent. VS Code's
 *   own undo/redo (Cmd+Z on the canvas) is flushed exactly as the toolbar's is.
 */

import * as crypto from 'crypto';
import { getErdStudioSetting } from '../services/configService';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  SubjectAreaFileError,
  SubjectAreaService,
  isSubjectAreaFilePath,
  notADiagramMessage,
  subjectAreaTableNames,
} from '../services/domainService';
import { computeSubjectAreaDiff } from '../services/stageDiff';
import { buildSyncPlan, countSyncPlanActions, syncPlanLibraryLookups } from '../services/syncPlanBuilder';
import { findVenvDir } from '../services/dbtEnv';
import { claudeTerminalLaunch } from './GettingStartedPanel';
import { runDbtParse } from '../commands/runDbtParse';
import { runDbtCompile } from '../commands/runDbtCompile';
import { NO_DBT_MODELS_MESSAGE } from '../commands/drawFromDbt';
import { IMPORT_DBML_COMMAND } from '../commands/importDbml';
import { EXPORT_DIAGRAM_COMMAND } from '../commands/exportDiagram';
import { SEND_FEEDBACK_BUTTON, crashFeedbackPrefill, noReadyFeedbackPrefill, describeDbmlMistake, describeDiagramFileProblem, describeJsonMistake, feedbackPrefill, oursMessage, projectRelative, reportNotOpenedMessage, showErrorWithActions, type FeedbackPrefill } from '../services/commandErrors';
import { isCrashFallbackAction, type CrashFallbackAction } from '../types/webviewError';
import { askNoReadyRecovery } from './noReadyRecovery';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import { SelectorsService } from '../services/selectorsService';
import { computeNewTablePositions, findOpenPosition } from '../services/positionService';
import {
  ERD_LAYOUT_NOTE_PREFIX,
  FIELDS_FILE_NAME,
  classifySemanticFile,
  computeMissingPositions,
  diagramPathOf,
  isErdLayoutName,
  subjectAreaStorageOf,
  SubjectAreaValidationError,
  EMPTY_DBT_KEY_INDEX,
  backwardsRelationshipNote,
  foreignKeyEnd,
  linkKey,
  normaliseSubjectAreaDocument,
  sameLink,
  tableLoadErrorOf,
  builtInField,
  setMetaEntry,
  toDisplaySubjectArea,
} from '@erd-studio/core';
import type { DbtKeyIndex, FieldList, MetaValue } from '@erd-studio/core';
import { FieldsService } from '../services/fieldsService';
import { CUSTOMISE_FIELDS_COMMAND } from '../commands/customiseFields';
import { dbtKeyIndexOf, withDbtKeyHints } from '../services/stageDisplay';
import { rewriteJsonScalars } from '../services/minimalEdits';
import { checkManifestStaleness } from '../services/stalenessService';
import { saveAllAndReload } from '../services/recoveryService';
import {
  GITHUB_REPO,
  buildFeedbackContext,
  copyFeedbackReport,
  hostErrorLog,
  submitFeedback,
} from '../services/feedbackService';
import {
  analysisNeedsPriming,
  analysisProviderChoice,
  analysisProviderLabel,
  analyzeFeedback,
  listAnalysisOptions,
  resolveAnalysisTier,
  setAnalysisProviderChoice,
  describeProviderWriteFailure,
} from '../services/feedbackAnalysisService';
import type { ReportTrackingService } from '../services/reportTrackingService';
import type { CatalogService } from '../services/catalogService';
import type { CatalogData } from '../types/catalog';
import { OwnWriteTracker, ownWrites } from '../services/ownWriteTracker';
import { ADD_FROM_DBT_NEEDS_DBT_MESSAGE, findOwningDbtProject, hasDbtProjectFile, samePath } from '../services/projectDiscovery';
import type {
  AddModelMessage,
  AddRelationshipMessage,
  AnalyzeFeedbackMessage,
  CopyFeedbackReportMessage,
  EditRelationshipMessage,
  ErrorMessage,
  NewRelationshipFileChoice,
  OpenFeedbackLinkMessage,
  OpenModelFileMessage,
  ViewFileMessage,
  SetFeedbackProviderMessage,
  SetLineStyleMessage,
  OpenFeedbackMessage,
  RelationshipKey,
  RequestFeedbackContextMessage,
  SubmitFeedbackMessage,
} from '../types/messages';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplaySubjectArea, DisplayRelationship } from '../types/display';
import type { Rationale, Cardinality, ColumnDef, DesignTable, Meta, Stage } from '../types/semantic';
import type { DropTablesMessage, LibraryDragStartedMessage, RevealRelationshipMessage, RevealTableMessage, UpdateColumnPayloadColumn, UpdateMetaMessage } from '../types/messages';
import { GO_TO_TABLE_COMMAND, REVEAL_IN_TABLE_LIBRARY_COMMAND, projectRelativePath } from '../commands/goToTable';
import { MOVE_TABLE_COMMAND } from '../commands/moveDbml';
import type { GroundTruth } from '../types/syncPlan';
import type { NodePosition, Relationship, SemanticTable, TableRelationship, UnifiedSubjectArea } from '../types/semantic';
import { describeUnsupportedSubjectAreaFormat, detectSubjectAreaFormat } from '../types/semantic';
import { telemetry } from '../services/telemetryService';
import { handlerFailureKeys, handlerGroupOf, type HandlerGroup } from '../services/runtimeTelemetry';
import { markRecorded, wasRecorded } from '../services/telemetryOnce';
import {
  canvasLayoutTelemetry,
  dbmlDiagramFeatures,
  isUserFileProblem,
  loaderWarningFeatures,
  slowCanvasLoad,
  subjectAreaLoadDetailCode,
  webviewErrorCodes,
} from '../services/telemetryCanvas';
import { ReadyWatch } from '../services/readyWatch';
import { saveDocument, saveDocumentByUri, saveWithoutFormatting } from './documentSave';
import { dirtyFiles } from './dirtyDocuments';
import { subjectAreaLoadErrorCode, subjectAreaLoadStepCode, layoutFeature, saveFailureCodes, type SaveFailure, type SubjectAreaLoadFailure, type SubjectAreaLoadStep, type TelemetryFeature } from '../services/telemetryPayload';
import { openTableFileAt } from '../commands/openModelFile';
import { redactPaths } from '../types/feedback';
import {
  buildDbtDraft,
  dbtTestsOf,
  dbtTestsOnTables,
  listDraftModels,
  listDraftScopes,
  markDraftKeys,
  relationshipsForAddedTables,
  seedTableFromDbt,
  seededColumnCount,
  configuredSchemaOf,
  type DbtMatchTable,
  type DraftSkipped,
} from '../services/dbtDraft';
import { pickDraftScope } from './dbtDraftPicker';
import { readSubjectAreaRelationships } from '../commands/moveRelationshipsToLibrary';
import {
  diagramsStillDrawing,
  drawnDiagramCopies,
  markPrimaryKey,
  planRelationshipWrite,
  planRelationshipWrites,
  removeColumnFromSubjectAreaRelationships,
  removeColumnRelationships,
  renameColumnInSubjectAreaRelationships,
  renameColumnInRelationships,
  relinkSticky,
  renameTableInSubjectArea,
  renameTableInSubjectAreaRelationships,
  renameTableInRelationships,
  describeUnstoredRelationships,
  routeToLibrary,
  sharedRelationshipCount,
  usesLibraryRelationships,
} from '../services/libraryRelationships';
import type { RelationshipWriteInput, RelationshipWriteOp } from '../services/libraryRelationships';
import { auditRelationshipWrite, surveyLibrary } from '../services/relationshipHealth';
import { namingMigrationIsEmpty } from '../services/namingMigration';
import type { DbmlConversionCandidates } from '../services/dbmlConversionFiles';
import { convertOfferApplies } from '../services/convertOffer';
import type { NamingMigrationPlan } from '../services/namingMigration';
import type { ProjectNaming } from '@erd-studio/core';
import type { RelationshipAudit } from '../services/relationshipHealth';
import { DbmlTableWriteRefused, DuplicateKeyWriteRefused, RelationshipsRewriteRefused, TableNamingWriteRefused } from '../services/logicalModelService';
import { runSuggestRelationships, vscodeSuggestRelationshipsUi, type SuggestOutcome, type SuggestRelationshipsUi, type SuggestionRead } from './suggestRelationshipsFlow';
import {
  DONT_ASK_AGAIN_BUTTON, NOT_NOW_BUTTON, NO_CANVAS_MESSAGE, REVIEW_SUGGESTIONS_BUTTON, computeSuggestions, importOfferMessage, notAddedMessage,
  offerAfterImport, offerCount, unreadableDiagramMessage,
} from '../services/relationshipSuggestionReview';
import { tableHomesOf } from '../services/tableHomes';
import { buildCanvasContext } from '../services/canvasContext';
import { collectFilesNotShown } from '../services/filesNotShown';
import type { FileNote } from '../types/filesNotShown';
import type { RefreshKind } from '../services/runtimeTelemetry';
import type { CodeOwnersReader } from '../services/codeOwners';
import { newTableSchemaChoice } from '../services/newTableSchema';
import { DBML_CONVERT_FIRST_MESSAGE, DbmlEditRefused } from '@erd-studio/core/dbml';
import type { FileWrite } from '../services/fileWrites';
import type { DbmlLibraryWritePlan } from '../services/dbmlLibraryWrites';
import { applyFileWrites, writtenPaths } from './applyFileWrites';
import { primeLayoutOnlyReading, readDbmlDiagram } from '../services/dbmlDiagramReadings';
import { changedMemberPath, dbmlResolverOf, diagramResolverOf, problemOf, settleDbmlDiagramWrites, settleSignalsOf, settlesNothing, unsettledDiagramRefusal } from '../services/dbmlDiagramSettle';
import { diagramSummaryForFile } from '../services/dbmlDiagramSummaries';
import type { DbmlDraftTable, DbmlTableHome, NewRefFileChoice } from '../services/dbmlLibraryWrites';
import type { AppliedFileWrites } from './applyFileWrites';
import {
  NotASubjectAreaObject,
  codecFor,
  isLayoutOnlyChange,
  isTableNamingDocument,
  layoutOnlyText,
  markTableNamingDocument,
  sameOutsideErdLayout,
  serialiseSubjectArea,
  subjectAreaFileObject,
} from './subjectAreaCodec';
import type { ParsedSubjectArea, SubjectAreaResolver } from './subjectAreaCodec';
import type { TableId } from '../types/tableId';
import type { TableFileEntry } from '../services/logicalModelService';
import { tableIdKey, tableIdOfPath } from '../types/tableId';
import { tableIdOfEntry } from '../services/tableLibraryIndex';
import { renameMemberRefs, type DiagramMemberTable } from '../services/diagramMemberTable';
import { readDbtProjectConfig } from '../services/dbtProjectConfig';
import { withRelationshipHomes } from '../services/diagramRelationshipHomes';
import { normaliseName } from '../services/nameUtils';
import { yieldToEventLoop } from '../services/libraryWarmUp';
import { createLogger, elapsedMs, log, phaseTimer, plural } from '../services/logger';
import { SHOW_LOGS_BUTTON, SHOW_LOGS_COMMAND } from '../services/showLogs';
import type { SessionPromptKind } from '../services/activationPrompts';
import { parseGuideAction, type CanvasGuideStart, type GuideActionPayload } from '../types/onboardingGuide';

/** The canvas's lines in the ERD Studio log: opening a diagram, position saves. */
const canvasLog = createLogger('Canvas');

/**
 * Backoff between re-reads of a domain file that read as empty or truncated.
 * Four attempts across ~1.2s — comfortably longer than the gap between the
 * create and the write of a file being replaced, and short enough that a file
 * which really is broken still says so while the user is still looking.
 */
const SUBJECT_AREA_READ_RETRY_DELAYS_MS = [150, 350, 700];

/**
 * A domain read worth retrying: core's transient failures (an empty or
 * truncated file — something is writing it right now) plus a file that exists
 * but cannot be read. On Windows a read that overlaps another process's write
 * (an AI assistant, git, dbt, a virus scanner, OneDrive) fails with a sharing
 * violation — EBUSY / EPERM / EACCES — that clears in milliseconds; failing
 * the canvas on the first one leaves an error over a file that is fine. A
 * genuinely unreadable file costs the same ~1.2 s of retries, then reports.
 */
function isRetryableSubjectAreaRead(err: unknown): err is SubjectAreaFileError {
  return err instanceof SubjectAreaFileError && (err.transient || err.reason === 'unreadable');
}

/** The fixed telemetry reason for a canvas load failure — never its message. */
export function classifySubjectAreaLoadFailure(err: unknown): SubjectAreaLoadFailure {
  if (err instanceof SubjectAreaFileError) {
    if (err.reason === 'missing') return 'missing';
    if (err.reason === 'unreadable') return 'unreadable';
    if (err.reason === 'empty') return 'empty';
    if (err.mergeConflict) return 'conflict';
    if (err.reason === 'invalid-dbml') return 'dbml';
    return 'json';
  }
  if (err instanceof SubjectAreaValidationError) return 'invalid';
  return 'internal';
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * At most this many Table Library files are read to list the Add Existing
 * Table rows with a payload. With more unread (a large library opened before
 * the background read reached it) none is read: their rows go out with
 * `detailsPending`, and the dialog asks for them when it opens.
 */
export const EXISTING_TABLES_READ_AT_MOST = 100;

/**
 * How long after a canvas opens its relationship survey (usage telemetry,
 * #133) runs: off the open's critical path, once the payload has gone out.
 */
export const RELATIONSHIP_SURVEY_DELAY_MS = 3000;

/**
 * The logical-models/ sub-folder new models created from a domain go in: the
 * domain file's layer directory (`{semanticDir}/{layer}/{domain}.json`, or a
 * DBML diagram's `{layer}/diagrams/{domain}.dbml`).
 * `TableLibraryService` ignores a name that is not layer-shaped, so a domain
 * opened from anywhere else simply creates its models at the top level.
 */
export function tableFolderForSubjectArea(domainFilePath: string): string {
  return diagramPathOf(domainFilePath)?.layer ?? path.basename(path.dirname(domainFilePath));
}

/** `rel` with its two ends renamed by `rename` (a diagram's names for its tables ↔ the library's); the same object when neither changes. */
function relationshipEndsRenamed<T extends { fromModel: string; toModel: string }>(rel: T, rename: (name: string) => string): T {
  const fromModel = rename(rel.fromModel);
  const toModel = rename(rel.toModel);
  return fromModel === rel.fromModel && toModel === rel.toModel ? rel : { ...rel, fromModel, toModel };
}

/** A relationship edit with every table it names renamed by `rename` (its ends, and the table whose key it marks). */
function relationshipOpRenamed(op: RelationshipWriteOp, rename: (name: string) => string): RelationshipWriteOp {
  const markKey = 'markKey' in op && op.markKey ? { markKey: { ...op.markKey, model: rename(op.markKey.model) } } : {};
  switch (op.kind) {
    case 'add': return { ...op, drawn: relationshipEndsRenamed(op.drawn, rename), ...markKey };
    case 'edit': return { ...op, original: relationshipEndsRenamed(op.original, rename), drawn: relationshipEndsRenamed(op.drawn, rename), ...markKey };
    case 'update': return { ...op, ends: relationshipEndsRenamed(op.ends, rename) };
    case 'remove': return { ...op, keys: op.keys.map((k) => relationshipEndsRenamed(k, rename)) };
  }
}

/** The last sentence of every "not a DBML diagram" page (§1.8): how to see the file as text. */
export const REOPEN_AS_TEXT_SENTENCE = 'To edit it as text, right-click the tab and choose Reopen Editor With… > Text Editor.';

/**
 * logical-models/*.yml operations to bundle into a domain WorkspaceEdit so the
 * model file and the domain file change (and undo) together.
 */
interface TableFileOps {
  /** Models whose yml should be written in full (created if missing). */
  save?: TableFileSave[];
  /** Model names whose yml should be deleted (e.g. the old name on rename); a DBML table may be named by its identity. */
  delete?: Array<string | TableId>;
  /**
   * DBML only: the relationships file the New Relationship dialog picked for
   * the relationship being added (`TableLibraryService.planTableWrites` →
   * `planDbmlLibraryWrites`' `newRefFile`). A YAML write never reads it.
   */
  newRefFile?: NewRefFileChoice;
}

/** The open canvas a table file delete anchors on (see deleteTablesWithCascade, #274). */
interface DeleteOrigin {
  document: vscode.TextDocument;
  /** `document.uri.toString()`: the canvas's edit queue and undo bookkeeping. */
  panelKey: string;
}

/** A single yml write inside a {@link TableFileOps}. */
interface TableFileSave {
  /** The model as it should end up in logical-models/{model.name}.yml. */
  model: import('../types/semantic').SemanticTable;
  /**
   * Name of the model file whose existing YAML document supplies comments,
   * key order and unknown keys. Defaults to `model.name`; a rename passes the
   * OLD name so the hand-written content of the old file is carried across to
   * the new path instead of being regenerated from scratch.
   */
  fromName?: string;
  /** A new DBML table (D-4): never an edit of a table of its name in another schema folder. A YAML write ignores it. */
  create?: boolean;
  /** DBML only: the existing table this save edits or renames, by identity (D-4). A YAML write ignores it. */
  from?: TableId;
}

/**
 * A table a canvas message names, resolved at the diagram boundary
 * ({@link SemanticEditorProvider.canvasTable}): `ref` is what the diagram
 * calls it, `name` its bare name, `library` what the library's relationship
 * lookups call it (its name, or `<schema>.<name>` where two schema folders
 * share it), and `id` / `filePath` the table file its `use` line reads,
 * where the library tells tables apart by identity.
 */
interface CanvasTable {
  ref: string;
  name: string;
  library: string;
  id?: TableId;
  filePath?: string;
}

/** Why a chosen dbt model was left out of a batch add, in words. */
const DRAFT_SKIP_WORDS: Partial<Record<DraftSkipped['reason'], string>> = {
  'invalid-name': 'name cannot be used as a file name',
  'not-found': 'not found in dbt',
  disabled: 'disabled in dbt',
  'over-limit': 'over the limit for one add',
};

/**
 * {@link DRAFT_SKIP_WORDS} in a folder without dbt (logical only), where a
 * pick from the Table Library that has no table file is simply not there.
 */
const LOGICAL_DRAFT_SKIP_WORDS: Partial<Record<DraftSkipped['reason'], string>> = {
  ...DRAFT_SKIP_WORDS,
  'not-found': 'not in the Table Library',
};

/**
 * One sentence naming the chosen models a batch "Add models from dbt" (or
 * a batch pick from the Table Library) left out, or `''` when nothing worth
 * mentioning was. Duplicates and models already in the domain are the
 * expected case and are not listed. `logicalOnly` (no dbt project): the
 * reasons are worded without dbt.
 */
export function describeSkippedDbtModels(skipped: readonly DraftSkipped[], options: { logicalOnly?: boolean } = {}): string {
  const words = options.logicalOnly ? LOGICAL_DRAFT_SKIP_WORDS : DRAFT_SKIP_WORDS;
  const parts = skipped
    .filter((s) => words[s.reason])
    .map((s) => `${s.name} (${words[s.reason]})`);
  if (parts.length === 0) return '';
  const shown = parts.slice(0, 5).join(', ');
  return `Left out: ${shown}${parts.length > 5 ? ` and ${parts.length - 5} more` : ''}.`;
}

/**
 * True when the domain has at least one model and NONE of them has a stored
 * `viewConfig.positions` entry (missing or empty `positions` included) — the
 * case where the webview should run the ELK auto layout on first open rather
 * than the host persisting its simple placement. A domain with any stored
 * position is not fresh: the missing ones keep today's host placement.
 */
export function isFreshLayout(
  unifiedDomain: { logical: { models: Array<{ name: string }> }; viewConfig: { positions?: Record<string, NodePosition> } },
): boolean {
  const models = unifiedDomain.logical.models;
  if (models.length === 0) return false;
  const positions = unifiedDomain.viewConfig.positions ?? {};
  return models.every((m) => !positions[m.name]);
}

/**
 * Drop every trace of removed models from the domain's shared `viewConfig`:
 * their persisted node positions and any annotation still linked to them (a
 * dangling `linkedModel` renders a dashed edge to a node that no longer
 * exists). Mutates `parsed` in place.
 *
 * Shared by the V5 and V4 arms of `handleRemoveModels` so the cleanup cannot
 * drift between them. A domain with no `viewConfig` is left without one rather
 * than gaining an empty stub.
 */
function pruneViewConfigForRemovedTables(
  parsed: Record<string, unknown>,
  removed: ReadonlySet<string>,
  /** Match names without case: DBML diagrams only (a position key or `linked_table` may spell a member another way, §1.6); JSON stays exact. */
  caseInsensitive = false,
): void {
  const viewConfig = parsed.viewConfig;
  if (!viewConfig || typeof viewConfig !== 'object' || Array.isArray(viewConfig)) return;
  const vc = viewConfig as Record<string, unknown>;
  const lowered = new Set([...removed].map((n) => n.toLowerCase()));
  const isRemoved = (name: string): boolean => (caseInsensitive ? lowered.has(name.toLowerCase()) : removed.has(name));

  const positions = vc.positions;
  if (positions && typeof positions === 'object' && !Array.isArray(positions)) {
    if (caseInsensitive) {
      for (const key of Object.keys(positions)) if (isRemoved(key)) delete (positions as Record<string, unknown>)[key];
    } else {
      for (const name of removed) delete (positions as Record<string, unknown>)[name];
    }
  }

  const annotations = vc.annotations;
  if (Array.isArray(annotations)) {
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== 'object') continue;
      const ann = annotation as Record<string, unknown>;
      if (typeof ann.linkedModel === 'string' && isRemoved(ann.linkedModel)) {
        delete ann.linkedModel;
      }
    }
  }
}

/**
 * The model name to suggest when a new model's name is taken but the user
 * wants a table of that name in this domain's layer: `{layer}_{name}`, the
 * dbt convention, with the alias carrying the table name.
 */
function sameTableName(name: string, domainPath: string): string {
  const layer = tableFolderForSubjectArea(domainPath).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return layer ? `${layer}_${name}` : `${name}_2`;
}

/**
 * Thrown by an `applySubjectAreaEdit` mutator to abort without an edit. The mutator
 * has already reported the reason to the webview (or decided the request is a
 * silent no-op), so `applySubjectAreaEdit` swallows it and returns `false`.
 */
class EditAborted extends Error {
  constructor() {
    super('edit aborted');
    this.name = 'EditAborted';
  }
}

/**
 * A refusal the user is told about in plain words — a file open with unsaved
 * edits, a relationship edit the planner turns down. Not a failure: usage
 * telemetry counts only the throws that are not one of these.
 */
class EditRefused extends Error {
  constructor(
    message: string,
    /** Made from a DBML writer's overlap refusal (`DbmlEditRefused.reason`): a writer bug, counted as ours. */
    readonly overlap = false,
  ) {
    super(message);
    this.name = 'EditRefused';
  }
}

/** What an edit VS Code did not apply says when the caller gives no label of its own (§5.3 step 7). */
const EDIT_NOT_APPLIED_MESSAGE = 'The edit could not be applied; nothing was changed.';

/** A refusal the user was told about in plain words, which usage telemetry does not count as a failure. */
function isExplainedRefusal(err: unknown): boolean {
  return err instanceof EditRefused || err instanceof RelationshipsRewriteRefused || err instanceof DuplicateKeyWriteRefused
    || err instanceof TableNamingWriteRefused || err instanceof DbmlTableWriteRefused || err instanceof DbmlEditRefused;
}

/**
 * A DBML writer refused its own overlapping edits (core's `refuseOverlaps`):
 * the user is told as for any refusal, but usage telemetry counts it as ours
 * (`dbmlWriteOverlap`, B12).
 */
function isDbmlWriteOverlap(err: unknown): boolean {
  return (err instanceof DbmlEditRefused && err.reason === 'overlap') || (err instanceof EditRefused && err.overlap);
}

/**
 * Usage telemetry for a canvas handler that failed (B12), once per error
 * (`telemetryOnce`): the boundary and a handler's own catch may both see it.
 * Fixed keys from the message type's group; never the error's text.
 */
function recordHandlerFailure(group: HandlerGroup, err: unknown): void {
  if (wasRecorded(err)) return;
  markRecorded(err);
  const keys = handlerFailureKeys(group, {
    explained: isExplainedRefusal(err),
    overlap: isDbmlWriteOverlap(err),
    userFile: isUserFileProblem(err),
  });
  for (const code of keys.errors) telemetry.error(code);
  for (const feature of keys.features) telemetry.feature(feature);
}

/**
 * Log a canvas handler failure at the level its telemetry counts it: a
 * refusal the user was told about in plain words, or a diagram file the
 * user or an assistant broke, is a warning, so the B19 catch-all
 * (`loggedError*`) does not count it as ours either. Everything else,
 * including a DBML writer overlap, stays an error.
 */
function logHandlerFailure(line: string, err: unknown): void {
  const theirs = !isDbmlWriteOverlap(err) && (isExplainedRefusal(err) || isUserFileProblem(err));
  if (theirs) log.warn(line);
  else log.error(line);
}

import {
  isValidCardinality,
  isValidRelationshipRole,
  isValidKeyType,
  isValidTableRole,
  isValidStage,
  validateColumnDef as validateColumnDefPayload,
  validateColumnDefs,
  validateSchemaFolderPayload,
  validateRequestNewRelationshipFilesPayload,
  validateTableName,
  validateModelAliasPayload,
  validateMetaPayload,
  validateOpenFieldsFilePayload,
  validateRationalePayload,
  validateAnnotationPositions,
  validateAddModelsFromDbtPayload,
  validateAddExistingModelsPayload,
  validateDropTablesPayload,
  validateOpenModelFilePayload,
  validateGoToTablePayload,
  validateTableActionPayload,
  validateLayoutFinishedPayload,
  validateWebviewErrorPayload,
  validateCrashFallbackPayload,
  validateViewFilePayload,
  validateExtraPairs,
  validateMarkKey,
  validateAddExistingModelPayload,
  validateNoRelationshipsFile,
  validateRelationshipEnds,
  validateRelationshipsFileChoice,
  validateDismissManifestHintPayload,
  validateImportEmbeddedTablesPayload,
  validateOpenNotedFilePayload,
  validateAddRelationshipsImportsPayload,
  validateReloadFromDiskPayload,
  validateExportDiagramPayload,
  validateGuidePayload,
  validateAnnotationUpdate,
  validateTableNameSafety,
  validateNewDbmlTableName,
  validatePoint,
  validatePositions,
  validateAnalyzeFeedbackPayload,
  validateCopyFeedbackReportPayload,
  validateOpenFeedbackLinkPayload,
  validateRequestFeedbackContextPayload,
  validateSetFeedbackProviderPayload,
  validateSetLineStylePayload,
  validateSubmitFeedbackPayload,
  type AnnotationPositionPayload,
} from './payloadValidation';
import { sameName } from '../types/naming';
import { affectsLineStyle, readLineStyle, writeLineStyle } from './lineStyleSetting';
import { dropGridPositions, tableFilesOfDroppedUris, tablesOfDroppedUris } from '../services/tableDrop';

/** A parsed domain file's `logical.relationships`, as a list the rename helpers can rewrite in place. */
function stageRelationships(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const logical = parsed.logical as Record<string, unknown> | undefined;
  return logical && Array.isArray(logical.relationships) ? logical.relationships as Array<Record<string, unknown>> : [];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * workspaceState key: the user closed the logical stage's "Run dbt parse" hint
 * (#113). Per workspace, so another project with no manifest still gets it.
 */
export const MANIFEST_HINT_DISMISSED_KEY = 'erdStudio.manifestHintDismissed';

/**
 * workspaceState key: "Don't Ask Again" on the offer to move a project's
 * relationships into the model library (#126). Per workspace.
 */
export const RELATIONSHIP_MOVE_DECLINED_KEY = 'erdStudio.relationshipMoveDeclined';

/**
 * workspaceState key: "Don't Ask Again" on the offer to turn round
 * relationships drawn backwards (#163). Per workspace; the ⚠ stays.
 */
export const RELATIONSHIP_BACKWARDS_DECLINED_KEY = 'erdStudio.relationshipBackwardsDeclined';

/**
 * workspaceState key: "Don't Ask Again" on the offer to move the project to
 * the new file naming (#182). Per workspace, like #126's and #163's.
 */
export const NAMING_MIGRATION_DECLINED_KEY = 'erdStudio.namingMigrationDeclined';

/**
 * workspaceState key: "Don't Ask Again" on the offer to convert the project
 * to DBML (native DBML storage, §6.4). Per workspace.
 */
export const DBML_CONVERSION_DECLINED_KEY = 'erdStudio.dbmlConversionDeclined';

/**
 * workspaceState key: "Don't Ask Again" on the offer to review suggested
 * relationships after an import. Per workspace, like the offers above; the
 * command stays.
 */
export const RELATIONSHIP_SUGGESTIONS_DECLINED_KEY = 'erdStudio.relationshipSuggestionsDeclined';

/** How long outside changes to table files are collected into one canvas refresh. */
export const TABLE_REFRESH_BATCH_MS = 150;

/** How long a relationship reveal waits for its canvas to load (a large diagram can take a few seconds). */
export const PENDING_REVEAL_MS = 60_000;

/** How long a Table Library drag is remembered for a drop that brings no table file. */
export const PENDING_LIBRARY_DRAG_MS = 60_000;

/** The answer to a drop on the canvas that names no table. */
export const DROP_TABLES_NOTHING_MESSAGE =
  'ERD Studio: Hold Shift and drop a table from the Table Library, or a table file from the Explorer, onto the diagram.';

/** The answer to a drop of tables that are all on the diagram already (they are selected instead). */
export function alreadyOnDiagramMessage(tables: readonly string[]): string {
  return tables.length === 1
    ? `ERD Studio: "${tables[0]}" is already on this diagram.`
    : `ERD Studio: These ${tables.length} tables are already on this diagram.`;
}

/** How long the status bar says where a new relationship was saved. */
export const RELATIONSHIP_SAVED_STATUS_MS = 8000;

/** "ERD Studio: Relationship saved in .erd-studio/gold/relationships/finance.dbml (line 7)". */
export function relationshipSavedMessage(file: string, line: number): string {
  return `ERD Studio: Relationship saved in ${file} (line ${line})`;
}
/** The Convert offer's dialog (§6.4): its title and its two buttons (VS Code adds Cancel, which is Not Now). */
export const DBML_CONVERSION_OFFER_TITLE = 'Convert this project to DBML?';
export const DBML_CONVERSION_OFFER_CONVERT = 'Convert…';
export const DBML_CONVERSION_OFFER_DECLINE = "Don't Ask Again";

/** The setting that turns the Convert offer off everywhere (`erdStudio.dbml.offerConvert`, default on). */
export const DBML_OFFER_CONVERT_SETTING = 'dbml.offerConvert';

/**
 * The Convert offer's explanation (§6.4): converting is optional, and what a
 * converted project needs from everyone who opens it. `files` is how many
 * YAML/JSON files a mixed project still has.
 */
export function dbmlConversionOfferDetail(storage: 'yaml' | 'mixed', files: number): string {
  if (storage === 'mixed') {
    return `Your project keeps working as it is — converting is optional. It is stored as DBML, but ${files} file${files === 1 ? ' is' : 's are'} ` +
      'YAML or JSON (probably written by an AI helper set up with an older ERD Studio, or by a teammate on one). Convert them to DBML? (You\'ll see the full list first.)';
  }
  return 'Your project keeps working as YAML and JSON — converting is optional. ERD Studio can store it as DBML instead, an open format. ' +
    'Afterwards, everyone who opens it needs ERD Studio 2.0 or later. ' +
    "Convert now? (You'll see the full list of changes first.)";
}

/** What the canvas needs to offer Convert Project to DBML (§6.4), wired by the extension. */
interface DbmlConversionHooks {
  /** What there is to convert, from the file listing alone (no plan: that waits until the user asks). */
  candidates: () => DbmlConversionCandidates;
  /** Run the command, with its own modal; true when it converted. */
  run: () => Promise<boolean>;
  /** The last run was refused or left only files to fix, and nothing changed since: offering would lead nowhere. */
  goesNowhere?: () => boolean;
}

/** What the canvas needs to offer the naming migration (#182), wired by the extension. */
interface NamingMigrationHooks {
  /** The migration's plan for the project as it is on disk. */
  plan: () => NamingMigrationPlan;
  /** The project's naming (`projectNamingOf`). */
  naming: () => ProjectNaming;
  /** Run the migration command, with its own dialog; true when it migrated. */
  run: () => Promise<boolean>;
  /** This extension's version, for the teammates sentence. */
  version: string;
}

/** A backwards group as the turn-round offer matches it again after the toast (#163): its links and cardinality. */
function backwardsGroupId(members: readonly Relationship[]): string {
  return `${members[0]?.cardinality}\u0002${members.map(linkKey).sort().join('\u0001')}`;
}

/** **ERD Studio: Reload Diagrams from Disk** (registered in `extension.ts`). */
export const RELOAD_FROM_DISK_COMMAND = 'erdStudio.reloadFromDisk';

/** What changed, in the words of a `refreshFailed` note. */
const REFRESH_KIND_WORDS: Readonly<Record<RefreshKind, string>> = {
  Table: 'a table or relationships file',
  Diagram: 'a diagram file',
  Layers: 'layers.json or fields.yml',
  Manifest: 'the dbt manifest',
  Catalog: 'the dbt catalog',
  DbtYml: 'a dbt file',
};

/** The note for a redraw that failed inside ERD Studio: the picture may be old, and here is how to get a fresh one. */
export function refreshFailedNote(kind: RefreshKind): FileNote {
  return {
    code: 'refreshFailed',
    message: `ERD Studio could not redraw after a change to ${REFRESH_KIND_WORDS[kind]}. This diagram may be out of date. `
      + 'The problem is in ERD Studio, not in your files.',
    action: 'reloadFromDisk',
  };
}

/** Buttons on the canvas's file and project warnings (#205). */
export const OPEN_AS_TEXT_BUTTON = 'Open as Text';
export const SELECT_DBT_PROJECT_BUTTON = 'Select dbt Project…';
export const OPEN_BOTH_FILES_BUTTON = 'Open Both Files';

/** Open the copy that is used and, beside it, the copy that is ignored. */
async function openBothFiles(used: string, ignored: string): Promise<void> {
  await vscode.window.showTextDocument(vscode.Uri.file(used), { preview: false });
  await vscode.window.showTextDocument(vscode.Uri.file(ignored), { preview: false, viewColumn: vscode.ViewColumn.Beside });
}

/**
 * The error when Delete Table File(s) could not delete them (#205).
 * `applyEdit` gives no reason, so the likely ones are named, not claimed,
 * and the edit is all or nothing, so no file was deleted.
 */
export function tableFileDeleteFailedMessage(shownPaths: readonly string[]): string {
  const what = shownPaths.length === 1 ? shownPaths[0] : `${shownPaths.length} table files`;
  return `ERD Studio couldn't delete ${what}, so no table file was deleted. ` +
    `Another program may have ${shownPaths.length === 1 ? 'it' : 'one of them'} open, or the folder may be read-only.`;
}

/** What {@link SemanticEditorProvider.onDidWriteSubjectArea} says about a write. */
export interface SubjectAreaWriteEvent {
  uri: vscode.Uri;
  /** True when a logical-models/*.yml file was created or deleted. */
  modelLibraryChanged: boolean;
  /**
   * True when the write changed only the layout (table positions, sticky-note
   * boxes): nothing either sidebar tree shows, so listeners skip their
   * refreshes. Absent means anything may have changed.
   */
  layoutOnly?: boolean;
}

/** Error posted to the webview when a mutation is attempted while viewing the physical stage. */
export const PHYSICAL_READ_ONLY_MESSAGE = 'Physical stage is read-only. Switch to the Logical stage to make changes.';


/**
 * Usage telemetry: which kind of canvas edit each webview message asks for.
 * Counted once per accepted request (after the physical-stage guard), whether
 * or not the edit then changes anything.
 */
const EDIT_FEATURES: Partial<Record<string, TelemetryFeature>> = {
  addModel: 'editModel',
  addExistingModel: 'editModel',
  addExistingModels: 'editModel',
  addModelsFromDbt: 'editModel',
  renameModel: 'editModel',
  removeModel: 'editModel',
  removeModels: 'editModel',
  addColumn: 'editColumn',
  removeColumn: 'editColumn',
  updateColumn: 'editColumn',
  reorderColumns: 'editColumn',
  toggleColumnKey: 'editKey',
  updateModelDescription: 'editDetails',
  updateModelGrain: 'editDetails',
  updateModelAlias: 'editDetails',
  updateModelRole: 'editDetails',
  updateModelRationale: 'editDetails',
  updateMeta: 'editDetails',
  addRelationship: 'editRelationship',
  updateRelationship: 'editRelationship',
  editRelationship: 'editRelationship',
  removeRelationship: 'editRelationship',
  removeRelationships: 'editRelationship',
  updatePositions: 'editLayout',
  addAnnotation: 'editAnnotation',
  updateAnnotation: 'editAnnotation',
  removeAnnotation: 'editAnnotation',
  removeAnnotations: 'editAnnotation',
  undo: 'editUndo',
  redo: 'editUndo',
};

/** How long VS Code's own undo/redo has to finish rewinding every document of the step. */
const NATIVE_UNDO_SETTLE_MS = 50;

/** How long a burst of saves (Save All) is gathered before the open canvases are settled once. */
const SAVED_RELATIONSHIPS_SETTLE_MS = 100;

/**
 * The brief note after ERD Studio added relationships imports to a diagram
 * by itself, because a relationships file was saved in this window. `files`
 * are paths inside the ERD Studio folder, as the strip names them.
 */
export function importsAddedMessage(files: readonly string[]): string {
  if (files.length <= 1) return `Added ${files[0] ?? 'a relationships file'} to this diagram so its relationships are drawn.`;
  const list = `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`;
  return `Added ${list} to this diagram so their relationships are drawn.`;
}

export class SemanticEditorProvider implements vscode.CustomTextEditorProvider {
  /**
   * Guard flags to prevent re-sending domain data to the webview when
   * an onDidChangeTextDocument event is triggered by our own WorkspaceEdit.
   * Keyed by document URI to support concurrent edits to multiple open domains.
   */
  private readonly pendingUpdates = new Map<string, boolean>();
  /**
   * Panels a {@link holdRefreshes} hold marked in `pendingUpdates` (not for an
   * edit of their own), and those of them a native undo/redo reached while
   * held: that Cmd+Z is the user's, and is flushed when the hold releases.
   */
  private readonly heldPanels = new Set<string>();
  private readonly undoWhileHeld = new Set<string>();
  /** Panels whose toolbar Undo / Redo command is rewinding the documents (it flushes them itself). */
  private readonly toolbarUndoRedo = new Set<string>();
  /** The move-to-library offer is made at most once per session (#126). */
  private relationshipMoveOffered = false;
  /** The naming migration's offer (#182): at most once per session, before the relationship offers. */
  private namingMigrationOffered = false;
  private dbmlConversionOffered = false;
  /** The DBML offer was eligible this session: the naming offer is then never made (§6.4). */
  private dbmlConversionEligible = false;
  private dbmlConversion: DbmlConversionHooks | undefined;
  private namingMigration: NamingMigrationHooks | undefined;
  /**
   * The window session's one prompt (src/services/activationPrompts.ts): the
   * Convert and naming offers claim it, and wait for the next window when an
   * activation prompt already showed. Unset (tests): never gated.
   */
  private sessionPrompts: { claim(kind: SessionPromptKind): boolean } | undefined;
  private relationshipBackwardsOffered = false;
  /** Each document's logical relationships flagged `keysContradict` when its canvas last loaded (#163). */
  private readonly backwardsDrawn = new Map<string, DisplayRelationship[]>();

  /**
   * The last load failure posted to each panel, so an error the user is
   * already looking at is not re-posted by every refresh that re-reads the
   * same broken file. Cleared whenever a payload gets through.
   */
  private readonly lastLoadError = new Map<string, string>();

  /**
   * logical-models/*.yml file paths this provider wrote through a
   * WorkspaceEdit, keyed by domain document URI. An undo/redo flushes ONLY
   * these documents — a model file the user is hand-editing in another tab is
   * never force-saved on their behalf.
   */
  private readonly editedTablePaths = new Map<string, Set<string>>();
  /**
   * Table files a canvas's own Delete Table File deleted, keyed like
   * `editedTablePaths`: Cmd+Z there brings them back with no text event, so
   * a rewind that left the diagram's text as it was still redraws (#274).
   */
  private readonly deletedTablePaths = new Map<string, Set<string>>();

  /** Tables changed outside ERD Studio, waiting for one batched canvas refresh (see queueTableRefresh). */
  private readonly queuedTableRefresh = new Set<string>();
  private tableRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Per webview: the log lines its Send Feedback dialog last previewed (the only ones a report may carry). */
  private readonly feedbackLogShown = new WeakMap<vscode.Webview, string[]>();

  /** Per panel: the pending flush after VS Code's own undo/redo (see scheduleNativeUndoFlush). */
  private readonly nativeUndoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The background read of the table library (extension.ts), told about foreground work so it steps aside. */
  private libraryWarmUp: { noteForegroundWork(): void } | undefined;
  /** Delay before a canvas open's relationship survey; tests set 0. */
  relationshipSurveyDelayMs = RELATIONSHIP_SURVEY_DELAY_MS;

  /** `{layer}/{domain}\0{ignored file}` pairs already warned about this session. */
  private readonly duplicateWarningsShown = new Set<string>();
  /** Open holds from {@link holdRefreshes}; while above 0, outside refreshes and the duplicate warning wait. */
  private refreshHolds = 0;
  /** Canvas refreshes asked for while held, and so not made: a hold's release says whether any were. */
  private droppedRefreshes = 0;

  /**
   * Fires after this provider has written a domain file (and any model files)
   * to disk. Those writes are recorded as own writes, so the file watchers
   * deliberately ignore them — extension.ts listens here instead to refresh
   * the domain tree, the model library view and the context keys.
   */
  private readonly _onDidWriteSubjectArea = new vscode.EventEmitter<SubjectAreaWriteEvent>();

  /** @see _onDidWriteSubjectArea */
  readonly onDidWriteSubjectArea = this._onDidWriteSubjectArea.event;

  /**
   * Report tracking, injected after construction so the five existing
   * constructor call sites stay untouched. Undefined until `activate()` has
   * built the service (and always undefined with no dbt project), so every use
   * must null-check.
   */
  private reportTracking: ReportTrackingService | undefined;

  /** @see reportTracking */
  setReportTracking(tracking: ReportTrackingService | undefined): void {
    this.reportTracking = tracking;
  }

  /**
   * The `target/catalog.json` reader, injected after construction for the same
   * reason as {@link reportTracking}. Undefined is a NORMAL state — a provider
   * built without it (every test, and any window with no dbt project) simply
   * derives the physical stage from yml and manifest, exactly as before.
   */
  private catalogService: CatalogService | undefined;

  /** @see catalogService */
  setCatalogService(catalogService: CatalogService | undefined): void {
    this.catalogService = catalogService;
  }

  /**
   * Logical-only mode: the open root has no dbt_project.yml, so there is no
   * Physical stage to show or compare against. Set once by activate(), same
   * pattern as the other setters. While true, every logical payload carries
   * `logicalOnly: true`, a physical switch is answered with the logical stage,
   * a Diff request is answered with no report, and Add Tables from dbt
   * explains itself instead of listing models.
   */
  private logicalOnly = false;

  /** @see logicalOnly */
  setLogicalOnly(logicalOnly: boolean): void {
    this.logicalOnly = logicalOnly;
  }

  /** `{ logicalOnly: true }` for a logical payload in logical-only mode, else nothing (absent = Physical available). */
  private logicalOnlyFlag(): { logicalOnly?: true } {
    return this.logicalOnly ? { logicalOnly: true } : {};
  }

  /**
   * Load the warehouse catalog, if a reader was injected and an artifact exists.
   *
   * Always resolves — `CatalogService.loadCatalog()` degrades to undefined on
   * every failure, and `buildPhysicalSubjectArea()` treats undefined as "no catalog".
   */
  private async loadCatalog(): Promise<CatalogData | undefined> {
    return this.catalogService?.loadCatalog(this.workspaceRoot);
  }

  /**
   * Serialization queue for document mutations. Ensures concurrent messages
   * (e.g. updateColumn + updatePositions) are processed sequentially so each
   * handler reads the latest document text rather than clobbering each other.
   * Keyed by document URI to allow independent queues for different files.
   */
  private readonly editQueues = new Map<string, Promise<void>>();

  /**
   * Enqueue a mutation so it runs after any pending mutation for the same
   * document completes. Returns a promise that resolves when `fn` finishes.
   */
  private queueEdit(documentUri: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.editQueues.get(documentUri) ?? Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    this.editQueues.set(documentUri, next);
    this.editQueueSeq.set(documentUri, (this.editQueueSeq.get(documentUri) ?? 0) + 1);
    return next;
  }

  /** Per panel: how many edits were ever queued (to tell whether a waiting batch is still the last one). */
  private readonly editQueueSeq = new Map<string, number>();

  /**
   * Per panel: the `updatePositions` batch that is queued and has not started
   * yet, with the queue position it was given ({@link queuePositions}).
   */
  private readonly waitingPositions = new Map<string, {
    seq: number;
    positions: Record<string, { x: number; y: number }>;
    annotations: Map<string, AnnotationPositionPayload>;
    done: Promise<void>;
  }>();

  /**
   * Queue an `updatePositions`, folding it into the batch already waiting
   * for this panel when that batch is still the last thing queued: the
   * positions merge (the later message wins for a table or note both moved),
   * one edit is written and both senders resolve when it lands. While the
   * host is busy, drags that pile up are saved once instead of one save
   * (and one layout file write) each. A batch that has started, or one with
   * another edit queued after it, is never joined, so edits stay in order.
   * Folded drags are one undo step (they reach the file as one edit).
   */
  private queuePositions(
    panelKey: string,
    run: (positions: Record<string, { x: number; y: number }>, annotations: AnnotationPositionPayload[]) => Promise<void>,
    positions: Record<string, { x: number; y: number }>,
    annotations: AnnotationPositionPayload[],
  ): Promise<void> {
    const waiting = this.waitingPositions.get(panelKey);
    if (waiting && waiting.seq === this.editQueueSeq.get(panelKey)) {
      Object.assign(waiting.positions, positions);
      for (const a of annotations) waiting.annotations.set(a.id, a);
      return waiting.done;
    }
    const batch = {
      seq: 0,
      positions: { ...positions },
      annotations: new Map(annotations.map((a) => [a.id, a] as const)),
      done: Promise.resolve(),
    };
    batch.done = this.queueEdit(panelKey, () => {
      // Started: a later message queues a batch of its own.
      if (this.waitingPositions.get(panelKey) === batch) this.waitingPositions.delete(panelKey);
      return run(batch.positions, [...batch.annotations.values()]);
    });
    batch.seq = this.editQueueSeq.get(panelKey) ?? 0;
    this.waitingPositions.set(panelKey, batch);
    return batch.done;
  }

  /**
   * Track all open webview panels by document URI.
   * Used by refreshAllOpenSubjectAreas() to update all editors when manifest changes.
   * activeStage tracks which stage the webview is currently displaying.
   */
  private readonly openPanels = new Map<
    string,
    {
      document: vscode.TextDocument;
      webview: vscode.Webview;
      activeStage: Stage;
      /** The tab's panel, to tell a canvas VS Code closed without its dispose reaching us (see {@link panelIsGone}). */
      panel?: vscode.WebviewPanel;
      /** Cached discrepancy report from the last comparison (used by sync plan generation). */
      lastDiscrepancyReport?: DiscrepancyReport | null;
      /** What the last comparison knew of tables two schema folders share (`tableIdsOf`, `dbtModelNamesOf`), by lower-case reference. */
      lastDiscrepancyTables?: { ids: ReadonlyMap<string, TableId>; dbtModels: ReadonlyMap<string, string | null> };
      /** The target stage from the last discrepancy comparison (used to refresh after stub toggle). */
      lastCompareAgainst?: Stage;
      /**
       * Bumped by every Compare toggle and every stage change: a comparison
       * still loading when it moves on is dropped, not cached or posted.
       */
      compareRequest?: number;
      /** The webview answered `ready` with its diagram: a reveal can be posted now. */
      loaded?: boolean;
      /**
       * The page crashed while rendering and shows the crash screen (a render
       * `webviewError` or a `crashFallback` arrived; cleared by its next
       * `ready`): Send Feedback must not be routed to its dead dialog.
       */
      crashed?: boolean;
      /**
       * The "not shown" notes last worked out for this canvas from its files
       * ({@link sendFilesNotShown}); the notes below are added in front when posted.
       */
      fileNotes?: FileNote[];
      /** The diagram's own file stopped reading over this live canvas: the note that says so until it reads again. */
      staleNote?: FileNote;
      /** The diagram's document could not be saved, so the canvas (drawn from disk) is not showing its text. */
      saveFailed?: boolean;
      /**
       * The tables this canvas was last drawn with, and what the library files
       * it was drawn from looked like on disk then ({@link filesSignatureOf}).
       */
      drawnFrom?: { members: readonly string[]; signature: string };
      /** The diagram file's signature the canvas was last re-read for because its document was not following the disk. */
      resyncedFor?: string;
    }
  >();

  /**
   * Relationship reveals asked for before their canvas had loaded (Open in
   * Diagram on a diagram that is still opening), by diagram path. The `ready`
   * handler posts one once the diagram is on the canvas; one older than
   * {@link PENDING_REVEAL_MS} is dropped, so a canvas that failed to open
   * does not jump to it the next time it is opened by hand.
   */
  private readonly pendingReveals = new Map<string, { target: RevealRelationshipMessage['payload']; at: number }>();

  /**
   * Table reveals (and Add to Diagram…'s adds) asked for before their canvas
   * had loaded, by diagram path; run by the `ready` handler, dropped after
   * {@link PENDING_REVEAL_MS} like {@link pendingReveals}.
   */
  private readonly pendingTableActions = new Map<string, { reveal: string; add?: string[]; at: number }>();

  /**
   * The last drag that started in the Table Library ({@link noteLibraryDrag}):
   * a drop on a canvas whose DataTransfer names no table file adds these,
   * once, while younger than {@link PENDING_LIBRARY_DRAG_MS}.
   */
  private pendingLibraryDrag: { tables: string[]; files?: string[]; at: number } | undefined;

  /**
   * Webviews whose panel has been disposed. Refresh paths iterate a snapshot
   * of openPanels and may race with disposal, and mutation handlers may finish
   * after the user closes the tab — `post()` drops messages to these instead
   * of calling into a dead webview.
   */
  private readonly disposedWebviews = new WeakSet<vscode.Webview>();
  /** The canvas most recently opened or focused (Run dbt parse's Open Physical view falls back to it). */
  private lastActivePanelKey?: string;

  /**
   * Post a message to a webview, skipping disposed panels and observing the
   * returned promise so a rejection can never surface as an unhandled
   * rejection from a fire-and-forget call site.
   */
  /** Tell a canvas how to draw its lines (`erdStudio.canvas.lineStyle`). */
  private postLineStyle(webview: vscode.Webview): void {
    this.post(webview, { type: 'lineStyle', payload: { lineStyle: readLineStyle() } });
  }

  private post(webview: vscode.Webview, message: unknown): void {
    if (this.disposedWebviews.has(webview)) {
      return;
    }
    try {
      void Promise.resolve(webview.postMessage(message)).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`[SemanticEditorProvider] postMessage failed: ${msg}`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[SemanticEditorProvider] postMessage threw: ${msg}`);
    }
  }

  /**
   * Wrap a webview message listener so a handler that throws (or rejects)
   * is logged and reported to the webview as an `error` message instead of
   * becoming an unhandled rejection that silently drops the message.
   */
  private withMessageErrorBoundary(
    webview: vscode.Webview,
    listener: (message: unknown) => Promise<void>,
  ): (message: unknown) => Promise<void> {
    return async (message: unknown) => {
      try {
        await listener(message);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const type = isTypedMessage(message) ? message.type : 'unknown';
        recordHandlerFailure(handlerGroupOf(type), err);
        logHandlerFailure(`[SemanticEditorProvider] Message "${type}" failed: ${detail}`, err);
        this.post(webview, { type: 'error', payload: { message: `Failed to handle "${type}": ${detail}` } });
      }
    };
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly subjectAreaService: SubjectAreaService,
    private readonly manifestService: ManifestService,
    private readonly ymlParserService: YmlParserService,
    private readonly templateService: TemplateService,
    private readonly layerService: LayerService,
    private readonly workspaceRoot: string,
    private readonly selectorsService: SelectorsService,
    readonly tableLibraryService: import('../services/logicalModelService').TableLibraryService,
    /**
     * Shared with FileWatcherService: every file this provider writes is
     * recorded here so the watcher can tell our own saves apart from an
     * external edit and skip the redundant refresh (which would clear the
     * user's selection).
     */
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
  ) {}

  /**
   * The `ready` handler's first answer (`loading`), posted before the
   * diagram is read, then again with its table count — counted from the
   * diagram's own text, no table read — each followed by a turn of the
   * event loop so the message leaves the host before the read blocks it.
   */
  private async postLoading(document: vscode.TextDocument, webview: vscode.Webview): Promise<void> {
    this.post(webview, { type: 'loading', payload: {} });
    await yieldToEventLoop();
    let tables: number | undefined;
    try {
      tables = this.subjectAreaService.countSubjectAreaTablesInText(document.getText(), document.uri.fsPath);
    } catch {
      // The read that follows reports what is wrong with the file.
      return;
    }
    this.post(webview, { type: 'loading', payload: { tables } });
    await yieldToEventLoop();
  }

  /**
   * Answer `requestExistingTables`: read the Table Library files a payload
   * listed by name only (`detailsPending`), a slice at a time so the host
   * stays responsive, then post the Add Existing Table rows in full.
   */
  private async sendExistingTables(document: vscode.TextDocument, webview: vscode.Webview): Promise<void> {
    const library = this.tableLibraryService;
    const unread = library.unreadTableFiles();
    while (unread.length > 0) {
      const started = Date.now();
      do library.warmTableFile(unread.shift()!); while (unread.length > 0 && Date.now() - started < 20);
      await yieldToEventLoop();
    }
    if (this.disposedWebviews.has(webview)) return;
    const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
    const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
    const domain = this.subjectAreaService.getSubjectArea(document.uri.fsPath);
    const memberFiles = this.memberFilesOf(document.uri.fsPath);
    const { existingModels, manifestModels } = this.buildWebviewPayload(
      { models: domain.logical.models }, manifest, ymlData, domain.modelFolder,
      { readAllTables: true, catalog: await this.loadCatalog(), ...(memberFiles ? { memberFiles } : {}) },
    );
    this.post(webview, { type: 'existingTables', payload: { existingModels, manifestModels } });
  }

  /** The repository's CODEOWNERS (read only), for "Reviewed by" in the detail panel. */
  private codeOwners: Pick<CodeOwnersReader, 'ownersOf'> | undefined;

  /** Hand the editor the CODEOWNERS reader the sidebar uses (set once, at activation). */
  useCodeOwners(reader: Pick<CodeOwnersReader, 'ownersOf'>): void {
    this.codeOwners = reader;
  }

  /** Each webview's latest `canvasContext` request: an older one still running posts nothing. */
  private readonly canvasContextRuns = new WeakMap<vscode.Webview, number>();

  /** Stop a `canvasContext` still being worked out: the physical stage gets none. */
  private cancelCanvasContext(webview: vscode.Webview): void {
    this.canvasContextRuns.set(webview, (this.canvasContextRuns.get(webview) ?? 0) + 1);
  }

  /**
   * Post the `canvasContext` for a logical-stage diagram just posted: each
   * table's file and reviewers, and its relationships to tables not on the
   * diagram (`buildCanvasContext`). Runs after the diagram has gone out, so
   * the canvas paints first, and reads no table file a refresh would not:
   * the Refs of every relationships file (DBML: the whole library, not just
   * the diagram's imports) and the own relationships of each YAML table
   * already read (a large YAML library's other tables join as the
   * background warm-up reads them, on the next refresh). Writes nothing;
   * never throws.
   */
  private async sendCanvasContext(webview: vscode.Webview, members: readonly string[], diagramLayer: string | undefined, document?: vscode.TextDocument): Promise<void> {
    const run = (this.canvasContextRuns.get(webview) ?? 0) + 1;
    this.canvasContextRuns.set(webview, run);
    const current = (): boolean => this.canvasContextRuns.get(webview) === run && !this.disposedWebviews.has(webview);
    try {
      await yieldToEventLoop();
      if (!current()) return;
      const library = this.tableLibraryService;
      const labels = new Map(this.layerService.getAllLayers().map((l) => [l.id, l.label || l.id]));
      const labelOf = (layer: string | undefined): string | undefined => (layer === undefined ? undefined : labels.get(layer) ?? layer);
      // One look at the library's listing for every lookup below, not one per table.
      const context = library.withIndexSnapshot(() => {
        // Told apart by identity, a DBML diagram's members are found by their own files (the diagram boundary).
        const scoped = document !== undefined && this.schemaScoped() && this.isDbmlDocument(document) ? this.scopedCanvasContext(document) : undefined;
        if (scoped) {
          return buildCanvasContext({
            members,
            libraryTables: library.dirExists() ? this.knownLibraryRelationships(true) : [],
            ...scoped,
            ...(diagramLayer !== undefined ? { diagramLayerLabel: labelOf(diagramLayer) } : {}),
            layerLabelOf: (name) => labelOf(scoped.entryOf(name)?.layer),
            ...(this.codeOwners ? {
              ownersOf: (name: string) => {
                const file = scoped.memberFile(name);
                return file === undefined ? [] : this.codeOwners!.ownersOf(file);
              },
            } : {}),
          });
        }
        const tables = library.dirExists() ? this.knownLibraryRelationships() : [];
        const entries = library.listTableFiles();
        const homes = tableHomesOf(entries);
        // A table's file from the listing: a name with no file gets no File line
        // (`resolveTablePath` would name where a new one would go).
        const files = new Map<string, string>();
        for (const e of entries) if (!e.shadowedBy && !files.has(e.name.toLowerCase())) files.set(e.name.toLowerCase(), e.filePath);
        const fileOf = (name: string): string | undefined => files.get(name.toLowerCase());
        return buildCanvasContext({
          members,
          libraryTables: tables,
          fileOf: (name) => {
            const file = fileOf(name);
            return file === undefined ? undefined : projectRelative(this.workspaceRoot, file);
          },
          layerLabelOf: (name) => labelOf(homes.get(name.toLowerCase())?.layer),
          ...(diagramLayer !== undefined ? { diagramLayerLabel: labelOf(diagramLayer) } : {}),
          ...(this.codeOwners ? {
            ownersOf: (name: string) => {
              const file = fileOf(name);
              return file === undefined ? [] : this.codeOwners!.ownersOf(file);
            },
          } : {}),
        });
      });
      if (!current()) return;
      this.post(webview, { type: 'canvasContext', payload: context });
    } catch (err) {
      // The canvas works without it: no File line, no "Not on this diagram" list.
      log.warn(`[SemanticEditorProvider] Canvas context failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // "Not shown" notes: what the files hold that the canvas is not drawing
  // -------------------------------------------------------------------------

  /** Each webview's latest `filesNotShown` run: an older one still running posts nothing. */
  private readonly filesNotShownRuns = new WeakMap<vscode.Webview, number>();

  /**
   * `.dbml` files saved this session where ERD Studio reads no file, relative
   * to the semantic dir ({@link noteUnreadFile}). Only what the watcher saw
   * being written: a file that has always been there (an export a team keeps
   * in the folder) is `doctor`'s to report, not a note on every canvas.
   */
  private readonly unreadFiles = new Set<string>();

  /** A redraw after a file change failed ({@link noteRefreshFailed}): what changed, until a redraw succeeds. */
  private refreshFailure: RefreshKind | undefined;

  /**
   * Work out and post the "not shown" notes of a logical-stage diagram just
   * posted (`collectFilesNotShown`): after the diagram has gone out, like the
   * canvas context, and from readings the redraw already made (the table
   * files of its members, the relationships files, the diagram's own import
   * drift), so it costs a stat per file. Reads only; never throws.
   */
  private async sendFilesNotShown(webview: vscode.Webview, panelKey: string, document: vscode.TextDocument, members: readonly string[]): Promise<void> {
    const run = (this.filesNotShownRuns.get(webview) ?? 0) + 1;
    this.filesNotShownRuns.set(webview, run);
    const current = (): boolean => this.filesNotShownRuns.get(webview) === run && !this.disposedWebviews.has(webview);
    try {
      await yieldToEventLoop();
      if (!current()) return;
      const entry = this.openPanels.get(panelKey);
      if (!entry || entry.webview !== webview) return;
      entry.fileNotes = this.collectFileNotes(document, members);
      this.postFilesNotShown(panelKey);
    } catch (err) {
      // The canvas works without them; the log and doctor still say everything.
      log.warn(`[SemanticEditorProvider] "Not shown" notes failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The notes of one diagram, from its files as they are on disk now. A YAML/JSON diagram of a YAML project has none. */
  private collectFileNotes(document: vscode.TextDocument, members: readonly string[]): FileNote[] {
    const fsPath = document.uri.fsPath;
    const library = this.tableLibraryService;
    const semanticRoot = this.semanticRootDir();
    const dbmlDiagram = subjectAreaStorageOf(fsPath) === 'dbml';
    if (!dbmlDiagram && !this.libraryHoldsDbml()) return [];
    const semanticRelative = (filePath: string): string => path.relative(semanticRoot, filePath).split(path.sep).join('/');
    return library.withIndexSnapshot(() => {
      let canAddImports = false;
      if (dbmlDiagram) {
        try {
          const file = codecFor(fsPath).parse(document.getText(), this.shownSubjectAreaPath(fsPath));
          canAddImports = file.writable !== false && !file.holdsOwnTables;
        } catch {
          canAddImports = false;
        }
      }
      const memberTables: Array<{ file: string; problems: readonly import('@erd-studio/core').DbmlProblem[] }> = [];
      for (const name of new Set(members.map((m) => m.toLowerCase()))) {
        const found = library.dbmlTableProblems(name);
        if (found && found.problems.length > 0) memberTables.push({ file: semanticRelative(found.filePath), problems: found.problems });
      }
      const relationshipsFiles: Array<{ file: string; reading: import('@erd-studio/core').DbmlRelationshipsReading }> = [];
      for (const filePath of library.listRelationshipsFiles()) {
        const reading = library.readRelationshipsFile(filePath);
        if (reading && !reading.readable) relationshipsFiles.push({ file: semanticRelative(filePath), reading });
      }
      return collectFilesNotShown({
        importDrift: dbmlDiagram ? this.subjectAreaService.relationshipsImportDrift(fsPath) : [],
        canAddImports,
        memberTables,
        relationshipsFiles,
        unreadFiles: this.currentUnreadFiles(),
        shown: (rel) => projectRelative(this.workspaceRoot, path.join(semanticRoot, ...rel.split('/'))),
      });
    });
  }

  /** {@link unreadFiles} that are still there and still unread; the others are forgotten. */
  private currentUnreadFiles(): string[] {
    const semanticRoot = this.semanticRootDir();
    const tablesDirIsLayer = this.tableLibraryService.tablesDirIsLayer();
    for (const rel of [...this.unreadFiles]) {
      const cls = classifySemanticFile(rel, { tablesDirIsLayer });
      if (cls.kind !== 'other' || cls.legacy !== undefined || !fs.existsSync(path.join(semanticRoot, ...rel.split('/')))) this.unreadFiles.delete(rel);
    }
    return [...this.unreadFiles];
  }

  /** Post a canvas's notes: what is wrong with the picture itself first, then what its files hold. Logical stage only. */
  private postFilesNotShown(panelKey: string): void {
    const entry = this.openPanels.get(panelKey);
    if (!entry || entry.activeStage !== 'logical' || this.disposedWebviews.has(entry.webview)) return;
    const items: FileNote[] = [
      ...(entry.staleNote ? [entry.staleNote] : []),
      ...(entry.saveFailed && entry.document.isDirty ? [this.unsavedDiagramNote(entry.document)] : []),
      ...(this.refreshFailure ? [refreshFailedNote(this.refreshFailure)] : []),
      ...(entry.fileNotes ?? []),
    ];
    this.post(entry.webview, { type: 'filesNotShown', payload: { items } });
  }

  private unsavedDiagramNote(document: vscode.TextDocument): FileNote {
    const shown = this.shownSubjectAreaPath(document.uri.fsPath);
    return {
      code: 'diagramUnsaved',
      message: `${shown} has changes that could not be saved. The canvas shows the file on disk: save or revert it in its tab.`,
      file: shown,
    };
  }

  /**
   * A `.dbml` file was created, changed or deleted where ERD Studio reads no
   * file (the watcher's `onUnreadFileChanged`): every open canvas says so
   * until the file is moved or deleted. Nothing is redrawn (the file is not
   * part of any diagram) and nothing is written.
   */
  noteUnreadFile(fsPath: string): void {
    const semanticRoot = this.semanticRootDir();
    const rel = path.relative(semanticRoot, fsPath).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel) || !/\.dbml$/i.test(rel)) return;
    // A YAML/JSON project reads no .dbml anywhere: a stray one there is not a file the user expects drawn.
    if (!this.libraryHoldsDbml() && this.tableLibraryService.listDbmlDiagrams().length === 0) return;
    this.unreadFiles.add(rel);
    this.refreshFilesNotShown();
  }

  /** Work the notes of every open, loaded canvas out again, without redrawing any diagram. Writes nothing. */
  refreshFilesNotShown(): void {
    for (const [panelKey, entry] of this.openPanels) {
      if (!entry.loaded || entry.activeStage !== 'logical' || this.disposedWebviews.has(entry.webview)) continue;
      const members = subjectAreaTableNames(entry.document.getText(), entry.document.uri.fsPath) ?? [];
      void this.sendFilesNotShown(entry.webview, panelKey, entry.document, members);
    }
  }

  /**
   * A watcher's refresh threw (`guardRefresh`): the open canvases may be out
   * of date, and they say so, with Reload from disk, until a redraw of every
   * canvas goes through ({@link refreshAllOpenSubjectAreas}).
   */
  noteRefreshFailed(kind: RefreshKind): void {
    this.refreshFailure = kind;
    for (const panelKey of this.openPanels.keys()) this.postFilesNotShown(panelKey);
  }

  /**
   * Read every file again and redraw every open canvas (**ERD Studio: Reload
   * Diagrams from Disk**, and the "not shown" strip's Reload from disk): for
   * a setup where file events do not arrive, and after a failed redraw. The
   * library, layers and field list already check the disk on every read; the
   * caches are dropped all the same, so nothing a reader remembered survives.
   * A refresh path: it never writes.
   */
  async reloadFromDisk(): Promise<void> {
    this.tableLibraryService.invalidateCache();
    this.tableLibraryService.invalidateRelationships();
    this.tableLibraryService.invalidateIndex();
    this.layerService.invalidateCache();
    this.fieldsReader?.invalidate();
    this.ymlParserService.invalidate();
    // A canvas showing an error is told again, even the same one: the user asked.
    for (const panelKey of this.openPanels.keys()) this.lastLoadError.delete(panelKey);
    this.syncSubjectAreaFilePresence();
    await this.refreshAllOpenSubjectAreas();
  }

  /**
   * What the files this canvas is drawn from look like on disk: its members'
   * table files and every relationships file (`filesSignature`), `layers.json`
   * and `fields.yml`. The diagram's own file is not in it: its document
   * follows it ({@link revalidateAgainstDisk} checks that separately).
   */
  private filesSignatureOf(members: readonly string[]): string {
    const statOf = (filePath: string): string => {
      try {
        const stat = fs.statSync(filePath);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return '';
      }
    };
    const semanticRoot = this.semanticRootDir();
    return [
      this.tableLibraryService.filesSignature(members),
      `layers@${statOf(this.layerService.getConfigPath())}`,
      `fields@${statOf(path.join(semanticRoot, FIELDS_FILE_NAME))}`,
    ].join('\n');
  }

  /**
   * The safety net under the watchers: when a canvas gets the focus, check
   * that it still shows its files, and redraw it when it does not. Two things
   * are compared, with a stat per file and one read of the diagram:
   *
   * - the library files it was drawn from ({@link filesSignatureOf}) against
   *   the disk now: a table or relationships file changed with no event
   *   reaching us (a network drive, a container mount, a watcher limit);
   * - the diagram's document against its file: a document left unsaved by a
   *   failed save, or one VS Code stopped syncing, no longer follows the
   *   disk, so no change to the file would ever reach the canvas through it.
   *   Redrawn once per version of the file, never in a loop.
   *
   * Skipped while this canvas's own edit is under way or refreshes are held.
   * A refresh path: it never writes, and never saves the document.
   */
  async revalidateAgainstDisk(panelKey: string): Promise<boolean> {
    const entry = this.openPanels.get(panelKey);
    if (!entry || !entry.loaded || this.refreshHolds > 0 || this.pendingUpdates.get(panelKey) || this.disposedWebviews.has(entry.webview)) return false;
    const { document, webview } = entry;
    if (document.uri.scheme !== 'file') return false;
    let stale = false;
    try {
      if (entry.drawnFrom !== undefined && this.filesSignatureOf(entry.drawnFrom.members) !== entry.drawnFrom.signature) stale = true;
      const onDisk = this.diskTextAndSignature(document.uri.fsPath);
      if (onDisk && onDisk.text !== document.getText().replace(/^﻿/, '') && entry.resyncedFor !== onDisk.signature) {
        entry.resyncedFor = onDisk.signature;
        stale = true;
      }
    } catch (err) {
      log.warn(`[SemanticEditorProvider] Could not check ${document.uri.fsPath} against the disk: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    if (!stale) return false;
    log.debug(`[SemanticEditorProvider] ${document.uri.fsPath} no longer shows its files: redrawing`);
    if (entry.activeStage === 'physical') await this.handleSwitchStage(panelKey, document, webview, 'physical');
    else await this.sendSubjectAreaData(document, webview, panelKey);
    return true;
  }

  /** A file's text (no byte-order mark) and `mtime:size`, or null when it cannot be read. */
  private diskTextAndSignature(filePath: string): { text: string; signature: string } | null {
    try {
      const stat = fs.statSync(filePath);
      return { text: fs.readFileSync(filePath, 'utf-8').replace(/^﻿/, ''), signature: `${stat.mtimeMs}:${stat.size}` };
    } catch {
      return null;
    }
  }

  /**
   * A change to a diagram file on disk that ERD Studio did not write (the
   * semantic watcher): normally the canvas has already redrawn through its
   * document. When the document is not following the disk, redraw from the
   * file ({@link revalidateAgainstDisk}). Writes nothing.
   */
  async syncSubjectAreaWithDisk(fsPath: string): Promise<void> {
    for (const [panelKey, entry] of Array.from(this.openPanels.entries())) {
      if (samePath(entry.document.uri.fsPath, fsPath)) await this.revalidateAgainstDisk(panelKey);
    }
  }

  /**
   * A "not shown" note's file link: open the file as text at its line. Only
   * a file inside the project's ERD Studio folder is opened, whatever the
   * webview sent. Writes nothing.
   *
   * Where: the group already showing that file, else the group right of the
   * canvas (`canvasColumn + 1`). Never `ViewColumn.Beside` while the canvas's
   * column is known: Beside is relative to the ACTIVE group, which is still
   * the text editor the user last typed in when the click arrives, so every
   * link would open yet another group further right.
   */
  private async handleOpenNotedFile(payload: { file: string; line?: number }, webview: vscode.Webview, canvasColumn?: vscode.ViewColumn): Promise<void> {
    const filePath = path.resolve(this.workspaceRoot, ...payload.file.split('/'));
    const inside = path.relative(this.semanticRootDir(), filePath);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) {
      this.post(webview, { type: 'error', payload: { message: 'That file is not inside this project.' } });
      return;
    }
    if (!fs.existsSync(filePath)) {
      this.post(webview, { type: 'error', payload: { message: `${payload.file} is no longer there.` } });
      return;
    }
    const position = new vscode.Position(Math.max((payload.line ?? 1) - 1, 0), 0);
    const shownIn = (vscode.window.visibleTextEditors ?? []).find((editor) => samePath(editor.document.uri.fsPath, filePath))?.viewColumn;
    const viewColumn = shownIn ?? (canvasColumn !== undefined && canvasColumn > 0 ? canvasColumn + 1 : vscode.ViewColumn.Beside);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'default', {
      selection: new vscode.Range(position, position),
      viewColumn,
    });
  }

  /**
   * A `relationshipsNotImported` note's Add the import: re-render this DBML
   * diagram with the relationships imports the one rule gives it
   * (`relationshipsImportsFor`, through the same storage edit every other
   * diagram edit uses), so the lines its files already hold are drawn. One
   * WorkspaceEdit, one save, one undo step; nothing else in the diagram
   * changes, and no relationship is created, moved or rewritten.
   *
   * `afterSave` is the same edit made by itself after a relationships file
   * was saved in this window ({@link settleImportsAfterSave}): it says
   * nothing when it cannot be made (the strip keeps its button), redraws
   * the canvas itself, and marks the canvas unsaved when its save fails.
   * Returns whether the edit was made.
   */
  private async handleAddRelationshipsImports(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    afterSave = false,
  ): Promise<boolean> {
    const say = (message: string): void => {
      if (!afterSave) this.post(webview, { type: 'error', payload: { message } });
    };
    if (!this.isDbmlDocument(document)) {
      say('Only a DBML diagram imports relationships files.');
      return false;
    }
    this.refuseIfSubjectAreaFileGone(document);
    const text = document.getText();
    const file = this.parseSubjectAreaFile(document, text);
    // Nothing to import (the file was fixed meanwhile): the strip is only out of date.
    if (this.subjectAreaService.relationshipsImportDrift(document.uri.fsPath).length === 0) {
      if (!afterSave) this.refreshFilesNotShown();
      return false;
    }
    if (file.writable === false || file.holdsOwnTables) {
      say(`ERD Studio can't edit ${this.shownSubjectAreaPath(document.uri.fsPath)} as it is. Add the use * line to it by hand.`);
      return false;
    }
    if (!afterSave) {
      return this.applyStorageEdit(document, file, text, {
        stage: 'logical',
        webview,
        errorLabel: 'Failed to add the import.',
      });
    }
    // No webview: a rejected edit or a failed save posts no toast (a convenience
    // that did not happen is not an error); the canvas is redrawn below instead.
    const panelKey = document.uri.toString();
    const applied = await this.applyStorageEdit(document, file, text, {
      stage: 'logical',
      onUnsaved: () => {
        const entry = this.openPanels.get(panelKey);
        if (entry?.webview === webview) entry.saveFailed = true;
      },
    });
    if (applied && !this.disposedWebviews.has(webview)) await this.sendSubjectAreaData(document, webview, panelKey);
    return applied;
  }

  // -------------------------------------------------------------------------
  // The import settle after a relationships file is saved in this window
  // -------------------------------------------------------------------------

  /** Relationships files saved in this window by the user, waiting for {@link settleImportsAfterSave} (resolved paths). */
  private readonly savedRelationshipsFiles = new Set<string>();
  private savedRelationshipsTimer: ReturnType<typeof setTimeout> | undefined;
  /** The settle under way (tests await it). */
  private importsSettle: Promise<void> = Promise.resolve();

  /**
   * A text document was saved in this window (`workspace.onDidSaveTextDocument`,
   * wired in `extension.ts`). When it is a relationships file, the open
   * logical canvases whose diagrams now need to import it are settled
   * ({@link settleImportsAfterSave}), once for a burst of saves (Save All).
   *
   * This is the one place a change to a file outside the diagram writes the
   * diagram, and it is deliberately narrow: only a save made in this window
   * (typed, formatted on save, auto-saved, or an extension's edit saved
   * here) gets here. A change that arrives on disk (git, another program, an
   * AI assistant writing the file, another window) fires no save event: the
   * watcher redraws, and the strip offers Add the import. ERD Studio's own
   * saves (an edit's, an undo's) were announced to the own-write tracker
   * before they started, and are skipped.
   */
  noteDocumentSaved(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || !/\.dbml$/i.test(document.uri.fsPath)) return;
    const fsPath = path.resolve(document.uri.fsPath);
    if (this.ownWriteTracker.isPending(fsPath)) return;
    const rel = path.relative(this.semanticRootDir(), fsPath).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return;
    const tablesDirIsLayer = this.tableLibraryService.tablesDirIsLayer();
    if (classifySemanticFile(rel, { tablesDirIsLayer }).kind !== 'relationships') return;
    this.savedRelationshipsFiles.add(fsPath);
    clearTimeout(this.savedRelationshipsTimer);
    this.savedRelationshipsTimer = setTimeout(() => {
      this.savedRelationshipsTimer = undefined;
      this.importsSettle = this.importsSettle.then(() => this.settleImportsAfterSave());
    }, SAVED_RELATIONSHIPS_SETTLE_MS);
  }

  /** Resolves once every settle asked for so far has finished (tests). */
  async importsSettled(): Promise<void> {
    while (this.savedRelationshipsTimer !== undefined) await new Promise((resolve) => setTimeout(resolve, SAVED_RELATIONSHIPS_SETTLE_MS));
    await this.importsSettle;
  }

  /**
   * After relationships files were saved in this window: every open, loaded
   * logical canvas of a DBML diagram that now needs to import one of them
   * (the one import rule, `relationshipsImportsFor`, read as the diagram
   * reader's drift) gets Add the import's edit, queued behind its other
   * edits. Each canvas is its own edit and its own undo step. Never throws.
   */
  private async settleImportsAfterSave(): Promise<void> {
    const saved = [...this.savedRelationshipsFiles];
    this.savedRelationshipsFiles.clear();
    // A bulk command holds the canvases: it redraws them when it is done, and the strip offers the button.
    if (saved.length === 0 || this.refreshHolds > 0) return;
    try {
      this.tableLibraryService.invalidatePaths(saved);
    } catch {
      // The readings are checked against the disk regardless.
    }
    const runs: Array<Promise<void>> = [];
    for (const [panelKey, entry] of Array.from(this.openPanels.entries())) {
      const { webview } = entry;
      runs.push(this.queueEdit(panelKey, async () => {
        try {
          await this.addImportsAfterSave(panelKey, webview, saved);
        } catch (err) {
          // A convenience: the strip still offers the button.
          log.debug(`[SemanticEditorProvider] Imports not added after a save: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
    }
    await Promise.all(runs);
  }

  /** {@link settleImportsAfterSave} for one canvas. Returns whether the diagram was written. */
  private async addImportsAfterSave(panelKey: string, webview: vscode.Webview, saved: readonly string[]): Promise<boolean> {
    const entry = this.openPanels.get(panelKey);
    if (!entry || entry.webview !== webview || !entry.loaded || this.disposedWebviews.has(webview)) return false;
    // The physical stage is read-only; an edit or a hold already under way is never interleaved with.
    if (entry.activeStage !== 'logical' || this.refreshHolds > 0 || this.pendingUpdates.get(panelKey)) return false;
    const { document } = entry;
    if (document.uri.scheme !== 'file' || !this.isDbmlDocument(document)) return false;
    // A document that is not the file on disk (unsaved, a failed save) or a file that does not read: left alone.
    if (document.isDirty || entry.saveFailed || entry.staleNote !== undefined) return false;
    const fsPath = document.uri.fsPath;
    const semanticRoot = this.semanticRootDir();
    // Only a saved file that reads can be imported (the rule never adds an unreadable one).
    const readable = new Set(saved
      .filter((p) => this.tableLibraryService.readRelationshipsFile(p)?.readable === true)
      .map((p) => path.relative(semanticRoot, p).split(path.sep).join('/')));
    if (readable.size === 0) return false;
    // The diagram read again, as the files are now: its reader records the imports it lacks.
    this.subjectAreaService.getSubjectArea(fsPath);
    const before = this.subjectAreaService.relationshipsImportDrift(fsPath);
    if (!before.some((file) => readable.has(file))) return false;
    if (!(await this.handleAddRelationshipsImports(document, webview, true))) return false;
    const after = new Set(this.subjectAreaService.relationshipsImportDrift(fsPath));
    const added = before.filter((file) => !after.has(file));
    if (added.length > 0) this.post(webview, { type: 'canvasNotice', payload: { message: importsAddedMessage(added) } });
    log.info(`[SemanticEditorProvider] ${this.shownSubjectAreaPath(fsPath)}: added the import of ${added.join(', ')} after a save`);
    return true;
  }

  /**
   * Every library table by name (no columns), each with the relationships it
   * owns as far as is known without reading a table file: the Refs of every
   * relationships file (a Ref's pairs as one composite line), and each YAML
   * table's own list when its file is already read. For `buildCanvasContext`.
   */
  private knownLibraryRelationships(byIdentity = false): SemanticTable[] {
    const library = this.tableLibraryService;
    const entries = library.listTableFiles().filter((e) => !e.shadowedBy);
    const owned = new Map<string, TableRelationship[]>();
    const own = (owner: string, rel: TableRelationship): void => {
      const key = owner.toLowerCase();
      const list = owned.get(key);
      if (list) list.push(rel);
      else owned.set(key, [rel]);
    };
    if (byIdentity) {
      // Told apart by identity: each Ref as the relationships index resolved its ends, by the
      // tables' library references (`<schema>.<name>` where two schema folders share a name).
      for (const ref of library.relationshipsIndex().refs) {
        const { unit } = ref;
        const composite = unit.fromColumns.length > 1 ? `ref:${ref.file}:${ref.line}` : undefined;
        unit.fromColumns.forEach((fromColumn, i) => own(unit.from, {
          fromColumn, toModel: unit.to, toColumn: unit.toColumns[i] ?? '', cardinality: unit.cardinality,
          ...(unit.role !== undefined ? { role: unit.role } : {}),
          ...(composite ? { compositeKey: composite } : {}),
        }));
      }
      const unreadYaml = new Set(library.unreadTableFiles().map((e) => e.filePath));
      return entries.map((e) => {
        const name = (e.id ? library.libraryRef(e.id) : undefined) ?? e.name;
        let relationships = owned.get(name.toLowerCase()) ?? [];
        if (e.storage !== 'dbml' && !unreadYaml.has(e.filePath)) {
          try {
            relationships = [...relationships, ...(library.getTable(e.name)?.relationships ?? [])];
          } catch {
            // A YAML table that does not read owns nothing here.
          }
        }
        return { name, columns: [], relationships } as unknown as SemanticTable;
      });
    }
    for (const file of library.listRelationshipsFiles()) {
      const reading = library.readRelationshipsFile(file);
      if (!reading?.readable) continue;
      for (const ref of [...reading.refs, ...(reading.pending ?? [])]) {
        const composite = ref.relationships.length > 1 ? `ref:${file}:${ref.line}` : undefined;
        for (const { fromModel, ...rel } of ref.relationships) {
          own(fromModel, composite && !rel.compositeKey ? { ...rel, compositeKey: composite } : rel);
        }
      }
    }
    const unread = new Set(library.unreadTableFiles().map((e) => e.filePath));
    for (const entry of entries) {
      if (entry.storage === 'dbml' || unread.has(entry.filePath)) continue;
      let table: SemanticTable | null = null;
      try {
        table = library.getTable(entry.name);
      } catch {
        table = null;
      }
      for (const rel of table?.relationships ?? []) own(entry.name, rel);
    }
    return entries.map((e) => ({ name: e.name, columns: [], relationships: owned.get(e.name.toLowerCase()) ?? [] }) as unknown as SemanticTable);
  }

  /**
   * What the canvas context of the DBML diagram `document` needs where the
   * library tells tables apart by identity: each member's own file
   * (`fileOf`, `memberFile`), the member a library table is (`memberOf`, by
   * its file), and each library table's entry and file (`entryOf`,
   * `otherTablePathOf`), all by the library's references.
   */
  private scopedCanvasContext(document: vscode.TextDocument): {
    fileOf: (ref: string) => string | undefined;
    memberFile: (ref: string) => string | undefined;
    memberOf: (libraryName: string) => string | undefined;
    otherTablePathOf: (libraryName: string) => string | undefined;
    entryOf: (libraryName: string) => TableFileEntry | undefined;
  } | undefined {
    const refs = this.diagramLibraryRefs(document);
    const members = this.parseSubjectAreaFile(document).members;
    if (!refs || !members) return undefined;
    const library = this.tableLibraryService;
    const memberFile = (ref: string): string | undefined => {
      const row = members.resolve(ref);
      if (row?.path === undefined || row.path.startsWith('../')) return undefined;
      return library.tableEntryAt(library.semanticAbsolute(row.path))?.filePath;
    };
    const entryOf = (libraryName: string): TableFileEntry | undefined => {
      const found = library.resolveLibraryRef(libraryName);
      return found.kind === 'found' ? found.entry : undefined;
    };
    return {
      memberFile,
      fileOf: (ref) => {
        const file = memberFile(ref);
        return file === undefined ? undefined : projectRelative(this.workspaceRoot, file);
      },
      memberOf: (libraryName) => {
        const ref = refs.toDiagram(libraryName);
        return members.resolve(ref)?.ref === ref ? ref : undefined;
      },
      otherTablePathOf: (libraryName) => {
        const file = entryOf(libraryName)?.filePath;
        return file === undefined ? undefined : projectRelative(this.workspaceRoot, file);
      },
      entryOf,
    };
  }

  /**
   * Where the library tells tables apart by identity: the table files the
   * DBML diagram `diagramPath`'s `use` lines read (resolved, lower-case), as
   * its open document or its file now says. Undefined anywhere else.
   */
  private memberFilesOf(diagramPath: string | undefined): ReadonlySet<string> | undefined {
    if (diagramPath === undefined || !this.schemaScoped() || subjectAreaStorageOf(diagramPath) !== 'dbml') return undefined;
    const text = this.openOrDiskText(diagramPath);
    if (text === null) return undefined;
    try {
      const members = codecFor(diagramPath).parse(text, this.shownSubjectAreaPath(diagramPath)).members;
      return new Set((members?.rows ?? []).flatMap((r) => (r.path !== undefined && !r.path.startsWith('../')
        ? [path.resolve(this.tableLibraryService.semanticAbsolute(r.path)).toLowerCase()]
        : [])));
    } catch {
      return undefined;
    }
  }

  /**
   * Build supplementary payload data for webview messages.
   * Includes templates and list of available models from logical-models/, yml, and manifest.
   */
  private buildWebviewPayload(
    domain: { models: Array<{ name: string }> },
    manifest: ManifestData,
    ymlData: YmlData,
    modelFolder?: string,
    options: {
      readAllTables?: boolean;
      catalog?: CatalogData;
      /**
       * Where the library tells tables apart by identity, the table files a DBML diagram's `use`
       * lines read (resolved, lower-case): a library row is left out when it is one of them (not
       * by name: another schema folder's table of a member's name can still be added), and each
       * row names its own file with its layer and schema folder.
       */
      memberFiles?: ReadonlySet<string>;
    } = {},
  ): {
    templates: ReturnType<TemplateService['loadTemplates']>;
    manifestModels: Array<{
      name: string;
      schema: string;
      description: string;
      columnCount: number;
    }>;
    existingModels: import('../types/display').ExistingTablePreview[];
  } {
    const templates = this.templateService.loadTemplates(this.workspaceRoot);
    const existingModelNames = new Set(domain.models.map((m) => m.name));

    // Build existing models list from three sources: logical-models/, yml, and manifest
    const existingModels: import('../types/display').ExistingTablePreview[] = [];
    const addedNames = new Set<string>();

    // 1. Logical models (already designed in ERD Studio's model library):
    // what the dialog shows of each, from the caches. On a large library
    // opened before its files were read, the unread ones go out by name
    // only (`detailsPending`) and the dialog asks for the rest when it opens.
    const library = this.tableLibraryService;
    const previews = library.withIndexSnapshot(() => library.tablePreviews({ readAtMost: options.readAllTables ? Infinity : EXISTING_TABLES_READ_AT_MOST }));
    library.withIndexSnapshot(() => {
      const memberFiles = options.memberFiles;
      for (const model of previews) {
        if (memberFiles ? memberFiles.has(path.resolve(model.filePath).toLowerCase()) : existingModelNames.has(model.name)) continue;
        // A yml whose internal `name:` is not path-safe cannot be added to a
        // domain — skip it rather than failing the whole payload.
        const absPath = model.pending || memberFiles ? model.filePath : library.resolveTablePath(model.name);
        if (absPath === null) continue;
        const entry = memberFiles ? library.tableEntryAt(absPath) : undefined;
        existingModels.push({
          name: model.name,
          schema: model.schema,
          description: model.description,
          columnCount: model.columnCount,
          source: 'logical',
          sourcePath: path.relative(this.workspaceRoot, absPath),
          ...(model.pending ? { detailsPending: true as const } : {}),
          ...(entry?.storage === 'dbml' && entry.layer !== undefined ? { layer: entry.layer, schemaFolder: entry.folder } : {}),
        });
        addedNames.add(model.name);
      }
    });

    // A dbt model's count is what adding it gives the table
    // (`seedTableFromDbt`): its declared columns plus the ones only the
    // catalog has. The cached catalog when the caller has none to hand.
    const catalog = 'catalog' in options ? options.catalog : this.catalogService?.peekCatalog();

    // 2. dbt .yml source file models (declared in dbt project)
    for (const [name, ymlModel] of ymlData.models) {
      if (existingModelNames.has(name) || addedNames.has(name)) continue;
      const manifestModel = manifest.models.get(name);
      existingModels.push({
        name,
        schema: manifestModel?.schema ?? '',
        description: ymlModel.description || manifestModel?.description || '',
        columnCount: seededColumnCount(name, ymlModel.columns, manifestModel, catalog),
        source: 'yml',
        sourcePath: path.relative(this.workspaceRoot, ymlModel.filePath),
      });
      addedNames.add(name);
    }

    // 3. Manifest models not in yml or logical (compiled/ephemeral models)
    let filteredManifest = Array.from(manifest.models.values()).filter(
      (m) => !existingModelNames.has(m.name) && !addedNames.has(m.name),
    );

    if (modelFolder) {
      const folderPrefix = modelFolder.endsWith('/') ? modelFolder : `${modelFolder}/`;
      filteredManifest = filteredManifest.filter(
        (m) => m.originalFilePath && m.originalFilePath.startsWith(folderPrefix),
      );
    }

    for (const m of filteredManifest) {
      existingModels.push({
        name: m.name,
        schema: m.schema,
        description: m.description,
        columnCount: seededColumnCount(m.name, m.columns, m, catalog),
        source: 'manifest',
        // Honours a custom `target-path` — the literal 'target/manifest.json'
        // this replaced was wrong for any project that sets one.
        sourcePath: path.relative(this.workspaceRoot, this.manifestService.getManifestPath(this.workspaceRoot)),
      });
    }

    // Sort: logical first, then yml, then manifest; alphabetical within each group
    const sourceOrder: Record<string, number> = { logical: 0, yml: 1, manifest: 2 };
    existingModels.sort((a, b) => {
      const orderDiff = (sourceOrder[a.source] ?? 9) - (sourceOrder[b.source] ?? 9);
      if (orderDiff !== 0) return orderDiff;
      return a.name.localeCompare(b.name);
    });

    // Legacy manifestModels (for backward compat with v4 webview)
    const manifestModels = existingModels
      .filter((m) => m.source === 'manifest' || m.source === 'yml')
      .map(({ name, schema, description, columnCount }) => ({ name, schema, description, columnCount }));

    return { templates, manifestModels, existingModels };
  }

  /**
   * Build and post the Feedback dialog's `feedbackContext` reply: the
   * diagnostics view (chips plus the verbatim `formatDiagnostics()` text) and a
   * capability snapshot.
   *
   * The GitHub session is read **silently** — the handle is only ever used to
   * label the auth pill and to track filed issues, and nobody is nagged to sign
   * in. `resolveAnalysisTier` / `analysisProviderLabel` decide whether the AI
   * panel renders at all, and `analysisNeedsPriming` whether it must be asked
   * for by a click first; all three answer "no" unless `feedback.aiAssist` is
   * on.
   */
  private async sendFeedbackContext(
    webview: vscode.Webview,
    payload: RequestFeedbackContextMessage['payload'],
  ): Promise<void> {
    const diagnostics = buildFeedbackContext(
      this.context,
      payload.domain,
      payload.webviewErrors ?? [],
    );
    // The log a report from this dialog may carry is exactly what it shows.
    this.feedbackLogShown.set(webview, diagnostics.log ?? []);
    const tier = await resolveAnalysisTier(this.context);
    // The handle is decoration: it labels the auth pill and helps the tracker
    // reconcile. A host with no GitHub authentication provider registered
    // rejects here, and losing the diagnostics disclosure and the whole dialog
    // over that would be absurd — so this one call is guarded and the rest of
    // the payload is posted regardless.
    let githubHandle: string | null = null;
    try {
      const session = await vscode.authentication.getSession('github', ['read:user'], {
        silent: true,
      });
      githubHandle = session?.account?.label ?? null;
    } catch (err) {
      hostErrorLog.record('sendFeedbackContext.getSession', err);
    }
    this.post(webview, {
      type: 'feedbackContext',
      payload: {
        diagnostics,
        capabilities: {
          extensionVersion: String(this.context.extension.packageJSON.version ?? 'unknown'),
          aiAvailable: tier !== 'none',
          aiProviderLabel: tier === 'none' ? null : await analysisProviderLabel(this.context),
          // The picker is listed whatever the resolved tier is, so a pinned
          // destination that is not available here (Copilot on a machine
          // without it) still leaves a visible way back rather than taking the
          // whole panel down with it.
          aiProvider: analysisProviderChoice(),
          aiOptions: await listAnalysisOptions(this.context),
          // Tier 1 on a machine where no request has succeeded yet: the dialog
          // shows its button rather than running on the debounce, so VS Code's
          // access dialog is raised by a click and not by typing.
          aiNeedsPriming: analysisNeedsPriming(this.context, tier),
          githubHandle,
        },
      },
    });
  }

  /**
   * The domain file of the focused ERD canvas, or undefined when the active
   * tab is not one of this provider's canvases (Export Diagram's no-argument
   * route then asks which domain).
   */
  activeSubjectAreaPath(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return undefined;
    return this.openPanels.has(input.uri.toString()) ? input.uri.fsPath : undefined;
  }

  /**
   * The crash screen's two buttons (the page's `crashFallback`), and the same
   * two in the host's notification for a canvas that never became ready.
   * Reload gives the panel a new page; Send Feedback opens the canvas-less
   * flow with `prefill`. Telemetry counts the button only.
   */
  private async crashChoice(
    action: CrashFallbackAction,
    panelKey: string,
    webviewPanel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    prefill: FeedbackPrefill,
  ): Promise<void> {
    if (action === 'reload') {
      telemetry.feature('crashFallbackReload');
      canvasLog.info(`Reloading the canvas of ${document.uri.fsPath}`);
      const entry = this.openPanels.get(panelKey);
      if (entry?.webview === webviewPanel.webview) entry.loaded = false;
      // A new page (a fresh nonce, so the html always changes): it says `ready` and loads again.
      webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
      return;
    }
    telemetry.feature('crashFallbackFeedback');
    this.markCrashed(panelKey, webviewPanel.webview);
    // The canvas-less Send Feedback (requestFeedbackDialog skips a crashed canvas).
    await vscode.commands.executeCommand('erdStudio.reportBug', prefill);
  }

  /** Note that `webview` (still this panel's) shows the crash screen. */
  private markCrashed(panelKey: string, webview: vscode.Webview): void {
    const entry = this.openPanels.get(panelKey);
    if (entry?.webview === webview) entry.crashed = true;
  }

  /**
   * If the active editor tab is one of our canvases, ask its webview to open
   * the Feedback dialog (so the report can include the diagnostics chips and
   * the optional analysis). Returns false when no canvas is active, or when
   * the active one shows the crash screen, so the caller can fall back to the
   * canvas-less QuickPick flow.
   */
  requestFeedbackDialog(prefill?: OpenFeedbackMessage['payload']): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return false;
    const panel = this.openPanels.get(input.uri.toString());
    // A crashed canvas shows the crash screen: its Feedback dialog went down with the tree.
    if (!panel || panel.crashed) return false;
    const msg: OpenFeedbackMessage = { type: 'openFeedback', payload: prefill };
    this.post(panel.webview, msg);
    return true;
  }

  /**
   * The dbt project a domain file belongs to when that is NOT the project
   * this window opened: the owning project's root, or `undefined` for a file
   * outside every dbt project and outside this one. `null` means the file is
   * this project's own.
   */
  private foreignProjectOf(filePath: string): string | undefined | null {
    const owner = findOwningDbtProject(filePath, this.workspaceRoot);
    if (owner) { return samePath(owner, this.workspaceRoot) ? null : owner; }
    const rel = path.relative(this.workspaceRoot, filePath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? null : undefined;
  }

  /**
   * Explain why a foreign domain file is not drawn, with a **Switch** button,
   * plus a notification offering the same. The page is not the canvas: its
   * only script posts `switchProject`, handled here, and it speaks none of
   * the canvas message protocol. (A `command:` link is not used — VS Code
   * blocks it in a custom editor webview.)
   */
  private showForeignProject(webviewPanel: vscode.WebviewPanel, filePath: string, owner: string | undefined): void {
    const esc = (v: string): string =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const current = path.basename(this.workspaceRoot);
    const webview = webviewPanel.webview;
    const nonce = crypto.randomBytes(16).toString('base64');
    // A plain (logical-only) window: nothing about dbt applies, even when the
    // file sits in a dbt project elsewhere, so the page and the toast say only
    // that it is in another folder or project, and offer no Switch (selecting a
    // dbt project needs a dbt project in this window's folders).
    const plainWindow = this.logicalOnly;
    const outsideFolder = plainWindow && !owner;
    const switchable = owner !== undefined && !plainWindow;
    webview.options = { enableScripts: switchable, localResourceRoots: [] };
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ERD Studio</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); max-width: 44em; line-height: 1.5;">
  ${outsideFolder ? `<h2 style="margin-top: 0;">This diagram is outside <code>${esc(current)}</code></h2>
  <p>ERD Studio has <code>${esc(current)}</code> open in this window and draws only the diagrams in that folder.
  Open this file\u2019s folder to edit it here.</p>` : plainWindow && owner ? `<h2 style="margin-top: 0;">This diagram is in <code>${esc(path.basename(owner))}</code>, another project</h2>
  <p>ERD Studio has <code>${esc(current)}</code> open in this window and draws only that project\u2019s diagrams.
  Open <code>${esc(path.basename(owner))}</code> to edit it here.</p>` : `<h2 style="margin-top: 0;">This diagram belongs to ${owner ? `the <code>${esc(path.basename(owner))}</code> dbt project` : 'no dbt project'}</h2>
  <p>ERD Studio has <code>${esc(current)}</code> open in this window, and a window shows one dbt project at a time.
  Drawing this file here would mix its tables with the wrong project\u2019s dbt data.</p>`}
  ${switchable && owner ? `<p><button id="switch" style="padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; font: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);">Switch ERD Studio to ${esc(path.basename(owner))}</button></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('switch').addEventListener('click', () => vscode.postMessage({ type: 'switchProject' }));
  </script>` : ''}
</body>
</html>`;

    const name = path.basename(filePath);
    if (plainWindow && owner) {
      void vscode.window.showWarningMessage(
        `ERD Studio: ${name} is in ${path.basename(owner)}, another project, so ERD Studio can't draw it in ${current}.`,
        OPEN_AS_TEXT_BUTTON,
      ).then(choice => {
        if (choice === OPEN_AS_TEXT_BUTTON) {
          void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'default');
        }
      });
      return;
    }
    if (!owner) {
      // Not a dead end (#205): the file still opens as text, and (in a dbt
      // project) another project can be picked.
      const shown = outsideFolder
        ? vscode.window.showWarningMessage(
          `ERD Studio: ${name} is outside ${current}, the folder open in this window, so ERD Studio can't draw it here.`,
          OPEN_AS_TEXT_BUTTON,
        )
        : vscode.window.showWarningMessage(
          `ERD Studio: ${name} isn't inside a dbt project, so ERD Studio can't draw it with ${current}'s dbt data.`,
          OPEN_AS_TEXT_BUTTON,
          SELECT_DBT_PROJECT_BUTTON,
        );
      void shown.then(choice => {
        if (choice === OPEN_AS_TEXT_BUTTON) {
          void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(filePath), 'default');
        } else if (choice === SELECT_DBT_PROJECT_BUTTON) {
          void vscode.commands.executeCommand('erdStudio.selectDbtProject');
        }
      });
      return;
    }
    const switchProject = (): void => {
      void vscode.commands.executeCommand('erdStudio.selectDbtProject', owner);
    };
    const messages = webview.onDidReceiveMessage((message: unknown) => {
      if (isTypedMessage(message) && message.type === 'switchProject') { switchProject(); }
    });
    webviewPanel.onDidDispose(() => messages.dispose());
    void vscode.window.showWarningMessage(
      `ERD Studio: ${name} belongs to the ${path.basename(owner)} dbt project, but ${current} is open.`,
      'Switch Project',
    ).then(choice => {
      if (choice === 'Switch Project') { switchProject(); }
    });
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    // A window serves one dbt project (#82). A domain file from another
    // project in the same workspace would read its models from this
    // project's logical-models/ and its physical stage from this project's
    // manifest — and an edit would write model files into the wrong project.
    // Refuse it and offer to switch instead of rendering wrong data.
    const foreignOwner = this.foreignProjectOf(document.uri.fsPath);
    if (foreignOwner !== null) {
      this.showForeignProject(webviewPanel, document.uri.fsPath, foreignOwner);
      return;
    }

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);
    // A canvas is opening: the background read of the library waits.
    this.libraryWarmUp?.noteForegroundWork();

    // Track this panel — default to logical stage (v3 unified files have no stage in path)
    const panelKey = document.uri.toString();
    this.openPanels.set(panelKey, { document, webview: webviewPanel.webview, activeStage: 'logical', panel: webviewPanel });
    this.lastActivePanelKey = panelKey;
    // Usage telemetry (2.0 B13): a canvas that stays blank, timed only while it is visible.
    const readyWatch = new ReadyWatch(webviewPanel.visible !== false, {
      ready: (slow) => { if (slow) telemetry.feature('readySlowOver10s'); },
      noReady: () => {
        telemetry.error('webviewNoReadyCanvas');
        // The page never mounted, so its crash screen cannot show: the host
        // offers the same two buttons in a notification.
        void askNoReadyRecovery('canvas').then((action) => {
          if (!action || this.openPanels.get(panelKey)?.webview !== webviewPanel.webview) return undefined;
          return this.crashChoice(action, panelKey, webviewPanel, document, noReadyFeedbackPrefill('canvas'));
        }).catch((err: unknown) => log.warn('[SemanticEditorProvider] The blank-canvas recovery failed', err));
      },
    });

    // --- Subscriptions (disposed when the panel closes) ---------------------

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      this.withMessageErrorBoundary(webviewPanel.webview, async (message: unknown) => {
        if (!isTypedMessage(message)) {
          log.warn('[SemanticEditorProvider] Ignoring webview message without a string "type"');
          return;
        }
        // The user is working: the background read of the library waits.
        this.libraryWarmUp?.noteForegroundWork();

        // Guard: reject mutation messages when viewing physical (read-only) stage.
        // Allowed through in physical: non-mutations (ready, switching, viewing,
        // navigation) plus writes that only touch shared canvas metadata —
        // positions and annotations live in the global viewConfig (physical
        // inherits logical positions), and generateSyncPlan is the
        // physical-stage "Compare to Logical" flow.
        // undo/redo are NOT allowed: they would rewind the logical document
        // while the user is looking at a derived, read-only view.
        const panel = this.openPanels.get(panelKey);
        const NON_MUTATION_TYPES = new Set([
          'ready', 'updatePositions', 'switchStage', 'toggleDiscrepancy',
          'refreshManifest',
          'viewFile', 'generateSyncPlan', 'runDbtCompile', 'runDbtParse', 'launchClaudeSync',
          'addAnnotation', 'updateAnnotation', 'removeAnnotation', 'removeAnnotations',
          'requestReload', 'openGettingStarted', 'showLogs', 'closeEditor', 'openAnotherDomain',
          'requestFeedbackContext', 'analyzeFeedback', 'setFeedbackProvider',
          'submitFeedback', 'copyFeedbackReport', 'openFeedbackLink',
          'openModelFile', 'layoutFinished', 'exportDiagram', 'requestExistingTables', 'requestNewRelationshipFiles',
          // Finding a table elsewhere: they open, select or copy, never write.
          'goToTable', 'showTableOnOtherDiagrams', 'copyTablePath', 'revealTableInLibrary',
          // The onboarding guide: fixed action ids mapped to fixed commands and a fixed URL; writes no file.
          'guide',
          // Usage telemetry only (2.0 B13): a crash's kind and area.
          'webviewError',
          // The crash screen's Reload / Send Feedback: reloads the page or opens Send Feedback; writes nothing.
          'crashFallback',
          // The toolbar's Curved / Hops switch: a view preference (a user setting), not a schema
          // mutation; it writes no project file, and the physical stage draws lines too.
          'setLineStyle',
          // The "not shown" strip: open a file it names, or read every file again. Neither writes.
          'openNotedFile', 'reloadFromDisk',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
          telemetry.error('physicalEditDropped');
          log.warn(`[SemanticEditorProvider] Dropped "${message.type}" while viewing physical stage`);
          this.post(webviewPanel.webview, { type: 'error', payload: { message: PHYSICAL_READ_ONLY_MESSAGE } });
          return;
        }

        // Usage telemetry: one edit request of this kind (EDIT_FEATURES).
        const editFeature = EDIT_FEATURES[message.type];
        if (editFeature) telemetry.feature(editFeature);

        // Mutations always target the logical stage (physical is already guarded above)
        const activeStage = 'logical' as const;

        switch (message.type) {
          case 'ready':
            // `ready` is both the first load and the error screen's Retry, and
            // a Retry always deserves an answer: the webview has already
            // cleared its error, so a suppressed repeat would leave it showing
            // "Loading domain…" for ever.
            this.lastLoadError.delete(panelKey);
            readyWatch.ready();
            {
              // A fresh page (first load, or the crash screen's Reload): not crashed.
              const entry = this.openPanels.get(panelKey);
              if (entry?.webview === webviewPanel.webview) entry.crashed = false;
            }
            {
              const readyAt = Date.now();
              canvasLog.info(`Opening ${document.uri.fsPath}`);
              // Answer at once, before reading anything: the webview's
              // "Canvas disconnected" timer stops, and it says how many
              // tables are loading while a large diagram is read.
              await this.postLoading(document, webviewPanel.webview);
              // How to draw the lines, before the diagram: the first routing pass uses the reader's style.
              this.postLineStyle(webviewPanel.webview);
              // The initial load is the one refresh path allowed to persist
              // auto-computed positions for models that lack them.
              const posted = await this.sendSubjectAreaData(document, webviewPanel.webview, panelKey, { persistPositions: true });
              canvasLog.info(posted === undefined
                ? `Opening ${document.uri.fsPath} ended without a diagram after ${elapsedMs(readyAt)} ms`
                : `Opened ${document.uri.fsPath}: ${plural(posted, 'table')} posted ${elapsedMs(readyAt)} ms after ready`);
              // A large diagram that took long to read (2.0 B17): once a day.
              if (posted !== undefined && slowCanvasLoad(Date.now() - readyAt)) telemetry.featureOnce('canvasLoadOver20s');
              const entry = this.openPanels.get(panelKey);
              if (posted !== undefined && entry?.webview === webviewPanel.webview) {
                entry.loaded = true;
                this.flushPendingReveal(document.uri.fsPath, webviewPanel.webview);
                this.flushPendingTableAction(document.uri.fsPath, panelKey);
                // The onboarding guide's phase B: the first diagram opened after its
                // draft part. Taken before the canvas's own offers, so it holds the
                // window's one prompt and none of them pops over it.
                const guideStart = this.onboardingGuide?.takeCanvas();
                if (guideStart) this.post(webviewPanel.webview, { type: 'guideStart', payload: guideStart });
                // The after-import suggestion offer waits for the guide to end on this canvas.
                if (guideStart) this.guideCanvas = panelKey;
              }
            }
            void this.offerRelationshipPrompts(document, webviewPanel.webview, panelKey);
            break;
          case 'requestExistingTables':
            await this.sendExistingTables(document, webviewPanel.webview);
            break;
          case 'requestNewRelationshipFiles': {
            // Reads only, so it is allowed on the physical stage too.
            const payloadError = validateRequestNewRelationshipFilesPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            this.sendNewRelationshipFiles(document, webviewPanel.webview);
            break;
          }
          case 'requestReload':
            // Webview detected it was orphaned (e.g. extension update before
            // activation auto-recovery could fire). Save & reload safely.
            telemetry.feature('canvasReconnectReload');
            saveAllAndReload('ERD Studio canvas connection lost').catch(err => {
              log.error('[ERD Studio] requestReload handling failed:', err);
            });
            break;
          case 'closeEditor':
            // The "deleted or renamed" screen (#161): the file is gone, so the
            // tab has nothing left to show. No payload to validate; writes
            // nothing, so both are on the physical allowlist.
            webviewPanel.dispose();
            break;
          case 'openAnotherDomain':
            await vscode.commands.executeCommand('erdStudio.openDomain');
            break;
          case 'importEmbeddedTables': {
            // The banner over a DBML diagram that holds its own tables (§2.5):
            // Import DBML on this very file. The command asks before writing.
            const payloadError = validateImportEmbeddedTablesPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            telemetry.feature('dbmlEmbeddedTablesImport');
            await vscode.commands.executeCommand(IMPORT_DBML_COMMAND, document.uri);
            break;
          }
          case 'openNotedFile': {
            // A "not shown" note's file link. Writes nothing, so it is on the physical allowlist.
            const payload = (message as { payload?: unknown }).payload;
            const payloadError = validateOpenNotedFilePayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await this.handleOpenNotedFile(payload as { file: string; line?: number }, webviewPanel.webview, webviewPanel.viewColumn);
            break;
          }
          case 'addRelationshipsImports': {
            // A "not shown" note's Add the import: one edit of this diagram, through the edit pipeline.
            const payloadError = validateAddRelationshipsImportsPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            try {
              await this.handleAddRelationshipsImports(document, webviewPanel.webview);
            } catch (err) {
              const detail = err instanceof Error ? err.message : String(err);
              if (!(err instanceof EditRefused)) logHandlerFailure(`[SemanticEditorProvider] Adding the relationships imports failed: ${detail}`, err);
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add the import: ${detail}` } });
            }
            break;
          }
          case 'reloadFromDisk': {
            // A "not shown" note's Reload from disk: the palette command, which also refreshes the sidebar. Writes nothing.
            const payloadError = validateReloadFromDiskPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await vscode.commands.executeCommand(RELOAD_FROM_DISK_COMMAND);
            break;
          }
          case 'dismissManifestHint': {
            // The webview has already hidden the hint; persisting it is all
            // that is left, so no domain is re-sent.
            const payloadError = validateDismissManifestHintPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await this.context.workspaceState?.update(MANIFEST_HINT_DISMISSED_KEY, true);
            telemetry.featureOnce('manifestHintDismissed');
            break;
          }
          case 'guide': {
            // The onboarding guide (Show Me Around): a fixed action id, rebuilt from
            // its checked fields; the host maps it (src/providers/guideWiring.ts).
            const raw = (message as { payload?: unknown }).payload;
            const payloadError = validateGuidePayload(raw);
            const action = payloadError ? undefined : parseGuideAction(raw);
            if (!action) {
              log.warn(`[SemanticEditorProvider] Ignoring a guide message: ${payloadError ?? 'unknown action'}`);
              break;
            }
            this.onboardingGuide?.onCanvasAction(action);
            if (action.action === 'complete' || action.action === 'skip' || action.action === 'star') this.guideEnded(panelKey);
            break;
          }
          case 'openGettingStarted':
            // No payload to validate. Writes nothing, so it is on the physical allowlist.
            await vscode.commands.executeCommand('erdStudio.showGettingStarted');
            break;
          case 'showLogs':
            // No payload to validate. Opens the ERD Studio output channel; on the physical allowlist.
            await vscode.commands.executeCommand(SHOW_LOGS_COMMAND);
            break;
          case 'exportDiagram': {
            // Writes no domain data and always exports the logical (design)
            // stage, so it is on the physical allowlist. The command asks for
            // the format and the action, and reports its own errors.
            const payloadError = validateExportDiagramPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await vscode.commands.executeCommand(EXPORT_DIAGRAM_COMMAND, document.uri);
            break;
          }
          case 'updatePositions': {
            const payload = (message as Record<string, unknown>).payload as
              | { positions: Record<string, { x: number; y: number }>; annotations?: unknown }
              | undefined;
            if (payload?.positions) {
              const positionsError = validatePositions(payload.positions);
              if (positionsError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to save positions: ${positionsError}` } });
                break;
              }
              const annotations = validateAnnotationPositions(payload.annotations);
              if (typeof annotations === 'string') {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to move annotation: ${annotations}` } });
                break;
              }
              await this.queuePositions(
                panelKey,
                (positions, moved) => this.handleUpdatePositions(document, webviewPanel.webview, positions, moved),
                payload.positions,
                annotations,
              );
            }
            break;
          }
          case 'addModel': {
            const payload = (message as { payload?: AddModelMessage['payload'] }).payload;
            if (payload) {
              telemetry.feature('addModel');
              await this.queueEdit(panelKey, () =>
                this.handleAddModel(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addColumn': {
            const payload = (message as { payload?: { modelName: string; column: ColumnDef } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleAddColumn(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'updateColumn': {
            const payload = (message as { payload?: { modelName: string; oldColumnName: string; column: ColumnDef } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdateColumn(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'removeColumn': {
            const payload = (message as { payload?: { modelName: string; columnName: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveColumn(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'toggleColumnKey': {
            const payload = (message as { payload?: { modelName: string; columnName: string; keyType: 'PK' | 'FK' | 'NK'; value: boolean } }).payload;
            if (payload) {
              if (!isValidKeyType(payload.keyType)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Unknown key type "${String(payload.keyType)}".` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleToggleColumnKey(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addRelationship': {
            const payload = (message as { payload?: AddRelationshipMessage['payload'] }).payload;
            if (payload) {
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              if (!isValidRelationshipRole(payload.role)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: 'Failed to add relationship: the role must be text of at most 60 characters.' } });
                break;
              }
              // extraPairs first: the other two read every pair once it is valid.
              const linkError = validateExtraPairs(payload.extraPairs, payload) ?? validateRelationshipEnds(payload)
                ?? validateMarkKey(payload.markKey, payload) ?? validateRelationshipsFileChoice(payload.relationshipsFile);
              if (linkError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add relationship: ${linkError}` } });
                break;
              }
              telemetry.feature('addRelationship');
              await this.queueEdit(panelKey, () =>
                this.handleAddRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'renameModel': {
            const payload = (message as { payload?: { oldName: string; newName: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleRenameModel(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'removeModel': {
            const payload = (message as { payload?: { modelName: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveModel(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'removeModels': {
            const payload = (message as { payload?: { modelNames: string[] } }).payload;
            if (payload && Array.isArray(payload.modelNames) && payload.modelNames.length > 0) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveModels(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'removeRelationship': {
            const payload = (message as { payload?: RelationshipKey }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'removeRelationships': {
            const payload = (message as { payload?: { relationships: RelationshipKey[] } }).payload;
            if (payload && Array.isArray(payload.relationships) && payload.relationships.length > 0) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveRelationships(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'updateRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleUpdateRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'editRelationship': {
            const payload = (message as { payload?: EditRelationshipMessage['payload'] }).payload;
            if (payload) {
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to edit relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              if (!isValidRelationshipRole(payload.role)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: 'Failed to edit relationship: the role must be text of at most 60 characters.' } });
                break;
              }
              // extraPairs first: the other two read every pair once it is valid.
              const linkError = validateNoRelationshipsFile(payload) ?? validateExtraPairs(payload.extraPairs, payload)
                ?? validateRelationshipEnds(payload) ?? validateMarkKey(payload.markKey, payload);
              if (linkError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to edit relationship: ${linkError}` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleEditRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addExistingModel': {
            const payload = (message as { payload?: { modelName: string; sourcePath?: string } }).payload;
            // A bad name or file path, in the handler's words.
            const payloadError = payload !== undefined ? validateAddExistingModelPayload(payload) : null;
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add table: ${payloadError}` } });
              break;
            }
            if (payload) {
              telemetry.feature('addModel');
              await this.queueEdit(panelKey, () =>
                this.handleAddExistingModel(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addExistingModels': {
            // Logical only, like addExistingModel: not in NON_MUTATION_TYPES.
            const payload = (message as { payload?: unknown }).payload;
            const payloadError = validateAddExistingModelsPayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add tables: ${payloadError}` } });
              break;
            }
            telemetry.feature('addModel');
            const picked = payload as { modelNames: string[]; sourcePaths?: string[] };
            await this.queueEdit(panelKey, () =>
              this.handleAddExistingModels(document, webviewPanel.webview, picked.modelNames, picked.sourcePaths ? { sourcePaths: picked.sourcePaths } : {}));
            break;
          }
          case 'dropTables': {
            // A Shift-drop of Table Library rows or Explorer table files. Logical
            // only, like addExistingModels: not in NON_MUTATION_TYPES.
            const payload = (message as { payload?: unknown }).payload;
            const payloadError = validateDropTablesPayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add the dropped tables: ${payloadError}` } });
              break;
            }
            await this.handleDropTables(document, webviewPanel.webview, panelKey, payload as DropTablesMessage['payload']);
            break;
          }
          case 'addModelsFromDbt': {
            // Logical only: not in NON_MUTATION_TYPES, so the physical guard
            // above has already refused it there. The QuickPick runs outside
            // the edit queue (it can stay open for a while); the edit itself
            // is queued and re-reads the document.
            if (this.logicalOnly) {
              // No dbt project: nothing to list. The webview hides the button;
              // a stale or hand-sent message still gets an answer.
              void vscode.window.showInformationMessage(ADD_FROM_DBT_NEEDS_DBT_MESSAGE);
              break;
            }
            const payloadError = validateAddModelsFromDbtPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add tables from dbt: ${payloadError}` } });
              break;
            }
            await this.handleAddModelsFromDbt(document, webviewPanel.webview, panelKey);
            break;
          }
          case 'refreshManifest': {
            await vscode.commands.executeCommand('erdStudio.refreshManifest');
            break;
          }
          case 'viewFile': {
            // With a position (#186), land the cursor on the JSON mistake the
            // error screen names; the toolbar's View JSON sends none.
            const payload = (message as ViewFileMessage).payload;
            if (payload !== undefined && validateViewFilePayload(payload)) {
              const line = Math.min(payload.line, Math.max(document.lineCount, 1)) - 1;
              const position = new vscode.Position(line, (payload.column ?? 1) - 1);
              await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', {
                selection: new vscode.Range(position, position),
              });
            } else {
              await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            }
            break;
          }
          case 'layoutFinished': {
            // Usage telemetry only; writes nothing, so it is on the physical allowlist.
            const payload = (message as { payload?: unknown }).payload;
            if (validateLayoutFinishedPayload(payload)) {
              telemetry.feature(layoutFeature(payload.ms, payload.ok));
              if (!payload.ok) {
                telemetry.error('layoutFailed');
                if (payload.firstOpen) telemetry.error('firstLayoutFailed');
              }
              // 2.0 B17: the failure's class, the stack-safe fallback, a slow first-open layout.
              const big = canvasLayoutTelemetry(payload);
              for (const code of big.errors) telemetry.error(code);
              for (const feature of big.features) telemetry.feature(feature);
            }
            break;
          }
          case 'webviewError': {
            // Usage telemetry only (2.0 B13): the canvas crashed or hit an
            // uncaught error. Fixed kind and area only; the text stays in the
            // webview. Writes nothing, so it is on the physical allowlist.
            const payload = (message as { payload?: unknown }).payload;
            if (validateWebviewErrorPayload(payload)) {
              for (const code of webviewErrorCodes(payload.kind, payload.area)) telemetry.error(code);
              // A render crash always ends on the crash screen (the page's root boundary).
              if (payload.kind === 'render') this.markCrashed(panelKey, webviewPanel.webview);
            } else {
              log.warn('[SemanticEditorProvider] Ignoring a webviewError with an unknown kind or area');
            }
            break;
          }
          case 'crashFallback': {
            // The crash screen's buttons (CanvasCrashFallback). Writes nothing,
            // so it is on the physical allowlist. Telemetry counts the button only.
            const raw = (message as { payload?: unknown }).payload;
            // A known button with a bad area or detail still works (the button
            // never goes dead); only the extras are dropped.
            const action = (raw as { action?: unknown } | null | undefined)?.action;
            const payload = validateCrashFallbackPayload(raw)
              ? raw
              : isCrashFallbackAction(action) ? { action } : undefined;
            if (!payload) {
              log.warn('[SemanticEditorProvider] Ignoring a crashFallback with an unknown action');
              break;
            }
            if (payload !== raw) log.warn('[SemanticEditorProvider] Dropped a bad area or detail from a crashFallback');
            await this.crashChoice(payload.action, panelKey, webviewPanel, document, crashFeedbackPrefill('canvas', payload));
            break;
          }
          case 'openFieldsFile': {
            // The Detail panel's "Customise fields" link (editor only). Writes
            // nothing: it opens fields.yml, or an unsaved one holding the starting set.
            const payloadError = validateOpenFieldsFilePayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await vscode.commands.executeCommand(CUSTOMISE_FIELDS_COMMAND);
            break;
          }
          case 'openModelFile': {
            // Writes nothing, so it is on the physical allowlist.
            const payload = (message as OpenModelFileMessage).payload;
            const payloadError = validateOpenModelFilePayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to open table file: ${payloadError}` } });
              break;
            }
            await this.handleOpenModelFile(payload.modelName, webviewPanel.webview, document);
            break;
          }
          case 'goToTable': {
            // The search's "Not on this diagram" hint. Writes nothing (physical allowlist).
            const payload = (message as { payload?: unknown }).payload;
            const payloadError = validateGoToTablePayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to open Go to Table: ${payloadError}` } });
              break;
            }
            const query = (payload as { query?: string } | undefined)?.query?.trim();
            await vscode.commands.executeCommand(GO_TO_TABLE_COMMAND, query || undefined);
            break;
          }
          case 'showTableOnOtherDiagrams':
          case 'moveTable':
          case 'copyTablePath':
          case 'revealTableInLibrary': {
            // A table's context menu. Only moveTable writes (it moves files),
            // so it alone is left off the physical allowlist.
            const payload = (message as { payload?: unknown }).payload;
            const payloadError = validateTableActionPayload(payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: payloadError } });
              break;
            }
            await this.handleTableAction(message.type, (payload as { modelName: string }).modelName.trim(), document, webviewPanel.webview);
            break;
          }
          // --- Feedback dialog -------------------------------------------
          // None of these writes a domain file, so all six are allowlisted in
          // NON_MUTATION_TYPES above. `submitFeedback` reports a rejected
          // payload as `feedbackSubmitted { ok: false }` rather than a bare
          // `error`, because the dialog sits over the toast and only clears its
          // busy flag on that reply; the rest take the generic error path.
          case 'requestFeedbackContext': {
            const payload = (message as RequestFeedbackContextMessage).payload;
            const validationError = validateRequestFeedbackContextPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to load feedback context: ${validationError}` },
              });
              break;
            }
            telemetry.feature('feedbackOpened');
            try {
              await this.sendFeedbackContext(webviewPanel.webview, payload);
            } catch (err) {
              hostErrorLog.record('requestFeedbackContext', err);
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: {
                  message: `Failed to load feedback context: ${err instanceof Error ? err.message : String(err)}`,
                },
              });
            }
            break;
          }
          case 'analyzeFeedback': {
            const payload = (message as AnalyzeFeedbackMessage).payload;
            const validationError = validateAnalyzeFeedbackPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to analyse feedback: ${validationError}` },
              });
              break;
            }
            try {
              const result = await analyzeFeedback(this.context, {
                kind: payload.kind,
                kindChosenByUser: payload.kindChosenByUser,
                description: payload.description,
                context: payload.context,
                userInitiated: payload.trigger === 'user',
              });
              this.post(webviewPanel.webview, {
                type: 'feedbackAnalysis',
                payload: { requestId: payload.requestId, ...result },
              });
            } catch (err) {
              // analyzeFeedback is documented not to throw; if it ever does,
              // the dialog still needs a reply or its panel spins forever.
              hostErrorLog.record('analyzeFeedback', err);
              this.post(webviewPanel.webview, {
                type: 'feedbackAnalysis',
                payload: {
                  requestId: payload.requestId,
                  analysis: null,
                  error: 'The analysis could not be completed.',
                },
              });
            }
            break;
          }
          case 'setLineStyle': {
            const payload = (message as SetLineStyleMessage).payload;
            const validationError = validateSetLineStylePayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to change the line style: ${validationError}` },
              });
              break;
            }
            // The webview has already switched. Once the write lands, the
            // configuration listener below tells every open canvas the
            // effective value (a workspace value wins over the user's, and
            // puts this toolbar back); a failed write puts it back here.
            try {
              await writeLineStyle(payload.lineStyle);
            } catch (err) {
              hostErrorLog.record('setLineStyle', err);
              this.postLineStyle(webviewPanel.webview);
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: 'ERD Studio could not save the line style in your settings.' },
              });
            }
            break;
          }
          case 'setFeedbackProvider': {
            const payload = (message as SetFeedbackProviderMessage).payload;
            const validationError = validateSetFeedbackProviderPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to switch the analysis provider: ${validationError}` },
              });
              break;
            }
            try {
              await setAnalysisProviderChoice(payload.provider);
              // Reply with a whole fresh context, not just the new label: the
              // switch can change whether a tier resolves at all and whether
              // the first request has to be asked for by a click, and the
              // dialog reads both from `capabilities`.
              await this.sendFeedbackContext(webviewPanel.webview, {
                webviewErrors: payload.webviewErrors,
                domain: payload.domain,
              });
            } catch (err) {
              hostErrorLog.record('setFeedbackProvider', err);
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: describeProviderWriteFailure(err) },
              });
            }
            break;
          }
          case 'submitFeedback': {
            const payload = (message as SubmitFeedbackMessage).payload;
            const validationError = validateSubmitFeedbackPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'feedbackSubmitted',
                payload: { ok: false, error: validationError },
              });
              break;
            }
            try {
              const result = await submitFeedback(this.context, payload, payload.domain, { previewedLog: this.feedbackLogShown.get(webviewPanel.webview) });
              // The issue is filed in the user's own browser, so all we can
              // record is that a form was opened; the tracker reconciles it
              // against GitHub later. A comment on an existing thread files
              // nothing new and is deliberately not tracked.
              if (result.ok && result.commentedOn === undefined) {
                // Tracking is a convenience on top of a submission that has
                // already happened — a failed globalState write must never be
                // reported back as a failed report.
                try {
                  await this.reportTracking?.recordPending(payload.title, payload.kind);
                } catch (err) {
                  hostErrorLog.record('submitFeedback.recordPending', err);
                }
              }
              // `failure` is host-only; the dialog's message carries the sentence.
              const { ok, commentedOn, error } = result;
              this.post(webviewPanel.webview, {
                type: 'feedbackSubmitted',
                payload: { ok, ...(commentedOn !== undefined ? { commentedOn } : {}), ...(error !== undefined ? { error } : {}) },
              });
            } catch (err) {
              // Never the raw exception (#285): it is recorded for the next report.
              hostErrorLog.record('submitFeedback', err);
              this.post(webviewPanel.webview, {
                type: 'feedbackSubmitted',
                payload: { ok: false, error: reportNotOpenedMessage(false) },
              });
            }
            break;
          }
          case 'copyFeedbackReport': {
            const payload = (message as CopyFeedbackReportMessage).payload;
            const validationError = validateCopyFeedbackReportPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to copy the report: ${validationError}` },
              });
              break;
            }
            try {
              await copyFeedbackReport(this.context, payload, payload.domain, { previewedLog: this.feedbackLogShown.get(webviewPanel.webview) });
            } catch (err) {
              hostErrorLog.record('copyFeedbackReport', err);
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: {
                  message: `Failed to copy the report: ${err instanceof Error ? err.message : String(err)}`,
                },
              });
            }
            break;
          }
          case 'openFeedbackLink': {
            const payload = (message as OpenFeedbackLinkMessage).payload;
            const validationError = validateOpenFeedbackLinkPayload(payload);
            if (validationError) {
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: { message: `Failed to open the link: ${validationError}` },
              });
              break;
            }
            try {
              if (payload.target === 'extension') {
                await vscode.commands.executeCommand(
                  'workbench.extensions.search',
                  '@id:liamwynne.erd-studio',
                );
                break;
              }
              const anchor = payload.comment ? '#issuecomment-new' : '';
              await vscode.env.openExternal(
                vscode.Uri.parse(`https://github.com/${GITHUB_REPO}/issues/${payload.issue}${anchor}`),
              );
            } catch (err) {
              hostErrorLog.record('openFeedbackLink', err);
              this.post(webviewPanel.webview, {
                type: 'error',
                payload: {
                  message: `Failed to open the link: ${err instanceof Error ? err.message : String(err)}`,
                },
              });
            }
            break;
          }
          case 'undo':
          case 'redo': {
            await this.handleUndoRedo(message.type, document, webviewPanel.webview, panelKey);
            break;
          }
          case 'updateModelRationale': {
            const payload = (message as { payload?: { modelName: string; rationale: Rationale } }).payload;
            const rationaleError = validateRationalePayload(payload);
            if (rationaleError || !payload) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update design rationale: ${rationaleError ?? 'Missing payload.'}` } });
              break;
            }
            await this.queueEdit(panelKey, () =>
              this.handleUpdateModelRationale(document, webviewPanel.webview, payload, activeStage));
            break;
          }
          case 'updateModelDescription': {
            const payload = (message as { payload?: { modelName: string; description: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelDescription(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'updateModelGrain': {
            const payload = (message as { payload?: { modelName: string; grain: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelGrain(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'updateModelAlias': {
            const payload = (message as { payload?: { modelName: string; alias: string } }).payload;
            if (payload) {
              const aliasError = validateModelAliasPayload(payload);
              if (aliasError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update warehouse name: ${aliasError}` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelAlias(webviewPanel.webview, document, payload));
            }
            break;
          }
          case 'updateMeta': {
            const payload = (message as { payload?: UpdateMetaMessage['payload'] }).payload;
            const metaError = validateMetaPayload(payload);
            if (metaError || !payload) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update metadata: ${metaError ?? 'Missing payload.'}` } });
              break;
            }
            await this.queueEdit(panelKey, () =>
              this.handleUpdateMeta(webviewPanel.webview, document, payload));
            break;
          }
          case 'updateModelRole': {
            const payload = (message as { payload?: { modelName: string; modelRole: string | null } }).payload;
            if (payload) {
              if (payload.modelRole != null && !isValidTableRole(payload.modelRole)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update table role: unknown role "${String(payload.modelRole)}".` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelRole(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'switchStage': {
            const payload = (message as { payload?: { stage: Stage; requestId?: number } }).payload;
            if (payload) {
              if (!isValidStage(payload.stage)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to switch stage: unknown stage "${String(payload.stage)}".` } });
                break;
              }
              const requestId = typeof payload.requestId === 'number' && Number.isFinite(payload.requestId)
                ? payload.requestId
                : undefined;
              if (payload.stage === 'physical') { telemetry.feature('physicalStage'); telemetry.stage('physical'); }
              await this.handleSwitchStage(panelKey, document, webviewPanel.webview, payload.stage, requestId);
            }
            break;
          }
          case 'toggleDiscrepancy': {
            const payload = (message as { payload?: { enabled: boolean; compareAgainst?: Stage } }).payload;
            if (payload) {
              if (payload.enabled) telemetry.feature('compare');
              await this.handleToggleDiscrepancy(panelKey, document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'generateSyncPlan': {
            const payload = (message as { payload?: { selections: Record<string, GroundTruth> } }).payload;
            if (payload) {
              telemetry.feature('syncPlan');
              await this.handleGenerateSyncPlan(panelKey, document, webviewPanel.webview, payload.selections);
            }
            break;
          }
          case 'runDbtCompile': {
            telemetry.feature('dbtCompile');
            // Awaits only the start; the run's follow-up settles on its own.
            await runDbtCompile(this.workspaceRoot);
            break;
          }
          case 'runDbtParse': {
            // Records the `dbtParse` feature itself; the manifest watcher
            // refreshes this canvas once manifest.json appears, and a parse
            // that wrote it offers Open Physical view for this canvas.
            await runDbtParse(this.workspaceRoot, { origin: document.uri });
            break;
          }
          case 'launchClaudeSync': {
            telemetry.feature('launchClaude');
            await this.handleLaunchClaudeSync();
            break;
          }
          case 'reorderColumns': {
            const payload = (message as { payload?: { modelName: string; orderedNames: string[] } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleReorderColumns(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addAnnotation': {
            const payload = (message as { payload?: { id: string; text: string; x: number; y: number; color?: string } }).payload;
            if (payload) {
              const pointError = validatePoint(payload);
              if (pointError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add annotation: ${pointError}` } });
                break;
              }
              telemetry.feature('annotation');
              await this.queueEdit(panelKey, () =>
                this.handleAddAnnotation(document, webviewPanel.webview, payload));
            }
            break;
          }
          case 'updateAnnotation': {
            const payload = (message as { payload?: { id: string; text?: string; color?: string; linkedModel?: string | null; width?: number; height?: number } }).payload;
            if (payload) {
              const updateError = validateAnnotationUpdate(payload);
              if (updateError) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update annotation: ${updateError}` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleUpdateAnnotation(document, webviewPanel.webview, payload));
            }
            break;
          }
          case 'removeAnnotation': {
            const payload = (message as { payload?: { id: string } }).payload;
            if (payload && typeof payload.id === 'string') {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveAnnotations(document, webviewPanel.webview, { ids: [payload.id] }));
            }
            break;
          }
          case 'removeAnnotations': {
            const payload = (message as { payload?: { ids: string[] } }).payload;
            if (payload && Array.isArray(payload.ids) && payload.ids.length > 0) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveAnnotations(document, webviewPanel.webview, payload));
            }
            break;
          }
          default:
            // A message type this host does not know — most likely webview /
            // host version skew after an update. Log rather than drop silently.
            telemetry.error('messageUnknownType');
            log.warn(`[SemanticEditorProvider] Ignoring unknown webview message type "${message.type}"`);
            break;
        }
      }),
    );

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
      // Cmd+Z / Cmd+Shift+Z on the canvas is VS Code's own undo, not the
      // toolbar's message: it rewinds the domain file and the model files the
      // edit wrote in memory only. Flush them as the toolbar's Undo does.
      const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo
        || e.reason === vscode.TextDocumentChangeReason.Redo;
      // A hold's mark (holdRefreshes) is not this canvas's undo.
      const heldByHold = this.heldPanels.has(panelKey);
      if (this.pendingUpdates.get(panelKey)) {
        const ours = undoRedo && (e.document.uri.toString() === document.uri.toString()
          || (webviewPanel.active && this.editedTablePaths.get(panelKey)?.has(e.document.uri.fsPath)));
        if (!ours) return;
        if (heldByHold) {
          // Pending only because a hold marked it (Convert, a bulk change), not
          // for an edit of this canvas: a native undo/redo it would flush below
          // is flushed when the hold releases, never dropped.
          this.undoWhileHeld.add(panelKey);
        } else if (!this.toolbarUndoRedo.has(panelKey)) {
          // A Cmd+Z while this canvas's own edit or flush is under way (a
          // second Cmd+Z during the first one's save, or one straight after a
          // drag): flushed once that work is done, never dropped. Dropped, it
          // left the documents it rewound dirty. The toolbar's own
          // Undo / Redo flushes what its command rewinds.
          this.scheduleNativeUndoFlush(document, webviewPanel.webview, panelKey);
        }
        return;
      }
      if (e.document.uri.toString() !== document.uri.toString()) {
        // A model file this canvas wrote — while the canvas has focus, so an
        // undo typed in that file's own tab stays the user's to save.
        if (undoRedo && webviewPanel.active && this.editedTablePaths.get(panelKey)?.has(e.document.uri.fsPath)) {
          this.scheduleNativeUndoFlush(document, webviewPanel.webview, panelKey);
        }
        return;
      }
      if (undoRedo) {
        this.scheduleNativeUndoFlush(document, webviewPanel.webview, panelKey);
        return;
      }
      // No text changed: the dirty state did (a save, including the flush's
      // own after an undo). Nothing to save or send again.
      if (e.contentChanges.length === 0) return;
      // A file deleted outside ERD Studio is not saved back into existence (#161).
      if (document.isDirty && fs.existsSync(document.uri.fsPath)) {
        // `save()` resolves false rather than throwing. The canvas is drawn
        // from the file on disk, so an unsaved document is not what it shows:
        // say so on the canvas until the document is saved or reverted.
        const saved = await saveWithoutFormatting(document);
        const entry = this.openPanels.get(panelKey);
        if (entry?.webview === webviewPanel.webview) entry.saveFailed = !saved && document.isDirty;
        if (!saved) log.warn(`[SemanticEditorProvider] ${document.uri.fsPath} could not be saved after a change: the canvas shows the file on disk`);
      }
      // The user (or a tool) just changed this very file: a file that is still
      // broken says so again, even with the message it had before.
      await this.sendSubjectAreaData(document, webviewPanel.webview, panelKey, { reshowError: true });
    });

    // The onboarding trail: the canvas went behind another tab and came back, or closed.
    const viewStateSubscription = webviewPanel.onDidChangeViewState((e) => {
      telemetry.canvasVisible(panelKey, e.webviewPanel.visible);
      readyWatch.visibility(e.webviewPanel.visible);
      if (e.webviewPanel.active && this.openPanels.get(panelKey)?.webview === webviewPanel.webview) {
        this.lastActivePanelKey = panelKey;
        // The safety net under the watchers: a canvas that gets the focus checks it still shows its files.
        void this.revalidateAgainstDisk(panelKey).catch((err) => {
          log.warn(`[SemanticEditorProvider] Check against the disk failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });
    // The line style is the reader's setting: every open canvas follows a change, wherever it was made.
    const lineStyleSubscription = vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsLineStyle(e)) this.postLineStyle(webviewPanel.webview);
    });
    webviewPanel.onDidDispose(() => {
      messageSubscription.dispose();
      changeSubscription.dispose();
      viewStateSubscription.dispose();
      lineStyleSubscription.dispose();
      readyWatch.dispose();
      telemetry.canvasClosed(panelKey);
      this.forgetPanel(panelKey, webviewPanel.webview);
      this.backwardsDrawn.delete(document.uri.toString());
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Extract the logical stage section from parsed domain JSON.
   * Returns a reference — mutations to the returned object mutate the parent.
   */
  private getStageSection(
    parsed: Record<string, unknown>,
    _stage: 'logical',
  ): Record<string, unknown> {
    if (!parsed.logical || typeof parsed.logical !== 'object') {
      parsed.logical = { models: [], relationships: [] };
    }
    return parsed.logical as Record<string, unknown>;
  }

  /**
   * Detect whether a parsed domain document uses v5 format (model name references).
   *
   * Delegates to the shared {@link detectSubjectAreaFormat} so reads and writes agree.
   * Throws for `legacy`/`hybrid` documents so a mutation never silently casts a
   * mixed or pre-v4 file into one branch — every caller runs inside a try/catch
   * that reports the error to the webview.
   */
  private isSubjectAreaV5(parsed: Record<string, unknown>): boolean {
    // A v6 file (#162) is held under the v5 keys: it is edited as v5 and written back as v6.
    if (isTableNamingDocument(parsed)) return true;
    const format = detectSubjectAreaFormat(parsed);
    const unsupported = describeUnsupportedSubjectAreaFormat(format, 'being edited', parsed);
    if (unsupported) {
      throw new Error(unsupported);
    }
    return format === 'v5' || format === 'v6';
  }

  /**
   * Where a table created from this diagram goes. A DBML diagram: its layer
   * `L` and the schema folder `L` as `L/tables/` lists it (case aside), else
   * `L` (§2.4 step 2). A JSON diagram in a project that writes DBML
   * (a mixed one): its layer too, as for a DBML diagram, whatever
   * `groupsByFolder` says of the YAML tables. A JSON diagram whose new
   * tables are YAML: the layer folder, or undefined for the top level — only
   * when the diagram's directory is a configured layer AND the library has
   * opted into layer folders (see `groupsByFolder`).
   */
  private newTableFolder(domainFilePath: string): string | DbmlTableHome | undefined {
    // One rule with the sync plan's new-table paths (syncPlanLibraryLookups).
    return this.tableLibraryService.newTableHomeFor(domainFilePath, new Set(this.layerService.getAllLayers().map((l) => l.id)));
  }

  /** {@link newTableFolder} for a JSON diagram's YAML table: the layer folder, or undefined for the top level (the same rule, `yamlTableFolderFor`). */
  private newYamlTableFolder(domainFilePath: string): string | undefined {
    return this.tableLibraryService.yamlTableFolderFor(domainFilePath, new Set(this.layerService.getAllLayers().map((l) => l.id)));
  }

  /**
   * A table's file relative to the semantic dir, for messages: the file that
   * holds it, else where the project puts a new one (`tables/…/x.dbml` in a
   * DBML project, `logical-models/…/x.yml` or `tables/…/x.yml` in a YAML one).
   */
  private libraryRelativePath(name: string): string {
    const filePath = this.tableLibraryService.findTableFile(name);
    if (filePath) return this.tableLibraryService.libraryRelativePath(filePath);
    try {
      return this.tableLibraryService.libraryRelativePath(this.tableLibraryService.pathForNewTable(name));
    } catch {
      return name;
    }
  }

  /**
   * Apply a mutation to a model stored in logical-models/{name}.yml (v5 path).
   * Reads the model, applies the mutator callback, and writes it back through
   * the same WorkspaceEdit as the domain file so both files form one undo step
   * (see `applySubjectAreaEdit` / `addTableFileEdits`). Nothing touches disk until
   * `vscode.workspace.applyEdit` succeeds.
   *
   * For handlers that also need to modify the domain file (e.g., cascade column rename
   * into relationships), pass a domainMutator callback.
   *
   * Throws if the model is not in the library (callers' catch blocks surface it).
   * Returns false when the WorkspaceEdit was rejected — callers must report that.
   */
  /**
   * Open a model's `logical-models` file in a text editor, with the cursor on
   * its load error when it has one.
   */
  private async handleOpenModelFile(modelName: string, webview: vscode.Webview, document: vscode.TextDocument): Promise<void> {
    let table: CanvasTable;
    try {
      table = this.canvasTable(document, modelName.trim());
    } catch (err) {
      this.post(webview, { type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    // The member's own file (two schema folders may each hold a table of its name), else the table by name.
    const filePath = table.filePath ?? this.tableLibraryService.findTableFile(table.name);
    if (!filePath) {
      this.post(webview, { type: 'error', payload: { message: `Table "${modelName}" not found in the Table Library.` } });
      return;
    }
    const error = table.filePath !== undefined
      ? this.tableLibraryService.getTableFileErrorAt(table.filePath, table.name)
      : this.tableLibraryService.getTableFileError(table.name);
    await openTableFileAt(filePath, error?.line, error?.column);
  }

  /**
   * A table's canvas context menu: Show on Other Diagrams…, Move Table…,
   * Copy Path and Reveal in Table Library. Each acts on the table's library
   * file; a table with none (a dbt model the library does not have) is named
   * in the toast. Only Move Table writes, through its own command.
   */
  private async handleTableAction(
    action: 'showTableOnOtherDiagrams' | 'moveTable' | 'copyTablePath' | 'revealTableInLibrary',
    modelName: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    if (action === 'showTableOnOtherDiagrams') {
      await vscode.commands.executeCommand('erdStudio.openInDiagram', { type: 'model', name: modelName }, { excludeDiagram: document.uri.fsPath });
      return;
    }
    let table: CanvasTable;
    try {
      table = this.canvasTable(document, modelName);
    } catch (err) {
      this.post(webview, { type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    // The member's own file (two schema folders may each hold a table of its name), else the table by name.
    const filePath = table.filePath ?? this.tableLibraryService.findTableFile(table.name);
    if (!filePath) {
      this.post(webview, { type: 'error', payload: { message: `Table "${modelName}" not found in the Table Library.` } });
      return;
    }
    if (action === 'moveTable') {
      await vscode.commands.executeCommand(MOVE_TABLE_COMMAND, filePath);
    } else if (action === 'copyTablePath') {
      const shown = projectRelativePath(this.workspaceRoot, filePath);
      await vscode.env.clipboard.writeText(shown);
      vscode.window.setStatusBarMessage(`ERD Studio: Copied ${shown}`, 4000);
    } else {
      await vscode.commands.executeCommand(REVEAL_IN_TABLE_LIBRARY_COMMAND, table.name);
    }
  }

  /**
   * The one way a handler turns a canvas message's table name into a table
   * (the diagram boundary). Where the library tells tables apart by identity
   * (`schemaScopedNames`) and `document` is a DBML diagram, `text` is
   * resolved among the diagram's own members (`DiagramMemberTable`: its
   * reference, its `<schema>.<name>`, or a bare name one member has), and
   * the table is the file that member's `use` line reads: `id` and
   * `filePath`. Text that names no member is refused ("not on this
   * diagram"). A member whose `use` line names no listed file is named by
   * its bare name, and only while no other table has that name. Anywhere
   * else the text is the table's name, as it always was.
   */
  private canvasTable(document: vscode.TextDocument, text: string): CanvasTable {
    if (!this.schemaScoped() || !this.isDbmlDocument(document)) return { ref: text, name: text, library: text };
    const row = this.parseSubjectAreaFile(document).members?.resolve(text);
    if (!row) throw new EditRefused(`Table "${text}" is not on this diagram.`);
    const filePath = row.path !== undefined && !row.path.startsWith('../') ? this.tableLibraryService.semanticAbsolute(row.path) : undefined;
    const entry = filePath !== undefined ? this.tableLibraryService.tableEntryAt(filePath) : undefined;
    if (entry?.id !== undefined && !entry.shadowedBy) {
      return { ref: row.ref, name: row.name, id: entry.id, filePath: entry.filePath, library: this.tableLibraryService.libraryRef(entry.id) ?? row.name };
    }
    if (row.path !== undefined && this.tableLibraryService.isAmbiguousName(row.name)) {
      throw new EditRefused(`Can't edit "${row.ref}": its file ${row.path} is not in the Table Library, and more than one table is named ${row.name}.`);
    }
    return { ref: row.ref, name: row.name, library: row.name };
  }

  /**
   * The identities of the DBML diagram `document`'s members (the table files
   * their `use` lines read), and the names of members read by name alone.
   */
  private memberIdentities(document: vscode.TextDocument): { ids: Set<string>; names: Set<string> } {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const row of this.parseSubjectAreaFile(document).members?.rows ?? []) {
      if (row.id !== undefined) ids.add(tableIdKey(row.id));
      else names.add(row.name.toLowerCase());
    }
    return { ids, names };
  }

  /**
   * What another diagram calls the canvas table `table` (`storage` its
   * format, `members` its members when it is DBML), for the relationship
   * copies it keeps of its own: told apart by identity, a DBML diagram by
   * the member whose `use` line reads the table's file (undefined where it
   * shows none), a JSON diagram by the table's name only where that name
   * reads this table (the library's first file of it). Anywhere else the
   * name the canvas gave, as always.
   */
  private nameOnOtherDiagram(table: CanvasTable, storage: 'json' | 'dbml', members?: DiagramMemberTable): string | undefined {
    if (table.id === undefined) return table.ref;
    if (storage === 'dbml') return members?.memberOf(table.id)?.ref;
    const byName = this.tableLibraryService.findTableFile(table.name);
    return table.filePath === undefined || (byName !== null && samePath(byName, table.filePath)) ? table.name : undefined;
  }

  /**
   * Refuse an edit from a JSON diagram that names `name` when two schema
   * folders each hold a table of that name (owner decision F): a JSON
   * diagram names tables by name alone, so it cannot say which one to change.
   * The sentence names both schema folders and says where the edit can be made.
   */
  private refuseSharedNameOnJsonDiagram(name: string): void {
    if (!this.tableLibraryService.isAmbiguousName(name)) return;
    const folders = this.tableLibraryService.tablesNamed(name).map((entry) => entry.folder);
    const listed = folders.length > 2 ? `${folders.slice(0, -1).join(', ')} and ${folders[folders.length - 1]}` : folders.join(' and ');
    throw new EditRefused(`Can't change "${name}" from this diagram: the schema folders ${listed} each have a table called ${name}, and a JSON diagram names tables by name alone. Make the change on a DBML diagram that shows the table.`);
  }

  /** Whether the library tells tables apart by identity (a library double without the flag does not). */
  private schemaScoped(): boolean {
    return (this.tableLibraryService as Partial<Pick<import('../services/logicalModelService').TableLibraryService, 'schemaScopedNames'>>).schemaScopedNames === true;
  }

  /** The library model of a canvas table: by its identity where it has one, else by its name. */
  private canvasModel(table: CanvasTable): SemanticTable | null {
    return this.tableLibraryService.getTable(table.id ?? table.name);
  }

  /**
   * Every library table as the library's relationship lookups name it, for
   * the one relationship planner (`planRelationshipWrite`) and the cascades
   * that rewrite other tables' relationships: told apart by identity, each
   * is named by its library reference (`<schema>.<name>` where two schema
   * folders share its name), and `save` turns a model those change back
   * into a save of its own file under its own name (by its identity).
   * Otherwise the library's tables by name, saved by name, as always.
   */
  private libraryTables(): { models: SemanticTable[]; save: (model: SemanticTable) => TableFileSave } {
    if (!this.schemaScoped()) return { models: this.tableLibraryService.listTables(), save: (model) => ({ model }) };
    const ids = new Map<string, TableId>();
    const models: SemanticTable[] = [];
    for (const entry of this.tableLibraryService.listTableFiles()) {
      if (entry.shadowedBy || entry.id === undefined) continue;
      const model = this.tableLibraryService.getTable(entry.id);
      if (!model) continue;
      const ref = this.tableLibraryService.libraryRef(entry.id) ?? model.name;
      ids.set(ref.toLowerCase(), entry.id);
      models.push(ref === model.name ? model : { ...model, name: ref });
    }
    return {
      models,
      save: (model) => {
        const id = ids.get(model.name.toLowerCase());
        return id !== undefined ? { model: { ...model, name: id.name }, from: id } : { model };
      },
    };
  }

  /**
   * The two names of the DBML diagram `document`'s tables, where the library
   * tells tables apart by identity: `toLibrary` turns what the diagram calls a
   * member into what the library's relationships call it, `toDiagram` back.
   * A name that is not a member's passes as it is. Undefined anywhere else
   * (the two names are one).
   */
  private diagramLibraryRefs(document: vscode.TextDocument): { toLibrary: (ref: string) => string; toDiagram: (ref: string) => string } | undefined {
    if (!this.schemaScoped() || !this.isDbmlDocument(document)) return undefined;
    const members = this.parseSubjectAreaFile(document).members;
    if (!members) return undefined;
    const toDiagram = new Map<string, string>();
    const toLibrary = new Map<string, string>();
    for (const row of members.rows) {
      const entry = row.path !== undefined && !row.path.startsWith('../')
        ? this.tableLibraryService.tableEntryAt(this.tableLibraryService.semanticAbsolute(row.path))
        : undefined;
      const library = entry?.id !== undefined && !entry.shadowedBy ? this.tableLibraryService.libraryRef(entry.id) : undefined;
      if (library === undefined) continue;
      if (!toDiagram.has(library.toLowerCase())) toDiagram.set(library.toLowerCase(), row.ref);
      if (!toLibrary.has(row.ref.toLowerCase())) toLibrary.set(row.ref.toLowerCase(), library);
    }
    return {
      toLibrary: (ref) => toLibrary.get(ref.toLowerCase()) ?? toLibrary.get(members.resolve(ref)?.ref.toLowerCase() ?? '') ?? ref,
      toDiagram: (ref) => toDiagram.get(ref.toLowerCase()) ?? ref,
    };
  }

  /**
   * Why a model cannot be edited: its file has a YAML error (the file exists
   * but is broken), else the old "not found" wording.
   */
  private tableUnavailableMessage(modelName: string, table?: CanvasTable): string {
    const error = table?.filePath !== undefined
      ? this.tableLibraryService.getTableFileErrorAt(table.filePath, table.name)
      : this.tableLibraryService.getTableFileError(modelName);
    if (error) {
      const where = error.line !== undefined ? ` on line ${error.line}` : '';
      if (error.kind === 'read') return `Can't edit "${modelName}": its file could not be read.`;
      return error.mergeConflict
        ? `Can't edit "${modelName}": its file has an unresolved git merge conflict${where}.`
        : `Can't edit "${modelName}": its file has a ${error.kind.startsWith('dbml') ? 'DBML' : 'YAML'} error${where}.`;
    }
    return `Table "${modelName}" not found in the Table Library.`;
  }

  /**
   * Whether this project keeps relationships in the model library (#126) —
   * see `usesLibraryRelationships` for the opt-in rule.
   */
  private relationshipsInLibrary(models: readonly SemanticTable[], document?: vscode.TextDocument): boolean {
    // A DBML diagram holds no relationships (D5): they live in the table library.
    if (document && this.isDbmlDocument(document)) return true;
    const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
    return usesLibraryRelationships(
      models,
      this.subjectAreaService.countSubjectAreaFileRelationships(this.workspaceRoot, semanticDir),
      this.tableLibraryService.hasUnreadableRelationships(),
      this.libraryHoldsDbml(),
    );
  }

  /**
   * Whether the table library holds a DBML table or relationships file. A
   * library double without the method (older tests) holds none.
   */
  private libraryHoldsDbml(): boolean {
    const lib = this.tableLibraryService as Partial<Pick<import('../services/logicalModelService').TableLibraryService, 'hasDbmlLibrary'>>;
    return typeof lib.hasDbmlLibrary === 'function' ? lib.hasDbmlLibrary.call(this.tableLibraryService) : false;
  }

  /**
   * Why `name` cannot join the DBML diagram `document`, or null (D20): an
   * existing YAML table cannot (a `use` line cannot point at a `.yml`), and a
   * new table's name must be safe as a file name. Null for a JSON diagram.
   */
  private dbmlMemberProblem(document: vscode.TextDocument, name: string): string | null {
    if (!this.isDbmlDocument(document)) return null;
    const storage = this.tableLibraryService.tableStorage(name);
    if (storage === 'yaml') return `"${name}" is a YAML table, and a DBML diagram can only show DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`;
    return storage === undefined ? validateNewDbmlTableName(name) : null;
  }

  /**
   * The own names of the DBML diagram `document`'s members (`addresse` for a
   * member the diagram calls `ccc.addresse`, because another member has its
   * name), for the lookups that name a changed table by its name alone. Empty
   * for a JSON diagram, and for one that does not parse.
   */
  private dbmlMemberNames(document: vscode.TextDocument): string[] {
    if (!this.isDbmlDocument(document)) return [];
    try {
      return (this.parseSubjectAreaFile(document).members?.rows ?? []).map((row) => row.name);
    } catch {
      return [];
    }
  }

  /** Whether `document` is a DBML diagram (`.dbml`). */
  private isDbmlDocument(document: vscode.TextDocument): boolean {
    return codecFor(document.uri.fsPath).storage === 'dbml';
  }

  /**
   * Relationships an add-models edit would put in this domain file, sent to
   * their from-models' library files instead when the project keeps them
   * there (#126). `newModels` are the models the same edit creates.
   */
  private routeAddedRelationships(
    document: vscode.TextDocument,
    added: readonly Relationship[],
    newModels: readonly SemanticTable[],
  ): { kept: Relationship[]; saves: SemanticTable[]; unstored?: string } {
    if (this.isDbmlDocument(document)) {
      // A DBML diagram holds no relationships (D5): every one goes to the
      // library. One whose many-side table cannot be read has nowhere to go:
      // the edit says so (`unstored`) rather than drop it without a word.
      const { kept, changed } = routeToLibrary(added, newModels, (name) => this.tableLibraryService.getTable(name), []);
      const unstored = describeUnstoredRelationships(kept);
      return { kept: [], saves: [...newModels, ...changed.filter((m) => !newModels.includes(m))], ...(unstored ? { unstored } : {}) };
    }
    if (added.length === 0 || !this.relationshipsInLibrary(this.tableLibraryService.listTables())) {
      return { kept: [...added], saves: [...newModels] };
    }
    // A link another diagram still draws from its own copy stays in this
    // file: a library entry would take that diagram's drawing over (#133).
    const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
    const here = path.resolve(document.uri.fsPath);
    const others = drawnDiagramCopies(readSubjectAreaRelationships(this.subjectAreaService, this.workspaceRoot, semanticDir)
      .filter((d) => path.resolve(d.filePath) !== here));
    const { kept, changed } = routeToLibrary(added, newModels, (name) => this.tableLibraryService.getTable(name), others);
    const saves = [...newModels, ...changed.filter((m) => !newModels.includes(m))];
    return { kept, saves };
  }

  /**
   * Offer an existing project the move to shared relationships (#126): once a
   * session, never after "Don't Ask Again", and only where it helps — the
   * project still keeps relationships per diagram, and at least one of them
   * has its two models together in more than one diagram. Writes nothing; the
   * command it opens explains the move and asks before changing a file.
   */
  private async maybeOfferRelationshipMove(): Promise<boolean> {
    if (this.relationshipMoveOffered) return false;
    this.relationshipMoveOffered = true;
    try {
      if (this.context.workspaceState?.get<boolean>(RELATIONSHIP_MOVE_DECLINED_KEY)) return false;
      if (this.relationshipsInLibrary(this.tableLibraryService.listTables())) return false;
      const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
      const shared = sharedRelationshipCount(readSubjectAreaRelationships(this.subjectAreaService, this.workspaceRoot, semanticDir));
      if (shared === 0) return false;
      telemetry.feature('relMoveOffered');
      const choice = await vscode.window.showInformationMessage(
        `Relationships can now be defined once and shared. ${shared === 1 ? '1 relationship here is' : `${shared} relationships here are`} ` +
        'kept as a separate copy in each diagram that shows it. Move them to the Table Library so each is defined once?',
        'Review the Move…',
        'Not Now',
        "Don't Ask Again",
      );
      if (choice === 'Review the Move…') {
        telemetry.feature('relMoveReview');
        try {
          await vscode.commands.executeCommand('erdStudio.moveRelationshipsToLibrary');
        } catch (err) {
          // The move reports its own failures; anything that escapes it is
          // still the user's to see, never only a console line.
          telemetry.error('relMoveFailed');
          log.error('[SemanticEditorProvider] Move Relationships to Table Library failed:', err);
          // Never the raw exception (#204): the move never started, and the failure is ours.
          const title = 'Move Relationships to Table Library';
          const doing = 'while starting the move';
          const choice = await vscode.window.showErrorMessage(oursMessage(title, doing, 'nothing was changed'), SEND_FEEDBACK_BUTTON, SHOW_LOGS_BUTTON);
          if (choice === SEND_FEEDBACK_BUTTON) {
            void vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(title, doing, err));
          } else if (choice === SHOW_LOGS_BUTTON) {
            void vscode.commands.executeCommand(SHOW_LOGS_COMMAND);
          }
        }
      } else if (choice === "Don't Ask Again") {
        telemetry.feature('relMoveDeclined');
        await this.context.workspaceState?.update(RELATIONSHIP_MOVE_DECLINED_KEY, true);
      } else {
        telemetry.feature('relMoveNotNow');
      }
      // Only the move itself turns backwards copies round; after Not Now the next offer may still ask.
      return choice === 'Review the Move…';
    } catch (err) {
      log.warn('[SemanticEditorProvider] Relationship move offer skipped:', err);
      return false;
    }
  }

  /**
   * The relationship offers a canvas's `ready` may make, one at a time: the
   * move to the model library first — it also turns backwards copies round —
   * and, unless the user chose the move, the offer to turn round this
   * diagram's relationships drawn backwards (#163).
   */
  private async offerRelationshipPrompts(document: vscode.TextDocument, webview: vscode.Webview, panelKey: string): Promise<void> {
    // At most one prompt per canvas open (#182): the DBML conversion's (§6.4)
    // first, then the naming migration's; either, when it is made, leaves
    // #126's and #163's offers for a later open.
    if (await this.maybeOfferDbmlConversion()) return;
    if (await this.maybeOfferNamingMigration()) return;
    if (await this.maybeOfferRelationshipMove()) return;
    // Just imported with no relationships: the suggestion offer, instead of the turn-round one (it has none to offer).
    if (await this.maybeOfferSuggestionsAfterImport(document, panelKey)) return;
    await this.maybeOfferTurnRound(document, webview, panelKey);
  }

  /** Wire the background read of the table library, which steps aside while a canvas is busy. */
  setLibraryWarmUp(warmUp: { noteForegroundWork(): void } | undefined): void {
    this.libraryWarmUp = warmUp;
  }

  /** The onboarding guide's host (Show Me Around, `src/providers/guideWiring.ts`); the extension sets it once. */
  private onboardingGuide: {
    takeCanvas(): CanvasGuideStart | undefined;
    startOnCanvas(): CanvasGuideStart;
    onCanvasAction(action: GuideActionPayload): void;
  } | undefined;

  /** Wire the onboarding guide (phase B runs on a canvas); the extension calls it once. */
  setOnboardingGuide(guide: SemanticEditorProvider['onboardingGuide']): void {
    this.onboardingGuide = guide;
  }

  /**
   * Show Me Around on the active canvas: phase B starts there now. False when
   * no canvas of ours is the active tab, or it has not loaded its diagram yet.
   */
  startGuideOnActiveCanvas(): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom) || !this.onboardingGuide) return false;
    const panel = this.openPanels.get(input.uri.toString());
    if (!panel?.loaded) return false;
    this.post(panel.webview, { type: 'guideStart', payload: this.onboardingGuide.startOnCanvas() });
    return true;
  }

  /** Wire the window session's one-prompt gate; the extension calls it once. */
  setSessionPrompts(gate: { claim(kind: SessionPromptKind): boolean }): void {
    this.sessionPrompts = gate;
  }

  /** Wire Convert Project to DBML's offer (§6.4); the extension calls it once. */
  setDbmlConversion(
    candidates: DbmlConversionHooks['candidates'],
    run: DbmlConversionHooks['run'],
    goesNowhere?: DbmlConversionHooks['goesNowhere'],
  ): void {
    this.dbmlConversion = { candidates, run, ...(goesNowhere ? { goesNowhere } : {}) };
  }

  /**
   * Offer, once a session, to convert a YAML or mixed project to DBML
   * (§6.4), in a modal dialog. Nothing is written without the user's choice:
   * Convert… runs the command, whose panel lists the whole plan. It decides
   * from the file listing alone, so opening a canvas never waits for a plan:
   * not made when there is no YAML table or JSON diagram, when a layer is
   * called `tables` (Convert would refuse), when the last run was refused or
   * left only files to fix and none of the files changed since (a project
   * Convert left mixed is not offered again until they are fixed), after
   * "Don't Ask Again" in this workspace, or with `erdStudio.dbml.offerConvert`
   * off. True when it was shown.
   */
  private async maybeOfferDbmlConversion(): Promise<boolean> {
    const hooks = this.dbmlConversion;
    if (!hooks || this.dbmlConversionOffered) return false;
    this.dbmlConversionOffered = true;
    try {
      const declined = this.context.workspaceState?.get<boolean>(DBML_CONVERSION_DECLINED_KEY) === true;
      const offerSetting = getErdStudioSetting<boolean>(DBML_OFFER_CONVERT_SETTING, true) !== false;
      // Checked before the storage is worked out: a turned-down offer costs nothing.
      if (declined || !offerSetting) return false;
      const storage = this.tableLibraryService.projectStorage();
      if (storage === 'dbml') return false;
      let candidates: DbmlConversionCandidates = { files: 0, tablesDirIsLayer: false };
      // The rule activation's opening notice uses too (src/services/convertOffer.ts).
      if (!convertOfferApplies({
        storage, declined, offerSetting,
        candidates: () => (candidates = hooks.candidates()),
        goesNowhere: () => hooks.goesNowhere?.() === true,
      })) return false;
      this.dbmlConversionEligible = true;
      // Another prompt already showed in this window: ask in the next one.
      if (this.sessionPrompts && !this.sessionPrompts.claim('dbmlConversion')) return false;
      telemetry.feature('convertToDbmlOffered');
      const message = dbmlConversionOfferDetail(storage, candidates.files);
      // A dialog the user must answer (after pre-release 1.9.0): VS Code adds
      // its own Cancel, and Cancel, Escape or closing it is Not Now.
      const choice = await vscode.window.showInformationMessage(
        DBML_CONVERSION_OFFER_TITLE,
        { modal: true, detail: message },
        DBML_CONVERSION_OFFER_CONVERT,
        DBML_CONVERSION_OFFER_DECLINE,
      );
      if (choice === DBML_CONVERSION_OFFER_CONVERT) {
        await hooks.run();
      } else if (choice === DBML_CONVERSION_OFFER_DECLINE) {
        telemetry.feature('convertToDbmlDeclined');
        await this.context.workspaceState?.update(DBML_CONVERSION_DECLINED_KEY, true);
      } else {
        telemetry.feature('convertToDbmlNotNow');
      }
      return true;
    } catch (err) {
      log.warn('[SemanticEditorProvider] DBML conversion offer skipped:', err);
      return false;
    }
  }

  /** Wire the naming migration's offer (#182); the extension calls it once. */
  setNamingMigration(
    plan: NamingMigrationHooks['plan'],
    naming: NamingMigrationHooks['naming'],
    run: NamingMigrationHooks['run'],
    version: string,
  ): void {
    this.namingMigration = { plan, naming, run, version };
  }

  /**
   * Hold every open canvas's refresh while the naming migration applies
   * (#182): half-way through, a table can be in both folders or in neither,
   * and a canvas redrawn then would warn about it. The returned function
   * lets them refresh again; the migration then redraws each once. It
   * returns whether a canvas refresh was asked for while this hold was open:
   * a holder that does not redraw on its own (the watcher's bulk change,
   * whose burst may be another command's own writes) redraws when it was.
   */
  holdRefreshes(): () => boolean {
    const held = [...this.openPanels.keys()].filter((key) => !this.pendingUpdates.get(key));
    for (const key of held) {
      this.pendingUpdates.set(key, true);
      this.heldPanels.add(key);
    }
    // Watcher-driven refreshes and the duplicate warning wait too: they read
    // the disk half-way through, when a converted table's .yml and .dbml
    // both exist, and a warning shown then is never taken back.
    this.refreshHolds++;
    const droppedAtHold = this.droppedRefreshes;
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      this.refreshHolds--;
      for (const key of held) {
        this.pendingUpdates.delete(key);
        this.heldPanels.delete(key);
        // A Cmd+Z on this canvas while held (a bulk change can start under
        // any edit): flushed now, as it would have been then.
        const open = this.undoWhileHeld.delete(key) ? this.openPanels.get(key) : undefined;
        if (open && !this.disposedWebviews.has(open.webview)) this.scheduleNativeUndoFlush(open.document, open.webview, key);
      }
      return this.droppedRefreshes > droppedAtHold;
    };
  }

  /**
   * Offer, once a session, to move a v5 or mixed project to the new file
   * naming (#182). Nothing is written without the user's choice: Review
   * opens the command's dialog, which shows the whole plan. Not made when the
   * migration would be refused (a layer called `tables`, a name in both
   * libraries…): the command says why when it is run. True when the offer
   * was shown, whatever the answer.
   */
  private async maybeOfferNamingMigration(): Promise<boolean> {
    const hooks = this.namingMigration;
    if (!hooks || this.namingMigrationOffered) return false;
    // Never in a session where the DBML conversion was offered (§6.4).
    if (this.dbmlConversionEligible) return false;
    this.namingMigrationOffered = true;
    try {
      if (this.context.workspaceState?.get<boolean>(NAMING_MIGRATION_DECLINED_KEY)) return false;
      if (hooks.naming() === 'v6') return false;
      // A DBML or mixed project is not offered the YAML naming migration (§5.7).
      if (this.tableLibraryService.projectStorage() !== 'yaml') return false;
      const plan = hooks.plan();
      // A v4 file is no refusal here: the command runs the v5 migration first.
      const refused = plan.v4SubjectAreas.length > 0 ? plan.refusals.length > 1 : plan.refusals.length > 0;
      if (refused || (namingMigrationIsEmpty(plan) && plan.v4SubjectAreas.length === 0)) return false;
      // Another prompt already showed in this window: ask in the next one.
      if (this.sessionPrompts && !this.sessionPrompts.claim('namingMigration')) return false;
      const choice = await vscode.window.showInformationMessage(
        'ERD Studio now says "table" where it said "model", and this project\'s files can say so too: .erd-studio/tables/ ' +
          `instead of logical-models/, "subjectArea" instead of "domain". Teammates will need ERD Studio ${hooks.version} or later ` +
          'to open the files afterwards. Review the migration?',
        'Review the Migration…',
        'Not Now',
        "Don't Ask Again",
      );
      if (choice === 'Review the Migration…') {
        await hooks.run();
      } else if (choice === "Don't Ask Again") {
        await this.context.workspaceState?.update(NAMING_MIGRATION_DECLINED_KEY, true);
      }
      return true;
    } catch (err) {
      log.warn('[SemanticEditorProvider] Naming migration offer skipped:', err);
      return false;
    }
  }

  /**
   * Offer to turn round the relationships in this diagram that look drawn
   * backwards (#163, `keysContradictedRelationships`): once a session, never
   * after "Don't Ask Again", on the logical stage only. Writes nothing until
   * the user picks; **Turn Round** (all) and **Review…** (those ticked) are
   * one edit and one undo step, through `commitRelationshipWrite`.
   */
  private async maybeOfferTurnRound(document: vscode.TextDocument, webview: vscode.Webview, panelKey: string): Promise<void> {
    if (this.relationshipBackwardsOffered) return;
    try {
      if (this.context.workspaceState?.get<boolean>(RELATIONSHIP_BACKWARDS_DECLINED_KEY)) return;
      if (this.openPanels.get(panelKey)?.activeStage === 'physical') return;
      const groups = this.backwardsRelationshipGroups(document);
      if (groups.length === 0) return;
      this.relationshipBackwardsOffered = true;
      const one = groups.length === 1;
      const choice = await vscode.window.showInformationMessage(
        `${one ? '1 relationship in this diagram looks' : `${groups.length} relationships in this diagram look`} drawn backwards ` +
        `(${one ? 'it starts' : 'they start'} at a table's key). Turn ${one ? 'it' : 'them'} round?`,
        'Turn Round',
        'Review…',
        'Not Now',
        "Don't Ask Again",
      );
      let chosen: Relationship[][] = [];
      if (choice === 'Turn Round') {
        chosen = groups;
      } else if (choice === 'Review…') {
        const picked = await vscode.window.showQuickPick(
          groups.map((members) => ({
            label: `${members[0].fromModel}.${members.map((m) => m.fromColumn).join(', ')} \u2192 ${members[0].toModel}.${members.map((m) => m.toColumn).join(', ')}`,
            detail: backwardsRelationshipNote(members[0], members),
            picked: true,
            members,
          })),
          { canPickMany: true, title: 'Turn these relationships round', placeHolder: 'Untick any you drew this way on purpose' },
        );
        chosen = (picked ?? []).map((item) => item.members);
      } else if (choice === "Don't Ask Again") {
        await this.context.workspaceState?.update(RELATIONSHIP_BACKWARDS_DECLINED_KEY, true);
      }
      // The toast may have waited a while: turn round only what the canvas still draws backwards, as it was.
      const still = new Set(this.backwardsRelationshipGroups(document).map((members) => backwardsGroupId(members)));
      chosen = chosen.filter((members) => still.has(backwardsGroupId(members)));
      if (chosen.length === 0) return;
      // ⇄ on each: a backwards many-to-one becomes the one-to-many it reads as, stored the right way round.
      const ops: RelationshipWriteOp[] = chosen.map((members) => ({
        kind: 'update',
        ends: { fromModel: members[0].fromModel, fromColumn: members[0].fromColumn, toModel: members[0].toModel, toColumn: members[0].toColumn },
        cardinality: members[0].cardinality === 'many-to-one' ? 'one-to-many' : 'many-to-one',
      }));
      await this.queueEdit(panelKey, async () => {
        // Set once VS Code applies the edit: a library-only turn round leaves this diagram's text (and version) as it was.
        let applied = false;
        try {
          await this.commitRelationshipWrite(
            document, webview, ops, 'logical',
            "Couldn't turn the relationships round: VS Code didn't accept the change, so nothing was changed.",
            () => { applied = true; },
          );
        } catch (err) {
          this.recordRelationshipFailure(err);
          if (isExplainedRefusal(err)) {
            // A refusal already says, in plain words, what in the user's files stopped it.
            const message = err instanceof Error ? err.message : String(err);
            webview.postMessage({ type: 'error', payload: { message: `Couldn't turn the relationships round: ${message}` } });
            return;
          }
          // Anything else is ours (#219): never the raw exception, which goes to the log and the report.
          log.error('[SemanticEditorProvider] Turn round failed:', err);
          const doing = applied ? 'after turning the relationships round' : 'while turning the relationships round';
          // Not awaited: the edit queue must not wait on the toast.
          showErrorWithActions(
            (m, ...items) => vscode.window.showErrorMessage(m, ...items),
            applied
              ? 'Turning the relationships round hit a problem in ERD Studio, not in your diagram. The change was made; Edit > Undo puts it back.'
              : "Couldn't turn the relationships round: that's a problem in ERD Studio, not your diagram. Nothing was changed.",
            { [SEND_FEEDBACK_BUTTON]: () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill('Turn Round', doing, err)) },
            (choice, actionErr) => log.error(`[SemanticEditorProvider] Turn Round: "${choice}" failed:`, actionErr),
          );
        }
      });
    } catch (err) {
      log.warn('[SemanticEditorProvider] Turn-round offer skipped:', err);
    }
  }

  // --- Suggest Relationships (src/providers/suggestRelationshipsFlow.ts) ---

  /** The review's UI; a test swaps in a fake ({@link useSuggestionUi}). */
  private suggestionUi: SuggestRelationshipsUi = vscodeSuggestRelationshipsUi();
  /** Diagrams an import just wrote, by path, waiting for their canvas's `ready` to make the offer once. */
  private readonly pendingSuggestionOffers = new Map<string, number>();
  /** Diagrams offered suggestions this session: never twice. */
  private readonly suggestionsOffered = new Set<string>();
  /** The canvas the onboarding guide (phase B) started on, and the offer held back until it ends there. */
  private guideCanvas?: string;
  private offerAfterGuide?: string;

  /** Swap the review's UI (tests). */
  useSuggestionUi(ui: SuggestRelationshipsUi): void {
    this.suggestionUi = ui;
  }

  /**
   * ERD Studio: Suggest Relationships… on the diagram `uri` (the editor title
   * menu passes it), else the active canvas. The physical stage writes
   * nothing. Every accepted relationship goes through
   * `commitRelationshipWrite` in the diagram's edit queue: one
   * WorkspaceEdit, one save, one undo step.
   */
  async suggestRelationships(uri?: vscode.Uri): Promise<SuggestOutcome | 'noCanvas'> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const panelKey = uri ? uri.toString() : input instanceof vscode.TabInputCustom ? input.uri.toString() : undefined;
    const panel = panelKey ? this.openPanels.get(panelKey) : undefined;
    const ui = this.suggestionUi;
    if (!panelKey || !panel) {
      ui.info(NO_CANVAS_MESSAGE);
      return 'noCanvas';
    }
    const { document, webview } = panel;
    return runSuggestRelationships({
      stage: panel.activeStage,
      dbt: !this.logicalOnly,
      ui,
      read: () => this.readForSuggestions(document),
      inQueue: (fn) => this.queueEdit(panelKey, fn),
      write: async (ops) => {
        let applied = false;
        try {
          const written = await this.commitRelationshipWrite(
            document, webview, ops, 'logical',
            "Couldn't add the suggested relationships: VS Code didn't accept the change, so nothing was changed.",
            () => { applied = true; },
          );
          return written !== null;
        } catch (err) {
          this.recordRelationshipFailure(err);
          if (isExplainedRefusal(err)) {
            // The planner's or the writer's refusal, in plain words: nothing was written.
            ui.error(notAddedMessage(err instanceof Error ? err.message : String(err)));
            return false;
          }
          // Anything else is ours (#219): never the raw exception, which goes to the log and the report.
          log.error('[SemanticEditorProvider] Suggest Relationships failed:', err);
          const doing = applied ? 'after adding the suggested relationships' : 'while adding the suggested relationships';
          showErrorWithActions(
            (m, ...items) => vscode.window.showErrorMessage(m, ...items),
            applied
              ? 'Adding the suggested relationships hit a problem in ERD Studio, not in your diagram. The change was made; Edit > Undo takes it back.'
              : "Couldn't add the suggested relationships: that's a problem in ERD Studio, not your diagram. Nothing was changed.",
            { [SEND_FEEDBACK_BUTTON]: () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill('Suggest Relationships', doing, err)) },
            (choice, actionErr) => log.error(`[SemanticEditorProvider] Suggest Relationships: "${choice}" failed:`, actionErr),
          );
          return false;
        }
      },
    });
  }

  /**
   * What the engine reads for one diagram, as it is now: its tables
   * (unreadable ones left out) and the relationships it draws, with dbt's key
   * evidence and relationships tests in a dbt project — the same cached reads
   * the canvas and every relationship write already make.
   */
  private async readForSuggestions(document: vscode.TextDocument): Promise<SuggestionRead> {
    const fsPath = document.uri.fsPath;
    const fileName = path.basename(fsPath).replace(/\.(json|dbml)$/i, '');
    try {
      const dbtKeyIndex = await this.loadDbtKeyIndex();
      const domain = this.subjectAreaService.getSubjectArea(fsPath, { dbtKeyIndex });
      let dbtTests: ReturnType<typeof dbtTestsOf>['relationshipTests'] = [];
      if (!this.logicalOnly) {
        try {
          const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
          const manifest = await this.manifestService.loadManifest(this.workspaceRoot).catch(() => undefined);
          dbtTests = dbtTestsOf(ymlData, manifest).relationshipTests;
        } catch (err) {
          log.warn(`[SemanticEditorProvider] Suggest Relationships: dbt's tests not read: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return {
        ok: true,
        diagramName: domain.domain || fileName,
        tables: domain.logical.models.filter((t) => !tableLoadErrorOf(t)),
        relationships: domain.logical.relationships ?? [],
        dbtKeyIndex,
        dbtTests,
      };
    } catch (err) {
      return { ok: false, message: unreadableDiagramMessage(fileName, err instanceof Error ? err.message : String(err)) };
    }
  }

  /**
   * An import's Keep wrote `domainPath` and is opening it: when its canvas
   * says `ready`, offer the review once (the import itself writes no
   * suggestion). Never on a plain open.
   */
  offerSuggestionsWhenOpened(domainPath: string): void {
    this.pendingSuggestionOffers.set(path.resolve(domainPath), Date.now());
  }

  /**
   * The after-import offer, from a canvas's `ready`: once per diagram per
   * session, never after Don't Ask Again, only on the logical stage of a
   * diagram with no relationship and at least one suggestion that is likely
   * or stronger. Held back while the onboarding guide runs on this canvas.
   * True when it took this open's one prompt.
   */
  private async maybeOfferSuggestionsAfterImport(document: vscode.TextDocument, panelKey: string): Promise<boolean> {
    const fsPath = path.resolve(document.uri.fsPath);
    const at = this.pendingSuggestionOffers.get(fsPath);
    if (at === undefined) return false;
    this.pendingSuggestionOffers.delete(fsPath);
    if (Date.now() - at > PENDING_REVEAL_MS) return false;
    if (this.guideCanvas === panelKey) {
      // Held back only when there could be an offer: a diagram that already has relationships
      // never gets one, so this open's other prompt (Turn Round) goes ahead as it would without the import.
      const read = await this.readForSuggestions(document);
      if (!read.ok || read.relationships.length > 0) return false;
      this.offerAfterGuide = panelKey;
      return true;
    }
    return this.showSuggestionOffer(document, panelKey);
  }

  /** The guide ended on `panelKey`: a suggestion offer it held back is made now. */
  private guideEnded(panelKey: string): void {
    if (this.guideCanvas === panelKey) this.guideCanvas = undefined;
    if (this.offerAfterGuide !== panelKey) return;
    this.offerAfterGuide = undefined;
    const panel = this.openPanels.get(panelKey);
    if (panel) void this.showSuggestionOffer(panel.document, panelKey);
  }

  private async showSuggestionOffer(document: vscode.TextDocument, panelKey: string): Promise<boolean> {
    const fsPath = path.resolve(document.uri.fsPath);
    try {
      if (this.suggestionsOffered.has(fsPath)) return false;
      if (this.context.workspaceState?.get<boolean>(RELATIONSHIP_SUGGESTIONS_DECLINED_KEY)) return false;
      if (this.openPanels.get(panelKey)?.activeStage !== 'logical') return false;
      const read = await this.readForSuggestions(document);
      if (!read.ok) return false;
      const suggestions = computeSuggestions(read);
      if (!offerAfterImport(read.relationships.length, suggestions)) return false;
      this.suggestionsOffered.add(fsPath);
      // Not awaited: the canvas's `ready` must not wait on the toast.
      void Promise.resolve(vscode.window.showInformationMessage(
        importOfferMessage(offerCount(suggestions)), REVIEW_SUGGESTIONS_BUTTON, NOT_NOW_BUTTON, DONT_ASK_AGAIN_BUTTON,
      )).then(async (choice) => {
        if (choice === REVIEW_SUGGESTIONS_BUTTON) await this.suggestRelationships(document.uri);
        else if (choice === DONT_ASK_AGAIN_BUTTON) await this.context.workspaceState?.update(RELATIONSHIP_SUGGESTIONS_DECLINED_KEY, true);
      }).catch((err: unknown) => log.warn('[SemanticEditorProvider] The suggestion offer failed:', err));
      return true;
    } catch (err) {
      log.warn('[SemanticEditorProvider] Suggestion offer skipped:', err);
      return false;
    }
  }

  /** This diagram's relationships drawn backwards, a composite's members together, as its canvas last drew them. */
  private backwardsRelationshipGroups(document: vscode.TextDocument): Relationship[][] {
    const groups = new Map<string, Relationship[]>();
    for (const rel of this.backwardsDrawn.get(document.uri.toString()) ?? []) {
      const id = rel.compositeKey ? [rel.fromModel, rel.toModel, rel.compositeKey].join('\u0000').toLowerCase() : `\u0001${groups.size}`;
      groups.set(id, [...(groups.get(id) ?? []), rel]);
    }
    return [...groups.values()];
  }


  /**
   * What dbt's tests say about keys (#133 L1), from the cached yml and
   * manifest. Never throws: without dbt it is empty, and only flags count.
   */
  private async loadDbtKeyIndex(): Promise<DbtKeyIndex> {
    try {
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot).catch(() => undefined);
      return dbtKeyIndexOf(ymlData, manifest);
    } catch {
      return EMPTY_DBT_KEY_INDEX;
    }
  }

  /** Every library model except `exclude`, fresh copies an edit may change. */
  private otherLibraryTables(exclude: string): SemanticTable[] {
    return this.tableLibraryService.listTables().filter((m) => !sameName(m.name, exclude));
  }

  /**
   * The saves of a cascade over every library table but `exclude` (the
   * relationships of other tables that point at it): `change` is given the
   * other tables named as the library's relationships name them
   * ({@link libraryTables}) and returns the ones it changed, each saved as
   * its own file.
   */
  private otherLibrarySaves(exclude: CanvasTable, change: (others: SemanticTable[]) => SemanticTable[]): TableFileSave[] {
    const library = this.libraryTables();
    return change(library.models.filter((m) => !sameName(m.name, exclude.library))).map(library.save);
  }

  /**
   * Run `change` over `model` (the canvas table `table`, as the library
   * read it, under its own name) named as the library's relationships name
   * it (`table.library`: `<schema>.<name>` where another schema folder has a
   * table of its name), so its own relationships are matched by the same
   * name as every other table's; their changes are kept on `model`.
   */
  private asLibraryNamed(model: SemanticTable, table: CanvasTable, change: (named: SemanticTable) => void): void {
    if (sameName(model.name, table.library)) {
      change(model);
      return;
    }
    const named: SemanticTable = { ...model, name: table.library };
    change(named);
    if (named.relationships) model.relationships = named.relationships;
    else delete model.relationships;
  }

  private async applyTableEdit(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelName: string,
    modelMutator: (model: import('../types/semantic').SemanticTable) => void,
    domainMutator?: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    /** Other library models changed alongside (relationships pointing at this one), each a model or its save. */
    alsoSave: ReadonlyArray<SemanticTable | TableFileSave> = [],
    /** Other diagrams' own relationship copies to rewrite in the same edit (see applySubjectAreaEdit). */
    otherDomains?: (parsed: Record<string, unknown>, storage: 'json' | 'dbml', members?: DiagramMemberTable) => boolean,
  ): Promise<boolean> {
    // The member's own file (two schema folders may each hold a table of its name), saved by its identity.
    const table = this.canvasTable(document, modelName);
    // A JSON diagram names tables by name alone (owner decision F): it reads the library's first file of a
    // shared name, and an edit that would have to pick between them is refused.
    if (this.schemaScoped() && !this.isDbmlDocument(document)) this.refuseSharedNameOnJsonDiagram(table.name);
    const model = this.canvasModel(table);
    if (!model) {
      throw new Error(this.tableUnavailableMessage(modelName, table));
    }

    modelMutator(model);

    // Even when there is no domain-level change, the domain document is still
    // re-written (with identical content) so its undo stack gains an element
    // grouped with the yml edit — the custom editor's undo/redo operate on the
    // domain resource, and the group pulls the yml change along with it.
    return this.applySubjectAreaEdit(
      document,
      domainMutator ?? (() => { /* no domain change */ }),
      {
        refreshWebview: true,
        webview,
        stage: 'logical',
        modelFiles: { save: [{ model, ...(table.id ? { from: table.id } : {}) }, ...alsoSave.map((other) => ('model' in other ? other : { model: other }))] },
        ...(otherDomains ? { otherDomains } : {}),
      },
    );
  }

  /**
   * Add logical-models/*.yml operations to a WorkspaceEdit so they are applied
   * (and undone / redone) together with the domain file change.
   *
   * - Existing files are replaced in full via their TextDocument (text edit).
   * - New files are created with contents (file edit).
   * - Deletions use deleteFile (VS Code snapshots the content for undo).
   *
   * A save may name a different `fromName` (renames): the YAML text is then
   * rendered from the OLD file's document, so comments, key order and unknown
   * keys travel to the new file instead of being regenerated away.
   *
   * Returns the TextDocuments that were edited in place (so the caller can
   * save them after `applyEdit` succeeds — new/deleted files need no save)
   * plus the paths created and deleted, which the caller records as own writes.
   *
   * Where a NEW file goes: a rename keeps the old file's folder; any other new
   * model lands in `logical-models/{layerFolder}/` — the layer of the domain
   * being edited — when the caller passes one (only once the library already
   * uses folders), else at the top level. An existing file is always edited
   * where it already is.
   */
  private async addTableFileEdits(
    edit: vscode.WorkspaceEdit,
    ops: TableFileOps | undefined,
    layerFolder?: string,
  ): Promise<{ docs: vscode.TextDocument[]; created: string[]; deleted: string[] }> {
    const docs: vscode.TextDocument[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    if (!ops) return { docs, created, deleted };

    // A YAML project's tables are named by name (a TableId names a DBML table, which never reaches here).
    for (const name of (ops.delete ?? []).filter((d): d is string => typeof d === 'string')) {
      if (!this.tableLibraryService.tableExists(name)) continue;
      const deletePath = this.tableLibraryService.tablePath(name);
      edit.deleteFile(vscode.Uri.file(deletePath), { ignoreIfNotExists: true });
      deleted.push(deletePath);
    }

    for (const { model, fromName } of ops.save ?? []) {
      // A renamed file stays in its own library and folder (#182).
      const renamed = fromName !== undefined && fromName !== model.name;
      const modelPath = renamed
        ? this.tableLibraryService.renamedTablePath(fromName, model.name)
        : this.tableLibraryService.tablePath(model.name, layerFolder);
      const uri = vscode.Uri.file(modelPath);
      const yamlText = this.tableLibraryService.serializeTable(model, fromName);
      if (this.tableLibraryService.tableExists(model.name)) {
        const modelDoc = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(
          modelDoc.positionAt(0),
          modelDoc.positionAt(modelDoc.getText().length),
        );
        edit.replace(uri, range, yamlText);
        docs.push(modelDoc);
      } else {
        this.tableLibraryService.ensureDir(modelPath);
        edit.createFile(uri, { overwrite: false, contents: Buffer.from(yamlText, 'utf-8') });
        created.push(modelPath);
      }
    }

    return { docs, created, deleted };
  }

  /** The library path of a model file `ops` would rewrite or delete that is open with unsaved edits. */
  private dirtyTableFile(ops: TableFileOps | undefined): string | null {
    const names = [
      ...(ops?.delete ?? []).filter((d): d is string => typeof d === 'string'),
      ...(ops?.save ?? []).flatMap(({ model, fromName }) => (fromName ? [model.name, fromName] : [model.name])),
    ];
    for (const name of names) {
      // The file addTableFileEdits would replace, read from or delete.
      if (!this.tableLibraryService.tableExists(name)) continue;
      const filePath = this.tableLibraryService.tablePath(name);
      if (dirtyFiles([filePath]).length > 0) {
        return this.tableLibraryService.libraryRelativePath(filePath);
      }
    }
    return null;
  }

  /**
   * After an undo/redo the in-memory yml documents we edited via WorkspaceEdit
   * are reverted but dirty; SubjectAreaService reads the library from disk, so
   * flush them before re-rendering.
   *
   * ONLY documents this provider itself wrote through a WorkspaceEdit for this
   * domain are saved (`editedTablePaths`). A logical-models/*.yml the user has
   * open in another tab with unsaved hand edits is never force-saved — those
   * bytes are theirs to keep or discard.
   *
   * Returns the paths that could not be saved (and, in `saved`, those that were).
   */
  private async saveDirtyTableDocuments(
    panelKey: string,
    onFailure: (reason: SaveFailure) => void,
    saved: string[] = [],
  ): Promise<string[]> {
    const ourPaths = new Set(this.editedTablePaths.get(panelKey) ?? []);
    if (ourPaths.size === 0) return [];
    const unsaved: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!ourPaths.has(doc.uri.fsPath)) continue;
      if (!doc.isDirty) continue;
      if (await saveDocument(doc, onFailure)) {
        this.ownWriteTracker.recordWrite(doc.uri.fsPath);
        saved.push(doc.uri.fsPath);
      } else {
        unsaved.push(doc.uri.fsPath);
      }
    }
    return unsaved;
  }

  /**
   * Undo / redo requested from the webview toolbar.
   *
   * `pendingUpdates` is held for the whole operation so the
   * `onDidChangeTextDocument` listener (which fires while VS Code rewinds the
   * document) does not save + re-send on its own — this handler is the single
   * save and the single `domainLoaded` for an undo/redo.
   */
  private async handleUndoRedo(
    command: 'undo' | 'redo',
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey: string,
  ): Promise<void> {
    this.refuseIfSubjectAreaFileGone(document);
    this.pendingUpdates.set(panelKey, true);
    try {
      // What this command rewinds is flushed just below; a Cmd+Z that
      // arrives during that flush is the user's and gets its own.
      this.toolbarUndoRedo.add(panelKey);
      try {
        await vscode.commands.executeCommand(command);
      } finally {
        this.toolbarUndoRedo.delete(panelKey);
      }
      await this.flushUndoRedo(document, webview, panelKey);
    } finally {
      this.pendingUpdates.delete(panelKey);
    }
  }

  /**
   * After an undo/redo has rewound the documents: save the domain file and
   * the model files this canvas wrote, then redraw — one refresh for the step.
   */
  private async flushUndoRedo(document: vscode.TextDocument, webview: vscode.Webview, panelKey: string): Promise<void> {
    // Cmd+Z on a canvas whose file was deleted outside ERD Studio rewinds the
    // document in memory only; saving it would recreate the file (#161).
    if (!fs.existsSync(document.uri.fsPath)) return;
    // A save that fails is reported, never ignored, as after a canvas edit (#126).
    const saveFailures = new Set<SaveFailure>();
    const onSaveFailure = (reason: SaveFailure) => saveFailures.add(reason);
    const unsaved: string[] = [];
    const expected = [document.uri.fsPath, ...(this.editedTablePaths.get(panelKey) ?? [])];
    const isDbml = this.isDbmlDocument(document);
    const diskText = isDbml ? this.diskTextOf(document.uri.fsPath) : undefined;
    // The undo of a drag rewinds the diagram's erd_layout and nothing else
    // (a minimal-range edit of the diagram alone): nothing the library or
    // the trees show changed.
    const layoutOnlyRewind = isDbml && diskText !== undefined
      && sameOutsideErdLayout(diskText, document.getText());
    // An undo VS Code refused across files ("Could not undo 'Workspace Edit'
    // across all files because changes were made to …") is split, not
    // dropped: VS Code rewinds this diagram's own part alone. When that is a
    // one-character anchor, its text stays as on disk (and the document
    // dirty): nothing the canvas, the library or the trees show changed —
    // unless a file this canvas created is gone (the undo of a create deletes
    // it, with no text event).
    const diagramUnchanged = isDbml && document.getText() === diskText;
    // Nor when this canvas deleted a table file: its undo brings the file back, also with no text event.
    const deletedHere = [...(this.deletedTablePaths.get(panelKey) ?? [])];
    const nothingRewound = diagramUnchanged && deletedHere.length === 0
      && [...(this.editedTablePaths.get(panelKey) ?? [])].every((p) => fs.existsSync(p));
    const savedOthers: string[] = [];
    const expectation = this.ownWriteTracker.expectWrite(expected);
    let unsavedTables: string[];
    try {
      if (await saveDocument(document, onSaveFailure)) {
        this.ownWriteTracker.recordWrite(document.uri.fsPath);
      } else {
        unsaved.push(document.uri.fsPath);
      }
      unsavedTables = await this.saveDirtyTableDocuments(panelKey, onSaveFailure, savedOthers);
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
    }
    unsaved.push(...unsavedTables);
    if (unsaved.length > 0) {
      const modelFile = unsavedTables.some((p) => /\.(ya?ml|dbml)$/i.test(p));
      for (const code of saveFailureCodes(saveFailures, { modelFile, undoRedo: true })) telemetry.error(code);
      void webview.postMessage({ type: 'error', payload: { message: this.describeUnsaved(unsaved) } });
    }
    // Saving the anchor's rewind cleared the dirty mark; the canvas stays as is.
    if (nothingRewound && unsavedTables.length === 0 && savedOthers.length === 0) return;
    if (layoutOnlyRewind && unsavedTables.length === 0 && savedOthers.length === 0) {
      await this.sendSubjectAreaData(document, webview, panelKey);
      this._onDidWriteSubjectArea.fire({ uri: document.uri, modelLibraryChanged: false, layoutOnly: true });
      return;
    }
    // Only what this canvas wrote can have changed (an undo of a create
    // deletes, of a delete creates): those files' parses, and the library
    // index, which is rebuilt from one listing.
    this.tableLibraryService.invalidatePaths([document.uri.fsPath, ...(this.editedTablePaths.get(panelKey) ?? []), ...deletedHere]);
    this.tableLibraryService.invalidateIndex();
    await this.sendSubjectAreaData(document, webview, panelKey);
    this._onDidWriteSubjectArea.fire({ uri: document.uri, modelLibraryChanged: true });
  }

  /** What `filePath` holds on disk, or undefined when it cannot be read. */
  private diskTextOf(filePath: string): string | undefined {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return undefined;
    }
  }

  /**
   * VS Code's own undo/redo (Cmd+Z on the canvas) changes each document of
   * the step in turn: wait until the burst settles, then flush once, exactly
   * as the toolbar's Undo / Redo does. A domain file whose text the step did
   * not change fires no event, so a model file's event schedules it too.
   */
  private scheduleNativeUndoFlush(document: vscode.TextDocument, webview: vscode.Webview, panelKey: string): void {
    clearTimeout(this.nativeUndoTimers.get(panelKey));
    this.nativeUndoTimers.set(panelKey, setTimeout(() => {
      this.nativeUndoTimers.delete(panelKey);
      void this.queueEdit(panelKey, async () => {
        if (this.disposedWebviews.has(webview)) return;
        // Work outside the edit queue still holds this canvas (a hold, or the
        // toolbar's Undo / Redo): flush after it, never under it.
        if (this.pendingUpdates.get(panelKey)) {
          if (this.heldPanels.has(panelKey)) this.undoWhileHeld.add(panelKey);
          else this.scheduleNativeUndoFlush(document, webview, panelKey);
          return;
        }
        this.pendingUpdates.set(panelKey, true);
        try {
          await this.flushUndoRedo(document, webview, panelKey);
        } catch (err) {
          log.error('[SemanticEditorProvider] Failed to save after undo/redo:', err);
        } finally {
          this.pendingUpdates.delete(panelKey);
        }
      });
    }, NATIVE_UNDO_SETTLE_MS));
  }

  /**
   * Generic helper to apply a stage-scoped mutation to the domain JSON and persist it.
   * This is the ONLY place a domain-file WorkspaceEdit is built: parse →
   * mutate → replace whole document → applyEdit → save → refresh webview, with
   * `pendingUpdates` held so the change listener never double-saves.
   *
   * - The mutator may `throw new EditAborted()` to abort without an edit (it
   *   has already reported the reason to the webview, or the request is a
   *   silent no-op); the helper then returns `false` without posting anything.
   *   Any other throw propagates — callers' catch blocks prefix the message
   *   with their own label.
   * - `options.errorLabel` is posted as an error when VS Code rejects the edit.
   * - `options.onSuccess` runs after the save + webview refresh (e.g.
   *   `selectorsService.scheduleRegenerate()`).
   * - `options.modelFiles` adds logical-models/*.yml writes/deletes to the same
   *   WorkspaceEdit so the domain change and the model file change are atomic
   *   and share one undo step.
   * - `options.otherDomains` is run on every OTHER v5 domain file of the
   *   project (parsed); each one it changes (returns true) is rewritten in the
   *   same WorkspaceEdit — how a rename reaches the copies other diagrams keep
   *   of their own (#133 L5). A file open with unsaved edits is refused by
   *   name, before anything is written; an unreadable one is left alone.
   */
  private async applySubjectAreaEdit(
    document: vscode.TextDocument,
    mutator: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    options: {
      refreshWebview?: boolean;
      webview?: vscode.Webview;
      stage: 'logical';
      modelFiles?: TableFileOps;
      /** Rewrite another diagram in place (a rename cascade); `storage` says which kind of file it is. True when it changed. */
      otherDomains?: (parsed: Record<string, unknown>, storage: 'json' | 'dbml', members?: DiagramMemberTable) => boolean;
      errorLabel?: string;
      onSuccess?: () => void;
      /** Called when the edit applied but a file could not be saved (usage telemetry). */
      onUnsaved?: () => void;
      /** Called as soon as VS Code applies the edit, before anything is saved. */
      onApplied?: () => void;
      /** Called when the edit went through as a layout-only write (positions or sticky-note boxes alone). */
      onLayoutOnly?: () => void;
      /** DBML: members whose reference the mutator changed (old → new): a namesake joined or left. Each keeps its `use` line. */
      renamedMembers?: ReadonlyMap<string, string>;
    },
  ): Promise<boolean> {
    const { refreshWebview = true, webview, stage, modelFiles, errorLabel, onSuccess } = options;
    const panelKey = document.uri.toString();

    // The open document outlives its file: saving this edit would bring back a
    // diagram an AI assistant, git or the file explorer just removed (#161).
    this.refuseIfSubjectAreaFileGone(document);
    const text = document.getText();
    const file = this.parseSubjectAreaFile(document, text);
    const parsed = file.parsed;
    const section = this.getStageSection(parsed, stage);

    try {
      mutator(section, parsed);
    } catch (err) {
      if (err instanceof EditAborted) return false;
      throw err;
    }
    // Only positions or sticky-note boxes moved (a drag, a layout, a resize):
    // the layout is all that is written, in either storage, and the sidebar
    // trees are told nothing they show changed.
    const layoutOnly = !modelFiles?.save?.length && !modelFiles?.delete?.length && options.otherDomains === undefined
      && isLayoutOnlyChange(file.snapshot, file.parsed);
    if (layoutOnly && (file.storage === 'json' || (file.writable !== false && !file.holdsOwnTables))) {
      const written = await this.applyLayoutOnlyEdit(document, file, text, options);
      if (written) options.onLayoutOnly?.();
      return written;
    }
    // A DBML diagram, or a project whose library holds DBML (native DBML
    // storage, §5.3): planned against the library and applied by
    // applyFileWrites. A YAML/JSON project keeps the path below unchanged.
    if (file.storage === 'dbml' || this.libraryHoldsDbml()
      || (options.otherDomains !== undefined && this.listOtherSubjectAreas(document.uri.fsPath).some((s) => s.storage === 'dbml'))) {
      return this.applyStorageEdit(document, file, text, options, layoutOnly);
    }
    // A model file open with unsaved edits would be replaced by text rendered
    // from disk: refuse by name (the handler reports it), before anything is written.
    const dirty = this.dirtyTableFile(modelFiles);
    if (dirty) throw new EditRefused(`${dirty} has unsaved changes. Save or revert it, then try again.`);
    const otherDomains = options.otherDomains ? this.rewriteOtherSubjectAreas(document.uri.fsPath, options.otherDomains) : [];

    // Re-rendered as before, in the file's own naming (#182) and line endings.
    const [primary] = codecFor(document.uri.fsPath).render(file, text, document.uri.fsPath);
    const updatedText = primary.kind === 'delete' ? text : primary.text;
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    edit.replace(document.uri, fullRange, updatedText);
    const { docs: modelDocs, created, deleted } = await this.addTableFileEdits(
      edit,
      modelFiles,
      // Layer folders are opt-in: a flat library stays flat (see groupsByFolder).
      modelFiles?.save?.length ? this.newYamlTableFolder(document.uri.fsPath) : undefined,
    );
    const otherDomainDocs: vscode.TextDocument[] = [];
    for (const { filePath, text: newText } of otherDomains) {
      const otherDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      edit.replace(otherDoc.uri, new vscode.Range(otherDoc.positionAt(0), otherDoc.positionAt(otherDoc.getText().length)), newText);
      otherDomainDocs.push(otherDoc);
    }

    // The watchers wait for these saves instead of taking one for an external change.
    const expected = [document.uri.fsPath, ...created, ...deleted, ...modelDocs.map((d) => d.uri.fsPath), ...otherDomainDocs.map((d) => d.uri.fsPath)];
    const expectation = this.ownWriteTracker.expectWrite(expected);
    this.pendingUpdates.set(panelKey, true);
    try {
      const success = await vscode.workspace.applyEdit(edit);
      if (!success) {
        telemetry.error('editRejected');
        if (errorLabel && webview) {
          webview.postMessage({ type: 'error', payload: { message: errorLabel } });
        }
        return false;
      }
      options.onApplied?.();
      // A save that fails is reported, never ignored: the edit is applied in
      // memory, so without a word the file would sit open and unsaved (#126).
      const unsaved: string[] = [];
      const saveFailures = new Set<SaveFailure>();
      const onSaveFailure = (reason: SaveFailure) => saveFailures.add(reason);
      let modelFileUnsaved = false;
      if (await saveDocument(document, onSaveFailure)) {
        // Own writes are recorded only once the bytes are on disk — the tracker
        // reads what the file holds — so the logical-model / semantic watchers can tell
        // this save apart from an external edit and skip the extra refresh.
        this.ownWriteTracker.recordWrite(document.uri.fsPath);
      } else {
        unsaved.push(document.uri.fsPath);
      }
      for (const filePath of created) {
        this.ownWriteTracker.recordWrite(filePath);
      }
      for (const filePath of deleted) {
        this.ownWriteTracker.recordDelete(filePath);
      }
      const ourPaths = this.editedTablePaths.get(panelKey) ?? new Set<string>();
      for (const [index, modelDoc] of [...modelDocs, ...otherDomainDocs].entries()) {
        // Remember which yml (and other domain) documents WE edited for this
        // domain, so an undo/redo only ever flushes those (never a buffer the
        // user is hand-editing in another tab).
        ourPaths.add(modelDoc.uri.fsPath);
        // Re-fetched by URI: VS Code may have disposed the handle opened
        // before the edit, and the edit then landed in a fresh copy (#126).
        if (await saveDocumentByUri(modelDoc.uri, onSaveFailure)) {
          this.ownWriteTracker.recordWrite(modelDoc.uri.fsPath);
        } else {
          unsaved.push(modelDoc.uri.fsPath);
          if (index < modelDocs.length) modelFileUnsaved = true;
        }
      }
      if (unsaved.length > 0) {
        for (const code of saveFailureCodes(saveFailures, { modelFile: modelFileUnsaved })) telemetry.error(code);
        options.onUnsaved?.();
        webview?.postMessage({ type: 'error', payload: { message: this.describeUnsaved(unsaved) } });
      }
      for (const filePath of created) {
        ourPaths.add(filePath);
      }
      if (ourPaths.size > 0) {
        this.editedTablePaths.set(panelKey, ourPaths);
      }
      // The table files this edit wrote, created or deleted: their parses, and
      // the library index when one appeared or went (the redraw below reads both).
      this.tableLibraryService.invalidatePaths([...created, ...deleted, ...modelDocs.map((d) => d.uri.fsPath)]);
      // Our own writes are suppressed at the watcher, so the refreshes it
      // used to drive are issued here instead: this panel via sendSubjectAreaData,
      // the sidebar/model library via onDidWriteSubjectArea, and any OTHER open
      // panel that shows a model we just wrote.
      if (refreshWebview && webview) {
        await this.sendSubjectAreaData(document, webview);
      }
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
      this.pendingUpdates.delete(panelKey);
    }

    const touchedModels = [
      ...(modelFiles?.save ?? []).map((entry) => entry.model.name),
      ...(modelFiles?.delete ?? []).map((d) => (typeof d === 'string' ? d : d.name)),
    ];
    // By name is right here: this path runs only for a library that holds no DBML (applyStorageEdit drops
    // every file it writes by path), and YAML names are unique across the library.
    for (const name of new Set(touchedModels)) this.tableLibraryService.invalidateCache(name);
    await this.refreshSubjectAreasReferencingTables(new Set(touchedModels), panelKey);
    this._onDidWriteSubjectArea.fire({
      uri: document.uri,
      modelLibraryChanged: created.length > 0 || deleted.length > 0,
    });
    for (const otherDoc of otherDomainDocs) {
      this._onDidWriteSubjectArea.fire({ uri: otherDoc.uri, modelLibraryChanged: false });
      // An open canvas of that diagram shows the rewrite (its own save is suppressed at the watcher).
      const other = this.openPanels.get(otherDoc.uri.toString());
      if (other && !this.disposedWebviews.has(other.webview)) await this.sendSubjectAreaData(other.document, other.webview, otherDoc.uri.toString());
    }

    onSuccess?.();
    return true;
  }

  /**
   * Every diagram of the project except `currentPath`. The DBML ones come
   * from every DBML layer folder, listed in layers.json or not (as the batch
   * settle reads them): a cascade that skipped a diagram in an unlisted
   * folder, or behind an unreadable layers.json, would leave it a `use`
   * line to a file that is gone.
   */
  private listOtherSubjectAreas(currentPath: string): import('../types/semantic').SubjectAreaSummary[] {
    const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
    const listed = this.subjectAreaService.listSubjectAreas(this.workspaceRoot, semanticDir);
    const semanticRoot = this.semanticRootDir();
    for (const filePath of this.tableLibraryService.listDbmlDiagrams()) {
      if (listed.some((s) => samePath(s.filePath, filePath))) continue;
      const [layer] = path.relative(semanticRoot, filePath).split(path.sep);
      listed.push({ domain: path.basename(filePath).replace(/\.dbml$/i, ''), layer, filePath, storage: 'dbml' });
    }
    return listed.filter((s) => !samePath(s.filePath, currentPath));
  }

  /** A file's text: an open document's (unsaved edits included), else the disk's without a byte-order mark; null when there is none. */
  private openOrDiskText(filePath: string): string | null {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, filePath));
    if (doc) return doc.getText();
    try {
      // A byte-order mark is the document's encoding, not its text: VS Code
      // keeps it on save, so a text with one would be written with two (D7).
      return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    } catch {
      return null;
    }
  }

  /** A writer's refusal (`DbmlEditRefused`) as the toast the handlers show; anything else as it is. */
  private refusalOf(err: unknown): unknown {
    if (err instanceof DbmlEditRefused) return new EditRefused(err.message, err.reason === 'overlap');
    return err;
  }

  /**
   * Whether `filePath` is a table library file: inside `logical-models/` or
   * a YAML `tables/`, or a DBML table or relationships file of a layer
   * (`<L>/tables/**`, `<L>/relationships/*`, by the classifier).
   */
  private isLibraryPath(filePath: string): boolean {
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    const rel = path.relative(semanticRoot, filePath).split(path.sep);
    if (rel.length < 2 || rel[0] === '..' || path.isAbsolute(rel[0])) return false;
    if (rel[0] === 'tables' || rel[0] === 'logical-models') return true;
    const kind = classifySemanticFile(rel.join('/'), { tablesDirIsLayer: this.tableLibraryService.tablesDirIsLayer() }).kind;
    return kind === 'table' || kind === 'relationships';
  }

  /** The semantic dir, absolute. */
  private semanticRootDir(): string {
    return path.dirname(this.tableLibraryService.getTablesDir());
  }

  /** The project's fields.yml reader, for the semantic dir in use (it changes only with a reload). */
  private fieldsReader: FieldsService | undefined;
  /** The problems last logged for fields.yml, so one broken file is logged once, not on every redraw. */
  private loggedFieldsReading: unknown;

  private fieldsService(): FieldsService {
    const root = this.semanticRootDir();
    if (!this.fieldsReader || this.fieldsReader.semanticRoot !== root) this.fieldsReader = new FieldsService(root);
    return this.fieldsReader;
  }

  /**
   * The field list a DisplaySubjectArea carries (both stages): the project's
   * fields.yml, only when it has one, so a project without the file posts
   * exactly what it did before. A broken file is logged (doctor reports it in
   * full) and its readable part, or the starting set, is used. Reads only.
   */
  private displayFields(): FieldList | undefined {
    try {
      const service = this.fieldsService();
      const reading = service.read();
      if (reading.problems.length > 0 && this.loggedFieldsReading !== reading) {
        this.loggedFieldsReading = reading;
        for (const problem of reading.problems) {
          log.warn(`[SemanticEditorProvider] ${projectRelative(this.workspaceRoot, reading.filePath)}${problem.line !== undefined ? ` (line ${problem.line})` : ''}: ${problem.message}`);
        }
      }
      return service.displayFields();
    } catch (err) {
      log.warn(`[SemanticEditorProvider] Could not read fields.yml: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** The resolved field list (the starting set without a file), for an edit that depends on a field's type. */
  private fieldList(): FieldList | undefined {
    try {
      return this.fieldsService().getList();
    } catch {
      return undefined;
    }
  }

  /**
   * fields.yml was created, changed or deleted outside ERD Studio: drop the
   * cached list and redraw every open canvas, on whichever stage it shows.
   * A refresh path: it never writes.
   */
  async onFieldsFileChanged(): Promise<void> {
    this.fieldsReader?.invalidate();
    await this.refreshAllOpenSubjectAreas();
  }

  /**
   * The {@link SubjectAreaResolver} of a library plan: tables, the
   * relationships files a diagram imports and file existence as the plan
   * leaves them, and the tables whose file moved, was renamed, was deleted
   * or was created (old and new names).
   */
  private resolverOf(plan: DbmlLibraryWritePlan): SubjectAreaResolver {
    return dbmlResolverOf(plan, this.semanticRootDir());
  }

  /**
   * {@link applySubjectAreaEdit} for a DBML diagram, or a project whose
   * library holds DBML (§2.6): the library writes are planned
   * (`planTableWrites`), the diagram is rendered against the library as the
   * edit leaves it (its relationships imports recomputed on every edit,
   * which also heals one it lacked), other diagrams the edit renames in are
   * re-rendered, and every other DBML diagram whose `use` lines the edit
   * invalidates is settled — all in ONE WorkspaceEdit applied by
   * `applyFileWrites`, with the primary's replace first so the step undoes
   * as one.
   */
  private async applyStorageEdit(
    document: vscode.TextDocument,
    file: ParsedSubjectArea,
    text: string,
    options: Parameters<SemanticEditorProvider['applySubjectAreaEdit']>[2],
    layoutOnly = false,
  ): Promise<boolean> {
    const { refreshWebview = true, webview, modelFiles, onSuccess } = options;
    const panelKey = document.uri.toString();
    const fsPath = document.uri.fsPath;
    const readText = (filePath: string): string | null => this.openOrDiskText(filePath);

    let primaryText: string;
    let writes: FileWrite[];
    let plan: DbmlLibraryWritePlan;
    let tableWrites: FileWrite[];
    try {
      const lib = this.tableLibraryService.planTableWrites(
        modelFiles,
        modelFiles?.save?.length ? this.newTableFolder(fsPath) : undefined,
        { dbml: file.storage === 'dbml', readText },
      );
      tableWrites = lib.writes;
      plan = lib.plan ?? this.tableLibraryService.planTableWrites(undefined, undefined, { dbml: true, readText }).plan!;
      const resolver = this.resolverOf(plan);
      // §2.6 step 1: the diagram being edited gets its imports recomputed on every edit but a layout-only one.
      // Told apart by identity, each of its members is the table its own `use` line reads, never the
      // library's first of its name, and a member whose reference the edit changed keeps its line.
      const own = plan.identities && file.members
        ? diagramResolverOf(plan, { members: file.members.rows.map((r) => r.ref), memberPaths: file.members.rows.map((r) => r.path ?? '') }, resolver)
        : resolver;
      const [primary] = codecFor(fsPath).render(file, text, fsPath, {
        ...own,
        refreshRelationshipsUses: !layoutOnly,
        ...(options.renamedMembers && options.renamedMembers.size > 0 ? { renamedMembers: options.renamedMembers } : {}),
      });
      primaryText = primary.kind === 'delete' ? text : primary.text;
      const others = options.otherDomains ? this.rewriteOtherSubjectAreaWrites(fsPath, options.otherDomains, resolver, { plan }) : [];
      const rewritten = new Set(others.map((w) => path.resolve(w.path)));
      const settled = this.settleDbmlDiagrams(fsPath, rewritten, plan);
      writes = [...tableWrites, ...others, ...settled];
    } catch (err) {
      throw this.refusalOf(err);
    }
    // Any file this edit writes that is open with unsaved changes would be
    // replaced under the user's work: refused by name, before anything is written.
    const dirty = dirtyFiles(writes.map((w) => w.path).filter((p) => !samePath(p, fsPath)));
    if (dirty.length > 0) {
      const name = path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/');
      throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
    }

    this.pendingUpdates.set(panelKey, true);
    let applied: AppliedFileWrites;
    try {
      const result = await this.applyAndSaveWrites(document, primaryText, writes, options);
      if (!result) return false;
      applied = result;
      // Only the files this edit wrote: every other table keeps its parse,
      // and the attach memo its result unless a relationships file or a
      // table's columns or keys changed. The relationships files it wrote
      // are read once more, from disk, so the next edit's snapshot reads none.
      const written = writtenPaths(applied);
      this.tableLibraryService.invalidatePaths(written);
      this.tableLibraryService.primeRelationshipsFiles(written);
      if (refreshWebview && webview) {
        await this.sendSubjectAreaData(document, webview);
      }
    } finally {
      this.pendingUpdates.delete(panelKey);
    }

    const touchedModels = [
      ...(modelFiles?.save ?? []).map((entry) => entry.model.name),
      ...(modelFiles?.delete ?? []).map((d) => (typeof d === 'string' ? d : d.name)),
    ];
    await this.refreshSubjectAreasReferencingTables(new Set(touchedModels), panelKey);
    this._onDidWriteSubjectArea.fire({
      uri: document.uri,
      modelLibraryChanged: applied.created.length > 0 || applied.deleted.length > 0,
      ...(layoutOnly ? { layoutOnly: true } : {}),
    });
    // Other diagrams this edit wrote (never a table or relationships file).
    const otherDiagrams = new Set<string>();
    for (const w of writes) {
      if (w.kind === 'delete' || this.isLibraryPath(w.path)) continue;
      if (!samePath(w.path, fsPath)) otherDiagrams.add(w.path);
    }
    for (const diagram of otherDiagrams) {
      const uri = vscode.Uri.file(diagram);
      this._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: false });
      const other = this.openPanels.get(uri.toString());
      if (other && !this.disposedWebviews.has(other.webview)) await this.sendSubjectAreaData(other.document, other.webview, uri.toString());
    }

    onSuccess?.();
    return true;
  }

  /**
   * Apply `writes` with the primary document's new text as ONE WorkspaceEdit
   * (`applyFileWrites`), then save every document it touched and record each
   * file as an own write once its bytes are on disk. Every path is announced
   * to the own-write tracker first, so a watcher that fires before a save
   * completes waits for it. Reports a rejected edit or an unsaved file to the
   * webview; returns what was applied, or null when VS Code rejected it.
   * The caller holds `pendingUpdates`.
   */
  private async applyAndSaveWrites(
    document: vscode.TextDocument,
    primaryText: string,
    writes: readonly FileWrite[],
    options: Parameters<SemanticEditorProvider['applySubjectAreaEdit']>[2],
    /** Replace only the primary's changed range: the DBML layout-only path alone. */
    minimalPrimary = false,
  ): Promise<AppliedFileWrites | null> {
    const { webview, errorLabel } = options;
    const panelKey = document.uri.toString();
    const fsPath = document.uri.fsPath;
    const expected = [fsPath, ...writes.map((w) => w.path)];
    const expectation = this.ownWriteTracker.expectWrite(expected);
    try {
      const applied = await applyFileWrites(writes, {
        primary: { document, text: primaryText },
        ...(minimalPrimary ? { minimalPrimary: true } : {}),
        semanticRoot: this.semanticRootDir(),
        ensureDir: (filePath) => { if (this.isLibraryPath(filePath)) this.tableLibraryService.ensureDir(filePath); },
      });
      if (!applied.ok) {
        telemetry.error('editRejected');
        // Put back: the caller's label, else the plain refusal (§5.3 step 7).
        // Not put back: the reconcile's modal already lists the files, and a
        // toast saying nothing changed would contradict it.
        if (webview && applied.unrestored.length === 0) {
          webview.postMessage({ type: 'error', payload: { message: errorLabel ?? EDIT_NOT_APPLIED_MESSAGE } });
        }
        return null;
      }
      options.onApplied?.();
      const unsaved: string[] = [];
      const saveFailures = new Set<SaveFailure>();
      const onSaveFailure = (reason: SaveFailure) => saveFailures.add(reason);
      let modelFileUnsaved = false;
      if (await saveDocument(document, onSaveFailure)) {
        this.ownWriteTracker.recordWrite(fsPath);
      } else {
        unsaved.push(fsPath);
      }
      for (const filePath of applied.created) this.ownWriteTracker.recordWrite(filePath);
      for (const filePath of applied.deleted) this.ownWriteTracker.recordDelete(filePath);
      for (const { from, to } of applied.renamed) {
        this.ownWriteTracker.recordDelete(from);
        this.ownWriteTracker.recordWrite(to);
      }
      const ourPaths = this.editedTablePaths.get(panelKey) ?? new Set<string>();
      for (const uri of applied.replaced) {
        // Remember what WE edited for this diagram, so an undo/redo only ever
        // flushes those.
        ourPaths.add(uri.fsPath);
        if (await saveDocumentByUri(uri, onSaveFailure)) {
          this.ownWriteTracker.recordWrite(uri.fsPath);
        } else {
          unsaved.push(uri.fsPath);
          if (this.isLibraryPath(uri.fsPath)) modelFileUnsaved = true;
        }
      }
      for (const filePath of applied.created) ourPaths.add(filePath);
      if (ourPaths.size > 0) this.editedTablePaths.set(panelKey, ourPaths);
      if (unsaved.length > 0) {
        for (const code of saveFailureCodes(saveFailures, { modelFile: modelFileUnsaved })) telemetry.error(code);
        options.onUnsaved?.();
        webview?.postMessage({ type: 'error', payload: { message: this.describeUnsaved(unsaved) } });
      }
      return applied;
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
    }
  }

  /**
   * {@link applySubjectAreaEdit} for an edit that changed only the layout
   * (table positions, sticky-note boxes; {@link isLayoutOnlyChange}): a drag,
   * an auto layout, a note moved or resized. Nothing in the table library
   * can change, so nothing is planned against it: no `planTableWrites`, no
   * library plan or attachment, no settle pass, no diagram render.
   *
   * - A DBML diagram rewrites its Project's `erd_layout` and nothing else
   *   ({@link layoutOnlyText}, never formatted), sent as the diagram's
   *   minimal-range replace: native Cmd+Z then rewinds that one edit. A
   *   conflicted `erd_layout` refuses it (a toast). The reading of the text
   *   it wrote is remembered (`primeLayoutOnlyReading`), so the next drag
   *   compiles nothing.
   * - A JSON diagram holds its positions, so its own text is rendered as on
   *   any edit (cheap: no library involved), as a full-range replace.
   *
   * Still one WorkspaceEdit, one save, one undo step, own writes recorded
   * after the bytes land. Nothing in the library is invalidated, and
   * `onDidWriteSubjectArea` carries `layoutOnly`, so the sidebar trees are
   * not refreshed.
   */
  private async applyLayoutOnlyEdit(
    document: vscode.TextDocument,
    file: ParsedSubjectArea,
    text: string,
    options: Parameters<SemanticEditorProvider['applySubjectAreaEdit']>[2],
  ): Promise<boolean> {
    const { refreshWebview = true, webview, onSuccess } = options;
    const panelKey = document.uri.toString();
    const fsPath = document.uri.fsPath;
    const dbml = file.storage === 'dbml';
    let primaryText: string;
    try {
      if (dbml) {
        primaryText = layoutOnlyText(file, text, fsPath, path.dirname(this.tableLibraryService.getTablesDir()));
      } else {
        const [primary] = codecFor(fsPath).render(file, text, fsPath);
        primaryText = primary.kind === 'delete' ? text : primary.text;
      }
    } catch (err) {
      throw this.refusalOf(err);
    }
    // Nothing moved (a drop where it was): no edit, no save, no undo step.
    if (primaryText === text) {
      onSuccess?.();
      return true;
    }

    this.pendingUpdates.set(panelKey, true);
    try {
      const applied = await this.applyAndSaveWrites(document, primaryText, [], options, dbml);
      if (!applied) return false;
      if (dbml) primeLayoutOnlyReading(text, primaryText, fsPath, file.parsed);
      if (refreshWebview && webview) {
        await this.sendSubjectAreaData(document, webview);
      }
    } finally {
      this.pendingUpdates.delete(panelKey);
    }
    this._onDidWriteSubjectArea.fire({ uri: document.uri, modelLibraryChanged: false, layoutOnly: true });
    onSuccess?.();
    return true;
  }

  /**
   * {@link rewriteOtherSubjectAreas} for every diagram format (§2.6): each
   * other diagram, parsed from its open document or the disk, run through
   * `rewrite`, and the ones it changes rendered against the library as the
   * edit leaves it — a DBML one with its imports recomputed and a conflicted
   * `erd_layout` kept as it is (§1.6). Throws, naming it, when a file it
   * would change is open with unsaved edits, and when a DBML diagram that
   * names a table whose path the edit changes (`changed`) cannot be read or
   * rendered: it would keep a `use` line to a file that is gone. Any other
   * DBML diagram that does not read is left as it is.
   */
  private rewriteOtherSubjectAreaWrites(
    currentPath: string,
    rewrite: (parsed: Record<string, unknown>, storage: 'json' | 'dbml', members?: DiagramMemberTable) => boolean,
    resolver: SubjectAreaResolver,
    options: {
      /** Only DBML diagrams: JSON ones are neither parsed nor dirty-checked. */
      dbmlOnly?: boolean;
      /** The plan whose path changes refuse an unreadable diagram (default: the resolver's). */
      plan?: DbmlLibraryWritePlan;
    } = {},
  ): FileWrite[] {
    const semanticRoot = this.semanticRootDir();
    // The tables whose file the edit renames, moves, deletes or re-qualifies (not the ones it creates).
    const changed = options.plan ? settleSignalsOf(options.plan) : { pathChanged: resolver.pathChanged };
    const out: FileWrite[] = [];
    for (const summary of this.listOtherSubjectAreas(currentPath)) {
      if (summary.storage !== 'dbml') {
        if (options.dbmlOnly) continue;
        for (const { filePath, text } of this.rewriteOtherSubjectAreas(currentPath, rewrite, [summary])) {
          out.push({ kind: 'replace', path: filePath, text });
        }
        continue;
      }
      const original = this.openOrDiskText(summary.filePath);
      if (original === null) continue;
      const rel = path.relative(semanticRoot, summary.filePath).split(path.sep).join('/');
      // What it imports, from a syntax-only read: whether a member's path changes decides refuse-or-skip.
      const memberPath = (): string | undefined => {
        const imports = diagramSummaryForFile(rel, summary.filePath, this.openDocumentText(summary.filePath));
        return changedMemberPath(rel, original, imports === 'unreadable' ? null : imports, changed);
      };
      let rendered: FileWrite[];
      try {
        const file = codecFor(summary.filePath).parse(original, summary.filePath);
        // With the diagram's own names for its members (a DBML diagram's member may be `<schema>.<name>`).
        if (!rewrite(file.parsed, 'dbml', file.members)) continue;
        // Not the diagram being edited: its imports are recomputed, a conflicted erd_layout stays as it is (§1.6).
        rendered = codecFor(summary.filePath).render(file, original, summary.filePath, { ...resolver, refreshRelationshipsUses: true, keepLayoutIfConflicted: true });
      } catch (err) {
        const oldPath = memberPath();
        if (oldPath !== undefined) throw unsettledDiagramRefusal(rel, problemOf(err, rel, summary.filePath), oldPath);
        log.warn(`[SemanticEditorProvider] ${summary.filePath} left as it is: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const changedWrites = rendered.filter((w, i) => i > 0 || (w.kind !== 'delete' && w.text !== original));
      if (changedWrites.length === 0) continue;
      const dirty = dirtyFiles(changedWrites.map((w) => w.path));
      if (dirty.length > 0) {
        const name = path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/');
        throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
      }
      out.push(...changedWrites);
    }
    return out;
  }

  /** An open document's text (unsaved edits included), else undefined. */
  private openDocumentText(filePath: string): string | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, filePath))?.getText();
  }

  /**
   * The settle (§2.6): every other DBML diagram whose `use` lines the plan
   * invalidates (`needsSettle`), re-rendered with no change of its own in
   * the same WorkspaceEdit, through the one settle every write path shares
   * (`settleDbmlDiagramWrites`). An edit that changes no path, creates no
   * table, re-qualifies nothing and moves no Ref pair lists and reads
   * nothing. `skip` holds the diagrams the caller already writes (resolved
   * paths). Throws, naming it, when a diagram it would change is open with
   * unsaved edits.
   */
  private settleDbmlDiagrams(currentPath: string, skip: ReadonlySet<string>, plan: DbmlLibraryWritePlan): FileWrite[] {
    if (settlesNothing(plan)) return [];
    const diagrams = this.listOtherSubjectAreas(currentPath)
      .filter((s) => s.storage === 'dbml' && !skip.has(path.resolve(s.filePath)))
      .map((s) => s.filePath);
    const out = settleDbmlDiagramWrites({
      semanticRoot: this.semanticRootDir(),
      diagrams,
      plan,
      readText: (filePath) => this.openOrDiskText(filePath),
      openText: (filePath) => this.openDocumentText(filePath),
    });
    if (out.length > 0) {
      const dirty = dirtyFiles(out.map((w) => w.path));
      if (dirty.length > 0) {
        const name = path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/');
        throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
      }
    }
    return out;
  }

  /**
   * The other v5 domain files `rewrite` changes, with their new text (#133
   * L5). Read from disk, as the next canvas load would; a file that does not
   * parse is left alone. Throws, naming it, when a file it would change is
   * open with unsaved edits.
   */
  private rewriteOtherSubjectAreas(
    currentPath: string,
    rewrite: (parsed: Record<string, unknown>, storage: 'json' | 'dbml', members?: DiagramMemberTable) => boolean,
    summaries?: readonly import('../types/semantic').SubjectAreaSummary[],
  ): Array<{ filePath: string; text: string }> {
    const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
    const out: Array<{ filePath: string; text: string }> = [];
    for (const summary of summaries ?? this.subjectAreaService.listSubjectAreas(this.workspaceRoot, semanticDir)) {
      if (samePath(summary.filePath, currentPath)) continue;
      // A `.dbml` diagram is never JSON.parse'd here (rewriteOtherSubjectAreaWrites renders it).
      if (summary.storage === 'dbml') continue;
      let original: string;
      let parsed: Record<string, unknown>;
      try {
        original = fs.readFileSync(summary.filePath, 'utf-8');
        parsed = JSON.parse(original) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== 'object') continue;
      const format = detectSubjectAreaFormat(parsed);
      if (format !== 'v5' && format !== 'v6') continue;
      // A v6 diagram (#162) is rewritten under the v5 keys and written back in its own naming (#182).
      if (format === 'v6') {
        parsed = normaliseSubjectAreaDocument(parsed);
        markTableNamingDocument(parsed);
      }
      if (!rewrite(parsed, 'json')) continue;
      if (dirtyFiles([summary.filePath]).length > 0) {
        const name = path.relative(this.workspaceRoot, summary.filePath).split(path.sep).join('/');
        throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
      }
      // Only the renamed strings change: the file keeps its layout and line endings.
      const text = rewriteJsonScalars(original, subjectAreaFileObject(parsed))
        ?? serialiseSubjectArea(parsed, original);
      out.push({ filePath: summary.filePath, text });
    }
    return out;
  }

  /** The error shown when files an edit changed could not be saved. */
  private describeUnsaved(filePaths: string[]): string {
    const names = filePaths.map((p) => path.relative(this.workspaceRoot, p).split(path.sep).join('/'));
    return `Could not save ${names.join(', ')} — the change is open in the editor but not on disk. ` +
      'Save the file from its tab (or revert it), then try again.';
  }

  /**
   * The open domain document, parsed for an edit or a handler that reads it
   * (#151). Core's `parseSubjectAreaJson` reads it — the load path's parser — so a
   * document that is empty, not JSON, or holds git conflict markers (written
   * while the canvas was open, before its refresh) refuses with the load
   * path's plain message ("…has unresolved git merge conflicts (first at
   * line N)…") instead of a raw SyntaxError, naming the file project-relative
   * as other toasts do. It throws `EditRefused` before any edit is built, so
   * nothing is written. Telemetry sniffs and refresh paths keep their own
   * tolerant `JSON.parse`: a bad document there is not the user's error.
   */
  private parseSubjectAreaDocument(document: vscode.TextDocument, text: string = document.getText()): Record<string, unknown> {
    return this.parseSubjectAreaFile(document, text).parsed;
  }

  /**
   * {@link parseSubjectAreaDocument} with what the codec knows besides the
   * object (§5.2): the storage, and for a DBML diagram its version and
   * writable flag. A `.dbml` diagram reads into a plain v5 object (D8).
   */
  private parseSubjectAreaFile(document: vscode.TextDocument, text: string = document.getText()): ParsedSubjectArea {
    const shown = this.shownSubjectAreaPath(document.uri.fsPath);
    const codec = codecFor(document.uri.fsPath);
    try {
      // Messages name the file project-relative.
      return codec.parse(text, shown);
    } catch (err) {
      if (err instanceof SubjectAreaFileError) {
        const fileProblem = this.subjectAreaFileProblemPayload(err, document.uri.fsPath);
        if (!fileProblem) throw new EditRefused(err.message);
        const next = fileProblem.fileProblem === 'empty' ? 'Restore its content, then try again.' : 'Fix it and save, then try again.';
        throw new EditRefused(`${fileProblem.message} ${next}`);
      }
      if (err instanceof NotASubjectAreaObject) {
        throw new EditRefused(`Diagram file ${shown} does not contain a JSON object.`);
      }
      if (err instanceof SubjectAreaValidationError) throw new EditRefused(err.message);
      throw err;
    }
  }

  /**
   * Say so — once per session per file — when this domain uses a name that
   * two files in the library define. Only one of them can be used (names are
   * identities), so without this a gold canvas would quietly show the silver
   * `date` table's columns. The warning names both files and offers the fix.
   */
  private warnAboutDuplicateTables(domain: UnifiedSubjectArea, document?: vscode.TextDocument): void {
    if (this.refreshHolds > 0) return;
    const used = new Set(domain.logical.models.map((m) => m.name.toLowerCase()));
    // Told apart by identity, a copy is a duplicate of the table of its schema folder and name, which a
    // DBML diagram may call `<schema>.<name>`: its members' identities are what it uses (and the names of
    // members read by name alone).
    const usedIds = document && this.schemaScoped() && this.isDbmlDocument(document) ? this.memberIdentities(document) : undefined;
    const uses = (entry: TableFileEntry): boolean => (usedIds
      ? usedIds.ids.has(tableIdKey(entry.id ?? tableIdOfEntry(entry))) || usedIds.names.has(entry.name.toLowerCase())
      : used.has(entry.name.toLowerCase()));
    const rel = (p: string): string => this.tableLibraryService.libraryRelativePath(p);
    for (const entry of this.tableLibraryService.listTableFiles()) {
      if (!entry.shadowedBy || !uses(entry)) continue;
      const key = `${domain.layer}/${domain.domain}\0${entry.filePath}`;
      if (this.duplicateWarningsShown.has(key)) continue;
      this.duplicateWarningsShown.add(key);
      // In both libraries (#162): a project half-way between the v5 and v6
      // naming, or a DBML copy of a YAML table (part-way through Convert).
      // Reported, never resolved here — the ignored copy is not written.
      const shadowedBy = entry.shadowedBy;
      if (this.tableLibraryService.isCrossLibraryDuplicate(entry)) {
        void vscode.window.showWarningMessage(
          `"${entry.name}" has a file in both the old and the new table folder. ${domain.layer}/${domain.domain} uses ` +
          `${rel(entry.shadowedBy)}; ${rel(entry.filePath)} is ignored. Delete the copy you don't want.`,
          OPEN_BOTH_FILES_BUTTON,
        ).then((choice) => {
          if (choice === OPEN_BOTH_FILES_BUTTON) void openBothFiles(shadowedBy, entry.filePath);
        });
        continue;
      }
      const meantThisCopy = entry.folder === domain.layer;
      const message = `"${entry.name}" is defined twice. ${domain.layer}/${domain.domain} uses ${rel(entry.shadowedBy)}` +
        (meantThisCopy
          ? `, not the ${domain.layer} copy ${rel(entry.filePath)}, which is ignored.`
          : `; ${rel(entry.filePath)} is ignored.`);
      // The fix rewrites files, so it is offered only inside logical-models/.
      const fixable = !entry.library && entry.layer === undefined;
      void vscode.window.showWarningMessage(
        fixable ? message : `${message} Rename or delete one copy.`,
        ...(fixable ? ['Fix…'] : []),
        OPEN_BOTH_FILES_BUTTON,
      ).then((choice) => {
        if (choice === 'Fix…') {
          void vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', entry.filePath);
        } else if (choice === OPEN_BOTH_FILES_BUTTON) {
          void openBothFiles(shadowedBy, entry.filePath);
        }
      });
    }
  }

  /**
   * Convert a SemanticSubjectArea to a DisplaySubjectArea for the webview.
   * viewConfig is passed separately since it lives at the unified domain root level.
   */
  private buildDisplaySubjectArea(
    domain: import('../types/semantic').SemanticSubjectArea,
    manifest: ManifestData,
    ymlData: YmlData,
    viewConfig: import('../types/semantic').ViewConfig,
    stubColumns?: string[],
    /** The diagram's file: a DBML diagram's tables are badged with the layer each was read from. */
    diagramPath?: string,
  ): DisplaySubjectArea {
    const memberFiles = this.memberFilesOf(diagramPath);
    const editorPayload = this.buildWebviewPayload(domain, manifest, ymlData, domain.modelFolder, memberFiles ? { memberFiles } : {});
    const readOnly = domain.stage === 'physical';
    const dbtKeyIndex = dbtKeyIndexOf(ymlData, manifest);

    const fields = this.displayFields();
    const display = toDisplaySubjectArea(domain, {
      viewConfig,
      stubColumns,
      layerConfig: this.layerService.getLayer(domain.layer),
      readOnly,
      editorPayload,
      // A relationship drawn backwards is flagged on dbt's evidence too (#163).
      dbtKeyIndex,
      // The project's fields.yml, only when it has one.
      ...(fields ? { fields } : {}),
    });
    // dbt's key evidence orients new relationships on an editable canvas (#133 L1).
    return readOnly ? display : this.withWhereThingsLand(this.withOwnRelationships(this.withTableLayers(withDbtKeyHints(display, dbtKeyIndex), diagramPath), diagramPath), diagramPath);
  }

  /**
   * Where New Table puts a table, for its Schema field: the layer's schema
   * folders and the default (`newTableSchemaChoice`), only when the
   * diagram's new tables are DBML (`newTableFolder`); a YAML project is
   * unchanged. Lists table files; reads none.
   */
  private withWhereThingsLand(display: DisplaySubjectArea, diagramPath: string | undefined): DisplaySubjectArea {
    if (diagramPath === undefined) return display;
    try {
      const home = this.newTableFolder(diagramPath);
      if (home === undefined || typeof home === 'string') return display;
      const choice = newTableSchemaChoice({
        layer: home.layer,
        layerSchema: home.schema,
        members: display.models.map((m) => m.name),
        homes: tableHomesOf(this.tableLibraryService.listTableFiles()),
      });
      return { ...display, newTableSchemas: { dir: projectRelative(this.workspaceRoot, this.semanticRootDir()), ...choice } };
    } catch (err) {
      log.warn(`[SemanticEditorProvider] where new tables go: ${err instanceof Error ? err.message : String(err)}`);
      return display;
    }
  }

  /**
   * Answer `requestNewRelationshipFiles` (the New Relationship dialog
   * opening): the relationships file a new relationship of each of the
   * diagram's DBML tables goes to when that table holds the foreign key
   * (`placeNewRef`, through `newRelationshipPlacements`), project-relative,
   * and the files the dialog may save it in instead (`choices`: that file
   * first, then the layer's other readable relationships files; omitted when
   * empty). Asked for on demand, not sent with every payload: it reads every
   * relationships file. The member names come from the open document's
   * text (no table is resolved); a YAML project answers empty at once.
   */
  private sendNewRelationshipFiles(document: vscode.TextDocument, webview: vscode.Webview): void {
    const files: Record<string, string> = {};
    const choices: Record<string, NewRelationshipFileChoice[]> = {};
    try {
      // No DBML table in the project: no relationship of this diagram goes to a relationships file.
      const names = (this.tableLibraryService.writesDbml()
        ? subjectAreaTableNames(document.getText(), document.uri.fsPath)
        : null) ?? [];
      // Told apart by identity, each member is placed by the file its `use` line reads, and answered
      // under what the diagram calls it (the dialog looks each table up by its name on the canvas).
      const byRef = new Map<string, string>();
      const asked: Array<string | TableId> = this.schemaScoped() && this.isDbmlDocument(document)
        ? names.map((name) => {
          try {
            const table = this.canvasTable(document, name);
            if (!table.id) return name;
            byRef.set(tableIdKey(table.id), name.toLowerCase());
            return table.id;
          } catch {
            return name;
          }
        })
        : names;
      for (const [key, placed] of this.tableLibraryService.newRelationshipPlacements(asked)) {
        const name = byRef.get(key) ?? key;
        files[name] = projectRelative(this.workspaceRoot, placed.file);
        // The dialog's "Stored in" choice: the default first, then the layer's other readable files.
        choices[name] = placed.choices.map((rel) => ({
          path: rel,
          projectPath: projectRelative(this.workspaceRoot, this.tableLibraryService.semanticAbsolute(rel)),
        }));
      }
    } catch (err) {
      log.warn(`[SemanticEditorProvider] where new relationships go: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.disposedWebviews.has(webview)) return;
    this.post(webview, { type: 'newRelationshipFiles', payload: { files, ...(Object.keys(choices).length > 0 ? { choices } : {}) } });
  }

  /**
   * Which relationships the diagram file holds itself, so the detail panel's
   * Remove confirmation warns only about the ones that really go with a
   * table (`withRelationshipHomes`). Reads the open document's text when
   * there is one; a file that cannot be read is left unmarked.
   */
  private withOwnRelationships(display: DisplaySubjectArea, diagramPath: string | undefined): DisplaySubjectArea {
    if (diagramPath === undefined) return display;
    if (subjectAreaStorageOf(diagramPath) === 'dbml') return withRelationshipHomes(display, undefined, true);
    let own: unknown = null;
    try {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === diagramPath);
      const text = open ? open.getText() : fs.readFileSync(diagramPath, 'utf-8');
      const logical = codecFor(diagramPath).parse(text, diagramPath).parsed.logical as { relationships?: unknown } | undefined;
      own = logical?.relationships;
    } catch {
      own = null;
    }
    return withRelationshipHomes(display, own, false);
  }

  /**
   * Each DBML table's own layer and every layer's config, so the canvas
   * badges a table borrowed from another layer with that layer, not the
   * diagram's. A DBML diagram's tables take the layer of the file each was
   * read from (its `use` path first, as core's loader reads it); a JSON
   * diagram's DBML tables, their file's. A project with no DBML tables is unchanged.
   */
  private withTableLayers(display: DisplaySubjectArea, diagramPath: string | undefined): DisplaySubjectArea {
    const read = diagramPath !== undefined ? this.subjectAreaService.dbmlMemberLayers(diagramPath) : undefined;
    const homes = read ? undefined : tableHomesOf(this.tableLibraryService.listTableFiles());
    const layerOf = (name: string): string | undefined => read ? read.get(name.toLowerCase()) : homes?.get(name.toLowerCase())?.layer;
    if (!display.models.some((m) => layerOf(m.name) !== undefined)) return display;
    return {
      ...display,
      layerConfigs: this.layerService.getAllLayers(),
      models: display.models.map((model) => {
        const layer = layerOf(model.name);
        return layer !== undefined ? { ...model, layer } : model;
      }),
    };
  }

  /**
   * A domain file's path as the user should see it: project-relative with `/`
   * separators, or just its name when it is outside the project (another
   * drive on Windows), so no screen or toast shows an absolute path.
   */
  private shownSubjectAreaPath(fsPath: string): string {
    return projectRelative(this.workspaceRoot, fsPath);
  }

  /**
   * The "isn't valid JSON" / "is empty" screens' payload (#186) for a domain
   * file the user has to fix, or `undefined` for any other failure (a merge
   * conflict keeps its own screen). The message is the plain sentence the
   * screen and the toast over a live canvas both show; it carries the line
   * and column, so a second mistake elsewhere is news to `postLoadError`.
   */
  private subjectAreaFileProblemPayload(err: SubjectAreaFileError, fsPath: string): ErrorMessage['payload'] | undefined {
    if (err.mergeConflict) return undefined;
    const shown = this.shownSubjectAreaPath(fsPath);
    if (err.reason === 'empty') {
      return { message: `${shown} has no content.`, kind: 'domain-file', fileProblem: 'empty' };
    }
    if (err.reason === 'invalid-dbml') {
      // A broken DBML diagram gets the same syntax screen, worded for DBML (§4.7).
      return {
        message: describeDbmlMistake(shown, err),
        kind: 'domain-file',
        fileProblem: 'syntax',
        ...(err.line !== undefined ? { line: err.line } : {}),
        ...(err.column !== undefined ? { column: err.column } : {}),
        fileType: 'DBML',
      };
    }
    if (err.reason !== 'invalid-json') return undefined;
    return {
      message: describeJsonMistake(shown, err),
      kind: 'domain-file',
      fileProblem: 'syntax',
      ...(err.line !== undefined ? { line: err.line } : {}),
      ...(err.column !== undefined ? { column: err.column } : {}),
    };
  }

  /** The "deleted or renamed" screen's payload (#161), naming the file project-relative. */
  private subjectAreaMissingPayload(document: vscode.TextDocument): ErrorMessage['payload'] {
    const shown = this.shownSubjectAreaPath(document.uri.fsPath);
    return { message: `${shown} was deleted or renamed outside ERD Studio.`, kind: 'domain-missing' };
  }

  /** Throws `EditRefused` when the domain file is no longer on disk, before anything is written (#161). */
  private refuseIfSubjectAreaFileGone(document: vscode.TextDocument): void {
    if (!fs.existsSync(document.uri.fsPath)) {
      throw new EditRefused(`${this.subjectAreaMissingPayload(document).message} Nothing was saved.`);
    }
  }

  /**
   * A domain file was deleted, created or changed outside ERD Studio (the
   * watcher's `onSemanticFileDeleted` / `onSemanticFileChanged`). Every open
   * canvas whose file is really gone switches to the "deleted or renamed"
   * screen now, rather than drawing a stale, editable diagram until an
   * unrelated refresh fails (#161); one showing that screen whose file is back
   * (a `git checkout` back, an assistant rewriting it) is re-read, since a
   * file restored with the same text fires no document change. Each panel is
   * checked on disk rather than matched against the event's paths: git's
   * delete-then-rename fires deletes for files that are still there, and
   * those canvases are left alone. Writes nothing.
   */
  syncSubjectAreaFilePresence(): void {
    for (const [panelKey, panel] of this.openPanels) {
      const { document, webview } = panel;
      if (document.uri.scheme !== 'file') continue;
      const missing = this.subjectAreaMissingPayload(document);
      if (!fs.existsSync(document.uri.fsPath)) {
        this.postLoadError(webview, panelKey, missing, undefined, 'missing');
      } else if (this.lastLoadError.get(panelKey) === missing.message) {
        void this.sendSubjectAreaData(document, webview, panelKey);
      }
    }
  }

  /**
   * Parse the document, build display domain for the active stage, and send to webview.
   * On parse failure, sends an error message instead.
   *
   * Models that lack a viewConfig position get one computed. By default the
   * computed positions are merged into the payload in memory only, so
   * watcher-driven refreshes (manifest / yml changes, external edits) never
   * write to the domain file. Pass `persistPositions: true` (the `ready` path)
   * to also write them back via WorkspaceEdit so they survive reloads.
   */
  private async sendSubjectAreaData(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey?: string,
    options: { persistPositions?: boolean; reshowError?: boolean } = {},
  ): Promise<number | undefined> {
    const errorKey = panelKey ?? document.uri.toString();
    const reshow = options.reshowError === true;

    // A JSON file under the semantic dir is not automatically a domain. The
    // custom editor's `**/.erd-studio/*/*.json` selector also matches
    // `templates/*.json` and the other reserved directories, and a glob cannot
    // express the exclusion, so the refusal lives here. Rendering a canvas for
    // one of those can only ever end in a parse error the user cannot act on.
    if (!isSubjectAreaFilePath(document.uri.fsPath) && document.uri.fsPath.toLowerCase().endsWith('.dbml')) {
      // The selector (`*/diagrams/*.dbml`) is case-insensitive in VS Code, a
      // tab restored from 1.9 keeps its editor, and `vscode.openWith` ignores
      // the selector: a table, relationships, 1.9 or other `.dbml` gets the
      // not-a-diagram page (§1.8), never a reroute.
      this.postLoadError(webview, errorKey, {
        message: `${notADiagramMessage(document.uri.fsPath, path.dirname(this.tableLibraryService.getTablesDir()))} ${REOPEN_AS_TEXT_SENTENCE}`,
        kind: 'not-a-domain',
      }, undefined, 'notDomain');
      return undefined;
    }
    if (!isSubjectAreaFilePath(document.uri.fsPath)) {
      const semanticDirName = path.basename(path.dirname(path.dirname(document.uri.fsPath)));
      this.postLoadError(webview, errorKey, {
        message:
          `${path.basename(document.uri.fsPath)} is not an ERD Studio diagram file — ` +
          `diagrams live in ${semanticDirName}/{layer}/diagrams/{name}.dbml or ${semanticDirName}/{layer}/{name}.json. ` +
          `Open it as text to edit it.`,
        kind: 'not-a-domain',
      }, undefined, 'notDomain');
      return undefined;
    }

    // Which step is running, for an internal failure's telemetry (#262).
    let step: SubjectAreaLoadStep = 'manifest';
    try {
      const key = panelKey ?? document.uri.toString();
      const panel = this.openPanels.get(key);
      // Logical-only: there is no Physical stage to restore into.
      if (panel && this.logicalOnly) { panel.activeStage = 'logical'; }
      const activeStage = panel?.activeStage ?? 'logical';
      // The first load's phases at info, a refresh's at debug.
      const timer = phaseTimer(canvasLog, `${options.persistPositions ? 'Open' : 'Refresh'} ${document.uri.fsPath}`,
        { level: options.persistPositions ? 'info' : 'debug' });

      timer.phase('reading dbt files');
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      step = 'yml';
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      step = 'catalog';
      const catalog = await this.loadCatalog();
      step = 'read';
      const dbtKeyIndex = dbtKeyIndexOf(ymlData, manifest);

      timer.phase('reading the diagram and its tables');
      let unifiedDomain = await this.readSubjectAreaTolerantly(document.uri.fsPath, { dbtKeyIndex });
      this.warnAboutDuplicateTables(unifiedDomain, document);

      // A fresh domain — models but not one stored position, typically written
      // by an AI assistant with `viewConfig: {}` — is laid out by the webview's
      // ELK auto layout instead, which persists through `updatePositions` (one
      // edit, one undo step). The simple placement below still goes out in the
      // payload so the first paint is never at (0,0), but it is not written:
      // should the ELK run fail, the next open simply asks again.
      // A DBML diagram's positions live in its Project's `erd_layout`,
      // written the same way.
      const autoLayout = activeStage === 'logical' && isFreshLayout(unifiedDomain);

      // Auto-assign positions for models that lack them (e.g. added by AI agents)
      step = 'positions';
      const computed = this.computeMissingPositions(unifiedDomain);
      if (computed) {
        if (options.persistPositions && !autoLayout) {
          timer.phase(`saving positions for ${plural(Object.keys(computed).length, 'new table')}`);
          const positionsWritten = await this.autoPositionNewTables(document, computed);
          if (positionsWritten === 'full') {
            // The full edit path may have settled more than the positions: read the diagram again.
            unifiedDomain = this.subjectAreaService.getSubjectArea(document.uri.fsPath, { dbtKeyIndex });
          }
          // A layout-only write stored exactly the positions merged below: nothing to read again.
        }
        // Whether or not they were persisted, the payload carries the positions
        // so the canvas never renders a model at (0,0).
        unifiedDomain.viewConfig.positions = { ...(unifiedDomain.viewConfig.positions ?? {}), ...computed };
      }

      timer.phase(`building the ${activeStage} canvas`);
      let postedTables: number;
      if (activeStage === 'physical') {
        step = 'physical';
        const physicalDomain = this.subjectAreaService.buildPhysicalSubjectArea(unifiedDomain, ymlData, manifest, catalog);
        postedTables = physicalDomain.models.length;
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) { physicalDomain.layerConfig = layerConfig; }
        const fields = this.displayFields();
        if (fields) { physicalDomain.fields = fields; }
        this.post(webview, { type: 'domainLoaded', payload: physicalDomain });
        step = 'other';
        this.cancelCanvasContext(webview);
        this.noteDrawn(key, unifiedDomain.logical.models.map((m) => m.name));
        if (options.persistPositions) this.recordCanvasOpen(document, 'physical', physicalDomain.models.length, catalog !== undefined);
      } else {
        step = 'display';
        const domain = SubjectAreaService.toLogicalStage(unifiedDomain);
        const displayDomain = this.buildDisplaySubjectArea(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns, document.uri.fsPath);
        postedTables = displayDomain.models.length;
        // What the turn-round offer asks about (#163): the lines this canvas flags, without reading the file again.
        this.backwardsDrawn.set(document.uri.toString(), displayDomain.relationships.filter((r) => r.keysContradict));
        this.post(webview, {
          type: 'domainLoaded',
          payload: displayDomain,
          ...(autoLayout ? { autoLayout: true } : {}),
          ...this.manifestHintFlag(),
          ...this.logicalOnlyFlag(),
        });
        step = 'other';
        // What the canvas knows beyond the diagram, once the diagram has gone out.
        void this.sendCanvasContext(webview, displayDomain.models.map((m) => m.name), unifiedDomain.layer, document);
        // What the files hold that this picture does not show ("not shown" notes), worked out after it has gone out.
        this.noteDrawn(key, displayDomain.models.map((m) => m.name));
        void this.sendFilesNotShown(webview, key, document, displayDomain.models.map((m) => m.name));
        if (subjectAreaStorageOf(document.uri.fsPath) === 'dbml' && this.holdsOwnTables(document)) {
          // A single-file DBML dropped into a layer folder (§2.5): offer Import.
          this.post(webview, { type: 'dbmlEmbeddedTables' });
        }
        if (options.persistPositions) {
          this.recordCanvasOpen(document, 'logical', displayDomain.models.length, catalog !== undefined);
          if (displayDomain.models.length === 0) telemetry.feature('emptyCanvas');
        }
        if (autoLayout) telemetry.feature('autoLayout');
      }
      // A payload went out, so the next failure is news again.
      this.lastLoadError.delete(errorKey);
      timer.end(`posted ${plural(postedTables, 'table')}${autoLayout ? ' (auto layout next)' : ''}`);
      return postedTables;
    } catch (err) {
      // A restored tab, or a refresh, whose file is gone (#161): the same
      // screen as a delete seen live, so Retry and Open as Text never show.
      if (err instanceof SubjectAreaFileError && err.reason === 'missing') {
        this.postLoadError(webview, errorKey, this.subjectAreaMissingPayload(document), err, 'missing');
        return undefined;
      }
      const fileProblem = err instanceof SubjectAreaFileError ? this.subjectAreaFileProblemPayload(err, document.uri.fsPath) : undefined;
      if (fileProblem) {
        this.postLoadError(webview, errorKey, fileProblem, err, classifySubjectAreaLoadFailure(err), undefined, reshow);
        return undefined;
      }
      if (err instanceof SubjectAreaFileError) {
        // A merge conflict, or a file that stayed locked or unreadable.
        this.postLoadError(webview, errorKey, {
          message: err.message,
          kind: 'domain-file',
          ...(err.mergeConflict ? { mergeConflict: true as const } : {}),
        }, err, classifySubjectAreaLoadFailure(err), undefined, reshow);
        return undefined;
      }
      this.postLoadError(webview, errorKey, this.subjectAreaLoadFailurePayload(err, document.uri.fsPath), err, classifySubjectAreaLoadFailure(err), step, reshow);
    }
    return undefined;
  }

  /**
   * The screen for a load failure that is not about reading the file (#261):
   * a file ERD Studio reads but can't accept (`invalid`: the user's to fix,
   * named project-relative, through the commands' `describeDiagramFileProblem`)
   * or anything else (`internal`: ERD Studio's, the exception with every local
   * path redacted). Core's wrapped TypeError is `describeDiagramFileProblem`'s
   * "ours" case, so it gets the internal screen.
   */
  private subjectAreaLoadFailurePayload(err: unknown, fsPath: string): ErrorMessage['payload'] {
    if (err instanceof SubjectAreaValidationError) {
      const problem = describeDiagramFileProblem(err, fsPath, this.shownSubjectAreaPath(fsPath));
      if (problem) {
        const newerSchema = err.kind === 'newerSchema' || !problem.openable;
        return { message: `${problem.reason}.`, kind: 'invalid', ...(newerSchema ? { newerSchema: true as const } : {}) };
      }
    }
    const raw = err instanceof Error ? err.message : String(err);
    return { message: redactPaths(raw), kind: 'internal' };
  }

  /**
   * `{ manifestMissing: true }` for a logical payload when dbt has not written
   * a manifest yet and this workspace has not dismissed the hint (#113), else
   * nothing. Call only after `loadManifest`, which is what sets `isMissing`,
   * and only for logical payloads.
   */
  private manifestHintFlag(): { manifestMissing?: true } {
    if (this.logicalOnly) return {};
    if (!this.manifestService.isMissing) return {};
    // A folder that is not a dbt project (#111) will never have a manifest.
    if (!hasDbtProjectFile(this.workspaceRoot)) return {};
    if (this.context.workspaceState?.get<boolean>(MANIFEST_HINT_DISMISSED_KEY)) return {};
    return { manifestMissing: true };
  }

  /** Whether a DBML diagram declares Tables of its own and has no table `use` line (§2.5). Never throws. */
  private holdsOwnTables(document: vscode.TextDocument): boolean {
    try {
      return codecFor(document.uri.fsPath).parse(document.getText(), document.uri.fsPath).holdsOwnTables === true;
    } catch {
      return false;
    }
  }

  /** Usage telemetry for a canvas's first load: only the stage, format and counts. */
  private recordCanvasOpen(document: vscode.TextDocument, stage: Stage, modelCount: number, hasCatalog: boolean): void {
    let format: 'v4' | 'v5' = 'v5';
    if (subjectAreaStorageOf(document.uri.fsPath) === 'dbml') {
      // A DBML diagram counts as 'v5' (D21), plus the feature: never JSON-parsed.
      telemetry.featureOnce('dbmlProject');
    } else {
      try {
        const detected = detectSubjectAreaFormat(JSON.parse(document.getText()) as Record<string, unknown>);
        if (detected === 'v4') format = 'v4';
        // A JSON diagram in the v6 table naming (still counted as 'v5'): once a day, off the onboarding trail.
        if (detected === 'v6') telemetry.featureQuiet('canvasJsonV6', true);
      } catch {
        // Loaded a moment ago, so this cannot really fail; v5 is the only other loadable format.
      }
    }
    telemetry.canvasOpened(stage, format, modelCount);
    // Without dbt the manifest service is disabled and reports neither missing
    // nor stale: recording that as 'ok' would count a plain folder as a fresh
    // manifest. The day's manifest state stays 'unknown' instead.
    if (!this.logicalOnly) {
      telemetry.manifest(this.manifestService.isMissing ? 'missing' : this.manifestService.isStale ? 'stale' : 'ok');
      // #113: where a missing manifest is met (once per day).
      if (this.manifestService.isMissing) {
        telemetry.featureOnce(stage === 'logical' ? 'manifestMissingCanvas' : 'manifestMissingPhysical');
      }
    }
    telemetry.catalog(hasCatalog);
    this.recordDiagramFlags(document);
    if (stage === 'logical') this.scheduleRelationshipSurvey(document);
  }

  /**
   * Usage telemetry for a canvas's first load (2.0 B14): how the diagram
   * renders degraded — the loader's warning codes (a table not found, DBML
   * from another tool) and, for a DBML diagram, what its reading found (the
   * remembered one: no compile). Presence flags, once a day each. Never throws.
   * Skipped when usage telemetry is off: its only use is telemetry.
   */
  private recordDiagramFlags(document: vscode.TextDocument): void {
    if (!telemetry.enabled()) return;
    try {
      const fsPath = document.uri.fsPath;
      const features = loaderWarningFeatures(this.subjectAreaService.loaderWarningCodes(fsPath));
      if (subjectAreaStorageOf(fsPath) === 'dbml') features.push(...dbmlDiagramFeatures(readDbmlDiagram(document.getText(), fsPath)));
      for (const feature of features) telemetry.featureOnce(feature);
    } catch (err) {
      log.debug(`[SemanticEditorProvider] Diagram flags not recorded: ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  /**
   * Run the canvas open's relationship survey ({@link recordRelationshipState})
   * a little later, off the open's critical path: it reads every table in
   * the library, which on a large library opened cold is most of the cost
   * of the open. Skipped when usage telemetry is off (nothing would be sent)
   * or the diagram has been closed since.
   */
  private scheduleRelationshipSurvey(document: vscode.TextDocument): void {
    const timer = setTimeout(() => {
      if (!telemetry.enabled() || !this.openPanels.has(document.uri.toString())) return;
      this.libraryWarmUp?.noteForegroundWork();
      this.recordRelationshipState(document);
    }, this.relationshipSurveyDelayMs);
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * Usage telemetry for a logical canvas's first load (#133): which states the
   * relationships it reads are in — counts only, at most once a day each.
   */
  private recordRelationshipState(document: vscode.TextDocument): void {
    try {
      // A DBML diagram is read through its codec (a v5 object, D8), never `JSON.parse`d.
      const parsed = subjectAreaStorageOf(document.uri.fsPath) === 'dbml'
        ? codecFor(document.uri.fsPath).parse(document.getText(), document.uri.fsPath).parsed
        : JSON.parse(document.getText()) as Record<string, unknown>;
      // Read only: a v6 file (#162) is surveyed like v5, through its v5 keys.
      const format = detectSubjectAreaFormat(parsed);
      const section = this.getStageSection(format === 'v6' ? normaliseSubjectAreaDocument(parsed) : parsed, 'logical');
      const v5 = format === 'v6' || this.isSubjectAreaV5(parsed);
      // Named as the library's relationships name them (its library reference, where two schema folders share a name).
      const models = v5 ? this.libraryTables().models : ((section.models ?? []) as SemanticTable[]).filter((m) => !!m && typeof m === 'object');
      const unreadableEntries = v5 && this.tableLibraryService.hasUnreadableRelationships() ? 1 : 0;
      telemetry.relationshipState(surveyLibrary(models, (section.relationships ?? []) as Relationship[], { unreadableEntries }));
    } catch (err) {
      log.error('[SemanticEditorProvider] relationship survey failed:', err);
    }
  }

  /**
   * Read a domain file, giving a writer that is replacing it time to finish.
   *
   * A domain file is replaced wholesale — by `git checkout`, by a formatter,
   * by an AI agent following the installed harness — and for a few
   * milliseconds mid-replacement it is empty or truncated. The watchers and
   * `onDidChangeTextDocument` fire on the create, so the canvas reads exactly
   * then. Re-reading a few times over ~1.2s turns what used to be a permanent
   * error screen into a refresh nobody notices.
   *
   * Only `transient` failures are retried: a file that is missing, unreadable
   * or structurally wrong will read the same way in a second, and making the
   * user wait to be told so helps nobody.
   */
  private async readSubjectAreaTolerantly(filePath: string, options: { dbtKeyIndex?: DbtKeyIndex } = {}): Promise<UnifiedSubjectArea> {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.subjectAreaService.getSubjectArea(filePath, options);
      } catch (err) {
        const last = attempt >= SUBJECT_AREA_READ_RETRY_DELAYS_MS.length;
        if (last || !isRetryableSubjectAreaRead(err)) {
          throw err;
        }
        log.warn(
          `[SemanticEditorProvider] ${filePath} is ${err.reason} — ` +
          `re-reading in ${SUBJECT_AREA_READ_RETRY_DELAYS_MS[attempt]}ms (likely mid-write)`,
        );
        await delay(SUBJECT_AREA_READ_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  /**
   * A diagram went out to this canvas: it shows its files again, so the note
   * for a file that would not read goes, and what it was drawn from is
   * remembered for {@link revalidateAgainstDisk}.
   */
  private noteDrawn(panelKey: string, members: readonly string[]): void {
    const entry = this.openPanels.get(panelKey);
    if (!entry) return;
    entry.staleNote = undefined;
    if (!entry.document.isDirty) entry.saveFailed = false;
    try {
      entry.drawnFrom = { members: [...members], signature: this.filesSignatureOf(members) };
    } catch {
      entry.drawnFrom = undefined;
    }
  }

  /**
   * The diagram's file could not be read over a canvas that is already
   * drawn: the old picture stays (a toast says why, and can be dismissed),
   * so a note that cannot be dismissed says the picture is old for as long
   * as that is true. Nothing for a canvas with no picture yet (it shows the
   * error page) or a file that is gone (it shows "deleted or renamed").
   */
  private noteNotDrawn(panelKey: string, payload: ErrorMessage['payload'], failure: SubjectAreaLoadFailure): void {
    const entry = this.openPanels.get(panelKey);
    if (!entry?.loaded || failure === 'missing' || failure === 'notDomain') return;
    const shown = this.shownSubjectAreaPath(entry.document.uri.fsPath);
    const note: FileNote = payload.kind === 'internal'
      ? {
        code: 'refreshFailed',
        message: 'ERD Studio could not redraw this diagram. The canvas shows it as it was before. The problem is in ERD Studio, not in your files.',
        action: 'reloadFromDisk',
      }
      : {
        code: 'diagramNotRead',
        message: `${payload.message} The canvas shows the last version that read, until the file is fixed.`,
        file: shown,
        ...(payload.line !== undefined ? { line: payload.line } : {}),
      };
    if (entry.staleNote?.message === note.message) return;
    entry.staleNote = note;
    this.postFilesNotShown(panelKey);
  }

  /**
   * Post a load failure to the canvas, at most once per distinct message.
   *
   * Issue #64 arrived with the same parse error fifteen times in six seconds:
   * an external writer touched fifteen model files, each refresh re-read the
   * same broken domain, and each one logged and posted afresh. Repeating an
   * error the user is already looking at tells them nothing and buries the
   * genuinely new entries in the diagnostics the bug report collects.
   */
  private postLoadError(
    webview: vscode.Webview,
    errorKey: string,
    payload: ErrorMessage['payload'],
    err: unknown,
    failure: SubjectAreaLoadFailure,
    step?: SubjectAreaLoadStep,
    /**
     * The diagram's own file just changed and failed the same way: the toast
     * is shown again (it may have been dismissed), with no second log line or
     * telemetry count. The #64 flood came from refreshes of OTHER files.
     */
    reshow = false,
  ): void {
    this.noteNotDrawn(errorKey, payload, failure);
    if (this.lastLoadError.get(errorKey) === payload.message) {
      if (reshow) this.post(webview, { type: 'error', payload });
      return;
    }
    this.lastLoadError.set(errorKey, payload.message);
    telemetry.error('domainLoad');
    telemetry.error(subjectAreaLoadErrorCode(failure));
    // Which step threw, beside domainLoadInternal (the total, #262).
    if (failure === 'internal' && step) telemetry.error(subjectAreaLoadStepCode(step));
    if (failure !== 'missing') {
      // 2.0 B14: a failure over a live canvas (often an assistant part-way
      // through writing several files) is only flagged; one that keeps the
      // canvas from opening also says why, from core's fixed fields.
      if (this.openPanels.get(errorKey)?.loaded) {
        telemetry.feature('domainLoadOverLive');
      } else {
        telemetry.feature('domainLoadBlocking');
        const detail = subjectAreaLoadDetailCode(err);
        if (detail) telemetry.error(detail);
      }
    }
    if (failure === 'missing') {
      // The canvas's file was removed (an Undo of Convert, a delete or a
      // `git checkout` outside ERD Studio): expected, and the screen says
      // so. Not an error: no error line, nothing for a bug report.
      log.info(`[SemanticEditorProvider] ${payload.message} The canvas shows the "deleted or renamed" screen.`);
    } else {
      hostErrorLog.record('sendDomainData', err ?? payload.message);
      log.error(`[SemanticEditorProvider] Failed to load domain: ${payload.message}`);
    }
    this.post(webview, { type: 'error', payload });
  }

  /**
   * Detect models in logical.models that lack entries in viewConfig.positions
   * and compute positions for them. Pure — returns the computed positions (or
   * null when every model already has one) without touching the document.
   */
  private computeMissingPositions(
    unifiedDomain: { logical: { models: Array<{ name: string }>; relationships: Relationship[] }; viewConfig: { positions?: Record<string, NodePosition> } },
  ): Record<string, NodePosition> | null {
    return computeMissingPositions(unifiedDomain);
  }

  /**
   * Persist auto-computed positions to the document via WorkspaceEdit so they
   * survive reloads. Only called from the `ready` path — see sendSubjectAreaData.
   * Returns true if positions were written.
   */
  private async autoPositionNewTables(
    document: vscode.TextDocument,
    computed: Record<string, NodePosition>,
  ): Promise<'layout' | 'full' | false> {
    // Merge computed positions into the document. No webview refresh — the
    // caller (sendSubjectAreaData) is about to send the payload itself.
    let layoutOnly = false;
    const save = async (): Promise<'layout' | 'full' | false> => {
      const written = await this.applySubjectAreaEdit(
        document,
        (_section, parsed) => {
          const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const existingPos = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
          viewConfig.positions = { ...existingPos, ...computed };
          parsed.viewConfig = viewConfig;
        },
        { refreshWebview: false, stage: 'logical', onLayoutOnly: () => { layoutOnly = true; } },
      );
      return written ? (layoutOnly ? 'layout' : 'full') : false;
    };
    if (!this.isDbmlDocument(document)) return save();
    // A DBML diagram's save rewrites its erd_layout, which can be refused (the
    // diagram is read-only, or erd_layout holds a merge conflict). A refresh
    // path never fails on a write: the canvas still loads with the computed
    // positions, and the next open asks again.
    try {
      if (this.parseSubjectAreaFile(document).writable === false) return false;
      return await save();
    } catch (err) {
      if (err instanceof EditRefused || err instanceof DbmlEditRefused) {
        log.warn(`[SemanticEditorProvider] Positions for ${document.uri.fsPath} not saved: ${err.message}`);
        return false;
      }
      throw err;
    }
  }

  /**
   * Refresh all open domain editors with fresh manifest data.
   * Called by extension.ts when manifest changes.
   * Stage-aware: panels viewing physical stage get physical data.
   */
  async refreshAllOpenSubjectAreas(): Promise<void> {
    // Held (holdRefreshes): the command that holds redraws every canvas once it releases.
    if (this.refreshHolds > 0) { this.droppedRefreshes++; return; }
    let failed = false;
    for (const [panelKey, { document, webview, activeStage, lastCompareAgainst }] of Array.from(this.openPanels.entries())) {
      // The snapshot may include a panel that was disposed while an earlier
      // iteration awaited — skip it rather than refreshing a dead webview.
      if (this.disposedWebviews.has(webview) || !this.openPanels.has(panelKey) || this.forgetIfGone(panelKey)) {
        continue;
      }
      try {
        if (activeStage === 'physical') {
          await this.handleSwitchStage(panelKey, document, webview, 'physical');
        } else {
          await this.sendSubjectAreaData(document, webview, panelKey);
        }
        // An open Compare overlay is worked out again (Refresh Manifest, a new
        // catalog, …): otherwise it, the staleness banner and the report Sync
        // plans from would still describe the data before the refresh. Only a
        // comparison made from the stage on screen: a stage switch closes the
        // overlay in the webview.
        // Read from the live entry, not the snapshot: Compare may have been
        // closed, or the stage switched, while the redraw above awaited.
        const live = lastCompareAgainst ? this.openPanels.get(panelKey) : undefined;
        if (live?.lastCompareAgainst && live.lastCompareAgainst !== live.activeStage && !this.logicalOnly
          && !this.disposedWebviews.has(webview)) {
          await this.handleToggleDiscrepancy(panelKey, document, webview, { enabled: true, compareAgainst: live.lastCompareAgainst });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        telemetry.error('refreshFailed');
        log.error(
          `[SemanticEditorProvider] Refresh failed for ${document.uri.fsPath}: ${message}`,
        );
        this.post(webview, {
          type: 'error',
          payload: { message: `Refresh failed: ${message}` },
        });
        failed = true;
      }
    }
    // Every canvas was redrawn from the files as they are: an earlier failed redraw is made good.
    if (!failed && this.refreshFailure !== undefined) {
      this.refreshFailure = undefined;
      for (const panelKey of this.openPanels.keys()) this.postFilesNotShown(panelKey);
    }
  }

  /**
   * Refresh all open domain editors that reference a specific model.
   * Called when a logical-models/*.yml file changes externally (e.g., edited
   * from another domain, or modified by an AI tool directly), and by
   * `applySubjectAreaEdit` for the OTHER open panels after this provider wrote a
   * model file itself (its own write is suppressed at the watcher, so the
   * cross-panel refresh has to be driven from here).
   */
  async refreshSubjectAreasReferencingTable(modelName: string, exceptPanelKey?: string): Promise<void> {
    await this.refreshSubjectAreasReferencingTables([modelName], exceptPanelKey);
  }

  /**
   * {@link refreshSubjectAreasReferencingTable} for several tables at once:
   * each open canvas naming any of them is sent once, however many of them
   * it names (a branch switch or an assistant's bulk edit changes hundreds).
   */
  async refreshSubjectAreasReferencingTables(modelNames: Iterable<string>, exceptPanelKey?: string): Promise<void> {
    if (this.refreshHolds > 0) { this.droppedRefreshes++; return; }
    const wanted = new Set([...modelNames].map(normaliseName));
    if (wanted.size === 0) return;
    const label = wanted.size === 1 ? `model "${[...modelNames][0]}"` : `${wanted.size} models`;
    for (const [panelKey, { document, webview }] of Array.from(this.openPanels.entries())) {
      if (this.disposedWebviews.has(webview) || !this.openPanels.has(panelKey) || this.forgetIfGone(panelKey)) {
        continue;
      }
      // The panel that made the edit has already been refreshed by
      // applySubjectAreaEdit — re-sending would clear the user's selection.
      if (exceptPanelKey !== undefined && panelKey === exceptPanelKey) {
        continue;
      }
      try {
        // Check if this domain references a changed model. The shared
        // raw membership reader handles v5 name strings, v4/hybrid inline
        // objects, legacy top-level `models` and a DBML diagram's `use`
        // lines — and tolerates junk entries.
        const names = subjectAreaTableNames(document.getText(), document.uri.fsPath);
        if (names === null) throw new Error(`${this.shownSubjectAreaPath(document.uri.fsPath)} does not parse`);
        // A DBML diagram that names a member `<schema>.<name>` (another member has its name) is
        // asked by its members' own names too: a changed table is named by its own name.
        const qualified = names.some((n) => n.includes('.'));
        if (names.some((n) => wanted.has(normaliseName(n))) || (qualified && this.dbmlMemberNames(document).some((n) => wanted.has(normaliseName(n))))) {
          await this.sendSubjectAreaData(document, webview, panelKey);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[SemanticEditorProvider] Refresh for ${label} failed: ${message}`);
      }
    }
  }

  /**
   * A table file changed outside ERD Studio: refresh the canvases naming it,
   * together with every other table that changes within
   * {@link TABLE_REFRESH_BATCH_MS} (one send per canvas for a burst, as the
   * sidebar trees already batch theirs).
   */
  queueTableRefresh(modelName: string): void {
    this.queuedTableRefresh.add(modelName);
    if (this.tableRefreshTimer !== undefined) return;
    this.tableRefreshTimer = setTimeout(() => {
      this.tableRefreshTimer = undefined;
      const names = [...this.queuedTableRefresh];
      this.queuedTableRefresh.clear();
      void this.refreshSubjectAreasReferencingTables(names);
    }, TABLE_REFRESH_BATCH_MS);
  }

  /**
   * Close the canvases of these files (Convert replaced them with their
   * `.dbml`): each panel is disposed, which drops its state, and its entry
   * is forgotten even if the dispose never reaches us, so no refresh reads
   * a file that is gone.
   */
  closeCanvasesOf(fsPaths: readonly string[]): void {
    for (const [panelKey, entry] of Array.from(this.openPanels.entries())) {
      if (!fsPaths.some((p) => samePath(entry.document.uri.fsPath, p))) continue;
      try { entry.panel?.dispose(); } catch { /* already disposed */ }
      this.forgetPanel(panelKey, entry.webview);
    }
  }

  /**
   * Whether a canvas's panel is gone (VS Code closed its tab, e.g. when Undo
   * deleted its file) though its dispose never reached us: a disposed
   * panel throws on `active`. Forgets it when so.
   */
  private forgetIfGone(panelKey: string): boolean {
    const entry = this.openPanels.get(panelKey);
    if (!entry?.panel) return false;
    try {
      void entry.panel.active;
      return false;
    } catch {
      this.forgetPanel(panelKey, entry.webview);
      return true;
    }
  }

  /**
   * Select and centre one relationship on the canvas of `uri` (the
   * Relationships view's Open in Diagram). A canvas that has loaded its
   * diagram gets it at once, switched to the logical stage first (the line is
   * a design relationship); one still opening gets it from the `ready`
   * handler, so the caller may ask before or after opening the editor.
   */
  async revealRelationship(uri: vscode.Uri, target: RevealRelationshipMessage['payload']): Promise<void> {
    const open = Array.from(this.openPanels.entries()).find(([, p]) =>
      p.loaded && !this.disposedWebviews.has(p.webview) && samePath(p.document.uri.fsPath, uri.fsPath));
    if (!open) {
      this.pendingReveals.set(uri.fsPath, { target, at: Date.now() });
      return;
    }
    const [panelKey, panel] = open;
    if (panel.activeStage !== 'logical') {
      await this.handleSwitchStage(panelKey, panel.document, panel.webview, 'logical');
    }
    this.post(panel.webview, { type: 'revealRelationship', payload: target } satisfies RevealRelationshipMessage);
  }

  /**
   * Select and centre one table, with its detail panel open, on the canvas of
   * `uri` (Open in Diagram / Go to Table on a table). As
   * {@link revealRelationship}: posted at once to a loaded canvas (switched
   * to the logical stage first), else held until its `ready` has its diagram.
   */
  async revealTable(uri: vscode.Uri, modelName: string): Promise<void> {
    await this.runTableAction(uri, { reveal: modelName });
  }

  /**
   * Add to Diagram… and a plain drop of Table Library rows on a diagram (its
   * drop receipt, `src/providers/libraryDropReceipts.ts`): once the canvas of
   * `uri` has its diagram, add `modelNames` through the Add Existing Tables
   * edit (`handleAddExistingModels`: one edit, one undo, placed next to
   * related tables), then select the first one added. When every one is on
   * the diagram already, the first is selected and named instead. The caller
   * opens the diagram.
   */
  async addTablesToDiagram(uri: vscode.Uri, modelNames: readonly string[]): Promise<void> {
    if (modelNames.length === 0) return;
    await this.runTableAction(uri, { reveal: modelNames[0], add: [...modelNames] });
  }

  /**
   * A drag started in the Table Library (its drag controller): remember its
   * tables for a drop that brings no table file ({@link PENDING_LIBRARY_DRAG_MS}),
   * and tell every loaded canvas on the logical stage, which shows how to drop
   * them (an editable diagram only; the webview decides).
   */
  noteLibraryDrag(
    tables: readonly string[],
    /** Each dragged table's file (absolute), index for index with `tables`: a drop adds them by file where a name cannot say which table. */
    files?: readonly string[],
  ): void {
    if (tables.length === 0) return;
    this.pendingLibraryDrag = { tables: [...tables], ...(files !== undefined && files.length === tables.length ? { files: [...files] } : {}), at: Date.now() };
    const message: LibraryDragStartedMessage = { type: 'libraryDragStarted', payload: { tables: [...tables] } };
    for (const [panelKey, panel] of Array.from(this.openPanels.entries())) {
      if (!panel.loaded || panel.activeStage !== 'logical' || this.disposedWebviews.has(panel.webview) || this.forgetIfGone(panelKey)) continue;
      this.post(panel.webview, message);
    }
  }

  /** The remembered Table Library drag's tables (and their files, when it knew them), if it is still fresh; forgotten either way. */
  private takeLibraryDrag(): { tables: string[]; files?: string[] } | undefined {
    const pending = this.pendingLibraryDrag;
    this.pendingLibraryDrag = undefined;
    return pending && Date.now() - pending.at <= PENDING_LIBRARY_DRAG_MS
      ? { tables: pending.tables, ...(pending.files ? { files: pending.files } : {}) }
      : undefined;
  }

  /**
   * A drop on the canvas (`dropTables`): the Table Library drag of the last
   * minute when the drop says it is one (`fromLibrary`), else the table files
   * among the dropped URIs, else that remembered drag. Tables already on
   * the diagram are selected and named; the rest are added through the Add
   * Existing Tables edit with their positions at the drop point (one edit,
   * one undo step), and the first of them is selected.
   */
  private async handleDropTables(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey: string,
    payload: DropTablesMessage['payload'],
  ): Promise<void> {
    try {
      const dropped = tablesOfDroppedUris(payload.uris, this.tableLibraryService.listTableFiles());
      // The drop uses the library drag up, whichever way its tables came.
      const drag = this.takeLibraryDrag();
      const draggedSafe = (drag?.tables ?? []).map((name) => validateTableNameSafety(name) === null);
      const dragged = (drag?.tables ?? []).filter((_name, i) => draggedSafe[i]);
      const fromDrag = payload.fromLibrary === true && dragged.length > 0;
      // Table files whose name alone cannot say which table (another schema folder has a table of
      // their name, or the diagram shows a namesake): added by their files. A Table Library drag's
      // own files, when it gave them; any other drop's dropped files. Names only where there are none.
      const draggedFiles = drag?.files?.filter((_file, i) => draggedSafe[i]);
      const byFile = fromDrag
        ? draggedFiles !== undefined ? this.tableFilesToAddByFile(document, draggedFiles.map((f) => this.workspaceRelative(f))) : undefined
        : this.tableFilesToAddByFile(document, tableFilesOfDroppedUris(payload.uris, this.tableLibraryService.listTableFiles()).map((f) => this.workspaceRelative(f.filePath)));
      if (byFile && byFile.rest.length === 0) {
        telemetry.feature('addModel');
        await this.queueEdit(panelKey, async () => {
          const added = await this.addTableFiles(document, webview, byFile.files, { dropAt: payload.position });
          if (added.length > 0) this.post(webview, { type: 'revealTable', payload: { modelName: added[0] } } satisfies RevealTableMessage);
        });
        return;
      }
      // A Table Library drag is what its controller collected: VS Code gives the
      // drop the files of the dragged table rows only, never a schema or layer
      // row's tables. Any other drop (an Explorer file) is its files, whatever
      // was dragged in the library before it.
      const names = payload.fromLibrary === true && dragged.length > 0 ? dragged : dropped.length > 0 ? dropped : dragged;
      if (names.length === 0) {
        void vscode.window.showInformationMessage(DROP_TABLES_NOTHING_MESSAGE);
        return;
      }
      const membersOf = (): Set<string> =>
        new Set((subjectAreaTableNames(document.getText(), document.uri.fsPath) ?? []).map(normaliseName));
      const members = membersOf();
      const fresh = names.filter((name) => !members.has(normaliseName(name)));
      if (fresh.length === 0) {
        this.post(webview, { type: 'revealTable', payload: { modelName: names[0] } } satisfies RevealTableMessage);
        void vscode.window.showInformationMessage(alreadyOnDiagramMessage(names));
        return;
      }
      telemetry.feature('addModel');
      // Every name goes to the add, so its note names the ones already here.
      await this.queueEdit(panelKey, () => this.handleAddExistingModels(document, webview, names, { dropAt: payload.position }));
      // Selected only once it is on the diagram: a refused add has said why.
      const after = membersOf();
      const added = fresh.find((name) => after.has(normaliseName(name)));
      if (added !== undefined) {
        this.post(webview, { type: 'revealTable', payload: { modelName: added } } satisfies RevealTableMessage);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Dropping tables failed: ${message}`, err);
      recordHandlerFailure('model', err);
      this.post(webview, { type: 'error', payload: { message: `Failed to add the dropped tables: ${message}` } });
    }
  }

  /** Run a table action on a loaded canvas of `uri` now, or hold it for its `ready`. */
  private async runTableAction(uri: vscode.Uri, action: { reveal: string; add?: string[] }): Promise<void> {
    const open = Array.from(this.openPanels.entries()).find(([, p]) =>
      p.loaded && !this.disposedWebviews.has(p.webview) && samePath(p.document.uri.fsPath, uri.fsPath));
    if (!open) {
      this.pendingTableActions.set(uri.fsPath, { ...action, at: Date.now() });
      return;
    }
    await this.applyTableAction(open[0], action);
  }

  private async applyTableAction(panelKey: string, action: { reveal: string; add?: string[] }): Promise<void> {
    const panel = this.openPanels.get(panelKey);
    if (!panel) return;
    if (panel.activeStage !== 'logical') {
      await this.handleSwitchStage(panelKey, panel.document, panel.webview, 'logical');
    }
    let reveal = action.reveal;
    if (action.add) {
      const add = action.add;
      const membersOf = (): Set<string> =>
        new Set((subjectAreaTableNames(panel.document.getText(), panel.document.uri.fsPath) ?? []).map(normaliseName));
      const before = membersOf();
      const fresh = add.filter((name) => !before.has(normaliseName(name)));
      if (fresh.length === 0) {
        // All there already: select the first and say so, briefly.
        void vscode.window.showInformationMessage(alreadyOnDiagramMessage(add));
      } else {
        // Every name goes to the add, so its note names the ones already here.
        await this.queueEdit(panelKey, () => this.handleAddExistingModels(panel.document, panel.webview, add));
        const after = membersOf();
        const added = fresh.find((name) => after.has(normaliseName(name)));
        // A refused add has said why: nothing to select.
        if (added === undefined) return;
        reveal = added;
      }
    }
    this.post(panel.webview, { type: 'revealTable', payload: { modelName: reveal } } satisfies RevealTableMessage);
  }

  /** Run the table action held for the diagram at `fsPath`, if it is still fresh. */
  private flushPendingTableAction(fsPath: string, panelKey: string): void {
    for (const [key, pending] of Array.from(this.pendingTableActions.entries())) {
      if (!samePath(key, fsPath)) continue;
      this.pendingTableActions.delete(key);
      if (Date.now() - pending.at <= PENDING_REVEAL_MS) {
        const { at: _at, ...action } = pending;
        void this.applyTableAction(panelKey, action).catch((err: unknown) => {
          log.error(`[SemanticEditorProvider] Table action failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  /** Post the reveal held for the diagram at `fsPath`, if it is still fresh. */
  private flushPendingReveal(fsPath: string, webview: vscode.Webview): void {
    for (const [key, pending] of Array.from(this.pendingReveals.entries())) {
      if (!samePath(key, fsPath)) continue;
      this.pendingReveals.delete(key);
      if (Date.now() - pending.at <= PENDING_REVEAL_MS) {
        this.post(webview, { type: 'revealRelationship', payload: pending.target } satisfies RevealRelationshipMessage);
      }
    }
  }

  /** Drop everything kept for one canvas (on its dispose, or when it is found gone). */
  private forgetPanel(panelKey: string, webview: vscode.Webview): void {
    this.disposedWebviews.add(webview);
    // Only this panel's entry: another canvas of the same file may have replaced it.
    if (this.openPanels.get(panelKey)?.webview === webview) this.openPanels.delete(panelKey);
    if (this.lastActivePanelKey === panelKey && !this.openPanels.has(panelKey)) this.lastActivePanelKey = undefined;
    this.editedTablePaths.delete(panelKey);
    this.deletedTablePaths.delete(panelKey);
    this.undoWhileHeld.delete(panelKey);
    clearTimeout(this.nativeUndoTimers.get(panelKey));
    this.nativeUndoTimers.delete(panelKey);
    this.lastLoadError.delete(panelKey);
  }

  /**
   * Redraw every open canvas of the diagram at `fsPath`. Nothing in the
   * extension calls it since positions moved into the diagram's `erd_layout`
   * (a change to the diagram reaches its canvas through its document); kept
   * for the callers outside it (the guard suite's held-refresh check).
   */
  async refreshSubjectAreaPanel(fsPath: string): Promise<void> {
    if (this.refreshHolds > 0) { this.droppedRefreshes++; return; }
    for (const [panelKey, { document, webview, activeStage }] of Array.from(this.openPanels.entries())) {
      if (this.disposedWebviews.has(webview) || !samePath(document.uri.fsPath, fsPath) || this.forgetIfGone(panelKey)) continue;
      try {
        if (activeStage === 'physical') {
          await this.handleSwitchStage(panelKey, document, webview, 'physical');
        } else {
          await this.sendSubjectAreaData(document, webview, panelKey);
        }
      } catch (err) {
        log.error(`[SemanticEditorProvider] Refresh failed for ${fsPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * The canvas Run dbt parse's **Open Physical view** would switch: the one
   * that asked (`origin`) while it is open, else the canvas last active;
   * only a live canvas on the Logical stage, and never in a logical-only
   * window.
   */
  physicalSwitchTarget(origin?: vscode.Uri): vscode.Uri | undefined {
    if (this.logicalOnly) return undefined;
    const originKey = origin?.toString();
    const key = originKey && this.openPanels.has(originKey) ? originKey : this.lastActivePanelKey;
    const panel = key ? this.openPanels.get(key) : undefined;
    if (!panel || this.disposedWebviews.has(panel.webview) || panel.activeStage !== 'logical') return undefined;
    return panel.document.uri;
  }

  /** The canvas that asked is open on the Physical stage. */
  originIsPhysical(origin?: vscode.Uri): boolean {
    if (!origin) return false;
    const panel = this.openPanels.get(origin.toString());
    return !!panel && !this.disposedWebviews.has(panel.webview) && panel.activeStage === 'physical';
  }

  /**
   * Bring the open canvas for `uri` to the front (its own editor group, with
   * focus): Run dbt parse's **Open Physical view** can target a canvas in a
   * background tab. False when no live canvas is open for it.
   */
  revealCanvas(uri: vscode.Uri): boolean {
    const entry = this.openPanels.get(uri.toString());
    if (!entry?.panel || this.disposedWebviews.has(entry.webview)) return false;
    entry.panel.reveal(undefined, false);
    return true;
  }

  /**
   * Switch the stage of an open editor panel identified by its document URI.
   * Called by extension.ts when opening a domain from the tree in physical stage.
   * Uses a small delay to allow the webview to initialise first.
   */
  switchStageForUri(uri: vscode.Uri, stage: Stage): void {
    const panelKey = uri.toString();

    // The panel may not be registered yet if the editor is still initialising.
    // Retry a few times with a short delay.
    let attempts = 0;
    const trySwitch = () => {
      const panel = this.openPanels.get(panelKey);
      if (panel) {
        void this.handleSwitchStage(panelKey, panel.document, panel.webview, stage);
        return;
      }
      attempts++;
      if (attempts < 10) {
        setTimeout(trySwitch, 100);
      } else {
        log.error(`[SemanticEditorProvider] switchStageForUri: panel not found for ${panelKey} after ${attempts} attempts`);
      }
    };
    trySwitch();
  }

  // -------------------------------------------------------------------------
  // Mutation handlers
  // -------------------------------------------------------------------------

  private async handleAddModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: AddModelMessage['payload'],
    stage: 'logical',
  ): Promise<void> {
    try {
      const { schemaFolder, ...given } = payload;
      let model: DesignTable = given;
      // Validate the payload before anything touches disk: the model name
      // becomes a file name under logical-models/, and column names are used
      // as keys by every later edit/remove path.
      const nameError = validateTableName(model.name);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${nameError}` } });
        return;
      }
      const columnsError = validateColumnDefs(model.columns ?? []);
      if (columnsError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${columnsError}` } });
        return;
      }
      if (model.modelRole != null && !isValidTableRole(model.modelRole)) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add table: unknown role "${String(model.modelRole)}".` } });
        return;
      }
      const schemaError = validateSchemaFolderPayload(schemaFolder);
      if (schemaError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${schemaError}` } });
        return;
      }
      model = { ...model, name: model.name.trim() };

      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      const section = this.getStageSection(parsed, stage);

      // V5: create central model file + add name reference to domain
      if (this.isSubjectAreaV5(parsed)) {
        const modelNames = (section.models ?? []) as string[];
        const inDomain = modelNames.find((n) => sameName(n, model.name));
        if (inDomain !== undefined) {
          webview.postMessage({ type: 'error', payload: { message: `Table "${inDomain}" already exists in this diagram.` } });
          return;
        }
        // A new table's name follows the authoring rule (a letter first).
        // The model library is shared across domains — never overwrite a
        // logical-models/{name}.yml that another domain may depend on. Case is
        // ignored: `DimDate` next to `dimdate.yml` is one file on macOS/Windows.
        const inLibrary = this.tableLibraryService.findTableNameIgnoringCase(model.name);
        if (inLibrary !== null) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Table "${inLibrary}" already exists in the Table Library (${this.libraryRelativePath(inLibrary)}). ` +
                'Use "Add Existing Tables" to add it to this diagram, or, for a separate table also called ' +
                `${model.name}, name it ${sameTableName(model.name, document.uri.fsPath)} and set its warehouse name to ${model.name}.`,
            },
          });
          return;
        }

        // Central model file — written via the same WorkspaceEdit as the domain
        // change so creating the model is a single, atomic, undoable step.
        // A DBML table's schema folder is the one the dialog named (`configuredSchema`:
        // transient, never written; a YAML table drops it), else the diagram's layer.
        const semanticModel: DbmlDraftTable = {
          name: model.name,
          schema: model.schema,
          description: model.description,
          columns: model.columns,
          ...(model.modelRole ? { modelRole: model.modelRole } : {}),
          ...(schemaFolder !== undefined ? { configuredSchema: schemaFolder } : {}),
        };

        // Add name reference + position to domain file
        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            names.push(model.name);
            sec.models = names;

            const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
            const positions = (vc.positions ?? {}) as Record<string, NodePosition>;
            const relationships = (sec.relationships ?? []) as Relationship[];
            const computed = computeNewTablePositions({
              newModels: [model.name],
              relationships,
              existingPositions: positions,
            });
            if (computed[model.name]) {
              vc.positions = { ...positions, ...computed };
              p.viewConfig = vc;
            }
          },
          // A new table (D-4): never an edit of a table of its name in another schema folder.
          { refreshWebview: true, webview, stage, modelFiles: { save: [{ model: semanticModel, create: true }] } },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add the table to this diagram.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;

          if (models.some((m) => typeof m.name === 'string' && sameName(m.name, model.name))) {
            webview.postMessage({
              type: 'error',
              payload: { message: `Table "${model.name}" already exists in this diagram.` },
            });
            throw new EditAborted();
          }

          models.push({
            name: model.name,
            schema: model.schema,
            description: model.description,
            columns: model.columns,
            ...(model.modelRole ? { modelRole: model.modelRole } : {}),
          });

          sec.models = models;

          // Compute position for the new model
          const viewConfig = (p.viewConfig ?? {}) as Record<string, unknown>;
          const existingPositions = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
          const relationships = (sec.relationships ?? []) as Relationship[];
          const computed = computeNewTablePositions({
            newModels: [model.name],
            relationships,
            existingPositions,
          });
          if (computed[model.name]) {
            viewConfig.positions = { ...existingPositions, ...computed };
            p.viewConfig = viewConfig;
          }
        },
        {
          webview,
          stage,
          errorLabel: 'Failed to add the table to this diagram.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add model failed: ${message}`, err);
      recordHandlerFailure('model', err);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add table: ${message}` },
      });
    }
  }

  private validateColumnDef(column: Pick<ColumnDef, 'name' | 'dataType'>): string | null {
    return validateColumnDefPayload(column);
  }

  private async handleAddColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; column: ColumnDef },
    stage: 'logical',
  ): Promise<void> {
    try {
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({ type: 'error', payload: { message: validationError } });
        return;
      }

      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          if (columns.some((c) => sameName(c.name, payload.column.name))) {
            throw new Error(`Column "${payload.column.name}" already exists.`);
          }
          columns.push({
            name: payload.column.name,
            dataType: payload.column.dataType,
            description: payload.column.description,
            ...(payload.column.isPrimaryKey ? { isPrimaryKey: true } : {}),
            ...(payload.column.isForeignKey ? { isForeignKey: true } : {}),
            ...(payload.column.isNaturalKey ? { isNaturalKey: true } : {}),
          });
          model.columns = columns;
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add column.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" not found.` } });
            throw new EditAborted();
          }

          const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
          if (columns.some((c) => typeof c.name === 'string' && sameName(c.name, payload.column.name))) {
            webview.postMessage({ type: 'error', payload: { message: `Column "${payload.column.name}" already exists.` } });
            throw new EditAborted();
          }

          columns.push({
            name: payload.column.name,
            dataType: payload.column.dataType,
            description: payload.column.description,
            ...(payload.column.isPrimaryKey ? { isPrimaryKey: true } : {}),
            ...(payload.column.isForeignKey ? { isForeignKey: true } : {}),
            ...(payload.column.isNaturalKey ? { isNaturalKey: true } : {}),
          });
          model.columns = columns;
        },
        { webview, stage, errorLabel: 'Failed to add column.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add column failed: ${message}`, err);
      recordHandlerFailure('column', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add column: ${message}` } });
    }
  }

  private async handleUpdateColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; oldColumnName: string; column: UpdateColumnPayloadColumn },
    stage: 'logical',
  ): Promise<void> {
    try {
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({ type: 'error', payload: { message: validationError } });
        return;
      }

      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);

      // V5: write column update to central model file, cascade rename to domain
      if (this.isSubjectAreaV5(parsed)) {
        const columnRenamed = payload.oldColumnName !== payload.column.name;
        const domainMutator = columnRenamed ? (section: Record<string, unknown>) => {
          renameColumnInSubjectAreaRelationships(
            (section.relationships ?? []) as Array<Record<string, unknown>>,
            payload.modelName, payload.oldColumnName, payload.column.name,
          );
        } : undefined;

        // The relationships of the library name the table as the library does (its library reference).
        const table = this.canvasTable(document, payload.modelName);
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
          if (columnIndex === -1) throw new Error(`Column "${payload.oldColumnName}" not found.`);
          if (columnRenamed && columns.some((c, i) => i !== columnIndex && sameName(c.name, payload.column.name))) {
            throw new Error(`Column "${payload.column.name}" already exists.`);
          }
          const existing = columns[columnIndex];
          // Omitted (undefined) keeps the existing value; explicit null clears it.
          const newScd = payload.column.scdType === undefined ? existing.scdType : payload.column.scdType;
          const newAdditive = payload.column.additiveType === undefined ? existing.additiveType : payload.column.additiveType;
          columns[columnIndex] = {
            name: payload.column.name,
            dataType: payload.column.dataType,
            description: payload.column.description,
            ...(payload.column.isPrimaryKey ?? existing.isPrimaryKey ? { isPrimaryKey: true } : {}),
            ...(payload.column.isForeignKey ?? existing.isForeignKey ? { isForeignKey: true } : {}),
            ...(payload.column.isNaturalKey ?? existing.isNaturalKey ? { isNaturalKey: true } : {}),
            ...(newScd != null ? { scdType: newScd } : {}),
            ...(newAdditive ? { additiveType: newAdditive } : {}),
            // Metadata is edited by `updateMeta` only; a column edit carries it across.
            ...(existing.meta ? { meta: existing.meta } : {}),
          } as ColumnDef;
          if (columnRenamed) {
            this.asLibraryNamed(model, table, (named) => renameColumnInRelationships([named], table.library, payload.oldColumnName, payload.column.name));
          }
        }, domainMutator, columnRenamed
          // Library relationships in other models that point at the renamed column (#126).
          ? this.otherLibrarySaves(table, (others) => renameColumnInRelationships(others, table.library, payload.oldColumnName, payload.column.name))
          : [],
        // And the copies other diagrams keep of their own (#133 L5), under what each calls the table.
        columnRenamed ? (other, storage, members) => {
          const name = this.nameOnOtherDiagram(table, storage, members);
          return name !== undefined && renameColumnInSubjectAreaRelationships(stageRelationships(other), name, payload.oldColumnName, payload.column.name);
        } : undefined);
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update column.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" not found.` } });
            throw new EditAborted();
          }

          const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
          const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
          if (columnIndex === -1) {
            webview.postMessage({ type: 'error', payload: { message: `Column "${payload.oldColumnName}" not found.` } });
            throw new EditAborted();
          }

          if (payload.oldColumnName !== payload.column.name) {
            if (columns.some((c, i) => i !== columnIndex && typeof c.name === 'string' && sameName(c.name, payload.column.name))) {
              webview.postMessage({ type: 'error', payload: { message: `Column "${payload.column.name}" already exists.` } });
              throw new EditAborted();
            }
          }

          const existingPK = columns[columnIndex].isPrimaryKey;
          const existingFK = columns[columnIndex].isForeignKey;
          const existingNK = columns[columnIndex].isNaturalKey;
          const newPK = payload.column.isPrimaryKey ?? existingPK;
          const newFK = payload.column.isForeignKey ?? existingFK;
          const newNK = payload.column.isNaturalKey ?? existingNK;
          // Omitted (undefined) keeps the existing value; explicit null clears it.
          const existingScd = columns[columnIndex].scdType as ColumnDef['scdType'];
          const existingAdditive = columns[columnIndex].additiveType as ColumnDef['additiveType'];
          const newScd = payload.column.scdType === undefined ? existingScd : payload.column.scdType;
          const newAdditive = payload.column.additiveType === undefined ? existingAdditive : payload.column.additiveType;
          columns[columnIndex] = {
            name: payload.column.name,
            dataType: payload.column.dataType,
            description: payload.column.description,
            ...(newPK ? { isPrimaryKey: true } : {}),
            ...(newFK ? { isForeignKey: true } : {}),
            ...(newNK ? { isNaturalKey: true } : {}),
            ...(newScd != null ? { scdType: newScd } : {}),
            ...(newAdditive ? { additiveType: newAdditive } : {}),
          };

          // Cascade column rename into relationships (matched without case)
          if (payload.oldColumnName !== payload.column.name) {
            renameColumnInSubjectAreaRelationships(
              (section.relationships ?? []) as Array<Record<string, unknown>>,
              payload.modelName, payload.oldColumnName, payload.column.name,
            );
          }
        },
        { webview, stage, errorLabel: 'Failed to update column.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update column failed: ${message}`, err);
      recordHandlerFailure('column', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update column: ${message}` } });
    }
  }

  private async handleRemoveColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; columnName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);

      // V5: write to central model file, cascade orphaned relationships in the domain.
      // No-op silently if the column or model is already gone (e.g. spam-clicked delete).
      if (this.isSubjectAreaV5(parsed)) {
        // The whole library, as read before the edit: where a composite the column is part of is found
        // (named as the library's relationships name each table).
        const table = this.canvasTable(document, payload.modelName);
        const library = this.libraryTables().models;
        const ok = await this.applyTableEdit(
          document,
          webview,
          payload.modelName,
          (model) => {
            const columns = model.columns ?? [];
            const idx = columns.findIndex((c) => c.name === payload.columnName);
            if (idx === -1) return;
            columns.splice(idx, 1);
            this.asLibraryNamed(model, table, (named) => removeColumnRelationships([named], table.library, payload.columnName, library));
          },
          (sec) => {
            // A composite key loses all its members with one column (#133 L2), the library's included.
            // The library's tables are named by their library references: the diagram's own lines are
            // matched to them under those (and kept or dropped as they are).
            const held = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            const refs = this.diagramLibraryRefs(document);
            if (!refs) {
              sec.relationships = removeColumnFromSubjectAreaRelationships(held, payload.modelName, payload.columnName, library);
              return;
            }
            const named = held.map((r) => (typeof r.fromModel === 'string' && typeof r.toModel === 'string'
              ? { ...r, fromModel: refs.toLibrary(r.fromModel), toModel: refs.toLibrary(r.toModel) }
              : r));
            const kept = new Set(removeColumnFromSubjectAreaRelationships(named, table.library, payload.columnName, library));
            sec.relationships = held.filter((_r, i) => kept.has(named[i]));
          },
          // Library relationships in other models that point at the removed column (#126).
          this.otherLibrarySaves(table, (others) => removeColumnRelationships(others, table.library, payload.columnName, library)),
        );
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to remove column.' } });
        }
        return;
      }

      // V4: legacy inline path. Silent no-op if the model or column is already gone.
      await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) throw new EditAborted();

          const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
          const columnIndex = columns.findIndex((c) => c.name === payload.columnName);
          if (columnIndex === -1) throw new EditAborted();

          columns.splice(columnIndex, 1);
          model.columns = columns;

          section.relationships = removeColumnFromSubjectAreaRelationships(
            (section.relationships ?? []) as Array<Record<string, unknown>>, payload.modelName, payload.columnName);
        },
        { webview, stage, errorLabel: 'Failed to remove column.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Remove column failed: ${message}`, err);
      recordHandlerFailure('column', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove column: ${message}` } });
    }
  }

  private async handleToggleColumnKey(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; columnName: string; keyType: 'PK' | 'FK' | 'NK'; value: boolean },
    stage: 'logical',
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);

      // V5: write to central model file
      if (this.isSubjectAreaV5(parsed)) {
        const fieldMap: Record<string, keyof ColumnDef> = { PK: 'isPrimaryKey', FK: 'isForeignKey', NK: 'isNaturalKey' };
        const fieldName = fieldMap[payload.keyType];
        if (!fieldName) throw new Error(`Unknown key type "${String(payload.keyType)}".`);
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const column = columns.find((c) => c.name === payload.columnName);
          if (!column) throw new Error(`Column "${payload.columnName}" not found.`);
          if (payload.value) {
            (column as unknown as Record<string, unknown>)[fieldName] = true;
          } else {
            delete (column as unknown as Record<string, unknown>)[fieldName];
          }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to toggle key type.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" not found.` } });
            throw new EditAborted();
          }

          const fieldMap: Record<string, string> = { PK: 'isPrimaryKey', FK: 'isForeignKey', NK: 'isNaturalKey' };
          const fieldName = fieldMap[payload.keyType];
          if (!fieldName) {
            webview.postMessage({ type: 'error', payload: { message: `Unknown key type "${String(payload.keyType)}".` } });
            throw new EditAborted();
          }
          const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
          const column = columns.find((c) => c.name === payload.columnName);

          if (!column) {
            webview.postMessage({ type: 'error', payload: { message: `Column "${payload.columnName}" not found.` } });
            throw new EditAborted();
          }

          if (payload.value) {
            column[fieldName] = true;
          } else {
            delete column[fieldName];
          }
        },
        { webview, stage, errorLabel: 'Failed to toggle key type.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Toggle key failed: ${message}`, err);
      recordHandlerFailure('key', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to toggle key type: ${message}` } });
    }
  }

  private async handleReorderColumns(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; orderedNames: string[] },
    stage: 'logical',
  ): Promise<void> {
    try {
      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          if (payload.orderedNames.length !== columns.length) {
            throw new Error(`Column count mismatch: expected ${columns.length}, got ${payload.orderedNames.length}.`);
          }
          const columnMap = new Map(columns.map((c) => [c.name, c]));
          model.columns = payload.orderedNames.map((name) => {
            const col = columnMap.get(name);
            if (!col) throw new Error(`Column "${name}" not found in table "${payload.modelName}".`);
            return col;
          });
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to reorder columns.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            throw new Error(`Table "${payload.modelName}" not found.`);
          }

          const columns = (model.columns ?? []) as Array<Record<string, unknown>>;

          if (payload.orderedNames.length !== columns.length) {
            throw new Error(`Column count mismatch: expected ${columns.length}, got ${payload.orderedNames.length}.`);
          }

          const columnMap = new Map<string, Record<string, unknown>>();
          for (const col of columns) {
            columnMap.set(col.name as string, col);
          }

          const reordered: Array<Record<string, unknown>> = [];
          for (const name of payload.orderedNames) {
            const col = columnMap.get(name);
            if (!col) {
              throw new Error(`Column "${name}" not found in table "${payload.modelName}".`);
            }
            reordered.push(col);
          }

          model.columns = reordered;
        },
        { refreshWebview: true, webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to reorder columns.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Reorder columns failed: ${message}`, err);
      recordHandlerFailure('column', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to reorder columns: ${message}` } });
    }
  }

  private async handleAddRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: AddRelationshipMessage['payload'],
    stage: 'logical',
  ): Promise<void> {
    try {
      const { markKey, extraPairs, relationshipsFile, ...rest } = payload;
      const drawn: Relationship = {
        fromModel: rest.fromModel, fromColumn: rest.fromColumn, toModel: rest.toModel, toColumn: rest.toColumn,
        cardinality: rest.cardinality, ...(rest.role !== undefined ? { role: rest.role } : {}),
      };
      // What the library calls the two tables (the planner's names, which the dialog's pick is checked against).
      const stored = this.libraryRelationship(document, drawn);
      // The dialog's "Stored in" pick (DBML): checked now, against the files as they are.
      let newRefFile: NewRefFileChoice | undefined;
      if (relationshipsFile !== undefined) {
        const chosen = this.chosenRelationshipsFile(stored, relationshipsFile);
        if ('error' in chosen) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to add relationship: ${chosen.error}` } });
          return;
        }
        const pairs = [{ fromColumn: drawn.fromColumn, toColumn: drawn.toColumn }, ...(extraPairs ?? [])];
        newRefFile = {
          file: chosen.path,
          links: pairs.map((p) => linkKey({ fromModel: stored.fromModel, fromColumn: p.fromColumn, toModel: stored.toModel, toColumn: p.toColumn })),
        };
      }
      const written = await this.commitRelationshipWrite(
        document, webview,
        { kind: 'add', drawn, ...(markKey ? { markKey } : {}), ...(extraPairs?.length ? { extraPairs } : {}) },
        stage, 'Failed to add relationship.', undefined, newRefFile,
      );
      if (written?.home === 'library') this.sayWhereRelationshipLanded(stored);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add relationship failed: ${message}`, err);
      this.recordRelationshipFailure(err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add relationship: ${message}` } });
    }
  }

  /**
   * The relationships file `relPath` (relative to the semantic dir) the New
   * Relationship dialog picked for `drawn`, when it may hold it: the project
   * stores DBML, the table holding the foreign key is a DBML table, and the
   * file is an existing, readable relationships file inside the semantic dir
   * (`TableLibraryService.chosenRelationshipsFile`). Its listed spelling, or
   * why not.
   */
  private chosenRelationshipsFile(drawn: Relationship, relPath: string): { path: string } | { error: string } {
    if (this.tableLibraryService.projectStorage() === 'yaml') {
      return { error: 'this project keeps its relationships in its YAML table files, so there is no relationships file to choose.' };
    }
    const fk = foreignKeyEnd(drawn).model;
    if (this.tableLibraryService.tableStorage(fk) === 'yaml') {
      return { error: `${fk} is a YAML table: its relationships are kept in its own file, not a relationships file.` };
    }
    return this.tableLibraryService.chosenRelationshipsFile(relPath, (filePath) => projectRelative(this.workspaceRoot, filePath));
  }

  /**
   * After a new relationship is saved in a relationships file (DBML), say
   * which file and line in the status bar for a few seconds
   * (`TableLibraryService.relationshipLocation`, read after the write). A
   * relationship kept in its table's own YAML file has no such line: nothing is said.
   */
  private sayWhereRelationshipLanded(rel: Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>): void {
    try {
      const at = this.tableLibraryService.relationshipLocation(rel);
      if (!at) return;
      vscode.window.setStatusBarMessage(relationshipSavedMessage(projectRelative(this.workspaceRoot, at.filePath), at.line), RELATIONSHIP_SAVED_STATUS_MS);
    } catch (err) {
      log.warn(`[SemanticEditorProvider] where the relationship was saved: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Write one relationship edit (#133), or several as one (#163's Turn
   * Round, folded by `planRelationshipWrites`): `planRelationshipWrite` decides it
   * from this domain file's relationships and the model library, inside one
   * `applySubjectAreaEdit` — the domain file and every model file it changes are
   * one WorkspaceEdit and one undo step. In a project that keeps
   * relationships in the model library (#126, v5 only) the link is stored
   * once in its many side's file and any copy in this domain file is folded
   * in; otherwise it stays in the domain file. Throws with a plain message.
   * Returns the model files changed, or null when nothing was written.
   */
  private async commitRelationshipWrite(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    op: RelationshipWriteOp | readonly RelationshipWriteOp[],
    stage: 'logical',
    errorLabel: string,
    /** Called as soon as VS Code applies the edit, before it saves (Turn Round's "was it made?"). */
    onApplied?: () => void,
    /** DBML: the relationships file the New Relationship dialog picked for the relationship being added (placement only). */
    newRefFile?: NewRefFileChoice,
  ): Promise<{ home: 'library' | 'domain'; changed: SemanticTable[] } | null> {
    // Several ops (Turn round all, #163) are folded into one plan, so they are one edit and one undo step.
    // Told apart by identity, the planner sees every table under its library reference, and the
    // diagram's names for its members are turned into those on the way in and back on the way out.
    const refs = this.diagramLibraryRefs(document);
    const ops: readonly RelationshipWriteOp[] = (Array.isArray(op) ? op : [op as RelationshipWriteOp])
      .map((o) => (refs ? relationshipOpRenamed(o, refs.toLibrary) : o));
    // A JSON diagram's ends are bare names: one two schema folders share cannot say which table (owner decision F).
    if (!refs && this.schemaScoped() && !this.isDbmlDocument(document)) {
      for (const o of ops) relationshipOpRenamed(o, (name) => { this.refuseSharedNameOnJsonDiagram(name); return name; });
    }
    const parsed = this.parseSubjectAreaDocument(document);
    const v5 = this.isSubjectAreaV5(parsed);
    const library = v5 ? this.libraryTables() : undefined;
    const models = library?.models ?? [];
    // A DBML diagram always stores relationships in the library (D5).
    const home = v5 && this.relationshipsInLibrary(models, document) ? 'library' : 'domain';
    const dbt = await this.loadDbtKeyIndex();
    // Filled by the mutator, which applySubjectAreaEdit runs before it reads modelFiles.
    const save: TableFileSave[] = [];
    let grouped: { count: number; compositeKey: string } | undefined;
    let audit: RelationshipAudit | undefined;
    const success = await this.applySubjectAreaEdit(
      document,
      (section) => {
        const held = (section.relationships ?? []) as Relationship[];
        const input: RelationshipWriteInput = { home, models, domainRelationships: refs ? held.map((r) => relationshipEndsRenamed(r, refs.toLibrary)) : held, dbt };
        const { plan, steps } = ops.length === 1
          ? (() => {
            const single = planRelationshipWrite(ops[0], input);
            return { plan: single, steps: single.ok ? [{ op: ops[0], input, plan: single }] : [] };
          })()
          : planRelationshipWrites(ops, input);
        if (!plan.ok) {
          if (plan.reason === 'keysWin') telemetry.feature('relSwapRefusedKey');
          throw new EditRefused(plan.missingModel ? this.tableUnavailableMessage(plan.missingModel) : plan.error);
        }
        // Self-check of each planned step (#133 telemetry): recorded and logged, never blocking or altering the edit.
        const usage: RelationshipAudit['usage'] = [];
        for (const step of steps) {
          const stepAudit = auditRelationshipWrite(step.op, step.input, step.plan, v5 ? step.input.models : (section.models ?? []) as SemanticTable[]);
          usage.push(...stepAudit.usage);
          if (stepAudit.broken.length > 0) {
            telemetry.relationshipInvariants(stepAudit.broken);
            log.warn(`[SemanticEditorProvider] relationship self-check (${step.op.kind}): ${stepAudit.broken.join(', ')}`);
          }
          audit = { ...stepAudit, usage };
        }
        if (plan.inlineMarkKey) {
          // A v4 domain keeps its models inline: the key is marked there.
          const inline = ((section.models ?? []) as SemanticTable[]).findIndex((m) => sameName(m.name, plan.inlineMarkKey!.model));
          if (inline === -1) throw new EditRefused(`Table "${plan.inlineMarkKey.model}" not found.`);
          const marked = markPrimaryKey((section.models as SemanticTable[])[inline], plan.inlineMarkKey.columns);
          if (typeof marked === 'string') throw new EditRefused(marked.replace('{was}', ops[0].kind === 'add' ? 'added' : 'changed'));
          (section.models as SemanticTable[])[inline] = marked;
        }
        if (plan.domainRelationships) {
          const planned = refs ? plan.domainRelationships.map((r) => relationshipEndsRenamed(r, refs.toDiagram)) : plan.domainRelationships;
          // A DBML diagram's object holds only its pending relationships (D27), which an edit may keep or
          // remove but never add or change; the writer refuses anything else.
          if (home === 'library' && this.isDbmlDocument(document)) {
            const identity = (r: Relationship): string => [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? ''].map((p) => String(p ?? '').toLowerCase()).join('\u0000');
            const held = new Set(((section.relationships ?? []) as Relationship[]).map(identity));
            if (planned.some((r) => !held.has(identity(r)))) {
              throw new EditRefused('A DBML diagram holds no relationships; they live in the table library.');
            }
          }
          section.relationships = planned;
        }
        save.push(...plan.changed.map((model) => (library ? library.save(model) : { model })));
        grouped = plan.grouped;
      },
      { webview, stage, errorLabel, modelFiles: { save, ...(newRefFile ? { newRefFile } : {}) }, onUnsaved: () => telemetry.error('relWriteFailed'), onApplied },
    );
    if (success) telemetry.relationshipUsage(audit?.usage ?? []);
    else telemetry.error('relWriteFailed');
    if (success && grouped) {
      // Single links taken into a composite key (#133 L2), e.g. after a 1.6.7 save split it.
      void vscode.window.showInformationMessage(
        `Grouped ${grouped.count} existing relationship${grouped.count === 1 ? '' : 's'} into ${grouped.compositeKey}.`,
      );
    }
    return success ? { home, changed: save.map((entry) => entry.model) } : null;
  }

  /**
   * `drawn` with each end named as the library's relationships name it
   * (its library reference where the library tells tables apart by
   * identity), for the lookups that read the library after a write.
   */
  private libraryRelationship<T extends Pick<Relationship, 'fromModel' | 'toModel'>>(document: vscode.TextDocument, drawn: T): T {
    const refs = this.diagramLibraryRefs(document);
    return refs ? relationshipEndsRenamed(drawn, refs.toLibrary) : drawn;
  }

  private async handleRenameModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { oldName: string; newName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      const nameError = validateTableName(payload.newName);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: nameError } });
        return;
      }
      const trimmedNew = payload.newName.trim();
      if (trimmedNew === payload.oldName) {
        return;
      }

      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      const section = this.getStageSection(parsed, stage);

      // V5: rename central model file + update domain references
      if (this.isSubjectAreaV5(parsed)) {
        // A case-only rename (`dimdate` → `DimDate`) is refused: on macOS and
        // Windows the new file IS the old one, and the rename's write-new +
        // delete-old edit would delete the model.
        if (sameName(trimmedNew, payload.oldName)) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `"${trimmedNew}" differs from "${payload.oldName}" only in upper/lower case, which cannot be renamed in place. ` +
                'Rename it to a different name first, then to the one you want.',
            },
          });
          return;
        }
        const currentNames = (section.models ?? []) as string[];
        const inDomain = currentNames.find((n) => sameName(n, trimmedNew));
        if (inDomain !== undefined) {
          webview.postMessage({ type: 'error', payload: { message: `Table "${inDomain}" already exists in this diagram.` } });
          return;
        }
        // The model library is shared across domains — renaming onto an
        // existing yml would silently replace another domain's model.
        const inLibrary = this.tableLibraryService.findTableNameIgnoringCase(trimmedNew);
        if (inLibrary !== null) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Table "${inLibrary}" already exists in the Table Library (${this.libraryRelativePath(inLibrary)}). ` +
                'Choose a different name, or use "Add Existing Tables" to add it to this diagram.',
            },
          });
          return;
        }
        // The member's own file, renamed by its identity where the library tells tables apart by it.
        const table = this.canvasTable(document, payload.oldName);
        // A JSON diagram cannot say which of two tables of a shared name it means (owner decision F).
        if (this.schemaScoped() && !this.isDbmlDocument(document)) this.refuseSharedNameOnJsonDiagram(table.name);
        const existingModel = this.canvasModel(table);
        if (!existingModel) {
          webview.postMessage({ type: 'error', payload: { message: this.tableUnavailableMessage(payload.oldName, table) } });
          return;
        }
        const dbmlDiagram = subjectAreaStorageOf(document.uri.fsPath) === 'dbml';
        const renamedModel: import('../types/semantic').SemanticTable = { ...existingModel, name: trimmedNew };
        // Library relationships that point at the model — its own self-references
        // and every other model's — follow the rename (#126). Told apart by identity
        // (as the Explorer's rename does), they keep the table's old library reference,
        // which the plan follows to the renamed file, so a new name another schema
        // folder's table has can never be read as that table.
        if (!table.id) renameTableInRelationships([renamedModel], payload.oldName, trimmedNew);
        const pointingAtIt: TableFileSave[] = table.id
          ? []
          : renameTableInRelationships(this.otherLibraryTables(payload.oldName), payload.oldName, trimmedNew).map((model) => ({ model }));
        // Told apart by identity, the other DBML diagrams follow the rename by the file their `use`
        // lines read (the settle); a JSON diagram names tables by name alone, and follows it only
        // when its name reads this table (the library's first file of the name).
        const byName = this.tableLibraryService.findTableFile(table.name);
        const followsByName = !table.filePath || (byName !== null && samePath(byName, table.filePath));
        // The diagram's own name for the table after the rename: its new name, or `<schema>.<name>`
        // while another member still shares it.
        const members = dbmlDiagram && table.id ? this.parseSubjectAreaFile(document).members : undefined;
        const renamed = members?.renaming(table.ref, trimmedNew);
        const newRef = renamed?.ref ?? trimmedNew;

        // Update domain (model reference name, relationships, positions) and
        // create-new + delete-old yml in one WorkspaceEdit so the rename is atomic
        // and a single undo restores both files.
        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
            if (renamed) {
              // Every reference the rename changes (its own, and a namesake's that no longer needs its schema).
              renameMemberRefs(p, renamed.renames);
              return;
            }
            const names = (sec.models ?? []) as string[];
            const idx = names.indexOf(payload.oldName);
            if (idx !== -1) names[idx] = trimmedNew;

            renameTableInSubjectAreaRelationships(
              (sec.relationships ?? []) as Array<Record<string, unknown>>, payload.oldName, trimmedNew);

            const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
            const positions = (vc.positions ?? {}) as Record<string, unknown>;
            if (payload.oldName in positions) {
              positions[trimmedNew] = positions[payload.oldName];
              delete positions[payload.oldName];
            }
            // A DBML diagram's sticky notes name the table they point at (`linked_table`): they follow it.
            if (dbmlDiagram) relinkSticky(p, payload.oldName, trimmedNew);
          },
          {
            refreshWebview: true,
            webview,
            stage,
            // fromName carries the OLD file's YAML document (comments, key
            // order, unknown keys) across to the new path — see
            // TableLibraryService.serializeTable.
            modelFiles: {
              save: [
                { model: renamedModel, fromName: table.name, ...(table.id ? { from: table.id } : {}) },
                ...pointingAtIt,
              ],
              delete: [table.id ?? payload.oldName],
            },
            ...(renamed && renamed.renames.size > 0 ? { renamedMembers: renamed.renames } : {}),
            // Every other diagram that names the model follows the rename —
            // its model list, position and own relationship copies (#133 L5).
            otherDomains: table.id
              ? (other, storage) => storage === 'json' && followsByName && renameTableInSubjectArea(other, table.name, trimmedNew, storage)
              : (other, storage) => renameTableInSubjectArea(other, payload.oldName, trimmedNew, storage),
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
          // The canvas selects the table by the name it gave it; one that keeps its schema is selected under it.
          if (newRef !== trimmedNew) this.post(webview, { type: 'revealTable', payload: { modelName: newRef } });
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to rename table.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.oldName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Table "${payload.oldName}" not found.` } });
            throw new EditAborted();
          }
          if (models.some((m) => m !== model && typeof m.name === 'string' && sameName(m.name, trimmedNew))) {
            webview.postMessage({ type: 'error', payload: { message: `Table "${trimmedNew}" already exists in this diagram.` } });
            throw new EditAborted();
          }

          model.name = trimmedNew;

          renameTableInSubjectAreaRelationships(
            (sec.relationships ?? []) as Array<Record<string, unknown>>, payload.oldName, trimmedNew);

          const viewConfig = (p.viewConfig ?? {}) as Record<string, unknown>;
          const positions = (viewConfig.positions ?? {}) as Record<string, unknown>;
          if (payload.oldName in positions) {
            positions[trimmedNew] = positions[payload.oldName];
            delete positions[payload.oldName];
          }
        },
        {
          webview,
          stage,
          errorLabel: 'Failed to rename table.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Rename model failed: ${message}`, err);
      recordHandlerFailure('model', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to rename table: ${message}` } });
    }
  }

  /** Single-model removal — thin wrapper over the batch handler. */
  private async handleRemoveModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
    stage: 'logical',
  ): Promise<void> {
    return this.handleRemoveModels(
      document,
      webview,
      { modelNames: [payload.modelName] },
      stage,
    );
  }

  /**
   * Batch-remove one or more models in a single document edit.
   * Cascades all relationships referencing any listed model and prunes the
   * shared viewConfig (their stored positions, plus any annotation whose
   * `linkedModel` pointed at them) via `pruneViewConfigForRemovedTables`, the
   * same helper in both the V5 and V4 arms. Produces one WorkspaceEdit (one
   * undo step, one save) regardless of how many models are deleted.
   *
   * In V5, after the domain is updated, prompts the user once to optionally
   * delete the underlying logical-models/*.yml files for any names that exist
   * on disk. Singular/plural copy is chosen automatically.
   */
  private async handleRemoveModels(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelNames: string[] },
    stage: 'logical',
  ): Promise<void> {
    const namesSet = new Set(payload.modelNames);
    if (namesSet.size === 0) return;
    // A relationship spelling a removed model in another case goes with it (#133 L4).
    const namesLower = new Set(payload.modelNames.map((n) => n.toLowerCase()));
    const isSingle = namesSet.size === 1;
    const errorLabel = isSingle ? 'model' : 'models';

    try {
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);

      if (this.isSubjectAreaV5(parsed)) {
        // Each removed member's own file, found while it is still on the diagram: the "delete its
        // file too?" offer names that file (two schema folders may each hold a table of its name).
        const removedTables = this.schemaScoped() && this.isDbmlDocument(document)
          ? [...namesSet].flatMap((name) => {
            try {
              return [this.canvasTable(document, name)];
            } catch {
              return [];
            }
          })
          : undefined;
        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
            const models = (sec.models ?? []) as string[];
            sec.models = models.filter((name) => !namesSet.has(name));

            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = relationships.filter(
              (rel) => !namesLower.has(String(rel.fromModel).toLowerCase()) && !namesLower.has(String(rel.toModel).toLowerCase()),
            );

            pruneViewConfigForRemovedTables(p, namesSet, subjectAreaStorageOf(document.uri.fsPath) === 'dbml');
          },
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${errorLabel}.` } });
          return;
        }

        this.selectorsService.scheduleRegenerate();

        // Single batched prompt for any underlying table files. A `.dbml`
        // table's file goes with its relationships and every use line that
        // names it, in diagrams and relationships files (D16).
        // Told apart by identity, each table is offered by its own file and deleted by its identity.
        const offered: Array<string | TableId> = removedTables
          ? removedTables.flatMap((t): Array<string | TableId> => (t.id ? [t.id] : this.tableLibraryService.tableExists(t.name) ? [t.name] : []))
          : [...namesSet].filter((name) => this.tableLibraryService.tableExists(name));
        const offeredFile = (t: string | TableId): string => (typeof t === 'string' ? this.tableLibraryService.tablePath(t) : this.tableLibraryService.findTableById(t)!.filePath);
        const filesToOffer = offered.map((t) => (typeof t === 'string' ? t : t.name));
        if (filesToOffer.length > 0) {
          const fileIsSingle = filesToOffer.length === 1;
          const dbmlTables = offered.filter((t) => this.tableLibraryService.tableStorage(t) === 'dbml');
          const cascade = dbmlTables.length > 0 ? this.describeDbmlDeleteCascade(dbmlTables) : '';
          const prompt = fileIsSingle
            ? `Removed "${filesToOffer[0]}" from this diagram. It stays in the Table Library for other diagrams. Delete its table file too?${cascade}`
            : `Removed ${filesToOffer.length} tables from this diagram. They stay in the Table Library for other diagrams. Delete their table files too?${cascade}`;
          const deleteLabel = fileIsSingle ? 'Delete Table File' : 'Delete Table Files';
          const keepLabel = fileIsSingle ? 'Keep File' : 'Keep Files';
          const panelKey = document.uri.toString();
          void vscode.window
            .showInformationMessage(prompt, deleteLabel, keepLabel)
            .then(async (choice) => {
              if (choice !== deleteLabel) return;
              // Captured before the delete: afterwards the folder is unknowable.
              const filePaths = offered.map(offeredFile);
              const shownPaths = offered.map((t) => (typeof t === 'string' ? this.libraryRelativePath(t) : this.tableLibraryService.libraryRelativePath(offeredFile(t))));
              const deleteFiles = async (): Promise<void> => {
                // A DBML table: the D16 cascade, one WorkspaceEdit through applyFileWrites.
                if (offered.some((t) => this.tableLibraryService.tableStorage(t) === 'dbml')) {
                  let result: { ok: boolean; unrestored: string[] };
                  try {
                    // In this canvas's queue, anchored on its diagram while it is open:
                    // Cmd+Z here then rewinds the delete before the remove (#274).
                    result = await this.runQueued(panelKey, () =>
                      this.deleteTablesWithCascade(offered, this.deleteOriginOf(document)));
                  } catch (err) {
                    void vscode.window.showErrorMessage(`Could not delete ${shownPaths.join(', ')}: ${err instanceof Error ? err.message : String(err)}`);
                    return;
                  }
                  if (result.ok) {
                    vscode.window.showInformationMessage(fileIsSingle ? `Deleted ${shownPaths[0]}` : `Deleted ${filesToOffer.length} table files`);
                    return;
                  }
                  // Files left half-deleted: the reconcile's modal names them, and "nothing was deleted" would contradict it.
                  if (result.unrestored.length > 0) return;
                  const again = await vscode.window.showErrorMessage(tableFileDeleteFailedMessage(shownPaths), 'Try Again');
                  if (again === 'Try Again') await deleteFiles();
                  return;
                }
                // Delete through one WorkspaceEdit (applyFileWrites, D23) so VS Code
                // snapshots the files and the deletion is undoable, rather than a
                // bare unlink; a partial apply is put back before anything is said.
                // Anchored on this canvas's diagram like the DBML cascade (#274).
                const deleted = await this.runQueued(panelKey, () =>
                  this.deleteTableFilesFromCanvas(filePaths, this.deleteOriginOf(document)));
                if (deleted.ok) {
                  vscode.window.showInformationMessage(fileIsSingle ? `Deleted ${shownPaths[0]}` : `Deleted ${filesToOffer.length} table files`);
                  return;
                }
                // Files the reconcile could not put back are named in its modal; "nothing was deleted" would contradict it.
                if (deleted.unrestored.length > 0) return;
                // applyEdit gives no reason, so none is guessed (#205); the reconcile put every file back.
                const choice = await vscode.window.showErrorMessage(
                  tableFileDeleteFailedMessage(shownPaths),
                  'Try Again',
                  ...(fileIsSingle ? ['Reveal in Explorer'] : []),
                );
                if (choice === 'Try Again') await deleteFiles();
                if (choice === 'Reveal in Explorer') await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(filePaths[0]));
              };
              await deleteFiles();
            });
        }
        return;
      }

      // V4: legacy inline path
      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;
          sec.models = models.filter((m) => !namesSet.has(m.name as string));

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          sec.relationships = relationships.filter(
            (rel) => !namesLower.has(String(rel.fromModel).toLowerCase()) && !namesLower.has(String(rel.toModel).toLowerCase()),
          );

          pruneViewConfigForRemovedTables(p, namesSet);
        },
        {
          webview,
          stage,
          errorLabel: `Failed to remove ${errorLabel}.`,
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Remove ${errorLabel} failed: ${message}`, err);
      recordHandlerFailure('model', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${errorLabel}: ${message}` } });
    }
  }

  /**
   * What deleting DBML tables also removes, for the Delete Table prompts
   * (D16): the relationships the cascade drops (the deleted tables' own and
   * other DBML owners' to them; a YAML owner keeps its own) and the DBML
   * diagrams that list them. `other` words them for the canvas, whose own
   * diagram has just dropped them. A clause whose count is 0 is left out.
   */
  describeDbmlDeleteCascade(tables: ReadonlyArray<string | TableId>, other = true): string {
    // A table named by its identity is counted by it (its namesake in another schema folder is another table).
    const names = tables.filter((t): t is string => typeof t === 'string');
    const ids = new Set(tables.filter((t): t is TableId => typeof t !== 'string').map(tableIdKey));
    const lowerNames = new Set(names.map((n) => n.toLowerCase()));
    // Every Ref in the project's relationships files with an end among them: one per relationship, a composite once.
    let relationships = 0;
    for (const ref of this.tableLibraryService.relationshipsIndex().refs) {
      const end = (label: string, id: string | undefined): boolean => lowerNames.has(label) || (id !== undefined && ids.has(id));
      if (!ref.pending && (end(ref.owner, ref.ownerId) || end(ref.target, ref.targetId))) relationships++;
    }
    // Every DBML diagram listing one, from its syntax-only summary (memoised).
    const semanticRoot = this.semanticRootDir();
    let diagrams = 0;
    for (const summary of this.listOtherSubjectAreas('')) {
      if (summary.storage !== 'dbml') continue;
      const rel = path.relative(semanticRoot, summary.filePath).split(path.sep).join('/');
      const imports = diagramSummaryForFile(rel, summary.filePath, this.openDocumentText(summary.filePath));
      const members = imports === null || imports === 'unreadable' ? [] : [...imports.members, ...imports.unlinked];
      const memberIds = imports === null || imports === 'unreadable' ? [] : imports.memberPaths.map((p) => tableIdOfPath(p));
      if (members.some((m) => lowerNames.has(m.toLowerCase())) || memberIds.some((id) => id !== undefined && ids.has(tableIdKey(id)))) diagrams++;
    }
    // A count of 0 is left out, never shown (#274: "its place in 0 other diagrams").
    const single = tables.length === 1;
    const parts = [single ? "the table's file" : 'their files'];
    if (relationships > 0) parts.push(`${single ? 'its' : 'their'} ${relationships} relationship${relationships === 1 ? '' : 's'}`);
    if (diagrams > 0) parts.push(`${single ? 'its place' : 'their places'} in ${diagrams} ${other ? 'other ' : ''}diagram${diagrams === 1 ? '' : 's'}`);
    const last = parts.pop()!;
    return ` This removes ${parts.length > 0 ? `${parts.join(', ')} and ${last}` : last}.`;
  }

  /**
   * Delete Table (File) for tables that include DBML ones (D16): the files,
   * the Refs they own, other DBML owners' Refs to them, and every `use` line
   * naming them (relationships files and DBML diagrams, with their positions
   * and sticky-note links), as ONE WorkspaceEdit (its own undo step). JSON
   * diagrams are neither read nor written: they name tables, and a deleted
   * one shows as a placeholder there, as for a YAML table. Returns false when
   * VS Code did not apply it (reconciled by applyFileWrites). A file that
   * could not be saved afterwards is reported, never ignored.
   *
   * `origin` is the canvas that asked (Delete Table File after Remove from
   * Diagram), while it is still open: its diagram is then the edit's primary
   * (its rewrite, or the one-character undo anchor when the cascade leaves it
   * as it is), so the step tops the canvas's own undo stack. Cmd+Z there
   * rewinds the delete first, and the remove only after it, so no undo ever
   * brings back a `use` line for a file that is gone (#274). The caller runs
   * it in that canvas's edit queue. The Table Library's Delete Table passes
   * none: no canvas asked, and the cascade is its own step in each file.
   */
  async deleteTablesWithCascade(tables: ReadonlyArray<string | TableId>, origin?: DeleteOrigin): Promise<{ ok: boolean; unrestored: string[] }> {
    // Diagrams lose a table named by name wherever they list that name. One named by its identity
    // whose name another schema folder's table shares is left to the settle, which finds each
    // diagram's member by the file its `use` line reads, so the namesake stays where it is.
    const names = tables.flatMap((t) => (typeof t === 'string' ? [t] : this.tableLibraryService.isAmbiguousName(t.name) ? [] : [t.name]));
    const lowerNames = new Set(names.map((n) => n.toLowerCase()));
    const readText = (filePath: string): string | null => this.openOrDiskText(filePath);
    let writes: FileWrite[];
    try {
      const lib = this.tableLibraryService.planTableWrites(this.tableLibraryService.dbmlDeleteCascadeOps(tables), undefined, { readText });
      const plan = lib.plan ?? this.tableLibraryService.planTableWrites(undefined, undefined, { dbml: true, readText }).plan!;
      const resolver = this.resolverOf(plan);
      const diagrams = this.rewriteOtherSubjectAreaWrites('', (parsed) => {
        const logical = (parsed.logical ?? {}) as Record<string, unknown>;
        const models = Array.isArray(logical.models) ? (logical.models as unknown[]) : [];
        const removed = new Set(models.filter((m): m is string => typeof m === 'string' && lowerNames.has(m.toLowerCase())));
        if (removed.size === 0) return false;
        logical.models = models.filter((m) => !(typeof m === 'string' && removed.has(m)));
        pruneViewConfigForRemovedTables(parsed, removed, true);
        return true;
      }, resolver, { dbmlOnly: true, plan });
      // Every other diagram whose imports the cut Refs change (§2.6).
      const settled = this.settleDbmlDiagrams('', new Set(diagrams.map((w) => path.resolve(w.path))), plan);
      writes = [...lib.writes, ...diagrams, ...settled];
    } catch (err) {
      throw this.refusalOf(err);
    }
    const originPath = origin?.document.uri.fsPath;
    // The canvas's own diagram, when the settle pass rewrites it: its text is the primary's (a replace of the primary's path is never sent twice).
    const originRewrite = origin ? writes.find((w) => w.kind === 'replace' && samePath(w.path, originPath!)) : undefined;
    const originText = originRewrite?.kind === 'replace' ? originRewrite.text : origin?.document.getText();
    const dirty = dirtyFiles([...writes.map((w) => w.path), ...(originPath ? [originPath] : [])]);
    if (dirty.length > 0) {
      throw new EditRefused(`${path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/')} has unsaved changes. Save or revert it, then try again.`);
    }
    // The watchers wait for these files instead of deciding while the saves
    // run (one per diagram listing the table), so none is taken for an
    // outside change before its record is made.
    const expectation = this.ownWriteTracker.expectWrite([...writes.map((w) => w.path), ...(originPath ? [originPath] : [])]);
    // The anchor's change event is this edit's, not an outside one to save and send again.
    const hold = origin !== undefined && !this.pendingUpdates.get(origin.panelKey);
    if (hold) this.pendingUpdates.set(origin!.panelKey, true);
    const unsaved: string[] = [];
    const saveFailures = new Set<SaveFailure>();
    let modelFileUnsaved = false;
    let applied: AppliedFileWrites;
    try {
      applied = await applyFileWrites(writes, {
        semanticRoot: this.semanticRootDir(),
        ...(origin ? { primary: { document: origin.document, text: originText! } } : {}),
      });
      // Not applied: `unrestored` lists the files the reconcile could not put back (its modal already named them).
      if (!applied.ok) return { ok: false, unrestored: applied.unrestored };
      // Creates and deletes landed with the edit itself: recorded before the saves.
      for (const filePath of applied.created) this.ownWriteTracker.recordWrite(filePath);
      for (const filePath of applied.deleted) this.ownWriteTracker.recordDelete(filePath);
      if (origin) {
        // The anchor (or the rewrite) left the diagram dirty: saved like the rest.
        if (await saveDocument(origin.document, (reason) => saveFailures.add(reason))) {
          this.ownWriteTracker.recordWrite(originPath!);
        } else {
          unsaved.push(originPath!);
        }
        this.rememberCanvasWrites(origin.panelKey, applied);
      }
      for (const uri of applied.replaced) {
        if (await saveDocumentByUri(uri, (reason) => saveFailures.add(reason))) {
          this.ownWriteTracker.recordWrite(uri.fsPath);
        } else {
          unsaved.push(uri.fsPath);
          if (this.isLibraryPath(uri.fsPath)) modelFileUnsaved = true;
        }
      }
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
      if (hold) this.pendingUpdates.delete(origin!.panelKey);
    }
    if (unsaved.length > 0) {
      for (const code of saveFailureCodes(saveFailures, { modelFile: modelFileUnsaved })) telemetry.error(code);
      void vscode.window.showErrorMessage(this.describeUnsaved(unsaved));
    }
    const written = [...writtenPaths(applied), ...(originRewrite ? [originPath!] : [])];
    this.tableLibraryService.invalidatePaths(written);
    this.tableLibraryService.primeRelationshipsFiles(written);
    await this.refreshAllOpenSubjectAreas();
    for (const uri of applied.replaced) this._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: true });
    if (origin) this._onDidWriteSubjectArea.fire({ uri: origin.document.uri, modelLibraryChanged: true });
    return { ok: true, unrestored: [] };
  }

  /**
   * The diagram a Delete Table File prompt came from, while a canvas is open
   * on it and its file exists: the delete then anchors on it
   * ({@link deleteTablesWithCascade}). Decided by the document, not by the
   * webview that showed the prompt: a second canvas on the same diagram, or
   * the canvas closed and reopened before the (non-modal) prompt is answered,
   * shares its undo stack, so it anchors on the live canvas's document.
   * Undefined when no canvas is open on it: a closed document is never
   * reopened, dirtied and saved for an anchor, nor a deleted diagram
   * recreated (#161).
   */
  private deleteOriginOf(document: vscode.TextDocument): DeleteOrigin | undefined {
    const panelKey = document.uri.toString();
    const open = this.openPanels.get(panelKey);
    if (!open || this.disposedWebviews.has(open.webview) || this.forgetIfGone(panelKey)) return undefined;
    const live = open.document;
    if ((live as { isClosed?: boolean }).isClosed || !fs.existsSync(live.uri.fsPath)) return undefined;
    return { document: live, panelKey };
  }

  /**
   * Remember what a canvas's anchored edit wrote, so its Cmd+Z / toolbar
   * Undo flushes exactly those documents ({@link saveDirtyTableDocuments})
   * and redraws when a file it deleted comes back ({@link flushUndoRedo}).
   */
  private rememberCanvasWrites(panelKey: string, applied: Pick<AppliedFileWrites, 'replaced' | 'created' | 'deleted'>): void {
    const ourPaths = this.editedTablePaths.get(panelKey) ?? new Set<string>();
    for (const uri of applied.replaced) ourPaths.add(uri.fsPath);
    for (const filePath of applied.created) ourPaths.add(filePath);
    if (ourPaths.size > 0) this.editedTablePaths.set(panelKey, ourPaths);
    if (applied.deleted.length === 0) return;
    const deleted = this.deletedTablePaths.get(panelKey) ?? new Set<string>();
    for (const filePath of applied.deleted) deleted.add(filePath);
    this.deletedTablePaths.set(panelKey, deleted);
  }

  /**
   * Delete Table File for YAML tables after Remove from Diagram: the files,
   * as one WorkspaceEdit anchored on the canvas's diagram while it is open
   * (`origin`), so Cmd+Z there brings them back before it undoes the remove
   * (#274). The diagram's anchor is saved with the edit; nothing else is
   * written. The deletes are left to the library watcher, as before.
   */
  private async deleteTableFilesFromCanvas(filePaths: readonly string[], origin: DeleteOrigin | undefined): Promise<AppliedFileWrites> {
    const writes = filePaths.map((filePath): FileWrite => ({ kind: 'delete', path: filePath }));
    if (!origin || origin.document.isDirty) return applyFileWrites(writes);
    const fsPath = origin.document.uri.fsPath;
    const expectation = this.ownWriteTracker.expectWrite([fsPath]);
    const hold = !this.pendingUpdates.get(origin.panelKey);
    if (hold) this.pendingUpdates.set(origin.panelKey, true);
    try {
      const applied = await applyFileWrites(writes, { primary: { document: origin.document, text: origin.document.getText() } });
      if (!applied.ok) return applied;
      const saveFailures = new Set<SaveFailure>();
      if (await saveDocument(origin.document, (reason) => saveFailures.add(reason))) {
        this.ownWriteTracker.recordWrite(fsPath);
      } else {
        for (const code of saveFailureCodes(saveFailures, { modelFile: false })) telemetry.error(code);
        void vscode.window.showErrorMessage(this.describeUnsaved([fsPath]));
      }
      this.rememberCanvasWrites(origin.panelKey, applied);
      return applied;
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
      if (hold) this.pendingUpdates.delete(origin.panelKey);
    }
  }

  /** Run `fn` in a panel's edit queue, after the edits already queued, and return its result. */
  private runQueued<T>(panelKey: string, fn: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    return this.queueEdit(panelKey, async () => {
      try {
        outcome = { ok: true, value: await fn() };
      } catch (error) {
        outcome = { ok: false, error };
      }
    }).then(() => {
      if (!outcome!.ok) throw outcome!.error;
      return outcome!.value;
    });
  }

  /** Single-relationship removal — thin wrapper over the batch handler. */
  private async handleRemoveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: RelationshipKey,
    stage: 'logical',
  ): Promise<void> {
    return this.handleRemoveRelationships(document, webview, { relationships: [payload] }, stage);
  }

  /**
   * Batch-remove one or more relationships in a single document edit — one
   * WorkspaceEdit (one undo step, one save, one webview refresh) regardless of
   * how many edges a multi-select delete covers. Keys that no longer exist are
   * skipped; it is an error only when none of them matched (which keeps the
   * single-edge "Relationship not found." behaviour).
   */
  private async handleRemoveRelationships(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { relationships: RelationshipKey[] },
    stage: 'logical',
  ): Promise<void> {
    const keys = payload.relationships.filter(
      (k): k is RelationshipKey =>
        !!k &&
        typeof k.fromModel === 'string' && typeof k.fromColumn === 'string' &&
        typeof k.toModel === 'string' && typeof k.toColumn === 'string',
    );
    if (keys.length === 0) return;
    const label = keys.length === 1 ? 'relationship' : 'relationships';

    try {
      // Every copy of the link, either way round, in this domain file and the
      // model library — which takes it off every domain that shows it (#126, #133).
      const written = await this.commitRelationshipWrite(
        document, webview, { kind: 'remove', keys }, stage, `Failed to remove ${label}.`,
      );
      if (written?.home === 'library') this.noteDiagramsStillDrawing(document, keys);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Remove ${label} failed: ${message}`, err);
      this.recordRelationshipFailure(err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${label}: ${message}` } });
    }
  }

  /**
   * After a delete in a project that keeps relationships in the model
   * library: name the other diagrams that still draw the link from a copy of
   * their own (#133). They are the user's to change — this only tells them,
   * and writes nothing.
   */
  private noteDiagramsStillDrawing(document: vscode.TextDocument, keys: readonly RelationshipKey[]): void {
    try {
      const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
      // Compared the way the file system does: VS Code may spell the open file's path in another case.
      const others = readSubjectAreaRelationships(this.subjectAreaService, this.workspaceRoot, semanticDir)
        .filter((d) => !samePath(d.filePath, document.uri.fsPath));
      const labels = diagramsStillDrawing(keys, others);
      if (labels.length === 0) return;
      telemetry.feature('relDeleteStillDrawn');
      const what = keys.length === 1 ? 'this relationship' : 'one of these relationships';
      void vscode.window.showInformationMessage(labels.length === 1
        ? `Deleted. The diagram ${labels[0]} still draws ${what} from a copy of its own. Delete it there too if it should go everywhere.`
        : `Deleted. These diagrams still draw ${what} from copies of their own: ${labels.join(', ')}. ` +
          'Delete those copies too if it should go everywhere.');
    } catch (err) {
      log.error('[SemanticEditorProvider] Could not check other diagrams after a delete:', err);
    }
  }

  /** Usage telemetry: a relationship handler threw something other than a refusal it explained. */
  private recordRelationshipFailure(err: unknown): void {
    recordHandlerFailure('relationship', err);
  }

  private async handleUpdateRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality },
    stage: 'logical',
  ): Promise<void> {
    try {
      await this.commitRelationshipWrite(
        document, webview, { kind: 'update', ends: payload, cardinality: payload.cardinality }, stage, 'Failed to update relationship.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update relationship failed: ${message}`, err);
      this.recordRelationshipFailure(err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update relationship: ${message}` } });
    }
  }

  private async handleEditRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: EditRelationshipMessage['payload'],
    stage: 'logical',
  ): Promise<void> {
    try {
      const original = {
        fromModel: payload.originalFromModel,
        fromColumn: payload.originalFromColumn,
        toModel: payload.originalToModel,
        toColumn: payload.originalToColumn,
      };
      const drawn: Relationship = {
        fromModel: payload.fromModel,
        fromColumn: payload.fromColumn,
        toModel: payload.toModel,
        toColumn: payload.toColumn,
        cardinality: payload.cardinality,
        ...(payload.role !== undefined ? { role: payload.role } : {}),
      };
      await this.commitRelationshipWrite(
        document, webview,
        {
          kind: 'edit', original, drawn,
          ...(payload.markKey ? { markKey: payload.markKey } : {}),
          ...(payload.extraPairs?.length ? { extraPairs: payload.extraPairs } : {}),
        },
        stage, 'Failed to edit relationship.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Edit relationship failed: ${message}`, err);
      this.recordRelationshipFailure(err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to edit relationship: ${message}` } });
    }
  }

  /**
   * Persist model positions (and, optionally, annotation positions moved in
   * the same drag) in ONE WorkspaceEdit so a multi-drag is one undo step.
   * No webview refresh — the canvas already shows the dragged state.
   */
  private async handleUpdatePositions(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    positions: Record<string, { x: number; y: number }>,
    annotations: AnnotationPositionPayload[] = [],
  ): Promise<void> {
    const start = Date.now();
    let layoutOnly = false;
    if (this.isDbmlDocument(document)) {
      // erd_layout holds one name per line (§1.6): a name it cannot hold is not saved.
      const dropped = Object.keys(positions).filter((name) => !isErdLayoutName(name) || name.startsWith(ERD_LAYOUT_NOTE_PREFIX));
      if (dropped.length > 0) log.warn(`[SemanticEditorProvider] Positions of ${plural(dropped.length, 'table')} not saved in ${document.uri.fsPath}: erd_layout cannot hold ${dropped.map((n) => JSON.stringify(n)).join(', ')}`);
    }
    try {
      const written = await this.applySubjectAreaEdit(
        document,
        (_section, parsed) => {
          const existingViewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const existingPositions = (existingViewConfig.positions ?? {}) as Record<string, unknown>;
          // Every table dropped where it already was, and no note moved: nothing to write.
          const unmoved = Object.entries(positions).every(([name, p]) => {
            const old = existingPositions[name] as { x?: unknown; y?: unknown } | undefined;
            return old?.x === p.x && old?.y === p.y;
          });
          if (unmoved && annotations.length === 0) throw new EditAborted();
          // Merge incoming positions over disk positions — prevents concurrent tabs from
          // clobbering each other's saves when using the shared global viewConfig.
          const mergedPositions = { ...existingPositions, ...positions };
          parsed.viewConfig = { ...existingViewConfig, positions: mergedPositions };

          if (annotations.length > 0) {
            const existing = (existingViewConfig.annotations ?? []) as Array<Record<string, unknown>>;
            for (const moved of annotations) {
              const ann = existing.find((a) => a.id === moved.id);
              if (!ann) continue; // deleted meanwhile — nothing to move
              ann.x = Math.round(moved.x);
              ann.y = Math.round(moved.y);
            }
          }
        },
        { refreshWebview: false, webview, stage: 'logical', errorLabel: 'Failed to save layout positions.', onLayoutOnly: () => { layoutOnly = true; } },
      );
      const what = [
        ...(Object.keys(positions).length > 0 ? [plural(Object.keys(positions).length, 'table')] : []),
        ...(annotations.length > 0 ? [plural(annotations.length, 'note')] : []),
      ].join(' and ');
      canvasLog.info(written
        ? `Saved the positions of ${what} in ${document.uri.fsPath} in ${elapsedMs(start)} ms${layoutOnly ? ' (layout only)' : ''}`
        : `Positions of ${what} in ${document.uri.fsPath} unchanged or not saved (${elapsedMs(start)} ms)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Position update failed: ${message}`, err);
      recordHandlerFailure('layout', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to save positions: ${message}` } });
    }
  }

  // ---------------------------------------------------------------------------
  // Annotation handlers (build notes in viewConfig)
  // ---------------------------------------------------------------------------

  private async handleAddAnnotation(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { id: string; text: string; x: number; y: number; color?: string; width?: number; height?: number; linkedModel?: string },
  ): Promise<void> {
    try {
      await this.applySubjectAreaEdit(
        document,
        (_section, parsed) => {
          const vc = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const annotations = (vc.annotations ?? []) as Array<Record<string, unknown>>;
          if (annotations.some((a) => a.id === payload.id)) throw new EditAborted();
          annotations.push({
            id: payload.id,
            text: payload.text,
            x: Math.round(payload.x),
            y: Math.round(payload.y),
            ...(payload.color ? { color: payload.color } : {}),
            ...(payload.width != null ? { width: payload.width } : {}),
            ...(payload.height != null ? { height: payload.height } : {}),
            ...(payload.linkedModel ? { linkedModel: payload.linkedModel } : {}),
          });
          vc.annotations = annotations;
          parsed.viewConfig = vc;
        },
        { webview, stage: 'logical', errorLabel: 'Failed to add annotation.' },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add annotation failed: ${msg}`, err);
      recordHandlerFailure('annotation', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add annotation: ${msg}` } });
    }
  }

  private async handleUpdateAnnotation(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { id: string; text?: string; color?: string; linkedModel?: string | null; width?: number; height?: number },
  ): Promise<void> {
    try {
      let found = true;
      await this.applySubjectAreaEdit(
        document,
        (_section, parsed) => {
          const vc = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const annotations = (vc.annotations ?? []) as Array<Record<string, unknown>>;
          const ann = annotations.find((a) => a.id === payload.id);
          if (!ann) {
            found = false;
            throw new EditAborted();
          }

          if (payload.text !== undefined) ann.text = payload.text;
          if (payload.color !== undefined) ann.color = payload.color;
          if (payload.width !== undefined) ann.width = payload.width;
          if (payload.height !== undefined) ann.height = payload.height;
          if (payload.linkedModel === null) {
            delete ann.linkedModel;
          } else if (payload.linkedModel !== undefined) {
            ann.linkedModel = payload.linkedModel;
          }

          parsed.viewConfig = vc;
        },
        { webview, stage: 'logical', errorLabel: 'Failed to update annotation.' },
      );
      if (!found) {
        // Annotation not found — re-sync webview with current disk state
        await this.sendSubjectAreaData(document, webview);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update annotation failed: ${msg}`, err);
      recordHandlerFailure('annotation', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update annotation: ${msg}` } });
    }
  }

  /**
   * Batch-remove one or more annotations in a single document edit — one
   * WorkspaceEdit (one undo step, one save, one webview refresh) regardless of
   * how many notes a multi-select delete covers. Unknown ids are ignored.
   */
  private async handleRemoveAnnotations(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { ids: string[] },
  ): Promise<void> {
    const ids = new Set(payload.ids.filter((id): id is string => typeof id === 'string'));
    if (ids.size === 0) return;
    const label = ids.size === 1 ? 'annotation' : 'annotations';

    try {
      await this.applySubjectAreaEdit(
        document,
        (_section, parsed) => {
          const vc = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const annotations = (vc.annotations ?? []) as Array<Record<string, unknown>>;
          vc.annotations = annotations.filter((a) => !ids.has(a.id as string));
          parsed.viewConfig = vc;
        },
        { webview, stage: 'logical', errorLabel: `Failed to remove ${label}.` },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Remove ${label} failed: ${msg}`, err);
      recordHandlerFailure('annotation', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${label}: ${msg}` } });
    }
  }

  /** `filePath` (absolute) relative to the workspace, `/`-separated: how the Add Existing Table dialog names a row's file. */
  private workspaceRelative(filePath: string): string {
    return path.relative(this.workspaceRoot, filePath).split(path.sep).join('/');
  }

  /**
   * The Table Library files to add to the DBML diagram `document` by file,
   * for rows the dialog (or a drop) named by their files (`sourcePaths`,
   * project-relative; undefined or `''` for a row with none): only where the
   * library tells tables apart by identity, and a name alone cannot say which
   * table one of the listed DBML table files is (another schema folder has a
   * table of its name, or the diagram shows a namesake). `files` are those
   * rows' files; `rest` the indexes of the other rows (a dbt model the
   * library does not have, say), which are added by name in the same edit.
   * Undefined otherwise: every row is added by name, as it always was.
   */
  private tableFilesToAddByFile(document: vscode.TextDocument, sourcePaths: ReadonlyArray<string | undefined>): { files: TableFileEntry[]; rest: number[] } | undefined {
    if (!this.schemaScoped() || !this.isDbmlDocument(document) || sourcePaths.length === 0) return undefined;
    const files: TableFileEntry[] = [];
    const rest: number[] = [];
    sourcePaths.forEach((sourcePath, i) => {
      const entry = sourcePath === undefined || sourcePath === '' ? undefined : this.tableLibraryService.tableEntryAt(path.resolve(this.workspaceRoot, sourcePath));
      if (entry && !entry.shadowedBy && entry.storage === 'dbml' && entry.id !== undefined) files.push(entry);
      else rest.push(i);
    });
    if (files.length === 0) return undefined;
    const members = this.parseSubjectAreaFile(document).members;
    const shown = new Set((members?.rows ?? []).map((r) => r.name.toLowerCase()));
    const needsFile = files.some((f) => this.tableLibraryService.isAmbiguousName(f.name) || shown.has(f.name.toLowerCase()));
    return needsFile ? { files, rest } : undefined;
  }

  /**
   * The relationships dbt's tests give tables added to the DBML diagram
   * `document` by their files (`files`, called `added.refs` on the diagram
   * once added; `added.renames` its members' reference changes), and tables
   * added by name in the same edit (`byName.names`; `byName.newModels`
   * those seeded from dbt), between them and the diagram's members, as the
   * by-name add derives them. A dbt model is matched to a table of a name two
   * schema folders share by its schema, never by its name alone
   * (`dbtTestsOnTables`); one it cannot tell gives no relationship. Each
   * relationship is stored in the library (D5): `saves` are the seeded tables
   * (new: `create`) and each library table whose relationships change (saved
   * by its identity); `onDiagram` the relationships named as the diagram will
   * name their tables (for placement); `unstored` says what had nowhere to go.
   */
  private dbtRelationshipsForFiles(
    document: vscode.TextDocument,
    files: readonly TableFileEntry[],
    added: { refs: readonly string[]; renames: ReadonlyMap<string, string> },
    byName: { names: readonly string[]; newModels: readonly SemanticTable[] },
    ymlData: YmlData,
    manifest: ManifestData,
  ): { saves: TableFileSave[]; onDiagram: Relationship[]; unstored?: string } {
    const seeded: TableFileSave[] = byName.newModels.map((model) => ({ model, create: true }));
    // Every table the diagram will show by its file: its members (named as they will be) and the added files.
    const shown: Array<{ entry: TableFileEntry; ref: string }> = [];
    for (const row of this.parseSubjectAreaFile(document).members?.rows ?? []) {
      const entry = row.path !== undefined && !row.path.startsWith('../')
        ? this.tableLibraryService.tableEntryAt(this.tableLibraryService.semanticAbsolute(row.path))
        : undefined;
      if (entry?.id !== undefined && !entry.shadowedBy) shown.push({ entry, ref: added.renames.get(row.ref) ?? row.ref });
    }
    const memberCount = shown.length;
    files.forEach((entry, i) => shown.push({ entry, ref: added.refs[i] }));
    // The relationships are worked out under each table's library reference; the diagram's name for each is kept beside it.
    const toDiagram = new Map<string, string>(byName.names.map((name) => [name.toLowerCase(), name]));
    const tables = shown.map(({ entry, ref }): DbtMatchTable => {
      const libraryRef = this.tableLibraryService.libraryRef(entry.id!) ?? entry.name;
      toDiagram.set(libraryRef.toLowerCase(), ref);
      const model = this.tableLibraryService.getTable(entry.id!);
      return {
        ref: libraryRef,
        name: entry.name,
        schemas: [entry.id!.schema, ...(model?.schema ? [model.schema] : [])],
        ...(model?.alias ? { alias: model.alias } : {}),
        shared: this.tableLibraryService.isAmbiguousName(entry.name),
      };
    });
    const tests = dbtTestsOnTables(tables, dbtTestsOf(ymlData, manifest), ymlData, manifest, byName.names);
    const relationships = relationshipsForAddedTables(
      tables.slice(0, memberCount).map((t) => t.ref),
      [...tables.slice(memberCount).map((t) => t.ref), ...byName.names],
      tests.relationshipTests,
      tests.unique,
    );
    if (relationships.length === 0) return { saves: seeded, onDiagram: [] };
    const library = this.libraryTables();
    const byRef = new Map(library.models.map((m) => [m.name.toLowerCase(), m]));
    const { kept, changed } = routeToLibrary(relationships, byName.newModels, (ref) => byRef.get(ref.toLowerCase()) ?? null, []);
    const unstored = describeUnstoredRelationships(kept);
    const diagramName = (ref: string): string => toDiagram.get(ref.toLowerCase()) ?? ref;
    return {
      saves: [...seeded, ...changed.filter((m) => !byName.newModels.includes(m)).map(library.save)],
      onDiagram: relationships.map((r) => ({ ...r, fromModel: diagramName(r.fromModel), toModel: diagramName(r.toModel) })),
      ...(unstored ? { unstored } : {}),
    };
  }

  /**
   * Add Table Library files to the DBML diagram `document` by file (Add
   * Existing Table, "+ Add", a drop), where the library tells tables apart
   * by identity: each table is the file named, never the library's first
   * file of its name. A table the diagram already shows (the same file) is
   * named and left. A namesake from another schema folder joins as
   * `<schema>.<name>`, and the member already there is renamed to its own
   * `<schema>.<name>` in the same edit, its `use` line, position and links
   * kept (one WorkspaceEdit, one undo step). The relationships dbt's tests
   * give the added tables are stored with them, as the by-name add does
   * ({@link dbtRelationshipsForFiles}). Returns what the diagram calls each
   * table added.
   */
  private async addTableFiles(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    files: readonly TableFileEntry[],
    options: { dropAt?: NodePosition } = {},
  ): Promise<string[]> {
    const members = this.parseSubjectAreaFile(document).members;
    if (!members) return [];
    const fresh = files.filter((f, i) => f.id !== undefined && !members.memberOf(f.id) && files.findIndex((g) => samePath(g.filePath, f.filePath)) === i);
    if (fresh.length === 0) {
      const first = files[0];
      const shown = first?.id ? members.memberOf(first.id)?.ref ?? first.name : first?.name ?? '';
      this.post(webview, { type: 'error', payload: { message: `Table "${shown}" already exists in this diagram.` } });
      return [];
    }
    const { refs, renames } = members.adding(fresh.map((f) => f.id!));
    const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
    const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
    const dbt = this.dbtRelationshipsForFiles(document, fresh, { refs, renames }, { names: [], newModels: [] }, ymlData, manifest);
    const success = await this.applySubjectAreaEdit(
      document,
      (sec, p) => {
        // A namesake already on the diagram is now named by its schema too.
        renameMemberRefs(p, renames);
        sec.models = [...((sec.models ?? []) as string[]), ...refs];
        const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
        const positions = { ...((vc.positions ?? {}) as Record<string, NodePosition>) };
        if (options.dropAt) {
          Object.assign(positions, dropGridPositions(refs, options.dropAt));
        } else {
          for (const ref of refs) positions[ref] = findOpenPosition(positions);
        }
        vc.positions = positions;
        p.viewConfig = vc;
      },
      {
        refreshWebview: true,
        webview,
        stage: 'logical',
        errorLabel: 'Failed to add the table to this diagram.',
        ...(renames.size > 0 ? { renamedMembers: renames } : {}),
        ...(dbt.saves.length > 0 ? { modelFiles: { save: dbt.saves } } : {}),
      },
    );
    if (!success) return [];
    this.selectorsService.scheduleRegenerate();
    if (dbt.unstored) void vscode.window.showInformationMessage(`Added ${refs.join(', ')}. ${dbt.unstored}`);
    return refs;
  }

  private async handleAddExistingModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; sourcePath?: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      // A Table Library row, added by its file where its name alone cannot say which table.
      const byFile = this.tableFilesToAddByFile(document, [payload.sourcePath]);
      if (byFile) {
        await this.addTableFiles(document, webview, byFile.files);
        return;
      }
      // The name comes from the user's own dbt project (yml / manifest), where
      // uppercase and digit-leading names are legal, so only the path-safety
      // rule applies here — not the authoring convention. It may still be used
      // to create a logical-models/*.yml file below.
      const nameError = validateTableNameSafety(payload.modelName);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${nameError}` } });
        return;
      }

      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      const section = this.getStageSection(parsed, stage);

      // V5: add model reference to domain (create model file from manifest if needed)
      if (this.isSubjectAreaV5(parsed)) {
        const modelNames = (section.models ?? []) as string[];
        if (modelNames.includes(payload.modelName)) {
          webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" already exists in this diagram.` } });
          return;
        }

        // Seed the logical model from yml (primary) or the manifest (fallback)
        // when it is not in the library yet — the same seeding Import from dbt
        // uses (`seedTableFromDbt`). The file is NOT written here — it rides
        // in the same WorkspaceEdit as the domain change below, so a rejected
        // edit leaves no orphan yml behind and one undo removes both.
        const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
        const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
        let seededModel: import('../types/semantic').SemanticTable | undefined;
        const dbmlProblem = this.dbmlMemberProblem(document, payload.modelName);
        if (dbmlProblem) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${dbmlProblem}` } });
          return;
        }
        if (!this.tableLibraryService.tableExists(payload.modelName)) {
          const seed = seedTableFromDbt(payload.modelName, ymlData, manifest, await this.loadCatalog());
          if (!seed) {
            webview.postMessage({ type: 'error', payload: { message: this.logicalOnly
              ? `Table "${payload.modelName}" is not in the Table Library.`
              : `Table "${payload.modelName}" not found in your dbt .yml files, the manifest or the table library.` } });
            return;
          }
          seededModel = { ...seed, name: payload.modelName };
          // A DBML diagram's new table goes in its dbt custom schema's folder, when the model has one (§2.4).
          const configuredSchema = this.isDbmlDocument(document) ? configuredSchemaOf(payload.modelName, ymlData, manifest) : undefined;
          if (configuredSchema !== undefined) seededModel = { ...seededModel, configuredSchema } as DbmlDraftTable;
        }

        // Relationships from the yml and manifest relationship tests together,
        // with cardinality from the unique tests (one-to-one when both ends
        // are unique), limited to edges whose other end is in this domain.
        const tests = dbtTestsOf(ymlData, manifest);
        const existingRelationships = (section.relationships ?? []) as Relationship[];
        const added = relationshipsForAddedTables(
          modelNames,
          [payload.modelName],
          tests.relationshipTests,
          tests.unique,
          existingRelationships,
        );
        if (seededModel) seededModel = markDraftKeys(seededModel, tests.unique, added);
        const routed = this.routeAddedRelationships(document, added, seededModel ? [seededModel] : []);

        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            names.push(payload.modelName);
            sec.models = names;
            if (routed.kept.length > 0) {
              sec.relationships = [...((sec.relationships ?? []) as Relationship[]), ...routed.kept];
            }

            // Add position
            const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
            const positions = (vc.positions ?? {}) as Record<string, NodePosition>;
            const newPosition = findOpenPosition(positions);
            vc.positions = { ...positions, [payload.modelName]: newPosition };
            p.viewConfig = vc;
          },
          {
            refreshWebview: true,
            webview,
            stage,
            // The seeded table is new (D-4: never an edit of a table of its name in another schema folder); others are edits.
            ...(routed.saves.length > 0 ? { modelFiles: { save: routed.saves.map((model) => (model === seededModel ? { model, create: true } : { model })) } } : {}),
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
          if (routed.unstored) void vscode.window.showInformationMessage(`Added ${payload.modelName}. ${routed.unstored}`);
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add the table to this diagram.' } });
        }
        return;
      }

      // V4: legacy inline path — try yml first, fall back to manifest
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const catalog = await this.loadCatalog();
      const ymlModel = ymlData.models.get(payload.modelName);
      const manifestModel = manifest.models.get(payload.modelName);

      if (!ymlModel && !manifestModel) {
        webview.postMessage({
          type: 'error',
          payload: { message: this.logicalOnly
            ? `Table "${payload.modelName}" is not in the Table Library.`
            : `Table "${payload.modelName}" not found in your dbt .yml files or the manifest.` },
        });
        return;
      }

      // Use yml relationship tests as primary, fall back to manifest
      const ymlRelTests = ymlData.relationshipTests;
      const manifestRelTests = this.manifestService.getRelationshipTests();
      const relationshipTests = ymlRelTests.length > 0 ? ymlRelTests : manifestRelTests;

      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;

          if (models.some((m) => m.name === payload.modelName)) {
            webview.postMessage({
              type: 'error',
              payload: { message: `Table "${payload.modelName}" already exists in this diagram.` },
            });
            throw new EditAborted();
          }

          const viewConfig = (p.viewConfig ?? {}) as Record<string, unknown>;
          const existingPositions = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
          const newPosition = findOpenPosition(existingPositions);

          // Columns from yml (primary) or manifest (fallback), types as the
          // physical stage resolves them — the same seeding as the v5 path.
          const columns = seedTableFromDbt(payload.modelName, ymlData, manifest, catalog)?.columns ?? [];

          models.push({
            name: payload.modelName,
            schema: manifestModel?.schema ?? '',
            description: ymlModel?.description || manifestModel?.description || '',
            columns,
          });

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          const modelNames = new Set(models.map((m) => m.name as string));

          for (const test of relationshipTests) {
            if (test.fromModel !== payload.modelName && test.toModel !== payload.modelName) continue;
            if (!modelNames.has(test.fromModel) || !modelNames.has(test.toModel)) continue;
            const alreadyExists = relationships.some(
              (r) => typeof r.fromModel === 'string' && typeof r.fromColumn === 'string'
                && typeof r.toModel === 'string' && typeof r.toColumn === 'string'
                && sameLink(r as unknown as RelationshipKey, test),
            );
            if (!alreadyExists) {
              relationships.push({
                fromModel: test.fromModel, fromColumn: test.fromColumn,
                toModel: test.toModel, toColumn: test.toColumn,
                cardinality: 'many-to-one' as const,
              });
            }
          }
          sec.relationships = relationships;

          const updatedPositions = { ...existingPositions, [payload.modelName]: newPosition };
          sec.models = models;
          p.viewConfig = { ...viewConfig, positions: updatedPositions };
        },
        {
          webview,
          stage,
          errorLabel: 'Failed to add the table to this diagram.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add existing model failed: ${message}`, err);
      recordHandlerFailure('model', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${message}` } });
    }
  }

  /**
   * "Add models from dbt" — the empty canvas's primary action, a batch version
   * of Add Existing Model. Asks which dbt models with the Import from dbt picker
   * (models already in the domain left out), seeds the ones the library lacks
   * from dbt's yml / manifest and adds names, relationships and new library
   * files in ONE `applySubjectAreaEdit` — one save, one refresh, one undo step.
   *
   * An empty domain is left with no stored position for any model, so it is
   * a fresh layout: the refresh carries `autoLayout: true` and the webview
   * runs the same ELK layout as the Layout button. A domain that already has
   * models gets host placement for the new ones instead.
   *
   * Cancelling the picker writes and posts nothing.
   */
  private async handleAddModelsFromDbt(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey: string,
  ): Promise<void> {
    telemetry.feature('addFromDbtStarted');
    try {
      const parsed = this.parseSubjectAreaDocument(document);
      if (!this.isSubjectAreaV5(parsed)) {
        telemetry.feature('addFromDbtNeedsV5');
        this.post(webview, {
          type: 'error',
          payload: { message: 'Adding tables from dbt needs the central Table Library. Run "ERD Studio: Migrate Subject Areas to the Central Table Library" first.' },
        });
        return;
      }
      // A member with no table file (drawn as missing; D26 in a DBML diagram) can be made from dbt here:
      // only the members that have one are already in.
      const inDomain = ((this.getStageSection(parsed, 'logical').models ?? []) as string[])
        .filter((name) => this.tableLibraryService.tableExists(name));

      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const source = {
        ymlData,
        manifest,
        projectRoot: this.workspaceRoot,
        modelPaths: readDbtProjectConfig(this.workspaceRoot).modelPaths,
        layerIds: this.layerService.getValidLayerIds(),
      };
      const models = listDraftModels(source);
      if (models.length === 0) {
        telemetry.feature('addFromDbtNoModels');
        void vscode.window.showInformationMessage(NO_DBT_MODELS_MESSAGE);
        return;
      }
      const excluded = new Set(inDomain.map(normaliseName));
      if (models.every((m) => excluded.has(normaliseName(m.name)))) {
        telemetry.feature('addFromDbtAllPresent');
        void vscode.window.showInformationMessage('Every dbt model is already in this diagram.');
        return;
      }

      const pick = await pickDraftScope(listDraftScopes(source), {
        models,
        excludeNames: inDomain,
        title: 'Add Tables from dbt',
      });
      if (!pick) { telemetry.feature('addFromDbtCancelled'); return; }

      await this.queueEdit(panelKey, () =>
        this.applyDbtModels(document, webview, pick.modelNames, ymlData, manifest));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add models from dbt failed: ${message}`, err);
      // A refusal the toast explains (a conflicted diagram, a model file
      // with unsaved edits) is not a breakage.
      if (!isExplainedRefusal(err)) telemetry.error('addFromDbtFailed');
      // Counted (or a refusal): the boundary does not count it again.
      markRecorded(err);
      this.post(webview, { type: 'error', payload: { message: `Failed to add tables from dbt: ${message}` } });
    }
  }

  /**
   * The Add Existing Model dialog with several rows ticked (#160): the same
   * batch write as "Add models from dbt" — library models referenced, dbt-only
   * ones seeded into the library, relationships between them and the domain
   * added — in one `applySubjectAreaEdit`, so one undo removes them all. The names
   * are the user's explicit pick, so the draft's first-diagram cap does not
   * apply; the payload validator already holds them to
   * {@link ADD_EXISTING_TABLES_LIMIT}. v5 only, like the dbt batch.
   */
  private async handleAddExistingModels(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelNames: readonly string[],
    /**
     * `dropAt`: a drop on the canvas: the new tables go here (`dropTables`), not beside their relations.
     * `sourcePaths`: each picked row's file (the dialog's `sourcePath`), index for index.
     */
    options: { dropAt?: NodePosition; sourcePaths?: readonly string[] } = {},
  ): Promise<void> {
    try {
      // Rows the dialog listed from Table Library files, added by their files where a name alone cannot say which table;
      // the other rows (dbt models the library does not have) by name, in the same edit.
      const byFile = this.tableFilesToAddByFile(document, modelNames.map((_n, i) => options.sourcePaths?.[i]));
      if (byFile && byFile.rest.length === 0) {
        await this.addTableFiles(document, webview, byFile.files, options.dropAt !== undefined ? { dropAt: options.dropAt } : {});
        return;
      }
      if (!this.isSubjectAreaV5(this.parseSubjectAreaDocument(document))) {
        this.post(webview, {
          type: 'error',
          payload: { message: 'Adding several tables at once needs the central Table Library. Run "ERD Studio: Migrate Subject Areas to the Central Table Library" first, or add them one at a time.' },
        });
        return;
      }
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      await this.applyDbtModels(
        document, webview,
        byFile ? byFile.rest.map((i) => modelNames[i]) : modelNames,
        ymlData, manifest, 'picked', options.dropAt, byFile?.files,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add existing models failed: ${message}`, err);
      recordHandlerFailure('model', err);
      this.post(webview, { type: 'error', payload: { message: `Failed to add tables: ${message}` } });
    }
  }

  /**
   * The queued half of {@link handleAddModelsFromDbt} and of
   * {@link handleAddExistingModels}: build the draft against the current
   * document and write it. `'dbt'` is the empty canvas's capped first draft;
   * `'picked'` is the dialog's explicit pick, uncapped and worded without
   * "from dbt" (it may be all library models).
   */
  private async applyDbtModels(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelNames: readonly string[],
    ymlData: YmlData,
    manifest: ManifestData,
    origin: 'dbt' | 'picked' = 'dbt',
    /** Where a drop on the canvas let go: the new tables are placed there (`dropGridPositions`). */
    dropAt?: NodePosition,
    /**
     * Table Library files picked beside `modelNames` that are added by their
     * files ({@link tableFilesToAddByFile}), in the same edit: then every
     * relationship is derived as {@link dbtRelationshipsForFiles} does.
     */
    byFile?: readonly TableFileEntry[],
  ): Promise<void> {
    const fromDbt = origin === 'dbt';
    const from = fromDbt ? ' from dbt' : '';
    try {
      // Re-read inside the queue: an edit may have landed while the picker was open.
      const parsed = this.parseSubjectAreaDocument(document);
      const section = this.getStageSection(parsed, 'logical');
      // The picked files the diagram does not show yet, what it will call them, and its members' renames.
      const members = byFile ? this.parseSubjectAreaFile(document).members : undefined;
      const files = members ? byFile!.filter((f, i) => f.id !== undefined && !members.memberOf(f.id) && byFile!.findIndex((g) => samePath(g.filePath, f.filePath)) === i) : [];
      const byFileAdded = members && files.length > 0 ? members.adding(files.map((f) => f.id!)) : { refs: [] as string[], renames: new Map<string, string>() };
      // A listed member with no table file is drawn as missing: picking it makes its file, and it stays listed once.
      const existingNames = ((section.models ?? []) as string[]).filter((name) => this.tableLibraryService.tableExists(name));
      const draft = buildDbtDraft({
        modelNames,
        ymlData,
        manifest,
        // Column types as the physical stage resolves them (catalog first).
        catalog: await this.loadCatalog(),
        libraryHas: (name) => this.tableLibraryService.tableExists(name),
        existingModelNames: existingNames,
        existingRelationships: (section.relationships ?? []) as Relationship[],
        ...(fromDbt ? {} : { limit: modelNames.length, skipDisabled: false }),
      });
      // A pick is matched to the domain ignoring case, as model names are
      // unique that way, so a ticked row can already be there under another
      // case (or added since by another panel): name it rather than drop it
      // without a word. The dbt picker leaves those out up front.
      const alreadyIn = fromDbt ? [] : draft.skipped.filter((s) => s.reason === 'already-in-domain').map((s) => s.name);
      const skippedNote = [
        describeSkippedDbtModels(draft.skipped, { logicalOnly: this.logicalOnly }),
        alreadyIn.length > 0 ? `Already in this diagram: ${alreadyIn.slice(0, 5).join(', ')}${alreadyIn.length > 5 ? ` and ${alreadyIn.length - 5} more` : ''}.` : '',
      ].filter(Boolean).join(' ');
      if (draft.modelNames.length === 0 && files.length === 0) {
        if (fromDbt) telemetry.feature('addFromDbtNothingDrawable');
        this.post(webview, {
          type: 'error',
          payload: { message: `No tables were added${from}.${skippedNote ? ` ${skippedNote}` : ''}` },
        });
        return;
      }

      const dbmlProblems = draft.modelNames.map((name) => this.dbmlMemberProblem(document, name)).filter((m): m is string => m !== null);
      if (dbmlProblems.length > 0) {
        this.post(webview, { type: 'error', payload: { message: `No tables were added${from}. ${dbmlProblems[0]}${dbmlProblems.length > 1 ? ` (and ${dbmlProblems.length - 1} more)` : ''}` } });
        return;
      }
      // A DBML diagram's new tables go in their dbt custom schema's folder, when they have one (§2.4).
      const newModels = this.isDbmlDocument(document)
        ? draft.newModels.map((m) => {
          const configuredSchema = configuredSchemaOf(m.name, ymlData, manifest);
          return configuredSchema !== undefined ? { ...m, configuredSchema } : m;
        })
        : draft.newModels;
      // With picked files added by file, every relationship is worked out by identity (the files', the
      // members' and the named tables' together): a test of a name two schema folders share lands on the
      // table whose schema dbt builds, never on the library's first file of the name.
      const routed: { kept: Relationship[]; saves: TableFileSave[]; placed: Relationship[]; unstored?: string } = files.length > 0
        ? (() => {
          const dbt = this.dbtRelationshipsForFiles(document, files, byFileAdded, { names: draft.modelNames, newModels }, ymlData, manifest);
          return { kept: [], saves: dbt.saves, placed: dbt.onDiagram, ...(dbt.unstored ? { unstored: dbt.unstored } : {}) };
        })()
        : (() => {
          const byName = this.routeAddedRelationships(document, draft.relationships, newModels);
          return {
            ...byName,
            // The tables seeded from dbt are new (D-4); a library table whose relationships changed is an edit.
            saves: byName.saves.map((model): TableFileSave => (newModels.includes(model) ? { model, create: true } : { model })),
            placed: draft.relationships.filter((r) => !byName.kept.includes(r)),
          };
        })();
      // Everything new to the diagram: the named tables, then the files under what the diagram calls them.
      const addedNames = [...draft.modelNames, ...byFileAdded.refs];
      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          // A namesake of a picked file already on the diagram is now named by its schema too.
          renameMemberRefs(p, byFileAdded.renames);
          const names = (sec.models ?? []) as string[];
          const wasEmpty = names.length === 0;
          const listed = new Set(names.map(normaliseName));
          names.push(...addedNames.filter((name) => !listed.has(normaliseName(name))));
          sec.models = names;
          if (routed.kept.length > 0) {
            sec.relationships = [...((sec.relationships ?? []) as Relationship[]), ...routed.kept];
          }
          // Placement sees every edge the domain will draw, wherever it is stored.
          const relationships = [...((sec.relationships ?? []) as Relationship[]), ...routed.placed];

          const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
          const positions = { ...((vc.positions ?? {}) as Record<string, NodePosition>) };
          if (dropAt) {
            // Dropped on the canvas: each table new to the diagram goes where the
            // user let go (over a stale position it may still have), whatever
            // else the diagram holds; a member already listed keeps its place.
            const added = addedNames.filter((name) => !listed.has(normaliseName(name)));
            vc.positions = { ...positions, ...dropGridPositions(added, dropAt) };
          } else if (wasEmpty) {
            // Keep it a fresh layout (isFreshLayout): no stored position for
            // any model, so the refresh asks the webview for an ELK layout.
            for (const name of addedNames) delete positions[name];
            if (vc.positions !== undefined) vc.positions = positions;
          } else {
            // A member already listed (made from dbt where it was drawn as missing) keeps its place.
            const unplaced = addedNames.filter((name) => !Object.prototype.hasOwnProperty.call(positions, name));
            vc.positions = {
              ...positions,
              ...computeNewTablePositions({ newModels: unplaced, relationships, existingPositions: positions }),
            };
          }
          p.viewConfig = vc;
        },
        {
          webview,
          stage: 'logical',
          errorLabel: `Failed to add tables${from}.`,
          ...(routed.saves.length > 0 ? { modelFiles: { save: routed.saves } } : {}),
          ...(byFileAdded.renames.size > 0 ? { renamedMembers: byFileAdded.renames } : {}),
          onSuccess: () => {
            if (fromDbt) telemetry.feature('addFromDbt');
            this.selectorsService.scheduleRegenerate();
            const note = [skippedNote, routed.unstored].filter(Boolean).join(' ');
            if (note) {
              const added = addedNames.length;
              void vscode.window.showInformationMessage(
                `Added ${added} table${added === 1 ? '' : 's'}${from}. ${note}`,
              );
            }
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Add models${from} failed: ${message}`, err);
      // A refusal the toast explains (a conflicted diagram, a model file
      // with unsaved edits) is not a breakage.
      if (fromDbt && !isExplainedRefusal(err)) telemetry.error('addFromDbtFailed');
      if (fromDbt) markRecorded(err);
      else recordHandlerFailure('model', err);
      this.post(webview, { type: 'error', payload: { message: `Failed to add tables${from}: ${message}` } });
    }
  }

  // -------------------------------------------------------------------------
  // Rationale / Grain / Role handlers
  // -------------------------------------------------------------------------

  private async handleUpdateModelRationale(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; rationale: Partial<Rationale> },
    stage: 'logical',
  ): Promise<void> {
    try {
      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const existing = model.rationale ?? {};
          const patched = { ...existing };
          for (const [key, val] of Object.entries(payload.rationale)) {
            const trimmed = typeof val === 'string' ? val.trim() : undefined;
            if (trimmed) { (patched as Record<string, string | undefined>)[key] = trimmed; } else { delete (patched as Record<string, string | undefined>)[key]; }
          }
          if (Object.keys(patched).length > 0) { model.rationale = patched as Rationale; } else { delete model.rationale; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update design rationale.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Table "${payload.modelName}" not found.`); }

          const existing = (model.rationale ?? {}) as Record<string, string | undefined>;
          const patched = { ...existing };
          for (const [key, val] of Object.entries(payload.rationale)) {
            const trimmed = typeof val === 'string' ? val.trim() : undefined;
            if (trimmed) { patched[key] = trimmed; } else { delete patched[key]; }
          }

          if (Object.keys(patched).length > 0) { model.rationale = patched; } else { delete model.rationale; }
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update design rationale.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update design rationale failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update design rationale: ${message}` } });
    }
  }

  private async handleUpdateModelDescription(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; description: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const description = payload.description?.trim() || undefined;
          if (description) { model.description = description; } else { delete model.description; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update description.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Table "${payload.modelName}" not found.`); }

          const description = payload.description?.trim() || undefined;
          if (description) { model.description = description; } else { delete model.description; }
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update description.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update description failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update description: ${message}` } });
    }
  }

  private async handleUpdateModelGrain(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; grain: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          const grain = payload.grain?.trim() || undefined;
          if (grain) { model.grain = grain; } else { delete model.grain; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update grain statement.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Table "${payload.modelName}" not found.`); }

          const grain = payload.grain?.trim() || undefined;
          if (grain) { model.grain = grain; } else { delete model.grain; }
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update grain statement.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update grain failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update grain: ${message}` } });
    }
  }

  /**
   * Set or clear a model's `alias` — the warehouse table name. It lives only
   * in the model file (v5), so it goes through applyTableEdit and shares that
   * path's single undo step; a v4 domain has no model files to hold it.
   */
  private async handleUpdateModelAlias(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    payload: { modelName: string; alias: string },
  ): Promise<void> {
    try {
      const parsed = this.parseSubjectAreaDocument(document);
      if (!this.isSubjectAreaV5(parsed)) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Table names need the Table Library: run "ERD Studio: Migrate Subject Areas to the Central Table Library" first.' },
        });
        return;
      }
      const alias = payload.alias.trim();
      const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
        // An alias equal to the name says nothing dbt does not already do.
        if (alias && alias !== model.name) { model.alias = alias; } else { delete model.alias; }
      });
      if (!ok) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update warehouse name.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update alias failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update warehouse name: ${message}` } });
    }
  }

  /**
   * Patch a model's or a column's `meta`. Only top-level keys are touched —
   * `set` writes text values, `remove` deletes keys — so nested maps and lists
   * the canvas only displays are carried across as they are. Like `alias`, it
   * lives only in the model file (v5).
   */
  private async handleUpdateMeta(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    payload: UpdateMetaMessage['payload'],
  ): Promise<void> {
    try {
      const parsed = this.parseSubjectAreaDocument(document);
      if (!this.isSubjectAreaV5(parsed)) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Metadata needs the Table Library: run "ERD Studio: Migrate Subject Areas to the Central Table Library" first.' },
        });
        return;
      }
      const scope = payload.columnName !== undefined ? 'column' : 'table';
      const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
        let target: { meta?: Meta } = model;
        if (payload.columnName !== undefined) {
          const column = model.columns?.find((c) => c.name === payload.columnName);
          if (!column) throw new Error(`Column "${payload.columnName}" not found.`);
          target = column;
        }
        const meta: Meta = { ...(target.meta ?? {}) };
        const writesDbmlText = this.tableIsDbml(document, payload.modelName);
        for (const key of payload.remove ?? []) delete meta[key];
        for (const [key, value] of Object.entries(payload.set ?? {})) {
          setMetaEntry(meta, key, this.metaValueToWrite(key, value, meta[key], scope, writesDbmlText));
        }
        if (Object.keys(meta).length > 0) { target.meta = meta; } else { delete target.meta; }
      });
      if (!ok) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update metadata.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update meta failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update metadata: ${message}` } });
    }
  }

  /** Whether `modelName`'s file is a DBML table (it keeps its storage through an edit). */
  private tableIsDbml(document: vscode.TextDocument, modelName: string): boolean {
    try {
      const table = this.canvasTable(document, modelName);
      return (table.filePath ?? this.tableLibraryService.findTableFile(table.name))?.toLowerCase().endsWith('.dbml') ?? false;
    } catch {
      return false;
    }
  }

  /**
   * What an `updateMeta` set writes for `key` (A12). The canvas posts text;
   * a yes-no answer (`true` / `false`) is written as a BOOLEAN where the file
   * keeps booleans: over a value that is already a boolean (YAML `pii: true`,
   * a DBML `meta_json` entry), and in a YAML table when the project's field
   * list makes the key a yes-no field. A DBML table's text value stays text
   * (`pii: 'true'`), as its bare spelling holds only text. Anything else is
   * the text as posted.
   */
  private metaValueToWrite(key: string, value: string, existing: MetaValue | undefined, scope: 'table' | 'column', dbml: boolean): MetaValue {
    const answer = /^\s*(true|false)\s*$/i.exec(value)?.[1]?.toLowerCase();
    if (answer === undefined) return value;
    if (typeof existing === 'boolean') return answer === 'true';
    if (dbml) return value;
    const list = this.fieldList();
    const defs = list ? (scope === 'column' ? list.columns : list.tables) : [];
    const def = defs.find((d) => d.key === key && d.home.kind === 'meta') ?? builtInField(key, scope);
    return def?.type === 'yes-no' && def.home.kind === 'meta' ? answer === 'true' : value;
  }

  private async handleUpdateModelRole(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; modelRole: string | null },
    stage: 'logical',
  ): Promise<void> {
    try {
      // V5: write to central model file
      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      if (this.isSubjectAreaV5(parsed)) {
        const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
          if (payload.modelRole) { model.modelRole = payload.modelRole as import('../types/semantic').TableRole; } else { delete model.modelRole; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update table role.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applySubjectAreaEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Table "${payload.modelName}" not found.`); }

          if (payload.modelRole) { model.modelRole = payload.modelRole; } else { delete model.modelRole; }
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update table role.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Update model role failed: ${message}`, err);
      recordHandlerFailure('details', err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update table role: ${message}` } });
    }
  }

  // -------------------------------------------------------------------------
  // Stage switching & discrepancy
  // -------------------------------------------------------------------------


  /**
   * Handle a switchStage message from the webview.
   * Loads data for the requested stage and sends it back.
   *
   * `requestId` is the webview's sequence token for this switch; it is echoed
   * on the `stageData` reply so the webview can discard a reply for a stage it
   * no longer wants (e.g. Alt+1 pressed while a slow physical load is in flight).
   * Host-initiated switches (tree view, watcher refresh) carry no token.
   */
  private async handleSwitchStage(
    panelKey: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    targetStage: Stage,
    requestId?: number,
  ): Promise<void> {
    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel) return;

      // Logical-only: no Physical stage. A physical request (a stale webview,
      // Alt+2, a tree "open in physical") is answered with the logical stage,
      // echoing requestId so the webview accepts the reply.
      if (this.logicalOnly) { targetStage = 'logical'; }

      // A stage change closes the Compare overlay in the webview (editorStore's
      // setDomain), so the host forgets that comparison too: a later redraw
      // must not re-run it, and Sync must not plan from it.
      if (panel.activeStage !== targetStage) {
        panel.lastDiscrepancyReport = null;
        panel.lastCompareAgainst = undefined;
        panel.compareRequest = (panel.compareRequest ?? 0) + 1;
      }
      // Update tracked stage
      panel.activeStage = targetStage;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();
      const dbtKeyIndex = dbtKeyIndexOf(ymlData, manifest);

      const unifiedDomain = this.subjectAreaService.getSubjectArea(document.uri.fsPath, { dbtKeyIndex });

      // Same in-memory auto-positioning as sendSubjectAreaData — never a write here.
      const computed = this.computeMissingPositions(unifiedDomain);
      if (computed) {
        unifiedDomain.viewConfig.positions = { ...(unifiedDomain.viewConfig.positions ?? {}), ...computed };
      }

      const reply = requestId !== undefined ? { requestId } : {};
      if (targetStage === 'physical') {
        // Physical stage is derived from the dbt project itself, enriched by the
        // manifest and the warehouse catalog when either has been generated.
        const physicalDomain = this.subjectAreaService.buildPhysicalSubjectArea(unifiedDomain, ymlData, manifest, catalog);
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) {
          physicalDomain.layerConfig = layerConfig;
        }
        const fields = this.displayFields();
        if (fields) {
          physicalDomain.fields = fields;
        }
        this.post(webview, { type: 'stageData', payload: physicalDomain, ...reply });
        this.cancelCanvasContext(webview);
        this.noteDrawn(panelKey, unifiedDomain.logical.models.map((m) => m.name));
        // #113: where a missing manifest is met (once per day).
        if (this.manifestService.isMissing) telemetry.featureOnce('manifestMissingPhysical');
      } else {
        // Logical — extract from unified file
        const domain = this.subjectAreaService.getSubjectAreaStage(document.uri.fsPath, { dbtKeyIndex });
        const displayDomain = this.buildDisplaySubjectArea(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns, document.uri.fsPath);
        this.post(webview, { type: 'stageData', payload: displayDomain, ...reply, ...this.manifestHintFlag(), ...this.logicalOnlyFlag() });
        void this.sendCanvasContext(webview, displayDomain.models.map((m) => m.name), unifiedDomain.layer, document);
        this.noteDrawn(panelKey, displayDomain.models.map((m) => m.name));
        void this.sendFilesNotShown(webview, panelKey, document, displayDomain.models.map((m) => m.name));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Stage switch failed: ${message}`, err);
      recordHandlerFailure('stage', err);
      // A file the user broke (#186) is named the way the load screen names it.
      const fileProblem = err instanceof SubjectAreaFileError ? this.subjectAreaFileProblemPayload(err, document.uri.fsPath) : undefined;
      this.post(webview, { type: 'error', payload: { message: `Failed to switch stage: ${fileProblem?.message ?? message}` } });
    }
  }

  /**
   * Handle a toggleDiscrepancy message from the webview.
   * Runs cross-stage comparison and sends the report back.
   */
  private async handleToggleDiscrepancy(
    panelKey: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { enabled: boolean; compareAgainst?: Stage },
  ): Promise<void> {
    // Logical-only: nothing to compare against, and no staleness check.
    if (!payload.enabled || !payload.compareAgainst || this.logicalOnly) {
      const panelEntry = this.openPanels.get(panelKey);
      if (panelEntry) {
        panelEntry.lastDiscrepancyReport = null;
        panelEntry.lastCompareAgainst = undefined;
        panelEntry.compareRequest = (panelEntry.compareRequest ?? 0) + 1;
      }
      webview.postMessage({ type: 'discrepancyReport', payload: null });
      return;
    }

    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel) return;
      const request = (panel.compareRequest ?? 0) + 1;
      panel.compareRequest = request;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();
      // Compare was closed, asked again or the stage changed while those
      // loaded: that later request owns the overlay and the cached report.
      if (this.openPanels.get(panelKey)?.compareRequest !== request) return;
      const sourceStage = panel.activeStage;
      const targetStage = payload.compareAgainst;

      // The one comparison orchestration, shared with the `erd-studio diff` CLI.
      const { report, unified } = computeSubjectAreaDiff(
        { subjectAreaService: this.subjectAreaService, ymlData, manifest, catalog },
        document.uri.fsPath,
        sourceStage,
        targetStage,
      );

      // Cache the report and comparison target for sync plan generation
      // and to allow re-running after stub column changes.
      const panelEntry = this.openPanels.get(panelKey);
      if (panelEntry) {
        panelEntry.lastDiscrepancyReport = report;
        // A table two schema folders share: its own file, and the dbt model the comparison found it as.
        panelEntry.lastDiscrepancyTables = {
          ids: this.subjectAreaService.tableIdsOf(unified),
          dbtModels: this.subjectAreaService.dbtModelNamesOf(unified, ymlData, manifest),
        };
        panelEntry.lastCompareAgainst = targetStage;
      }

      webview.postMessage({ type: 'discrepancyReport', payload: report });

      // Also check manifest staleness and send alongside
      try {
        const staleness = await checkManifestStaleness(this.workspaceRoot);
        webview.postMessage({ type: 'manifestStaleness', payload: staleness });
      } catch {
        // Non-critical — staleness check failure shouldn't break discrepancy
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Discrepancy comparison failed: ${message}`, err);
      recordHandlerFailure('compare', err);
      webview.postMessage({ type: 'discrepancyReport', payload: null });
    }
  }

  // ---------------------------------------------------------------------------
  // Sync reconciliation handlers
  // ---------------------------------------------------------------------------

  /**
   * Generate a .sync-plan.json file from user's ground truth selections.
   */
  private async handleGenerateSyncPlan(
    panelKey: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    selections: Record<string, GroundTruth>,
  ): Promise<void> {
    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel?.lastDiscrepancyReport) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'No discrepancy report available. Run a comparison first.' },
        });
        return;
      }

      const report = panel.lastDiscrepancyReport;
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');

      // Parse domain info from the document (a v6 file names it `subjectArea`, #162)
      const raw = this.parseSubjectAreaDocument(document);
      const parsed = detectSubjectAreaFormat(raw) === 'v6' ? normaliseSubjectAreaDocument(raw) : raw;

      const syncPlan = buildSyncPlan(report, selections, {
        manifest,
        ymlData,
        projectRoot: this.workspaceRoot,
        semanticDir,
        domain: (parsed.domain as string | undefined) ?? '',
        layer: (parsed.layer as string | undefined) ?? '',
        // The CLI's lookups (diff): a new table goes where one created from this diagram goes.
        ...syncPlanLibraryLookups(this.tableLibraryService, {
          diagramFile: document.uri.fsPath,
          layerIds: new Set(this.layerService.getAllLayers().map((l) => l.id)),
          manifest,
          ymlData,
          tableIdOf: (name) => panel.lastDiscrepancyTables?.ids.get(name.toLowerCase()),
        }),
        dbtModelOf: (name) => panel.lastDiscrepancyTables?.dbtModels.get(name.toLowerCase()),
      });

      const totalActions = countSyncPlanActions(syncPlan);
      if (totalActions === 0) {
        // Everything selected touched a table whose file does not read: say
        // so, rather than suggest the selection was empty.
        const unreadable = syncPlan.unreadableTables ?? [];
        webview.postMessage({
          type: 'error',
          payload: {
            message: unreadable.length > 0
              ? `Nothing to sync yet: ${unreadable.join(', ')} could not be read. Fix the file, then compare again.`
              : 'No actionable resolutions selected.',
          },
        });
        return;
      }

      // Write to disk directly (not via WorkspaceEdit) — this is a generated output
      // file, not a domain mutation, so undo/redo integration is not needed.
      const syncPlanPath = path.join(this.workspaceRoot, semanticDir, '.sync-plan.json');
      const fs = await import('fs');
      const dir = path.dirname(syncPlanPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(syncPlanPath, JSON.stringify(syncPlan, null, 2) + '\n', 'utf-8');

      // Notify the webview
      webview.postMessage({
        type: 'syncPlanGenerated',
        payload: { filePath: syncPlanPath, totalActions },
      });

      // Open the sync plan in VS Code editor for review
      const uri = vscode.Uri.file(syncPlanPath);
      await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logHandlerFailure(`[SemanticEditorProvider] Sync plan generation failed: ${msg}`, err);
      recordHandlerFailure('compare', err);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to generate sync plan: ${msg}` },
      });
    }
  }

  /**
   * Launch Claude Code in a terminal to execute the sync plan.
   *
   * The user is shown a modal that names the exact command before anything
   * runs. `--dangerously-skip-permissions` is only added when the
   * `erdStudio.claudeSync.skipPermissions` setting is enabled (default off),
   * because it lets Claude edit files in the workspace without asking.
   *
   * The prompt is Claude Code's initial-prompt argument (`claude "<prompt>"`,
   * built by `claudeTerminalLaunch`, the launcher Open Claude Code uses), never
   * text typed into its TUI after a delay: on a first run Claude Code shows
   * its folder-trust prompt with "No, exit" preselected, where typed text is
   * lost and its newline would confirm the highlighted option.
   */
  private async handleLaunchClaudeSync(): Promise<void> {
    const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');
    const skipPermissions = getErdStudioSetting<boolean>('claudeSync.skipPermissions', false) === true;
    const planPath = `${semanticDir}/.sync-plan.json`;
    const syncGuide = '.claude/skills/erd-studio/SYNC.md';
    const prompt = `Execute the erd-studio sync plan at ${planPath} using the erd-studio skill. Read ${syncGuide} for the action reference and follow the execution steps.`;

    // Without the AI helper files the prompt names a guide that isn't there,
    // and Claude Code goes looking for it across the disk. Offer the setup
    // instead of launching.
    if (!fs.existsSync(path.join(this.workspaceRoot, syncGuide))) {
      const SETUP = 'Set Up My AI Helper';
      const pick = await vscode.window.showWarningMessage(
        'Claude Code needs ERD Studio\'s AI helper files to apply the sync plan.',
        { modal: true, detail: `${syncGuide} is missing. Set Up My AI Helper installs it (choose Claude Code), then run Execute with Claude again. The plan stays at ${planPath}.` },
        SETUP,
      );
      if (pick === SETUP) {
        await vscode.commands.executeCommand('erdStudio.setupAiHelper');
      }
      return;
    }

    const launch = claudeTerminalLaunch('claude', process.platform, {
      prompt,
      args: skipPermissions ? ['--dangerously-skip-permissions'] : [],
      venvDir: findVenvDir(this.workspaceRoot),
    });

    const detail = skipPermissions
      ? `Command: ${launch.display}\n\n` +
        'The --dangerously-skip-permissions flag lets Claude Code edit files in this workspace ' +
        'without asking for confirmation. Set "erdStudio.claudeSync.skipPermissions" to false to keep the permission prompts.'
      : `Command: ${launch.display}\n\n` +
        'Claude Code asks before editing files unless your own Claude Code settings allow edits. ' +
        'Enable "erdStudio.claudeSync.skipPermissions" in your user settings to run unattended with --dangerously-skip-permissions.';
    const LAUNCH = 'Launch';
    const choice = await vscode.window.showWarningMessage(
      `Launch Claude Code in a terminal to execute the sync plan at ${planPath}?`,
      { modal: true, detail },
      LAUNCH,
    );
    if (choice !== LAUNCH) {
      return;
    }

    if (launch.kind === 'process') {
      vscode.window.createTerminal({
        name: 'ERD Studio Sync', cwd: this.workspaceRoot, shellPath: launch.shellPath, shellArgs: launch.shellArgs, env: launch.env,
      }).show();
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: 'ERD Studio Sync',
      cwd: this.workspaceRoot,
    });
    terminal.show();
    terminal.sendText(launch.line);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptOnDisk = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js');

    // Worst case: an extension update removed the previous version's directory
    // before this panel was reattached. The cached <script src> would 404 and
    // leave a blank canvas with no JS to surface the problem. Render a static
    // fallback that prompts the user to reload.
    if (!fs.existsSync(scriptOnDisk.fsPath)) {
      return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ERD Studio</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
</head>
<body style="font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground);">
  <h2 style="margin-top: 0;">ERD Studio was updated</h2>
  <p>This canvas can't render until the window reloads to pick up the new extension files.</p>
  <p>Run <strong>Developer: Reload Window</strong> from the Command Palette (⌘⇧P / Ctrl+Shift+P).</p>
</body>
</html>`;
    }

    const scriptUri = webview.asWebviewUri(scriptOnDisk);
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'),
    );

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
      script-src ${webview.cspSource} 'nonce-${nonce}';
      style-src ${webview.cspSource} 'unsafe-inline';
      img-src ${webview.cspSource} data: blob:;
      font-src ${webview.cspSource};
      connect-src ${webview.cspSource};
      worker-src blob:;">
  <title>ERD Studio Diagram</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isTypedMessage(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && 'type' in value && typeof (value as Record<string, unknown>).type === 'string';
}
