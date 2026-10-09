/**
 * Types for dbt manifest.json data as parsed by ManifestService.
 *
 * The manifest is the compiled output of `dbt compile` / `dbt run`.
 * Models are keyed in the manifest as "model.{project_name}.{model_name}".
 * We extract and index by the short model name for convenient lookup.
 */

import type { Meta } from './semantic';

/** Column metadata from a dbt manifest node. */
export interface ManifestColumn {
  name: string;
  data_type: string | null;
  description: string;
  /** dbt `meta` (merged with `config.meta`), when non-empty. CLI inventory only. */
  meta?: Meta;
}

/**
 * Relationship test info extracted from manifest test nodes.
 *
 * In dbt, relationship tests are schema tests that validate FK constraints.
 * They appear in the manifest as test nodes with test_metadata.name='relationships'.
 */
export interface ManifestRelationshipTest {
  /** FK model name (short name, e.g. "fct_order") */
  fromModel: string;
  /** FK column name (from test_metadata.kwargs.column_name) */
  fromColumn: string;
  /** PK model name (short name, e.g. "dim_customer") */
  toModel: string;
  /** PK column name (from test_metadata.kwargs.field) */
  toColumn: string;
}

/** Model info extracted from a dbt manifest node. */
export interface ManifestModelInfo {
  /** Short model name (e.g. "dim_customer") */
  name: string;
  /** Full manifest key (e.g. "model.my_project.dim_customer") */
  uniqueId: string;
  /** The dbt project this model belongs to */
  projectName: string;
  /** Schema the model is materialised in */
  schema: string;
  /**
   * Relation name dbt builds the model as, when it differs from `name` (the
   * `alias` config). dbt fills `alias` in on every node — equal to the name
   * when none is configured — so it is recorded here only when it differs.
   */
  alias?: string;
  /** Model description from dbt */
  description: string;
  /** Column definitions from dbt */
  columns: ManifestColumn[];
  /** dbt `meta` (merged with `config.meta`), when non-empty. CLI inventory only. */
  meta?: Meta;
  /** Original file path from manifest (e.g., "models/silver/dim_customer.sql") */
  originalFilePath?: string;
  /** dbt model version (only set for versioned models, e.g. `model.proj.name.v2`) */
  version?: number;
  /** The version dbt marks as latest for this model name (versioned models only) */
  latestVersion?: number;
}

/**
 * A composite foreign key dbt declares (#133 L2): a dbt ≥ 1.9 model-level
 * `foreign_key` constraint, or a `dbt_constraints.foreign_key` test, over two
 * or more columns. Single-column forms are left to relationships tests.
 */
export interface CompositeForeignKey {
  /** The model the constraint (or test) is declared on: the foreign-key side. */
  fromModel: string;
  fromColumns: string[];
  toModel: string;
  /** Pairs with `fromColumns` by position; the same length. */
  toColumns: string[];
  /** The constraint's `name`, when it has one. */
  name?: string;
}

/**
 * Serializable result from the manifest worker thread.
 * Uses plain objects/arrays instead of Maps/Sets because
 * structured clone (worker postMessage) cannot transfer them.
 */
export interface ManifestWorkerResult {
  models: Record<string, ManifestModelInfo>;
  relationshipTests: ManifestRelationshipTest[];
  uniqueColumns: Record<string, string[]>;
  compositeUniqueGroups: Record<string, string[][]>;
  /** Short names of models in `manifest.disabled` (raw spelling, deduped) */
  disabledModels: string[];
  /** Seed and snapshot nodes, keyed by short name (descriptions only — see ManifestData.resourceDocs) */
  resourceDocs?: Record<string, ManifestModelInfo>;
  /** Composite foreign keys declared by constraints or dbt_constraints tests (#133 L2) */
  compositeForeignKeys?: CompositeForeignKey[];
}

/** Error result from the manifest worker thread. */
export interface ManifestWorkerError {
  error: string;
}

/** Parsed manifest data cached in memory. */
export interface ManifestData {
  /** Models indexed by short name (e.g. "dim_customer") */
  models: Map<string, ManifestModelInfo>;
  /** Relationship tests extracted from manifest test nodes */
  relationshipTests: ManifestRelationshipTest[];
  /** Columns with a standalone `unique` test, indexed by model name */
  uniqueColumns: Map<string, Set<string>>;
  /**
   * Composite unique groups from `unique_combination_of_columns` tests,
   * indexed by model name. Each entry is an array of column names that
   * are unique together.
   */
  compositeUniqueGroups: Map<string, string[][]>;
  /**
   * Normalised names of models dbt has disabled (`enabled: false` via
   * `{{ config() }}`, a `dbt_project.yml` subtree, or an excluded package).
   *
   * Their `.sql` files stay on disk but `ref()` to them fails to compile, so
   * a file alone must never be taken as evidence that the model exists.
   */
  disabledModels: Set<string>;
  /**
   * `seed.` and `snapshot.` nodes, keyed by `normaliseName(name)`. They are
   * kept OUT of `models` (which drives existence, the Add-Existing picker and
   * relationship derivation) and supply only descriptions — model- and
   * column-level — to the physical stage when no schema .yml has them.
   * Optional so hand-built literals stay valid.
   */
  resourceDocs?: Map<string, ManifestModelInfo>;
  /**
   * Composite foreign keys declared by model-level `foreign_key` constraints
   * or `dbt_constraints.foreign_key` tests (#133 L2). Optional so hand-built
   * literals stay valid.
   */
  compositeForeignKeys?: CompositeForeignKey[];
}
