// Entry point `@erd-studio/renderer/editor`: everything a host needs to build
// a full editor around the canvas (the VS Code extension's webview) — the
// viewer API plus the store, the host adapter, the canvas building blocks and
// the individual components, hooks and helpers.

export * from './index';
export * from './store';
export * from './sizing';

// Host adapter
export {
  NOOP_CANVAS_HOST,
  CanvasEnvironmentProvider,
  useCanvasHost,
  useSend,
  useIsViewer,
  type CanvasHost,
  type CanvasEnvironment,
} from './host/canvasEnvironment';

// Canvas
export { useCanvasGraph } from './canvas/useCanvasGraph';
export { useHoverFocus, type UseHoverFocusResult, type HoverFocusHandlers } from './canvas/useHoverFocus';
export { CanvasBackdrop, ANNOTATION_MINIMAP_COLORS } from './canvas/CanvasBackdrop';
export { canvasNodeTypes, canvasEdgeTypes } from './canvas/flowTypes';

// Components
export { TableNode } from './components/Graph/ModelNode';
export { FkEdge } from './components/Graph/FkEdge';
export { EdgeFlow, EdgeFlowGlyphs, type EdgeFlowProps } from './components/Graph/EdgeFlow';
export { AnnotationNode } from './components/Graph/AnnotationNode';
export { AnnotationEdge } from './components/Graph/AnnotationEdge';
export { DetailPanel } from './components/DetailPanel/DetailPanel';
export { Legend } from './components/Legend/Legend';
export { KeyBadge } from './components/common/KeyBadge';
export { KeyBadgeGroup } from './components/common/KeyBadgeGroup';
export { DataTypeSelect } from './components/common/DataTypeSelect';
export { ColumnRowEditor } from './components/common/ColumnRowEditor';

// Hooks
export * from './hooks/useColumnExpansion';
export * from './hooks/useColumnReorder';
export * from './hooks/useFocusWithinRow';
export * from './hooks/useLongPressDrag';
export { usePrefersReducedMotion } from './hooks/usePrefersReducedMotion';

// Helpers
export { applyNodeOverlays, type GraphNode, type GraphEdge } from './lib/nodeOverlays';
export { computeCanvasFocus, sameFocus, type CanvasFocus } from './lib/canvasFocus';
export * from './lib/stageColors';
export * from './lib/dataTypeColors';
export * from './lib/badgeLabels';
export { swapCardinality } from './lib/cardinalityUtils';
export { columnPairs, foldComposites, relationshipDisplayKey, relationshipEdgeId } from './lib/relationshipDisplayKey';
export { computeTableLabels, matchesTableSearch, type LabelledTable } from './lib/modelLabels';
export { ANNOTATION_COLORS } from './lib/annotationColors';
