/**
 * The canvas's first paint (#333): how long this page took from receiving its
 * first diagram (`domainLoaded`) to the paint after React Flow measured its
 * tables, said once per page load as `canvasPainted`. The host maps the time
 * to a fixed telemetry range (`canvasPaint*`) and logs it; the page sends a
 * number of milliseconds and nothing else.
 *
 * The time is this page's own (`performance.now()`), never compared with a
 * host clock. A `requestAnimationFrame` callback runs just before the next
 * paint and a timer it queues runs just after it, as `dropTrace.ts` does. A
 * page that was hidden at any point in between sends nothing: a hidden page
 * does not paint, so its time would be how long it stayed hidden.
 *
 * Only the page's first diagram counts: a refresh, an undo or a stage switch
 * re-posts the diagram and is not an open. A crash screen's Reload loads the
 * page again, which is a new first diagram.
 */

import { isBehindAnotherTab } from './gentleReveal';

/** The longest `ms` sent (the host's `CANVAS_PAINTED_MAX_MS`). */
const MAX_PAINT_MS = 600_000;

type Phase = 'idle' | 'waiting' | 'measuring' | 'done';

let phase: Phase = 'idle';
let receivedAt = 0;

export interface PaintTimingDeps {
  now(): number;
  /** Before the next paint. */
  frame(callback: () => void): void;
  /** After the current task (queued from `frame`: after the paint). */
  later(callback: () => void): void;
  /** Whether the page is on screen now. */
  visible(): boolean;
}

const browserDeps: PaintTimingDeps = {
  now: () => performance.now(),
  frame: (callback) => { requestAnimationFrame(() => callback()); },
  later: (callback) => { setTimeout(callback, 0); },
  visible: () => document.visibilityState !== 'hidden' && !isBehindAnotherTab(),
};

/** A `domainLoaded` arrived. Only the page's first starts the clock; a page off screen then is never timed. */
export function notePayloadReceived(deps: PaintTimingDeps = browserDeps): void {
  if (phase !== 'idle') return;
  if (!deps.visible()) {
    phase = 'done';
    return;
  }
  receivedAt = deps.now();
  phase = 'waiting';
}

/** The page went off screen (behind another tab, or the window hidden): the paint being waited for is not timed. */
export function notePageHidden(): void {
  if (phase === 'waiting' || phase === 'measuring') phase = 'done';
}

/**
 * The first diagram is drawn (its tables measured, or nothing to draw): post
 * `canvasPainted` after the next paint, once. Does nothing before the first
 * `domainLoaded`, after the answer, or once the page has been hidden.
 */
export function answerFirstPaint(post: (message: { type: 'canvasPainted'; payload: { ms: number } }) => void, deps: PaintTimingDeps = browserDeps): void {
  if (phase !== 'waiting') return;
  phase = 'measuring';
  const since = receivedAt;
  deps.frame(() => deps.later(() => {
    if (phase !== 'measuring') return;
    phase = 'done';
    if (!deps.visible()) return;
    const ms = Math.min(MAX_PAINT_MS, Math.max(0, Math.round(deps.now() - since)));
    post({ type: 'canvasPainted', payload: { ms } });
  }));
}

/** Tests: a fresh page. */
export function _resetPaintTimingForTests(): void {
  phase = 'idle';
  receivedAt = 0;
}
