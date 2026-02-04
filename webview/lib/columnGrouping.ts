/**
 * Column grouping utility — groups columns by status into three categories.
 *
 * Groups columns into built, approved, and planned, applying key priority
 * sorting (PK -> NK -> FK -> non-key) within each group.
 *
 * Used by ModelNode (canvas) and ColumnEditor (detail panel) to ensure
 * consistent grouping logic.
 */

import { sortColumnsByKeyPriority } from './columnSort';

/**
 * Minimal interface for columns that can be grouped by status.
 * Works with both ReconciledColumn and ColumnDisplay.
 */
export interface GroupableColumn {
  status: 'built' | 'approved' | 'planned' | 'missing';
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
}

/**
 * Result of grouping columns by status.
 */
export interface ColumnGroups<T extends GroupableColumn> {
  /** Columns that exist in the manifest (status === 'built'). */
  built: T[];
  /** Columns approved for build (status === 'approved'). */
  approved: T[];
  /** Columns planned or missing (status === 'planned' or 'missing'). */
  planned: T[];
}

/**
 * Group columns into built, approved, and planned categories.
 *
 * Each group is sorted by key priority: PK -> NK -> FK -> non-key.
 * The 'missing' status is treated as planned for grouping purposes.
 *
 * @param columns - Array of columns to group
 * @returns Object with three sorted arrays: built, approved, planned
 */
export function groupColumnsByStatus<T extends GroupableColumn>(
  columns: T[]
): ColumnGroups<T> {
  const built: T[] = [];
  const approved: T[] = [];
  const planned: T[] = [];

  for (const col of columns) {
    if (col.status === 'built') {
      built.push(col);
    } else if (col.status === 'approved') {
      approved.push(col);
    } else {
      // 'planned' or 'missing' — both go in planned group
      planned.push(col);
    }
  }

  return {
    built: sortColumnsByKeyPriority(built),
    approved: sortColumnsByKeyPriority(approved),
    planned: sortColumnsByKeyPriority(planned),
  };
}
