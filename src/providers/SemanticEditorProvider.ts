/**
 * SemanticEditorProvider — CustomTextEditorProvider for semantic domain JSON files.
 *
 * Opens semantic JSON files in a React webview instead of the default JSON editor.
 * VS Code manages save/dirty state for the underlying text document.
 *
 * Message protocol:
 *   Webview → Extension:  { type: "ready" }
 *   Extension → Webview:  { type: "domainLoaded", payload: ReconciledDomain }
 *   Extension → Webview:  { type: "error", payload: { message: string } }
 *
 * Update loop prevention:
 *   When writing via WorkspaceEdit, a pendingUpdate flag is set to avoid
 *   re-sending the update triggered by onDidChangeTextDocument.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { DomainService } from '../services/domainService';
import { ManifestService } from '../services/manifestService';
import { ReconciliationService } from '../services/reconciliationService';
import { TemplateService } from '../services/templateService';
import { AutoReconciliationService } from '../services/autoReconciliationService';
import { LayerService } from '../services/layerService';
import { SchemaTagService } from '../services/schemaTagService';
import type { ManifestData } from '../types/manifest';
import type { Cardinality, ColumnDef, DesignModel } from '../types/semantic';

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
   * Guard flag to prevent concurrent reconciliation operations.
   * Only one refresh/reconcile operation should run at a time to avoid
   * race conditions between manual refresh (F305) and file watcher (F304).
   */
  private reconciliationInProgress = false;

  /**
   * Track all open webview panels by document URI.
   * Used by reconcileAllOpenDomains() to update all editors when manifest changes.
   */
  private readonly openPanels = new Map<
    string,
    { document: vscode.TextDocument; webview: vscode.Webview }
  >();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly reconciliationService: ReconciliationService,
    private readonly templateService: TemplateService,
    private readonly autoReconciliationService: AutoReconciliationService,
    private readonly layerService: LayerService,
    private readonly schemaTagService: SchemaTagService,
    private readonly workspaceRoot: string,
  ) {}

  /**
   * Build supplementary payload data for webview messages.
   * Includes templates and list of manifest models not in the domain.
   *
   * @param reconciled - Reconciled domain data with existing models
   * @param manifest - Loaded manifest data
   * @param modelFolder - Optional folder filter (e.g., "models/silver")
   */
  private buildWebviewPayload(
    reconciled: { models: Array<{ name: string }> },
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
    const existingModelNames = new Set(reconciled.models.map((m) => m.name));

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

    // Track this panel for auto-reconciliation (F304)
    const panelKey = document.uri.toString();
    this.openPanels.set(panelKey, { document, webview: webviewPanel.webview });

    // --- Subscriptions (disposed when the panel closes) ---------------------

    const messageSubscription = webviewPanel.webview.onDidReceiveMessage(
      async (message: unknown) => {
        if (!isTypedMessage(message)) {
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
            // Trigger the refresh manifest command (F305)
            // This runs the full refresh flow with progress notification
            await vscode.commands.executeCommand('dbtSemantic.refreshManifest');
            break;
          }
          case 'undo': {
            // Execute VS Code's native undo command, then save and refresh
            await vscode.commands.executeCommand('undo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview);
            break;
          }
          case 'redo': {
            // Execute VS Code's native redo command, then save and refresh
            await vscode.commands.executeCommand('redo');
            await document.save();
            await this.sendDomainData(document, webviewPanel.webview);
            break;
          }
          case 'approveModel': {
            const payload = (message as { payload?: { modelName: string } }).payload;
            if (payload) {
              await this.handleApproveModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'unapproveModel': {
            const payload = (message as { payload?: { modelName: string } }).payload;
            if (payload) {
              await this.handleUnapproveModel(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'approveColumn': {
            const payload = (message as { payload?: { modelName: string; columnName: string } }).payload;
            if (payload) {
              await this.handleApproveColumn(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'unapproveColumn': {
            const payload = (message as { payload?: { modelName: string; columnName: string } }).payload;
            if (payload) {
              await this.handleUnapproveColumn(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'approveRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string } }).payload;
            if (payload) {
              await this.handleApproveRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          case 'unapproveRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string } }).payload;
            if (payload) {
              await this.handleUnapproveRelationship(document, webviewPanel.webview, payload);
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
      // Save the document before sending data to webview.
      // This ensures changes from keyboard undo/redo (Ctrl+Z/Ctrl+Shift+Z)
      // are persisted to disk before we read and send to the webview.
      // Without this, sendDomainData reads from disk (old state) while
      // the undone content only exists in VS Code's in-memory document.
      if (document.isDirty) {
        await document.save();
      }
      await this.sendDomainData(document, webviewPanel.webview);
    });

    // Note: no onDidChangeViewState handler here. When the webview becomes
    // visible after being hidden, VS Code re-creates the DOM and re-runs
    // scripts. The React app re-mounts and sends a fresh "ready" message,
    // which triggers sendDomainData above. Sending data eagerly on
    // viewState change would race with React mounting.

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
   *
   * @param document - The VS Code text document to edit
   * @param mutator - Function that mutates the parsed JSON object
   * @param options.refreshWebview - If true (default), calls sendDomainData after save
   * @returns true if the edit was applied successfully, false otherwise
   * @throws Error if mutation throws (caller should catch and report to webview)
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

    // Apply the mutation
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
   * Parse the document, reconcile with manifest, and send to webview.
   * On parse failure, sends an error message instead.
   */
  private async sendDomainData(
    document: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    try {
      const domain = this.domainService.getDomain(document.uri.fsPath);
      const manifest = await this.manifestService.loadManifest(this.workspaceRoot);
      const reconciled = this.reconciliationService.reconcile(domain, manifest);
      const { templates, manifestModels } = this.buildWebviewPayload(
        reconciled,
        manifest,
        domain.modelFolder,
      );

      // Get layer config for dynamic badge colors and labels
      const layerConfig = this.layerService.getLayer(domain.layer);

      webview.postMessage({
        type: 'domainLoaded',
        payload: { ...reconciled, templates, manifestModels, layerConfig },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Failed to parse domain: ${message}`);
      webview.postMessage({ type: 'error', payload: { message } });
    }
  }

  /**
   * Refresh all open domain editors with fresh manifest data without auto-transitioning.
   * Called by extension.ts when user manually refreshes manifest and autoReconcile is disabled.
   *
   * Simply re-sends domain data to each open webview to reflect updated manifest state.
   *
   * @returns Promise that resolves when all open domains have been refreshed
   */
  async refreshAllOpenDomains(): Promise<void> {
    if (this.reconciliationInProgress) {
      console.warn('[SemanticEditorProvider] Reconciliation already in progress, skipping refresh');
      return;
    }

    this.reconciliationInProgress = true;
    try {
      for (const { document, webview } of Array.from(this.openPanels.values())) {
        try {
          await this.sendDomainData(document, webview);
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
    } finally {
      this.reconciliationInProgress = false;
    }
  }

  /**
   * Reconcile all open domain editors against fresh manifest.
   * Called by extension.ts when manifest changes (F304) or manual refresh (F305).
   *
   * For each open editor:
   * - Detects design models that now exist in manifest
   * - Transitions them: source 'design' → 'built', moves unbuilt columns to plannedColumns
   * - Persists changes via WorkspaceEdit
   * - Sends manifestRefreshed message to webview with newlyBuiltModels list
   *
   * @param manifest - Fresh manifest data to reconcile against
   * @returns Array of all newly built model names across all domains
   */
  async reconcileAllOpenDomains(manifest: ManifestData): Promise<string[]> {
    if (this.reconciliationInProgress) {
      console.warn('[SemanticEditorProvider] Reconciliation already in progress, skipping');
      return [];
    }

    this.reconciliationInProgress = true;
    const allNewlyBuilt: string[] = [];

    try {
      for (const { document, webview } of Array.from(this.openPanels.values())) {
        try {
          // Parse current domain from disk
          const domain = this.domainService.getDomain(document.uri.fsPath);

          // Detect and execute transitions
          const result = this.autoReconciliationService.reconcileDomain(
            domain,
            manifest,
          );

          if (!result.transitioned) {
            // No transitions - just refresh with new manifest data
            await this.sendDomainData(document, webview);
            continue;
          }

          // Persist transitioned domain to disk via WorkspaceEdit
          const updatedText = JSON.stringify(domain, null, 2) + '\n';
          const edit = new vscode.WorkspaceEdit();
          const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length),
          );
          edit.replace(document.uri, fullRange, updatedText);

          this.pendingUpdates.set(document.uri.toString(), true);
          const success = await vscode.workspace.applyEdit(edit);

          if (success) {
            try {
              await document.save();

              // Add domain tags to schema.yml for newly built models
              const domainName = typeof domain.domain === 'string' ? domain.domain : undefined;
              if (domainName && result.newlyBuiltModels.length > 0) {
                for (const modelName of result.newlyBuiltModels) {
                  const tagEdit = await this.schemaTagService.addDomainTag(
                    modelName,
                    domainName,
                    this.workspaceRoot,
                  );
                  if (tagEdit) {
                    await vscode.workspace.applyEdit(tagEdit);
                  }
                }
                await vscode.workspace.saveAll(false);
              }

              // Build payload for manifestRefreshed message
              const reconciled = this.reconciliationService.reconcile(
                domain,
                manifest,
              );
              const { templates, manifestModels } = this.buildWebviewPayload(
                reconciled,
                manifest,
                domain.modelFolder,
              );

              // Send manifestRefreshed message with newly built list
              webview.postMessage({
                type: 'manifestRefreshed',
                payload: {
                  domain: { ...reconciled, templates, manifestModels },
                  newlyBuiltModels: result.newlyBuiltModels,
                  newlyBuiltRelationships: result.newlyBuiltRelationships,
                },
              });

              allNewlyBuilt.push(...result.newlyBuiltModels);
              allNewlyBuilt.push(
                ...result.newlyBuiltRelationships.map(
                  (r) => `${r.fromModel}.${r.fromColumn}→${r.toModel}.${r.toColumn}`,
                ),
              );
            } finally {
              this.pendingUpdates.delete(document.uri.toString());
            }
          } else {
            this.pendingUpdates.delete(document.uri.toString());
            console.error(
              '[SemanticEditorProvider] Failed to apply auto-reconciliation edit',
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[SemanticEditorProvider] Auto-reconciliation failed for ${document.uri.fsPath}: ${message}`,
          );
          webview.postMessage({
            type: 'error',
            payload: { message: `Auto-reconciliation failed: ${message}` },
          });
        }
      }
    } finally {
      this.reconciliationInProgress = false;
    }

    return allNewlyBuilt;
  }

  /**
   * Handle an `addModel` message from the webview.
   *
   * Adds a new design model to the domain's models array and writes back via
   * WorkspaceEdit (integrates with VS Code undo/redo).
   */
  private async handleAddModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    model: DesignModel,
  ): Promise<void> {
    try {
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;

      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

      // Check for duplicate model name
      if (models.some((m) => m.name === model.name)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${model.name}" already exists in this domain.` },
        });
        return;
      }

      // Add the new design model
      models.push({
        name: model.name,
        source: 'design',
        schema: model.schema,
        description: model.description,
        columns: model.columns,
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
        // Save the document so getDomain reads the updated content from disk
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        // Send updated domain data to refresh the canvas
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

  /**
   * Validate a column definition. Returns error message or null if valid.
   */
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

  /**
   * Handle an `addColumn` message from the webview.
   *
   * Adds a new column to the model's columns (design models) or
   * plannedColumns (repo models) array.
   */
  private async handleAddColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; column: ColumnDef },
  ): Promise<void> {
    try {
      // Validate column definition
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({
          type: 'error',
          payload: { message: validationError },
        });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found.` },
        });
        return;
      }

      // Determine which array to add to based on model source
      const isDesignModel = model.source === 'design';
      const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
      const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

      // Check for duplicate column name
      if (columns.some((c) => c.name === payload.column.name)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Column "${payload.column.name}" already exists.` },
        });
        return;
      }

      // Add the new column
      // Note: New columns start without approval even if model is approved
      // The user must explicitly approve new columns
      columns.push({
        name: payload.column.name,
        dataType: payload.column.dataType,
        description: payload.column.description,
        ...(payload.column.isPrimaryKey ? { isPrimaryKey: true } : {}),
        ...(payload.column.isForeignKey ? { isForeignKey: true } : {}),
        ...(payload.column.isNaturalKey ? { isNaturalKey: true } : {}),
        ...(payload.column.approved ? { approved: true } : {}),
      });
      model[targetArray] = columns;

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
          payload: { message: 'Failed to add column.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add column: ${message}` },
      });
    }
  }

  /**
   * Handle an `updateColumn` message from the webview.
   *
   * Updates an existing column in the model's columns (design models) or
   * plannedColumns (repo models) array.
   */
  private async handleUpdateColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; oldColumnName: string; column: ColumnDef },
  ): Promise<void> {
    try {
      // Validate column definition
      const validationError = this.validateColumnDef(payload.column);
      if (validationError) {
        webview.postMessage({
          type: 'error',
          payload: { message: validationError },
        });
        return;
      }

      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

      const model = models.find((m) => m.name === payload.modelName);
      if (!model) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found.` },
        });
        return;
      }

      // Determine which array to update based on model source
      const isDesignModel = model.source === 'design';
      const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
      const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

      const columnIndex = columns.findIndex((c) => c.name === payload.oldColumnName);
      if (columnIndex === -1) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Column "${payload.oldColumnName}" not found.` },
        });
        return;
      }

      // Check for duplicate name (if name changed)
      if (payload.oldColumnName !== payload.column.name) {
        if (columns.some((c) => c.name === payload.column.name)) {
          webview.postMessage({
            type: 'error',
            payload: { message: `Column "${payload.column.name}" already exists.` },
          });
          return;
        }
      }

      // Update the column — preserve existing key and approval state unless explicitly changed
      const existingPK = columns[columnIndex].isPrimaryKey;
      const existingFK = columns[columnIndex].isForeignKey;
      const existingNK = columns[columnIndex].isNaturalKey;
      const existingApproved = columns[columnIndex].approved;
      const newPK = payload.column.isPrimaryKey ?? existingPK;
      const newFK = payload.column.isForeignKey ?? existingFK;
      const newNK = payload.column.isNaturalKey ?? existingNK;
      const newApproved = payload.column.approved ?? existingApproved;
      columns[columnIndex] = {
        name: payload.column.name,
        dataType: payload.column.dataType,
        description: payload.column.description,
        ...(newPK ? { isPrimaryKey: true } : {}),
        ...(newFK ? { isForeignKey: true } : {}),
        ...(newNK ? { isNaturalKey: true } : {}),
        ...(newApproved ? { approved: true } : {}),
      };

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
          payload: { message: 'Failed to update column.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to update column: ${message}` },
      });
    }
  }

  /**
   * Handle a `removeColumn` message from the webview.
   *
   * Removes a column from the model's columns (design models) or
   * plannedColumns (repo models) array.
   */
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
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found.` },
        });
        return;
      }

      // Determine which array to remove from based on model source
      const isDesignModel = model.source === 'design';
      const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
      const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

      const columnIndex = columns.findIndex((c) => c.name === payload.columnName);
      if (columnIndex === -1) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Column "${payload.columnName}" not found.` },
        });
        return;
      }

      // Remove the column
      columns.splice(columnIndex, 1);
      model[targetArray] = columns;

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
          payload: { message: 'Failed to remove column.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to remove column: ${message}` },
      });
    }
  }

  /**
   * Handle a `toggleColumnKey` message from the webview.
   *
   * Toggles PK/FK/NK flags on a column. For built columns, the key type
   * override is stored in plannedColumns with the same name as the manifest column.
   */
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
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found.` },
        });
        return;
      }

      // Map key type to field name
      const fieldMap: Record<string, string> = {
        PK: 'isPrimaryKey',
        FK: 'isForeignKey',
        NK: 'isNaturalKey',
      };
      const fieldName = fieldMap[payload.keyType];

      // Determine which array to update based on model source
      const isDesignModel = model.source === 'design';
      const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
      const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

      let column = columns.find((c) => c.name === payload.columnName);

      // For built columns on repo models, we need to create a plannedColumns entry
      // to store the key type override
      if (!column && !isDesignModel) {
        // Create an override entry in plannedColumns
        column = { name: payload.columnName };
        columns.push(column);
        model[targetArray] = columns;
      }

      if (!column) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Column "${payload.columnName}" not found.` },
        });
        return;
      }

      // Toggle the key flag
      if (payload.value) {
        column[fieldName] = true;
      } else {
        delete column[fieldName];
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
          payload: { message: 'Failed to toggle key type.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Toggle key failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to toggle key type: ${message}` },
      });
    }
  }

  /**
   * Handle an `addRelationship` message from the webview.
   *
   * Adds a new FK relationship to the domain's relationships array.
   * The relationship is marked with source: 'design' and persisted via WorkspaceEdit.
   */
  private async handleAddRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      fromModel: string;
      fromColumn: string;
      toModel: string;
      toColumn: string;
      cardinality: Cardinality;
    },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;

          // Check for duplicate relationship (same composite key)
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

          // Add the new relationship with source: 'design'
          relationships.push({
            fromModel: payload.fromModel,
            fromColumn: payload.fromColumn,
            toModel: payload.toModel,
            toColumn: payload.toColumn,
            cardinality: payload.cardinality,
            source: 'design',
          });
          parsed.relationships = relationships;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to add relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add relationship: ${message}` },
      });
    }
  }

  /**
   * Handle a `removeModel` message from the webview.
   *
   * Removes a design model from the domain's models array and cascades
   * to remove all relationships involving this model.
   */
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
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" not found.` },
        });
        return;
      }

      // Capture model info before removal (for tag management)
      const modelToRemove = models[modelIndex];
      const isBuiltModel = modelToRemove.source === 'built';
      const domainName = typeof parsed.domain === 'string' ? parsed.domain : undefined;

      // Remove the model (both design and repo models can be removed from the domain)
      models.splice(modelIndex, 1);
      parsed.models = models;

      // Cascade: remove relationships involving this model
      const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
      const filteredRelationships = relationships.filter(
        (rel) => rel.fromModel !== payload.modelName && rel.toModel !== payload.modelName,
      );
      parsed.relationships = filteredRelationships;

      // Remove positions for deleted model
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const positions = (viewConfig.positions ?? {}) as Record<string, unknown>;
      delete positions[payload.modelName];
      viewConfig.positions = positions;
      parsed.viewConfig = viewConfig;

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
        try {
          await document.save();

          // Remove domain tag from schema.yml for built models only
          if (isBuiltModel && domainName) {
            const tagEdit = await this.schemaTagService.removeDomainTag(
              payload.modelName,
              domainName,
              this.workspaceRoot,
            );
            if (tagEdit) {
              const tagSuccess = await vscode.workspace.applyEdit(tagEdit);
              if (tagSuccess) {
                // Save all modified documents (the schema.yml file)
                await vscode.workspace.saveAll(false);
              }
            }
          }

          await this.sendDomainData(document, webview);
        } finally {
          this.pendingUpdates.delete(document.uri.toString());
        }
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to remove model.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to remove model: ${message}` },
      });
    }
  }

  /**
   * Handle a `removeRelationship` message from the webview.
   *
   * Removes an FK relationship by its composite key (fromModel, fromColumn, toModel, toColumn).
   */
  private async handleRemoveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      fromModel: string;
      fromColumn: string;
      toModel: string;
      toColumn: string;
    },
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

          const relationship = relationships[relIndex];
          if (relationship.source !== 'design') {
            throw new Error('Cannot delete built relationship. Only design relationships can be deleted.');
          }

          relationships.splice(relIndex, 1);
          parsed.relationships = relationships;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to remove relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to remove relationship: ${message}` },
      });
    }
  }

  /**
   * Handle updateRelationship message — updates a relationship's cardinality.
   * Works for both design and built relationships.
   */
  private async handleUpdateRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      fromModel: string;
      fromColumn: string;
      toModel: string;
      toColumn: string;
      cardinality: Cardinality;
    },
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
          parsed.relationships = relationships;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to update relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Update relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to update relationship: ${message}` },
      });
    }
  }

  /**
   * Handle an `editRelationship` message from the webview.
   *
   * Edits a relationship by finding it via the original composite key
   * and updating all fields. Preserves source and approved status.
   * Only works for design/approved relationships (not built).
   */
  private async handleEditRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: {
      originalFromModel: string;
      originalFromColumn: string;
      originalToModel: string;
      originalToColumn: string;
      fromModel: string;
      fromColumn: string;
      toModel: string;
      toColumn: string;
      cardinality: Cardinality;
    },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;

          // Find the relationship by original composite key
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

          const existingRel = relationships[relIndex];

          // Only allow editing design relationships (not built from manifest)
          if (existingRel.source !== 'design') {
            throw new Error('Cannot edit built relationships.');
          }

          // Check for duplicate at new key (if key changed)
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

          // Update the relationship, preserving source and approved status
          relationships[relIndex] = {
            ...existingRel,
            fromModel: payload.fromModel,
            fromColumn: payload.fromColumn,
            toModel: payload.toModel,
            toColumn: payload.toColumn,
            cardinality: payload.cardinality,
          };
          parsed.relationships = relationships;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to edit relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Edit relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to edit relationship: ${message}` },
      });
    }
  }

  /**
   * Handle an `updatePositions` message from the webview.
   *
   * Merges the new positions into `viewConfig.positions` in the domain JSON
   * and writes back via WorkspaceEdit (integrates with VS Code undo/redo).
   */
  private async handleUpdatePositions(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    positions: Record<string, { x: number; y: number }>,
  ): Promise<void> {
    try {
      // Read from the document buffer (not disk) — the buffer is the source
      // of truth for unsaved edits.
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;

      // Merge positions into viewConfig, preserving other viewConfig fields.
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      parsed.viewConfig = { ...viewConfig, positions };

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
        // Save the document so undo/redo works correctly.
        // Without save, onDidChangeTextDocument would read stale data from disk.
        await document.save();
        this.pendingUpdates.delete(document.uri.toString());
        // Note: We don't call sendDomainData() here because positions are managed
        // locally by React Flow. The webview already has the correct positions.
        // However, external undo (Ctrl+Z) will trigger onDidChangeTextDocument,
        // which will call sendDomainData() and refresh the canvas with old positions.
      } else {
        this.pendingUpdates.delete(document.uri.toString());
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to save layout positions.' },
        });
      }
    } catch (err) {
      this.pendingUpdates.delete(document.uri.toString());
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Position update failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to save positions: ${message}` },
      });
    }
  }

  /**
   * Handle an `addExistingModel` message from the webview.
   *
   * Adds an existing model from the manifest to the domain with source: 'built'.
   * The model's columns will be resolved from the manifest during reconciliation.
   */
  private async handleAddExistingModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
  ): Promise<void> {
    try {
      // Verify model exists in manifest
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

      // Check for duplicate model name
      if (models.some((m) => m.name === payload.modelName)) {
        webview.postMessage({
          type: 'error',
          payload: { message: `Model "${payload.modelName}" already exists in this domain.` },
        });
        return;
      }

      // Find an open position on the canvas for the new model
      const viewConfig = (parsed.viewConfig ?? {}) as Record<string, unknown>;
      const existingPositions = (viewConfig.positions ?? {}) as Record<string, { x: number; y: number }>;
      const newPosition = this.findOpenPosition(existingPositions);

      // Add the built model (columns come from manifest via reconciliation)
      models.push({
        name: payload.modelName,
        source: 'built',
      });

      // Auto-create relationships from manifest tests (F409 enhancement)
      // When adding a model from manifest, automatically add any relationship tests
      // that involve this model where both endpoints are now in the domain.
      const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
      const modelNames = new Set(models.map((m) => m.name as string));
      const relationshipTests = this.manifestService.getRelationshipTests();

      for (const test of relationshipTests) {
        // Only consider tests that involve the newly added model
        if (test.fromModel !== payload.modelName && test.toModel !== payload.modelName) {
          continue;
        }

        // Check if both models are now in the domain
        if (!modelNames.has(test.fromModel) || !modelNames.has(test.toModel)) {
          continue;
        }

        // Check if relationship already exists (by all 4 keys)
        const alreadyExists = relationships.some(
          (r) =>
            r.fromModel === test.fromModel &&
            r.fromColumn === test.fromColumn &&
            r.toModel === test.toModel &&
            r.toColumn === test.toColumn,
        );

        if (!alreadyExists) {
          // Add as built relationship (no source: 'design' property)
          relationships.push({
            fromModel: test.fromModel,
            fromColumn: test.fromColumn,
            toModel: test.toModel,
            toColumn: test.toColumn,
            cardinality: 'many-to-one' as const, // Default cardinality for FK relationships
          });
        }
      }
      parsed.relationships = relationships;

      // Save the position for the new model
      const updatedPositions = {
        ...existingPositions,
        [payload.modelName]: newPosition,
      };

      parsed.models = models;
      parsed.viewConfig = { ...viewConfig, positions: updatedPositions };
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
        try {
          await document.save();

          // Add domain tag to schema.yml for the newly added model
          const domainName = typeof parsed.domain === 'string' ? parsed.domain : undefined;
          if (domainName && manifestModel.originalFilePath) {
            const tagEdit = await this.schemaTagService.addDomainTag(
              payload.modelName,
              domainName,
              this.workspaceRoot,
            );
            if (tagEdit) {
              const tagSuccess = await vscode.workspace.applyEdit(tagEdit);
              if (tagSuccess) {
                // Save all modified documents (the schema.yml file)
                await vscode.workspace.saveAll(false);
              }
            }
          }

          await this.sendDomainData(document, webview);
        } finally {
          this.pendingUpdates.delete(document.uri.toString());
        }
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
      console.error(`[SemanticEditorProvider] Add existing model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add model: ${message}` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Approval handlers
  // ---------------------------------------------------------------------------

  /**
   * Handle `approveModel` message — approves a model and all its columns.
   * Sets model.approved = true and approved = true on all existing columns.
   */
  private async handleApproveModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);

          if (!model) {
            throw new Error(`Model "${payload.modelName}" not found.`);
          }

          // Set model as approved
          model.approved = true;

          // Approve all existing columns (design models only)
          if (model.source === 'design' && Array.isArray(model.columns)) {
            for (const col of model.columns as Array<Record<string, unknown>>) {
              col.approved = true;
            }
          }

          // Approve all planned columns (built models)
          if (model.source === 'built' && Array.isArray(model.plannedColumns)) {
            for (const col of model.plannedColumns as Array<Record<string, unknown>>) {
              col.approved = true;
            }
          }
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to approve model.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Approve model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to approve model: ${message}` },
      });
    }
  }

  /**
   * Handle `unapproveModel` message — unapproves a model.
   * Removes the approved flag from the model AND cascades to all columns.
   * This maintains the invariant: columns cannot be approved if model is not approved.
   */
  private async handleUnapproveModel(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);

          if (!model) {
            throw new Error(`Model "${payload.modelName}" not found.`);
          }

          // Remove approval from model
          delete model.approved;

          // Cascade unapproval to all columns (maintains invariant)
          if (model.source === 'design' && Array.isArray(model.columns)) {
            for (const col of model.columns as Array<Record<string, unknown>>) {
              delete col.approved;
            }
          }
          if (Array.isArray(model.plannedColumns)) {
            for (const col of model.plannedColumns as Array<Record<string, unknown>>) {
              delete col.approved;
            }
          }

          // Cascade unapproval to relationships involving this model
          // (relationships require both models to be built/approved)
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
          for (const rel of relationships) {
            if (rel.fromModel === payload.modelName || rel.toModel === payload.modelName) {
              delete rel.approved;
            }
          }
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to unapprove model.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Unapprove model failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to unapprove model: ${message}` },
      });
    }
  }

  /**
   * Handle `approveColumn` message — approves a single column.
   * Requires model to be approved first.
   */
  private async handleApproveColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; columnName: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);

          if (!model) {
            throw new Error(`Model "${payload.modelName}" not found.`);
          }

          // For design models, require model approval first
          // For repo (built) models, allow column approval without model approval
          const isDesignModel = model.source === 'design';
          if (isDesignModel && model.approved !== true) {
            throw new Error('Cannot approve column until model is approved.');
          }

          // Find and approve the column
          const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
          const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

          const column = columns.find((c) => c.name === payload.columnName);
          if (!column) {
            throw new Error(`Column "${payload.columnName}" not found.`);
          }

          column.approved = true;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to approve column.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Approve column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to approve column: ${message}` },
      });
    }
  }

  /**
   * Handle `unapproveColumn` message — unapproves a single column.
   */
  private async handleUnapproveColumn(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { modelName: string; columnName: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;
          const model = models.find((m) => m.name === payload.modelName);

          if (!model) {
            throw new Error(`Model "${payload.modelName}" not found.`);
          }

          // Find and unapprove the column
          const isDesignModel = model.source === 'design';
          const targetArray = isDesignModel ? 'columns' : 'plannedColumns';
          const columns = (model[targetArray] ?? []) as Array<Record<string, unknown>>;

          const column = columns.find((c) => c.name === payload.columnName);
          if (!column) {
            throw new Error(`Column "${payload.columnName}" not found.`);
          }

          delete column.approved;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to unapprove column.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Unapprove column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to unapprove column: ${message}` },
      });
    }
  }

  /**
   * Handle `approveRelationship` message — approves a relationship.
   */
  private async handleApproveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
          const models = (parsed.models ?? []) as Array<Record<string, unknown>>;

          const rel = relationships.find(
            (r) =>
              r.fromModel === payload.fromModel &&
              r.fromColumn === payload.fromColumn &&
              r.toModel === payload.toModel &&
              r.toColumn === payload.toColumn,
          );

          if (!rel) {
            throw new Error('Relationship not found.');
          }

          // Only design relationships can be approved
          if (rel.source !== 'design') {
            throw new Error('Only design relationships can be approved.');
          }

          // Check that both models are built or approved (not design)
          // A model is "approvable" if it's a repo model OR a design model with approved=true
          const fromModel = models.find((m) => m.name === payload.fromModel);
          const toModel = models.find((m) => m.name === payload.toModel);

          const isModelApprovable = (model: Record<string, unknown> | undefined): boolean => {
            if (!model) return false;
            // Built models are always approvable (they're built or missing)
            if (model.source === 'built') return true;
            // Design models must be approved
            return model.approved === true;
          };

          if (!isModelApprovable(fromModel)) {
            throw new Error(`Cannot approve relationship: model "${payload.fromModel}" must be approved first.`);
          }
          if (!isModelApprovable(toModel)) {
            throw new Error(`Cannot approve relationship: model "${payload.toModel}" must be approved first.`);
          }

          rel.approved = true;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to approve relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Approve relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to approve relationship: ${message}` },
      });
    }
  }

  /**
   * Handle `unapproveRelationship` message — unapproves a relationship.
   */
  private async handleUnapproveRelationship(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    payload: { fromModel: string; fromColumn: string; toModel: string; toColumn: string },
  ): Promise<void> {
    try {
      const success = await this.applyDomainEdit(
        document,
        (parsed) => {
          const relationships = (parsed.relationships ?? []) as Array<Record<string, unknown>>;
          const rel = relationships.find(
            (r) =>
              r.fromModel === payload.fromModel &&
              r.fromColumn === payload.fromColumn &&
              r.toModel === payload.toModel &&
              r.toColumn === payload.toColumn,
          );

          if (!rel) {
            throw new Error('Relationship not found.');
          }

          delete rel.approved;
        },
        { webview },
      );

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to unapprove relationship.' },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Unapprove relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to unapprove relationship: ${message}` },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Utility methods
  // ---------------------------------------------------------------------------

  /**
   * Find an open position on the canvas that doesn't overlap existing nodes.
   * Uses a simple grid-based algorithm that searches outward from the center.
   */
  private findOpenPosition(
    existingPositions: Record<string, { x: number; y: number }>,
  ): { x: number; y: number } {
    const NODE_WIDTH = 280;
    const NODE_HEIGHT = 200;
    const PADDING = 40;
    const CELL_WIDTH = NODE_WIDTH + PADDING;
    const CELL_HEIGHT = NODE_HEIGHT + PADDING;

    // If no existing nodes, place at a reasonable starting position
    if (Object.keys(existingPositions).length === 0) {
      return { x: 100, y: 100 };
    }

    // Find the bounding box of existing nodes (for fallback positioning)
    const positions = Object.values(existingPositions);
    const maxX = Math.max(...positions.map((p) => p.x), 0);

    // Try positions in a grid pattern, searching for first non-overlapping spot
    // Start from top-left and scan right, then down
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < 10; col++) {
        const candidate = {
          x: col * CELL_WIDTH + 100,
          y: row * CELL_HEIGHT + 100,
        };

        // Check if this spot overlaps any existing node
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

    // Fallback: place to the right of all existing nodes
    return { x: maxX + CELL_WIDTH, y: 100 };
  }

  /**
   * Generate CSP-compliant HTML for the webview.
   * Loads the bundled webview script with a nonce for security.
   */
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

/** Type guard for messages with a `type` string property. */
function isTypedMessage(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && 'type' in value && typeof (value as Record<string, unknown>).type === 'string';
}
