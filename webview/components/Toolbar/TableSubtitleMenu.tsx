/**
 * TableSubtitleMenu — the toolbar's "Under name" control: one button that
 * says what the line under every table's name shows, and the list it opens.
 *
 *   - the project's table fields (Grain, Purpose, … and the team's own)
 *   - "Not in your list": values the tables on this diagram carry that the
 *     field list does not name (an `owner` with no `fields.yml`)
 *   - Description, and Nothing (no line)
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
import { tableSubtitleOptions, type TableSubtitleOption } from '@erd-studio/renderer/editor';

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

export function TableSubtitleMenu() {
  const domain = useEditorStore((s) => s.domain);
  const chosen = useEditorStore((s) => normaliseTableSubtitle(s.tableSubtitle ?? DEFAULT_TABLE_SUBTITLE));
  const setTableSubtitle = useEditorStore((s) => s.setTableSubtitle);
  const send = useSend();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const options = useMemo(() => tableSubtitleOptions(domain, chosen), [domain, chosen]);
  const current = options.find((o) => o.value === chosen);

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

  const shown = current?.label ?? '';

  return (
    <div className="table-subtitle" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`table-subtitle__button${open ? ' table-subtitle__button--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Under name: ${shown}`}
        title="Choose what the line under every table's name shows"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="table-subtitle__button-label">Under name</span>
        <span className="table-subtitle__button-value">{shown}</span>
        <span className="table-subtitle__button-arrow"><IconChevronDown size={11} /></span>
      </button>
      {open && (
        <div
          className="table-subtitle__panel"
          role="menu"
          aria-label="The line under every table's name"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              close();
            }
          }}
        >
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
