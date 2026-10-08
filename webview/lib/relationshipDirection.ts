/**
 * Which way round a dragged relationship goes (issue #133).
 *
 * A relationship points from the column that refers to a key at the key it
 * refers to; the model holding that column is the "many" side, which stores
 * it. A drag carries no such information — it may start at either end — so
 * the ends are oriented by key evidence alone (`orientLink`: the models' key
 * flags, else dbt's tests). With no evidence the dialog asks, rather than
 * take the drag's order as the answer.
 */

import { contradictsKeysOf, keyEvidenceDetail, linkEnd, orientLink } from '@erd-studio/core';
import type { KeyColumn, LinkEnd, Orientation } from '@erd-studio/core';

import type { DisplayModel } from '../../src/types/display';
import type { Cardinality } from '../../src/types/semantic';
import type { FkDialogPrefill } from '../store/editorStore';

type Models = ReadonlyArray<Pick<DisplayModel, 'name' | 'columns'>>;

/** The prefill a drag opens the dialog with, oriented by key evidence. */
export interface OrientedPrefill extends FkDialogPrefill {
  cardinality?: 'many-to-one' | 'one-to-one' | 'many-to-many';
  direction: 'decided' | 'undecided';
  basis: 'keys' | 'dbt' | 'none';
}

const modelNamed = (models: Models, name: string) =>
  models.find((m) => m.name === name) ?? models.find((m) => m.name.toLowerCase() === name.toLowerCase());

/** A canvas column's stored foreign-key flag (its `isForeignKey` is the badge). */
const declaredFk = (column: KeyColumn): boolean => (column as { isForeignKeyDeclared?: boolean }).isForeignKeyDeclared === true;

/** One end of a link on the canvas, with its key evidence (flags, else the columns' `dbtKey`). */
export function canvasLinkEnd(models: Models, model: string, columns: readonly string[]): LinkEnd {
  return linkEnd(model, modelNamed(models, model), columns, { declaredFk });
}

/** How key evidence orients the link between two canvas ends. */
export function orientCanvasLink(
  models: Models,
  from: { model: string; columns: readonly string[] },
  to: { model: string; columns: readonly string[] },
): Orientation {
  return orientLink(canvasLinkEnd(models, from.model, from.columns), canvasLinkEnd(models, to.model, to.columns));
}

/**
 * The dialog prefill for a drag (#133 L1): `from` / `to` from the key
 * evidence whatever the drag's order, or as dragged when nothing decides it —
 * then `direction: 'undecided'` and the dialog asks. Returns the prefill
 * unchanged when the drop named no column or a column the canvas does not show.
 */
export function orientDraggedRelationship(prefill: FkDialogPrefill, models: Models): FkDialogPrefill | OrientedPrefill {
  if (!prefill.toColumn) return prefill;
  const has = (model: string, column: string): boolean =>
    !!modelNamed(models, model)?.columns.some((c) => typeof c.name === 'string' && c.name.toLowerCase() === column.toLowerCase());
  if (!has(prefill.fromModel, prefill.fromColumn) || !has(prefill.toModel, prefill.toColumn)) return prefill;
  const o = orientCanvasLink(models,
    { model: prefill.fromModel, columns: [prefill.fromColumn] }, { model: prefill.toModel, columns: [prefill.toColumn] });
  if (!o.decided) {
    return { ...prefill, cardinality: o.cardinality, direction: 'undecided', basis: 'none' };
  }
  return {
    fromModel: o.from.model, fromColumn: o.from.columns[0], toModel: o.to.model, toColumn: o.to.columns[0],
    cardinality: o.cardinality, direction: 'decided', basis: o.basis,
  };
}

/**
 * The New / Edit Relationship dialog's warning (#133, keys win): a
 * many-to-one whose "many" end is its model's whole key while the other end
 * is certainly not the other model's key — the same contradiction that
 * refuses ⇄ and that Move turns round. Key evidence is the models' flags,
 * else dbt's tests. The dialog still lets the user save it ("Create anyway").
 * Null when there is nothing to say.
 */
export function keysContradictionWarning(
  rel: { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: Cardinality },
  models: Models,
  /** A composite's column pairs, the first being rel's (#133 L2): read on the column sets. */
  pairs?: ReadonlyArray<{ fromColumn: string; toColumn: string }>,
): string | null {
  if (!rel.fromModel || !rel.fromColumn || !rel.toModel || !rel.toColumn) return null;
  const members = (pairs && pairs.length > 1 ? pairs : [rel]).map((p) => ({ ...rel, fromColumn: p.fromColumn, toColumn: p.toColumn }));
  if (!contradictsKeysOf(members, (name) => modelNamed(models, name))) return null;
  const end = (model: string, cols: string[]): string => (cols.length === 1 ? `${model}.${cols[0]}` : `${model}.(${cols.join(', ')})`);
  const from = end(rel.fromModel, members.map((m) => m.fromColumn));
  const to = end(rel.toModel, members.map((m) => m.toColumn));
  const evidence = keyEvidenceDetail(modelNamed(models, rel.fromModel), members.map((m) => m.fromColumn));
  const why = evidence.source === 'dbt'
    ? `dbt tests ${from} as unique`
    : `${from} is ${rel.fromModel}'s key`;
  return `${why}, so each value appears only once — it can't be the ` +
    `"many" side. ${to} is probably the source ${members.length > 1 ? 'columns' : 'column'} instead; if you save it this way, Move ` +
    'Relationships to Model Library will turn it round.';
}
