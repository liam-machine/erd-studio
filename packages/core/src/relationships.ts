/**
 * Rules for how a relationship is stored, shared by every reader and writer
 * of domain files and `logical-models/*.yml`.
 */

import type { Relationship } from './types/semantic.js';
import { keyEvidence } from './keyEvidence.js';
import type { DbtKeyIndex, KeyedModel } from './keyEvidence.js';

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

/** The parts of a model `respellRelationship` reads. */
interface SpelledModel {
  name: string;
  columns?: ReadonlyArray<{ name?: unknown }>;
}

/**
 * `rel` with each end spelled as the domain's models and columns spell it
 * (#133 L4): `toModel: Dim_Customer` for model `dim_customer` is drawn — and
 * written back, the next time that entry changes — as `dim_customer`. Exact
 * match first, then without case. An end that matches nothing keeps its
 * written spelling. Returns `rel` itself when nothing changes.
 */
export function respellRelationship<T extends Ends>(rel: T, models: readonly SpelledModel[]): T {
  const lower = (s: string): string => s.toLowerCase();
  const spell = (modelName: string, column: string): [string, string] => {
    const model = models.find((m) => m.name === modelName) ?? models.find((m) => lower(m.name) === lower(modelName));
    if (!model) return [modelName, column];
    const names = (model.columns ?? []).map((c) => c?.name).filter((n): n is string => typeof n === 'string');
    const real = names.find((n) => n === column) ?? names.find((n) => lower(n) === lower(column));
    return [model.name, real ?? column];
  };
  const [fromModel, fromColumn] = spell(rel.fromModel, rel.fromColumn);
  const [toModel, toColumn] = spell(rel.toModel, rel.toColumn);
  if (fromModel === rel.fromModel && fromColumn === rel.fromColumn && toModel === rel.toModel && toColumn === rel.toColumn) {
    return rel;
  }
  return { ...rel, fromModel, fromColumn, toModel, toColumn };
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
 * Whether the keys contradict a stored many-to-one: its many side is its
 * model's whole key (each value appears once) and the one side is certainly
 * not the target's key (`keyEvidence`: the model's flags, else dbt's tests).
 * "Keys win": such an entry is read the other way round. Without that
 * certainty — nothing flagged or tested on the target — nothing is turned
 * round.
 */
export function contradictsKeys(
  rel: Relationship,
  modelOf: (name: string) => KeyedModel | null | undefined,
  dbt?: DbtKeyIndex,
): boolean {
  return rel.cardinality === 'many-to-one'
    && keyEvidence(named(modelOf(rel.fromModel), rel.fromModel), rel.fromColumn, dbt) === 'whole-key'
    && keyEvidence(named(modelOf(rel.toModel), rel.toModel), rel.toColumn, dbt) === 'not-key';
}

/** A model as key evidence reads it, named so dbt evidence can be looked up for it. */
const named = (model: KeyedModel | null | undefined, name: string): KeyedModel => (model ? { ...model, name: model.name ?? name } : { name });

/**
 * Where a relationship belongs, by its cardinality and its keys: the
 * `canonicalRelationship`, turned round as a many-to-one when the keys
 * contradict it (`contradictsKeys`). Returns `rel` itself when nothing changes.
 */
export function keyedRelationship<T extends Relationship>(
  rel: T,
  modelOf: (name: string) => KeyedModel | null | undefined,
  dbt?: DbtKeyIndex,
): T {
  const canonical = canonicalRelationship(rel);
  return contradictsKeys(canonical, modelOf, dbt) ? { ...reverseRelationship(canonical), cardinality: 'many-to-one' } : canonical;
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
