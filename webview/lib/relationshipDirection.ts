/**
 * Which way round a dragged or edited relationship goes (issue #133) — a thin
 * wrapper over `@erd-studio/core`'s `resolveDirection`, which decides it from
 * the evidence alone: the key flags the model files declare and, when the
 * host sent them, the dbt tests on each column (`DisplayColumn.dbtEvidence`).
 *
 * A relationship points from the column that refers to a key (the "many"
 * side, which stores it) at the key it refers to. A drag that starts on the
 * key end is turned round before the dialog opens — but only when the
 * evidence says so (`certain` or `likely`). When it is `ambiguous`, nothing is
 * turned and the dialog asks; the drag's order never breaks a tie.
 *
 * Only the *declared* foreign-key flag counts (`isForeignKeyDeclared`). The
 * FK badge (`isForeignKey`) is also set by every relationship drawn from a
 * column, so reading it would let a wrongly drawn relationship confirm itself.
 */

import { endEvidenceFromDisplay, resolveDirection, type DirectionVerdict, type EndEvidence } from '@erd-studio/core';

import type { DisplayColumn, DisplayModel } from '../../src/types/display';
import type { FkDialogPrefill } from '../store/editorStore';

type KeyFlags = Pick<DisplayColumn, 'isPrimaryKey' | 'isNaturalKey'> & { isForeignKeyDeclared?: boolean };

/** The models a direction is worked out from (the canvas's display models). */
export type DirectionModels = ReadonlyArray<Pick<DisplayModel, 'name' | 'columns'>>;

/**
 * A column other columns point at: the model's whole primary key or whole
 * natural key, and not itself declared a foreign key. A column that is only
 * part of a composite key points out instead — a Data Vault satellite's hub
 * hash key (key: hub key + load date), a fact keyed by its dimension keys, a
 * bridge.
 */
export function isReferencedKey(column: KeyFlags, columns: readonly KeyFlags[] = [column]): boolean {
  if (column.isForeignKeyDeclared) return false;
  const whole = (flag: 'isPrimaryKey' | 'isNaturalKey') => column[flag] && columns.filter((c) => c[flag]).length === 1;
  return whole('isPrimaryKey') || whole('isNaturalKey');
}

/** The evidence for one end, matching the model name without case. */
export function endEvidenceFor(models: DirectionModels, model: string, column: string): EndEvidence | undefined {
  const found = models.find((m) => m.name === model) ?? models.find((m) => m.name.toLowerCase() === model.toLowerCase());
  return found ? endEvidenceFromDisplay(found, column) : undefined;
}

/**
 * The verdict for a relationship between two columns, or undefined when
 * either end is not a known column (or the two ends are the same column).
 */
export function directionFor(
  models: DirectionModels,
  ends: { fromModel: string; fromColumn: string; toModel: string; toColumn: string },
): DirectionVerdict | undefined {
  const a = endEvidenceFor(models, ends.fromModel, ends.fromColumn);
  const b = endEvidenceFor(models, ends.toModel, ends.toColumn);
  if (!a || !b) return undefined;
  return resolveDirection(a, b);
}

/** Whether a verdict's "from" end is the given end (names compared without case). */
export function verdictStartsAt(verdict: DirectionVerdict, model: string, column: string): boolean {
  return verdict.from.model.toLowerCase() === model.toLowerCase()
    && verdict.from.column.toLowerCase() === column.toLowerCase();
}

/** A drag, oriented by the evidence, with what was done to it. */
export interface OrientedDrag {
  prefill: FkDialogPrefill;
  /** The ends were swapped from the order the drag went in. */
  turned: boolean;
  /** The verdict behind it (undefined when an end is unknown or no target column). */
  verdict?: DirectionVerdict;
}

/**
 * Orient a drag: turned round when the evidence (certain or likely) says the
 * other end is the "many" one; left exactly as dragged otherwise.
 */
export function orientDrag(prefill: FkDialogPrefill, models: DirectionModels): OrientedDrag {
  if (!prefill.toColumn) return { prefill, turned: false };
  const verdict = directionFor(models, { ...prefill, toColumn: prefill.toColumn });
  if (!verdict) return { prefill, turned: false };
  if (verdict.confidence === 'ambiguous' || verdictStartsAt(verdict, prefill.fromModel, prefill.fromColumn)) {
    return { prefill, turned: false, verdict };
  }
  return {
    prefill: {
      fromModel: prefill.toModel,
      fromColumn: prefill.toColumn,
      toModel: prefill.fromModel,
      toColumn: prefill.fromColumn,
    },
    turned: true,
    verdict,
  };
}

/** The dialog prefill for a drag, turned round when it started on the key end. */
export function orientDraggedRelationship(prefill: FkDialogPrefill, models: DirectionModels): FkDialogPrefill {
  return orientDrag(prefill, models).prefill;
}
