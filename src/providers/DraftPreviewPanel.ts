/**
 * The draft preview (docs/dev/draft-first.md §2): one editor tab that shows a
 * {@link Draft} read-only — the banner, the switcher, the schema panel, the
 * details drawer and the diagram drawn by the renderer's `ErdCanvas` — and
 * hands the viewer's decision back to the flow that asked, as a
 * {@link DraftAnswer}.
 *
 * It writes nothing, runs no command and counts nothing: the flow acts on the
 * answer, and the passive events (`detailsOpened`, `layoutFailed`) go to the
 * `events` the host passes. The page (`webview-draft/`, `dist/draft.js`) gets
 * only `toDraftView(draft)`, and every message it sends is checked by
 * `parseDraftToHost` against the draft on show; anything else is logged and
 * dropped.
 *
 * One tab at a time (a singleton, no serializer: it closes on reload). A new
 * `ask` takes the open tab over and redraws it; the earlier pending `ask`
 * resolves `superseded`.
 */

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import {
  DRAFT_PASSIVE_TYPES,
  DRAFT_PREVIEW_VIEW_TYPE,
  draftAllowance,
  parseDraftToHost,
  toDraftView,
  type Draft,
  type DraftAnswer,
  type DraftGuideStart,
  type DraftKeepOutcome,
  type DraftPreview,
  type DraftPreviewEvents,
  type DraftToHost,
  type DraftToWebview,
  type DraftView,
} from '../types/draft';
import { createLogger } from '../services/logger';
import { layoutFailureLogLine } from '../services/telemetryCanvas';
import { ReadyWatch } from '../services/readyWatch';
import { askNoReadyRecovery } from './noReadyRecovery';

const log = createLogger('DraftPreviewPanel');

// ---------------------------------------------------------------------------
// The HTML shell (pure)
// ---------------------------------------------------------------------------

export interface DraftPreviewHtmlInput {
  /** `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  /** `dist/draft.js` as a webview URI. */
  scriptUri: string;
  /** `dist/draft.css` as a webview URI. */
  styleUri: string;
  /** The tab's title (the document's `<title>`). */
  title: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The page's Content-Security-Policy: nonce-only scripts, no `unsafe-inline` anywhere. */
export function draftPreviewCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    // The bundled stylesheet comes from cspSource. React and React Flow set
    // styles through the CSSOM (element.style), which this allows; a <style>
    // element would need the nonce.
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    // The ELK layout worker is a blob: URL built from the bundled worker code.
    'worker-src blob:',
  ].join('; ');
}

/**
 * The page: the CSP, the bundled stylesheet and script (both nonced), and an
 * empty root. No inline script, style or handler; nothing but the two
 * `cspSource` URLs.
 */
