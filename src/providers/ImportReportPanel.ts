/**
 * The **Import Report** tab (`src/services/importReport.ts`): a singleton
 * webview panel, opened by `erdStudio.showImportReport`, that shows the last
 * import's report and follows it when a new import replaces it.
 *
 * Read-only: it writes nothing (no file, no setting, no state). The page can
 * only ask to open a link by its index (`parseImportReportToHost`); the host
 * opens the file the import itself read, at that line, from its own table.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
  IMPORT_REPORT_TITLE,
  IMPORT_REPORT_VIEW_TYPE,
  buildImportReportHtml,
  buildImportReportView,
  parseImportReportToHost,
  type ImportReportLink,
  type ImportReportRecord,
} from '../services/importReport';
import { latestImportReport, onImportReportChanged } from '../services/importReportStore';
import { log } from '../services/logger';

export interface ImportReportDeps {
  /** The report on show (default: the store's last import). */
  report?(): ImportReportRecord | undefined;
  /** Open `file` at the 1-based `line` (default: `openTableFileAt`). */
  openFileAt(file: string, line?: number): Promise<unknown>;
  /** Say that a link did not open (the file moved or was deleted since). */
  couldNotOpen?(file: string): void;
}

export class ImportReportPanel {
  private static current: ImportReportPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /** The link table of the page on show: the page sends only an index into it. */
  private links: ImportReportLink[] = [];

  /** Open the report, or bring the open one forward with the last import. */
  static createOrShow(deps: ImportReportDeps): ImportReportPanel {
    const open = ImportReportPanel.current;
    if (open) {
      open.deps = deps;
      open.render();
      open.panel.reveal(vscode.ViewColumn.Active);
      return open;
    }
    const panel = vscode.window.createWebviewPanel(
      IMPORT_REPORT_VIEW_TYPE,
      IMPORT_REPORT_TITLE,
      vscode.ViewColumn.Active,
      { enableScripts: true, enableFindWidget: true, localResourceRoots: [] },
    );
    const page = new ImportReportPanel(panel, deps);
    ImportReportPanel.current = page;
    return page;
  }

  /** The open report, if any (tests). */
  static get currentPanel(): ImportReportPanel | undefined {
    return ImportReportPanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private deps: ImportReportDeps) {
    this.render();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
      // A new import (or a Keep) while the tab is open: it shows the new report.
      onImportReportChanged(() => this.render()),
    );
  }

  /** Draw the page for the report as it is now. */
  render(): void {
    if (this.disposed) return;
    const record = (this.deps.report ?? latestImportReport)();
    const view = record ? buildImportReportView(record) : undefined;
    this.links = view?.links ?? [];
    this.panel.webview.html = buildImportReportHtml(view, crypto.randomBytes(16).toString('base64'));
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const message = parseImportReportToHost(raw, this.links.length);
    if (!message) {
      log.warn('[ImportReport] Ignoring an unknown or invalid message.');
      return;
    }
    const target = this.links[message.link];
    try {
      await this.deps.openFileAt(target.file, target.line);
    } catch (err) {
      log.warn('[ImportReport] Could not open a file from the report:', err instanceof Error ? err.message : String(err));
      this.deps.couldNotOpen?.(target.file);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ImportReportPanel.current === this) ImportReportPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
