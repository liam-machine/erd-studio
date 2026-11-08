/**
 * Route-around router — the whole pass.
 *
 *   1. Grid: the padded cards' edges, channel midlines, side centres, and per
 *      line the middle of the gap between its two cards and the straight-line
 *      option where their sides overlap (grid.ts). Self-loops are left to the
 *      canvas, but the space their loop takes is an obstacle.
 *   2. Route every line, shortest first, with A* from any free anchor slot on
 *      any side of its source to any on its target (search.ts). The router
 *      picks the side: a line may leave the side the transformer chose when
 *      another is clearly better. Lines routed later pay to cross or run
 *      along earlier ones, so they spread over the free channels, and once a
 *      card side has a line attached, the zone in front of it (stubs and
 *      `*` / `1` labels) is closed to every other line.
 *      Before the first line is routed, the zones in front of the sides the
 *      canvas picked for every line are marked too, and a crossing on a stub
 *      (between a card and its `*` / `1`, or on the leg out of it) costs
 *      STUB_CROSS times more: it reads as a T junction.
 *      In a drag, lines away from the moved card keep their routes; a line
 *      routed again prefers the sides and slots it had (hysteresis), so it
 *      does not jump about as its card moves a pixel at a time.
 *   3. Nudge: centre free segments, then order and spread lines that share a
 *      channel or a card side, so they read as separate wires and never
 *      cross right at a card (nudge.ts).
 *   4. Check: no segment may pass through a card other than one the line had
 *      to ignore. A line that can't be routed at all (its end is buried under
 *      another card) falls back to today's simple three-segment path.
 */

import {
  PATH_GAP,
  type EdgeSpec,
  type Point,
  type Rect,
  type RoutedLine,
  type RoutingInput,
  type Side,
} from "../../types";
import { pushOut } from "../../input";
import {
  Buckets,
  SIDES,
  anchorBehind,
  anchorRange,
  legOrient,
  outDir,
  portPoint,
  rectsOverlap,
  segmentEntersRect,
  sideMid,
  sideSpan,
  simplifyOrthogonal,
} from "./geom";
import {
  ceilIndex,
  floorIndex,
  gridLines,
  makeGrid,
  markBand,
  markPathUse,
  markRect,
  markUse,
  markZone,
  nearIndex,
  type Grid,
} from "./grid";
import { Searcher, type Found, type Port } from "./search";
import { centrePass, nudgePass, straightenPass, type NudgePath } from "./nudge";
import {
  ANCHOR_SEP,
  CROSS,
  HEURISTIC_WEIGHT,
  LONG_CROSS_CUT,
  LONG_EXTRA,
  LONG_FROM,
  LONG_RAMP,
  MARGIN,
  MAX_POPS,
  MERGE_EPS,
  MIN_LEG,
  OWN_CLEAR,
  SHARE,
  SHIFT,
  SHIFT_SQ,
  SLOT,
  SOFT_EPS,
  STICK_MAX_CHANGED,
  STICK_SIDE,
  STICK_SLOT,
  STUB_CROSS,
  ZONE,
  ZONE_COST,
  LOCAL_FROM_CARDS,
  LOCAL_GROWTH,
  LOCAL_MARGIN,
  LOCAL_MAX_NODES,
  LOCAL_LONG_CROSS_CUT,
  LOCAL_LONG_EXTRA,
  LOCAL_LONG_FROM,
  RESCUE_CROSS,
  RESCUE_WEIGHT,
} from "./params";

export interface AvoidResult {
  lines: Map<string, RoutedLine>;
  /** Lines with no route around the cards: they got today's three-segment path. */
  fallbacks: Set<string>;
  /** Lines routed only by letting them pass under cards that crowd their ends. */
  relaxed: Map<string, Set<string>>;
  /** Grid size and A* expansions, for tests and the perf readout. */
  stats: { gridX: number; gridY: number; pops: number; reused: number };
}

/** Matches FkEdge's self-loop: radius 55, each further loop on a card 18 wider. */
const LOOP_RADIUS = 55;
const LOOP_STEP = 18;
/** Room for a self-loop's role label (drawn above the loop's middle), and round its two anchors. */
const LOOP_LABEL = { halfWidth: 34, height: 28, anchorRoom: 8 };

/** A route kept from the last pass, and what it depended on. */
interface Kept {
  srcKey: string;
  tgtKey: string;
  /** The raw route (before straightening and nudging). */
  pts: Point[];
  srcSide: Side;
  tgtSide: Side;
  ignore: string[] | null;
  fallback: boolean;
  /** Any card that moves into (or out of) this box may change the route. */
  reach: { x0: number; y0: number; x1: number; y1: number };
}

interface Memo {
  rects: Map<string, Rect>;
  routes: Map<string, Kept>;
}

/**
 * One router's state between passes: the last pass (routing runs every frame
 * of a drag and most lines don't change; a re-routed line prefers the sides
 * and slots it had) and the A* scratch buffers. Each canvas holds its own
 * router (`createAvoidRouter`), so two diagrams on one page never share it.
 */
interface RouterState {
  memo: Memo | null;
  searcher: Searcher;
}

/** A route-around router with its own memory of the last pass. */
export interface AvoidRouter {
  /** Route every line; lines away from what changed since the last pass keep their routes. */
  route(input: RoutingInput): AvoidResult;
  /** Drop the last pass: the next `route` routes every line from scratch. */
  reset(): void;
}

export function createAvoidRouter(): AvoidRouter {
  const state: RouterState = { memo: null, searcher: new Searcher() };
  return {
    route: (input) => routeAvoid(state, input),
    reset: () => {
      state.memo = null;
    },
  };
}

const rectKey = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;

/** How near a moved card must come to a route to make it worth routing again. */
const REACH = MARGIN + ZONE + 2 * 12;

function influence(pts: readonly Point[], a: Rect, b: Rect): Kept["reach"] {
  let x0 = Math.min(a.x, b.x);
  let y0 = Math.min(a.y, b.y);
  let x1 = Math.max(a.x + a.width, b.x + b.width);
  let y1 = Math.max(a.y + a.height, b.y + b.height);
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0: x0 - REACH, y0: y0 - REACH, x1: x1 + REACH, y1: y1 + REACH };
}

