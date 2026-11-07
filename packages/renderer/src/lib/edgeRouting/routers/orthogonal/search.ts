/**
 * Route-around router — A* over the routing grid.
 *
 * A state is (grid node, heading): bends cost BEND and a line may never
 * double back on itself, so the search needs to know which way it is going.
 * Many sources and many targets: every allowed anchor slot on every free
 * side of the two cards is a seed / a goal (`Port`), each carrying its own
 * cost (how far the anchor sits off the side's centre, plus the straight leg
 * to the grid). The search stops at the cheapest complete route: a goal
 * reached travelling along its leg towards the card, or turning onto it (one
 * more bend).
 *
 * Costs: length, BEND per bend, CROSS per line routed earlier that this one
 * crosses, SHARE per px of grid edge that earlier lines already use, and
 * ZONE_COST per px run inside another card side's anchor zone. The
 * heuristic is scaled by HEURISTIC_WEIGHT (bounded-suboptimal A*).
 *
 * The heuristic is the classic orthogonal-routing lower bound (as libavoid
 * uses): for each side of the target, the Manhattan distance to its port
 * line plus BEND × the fewest bends that can still arrive on it square-on
 * from the current heading. Without the bend count a Z-shaped route (two
 * bends) leaves every one-bend state between the cards cheaper than the
 * answer, and A* floods the whole rectangle between them.
 *
 * Typed arrays are reused across searches with a stamp, so a search costs
 * only what it touches.
 */

import type { Point, Side } from "../../types";
import type { Grid } from "./grid";
import type { Orient } from "./geom";
import { BEND, CROSS, HEURISTIC_WEIGHT, SHARE, ZONE_COST } from "./params";

export interface Port {
  side: Side;
  /** The anchor's coordinate along the side. */
  c: number;
  /** The stub point (PATH_GAP off the card), where the drawn line starts / ends. */
  point: Point;
  /** The grid node at the far end of the straight leg (≥ MIN_LEG from the stub). */
  node: number;
  /** Orientation of the leg. */
  orient: Orient;
  /** Direction of travel along the leg: away from the card for a seed, towards it for a goal. */
  dir: 1 | -1;
  /** Anchor penalty + leg length (+ crossings of lines already routed across the leg). */
  cost: number;
  /** The slot's grid line (row for a horizontal leg, column for a vertical one). */
  lane: number;
  /** Elementary grid edges the leg covers along its lane: [legLo, legHi]. */
  legLo: number;
  legHi: number;
}

export interface Found {
  /** Grid nodes from the seed's node to the goal's node. */
  nodes: number[];
  src: Port;
  tgt: Port;
  cost: number;
}

/** Heading index: 0 = +x, 1 = -x, 2 = +y, 3 = -y. */
const headingOf = (orient: number, dir: number): number =>
  orient * 2 + (dir > 0 ? 0 : 1);

class MinHeap {
  f = new Float64Array(1024);
  g = new Float64Array(1024);
  s = new Int32Array(1024);
  size = 0;
  topF = 0;
  topG = 0;
  topS = 0;

  clear(): void {
    this.size = 0;
  }

  private grow(): void {
    const n = this.f.length * 2;
    const f = new Float64Array(n);
    const g = new Float64Array(n);
    const s = new Int32Array(n);
    f.set(this.f);
    g.set(this.g);
    s.set(this.s);
    this.f = f;
    this.g = g;
    this.s = s;
  }

  push(f: number, s: number, g: number): void {
    if (this.size === this.f.length) this.grow();
    let i = this.size++;
    const F = this.f;
    const G = this.g;
    const S = this.s;
    while (i > 0) {
      const p = (i - 1) >> 1;
      // Ties: the deeper state (larger g) first, so a plateau is finished along one path.
      if (F[p] < f || (F[p] === f && G[p] >= g)) break;
      F[i] = F[p];
      G[i] = G[p];
      S[i] = S[p];
      i = p;
    }
    F[i] = f;
    G[i] = g;
    S[i] = s;
  }

  /** Pops into topF / topG / topS. */
  pop(): void {
    const F = this.f;
    const G = this.g;
    const S = this.s;
    this.topF = F[0];
    this.topG = G[0];
    this.topS = S[0];
    const n = --this.size;
    if (n === 0) return;
    const f = F[n];
    const g = G[n];
    const s = S[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      let c = l;
      if (r < n && (F[r] < F[l] || (F[r] === F[l] && G[r] > G[l]))) c = r;
      if (F[c] > f || (F[c] === f && G[c] <= g)) break;
      F[i] = F[c];
      G[i] = G[c];
      S[i] = S[c];
      i = c;
    }
    F[i] = f;
    G[i] = g;
    S[i] = s;
  }
}

export class Searcher {
  private cap = 0;
  private gScore = new Float64Array(0);
  private stamp = new Uint32Array(0);
  private parent = new Int32Array(0);
  private seedOf = new Int32Array(0);
  private goalStamp = new Uint32Array(0);
  private goalOf = new Int32Array(0);
  private id = 0;
  private readonly heap = new MinHeap();
  /** Expansions in the last search (for perf tests). */
  lastPops = 0;

