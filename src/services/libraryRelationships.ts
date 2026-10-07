/**
 * Relationships stored once in the model library (issue #126), and the one
 * write path every canvas relationship edit takes (issue #133).
 *
 * A relationship lives in the file of the model holding its foreign key — its
 * canonical `fromModel` — under `relationships:`, and every domain that holds
 * both ends draws it (the read side is `normaliseRelationships` in
 * `@erd-studio/core`). A project that still keeps relationships in its domain
 * files stores them there instead, in the same canonical direction.
 * `planRelationshipCommit` is the write side of both: it takes the endpoint
 * models and the domain file's list, edits them in place and says what
 * changed, which the editor saves through one WorkspaceEdit.
 *
 * "The same relationship" always means the same link — core's `linkKey`: the
 * two `model.column` ends, either way round, without case.
 *
 * Pure: no `vscode`, no file access.
 */

import {
  RELATIONSHIP_ROLE_MAX_LENGTH,
  VALID_CARDINALITIES,
  canonicalRelationship,
  keepStoredRole,
  linkKey,
  normaliseRelationshipRole,
  relationshipFilePositions,
  sameLink,
  sameRelationshipMeaning,
  type DisplayRelationshipIssue,
  type RelationshipEnds,
  type RelationshipFinding,
  type RelationshipIssueCode,
} from '@erd-studio/core';
import type { Cardinality, ModelRelationship, Relationship, SemanticModel } from '../types/semantic';
import { countAffectedRelationships } from '../types/relationshipIssues';
import { describeExtras, domainObjectExtras } from './relationshipEntryExtras';

export type { RelationshipEnds };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `cardinality` as read from the other end (many-to-one ↔ one-to-many). */
function readFromOtherEnd(cardinality: Cardinality): Cardinality {
  if (cardinality === 'many-to-one') return 'one-to-many';
  if (cardinality === 'one-to-many') return 'many-to-one';
  return cardinality;
}

/** Whether `model.column` is the `side` end of `rel`, without case. */
function endIs(rel: RelationshipEnds, side: 'from' | 'to', model: string, column?: string): boolean {
  const m = side === 'from' ? rel.fromModel : rel.toModel;
  const c = side === 'from' ? rel.fromColumn : rel.toColumn;
  return same(m, model) && (column === undefined || same(c, column));
}

/**
 * Whether new relationships go to the model library. Like layer folders this
 * is opt-in per project, decided by what is on disk: true once any model file
 * carries a relationship (someone ran "Move Relationships to Model Library",
 * or wrote one by hand), and for a project whose domain files hold none, which
 * has no per-domain convention to keep. A project that keeps relationships in
 * its domain files carries on doing so — a teammate on a version before this
 * one would not see an edge stored in the library.
 *
 * Evaluated before an edit, never changed by one (R3): a commit writes where
 * this says, and only "Move Relationships to Model Library" / "Repair
 * Relationships…" move relationships between the two.
 */
export function usesLibraryRelationships(
  models: readonly SemanticModel[],
  domainFileRelationshipCount: number,
  /**
   * Model files that cannot be read but whose text has a `relationships:`
   * key (`UncheckableModelFile.holdsRelationships`). They are library
   * evidence too: a YAML error in the one file holding relationships must
   * never switch where every new relationship is written.
   */
  unreadableWithRelationships = 0,
): boolean {
  // A file whose `relationships:` holds only entries that could not be read
  // (REL008 — a mapping, an entry missing an end) is evidence too, exactly as
  // the same key in a file with a YAML error is: fixing the YAML error must
  // not switch the project back to per-domain without a word.
  return domainFileRelationshipCount === 0
    || unreadableWithRelationships > 0
    || models.some((m) => (m.relationships?.length ?? 0) > 0 || (m.relationshipIssues?.length ?? 0) > 0);
}

/** The full relationships stored in `model`'s library file. */
export function libraryRelationshipsOf(model: SemanticModel): Relationship[] {
  return (model.relationships ?? []).map((rel) => ({ fromModel: model.name, ...rel }));
}

/** Whether `model`'s library file stores the link these ends draw (either way round). */
export function hasLibraryRelationship(model: SemanticModel, ends: RelationshipEnds): boolean {
  return libraryRelationshipsOf(model).some((rel) => sameLink(rel, ends));
}

/**
 * Whether two relationships join the same two columns, in either direction
 * (issue #133): `dim.id → fct.dim_id` and `fct.dim_id → dim.id` are one link,
 * so a second one would draw a duplicate line. Core's `sameLink`, kept under
 * its first name for existing callers.
 */
export const sameColumnPair: (a: RelationshipEnds, b: RelationshipEnds) => boolean = sameLink;

/** The relationship any library model stores between these two columns, either way round. */
export function findLibraryColumnPair(models: readonly SemanticModel[], ends: RelationshipEnds): Relationship | undefined {
  for (const model of models) {
    const found = libraryRelationshipsOf(model).find((rel) => sameLink(rel, ends));
    if (found) return found;
  }
  return undefined;
}

