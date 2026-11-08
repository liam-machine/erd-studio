import { describe, expect, it } from 'vitest';
import { renderPaths, simplify, HOP_RADIUS, HALO_CUT_HALF, hopRadiusFor } from '../../src/lib/edgeRouting/render/pathRender';
import { findCrossings } from '../../src/lib/edgeRouting/render/crossings';
import { measurePath, poseAt } from '../../src/lib/pathGeometry';
import { pushOut } from '../../src/lib/edgeRouting/input';
import { PATH_GAP, type Point, type Rect, type RoutedLine, type Side } from '../../src/lib/edgeRouting/types';
import { scenarioRoutingInput } from '../fixtures/edgeRouting/scenarios';

const P = (x: number, y: number): Point => ({ x, y });

function line(points: Point[], extra: Partial<RoutedLine> = {}): RoutedLine {
  const first = points[0];
  const last = points[points.length - 1];
  return {
    sourceAnchor: { ...first, side: 'right' },
    targetAnchor: { ...last, side: 'left' },
    points,
    ...extra,
  };
}

function lines(entries: Record<string, RoutedLine>): Map<string, RoutedLine> {
  return new Map(Object.entries(entries));
}

const commands = (d: string) => d.match(/[MLHVQCZA]/g) ?? [];
const count = (d: string, c: string) => commands(d).filter((x) => x === c).length;

/** Every number pair in a path (end and control points). */
function coords(d: string): Point[] {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push({ x: nums[i], y: nums[i + 1] });
  return out;
}

/** Distance from p to the nearest point of the flattened path. */
function distToPath(d: string, p: Point): number {
  const g = measurePath(d);
  let best = Infinity;
  for (let i = 1; i < g.points.length; i++) {
    const a = g.points[i - 1];
    const b = g.points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
}

// A horizontal line and a vertical one crossing at (100, 100).
const cross = () =>
  lines({
    h: line([P(0, 100), P(200, 100)]),
    v: line([P(100, 0), P(100, 200)]),
  });

describe('simplify', () => {
  it('drops repeats and collinear midpoints but keeps a reversal', () => {
    expect(simplify([P(0, 0), P(0, 0), P(10, 0), P(20, 0), P(20, 10)])).toEqual([P(0, 0), P(20, 0), P(20, 10)]);
    expect(simplify([P(0, 0), P(20, 0), P(10, 0)])).toHaveLength(3);
  });
});

describe('findCrossings', () => {
  it('finds a proper crossing with the distance along each segment', () => {
    const c = findCrossings([[P(0, 100), P(200, 100)], [P(100, 0), P(100, 200)]]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ x: 100, y: 100 });
    expect(c[0].a.d).toBeCloseTo(100);
    expect(c[0].b.d).toBeCloseTo(100);
  });

  it('ignores touching ends, a corner on another line and collinear overlaps', () => {
    const none = (polys: Point[][]) => expect(findCrossings(polys)).toHaveLength(0);
    none([[P(0, 0), P(100, 0)], [P(100, 0), P(100, 100)]]); // shared end
    none([[P(0, 0), P(100, 0)], [P(50, 0), P(50, 100)]]); // T: an end on the other line
    none([[P(0, 0), P(100, 0)], [P(50, 0), P(150, 0)]]); // collinear overlap
    expect(findCrossings([[P(0, 0), P(100, 0)], [P(50, -50), P(50, 50)]])).toHaveLength(1);
  });
});

