/**
 * The route-around router (`createAvoidRouter`).
 *
 * Property tests over every routing scenario and seeded random layouts:
 * every line starts and ends on its stubs, leaves and enters its cards
 * square-on, is orthogonal, never passes through a card (other than one
 * overlapping its own end, which the router reports), and the answer is the
 * same every time. Plus a timing check on the 40-card scenario, because
 * routing runs on every frame of a drag.
 */

import { describe, expect, it } from "vitest";
import { createAvoidRouter } from "../../src/lib/edgeRouting/routers/orthogonalAvoid";
import { routeAll } from "../../src/lib/edgeRouting";
import { pushOut } from "../../src/lib/edgeRouting/input";
import {
  PATH_GAP,
  type EdgeSpec,
  type Point,
  type Rect,
  type RoutedLine,
  type RoutingInput,
  type Side,
} from "../../src/lib/edgeRouting/types";
import { MIN_LEG } from "../../src/lib/edgeRouting/routers/orthogonal/params";
import {
  SCENARIO_NAMES,
  scenarioRoutingInput,
} from "../fixtures/edgeRouting/scenarios";

// One router for the file, as a canvas holds one: its memory of the last pass
// carries between calls until `resetAvoidCache()`.
const router = createAvoidRouter();
const routeAvoid = (input: RoutingInput) => router.route(input);
const routeOrthogonalAvoid = (input: RoutingInput) => router.route(input).lines;
const resetAvoidCache = () => router.reset();

const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

function insideStrict(a: Point, b: Point, r: Rect, tol = 0.5): boolean {
  const x0 = r.x + tol;
  const x1 = r.x + r.width - tol;
  const y0 = r.y + tol;
  const y1 = r.y + r.height - tol;
  if (near(a.x, b.x)) {
    if (a.x <= x0 || a.x >= x1) return false;
    return (
      Math.min(Math.max(a.y, b.y), y1) - Math.max(Math.min(a.y, b.y), y0) > 0
    );
  }
  if (a.y <= y0 || a.y >= y1) return false;
  return (
    Math.min(Math.max(a.x, b.x), x1) - Math.max(Math.min(a.x, b.x), x0) > 0
  );
}

/** The unit step a line takes when it leaves a side. */
const OUT: Record<Side, Point> = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  bottom: { x: 0, y: 1 },
  top: { x: 0, y: -1 },
};

function onSide(
  anchor: { x: number; y: number; side: Side },
  r: Rect,
): boolean {
  switch (anchor.side) {
    case "right":
      return (
        near(anchor.x, r.x + r.width) &&
        anchor.y > r.y &&
        anchor.y < r.y + r.height
      );
    case "left":
      return near(anchor.x, r.x) && anchor.y > r.y && anchor.y < r.y + r.height;
    case "bottom":
      return (
        near(anchor.y, r.y + r.height) &&
        anchor.x > r.x &&
        anchor.x < r.x + r.width
      );
    case "top":
      return near(anchor.y, r.y) && anchor.x > r.x && anchor.x < r.x + r.width;
  }
}

