/**
 * Edge routing — route every FK line in one pass.
 *
 *   input (boxes + anchors) → router (polylines) → renderer (corners, crossings)
 *                                                → tunnels (x-ray under cards)
 *
 * Two line styles, chosen by the reader (`LineStyle`): `curved` (soft curves
 * around the tables, a halo where lines cross, an x-ray of a line that has
 * to pass under a card) and `hops` (square corners rounded a little, a small
 * hop where two lines cross). Both use the same router.
 *
 * A line the router leaves out (a self-loop, a line on an unmeasured card)
 * keeps `FkEdge`'s smooth-step fallback, and so does every line when routing
 * fails or is too slow for the diagram (`createEdgeRoutingEngine`).
 */

import type { RoutedEdge, RoutingInput } from './types';
import { createAvoidRouter } from './routers/orthogonalAvoid';
import { routeAll, safely } from './routeAll';
import { lineStyleOptions, type LineStyle } from './lineStyle';
import type { RoutingWorkerFactory, RoutingWorkerHandle } from './worker/client';
import type { WorkerRouteResult } from './worker/protocol';

export * from './types';
export { buildRoutingInput, routingInputKey, draggingNodesKey } from './input';
export { createAvoidRouter, type AvoidRouter } from './routers/orthogonalAvoid';
export * from './lineStyle';
export { routeAll, type RouteAllOptions } from './routeAll';
export { createRoutingWorker, type RoutingWorkerFactory, type RoutingWorkerHandle, type RoutingWorkerEvents } from './worker/client';
export type { WorkerRouteRequest, WorkerRouteResult } from './worker/protocol';

// ---------------------------------------------------------------------------
// The performance guard
// ---------------------------------------------------------------------------
//
// One pass on generated layered diagrams like the auto-layout's (M-series
// Mac, opening / one card moved): 300 cards ~110 / 20 ms, 500 ~190 / 40 ms,
// 1,000 ~460 / 100 ms, 2,000 (2,700 lines) ~1.4 s / 230 ms. Up to 150 cards
// one routing grid covers the diagram; past that each line gets its own local
// grid (routers/orthogonal/router.ts), which keeps both time and memory near
// linear in the diagram's size.

/**
 * A pass during a drag slower than this (ms) is too slow to run on every
 * frame: for the rest of that drag the routes are held (see
 * `createEdgeRoutingEngine`), and everything is routed again once, when the
 * drag ends.
 */
export const DRAG_REROUTE_BUDGET_MS = 12;
/**
 * A pass outside a drag slower than this (ms) holds the routes from a drag's
 * first frame: even routing only the moved card's lines would not fit a frame.
 * With a worker, it also moves that diagram's routing into the worker.
 */
export const DRAG_HOLD_AFTER_MS = 50;
/** A main-thread pass slower than this (ms) turns routing off for diagrams of that size: every line draws the fallback. */
export const ROUTING_HARD_LIMIT_MS = 150;
/**
 * A worker pass slower than this (ms) turns routing off for diagrams of that
 * size. A safety net only: a 2,000-card diagram takes ~1.5 s.
 */
export const WORKER_HARD_LIMIT_MS = 20000;
/**
 * Diagrams with up to this many lines route on the main thread (a pass is
 * ~20 ms or less), so a drag can re-route as the card moves. Larger ones
 * route in the canvas's worker, when it has one.
 */
export const MAIN_THREAD_MAX_LINES = 100;
/** With a worker: no limit on the number of lines (the worker never pauses the canvas). */
export const MAX_ROUTED_LINES = Infinity;
/** Without a worker: diagrams with more lines than this are never routed (the pass would pause the canvas over ~40 ms). */
export const MAX_ROUTED_LINES_WITHOUT_WORKER = 150;

/** What the engine did on one update. */
export type RoutingPass =
  /** Every line routed. */
  | 'routed'
  /** A drag on a slow diagram: the last routes kept, minus the lines of the dragged cards. */
  | 'held'
  /**
   * Sent to the worker: the last routes kept, minus the lines of cards that
   * moved or changed size since, until the worker answers (`onUpdate`).
   */
  | 'pending'
  /** No routes: every line draws the smooth-step fallback. */
  | 'off';

