/**
 * Route-around router — the routing grid.
 *
 * A sparse orthogonal grid (Wybrow–Marriott–Stuckey style): its lines are the
 * padded edges of every card, channel midlines between neighbouring cards,
 * the centre of every card side, and the line where two related cards'
 * sides overlap (so a straight line between them is on offer). A node is
 * every crossing of an x-line and a y-line. Every padded card's edges are
 * grid lines, so each elementary grid edge is either wholly inside a padded
 * card or wholly outside it; `hBlk` / `vBlk` count the padded cards each one
 * runs through, so a card can be lifted out again (`markRect(…, -1)`) for a
 * relaxed retry.
 *
 * Node index n = j * nx + i (column i, row j).
 *   hBlk[n]  the edge from (i, j) to (i + 1, j)
 *   vBlk[n]  the edge from (i, j) to (i, j + 1)
 *   hUse / vUse  how many lines routed so far run along that edge.
 */

import { MERGE_EPS } from "./params";

export interface Grid {
  xs: Float64Array;
  ys: Float64Array;
  nx: number;
  ny: number;
  hBlk: Uint16Array;
  vBlk: Uint16Array;
  hUse: Uint8Array;
  vUse: Uint8Array;
  /** Anchor zones: the band in front of a card side where lines attach (closed to other lines). */
  hZone: Uint8Array;
  vZone: Uint8Array;
}

/** Sort and merge values closer than MERGE_EPS (each cluster keeps its smallest value). */
export function uniqueSorted(values: number[]): Float64Array {
  const sorted = Float64Array.from(
    values.filter((v) => Number.isFinite(v)),
  ).sort();
  const out: number[] = [];
  let start = -Infinity;
  for (const v of sorted) {
    if (v - start > MERGE_EPS) {
      out.push(v);
      start = v;
    }
  }
  return Float64Array.from(out);
}

/**
 * The grid lines: every `hard` value (a padded card edge, which the blocking
 * needs exactly) plus each `soft` value (side centres, midlines, straight-line
 * options) that is more than `softEps` from every line kept so far. A cluster
 * of lines a few px apart adds nodes but no real routing choice, and A* pays
 * for every node.
 */
export function gridLines(
  hard: number[],
  soft: number[],
  softEps: number,
): Float64Array {
  const kept = Array.from(uniqueSorted(hard));
  const sortedSoft = Float64Array.from(
    soft.filter((v) => Number.isFinite(v)),
  ).sort();
  // Soft values far from any hard line, then thinned among themselves.
  const accepted: number[] = [];
  let k = 0;
  for (const v of sortedSoft) {
    while (k < kept.length && kept[k] < v - softEps) k++;
    if (k < kept.length && Math.abs(kept[k] - v) <= softEps) continue;
    if (k > 0 && Math.abs(kept[k - 1] - v) <= softEps) continue;
    if (accepted.length && v - accepted[accepted.length - 1] <= softEps)
      continue;
    accepted.push(v);
  }
  const all = Float64Array.from([...kept, ...accepted]).sort();
  return all;
}

/** The largest index i with arr[i] <= v (+ a hair), or -1. */
export function floorIndex(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v + 1e-6) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** The smallest index i with arr[i] >= v (- a hair), or arr.length. */
export function ceilIndex(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let ans = arr.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] >= v - 1e-6) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/**
 * Scratch buffers reused between calls (routing runs every frame of a drag).
 * Shared by every router: a pass is synchronous and `makeGrid` clears what it
 * hands out, so nothing carries from one pass (or one canvas) to the next.
 */
let pool: {
  hBlk: Uint16Array;
  vBlk: Uint16Array;
  hUse: Uint8Array;
  vUse: Uint8Array;
  hZone: Uint8Array;
  vZone: Uint8Array;
} | null = null;

export function makeGrid(xs: Float64Array, ys: Float64Array): Grid {
  const size = xs.length * ys.length;
  if (!pool || pool.hBlk.length < size) {
    const cap = Math.max(size, Math.ceil((pool?.hBlk.length ?? 0) * 1.5));
    pool = {
      hBlk: new Uint16Array(cap),
      vBlk: new Uint16Array(cap),
      hUse: new Uint8Array(cap),
      vUse: new Uint8Array(cap),
      hZone: new Uint8Array(cap),
      vZone: new Uint8Array(cap),
    };
  }
  const grid: Grid = {
    xs,
    ys,
    nx: xs.length,
    ny: ys.length,
    hBlk: pool.hBlk.subarray(0, size),
    vBlk: pool.vBlk.subarray(0, size),
    hUse: pool.hUse.subarray(0, size),
    vUse: pool.vUse.subarray(0, size),
    hZone: pool.hZone.subarray(0, size),
    vZone: pool.vZone.subarray(0, size),
  };
  grid.hBlk.fill(0);
  grid.vBlk.fill(0);
  grid.hUse.fill(0);
  grid.vUse.fill(0);
  grid.hZone.fill(0);
  grid.vZone.fill(0);
  return grid;
}

/**
 * Add (delta +1) or remove (-1) a padded card: every grid edge strictly
 * inside the box. The box's edges must be grid lines (they snap to the line
 * they were merged into).
 */
