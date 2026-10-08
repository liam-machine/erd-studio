/**
 * The messages a canvas sends to change or remove a drawn relationship
 * (issue #133), shared by the edge's ⇄ button, the edge context menu, the
 * detail panel and multi-delete so they all name a relationship the same way.
 *
 * Each carries the ends as drawn plus, when the payload has them, the
 * record's ends exactly as stored on disk (`stored`). The host finds the
 * record by `stored` first and by the link either way round otherwise, so a
 * copy written the other way round, or in other case, is still the one that
 * changes.
 */

import type {
  Cardinality,
  EditRelationshipMessage,
  RelationshipEnds,
  RelationshipIssueCode,
  RelationshipSource,
  RemoveRelationshipMessage,
  UpdateRelationshipMessage,
} from '@erd-studio/core';

import { swapCardinality } from './cardinalityUtils';

/** A drawn relationship as the canvas knows it (edge data or a domain relationship). */
export interface DrawnRelationship extends RelationshipEnds {
  cardinality: Cardinality;
  role?: string;
  stored?: RelationshipEnds;
}

/** The ends as drawn, plus the stored ends when known. */
export type RelationshipTarget = RelationshipEnds & { stored?: RelationshipEnds };

/** `updateRelationship`, with the stored ends the host matches first. */
export type UpdateRelationshipRequest = UpdateRelationshipMessage;

/** `editRelationship` (the original key is the ends as drawn). */
export type EditRelationshipRequest = EditRelationshipMessage;

/** `removeRelationship`, with the stored ends the host matches first. */
export type RemoveRelationshipRequest = RemoveRelationshipMessage;

export type RelationshipRequest = UpdateRelationshipRequest | EditRelationshipRequest | RemoveRelationshipRequest;

/** The drawn ends of a relationship, plus its stored ends when it has them. */
export function relationshipTarget(rel: RelationshipEnds & { stored?: RelationshipEnds }): RelationshipTarget {
  return {
    fromModel: rel.fromModel,
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    ...(rel.stored ? { stored: endsOf(rel.stored) } : {}),
  };
}

/** Just the four ends (never a runtime-only field). */
function endsOf(ends: RelationshipEnds): RelationshipEnds {
  return { fromModel: ends.fromModel, fromColumn: ends.fromColumn, toModel: ends.toModel, toColumn: ends.toColumn };
}

/** Change a relationship's cardinality, keeping its ends and role. */
export function updateCardinalityRequest(rel: DrawnRelationship, cardinality: Cardinality): UpdateRelationshipRequest {
  return { type: 'updateRelationship', payload: { ...relationshipTarget(rel), cardinality } };
}

/** Remove a relationship. */
export function removeRelationshipRequest(rel: RelationshipEnds & { stored?: RelationshipEnds }): RemoveRelationshipRequest {
  return { type: 'removeRelationship', payload: relationshipTarget(rel) };
}

/** What the ⇄ button does to a relationship, and the words that say so. */
export interface RelationshipSwap {
  request: UpdateRelationshipRequest | EditRelationshipRequest;
  /** Tooltip / accessible name: what pressing ⇄ will do, in the models' names. */
  title: string;
}

/**
 * The ⇄ action for a relationship.
 *
 * - `many-to-one` / `one-to-many`: flip which side is "many" — an
 *   `updateRelationship` with the swapped cardinality; the host stores the
 *   result as `many-to-one` on the new many side.
 * - `one-to-one`: the ends are swapped (direction there means "fromModel
 *   holds the foreign key"), through `editRelationship` with the role kept.
 * - `many-to-many`: no side is "many" over the other; the ends are swapped
 *   the same way, which only changes which model the record is stored with.
 */
