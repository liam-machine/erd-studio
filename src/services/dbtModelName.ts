/**
 * The dbt model a diagram's table is: one answer, shared by selectors.yml
 * (`SelectorsService`'s planner) and the canvas's dbt command
 * (`dbtCommand.ts`), so the two can never name a table differently.
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
 * table's dbt model is its name.
 */
export function dbtModelNameOf(model: SemanticTable, dbtModels?: ReadonlyMap<string, string | null>): string | null {
  const found = dbtModels?.get(model.name.toLowerCase());
  if (found !== undefined) return found;
  return tableNameOf(model) !== undefined ? null : model.name;
}
