/**
 * Column grouping utility — sorts columns by key priority.
 *
 * In the stage architecture, columns no longer have a status field.
 * This module provides a simple passthrough that applies key priority
 * sorting (PK -> NK -> FK -> non-key).
 *
 * Used by ModelNode (canvas) and ColumnEditor (detail panel) to ensure
 * consistent sorting logic.
 */

import { sortColumnsByKeyPriority } from './columnSort';

/**
 * Minimal interface for columns that can be sorted by key type.
 */
export interface GroupableColumn {
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
}

/**
 * Sort columns by key priority: PK -> NK -> FK -> non-key.
 *
 * This replaces the old groupColumnsByStatus which categorized by
 * built/approved/planned. In the stage architecture, all columns in
 * a domain file are equal — the stage directory determines lifecycle.
 */
export function sortColumns<T extends GroupableColumn>(columns: T[]): T[] {
  return sortColumnsByKeyPriority(columns);
}

/**
 * @deprecated Use sortColumns instead. Kept for backward compatibility
 * during migration — returns all columns in a single "planned" bucket.
 */
export function groupColumnsByStatus<T extends GroupableColumn>(
  columns: T[]
): { built: T[]; approved: T[]; planned: T[] } {
  return {
    built: [],
    approved: [],
    planned: sortColumnsByKeyPriority(columns),
  };
}
