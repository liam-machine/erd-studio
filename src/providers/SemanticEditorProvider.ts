/**
 * SemanticEditorProvider — CustomTextEditorProvider for semantic domain JSON files.
 *
 * Opens domain files (`{semanticDir}/{layer}/{domain}.json`, v5 central model
 * store) in a React webview instead of the default JSON editor. Model bodies
 * live in `{semanticDir}/logical-models/{name}.yml` and are resolved through
 * LogicalModelService; the domain file holds model names, relationships and
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
 *                         dismissManifestHint, openGettingStarted
 *   Extension → Webview:  domainLoaded, stageData (echoes switchStage
 *                         requestId), discrepancyReport, manifestStaleness,
 *                         syncPlanGenerated, openFeedback, feedbackContext,
 *                         feedbackAnalysis, feedbackSubmitted, error
 *
 * Writes and save semantics:
 *   Every domain-file write goes through `applyDomainEdit` — the ONLY place a
 *   domain WorkspaceEdit is built (parse → mutate → replace → applyEdit →
 *   document.save() → refresh). logical-models/*.yml changes ride in the same
 *   WorkspaceEdit (`applyModelEdit` / `addModelFileEdits`) so a model edit and
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
 *   `pendingUpdates` is held for the whole applyDomainEdit / undo / redo so the
 *   onDidChangeTextDocument listener does not save and re-send on its own.
 *   External edits (guard not held) are saved if dirty and re-sent.
 */

import * as crypto from 'crypto';
import { getErdStudioSetting } from '../services/configService';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  DomainFileError,
  DomainService,
  isDomainFilePath,
} from '../services/domainService';
import { computeDomainDiff } from '../services/stageDiff';
import { buildSyncPlan, countSyncPlanActions } from '../services/syncPlanBuilder';
import { findVenvActivate } from '../services/dbtEnv';
import { runDbtParse } from '../commands/runDbtParse';
import { NO_DBT_MODELS_MESSAGE } from '../commands/drawFromDbt';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import { SelectorsService } from '../services/selectorsService';
import { computeNewModelPositions, findOpenPosition } from '../services/positionService';
import {
  checkRelationships,
  computeMissingPositions,
  DomainValidationError,
  readDomainRelationshipEntries,
  relationshipFilePositions,
  sameLink,
  setMetaEntry,
  toDisplayDomain,
  type CheckDomain,
  type DisplayRelationshipIssue,
  type RelationshipEnds,
  type RelationshipFinding,
} from '@erd-studio/core';
import { buildDbtEvidenceIndex, withDbtEvidence } from '../services/stageDisplay';
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
import { findOwningDbtProject, hasDbtProjectFile, samePath } from '../services/projectDiscovery';
import type {
  AnalyzeFeedbackMessage,
  CopyFeedbackReportMessage,
  ErrorMessage,
  OpenFeedbackLinkMessage,
  OpenModelFileMessage,
  SetFeedbackProviderMessage,
  OpenFeedbackMessage,
  RelationshipKey,
  RelationshipMarkKeyPayload,
  RequestFeedbackContextMessage,
  SubmitFeedbackMessage,
} from '../types/messages';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplayDomain } from '../types/display';
import type { Rationale, Cardinality, ColumnDef, DesignModel, Meta, Stage } from '../types/semantic';
import type { UpdateColumnPayloadColumn, UpdateMetaMessage } from '../types/messages';
import type { GroundTruth } from '../types/syncPlan';
import type { NodePosition, Relationship, SemanticModel, UnifiedDomain } from '../types/semantic';
import { describeUnsupportedDomainFormat, detectDomainFormat, getRawDomainModelNames } from '../types/semantic';
import { telemetry } from '../services/telemetryService';
import { saveDocument, saveDocumentByUri } from './documentSave';
import { domainLoadErrorCode, layoutFeature, type DomainLoadFailure, type TelemetryFeature } from '../services/telemetryPayload';
import { openModelFileAt } from '../commands/openModelFile';
import {
  buildDbtDraft,
  dbtTestsOf,
  listDraftModels,
  listDraftScopes,
  markDraftKeys,
  relationshipsForAddedModels,
  seedModelFromDbt,
  type DraftSkipped,
} from '../services/dbtDraft';
import { pickDraftScope } from './dbtDraftPicker';
import { readDomainRelationships } from '../commands/moveRelationshipsToLibrary';
import {
  describeRepairOffer,
  linksTheMoveStores,
  mayHaveAutomaticRepair,
  planRelationshipRepair,
  readRepairSnapshot,
  scanDomainFiles,
  toCheckDomains,
  type RepairSnapshot,
} from '../services/relationshipRepair';
import { yamlEntryExtras } from '../services/relationshipEntryExtras';
import {
  RelationshipCommitError,
  findingsForDomain,
  mergeDomainRelationships,
  planRelationshipCommit,
  describeOtherDiagramCopies,
  removeColumnRelationships,
  removeRelationshipsToModels,
  describeRemovedRelationships,
  renameColumnInRelationships,
  renameModelInRelationships,
  resolveEndpointModels,
  routeToLibrary,
  sharedRelationshipKeys,
  toDisplayRelationshipIssues,
  usesLibraryRelationships,
  type RelationshipCommitOp,
  type RelationshipCommitPlan,
  type RelationshipMode,
} from '../services/libraryRelationships';
import { readDbtProjectConfig } from '../services/dbtProjectConfig';
import { normaliseName } from '../services/nameUtils';

/**
 * Backoff between re-reads of a domain file that read as empty or truncated.
 * Four attempts across ~1.2s — comfortably longer than the gap between the
 * create and the write of a file being replaced, and short enough that a file
 * which really is broken still says so while the user is still looking.
 */
const DOMAIN_READ_RETRY_DELAYS_MS = [150, 350, 700];

/**
 * A domain read worth retrying: core's transient failures (an empty or
 * truncated file — something is writing it right now) plus a file that exists
 * but cannot be read. On Windows a read that overlaps another process's write
 * (an AI assistant, git, dbt, a virus scanner, OneDrive) fails with a sharing
 * violation — EBUSY / EPERM / EACCES — that clears in milliseconds; failing
 * the canvas on the first one leaves an error over a file that is fine. A
 * genuinely unreadable file costs the same ~1.2 s of retries, then reports.
 */
function isRetryableDomainRead(err: unknown): err is DomainFileError {
  return err instanceof DomainFileError && (err.transient || err.reason === 'unreadable');
}

/** The fixed telemetry reason for a canvas load failure — never its message. */
export function classifyDomainLoadFailure(err: unknown): DomainLoadFailure {
  if (err instanceof DomainFileError) {
    if (err.reason === 'missing') return 'missing';
    if (err.reason === 'unreadable') return 'unreadable';
    return 'json';
  }
  if (err instanceof DomainValidationError) return 'invalid';
  return 'internal';
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The logical-models/ sub-folder new models created from a domain go in: the
 * domain file's layer directory (`{semanticDir}/{layer}/{domain}.json`).
 * `LogicalModelService` ignores a name that is not layer-shaped, so a domain
 * opened from anywhere else simply creates its models at the top level.
 */
export function modelFolderForDomain(domainFilePath: string): string {
  return path.basename(path.dirname(domainFilePath));
}

/**
 * logical-models/*.yml operations to bundle into a domain WorkspaceEdit so the
 * model file and the domain file change (and undo) together.
 */
interface ModelFileOps {
  /** Models whose yml should be written in full (created if missing). */
  save?: ModelFileSave[];
  /** Model names whose yml should be deleted (e.g. the old name on rename). */
  delete?: string[];
}

/** A single yml write inside a {@link ModelFileOps}. */
interface ModelFileSave {
  /** The model as it should end up in logical-models/{model.name}.yml. */
  model: import('../types/semantic').SemanticModel;
  /**
   * Name of the model file whose existing YAML document supplies comments,
   * key order and unknown keys. Defaults to `model.name`; a rename passes the
   * OLD name so the hand-written content of the old file is carried across to
   * the new path instead of being regenerated from scratch.
   */
  fromName?: string;
  /**
   * Indices into `model.relationships` of the entries a relationship commit
   * wrote (`planRelationshipCommit`'s `written`): rewritten in full, where
   * every other entry keeps what it does not need to change (issue #133, R6).
   */
  relationshipTargets?: number[];
}

/** The command the canvas banner and the notification run (registered in `extension.ts`). */
export const REPAIR_RELATIONSHIPS_COMMAND = 'erdStudio.repairRelationships';

/** Shown when an edit took the model library's last relationship out while diagram files still hold their own (#133 review 8). */
export const LIBRARY_MODE_ENDED_MESSAGE =
  'The model library no longer holds any relationship, but some diagram files still hold their own, so new relationships ' +
  'will now be saved in each diagram\'s file. To keep them in the model library, move the diagram files\' relationships there.';

/**
 * Shown when an edit took the last relationship out of the diagram files of a
 * project that kept them there, so new ones now go to the model library (#133).
 */
export const LIBRARY_MODE_STARTED_MESSAGE =
  'No diagram file holds a relationship any more, so new relationships will now be saved with their models in the model ' +
  'library (in the file of the model that holds the foreign key), and every diagram showing both models draws them. ' +
  'Undo puts the relationship back and returns to saving them in each diagram\'s file.';

/** Shown when an undo would rewind a Repair / Move that saved files directly (#133 review 8). */
export const UNDO_BARRIER_MESSAGE =
  'Undo stops here: Repair Relationships… (or the move to the model library) saved its changes directly, ' +
  'so undoing it in this diagram would put back only half of it. Use git (or your source control) to undo it.'

/** Whether `model.column` is the `side` end of `rel`, names without case (core's identity rule). */
function relEndIs(rel: Record<string, unknown>, side: 'from' | 'to', model: string, column?: string): boolean {
  const m = side === 'from' ? rel.fromModel : rel.toModel;
  const c = side === 'from' ? rel.fromColumn : rel.toColumn;
  return typeof m === 'string' && sameName(m, model) && (column === undefined || (typeof c === 'string' && sameName(c, column)));
}

/** Whether a relationship starts or ends at `model.column`, names without case. */
function relationshipReferencesColumnAnyCase(rel: Record<string, unknown>, model: string, column: string): boolean {
  return relEndIs(rel, 'from', model, column) || relEndIs(rel, 'to', model, column);
}

/** Whether a domain-file entry has four text ends (anything else is kept as written, never matched). */
function isWellFormedRelationship(rel: unknown): rel is Relationship {
  if (!rel || typeof rel !== 'object' || Array.isArray(rel)) return false;
  const r = rel as Record<string, unknown>;
  return ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof r[k] === 'string');
}

