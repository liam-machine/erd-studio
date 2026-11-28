/**
 * TableSubtitleMenu — the toolbar's "Under name" control: one glyph button
 * that says (in its name and hover text) what the line under every table's
 * name shows, and the list it opens.
 *
 *   - the project's table fields (Grain, Purpose, … and the team's own)
 *   - "Not in your list": values the tables on this diagram carry that the
 *     field list does not name (an `owner` with no `fields.yml`)
 *   - Description, and Nothing (no line)
 *
 * A glyph, not a labelled button: the toolbar is centred, so every pixel it
 * gains folds the corner's Feedback and View File labels away two pixels of
 * window sooner (Toolbar.tsx, corner actions). The label and the choice are
 * spelled out where there is room: in the View popover of a narrow editor.
 * The glyph is tinted while the line is anything but the grain.
 *
 * A view preference, not an edit: shown on every stage and on read-only
 * diagrams. A pick switches the canvas at once (the store's `tableSubtitle`)
 * and posts `setTableSubtitle`, which writes the
 * `erdStudio.canvas.tableSubtitle` setting; the host then tells every open
 * canvas the value (`tableSubtitle`), so every diagram follows. A table with
 * no value for the choice shows no line.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_TABLE_SUBTITLE, normaliseTableSubtitle } from '@erd-studio/core';
import { tableSubtitleLabel, tableSubtitleOptions, type TableSubtitleOption } from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import { IconChevronDown } from './toolbarIcons';
import './TableSubtitleMenu.css';

/** The headings the list's groups are shown under (the fields of the list need none). */
export const TABLE_SUBTITLE_GROUP_HEADINGS: Partial<Record<TableSubtitleOption['group'], string>> = {
  carried: 'Not in your list',
  missing: 'Not in this project',
};

const GROUP_ORDER: ReadonlyArray<TableSubtitleOption['group']> = ['list', 'carried', 'missing', 'other'];
const NO_OPTIONS: TableSubtitleOption[] = [];

export function TableSubtitleMenu() {
  const domain = useEditorStore((s) => s.domain);
  const chosen = useEditorStore((s) => normaliseTableSubtitle(s.tableSubtitle ?? DEFAULT_TABLE_SUBTITLE));
  const setTableSubtitle = useEditorStore((s) => s.setTableSubtitle);
  const send = useSend();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The list reads every table on the diagram, so it is built only while the
  // menu is open; the button's own text needs the field list alone.
  const options = useMemo(() => (open ? tableSubtitleOptions(domain, chosen) : NO_OPTIONS), [open, domain, chosen]);
  const shown = useMemo(() => tableSubtitleLabel(chosen, domain?.fields), [chosen, domain?.fields]);

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

  // Opening puts the keyboard on the choice in force, so the arrow keys start from it.
  useEffect(() => {
    if (!open) return;
    const items = panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    if (!items || items.length === 0) return;
    ([...items].find((el) => el.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
  }, [open]);

  /** Escape closes (from the button or the list); the arrow keys, Home and End move through the list. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
        return;
      }
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0 && e.key !== 'Home' && e.key !== 'End') return;
      const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
      if (items.length === 0) return;
      // The canvas has arrow-key shortcuts of its own.
      e.stopPropagation();
      e.preventDefault();
      const at = items.indexOf(e.currentTarget.ownerDocument.activeElement as HTMLButtonElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + step + items.length) % items.length;
      items[next].focus();
    },
    [open, close],
  );

  const choose = useCallback(
    (value: string) => {
      if (value !== normaliseTableSubtitle(useEditorStore.getState().tableSubtitle ?? DEFAULT_TABLE_SUBTITLE)) {
        setTableSubtitle?.(value);
        send({ type: 'setTableSubtitle', payload: { tableSubtitle: value } });
      }
      close();
    },
    [setTableSubtitle, send, close],
  );

  return (
    <div className="table-subtitle" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        className={`table-subtitle__button${open ? ' table-subtitle__button--open' : ''}${chosen !== DEFAULT_TABLE_SUBTITLE ? ' table-subtitle__button--set' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Under name: ${shown}`}
        title={`Under name: ${shown}. Choose what the line under every table's name shows.`}
        onClick={() => setOpen((o) => !o)}
      >
        {/* A table card: its name, and the line under it, which is what this sets. */}
        <svg className="table-subtitle__icon" viewBox="0 0 16 16" aria-hidden="true">
          <rect className="table-subtitle__icon-card" x="2" y="2.5" width="12" height="11" rx="2" />
          <path className="table-subtitle__icon-name" d="M4.75 6 H8.5" />
          <path className="table-subtitle__icon-line" d="M4.75 9.5 H11.25" />
        </svg>
        <span className="table-subtitle__button-text">
          <span className="table-subtitle__button-label">Under name</span>
          <span className="table-subtitle__button-value">{shown}</span>
          <span className="table-subtitle__button-arrow"><IconChevronDown size={11} /></span>
        </span>
      </button>
      {open && (
        <div className="table-subtitle__panel" role="menu" aria-label="The line under every table's name" ref={panelRef}>
          <div className="table-subtitle__title">Under each table&apos;s name, show</div>
          {GROUP_ORDER.map((group) => {
            const rows = options.filter((o) => o.group === group);
            if (rows.length === 0) return null;
            const heading = TABLE_SUBTITLE_GROUP_HEADINGS[group];
            return (
              <div key={group} className={`table-subtitle__group table-subtitle__group--${group}`} role="group" aria-label={heading}>
                {heading && <div className="table-subtitle__heading">{heading}</div>}
                {rows.map((option) => {
                  const on = option.value === chosen;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={on}
                      className={`table-subtitle__option${on ? ' table-subtitle__option--on' : ''}`}
                      tabIndex={on ? 0 : -1}
                      onClick={() => choose(option.value)}
                    >
                      <span className="table-subtitle__tick" aria-hidden="true">{on ? '✓' : ''}</span>
                      <span className="table-subtitle__option-label">{option.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div className="table-subtitle__hint">
            Shown on every diagram. A table with nothing written for it shows no line.
          </div>
        </div>
      )}
    </div>
  );
}
