/**
 * The Detail panel's "Sample data" section: a table's sample rows (its DBML
 * file's `records` block), read-only, so a reader sees what each column
 * holds.
 *
 * A fold titled with the row count, below Columns. The rows are drawn
 * transposed: one line per column, in the order of the table's Columns (a
 * column the rows name that the table lacks goes last), with the column name
 * as a sticky row header and one column per sample row, the first
 * {@link SAMPLE_ROWS_SHOWN} only. The lines scroll sideways in their own
 * region, which takes the wheel and the drag so the canvas does not pan.
 *
 * Every value is shown as written: `null` as a muted NULL, an empty string as
 * (empty), a number right-aligned as written, an expression with its
 * backticks, a line break as ↵; each cell is one line, cut with an ellipsis,
 * its first 1,000 characters in the tooltip, and selectable.
 *
 * The values may be real data, so they go nowhere but the page: the section
 * posts nothing, logs nothing, parses no value and offers no copy button.
 */

import { useId } from 'react';

import type { DisplayColumn, SampleCell, SampleData } from '@erd-studio/core';
import { IconChevron } from './panelIcons';
import './SampleDataSection.css';

/** How many sample rows the section shows; the rest are counted. */
export const SAMPLE_ROWS_SHOWN = 10;

/** The longest tooltip a cell gets, in characters. */
export const SAMPLE_CELL_TITLE_LIMIT = 1000;

/** One line of the transposed table: a column and its value in each shown row. */
export interface SampleDataLine {
  column: string;
  cells: Array<SampleCell | null>;
}

/**
 * The lines to draw: the columns the rows hold, in the table's column order,
 * then any column the rows name that the table lacks, each with its value in
 * the first `shown` rows. Names are matched without case.
 */
export function sampleDataLines(columns: readonly Pick<DisplayColumn, 'name'>[], data: SampleData, shown = SAMPLE_ROWS_SHOWN): SampleDataLine[] {
  const rows = data.rows.slice(0, shown);
  const positionOf = new Map<string, number>();
  data.columns.forEach((name, i) => {
    const key = name.toLowerCase();
    if (!positionOf.has(key)) positionOf.set(key, i);
  });
  const lines: SampleDataLine[] = [];
  const used = new Set<number>();
  const lineAt = (column: string, i: number): SampleDataLine => ({ column, cells: rows.map((row) => row[i] ?? null) });
  for (const column of columns) {
    const i = positionOf.get(column.name.toLowerCase());
    if (i === undefined || used.has(i)) continue;
    used.add(i);
    lines.push(lineAt(column.name, i));
  }
  data.columns.forEach((name, i) => {
    if (used.has(i) || positionOf.get(name.toLowerCase()) !== i) return;
    lines.push(lineAt(name, i));
  });
  return lines;
}

/** A cell's text as the section shows it: on one line, a line break as ↵. */
export function sampleCellText(cell: SampleCell): string {
  return cell.text.replace(/\r\n|\r|\n/g, '↵');
}

function SampleDataCell({ cell }: { cell: SampleCell | null }): JSX.Element {
  if (cell === null) {
    return (
      <td className="sample-data__cell sample-data__cell--null" aria-label="null">
        NULL
      </td>
    );
  }
  if (cell.kind === 'string' && cell.text === '') {
    return (
      <td className="sample-data__cell sample-data__cell--empty">
        <em className="fields-section__empty-value">(empty)</em>
      </td>
    );
  }
  return (
    <td className={`sample-data__cell sample-data__cell--${cell.kind}`} title={cell.text.slice(0, SAMPLE_CELL_TITLE_LIMIT)}>
      {sampleCellText(cell)}
    </td>
  );
}

export interface SampleDataSectionProps {
  /** The table's own name, for the region's label. */
  tableName: string;
  /** The table's columns, in the order the Columns section lists them. */
  columns: readonly Pick<DisplayColumn, 'name'>[];
  data: SampleData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** The section; nothing when there is no row to show. */
export function SampleDataSection({ tableName, columns, data, open, onOpenChange }: SampleDataSectionProps) {
  const bodyId = useId();
  const total = data.totalRows > data.rows.length ? data.totalRows : data.rows.length;
  const lines = sampleDataLines(columns, data);
  const shown = data.rows.slice(0, SAMPLE_ROWS_SHOWN).length;
  if (shown === 0 || lines.length === 0) return null;

  return (
    <div className={`detail-panel__section sample-data${open ? ' sample-data--open' : ''}`}>
      <h4 className="detail-panel__section-title sample-data__title">
        <button
          type="button"
          className="sample-data__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpenChange(!open)}
        >
          <span className="sample-data__chevron" aria-hidden="true"><IconChevron size={11} /></span>
          <span className="sample-data__toggle-label">Sample data</span>{' '}
          <span className="sample-data__count">({total === 1 ? '1 row' : `${total} rows`})</span>
        </button>
      </h4>
      <div className="sample-data__body" id={bodyId} hidden={!open}>
        <div
          className="sample-data__scroll nowheel nopan"
          role="region"
          tabIndex={0}
          aria-label={`Sample data for ${tableName}`}
        >
          <table className="sample-data__table">
            <caption className="sample-data__caption">
              {`The first ${shown === 1 ? 'sample row' : `${shown} sample rows`} of ${tableName}: one line per column, one column per row.`}
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sample-data__corner">Column</th>
                {Array.from({ length: shown }, (_, r) => (
                  <th scope="col" className="sample-data__row-number" key={r}>{r + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.column} className="sample-data__line">
                  <th scope="row" className="sample-data__column" title={line.column}>{line.column}</th>
                  {line.cells.map((cell, r) => <SampleDataCell key={r} cell={cell} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {total > shown && (
          <p className="sample-data__more">{`Showing ${shown} of ${total} rows in the table file.`}</p>
        )}
      </div>
    </div>
  );
}
