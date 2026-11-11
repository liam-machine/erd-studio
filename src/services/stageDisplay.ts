/**
 * Logical stage → DisplaySubjectArea, the pure core.
 *
 * A thin wrapper over `@erd-studio/core`'s `toDisplaySubjectArea` — the one
 * implementation the canvas (`SemanticEditorProvider.buildDisplaySubjectArea`) also
 * uses — without the canvas-only extras (templates, add-model pickers, layer
 * config). The discrepancy comparison only reads the core, so
 * `computeSubjectAreaDiff` (`stageDiff.ts`), shared by the canvas and the
 * `erd-studio` CLI, builds the logical side here and both see exactly the same
 * domain.
 *
 * No `vscode` import — this module is bundled into `dist/cli.js`.
 */

import { buildDbtKeyIndex, toDisplaySubjectArea } from '@erd-studio/core';
import type { DbtKeyIndex } from '@erd-studio/core';

import type { DisplaySubjectArea } from '../types/display';
import type { ManifestData } from '../types/manifest';
import type { SemanticSubjectArea, ViewConfig } from '../types/semantic';
import type { YmlData } from '../types/ymlData';

/**
 * Convert a logical `SemanticSubjectArea` to a `DisplaySubjectArea`.
 *
 * Key flags are coerced to booleans (`isPrimaryKey === true`), and a column is
 * a foreign key when it says so OR when it is the foreign-key end of one of the
 * domain's relationships (core's `foreignKeyEnd`: the `toColumn` of a
 * `one-to-many`, else the `fromColumn`). `viewConfig` is passed separately because it lives
 * at the root of the unified domain file, not in the stage section.
 * `dbtKeyIndex` lets a relationship drawn backwards be flagged
 * (`keysContradict`, #163) on dbt's evidence too, as the canvas flags it.
 */
export function buildLogicalDisplaySubjectArea(
  domain: SemanticSubjectArea,
  viewConfig: ViewConfig,
  stubColumns?: string[],
  dbtKeyIndex?: DbtKeyIndex,
): DisplaySubjectArea {
  return toDisplaySubjectArea(domain, {
    viewConfig,
    stubColumns,
    layerConfig: undefined,
    readOnly: domain.stage === 'physical',
    ...(dbtKeyIndex ? { dbtKeyIndex } : {}),
  });
}

/**
 * What dbt's tests say about keys, from the schema yml and the manifest
 * (#133 L1): `unique` tests, `unique_combination_of_columns` and the columns
 * `relationships` tests leave. Either source may be missing.
 */
export function dbtKeyIndexOf(ymlData: YmlData | undefined, manifest: ManifestData | undefined): DbtKeyIndex {
  return buildDbtKeyIndex([ymlData, manifest]);
}

/**
 * The editable logical payload with `dbtKey` on every column dbt's tests say
 * something about — how the canvas orients a new relationship when the model
 * flags no key (#133 L1). Editor-only: the CLI's `diff`, the viewer and the
 * display goldens never carry it. Returns `display` itself when there is
 * nothing to add.
 */
export function withDbtKeyHints(display: DisplaySubjectArea, index: DbtKeyIndex): DisplaySubjectArea {
  if (index.columns.size === 0) return display;
  let touched = false;
  const models = display.models.map((model) => {
    // dbt names a table by its own name (`tableName` where two members share it), as core's key evidence does.
    const hints = index.columns.get((model.tableName ?? model.name).toLowerCase());
    if (!hints) return model;
    let changed = false;
    const columns = model.columns.map((col) => {
      const hint = typeof col.name === 'string' ? hints.get(col.name.toLowerCase()) : undefined;
      if (!hint) return col;
      changed = true;
      return { ...col, dbtKey: { ...hint, ...(hint.combinations ? { combinations: hint.combinations.map((c) => [...c]) } : {}) } };
    });
    if (!changed) return model;
    touched = true;
    return { ...model, columns };
  });
  return touched ? { ...display, models } : display;
}
