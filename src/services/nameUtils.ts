/**
 * Pure name-handling helpers shared by the extension host services and the
 * manifest worker. Keep this module dependency-free — it is bundled into the
 * worker thread as well as the extension host.
 */

/**
 * Normalise a model / column name for matching purposes.
 *
 * dbt identifiers are case-insensitive on most warehouses (Snowflake, Oracle,
 * Databricks, …), so `CUSTOMER_ID` in a schema.yml and `customer_id` in the
 * logical design refer to the same column. Matching keys are normalised with
 * this helper; the raw strings are always kept for display.
 */
export function normaliseName(name: string): string {
  return name.trim().toLowerCase();
}

/** True when two names refer to the same identifier (case/whitespace-insensitive). */
export function namesEqual(a: string, b: string): boolean {
  return normaliseName(a) === normaliseName(b);
}

/**
 * Matches a dbt `ref()` call and captures the model name.
 *
 * Accepted forms:
 *   ref('model')
 *   ref("model")
 *   ref('project', 'model')
 *   ref('model', v=2)            — dbt model versions
 *   ref('model', version=2)
 *   ref('project', 'model', v=2)
 *
 * Group 1 is the model name (the last quoted string before any keyword args).
 */
const REF_PATTERN =
  /ref\(\s*(?:['"][^'"]+['"]\s*,\s*)?['"](\w+)['"]\s*(?:,\s*(?:v|version)\s*=\s*['"]?\d+['"]?\s*)?\)/;

/**
 * Extract the model name from a string containing a dbt `ref()` call.
 * Returns undefined when no ref() call is present.
 */
export function parseRefModelName(value: string): string | undefined {
  const match = value.match(REF_PATTERN);
  return match?.[1];
}

/**
 * Resolve the short model name from a manifest node id such as
 * `model.my_project.dim_customer` or, for versioned models,
 * `model.my_project.dim_customer.v2`.
 *
 * Prefers the `name` field of the referenced node (dbt always records the
 * un-versioned name there); falls back to stripping a trailing `.vN` segment
 * and taking the last dotted part.
 */
export function resolveModelNameFromNodeId(
  nodeId: string,
  nodes?: Record<string, unknown>,
): string {
  const node = nodes?.[nodeId] as Record<string, unknown> | undefined;
  if (node && typeof node.name === 'string' && node.name) {
    return node.name;
  }

  const stripped = nodeId.replace(/\.v\d+$/, '');
  const parts = stripped.split('.');
  return parts[parts.length - 1];
}

/**
 * An identifier without one pair of wrapping quotes: `"Order Id"` → `Order Id`,
 * `` `id` `` → `id`, `[id]` → `id`. dbt passes a column with `quote: true` to
 * its tests quoted (`column_name: '"Id"'` in the manifest), and some projects
 * write the quotes into the yml `name:` itself; either way the column is the
 * name inside, a doubled quote inside it read as one (`"Ref ""A"""` →
 * `Ref "A"`). Quotes round an expression (`"a" || "b"`, `[a] + [b]`) are not
 * one identifier's, so anything else is returned trimmed.
 */
export function unquoteIdentifier(name: string): string {
  const t = name.trim();
  const m = /^"((?:[^"]|"")*)"$|^`((?:[^`]|``)*)`$|^\[((?:[^\]]|\]\])*)\]$/s.exec(t);
  if (!m) return t;
  const inner = m[1] !== undefined ? m[1].replace(/""/g, '"')
    : m[2] !== undefined ? m[2].replace(/``/g, '`')
      : (m[3] ?? '').replace(/\]\]/g, ']');
  return inner.trim() !== '' ? inner : t;
}

/** A name as compared when it may be quoted: {@link unquoteIdentifier}, then {@link normaliseName}. */
export function identifierKey(name: string): string {
  return normaliseName(unquoteIdentifier(name));
}

/**
 * The source and table a dbt `source('raw', 'customers')` call names (a
 * relationships test's `to:`), or undefined when there is none.
 */
export function parseSourceCall(value: string): { source: string; table: string } | undefined {
  const m = /\bsource\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/.exec(value);
  return m ? { source: m[1].trim(), table: m[2].trim() } : undefined;
}
