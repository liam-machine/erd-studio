/**
 * Line routing on the canvas. Render all three as children of `<ReactFlow>`
 * (CanvasBackdrop does), in the editor and in the viewer alike: none of them
 * posts to a host or shows an editing affordance.
 *
 * - `EdgeRouter` routes every FK line in one pass whenever a card moves, is
 *   measured, or the line style changes, and puts the result in the canvas
 *   store (`edgeRoutes`). `FkEdge` reads its own route from there. Each
 *   canvas has its own routing engine (router memory and performance guard).
 * - `EdgeOverlay` draws what has to sit above the cards: the x-ray stretches
 *   of a line that passes under a table (the `curved` style).
 * - `LayerLineColour` hands the diagram's layer colour to the CSS, which a
 *   logical-only canvas lights the focused lines with (EdgeRouting.css).
 */

import { useEffect, useId, useRef } from 'react';
import { ViewportPortal, useStore, useStoreApi, type Edge } from '@xyflow/react';
import { useEditorStore, useEditorStoreApi } from '../store/editorStore';
import {
  buildRoutingInput,
  createEdgeRoutingEngine,
  routingWorkerFactory,
  draggingNodesKey,
  lineStyleOptions,
  routingInputKey,
  type EdgeRoutingEngine,
  type Point,
  type RoutingUpdate,
  type Rect,
} from '../lib/edgeRouting';
import { rectOfNode } from '../lib/edgeRouting/input';
import { EDGE_TOLERANCE } from '../lib/edgeRouting/render/tunnels';
import { CURVE_RADIUS, ROUNDED_RADIUS } from '../lib/edgeRouting/render/corners';
import { edgeFocusRole } from '../lib/canvasFocus';
import type { FkEdgeData } from '../types/graph';
import './EdgeRouting.css';

/**
 * The diagram's own layer colour, as `--diagram-layer-color` on the React
 * Flow root, so a logical-only canvas can light its focused lines with it
 * (EdgeRouting.css). Cleared when the diagram has no layer colour: the lines
 * then stay neutral grey.
 */
export function LayerLineColour() {
  const domNode = useStore((s) => s.domNode);
  const color = useEditorStore((s) => s.domain?.layerConfig?.color);
  useEffect(() => {
    if (!domNode) return;
    if (color) domNode.style.setProperty('--diagram-layer-color', color);
    else domNode.style.removeProperty('--diagram-layer-color');
    return () => {
      domNode.style.removeProperty('--diagram-layer-color');
    };
  }, [domNode, color]);
  return null;
}

/** The number of FK lines the router would route (for the engine's hard cap). */
function fkLineCount(edges: readonly Edge[]): number {
  let n = 0;
  for (const e of edges) if (e.type === 'fk' && !e.hidden) n++;
  return n;
}

/**
 * Routes every FK line once per frame in which a card moved, was measured or
 * the line style changed (and, for hops, when the zoom moves a quarter of a
 * doubling: hops are sized for it). The engine is this canvas's own, and
 * decides whether and where to route (see `createEdgeRoutingEngine`): a small
 * diagram routes here, on the main thread; a larger one in the canvas's
 * worker, whose answer arrives later through `onUpdate`; a slow diagram holds
 * its routes while a card is dragged and routes again when the drag ends
 * (`dragKey` changes back to empty).
 */
