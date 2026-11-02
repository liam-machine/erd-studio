/**
 * Types for React Flow graph nodes and edges.
 *
 * These types define the data payloads for custom React Flow node and edge
 * components. The graph transformer converts DisplaySubjectArea data into
 * these shapes.
 */

import type { Node, Edge } from '@xyflow/react';
import type { AnnotationColor, Cardinality, ColumnPair, DbtKeyHint, Layer, Meta, TableLoadError, TableLoadWarning, TableRole, Stage } from '@erd-studio/core';
import type { LayerConfig } from '@erd-studio/core';
import type { TableDiscrepancy } from '@erd-studio/core';
import type { PhysicalProvenance } from '@erd-studio/core';

// ---------------------------------------------------------------------------
// Column display
// ---------------------------------------------------------------------------

/** Column data enriched with PK/FK/NK indicators for display in TableNode. */
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
  /** Structured metadata (`meta:`) — shown in the tooltip. Absent when empty. */
  meta?: Meta;
  /** What dbt's tests say about the column (editable logical canvas only) — one line of its hover text. */
  dbtKey?: DbtKeyHint;
}

// ---------------------------------------------------------------------------
// TableNode
// ---------------------------------------------------------------------------

/** Data payload for a TableNode React Flow node. */
export type TableNodeData = {
  /** Model name (unique within a domain). */
  modelName: string;
  /**
   * Header label when it differs from `modelName`: the model's table name
   * (`alias`), qualified by schema when another model on the canvas would read
   * the same. See `computeTableLabels`.
   */
  label?: string;
  /** The active design stage. */
  stage: Stage;
  /** Data warehouse layer. */
  layer: Layer;
  /** Database schema the model materializes in (named in the badge's hover card). */
  schema?: string;
  /** Layer configuration for dynamic badge styling (color, abbreviation). */
  layerConfig?: LayerConfig;
  /**
   * The layer the table itself belongs to (`DisplayTable.layer`), when known.
   * The header's badge always names the layer the table lives in: this one,
   * else the diagram's `layer`. A known layer also draws the colour strip.
   */
  tableLayer?: Layer;
  /** {@link tableLayer}'s config (its colour and abbreviation). */
  tableLayerConfig?: LayerConfig;
  /** Set when {@link tableLayer} is not the diagram's layer: a table this diagram borrows. */
  otherLayer?: true;
  /** The schema as a prefix of the name (`sales.fct_order`): set only when it is not the badge's layer id. */
  shownSchema?: string;
  /**
   * Set when the project has one layer and every table is in it
   * (`isSingleLayerProject`): the layer badge and colour strip are left off.
   */
  singleLayer?: true;
  /** The warehouse name when it differs from the model name (`alias`), shown after it: `gold_orders  as orders`. */
  alias?: string;
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
  modelRole?: TableRole;
  /** Structured metadata (`meta:`) — shown in the name's hover tip. Absent when empty. */
  meta?: Meta;
  /** Whether this stage is read-only (physical). */
  readOnly?: boolean;
  /**
   * Render this node as a ghost. Set from two unrelated places: a physical
   * model that does not exist in the dbt project, and a model the active
   * discrepancy report reports 'missing' (which also fires on the logical
   * canvas). `ghostReason` is what tells them apart.
   */
  isGhost?: boolean;
  /**
   * Why the node is a ghost — drives the border treatment and the tooltip.
   * 'not-in-project' / 'disabled' come from the physical stage;
   * 'missing-in-comparison' from the discrepancy overlay.
   */
  ghostReason?: 'not-in-project' | 'disabled' | 'missing-in-comparison';
  /**
   * Where the physical model's columns and types came from. Physical stage
   * only — logical nodes never carry it, which is what keeps the header chip
   * off the logical canvas without a stage check.
   */
  provenance?: PhysicalProvenance;
  /**
   * The model's file exists but could not be read (logical stage only): the
   * node shows the error and an "Open file" button instead of "No columns".
   */
  loadError?: TableLoadError;
  /**
   * The model's file was read but needs fixing (logical stage only): a key
   * written twice, whose last value is shown (#164). Absent from an older core.
   */
  loadWarning?: TableLoadWarning;
  /** Whether this model is in stub display mode (PK/NK columns only). */
  isStub: boolean;
  /** Per-model discrepancy data when a cross-stage comparison report is active. */
  discrepancy?: TableDiscrepancy;
  /** The stage currently being viewed (set when discrepancy overlay is active). */
  discrepancySourceStage?: Stage;
  /** The stage being compared against (set when discrepancy overlay is active). */
  discrepancyTargetStage?: Stage;
  /**
   * Index signature required by React Flow's Node generic.
   *
   * It also means an unknown or misspelled key type-checks, and a field written
   * here but never destructured in TableNode ships as dead payload — which is
   * exactly how `hasRationale` and `modelRole` gained matching dead CSS. Add a
   * field here only together with the code that reads it.
   */
  [key: string]: unknown;
};

/** Typed React Flow node for a semantic model. */
export type TableFlowNode = Node<TableNodeData, 'model'>;

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
  /** Optional label for the link, e.g. `ship date`, drawn at the edge's midpoint. */
  role?: string;
  /**
   * A composite foreign key's column pairs (two or more; #133 L2). Absent for
   * a single-column link; `fromColumn` / `toColumn` are always the first pair.
   */
  pairs?: ColumnPair[];
  /** The composite's `compositeKey` name, alongside `pairs`. */
  compositeKey?: string;
  /**
   * The keys contradict its direction (`DisplayRelationship.keysContradict`,
   * #163): drawn with a ⚠ and Turn round, except for viewers.
   */
  keysContradict?: true;
  /** Stage of the owning domain canvas — drives CSS colour class. */
  stage?: Stage;
  /** Discrepancy status for ghost/extra/mismatch edges. */
  discrepancyStatus?: 'extra' | 'missing' | 'cardinality-mismatch';
  /** Whether the edge is dimmed (not connected to current selection). */
  dimmed?: boolean;
  /** Whether the edge is in a read-only context (physical stage). */
  readOnly?: boolean;
  /** True when source === target — renders a loop arc over the top-right corner. */
  isSelfLoop?: boolean;
  /**
   * For a self-loop: its place among the node's self-loops, by edge id (#133
   * L3). Each one is drawn wider than the last, so loops nest, never cross.
   */
  loopIndex?: number;
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
