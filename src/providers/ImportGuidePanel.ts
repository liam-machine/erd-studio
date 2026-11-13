/**
 * The **Import Your Data Model** tab (`src/services/importGuide.ts`): a
 * singleton webview panel, opened by `erdStudio.showImportGuide` from any
 * window (an empty one too: it is pre-registered). Every message is
 * validated (`isImportGuideToHost`) and mapped to a fixed command or a fixed
 * snippet here; nothing the page sends is run or copied as given. It writes
 * nothing: each import asks its own questions and shows its dry run first.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
  IMPORT_GUIDE_ACTION_FEATURES,
  IMPORT_GUIDE_COPIED_FEATURE,
  IMPORT_GUIDE_EXAMPLE_COMMAND,
  IMPORT_GUIDE_SNIPPET_COPIED_FEATURES,
  IMPORT_GUIDE_SNIPPETS,
  IMPORT_GUIDE_TITLE,
  IMPORT_GUIDE_VIEW_TYPE,
  buildImportGuideHtml,
  importGuideActionCommand,
  importGuideActionNeedsFolder,
  isImportGuideToHost,
  type ImportGuideContext,
} from '../services/importGuide';
import { log } from '../services/logger';
import type { TelemetryFeature } from '../services/telemetryPayload';

export interface ImportGuideDeps {
  /** Where the window stands now (folder, dbt, the suggestion). */
  context(): ImportGuideContext;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  writeClipboard(text: string): Thenable<void>;
  /** A button that needs a folder, pressed with none open: the "Open a folder first" warning. */
  noFolder(): void;
  feature(key: TelemetryFeature): void;
}

export class ImportGuidePanel {
  private static current: ImportGuidePanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  /** Open the guide, or bring the open one forward with the window's current context. */
  static createOrShow(deps: ImportGuideDeps): ImportGuidePanel {
    const open = ImportGuidePanel.current;
    if (open) {
      open.deps = deps;
      open.render();
      open.panel.reveal(vscode.ViewColumn.Active);
      return open;
    }
    const panel = vscode.window.createWebviewPanel(
      IMPORT_GUIDE_VIEW_TYPE,
      IMPORT_GUIDE_TITLE,
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [] },
    );
    const page = new ImportGuidePanel(panel, deps);
    ImportGuidePanel.current = page;
    return page;
  }

  /** The open guide, if any (tests). */
  static get currentPanel(): ImportGuidePanel | undefined {
    return ImportGuidePanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private deps: ImportGuideDeps) {
    this.render();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => { void this.handleMessage(message); }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Draw the page again for the window as it is now (a suggestion found since, say). */
  render(): void {
    if (this.disposed) return;
    this.panel.webview.html = buildImportGuideHtml(this.deps.context(), crypto.randomBytes(16).toString('base64'));
  }

  async handleMessage(message: unknown): Promise<void> {
    if (!isImportGuideToHost(message)) {
      log.warn('[ImportGuide] Ignoring an unknown or invalid message:', message);
      return;
    }
    switch (message.type) {
      case 'run': {
        const ctx = this.deps.context();
        const run = importGuideActionCommand(message.action, ctx.intent);
        if (!run) {
          log.warn(`[ImportGuide] Nothing to run for ${message.action} here.`);
          return;
        }
        this.deps.feature(IMPORT_GUIDE_ACTION_FEATURES[message.action]);
        if (importGuideActionNeedsFolder(message.action) && !ctx.hasProject) {
          this.deps.noFolder();
          return;
        }
        await this.deps.executeCommand(run.command, ...run.args);
        return;
      }
      case 'copy': {
        this.deps.feature(IMPORT_GUIDE_COPIED_FEATURE);
        // The Fabric card's query is also counted by itself: fixed keys only, never what was copied.
        const copied = IMPORT_GUIDE_SNIPPET_COPIED_FEATURES[message.snippet];
        if (copied) this.deps.feature(copied);
        await this.deps.writeClipboard(IMPORT_GUIDE_SNIPPETS[message.snippet]);
        return;
      }
      case 'openFolder':
        await this.deps.executeCommand('vscode.openFolder');
        return;
      case 'openExample':
        // Works with no folder open too: the example opens in a draft, or in a folder of its own.
        await this.deps.executeCommand(IMPORT_GUIDE_EXAMPLE_COMMAND);
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ImportGuidePanel.current === this) ImportGuidePanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
