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
import type { Cardinality, ColumnDef, DesignModel } from '../types/semantic';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class SemanticEditorProvider implements vscode.CustomTextEditorProvider {
  /**
   * Guard flag to prevent re-sending domain data to the webview when
   * an onDidChangeTextDocument event is triggered by our own WorkspaceEdit.
   */
  private pendingUpdate = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly reconciliationService: ReconciliationService,
    private readonly templateService: TemplateService,
    private readonly workspaceRoot: string,
  ) {}

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
          case 'addRelationship': {
            const payload = (message as { payload?: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality } }).payload;
            if (payload) {
              await this.handleAddRelationship(document, webviewPanel.webview, payload);
            }
            break;
          }
          // Phase 2: handle other mutation messages (removeModel, removeRelationship, etc.)
        }
      },
    );

    const changeSubscription = vscode.workspace.onDidChangeTextDocument(async (e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (this.pendingUpdate) {
        return;
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
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

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

      // Load templates from the semantic/templates directory
      const templates = this.templateService.loadTemplates(this.workspaceRoot);

      webview.postMessage({
        type: 'domainLoaded',
        payload: { ...reconciled, templates },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Failed to parse domain: ${message}`);
      webview.postMessage({ type: 'error', payload: { message } });
    }
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

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        // Save the document so getDomain reads the updated content from disk
        await document.save();
        this.pendingUpdate = false;
        // Send updated domain data to refresh the canvas
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdate = false;
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to add model to domain.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
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
      columns.push({
        name: payload.column.name,
        dataType: payload.column.dataType,
        description: payload.column.description,
        ...(payload.column.isPrimaryKey ? { isPrimaryKey: true } : {}),
      });
      model[targetArray] = columns;

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdate = false;
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdate = false;
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to add column.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
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

      // Update the column
      columns[columnIndex] = {
        name: payload.column.name,
        dataType: payload.column.dataType,
        description: payload.column.description,
        ...(payload.column.isPrimaryKey ? { isPrimaryKey: true } : {}),
      };

      const updatedText = JSON.stringify(parsed, null, 2) + '\n';
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdate = false;
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdate = false;
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to update column.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
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

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        await document.save();
        this.pendingUpdate = false;
        await this.sendDomainData(document, webview);
      } else {
        this.pendingUpdate = false;
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to remove column.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Remove column failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to remove column: ${message}` },
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
      const text = document.getText();
      const parsed = JSON.parse(text) as Record<string, unknown>;

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
        webview.postMessage({
          type: 'error',
          payload: { message: 'This relationship already exists.' },
        });
        return;
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
      const updatedText = JSON.stringify(parsed, null, 2) + '\n';

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(text.length),
      );
      edit.replace(document.uri, fullRange, updatedText);

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);

      if (success) {
        try {
          await document.save();
          await this.sendDomainData(document, webview);
        } finally {
          this.pendingUpdate = false;
        }
      } else {
        this.pendingUpdate = false;
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to add relationship.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Add relationship failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to add relationship: ${message}` },
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

      this.pendingUpdate = true;
      const success = await vscode.workspace.applyEdit(edit);
      this.pendingUpdate = false;

      if (!success) {
        webview.postMessage({
          type: 'error',
          payload: { message: 'Failed to save layout positions.' },
        });
      }
    } catch (err) {
      this.pendingUpdate = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Position update failed: ${message}`);
      webview.postMessage({
        type: 'error',
        payload: { message: `Failed to save positions: ${message}` },
      });
    }
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
