/**
 * Edge routing — turn routed polylines into SVG paths.
 *
 * Owns the corner style (rounded / curved / sharp) and the crossing
 * treatment (hops / halo). Crossings need every line at once, so this
 * takes the whole map.
 *
 * Who goes over at a crossing: **the more horizontal segment** (the later
 * line id on a tie), as on a circuit schematic. One fixed rule reads at a
 * glance — every bridge is a bump on a horizontal run, every vertical run
 * passes under — where "whichever line is later" scatters bumps in both
 * directions with no visible logic. Horizontal runs are also the long,
 * calm stretches between cards, so a bump there disturbs the least. When the
 * over line has no room at that spot (a corner or its end is too close), the
 * other line takes the treatment; when neither has room, the crossing is
 * drawn plain.
 *
 *   hops   the over line jumps the under one with a semicircle of
 *          HOP_RADIUS, drawn as two cubics (EdgeFlow's `measurePath` reads
 *          M L H V Q C only, so no `A`). Crossings closer than
 *          2 × HOP_RADIUS + MERGE_SLACK merge into one flat-topped bridge.
 *   halo   `halo: true`: FkEdge draws a canvas-coloured casing under every
 *          line. Left to paint order, the casing would let whichever line
 *          React Flow draws LATER win each crossing, a different rule from
 *          hops and a random-looking one. So the under line is also cut
 *          (`strokeD`, HALO_CUT_HALF either side) and FkEdge draws both its
 *          casing and its stroke from that: an under line has no casing at
 *          the crossing, so it can never paint over the line above it. `d`
 *          stays ONE continuous subpath (EdgeFlow and the hit area need one).
 *
 * Paths use absolute M / L / Q / C only, one subpath (`strokeD` aside), and
 * numbers rounded to 0.01 px.
 */

import type { CornerMode, CrossingMode, Point, Rect, RoutedLine } from '../types';
import { findCrossings, type Crossing, type CrossingEnd } from './crossings';
import { findCurveCrossings, type CurveCrossing } from './curveCrossings';
import { cornerCurve, cornerRadii, KAPPA, ROUNDED_RADIUS, type CornerRadii } from './corners';

export interface RenderOptions {
  crossings: CrossingMode;
  corners: CornerMode;
  /**
   * The cards (optional). With them, a curved corner that would cut into a
   * card is tightened until it clears.
   */
  obstacles?: readonly Rect[];
  /**
   * The canvas zoom (default 1). Hops are sized in screen px, so they stay
   * readable as bridges when the diagram is zoomed out (see `hopRadiusFor`).
   */
  zoom?: number;
}

export interface RenderedPath {
  /** One continuous subpath: draw the halo and the hit area with it; EdgeFlow follows it. */
  d: string;
  mid: Point;
  halo?: boolean;
  /**
   * crossings = 'halo', on a line that passes under another: `d`
   * with the breaks cut out (several `M` subpaths). Draw the visible stroke
   * (and the halo casing) with this when present; keep `d` for EdgeFlow and
   * the hit area.
   */
  strokeD?: string;
}

/** Radius (px) of a hop's semicircle at zoom 1. */
export const HOP_RADIUS = 6;
/** A hop is at least this many screen px across (radius), however far the canvas is zoomed out... */
const HOP_SCREEN_RADIUS = 6;
/** ...up to this radius in flow px, so a far-out zoom does not turn bridges into humps. */
const HOP_MAX_RADIUS = 14;

/** Hop radius in flow px for a canvas zoom: HOP_SCREEN_RADIUS on screen, between HOP_RADIUS and HOP_MAX_RADIUS. */
export function hopRadiusFor(zoom: number | undefined): number {
  const z = zoom && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  return Math.min(HOP_MAX_RADIUS, Math.max(HOP_RADIUS, HOP_SCREEN_RADIUS / z));
}
/** Half the cut (px) in an under line in halo mode: the casing's half width (3.5) plus a hair. */
export const HALO_CUT_HALF = 4.5;
/** A hop or cut keeps this far (px) from where a corner's curve starts. */
const CORNER_CLEAR = 3;
/** ...and this far from the line's own ends (the card stubs, by the `*` / `1`). */
const STUB_CLEAR = 4;
/** Two treatments closer than this (px) between their edges merge into one. */
const MERGE_SLACK = 4;
/**
 * The midpoint keeps this far (px, along the line) from a crossing: the
 * labels there (role name, swap button) are wide and short, so further on a
 * horizontal run than on a vertical one...
 */
