/**
 * The canvas's half of drop timing (`src/services/dropTiming.ts`): when the
 * host has redrawn the diagram for a dropped table and posts `dropTrace`, say
 * `dropShown` once that diagram has been painted. A `requestAnimationFrame`
 * callback runs just before the next paint and a timer it queues runs just
 * after it, so the answer leaves once the table is on screen (a hidden canvas
 * paints when it is shown again). `renderMs` is this page's own time from
 * receiving the last `domainLoaded` to that paint, so the host can tell the
 * canvas's render apart from the message's trip and its own busy time.
 */

/** The longest `renderMs` sent (the host's `DROP_SHOWN_MAX_RENDER_MS`). */
const MAX_RENDER_MS = 600_000;

let domainLoadedAt: number | undefined;

/** A `domainLoaded` arrived (the redrawn diagram a `dropTrace` follows). */
export function noteDomainLoaded(now: number = performance.now()): void {
  domainLoadedAt = now;
}

export interface DropTraceDeps {
  now(): number;
  /** Before the next paint. */
  frame(callback: () => void): void;
  /** After the current task (queued from `frame`: after the paint). */
  later(callback: () => void): void;
}

const browserDeps: DropTraceDeps = {
  now: () => performance.now(),
  frame: (callback) => { requestAnimationFrame(() => callback()); },
  later: (callback) => { setTimeout(callback, 0); },
};

/** Answer the host's `dropTrace` (its `trace` id) with `dropShown` after the next paint. Anything but a whole id from 1 is ignored. */
export function answerDropTrace(trace: unknown, post: (message: unknown) => void, deps: DropTraceDeps = browserDeps): void {
  if (typeof trace !== 'number' || !Number.isSafeInteger(trace) || trace < 1) return;
  const since = domainLoadedAt;
  deps.frame(() => deps.later(() => {
    const renderMs = since !== undefined ? Math.min(MAX_RENDER_MS, Math.max(0, Math.round(deps.now() - since))) : undefined;
    post({ type: 'dropShown', payload: { trace, ...(renderMs !== undefined ? { renderMs } : {}) } });
  }));
}

/** Tests: forget the last `domainLoaded`. */
export function _resetDropTraceForTests(): void {
  domainLoadedAt = undefined;
}