export function EdgeRouter() {
  const storeApi = useStoreApi();
  const canvas = useEditorStoreApi();
  const lineStyle = useEditorStore((s) => s.lineStyle);
  const hops = lineStyleOptions(lineStyle).crossings === 'hops';
  const key = useStore((s) => routingInputKey(s.nodeLookup, s.edges));
  const dragKey = useStore((s) => draggingNodesKey(s.nodeLookup));
  const zoomStep = useStore((s) => (hops ? Math.round(Math.log2(s.transform[2] || 1) * 4) / 4 : 0));
  const engine = useRef<EdgeRoutingEngine | null>(null);
  const frame = useRef(0);

  // The engine (and its worker) lives as long as the canvas.
  useEffect(
    () => () => {
      engine.current?.dispose();
      engine.current = null;
    },
    [],
  );

  useEffect(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const apply = (update: RoutingUpdate) => {
        canvas.getState().setEdgeRoutes(update.routes);
        // What the last pass did, for tests and for debugging in the field (no styling hangs off it).
        const root = storeApi.getState().domNode;
        if (root) root.dataset.edgeRouting = `${update.pass} ${Math.round(update.millis)}ms ${update.routes?.size ?? 0}`;
      };
      // The worker starts from the host's worker file when it gave one (ErdCanvas `routingWorkerUrl`), else from the inlined code.
      engine.current ??= createEdgeRoutingEngine({ worker: routingWorkerFactory(canvas.getState().routingWorkerUrl), onUpdate: apply });
      const { nodeLookup, edges } = storeApi.getState();
      const dragging = new Set<string>();
      for (const node of nodeLookup.values()) if (node.dragging && !node.hidden) dragging.add(node.id);
      const update = engine.current.update({
        input: () => buildRoutingInput(nodeLookup as never, edges),
        lineCount: fkLineCount(edges),
        style: lineStyle,
        zoom: 2 ** zoomStep,
        dragging,
      });
      apply(update);
    });
    return () => cancelAnimationFrame(frame.current);
  }, [key, dragKey, lineStyle, zoomStep, storeApi, canvas]);

  return null;
}

/** Radius (px) of a portal ring. */
const PORTAL_R = 4;

/** The colour key FkEdge uses for a line (`fk-edge--{key}`), so a tunnel matches its line. */
function statusKeyOf(data: FkEdgeData | undefined): string {
  if (!data) return 'logical';
  return data.discrepancyStatus ? `discrepancy-${data.discrepancyStatus}` : (data.stage ?? 'logical');
}

interface TunnelDraw {
  id: string;
  d: string;
  className: string;
  /** Where the ghost may show: the tunnels' boxes (so it never shows a stretch `computeTunnels` dropped). */
  windows: { x: number; y: number; width: number; height: number }[];
  /** A buried end: the line's stub lies inside another card, so its last 20 px to its own card are drawn too. */
  leads: string[];
  /** Where the line dives under a card's border, or comes back out. */
  portals: Point[];
}

/** Finite numbers only: a NaN in an SVG attribute is a console error and draws nothing useful. */
const finite = (...ns: number[]) => ns.every(Number.isFinite);

/**
 * The x-ray: every routed line that passes under a card is drawn again ABOVE
 * the cards, as a fine dashed ghost in the line's own colour, with a portal
 * ring where it dives under a border and where it comes back out. Only the
 * `curved` line style computes tunnels; with `hops` this draws nothing.
 *
 * The ghost is the line's own `d` (so it sits exactly on the hidden line
 * whatever the corner or crossing style) under two clips: the card boxes, and
 * the boxes of the line's tunnels (`windows`). The second clip keeps out what
 * `computeTunnels` deliberately dropped: a line's hook inside its own two
 * nearly touching cards, or a rounded corner grazing a card.
 *
 * A line whose end stub sits inside another card (the two cards closer than
 * 20 px) would leave its ghost dangling mid-card; a short `lead` carries it on
 * to the anchor on its own card, so the reader sees where it plugs in.
 *
 * Calm by default, loud on demand: at rest the ghost is faint and the portals
 * carry the message ("this line goes under here"); the lines of the hovered
 * or selected table, or the selected line (`flowFocus` / `hoverFocus`), get a
 * bright ghost; lines faded by a selection or by the hover preview fade their
 * ghost almost away. Pointer-events none, no host posts: viewer-safe.
 */
