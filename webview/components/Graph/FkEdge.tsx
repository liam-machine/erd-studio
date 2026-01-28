/**
 * FkEdge — custom React Flow edge for displaying FK relationships.
 *
 * Renders a smooth-step path with Power BI-style cardinality labels:
 * `*` for "many" and `1` for "one", positioned near each endpoint.
 * Built relationships are blue; design relationships are orange.
 * One-to-one edges use a dashed line style.
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

/** Offset (px) from the endpoint to position the cardinality label. */
const LABEL_OFFSET = 18;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the (x, y) position for a cardinality label near an endpoint.
 * The label is offset away from the node, along the edge direction.
 */
function labelPosition(
  x: number,
  y: number,
  position: Position,
): { x: number; y: number } {
  switch (position) {
    case Position.Right:
      return { x: x + LABEL_OFFSET, y };
    case Position.Left:
      return { x: x - LABEL_OFFSET, y };
    case Position.Bottom:
      return { x, y: y + LABEL_OFFSET };
    case Position.Top:
      return { x, y: y - LABEL_OFFSET };
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

  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
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

  const srcPos = labelPosition(sourceX, sourceY, sourcePosition);
  const tgtPos = labelPosition(targetX, targetY, targetPosition);

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
          className={`fk-edge__label fk-edge__label--${status}`}
          style={{
            transform: `translate(-50%, -50%) translate(${srcPos.x}px, ${srcPos.y}px)`,
          }}
        >
          {sourceLabel}
        </span>
        <span
          className={`fk-edge__label fk-edge__label--${status}`}
          style={{
            transform: `translate(-50%, -50%) translate(${tgtPos.x}px, ${tgtPos.y}px)`,
          }}
        >
          {targetLabel}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

export const FkEdge = memo(FkEdgeComponent);
