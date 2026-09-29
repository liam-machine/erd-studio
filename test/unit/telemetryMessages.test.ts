/**
 * The two webview → host messages that exist only for usage telemetry:
 * the canvas's `layoutFinished` and the Welcome panel's `videoProgress`.
 * Both are validated at the boundary like every other message.
 */

import { describe, expect, it } from 'vitest';

import { validateLayoutFinishedPayload } from '../../src/providers/payloadValidation';
import { isGettingStartedToHost } from '../../src/types/gettingStarted';

describe('layoutFinished payload', () => {
  it('accepts a non-negative finite duration and a boolean', () => {
    expect(validateLayoutFinishedPayload({ ms: 0, ok: true })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 1234.5, ok: false })).toBe(true);
  });

  it('accepts an optional firstOpen boolean', () => {
    expect(validateLayoutFinishedPayload({ ms: 10, ok: false, firstOpen: true })).toBe(true);
    expect(validateLayoutFinishedPayload({ ms: 10, ok: true, firstOpen: false })).toBe(true);
  });

  it.each([
    undefined,
    null,
    [],
    { ms: -1, ok: true },
    { ms: Number.NaN, ok: true },
    { ms: Number.POSITIVE_INFINITY, ok: true },
    { ms: '12', ok: true },
    { ms: 12, ok: 'yes' },
    { ms: 12 },
    { ms: 12, ok: false, firstOpen: 'yes' },
  ])('refuses %j', (payload) => {
    expect(validateLayoutFinishedPayload(payload)).toBe(false);
  });
});

describe('videoProgress message', () => {
  it('accepts the two milestones only', () => {
    expect(isGettingStartedToHost({ type: 'videoProgress', milestone: 'half' })).toBe(true);
    expect(isGettingStartedToHost({ type: 'videoProgress', milestone: 'end' })).toBe(true);
    expect(isGettingStartedToHost({ type: 'videoProgress', milestone: 'start' })).toBe(false);
    expect(isGettingStartedToHost({ type: 'videoProgress' })).toBe(false);
  });
});