/**
 * The library entry for `rel`, without `fromModel`: the four stored fields,
 * plus `role` when it has one. Runtime-only fields (`source`, `stored`,
 * `issues`) are never copied.
 */
function libraryEntry(rel: Relationship): ModelRelationship {
  return {
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
    ...(rel.role ? { role: rel.role } : {}),
  };
}

/** A domain-file entry for `rel`: the five stored fields, plus `role` when it has one. */
function domainEntry(rel: Relationship): Relationship {
  return {
    fromModel: rel.fromModel,
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
    ...(rel.role ? { role: rel.role } : {}),
  };
}

/**
 * The domain-file entry for `rel` written over the entry it replaces: that
 * entry's own keys (a `description`, `tests`, anything a relationship does
 * not have) and their order are kept, the relationship's fields are set to
 * `rel`'s, and a role `rel` does not have is removed. Without an entry to
 * replace, the plain {@link domainEntry}.
 */
function domainEntryOver(existing: Relationship | undefined, rel: Relationship): Relationship {
  if (!existing || typeof existing !== 'object') return domainEntry(rel);
  const out: Record<string, unknown> = { ...(existing as unknown as Record<string, unknown>) };
  for (const key of ['source', 'stored', 'issues']) delete out[key];
  Object.assign(out, domainEntry(rel));
  if (!rel.role) delete out.role;
  return out as unknown as Relationship;
}

/**
 * Add or replace a relationship on its from-model (`model.name` must be
 * `rel.fromModel`, already in its stored direction — see
 * `canonicalRelationship`). An entry for the same link (either way round) is
 * replaced in place; any further copy of it in this file is dropped. Returns
 * false when an identical one is already there.
 */
export function upsertLibraryRelationship(model: SemanticModel, rel: Relationship): boolean {
  const key = linkKey(rel);
  const list = model.relationships ?? [];
  const entry = libraryEntry(rel);
  const index = list.findIndex((r) => linkKey({ fromModel: model.name, ...r }) === key);
  if (index === -1) {
    model.relationships = [...list, entry];
    return true;
  }
  const current = list[index];
  const duplicates = list.filter((r, i) => i !== index && linkKey({ fromModel: model.name, ...r }) === key).length;
  const identical = (['fromColumn', 'toModel', 'toColumn', 'cardinality', 'role'] as const).every((k) => current[k] === entry[k]);
  if (duplicates === 0 && identical) {
    return false;
  }
  model.relationships = list
    .map((r, i) => (i === index ? entry : r))
    .filter((r, i) => i === index || linkKey({ fromModel: model.name, ...r }) !== key);
  return true;
}

/** Remove each model's relationships for which `drop` is true. Returns the models changed. */
function dropWhere(models: readonly SemanticModel[], drop: (rel: Relationship) => boolean): SemanticModel[] {
  const changed: SemanticModel[] = [];
  for (const model of models) {
    const list = model.relationships ?? [];
    const kept = list.filter((rel) => !drop({ fromModel: model.name, ...rel }));
    if (kept.length === list.length) continue;
    if (kept.length > 0) {
      model.relationships = kept;
    } else {
      delete model.relationships;
    }
    changed.push(model);
  }
  return changed;
}

/** Remove every library copy of the links these ends draw (either way round, without case). */
export function removeLibraryRelationships(
  models: readonly SemanticModel[],
  ends: readonly RelationshipEnds[],
): SemanticModel[] {
  const keys = new Set(ends.map(linkKey));
  return dropWhere(models, (rel) => keys.has(linkKey(rel)));
}

/** Remove every library relationship that starts or ends at `model.column`. */
export function removeColumnRelationships(
  models: readonly SemanticModel[],
  modelName: string,
  column: string,
): SemanticModel[] {
  return dropWhere(models, (rel) => endIs(rel, 'from', modelName, column) || endIs(rel, 'to', modelName, column));
}

/**
 * Follow a column rename: the model's own relationships leaving that column,
 * and every other model's relationships pointing at it (names without case).
 */
export function renameColumnInRelationships(
  models: readonly SemanticModel[],
  modelName: string,
  oldColumn: string,
  newColumn: string,
): SemanticModel[] {
  const changed: SemanticModel[] = [];
  for (const model of models) {
    let touched = false;
    for (const rel of model.relationships ?? []) {
      if (same(model.name, modelName) && same(rel.fromColumn, oldColumn)) {
        rel.fromColumn = newColumn;
        touched = true;
      }
      if (same(rel.toModel, modelName) && same(rel.toColumn, oldColumn)) {
        rel.toColumn = newColumn;
        touched = true;
      }
    }
    if (touched) changed.push(model);
  }
  return changed;
}

