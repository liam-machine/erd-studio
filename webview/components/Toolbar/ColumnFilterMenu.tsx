/**
 * ColumnFilterMenu — the button beside Names / Keys / All that chooses which
 * columns the Keys level shows: any of primary keys, foreign keys and natural
 * (business) keys, plus the columns whose name matches a pattern. A column is
 * shown when it matches any rule that is on.
 *
 * A view preference like the level itself: shown on every stage and on
 * read-only diagrams, kept per diagram in the webview's own state
 * (useStatePersistence) and never posted to the host or written to a file.
 * Changing a rule puts the diagram at Keys, since that is the level the rules
 * apply to; already at Keys, the tables opened on their own stay open.
 *
 * It sits outside the switch's radio group on purpose: the group's arrow keys
 * choose a level, and they must keep moving the caret in the pattern box.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COLUMN_NAME_PATTERN_MAX,
  columnNameTerms,
  resolveVisibleColumns,
  type ColumnFilter,
} from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import './ColumnFilterMenu.css';

/** How long the pattern box waits after the last keystroke before the diagram redraws. */
export const COLUMN_PATTERN_DEBOUNCE_MS = 150;

type KeyRule = 'primaryKeys' | 'foreignKeys' | 'naturalKeys';

/** The three key rules, in menu order, with their labels. */
export const COLUMN_FILTER_RULES: ReadonlyArray<{ key: KeyRule; label: string; badge: string }> = [
  { key: 'primaryKeys', label: 'Primary keys', badge: 'PK' },
  { key: 'foreignKeys', label: 'Foreign keys', badge: 'FK' },
  { key: 'naturalKeys', label: 'Natural (business) keys', badge: 'NK' },
];

/** The filter with every field set (null is the three key kinds, no pattern). */
function filled(filter: ColumnFilter | null): Required<ColumnFilter> {
  return {
    primaryKeys: filter?.primaryKeys !== false,
    foreignKeys: filter?.foreignKeys !== false,
    naturalKeys: filter?.naturalKeys !== false,
    namePattern: filter?.namePattern ?? '',
  };
}

/** What the Keys level shows under `filter`, in words (the button's hover text). */
export function describeColumnFilter(filter: ColumnFilter | null): string {
  const f = filled(filter);
  const parts = COLUMN_FILTER_RULES.filter((r) => f[r.key]).map((r) => r.label.toLowerCase());
  const terms = columnNameTerms(f.namePattern);
  if (terms.length > 0) parts.push(`names matching ${terms.join(', ')}`);
  return parts.length > 0 ? parts.join(', ') : 'no columns';
}

const NO_NODES: never[] = [];

function IconFilter() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 3.5h12L9.5 9v4l-3-1.5V9L2 3.5z" />
    </svg>
  );
}

