/**
 * FkEdge — custom React Flow edge for displaying FK relationships.
 *
 * Renders a smooth-step path with Power BI-style cardinality labels:
 * `*` for "many" and `1` for "one", positioned near each endpoint.
 * Built relationships are blue; design relationships are orange.
 * One-to-one edges use a dashed line style.
 *
 * The edge line stops short of the node so the cardinality label sits
 * in the gap between the line end and the node boundary.
 *
 * Edges connect to node-level handles (top/right/bottom/left) rather
 * than column-specific handles, choosing the side that creates the
 * least bends.
 */

import { memo } from 'react';
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  Position,
  type EdgeProps,
} from '@xyflow/react';
import type { FkFlowEdge } from '../../types/graph';
import './FkEdge.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How far (px) to shorten the edge path on each end (leaves room for label). */
const PATH_GAP = 20;

/** How far (px) from the node boundary to place the cardinality label. */
const LABEL_OFFSET = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Offset a point away from its node along the edge direction.
 * `position` is the handle side (Right/Left/Top/Bottom).
 */
function offsetPoint(
  x: number,
  y: number,
  position: Position,
  distance: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Right:
      return { x: x + distance, y };
    case Position.Left:
      return { x: x - distance, y };
    case Position.Bottom:
      return { x, y: y + distance };
    case Position.Top:
      return { x, y: y - distance };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function FkEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<FkFlowEdge>) {
  if (!data) return null;
  const { cardinality, status } = data;

  // Shorten the path so the line stops before the node, leaving room
  // for the cardinality label in the gap.
  const src = offsetPoint(sourceX, sourceY, sourcePosition, PATH_GAP);
  const tgt = offsetPoint(targetX, targetY, targetPosition, PATH_GAP);

  const [edgePath] = getSmoothStepPath({
    sourceX: src.x,
    sourceY: src.y,
    targetX: tgt.x,
    targetY: tgt.y,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });

  const statusClass = `fk-edge--${status}`;
  const cardinalityClass =
    cardinality === 'one-to-one' ? 'fk-edge--one-to-one' : '';

  // Cardinality labels: many-to-one → source is *, target is 1
  // one-to-one → both sides are 1
  const sourceLabel = cardinality === 'many-to-one' ? '*' : '1';
  const targetLabel = '1';
  const srcLabelClass = sourceLabel === '*' ? ' fk-edge__label--many' : '';
  const tgtLabelClass = '';

  // Labels sit close to the node, in the gap before the shortened path.
  const srcLabel = offsetPoint(sourceX, sourceY, sourcePosition, LABEL_OFFSET);
  const tgtLabel = offsetPoint(targetX, targetY, targetPosition, LABEL_OFFSET);

  return (
    <>
      <path
        id={id}
        d={edgePath}
        className={`fk-edge ${statusClass} ${cardinalityClass}`}
      />
      {/* Invisible wider path for easier hover/click targeting */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ pointerEvents: 'stroke' }}
      />
      <EdgeLabelRenderer>
        <span
          className={`fk-edge__label fk-edge__label--${status}${srcLabelClass}`}
          style={{
            transform: `translate(-50%, -50%) translate(${srcLabel.x}px, ${srcLabel.y}px)`,
          }}
        >
          {sourceLabel}
        </span>
        <span
          className={`fk-edge__label fk-edge__label--${status}${tgtLabelClass}`}
          style={{
            transform: `translate(-50%, -50%) translate(${tgtLabel.x}px, ${tgtLabel.y}px)`,
          }}
        >
          {targetLabel}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

export const FkEdge = memo(FkEdgeComponent);
