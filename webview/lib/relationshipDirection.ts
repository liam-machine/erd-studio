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

type KeyFlags = Pick<DisplayColumn, 'isPrimaryKey' | 'isNaturalKey' | 'isForeignKey'>;

/**
 * A column other columns point at: the model's whole primary key or whole
 * natural key, and not itself a foreign key. A column that is only part of a
 * composite key points out instead — a Data Vault satellite's hub hash key
 * (key: hub key + load date), a fact keyed by its dimension keys, a bridge.
 */
export function isReferencedKey(column: KeyFlags, columns: readonly KeyFlags[] = [column]): boolean {
  if (column.isForeignKey) return false;
  const whole = (flag: 'isPrimaryKey' | 'isNaturalKey') => column[flag] && columns.filter((c) => c[flag]).length === 1;
  return whole('isPrimaryKey') || whole('isNaturalKey');
}

/** The dialog prefill for a drag, turned round when it started on the key end. */
export function orientDraggedRelationship(
  prefill: FkDialogPrefill,
  models: ReadonlyArray<Pick<DisplayModel, 'name' | 'columns'>>,
): FkDialogPrefill {
  if (!prefill.toColumn) return prefill;
  const referenced = (model: string, column: string): boolean | undefined => {
    const columns = models.find((m) => m.name === model)?.columns;
    const col = columns?.find((c) => c.name === column);
    return col && columns ? isReferencedKey(col, columns) : undefined;
  };
  const from = referenced(prefill.fromModel, prefill.fromColumn);
  const to = referenced(prefill.toModel, prefill.toColumn);
  if (from === undefined || to === undefined) return prefill;
  if (!from || to) return prefill;
  return {
    fromModel: prefill.toModel,
    fromColumn: prefill.toColumn,
    toModel: prefill.fromModel,
    toColumn: prefill.fromColumn,
  };
}