/** Follow a model rename in every other model's relationships that point at it (name without case). */
export function renameModelInRelationships(
  models: readonly SemanticModel[],
  oldName: string,
  newName: string,
): SemanticModel[] {
  const changed: SemanticModel[] = [];
  for (const model of models) {
    let touched = false;
    for (const rel of model.relationships ?? []) {
      if (same(rel.toModel, oldName)) {
        rel.toModel = newName;
        touched = true;
      }
    }
    if (touched) changed.push(model);
  }
  return changed;
}

/**
 * Send relationships a canvas or Draw from dbt would add to a domain file to
 * their from-models instead. `newModels` are models about to be created (they
 * take their relationships directly); any other from-model is looked up with
 * `libraryModel`, which must return a copy the caller may change. A
 * relationship whose from-model has neither stays in `kept`, for the domain
 * file. `changed` lists every model to save, new ones included only when they
 * gained a relationship. A link either end's file already stores (either way
 * round) is left as it is: that entry already draws it.
 */
export function routeToLibrary(
  relationships: readonly Relationship[],
  newModels: readonly SemanticModel[],
  libraryModel: (name: string) => SemanticModel | null,
): { kept: Relationship[]; changed: SemanticModel[] } {
  const kept: Relationship[] = [];
  const changed = new Map<string, SemanticModel>();
  const loaded = new Map<string, SemanticModel | null>();
  const modelFor = (name: string): SemanticModel | null => {
    const fresh = newModels.find((m) => same(m.name, name));
    if (fresh) return fresh;
    const key = name.toLowerCase();
    if (!loaded.has(key)) loaded.set(key, libraryModel(name));
    return loaded.get(key) ?? null;
  };
  for (const drawn of relationships) {
    const rel = canonicalRelationship(drawn);
    const model = modelFor(rel.fromModel);
    if (!model) {
      kept.push(drawn);
      continue;
    }
    // Already stored, here or on the other end (by hand, or before #133):
    // that entry already draws this link, so a second would only duplicate it.
    const other = modelFor(rel.toModel);
    if ([model, other].some((m) => m !== null && hasLibraryRelationship(m, rel))) continue;
    if (upsertLibraryRelationship(model, { ...rel, fromModel: model.name })) changed.set(model.name, model);
  }
  return { kept, changed: [...changed.values()] };
}

// ---------------------------------------------------------------------------
// The one write path (issue #133, R4)
// ---------------------------------------------------------------------------

/** Where a project keeps relationships: the model library, or each domain file. */
export type RelationshipMode = 'library' | 'domain';

/** A column the same commit marks as its model's primary key (the dialog's "Mark … as … key"). */
export interface RelationshipMarkKey {
  model: string;
  column: string;
}

/**
 * One relationship edit from the canvas.
 *
 * - `add` — a new link (`rel` as drawn; stored canonical).
 * - `update` — a new cardinality for the link `stored` names (the ⇄ swap and
 *   the context menu). The cardinality is read in the direction the link is
 *   drawn: `drawn`, the ends as the canvas showed them, when given — so a
 *   canvas drawn before the link was turned round elsewhere still gets what
 *   it showed — else the canonical direction of the record a reader draws. A
 *   `one-to-many` turns it round. The role is kept exactly as stored.
 * - `edit` — the dialog: the link `stored` names becomes `next` (ends,
 *   cardinality and role; a blank role clears it).
 * - `remove` — every link `stored` names.
 *
 * `stored` may be the ends as drawn or as on disk: both name the same link.
 */
export type RelationshipCommitOp =
  | { kind: 'add'; rel: Relationship; markKey?: RelationshipMarkKey }
  | { kind: 'update'; stored: RelationshipEnds; cardinality: Cardinality; drawn?: RelationshipEnds }
  | { kind: 'edit'; stored: RelationshipEnds; next: Relationship; markKey?: RelationshipMarkKey }
  | { kind: 'remove'; stored: readonly RelationshipEnds[] };

export interface RelationshipCommitInput {
  /** Where the project keeps relationships, decided before the edit (`usesLibraryRelationships`; always `domain` for a v4 domain). */
  mode: RelationshipMode;
  op: RelationshipCommitOp;
  /**
   * Copies of the models at the ends of the link(s) — for an edit that
   * changes ends, the old and the new ones — already read. Edited in place.
   * Their `relationships` are only read and written in `library` mode.
   */
  endpointModels: readonly SemanticModel[];
  /** The current domain file's `logical.relationships`. Not edited; the result carries the new list. */
  domainRelationships: readonly Relationship[];
  /**
   * The project's other domain files (library mode, remove only): those that
   * still hold their own copy of a removed link are named in
   * `otherDomainCopies`.
   */
  otherDomains?: ReadonlyArray<{ label: string; models: readonly string[]; relationships: readonly Relationship[] }>;
  /** The message for a home model that is not among `endpointModels` (library mode). */
  describeMissingModel?: (name: string) => string;
  /**
   * What taking `model`'s `index`-th relationship (as read) out of its file
   * would lose — its own keys and comments (`yamlEntryExtras`), empty when
   * nothing. A copy that would lose something is refused rather than dropped
   * (library mode). Without it, model-file copies are assumed to hold none.
   */
  libraryEntryExtras?: (model: SemanticModel, index: number) => readonly string[];
  /** How the domain file is named in a refusal (default "this diagram"). */
  domainFileLabel?: string;
  /**
   * The domain file is in the older (v4, inline-model) format, which Repair
   * Relationships… never writes: a refusal points at the migration instead.
   */
  olderFormat?: boolean;
  /**
   * Position of each of `domainRelationships` in the domain file's list as
   * written (entries the reader could not use counted), for "entry N" in a
   * refusal. Without it, the n-th is called entry n.
   */
  domainPositions?: readonly number[];
}

