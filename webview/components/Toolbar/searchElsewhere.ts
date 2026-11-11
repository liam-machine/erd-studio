/**
 * The toolbar search's "Not on this diagram" hint: how many of the
 * project's tables match a search that finds none on this diagram. Counted
 * from the Table Library rows the host already sends (`existingModels`,
 * source `logical`), so no request is made for it; the hint runs Go to
 * Table… with the search filled in.
 */
import type { ExistingTablePreview } from '../../../src/types/display';

/**
 * Library tables, not on this diagram (`onCanvas`, node ids), whose name
 * holds `query` (ignoring case). A row the host lists with its schema folder
 * (two tables of one name in different schema folders) is a table of its
 * own, by its file, and the host already left out the diagram's own tables:
 * it is never compared with a node's name.
 */
export function otherProjectMatches(
  existing: readonly ExistingTablePreview[] | undefined,
  onCanvas: readonly string[],
  query: string,
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const here = new Set(onCanvas.map((id) => id.toLowerCase()));
  const tables = new Set<string>();
  for (const row of existing ?? []) {
    if (row.source !== 'logical') continue;
    const name = row.name.toLowerCase();
    if (!name.includes(q)) continue;
    if (row.schemaFolder !== undefined) {
      tables.add(`${name}\u0000${row.sourcePath.toLowerCase()}`);
      continue;
    }
    if (here.has(name)) continue;
    tables.add(name);
  }
  return tables.size;
}

/** "Not on this diagram — 3 in the project". */
export function searchElsewhereLabel(count: number): string {
  return `Not on this diagram — ${count} in the project`;
}