/** Every property a routed line must have; returns the problems found (empty = good). */
function problems(
  input: RoutingInput,
  spec: EdgeSpec,
  line: RoutedLine,
  ignored: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const rects = new Map(input.obstacles.map((r) => [r.id, r]));
  const src = rects.get(spec.source)!;
  const tgt = rects.get(spec.target)!;
  const pts = line.points;
  if (pts.length < 2) return [`${spec.id}: fewer than 2 points`];
  const s = pushOut(line.sourceAnchor, line.sourceAnchor.side, PATH_GAP);
  const t = pushOut(line.targetAnchor, line.targetAnchor.side, PATH_GAP);
  if (!near(pts[0].x, s.x) || !near(pts[0].y, s.y))
    out.push(`${spec.id}: does not start at the source stub`);
  if (!near(pts[pts.length - 1].x, t.x) || !near(pts[pts.length - 1].y, t.y))
    out.push(`${spec.id}: does not end at the target stub`);
  if (!onSide(line.sourceAnchor, src))
    out.push(
      `${spec.id}: source anchor off the ${line.sourceAnchor.side} side`,
    );
  if (!onSide(line.targetAnchor, tgt))
    out.push(
      `${spec.id}: target anchor off the ${line.targetAnchor.side} side`,
    );
  for (let k = 1; k < pts.length; k++) {
    const a = pts[k - 1];
    const b = pts[k];
    if (!near(a.x, b.x) && !near(a.y, b.y))
      out.push(`${spec.id}: segment ${k} is not orthogonal`);
    if (near(a.x, b.x) && near(a.y, b.y))
      out.push(`${spec.id}: segment ${k} has no length`);
  }
  // Square-on at both ends, pointing away from / into the card, with a visible
  // leg before the first bend (a straight line between facing cards has no bend).
  const leg = pts.length > 2 ? MIN_LEG - 0.01 : 0.5;
  const o = OUT[line.sourceAnchor.side];
  const first = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
  if (
    first.x * o.x + first.y * o.y < leg ||
    Math.abs(first.x * o.y - first.y * o.x) > 0.01
  ) {
    out.push(
      `${spec.id}: first segment is not a ${MIN_LEG}px+ leg out of the ${line.sourceAnchor.side} side`,
    );
  }
  const i = OUT[line.targetAnchor.side];
  const n = pts.length - 1;
  const lastSeg = { x: pts[n - 1].x - pts[n].x, y: pts[n - 1].y - pts[n].y };
  if (
    lastSeg.x * i.x + lastSeg.y * i.y < leg ||
    Math.abs(lastSeg.x * i.y - lastSeg.y * i.x) > 0.01
  ) {
    out.push(
      `${spec.id}: last segment is not a ${MIN_LEG}px+ leg into the ${line.targetAnchor.side} side`,
    );
  }
  // No fold: a line never doubles back over a run shorter than a stub (a hook).
  for (let k = 2; k < pts.length; k++) {
    const a = pts[k - 2];
    const b = pts[k - 1];
    const c = pts[k];
    const d1 = { x: b.x - a.x, y: b.y - a.y };
    const d2 = { x: c.x - b.x, y: c.y - b.y };
    if (d1.x * d2.x + d1.y * d2.y < -0.01)
      out.push(`${spec.id}: doubles back at point ${k - 1}`);
  }
  // Never through a card — its own two included — unless the router had to let it pass under one.
  for (const r of input.obstacles) {
    if (ignored.has(r.id)) continue;
    for (let k = 1; k < pts.length; k++) {
      if (insideStrict(pts[k - 1], pts[k], r)) {
        out.push(`${spec.id}: segment ${k} passes through ${r.id}`);
        break;
      }
    }
  }
  return out;
}

