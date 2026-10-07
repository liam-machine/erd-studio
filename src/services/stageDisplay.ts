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
import { sameName } from '../types/naming';

/**
 * Convert a logical `SemanticDomain` to a `DisplayDomain`.
 *
 * Key flags are coerced to booleans (`isPrimaryKey === true`), and a column is
 * a foreign key when it says so OR when it is the `fromColumn` of one of the
 * domain's relationships. Relationships the diagram does not draw (REL003, an
 * end outside the domain) are left out, so a comparison never reports them. `viewConfig` is passed separately because it lives
 * at the root of the unified domain file, not in the stage section.
 */
export function buildLogicalDisplayDomain(
  domain: SemanticDomain,
  viewConfig: ViewConfig,
  stubColumns?: string[],
): DisplayDomain {
  const display = toDisplayDomain(domain, {
    viewConfig,
    stubColumns,
    layerConfig: undefined,
    readOnly: domain.stage === 'physical',
  });
  // A domain-file relationship to a model the domain does not list (REL003)
  // is kept by the reader but has no node to be drawn between, and the
  // physical stage — scoped to the domain's models — can never hold it. It is
  // not part of what this stage compares: the diff reports it only through
  // its REL003 integrity finding, never as an "extra" relationship that no
  // dbt test could ever clear (#133).
  const drawn = display.relationships.filter((r) => !r.issues?.includes('REL003'));
  return drawn.length === display.relationships.length ? display : { ...display, relationships: drawn };
}

/** What dbt's tests say about one column (`DisplayColumn.dbtEvidence`). */
export type DbtColumnEvidence = NonNullable<DisplayColumn['dbtEvidence']>;

/** The test declarations one dbt source (the schema yml, or the manifest) carries. */
export interface DbtTestSource {
  uniqueColumns?: ReadonlyMap<string, ReadonlySet<string>>;
  compositeUniqueGroups?: ReadonlyMap<string, readonly (readonly string[])[]>;
  relationshipTests?: ReadonlyArray<{ fromModel: string; fromColumn: string; toModel?: string; toColumn?: string }>;
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
      const evidence = at(test.fromModel, test.fromColumn);
      evidence.relationshipsTest = true;
      // Record where the test points, so a unique column's test only counts as
      // "pointing at the other end" for the pair it actually names.
      if (test.toModel && test.toColumn) {
        const targets = evidence.relationshipsTo ?? (evidence.relationshipsTo = []);
        const seen = targets.some((t) => sameName(t.model, test.toModel!) && sameName(t.column, test.toColumn!));
        if (!seen) targets.push({ model: test.toModel, column: test.toColumn });
      }
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
      return { ...col, dbtEvidence: { ...evidence, ...(evidence.relationshipsTo ? { relationshipsTo: evidence.relationshipsTo.map((t) => ({ ...t })) } : {}) } };
    });
    if (!changed) return model;
    touched = true;
    return { ...model, columns: next };
  });
  return touched ? { ...display, models } : display;
}