describe('renderPaths — hops', () => {
  it('the horizontal line hops the vertical one with a semicircle bulging up', () => {
    const out = renderPaths(cross(), { crossings: 'hops', corners: 'rounded' });
    const h = out.get('h')!.d;
    const v = out.get('v')!.d;
    expect(count(h, 'C')).toBe(2);
    expect(count(v, 'C')).toBe(0);
    expect(count(h, 'A')).toBe(0); // EdgeFlow cannot read arcs
    const ys = coords(h).map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(100 - HOP_RADIUS);
    expect(Math.max(...ys)).toBe(100);
    // Still one subpath of the same overall extent.
    expect(count(h, 'M')).toBe(1);
    const g = measurePath(h);
    expect(g.points[g.points.length - 1]).toEqual(P(200, 100));
    expect(g.length).toBeCloseTo(200 - 2 * HOP_RADIUS + Math.PI * HOP_RADIUS, 0);
  });

  it('the rule is by orientation, not by which line comes first', () => {
    const swapped = lines({ v: line([P(100, 0), P(100, 200)]), h: line([P(0, 100), P(200, 100)]) });
    const out = renderPaths(swapped, { crossings: 'hops', corners: 'rounded' });
    expect(count(out.get('h')!.d, 'C')).toBe(2);
    expect(count(out.get('v')!.d, 'C')).toBe(0);
  });

  it('merges crossings closer than a hop into one bridge', () => {
    const m = lines({
      h: line([P(0, 100), P(300, 100)]),
      v1: line([P(100, 0), P(100, 200)]),
      v2: line([P(107, 0), P(107, 200)]),
      v3: line([P(200, 0), P(200, 200)]),
    });
    const h = renderPaths(m, { crossings: 'hops', corners: 'rounded' }).get('h')!.d;
    // One bridge (C L C) over v1+v2 and one semicircle (C C) over v3.
    expect(count(h, 'C')).toBe(4);
    const tops = coords(h).filter((p) => Math.abs(p.y - (100 - HOP_RADIUS)) < 0.01);
    expect(tops.some((p) => Math.abs(p.x - (100 - HOP_RADIUS + HOP_RADIUS)) < 0.01)).toBe(true);
    expect(tops.some((p) => Math.abs(p.x - (107 + HOP_RADIUS - HOP_RADIUS)) < 0.01)).toBe(true);
  });

  it('no hop where either line is turning (a bridge over a corner reads as a knot)', () => {
    // h turns down at x=104, so the crossing at x=100 sits inside its corner.
    const m = lines({
      h: line([P(0, 100), P(104, 100), P(104, 300)]),
      v: line([P(100, 0), P(100, 200)]),
    });
    const out = renderPaths(m, { crossings: 'hops', corners: 'rounded' });
    expect(count(out.get('h')!.d, 'C')).toBe(0);
    expect(count(out.get('v')!.d, 'C')).toBe(0);
    // v turns just above the crossing: h stays flat too.
    const m2 = lines({
      h: line([P(0, 100), P(300, 100)]),
      v: line([P(100, 200), P(100, 92), P(200, 92)]),
    });
    expect(count(renderPaths(m2, { crossings: 'hops', corners: 'rounded' }).get('h')!.d, 'C')).toBe(0);
  });

  it('never hops at a line end (the card stub)', () => {
    const m = lines({ h: line([P(98, 100), P(300, 100)]), v: line([P(100, 0), P(100, 200)]) });
    const out = renderPaths(m, { crossings: 'hops', corners: 'rounded' });
    expect(count(out.get('h')!.d, 'C')).toBe(0);
    expect(count(out.get('v')!.d, 'C')).toBe(0);
  });

  it('a halo cut falls back to the other line when the under line has no room', () => {
    // v ends 4px below the crossing (its stub): no room to break it, so h breaks instead.
    const m = lines({ h: line([P(0, 100), P(300, 100)]), v: line([P(100, 0), P(100, 104)]) });
    const out = renderPaths(m, { crossings: 'halo', corners: 'rounded' });
    expect(out.get('v')!.strokeD).toBeUndefined();
    expect(out.get('h')!.strokeD).toBeUndefined(); // h is fine, but v is not straight across the gap either
    const m2 = lines({ h: line([P(0, 100), P(300, 100)]), v: line([P(100, 0), P(100, 106)]) });
    const out2 = renderPaths(m2, { crossings: 'halo', corners: 'rounded' });
    expect(out2.get('v')!.strokeD).toBeUndefined();
    expect(count(out2.get('h')!.strokeD!, 'M')).toBe(2);
  });

});