const MID_CROSSING_CLEAR_H = 36;
const MID_CROSSING_CLEAR_V = 16;
/** ...and this far from the line's ends. */
const MID_END_CLEAR = 16;

/** Drop repeated points and points in the middle of a straight run. */
export function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      // Collinear and still heading the same way: extend the run.
      const dot = (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y);
      if (Math.abs(cross) < 0.01 && dot >= 0) {
        out[out.length - 1] = p;
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

/** A polyline with each corner rounded by up to `radius`, no crossings treatment. */
export function roundedPath(points: readonly Point[], radius = ROUNDED_RADIUS): string {
  return renderOne(simplify(points), radius === 0 ? 'sharp' : 'rounded', undefined, null, null, []).d;
}

/** The point halfway along a polyline, by length. */
export function polylineMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  let remaining = total / 2;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len >= remaining && len > 0) {
      const t = remaining / len;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= len;
  }
  return points[points.length - 1];
}

// ---------------------------------------------------------------------------

/** 'cut' is the halo's break: a gap in the under line sized to the casing. */
type Treatment = 'hop' | 'cut';

const halfOf = (t: Treatment, hopR = HOP_RADIUS) => (t === 'hop' ? hopR : HALO_CUT_HALF);

/** Per line, per segment: crossing positions (distance along the segment) that get a treatment. */
type SegEvents = (number[] | undefined)[];

/** The stretch of segment `seg` that is drawn straight, minus clearances: where a treatment may sit. */
function freeSpan(radii: CornerRadii, seg: number): [number, number] {
  const last = radii.segLen.length - 1;
  const lo = radii.rOut[seg] + (seg === 0 ? STUB_CLEAR : CORNER_CLEAR);
  const hi = radii.segLen[seg] - radii.rIn[seg + 1] - (seg === last ? STUB_CLEAR : CORNER_CLEAR);
  return [lo, hi];
}

/** How horizontal a segment is: |dx| / length (1 = horizontal, 0 = vertical). */
function horizontalness(pts: readonly Point[], seg: number): number {
  const a = pts[seg];
  const b = pts[seg + 1];
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  return len > 0 ? Math.abs(b.x - a.x) / len : 0;
}

function assignTreatments(
  crossings: readonly Crossing[],
  polys: readonly Point[][],
  radii: readonly CornerRadii[],
  ids: readonly string[],
  treatment: Treatment,
  curveCrossings: readonly CurveCrossing[],
  hopR: number,
): SegEvents[] {
  const half = halfOf(treatment, hopR);
  const events: SegEvents[] = polys.map(() => []);
  // How far either side of the crossing the other line must run straight.
  const other = treatment === 'hop' ? hopR : 2;
  const fits = (end: CrossingEnd, reach: number) => {
    const [lo, hi] = freeSpan(radii[end.line], end.seg);
    return end.d - reach >= lo && end.d + reach <= hi;
  };
  const add = (end: CrossingEnd) => {
    const list = events[end.line][end.seg];
    if (list) list.push(end.d);
    else events[end.line][end.seg] = [end.d];
  };
  for (const c of crossings) {
    const ha = horizontalness(polys[c.a.line], c.a.seg);
    const hb = horizontalness(polys[c.b.line], c.b.seg);
    const aOver = Math.abs(ha - hb) > 1e-3 ? ha > hb : ids[c.a.line] > ids[c.b.line];
    const over = aOver ? c.a : c.b;
    const under = aOver ? c.b : c.a;
    // Hops go on the over line, cuts on the under line; the other line if that one has no room.
    // The line crossing under a hop must itself run straight there, or the
    // bridge and its corner tangle into a knot; a cut needs the line over it
    // to be straight across the cut's width.
    const [first, second] = treatment === 'hop' ? [over, under] : [under, over];
    if (fits(first, half) && fits(second, other)) add(first);
    else if (fits(second, half) && fits(first, other)) add(second);
  }
  // A corner curve across a straight stretch: the curve goes over and the
  // straight line breaks where the drawn curve really crosses it. Hops stay
  // plain here: a bridge over a turning line reads as a knot.
  if (treatment !== 'hop') {
    for (const c of curveCrossings) if (fits(c.straight, half)) add(c.straight);
  }
  return events;
}

