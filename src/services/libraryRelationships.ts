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
  canonicalRelationship, contradictsKeys, keyedRelationship, linkKey, mergeLibraryRelationships, normaliseRelationshipRole,
  relationshipKey, reverseRelationship, sameLink,
} from '@erd-studio/core';
import type { KeyedModel } from '@erd-studio/core';
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
 * plus `role` when it has one.
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
    && current.role === entry.role) {
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

/** Remove every library relationship that starts or ends at `model.column`. */
export function removeColumnRelationships(
  models: readonly SemanticModel[],
  modelName: string,
  column: string,
): SemanticModel[] {
  return dropWhere(models, (rel) =>
    (same(rel.fromModel, modelName) && same(rel.fromColumn, column))
    || (same(rel.toModel, modelName) && same(rel.toColumn, column)));
}

/**
 * Follow a column rename: the model's own relationships leaving that column,
 * and every other model's relationships pointing at it.
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
      if (same(model.name, modelName) && rel.fromColumn === oldColumn) {
        rel.fromColumn = newColumn;
        touched = true;
      }
      if (same(rel.toModel, modelName) && rel.toColumn === oldColumn) {
        rel.toColumn = newColumn;
        touched = true;
      }
    }
    if (touched) changed.push(model);
  }
  return changed;
}

/** Follow a model rename in every other model's relationships that point at it. */
export function renameModelInRelationships(
  models: readonly SemanticModel[],
  oldName: string,
  newName: string,
): SemanticModel[] {
  const changed: SemanticModel[] = [];
  for (const model of models) {
    let touched = false;
    for (const rel of model.relationships ?? []) {
      if (rel.toModel === oldName) {
        rel.toModel = newName;
        touched = true;
      }
    }
    if (touched) changed.push(model);
  }
  return changed;
}

/** One canvas edit of a relationship, as the webview sends it. */
export type RelationshipWriteOp =
  | { kind: 'add'; drawn: Relationship }
  /** ⇄ or a context-menu cardinality: the drawn line's ends, with the new cardinality. */
  | { kind: 'update'; ends: RelationshipEnds; cardinality: Relationship['cardinality'] }
  | { kind: 'edit'; original: RelationshipEnds; drawn: Relationship }
  | { kind: 'remove'; keys: readonly RelationshipEnds[] };

export interface RelationshipWriteInput {
  /** Where this project keeps relationships: the model library, or the open domain file. */
  home: 'library' | 'domain';
  /** Every library model, never changed in place ([] for a v4 domain). */
  models: readonly SemanticModel[];
  /** The open domain file's `logical.relationships`, as parsed; never changed in place. */
  domainRelationships: readonly Relationship[];
}

export type RelationshipWritePlan =
  | {
    ok: true;
    /** Copies of the library models whose `relationships` changed, to save. */
    changed: SemanticModel[];
    /** The domain file's new `logical.relationships`, or null when it is unchanged. */
    domainRelationships: Relationship[] | null;
  }
  | { ok: false; error: string; /** Set when the home model has no readable file. */ missingModel?: string };

const refuse = (error: string, missingModel?: string): RelationshipWritePlan =>
  ({ ok: false, error, ...(missingModel ? { missingModel } : {}) });

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
  const { home, models, domainRelationships } = input;
  const modelOf = (name: string): SemanticModel | undefined => models.find((m) => same(m.name, name));
  const drawnLines = (): Relationship[] => mergeLibraryRelationships(home === 'library' ? models : [], domainRelationships);
  const libraryCopies = (key: string): Relationship[] => models.flatMap(libraryRelationshipsOf).filter((r) => linkKey(r) === key);
  const domainCopies = (key: string): Relationship[] => domainRelationships.filter((r) => isEnds(r) && linkKey(r) === key);
  const stored = (key: string): boolean => libraryCopies(key).length > 0 || domainCopies(key).length > 0;

  if (op.kind === 'remove') {
    const keys = new Set(op.keys.map(linkKey));
    const changed = models.map(copyModel).filter((m) => removeLibraryRelationships([m], op.keys).length > 0);
    const kept = domainRelationships.filter((r) => !isEnds(r) || !keys.has(linkKey(r)));
    if (changed.length === 0 && kept.length === domainRelationships.length) return refuse('Relationship not found.');
    return { ok: true, changed, domainRelationships: kept.length === domainRelationships.length ? null : kept };
  }

  const original = op.kind === 'add' ? null : op.kind === 'update' ? op.ends : op.original;
  const oldKey = original ? linkKey(original) : null;
  if (oldKey && !stored(oldKey)) return refuse('Relationship not found.');
  const line = oldKey ? drawnLines().find((r) => linkKey(r) === oldKey) : undefined;

  let role: string | undefined;
  if (op.kind === 'update') {
    const roles = [...new Set([...libraryCopies(oldKey!), ...domainCopies(oldKey!)]
      .map((r) => normaliseRelationshipRole(r.role)).filter((r): r is string => !!r))];
    const drawnRole = normaliseRelationshipRole(line?.role);
    if (roles.some((r) => r !== (drawnRole ?? roles[0]))) {
      return refuse(`This link is saved more than once with different roles (${roles.map((r) => `"${r}"`).join(', ')}). ` +
        'Edit the relationship to choose one, then try again.');
    }
    role = drawnRole ?? roles[0];
  } else {
    role = normaliseRelationshipRole(op.drawn.role);
  }
  const drawn: Relationship = op.kind === 'update'
    ? { ...pickEnds(op.ends), cardinality: op.cardinality }
    : { ...pickEnds(op.drawn), cardinality: op.drawn.cardinality };
  const newKey = linkKey(drawn);
  if (newKey !== oldKey && stored(newKey)) {
    return refuse(op.kind === 'add' ? 'This relationship already exists.' : 'A relationship with this key already exists.');
  }

  // Keys win (#133): ⇄ may not make a unique column the "many" side.
  const next: Relationship = { ...(home === 'library' ? canonicalRelationship(drawn) : drawn), ...(role ? { role } : {}) };
  const asMany = canonicalRelationship(drawn);
  const lineAsMany = line && canonicalRelationship(line);
  if (op.kind === 'update' && contradictsKeys(asMany, modelOf)
    && !(lineAsMany?.cardinality === 'many-to-one' && relationshipKey(lineAsMany) === relationshipKey(asMany))) {
    const model = modelOf(asMany.fromModel)?.name ?? asMany.fromModel;
    return refuse(`${model}.${asMany.fromColumn} is ${model}'s key, so each value appears only once — it can't be ` +
      'the "many" side. Unmark it as a key first, then try again.');
  }

  const replaceKeys = new Set([oldKey, newKey].filter((k): k is string => !!k));
  if (home === 'domain') {
    // The first copy (the drawn one when its ends match) keeps its place and any other keys it has.
    const base = domainRelationships.find((r) => isEnds(r) && line && relationshipKey(r) === relationshipKey(line))
      ?? domainRelationships.find((r) => isEnds(r) && replaceKeys.has(linkKey(r)));
    const { role: _old, ...rest } = (base ?? {}) as Relationship;
    const entry = { ...rest, ...next } as Relationship;
    const list: Relationship[] = [];
    for (const r of domainRelationships) {
      if (!isEnds(r) || !replaceKeys.has(linkKey(r))) list.push(r);
      else if (r === base) list.push(entry);
    }
    if (!base) list.push(entry);
    // A library copy (a project switching homes) is folded in too.
    const changed = models.map(copyModel).filter((m) => dropWhere([m], (r) => replaceKeys.has(linkKey(r))).length > 0);
    return { ok: true, changed, domainRelationships: list };
  }

  const target = modelOf(next.fromModel);
  if (!target) return refuse(`Model "${next.fromModel}" not found in logical-models/.`, next.fromModel);
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
        out.push(libraryEntry({ ...next, fromModel: model.name }));
        placed = true;
      }
    }
    if (isTarget && !placed) out.push(libraryEntry({ ...next, fromModel: model.name }));
    if (JSON.stringify(out) === JSON.stringify(list)) continue;
    const copy = copyModel(model);
    if (out.length > 0) copy.relationships = out;
    else delete copy.relationships;
    changed.push(copy);
  }
  const kept = domainRelationships.filter((r) => !isEnds(r) || !replaceKeys.has(linkKey(r)));
  return { ok: true, changed, domainRelationships: kept.length === domainRelationships.length ? null : kept };
}

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
  const loaded = new Map<string, SemanticModel | null>();
  const modelFor = (name: string): SemanticModel | null => {
    const fresh = newModels.find((m) => m.name === name);
    if (fresh) return fresh;
    if (!loaded.has(name)) loaded.set(name, libraryModel(name));
    return loaded.get(name) ?? null;
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
  /** On its many side (keys win), with its role. */
  relationship: Relationship;
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
): Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> {
  const plan: Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> = { rehome: [], disagreements: [], lockedFiles: [] };
  const disagreeing = new Set<string>();
  for (const model of libraryModels) {
    libraryRelationshipsOf(model).forEach((stored, index) => {
      const to = keyedRelationship(stored, libraryModel);
      if (to === stored) return;
      const home = libraryModel(to.fromModel);
      if (!home) return;
      // Every other copy of the link, in either file, must say the same.
      const files = [model, ...(same(home.name, model.name) ? [] : [home])];
      const others = files.flatMap((m) => libraryRelationshipsOf(m)
        .filter((r, i) => sameLink(r, to) && !(same(m.name, model.name) && i === index)));
      const held = others.find((r) => !agrees(r, to, libraryModel));
      if (held) {
        if (!disagreeing.has(linkKey(to))) plan.disagreements.push({ stored, held });
        disagreeing.add(linkKey(to));
        return;
      }
      const lockedHere = [model.name, home.name].filter(locked);
      if (lockedHere.length > 0) {
        plan.lockedFiles.push(...lockedHere.filter((m) => !plan.lockedFiles.includes(m)));
        return;
      }
      plan.rehome.push({ from: model.name, stored, to });
    });
  }
  // A link listed as disagreeing moves nowhere, whichever copy came first.
  plan.rehome = plan.rehome.filter((r) => !disagreeing.has(linkKey(r.to)));
  return plan;
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

/** Whether a stored copy says the same as `home` (already keyed): its meaning, and any role. */
function agrees(copy: Relationship, home: Relationship, modelOf: (name: string) => KeyedModel | null): boolean {
  return sameMeaning(keyedRelationship(copy, modelOf), home) && (!copy.role || !home.role || copy.role === home.role);
}

/**
 * How the move stores a diagram's copy: on its many side, turned round where
 * the keys contradict it (`keyedRelationship`), and a many-to-many — which
 * has no many side — from its lower end, so the order the diagrams are read
 * in never decides its file.
 */
function moveForm(rel: Relationship, modelOf: (name: string) => KeyedModel | null): Relationship {
  const keyed = keyedRelationship(rel, modelOf);
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
): MoveToLibraryPlan {
  const plan: MoveToLibraryPlan = {
    toLibrary: [], removeFromDomains: new Map(), conflicts: [], skippedNoModel: [], turned: [], keptLibrary: [],
    ...planRehome(libraryModels, libraryModel, locked),
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

  // Every diagram copy of each link, however it was drawn (#133).
  const byKey = new Map<string, Array<{ label: string; drawn: Relationship; stored: Relationship }>>();
  for (const domain of domains) {
    for (const drawn of domain.relationships) {
      const key = linkKey(drawn);
      byKey.set(key, [...(byKey.get(key) ?? []), { label: domain.label, drawn, stored: moveForm(drawn, libraryModel) }]);
    }
  }

  for (const [key, uses] of byKey) {
    const sample = uses[0].drawn;
    const ends = [libraryModel(sample.fromModel), libraryModel(sample.toModel)];
    // The library's word on this link: as it will be stored once turned round, else the copy drawn.
    const rehomes = plan.rehome.filter((r) => linkKey(r.to) === key);
    const library = rehomes[0]?.to ?? mergeLibraryRelationships(
      ends.map((m, i) => m ?? { name: i === 0 ? sample.fromModel : sample.toModel, columns: [] }), [],
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
        } else if (contradictsKeys(canonicalRelationship(use.drawn), libraryModel)) {
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
      if (contradictsKeys(canonicalRelationship(use.drawn), libraryModel)) {
        plan.turned.push({ domain: use.label, relationship: use.drawn, to: relationship });
      }
      takeOut(use.label, key);
    }
  }
  return plan;
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
  return {
    ...plan,
    toLibrary: [...plan.toLibrary, { ...definition.relationship, ...(role ? { role } : {}) }],
    removeFromDomains,
    conflicts: plan.conflicts.filter((c) => c !== conflict),
  };
}

/** The model files a settled plan writes, by model name. */
export function moveTargets(plan: Pick<MoveToLibraryPlan, 'toLibrary' | 'rehome'>): string[] {
  return [...new Set([...plan.toLibrary.map((r) => r.fromModel), ...plan.rehome.flatMap((r) => [r.from, r.to.fromModel])])];
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
    // The copy that says the same gains the role — never another copy of the link.
    const index = held.findIndex((r) => sameMeaning(r, rel));
    if (index !== -1) {
      if (!held[index].role && rel.role) {
        model.relationships = (model.relationships ?? []).map((entry, i) => (i === index ? { ...entry, role: rel.role } : entry));
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
      const uses = conflict.definitions.map((d) => `${describeDefinition(d.relationship)} in ${d.domains.join(', ')}`).join('; ');
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
  lines.push(...describeLeftAlone(plan, fileOf));
  if (movesDomains) {
    lines.push('', 'Teammates on an older ERD Studio version will not see relationships stored in the model library until they update.');
  }
  return lines.join('\n').replace(/^\n/, '');
}

/** What the move leaves for the user: copies that disagree, and files it will not rewrite. */
export function describeLeftAlone(
  plan: Pick<MoveToLibraryPlan, 'disagreements' | 'lockedFiles'>,
  fileOf: (model: string) => string = (m) => `logical-models/${m}.yml`,
): string[] {
  const lines: string[] = [];
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
