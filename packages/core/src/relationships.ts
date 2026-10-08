/**
 * Rules for how a relationship is stored, shared by every reader and writer
 * of domain files and `logical-models/*.yml`.
 */

import type { Relationship } from './types/semantic.js';

/**
 * The four column ends of a relationship, without its cardinality or role.
 * What every "is this the same link?" question compares (issue #133).
 * Composite foreign keys, when they come, extend the column ends rather than
 * replacing this shape.
 */
export type RelationshipEnds = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

/**
 * The link a relationship draws: its two `model.column` ends, lowercased,
 * sorted and joined with NUL — so a relationship and the same one read from
 * the other end (a library entry on the many side, a domain copy drawn the
 * other way, a `one-to-many` before it is turned round) share one key, and one
 * line is drawn, not two. Cardinality and role are not part of it.
 */
export function linkKey(ends: RelationshipEnds): string {
  const from = `${ends.fromModel}.${ends.fromColumn}`.toLowerCase();
  const to = `${ends.toModel}.${ends.toColumn}`.toLowerCase();
  return from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}

/** Whether two relationships draw the same link: {@link linkKey} equality, either way round, without case. */
export function sameLink(a: RelationshipEnds, b: RelationshipEnds): boolean {
  return linkKey(a) === linkKey(b);
}

/** Just the ends of a relationship (drops cardinality, role and any runtime-only field). */
export function relationshipEnds(rel: RelationshipEnds): RelationshipEnds {
  return { fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn };
}

/**
 * Where a drawn relationship was read from (runtime-only, never written):
 * entry `index` of `model`'s library file `relationships:` list — counted in
 * the list as read, i.e. `SemanticModel.relationships[index]`, which skips
 * entries the reader could not read — or entry `index` of the domain file's
 * own `logical.relationships` as parsed.
 */
export type RelationshipSource =
  | { kind: 'library'; model: string; index: number }
  | { kind: 'domain'; index: number };

/**
 * Stable codes for what can be wrong with stored relationships (issue #133).
 *
 * - REL001 the same link is stored more than once
 * - REL002 a `one-to-many` stored in a model file (it belongs on the other model, as `many-to-one`)
 * - REL003 an endpoint model is missing from the model library
 * - REL004 an endpoint column is missing from its model
 * - REL005 an endpoint matches a model or column only when case is ignored
 * - REL006 the stored direction contradicts certain key evidence
 * - REL008 a model file entry was skipped or defaulted on read
 * - REL009 a domain-file copy of a link the model library also holds
 */
export type RelationshipIssueCode =
  | 'REL001' | 'REL002' | 'REL003' | 'REL004' | 'REL005' | 'REL006' | 'REL008' | 'REL009';

/** How serious a relationship finding is. `info` never fails a check run. */
export type RelationshipSeverity = 'error' | 'warning' | 'info';

/**
 * One thing `normaliseRelationships` noticed while reading a domain's
 * relationships. `link` is the {@link linkKey} it is about ('' for REL008,
 * which is about a model file entry that could not be read); `sources` names
 * every record involved, the drawn one first.
 */
export interface RelationshipDiagnostic {
  code: RelationshipIssueCode;
  severity: RelationshipSeverity;
  message: string;
  link: string;
  sources: RelationshipSource[];
}

/**
 * The direction a relationship is stored in (issue #133): the "many" end —
 * the model holding the foreign key — is always `fromModel`, so a relationship
 * lives in the fact's library file however it was drawn. A `one-to-many` is
 * the same relationship read from the other end, so its ends are swapped and
 * it becomes `many-to-one`. `one-to-one` and `many-to-many` have no many end
 * to prefer and keep the direction they were drawn in (for `one-to-one`,
 * `fromModel` is the model holding the foreign key).
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

/**
 * The model whose file a relationship is stored in, in a project that keeps
 * relationships in the model library: the canonical `fromModel`. Computed
 * from the record alone — never from key flags.
 */
export function relationshipHomeModel(rel: Relationship): string {
  return canonicalRelationship(rel).fromModel;
}