/** Sorted crossing positions → merged [lo, hi] intervals along the segment. */
function mergeEvents(list: number[], half: number): [number, number][] {
  list.sort((p, q) => p - q);
  const out: [number, number][] = [];
  for (const c of list) {
    const prev = out[out.length - 1];
    if (prev && c - half - prev[1] < MERGE_SLACK) prev[1] = Math.max(prev[1], c + half);
    else out.push([c - half, c + half]);
  }
  return out;
}

const f = (v: number) => String(Math.round(v * 100) / 100);
const pt = (p: Point) => `${f(p.x)},${f(p.y)}`;
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Which way a hop bulges: up for anything not vertical, right for a vertical. */
function hopNormal(ux: number, uy: number): Point {
  let nx = uy;
  let ny = -ux;
  if (Math.abs(ny) > 0.05) {
    if (ny > 0) {
      nx = -nx;
      ny = -ny;
    }
  } else if (nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  return { x: nx, y: ny };
}

/** One drawn piece of a path, by length along the drawn path. */
type Piece =
  | { pos0: number; pos1: number; kind: 'L'; a: Point; b: Point }
  | { pos0: number; pos1: number; kind: 'Q'; a: Point; c: Point; b: Point }
  | { pos0: number; pos1: number; kind: 'C'; a: Point; c1: Point; c2: Point; b: Point };

interface Rendered {
  d: string;
  strokeD?: string;
  pieces: Piece[];
  /**
   * Per segment, [distance along the segment, path length there] at the
   * start of each straight stretch, so a crossing's place on the segment
   * maps exactly to a length along the drawn path (hops are longer than the
   * stretch they replace).
   */
  knots: [number, number][][];
  /** Per vertex with a corner: [path length where its curve starts, where it ends]. */
  cornerPos: [number, number][];
  length: number;
}

/** The point at path length `p` (clamped to the path). */
function pointAtLength(r: Rendered, p: number): Point {
  const { pieces } = r;
  let lo = 0;
  let hi = pieces.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (pieces[m].pos1 < p) lo = m + 1;
    else hi = m;
  }
  const q = pieces[lo];
  const span = q.pos1 - q.pos0;
  const t = span > 0 ? Math.min(1, Math.max(0, (p - q.pos0) / span)) : 0;
  const u = 1 - t;
  switch (q.kind) {
    case 'L':
      return { x: q.a.x + (q.b.x - q.a.x) * t, y: q.a.y + (q.b.y - q.a.y) * t };
    case 'Q':
      return {
        x: u * u * q.a.x + 2 * u * t * q.c.x + t * t * q.b.x,
        y: u * u * q.a.y + 2 * u * t * q.c.y + t * t * q.b.y,
      };
    case 'C':
      return {
        x: u * u * u * q.a.x + 3 * u * u * t * q.c1.x + 3 * u * t * t * q.c2.x + t * t * t * q.b.x,
        y: u * u * u * q.a.y + 3 * u * u * t * q.c1.y + 3 * u * t * t * q.c2.y + t * t * t * q.b.y,
      };
  }
}

/** Path length at distance `d` along segment `seg` (exact on its straight stretches). */
function lengthAt(r: Rendered, seg: number, d: number): number {
  const knots = r.knots[seg];
  if (!knots || !knots.length) return 0;
  let k = knots[0];
  for (const knot of knots) {
    if (knot[0] > d) break;
    k = knot;
  }
  return k[1] + Math.max(0, d - k[0]);
}