  /** Target sides for the heuristic: [ux, sgn, up, lo, hi] × up to 4. */
  private readonly targetBuf = new Float64Array(20);
  private zeroBuf = new Uint8Array(0);
  private zeros(n: number): Uint8Array {
    if (this.zeroBuf.length < n) this.zeroBuf = new Uint8Array(n);
    return this.zeroBuf;
  }

  private ensure(nodes: number): void {
    if (nodes * 4 <= this.cap) return;
    const cap = Math.max(nodes * 4, Math.ceil(this.cap * 1.5));
    this.cap = cap;
    this.gScore = new Float64Array(cap);
    this.stamp = new Uint32Array(cap);
    this.parent = new Int32Array(cap);
    this.seedOf = new Int32Array(cap);
    this.goalStamp = new Uint32Array(cap >> 2);
    this.goalOf = new Int32Array(cap >> 2);
    this.id = 0;
  }

  /**
   * `zones`: keep out of the anchor zones in front of card sides other lines
   * attach to (off for a last-ditch retry).
   */
  search(
    grid: Grid,
    seeds: readonly Port[],
    goals: readonly Port[],
    maxPops: number,
    zones = true,
    weight = HEURISTIC_WEIGHT,
    cross = CROSS,
  ): Found | null {
    const { xs, ys, nx, ny, hBlk, vBlk, hUse, vUse } = grid;
    // With zones off, read a zeroed array instead (one code path, no branch per move).
    const hZone = zones ? grid.hZone : this.zeros(nx * ny);
    const vZone = zones ? grid.vZone : this.zeros(nx * ny);
    // Zones close the grid (ZONE_COST < 0) or make it dear per px (the default).
    const zoneCost = ZONE_COST < 0 ? 0 : ZONE_COST;
    const zoneMask = ZONE_COST < 0 ? 0xff : 0;
    this.ensure(nx * ny);
    if (++this.id >= 0xfffffff0) {
      this.stamp.fill(0);
      this.goalStamp.fill(0);
      this.id = 1;
    }
    const id = this.id;
    const { gScore, stamp, parent, seedOf, goalStamp, goalOf, heap } = this;
    heap.clear();
    this.lastPops = 0;

    // Goals by node, and the target's sides for the heuristic (flat, for speed).
    const T = this.targetBuf;
    let nt = 0;
    for (let q = 0; q < goals.length; q++) {
      const gl = goals[q];
      const n = gl.node;
      if (goalStamp[n] !== id || gl.cost < goals[goalOf[n]].cost) {
        goalStamp[n] = id;
        goalOf[n] = q;
      }
      const ux = gl.orient === 0 ? 1 : 0;
      const sgn = gl.dir;
      let t = 0;
      while (t < nt && !(T[t * 5] === ux && T[t * 5 + 1] === sgn)) t++;
      if (t === nt) {
        T[t * 5] = ux;
        T[t * 5 + 1] = sgn;
        T[t * 5 + 2] = (ux ? gl.point.x : gl.point.y) * sgn;
        T[t * 5 + 3] = gl.c;
        T[t * 5 + 4] = gl.c;
        nt++;
      } else {
        if (gl.c < T[t * 5 + 3]) T[t * 5 + 3] = gl.c;
        if (gl.c > T[t * 5 + 4]) T[t * 5 + 4] = gl.c;
      }
    }
    const hw = weight;

    /** Lower bound from (x, y) heading hd: per target side, distance + BEND × fewest bends. */
    const h = (x: number, y: number, hd: number): number => {
      const horizontal = hd < 2 ? 1 : 0;
      const dsign = hd & 1 ? -1 : 1;
      let best = Infinity;
      for (let t = 0; t < nt; t++) {
        const o = t * 5;
        const ux = T[o];
        const sgn = T[o + 1];
        const up = T[o + 2];
        const lo = T[o + 3];
        const hi = T[o + 4];
        const u = (ux ? x : y) * sgn;
        const v = ux ? y : x;
        const ahead = u < up - 0.5;
        const dv = v < lo ? lo - v : v > hi ? v - hi : 0;
        let bends: number;
        if (horizontal === ux) {
          // Travelling along the approach axis: towards the card (+) or away (-).
          if (dsign * sgn > 0) bends = !ahead ? 4 : dv === 0 ? 0 : 2;
          else bends = 2;
        } else if (!ahead) bends = 3;
        else if (dv === 0) bends = 1;
        else bends = (v < lo && dsign > 0) || (v > hi && dsign < 0) ? 1 : 3;
        const cand = (up > u ? up - u : u - up) + dv + bends * BEND;
        if (cand < best) best = cand;
      }
      return best * hw;
    };

    for (let q = 0; q < seeds.length; q++) {
      const sd = seeds[q];
      const hd = headingOf(sd.orient, sd.dir);
      const s = sd.node * 4 + hd;
      if (stamp[s] === id && gScore[s] <= sd.cost) continue;
      stamp[s] = id;
      gScore[s] = sd.cost;
      parent[s] = -1;
      seedOf[s] = q;
      const i = sd.node % nx;
      heap.push(sd.cost + h(xs[i], ys[(sd.node - i) / nx], hd), s, sd.cost);
    }

    let pops = 0;
    let cur = 0;
    let curG = 0;
    let curH = 0;
    const relax = (
      n2: number,
      x2: number,
      y2: number,
      hd2: number,
      len: number,
      use: number,
      crossing: boolean,
      zone: number,
    ): void => {
      const cost =
        curG +
        len * (1 + SHARE * use + (zone ? zoneCost : 0)) +
        (hd2 >> 1 !== curH >> 1 ? BEND : 0) +
        (crossing ? cross : 0);
      const s2 = n2 * 4 + hd2;
      if (stamp[s2] === id && cost >= gScore[s2] - 1e-9) return;
      stamp[s2] = id;
      gScore[s2] = cost;
      parent[s2] = cur;
      heap.push(cost + h(x2, y2, hd2), s2, cost);
    };

    while (heap.size > 0) {
      heap.pop();
      const s = heap.topS;
      if (s < 0) {
        this.lastPops = pops;
        return this.build(-1 - s, seeds, goals, heap.topF);
      }
      const gv = heap.topG;
      if (gv > gScore[s] + 1e-9) continue;
      if (++pops > maxPops) {
        this.lastPops = pops;
        return null;
      }
      const n = s >> 2;
      const hd = s & 3;
      cur = s;
      curG = gv;
      curH = hd;

      if (goalStamp[n] === id) {
        const goal = goals[goalOf[n]];
        const want = headingOf(goal.orient, goal.dir);
        let total = -1;
        if (hd === want) total = gv + goal.cost;
        else if (hd >> 1 !== want >> 1) total = gv + BEND + goal.cost;
        if (total >= 0) heap.push(total, -1 - s, total);
      }

      const i = n % nx;
      const j = (n - i) / nx;
      const x = xs[i];
      const y = ys[j];
      // +x / -x: crossing a line that runs straight through the next node vertically.
      if (
        hd !== 1 &&
        i + 1 < nx &&
        hBlk[n] === 0 &&
        (hZone[n] & zoneMask) === 0
      ) {
        const n2 = n + 1;
        const x2 = xs[i + 1];
        relax(
          n2,
          x2,
          y,
          0,
          x2 - x,
          hUse[n],
          j > 0 && j + 1 < ny && vUse[n2] > 0 && vUse[n2 - nx] > 0,
          hZone[n],
        );
      }
      if (
        hd !== 0 &&
        i > 0 &&
        hBlk[n - 1] === 0 &&
        (hZone[n - 1] & zoneMask) === 0
      ) {
        const n2 = n - 1;
        const x2 = xs[i - 1];
        relax(
          n2,
          x2,
          y,
          1,
          x - x2,
          hUse[n2],
          j > 0 && j + 1 < ny && vUse[n2] > 0 && vUse[n2 - nx] > 0,
          hZone[n - 1],
        );
      }
      // +y / -y.
      if (
        hd !== 3 &&
        j + 1 < ny &&
        vBlk[n] === 0 &&
        (vZone[n] & zoneMask) === 0
      ) {
        const n2 = n + nx;
        const y2 = ys[j + 1];
        relax(
          n2,
          x,
          y2,
          2,
          y2 - y,
          vUse[n],
          i > 0 && i + 1 < nx && hUse[n2] > 0 && hUse[n2 - 1] > 0,
          vZone[n],
        );
      }
      if (
        hd !== 2 &&
        j > 0 &&
        vBlk[n - nx] === 0 &&
        (vZone[n - nx] & zoneMask) === 0
      ) {
        const n2 = n - nx;
        const y2 = ys[j - 1];
        relax(
          n2,
          x,
          y2,
          3,
          y - y2,
          vUse[n2],
          i > 0 && i + 1 < nx && hUse[n2] > 0 && hUse[n2 - 1] > 0,
          vZone[n - nx],
        );
      }
    }
    this.lastPops = pops;
    return null;
  }

  private build(
    goalState: number,
    seeds: readonly Port[],
    goals: readonly Port[],
    cost: number,
  ): Found {
    const nodes: number[] = [];
    let st = goalState;
    let seed = seeds[0];
    for (let guard = 0; guard < 1_000_000; guard++) {
      nodes.push(st >> 2);
      const p = this.parent[st];
      if (p < 0) {
        seed = seeds[this.seedOf[st]];
        break;
      }
      st = p;
    }
    nodes.reverse();
    const goal = goals[this.goalOf[goalState >> 2]];
    return { nodes, src: seed, tgt: goal, cost };
  }
}