export interface RelationshipCommitPlan {
  /**
   * Endpoint models to save: those whose `relationships` (or, for `markKey`,
   * columns) changed, and the model a record was written to.
   */
  changedModels: SemanticModel[];
  /** The domain file's `logical.relationships` after the commit. */
  domainRelationships: Relationship[];
  /** Whether `domainRelationships` differs from the input. */
  domainChanged: boolean;
  /**
   * The record written (add / update / edit): in `model`'s `relationships` at
   * `index` (library mode), or at `index` of `domainRelationships`. A model
   * file save passes it on so the entry is rewritten in full, a cardinality
   * the reader could not read included.
   */
  written?: { where: 'library'; model: string; index: number } | { where: 'domain'; index: number };
  /** Other domain files (by label) still holding their own copy of a removed link. */
  otherDomainCopies?: string[];
}

/** A commit the canvas must refuse; the message is for the user. */
export class RelationshipCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelationshipCommitError';
  }
}

/**
 * The library models at the ends of a commit, from the endpoint names it
 * names: each name resolved as core's reader resolves it — the exact name,
 * else the alphabetically first model whose name differs only in case — and
 * each model once. Names are never folded together first: two models whose
 * names differ only in case (`Dd`, `DD`, hand-made on a case-sensitive file
 * system or in two folders) are two models, and a commit between them must
 * plan against both.
 */
