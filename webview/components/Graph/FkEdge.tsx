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

import { memo, useMemo } from 'react';
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  Position,
  useStore,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react';
import type { FkFlowEdge } from '../../types/graph';
import {
  calculateEdgeOffset,
  parseSideFromHandle,
  getSideLength,
  type NodePositionMap,
} from '../../lib/edgeDistribution';
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
  sourceHandleId,
  targetHandleId,
  data,
}: EdgeProps<FkFlowEdge>) {
  // Access all edges from React Flow store for distribution calculation
  const allEdges = useStore((state) => state.edges);

  // Access node lookup for building position map
  const nodeLookup = useStore((state) => state.nodeLookup);

  // Get source and target node dimensions for calculating side lengths
  const sourceNode = useInternalNode(data?.fromModel ?? '');
  const targetNode = useInternalNode(data?.toModel ?? '');

  // Build position map for spatial edge sorting
  // Memoized to avoid rebuilding when unrelated state changes
  const nodePositions = useMemo((): NodePositionMap => {
    const positions: NodePositionMap = new Map();
    for (const [nodeId, node] of nodeLookup) {
      if (node.internals?.positionAbsolute) {
        positions.set(nodeId, node.internals.positionAbsolute);
      } else if (node.position) {
        positions.set(nodeId, node.position);
      }
    }
    return positions;
  }, [nodeLookup]);

  if (!data) return null;
  const { cardinality, status, fromModel, toModel, dimmed } = data;

  // Parse which side each handle is on (top/right/bottom/left)
  const sourceSide = parseSideFromHandle(sourceHandleId);
  const targetSide = parseSideFromHandle(targetHandleId);

  // Calculate distribution offsets to spread multiple edges along node sides
  let adjustedSourceX = sourceX;
  let adjustedSourceY = sourceY;
  let adjustedTargetX = targetX;
  let adjustedTargetY = targetY;

  if (sourceSide) {
    const sideLength = getSideLength(sourceSide, sourceNode?.measured);
    const sourceOffset = calculateEdgeOffset(
      id,
      fromModel,
      sourceSide,
      true, // isSource
      allEdges,
      sideLength,
      nodePositions,
    );
    adjustedSourceX += sourceOffset.x;
    adjustedSourceY += sourceOffset.y;
  }

  if (targetSide) {
    const sideLength = getSideLength(targetSide, targetNode?.measured);
    const targetOffset = calculateEdgeOffset(
      id,
      toModel,
      targetSide,
      false, // isSource
      allEdges,
      sideLength,
      nodePositions,
    );
    adjustedTargetX += targetOffset.x;
    adjustedTargetY += targetOffset.y;
  }

  // Shorten the path so the line stops before the node, leaving room
  // for the cardinality label in the gap.
  const src = offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, PATH_GAP);
  const tgt = offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, PATH_GAP);

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
  // Apply special styling for one-to-one (dashed) and many-to-many (dotted)
  let cardinalityClass = '';
  if (cardinality === 'one-to-one') {
    cardinalityClass = 'fk-edge--one-to-one';
  } else if (cardinality === 'many-to-many') {
    cardinalityClass = 'fk-edge--many-to-many';
  }

  // Cardinality labels at each end:
  // - many-to-one: * at source, 1 at target
  // - one-to-one: 1 at both ends
  // - one-to-many: 1 at source, * at target
  // - many-to-many: * at both ends
  let sourceLabel: string;
  let targetLabel: string;
  switch (cardinality) {
    case 'many-to-one':
      sourceLabel = '*';
      targetLabel = '1';
      break;
    case 'one-to-one':
      sourceLabel = '1';
      targetLabel = '1';
      break;
    case 'one-to-many':
      sourceLabel = '1';
      targetLabel = '*';
      break;
    case 'many-to-many':
      sourceLabel = '*';
      targetLabel = '*';
      break;
    default:
      sourceLabel = '*';
      targetLabel = '1';
  }
  const srcLabelClass = sourceLabel === '*' ? ' fk-edge__label--many' : '';
  const tgtLabelClass = targetLabel === '*' ? ' fk-edge__label--many' : '';

  // Labels sit close to the node, in the gap before the shortened path.
  // Use adjusted coordinates so labels align with distributed connection points.
  const srcLabel = offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, LABEL_OFFSET);
  const tgtLabel = offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, LABEL_OFFSET);

  return (
    <>
      <path
        id={id}
        d={edgePath}
        className={`fk-edge ${statusClass} ${cardinalityClass}${dimmed ? ' fk-edge--dimmed' : ''}`}
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
          className={`fk-edge__label fk-edge__label--${status}${srcLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${srcLabel.x}px, ${srcLabel.y}px)`,
          }}
        >
          {sourceLabel}
        </span>
        <span
          className={`fk-edge__label fk-edge__label--${status}${tgtLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}`}
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
