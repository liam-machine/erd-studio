/**
 * The canvas backdrop: the dotted background, the minimap and the line
 * routing (`EdgeRouter`, the x-ray `EdgeOverlay`, `LayerLineColour`). Render
 * it as a child of `<ReactFlow>`.
 *
 * The ambient colour wash the dots sit on is CSS, not an element: the
 * canvas root (`.editor-canvas`) paints `--canvas-wash` and the flow area is
 * transparent (styles/theme.css, "Floating shell"). It is static and lives
 * outside the viewport, so panning never repaints it. The dots and the
 * minimap take their colours from theme tokens (`--canvas-dot`,
 * `--minimap-mask`, `--minimap-view-stroke`); the minimap's glass tile is
 * styled by `.erd-minimap` in theme.css. Its size follows the canvas
 * (`lib/canvasChrome.ts`): at most React Flow's 200 × 150, a modest share of
 * a small canvas, and none on a canvas too small for it to help.
 */

import { Background, BackgroundVariant, MiniMap, useStore, type Node } from '@xyflow/react';
import { stageNodeColor } from '../lib/stageColors';
import type { TableFlowNode, AnnotationFlowNode } from '../types/graph';
import { useEditorStore } from '../store/editorStore';
import { EdgeRouter, EdgeOverlay, LayerLineColour } from './EdgeRouting';
import { useCanvasChrome } from './useCanvasChrome';

/** Minimap fill for annotation nodes, keyed by annotation colour. */
export const ANNOTATION_MINIMAP_COLORS: Record<string, string> = {
  yellow: '#f59e0b', blue: '#3b82f6', green: '#22c55e',
  pink: '#ec4899', orange: '#f97316',
};

/** A minimap fill at reduced strength, so the tile stays calm glass. */
const soften = (colour: string, percent: number): string =>
  `color-mix(in srgb, ${colour} ${percent}%, transparent)`;

/** Minimap colour for a node: annotation colour, or the model's stage colour. */
function nodeColor(node: Node): string {
  if (node.type === 'annotation') {
    return soften(ANNOTATION_MINIMAP_COLORS[(node as AnnotationFlowNode).data.color] ?? '#f59e0b', 40);
  }
  const d = (node as TableFlowNode).data;
  return soften(stageNodeColor(d.stage, d.isGhost), 50);
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
  return soften((!d.singleLayer && config?.color) || 'var(--canvas-neutral-line)', 55);
}

export function CanvasBackdrop() {
  const logicalOnly = useEditorStore((s) => s.logicalOnly) === true;
  // An empty diagram gets no minimap (it would be an empty framed tile).
  const hasNodes = useStore((s) => s.nodes.length > 0);
  const { minimap } = useCanvasChrome();
  return (
    <>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1.1} color="var(--canvas-dot)" />
      <EdgeRouter />
      <LayerLineColour />
      <EdgeOverlay />
      {hasNodes && minimap && <MiniMap
        position="bottom-right"
        style={{ width: minimap.width, height: minimap.height }}
        pannable
        zoomable
        className="erd-minimap"
        nodeColor={logicalOnly ? neutralNodeColor : nodeColor}
        nodeBorderRadius={3}
        maskColor="var(--minimap-mask)"
        maskStrokeColor="var(--minimap-view-stroke)"
        maskStrokeWidth={1}
        nodeStrokeWidth={0}
      />}
    </>
  );
}
