/**
 * Column sorting utility — sorts columns by key type priority.
 *
 * Priority order: PK → NK → FK → non-key columns
 * For columns with multiple key types, highest priority wins.
 */

interface KeyFlags {
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isNaturalKey: boolean;
}

/**
 * Get sort priority for a column based on its key types.
 * Lower number = higher priority (sorted first).
 *
 * Priority: PK (0) → NK (1) → FK (2) → non-key (3)
 * If a column has multiple keys, highest priority wins.
 */
function getKeyPriority(col: KeyFlags): number {
  if (col.isPrimaryKey) return 0;
  if (col.isNaturalKey) return 1;
  if (col.isForeignKey) return 2;
  return 3;
}

/**
 * Sort columns by key type priority (PK → NK → FK → non-key).
 * Stable sort: preserves original order for columns with same priority.
 */
export function sortColumnsByKeyPriority<T extends KeyFlags>(columns: T[]): T[] {
  // Use slice() to avoid mutating the original array
  return columns.slice().sort((a, b) => getKeyPriority(a) - getKeyPriority(b));
}
