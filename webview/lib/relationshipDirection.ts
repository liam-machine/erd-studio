/**
 * Which way round a dragged relationship goes (issue #133).
 *
 * A drag between two column rows opens the New Relationship dialog with the
 * drag's start as "from" and many-to-one selected. Dragging from a dimension's
 * key to a fact's column would therefore record the dimension as the "many"
 * side — and store the relationship in the dimension's file. A relationship
 * points from the column that refers to a key at the key it refers to, so when
 * the drag starts on a key and ends on a column that is not one, the ends are
 * swapped before the dialog opens.
 */

import type { DisplayColumn, DisplayModel } from '../../src/types/display';
import type { FkDialogPrefill } from '../store/editorStore';

/**
 * A column other columns point at: a primary or natural key that is not
 * itself a foreign key (a bridge table's key columns are both, and point out).
 */
export function isReferencedKey(column: Pick<DisplayColumn, 'isPrimaryKey' | 'isNaturalKey' | 'isForeignKey'>): boolean {
  return (column.isPrimaryKey || column.isNaturalKey) && !column.isForeignKey;
}

/** The dialog prefill for a drag, turned round when it started on the key end. */
export function orientDraggedRelationship(
  prefill: FkDialogPrefill,
  models: ReadonlyArray<Pick<DisplayModel, 'name' | 'columns'>>,
): FkDialogPrefill {
  if (!prefill.toColumn) return prefill;
  const columnOf = (model: string, column: string): DisplayColumn | undefined =>
    models.find((m) => m.name === model)?.columns.find((c) => c.name === column);
  const from = columnOf(prefill.fromModel, prefill.fromColumn);
  const to = columnOf(prefill.toModel, prefill.toColumn);
  if (!from || !to) return prefill;
  if (!isReferencedKey(from) || isReferencedKey(to)) return prefill;
  return {
    fromModel: prefill.toModel,
    fromColumn: prefill.toColumn,
    toModel: prefill.fromModel,
    toColumn: prefill.fromColumn,
  };
}
