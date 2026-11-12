/**
 * The 2.0 B13 / B17 webview → host telemetry messages, validated at the
 * boundary: the canvas's `webviewError` and `layoutFinished`'s new optional
 * fields, and the draft page's passive `layoutFinished` and `pageError`.
 * Fixed enums only; anything else is refused.
 */
import { describe, expect, it } from 'vitest';

import { validateLayoutFinishedPayload, validateWebviewErrorPayload } from '../../src/providers/payloadValidation';
import { DRAFT_PASSIVE_TYPES, DRAFT_TO_HOST_TYPES, parseDraftToHost, type DraftMessageAllowance } from '../../src/types/draft';

describe('layoutFinished payload (2.0 fields)', () => {
  it('accepts a failure class and the fallback flag', () => {
    expect(validateLayoutFinishedPayload({ ms: 30000, ok: false, failure: 'timeout' })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 10, ok: false, firstOpen: true, failure: 'worker' })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 10, ok: false, failure: 'stack' })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 10, ok: false, failure: 'other' })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 10, ok: true, fallback: true })).toBe(true);
  });

  it.each([
    { ms: 10, ok: false, failure: 'Maximum call stack size exceeded' },
    { ms: 10, ok: false, failure: 3 },
    { ms: 10, ok: true, fallback: false },
    { ms: 10, ok: true, fallback: 'yes' },
  ])('refuses %j', (payload) => {
    expect(validateLayoutFinishedPayload(payload)).toBe(false);
  });
});

describe('layoutFinished payload (fields added after 2.0.4: what failed, and how far the fallbacks got)', () => {
  const log = { tables: 1100, relationships: 2400, message: 'RangeError: Maximum call stack size exceeded' };

  it('still accepts every older shape', () => {
    // 1.x: no optional field. 2.0.0 – 2.0.4: failure and fallback only.
    expect(validateLayoutFinishedPayload({ ms: 12, ok: true })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 12, ok: false })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 12, ok: false, firstOpen: true, failure: 'other' })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 12, ok: true, firstOpen: true, fallback: true })).toBe(true);
  });

  it('accepts the new classes, the size buckets, the fallback outcome, the rung and the log', () => {
    for (const failure of ['memory', 'unsupported', 'input', 'engine', 'result']) {
      expect(validateLayoutFinishedPayload({ ms: 10, ok: false, failure })).toBe(true);
    }
    expect(validateLayoutFinishedPayload({
      ms: 64000, ok: false, firstOpen: true, failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout', log,
    })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 900, ok: true, fallback: true, rung: 2 })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 900, ok: true, rung: 3 })).toBe(true);
  });

  it.each([
    { ms: 10, ok: false, tableBucket: 1100 },
    { ms: 10, ok: false, tableBucket: 'huge' },
    { ms: 10, ok: false, relBucket: 2400 },
    { ms: 10, ok: false, relBucket: 'under50' },
    { ms: 10, ok: false, exhausted: false },
    { ms: 10, ok: false, lastFailure: 'Maximum call stack size exceeded' },
    { ms: 10, ok: true, rung: 1 },
    { ms: 10, ok: true, rung: 4 },
    { ms: 10, ok: true, rung: '2' },
    { ms: 10, ok: false, log: { tables: -1, relationships: 0, message: '' } },
    { ms: 10, ok: false, log: { tables: 1_000_001, relationships: 0, message: '' } },
    { ms: 10, ok: false, log: { tables: 10.5, relationships: 0, message: '' } },
    { ms: 10, ok: false, log: { tables: 10, relationships: 0, message: 'x'.repeat(501) } },
    { ms: 10, ok: false, log: { tables: 10, relationships: 0 } },
    { ms: 10, ok: false, log: 'boom' },
  ])('refuses %j', (payload) => {
    expect(validateLayoutFinishedPayload(payload)).toBe(false);
  });
});

describe('webviewError payload', () => {
  it('accepts every kind and area', () => {
    for (const kind of ['render', 'window', 'rejection']) {
      for (const area of ['canvas', 'detailPanel', 'toolbar', 'dialogs', 'compare', 'guide', 'other']) {
        expect(validateWebviewErrorPayload({ kind, area })).toBe(true);
      }
    }
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { kind: 'render' },
    { kind: 'crash', area: 'canvas' },
    { kind: 'render', area: 'sidebar' },
    { kind: 'render', area: 'draft' },
    { kind: 'render', area: 'Canvas' },
  ])('refuses %j', (payload) => {
    expect(validateWebviewErrorPayload(payload)).toBe(false);
  });
});

