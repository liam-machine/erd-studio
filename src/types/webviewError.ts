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

/**
 * How long after its panel was shown a page said `ready`, when that came
 * after the 30 s no-ready timeout (`ReadyWatch`'s `lateReady`, #320): under a
 * minute, or a minute or more.
 */
export type LateReadyRange = '30to60s' | 'over60s';

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
 * of `webview/lib/elkLayout.ts`'s errors and the engine's own fixed text
 * (never sent as text): the 30 s guard (`timeout`), the worker dying
 * (`worker`), the worker's stack overflowing (`stack`), the engine running
 * out of memory or asking for an array it cannot have (`memory`), ELK
 * refusing the options or the graph's shape (`unsupported`), ELK refusing the
 * graph it was handed (`input`: a relationship whose table is not in it),
 * another exception of the engine's own (`engine`), a result with a table
 * left unplaced (`result`), or anything else (`other`). Append-only.
 */
export const LAYOUT_FAILURES = ['timeout', 'worker', 'stack', 'other', 'memory', 'unsupported', 'input', 'engine', 'result'] as const;
export type LayoutFailure = (typeof LAYOUT_FAILURES)[number];

export function isLayoutFailure(value: unknown): value is LayoutFailure {
  return typeof value === 'string' && (LAYOUT_FAILURES as readonly string[]).includes(value);
}

/** V8's and Firefox's own words for a stack overflow. */
const STACK_OVERFLOW_TEXT = /Maximum call stack size exceeded|too much recursion/i;

/** The engines' own words for memory running out, or an array or string too long to allocate. */
const OUT_OF_MEMORY_TEXT = /out of memory|Invalid (?:typed )?array length|Invalid array buffer length|Array buffer allocation failed|Invalid string length|allocation size overflow/i;

/** elkjs starts a Java exception's message with its class name: `org.eclipse.elk.core.UnsupportedGraphException: …`. */
const JAVA_CLASS_PREFIX = /^((?:[a-z_][a-z0-9_]*\.)+[A-Z][A-Za-z0-9_$]*)(?::|$)/;

/** ELK's exception classes (engine constants) with a class of their own; any other Java exception is `engine`. */
const ELK_EXCEPTION_CLASSES: Readonly<Record<string, LayoutFailure>> = {
  'org.eclipse.elk.core.UnsupportedConfigurationException': 'unsupported',
  'org.eclipse.elk.core.UnsupportedGraphException': 'unsupported',
  'org.eclipse.elk.graph.json.JsonImportException': 'input',
};

/** Whether an error's text is a stack overflow's (V8: RangeError, Firefox: InternalError). */
export function isStackOverflowText(message: string): boolean {
  return STACK_OVERFLOW_TEXT.test(message);
}

/**
 * The class of a layout error that carries no tag of this module's own, from
 * its `name` and the fixed, engine-owned start or wording of its `message`.
 * The text is only matched here, in the page; the class is all that leaves.
 */
export function classifyLayoutErrorText(name: string, message: string): LayoutFailure {
  if (STACK_OVERFLOW_TEXT.test(message)) return 'stack';
  if (OUT_OF_MEMORY_TEXT.test(message) || name === 'RangeError') return 'memory';
  const javaClass = JAVA_CLASS_PREFIX.exec(message)?.[1];
  if (javaClass !== undefined) return ELK_EXCEPTION_CLASSES[javaClass] ?? 'engine';
  return 'other';
}

/** How many tables a diagram whose layout failed had, as a bucket (never the number). */
export const LAYOUT_TABLE_BUCKETS = ['under50', '50to199', '200to499', '500plus'] as const;
export type LayoutTableBucket = (typeof LAYOUT_TABLE_BUCKETS)[number];

/** How many relationships it had, as a bucket. */
export const LAYOUT_REL_BUCKETS = ['under100', '100to499', '500to1999', '2000plus'] as const;
export type LayoutRelBucket = (typeof LAYOUT_REL_BUCKETS)[number];

export function layoutTableBucket(tables: number): LayoutTableBucket {
  if (!(tables >= 50)) return 'under50';
  if (tables < 200) return '50to199';
  if (tables < 500) return '200to499';
  return '500plus';
}

export function layoutRelBucket(relationships: number): LayoutRelBucket {
  if (!(relationships >= 100)) return 'under100';
  if (relationships < 500) return '100to499';
  if (relationships < 2000) return '500to1999';
  return '2000plus';
}

/**
 * The fallback that produced a layout whose default attempt failed
 * (`stackSafeFallbacks` in `webview/lib/elkLayout.ts`), named by what it
 * drops: 2 is Brandes–Köpf node placement, 3 also leaves post-compaction out.
 * The later steps (the same with grouping off, and the grid that needs no
 * ELK, which also lays out a diagram too large to try) are reported as 3
 * until telemetry has keys of their own; the extension's log names them.
 */
