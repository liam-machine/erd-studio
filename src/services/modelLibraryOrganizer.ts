/**
 * Plans "Organise Model Library by Layer": which top-level
 * logical-models/{name}.yml files can move into a layer folder
 * (logical-models/{layer}/{name}.yml), and which have to stay where they are.
 *
 * Pure — no `vscode`, no `fs` — so the decision is unit-tested on its own and
 * the command only has to turn `moves` into one WorkspaceEdit.
 *
 * A model moves only when every domain that references it sits in ONE layer:
 * a conformed dimension used by silver and gold domains belongs to neither
 * folder, and an unused model has no layer to go to. Files already in a
 * folder are never touched — that placement was someone's decision.
 */

import type { ModelFileEntry } from './logicalModelService';

/** One domain's layer and the model names it references. */
export interface DomainModelUsage {
  readonly layer: string;
  readonly modelNames: readonly string[];
}

export interface ModelMove {
  readonly name: string;
  readonly layer: string;
  readonly from: string;
  readonly to: string;
}

export interface OrganizePlan {
  /** Top-level files that move into their layer's folder. */
  readonly moves: ModelMove[];
  /** Top-level models referenced from more than one layer, with those layers. */
  readonly shared: { name: string; layers: string[] }[];
  /** Top-level models no domain references. */
  readonly unused: string[];
  /** Top-level models whose target folder already holds a file of that name. */
  readonly conflicts: { name: string; layer: string }[];
}

/**
 * Build the plan. `targetPath(name, layer)` returns where a moved file goes,
 * or null when `layer` cannot be a folder name (the move is then skipped as
 * if the model were shared — nowhere safe to put it).
 */
export function planOrganizeByLayer(
  entries: readonly ModelFileEntry[],
  usage: readonly DomainModelUsage[],
  targetPath: (name: string, layer: string) => string | null,
): OrganizePlan {
  const layersByModel = new Map<string, Set<string>>();
  for (const domain of usage) {
    for (const name of domain.modelNames) {
      const layers = layersByModel.get(name) ?? new Set<string>();
      layers.add(domain.layer);
      layersByModel.set(name, layers);
    }
  }

  const taken = new Set(entries.filter(e => e.folder !== '').map(e => `${e.folder}/${e.name}`));
  const moves: ModelMove[] = [];
  const shared: { name: string; layers: string[] }[] = [];
  const unused: string[] = [];
  const conflicts: { name: string; layer: string }[] = [];

  const topLevel = entries
    .filter(e => e.folder === '' && !e.shadowedBy)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of topLevel) {
    const layers = [...(layersByModel.get(entry.name) ?? [])].sort();
    if (layers.length === 0) {
      unused.push(entry.name);
      continue;
    }
    if (layers.length > 1) {
      shared.push({ name: entry.name, layers });
      continue;
    }
    const layer = layers[0];
    const to = targetPath(entry.name, layer);
    if (to === null) {
      shared.push({ name: entry.name, layers });
      continue;
    }
    if (taken.has(`${layer}/${entry.name}`)) {
      conflicts.push({ name: entry.name, layer });
      continue;
    }
    moves.push({ name: entry.name, layer, from: entry.filePath, to });
  }

  return { moves, shared, unused, conflicts };
}

/** Up to three names, then "and N more" — enough to recognise, short enough for a dialog. */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown;
}

/** One-paragraph summary of a plan for the confirmation dialog. */
export function describeOrganizePlan(plan: OrganizePlan): string {
  const lines: string[] = [];
  const perLayer = new Map<string, number>();
  for (const move of plan.moves) {
    perLayer.set(move.layer, (perLayer.get(move.layer) ?? 0) + 1);
  }
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (plan.moves.length > 0) {
    const parts = [...perLayer.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([layer, n]) => `${n} → ${layer}/`);
    lines.push(`Move ${plural(plan.moves.length, 'model')} into layer folders (${parts.join(', ')}).`);
  }
  const staying: string[] = [];
  if (plan.shared.length > 0) {
    staying.push(`${plural(plan.shared.length, 'model')} used by more than one layer (${nameList(plan.shared.map(s => s.name))})`);
  }
  if (plan.unused.length > 0) staying.push(`${plural(plan.unused.length, 'unused model')} (${nameList(plan.unused)})`);
  if (plan.conflicts.length > 0) {
    staying.push(
      `${plural(plan.conflicts.length, 'model')} whose layer folder already has a file of that name (${nameList(plan.conflicts.map(c => c.name))})`,
    );
  }
  if (staying.length > 0) {
    lines.push(`Staying at the top of logical-models/: ${staying.join('; ')}.`);
  }
  lines.push('Domain files reference models by name, so no domain file changes.');
  return lines.join('\n\n');
}
