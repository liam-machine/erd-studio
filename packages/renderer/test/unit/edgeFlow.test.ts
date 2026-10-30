/**
 * The flow recipes: arrows travel from the `1` end to the `*` end, both ways
 * for many-to-many, two dots meet for one-to-one, nothing on a `missing` line,
 * and still glyphs (still pointing the right way) without motion.
 */
import { describe, it, expect } from 'vitest';
import {
  flowModeFor,
  planEdgeFlow,
  flowDuration,
  FLOW_MIN_GLYPHS,
  FLOW_MAX_GLYPHS,
  MANY_MANY_MAX_PER_LANE,
  FLOW_MIN_DUR_S,
  FLOW_MAX_DUR_S,
  type GlyphSpec,
} from '../../src/lib/edgeFlow';

const MOVING = { animate: true, reducedMotion: false };
const secs = (s: string) => parseFloat(s);

describe('flowModeFor', () => {
  it('maps each cardinality to its direction', () => {
    expect(flowModeFor('many-to-one')).toBe('reverse');
    expect(flowModeFor('one-to-many')).toBe('forward');
    expect(flowModeFor('many-to-many')).toBe('both');
    expect(flowModeFor('one-to-one')).toBe('meet');
  });

  it('defaults an unknown cardinality to reverse, as the labels default to * at the source', () => {
    expect(flowModeFor(undefined)).toBe('reverse');
    expect(flowModeFor('zero-or-more')).toBe('reverse');
  });

  it('never flows on a missing line; extra and mismatched lines flow', () => {
    expect(flowModeFor('many-to-one', 'missing')).toBeNull();
    expect(flowModeFor('one-to-one', 'missing')).toBeNull();
    expect(flowModeFor('many-to-one', 'extra')).toBe('reverse');
    expect(flowModeFor('one-to-many', 'cardinality-mismatch')).toBe('forward');
  });
});

describe('planEdgeFlow — one-way streams', () => {
  it('many-to-one: chevrons travel target → source, facing the way they move', () => {
    const specs = planEdgeFlow('reverse', 300, MOVING);
    for (const g of specs) {
      expect(g.kind).toBe('chevron');
      expect(g.keyPoints).toBe('1;0');
      expect(g.rotate).toBe('auto-reverse');
      expect(g.still).toBe(false);
      expect(g.opacityValues).toBe('0;1;1;0');
      expect(g.opacityKeyTimes).toBe('0;0.1;0.9;1');
    }
  });

  it('one-to-many: chevrons travel source → target', () => {
    for (const g of planEdgeFlow('forward', 300, MOVING)) {
      expect(g.keyPoints).toBe('0;1');
      expect(g.rotate).toBe('auto');
    }
  });

  it('spaces glyphs about 90px apart, between 2 (one always on screen) and 4', () => {
    expect(FLOW_MIN_GLYPHS).toBe(2);
    expect(planEdgeFlow('forward', 10, MOVING)).toHaveLength(2);
    expect(planEdgeFlow('reverse', 120, MOVING)).toHaveLength(2);
    expect(planEdgeFlow('forward', 180, MOVING)).toHaveLength(2);
    expect(planEdgeFlow('forward', 270, MOVING)).toHaveLength(3);
    expect(planEdgeFlow('forward', 5000, MOVING)).toHaveLength(FLOW_MAX_GLYPHS);
  });

  it('buckets the duration to 0.5s and clamps it to 1.6–7s', () => {
    expect(flowDuration(10)).toBe(FLOW_MIN_DUR_S);
    expect(flowDuration(5000)).toBe(FLOW_MAX_DUR_S);
    expect(flowDuration(224)).toBe(4); // 224 / 56 = 4
    expect(flowDuration(238)).toBe(4.5); // 4.25 → 4.5
    expect(flowDuration(230)).toBe(4); // 4.1 → 4
    expect(planEdgeFlow('forward', 224, MOVING)[0].dur).toBe('4s');
  });

  it('staggers glyphs evenly with negative begins', () => {
    const specs = planEdgeFlow('forward', 224, MOVING); // 2 glyphs (224/90 ≈ 2.5 → 2), dur 4s
    expect(specs.map((g) => g.begin)).toEqual(['0s', '-2s']);
    const four = planEdgeFlow('reverse', 400, MOVING); // 4 glyphs, dur 7s
    expect(four.map((g) => secs(g.begin))).toEqual([0, -1.75, -3.5, -5.25]);
  });
});

