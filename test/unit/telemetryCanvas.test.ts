/**
 * The pure mapping from what webviews, core and the DBML reader report to
 * the 2.0 B13 / B14 / B17 telemetry keys (`src/services/telemetryCanvas.ts`):
 * fixed enums in, allowlisted keys out, never a message.
 */
import { describe, expect, it } from 'vitest';

import { SubjectAreaFileError, SubjectAreaValidationError, validateSubjectAreaDocument, LOADER_WARNING_CODES } from '@erd-studio/core';
import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';

import {
  CANVAS_LOAD_SLOW_MS,
  canvasLayoutTelemetry,
  layoutFailureCodes,
  layoutFailureLogLine,
  dbmlDiagramFeatures,
  draftLayoutFeatures,
  isUserFileProblem,
  loaderWarningFeatures,
  slowCanvasLoad,
  subjectAreaLoadDetailCode,
  tableFileDetailCode,
  webviewErrorCodes,
} from '../../src/services/telemetryCanvas';
import { ERROR_CODES, FEATURES } from '../../src/services/telemetryPayload';
import { LAYOUT_FAILURES, LAYOUT_FALLBACK_RUNGS, LAYOUT_REL_BUCKETS, LAYOUT_TABLE_BUCKETS, WEBVIEW_ERROR_AREAS, WEBVIEW_ERROR_KINDS, fitZoomBucket } from '../../src/types/webviewError';

const isFeature = (key: string) => (FEATURES as readonly string[]).includes(key);
const isError = (key: string) => (ERROR_CODES as readonly string[]).includes(key);

describe('webviewErrorCodes (B13)', () => {
  it('counts a render crash as the total plus its area', () => {
    expect(webviewErrorCodes('render', 'toolbar')).toEqual(['webviewCrash', 'webviewCrashToolbar']);
    expect(webviewErrorCodes('render', 'detailPanel')).toEqual(['webviewCrash', 'webviewCrashDetailPanel']);
    expect(webviewErrorCodes('render', 'draft')).toEqual(['webviewCrash', 'webviewCrashDraft']);
    expect(webviewErrorCodes('render', 'other')).toEqual(['webviewCrash', 'webviewCrashOther']);
  });

  it('counts an uncaught error and a rejection on their own, whatever the area', () => {
    expect(webviewErrorCodes('window', 'canvas')).toEqual(['webviewWindowError']);
    expect(webviewErrorCodes('rejection', 'draft')).toEqual(['webviewRejection']);
  });

  it('only ever returns allowlisted error codes', () => {
    for (const kind of WEBVIEW_ERROR_KINDS) {
      for (const area of [...WEBVIEW_ERROR_AREAS, 'draft' as const]) {
        for (const code of webviewErrorCodes(kind, area)) expect(isError(code), code).toBe(true);
      }
    }
  });
});

