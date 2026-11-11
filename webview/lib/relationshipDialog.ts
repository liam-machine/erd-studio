/**
 * The New / Edit Relationship dialog's words for which side holds the
 * foreign key (#133 L1), kept apart from the component so they can be read
 * and tested on their own.
 */

import type { LinkEnd, Orientation } from '@erd-studio/core';
import { CARDINALITY_NAMES, columnsText, describeEnd } from '../../src/types/relationshipWording';

// The direction and cardinality words the host says too (Suggest Relationships), kept in one shared module.
export {
  CARDINALITY_NAMES, DIRECTION_MISSING_HINT, DIRECTION_MISSING_HINT_LOGICAL, DIRECTION_QUESTION, describeEnd, directionChoice,
} from '../../src/types/relationshipWording';
export type { DirectionChoice } from '../../src/types/relationshipWording';

/** Why an end is (or is not) its model's key, in a few words — or null when nothing is known. */
function why(end: LinkEnd, keyKind: (end: LinkEnd) => 'primary key' | 'natural key'): string | null {
  const at = describeEnd(end.model, end.columns);
  if (end.source === 'keys') {
    return end.evidence === 'whole-key'
      ? `${columnsText(end.columns)} is ${end.model}'s ${keyKind(end)}`
      : `${end.model}'s key is another column, so ${columnsText(end.columns)} can repeat there`;
  }
  if (end.source === 'dbt') {
    switch (end.because) {
      case 'unique-test': return `dbt tests ${at} as unique`;
      case 'unique-combination': return `dbt tests ${at} as a unique combination`;
      case 'part-of-unique-combination': return `dbt tests ${at} only as part of a unique combination`;
      case 'relationships-test': return `dbt has a relationships test leaving ${at}`;
      default: return null;
    }
  }
  return null;
}

/**
 * The sentence under the column pickers for a decided orientation: which
 * end points at which, and what says so — the key end's evidence first.
 */
export function directionSentence(o: Orientation, keyKind: (end: LinkEnd) => 'primary key' | 'natural key'): string {
  const from = describeEnd(o.from.model, o.from.columns);
  const to = describeEnd(o.to.model, o.to.columns);
  const lead = o.cardinality === 'one-to-one' ? `${from} holds ${to}'s key` : `${from} points at ${to}`;
  if (o.cardinality === 'one-to-one' && o.from.declaredFk) {
    return `${lead} — both are their table's key, and ${from} is marked as a foreign key.`;
  }
  const reason = (o.to.evidence !== 'unknown' ? why(o.to, keyKind) : null) ?? why(o.from, keyKind);
  return reason ? `${lead} — ${reason}.` : `${lead}.`;
}

/** The "mark as primary key" checkbox's label. */
export function markKeyLabel(model: string, columns: readonly string[]): string {
  return columns.length === 1
    ? `Mark ${model}.${columns[0]} as ${model}'s primary key`
    : `Mark (${columns.join(', ')}) as ${model}'s primary key`;
}

// Composite foreign keys (#133 L2)

export const ADD_PAIR_LABEL = '+ Add another column pair';
export const PAIR_INCOMPLETE = 'Pick both columns';
export const COMPOSITE_MANY_TO_MANY_TITLE = "A composite key can't be many-to-many";
export const COMPOSITE_MANY_TO_MANY_ERROR = "A composite key can't be many-to-many — pick many-to-one or one-to-one";
export const ABSORB_HINT = 'Already a relationship — it will become part of this key.';

/** A pair's column already used by an earlier pair at the same end. */
export function pairColumnUsed(column: string): string {
  return `${column} is already used in this key`;
}

/** The dialog's title: "New Relationship", or "New Composite Relationship" with two or more pairs. */
export function dialogTitle(editing: boolean, pairCount: number): string {
  return `${editing ? 'Edit' : 'New'} ${pairCount > 1 ? 'Composite ' : ''}Relationship`;
}

/** The New / Edit Relationship dialog's "How many?" field label. */
export const HOW_MANY_LABEL = 'How many?';

/** The cardinalities the dialog offers, in its order (one-to-many is stored turned round, #133). */
export type DialogCardinality = 'many-to-one' | 'one-to-one' | 'many-to-many';

/** The notation, kept for tooltips only. */
const CARDINALITY_NOTATION: Record<DialogCardinality, string> = {
  'many-to-one': 'N:1, *→1',
  'one-to-one': '1:1',
  'many-to-many': 'N:M, *↔*',
};

/**
 * One "How many?" option, phrased with the chosen tables: "Many fct_order
 * rows → one dim_customer", "One fct_order row → one dim_customer",
 * "Many → many". Before both tables are chosen it says "Many → one". The
 * notation is in `title` only.
 */
export function cardinalityChoice(cardinality: DialogCardinality, from: string, to: string): { text: string; title: string } {
  const title = `${CARDINALITY_NAMES[cardinality]} (${CARDINALITY_NOTATION[cardinality]})`;
  const named = from !== '' && to !== '';
  switch (cardinality) {
    case 'many-to-one':
      return { text: named ? `Many ${from} rows → one ${to}` : 'Many → one', title };
    case 'one-to-one':
      return { text: named ? `One ${from} row → one ${to}` : 'One → one', title };
    default:
      return { text: 'Many → many', title };
  }
}
