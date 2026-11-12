/**
 * What a page may say about a failed auto layout (`src/types/webviewError.ts`):
 * the failure's class from the error's type and the engine's own fixed text,
 * the diagram's size as buckets, the duration bucket, and the check that
 * rebuilds the detail at the host boundary. Fixed values out; the text and
 * the counts never reach a field telemetry reads.
 */
import { describe, expect, it } from 'vitest';

import {
  LAYOUT_FAILURES,
  LAYOUT_LOG_COUNT_MAX,
  LAYOUT_LOG_MESSAGE_MAX,
  LAYOUT_REL_BUCKETS,
  LAYOUT_TABLE_BUCKETS,
  classifyLayoutErrorText,
  isLayoutFallbackRung,
  layoutFailureDuration,
  layoutFailureSummary,
  layoutRelBucket,
  layoutTableBucket,
  readLayoutFailureDetail,
} from '../../src/types/webviewError';

describe('size buckets of a failed layout', () => {
  it.each([
    [0, 'under50'], [49, 'under50'], [50, '50to199'], [199, '50to199'],
    [200, '200to499'], [499, '200to499'], [500, '500plus'], [1100, '500plus'],
    [Number.NaN, 'under50'], [-1, 'under50'],
  ] as const)('%d tables is %s', (n, bucket) => {
    expect(layoutTableBucket(n)).toBe(bucket);
  });

  it.each([
    [0, 'under100'], [99, 'under100'], [100, '100to499'], [499, '100to499'],
    [500, '500to1999'], [1999, '500to1999'], [2000, '2000plus'], [50000, '2000plus'],
    [Number.NaN, 'under100'],
  ] as const)('%d relationships is %s', (n, bucket) => {
    expect(layoutRelBucket(n)).toBe(bucket);
  });

  it('every bucket is reachable', () => {
    expect(new Set([0, 50, 200, 500].map(layoutTableBucket))).toEqual(new Set(LAYOUT_TABLE_BUCKETS));
    expect(new Set([0, 100, 500, 2000].map(layoutRelBucket))).toEqual(new Set(LAYOUT_REL_BUCKETS));
  });
});

describe('how long a layout ran before failing', () => {
  it.each([[0, 'under1s'], [999, 'under1s'], [1000, '1to5s'], [5000, '1to5s'], [5001, 'over5s'], [61000, 'over5s']] as const)(
    '%d ms is %s', (ms, bucket) => {
      expect(layoutFailureDuration(ms)).toBe(bucket);
    });
});

describe('classifyLayoutErrorText', () => {
  it('a stack overflow, in V8 and Firefox words, whatever its type', () => {
    expect(classifyLayoutErrorText('RangeError', 'Maximum call stack size exceeded')).toBe('stack');
    expect(classifyLayoutErrorText('InternalError', 'too much recursion')).toBe('stack');
    expect(classifyLayoutErrorText('Error', 'com.google.gwt.core.client.JavaScriptException: (RangeError) : Maximum call stack size exceeded')).toBe('stack');
  });

  it('memory: a RangeError that is not a stack overflow, or the engines\' own out-of-memory words', () => {
    expect(classifyLayoutErrorText('RangeError', 'Invalid array length')).toBe('memory');
    expect(classifyLayoutErrorText('RangeError', 'Array buffer allocation failed')).toBe('memory');
    expect(classifyLayoutErrorText('RangeError', 'something V8 words differently one day')).toBe('memory');
    expect(classifyLayoutErrorText('Error', 'out of memory')).toBe('memory');
    expect(classifyLayoutErrorText('InternalError', 'allocation size overflow')).toBe('memory');
    expect(classifyLayoutErrorText('Error', 'com.google.gwt.core.client.JavaScriptException: (RangeError) : Invalid array length')).toBe('memory');
  });

  it('ELK exceptions by their class name, the start of the message elkjs sends', () => {
    expect(classifyLayoutErrorText('Error', "org.eclipse.elk.core.UnsupportedConfigurationException: Layout algorithm 'nope' not found for Root Node root")).toBe('unsupported');
    expect(classifyLayoutErrorText('Error', 'org.eclipse.elk.core.UnsupportedGraphException: Hyperedges are not supported.')).toBe('unsupported');
    expect(classifyLayoutErrorText('Error', 'org.eclipse.elk.graph.json.JsonImportException: Referenced shape does not exist: dim_customer')).toBe('input');
    // Any other exception of the engine's own.
    expect(classifyLayoutErrorText('Error', 'java.lang.IllegalStateException: Invalid hitboxes for scanline constraint calculation.')).toBe('engine');
    expect(classifyLayoutErrorText('Error', 'java.lang.NullPointerException')).toBe('engine');
  });

  it('anything else is other: a class name later in the text is not read', () => {
    expect(classifyLayoutErrorText('Error', 'cycle detected')).toBe('other');
    expect(classifyLayoutErrorText('TypeError', "Cannot read properties of undefined (reading 'x')")).toBe('other');
    expect(classifyLayoutErrorText('Error', 'failed: org.eclipse.elk.core.UnsupportedGraphException: x')).toBe('other');
    expect(classifyLayoutErrorText('', '')).toBe('other');
  });

  it('only ever returns a listed class', () => {
    for (const text of ['x', 'out of memory', 'too much recursion', 'a.b.C: d']) {
      expect(LAYOUT_FAILURES).toContain(classifyLayoutErrorText('Error', text));
    }
  });
});

