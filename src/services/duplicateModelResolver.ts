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

import { MODEL_NAME_PATTERN } from '../types/naming';

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
  return candidates.find((c) => MODEL_NAME_PATTERN.test(c) && !taken.has(c)) ?? '';
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

/** Modal text for a plan. */
export function describeDuplicateFix(plan: DuplicateFixPlan, fromLabel: string, toLabel: string): string {
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

  if (Array.isArray(logical.relationships)) {
    for (const rel of logical.relationships as Array<Record<string, unknown>>) {
      if (!rel || typeof rel !== 'object') continue;
      if (rel.fromModel === oldName) rel.fromModel = newName;
      if (rel.toModel === oldName) rel.toModel = newName;
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
