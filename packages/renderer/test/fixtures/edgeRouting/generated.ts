/**
 * Large generated diagrams for the router's local grids: columns of cards
 * with varied sizes and gaps, as the auto-layout places them, and lines
 * mostly to the next column with some long ones. Deterministic per seed.
 */
import type { EdgeSpec, Rect, RoutingInput, Side } from '../../../src/lib/edgeRouting/types';

/**
 * `sides`: 'facing' anchors every line right → left; 'canvas' picks top /
 * bottom when the two cards are much further apart vertically than
 * horizontally, as the canvas does (lines between neighbouring columns
 * thousands of px apart, which must run up the crowded gap between them).
 */
export function layeredRoutingInput(cards: number, seed = 1, sides: 'facing' | 'canvas' = 'facing'): RoutingInput {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const perCol = Math.max(4, Math.round(Math.sqrt(cards / 2)));
  const obstacles: Rect[] = [];
  const colOf: number[] = [];
  let x = 0;
  let col = 0;
  while (obstacles.length < cards) {
    let y = Math.round(rnd() * 200);
    let maxW = 0;
    const k = Math.min(cards - obstacles.length, Math.max(2, Math.round(perCol * (0.6 + rnd() * 0.8))));
    for (let q = 0; q < k; q++) {
      const width = 180 + Math.round(rnd() * 120);
      const height = 80 + Math.round(rnd() * 260);
      obstacles.push({ id: `t${obstacles.length}`, x: x + Math.round(rnd() * 40), y, width, height, kind: 'model' });
      colOf.push(col);
      y += height + 40 + Math.round(rnd() * 60);
      maxW = Math.max(maxW, width);
    }
    x += maxW + 160 + Math.round(rnd() * 80);
    col++;
  }
  const byCol = new Map<number, number[]>();
  colOf.forEach((c, i) => {
    const list = byCol.get(c);
    if (list) list.push(i);
    else byCol.set(c, [i]);
  });
  const anchor = (r: Rect, side: Side) => ({ x: side === 'right' ? r.x + r.width : r.x, y: r.y + r.height / 2, side });
  const vAnchor = (r: Rect, side: Side) => ({ x: r.x + r.width / 2, y: side === 'bottom' ? r.y + r.height : r.y, side });
  const edges: EdgeSpec[] = [];
  for (let i = 0; i < cards; i++) {
    const next = byCol.get(colOf[i] + 1);
    if (!next) continue;
    const targets = [next[Math.floor(rnd() * next.length)]];
    if (rnd() < 0.3) targets.push(next[Math.floor(rnd() * next.length)]);
    if (rnd() < 0.08) {
      const far = byCol.get(colOf[i] + 2 + Math.floor(rnd() * 6));
      if (far) targets.push(far[Math.floor(rnd() * far.length)]);
    }
    for (const j of targets) {
      const a = obstacles[i];
      const b = obstacles[j];
      const vertical = sides === 'canvas' && Math.abs(b.y - a.y) > 3 * Math.abs(b.x - a.x);
      const down = b.y > a.y;
      edges.push({
        id: `e${edges.length}`,
        source: a.id,
        target: b.id,
        sourceAnchor: vertical ? vAnchor(a, down ? 'bottom' : 'top') : anchor(a, 'right'),
        targetAnchor: vertical ? vAnchor(b, down ? 'top' : 'bottom') : anchor(b, 'left'),
        isSelfLoop: false,
        loopIndex: 0,
        cardinality: 'many-to-one',
      });
    }
  }
  return { obstacles, edges };
}
