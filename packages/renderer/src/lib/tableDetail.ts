/**
 * Table detail levels: how much of every table a diagram draws.
 *
 *   - `name`: the header only, no column rows
 *   - `keys`: the key columns (primary, foreign or natural key), in file
 *             order; or, with a column filter, the columns it matches
 *   - `all`:  every column
 *
 * The level is diagram-wide (the store's `tableDetail`); one table can be
 * opened on its own (`isExpanded`, the store's `expandedNodes`) and closed
 * again. `resolveVisibleColumns` is the one place that decides which rows a
 * table draws: the node component, the row count and the width estimate all
 * call it, so what is drawn and what is estimated cannot drift.
 *
 * A node with no level (`tableDetail` absent: an `ErdCanvas` without the
 * prop, or node data built by older code) keeps the behaviour from before the
 * levels existed: the first `COLLAPSED_COLUMN_LIMIT` columns until expanded.
 *
 * Pure: no React, no React Flow, no store.
 */

/** The three levels, in toolbar order. */
export const TABLE_DETAILS = ['name', 'keys', 'all'] as const;

export type TableDetail = (typeof TABLE_DETAILS)[number];

/** Whether `value` is one of the three levels (for props and restored state). */
export function isTableDetail(value: unknown): value is TableDetail {
  return typeof value === 'string' && (TABLE_DETAILS as readonly string[]).includes(value);
}

/** Tables at or above this count open at `keys`; smaller diagrams at `all`. */
export const TABLE_DETAIL_ALL_BELOW = 30;

/** The level a diagram of `tableCount` tables opens at when the reader has not chosen one. */
export function defaultTableDetail(tableCount: number): TableDetail {
  return tableCount < TABLE_DETAIL_ALL_BELOW ? 'all' : 'keys';
}

/** Columns shown by a node with no level before it is expanded (the pre-level behaviour). */
export const LEGACY_COLLAPSED_COLUMN_LIMIT = 5;

/** The flags that make a column a key, and the name a column filter's pattern reads. */
export interface KeyFlags {
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  name?: string;
}

/**
 * Which columns the `keys` level shows: a column is shown when it matches
 * ANY rule that is on. A reader's view preference, like the level itself.
 *
 * Absent (or null) is the rule from before the filter existed: primary,
 * foreign and natural keys, no pattern. A flag left out counts as on, so
 * `{ foreignKeys: false }` is "primary and natural keys".
 */
export interface ColumnFilter {
  primaryKeys?: boolean;
  foreignKeys?: boolean;
  naturalKeys?: boolean;
  /**
   * Column names to show as well, as comma-separated terms, any case. A
   * plain term matches anywhere in the name (`date` finds `order_date`); a
   * term with `*` (any run of characters) or `?` (one character) must match
   * the whole name (`*_at`, `dbt_*`). Wildcards only: never a regular
   * expression, so no text typed here can fail to compile or run away.
   */
  namePattern?: string;
}

/** The longest name pattern kept; anything past it is dropped. */
export const COLUMN_NAME_PATTERN_MAX = 200;

/**
 * A filter read from a prop, restored state or the toolbar, in the one shape
 * the store keeps: all four fields set, or null when it is the default (the
 * three key kinds, no pattern) or not a filter at all. Never throws.
 */
export function normaliseColumnFilter(value: unknown): ColumnFilter | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const filter: Required<ColumnFilter> = {
    primaryKeys: v.primaryKeys !== false,
    foreignKeys: v.foreignKeys !== false,
    naturalKeys: v.naturalKeys !== false,
    namePattern: typeof v.namePattern === 'string' ? v.namePattern.slice(0, COLUMN_NAME_PATTERN_MAX) : '',
  };
  return filter.primaryKeys && filter.foreignKeys && filter.naturalKeys && filter.namePattern === ''
    ? null
    : filter;
}

/** Whether two filters show the same columns' rules (null and absent are the default). */
export function sameColumnFilter(a: ColumnFilter | null | undefined, b: ColumnFilter | null | undefined): boolean {
  const x = normaliseColumnFilter(a);
  const y = normaliseColumnFilter(b);
  if (x === null || y === null) return x === y;
  return x.primaryKeys === y.primaryKeys && x.foreignKeys === y.foreignKeys
    && x.naturalKeys === y.naturalKeys && x.namePattern === y.namePattern;
}

/** The pattern's terms: trimmed, lower-cased, empties dropped. */
export function columnNameTerms(namePattern: string | undefined): string[] {
  return (namePattern ?? '')
    .slice(0, COLUMN_NAME_PATTERN_MAX)
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
}

/**
 * Whether `text` is matched by the wildcard `pattern` (`*` any run, `?` one
 * character), whole string. A two-pointer walk: at worst pattern × text
 * steps, with no backtracking blow-up whatever is typed.
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

function matchesTerm(term: string, name: string): boolean {
  return term.includes('*') || term.includes('?') ? wildcardMatch(term, name) : name.includes(term);
}

type ColumnPredicate = (c: KeyFlags) => boolean;

function isKey(c: KeyFlags): boolean {
  return !!(c.isPrimaryKey || c.isForeignKey || c.isNaturalKey);
}

/**
 * One predicate per filter object: the pattern is split once, not once per
 * table. Kept with the values it was built from, so a caller that changes a
 * filter object in place still gets the rule it now holds.
 */
