/**
 * Relationship flow — the moving arrows on the lines of a focused table.
 *
 * The rule: glyphs travel from the `1` end to the `*` end, the way one
 * customer fans out to many orders (Power BI's filter arrow, matching the
 * `*` / `1` labels the canvas already draws). The edge path runs from the
 * source (`fromModel`) to the target (`toModel`), so:
 *
 *   | cardinality    | mode      | glyphs                                  |
 *   |----------------|-----------|-----------------------------------------|
 *   | many-to-one    | `reverse` | chevrons, target → source               |
 *   | one-to-many    | `forward` | chevrons, source → target               |
 *   | many-to-many   | `both`    | two lanes of chevrons, opposite ways    |
 *   | one-to-one     | `meet`    | two dots that meet in the middle        |
 *   | anything else  | `reverse` | as the default labels (`*` at source)   |
 *   | `missing`      | none      | motion would claim the link exists here |
 *
 * `flowModeFor` is the one place to flip the convention.
 *
 * `planEdgeFlow` turns a mode and a path length into glyph recipes
 * (`GlyphSpec`). Pure: no React, no DOM. A moving glyph is an SVG
 * `<animateMotion>`; durations are bucketed so a few pixels of layout jitter
 * do not restart the animation, and the glyph count is capped. With motion
 * off (too many flowing lines, a click selection that has settled, or the
 * user's reduce-motion setting) every glyph is `still`: a plain transform at
 * a fixed point on the line, still pointing the right way. Still glyphs are
 * deliberately not a frozen SMIL frame: once a `fill="freeze"` interval ends,
 * Chrome stops applying later `path` / `rotate` / `keyPoints` changes, so a
 * swapped or re-routed line would keep a stale arrow.
 */

import type { FkEdgeData } from '../types/graph';

export const FLOW_SPEED_PX_S = 56;
export const FLOW_SPACING_PX = 90;
/** A one-way line always has at least two arrows, so one is always on screen. */
export const FLOW_MIN_GLYPHS = 2;
export const FLOW_MAX_GLYPHS = 4;
export const FLOW_MIN_DUR_S = 1.6;
export const FLOW_MAX_DUR_S = 7;
export const FLOW_DUR_BUCKET_S = 0.5;
export const MANY_MANY_SPACING_PX = 140;
export const MANY_MANY_MAX_PER_LANE = 3;
export const ONE_ONE_CYCLE_S = 1.8;
/** Below this zoom the glyphs would be sub-pixel noise, so none are drawn. */
export const MIN_FLOW_ZOOM = 0.35;
/** Glyphs grow as the canvas zooms out, up to this factor, so they stay legible. */
export const MAX_GLYPH_SCALE = 2.5;
/** Radius of a one-to-one dot, in flow px at scale 1. */
export const FLOW_DOT_RADIUS = 3.25;

export type FlowMode = 'forward' | 'reverse' | 'both' | 'meet';

export interface GlyphSpec {
  kind: 'chevron' | 'dot';
  /** 0 or 1; lanes only differ for `both`. */
  lane: 0 | 1;
  /** `<animateMotion keyPoints>`; for a still glyph, `p;p` (its fixed point). */
  keyPoints: string;
  rotate: 'auto' | 'auto-reverse';
  keyTimes: string;
  dur: string;
  begin: string;
  /** True: drawn at `at` with a plain transform, no animation. */
  still: boolean;
  /** A still glyph's position, as a fraction of the path length. */
  at?: number;
  opacityValues?: string;
  opacityKeyTimes?: string;
}

export interface FlowPlanOptions {
  animate: boolean;
  reducedMotion: boolean;
  /**
   * Where a one-way or many-to-many line's two still glyphs sit (fractions of
   * its length), chosen off the bends (`stillPositions`). Defaults to
   * 0.25 / 0.75, or 0.2 / 0.8 for many-to-many.
   */
  stillAt?: readonly [number, number] | null;
  /** How much the glyphs are scaled up (zoomed-out canvas); spaces the one-to-one dots. */
  glyphScale?: number;
}