export function buildDraftPreviewHtml(input: DraftPreviewHtmlInput): string {
  const nonce = escapeHtml(input.nonce);
  const csp = escapeHtml(draftPreviewCsp(input.cspSource, input.nonce));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="${escapeHtml(input.styleUri)}" nonce="${nonce}">
</head>
<body>
  <div id="root" class="draft-root"></div>
  <script nonce="${nonce}" src="${escapeHtml(input.scriptUri)}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type Resolve = (answer: DraftAnswer) => void;

/** A choice the page made while no `ask` was waiting (after a Keep that did not save): kept for the next `ask` of the same draft. */
interface QueuedChoice {
  viewId: string;
  message: DraftToHost;
}

export class DraftPreviewPanel {
  private static current: DraftPreviewPanel | undefined;

  private draft: Draft;
  private view: DraftView;
  private events: Partial<DraftPreviewEvents>;
  /** The page has said `ready`: posts reach it. */
  private ready = false;
  private pending: Resolve | undefined;
  /** Bumped by every `ask`; a `settle` from an earlier one is ignored. */
  private generation = 0;
  private queued: QueuedChoice | undefined;
  /** The onboarding guide runs on this page (posted after the draft, once the page is ready). */
  private guide: DraftGuideStart | undefined;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  /** Did the page come up (2.0 B13)? Timed while the tab is visible. */
  private readonly readyWatch: ReadyWatch;
  /** The page shows its crash screen (until it is reloaded). */
  private crashed = false;
  /** The id of the draft the page is laying out (posted with `autoLayout`, no `layoutFinished` / `layoutFailed` yet). */
  private layingOut: string | undefined;
  /** The extension's `dist/` folder (the page's script and stylesheet). */
  private readonly dist: vscode.Uri;

  /** The open tab, if any (tests). */
  static get currentPanel(): DraftPreviewPanel | undefined {
    return DraftPreviewPanel.current;
  }

  /**
   * Show `draft` (opening the tab, or redrawing the open one) and wait for
   * the viewer's next decision.
   */
  static show(extensionUri: vscode.Uri, draft: Draft, events: Partial<DraftPreviewEvents> = {}): Promise<DraftAnswer> {
    const preserveFocus = draft.trigger === 'sidebar';
    let page = DraftPreviewPanel.current;
    if (page && page.draft === draft) {
      // The same draft asked again (after a Keep that did not save): the page
      // keeps what it shows (its buttons and notice already came back), and a
      // choice made in between is answered now.
      page.events = events;
      page.answer({ kind: 'superseded' });
    } else if (page) {
      page.events = events;
      page.redraw(draft);
      page.panel.reveal(undefined, preserveFocus);
    } else {
      const panel = vscode.window.createWebviewPanel(
        DRAFT_PREVIEW_VIEW_TYPE,
        draft.title,
        { viewColumn: vscode.ViewColumn.Active, preserveFocus },
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
        },
      );
      page = new DraftPreviewPanel(panel, extensionUri, draft, events);
      DraftPreviewPanel.current = page;
    }
    return page.wait();
  }

  /** Run the onboarding guide's phase A on the open tab (Show Me Around). */
  startGuide(start: DraftGuideStart): void {
    this.guide = start;
    if (this.ready) this.postGuide();
  }

  private postGuide(): void {
    const start = this.guide;
    if (!start) return;
    this.post({
      type: 'guide',
      ...(start.nothingFound ? { nothingFound: true } : {}),
      ...(start.semanticDir !== undefined ? { semanticDir: start.semanticDir } : {}),
      ...(start.resumed ? { resumed: true } : {}),
    });
  }

  /** Close the open tab, if any (a pending `ask` resolves `closed`). */
  static close(): void {
    DraftPreviewPanel.current?.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    draft: Draft,
    events: Partial<DraftPreviewEvents>,
  ) {
    this.draft = draft;
    this.view = toDraftView(draft);
    this.events = events;
    const webview = panel.webview;
    this.dist = vscode.Uri.joinPath(extensionUri, 'dist');
    webview.html = this.pageHtml();
    this.readyWatch = new ReadyWatch(panel.visible !== false, {
      ready: (slow) => this.events.pageReady?.(this.view.source, slow),
      lateReady: (range) => this.events.lateReady?.(this.view.source, range),
      noReady: () => {
        this.events.noReady?.(this.view.source);
        // The page never mounted, so its crash screen cannot show: the host
        // offers the same two buttons in a notification.
        void askNoReadyRecovery('draft').then((action) => {
          if (!action || this.disposed) return;
          // The notification cannot be taken down, and the page has opened
          // since (#320): Reload would throw a working preview away, so it
          // does nothing, and Send Feedback is told the page is up.
          // A page that crashed after it opened keeps both buttons.
          if (this.ready && !this.crashed) {
            if (action === 'feedback') this.events.noReadyChoice?.(this.view.source, action, true);
            return;
          }
          if (action === 'reload') this.reloadPage();
          this.events.noReadyChoice?.(this.view.source, action);
        });
      },
    });
    this.disposables.push(
      webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message)),
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => this.readyWatch.visibility(e.webviewPanel.visible)),
    );
  }

  /** The page's HTML, with a fresh nonce (so a reload always changes it). */
  private pageHtml(): string {
    const webview = this.panel.webview;
    return buildDraftPreviewHtml({
      cspSource: webview.cspSource,
      nonce: crypto.randomBytes(16).toString('base64'),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.dist, 'draft.js')).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.dist, 'draft.css')).toString(),
      title: this.draft.title,
    });
  }

  /**
   * The crash screen's Reload: a new page for the same draft. Nothing the
   * flow waits on changes (the pending `ask` keeps waiting, a queued choice
   * stays queued); the new page says `ready` and is sent the draft and the
   * guide again.
   */
  private reloadPage(): void {
    if (this.disposed) return;
    // A page reloaded before it ever said ready: the ready that follows is the new page's (#320).
    this.readyWatch.reloaded();
    this.ready = false;
    this.crashed = false;
    this.layingOut = undefined;
    this.panel.webview.html = this.pageHtml();
  }

  /** Post the draft on show, noting that the page lays it out first when it has no stored positions. */
  private postDraft(): void {
    const laysOut = this.view.autoLayout && this.view.display.models.length > 0;
    this.layingOut = laysOut ? this.view.id : undefined;
    this.post({ type: 'draft', view: this.view });
  }

  /** The draft on show (tests). */
  get shownDraft(): Draft {
    return this.draft;
  }

  /** Take the open tab over with `draft`: the earlier `ask` is superseded. */
  private redraw(draft: Draft): void {
    this.answer({ kind: 'superseded' });
    this.draft = draft;
    this.view = toDraftView(draft);
    this.panel.title = draft.title;
    if (this.ready) this.postDraft();
  }

  /** Wait for the next decision on the draft on show. */
  private wait(): Promise<DraftAnswer> {
    this.generation += 1;
    const promise = new Promise<DraftAnswer>((resolve) => { this.pending = resolve; });
    const queued = this.queued;
    this.queued = undefined;
    if (queued && queued.viewId === this.view.id) this.choose(queued.message);
    return promise;
  }

  private answer(answer: DraftAnswer): boolean {
    const resolve = this.pending;
    this.pending = undefined;
    if (!resolve) return false;
    resolve(answer);
    return true;
  }

  private post(message: DraftToWebview): void {
    if (this.disposed) return;
    void Promise.resolve(this.panel.webview.postMessage(message)).catch((err: unknown) => {
      log.warn('Could not post to the draft preview:', err instanceof Error ? err.message : String(err));
    });
  }

  /** A message from the page: validated against the draft on show, then acted on. */
  handleMessage(raw: unknown): void {
    if (this.disposed) return;
    const message = parseDraftToHost(raw, draftAllowance(this.view), this.view.scopes?.current);
    if (!message) {
      const type = typeof raw === 'object' && raw !== null && typeof (raw as { type?: unknown }).type === 'string'
        ? (raw as { type: string }).type
        : typeof raw;
      log.warn(`Ignoring a message the draft on show does not allow (${type}).`);
      return;
    }
    if (DRAFT_PASSIVE_TYPES.has(message.type)) {
      this.passive(message);
      return;
    }
    if (!this.pending) {
      // Nobody is asking (a Keep that did not save, before the flow asks the
      // same draft again): keep the choice for that ask.
      this.queued = { viewId: this.view.id, message };
      return;
    }
    this.choose(message);
  }

  private passive(message: DraftToHost): void {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        // A fresh page (first load, a Reload, or one VS Code loaded again): not crashed.
        this.crashed = false;
        this.readyWatch.ready();
        this.postDraft();
        this.postGuide();
        return;
      case 'guide': {
        const { type: _type, ...action } = message;
        this.events.guide?.(action, this.view);
        return;
      }
      case 'detailsOpened':
        this.events.detailsOpened?.(this.view.source);
        return;
      case 'importReport':
        try {
          // The draft's own import (host only), never one the page names.
          this.events.importReport?.(this.view.source, this.draft.importReportId);
        } catch (err) {
          log.warn('The draft preview\'s Show Import Report failed:', err instanceof Error ? err.message : String(err));
        }
        return;
      case 'layoutFailed': {
        this.layingOut = undefined;
        const { type: _type, ...failure } = message;
        // The real counts and message, for the ERD Studio log only (never sent).
        log.warn(layoutFailureLogLine('draft', failure));
        // A page from before the detail sent the type alone.
        if (Object.keys(failure).length > 0) this.events.layoutFailed?.(this.view.source, failure);
        else this.events.layoutFailed?.(this.view.source);
        return;
      }
      case 'laidOut':
        // Only the draft being laid out: a late one for a draft since replaced says nothing.
        if (this.layingOut === message.id) this.layingOut = undefined;
        return;
      case 'layoutFinished': {
        this.layingOut = undefined;
        const { type: _type, ...layout } = message;
        this.events.layoutFinished?.(this.view.source, layout);
        return;
      }
      case 'pageError':
        // A render crash always ends on the crash screen (the page's root boundary).
        if (message.kind === 'render') this.crashed = true;
        this.events.pageError?.(this.view.source, message.kind);
        return;
      case 'crashFallback':
        if (message.action === 'reload') this.reloadPage();
        try {
          this.events.crashFallback?.(this.view.source, message.action, message.detail);
        } catch (err) {
          log.warn('The draft preview\'s crash screen action failed:', err instanceof Error ? err.message : String(err));
        }
        return;
      default:
        return;
    }
  }

  /** A choice, answered to the waiting `ask`. */
  private choose(message: DraftToHost): void {
    // A choice made while the layout runs is no abandoned page.
    this.layingOut = undefined;
    switch (message.type) {
      case 'keep': {
        const generation = this.generation;
        let settled = false;
        this.post({ type: 'busy', action: 'keep' });
        this.answer({
          kind: 'keep',
          settle: (outcome: DraftKeepOutcome) => {
            if (settled) return;
            settled = true;
            // A newer ask (a redraw, another flow) owns the page now.
            if (generation !== this.generation || this.disposed) return;
            if (outcome.kept) {
              this.dispose();
            } else {
              this.post(outcome.notice === undefined ? { type: 'idle' } : { type: 'idle', notice: outcome.notice });
            }
          },
        });
        return;
      }
      case 'scope':
        this.post({ type: 'busy', action: 'scope' });
        this.answer({ kind: 'scope', scopeId: message.scopeId });
        return;
      case 'changeOptions':
      case 'discard':
      case 'otherStart': {
        // The tab closes first, then the flow goes on (a command it runs opens over nothing).
        const resolve = this.pending;
        this.pending = undefined;
        this.dispose();
        if (message.type === 'otherStart') resolve?.({ kind: 'otherStart', start: message.start });
        else resolve?.({ kind: message.type });
        return;
      }
      default:
        return;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.readyWatch.dispose();
    if (this.layingOut !== undefined && this.layingOut === this.view.id) {
      try {
        this.events.closedWhileLayingOut?.(this.view.source);
      } catch {
        // Telemetry never stops the tab closing.
      }
    }
    this.layingOut = undefined;
    if (DraftPreviewPanel.current === this) DraftPreviewPanel.current = undefined;
    this.queued = undefined;
    this.answer({ kind: 'closed' });
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}

/**
 * The preview the wiring shares across every flow (one per extension host).
 * `events` receives the passive events of whichever draft is on show.
 */
export function createDraftPreview(extensionUri: vscode.Uri, events: Partial<DraftPreviewEvents> = {}): DraftPreview {
  return {
    ask: (draft) => DraftPreviewPanel.show(extensionUri, draft, events),
    isOpen: () => DraftPreviewPanel.currentPanel !== undefined,
    showing: () => DraftPreviewPanel.currentPanel?.shownDraft.id,
    close: () => DraftPreviewPanel.close(),
    startGuide: (start) => DraftPreviewPanel.currentPanel?.startGuide(start),
  };
}