/** Channel midlines between facing neighbours that a padded route can pass between. */
function addMidlines(rects: readonly Rect[], xs: number[], ys: number[]): void {
  const n = rects.length;
  for (let a = 0; a < n; a++) {
    const A = rects[a];
    const ar = A.x + A.width;
    const ab = A.y + A.height;
    let right = Infinity;
    let below = Infinity;
    for (let b = 0; b < n; b++) {
      if (a === b) continue;
      const B = rects[b];
      // Facing: overlapping by a real stretch, not just a corner.
      if (
        B.x >= ar &&
        B.y < ab - MARGIN &&
        A.y < B.y + B.height - MARGIN &&
        B.x < right
      )
        right = B.x;
      if (
        B.y >= ab &&
        B.x < ar - MARGIN &&
        A.x < B.x + B.width - MARGIN &&
        B.y < below
      )
        below = B.y;
    }
    if (right < Infinity && right - ar > 2 * MARGIN) xs.push((ar + right) / 2);
    if (below < Infinity && below - ab > 2 * MARGIN) ys.push((ab + below) / 2);
  }
}

/** The space a self-loop (and its role label) takes, from the canvas's own loop geometry. */
function loopBlocker(spec: EdgeSpec): Rect {
  const r = LOOP_RADIUS + LOOP_STEP * spec.loopIndex;
  const s = pushOut(spec.sourceAnchor, spec.sourceAnchor.side, PATH_GAP);
  const t = pushOut(spec.targetAnchor, spec.targetAnchor.side, PATH_GAP);
  // A little past the loop's two anchors too, so a neighbouring anchor keeps its distance.
  const x0 = Math.min(s.x, t.x) - LOOP_LABEL.anchorRoom;
  const x1 = Math.max(s.x, t.x) + 0.75 * r + LOOP_LABEL.halfWidth;
  const y0 = Math.min(s.y, t.y) - 0.75 * r - LOOP_LABEL.height;
  const y1 = Math.max(s.y, t.y) + LOOP_LABEL.anchorRoom;
  return {
    id: `${spec.id}#loop`,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    kind: "annotation",
  };
}

/**
 * The anchor slots on one side of a card that a line can use: every grid
 * line inside the side's anchor range whose straight leg (from the stub out
 * to the first grid line at least MIN_LEG further) is free. A slot whose leg
 * would cross lines already routed costs CROSS per crossing.
 */
/** Where a line routed again would like its anchor: the side and slot it had, moved with its card. */
type Pref = { side: Side; c: number };

/** Anchors already placed on a card side: slot coordinate and the card at the line's other end. */
type Taken = { c: number; other: string }[];

function portsOf(
  grid: Grid,
  r: Rect,
  side: Side,
  asGoal: boolean,
  out: Port[],
  taken: Taken | undefined,
  other: string,
  pref: Pref | null,
): void {
  const { xs, ys, nx, hBlk, vBlk, hUse, vUse } = grid;
  const o = legOrient(side);
  const d = outDir(side);
  const [r0, r1] = anchorRange(r, side);
  const mid = sideMid(r, side);
  const slots = o === 0 ? ys : xs; // anchor coordinates run along the side
  const legs = o === 0 ? xs : ys; // the leg runs across it
  const first = ceilIndex(slots, r0 - MERGE_EPS);
  const lastSlot = floorIndex(slots, r1 + MERGE_EPS);
  for (let q = first; q <= lastSlot; q++) {
    const c = slots[q];
    const point = portPoint(r, side, c);
    const p = o === 0 ? point.x : point.y;
    let end: number;
    let from: number;
    let to: number;
    if (d > 0) {
      end = ceilIndex(legs, p + MIN_LEG);
      if (end >= legs.length) continue;
      from = Math.max(0, floorIndex(legs, p));
      to = end - 1;
    } else {
      end = floorIndex(legs, p - MIN_LEG);
      if (end < 0) continue;
      from = end;
      to = Math.min(legs.length - 1, ceilIndex(legs, p)) - 1;
    }
    let free = true;
    let extra = 0;
    for (let e = from; e <= to && free; e++) {
      // Edge e runs along the lane from node e to node e + 1.
      const edge = o === 0 ? q * nx + e : e * nx + q;
      free = (o === 0 ? hBlk[edge] : vBlk[edge]) === 0;
      if (!free) break;
      const use = o === 0 ? hUse[edge] : vUse[edge];
      if (use) extra += SHARE * use * Math.abs(legs[e + 1] - legs[e]);
      // Node e (inside the leg, not where it turns): a line already routed straight across it.
      if (e > from) {
        const across =
          o === 0
            ? edge >= nx && vUse[edge] > 0 && vUse[edge - nx] > 0
            : edge % nx > 0 && hUse[edge] > 0 && hUse[edge - 1] > 0;
        if (across) extra += CROSS * STUB_CROSS;
      }
    }
    if (!free) continue;
    // Lines already routed across the piece between the card and the stub
    // (where this anchor's `*` / `1` would sit): a crossing there reads as a
    // T junction at the label.
    {
      const border = p - d * PATH_GAP;
      const lo = Math.min(border, p);
      const hi = Math.max(border, p);
      for (
        let e = ceilIndex(legs, lo + 0.5);
        e < legs.length && legs[e] <= hi + 0.5;
        e++
      ) {
        const across =
          o === 0
            ? q > 0 && vUse[q * nx + e] > 0 && vUse[(q - 1) * nx + e] > 0
            : q > 0 && hUse[e * nx + q] > 0 && hUse[e * nx + q - 1] > 0;
        if (across) extra += CROSS * STUB_CROSS;
      }
    }
    if (taken) {
      for (const t of taken) {
        if (t.other === other) continue; // a twin: it runs alongside
        const near = 1 - Math.abs(c - t.c) / ANCHOR_SEP;
        if (near > 0) extra += SLOT * near;
      }
    }
    if (pref)
      extra +=
        pref.side === side ? STICK_SLOT * Math.abs(c - pref.c) : STICK_SIDE;
    const node = o === 0 ? q * nx + end : end * nx + q;
    const off = c - mid;
    out.push({
      side,
      c,
      point,
      node,
      orient: o,
      dir: (asGoal ? -d : d) as 1 | -1,
      cost:
        SHIFT * Math.abs(off) +
        SHIFT_SQ * off * off +
        Math.abs(legs[end] - p) +
        extra,
      lane: q,
      legLo: from,
      legHi: to,
    });
  }
}

