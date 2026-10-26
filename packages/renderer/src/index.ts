// Entry point `@erd-studio/renderer`: the viewer API — rendering a
// `DisplaySubjectArea` as an entity-relationship diagram, and the graph types.
//
//   import { ErdCanvas } from '@erd-studio/renderer';
//   import '@erd-studio/renderer/styles.css';

export { ErdCanvas, type ErdCanvasProps, type ErdCanvasHandle } from './ErdCanvas';

export {
  transformSubjectArea,
  pickHandleSides,
  type TransformResult,
  type TransformOptions,
  type NodeRect,
  type NodeDimensions,
} from './lib/graphTransformer';
export { repickHandleSides, nodeRect } from './lib/dragHandleSides';

export type {
  DisplaySubjectArea,
  DisplayTable,
  DisplayColumn,
  DisplayRelationship,
  PhysicalColumnSource,
  PhysicalProvenance,
  Annotation,
  AnnotationColor,
  Cardinality,
  Layer,
  TableRole,
  NodePosition,
  Rationale,
  Stage,
  ViewConfig,
  LayerConfig,
} from '@erd-studio/core';

// Text exports of a diagram (Mermaid erDiagram, portable DBML, rich DBML and
// its dbdiagram layout file), re-exported from @erd-studio/core so a page
// that renders with this package can offer them without depending on core
// directly.
export {
  toMermaid,
  toDbml,
  toDbmlRich,
  DBML_RICH_EXPORT_HEADER,
  type DbmlRichOptions,
  exportDiagram,
  diagramExportFileName,
  DIAGRAM_EXPORT_FORMATS,
  DIAGRAM_EXPORT_FILE_EXTENSIONS,
  type DiagramExportFormat,
  toDbdiagramLayout,
  serializeDbdiagramLayout,
  dbdiagramLayoutFileName,
  type DbdiagramLayout,
  type DbdiagramTablePosition,
} from '@erd-studio/core';

export type {
  TableFlowNode,
  TableNodeData,
  FkFlowEdge,
  FkEdgeData,
  AnnotationFlowNode,
  AnnotationFlowEdge,
  ColumnDisplay,
} from './types/graph';
