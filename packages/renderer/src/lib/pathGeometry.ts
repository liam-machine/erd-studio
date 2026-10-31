/**
 * Path geometry for the relationship flow glyphs: how long a drawn edge path
 * is, where its straight runs are, and the point and heading at a fraction
 * of its length.
 *
 * Reads the absolute commands the canvas draws: `M`, `L`, `H`, `V` (xyflow's
 * smooth-step path and the Legend samples), `Q` (smooth-step bends) and `C`
 * (self-loops). Curves are flattened into a few chords, which is accurate to
 * well under a pixel for the radii used here. Anything else ends the parse;
 * what was read so far is kept.
 *
 * Pure: no React, no DOM (`SVGPathElement.getTotalLength` would need a
 * mounted element and a layout).
 */

export interface PathPoint {
  x: number;
  y: number;
}

export interface PathPose extends PathPoint {
  /** Heading in degrees, along increasing path length (SVG `rotate="auto"`). */
  angle: number;
}

export interface PathGeometry {
  /** The flattened path. */
  readonly points: readonly PathPoint[];
  /** Cumulative length at each point (`cumulative[0] === 0`). */
  readonly cumulative: readonly number[];
  readonly length: number;
  /** Straight runs (`L` / `H` / `V`) as fractions of the length, in path order. */
  readonly straights: readonly { start: number; end: number }[];
}

const Q_STEPS = 4;
const C_STEPS = 12;

const COMMAND = /([MLHVQCZmlhvqcz])([^MLHVQCZmlhvqcz]*)/g;
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

/** Flatten and measure a path. An unreadable path has length 0. */
export function measurePath(d: string): PathGeometry {
  const points: PathPoint[] = [];
  const cumulative: number[] = [];
  const straightRuns: { from: number; to: number; heading: number }[] = [];
  let length = 0;
  let cur: PathPoint | null = null;

  const lineTo = (p: PathPoint) => {
    if (!cur) return;
    length += Math.hypot(p.x - cur.x, p.y - cur.y);
    points.push(p);
    cumulative.push(length);
    cur = p;
  };

  COMMAND.lastIndex = 0;
  let m: RegExpExecArray | null;
  outer: while ((m = COMMAND.exec(d)) !== null) {
    const cmd = m[1];
    const n = (m[2].match(NUMBER) ?? []).map(Number);
    switch (cmd) {
      case 'M':
        if (n.length < 2 || cur) break outer; // one subpath only
        cur = { x: n[0], y: n[1] };
        points.push(cur);
        cumulative.push(0);
        for (let i = 2; i + 1 < n.length; i += 2) straight({ x: n[i], y: n[i + 1] });
        break;
      case 'L':
        for (let i = 0; i + 1 < n.length; i += 2) straight({ x: n[i], y: n[i + 1] });
        break;
      case 'H':
        for (const x of n) if (cur) straight({ x, y: (cur as PathPoint).y });
        break;
      case 'V':
        for (const y of n) if (cur) straight({ x: (cur as PathPoint).x, y });
        break;
      case 'Q':
        for (let i = 0; i + 3 < n.length; i += 4) {
          const p0 = cur;
          if (!p0) break outer;
          const c = { x: n[i], y: n[i + 1] };
          const p1 = { x: n[i + 2], y: n[i + 3] };
          for (let s = 1; s <= Q_STEPS; s++) {
            const t = s / Q_STEPS;
            const u = 1 - t;
            lineTo({
              x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
              y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
            });
          }
        }
        break;
      case 'C':
        for (let i = 0; i + 5 < n.length; i += 6) {
          const p0 = cur;
          if (!p0) break outer;
          const c1 = { x: n[i], y: n[i + 1] };
          const c2 = { x: n[i + 2], y: n[i + 3] };
          const p1 = { x: n[i + 4], y: n[i + 5] };
          for (let s = 1; s <= C_STEPS; s++) {
            const t = s / C_STEPS;
            const u = 1 - t;
            lineTo({
              x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
              y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
            });
          }
        }
        break;
      case 'Z':
      case 'z':
        break outer;
      default:
        break outer; // relative commands: not drawn by the canvas
    }
  }

  function straight(p: PathPoint) {
    const start = cur;
    if (!start) return;
    const from = length;
    lineTo(p);
    if (length <= from) return;
    // xyflow writes a bend-free corner as a second `L` on the same line: one run.
    const heading = Math.atan2(p.y - start.y, p.x - start.x);
    const prev = straightRuns[straightRuns.length - 1];
    if (prev && prev.to === from && Math.abs(prev.heading - heading) < 1e-6) prev.to = length;
    else straightRuns.push({ from, to: length, heading });
  }

  const straights = length > 0
    ? straightRuns.map((r) => ({ start: r.from / length, end: r.to / length }))
    : [];
  return { points, cumulative, length, straights };
}

/** The point and heading at `fraction` (0..1) of the path's length. */
export function poseAt(geom: PathGeometry, fraction: number): PathPose {
  const { points, cumulative, length } = geom;
  if (points.length === 0) return { x: 0, y: 0, angle: 0 };
  if (points.length === 1 || length === 0) return { ...points[0], angle: 0 };
  const target = Math.min(1, Math.max(0, fraction)) * length;
  let i = 1;
  while (i < points.length - 1 && cumulative[i] < target) i++;
  // Skip zero-length chords so the heading is defined.
  let j = i;
  while (j < points.length - 1 && cumulative[j] === cumulative[j - 1]) j++;
  const a = points[j - 1];
  const b = points[j];
  const seg = cumulative[j] - cumulative[j - 1];
  const t = seg > 0 ? Math.min(1, Math.max(0, (target - cumulative[j - 1]) / seg)) : 0;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
  };
}

/** Straight runs shorter than this (flow px) are bend stubs, not a place for a glyph. */
const MIN_STRAIGHT_PX = 24;

/**
 * Where two still glyphs sit so that neither lands on a bend: the middle of
 * the first and of the last usable straight run, or a third and two thirds
 * of the only one. Null when the path has no usable straight run (a
 * self-loop's curve): the planner's defaults then apply.
 */
export function stillPositions(geom: PathGeometry): readonly [number, number] | null {
  if (geom.length <= 0) return null;
  const minFraction = MIN_STRAIGHT_PX / geom.length;
  const usable = geom.straights.filter((s) => s.end - s.start >= minFraction);
  if (usable.length === 0) return null;
  const first = usable[0];
  const last = usable[usable.length - 1];
  const round = (v: number) => Math.round(v * 1000) / 1000;
  if (first === last) {
    const span = first.end - first.start;
    return [round(first.start + span / 3), round(first.start + (2 * span) / 3)];
  }
  return [round((first.start + first.end) / 2), round((last.start + last.end) / 2)];
}