/** Where a straight line from `r`'s side to `other` could run (middle of the overlap), or null. */
function straightOption(r: Rect, other: Rect, side: Side): number | null {
  const [a0, a1] = anchorRange(r, side);
  const [b0, b1] = anchorRange(other, side);
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  return lo <= hi ? (lo + hi) / 2 : null;
}

/**
 * Count the piece between a stub and its card as used. The `*` / `1` sits
 * there and it is drawn, but it is not on the routing grid's lines: a later
 * line crossing it must see the crossing (and pay STUB_CROSS for it), not slip
 * between the card and the stub for free.
 */
function markStub(grid: Grid, side: Side, point: Point, eps = 0.01): void {
  const orient = legOrient(side);
  const legs = orient === 0 ? grid.xs : grid.ys;
  const lanes = orient === 0 ? grid.ys : grid.xs;
  const c = orient === 0 ? point.y : point.x;
  const lane = nearIndex(lanes, c, eps);
  if (lane < 0) return;
  const stub = orient === 0 ? point.x : point.y;
  const border = stub - outDir(side) * PATH_GAP;
  const lo = Math.min(stub, border);
  const hi = Math.max(stub, border);
  const first = Math.max(0, floorIndex(legs, lo) - 1);
  const last = Math.min(legs.length - 2, ceilIndex(legs, hi));
  const { nx, hUse, vUse } = grid;
  for (let e = first; e <= last; e++) {
    // Elementary edges inside (card border, stub).
    if (legs[e + 1] <= lo + 0.5 || legs[e] >= hi - 0.5) continue;
    const edge = orient === 0 ? lane * nx + e : e * nx + lane;
    if (orient === 0) {
      if (hUse[edge] < 255) hUse[edge]++;
    } else if (vUse[edge] < 255) vUse[edge]++;
  }
}

/** Count a port's straight leg as used, like the rest of the route. */
function markLeg(grid: Grid, port: Port): void {
  const { nx, hUse, vUse } = grid;
  for (let e = port.legLo; e <= port.legHi; e++) {
    if (port.orient === 0) {
      const edge = port.lane * nx + e;
      if (hUse[edge] < 255) hUse[edge]++;
    } else {
      const edge = e * nx + port.lane;
      if (vUse[edge] < 255) vUse[edge]++;
    }
  }
}

/** The band in front of a card side where its stubs and `*` / `1` labels sit. */
function zoneOf(
  r: Rect,
  side: Side,
): { x0: number; y0: number; x1: number; y1: number } {
  switch (side) {
    case "top":
      return { x0: r.x, y0: r.y - ZONE, x1: r.x + r.width, y1: r.y };
    case "bottom":
      return {
        x0: r.x,
        y0: r.y + r.height,
        x1: r.x + r.width,
        y1: r.y + r.height + ZONE,
      };
    case "left":
      return { x0: r.x - ZONE, y0: r.y, x1: r.x, y1: r.y + r.height };
    case "right":
      return {
        x0: r.x + r.width,
        y0: r.y,
        x1: r.x + r.width + ZONE,
        y1: r.y + r.height,
      };
  }
}

function fallbackLine(spec: EdgeSpec): RoutedLine {
  const s = pushOut(spec.sourceAnchor, spec.sourceAnchor.side, PATH_GAP);
  const t = pushOut(spec.targetAnchor, spec.targetAnchor.side, PATH_GAP);
  const horizontal =
    spec.sourceAnchor.side === "left" || spec.sourceAnchor.side === "right";
  const pts = horizontal
    ? [s, { x: (s.x + t.x) / 2, y: s.y }, { x: (s.x + t.x) / 2, y: t.y }, t]
    : [s, { x: s.x, y: (s.y + t.y) / 2 }, { x: t.x, y: (s.y + t.y) / 2 }, t];
  return {
    sourceAnchor: spec.sourceAnchor,
    targetAnchor: spec.targetAnchor,
    points: simplifyOrthogonal(pts),
  };
}

/** Does any segment of the polyline pass through a card (other than ones the line may ignore)? */
function pathHitsCard(
  pts: readonly Point[],
  rects: readonly Rect[],
  cards: number,
  buckets: Buckets,
  ignore: ReadonlySet<number> | null,
): boolean {
  const near: number[] = [];
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    buckets.query(
      Math.min(a.x, b.x),
      Math.min(a.y, b.y),
      Math.max(a.x, b.x),
      Math.max(a.y, b.y),
      near,
    );
    for (const oi of near) {
      if (oi >= cards || (ignore && ignore.has(oi))) continue;
      if (segmentEntersRect(a, b, rects[oi], 0.5)) return true;
    }
  }
  return false;
}

/** A box the grid can hold: finite, non-negative size (an unmeasured or corrupt node is left out, and so are its lines). */
const usableRect = (r: Rect) =>
  Number.isFinite(r.x) &&
  Number.isFinite(r.y) &&
  Number.isFinite(r.width) &&
  Number.isFinite(r.height) &&
  r.width >= 0 &&
  r.height >= 0;
const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);

