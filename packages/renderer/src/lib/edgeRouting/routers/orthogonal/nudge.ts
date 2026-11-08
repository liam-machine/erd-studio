/**
 * Route-around router — after every line has a route, make the routes read
 * as separate wires.
 *
 * For one dimension at a time (vertical segments, then horizontal):
 *
 * 1. Centre. A middle segment with both neighbours heading the same way (a
 *    "Z") can slide anywhere between them without changing the length or the
 *    bends; slide it to the middle of the free space (between the cards
 *    around it, and between its neighbours' far ends). Lines then run down
 *    the middle of a channel, and a step between two cards turns half-way,
 *    as today's smooth step does.
 *
 * 2. Nudge. Segments that share a channel (parallel, overlapping, within a
 *    few px) and the end segments that meet one card side are put in an
 *    order that does not make them cross, then spread apart: LINE_SEP in a
 *    channel, ANCHOR_SEP between anchors on a card side (moving an end
 *    segment slides its anchor along the side). The order comes from where
 *    the lines go at the ends of the shared stretch (Wybrow, Marriott &
 *    Stuckey's "ordering paths in a shared channel"): if one line turns off
 *    first, the other must sit on the far side of that turn. Where two lines
 *    turn together, the comparison follows them round the corner.
 *
 * Every move is bounded so a segment never comes closer than CLEAR to a
 * card (sweep-free), anchors stay off the corners, and the first / last bend
 * stays MIN_LEG past the stub.
 */

import type { Point, Rect, Side } from "../../types";
import { anchorRange, outDir, simplifyOrthogonal, type Buckets } from "./geom";
import {
  ANCHOR_SEP,
  CLEAR,
  LINE_SEP,
  MARGIN,
  MAX_SHIFT,
  MIN_LEG,
  MIN_RUN,
  NEAR,
  OWN_CLEAR,
  RELATE_WINDOW,
  TWIN_SEP,
} from "./params";

export interface NudgePath {
  /** From the source port to the target port; mutated in place. */
  pts: Point[];
  src: Rect;
  srcSide: Side;
  tgt: Rect;
  tgtSide: Side;
  /** Tie-break order (by edge id). */
  rank: number;
  /** Indices of cards this line may pass under (ends buried under another card). */
  ignore: ReadonlySet<number> | null;
  /** Indices of its own two cards: kept OWN_CLEAR away, except along the stubs. */
  own: readonly [number, number];
}

export interface NudgeContext {
  /** Cards, self-loops, then (from `zoneFrom` on) anchor zones. */
  rects: readonly Rect[];
  buckets: Buckets;
  /** Index of the first anchor zone in `rects`: zones need no extra clearance. */
  zoneFrom: number;
}

interface Seg {
  p: number;
  k: number;
  /** Coordinate across the segment (x of a vertical segment). */
  c: number;
  /** Span along the segment. */
  lo: number;
  hi: number;
  /** Card-side keys of the ends this segment carries ('' = none). */
  keyA: string;
  keyB: string;
  lb: number;
  ub: number;
  w: number;
}

interface Rel {
  a: number;
  b: number;
  sep: number;
  /** -1: a sits before (at a smaller coordinate than) b. */
  order: -1 | 1;
}

const EPS = 0.01;
const scratch: number[] = [];

function isVertical(pts: readonly Point[], k: number): boolean {
  return Math.abs(pts[k].x - pts[k + 1].x) < EPS;
}

const across = (vert: boolean, q: Point): number => (vert ? q.x : q.y);
const along = (vert: boolean, q: Point): number => (vert ? q.y : q.x);

/**
 * How far a segment at `c`, spanning [lo, hi] along itself, can move across
 * before it comes within `clear` of a card (cards in `ignore` don't count).
 * Never forces a move: the current position is always inside the range.
 */
function sweepBounds(
  ctx: NudgeContext,
  path: NudgePath,
  vert: boolean,
  c: number,
  lo: number,
  hi: number,
  clear: number,
  reach: number,
): [number, number] {
  let lb = c - reach;
  let ub = c + reach;
  const list = vert
    ? ctx.buckets.query(
        c - reach - clear,
        lo - clear,
        c + reach + clear,
        hi + clear,
        scratch,
      )
    : ctx.buckets.query(
        lo - clear,
        c - reach - clear,
        hi + clear,
        c + reach + clear,
        scratch,
      );
  const ignore = path.ignore;
  for (let q = 0; q < list.length; q++) {
    const oi = list[q];
    if (ignore && ignore.has(oi)) continue;
    const r = ctx.rects[oi];
    const gap =
      oi >= ctx.zoneFrom
        ? 1
        : oi === path.own[0] || oi === path.own[1]
          ? Math.max(clear, OWN_CLEAR)
          : clear;
    const a0 = vert ? r.y : r.x;
    const a1 = vert ? r.y + r.height : r.x + r.width;
    if (a1 + gap <= lo + 0.5 || a0 - gap >= hi - 0.5) continue;
    const p0 = vert ? r.x : r.y;
    const p1 = vert ? r.x + r.width : r.y + r.height;
    if (p1 <= c + 0.5) {
      if (p1 + gap > lb) lb = p1 + gap;
    } else if (p0 >= c - 0.5) {
      if (p0 - gap < ub) ub = p0 - gap;
    }
    // Otherwise the segment already runs inside the card's band (a relaxed
    // route under an overlapping card): that card can't bound it.
  }
  return [Math.min(lb, c), Math.max(ub, c)];
}