/** A path relative to `root`, forward-slashed, as relationship findings name files. */
function projectRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
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
function pruneViewConfigForRemovedModels(
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
 * Thrown by an `applyDomainEdit` mutator to abort without an edit. The mutator
 * has already reported the reason to the webview (or decided the request is a
 * silent no-op), so `applyDomainEdit` swallows it and returns `false`.
 */
class EditAborted extends Error {
  constructor() {
    super('edit aborted');
    this.name = 'EditAborted';
  }
}
import {
  isValidCardinality,
  isValidRelationshipEnds,
  isValidRelationshipRole,
  validateMarkKey,
  validateRepairRelationshipsPayload,
  validateStoredEnds,
  isValidKeyType,
  isValidModelRole,
  isValidStage,
  validateColumnDef as validateColumnDefPayload,
  validateColumnDefs,
  validateModelName,
  validateModelAliasPayload,
  validateMetaPayload,
  validateAnnotationPositions,
  validateAddModelsFromDbtPayload,
  validateOpenModelFilePayload,
  validateLayoutFinishedPayload,
  validateDismissManifestHintPayload,
  validateAnnotationUpdate,
  validateModelNameSafety,
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
 * workspaceState: the user chose "Don't Ask Again" on the offer to store
 * library relationships saved on their one side with the model holding the
 * foreign key (#133). Separate from the #126 key: a different question.
 */
export const RELATIONSHIP_REHOME_DECLINED_KEY = 'erdStudio.relationshipRehomeDeclined';

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

export class SemanticEditorProvider implements vscode.CustomTextEditorProvider {
  /**
   * Guard flags to prevent re-sending domain data to the webview when
   * an onDidChangeTextDocument event is triggered by our own WorkspaceEdit.
   * Keyed by document URI to support concurrent edits to multiple open domains.
   */
  private readonly pendingUpdates = new Map<string, boolean>();
  /** The move-to-library offer is made at most once per session (#126). */
  private relationshipMoveOffered = false;
  /** The last project findings and the file signature they were read from (`relationshipFindings`). */
  private relationshipFindingsCache?: { key: string; result: { findings: RelationshipFinding[]; mode: RelationshipMode } };

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
  private readonly editedModelPaths = new Map<string, Set<string>>();

  /**
   * Panels open when Repair Relationships… / Move Relationships to Model
   * Library wrote files straight to disk (#133 review 8). VS Code records the
   * reload of each open diagram as an undoable step, but the model files the
   * same run rewrote are not part of it: an undo across that step would put
   * back only the diagram's half. `edits` counts canvas edits made since (an
   * undo may rewind those), `redoable` the ones undone since.
   */
  private readonly undoBarriers = new Map<string, { edits: number; redoable: number }>();

  /** `{layer}/{domain}\0{ignored file}` pairs already warned about this session. */
  private readonly duplicateWarningsShown = new Set<string>();

  /**
   * Fires after this provider has written a domain file (and any model files)
   * to disk. Those writes are recorded as own writes, so the file watchers
   * deliberately ignore them — extension.ts listens here instead to refresh
   * the domain tree, the model library view and the context keys.
   */
  private readonly _onDidWriteDomain = new vscode.EventEmitter<{
    uri: vscode.Uri;
    /** True when a logical-models/*.yml file was created or deleted. */
    modelLibraryChanged: boolean;
  }>();

  /** @see _onDidWriteDomain */
  readonly onDidWriteDomain = this._onDidWriteDomain.event;

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
   * Load the warehouse catalog, if a reader was injected and an artifact exists.
   *
   * Always resolves — `CatalogService.loadCatalog()` degrades to undefined on
   * every failure, and `buildPhysicalDomain()` treats undefined as "no catalog".
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
    return next;
  }

  /**
   * Track all open webview panels by document URI.
   * Used by refreshAllOpenDomains() to update all editors when manifest changes.
   * activeStage tracks which stage the webview is currently displaying.
   */
  private readonly openPanels = new Map<
    string,
    {
      document: vscode.TextDocument;
      webview: vscode.Webview;
      activeStage: Stage;
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
        console.warn(`[SemanticEditorProvider] postMessage failed: ${msg}`);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[SemanticEditorProvider] postMessage threw: ${msg}`);
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
        console.error(`[SemanticEditorProvider] Message "${type}" failed: ${detail}`);
        this.post(webview, { type: 'error', payload: { message: `Failed to handle "${type}": ${detail}` } });
      }
    };
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly ymlParserService: YmlParserService,
    private readonly templateService: TemplateService,
    private readonly layerService: LayerService,
    private readonly workspaceRoot: string,
    private readonly selectorsService: SelectorsService,
    readonly logicalModelService: import('../services/logicalModelService').LogicalModelService,
    /**
     * Shared with FileWatcherService: every file this provider writes is
     * recorded here so the watcher can tell our own saves apart from an
     * external edit and skip the redundant refresh (which would clear the
     * user's selection).
     */
    private readonly ownWriteTracker: OwnWriteTracker = ownWrites,
  ) {}

  /**
   * Build supplementary payload data for webview messages.
   * Includes templates and list of available models from logical-models/, yml, and manifest.
   */
  private buildWebviewPayload(
    domain: { models: Array<{ name: string }> },
    manifest: ManifestData,
    ymlData: YmlData,
    modelFolder?: string,
  ): {
    templates: ReturnType<TemplateService['loadTemplates']>;
    manifestModels: Array<{
      name: string;
      schema: string;
      description: string;
      columnCount: number;
    }>;
    existingModels: import('../types/display').ExistingModelPreview[];
  } {
    const templates = this.templateService.loadTemplates(this.workspaceRoot);
    const existingModelNames = new Set(domain.models.map((m) => m.name));

    // Build existing models list from three sources: logical-models/, yml, and manifest
    const existingModels: import('../types/display').ExistingModelPreview[] = [];
    const addedNames = new Set<string>();

    // 1. Logical models (already designed in ERD Studio's model library)
    const logicalModels = this.logicalModelService.listModels();
    for (const model of logicalModels) {
      if (existingModelNames.has(model.name)) continue;
      // A yml whose internal `name:` is not path-safe cannot be added to a
      // domain — skip it rather than failing the whole payload.
      const absPath = this.logicalModelService.resolveModelPath(model.name);
      if (absPath === null) continue;
      existingModels.push({
        name: model.name,
        schema: model.schema ?? '',
        description: model.description ?? '',
        columnCount: (model.columns ?? []).length,
        source: 'logical',
        sourcePath: path.relative(this.workspaceRoot, absPath),
      });
      addedNames.add(model.name);
    }

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
  Drawing this file here would mix its models with the wrong project\u2019s dbt data.</p>
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
      void vscode.window.showWarningMessage(
        `ERD Studio: ${name} is not inside a dbt project, so it cannot be opened with ${current}'s data.`,
      );
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

    // Track this panel — default to logical stage (v3 unified files have no stage in path)
    const panelKey = document.uri.toString();
    this.openPanels.set(panelKey, { document, webview: webviewPanel.webview, activeStage: 'logical' });

    // --- Subscriptions (disposed when the panel closes) ---------------------

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      this.withMessageErrorBoundary(webviewPanel.webview, async (message: unknown) => {
        if (!isTypedMessage(message)) {
          console.warn('[SemanticEditorProvider] Ignoring webview message without a string "type"');
          return;
        }

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
          'requestReload', 'openGettingStarted',
          'requestFeedbackContext', 'analyzeFeedback', 'setFeedbackProvider',
          'submitFeedback', 'copyFeedbackReport', 'openFeedbackLink',
          'openModelFile', 'layoutFinished',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
          console.warn(`[SemanticEditorProvider] Dropped "${message.type}" while viewing physical stage`);
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
            // The initial load is the one refresh path allowed to persist
            // auto-computed positions for models that lack them.
            await this.sendDomainData(document, webviewPanel.webview, panelKey, { persistPositions: true });
            // After the canvas has its payload: the offer may read the whole
            // project, and the extension host must deliver the diagram first.
            setTimeout(() => { void this.maybeOfferRelationshipMove(); }, 0);
            break;
          case 'requestReload':
            // Webview detected it was orphaned (e.g. extension update before
            // activation auto-recovery could fire). Save & reload safely.
            saveAllAndReload('ERD Studio canvas connection lost').catch(err => {
              console.error('[ERD Studio] requestReload handling failed:', err);
            });
            break;
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
              await this.queueEdit(panelKey, () =>
                this.handleUpdatePositions(
                  document,
                  webviewPanel.webview,
                  payload.positions,
                  annotations,
                ),
              );
            }
            break;
          }
          case 'addModel': {
            const payload = (message as { payload?: DesignModel }).payload;
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
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality; role?: string; markKey?: RelationshipMarkKeyPayload } }).payload;
            if (payload) {
              const invalid = this.relationshipPayloadError(payload, { markKey: true });
              if (invalid) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add relationship: ${invalid}` } });
                break;
              }
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              if (!isValidRelationshipRole(payload.role)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: 'Failed to add relationship: the role must be text of at most 60 characters.' } });
                break;
              }
              telemetry.feature('addRelationship');
              await this.queueEdit(panelKey, () =>
                this.handleAddRelationship(document, webviewPanel.webview, payload));
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
            const payload = (message as { payload?: RelationshipKey & { stored?: RelationshipKey } }).payload;
            if (payload) {
              const invalid = this.relationshipPayloadError(payload, { stored: true });
              if (invalid) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to remove relationship: ${invalid}` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleRemoveRelationship(document, webviewPanel.webview, payload));
            }
            break;
          }
          case 'removeRelationships': {
            const payload = (message as { payload?: { relationships?: unknown } }).payload;
            // Validated as a whole at the boundary, exactly as the single
            // remove is: one malformed entry refuses the batch, naming it,
            // rather than deleting the rest of the selection without a word.
            const invalid = this.removeRelationshipsPayloadError(payload);
            if (invalid) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to remove relationships: ${invalid}` } });
              break;
            }
            const valid = payload as { relationships: Array<RelationshipKey & { stored?: RelationshipKey }> };
            await this.queueEdit(panelKey, () =>
              this.handleRemoveRelationships(document, webviewPanel.webview, valid));
            break;
          }
          case 'updateRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality; stored?: RelationshipKey } }).payload;
            if (payload) {
              const invalid = this.relationshipPayloadError(payload, { stored: true });
              if (invalid) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update relationship: ${invalid}` } });
                break;
              }
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleUpdateRelationship(document, webviewPanel.webview, payload));
            }
            break;
          }
          case 'editRelationship': {
            const payload = (message as { payload?: { originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string; fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality; role?: string; stored?: RelationshipKey; markKey?: RelationshipMarkKeyPayload } }).payload;
            if (payload) {
              const original = {
                fromModel: payload.originalFromModel, fromColumn: payload.originalFromColumn,
                toModel: payload.originalToModel, toColumn: payload.originalToColumn,
              };
              const invalid = !isValidRelationshipEnds(original)
                ? 'the relationship being edited is not named.'
                : this.relationshipPayloadError({ ...payload, ...original, stored: payload.stored }, { stored: true })
                  ?? this.relationshipPayloadError(payload, { markKey: true });
              if (invalid) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to edit relationship: ${invalid}` } });
                break;
              }
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to edit relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
              if (!isValidRelationshipRole(payload.role)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: 'Failed to edit relationship: the role must be text of at most 60 characters.' } });
                break;
              }
              await this.queueEdit(panelKey, () =>
                this.handleEditRelationship(document, webviewPanel.webview, payload));
            }
            break;
          }
          case 'repairRelationships': {
            const invalid = validateRepairRelationshipsPayload((message as { payload?: unknown }).payload);
            if (invalid) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: invalid } });
              break;
            }
            telemetry.feature('relMoveReview');
            // Not awaited: the command's own dialogs must not hold up this canvas's messages.
            void this.runRepairCommand();
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
          case 'addModelsFromDbt': {
            // Logical only: not in NON_MUTATION_TYPES, so the physical guard
            // above has already refused it there. The QuickPick runs outside
            // the edit queue (it can stay open for a while); the edit itself
            // is queued and re-reads the document.
            const payloadError = validateAddModelsFromDbtPayload((message as { payload?: unknown }).payload);
            if (payloadError) {
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add models from dbt: ${payloadError}` } });
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
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
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
              this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to open model file: ${payloadError}` } });
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
              const result = await submitFeedback(this.context, payload, payload.domain);
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
              await copyFeedbackReport(this.context, payload, payload.domain);
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
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update table name: ${aliasError}` } });
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
              if (payload.modelRole != null && !isValidModelRole(payload.modelRole)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to update model role: unknown role "${String(payload.modelRole)}".` } });
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
            console.warn(`[SemanticEditorProvider] Ignoring unknown webview message type "${message.type}"`);
            break;
        }
      }),
    );

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (this.pendingUpdates.get(panelKey)) {
        return;
      }
      // The editor's own Undo / Redo (Cmd+Z) rewinds the document directly.
      if (e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo) {
        const verdict = this.passUndoBarrier(panelKey, e.reason === vscode.TextDocumentChangeReason.Undo ? 'undo' : 'redo');
        if (verdict === 'blocked') {
          await this.restoreAfterBlockedUndo(document, webviewPanel.webview, panelKey);
          return;
        }
      }
      if (document.isDirty) {
        await document.save();
      }
      await this.sendDomainData(document, webviewPanel.webview, panelKey);
    });

    webviewPanel.onDidDispose(() => {
      messageSubscription.dispose();
      changeSubscription.dispose();
      this.disposedWebviews.add(webviewPanel.webview);
      this.openPanels.delete(panelKey);
      this.editedModelPaths.delete(panelKey);
      this.undoBarriers.delete(panelKey);
      this.lastLoadError.delete(panelKey);
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
   * Delegates to the shared {@link detectDomainFormat} so reads and writes agree.
   * Throws for `legacy`/`hybrid` documents so a mutation never silently casts a
   * mixed or pre-v4 file into one branch — every caller runs inside a try/catch
   * that reports the error to the webview.
   */
  private isDomainV5(parsed: Record<string, unknown>): boolean {
    const format = detectDomainFormat(parsed);
    const unsupported = describeUnsupportedDomainFormat(format, 'being edited');
    if (unsupported) {
      throw new Error(unsupported);
    }
    return format === 'v5';
  }

  /**
   * The layer folder a model created from this domain goes in, or undefined
   * for the top level: only when the domain's directory is a configured layer
   * AND the library has opted into layer folders (see `groupsByFolder`).
   */
  private newModelFolder(domainFilePath: string): string | undefined {
    const layer = modelFolderForDomain(domainFilePath);
    const layerIds = new Set(this.layerService.getAllLayers().map((l) => l.id));
    return layerIds.has(layer) && this.logicalModelService.groupsByFolder(layerIds) ? layer : undefined;
  }

  /** `logical-models/[{folder}/]{name}.yml` for an existing model file, for messages. */
  private libraryRelativePath(name: string): string {
    const folder = this.logicalModelService.modelFolder(name);
    return `logical-models/${folder ? `${folder}/` : ''}${name}.yml`;
  }

  /**
   * Apply a mutation to a model stored in logical-models/{name}.yml (v5 path).
   * Reads the model, applies the mutator callback, and writes it back through
   * the same WorkspaceEdit as the domain file so both files form one undo step
   * (see `applyDomainEdit` / `addModelFileEdits`). Nothing touches disk until
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
    const filePath = this.logicalModelService.findModelFile(modelName.trim());
    if (!filePath) {
      this.post(webview, { type: 'error', payload: { message: `Model "${modelName}" not found in logical-models/.` } });
      return;
    }
    const error = this.logicalModelService.getModelFileError(modelName.trim());
    await openModelFileAt(filePath, error?.line, error?.column);
  }

  /**
   * Why a model cannot be edited: its file has a YAML error (the file exists
   * but is broken), else the old "not found" wording.
   */
  private modelUnavailableMessage(modelName: string): string {
    const error = this.logicalModelService.getModelFileError(modelName);
    if (error) {
      return error.kind === 'read'
        ? `Can't edit "${modelName}": its file could not be read.`
        : `Can't edit "${modelName}": its file has a YAML error${error.line !== undefined ? ` on line ${error.line}` : ''}.`;
    }
    return `Model "${modelName}" not found in logical-models/.`;
  }

  /**
   * Whether this project keeps relationships in the model library (#126) —
   * see `usesLibraryRelationships` for the opt-in rule.
   */
  /** Whether the project keeps relationships in the model library now, or undefined when that cannot be read. */
  private projectKeepsRelationshipsInLibrary(): boolean | undefined {
    try {
      this.logicalModelService.invalidateCache();
      const inputs = this.logicalModelService.relationshipModeInputs();
      return this.relationshipsInLibrary(inputs.models, inputs.unreadableWithRelationships);
    } catch (err) {
      console.warn('[SemanticEditorProvider] Relationship mode check failed:', err);
      return undefined;
    }
  }

  private relationshipsInLibrary(models: readonly SemanticModel[], unreadableWithRelationships: number): boolean {
    // Library evidence already in hand settles it: no need to read every
    // domain file for a count that cannot change the answer.
    if (unreadableWithRelationships > 0 || models.some((m) => (m.relationships?.length ?? 0) > 0)) return true;
    return usesLibraryRelationships(
      models,
      this.domainService.countDomainFileRelationships(this.workspaceRoot, this.semanticDirName()),
      unreadableWithRelationships,
    );
  }

  /** The semantic directory, relative to the project root (e.g. `.erd-studio`). */
  private semanticDirName(): string {
    return path.relative(this.workspaceRoot, path.dirname(this.logicalModelService.getModelsDir()));
  }

  /**
   * Why a relationship payload is malformed, or null: four text ends, and —
   * where the message carries them — valid `stored` ends naming the same link
   * (core's `sameLink`) and a valid `markKey`.
   */
  private relationshipPayloadError(
    payload: unknown,
    accepts: { stored?: boolean; markKey?: boolean },
  ): string | null {
    if (!isValidRelationshipEnds(payload)) return "the relationship's ends are not valid.";
    const p = payload as RelationshipKey & { stored?: unknown; markKey?: unknown };
    if (accepts.stored) {
      const storedError = validateStoredEnds(p.stored);
      if (storedError) return storedError;
      if (p.stored !== undefined && !sameLink(p.stored as RelationshipKey, p)) {
        return 'the stored ends name a different relationship from the one drawn.';
      }
    }
    if (accepts.markKey) {
      const markKeyError = validateMarkKey(p.markKey);
      if (markKeyError) return markKeyError;
    }
    return null;
  }

  /** What is wrong with a `removeRelationships` payload, or null: every entry checked as a single remove is. */
  private removeRelationshipsPayloadError(payload: unknown): string | null {
    const list = (payload as { relationships?: unknown } | undefined)?.relationships;
    if (!Array.isArray(list) || list.length === 0) return 'no relationships were given.';
    const problems: string[] = [];
    list.forEach((entry, i) => {
      const error = this.relationshipPayloadError(entry, { stored: true });
      if (error) problems.push(`entry ${i + 1}: ${error}`);
    });
    return problems.length > 0 ? problems.join('; ') : null;
  }

  /**
   * Relationships an add-models edit would put in this domain file, sent to
   * their from-models' library files instead when the project keeps them
   * there (#126). `newModels` are the models the same edit creates.
   */
  private routeAddedRelationships(
    added: readonly Relationship[],
    newModels: readonly SemanticModel[],
  ): { kept: Relationship[]; saves: SemanticModel[] } {
    if (added.length === 0) return { kept: [...added], saves: [...newModels] };
    const library = this.logicalModelService.relationshipModeInputs();
    if (!this.relationshipsInLibrary(library.models, library.unreadableWithRelationships)) {
      return { kept: [...added], saves: [...newModels] };
    }
    // A model file that exists but cannot be read is refused, never treated as
    // "no file": its relationship would land in this domain file instead, or
    // (for the other end) a copy it already stores would go unseen and be
    // written twice. The add is refused, naming the file, like a canvas commit.
    const libraryModel = (name: string): SemanticModel | null => {
      const model = this.logicalModelService.getModel(name);
      if (model) return model;
      const realName = this.logicalModelService.findModelNameIgnoringCase(name) ?? name;
      const refusal = this.unreadableModelRefusal(realName);
      if (refusal) throw new Error(refusal);
      return null;
    };
    const { kept, changed } = routeToLibrary(added, newModels, libraryModel);
    const saves = [...newModels, ...changed.filter((m) => !newModels.includes(m))];
    return { kept, saves };
  }

  /**
   * Offer, once a session, what the project's relationships need — never
   * after "Don't Ask Again", and writing nothing itself (each command asks
   * before changing a file):
   *
   * - a project that keeps relationships per diagram, with at least one
   *   shared by two diagrams, is offered the move to the model library
   *   (#126);
   * - otherwise, when Repair Relationships… has something to fix on its own
   *   (a relationship saved on its one side or the wrong way round, stored
   *   twice, or spelled in another case), it is offered (#133) — from the
   *   very plan the command would make, so the two never disagree (D11). A
   *   problem only the user can settle is not nagged about: the canvas shows
   *   it (badges, banner) and `erd-studio check` lists it.
   */
  private async maybeOfferRelationshipMove(): Promise<void> {
    if (this.relationshipMoveOffered) return;
    this.relationshipMoveOffered = true;
    let snapshot: RepairSnapshot | undefined;
    try {
      const library = this.logicalModelService.relationshipModeInputs();
      if (!this.relationshipsInLibrary(library.models, library.unreadableWithRelationships)
        && !this.context.workspaceState?.get<boolean>(RELATIONSHIP_MOVE_DECLINED_KEY)) {
        const sharedKeys = sharedRelationshipKeys(readDomainRelationships(this.domainService, this.workspaceRoot, this.semanticDirName()));
        // Only links the move would really store count: one it would leave
        // where it is (a stub-only end, no readable model file, an entry's
        // own keys) is no reason to offer it — the offer would come back
        // every session for a move that can never act (#133).
        snapshot = sharedKeys.size > 0 ? this.offerSnapshot() : undefined;
        const movable = snapshot ? linksTheMoveStores(snapshot) : new Set<string>();
        const shared = [...sharedKeys].filter((key) => movable.has(key)).length;
        if (shared > 0) {
          await this.offerRelationshipMove(shared);
          return;
        }
      }
      await this.maybeOfferRepair(snapshot);
    } catch (err) {
      console.warn('[SemanticEditorProvider] Relationship move offer skipped:', err);
    }
  }

  /** The project as the offers read it: like the commands, but keeping the model cache the canvas just filled. */
  private offerSnapshot(): RepairSnapshot {
    return readRepairSnapshot({
      workspaceRoot: this.workspaceRoot,
      semanticDir: this.semanticDirName(),
      domainService: this.domainService,
      logicalModelService: this.logicalModelService,
      keepCache: true,
    });
  }

  /** The #126 offer: move a per-diagram project's relationships into the model library. */
  private async offerRelationshipMove(shared: number): Promise<void> {
    telemetry.feature('relMoveOffered');
    const choice = await vscode.window.showInformationMessage(
      `Relationships can now be defined once and shared. ${shared === 1 ? '1 relationship here is' : `${shared} relationships here are`} ` +
      'kept as a separate copy in each diagram that shows it. Move them to the model library so each is defined once?',
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
        void vscode.window.showErrorMessage(
          `Move Relationships to Model Library failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (choice === "Don't Ask Again") {
      telemetry.feature('relMoveDeclined');
      await this.context.workspaceState?.update(RELATIONSHIP_MOVE_DECLINED_KEY, true);
    } else {
      telemetry.feature('relMoveNotNow');
    }
  }

  /**
   * Offer "Repair Relationships…" when it has an automatic fix to make — the
   * plan the command itself would make, so an offer is never followed by
   * "nothing to repair". Writes nothing — the command shows every change and
   * asks first. Its own "Don't Ask Again" (RELATIONSHIP_REHOME_DECLINED_KEY,
   * kept from #133's first offer); the `relMove*` usage features are reused.
   */
  private async maybeOfferRepair(snapshot?: RepairSnapshot): Promise<void> {
    if (this.context.workspaceState?.get<boolean>(RELATIONSHIP_REHOME_DECLINED_KEY)) return;
    // The findings every payload has already computed (and cached) first: only
    // a project with something Repair might settle on its own is read and
    // planned in full — never a clean one, on every first open of a session.
    if (!snapshot && !mayHaveAutomaticRepair(this.relationshipFindings().findings)) return;
    const offer = describeRepairOffer(planRelationshipRepair(snapshot ?? this.offerSnapshot()));
    if (!offer) return;
    telemetry.feature('relMoveOffered');
    const choice = await vscode.window.showInformationMessage(offer, 'Repair Relationships…', 'Not Now', "Don't Ask Again");
    if (choice === 'Repair Relationships…') {
      telemetry.feature('relMoveReview');
      await this.runRepairCommand();
    } else if (choice === "Don't Ask Again") {
      telemetry.feature('relMoveDeclined');
      await this.context.workspaceState?.update(RELATIONSHIP_REHOME_DECLINED_KEY, true);
    } else {
      telemetry.feature('relMoveNotNow');
    }
  }

  /**
   * The project's relationship findings (`checkRelationships`): every model
   * file (`LogicalModelService.relationshipCheckModels`) and every domain file
   * as `scanDomainFiles` reads it — v5 and v4, with their stubs and the
   * entries that could not be read — files named project-relative, and the
   * mode the project is in. The same reader Repair Relationships… and the CLI
   * use, so the notification, the banner and the command never disagree (D11).
   * `extraDomain` adds a domain file the scan does not list.
   */
  private relationshipFindings(
    extra?: { filePath: string; domain: () => Omit<CheckDomain, 'mode'> & { v4: boolean } },
  ): { findings: RelationshipFinding[]; mode: RelationshipMode } {
    // Every payload asks; the files rarely change between two payloads. The
    // result is reused while every model and domain file is the one it was
    // read from (path, size, modification time — a stat, never a read) and
    // no edit of ours has happened since (`invalidateRelationshipFindings`).
    const signature = this.relationshipFilesSignature();
    const cacheable = signature !== null && (!extra || signature.domainFiles.has(extra.filePath));
    if (cacheable && this.relationshipFindingsCache?.key === signature.key) return this.relationshipFindingsCache.result;
    const result = this.computeRelationshipFindings(extra);
    if (cacheable) this.relationshipFindingsCache = { key: signature.key, result };
    return result;
  }

  /** Forget the cached project findings (after an edit of ours: never wait for a file's mtime to tick). */
  private invalidateRelationshipFindings(): void {
    this.relationshipFindingsCache = undefined;
  }

  /**
   * What the project findings are read from, as one string: every model file
   * and domain file the checks read, with its size and modification time,
   * plus the domain files' project-relative paths. Null when a file cannot be
   * looked at (then nothing is cached).
   */
  private relationshipFilesSignature(): { key: string; domainFiles: Set<string> } | null {
    try {
      const stamp = (filePath: string): string => {
        const st = fs.statSync(filePath);
        return `${filePath}\u0000${st.size}\u0000${st.mtimeMs}`;
      };
      const models = this.logicalModelService.listModelFiles().map((e) => `${stamp(e.filePath)}\u0000${e.shadowedBy ?? ''}`);
      const domains = this.domainService.listDomains(this.workspaceRoot, this.semanticDirName()).map((d) => d.filePath);
      return {
        key: [this.semanticDirName(), ...models, '\u0001', ...domains.map(stamp)].join('\u0002'),
        domainFiles: new Set(domains.map((d) => projectRelative(this.workspaceRoot, d))),
      };
    } catch {
      return null;
    }
  }

  private computeRelationshipFindings(
    extra?: { filePath: string; domain: () => Omit<CheckDomain, 'mode'> & { v4: boolean } },
  ): { findings: RelationshipFinding[]; mode: RelationshipMode } {
    const rel = (filePath: string): string => projectRelative(this.workspaceRoot, filePath);
    const { libraryModels, unreadableModels } = this.logicalModelService.relationshipCheckModels(rel);
    // One read of every domain file: the checks' domains and the mode both come from it.
    const scan = scanDomainFiles(this.domainService, this.workspaceRoot, this.semanticDirName());
    const mode: RelationshipMode = usesLibraryRelationships(
      libraryModels.map((m) => m.model),
      scan.domainFileRelationshipCount,
      unreadableModels.filter((u) => u.holdsRelationships).length,
    ) ? 'library' : 'domain';
    const domains = toCheckDomains(scan, mode, rel);
    const scanned = [...scan.v5, ...scan.v4, ...scan.unchecked].some((d) => rel(d.filePath) === extra?.filePath);
    if (extra && !scanned) {
      const { v4, ...domain } = extra.domain();
      domains.push({ ...domain, mode: v4 ? 'domain' : mode, ...(v4 ? { olderFormat: true } : {}) });
    }
    return { findings: checkRelationships({ libraryModels, domains, unreadableModels }), mode };
  }

  /**
   * Relationship facts for the editable logical payload (issue #133): where a
   * new relationship is stored (`relationshipHome`), and the project findings
   * that concern this domain (`relationshipIssues`, for the banner and the
   * edge badges). Never fails a load: a check that throws only logs.
   */
  private relationshipPayload(
    domainFilePath: string,
    domain: import('../types/semantic').SemanticDomain,
    stubColumns?: string[],
  ): { relationshipHome?: RelationshipMode; relationshipIssues?: DisplayRelationshipIssue[] } {
    try {
      const v4 = domain.schemaVersion < 5;
      const rel = (filePath: string): string => projectRelative(this.workspaceRoot, filePath);
      const filePath = rel(domainFilePath);
      const modelNames = domain.models.map((m) => m.name);
      // The open domain as the checks see it, read the scan's way — read only
      // when the scan does not list this file (a layer folder it skips).
      const openDomain = (): Omit<CheckDomain, 'mode'> & { v4: boolean } => {
        const label = `${path.basename(path.dirname(domainFilePath))}/${path.basename(domainFilePath, '.json')}`;
        let entries = readDomainRelationshipEntries(undefined, label);
        try {
          const raw = JSON.parse(fs.readFileSync(domainFilePath, 'utf-8')) as { logical?: { relationships?: unknown } };
          entries = readDomainRelationshipEntries(raw.logical?.relationships, label);
        } catch {
          // Unreadable right now: the canvas loaded it a moment ago; skip its own records.
        }
        return {
          label,
          filePath,
          models: v4 ? domain.models : modelNames,
          relationships: entries.relationships,
          ...(stubColumns && stubColumns.length > 0 ? { stubColumns } : {}),
          ...(entries.issues.length > 0 ? { readIssues: entries.issues } : {}),
          v4,
        };
      };
      const { findings, mode } = this.relationshipFindings({ filePath, domain: openDomain });
      const modelFiles = v4 ? [] : modelNames
        .map((name) => this.logicalModelService.resolveModelPath(name))
        .filter((p): p is string => p !== null && fs.existsSync(p))
        .map(rel);
      const issues = toDisplayRelationshipIssues(findingsForDomain(findings, { filePath, models: modelNames, modelFiles, olderFormat: v4 }));
      return {
        relationshipHome: v4 ? 'domain' : mode,
        ...(issues.length > 0 ? { relationshipIssues: issues } : {}),
      };
    } catch (err) {
      console.warn('[SemanticEditorProvider] Relationship checks skipped:', err);
      return {};
    }
  }

  /**
   * Why a column rename / column removal / model rename of `modelName` must
   * not go ahead, or null. The cascade rewrites the relationships other model
   * files hold to it (`otherLibraryModels`), but a model file that cannot be
   * read is not among them: it would keep pointing at the old name, to be
   * found dangling (REL003 / REL004) only once someone fixes it. So an
   * unreadable file is refused, by name, whenever its text names `modelName`
   * (a relationship to it must) — or cannot be read at all, so nobody knows.
   */
  private unreadableReferrerRefusal(modelName: string, what: string): string | null {
    const { unreadableModels } = this.logicalModelService.relationshipCheckModels();
    for (const unreadable of unreadableModels) {
      if (sameName(unreadable.name, modelName)) continue;
      let text: string | null = null;
      try {
        text = fs.readFileSync(unreadable.file, 'utf-8');
      } catch {
        text = null;
      }
      if (text !== null && !mentionsName(text, modelName)) continue;
      const file = this.libraryRelativePath(unreadable.name);
      return `${file} could not be read, so a relationship it holds to ${modelName} would keep pointing at the old name after this ${what}. ` +
        'Fix that file first, then try again.';
    }
    return null;
  }

  /**
   * The library relationships other model files keep to `names`, taken out
   * of fresh copies of those models. A name another file still defines (a
   * duplicate in another folder) keeps its relationships: they still resolve.
   */
  private relationshipsToDeletedModels(names: readonly string[]): { changed: SemanticModel[]; removed: string[] } {
    const files = names.map((name) => this.logicalModelService.findModelFile(name));
    const gone = names.filter((name, i) => !this.logicalModelService.listModelFiles()
      .some((e) => sameName(e.name, name) && !samePath(e.filePath, files[i] ?? '')));
    if (gone.length === 0) return { changed: [], removed: [] };
    return removeRelationshipsToModels(this.logicalModelService.listModels(), gone);
  }

  /**
   * Delete model files the user chose to delete after removing them from a
   * diagram — and, in the same WorkspaceEdit (one undo step), the
   * relationships other model files keep to them. A file it would rewrite
   * that is open with unsaved edits stops it, by name, before anything is
   * changed.
   */
  private async deleteModelFiles(document: vscode.TextDocument, names: readonly string[]): Promise<void> {
    const single = names.length === 1;
    // Captured before the delete: afterwards the folder is unknowable.
    const singlePath = single ? this.libraryRelativePath(names[0]) : '';
    const { changed, removed } = this.relationshipsToDeletedModels(names);
    // Delete through a WorkspaceEdit so VS Code snapshots the files and the
    // deletion is undoable, rather than a bare unlink.
    const edit = new vscode.WorkspaceEdit();
    let docs: vscode.TextDocument[];
    let deletedPaths: string[];
    try {
      ({ docs, deleted: deletedPaths } = await this.addModelFileEdits(edit, {
        save: changed.map((model) => ({ model })),
        delete: [...names],
      }));
    } catch (err) {
      void vscode.window.showErrorMessage(`Model file not deleted: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage('Failed to delete model file(s).');
      return;
    }
    const unsaved: string[] = [];
    for (const doc of docs) {
      if (await saveDocumentByUri(doc.uri)) {
        this.ownWriteTracker.recordWrite(doc.uri.fsPath);
      } else {
        unsaved.push(doc.uri.fsPath);
      }
    }
    for (const filePath of deletedPaths) this.ownWriteTracker.recordDelete(filePath);
    if (unsaved.length > 0) {
      telemetry.error('saveFailed');
      void vscode.window.showErrorMessage(this.describeUnsaved(unsaved));
    }
    // Recorded as our own writes, so the watchers stay quiet: refresh here.
    this.logicalModelService.invalidateCache();
    await this.refreshDomainsReferencingModels([...names, ...changed.map((m) => m.name)]);
    this._onDidWriteDomain.fire({ uri: document.uri, modelLibraryChanged: true });
    const summary = single ? `Deleted ${singlePath}` : `Deleted ${names.length} model files`;
    void vscode.window.showInformationMessage(
      removed.length === 0 ? summary : `${summary} and ${removed.length === 1 ? 'the relationship' : `${removed.length} relationships`} other model files kept to ${single ? 'it' : 'them'}.`,
    );
  }

  /** Every library model except `exclude`, fresh copies an edit may change. */
  private otherLibraryModels(exclude: string): SemanticModel[] {
    return this.logicalModelService.listModels().filter((m) => !sameName(m.name, exclude));
  }

  private async applyModelEdit(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelName: string,
    modelMutator: (model: import('../types/semantic').SemanticModel) => void,
    domainMutator?: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    /** Other library models changed alongside (relationships pointing at this one). */
    alsoSave: readonly SemanticModel[] = [],
  ): Promise<boolean> {
    const model = this.logicalModelService.getModel(modelName);
    if (!model) {
      throw new Error(this.modelUnavailableMessage(modelName));
    }

    modelMutator(model);

    // Even when there is no domain-level change, the domain document is still
    // re-written (with identical content) so its undo stack gains an element
    // grouped with the yml edit — the custom editor's undo/redo operate on the
    // domain resource, and the group pulls the yml change along with it.
    return this.applyDomainEdit(
      document,
      domainMutator ?? (() => { /* no domain change */ }),
      {
        refreshWebview: true,
        webview,
        stage: 'logical',
        modelFiles: { save: [{ model }, ...alsoSave.map((other) => ({ model: other }))] },
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
  private async addModelFileEdits(
    edit: vscode.WorkspaceEdit,
    ops: ModelFileOps | undefined,
    layerFolder?: string,
  ): Promise<{ docs: vscode.TextDocument[]; created: string[]; deleted: string[] }> {
    const docs: vscode.TextDocument[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    if (!ops) return { docs, created, deleted };

    // Every writer of a model file comes through here — a canvas edit of the
    // model itself, a rename or column cascade into the models that point at
    // it, Add Existing Model / Add models from dbt routing a relationship into
    // the library — so the one check that a file the edit would replace, carry
    // across or delete holds no unsaved hand edits lives here too. Replacing
    // the buffer with text rendered from the disk bytes would lose them
    // without a word.
    const touched = [
      ...(ops.delete ?? []).filter((name) => this.logicalModelService.modelExists(name)),
      ...(ops.save ?? []).flatMap(({ model, fromName }) => [
        ...(this.logicalModelService.modelExists(model.name) ? [model.name] : []),
        ...(fromName !== undefined && fromName !== model.name && this.logicalModelService.modelExists(fromName) ? [fromName] : []),
      ]),
    ];
    for (const name of touched) {
      const filePath = this.logicalModelService.findModelFile(name) ?? this.logicalModelService.modelPath(name);
      if (this.isDirtyOnScreen(filePath)) throw new Error(this.unsavedModelRefusal(filePath));
    }

    for (const name of ops.delete ?? []) {
      if (!this.logicalModelService.modelExists(name)) continue;
      const deletePath = this.logicalModelService.modelPath(name);
      edit.deleteFile(vscode.Uri.file(deletePath), { ignoreIfNotExists: true });
      deleted.push(deletePath);
    }

    for (const { model, fromName, relationshipTargets } of ops.save ?? []) {
      const renamedFrom = fromName !== undefined && fromName !== model.name
        ? this.logicalModelService.modelFolder(fromName)
        : null;
      const modelPath = this.logicalModelService.modelPath(model.name, renamedFrom ?? layerFolder);
      const uri = vscode.Uri.file(modelPath);
      const yamlText = this.logicalModelService.serializeModel(model, fromName, { relationshipTargets });
      if (this.logicalModelService.modelExists(model.name)) {
        const modelDoc = await vscode.workspace.openTextDocument(uri);
        const range = new vscode.Range(
          modelDoc.positionAt(0),
          modelDoc.positionAt(modelDoc.getText().length),
        );
        edit.replace(uri, range, yamlText);
        docs.push(modelDoc);
      } else {
        this.logicalModelService.ensureDir(modelPath);
        edit.createFile(uri, { overwrite: false, contents: Buffer.from(yamlText, 'utf-8') });
        created.push(modelPath);
      }
    }

    return { docs, created, deleted };
  }

  /**
   * After an undo/redo the in-memory yml documents we edited via WorkspaceEdit
   * are reverted but dirty; DomainService reads the library from disk, so
   * flush them before re-rendering.
   *
   * ONLY documents this provider itself wrote through a WorkspaceEdit for this
   * domain are saved (`editedModelPaths`). A logical-models/*.yml the user has
   * open in another tab with unsaved hand edits is never force-saved — those
   * bytes are theirs to keep or discard.
   */
  private async saveDirtyModelDocuments(panelKey: string): Promise<string[]> {
    const saved: string[] = [];
    const ourPaths = this.editedModelPaths.get(panelKey);
    if (!ourPaths || ourPaths.size === 0) return saved;
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty) continue;
      if (!ourPaths.has(doc.uri.fsPath)) continue;
      try {
        await doc.save();
        this.ownWriteTracker.recordWrite(doc.uri.fsPath);
        saved.push(doc.uri.fsPath);
      } catch (err) {
        console.error(`[SemanticEditorProvider] Failed to save ${doc.uri.fsPath} after undo/redo:`, err);
      }
    }
    return saved;
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
    const verdict = this.passUndoBarrier(panelKey, command);
    if (verdict === 'blocked') {
      this.post(webview, { type: 'error', payload: { message: UNDO_BARRIER_MESSAGE } });
      return;
    }
    if (verdict === 'nothing') return;
    this.pendingUpdates.set(panelKey, true);
    try {
      const libraryBefore = this.projectKeepsRelationshipsInLibrary();
      await vscode.commands.executeCommand(command);
      await document.save();
      this.ownWriteTracker.recordWrite(document.uri.fsPath);
      const reverted = await this.saveDirtyModelDocuments(panelKey);
      this.logicalModelService.invalidateCache();
      await this.sendDomainData(document, webview, panelKey);
      // The yml saves above are our own writes, which the watcher skips: any
      // OTHER open diagram showing those models (a library relationship is
      // drawn by every diagram holding both ends) is refreshed from here, as
      // applyDomainEdit does after the edit being undone.
      const names = new Set(reverted.map((filePath) => path.basename(filePath).replace(/\.ya?ml$/i, '')));
      this.invalidateRelationshipFindings();
      // Undoing the removal of the model library's last relationship (or
      // redoing it) changes where every diagram's relationships come from:
      // every open diagram is re-sent, as the edit itself did.
      if (libraryBefore !== undefined && libraryBefore !== this.projectKeepsRelationshipsInLibrary()) {
        await this.refreshAllOpenDomains(panelKey);
      } else {
        await this.refreshDomainsReferencingModels(names, panelKey);
      }
      this._onDidWriteDomain.fire({ uri: document.uri, modelLibraryChanged: true });
    } finally {
      this.pendingUpdates.delete(panelKey);
    }
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
   */
  private async applyDomainEdit(
    document: vscode.TextDocument,
    mutator: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    options: {
      refreshWebview?: boolean;
      webview?: vscode.Webview;
      stage: 'logical';
      modelFiles?: ModelFileOps;
      errorLabel?: string;
      onSuccess?: () => void;
    },
  ): Promise<boolean> {
    const { refreshWebview = true, webview, stage, modelFiles, errorLabel, onSuccess } = options;
    const panelKey = document.uri.toString();

    const text = document.getText();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const section = this.getStageSection(parsed, stage);

    try {
      mutator(section, parsed);
    } catch (err) {
      if (err instanceof EditAborted) return false;
      throw err;
    }

    const updatedText = JSON.stringify(parsed, null, 2) + '\n';
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    edit.replace(document.uri, fullRange, updatedText);
    const { docs: modelDocs, created, deleted } = await this.addModelFileEdits(
      edit,
      modelFiles,
      // Layer folders are opt-in: a flat library stays flat (see groupsByFolder).
      modelFiles?.save?.length ? this.newModelFolder(document.uri.fsPath) : undefined,
    );

    this.pendingUpdates.set(panelKey, true);
    try {
      const success = await vscode.workspace.applyEdit(edit);
      if (success) {
        // One more step an undo may rewind before it reaches a repair's.
        const barrier = this.undoBarriers.get(panelKey);
        if (barrier) {
          barrier.edits += 1;
          barrier.redoable = 0;
        }
      }
      if (!success) {
        telemetry.error('editRejected');
        if (errorLabel && webview) {
          webview.postMessage({ type: 'error', payload: { message: errorLabel } });
        }
        return false;
      }
      // A save that fails is reported, never ignored: the edit is applied in
      // memory, so without a word the file would sit open and unsaved (#126).
      const unsaved: string[] = [];
      if (await saveDocument(document)) {
        // Own writes are recorded only once the bytes are on disk — the tracker
        // stats the file — so the logical-model / semantic watchers can tell
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
      const ourPaths = this.editedModelPaths.get(panelKey) ?? new Set<string>();
      for (const modelDoc of modelDocs) {
        // Remember which yml documents WE edited for this domain, so an
        // undo/redo only ever flushes those (never a buffer the user is
        // hand-editing in another tab).
        ourPaths.add(modelDoc.uri.fsPath);
        // Re-fetched by URI: VS Code may have disposed the handle opened
        // before the edit, and the edit then landed in a fresh copy (#126).
        if (await saveDocumentByUri(modelDoc.uri)) {
          this.ownWriteTracker.recordWrite(modelDoc.uri.fsPath);
        } else {
          unsaved.push(modelDoc.uri.fsPath);
        }
      }
      if (unsaved.length > 0) {
        telemetry.error('saveFailed');
        webview?.postMessage({ type: 'error', payload: { message: this.describeUnsaved(unsaved) } });
      }
      for (const filePath of created) {
        ourPaths.add(filePath);
      }
      if (ourPaths.size > 0) {
        this.editedModelPaths.set(panelKey, ourPaths);
      }
      // The project findings are read again for the payloads below.
      this.invalidateRelationshipFindings();
      // Our own writes are suppressed at the watcher, so the refreshes it
      // used to drive are issued here instead: this panel via sendDomainData,
      // the sidebar/model library via onDidWriteDomain, and any OTHER open
      // panel that shows a model we just wrote.
      if (refreshWebview && webview) {
        await this.sendDomainData(document, webview);
      }
    } finally {
      this.pendingUpdates.delete(panelKey);
    }

    const touchedModels = [
      ...(modelFiles?.save ?? []).map((entry) => entry.model.name),
      ...(modelFiles?.delete ?? []),
    ];
    for (const name of new Set(touchedModels)) this.logicalModelService.invalidateCache(name);
    // Each other open diagram holding any of them is re-sent once, not once
    // per touched model (a box-select delete touches many).
    await this.refreshDomainsReferencingModels(touchedModels, panelKey);
    this._onDidWriteDomain.fire({
      uri: document.uri,
      modelLibraryChanged: created.length > 0 || deleted.length > 0,
    });

    onSuccess?.();
    return true;
  }

  /** The error shown when files an edit changed could not be saved. */
  private describeUnsaved(filePaths: string[]): string {
    const names = filePaths.map((p) => path.relative(this.workspaceRoot, p).split(path.sep).join('/'));
    return `Could not save ${names.join(', ')} — the change is open in the editor but not on disk. ` +
      'Save the file from its tab (or revert it), then try again.';
  }

  /**
   * Say so — once per session per file — when this domain uses a name that
   * two files in the library define. Only one of them can be used (names are
   * identities), so without this a gold canvas would quietly show the silver
   * `date` table's columns. The warning names both files and offers the fix.
   */
  private warnAboutDuplicateModels(domain: UnifiedDomain): void {
    const used = new Set(domain.logical.models.map((m) => m.name));
    const modelsDir = this.logicalModelService.getModelsDir();
    const rel = (p: string): string => `logical-models/${path.relative(modelsDir, p).split(path.sep).join('/')}`;
    for (const entry of this.logicalModelService.listModelFiles()) {
      if (!entry.shadowedBy || !used.has(entry.name)) continue;
      const key = `${domain.layer}/${domain.domain}\0${entry.filePath}`;
      if (this.duplicateWarningsShown.has(key)) continue;
      this.duplicateWarningsShown.add(key);
      const meantThisCopy = entry.folder === domain.layer;
      const message = `"${entry.name}" is defined twice. ${domain.layer}/${domain.domain} uses ${rel(entry.shadowedBy)}` +
        (meantThisCopy
          ? `, not the ${domain.layer} copy ${rel(entry.filePath)}, which is ignored.`
          : `; ${rel(entry.filePath)} is ignored.`);
      void vscode.window.showWarningMessage(message, 'Fix…').then((choice) => {
        if (choice === 'Fix…') {
          void vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', entry.filePath);
        }
      });
    }
  }

  /**
   * Convert a SemanticDomain to a DisplayDomain for the webview.
   * viewConfig is passed separately since it lives at the unified domain root level.
   */
  private buildDisplayDomain(
    domain: import('../types/semantic').SemanticDomain,
    manifest: ManifestData,
    ymlData: YmlData,
    viewConfig: import('../types/semantic').ViewConfig,
    stubColumns: string[] | undefined,
    domainFilePath: string,
  ): DisplayDomain {
    const editorPayload = this.buildWebviewPayload(domain, manifest, ymlData, domain.modelFolder);
    const readOnly = domain.stage === 'physical';

    const display = toDisplayDomain(domain, {
      viewConfig,
      stubColumns,
      layerConfig: this.layerService.getLayer(domain.layer),
      readOnly,
      editorPayload,
      // Editable logical payload only (#133): where relationships are stored,
      // and what needs attention.
      ...(readOnly ? {} : this.relationshipPayload(domainFilePath, domain, stubColumns)),
    });
    // What dbt's tests say about each column, for the New Relationship
    // dialog's direction (#133, R7). Editor-only, never on the CLI's diff.
    return readOnly ? display : withDbtEvidence(display, buildDbtEvidenceIndex([ymlData, manifest]));
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
  private async sendDomainData(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey?: string,
    options: { persistPositions?: boolean } = {},
  ): Promise<void> {
    const errorKey = panelKey ?? document.uri.toString();

    // A JSON file under the semantic dir is not automatically a domain. The
    // custom editor's `**/.erd-studio/*/*.json` selector also matches
    // `templates/*.json` and the other reserved directories, and a glob cannot
    // express the exclusion, so the refusal lives here. Rendering a canvas for
    // one of those can only ever end in a parse error the user cannot act on.
    if (!isDomainFilePath(document.uri.fsPath)) {
      this.postLoadError(webview, errorKey, {
        message:
          `${path.basename(document.uri.fsPath)} is not an ERD domain file — ` +
          `domains live in ${path.basename(path.dirname(path.dirname(document.uri.fsPath)))}/{layer}/{domain}.json. ` +
          `Open it as text to edit it.`,
        kind: 'not-a-domain',
      }, undefined, 'notDomain');
      return;
    }

    try {
      const key = panelKey ?? document.uri.toString();
      const panel = this.openPanels.get(key);
      const activeStage = panel?.activeStage ?? 'logical';

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();
      const welcomeDismissed = !!this.context.globalState.get('welcomeDismissed');

      let unifiedDomain = await this.readDomainTolerantly(document.uri.fsPath);
      this.warnAboutDuplicateModels(unifiedDomain);

      // A fresh domain — models but not one stored position, typically written
      // by an AI assistant with `viewConfig: {}` — is laid out by the webview's
      // ELK auto layout instead, which persists through `updatePositions` (one
      // edit, one undo step). The simple placement below still goes out in the
      // payload so the first paint is never at (0,0), but it is not written:
      // should the ELK run fail, the next open simply asks again.
      const autoLayout = activeStage === 'logical' && isFreshLayout(unifiedDomain);

      // Auto-assign positions for models that lack them (e.g. added by AI agents)
      const computed = this.computeMissingPositions(unifiedDomain);
      if (computed) {
        if (options.persistPositions && !autoLayout) {
          const positionsWritten = await this.autoPositionNewModels(document, computed);
          if (positionsWritten) {
            // Re-read since we wrote new positions to the file
            unifiedDomain = this.domainService.getDomain(document.uri.fsPath);
          }
        }
        // Whether or not they were persisted, the payload carries the positions
        // so the canvas never renders a model at (0,0).
        unifiedDomain.viewConfig.positions = { ...(unifiedDomain.viewConfig.positions ?? {}), ...computed };
      }

      if (activeStage === 'physical') {
        const physicalDomain = this.domainService.buildPhysicalDomain(unifiedDomain, ymlData, manifest, catalog);
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) { physicalDomain.layerConfig = layerConfig; }
        this.post(webview, { type: 'domainLoaded', payload: physicalDomain, welcomeDismissed });
        if (options.persistPositions) this.recordCanvasOpen(document, 'physical', physicalDomain.models.length, catalog !== undefined);
      } else {
        const domain = DomainService.toLogicalStage(unifiedDomain);
        const displayDomain = this.buildDisplayDomain(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns, document.uri.fsPath);
        this.post(webview, {
          type: 'domainLoaded',
          payload: displayDomain,
          welcomeDismissed,
          ...(autoLayout ? { autoLayout: true } : {}),
          ...this.manifestHintFlag(),
        });
        if (options.persistPositions) {
          this.recordCanvasOpen(document, 'logical', displayDomain.models.length, catalog !== undefined);
          if (displayDomain.models.length === 0) telemetry.feature('emptyCanvas');
        }
        if (autoLayout) telemetry.feature('autoLayout');
      }
      // A payload went out, so the next failure is news again.
      this.lastLoadError.delete(errorKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postLoadError(webview, errorKey, {
        message,
        ...(err instanceof DomainFileError ? { kind: 'domain-file' as const } : {}),
      }, err, classifyDomainLoadFailure(err));
    }
  }

  /**
   * `{ manifestMissing: true }` for a logical payload when dbt has not written
   * a manifest yet and this workspace has not dismissed the hint (#113), else
   * nothing. Call only after `loadManifest`, which is what sets `isMissing`,
   * and only for logical payloads.
   */
  private manifestHintFlag(): { manifestMissing?: true } {
    if (!this.manifestService.isMissing) return {};
    // A folder that is not a dbt project (#111) will never have a manifest.
    if (!hasDbtProjectFile(this.workspaceRoot)) return {};
    if (this.context.workspaceState?.get<boolean>(MANIFEST_HINT_DISMISSED_KEY)) return {};
    return { manifestMissing: true };
  }

  /** Usage telemetry for a canvas's first load: only the stage, format and counts. */
  private recordCanvasOpen(document: vscode.TextDocument, stage: Stage, modelCount: number, hasCatalog: boolean): void {
    let format: 'v4' | 'v5' = 'v5';
    try {
      if (detectDomainFormat(JSON.parse(document.getText()) as Record<string, unknown>) === 'v4') format = 'v4';
    } catch {
      // Loaded a moment ago, so this cannot really fail; v5 is the only other loadable format.
    }
    telemetry.canvasOpened(stage, format, modelCount);
    telemetry.manifest(this.manifestService.isMissing ? 'missing' : this.manifestService.isStale ? 'stale' : 'ok');
    // #113: where a missing manifest is met (once per day).
    if (this.manifestService.isMissing) {
      telemetry.featureOnce(stage === 'logical' ? 'manifestMissingCanvas' : 'manifestMissingPhysical');
    }
    telemetry.catalog(hasCatalog);
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
  private async readDomainTolerantly(filePath: string): Promise<UnifiedDomain> {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.domainService.getDomain(filePath);
      } catch (err) {
        const last = attempt >= DOMAIN_READ_RETRY_DELAYS_MS.length;
        if (last || !isRetryableDomainRead(err)) {
          throw err;
        }
        console.warn(
          `[SemanticEditorProvider] ${filePath} is ${err.reason} — ` +
          `re-reading in ${DOMAIN_READ_RETRY_DELAYS_MS[attempt]}ms (likely mid-write)`,
        );
        await delay(DOMAIN_READ_RETRY_DELAYS_MS[attempt]);
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
    failure: DomainLoadFailure,
  ): void {
    if (this.lastLoadError.get(errorKey) === payload.message) {
      return;
    }
    this.lastLoadError.set(errorKey, payload.message);
    telemetry.error('domainLoad');
    telemetry.error(domainLoadErrorCode(failure));
    hostErrorLog.record('sendDomainData', err ?? payload.message);
    console.error(`[SemanticEditorProvider] Failed to load domain: ${payload.message}`);
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
   * survive reloads. Only called from the `ready` path — see sendDomainData.
   * Returns true if positions were written.
   */
  private async autoPositionNewModels(
    document: vscode.TextDocument,
    computed: Record<string, NodePosition>,
  ): Promise<boolean> {
    // Merge computed positions into the document. No webview refresh — the
    // caller (sendDomainData) is about to send the payload itself.
    return this.applyDomainEdit(
      document,
      (_section, parsed) => {
        const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
        const existingPos = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
        viewConfig.positions = { ...existingPos, ...computed };
        parsed.viewConfig = viewConfig;
      },
      { refreshWebview: false, stage: 'logical' },
    );
  }

  /**
   * Repair Relationships… / Move Relationships to Model Library just wrote
   * files to disk behind VS Code's undo history: from here on, an undo on any
   * open diagram stops before it would rewind that change (the model files the
   * run rewrote cannot be rewound with it).
   */
  markFilesRewrittenOnDisk(): void {
    for (const panelKey of this.openPanels.keys()) {
      this.undoBarriers.set(panelKey, { edits: 0, redoable: 0 });
    }
  }

  /**
   * Whether an undo / redo on this panel may go ahead, counting it: `blocked`
   * when an undo would rewind a repair's disk write, `nothing` for a redo with
   * nothing undone since one (VS Code would have nothing to redo), else `ok`.
   */
  private passUndoBarrier(panelKey: string, command: 'undo' | 'redo'): 'ok' | 'blocked' | 'nothing' {
    const barrier = this.undoBarriers.get(panelKey);
    if (!barrier) return 'ok';
    if (command === 'undo') {
      if (barrier.edits === 0) return 'blocked';
      barrier.edits -= 1;
      barrier.redoable += 1;
      return 'ok';
    }
    if (barrier.redoable === 0) return 'nothing';
    barrier.redoable -= 1;
    barrier.edits += 1;
    return 'ok';
  }

  /**
   * The editor's own Undo rewound a diagram past a repair's disk write: put
   * the file's text on disk (the repaired one — nothing was saved since) back
   * into the document, and say why.
   */
  private async restoreAfterBlockedUndo(document: vscode.TextDocument, webview: vscode.Webview, panelKey: string): Promise<void> {
    this.post(webview, { type: 'error', payload: { message: UNDO_BARRIER_MESSAGE } });
    let onDisk: string;
    try {
      onDisk = fs.readFileSync(document.uri.fsPath, 'utf-8');
    } catch {
      return;
    }
    if (document.getText() === onDisk) return;
    this.pendingUpdates.set(panelKey, true);
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), onDisk);
      if (await vscode.workspace.applyEdit(edit) && await saveDocument(document)) {
        this.ownWriteTracker.recordWrite(document.uri.fsPath);
      }
      await this.sendDomainData(document, webview, panelKey);
    } finally {
      this.pendingUpdates.delete(panelKey);
    }
  }

  /**
   * Refresh all open domain editors with fresh manifest data.
   * Called by extension.ts when manifest changes.
   * Stage-aware: panels viewing physical stage get physical data.
   */
  async refreshAllOpenDomains(exceptPanelKey?: string): Promise<void> {
    // Called after writes made behind the editor (Repair Relationships…, the
    // move, a reorganised library): the project findings are read again, never
    // reused because two writes landed within one file-time tick.
    this.invalidateRelationshipFindings();
    for (const [panelKey, { document, webview, activeStage }] of Array.from(this.openPanels.entries())) {
      // The snapshot may include a panel that was disposed while an earlier
      // iteration awaited — skip it rather than refreshing a dead webview.
      if (this.disposedWebviews.has(webview) || !this.openPanels.has(panelKey)) {
        continue;
      }
      // The panel that made an edit has already been refreshed by it.
      if (exceptPanelKey !== undefined && panelKey === exceptPanelKey) continue;
      try {
        if (activeStage === 'physical') {
          await this.handleSwitchStage(panelKey, document, webview, 'physical');
        } else {
          await this.sendDomainData(document, webview, panelKey);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
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
   * `applyDomainEdit` for the OTHER open panels after this provider wrote a
   * model file itself (its own write is suppressed at the watcher, so the
   * cross-panel refresh has to be driven from here).
   */
  async refreshDomainsReferencingModel(modelName: string, exceptPanelKey?: string): Promise<void> {
    await this.refreshDomainsReferencingModels([modelName], exceptPanelKey);
  }

  /**
   * {@link refreshDomainsReferencingModel} for several models at once: every
   * open domain editor that references any of them is re-sent exactly once.
   */
  async refreshDomainsReferencingModels(modelNames: Iterable<string>, exceptPanelKey?: string): Promise<void> {
    // Without case: on a case-insensitive file system a domain may list a
    // model in another case than its file name and still draw its links — a
    // panel refreshed once too often costs nothing, one left stale misleads.
    const names = new Set([...modelNames].map((n) => n.toLowerCase()));
    if (names.size === 0) return;
    // A model file changed (on disk, by us or by someone else): the findings
    // are read again once, then shared by every panel re-sent below.
    this.invalidateRelationshipFindings();
    const modelName = [...names].join(', ');
    for (const [panelKey, { document, webview }] of Array.from(this.openPanels.entries())) {
      if (this.disposedWebviews.has(webview) || !this.openPanels.has(panelKey)) {
        continue;
      }
      // The panel that made the edit has already been refreshed by
      // applyDomainEdit — re-sending would clear the user's selection.
      if (exceptPanelKey !== undefined && panelKey === exceptPanelKey) {
        continue;
      }
      try {
        const text = document.getText();
        const parsed = JSON.parse(text) as unknown;

        // Check if this domain references the changed model. The shared
        // format-agnostic extractor handles v5 name strings, v4/hybrid inline
        // objects and legacy top-level `models` — and tolerates junk entries.
        const referencesModel = getRawDomainModelNames(parsed).some((name) => names.has(name.toLowerCase()));

        if (referencesModel) {
          await this.sendDomainData(document, webview, panelKey);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[SemanticEditorProvider] Refresh for model "${modelName}" failed: ${message}`);
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
        console.error(`[SemanticEditorProvider] switchStageForUri: panel not found for ${panelKey} after ${attempts} attempts`);
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
    model: DesignModel,
    stage: 'logical',
  ): Promise<void> {
    try {
      // Validate the payload before anything touches disk: the model name
      // becomes a file name under logical-models/, and column names are used
      // as keys by every later edit/remove path.
      const nameError = validateModelName(model.name);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add model: ${nameError}` } });
        return;
      }
      const columnsError = validateColumnDefs(model.columns ?? []);
      if (columnsError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add model: ${columnsError}` } });
        return;
      }
      if (model.modelRole != null && !isValidModelRole(model.modelRole)) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add model: unknown role "${String(model.modelRole)}".` } });
        return;
      }
      model = { ...model, name: model.name.trim() };

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const section = this.getStageSection(parsed, stage);

      // V5: create central model file + add name reference to domain
      if (this.isDomainV5(parsed)) {
        const modelNames = (section.models ?? []) as string[];
        const inDomain = modelNames.find((n) => sameName(n, model.name));
        if (inDomain !== undefined) {
          webview.postMessage({ type: 'error', payload: { message: `Model "${inDomain}" already exists in this domain.` } });
          return;
        }
        // The model library is shared across domains — never overwrite a
        // logical-models/{name}.yml that another domain may depend on. Case is
        // ignored: `DimDate` next to `dimdate.yml` is one file on macOS/Windows.
        const inLibrary = this.logicalModelService.findModelNameIgnoringCase(model.name);
        if (inLibrary !== null) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Model "${inLibrary}" already exists in the model library (${this.libraryRelativePath(inLibrary)}). ` +
                'Use "Add Existing Model" to reference it in this domain, or, for a separate table also called ' +
                `${model.name}, name the model ${sameTableName(model.name, document.uri.fsPath)} and set its Table name to ${model.name}.`,
            },
          });
          return;
        }

        // Central model file — written via the same WorkspaceEdit as the domain
        // change so creating the model is a single, atomic, undoable step.
        const semanticModel: import('../types/semantic').SemanticModel = {
          name: model.name,
          schema: model.schema,
          description: model.description,
          columns: model.columns,
          ...(model.modelRole ? { modelRole: model.modelRole } : {}),
        };

        // Add name reference + position to domain file
        const success = await this.applyDomainEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            names.push(model.name);
            sec.models = names;

            const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
            const positions = (vc.positions ?? {}) as Record<string, NodePosition>;
            const relationships = (sec.relationships ?? []) as Relationship[];
            const computed = computeNewModelPositions({
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
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add model to domain.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applyDomainEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;

          if (models.some((m) => typeof m.name === 'string' && sameName(m.name, model.name))) {
            webview.postMessage({
              type: 'error',
              payload: { message: `Model "${model.name}" already exists in this domain.` },
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
          const computed = computeNewModelPositions({
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
          errorLabel: 'Failed to add model to domain.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add model: ${message}` },
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
      await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
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
      console.error(`[SemanticEditorProvider] Add column failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // V5: write column update to central model file, cascade rename to domain
      if (this.isDomainV5(parsed)) {
        const columnRenamed = payload.oldColumnName !== payload.column.name;
        if (columnRenamed) {
          const refusal = this.unreadableReferrerRefusal(payload.modelName, 'column rename');
          if (refusal) {
            webview.postMessage({ type: 'error', payload: { message: `Failed to update column: ${refusal}` } });
            return;
          }
        }
        const domainMutator = columnRenamed ? (section: Record<string, unknown>) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          for (const rel of relationships) {
            if (relEndIs(rel, 'from', payload.modelName, payload.oldColumnName)) {
              rel.fromColumn = payload.column.name;
            }
            if (relEndIs(rel, 'to', payload.modelName, payload.oldColumnName)) {
              rel.toColumn = payload.column.name;
            }
          }
        } : undefined;

        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
            // The canvas sends its FK *badge*, which every relationship drawn
            // from the column also switches on. Writing that back would turn a
            // drawn relationship into the declared flag direction checks trust
            // (#133 D2). The flag is changed by `toggleColumnKey` only.
            ...(existing.isForeignKey ? { isForeignKey: true } : {}),
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
            this.otherLibraryModels(payload.modelName), payload.modelName, payload.oldColumnName, payload.column.name)
          : []);
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update column.' } });
        } else if (columnRenamed) {
          this.reportOtherDiagramReferences(document, payload.modelName, payload.oldColumnName, 'rename');
        }
        return;
      }

      // V4: legacy inline path
      await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
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
          // The FK badge the canvas sends is not the declared flag (see the v5
          // path above): only `toggleColumnKey` changes it.
          const newFK = existingFK;
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

          // Cascade column rename into relationships
          if (payload.oldColumnName !== payload.column.name) {
            const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
            for (const rel of relationships) {
              if (relEndIs(rel, 'from', payload.modelName, payload.oldColumnName)) {
                rel.fromColumn = payload.column.name;
              }
              if (relEndIs(rel, 'to', payload.modelName, payload.oldColumnName)) {
                rel.toColumn = payload.column.name;
              }
            }
          }
        },
        { webview, stage, errorLabel: 'Failed to update column.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update column failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // V5: write to central model file, cascade orphaned relationships in the domain.
      // No-op silently if the column or model is already gone (e.g. spam-clicked delete).
      if (this.isDomainV5(parsed)) {
        const hasColumn = this.logicalModelService.getModel(payload.modelName)?.columns?.some((c) => c.name === payload.columnName) === true;
        const refusal = hasColumn ? this.unreadableReferrerRefusal(payload.modelName, 'column removal') : null;
        if (refusal) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to remove column: ${refusal}` } });
          return;
        }
        const ok = await this.applyModelEdit(
          document,
          webview,
          payload.modelName,
          (model) => {
            const columns = model.columns ?? [];
            const idx = columns.findIndex((c) => c.name === payload.columnName);
            if (idx === -1) return;
            columns.splice(idx, 1);
            removeColumnRelationships([model], payload.modelName, payload.columnName);
          },
          (sec) => {
            const rels = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = rels.filter(
              (rel) => !relationshipReferencesColumnAnyCase(rel, payload.modelName, payload.columnName),
            );
          },
          // Library relationships in other models that point at the removed column (#126).
          removeColumnRelationships(this.otherLibraryModels(payload.modelName), payload.modelName, payload.columnName),
        );
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to remove column.' } });
        } else if (hasColumn) {
          this.reportOtherDiagramReferences(document, payload.modelName, payload.columnName, 'removal');
        }
        return;
      }

      // V4: legacy inline path. Silent no-op if the model or column is already gone.
      await this.applyDomainEdit(
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

          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          section.relationships = relationships.filter(
            (rel) => !relationshipReferencesColumnAnyCase(rel, payload.modelName, payload.columnName),
          );
        },
        { webview, stage, errorLabel: 'Failed to remove column.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove column failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // V5: write to central model file
      if (this.isDomainV5(parsed)) {
        const fieldMap: Record<string, keyof ColumnDef> = { PK: 'isPrimaryKey', FK: 'isForeignKey', NK: 'isNaturalKey' };
        const fieldName = fieldMap[payload.keyType];
        if (!fieldName) throw new Error(`Unknown key type "${String(payload.keyType)}".`);
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
      await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
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
      console.error(`[SemanticEditorProvider] Toggle key failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          if (payload.orderedNames.length !== columns.length) {
            throw new Error(`Column count mismatch: expected ${columns.length}, got ${payload.orderedNames.length}.`);
          }
          const columnMap = new Map(columns.map((c) => [c.name, c]));
          model.columns = payload.orderedNames.map((name) => {
            const col = columnMap.get(name);
            if (!col) throw new Error(`Column "${name}" not found in model "${payload.modelName}".`);
            return col;
          });
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to reorder columns.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) {
            throw new Error(`Model "${payload.modelName}" not found.`);
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
              throw new Error(`Column "${name}" not found in model "${payload.modelName}".`);
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
      console.error(`[SemanticEditorProvider] Reorder columns failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to reorder columns: ${message}` } });
    }
  }

  private async handleAddRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      fromModel: string; fromColumn: string; toModel: string; toColumn: string;
      cardinality: Cardinality; role?: string; markKey?: RelationshipMarkKeyPayload;
    },
  ): Promise<void> {
    const { markKey, ...rel } = payload;
    await this.commitRelationship(document, webview, { kind: 'add', rel, ...(markKey ? { markKey } : {}) }, 'add', 'relationship');
  }

  /**
   * The one write path for a relationship edit from the canvas (issue #133,
   * R4): add, update (⇄ / context menu), edit (dialog) and remove all come
   * here. The project's mode is read BEFORE the edit (`usesLibraryRelationships`;
   * a v4 domain is always per-domain) and never changed by it.
   * `planRelationshipCommit` takes every copy of the link out of the endpoint
   * models' files and this domain file and writes one canonical record where
   * the mode says — the canonical from-model's file, or this domain file —
   * and the result goes out through `applyDomainEdit`'s single WorkspaceEdit
   * (one undo step, the domain file included even when only a yml changed).
   *
   * The library is listed once (to decide the mode — whether any model file
   * holds a relationship — and to find the endpoint models); only the (at
   * most four) endpoint models are planned against and may be written. A
   * model file the commit may write is refused, naming the file, when it is
   * open with unsaved changes (the edit would replace the buffer with a
   * rendering of the disk bytes) or cannot be read (a relationship stored in
   * it could not be found, and writing it would regenerate the file).
   */
  private async commitRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    op: RelationshipCommitOp,
    action: 'add' | 'update' | 'edit' | 'remove',
    label: 'relationship' | 'relationships',
  ): Promise<void> {
    const fail = (message: string): void => {
      webview.postMessage({ type: 'error', payload: { message: `Failed to ${action} ${label}: ${message}` } });
    };
    try {
      const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
      const v5 = this.isDomainV5(parsed);
      // The mode counts a model file with a YAML error that still has a
      // `relationships:` key as library evidence: a broken file must never
      // quietly send a new relationship into the diagram file (R3).
      const library = v5 ? this.logicalModelService.relationshipModeInputs() : { models: [], unreadableWithRelationships: 0 };
      const libraryModels = library.models;
      const mode: RelationshipMode = v5 && this.relationshipsInLibrary(libraryModels, library.unreadableWithRelationships) ? 'library' : 'domain';

      const ends: RelationshipEnds[] =
        op.kind === 'add' ? [op.rel]
          : op.kind === 'update' ? [op.stored]
            : op.kind === 'edit' ? [op.stored, op.next]
              : [...op.stored];
      // Distinct by exact spelling: two models whose names differ only in
      // case (`Dd`, `DD`, hand-made on a case-sensitive file system) are two
      // models, and folding them together would plan against the wrong one.
      const endpointNames = [...new Set(ends.flatMap((e) => [e.fromModel, e.toModel]))];
      const markKey = op.kind === 'add' || op.kind === 'edit' ? op.markKey : undefined;

      // v5: copies of the endpoint models, each name resolved as core's reader
      // resolves it — the exact name, else the alphabetically first case variant.
      const endpointModels: SemanticModel[] = v5 ? resolveEndpointModels(endpointNames, libraryModels) : [];
      if (v5) {
        const resolveLibrary = (name: string): SemanticModel | undefined => resolveEndpointModels([name], libraryModels)[0];
        const writable = mode === 'library' ? endpointNames : markKey ? [markKey.model] : [];
        const checked = new Set<string>();
        // Every model file the commit may write must read: one that does not
        // could hold a copy of the link the plan cannot see. Unsaved changes
        // matter only in a file the plan really writes (checked once it is
        // made, below): drawing a fact's line while its dimension's file is
        // open with an unsaved edit writes only the fact's file.
        for (const name of writable) {
          const realName = resolveLibrary(name)?.name ?? this.logicalModelService.findModelNameIgnoringCase(name);
          if (!realName || checked.has(realName)) continue;
          checked.add(realName);
          const refusal = this.logicalModelService.findModelFile(realName) ? this.unreadableModelRefusal(realName) : null;
          if (refusal) {
            fail(refusal);
            return;
          }
        }
      }

      // Every commit in library mode: a remove names diagrams still drawing
      // the link from their own copy, an add / update / edit those keeping a
      // copy the model library's now overrides (ignored there, REL009) — one
      // notice either way, never a write to another diagram's file.
      const otherDomains = mode === 'library'
        ? readDomainRelationships(this.domainService, this.workspaceRoot, this.semanticDirName())
          .filter((d) => !samePath(d.filePath, document.uri.fsPath))
          .map((d) => ({ label: `${d.label}.json`, models: d.models, relationships: d.relationships }))
        : undefined;

      let plan: RelationshipCommitPlan | undefined;
      const modelFiles: ModelFileOps = {};
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const current = Array.isArray(section.relationships) ? section.relationships as unknown[] : [];
          // An entry without four text ends is never matched, never dropped and never moved.
          const wellFormed = current.filter(isWellFormedRelationship);
          // v4: the inline models (objects in this very document) take a markKey.
          const inline = v5 ? [] : ((Array.isArray(section.models) ? section.models : []) as SemanticModel[])
            .filter((m) => !!m && typeof m === 'object' && typeof m.name === 'string'
              && endpointNames.some((n) => sameName(n, m.name)));
          plan = planRelationshipCommit({
            mode,
            op,
            endpointModels: v5 ? endpointModels : inline,
            domainRelationships: wellFormed,
            otherDomains,
            describeMissingModel: (name) => this.modelUnavailableMessage(name),
            libraryEntryExtras: (model, index) => this.libraryEntryExtras(model, index),
            domainFileLabel: path.basename(document.uri.fsPath),
            olderFormat: !v5,
            domainPositions: current.flatMap((entry, i) => (isWellFormedRelationship(entry) ? [i] : [])),
          });
          // A `logical.relationships` that is not a list (REL008: none of it
          // was read) is never replaced by the one record a commit writes —
          // the hand-written value would be lost without a word.
          if (plan.domainChanged && section.relationships !== undefined && section.relationships !== null
            && !Array.isArray(section.relationships)) {
            throw new RelationshipCommitError(
              `${path.basename(document.uri.fsPath)}: "logical.relationships" is not a list, so ERD Studio cannot write to it. Fix it by hand first.`,
            );
          }
          // Entries the reader could not use keep their slot (and their "entry N").
          if (plan.domainChanged) section.relationships = mergeDomainRelationships(current, wellFormed, plan.domainRelationships);
          if (v5 && plan.changedModels.length > 0) {
            // A model file the commit rewrites must not be open with unsaved
            // changes: the edit would replace the text on screen.
            for (const model of plan.changedModels) {
              const filePath = this.logicalModelService.findModelFile(model.name);
              if (filePath && this.isDirtyOnScreen(filePath)) throw new RelationshipCommitError(this.unsavedModelRefusal(filePath));
            }
            const written = plan.written;
            modelFiles.save = plan.changedModels.map((model) => ({
              model,
              ...(written?.where === 'library' && written.model === model.name ? { relationshipTargets: [written.index] } : {}),
            }));
          }
        },
        { webview, stage: 'logical', modelFiles, errorLabel: `Failed to ${action} ${label}.` },
      );
      if (success && plan) this.reportOtherDiagramCopies(plan);
      // The mode is read from disk (R3): taking the model library's last
      // relationship out while a diagram file still holds one of its own
      // switches where new ones go. That is never left for the next add to
      // discover (#133 review 8).
      if (success && mode === 'library') {
        const after = this.logicalModelService.relationshipModeInputs();
        if (!this.relationshipsInLibrary(after.models, after.unreadableWithRelationships)) {
          // Every diagram now draws its own copies and saves new ones in its
          // file: each open one is re-sent, not only those showing the models.
          await this.refreshAllOpenDomains(document.uri.toString());
          void vscode.window.showInformationMessage(LIBRARY_MODE_ENDED_MESSAGE, 'Move Relationships to Model Library').then((choice) => {
            if (choice) void vscode.commands.executeCommand('erdStudio.moveRelationshipsToLibrary');
          });
        }
      }
      // The other way round: taking the last relationship out of the diagram
      // files of a project that kept them there makes the model library their
      // home (`usesLibraryRelationships`). Said, and every open diagram re-sent
      // (its "Saved in this diagram" hint is stale) — never left for the next
      // line drawn to land somewhere the user did not expect.
      if (success && v5 && mode === 'domain') {
        const after = this.logicalModelService.relationshipModeInputs();
        if (this.relationshipsInLibrary(after.models, after.unreadableWithRelationships)) {
          await this.refreshAllOpenDomains(document.uri.toString());
          void vscode.window.showInformationMessage(LIBRARY_MODE_STARTED_MESSAGE);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof RelationshipCommitError)) {
        console.error(`[SemanticEditorProvider] ${action} ${label} failed: ${message}`);
      }
      fail(message);
    }
  }

  /**
   * What taking `model`'s `index`-th relationship (as read) out of its model
   * file would lose — its own keys and comments — read from the file as it
   * is on screen (or on disk). Empty when the file cannot be found or read.
   */
  private libraryEntryExtras(model: SemanticModel, index: number): readonly string[] {
    const filePath = this.logicalModelService.findModelFile(model.name);
    if (!filePath) return [];
    let text: string;
    try {
      const open = vscode.workspace.textDocuments.find((doc) => samePath(doc.uri.fsPath, filePath));
      text = open ? open.getText() : fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    const raw = relationshipFilePositions(model.relationships?.length ?? 0, model.relationshipIssues)[index] ?? index;
    return yamlEntryExtras(text).get(raw) ?? [];
  }

  /** Whether `filePath` is open in an editor with unsaved changes. */
  private isDirtyOnScreen(filePath: string): boolean {
    return vscode.workspace.textDocuments.some((doc) => doc.isDirty && samePath(doc.uri.fsPath, filePath));
  }

  /** The refusal for a model file that is open with unsaved changes. */
  private unsavedModelRefusal(filePath: string): string {
    const root = path.resolve(this.logicalModelService.getModelsDir());
    const relative = path.relative(root, filePath).split(path.sep).join('/');
    const file = relative && !relative.startsWith('..') ? `logical-models/${relative}` : path.basename(filePath);
    return `${file} has unsaved changes. Save or revert it first, then try again.`;
  }

  /** Why `modelName`'s file, which exists, cannot be read — or null when it reads (or does not exist). */
  private unreadableModelRefusal(modelName: string): string | null {
    const error = this.logicalModelService.getModelFileError(modelName);
    if (!error) return null;
    const file = this.libraryRelativePath(modelName);
    return error.kind === 'read'
      ? `${file} could not be read. Fix the file first, then try again.`
      : `${file} has a YAML error${error.line !== undefined ? ` on line ${error.line}` : ''}. Fix the file first, then try again.`;
  }

  /**
   * After any commit in a library project (add, ⇄, edit, remove): the other
   * diagram files that keep their own copy of the link, in ONE non-blocking
   * notice — a commit edits the model library and the open diagram's file,
   * never another diagram's. A copy of a link now in the model library is
   * ignored there (every diagram draws the library's — REL009); one that says
   * something else is named as such, since only the user knows whether it is
   * wrong. A copy of a link the commit took out of the library draws there
   * again. Writes nothing; only identical copies are Repair's to remove.
   */
  private reportOtherDiagramCopies(plan: RelationshipCommitPlan): void {
    const message = describeOtherDiagramCopies(plan);
    if (!message) return;
    const offerRepair = (plan.ignoredDomainCopies ?? []).some((c) => !c.differs);
    const shown = offerRepair
      ? vscode.window.showInformationMessage(message, 'Repair Relationships…')
      : vscode.window.showInformationMessage(message);
    void Promise.resolve(shown).then(async (choice) => {
      if (choice !== 'Repair Relationships…') return;
      await this.runRepairCommand();
    }).catch((err) => console.warn('[SemanticEditorProvider] Other-copies notice failed:', err));
  }

  /**
   * After a column rename or removal, or a model rename: the edit follows the
   * open diagram's own relationships and the model library's, but another
   * diagram file keeping its own copy of a relationship to the old name
   * (a project that keeps relationships per diagram, or a leftover copy) is
   * not rewritten — it now points at something that is gone (REL003 /
   * REL004 there). Named, with the command that lists it with the file to open
   * (#133 review 8). Writes nothing.
   */
  private reportOtherDiagramReferences(
    document: vscode.TextDocument,
    model: string,
    column: string | undefined,
    what: 'rename' | 'removal',
  ): void {
    let labels: string[];
    try {
      labels = readDomainRelationships(this.domainService, this.workspaceRoot, this.semanticDirName())
        .filter((d) => !samePath(d.filePath, document.uri.fsPath))
        .filter((d) => d.relationships.some((rel) => {
          const r = rel as unknown as Record<string, unknown>;
          return column === undefined
            ? relEndIs(r, 'from', model) || relEndIs(r, 'to', model)
            : relationshipReferencesColumnAnyCase(r, model, column);
        }))
        .map((d) => `${d.label}.json`)
        .sort();
    } catch (err) {
      console.warn('[SemanticEditorProvider] Other-diagram check failed:', err);
      return;
    }
    if (labels.length === 0) return;
    const where = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    const target = column === undefined ? model : `${model}.${column}`;
    void Promise.resolve(vscode.window.showInformationMessage(
      `${where} ${labels.length === 1 ? 'keeps its' : 'keep their'} own relationship to ${target}, which this ${what} did not change — ` +
      'Repair Relationships… lists it, with the file to open.',
      'Repair Relationships…',
    )).then(async (choice) => {
      if (choice !== 'Repair Relationships…') return;
      await this.runRepairCommand();
    }).catch((err) => console.warn('[SemanticEditorProvider] Other-diagram notice failed:', err));
  }

  /** Run "Repair Relationships…", reporting anything that escapes it. */
  private async runRepairCommand(): Promise<void> {
    try {
      await vscode.commands.executeCommand(REPAIR_RELATIONSHIPS_COMMAND);
    } catch (err) {
      telemetry.error('relMoveFailed');
      void vscode.window.showErrorMessage(
        `Repair Relationships failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async handleRenameModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { oldName: string; newName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      const nameError = validateModelName(payload.newName);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: nameError } });
        return;
      }
      const trimmedNew = payload.newName.trim();
      if (trimmedNew === payload.oldName) {
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const section = this.getStageSection(parsed, stage);

      // V5: rename central model file + update domain references
      if (this.isDomainV5(parsed)) {
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
          webview.postMessage({ type: 'error', payload: { message: `Model "${inDomain}" already exists in this domain.` } });
          return;
        }
        // The model library is shared across domains — renaming onto an
        // existing yml would silently replace another domain's model.
        const inLibrary = this.logicalModelService.findModelNameIgnoringCase(trimmedNew);
        if (inLibrary !== null) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Model "${inLibrary}" already exists in the model library (${this.libraryRelativePath(inLibrary)}). ` +
                'Choose a different name, or use "Add Existing Model" to reference it in this domain.',
            },
          });
          return;
        }
        const existingModel = this.logicalModelService.getModel(payload.oldName);
        if (!existingModel) {
          webview.postMessage({ type: 'error', payload: { message: this.modelUnavailableMessage(payload.oldName) } });
          return;
        }
        const refusal = this.unreadableReferrerRefusal(payload.oldName, 'rename');
        if (refusal) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to rename model: ${refusal}` } });
          return;
        }
        const renamedModel: import('../types/semantic').SemanticModel = { ...existingModel, name: trimmedNew };
        // Library relationships that point at the model — its own self-references
        // and every other model's — follow the rename (#126).
        renameModelInRelationships([renamedModel], payload.oldName, trimmedNew);
        const pointingAtIt = renameModelInRelationships(
          this.otherLibraryModels(payload.oldName), payload.oldName, trimmedNew);

        // Update domain (model reference name, relationships, positions) and
        // create-new + delete-old yml in one WorkspaceEdit so the rename is atomic
        // and a single undo restores both files.
        const success = await this.applyDomainEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            const idx = names.indexOf(payload.oldName);
            if (idx !== -1) names[idx] = trimmedNew;

            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            for (const rel of relationships) {
              if (relEndIs(rel, 'from', payload.oldName)) rel.fromModel = trimmedNew;
              if (relEndIs(rel, 'to', payload.oldName)) rel.toModel = trimmedNew;
            }

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
            // LogicalModelService.serializeModel.
            modelFiles: {
              save: [
                { model: renamedModel, fromName: payload.oldName },
                ...pointingAtIt.map((model) => ({ model })),
              ],
              delete: [payload.oldName],
            },
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
          this.reportOtherDiagramReferences(document, payload.oldName, undefined, 'rename');
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to rename model.' } });
        }
        return;
      }

      // V4: legacy inline path
      await this.applyDomainEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.oldName);
          if (!model) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.oldName}" not found.` } });
            throw new EditAborted();
          }
          if (models.some((m) => m !== model && typeof m.name === 'string' && sameName(m.name, trimmedNew))) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${trimmedNew}" already exists in this domain.` } });
            throw new EditAborted();
          }

          model.name = trimmedNew;

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          for (const rel of relationships) {
            if (relEndIs(rel, 'from', payload.oldName)) { rel.fromModel = trimmedNew; }
            if (relEndIs(rel, 'to', payload.oldName)) { rel.toModel = trimmedNew; }
          }

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
          errorLabel: 'Failed to rename model.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Rename model failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to rename model: ${message}` } });
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
   * `linkedModel` pointed at them) via `pruneViewConfigForRemovedModels`, the
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
    const isSingle = namesSet.size === 1;
    const errorLabel = isSingle ? 'model' : 'models';

    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;

      if (this.isDomainV5(parsed)) {
        const success = await this.applyDomainEdit(
          document,
          (sec, p) => {
            const models = (sec.models ?? []) as string[];
            sec.models = models.filter((name) => !namesSet.has(name));

            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = relationships.filter(
              (rel) => ![...namesSet].some((name) => relEndIs(rel, 'from', name) || relEndIs(rel, 'to', name)),
            );

            pruneViewConfigForRemovedModels(p, namesSet);
          },
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${errorLabel}.` } });
          return;
        }

        this.selectorsService.scheduleRegenerate();

        // Single batched prompt for any underlying .yml files.
        const filesToOffer = [...namesSet].filter((name) =>
          this.logicalModelService.modelExists(name),
        );
        if (filesToOffer.length > 0) {
          const fileIsSingle = filesToOffer.length === 1;
          // Relationships other model files keep to these models would point
          // at nothing once the files are gone (REL003 on every diagram
          // showing the model holding them): named here, and taken out in
          // the same edit (#133 review 8).
          const pointing = this.relationshipsToDeletedModels(filesToOffer).removed;
          const also = pointing.length === 0
            ? ''
            : ` This also removes ${pointing.length === 1 ? 'the relationship' : `${pointing.length} relationships`} other model files keep to ${fileIsSingle ? 'it' : 'them'}: ${describeRemovedRelationships(pointing)}.`;
          const prompt = (fileIsSingle
            ? `Model "${filesToOffer[0]}" removed from this domain. Delete the model file entirely?`
            : `${filesToOffer.length} models removed from this domain. Delete their model files entirely?`) + also;
          const deleteLabel = fileIsSingle ? 'Delete Model File' : 'Delete Model Files';
          const keepLabel = fileIsSingle ? 'Keep File' : 'Keep Files';
          void vscode.window
            .showInformationMessage(prompt, deleteLabel, keepLabel)
            .then(async (choice) => {
              if (choice !== deleteLabel) return;
              await this.deleteModelFiles(document, filesToOffer);
            });
        }
        return;
      }

      // V4: legacy inline path
      await this.applyDomainEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;
          sec.models = models.filter((m) => !namesSet.has(m.name as string));

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          sec.relationships = relationships.filter(
            (rel) => ![...namesSet].some((name) => relEndIs(rel, 'from', name) || relEndIs(rel, 'to', name)),
          );

          pruneViewConfigForRemovedModels(p, namesSet);
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
      console.error(`[SemanticEditorProvider] Remove ${errorLabel} failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${errorLabel}: ${message}` } });
    }
  }

  /** Single-relationship removal — thin wrapper over the batch handler. */
  private async handleRemoveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: RelationshipKey & { stored?: RelationshipKey },
  ): Promise<void> {
    return this.handleRemoveRelationships(document, webview, { relationships: [payload] });
  }

  /**
   * Batch-remove one or more relationships in a single edit — one
   * WorkspaceEdit (one undo step, one save, one webview refresh) regardless of
   * how many edges a multi-select delete covers. Every copy of each link goes
   * (core's `linkKey`: either way round, without case), wherever it is
   * stored. Links that no longer exist are skipped; it is an error only when
   * none of them matched (the single-edge "Relationship not found.").
   */
  private async handleRemoveRelationships(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { relationships: Array<RelationshipKey & { stored?: RelationshipKey }> },
  ): Promise<void> {
    // Validated at the message boundary (`relationshipPayloadError`): every
    // entry has valid ends, and its stored ends, when given, name the same link.
    const keys = payload.relationships.map((k) => k.stored ?? k);
    const label = keys.length === 1 ? 'relationship' : 'relationships';
    await this.commitRelationship(document, webview, { kind: 'remove', stored: keys }, 'remove', label);
  }

  /** ⇄ and the context menu's cardinality: a new cardinality for the link, read as it is drawn; the role is kept. */
  private async handleUpdateRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality; stored?: RelationshipKey },
  ): Promise<void> {
    const drawn: RelationshipEnds = {
      fromModel: payload.fromModel, fromColumn: payload.fromColumn, toModel: payload.toModel, toColumn: payload.toColumn,
    };
    await this.commitRelationship(
      document, webview, { kind: 'update', stored: payload.stored ?? payload, drawn, cardinality: payload.cardinality }, 'update', 'relationship',
    );
  }

  /** The Edit Relationship dialog: the link becomes the one described (ends, cardinality, role; '' clears the role). */
  private async handleEditRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string;
      fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality; role?: string;
      stored?: RelationshipKey; markKey?: RelationshipMarkKeyPayload;
    },
  ): Promise<void> {
    const original: RelationshipEnds = payload.stored ?? {
      fromModel: payload.originalFromModel,
      fromColumn: payload.originalFromColumn,
      toModel: payload.originalToModel,
      toColumn: payload.originalToColumn,
    };
    const next: Relationship = {
      fromModel: payload.fromModel,
      fromColumn: payload.fromColumn,
      toModel: payload.toModel,
      toColumn: payload.toColumn,
      cardinality: payload.cardinality,
      ...(payload.role !== undefined ? { role: payload.role } : {}),
    };
    await this.commitRelationship(
      document, webview,
      { kind: 'edit', stored: original, next, ...(payload.markKey ? { markKey: payload.markKey } : {}) },
      'edit', 'relationship',
    );
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
    try {
      await this.applyDomainEdit(
        document,
        (_section, parsed) => {
          const existingViewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
          const existingPositions = (existingViewConfig.positions ?? {}) as Record<string, unknown>;
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
        { refreshWebview: false, webview, stage: 'logical', errorLabel: 'Failed to save layout positions.' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Position update failed: ${message}`);
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
      await this.applyDomainEdit(
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
      console.error(`[SemanticEditorProvider] Add annotation failed: ${msg}`);
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
      await this.applyDomainEdit(
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
        await this.sendDomainData(document, webview);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update annotation failed: ${msg}`);
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
      await this.applyDomainEdit(
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
      console.error(`[SemanticEditorProvider] Remove ${label} failed: ${msg}`);
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
      const nameError = validateModelNameSafety(payload.modelName);
      if (nameError) {
        webview.postMessage({ type: 'error', payload: { message: `Failed to add model: ${nameError}` } });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const section = this.getStageSection(parsed, stage);

      // V5: add model reference to domain (create model file from manifest if needed)
      if (this.isDomainV5(parsed)) {
        const modelNames = (section.models ?? []) as string[];
        if (modelNames.includes(payload.modelName)) {
          webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" already exists in this domain.` } });
          return;
        }

        // Seed the logical model from yml (primary) or the manifest (fallback)
        // when it is not in the library yet — the same seeding Draw from dbt
        // uses (`seedModelFromDbt`). The file is NOT written here — it rides
        // in the same WorkspaceEdit as the domain change below, so a rejected
        // edit leaves no orphan yml behind and one undo removes both.
        const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
        const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
        let seededModel: import('../types/semantic').SemanticModel | undefined;
        if (!this.logicalModelService.modelExists(payload.modelName)) {
          const seed = seedModelFromDbt(payload.modelName, ymlData, manifest);
          if (!seed) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found in .yml files, manifest, or logical-models/.` } });
            return;
          }
          seededModel = { ...seed, name: payload.modelName };
        }

        // Relationships from the yml and manifest relationship tests together,
        // with cardinality from the unique tests (one-to-one when both ends
        // are unique), limited to edges whose other end is in this domain.
        const tests = dbtTestsOf(ymlData, manifest);
        const existingRelationships = (section.relationships ?? []) as Relationship[];
        const added = relationshipsForAddedModels(
          modelNames,
          [payload.modelName],
          tests.relationshipTests,
          tests.unique,
          existingRelationships,
        );
        if (seededModel) seededModel = markDraftKeys(seededModel, tests.unique, added);
        const routed = this.routeAddedRelationships(added, seededModel ? [seededModel] : []);

        const success = await this.applyDomainEdit(
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
        } else {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add model to domain.' } });
        }
        return;
      }

      // V4: legacy inline path — try yml first, fall back to manifest
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlModel = ymlData.models.get(payload.modelName);
      const manifestModel = manifest.models.get(payload.modelName);

      if (!ymlModel && !manifestModel) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found in .yml files or manifest.` },
        });
        return;
      }

      // The yml and manifest relationship tests together, with the unique
      // tests: the same reading the v5 path stores (one record per link,
      // turned round to its many side — a test declared on the dimension is
      // the fact's many-to-one — names matched without case).
      const tests = dbtTestsOf(ymlData, manifest);

      await this.applyDomainEdit(
        document,
        (sec, p) => {
          const models = (sec.models ?? []) as Array<Record<string, unknown>>;

          if (models.some((m) => m.name === payload.modelName)) {
            webview.postMessage({
              type: 'error',
              payload: { message: `Model "${payload.modelName}" already exists in this domain.` },
            });
            throw new EditAborted();
          }

          const viewConfig = (p.viewConfig ?? {}) as Record<string, unknown>;
          const existingPositions = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
          const newPosition = findOpenPosition(existingPositions);

          // Build columns from yml (primary) or manifest (fallback)
          const columns = ymlModel
            ? ymlModel.columns.map((col) => ({
                name: col.name,
                dataType: col.dataType ?? manifestModel?.columns.find((mc) => mc.name === col.name)?.data_type ?? 'unknown',
                description: col.description || '',
              }))
            : manifestModel!.columns.map((col) => ({
                name: col.name,
                dataType: col.data_type ?? 'unknown',
                description: col.description,
              }));

          models.push({
            name: payload.modelName,
            schema: manifestModel?.schema ?? '',
            description: ymlModel?.description || manifestModel?.description || '',
            columns,
          });

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          const modelNames = models.map((m) => m.name).filter((n): n is string => typeof n === 'string');
          // Deduped against what the domain already draws, either way round, without case (#133).
          const added = relationshipsForAddedModels(
            modelNames,
            [payload.modelName],
            tests.relationshipTests,
            tests.unique,
            relationships.filter(isWellFormedRelationship) as unknown as Relationship[],
          );
          sec.relationships = [...relationships, ...added];

          const updatedPositions = { ...existingPositions, [payload.modelName]: newPosition };
          sec.models = models;
          p.viewConfig = { ...viewConfig, positions: updatedPositions };
        },
        {
          webview,
          stage,
          errorLabel: 'Failed to add model to domain.',
          onSuccess: () => this.selectorsService.scheduleRegenerate(),
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add existing model failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add model: ${message}` } });
    }
  }

  /**
   * "Add models from dbt" — the empty canvas's primary action, a batch version
   * of Add Existing Model. Asks which dbt models with the Draw from dbt picker
   * (models already in the domain left out), seeds the ones the library lacks
   * from dbt's yml / manifest and adds names, relationships and new library
   * files in ONE `applyDomainEdit` — one save, one refresh, one undo step.
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
      const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
      if (!this.isDomainV5(parsed)) {
        telemetry.feature('addFromDbtNeedsV5');
        this.post(webview, {
          type: 'error',
          payload: { message: 'Adding models from dbt needs the central model store. Run "ERD Studio: Migrate Domains to Central Model Store" first.' },
        });
        return;
      }
      const inDomain = (this.getStageSection(parsed, 'logical').models ?? []) as string[];

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
        title: 'Add models from dbt',
      });
      if (!pick) { telemetry.feature('addFromDbtCancelled'); return; }

      await this.queueEdit(panelKey, () =>
        this.applyDbtModels(document, webview, pick.modelNames, ymlData, manifest));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add models from dbt failed: ${message}`);
      telemetry.error('addFromDbtFailed');
      this.post(webview, { type: 'error', payload: { message: `Failed to add models from dbt: ${message}` } });
    }
  }

  /** The queued half of {@link handleAddModelsFromDbt}: build the draft against the current document and write it. */
  private async applyDbtModels(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelNames: readonly string[],
    ymlData: YmlData,
    manifest: ManifestData,
  ): Promise<void> {
    try {
      // Re-read inside the queue: an edit may have landed while the picker was open.
      const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
      const section = this.getStageSection(parsed, 'logical');
      const existingNames = (section.models ?? []) as string[];
      const draft = buildDbtDraft({
        modelNames,
        ymlData,
        manifest,
        libraryHas: (name) => this.logicalModelService.modelExists(name),
        existingModelNames: existingNames,
        existingRelationships: (section.relationships ?? []) as Relationship[],
      });
      const skippedNote = describeSkippedDbtModels(draft.skipped);
      if (draft.modelNames.length === 0) {
        telemetry.feature('addFromDbtNothingDrawable');
        this.post(webview, {
          type: 'error',
          payload: { message: `No models were added from dbt.${skippedNote ? ` ${skippedNote}` : ''}` },
        });
        return;
      }

      const routed = this.routeAddedRelationships(draft.relationships, draft.newModels);
      await this.applyDomainEdit(
        document,
        (sec, p) => {
          const names = (sec.models ?? []) as string[];
          const wasEmpty = names.length === 0;
          names.push(...draft.modelNames);
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
            vc.positions = {
              ...positions,
              ...computeNewModelPositions({ newModels: draft.modelNames, relationships, existingPositions: positions }),
            };
          }
          p.viewConfig = vc;
        },
        {
          webview,
          stage: 'logical',
          errorLabel: 'Failed to add models from dbt.',
          ...(routed.saves.length > 0 ? { modelFiles: { save: routed.saves.map((model) => ({ model })) } } : {}),
          onSuccess: () => {
            telemetry.feature('addFromDbt');
            this.selectorsService.scheduleRegenerate();
            if (skippedNote) {
              const added = draft.modelNames.length;
              void vscode.window.showInformationMessage(
                `Added ${added} model${added === 1 ? '' : 's'} from dbt. ${skippedNote}`,
              );
            }
          },
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add models from dbt failed: ${message}`);
      telemetry.error('addFromDbtFailed');
      this.post(webview, { type: 'error', payload: { message: `Failed to add models from dbt: ${message}` } });
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

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
      console.error(`[SemanticEditorProvider] Update design rationale failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const description = payload.description?.trim() || undefined;
          if (description) { model.description = description; } else { delete model.description; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update description.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

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
      console.error(`[SemanticEditorProvider] Update description failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const grain = payload.grain?.trim() || undefined;
          if (grain) { model.grain = grain; } else { delete model.grain; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update grain statement.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

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
      console.error(`[SemanticEditorProvider] Update grain failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update grain: ${message}` } });
    }
  }

  /**
   * Set or clear a model's `alias` — the warehouse table name. It lives only
   * in the model file (v5), so it goes through applyModelEdit and shares that
   * path's single undo step; a v4 domain has no model files to hold it.
   */
  private async handleUpdateModelAlias(
    webview: vscode.Webview,
    document: vscode.TextDocument,
    payload: { modelName: string; alias: string },
  ): Promise<void> {
    try {
      const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
      if (!this.isDomainV5(parsed)) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Table names need the model library: run "ERD Studio: Migrate Domain to v5" first.' },
        });
        return;
      }
      const alias = payload.alias.trim();
      const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
        // An alias equal to the name says nothing dbt does not already do.
        if (alias && alias !== model.name) { model.alias = alias; } else { delete model.alias; }
      });
      if (!ok) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update table name.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update alias failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update table name: ${message}` } });
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
      const parsed = JSON.parse(document.getText()) as Record<string, unknown>;
      if (!this.isDomainV5(parsed)) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Metadata needs the model library: run "ERD Studio: Migrate Domain to v5" first.' },
        });
        return;
      }
      const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
      console.error(`[SemanticEditorProvider] Update meta failed: ${message}`);
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (this.isDomainV5(parsed)) {
        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          if (payload.modelRole) { model.modelRole = payload.modelRole as import('../types/semantic').ModelRole; } else { delete model.modelRole; }
        });
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update model role.' } });
        }
        return;
      }

      // V4: legacy inline path
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const models = (section.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

          if (payload.modelRole) { model.modelRole = payload.modelRole; } else { delete model.modelRole; }
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update model role.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update model role failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update model role: ${message}` } });
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

      // Update tracked stage
      panel.activeStage = targetStage;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
      const catalog = await this.loadCatalog();

      const unifiedDomain = this.domainService.getDomain(document.uri.fsPath);

      // Same in-memory auto-positioning as sendDomainData — never a write here.
      const computed = this.computeMissingPositions(unifiedDomain);
      if (computed) {
        unifiedDomain.viewConfig.positions = { ...(unifiedDomain.viewConfig.positions ?? {}), ...computed };
      }

      const reply = requestId !== undefined ? { requestId } : {};
      if (targetStage === 'physical') {
        // Physical stage is derived from the dbt project itself, enriched by the
        // manifest and the warehouse catalog when either has been generated.
        const physicalDomain = this.domainService.buildPhysicalDomain(unifiedDomain, ymlData, manifest, catalog);
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) {
          physicalDomain.layerConfig = layerConfig;
        }
        this.post(webview, { type: 'stageData', payload: physicalDomain, ...reply });
        // #113: where a missing manifest is met (once per day).
        if (this.manifestService.isMissing) telemetry.featureOnce('manifestMissingPhysical');
      } else {
        // Logical — extract from unified file
        const domain = this.domainService.getDomainStage(document.uri.fsPath);
        const displayDomain = this.buildDisplayDomain(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns, document.uri.fsPath);
        this.post(webview, { type: 'stageData', payload: displayDomain, ...reply, ...this.manifestHintFlag() });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Stage switch failed: ${message}`);
      this.post(webview, { type: 'error', payload: { message: `Failed to switch stage: ${message}` } });
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
    if (!payload.enabled || !payload.compareAgainst) {
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
      const { report } = computeDomainDiff(
        { domainService: this.domainService, ymlData, manifest, catalog },
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
      console.error(`[SemanticEditorProvider] Discrepancy comparison failed: ${message}`);
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

      // Parse domain info from the document
      const parsed = JSON.parse(document.getText());

      const syncPlan = buildSyncPlan(report, selections, {
        manifest,
        ymlData,
        projectRoot: this.workspaceRoot,
        semanticDir,
        domain: parsed.domain ?? '',
        layer: parsed.layer ?? '',
        modelFolder: (name) => this.logicalModelService.modelFolder(name),
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
      console.error(`[SemanticEditorProvider] Sync plan generation failed: ${msg}`);
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
          console.warn('[SemanticEditorProvider] Claude sync terminal closed before the prompt could be sent.');
          return;
        }
        terminal.sendText(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SemanticEditorProvider] Failed to send sync prompt to terminal: ${message}`);
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
  <title>Semantic Domain Editor</title>
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

/**
 * Whether `text` names `name` as a whole word, without case — how a model
 * file that cannot be parsed is checked for a relationship to `name`.
 */
function mentionsName(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, 'i').test(text);
}
