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
import type { FitZoomBucket, LayoutFailure, WebviewCrashArea, WebviewErrorKind } from '../types/webviewError';

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

const LAYOUT_FAILURE_CODES: Partial<Record<LayoutFailure, TelemetryErrorCode>> = {
  timeout: 'layoutFailedTimeout',
  worker: 'layoutFailedWorker',
  stack: 'layoutFailedStack',
};

/**
 * The 2.0 keys for a canvas `layoutFinished` (beside the bucket and the
 * `layoutFailed` / `firstLayoutFailed` errors it already records): the
 * failure's class (`other` has no code of its own), the stack-safe fallback,
 * and a slow first-open layout.
 */
export function canvasLayoutTelemetry(payload: {
  ms: number; ok: boolean; firstOpen?: boolean; failure?: LayoutFailure; fallback?: true;
}): { features: TelemetryFeature[]; errors: TelemetryErrorCode[] } {
  const features: TelemetryFeature[] = [];
  const errors: TelemetryErrorCode[] = [];
  if (!payload.ok && payload.failure) {
    const code = LAYOUT_FAILURE_CODES[payload.failure];
    if (code) errors.push(code);
  }
  if (payload.fallback === true) features.push('layoutStackFallback');
  if (payload.firstOpen === true && payload.ok && payload.ms > LAYOUT_SLOW_MS) features.push('firstLayoutOver5s');
  return { features, errors };
}

/** The keys for a draft page's finished layout: slow, too small to read when fitted, laid out with the stack-safe fallback. */
export function draftLayoutFeatures(payload: { ms: number; fitZoom: FitZoomBucket; fallback?: true }): TelemetryFeature[] {
  const features: TelemetryFeature[] = [];
  if (payload.ms > LAYOUT_SLOW_MS) features.push('draftLayoutOver5s');
  if (payload.fitZoom === 'under30') features.push('draftFitZoomUnder30');
  if (payload.fallback === true) features.push('draftLayoutFallback');
  return features;
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
