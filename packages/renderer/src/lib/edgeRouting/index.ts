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

import type { LineRouter, LineStyleOptions, RouteResult, RoutedEdge, RoutedLine, RoutingInput } from './types';
import { createAvoidRouter } from './routers/orthogonalAvoid';
import { renderPaths } from './render/pathRender';
import { computeTunnels } from './render/tunnels';
import { lineStyleOptions, type LineStyle } from './lineStyle';

export * from './types';
export { buildRoutingInput, routingInputKey, draggingNodesKey } from './input';
export { createAvoidRouter, type AvoidRouter } from './routers/orthogonalAvoid';
export * from './lineStyle';

/** A router that throws must never take the canvas down: fall back. */
function safely<T>(fn: () => T, fallback: T, onError: (err: unknown) => void): T {
  try {
    return fn();
  } catch (err) {
    onError(err);
    return fallback;
  }
}

export interface RouteAllOptions {
  /** The router (and its memory of the last pass). Default: a fresh route-around router, so the call keeps no state. */
  router?: LineRouter;
  /** Clock for `millis` (default: none, `millis` is 0). */
  now?: () => number;
  /** The canvas zoom: hops are sized for it (`hopRadiusFor`). Default 1. */
  zoom?: number;
  /** Called with a router or renderer error (the pass still returns, with fewer or no routes). */
  onError?: (err: unknown) => void;
}

/** Route and draw every line of `input` in one pass. Never throws. */
export function routeAll(input: RoutingInput, options: LineStyleOptions, ctx: RouteAllOptions = {}): RouteResult {
  const now = ctx.now ?? (() => 0);
  const onError = ctx.onError ?? (() => {});
  const router = ctx.router ?? createAvoidRouter();
  const start = now();
  const lines = safely(() => router.route(input).lines, new Map<string, RoutedLine>(), (err) => {
    // A pass that failed half-way may have left the router's memory inconsistent.
    router.reset();
    onError(err);
  });
  const rendered = safely(
    () =>
      renderPaths(lines, {
        crossings: options.crossings,
        corners: options.corners,
        obstacles: input.obstacles,
        zoom: ctx.zoom ?? 1,
      }),
    new Map(),
    onError,
  );
  const specs = new Map(input.edges.map((e) => [e.id, e]));
  const edges = new Map<string, RoutedEdge>();
  for (const [id, line] of lines) {
    const r = rendered.get(id);
    if (!r) continue;
    const spec = specs.get(id);
    const tunnels =
      options.underTables === 'xray' && spec ? safely(() => computeTunnels(line, spec, input.obstacles), [], onError) : undefined;
    const routed: RoutedEdge = {
      ...line,
      d: r.d,
      mid: r.mid,
      halo: r.halo,
      tunnels: tunnels && tunnels.length ? tunnels : undefined,
    };
    if (r.strokeD) routed.strokeD = r.strokeD;
    edges.set(id, routed);
  }
  return { edges, millis: now() - start };
}

// ---------------------------------------------------------------------------
// The performance guard
// ---------------------------------------------------------------------------

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
 */
export const DRAG_HOLD_AFTER_MS = 50;
/** A pass slower than this (ms) turns routing off for diagrams of that size: every line draws the fallback. */
export const ROUTING_HARD_LIMIT_MS = 150;
/** Diagrams with more lines than this are never routed (the fallback draws them). */
export const MAX_ROUTED_LINES = 600;

/** What the engine did on one update. */
export type RoutingPass =
  /** Every line routed. */
  | 'routed'
  /** A drag on a slow diagram: the last routes kept, minus the lines of the dragged cards. */
  | 'held'
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
  /** The number of FK lines (for the hard cap, without building the input). */
  lineCount: number;
  style: LineStyle;
  /** The canvas zoom (hops are sized for it). */
  zoom?: number;
  /** Ids of the cards being dragged (empty when no drag is in progress). */
  dragging?: ReadonlySet<string>;
}

export interface EdgeRoutingEngine {
  update(request: RoutingRequest): RoutingUpdate;
}

/**
 * One canvas's routing: its own router (so two canvases on a page never share
 * the router's memory of the last pass) and the performance guard.
 *
 * - A diagram with more than `MAX_ROUTED_LINES` lines is never routed.
 * - During a drag the router re-routes only what the move touches, which is
 *   usually far cheaper than a full pass (40 tables / 60 lines: about 16 ms
 *   cold, 6 ms a drag frame). When one drag frame takes more than
 *   `DRAG_REROUTE_BUDGET_MS`, or the last pass outside a drag took more than
 *   `DRAG_HOLD_AFTER_MS`, the drag stops routing: the routes stay as they
 *   were, minus the lines touching a dragged card (they draw the fallback,
 *   which follows the card), and the first update after the drag routes
 *   everything again.
 * - A pass that takes more than `ROUTING_HARD_LIMIT_MS` turns routing off for
 *   this canvas while the diagram has at least that many lines.
 * - A router or renderer error is reported once (`console.warn`), never per
 *   frame, and leaves those lines on the fallback. Nothing else is logged.
 */
export function createEdgeRoutingEngine(now: () => number = defaultNow): EdgeRoutingEngine {
  const router = createAvoidRouter();
  /** The last pass outside a drag. */
  let fullMillis = 0;
  /** A frame of the drag in progress blew the budget: hold until it ends. */
  let dragSlow = false;
  /** Line count at which a pass blew the hard limit (routing off at or above it). */
  let slowAt: number | null = null;
  /** The last routed pass: its routes and each line's two cards. */
  let last: Map<string, RoutedEdge> | null = null;
  let lastEnds = new Map<string, [string, string]>();
  /** The held routes and the drag they were made for, so one drag hands back one map. */
  let held: { key: string; routes: Map<string, RoutedEdge> } | null = null;
  let warned = false;
  const onError = (err: unknown) => {
    if (warned) return;
    warned = true;
    // eslint-disable-next-line no-console
    console.warn('[edge-routing] Line routing failed; the affected lines use the simple path.', err);
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

  return {
    update(request) {
      const dragging = request.dragging ?? EMPTY_SET;
      const inDrag = dragging.size > 0;
      if (request.lineCount > MAX_ROUTED_LINES || (slowAt !== null && request.lineCount >= slowAt)) {
        held = null;
        last = null;
        return { routes: null, pass: 'off', millis: 0 };
      }
      if (inDrag && last && (dragSlow || fullMillis > DRAG_HOLD_AFTER_MS)) return hold(dragging, last);
      if (!inDrag) dragSlow = false;
      held = null;
      const input = safely(request.input, null, onError);
      if (!input) {
        last = null;
        return { routes: null, pass: 'off', millis: 0 };
      }
      const result = routeAll(input, lineStyleOptions(request.style), {
        router,
        now,
        zoom: request.zoom,
        onError,
      });
      if (result.millis > ROUTING_HARD_LIMIT_MS) {
        slowAt = request.lineCount;
        last = null;
        return { routes: null, pass: 'off', millis: result.millis };
      }
      if (inDrag) {
        if (result.millis > DRAG_REROUTE_BUDGET_MS) dragSlow = true;
      } else {
        fullMillis = result.millis;
      }
      last = result.edges;
      lastEnds = new Map(input.edges.map((e) => [e.id, [e.source, e.target]]));
      return { routes: result.edges, pass: 'routed', millis: result.millis };
    },
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

const defaultNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
