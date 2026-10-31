/**
 * Hover intent: a short wait before a table becomes the focus, a quicker
 * switch between tables with no blank frame, and a grace period on leave.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createHoverIntent,
  HOVER_ENTER_DELAY_MS,
  HOVER_SWITCH_DELAY_MS,
  HOVER_LEAVE_GRACE_MS,
} from '../../src/lib/hoverIntent';

let focus: string | null;
let suppressed: boolean;
let commits: (string | null)[];

function make() {
  return createHoverIntent({
    current: () => focus,
    isSuppressed: () => suppressed,
    commit: (id) => {
      commits.push(id);
      focus = id;
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  focus = null;
  suppressed = false;
  commits = [];
});
afterEach(() => {
  vi.useRealTimers();
});

describe('hover intent', () => {
  it('commits after 120ms, not before', () => {
    expect(HOVER_ENTER_DELAY_MS).toBe(120);
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(119);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(['a']);
  });

  it('leaving before 120ms commits nothing', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(80);
    h.leave();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
  });

  it('switches A → B after 60ms with no null in between', () => {
    expect(HOVER_SWITCH_DELAY_MS).toBe(60);
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    vi.advanceTimersByTime(20);
    h.enter('b', 0);
    vi.advanceTimersByTime(59);
    expect(commits).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(['a', 'b']);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a', 'b']);
  });

  it('clears 150ms after leaving; coming back within the grace keeps the focus', () => {
    expect(HOVER_LEAVE_GRACE_MS).toBe(150);
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    vi.advanceTimersByTime(100);
    h.enter('a', 0);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a']);
    h.leave();
    vi.advanceTimersByTime(149);
    expect(commits).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(['a', null]);
  });

  it('hold() cancels a pending clear', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    vi.advanceTimersByTime(100);
    h.hold();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a']);
  });

  it('ignores an enter with a mouse button held', () => {
    const h = make();
    h.enter('a', 1);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
  });

  it('isSuppressed() blocks when scheduling and when the timer fires', () => {
    const h = make();
    suppressed = true;
    h.enter('a', 0);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
    suppressed = false;
    h.enter('a', 0);
    vi.advanceTimersByTime(60);
    suppressed = true;
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
  });

  it('entering the table already in focus does nothing', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.enter('a', 0);
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a']);
  });

  it('re-entering a pending table does not restart its wait', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(100);
    h.enter('a', 0);
    vi.advanceTimersByTime(20);
    expect(commits).toEqual(['a']);
  });

  it('cancelPending() drops both timers', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    h.cancelPending();
    h.enter('b', 0);
    h.cancelPending();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a']);
  });

  it('cancelEnter() drops a pending enter but lets a pending clear run', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    h.cancelEnter();
    vi.advanceTimersByTime(HOVER_LEAVE_GRACE_MS);
    expect(commits).toEqual(['a', null]);

    h.enter('b', 0);
    h.cancelEnter();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual(['a', null]);
  });

  it('after dispose() nothing ever commits', () => {
    const h = make();
    h.enter('a', 0);
    h.dispose();
    vi.advanceTimersByTime(1000);
    h.enter('b', 0);
    h.leave();
    vi.advanceTimersByTime(1000);
    expect(commits).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps at most two timers', () => {
    const h = make();
    h.enter('a', 0);
    vi.advanceTimersByTime(120);
    h.leave();
    h.enter('b', 0);
    h.enter('c', 0);
    h.leave();
    h.enter('d', 0);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
  });
});