function setAcross(pts: Point[], k: number, vert: boolean, v: number): void {
  if (vert) {
    pts[k] = { x: v, y: pts[k].y };
    pts[k + 1] = { x: v, y: pts[k + 1].y };
  } else {
    pts[k] = { x: pts[k].x, y: v };
    pts[k + 1] = { x: pts[k + 1].x, y: v };
  }
}

// ---------------------------------------------------------------------------
// 0. Straighten: remove jogs
// ---------------------------------------------------------------------------

/**
 * Where a line steps sideways (segment k between two parallel segments that
 * head the same way, a "Z"), slide one of the two onto the other's line:
 * two bends fewer and never longer. Allowed when the area the segment
 * sweeps is clear of cards, loops and anchor zones (by MARGIN), an end
 * segment's anchor stays on its side, the neighbour beyond keeps its
 * direction and length (a stub keeps MIN_LEG), and the line crosses no more
 * of the others than before. Weighted A* and the grid both leave such jogs.
 */
export function straightenPass(paths: NudgePath[], ctx: NudgeContext): void {
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    for (let guard = 0; guard < 12; guard++) {
      if (!straightenOnce(paths, pi, ctx)) break;
      path.pts = simplifyOrthogonal(path.pts);
    }
  }
}

function straightenOnce(
  paths: NudgePath[],
  pi: number,
  ctx: NudgeContext,
): boolean {
  const pts = paths[pi].pts;
  const last = pts.length - 2;
  for (let k = 1; k < last; k++) {
    const vert = !isVertical(pts, k); // orientation of the two parallel neighbours
    const dPrev = Math.sign(along(vert, pts[k]) - along(vert, pts[k - 1]));
    const dNext = Math.sign(along(vert, pts[k + 2]) - along(vert, pts[k + 1]));
    if (dPrev === 0 || dPrev !== dNext) continue; // a U turn, not a jog
    // Move the earlier parallel onto the later one's line (its far neighbour is k - 2),
    // or the later onto the earlier's (far neighbour k + 2).
    if (tryMove(paths, pi, k - 1, -1, vert, across(vert, pts[k + 1]), ctx))
      return true;
    if (tryMove(paths, pi, k + 1, 1, vert, across(vert, pts[k]), ctx))
      return true;
  }
  return false;
}

