/**
 * Writing sample rows (D37 of the native DBML storage spec): the one writer
 * of row text, shared by every path that writes a `records` block of its own
 * (a new table file, an export), and the rules it follows.
 *
 * - **Every cell is written so it reads back as the same value**: a string
 *   quoted (`'''…'''` when it holds a line break), a number, boolean or
 *   backtick expression exactly as written, `null` for no value (an empty
 *   field reads as null too, but a written block never relies on that).
 * - **An enum reference becomes text** ({@link sampleCellAsText}): the file
 *   it is written to declares no Enum, so `status.active` is written as
 *   `'active'`, its last segment. One rule for every writer.
 * - **No row after the first starts with a sign**: DBML 9 and 10 reject such
 *   a row (11 reads it). The list is ordered so a column with no signed value
 *   in rows 2 and later leads ({@link sampleRowsWriteOrder}); when no column
 *   can, those rows are left out and counted.
 * - **Always an explicit column list**, so the block stays right when the
 *   table's columns are later reordered or added to.
 *
 * Pure and parser-free (the main entry may import it). Privacy: a cell may
 * hold real data, so nothing here puts a value in anything but the block's
 * own text; the counts it returns are numbers only.
 */

import { dbmlName } from './dbmlText.js';
import type { SampleCell } from './types/semantic.js';

/** A row as a writer is given it: a cell, or null for no value. */
export type SampleRow = ReadonlyArray<SampleCell | null>;

/** The unquoted text of one name segment (`"in progress"` → `in progress`). */
function unquoteSegment(segment: string): string {
  const s = segment.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const escapes: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t' };
    return s.slice(1, -1).replace(/\\(.)/gs, (_m, c: string) => escapes[c] ?? c);
  }
  return s;
}

/** The last dot-separated segment of an enum reference as written (dots inside double quotes are not separators). */
function lastSegment(text: string): string {
  let inQuote = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '\\') i++;
      else if (c === '"') inQuote = false;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === '.') {
      start = i + 1;
    }
  }
  return unquoteSegment(text.slice(start));
}

/**
 * A cell as a written block holds it: an enum reference (`status.active`,
 * `sales.status."in progress"`) becomes a string of its last segment
 * (`active`, `in progress`), because the file it is written to declares no
 * Enum; every other cell is returned as it is.
 */
export function sampleCellAsText(cell: SampleCell): SampleCell {
  return cell.kind === 'enum' ? { text: lastSegment(cell.text), kind: 'string' } : cell;
}

/** A string as a sample value: quoted as `dbmlString` quotes it, a carriage return written `\r` so a row never holds a bare one. */
function sampleString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r');
  return value.includes('\n') ? `'''${escaped}'''` : `'${escaped}'`;
}

/** One cell's text in a written row. */
function cellSource(cell: SampleCell | null): string {
  if (cell === null) return 'null';
  const value = sampleCellAsText(cell);
  return value.kind === 'string' ? sampleString(value.text) : value.text;
}

/** Whether a cell, written, starts with a sign (`-5`, `+5`; a quoted string never does). */
function startsWithSign(cell: SampleCell | null | undefined): boolean {
  return /^[-+]/.test(cellSource(cell ?? null));
}

/** How a block is written: the column order, the rows kept, and how many were left out. */
export interface SampleRowsWriteOrder {
  /** Column indices in the order they are written (the lead column first). */
  order: number[];
  /** Indices of the rows written, in file order. */
  rows: number[];
  /** Rows after the first left out because each would start with a sign whichever column led. */
  leftOut: number;
}

/**
 * The order a block is written in, so no row after the first starts with a
 * sign (DBML 9 and 10 reject such a row): the first column, in the given
 * order, with no signed value in rows 2 and later leads, the others keep
 * their order. When no column can lead, the given order is kept and each row
 * after the first whose first value is signed is left out (and counted).
 */
export function sampleRowsWriteOrder(columnCount: number, rows: ReadonlyArray<SampleRow>): SampleRowsWriteOrder {
  const all = rows.map((_, r) => r);
  const lead = Array.from({ length: columnCount }, (_, c) => c).find((c) => rows.every((row, r) => r === 0 || !startsWithSign(row[c])));
  if (lead !== undefined) {
    return { order: [lead, ...Array.from({ length: columnCount }, (_, c) => c).filter((c) => c !== lead)], rows: all, leftOut: 0 };
  }
  const kept = all.filter((r) => r === 0 || !startsWithSign(rows[r][0]));
  return { order: Array.from({ length: columnCount }, (_, c) => c), rows: kept, leftOut: rows.length - kept.length };
}

/** Options for {@link renderRecordsBlock}. */
export interface RenderRecordsBlockOptions {
  /**
   * Write value-free comments inside the block: how many rows the table file
   * has beyond those written (with `totalRows`), and how many were left out
   * for a leading sign. Off by default.
   */
  comments?: boolean;
  /** The rows the source holds, counting any not given (for the comment). */
  totalRows?: number;
}

/** What {@link renderRecordsBlock} wrote. */
export interface RenderedRecordsBlock {
  /** The block, from its first line's indent to its closing brace (no line ending after it); '' when there is nothing to write. */
  text: string;
  /** Rows left out because each would start with a sign ({@link sampleRowsWriteOrder}). */
  leftOut: number;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * A nested `records (<columns>) { … }` block: the column list always written
 * (in the order {@link sampleRowsWriteOrder} gives), one row per line, every
 * cell written so it reads back as the same value, an enum reference as text
 * ({@link sampleCellAsText}). `indent` is the block's own indent (a row gets
 * two spaces more), `eol` its line ending. Nothing is written for no column
 * or no row. Each row must hold one cell per column.
 */
export function renderRecordsBlock(
  columns: readonly string[],
  rows: ReadonlyArray<SampleRow>,
  indent = '  ',
  eol = '\n',
  options: RenderRecordsBlockOptions = {},
): RenderedRecordsBlock {
  if (columns.length === 0 || rows.length === 0) return { text: '', leftOut: 0 };
  const { order, rows: kept, leftOut } = sampleRowsWriteOrder(columns.length, rows);
  const lines = [`${indent}records (${order.map((c) => dbmlName(columns[c])).join(', ')}) {`];
  for (const r of kept) lines.push(`${indent}  ${order.map((c) => cellSource(rows[r][c] ?? null)).join(', ')}`);
  if (options.comments) {
    const more = (options.totalRows ?? rows.length) - rows.length;
    if (more > 0) lines.push(`${indent}  // ${plural(more, 'more row is', 'more rows are')} in the table file`);
    if (leftOut > 0) lines.push(`${indent}  // ${plural(leftOut, 'row', 'rows')} left out: DBML 9 and 10 read no row that starts with a sign`);
  }
  lines.push(`${indent}}`);
  return { text: lines.join(eol), leftOut };
}