describe('readLayoutFailureDetail', () => {
  const full = {
    failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout',
    log: { tables: 1100, relationships: 2400, message: 'Maximum call stack size exceeded' },
  };

  it('an older page sends none of the fields', () => {
    expect(readLayoutFailureDetail({ ms: 12, ok: false })).toEqual({});
    expect(readLayoutFailureDetail({ type: 'layoutFailed' })).toEqual({});
  });

  it('rebuilds the detail from the checked fields only', () => {
    expect(readLayoutFailureDetail({ ...full, ms: 1, ok: false, table: 'dim_customer' })).toEqual(full);
    for (const failure of LAYOUT_FAILURES) expect(readLayoutFailureDetail({ failure })).toEqual({ failure });
    for (const tableBucket of LAYOUT_TABLE_BUCKETS) expect(readLayoutFailureDetail({ tableBucket })).toEqual({ tableBucket });
    for (const relBucket of LAYOUT_REL_BUCKETS) expect(readLayoutFailureDetail({ relBucket })).toEqual({ relBucket });
    expect(readLayoutFailureDetail({ log: { tables: 0, relationships: LAYOUT_LOG_COUNT_MAX, message: '' } }))
      .toEqual({ log: { tables: 0, relationships: LAYOUT_LOG_COUNT_MAX, message: '' } });
  });

  it.each([
    undefined, null, [], 'stack',
    { failure: 'Maximum call stack size exceeded' },
    { failure: 3 },
    { tableBucket: 1100 },
    { tableBucket: '1100' },
    { tableBucket: 'under100' },
    { relBucket: 2400 },
    { relBucket: '500plus' },
    { exhausted: false },
    { exhausted: 'yes' },
    { lastFailure: 'slow' },
    { log: 'Maximum call stack size exceeded' },
    { log: { tables: 1100, relationships: 2400 } },
    { log: { tables: -1, relationships: 0, message: '' } },
    { log: { tables: 1.5, relationships: 0, message: '' } },
    { log: { tables: 0, relationships: LAYOUT_LOG_COUNT_MAX + 1, message: '' } },
    { log: { tables: '1100', relationships: 0, message: '' } },
    { log: { tables: 0, relationships: 0, message: 'x'.repeat(LAYOUT_LOG_MESSAGE_MAX + 1) } },
    { log: { tables: 0, relationships: 0, message: 7 } },
  ])('refuses %j', (raw) => {
    expect(readLayoutFailureDetail(raw)).toBeUndefined();
  });

  it('a fallback rung is 2 or 3', () => {
    expect([2, 3].every(isLayoutFallbackRung)).toBe(true);
    expect([1, 4, '2', true, undefined, 2.5].some(isLayoutFallbackRung)).toBe(false);
  });
});

describe('layoutFailureSummary (the Send Feedback diagnostics line)', () => {
  it('says the class, the buckets, how far the fallbacks got and the duration bucket, in fixed words', () => {
    expect(layoutFailureSummary({ failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout' }, 61000))
      .toBe('class stack, tables 500plus, relationships 2000plus, every fallback failed (last: timeout), ran over5s');
    expect(layoutFailureSummary({ failure: 'timeout', tableBucket: 'under50', relBucket: 'under100' }, 30000))
      .toBe('class timeout, tables under50, relationships under100, no fallback tried, ran over5s');
    expect(layoutFailureSummary({})).toBe('class unknown, no fallback tried');
  });

  it('never carries the counts or the message', () => {
    const line = layoutFailureSummary({
      failure: 'input', tableBucket: '500plus', relBucket: '2000plus',
      log: { tables: 1134, relationships: 2417, message: 'Referenced shape does not exist: dim_customer' },
    }, 12);
    expect(line).not.toMatch(/1134|2417|dim_customer|Referenced/);
  });
});
