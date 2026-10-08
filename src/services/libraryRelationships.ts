/**
 * Relationships stored once in the model library (issue #126).
 *
 * A relationship lives in its from-model's `logical-models/*.yml` under
 * `relationships:`, and every domain that holds both ends draws it (the read
 * side is `mergeLibraryRelationships` in `@erd-studio/core`). These helpers are
 * the write side: each takes library models, edits their `relationships` in
 * place and returns the models it changed, which the editor saves through the
 * same WorkspaceEdit as the domain file.
 *
 * Pure: no `vscode`, no file access.
 */

import {
  canonicalRelationship, compositeGroupProblem, contradictsKeys, contradictsKeysOf, keyedRelationship, linkKey,
  mergeLibraryRelationships, normaliseRelationshipRole, relationshipKey, respellRelationship, reverseRelationship, sameLink,
} from '@erd-studio/core';
import type { ColumnPair, DbtKeyIndex, KeyedModel } from '@erd-studio/core';
import type { ModelRelationship, Relationship, SemanticModel } from '../types/semantic';

type RelationshipEnds = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Whether new relationships go to the model library. Like layer folders this
 * is opt-in per project, decided by what is on disk: true once any model file
 * carries a relationship (someone ran "Move Relationships to Model Library",
 * or wrote one by hand), and for a project whose domain files hold none, which
 * has no per-domain convention to keep. A project that keeps relationships in
 * its domain files carries on doing so — a teammate on a version before this
 * one would not see an edge stored in the library.
 */
export function usesLibraryRelationships(
  models: readonly SemanticModel[],
  domainFileRelationshipCount: number,
  /** A model file that does not parse still lists some (`hasUnreadableRelationships`). */
  unreadableModelRelationships = false,
): boolean {
  return domainFileRelationshipCount === 0 || unreadableModelRelationships
    || models.some((m) => (m.relationships?.length ?? 0) > 0);
}

/** The full relationships stored in `model`'s library file. */
export function libraryRelationshipsOf(model: SemanticModel): Relationship[] {
  return (model.relationships ?? []).map((rel) => ({ fromModel: model.name, ...rel }));
}

/**
 * The library entry for `rel`, without `fromModel`: the four stored fields,
 * plus `role` and `compositeKey` when it has them.
 */
function libraryEntry(rel: Relationship): ModelRelationship {
  return {
    fromColumn: rel.fromColumn,
    toModel: rel.toModel,
    toColumn: rel.toColumn,
    cardinality: rel.cardinality,
    ...(rel.role ? { role: rel.role } : {}),
    ...(rel.compositeKey ? { compositeKey: rel.compositeKey } : {}),
  };
}

/**
 * Add or replace a relationship on its from-model (`model.name` must be
 * `rel.fromModel`, already in its stored direction — see
 * `canonicalRelationship`). Returns false when an identical one is already
 * there.
 */