function ColumnFilterPanel({ onClose }: { onClose: () => void }) {
  const filter = useEditorStore((s) => s.columnFilter ?? null);
  const setColumnFilter = useEditorStore((s) => s.setColumnFilter);
  const setTableDetail = useEditorStore((s) => s.setTableDetail);
  const nodes = useEditorStore((s) => s.nodes ?? NO_NODES);
  const current = filled(filter);

  // The box keeps its own text and hands it on shortly after the last
  // keystroke, so a large diagram redraws once per pause, not once per letter.
  const [text, setText] = useState(current.namePattern);
  const timerRef = useRef<number | null>(null);

  const apply = useCallback(
    (next: Required<ColumnFilter>) => {
      setColumnFilter(next);
      // Only a change of level: choosing Keys again would close the tables
      // opened on their own, on every tick and every pause in typing.
      if (useEditorStore.getState().tableDetail !== 'keys') setTableDetail('keys');
    },
    [setColumnFilter, setTableDetail],
  );

  const commitText = useCallback(
    (value: string) => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const latest = filled(useEditorStore.getState().columnFilter ?? null);
      if (latest.namePattern !== value) apply({ ...latest, namePattern: value });
    },
    [apply],
  );

  // A pattern still waiting when the menu closes is applied, not dropped.
  const textRef = useRef(text);
  textRef.current = text;
  const commitRef = useRef(commitText);
  commitRef.current = commitText;
  useEffect(() => () => {
    if (timerRef.current !== null) commitRef.current(textRef.current);
  }, []);

  const onTextChange = (value: string) => {
    setText(value);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commitText(value);
    }, COLUMN_PATTERN_DEBOUNCE_MS);
  };

  const toggleRule = (key: KeyRule) => {
    // The pattern as typed, in case its pause has not run out yet.
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    apply({ ...current, namePattern: text, [key]: !current[key] });
  };

  const reset = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setText('');
    apply(filled(null));
  };

  // Where the rules land: the same call every table makes for its rows.
  const summary = useMemo(() => {
    let columns = 0;
    let tables = 0;
    let total = 0;
    for (const node of nodes) {
      if (node.type !== 'model') continue;
      const data = node.data as { columns?: unknown; isStub?: boolean };
      if (!Array.isArray(data.columns)) continue;
      total++;
      const shown = resolveVisibleColumns({
        columns: data.columns,
        isStub: data.isStub,
        tableDetail: 'keys',
        columnFilter: filter,
      }).columns.length;
      columns += shown;
      if (shown > 0) tables++;
    }
    return { columns, tables, total };
  }, [nodes, filter]);

  return (
    <div
      className="column-filter__panel"
      role="dialog"
      aria-label="Columns shown at Keys"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          // Escape leaves: a pattern still waiting for its pause is dropped, not applied.
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          onClose();
        }
      }}
    >
      <div className="column-filter__heading">Keys shows a column when it is any of:</div>
      {COLUMN_FILTER_RULES.map((rule) => (
        <label key={rule.key} className="column-filter__rule">
          <input
            type="checkbox"
            className="column-filter__checkbox"
            checked={current[rule.key]}
            onChange={() => toggleRule(rule.key)}
          />
          <span className="column-filter__rule-label">{rule.label}</span>
          <span className="column-filter__badge" aria-hidden="true">{rule.badge}</span>
        </label>
      ))}
      <label className="column-filter__pattern">
        <span className="column-filter__pattern-label">Name matches</span>
        <input
          type="text"
          className="column-filter__input"
          value={text}
          maxLength={COLUMN_NAME_PATTERN_MAX}
          placeholder="e.g. date, *_at, etl_*"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onTextChange(e.target.value)}
          onBlur={() => commitText(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText(text);
            // The caret keys stay in the box (the canvas has shortcuts of its own).
            if (e.key !== 'Escape') e.stopPropagation();
          }}
        />
      </label>
      <div className="column-filter__hint">
        A name matches anywhere in the column name. Separate names with commas;{' '}
        <code>*</code> stands for any text, <code>?</code> for one character.
      </div>
      <div className="column-filter__footer">
        <span className="column-filter__summary" role="status">
          {summary.columns} {summary.columns === 1 ? 'column' : 'columns'} in {summary.tables} of {summary.total}{' '}
          {summary.total === 1 ? 'table' : 'tables'}
        </span>
        <button
          type="button"
          className="column-filter__reset"
          onClick={reset}
          disabled={filter === null && text === ''}
          title="Back to primary, foreign and natural keys"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export function ColumnFilterMenu() {
  const filter = useEditorStore((s) => s.columnFilter ?? null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const custom = filter !== null;
  const description = describeColumnFilter(filter);

  return (
    <div className="column-filter" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`column-filter__button${custom ? ' column-filter__button--custom' : ''}${open ? ' column-filter__button--open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={custom ? `Choose the columns Keys shows (now: ${description})` : 'Choose the columns Keys shows'}
        title={`Choose the columns Keys shows. Now: ${description}`}
        onClick={() => setOpen((o) => !o)}
      >
        <IconFilter />
        {custom && <span className="column-filter__dot" aria-hidden="true" />}
      </button>
      {open && <ColumnFilterPanel onClose={close} />}
    </div>
  );
}
