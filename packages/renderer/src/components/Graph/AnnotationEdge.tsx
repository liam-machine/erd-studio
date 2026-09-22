/**
 * AnnotationEdge — dashed edge linking an annotation to a model.
 *
 * Purely visual — no interactivity, no labels, no arrows.
 * Uses a bezier path with a dashed stroke.
 */

import { memo } from 'react';
import { getBezierPath, type EdgeProps } from '@xyflow/react';
import type { AnnotationFlowEdge } from '../../types/graph';

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
      stroke="var(--vscode-descriptionForeground, #999)"
      strokeWidth={1.5}
      strokeDasharray="6 4"
      strokeOpacity={0.5}
      className="annotation-edge"
    />
  );
}

export const AnnotationEdge = memo(AnnotationEdgeInner);
