/**
 * Route-around router — small geometry helpers shared by the grid, the search
 * and the nudging pass. Orthogonal only: every segment is horizontal or vertical.
 */

import {
  PATH_GAP,
  type Anchor,
  type Point,
  type Rect,
  type Side,
} from "../../types";
import { ANCHOR_INSET } from "./params";

/** Leg orientation: 0 = horizontal, 1 = vertical. */
export type Orient = 0 | 1;

/** The sides tried for a port, in a fixed order (determinism). */
export const SIDES: readonly Side[] = ["right", "left", "bottom", "top"];

/** Orientation of the straight leg that leaves (or enters) a side. */
export function legOrient(side: Side): Orient {
  return side === "left" || side === "right" ? 0 : 1;
}

/** Direction of travel along that leg when leaving the card (+1 = towards +x / +y). */
export function outDir(side: Side): 1 | -1 {
  return side === "right" || side === "bottom" ? 1 : -1;
}

/** Where a side lies across its leg: x of a left/right side, y of a top/bottom side. */
export function sideLine(r: Rect, side: Side): number {
  switch (side) {
    case "left":
      return r.x;
    case "right":
      return r.x + r.width;
    case "top":
      return r.y;
    case "bottom":
      return r.y + r.height;
  }
}

/** The span of a side along itself: [y0, y1] for left/right, [x0, x1] for top/bottom. */
export function sideSpan(r: Rect, side: Side): [number, number] {
  return legOrient(side) === 0 ? [r.y, r.y + r.height] : [r.x, r.x + r.width];
}

/** Where anchors may sit along a side: the span minus a corner inset (the centre for a short side). */
export function anchorRange(r: Rect, side: Side): [number, number] {
  const [a, b] = sideSpan(r, side);
  const inset = Math.min(ANCHOR_INSET, (b - a) / 2);
  return [a + inset, b - inset];
}

export function sideMid(r: Rect, side: Side): number {
  const [a, b] = sideSpan(r, side);
  return (a + b) / 2;
}

/** The port: the point `c` along the side, pushed PATH_GAP out (where the drawn line starts). */
export function portPoint(r: Rect, side: Side, c: number): Point {
  const line = sideLine(r, side) + outDir(side) * PATH_GAP;
  return legOrient(side) === 0 ? { x: line, y: c } : { x: c, y: line };
}

/** The anchor on the card border behind a port. */
export function anchorBehind(port: Point, side: Side): Anchor {
  switch (side) {
    case "right":
      return { x: port.x - PATH_GAP, y: port.y, side };
    case "left":
      return { x: port.x + PATH_GAP, y: port.y, side };
    case "bottom":
      return { x: port.x, y: port.y - PATH_GAP, side };
    case "top":
      return { x: port.x, y: port.y + PATH_GAP, side };
  }
}

export function pad(
  r: Rect,
  by: number,
): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: r.x - by,
    y0: r.y - by,
    x1: r.x + r.width + by,
    y1: r.y + r.height + by,
  };
}

/** Do two rects (each grown by its own amount) overlap with positive area? */
export function rectsOverlap(
  a: Rect,
  growA: number,
  b: Rect,
  growB: number,
): boolean {
  return (
    a.x - growA < b.x + b.width + growB &&
    b.x - growB < a.x + a.width + growA &&
    a.y - growA < b.y + b.height + growB &&
    b.y - growB < a.y + a.height + growA
  );
}

/** Drop repeated points and the middle point of any straight run. */
export function simplifyOrthogonal(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01)
      continue;
    if (out.length >= 2) {
      const a = out[out.length - 2];
      const b = last;
      const sameX = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01;
      const sameY = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01;
      if (sameX || sameY) {
        out[out.length - 1] = { x: p.x, y: p.y };
        continue;
      }
    }
    out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Does the axis-aligned segment a→b pass through the inside of `r` (shrunk by
 * `tol` on every side)? Touching the border does not count.
 */
export function segmentEntersRect(
  a: Point,
  b: Point,
  r: Rect,
  tol: number,
): boolean {
  const x0 = r.x + tol;
  const x1 = r.x + r.width - tol;
  const y0 = r.y + tol;
  const y1 = r.y + r.height - tol;
  if (x1 <= x0 || y1 <= y0) return false;
  if (Math.abs(a.x - b.x) < 0.01) {
    if (a.x <= x0 || a.x >= x1) return false;
    const lo = Math.min(a.y, b.y);
    const hi = Math.max(a.y, b.y);
    return Math.min(hi, y1) - Math.max(lo, y0) > 0;
  }
  if (Math.abs(a.y - b.y) < 0.01) {
    if (a.y <= y0 || a.y >= y1) return false;
    const lo = Math.min(a.x, b.x);
    const hi = Math.max(a.x, b.x);
    return Math.min(hi, x1) - Math.max(lo, x0) > 0;
  }
  // Not axis-aligned (only the fallback path could be): sample it.
  for (let t = 0.05; t < 1; t += 0.05) {
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > x0 && x < x1 && y > y0 && y < y1) return true;
  }
  return false;
}

/**
 * A uniform bucket grid over the cards, for "which cards are near this
 * segment" queries in the nudging and validation passes.
 */
export class Buckets {
  private readonly x0: number;
  private readonly y0: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly cells: number[][];
  private readonly seen: Uint32Array;
  private stamp = 0;

  private readonly cell: number;

  constructor(
    readonly rects: readonly Rect[],
    cell = 160,
  ) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x);
      y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.width);
      y1 = Math.max(y1, r.y + r.height);
    }
    if (!rects.length) {
      x0 = y0 = 0;
      x1 = y1 = 1;
    }
    this.x0 = x0;
    this.y0 = y0;
    // At most ~256 cells a side: a card far off (a typo'd position) or a giant
    // one must not allocate millions of cells (1e9 px wide ran out of memory).
    this.cell = Math.max(cell, Math.max(x1 - x0, y1 - y0) / 256);
    cell = this.cell;
    this.cols = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
    this.rows = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
    this.cells = Array.from({ length: this.cols * this.rows }, () => []);
    this.seen = new Uint32Array(rects.length);
    rects.forEach((r, i) => {
      const [c0, r0] = this.cellOf(r.x, r.y);
      const [c1, r1] = this.cellOf(r.x + r.width, r.y + r.height);
      for (let row = r0; row <= r1; row++)
        for (let col = c0; col <= c1; col++)
          this.cells[row * this.cols + col].push(i);
    });
  }

  private cellOf(x: number, y: number): [number, number] {
    const c = Math.min(
      this.cols - 1,
      Math.max(0, Math.floor((x - this.x0) / this.cell)),
    );
    const r = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((y - this.y0) / this.cell)),
    );
    return [c, r];
  }

  /** Indices of the rects whose bucket cells meet the box (a superset of the rects that meet it). */
  query(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    out: number[] = [],
  ): number[] {
    out.length = 0;
    if (++this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const [c0, r0] = this.cellOf(x0, y0);
    const [c1, r1] = this.cellOf(x1, y1);
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        for (const i of this.cells[row * this.cols + col]) {
          if (this.seen[i] === this.stamp) continue;
          this.seen[i] = this.stamp;
          out.push(i);
        }
      }
    }
    return out;
  }
}
