/**
 * AnnotationEdge — dashed edge linking an annotation to a model.
 *
 * Purely visual — no interactivity, no labels, no arrows.
 * Uses a bezier path with a dashed stroke.
 */

import { memo } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { AnnotationFlowEdge } from '../../types/graph';
// The line's stroke lives with the note styles (`.annotation-edge`).
import './AnnotationNode.css';

function AnnotationEdgeInner({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<AnnotationFlowEdge>) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <path
      d={edgePath}
      fill="none"
      stroke="var(--text-tertiary)"
      strokeWidth={1.25}
      strokeDasharray="3 5"
      strokeLinecap="round"
      className="annotation-edge"
    />
  );
}

export const AnnotationEdge = memo(AnnotationEdgeInner);
