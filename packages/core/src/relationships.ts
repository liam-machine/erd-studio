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
  const from = `${rel.fromModel}.${rel.fromColumn}`.toLowerCase();
  const to = `${rel.toModel}.${rel.toColumn}`.toLowerCase();
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
  if (rel.cardinality !== 'one-to-many') return rel;
  return {
    ...rel,
    fromModel: rel.toModel,
    fromColumn: rel.toColumn,
    toModel: rel.fromModel,
    toColumn: rel.fromColumn,
    cardinality: 'many-to-one',
  };
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
