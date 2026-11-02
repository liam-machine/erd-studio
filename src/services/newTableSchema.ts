/**
 * Which schema folder a table made on the canvas goes in (native DBML
 * storage, `<layer>/tables/<schema>/`), the rule the New Table dialog shows
 * and the AI helper's guide states:
 *
 * 1. the schema the user names;
 * 2. else the schema most of the diagram's tables in that layer already use
 *    (a tie goes to the layer's own schema, then to the first in byte order);
 * 3. else the layer id, as the layer's `tables/` lists it.
 *
 * Pure: no `vscode`, no file access.
 */

import type { TableHome } from './tableHomes';

/** What the New Table dialog offers for a diagram's new table. */
export interface NewTableSchemaChoice {
  /** The diagram's layer: the new table's layer folder. */
  layer: string;
  /** Every schema folder the layer's tables already use, plus the default; byte order. */
  schemas: string[];
  /** The schema the dialog fills in (rules 2 and 3). */
  defaultSchema: string;
}

const lower = (s: string): string => s.toLowerCase();

/** Code-unit order: the same on every machine and locale. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The schemas the dialog offers and the one it fills in. `layerSchema` is
 * the layer id as the layer's `tables/` lists it (today's default);
 * `members` the diagram's tables; `homes` every DBML table's layer and
 * schema (`tableHomesOf`).
 */
export function newTableSchemaChoice(input: {
  layer: string;
  layerSchema: string;
  members: readonly string[];
  homes: ReadonlyMap<string, TableHome>;
}): NewTableSchemaChoice {
  const { layer, layerSchema, members, homes } = input;
  const inLayer = (home: TableHome): boolean => lower(home.layer) === lower(layer);

  // Every schema the layer's tables use, spelled as the first one listed.
  const spelling = new Map<string, string>();
  for (const home of homes.values()) {
    if (inLayer(home) && !spelling.has(lower(home.schema))) spelling.set(lower(home.schema), home.schema);
  }

  // How many of the diagram's own tables sit in each of them.
  const counts = new Map<string, number>();
  for (const name of new Set(members.map(lower))) {
    const home = homes.get(name);
    if (!home || !inLayer(home)) continue;
    counts.set(lower(home.schema), (counts.get(lower(home.schema)) ?? 0) + 1);
  }
  const own = lower(layerSchema);
  const [best] = [...counts.entries()].sort(([a, n], [b, m]) =>
    m - n || Number(b === own) - Number(a === own) || byteOrder(a, b));
  const defaultSchema = best !== undefined ? spelling.get(best[0]) ?? best[0] : layerSchema;
  if (!spelling.has(lower(defaultSchema))) spelling.set(lower(defaultSchema), defaultSchema);
  return { layer, schemas: [...spelling.values()].sort(byteOrder), defaultSchema };
}
