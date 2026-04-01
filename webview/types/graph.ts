/**
 * Types for React Flow graph nodes and edges.
 *
 * These types define the data payloads for custom React Flow node and edge
 * components. The graph transformer converts DisplayDomain data into
 * these shapes.
 */

import type { Node, Edge } from '@xyflow/react';
import type { AnnotationColor, Cardinality, Layer, ModelRole, Stage } from '../../src/types/semantic';
import type { LayerConfig } from '../../src/types/layer';
import type { ModelDiscrepancy } from '../../src/types/discrepancy';

// ---------------------------------------------------------------------------
// Column display
// ---------------------------------------------------------------------------

/** Column data enriched with PK/FK/NK indicators for display in ModelNode. */
export interface ColumnDisplay {
  name: string;
  dataType: string;
  /** Column description (optional — shown in tooltip on hover). */
  description?: string;
  isPrimaryKey: boolean;
  /** True if this column is the source of an FK relationship. */
  isForeignKey: boolean;
  /** True if this column is a natural key (business identifier). */
  isNaturalKey: boolean;
  /** SCD type for dimension columns (0 = never changes, 1 = overwrite, 2 = track history). */
  scdType?: 0 | 1 | 2;
  /** Additive type for fact measure columns. */
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

// ---------------------------------------------------------------------------
// ModelNode
// ---------------------------------------------------------------------------

/** Data payload for a ModelNode React Flow node. */
export type ModelNodeData = {
  /** Model name (unique within a domain). */
  modelName: string;
  /** The active design stage. */
  stage: Stage;
  /** Data warehouse layer. */
  layer: Layer;
  /** Database schema the model materializes in (shown as badge text). */
  schema?: string;
  /** Layer configuration for dynamic badge styling (color, abbreviation). */
  layerConfig?: LayerConfig;
  /** Columns to display, enriched with PK/FK flags. */
  columns: ColumnDisplay[];
  /** Whether the node is dimmed (doesn't match current search query). */
  dimmed?: boolean;
  /**
   * Whether columns are expanded.
   * When false, only first N columns are shown with node-level handles only.
   * Ephemeral state — not persisted, resets on domain refresh.
   */
  isExpanded?: boolean;
  /** Callback to toggle expansion state. Receives model name as argument. */
  onToggleExpansion?: (modelName: string) => void;
  /** Whether this model has design rationale metadata. */
  hasRationale?: boolean;
  /** Grain statement — "One row per ___". Shown as subtitle on node. */
  grain?: string;
  /** Model's role in the data warehouse architecture. Shown as badge on node. */
  modelRole?: ModelRole;
  /** Whether this stage is read-only (physical). */
  readOnly?: boolean;
  /** True if model doesn't exist in manifest (physical stage ghost node). */
  isGhost?: boolean;
  /** Whether this model is in stub display mode (PK/NK columns only). */
  isStub: boolean;
  /** Per-model discrepancy data when a cross-stage comparison report is active. */
  discrepancy?: ModelDiscrepancy;
  /** The stage currently being viewed (set when discrepancy overlay is active). */
  discrepancySourceStage?: Stage;
  /** The stage being compared against (set when discrepancy overlay is active). */
  discrepancyTargetStage?: Stage;
  /** Index signature required by React Flow's Node generic. */
  [key: string]: unknown;
};

/** Typed React Flow node for a semantic model. */
export type ModelFlowNode = Node<ModelNodeData, 'model'>;

// ---------------------------------------------------------------------------
// FkEdge
// ---------------------------------------------------------------------------

/** Data payload for an FkEdge React Flow edge. */
export type FkEdgeData = {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  /** Stage of the owning domain canvas — drives CSS colour class. */
  stage?: Stage;
  /** Discrepancy status for ghost/extra/mismatch edges. */
  discrepancyStatus?: 'extra' | 'missing' | 'cardinality-mismatch';
  /** Whether the edge is dimmed (not connected to current selection). */
  dimmed?: boolean;
  /** Whether the edge is in a read-only context (physical stage). */
  readOnly?: boolean;
  /** Index signature required by React Flow's Edge generic. */
  [key: string]: unknown;
};

/** Typed React Flow edge for a semantic FK relationship. */
export type FkFlowEdge = Edge<FkEdgeData, 'fk'>;

// ---------------------------------------------------------------------------
// AnnotationNode (canvas build notes)
// ---------------------------------------------------------------------------

/** Data payload for an AnnotationNode React Flow node. */
export type AnnotationNodeData = {
  annotationId: string;
  text: string;
  color: AnnotationColor;
  width?: number;
  height?: number;
  linkedModel?: string;
  /** Whether this annotation is in a read-only context (physical stage). */
  readOnly?: boolean;
  /** Index signature required by React Flow's Node generic. */
  [key: string]: unknown;
};

/** Typed React Flow node for a canvas annotation. */
export type AnnotationFlowNode = Node<AnnotationNodeData, 'annotation'>;

// ---------------------------------------------------------------------------
// AnnotationEdge (dashed link from annotation to model)
// ---------------------------------------------------------------------------

/** Data payload for the dashed edge linking an annotation to a model. */
export type AnnotationEdgeData = {
  annotationId: string;
  targetModel: string;
  /** Index signature required by React Flow's Edge generic. */
  [key: string]: unknown;
};

/** Typed React Flow edge for an annotation-to-model link. */
export type AnnotationFlowEdge = Edge<AnnotationEdgeData, 'annotationLink'>;
