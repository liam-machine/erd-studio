/**
 * The "Convert to DBML" panel (native DBML storage §6.2, after pre-release
 * 1.9.0 feedback): an editor tab that shows Convert Project to DBML's plan,
 * or its refusals, as a scrollable list with sticky buttons. It replaces the
 * modal, whose detail text could not scroll.
 *
 * One panel at a time. It writes nothing: `show` resolves with the user's
 * choice and the command (`src/commands/convertProjectToDbml.ts`) does the
 * rest exactly as before. Its own protocol and HTML are the pure
 * `src/services/dbmlConversionReview.ts`; every incoming message is
 * validated there, and a refusal's Open sends an index into this host's list,
 * never a path.
 */

import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

import { openTableFileAt } from '../commands/openModelFile';
import type { FeedbackPrefill } from '../services/commandErrors';
import {
  CONVERT_PANEL_TITLE,
  CONVERT_PANEL_VIEW_TYPE,
  buildConvertPanelHtml,
  isConvertPanelToHost,
  type ConvertRefusalLocation,
  type ConvertReviewView,
} from '../services/dbmlConversionReview';

/** What the user chose. `superseded`: a newer run took the panel over before the user chose. */
export type ConvertPanelChoice = 'convert' | 'cancel' | 'checkAgain' | 'superseded';

export interface ConvertPanelContent {
  view: ConvertReviewView;
  /** Each refusal's file and line, indexed by the items' `open`. */
  locations: ConvertRefusalLocation[];
  /** The semantic dir, absolute: locations resolve under it and never outside. */
  semanticRoot: string;
  /** What Send Feedback prefills, on a page refused by ERD Studio's own self-check. */
  feedback?: FeedbackPrefill;
}

export class ConvertToDbmlPanel {
  private static current: ConvertToDbmlPanel | undefined;

  private content: ConvertPanelContent;
  private resolve: ((choice: ConvertPanelChoice) => void) | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Show the content (opening the panel, or revealing and refreshing the open
   * one) and wait for the user's choice. Closing the tab is Cancel.
   */
  static show(content: ConvertPanelContent): Promise<ConvertPanelChoice> {
    let panel = ConvertToDbmlPanel.current;
    if (panel) {
      panel.settle('superseded');
      panel.setContent(content);
      panel.panel.reveal(vscode.ViewColumn.Active);
    } else {
      const webviewPanel = vscode.window.createWebviewPanel(
        CONVERT_PANEL_VIEW_TYPE,
        CONVERT_PANEL_TITLE,
        vscode.ViewColumn.Active,
        { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true },
      );
      panel = new ConvertToDbmlPanel(webviewPanel, content);
      ConvertToDbmlPanel.current = panel;
    }
    const shown = panel;
    return new Promise<ConvertPanelChoice>((resolve) => { shown.resolve = resolve; });
  }

  /** The open panel, if any. */
  static get currentPanel(): ConvertToDbmlPanel | undefined {
    return ConvertToDbmlPanel.current;
  }

  /** Bring the open panel to the front, unchanged. */
  static reveal(): void {
    ConvertToDbmlPanel.current?.panel.reveal(vscode.ViewColumn.Active);
  }

  /** Close the panel unless a run is waiting on it. */
  static closeIfIdle(): void {
    const panel = ConvertToDbmlPanel.current;
    if (panel && !panel.resolve) panel.dispose();
  }

  /** Close the panel (any waiting run gets Cancel). */
  static close(): void {
    ConvertToDbmlPanel.current?.dispose();
  }

  private constructor(private readonly panel: vscode.WebviewPanel, content: ConvertPanelContent) {
    this.content = content;
    this.render();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message).catch((err: unknown) => {
          console.error('[ConvertToDbmlPanel] Message handler failed:', err);
        });
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  /** The content on show, for tests. */
  get view(): ConvertReviewView {
    return this.content.view;
  }

  /** Whether a run is waiting for the user's choice. */
  get waiting(): boolean {
    return this.resolve !== undefined;
  }

  private setContent(content: ConvertPanelContent): void {
    this.content = content;
    this.render();
  }

  private render(): void {
    this.panel.webview.html = buildConvertPanelHtml(this.content.view, crypto.randomBytes(16).toString('base64'));
  }

  private settle(choice: ConvertPanelChoice): void {
    const resolve = this.resolve;
    this.resolve = undefined;
    resolve?.(choice);
  }

  async handleMessage(message: unknown): Promise<void> {
    if (!isConvertPanelToHost(message, this.content.locations.length)) {
      console.warn('[ConvertToDbmlPanel] Ignoring an unknown or invalid message:', message);
      return;
    }
    const mode = this.content.view.mode;
    switch (message.type) {
      case 'convert':
        // Only once, and only from the review: the button is disabled after its first click too.
        if (mode === 'review') this.settle('convert');
        return;
      case 'checkAgain':
        // The refused page, or a review that leaves files as they are (fix them, then check again).
        if (mode === 'refused' || this.content.view.checkAgain) this.settle('checkAgain');
        return;
      case 'sendFeedback':
        if (mode === 'refused' && this.content.view.reportable && this.content.feedback) {
          await vscode.commands.executeCommand('erdStudio.reportBug', this.content.feedback);
        }
        return;
      case 'cancel':
        if (this.resolve || mode === 'refused') this.dispose();
        return;
      case 'open': {
        const location = this.content.locations[message.index];
        const filePath = path.resolve(this.content.semanticRoot, ...location.path.split('/'));
        const root = path.resolve(this.content.semanticRoot);
        if (!filePath.startsWith(root + path.sep)) {
          console.warn('[ConvertToDbmlPanel] Refusing to open a path outside the project:', location.path);
          return;
        }
        try {
          await openTableFileAt(filePath, location.line, undefined, vscode.ViewColumn.Beside);
        } catch (err) {
          console.error('[ConvertToDbmlPanel] Could not open', location.path, err);
          void vscode.window.showErrorMessage(`${CONVERT_PANEL_TITLE}: could not open ${location.path}.`);
        }
        return;
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (ConvertToDbmlPanel.current === this) ConvertToDbmlPanel.current = undefined;
    this.settle('cancel');
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