function renderOne(
  pts: readonly Point[],
  corners: CornerMode,
  obstacles: readonly Rect[] | undefined,
  radiiIn: CornerRadii | null,
  treatment: Treatment | null,
  segEvents: SegEvents,
  hopR = HOP_RADIUS,
): Rendered {
  const n = pts.length;
  if (n === 0) return { d: '', pieces: [], knots: [], cornerPos: [], length: 0 };
  const radii = radiiIn ?? cornerRadii(pts, corners, obstacles);
  let d = `M ${pt(pts[0])}`;
  let sd: string | null = null; // the gapped stroke, built only once a gap appears
  const pieces: Piece[] = [];
  const knots: [number, number][][] = [];
  const cornerPos: [number, number][] = [];
  let pos = 0;
  let last: Point = pts[0];
  const half = treatment ? halfOf(treatment, hopR) : 0;

  const emit = (cmd: string) => {
    d += cmd;
    if (sd !== null) sd += cmd;
  };

  for (let s = 0; s + 1 < n; s++) {
    const a = pts[s];
    const b = pts[s + 1];
    const len = radii.segLen[s];
    if (len <= 0) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const at = (t: number): Point => ({ x: a.x + ux * t, y: a.y + uy * t });

    // The corner into this segment, at vertex s.
    if (s > 0) {
      const rIn = radii.rIn[s];
      const rOut = radii.rOut[s];
      if (rIn > 0 || rOut > 0) {
        const prev = pts[s - 1];
        const cc = cornerCurve(prev, a, b, rIn, rOut);
        const pos0 = pos;
        if (corners === 'rounded') {
          emit(` Q ${pt(a)} ${pt(cc.b)}`);
          pos += (dist(cc.a, cc.b) + dist(cc.a, a) + dist(a, cc.b)) / 2;
          pieces.push({ pos0, pos1: pos, kind: 'Q', a: last, c: a, b: cc.b });
        } else {
          emit(` C ${pt(cc.c1)} ${pt(cc.c2)} ${pt(cc.b)}`);
          pos += (dist(cc.a, cc.b) + dist(cc.a, cc.c1) + dist(cc.c1, cc.c2) + dist(cc.c2, cc.b)) / 2;
          pieces.push({ pos0, pos1: pos, kind: 'C', a: last, c1: cc.c1, c2: cc.c2, b: cc.b });
        }
        last = cc.b;
        cornerPos[s] = [pos0, pos];
      }
    }

    const s0 = radii.rOut[s];
    const s1 = len - radii.rIn[s + 1];
    let cursor = s0;
    const segKnots: [number, number][] = [[cursor, pos]];
    knots[s] = segKnots;
    const straightTo = (t: number) => {
      if (t <= cursor + 1e-6) return;
      const to = at(t);
      emit(` L ${pt(to)}`);
      pieces.push({ pos0: pos, pos1: pos + (t - cursor), kind: 'L', a: last, b: to });
      pos += t - cursor;
      cursor = t;
      last = to;
    };

    const list = treatment ? segEvents[s] : undefined;
    if (list && list.length) {
      for (const [lo, hi] of mergeEvents(list, half)) {
        straightTo(lo);
        const A = at(lo);
        const B = at(hi);
        if (treatment === 'cut') {
          if (sd === null) sd = d; // everything so far, unbroken
          d += ` L ${pt(B)}`;
          sd += ` M ${pt(B)}`;
          pieces.push({ pos0: pos, pos1: pos + (hi - lo), kind: 'L', a: A, b: B });
          pos += hi - lo;
        } else {
          const nrm = hopNormal(ux, uy);
          const r = hopR;
          const k = KAPPA * r;
          const up = (p: Point, along: number, out: number): Point => ({
            x: p.x + ux * along + nrm.x * out,
            y: p.y + uy * along + nrm.y * out,
          });
          const quarter = (Math.PI * r) / 2;
          const arc = (p0: Point, c1: Point, c2: Point, p1: Point) => {
            emit(` C ${pt(c1)} ${pt(c2)} ${pt(p1)}`);
            pieces.push({ pos0: pos, pos1: pos + quarter, kind: 'C', a: p0, c1, c2, b: p1 });
            pos += quarter;
          };
          if (hi - lo <= 2 * r + 0.01) {
            const T = up(A, r, r);
            arc(A, up(A, 0, k), up(T, -k, 0), T);
            arc(T, up(T, k, 0), up(B, 0, k), B);
          } else {
            const TL = up(A, r, r);
            const TR = up(B, -r, r);
            arc(A, up(A, 0, k), up(TL, -k, 0), TL);
            emit(` L ${pt(TR)}`);
            pieces.push({ pos0: pos, pos1: pos + (hi - lo - 2 * r), kind: 'L', a: TL, b: TR });
            pos += hi - lo - 2 * r;
            arc(TR, up(TR, k, 0), up(B, 0, k), B);
          }
        }
        cursor = hi;
        last = B;
        segKnots.push([cursor, pos]);
      }
    }
    straightTo(s1);
  }

  const out: Rendered = { d, pieces, knots, cornerPos, length: pos };
  if (sd !== null) out.strokeD = sd;
  return out;
}

