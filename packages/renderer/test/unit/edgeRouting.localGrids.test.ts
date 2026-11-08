/**
 * The router on large diagrams: past LOCAL_FROM_CARDS cards each line is
 * routed on its own local grid (the area round its two cards, widened while
 * the route has to run along its edge). Lines still go round every card, the
 * result is repeatable, a move re-routes only what it touches, and no grid
 * comes near the size one grid over the whole diagram would be.
 */
import { describe, expect, it } from 'vitest';
import { createAvoidRouter } from '../../src/lib/edgeRouting';
import { LOCAL_FROM_CARDS, LOCAL_MARGIN, LOCAL_MAX_NODES } from '../../src/lib/edgeRouting/routers/orthogonal/params';
import type { EdgeSpec, Point, Rect, RoutingInput } from '../../src/lib/edgeRouting/types';
import { layeredRoutingInput } from '../fixtures/edgeRouting/generated';
import { scenarioRoutingInput } from '../fixtures/edgeRouting/scenarios';

/** Lines with a segment inside a card other than their own two (relaxed lines excepted). */
function linesUnderCards(input: RoutingInput, lines: Map<string, { points: Point[] }>, except: ReadonlySet<string>): string[] {
  const ends = new Map(input.edges.map((e) => [e.id, [e.source, e.target]]));
  const out: string[] = [];
  for (const [id, line] of lines) {
    if (except.has(id)) continue;
    const [s, t] = ends.get(id)!;
    const pts = line.points;
    const hit = input.obstacles.some((r) => {
      if (r.id === s || r.id === t) return false;
      for (let k = 1; k < pts.length; k++) {
        const a = pts[k - 1];
        const b = pts[k];
        if (
          Math.max(a.x, b.x) > r.x + 0.5 &&
          Math.min(a.x, b.x) < r.x + r.width - 0.5 &&
          Math.max(a.y, b.y) > r.y + 0.5 &&
          Math.min(a.y, b.y) < r.y + r.height - 0.5
        )
          return true;
      }
      return false;
    });
    if (hit) out.push(id);
  }
  return out;
}

function moveCard(input: RoutingInput, id: string, dx: number, dy: number): RoutingInput {
  const shift = <T extends { x: number; y: number }>(p: T, owner: string): T => (owner === id ? { ...p, x: p.x + dx, y: p.y + dy } : p);
  return {
    obstacles: input.obstacles.map((o) => shift(o, o.id)),
    edges: input.edges.map((e) => ({ ...e, sourceAnchor: shift(e.sourceAnchor, e.source), targetAnchor: shift(e.targetAnchor, e.target) })),
  };
}

const large = layeredRoutingInput(400, 3);

describe('the router on a large diagram (local grids)', () => {
  it('routes every line round the cards, on grids far smaller than the diagram', () => {
    expect(large.obstacles.length).toBeGreaterThan(LOCAL_FROM_CARDS);
    const result = createAvoidRouter().route(large);
    expect(result.lines.size).toBe(large.edges.length);
    expect(result.fallbacks.size).toBe(0);
    expect(linesUnderCards(large, result.lines, new Set(result.relaxed.keys()))).toEqual([]);
    // The largest local grid, against what one grid over the whole diagram needs (every card's two edges, each way).
    const largest = result.stats.gridX * result.stats.gridY;
    expect(largest).toBeLessThanOrEqual(LOCAL_MAX_NODES);
    expect(largest).toBeLessThan((2 * large.obstacles.length) ** 2 / 4);
  });

  it('routes lines between neighbouring columns far apart vertically (up the crowded gap) rather than through the column', () => {
    const input = layeredRoutingInput(1000, 5, 'canvas'); // 2 lines fell back here before the rescue
    const vertical = input.edges.filter((e) => e.sourceAnchor.side === 'top' || e.sourceAnchor.side === 'bottom');
    expect(vertical.length).toBeGreaterThan(10);
    const result = createAvoidRouter().route(input);
    expect(result.fallbacks.size).toBe(0);
    expect(linesUnderCards(input, result.lines, new Set(result.relaxed.keys()))).toEqual([]);
  });

  it('is repeatable: two routers give the same lines', () => {
    const a = createAvoidRouter().route(large);
    const b = createAvoidRouter().route(large);
    expect(JSON.stringify([...b.lines])).toBe(JSON.stringify([...a.lines]));
  });

  it('a moved card re-routes only the lines near it; the others keep their routes', () => {
    const router = createAvoidRouter();
    const before = router.route(large);
    const card = large.obstacles[Math.floor(large.obstacles.length / 2)];
    const after = router.route(moveCard(large, card.id, 24, 0));
    expect(after.stats.reused).toBeGreaterThan(large.edges.length * 0.9);
    const own = new Set(large.edges.filter((e) => e.source === card.id || e.target === card.id).map((e) => e.id));
    for (const id of own) expect(after.lines.has(id)).toBe(true);
    expect(linesUnderCards(large, after.lines, new Set(after.relaxed.keys())).filter((id) => !own.has(id))).toEqual([]);
    expect(after.lines.size).toBe(before.lines.size);
  });

  it('widens a line\'s grid to go round a wall of cards taller than its first grid', () => {
    // Two cards with a wall of cards between them, reaching well past LOCAL_MARGIN above and below.
    const filler: Rect[] = Array.from({ length: LOCAL_FROM_CARDS + 10 }, (_, i) => ({
      id: `f${i}`,
      x: 4000 + (i % 15) * 300,
      y: Math.floor(i / 15) * 260,
      width: 200,
      height: 160,
      kind: 'model',
    }));
    const wall: Rect[] = Array.from({ length: 9 }, (_, i) => ({ id: `w${i}`, x: 900, y: -1600 + i * 400, width: 220, height: 380, kind: 'model' }));
    const a: Rect = { id: 'a', x: 300, y: 100, width: 200, height: 120, kind: 'model' };
    const b: Rect = { id: 'b', x: 1600, y: 100, width: 200, height: 120, kind: 'model' };
    const spec: EdgeSpec = {
      id: 'ab',
      source: 'a',
      target: 'b',
      sourceAnchor: { x: 500, y: 160, side: 'right' },
      targetAnchor: { x: 1600, y: 160, side: 'left' },
      isSelfLoop: false,
      loopIndex: 0,
      cardinality: 'many-to-one',
    };
    const input: RoutingInput = { obstacles: [a, b, ...wall, ...filler], edges: [spec] };
    const result = createAvoidRouter().route(input);
    expect(result.fallbacks.has('ab')).toBe(false);
    expect(result.relaxed.has('ab')).toBe(false);
    expect(linesUnderCards(input, result.lines, new Set())).toEqual([]);
    const ys = result.lines.get('ab')!.points.map((p) => p.y);
    // Round the top or the bottom of the wall: past where the first grid ends.
    expect(Math.min(...ys) < 100 - LOCAL_MARGIN || Math.max(...ys) > 220 + LOCAL_MARGIN).toBe(true);
  });

  it('a small diagram still uses one grid over all of it', () => {
    const input = scenarioRoutingInput('big');
    expect(input.obstacles.length).toBeLessThanOrEqual(LOCAL_FROM_CARDS);
    const result = createAvoidRouter().route(input);
    // One grid: its lines span every card (the global grid includes every card's padded edges).
    expect(result.stats.gridX).toBeGreaterThanOrEqual(new Set(input.obstacles.map((o) => o.x)).size);
  });
});
