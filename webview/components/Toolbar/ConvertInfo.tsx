/**
 * ConvertInfo — the "i" beside the diagram's name in a project from before
 * 2.0 (YAML/JSON storage), which keeps offering **Convert to DBML…** after
 * the once-a-session offer was answered Not Now (#305).
 *
 * It shows while the host's `convertOffer` says so (the Convert offer's own
 * checks, `convertOfferApplies` in src/services/convertOffer.ts) and only on
 * the logical stage: the physical stage is read-only. It is information, not
 * a prompt: quiet until clicked, and closing its card never hides it. The
 * card's button posts `convertProjectToDbml`, which runs Convert Project to
 * DBML; its panel lists every change before anything is written.
 *
 * Editor only (webview/, never the renderer's viewer).
 */

import React, { useEffect, useId, useRef, useState } from 'react';

import { useSend } from '../../hooks/useMessageBus';
import { useEditorStore } from '../../store/editorStore';
import { IconClose, IconInfo } from './toolbarIcons';
import './ConvertInfo.css';

/** The button's accessible name (and its tooltip). */
export const CONVERT_INFO_LABEL = 'This project is from an older ERD Studio: about converting it to DBML';
export const CONVERT_INFO_TITLE = 'An older ERD Studio format';
/** The card's words: the sidebar row's tooltip (CONVERT_ROW_TOOLTIP), in two sentences. */
export const CONVERT_INFO_TEXT =
  'This project is from an older ERD Studio. Convert it once to DBML, an open format: your tables and diagrams stay as they are, ' +
  'and you see every change before anything is written.';
export const CONVERT_INFO_BUTTON = 'Convert to DBML…';

export const ConvertInfo: React.FC = () => {
  const show = useEditorStore((s) => s.convertOffer);
  const stage = useEditorStore((s) => s.domain?.stage);
  const send = useSend();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const convertRef = useRef<HTMLButtonElement>(null);
  const cardId = useId();
  const titleId = useId();

  const visible = show && stage === 'logical';

  // The card goes with the button (a conversion, a stage switch).
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    convertRef.current?.focus();
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    // Escape closes the card without reaching the canvas shortcut handler
    // (which would clear the selection behind it), and gives focus back to the "i".
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    window.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  if (!visible) return null;

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  return (
    <span className="convert-info" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`toolbar__button convert-info__button${open ? ' convert-info__button--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={CONVERT_INFO_LABEL}
        aria-label={CONVERT_INFO_LABEL}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
      >
        <IconInfo />
      </button>
      {open && (
        <div className="convert-info__card" id={cardId} role="dialog" aria-labelledby={titleId}>
          <div className="convert-info__header">
            <span className="convert-info__title" id={titleId}>{CONVERT_INFO_TITLE}</span>
            <button type="button" className="convert-info__close" onClick={close} aria-label="Close" title="Close">
              <IconClose size={14} />
            </button>
          </div>
          <p className="convert-info__text">{CONVERT_INFO_TEXT}</p>
          <button
            ref={convertRef}
            type="button"
            className="convert-info__convert"
            onClick={() => {
              send({ type: 'convertProjectToDbml' });
              close();
            }}
          >
            {CONVERT_INFO_BUTTON}
          </button>
        </div>
      )}
    </span>
  );
};
