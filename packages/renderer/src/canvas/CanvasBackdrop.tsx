/**
 * The canvas backdrop: the dotted background, the minimap and the line
 * routing (`EdgeRouter`, the x-ray `EdgeOverlay`, `LayerLineColour`). Render
 * it as a child of `<ReactFlow>`.
 */

import { Background, BackgroundVariant, MiniMap, type Node } from '@xyflow/react';
import { stageNodeColor } from '../lib/stageColors';
import type { TableFlowNode, AnnotationFlowNode } from '../types/graph';
import { useEditorStore } from '../store/editorStore';
import { EdgeRouter, EdgeOverlay, LayerLineColour } from './EdgeRouting';

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
  const d = (node as TableFlowNode).data;
  return stageNodeColor(d.stage, d.isGhost);
}

/**
 * Minimap colour on a logical-only canvas, which has no stage colour: the
 * colour of the table's layer badge, else the neutral line colour. (React
 * Flow sets the fill as a style, so a CSS variable resolves.)
 */
function neutralNodeColor(node: Node): string {
  if (node.type === 'annotation') return nodeColor(node);
  const d = (node as TableFlowNode).data;
  const config = d.tableLayer !== undefined ? d.tableLayerConfig : d.layerConfig;
  return (!d.singleLayer && config?.color) || 'var(--canvas-neutral-line)';
}

export function CanvasBackdrop() {
  const logicalOnly = useEditorStore((s) => s.logicalOnly) === true;
  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <EdgeRouter />
      <LayerLineColour />
      <EdgeOverlay />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={logicalOnly ? neutralNodeColor : nodeColor}
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
