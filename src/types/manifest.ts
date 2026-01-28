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
}

/** Parsed manifest data cached in memory. */
export interface ManifestData {
  /** Models indexed by short name (e.g. "dim_work_lot") */
  models: Map<string, ManifestModelInfo>;
}
