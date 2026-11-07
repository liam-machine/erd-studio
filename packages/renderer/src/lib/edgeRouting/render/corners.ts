/**
 * Edge routing — how much of each segment a corner eats.
 *
 * Every interior vertex of a simplified polyline becomes a corner that
 * starts `rIn` px before the vertex (along the incoming segment) and ends
 * `rOut` px after it (along the outgoing one). Between corners, what is left
 * of a segment is drawn straight; hops and cuts may only sit there.
 *
 *   sharp    0
 *   rounded  up to 8 px, a quadratic (today's smooth-step look)
 *   curved   up to CURVE_RADIUS px each way, an elliptical quarter (cubic).
 *            An interior segment is shared by its two corners (half each);
 *            the first and last segments (from the card stubs) go wholly to
 *            their one corner, so a short step becomes one soft S. The
 *            curve stays inside the corner's triangle, so it only ever cuts
 *            the corner, never swings out; given the cards, a corner that
 *            would cut into one is shrunk until it clears.
 */

import type { CornerMode, Point, Rect } from '../types';

export const ROUNDED_RADIUS = 8;
/** Largest radius of a curved corner. */
export const CURVE_RADIUS = 40;
/** A curved corner is at most this many times longer on one leg than the other. */
const CURVE_RATIO = 2;
/** A curved corner keeps this many px of the stub segment straight. */
const CURVE_END_KEEP = 4;
/** A curved corner keeps this far (px) from any card it would otherwise cut. */
const CURVE_CLEARANCE = 6;
/** Cubic control-point factor for a quarter circle (and ellipse). */
export const KAPPA = 0.5523;

export interface CornerRadii {
  /** Length of each segment `i` (pts[i] → pts[i+1]). */
  segLen: Float64Array;
  /** Per vertex: px trimmed from the incoming segment (0 at the two ends). */
  rIn: Float64Array;
  /** Per vertex: px trimmed from the outgoing segment (0 at the two ends). */
  rOut: Float64Array;
}

export function cornerRadii(pts: readonly Point[], mode: CornerMode, obstacles?: readonly Rect[]): CornerRadii {
  const n = pts.length;
  const segLen = new Float64Array(Math.max(0, n - 1));
  for (let i = 0; i + 1 < n; i++) segLen[i] = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  const rIn = new Float64Array(n);
  const rOut = new Float64Array(n);
  if (mode === 'sharp') return { segLen, rIn, rOut };

  for (let v = 1; v < n - 1; v++) {
    const inLen = segLen[v - 1];
    const outLen = segLen[v];
    if (mode === 'rounded') {
      const r = Math.min(ROUNDED_RADIUS, inLen / 2, outLen / 2);
      rIn[v] = r;
      rOut[v] = r;
      continue;
    }
    const budgetIn = v - 1 === 0 ? inLen - CURVE_END_KEEP : inLen / 2;
    const budgetOut = v === n - 2 ? outLen - CURVE_END_KEEP : outLen / 2;
    let a = Math.max(0, Math.min(CURVE_RADIUS, budgetIn));
    let b = Math.max(0, Math.min(CURVE_RADIUS, budgetOut));
    const small = Math.min(a, b);
    a = Math.min(a, small * CURVE_RATIO);
    b = Math.min(b, small * CURVE_RATIO);
    if (obstacles && obstacles.length && a > ROUNDED_RADIUS) {
      [a, b] = clearOfCards(pts[v - 1], pts[v], pts[v + 1], a, b, obstacles);
    }
    rIn[v] = a;
    rOut[v] = b;
  }
  return { segLen, rIn, rOut };
}

/** The corner's start / end points and cubic control points. */
export function cornerCurve(prev: Point, cur: Point, next: Point, rIn: number, rOut: number) {
  const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y) || 1;
  const outLen = Math.hypot(next.x - cur.x, next.y - cur.y) || 1;
  const a = { x: cur.x - ((cur.x - prev.x) / inLen) * rIn, y: cur.y - ((cur.y - prev.y) / inLen) * rIn };
  const b = { x: cur.x + ((next.x - cur.x) / outLen) * rOut, y: cur.y + ((next.y - cur.y) / outLen) * rOut };
  const c1 = { x: a.x + (cur.x - a.x) * KAPPA, y: a.y + (cur.y - a.y) * KAPPA };
  const c2 = { x: b.x + (cur.x - b.x) * KAPPA, y: b.y + (cur.y - b.y) * KAPPA };
  return { a, c1, c2, b };
}

const SAMPLES = [0.2, 0.35, 0.5, 0.65, 0.8];

/** Shrink a curved corner until its curve keeps CURVE_CLEARANCE from every card the vertex itself is clear of. */
function clearOfCards(
  prev: Point,
  cur: Point,
  next: Point,
  rIn: number,
  rOut: number,
  obstacles: readonly Rect[],
): [number, number] {
  const reach = Math.max(rIn, rOut) + CURVE_CLEARANCE;
  const near: Rect[] = [];
  for (const r of obstacles) {
    if (r.x > cur.x + reach || r.x + r.width < cur.x - reach || r.y > cur.y + reach || r.y + r.height < cur.y - reach) continue;
    // The route itself runs through this card here: the curve cannot help it.
    if (cur.x > r.x - CURVE_CLEARANCE && cur.x < r.x + r.width + CURVE_CLEARANCE && cur.y > r.y - CURVE_CLEARANCE && cur.y < r.y + r.height + CURVE_CLEARANCE) continue;
    near.push(r);
  }
  if (!near.length) return [rIn, rOut];
  for (let attempt = 0; attempt < 5; attempt++) {
    const { a, c1, c2, b } = cornerCurve(prev, cur, next, rIn, rOut);
    let hit = false;
    for (const t of SAMPLES) {
      const u = 1 - t;
      const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x;
      const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y;
      for (const r of near) {
        if (x > r.x - CURVE_CLEARANCE && x < r.x + r.width + CURVE_CLEARANCE && y > r.y - CURVE_CLEARANCE && y < r.y + r.height + CURVE_CLEARANCE) {
          hit = true;
          break;
        }
      }
      if (hit) break;
    }
    if (!hit) return [rIn, rOut];
    rIn *= 0.7;
    rOut *= 0.7;
    if (Math.max(rIn, rOut) <= ROUNDED_RADIUS) break;
  }
  return [Math.min(rIn, ROUNDED_RADIUS), Math.min(rOut, ROUNDED_RADIUS)];
}
