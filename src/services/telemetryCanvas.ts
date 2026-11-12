/**
 * Usage telemetry for webviews, canvas loads and big diagrams (ERD Studio
 * 2.0 B13, B14, B17): the pure mapping from what a webview, core or a reader
 * reported to the fixed feature keys and error codes in `telemetryPayload.ts`.
 * Fixed enums in, fixed keys out: never a message, name, path or count.
 *
 * No `vscode` (the host wires these to `telemetry.feature` / `.error`), so
 * each mapping is unit-tested on its own.
 */

import {
  SubjectAreaFileError,
  SubjectAreaValidationError,
  type DbmlSubjectAreaReading,
  type LoaderWarningCode,
  type TableLoadErrorKind,
} from '@erd-studio/core';

import type { TelemetryErrorCode, TelemetryFeature } from './telemetryPayload';
import {
  layoutFailureDuration,
  layoutFailureSummary,
  type FitZoomBucket,
  type LayoutFailure,
  type LayoutFailureDetail,
  type LayoutFallbackRung,
  type LayoutRelBucket,
  type LayoutTableBucket,
  type WebviewCrashArea,
  type WebviewErrorKind,
} from '../types/webviewError';

// ---------------------------------------------------------------------------
// B13 — webview crashes
// ---------------------------------------------------------------------------

const CRASH_AREA_CODES: Record<WebviewCrashArea, TelemetryErrorCode> = {
  canvas: 'webviewCrashCanvas',
  detailPanel: 'webviewCrashDetailPanel',
  toolbar: 'webviewCrashToolbar',
  dialogs: 'webviewCrashDialogs',
  compare: 'webviewCrashCompare',
  guide: 'webviewCrashGuide',
  draft: 'webviewCrashDraft',
  other: 'webviewCrashOther',
};

/**
 * The error codes for one webview failure: a render crash is `webviewCrash`
 * (the total) plus its area's code; an uncaught error or an unhandled
 * rejection is its own code (the area is not counted for those).
 */