export interface RoutingUpdate {
  /** The routes to draw, by edge id; null when every line draws the fallback. */
  routes: Map<string, RoutedEdge> | null;
  pass: RoutingPass;
  /** How long a routed pass took (0 when nothing was routed). */
  millis: number;
}

export interface RoutingRequest {
  /** Builds the input: called only for a pass that routes. */
  input: () => RoutingInput;
  /** The number of FK lines (for the caps, without building the input). */
  lineCount: number;
  style: LineStyle;
  /** The canvas zoom (hops are sized for it). */
  zoom?: number;
  /** Ids of the cards being dragged (empty when no drag is in progress). */
  dragging?: ReadonlySet<string>;
}

export interface EdgeRoutingEngine {
  update(request: RoutingRequest): RoutingUpdate;
  /** Stops the worker. The engine answers nothing afterwards. */
  dispose(): void;
}

export interface EdgeRoutingEngineOptions {
  /** Clock for pass timings (default `performance.now`). */
  now?: () => number;
  /**
   * Starts this canvas's routing worker (`createRoutingWorker`), called the
   * first time a diagram is large enough to need it. Omitted, or returning
   * null: every pass runs on the main thread, under the lower cap.
   */
  worker?: RoutingWorkerFactory;
  /** Receives the routes a worker pass produced, after `update` returned 'pending'. */
  onUpdate?: (update: RoutingUpdate) => void;
}

/** A pass sent to the worker, with what is needed to use its answer. */
interface WorkerJob {
  seq: number;
  input: RoutingInput;
  style: LineStyle;
  zoom: number;
  lineCount: number;
}

/** Each card's box, as a comparable key: a route is still right while both its cards' keys are unchanged. */
function rectKeysOf(input: RoutingInput): Map<string, string> {
  const keys = new Map<string, string>();
  for (const r of input.obstacles) keys.set(r.id, `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`);
  return keys;
}

function endsOf(input: RoutingInput): Map<string, [string, string]> {
  return new Map(input.edges.map((e) => [e.id, [e.source, e.target]]));
}

/**
 * One canvas's routing: its own router (so two canvases on a page never share
 * the router's memory of the last pass), its own worker, and the performance
 * guard.
 *
 * - Up to `MAIN_THREAD_MAX_LINES` lines, a pass runs on the main thread, and
 *   a drag re-routes only what the move touches, which is usually far cheaper
 *   than a full pass (40 tables / 60 lines: about 16 ms cold, 6 ms a drag
 *   frame). When one drag frame takes more than `DRAG_REROUTE_BUDGET_MS`, or
 *   the last pass outside a drag took more than `DRAG_HOLD_AFTER_MS`, the
 *   drag stops routing: the routes stay as they were, minus the lines
 *   touching a dragged card (they draw the fallback, which follows the card),
 *   and the first update after the drag routes everything again.
 * - Larger diagrams (and a smaller one whose pass took more than
 *   `DRAG_HOLD_AFTER_MS`) route in the worker, so the canvas never pauses:
 *   `update` returns 'pending' with the last routes still right (lines on a
 *   moved card fall back), and `onUpdate` delivers the new ones. A drag holds
 *   the routes; an answer to a request that has since been superseded is
 *   dropped, and only the latest waiting request is sent next.
 * - With the worker, every diagram is routed, whatever its size. Without it
 *   (it cannot start, or failed), more than `MAX_ROUTED_LINES_WITHOUT_WORKER`
 *   lines are not. A main-thread pass over `ROUTING_HARD_LIMIT_MS`, or a
 *   worker pass over `WORKER_HARD_LIMIT_MS`, turns routing off for this
 *   canvas while the diagram has at least that many lines.
 * - A worker that fails is stopped for good; the canvas carries on on the
 *   main thread under the lower cap.
 * - A router, renderer or worker error is reported once (`console.warn`),
 *   never per frame, and leaves those lines on the fallback. Nothing else is
 *   logged.
 */