/**
 * The label point: half way along the drawn path, moved only as far as it
 * must be to clear a crossing (to the nearer edge of the keep-out). Half way
 * may sit on a corner: a point that moves continuously as the cards move
 * beats one that is always on a straight stretch but jumps between two
 * stretches when a card is nudged a pixel (a Z-route's middle step is often
 * all corner, with the two long runs either side equally near).
 */
function pickMid(r: Rendered, keepOut: [number, number][]): Point {
  const target = r.length / 2;
  const end = Math.min(MID_END_CLEAR, r.length / 2);
  keepOut.push([-Infinity, end], [r.length - end, Infinity]);
  keepOut.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  // Merge overlapping keep-outs, then find the one holding the target.
  let p = target;
  let lo = -Infinity;
  let hi = -Infinity;
  for (const [klo, khi] of keepOut) {
    if (klo > hi) {
      if (lo < target && target < hi) break;
      lo = klo;
      hi = khi;
    } else hi = Math.max(hi, khi);
  }
  if (lo < target && target < hi) {
    const loOk = lo >= end;
    const hiOk = hi <= r.length - end;
    if (loOk && (!hiOk || target - lo <= hi - target)) p = lo;
    else if (hiOk) p = hi;
  }
  return pointAtLength(r, p);
}

/**
 * Hops mode: a crossing that lands on a corner's curve gets no bridge (a
 * bridge over a turning line reads as a knot), and with curved corners that
 * is most crossings. So the crossing wins: every corner that reaches into a
 * crossing (on either line) is tightened until the crossing, plus a hop's
 * width and the usual clearance, sits on straight line. Then, for a curve
 * that still cuts across another line where the polylines do not cross, the
 * corner is tightened until it no longer does (at worst to the rounded
 * radius, where the curve stays tucked into its corner). The polylines do not
 * move, so neither do the crossings: one pass is enough. Mutates `radii`.
 */
function bridgesWinOverCorners(
  polys: readonly Point[][],
  radii: CornerRadii[],
  corners: CornerMode,
  hopR: number,
): { crossings: Crossing[]; curveCrossings: CurveCrossing[] } {
  const need = hopR + CORNER_CLEAR;
  // A corner whose one leg was shortened keeps a sensible shape: the other
  // leg is at most this many times as long.
  const RATIO = 2;
  const tighten = (line: number, seg: number, d: number) => {
    const r = radii[line];
    const len = r.segLen[seg];
    // Too close to either end of its segment for any bridge: leave the curve.
    if (d < need || len - d < need) return;
    const out = Math.max(0, d - need); // the corner at the segment's start (vertex seg)
    const into = Math.max(0, len - d - need); // the corner at its end (vertex seg + 1)
    if (seg > 0 && r.rOut[seg] > out) {
      r.rOut[seg] = out;
      r.rIn[seg] = Math.min(r.rIn[seg], Math.max(out, ROUNDED_RADIUS) * RATIO);
    }
    if (seg + 1 < polys[line].length - 1 && r.rIn[seg + 1] > into) {
      r.rIn[seg + 1] = into;
      r.rOut[seg + 1] = Math.min(r.rOut[seg + 1], Math.max(into, ROUNDED_RADIUS) * RATIO);
    }
  };
  const crossings = findCrossings(polys);
  for (const c of crossings) {
    tighten(c.a.line, c.a.seg, c.a.d);
    tighten(c.b.line, c.b.seg, c.b.d);
  }
  // Rounded corners are 8 px: there is nothing left to tighten.
  if (corners !== 'curved') return { crossings, curveCrossings: findCurveCrossings(polys, radii, corners) };
  for (let round = 0; ; round++) {
    const left = findCurveCrossings(polys, radii, corners);
    if (!left.length || round === 3) return { crossings, curveCrossings: left };
    let changed = false;
    for (const c of left) {
      const r = radii[c.curve.line];
      const v = c.curve.vertex;
      const big = Math.max(r.rIn[v], r.rOut[v]);
      if (big <= ROUNDED_RADIUS + 0.01) continue;
      r.rIn[v] = Math.max(Math.min(r.rIn[v], ROUNDED_RADIUS), r.rIn[v] * 0.6);
      r.rOut[v] = Math.max(Math.min(r.rOut[v], ROUNDED_RADIUS), r.rOut[v] * 0.6);
      changed = true;
    }
    if (!changed) return { crossings, curveCrossings: left };
  }
}

