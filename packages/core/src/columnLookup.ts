/**
 * Column lookup by name, shared by every place core matches a relationship
 * endpoint to a column. Internal: not re-exported from the package index.
 *
 * A v4 domain's inline models are copied straight from the domain JSON, so a
 * hand-edited column may have no `name`, or a number there. Those files drew
 * before #133 and must keep drawing (CLAUDE.md, "Backward compatibility"), so
 * a column without a text name is simply never a match — it must not throw.
 */
export function findColumnByName<C extends { name: unknown }>(
  columns: readonly C[],
  name: string,
): C | undefined {
  const exact = columns.find((c) => c?.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  return columns.find((c) => typeof c?.name === 'string' && c.name.toLowerCase() === lower);
}