export function resolveEndpointModels(names: readonly string[], libraryModels: readonly SemanticModel[]): SemanticModel[] {
  const out: SemanticModel[] = [];
  for (const name of new Set(names)) {
    const model = libraryModels.find((m) => m.name === name)
      ?? libraryModels.filter((m) => same(m.name, name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

/** Whether `model`'s `index`-th relationship (as read) has a role the reader showed shortened (REL008 `role-too-long`). */
function roleShownShortened(model: SemanticModel, index: number): boolean {
  const issues = model.relationshipIssues ?? [];
  const raw = relationshipFilePositions(model.relationships?.length ?? 0, issues)[index];
  return issues.some((i) => i.index === raw && i.reason === 'role-too-long');
}

/** One stored record of a link, where a commit found it. */
type Copy =
  | { where: 'library'; model: SemanticModel; index: number; rel: Relationship }
  | { where: 'domain'; index: number; rel: Relationship };

/** The copy a reader draws first (core's `normaliseRelationships` order): library, at home, by holder, by index. */
function rankCopies(a: Copy, b: Copy): number {
  if (a.where !== b.where) return a.where === 'library' ? -1 : 1;
  if (a.where === 'library' && b.where === 'library') {
    const aHome = same(canonicalRelationship(a.rel).fromModel, a.model.name);
    const bHome = same(canonicalRelationship(b.rel).fromModel, b.model.name);
    if (aHome !== bHome) return aHome ? -1 : 1;
    const ma = a.model.name.toLowerCase();
    const mb = b.model.name.toLowerCase();
    if (ma !== mb) return ma < mb ? -1 : 1;
    // Case-only variants (`Dd`, `DD`): the exact name, as the reader ranks them.
    if (a.model.name !== b.model.name) return a.model.name < b.model.name ? -1 : 1;
  }
  return a.index - b.index;
}

/** A stored record as core's readers read it (`readDomainRelationshipEntries`, `parseLogicalModelText`). */
function asRead(rel: Relationship): Relationship {
  const { role: _role, ...rest } = rel;
  const role = normaliseRelationshipRole(rel.role);
  return {
    ...rest,
    cardinality: VALID_CARDINALITIES.has(rel.cardinality) ? rel.cardinality : 'many-to-one',
    ...(role ? { role } : {}),
  };
}

/**
 * Plan one relationship edit (R4). Every copy of the link — in the endpoint
 * models' files (library mode) and in the current domain file — is taken out,
 * then (add / update / edit) ONE canonical record is written at its home: the
 * canonical from-model's file in library mode, the domain file in domain
 * mode. A record already at home keeps its place in the list; anything else
 * is appended. Nothing else is touched. Throws `RelationshipCommitError` for
 * a duplicate (adding or re-keying onto a link stored elsewhere), a link that
 * is not found, or a home model that is missing.
 */
export function planRelationshipCommit(input: RelationshipCommitInput): RelationshipCommitPlan {
  const { mode, op } = input;
  const library = mode === 'library';
  // Distinct models (a self-reference names one model twice).
  const models: SemanticModel[] = [];
  for (const m of input.endpointModels) if (!models.includes(m)) models.push(m);
  // The exact name, else the alphabetically first case variant (core's reader).
  const findModel = (name: string): SemanticModel | undefined =>
    models.find((m) => m.name === name)
    ?? models.filter((m) => same(m.name, name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  const before = new Map(models.map((m) => [m, JSON.stringify({ r: m.relationships ?? [], c: m.columns ?? [] })]));
  let domain = input.domainRelationships.map((rel) => rel);

  const copiesOf = (key: string): Copy[] => {
    const found: Copy[] = [];
    if (library) {
      for (const model of models) {
        (model.relationships ?? []).forEach((entry, index) => {
          const rel = { fromModel: model.name, ...entry };
          if (linkKey(rel) === key) found.push({ where: 'library', model, index, rel });
        });
      }
    }
    domain.forEach((rel, index) => {
      if (linkKey(rel) === key) found.push({ where: 'domain', index, rel });
    });
    return found.sort(rankCopies);
  };

  // --- What is cleared, and what is checked --------------------------------
  const cleared = new Set(
    op.kind === 'remove' ? op.stored.map(linkKey) : [linkKey(op.kind === 'add' ? op.rel : op.stored)],
  );
  const copies = [...cleared].flatMap(copiesOf);
  const domainLabel = input.domainFileLabel ?? 'this diagram';
  const placeOf = (c: Copy): string => c.where === 'library'
    ? `entry ${(relationshipFilePositions(c.model.relationships?.length ?? 0, c.model.relationshipIssues)[c.index] ?? c.index) + 1} of ${c.model.name}'s model file`
    : `entry ${(input.domainPositions?.[c.index] ?? c.index) + 1} of ${domainLabel}`;
  // A change made from the canvas writes ONE record from the copy the canvas
  // draws. When the link is stored more than once and the copies disagree
  // (REL001, an error), writing it would silently drop what the other copies
  // say — a role, a cardinality, a one-to-one's direction the user never saw.
  // That choice is the repair's, where the user picks; a remove takes every
  // copy out by design and is not refused.
  if (op.kind === 'update' || op.kind === 'edit') {
    // Compared as every reader reads them: a domain-file copy is the entry as
    // written, a library copy the parsed record, so a missing or unknown
    // cardinality reads as many-to-one and a role is normalised on both sides
    // — exactly core's REL001 "copies disagree", never a difference of spelling.
    const disagreeing = copies.filter((c) => !sameRelationshipMeaning(asRead(c.rel), asRead(copies[0].rel)));
    if (disagreeing.length > 0) {
      const sites = [copies[0], ...disagreeing].map(placeOf).join(' and ');
      throw new RelationshipCommitError(
        `This relationship is stored more than once and the copies disagree (${sites}), ` +
        'so changing it here would throw away what the other copies say. ' +
        (input.olderFormat
          // Repair Relationships… never writes an older-format diagram.
          ? `This diagram is in the older format: run "ERD Studio: Migrate Domains to Central Model Store", then ` +
            `"Repair Relationships…" to choose which one is right — or remove the extra entry from ${domainLabel} by hand.`
          : 'Run "Repair Relationships…" to choose which one is right, then try again.'),
      );
    }
  }
  let next: Relationship | null = null;
  switch (op.kind) {
    case 'add': {
      if (copies.length > 0) throw new RelationshipCommitError('This relationship already exists.');
      const role = normaliseRelationshipRole(op.rel.role);
      next = { ...ends(op.rel), cardinality: op.rel.cardinality, ...(role ? { role } : {}) };
      break;
    }
    case 'update': {
      const drawn = copies[0];
      if (!drawn) throw new RelationshipCommitError('Relationship not found.');
      // The stored role is kept as written: a long label the canvas shows
      // shortened is never cut on disk by a cardinality change.
      const role = keepStoredRole(drawn.rel.role, normaliseRelationshipRole(drawn.rel.role));
      const base = ends(canonicalRelationship(drawn.rel));
      // The cardinality was chosen against the ends as drawn; when the record
      // now runs the other way (turned round since the canvas was drawn), it
      // is read from the other end, so the result is what the canvas showed.
      const reversed = op.drawn !== undefined && endIs(base, 'from', op.drawn.toModel, op.drawn.toColumn)
        && endIs(base, 'to', op.drawn.fromModel, op.drawn.fromColumn)
        && !(endIs(base, 'from', op.drawn.fromModel, op.drawn.fromColumn) && endIs(base, 'to', op.drawn.toModel, op.drawn.toColumn));
      next = { ...base, cardinality: reversed ? readFromOtherEnd(op.cardinality) : op.cardinality, ...(role ? { role } : {}) };
      break;
    }
    case 'edit': {
      if (copies.length === 0) throw new RelationshipCommitError('Relationship not found.');
      const nextKey = linkKey(op.next);
      if (!cleared.has(nextKey) && copiesOf(nextKey).length > 0) {
        throw new RelationshipCommitError('A relationship with this key already exists.');
      }
      // A role the dialog sends back unchanged (the shortened label it was
      // shown) keeps the stored text; any other role is the one written.
      const role = keepStoredRole(copies[0].rel.role, op.next.role);
      next = { ...ends(op.next), cardinality: op.next.cardinality, ...(role ? { role } : {}) };
      break;
    }
    case 'remove':
      if (copies.length === 0) throw new RelationshipCommitError('Relationship not found.');
      break;
  }

  // --- The canonical record, spelled as the models spell themselves --------
  let record: Relationship | null = null;
  let home: SemanticModel | undefined;
  if (next) {
    record = respell(canonicalRelationship(next), findModel);
    if (library) {
      home = findModel(record.fromModel);
      if (!home) {
        throw new RelationshipCommitError(
          input.describeMissingModel?.(record.fromModel) ?? `Model "${record.fromModel}" not found in logical-models/.`,
        );
      }
      record = { ...record, fromModel: home.name };
    }
  }

  // A key to mark in the same commit, checked against the models as they are
  // now, before anything is changed — the dialog's offer was made against the
  // canvas it drew, which another writer may have overtaken since. Only the
  // end the relationship points at (either end of a one-to-one) may be marked,
  // and only while its model has no primary key: a tick never turns an
  // existing key into a composite one, nor makes the many side's foreign key
  // part of its own model's key.
  const markKey = op.kind === 'add' || op.kind === 'edit' ? op.markKey : undefined;
  let markColumn: NonNullable<SemanticModel['columns']>[number] | undefined;
  if (markKey && record) {
    const atFrom = endIs(record, 'from', markKey.model, markKey.column);
    const atTo = endIs(record, 'to', markKey.model, markKey.column);
    const model = atFrom || atTo ? findModel(markKey.model) : undefined;
    markColumn = model?.columns?.find((c) => c.name === markKey.column) ?? model?.columns?.find((c) => same(c.name, markKey.column));
    if (!model || !markColumn) {
      throw new RelationshipCommitError(`Can't mark ${markKey.model}.${markKey.column} as a key: it is not an end of this relationship.`);
    }
    if (!atTo && record.cardinality !== 'one-to-one') {
      throw new RelationshipCommitError(
        `Can't mark ${model.name}.${markColumn.name} as ${model.name}'s key: it is the many side of this relationship, ` +
        'not the end it points at. Re-open the dialog and try again.',
      );
    }
    const otherKeys = (model.columns ?? []).filter((c) => c !== markColumn && c.isPrimaryKey === true).map((c) => c.name);
    if (otherKeys.length > 0) {
      throw new RelationshipCommitError(
        `Can't mark ${model.name}.${markColumn.name} as ${model.name}'s key: ${model.name} already has a primary key ` +
        `(${otherKeys.join(', ')}). Re-open the dialog and try again.`,
      );
    }
  }

  // Where a record already at home sits: the written one keeps that place.
  const homeIndex = home
    ? copies.filter((c) => c.where === 'library' && c.model === home).map((c) => c.index).sort((a, b) => a - b)[0]
    : copies.filter((c) => c.where === 'domain').map((c) => c.index).sort((a, b) => a - b)[0];

  // A model-file copy whose role is longer than the canvas shows keeps its
  // text only when it is rewritten in place; written anywhere else it would be
  // stored shortened. Refused, by name, before anything changes — unless the
  // user chose a different role.
  if (record && library && record.role !== undefined) {
    for (const c of copies) {
      if (c.where !== 'library' || (c.model === home && c.index === homeIndex)) continue;
      if (!roleShownShortened(c.model, c.index) || normaliseRelationshipRole(c.rel.role) !== record.role) continue;
      throw new RelationshipCommitError(
        `This relationship's role in ${c.model.name}'s model file is longer than ${RELATIONSHIP_ROLE_MAX_LENGTH} characters ` +
        'and would be cut by moving it. Shorten it there first, then try again.',
      );
    }
  }

  // --- Nothing the user wrote on a copy is lost without a word --------------
  // The copy rewritten in place keeps its comments and its own keys (a model
  // file entry through `syncRelationships`, a domain file entry below). Any
  // other copy is taken out of its file; one carrying something a
  // relationship does not have is refused, as the repair refuses it.
  const domainKeptIndex = record && !home ? homeIndex : undefined;
  for (const c of copies) {
    const keptInPlace = c.where === 'library'
      ? record !== null && c.model === home && c.index === homeIndex
      : record !== null && !home && c.index === domainKeptIndex;
    if (keptInPlace || op.kind === 'remove') continue;
    const lost = c.where === 'library' ? input.libraryEntryExtras?.(c.model, c.index) ?? [] : domainObjectExtras(c.rel);
    if (lost.length === 0) continue;
    throw new RelationshipCommitError(
      `${placeOf(c)[0].toUpperCase()}${placeOf(c).slice(1)} has ${describeExtras(lost)}, which changing this relationship here would remove. ` +
      'Move that text out of the entry or make the change by hand, then try again.',
    );
  }

  // --- Take every copy out ---------------------------------------------------
  const keptDomainEntry = domainKeptIndex !== undefined ? domain[domainKeptIndex] : undefined;
  if (library) dropWhere(models, (rel) => cleared.has(linkKey(rel)));
  domain = domain.filter((rel) => !cleared.has(linkKey(rel)));

  // --- Write the one record at its home --------------------------------------
  let written: RelationshipCommitPlan['written'];
  if (record) {
    if (home) {
      const list = [...(home.relationships ?? [])];
      const index = homeIndex ?? list.length;
      list.splice(index, 0, libraryEntry(record));
      home.relationships = list;
      written = { where: 'library', model: home.name, index };
    } else {
      const index = homeIndex ?? domain.length;
      domain.splice(index, 0, domainEntryOver(keptDomainEntry, record));
      written = { where: 'domain', index };
    }
  }

  if (markColumn) markColumn.isPrimaryKey = true;

  // --- Other domains still drawing a removed link from their own copy --------
  let otherDomainCopies: string[] | undefined;
  if (op.kind === 'remove' && library && input.otherDomains) {
    const labels = input.otherDomains
      .filter((d) => {
        const names = new Set(d.models.map((m) => m.toLowerCase()));
        return d.relationships.some((rel) => cleared.has(linkKey(rel))
          && names.has(rel.fromModel.toLowerCase()) && names.has(rel.toModel.toLowerCase()));
      })
      .map((d) => d.label);
    if (labels.length > 0) otherDomainCopies = [...new Set(labels)].sort();
  }

  const domainChanged = JSON.stringify(domain) !== JSON.stringify(input.domainRelationships);
  // The home model is always saved when a record was written there, even when
  // the parsed list looks the same: the entry on disk may hold what the reader
  // defaulted (`one_to_many` read as many-to-one), and the save rewrites it.
  const changedModels = models.filter((m) => m === home
    || before.get(m) !== JSON.stringify({ r: m.relationships ?? [], c: m.columns ?? [] }));
  return {
    changedModels,
    domainRelationships: domain,
    domainChanged,
    ...(written ? { written } : {}),
    ...(otherDomainCopies ? { otherDomainCopies } : {}),
  };
}

/**
 * Lay a commit's new list of well-formed domain-file relationships back over
 * the list as written, so every entry the reader could not use (`raw` items
 * that are not in `wellFormed`) keeps its exact slot — and with it the
 * "entry N" a finding named — instead of being moved to the end.
 *
 * `next` is `planRelationshipCommit`'s `domainRelationships` for
 * `wellFormed`: the entries it kept are the same objects, in order; anything
 * else in it is the record it wrote. A written record takes the slot of the
 * copy it replaced (the first well-formed entry, kept or removed, after the
 * entries before it), or is appended when it goes at the end.
 */
export function mergeDomainRelationships(
  raw: readonly unknown[],
  wellFormed: readonly unknown[],
  next: readonly unknown[],
): unknown[] {
  const original = new Set(wellFormed);
  const out: unknown[] = [];
  let j = 0;
  const flushWritten = (): void => {
    while (j < next.length && !original.has(next[j])) out.push(next[j++]);
  };
  for (const item of raw) {
    if (!original.has(item)) {
      out.push(item); // not one the plan saw: left exactly where it was
      continue;
    }
    flushWritten();
    if (j < next.length && next[j] === item) {
      out.push(item);
      j++;
    }
    // else: a copy the commit took out
  }
  flushWritten();
  // Never drop anything the plan returned (it keeps order, so this is empty).
  while (j < next.length) out.push(next[j++]);
  return out;
}

/** Just the four ends of a relationship (no cardinality, role or runtime fields). */
function ends(rel: RelationshipEnds): RelationshipEnds {
  return { fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn };
}

/**
 * `rel` with each end spelled as its model spells itself: the model's real
 * name when one of `findModel`'s models matches without case, and the real
 * column name when that model has the column (REL005 is never written).
 */
function respell(rel: Relationship, findModel: (name: string) => SemanticModel | undefined): Relationship {
  const fix = (modelName: string, column: string): [string, string] => {
    const model = findModel(modelName);
    if (!model) return [modelName, column];
    const real = model.columns?.find((c) => c.name === column) ?? model.columns?.find((c) => same(c.name, column));
    return [model.name, real?.name ?? column];
  };
  const [fromModel, fromColumn] = fix(rel.fromModel, rel.fromColumn);
  const [toModel, toColumn] = fix(rel.toModel, rel.toColumn);
  return { ...rel, fromModel, fromColumn, toModel, toColumn };
}

// ---------------------------------------------------------------------------
// Findings a canvas shows, and when to offer a repair (issue #133)
// ---------------------------------------------------------------------------

/** Codes that make the canvas offer "Repair Relationships…" (banner and notification). */
export const REPAIR_OFFER_CODES: readonly RelationshipIssueCode[] = ['REL001', 'REL002', 'REL003', 'REL004', 'REL008'];

/** The findings worth offering a repair for: REL001 / REL002 / REL003 / REL004 / REL008. */
export function findingsNeedingRepair(findings: readonly RelationshipFinding[]): RelationshipFinding[] {
  return findings.filter((f) => REPAIR_OFFER_CODES.includes(f.code));
}

/**
 * The project findings (`checkRelationships`) that concern one domain: those
 * naming its file, those about a link whose two models it holds, and those
 * about a model file it shows that could not be read in full (REL008) or that
 * points at a missing model or column (REL003 / REL004). `domain.modelFiles`
 * are the domain's models' file names as the findings spell them. A v4
 * domain (`olderFormat`) gets only the findings naming its own file.
 */
export function findingsForDomain(
  findings: readonly RelationshipFinding[],
  domain: { filePath: string; models: readonly string[]; modelFiles: readonly string[]; olderFormat?: boolean },
): RelationshipFinding[] {
  // A v4 (inline-model) diagram draws only its own records, never the model
  // library's (core's `parseStageData` strips them), so only findings about
  // its own file concern it — the canvas banner and `diff` alike.
  if (domain.olderFormat) return findings.filter((f) => f.files.includes(domain.filePath));
  const models = new Set(domain.models.map((m) => m.toLowerCase()));
  const modelFiles = new Set(domain.modelFiles);
  const holds = (name: string): boolean => models.has(name.toLowerCase());
  return findings.filter((f) => {
    if (f.files.includes(domain.filePath)) return true;
    const records = f.records ?? [];
    if (records.length === 0) return f.files.some((file) => modelFiles.has(file));
    return records.some((r) => {
      if (r.source.kind !== 'library') return false;
      if (f.code === 'REL003' || f.code === 'REL004') return holds(r.source.model);
      return holds(r.stored.fromModel) && holds(r.stored.toModel);
    });
  });
}

/** Findings as the canvas payload carries them (`DisplayDomain.relationshipIssues`), without repeats. */
export function toDisplayRelationshipIssues(findings: readonly RelationshipFinding[]): DisplayRelationshipIssue[] {
  const seen = new Set<string>();
  const issues: DisplayRelationshipIssue[] = [];
  for (const f of findings) {
    const id = `${f.code}\u0000${f.message}`;
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push({ code: f.code, severity: f.severity, message: f.message, ...(f.link ? { link: f.link } : {}) });
  }
  return issues;
}

/**
 * The notification offering "Repair Relationships…": how many relationships
 * need attention and, briefly, why. Null when nothing does.
 */
export function describeRepairOffer(findings: readonly RelationshipFinding[]): string | null {
  const needing = findingsNeedingRepair(findings);
  if (needing.length === 0) return null;
  const reasons: Array<[RelationshipIssueCode, string]> = [
    ['REL001', 'stored more than once'],
    ['REL002', 'saved in the file of the model it points at'],
    ['REL003', 'pointing at a model that is missing (from the model library, or from the diagram that stores it)'],
    ['REL004', 'pointing at a column its model does not have'],
    ['REL008', 'could not be read'],
  ];
  // Relationships, not findings — as the canvas banner counts them: one
  // relationship missing a column on each end is one relationship.
  const parts = reasons
    .map(([code, words]) => [countAffectedRelationships(needing.filter((f) => f.code === code)), words] as const)
    .filter(([n]) => n > 0)
    .map(([n, words]) => `${n} ${words}`);
  const n = countAffectedRelationships(needing);
  return `${n === 1 ? '1 relationship needs' : `${n} relationships need`} attention (${parts.join('; ')}). ` +
    'Review the fixes with Repair Relationships…? Nothing changes until you confirm.';
}

/**
 * How many relationships kept in domain files are worth sharing: those whose
 * two models sit together in more than one domain, each of which needs its own
 * copy today (whether it has drawn one or not). What the "move to the model
 * library" offer counts, and the reason it is made at all.
 */
export function sharedRelationshipCount(
  domains: ReadonlyArray<{ models: readonly string[]; relationships: readonly Relationship[] }>,
): number {
  return sharedRelationshipKeys(domains).size;
}

/** The links (`linkKey`) {@link sharedRelationshipCount} counts. */
export function sharedRelationshipKeys(
  domains: ReadonlyArray<{ models: readonly string[]; relationships: readonly Relationship[] }>,
): Set<string> {
  const lowerModels = domains.map((d) => new Set(d.models.map((m) => m.toLowerCase())));
  const keys = new Set<string>();
  for (const domain of domains) {
    for (const rel of domain.relationships) {
      const holders = lowerModels.filter((models) =>
        models.has(rel.fromModel.toLowerCase()) && models.has(rel.toModel.toLowerCase())).length;
      if (holders > 1) keys.add(linkKey(rel));
    }
  }
  return keys;
}
