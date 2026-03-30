/**
 * Types for dbt manifest.json data as parsed by ManifestService.
 *
 * The manifest is the compiled output of `dbt compile` / `dbt run`.
 * Models are keyed in the manifest as "model.{project_name}.{model_name}".
 * We extract and index by the short model name for convenient lookup.
 */

/** Column metadata from a dbt manifest node. */
export interface ManifestColumn {
  name: string;
  data_type: string | null;
  description: string;
}

/**
 * Relationship test info extracted from manifest test nodes.
 *
 * In dbt, relationship tests are schema tests that validate FK constraints.
 * They appear in the manifest as test nodes with test_metadata.name='relationships'.
 */
export interface ManifestRelationshipTest {
  /** FK model name (short name, e.g. "dim_work_lot") */
  fromModel: string;
  /** FK column name (from test_metadata.kwargs.column_name) */
  fromColumn: string;
  /** PK model name (short name, e.g. "dim_project") */
  toModel: string;
  /** PK column name (from test_metadata.kwargs.field) */
  toColumn: string;
}

/** Model info extracted from a dbt manifest node. */
export interface ManifestModelInfo {
  /** Short model name (e.g. "dim_work_lot") */
  name: string;
  /** Full manifest key (e.g. "model.my_project.dim_work_lot") */
  uniqueId: string;
  /** The dbt project this model belongs to */
  projectName: string;
  /** Schema the model is materialised in */
  schema: string;
  /** Model description from dbt */
  description: string;
  /** Column definitions from dbt */
  columns: ManifestColumn[];
  /** Original file path from manifest (e.g., "models/silver/dim_customer.sql") */
  originalFilePath?: string;
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
}

/** Error result from the manifest worker thread. */
export interface ManifestWorkerError {
  error: string;
}

/** Parsed manifest data cached in memory. */
export interface ManifestData {
  /** Models indexed by short name (e.g. "dim_work_lot") */
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
}
