/**
 * Duplicate model files — two files in the library with the same name
 * (issue #76 follow-up).
 *
 * Layer folders make it natural to create `silver/date.yml` and
 * `gold/date.yml`, but a model's name is its identity: domains, relationships
 * and positions all refer to `date`, and dbt itself refuses two models called
 * `date`. So only one file can win (see `LogicalModelService.listModelFiles`)
 * and the other is ignored — which used to mean a gold canvas silently showed
 * the silver table's columns.
 *
 * The fix follows dbt's own pattern: the ignored copy becomes its own model,
 * `gold_date`, whose `alias` keeps the table name `date`. The domains of that
 * copy's layer — the ones that meant it — are repointed at the new name.
 *
 * Everything here is pure (no `vscode`, no fs) so it can be unit-tested; the
 * command in extension.ts builds the WorkspaceEdit from the plan.
 */

import { MODEL_NAME_PATTERN, sameName } from '../types/naming';

/** A domain file that references the duplicated name. */
export interface DomainReference {
  filePath: string;
  domain: string;
  layer: string;
}

/** What "Give This Copy Its Own Name" will do. */
export interface DuplicateFixPlan {
  /** The name both files use (`date`). */
  name: string;
  /** Folder of the ignored copy (`gold`); `''` at the top level. */
  folder: string;
  /** The model name the ignored copy gets (`gold_date`). */
  newName: string;
  /** The alias it gets: the old name, so the table is still called `date`. */
  alias: string;
  /** Domains to repoint from `name` to `newName`: those in the copy's layer. */
  repoint: DomainReference[];
  /** Domains that keep using the winning file, named so the dialog can say so. */
  keep: DomainReference[];
}

/**
 * The name the ignored copy is offered: `{folder}_{name}`, the convention dbt
 * projects use for a table that exists in more than one layer. Returns '' when
 * no valid, unused name can be made (the caller then asks the user).
 */
