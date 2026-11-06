/**
 * What a webview may say about its own crashes and its layouts (usage
 * telemetry only, 2.0 B13 / B17): fixed enums, never an error's text, stack or
 * a name. The canvas (`webview/`) posts `webviewError`, the draft page
 * (`webview-draft/`) posts `pageError`; both are checked against these lists
 * at the host boundary (`payloadValidation.ts`, `parseDraftToHost`).
 *
 * Pure, vscode-free and Node-free: compiled by both tsconfigs (the webview's
 * includes `src/types/**`); never imports from `services/`.
 */

/**
 * How a webview failed: a React render crash caught by an area boundary
 * (`render`), an uncaught error (`window`) or an unhandled promise rejection
 * (`rejection`).
 */
export const WEBVIEW_ERROR_KINDS = ['render', 'window', 'rejection'] as const;
export type WebviewErrorKind = (typeof WEBVIEW_ERROR_KINDS)[number];

/** Where on the canvas a render crash started (the innermost area boundary around it). */
export const WEBVIEW_ERROR_AREAS = ['canvas', 'detailPanel', 'toolbar', 'dialogs', 'compare', 'guide', 'other'] as const;
export type WebviewErrorArea = (typeof WEBVIEW_ERROR_AREAS)[number];

/** Every area a boundary can name: the canvas's, plus the draft page's one. */
export type WebviewCrashArea = WebviewErrorArea | 'draft';

/** The `webviewError` payload (canvas → host). */
export interface WebviewErrorPayload {
  kind: WebviewErrorKind;
  area: WebviewErrorArea;
}

export function isWebviewErrorKind(value: unknown): value is WebviewErrorKind {
  return typeof value === 'string' && (WEBVIEW_ERROR_KINDS as readonly string[]).includes(value);
}

export function isWebviewErrorArea(value: unknown): value is WebviewErrorArea {
  return typeof value === 'string' && (WEBVIEW_ERROR_AREAS as readonly string[]).includes(value);
}

/**
 * Why an auto layout failed, classified in the webview from the known shapes
 * of `webview/lib/elkLayout.ts`'s errors: the 30 s guard (`timeout`), the
 * worker dying (`worker`), the worker's stack overflowing even with the
 * stack-safe placement (`stack`), or anything else (`other`).
 */
export const LAYOUT_FAILURES = ['timeout', 'worker', 'stack', 'other'] as const;
export type LayoutFailure = (typeof LAYOUT_FAILURES)[number];

export function isLayoutFailure(value: unknown): value is LayoutFailure {
  return typeof value === 'string' && (LAYOUT_FAILURES as readonly string[]).includes(value);
}

/** The draft page's fitted zoom after its layout, bucketed: below 30 % the tables are too small to read. */
export const FIT_ZOOM_BUCKETS = ['under30', 'ok'] as const;
export type FitZoomBucket = (typeof FIT_ZOOM_BUCKETS)[number];

/** The zoom (1 = 100 %) below which a fitted draft counts as too small to read. */
export const FIT_ZOOM_READABLE = 0.3;

export function fitZoomBucket(zoom: number): FitZoomBucket {
  return Number.isFinite(zoom) && zoom < FIT_ZOOM_READABLE ? 'under30' : 'ok';
}
