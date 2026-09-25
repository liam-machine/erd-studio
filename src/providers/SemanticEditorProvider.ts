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
 *                         runDbtCompile, launchClaudeSync),
 *                         feedback (requestFeedbackContext, analyzeFeedback,
 *                         submitFeedback, copyFeedbackReport,
 *                         openFeedbackLink),
 *                         viewFile, requestReload, dismissWelcome,
 *                         openGettingStarted
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
  relationshipReferencesColumn,
} from '../services/domainService';
import { computeDomainDiff } from '../services/stageDiff';
import { buildSyncPlan, countSyncPlanActions } from '../services/syncPlanBuilder';
import { findVenvActivate } from '../services/dbtEnv';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import { SelectorsService } from '../services/selectorsService';
import { computeNewModelPositions, findOpenPosition } from '../services/positionService';
import { computeMissingPositions, toDisplayDomain } from '@erd-studio/core';
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
import { findOwningDbtProject, samePath } from '../services/projectDiscovery';
import type {
  AnalyzeFeedbackMessage,
  CopyFeedbackReportMessage,
  ErrorMessage,
  OpenFeedbackLinkMessage,
  SetFeedbackProviderMessage,
  OpenFeedbackMessage,
  RelationshipKey,
  RequestFeedbackContextMessage,
  SubmitFeedbackMessage,
} from '../types/messages';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplayDomain } from '../types/display';
import type { Rationale, Cardinality, ColumnDef, DesignModel, Stage } from '../types/semantic';
import type { UpdateColumnPayloadColumn } from '../types/messages';
import type { GroundTruth } from '../types/syncPlan';
import type { NodePosition, Relationship, UnifiedDomain } from '../types/semantic';
import { describeUnsupportedDomainFormat, detectDomainFormat, getRawDomainModelNames } from '../types/semantic';

/**
 * Backoff between re-reads of a domain file that read as empty or truncated.
 * Four attempts across ~1.2s — comfortably longer than the gap between the
 * create and the write of a file being replaced, and short enough that a file
 * which really is broken still says so while the user is still looking.
 */
const DOMAIN_READ_RETRY_DELAYS_MS = [150, 350, 700];

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
  isValidKeyType,
  isValidModelRole,
  isValidStage,
  validateColumnDef as validateColumnDefPayload,
  validateColumnDefs,
  validateModelName,
  validateAnnotationPositions,
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

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Error posted to the webview when a mutation is attempted while viewing the physical stage. */
export const PHYSICAL_READ_ONLY_MESSAGE = 'Physical stage is read-only. Switch to the Logical stage to make changes.';

