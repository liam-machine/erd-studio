/**
 * Webview crash reporting (ERD Studio 2.0 B13), shared by the canvas
 * (`webview/`) and the draft page (`webview-draft/`). Nothing here changes
 * what the user sees: a render crash still blanks the page as it always did
 * (the area boundaries only tag the error on its way up, then rethrow it), and
 * the host is told only the crash's kind and area — never its text, stack or
 * a name. The text stays in the page (the Send Feedback dialog's recent
 * errors, which the user reads before anything is sent).
 *
 * Listeners are installed once per page, outside React, so they still hear
 * the error React rethrows after it has unmounted the tree.
 */

import type { WebviewCrashArea, WebviewErrorKind } from '../../src/types/webviewError';

/** The area each render error started in: the innermost boundary it passed tags it first. */
const crashAreas = new WeakMap<object, WebviewCrashArea>();

/** Tag `error` with `area`, unless a boundary inside this one already did. */
export function tagCrashArea(error: unknown, area: WebviewCrashArea): void {
  if (typeof error === 'object' && error !== null && !crashAreas.has(error)) crashAreas.set(error, area);
}

/** The area `error` was tagged with by an area boundary, if any. */
export function crashAreaOf(error: unknown): WebviewCrashArea | undefined {
  return typeof error === 'object' && error !== null ? crashAreas.get(error) : undefined;
}

/** At most this many reports of each kind per page. */
export const MAX_WEBVIEW_ERROR_REPORTS = 5;

/** Errors that are noise, not faults: matched against the text locally, which never leaves the page. */
const BENIGN_ERROR = /ResizeObserver loop/i;

export type WebviewErrorReporter = (kind: WebviewErrorKind, area: WebviewCrashArea) => void;

/**
 * Listen for uncaught errors and unhandled rejections on `target` (the
 * window) and report each one's kind: a render crash tagged by an area
 * boundary as `render` in its area, anything else as `window` or
 * `rejection` in `fallbackArea`. The same error object is reported once; at
 * most {@link MAX_WEBVIEW_ERROR_REPORTS} of each kind; a `ResizeObserver
 * loop` error is dropped. The check waits a tick, so a boundary that tags
 * the error later in the same render pass is seen. Returns the uninstaller.
 */
export function installWebviewErrorReporting(
  report: WebviewErrorReporter,
  fallbackArea: WebviewCrashArea,
  target: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
): () => void {
  const counts: Record<WebviewErrorKind, number> = { render: 0, window: 0, rejection: 0 };
  const reported = new WeakSet<object>();
  const send = (kind: WebviewErrorKind, area: WebviewCrashArea): void => {
    if (counts[kind] >= MAX_WEBVIEW_ERROR_REPORTS) return;
    counts[kind] += 1;
    try {
      report(kind, area);
    } catch {
      // Reporting never adds an error of its own.
    }
  };
  const onError = (event: Event): void => {
    const { error, message } = event as ErrorEvent;
    setTimeout(() => {
      if (typeof error === 'object' && error !== null) {
        if (reported.has(error)) return;
        reported.add(error);
      }
      const area = crashAreaOf(error);
      if (area) {
        send('render', area);
        return;
      }
      const text = typeof message === 'string' && message !== '' ? message : error instanceof Error ? error.message : '';
      if (BENIGN_ERROR.test(text)) return;
      send('window', fallbackArea);
    }, 0);
  };
  const onRejection = (event: Event): void => {
    const reason = (event as PromiseRejectionEvent).reason as unknown;
    if (typeof reason === 'object' && reason !== null) {
      if (reported.has(reason)) return;
      reported.add(reason);
    }
    send('rejection', fallbackArea);
  };
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}
