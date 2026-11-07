/** The page's own words (the banner's are built by the host's draft services). */

/** `1,204` (en-US grouping, whatever the machine's locale, as the banner's counts). */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** `1 table`, `257 tables`. */
export function countOf(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/** What a table with no schema is listed as. */
export const NO_SCHEMA_LABEL = 'No schema';

export function schemaLabel(schema: string): string {
  return schema === '' ? NO_SCHEMA_LABEL : schema;
}

export const BUSY_LABELS = {
  keep: 'Saving…',
  scope: 'Drawing…',
} as const;

export function layingOutLabel(tables: number): string {
  return `Laying out ${countOf(tables, 'table', 'tables')}…`;
}

export const OTHER_WAYS_TO_START = 'More ways to start';
export const DISCARD = 'Discard';
export const CHANGE_OPTIONS = 'Change options…';
export const SHOW_DETAILS = 'Show details';

/** The schema panel's line when one schema is on show: `Showing sales: 80 of 257 tables`. */
export function showingLine(schema: string, shown: number, total: number): string {
  return `Showing ${schemaLabel(schema)}: ${formatCount(shown)} of ${countOf(total, 'table', 'tables')}`;
}

/** The second banner line's counts: `2 notes, 3 left out`, or '' when there are none. */
export function notesLine(notes: number, leftOut: number): string {
  const parts: string[] = [];
  if (notes > 0) parts.push(countOf(notes, 'note', 'notes'));
  if (leftOut > 0) parts.push(`${formatCount(leftOut)} left out`);
  return parts.join(', ');
}

/** How many items a details section shows before its Show all. */
export const DETAILS_PAGE = 200;