describe('planEdgeFlow — many-to-many and one-to-one', () => {
  it('both: two lanes in opposite directions, up to 3 each, interleaved', () => {
    const specs = planEdgeFlow('both', 280, MOVING); // 2 per lane, dur 5s
    const lane0 = specs.filter((g) => g.lane === 0);
    const lane1 = specs.filter((g) => g.lane === 1);
    expect(lane0).toHaveLength(2);
    expect(lane1).toHaveLength(2);
    for (const g of lane0) expect([g.keyPoints, g.rotate]).toEqual(['0;1', 'auto']);
    for (const g of lane1) expect([g.keyPoints, g.rotate]).toEqual(['1;0', 'auto-reverse']);
    expect(lane0.map((g) => secs(g.begin))).toEqual([0, -2.5]);
    expect(lane1.map((g) => secs(g.begin))).toEqual([-1.25, -3.75]);
    const long = planEdgeFlow('both', 5000, MOVING);
    expect(long.filter((g) => g.lane === 0)).toHaveLength(MANY_MANY_MAX_PER_LANE);
    expect(long.filter((g) => g.lane === 1)).toHaveLength(MANY_MANY_MAX_PER_LANE);
  });

  it('meet: exactly two dots that glide to the middle, stop just short of touching and dissolve', () => {
    const specs = planEdgeFlow('meet', 300, MOVING);
    expect(specs).toHaveLength(2);
    expect(specs.every((g) => g.kind === 'dot')).toBe(true);
    // (3.25 radius + 1.5) / 300 → 0.016, floored at 0.02.
    expect(specs.map((g) => g.keyPoints)).toEqual(['0;0.48;0.48', '1;0.52;0.52']);
    for (const g of specs) {
      expect(g.keyTimes).toBe('0;0.6;1');
      expect(g.dur).toBe('1.8s');
      expect(g.begin).toBe('0s');
      expect(g.opacityValues).toBe('0;1;1;0;0');
      // Rest (both dots gone) is the last 17% of 1.8s: about 0.3s.
      expect(g.opacityKeyTimes).toBe('0;0.12;0.6;0.83;1');
    }
  });

  it('meet: the dots stay apart on a short line and when scaled up', () => {
    const at = (specs: GlyphSpec[]) => specs.map((g) => parseFloat(g.keyPoints.split(';')[1]));
    const [l, r] = at(planEdgeFlow('meet', 60, MOVING));
    // Centres at least 2 × (radius + 1.5) px apart on a 60px line.
    expect((r - l) * 60).toBeGreaterThanOrEqual(2 * 4.75 - 0.1);
    const [ls, rs] = at(planEdgeFlow('meet', 300, { ...MOVING, glyphScale: 2 }));
    expect((rs - ls) * 300).toBeGreaterThanOrEqual(2 * (3.25 * 2 + 1.5) - 0.2);
  });

  it('draws something different for every cardinality', () => {
    const signature = (specs: GlyphSpec[]) => specs.map((g) => `${g.kind}:${g.keyPoints}:${g.rotate}`).join('|');
    const sigs = (['many-to-one', 'one-to-many', 'many-to-many', 'one-to-one'] as const)
      .map((c) => signature(planEdgeFlow(flowModeFor(c)!, 300, MOVING)));
    expect(new Set(sigs).size).toBe(4);
  });
});

describe('planEdgeFlow — still glyphs', () => {
  for (const opts of [{ animate: false, reducedMotion: false }, { animate: true, reducedMotion: true }]) {
    it(`stands every glyph still (${JSON.stringify(opts)}) but keeps the direction`, () => {
      for (const mode of ['forward', 'reverse', 'both', 'meet'] as const) {
        const specs = planEdgeFlow(mode, 300, opts);
        expect(specs.length).toBeGreaterThan(0);
        for (const g of specs) {
          expect(g.still).toBe(true);
          expect(g.at).toBeGreaterThan(0);
          expect(g.at).toBeLessThan(1);
          expect(g.keyPoints).toBe(`${g.at};${g.at}`);
          expect(g.opacityValues).toBeUndefined();
        }
      }
      // Off the middle bend by default.
      expect(planEdgeFlow('forward', 300, opts).map((g) => [g.kind, g.at, g.rotate]))
        .toEqual([['chevron', 0.25, 'auto'], ['chevron', 0.75, 'auto']]);
      expect(planEdgeFlow('reverse', 300, opts).every((g) => g.kind === 'chevron' && g.rotate === 'auto-reverse')).toBe(true);
      expect(planEdgeFlow('both', 300, opts).map((g) => [g.lane, g.at, g.rotate]))
        .toEqual([[0, 0.2, 'auto'], [1, 0.8, 'auto-reverse']]);
      const dots = planEdgeFlow('meet', 300, opts);
      expect(dots.map((g) => g.kind)).toEqual(['dot', 'dot']);
      expect(dots.map((g) => g.at)).toEqual([0.42, 0.58]);
    });
  }

  it('puts still glyphs where the caller found straight runs', () => {
    const still = { animate: false, reducedMotion: false, stillAt: [0.1, 0.9] as const };
    expect(planEdgeFlow('reverse', 300, still).map((g) => g.at)).toEqual([0.1, 0.9]);
    expect(planEdgeFlow('both', 300, still).map((g) => [g.lane, g.at])).toEqual([[0, 0.1], [1, 0.9]]);
  });
});
