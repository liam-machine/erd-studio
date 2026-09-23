/**
 * The canvas backdrop: the dotted background and the minimap. Render it as a
 * child of `<ReactFlow>`.
 */

import { Background, BackgroundVariant, MiniMap, type Node } from '@xyflow/react';
import { stageNodeColor } from '../lib/stageColors';
import type { ModelFlowNode, AnnotationFlowNode } from '../types/graph';

/** Minimap fill for annotation nodes, keyed by annotation colour. */
export const ANNOTATION_MINIMAP_COLORS: Record<string, string> = {
  yellow: '#f59e0b', blue: '#3b82f6', green: '#22c55e',
  pink: '#ec4899', orange: '#f97316',
};

/** Minimap colour for a node: annotation colour, or the model's stage colour. */
function nodeColor(node: Node): string {
  if (node.type === 'annotation') {
    return ANNOTATION_MINIMAP_COLORS[(node as AnnotationFlowNode).data.color] ?? '#f59e0b';
  }
  const d = (node as ModelFlowNode).data;
  return stageNodeColor(d.stage, d.isGhost);
}

export function CanvasBackdrop() {
  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={nodeColor}
        maskColor="rgba(0, 0, 0, 0.2)"
        style={{
          background: 'var(--panel-bg)',
          border: '1px solid var(--panel-border)',
          borderRadius: '4px',
        }}
      />
    </>
  );
}
