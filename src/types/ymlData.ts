/**
 * Types for dbt schema YAML data as parsed by YmlParserService.
 *
 * These types intentionally mirror the shape of ManifestData so that
 * downstream consumers (buildPhysicalDomain, derivePhysicalRelationships)
 * can work with either source with minimal changes.
 *
 * Unlike ManifestData (which comes from the compiled manifest.json),
 * YmlData is parsed directly from dbt schema .yml files and is always
 * current — no `dbt compile` required.
 */

/** Column metadata from a dbt schema .yml file. */
export interface YmlColumn {
  name: string;
  description: string;
  /** Often null — dbt .yml files rarely declare data_type on every column. */
  dataType: string | null;
}

/**
 * Relationship test info extracted from a dbt schema .yml file.
 *
 * In .yml files, relationship tests are nested under columns:
 * ```yaml
 * columns:
 *   - name: project_id
 *     tests:
 *       - relationships:
 *           to: ref('dim_project')
 *           field: project_id
 * ```
 *
 * The fromModel is the enclosing model, fromColumn is the enclosing column.
 */
export interface YmlRelationshipTest {
  /** FK model name (the model the test is defined on) */
  fromModel: string;
  /** FK column name (the column the test is nested under) */
  fromColumn: string;
  /** PK model name (extracted from ref('...') in the `to` kwarg) */
  toModel: string;
  /** PK column name (from the `field` kwarg) */
  toColumn: string;
}

/** Model info extracted from a dbt schema .yml file. */
export interface YmlModelInfo {
  /** Short model name (e.g. "dim_customer") */
  name: string;
  /** Model description */
  description: string;
  /** Column definitions */
  columns: YmlColumn[];
  /** Absolute path to the .yml file */
  filePath: string;
  /** Tags from config.tags (e.g. ["silver", "domain:showcase"]) */
  tags: string[];
}

/** Parsed data from all dbt schema .yml files in the project. */
export interface YmlData {
  /** Models indexed by short name (e.g. "dim_customer") */
  models: Map<string, YmlModelInfo>;
  /** Relationship tests extracted from column-level test declarations */
  relationshipTests: YmlRelationshipTest[];
  /** Columns with a `unique` test, indexed by model name */
  uniqueColumns: Map<string, Set<string>>;
  /**
   * Composite unique groups from `unique_combination_of_columns` tests,
   * indexed by model name. Each entry is an array of column names that
   * are unique together.
   */
  compositeUniqueGroups: Map<string, string[][]>;
}
