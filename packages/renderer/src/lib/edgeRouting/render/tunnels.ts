/**
 * Edge routing — "x-ray": the stretches of a line that pass under a card.
 *
 * Cards are drawn above the lines, so any stretch of a line inside a card's
 * box is hidden. `computeTunnels` clips the line's polyline against every
 * box (tables and sticky notes alike, the line's own two ends included: a
 * line that doubles back across its own table is hidden there too) and
 * returns each hidden stretch as a polyline. `EdgeOverlay` draws them above
 * the cards, with a "portal" where the line dives under a border and where it
 * comes back out.
 *
 * - Boxes are shrunk by `EDGE_TOLERANCE` first, so a line that grazes a
 *   corner is not "under" anything; a straight stretch parallel to a border
 *   and within `BORDER_HUG` of it runs "along" the border, not under the card.
 * - Overlapping or nearly touching boxes (a gap under `MERGE_GAP`) give one
 *   tunnel, not a row of portals 4 px apart.
 * - Stretches shorter than `MIN_TUNNEL` (a rounded corner clipping a box
 *   corner) are dropped.
 * - A stretch at the line's own end that is only under the line's own two
 *   cards is dropped: when two related cards nearly touch, the 20 px stub
 *   starts inside the other card and the line hooks round inside the pair.
 *   Showing that hook says nothing the reader does not know (the line joins
 *   those two cards) and puts dashes in two headers.
 *
 * Pure and allocation-light: it runs for every line on every frame of a drag.
 * A box is tested against a segment only when their bounding boxes meet.
 */

import type { EdgeSpec, Point, Rect, RoutedLine } from '../types';

/** A line closer than this (px) to a border counts as outside the box. */
export const EDGE_TOLERANCE = 1;
/**
 * A straight stretch running parallel to a border and closer to it than this
 * (px) is "along the border", not under the card: drawn, its ghost reads as
 * a second, dashed border a few px inside the real one (seen on 'big': 127 px
 * of it 3 px inside dim_supplier's bottom). Like every threshold it flips
 * somewhere during a drag; pops stay rare (~1 in 1500 nudges on the scenarios).
 */
export const BORDER_HUG = 6;
/** Hidden stretches closer together than this (px) along the line become one tunnel. */
export const MERGE_GAP = 12;
/** Hidden stretches shorter than this (px) are not worth a tunnel. */
export const MIN_TUNNEL = 6;

/**
 * Liang–Barsky: the parameter range [t0, t1] ⊂ [0, 1] of segment a→b inside
 * the box, or null when the segment misses it.
 */
function clipSegment(
  ax: number,
  ay: number,
  dx: number,
  dy: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - left, right - ax, ay - top, bottom - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this pair of borders: inside only if strictly between them.
      if (q[i] <= 0) return null;
      continue;
    }
    const r = q[i] / p[i];
    if (p[i] < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return t1 > t0 ? [t0, t1] : null;
}

/** The point at arc length `s` along the polyline (with cumulative lengths `cum`). */
function pointAt(points: Point[], cum: number[], s: number, from: number): { p: Point; seg: number } {
  let i = from;
  while (i < points.length - 2 && cum[i + 1] < s) i++;
  const len = cum[i + 1] - cum[i];
  const t = len > 0 ? (s - cum[i]) / len : 0;
  const a = points[i];
  const b = points[i + 1];
  return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, seg: i };
}

/**
 * The hidden stretches of `line` as polylines: hidden by `obstacles` (every
 * card box). Each polyline starts where the line dives under a border and ends
 * where it comes back out (or where the line itself starts / ends, if an end
 * sits inside another card).
 */
export function computeTunnels(line: RoutedLine, spec: EdgeSpec | undefined, obstacles: Rect[]): Point[][] {
  const pts = line.points;
  if (pts.length < 2 || obstacles.length === 0) return [];

  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));

  // Hidden intervals along the line, by arc length, and whether the card is not one of the line's ends.
  const spans: [number, number, boolean][] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const len = cum[i + 1] - cum[i];
    // A zero-length segment hides nothing; a NaN / infinite point (a node not
    // measured yet, a bad position) must not turn into NaN path data.
    if (!(len > 0) || !Number.isFinite(len)) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    for (const r of obstacles) {
      const left = r.x + EDGE_TOLERANCE;
      const top = r.y + EDGE_TOLERANCE;
      const right = r.x + r.width - EDGE_TOLERANCE;
      const bottom = r.y + r.height - EDGE_TOLERANCE;
      // Also false for a NaN or infinite box: `!(a < b)` rather than `a >= b`.
      if (!(right > left) || !(bottom > top) || !Number.isFinite(right - left) || !Number.isFinite(bottom - top)) continue;
      if (maxX <= left || minX >= right || maxY <= top || minY >= bottom) continue;
      if (dy === 0 && (a.y - r.y < BORDER_HUG || r.y + r.height - a.y < BORDER_HUG)) continue;
      if (dx === 0 && (a.x - r.x < BORDER_HUG || r.x + r.width - a.x < BORDER_HUG)) continue;
      const hit = clipSegment(a.x, a.y, dx, dy, left, top, right, bottom);
      if (hit) spans.push([cum[i] + hit[0] * len, cum[i] + hit[1] * len, r.id !== spec?.source && r.id !== spec?.target]);
    }
  }
  if (spans.length === 0) return [];

  // Union, bridging small gaps (overlapping or nearly touching cards).
  spans.sort((p, q) => p[0] - q[0]);
  const merged: [number, number, boolean][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < MERGE_GAP) {
      if (s[1] > last[1]) last[1] = s[1];
      if (s[2]) last[2] = true;
    } else {
      merged.push([s[0], s[1], s[2]]);
    }
  }

  const total = cum[cum.length - 1];
  if (!Number.isFinite(total)) return [];
  const tunnels: Point[][] = [];
  let seg = 0;
  for (const [s0, s1, foreign] of merged) {
    if (s1 - s0 < MIN_TUNNEL) continue;
    if (spec && !foreign && (s0 < 0.5 || s1 > total - 0.5)) continue;
    const start = pointAt(pts, cum, s0, seg);
    const end = pointAt(pts, cum, s1, start.seg);
    const poly: Point[] = [start.p];
    for (let k = start.seg + 1; k <= end.seg; k++) poly.push(pts[k]);
    poly.push(end.p);
    tunnels.push(dedupe(poly));
    seg = end.seg;
  }
  return tunnels;
}

/** Drop consecutive repeats (a tunnel that starts exactly on a corner). */
function dedupe(poly: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
    out.push(p);
  }
  return out;
}