const predicates = new WeakMap<ColumnFilter, { pk: boolean; fk: boolean; nk: boolean; pattern: string; predicate: ColumnPredicate }>();

/** The test a column must pass to be drawn at the `keys` level under `filter`. */
export function columnFilterPredicate(filter: ColumnFilter | null | undefined): ColumnPredicate {
  if (filter == null) return isKey;
  const pk = filter.primaryKeys !== false;
  const fk = filter.foreignKeys !== false;
  const nk = filter.naturalKeys !== false;
  const pattern = typeof filter.namePattern === 'string' ? filter.namePattern : '';
  const cached = predicates.get(filter);
  if (cached && cached.pk === pk && cached.fk === fk && cached.nk === nk && cached.pattern === pattern) {
    return cached.predicate;
  }
  const terms = columnNameTerms(pattern);
  const predicate: ColumnPredicate = (c) => {
    if ((pk && c.isPrimaryKey) || (fk && c.isForeignKey) || (nk && c.isNaturalKey)) return true;
    if (terms.length === 0 || typeof c.name !== 'string') return false;
    const name = c.name.toLowerCase();
    return terms.some((term) => matchesTerm(term, name));
  };
  predicates.set(filter, { pk, fk, nk, pattern, predicate });
  return predicate;
}

/** What `resolveVisibleColumns` reads from a table node's data. */
export interface VisibleColumnsInput<C extends KeyFlags> {
  columns: readonly C[];
  /** Stub tables only ever list their primary and natural keys. */
  isStub?: boolean;
  /** This one table is opened (the per-table override). */
  isExpanded?: boolean;
  /** The diagram's level; absent keeps the pre-level behaviour. */
  tableDetail?: TableDetail | null;
  /**
   * Which columns the `keys` level shows; absent or null is the three key
   * kinds. Read at `keys` only, and never for a stub.
   */
  columnFilter?: ColumnFilter | null;
  /** Only its presence is read: an unreadable file's message shows at every level. */
  loadError?: unknown;
}

export interface VisibleColumns<C> {
  /** The column rows drawn, in file order. */
  columns: C[];
  /** How many more rows the table would draw if it were opened. */
  hiddenCount: number;
  /** How many rows the table draws when opened (the "Show all N" count). */
  expandedCount: number;
  /** The control that opens this table or closes it again, or none. */
  toggle: 'expand' | 'collapse' | null;
  /**
   * Where the control is. False: a row-sized button under the columns. True:
   * the footer itself is the button, so the body gains no row (a closed table
   * at the `name` level, which is then header and footer only).
   */
  toggleInFooter: boolean;
  /** The table is drawn opened: by the `all` level or by its own override. */
  expanded: boolean;
  /** The rows are exactly `columns`, so a row's index is its index in the file. */
  isFullList: boolean;
  /** The "No columns" line (or the load error) is drawn in place of rows. */
  placeholder: boolean;
}

/** The rows a table draws, and what its expand / collapse button offers. */
export function resolveVisibleColumns<C extends KeyFlags>(data: VisibleColumnsInput<C>): VisibleColumns<C> {
  const all = data.columns as C[];
  const level = data.tableDetail ?? null;
  const isExpanded = data.isExpanded ?? false;
  // What the table lists when opened: a stub never more than its PK / NK.
  const opened = data.isStub ? all.filter((c) => c.isPrimaryKey || c.isNaturalKey) : all;

  let columns: C[];
  let toggle: VisibleColumns<C>['toggle'] = null;
  let expanded: boolean;

  if (level === null) {
    // Before levels: the first few columns, then all of them.
    expanded = isExpanded;
    if (isExpanded) {
      columns = opened;
      if (all.length > LEGACY_COLLAPSED_COLUMN_LIMIT) toggle = 'collapse';
    } else if (opened.length > LEGACY_COLLAPSED_COLUMN_LIMIT) {
      columns = opened.slice(0, LEGACY_COLLAPSED_COLUMN_LIMIT);
      toggle = 'expand';
    } else {
      columns = opened;
    }
  } else if (level === 'all') {
    expanded = true;
    columns = opened;
  } else {
    const closed = level === 'name' ? [] : data.isStub ? opened : all.filter(columnFilterPredicate(data.columnFilter));
    const hides = closed.length < opened.length;
    expanded = isExpanded && hides;
    columns = expanded ? opened : closed;
    if (hides) toggle = expanded ? 'collapse' : 'expand';
  }

  return {
    columns,
    hiddenCount: opened.length - columns.length,
    expandedCount: opened.length,
    toggle,
    toggleInFooter: level === 'name' && toggle === 'expand',
    expanded,
    isFullList: columns.length === all.length,
    placeholder: all.length === 0 && (level !== 'name' || data.loadError != null),
  };
}