/** Slide segment m to `target`; `far` says which neighbour is not the collapsing jog. */
function tryMove(
  paths: NudgePath[],
  pi: number,
  m: number,
  far: -1 | 1,
  vert: boolean,
  target: number,
  ctx: NudgeContext,
): boolean {
  const path = paths[pi];
  const pts = path.pts;
  const last = pts.length - 2;
  const cur = across(vert, pts[m]);
  if (Math.abs(target - cur) < 0.5) return false;
  const farSeg = m + far;
  if (farSeg < 0 || farSeg > last) {
    // m is an end segment: its anchor slides along the card side, inside the anchor range.
    const [r0, r1] =
      m === 0
        ? anchorRange(path.src, path.srcSide)
        : anchorRange(path.tgt, path.tgtSide);
    if (target < r0 - 0.01 || target > r1 + 0.01) return false;
  } else {
    // The far neighbour keeps its direction and enough length (a stub keeps MIN_LEG).
    const fixedEnd = far < 0 ? pts[m - 1] : pts[m + 2];
    const movingEnd = far < 0 ? pts[m] : pts[m + 1];
    const before = across(vert, movingEnd) - across(vert, fixedEnd);
    const after = target - across(vert, fixedEnd);
    if (before === 0 || Math.sign(before) !== Math.sign(after)) return false;
    const isStub = farSeg === 0 || farSeg === last;
    if (Math.abs(after) < (isStub ? MIN_LEG : MIN_RUN) - 0.01) return false;
  }
  const lo = Math.min(along(vert, pts[m]), along(vert, pts[m + 1]));
  const hi = Math.max(along(vert, pts[m]), along(vert, pts[m + 1]));
  const [lb, ub] = sweepBounds(
    ctx,
    path,
    vert,
    cur,
    lo,
    hi,
    MARGIN,
    Math.abs(target - cur) + 1,
  );
  if (target < lb - 0.01 || target > ub + 0.01) return false;
  const crossBefore = crossingsAround(paths, pi, m);
  const saved0 = pts[m];
  const saved1 = pts[m + 1];
  setAcross(pts, m, vert, target);
  moved(paths, pi, m);
  if (crossingsAround(paths, pi, m) > crossBefore) {
    pts[m] = saved0;
    pts[m + 1] = saved1;
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Centre the free middle segments
// ---------------------------------------------------------------------------

/** Proper crossing of two axis-aligned segments (touching or overlapping does not count). */
function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const abV = Math.abs(a.x - b.x) < EPS;
  const cdV = Math.abs(c.x - d.x) < EPS;
  if (abV === cdV) return false;
  const [v0, v1, h0, h1] = abV ? [a, b, c, d] : [c, d, a, b];
  const x = v0.x;
  const y = h0.y;
  return (
    x > Math.min(h0.x, h1.x) + EPS &&
    x < Math.max(h0.x, h1.x) - EPS &&
    y > Math.min(v0.y, v1.y) + EPS &&
    y < Math.max(v0.y, v1.y) - EPS
  );
}

/**
 * Which lines run near where: every cell a line's segments have ever passed
 * through (lines move during nudging; `moved` adds their new cells, nothing is
 * removed), so a query returns a superset of the lines near a box and the
 * exact test below does the counting. One per `paths` array (one per pass).
 */
class SegmentIndex {
  private readonly cells = new Map<number, number[]>();
  private seen = new Uint32Array(0);
  private stamp = 0;
  private static readonly CELL = 200;
  private static readonly LIMIT = 0x7000;

  constructor(paths: readonly NudgePath[]) {
    this.seen = new Uint32Array(paths.length);
    paths.forEach((path, p) => {
      for (let k = 1; k < path.pts.length; k++) this.add(p, path.pts[k - 1], path.pts[k]);
    });
  }

  private static cellOf(v: number): number {
    const c = Math.floor(v / SegmentIndex.CELL);
    return Math.max(-SegmentIndex.LIMIT, Math.min(SegmentIndex.LIMIT, Number.isFinite(c) ? c : 0));
  }

  private static key(c: number, r: number): number {
    return (c + 0x8000) * 0x10000 + (r + 0x8000);
  }

  add(p: number, a: Point, b: Point): void {
    const c0 = SegmentIndex.cellOf(Math.min(a.x, b.x));
    const c1 = SegmentIndex.cellOf(Math.max(a.x, b.x));
    const r0 = SegmentIndex.cellOf(Math.min(a.y, b.y));
    const r1 = SegmentIndex.cellOf(Math.max(a.y, b.y));
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const key = SegmentIndex.key(c, r);
        const list = this.cells.get(key);
        if (!list) this.cells.set(key, [p]);
        else if (!list.includes(p)) list.push(p);
      }
  }

  /** Lines that may have a segment in the box. */
  near(x0: number, y0: number, x1: number, y1: number, out: number[]): number[] {
    out.length = 0;
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const c0 = SegmentIndex.cellOf(x0);
    const c1 = SegmentIndex.cellOf(x1);
    const r0 = SegmentIndex.cellOf(y0);
    const r1 = SegmentIndex.cellOf(y1);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const list = this.cells.get(SegmentIndex.key(c, r));
        if (!list) continue;
        for (const p of list) {
          if (this.seen[p] === this.stamp) continue;
          this.seen[p] = this.stamp;
          out.push(p);
        }
      }
    return out;
  }
}

const segmentIndexes = new WeakMap<readonly NudgePath[], SegmentIndex>();

function indexOf(paths: readonly NudgePath[]): SegmentIndex {
  let index = segmentIndexes.get(paths);
  if (!index) {
    index = new SegmentIndex(paths);
    segmentIndexes.set(paths, index);
  }
  return index;
}

/** Segment k of path p (and its two neighbours) moved: record where they are now. */
function moved(paths: readonly NudgePath[], p: number, k: number): void {
  const index = segmentIndexes.get(paths);
  if (!index) return; // built later, from the current points
  const pts = paths[p].pts;
  for (let i = Math.max(1, k); i <= Math.min(pts.length - 1, k + 2); i++) index.add(p, pts[i - 1], pts[i]);
}

