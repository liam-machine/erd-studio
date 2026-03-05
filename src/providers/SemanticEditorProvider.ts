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
import * as vscode from 'vscode';

import * as path from 'path';

import { DomainService } from '../services/domainService';
import { compare as compareStages } from '../services/discrepancyService';
import { ManifestService } from '../services/manifestService';
import { TemplateService } from '../services/templateService';
import { LayerService } from '../services/layerService';
import type { ManifestData } from '../types/manifest';
import type { DisplayDomain } from '../types/display';
import type { Rationale, Cardinality, ColumnDef, DesignModel, Stage } from '../types/semantic';

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
   * Track all open webview panels by document URI.
   * Used by refreshAllOpenDomains() to update all editors when manifest changes.
   * activeStage tracks which stage the webview is currently displaying.
   */
  private readonly openPanels = new Map<
    string,
    { document: vscode.TextDocument; webview: vscode.Webview; activeStage: Stage }
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly templateService: TemplateService,
    private readonly layerService: LayerService,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Build supplementary payload data for webview messages.
   * Includes templates and list of manifest models not in the domain.
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
  } {
    const templates = this.templateService.loadTemplates(this.workspaceRoot);
    const existingModelNames = new Set(domain.models.map((m) => m.name));

    let filteredModels = Array.from(manifest.models.values()).filter(
      (m) => !existingModelNames.has(m.name),
    );

    // Apply folder filter if configured (prefix match)
    if (modelFolder) {
      const folderPrefix = modelFolder.endsWith('/') ? modelFolder : `${modelFolder}/`;
      filteredModels = filteredModels.filter(
        (m) => m.originalFilePath && m.originalFilePath.startsWith(folderPrefix),
      );
    }

    const manifestModels = filteredModels
      .map((m) => ({
        name: m.name,
        schema: m.schema,
        description: m.description,
        columnCount: m.columns.length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { templates, manifestModels };
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

    // Track this panel — infer initial stage from the file path
    const panelKey = document.uri.toString();
    const initialStage = this.inferStageFromPath(document.uri.fsPath);
    this.openPanels.set(panelKey, { document, webview: webviewPanel.webview, activeStage: initialStage });

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
          'refreshManifest', 'undo', 'redo', 'updateViewConfig',
        ]);
        if (panel?.activeStage === 'physical' && !NON_MUTATION_TYPES.has(message.type)) {
          return;
        }

        switch (message.type) {
          case 'ready':
            await this.sendDomainData(document, webviewPanel.webview);
            break;
          case 'updatePositions': {
            const payload = (message as Record<string, unknown>).payload as
              | { positions: Record<string, { x: number; y: number }> }
              | undefined;
            if (payload?.positions) {
              await this.handleUpdatePositions(
                document,
                webviewPanel.webview,
                payload.positions,
              );
            }
            break;
          }
          case 'addModel': {
            const payload = (message as { payload?: DesignModel }).payload;
            if (payload) {
              await this.handleAddModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'addColumn': {
            const payload = (message as { payload?: { modelName: string; column: ColumnDef } }).payload;
            if (payload) {
              await this.handleAddColumn(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'updateColumn': {
            const payload = (message as { payload?: { modelName: string; oldColumnName: string; column: ColumnDef } }).payload;
            if (payload) {
              await this.handleUpdateColumn(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'removeColumn': {
            const payload = (message as { payload?: { modelName: string; columnName: string } }).payload;
            if (payload) {
              await this.handleRemoveColumn(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'toggleColumnKey': {
            const payload = (message as { payload?: { modelName: string; columnName: string; keyType: 'PK' | 'FK' | 'NK'; value: boolean } }).payload;
            if (payload) {
              await this.handleToggleColumnKey(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'addRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              await this.handleAddRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'renameModel': {
            const payload = (message as { payload?: { oldName: string; newName: string } }).payload;
            if (payload) {
              await this.handleRenameModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'removeModel': {
            const payload = (message as { payload?: { modelName: string } }).payload;
            if (payload) {
              await this.handleRemoveModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'removeRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string } }).payload;
            if (payload) {
              await this.handleRemoveRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'updateRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              await this.handleUpdateRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'editRelationship': {
            const payload = (message as { payload?: { originalFromModel: string; originalFromColumn: string; originalToModel: string; originalToColumn: string; fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              await this.handleEditRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'addExistingModel': {
            const payload = (message as { payload?: { modelName: string } }).payload;
            if (payload) {
              await this.handleAddExistingModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'refreshManifest': {
            await vscode.commands.executeCommand('dbtSemantic.refreshManifest');
            break;
          }
          case 'undo': {
            await vscode.commands.executeCommand('undo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview);
            break;
          }
          case 'redo': {
            await vscode.commands.executeCommand('redo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview);
            break;
          }
          case 'updateModelRationale': {
            const payload = (message as { payload?: { modelName: string; rationale: Rationale } }).payload;
            if (payload) {
              await this.handleUpdateModelRationale(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'updateModelGrain': {
            const payload = (message as { payload?: { modelName: string; grain: string } }).payload;
            if (payload) {
              await this.handleUpdateModelGrain(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'updateModelRole': {
            const payload = (message as { payload?: { modelName: string; modelRole: string | null } }).payload;
            if (payload) {
              await this.handleUpdateModelRole(document, webviewPanel.webview, payload);
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
      await this.sendDomainData(document, webviewPanel.webview);
    });

    webviewPanel.onDidDispose(() => {
      messageSubscription.dispose();
      changeSubscription.dispose();
      this.openPanels.delete(panelKey);
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Generic helper to apply a mutation to the domain JSON and persist it.
   * Handles the common WorkspaceEdit pattern used by all mutation handlers.
   */
  private async applyDomainEdit(
    document: vscode.TextDocument,
    mutator: (parsed: Record<string, unknown>) => void,
    options: { refreshWebview?: boolean; webview?: vscode.Webview } = {},
  ): Promise<boolean> {
    const { refreshWebview = true, webview } = options;
    const panelKey = document.uri.toString();

    const text = document.getText();
    const parsed = JSON.parse(text) as Record<string, unknown>;

    mutator(parsed);

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
   */
  private buildDisplayDomain(
    domain: import('../types/semantic').SemanticDomain,
    manifest: ManifestData,
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

    const { templates, manifestModels } = this.buildWebviewPayload(
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
      viewConfig: domain.viewConfig,
      templates,
      manifestModels,
      layerConfig,
      readOnly: domain.stage === 'physical',
    };
  }

  /**
   * Parse the document, build display domain, and send to webview.
   * On parse failure, sends an error message instead.
   */
  private async sendDomainData(
    document: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    try {
      const domain = this.domainService.getDomain(document.uri.fsPath);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const displayDomain = this.buildDisplayDomain(domain, manifest);

      webview.postMessage({
        type: 'domainLoaded',
        payload: displayDomain,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Failed to parse domain: ${message}`);
      webview.postMessage({ type: 'error', payload: { message } });
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
          // Re-derive physical from logical + manifest
          await this.handleSwitchStage(panelKey, document, webview, 'physical');
        } else {
          await this.sendDomainData(document, webview);
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

  // -------------------------------------------------------------------------
  // Mutation handlers
  // -------------------------------------------------------------------------

  private async handleAddModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    model: DesignModel,
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;

      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

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

      parsed.models = models;
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
  ): Promise<void> {
    try {
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({ type: 'error', payload: { message: validationError } });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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
  ): Promise<void> {
    try {
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({ type: 'error', payload: { message: validationError } });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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

  private async handleAddRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
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
          parsed.relationships = relationships;
        },
        { webview },
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
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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

      // Cascade: update relationship references
      const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
      for (const rel of relationships) {
        if (rel.fromModel === payload.oldName) { rel.fromModel = trimmedNew; }
        if (rel.toModel === payload.oldName) { rel.toModel = trimmedNew; }
      }

      // Cascade: update viewConfig positions
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
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
      const modelIndex = models.findIndex((m) => m.name === payload.modelName);
      if (modelIndex === -1) {
        webview.postMessage({ type: 'error', payload: { message: `Model "${payload.modelName}" not found.` } });
        return;
      }

      models.splice(modelIndex, 1);
      parsed.models = models;

      // Cascade: remove relationships involving this model
      const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
      parsed.relationships = relationships.filter(
        (rel) => rel.fromModel !== payload.modelName && rel.toModel !== payload.modelName,
      );

      // Remove positions for deleted model
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
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
          parsed.relationships = relationships;
        },
        { webview },
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
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
        { webview },
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
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
        { webview },
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
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      parsed.viewConfig = { ...viewConfig, positions };

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
  ): Promise<void> {
    try {
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const manifestModel = manifest.models.get(payload.modelName);

      if (!manifestModel) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found in manifest. Run 'dbt compile' to refresh.` },
        });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

      if (models.some((m) => m.name === payload.modelName)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" already exists in this domain.` },
        });
        return;
      }

      // Find open position
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const existingPositions = (viewConfig.positions ?? {}) as Record<string, { x: number; y: number }>;
      const newPosition = this.findOpenPosition(existingPositions);

      // Add model with columns from manifest
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

      // Auto-create relationships from manifest tests
      const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
      const modelNames = new Set(models.map((m) => m.name as string));
      const relationshipTests = this.manifestService.getRelationshipTests();

      for (const test of relationshipTests) {
        if (test.fromModel !== payload.modelName && test.toModel !== payload.modelName) {
          continue;
        }
        if (!modelNames.has(test.fromModel) || !modelNames.has(test.toModel)) {
          continue;
        }
        const alreadyExists = relationships.some(
          (r) =>
            r.fromModel === test.fromModel &&
            r.fromColumn === test.fromColumn &&
            r.toModel === test.toModel &&
            r.toColumn === test.toColumn,
        );
        if (!alreadyExists) {
          relationships.push({
            fromModel: test.fromModel,
            fromColumn: test.fromColumn,
            toModel: test.toModel,
            toColumn: test.toColumn,
            cardinality: 'many-to-one' as const,
          });
        }
      }
      parsed.relationships = relationships;

      const updatedPositions = { ...existingPositions, [payload.modelName]: newPosition };
      parsed.models = models;
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
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
        { webview },
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

          const grain = payload.grain?.trim() || undefined;
          if (grain) { model.grain = grain; } else { delete model.grain; }
        },
        { webview },
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
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);
          if (!model) { throw new Error(`Model "${payload.modelName}" not found.`); }

          if (payload.modelRole) { model.modelRole = payload.modelRole; } else { delete model.modelRole; }
        },
        { webview },
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
  // Utility methods
  // -------------------------------------------------------------------------

  private findOpenPosition(
    existingPositions: Record<string, { x: number; y: number }>,
  ): { x: number; y: number } {
    const NODE_WIDTH = 280;
    const NODE_HEIGHT = 200;
    const PADDING = 40;
    const CELL_WIDTH = NODE_WIDTH + PADDING;
    const CELL_HEIGHT = NODE_HEIGHT + PADDING;

    if (Object.keys(existingPositions).length === 0) {
      return { x: 100, y: 100 };
    }

    const positions = Object.values(existingPositions);
    const maxX = Math.max(...positions.map((p) => p.x), 0);

    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 10; col++) {
        const candidate = { x: col * CELL_WIDTH + 100, y: row * CELL_HEIGHT + 100 };
        const isOverlapping = positions.some((existing) => {
          const dx = Math.abs(candidate.x - existing.x);
          const dy = Math.abs(candidate.y - existing.y);
          return dx < CELL_WIDTH && dy < CELL_HEIGHT;
        });
        if (!isOverlapping) {
          return candidate;
        }
      }
    }

    return { x: maxX + CELL_WIDTH, y: 100 };
  }

  // -------------------------------------------------------------------------
  // Stage switching & discrepancy
  // -------------------------------------------------------------------------

  /**
   * Infer the stage from a file path.
   * Path pattern: erd-studio/{stage}/{layer}/{domain}.json
   */
  private inferStageFromPath(filePath: string): Stage {
    const grandparent = path.basename(path.dirname(path.dirname(filePath)));
    if (grandparent === 'logical') return 'logical';
    if (grandparent === 'physical') return 'physical';
    return 'conceptual';
  }

  /**
   * Get the domain name and layer from the currently open document.
   * Infers from path: erd-studio/{stage}/{layer}/{domain}.json
   */
  private parseDomainPath(filePath: string): { domainName: string; layer: string } {
    return {
      domainName: path.basename(filePath, '.json'),
      layer: path.basename(path.dirname(filePath)),
    };
  }

  /**
   * Resolve the file path for a sibling domain at a different stage.
   * E.g., switching from conceptual/silver/orders.json → logical/silver/orders.json
   */
  private resolveSiblingPath(currentFilePath: string, targetStage: Stage): string {
    const { domainName, layer } = this.parseDomainPath(currentFilePath);
    const config = vscode.workspace.getConfiguration('dbtSemantic');
    const semanticDir = config.get<string>('semanticDir', 'erd-studio');
    return path.join(this.workspaceRoot, semanticDir, targetStage, layer, `${domainName}.json`);
  }

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

      if (targetStage === 'physical') {
        // Physical stage is derived from logical domain + manifest
        const logicalPath = this.resolveSiblingPath(document.uri.fsPath, 'logical');
        const logicalDomain = this.domainService.getDomain(logicalPath);
        const physicalDomain = this.domainService.buildPhysicalDomain(logicalDomain, manifest);
        const layerConfig = this.layerService.getLayer(logicalDomain.layer);
        if (layerConfig) {
          physicalDomain.layerConfig = layerConfig;
        }
        webview.postMessage({ type: 'stageData', payload: physicalDomain });
      } else {
        // Conceptual or logical — read from disk
        const siblingPath = this.resolveSiblingPath(document.uri.fsPath, targetStage);
        const domain = this.domainService.getDomain(siblingPath);
        const displayDomain = this.buildDisplayDomain(domain, manifest);
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
      webview.postMessage({ type: 'discrepancyReport', payload: report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Discrepancy comparison failed: ${message}`);
      webview.postMessage({ type: 'discrepancyReport', payload: null });
    }
  }

  /**
   * Build a DisplayDomain for any stage, given the current document as context.
   * For physical, derives from logical domain + manifest.
   * For conceptual/logical, reads the sibling file from disk.
   */
  private async buildStageDisplayDomain(
    document: vscode.TextDocument,
    stage: Stage,
    manifest: ManifestData,
  ): Promise<DisplayDomain> {
    if (stage === 'physical') {
      const logicalPath = this.resolveSiblingPath(document.uri.fsPath, 'logical');
      const logicalDomain = this.domainService.getDomain(logicalPath);
      return this.domainService.buildPhysicalDomain(logicalDomain, manifest);
    }
    const filePath = this.resolveSiblingPath(document.uri.fsPath, stage);
    const domain = this.domainService.getDomain(filePath);
    return this.buildDisplayDomain(domain, manifest);
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
