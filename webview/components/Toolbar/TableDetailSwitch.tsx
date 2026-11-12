/**
 * TableDetailSwitch — the toolbar's three-option control for how much of
 * every table the diagram draws: Names, Keys or All.
 *
 * A view preference, not an edit: shown on every stage and on read-only
 * diagrams, kept per diagram in the webview's own state (useStatePersistence)
 * and never posted to the host or written to a file. Choosing a level puts
 * every table at it, closing the tables opened on their own; choosing the
 * level already on does the same, which is the way back from them.
 *
 * A radio group: one tab stop, the arrow keys (and Home / End) move and choose.
 */

import { useCallback, useRef, type KeyboardEvent } from 'react';
import { TABLE_DETAILS, type TableDetail } from '@erd-studio/renderer/editor';

import { useEditorStore } from '../../store/editorStore';
import './TableDetailSwitch.css';

/** Each option's label, accessible name and hover text. */
export const TABLE_DETAIL_LABELS: Record<TableDetail, { label: string; name: string; title: string }> = {
  name: { label: 'Names', name: 'Table names only', title: 'Table names only: no columns' },
  keys: { label: 'Keys', name: 'Key columns only', title: 'Key columns only: primary, foreign and natural keys' },
  all: { label: 'All', name: 'All columns', title: 'All columns' },
};

export function TableDetailSwitch() {
  // Until the diagram has loaded there is no level; no option is on then.
  const tableDetail = useEditorStore((s) => s.tableDetail ?? null);
  const setTableDetail = useEditorStore((s) => s.setTableDetail);
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      const current = TABLE_DETAILS.indexOf(tableDetail ?? 'all');
      let next: number;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (current + 1) % TABLE_DETAILS.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (current + TABLE_DETAILS.length - 1) % TABLE_DETAILS.length;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = TABLE_DETAILS.length - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
      setTableDetail(TABLE_DETAILS[next]);
      groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
    },
    [setTableDetail, tableDetail],
  );

  return (
    <div
      ref={groupRef}
      className="table-detail-switch"
      role="radiogroup"
      aria-label="Table detail"
      onKeyDown={onKeyDown}
    >
      {TABLE_DETAILS.map((level, index) => {
        const on = level === tableDetail;
        // One tab stop: the option that is on, or the first when none is.
        const tabbable = on || (tableDetail === null && index === 0);
        return (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={tabbable ? 0 : -1}
            className={`table-detail-switch__option${on ? ' table-detail-switch__option--on' : ''}`}
            aria-label={TABLE_DETAIL_LABELS[level].name}
            title={TABLE_DETAIL_LABELS[level].title}
            onClick={() => setTableDetail(level)}
          >
            {TABLE_DETAIL_LABELS[level].label}
          </button>
        );
      })}
    </div>
  );
}
