/**
 * Types for React Flow graph nodes and edges.
 *
 * These types define the data payloads for custom React Flow node and edge
 * components. The graph transformer (F108) converts SemanticDomain data into
 * these shapes.
 */

import type { Node, Edge } from '@xyflow/react';
import type { Cardinality, Layer, ModelRole } from '../../src/types/semantic';
import type { LayerConfig } from '../../src/types/layer';

// ---------------------------------------------------------------------------
// Model status
// ---------------------------------------------------------------------------

/** Reconciled model status (determined by comparing domain JSON with manifest). */
export type ModelStatus = 'built' | 'approved' | 'design' | 'missing';

// ---------------------------------------------------------------------------
// Column display
// ---------------------------------------------------------------------------

/**
 * Column status for styling:
 * - `built` — exists in manifest (blue)
 * - `approved` — approved for build (teal)
 * - `planned` — in plannedColumns but not manifest (orange)
 * - `missing` — PK/FK reference to non-existent column (orange ghost)
 */
export type ColumnStatus = 'built' | 'approved' | 'planned' | 'missing';

/** Column data enriched with PK/FK/NK indicators for display in ModelNode. */
export interface ColumnDisplay {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  /** True if this column is the source of an FK relationship. */
  isForeignKey: boolean;
  /** True if this column is a natural key (business identifier). */
  isNaturalKey: boolean;
  /** Column status for row styling. */
  status: ColumnStatus;
  /** Whether this column has been approved for build. */
  approved: boolean;
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
  /** Model status: built (blue), approved (teal), design (orange), or missing (grey). */
  status: ModelStatus;
  /** Whether this model has been approved for build. */
  approved: boolean;
  /** Data warehouse layer. */
  layer: Layer;
  /** Layer configuration for dynamic badge styling (color, abbreviation). */
  layerConfig?: LayerConfig;
  /** Columns to display, enriched with PK/FK flags. */
  columns: ColumnDisplay[];
  /** Number of columns with unresolved discrepancies (for warning badge). */
  discrepancyCount?: number;
  /** Whether the node is dimmed (doesn't match current search query). */
  dimmed?: boolean;
  /**
   * Whether columns are expanded (F405).
   * When false, only first N columns are shown with node-level handles only.
   * Ephemeral state — not persisted, resets on domain refresh.
   */
  isExpanded?: boolean;
  /** Callback to toggle expansion state (F405). Receives model name as argument. */
  onToggleExpansion?: (modelName: string) => void;
  /** Whether this model has design rationale metadata. */
  hasRationale?: boolean;
  /** Grain statement — "One row per ___". Shown as subtitle on node. */
  grain?: string;
  /** Model's role in the data warehouse architecture. Shown as badge on node. */
  modelRole?: ModelRole;
  /** Index signature required by React Flow's Node generic. */
  [key: string]: unknown;
};

/** Typed React Flow node for a semantic model. */
export type ModelFlowNode = Node<ModelNodeData, 'model'>;

// ---------------------------------------------------------------------------
// FkEdge
// ---------------------------------------------------------------------------

/** Relationship status for edge colouring: built (blue), approved (teal), or design (orange). */
export type RelationshipStatus = 'built' | 'approved' | 'design';

/** Data payload for an FkEdge React Flow edge. */
export type FkEdgeData = {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  status: RelationshipStatus;
  /** Whether this relationship has been approved for build. */
  approved: boolean;
  /** Whether the edge is dimmed (not connected to current selection). */
  dimmed?: boolean;
  /** Index signature required by React Flow's Edge generic. */
  [key: string]: unknown;
};

/** Typed React Flow edge for a semantic FK relationship. */
export type FkFlowEdge = Edge<FkEdgeData, 'fk'>;
