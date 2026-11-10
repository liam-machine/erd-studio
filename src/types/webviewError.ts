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

/**
 * The two buttons of the screen a webview shows after a render crash (the
 * canvas's and the draft page's crash fallback): `reload` the panel, or open
 * Send Feedback. The page sends the choice; the host acts on it.
 */
export const CRASH_FALLBACK_ACTIONS = ['reload', 'feedback'] as const;
export type CrashFallbackAction = (typeof CRASH_FALLBACK_ACTIONS)[number];

export function isCrashFallbackAction(value: unknown): value is CrashFallbackAction {
  return typeof value === 'string' && (CRASH_FALLBACK_ACTIONS as readonly string[]).includes(value);
}

/**
 * The longest crash `detail` a page may send (the error's first line, paths
 * already reduced to their shape by `redactPaths`). It goes only into the
 * Send Feedback prefill the user reads before anything is sent; never into
 * telemetry.
 */
export const CRASH_DETAIL_MAX = 300;

/**
 * The `crashFallback` payload (canvas → host): the button pressed, and for
 * `feedback` where the crash started and its first line, for the report's
 * prefill only.
 */
export interface CrashFallbackPayload {
  action: CrashFallbackAction;
  area?: WebviewErrorArea;
  detail?: string;
}

/**
 * A caught crash's first line, uncut and unredacted (at most
 * {@link CRASH_FIRST_LINE_MAX} characters, so redaction never works on a huge
 * message). Never the stack: the report's reader gets what the error said,
 * and the stack's file URLs say nothing of the user's.
 */
export function crashFirstLineOf(error: unknown): string {
  const raw = error instanceof Error
    ? (error.name && error.name !== 'Error' ? `${error.name}: ${error.message}` : error.message)
    : typeof error === 'string' ? error : '';
  return (raw.split('\n', 1)[0]?.trim() ?? '').slice(0, CRASH_FIRST_LINE_MAX);
}

/** How much of a crash's first line is looked at before it is redacted and cut. */
export const CRASH_FIRST_LINE_MAX = 4 * CRASH_DETAIL_MAX;

/**
 * Cut an already-redacted crash detail to {@link CRASH_DETAIL_MAX}
 * characters, ending on `…`. A cut never leaves half a `redactPaths`
 * placeholder (`{pa`): it steps back to before the open brace.
 */
export function cutCrashDetail(text: string): string {
  if (text.length <= CRASH_DETAIL_MAX) return text;
  let cut = text.slice(0, CRASH_DETAIL_MAX - 1);
  const open = cut.lastIndexOf('{');
  if (open > cut.lastIndexOf('}')) cut = cut.slice(0, open);
  return `${cut.trimEnd()}…`;
}

/**
 * A caught crash's first line, cut to {@link CRASH_DETAIL_MAX} characters.
 * The crash screen redacts before it cuts (`caughtCrashOf`), since
 * `redactPaths` can make the text longer.
 */
export function crashDetailOf(error: unknown): string {
  return cutCrashDetail(crashFirstLineOf(error));
}
