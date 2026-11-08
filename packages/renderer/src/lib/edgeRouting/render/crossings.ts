/**
 * Edge routing — where routed lines cross each other.
 *
 * Works on the simplified polylines (one segment per straight run). A
 * crossing is *proper*: the two segments cut through each other strictly
 * inside both of them. Touching ends, a corner sitting on another line,
 * and collinear overlaps (a shared channel) are not crossings.
 *
 * A sweep over segments sorted by left edge keeps this well under a
 * millisecond for a few hundred segments.
 */

import type { Point } from '../types';

/** One end of a crossing: which line, which segment, how far along it (px). */
export interface CrossingEnd {
  line: number;
  seg: number;
  /** Distance from the segment's first point. */
  d: number;
}

export interface Crossing {
  x: number;
  y: number;
  a: CrossingEnd;
  b: CrossingEnd;
}

/** A crossing this close (px) to either segment's end is a touch, not a crossing. */
const END_EPS = 0.75;
/** Segments closer than this to parallel (sine of the angle) never cross properly. */
const PARALLEL_SIN = 0.02;

interface Seg {
  line: number;
  seg: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  len: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Every proper crossing between segments of different lines. */
export function findCrossings(polys: readonly Point[][]): Crossing[] {
  const segs: Seg[] = [];
  for (let line = 0; line < polys.length; line++) {
    const pts = polys[line];
    for (let s = 0; s + 1 < pts.length; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 2 * END_EPS) continue;
      segs.push({
        line,
        seg: s,
        ax: a.x,
        ay: a.y,
        bx: b.x,
        by: b.y,
        len,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  }
  segs.sort((p, q) => p.minX - q.minX);

  const out: Crossing[] = [];
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i];
    for (let j = i + 1; j < segs.length; j++) {
      const q = segs[j];
      if (q.minX > p.maxX) break;
      if (q.line === p.line) continue;
      if (q.minY > p.maxY || q.maxY < p.minY) continue;

      const rx = p.bx - p.ax;
      const ry = p.by - p.ay;
      const sx = q.bx - q.ax;
      const sy = q.by - q.ay;
      const denom = rx * sy - ry * sx;
      if (Math.abs(denom) < PARALLEL_SIN * p.len * q.len) continue;
      const cx = q.ax - p.ax;
      const cy = q.ay - p.ay;
      const t = (cx * sy - cy * sx) / denom;
      const u = (cx * ry - cy * rx) / denom;
      const dp = t * p.len;
      const dq = u * q.len;
      if (dp <= END_EPS || dp >= p.len - END_EPS || dq <= END_EPS || dq >= q.len - END_EPS) continue;
      out.push({
        x: p.ax + rx * t,
        y: p.ay + ry * t,
        a: { line: p.line, seg: p.seg, d: dp },
        b: { line: q.line, seg: q.seg, d: dq },
      });
    }
  }
  return out;
}
