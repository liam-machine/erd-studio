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
 *                         viewFile, requestReload, dismissWelcome,
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
  subjectAreaTableNames,
} from '../services/domainService';
import { computeSubjectAreaDiff } from '../services/stageDiff';
import { buildSyncPlan, countSyncPlanActions } from '../services/syncPlanBuilder';
import { findVenvActivate } from '../services/dbtEnv';
import { runDbtParse } from '../commands/runDbtParse';
import { NO_DBT_MODELS_MESSAGE } from '../commands/drawFromDbt';
import { IMPORT_DBML_COMMAND } from '../commands/importDbml';
import { EXPORT_DIAGRAM_COMMAND } from '../commands/exportDiagram';
import { SEND_FEEDBACK_BUTTON, describeDbmlMistake, describeJsonMistake, feedbackPrefill, oursMessage, projectRelative, showErrorWithActions } from '../services/commandErrors';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import { SelectorsService } from '../services/selectorsService';
import { computeNewTablePositions, findOpenPosition } from '../services/positionService';
import {
  DbdiagramLayoutRefused,
  classifySemanticFile,
  computeMissingPositions,
  diagramPathOfLayout,
  subjectAreaStorageOf,
  SubjectAreaValidationError,
  EMPTY_DBT_KEY_INDEX,
  backwardsRelationshipNote,
  layoutFilePathOf,
  linkKey,
  normaliseSubjectAreaDocument,
  sameLink,
  setMetaEntry,
  toDisplaySubjectArea,
} from '@erd-studio/core';
import type { DbtKeyIndex } from '@erd-studio/core';
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
  AddRelationshipMessage,
  AnalyzeFeedbackMessage,
  CopyFeedbackReportMessage,
  EditRelationshipMessage,
  ErrorMessage,
  OpenFeedbackLinkMessage,
  OpenModelFileMessage,
  ViewFileMessage,
  SetFeedbackProviderMessage,
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
import type { UpdateColumnPayloadColumn, UpdateMetaMessage } from '../types/messages';
import type { GroundTruth } from '../types/syncPlan';
import type { NodePosition, Relationship, SemanticTable, UnifiedSubjectArea } from '../types/semantic';
import { describeUnsupportedSubjectAreaFormat, detectSubjectAreaFormat } from '../types/semantic';
import { telemetry } from '../services/telemetryService';
import { saveDocument, saveDocumentByUri } from './documentSave';
import { dirtyFiles } from './dirtyDocuments';
import { subjectAreaLoadErrorCode, layoutFeature, saveFailureCodes, type SaveFailure, type SubjectAreaLoadFailure, type TelemetryFeature } from '../services/telemetryPayload';
import { openTableFileAt } from '../commands/openModelFile';
import {
  buildDbtDraft,
  dbtTestsOf,
  listDraftModels,
  listDraftScopes,
  markDraftKeys,
  relationshipsForAddedTables,
  seedTableFromDbt,
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
import type { NamingMigrationPlan } from '../services/namingMigration';
import type { ProjectNaming } from '@erd-studio/core';
import type { RelationshipAudit } from '../services/relationshipHealth';
import { DbmlTableWriteRefused, DuplicateKeyWriteRefused, RelationshipsRewriteRefused, TableNamingWriteRefused, tablesDirIsLayer } from '../services/logicalModelService';
import { DBML_CONVERT_FIRST_MESSAGE, DbmlEditRefused } from '@erd-studio/core/dbml';
import type { FileWrite } from '../services/fileWrites';
import type { DbmlLibraryWritePlan } from '../services/dbmlLibraryWrites';
import { applyFileWrites, writtenPaths } from './applyFileWrites';
import type { AppliedFileWrites } from './applyFileWrites';
import {
  NotASubjectAreaObject,
  codecFor,
  isLayoutOnlyChange,
  isTableNamingDocument,
  layoutWrite,
  readLayoutText,
  markTableNamingDocument,
  serialiseSubjectArea,
  subjectAreaFileObject,
} from './subjectAreaCodec';
import type { ParsedSubjectArea, SubjectAreaResolver } from './subjectAreaCodec';
import { readDbtProjectConfig } from '../services/dbtProjectConfig';
import { normaliseName } from '../services/nameUtils';
import { yieldToEventLoop } from '../services/libraryWarmUp';
import { createLogger, elapsedMs, log, phaseTimer, plural } from '../services/logger';
import { SHOW_LOGS_BUTTON, SHOW_LOGS_COMMAND } from '../services/showLogs';

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
/** A document's first line (the classifier reads a DBML export's header from it). */
function firstLineOf(document: vscode.TextDocument): string {
  const text = document.getText();
  const end = text.indexOf('\n');
  return (end < 0 ? text : text.slice(0, end)).replace(/\r$/, '');
}

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
 * domain file's layer directory (`{semanticDir}/{layer}/{domain}.json`).
 * `TableLibraryService` ignores a name that is not layer-shaped, so a domain
 * opened from anywhere else simply creates its models at the top level.
 */
export function tableFolderForSubjectArea(domainFilePath: string): string {
  return path.basename(path.dirname(domainFilePath));
}

/**
 * logical-models/*.yml operations to bundle into a domain WorkspaceEdit so the
 * model file and the domain file change (and undo) together.
 */
interface TableFileOps {
  /** Models whose yml should be written in full (created if missing). */
  save?: TableFileSave[];
  /** Model names whose yml should be deleted (e.g. the old name on rename). */
  delete?: string[];
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
}

/** Why a chosen dbt model was left out of a batch add, in words. */
const DRAFT_SKIP_WORDS: Partial<Record<DraftSkipped['reason'], string>> = {
  'invalid-name': 'name cannot be used as a file name',
  'not-found': 'not found in dbt',
  disabled: 'disabled in dbt',
  'over-limit': 'over the limit for one add',
};

/**
 * One sentence naming the chosen models a batch "Add models from dbt" left
 * out, or `''` when nothing worth mentioning was. Duplicates and models
 * already in the domain are the expected case and are not listed.
 */
export function describeSkippedDbtModels(skipped: readonly DraftSkipped[]): string {
  const parts = skipped
    .filter((s) => DRAFT_SKIP_WORDS[s.reason])
    .map((s) => `${s.name} (${DRAFT_SKIP_WORDS[s.reason]})`);
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
): void {
  const viewConfig = parsed.viewConfig;
  if (!viewConfig || typeof viewConfig !== 'object' || Array.isArray(viewConfig)) return;
  const vc = viewConfig as Record<string, unknown>;

  const positions = vc.positions;
  if (positions && typeof positions === 'object' && !Array.isArray(positions)) {
    for (const name of removed) delete (positions as Record<string, unknown>)[name];
  }

  const annotations = vc.annotations;
  if (Array.isArray(annotations)) {
    for (const annotation of annotations) {
      if (!annotation || typeof annotation !== 'object') continue;
      const ann = annotation as Record<string, unknown>;
      if (typeof ann.linkedModel === 'string' && removed.has(ann.linkedModel)) {
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
  const layer = path.basename(path.dirname(domainPath)).toLowerCase().replace(/[^a-z0-9_]/g, '_');
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
  constructor(message: string) {
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

import {
  isValidCardinality,
  isValidRelationshipRole,
  isValidKeyType,
  isValidTableRole,
  isValidStage,
  validateColumnDef as validateColumnDefPayload,
  validateColumnDefs,
  validateTableName,
  validateModelAliasPayload,
  validateMetaPayload,
  validateAnnotationPositions,
  validateAddModelsFromDbtPayload,
  validateAddExistingModelsPayload,
  validateOpenModelFilePayload,
  validateLayoutFinishedPayload,
  validateViewFilePayload,
  validateExtraPairs,
  validateMarkKey,
  validateRelationshipEnds,
  validateDismissManifestHintPayload,
  validateImportEmbeddedTablesPayload,
  validateExportDiagramPayload,
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
  validateSubmitFeedbackPayload,
  type AnnotationPositionPayload,
} from './payloadValidation';
import { sameName } from '../types/naming';

/** A parsed domain file's `logical.relationships`, as a list the rename helpers can rewrite in place. */
function stageRelationships(parsed: Record<string, unknown>): Array<Record<string, unknown>> {
  const logical = parsed.logical as Record<string, unknown> | undefined;
  return logical && Array.isArray(logical.relationships) ? logical.relationships as Array<Record<string, unknown>> : [];
}

/**
 * Follow a model rename in another v5 domain file, in place (#133 L5): its
 * `logical.models` entry, its stored position and its own relationship
 * copies, matched without case. Returns whether anything changed.
 */
function renameTableInSubjectArea(parsed: Record<string, unknown>, oldName: string, newName: string): boolean {
  let touched = false;
  const logical = parsed.logical as Record<string, unknown> | undefined;
  if (logical && Array.isArray(logical.models)) {
    logical.models = (logical.models as unknown[]).map((m) => {
      if (typeof m !== 'string' || !sameName(m, oldName)) return m;
      touched = true;
      return newName;
    });
  }
  const positions = ((parsed.viewConfig ?? {}) as Record<string, unknown>).positions as Record<string, unknown> | undefined;
  if (positions && typeof positions === 'object') {
    const key = Object.keys(positions).find((k) => sameName(k, oldName));
    if (key !== undefined && !(newName in positions)) {
      positions[newName] = positions[key];
      delete positions[key];
      touched = true;
    }
  }
  return renameTableInSubjectAreaRelationships(stageRelationships(parsed), oldName, newName) || touched;
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

/** How long outside changes to table files are collected into one canvas refresh. */
export const TABLE_REFRESH_BATCH_MS = 150;
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
    'Afterwards, everyone who opens it needs ERD Studio 1.9 pre-release or 2.0 and later. ' +
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
  /** The move-to-library offer is made at most once per session (#126). */
  private relationshipMoveOffered = false;
  /** The naming migration's offer (#182): at most once per session, before the relationship offers. */
  private namingMigrationOffered = false;
  private dbmlConversionOffered = false;
  /** The DBML offer was eligible this session: the naming offer is then never made (§6.4). */
  private dbmlConversionEligible = false;
  private dbmlConversion: DbmlConversionHooks | undefined;
  private namingMigration: NamingMigrationHooks | undefined;
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

  /** Tables changed outside ERD Studio, waiting for one batched canvas refresh (see queueTableRefresh). */
  private readonly queuedTableRefresh = new Set<string>();
  private tableRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Per webview: the log lines its Send Feedback dialog last previewed (the only ones a report may carry). */
  private readonly feedbackLogShown = new WeakMap<vscode.Webview, string[]>();

  /** Per panel: the pending flush after VS Code's own undo/redo (see scheduleNativeUndoFlush). */
  private readonly nativeUndoTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Per panel: the DBML diagram's layout file when an undo/redo on the canvas
   * rewound it since the last flush. Only then does the flush save it: a
   * `.dbdiagram` the user is hand-editing in another tab is never force-saved.
   */
  private readonly undoRewoundLayout = new Map<string, Set<string>>();

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
      /** The target stage from the last discrepancy comparison (used to refresh after stub toggle). */
      lastCompareAgainst?: Stage;
    }
  >();

  /**
   * Webviews whose panel has been disposed. Refresh paths iterate a snapshot
   * of openPanels and may race with disposal, and mutation handlers may finish
   * after the user closes the tab — `post()` drops messages to these instead
   * of calling into a dead webview.
   */
  private readonly disposedWebviews = new WeakSet<vscode.Webview>();

  /**
   * Post a message to a webview, skipping disposed panels and observing the
   * returned promise so a rejection can never surface as an unhandled
   * rejection from a fire-and-forget call site.
   */
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
        log.error(`[SemanticEditorProvider] Message "${type}" failed: ${detail}`);
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
    const { existingModels, manifestModels } = this.buildWebviewPayload(
      { models: domain.logical.models }, manifest, ymlData, domain.modelFolder, { readAllTables: true },
    );
    this.post(webview, { type: 'existingTables', payload: { existingModels, manifestModels } });
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
    options: { readAllTables?: boolean } = {},
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
      for (const model of previews) {
        if (existingModelNames.has(model.name)) continue;
        // A yml whose internal `name:` is not path-safe cannot be added to a
        // domain — skip it rather than failing the whole payload.
        const absPath = model.pending ? model.filePath : library.resolveTablePath(model.name);
        if (absPath === null) continue;
        existingModels.push({
          name: model.name,
          schema: model.schema,
          description: model.description,
          columnCount: model.columnCount,
          source: 'logical',
          sourcePath: path.relative(this.workspaceRoot, absPath),
          ...(model.pending ? { detailsPending: true as const } : {}),
        });
        addedNames.add(model.name);
      }
    });

    // 2. dbt .yml source file models (declared in dbt project)
    for (const [name, ymlModel] of ymlData.models) {
      if (existingModelNames.has(name) || addedNames.has(name)) continue;
      const manifestModel = manifest.models.get(name);
      existingModels.push({
        name,
        schema: manifestModel?.schema ?? '',
        description: ymlModel.description || manifestModel?.description || '',
        columnCount: ymlModel.columns.length,
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
        columnCount: m.columns.length,
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
   * If the active editor tab is one of our canvases, ask its webview to open
   * the Feedback dialog (so the report can include the diagnostics chips and
   * the optional analysis). Returns false when no canvas is active so the
   * caller can fall back to the canvas-less QuickPick flow.
   */
  requestFeedbackDialog(prefill?: OpenFeedbackMessage['payload']): boolean {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputCustom)) return false;
    const panel = this.openPanels.get(input.uri.toString());
    if (!panel) return false;
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
    webview.options = { enableScripts: Boolean(owner), localResourceRoots: [] };
    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ERD Studio</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); max-width: 44em; line-height: 1.5;">
  <h2 style="margin-top: 0;">This diagram belongs to ${owner ? `the <code>${esc(path.basename(owner))}</code> dbt project` : 'no dbt project'}</h2>
  <p>ERD Studio has <code>${esc(current)}</code> open in this window, and a window shows one dbt project at a time.
  Drawing this file here would mix its tables with the wrong project\u2019s dbt data.</p>
  ${owner ? `<p><button id="switch" style="padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; font: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);">Switch ERD Studio to ${esc(path.basename(owner))}</button></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('switch').addEventListener('click', () => vscode.postMessage({ type: 'switchProject' }));
  </script>` : ''}
</body>
</html>`;

    const name = path.basename(filePath);
    if (!owner) {
      // Not a dead end (#205): the file still opens as text, and another project can be picked.
      void vscode.window.showWarningMessage(
        `ERD Studio: ${name} isn't inside a dbt project, so ERD Studio can't draw it with ${current}'s dbt data.`,
        OPEN_AS_TEXT_BUTTON,
        SELECT_DBT_PROJECT_BUTTON,
      ).then(choice => {
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

  /** A `file:` `.dbml` the classifier says is not a diagram: a table, relationships or other file (§5.9). */
  private isRerouted(document: vscode.TextDocument): boolean {
    if (document.uri.scheme !== 'file' || !document.uri.fsPath.toLowerCase().endsWith('.dbml')) return false;
    // The first line too: a DBML export 1.x saved beside its diagram (`// erd-studio dbml-export …`) opens as text, as it did then (§3.5).
    const firstLine = firstLineOf(document);
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    const rel = path.relative(semanticRoot, document.uri.fsPath).split(path.sep).join('/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) return !isSubjectAreaFilePath(document.uri.fsPath, firstLine);
    return classifySemanticFile(rel, { tablesDirIsLayer: tablesDirIsLayer(semanticRoot), firstLine }).kind !== 'diagram';
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

    // The `**/.erd-studio/*/*.dbml` selector also matches `tables/x.dbml` and
    // `tables/_relationships.dbml`, and a glob cannot exclude them (§5.9). A
    // `file:` one that is not a diagram is reopened as text. Other schemes
    // (`git:` in the SCM diff, the merge editor's inputs) are never rerouted:
    // disposing their panel would break those views; they get the
    // not-a-diagram page with Open as Text instead.
    if (this.isRerouted(document)) {
      const column = webviewPanel.viewColumn;
      webviewPanel.dispose();
      await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', { viewColumn: column, preview: false });
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
          'refreshManifest', 'dismissWelcome',
          'viewFile', 'generateSyncPlan', 'runDbtCompile', 'runDbtParse', 'launchClaudeSync',
          'addAnnotation', 'updateAnnotation', 'removeAnnotation', 'removeAnnotations',
          'requestReload', 'openGettingStarted', 'showLogs', 'closeEditor', 'openAnotherDomain',
          'requestFeedbackContext', 'analyzeFeedback', 'setFeedbackProvider',
          'submitFeedback', 'copyFeedbackReport', 'openFeedbackLink',
          'openModelFile', 'layoutFinished', 'exportDiagram', 'requestExistingTables',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
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
            {
              const readyAt = Date.now();
              canvasLog.info(`Opening ${document.uri.fsPath}`);
              // Answer at once, before reading anything: the webview's
              // "Canvas disconnected" timer stops, and it says how many
              // tables are loading while a large diagram is read.
              await this.postLoading(document, webviewPanel.webview);
              // The initial load is the one refresh path allowed to persist
              // auto-computed positions for models that lack them.
              const posted = await this.sendSubjectAreaData(document, webviewPanel.webview, panelKey, { persistPositions: true });
              canvasLog.info(posted === undefined
                ? `Opening ${document.uri.fsPath} ended without a diagram after ${elapsedMs(readyAt)} ms`
                : `Opened ${document.uri.fsPath}: ${plural(posted, 'table')} posted ${elapsedMs(readyAt)} ms after ready`);
            }
            void this.offerRelationshipPrompts(document, webviewPanel.webview, panelKey);
            break;
          case 'requestExistingTables':
            await this.sendExistingTables(document, webviewPanel.webview);
            break;
          case 'requestReload':
            // Webview detected it was orphaned (e.g. extension update before
            // activation auto-recovery could fire). Save & reload safely.
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
            await vscode.commands.executeCommand(IMPORT_DBML_COMMAND, document.uri);
            break;
          }
          case 'dismissWelcome':
            await this.context.globalState.update('welcomeDismissed', true);
            break;
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
            const payload = (message as { payload?: DesignTable }).payload;
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
                ?? validateMarkKey(payload.markKey, payload);
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
              const linkError = validateExtraPairs(payload.extraPairs, payload) ?? validateRelationshipEnds(payload)
                ?? validateMarkKey(payload.markKey, payload);
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
            const payload = (message as { payload?: { modelName: string } }).payload;
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
            await this.queueEdit(panelKey, () =>
              this.handleAddExistingModels(document, webviewPanel.webview, (payload as { modelNames: string[] }).modelNames));
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
            }
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
            await this.handleOpenModelFile(payload.modelName, webviewPanel.webview);
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
              this.post(webviewPanel.webview, { type: 'feedbackSubmitted', payload: result });
            } catch (err) {
              hostErrorLog.record('submitFeedback', err);
              this.post(webviewPanel.webview, {
                type: 'feedbackSubmitted',
                payload: { ok: false, error: err instanceof Error ? err.message : String(err) },
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
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelRationale(document, webviewPanel.webview, payload, activeStage));
            }
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
            await this.handleRunDbtCompile();
            break;
          }
          case 'runDbtParse': {
            // Records the `dbtParse` feature itself; the manifest watcher
            // refreshes this canvas once manifest.json appears.
            await runDbtParse(this.workspaceRoot);
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
            log.warn(`[SemanticEditorProvider] Ignoring unknown webview message type "${message.type}"`);
            break;
        }
      }),
    );

    const layoutPath = this.isDbmlDocument(document) ? layoutFilePathOf(document.uri.fsPath) : undefined;
    const changeSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
      // Cmd+Z / Cmd+Shift+Z on the canvas is VS Code's own undo, not the
      // toolbar's message: it rewinds the domain file and the model files the
      // edit wrote in memory only. Flush them as the toolbar's Undo does.
      const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo
        || e.reason === vscode.TextDocumentChangeReason.Redo;
      // The diagram's layout file rewound by an undo/redo from this canvas
      // (the toolbar's, while it holds `pendingUpdates`, or Cmd+Z with the
      // canvas focused): the flush saves it. Any other dirty layout is the user's.
      // A hold's mark (holdRefreshes) is not this canvas's undo.
      const heldByHold = this.heldPanels.has(panelKey);
      const layoutRewound = undoRedo && layoutPath !== undefined && e.document.uri.fsPath === layoutPath
        && (webviewPanel.active || (this.pendingUpdates.get(panelKey) === true && !heldByHold));
      if (layoutRewound) {
        const rewound = this.undoRewoundLayout.get(panelKey) ?? new Set<string>();
        rewound.add(layoutPath);
        this.undoRewoundLayout.set(panelKey, rewound);
      }
      if (this.pendingUpdates.get(panelKey)) {
        // Pending only because a hold marked it (Convert, a bulk change), not
        // for an edit of this canvas: a native undo/redo it would flush below
        // is flushed when the hold releases, never dropped.
        if (heldByHold && undoRedo && (e.document.uri.toString() === document.uri.toString() || layoutRewound
          || (webviewPanel.active && this.editedTablePaths.get(panelKey)?.has(e.document.uri.fsPath)))) {
          this.undoWhileHeld.add(panelKey);
        }
        return;
      }
      if (e.document.uri.toString() !== document.uri.toString()) {
        // A model file this canvas wrote — while the canvas has focus, so an
        // undo typed in that file's own tab stays the user's to save.
        if (layoutRewound || (undoRedo && webviewPanel.active && this.editedTablePaths.get(panelKey)?.has(e.document.uri.fsPath))) {
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
        await document.save();
      }
      await this.sendSubjectAreaData(document, webviewPanel.webview, panelKey);
    });

    webviewPanel.onDidDispose(() => {
      messageSubscription.dispose();
      changeSubscription.dispose();
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
   * The layer folder a model created from this domain goes in, or undefined
   * for the top level: only when the domain's directory is a configured layer
   * AND the library has opted into layer folders (see `groupsByFolder`).
   */
  private newTableFolder(domainFilePath: string): string | undefined {
    const layer = tableFolderForSubjectArea(domainFilePath);
    const layerIds = new Set(this.layerService.getAllLayers().map((l) => l.id));
    return layerIds.has(layer) && this.tableLibraryService.groupsByFolder(layerIds) ? layer : undefined;
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
  private async handleOpenModelFile(modelName: string, webview: vscode.Webview): Promise<void> {
    const filePath = this.tableLibraryService.findTableFile(modelName.trim());
    if (!filePath) {
      this.post(webview, { type: 'error', payload: { message: `Table "${modelName}" not found in the Table Library.` } });
      return;
    }
    const error = this.tableLibraryService.getTableFileError(modelName.trim());
    await openTableFileAt(filePath, error?.line, error?.column);
  }

  /**
   * Why a model cannot be edited: its file has a YAML error (the file exists
   * but is broken), else the old "not found" wording.
   */
  private tableUnavailableMessage(modelName: string): string {
    const error = this.tableLibraryService.getTableFileError(modelName);
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
   * Why `name` cannot join the DBML diagram `document`, or null (D20, §2.1):
   * an existing YAML table cannot (a `use` line cannot point at a `.yml`),
   * and a new table may not be named like the relationships file. Null for a
   * JSON diagram.
   */
  private dbmlMemberProblem(document: vscode.TextDocument, name: string): string | null {
    if (!this.isDbmlDocument(document)) return null;
    const storage = this.tableLibraryService.tableStorage(name);
    if (storage === 'yaml') return `"${name}" is a YAML table, and a DBML diagram can only show DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`;
    return storage === undefined ? validateNewDbmlTableName(name) : null;
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
    await this.maybeOfferTurnRound(document, webview, panelKey);
  }

  /** Wire the background read of the table library, which steps aside while a canvas is busy. */
  setLibraryWarmUp(warmUp: { noteForegroundWork(): void } | undefined): void {
    this.libraryWarmUp = warmUp;
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
      if (this.context.workspaceState?.get<boolean>(DBML_CONVERSION_DECLINED_KEY)) return false;
      if (!getErdStudioSetting<boolean>(DBML_OFFER_CONVERT_SETTING, true)) return false;
      const storage = this.tableLibraryService.projectStorage();
      if (storage === 'dbml') return false;
      const candidates = hooks.candidates();
      if (candidates.tablesDirIsLayer || candidates.files === 0) return false;
      if (hooks.goesNowhere?.()) return false;
      this.dbmlConversionEligible = true;
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
      const choice = await vscode.window.showInformationMessage(
        'ERD Studio now says "table" and "subject area", and this project\'s files can say so too: .erd-studio/tables/ ' +
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

  private async applyTableEdit(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelName: string,
    modelMutator: (model: import('../types/semantic').SemanticTable) => void,
    domainMutator?: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    /** Other library models changed alongside (relationships pointing at this one). */
    alsoSave: readonly SemanticTable[] = [],
    /** Other diagrams' own relationship copies to rewrite in the same edit (see applySubjectAreaEdit). */
    otherDomains?: (parsed: Record<string, unknown>) => boolean,
  ): Promise<boolean> {
    const model = this.tableLibraryService.getTable(modelName);
    if (!model) {
      throw new Error(this.tableUnavailableMessage(modelName));
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
        modelFiles: { save: [{ model }, ...alsoSave.map((other) => ({ model: other }))] },
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

    for (const name of ops.delete ?? []) {
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
      ...(ops?.delete ?? []),
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
    alsoPaths: readonly string[] = [],
    saved: string[] = [],
  ): Promise<string[]> {
    const ourPaths = new Set([...(this.editedTablePaths.get(panelKey) ?? []), ...alsoPaths]);
    if (ourPaths.size === 0) return [];
    const unsaved: string[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty) continue;
      if (!ourPaths.has(doc.uri.fsPath)) continue;
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
      await vscode.commands.executeCommand(command);
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
    // A DBML diagram's layout file is flushed with it when this step rewound
    // it: VS Code's undo stack outlives this panel's `editedTablePaths`
    // (cleared when the canvas closes), and an undo that rewound the layout
    // must never leave it dirty in the background, where VS Code would show
    // it as an unsaved tab. A layout the step did not touch is never saved:
    // unsaved hand edits in its own tab are the user's to keep or discard.
    const layoutPaths = [...(this.undoRewoundLayout.get(panelKey) ?? [])];
    this.undoRewoundLayout.delete(panelKey);
    const expected = [document.uri.fsPath, ...layoutPaths, ...(this.editedTablePaths.get(panelKey) ?? [])];
    // The undo of a move rewinds the diagram's one-character anchor (its text
    // stays as on disk) and the layout file: nothing either tree shows, and
    // nothing in the table library.
    const diagramUnchanged = this.isDbmlDocument(document) && document.getText() === this.diskTextOf(document.uri.fsPath);
    // An undo VS Code refused ("changes were made to …") rewinds nothing: every
    // edit anchors the diagram, so a step that ran leaves it dirty.
    const nothingRewound = !document.isDirty && layoutPaths.length === 0;
    const savedOthers: string[] = [];
    const expectation = this.ownWriteTracker.expectWrite(expected);
    let unsavedTables: string[];
    try {
      if (await saveDocument(document, onSaveFailure)) {
        this.ownWriteTracker.recordWrite(document.uri.fsPath);
      } else {
        unsaved.push(document.uri.fsPath);
      }
      unsavedTables = await this.saveDirtyTableDocuments(panelKey, onSaveFailure, layoutPaths, savedOthers);
    } finally {
      this.ownWriteTracker.settleWrites(expectation);
    }
    unsaved.push(...unsavedTables);
    if (unsaved.length > 0) {
      const modelFile = unsavedTables.some((p) => /\.(ya?ml|dbml|dbdiagram)$/i.test(p));
      for (const code of saveFailureCodes(saveFailures, { modelFile, undoRedo: true })) telemetry.error(code);
      void webview.postMessage({ type: 'error', payload: { message: this.describeUnsaved(unsaved) } });
    }
    const layoutOnly = diagramUnchanged && (layoutPaths.length > 0 || nothingRewound) && unsavedTables.length === 0
      && savedOthers.every((p) => layoutPaths.includes(p));
    if (layoutOnly) {
      await this.sendSubjectAreaData(document, webview, panelKey);
      this._onDidWriteSubjectArea.fire({ uri: document.uri, modelLibraryChanged: false, layoutOnly: true });
      return;
    }
    // Only what this canvas wrote can have changed (an undo of a create
    // deletes, of a delete creates): those files' parses, and the library
    // index, which is rebuilt from one listing.
    this.tableLibraryService.invalidatePaths([document.uri.fsPath, ...(this.editedTablePaths.get(panelKey) ?? [])]);
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
      otherDomains?: (parsed: Record<string, unknown>) => boolean;
      errorLabel?: string;
      onSuccess?: () => void;
      /** Called when the edit applied but a file could not be saved (usage telemetry). */
      onUnsaved?: () => void;
      /** Called as soon as VS Code applies the edit, before anything is saved. */
      onApplied?: () => void;
      /** Called when the edit went through as a layout-only write (positions or sticky-note boxes alone). */
      onLayoutOnly?: () => void;
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
      modelFiles?.save?.length ? this.newTableFolder(document.uri.fsPath) : undefined,
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
      ...(modelFiles?.delete ?? []),
    ];
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

  /** Every diagram of the project except `currentPath`. */
  private listOtherSubjectAreas(currentPath: string): import('../types/semantic').SubjectAreaSummary[] {
    const semanticDir = path.relative(this.workspaceRoot, path.dirname(this.tableLibraryService.getTablesDir()));
    return this.subjectAreaService.listSubjectAreas(this.workspaceRoot, semanticDir).filter((s) => !samePath(s.filePath, currentPath));
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
    if (err instanceof DbmlEditRefused) return new EditRefused(err.message);
    return err;
  }

  /** Whether `filePath` is inside a table library folder (`tables/`, `logical-models/`). */
  private isLibraryPath(filePath: string): boolean {
    const semanticRoot = path.dirname(this.tableLibraryService.getTablesDir());
    const rel = path.relative(semanticRoot, filePath).split(path.sep);
    return rel.length > 1 && (rel[0] === 'tables' || rel[0] === 'logical-models');
  }

  /**
   * The {@link SubjectAreaResolver} of a library plan: tables, relationships
   * files and file existence as the plan leaves them, and the tables whose
   * file moved, was renamed or was deleted (old and new names).
   */
  private resolverOf(plan: DbmlLibraryWritePlan): SubjectAreaResolver {
    const pathChanged = new Set<string>();
    for (const [oldName, newPath] of plan.pathChanged) {
      pathChanged.add(oldName.toLowerCase());
      if (newPath !== null) pathChanged.add(path.posix.basename(newPath).replace(/\.dbml$/i, '').toLowerCase());
    }
    // A table new in this plan gains its file: a diagram listing it in erd_unlinked_tables gives it a use line (D26).
    for (const name of plan.createdTables ?? []) pathChanged.add(name.toLowerCase());
    return {
      semanticRoot: path.dirname(this.tableLibraryService.getTablesDir()),
      resolveTable: (name) => plan.resolveTable(name),
      relationshipsFilesFor: (names) => plan.relationshipsFilesFor(names),
      fileExists: (relPath) => plan.fileExists(relPath),
      ...(pathChanged.size > 0 ? { pathChanged } : {}),
    };
  }

  /**
   * {@link applySubjectAreaEdit} for a DBML diagram, or a project whose
   * library holds DBML (§5.3): the library writes are planned
   * (`planTableWrites`), the diagram is rendered against the library as the
   * edit leaves it, other diagrams the edit renames in are re-rendered, and
   * every other DBML diagram whose `use` lines the edit invalidates is
   * settled — all in ONE WorkspaceEdit applied by `applyFileWrites`, with
   * the primary's replace first so the step undoes as one.
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
      // The diagram imports the relationships file of each member's folder: one this edit creates gets its use line.
      const members = ((file.parsed.logical ?? {}) as { models?: unknown }).models;
      const created = new Set(plan.createdRelationshipsFiles);
      const refresh = file.storage === 'dbml' && Array.isArray(members)
        && plan.relationshipsFilesFor(members.filter((m): m is string => typeof m === 'string')).some((f) => created.has(f));
      const [primary, ...layout] = codecFor(fsPath).render(file, text, fsPath, refresh ? { ...resolver, refreshRelationshipsUses: true } : resolver);
      primaryText = primary.kind === 'delete' ? text : primary.text;
      const others = options.otherDomains ? this.rewriteOtherSubjectAreaWrites(fsPath, options.otherDomains, resolver) : [];
      const rewritten = new Set(others.map((w) => (w.path.toLowerCase().endsWith('.dbdiagram') ? diagramPathOfLayout(w.path) : w.path)));
      const settled = this.settleDbmlDiagrams(fsPath, rewritten, plan, resolver);
      writes = [...layout, ...tableWrites, ...others, ...settled];
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
      // table's columns or keys changed.
      this.tableLibraryService.invalidatePaths(writtenPaths(applied));
      if (refreshWebview && webview) {
        await this.sendSubjectAreaData(document, webview);
      }
    } finally {
      this.pendingUpdates.delete(panelKey);
    }

    const touchedModels = [
      ...(modelFiles?.save ?? []).map((entry) => entry.model.name),
      ...(modelFiles?.delete ?? []),
    ];
    await this.refreshSubjectAreasReferencingTables(new Set(touchedModels), panelKey);
    this._onDidWriteSubjectArea.fire({
      uri: document.uri,
      modelLibraryChanged: applied.created.length > 0 || applied.deleted.length > 0,
      ...(layoutOnly ? { layoutOnly: true } : {}),
    });
    // Other diagrams this edit wrote (a layout path maps to its diagram).
    const otherDiagrams = new Set<string>();
    for (const w of writes) {
      if (w.kind === 'delete' || this.isLibraryPath(w.path)) continue;
      const diagram = w.path.toLowerCase().endsWith('.dbdiagram') ? diagramPathOfLayout(w.path) : w.path;
      if (!samePath(diagram, fsPath)) otherDiagrams.add(diagram);
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
  ): Promise<AppliedFileWrites | null> {
    const { webview, errorLabel } = options;
    const panelKey = document.uri.toString();
    const fsPath = document.uri.fsPath;
    const expected = [fsPath, ...writes.map((w) => w.path)];
    const expectation = this.ownWriteTracker.expectWrite(expected);
    try {
      const applied = await applyFileWrites(writes, {
        primary: { document, text: primaryText },
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
      // The diagram's layout file is left out: an undo/redo saves it only when
      // that step rewound it (`undoRewoundLayout`), never because an earlier
      // move wrote it — its tab may hold the user's unsaved hand edits since.
      const layoutPath = this.isDbmlDocument(document) ? layoutFilePathOf(fsPath) : undefined;
      for (const uri of applied.replaced) {
        // Remember what WE edited for this diagram, so an undo/redo only ever
        // flushes those.
        if (uri.fsPath !== layoutPath) ourPaths.add(uri.fsPath);
        if (await saveDocumentByUri(uri, onSaveFailure)) {
          this.ownWriteTracker.recordWrite(uri.fsPath);
        } else {
          unsaved.push(uri.fsPath);
          if (this.isLibraryPath(uri.fsPath)) modelFileUnsaved = true;
        }
      }
      for (const filePath of applied.created) if (filePath !== layoutPath) ourPaths.add(filePath);
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
   * - A DBML diagram writes its `.dbdiagram` alone. The `.dbml` keeps its
   *   text; `applyFileWrites` gives it the one-character undo anchor so the
   *   step still undoes from the canvas.
   * - A JSON diagram holds its positions, so its own text is rendered as on
   *   any edit (cheap: no library involved).
   *
   * Still one WorkspaceEdit, one save pass, one undo step, own writes
   * recorded after the bytes land. Nothing in the library is invalidated
   * (a layout file is not a library file), and `onDidWriteSubjectArea`
   * carries `layoutOnly`, so the sidebar trees are not refreshed.
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
    let primaryText: string;
    let writes: FileWrite[];
    try {
      if (file.storage === 'dbml') {
        primaryText = text;
        const layout = layoutWrite(file, fsPath);
        writes = layout ? [layout] : [];
      } else {
        const [primary] = codecFor(fsPath).render(file, text, fsPath);
        primaryText = primary.kind === 'delete' ? text : primary.text;
        writes = [];
      }
    } catch (err) {
      throw this.refusalOf(err);
    }
    // Nothing moved (a drop where it was): no edit, no save, no undo step.
    if (primaryText === text && writes.length === 0) {
      onSuccess?.();
      return true;
    }
    const dirty = dirtyFiles(writes.map((w) => w.path));
    if (dirty.length > 0) {
      const name = path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/');
      throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
    }

    this.pendingUpdates.set(panelKey, true);
    try {
      const applied = await this.applyAndSaveWrites(document, primaryText, writes, options);
      if (!applied) return false;
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
   * {@link rewriteOtherSubjectAreas} for every diagram format (§5.3 step 3):
   * each other diagram, parsed from its open document or the disk, run
   * through `rewrite`, and the ones it changes rendered against the library
   * as the edit leaves it. Throws, naming it, when a file it would change is
   * open with unsaved edits.
   */
  private rewriteOtherSubjectAreaWrites(
    currentPath: string,
    rewrite: (parsed: Record<string, unknown>) => boolean,
    resolver: SubjectAreaResolver,
    /** Only DBML diagrams: JSON ones are neither parsed nor dirty-checked. */
    options: { dbmlOnly?: boolean } = {},
  ): FileWrite[] {
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
      let file: ParsedSubjectArea;
      try {
        file = codecFor(summary.filePath).parse(original, summary.filePath, readLayoutText(summary.filePath));
      } catch {
        continue;
      }
      if (!rewrite(file.parsed)) continue;
      const rendered = codecFor(summary.filePath).render(file, original, summary.filePath, resolver);
      const changed = rendered.filter((w, i) => i > 0 || (w.kind !== 'delete' && w.text !== original));
      if (changed.length === 0) continue;
      const dirty = dirtyFiles(changed.map((w) => w.path));
      if (dirty.length > 0) {
        const name = path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/');
        throw new EditRefused(`${name} has unsaved changes. Save or revert it, then try again.`);
      }
      out.push(...changed);
    }
    return out;
  }

  /**
   * The settle pass (§5.3 step 4): every other DBML diagram with a member
   * in a folder whose relationships file the plan creates, or a member whose
   * file the plan moves, renames or deletes, re-rendered with no change of
   * its own, so its `use` lines stay valid in the same WorkspaceEdit.
   */
  private settleDbmlDiagrams(currentPath: string, skip: ReadonlySet<string>, plan: DbmlLibraryWritePlan, resolver: SubjectAreaResolver): FileWrite[] {
    const createdTables = new Set((plan.createdTables ?? []).map((n) => n.toLowerCase()));
    if (plan.createdRelationshipsFiles.length === 0 && plan.pathChanged.size === 0 && createdTables.size === 0) return [];
    const created = new Set(plan.createdRelationshipsFiles);
    const out: FileWrite[] = [];
    for (const summary of this.listOtherSubjectAreas(currentPath)) {
      if (summary.storage !== 'dbml' || skip.has(summary.filePath)) continue;
      const original = this.openOrDiskText(summary.filePath);
      if (original === null) continue;
      let file: ParsedSubjectArea;
      try {
        file = codecFor(summary.filePath).parse(original, summary.filePath, readLayoutText(summary.filePath));
      } catch {
        continue;
      }
      const logical = (file.parsed.logical ?? {}) as { models?: unknown };
      const members = Array.isArray(logical.models) ? (logical.models as unknown[]).filter((m): m is string => typeof m === 'string') : [];
      const affected = members.some((m) => plan.pathChanged.has(m.toLowerCase()) || createdTables.has(m.toLowerCase())
        || plan.relationshipsFilesFor([m]).some((f) => created.has(f)));
      if (!affected) continue;
      try {
        const [primary] = codecFor(summary.filePath).render(file, original, summary.filePath, { ...resolver, refreshRelationshipsUses: true });
        if (primary.kind !== 'delete' && primary.text !== original) out.push(primary);
      } catch (err) {
        // A diagram the writer will not touch (it does not read, or holds a second Project) is left as it is.
        log.warn(`[SemanticEditorProvider] ${summary.filePath} left as it is: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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
    rewrite: (parsed: Record<string, unknown>) => boolean,
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
      if (!rewrite(parsed)) continue;
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
   * object (§5.2): the storage, and for a DBML diagram its version, writable
   * flag and layout. A `.dbml` diagram reads into a plain v5 object (D8).
   */
  private parseSubjectAreaFile(document: vscode.TextDocument, text: string = document.getText()): ParsedSubjectArea {
    const shown = this.shownSubjectAreaPath(document.uri.fsPath);
    const codec = codecFor(document.uri.fsPath);
    try {
      // Messages name the file project-relative; a DBML diagram's layout is
      // read, and will be written (S5), beside the real path, never the shown one.
      const file = codec.parse(text, shown, codec.storage === 'dbml' ? readLayoutText(document.uri.fsPath) : null);
      return file.storage === 'dbml' ? { ...file, layoutPath: layoutFilePathOf(document.uri.fsPath) } : file;
    } catch (err) {
      if (err instanceof SubjectAreaFileError) {
        const fileProblem = this.subjectAreaFileProblemPayload(err, document.uri.fsPath);
        if (!fileProblem) throw new EditRefused(err.message);
        const next = fileProblem.fileProblem === 'empty' ? 'Restore its content, then try again.' : 'Fix it and save, then try again.';
        throw new EditRefused(`${fileProblem.message} ${next}`);
      }
      if (err instanceof NotASubjectAreaObject) {
        throw new EditRefused(`Subject area file ${shown} does not contain a JSON object.`);
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
  private warnAboutDuplicateTables(domain: UnifiedSubjectArea): void {
    if (this.refreshHolds > 0) return;
    const used = new Set(domain.logical.models.map((m) => m.name.toLowerCase()));
    const rel = (p: string): string => this.tableLibraryService.libraryRelativePath(p);
    for (const entry of this.tableLibraryService.listTableFiles()) {
      if (!entry.shadowedBy || !used.has(entry.name.toLowerCase())) continue;
      const key = `${domain.layer}/${domain.domain}\0${entry.filePath}`;
      if (this.duplicateWarningsShown.has(key)) continue;
      this.duplicateWarningsShown.add(key);
      // In both libraries (#162): a project half-way between the v5 and v6
      // naming. Reported, never resolved here — the v6 file is not written.
      const shadowedBy = entry.shadowedBy;
      if (entry.library && !this.tableLibraryService.isTableNamingFile(shadowedBy)) {
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
      const fixable = !entry.library;
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
  ): DisplaySubjectArea {
    const editorPayload = this.buildWebviewPayload(domain, manifest, ymlData, domain.modelFolder);
    const readOnly = domain.stage === 'physical';
    const dbtKeyIndex = dbtKeyIndexOf(ymlData, manifest);

    const display = toDisplaySubjectArea(domain, {
      viewConfig,
      stubColumns,
      layerConfig: this.layerService.getLayer(domain.layer),
      readOnly,
      editorPayload,
      // A relationship drawn backwards is flagged on dbt's evidence too (#163).
      dbtKeyIndex,
    });
    // dbt's key evidence orients new relationships on an editable canvas (#133 L1).
    return readOnly ? display : withDbtKeyHints(display, dbtKeyIndex);
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
    options: { persistPositions?: boolean } = {},
  ): Promise<number | undefined> {
    const errorKey = panelKey ?? document.uri.toString();

    // A JSON file under the semantic dir is not automatically a domain. The
    // custom editor's `**/.erd-studio/*/*.json` selector also matches
    // `templates/*.json` and the other reserved directories, and a glob cannot
    // express the exclusion, so the refusal lives here. Rendering a canvas for
    // one of those can only ever end in a parse error the user cannot act on.
    if (!isSubjectAreaFilePath(document.uri.fsPath, firstLineOf(document)) && document.uri.fsPath.toLowerCase().endsWith('.dbml')) {
      // A table or relationships file shown through another scheme (an SCM
      // diff), or reached directly: core's own words, with Open as Text.
      this.postLoadError(webview, errorKey, {
        message: `${document.uri.fsPath} is a DBML table or relationships file, not a diagram. Open a diagram in a layer folder.`,
        kind: 'not-a-domain',
      }, undefined, 'notDomain');
      return undefined;
    }
    if (!isSubjectAreaFilePath(document.uri.fsPath)) {
      this.postLoadError(webview, errorKey, {
        message:
          `${path.basename(document.uri.fsPath)} is not an ERD Studio subject area file — ` +
          `subject areas live in ${path.basename(path.dirname(path.dirname(document.uri.fsPath)))}/{layer}/{domain}.json. ` +
          `Open it as text to edit it.`,
        kind: 'not-a-domain',
      }, undefined, 'notDomain');
      return undefined;
    }

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
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();
      const welcomeDismissed = !!this.context.globalState.get('welcomeDismissed');
      const dbtKeyIndex = dbtKeyIndexOf(ymlData, manifest);

      timer.phase('reading the diagram and its tables');
      let unifiedDomain = await this.readSubjectAreaTolerantly(document.uri.fsPath, { dbtKeyIndex });
      this.warnAboutDuplicateTables(unifiedDomain);

      // A fresh domain — models but not one stored position, typically written
      // by an AI assistant with `viewConfig: {}` — is laid out by the webview's
      // ELK auto layout instead, which persists through `updatePositions` (one
      // edit, one undo step). The simple placement below still goes out in the
      // payload so the first paint is never at (0,0), but it is not written:
      // should the ELK run fail, the next open simply asks again.
      // A DBML diagram's positions live in its layout file (`.dbdiagram`),
      // written the same way.
      const autoLayout = activeStage === 'logical' && isFreshLayout(unifiedDomain);

      // Auto-assign positions for models that lack them (e.g. added by AI agents)
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
        const physicalDomain = this.subjectAreaService.buildPhysicalSubjectArea(unifiedDomain, ymlData, manifest, catalog);
        postedTables = physicalDomain.models.length;
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) { physicalDomain.layerConfig = layerConfig; }
        this.post(webview, { type: 'domainLoaded', payload: physicalDomain, welcomeDismissed });
        if (options.persistPositions) this.recordCanvasOpen(document, 'physical', physicalDomain.models.length, catalog !== undefined);
      } else {
        const domain = SubjectAreaService.toLogicalStage(unifiedDomain);
        const displayDomain = this.buildDisplaySubjectArea(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns);
        postedTables = displayDomain.models.length;
        // What the turn-round offer asks about (#163): the lines this canvas flags, without reading the file again.
        this.backwardsDrawn.set(document.uri.toString(), displayDomain.relationships.filter((r) => r.keysContradict));
        this.post(webview, {
          type: 'domainLoaded',
          payload: displayDomain,
          welcomeDismissed,
          ...(autoLayout ? { autoLayout: true } : {}),
          ...this.manifestHintFlag(),
          ...this.logicalOnlyFlag(),
        });
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
        this.postLoadError(webview, errorKey, fileProblem, err, classifySubjectAreaLoadFailure(err));
        return undefined;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.postLoadError(webview, errorKey, {
        message,
        ...(err instanceof SubjectAreaFileError ? { kind: 'domain-file' as const } : {}),
        ...(err instanceof SubjectAreaFileError && err.mergeConflict ? { mergeConflict: true as const } : {}),
      }, err, classifySubjectAreaLoadFailure(err));
    }
    return undefined;
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
      return codecFor(document.uri.fsPath).parse(document.getText(), document.uri.fsPath, readLayoutText(document.uri.fsPath)).holdsOwnTables === true;
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
        if (detectSubjectAreaFormat(JSON.parse(document.getText()) as Record<string, unknown>) === 'v4') format = 'v4';
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
    if (stage === 'logical') this.scheduleRelationshipSurvey(document);
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
        ? codecFor(document.uri.fsPath).parse(document.getText(), document.uri.fsPath, readLayoutText(document.uri.fsPath)).parsed
        : JSON.parse(document.getText()) as Record<string, unknown>;
      // Read only: a v6 file (#162) is surveyed like v5, through its v5 keys.
      const format = detectSubjectAreaFormat(parsed);
      const section = this.getStageSection(format === 'v6' ? normaliseSubjectAreaDocument(parsed) : parsed, 'logical');
      const v5 = format === 'v6' || this.isSubjectAreaV5(parsed);
      const models = v5 ? this.tableLibraryService.listTables() : ((section.models ?? []) as SemanticTable[]).filter((m) => !!m && typeof m === 'object');
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
  ): void {
    if (this.lastLoadError.get(errorKey) === payload.message) {
      return;
    }
    this.lastLoadError.set(errorKey, payload.message);
    telemetry.error('domainLoad');
    telemetry.error(subjectAreaLoadErrorCode(failure));
    hostErrorLog.record('sendDomainData', err ?? payload.message);
    log.error(`[SemanticEditorProvider] Failed to load domain: ${payload.message}`);
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
    // A DBML diagram's save writes its layout file, which can be refused (the
    // diagram is read-only, the layout is open with unsaved changes or does
    // not read). A refresh path never fails on a write: the canvas still
    // loads with the computed positions, and the next open asks again.
    try {
      if (this.parseSubjectAreaFile(document).writable === false) return false;
      return await save();
    } catch (err) {
      if (err instanceof EditRefused || err instanceof DbmlEditRefused || err instanceof DbdiagramLayoutRefused) {
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
    for (const [panelKey, { document, webview, activeStage }] of Array.from(this.openPanels.entries())) {
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          `[SemanticEditorProvider] Refresh failed for ${document.uri.fsPath}: ${message}`,
        );
        this.post(webview, {
          type: 'error',
          payload: { message: `Refresh failed: ${message}` },
        });
      }
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
        if (names.some((n) => wanted.has(normaliseName(n)))) {
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

  /** Drop everything kept for one canvas (on its dispose, or when it is found gone). */
  private forgetPanel(panelKey: string, webview: vscode.Webview): void {
    this.disposedWebviews.add(webview);
    // Only this panel's entry: another canvas of the same file may have replaced it.
    if (this.openPanels.get(panelKey)?.webview === webview) this.openPanels.delete(panelKey);
    this.editedTablePaths.delete(panelKey);
    this.undoRewoundLayout.delete(panelKey);
    this.undoWhileHeld.delete(panelKey);
    clearTimeout(this.nativeUndoTimers.get(panelKey));
    this.nativeUndoTimers.delete(panelKey);
    this.lastLoadError.delete(panelKey);
  }

  /** Redraw every open canvas of the diagram at `fsPath` (its layout file changed outside the editor). */
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
    model: DesignTable,
    stage: 'logical',
  ): Promise<void> {
    try {
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
      model = { ...model, name: model.name.trim() };

      const text = document.getText();
      const parsed = this.parseSubjectAreaDocument(document, text);
      const section = this.getStageSection(parsed, stage);

      // V5: create central model file + add name reference to domain
      if (this.isSubjectAreaV5(parsed)) {
        const modelNames = (section.models ?? []) as string[];
        const inDomain = modelNames.find((n) => sameName(n, model.name));
        if (inDomain !== undefined) {
          webview.postMessage({ type: 'error', payload: { message: `Table "${inDomain}" already exists in this subject area.` } });
          return;
        }
        // A new table's name follows the authoring rule (a letter first), so it
        // is never `_relationships` (§2.1); the planner refuses that name for
        // every other caller.
        // The model library is shared across domains — never overwrite a
        // logical-models/{name}.yml that another domain may depend on. Case is
        // ignored: `DimDate` next to `dimdate.yml` is one file on macOS/Windows.
        const inLibrary = this.tableLibraryService.findTableNameIgnoringCase(model.name);
        if (inLibrary !== null) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Table "${inLibrary}" already exists in the Table Library (${this.libraryRelativePath(inLibrary)}). ` +
                'Use "Add Existing Table" to reference it in this subject area, or, for a separate table also called ' +
                `${model.name}, name it ${sameTableName(model.name, document.uri.fsPath)} and set its warehouse name to ${model.name}.`,
            },
          });
          return;
        }

        // Central model file — written via the same WorkspaceEdit as the domain
        // change so creating the model is a single, atomic, undoable step.
        const semanticModel: import('../types/semantic').SemanticTable = {
          name: model.name,
          schema: model.schema,
          description: model.description,
          columns: model.columns,
          ...(model.modelRole ? { modelRole: model.modelRole } : {}),
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
          { refreshWebview: true, webview, stage, modelFiles: { save: [{ model: semanticModel }] } },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add table to subject area.' } });
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
              payload: { message: `Table "${model.name}" already exists in this subject area.` },
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
          errorLabel: 'Failed to add table to subject area.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add model failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Add column failed: ${message}`);
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
            renameColumnInRelationships([model], payload.modelName, payload.oldColumnName, payload.column.name);
          }
        }, domainMutator, columnRenamed
          // Library relationships in other models that point at the renamed column (#126).
          ? renameColumnInRelationships(
            this.otherLibraryTables(payload.modelName), payload.modelName, payload.oldColumnName, payload.column.name)
          : [],
        // And the copies other diagrams keep of their own (#133 L5).
        columnRenamed ? (other) => renameColumnInSubjectAreaRelationships(
          stageRelationships(other), payload.modelName, payload.oldColumnName, payload.column.name) : undefined);
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
      log.error(`[SemanticEditorProvider] Update column failed: ${message}`);
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
        // The whole library, as read before the edit: where a composite the column is part of is found.
        const library = this.tableLibraryService.listTables();
        const ok = await this.applyTableEdit(
          document,
          webview,
          payload.modelName,
          (model) => {
            const columns = model.columns ?? [];
            const idx = columns.findIndex((c) => c.name === payload.columnName);
            if (idx === -1) return;
            columns.splice(idx, 1);
            removeColumnRelationships([model], payload.modelName, payload.columnName, library);
          },
          (sec) => {
            // A composite key loses all its members with one column (#133 L2), the library's included.
            sec.relationships = removeColumnFromSubjectAreaRelationships(
              (sec.relationships ?? []) as Array<Record<string, unknown>>, payload.modelName, payload.columnName, library);
          },
          // Library relationships in other models that point at the removed column (#126).
          removeColumnRelationships(this.otherLibraryTables(payload.modelName), payload.modelName, payload.columnName, library),
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
      log.error(`[SemanticEditorProvider] Remove column failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Toggle key failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Reorder columns failed: ${message}`);
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
      const { markKey, extraPairs, ...rest } = payload;
      const drawn: Relationship = {
        fromModel: rest.fromModel, fromColumn: rest.fromColumn, toModel: rest.toModel, toColumn: rest.toColumn,
        cardinality: rest.cardinality, ...(rest.role !== undefined ? { role: rest.role } : {}),
      };
      await this.commitRelationshipWrite(
        document, webview,
        { kind: 'add', drawn, ...(markKey ? { markKey } : {}), ...(extraPairs?.length ? { extraPairs } : {}) },
        stage, 'Failed to add relationship.',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add relationship failed: ${message}`);
      this.recordRelationshipFailure(err);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add relationship: ${message}` } });
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
  ): Promise<{ home: 'library' | 'domain'; changed: SemanticTable[] } | null> {
    // Several ops (Turn round all, #163) are folded into one plan, so they are one edit and one undo step.
    const ops: readonly RelationshipWriteOp[] = Array.isArray(op) ? op : [op as RelationshipWriteOp];
    const parsed = this.parseSubjectAreaDocument(document);
    const v5 = this.isSubjectAreaV5(parsed);
    const models = v5 ? this.tableLibraryService.listTables() : [];
    // A DBML diagram always stores relationships in the library (D5).
    const home = v5 && this.relationshipsInLibrary(models, document) ? 'library' : 'domain';
    const dbt = await this.loadDbtKeyIndex();
    // Filled by the mutator, which applySubjectAreaEdit runs before it reads modelFiles.
    const save: Array<{ model: SemanticTable }> = [];
    let grouped: { count: number; compositeKey: string } | undefined;
    let audit: RelationshipAudit | undefined;
    const success = await this.applySubjectAreaEdit(
      document,
      (section) => {
        const input: RelationshipWriteInput = { home, models, domainRelationships: (section.relationships ?? []) as Relationship[], dbt };
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
          // A DBML diagram's object holds only its pending relationships (D27), which an edit may keep or
          // remove but never add or change; the writer refuses anything else.
          if (home === 'library' && this.isDbmlDocument(document)) {
            const identity = (r: Relationship): string => [r.fromModel, r.fromColumn, r.toModel, r.toColumn, r.cardinality, r.role ?? ''].map((p) => String(p ?? '').toLowerCase()).join('\u0000');
            const held = new Set(((section.relationships ?? []) as Relationship[]).map(identity));
            if (plan.domainRelationships.some((r) => !held.has(identity(r)))) {
              throw new EditRefused('A DBML diagram holds no relationships; they live in the table library.');
            }
          }
          section.relationships = plan.domainRelationships;
        }
        save.push(...plan.changed.map((model) => ({ model })));
        grouped = plan.grouped;
      },
      { webview, stage, errorLabel, modelFiles: { save }, onUnsaved: () => telemetry.error('relWriteFailed'), onApplied },
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
          webview.postMessage({ type: 'error', payload: { message: `Table "${inDomain}" already exists in this subject area.` } });
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
                'Choose a different name, or use "Add Existing Table" to reference it in this subject area.',
            },
          });
          return;
        }
        const existingModel = this.tableLibraryService.getTable(payload.oldName);
        if (!existingModel) {
          webview.postMessage({ type: 'error', payload: { message: this.tableUnavailableMessage(payload.oldName) } });
          return;
        }
        // The new name follows the authoring rule (a letter first), so it is
        // never `_relationships` (§2.1); the planner refuses it for any other caller.
        const renamedModel: import('../types/semantic').SemanticTable = { ...existingModel, name: trimmedNew };
        // Library relationships that point at the model — its own self-references
        // and every other model's — follow the rename (#126).
        renameTableInRelationships([renamedModel], payload.oldName, trimmedNew);
        const pointingAtIt = renameTableInRelationships(
          this.otherLibraryTables(payload.oldName), payload.oldName, trimmedNew);

        // Update domain (model reference name, relationships, positions) and
        // create-new + delete-old yml in one WorkspaceEdit so the rename is atomic
        // and a single undo restores both files.
        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
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
                { model: renamedModel, fromName: payload.oldName },
                ...pointingAtIt.map((model) => ({ model })),
              ],
              delete: [payload.oldName],
            },
            // Every other diagram that names the model follows the rename —
            // its model list, position and own relationship copies (#133 L5).
            otherDomains: (other) => renameTableInSubjectArea(other, payload.oldName, trimmedNew),
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
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
            webview.postMessage({ type: 'error', payload: { message: `Table "${trimmedNew}" already exists in this subject area.` } });
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
      log.error(`[SemanticEditorProvider] Rename model failed: ${message}`);
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
        const success = await this.applySubjectAreaEdit(
          document,
          (sec, p) => {
            const models = (sec.models ?? []) as string[];
            sec.models = models.filter((name) => !namesSet.has(name));

            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = relationships.filter(
              (rel) => !namesLower.has(String(rel.fromModel).toLowerCase()) && !namesLower.has(String(rel.toModel).toLowerCase()),
            );

            pruneViewConfigForRemovedTables(p, namesSet);
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
        const filesToOffer = [...namesSet].filter((name) => this.tableLibraryService.tableExists(name));
        if (filesToOffer.length > 0) {
          const fileIsSingle = filesToOffer.length === 1;
          const dbmlNames = filesToOffer.filter((name) => this.tableLibraryService.tableStorage(name) === 'dbml');
          const cascade = dbmlNames.length > 0 ? this.describeDbmlDeleteCascade(dbmlNames) : '';
          const prompt = fileIsSingle
            ? `Table "${filesToOffer[0]}" removed from this subject area. Delete the table file entirely?${cascade}`
            : `${filesToOffer.length} tables removed from this subject area. Delete their table files entirely?${cascade}`;
          const deleteLabel = fileIsSingle ? 'Delete Table File' : 'Delete Table Files';
          const keepLabel = fileIsSingle ? 'Keep File' : 'Keep Files';
          void vscode.window
            .showInformationMessage(prompt, deleteLabel, keepLabel)
            .then(async (choice) => {
              if (choice !== deleteLabel) return;
              // Captured before the delete: afterwards the folder is unknowable.
              const filePaths = filesToOffer.map((name) => this.tableLibraryService.tablePath(name));
              const shownPaths = filesToOffer.map((name) => this.libraryRelativePath(name));
              const deleteFiles = async (): Promise<void> => {
                // A DBML table: the D16 cascade, one WorkspaceEdit through applyFileWrites.
                if (filesToOffer.some((name) => this.tableLibraryService.tableStorage(name) === 'dbml')) {
                  let result: { ok: boolean; unrestored: string[] };
                  try {
                    result = await this.deleteTablesWithCascade(filesToOffer);
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
                const deleted = await applyFileWrites(filePaths.map((filePath): FileWrite => ({ kind: 'delete', path: filePath })));
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
      log.error(`[SemanticEditorProvider] Remove ${errorLabel} failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${errorLabel}: ${message}` } });
    }
  }

  /**
   * What deleting DBML tables also removes, for the Delete Table prompts
   * (D16): the relationships the cascade drops (the deleted tables' own and
   * other DBML owners' to them; a YAML owner keeps its own) and the DBML
   * diagrams that list them. `other` words them for the canvas, whose own
   * diagram has just dropped them.
   */
  describeDbmlDeleteCascade(names: readonly string[], other = true): string {
    const lowerNames = new Set(names.map((n) => n.toLowerCase()));
    let relationships = 0;
    for (const model of this.tableLibraryService.listTables()) {
      const deleted = lowerNames.has(model.name.toLowerCase());
      if (!deleted && this.tableLibraryService.tableStorage(model.name) !== 'dbml') continue;
      for (const rel of model.relationships ?? []) {
        if (deleted || lowerNames.has(rel.toModel.toLowerCase())) relationships++;
      }
    }
    let diagrams = 0;
    for (const summary of this.listOtherSubjectAreas('')) {
      if (summary.storage !== 'dbml') continue;
      const members = subjectAreaTableNames(this.openOrDiskText(summary.filePath) ?? '', summary.filePath) ?? [];
      if (members.some((m) => lowerNames.has(m.toLowerCase()))) diagrams++;
    }
    const rels = `${relationships} relationship${relationships === 1 ? '' : 's'}`;
    const places = `${diagrams} ${other ? 'other ' : ''}diagram${diagrams === 1 ? '' : 's'}`;
    return ` This removes the table's file, its ${rels} and its place in ${places}.`;
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
   */
  async deleteTablesWithCascade(names: readonly string[]): Promise<{ ok: boolean; unrestored: string[] }> {
    const lowerNames = new Set(names.map((n) => n.toLowerCase()));
    const readText = (filePath: string): string | null => this.openOrDiskText(filePath);
    let writes: FileWrite[];
    try {
      const lib = this.tableLibraryService.planTableWrites(this.tableLibraryService.dbmlDeleteCascadeOps(names), undefined, { readText });
      const plan = lib.plan ?? this.tableLibraryService.planTableWrites(undefined, undefined, { dbml: true, readText }).plan!;
      const resolver = this.resolverOf(plan);
      const diagrams = this.rewriteOtherSubjectAreaWrites('', (parsed) => {
        const logical = (parsed.logical ?? {}) as Record<string, unknown>;
        const models = Array.isArray(logical.models) ? (logical.models as unknown[]) : [];
        const removed = new Set(models.filter((m): m is string => typeof m === 'string' && lowerNames.has(m.toLowerCase())));
        if (removed.size === 0) return false;
        logical.models = models.filter((m) => !(typeof m === 'string' && removed.has(m)));
        pruneViewConfigForRemovedTables(parsed, removed);
        return true;
      }, resolver, { dbmlOnly: true });
      writes = [...lib.writes, ...diagrams];
    } catch (err) {
      throw this.refusalOf(err);
    }
    const dirty = dirtyFiles(writes.map((w) => w.path));
    if (dirty.length > 0) {
      throw new EditRefused(`${path.relative(this.workspaceRoot, dirty[0]).split(path.sep).join('/')} has unsaved changes. Save or revert it, then try again.`);
    }
    // The watchers wait for these files instead of deciding while the saves
    // run (one per diagram listing the table), so none is taken for an
    // outside change before its record is made.
    const expectation = this.ownWriteTracker.expectWrite(writes.map((w) => w.path));
    const unsaved: string[] = [];
    const saveFailures = new Set<SaveFailure>();
    let modelFileUnsaved = false;
    let applied: AppliedFileWrites;
    try {
      applied = await applyFileWrites(writes, {});
      // Not applied: `unrestored` lists the files the reconcile could not put back (its modal already named them).
      if (!applied.ok) return { ok: false, unrestored: applied.unrestored };
      // Creates and deletes landed with the edit itself: recorded before the saves.
      for (const filePath of applied.created) this.ownWriteTracker.recordWrite(filePath);
      for (const filePath of applied.deleted) this.ownWriteTracker.recordDelete(filePath);
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
    }
    if (unsaved.length > 0) {
      for (const code of saveFailureCodes(saveFailures, { modelFile: modelFileUnsaved })) telemetry.error(code);
      void vscode.window.showErrorMessage(this.describeUnsaved(unsaved));
    }
    this.tableLibraryService.invalidatePaths(writtenPaths(applied));
    await this.refreshAllOpenSubjectAreas();
    for (const uri of applied.replaced) this._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: true });
    return { ok: true, unrestored: [] };
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
      log.error(`[SemanticEditorProvider] Remove ${label} failed: ${message}`);
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
    if (isExplainedRefusal(err)) return;
    telemetry.error('relHandlerFailed');
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
      log.error(`[SemanticEditorProvider] Update relationship failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Edit relationship failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Position update failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Add annotation failed: ${msg}`);
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
      log.error(`[SemanticEditorProvider] Update annotation failed: ${msg}`);
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
      log.error(`[SemanticEditorProvider] Remove ${label} failed: ${msg}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${label}: ${msg}` } });
    }
  }

  private async handleAddExistingModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
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
          webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" already exists in this subject area.` } });
          return;
        }

        // Seed the logical model from yml (primary) or the manifest (fallback)
        // when it is not in the library yet — the same seeding Draw from dbt
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
            webview.postMessage({ type: 'error', payload: { message: `Table "${payload.modelName}" not found in your dbt .yml files, the manifest or the table library.` } });
            return;
          }
          seededModel = { ...seed, name: payload.modelName };
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
            ...(routed.saves.length > 0 ? { modelFiles: { save: routed.saves.map((model) => ({ model })) } } : {}),
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
          if (routed.unstored) void vscode.window.showInformationMessage(`Added ${payload.modelName}. ${routed.unstored}`);
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add table to subject area.' } });
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
          payload: { message: `Table "${payload.modelName}" not found in your dbt .yml files or the manifest.` },
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
              payload: { message: `Table "${payload.modelName}" already exists in this subject area.` },
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
          errorLabel: 'Failed to add table to subject area.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add existing model failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add table: ${message}` } });
    }
  }

  /**
   * "Add models from dbt" — the empty canvas's primary action, a batch version
   * of Add Existing Model. Asks which dbt models with the Draw from dbt picker
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
        title: 'Add tables from dbt',
      });
      if (!pick) { telemetry.feature('addFromDbtCancelled'); return; }

      await this.queueEdit(panelKey, () =>
        this.applyDbtModels(document, webview, pick.modelNames, ymlData, manifest));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add models from dbt failed: ${message}`);
      // A refusal the toast explains (a conflicted diagram, a model file
      // with unsaved edits) is not a breakage.
      if (!isExplainedRefusal(err)) telemetry.error('addFromDbtFailed');
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
  ): Promise<void> {
    try {
      if (!this.isSubjectAreaV5(this.parseSubjectAreaDocument(document))) {
        this.post(webview, {
          type: 'error',
          payload: { message: 'Adding several tables at once needs the central Table Library. Run "ERD Studio: Migrate Subject Areas to the Central Table Library" first, or add them one at a time.' },
        });
        return;
      }
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      await this.applyDbtModels(document, webview, modelNames, ymlData, manifest, 'picked');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add existing models failed: ${message}`);
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
  ): Promise<void> {
    const fromDbt = origin === 'dbt';
    const from = fromDbt ? ' from dbt' : '';
    try {
      // Re-read inside the queue: an edit may have landed while the picker was open.
      const parsed = this.parseSubjectAreaDocument(document);
      const section = this.getStageSection(parsed, 'logical');
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
        describeSkippedDbtModels(draft.skipped),
        alreadyIn.length > 0 ? `Already in this diagram: ${alreadyIn.slice(0, 5).join(', ')}${alreadyIn.length > 5 ? ` and ${alreadyIn.length - 5} more` : ''}.` : '',
      ].filter(Boolean).join(' ');
      if (draft.modelNames.length === 0) {
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
      const routed = this.routeAddedRelationships(document, draft.relationships, draft.newModels);
      await this.applySubjectAreaEdit(
        document,
        (sec, p) => {
          const names = (sec.models ?? []) as string[];
          const wasEmpty = names.length === 0;
          const listed = new Set(names.map(normaliseName));
          names.push(...draft.modelNames.filter((name) => !listed.has(normaliseName(name))));
          sec.models = names;
          if (routed.kept.length > 0) {
            sec.relationships = [...((sec.relationships ?? []) as Relationship[]), ...routed.kept];
          }
          // Placement sees every edge the domain will draw, wherever it is stored.
          const relationships = [...((sec.relationships ?? []) as Relationship[]), ...draft.relationships.filter((r) => !routed.kept.includes(r))];

          const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
          const positions = { ...((vc.positions ?? {}) as Record<string, NodePosition>) };
          if (wasEmpty) {
            // Keep it a fresh layout (isFreshLayout): no stored position for
            // any model, so the refresh asks the webview for an ELK layout.
            for (const name of draft.modelNames) delete positions[name];
            if (vc.positions !== undefined) vc.positions = positions;
          } else {
            // A member already listed (made from dbt where it was drawn as missing) keeps its place.
            const unplaced = draft.modelNames.filter((name) => !Object.prototype.hasOwnProperty.call(positions, name));
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
          ...(routed.saves.length > 0 ? { modelFiles: { save: routed.saves.map((model) => ({ model })) } } : {}),
          onSuccess: () => {
            if (fromDbt) telemetry.feature('addFromDbt');
            this.selectorsService.scheduleRegenerate();
            const note = [skippedNote, routed.unstored].filter(Boolean).join(' ');
            if (note) {
              const added = draft.modelNames.length;
              void vscode.window.showInformationMessage(
                `Added ${added} table${added === 1 ? '' : 's'}${from}. ${note}`,
              );
            }
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Add models${from} failed: ${message}`);
      // A refusal the toast explains (a conflicted diagram, a model file
      // with unsaved edits) is not a breakage.
      if (fromDbt && !isExplainedRefusal(err)) telemetry.error('addFromDbtFailed');
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
      log.error(`[SemanticEditorProvider] Update design rationale failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Update description failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Update grain failed: ${message}`);
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
      log.error(`[SemanticEditorProvider] Update alias failed: ${message}`);
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
      const ok = await this.applyTableEdit(document, webview, payload.modelName, (model) => {
        let target: { meta?: Meta } = model;
        if (payload.columnName !== undefined) {
          const column = model.columns?.find((c) => c.name === payload.columnName);
          if (!column) throw new Error(`Column "${payload.columnName}" not found.`);
          target = column;
        }
        const meta: Meta = { ...(target.meta ?? {}) };
        for (const key of payload.remove ?? []) delete meta[key];
        for (const [key, value] of Object.entries(payload.set ?? {})) setMetaEntry(meta, key, value);
        if (Object.keys(meta).length > 0) { target.meta = meta; } else { delete target.meta; }
      });
      if (!ok) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update metadata.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Update meta failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update metadata: ${message}` } });
    }
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
      log.error(`[SemanticEditorProvider] Update model role failed: ${message}`);
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
        this.post(webview, { type: 'stageData', payload: physicalDomain, ...reply });
        // #113: where a missing manifest is met (once per day).
        if (this.manifestService.isMissing) telemetry.featureOnce('manifestMissingPhysical');
      } else {
        // Logical — extract from unified file
        const domain = this.subjectAreaService.getSubjectAreaStage(document.uri.fsPath, { dbtKeyIndex });
        const displayDomain = this.buildDisplaySubjectArea(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns);
        this.post(webview, { type: 'stageData', payload: displayDomain, ...reply, ...this.manifestHintFlag(), ...this.logicalOnlyFlag() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[SemanticEditorProvider] Stage switch failed: ${message}`);
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
      }
      webview.postMessage({ type: 'discrepancyReport', payload: null });
      return;
    }

    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel) return;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();
      const sourceStage = panel.activeStage;
      const targetStage = payload.compareAgainst;

      // The one comparison orchestration, shared with the `erd-studio diff` CLI.
      const { report } = computeSubjectAreaDiff(
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
      log.error(`[SemanticEditorProvider] Discrepancy comparison failed: ${message}`);
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
        modelFolder: (name) => this.tableLibraryService.tableFolder(name),
        tableLibraryFile: (name) => this.tableLibraryService.tableLibraryFile(name),
        newTableLibraryDir: this.tableLibraryService.newTableLibraryDirName(),
        newTableFilePath: (name) => {
          try { return this.tableLibraryService.libraryRelativePath(this.tableLibraryService.pathForNewTable(name)); } catch { return undefined; }
        },
        relationshipsFile: (name) => {
          const file = this.tableLibraryService.relationshipsFileFor(name);
          return file === undefined ? undefined : this.tableLibraryService.libraryRelativePath(file);
        },
      });

      const totalActions = countSyncPlanActions(syncPlan);
      if (totalActions === 0) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'No actionable resolutions selected.' },
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
      log.error(`[SemanticEditorProvider] Sync plan generation failed: ${msg}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to generate sync plan: ${msg}` },
      });
    }
  }

  /**
   * Run `dbt compile` in a VS Code terminal.
   * The existing FileWatcherService will detect manifest changes and refresh.
   */
  private async handleRunDbtCompile(): Promise<void> {
    const terminal = vscode.window.createTerminal({ name: 'dbt compile', cwd: this.workspaceRoot });
    terminal.show();
    const activate = findVenvActivate(this.workspaceRoot);
    terminal.sendText(activate ? `${activate} && dbt compile` : 'dbt compile');
  }

  /**
   * Launch Claude Code in a terminal to execute the sync plan.
   *
   * The user is shown a modal that names the exact command before anything
   * runs. `--dangerously-skip-permissions` is only added when the
   * `erdStudio.claudeSync.skipPermissions` setting is enabled (default off),
   * because it lets Claude edit files in the workspace without asking.
   *
   * The prompt is typed into the Claude TUI after a short delay; if the user
   * closes the terminal in the meantime the send is skipped rather than
   * throwing "Terminal has already been disposed" inside the timer.
   */
  private async handleLaunchClaudeSync(): Promise<void> {
    const semanticDir = getErdStudioSetting('semanticDir', '.erd-studio');
    const skipPermissions = getErdStudioSetting<boolean>('claudeSync.skipPermissions', false) === true;
    const planPath = `${semanticDir}/.sync-plan.json`;
    const prompt = `Execute the erd-studio sync plan at ${planPath} using the erd-studio skill. Read .claude/skills/erd-studio/SYNC.md for the action reference and follow the execution steps.`;

    const claudeCommand = skipPermissions ? 'claude --dangerously-skip-permissions' : 'claude';
    const activate = findVenvActivate(this.workspaceRoot);
    const launchCommand = activate ? `${activate} && ${claudeCommand}` : claudeCommand;

    const detail = skipPermissions
      ? `Command: ${claudeCommand}\n\n` +
        'The --dangerously-skip-permissions flag lets Claude Code edit files in this workspace ' +
        'without asking for confirmation. Set "erdStudio.claudeSync.skipPermissions" to false to keep the permission prompts.'
      : `Command: ${claudeCommand}\n\n` +
        'Claude Code will ask before editing files. Enable "erdStudio.claudeSync.skipPermissions" ' +
        'to run unattended with --dangerously-skip-permissions.';
    const LAUNCH = 'Launch';
    const choice = await vscode.window.showWarningMessage(
      `Launch Claude Code in a terminal to execute the sync plan at ${planPath}?`,
      { modal: true, detail },
      LAUNCH,
    );
    if (choice !== LAUNCH) {
      return;
    }

    const terminal = vscode.window.createTerminal({
      name: 'ERD Studio Sync',
      cwd: this.workspaceRoot,
    });
    terminal.show();
    terminal.sendText(launchCommand);
    const CLAUDE_TUI_INIT_DELAY_MS = 2000;
    setTimeout(() => {
      try {
        if (!isTerminalAlive(terminal)) {
          log.warn('[SemanticEditorProvider] Claude sync terminal closed before the prompt could be sent.');
          return;
        }
        terminal.sendText(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[SemanticEditorProvider] Failed to send sync prompt to terminal: ${message}`);
      }
    }, CLAUDE_TUI_INIT_DELAY_MS);
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
  <title>Subject Area Editor</title>
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

/**
 * True while a terminal is still open and its process has not exited.
 * `exitStatus` is set when the shell exits; a closed terminal also drops out of
 * `window.terminals`. Either signal means `sendText` would throw.
 */
function isTerminalAlive(terminal: vscode.Terminal): boolean {
  if (terminal.exitStatus !== undefined) return false;
  const open = vscode.window.terminals;
  return Array.isArray(open) ? open.includes(terminal) : true;
}
