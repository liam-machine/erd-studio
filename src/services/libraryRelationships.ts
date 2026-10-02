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

import { relationshipKey } from '@erd-studio/core';
import type { Relationship, SemanticModel } from '../types/semantic';

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
): boolean {
  return domainFileRelationshipCount === 0 || models.some((m) => (m.relationships?.length ?? 0) > 0);
}

/** The full relationships stored in `model`'s library file. */
export function libraryRelationshipsOf(model: SemanticModel): Relationship[] {
  return (model.relationships ?? []).map((rel) => ({ fromModel: model.name, ...rel }));
}

/** Whether `model`'s library file defines a relationship with these ends. */
export function hasLibraryRelationship(model: SemanticModel, ends: RelationshipEnds): boolean {
  const key = relationshipKey(ends);
  return libraryRelationshipsOf(model).some((rel) => relationshipKey(rel) === key);
}

/**
 * Add or replace a relationship on its from-model (`model.name` must be
 * `rel.fromModel`). Returns false when an identical one is already there.
 */
export function upsertLibraryRelationship(model: SemanticModel, rel: Relationship): boolean {
  const key = relationshipKey(rel);
  const list = model.relationships ?? [];
  const index = list.findIndex((r) => relationshipKey({ fromModel: model.name, ...r }) === key);
  const entry = { fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn, cardinality: rel.cardinality };
  if (index === -1) {
    model.relationships = [...list, entry];
    return true;
  }
  const current = list[index];
  if (current.cardinality === entry.cardinality && current.fromColumn === entry.fromColumn
    && current.toModel === entry.toModel && current.toColumn === entry.toColumn) {
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

/** Remove the relationships with these ends from the library. */
export function removeLibraryRelationships(
  models: readonly SemanticModel[],
  ends: readonly RelationshipEnds[],
): SemanticModel[] {
  const keys = new Set(ends.map(relationshipKey));
  return dropWhere(models, (rel) => keys.has(relationshipKey(rel)));
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
  for (const rel of relationships) {
    const model = modelFor(rel.fromModel);
    if (!model) {
      kept.push(rel);
      continue;
    }
    if (upsertLibraryRelationship(model, rel)) changed.set(model.name, model);
  }
  return { kept, changed: [...changed.values()] };
}

/** One relationship that domain files define in more than one way. */
export interface RelationshipConflict {
  relationship: RelationshipEnds;
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
  /** Defined with different cardinalities: left where they are, for the user to settle. */
  conflicts: RelationshipConflict[];
  /** From-model has no library file (or cannot be read): left in the domain file. */
  skippedNoModel: Relationship[];
}

/**
 * Plan "Move Relationships to Model Library": every relationship in a v5
 * domain file goes to its from-model's library file, once, unless the domain
 * files disagree about its cardinality — those are reported and left alone,
 * never settled by picking one. A relationship the library already defines is
 * taken out of the domain file; its cardinality is the library's, which every
 * domain already shows.
 */
export function planMoveToLibrary(
  domains: ReadonlyArray<{ label: string; relationships: readonly Relationship[] }>,
  libraryModel: (name: string) => SemanticModel | null,
): MoveToLibraryPlan {
  const byKey = new Map<string, { rel: Relationship; uses: Array<{ label: string; cardinality: Relationship['cardinality'] }> }>();
  for (const domain of domains) {
    for (const rel of domain.relationships) {
      const key = relationshipKey(rel);
      const entry = byKey.get(key) ?? { rel, uses: [] };
      entry.uses.push({ label: domain.label, cardinality: rel.cardinality });
      byKey.set(key, entry);
    }
  }

  const plan: MoveToLibraryPlan = { toLibrary: [], removeFromDomains: new Map(), conflicts: [], skippedNoModel: [] };
  for (const [key, { rel, uses }] of byKey) {
    const model = libraryModel(rel.fromModel);
    if (!model) {
      plan.skippedNoModel.push(rel);
      continue;
    }
    const alreadyShared = hasLibraryRelationship(model, rel);
    const cardinalities = [...new Set(uses.map((u) => u.cardinality))];
    if (!alreadyShared && cardinalities.length > 1) {
      plan.conflicts.push({
        relationship: { fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn },
        definitions: cardinalities.map((cardinality) => ({
          cardinality,
          domains: [...new Set(uses.filter((u) => u.cardinality === cardinality).map((u) => u.label))],
        })),
      });
      continue;
    }
    if (!alreadyShared) {
      plan.toLibrary.push({ ...rel, fromModel: model.name });
    }
    for (const use of uses) {
      const keys = plan.removeFromDomains.get(use.label) ?? new Set<string>();
      keys.add(key);
      plan.removeFromDomains.set(use.label, keys);
    }
  }
  return plan;
}

const describeEnds = (rel: RelationshipEnds): string =>
  `${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn}`;

/** The modal's detail for "Move Relationships to Model Library". */
export function describeMovePlan(plan: MoveToLibraryPlan): string {
  const lines: string[] = [];
  const domainCount = plan.removeFromDomains.size;
  if (plan.toLibrary.length > 0 || domainCount > 0) {
    lines.push(
      `${plan.toLibrary.length} relationship${plan.toLibrary.length === 1 ? '' : 's'} will be stored once, in the ` +
      `from-model's file under logical-models/, and taken out of ${domainCount} domain file${domainCount === 1 ? '' : 's'}. ` +
      'Every diagram that holds both models then draws the same relationship, and a change made in one shows in all of them.',
    );
  }
  if (plan.conflicts.length > 0) {
    lines.push(
      '',
      `${plan.conflicts.length} relationship${plan.conflicts.length === 1 ? ' is' : 's are'} defined differently in different diagrams ` +
      'and will stay where they are. Change one on the canvas to the cardinality you want — that makes it the shared one:',
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
      `${plan.skippedNoModel.length} relationship${plan.skippedNoModel.length === 1 ? '' : 's'} start at a model with no ` +
      'readable file in logical-models/ and will stay in their domain files.',
    );
  }
  lines.push('', 'Teammates on an ERD Studio version before this one will not see relationships stored in the model library.');
  return lines.join('\n');
}
