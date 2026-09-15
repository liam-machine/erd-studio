/**
 * Types for dbt's `target/catalog.json` — the artifact written by
 * `dbt docs generate`, which queries the warehouse's information schema and
 * reports the columns and types that *actually exist* there.
 *
 * This is the only source ERD Studio has for real warehouse types: a
 * manifest `data_type` is nothing more than a copy of whatever the author
 * typed into their schema .yml. The catalog is optional and frequently
 * absent, stale or partial, so every consumer must treat it as enrichment
 * rather than as truth about *existence*.
 *
 * Kept in src/types so services can `import type` these without dragging a
 * service into another bundle. Must stay DOM-free and vscode-free — it is
 * type-checked by the mcp-server job under `lib: ES2022` + `isolatedModules`.
 */

/** One column as the warehouse reports it. */
export interface CatalogColumn {
  /** Warehouse spelling of the column name — Snowflake returns UPPERCASE. */
  name: string;
  /** Warehouse type string: `NUMBER`, `TEXT`, `character varying(255)`. Null when absent. */
  dataType: string | null;
  /** Warehouse comment. Null far more often than not — the catalog schema marks it nullable. */
  comment: string | null;
  /** Ordinal position of the column in the relation, as reported by the adapter. */
  index: number;
}

/** One model / seed / snapshot node from catalog.json's `nodes` section. */
export interface CatalogNodeInfo {
  /**
   * Catalog key, which IS the manifest `unique_id`
   * (`model.my_project.dim_customer`, `model.my_project.dim_customer.v2`).
   * dbt maps each warehouse relation onto a manifest node and drops the
   * relations it cannot match, so this is the reliable join key whenever a
   * manifest was also parsed.
   */
  uniqueId: string;
  resourceType: CatalogResourceType;
  /**
   * Best-effort short name parsed out of `uniqueId`.
   *
   * NEVER `metadata.name`: that is the *relation* name, which is the alias
   * when one is configured and `<name>_v2` for versioned models. Use this
   * only for the fallback name index — prefer `uniqueId` matching whenever
   * a manifest resolved the model.
   */
  name: string;
  /**
   * Version token parsed off a trailing `.v<token>` in the unique_id.
   * dbt allows integers (`v2`), floats (`v1.1`) and arbitrary strings
   * (`vprod`), so never assume a bare integer.
   */
  version?: string;
  /** `metadata.name` — the relation as materialised. Display and diagnostics only. */
  relationName: string;
  /**
   * `metadata.schema`. Warehouse casing is preserved, which is why the
   * manifest's spelling wins when both are available (Snowflake reports
   * `ANALYTICS` where the manifest says `analytics`).
   */
  schema: string;
  database: string | null;
  comment: string | null;
  /** Sorted ascending by the catalog's `index`, i.e. warehouse column order. */
  columns: CatalogColumn[];
}

/** The node kinds ERD Studio extracts. `source.*`, `test.*` and the rest are ignored. */
export type CatalogResourceType = 'model' | 'seed' | 'snapshot';

/** A parsed `target/catalog.json`, indexed for lookup by the physical stage build. */
export interface CatalogData {
  /** PRIMARY index: `unique_id` → node. */
  byUniqueId: Map<string, CatalogNodeInfo>;
  /**
   * FALLBACK index for when no manifest resolved the model:
   * `normaliseName(short name)` → node. The highest version wins; where
   * versions do not separate them, the first node encountered wins.
   */
  byName: Map<string, CatalogNodeInfo>;
  /**
   * `metadata.generated_at` (ISO 8601, UTC) — how old this catalog is.
   * Surfaced to the user, because a catalog weeks older than the schema .yml
   * it overrules is the main hazard of preferring warehouse types. Null when absent.
   */
  generatedAt: string | null;
  /**
   * True when the top-level `errors` array is non-empty, i.e. dbt could not
   * describe at least one relation (usually a permissions failure). A
   * `--select`ed or `--empty-catalog` run is simply missing nodes and is not
   * flagged here — nothing in the artifact distinguishes it from a fresh project.
   */
  partial: boolean;
}