describe('renderPaths — the halo cut', () => {
  it('breaks the vertical line in strokeD, keeps d continuous, leaves the horizontal whole', () => {
    const out = renderPaths(cross(), { crossings: 'halo', corners: 'rounded' });
    const h = out.get('h')!;
    const v = out.get('v')!;
    expect(h.strokeD).toBeUndefined();
    expect(count(v.d, 'M')).toBe(1);
    expect(measurePath(v.d).length).toBeCloseTo(200);
    expect(v.strokeD).toBeDefined();
    expect(count(v.strokeD!, 'M')).toBe(2);
    expect(v.strokeD).toContain(`L 100,${100 - HALO_CUT_HALF} M 100,${100 + HALO_CUT_HALF}`);
  });

  it('no strokeD on a line with no crossing', () => {
    const out = renderPaths(lines({ a: line([P(0, 0), P(100, 0)]) }), { crossings: 'halo', corners: 'rounded' });
    expect(out.get('a')!.strokeD).toBeUndefined();
  });
});

describe('renderPaths — halo and none', () => {
  it('halo flags every line, draws no hop, and cuts the under line so paint order cannot decide', () => {
    for (const input of [cross(), new Map([...cross()].reverse())]) {
      const out = renderPaths(input, { crossings: 'halo', corners: 'rounded' });
      for (const r of out.values()) {
        expect(r.halo).toBe(true);
        expect(count(r.d, 'C')).toBe(0);
      }
      // The horizontal goes over (as with hops), whichever line comes first.
      expect(out.get('h')!.strokeD).toBeUndefined();
      expect(out.get('v')!.strokeD).toBe(`M 100,0 L 100,${100 - HALO_CUT_HALF} M 100,${100 + HALO_CUT_HALF} L 100,200`);
      expect(measurePath(out.get('v')!.d).length).toBeCloseTo(200);
      expect(commands(out.get('v')!.d).filter((c) => c === 'M')).toHaveLength(1);
    }
    const none = renderPaths(cross(), { crossings: 'none', corners: 'rounded' });
    for (const r of none.values()) expect(r.halo).toBeUndefined();
  });
});

describe('renderPaths — corners', () => {
  const step = lines({ s: line([P(0, 0), P(60, 0), P(60, 200), P(120, 200)]) });

  it('sharp keeps the vertices, rounded uses 8px quadratics', () => {
    expect(renderPaths(step, { crossings: 'none', corners: 'sharp' }).get('s')!.d).toBe('M 0,0 L 60,0 L 60,200 L 120,200');
    const r = renderPaths(step, { crossings: 'none', corners: 'rounded' }).get('s')!.d;
    expect(r).toBe('M 0,0 L 52,0 Q 60,0 60,8 L 60,192 Q 60,200 68,200 L 120,200');
  });

  it('curved is one smooth S that leaves and enters along the stub segments', () => {
    const d = renderPaths(step, { crossings: 'none', corners: 'curved' }).get('s')!.d;
    expect(count(d, 'C')).toBe(2);
    const g = measurePath(d);
    // Leaves along +x, arrives along +x.
    expect(poseAt(g, 0.001).angle).toBeCloseTo(0, 0);
    expect(poseAt(g, 0.999).angle).toBeCloseTo(0, 0);
    expect(g.points[g.points.length - 1]).toEqual(P(120, 200));
    // Smooth: the heading never jumps between consecutive chords.
    for (let i = 2; i < g.points.length; i++) {
      const a = Math.atan2(g.points[i - 1].y - g.points[i - 2].y, g.points[i - 1].x - g.points[i - 2].x);
      const b = Math.atan2(g.points[i].y - g.points[i - 1].y, g.points[i].x - g.points[i - 1].x);
      expect(Math.abs(b - a)).toBeLessThan(0.5);
    }
    // Never swings outside the route's box.
    for (const p of g.points) {
      expect(p.x).toBeGreaterThanOrEqual(-0.01);
      expect(p.x).toBeLessThanOrEqual(120.01);
    }
  });

  it('curved tightens a corner that would cut into a card', () => {
    // The route hugs a card's top-right corner with 10px clearance.
    const card: Rect = { id: 'c', x: 0, y: 110, width: 190, height: 200, kind: 'model' };
    const m = lines({ s: line([P(0, 100), P(200, 100), P(200, 400)]) });
    const loose = measurePath(renderPaths(m, { crossings: 'none', corners: 'curved' }).get('s')!.d);
    const tight = measurePath(renderPaths(m, { crossings: 'none', corners: 'curved', obstacles: [card] }).get('s')!.d);
    const inside = (p: Point) => p.x > card.x && p.x < card.x + card.width && p.y > card.y && p.y < card.y + card.height;
    expect(loose.points.some(inside)).toBe(true);
    expect(tight.points.some(inside)).toBe(false);
  });
});

