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
          // Phase 2: handle mutation messages (addModel, addColumn, etc.)
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
      webview.postMessage({ type: 'domainLoaded', payload: reconciled });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[SemanticEditorProvider] Failed to parse domain: ${message}`);
      webview.postMessage({ type: 'error', payload: { message } });
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
