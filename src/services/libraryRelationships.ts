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

import { canonicalRelationship, linkKey, relationshipKey, reverseRelationship, sameLink } from '@erd-studio/core';
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

/**
 * Send relationships a canvas or Draw from dbt would add to a domain file to
 * their from-models instead. `newModels` are models about to be created (they
 * take their relationships directly); any other from-model is looked up with
 * `libraryModel`, which must return a copy the caller may change. A
 * relationship whose from-model has neither stays in `kept`, for the domain
 * file. `changed` lists every model to save, new ones included only when they
 * gained a relationship.
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
    const fresh = newModels.find((m) => m.name === name);
    if (fresh) return fresh;
    if (!loaded.has(name)) loaded.set(name, libraryModel(name));
    return loaded.get(name) ?? null;
  };
  for (const drawn of relationships) {
    const rel = canonicalRelationship(drawn);
    const model = modelFor(rel.fromModel);
    if (!model) {
      kept.push(drawn);
      continue;
    }
    // Already stored the other way round (by hand, or before #133): that
    // entry already draws this link, so a second would only duplicate it.
    const other = modelFor(rel.toModel);
    if (other && libraryRelationshipsOf(other).some((r) => sameLink(r, rel))) continue;
    if (upsertLibraryRelationship(model, rel)) changed.set(model.name, model);
  }
  return { kept, changed: [...changed.values()] };
}

/** One relationship that domain files define in more than one way. */
export interface RelationshipConflict {
  /** Its ends, with the `role` a domain file gave it, if any. */
  relationship: RelationshipEnds & { role?: string };
  /** Each cardinality in use, with the domain files that use it. */
  definitions: Array<{ cardinality: Relationship['cardinality']; domains: string[] }>;
}