describe('canvasLayoutTelemetry (B17)', () => {
  it('records the failure class of a failed layout, other included, and how long it ran', () => {
    expect(canvasLayoutTelemetry({ ms: 30000, ok: false, failure: 'timeout' }).errors).toEqual(['layoutFailedTimeout', 'layoutFailedOver5s']);
    expect(canvasLayoutTelemetry({ ms: 10, ok: false, failure: 'worker' }).errors).toEqual(['layoutFailedWorker', 'layoutFailedUnder1s']);
    expect(canvasLayoutTelemetry({ ms: 1000, ok: false, failure: 'stack' }).errors).toEqual(['layoutFailedStack', 'layoutFailed1to5s']);
    expect(canvasLayoutTelemetry({ ms: 5000, ok: false, failure: 'other' }).errors).toEqual(['layoutFailedOther', 'layoutFailed1to5s']);
    expect(canvasLayoutTelemetry({ ms: 5001, ok: false, failure: 'memory' }).errors).toEqual(['layoutFailedMemory', 'layoutFailedOver5s']);
    expect(canvasLayoutTelemetry({ ms: 999, ok: false, failure: 'unsupported' }).errors).toEqual(['layoutFailedUnsupported', 'layoutFailedUnder1s']);
    expect(canvasLayoutTelemetry({ ms: 10, ok: false, failure: 'input' }).errors).toEqual(['layoutFailedInput', 'layoutFailedUnder1s']);
    expect(canvasLayoutTelemetry({ ms: 10, ok: false, failure: 'engine' }).errors).toEqual(['layoutFailedEngine', 'layoutFailedUnder1s']);
    expect(canvasLayoutTelemetry({ ms: 10, ok: false, failure: 'result' }).errors).toEqual(['layoutFailedResult', 'layoutFailedUnder1s']);
    // An older webview sends no failure: only the duration is known.
    expect(canvasLayoutTelemetry({ ms: 10, ok: false })).toEqual({ features: [], errors: ['layoutFailedUnder1s'] });
  });

  it('records the size buckets of a failed layout, one code each', () => {
    const tables = LAYOUT_TABLE_BUCKETS.map((tableBucket) => layoutFailureCodes({ tableBucket }));
    expect(tables).toEqual([['layoutFailedTablesUnder50'], ['layoutFailedTables50to199'], ['layoutFailedTables200to499'], ['layoutFailedTables500Plus']]);
    const rels = LAYOUT_REL_BUCKETS.map((relBucket) => layoutFailureCodes({ relBucket }));
    expect(rels).toEqual([['layoutFailedRelsUnder100'], ['layoutFailedRels100to499'], ['layoutFailedRels500to1999'], ['layoutFailedRels2000Plus']]);
  });

  it('records how far the fallbacks got', () => {
    // Every rung failed; the last one's class only when it adds something.
    expect(layoutFailureCodes({ failure: 'stack', exhausted: true, lastFailure: 'stack' })).toEqual(['layoutFailedStack', 'layoutFailedAllRungs']);
    expect(layoutFailureCodes({ failure: 'stack', exhausted: true, lastFailure: 'timeout' })).toEqual(['layoutFailedStack', 'layoutFailedAllRungs', 'layoutFailedLastRungTimeout']);
    expect(layoutFailureCodes({ failure: 'stack', exhausted: true, lastFailure: 'worker' })).toEqual(['layoutFailedStack', 'layoutFailedAllRungs', 'layoutFailedLastRungWorker']);
    expect(layoutFailureCodes({ failure: 'engine', exhausted: true, lastFailure: 'memory' })).toEqual(['layoutFailedEngine', 'layoutFailedAllRungs', 'layoutFailedLastRungMemory']);
    // A last-rung class without "every rung failed" says nothing.
    expect(layoutFailureCodes({ failure: 'timeout', lastFailure: 'timeout' })).toEqual(['layoutFailedTimeout']);
    // The rung that produced a layout is a feature of a finished layout only.
    expect(canvasLayoutTelemetry({ ms: 100, ok: true, fallback: true, rung: 2 }).features).toEqual(['layoutStackFallback', 'layoutFallbackRung2']);
    expect(canvasLayoutTelemetry({ ms: 100, ok: true, rung: 3 }).features).toEqual(['layoutFallbackRung3']);
    expect(canvasLayoutTelemetry({ ms: 100, ok: false, rung: 3 }).features).toEqual([]);
    expect(draftLayoutFeatures({ ms: 100, fitZoom: 'ok', fallback: true, rung: 3 })).toEqual(['draftLayoutFallback', 'layoutFallbackRung3']);
  });

  it('the customer\'s case in one record: 1,100 tables, a stack overflow, every fallback failed', () => {
    const out = canvasLayoutTelemetry({
      ms: 64000, ok: false, firstOpen: true, failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout',
    });
    expect(out).toEqual({
      features: [],
      errors: ['layoutFailedStack', 'layoutFailedTables500Plus', 'layoutFailedRels2000Plus', 'layoutFailedOver5s', 'layoutFailedAllRungs', 'layoutFailedLastRungTimeout'],
    });
  });

  it('never counts the log: the counts and the message reach no key', () => {
    const log = { tables: 1134, relationships: 2417, message: 'Referenced shape does not exist: dim_customer' };
    const out = canvasLayoutTelemetry({ ms: 12, ok: false, failure: 'input', tableBucket: '500plus', relBucket: '2000plus', log } as Parameters<typeof canvasLayoutTelemetry>[0]);
    expect(JSON.stringify(out)).not.toMatch(/1134|2417|dim_customer|Referenced/);
    expect(out.errors).toEqual(['layoutFailedInput', 'layoutFailedTables500Plus', 'layoutFailedRels2000Plus', 'layoutFailedUnder1s']);
  });

  it('the log line carries the real counts and message, for the local log only', () => {
    const failure = { failure: 'stack' as const, tableBucket: '500plus' as const, relBucket: '2000plus' as const, exhausted: true as const, lastFailure: 'timeout' as const,
      log: { tables: 1134, relationships: 2417, message: 'RangeError: Maximum call stack size exceeded' } };
    expect(layoutFailureLogLine('canvas', { ...failure, ms: 64000.4 })).toBe(
      'Auto layout failed (class stack, tables 500plus, relationships 2000plus, every fallback failed (last: timeout); 1134 tables, 2417 relationships; after 64000 ms): RangeError: Maximum call stack size exceeded');
    expect(layoutFailureLogLine('canvas', { ...failure, ms: 10, firstOpen: true })).toMatch(/^First-open auto layout failed \(/);
    expect(layoutFailureLogLine('draft', { ...failure, ms: 10 })).toMatch(/^Draft layout failed \(/);
    // An older page: no detail at all.
    expect(layoutFailureLogLine('draft', {})).toBe('Draft layout failed (class unknown, no fallback tried)');
  });

  it('flags the stack-safe fallback and a slow first-open layout', () => {
    expect(canvasLayoutTelemetry({ ms: 100, ok: true, fallback: true }).features).toEqual(['layoutStackFallback']);
    expect(canvasLayoutTelemetry({ ms: 5001, ok: true, firstOpen: true }).features).toEqual(['firstLayoutOver5s']);
    expect(canvasLayoutTelemetry({ ms: 5000, ok: true, firstOpen: true }).features).toEqual([]);
    // Not a user's own layout, and not a failed one.
    expect(canvasLayoutTelemetry({ ms: 9000, ok: true }).features).toEqual([]);
    expect(canvasLayoutTelemetry({ ms: 9000, ok: false, firstOpen: true }).features).toEqual([]);
  });

  it('only ever returns allowlisted keys', () => {
    for (const failure of LAYOUT_FAILURES) {
      const out = canvasLayoutTelemetry({ ms: 9000, ok: false, firstOpen: true, failure, fallback: true });
      for (const e of out.errors) expect(isError(e), e).toBe(true);
      for (const f of out.features) expect(isFeature(f), f).toBe(true);
    }
    for (const f of canvasLayoutTelemetry({ ms: 9000, ok: true, firstOpen: true, fallback: true }).features) expect(isFeature(f), f).toBe(true);
    // Every class, bucket, duration and rung has a key of its own, each on the right list.
    const errors = new Set<string>();
    for (const failure of LAYOUT_FAILURES) {
      for (const lastFailure of LAYOUT_FAILURES) {
        for (const code of layoutFailureCodes({ failure, exhausted: true, lastFailure })) errors.add(code);
      }
    }
    for (const tableBucket of LAYOUT_TABLE_BUCKETS) for (const code of layoutFailureCodes({ tableBucket })) errors.add(code);
    for (const relBucket of LAYOUT_REL_BUCKETS) for (const code of layoutFailureCodes({ relBucket })) errors.add(code);
    for (const ms of [0, 2000, 9000]) for (const code of layoutFailureCodes({ ms })) errors.add(code);
    for (const e of errors) expect(isError(e), e).toBe(true);
    // Exactly the layoutFailed* codes on the list, bar the total: none is recorded by nothing.
    expect([...errors].sort()).toEqual(ERROR_CODES.filter((c) => c.startsWith('layoutFailed') && c !== 'layoutFailed').sort());
    for (const rung of LAYOUT_FALLBACK_RUNGS) {
      for (const f of canvasLayoutTelemetry({ ms: 1, ok: true, rung }).features) expect(isFeature(f), f).toBe(true);
    }
    expect(FEATURES.filter((f) => f.startsWith('layoutFallbackRung'))).toEqual(['layoutFallbackRung2', 'layoutFallbackRung3']);
  });
});

describe('draftLayoutFeatures (B17)', () => {
  it('flags a slow layout, an unreadable fitted zoom and the fallback', () => {
    expect(draftLayoutFeatures({ ms: 200, fitZoom: 'ok' })).toEqual([]);
    expect(draftLayoutFeatures({ ms: 6000, fitZoom: 'under30', fallback: true }))
      .toEqual(['draftLayoutOver5s', 'draftFitZoomUnder30', 'draftLayoutFallback']);
    for (const f of draftLayoutFeatures({ ms: 6000, fitZoom: 'under30', fallback: true })) expect(isFeature(f)).toBe(true);
  });

  it('buckets the fitted zoom at 30 %', () => {
    expect(fitZoomBucket(0.29)).toBe('under30');
    expect(fitZoomBucket(0.3)).toBe('ok');
    expect(fitZoomBucket(1)).toBe('ok');
    expect(fitZoomBucket(Number.NaN)).toBe('ok');
  });
});

describe('slowCanvasLoad (B17)', () => {
  it('is more than 20 s', () => {
    expect(slowCanvasLoad(CANVAS_LOAD_SLOW_MS)).toBe(false);
    expect(slowCanvasLoad(CANVAS_LOAD_SLOW_MS + 1)).toBe(true);
    expect(slowCanvasLoad(Number.NaN)).toBe(false);
  });
});

const DIAGRAM = '/p/.erd-studio/gold/diagrams/sales.dbml';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected a throw');
}

describe('isUserFileProblem (review of B12)', () => {
  it('a broken, missing or locked diagram file is the user\'s', () => {
    expect(isUserFileProblem(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { dbmlErrorClass: 'syntax' }))).toBe(true);
    expect(isUserFileProblem(new SubjectAreaFileError('invalid-json', '/p/a.json', 'x'))).toBe(true);
    expect(isUserFileProblem(new SubjectAreaFileError('missing', '/p/a.json', 'x'))).toBe(true);
    expect(isUserFileProblem(new SubjectAreaValidationError('x', 'notADiagram'))).toBe(true);
    expect(isUserFileProblem(new SubjectAreaValidationError('x'))).toBe(true);
    expect(isUserFileProblem(thrown(() => parseSubjectAreaDbml('Table x {\n  id int [pk\n}\n', DIAGRAM)))).toBe(true);
  });

  it('a parser that threw, core\'s own TypeError and anything else are ours', () => {
    expect(isUserFileProblem(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { parserThrew: true }))).toBe(false);
    const wrapped = new SubjectAreaValidationError('x');
    Object.defineProperty(wrapped, 'cause', { value: new TypeError('y') });
    expect(isUserFileProblem(wrapped)).toBe(false);
    expect(isUserFileProblem(new TypeError('x'))).toBe(false);
    expect(isUserFileProblem('x')).toBe(false);
  });
});

