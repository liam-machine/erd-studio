/**
 * `ReadyWatch` (2.0 B13): a panel that never says ready is reported once,
 * after 30 s visible; a hidden panel is never judged; a slow ready is
 * flagged; dispose cancels everything; a hook that throws is swallowed.
 * #364: a timer that ran late says the host was held, and a tab closed while
 * still blank is reported once, with its range.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closedBlankFeature,
  NO_READY_HOST_HELD_MS,
  READY_LATE_LONG_MS,
  READY_SLOW_MS,
  READY_TIMEOUT_MS,
  ReadyWatch,
} from '../../src/services/readyWatch';

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

/**
 * #364. Two clocks, as in the extension: `now` is the wall clock (ranges, as
 * `ready()` uses it) and `elapsed` the monotonic one (how late the timer ran).
 */
describe('ReadyWatch on a held host, and a tab closed while blank (#364)', () => {
  let mono = 0;
  const elapsed = () => mono;
  function watched(visible = true) {
    const hooks = { ready: vi.fn(), noReady: vi.fn(), lateReady: vi.fn(), noReadyHostHeld: vi.fn(), closedBlank: vi.fn() };
    return { hooks, watch: new ReadyWatch(visible, hooks, clock, elapsed) };
  }
  /** A host free all along: both clocks move and timers run on time. */
  const step = (ms: number) => { now += ms; mono += ms; vi.advanceTimersByTime(ms); };
  /** The host was blocked for `ms`: both clocks moved, no timer could run. */
  const block = (ms: number) => { now += ms; mono += ms; };
  /** The machine slept for `ms`: only the wall clock moved (the monotonic one stops on macOS and Linux). */
  const sleep = (ms: number) => { now += ms; };
  /** The host is free again: the overdue timer runs now. */
  const drain = () => vi.advanceTimersByTime(READY_TIMEOUT_MS);

  beforeEach(() => { mono = 1_000; });

  it('a timer that ran 5 s or more late reports noReadyHostHeld once, right after noReady', () => {
    const { hooks } = watched();
    block(READY_TIMEOUT_MS + NO_READY_HOST_HELD_MS);
    drain();
    expect(hooks.noReady).toHaveBeenCalledTimes(1);
    expect(hooks.noReadyHostHeld).toHaveBeenCalledTimes(1);
    expect(hooks.noReady.mock.invocationCallOrder[0]).toBeLessThan(hooks.noReadyHostHeld.mock.invocationCallOrder[0]);
    // noReady's signature is unchanged: it is still called with nothing.
    expect(hooks.noReady.mock.calls[0]).toEqual([]);
    step(READY_TIMEOUT_MS * 3);
    expect(hooks.noReadyHostHeld).toHaveBeenCalledTimes(1);
  });

  it('a timer 1 ms short of 5 s late, or on time, is not a held host', () => {
    const almost = watched();
    block(READY_TIMEOUT_MS + NO_READY_HOST_HELD_MS - 1);
    drain();
    expect(almost.hooks.noReady).toHaveBeenCalledTimes(1);
    expect(almost.hooks.noReadyHostHeld).not.toHaveBeenCalled();

    const onTime = watched();
    step(READY_TIMEOUT_MS);
    expect(onTime.hooks.noReady).toHaveBeenCalledTimes(1);
    expect(onTime.hooks.noReadyHostHeld).not.toHaveBeenCalled();
  });

  it('a machine that slept through the 30 s is not a held host: lateness is timed on the monotonic clock', () => {
    const { hooks } = watched();
    sleep(60_000);
    step(READY_TIMEOUT_MS);
    expect(hooks.noReady).toHaveBeenCalledTimes(1);
    expect(hooks.noReadyHostHeld).not.toHaveBeenCalled();
  });

  it('lateness is timed from the show that armed the timer, not the first one', () => {
    const { hooks, watch } = watched();
    block(READY_TIMEOUT_MS * 2);
    watch.visibility(false);
    drain();
    watch.visibility(true);
    step(READY_TIMEOUT_MS);
    expect(hooks.noReady).toHaveBeenCalledTimes(1);
    expect(hooks.noReadyHostHeld).not.toHaveBeenCalled();
  });

  it('evidence: a ready queued behind a blocked host that is handled before the overdue timer reports no noReady at all', () => {
    const { hooks, watch } = watched();
    block(READY_TIMEOUT_MS + 12_000);
    watch.ready();
    drain();
    expect(hooks.noReady).not.toHaveBeenCalled();
    expect(hooks.noReadyHostHeld).not.toHaveBeenCalled();
    expect(hooks.ready.mock.calls).toEqual([[true]]);
  });

  it('a tab closed blank under 60 s after it was shown reports closedBlank("30to60s"), once', () => {
    const { hooks, watch } = watched();
    step(READY_TIMEOUT_MS);
    step(READY_LATE_LONG_MS - READY_TIMEOUT_MS - 1);
    watch.dispose();
    watch.dispose();
    expect(hooks.closedBlank.mock.calls).toEqual([['30to60s']]);
  });

  it('a tab closed blank 60 s or more after it was shown reports closedBlank("over60s")', () => {
    const { hooks, watch } = watched();
    step(READY_TIMEOUT_MS);
    step(READY_LATE_LONG_MS - READY_TIMEOUT_MS);
    watch.dispose();
    expect(hooks.closedBlank.mock.calls).toEqual([['over60s']]);
  });

  it('times the close from the show whose 30 s ran out, hidden or not since', () => {
    const { hooks, watch } = watched();
    step(READY_TIMEOUT_MS);
    watch.visibility(false);
    step(40_000);
    watch.visibility(true);
    watch.dispose();
    expect(hooks.closedBlank.mock.calls).toEqual([['over60s']]);
  });

  it('no closedBlank after a ready, a reload, with no timeout yet, or on a panel never shown', () => {
    const readyFirst = watched();
    step(READY_TIMEOUT_MS); readyFirst.watch.ready(); readyFirst.watch.dispose();
    const reloaded = watched();
    step(READY_TIMEOUT_MS); reloaded.watch.reloaded(); reloaded.watch.dispose();
    const early = watched();
    step(5_000); early.watch.dispose();
    const hidden = watched(false);
    step(READY_TIMEOUT_MS * 3); hidden.watch.dispose();
    for (const w of [readyFirst, reloaded, early, hidden]) expect(w.hooks.closedBlank).not.toHaveBeenCalled();
    // The late ready is still reported as before.
    expect(readyFirst.hooks.lateReady).toHaveBeenCalledTimes(1);
  });

  it('a panel that does not keep its page, hidden after the timeout, is never closed blank (Welcome)', () => {
    const { hooks, watch } = watched();
    step(READY_TIMEOUT_MS);
    // GettingStartedPanel: a hide replaces the page.
    watch.reloaded();
    watch.visibility(false);
    step(10_000);
    watch.visibility(true);
    step(READY_TIMEOUT_MS * 2);
    watch.dispose();
    expect(hooks.closedBlank).not.toHaveBeenCalled();
    // Shown blank again, it is not judged a second time either.
    expect(hooks.noReady).toHaveBeenCalledTimes(1);
  });

  it('swallows a noReadyHostHeld or closedBlank hook that throws', () => {
    const watch = new ReadyWatch(true, {
      noReady: vi.fn(),
      noReadyHostHeld: () => { throw new Error('held'); },
      closedBlank: () => { throw new Error('closed'); },
    }, clock, elapsed);
    block(READY_TIMEOUT_MS + NO_READY_HOST_HELD_MS);
    expect(() => drain()).not.toThrow();
    expect(() => watch.dispose()).not.toThrow();
  });

  it('closedBlankFeature maps each range to its key', () => {
    expect(closedBlankFeature('30to60s')).toBe('noReadyClosed30to60s');
    expect(closedBlankFeature('over60s')).toBe('noReadyClosedOver60s');
  });
});
