/**
 * ColumnFilterMenu — the toolbar's Columns control: one button that says
 * which columns every table shows, and the checklist it opens.
 *
 *   - All columns
 *   - any of primary keys, foreign keys and natural (business) keys, plus the
 *     columns whose name matches a pattern: a column is shown when it matches
 *     any rule that is ticked
 *   - nothing ticked: table names only
 *
 * It replaced the Names / Keys / All switch (#359), and drives the same
 * state: the diagram's table detail level (`all`, `keys`, `name`) and, at
 * `keys`, the column filter. A view preference: shown on every stage and on
 * read-only diagrams, kept per diagram in the webview's own state
 * (useStatePersistence) and never posted to the host or written to a file.
 *
 * A change of level puts every table at it, closing the tables opened on
 * their own; a change of rule at the same level leaves them open.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  COLUMN_NAME_PATTERN_MAX,
  columnNameTerms,
  resolveVisibleColumns,
  type ColumnFilter,
  type TableDetail,
} from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import { IconChevronDown } from './toolbarIcons';
import './ColumnFilterMenu.css';

/** How long the pattern box waits after the last keystroke before the diagram redraws. */
export const COLUMN_PATTERN_DEBOUNCE_MS = 150;

type KeyRule = 'primaryKeys' | 'foreignKeys' | 'naturalKeys';
type Rules = Required<ColumnFilter>;

/** The three key rules, in menu order, with their labels. */
export const COLUMN_FILTER_RULES: ReadonlyArray<{ key: KeyRule; label: string; badge: string }> = [
  { key: 'primaryKeys', label: 'Primary keys', badge: 'PK' },
  { key: 'foreignKeys', label: 'Foreign keys', badge: 'FK' },
  { key: 'naturalKeys', label: 'Natural (business) keys', badge: 'NK' },
];

const NO_RULES: Rules = { primaryKeys: false, foreignKeys: false, naturalKeys: false, namePattern: '' };

/**
 * The rules the checklist shows as ticked. At `name` nothing is; otherwise
 * the filter, where null is the three key kinds and no pattern.
 */
function rulesOf(level: TableDetail | null, filter: ColumnFilter | null): Rules {
  if (level === 'name') return NO_RULES;
  return {
    primaryKeys: filter?.primaryKeys !== false,
    foreignKeys: filter?.foreignKeys !== false,
    naturalKeys: filter?.naturalKeys !== false,
    namePattern: filter?.namePattern ?? '',
  };
}

function hasNoRule(rules: Rules): boolean {
  return !rules.primaryKeys && !rules.foreignKeys && !rules.naturalKeys && columnNameTerms(rules.namePattern).length === 0;
}

/** What the tables show, in a few words (the button's text). */
export function describeColumns(level: TableDetail | null, filter: ColumnFilter | null): string {
  if (level === null) return '';
  if (level === 'all') return 'All';
  if (level === 'name') return 'Names only';
  if (filter === null) return 'Keys';
  const rules = rulesOf(level, filter);
  const parts = [
    ...COLUMN_FILTER_RULES.filter((r) => rules[r.key]).map((r) => r.badge),
    ...columnNameTerms(rules.namePattern),
  ];
  return parts.length > 0 ? parts.join(', ') : 'Names only';
}

const NO_NODES: never[] = [];