const nearBuf: number[] = [];

/** How many times segments k-1..k+1 of path `p` cross the other lines. */
function crossingsAround(paths: NudgePath[], p: number, k: number): number {
  const pts = paths[p].pts;
  let n = 0;
  const lo = Math.max(0, k - 1);
  const hi = Math.min(pts.length - 2, k + 1);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = lo; i <= hi + 1; i++) {
    x0 = Math.min(x0, pts[i].x);
    y0 = Math.min(y0, pts[i].y);
    x1 = Math.max(x1, pts[i].x);
    y1 = Math.max(y1, pts[i].y);
  }
  for (const q of indexOf(paths).near(x0, y0, x1, y1, nearBuf)) {
    if (q === p) continue;
    const other = paths[q].pts;
    for (let j = 1; j < other.length; j++) {
      const c = other[j - 1];
      const d = other[j];
      if (
        Math.max(c.x, d.x) < x0 ||
        Math.min(c.x, d.x) > x1 ||
        Math.max(c.y, d.y) < y0 ||
        Math.min(c.y, d.y) > y1
      )
        continue;
      for (let i = lo; i <= hi; i++) if (crosses(pts[i], pts[i + 1], c, d)) n++;
    }
  }
  return n;
}

export function centrePass(
  paths: NudgePath[],
  vert: boolean,
  ctx: NudgeContext,
): void {
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi];
    const pts = path.pts;
    const last = pts.length - 2;
    for (let k = 1; k < last; k++) {
      if (isVertical(pts, k) !== vert) continue;
      const a = pts[k - 1];
      const b = pts[k];
      const c = pts[k + 1];
      const d = pts[k + 2];
      const cur = across(vert, b);
      const sPrev = Math.sign(cur - across(vert, a));
      const sNext = Math.sign(across(vert, d) - across(vert, c));
      if (sPrev === 0 || sPrev !== sNext) continue; // a U turn hugs what it wraps
      const m1 = k - 1 === 0 ? MIN_LEG : MIN_RUN;
      const m2 = k + 1 === last ? MIN_LEG : MIN_RUN;
      let lo = sPrev > 0 ? across(vert, a) + m1 : across(vert, d) + m2;
      let hi = sPrev > 0 ? across(vert, d) - m2 : across(vert, a) - m1;
      if (lo > hi) continue;
      const reach = Math.max(Math.abs(lo - cur), Math.abs(hi - cur)) + 1;
      const s0 = Math.min(along(vert, b), along(vert, c));
      const s1 = Math.max(along(vert, b), along(vert, c));
      const [lb, ub] = sweepBounds(ctx, path, vert, cur, s0, s1, MARGIN, reach);
      lo = Math.max(lo, lb);
      hi = Math.min(hi, ub);
      if (lo > hi) continue;
      const target = (lo + hi) / 2;
      if (Math.abs(target - cur) <= 0.5) continue;
      // Only where it does not make the line cross more of the others.
      const before = crossingsAround(paths, pi, k);
      setAcross(pts, k, vert, target);
      moved(paths, pi, k);
      if (crossingsAround(paths, pi, k) > before) setAcross(pts, k, vert, cur);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Order and spread segments that share a channel or a card side
// ---------------------------------------------------------------------------

/**
 * Which way a line leaves the far end (in direction `walk` along the
 * segment) of segment k: the sign of its next move across the segment, or
 * 0 if the line ends there (at a card).
 */
function departure(
  pts: readonly Point[],
  k: number,
  walk: number,
  vert: boolean,
): { dir: number; next: number } {
  const forward = (along(vert, pts[k + 1]) - along(vert, pts[k])) * walk > 0;
  if (forward) {
    if (k + 2 >= pts.length) return { dir: 0, next: -1 };
    return {
      dir: Math.sign(across(vert, pts[k + 2]) - across(vert, pts[k + 1])),
      next: k + 1,
    };
  }
  if (k === 0) return { dir: 0, next: -1 };
  return {
    dir: Math.sign(across(vert, pts[k - 1]) - across(vert, pts[k])),
    next: k - 1,
  };
}

/**
 * Order two parallel segments at their far end in direction `walk`:
 * -1 if a must sit at the smaller coordinate, +1 if at the larger, 0 if
 * that end does not decide.
 */
function compareEnd(
  A: readonly Point[],
  ka: number,
  B: readonly Point[],
  kb: number,
  walk: number,
  depth: number,
): number {
  const vert = isVertical(A, ka);
  const endOf = (P: readonly Point[], k: number) =>
    walk > 0
      ? Math.max(along(vert, P[k]), along(vert, P[k + 1]))
      : Math.min(along(vert, P[k]), along(vert, P[k + 1]));
  const diff = (endOf(A, ka) - endOf(B, kb)) * walk;
  if (diff > 0.5) {
    // a runs on past b's end: a must sit on the far side of b's turn.
    const dep = departure(B, kb, walk, vert).dir;
    return dep === 0 ? 0 : dep > 0 ? -1 : 1;
  }
  if (diff < -0.5) {
    const dep = departure(A, ka, walk, vert).dir;
    return dep === 0 ? 0 : dep > 0 ? 1 : -1;
  }
  const da = departure(A, ka, walk, vert);
  const db = departure(B, kb, walk, vert);
  if (da.dir === 0 || db.dir === 0) return 0;
  if (da.dir !== db.dir) return da.dir < db.dir ? -1 : 1;
  // They turn the same way at the same place: follow them round the corner.
  // The line on the outside of the turn there is on the outside here too.
  if (depth >= 8 || da.next < 0 || db.next < 0) return 0;
  const r = compareEnd(A, da.next, B, db.next, da.dir, depth + 1);
  return r === 0 ? 0 : ((-r * walk * da.dir) as number);
}

export function nudgePass(
  paths: NudgePath[],
  vert: boolean,
  ctx: NudgeContext,
): void {
  const segs = collectSegments(paths, vert, ctx);
  const n = segs.length;
  if (n < 2) return;

  // Core relations: segments that share a line (parallel, overlapping, within
  // NEAR) and end segments on the same card side. Their order comes from
  // where the lines go; everything else keeps the order it has.
  const rels: Rel[] = [];
  const related = new Set<number>();
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra < rb ? rb : ra] = ra < rb ? ra : rb;
  };
  const relate = (i: number, j: number, byWhereTheyGo: boolean) => {
    const pairKey = i < j ? i * n + j : j * n + i;
    if (related.has(pairKey)) return;
    related.add(pairKey);
    const a = segs[i];
    const b = segs[j];
    const side = sameSide(a, b);
    let order: -1 | 1 = a.c < b.c || (a.c === b.c && i < j) ? -1 : 1;
    if (byWhereTheyGo) {
      const A = paths[a.p].pts;
      const B = paths[b.p].pts;
      let r = compareEnd(A, a.k, B, b.k, 1, 0);
      if (r === 0) r = compareEnd(A, a.k, B, b.k, -1, 0);
      // Neither end decides: keep apart lines where they are; twins follow the left rule.
      if (r === 0)
        r =
          Math.abs(a.c - b.c) > NEAR
            ? a.c < b.c
              ? -1
              : 1
            : leftRule(paths, a, b, vert);
      order = r < 0 ? -1 : 1;
    }
    const pa = paths[a.p];
    const pb = paths[b.p];
    const twins =
      (pa.src === pb.src && pa.tgt === pb.tgt) ||
      (pa.src === pb.tgt && pa.tgt === pb.src);
    const sep = twins ? TWIN_SEP : side ? ANCHOR_SEP : LINE_SEP;
    // An order the bounds can't hold (the crossing is unavoidable either way):
    // take the one that fits, so the group isn't squeezed flat.
    const [first, second] = order < 0 ? [a, b] : [b, a];
    if (first.lb + sep / 2 > second.ub && second.lb + sep / 2 <= first.ub)
      order = order < 0 ? 1 : -1;
    rels.push({ a: i, b: j, sep, order });
    union(i, j);
  };
  const byC = segs
    .map((_, i) => i)
    .sort((a, b) => segs[a].c - segs[b].c || a - b);
  for (let x = 0; x < n; x++) {
    const a = segs[byC[x]];
    for (let y = x + 1; y < n; y++) {
      const b = segs[byC[y]];
      if (b.c - a.c > NEAR) break;
      if (a.p !== b.p && overlaps(a, b)) relate(byC[x], byC[y], true);
    }
  }
  const sideGroups = new Map<string, number[]>();
  segs.forEach((sg, i) => {
    for (const key of [sg.keyA, sg.keyB]) {
      if (!key) continue;
      const list = sideGroups.get(key);
      if (list) list.push(i);
      else sideGroups.set(key, [i]);
    }
  });
  for (const list of sideGroups.values()) {
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++)
        if (segs[list[x]].p !== segs[list[y]].p) relate(list[x], list[y], true);
    }
  }

  // Solve every group on its own; where two groups' answers now collide (they
  // overlap and came within LINE_SEP, or swapped), join them and solve again.
  const pos = new Float64Array(n);
  for (let i = 0; i < n; i++)
    pos[i] = Math.min(Math.max(segs[i].c, segs[i].lb), segs[i].ub);
  /** Each group's members (ascending) and relations (in the order made), for the given roots. */
  const groupsOf = (roots: ReadonlySet<number>) => {
    const members = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!roots.has(r)) continue;
      const list = members.get(r);
      if (list) list.push(i);
      else members.set(r, [i]);
    }
    const groupRels = new Map<number, Rel[]>();
    for (const rel of rels) {
      const r = find(rel.a);
      if (!roots.has(r)) continue;
      const list = groupRels.get(r);
      if (list) list.push(rel);
      else groupRels.set(r, [rel]);
    }
    return { members, groupRels };
  };
  const solveGroup = (members: number[], groupRels: Rel[]) => {
    if (members.length < 2) return;
    let order = topoOrder(members, groupRels, segs, paths);
    const rank = new Map<number, number>();
    const orient = () => {
      rank.clear();
      order.forEach((m, i) => rank.set(m, i));
      return groupRels.map((rel) => {
        // Orient every constraint by the final order (a cycle means an unavoidable crossing).
        const aFirst = rank.get(rel.a)! < rank.get(rel.b)!;
        const u = aFirst ? rel.a : rel.b;
        const v = aFirst ? rel.b : rel.a;
        // A pair with less room than its separation gets what room it has, so a
        // tight spot doesn't squeeze the rest of the group with it.
        // A constraint the final order turned round closes a cycle: the two lines
        // cross whatever the order, and squeezing the whole group to honour it
        // drew twins on top of each other (three links between two cards).
        const broken = rel.order < 0 !== aFirst;
        return {
          u,
          v,
          sep: Math.max(0, Math.min(rel.sep, segs[v].ub - segs[u].lb)),
          broken,
        };
      });
    };
    let cons = orient();
    // An order the bounds can't hold even with no gaps at all (each pair fits,
    // the chain doesn't: three links between two cards, the third stepping
    // across the other two) would squeeze the whole group onto one line.
    // Keep the order the segments already have instead: the crossing happens
    // either way, and the lines stay apart.
    if (!fitsAt(order, cons, segs, 0)) {
      order = [...members].sort(
        (a, b) =>
          segs[a].c - segs[b].c ||
          paths[segs[a].p].rank - paths[segs[b].p].rank ||
          segs[a].k - segs[b].k,
      );
      cons = orient();
    }
    solve(order, cons, segs, pos);
  };
  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  {
    const { members, groupRels } = groupsOf(roots);
    for (const r of roots) solveGroup(members.get(r) ?? [], groupRels.get(r) ?? []);
  }

  for (let round = 0; round < 8; round++) {
    const touched = new Set<number>();
    const byPos = segs
      .map((_, i) => i)
      .sort((a, b) => pos[a] - pos[b] || a - b);
    for (let x = 0; x < n; x++) {
      const i = byPos[x];
      for (let y = x + 1; y < n; y++) {
        const j = byPos[y];
        if (pos[j] - pos[i] >= LINE_SEP - 0.01) break;
        if (
          find(i) === find(j) ||
          segs[i].p === segs[j].p ||
          !overlaps(segs[i], segs[j])
        )
          continue;
        relate(i, j, Math.abs(segs[i].c - segs[j].c) <= NEAR);
        touched.add(find(i));
      }
    }
    // Pairs that swapped sides (a group pushed one past the other). Only
    // pairs that started within RELATE_WINDOW of each other count, so a sweep
    // over the segments sorted by where they started finds them all; they
    // are then related in index order, as a scan of every pair would.
    const swapped: number[] = [];
    for (let x = 0; x < n; x++) {
      const a = byC[x];
      for (let y = x + 1; y < n; y++) {
        const b = byC[y];
        if (segs[b].c - segs[a].c > RELATE_WINDOW) break;
        const i = a < b ? a : b;
        const j = a < b ? b : a;
        if (find(i) === find(j) || segs[i].p === segs[j].p) continue;
        const was = segs[i].c - segs[j].c;
        const now = pos[i] - pos[j];
        if (was * now >= 0 || !overlaps(segs[i], segs[j])) continue;
        swapped.push(i, j);
      }
    }
    const pairOrder = Array.from({ length: swapped.length / 2 }, (_, q) => q).sort(
      (p, q) => swapped[2 * p] - swapped[2 * q] || swapped[2 * p + 1] - swapped[2 * q + 1],
    );
    for (const q of pairOrder) {
      const i = swapped[2 * q];
      const j = swapped[2 * q + 1];
      if (find(i) === find(j)) continue;
      relate(i, j, false);
      touched.add(find(i));
    }
    if (!touched.size) break;
    const solveRoots = new Set<number>();
    for (const r of touched) solveRoots.add(find(r));
    const { members, groupRels } = groupsOf(solveRoots);
    for (const root of solveRoots) solveGroup(members.get(root) ?? [], groupRels.get(root) ?? []);
  }

  for (let i = 0; i < n; i++) {
    const sg = segs[i];
    if (Math.abs(pos[i] - across(vert, paths[sg.p].pts[sg.k])) > 1e-6) {
      setAcross(paths[sg.p].pts, sg.k, vert, pos[i]);
      moved(paths, sg.p, sg.k);
    }
  }
}

