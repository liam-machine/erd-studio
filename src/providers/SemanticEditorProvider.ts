/**
 * SemanticEditorProvider — CustomTextEditorProvider for semantic domain JSON files.
 *
 * Opens semantic JSON files in a React webview instead of the default JSON editor.
 * VS Code manages save/dirty state for the underlying text document.
 *
 * Message protocol:
 *   Webview → Extension:  { type: "ready" }
 *   Extension → Webview:  { type: "domainLoaded", payload: DisplayDomain }
 *   Extension → Webview:  { type: "error", payload: { message: string } }
 *
 * Update loop prevention:
 *   When writing via WorkspaceEdit, a pendingUpdate flag is set to avoid
 *   re-sending the update triggered by onDidChangeTextDocument.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import { DomainService } from '../services/domainService';
import { compare as compareStages } from '../services/discrepancyService';
import { ManifestService } from '../services/manifestService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import { SchemaTagService } from '../services/schemaTagService';
import { computeNewModelPositions, findOpenPosition } from '../services/positionService';
import { checkManifestStaleness } from '../services/stalenessService';
import type { ManifestData } from '../types/manifest';
import type { DiscrepancyReport } from '../types/discrepancy';
import type { DisplayDomain } from '../types/display';
import type { Rationale, Cardinality, ColumnDef, DesignModel, Stage } from '../types/semantic';
import type { GroundTruth } from '../types/syncPlan';
import {
  deriveModelAction,
  deriveColumnAction,
  deriveRelationshipAction,
} from '../types/syncPlan';
import type {
  SyncPlan,
  ModelResolution,
  ColumnResolution,
  RelationshipResolution,
  ModelContext,
} from '../types/syncPlan';
import type { NodePosition, Relationship } from '../types/semantic';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SemanticEditorProvider implements vscode.CustomTextEditorProvider {
  /**
   * Guard flags to prevent re-sending domain data to the webview when
   * an onDidChangeTextDocument event is triggered by our own WorkspaceEdit.
   * Keyed by document URI to support concurrent edits to multiple open domains.
   */
  private readonly pendingUpdates = new Map<string, boolean>();

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
    }
  >();

  /**
   * Track model names per document for diff-based tag sync.
   * When models are added/removed (including via undo/redo), the diff
   * triggers tag sync to keep YAML files consistent.
   */
  private readonly previousModels = new Map<string, Set<string>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly templateService: TemplateService,
    private readonly layerService: LayerService,
    private readonly workspaceRoot: string,
    private readonly schemaTagService: SchemaTagService,
    readonly logicalModelService: import('../services/logicalModelService').LogicalModelService,
  ) {}

  /**
   * Build supplementary payload data for webview messages.
   * Includes templates and list of available models from logical-models/ and manifest.
   */
  private buildWebviewPayload(
    domain: { models: Array<{ name: string }> },
    manifest: ManifestData,
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

    // Build existing models list from two sources: logical-models/ and manifest
    const existingModels: import('../types/display').ExistingModelPreview[] = [];
    const addedNames = new Set<string>();

    // 1. Logical models (already designed in ERD Studio)
    const logicalModels = this.logicalModelService.listModels();
    for (const model of logicalModels) {
      if (existingModelNames.has(model.name)) continue; // already in domain
      existingModels.push({
        name: model.name,
        schema: model.schema ?? '',
        description: model.description ?? '',
        columnCount: (model.columns ?? []).length,
        source: 'logical',
      });
      addedNames.add(model.name);
    }

    // 2. Manifest models (not yet designed)
    let filteredManifest = Array.from(manifest.models.values()).filter(
      (m) => !existingModelNames.has(m.name) && !addedNames.has(m.name),
    );

    // Apply folder filter if configured (prefix match)
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
      });
    }

    // Sort: logical first, then manifest, alphabetical within each group
    existingModels.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'logical' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Legacy manifestModels (for backward compat with v4 webview until dialog is updated)
    const manifestModels = existingModels
      .filter((m) => m.source === 'manifest')
      .map(({ name, schema, description, columnCount }) => ({ name, schema, description, columnCount }));

    return { templates, manifestModels, existingModels };
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
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
      async (message: unknown) => {
        if (!isTypedMessage(message)) {
          return;
        }

        // Guard: reject mutation messages when viewing physical (read-only) stage.
        // Non-mutation messages (ready, switching, viewing, navigation) are allowed through.
        const panel = this.openPanels.get(panelKey);
        const NON_MUTATION_TYPES = new Set([
          'ready', 'updatePositions', 'switchStage', 'toggleDiscrepancy',
          'refreshManifest', 'undo', 'redo', 'updateViewConfig', 'dismissWelcome',
          'viewFile', 'checkManifestStaleness', 'generateSyncPlan', 'runDbtCompile', 'launchClaudeSync',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
          return;
        }

        // Mutations always target the logical stage (physical is already guarded above)
        const activeStage = 'logical' as const;

        switch (message.type) {
          case 'ready':
            await this.sendDomainData(document, webviewPanel.webview, panelKey);
            break;
          case 'dismissWelcome':
            await this.context.globalState.update('welcomeDismissed', true);
            break;
          case 'updatePositions': {
            const payload = (message as Record<string, unknown>).payload as
              | { positions: Record<string, { x: number; y: number }> }
              | undefined;
            if (payload?.positions) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdatePositions(
                  document,
                  webviewPanel.webview,
                  payload.positions,
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
              await this.queueEdit(panelKey, () =>
                this.handleToggleColumnKey(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'addRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
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
          case 'removeRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleRemoveRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'updateRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              await this.queueEdit(panelKey, () =>
                this.handleUpdateRelationship(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'editRelationship': {
            const payload = (message as { payload?: { originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string; fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
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
            await vscode.commands.executeCommand('dbtSemantic.refreshManifest');
            break;
          }
          case 'viewFile': {
            await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
            break;
          }
          case 'undo': {
            await vscode.commands.executeCommand('undo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview, panelKey);
            break;
          }
          case 'redo': {
            await vscode.commands.executeCommand('redo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview, panelKey);
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
              await this.queueEdit(panelKey, () =>
                this.handleUpdateModelRole(document, webviewPanel.webview, payload, activeStage));
            }
            break;
          }
          case 'switchStage': {
            const payload = (message as { payload?: { stage: Stage } }).payload;
            if (payload) {
              await this.handleSwitchStage(panelKey, document, webviewPanel.webview, payload.stage);
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
          case 'checkManifestStaleness': {
            await this.handleCheckManifestStaleness(webviewPanel.webview);
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
        }
      },
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
      this.openPanels.delete(panelKey);
      this.previousModels.delete(document.uri.toString());
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
   */
  private isDomainV5(parsed: Record<string, unknown>): boolean {
    const version = parsed.schemaVersion as number;
    if (version >= 5) return true;
    const section = this.getStageSection(parsed, 'logical');
    const models = section.models as unknown[];
    if (!models || models.length === 0) return false;
    return typeof models[0] === 'string';
  }

  /**
   * Apply a mutation to a model stored in logical-models/{name}.yml (v5 path).
   * Reads the model, applies the mutator callback, writes back, and refreshes the view.
   *
   * For handlers that also need to modify the domain file (e.g., cascade column rename
   * into relationships), pass a domainMutator callback.
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
      webview.postMessage({ type: 'error', payload: { message: `Model "${modelName}" not found in logical-models/.` } });
      return false;
    }

    modelMutator(model);
    this.logicalModelService.saveModel(model);

    // If there's also a domain-level mutation (e.g., relationship cascade), apply it
    if (domainMutator) {
      const success = await this.applyDomainEdit(
        document,
        domainMutator,
        { refreshWebview: true, webview, stage: 'logical' },
      );
      return success;
    }

    // No domain change — just refresh the view
    await this.sendDomainData(document, webview);
    return true;
  }

  /**
   * Generic helper to apply a stage-scoped mutation to the domain JSON and persist it.
   * Handles the common WorkspaceEdit pattern used by all mutation handlers.
   */
  private async applyDomainEdit(
    document: vscode.TextDocument,
    mutator: (section: Record<string, unknown>, parsed: Record<string, unknown>) => void,
    options: { refreshWebview?: boolean; webview?: vscode.Webview; stage: 'logical' },
  ): Promise<boolean> {
    const { refreshWebview = true, webview, stage } = options;
    const panelKey = document.uri.toString();

    const text = document.getText();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const section = this.getStageSection(parsed, stage);

    mutator(section, parsed);

    const updatedText = JSON.stringify(parsed, null, 2) + '\n';
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    edit.replace(document.uri, fullRange, updatedText);

    this.pendingUpdates.set(panelKey, true);
    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      try {
        await document.save();
        if (refreshWebview && webview) {
          await this.sendDomainData(document, webview);
        }
      } finally {
        this.pendingUpdates.delete(panelKey);
      }
      return true;
    } else {
      this.pendingUpdates.delete(panelKey);
      return false;
    }
  }

  /**
   * Convert a SemanticDomain to a DisplayDomain for the webview.
   * viewConfig is passed separately since it lives at the unified domain root level.
   */
  private buildDisplayDomain(
    domain: import('../types/semantic').SemanticDomain,
    manifest: ManifestData,
    viewConfig: import('../types/semantic').ViewConfig,
  ): DisplayDomain {
    // Build FK column set for isForeignKey computation
    const fkColumnsByModel = new Map<string, Set<string>>();
    for (const rel of domain.relationships) {
      if (!fkColumnsByModel.has(rel.fromModel)) {
        fkColumnsByModel.set(rel.fromModel, new Set());
      }
      fkColumnsByModel.get(rel.fromModel)!.add(rel.fromColumn);
    }

    const models = domain.models.map((model) => {
      const fkCols = fkColumnsByModel.get(model.name) ?? new Set<string>();
      const columns = (model.columns ?? []).map((col) => ({
        name: col.name,
        dataType: col.dataType,
        description: col.description,
        isPrimaryKey: col.isPrimaryKey === true,
        isForeignKey: col.isForeignKey === true || fkCols.has(col.name),
        isNaturalKey: col.isNaturalKey === true,
        ...(col.scdType != null ? { scdType: col.scdType } : {}),
        ...(col.additiveType ? { additiveType: col.additiveType } : {}),
      }));

      return {
        name: model.name,
        schema: model.schema ?? '',
        description: model.description ?? '',
        columns,
        ...(model.rationale ? { rationale: model.rationale } : {}),
        ...(model.grain ? { grain: model.grain } : {}),
        ...(model.modelRole ? { modelRole: model.modelRole } : {}),
      };
    });

    const relationships = domain.relationships.map((rel) => ({
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: rel.cardinality,
    }));

    const { templates, manifestModels, existingModels } = this.buildWebviewPayload(
      { models },
      manifest,
      domain.modelFolder,
    );

    const layerConfig = this.layerService.getLayer(domain.layer);

    return {
      schemaVersion: domain.schemaVersion,
      domain: domain.domain,
      layer: domain.layer,
      stage: domain.stage,
      description: domain.description,
      modelFolder: domain.modelFolder,
      models,
      relationships,
      viewConfig,
      templates,
      manifestModels,
      existingModels,
      layerConfig,
      readOnly: domain.stage === 'physical',
      positionDraggable: true,
    };
  }

  /**
   * Parse the document, build display domain for the active stage, and send to webview.
   * On parse failure, sends an error message instead.
   */
  private async sendDomainData(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    panelKey?: string,
  ): Promise<void> {
    try {
      const key = panelKey ?? document.uri.toString();
      const panel = this.openPanels.get(key);
      const activeStage = panel?.activeStage ?? 'logical';

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const welcomeDismissed = !!this.context.globalState.get('welcomeDismissed');

      let unifiedDomain = this.domainService.getDomain(document.uri.fsPath);

      // Diff-based tag sync: detect model membership changes and sync YAML tags
      void this.diffAndSyncTags(document, unifiedDomain);

      // Auto-assign positions for models that lack them (e.g. added by AI agents)
      const positionsWritten = await this.autoPositionNewModels(document, unifiedDomain);
      if (positionsWritten) {
        // Re-read since we wrote new positions to the file
        unifiedDomain = this.domainService.getDomain(document.uri.fsPath);
      }

      if (activeStage === 'physical') {
        const physicalDomain = this.domainService.buildPhysicalDomain(unifiedDomain, manifest);
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) { physicalDomain.layerConfig = layerConfig; }
        webview.postMessage({ type: 'domainLoaded', payload: physicalDomain, welcomeDismissed });
      } else {
        const domain = this.domainService.getDomainStage(document.uri.fsPath);
        const displayDomain = this.buildDisplayDomain(domain, manifest, unifiedDomain.viewConfig);
        webview.postMessage({ type: 'domainLoaded', payload: displayDomain, welcomeDismissed });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Failed to parse domain: ${message}`);
      webview.postMessage({ type: 'error', payload: { message } });
    }
  }

  /**
   * Detect models in logical.models that lack entries in viewConfig.positions
   * and compute positions for them. Writes positions back to the document via
   * WorkspaceEdit so they persist. Returns true if positions were written.
   */
  private async autoPositionNewModels(
    document: vscode.TextDocument,
    unifiedDomain: { logical: { models: Array<{ name: string }>; relationships: Relationship[] }; viewConfig: { positions?: Record<string, NodePosition> } },
  ): Promise<boolean> {
    const positions = unifiedDomain.viewConfig.positions ?? {};
    const modelNames = unifiedDomain.logical.models.map((m) => m.name);
    const newModels = modelNames.filter((name) => !positions[name]);

    if (newModels.length === 0) return false;

    const computed = computeNewModelPositions({
      newModels,
      relationships: unifiedDomain.logical.relationships ?? [],
      existingPositions: positions,
    });

    if (Object.keys(computed).length === 0) return false;

    // Merge computed positions into document
    const text = document.getText();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
    const existingPos = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
    viewConfig.positions = { ...existingPos, ...computed };
    parsed.viewConfig = viewConfig;

    const updatedText = JSON.stringify(parsed, null, 2) + '\n';
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      document.positionAt(0),
      document.positionAt(text.length),
    );
    edit.replace(document.uri, fullRange, updatedText);

    const docUri = document.uri.toString();
    this.pendingUpdates.set(docUri, true);
    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      try {
        await document.save();
      } finally {
        this.pendingUpdates.delete(docUri);
      }
      return true;
    }

    this.pendingUpdates.delete(docUri);
    return false;
  }

  /**
   * Compare current model list against the previous snapshot and sync domain
   * tags for any models that were added or removed. Handles undo/redo, external
   * edits, and direct mutations uniformly.
   */
  private diffAndSyncTags(
    document: vscode.TextDocument,
    unifiedDomain: { domain: string; logical: { models: Array<{ name: string }> } },
  ): void {
    const docKey = document.uri.toString();
    const domainName = path.basename(document.uri.fsPath, '.json');
    const currentModels = new Set(unifiedDomain.logical.models.map((m) => m.name));
    const previousModels = this.previousModels.get(docKey);

    // Always update the snapshot
    this.previousModels.set(docKey, currentModels);

    // Skip on first load (no previous state to diff against)
    if (!previousModels) {
      return;
    }

    // Models added since last state
    for (const name of currentModels) {
      if (!previousModels.has(name)) {
        void this.schemaTagService.addDomainTag(name, domainName)
          .catch(err => console.warn(`[SemanticEditorProvider] Tag sync failed: ${err}`));
      }
    }

    // Models removed since last state
    for (const name of previousModels) {
      if (!currentModels.has(name)) {
        void this.schemaTagService.removeDomainTag(name, domainName, document.uri.fsPath)
          .catch(err => console.warn(`[SemanticEditorProvider] Tag sync failed: ${err}`));
      }
    }
  }

  /**
   * Refresh all open domain editors with fresh manifest data.
   * Called by extension.ts when manifest changes.
   * Stage-aware: panels viewing physical stage get physical data.
   */
  async refreshAllOpenDomains(): Promise<void> {
    for (const [panelKey, { document, webview, activeStage }] of Array.from(this.openPanels.entries())) {
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
        webview.postMessage({
          type: 'error',
          payload: { message: `Refresh failed: ${message}` },
        });
      }
    }
  }

  /**
   * Refresh all open domain editors that reference a specific model.
   * Called when a logical-models/*.yml file changes externally (e.g., edited
   * from another domain, or modified by an AI tool directly).
   */
  async refreshDomainsReferencingModel(modelName: string): Promise<void> {
    for (const [panelKey, { document, webview }] of Array.from(this.openPanels.entries())) {
      try {
        const text = document.getText();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const section = this.getStageSection(parsed, 'logical');
        const models = (section.models ?? []) as unknown[];

        // Check if this domain references the changed model
        const referencesModel = models.some((m) =>
          typeof m === 'string' ? m === modelName : (m as Record<string, unknown>).name === modelName,
        );

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

        // Create the central model file
        const semanticModel: import('../types/semantic').SemanticModel = {
          name: model.name,
          schema: model.schema,
          description: model.description,
          columns: model.columns,
          ...(model.modelRole ? { modelRole: model.modelRole } : {}),
        };
        this.logicalModelService.saveModel(semanticModel);

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
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add model to domain.' } });
        }
        return;
      }

      // V4: legacy inline path
      const models = (section.models ?? []) as Array<Record<string, unknown>>;

      if (models.some((m) => m.name === model.name)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${model.name}" already exists in this domain.` },
        });
        return;
      }

      models.push({
        name: model.name,
        schema: model.schema,
        description: model.description,
        columns: model.columns,
        ...(model.modelRole ? { modelRole: model.modelRole } : {}),
      });

      section.models = models;

      // Compute position for the new model
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const existingPositions = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
      const relationships = (section.relationships ?? []) as Relationship[];
      const computed = computeNewModelPositions({
        newModels: [model.name],
        relationships,
        existingPositions,
      });
      if (computed[model.name]) {
        viewConfig.positions = { ...existingPositions, ...computed };
        parsed.viewConfig = viewConfig;
      }

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to add model to domain.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add model: ${message}` },
      });
    }
  }

  private validateColumnDef(column: ColumnDef): string | null {
    const trimmedName = column.name?.trim();
    if (!trimmedName) {
      return 'Column name is required';
    }
    if (!/^[a-z0-9_]+$/.test(trimmedName)) {
      return 'Column name must use lowercase letters, numbers, and underscores';
    }
    if (!column.dataType?.trim()) {
      return 'Data type is required';
    }
    return null;
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
        return;
      }

      // V4: legacy inline path
      const section = this.getStageSection(parsed, stage);
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
      if (columns.some((c) => c.name === payload.column.name)) {
        webview.postMessage({ type: 'error', payload: { message: `Column "${payload.column.name}" already exists.` } });
        return;
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

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to add column.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add column failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to add column: ${message}` } });
    }
  }

  private async handleUpdateColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; oldColumnName: string; column: ColumnDef },
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

        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
          if (columnIndex === -1) throw new Error(`Column "${payload.oldColumnName}" not found.`);
          if (columnRenamed && columns.some((c) => c.name === payload.column.name)) {
            throw new Error(`Column "${payload.column.name}" already exists.`);
          }
          const existing = columns[columnIndex];
          columns[columnIndex] = {
            name: payload.column.name,
            dataType: payload.column.dataType,
            description: payload.column.description,
            ...(payload.column.isPrimaryKey ?? existing.isPrimaryKey ? { isPrimaryKey: true } : {}),
            ...(payload.column.isForeignKey ?? existing.isForeignKey ? { isForeignKey: true } : {}),
            ...(payload.column.isNaturalKey ?? existing.isNaturalKey ? { isNaturalKey: true } : {}),
            ...(payload.column.scdType != null ? { scdType: payload.column.scdType } : {}),
            ...(payload.column.additiveType ? { additiveType: payload.column.additiveType } : {}),
          } as ColumnDef;
        }, domainMutator);
        return;
      }

      // V4: legacy inline path
      const section = this.getStageSection(parsed, stage);
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
      const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
      if (columnIndex === -1) {
        webview.postMessage({ type: 'error', payload: { message: `Column "${payload.oldColumnName}" not found.` } });
        return;
      }

      if (payload.oldColumnName !== payload.column.name) {
        if (columns.some((c) => c.name === payload.column.name)) {
          webview.postMessage({ type: 'error', payload: { message: `Column "${payload.column.name}" already exists.` } });
          return;
        }
      }

      const existingPK = columns[columnIndex].isPrimaryKey;
      const existingFK = columns[columnIndex].isForeignKey;
      const existingNK = columns[columnIndex].isNaturalKey;
      const newPK = payload.column.isPrimaryKey ?? existingPK;
      const newFK = payload.column.isForeignKey ?? existingFK;
      const newNK = payload.column.isNaturalKey ?? existingNK;
      columns[columnIndex] = {
        name: payload.column.name,
        dataType: payload.column.dataType,
        description: payload.column.description,
        ...(newPK ? { isPrimaryKey: true } : {}),
        ...(newFK ? { isForeignKey: true } : {}),
        ...(newNK ? { isNaturalKey: true } : {}),
        ...(payload.column.scdType != null ? { scdType: payload.column.scdType } : {}),
        ...(payload.column.additiveType ? { additiveType: payload.column.additiveType } : {}),
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

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to update column.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
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

      // V5: write to central model file
      if (this.isDomainV5(parsed)) {
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const idx = columns.findIndex((c) => c.name === payload.columnName);
          if (idx === -1) throw new Error(`Column "${payload.columnName}" not found.`);
          columns.splice(idx, 1);
        });
        return;
      }

      // V4: legacy inline path
      const section = this.getStageSection(parsed, stage);
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
      const columnIndex = columns.findIndex((c) => c.name === payload.columnName);
      if (columnIndex === -1) {
        webview.postMessage({ type: 'error', payload: { message: `Column "${payload.columnName}" not found.` } });
        return;
      }

      columns.splice(columnIndex, 1);
      model.columns = columns;

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to remove column.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const columns = model.columns ?? [];
          const column = columns.find((c) => c.name === payload.columnName);
          if (!column) throw new Error(`Column "${payload.columnName}" not found.`);
          if (payload.value) {
            (column as unknown as Record<string, unknown>)[fieldName] = true;
          } else {
            delete (column as unknown as Record<string, unknown>)[fieldName];
          }
        });
        return;
      }

      // V4: legacy inline path
      const section = this.getStageSection(parsed, stage);
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      const fieldMap: Record<string, string> = { PK: 'isPrimaryKey', FK: 'isForeignKey', NK: 'isNaturalKey' };
      const fieldName = fieldMap[payload.keyType];
      const columns = (model.columns ?? []) as Array<Record<string, unknown>>;
      const column = columns.find((c) => c.name === payload.columnName);

      if (!column) {
        webview.postMessage({ type: 'error', payload: { message: `Column "${payload.columnName}" not found.` } });
        return;
      }

      if (payload.value) {
        column[fieldName] = true;
      } else {
        delete column[fieldName];
      }

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to toggle key type.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
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
      const trimmedNew = payload.newName.trim();
      if (!trimmedNew) {
        webview.postMessage({ type: 'error', payload: { message: 'Model name cannot be empty.' } });
        return;
      }
      if (!/^[a-z][a-z0-9_]*$/.test(trimmedNew)) {
        webview.postMessage({ type: 'error', payload: { message: 'Model name must start with a letter and use lowercase letters, numbers, and underscores.' } });
        return;
      }
      if (trimmedNew === payload.oldName) {
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const section = this.getStageSection(parsed, stage);

      // V5: rename central model file + update domain references
      if (this.isDomainV5(parsed)) {
        // Rename the model file
        this.logicalModelService.renameModel(payload.oldName, trimmedNew);

        // Update domain: model reference name, relationships, positions
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
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to rename model.' } });
        }
        return;
      }

      // V4: legacy inline path
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const model = models.find((m) => m.name === payload.oldName);
      if (!model) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.oldName}" not found.` } });
        return;
      }
      if (models.some((m) => m.name === trimmedNew)) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${trimmedNew}" already exists in this domain.` } });
        return;
      }

      model.name = trimmedNew;

      const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
      for (const rel of relationships) {
        if (rel.fromModel === payload.oldName) { rel.fromModel = trimmedNew; }
        if (rel.toModel === payload.oldName) { rel.toModel = trimmedNew; }
      }

      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const positions = (viewConfig.positions ?? {}) as Record<string, unknown>;
      if (payload.oldName in positions) {
        positions[trimmedNew] = positions[payload.oldName];
        delete positions[payload.oldName];
      }

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to rename model.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Rename model failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to rename model: ${message}` } });
    }
  }

  private async handleRemoveModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const section = this.getStageSection(parsed, stage);

      // V5: remove reference from domain + ask about deleting model file
      if (this.isDomainV5(parsed)) {
        // Remove reference, relationships, and position from domain
        const success = await this.applyDomainEdit(
          document,
          (sec, p) => {
            const names = (sec.models ?? []) as string[];
            const idx = names.indexOf(payload.modelName);
            if (idx !== -1) names.splice(idx, 1);

            const relationships = (sec.relationships ?? []) as Array<Record<string, unknown>>;
            sec.relationships = relationships.filter(
              (rel) => rel.fromModel !== payload.modelName && rel.toModel !== payload.modelName,
            );

            const vc = (p.viewConfig ?? {}) as Record<string, unknown>;
            const positions = (vc.positions ?? {}) as Record<string, unknown>;
            delete positions[payload.modelName];
          },
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to remove model.' } });
          return;
        }

        // Ask: remove from domain only, or delete model file entirely?
        if (this.logicalModelService.modelExists(payload.modelName)) {
          void vscode.window.showInformationMessage(
            `Model "${payload.modelName}" removed from this domain. Delete the model file entirely?`,
            'Delete Model File',
            'Keep File',
          ).then((choice) => {
            if (choice === 'Delete Model File') {
              this.logicalModelService.deleteModel(payload.modelName);
              vscode.window.showInformationMessage(`Deleted logical-models/${payload.modelName}.yml`);
            }
          });
        }
        return;
      }

      // V4: legacy inline path
      const models = (section.models ?? []) as Array<Record<string, unknown>>;
      const modelIndex = models.findIndex((m) => m.name === payload.modelName);
      if (modelIndex === -1) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      models.splice(modelIndex, 1);
      section.models = models;

      const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
      section.relationships = relationships.filter(
        (rel) => rel.fromModel !== payload.modelName && rel.toModel !== payload.modelName,
      );

      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const positions = (viewConfig.positions ?? {}) as Record<string, unknown>;
      delete positions[payload.modelName];
      viewConfig.positions = positions;
      parsed.viewConfig = viewConfig;

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        try {
          await document.save();
          await this.sendDomainData(document, webview);
        } finally {
          this.pendingUpdates.delete(document.uri.toString());
        }
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to remove model.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove model failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove model: ${message}` } });
    }
  }

  private async handleRemoveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string },
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
          relationships.splice(relIndex, 1);
          section.relationships = relationships;
        },
        { webview, stage },
      );

      if (!success) {
        webview.postMessage({ type: 'error', payload: { message: 'Failed to remove relationship.' } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove relationship failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to remove relationship: ${message}` } });
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

  private async handleUpdatePositions(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    positions: Record<string, { x: number; y: number }>,
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const existingViewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const existingPositions = (existingViewConfig.positions ?? {}) as Record<string, unknown>;
      // Merge incoming positions over disk positions — prevents concurrent tabs from
      // clobbering each other's saves when using the shared global viewConfig.
      const mergedPositions = { ...existingPositions, ...positions };
      parsed.viewConfig = { ...existingViewConfig, positions: mergedPositions };

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to save layout positions.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Position update failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to save positions: ${message}` } });
    }
  }

  private async handleAddExistingModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
    stage: 'logical',
  ): Promise<void> {
    try {
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

        // Ensure the logical model file exists — create from manifest if needed
        if (!this.logicalModelService.modelExists(payload.modelName)) {
          const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
          const created = this.logicalModelService.createFromManifest(payload.modelName, manifest);
          if (!created) {
            webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found in manifest or logical-models/. Run 'dbt compile' to refresh.` } });
            return;
          }
        }

        // Add name reference + position + auto-relationships to domain
        await this.manifestService.loadManifest(this.workspaceRoot);
        const relationshipTests = this.manifestService.getRelationshipTests();

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
          { refreshWebview: true, webview, stage },
        );

        if (!success) {
          webview.postMessage({ type: 'error', payload: { message: 'Failed to add model to domain.' } });
        }
        return;
      }

      // V4: legacy inline path
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const manifestModel = manifest.models.get(payload.modelName);

      if (!manifestModel) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found in manifest. Run 'dbt compile' to refresh.` },
        });
        return;
      }

      const models = (section.models ?? []) as Array<Record<string, unknown>>;

      if (models.some((m) => m.name === payload.modelName)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" already exists in this domain.` },
        });
        return;
      }

      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const existingPositions = (viewConfig.positions ?? {}) as Record<string, NodePosition>;
      const newPosition = findOpenPosition(existingPositions);

      const columns = manifestModel.columns.map((col) => ({
        name: col.name,
        dataType: col.data_type ?? 'unknown',
        description: col.description,
      }));

      models.push({
        name: payload.modelName,
        schema: manifestModel.schema,
        description: manifestModel.description,
        columns,
      });

      const relationships = (section.relationships ?? []) as Array<Record<string, unknown>>;
      const modelNames = new Set(models.map((m) => m.name as string));
      const relationshipTests = this.manifestService.getRelationshipTests();

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
      section.relationships = relationships;

      const updatedPositions = { ...existingPositions, [payload.modelName]: newPosition };
      section.models = models;
      parsed.viewConfig = { ...viewConfig, positions: updatedPositions };
      const updatedText = JSON.stringify(parsed, null, 2) + '\n';

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(text.length));
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdates.set(document.uri.toString(), true);
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        try {
          await document.save();
          await this.sendDomainData(document, webview);
        } finally {
          this.pendingUpdates.delete(document.uri.toString());
        }
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({ type: 'error', payload: { message: 'Failed to add model to domain.' } });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const existing = model.rationale ?? {};
          const patched = { ...existing };
          for (const [key, val] of Object.entries(payload.rationale)) {
            const trimmed = typeof val === 'string' ? val.trim() : undefined;
            if (trimmed) { (patched as Record<string, string | undefined>)[key] = trimmed; } else { delete (patched as Record<string, string | undefined>)[key]; }
          }
          if (Object.keys(patched).length > 0) { model.rationale = patched as Rationale; } else { delete model.rationale; }
        });
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          const grain = payload.grain?.trim() || undefined;
          if (grain) { model.grain = grain; } else { delete model.grain; }
        });
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
        await this.applyModelEdit(document, webview, payload.modelName, (model) => {
          if (payload.modelRole) { model.modelRole = payload.modelRole as import('../types/semantic').ModelRole; } else { delete model.modelRole; }
        });
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
   */
  private async handleSwitchStage(
    panelKey: string,
    document: vscode.TextDocument,
    webview: vscode.Webview,
    targetStage: Stage,
  ): Promise<void> {
    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel) return;

      // Update tracked stage
      panel.activeStage = targetStage;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);

      const unifiedDomain = this.domainService.getDomain(document.uri.fsPath);

      if (targetStage === 'physical') {
        // Physical stage is derived from same unified file's logical section + manifest
        const physicalDomain = this.domainService.buildPhysicalDomain(unifiedDomain, manifest);
        const layerConfig = this.layerService.getLayer(unifiedDomain.layer);
        if (layerConfig) {
          physicalDomain.layerConfig = layerConfig;
        }
        webview.postMessage({ type: 'stageData', payload: physicalDomain });
      } else {
        // Logical — extract from unified file
        const domain = this.domainService.getDomainStage(document.uri.fsPath);
        const displayDomain = this.buildDisplayDomain(domain, manifest, unifiedDomain.viewConfig);
        webview.postMessage({ type: 'stageData', payload: displayDomain });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Stage switch failed: ${message}`);
      webview.postMessage({ type: 'error', payload: { message: `Failed to switch stage: ${message}` } });
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
      webview.postMessage({ type: 'discrepancyReport', payload: null });
      return;
    }

    try {
      const panel = this.openPanels.get(panelKey);
      if (!panel) return;

      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const sourceStage = panel.activeStage;
      const targetStage = payload.compareAgainst;

      // Build source DisplayDomain
      const sourceDomain = await this.buildStageDisplayDomain(
        document, sourceStage, manifest,
      );

      // Build target DisplayDomain
      const targetDomain = await this.buildStageDisplayDomain(
        document, targetStage, manifest,
      );

      const report = compareStages(sourceDomain, targetDomain);

      // Cache the report for sync plan generation
      const panelEntry = this.openPanels.get(panelKey);
      if (panelEntry) {
        panelEntry.lastDiscrepancyReport = report;
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

  /**
   * Build a DisplayDomain for any stage, given the current document as context.
   * For physical, derives from the unified file's logical section + manifest.
   * For logical, extracts the logical section from the unified file.
   */
  private async buildStageDisplayDomain(
    document: vscode.TextDocument,
    stage: Stage,
    manifest: ManifestData,
  ): Promise<DisplayDomain> {
    const unifiedDomain = this.domainService.getDomain(document.uri.fsPath);
    if (stage === 'physical') {
      return this.domainService.buildPhysicalDomain(unifiedDomain, manifest);
    }
    const domain = this.domainService.getDomainStage(document.uri.fsPath);
    return this.buildDisplayDomain(domain, manifest, unifiedDomain.viewConfig);
  }

  // ---------------------------------------------------------------------------
  // Sync reconciliation handlers
  // ---------------------------------------------------------------------------

  /**
   * Check manifest staleness and send the result to the webview.
   */
  private async handleCheckManifestStaleness(webview: vscode.Webview): Promise<void> {
    try {
      const staleness = await checkManifestStaleness(this.workspaceRoot);
      webview.postMessage({ type: 'manifestStaleness', payload: staleness });
    } catch (err) {
      console.error('[SemanticEditorProvider] Staleness check failed:', err);
    }
  }

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
      const semanticDir = vscode.workspace
        .getConfiguration('dbtSemantic')
        .get<string>('semanticDir', 'erd-studio');

      // Build resolutions from selections
      const models: ModelResolution[] = [];
      const columns: ColumnResolution[] = [];
      const relationships: RelationshipResolution[] = [];
      const referencedModels = new Set<string>();

      for (const [key, groundTruth] of Object.entries(selections)) {
        const parts = key.split(':');
        const kind = parts[0];

        if (kind === 'model') {
          const modelName = parts[1];
          const disc = report.models.find((m) => m.name === modelName);
          if (!disc || disc.status === 'matched') continue;

          const action = deriveModelAction(disc.status, groundTruth, report.sourceStage);
          if (!action) continue;

          models.push({
            modelName,
            discrepancyStatus: disc.status,
            groundTruth,
            action,
          });
          referencedModels.add(modelName);
        } else if (kind === 'col') {
          const modelName = parts[1];
          const columnName = parts.slice(2).join(':'); // column name may contain colons
          const modelDisc = report.models.find((m) => m.name === modelName);
          const colDisc = modelDisc?.columns.find((c) => c.name === columnName);
          if (!colDisc || colDisc.status === 'matched') continue;

          const action = deriveColumnAction(colDisc.status, groundTruth, report.sourceStage);
          if (!action) continue;

          columns.push({
            modelName,
            columnName,
            discrepancyStatus: colDisc.status,
            groundTruth,
            action,
            sourceDataType: colDisc.sourceDataType,
            targetDataType: colDisc.targetDataType,
          });
          referencedModels.add(modelName);
        } else if (kind === 'rel') {
          const [, fromModel, fromColumn, toModel, toColumn] = parts;
          const relDisc = report.relationships.find(
            (r) =>
              r.fromModel === fromModel &&
              r.fromColumn === fromColumn &&
              r.toModel === toModel &&
              r.toColumn === toColumn,
          );
          if (!relDisc || relDisc.status === 'matched') continue;

          const action = deriveRelationshipAction(relDisc.status, groundTruth, report.sourceStage);
          if (!action) continue;

          relationships.push({
            fromModel,
            fromColumn,
            toModel,
            toColumn,
            discrepancyStatus: relDisc.status,
            groundTruth,
            action,
            sourceCardinality: relDisc.sourceCardinality,
            targetCardinality: relDisc.targetCardinality,
          });
          referencedModels.add(fromModel);
          referencedModels.add(toModel);
        }
      }

      const totalActions = models.length + columns.length + relationships.length;
      if (totalActions === 0) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'No actionable resolutions selected.' },
        });
        return;
      }

      // Build model context with file paths
      const modelContext: Record<string, ModelContext> = {};
      for (const modelName of referencedModels) {
        const manifestModel = manifest.models.get(modelName);
        let dbtSqlPath: string | null = null;
        let dbtSchemaPath: string | null = null;

        if (manifestModel?.originalFilePath) {
          dbtSqlPath = manifestModel.originalFilePath;
          // Heuristic: schema YAML is next to the SQL file with .yml extension
          dbtSchemaPath = dbtSqlPath.replace(/\.sql$/, '.yml');
        }

        modelContext[modelName] = {
          modelName,
          logicalModelPath: path.join(semanticDir, 'logical-models', `${modelName}.yml`),
          dbtSqlPath,
          dbtSchemaPath,
        };
      }

      // Determine if compile is needed (any physical-side action)
      const physicalActions = [
        'add-to-physical', 'remove-from-physical',
        'add-column-to-physical', 'remove-column-from-physical',
        'update-type-in-physical',
        'add-relationship-test-to-physical', 'remove-relationship-test-from-physical',
        'update-cardinality-in-physical',
      ];
      const allActions = [
        ...models.map((m) => m.action),
        ...columns.map((c) => c.action),
        ...relationships.map((r) => r.action),
      ];
      const requiresCompile = allActions.some((a) => physicalActions.includes(a));

      // Parse domain info from the document
      const parsed = JSON.parse(document.getText());

      const syncPlan: SyncPlan = {
        generatedAt: new Date().toISOString(),
        domain: parsed.domain ?? '',
        layer: parsed.layer ?? '',
        sourceStage: report.sourceStage,
        targetStage: report.targetStage,
        modelContext,
        models,
        columns,
        relationships,
        requiresCompile,
      };

      // Write to disk
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
    terminal.sendText('dbt compile');
  }

  /**
   * Launch Claude Code in a terminal to execute the sync plan.
   * Uses --dangerously-skip-permissions so file edits proceed without prompts.
   */
  private async handleLaunchClaudeSync(): Promise<void> {
    const semanticDir = vscode.workspace
      .getConfiguration('dbtSemantic')
      .get<string>('semanticDir', 'erd-studio');
    const planPath = `${semanticDir}/.sync-plan.json`;
    const prompt = `Execute the erd-studio sync plan at ${planPath} using the erd-studio skill. Read .claude/skills/erd-studio/SYNC.md for the action reference and follow the execution steps.`;

    const terminal = vscode.window.createTerminal({
      name: 'ERD Studio Sync',
      cwd: this.workspaceRoot,
    });
    terminal.show();
    // Launch the TUI, then send the prompt as user input
    terminal.sendText('claude --dangerously-skip-permissions');
    // Small delay to let the TUI initialize before sending the prompt
    setTimeout(() => terminal.sendText(prompt), 2000);
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
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