describe('the draft page passive messages', () => {
  const allowed: DraftMessageAllowance = { keepable: true, changeOptions: true, scopeIds: new Set(), otherStarts: new Set() };

  it('are passive and listed', () => {
    for (const type of ['layoutFinished', 'pageError'] as const) {
      expect(DRAFT_TO_HOST_TYPES).toContain(type);
      expect(DRAFT_PASSIVE_TYPES.has(type)).toBe(true);
    }
  });

  it('parses layoutFinished, rebuilt from the checked fields', () => {
    expect(parseDraftToHost({ type: 'layoutFinished', ms: 1200, fitZoom: 'under30', fallback: true, extra: 'x' }, allowed))
      .toEqual({ type: 'layoutFinished', ms: 1200, fitZoom: 'under30', fallback: true });
    expect(parseDraftToHost({ type: 'layoutFinished', ms: 0, fitZoom: 'ok' }, allowed))
      .toEqual({ type: 'layoutFinished', ms: 0, fitZoom: 'ok' });
  });

  it('parses layoutFinished with the fallback rung, and refuses another rung', () => {
    expect(parseDraftToHost({ type: 'layoutFinished', ms: 1200, fitZoom: 'ok', fallback: true, rung: 3 }, allowed))
      .toEqual({ type: 'layoutFinished', ms: 1200, fitZoom: 'ok', fallback: true, rung: 3 });
    expect(parseDraftToHost({ type: 'layoutFinished', ms: 1200, fitZoom: 'ok', rung: 1 }, allowed)).toBeUndefined();
  });

  it('parses layoutFailed: alone from an older page, or rebuilt from its checked detail', () => {
    expect(parseDraftToHost({ type: 'layoutFailed' }, allowed)).toEqual({ type: 'layoutFailed' });
    const detail = {
      ms: 31000, failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'timeout',
      log: { tables: 1100, relationships: 2400, message: 'Maximum call stack size exceeded' },
    };
    expect(parseDraftToHost({ type: 'layoutFailed', ...detail, table: 'dim_customer' }, allowed)).toEqual({ type: 'layoutFailed', ...detail });
  });

  it.each([
    { type: 'layoutFailed', ms: -1 },
    { type: 'layoutFailed', ms: '12' },
    { type: 'layoutFailed', failure: 'Maximum call stack size exceeded' },
    { type: 'layoutFailed', tableBucket: 1100 },
    { type: 'layoutFailed', relBucket: 'lots' },
    { type: 'layoutFailed', exhausted: 1 },
    { type: 'layoutFailed', log: { tables: 2_000_000, relationships: 0, message: '' } },
  ])('refuses %j', (raw) => {
    expect(parseDraftToHost(raw, allowed)).toBeUndefined();
  });

  it.each([
    { type: 'layoutFinished', ms: 10, fitZoom: 0.2 },
    { type: 'layoutFinished', ms: 10, fitZoom: 'tiny' },
    { type: 'layoutFinished', ms: -1, fitZoom: 'ok' },
    { type: 'layoutFinished', ms: Number.NaN, fitZoom: 'ok' },
    { type: 'layoutFinished', fitZoom: 'ok' },
    { type: 'layoutFinished', ms: 10, fitZoom: 'ok', fallback: false },
  ])('refuses %j', (raw) => {
    expect(parseDraftToHost(raw, allowed)).toBeUndefined();
  });

  it('parses pageError with the draft area only', () => {
    expect(parseDraftToHost({ type: 'pageError', kind: 'render', area: 'draft', message: 'secret' }, allowed))
      .toEqual({ type: 'pageError', kind: 'render', area: 'draft' });
    expect(parseDraftToHost({ type: 'pageError', kind: 'rejection', area: 'draft' }, allowed))
      .toEqual({ type: 'pageError', kind: 'rejection', area: 'draft' });
    expect(parseDraftToHost({ type: 'pageError', kind: 'render', area: 'canvas' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'pageError', kind: 'boom', area: 'draft' }, allowed)).toBeUndefined();
    expect(parseDraftToHost({ type: 'pageError', area: 'draft' }, allowed)).toBeUndefined();
  });
});
