/**
 * FilesNotShownBanner — "2 things in your files aren't shown on this
 * diagram": the other half of "the canvas follows the files".
 *
 * Every save of a file redraws the canvas by itself, so there is no refresh
 * button. What a refresh button was really asked for is an answer to "I
 * changed a file and the canvas did not change": the file was read, and what
 * was written in it cannot be drawn. The host works out each such thing
 * after every redraw (`filesNotShown`, `src/services/filesNotShown.ts`) and
 * this strip lists them above the diagram, each with the file and line to
 * open, for as long as it is true. It goes by itself when the files are fixed.
 *
 * A strip above the flow area, like the other hints: it never covers a table
 * and never takes the focus. The × hides it until the list changes, except
 * while the picture itself is out of date (the diagram's file does not read,
 * a redraw failed): that is never hidden, so an old picture is never left
 * unexplained. Logical stage only (the physical stage is drawn from dbt).
 */

import React, { useState } from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import { FILE_NOTE_ACTION_LABELS, fileNotesSignature, type FileNote, type FileNoteCode } from '../../../src/types/filesNotShown';
import './FilesNotShownBanner.css';

/** Notes that say the picture itself is old: the strip cannot be hidden while one holds. */
const STALE_PICTURE_CODES: ReadonlySet<FileNoteCode> = new Set(['diagramNotRead', 'diagramUnsaved', 'refreshFailed']);

/** Up to this many notes are listed at once; with more, the list starts folded. */
const OPEN_BY_DEFAULT_MAX = 2;

/** The strip's one-line summary. */
export function filesNotShownLead(items: readonly FileNote[]): string {
  const stale = items.some((n) => STALE_PICTURE_CODES.has(n.code));
  const others = items.filter((n) => !STALE_PICTURE_CODES.has(n.code)).length;
  const things = (n: number): string => (n === 1 ? "1 thing in your files isn't shown on this diagram" : `${n} things in your files aren't shown on this diagram`);
  if (stale) {
    return others > 0
      ? `This diagram may not match your files, and ${things(others)}.`
      : 'This diagram may not match your files.';
  }
  return `${things(others)}.`;
}

export const FilesNotShownBanner: React.FC = () => {
  const stage = useEditorStore((s) => s.domain?.stage);
  const items = useEditorStore((s) => s.filesNotShown);
  const send = useSend();
  // The reader's own choice of folded / unfolded; null follows the default.
  const [open, setOpen] = useState<boolean | null>(null);
  // The list the reader hid: the strip comes back as soon as the list is another one.
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  if (stage !== 'logical' || items.length === 0) { return null; }
  const signature = fileNotesSignature(items);
  const stale = items.some((n) => STALE_PICTURE_CODES.has(n.code));
  if (!stale && hiddenFor === signature) { return null; }

  const expanded = open ?? items.length <= OPEN_BY_DEFAULT_MAX;
  return (
    <div className={`files-not-shown${stale ? ' files-not-shown--stale' : ''}`} role="status">
      <div className="files-not-shown__summary">
        <span className="files-not-shown__icon" aria-hidden="true">&#9888;</span>
        <span className="files-not-shown__lead">{filesNotShownLead(items)}</span>
        <button
          type="button"
          className="files-not-shown__toggle"
          aria-expanded={expanded}
          onClick={() => setOpen(!expanded)}
        >
          {expanded ? 'Hide details' : 'Show details'}
        </button>
        {!stale && (
          <button
            type="button"
            className="files-not-shown__dismiss"
            aria-label="Hide until this list changes"
            title="Hide until this list changes"
            onClick={() => setHiddenFor(signature)}
          >
            &times;
          </button>
        )}
      </div>
      {expanded && (
        <ul className="files-not-shown__list">
          {items.map((note, index) => (
            <li key={`${note.code}:${note.file ?? ''}:${note.line ?? ''}:${index}`} className="files-not-shown__item">
              <span className="files-not-shown__message">{note.message}</span>
              {note.file !== undefined && (
                <button
                  type="button"
                  className="files-not-shown__file"
                  title={`Open ${note.file}${note.line !== undefined ? ` at line ${note.line}` : ''}`}
                  onClick={() => send({
                    type: 'openNotedFile',
                    payload: { file: note.file!, ...(note.line !== undefined ? { line: note.line } : {}) },
                  })}
                >
                  {note.line !== undefined ? `Open at line ${note.line}` : 'Open file'}
                </button>
              )}
              {note.action !== undefined && (
                <button
                  type="button"
                  className="files-not-shown__action"
                  onClick={() => send({ type: note.action! })}
                >
                  {FILE_NOTE_ACTION_LABELS[note.action]}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
