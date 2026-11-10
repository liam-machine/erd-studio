/**
 * Edge routing — where a drawn corner curve crosses another line's
 * straight stretch.
 *
 * `findCrossings` works on the routed polylines, which is exact only where
 * both lines are drawn straight. A rounded or curved corner cuts inside its
 * vertex, so where a corner is involved the polyline crossing is in the wrong
 * place (or the drawn lines do not cross at all, or cross where the
 * polylines do not). With curved corners that is most crossings. This finds
 * them on the drawn geometry: each corner curve flattened into chords,
 * against every other line's straight stretches (the part of each segment no
 * corner eats).
 *
 * Curve against curve is left out: there is no straight line to break.
 */

import type { CornerMode, Point } from '../types';
import { cornerCurve, type CornerRadii } from './corners';
import type { CrossingEnd } from './crossings';

/** Chords per corner curve. A 40 px quarter is within ~0.2 px of its chords. */
const CHORDS = 10;
/** A crossing this close (px) to either end of a straight stretch is a touch. */
const END_EPS = 0.75;

export interface CurveCrossing {
  x: number;
  y: number;
  /** The straight line's end, as `findCrossings` reports it (distance from the segment's first point). */
  straight: CrossingEnd;
  /** The curving line, its corner vertex, and how far through the corner (0..1). */
  curve: { line: number; vertex: number; t: number };
}

interface Item {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  line: number;
  /** Straight stretch: segment index; curve: vertex index. */
  index: number;
  curve: boolean;
  /** Straight: [start, end]; curve: the flattened points (CHORDS + 1). */
  pts: Point[];
  /** Straight only: where the stretch starts along its segment. */
  offset: number;
}

function bezier(mode: CornerMode, a: Point, c1: Point, c2: Point, b: Point, cur: Point, t: number): Point {
  const u = 1 - t;
  if (mode === 'rounded') {
    return { x: u * u * a.x + 2 * u * t * cur.x + t * t * b.x, y: u * u * a.y + 2 * u * t * cur.y + t * t * b.y };
  }
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}

function boxed(item: Omit<Item, 'minX' | 'maxX' | 'minY' | 'maxY'>): Item {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of item.pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { ...item, minX, maxX, minY, maxY };
}

/**
 * Every crossing between one line's corner curve and another line's straight
 * stretch. `radii[i]` must be the radii the paths are drawn with.
 */
export function findCurveCrossings(
  polys: readonly Point[][],
  radii: readonly CornerRadii[],
  mode: CornerMode,
): CurveCrossing[] {
  if (mode === 'sharp') return [];
  const items: Item[] = [];
  let curves = 0;
  for (let line = 0; line < polys.length; line++) {
    const pts = polys[line];
    const r = radii[line];
    for (let s = 0; s + 1 < pts.length; s++) {
      const len = r.segLen[s];
      if (len <= 0) continue;
      const lo = r.rOut[s];
      const hi = len - r.rIn[s + 1];
      if (hi - lo > 2 * END_EPS) {
        const a = pts[s];
        const b = pts[s + 1];
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        items.push(
          boxed({
            line,
            index: s,
            curve: false,
            pts: [
              { x: a.x + ux * lo, y: a.y + uy * lo },
              { x: a.x + ux * hi, y: a.y + uy * hi },
            ],
            offset: lo,
          }),
        );
      }
      const v = s + 1;
      if (v < pts.length - 1 && (r.rIn[v] > 0 || r.rOut[v] > 0)) {
        const cc = cornerCurve(pts[v - 1], pts[v], pts[v + 1], r.rIn[v], r.rOut[v]);
        const flat: Point[] = [];
        for (let k = 0; k <= CHORDS; k++) flat.push(bezier(mode, cc.a, cc.c1, cc.c2, cc.b, pts[v], k / CHORDS));
        items.push(boxed({ line, index: v, curve: true, pts: flat, offset: 0 }));
        curves++;
      }
    }
  }
  if (!curves) return [];
  items.sort((p, q) => p.minX - q.minX);

  const out: CurveCrossing[] = [];
  for (let i = 0; i < items.length; i++) {
    const p = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const q = items[j];
      if (q.minX > p.maxX) break;
      if (p.curve === q.curve || p.line === q.line) continue;
      if (q.minY > p.maxY || q.maxY < p.minY) continue;
      const curve = p.curve ? p : q;
      const straight = p.curve ? q : p;
      const [A, B] = straight.pts;
      const sx = B.x - A.x;
      const sy = B.y - A.y;
      const sLen = Math.hypot(sx, sy);
      for (let k = 0; k < CHORDS; k++) {
        const c0 = curve.pts[k];
        const c1 = curve.pts[k + 1];
        const rx = c1.x - c0.x;
        const ry = c1.y - c0.y;
        const denom = rx * sy - ry * sx;
        if (Math.abs(denom) < 1e-9) continue;
        const cx = A.x - c0.x;
        const cy = A.y - c0.y;
        const t = (cx * sy - cy * sx) / denom; // along the chord
        const u = (cx * ry - cy * rx) / denom; // along the straight stretch
        // Half-open on the chord, so a crossing on a chord joint counts once.
        if (t < 0 || t >= 1) continue;
        const along = u * sLen;
        if (along <= END_EPS || along >= sLen - END_EPS) continue;
        out.push({
          x: A.x + sx * u,
          y: A.y + sy * u,
          straight: { line: straight.line, seg: straight.index, d: straight.offset + along },
          curve: { line: curve.line, vertex: curve.index, t: (k + t) / CHORDS },
        });
      }
    }
  }
  return out;
}
