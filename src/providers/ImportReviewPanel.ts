/**
 * The import's **Review All…** page (`src/services/importReview.ts`): an
 * editor tab with every table, relationship and what is left out, and the
 * import's own Import / Cancel (and Change Options…) buttons, so the user
 * answers the waiting import from the page. Closing the tab answers
 * `closed`: the import shows its modal again.
 *
 * One page at a time; a newer review takes the open one over (the older
 * import gets `closed`). It writes nothing and posts nothing back: every
 * message is validated (`isImportReviewToHost`) and the import's flow acts
 * on the answer.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
  IMPORT_REVIEW_TITLE,
  IMPORT_REVIEW_VIEW_TYPE,
  buildImportReviewHtml,
  isImportReviewToHost,
  type ImportReviewView,
} from '../services/importReview';
import { log } from '../services/logger';

/** What the user chose on the page; `closed`: the tab was closed (or a newer review took it over). */
export type ImportReviewChoice = 'import' | 'cancel' | 'changeOptions' | 'closed';

export class ImportReviewPanel {
  private static current: ImportReviewPanel | undefined;

  private resolve: ((choice: ImportReviewChoice) => void) | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /** Show the review (taking over an open one) and wait for the user's choice. */
  static show(view: ImportReviewView): Promise<ImportReviewChoice> {
    let page = ImportReviewPanel.current;
    if (page) {
      page.settle('closed');
      page.render(view);
      page.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const panel = vscode.window.createWebviewPanel(
        IMPORT_REVIEW_VIEW_TYPE,
        IMPORT_REVIEW_TITLE,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
      );
      page = new ImportReviewPanel(panel, view);
      ImportReviewPanel.current = page;
    }
    const shown = page;
    return new Promise<ImportReviewChoice>((resolve) => { shown.resolve = resolve; });
  }

  /** The open page, if any (tests). */
  static get currentPanel(): ImportReviewPanel | undefined {
    return ImportReviewPanel.current;
  }

  private constructor(private readonly panel: vscode.WebviewPanel, view: ImportReviewView) {
    this.render(view);
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  private render(view: ImportReviewView): void {
    this.panel.webview.html = buildImportReviewHtml(view, crypto.randomBytes(16).toString('base64'));
  }

  private settle(choice: ImportReviewChoice): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(choice);
  }

  handleMessage(message: unknown): void {
    if (!isImportReviewToHost(message)) {
      log.warn('[ImportReviewPanel] Ignoring an unknown or invalid message:', message);
      return;
    }
    // The page has answered: it closes, and the import goes on (or stops) from here.
    this.settle(message.type);
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ImportReviewPanel.current === this) ImportReviewPanel.current = undefined;
    this.settle('closed');
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
