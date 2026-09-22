// Entry point `@erd-studio/renderer`: the viewer API — rendering a
// `DisplayDomain` as an entity-relationship diagram, and the graph types.

export {
  transformDomain,
  pickHandleSides,
  type TransformResult,
  type TransformOptions,
  type NodeRect,
  type NodeDimensions,
} from './lib/graphTransformer';

export type {
  DisplayDomain,
  DisplayModel,
  DisplayColumn,
  DisplayRelationship,
  PhysicalColumnSource,
  PhysicalProvenance,
  Annotation,
  AnnotationColor,
  Cardinality,
  Layer,
  ModelRole,
  NodePosition,
  Rationale,
  Stage,
  ViewConfig,
  LayerConfig,
} from '@erd-studio/core';

export type {
  ModelFlowNode,
  ModelNodeData,
  FkFlowEdge,
  FkEdgeData,
  AnnotationFlowNode,
  AnnotationFlowEdge,
  ColumnDisplay,
} from './types/graph';