/**
 * Whether two stored relationships say the same thing about the same link:
 * same canonical cardinality, same role and — except for `many-to-many`, which
 * has no direction — the same canonical direction. A `one-to-one` A→B and
 * B→A are different (each names the other as the foreign-key holder).
 */
export function sameRelationshipMeaning(a: Relationship, b: Relationship): boolean {
  if (!sameLink(a, b)) return false;
  const ca = canonicalRelationship(a);
  const cb = canonicalRelationship(b);
  if (ca.cardinality !== cb.cardinality) return false;
  if ((ca.role ?? '') !== (cb.role ?? '')) return false;
  if (ca.cardinality === 'many-to-many') return true;
  return `${ca.fromModel}.${ca.fromColumn}`.toLowerCase() === `${cb.fromModel}.${cb.fromColumn}`.toLowerCase();
}

/**
 * What two records of one link disagree on, in reading order: `cardinality`,
 * `direction` (the same one-to-one or many-to-one stored the other way round)
 * and `role`. Empty when they say the same (`sameRelationshipMeaning`).
 * Compared canonically, so a `one-to-many` and the `many-to-one` it reads as
 * from the other end do not differ.
 */
export function relationshipDifferences(a: Relationship, b: Relationship): Array<'cardinality' | 'direction' | 'role'> {
  const ca = canonicalRelationship(a);
  const cb = canonicalRelationship(b);
  const out: Array<'cardinality' | 'direction' | 'role'> = [];
  if (ca.cardinality !== cb.cardinality) out.push('cardinality');
  else if (ca.cardinality !== 'many-to-many'
    && `${ca.fromModel}.${ca.fromColumn}`.toLowerCase() !== `${cb.fromModel}.${cb.fromColumn}`.toLowerCase()) out.push('direction');
  if ((ca.role ?? '') !== (cb.role ?? '')) out.push('role');
  return out;
}

/**
 * A relationship without the runtime-only fields `normaliseRelationships`
 * adds (`source`, `stored`, `issues`) — what a writer may put on disk.
 */
export function stripRelationshipProvenance<T extends Relationship>(rel: T): Omit<T, 'source' | 'stored' | 'issues'> {
  const { source: _source, stored: _stored, issues: _issues, ...rest } = rel;
  return rest;
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

/**
 * Whether a stored `role` is longer than {@link RELATIONSHIP_ROLE_MAX_LENGTH}
 * once its whitespace is collapsed — so a reader shows it shortened. The
 * readers report such an entry (REL008) rather than cutting it silently, and
 * the writers keep the text on disk unless the role itself is changed.
 */
export function relationshipRoleTooLong(value: unknown): boolean {
  return typeof value === 'string' && value.replace(/\s+/g, ' ').trim().length > RELATIONSHIP_ROLE_MAX_LENGTH;
}

/**
 * The role to write for a record whose stored role is `stored` and whose
 * wanted role is `wanted`: the stored text, exactly as written, when it reads
 * as the wanted role (a long or multi-line label the canvas shows shortened
 * is not cut on disk by an unrelated edit); otherwise the wanted role.
 */
export function keepStoredRole(stored: unknown, wanted: string | undefined): string | undefined {
  const normalised = normaliseRelationshipRole(wanted);
  if (typeof stored === 'string' && normalised !== undefined && normaliseRelationshipRole(stored) === normalised) return stored;
  return normalised;
}

/**
 * Where each relationship that was read sits in its file's own list: the
 * reader leaves skipped entries out, so the n-th relationship read is not
 * always the n-th entry written. `issues` are the reader's per-entry issues
 * (`SemanticModel.relationshipIssues`, a domain file's read issues); the
 * result maps a read index to the 0-based position in the file.
 */
export function relationshipFilePositions(
  readCount: number,
  issues: ReadonlyArray<{ index: number; skipped: boolean; reason?: string }> | undefined,
): number[] {
  const skipped = new Set((issues ?? []).filter((i) => i.skipped && i.reason !== 'not-a-list').map((i) => i.index));
  const positions: number[] = [];
  for (let raw = 0; positions.length < readCount; raw++) {
    if (!skipped.has(raw)) positions.push(raw);
  }
  return positions;
}