describe('subjectAreaLoadDetailCode (B14)', () => {
  it('maps a DBML diagnostic class from core, never the message', () => {
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { dbmlErrorClass: 'syntax' }))).toBe('domainLoadDbmlSyntax');
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { dbmlErrorClass: 'binding' }))).toBe('domainLoadDbmlBinding');
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { dbmlErrorClass: 'invalid' }))).toBe('domainLoadDbmlInvalid');
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { dbmlErrorClass: 'interpreter' }))).toBe('domainLoadDbmlInvalid');
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { parserThrew: true }))).toBe('domainLoadDbmlParserThrew');
  });

  it('has no detail for a conflict, a JSON file or an error from an older core', () => {
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x', { mergeConflict: true, line: 3 }))).toBeUndefined();
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-json', '/p/a.json', 'x'))).toBeUndefined();
    expect(subjectAreaLoadDetailCode(new SubjectAreaFileError('invalid-dbml', DIAGRAM, 'x'))).toBeUndefined();
    expect(subjectAreaLoadDetailCode(new SubjectAreaValidationError('x'))).toBeUndefined();
    expect(subjectAreaLoadDetailCode(new TypeError('x'))).toBeUndefined();
  });

  it('maps the validation kind', () => {
    expect(subjectAreaLoadDetailCode(new SubjectAreaValidationError('x', 'newerSchema'))).toBe('domainLoadNewerSchema');
    expect(subjectAreaLoadDetailCode(new SubjectAreaValidationError('x', 'notADiagram'))).toBe('domainLoadNotADiagram');
    expect(subjectAreaLoadDetailCode(new SubjectAreaValidationError('x', 'legacyFormat'))).toBe('domainLoadLegacyFormat');
  });

  it('reads what core really throws', () => {
    expect(subjectAreaLoadDetailCode(thrown(() => parseSubjectAreaDbml('Table x {\n  id int [pk\n}\n', DIAGRAM)))).toBe('domainLoadDbmlSyntax');
    expect(subjectAreaLoadDetailCode(thrown(() => parseSubjectAreaDbml("Project p {\n  erd_schema_version: '99'\n}\n", DIAGRAM)))).toBe('domainLoadNewerSchema');
    expect(subjectAreaLoadDetailCode(thrown(() => validateSubjectAreaDocument({ schemaVersion: 99 }, '/p/x.json')))).toBe('domainLoadNewerSchema');
    expect(subjectAreaLoadDetailCode(thrown(() => parseSubjectAreaDbml('Project p {\n}\n', '/p/.erd-studio/gold/tables/x.dbml')))).toBe('domainLoadNotADiagram');
  });
});

