/**
 * Table detail levels: how much of every table a diagram draws.
 *
 *   - `name`: the header only, no column rows
 *   - `keys`: the key columns (primary, foreign or natural key), in file order
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

/** The flags that make a column a key. */
export interface KeyFlags {
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
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

function isKey(c: KeyFlags): boolean {
  return !!(c.isPrimaryKey || c.isForeignKey || c.isNaturalKey);
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
    const closed = level === 'name' ? [] : data.isStub ? opened : all.filter(isKey);
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