/** The flow mode for a line, or null when it must not move (`missing`). */
export function flowModeFor(
  cardinality: string | undefined,
  status?: FkEdgeData['discrepancyStatus'],
): FlowMode | null {
  if (status === 'missing') return null;
  switch (cardinality) {
    case 'one-to-many':
      return 'forward';
    case 'many-to-many':
      return 'both';
    case 'one-to-one':
      return 'meet';
    case 'many-to-one':
    default:
      return 'reverse';
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Seconds for one pass along a line of this length, bucketed and clamped. */
export function flowDuration(length: number): number {
  const raw = Math.round(length / FLOW_SPEED_PX_S / FLOW_DUR_BUCKET_S) * FLOW_DUR_BUCKET_S;
  return clamp(raw, FLOW_MIN_DUR_S, FLOW_MAX_DUR_S);
}

/** Seconds as an SVG clock value, without float noise ("-0.875s"). */
function secs(v: number): string {
  const rounded = Math.round(v * 1000) / 1000;
  return `${rounded === 0 ? 0 : rounded}s`;
}

function frac(v: number): number {
  return Math.round(v * 1000) / 1000;
}

const STREAM_OPACITY = { opacityValues: '0;1;1;0', opacityKeyTimes: '0;0.1;0.9;1' };
/** Glide in, meet, dissolve, then a short rest (about 0.3s of the 1.8s cycle). */
const MEET_OPACITY = { opacityValues: '0;1;1;0;0', opacityKeyTimes: '0;0.12;0.6;0.83;1' };
const MEET_KEY_TIMES = '0;0.6;1';

/**
 * Half the distance (as a fraction of the line) between the two one-to-one
 * dots where they meet, so they stop just short of touching.
 */
function meetHalfGap(length: number, scale: number): number {
  if (length <= 0) return 0.03;
  return clamp((FLOW_DOT_RADIUS * scale + 1.5) / length, 0.02, 0.2);
}

function still(kind: GlyphSpec['kind'], lane: 0 | 1, p: number, rotate: GlyphSpec['rotate']): GlyphSpec {
  const at = frac(clamp(p, 0, 1));
  return {
    kind,
    lane,
    keyPoints: `${at};${at}`,
    rotate,
    keyTimes: '0;1',
    dur: '0s',
    begin: '0s',
    still: true,
    at,
  };
}

function stream(
  lane: 0 | 1,
  direction: 'forward' | 'reverse',
  count: number,
  dur: number,
  offset: number,
): GlyphSpec[] {
  const specs: GlyphSpec[] = [];
  for (let i = 0; i < count; i++) {
    specs.push({
      kind: 'chevron',
      lane,
      keyPoints: direction === 'forward' ? '0;1' : '1;0',
      rotate: direction === 'forward' ? 'auto' : 'auto-reverse',
      keyTimes: '0;1',
      dur: secs(dur),
      begin: secs(-(i * dur / count + offset)),
      still: false,
      ...STREAM_OPACITY,
    });
  }
  return specs;
}

/** The glyph recipes for one line. */
export function planEdgeFlow(mode: FlowMode, length: number, opts: FlowPlanOptions): GlyphSpec[] {
  const scale = opts.glyphScale ?? 1;
  const half = meetHalfGap(length, scale);

  if (!opts.animate || opts.reducedMotion) {
    const [a, b] = opts.stillAt ?? (mode === 'both' ? [0.2, 0.8] : [0.25, 0.75]);
    switch (mode) {
      case 'forward':
        return [still('chevron', 0, a, 'auto'), still('chevron', 0, b, 'auto')];
      case 'reverse':
        return [still('chevron', 0, a, 'auto-reverse'), still('chevron', 0, b, 'auto-reverse')];
      case 'both':
        return [still('chevron', 0, a, 'auto'), still('chevron', 1, b, 'auto-reverse')];
      case 'meet': {
        // Apart enough to read as two dots, off the middle bend.
        const gap = Math.max(0.08, 2 * half);
        return [still('dot', 0, 0.5 - gap, 'auto'), still('dot', 0, 0.5 + gap, 'auto')];
      }
    }
  }

  const dur = flowDuration(length);
  switch (mode) {
    case 'forward':
    case 'reverse': {
      const n = clamp(Math.round(length / FLOW_SPACING_PX), FLOW_MIN_GLYPHS, FLOW_MAX_GLYPHS);
      return stream(0, mode, n, dur, 0);
    }
    case 'both': {
      const n = clamp(Math.round(length / MANY_MANY_SPACING_PX), 1, MANY_MANY_MAX_PER_LANE);
      return [...stream(0, 'forward', n, dur, 0), ...stream(1, 'reverse', n, dur, dur / (2 * n))];
    }
    case 'meet': {
      const base = {
        kind: 'dot' as const,
        lane: 0 as const,
        rotate: 'auto' as const,
        keyTimes: MEET_KEY_TIMES,
        dur: secs(ONE_ONE_CYCLE_S),
        begin: '0s',
        still: false,
        ...MEET_OPACITY,
      };
      const left = frac(0.5 - half);
      const right = frac(0.5 + half);
      return [
        { ...base, keyPoints: `0;${left};${left}` },
        { ...base, keyPoints: `1;${right};${right}` },
      ];
    }
  }
}