export function createEdgeRoutingEngine(options: EdgeRoutingEngineOptions | (() => number) = {}): EdgeRoutingEngine {
  const opts: EdgeRoutingEngineOptions = typeof options === 'function' ? { now: options } : options;
  const now = opts.now ?? defaultNow;
  const router = createAvoidRouter();
  /** The last full pass (main thread or worker). */
  let fullMillis = 0;
  /** A frame of the drag in progress blew the budget: hold until it ends. */
  let dragSlow = false;
  /** Line count at which a pass blew a hard limit (routing off at or above it). */
  let slowAt: number | null = null;
  /** Line count at which a main-thread pass was slow enough to move to the worker. */
  let workerFromLines: number | null = null;
  /** The last routes, the two cards of each line, and the card boxes they were routed for. */
  let last: Map<string, RoutedEdge> | null = null;
  let lastEnds = new Map<string, [string, string]>();
  let lastRects = new Map<string, string>();
  /** The held routes and the drag they were made for, so one drag hands back one map. */
  let held: { key: string; routes: Map<string, RoutedEdge> } | null = null;
  /** The worker: undefined until first needed, null when it cannot start or failed. */
  let worker: RoutingWorkerHandle | null | undefined;
  /** The newest request's sequence number: only its answer is used. */
  let seq = 0;
  /** The pass the worker is computing, and the newest one waiting behind it. */
  let inFlight: WorkerJob | null = null;
  let queued: WorkerJob | null = null;
  /** The newest request (a worker answer lands into its drag state; a worker failure re-runs it). */
  let latest: RoutingRequest | null = null;
  let disposed = false;
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    // eslint-disable-next-line no-console
    console.warn('[edge-routing] Line routing failed; the affected lines use the simple path.', err);
  };
  const emit = (update: RoutingUpdate) => {
    if (!disposed) opts.onUpdate?.(update);
  };

  const hold = (dragging: ReadonlySet<string>, routes: Map<string, RoutedEdge>): RoutingUpdate => {
    const key = [...dragging].sort().join('\u0000');
    if (held?.key !== key) {
      const kept = new Map<string, RoutedEdge>();
      for (const [id, route] of routes) {
        const ends = lastEnds.get(id);
        if (ends && (dragging.has(ends[0]) || dragging.has(ends[1]))) continue;
        kept.set(id, route);
      }
      held = { key, routes: kept };
    }
    return { routes: held.routes, pass: 'held', millis: 0 };
  };

  /** The last routes still right for `rects`: a line keeps its route while neither of its cards moved or resized. */
  const stillRight = (rects: Map<string, string>): Map<string, RoutedEdge> | null => {
    if (!last) return null;
    const kept = new Map<string, RoutedEdge>();
    for (const [id, route] of last) {
      const ends = lastEnds.get(id);
      if (!ends) continue;
      const [a, b] = ends;
      if (rects.get(a) === undefined || rects.get(a) !== lastRects.get(a)) continue;
      if (rects.get(b) === undefined || rects.get(b) !== lastRects.get(b)) continue;
      kept.set(id, route);
    }
    return kept.size === last.size ? last : kept;
  };

  const remember = (routes: Map<string, RoutedEdge>, input: RoutingInput) => {
    last = routes;
    lastEnds = endsOf(input);
    lastRects = rectKeysOf(input);
  };

  const off = (millis = 0): RoutingUpdate => {
    held = null;
    last = null;
    seq++; // an answer still on its way is stale now
    queued = null;
    return { routes: null, pass: 'off', millis };
  };

  const workerHandle = (): RoutingWorkerHandle | null => {
    if (worker !== undefined || disposed) return worker ?? null;
    worker = null;
    try {
      worker = opts.worker?.({ onResult, onFailure }) ?? null;
    } catch (err) {
      onError(err);
      worker = null;
    }
    return worker;
  };

  const post = (job: WorkerJob) => {
    inFlight = job;
    worker?.post({ type: 'route', seq: job.seq, input: job.input, style: job.style, zoom: job.zoom });
  };

  function onResult(result: WorkerRouteResult) {
    if (disposed) return;
    const job = inFlight;
    inFlight = null;
    if (queued) {
      const next = queued;
      queued = null;
      post(next);
    }
    if (!job || result.seq !== job.seq || job.seq !== seq) return; // superseded
    if (result.error) onError(new Error(result.error));
    if (result.millis > WORKER_HARD_LIMIT_MS) {
      slowAt = job.lineCount;
      emit(off(result.millis));
      return;
    }
    fullMillis = result.millis;
    const routes = keepUnchanged(last, result.edges);
    remember(routes, job.input);
    held = null;
    const dragging = latest?.dragging;
    emit(dragging && dragging.size > 0 ? hold(dragging, routes) : { routes, pass: 'routed', millis: result.millis });
  }

  function onFailure(err: unknown) {
    if (disposed) return;
    onError(err);
    worker = null;
    inFlight = null;
    queued = null;
    // Carry on without it: route the newest request again, on the main thread.
    if (latest) emit(engine.update(latest));
  }

  const engine: EdgeRoutingEngine = {
    update(request) {
      latest = request;
      const n = request.lineCount;
      const dragging = request.dragging ?? EMPTY_SET;
      const inDrag = dragging.size > 0;
      const wantsWorker = n > MAIN_THREAD_MAX_LINES || (workerFromLines !== null && n >= workerFromLines);
      const w = wantsWorker ? workerHandle() : null;
      const cap = w ? MAX_ROUTED_LINES : MAX_ROUTED_LINES_WITHOUT_WORKER;
      if (disposed || n > cap || (slowAt !== null && n >= slowAt)) return off();

      if (w) {
        if (inDrag) {
          queued = null;
          seq++; // a pass from before the drag would land on moved cards
          return last ? hold(dragging, last) : { routes: null, pass: 'held', millis: 0 };
        }
        held = null;
        const input = safely(request.input, null, onError);
        if (!input) return off();
        const job: WorkerJob = { seq: ++seq, input, style: request.style, zoom: request.zoom ?? 1, lineCount: n };
        if (inFlight) queued = job;
        else post(job);
        return { routes: stillRight(rectKeysOf(input)), pass: 'pending', millis: 0 };
      }

      seq++; // a worker answer still on its way is stale now
      queued = null;
      if (inDrag && last && (dragSlow || fullMillis > DRAG_HOLD_AFTER_MS)) return hold(dragging, last);
      if (!inDrag) dragSlow = false;
      held = null;
      const input = safely(request.input, null, onError);
      if (!input) return off();
      const result = routeAll(input, lineStyleOptions(request.style), {
        router,
        now,
        zoom: request.zoom,
        onError,
      });
      // A worker may still be had (not tried yet, or running): a slow pass moves this size there.
      const canUseWorker = opts.worker !== undefined && worker !== null && !disposed;
      if (result.millis > ROUTING_HARD_LIMIT_MS && !canUseWorker) {
        slowAt = n;
        return off(result.millis);
      }
      if (inDrag) {
        if (result.millis > DRAG_REROUTE_BUDGET_MS) dragSlow = true;
      } else {
        fullMillis = result.millis;
      }
      // Slow enough to pause the canvas: the next passes at this size go to the worker.
      if (result.millis > DRAG_HOLD_AFTER_MS && canUseWorker) workerFromLines = Math.min(workerFromLines ?? n, n);
      remember(result.edges, input);
      return { routes: result.edges, pass: 'routed', millis: result.millis };
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      inFlight = null;
      queued = null;
    },
  };
  return engine;
}

