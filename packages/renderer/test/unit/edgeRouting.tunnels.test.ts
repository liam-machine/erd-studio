import { describe, it, expect } from 'vitest';
import { computeTunnels, MERGE_GAP, BORDER_HUG } from '../../src/lib/edgeRouting/render/tunnels';
import { routeAll } from '../../src/lib/edgeRouting';
import { PATH_GAP, type EdgeSpec, type LineStyleOptions, type Point, type Rect, type RoutedLine, type RoutingInput } from '../../src/lib/edgeRouting/types';
import { pushOut } from '../../src/lib/edgeRouting/input';
import { scenarioRoutingInput, SCENARIO_NAMES, zRouter } from '../fixtures/edgeRouting/scenarios';

const rect = (id: string, x: number, y: number, width: number, height: number, kind: Rect['kind'] = 'model'): Rect => ({
  id, x, y, width, height, kind,
});

const line = (...points: [number, number][]): RoutedLine => ({
  sourceAnchor: { x: points[0][0], y: points[0][1], side: 'right' },
  targetAnchor: { x: points[points.length - 1][0], y: points[points.length - 1][1], side: 'left' },
  points: points.map(([x, y]) => ({ x, y })),
});

const spec: EdgeSpec = {
  id: 'e', source: 'a', target: 'b',
  sourceAnchor: { x: 0, y: 0, side: 'right' }, targetAnchor: { x: 0, y: 0, side: 'left' },
  isSelfLoop: false, loopIndex: 0, cardinality: 'many-to-one',
};

const round = (poly: Point[]) => poly.map((p) => [Math.round(p.x), Math.round(p.y)]);

