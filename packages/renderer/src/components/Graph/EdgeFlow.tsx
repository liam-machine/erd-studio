/**
 * EdgeFlow — the moving direction glyphs drawn along a relationship line.
 *
 * Chevrons run from the `1` end to the `*` end; a many-to-many has two lanes
 * running opposite ways; a one-to-one has two dots meeting in the middle
 * (`lib/edgeFlow.ts` has the rule and the recipes). Each glyph is an SVG
 * `<animateMotion>` along the line's own path:
 *
 *   - `path={d}`, never `<mpath href>`: edge ids repeat when two canvases
 *     share a page, so an id reference could follow the other canvas's line.
 *   - `calcMode="linear"`: the default (`paced`) ignores `keyPoints`.
 *   - Each glyph is keyed on its recipe, so a change of direction or a switch
 *     between moving and still mounts fresh SMIL elements.
 *   - With the OS reduce-motion setting on, too many lines flowing, or a
 *     settled click selection, every glyph is still: a plain
 *     `translate() rotate()` at a point off the bends (`stillPositions`),
 *     with no SMIL at all, so it follows a swapped or re-routed line and
 *     costs nothing per frame.
 *
 * `EdgeFlow` is the canvas version: it draws nothing below `MIN_FLOW_ZOOM`
 * and scales the glyphs up as the canvas zooms out, so they stay legible.
 * `EdgeFlowGlyphs` always draws (the Legend, which is not zoomed). Neither
 * takes pointer events nor is read out by assistive technology: the line's
 * own `<title>` says what the relationship is.
 */

import { memo, useMemo } from 'react';
import { useStore } from '@xyflow/react';
import {
  planEdgeFlow,
  MIN_FLOW_ZOOM,
  MAX_GLYPH_SCALE,
  FLOW_DOT_RADIUS,
  type FlowMode,
  type GlyphSpec,
} from '../../lib/edgeFlow';
import { measurePath, poseAt, stillPositions, type PathGeometry } from '../../lib/pathGeometry';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
// The glyph colours and halo live with the edge styles.
import './FkEdge.css';

/** A filled, notched arrowhead, 8 × 9, pointing along +x (the direction of travel). */
export const CHEVRON_D = 'M -4,-4.5 L 4,0 L -4,4.5 L -1.75,0 Z';

/**
 * Many-to-many lanes sit 3.5px to one side of travel; the two lanes face
 * opposite ways, so they land on opposite sides of the line.
 */
const LANE_OFFSET_Y = -3.5;

export interface EdgeFlowProps {
  /** The line's path data, exactly as drawn. */
  d: string;
  mode: FlowMode;
  /** Path length in flow pixels when `d` cannot be measured; otherwise unused. */
  length?: number;
  /** False: stand still (too many lines flowing, or a settled selection). */
  animate: boolean;
  /** Colour key: a stage (`logical`, `physical`, `ghost`) or `discrepancy-<status>`. */
  statusKey: string;
  /** Glyph size factor (1 = 8 flow px). `EdgeFlow` sets it from the zoom. */
  glyphScale?: number;
}

/** Scale, then (many-to-many) the lane offset, in the glyph's own frame. */
function glyphTransform(mode: FlowMode, scale: number): string | undefined {
  const parts: string[] = [];
  if (scale !== 1) parts.push(`scale(${scale})`);
  if (mode === 'both') parts.push(`translate(0,${LANE_OFFSET_Y})`);
  return parts.length ? parts.join(' ') : undefined;
}

function stillTransform(geom: PathGeometry, g: GlyphSpec): string {
  const pose = poseAt(geom, g.at ?? 0.5);
  const angle = g.rotate === 'auto-reverse' ? pose.angle + 180 : pose.angle;
  const r = (v: number) => Math.round(v * 100) / 100;
  return `translate(${r(pose.x)},${r(pose.y)}) rotate(${r(angle)})`;
}

function EdgeFlowGlyphsComponent({ d, mode, length, animate, statusKey, glyphScale = 1 }: EdgeFlowProps) {
  const reduced = usePrefersReducedMotion();
  const geom = useMemo(() => measurePath(d), [d]);
  // Bucketed so a few pixels of layout jitter reuse the same recipes.
  const bucketedLength = Math.round((geom.length > 0 ? geom.length : length ?? 0) / 8) * 8;
  const still = !animate || reduced;
  const stillAt = still ? stillPositions(geom) : null;
  const stillA = stillAt?.[0];
  const stillB = stillAt?.[1];
  const specs = useMemo(
    () => planEdgeFlow(mode, bucketedLength, {
      animate,
      reducedMotion: reduced,
      stillAt: stillA !== undefined && stillB !== undefined ? [stillA, stillB] : null,
      glyphScale,
    }),
    [mode, bucketedLength, animate, reduced, stillA, stillB, glyphScale],
  );

  return (
    <g className={`fk-edge__flow fk-edge__flow--${statusKey}`} aria-hidden="true" pointerEvents="none">
      {specs.map((g, i) => {
        const shape = g.kind === 'chevron'
          ? <path className="fk-edge__flow-chevron" d={CHEVRON_D} />
          : <circle className="fk-edge__flow-dot" r={FLOW_DOT_RADIUS} />;
        const inner = <g transform={glyphTransform(mode, glyphScale)}>{shape}</g>;
        // Keyed on the recipe: a new direction, mode or still/moving switch
        // remounts the glyph rather than editing a running SMIL element.
        const key = `${mode}:${g.still ? 'still' : 'move'}:${g.kind}:${g.lane}:${g.rotate}:${i}`;
        if (g.still) {
          return (
            <g key={key} className="fk-edge__flow-glyph" transform={stillTransform(geom, g)}>
              {inner}
            </g>
          );
        }
        return (
          <g key={key} className="fk-edge__flow-glyph">
            <animateMotion
              path={d}
              calcMode="linear"
              keyPoints={g.keyPoints}
              keyTimes={g.keyTimes}
              rotate={g.rotate}
              dur={g.dur}
              begin={g.begin}
              repeatCount="indefinite"
            />
            {g.opacityValues && (
              <animate
                attributeName="opacity"
                values={g.opacityValues}
                keyTimes={g.opacityKeyTimes}
                dur={g.dur}
                begin={g.begin}
                repeatCount="indefinite"
              />
            )}
            {inner}
          </g>
        );
      })}
    </g>
  );
}

/** The glyphs at any zoom (for the Legend). */
export const EdgeFlowGlyphs = memo(EdgeFlowGlyphsComponent);

/**
 * The glyph scale for a zoom: 0 below `MIN_FLOW_ZOOM` (draw nothing), else
 * 1 / zoom rounded up to a quarter and clamped to 1..`MAX_GLYPH_SCALE`, so a
 * glyph stays about 8 screen px or more and the value changes rarely.
 */
export function glyphScaleForZoom(zoom: number): number {
  if (!(zoom >= MIN_FLOW_ZOOM)) return 0;
  const scale = Math.ceil((1 / zoom) * 4 - 1e-9) / 4;
  return Math.min(MAX_GLYPH_SCALE, Math.max(1, scale));
}

function EdgeFlowComponent(props: EdgeFlowProps) {
  // A store without `transform` (a test double) counts as zoom 1.
  const scale = useStore((s) => glyphScaleForZoom((s as { transform?: [number, number, number] }).transform?.[2] ?? 1));
  if (scale === 0) return null;
  return <EdgeFlowGlyphs {...props} glyphScale={scale} />;
}

/** The glyphs on the canvas: nothing below `MIN_FLOW_ZOOM`, larger when zoomed out. */
export const EdgeFlow = memo(EdgeFlowComponent);