describe('tableFileDetailCode (B14)', () => {
  it('maps ERD Studio table-file rules', () => {
    expect(tableFileDetailCode('dbmlStructure', 'structure:notOneTable')).toBe('modelFileDbmlNotOneTable');
    expect(tableFileDetailCode('dbmlStructure', 'structure:nameMismatch')).toBe('modelFileDbmlNameMismatch');
    expect(tableFileDetailCode('dbmlStructure', 'structure:unsupportedElement')).toBe('modelFileDbmlUnsupportedElement');
    expect(tableFileDetailCode('dbmlStructure', 'structure:metadataTarget')).toBe('modelFileDbmlMetadataTarget');
  });

  it('maps binder and interpreter diagnostics by their code range', () => {
    expect(tableFileDetailCode('dbmlStructure', '4001')).toBe('modelFileDbmlBinding');
    expect(tableFileDetailCode('dbmlInvalid', '5002')).toBe('modelFileDbmlInterpreter');
  });

  it('has no detail for YAML, a syntax or validator code, or no code', () => {
    expect(tableFileDetailCode('yamlScalar', 'BAD_SCALAR_START')).toBeUndefined();
    expect(tableFileDetailCode('dbmlSyntax', '1001')).toBeUndefined();
    expect(tableFileDetailCode('dbmlInvalid', '3025')).toBeUndefined();
    expect(tableFileDetailCode('dbmlInvalid', undefined)).toBeUndefined();
    expect(tableFileDetailCode('dbmlStructure', 'structure:somethingNew')).toBeUndefined();
  });
});