describe('computeTunnels', () => {
  it('returns nothing when the line misses every card', () => {
    expect(computeTunnels(line([0, 50], [100, 50]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
  });

  it('clips a straight line through a card to the card (less the border tolerance)', () => {
    const t = computeTunnels(line([0, 50], [500, 50]), spec, [rect('c', 200, 0, 100, 100)]);
    expect(t).toHaveLength(1);
    expect(round(t[0])).toEqual([[201, 50], [299, 50]]);
  });

  it('keeps the corners of a line that turns under a card', () => {
    // Out right, down under the card, out right again.
    const t = computeTunnels(line([0, 20], [150, 20], [150, 180], [400, 180]), spec, [rect('c', 100, 0, 100, 200)]);
    expect(t).toHaveLength(1);
    expect(round(t[0])).toEqual([[101, 20], [150, 20], [150, 180], [199, 180]]);
  });

  it('gives one tunnel per card the line passes under', () => {
    const t = computeTunnels(line([0, 50], [800, 50]), spec, [rect('c1', 100, 0, 100, 100), rect('c2', 400, 0, 100, 100)]);
    expect(t.map(round)).toEqual([[[101, 50], [199, 50]], [[401, 50], [499, 50]]]);
  });

  it('merges overlapping cards and cards a few px apart into one tunnel', () => {
    const overlapping = computeTunnels(line([0, 50], [800, 50]), spec, [rect('c1', 100, 0, 200, 100), rect('c2', 250, 0, 200, 100)]);
    expect(overlapping.map(round)).toEqual([[[101, 50], [449, 50]]]);
    const nearlyTouching = computeTunnels(line([0, 50], [800, 50]), spec, [rect('c1', 100, 0, 100, 100), rect('c2', 204, 0, 100, 100)]);
    expect(nearlyTouching.map(round)).toEqual([[[101, 50], [303, 50]]]);
    const apart = computeTunnels(line([0, 50], [800, 50]), spec, [rect('c1', 100, 0, 100, 100), rect('c2', 200 + MERGE_GAP + 4, 0, 100, 100)]);
    expect(apart).toHaveLength(2);
  });

  it('ignores a line running along a border or grazing a corner', () => {
    // Parallel and a few px inside a border: along it, not under the card.
    expect(computeTunnels(line([0, 3], [500, 3]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    expect(computeTunnels(line([204, -50], [204, 150]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    expect(computeTunnels(line([0, 3 + BORDER_HUG], [500, 3 + BORDER_HUG]), spec, [rect('c', 200, 0, 100, 100)])).toHaveLength(1);
    expect(computeTunnels(line([0, 0], [500, 0]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    expect(computeTunnels(line([0, 100.5], [500, 100.5]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    // A short clip of a corner (under MIN_TUNNEL) is not a tunnel.
    expect(computeTunnels(line([195, 3], [203, 3], [203, -20]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
  });

  it('counts sticky notes and the line\'s own cards like any other card', () => {
    const note = computeTunnels(line([0, 50], [500, 50]), spec, [rect('n', 200, 0, 100, 100, 'annotation')]);
    expect(note).toHaveLength(1);
    // A line that doubles back across its own source card ('a').
    const own = computeTunnels(line([320, 50], [340, 50], [340, 150], [-40, 150], [-40, 300]), spec, [rect('a', 0, 0, 300, 200)]);
    expect(round(own[0])).toEqual([[299, 150], [1, 150]]);
  });

  it('starts a tunnel at the line\'s end when that end is inside another card', () => {
    const t = computeTunnels(line([150, 50], [500, 50]), spec, [rect('c', 100, 0, 100, 100)]);
    expect(round(t[0])).toEqual([[150, 50], [199, 50]]);
  });

  it('drops the hook at a line\'s end that is only under its own two cards (cards nearly touching)', () => {
    // 'a' above 'b', 8 px apart: the stub below 'a' starts inside 'b', hooks round and comes back up.
    const a = rect('a', 0, 0, 200, 100);
    const b = rect('b', 0, 108, 200, 100);
    const hook = line([100, 120], [100, 140], [150, 140], [150, 88]);
    expect(computeTunnels(hook, spec, [a, b])).toEqual([]);
    // The same stretch under a third card is kept.
    expect(computeTunnels(hook, spec, [a, rect('c', 0, 108, 200, 100)])).toHaveLength(1);
    // Without a spec (no idea which cards are its own), it is kept.
    expect(computeTunnels(hook, undefined, [a, b])).toHaveLength(1);
  });

  it('handles a diagonal segment', () => {
    const t = computeTunnels(line([0, 0], [400, 400]), spec, [rect('c', 100, 100, 200, 200)]);
    expect(round(t[0])).toEqual([[101, 101], [299, 299]]);
  });
});

describe('x-ray through routeAll', () => {
  it('finds lines under cards in the "under" scenario with lines that ignore the cards', () => {
    const input = scenarioRoutingInput('under');
    const result = routeAll(input, { crossings: 'none', underTables: 'xray', corners: 'rounded' }, { router: zRouter });
    const withTunnels = [...result.edges.values()].filter((e) => e.tunnels?.length);
    expect(withTunnels.length).toBeGreaterThan(0);
  });

  it('draws no tunnels when x-ray is off', () => {
    const input = scenarioRoutingInput('under');
    const result = routeAll(input, { crossings: 'none', underTables: 'hidden', corners: 'rounded' }, { router: zRouter });
    expect([...result.edges.values()].some((e) => e.tunnels)).toBe(false);
  });

  it('every tunnel lies inside some card', () => {
    for (const name of SCENARIO_NAMES) {
      const input = scenarioRoutingInput(name);
      const result = routeAll(input, { crossings: 'none', underTables: 'xray', corners: 'rounded' }, { router: zRouter });
      for (const e of result.edges.values()) {
        for (const t of e.tunnels ?? []) {
          const mid = { x: (t[0].x + t[1].x) / 2, y: (t[0].y + t[1].y) / 2 };
          const inside = input.obstacles.some((o) => mid.x > o.x && mid.x < o.x + o.width && mid.y > o.y && mid.y < o.y + o.height);
          expect(inside, `${name}: ${e.sourceAnchor.x},${e.sourceAnchor.y}`).toBe(true);
        }
      }
    }
  });

  it('is cheap enough to run every frame of a drag on the big scenario', () => {
    const input = scenarioRoutingInput('big');
    const result = routeAll(input, { crossings: 'none', underTables: 'hidden', corners: 'rounded' }, { router: zRouter });
    const lines = [...result.edges.entries()];
    const specs = new Map(input.edges.map((e) => [e.id, e]));
    const runs = 200;
    const t0 = performance.now();
    let count = 0;
    for (let i = 0; i < runs; i++) {
      for (const [id, l] of lines) count += computeTunnels(l, specs.get(id), input.obstacles).length;
    }
    const perPass = (performance.now() - t0) / runs;
    // eslint-disable-next-line no-console
    console.log(`[tunnels perf] big: ${lines.length} lines × ${input.obstacles.length} cards, ${(count / runs).toFixed(0)} tunnels, ${perPass.toFixed(3)} ms per pass`);
    expect(perPass).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: what a second reviewer threw at it.
// ---------------------------------------------------------------------------

const XRAY: LineStyleOptions = { crossings: 'halo', underTables: 'xray', corners: 'rounded' };
const Z = { router: zRouter };

/** Every point of every tunnel is a finite number. */
const allFinite = (tunnels: Point[][] | undefined) => (tunnels ?? []).every((t) => t.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

/** Distance from p to the polyline. */
function distToPolyline(p: Point, pts: Point[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return best;
}

/** A seeded PRNG (mulberry32) so the stress diagram is the same every run. */
function prng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `cards` cards on a jittered grid (some overlapping), `lines` lines between random pairs, today's handle sides. */
function stressInput(cards: number, lines: number, seed = 7): RoutingInput {
  const rnd = prng(seed);
  const obstacles: Rect[] = [];
  const cols = Math.ceil(Math.sqrt(cards));
  for (let i = 0; i < cards; i++) {
    const h = 60 + Math.floor(rnd() * 440);
    obstacles.push(rect(`t${i}`, (i % cols) * 330 + Math.floor(rnd() * 120 - 60), Math.floor(i / cols) * 420 + Math.floor(rnd() * 120 - 60), 260, h));
  }
  const centre = (r: Rect) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < lines; i++) {
    const s = obstacles[Math.floor(rnd() * cards)];
    let t = obstacles[Math.floor(rnd() * cards)];
    if (t === s) t = obstacles[(obstacles.indexOf(s) + 1) % cards];
    const cs = centre(s);
    const ct = centre(t);
    const horizontal = Math.abs(ct.x - cs.x) > Math.abs(ct.y - cs.y);
    const sSide = horizontal ? (ct.x > cs.x ? 'right' : 'left') : ct.y > cs.y ? 'bottom' : 'top';
    const tSide = horizontal ? (ct.x > cs.x ? 'left' : 'right') : ct.y > cs.y ? 'top' : 'bottom';
    const slot = (r: Rect, side: EdgeSpec['sourceAnchor']['side']) => {
      const f = 0.2 + rnd() * 0.6;
      if (side === 'left') return { x: r.x, y: r.y + r.height * f, side };
      if (side === 'right') return { x: r.x + r.width, y: r.y + r.height * f, side };
      if (side === 'top') return { x: r.x + r.width * f, y: r.y, side };
      return { x: r.x + r.width * f, y: r.y + r.height, side };
    };
    edges.push({
      id: `e${i}`, source: s.id, target: t.id,
      sourceAnchor: slot(s, sSide), targetAnchor: slot(t, tSide),
      isSelfLoop: false, loopIndex: 0, cardinality: 'many-to-one',
    });
  }
  return { obstacles, edges };
}

describe('computeTunnels — adversarial', () => {
  it('never returns NaN for NaN / infinite points or boxes', () => {
    const c = rect('c', 200, 0, 100, 100);
    expect(computeTunnels(line([0, 50], [NaN, 50], [500, 50]), spec, [c])).toEqual([]);
    expect(computeTunnels(line([0, 50], [Infinity, 50]), spec, [c])).toEqual([]);
    expect(computeTunnels(line([0, 50], [500, 50]), spec, [rect('n', NaN, 0, 100, 100)])).toEqual([]);
    expect(computeTunnels(line([0, 50], [500, 50]), spec, [rect('n', -Infinity, -Infinity, Infinity, Infinity)])).toEqual([]);
    expect(computeTunnels(line([0, 50], [500, 50]), spec, [rect('n', 0, 0, NaN, 100)])).toEqual([]);
  });

  it('ignores zero-size and negative-size boxes, and survives degenerate lines', () => {
    expect(computeTunnels(line([0, 50], [500, 50]), spec, [rect('z', 200, 50, 0, 0), rect('neg', 300, 100, -50, -100)])).toEqual([]);
    expect(computeTunnels(line([250, 50]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    expect(computeTunnels(line([250, 50], [250, 50]), spec, [rect('c', 200, 0, 100, 100)])).toEqual([]);
    // A zero-length segment in the middle does not split or corrupt the tunnel.
    const t = computeTunnels(line([0, 50], [250, 50], [250, 50], [500, 50]), spec, [rect('c', 200, 0, 100, 100)]);
    expect(t).toHaveLength(1);
    expect(round(t[0])).toEqual([[201, 50], [250, 50], [299, 50]]);
  });

  it('handles a card that covers the whole line, and a huge card', () => {
    // Both ends inside a third card: the whole line is one tunnel.
    const whole = computeTunnels(line([20, 50], [480, 50]), spec, [rect('c', 0, 0, 500, 100)]);
    expect(round(whole[0])).toEqual([[20, 50], [480, 50]]);
    const huge = computeTunnels(line([0, 50], [500, 50]), spec, [rect('h', -1e9, -1e9, 2e9, 2e9)]);
    expect(round(huge[0])).toEqual([[0, 50], [500, 50]]);
  });

  it('starts a tunnel at the line end when a card covers the anchor', () => {
    // The target card 'b' is under 'c'; the line's last stretch runs under 'c'.
    const t = computeTunnels(line([0, 50], [300, 50], [300, 150], [380, 150]), spec, [rect('b', 400, 100, 200, 100), rect('c', 250, 0, 400, 300)]);
    expect(t).toHaveLength(1);
    expect(round(t[0])[0]).toEqual([251, 50]);
    expect(round(t[0]).at(-1)).toEqual([380, 150]);
  });

  it('gives two lines with identical points identical tunnels', () => {
    const obstacles = [rect('c', 200, 0, 100, 100), rect('d', 350, 0, 100, 100)];
    const a = computeTunnels(line([0, 50], [500, 50]), spec, obstacles);
    const b = computeTunnels(line([0, 50], [500, 50]), { ...spec, id: 'e2' }, obstacles);
    expect(b).toEqual(a);
  });

  it('a U-shaped line (both ends on the same side) under a card between them', () => {
    // Both ends on the right side of 'a' (x = 200) and 'b'; the U turns at x = 260, under 'c'.
    const u = computeTunnels(line([220, 40], [260, 40], [260, 340], [220, 340]), spec, [
      rect('a', 0, 0, 200, 80), rect('b', 0, 300, 200, 80), rect('c', 240, 120, 200, 140),
    ]);
    expect(u.map(round)).toEqual([[[260, 121], [260, 259]]]);
  });

  it('is the same whatever order the cards come in', () => {
    const input = stressInput(30, 60, 3);
    const result = routeAll(input, XRAY, Z);
    const shuffled = { ...input, obstacles: [...input.obstacles].reverse() };
    const again = routeAll(shuffled, XRAY, Z);
    for (const [id, e] of result.edges) expect(again.edges.get(id)?.tunnels).toEqual(e.tunnels);
  });

  it('every tunnel lies on its line, inside a card, with finite points (stress diagram)', () => {
    const input = stressInput(100, 200);
    const result = routeAll(input, XRAY, Z);
    let count = 0;
    for (const e of result.edges.values()) {
      expect(allFinite(e.tunnels)).toBe(true);
      for (const t of e.tunnels ?? []) {
        count++;
        for (const p of t) expect(distToPolyline(p, e.points)).toBeLessThan(0.01);
        // Just past where it dives under, it is under some card. (Not the middle of
        // the first stretch: a tunnel bridges cards a few px apart, so that can be the gap.)
        const len = Math.hypot(t[1].x - t[0].x, t[1].y - t[0].y);
        const m = { x: t[0].x + ((t[1].x - t[0].x) / len) * 0.5, y: t[0].y + ((t[1].y - t[0].y) / len) * 0.5 };
        expect(input.obstacles.some((o) => m.x >= o.x && m.x <= o.x + o.width && m.y >= o.y && m.y <= o.y + o.height)).toBe(true);
      }
    }
    expect(count).toBeGreaterThan(0);
  });

  it('every routed line still runs from its source stub to its target stub (x-ray changes no geometry)', () => {
    for (const input of [...SCENARIO_NAMES.map((n) => scenarioRoutingInput(n)), stressInput(100, 200)]) {
      const on = routeAll(input, XRAY, Z);
      const off = routeAll(input, { ...XRAY, underTables: 'hidden' }, Z);
      for (const [id, e] of on.edges) {
        const first = e.points[0];
        const last = e.points[e.points.length - 1];
        expect(distToPolyline(first, [pushOut(e.sourceAnchor, e.sourceAnchor.side, PATH_GAP), pushOut(e.sourceAnchor, e.sourceAnchor.side, PATH_GAP)])).toBeLessThan(0.5);
        expect(distToPolyline(last, [pushOut(e.targetAnchor, e.targetAnchor.side, PATH_GAP), pushOut(e.targetAnchor, e.targetAnchor.side, PATH_GAP)])).toBeLessThan(0.5);
        expect(e.d).toBe(off.edges.get(id)?.d);
      }
    }
  });

  it('is deterministic, and rarely pops a tunnel in or out when a card is nudged 1–5 px', () => {
    // Every threshold (the 1 px tolerance, BORDER_HUG, MERGE_GAP, MIN_TUNNEL)
    // flips somewhere, so some popping is unavoidable: measured 5 in 15140
    // with no BORDER_HUG, 12 with it at 6 px. Fail if it gets an order worse.
    let pops = 0;
    let checks = 0;
    for (const name of SCENARIO_NAMES) {
      const input = scenarioRoutingInput(name);
      const base = routeAll(input, XRAY, Z);
      expect(routeAll(input, XRAY, Z).edges).toEqual(base.edges);
      for (const card of input.obstacles) {
        for (const dx of [1, 2, 3, 4, 5]) {
          const shift = (a: EdgeSpec['sourceAnchor'], owner: string) => (owner === card.id ? { ...a, x: a.x + dx, y: a.y + dx } : a);
          const moved: RoutingInput = {
            obstacles: input.obstacles.map((o) => (o.id === card.id ? { ...o, x: o.x + dx, y: o.y + dx } : o)),
            edges: input.edges.map((e) => ({ ...e, sourceAnchor: shift(e.sourceAnchor, e.source), targetAnchor: shift(e.targetAnchor, e.target) })),
          };
          const after = routeAll(moved, XRAY, Z);
          for (const [id, e] of base.edges) {
            checks++;
            if ((after.edges.get(id)?.tunnels?.length ?? 0) !== (e.tunnels?.length ?? 0)) pops++;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[tunnels jitter] ${pops} pops in ${checks} line × nudge checks`);
    expect(pops / checks).toBeLessThan(0.005);
  });

  it('keeps up with a drag on 100 cards / 200 lines', () => {
    const input = stressInput(100, 200);
    const routed = routeAll(input, { ...XRAY, underTables: 'hidden' }, Z);
    const specs = new Map(input.edges.map((e) => [e.id, e]));
    const lines = [...routed.edges.entries()];
    const runs = 50;
    const t0 = performance.now();
    let n = 0;
    for (let i = 0; i < runs; i++) for (const [id, l] of lines) n += computeTunnels(l, specs.get(id), input.obstacles).length;
    const perPass = (performance.now() - t0) / runs;
    // eslint-disable-next-line no-console
    console.log(`[tunnels perf] stress: ${lines.length} lines × ${input.obstacles.length} cards, ${(n / runs).toFixed(0)} tunnels, ${perPass.toFixed(3)} ms per pass`);
    expect(perPass).toBeLessThan(4);
  });
});
