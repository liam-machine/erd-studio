/**
 * The schema panel (docs/dev/draft-first.md §2.3): **All tables (N)** then
 * each schema with its count, biggest first. Choosing one redraws the canvas
 * with that schema's tables and the relationships between them, on the page
 * only; Keep keeps every table. `«` / `»` collapses and opens it.
 */

import type { DraftSchemaCount } from '../../src/types/draft';
import { countOf, formatCount, schemaLabel, showingLine } from '../lib/wording';

export interface SchemaPanelProps {
  schemas: readonly DraftSchemaCount[];
  total: number;
  /** The schema on show; undefined: every table. */
  selected: string | undefined;
  open: boolean;
  onToggle(): void;
  onSelect(schema: string | undefined): void;
}

export function SchemaPanel({ schemas, total, selected, open, onToggle, onSelect }: SchemaPanelProps) {
  const selectedCount = selected === undefined ? total : schemas.find((s) => s.schema === selected)?.tables ?? 0;
  return (
    <nav className={`draft-schemas${open ? ' draft-schemas--open' : ''}`} aria-label="Schemas">
      <div className="draft-schemas__header">
        {open && <span className="draft-schemas__title">Schemas</span>}
        <button
          type="button"
          className="draft-schemas__toggle"
          aria-expanded={open}
          aria-label={open ? 'Hide schemas' : 'Show schemas'}
          title={open ? 'Hide schemas' : 'Show schemas'}
          onClick={onToggle}
        >
          {open ? '«' : '»'}
        </button>
      </div>
      {open && (
        <>
          {selected !== undefined && (
            <p className="draft-schemas__showing">{showingLine(selected, selectedCount, total)}</p>
          )}
          <ul className="draft-schemas__list">
            <li className="draft-schemas__entry">
              <button
                type="button"
                className={`draft-schemas__item${selected === undefined ? ' draft-schemas__item--selected' : ''}`}
                aria-pressed={selected === undefined}
                onClick={() => onSelect(undefined)}
              >
                <span className="draft-schemas__name">{`All tables (${formatCount(total)})`}</span>
              </button>
            </li>
            {schemas.map((s) => (
              <li key={s.schema} className="draft-schemas__entry">
                <button
                  type="button"
                  className={`draft-schemas__item${selected === s.schema ? ' draft-schemas__item--selected' : ''}`}
                  aria-pressed={selected === s.schema}
                  aria-label={`${schemaLabel(s.schema)}, ${countOf(s.tables, 'table', 'tables')}`}
                  onClick={() => onSelect(s.schema)}
                >
                  <span className="draft-schemas__name">{schemaLabel(s.schema)}</span>
                  <span className="draft-schemas__count">{formatCount(s.tables)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