/** What moving domain-file relationships into the library would do. */
export interface MoveToLibraryPlan {
  /** Relationships to add to their from-model, one per set of ends. */
  toLibrary: Relationship[];
  /**
   * Per domain file, the entries to take out of `logical.relationships`
   * (by ends) — every entry whose relationship moves.
   */
  removeFromDomains: Map<string, Set<string>>;
  /** Defined with different cardinalities: the user picks one (`resolveConflict`) or leaves them in place. */
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
 * side, and a `many-to-one` that 1.6.7 saved backwards from a dimension —
 * one leaving its model's whole primary (or natural) key for a column that is
 * not the target's whole key. Nothing else is guessed at. Entries whose many
 * side has no library file stay where they are, and so does an entry whose
 * many side already holds a copy that disagrees, or whose files are `locked`
 * (see `MoveToLibraryPlan.lockedFiles`).
 */
export function planRehome(
  libraryModels: readonly SemanticModel[],
  libraryModel: (name: string) => SemanticModel | null,
  locked: (model: string) => boolean = () => false,
): Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> {
  const plan: Pick<MoveToLibraryPlan, 'rehome' | 'disagreements' | 'lockedFiles'> = { rehome: [], disagreements: [], lockedFiles: [] };
  const disagreeing = new Set<string>();
  for (const model of libraryModels) {
    for (const stored of libraryRelationshipsOf(model)) {
      const target = libraryModel(stored.toModel);
      const backwards = stored.cardinality === 'many-to-one' && target !== null
        && isWholeKey(model, stored.fromColumn) && !isWholeKey(target, stored.toColumn);
      const to = backwards ? { ...reverseRelationship(stored), cardinality: 'many-to-one' as const } : canonicalRelationship(stored);
      if (to === stored) continue;
      const home = libraryModel(to.fromModel);
      if (!home) continue;
      const held = libraryRelationshipsOf(home).find((r) => sameLink(r, to) && !sameEntry(r, stored));
      if (held && !agrees(held, to)) {
        if (!disagreeing.has(linkKey(to))) plan.disagreements.push({ stored, held });
        disagreeing.add(linkKey(to));
        continue;
      }
      const lockedHere = [model.name, home.name].filter(locked);
      if (lockedHere.length > 0) {
        plan.lockedFiles.push(...lockedHere.filter((m) => !plan.lockedFiles.includes(m)));
        continue;
      }
      plan.rehome.push({ from: model.name, stored, to });
    }
  }
  return plan;
}

/** Whether `column` is `model`'s whole primary key or whole natural key. */
function isWholeKey(model: SemanticModel, column: string): boolean {
  return (['isPrimaryKey', 'isNaturalKey'] as const).some((flag) => {
    const keys = (model.columns ?? []).filter((c) => c[flag]);
    return keys.length === 1 && same(keys[0].name, column);
  });
}

/** Whether two entries are the same stored entry (same ends, cardinality and role). */
function sameEntry(a: Relationship, b: Relationship): boolean {
  return relationshipKey(a) === relationshipKey(b) && a.cardinality === b.cardinality && a.role === b.role;
}

/** Whether a copy already stored says the same as `canonical`: ends, cardinality, and any role. */
function agrees(copy: Relationship, canonical: Relationship): boolean {
  const c = canonicalRelationship(copy);
  return relationshipKey(c) === relationshipKey(canonical) && c.cardinality === canonical.cardinality
    && (!c.role || !canonical.role || c.role === canonical.role);
}

/**
 * Plan "Move Relationships to Model Library": every relationship in a v5
 * domain file goes to its from-model's library file, once, unless the domain
 * files disagree about its cardinality — those are `conflicts`, which only the
 * user settles (`resolveConflict` with their pick), never this code. A relationship the library already defines is
 * taken out of the domain file; its cardinality is the library's, which every
 * domain already shows.
 */
export function planMoveToLibrary(
  domains: ReadonlyArray<{ label: string; relationships: readonly Relationship[] }>,
  libraryModel: (name: string) => SemanticModel | null,
  libraryModels: readonly SemanticModel[] = [],
  locked: (model: string) => boolean = () => false,
): MoveToLibraryPlan {
  const byKey = new Map<string, { rel: Relationship; uses: Array<{ label: string; cardinality: Relationship['cardinality'] }> }>();
  for (const domain of domains) {
    for (const rel of domain.relationships) {
      const key = relationshipKey(rel);
      const entry = byKey.get(key) ?? { rel, uses: [] };
      // The first role any domain gives it is the one kept.
      if (!entry.rel.role && rel.role) entry.rel = { ...entry.rel, role: rel.role };
      entry.uses.push({ label: domain.label, cardinality: rel.cardinality });
      byKey.set(key, entry);
    }
  }

  const plan: MoveToLibraryPlan = {
    toLibrary: [], removeFromDomains: new Map(), conflicts: [], skippedNoModel: [],
    ...planRehome(libraryModels, libraryModel, locked),
  };
  // A relationship bound for a locked file stays in its domain files.
  const isLocked = (...names: string[]): boolean => {
    const hit = names.filter(locked);
    for (const name of hit) if (!plan.lockedFiles.includes(name)) plan.lockedFiles.push(name);
    return hit.length > 0;
  };
  for (const [key, { rel, uses }] of byKey) {
    // Stored on its many side (#133); a conflict is turned round once the user picks.
    const stored = canonicalRelationship(rel);
    const model = libraryModel(stored.fromModel);
    if (!model) {
      plan.skippedNoModel.push(rel);
      continue;
    }
    const other = libraryModel(stored.toModel);
    const shared = findLibraryColumnPair(other ? [model, other] : [model], stored);
    const alreadyShared = shared !== undefined;
    const cardinalities = [...new Set(uses.map((u) => u.cardinality))];
    if (!alreadyShared && cardinalities.length > 1) {
      // Settled at either end, depending on the cardinality picked.
      if (isLocked(stored.fromModel, stored.toModel)) continue;
      plan.conflicts.push({
        relationship: {
          fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn,
          ...(rel.role ? { role: rel.role } : {}),
        },
        definitions: cardinalities.map((cardinality) => ({
          cardinality,
          domains: [...new Set(uses.filter((u) => u.cardinality === cardinality).map((u) => u.label))],
        })),
      });
      continue;
    }
    if (!alreadyShared) {
      if (isLocked(model.name)) continue;
      plan.toLibrary.push({ ...stored, fromModel: model.name });
    } else if (stored.role) {
      // The library already draws it but has no role: the domain's label is
      // the only copy of it, and the domain entry is about to go.
      if (shared && !shared.role) {
        if (isLocked(shared.fromModel)) continue;
        plan.toLibrary.push({ ...shared, role: stored.role });
      }
    }
    for (const use of uses) {
      const keys = plan.removeFromDomains.get(use.label) ?? new Set<string>();
      keys.add(key);
      plan.removeFromDomains.set(use.label, keys);
    }
  }
  return plan;
}

/**
 * Settle a conflict the way the user picked: the relationship goes to the
 * library with `cardinality`, and every domain file's copy is taken out, so
 * each diagram now draws the one definition. Returns the plan unchanged for a
 * conflict it does not hold.
 */
export function resolveConflict(
  plan: MoveToLibraryPlan,
  conflict: RelationshipConflict,
  cardinality: Relationship['cardinality'],
): MoveToLibraryPlan {
  if (!plan.conflicts.includes(conflict)) return plan;
  const key = relationshipKey(conflict.relationship);
  const removeFromDomains = new Map([...plan.removeFromDomains].map(([label, keys]) => [label, new Set(keys)]));
  for (const domain of conflict.definitions.flatMap((d) => d.domains)) {
    const keys = removeFromDomains.get(domain) ?? new Set<string>();
    keys.add(key);
    removeFromDomains.set(domain, keys);
  }
  return {
    ...plan,
    toLibrary: [...plan.toLibrary, canonicalRelationship({ ...conflict.relationship, cardinality })],
    removeFromDomains,
    conflicts: plan.conflicts.filter((c) => c !== conflict),
  };
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

  // Where each relationship will live — a conflict too, once its cardinality is picked.
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
      'diagrams. Next you pick the cardinality to keep for each — or leave it as it is in each diagram for now:',
    );
    for (const conflict of plan.conflicts.slice(0, 5)) {
      const uses = conflict.definitions.map((d) => `${d.cardinality} in ${d.domains.join(', ')}`).join('; ');
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
  if (plan.rehome.length > 0) {
    lines.push(
      '',
      `Turned round: ${plural(plan.rehome.length, 'relationship is', 'relationships are')} stored in the file of the ` +
      'model it points at. Each moves to the file of the model holding the foreign key, as many-to-one, so adding a ' +
      'new fact never means editing its dimensions. The diagrams draw the same lines:',
    );
    for (const { stored, to } of plan.rehome.slice(0, 5)) {
      lines.push(`• ${describeEnds(stored)} → ${fileOf(to.fromModel)}`);
    }
    if (plan.rehome.length > 5) lines.push(`• …and ${plan.rehome.length - 5} more`);
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
