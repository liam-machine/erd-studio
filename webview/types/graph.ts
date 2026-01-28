/**
 * Types for React Flow graph nodes and edges.
 *
 * These types define the data payloads for custom React Flow node and edge
 * components. The graph transformer (F108) converts SemanticDomain data into
 * these shapes.
 */

import type { Node } from '@xyflow/react';
import type { Layer } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// Model status
// ---------------------------------------------------------------------------

/** Reconciled model status (determined by comparing domain JSON with manifest). */
export type ModelStatus = 'built' | 'design' | 'missing';

// ---------------------------------------------------------------------------
// Column display
// ---------------------------------------------------------------------------

/** Column data enriched with PK/FK indicators for display in ModelNode. */
export interface ColumnDisplay {
  name: string;
  dataType: string;
  isPrimaryKey: boolean;
  /** True if this column is the source of an FK relationship. */
  isForeignKey: boolean;
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
  /** Index signature required by React Flow's Node generic. */
  [key: string]: unknown;
};

/** Typed React Flow node for a semantic model. */
export type ModelFlowNode = Node<ModelNodeData, 'model'>;