export class SemanticEditorProvider implements vscode.CustomTextEditorProvider {
  /**
   * Guard flags to prevent re-sending domain data to the webview when
   * an onDidChangeTextDocument event is triggered by our own WorkspaceEdit.
   * Keyed by document URI to support concurrent edits to multiple open domains.
   */
  private readonly pendingUpdates = new Map<string, boolean>();

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
    const owner = findOwningDbtProject(filePath);
    if (owner) { return samePath(owner, this.workspaceRoot) ? null : owner; }
    const rel = path.relative(this.workspaceRoot, filePath);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? null : undefined;
  }

  /** Static page (no scripts) plus a notification offering to open the file's own project. */
  private showForeignProject(webviewPanel: vscode.WebviewPanel, filePath: string, owner: string | undefined): void {
    const esc = (v: string): string =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const current = path.basename(this.workspaceRoot);
    const switchUri = owner
      ? `command:erdStudio.selectDbtProject?${encodeURIComponent(JSON.stringify([owner]))}`
      : '';
    webviewPanel.webview.options = { enableScripts: false, enableCommandUris: owner ? ['erdStudio.selectDbtProject'] : false };
    webviewPanel.webview.html =
      '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';"></head>' +
      '<body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:2em;max-width:44em;line-height:1.5">' +
      `<h2>This diagram belongs to ${owner ? `the <code>${esc(path.basename(owner))}</code> dbt project` : 'no dbt project'}</h2>` +
      `<p>ERD Studio has <code>${esc(current)}</code> open in this window, and a window shows one dbt project at a time. ` +
      'Opening this file here would mix its models with the wrong project\u2019s dbt data.</p>' +
      (owner
        ? `<p><a href="${esc(switchUri)}" style="display:inline-block;padding:6px 14px;border-radius:2px;text-decoration:none;` +
          'background:var(--vscode-button-background);color:var(--vscode-button-foreground)">' +
          `Switch ERD Studio to ${esc(path.basename(owner))}</a></p>`
        : '') +
      '</body></html>';
    const name = path.basename(filePath);
    if (!owner) {
      void vscode.window.showWarningMessage(
        `ERD Studio: ${name} is not inside a dbt project, so it cannot be opened with ${current}'s data.`,
      );
      return;
    }
    void vscode.window.showWarningMessage(
      `ERD Studio: ${name} belongs to the ${path.basename(owner)} dbt project, but ${current} is open.`,
      'Switch Project',
    ).then(choice => {
      if (choice === 'Switch Project') {
        void vscode.commands.executeCommand('erdStudio.selectDbtProject', owner);
      }
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
          'viewFile', 'generateSyncPlan', 'runDbtCompile', 'launchClaudeSync',
          'addAnnotation', 'updateAnnotation', 'removeAnnotation', 'removeAnnotations',
          'requestReload', 'openGettingStarted',
          'requestFeedbackContext', 'analyzeFeedback', 'setFeedbackProvider',
          'submitFeedback', 'copyFeedbackReport', 'openFeedbackLink',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
          console.warn(`[SemanticEditorProvider] Dropped "${message.type}" while viewing physical stage`);
          this.post(webviewPanel.webview, { type: 'error', payload: { message: PHYSICAL_READ_ONLY_MESSAGE } });
          return;
        }

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
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to add relationship: unknown cardinality "${String(payload.cardinality)}".` } });
                break;
              }
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
            const payload = (message as { payload?: { originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string; fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              if (!isValidCardinality(payload.cardinality)) {
                this.post(webviewPanel.webview, { type: 'error', payload: { message: `Failed to edit relationship: unknown cardinality "${String(payload.cardinality)}".` } });
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
              await this.queueEdit(panelKey, () =>
                this.handleAddExistingModel(document, webviewPanel.webview, payload, activeStage));
            }
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
              await this.handleSwitchStage(panelKey, document, webviewPanel.webview, payload.stage, requestId);
            }
            break;
          }
          case 'toggleDiscrepancy': {
            const payload = (message as { payload?: { enabled: boolean; compareAgainst?: Stage } }).payload;
            if (payload) {
              await this.handleToggleDiscrepancy(panelKey, document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'generateSyncPlan': {
            const payload = (message as { payload?: { selections: Record<string, GroundTruth> } }).payload;
            if (payload) {
              await this.handleGenerateSyncPlan(panelKey, document, webviewPanel.webview, payload.selections);
            }
            break;
          }
          case 'runDbtCompile': {
            await this.handleRunDbtCompile();
            break;
          }
          case 'launchClaudeSync': {
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
  private async applyModelEdit(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    modelName: string,
    modelMutator: (model: import('../types/semantic').SemanticModel) => void,
    domainMutator?: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
  ): Promise<boolean> {
    const model = this.logicalModelService.getModel(modelName);
    if (!model) {
      throw new Error(`Model "${modelName}" not found in logical-models/.`);
    }

    modelMutator(model);

    // Even when there is no domain-level change, the domain document is still
    // re-written (with identical content) so its undo stack gains an element
    // grouped with the yml edit — the custom editor's undo/redo operate on the
    // domain resource, and the group pulls the yml change along with it.
    return this.applyDomainEdit(
      document,
      domainMutator ?? (() => { /* no domain change */ }),
      { refreshWebview: true, webview, stage: 'logical', modelFiles: { save: [{ model }] } },
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

    for (const name of ops.delete ?? []) {
      if (!this.logicalModelService.modelExists(name)) continue;
      const deletePath = this.logicalModelService.modelPath(name);
      edit.deleteFile(vscode.Uri.file(deletePath), { ignoreIfNotExists: true });
      deleted.push(deletePath);
    }

    for (const { model, fromName } of ops.save ?? []) {
      const renamedFrom = fromName !== undefined && fromName !== model.name
        ? this.logicalModelService.modelFolder(fromName)
        : null;
      const modelPath = this.logicalModelService.modelPath(model.name, renamedFrom ?? layerFolder);
      const uri = vscode.Uri.file(modelPath);
      const yamlText = this.logicalModelService.serializeModel(model, fromName);
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
  private async saveDirtyModelDocuments(panelKey: string): Promise<void> {
    const ourPaths = this.editedModelPaths.get(panelKey);
    if (!ourPaths || ourPaths.size === 0) return;
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty) continue;
      if (!ourPaths.has(doc.uri.fsPath)) continue;
      try {
        await doc.save();
        this.ownWriteTracker.recordWrite(doc.uri.fsPath);
      } catch (err) {
        console.error(`[SemanticEditorProvider] Failed to save ${doc.uri.fsPath} after undo/redo:`, err);
      }
    }
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
    this.pendingUpdates.set(panelKey, true);
    try {
      await vscode.commands.executeCommand(command);
      await document.save();
      this.ownWriteTracker.recordWrite(document.uri.fsPath);
      await this.saveDirtyModelDocuments(panelKey);
      this.logicalModelService.invalidateCache();
      await this.sendDomainData(document, webview, panelKey);
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
      if (!success) {
        if (errorLabel && webview) {
          webview.postMessage({ type: 'error', payload: { message: errorLabel } });
        }
        return false;
      }
      await document.save();
      // Own writes are recorded only once the bytes are on disk — the tracker
      // stats the file — so the logical-model / semantic watchers can tell
      // this save apart from an external edit and skip the extra refresh.
      this.ownWriteTracker.recordWrite(document.uri.fsPath);
      for (const filePath of created) {
        this.ownWriteTracker.recordWrite(filePath);
      }
      for (const filePath of deleted) {
        this.ownWriteTracker.recordDelete(filePath);
      }
      const ourPaths = this.editedModelPaths.get(panelKey) ?? new Set<string>();
      for (const modelDoc of modelDocs) {
        await modelDoc.save();
        this.ownWriteTracker.recordWrite(modelDoc.uri.fsPath);
        // Remember which yml documents WE edited for this domain, so an
        // undo/redo only ever flushes those (never a buffer the user is
        // hand-editing in another tab).
        ourPaths.add(modelDoc.uri.fsPath);
      }
      for (const filePath of created) {
        ourPaths.add(filePath);
      }
      if (ourPaths.size > 0) {
        this.editedModelPaths.set(panelKey, ourPaths);
      }
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
    for (const name of new Set(touchedModels)) {
      this.logicalModelService.invalidateCache(name);
      await this.refreshDomainsReferencingModel(name, panelKey);
    }
    this._onDidWriteDomain.fire({
      uri: document.uri,
      modelLibraryChanged: created.length > 0 || deleted.length > 0,
    });

    onSuccess?.();
    return true;
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
    stubColumns?: string[],
  ): DisplayDomain {
    const editorPayload = this.buildWebviewPayload(domain, manifest, ymlData, domain.modelFolder);

    return toDisplayDomain(domain, {
      viewConfig,
      stubColumns,
      layerConfig: this.layerService.getLayer(domain.layer),
      readOnly: domain.stage === 'physical',
      editorPayload,
    });
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
      });
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
      } else {
        const domain = DomainService.toLogicalStage(unifiedDomain);
        const displayDomain = this.buildDisplayDomain(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns);
        this.post(webview, {
          type: 'domainLoaded',
          payload: displayDomain,
          welcomeDismissed,
          ...(autoLayout ? { autoLayout: true } : {}),
        });
      }
      // A payload went out, so the next failure is news again.
      this.lastLoadError.delete(errorKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.postLoadError(webview, errorKey, {
        message,
        ...(err instanceof DomainFileError ? { kind: 'domain-file' as const } : {}),
      }, err);
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
  private async readDomainTolerantly(filePath: string): Promise<UnifiedDomain> {
    for (let attempt = 0; ; attempt++) {
      try {
        return this.domainService.getDomain(filePath);
      } catch (err) {
        const last = attempt >= DOMAIN_READ_RETRY_DELAYS_MS.length;
        if (last || !(err instanceof DomainFileError) || !err.transient) {
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
    err?: unknown,
  ): void {
    if (this.lastLoadError.get(errorKey) === payload.message) {
      return;
    }
    this.lastLoadError.set(errorKey, payload.message);
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
   * Refresh all open domain editors with fresh manifest data.
   * Called by extension.ts when manifest changes.
   * Stage-aware: panels viewing physical stage get physical data.
   */
  async refreshAllOpenDomains(): Promise<void> {
    for (const [panelKey, { document, webview, activeStage }] of Array.from(this.openPanels.entries())) {
      // The snapshot may include a panel that was disposed while an earlier
      // iteration awaited — skip it rather than refreshing a dead webview.
      if (this.disposedWebviews.has(webview) || !this.openPanels.has(panelKey)) {
        continue;
      }
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
        const referencesModel = getRawDomainModelNames(parsed).includes(modelName);

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
        if (modelNames.includes(model.name)) {
          webview.postMessage({ type: 'error', payload: { message: `Model "${model.name}" already exists in this domain.` } });
          return;
        }
        // The model library is shared across domains — never overwrite a
        // logical-models/{name}.yml that another domain may depend on.
        if (this.logicalModelService.modelExists(model.name)) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Model "${model.name}" already exists in the model library (${this.libraryRelativePath(model.name)}). ` +
                'Use "Add Existing Model" to reference it in this domain, or choose a different name.',
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

          if (models.some((m) => m.name === model.name)) {
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
          if (columns.some((c) => c.name === payload.column.name)) {
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
          if (columns.some((c) => c.name === payload.column.name)) {
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
        const domainMutator = columnRenamed ? (section: Record<string, unknown>) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          for (const rel of relationships) {
            if (rel.fromModel === payload.modelName && rel.fromColumn === payload.oldColumnName) {
              rel.fromColumn = payload.column.name;
            }
            if (rel.toModel === payload.modelName && rel.toColumn === payload.oldColumnName) {
              rel.toColumn = payload.column.name;
            }
          }
        } : undefined;

        const ok = await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
          if (columnIndex === -1) throw new Error(`Column "${payload.oldColumnName}" not found.`);
          if (columnRenamed && columns.some((c) => c.name === payload.column.name)) {
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
          } as ColumnDef;
        }, domainMutator);
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to update column.' } });
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
            if (columns.some((c) => c.name === payload.column.name)) {
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

          // Cascade column rename into relationships
          if (payload.oldColumnName !== payload.column.name) {
            const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
            for (const rel of relationships) {
              if (rel.fromModel === payload.modelName && rel.fromColumn === payload.oldColumnName) {
                rel.fromColumn = payload.column.name;
              }
              if (rel.toModel === payload.modelName && rel.toColumn === payload.oldColumnName) {
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
        const ok = await this.applyModelEdit(
          document,
          webview,
          payload.modelName,
          (model) => {
            const columns = model.columns ?? [];
            const idx = columns.findIndex((c) => c.name === payload.columnName);
            if (idx === -1) return;
            columns.splice(idx, 1);
          },
          (sec) => {
            const rels = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = rels.filter(
              (rel) => !relationshipReferencesColumn(rel, payload.modelName, payload.columnName),
            );
          },
        );
        if (!ok) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to remove column.' } });
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
            (rel) => !relationshipReferencesColumn(rel, payload.modelName, payload.columnName),
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
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality },
    stage: 'logical',
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          const isDuplicate = relationships.some(
            (rel) =>
              rel.fromModel === payload.fromModel &&
              rel.fromColumn === payload.fromColumn &&
              rel.toModel === payload.toModel &&
              rel.toColumn === payload.toColumn,
          );
          if (isDuplicate) {
            throw new Error('This relationship already exists.');
          }

          relationships.push({
            fromModel: payload.fromModel,
            fromColumn: payload.fromColumn,
            toModel: payload.toModel,
            toColumn: payload.toColumn,
            cardinality: payload.cardinality,
          });
          section.relationships = relationships;
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to add relationship.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add relationship failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add relationship: ${message}` } });
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
        const currentNames = (section.models ?? []) as string[];
        if (currentNames.includes(trimmedNew)) {
          webview.postMessage({ type: 'error', payload: { message: `Model "${trimmedNew}" already exists in this domain.` } });
          return;
        }
        // The model library is shared across domains — renaming onto an
        // existing yml would silently replace another domain's model.
        if (this.logicalModelService.modelExists(trimmedNew)) {
          webview.postMessage({
            type: 'error',
            payload: {
              message: `Model "${trimmedNew}" already exists in the model library (${this.libraryRelativePath(trimmedNew)}). ` +
                'Choose a different name, or use "Add Existing Model" to reference it in this domain.',
            },
          });
          return;
        }
        const existingModel = this.logicalModelService.getModel(payload.oldName);
        if (!existingModel) {
          webview.postMessage({ type: 'error', payload: { message: `Model "${payload.oldName}" not found in logical-models/.` } });
          return;
        }
        const renamedModel: import('../types/semantic').SemanticModel = { ...existingModel, name: trimmedNew };

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
              if (rel.fromModel === payload.oldName) rel.fromModel = trimmedNew;
              if (rel.toModel === payload.oldName) rel.toModel = trimmedNew;
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
            modelFiles: { save: [{ model: renamedModel, fromName: payload.oldName }], delete: [payload.oldName] },
          },
        );

        if (success) {
          this.selectorsService.scheduleRegenerate();
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
          if (models.some((m) => m.name === trimmedNew)) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${trimmedNew}" already exists in this domain.` } });
            throw new EditAborted();
          }

          model.name = trimmedNew;

          const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
          for (const rel of relationships) {
            if (rel.fromModel === payload.oldName) { rel.fromModel = trimmedNew; }
            if (rel.toModel === payload.oldName) { rel.toModel = trimmedNew; }
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
              (rel) =>
                !namesSet.has(rel.fromModel as string) &&
                !namesSet.has(rel.toModel as string),
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
          const prompt = fileIsSingle
            ? `Model "${filesToOffer[0]}" removed from this domain. Delete the model file entirely?`
            : `${filesToOffer.length} models removed from this domain. Delete their model files entirely?`;
          const deleteLabel = fileIsSingle ? 'Delete Model File' : 'Delete Model Files';
          const keepLabel = fileIsSingle ? 'Keep File' : 'Keep Files';
          void vscode.window
            .showInformationMessage(prompt, deleteLabel, keepLabel)
            .then(async (choice) => {
              if (choice !== deleteLabel) return;
              // Delete through a WorkspaceEdit so VS Code snapshots the files
              // and the deletion is undoable, rather than a bare unlink.
              const deleteEdit = new vscode.WorkspaceEdit();
              // Captured before the delete: afterwards the folder is unknowable.
              const singlePath = fileIsSingle ? this.libraryRelativePath(filesToOffer[0]) : '';
              for (const name of filesToOffer) {
                deleteEdit.deleteFile(
                  vscode.Uri.file(this.logicalModelService.modelPath(name)),
                  { ignoreIfNotExists: true },
                );
              }
              const deleted = await vscode.workspace.applyEdit(deleteEdit);
              if (!deleted) {
                void vscode.window.showErrorMessage('Failed to delete model file(s).');
                return;
              }
              const summary = fileIsSingle
                ? `Deleted ${singlePath}`
                : `Deleted ${filesToOffer.length} model files`;
              vscode.window.showInformationMessage(summary);
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
            (rel) =>
              !namesSet.has(rel.fromModel as string) &&
              !namesSet.has(rel.toModel as string),
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
      await this.applyDomainEdit(
        document,
        (section) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          const matches = (rel: Record<string, unknown>) =>
            keys.some(
              (k) =>
                rel.fromModel === k.fromModel &&
                rel.fromColumn === k.fromColumn &&
                rel.toModel === k.toModel &&
                rel.toColumn === k.toColumn,
            );
          const remaining = relationships.filter((rel) => !matches(rel));
          if (remaining.length === relationships.length) {
            throw new Error('Relationship not found.');
          }
          section.relationships = remaining;
        },
        { webview, stage, errorLabel: `Failed to remove ${label}.` },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove ${label} failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove ${label}: ${message}` } });
    }
  }

  private async handleUpdateRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality },
    stage: 'logical',
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          const relIndex = relationships.findIndex(
            (rel) =>
              rel.fromModel === payload.fromModel &&
              rel.fromColumn === payload.fromColumn &&
              rel.toModel === payload.toModel &&
              rel.toColumn === payload.toColumn,
          );
          if (relIndex === -1) {
            throw new Error('Relationship not found.');
          }
          relationships[relIndex].cardinality = payload.cardinality;
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update relationship.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update relationship failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to update relationship: ${message}` } });
    }
  }

  private async handleEditRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string;
      fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality;
    },
    stage: 'logical',
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (section) => {
          const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
          const relIndex = relationships.findIndex(
            (rel) =>
              rel.fromModel === payload.originalFromModel &&
              rel.fromColumn === payload.originalFromColumn &&
              rel.toModel === payload.originalToModel &&
              rel.toColumn === payload.originalToColumn,
          );
          if (relIndex === -1) {
            throw new Error('Relationship not found.');
          }

          // Check for duplicate at new key
          const keyChanged =
            payload.fromModel !== payload.originalFromModel ||
            payload.fromColumn !== payload.originalFromColumn ||
            payload.toModel !== payload.originalToModel ||
            payload.toColumn !== payload.originalToColumn;

          if (keyChanged) {
            const isDuplicate = relationships.some(
              (rel, idx) =>
                idx !== relIndex &&
                rel.fromModel === payload.fromModel &&
                rel.fromColumn === payload.fromColumn &&
                rel.toModel === payload.toModel &&
                rel.toColumn === payload.toColumn,
            );
            if (isDuplicate) {
              throw new Error('A relationship with this key already exists.');
            }
          }

          relationships[relIndex] = {
            fromModel: payload.fromModel,
            fromColumn: payload.fromColumn,
            toModel: payload.toModel,
            toColumn: payload.toColumn,
            cardinality: payload.cardinality,
          };
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to edit relationship.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Edit relationship failed: ${message}`);
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
        // when it is not in the library yet. The file is NOT written here — it
        // rides in the same WorkspaceEdit as the domain change below, so a
        // rejected edit leaves no orphan yml behind and one undo removes both.
        let seededModel: import('../types/semantic').SemanticModel | undefined;
        if (!this.logicalModelService.modelExists(payload.modelName)) {
          const seedYmlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
          const ymlModel = seedYmlData.models.get(payload.modelName);
          if (ymlModel) {
            seededModel = this.logicalModelService.ymlToSemanticModel(ymlModel);
          } else {
            const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
            const manifestModel = manifest.models.get(payload.modelName);
            if (manifestModel) {
              seededModel = this.logicalModelService.manifestToSemanticModel(manifestModel);
            }
          }
          if (!seededModel) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found in .yml files, manifest, or logical-models/.` } });
            return;
          }
        }

        // Add name reference + position + auto-relationships to domain
        // Use yml relationship tests as primary, fall back to manifest
        const ymlData = await this.ymlParserService.loadYmlData(this.workspaceRoot, undefined);
        await this.manifestService.loadManifest(this.workspaceRoot);
        const manifestRelTests = this.manifestService.getRelationshipTests();
        const relationshipTests = ymlData.relationshipTests.length > 0
          ? ymlData.relationshipTests
          : manifestRelTests;

        const success = await this.applyDomainEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            names.push(payload.modelName);

            // Auto-create relationships from manifest tests
            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            const allNames = new Set(names);
            for (const test of relationshipTests) {
              if (test.fromModel !== payload.modelName && test.toModel !== payload.modelName) continue;
              if (!allNames.has(test.fromModel) || !allNames.has(test.toModel)) continue;
              const alreadyExists = relationships.some(
                (r) => r.fromModel === test.fromModel && r.fromColumn === test.fromColumn &&
                        r.toModel === test.toModel && r.toColumn === test.toColumn,
              );
              if (!alreadyExists) {
                relationships.push({
                  fromModel: test.fromModel, fromColumn: test.fromColumn,
                  toModel: test.toModel, toColumn: test.toColumn,
                  cardinality: 'many-to-one',
                });
              }
            }
            sec.relationships = relationships;

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
            ...(seededModel ? { modelFiles: { save: [{ model: seededModel }] } } : {}),
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

      // Use yml relationship tests as primary, fall back to manifest
      const ymlRelTests = ymlData.relationshipTests;
      const manifestRelTests = this.manifestService.getRelationshipTests();
      const relationshipTests = ymlRelTests.length > 0 ? ymlRelTests : manifestRelTests;

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
          const modelNames = new Set(models.map((m) => m.name as string));

          for (const test of relationshipTests) {
            if (test.fromModel !== payload.modelName && test.toModel !== payload.modelName) continue;
            if (!modelNames.has(test.fromModel) || !modelNames.has(test.toModel)) continue;
            const alreadyExists = relationships.some(
              (r) => r.fromModel === test.fromModel && r.fromColumn === test.fromColumn &&
                      r.toModel === test.toModel && r.toColumn === test.toColumn,
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
      } else {
        // Logical — extract from unified file
        const domain = this.domainService.getDomainStage(document.uri.fsPath);
        const displayDomain = this.buildDisplayDomain(domain, manifest, ymlData, unifiedDomain.viewConfig, unifiedDomain.stubColumns);
        this.post(webview, { type: 'stageData', payload: displayDomain, ...reply });
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
