/**
 * The **Import Report** tab (`src/services/importReport.ts`): a singleton
 * webview panel, opened by `erdStudio.showImportReport`, that shows one
 * import's report. Showing the latest, it follows a new import; showing an
 * older one (asked for by that import's draft or toast), it stays on it.
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
import { importReportById, latestImportReportId, onImportReportChanged } from '../services/importReportStore';
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
  /** The token of the page on show: a click from an earlier drawing (another report's links) is refused. */
  private viewToken = '';
  /** The import on show (undefined: none yet). */
  private reportId: number | undefined;
  /** Follow a new import (the tab shows the latest). */
  private follow = true;
  /** The report the page on show was drawn from (a change to another import never redraws it). */
  private drawn: { record: ImportReportRecord | undefined } | undefined;

  /**
   * Open the report of import `reportId` (default: the latest), or bring the
   * open tab forward with it.
   */
  static createOrShow(deps: ImportReportDeps, reportId?: number): ImportReportPanel {
    const open = ImportReportPanel.current;
    if (open) {
      open.deps = deps;
      open.target(reportId);
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
    const page = new ImportReportPanel(panel, deps, reportId);
    ImportReportPanel.current = page;
    return page;
  }

  /** The open report, if any (tests). */
  static get currentPanel(): ImportReportPanel | undefined {
    return ImportReportPanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, private deps: ImportReportDeps, reportId?: number) {
    this.target(reportId);
    this.render();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
      // A new import (or a Keep) while the tab is open: the latest's tab moves to the new one; any tab redraws its
      // own report when it changed, and only then (a redraw resets the page and refuses a click already sent).
      onImportReportChanged(() => {
        // An older report a long session has since dropped: the tab moves to the latest rather than going blank.
        if (!this.follow && this.reportId !== undefined && !importReportById(this.reportId)) this.follow = true;
        if (this.follow) this.reportId = latestImportReportId();
        if (this.drawn && this.drawn.record === this.record()) return;
        this.render();
      }),
    );
  }

  /** Show import `reportId` (undefined, or the latest itself: follow the latest). */
  private target(reportId: number | undefined): void {
    const latest = latestImportReportId();
    this.follow = reportId === undefined || reportId === latest;
    this.reportId = this.follow ? latest : reportId;
  }

  /** The report to show, as it is now (the store replaces a record when it changes). */
  private record(): ImportReportRecord | undefined {
    return this.deps.report ? this.deps.report() : this.reportId !== undefined ? importReportById(this.reportId) : undefined;
  }

  /** Draw the page for the report as it is now. */
  render(): void {
    if (this.disposed) return;
    const record = this.record();
    this.drawn = { record };
    const view = record ? buildImportReportView(record) : undefined;
    this.links = view?.links ?? [];
    this.viewToken = crypto.randomBytes(12).toString('hex');
    this.panel.webview.html = buildImportReportHtml(view, crypto.randomBytes(16).toString('base64'), this.viewToken);
  }

  async handleMessage(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const message = parseImportReportToHost(raw, this.links.length, this.viewToken);
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
