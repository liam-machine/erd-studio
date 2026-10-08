/**
 * The New / Edit Relationship dialog's words for which side holds the
 * foreign key (#133 L1), kept apart from the component so they can be read
 * and tested on their own.
 */

import type { LinkEnd, Orientation } from '@erd-studio/core';

/** `model.column`, or `model.(a, b)` for a composite. */
export function describeEnd(model: string, columns: readonly string[]): string {
  return columns.length === 1 ? `${model}.${columns[0]}` : `${model}.(${columns.join(', ')})`;
}

const columnsText = (columns: readonly string[]): string => (columns.length === 1 ? columns[0] : `(${columns.join(', ')})`);

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
    return `${lead} — both are their model's key, and ${from} is marked as a foreign key.`;
  }
  const reason = (o.to.evidence !== 'unknown' ? why(o.to, keyKind) : null) ?? why(o.from, keyKind);
  return reason ? `${lead} — ${reason}.` : `${lead}.`;
}

/** One of the two choices the dialog offers when nothing says which side holds the foreign key. */
export interface DirectionChoice {
  text: string;
  detail: string;
}

/**
 * The choice "`from` holds the foreign key", named after the models: "Each
 * fct_order row points at one dim_customer", "fct_order holds dim_customer's
 * key" for a one-to-one, or "Each employee row's manager_id points at one
 * employee_id" for a self-reference.
 */
export function directionChoice(
  from: { model: string; columns: readonly string[] },
  to: { model: string; columns: readonly string[] },
  cardinality: string,
): DirectionChoice {
  const detail = `${describeEnd(from.model, from.columns)} → ${describeEnd(to.model, to.columns)}`;
  if (from.model.toLowerCase() === to.model.toLowerCase()) {
    return { text: `Each ${from.model} row's ${columnsText(from.columns)} points at one ${columnsText(to.columns)}`, detail };
  }
  if (cardinality === 'one-to-one') return { text: `${from.model} holds ${to.model}'s key`, detail };
  return { text: `Each ${from.model} row points at one ${to.model}`, detail };
}

export const DIRECTION_QUESTION = 'Which side holds the foreign key?';
export const DIRECTION_MISSING_HINT = 'Pick which side holds the foreign key — ERD Studio has no key or dbt test to tell.';

/** The "mark as primary key" checkbox's label. */
export function markKeyLabel(model: string, columns: readonly string[]): string {
  return columns.length === 1
    ? `Mark ${model}.${columns[0]} as ${model}'s primary key`
    : `Mark (${columns.join(', ')}) as ${model}'s primary key`;
}
