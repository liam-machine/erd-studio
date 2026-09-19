/**
 * FkEdge — read-only custom React Flow edge for displaying FK relationships.
 *
 * Simplified version for Confluence macro viewer. No swap cardinality button.
 * Renders smooth-step path with Power BI-style cardinality labels.
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

const PATH_GAP = 20;
const LABEL_OFFSET = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const allEdges = useStore((state) => state.edges);
  const nodeLookup = useStore((state) => state.nodeLookup);

  const sourceNode = useInternalNode(data?.fromModel ?? '');
  const targetNode = useInternalNode(data?.toModel ?? '');

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
  const { cardinality, stage, fromModel, toModel, dimmed } = data;

  const sourceSide = parseSideFromHandle(sourceHandleId);
  const targetSide = parseSideFromHandle(targetHandleId);

  let adjustedSourceX = sourceX;
  let adjustedSourceY = sourceY;
  let adjustedTargetX = targetX;
  let adjustedTargetY = targetY;

  if (sourceSide) {
    const sideLength = getSideLength(sourceSide, sourceNode?.measured);
    const sourceOffset = calculateEdgeOffset(
      id, fromModel, sourceSide, true, allEdges, sideLength, nodePositions,
    );
    adjustedSourceX += sourceOffset.x;
    adjustedSourceY += sourceOffset.y;
  }

  if (targetSide) {
    const sideLength = getSideLength(targetSide, targetNode?.measured);
    const targetOffset = calculateEdgeOffset(
      id, toModel, targetSide, false, allEdges, sideLength, nodePositions,
    );
    adjustedTargetX += targetOffset.x;
    adjustedTargetY += targetOffset.y;
  }

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

  const statusClass = `fk-edge--${stage ?? 'logical'}`;

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
  const labelColorClass = `fk-edge__label--${stage ?? 'logical'}`;

  const srcLabel = offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, LABEL_OFFSET);
  const tgtLabel = offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, LABEL_OFFSET);

  return (
    <>
      <path
        id={id}
        d={edgePath}
        className={`fk-edge ${statusClass}${dimmed ? ' fk-edge--dimmed' : ''}`}
      />
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
      </EdgeLabelRenderer>
    </>
  );
}

export const FkEdge = memo(FkEdgeComponent);
