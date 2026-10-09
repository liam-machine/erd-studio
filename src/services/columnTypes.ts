/**
 * Where a dbt column's data type comes from — one rule, shared by the physical
 * stage (`DomainService.buildPhysicalDomain`) and the seeding of a logical
 * model from dbt (`seedModelFromDbt`: Draw from dbt, Add models from dbt, Add
 * Existing Model), so a freshly drawn model starts with the types the physical
 * stage would show for it and a Compare does not open on invented differences.
 *
 * Pure and vscode-free: reachable from `dist/cli.js` and `mcp-server/`.
 */

import type { CatalogData, CatalogNodeInfo } from '../types/catalog';

/** Which source supplied a column's type; `declared` is the yml, or the manifest when no yml declares the model. */
export type ColumnTypeSource = 'catalog' | 'declared' | 'manifest';

/**
 * The catalog node for a dbt model. The manifest `unique_id` first — catalog
 * keys ARE manifest unique_ids, so that join is exact and already knows which
 * version dbt marks latest — then the best-effort short-name index (highest
 * version wins) for when no manifest resolved the model. `key` is the model's
 * normalised name.
 */
export function catalogNodeFor(
  catalog: CatalogData | undefined,
  manifestModel: { uniqueId: string } | undefined,
  key: string,
): CatalogNodeInfo | undefined {
  return (manifestModel ? catalog?.byUniqueId.get(manifestModel.uniqueId) : undefined)
    ?? catalog?.byName.get(key);
}

/**
 * A column's type as an ordered fallthrough: what the warehouse reports
 * (catalog), then the declared assertion (yml `data_type:`), then the
 * manifest's compiled copy of it. Empty when none has one — a type is never
 * invented, so the discrepancy check can tell "undeclared" from a mismatch.
 */
export function resolveColumnType(
  observed: string | null | undefined,
  declared: string | null | undefined,
  manifest: string | null | undefined,
): { dataType: string; source?: ColumnTypeSource } {
  if (observed) { return { dataType: observed, source: 'catalog' }; }
  if (declared) { return { dataType: declared, source: 'declared' }; }
  if (manifest) { return { dataType: manifest, source: 'manifest' }; }
  return { dataType: '' };
}