function routeAvoid(state: RouterState, input: RoutingInput): AvoidResult {
  const cards = input.obstacles.every(usableRect)
    ? input.obstacles
    : input.obstacles.filter(usableRect);
  const indexOf = new Map<string, number>();
  cards.forEach((r, i) => indexOf.set(r.id, i));
  const result: AvoidResult = {
    lines: new Map(),
    fallbacks: new Set(),
    relaxed: new Map(),
    stats: { gridX: 0, gridY: 0, pops: 0, reused: 0 },
  };

  const edges = input.edges.filter(
    (e) =>
      !e.isSelfLoop &&
      e.source !== e.target &&
      indexOf.has(e.source) &&
      indexOf.has(e.target),
  );
  if (!edges.length) return result;

  // Everything a line must keep clear of: the cards (indices 0..cards.length-1), then self-loops.
  const blockers: Rect[] = [...cards];
  for (const e of input.edges) {
    if (
      (e.isSelfLoop || e.source === e.target) &&
      indexOf.has(e.source) &&
      finitePoint(e.sourceAnchor) &&
      finitePoint(e.targetAnchor)
    ) {
      blockers.push(loopBlocker(e));
    }
  }

  // Routing order: shortest first.
  const rankOf = new Map<string, number>();
  [...edges]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .forEach((e, i) => rankOf.set(e.id, i));
  const dist = (e: EdgeSpec) => {
    const a = cards[indexOf.get(e.source)!];
    const b = cards[indexOf.get(e.target)!];
    return (
      Math.abs(a.x + a.width / 2 - b.x - b.width / 2) +
      Math.abs(a.y + a.height / 2 - b.y - b.height / 2)
    );
  };
  const order = [...edges].sort(
    (a, b) => dist(a) - dist(b) || rankOf.get(a.id)! - rankOf.get(b.id)!,
  );

  // Change detection against the last pass (cards, notes and self-loops by id).
  const prev = state.memo;
  const nextMemo: Memo = {
    rects: new Map(blockers.map((r) => [r.id, r])),
    routes: new Map(),
  };
  const changed: Rect[] = [];
  if (prev) {
    for (const r of blockers) {
      const old = prev.rects.get(r.id);
      if (!old || rectKey(old) !== rectKey(r)) {
        changed.push(r);
        if (old) changed.push(old);
      }
    }
    for (const [id, old] of prev.rects)
      if (!nextMemo.rects.has(id)) changed.push(old);
  }
  const reusable = (spec: EdgeSpec): Kept | null => {
    if (!prev || changed.length > blockers.length / 2) return null;
    const kept = prev.routes.get(spec.id);
    if (!kept) return null;
    if (
      kept.srcKey !== rectKey(cards[indexOf.get(spec.source)!]) ||
      kept.tgtKey !== rectKey(cards[indexOf.get(spec.target)!])
    )
      return null;
    for (const r of changed) {
      if (!(
        r.x < kept.reach.x1 &&
        r.x + r.width > kept.reach.x0 &&
        r.y < kept.reach.y1 &&
        r.y + r.height > kept.reach.y0
      ))
        continue;
      // Within reach of the route itself (a card it went round, or one now in its way)?
      const x0 = r.x - REACH;
      const y0 = r.y - REACH;
      const x1 = r.x + r.width + REACH;
      const y1 = r.y + r.height + REACH;
      const pts = kept.pts;
      if (!pts.length) return null;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1];
        const b = pts[k];
        if (
          Math.max(a.x, b.x) > x0 &&
          Math.min(a.x, b.x) < x1 &&
          Math.max(a.y, b.y) > y0 &&
          Math.min(a.y, b.y) < y1
        )
          return null;
      }
    }
    return kept;
  };

  // Lines whose surroundings did not change keep the route they had (a drag
  // moves one card a frame: only the lines near it are routed again).
  const keptRoutes = new Map<string, Kept>();
  const fresh: EdgeSpec[] = [];
  for (const spec of order) {
    const kept = reusable(spec);
    if (kept) keptRoutes.set(spec.id, kept);
    else fresh.push(spec);
  }
  // A line routed again because one of its cards moved (or a card came near)
  // prefers the sides and slots it had, carried along with its card: without
  // this, a 1 px move can swap a soft grid line for another and the anchor
  // jumps 20-50 px, or the line flips to another side, frame after frame of a drag.
  const prefer = new Map<string, { src: Pref | null; tgt: Pref | null }>();
  const prefXs: number[] = [];
  const prefYs: number[] = [];
  // Only for a drag (a few cards moved). When most cards change at once — the
  // first measure after load, a re-layout, an expand-all — routes start afresh.
  if (prev && changed.length <= STICK_MAX_CHANGED) {
    const carry = (cardId: string, side: Side, stub: Point): Pref | null => {
      const was = prev.rects.get(cardId);
      const now = cards[indexOf.get(cardId)!];
      // A card that changed size (expanded, collapsed, measured) is re-planned too.
      if (!was || was.width !== now.width || was.height !== now.height)
        return null;
      const horizontal = side === "left" || side === "right";
      const offset = (horizontal ? stub.y : stub.x) - sideSpan(was, side)[0];
      const [lo, hi] = anchorRange(now, side);
      const c = Math.min(hi, Math.max(lo, sideSpan(now, side)[0] + offset));
      (horizontal ? prefYs : prefXs).push(c);
      return { side, c };
    };
    for (const spec of fresh) {
      const old = prev.routes.get(spec.id);
      if (!old || old.fallback || old.pts.length < 2) continue;
      prefer.set(spec.id, {
        src: carry(spec.source, old.srcSide, old.pts[0]),
        tgt: carry(spec.target, old.tgtSide, old.pts[old.pts.length - 1]),
      });
    }
  }

  // --- 1. Grid --------------------------------------------------------------
  // Hard lines (padded card edges, the outer ring) are kept exactly; soft
  // lines (side centres, midlines, straight-line options) snap to a line
  // already there when within SOFT_EPS.
  //
  // A small diagram gets one grid over all of it, as it always has. A large
  // one (`local`) would get a grid whose size grows with the square of the
  // diagram (every card's edges cross every other card's), so each line is
  // routed on its own local grid instead: the area round its two cards, with
  // every card in it blocked and every line already routed through it marked
  // (see `localGrid`), widened while the route has to run along its edge.
  const ring = 2 * (PATH_GAP + MIN_LEG);
  const used = new Set<number>();
  for (const e of edges) {
    used.add(indexOf.get(e.source)!);
    used.add(indexOf.get(e.target)!);
  }
  const padded = blockers.map((r) => ({
    x0: r.x - MARGIN,
    y0: r.y - MARGIN,
    x1: r.x + r.width + MARGIN,
    y1: r.y + r.height + MARGIN,
  }));
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const r of blockers) {
    bx0 = Math.min(bx0, r.x);
    by0 = Math.min(by0, r.y);
    bx1 = Math.max(bx1, r.x + r.width);
    by1 = Math.max(by1, r.y + r.height);
  }
  /** The soft lines one line adds (straight option, the middle of the gap), and the box where they matter. */
  const edgeSoft = edges.map((e) => {
    const a = cards[indexOf.get(e.source)!];
    const b = cards[indexOf.get(e.target)!];
    const xs: number[] = [];
    const ys: number[] = [];
    // Where the two cards' sides overlap, a straight line is possible: offer its middle.
    const sy = straightOption(a, b, "left");
    if (sy !== null) ys.push(sy);
    const sx = straightOption(a, b, "top");
    if (sx !== null) xs.push(sx);
    // The middle of the gap between them: where a step between the two cards turns.
    if (b.x > a.x + a.width) xs.push((a.x + a.width + b.x) / 2);
    else if (a.x > b.x + b.width) xs.push((b.x + b.width + a.x) / 2);
    if (b.y > a.y + a.height) ys.push((a.y + a.height + b.y) / 2);
    else if (a.y > b.y + b.height) ys.push((b.y + b.height + a.y) / 2);
    const x0 = Math.min(a.x, b.x);
    const y0 = Math.min(a.y, b.y);
    return {
      xs,
      ys,
      box: { id: e.id, x: x0, y: y0, width: Math.max(a.x + a.width, b.x + b.width) - x0, height: Math.max(a.y + a.height, b.y + b.height) - y0, kind: "annotation" as const },
    };
  });

  /** Grid lines over `rects` (indices into blockers), with `extra` hard lines and the soft lines of `soft` (indices into edges). */
  const linesFor = (
    rects: readonly number[],
    soft: readonly number[],
    xsExtra: number[],
    ysExtra: number[],
  ): { xs: Float64Array; ys: Float64Array } => {
    const xsHard: number[] = [...xsExtra, ...prefXs];
    const ysHard: number[] = [...ysExtra, ...prefYs];
    const xsSoft: number[] = [];
    const ysSoft: number[] = [];
    const inCards: Rect[] = [];
    for (const i of rects) {
      const r = blockers[i];
      xsHard.push(padded[i].x0, padded[i].x1);
      ysHard.push(padded[i].y0, padded[i].y1);
      if (i < cards.length) {
        inCards.push(r);
        if (used.has(i)) {
          xsSoft.push(r.x + r.width / 2);
          ysSoft.push(r.y + r.height / 2);
        }
      }
    }
    addMidlines(inCards, xsSoft, ysSoft);
    for (const k of soft) {
      xsSoft.push(...edgeSoft[k].xs);
      ysSoft.push(...edgeSoft[k].ys);
    }
    return {
      xs: gridLines(xsHard, xsSoft, SOFT_EPS),
      ys: gridLines(ysHard, ysSoft, SOFT_EPS),
    };
  };

  const allBlockers = blockers.map((_, i) => i);
  const local = blockers.length > LOCAL_FROM_CARDS;
  let grid: Grid;
  if (!local) {
    const { xs, ys } = linesFor(
      allBlockers,
      edges.map((_, k) => k),
      [bx0 - ring, bx1 + ring],
      [by0 - ring, by1 + ring],
    );
    grid = makeGrid(xs, ys);
    result.stats.gridX = grid.nx;
    result.stats.gridY = grid.ny;
    for (let i = 0; i < blockers.length; i++)
      markRect(grid, padded[i].x0, padded[i].y0, padded[i].x1, padded[i].y1, 1);
  } else {
    grid = makeGrid(new Float64Array(0), new Float64Array(0));
  }
  const mark = (i: number, delta: 1 | -1) =>
    markRect(
      grid,
      padded[i].x0,
      padded[i].y0,
      padded[i].x1,
      padded[i].y1,
      delta,
    );

  // Local grids: where to find the cards, the lines' soft lines and the lines routed so far.
  const blockerIndex = local ? new Buckets(blockers, 320) : null;
  const softIndex = local ? new Buckets(edgeSoft.map((e) => e.box), 320) : null;
  const committed: { pts: Point[]; srcSide: Side; tgtSide: Side }[] = [];
  const committedIndex = local ? new GrowingIndex(400) : null;
  // Every card side's anchor zone (card index * 4 + side), and which are marked (`zoned`).
  const zoneRects = local
    ? cards.flatMap((card) =>
        SIDES.map((side) => {
          const z = zoneOf(card, side);
          return { id: "", x: z.x0, y: z.y0, width: z.x1 - z.x0, height: z.y1 - z.y0, kind: "annotation" as const };
        }),
      )
    : null;
  const zoneIndex = local ? new Buckets(zoneRects!, 320) : null;
  const zoneFlags = local ? new Uint8Array(cards.length * 4) : null;
  const flagZone = (card: Rect, side: Side) => {
    if (zoneFlags) zoneFlags[indexOf.get(card.id)! * 4 + SIDES.indexOf(side)] = 1;
  };
  const near: number[] = [];

  /**
   * The local grid for a line between cards `a` and `b`: their box plus
   * `margin`, grown until every padded card it touches lies wholly inside (so
   * a card is either on the grid, blocked, or not reachable at all), with
   * every line already routed through it counted. Its outermost lines are its
   * edge, except when it covers the whole diagram (`whole`): then it has the
   * outer ring the global grid has. Null when it would exceed
   * LOCAL_MAX_NODES.
   */
  const localGrid = (a: Rect, b: Rect, margin: number): { grid: Grid; whole: boolean; box: [number, number, number, number] } | null => {
    // The box the line may use. Cards that straddle its edge are on the grid
    // whole (so they are blocked whole); everything outside the box is closed.
    let x0 = Math.min(a.x, b.x) - margin;
    let y0 = Math.min(a.y, b.y) - margin;
    let x1 = Math.max(a.x + a.width, b.x + b.width) + margin;
    let y1 = Math.max(a.y + a.height, b.y + b.height) + margin;
    const whole = x0 <= bx0 - ring && y0 <= by0 - ring && x1 >= bx1 + ring && y1 >= by1 + ring;
    if (whole) {
      x0 = bx0 - ring;
      y0 = by0 - ring;
      x1 = bx1 + ring;
      y1 = by1 + ring;
    }
    blockerIndex!.query(x0, y0, x1, y1, near);
    const inside: number[] = [];
    for (const i of near) {
      const p = padded[i];
      if (p.x1 < x0 || p.x0 > x1 || p.y1 < y0 || p.y0 > y1) continue;
      inside.push(i);
    }
    softIndex!.query(x0, y0, x1, y1, near);
    const soft = near.slice();
    // The lines already routed through the area: their own coordinates become
    // grid lines, so the usage below lands exactly on them.
    const paths = committedIndex!.query(x0, y0, x1, y1);
    const xsExtra = [x0, x1];
    const ysExtra = [y0, y1];
    for (const k of paths) {
      const pts = committed[k].pts;
      for (let q = 1; q < pts.length; q++) {
        const p = pts[q - 1];
        const r = pts[q];
        if (Math.max(p.x, r.x) < x0 || Math.min(p.x, r.x) > x1 || Math.max(p.y, r.y) < y0 || Math.min(p.y, r.y) > y1) continue;
        if (Math.abs(p.y - r.y) < 0.01 && p.y > y0 && p.y < y1) ysExtra.push(p.y);
        else if (Math.abs(p.x - r.x) < 0.01 && p.x > x0 && p.x < x1) xsExtra.push(p.x);
      }
    }
    const { xs, ys } = linesFor(inside, soft, xsExtra, ysExtra);
    // Lines past the straddling cards (a preferred slot of a card elsewhere) are not wanted.
    let lx = x0;
    let ly = y0;
    let hx = x1;
    let hy = y1;
    for (const i of inside) {
      lx = Math.min(lx, padded[i].x0);
      ly = Math.min(ly, padded[i].y0);
      hx = Math.max(hx, padded[i].x1);
      hy = Math.max(hy, padded[i].y1);
    }
    const clip = (arr: Float64Array, lo: number, hi: number) => arr.filter((v) => v >= lo - 1e-6 && v <= hi + 1e-6);
    const cx = clip(xs, lx, hx);
    const cy = clip(ys, ly, hy);
    if (cx.length * cy.length > LOCAL_MAX_NODES) return null;
    const g = makeGrid(cx, cy);
    for (const i of inside) markRect(g, padded[i].x0, padded[i].y0, padded[i].x1, padded[i].y1, 1);
    // Close everything outside the box (the box's own edge stays open).
    const far = 1e9;
    if (lx < x0) markBand(g, -far, -far, x0, far, 1);
    if (hx > x1) markBand(g, x1, -far, far, far, 1);
    if (ly < y0) markBand(g, -far, -far, far, y0, 1);
    if (hy > y1) markBand(g, -far, y1, far, far, 1);
    zoneIndex!.query(x0, y0, x1, y1, near);
    for (const zi of near) {
      if (!zoneFlags![zi]) continue;
      const z = zoneRects![zi];
      if (z.x + z.width < x0 || z.x > x1 || z.y + z.height < y0 || z.y > y1) continue;
      markZone(g, z.x, z.y, z.x + z.width, z.y + z.height, 1);
    }
    for (const k of paths) {
      const c = committed[k];
      markPathUse(g, c.pts, MERGE_EPS);
      markStub(g, c.srcSide, c.pts[0], MERGE_EPS);
      markStub(g, c.tgtSide, c.pts[c.pts.length - 1], MERGE_EPS);
    }
    result.stats.gridX = Math.max(result.stats.gridX, g.nx);
    result.stats.gridY = Math.max(result.stats.gridY, g.ny);
    return { grid: g, whole, box: [x0, y0, x1, y1] };
  };

  const seeds: Port[] = [];
  const goals: Port[] = [];
  const routed: { spec: EdgeSpec; path: NudgePath }[] = [];
  /** Card sides whose anchor zone is marked on the grid. */
  const zoned = new Set<string>();
  /** …and the ones a routed line really attaches to (the nudging pass keeps out of these). */
  const zoneUsed = new Set<string>();
  const zones: Rect[] = [];
  const taken = new Map<string, Taken>();
  const take = (card: Rect, side: Side, c: number, other: string) => {
    const key = `${card.id}\u0000${side}`;
    const list = taken.get(key);
    if (list) list.push({ c, other });
    else taken.set(key, [{ c, other }]);
  };
  // A self-loop's two anchors (drawn by the canvas) hold their slots too.
  for (const e of input.edges) {
    if (!(e.isSelfLoop || e.source === e.target) || !indexOf.has(e.source))
      continue;
    const card = cards[indexOf.get(e.source)!];
    for (const a of [e.sourceAnchor, e.targetAnchor])
      take(
        card,
        a.side,
        a.side === "left" || a.side === "right" ? a.y : a.x,
        "",
      );
  }
  /** Lift (-1) or restore (+1) the anchor zones of one card: a line may use its own cards' zones. */
  const cardZones = (card: Rect, delta: 1 | -1) => {
    for (const side of SIDES) {
      if (!zoned.has(`${card.id}\u0000${side}`)) continue;
      const z = zoneOf(card, side);
      markZone(grid, z.x0, z.y0, z.x1, z.y1, delta);
    }
  };

  const attempt = (
    si: number,
    ti: number,
    useZones: boolean,
    pref?: { src: Pref | null; tgt: Pref | null },
    rescue = false,
  ) => {
    seeds.length = 0;
    goals.length = 0;
    const src = cards[si];
    const tgt = cards[ti];
    for (const side of SIDES) {
      portsOf(
        grid,
        src,
        side,
        false,
        seeds,
        taken.get(`${src.id}\u0000${side}`),
        tgt.id,
        pref?.src ?? null,
      );
      portsOf(
        grid,
        tgt,
        side,
        true,
        goals,
        taken.get(`${tgt.id}\u0000${side}`),
        src.id,
        pref?.tgt ?? null,
      );
    }
    if (!seeds.length || !goals.length) return null;
    // The line's own cards: their anchor zones open to it (its first bends
    // live there), but it may not come within OWN_CLEAR of either card except
    // along its two stubs, which the ports above already checked.
    const band = (r: Rect, delta: 1 | -1) =>
      markBand(
        grid,
        r.x - OWN_CLEAR,
        r.y - OWN_CLEAR,
        r.x + r.width + OWN_CLEAR,
        r.y + r.height + OWN_CLEAR,
        delta,
      );
    cardZones(src, -1);
    if (ti !== si) cardZones(tgt, -1);
    band(src, 1);
    if (ti !== si) band(tgt, 1);
    // Long lines cross most of the diagram, where crossings are unavoidable and
    // an exact search floods every channel: let them be a little greedier.
    const span =
      Math.abs(src.x + src.width / 2 - tgt.x - tgt.width / 2) +
      Math.abs(src.y + src.height / 2 - tgt.y - tgt.height / 2);
    const long = Math.min(1, Math.max(0, (span - (local ? LOCAL_LONG_FROM : LONG_FROM)) / LONG_RAMP));
    const found = state.searcher.search(
      grid,
      seeds,
      goals,
      MAX_POPS,
      useZones,
      rescue ? RESCUE_WEIGHT : HEURISTIC_WEIGHT + (local ? LOCAL_LONG_EXTRA : LONG_EXTRA) * long,
      rescue ? CROSS * RESCUE_CROSS : CROSS * (1 - (local ? LOCAL_LONG_CROSS_CUT : LONG_CROSS_CUT) * long),
    );
    band(src, -1);
    if (ti !== si) band(tgt, -1);
    cardZones(src, 1);
    if (ti !== si) cardZones(tgt, 1);
    result.stats.pops += state.searcher.lastPops;
    return found;
  };

  /** Count a route in: its grid edges, its slots and the anchor zones of its two sides. */
  const commit = (
    spec: EdgeSpec,
    pts: Point[],
    srcSide: Side,
    tgtSide: Side,
    ignore: Set<number> | null,
    found: Found | null,
  ) => {
    const src = cards[indexOf.get(spec.source)!];
    const tgt = cards[indexOf.get(spec.target)!];
    if (local) {
      // Local grids are rebuilt per line: the route is replayed onto each one it crosses.
      const k = committed.length;
      committed.push({ pts: pts.map((p) => ({ x: p.x, y: p.y })), srcSide, tgtSide });
      for (let q = 1; q < pts.length; q++) committedIndex!.add(k, pts[q - 1], pts[q]);
    } else {
      if (found) {
        markUse(grid, found.nodes);
        markLeg(grid, found.src);
        markLeg(grid, found.tgt);
      } else {
        markPathUse(grid, pts);
      }
      markStub(grid, srcSide, pts[0]);
      markStub(grid, tgtSide, pts[pts.length - 1]);
    }
    const along = (p: Point, side: Side) =>
      side === "left" || side === "right" ? p.y : p.x;
    take(src, srcSide, along(pts[0], srcSide), tgt.id);
    take(tgt, tgtSide, along(pts[pts.length - 1], tgtSide), src.id);
    for (const [card, side] of [
      [src, srcSide],
      [tgt, tgtSide],
    ] as const) {
      const key = `${card.id}\u0000${side}`;
      const z = zoneOf(card, side);
      if (!zoned.has(key)) {
        zoned.add(key);
        flagZone(card, side);
        if (!local) markZone(grid, z.x0, z.y0, z.x1, z.y1, 1);
      }
      if (zoneUsed.has(key)) continue;
      zoneUsed.add(key);
      zones.push({
        id: `${key}#zone`,
        x: z.x0,
        y: z.y0,
        width: z.x1 - z.x0,
        height: z.y1 - z.y0,
        kind: "annotation",
      });
    }
    if (ignore && ignore.size)
      result.relaxed.set(spec.id, new Set([...ignore].map((i) => cards[i].id)));
    routed.push({
      spec,
      path: {
        pts,
        src,
        srcSide,
        tgt,
        tgtSide,
        rank: rankOf.get(spec.id)!,
        ignore: ignore && ignore.size ? ignore : null,
        own: [indexOf.get(spec.source)!, indexOf.get(spec.target)!],
      },
    });
    nextMemo.routes.set(spec.id, {
      srcKey: rectKey(src),
      tgtKey: rectKey(tgt),
      // A copy: the nudging passes below rewrite the path's points.
      pts: pts.slice(),
      srcSide,
      tgtSide,
      ignore:
        ignore && ignore.size ? [...ignore].map((i) => cards[i].id) : null,
      fallback: false,
      reach: influence(pts, src, tgt),
    });
  };

  // Pre-mark the zones in front of the sides the canvas picked for every line,
  // before any line is routed. Otherwise the first lines routed run straight
  // across sides that lines routed later attach to, and those lines cross them
  // right at their `*` / `1`, which reads as a T junction (overlap: the
  // order → employee line through the carrier and service-level stubs).
  for (const e of edges) {
    for (const [id, side] of [
      [e.source, e.sourceAnchor.side],
      [e.target, e.targetAnchor.side],
    ] as const) {
      const card = cards[indexOf.get(id)!];
      const key = `${card.id}\u0000${side}`;
      if (zoned.has(key)) continue;
      zoned.add(key);
      flagZone(card, side);
      if (local) continue; // marked on each local grid as it is built
      const z = zoneOf(card, side);
      markZone(grid, z.x0, z.y0, z.x1, z.y1, 1);
    }
  }

  for (const spec of order) {
    const kept = keptRoutes.get(spec.id);
    if (!kept) continue;
    result.stats.reused++;
    if (kept.fallback) {
      result.fallbacks.add(spec.id);
      result.lines.set(spec.id, fallbackLine(spec));
      nextMemo.routes.set(spec.id, kept);
      continue;
    }
    const ignore = kept.ignore
      ? new Set(
          kept.ignore
            .map((id) => indexOf.get(id)!)
            .filter((i) => i !== undefined),
        )
      : null;
    commit(
      spec,
      kept.pts.map((p) => ({ x: p.x, y: p.y })),
      kept.srcSide,
      kept.tgtSide,
      ignore,
      null,
    );
  }

  for (const spec of fresh) {
    const si = indexOf.get(spec.source)!;
    const ti = indexOf.get(spec.target)!;
    const src = cards[si];
    const tgt = cards[ti];
    // With closed anchor zones, a line that finds no way round tries again through them.
    const pref = prefer.get(spec.id);
    const normal = () =>
      attempt(si, ti, true, pref) ??
      (ZONE_COST < 0 ? attempt(si, ti, false, pref) : null);
    // No way round at all: let the line pass under the cards crowding (or lying over) its ends.
    const relaxed = (): { found: Found; ignore: Set<number> } | null => {
      const reach = PATH_GAP + MIN_LEG + MARGIN;
      const ignore = new Set<number>();
      for (let i = 0; i < cards.length; i++) {
        if (i === si || i === ti) continue;
        if (
          rectsOverlap(cards[i], 0, src, reach) ||
          rectsOverlap(cards[i], 0, tgt, reach)
        )
          ignore.add(i);
      }
      if (rectsOverlap(src, 0, tgt, reach)) {
        ignore.add(si);
        ignore.add(ti);
      }
      if (!ignore.size) return null;
      for (const i of ignore) mark(i, -1);
      const f = attempt(si, ti, false, pref);
      for (const i of ignore) mark(i, 1);
      return f ? { found: f, ignore } : null;
    };
    let found: Found | null = null;
    let ignore: Set<number> | null = null;
    let routedPts: Point[] | null = null;
    if (!local) {
      found = normal();
      if (!found) {
        const r = relaxed();
        if (r) ({ found, ignore } = r);
      }
      if (found) routedPts = pointsOf(found, grid);
    } else {
      // Widen the local grid while the route has to run along its edge (a
      // better one may lie outside) or none is found; the relaxed retry only
      // once the widest grid has no way round either.
      let margin = LOCAL_MARGIN;
      let built = false;
      for (;;) {
        const lg = localGrid(src, tgt, margin);
        if (!lg) break;
        grid = lg.grid;
        built = true;
        const f = normal();
        if (f) {
          found = f;
          routedPts = pointsOf(f, grid);
          if (lg.whole || !touchesBox(routedPts, lg.box)) break;
        } else if (state.searcher.lastPops > MAX_POPS) {
          // Out of budget, not out of room: a wider grid would only search
          // longer. Rescue it with a greedy search that hardly minds crossing
          // other lines (a line across a crowded channel between two columns
          // weighs every crossing and runs out), before it falls back to a
          // path straight through the cards.
          const f2 = attempt(si, ti, true, pref, true);
          if (f2) {
            found = f2;
            routedPts = pointsOf(f2, grid);
          }
          break;
        } else if (lg.whole) {
          break;
        }
        margin *= LOCAL_GROWTH;
      }
      if (!found && built) {
        const r = relaxed();
        if (r) {
          ({ found, ignore } = r);
          routedPts = pointsOf(r.found, grid);
        }
      }
    }
    if (!found) {
      result.fallbacks.add(spec.id);
      result.lines.set(spec.id, fallbackLine(spec));
      nextMemo.routes.set(spec.id, {
        srcKey: rectKey(src),
        tgtKey: rectKey(tgt),
        pts: [],
        srcSide: spec.sourceAnchor.side,
        tgtSide: spec.targetAnchor.side,
        ignore: null,
        fallback: true,
        reach: influence([], src, tgt),
      });
      continue;
    }
    commit(
      spec,
      routedPts!,
      found.src.side,
      found.tgt.side,
      ignore && ignore.size ? ignore : null,
      found,
    );
  }
  state.memo = nextMemo;

  // --- 3. Nudge ---------------------------------------------------------------
  routed.sort((a, b) => a.path.rank - b.path.rank);
  const paths = routed.map((r) => r.path);
  const before = paths.map((p) => p.pts.slice());
  // Nudging keeps clear of cards, loops and anchor zones (a segment already
  // inside a zone — a stub — is not held back by it).
  const nudgeBlockers = [...blockers, ...zones];
  const ctx = {
    rects: nudgeBlockers,
    buckets: new Buckets(nudgeBlockers),
    zoneFrom: blockers.length,
  };
  straightenPass(paths, ctx);
  centrePass(paths, true, ctx);
  nudgePass(paths, true, ctx);
  centrePass(paths, false, ctx);
  nudgePass(paths, false, ctx);

  // --- 4. Check and emit ------------------------------------------------------
  const cardBuckets = new Buckets(blockers);
  routed.forEach(({ spec, path }, i) => {
    let pts = simplifyOrthogonal(path.pts);
    if (
      pts.length < 2 ||
      pathHitsCard(pts, blockers, cards.length, cardBuckets, path.ignore)
    )
      pts = before[i];
    if (pathHitsCard(pts, blockers, cards.length, cardBuckets, path.ignore)) {
      result.fallbacks.add(spec.id);
      result.lines.set(spec.id, fallbackLine(spec));
      return;
    }
    result.lines.set(spec.id, {
      sourceAnchor: anchorBehind(pts[0], path.srcSide),
      targetAnchor: anchorBehind(pts[pts.length - 1], path.tgtSide),
      points: pts,
    });
  });
  return result;
}

