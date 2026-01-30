/**
 * Types for React Flow graph nodes and edges.
 *
 * These types define the data payloads for custom React Flow node and edge
 * components. The graph transformer (F108) converts SemanticDomain data into
 * these shapes.
 */

import type { Node, Edge } from '@xyflow/react';
import type { Cardinality, Layer } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// Model status
// ---------------------------------------------------------------------------

/** Reconciled model status (determined by comparing domain JSON with manifest). */
export type ModelStatus = 'built' | 'design' | 'missing';

// ---------------------------------------------------------------------------
// Column display
// ---------------------------------------------------------------------------

/**
 * Column status for styling:
 * - `built` — exists in manifest (green)
 * - `planned` — in plannedColumns but not manifest (orange)
 * - `missing` — PK/FK reference to non-existent column (orange ghost)
 */
export type ColumnStatus = 'built' | 'planned' | 'missing';

/** Column data enriched with PK/FK indicators for display in ModelNode. */
export interface ColumnDisplay {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  /** True if this column is the source of an FK relationship. */
  isForeignKey: boolean;
  /** Column status for row styling. */
  status: ColumnStatus;
}

// ---------------------------------------------------------------------------
// ModelNode
// ---------------------------------------------------------------------------

/** Data payload for a ModelNode React Flow node. */
export type ModelNodeData = {
  /** Model name (unique within a domain). */
  modelName: string;
  /** Model status: built (green), design (orange), or missing (grey). */
  status: ModelStatus;
  /** Data warehouse layer. */
  layer: Layer;
  /** Columns to display, enriched with PK/FK flags. */
  columns: ColumnDisplay[];
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
  /** Index signature required by React Flow's Node generic. */
  [key: string]: unknown;
};

/** Typed React Flow node for a semantic model. */
export type ModelFlowNode = Node<ModelNodeData, 'model'>;

// ---------------------------------------------------------------------------
// FkEdge
// ---------------------------------------------------------------------------

/** Relationship status for edge colouring: built (blue) or design (orange). */
export type RelationshipStatus = 'built' | 'design';

/** Data payload for an FkEdge React Flow edge. */
export type FkEdgeData = {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  status: RelationshipStatus;
  /** Whether the edge is dimmed (not connected to current selection). */
  dimmed?: boolean;
  /** Index signature required by React Flow's Edge generic. */
  [key: string]: unknown;
};

/** Typed React Flow edge for a semantic FK relationship. */
export type FkFlowEdge = Edge<FkEdgeData, 'fk'>;
