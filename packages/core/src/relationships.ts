/**
 * Rules for how a relationship is stored, shared by every reader and writer
 * of domain files and `logical-models/*.yml`.
 */

import type { Relationship } from './types/semantic.js';
import { keyEvidenceOf } from './keyEvidence.js';
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
  return contradictsKeysOf([rel], modelOf, dbt);
}

/**
 * {@link contradictsKeys} for the members of one composite foreign key (#133
 * L2), read on their column sets: all many-to-one, every from column together
 * its model's whole key, and the to columns together certainly not the other
 * model's key.
 */
export function contradictsKeysOf(
  members: readonly Relationship[],
  modelOf: (name: string) => KeyedModel | null | undefined,
  dbt?: DbtKeyIndex,
): boolean {
  if (members.length === 0 || members.some((m) => m.cardinality !== 'many-to-one')) return false;
  const { fromModel, toModel } = members[0];
  return keyEvidenceOf(named(modelOf(fromModel), fromModel), members.map((m) => m.fromColumn), dbt) === 'whole-key'
    && keyEvidenceOf(named(modelOf(toModel), toModel), members.map((m) => m.toColumn), dbt) === 'not-key';
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

/** Longest `compositeKey` name kept (#133 L2). */
export const COMPOSITE_KEY_MAX_LENGTH = 64;
/** Most column pairs in one composite foreign key. */
export const MAX_COMPOSITE_PAIRS = 8;

/**
 * A relationship's `compositeKey` as read: trimmed text of 1–64 characters,
 * or undefined — a non-string, blank or longer value is ignored (the entry
 * reads as a single link, and its bytes stay on disk).
 */
export function normaliseCompositeKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return key === '' || key.length > COMPOSITE_KEY_MAX_LENGTH ? undefined : key;
}

/** One column pair of a link: the from end's column and the to end's. */
export interface ColumnPair {
  fromColumn: string;
  toColumn: string;
}

/**
 * Identity of a composite foreign key: its canonical from-model plus its
 * members' sorted `linkKey`s. The same members drawn in two diagrams, or
 * under two `compositeKey` names, are the same composite. Never written.
 */
export function groupKey(members: readonly Relationship[]): string {
  const from = members.length > 0 ? canonicalRelationship(members[0]).fromModel.toLowerCase() : '';
  return `${from}\u0000${members.map(linkKey).sort().join('\u0001')}`;
}

/**
 * Why these entries — sharing one `compositeKey` — do not form one composite
 * foreign key, or null when they do (#133 L2): at least two pairs and at most
 * {@link MAX_COMPOSITE_PAIRS}; all from one model to one model (stored on the
 * many side); one cardinality, many-to-one or one-to-one; and no column used
 * twice at either end.
 */
export function compositeGroupProblem(members: readonly Relationship[]): string | null {
  if (members.length < 2) return 'it has only one column pair';
  if (members.length > MAX_COMPOSITE_PAIRS) return `it has more than ${MAX_COMPOSITE_PAIRS} column pairs`;
  const canon = members.map(canonicalRelationship);
  const lower = (s: string): string => s.toLowerCase();
  if (canon.some((m) => lower(m.fromModel) !== lower(canon[0].fromModel) || lower(m.toModel) !== lower(canon[0].toModel))) {
    return 'its entries join different models';
  }
  if (canon.some((m) => m.cardinality !== canon[0].cardinality)) return 'its entries have different cardinalities';
  if (canon[0].cardinality !== 'many-to-one' && canon[0].cardinality !== 'one-to-one') return 'a composite key can\'t be many-to-many';
  const distinct = (cols: string[]): boolean => new Set(cols.map(lower)).size === cols.length;
  if (!distinct(canon.map((m) => m.fromColumn)) || !distinct(canon.map((m) => m.toColumn))) return 'a column is used twice';
  return null;
}

/** A composite's column pairs, in the members' order and direction. */
export function pairsOf(members: readonly Relationship[]): ColumnPair[] {
  return members.map((m) => ({ fromColumn: m.fromColumn, toColumn: m.toColumn }));
}
