/**
 * Pure helpers for the Sync modal's decisions (`syncSelections`).
 *
 * A table that exists on one side only has a table key as well as its column
 * keys. The user decides the columns; the table decision is inferred from
 * them (majority wins, logical on a tie). An inferred table decision follows
 * its columns: it is cleared when a column is cleared (Reset, or clicking the
 * chosen side again) and re-inferred when the columns change. A table
 * decision the user made themselves ("Keep all", "All Logical") is left alone.
 * Which table keys were inferred, and to which side, is the store's
 * `syncInferredTableKeys`, so it survives the modal closing; any user action
 * on a key removes it from there, even one that sets the same side.
 */

import type { GroundTruth } from '../../src/types/syncPlan';

/** The side a table's columns lean to, or null while any column is undecided. */
export function inferTableChoice(
  selections: Readonly<Record<string, GroundTruth>>,
  columnKeys: readonly string[],
): GroundTruth | null {
  if (columnKeys.length === 0) return null;
  let logical = 0;
  let physical = 0;
  for (const k of columnKeys) {
    const choice = selections[k];
    if (choice === 'logical') logical++;
    else if (choice === 'physical') physical++;
    else return null;
  }
  return logical >= physical ? 'logical' : 'physical';
}

export interface TableKeyReconcile {
  /** What to do with the table key: set it to a side, clear it, or leave it. */
  change: { kind: 'set'; choice: GroundTruth } | { kind: 'clear' } | null;
  /** The inferred value now owned by the modal, or null when it owns none. */
  inferred: GroundTruth | null;
}

/**
 * Decide what the table key should be after a change to the selections.
 * `lastInferred` is the side recorded as inferred for this key
 * (`syncInferredTableKeys`, null if none); when the table key no longer holds
 * it, someone else decided the table and the helper stops managing it.
 */
export function reconcileInferredTableKey(
  selections: Readonly<Record<string, GroundTruth>>,
  tableKey: string,
  columnKeys: readonly string[],
  lastInferred: GroundTruth | null,
): TableKeyReconcile {
  const current = selections[tableKey] ?? null;
  const owned = lastInferred !== null && current === lastInferred;
  const target = inferTableChoice(selections, columnKeys);

  if (current === null) {
    return target ? { change: { kind: 'set', choice: target }, inferred: target } : { change: null, inferred: null };
  }
  if (!owned) return { change: null, inferred: null };
  if (target === null) return { change: { kind: 'clear' }, inferred: null };
  if (target !== current) return { change: { kind: 'set', choice: target }, inferred: target };
  return { change: null, inferred: current };
}