export function relationshipSwap(rel: DrawnRelationship): RelationshipSwap {
  const { fromModel, toModel, cardinality } = rel;
  // A relationship from a model to itself (a hierarchy) has the same model at
  // both ends, so the words name the columns — "Make employee the many side"
  // would read as already true and hide that the key columns trade places.
  const selfReference = fromModel.toLowerCase() === toModel.toLowerCase();
  const fromEnd = `${fromModel}.${rel.fromColumn}`;
  const toEnd = `${toModel}.${rel.toColumn}`;
  if (cardinality === 'many-to-one' || cardinality === 'one-to-many') {
    // After the swap the "many" end is the other one.
    const nextMany = cardinality === 'many-to-one' ? toModel : fromModel;
    const [pointing, pointedAt] = cardinality === 'many-to-one' ? [toEnd, fromEnd] : [fromEnd, toEnd];
    return {
      request: updateCardinalityRequest(rel, swapCardinality(cardinality)),
      title: selfReference
        ? `Make ${pointing} point at ${pointedAt} (the many side)`
        : `Make ${nextMany} the many side`,
    };
  }
  return {
    request: {
      type: 'editRelationship',
      payload: {
        originalFromModel: rel.fromModel,
        originalFromColumn: rel.fromColumn,
        originalToModel: rel.toModel,
        originalToColumn: rel.toColumn,
        fromModel: rel.toModel,
        fromColumn: rel.toColumn,
        toModel: rel.fromModel,
        toColumn: rel.fromColumn,
        cardinality,
        role: rel.role ?? '',
        ...(rel.stored ? { stored: endsOf(rel.stored) } : {}),
      },
    },
    title: cardinality === 'one-to-one'
      ? (selfReference ? `Make ${toEnd} hold the key to ${fromEnd}` : `Make ${toModel} the side that holds the foreign key`)
      : `Swap the ends (list ${selfReference ? toEnd : toModel} first)`,
  };
}

/** Issue codes worth a badge on the edge itself (the rest go to the canvas banner). */
export const EDGE_ISSUE_CODES: readonly RelationshipIssueCode[] = ['REL001', 'REL002', 'REL006'];

/** One plain sentence per edge issue code. */
const EDGE_ISSUE_TEXT: Partial<Record<RelationshipIssueCode, string>> = {
  REL001: 'Saved more than once — Repair Relationships… removes exact copies; copies that disagree are listed for you to settle.',
  REL002: 'Saved as one-to-many in the "one" model\'s file — Repair Relationships… moves it to the many side.',
  REL006: 'Its direction disagrees with the key columns — check which side is "many": ⇄ turns it round, or make it one-to-one if both '
    + 'sides are unique. When a model file holds it in the shape ERD Studio 1.6.7 saved (a dimension\'s key as the many side of a fact '
    + 'that has its own key), Repair Relationships… turns it round for you.',
};

/** The edge-badge issues of a relationship, in code order (empty when none). */
export function edgeIssues(issues: readonly RelationshipIssueCode[] | undefined): RelationshipIssueCode[] {
  if (!issues || issues.length === 0) return [];
  return EDGE_ISSUE_CODES.filter((code) => issues.includes(code));
}

/**
 * The same sentences on a diagram in the older (v4, inline-model) format,
 * which Repair Relationships… never changes: point at the migration first.
 * Edit or ⇄ on the line keeps one copy only when the copies agree (a commit
 * refuses copies that disagree), so the badge never offers it unqualified.
 */
const OLDER_FORMAT_EDGE_ISSUE_TEXT: Partial<Record<RelationshipIssueCode, string>> = {
  REL001: 'Saved more than once — this diagram is in the older format: run "ERD Studio: Migrate Domains to Central Model Store" first; after that, Repair Relationships… removes exact copies and lists the rest. Edit or ⇄ on the line keeps one copy only when every copy says the same — copies that disagree are refused there.',
  REL002: 'Saved as one-to-many in the "one" model\'s file — this diagram is in the older format: run "ERD Studio: Migrate Domains to Central Model Store" first.',
};

/** The "?" badge's tooltip: one line per issue. `olderFormat`: the diagram is v4. */
export function edgeIssueTitle(codes: readonly RelationshipIssueCode[], options: { olderFormat?: boolean } = {}): string {
  const text = (code: RelationshipIssueCode): string =>
    (options.olderFormat ? OLDER_FORMAT_EDGE_ISSUE_TEXT[code] : undefined) ?? EDGE_ISSUE_TEXT[code] ?? code;
  return ['This relationship needs attention:', ...codes.map((code) => `• ${code}: ${text(code)}`)].join('\n');
}

/**
 * Where a drawn relationship is stored, for the detail panel's "Stored in"
 * tooltip: the model library file of the model it was read from, or this
 * diagram's own file. Undefined without provenance (physical stage, viewer
 * payloads from hosts that do not send it).
 */
export function relationshipStoredIn(
  source: RelationshipSource | undefined,
  domain: { layer: string; domain: string },
): string | undefined {
  if (!source) return undefined;
  return source.kind === 'library'
    ? `${source.model}.yml (model library)`
    : `${domain.layer}/${domain.domain}.json (this diagram)`;
}
