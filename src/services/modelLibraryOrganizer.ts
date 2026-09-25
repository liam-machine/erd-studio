/**
 * Plans "Organise Model Library by Layer": which logical-models files move
 * into (or between) layer folders — logical-models/{layer}/{name}.yml — and
 * which have to stay where they are.
 *
 * Pure — no `vscode`, no `fs` — so the decision is unit-tested on its own and
 * the command only has to turn `moves` into one WorkspaceEdit.
 *
 * A model moves only when every domain that references it sits in ONE layer:
 * a conformed dimension used by silver and gold domains belongs to neither
 * folder, and an unused model has no layer to go to. That covers two cases:
 * - a top-level file moves into its layer's folder;
 * - a file in ANOTHER layer's folder moves to the right one (its domains
 *   changed layer since it was created), so re-running the command always
 *   tidies the library.
 * A file in a layer folder whose model is now shared or unused is left where
 * it is — it is not wrong, just no longer specific. Files in a folder that is
 * not a layer (a hand-made `Staging/`, or a layer id since removed from
 * layers.json) are never touched: that placement was someone's decision, and
 * the plan reports them instead.
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
  /** The layer folder the file is moving out of; absent for a top-level file. */
  readonly fromFolder?: string;
}

export interface OrganizePlan {
  /** Files that move into their layer's folder (from the top level or another layer's folder). */
  readonly moves: ModelMove[];
  /** Top-level models referenced from more than one layer, with those layers. */
  readonly shared: { name: string; layers: string[] }[];
  /** Top-level models no domain references. */
  readonly unused: string[];
  /** Models whose target folder already holds a file of that name. */
  readonly conflicts: { name: string; layer: string }[];
  /** Folders that are not a configured layer; their files are left alone. */
  readonly otherFolders: { folder: string; count: number }[];
}

/**
 * Build the plan. `layerIds` are the configured layers (layers.json);
 * `targetPath(name, layer)` returns where a moved file goes, or null when
 * `layer` cannot be a folder name (the model then stays put, as if shared).
 */
export function planOrganizeByLayer(
  entries: readonly ModelFileEntry[],
  usage: readonly DomainModelUsage[],
  targetPath: (name: string, layer: string) => string | null,
  layerIds: ReadonlySet<string> = new Set(usage.map(u => u.layer)),
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
  const otherFolderCounts = new Map<string, number>();

  const candidates = entries
    .filter(e => !e.shadowedBy)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of candidates) {
    const inLayerFolder = entry.folder !== '' && layerIds.has(entry.folder);
    if (entry.folder !== '' && !inLayerFolder) {
      otherFolderCounts.set(entry.folder, (otherFolderCounts.get(entry.folder) ?? 0) + 1);
      continue;
    }
    const layers = [...(layersByModel.get(entry.name) ?? [])].sort();
    if (layers.length !== 1) {
      // Only a top-level file is reported: one in a layer folder stays put quietly.
      if (!inLayerFolder) {
        if (layers.length === 0) unused.push(entry.name);
        else shared.push({ name: entry.name, layers });
      }
      continue;
    }
    const layer = layers[0];
    if (entry.folder === layer) continue; // already in the right place
    const to = targetPath(entry.name, layer);
    if (to === null) {
      if (!inLayerFolder) shared.push({ name: entry.name, layers });
      continue;
    }
    if (taken.has(`${layer}/${entry.name}`)) {
      conflicts.push({ name: entry.name, layer });
      continue;
    }
    moves.push({
      name: entry.name,
      layer,
      from: entry.filePath,
      to,
      ...(inLayerFolder ? { fromFolder: entry.folder } : {}),
    });
  }

  const otherFolders = [...otherFolderCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, count]) => ({ folder, count }));
  return { moves, shared, unused, conflicts, otherFolders };
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
    const relocated = plan.moves.filter(m => m.fromFolder);
    if (relocated.length > 0) {
      const examples = relocated.slice(0, 3).map(m => `${m.name}: ${m.fromFolder}/ → ${m.layer}/`);
      const more = relocated.length > 3 ? ` and ${relocated.length - 3} more` : '';
      lines.push(
        `${relocated.length === 1 ? 'One is' : `${relocated.length} are`} in another layer's folder, ` +
        `because the domains that use ${relocated.length === 1 ? 'it' : 'them'} are now in a different layer ` +
        `(${examples.join('; ')}${more}).`,
      );
    }
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
  if (plan.otherFolders.length > 0) {
    const folders = plan.otherFolders.map(f => `${f.folder}/ (${f.count})`).join(', ');
    lines.push(`Left alone: folders that are not a layer in layers.json — ${folders}.`);
  }
  lines.push('Domain files reference models by name, so no domain file changes.');
  return lines.join('\n\n');
}
