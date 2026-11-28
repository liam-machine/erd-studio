/**
 * The dbt model selectors.yml (`SelectorsService`'s planner) names a
 * diagram's table as. The canvas's dbt command names each table as the dbt
 * node the physical stage finds (`SubjectAreaService.dbtNodeNamesOf`); where
 * that is not the name written here, the selector does not select the model
 * (`selectorNameGaps`, `src/services/dbtCommand.ts`): Regenerate dbt
 * selectors.yml says so, and the dbt command does not offer the selector in
 * place of a long list.
 *
 * Pure: no `vscode`, no `fs`, so the CLI may bundle it.
 */

import { tableNameOf } from '@erd-studio/core';
import type { SemanticTable } from '../types/semantic';

/**
 * The dbt model `model` is, or null when it has none to name.
 *
 * `dbtModels` is `SubjectAreaService.dbtModelNamesOf` for the table's
 * diagram: the dbt model each table whose name two schema folders share was
 * found as (null for one found as none), by lower-case reference. Such a
 * table is that model, or none; one the diagram names `<schema>.<name>` that
 * the map does not list is none (never written as a reference). Any other
 * table is written by its name, even where dbt's node is spelled in another
 * case or the physical stage found it through its warehouse relation under
 * another name: selectors.yml reads no dbt data for such a table.
 */
export function dbtModelNameOf(model: SemanticTable, dbtModels?: ReadonlyMap<string, string | null>): string | null {
  const found = dbtModels?.get(model.name.toLowerCase());
  if (found !== undefined) return found;
  return tableNameOf(model) !== undefined ? null : model.name;
}
