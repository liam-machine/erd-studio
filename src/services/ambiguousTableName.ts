/**
 * The fail-closed guard of every write that names a table (D-5): a bare name
 * that tables in more than one schema folder share does not say which table
 * to change, so the write is refused, never sent to the first file of that
 * name. Every library write entry asks it before it plans anything, so a
 * caller still naming tables by name alone fails loudly instead of editing
 * the other table. A name only one table has is never refused, so a library
 * where no two tables share a name writes exactly as it always did.
 *
 * Pure: no `vscode`, no file access. The CLI bundles it.
 */

import { qualifiedRef, tableIdKey } from '@erd-studio/core';
import type { TableId } from '@erd-studio/core';

/** A write named a table by a bare name more than one table has. Nothing was written. */
export class AmbiguousTableName extends Error {
  /** The name as the write gave it. */
  readonly tableName: string;
  /** The tables of that name, one per identity, in library order. */
  readonly candidates: readonly TableId[];

  constructor(tableName: string, candidates: readonly TableId[]) {
    const named = candidates.map((c) => qualifiedRef(c.schema, c.name)).join(', ');
    super(`More than one table is named ${tableName} (${named}), and this change does not say which one; nothing was changed.`);
    this.name = 'AmbiguousTableName';
    this.tableName = tableName;
    this.candidates = candidates;
  }
}

/**
 * Throws {@link AmbiguousTableName} when `candidates` (the tables named
 * `tableName`) are more than one identity; does nothing for one table, a
 * table listed twice, or none.
 */
export function refuseAmbiguousTableName(tableName: string, candidates: readonly TableId[]): void {
  const distinct = new Map<string, TableId>();
  for (const candidate of candidates) {
    const key = tableIdKey(candidate);
    if (!distinct.has(key)) distinct.set(key, candidate);
  }
  if (distinct.size > 1) throw new AmbiguousTableName(tableName, [...distinct.values()]);
}