export function upsertLibraryRelationship(model: SemanticModel, rel: Relationship): boolean {
  const key = relationshipKey(rel);
  const list = model.relationships ?? [];
  const index = list.findIndex((r) => relationshipKey({ fromModel: model.name, ...r }) === key);
  const entry = libraryEntry(rel);
  if (index === -1) {
    model.relationships = [...list, entry];
    return true;
  }
  const current = list[index];
  if (current.cardinality === entry.cardinality && current.fromColumn === entry.fromColumn
    && current.toModel === entry.toModel && current.toColumn === entry.toColumn
    && current.role === entry.role && current.compositeKey === entry.compositeKey) {
    return false;
  }
  list[index] = entry;
  model.relationships = list;
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

/**
 * Remove every library copy of these links, either way round (#133): the
 * many side's entry and any reverse copy an older version left on the other
 * end, so a deleted line does not come back.
 */
export function removeLibraryRelationships(
  models: readonly SemanticModel[],
  ends: readonly RelationshipEnds[],
): SemanticModel[] {
  const keys = new Set(ends.map(linkKey));
  return dropWhere(models, (rel) => keys.has(linkKey(rel)));
}

const touchesColumn = (rel: Relationship, modelName: string, column: string): boolean =>
  (same(rel.fromModel, modelName) && same(rel.fromColumn, column))
  || (same(rel.toModel, modelName) && same(rel.toColumn, column));

/**
 * Remove every library relationship that starts or ends at `model.column` —
 * and, for one that is part of a composite foreign key, the whole composite
 * (#133 L2): a composite key missing a column is a different statement, never
 * kept as a narrower link.
 */
export function removeColumnRelationships(
  models: readonly SemanticModel[],
  modelName: string,
  column: string,
  /** The whole library, which a composite is read from when `models` is part of it. */
  library: readonly SemanticModel[] = models,
): SemanticModel[] {
  const keys = columnRemovalKeys(library, [], modelName, column);
  return dropWhere(models, (rel) => keys.has(linkKey(rel)));
}

/** The links to drop when `model.column` goes: those touching it, and every member of a composite (as drawn) one of them is in. */
function columnRemovalKeys(models: readonly SemanticModel[], domainRels: readonly Relationship[], modelName: string, column: string): Set<string> {
  const own = domainRels.filter(isEnds);
  const keys = new Set([...models.flatMap(libraryRelationshipsOf), ...own].filter((r) => touchesColumn(r, modelName, column)).map(linkKey));
  const lines = mergeLibraryRelationships(models, own);
  for (const line of lines.filter((r) => touchesColumn(r, modelName, column))) {
    for (const member of drawnGroupOf(lines, line) ?? []) keys.add(linkKey(member));
  }
  return keys;
}

/**
 * A domain file's own `logical.relationships` without those that start or
 * end at `model.column`, a composite taking all its members with it (#133
 * L2) — whether the composite is the file's own or the model library's
 * (`library`: its models), as drawn, so no copy of a member outlives the
 * key. Entries that are not relationships are kept.
 */
export function removeColumnFromDomainRelationships<T>(
  relationships: readonly T[],
  modelName: string,
  column: string,
  library: readonly SemanticModel[] = [],
): T[] {
  const keys = columnRemovalKeys(library, relationships as unknown as Relationship[], modelName, column);
  return relationships.filter((r) => !isEnds(r) || !keys.has(linkKey(r)));
}

/**
 * The valid composite foreign key `ends` is a member of in `list` (one model
 * file's entries, the whole library's, or one domain section's), or
 * undefined (#133 L2). Members share a `compositeKey` (without case) and
 * their canonical from-model; `compositeGroupProblem` decides validity.
 */
export function groupOf(list: readonly Relationship[], ends: RelationshipEnds): Relationship[] | undefined {
  const entries = list.filter(isEnds);
  // The entry itself when it is one of them (a file may hold two groups of one name), else its link's first keyed copy.
  const found = entries.find((r) => r === ends && r.compositeKey) ?? entries.find((r) => r.compositeKey && sameLink(r, ends));
  if (!found) return undefined;
  const owner = canonicalRelationship(found).fromModel;
  // One member per link, as the read path draws it: a link saved twice is one pair.
  const members = entries.filter((r) => !!r.compositeKey && same(r.compositeKey, found.compositeKey!)
    && same(canonicalRelationship(r).fromModel, owner))
    .filter((r, i, all) => all.findIndex((x) => sameLink(x, r)) === i);
  return compositeGroupProblem(members) ? undefined : members;
}

/**
 * The composite `ends` is drawn in among `lines` (what the read path draws:
 * only a valid group keeps its compositeKey there), or undefined (#133 L2).
 * How a write finds the group the user sees, whichever stored copies won.
 */
export function drawnGroupOf(lines: readonly Relationship[], ends: RelationshipEnds): Relationship[] | undefined {
  const line = lines.find((r) => sameLink(r, ends));
  if (!line?.compositeKey) return undefined;
  const members = lines.filter((r) => !!r.compositeKey && same(r.compositeKey, line.compositeKey!)
    && same(r.fromModel, line.fromModel) && same(r.toModel, line.toModel));
  return members.length >= 2 ? members : undefined;
}

/**
 * `ends`, plus every other member of a valid composite any of them belongs
 * to — in the model library or the domain section, as drawn — deduped by link
 * (#133 L2). How one edge of a composite stands for the whole group.
 */
export function expandToGroups(
  models: readonly SemanticModel[],
  domainRels: readonly Relationship[],
  ends: readonly RelationshipEnds[],
): RelationshipEnds[] {
  const lines = mergeLibraryRelationships(models, domainRels.filter(isEnds));
  const out: RelationshipEnds[] = [];
  const seen = new Set<string>();
  const add = (e: RelationshipEnds): void => {
    if (seen.has(linkKey(e))) return;
    seen.add(linkKey(e));
    out.push(pickEnds(e));
  };
  for (const e of ends) {
    add(e);
    for (const member of drawnGroupOf(lines, e) ?? []) add(member);
  }
  return out;
}

/**
 * A new composite's name in a file (#133 L2): `fk_<toModel>`, lowercased,
 * then `_2`, `_3`, … while the file already uses it. Depends only on the
 * file's entries.
 */
export function nextCompositeKey(fileEntries: ReadonlyArray<Pick<ModelRelationship, 'compositeKey'>>, toModel: string): string {
  const used = new Set(fileEntries.map((e) => e.compositeKey?.toLowerCase()).filter((k): k is string => !!k));
  const base = `fk_${toModel}`.toLowerCase();
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/**
 * Follow a column rename: the model's own relationships leaving that column,
 * and every other model's relationships pointing at it — matched without
 * case, written as the user typed the new name (#133 L4).
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

/** Follow a model rename in every other model's relationships that point at it (matched without case). */
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
 * Follow a column rename in a domain file's own `logical.relationships`, in
 * place: every end at `model.oldColumn`, matched without case (#133 L4).
 * Entries that are not relationships are left alone. Returns whether any
 * entry changed.
 */
export function renameColumnInDomainRelationships(
  relationships: ReadonlyArray<Record<string, unknown>>,
  modelName: string,
  oldColumn: string,
  newColumn: string,
): boolean {
  let touched = false;
  for (const rel of relationships) {
    if (!isEnds(rel)) continue;
    if (same(rel.fromModel, modelName) && same(rel.fromColumn, oldColumn)) {
      rel.fromColumn = newColumn;
      touched = true;
    }
    if (same(rel.toModel, modelName) && same(rel.toColumn, oldColumn)) {
      rel.toColumn = newColumn;
      touched = true;
    }
  }
  return touched;
}

/** Follow a model rename in a domain file's own `logical.relationships`, in place, matched without case. */
export function renameModelInDomainRelationships(
  relationships: ReadonlyArray<Record<string, unknown>>,
  oldName: string,
  newName: string,
): boolean {
  let touched = false;
  for (const rel of relationships) {
    if (!isEnds(rel)) continue;
    if (same(rel.fromModel, oldName)) {
      rel.fromModel = newName;
      touched = true;
    }
    if (same(rel.toModel, oldName)) {
      rel.toModel = newName;
      touched = true;
    }
  }
  return touched;
}

/** Columns of one end's model to mark as its primary key with the relationship (#133 L1). */
export interface MarkKey {
  model: string;
  columns: readonly string[];
}

/**
 * One canvas edit of a relationship, as the webview sends it. One edge of a
 * composite foreign key stands for the whole group (#133 L2): `update`,
 * `edit` and `remove` act on every member; `add` and `edit` carry the other
 * column pairs in `extraPairs`.
 */
export type RelationshipWriteOp =
  | { kind: 'add'; drawn: Relationship; markKey?: MarkKey; extraPairs?: readonly ColumnPair[] }
  /** ⇄ or a context-menu cardinality: the drawn line's ends, with the new cardinality. */
  | { kind: 'update'; ends: RelationshipEnds; cardinality: Relationship['cardinality'] }
  | { kind: 'edit'; original: RelationshipEnds; drawn: Relationship; markKey?: MarkKey; extraPairs?: readonly ColumnPair[] }
  | { kind: 'remove'; keys: readonly RelationshipEnds[] };

export interface RelationshipWriteInput {
  /** Where this project keeps relationships: the model library, or the open domain file. */
  home: 'library' | 'domain';
  /** Every library model, never changed in place ([] for a v4 domain). */
  models: readonly SemanticModel[];
  /** The open domain file's `logical.relationships`, as parsed; never changed in place. */
  domainRelationships: readonly Relationship[];
  /** dbt's key evidence (#133 L1): the line drawn, and ⇄'s keys-win refusal, read it as the canvas does. */
  dbt?: DbtKeyIndex;
}

export type RelationshipWritePlan =
  | {
    ok: true;
    /** Copies of the library models whose `relationships` (or, for `markKey`, key flags) changed, to save. */
    changed: SemanticModel[];
    /** The domain file's new `logical.relationships`, or null when it is unchanged. */
    domainRelationships: Relationship[] | null;
    /** A v4 domain's `markKey`: no library model holds it, so the caller marks the inline model. */
    inlineMarkKey?: MarkKey;
    /** Single links an add or edit took into a composite key (#133 L2), for the success message. */
    grouped?: { count: number; compositeKey: string };
  }
  | {
    ok: false;
    error: string;
    /** Set when the home model has no readable file. */
    missingModel?: string;
    /** `keysWin`: ⇄ would make a whole key the "many" side (#133 F3b). For usage telemetry only. */
    reason?: 'keysWin';
  };

const refuse = (error: string, missingModel?: string, reason?: 'keysWin'): RelationshipWritePlan =>
  ({ ok: false, error, ...(missingModel ? { missingModel } : {}), ...(reason ? { reason } : {}) });

/**
 * What one canvas relationship edit writes (#133) — the only place the
 * provider's add / ⇄ / edit / delete decide it, so the exhaustive checker
 * runs this same function. Pure: returns copies, changes nothing it is given.
 *
 * An edit acts on the link, not on one stored entry: every copy of it, in
 * either model file and in the domain file, is folded into exactly one entry
 * in its home (the many side's model file in a library project, the domain
 * file otherwise), carrying the cardinality asked for and the role — the one
 * on the line drawn, else the one any copy has. ⇄ and a context-menu
 * cardinality carry no role, so a copy with a different role refuses them
 * rather than lose it; only an edit (whose dialog sets the role) drops one.
 * ⇄ is also refused when it would make a model's whole key the "many" side
 * against the other end's key (`contradictsKeys`). Removing drops every copy.
 */
export function planRelationshipWrite(op: RelationshipWriteOp, input: RelationshipWriteInput): RelationshipWritePlan {
  const plan = planLinkWrite(op, input);
  if (!plan.ok || op.kind === 'remove' || op.kind === 'update' || !op.markKey) return plan;
  // "Mark … as primary key" (#133 L1): the key flags travel in the same edit.
  if (input.models.length === 0) return { ...plan, inlineMarkKey: op.markKey };
  const target = input.models.find((m) => same(m.name, op.markKey!.model));
  if (!target) return refuse(`Model "${op.markKey.model}" not found in logical-models/.`, op.markKey.model);
  const marked = markPrimaryKey(plan.changed.find((m) => same(m.name, target.name)) ?? copyModel(target), op.markKey.columns);
  if (typeof marked === 'string') return refuse(marked.replace('{was}', op.kind === 'add' ? 'added' : 'changed'));
  return { ...plan, changed: [...plan.changed.filter((m) => !same(m.name, target.name)), marked] };
}

/**
 * `model` with `columns` (matched without case) flagged `isPrimaryKey`, or
 * the refusal when the model already flags a key (`{was}` names what did not
 * happen) or lacks one of the columns. Never changes `model` itself.
 */
export function markPrimaryKey<T extends Pick<SemanticModel, 'name' | 'columns'>>(model: T, columns: readonly string[]): T | string {
  const cols = model.columns ?? [];
  if (cols.some((c) => c.isPrimaryKey || c.isNaturalKey)) {
    return `${model.name} already has a key marked — the relationship was not {was}. Set its keys in the model first.`;
  }
  const missing = columns.find((name) => !cols.some((c) => typeof c.name === 'string' && same(c.name, name)));
  if (missing !== undefined) return `Column "${missing}" not found in ${model.name}.`;
  return {
    ...model,
    columns: cols.map((c) => (columns.some((name) => typeof c.name === 'string' && same(c.name, name)) ? { ...c, isPrimaryKey: true } : c)),
  };
}

function planLinkWrite(op: RelationshipWriteOp, input: RelationshipWriteInput): RelationshipWritePlan {
  const { home, models, domainRelationships, dbt } = input;
  const modelOf = (name: string): SemanticModel | undefined => models.find((m) => same(m.name, name));
  const drawnLines = (): Relationship[] => mergeLibraryRelationships(home === 'library' ? models : [], domainRelationships, '', undefined, dbt);
  const library = models.flatMap(libraryRelationshipsOf);
  const libraryCopies = (key: string): Relationship[] => library.filter((r) => linkKey(r) === key);
  const domainCopies = (key: string): Relationship[] => domainRelationships.filter((r) => isEnds(r) && linkKey(r) === key);
  const stored = (key: string): boolean => libraryCopies(key).length > 0 || domainCopies(key).length > 0;
  /** The composite `ends` is drawn in, as the canvas shows it. */
  let lines: Relationship[] | undefined;
  const storedGroup = (ends: RelationshipEnds): Relationship[] | undefined => drawnGroupOf(lines ??= drawnLines(), ends);

  if (op.kind === 'remove') {
    // One edge of a composite deletes the whole group.
    const all = expandToGroups(models, domainRelationships, op.keys);
    const keys = new Set(all.map(linkKey));
    const changed = models.map(copyModel).filter((m) => removeLibraryRelationships([m], all).length > 0);
    const kept = domainRelationships.filter((r) => !isEnds(r) || !keys.has(linkKey(r)));
    if (changed.length === 0 && kept.length === domainRelationships.length) return refuse('Relationship not found.');
    return { ok: true, changed, domainRelationships: kept.length === domainRelationships.length ? null : kept };
  }

  const original = op.kind === 'add' ? null : op.kind === 'update' ? op.ends : op.original;
  const oldKey = original ? linkKey(original) : null;
  if (oldKey && !stored(oldKey)) return refuse('Relationship not found.');
  const oldGroup = original ? storedGroup(original) : undefined;
  const oldKeys = new Set(oldGroup ? oldGroup.map(linkKey) : oldKey ? [oldKey] : []);
  const line = oldKey ? drawnLines().find((r) => linkKey(r) === oldKey) : undefined;

  // The new link, as drawn: one entry per column pair.
  let role: string | undefined;
  let members: Relationship[];
  if (op.kind === 'update') {
    const roles = [...new Set([...oldKeys].flatMap((key) => [...libraryCopies(key), ...domainCopies(key)])
      .map((r) => normaliseRelationshipRole(r.role)).filter((r): r is string => !!r))];
    const drawnRole = normaliseRelationshipRole(line?.role);
    if (roles.some((r) => r !== (drawnRole ?? roles[0]))) {
      return refuse(`This link is saved more than once with different roles (${roles.map((r) => `"${r}"`).join(', ')}). ` +
        'Edit the relationship to choose one, then try again.');
    }
    role = drawnRole ?? roles[0];
    // A composite's members are read the way its drawn member is.
    const anchor = oldGroup?.find((m) => linkKey(m) === oldKey);
    const sameWay = !anchor || relationshipKey(anchor) === relationshipKey(op.ends);
    members = (oldGroup ?? [op.ends]).map((m) => ({
      ...pickEnds(m === anchor ? op.ends : sameWay ? m : reverseEnds(m)), cardinality: op.cardinality,
    }));
    members.sort((a, b) => (linkKey(a) === oldKey ? -1 : linkKey(b) === oldKey ? 1 : 0));
  } else {
    role = normaliseRelationshipRole(op.drawn.role);
    const { fromModel, toModel, cardinality } = op.drawn;
    members = [
      { ...pickEnds(op.drawn), cardinality },
      ...(op.extraPairs ?? []).map((p) => ({ fromModel, fromColumn: p.fromColumn, toModel, toColumn: p.toColumn, cardinality })),
    ];
  }
  const composite = members.length > 1;
  if (composite) {
    if (canonicalRelationship(members[0]).cardinality === 'many-to-many') return refuse('A composite key can\'t be many-to-many.');
    const problem = compositeGroupProblem(members);
    if (problem) return refuse(`These column pairs don't make one composite key: ${problem}.`);
  }

  // A pair stored already: refused for a single link; for a composite,
  // taken in when it is a single link (#133 L2 — how a group a 1.6.7 save
  // split is put back together), refused when another composite owns it.
  const absorbed: Relationship[] = [];
  for (const m of members) {
    const key = linkKey(m);
    if (oldKeys.has(key) || !stored(key)) continue;
    if (!composite) return refuse(op.kind === 'add' ? 'This relationship already exists.' : 'A relationship with this key already exists.');
    const owner = storedGroup(m);
    if (owner) {
      return refuse(`${m.fromModel}.${m.fromColumn} ↔ ${m.toModel}.${m.toColumn} is already part of composite key ${owner[0].compositeKey}.`);
    }
    absorbed.push(...libraryCopies(key), ...domainCopies(key));
  }
  if (!role && op.kind === 'add') {
    role = absorbed.map((r) => normaliseRelationshipRole(r.role)).find((r): r is string => !!r);
  }

  // Keys win (#133): ⇄ may not make a unique column — or column set — the "many" side.
  const asMany = members.map(canonicalRelationship);
  const lineAsMany = line && canonicalRelationship(line);
  if (op.kind === 'update' && contradictsKeysOf(asMany, modelOf, dbt)
    && !(lineAsMany?.cardinality === 'many-to-one' && relationshipKey(lineAsMany) === relationshipKey(asMany[0]))) {
    const model = modelOf(asMany[0].fromModel)?.name ?? asMany[0].fromModel;
    const cols = asMany.map((m) => m.fromColumn);
    const what = cols.length === 1 ? `${model}.${cols[0]} is ${model}'s key` : `(${cols.join(', ')}) is ${model}'s key`;
    return refuse(`${what}, so each value appears only once — it can't be the "many" side. Unmark it as a key first, then try again.`, undefined, 'keysWin');
  }

  const replaceKeys = new Set([...oldKeys, ...members.map(linkKey)]);
  const next = members.map((m) => ({ ...(home === 'library' ? canonicalRelationship(m) : m), ...(role ? { role } : {}) }) as Relationship);
  const target = home === 'library' ? modelOf(next[0].fromModel) : undefined;
  if (home === 'library' && !target) return refuse(`Model "${next[0].fromModel}" not found in logical-models/.`, next[0].fromModel);
  if (composite) {
    // The group keeps its name unless its destination already uses it for other entries.
    const remaining = home === 'library'
      ? libraryRelationshipsOf(target!).filter((r) => !replaceKeys.has(linkKey(r)))
      : domainRelationships.filter((r) => isEnds(r) && !replaceKeys.has(linkKey(r)));
    let compositeKey = oldGroup?.[0].compositeKey;
    if (!compositeKey || remaining.some((r) => r.compositeKey && same(r.compositeKey, compositeKey!))) {
      compositeKey = nextCompositeKey(remaining, next[0].toModel);
    }
    for (const n of next) n.compositeKey = compositeKey;
  }
  const grouped = composite && absorbed.length > 0
    ? { grouped: { count: new Set(absorbed.map(linkKey)).size, compositeKey: next[0].compositeKey! } } : {};

  if (home === 'domain') {
    // Each entry keeps its old entry's place (the first one's for the group) and any other keys it had.
    const baseOf = (n: Relationship): Relationship | undefined =>
      domainRelationships.find((r) => isEnds(r) && line && linkKey(n) === linkKey(line) && relationshipKey(r) === relationshipKey(line))
      ?? domainRelationships.find((r) => isEnds(r) && linkKey(r) === linkKey(n))
      ?? (linkKey(n) === linkKey(members[0]) && oldKey ? domainRelationships.find((r) => isEnds(r) && linkKey(r) === oldKey) : undefined);
    const entries = next.map((n) => {
      const { role: _role, compositeKey: _key, ...rest } = (baseOf(n) ?? {}) as Relationship;
      return { ...rest, ...n } as Relationship;
    });
    const anchor = baseOf(next[0]) ?? domainRelationships.find((r) => isEnds(r) && replaceKeys.has(linkKey(r)));
    const list: Relationship[] = [];
    for (const r of domainRelationships) {
      if (!isEnds(r) || !replaceKeys.has(linkKey(r))) list.push(r);
      else if (r === anchor) list.push(...entries);
    }
    if (!anchor) list.push(...entries);
    // A library copy (a project switching homes) is folded in too.
    const changed = models.map(copyModel).filter((m) => dropWhere([m], (r) => replaceKeys.has(linkKey(r))).length > 0);
    return { ok: true, changed, domainRelationships: list, ...grouped };
  }

  const changed: SemanticModel[] = [];
  for (const model of models) {
    const list = model.relationships ?? [];
    const isTarget = model === target;
    const out: ModelRelationship[] = [];
    let placed = false;
    for (const entry of list) {
      if (!replaceKeys.has(linkKey({ fromModel: model.name, ...entry }))) {
        out.push(entry);
      } else if (isTarget && !placed) {
        out.push(...next.map((n) => libraryEntry({ ...n, fromModel: model.name })));
        placed = true;
      }
    }
    if (isTarget && !placed) out.push(...next.map((n) => libraryEntry({ ...n, fromModel: model.name })));
    if (JSON.stringify(out) === JSON.stringify(list)) continue;
    const copy = copyModel(model);
    if (out.length > 0) copy.relationships = out;
    else delete copy.relationships;
    changed.push(copy);
  }
  const kept = domainRelationships.filter((r) => !isEnds(r) || !replaceKeys.has(linkKey(r)));
  return { ok: true, changed, domainRelationships: kept.length === domainRelationships.length ? null : kept, ...grouped };
}

/** `rel`'s ends read from the other end. */
const reverseEnds = (rel: RelationshipEnds): RelationshipEnds =>
  ({ fromModel: rel.toModel, fromColumn: rel.toColumn, toModel: rel.fromModel, toColumn: rel.fromColumn });

const isEnds = (r: unknown): r is Relationship => !!r && typeof r === 'object'
  && ['fromModel', 'fromColumn', 'toModel', 'toColumn'].every((k) => typeof (r as Record<string, unknown>)[k] === 'string');

const pickEnds = (r: RelationshipEnds): RelationshipEnds =>
  ({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn });

const copyModel = (m: SemanticModel): SemanticModel =>
  ({ ...m, ...(m.relationships ? { relationships: m.relationships.map((r) => ({ ...r })) } : {}) });

type DiagramRelationships = { label: string; models: readonly string[]; relationships: readonly Relationship[] };

/** The copies diagram files keep of their own that they draw: both models are on that canvas. */
export function drawnDiagramCopies(domains: ReadonlyArray<DiagramRelationships>): Array<Relationship & { diagram: string }> {
  return domains.flatMap((d) => {
    const models = new Set(d.models.map((m) => m.toLowerCase()));
    return d.relationships
      .filter((r) => isEnds(r) && models.has(r.fromModel.toLowerCase()) && models.has(r.toModel.toLowerCase()))
      .map((r) => ({ ...r, diagram: d.label }));
  });
}

/**
 * The diagrams that still draw one of `keys` from a copy of their own after
 * a delete took it out of the model library (#133). Named to the user, never
 * edited: what a diagram keeps is its own.
 */
export function diagramsStillDrawing(keys: readonly RelationshipEnds[], domains: ReadonlyArray<DiagramRelationships>): string[] {
  const wanted = new Set(keys.map(linkKey));
  return [...new Set(drawnDiagramCopies(domains).filter((r) => wanted.has(linkKey(r))).map((r) => r.diagram))];
}

/**
 * Send relationships a canvas or Draw from dbt would add to a domain file to
 * their from-models instead. `newModels` are models about to be created (they
 * take their relationships directly); any other from-model is looked up with
 * `libraryModel`, which must return a copy the caller may change. A
 * relationship whose from-model has neither stays in `kept`, for the domain
 * file. `changed` lists every model to save, new ones included only when they
 * gained a relationship. A link the library already stores, in either file
 * and either way round, is never overwritten: its cardinality and role are
 * the user's, so dbt only adds the links the library lacks. A link another
 * diagram keeps a copy of (`diagramCopies`) stays in this domain's file, so
 * a new library entry never redraws that diagram.
 */
export function routeToLibrary(
  relationships: readonly Relationship[],
  newModels: readonly SemanticModel[],
  libraryModel: (name: string) => SemanticModel | null,
  /** Copies other diagram files keep of their own: a link one holds stays in `kept`, so it takes nothing over. */
  diagramCopies: readonly Relationship[] = [],
): { kept: Relationship[]; changed: SemanticModel[] } {
  const heldByDiagrams = new Set(diagramCopies.map(linkKey));
  const kept: Relationship[] = [];
  const changed = new Map<string, SemanticModel>();
  // One object per model whatever the spelling, so two ends spelled
  // differently never edit two copies of one file (#133 L4).
  const loaded = new Map<string, SemanticModel | null>();
  const modelFor = (name: string): SemanticModel | null => {
    const fresh = newModels.find((m) => same(m.name, name));
    if (fresh) return fresh;
    if (!loaded.has(name.toLowerCase())) loaded.set(name.toLowerCase(), libraryModel(name));
    return loaded.get(name.toLowerCase()) ?? null;
  };
  for (const drawn of relationships) {
    const rel = canonicalRelationship(drawn);
    const model = modelFor(rel.fromModel);
    if (!model || heldByDiagrams.has(linkKey(rel))) {
      kept.push(drawn);
      continue;
    }
    const other = modelFor(rel.toModel);
    if ([model, other].some((m) => m && libraryRelationshipsOf(m).some((r) => sameLink(r, rel)))) continue;
    if (upsertLibraryRelationship(model, rel)) changed.set(model.name, model);
  }
  return { kept, changed: [...changed.values()] };
}

/** One way a relationship is defined in some diagrams, as the move would store it. */
export interface ConflictDefinition {
  /** On its many side (keys win), with its role. For a composite key, its first member. */
  relationship: Relationship;
  /** A composite key's members, each as `relationship` is (#133 L2). */
  members?: Relationship[];
  /** Its cardinality read from the conflict's `relationship.fromModel`. */
  cardinality: Relationship['cardinality'];
  /** The diagrams that draw it this way. */
  domains: string[];
}

/** One relationship that domain files define in more than one way. */
export interface RelationshipConflict {
  /** Its ends, with the role when every diagram that labels it agrees. */
  relationship: RelationshipEnds & { role?: string };
  /**
   * Each distinct definition — cardinality, role, and which end holds the
   * foreign key where that matters — with the diagrams that use it.
   */
  definitions: ConflictDefinition[];
  /** Diagrams holding a composite's column pairs as single links: settled with it (#133 L2). */
  alsoIn?: string[];
}

/** What moving domain-file relationships into the library would do. */
export interface MoveToLibraryPlan {
  /** Relationships to add to their from-model, one per set of ends. */
  toLibrary: Relationship[];
  /**
   * Per domain file, the entries to take out of `logical.relationships`
   * (by `linkKey`) — every copy of a relationship that moves.
   */
  removeFromDomains: Map<string, Set<string>>;
  /** Defined in different ways: the user picks one (`resolveConflict`) or leaves them in place. */
  conflicts: RelationshipConflict[];
  /** From-model has no library file (or cannot be read): left in the domain file. */
  skippedNoModel: Relationship[];
  /**
   * Library entries stored on their "one" side (a `one-to-many`, or a
   * backwards `many-to-one` — see `planRehome`): each moves to the model on
   * its many side as `many-to-one` — `stored` is taken out of `from`'s file
   * and `to` added, unless that file already holds the link.
   */
  rehome: RelationshipRehome[];
  /**
   * Links stored in both model files whose copies disagree (cardinality,
   * direction or role): both are left in place for the user to settle.
   */
  disagreements: RelationshipDisagreement[];
  /**
   * Model files left untouched because rewriting their `relationships:`
   * list would lose a comment or an entry the reader cannot understand
   * (`relationshipsRewriteLoses`); what would have gone there stays put.
   */
  lockedFiles: string[];
  /** Diagram copies the keys contradict (`contradictsKeys`), stored the other way round. */
  turned: Array<{ domain: string; relationship: Relationship; to: Relationship }>;
  /**
   * Diagram copies that define a link the model library already holds in a
   * different way. The library's version — the one every diagram already
   * draws — is kept, and these copies go with the rest.
   */
  keptLibrary: Array<{ domain: string; relationship: Relationship; library: Relationship }>;
  /** Composite keys left whole in every diagram that has them, and why (#133 L2). */
  leftGroups: Array<{ members: Relationship[]; domains: string[]; reason: string }>;
  /** Single diagram copies of a composite's column pairs, taken out because the composite moves (#133 L2). */
  regrouped: Array<{ domain: string; relationship: Relationship; compositeKey: string }>;
}

/** Two copies of one link, one in each model file, that disagree. */
export interface RelationshipDisagreement {
  /** The copy stored on its one side. */
  stored: Relationship;
  /** The copy the many side's file already holds. */
  held: Relationship;
}

/** One library entry moving to its many side's file (see `MoveToLibraryPlan.rehome`). */
export interface RelationshipRehome {
  /** The model whose file holds it now. */
  from: string;
  /** The entry as stored there, with `fromModel` = `from`. */
  stored: Relationship;
  /** The same relationship as it will be stored, on its many side. */
  to: Relationship;
}

/**
 * Library entries stored the wrong way round (#133), which belong with the
 * model holding the foreign key: a `one-to-many` in the file of its "one"
 * side, and a `many-to-one` its keys contradict (`contradictsKeys`: 1.6.7
 * saved one backwards from a dimension's whole key). Nothing else is guessed
 * at. Entries whose many side has no library file stay where they are, and so
 * does an entry when another copy of the link, in either file, disagrees with
 * it, or whose files are `locked` (see `MoveToLibraryPlan.lockedFiles`).
 */
export function planRehome(
  libraryModels: readonly SemanticModel[],
  libraryModel: (name: string) => SemanticModel | null,
  locked: (model: string) => boolean = () => false,
  /** dbt's key evidence for models that flag no key (#133 L1). */
  dbt?: DbtKeyIndex,
): Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> {
  const plan: Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> = { rehome: [], disagreements: [], lockedFiles: [] };
  const disagreeing = new Set<string>();
  // Each file's entries, and how the move reads each one: a composite's
  // member as part of its group (keys on the column sets, #133 L2), any other
  // entry on its own — so a member is never judged by its single column.
  const files = new Map<string, { list: Relationship[]; forms: Relationship[]; groupOf: Array<Relationship[] | undefined> }>();
  const fileOf = (model: SemanticModel) => {
    const key = model.name.toLowerCase();
    if (!files.has(key)) {
      const list = libraryRelationshipsOf(model);
      const groupOfEntry = list.map((r) => { const g = groupOf(list, r); return g?.includes(r) ? g : undefined; });
      const forms = list.map((r, i) => {
        const g = groupOfEntry[i];
        return g ? keyedGroup(g, libraryModel, dbt)[g.indexOf(r)] : keyedRelationship(r, libraryModel, dbt);
      });
      files.set(key, { list, forms, groupOf: groupOfEntry });
    }
    return files.get(key)!;
  };
  /** The first other copy of `to`'s link in `inFiles` that says something else, skipping `skip`. */
  const disagreement = (inFiles: SemanticModel[], to: Relationship, skip: (file: string, i: number) => boolean): Relationship | undefined => {
    for (const m of inFiles) {
      const { list, forms } = fileOf(m);
      const i = list.findIndex((r, j) => !skip(m.name, j) && sameLink(r, to) && !agreesAs(forms[j], r.role, to));
      if (i !== -1) return list[i];
    }
    return undefined;
  };
  // Rehomes that move together: a composite's members, all or none.
  const batches: RelationshipRehome[][] = [];
  for (const model of libraryModels) {
    const { list, forms, groupOf: groups } = fileOf(model);
    const grouped = new Set<number>();
    list.forEach((stored, index) => {
      if (grouped.has(index)) return;
      const group = groups[index];
      if (group) {
        const indices = group.map((m) => list.indexOf(m));
        indices.forEach((i) => grouped.add(i));
        const to = indices.map((i) => forms[i]);
        if (to.every((t, k) => relationshipKey(t) === relationshipKey(group[k]) && t.cardinality === group[k].cardinality)) return;
        const home = libraryModel(to[0].fromModel);
        if (!home) return;
        const inFiles = [model, ...(same(home.name, model.name) ? [] : [home])];
        const disagree = to.flatMap((t, k) => {
          const held = disagreement(inFiles, t, (file, i) => same(file, model.name) && indices.includes(i));
          return held ? [{ stored: group[k], held }] : [];
        });
        if (disagree.length > 0) {
          for (const d of disagree) if (!disagreeing.has(linkKey(d.stored))) plan.disagreements.push(d);
          for (const m of group) disagreeing.add(linkKey(m));
          return;
        }
        if (lockedOut(model, home)) return;
        // In its new file it keeps its name unless that file already uses it.
        const keys = new Set(group.map(linkKey));
        const elsewhere = libraryRelationshipsOf(home).filter((r) => !keys.has(linkKey(r)));
        const name = elsewhere.some((r) => r.compositeKey && same(r.compositeKey, group[0].compositeKey!))
          ? nextCompositeKey(elsewhere, to[0].toModel) : group[0].compositeKey!;
        batches.push(group.map((s, k) => ({ from: model.name, stored: s, to: { ...to[k], compositeKey: name } })));
        return;
      }
      if (forms[index] === stored) return;
      // A single link moving file carries no compositeKey: one that groups nothing is stale (#133 L2).
      const { compositeKey: _stale, ...to } = forms[index];
      const home = libraryModel(to.fromModel);
      if (!home) return;
      // Every other copy of the link, in either file, must say the same.
      const held = disagreement([model, ...(same(home.name, model.name) ? [] : [home])], to, (file, i) => same(file, model.name) && i === index);
      if (held) {
        if (!disagreeing.has(linkKey(to))) plan.disagreements.push({ stored, held });
        disagreeing.add(linkKey(to));
        return;
      }
      if (lockedOut(model, home)) return;
      batches.push([{ from: model.name, stored, to }]);
    });
  }
  function lockedOut(model: SemanticModel, home: SemanticModel): boolean {
    const lockedHere = [model.name, home.name].filter(locked);
    plan.lockedFiles.push(...lockedHere.filter((m) => !plan.lockedFiles.includes(m)));
    return lockedHere.length > 0;
  }
  // A link listed as disagreeing moves nowhere, whichever copy came first — nor does the rest of its composite.
  plan.rehome = batches.filter((b) => !b.some((r) => disagreeing.has(linkKey(r.to)))).flat();
  return plan;
}

/** A composite's members as the move stores them: on its many side, turned round together where the column sets' keys say so. */
function keyedGroup(group: readonly Relationship[], modelOf: (name: string) => KeyedModel | null, dbt?: DbtKeyIndex): Relationship[] {
  const canon = group.map(canonicalRelationship);
  return contradictsKeysOf(canon, modelOf, dbt)
    ? canon.map((c) => ({ ...reverseRelationship(c), cardinality: 'many-to-one' as const }))
    : canon;
}

/** Whether a copy, read as the move stores it (`form`), says what `home` says: its meaning, and any role. */
function agreesAs(form: Relationship, role: string | undefined, home: Relationship): boolean {
  return sameMeaning(form, home) && (!role || !home.role || role === home.role);
}

/** Whether two entries are the same stored entry (same ends, cardinality and role). */
function sameEntry(a: Relationship, b: Relationship): boolean {
  return relationshipKey(a) === relationshipKey(b) && a.cardinality === b.cardinality && a.role === b.role;
}

/** Whether two definitions mean the same, ignoring roles: cardinality, and its many (or FK) side unless many-to-many. */
function sameMeaning(a: Relationship, b: Relationship): boolean {
  if (a.cardinality !== b.cardinality || !sameLink(a, b)) return false;
  return a.cardinality === 'many-to-many' || relationshipKey(a) === relationshipKey(b);
}

/**
 * How the move stores a diagram's copy: on its many side, turned round where
 * the keys contradict it (`keyedRelationship`), and a many-to-many — which
 * has no many side — from its lower end, so the order the diagrams are read
 * in never decides its file.
 */
function moveForm(rel: Relationship, modelOf: (name: string) => KeyedModel | null, dbt?: DbtKeyIndex): Relationship {
  const keyed = keyedRelationship(rel, modelOf, dbt);
  if (keyed.cardinality !== 'many-to-many') return keyed;
  const from = `${keyed.fromModel}.${keyed.fromColumn}`.toLowerCase();
  const to = `${keyed.toModel}.${keyed.toColumn}`.toLowerCase();
  return from <= to ? keyed : reverseRelationship(keyed);
}

const CARDINALITY_ORDER: Relationship['cardinality'][] = ['many-to-one', 'one-to-one', 'many-to-many', 'one-to-many'];

/**
 * The distinct definitions behind diagram copies of one link (#133): by
 * meaning (`sameMeaning`) and role. A copy without a role agrees with one
 * that has a role; two different roles are two definitions. Sorted, so the
 * order the diagrams are read in decides nothing.
 */
function definitionsOf(uses: ReadonlyArray<{ label: string; stored: Relationship }>): Array<{ relationship: Relationship; domains: string[] }> {
  const groups: Array<Array<{ label: string; stored: Relationship }>> = [];
  for (const use of uses) {
    const group = groups.find((g) => sameMeaning(g[0].stored, use.stored));
    if (group) group.push(use);
    else groups.push([use]);
  }
  const strip = ({ role: _role, ...rel }: Relationship): Relationship => rel;
  const labels = (us: typeof uses): string[] => [...new Set(us.map((u) => u.label))];
  const definitions = groups.flatMap((group) => {
    const roles = [...new Set(group.map((u) => u.stored.role).filter((r): r is string => !!r))];
    if (roles.length <= 1) {
      return [{ relationship: { ...strip(group[0].stored), ...(roles[0] ? { role: roles[0] } : {}) }, domains: labels(group) }];
    }
    const unlabelled = group.filter((u) => !u.stored.role);
    return [
      ...roles.map((role) => ({ relationship: { ...strip(group[0].stored), role }, domains: labels(group.filter((u) => u.stored.role === role)) })),
      ...(unlabelled.length > 0 ? [{ relationship: strip(group[0].stored), domains: labels(unlabelled) }] : []),
    ];
  });
  const sortKey = (d: { relationship: Relationship }): string =>
    `${CARDINALITY_ORDER.indexOf(d.relationship.cardinality)}\u0000${relationshipKey(d.relationship)}\u0000${d.relationship.role ?? ''}`;
  return definitions.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/**
 * Plan "Move Relationships to Model Library": every relationship in a v5
 * domain file goes to the file of the model holding its foreign key, once,
 * stored as `moveForm` reads it — so one run leaves nothing for a second. When
 * the diagrams define it in different ways (cardinality, role, or which end
 * of a one-to-one holds the key) it is a conflict, which only the user
 * settles (`resolveConflict` with their pick), never this code. A
 * relationship the library already defines is taken out of the domain files:
 * the library's version is the one every diagram already draws, a diagram
 * copy that says otherwise is listed (`keptLibrary`), and a role only a
 * diagram gives it moves onto the library entry — onto the entry as it will
 * be stored when the library entry itself is being turned round.
 */
export function planMoveToLibrary(
  domains: ReadonlyArray<{ label: string; relationships: readonly Relationship[] }>,
  libraryModel: (name: string) => SemanticModel | null,
  libraryModels: readonly SemanticModel[] = [],
  locked: (model: string) => boolean = () => false,
  /** `dbt`: dbt's key evidence, for models that flag no key (#133 L1). */
  options: { dbt?: DbtKeyIndex } = {},
): MoveToLibraryPlan {
  const { dbt } = options;
  const plan: MoveToLibraryPlan = {
    toLibrary: [], removeFromDomains: new Map(), conflicts: [], skippedNoModel: [], turned: [], keptLibrary: [],
    leftGroups: [], regrouped: [],
    ...planRehome(libraryModels, libraryModel, locked, dbt),
  };
  // A relationship bound for a locked file stays in its domain files.
  const isLocked = (...names: string[]): boolean => {
    const hit = names.filter(locked);
    for (const name of hit) if (!plan.lockedFiles.includes(name)) plan.lockedFiles.push(name);
    return hit.length > 0;
  };
  const takeOut = (label: string, key: string): void => {
    const keys = plan.removeFromDomains.get(label) ?? new Set<string>();
    keys.add(key);
    plan.removeFromDomains.set(label, keys);
  };

  // Composite keys first (#133 L2): each moves as one, or stays whole.
  const handled = planGroupMoves(plan, domains, libraryModel, isLocked, takeOut, dbt);

  // Every diagram copy of each link, however it was drawn (#133).
  // Stored with the models' real spelling (#133 L4), and as a single link.
  const byKey = new Map<string, Array<{ label: string; drawn: Relationship; stored: Relationship }>>();
  for (const domain of domains) {
    for (const drawn of domain.relationships) {
      const key = linkKey(drawn);
      if (handled.has(key)) continue;
      const ends = [libraryModel(drawn.fromModel), libraryModel(drawn.toModel)].filter((m): m is SemanticModel => !!m);
      const { compositeKey: _stale, ...single } = respellRelationship(drawn, ends);
      const stored = moveForm(single, libraryModel, dbt);
      byKey.set(key, [...(byKey.get(key) ?? []), { label: domain.label, drawn, stored }]);
    }
  }

  for (const [key, uses] of byKey) {
    const sample = uses[0].drawn;
    const ends = [libraryModel(sample.fromModel), libraryModel(sample.toModel)];
    // The library's word on this link: as it will be stored once turned round, else the copy drawn.
    const rehomes = plan.rehome.filter((r) => linkKey(r.to) === key);
    const library = rehomes[0]?.to ?? mergeLibraryRelationships(
      ends.map((m, i) => m ?? { name: i === 0 ? sample.fromModel : sample.toModel, columns: [] }), [], '', undefined, dbt,
    ).find((r) => linkKey(r) === key);

    if (library) {
      // A role only the diagrams give it is the link's label, whatever else they say about it.
      const roles = [...new Set(uses.map((u) => u.stored.role).filter((r): r is string => !!r))];
      const role = library.role ?? (roles.length === 1 ? roles[0] : undefined);
      const agreeing = uses.filter((u) => sameMeaning(u.stored, library) && (!u.stored.role || u.stored.role === role));
      if (role && !library.role) {
        if (rehomes.length > 0) {
          for (const r of rehomes) r.to = { ...r.to, role };
        } else {
          if (isLocked(library.fromModel)) continue;
          plan.toLibrary.push({ ...library, role });
        }
      }
      for (const use of uses) {
        if (!agreeing.includes(use)) {
          plan.keptLibrary.push({ domain: use.label, relationship: use.drawn, library: { ...library, ...(role ? { role } : {}) } });
        } else if (contradictsKeys(canonicalRelationship(use.drawn), libraryModel, dbt)) {
          plan.turned.push({ domain: use.label, relationship: use.drawn, to: library });
        }
        takeOut(use.label, key);
      }
      continue;
    }

    const definitions = definitionsOf(uses);
    if (definitions.some((d) => !libraryModel(d.relationship.fromModel))) {
      plan.skippedNoModel.push(sample);
      continue;
    }
    if (definitions.length > 1) {
      // Settled at either end, depending on the definition picked.
      if (isLocked(...new Set(definitions.map((d) => d.relationship.fromModel)), sample.toModel, sample.fromModel)) continue;
      const head = definitions[0].relationship;
      const roles = [...new Set(definitions.map((d) => d.relationship.role).filter((r): r is string => !!r))];
      const relationship = { ...pickEnds(head), ...(roles.length === 1 ? { role: roles[0] } : {}) };
      plan.conflicts.push({
        relationship,
        definitions: definitions.map((d) => ({
          ...d,
          cardinality: relationshipKey(d.relationship) === relationshipKey(head) || d.relationship.cardinality === 'many-to-many'
            ? d.relationship.cardinality
            : reverseRelationship(d.relationship).cardinality,
        })),
      });
      continue;
    }
    const [{ relationship }] = definitions;
    if (isLocked(relationship.fromModel)) continue;
    plan.toLibrary.push(relationship);
    for (const use of uses) {
      if (contradictsKeys(canonicalRelationship(use.drawn), libraryModel, dbt)) {
        plan.turned.push({ domain: use.label, relationship: use.drawn, to: relationship });
      }
      takeOut(use.label, key);
    }
  }
  return plan;
}

/**
 * The composite keys diagrams define, planned as units (#133 L2), before the
 * links one by one. A composite moves to its many side's file — every member
 * with its name (re-suffixed only when that file already uses the name) and
 * the group's role — and leaves every diagram, single copies of its pairs
 * included (`regrouped`). Diagrams that define it differently are one
 * conflict over whole definitions. It stays whole in every diagram
 * (`leftGroups`) when its file is missing or locked, when the model library
 * holds a pair in another composite or defines one differently. Returns the
 * links it planned, which the link-by-link pass skips.
 */
function planGroupMoves(
  plan: MoveToLibraryPlan,
  domains: ReadonlyArray<{ label: string; relationships: readonly Relationship[] }>,
  libraryModel: (name: string) => SemanticModel | null,
  isLocked: (...names: string[]) => boolean,
  takeOut: (label: string, key: string) => void,
  dbt?: DbtKeyIndex,
): Set<string> {
  const handled = new Set<string>();
  const uses = new Map<string, Array<{ label: string; members: Relationship[] }>>();
  for (const domain of domains) {
    const rels = domain.relationships.filter(isEnds);
    const seen = new Set<Relationship>();
    for (const rel of rels) {
      if (seen.has(rel) || !rel.compositeKey) continue;
      const group = groupOf(rels, rel);
      if (!group) continue;
      group.forEach((m) => seen.add(m));
      // The same pairs, whichever side a diagram draws them from (definitions settle direction).
      const id = group.map(linkKey).sort().join('\u0001');
      uses.set(id, [...(uses.get(id) ?? []), { label: domain.label, members: group }]);
    }
  }
  // As the move stores a composite: real spelling, many side, keys win on the column sets, the first member's role.
  const formOf = (members: readonly Relationship[]): Relationship[] => {
    const ends = [libraryModel(members[0].fromModel), libraryModel(members[0].toModel)].filter((m): m is SemanticModel => !!m);
    const canon = members.map((m) => canonicalRelationship(respellRelationship(m, ends)));
    const keyed = contradictsKeysOf(canon, libraryModel, dbt)
      ? canon.map((c) => ({ ...reverseRelationship(c), cardinality: 'many-to-one' as const }))
      : canon;
    const role = members[0].role;
    return keyed.map(({ role: _r, ...m }) => ({ ...m, compositeKey: members[0].compositeKey!, ...(role ? { role } : {}) }));
  };
  for (const groupUses of uses.values()) {
    const keys = groupUses[0].members.map(linkKey);
    keys.forEach((k) => handled.add(k));
    const holders = domains.filter((d) => d.relationships.some((r) => isEnds(r) && keys.includes(linkKey(r)))).map((d) => d.label);
    const forms = groupUses.map((u) => ({ label: u.label, members: formOf(u.members) }));
    const head = forms[0].members;
    const leave = (reason: string): void => { plan.leftGroups.push({ members: head, domains: holders, reason }); };
    // A diagram that also keeps a member's link as another entry saying something else.
    const disagreeing = groupUses.some((u) => domains.find((d) => d.label === u.label)!.relationships
      .filter((r) => isEnds(r) && keys.includes(linkKey(r)) && !u.members.includes(r))
      .some((r) => !sameMeaning(moveForm(r, libraryModel, dbt), formOf(u.members).find((m) => sameLink(m, r))!)));
    if (disagreeing) {
      leave('a diagram also keeps one of its column pairs as another relationship that says something else');
      continue;
    }
    const owner = libraryModel(head[0].fromModel);
    if (!owner) {
      leave(`${head[0].fromModel} has no readable file in logical-models/`);
      continue;
    }
    // What the library already says about these pairs.
    const endFiles = [owner, libraryModel(head[0].toModel)].filter((m, i, all): m is SemanticModel => !!m && all.indexOf(m) === i);
    const library = endFiles.flatMap(libraryRelationshipsOf);
    const held = library.filter((r) => keys.includes(linkKey(r)));
    const libGroup = held.length > 0 ? groupOf(library, held[0]) : undefined;
    // The same pairs (in whichever direction the library holds them — planRehome turns them round).
    const pairsOfGroup = (members: readonly Relationship[]): string => members.map(linkKey).sort().join('\u0001');
    if (libGroup && pairsOfGroup(libGroup) === pairsOfGroup(head)) {
      // Already defined there, as every diagram draws it: the diagram copies go.
      for (const label of holders) for (const k of keys) takeOut(label, k);
      continue;
    }
    if (libGroup || held.some((r) => libraryGroupOf(library, r))) {
      leave('the model library holds one of its column pairs in another composite key');
      continue;
    }
    if (held.some((r) => !sameMeaning(keyedRelationship(r, libraryModel, dbt), head.find((m) => sameLink(m, r))!))) {
      leave('the model library defines one of its column pairs differently');
      continue;
    }
    const definitions = groupDefinitions(forms);
    if (definitions.length > 1) {
      if (isLocked(...new Set(definitions.map((d) => d.members[0].fromModel)), head[0].toModel)) {
        leave('a model file it would go in has comments or entries ERD Studio cannot read');
        continue;
      }
      const roles = [...new Set(definitions.map((d) => d.members[0].role).filter((r): r is string => !!r))];
      const ends = pickEnds(definitions[0].members[0]);
      plan.conflicts.push({
        relationship: { ...ends, ...(roles.length === 1 ? { role: roles[0] } : {}) },
        definitions: definitions.map((d) => ({
          relationship: d.members[0],
          members: d.members,
          cardinality: relationshipKey(d.members[0]) === relationshipKey(ends) ? d.members[0].cardinality : reverseRelationship(d.members[0]).cardinality,
          domains: d.domains,
        })),
        alsoIn: holders.filter((h) => !definitions.some((d) => d.domains.includes(h))),
      });
      continue;
    }
    if (isLocked(owner.name)) {
      leave('its model file has comments or entries ERD Studio cannot read');
      continue;
    }
    const [{ members }] = definitions;
    const elsewhere = libraryRelationshipsOf(owner).filter((r) => !keys.includes(linkKey(r)));
    const name = elsewhere.some((r) => r.compositeKey && same(r.compositeKey, members[0].compositeKey!))
      ? nextCompositeKey(elsewhere, members[0].toModel) : members[0].compositeKey!;
    plan.toLibrary.push(...members.map((m) => ({ ...m, compositeKey: name })));
    for (const use of groupUses) {
      if (contradictsKeysOf(use.members.map(canonicalRelationship), libraryModel, dbt)) {
        use.members.forEach((m, i) => plan.turned.push({ domain: use.label, relationship: m, to: { ...members[i], compositeKey: name } }));
      }
    }
    for (const label of holders) {
      for (const k of keys) takeOut(label, k);
      if (groupUses.some((u) => u.label === label)) continue;
      const singles = domains.find((d) => d.label === label)!.relationships.filter((r) => isEnds(r) && keys.includes(linkKey(r)));
      for (const relationship of singles) plan.regrouped.push({ domain: label, relationship, compositeKey: name });
    }
  }
  return handled;
}

/** The valid composite `rel` belongs to among library entries, if any. */
const libraryGroupOf = (library: readonly Relationship[], rel: Relationship): Relationship[] | undefined =>
  (rel.compositeKey ? groupOf(library, rel) : undefined);

/**
 * The distinct definitions of one composite across diagrams: its cardinality
 * and which side holds the key (as `formOf` stores it), and its role — a
 * diagram without a role agrees with one that has one. Sorted, so diagram
 * order decides nothing.
 */
function groupDefinitions(forms: ReadonlyArray<{ label: string; members: Relationship[] }>): Array<{ members: Relationship[]; domains: string[] }> {
  const meaning = (members: readonly Relationship[]): string =>
    `${members[0].cardinality}\u0000${members.map(relationshipKey).sort().join('\u0001')}`;
  const buckets = new Map<string, Array<{ label: string; members: Relationship[] }>>();
  for (const f of forms) buckets.set(meaning(f.members), [...(buckets.get(meaning(f.members)) ?? []), f]);
  const out: Array<{ members: Relationship[]; domains: string[] }> = [];
  const withRole = (members: Relationship[], role?: string): Relationship[] =>
    members.map(({ role: _r, ...m }) => ({ ...m, ...(role ? { role } : {}) }));
  for (const bucket of buckets.values()) {
    const roles = [...new Set(bucket.map((f) => f.members[0].role).filter((r): r is string => !!r))];
    const labels = (fs: typeof bucket): string[] => [...new Set(fs.map((f) => f.label))];
    if (roles.length <= 1) {
      out.push({ members: withRole(bucket[0].members, roles[0]), domains: labels(bucket) });
      continue;
    }
    for (const role of roles) out.push({ members: withRole(bucket[0].members, role), domains: labels(bucket.filter((f) => f.members[0].role === role)) });
    const unlabelled = bucket.filter((f) => !f.members[0].role);
    if (unlabelled.length > 0) out.push({ members: withRole(bucket[0].members), domains: labels(unlabelled) });
  }
  const sortKey = (d: { members: Relationship[] }): string =>
    `${CARDINALITY_ORDER.indexOf(d.members[0].cardinality)}\u0000${meaning(d.members)}\u0000${d.members[0].role ?? ''}`;
  return out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/**
 * Settle a conflict the way the user picked: `definition` goes to the
 * library — with the conflict's role when it has none of its own — and every
 * domain file's copy is taken out, so each diagram now draws the one
 * definition. Returns the plan unchanged for a conflict or definition it does
 * not hold.
 */
export function resolveConflict(
  plan: MoveToLibraryPlan,
  conflict: RelationshipConflict,
  definition: ConflictDefinition,
): MoveToLibraryPlan {
  if (!plan.conflicts.includes(conflict) || !conflict.definitions.includes(definition)) return plan;
  const key = linkKey(conflict.relationship);
  const removeFromDomains = new Map([...plan.removeFromDomains].map(([label, keys]) => [label, new Set(keys)]));
  for (const domain of conflict.definitions.flatMap((d) => d.domains)) {
    const keys = removeFromDomains.get(domain) ?? new Set<string>();
    keys.add(key);
    removeFromDomains.set(domain, keys);
  }
  const role = definition.relationship.role ?? conflict.relationship.role;
  const settled = definition.members ?? [definition.relationship];
  // A composite takes every member out of every diagram that holds one, single copies too.
  for (const domain of [...conflict.definitions.flatMap((d) => d.domains), ...(conflict.alsoIn ?? [])]) {
    const keys = removeFromDomains.get(domain) ?? new Set<string>();
    for (const m of settled) keys.add(linkKey(m));
    removeFromDomains.set(domain, keys);
  }
  return {
    ...plan,
    toLibrary: [...plan.toLibrary, ...settled.map((m) => ({ ...m, ...(role ? { role } : {}) }))],
    removeFromDomains,
    conflicts: plan.conflicts.filter((c) => c !== conflict),
  };
}

/** The model files a settled plan writes, by model name. */
export function moveTargets(plan: Pick<MoveToLibraryPlan, 'toLibrary' | 'rehome'>): string[] {
  const names = [...plan.toLibrary.map((r) => r.fromModel), ...plan.rehome.flatMap((r) => [r.from, r.to.fromModel])];
  // One write per file, however its model is spelled.
  return names.filter((name, i) => names.findIndex((n) => same(n, name)) === i);
}

/**
 * Apply a settled plan to one model's relationships, in place. A turned-round
 * entry leaves by itself — never by link, as another copy in the same file
 * may be the one drawn — and an entry arriving where the file already holds
 * the link keeps that copy, gaining only a role it lacks. Returns whether the
 * model changed. Shared by the command and the exhaustive checker.
 */
export function applyMoveToModel(plan: Pick<MoveToLibraryPlan, 'toLibrary' | 'rehome'>, model: SemanticModel): boolean {
  let changed = false;
  for (const { from, stored } of plan.rehome) {
    if (!same(from, model.name)) continue;
    const list = model.relationships ?? [];
    const index = list.findIndex((entry) => sameEntry({ fromModel: model.name, ...entry }, stored));
    if (index === -1) continue;
    const kept = list.filter((_, i) => i !== index);
    if (kept.length > 0) model.relationships = kept;
    else delete model.relationships;
    changed = true;
  }
  for (const rel of [...plan.toLibrary, ...plan.rehome.map((r) => r.to)]) {
    if (!same(rel.fromModel, model.name)) continue;
    const held = libraryRelationshipsOf(model);
    // The copy that says the same gains the role (and a composite's name,
    // when it is a single the group takes in) — never another copy of the link.
    const index = held.findIndex((r) => sameMeaning(r, rel));
    if (index !== -1) {
      const gains = {
        ...(!held[index].role && rel.role ? { role: rel.role } : {}),
        ...(!held[index].compositeKey && rel.compositeKey ? { compositeKey: rel.compositeKey } : {}),
      };
      if (Object.keys(gains).length > 0) {
        model.relationships = (model.relationships ?? []).map((entry, i) => (i === index ? { ...entry, ...gains } : entry));
        changed = true;
      }
      continue;
    }
    if (held.some((r) => sameLink(r, rel))) continue;
    changed = upsertLibraryRelationship(model, { ...rel, fromModel: model.name }) || changed;
  }
  return changed;
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
  const lowerModels = domains.map((d) => new Set(d.models.map((m) => m.toLowerCase())));
  const keys = new Set<string>();
  for (const domain of domains) {
    for (const rel of domain.relationships) {
      const holders = lowerModels.filter((models) =>
        models.has(rel.fromModel.toLowerCase()) && models.has(rel.toModel.toLowerCase())).length;
      if (holders > 1) keys.add(relationshipKey(rel));
    }
  }
  return keys.size;
}

const describeEnds = (rel: RelationshipEnds): string =>
  `${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn}`;

/** A definition in a few words: which way round (unless many-to-many), its cardinality, and its role. */
export const describeDefinition = (rel: Relationship): string =>
  `${rel.cardinality === 'many-to-many' ? '' : `${describeEnds(rel)} `}${rel.cardinality}` +
  `${rel.cardinality === 'one-to-one' ? ` (${rel.fromModel} holds the foreign key)` : ''}${rel.role ? `, role "${rel.role}"` : ''}`;

/** A composite key in a few words: `pit.(a, b) → sat.(c, d)`. */
const describeGroupEnds = (members: readonly RelationshipEnds[]): string =>
  `${members[0].fromModel}.(${members.map((m) => m.fromColumn).join(', ')}) → ${members[0].toModel}.(${members.map((m) => m.toColumn).join(', ')})`;

/** A conflict's definition in a few words; a composite key names all its column pairs (#133 L2). */
export const describeConflictDefinition = (d: Pick<ConflictDefinition, 'relationship' | 'members'>): string =>
  (d.members && d.members.length > 1
    ? `composite key ${describeGroupEnds(d.members)} ${d.relationship.cardinality}${d.relationship.role ? `, role "${d.relationship.role}"` : ''}`
    : describeDefinition(d.relationship));

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The modal's detail for "Move Relationships to Model Library": why the move
 * helps, where each relationship will live (`fileOf` names a model's file,
 * e.g. `logical-models/fct_order.yml`), and what happens to conflicts.
 */
export function describeMovePlan(plan: MoveToLibraryPlan, fileOf: (model: string) => string = (m) => `logical-models/${m}.yml`): string {
  const movesDomains = plan.removeFromDomains.size > 0 || plan.conflicts.length > 0;
  const lines: string[] = movesDomains
    ? [
      'Why: today each diagram keeps its own copy of a relationship, so two diagrams can draw the same link ' +
      'differently, and a new diagram has to draw it again. After the move each relationship is defined once, and ' +
      'every diagram that holds both models draws it. A change made in one diagram shows in all of them.',
    ]
    : [];

  // Where each relationship will live — a conflict too, once a version is picked.
  const byFile = new Map<string, RelationshipEnds[]>();
  for (const rel of [...plan.toLibrary, ...plan.conflicts.map((c) => c.relationship)]) {
    const file = fileOf(rel.fromModel);
    byFile.set(file, [...(byFile.get(file) ?? []), rel]);
  }
  const diagrams = new Set([...plan.removeFromDomains.keys(), ...plan.conflicts.flatMap((c) => c.definitions.flatMap((d) => d.domains))]);
  if (byFile.size > 0) {
    lines.push('', 'Where: in the file of the model that holds the foreign key, under "relationships:".');
    for (const [file, rels] of [...byFile].slice(0, 6)) {
      lines.push(`• ${file} — ${rels.slice(0, 2).map(describeEnds).join(', ')}${rels.length > 2 ? ` and ${rels.length - 2} more` : ''}`);
    }
    if (byFile.size > 6) lines.push(`• …and ${byFile.size - 6} more model files`);
    lines.push(`Each is then taken out of the diagram files that held a copy (${plural(diagrams.size, 'diagram')}).`);
  }

  if (plan.conflicts.length > 0) {
    lines.push(
      '',
      `Conflicts: ${plural(plan.conflicts.length, 'relationship is', 'relationships are')} drawn differently in different ` +
      'diagrams. Next you pick the version to keep for each — or leave it as it is in each diagram for now:',
    );
    for (const conflict of plan.conflicts.slice(0, 5)) {
      const uses = conflict.definitions.map((d) => `${describeConflictDefinition(d)} in ${d.domains.join(', ')}`).join('; ');
      lines.push(`• ${describeEnds(conflict.relationship)}: ${uses}`);
    }
    if (plan.conflicts.length > 5) lines.push(`• …and ${plan.conflicts.length - 5} more`);
  }
  if (plan.skippedNoModel.length > 0) {
    lines.push(
      '',
      `${plural(plan.skippedNoModel.length, 'relationship starts', 'relationships start')} at a model with no readable ` +
      'file in logical-models/ and will stay in the diagram files.',
    );
  }
  // Every entry the move turns round is listed: the preview is the only chance to check them.
  if (plan.rehome.length > 0) {
    lines.push(
      '',
      `Turned round: ${plural(plan.rehome.length, 'relationship is', 'relationships are')} stored in the file of the ` +
      'model it points at. Each moves to the file of the model holding the foreign key, as many-to-one, so adding a ' +
      'new fact never means editing its dimensions:',
    );
    for (const { stored, to } of plan.rehome) {
      lines.push(`• ${describeEnds(stored)} → ${fileOf(to.fromModel)}${relationshipKey(canonicalRelationship(stored)) === relationshipKey(to)
        ? '' : ` (read the other way round: ${stored.fromModel}.${stored.fromColumn} is its model's key)`}`);
    }
  }
  if ((plan.turned ?? []).length > 0) {
    lines.push(
      '',
      `Read the other way round: ${plural(plan.turned.length, 'diagram copy runs', 'diagram copies run')} from a model's ` +
      'key to a column that is not the other model\'s key, so the key side cannot be the "many" side. Each is stored ' +
      'the other way round:',
    );
    for (const { domain, relationship, to } of plan.turned) lines.push(`• ${domain}: ${describeEnds(relationship)} → ${describeEnds(to)}`);
  }
  if ((plan.keptLibrary ?? []).length > 0) {
    lines.push(
      '',
      `Kept the model library's version: ${plural(plan.keptLibrary.length, 'diagram copy says', 'diagram copies say')} ` +
      'something different about a link the model library already defines. Each diagram already draws the library\'s ' +
      'version, which stays; these copies are taken out:',
    );
    for (const { domain, relationship, library } of plan.keptLibrary) {
      lines.push(`• ${domain}: ${describeEnds(relationship)} ${relationship.cardinality}${relationship.role ? `, role "${relationship.role}"` : ''} — the library has ${describeDefinition(library)} in ${fileOf(library.fromModel)}`);
    }
  }
  if ((plan.regrouped ?? []).length > 0) {
    lines.push(
      '',
      `Grouped: ${plural(plan.regrouped.length, 'diagram keeps', 'diagrams keep')} a column pair of a composite key as a single ` +
      'link. The composite key moves to the model library, so these copies are taken out:',
    );
    for (const { domain, relationship, compositeKey } of plan.regrouped) lines.push(`• ${domain}: ${describeEnds(relationship)} — part of ${compositeKey}`);
  }
  lines.push(...describeLeftAlone(plan, fileOf));
  if (movesDomains) {
    lines.push('', 'Teammates on an older ERD Studio version will not see relationships stored in the model library until they update.');
  }
  return lines.join('\n').replace(/^\n/, '');
}

/** What the move leaves for the user: copies that disagree, files it will not rewrite, and composite keys it leaves whole. */
export function describeLeftAlone(
  plan: Pick<MoveToLibraryPlan, 'disagreements' | 'lockedFiles'> & Partial<Pick<MoveToLibraryPlan, 'leftGroups'>>,
  fileOf: (model: string) => string = (m) => `logical-models/${m}.yml`,
): string[] {
  const lines: string[] = [];
  for (const { members, domains, reason } of plan.leftGroups ?? []) {
    lines.push('', `Composite key ${describeGroupEnds(members)} left in the diagrams (${domains.join(', ')}): ${reason}.`);
  }
  if (plan.disagreements.length > 0) {
    lines.push(
      '',
      `Needs your attention: ${plural(plan.disagreements.length, 'link is', 'links are')} saved in both model files, ` +
      'and the two copies disagree. Both are left as they are; delete the wrong one:',
    );
    const copy = (rel: Relationship): string =>
      `${describeEnds(rel)} ${rel.cardinality}${rel.role ? ` "${rel.role}"` : ''} in ${fileOf(rel.fromModel)}`;
    for (const { stored, held } of plan.disagreements.slice(0, 5)) lines.push(`• ${copy(stored)}, but ${copy(held)}`);
    if (plan.disagreements.length > 5) lines.push(`• …and ${plan.disagreements.length - 5} more`);
  }
  if (plan.lockedFiles.length > 0) {
    lines.push(
      '',
      `Left alone: the relationships list in ${plan.lockedFiles.map(fileOf).join(', ')} has comments or entries ` +
      'ERD Studio cannot read, which rewriting it would lose. Its relationships stay where they are; move them by hand.',
    );
  }
  return lines;
}