export const LAYOUT_FALLBACK_RUNGS = [2, 3] as const;
export type LayoutFallbackRung = (typeof LAYOUT_FALLBACK_RUNGS)[number];

export function isLayoutFallbackRung(value: unknown): value is LayoutFallbackRung {
  return value === 2 || value === 3;
}

/** The largest table or relationship count a failed layout may report for the local log. */
export const LAYOUT_LOG_COUNT_MAX = 1_000_000;

/** The longest error message a failed layout may report for the local log. */
export const LAYOUT_LOG_MESSAGE_MAX = 500;

/**
 * What a failed layout says for the extension's own log, and for nothing
 * else: the real counts and the error's message. A layout that worked but not
 * as asked (a fallback, the grid) sends one too, its `message` saying what
 * happened. Never read by telemetry.
 */
export interface LayoutFailureLog {
  tables: number;
  relationships: number;
  message: string;
}

/**
 * What a page says about a failed layout. Everything but `log` is a fixed
 * enum (the only fields telemetry reads): its class, the diagram's size as
 * buckets worked out in the page, whether every fallback was tried and
 * failed (`exhausted`) and the class of the last one's failure. All optional:
 * a page from before these fields sends none.
 */
export interface LayoutFailureDetail {
  failure?: LayoutFailure;
  tableBucket?: LayoutTableBucket;
  relBucket?: LayoutRelBucket;
  exhausted?: true;
  lastFailure?: LayoutFailure;
  log?: LayoutFailureLog;
}

function isLogCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LAYOUT_LOG_COUNT_MAX;
}

function readLayoutFailureLog(raw: unknown): LayoutFailureLog | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { tables, relationships, message } = raw as { tables?: unknown; relationships?: unknown; message?: unknown };
  if (!isLogCount(tables) || !isLogCount(relationships)) return undefined;
  if (typeof message !== 'string' || message.length > LAYOUT_LOG_MESSAGE_MAX) return undefined;
  return { tables, relationships, message };
}

/**
 * The {@link LayoutFailureDetail} fields of a message, rebuilt from the
 * checked values only. Undefined when a field that is present is not one of
 * its fixed values (or a count is out of range): the message is then refused,
 * never trimmed into shape. A message with none of the fields reads as `{}`.
 */
export function readLayoutFailureDetail(raw: unknown): LayoutFailureDetail | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { failure, tableBucket, relBucket, exhausted, lastFailure, log } = raw as Record<string, unknown>;
  const detail: LayoutFailureDetail = {};
  if (failure !== undefined) {
    if (!isLayoutFailure(failure)) return undefined;
    detail.failure = failure;
  }
  if (tableBucket !== undefined) {
    if (typeof tableBucket !== 'string' || !(LAYOUT_TABLE_BUCKETS as readonly string[]).includes(tableBucket)) return undefined;
    detail.tableBucket = tableBucket as LayoutTableBucket;
  }
  if (relBucket !== undefined) {
    if (typeof relBucket !== 'string' || !(LAYOUT_REL_BUCKETS as readonly string[]).includes(relBucket)) return undefined;
    detail.relBucket = relBucket as LayoutRelBucket;
  }
  if (exhausted !== undefined) {
    if (exhausted !== true) return undefined;
    detail.exhausted = true;
  }
  if (lastFailure !== undefined) {
    if (!isLayoutFailure(lastFailure)) return undefined;
    detail.lastFailure = lastFailure;
  }
  if (log !== undefined) {
    const checked = readLayoutFailureLog(log);
    if (!checked) return undefined;
    detail.log = checked;
  }
  return detail;
}

/** How long a layout ran before it failed, as the bucket the layout-time keys use. */
export function layoutFailureDuration(ms: number): 'under1s' | '1to5s' | 'over5s' {
  if (ms < 1000) return 'under1s';
  if (ms <= 5000) return '1to5s';
  return 'over5s';
}

/**
 * A failed layout in fixed words only (its class, size buckets, how far the
 * fallbacks got, how long it ran): what the Send Feedback diagnostics show.
 * Never a count, a name or the error's text.
 */
export function layoutFailureSummary(detail: LayoutFailureDetail, ms?: number): string {
  const parts = [`class ${detail.failure ?? 'unknown'}`];
  if (detail.tableBucket) parts.push(`tables ${detail.tableBucket}`);
  if (detail.relBucket) parts.push(`relationships ${detail.relBucket}`);
  parts.push(detail.exhausted
    ? `every fallback failed${detail.lastFailure ? ` (last: ${detail.lastFailure})` : ''}`
    : 'no fallback tried');
  if (ms !== undefined && Number.isFinite(ms)) parts.push(`ran ${layoutFailureDuration(ms)}`);
  return parts.join(', ');
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