const finitePoint = (p: Point) => Number.isFinite(p.x) && Number.isFinite(p.y);

export function renderPaths(lines: Map<string, RoutedLine>, opts: RenderOptions): Map<string, RenderedPath> {
  // A line with a non-finite point is left out, so it keeps today's fallback
  // path instead of drawing nothing (an SVG path with NaN in it is dropped).
  const ids = [...lines.keys()].filter((id) => lines.get(id)!.points.every(finitePoint));
  const polys = ids.map((id) => simplify(lines.get(id)!.points));
  const radii = polys.map((p) => cornerRadii(p, opts.corners, opts.obstacles));
  const hopR = hopRadiusFor(opts.zoom);
  const found =
    opts.crossings === 'hops' && opts.corners !== 'sharp' && polys.length > 1
      ? bridgesWinOverCorners(polys, radii, opts.corners, hopR)
      : null;
  // Polyline crossings are where the drawn lines cross only when both are
  // drawn straight there; a corner moves (or removes) the crossing, so those
  // come from the drawn curves instead.
  const straightAt = (e: CrossingEnd) => {
    const r = radii[e.line];
    return e.d >= r.rOut[e.seg] && e.d <= r.segLen[e.seg] - r.rIn[e.seg + 1];
  };
  const crossings = polys.length > 1 ? (found?.crossings ?? findCrossings(polys)).filter((c) => straightAt(c.a) && straightAt(c.b)) : [];
  const curveCrossings = polys.length > 1 ? (found?.curveCrossings ?? findCurveCrossings(polys, radii, opts.corners)) : [];

  const treatment: Treatment | null =
    opts.crossings === 'hops' ? 'hop' : opts.crossings === 'halo' ? 'cut' : null;
  const events = treatment
    ? assignTreatments(crossings, polys, radii, ids, treatment, curveCrossings, hopR)
    : polys.map(() => []);

  // Every crossing on a line, to keep its midpoint label off it.
  const onLine: CrossingEnd[][] = polys.map(() => []);
  const onCurve: CurveCrossing['curve'][][] = polys.map(() => []);
  for (const c of crossings) {
    onLine[c.a.line].push(c.a);
    onLine[c.b.line].push(c.b);
  }
  for (const c of curveCrossings) {
    onLine[c.straight.line].push(c.straight);
    onCurve[c.curve.line].push(c.curve);
  }

  const out = new Map<string, RenderedPath>();
  for (let i = 0; i < ids.length; i++) {
    const pts = polys[i];
    if (pts.length < 2) {
      const p = pts[0] ?? { x: 0, y: 0 };
      out.set(ids[i], { d: `M ${pt(p)}`, mid: p, halo: opts.crossings === 'halo' ? true : undefined });
      continue;
    }
    const r = renderOne(pts, opts.corners, opts.obstacles, radii[i], treatment, events[i], hopR);
    const keepOut: [number, number][] = onLine[i].map((e) => {
      const at = lengthAt(r, e.seg, e.d);
      const clear = horizontalness(pts, e.seg) > 0.7 ? MID_CROSSING_CLEAR_H : MID_CROSSING_CLEAR_V;
      return [at - clear, at + clear];
    });
    for (const c of onCurve[i]) {
      const span = r.cornerPos[c.vertex];
      if (!span) continue;
      const at = span[0] + (span[1] - span[0]) * c.t;
      // The curve turns between its two legs: clear by the leg it is nearer.
      const clear = horizontalness(pts, c.t < 0.5 ? c.vertex - 1 : c.vertex) > 0.7 ? MID_CROSSING_CLEAR_H : MID_CROSSING_CLEAR_V;
      keepOut.push([at - clear, at + clear]);
    }
    const mid = pickMid(r, keepOut);
    const rendered: RenderedPath = { d: r.d, mid };
    if (opts.crossings === 'halo') rendered.halo = true;
    if (r.strokeD) rendered.strokeD = r.strokeD;
    out.set(ids[i], rendered);
  }
  return out;
}