export function suggestDuplicateName(name: string, folder: string, taken: ReadonlySet<string>): string {
  const prefix = folder.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const base = prefix ? `${prefix}_${name}` : `${name}_copy`;
  const candidates = [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${base}_${n}`)];
  const isTaken = (c: string) => taken.has(c) || [...taken].some((t) => sameName(t, c));
  return candidates.find((c) => MODEL_NAME_PATTERN.test(c) && !isTaken(c)) ?? '';
}

/**
 * Plan the fix for the ignored copy of `name` in `folder`. Domains in the
 * copy's layer are repointed; every other domain keeps the winning file.
 */
export function planDuplicateFix(
  name: string,
  folder: string,
  newName: string,
  existingAlias: string | undefined,
  references: readonly DomainReference[],
): DuplicateFixPlan {
  const repoint = references.filter((r) => folder !== '' && r.layer === folder);
  const keep = references.filter((r) => !repoint.includes(r));
  return { name, folder, newName, alias: existingAlias || name, repoint, keep };
}

/** A readable model file in the library, as the duplicate fix sees its relationships. */
export interface LibraryHolder {
  name: string;
  /** Sub-folder under logical-models/ (`''` at the top level). */
  folder: string;
  relationships: ReadonlyArray<{ fromColumn: string; toModel: string; toColumn: string }>;
}

/** What the fix does to relationships kept in the model library (#133 review 8). */
export interface LibraryRepointPlan {
  /**
   * Models in the copy's folder whose entries point at the duplicated name,
   * shown by a repointed domain: those entries are repointed to the new name,
   * as that domain's own relationships are. By position in `relationships`.
   */
  repoint: Array<{ model: string; indexes: number[] }>;
  /**
   * Entries a repointed domain draws today and will no longer draw: their
   * model is in another folder, so which copy they mean is not known, and
   * they are left as they are — named so the dialog can say so.
   */
  undrawn: Array<{
    model: string;
    fromColumn: string;
    toColumn: string;
    domains: string[];
    /**
     * Domains that keep using the winning file and also show the entry's
     * model: they draw it today, so it is left pointing at the old name rather
     * than repointed out from under them (#133 review 8).
     */
    stillDrawnIn?: string[];
  }>;
}

/**
 * Library relationships the fix affects. A domain draws a library entry only
 * when it shows both models, so once a repointed domain shows `newName`
 * instead of `name`, an entry pointing at `name` would silently stop being
 * drawn there. An entry held by a model in the copy's own folder means the
 * copy (the same layer) and is repointed with it; any other is listed.
 * `repointed` is each repointed domain's label and model list (before the fix).
 */
export function planLibraryRepoint(
  plan: DuplicateFixPlan,
  holders: readonly LibraryHolder[],
  repointed: ReadonlyArray<{ label: string; models: readonly string[] }>,
  /**
   * Each kept domain's label and model list (`plan.keep`). One that shows a
   * holder draws its entries to the old name today; repointing them would
   * silently take the line off that diagram, so they are left and named.
   */
  kept: ReadonlyArray<{ label: string; models: readonly string[] }> = [],
): LibraryRepointPlan {
  const result: LibraryRepointPlan = { repoint: [], undrawn: [] };
  for (const holder of holders) {
    if (sameName(holder.name, plan.name)) continue;
    const indexes = holder.relationships
      .map((rel, i) => (sameName(rel.toModel, plan.name) ? i : -1))
      .filter((i) => i !== -1);
    if (indexes.length === 0) continue;
    const shows = (d: { models: readonly string[] }): boolean => d.models.some((m) => sameName(m, holder.name));
    const shownIn = repointed.filter(shows).map((d) => d.label);
    if (shownIn.length === 0) continue;
    const stillDrawnIn = kept.filter((d) => shows(d) && d.models.some((m) => sameName(m, plan.name))).map((d) => d.label);
    if (plan.folder !== '' && holder.folder === plan.folder && stillDrawnIn.length === 0) {
      result.repoint.push({ model: holder.name, indexes });
      continue;
    }
    for (const i of indexes) {
      const rel = holder.relationships[i];
      result.undrawn.push({
        model: holder.name, fromColumn: rel.fromColumn, toColumn: rel.toColumn, domains: shownIn,
        ...(stillDrawnIn.length > 0 ? { stillDrawnIn } : {}),
      });
    }
  }
  return result;
}

/** Modal text for a plan. */
export function describeDuplicateFix(
  plan: DuplicateFixPlan,
  fromLabel: string,
  toLabel: string,
  library?: LibraryRepointPlan,
  holders: readonly LibraryHolder[] = [],
): string {
  const lines = [
    `${fromLabel} → ${toLabel}`,
    `The model becomes "${plan.newName}" with alias: ${plan.alias}, so dbt still builds a table called ${plan.alias}.`,
  ];
  if (plan.repoint.length > 0) {
    lines.push('', `Repointed to ${plan.newName} (${plan.folder} domains):`);
    lines.push(...plan.repoint.map((r) => `  • ${r.layer}/${r.domain}`));
  } else {
    lines.push('', `No domain uses this copy yet: add ${plan.newName} to a domain from "Add Existing Model".`);
  }
  if (plan.keep.length > 0) {
    lines.push('', `Still using "${plan.name}":`);
    lines.push(...plan.keep.map((r) => `  • ${r.layer}/${r.domain}`));
  }
  if (library && library.repoint.length > 0) {
    lines.push('', `Relationships in the model library repointed to ${plan.newName}:`);
    for (const { model, indexes } of library.repoint) {
      const holder = holders.find((h) => h.name === model);
      for (const i of indexes) {
        const rel = holder?.relationships[i];
        if (rel) lines.push(`  • ${model}.${rel.fromColumn} → ${plan.newName}.${rel.toColumn}`);
      }
    }
  }
  if (library && library.undrawn.length > 0) {
    lines.push('', `No longer drawn in the repointed domains (they point at "${plan.name}", left as they are):`);
    lines.push(...library.undrawn.map((u) => `  • ${u.model}.${u.fromColumn} → ${plan.name}.${u.toColumn} (${u.domains.join(', ')})` +
      (u.stillDrawnIn ? ` — kept because ${u.stillDrawnIn.join(', ')} still ${u.stillDrawnIn.length === 1 ? 'draws' : 'draw'} it` : '')));
  }
  return lines.join('\n');
}

/**
 * Repoint a parsed v5 domain document from `oldName` to `newName`: the model
 * list, both ends of every relationship, the canvas position, annotation links
 * and the stub-columns list. Mutates `doc`; returns whether anything changed.
 * A document whose `logical.models` is not a list of names (v4 inline models)
 * is left alone — those domains carry their own model bodies.
 */
export function repointDomainModel(doc: Record<string, unknown>, oldName: string, newName: string): boolean {
  const logical = doc.logical as Record<string, unknown> | undefined;
  if (!logical || !Array.isArray(logical.models) || !logical.models.every((m) => typeof m === 'string')) {
    return false;
  }
  const models = logical.models as string[];
  const idx = models.indexOf(oldName);
  if (idx === -1) return false;
  models[idx] = newName;

  // Relationship ends name the model in any case (#133, D7): `Date` and
  // `date` are one model, so an end spelled either way is repointed. Ends
  // that are not text are left exactly as written.
  const isOld = (end: unknown): boolean => typeof end === 'string' && sameName(end, oldName);
  if (Array.isArray(logical.relationships)) {
    for (const rel of logical.relationships as Array<Record<string, unknown>>) {
      if (!rel || typeof rel !== 'object') continue;
      if (isOld(rel.fromModel)) rel.fromModel = newName;
      if (isOld(rel.toModel)) rel.toModel = newName;
    }
  }

  const viewConfig = doc.viewConfig as Record<string, unknown> | undefined;
  const positions = viewConfig?.positions as Record<string, unknown> | undefined;
  if (positions && typeof positions === 'object' && oldName in positions && !(newName in positions)) {
    positions[newName] = positions[oldName];
    delete positions[oldName];
  }
  if (Array.isArray(viewConfig?.annotations)) {
    for (const note of viewConfig.annotations as Array<Record<string, unknown>>) {
      if (note && typeof note === 'object' && note.linkedModel === oldName) note.linkedModel = newName;
    }
  }

  if (Array.isArray(doc.stubColumns)) {
    doc.stubColumns = (doc.stubColumns as unknown[]).map((s) => (s === oldName ? newName : s));
  }
  return true;
}
