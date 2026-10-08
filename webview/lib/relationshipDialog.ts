/**
 * The words and decisions of the New / Edit Relationship dialog (issue #133),
 * kept pure so they can be tested without rendering it.
 *
 * The dialog states a relationship as a sentence ("Each fct_order points to
 * one dim_customer"), asks how many rows can share one target, reads the
 * result back with where it will be saved, and uses `resolveDirection`'s
 * verdict to decide whether the direction is already settled:
 *
 * - **certain** — prefilled; choosing the other way round shows an amber
 *   warning ("… is normally the 'one' side") and the primary button reads
 *   "Create anyway". Soft: never blocks.
 * - **likely** — prefilled, with the reason on a line of its own.
 * - **ambiguous** — no default: two buttons named after the models, and
 *   Create stays disabled until one is picked.
 */

import type { DirectionVerdict } from '@erd-studio/core';

import type { Cardinality } from '../../src/types/semantic';
import { endEvidenceFor, verdictStartsAt, type DirectionModels } from './relationshipDirection';

/** Four column ends. */
export interface DialogEnds {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

/** The cardinalities the dialog offers, as answers to "How many <from> rows can share one <to>?". */
export const DIALOG_CARDINALITIES: ReadonlyArray<{ value: Cardinality; label: string }> = [
  { value: 'many-to-one', label: 'Many (usual)' },
  { value: 'one-to-one', label: 'Only one' },
  { value: 'many-to-many', label: 'Many on both sides (use a bridge model)' },
];

/** Shown under "Many on both sides". */
export const BRIDGE_HINT =
  'A many-to-many is usually drawn as a bridge model with a many-to-one to each side — that keeps every link a foreign key. Draw it here only to note the idea.';

/** "Why here?" — where relationships live, by project mode. */
export const WHY_HERE_LIBRARY =
  'Relationships live with the model holding the foreign key, so adding a fact never edits its dimensions.';
export const WHY_HERE_DOMAIN =
  "This project keeps each diagram's relationships in the diagram's own file. Move Relationships to Model Library stores them with their models instead.";
/**
 * An older-format (v4, inline-model) diagram keeps its relationships in its
 * own file whatever the project does, and neither the move nor Repair
 * Relationships… writes it: only the migration changes that.
 */
export const WHY_HERE_OLDER_FORMAT =
  'This diagram is in the older format, so its relationships live in its own file. Run "ERD Studio: Migrate Domains to Central Model Store" to bring it up to date.';

/** The sentence at the top of the direction section. */
export function relationshipSentence(ends: DialogEnds, cardinality: Cardinality): string {
  return cardinality === 'many-to-many'
    ? `Each ${ends.fromModel} can match many ${ends.toModel}`
    : `Each ${ends.fromModel} points to one ${ends.toModel}`;
}

/** The cardinality question. */
export function cardinalityQuestion(ends: DialogEnds): string {
  return `How many ${ends.fromModel} rows can share one ${ends.toModel}?`;
}

/**
 * The read-back: what the relationship says from the target's side, and
 * where it is saved. `home` is the canvas payload's `relationshipHome`; with
 * none (an older host) the saved line is left out. `olderFormat`: the
 * diagram is v4 (`schemaVersion` below 5), whose "Why here?" names the
 * migration rather than the project's mode.
 */
export function readBack(
  ends: DialogEnds,
  cardinality: Cardinality,
  home: 'library' | 'domain' | undefined,
  olderFormat = false,
): { text: string; savedIn?: string; why?: string } {
  const text = cardinality === 'one-to-one'
    ? `A ${ends.toModel} has at most one ${ends.fromModel}.`
    : cardinality === 'many-to-many'
      ? `A ${ends.toModel} can match many ${ends.fromModel} too.`
      : `A ${ends.toModel} has many ${ends.fromModel}.`;
  if (home === 'library') return { text, savedIn: `Saved in ${ends.fromModel}.yml`, why: WHY_HERE_LIBRARY };
  if (home === 'domain') return { text, savedIn: 'Saved in this diagram', why: olderFormat ? WHY_HERE_OLDER_FORMAT : WHY_HERE_DOMAIN };
  return { text };
}

/** Whether the ends run the way the verdict says (its "from" is the dialog's "from"). */
export function followsVerdict(verdict: DirectionVerdict, ends: DialogEnds): boolean {
  return verdictStartsAt(verdict, ends.fromModel, ends.fromColumn);
}

/** The same ends, the other way round. */
export function reversed(ends: DialogEnds): DialogEnds {
  return { fromModel: ends.toModel, fromColumn: ends.toColumn, toModel: ends.fromModel, toColumn: ends.fromColumn };
}

/** The ends a verdict proposes. */
export function verdictEnds(verdict: DirectionVerdict): DialogEnds {
  return {
    fromModel: verdict.from.model,
    fromColumn: verdict.from.column,
    toModel: verdict.to.model,
    toColumn: verdict.to.column,
  };
}

/** A stable key for a direction, to remember which one the user picked. */
export function directionKey(ends: DialogEnds): string {
  return [ends.fromModel, ends.fromColumn, ends.toModel, ends.toColumn].join('\u0000').toLowerCase();
}

/**
 * The amber warning when the user has chosen the other way round from a
 * `certain` verdict, or null when there is nothing to warn about. A
 * many-to-many has no "one" side and its ends only decide which file stores
 * it, so it never contradicts anything (as core's REL006 check reads it).
 */
export function contradictionWarning(
  verdict: DirectionVerdict | undefined,
  ends: DialogEnds,
  models: DirectionModels,
  cardinality?: Cardinality,
): string | null {
  if (cardinality === 'many-to-many') return null;
  if (!verdict || verdict.confidence !== 'certain' || followsVerdict(verdict, ends)) return null;
  if (verdict.cardinality === 'one-to-one') {
    const { model, column } = verdict.from;
    return `${model}.${column} is marked as a foreign key, so ${model} is normally the side that points.`;
  }
  const { model, column } = verdict.to;
  const key = endEvidenceFor(models, model, column);
  const what = key && key.isPrimaryKey && key.pkColumnCount === 1 ? 'primary key' : 'natural key';
  return `${model}.${column} is ${model}'s ${what}, so ${model} is normally the 'one' side.`;
}

/** The note shown when a drag was turned round: "Turned round: <reason>". */
export function turnedRoundNote(verdict: DirectionVerdict | undefined): string {
  const reason = verdict?.reasons.join('; ');
  return reason ? `Turned round: ${reason}.` : 'Turned round so the column that points at the key comes first.';
}

/** The reason line for a `likely` verdict. */
export function likelyReason(verdict: DirectionVerdict, ends: DialogEnds): string {
  const why = verdict.reasons.join('; ');
  return followsVerdict(verdict, ends)
    ? `Suggested because ${why}.`
    : `Usually the other way round: ${why}.`;
}

/**
 * The two direction buttons of an ambiguous verdict, in the verdict's fixed
 * order. Named after the models — and after the columns when both ends are
 * in one model (a self-reference, compared without case), where the model
 * names alone would make the two buttons read the same.
 */
export function directionChoices(
  verdict: DirectionVerdict,
  cardinality: Cardinality,
): Array<{ label: string; ends: DialogEnds }> {
  const first = verdictEnds(verdict);
  const sameModel = first.fromModel.toLowerCase() === first.toModel.toLowerCase();
  return [first, reversed(first)].map((ends) => {
    const from = sameModel ? `${ends.fromModel}.${ends.fromColumn}` : ends.fromModel;
    const to = sameModel ? `${ends.toModel}.${ends.toColumn}` : ends.toModel;
    return {
      ends,
      label: cardinality === 'one-to-one'
        ? `${from} holds the key to ${to}`
        : `${from} has many rows per ${to}`,
    };
  });
}

/** The question above the two direction buttons. */
export function directionQuestion(cardinality: Cardinality): string {
  return cardinality === 'one-to-one'
    ? 'Which side holds the foreign key? The keys do not say.'
    : 'Which side has many rows? The keys do not say.';
}

/**
 * Whether the dialog may offer "Mark <col> as <model>'s key": the direction
 * was chosen by the user (ambiguous evidence) and the target model has no
 * primary key yet — ticking it never turns an existing key into a composite.
 */
export function canOfferMarkKey(models: DirectionModels, ends: DialogEnds): boolean {
  const target = endEvidenceFor(models, ends.toModel, ends.toColumn);
  return !!target && target.pkColumnCount === 0;
}
