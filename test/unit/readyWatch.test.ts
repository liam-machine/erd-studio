/**
 * `ReadyWatch` (2.0 B13): a panel that never says ready is reported once,
 * after 30 s visible; a hidden panel is never judged; a slow ready is
 * flagged; dispose cancels everything; a hook that throws is swallowed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { READY_SLOW_MS, READY_TIMEOUT_MS, ReadyWatch } from '../../src/services/readyWatch';

let now = 0;
const clock = () => now;

beforeEach(() => {
  vi.useFakeTimers();
  now = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  now += ms;
  vi.advanceTimersByTime(ms);
}

describe('ReadyWatch', () => {
  it('fires noReady once a visible panel has gone 30 s without ready', () => {
    const noReady = vi.fn();
    new ReadyWatch(true, { noReady }, clock);
    advance(READY_TIMEOUT_MS - 1);
    expect(noReady).not.toHaveBeenCalled();
    advance(1);
    expect(noReady).toHaveBeenCalledTimes(1);
    advance(READY_TIMEOUT_MS * 3);
    expect(noReady).toHaveBeenCalledTimes(1);
  });

  it('never judges a panel that stays hidden', () => {
    const noReady = vi.fn();
    new ReadyWatch(false, { noReady }, clock);
    advance(READY_TIMEOUT_MS * 4);
    expect(noReady).not.toHaveBeenCalled();
  });

  it('stops while hidden and starts over when shown again', () => {
    const noReady = vi.fn();
    const watch = new ReadyWatch(true, { noReady }, clock);
    advance(READY_TIMEOUT_MS - 1000);
    watch.visibility(false);
    advance(READY_TIMEOUT_MS * 2);
    expect(noReady).not.toHaveBeenCalled();
    watch.visibility(true);
    // A second "visible" (an active change) does not restart the clock.
    advance(1000);
    watch.visibility(true);
    advance(READY_TIMEOUT_MS - 1000);
    expect(noReady).toHaveBeenCalledTimes(1);
  });

  it('cancels the timer on dispose', () => {
    const noReady = vi.fn();
    const watch = new ReadyWatch(true, { noReady }, clock);
    watch.dispose();
    advance(READY_TIMEOUT_MS * 2);
    expect(noReady).not.toHaveBeenCalled();
  });

  it('reports ready once, slow when it came more than 10 s after the panel was shown', () => {
    const ready = vi.fn();
    const noReady = vi.fn();
    const watch = new ReadyWatch(true, { ready, noReady }, clock);
    advance(READY_SLOW_MS + 1);
    watch.ready();
    watch.ready();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith(true);
    advance(READY_TIMEOUT_MS);
    expect(noReady).not.toHaveBeenCalled();

    const fast = vi.fn();
    new ReadyWatch(true, { ready: fast, noReady }, clock).ready();
    expect(fast).toHaveBeenCalledWith(false);
  });

  it('measures slowness from the last time the panel was shown', () => {
    const ready = vi.fn();
    const watch = new ReadyWatch(false, { ready, noReady: vi.fn() }, clock);
    advance(60_000);
    watch.visibility(true);
    advance(2000);
    watch.ready();
    expect(ready).toHaveBeenCalledWith(false);
  });

  it('swallows a hook that throws', () => {
    const watch = new ReadyWatch(true, { ready: () => { throw new Error('x'); }, noReady: () => { throw new Error('y'); } }, clock);
    expect(() => watch.ready()).not.toThrow();
    const late = new ReadyWatch(true, { noReady: () => { throw new Error('y'); } }, clock);
    expect(() => advance(READY_TIMEOUT_MS)).not.toThrow();
    late.dispose();
  });
});