function ColumnFilterPanel({ onClose }: { onClose: () => void }) {
  const level = useEditorStore((s) => s.tableDetail ?? null);
  const filter = useEditorStore((s) => s.columnFilter ?? null);
  const setColumnFilter = useEditorStore((s) => s.setColumnFilter);
  const setTableDetail = useEditorStore((s) => s.setTableDetail);
  const nodes = useEditorStore((s) => s.nodes ?? NO_NODES);
  const all = level === 'all';
  const current = rulesOf(level, filter);

  // The box keeps its own text and hands it on shortly after the last
  // keystroke, so a large diagram redraws once per pause, not once per letter.
  const [text, setText] = useState(current.namePattern);
  const timerRef = useRef<number | null>(null);
  const cancelTimer = () => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Go to a level, only when it is a change: choosing the level already on would close the opened tables. */
  const goTo = useCallback(
    (next: TableDetail) => {
      if ((useEditorStore.getState().tableDetail ?? null) !== next) setTableDetail(next);
    },
    [setTableDetail],
  );

  /** Show the columns `rules` match: the `keys` level under that filter, or names only when no rule is on. */
  const apply = useCallback(
    (rules: Rules) => {
      if (hasNoRule(rules)) {
        setColumnFilter(null);
        goTo('name');
      } else {
        setColumnFilter(rules);
        goTo('keys');
      }
    },
    [goTo, setColumnFilter],
  );

  const commitText = useCallback(
    (value: string) => {
      cancelTimer();
      const state = useEditorStore.getState();
      if ((state.tableDetail ?? null) === 'all') return;
      const latest = rulesOf(state.tableDetail ?? null, state.columnFilter ?? null);
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
    cancelTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      commitText(value);
    }, COLUMN_PATTERN_DEBOUNCE_MS);
  };

  const toggleRule = (key: KeyRule) => {
    // The pattern as typed, in case its pause has not run out yet.
    cancelTimer();
    apply({ ...current, namePattern: text, [key]: !current[key] });
  };

  const toggleAll = () => {
    cancelTimer();
    if (!all) {
      goTo('all');
    } else if (hasNoRule(rulesOf('keys', filter))) {
      goTo('name');
    } else {
      goTo('keys');
    }
  };

  const keysOnly = () => {
    cancelTimer();
    setText('');
    setColumnFilter(null);
    goTo('keys');
  };

  // Where the choice lands: the same call every table makes for its rows.
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
        tableDetail: level ?? 'all',
        columnFilter: filter,
      }).columns.length;
      columns += shown;
      if (shown > 0) tables++;
    }
    return { columns, tables, total };
  }, [nodes, level, filter]);

  return (
    <div
      className="column-filter__panel"
      role="dialog"
      aria-label="Columns to show"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          // Escape leaves: a pattern still waiting for its pause is dropped, not applied.
          cancelTimer();
          onClose();
        }
      }}
    >
      <label className="column-filter__rule column-filter__rule--all">
        <input type="checkbox" className="column-filter__checkbox" checked={all} onChange={toggleAll} />
        <span className="column-filter__rule-label">All columns</span>
      </label>
      <div className="column-filter__heading">
        {all ? 'Untick to choose which columns to show:' : 'Show a column when it is any of:'}
      </div>
      {COLUMN_FILTER_RULES.map((rule) => (
        <label key={rule.key} className={`column-filter__rule${all ? ' column-filter__rule--off' : ''}`}>
          <input
            type="checkbox"
            className="column-filter__checkbox"
            checked={current[rule.key]}
            disabled={all}
            onChange={() => toggleRule(rule.key)}
          />
          <span className="column-filter__rule-label">{rule.label}</span>
          <span className="column-filter__badge" aria-hidden="true">{rule.badge}</span>
        </label>
      ))}
      <label className={`column-filter__pattern${all ? ' column-filter__rule--off' : ''}`}>
        <span className="column-filter__pattern-label">Name matches</span>
        <input
          type="text"
          className="column-filter__input"
          value={text}
          disabled={all}
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
        <code>*</code> stands for any text, <code>?</code> for one character. With nothing ticked,
        tables show their names only.
      </div>
      <div className="column-filter__footer">
        <span className="column-filter__summary" role="status">
          {summary.columns} {summary.columns === 1 ? 'column' : 'columns'} in {summary.tables} of {summary.total}{' '}
          {summary.total === 1 ? 'table' : 'tables'}
        </span>
        <button
          type="button"
          className="column-filter__reset"
          onClick={keysOnly}
          disabled={level === 'keys' && filter === null && text === ''}
          title="Show primary, foreign and natural keys"
        >
          Keys only
        </button>
      </div>
    </div>
  );
}

export function ColumnFilterMenu() {
  // Until the diagram has loaded there is no level, and the button says only "Columns".
  const level = useEditorStore((s) => s.tableDetail ?? null);
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

  const shown = describeColumns(level, filter);

  return (
    <div className="column-filter" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`column-filter__button${open ? ' column-filter__button--open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={shown ? `Columns: ${shown}` : 'Columns'}
        title="Choose the columns every table shows"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="column-filter__button-label">Columns</span>
        {shown && <span className="column-filter__button-value">{shown}</span>}
        <span className="column-filter__button-arrow"><IconChevronDown size={11} /></span>
      </button>
      {open && <ColumnFilterPanel onClose={close} />}
    </div>
  );
}