export function markRect(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  delta: 1 | -1,
): void {
  const i0 = floorIndex(g.xs, x0);
  const i1 = floorIndex(g.xs, x1);
  const j0 = floorIndex(g.ys, y0);
  const j1 = floorIndex(g.ys, y1);
  if (i0 < 0 || j0 < 0 || i1 <= i0 || j1 <= j0) return;
  const { nx, hBlk, vBlk } = g;
  for (let j = j0 + 1; j < j1; j++) {
    const row = j * nx;
    for (let i = i0; i < i1; i++) hBlk[row + i] += delta;
  }
  for (let j = j0; j < j1; j++) {
    const row = j * nx;
    for (let i = i0 + 1; i < i1; i++) vBlk[row + i] += delta;
  }
}

/** Count a routed line's grid edges (consecutive nodes of a search result). */
export function markUse(g: Grid, nodes: readonly number[]): void {
  for (let q = 1; q < nodes.length; q++) {
    const a = nodes[q - 1];
    const b = nodes[q];
    const lo = a < b ? a : b;
    if (Math.abs(a - b) === 1) {
      if (g.hUse[lo] < 255) g.hUse[lo]++;
    } else if (g.vUse[lo] < 255) {
      g.vUse[lo]++;
    }
  }
}

/** The smallest index k with arr[k] > v, or arr.length. */
function firstAbove(arr: Float64Array, v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] > v) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * Close (delta +1) or reopen (-1) a box that is not grid-aligned: every grid
 * edge that runs inside it, or crosses into it, is marked. Used for the
 * anchor zone in front of a card side.
 */
export function markZone(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  delta: 1 | -1,
): void {
  markOpenBox(g, g.hZone, g.vZone, x0, y0, x1, y1, delta);
}

/**
 * Block (+1) or unblock (-1) a box that is not grid-aligned, like `markZone`
 * but in the hard block counts (used for the band round a line's own cards).
 */
export function markBand(
  g: Grid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  delta: 1 | -1,
): void {
  markOpenBox(g, g.hBlk, g.vBlk, x0, y0, x1, y1, delta);
}

function markOpenBox(
  g: Grid,
  hZone: Uint8Array | Uint16Array,
  vZone: Uint8Array | Uint16Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  delta: 1 | -1,
): void {
  const { xs, ys, nx, ny } = g;
  const e = 0.5;
  // Horizontal edges on rows strictly inside, overlapping (x0, x1).
  const ja = firstAbove(ys, y0 + e);
  const jb = firstAbove(ys, y1 - e) - 1;
  const ia = Math.max(0, firstAbove(xs, x0 + e) - 1);
  const ib = Math.min(nx - 2, firstAbove(xs, x1 - e - 1e-9) - 1);
  for (let j = ja; j <= jb && j < ny; j++) {
    const row = j * nx;
    for (let i = ia; i <= ib; i++) {
      if (xs[i + 1] > x0 + e && xs[i] < x1 - e) hZone[row + i] += delta;
    }
  }
  // Vertical edges on columns strictly inside, overlapping (y0, y1).
  const ka = firstAbove(xs, x0 + e);
  const kb = firstAbove(xs, x1 - e) - 1;
  const la = Math.max(0, firstAbove(ys, y0 + e) - 1);
  const lb = Math.min(ny - 2, firstAbove(ys, y1 - e - 1e-9) - 1);
  for (let j = la; j <= lb; j++) {
    if (!(ys[j + 1] > y0 + e && ys[j] < y1 - e)) continue;
    const row = j * nx;
    for (let i = ka; i <= kb && i < nx; i++) vZone[row + i] += delta;
  }
}

/**
 * Count a polyline's grid edges as used, from its geometry (a route kept from
 * an earlier pass, whose grid has changed since). Segments not on a grid line
 * are skipped: usage is only a hint to the lines routed after it.
 */
export function markPathUse(
  g: Grid,
  pts: readonly { x: number; y: number }[],
): void {
  const { xs, ys, nx, hUse, vUse } = g;
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (Math.abs(a.y - b.y) < 0.01) {
      const j = floorIndex(ys, a.y);
      if (j < 0 || Math.abs(ys[j] - a.y) > 0.01) continue;
      const lo = Math.max(0, floorIndex(xs, Math.min(a.x, b.x)));
      const hi = Math.min(nx - 1, ceilIndex(xs, Math.max(a.x, b.x)));
      for (let e = lo; e < hi; e++)
        if (hUse[j * nx + e] < 255) hUse[j * nx + e]++;
    } else if (Math.abs(a.x - b.x) < 0.01) {
      const i = floorIndex(xs, a.x);
      if (i < 0 || Math.abs(xs[i] - a.x) > 0.01) continue;
      const lo = Math.max(0, floorIndex(ys, Math.min(a.y, b.y)));
      const hi = Math.min(g.ny - 1, ceilIndex(ys, Math.max(a.y, b.y)));
      for (let e = lo; e < hi; e++)
        if (vUse[e * nx + i] < 255) vUse[e * nx + i]++;
    }
  }
}
