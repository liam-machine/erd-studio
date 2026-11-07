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
