/**
 * `routeAll`: route and draw every line of one diagram in one pass. Its own
 * module (no React Flow, no React) so the line-routing worker can bundle it
 * without the canvas code around it.
 */

import type { LineRouter, LineStyleOptions, RouteResult, RoutedEdge, RoutedLine, RoutingInput } from './types';
import { createAvoidRouter } from './routers/orthogonalAvoid';
import { renderPaths } from './render/pathRender';
import { computeTunnels } from './render/tunnels';

/** A router that throws must never take the canvas down: fall back. */
export function safely<T>(fn: () => T, fallback: T, onError: (err: unknown) => void): T {
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