describe('renderPaths — mid', () => {
  it('is on the drawn path and off the hop', () => {
    const out = renderPaths(cross(), { crossings: 'hops', corners: 'rounded' });
    const h = out.get('h')!;
    expect(distToPath(h.d, h.mid)).toBeLessThan(0.5);
    expect(Math.abs(h.mid.x - 100)).toBeGreaterThanOrEqual(HOP_RADIUS);
    expect(h.mid.y).toBe(100);
    const v = out.get('v')!;
    expect(Math.hypot(v.mid.x - 100, v.mid.y - 100)).toBeGreaterThan(10);
  });

  it('is on the curve even when the middle of the route is a corner', () => {
    const m = lines({ s: line([P(0, 0), P(40, 0), P(40, 40)]) });
    const r = renderPaths(m, { crossings: 'none', corners: 'curved' }).get('s')!;
    expect(distToPath(r.d, r.mid)).toBeLessThan(0.75);
  });

  it('is half way on a plain line', () => {
    const r = renderPaths(lines({ a: line([P(0, 0), P(100, 0)]) }), { crossings: 'none', corners: 'rounded' }).get('a')!;
    expect(r.mid).toEqual(P(50, 0));
  });
});

// A simple stand-in router (out of the stub, across at the middle, in) over
// the 'big' scenario's anchors: the perf budget is for the renderer alone.
function zRoutes(name: string): Map<string, RoutedLine> {
  const input = scenarioRoutingInput(name);
  const out = new Map<string, RoutedLine>();
  const horiz = (s: Side) => s === 'left' || s === 'right';
  for (const e of input.edges) {
    if (e.isSelfLoop) continue;
    const a = pushOut(e.sourceAnchor, e.sourceAnchor.side, PATH_GAP);
    const b = pushOut(e.targetAnchor, e.targetAnchor.side, PATH_GAP);
    const pts = horiz(e.sourceAnchor.side)
      ? [a, P((a.x + b.x) / 2, a.y), P((a.x + b.x) / 2, b.y), b]
      : [a, P(a.x, (a.y + b.y) / 2), P(b.x, (a.y + b.y) / 2), b];
    out.set(e.id, { sourceAnchor: e.sourceAnchor, targetAnchor: e.targetAnchor, points: pts });
  }
  return out;
}

/** Z-shaped routes between each edge's stubs (pushed-out anchors), for any input. */
function zRoutesOf(input: RoutingInput): Map<string, RoutedLine> {
  const out = new Map<string, RoutedLine>();
  for (const e of input.edges) {
    const a = pushOut(e.sourceAnchor, e.sourceAnchor.side, PATH_GAP);
    const b = pushOut(e.targetAnchor, e.targetAnchor.side, PATH_GAP);
    const horizontal = e.sourceAnchor.side === 'left' || e.sourceAnchor.side === 'right';
    const pts = horizontal
      ? [a, P((a.x + b.x) / 2, a.y), P((a.x + b.x) / 2, b.y), b]
      : [a, P(a.x, (a.y + b.y) / 2), P(b.x, (a.y + b.y) / 2), b];
    out.set(e.id, { sourceAnchor: e.sourceAnchor, targetAnchor: e.targetAnchor, points: pts });
  }
  return out;
}