describe('dbmlDiagramFeatures (B14)', () => {
  it('flags nothing for a clean reading', () => {
    expect(dbmlDiagramFeatures({ writable: true })).toEqual([]);
  });

  it('flags each degraded render from the reading', () => {
    expect(dbmlDiagramFeatures({
      writable: false,
      holdsOwnTables: true,
      unlinked: ['a'],
      pending: [{ line: 3, relationships: [] }],
      layoutProblems: [
        { code: 'layoutBadLine', message: 'm', severity: 'warning' },
        { code: 'layoutDuplicateKey', message: 'm', severity: 'warning' },
        { code: 'layoutBadValue', message: 'm', severity: 'error' },
      ],
      layoutConflictLine: 9,
    })).toEqual([
      'dbmlLayoutBadLine', 'dbmlLayoutDuplicateKey', 'dbmlLayoutBadValue', 'dbmlLayoutConflict',
      'dbmlDiagramReadOnly', 'dbmlPendingRefs', 'dbmlUnlinkedTables', 'dbmlEmbeddedTablesShown',
    ]);
  });

  it('reads a real diagram holding its own Tables and a second Project', () => {
    const reading = parseSubjectAreaDbml('Table a {\n  id int [pk]\n}\nProject one {\n}\nProject two {\n}\n', DIAGRAM);
    const flags = dbmlDiagramFeatures(reading);
    expect(flags).toContain('dbmlEmbeddedTablesShown');
    expect(flags).toContain('dbmlDiagramReadOnly');
    for (const f of flags) expect(isFeature(f)).toBe(true);
  });
});

describe('loaderWarningFeatures (B14)', () => {
  it('flags a missing table and DBML from another tool', () => {
    expect(loaderWarningFeatures([])).toEqual([]);
    expect(loaderWarningFeatures(['other', 'layoutProblem'])).toEqual([]);
    expect(loaderWarningFeatures(['modelNotFound'])).toEqual(['diagramWarnModelNotFound']);
    expect(loaderWarningFeatures(['foreignDbml', 'inlineElement'])).toEqual(['diagramWarnForeignDbml']);
    expect(loaderWarningFeatures(['inlineElement'])).toEqual(['diagramWarnForeignDbml']);
    for (const f of loaderWarningFeatures(LOADER_WARNING_CODES)) expect(isFeature(f)).toBe(true);
  });
});
