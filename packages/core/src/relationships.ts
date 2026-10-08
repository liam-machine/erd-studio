/**
 * Rules for how a relationship is stored, shared by every reader and writer
 * of domain files and `logical-models/*.yml`.
 */

import type { Relationship } from './types/semantic.js';

type Ends = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

/**
 * The link a relationship draws: its two `model.column` ends in either order,
 * without case (#133). A relationship and the same one read from the other
 * end share it, so one line is drawn, not two.
 */
export function linkKey(rel: Ends): string {
  const end = (model: string, column: string): string => `${model}`.trim().toLowerCase() + '.' + `${column}`.trim().toLowerCase();
  const from = end(rel.fromModel, rel.fromColumn);
  const to = end(rel.toModel, rel.toColumn);
  return from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/** Whether two relationships join the same two columns, either way round. */
export function sameLink(a: Ends, b: Ends): boolean {
  return linkKey(a) === linkKey(b);
}

/**
 * The direction a relationship is stored in (issue #133): the "many" end —
 * the model holding the foreign key — is always `fromModel`, so a relationship
 * lives in the fact's library file however it was drawn. A `one-to-many` is
 * the same relationship read from the other end, so its ends are swapped and
 * it becomes `many-to-one`. `one-to-one` and `many-to-many` have no many end
 * to prefer and keep the direction they were drawn in.
 */
export function canonicalRelationship<T extends Relationship>(rel: T): T {
  return rel.cardinality === 'one-to-many' ? reverseRelationship(rel) : rel;
}

/** The same relationship read from its other end: ends swapped, many-to-one ↔ one-to-many. */
export function reverseRelationship<T extends Relationship>(rel: T): T {
  const flipped = { 'many-to-one': 'one-to-many', 'one-to-many': 'many-to-one' } as const;
  return {
    ...rel,
    fromModel: rel.toModel,
    fromColumn: rel.toColumn,
    toModel: rel.fromModel,
    toColumn: rel.fromColumn,
    cardinality: flipped[rel.cardinality as keyof typeof flipped] ?? rel.cardinality,
  };
}

/**
 * What a model's key flags say about one of its columns (#133): its whole
 * primary or natural key (`whole-key`), a column of a model that declares a
 * single-column key elsewhere (`not-key`), or nothing either way (`unknown` —
 * no key flagged, or only a composite one). The one place relationship
 * direction reads key evidence: Move's turn-round, the read winner, the ⇄
 * refusal and the New Relationship dialog's warning all ask it.
 */
export type KeyEvidence = 'whole-key' | 'not-key' | 'unknown';

/** The parts of a model `keyEvidence` reads. */
export interface KeyedModel {
  columns?: ReadonlyArray<{ name: string; isPrimaryKey?: boolean; isNaturalKey?: boolean }>;
}

export function keyEvidence(model: KeyedModel | null | undefined, column: string): KeyEvidence {
  const columns = model?.columns ?? [];
  const wholeKeys = (['isPrimaryKey', 'isNaturalKey'] as const)
    .map((flag) => columns.filter((c) => c[flag]))
    .filter((keys) => keys.length === 1)
    .map((keys) => keys[0].name.trim().toLowerCase());
  if (wholeKeys.length === 0) return 'unknown';
  return wholeKeys.includes(`${column}`.trim().toLowerCase()) ? 'whole-key' : 'not-key';
}

/**
 * Whether the keys contradict a stored many-to-one: its many side is its
 * model's whole key (each value appears once) and the one side is certainly
 * not the target's key. "Keys win": such an entry is read the other way
 * round. Without that certainty — no key flagged on the target, or a
 * composite one — nothing is turned round.
 */
export function contradictsKeys(rel: Relationship, modelOf: (name: string) => KeyedModel | null | undefined): boolean {
  return rel.cardinality === 'many-to-one'
    && keyEvidence(modelOf(rel.fromModel), rel.fromColumn) === 'whole-key'
    && keyEvidence(modelOf(rel.toModel), rel.toColumn) === 'not-key';
}

/**
 * Where a relationship belongs, by its cardinality and its keys: the
 * `canonicalRelationship`, turned round as a many-to-one when the keys
 * contradict it (`contradictsKeys`). Returns `rel` itself when nothing changes.
 */
export function keyedRelationship<T extends Relationship>(rel: T, modelOf: (name: string) => KeyedModel | null | undefined): T {
  const canonical = canonicalRelationship(rel);
  return contradictsKeys(canonical, modelOf) ? { ...reverseRelationship(canonical), cardinality: 'many-to-one' } : canonical;
}

/** Longest `role` label kept on a relationship. */
export const RELATIONSHIP_ROLE_MAX_LENGTH = 60;

/**
 * A relationship's `role` as stored: trimmed, single-line text, or undefined
 * when absent, blank or not a string. Longer labels are cut to
 * {@link RELATIONSHIP_ROLE_MAX_LENGTH}.
 */
export function normaliseRelationshipRole(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const role = value.replace(/\s+/g, ' ').trim().slice(0, RELATIONSHIP_ROLE_MAX_LENGTH).trim();
  return role === '' ? undefined : role;
}
