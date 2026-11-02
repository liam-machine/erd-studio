/**
 * Where each table lives: its layer and its schema, read from its file's path
 * (`<layer>/tables/<schema>/<name>.dbml`). The sidebar views and the canvas
 * use it to show every table under the same layer and schema the Explorer
 * shows its file in.
 *
 * Only DBML tables have a home: a YAML table (a project from before 2.0) has
 * no layer of its own, so the views show it as they always have.
 */
import type { TableFileEntry } from './logicalModelService';

export interface TableHome {
  /** The layer folder: `gold` of `gold/tables/sales/fct_order.dbml`. */
  readonly layer: string;
  /** The schema folder: `sales` of `gold/tables/sales/fct_order.dbml`. */
  readonly schema: string;
}

/** Each DBML table's home, by lower-cased name. A duplicate (`shadowedBy`) is left out: diagrams never use it. */
export function tableHomesOf(entries: readonly TableFileEntry[]): Map<string, TableHome> {
  const homes = new Map<string, TableHome>();
  for (const entry of entries) {
    if (entry.layer === undefined || entry.shadowedBy) continue;
    homes.set(entry.name.toLowerCase(), { layer: entry.layer, schema: entry.folder });
  }
  return homes;
}

/**
 * How many of `names` sit in each layer other than `layer`, in `order` (layer
 * ids, layers.json order; layers it does not list follow, by name). Names with
 * no home are not counted.
 */
export function otherLayerCounts(
  names: readonly string[],
  layer: string,
  homes: ReadonlyMap<string, TableHome>,
  order: readonly string[],
): Array<{ layer: string; count: number }> {
  const counts = new Map<string, number>();
  for (const name of new Set(names.map((n) => n.toLowerCase()))) {
    const home = homes.get(name);
    if (!home || home.layer === layer) continue;
    counts.set(home.layer, (counts.get(home.layer) ?? 0) + 1);
  }
  const rank = (id: string): number => {
    const i = order.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...counts.entries()]
    .map(([id, count]) => ({ layer: id, count }))
    .sort((a, b) => rank(a.layer) - rank(b.layer) || a.layer.localeCompare(b.layer));
}
