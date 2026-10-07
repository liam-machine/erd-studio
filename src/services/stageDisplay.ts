/**
 * Logical stage → DisplayDomain, the pure core.
 *
 * A thin wrapper over `@erd-studio/core`'s `toDisplayDomain` — the one
 * implementation the canvas (`SemanticEditorProvider.buildDisplayDomain`) also
 * uses — without the canvas-only extras (templates, add-model pickers, layer
 * config). The discrepancy comparison only reads the core, so
 * `computeDomainDiff` (`stageDiff.ts`), shared by the canvas and the
 * `erd-studio` CLI, builds the logical side here and both see exactly the same
 * domain.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import { toDisplayDomain } from '@erd-studio/core';

import type { DisplayColumn, DisplayDomain } from '../types/display';
import type { SemanticDomain, ViewConfig } from '../types/semantic';

/**
 * Convert a logical `SemanticDomain` to a `DisplayDomain`.
 *
 * Key flags are coerced to booleans (`isPrimaryKey === true`), and a column is
 * a foreign key when it says so OR when it is the `fromColumn` of one of the
 * domain's relationships. `viewConfig` is passed separately because it lives
 * at the root of the unified domain file, not in the stage section.
 */
export function buildLogicalDisplayDomain(
  domain: SemanticDomain,
  viewConfig: ViewConfig,
  stubColumns?: string[],
): DisplayDomain {
  return toDisplayDomain(domain, {
    viewConfig,
    stubColumns,
    layerConfig: undefined,
    readOnly: domain.stage === 'physical',
  });
}

/** What dbt's tests say about one column (`DisplayColumn.dbtEvidence`). */
export type DbtColumnEvidence = NonNullable<DisplayColumn['dbtEvidence']>;

/** The test declarations one dbt source (the schema yml, or the manifest) carries. */
export interface DbtTestSource {
  uniqueColumns?: ReadonlyMap<string, ReadonlySet<string>>;
  compositeUniqueGroups?: ReadonlyMap<string, readonly (readonly string[])[]>;
  relationshipTests?: ReadonlyArray<{ fromModel: string; fromColumn: string }>;
}

/**
 * Per model and column (both lowercased), what dbt's tests say about it —
 * the evidence `resolveDirection` weighs beside the model's own keys (issue
 * #133, R7): a `unique` test on the column alone, membership of a
 * `unique_combination_of_columns` group, and a `relationships` test leaving
 * it. Sources are merged (the yml and the manifest declare the same tests;
 * either one is enough). Only what a test says is recorded — a column with no
 * test gets no entry, never `unique: false`.
 */
export function buildDbtEvidenceIndex(sources: ReadonlyArray<DbtTestSource | undefined>): Map<string, Map<string, DbtColumnEvidence>> {
  const index = new Map<string, Map<string, DbtColumnEvidence>>();
  const at = (model: string, column: string): DbtColumnEvidence => {
    const m = model.toLowerCase();
    if (!index.has(m)) index.set(m, new Map());
    const columns = index.get(m)!;
    const c = column.toLowerCase();
    if (!columns.has(c)) columns.set(c, {});
    return columns.get(c)!;
  };
  for (const source of sources) {
    if (!source) continue;
    for (const [model, columns] of source.uniqueColumns ?? []) {
      for (const column of columns) at(model, column).unique = true;
    }
    for (const [model, groups] of source.compositeUniqueGroups ?? []) {
      for (const group of groups) {
        if (group.length < 2) continue;
        for (const column of group) at(model, column).inCompositeUnique = true;
      }
    }
    for (const test of source.relationshipTests ?? []) {
      at(test.fromModel, test.fromColumn).relationshipsTest = true;
    }
  }
  return index;
}

/**
 * The editable logical payload with `dbtEvidence` on every column dbt's tests
 * say something about. Editor-only: the CLI's `diff` and the viewer never
 * carry it. Returns `display` itself when there is nothing to add.
 */
export function withDbtEvidence(
  display: DisplayDomain,
  index: ReadonlyMap<string, ReadonlyMap<string, DbtColumnEvidence>>,
): DisplayDomain {
  if (index.size === 0) return display;
  let touched = false;
  const models = display.models.map((model) => {
    const columns = index.get(model.name.toLowerCase());
    if (!columns) return model;
    let changed = false;
    const next = model.columns.map((col) => {
      const evidence = columns.get(col.name.toLowerCase());
      if (!evidence || Object.keys(evidence).length === 0) return col;
      changed = true;
      return { ...col, dbtEvidence: { ...evidence } };
    });
    if (!changed) return model;
    touched = true;
    return { ...model, columns: next };
  });
  return touched ? { ...display, models } : display;
}