function overlaps(a: Seg, b: Seg): boolean {
  return Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) >= -1;
}

function sameSide(a: Seg, b: Seg): boolean {
  return (
    (a.keyA !== "" && (a.keyA === b.keyA || a.keyA === b.keyB)) ||
    (a.keyB !== "" && (a.keyB === b.keyA || a.keyB === b.keyB))
  );
}

/** Every segment of one orientation, with how far it may move. */
function collectSegments(
  paths: NudgePath[],
  vert: boolean,
  ctx: NudgeContext,
): Seg[] {
  const segs: Seg[] = [];
  const keyOf = (r: Rect, side: Side) => `${r.id}\u0000${side}`;
  for (let p = 0; p < paths.length; p++) {
    const path = paths[p];
    const pts = path.pts;
    const last = pts.length - 2;
    for (let k = 0; k <= last; k++) {
      if (isVertical(pts, k) !== vert) continue;
      const c = across(vert, pts[k]);
      const lo = Math.min(along(vert, pts[k]), along(vert, pts[k + 1]));
      const hi = Math.max(along(vert, pts[k]), along(vert, pts[k + 1]));
      if (hi - lo < EPS) continue;
      let [lb, ub] = sweepBounds(ctx, path, vert, c, lo, hi, CLEAR, MAX_SHIFT);
      let keyA = "";
      let keyB = "";
      if (k === 0) {
        const [r0, r1] = anchorRange(path.src, path.srcSide);
        lb = Math.max(lb, Math.min(r0, c));
        ub = Math.min(ub, Math.max(r1, c));
        keyA = keyOf(path.src, path.srcSide);
      }
      if (k === last) {
        const [r0, r1] = anchorRange(path.tgt, path.tgtSide);
        lb = Math.max(lb, Math.min(r0, c));
        ub = Math.min(ub, Math.max(r1, c));
        keyB = keyOf(path.tgt, path.tgtSide);
      }
      // Keep the straight leg out of each port at least MIN_LEG long.
      if (k === 1) {
        const line = across(vert, pts[0]);
        if (outDir(path.srcSide) > 0)
          lb = Math.max(lb, Math.min(c, line + MIN_LEG));
        else ub = Math.min(ub, Math.max(c, line - MIN_LEG));
      }
      if (k === last - 1) {
        const line = across(vert, pts[last + 1]);
        if (outDir(path.tgtSide) > 0)
          lb = Math.max(lb, Math.min(c, line + MIN_LEG));
        else ub = Math.min(ub, Math.max(c, line - MIN_LEG));
      }
      // Never past half-way to this line's own next parallel segment either way,
      // and never closer to it than MIN_RUN (or than it already is): the run
      // between them keeps its direction and some length, so the line can't
      // fold onto itself.
      for (const other of [k - 2, k + 2]) {
        if (other < 0 || other > last) continue;
        const oc = across(vert, pts[other]);
        const gap = Math.abs(oc - c);
        const room = Math.max(0, (gap - Math.min(gap, MIN_RUN)) / 2);
        if (oc < c) lb = Math.max(lb, c - room);
        else if (oc > c) ub = Math.min(ub, c + room);
      }
      segs.push({
        p,
        k,
        c,
        lo,
        hi,
        keyA,
        keyB,
        lb,
        ub,
        w: keyA || keyB ? 3 : 1,
      });
    }
  }
  return segs;
}

