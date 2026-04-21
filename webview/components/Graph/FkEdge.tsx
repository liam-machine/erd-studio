/**
 * FkEdge — custom React Flow edge for displaying FK relationships.
 *
 * Renders a smooth-step path with Power BI-style cardinality labels:
 * `*` for "many" and `1` for "one", positioned near each endpoint.
 * Built relationships are blue; design relationships are orange.
 * All edges use a solid line style.
 *
 * The edge line stops short of the node so the cardinality label sits
 * in the gap between the line end and the node boundary.
 *
 * Edges connect to node-level handles (top/right/bottom/left) rather
 * than column-specific handles, choosing the side that creates the
 * least bends.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  Position,
  useStore,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react';
import type { FkFlowEdge } from '../../types/graph';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { swapCardinality } from '../../lib/cardinalityUtils';
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

/**
 * Radius (px) of the arc drawn for self-reference edges. The loop exits the
 * top of the node, arcs outward past the top-right corner, and re-enters the
 * right side. A larger radius means the loop extends further from the node.
 */
const SELF_LOOP_RADIUS = 55;

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

  const vscode = useVsCodeApi();
  const [hovered, setHovered] = useState(false);

  const handleSwap = useCallback(
    (e: React.MouseEvent) => {
      if (!data) return;
      e.stopPropagation();
      vscode.postMessage({
        type: 'updateRelationship',
        payload: {
          fromModel: data.fromModel,
          fromColumn: data.fromColumn,
          toModel: data.toModel,
          toColumn: data.toColumn,
          cardinality: swapCardinality(data.cardinality),
        },
      });
    },
    [vscode, data],
  );

  if (!data) return null;
  const { cardinality, stage, discrepancyStatus, fromModel, toModel, dimmed, readOnly, isSelfLoop } = data;

  // For cardinality mismatch edges, pull the mismatch details from the report
  // The edge data only has status — we need to find the original relationship discrepancy
  // to get both cardinalities. For now, we show a visual indicator on the edge itself.

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

  // Self-refs use a cubic bezier arcing outward past the top-right corner.
  // Both control points are pulled diagonally north-east so the curve sweeps
  // *around* the corner instead of sagging through it — perpendicular-only
  // control points let the midsection collapse onto the node corner.
  const edgePath = isSelfLoop
    ? `M ${src.x},${src.y} C ${src.x + SELF_LOOP_RADIUS},${src.y - SELF_LOOP_RADIUS} ${tgt.x + SELF_LOOP_RADIUS},${tgt.y - SELF_LOOP_RADIUS} ${tgt.x},${tgt.y}`
    : getSmoothStepPath({
        sourceX: src.x,
        sourceY: src.y,
        targetX: tgt.x,
        targetY: tgt.y,
        sourcePosition,
        targetPosition,
        borderRadius: 8,
      })[0];

  const statusClass = discrepancyStatus
    ? `fk-edge--discrepancy-${discrepancyStatus}`
    : `fk-edge--${stage ?? 'logical'}`;
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

  // Use discrepancy colour for labels when edge has a discrepancy status
  const labelColorClass = discrepancyStatus
    ? `fk-edge__label--discrepancy-${discrepancyStatus}`
    : `fk-edge__label--${stage ?? 'logical'}`;

  // Labels sit close to the node, in the gap before the shortened path.
  // Use adjusted coordinates so labels align with distributed connection points.
  const srcLabel = offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, LABEL_OFFSET);
  const tgtLabel = offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, LABEL_OFFSET);

  // Midpoint for cardinality mismatch badge / swap button.
  // For self-loops the straight midpoint falls inside the node; instead we
  // compute the bezier's exact midpoint at t=0.5, which sits northeast of
  // the top-right corner. (Derived from B(0.5) with diagonal control points:
  // the R terms aggregate to 0.75·R along each axis.)
  const midX = isSelfLoop
    ? (src.x + tgt.x) / 2 + SELF_LOOP_RADIUS * 0.75
    : (adjustedSourceX + adjustedTargetX) / 2;
  const midY = isSelfLoop
    ? (src.y + tgt.y) / 2 - SELF_LOOP_RADIUS * 0.75
    : (adjustedSourceY + adjustedTargetY) / 2;

  return (
    <>
      <path
        id={id}
        d={edgePath}
        className={`fk-edge ${statusClass}${dimmed ? ' fk-edge--dimmed' : ''}`}
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
          className={`fk-edge__label ${labelColorClass}${srcLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${srcLabel.x}px, ${srcLabel.y}px)`,
          }}
        >
          {sourceLabel}
        </span>
        <span
          className={`fk-edge__label ${labelColorClass}${tgtLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${tgtLabel.x}px, ${tgtLabel.y}px)`,
          }}
        >
          {targetLabel}
        </span>
        {discrepancyStatus === 'cardinality-mismatch' && (
          <span
            className="fk-edge__mismatch-badge"
            style={{
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
            }}
            title="Cardinality differs between stages"
          >
            !
          </span>
        )}
        {!readOnly && discrepancyStatus !== 'missing' && (
          <span
            className={`fk-edge__swap-zone${dimmed ? ' fk-edge__swap-zone--dimmed' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
            }}
            onMouseEnter={(e) => { e.stopPropagation(); setHovered(true); }}
            onMouseLeave={(e) => { e.stopPropagation(); setHovered(false); }}
          >
            {hovered && (
              <button
                className="fk-edge__swap-btn"
                onClick={handleSwap}
                title={`Swap cardinality (${cardinality} → ${swapCardinality(cardinality)})`}
                aria-label="Swap cardinality direction"
              >
                &#x21c4;
              </button>
            )}
          </span>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const FkEdge = memo(FkEdgeComponent);