export function EdgeOverlay() {
  const routes = useEditorStore((s) => s.edgeRoutes);
  const corners = useEditorStore((s) => lineStyleOptions(s.lineStyle).corners);
  const flowFocus = useEditorStore((s) => s.flowFocus);
  const hoverFocus = useEditorStore((s) => s.hoverFocus);
  const flowEdges = useStore((s) => s.edges);
  const storeApi = useStoreApi();
  const clipId = `edge-xray-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!routes) return null;

  // How far the drawn corner can stray from the polyline the tunnels were cut from.
  const slack = (corners === 'curved' ? CURVE_RADIUS : ROUNDED_RADIUS) + 4;
  const tunnels: TunnelDraw[] = [];
  let edgeData: Map<string, FkEdgeData | undefined> | null = null;
  for (const [id, r] of routes) {
    if (!r.tunnels?.length || !r.d) continue;
    edgeData ??= new Map(flowEdges.map((e) => [e.id, e.data as FkEdgeData | undefined]));
    const data = edgeData.get(id);
    const lit = edgeFocusRole(flowFocus, hoverFocus, id) !== null;
    const first = r.points[0];
    const last = r.points[r.points.length - 1];
    const same = (q: Point | undefined, p: Point) => q !== undefined && Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5;
    const portals: Point[] = [];
    const windows: TunnelDraw['windows'] = [];
    const leads: string[] = [];
    for (const t of r.tunnels) {
      if (t.length < 2 || !t.every((p) => finite(p.x, p.y))) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const p of t) {
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x);
        y1 = Math.max(y1, p.y);
      }
      windows.push({ x: x0 - slack, y: y0 - slack, width: x1 - x0 + 2 * slack, height: y1 - y0 + 2 * slack });
      for (const [p, end] of [[t[0], 'start'], [t[t.length - 1], 'end']] as const) {
        if (same(first, p) && end === 'start') {
          const a = r.sourceAnchor;
          if (finite(a.x, a.y)) leads.push(`M ${a.x},${a.y} L ${p.x},${p.y}`);
        } else if (same(last, p) && end === 'end') {
          const a = r.targetAnchor;
          if (finite(a.x, a.y)) leads.push(`M ${p.x},${p.y} L ${a.x},${a.y}`);
        } else {
          portals.push(p);
        }
      }
    }
    if (windows.length === 0) continue;
    tunnels.push({
      id,
      d: r.d,
      className:
        `edge-overlay__tunnel edge-overlay__tunnel--${statusKeyOf(data)}` +
        `${data?.dimmed ? ' edge-overlay__tunnel--dimmed' : ''}${lit ? ' edge-overlay__tunnel--lit' : ''}`,
      windows,
      leads,
      portals,
    });
  }
  if (tunnels.length === 0) return null;

  // The cards, for the clip. Read, not subscribed: `routes` is recomputed
  // whenever a card moves or resizes.
  const rects: Rect[] = [];
  for (const node of storeApi.getState().nodeLookup.values()) {
    if (node.hidden) continue;
    const rect = rectOfNode(node as never);
    if (finite(rect.x, rect.y, rect.width, rect.height) && rect.width > 0 && rect.height > 0) rects.push(rect);
  }
  const inset = EDGE_TOLERANCE;

  return (
    <ViewportPortal>
      <svg className="edge-overlay" width={1} height={1}>
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            {rects.map((r) => (
              <rect
                key={r.id}
                x={r.x + inset}
                y={r.y + inset}
                width={Math.max(0, r.width - 2 * inset)}
                height={Math.max(0, r.height - 2 * inset)}
              />
            ))}
          </clipPath>
          {tunnels.map((t, i) => (
            <clipPath key={t.id} id={`${clipId}-${i}`} clipPathUnits="userSpaceOnUse">
              {t.windows.map((w, k) => (
                <rect key={k} x={w.x} y={w.y} width={w.width} height={w.height} />
              ))}
            </clipPath>
          ))}
        </defs>
        {tunnels.map((t, i) => (
          <g key={t.id} className={t.className}>
            {/* Nested clips intersect: inside a card AND inside one of this line's tunnels. */}
            <g clipPath={`url(#${clipId})`}>
              <path className="edge-overlay__tunnel-line" d={t.d} clipPath={`url(#${clipId}-${i})`} />
            </g>
            {t.leads.map((d, k) => (
              <path key={`l${k}`} className="edge-overlay__tunnel-line edge-overlay__tunnel-lead" d={d} />
            ))}
            {t.portals.map((p, k) => (
              <circle key={k} className="edge-overlay__portal" cx={p.x} cy={p.y} r={PORTAL_R - 0.5} />
            ))}
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}