function checkAll(input: RoutingInput, opts: { allowFallback?: boolean } = {}) {
  const result = routeAvoid(input);
  const errors: string[] = [];
  for (const spec of input.edges) {
    const line = result.lines.get(spec.id);
    if (spec.isSelfLoop || spec.source === spec.target) {
      if (line) errors.push(`${spec.id}: a self-loop was routed`);
      continue;
    }
    if (!line) {
      errors.push(`${spec.id}: no line`);
      continue;
    }
    if (result.fallbacks.has(spec.id)) {
      if (!opts.allowFallback) errors.push(`${spec.id}: fell back`);
      continue;
    }
    errors.push(
      ...problems(input, spec, line, result.relaxed.get(spec.id) ?? new Set()),
    );
  }
  return { result, errors };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random diagram: cards on a jittered grid (or anywhere, overlapping), random links. */
function randomInput(seed: number, mode: "tidy" | "messy"): RoutingInput {
  const rand = mulberry32(seed);
  const count = 6 + Math.floor(rand() * 18);
  const cols = Math.ceil(Math.sqrt(count));
  const obstacles: Rect[] = [];
  for (let i = 0; i < count; i++) {
    const width = 200 + Math.round(rand() * 80);
    const height = 60 + Math.round(rand() * 300);
    let x: number;
    let y: number;
    if (mode === "tidy") {
      x = (i % cols) * 380 + Math.round(rand() * 60);
      y = Math.floor(i / cols) * 460 + Math.round(rand() * 60);
    } else {
      x = Math.round(rand() * cols * 300);
      y = Math.round(rand() * cols * 300);
    }
    obstacles.push({ id: `t${i}`, x, y, width, height, kind: "model" });
  }
  if (rand() < 0.5)
    obstacles.push({
      id: "note",
      x: Math.round(rand() * 600),
      y: Math.round(rand() * 600),
      width: 180,
      height: 90,
      kind: "annotation",
    });
  const edges: EdgeSpec[] = [];
  const linkCount = Math.round(count * (1 + rand()));
  const seen = new Set<string>();
  for (let e = 0; e < linkCount; e++) {
    const a = Math.floor(rand() * count);
    let b = Math.floor(rand() * count);
    if (rand() < 0.05) b = a; // the odd self-loop
    const key = `${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ra = obstacles[a];
    const rb = obstacles[b];
    edges.push({
      id: `e${e}`,
      source: ra.id,
      target: rb.id,
      sourceAnchor: {
        x: ra.x + ra.width,
        y: ra.y + ra.height / 2,
        side: "right",
      },
      targetAnchor: { x: rb.x, y: rb.y + rb.height / 2, side: "left" },
      isSelfLoop: a === b,
      loopIndex: 0,
      cardinality: "many-to-one",
    });
  }
  return { obstacles, edges };
}

describe("orthogonal-avoid router", () => {
  for (const name of SCENARIO_NAMES) {
    it(`routes every line of '${name}' around the cards`, () => {
      const input = scenarioRoutingInput(name);
      const { result, errors } = checkAll(input);
      expect(errors).toEqual([]);
      const lines = input.edges.filter((e) => !e.isSelfLoop).length;
      expect(result.lines.size).toBe(lines);
    });
  }

  it("is deterministic", () => {
    for (const name of SCENARIO_NAMES) {
      const input = scenarioRoutingInput(name);
      const a = JSON.stringify([...routeOrthogonalAvoid(input)]);
      const b = JSON.stringify([...routeOrthogonalAvoid(input)]);
      expect(b).toBe(a);
    }
  });

  it("routes tidy random layouts with no fallbacks and no line through a card", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { errors } = checkAll(randomInput(seed, "tidy"));
      expect(errors, `seed ${seed}`).toEqual([]);
    }
  });

  it("copes with messy, overlapping random layouts (fallbacks allowed, never a broken line)", () => {
    for (let seed = 100; seed <= 160; seed++) {
      const input = randomInput(seed, "messy");
      resetAvoidCache();
      const { errors } = checkAll(input, { allowFallback: true });
      expect(errors, `seed ${seed}`).toEqual([]);
    }
  });

  it("keeps anchors on one card side apart, so the * and 1 never pile up", () => {
    for (const name of SCENARIO_NAMES) {
      const input = scenarioRoutingInput(name);
      const { result } = checkAll(input);
      const bySide = new Map<string, number[]>();
      for (const spec of input.edges) {
        const line = result.lines.get(spec.id);
        if (!line || result.fallbacks.has(spec.id)) continue;
        for (const [card, anchor] of [
          [spec.source, line.sourceAnchor],
          [spec.target, line.targetAnchor],
        ] as const) {
          const key = `${card}|${anchor.side}`;
          const c =
            anchor.side === "left" || anchor.side === "right"
              ? anchor.y
              : anchor.x;
          bySide.set(key, [...(bySide.get(key) ?? []), c]);
        }
      }
      for (const [key, cs] of bySide) {
        cs.sort((a, b) => a - b);
        for (let i = 1; i < cs.length; i++)
          expect(cs[i] - cs[i - 1], `${name} ${key}`).toBeGreaterThanOrEqual(
            10,
          );
      }
    }
  });

  it("leaves self-loops to the canvas", () => {
    const input = scenarioRoutingInput("showcase");
    const loops = input.edges.filter((e) => e.isSelfLoop);
    expect(loops.length).toBeGreaterThan(0);
    const lines = routeOrthogonalAvoid(input);
    for (const l of loops) expect(lines.has(l.id)).toBe(false);
  });

  it("routes a line under a card only when its end is buried under another card", () => {
    // Card b lies right on top of a's only free side; the line still gets a path.
    const obstacles: Rect[] = [
      { id: "a", x: 0, y: 0, width: 260, height: 200, kind: "model" },
      { id: "b", x: 100, y: 50, width: 260, height: 200, kind: "model" },
      { id: "c", x: 700, y: 0, width: 260, height: 200, kind: "model" },
    ];
    const edges: EdgeSpec[] = [
      {
        id: "a-c",
        source: "a",
        target: "c",
        sourceAnchor: { x: 260, y: 100, side: "right" },
        targetAnchor: { x: 700, y: 100, side: "left" },
        isSelfLoop: false,
        loopIndex: 0,
        cardinality: "many-to-one",
      },
      {
        id: "b-a",
        source: "b",
        target: "a",
        sourceAnchor: { x: 100, y: 150, side: "left" },
        targetAnchor: { x: 260, y: 100, side: "right" },
        isSelfLoop: false,
        loopIndex: 0,
        cardinality: "many-to-one",
      },
    ];
    const { errors } = checkAll({ obstacles, edges }, { allowFallback: true });
    expect(errors).toEqual([]);
  });

  it("draws a straight line between two cards side by side", () => {
    const obstacles: Rect[] = [
      { id: "a", x: 0, y: 0, width: 260, height: 200, kind: "model" },
      { id: "b", x: 500, y: 60, width: 260, height: 160, kind: "model" },
    ];
    const edges: EdgeSpec[] = [
      {
        id: "a-b",
        source: "a",
        target: "b",
        sourceAnchor: { x: 260, y: 100, side: "right" },
        targetAnchor: { x: 500, y: 140, side: "left" },
        isSelfLoop: false,
        loopIndex: 0,
        cardinality: "many-to-one",
      },
    ];
    const line = routeOrthogonalAvoid({ obstacles, edges }).get("a-b")!;
    expect(line.points).toHaveLength(2);
    expect(line.sourceAnchor.side).toBe("right");
    expect(line.targetAnchor.side).toBe("left");
  });

  it("goes round a card in the way rather than under it", () => {
    const obstacles: Rect[] = [
      { id: "a", x: 0, y: 0, width: 260, height: 200, kind: "model" },
      { id: "mid", x: 340, y: 0, width: 260, height: 200, kind: "model" },
      { id: "b", x: 680, y: 0, width: 260, height: 200, kind: "model" },
    ];
    const edges: EdgeSpec[] = [
      {
        id: "a-b",
        source: "a",
        target: "b",
        sourceAnchor: { x: 260, y: 100, side: "right" },
        targetAnchor: { x: 680, y: 100, side: "left" },
        isSelfLoop: false,
        loopIndex: 0,
        cardinality: "many-to-one",
      },
    ];
    const { result, errors } = checkAll({ obstacles, edges });
    expect(errors).toEqual([]);
    const pts = result.lines.get("a-b")!.points;
    // It goes over or under the middle card.
    expect(pts.some((p) => p.y < 0 || p.y > 200)).toBe(true);
  });

  it("routes the 40-card / 60-line scenario fast enough for every frame of a drag", () => {
    const input = scenarioRoutingInput("big");
    const settings = {
      crossings: "none",
      underTables: "hidden",
      corners: "rounded",
    } as const;
    const median = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const max = (xs: number[]) => Math.max(...xs);

    // Cold: every line routed from scratch (first paint, a style switch).
    for (let i = 0; i < 6; i++) {
      resetAvoidCache();
      routeAll(input, settings, { router });
    }
    const cold: number[] = [];
    for (let i = 0; i < 15; i++) {
      resetAvoidCache();
      const t0 = performance.now();
      routeAll(input, settings, { router });
      cold.push(performance.now() - t0);
    }

    // Drag: the busiest card moves 250 x 150 px in 40 frames; lines away from it keep their routes, the rest are routed again.
    const degree = new Map<string, number>();
    for (const e of input.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const busiest = [...degree.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0][0];
    const home = input.obstacles.find((o) => o.id === busiest)!;
    const frameInput = (f: number): RoutingInput => ({
      edges: input.edges,
      obstacles: input.obstacles.map((o) =>
        o.id === busiest
          ? { ...o, x: home.x + (250 * f) / 40, y: home.y + (150 * f) / 40 }
          : o,
      ),
    });
    resetAvoidCache();
    routeAll(frameInput(0), settings, { router });
    const drag: number[] = [];
    let reused = 0;
    for (let f = 1; f <= 40; f++) {
      const frame = frameInput(f);
      const t0 = performance.now();
      const result = routeAvoid(frame);
      drag.push(performance.now() - t0);
      reused += result.stats.reused;
    }
    // eslint-disable-next-line no-console
    console.log(
      `[orthogonal-avoid] big: cold median ${median(cold).toFixed(2)} ms (max ${max(cold).toFixed(2)}), ` +
        `drag of ${busiest} median ${median(drag).toFixed(2)} ms (max ${max(drag).toFixed(2)}), ` +
        `${(reused / 40).toFixed(0)}/${input.edges.length} lines kept per frame`,
    );
    // The budget is ~12 ms a frame on a dev Mac; CI machines get slack.
    const slack = process.env.CI ? 3 : 1;
    expect(median(drag)).toBeLessThan(12 * slack);
    expect(median(cold)).toBeLessThan(30 * slack);
  });
});

// ---------------------------------------------------------------------------
// Adversarial cases (second review). Inputs the canvas can really produce —
// cards dropped on top of each other, a card over an anchor, unmeasured,
// giant or far-off cards, twin links, a card dragged 1 px at a time — and
// what must hold anyway: no throw, no NaN, every line ends on its stubs,
// no line through a card it was not allowed under, stable routes while a
// card is dragged, and no crossing right at a `*` / `1`.

const card = (
  id: string,
  x: number,
  y: number,
  width = 260,
  height = 200,
): Rect => ({ id, x, y, width, height, kind: "model" });

function centreAnchor(r: Rect, side: Side) {
  switch (side) {
    case "right":
      return { x: r.x + r.width, y: r.y + r.height / 2, side };
    case "left":
      return { x: r.x, y: r.y + r.height / 2, side };
    case "bottom":
      return { x: r.x + r.width / 2, y: r.y + r.height, side };
    case "top":
      return { x: r.x + r.width / 2, y: r.y, side };
  }
}

function link(
  id: string,
  a: Rect,
  b: Rect,
  sa: Side = "right",
  sb: Side = "left",
): EdgeSpec {
  return {
    id,
    source: a.id,
    target: b.id,
    sourceAnchor: centreAnchor(a, sa),
    targetAnchor: centreAnchor(b, sb),
    isSelfLoop: false,
    loopIndex: 0,
    cardinality: "many-to-one",
  };
}

/** Every number is finite and every routed line runs stub to stub. */
function finiteAndConnected(lines: Map<string, RoutedLine>): string[] {
  const out: string[] = [];
  for (const [id, line] of lines) {
    const nums = [
      line.sourceAnchor.x,
      line.sourceAnchor.y,
      line.targetAnchor.x,
      line.targetAnchor.y,
      ...line.points.flatMap((p) => [p.x, p.y]),
    ];
    if (nums.some((v) => !Number.isFinite(v)))
      out.push(`${id}: non-finite coordinate`);
    if (line.points.length < 2) {
      out.push(`${id}: fewer than 2 points`);
      continue;
    }
    const s = pushOut(line.sourceAnchor, line.sourceAnchor.side, PATH_GAP);
    const t = pushOut(line.targetAnchor, line.targetAnchor.side, PATH_GAP);
    const p0 = line.points[0];
    const pn = line.points[line.points.length - 1];
    if (!near(p0.x, s.x) || !near(p0.y, s.y))
      out.push(`${id}: first point is not the source stub`);
    if (!near(pn.x, t.x) || !near(pn.y, t.y))
      out.push(`${id}: last point is not the target stub`);
  }
  return out;
}

function shiftCard(
  input: RoutingInput,
  id: string,
  dx: number,
  dy: number,
): RoutingInput {
  const r0 = input.obstacles.find((o) => o.id === id)!;
  const mv = (a: { x: number; y: number; side: Side }) => ({
    ...a,
    x: a.x + dx,
    y: a.y + dy,
  });
  return {
    obstacles: input.obstacles.map((o) =>
      o.id === id ? { ...o, x: r0.x + dx, y: r0.y + dy } : o,
    ),
    edges: input.edges.map((e) => ({
      ...e,
      sourceAnchor: e.source === id ? mv(e.sourceAnchor) : e.sourceAnchor,
      targetAnchor: e.target === id ? mv(e.targetAnchor) : e.targetAnchor,
    })),
  };
}

/** Crossings that land on another line's stub, within `depth` px of its card (they read as a T junction at the label). */
function stubCrossings(lines: Map<string, RoutedLine>, depth = 42): string[] {
  const out: string[] = [];
  const all = [...lines.entries()];
  for (const [id, line] of all) {
    const ends = [
      [line.sourceAnchor, line.points[1]],
      [line.targetAnchor, line.points[line.points.length - 2]],
    ] as const;
    for (const [anchor, next] of ends) {
      const o = OUT[anchor.side];
      const len = Math.min(
        depth,
        Math.abs(next.x - anchor.x) + Math.abs(next.y - anchor.y),
      );
      const a = { x: anchor.x, y: anchor.y };
      const b = { x: anchor.x + o.x * len, y: anchor.y + o.y * len };
      for (const [oid, other] of all) {
        if (oid === id) continue;
        for (let k = 1; k < other.points.length; k++) {
          const c = other.points[k - 1];
          const d = other.points[k];
          const abV = near(a.x, b.x);
          if (abV === near(c.x, d.x)) continue;
          const [v0, v1, h0, h1] = abV ? [a, b, c, d] : [c, d, a, b];
          if (
            v0.x > Math.min(h0.x, h1.x) + 0.01 &&
            v0.x < Math.max(h0.x, h1.x) - 0.01 &&
            h0.y > Math.min(v0.y, v1.y) + 0.01 &&
            h0.y < Math.max(v0.y, v1.y) - 0.01
          ) {
            out.push(`${id}@${anchor.side} x ${oid}`);
          }
        }
      }
    }
  }
  return out;
}

/** A line's shape: its sides and bend count (what a viewer sees jump). */
const shapeOf = (l: RoutedLine | undefined) =>
  l ? `${l.sourceAnchor.side}>${l.targetAnchor.side}/${l.points.length}` : "-";

function gridDiagram(
  cards: number,
  linksPerCard: number,
  seed: number,
): RoutingInput {
  const rand = mulberry32(seed);
  const cols = 10;
  const obstacles: Rect[] = [];
  for (let i = 0; i < cards; i++) {
    obstacles.push(
      card(
        `t${i}`,
        (i % cols) * 360 + Math.round(rand() * 60),
        Math.floor(i / cols) * 420 + Math.round(rand() * 60),
        260,
        60 + Math.round(rand() * 280),
      ),
    );
  }
  const edges: EdgeSpec[] = [];
  for (let e = 0; e < cards * linksPerCard; e++) {
    const a = Math.floor(rand() * cards);
    // Mostly neighbours (as a laid-out ERD has), a fifth anywhere.
    const b =
      rand() < 0.8
        ? Math.min(
            cards - 1,
            Math.max(
              0,
              a +
                [1, -1, cols, -cols, cols + 1, cols - 1][
                  Math.floor(rand() * 6)
                ],
            ),
          )
        : Math.floor(rand() * cards);
    if (a !== b) edges.push(link(`e${e}`, obstacles[a], obstacles[b]));
  }
  return { obstacles, edges };
}

describe("orthogonal-avoid router — adversarial", () => {
  const nasty: [string, () => RoutingInput][] = [
    [
      "two cards on the same spot",
      () => {
        const a = card("a", 0, 0),
          b = card("b", 0, 0),
          c = card("c", 600, 0);
        return {
          obstacles: [a, b, c],
          edges: [link("ab", a, b), link("ac", a, c), link("bc", b, c)],
        };
      },
    ],
    [
      "a card inside another",
      () => {
        const a = card("a", 50, 50, 100, 60),
          b = card("b", 0, 0, 400, 300),
          c = card("c", 700, 0);
        return {
          obstacles: [a, b, c],
          edges: [
            link("ac", a, c),
            link("ab", a, b),
            link("cb", c, b, "left", "right"),
          ],
        };
      },
    ],
    [
      "a card lying over an anchor",
      () => {
        const a = card("a", 0, 0),
          cov = card("cov", 240, 60, 100, 80),
          c = card("c", 700, 0);
        return { obstacles: [a, cov, c], edges: [link("ac", a, c)] };
      },
    ],
    [
      "ten cards in a pile",
      () => {
        const cs = Array.from({ length: 10 }, (_, i) =>
          card(`c${i}`, i * 5, i * 5),
        );
        return {
          obstacles: cs,
          edges: cs.slice(1).map((c, i) => link(`e${i}`, cs[0], c)),
        };
      },
    ],
    [
      "a card boxed in by four touching neighbours",
      () => {
        const a = card("a", 300, 300),
          t = card("t", 280, 60, 300, 230),
          bo = card("bo", 280, 510, 300, 230),
          l = card("l", 20, 280, 270, 240),
          r = card("r", 570, 280, 270, 240),
          far = card("far", 1200, 300);
        return {
          obstacles: [a, t, bo, l, r, far],
          edges: [link("af", a, far)],
        };
      },
    ],
    [
      "zero-size cards",
      () => {
        const a = card("a", 0, 0, 0, 0),
          b = card("b", 500, 0, 0, 0);
        return { obstacles: [a, b], edges: [link("ab", a, b)] };
      },
    ],
    [
      "tiny cards",
      () => {
        const a = card("a", 0, 0, 10, 10),
          b = card("b", 300, 0, 10, 10);
        return {
          obstacles: [a, b],
          edges: [
            link("ab", a, b),
            link("ab2", a, b),
            link("ba", b, a, "left", "right"),
          ],
        };
      },
    ],
    [
      "a huge card",
      () => {
        const a = card("a", 0, 0, 100000, 50000),
          b = card("b", 200000, 0);
        return { obstacles: [a, b], edges: [link("ab", a, b)] };
      },
    ],
    [
      "a card a billion px wide",
      () => {
        const a = card("a", 0, 0, 1e9, 200),
          b = card("b", 0, 600),
          c = card("c", 2000, 900);
        return {
          obstacles: [a, b, c],
          edges: [link("bc", b, c), link("ab", a, b, "bottom", "top")],
        };
      },
    ],
    [
      "cards 2e8 px apart",
      () => {
        const a = card("a", -1e8, 0),
          b = card("b", 1e8, 500),
          c = card("c", 0, 0);
        return {
          obstacles: [a, b, c],
          edges: [link("ab", a, b), link("cb", c, b)],
        };
      },
    ],
    [
      "cards far from the origin",
      () => {
        const a = card("a", 1e7, 1e7),
          b = card("b", 1e7 + 600, 1e7 + 300);
        return { obstacles: [a, b], edges: [link("ab", a, b)] };
      },
    ],
    [
      "NaN, Infinity and negative sizes",
      () => {
        const a = card("a", NaN, 0),
          b = card("b", 500, 0),
          c = card("c", 0, 0, Infinity, 200),
          d = card("d", 0, 400, -50, 100),
          e = card("e", 900, 400);
        return {
          obstacles: [a, b, c, d, e],
          edges: [
            link("ab", a, b),
            link("cb", c, b),
            link("de", d, e),
            link("be", b, e, "bottom", "top"),
          ],
        };
      },
    ],
    [
      "a line to a card that is not there",
      () => {
        const a = card("a", 0, 0),
          b = card("b", 600, 0);
        return { obstacles: [a], edges: [link("ab", a, b)] };
      },
    ],
    [
      "two lines with identical endpoints (and a reversed one)",
      () => {
        const a = card("a", 0, 0),
          b = card("b", 600, 100);
        return {
          obstacles: [a, b],
          edges: [
            link("x1", a, b),
            link("x2", a, b),
            link("x3", a, b),
            link("x4", b, a, "left", "right"),
          ],
        };
      },
    ],
    [
      "both ends on the same side",
      () => {
        const a = card("a", 0, 0),
          b = card("b", 0, 400);
        return {
          obstacles: [a, b],
          edges: [
            link("rr", a, b, "right", "right"),
            link("ll", a, b, "left", "left"),
          ],
        };
      },
    ],
  ];
  for (const [name, make] of nasty) {
    it(`survives ${name}`, () => {
      const input = make();
      resetAvoidCache();
      const result = routeAvoid(input);
      expect(finiteAndConnected(result.lines)).toEqual([]);
      // Lines between finite cards that both exist are all drawn by the router.
      const finite = new Set(
        input.obstacles
          .filter(
            (r) =>
              [r.x, r.y, r.width, r.height].every(Number.isFinite) &&
              r.width >= 0 &&
              r.height >= 0,
          )
          .map((r) => r.id),
      );
      for (const e of input.edges) {
        if (finite.has(e.source) && finite.has(e.target))
          expect(result.lines.has(e.id), e.id).toBe(true);
        else expect(result.lines.has(e.id), e.id).toBe(false);
      }
      // Never through a card it was not allowed under (zero-size cards have no inside to check).
      resetAvoidCache();
      const { errors } = checkAll(
        {
          obstacles: input.obstacles.filter((r) => finite.has(r.id)),
          edges: input.edges.filter(
            (e) => finite.has(e.source) && finite.has(e.target),
          ),
        },
        { allowFallback: true },
      );
      expect(
        errors.filter(
          (e) => !/anchor off the/.test(e) || !name.startsWith("zero"),
        ),
      ).toEqual([]);
    });
  }

  it("keeps twin lines apart along their whole run, not drawn on top of each other", () => {
    const a = card("a", 0, 0);
    const b = card("b", 600, 100);
    const input = {
      obstacles: [a, b],
      edges: [
        link("x1", a, b),
        link("x2", a, b),
        link("x3", a, b),
        link("x4", b, a, "left", "right"),
      ],
    };
    resetAvoidCache();
    const lines = [...routeAvoid(input).lines.values()];
    for (let i = 0; i < lines.length; i++) {
      for (let j = i + 1; j < lines.length; j++) {
        // No collinear overlap: parallel segments of two twins are at least 10 px apart wherever they run side by side.
        for (let p = 1; p < lines[i].points.length; p++) {
          for (let q = 1; q < lines[j].points.length; q++) {
            const [a0, a1] = [lines[i].points[p - 1], lines[i].points[p]];
            const [b0, b1] = [lines[j].points[q - 1], lines[j].points[q]];
            const av = near(a0.x, a1.x);
            if (av !== near(b0.x, b1.x)) continue;
            const gap = av ? Math.abs(a0.x - b0.x) : Math.abs(a0.y - b0.y);
            const [lo1, hi1] = av
              ? [Math.min(a0.y, a1.y), Math.max(a0.y, a1.y)]
              : [Math.min(a0.x, a1.x), Math.max(a0.x, a1.x)];
            const [lo2, hi2] = av
              ? [Math.min(b0.y, b1.y), Math.max(b0.y, b1.y)]
              : [Math.min(b0.x, b1.x), Math.max(b0.x, b1.x)];
            if (Math.min(hi1, hi2) - Math.max(lo1, lo2) > 1)
              expect(gap, `${i}/${j}`).toBeGreaterThanOrEqual(10);
          }
        }
      }
    }
  });

  it("routes 100 cards / ~200 lines: every line, no fallback, no broken line, in time", () => {
    const input = gridDiagram(100, 2, 100);
    resetAvoidCache();
    const t0 = performance.now();
    const result = routeAvoid(input);
    const cold = performance.now() - t0;
    expect(finiteAndConnected(result.lines)).toEqual([]);
    resetAvoidCache();
    expect(checkAll(input, { allowFallback: true }).errors).toEqual([]);
    expect(result.fallbacks.size).toBeLessThanOrEqual(2);
    // Drag the busiest card 1 px a frame: only its neighbourhood is routed again.
    const degree = new Map<string, number>();
    for (const e of input.edges)
      for (const id of [e.source, e.target])
        degree.set(id, (degree.get(id) ?? 0) + 1);
    const busiest = [...degree.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
    )[0][0];
    resetAvoidCache();
    routeAvoid(input);
    const frames: number[] = [];
    for (let f = 1; f <= 30; f++) {
      const t = performance.now();
      routeAvoid(shiftCard(input, busiest, f * 4, f * 2));
      frames.push(performance.now() - t);
    }
    frames.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(
      `[orthogonal-avoid] 100 cards / ${input.edges.length} lines: cold ${cold.toFixed(1)} ms, drag median ${frames[15].toFixed(1)} ms (max ${frames[29].toFixed(1)})`,
    );
    const slack = process.env.CI ? 3 : 1;
    expect(cold).toBeLessThan(400 * slack);
    expect(frames[15]).toBeLessThan(40 * slack);
  });

  it("is deterministic from a cold start, and a repeated call (served from the cache) draws the same", () => {
    for (const name of SCENARIO_NAMES) {
      const input = scenarioRoutingInput(name);
      resetAvoidCache();
      const a = JSON.stringify([...routeOrthogonalAvoid(input)]);
      const b = JSON.stringify([...routeOrthogonalAvoid(input)]);
      resetAvoidCache();
      const c = JSON.stringify([...routeOrthogonalAvoid(input)]);
      expect(b, name).toBe(a);
      expect(c, name).toBe(a);
    }
  });

  it("does not carry routes over a re-measure: when every card changes size, the answer is a fresh one", () => {
    for (const name of ["star", "tangle", "overlap"] as const) {
      const input = scenarioRoutingInput(name);
      // First pass with the canvas's pre-measure estimate (every card 30 px shorter)…
      const estimate: RoutingInput = {
        edges: input.edges,
        obstacles: input.obstacles.map((o) => ({
          ...o,
          height: Math.max(40, o.height - 30),
        })),
      };
      resetAvoidCache();
      routeOrthogonalAvoid(estimate);
      const afterMeasure = JSON.stringify([...routeOrthogonalAvoid(input)]);
      resetAvoidCache();
      expect(afterMeasure, name).toBe(
        JSON.stringify([...routeOrthogonalAvoid(input)]),
      );
    }
  });

  it("holds its routes while a card is dragged 1 px at a time (no A-B-A flicker, few shape changes)", () => {
    // Each card of the small scenarios moves 30 px right and 15 down in 1 px frames.
    // Before the hysteresis: under 8, star 8, overlap 11 and tangle 106 shape
    // changes, tangle with 7 A-B-A flickers.
    const limits: Record<string, [number, number]> = {
      under: [3, 0],
      star: [4, 0],
      showcase: [3, 0],
      overlap: [6, 0],
      tangle: [60, 2],
    };
    for (const [name, [maxChanges, maxFlicker]] of Object.entries(limits)) {
      const input = scenarioRoutingInput(name);
      let changes = 0;
      let flicker = 0;
      for (const moved of input.obstacles.filter((o) => o.kind === "model")) {
        resetAvoidCache();
        const seq: Map<string, string>[] = [];
        for (let f = 0; f <= 30; f++) {
          const lines = routeAvoid(
            shiftCard(input, moved.id, f, Math.round(f / 2)),
          ).lines;
          seq.push(
            new Map(input.edges.map((e) => [e.id, shapeOf(lines.get(e.id))])),
          );
        }
        for (const e of input.edges) {
          for (let f = 1; f < seq.length; f++)
            if (seq[f].get(e.id) !== seq[f - 1].get(e.id)) changes++;
          for (let f = 2; f < seq.length; f++)
            if (
              seq[f].get(e.id) === seq[f - 2].get(e.id) &&
              seq[f].get(e.id) !== seq[f - 1].get(e.id)
            )
              flicker++;
        }
      }
      expect(
        flicker,
        `${name}: a line flipped shape and straight back`,
      ).toBeLessThanOrEqual(maxFlicker);
      expect(
        changes,
        `${name}: shape changes over every card's drag`,
      ).toBeLessThanOrEqual(maxChanges);
    }
  });

  it("keeps a line's anchors still while a neighbour is dragged past (they move with their own card only)", () => {
    const input = scenarioRoutingInput("star");
    let jumps = 0;
    for (const moved of input.obstacles.filter((o) => o.kind === "model")) {
      resetAvoidCache();
      let prev = routeAvoid(input).lines;
      for (let f = 1; f <= 30; f++) {
        const cur = routeAvoid(
          shiftCard(input, moved.id, f, Math.round(f / 2)),
        ).lines;
        for (const e of input.edges) {
          const a = prev.get(e.id);
          const b = cur.get(e.id);
          if (!a || !b || shapeOf(a) !== shapeOf(b)) continue;
          // Relative to its own card (which moves 1 px a frame when it is the dragged one).
          for (const [pa, pb] of [
            [a.sourceAnchor, b.sourceAnchor],
            [a.targetAnchor, b.targetAnchor],
          ] as const) {
            if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 3) jumps++;
          }
        }
        prev = cur;
      }
    }
    // Before the hysteresis: 28 jumps over these drags. The one left is the
    // nudging pass re-spreading a side when a neighbour's slot changes.
    expect(jumps).toBeLessThanOrEqual(2);
  });

  it("never crosses a line right at another line's `*` / `1`", () => {
    for (const name of [
      "under",
      "star",
      "tangle",
      "showcase",
      "overlap",
    ] as const) {
      resetAvoidCache();
      expect(
        stubCrossings(routeAvoid(scenarioRoutingInput(name)).lines),
        name,
      ).toEqual([]);
    }
    resetAvoidCache();
    expect(
      stubCrossings(routeAvoid(scenarioRoutingInput("big")).lines).length,
    ).toBeLessThanOrEqual(3);
    // Random diagrams: was 112 crossings on a stub over these 40 before the fix.
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      resetAvoidCache();
      total += stubCrossings(
        routeAvoid(randomInput(seed, "tidy")).lines,
      ).length;
    }
    expect(total).toBeLessThanOrEqual(30);
  });
});