/** Does a route draw exactly what another does (path, crossings, x-ray, labels)? */
function sameRoute(a: RoutedEdge, b: RoutedEdge): boolean {
  return (
    a.d === b.d &&
    a.strokeD === b.strokeD &&
    a.halo === b.halo &&
    a.mid.x === b.mid.x &&
    a.mid.y === b.mid.y &&
    a.sourceAnchor.x === b.sourceAnchor.x &&
    a.sourceAnchor.y === b.sourceAnchor.y &&
    a.sourceAnchor.side === b.sourceAnchor.side &&
    a.targetAnchor.x === b.targetAnchor.x &&
    a.targetAnchor.y === b.targetAnchor.y &&
    a.targetAnchor.side === b.targetAnchor.side &&
    (a.tunnels === b.tunnels || JSON.stringify(a.tunnels) === JSON.stringify(b.tunnels))
  );
}

/**
 * A worker's routes arrive as new objects (copied between threads), so every
 * line would re-render. Keep the previous object for each route that draws
 * the same: after a card is dropped, only the lines that changed re-render.
 */
function keepUnchanged(prev: Map<string, RoutedEdge> | null, next: Map<string, RoutedEdge>): Map<string, RoutedEdge> {
  if (!prev) return next;
  const out = new Map<string, RoutedEdge>();
  let changed = next.size !== prev.size;
  for (const [id, route] of next) {
    const before = prev.get(id);
    if (before && sameRoute(before, route)) out.set(id, before);
    else {
      out.set(id, route);
      changed = true;
    }
  }
  return changed ? out : prev;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
