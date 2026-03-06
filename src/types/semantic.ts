/**
 * Types for semantic domain JSON files.
 *
 * Domain files live at {dbt_project}/erd-studio/{stage}/{layer}/{domain}.json
 * and describe FK-based relationships between dbt models within a business
 * domain at a particular design stage (conceptual, logical, or physical).
 */

/**
 * Layer identifier type - dynamic string validated at runtime.
 * Layer configuration is managed by LayerService and stored in layers.json.
 */
export type Layer = string;

/** The three design stages of a domain. */
export type Stage = 'conceptual' | 'logical' | 'physical';

/** The current schema version written by this extension. */
export const CURRENT_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

/** Column definition for a model. */
export interface ColumnDef {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey?: boolean;
  /** Stored FK flag for design-time FK intent (separate from computed FK from relationships). */
  isForeignKey?: boolean;
  /** Natural key flag — business identifier like email, SKU, customer_code. */
  isNaturalKey?: boolean;
  /**
   * SCD type for dimension columns: how this attribute handles changes over time.
   * 0 = Never changes, 1 = Overwrite, 2 = Track history.
   * Only meaningful on dimension-role models but stored unconditionally.
   */
  scdType?: 0 | 1 | 2;
  /**
   * Additive type for fact measure columns: how this measure aggregates across dimensions.
   * Only meaningful on fact-role models but stored unconditionally.
   */
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
}

// ---------------------------------------------------------------------------
// Model role
// ---------------------------------------------------------------------------

/**
 * Classifies a model's role in the data warehouse architecture.
 * Maps to entity types from dimensional modelling methodology.
 */
export type ModelRole =
  | 'conformed-dim'        // Shared dimension reused across domains
  | 'domain-dim'           // New dimension specific to this domain
  | 'transaction-fact'     // Discrete event fact
  | 'periodic-snapshot'    // Recurring measurement per period
  | 'accumulating-snapshot'// Lifecycle with milestones
  | 'factless-fact'        // M:M bridge table, FKs only
  | 'reference'            // Low-cardinality lookup
  | 'gold-fact'            // Pre-joined Gold view
  | 'gold-dim';            // Flattened Gold dimension view

// ---------------------------------------------------------------------------
// Design rationale
// ---------------------------------------------------------------------------

/** Design rationale metadata for a model — explains architectural decisions. */
export interface Rationale {
  /** What requirements or purpose this model fulfils. */
  purpose?: string;
  /** Why this model was designed the way it was. */
  design?: string;
  /** Why this grain was chosen over alternatives. */
  grainChoice?: string;
  /** Why this model role / fact type was selected. */
  roleChoice?: string;
  /** Overall SCD strategy explanation across dimension attributes. */
  scdStrategy?: string;
  /** Why measures are structured this way — additive type choices, component storage. */
  measures?: string;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * A model entry in a semantic domain.
 *
 * In the stage architecture, models are simple data containers.
 * The stage (conceptual/logical/physical) is determined by the
 * directory the domain file lives in, not by a field on the model.
 */
export interface SemanticModel {
  name: string;
  /** Schema the model will be materialised in. */
  schema?: string;
  /** Model description. */
  description?: string;
  /** Column definitions. */
  columns?: ColumnDef[];
  /** Design rationale: what this model does and why it was designed this way. */
  rationale?: Rationale;
  /** Grain statement — "One row per ___". The single most critical design decision. */
  grain?: string;
  /** Model's role in the data warehouse architecture (e.g. conformed-dim, transaction-fact). */
  modelRole?: ModelRole;
}

/**
 * A model definition used when creating new models via addModel message.
 */
export interface DesignModel {
  name: string;
  schema?: string;
  description: string;
  columns: ColumnDef[];
  /** Model's role in the data warehouse architecture. Auto-suggested from template. */
  modelRole?: ModelRole;
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/** FK relationship cardinality. */
export type Cardinality = 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';

/**
 * An FK relationship between two models in a domain.
 *
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 */
export interface Relationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

// ---------------------------------------------------------------------------
// View configuration
// ---------------------------------------------------------------------------

/** Persisted x/y position for a model node on the canvas. */
export interface NodePosition {
  x: number;
  y: number;
}

/** ELK layout options stored as string key-value pairs. */
export type LayoutOptions = Record<string, string>;

/** View configuration for a domain's graph editor. */
export interface ViewConfig {
  showFkEdges?: boolean;
  layoutOptions?: LayoutOptions;
  /** Persisted node positions keyed by model name. */
  positions?: Record<string, NodePosition>;
}

// ---------------------------------------------------------------------------
// Stage data (shared structure for conceptual/logical sections)
// ---------------------------------------------------------------------------

/** The models, relationships, and view config for a single design stage. */
export interface StageData {
  models: SemanticModel[];
  relationships: Relationship[];
  viewConfig: ViewConfig;
}

// ---------------------------------------------------------------------------
// Top-level domain
// ---------------------------------------------------------------------------

/** A full semantic domain as stored in JSON. */
export interface SemanticDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  stage: Stage;
  description: string;
  /**
   * Optional folder filter for models (e.g., "models/silver").
   * When set, only manifest models with originalFilePath matching this prefix
   * will appear in the "Add Existing Model" dialog.
   * Undefined or null means no filter (show all models).
   */
  modelFolder?: string;
  models: SemanticModel[];
  relationships: Relationship[];
  viewConfig: ViewConfig;
}

/**
 * Unified domain file format (v3).
 *
 * A single JSON file at erd-studio/{layer}/{domain}.json containing both
 * conceptual and logical stage data. Replaces the v2 layout where each
 * stage had its own file in a separate directory.
 */
export interface UnifiedDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
  description: string;
  modelFolder?: string;
  conceptual: StageData;
  logical: StageData;
}

// ---------------------------------------------------------------------------
// Summary (lightweight, for tree view listing)
// ---------------------------------------------------------------------------

/** Lightweight summary returned by listDomains — avoids parsing full JSON. */
export interface DomainSummary {
  /** Domain slug (filename without extension). */
  domain: string;
  /** Layer derived from parent directory name. */
  layer: Layer;
  /**
   * Stage derived from path. Optional in v3 unified format where a single
   * file contains both stages — will be removed entirely once all consumers
   * are migrated (Phase 6/9).
   */
  stage?: Stage;
  /** Absolute path to the domain JSON file. */
  filePath: string;
}

// ---------------------------------------------------------------------------
// Model templates (configurable via JSON files)
// ---------------------------------------------------------------------------

/**
 * A model template definition loaded from semantic/templates/*.json files.
 *
 * Templates define preset columns and metadata for common model patterns
 * (dimension, fact, bridge, etc.). Users can add custom templates by
 * creating new JSON files in the templates directory.
 *
 * Placeholder syntax in column names/descriptions:
 * - {name} = model name minus prefix (e.g., "customer" from "dim_customer")
 * - {left} = left entity name (bridge templates only)
 * - {right} = right entity name (bridge templates only)
 */
export interface ModelTemplate {
  /** Unique template identifier (e.g., "dimension", "fact", "bridge"). */
  id: string;
  /** Display label in the UI (e.g., "Dimension", "Fact Table"). */
  label: string;
  /** Model name prefix (e.g., "dim_", "fct_"). Empty string for no prefix. */
  prefix: string;
  /** Description of what this template is used for. */
  description: string;
  /** Whether this template requires a left entity name (bridge tables). */
  requiresLeftEntity?: boolean;
  /** Whether this template requires a right entity name (bridge tables). */
  requiresRightEntity?: boolean;
  /** Preset columns with placeholder syntax in name/description fields. */
  columns: ColumnDef[];
}