export function webviewErrorCodes(kind: WebviewErrorKind, area: WebviewCrashArea): TelemetryErrorCode[] {
  switch (kind) {
    case 'render': return ['webviewCrash', CRASH_AREA_CODES[area] ?? 'webviewCrashOther'];
    case 'window': return ['webviewWindowError'];
    case 'rejection': return ['webviewRejection'];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// B17 — layouts and slow loads
// ---------------------------------------------------------------------------

/** A canvas whose diagram took longer than this to post after `ready` counts as a slow load. */
export const CANVAS_LOAD_SLOW_MS = 20_000;

/** A layout (the canvas's first-open one, or a draft page's) longer than this counts as slow. */
export const LAYOUT_SLOW_MS = 5_000;

/** Whether a canvas load of `ms` (ready → diagram posted) was slow: `canvasLoadOver20s`. */
export function slowCanvasLoad(ms: number): boolean {
  return Number.isFinite(ms) && ms > CANVAS_LOAD_SLOW_MS;
}

const LAYOUT_FAILURE_CODES: Record<LayoutFailure, TelemetryErrorCode> = {
  timeout: 'layoutFailedTimeout',
  worker: 'layoutFailedWorker',
  stack: 'layoutFailedStack',
  other: 'layoutFailedOther',
  memory: 'layoutFailedMemory',
  unsupported: 'layoutFailedUnsupported',
  input: 'layoutFailedInput',
  engine: 'layoutFailedEngine',
  result: 'layoutFailedResult',
};

const LAYOUT_TABLE_BUCKET_CODES: Record<LayoutTableBucket, TelemetryErrorCode> = {
  under50: 'layoutFailedTablesUnder50',
  '50to199': 'layoutFailedTables50to199',
  '200to499': 'layoutFailedTables200to499',
  '500plus': 'layoutFailedTables500Plus',
};

const LAYOUT_REL_BUCKET_CODES: Record<LayoutRelBucket, TelemetryErrorCode> = {
  under100: 'layoutFailedRelsUnder100',
  '100to499': 'layoutFailedRels100to499',
  '500to1999': 'layoutFailedRels500to1999',
  '2000plus': 'layoutFailedRels2000Plus',
};

const LAYOUT_DURATION_CODES: Record<ReturnType<typeof layoutFailureDuration>, TelemetryErrorCode> = {
  under1s: 'layoutFailedUnder1s',
  '1to5s': 'layoutFailed1to5s',
  over5s: 'layoutFailedOver5s',
};

/** The last fallback's failure has a code only when it says something the first error's class does not. */
const LAYOUT_LAST_RUNG_CODES: Partial<Record<LayoutFailure, TelemetryErrorCode>> = {
  timeout: 'layoutFailedLastRungTimeout',
  worker: 'layoutFailedLastRungWorker',
  memory: 'layoutFailedLastRungMemory',
};

const LAYOUT_RUNG_FEATURES: Record<LayoutFallbackRung, TelemetryFeature> = {
  2: 'layoutFallbackRung2',
  3: 'layoutFallbackRung3',
};

/**
 * The codes that describe one failed layout, the canvas's (beside
 * `layoutFailed`) or a draft page's (beside `draftLayoutFailed`): its class,
 * the diagram's size buckets, how long it ran, and whether every fallback
 * failed (with the last one's class when that is a timeout, a dead worker or
 * memory). Only the fixed fields are read; `log` (the counts and the message,
 * for the extension's own log) is not a parameter here, so it cannot be
 * counted. A page from before these fields yields only what it sent.
 */
export function layoutFailureCodes(failure: Omit<LayoutFailureDetail, 'log'> & { ms?: number }): TelemetryErrorCode[] {
  const codes: TelemetryErrorCode[] = [];
  if (failure.failure) codes.push(LAYOUT_FAILURE_CODES[failure.failure]);
  if (failure.tableBucket) codes.push(LAYOUT_TABLE_BUCKET_CODES[failure.tableBucket]);
  if (failure.relBucket) codes.push(LAYOUT_REL_BUCKET_CODES[failure.relBucket]);
  if (failure.ms !== undefined && Number.isFinite(failure.ms)) codes.push(LAYOUT_DURATION_CODES[layoutFailureDuration(failure.ms)]);
  if (failure.exhausted === true) {
    codes.push('layoutFailedAllRungs');
    const last = failure.lastFailure ? LAYOUT_LAST_RUNG_CODES[failure.lastFailure] : undefined;
    if (last) codes.push(last);
  }
  return codes.filter((code): code is TelemetryErrorCode => code !== undefined);
}

/** The feature for the fallback that produced a layout, if one did. */
export function layoutRungFeature(rung: LayoutFallbackRung | undefined): TelemetryFeature | undefined {
  return rung === undefined ? undefined : LAYOUT_RUNG_FEATURES[rung];
}

/**
 * The 2.0 keys for a canvas `layoutFinished` (beside the bucket and the
 * `layoutFailed` / `firstLayoutFailed` errors it already records): a failed
 * layout's {@link layoutFailureCodes}, the stack-safe fallback, the fallback
 * that produced the layout, and a slow first-open layout.
 */
export function canvasLayoutTelemetry(payload: Omit<LayoutFailureDetail, 'log'> & {
  ms: number; ok: boolean; firstOpen?: boolean; fallback?: true; rung?: LayoutFallbackRung;
}): { features: TelemetryFeature[]; errors: TelemetryErrorCode[] } {
  const features: TelemetryFeature[] = [];
  const errors: TelemetryErrorCode[] = payload.ok ? [] : layoutFailureCodes(payload);
  if (payload.fallback === true) features.push('layoutStackFallback');
  const rung = payload.ok ? layoutRungFeature(payload.rung) : undefined;
  if (rung) features.push(rung);
  if (payload.firstOpen === true && payload.ok && payload.ms > LAYOUT_SLOW_MS) features.push('firstLayoutOver5s');
  return { features, errors };
}

/**
 * The keys for a draft page's finished layout: slow, too small to read when
 * fitted, laid out with the stack-safe fallback, and the fallback that
 * produced it.
 */
export function draftLayoutFeatures(payload: { ms: number; fitZoom: FitZoomBucket; fallback?: true; rung?: LayoutFallbackRung }): TelemetryFeature[] {
  const features: TelemetryFeature[] = [];
  if (payload.ms > LAYOUT_SLOW_MS) features.push('draftLayoutOver5s');
  if (payload.fitZoom === 'under30') features.push('draftFitZoomUnder30');
  if (payload.fallback === true) features.push('draftLayoutFallback');
  const rung = layoutRungFeature(payload.rung);
  if (rung) features.push(rung);
  return features;
}

/**
 * One line for the extension's own log about a failed layout: its fixed
 * summary, and from `log` the real counts and the error's message. Local
 * only: nothing here is sent anywhere.
 */
export function layoutFailureLogLine(where: 'canvas' | 'draft', failure: LayoutFailureDetail & { ms?: number; firstOpen?: boolean }): string {
  const origin = where === 'draft' ? 'Draft layout' : failure.firstOpen ? 'First-open auto layout' : 'Auto layout';
  const size = failure.log ? `; ${failure.log.tables} tables, ${failure.log.relationships} relationships` : '';
  const ran = failure.ms !== undefined && Number.isFinite(failure.ms) ? `; after ${Math.round(failure.ms)} ms` : '';
  const message = failure.log?.message ? `: ${failure.log.message}` : '';
  return `${origin} failed (${layoutFailureSummary(failure)}${size}${ran})${message}`;
}

// ---------------------------------------------------------------------------
// B14 — why a diagram did not load, and diagrams that render degraded
// ---------------------------------------------------------------------------

/**
 * The 2.0 detail code for a canvas load failure, from core's fixed fields
 * only (never the message): a DBML diagram's diagnostic class or a parser
 * that threw, or the validation refusal's kind. Undefined for anything else
 * (the existing `domainLoad*` sub-code already says what it was).
 */
export function subjectAreaLoadDetailCode(err: unknown): TelemetryErrorCode | undefined {
  if (err instanceof SubjectAreaFileError) {
    if (err.reason !== 'invalid-dbml' || err.mergeConflict) return undefined;
    if (err.parserThrew) return 'domainLoadDbmlParserThrew';
    switch (err.dbmlErrorClass) {
      case 'syntax': return 'domainLoadDbmlSyntax';
      case 'binding': return 'domainLoadDbmlBinding';
      case 'invalid':
      case 'interpreter': return 'domainLoadDbmlInvalid';
      default: return undefined;
    }
  }
  if (err instanceof SubjectAreaValidationError) {
    switch (err.kind) {
      case 'newerSchema': return 'domainLoadNewerSchema';
      case 'notADiagram': return 'domainLoadNotADiagram';
      case 'legacyFormat': return 'domainLoadLegacyFormat';
      default: return undefined;
    }
  }
  return undefined;
}

/**
 * Whether a canvas handler's failure is the diagram file itself (a file the
 * user or an assistant broke, removed or locked), not ERD Studio: core's
 * `SubjectAreaFileError` unless its DBML parser threw, and a
 * `SubjectAreaValidationError` unless core wrapped its own `TypeError` in it.
 * The load path already files these under the user's environment (B14:
 * `domainLoadBlocking` / `domainLoadOverLive`); a stage switch or a
 * comparison that meets the same file must not count it as ours.
 */
export function isUserFileProblem(err: unknown): boolean {
  if (err instanceof SubjectAreaFileError) return err.parserThrew !== true;
  if (err instanceof SubjectAreaValidationError) return !((err as { cause?: unknown }).cause instanceof TypeError);
  return false;
}

const STRUCTURE_RULE_CODES: Record<string, TelemetryErrorCode> = {
  'structure:notOneTable': 'modelFileDbmlNotOneTable',
  'structure:nameMismatch': 'modelFileDbmlNameMismatch',
  'structure:unsupportedElement': 'modelFileDbmlUnsupportedElement',
  'structure:metadataTarget': 'modelFileDbmlMetadataTarget',
};

/**
 * The 2.0 detail code for a broken `.dbml` table file (beside
 * `modelFileParse` and `tableFileErrorCode(kind)`): ERD Studio's own
 * table-file rule, or a DBML binding / interpreter diagnostic, from the
 * error's fixed `code` (`structure:<rule>` or a DBML diagnostic number as
 * text). Undefined for a YAML file, a syntax error or a code it does not know.
 */
export function tableFileDetailCode(kind: TableLoadErrorKind, code: string | undefined): TelemetryErrorCode | undefined {
  if (!kind.startsWith('dbml') || code === undefined) return undefined;
  const rule = STRUCTURE_RULE_CODES[code];
  if (rule) return rule;
  if (!/^\d+$/.test(code)) return undefined;
  // dbmlErrorClassOf's ranges: the binder's 4000s (core files them as a
  // dbmlStructure) and the interpreter's 5000 and up (a dbmlInvalid).
  const n = Number(code);
  if (n >= 4000 && n < 5000) return 'modelFileDbmlBinding';
  if (n >= 5000) return 'modelFileDbmlInterpreter';
  return undefined;
}

/** The parts of a DBML diagram's reading the degraded-render flags come from. */
export type DbmlReadingFlags = Pick<
  DbmlSubjectAreaReading,
  'writable' | 'holdsOwnTables' | 'unlinked' | 'pending' | 'layoutProblems' | 'layoutConflictLine'
>;

/**
 * What a DBML diagram's reading says about how it renders, as presence
 * flags for a canvas open: `erd_layout` lines it could not read, a key twice,
 * a bad value or conflict markers; a diagram ERD Studio will not edit (a
 * repeated Note name, a second Project); relationships waiting for their
 * tables; tables with no file to link; and a diagram holding its own Tables.
 */
export function dbmlDiagramFeatures(reading: DbmlReadingFlags): TelemetryFeature[] {
  const features: TelemetryFeature[] = [];
  const problems = new Set((reading.layoutProblems ?? []).map((p) => p.code));
  if (problems.has('layoutBadLine')) features.push('dbmlLayoutBadLine');
  if (problems.has('layoutDuplicateKey')) features.push('dbmlLayoutDuplicateKey');
  if (problems.has('layoutBadValue')) features.push('dbmlLayoutBadValue');
  if (problems.has('layoutMergeConflict') || reading.layoutConflictLine !== undefined) features.push('dbmlLayoutConflict');
  if (reading.writable === false) features.push('dbmlDiagramReadOnly');
  if ((reading.pending?.length ?? 0) > 0) features.push('dbmlPendingRefs');
  if ((reading.unlinked?.length ?? 0) > 0) features.push('dbmlUnlinkedTables');
  if (reading.holdsOwnTables === true) features.push('dbmlEmbeddedTablesShown');
  return features;
}

/**
 * The flags a diagram's loader warnings raise (any storage): a table it
 * names that was not found, and DBML from another tool (its own Tables, or
 * an Enum, TableGroup, … or Metadata block declared in the diagram).
 */
export function loaderWarningFeatures(codes: Iterable<LoaderWarningCode>): TelemetryFeature[] {
  const seen = new Set(codes);
  const features: TelemetryFeature[] = [];
  if (seen.has('modelNotFound')) features.push('diagramWarnModelNotFound');
  if (seen.has('foreignDbml') || seen.has('inlineElement')) features.push('diagramWarnForeignDbml');
  return features;
}