describe('renderPaths — performance', () => {
  it('renders the big scenario in well under 3 ms', () => {
    const routes = zRoutes('big');
    expect(routes.size).toBeGreaterThan(40);
    const timings: Record<string, number> = {};
    for (const crossings of ['hops', 'halo'] as const) {
      for (const corners of ['rounded', 'curved'] as const) {
        const obstacles = scenarioRoutingInput('big').obstacles;
        for (let i = 0; i < 20; i++) renderPaths(routes, { crossings, corners, obstacles }); // warm up
        const runs: number[] = [];
        for (let i = 0; i < 60; i++) {
          const t0 = performance.now();
          renderPaths(routes, { crossings, corners, obstacles });
          runs.push(performance.now() - t0);
        }
        runs.sort((p, q) => p - q);
        timings[`${crossings}/${corners}`] = runs[Math.floor(runs.length / 2)];
      }
    }
    // eslint-disable-next-line no-console
    console.log('renderPaths big (median ms)', JSON.stringify(timings));
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(3);
  });

  it('every path in every scenario parses as one subpath to its end', () => {
    for (const name of ['under', 'star', 'tangle', 'showcase', 'big', 'overlap']) {
      const routes = zRoutes(name);
      for (const crossings of ['hops', 'halo'] as const) {
        for (const corners of ['rounded', 'curved', 'sharp'] as const) {
          const out = renderPaths(routes, { crossings, corners });
          for (const [id, r] of out) {
            const pts = routes.get(id)!.points;
            const g = measurePath(r.d);
            const end = g.points[g.points.length - 1];
            expect(Math.hypot(end.x - pts[pts.length - 1].x, end.y - pts[pts.length - 1].y)).toBeLessThan(0.02);
            expect(Number.isFinite(r.mid.x) && Number.isFinite(r.mid.y)).toBe(true);
            expect(distToPath(r.d, r.mid)).toBeLessThan(1);
          }
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial (second review)
// ---------------------------------------------------------------------------

import { createAvoidRouter } from '../../src/lib/edgeRouting/routers/orthogonalAvoid';
import type { EdgeSpec, RoutingInput } from '../../src/lib/edgeRouting/types';

/** Real routes for a layout: the route-around router, from scratch. */
const routeAround = (input: RoutingInput) => createAvoidRouter().route(input).lines;

const ALL_MODES = (['none', 'hops', 'halo'] as const).flatMap((crossings) =>
  (['rounded', 'curved', 'sharp'] as const).map((corners) => ({ crossings, corners })),
);

/** Seeded PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n cards on a jittered grid (some overlapping), m lines between random pairs, anchors facing each other. */
function randomInput(cards: number, edgesN: number, seed: number, local = false): RoutingInput {
  const r = rng(seed);
  const obstacles: Rect[] = [];
  const cols = Math.ceil(Math.sqrt(cards));
  for (let i = 0; i < cards; i++) {
    obstacles.push({
      id: `t${i}`,
      x: (i % cols) * 330 + (r() - 0.5) * 140,
      y: Math.floor(i / cols) * 340 + (r() - 0.5) * 160,
      width: 260,
      height: 60 + Math.floor(r() * 300),
      kind: 'model',
    });
  }
  const edges: EdgeSpec[] = [];
  const sides: Side[] = ['top', 'right', 'bottom', 'left'];
  const anchorOn = (rect: Rect, side: Side, t: number) => {
    switch (side) {
      case 'top': return { x: rect.x + rect.width * t, y: rect.y, side };
      case 'bottom': return { x: rect.x + rect.width * t, y: rect.y + rect.height, side };
      case 'left': return { x: rect.x, y: rect.y + rect.height * t, side };
      case 'right': return { x: rect.x + rect.width, y: rect.y + rect.height * t, side };
    }
  };
  for (let i = 0; i < edgesN; i++) {
    const ai = Math.floor(r() * cards);
    const a = obstacles[ai];
    // local: the other end is within two grid cells, as in a real ERD.
    let b = local
      ? obstacles[Math.min(cards - 1, Math.max(0, ai + Math.round((r() - 0.5) * 4) + cols * Math.round((r() - 0.5) * 4)))]
      : obstacles[Math.floor(r() * cards)];
    if (b === a) b = obstacles[(obstacles.indexOf(a) + 1) % cards];
    edges.push({
      id: `e${String(i).padStart(3, '0')}`,
      source: a.id,
      target: b.id,
      sourceAnchor: anchorOn(a, sides[Math.floor(r() * 4)], 0.1 + r() * 0.8),
      targetAnchor: anchorOn(b, sides[Math.floor(r() * 4)], 0.1 + r() * 0.8),
      isSelfLoop: false,
      loopIndex: 0,
      cardinality: 'many-to-one',
    });
  }
  return { obstacles, edges };
}

/** Each `M` subpath of a path, as its own path string. */
const subpaths = (d: string) => d.split(/(?=M )/).map((s) => s.trim()).filter(Boolean);

function assertSound(lines: Map<string, RoutedLine>, out: Map<string, ReturnType<typeof renderPaths> extends Map<string, infer V> ? V : never>) {
  for (const [id, r] of out) {
    const pts = simplify(lines.get(id)!.points);
    expect(r.d, id).not.toMatch(/NaN|Infinity|undefined/);
    expect(r.strokeD ?? '', id).not.toMatch(/NaN|Infinity|undefined/);
    expect(commands(r.d).filter((c) => c === 'M'), id).toHaveLength(1);
    expect(r.d).not.toMatch(/ A /);
    const g = measurePath(r.d);
    const start = g.points[0];
    const end = g.points[g.points.length - 1];
    // Every line still reaches both its anchors' stub points.
    expect(Math.hypot(start.x - pts[0].x, start.y - pts[0].y), id).toBeLessThan(0.02);
    expect(Math.hypot(end.x - pts[pts.length - 1].x, end.y - pts[pts.length - 1].y), id).toBeLessThan(0.02);
    expect(Number.isFinite(r.mid.x) && Number.isFinite(r.mid.y), id).toBe(true);
    if (pts.length >= 2) expect(distToPath(r.d, r.mid), id).toBeLessThan(1);
    if (r.strokeD) {
      // Each piece of the broken stroke is itself readable, and the pieces add up to less than d.
      const pieces = subpaths(r.strokeD);
      let total = 0;
      for (const s of pieces) total += measurePath(s).length;
      // Each break is at least 2 × HALO_CUT_HALF; close crossings merge into a longer one.
      expect(pieces.length, id).toBeGreaterThan(1);
      expect(total, id).toBeLessThan(g.length - 2 * HALO_CUT_HALF * (pieces.length - 1) + 0.5);
    }
  }
}

describe('renderPaths — adversarial', () => {
  it('stays NaN-free and reaches every anchor on 100 cards / 200 lines in every mode, fast', () => {
    // Router-independent routes (the routers are still changing): Z-shapes between the stubs.
    const input = randomInput(100, 200, 7, true);
    const routes = zRoutesOf(input);
    expect(routes.size).toBe(200);
    const timings: Record<string, number> = {};
    for (const mode of ALL_MODES) {
      const opts = { ...mode, obstacles: input.obstacles };
      const out = renderPaths(routes, opts);
      expect(out.size).toBe(200);
      assertSound(routes, out);
      for (let i = 0; i < 5; i++) renderPaths(routes, opts);
      const runs: number[] = [];
      for (let i = 0; i < 15; i++) {
        const t0 = performance.now();
        renderPaths(routes, opts);
        runs.push(performance.now() - t0);
      }
      // The fastest of 15 runs: the cost of the work itself. The full suite
      // runs test files in parallel, so a median or quartile also measures
      // the other workers (a lower quartile under 4 ms flaked there); one
      // uncontended run in 15 is enough to show the work fits in a frame.
      timings[`${mode.crossings}/${mode.corners}`] = Math.min(...runs);
    }
    // eslint-disable-next-line no-console
    console.log('renderPaths 100 cards / 200 lines (fastest of 15, ms)', JSON.stringify(timings));
    // ~1.5 ms for the two shipped styles on a dev Mac; CI machines get slack.
    const slack = process.env.CI ? 3 : 1;
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(4 * slack);
  });

  it('stays inside a frame even when 200 lines cross each other thousands of times', () => {
    const input = randomInput(100, 200, 7);
    const routes = zRoutesOf(input);
    for (const crossings of ['hops', 'halo'] as const) {
      const opts = { crossings, corners: 'curved' as const, obstacles: input.obstacles };
      for (let i = 0; i < 3; i++) renderPaths(routes, opts);
      const runs: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t0 = performance.now();
        renderPaths(routes, opts);
        runs.push(performance.now() - t0);
      }
      runs.sort((p, q) => p - q);
      expect(runs[2], crossings).toBeLessThan(16);
    }
  });

  it('random layouts (overlapping cards, same-side anchors) are sound in every mode', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const input = randomInput(14, 24, seed);
      const routes = routeAround(input);
      for (const mode of ALL_MODES) assertSound(routes, renderPaths(routes, { ...mode, obstacles: input.obstacles }));
    }
  });

  it('is deterministic and does not depend on the order the lines arrive in', () => {
    const input = randomInput(30, 60, 3);
    const routes = routeAround(input);
    const reversed = new Map([...routes].reverse());
    for (const mode of ALL_MODES) {
      const opts = { ...mode, obstacles: input.obstacles };
      const a = renderPaths(routes, opts);
      const b = renderPaths(routes, opts);
      const c = renderPaths(reversed, opts);
      for (const [id, r] of a) {
        expect(b.get(id)).toEqual(r);
        expect(c.get(id), `${mode.crossings}/${mode.corners} ${id}`).toEqual(r);
      }
    }
  });

  it('degenerate lines: one point, a zero-length line, repeats, two identical lines, huge and tiny coords', () => {
    const out = renderPaths(
      lines({
        one: line([P(5, 5)]),
        zero: line([P(5, 5), P(5, 5)]),
        repeats: line([P(0, 0), P(0, 0), P(50, 0), P(50, 0), P(50, 50)]),
        twinA: line([P(0, 300), P(100, 300), P(100, 400)]),
        twinB: line([P(0, 300), P(100, 300), P(100, 400)]),
        huge: line([P(1e7, 1e7), P(1e7 + 500, 1e7), P(1e7 + 500, 1e7 + 500)]),
        tiny: line([P(0, 0), P(0.3, 0), P(0.3, 0.3)]),
        back: line([P(0, 600), P(100, 600), P(40, 600)]),
      }),
      { crossings: 'hops', corners: 'curved' },
    );
    for (const [id, r] of out) {
      expect(r.d, id).not.toMatch(/NaN|Infinity/);
      expect(Number.isFinite(r.mid.x) && Number.isFinite(r.mid.y), id).toBe(true);
    }
    expect(out.get('twinA')).toEqual(out.get('twinB'));
    expect(out.get('huge')!.d.startsWith('M 10000000,10000000')).toBe(true);
  });

  it('a line with a non-finite point is left out (it keeps the fallback path) rather than drawn as NaN', () => {
    const out = renderPaths(
      lines({
        bad: line([P(0, 0), P(NaN, 50), P(100, 100)]),
        inf: line([P(0, 0), P(Infinity, 0)]),
        good: line([P(0, 200), P(200, 200)]),
      }),
      { crossings: 'hops', corners: 'rounded' },
    );
    expect(out.has('bad')).toBe(false);
    expect(out.has('inf')).toBe(false);
    expect(out.get('good')!.d).toBe('M 0,200 L 200,200');
  });

  it('a hop or curve never strays far from the routed polyline', () => {
    const input = randomInput(20, 40, 11);
    const routes = routeAround(input);
    for (const mode of ALL_MODES) {
      const out = renderPaths(routes, { ...mode, obstacles: input.obstacles });
      const limit = mode.corners === 'curved' ? 13 : HOP_RADIUS + 0.5;
      for (const [id, r] of out) {
        const poly = 'M ' + simplify(routes.get(id)!.points).map((p) => `${p.x},${p.y}`).join(' L ');
        for (const p of measurePath(r.d).points) expect(distToPath(poly, p), id).toBeLessThan(limit);
      }
    }
  });
});

/** The smallest crossing keep-out (px) round the label point (a vertical run). */
const MID_CLEAR_MIN = 16;

describe('renderPaths — crossings on the drawn curve', () => {
  // A curved corner at (100, 0): drawn from (60, 0) round to (100, 40).
  const corner = () => line([P(0, 0), P(100, 0), P(100, 100)]);

  it('breaks a straight line where the drawn curve crosses it, not where the polyline would', () => {
    for (const crossings of ['halo'] as const) {
      const out = renderPaths(lines({ c: corner(), v: line([P(90, -50), P(90, 100)]) }), { crossings, corners: 'curved' });
      expect(out.get('c')!.strokeD).toBeUndefined(); // the curve goes over
      const pieces = subpaths(out.get('v')!.strokeD!);
      expect(pieces).toHaveLength(2);
      const gapTop = measurePath(pieces[0]).points.at(-1)!;
      const gapBottom = measurePath(pieces[1]).points[0];
      const centre = P((gapTop.x + gapBottom.x) / 2, (gapTop.y + gapBottom.y) / 2);
      // On the drawn curve (about y = 13.5), well clear of the polyline's corner at y = 0.
      expect(distToPath(out.get('c')!.d, centre)).toBeLessThan(1);
      expect(centre.y).toBeGreaterThan(8);
    }
  });

  it('no break where only the polyline crosses (the curve cuts inside the corner)', () => {
    const out = renderPaths(lines({ c: corner(), v: line([P(98, -50), P(98, 5)]) }), { crossings: 'halo', corners: 'curved' });
    for (const r of out.values()) expect(r.strokeD).toBeUndefined();
  });

  it('hops: the crossing wins — the curve tightens so the crossing is straight and bridged', () => {
    const out = renderPaths(lines({ c: corner(), v: line([P(90, -50), P(90, 100)]) }), { crossings: 'hops', corners: 'curved' });
    // The vertical line passes under: drawn straight, no bridge on it.
    expect(count(out.get('v')!.d, 'C')).toBe(0);
    // The horizontal line bridges it at x = 90: its top sits a hop radius above y = 0.
    const top = measurePath(out.get('c')!.d).points.reduce((m, p) => (p.y < m.y ? p : m));
    expect(top.x).toBeCloseTo(90, 0);
    expect(top.y).toBeLessThan(-HOP_RADIUS + 0.5);
    // The label keeps off the crossing (now at y = 0, on the polyline).
    const mid = out.get('v')!.mid;
    expect(Math.abs(mid.y)).toBeGreaterThan(MID_CLEAR_MIN - 1);
  });

  it('hops get bigger in flow px as the canvas zooms out, within limits', () => {
    expect(hopRadiusFor(1)).toBe(HOP_RADIUS);
    expect(hopRadiusFor(2)).toBe(HOP_RADIUS);
    expect(hopRadiusFor(0.5)).toBeCloseTo(12);
    expect(hopRadiusFor(0.1)).toBe(14);
    expect(hopRadiusFor(Number.NaN)).toBe(HOP_RADIUS);
  });
});