/**
 * Two lines on the same stretch that no end tells apart (twins between the
 * same two cards): the one with the lower rank keeps to the left of its own
 * direction of travel, the same rule on every stretch they share, so they
 * never swap over.
 */
function leftRule(paths: NudgePath[], a: Seg, b: Seg, vert: boolean): number {
  const first = paths[a.p].rank <= paths[b.p].rank ? a : b;
  const P = paths[first.p].pts;
  const t =
    Math.sign(along(vert, P[first.k + 1]) - along(vert, P[first.k])) || 1;
  // Facing +y the left hand points +x; facing +x it points -y.
  const leftSign = vert ? t : -t;
  const firstSmaller = leftSign < 0;
  const aSmaller = first === a ? firstSmaller : !firstSmaller;
  return aSmaller ? -1 : 1;
}

function topoOrder(
  members: number[],
  rels: Rel[],
  segs: Seg[],
  paths: NudgePath[],
): number[] {
  const n = members.length;
  const idx = new Map<number, number>();
  members.forEach((m, i) => idx.set(m, i));
  const indeg = new Int32Array(n);
  const succ: number[][] = Array.from({ length: n }, () => []);
  for (const rel of rels) {
    const u = idx.get(rel.order < 0 ? rel.a : rel.b)!;
    const v = idx.get(rel.order < 0 ? rel.b : rel.a)!;
    succ[u].push(v);
    indeg[v]++;
  }
  const less = (i: number, j: number) => {
    const a = segs[members[i]];
    const b = segs[members[j]];
    if (a.c !== b.c) return a.c < b.c;
    const ra = paths[a.p].rank;
    const rb = paths[b.p].rank;
    if (ra !== rb) return ra < rb;
    return a.k < b.k;
  };
  const done = new Uint8Array(n);
  const out: number[] = [];
  for (let step = 0; step < n; step++) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      if (done[i] || indeg[i] !== 0) continue;
      if (best < 0 || less(i, best)) best = i;
    }
    if (best < 0) {
      // A cycle (lines that must cross): break it at the least constrained member.
      for (let i = 0; i < n; i++) {
        if (done[i]) continue;
        if (
          best < 0 ||
          indeg[i] < indeg[best] ||
          (indeg[i] === indeg[best] && less(i, best))
        )
          best = i;
      }
    }
    done[best] = 1;
    out.push(members[best]);
    for (const v of succ[best]) indeg[v]--;
  }
  return out;
}

