/**
 * Types for semantic domain JSON files.
 *
 * Domain files live at {dbt_project}/models/semantic/{layer}/{domain}.json
 * and describe FK-based relationships between dbt models within a business
 * domain. Models are either sourced from the repo (columns resolved from
 * manifest at runtime) or designed inline (columns defined in the JSON).
 */

/**
 * Layer identifier type - dynamic string validated at runtime.
 * Layer configuration is managed by LayerService and stored in layers.json.
 */
export type Layer = string;

/** The current schema version written by this extension. */
export const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Column definitions (used by design models)
// ---------------------------------------------------------------------------

/** Column definition for a design model. */
export interface ColumnDef {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey?: boolean;
  /** Whether this column has been approved for build. */
  approved?: boolean;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * A model entry in a semantic domain.
 *
 * - `source: "built"` — exists in the dbt project; columns are resolved from
 *   the compiled manifest at runtime. Use `primaryKey` to designate the PK
 *   and `plannedColumns` for columns not yet built.
 * - `source: "design"` — a planned model that doesn't exist yet; columns,
 *   schema, and description are defined inline.
 */
export interface SemanticModel {
  name: string;
  source: 'built' | 'design';
  /** Schema the model will be materialised in (design models only). */
  schema?: string;
  /** Model description (design models only — repo models use manifest). */
  description?: string;
  /** Inline column definitions (design models only). */
  columns?: ColumnDef[];
  /**
   * Primary key column name (repo models only).
   * For design models, use `isPrimaryKey: true` in the columns array.
   */
  primaryKey?: string;
  /**
   * Planned columns not yet in manifest (repo models only).
   * These are displayed as orange rows until they appear in manifest.
   * Once a planned column exists in manifest, the manifest version is shown
   * instead (overlay semantics — manifest always wins).
   */
  plannedColumns?: ColumnDef[];
  /**
   * Whether this model has been approved for build.
   * Approving a model auto-approves all existing columns.
   * New columns added after approval start as unapproved.
   */
  approved?: boolean;
}

/**
 * A design model definition used when creating new models via addModel message.
 * All design models have source: 'design' and define columns inline.
 */
export interface DesignModel {
  name: string;
  schema: string;
  description: string;
  columns: ColumnDef[];
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
 * The optional `source` field marks design-time relationships; repo
 * relationships omit it (or default to repo-like behaviour).
 */
export interface Relationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
  /** Present and set to `"design"` for relationships created in design mode. */
  source?: 'design';
  /** Whether this relationship has been approved for build. */
  approved?: boolean;
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
// Top-level domain
// ---------------------------------------------------------------------------

/** A full semantic domain as stored in JSON. */
export interface SemanticDomain {
  schemaVersion: number;
  domain: string;
  layer: Layer;
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

// ---------------------------------------------------------------------------
// Summary (lightweight, for tree view listing)
// ---------------------------------------------------------------------------

/** Lightweight summary returned by listDomains — avoids parsing full JSON. */
export interface DomainSummary {
  /** Domain slug (filename without extension). */
  domain: string;
  /** Layer derived from parent directory name. */
  layer: Layer;
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