/** A search result as points: the source stub, the grid nodes, the target stub. */
function pointsOf(found: Found, grid: Grid): Point[] {
  const pts: Point[] = [found.src.point];
  for (const n of found.nodes) {
    const i = n % grid.nx;
    pts.push({ x: grid.xs[i], y: grid.ys[(n - i) / grid.nx] });
  }
  pts.push(found.tgt.point);
  return simplifyOrthogonal(pts);
}

/** Does the route reach the edge of the box it was confined to (a better one may lie outside)? */
function touchesBox(pts: readonly Point[], box: readonly [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = box;
  for (const p of pts)
    if (p.x <= x0 + 0.5 || p.y <= y0 + 0.5 || p.x >= x1 - 0.5 || p.y >= y1 - 0.5) return true;
  return false;
}

/**
 * The routes committed so far, by the bucket cells their segments pass
 * through, so a local grid replays only the lines that cross it.
 */
class GrowingIndex {
  private readonly cells = new Map<number, number[]>();
  /** Segments too long to bucket (a card placed absurdly far away): always returned. */
  private readonly everywhere = new Set<number>();
  private seen = new Uint32Array(64);
  private stamp = 0;

  constructor(private readonly cell: number) {}

  private key(c: number, r: number): number {
    return (c + 0x8000) * 0x10000 + (r + 0x8000);
  }

  add(k: number, a: Point, b: Point): void {
    const c0 = Math.floor(Math.min(a.x, b.x) / this.cell);
    const c1 = Math.floor(Math.max(a.x, b.x) / this.cell);
    const r0 = Math.floor(Math.min(a.y, b.y) / this.cell);
    const r1 = Math.floor(Math.max(a.y, b.y) / this.cell);
    if (!Number.isFinite(c0 + c1 + r0 + r1) || (c1 - c0 + 1) * (r1 - r0 + 1) > 4096 || Math.abs(c0) > 0x7000 || Math.abs(c1) > 0x7000 || Math.abs(r0) > 0x7000 || Math.abs(r1) > 0x7000) {
      this.everywhere.add(k);
      return;
    }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const key = this.key(c, r);
        const list = this.cells.get(key);
        if (!list) this.cells.set(key, [k]);
        else if (list[list.length - 1] !== k) list.push(k);
      }
  }

  query(x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = [...this.everywhere];
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const c0 = Math.max(-0x7000, Math.floor(x0 / this.cell));
    const c1 = Math.min(0x7000, Math.floor(x1 / this.cell));
    const r0 = Math.max(-0x7000, Math.floor(y0 / this.cell));
    const r1 = Math.min(0x7000, Math.floor(y1 / this.cell));
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > 1 << 20) {
      // A box over the whole canvas: every route.
      const all = new Set<number>(this.everywhere);
      for (const list of this.cells.values()) for (const k of list) all.add(k);
      return [...all];
    }
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(this.key(c, r));
        if (!list) continue;
        for (const k of list) {
          if (k >= this.seen.length) {
            const grown = new Uint32Array(Math.max(k + 1, this.seen.length * 2));
            grown.set(this.seen);
            this.seen = grown;
          }
          if (this.seen[k] === this.stamp || this.everywhere.has(k)) continue;
          this.seen[k] = this.stamp;
          out.push(k);
        }
      }
    return out;
  }
}