/**
 * Spread a group: each segment as close to where it is as the separations
 * allow (weighted, so anchors move less), inside its bounds. Iterative
 * projection; groups are small.
 */
function solve(
  order: number[],
  cons: { u: number; v: number; sep: number; broken: boolean }[],
  segs: Seg[],
  pos: Float64Array,
): void {
  // If the bounds leave too little room for every separation (a narrow
  // channel), shrink them all by the same factor: the lines keep their order
  // and share what room there is. Constraints that close a cycle don't count
  // towards the shrink (they get what room is left).
  const scale = fitScale(
    order,
    cons.filter((c) => !c.broken),
    segs,
  );
  for (const m of order)
    pos[m] = Math.min(Math.max(segs[m].c, segs[m].lb), segs[m].ub);
  for (let iter = 0; iter < 100; iter++) {
    let worst = 0;
    for (const { u, v, sep: fullSep } of cons) {
      const sep = fullSep * scale;
      const pu = pos[u];
      const pv = pos[v];
      const gap = sep - (pv - pu);
      if (gap <= 1e-3) continue;
      if (gap > worst) worst = gap;
      const su = segs[u];
      const sv = segs[v];
      let mu = (gap * sv.w) / (su.w + sv.w);
      let mv = gap - mu;
      const roomU = pu - su.lb;
      const roomV = sv.ub - pv;
      if (mu > roomU) {
        mv += mu - roomU;
        mu = roomU;
      }
      if (mv > roomV) {
        mu = Math.min(roomU, mu + (mv - roomV));
        mv = roomV;
      }
      pos[u] = pu - Math.max(0, mu);
      pos[v] = pv + Math.max(0, mv);
    }
    if (worst < 0.05) break;
  }
}

/** The largest factor (≤ 1) by which every separation can be met inside the bounds, in this order. */
/** Can every separation, scaled by `f`, be met inside the bounds in this order? */
function fitsAt(
  order: number[],
  cons: { u: number; v: number; sep: number }[],
  segs: Seg[],
  f: number,
): boolean {
  const into = new Map<number, { u: number; sep: number }[]>();
  for (const c of cons) {
    const list = into.get(c.v);
    if (list) list.push({ u: c.u, sep: c.sep });
    else into.set(c.v, [{ u: c.u, sep: c.sep }]);
  }
  const lowest = new Map<number, number>();
  for (const m of order) {
    let x = segs[m].lb;
    for (const { u, sep } of into.get(m) ?? []) {
      const xu = lowest.get(u);
      if (xu !== undefined) x = Math.max(x, xu + sep * f);
    }
    if (x > segs[m].ub + 1e-6) return false;
    lowest.set(m, x);
  }
  return true;
}

function fitScale(
  order: number[],
  cons: { u: number; v: number; sep: number }[],
  segs: Seg[],
): number {
  const fits = (f: number) => fitsAt(order, cons, segs, f);
  if (fits(1)) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
