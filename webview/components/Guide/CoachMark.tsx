/**
 * One coach mark of the onboarding guide (Show Me Around): a small callout
 * anchored to a real control, with "N of M", Back / Next (or Done), the
 * step's own buttons and **Skip guide**, plus a ring around what it points
 * at. Shared by the canvas (`CanvasGuide`) and the draft page
 * (`webview-draft/components/DraftGuide.tsx`); never part of the renderer
 * package, so the viewer path is untouched.
 *
 * It re-anchors every animation frame while it shows (pan, zoom, a resize, a
 * layout that moves the node), and falls back to a centred card when its
 * anchor is missing or out of view. Its position is set through the CSSOM
 * (`style.setProperty` of `--guide-*` custom properties), which a nonce-only
 * CSP allows; there is no inline style attribute.
 *
 * Keyboard: the step's primary button (else Next) takes the focus when the
 * step shows (the callout itself on a step that waits for a click elsewhere); Tab moves
 * through Back, Next and Skip guide; Esc skips (on the last step, finishes),
 * unless the key was meant for a field, a menu or another dialog.
 */

import { useEffect, useId, useLayoutEffect, useRef } from 'react';

import { placeCallout, type GuideRect, type PlaceOptions } from './coachMarkPlacement';
import './CoachMark.css';

export interface CoachMarkButton {
  label: string;
  onClick(): void;
  primary?: boolean;
  /** Star on GitHub: GitHub's gold, with its star. */
  star?: boolean;
}

/** GitHub's star (Octicons `star-fill-16`, MIT). */
function StarIcon() {
  return (
    <svg className="guide-mark__star-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
    </svg>
  );
}

export interface CoachMarkProps {
  /** Changes with each step: the focus moves to the new step. */
  stepKey: string;
  title: string;
  text: string;
  /** A quieter line under the text (where to run the guide again, on the last card). */
  note?: string;
  /** "2 of 5". */
  progress: string;
  /** The anchor's rect now, or null (a centred card). Called every frame. */
  resolveAnchor(): GuideRect | null;
  prefer?: PlaceOptions['prefer'];
  /** Areas the callout must not cover (the banner's buttons, the toolbar), measured each frame. */
  avoid?: () => GuideRect[];
  /** Draw the ring around the anchor (off for the sidebar step, whose anchor is the editor's edge). */
  ring?: boolean;
  onBack?: () => void;
  /** Absent: the step waits for a click on its anchor (no Next). */
  next?: { label: string; onClick(): void; quiet?: boolean };
  buttons?: readonly CoachMarkButton[];
  skipLabel: string;
  onSkip(): void;
  /** Esc: skip, or finish on the last step. */
  onEscape(): void;
  backLabel: string;
}

type Frame = (cb: () => void) => number;
type CancelFrame = (handle: number) => void;

function frames(): { request: Frame; cancel: CancelFrame } {
  if (typeof window.requestAnimationFrame === 'function') {
    return { request: (cb) => window.requestAnimationFrame(cb), cancel: (h) => window.cancelAnimationFrame(h) };
  }
  return { request: (cb) => window.setTimeout(cb, 16), cancel: (h) => window.clearTimeout(h) };
}

/** A key meant for something else: a field, a menu or another dialog keeps its Esc. */
function escapeBelongsElsewhere(target: EventTarget | null, mark: HTMLElement | null): boolean {
  if (!(target instanceof Element)) return false;
  if (mark && mark.contains(target)) return false;
  if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]')) return true;
  const dialog = target.closest('[role="dialog"], [role="alertdialog"]');
  return dialog !== null && dialog !== mark;
}

export function CoachMark({
  stepKey, title, text, note, progress, resolveAnchor, prefer, avoid, ring: showRing = true, onBack, next, buttons = [], skipLabel, onSkip, onEscape, backLabel,
}: CoachMarkProps) {
  const markRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const resolveRef = useRef(resolveAnchor);
  resolveRef.current = resolveAnchor;
  const avoidRef = useRef(avoid);
  avoidRef.current = avoid;
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const titleId = useId();
  const textId = useId();

  // Place it now and on every frame while it shows: the anchor moves with pan, zoom and layout.
  useLayoutEffect(() => {
    const { request, cancel } = frames();
    let handle = 0;
    let last = '';
    const place = () => {
      const mark = markRef.current;
      const ring = ringRef.current;
      if (!mark || !ring) return;
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const size = { width: mark.offsetWidth, height: mark.offsetHeight };
      const anchor = resolveRef.current();
      const placed = placeCallout(anchor, size, viewport, { ...(prefer ? { prefer } : {}), avoid: avoidRef.current?.() ?? [] });
      const key = JSON.stringify(placed);
      if (key === last) return;
      last = key;
      mark.style.setProperty('--guide-x', `${placed.x}px`);
      mark.style.setProperty('--guide-y', `${placed.y}px`);
      mark.style.setProperty('--guide-arrow', `${placed.arrow}px`);
      mark.setAttribute('data-side', placed.side);
      if (placed.ring && showRing) {
        ring.hidden = false;
        ring.style.setProperty('--guide-ring-x', `${placed.ring.left}px`);
        ring.style.setProperty('--guide-ring-y', `${placed.ring.top}px`);
        ring.style.setProperty('--guide-ring-w', `${placed.ring.width}px`);
        ring.style.setProperty('--guide-ring-h', `${placed.ring.height}px`);
      } else {
        ring.hidden = true;
      }
    };
    const loop = () => {
      place();
      handle = request(loop);
    };
    loop();
    const onResize = () => { last = ''; place(); };
    window.addEventListener('resize', onResize);
    return () => {
      cancel(handle);
      window.removeEventListener('resize', onResize);
    };
  }, [stepKey, prefer, showRing]);

  // The focus follows the step: its first button, or the callout itself while it waits for a click elsewhere.
  useEffect(() => {
    const mark = markRef.current;
    if (!mark) return;
    const first = mark.querySelector<HTMLButtonElement>('[data-guide-focus="true"]');
    (first ?? mark).focus();
  }, [stepKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (escapeBelongsElsewhere(event.target, markRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      escapeRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // The focus goes to the step's primary button (Star on GitHub), else Next / Done, else its first button.
  const primaryButton = buttons.findIndex((b) => b.primary);
  const focusFirst = primaryButton >= 0 ? `button${primaryButton}` : next !== undefined ? 'next' : buttons.length > 0 ? 'button0' : undefined;

  return (
    <>
      <div ref={ringRef} className="guide-ring" aria-hidden="true" hidden />
      <div
        ref={markRef}
        className="guide-mark"
        data-side="centre"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={textId}
        tabIndex={-1}
      >
        <div className="guide-mark__header">
          <h2 className="guide-mark__title" id={titleId}>{title}</h2>
          <span className="guide-mark__progress">{progress}</span>
        </div>
        <p className="guide-mark__text" id={textId}>{text}</p>
        {note && <p className="guide-mark__note">{note}</p>}
        <div className="guide-mark__actions">
          {buttons.map((b, i) => (
            <button
              key={b.label}
              type="button"
              className={`guide-mark__button${b.star ? ' guide-mark__button--star' : b.primary ? ' guide-mark__button--primary' : ''}`}
              data-guide-focus={focusFirst === `button${i}` ? 'true' : undefined}
              onClick={b.onClick}
            >
              {b.star && <StarIcon />}
              {b.label}
            </button>
          ))}
          <span className="guide-mark__spacer" />
          {onBack && (
            <button type="button" className="guide-mark__button" onClick={onBack}>{backLabel}</button>
          )}
          {next && (
            <button
              type="button"
              className={`guide-mark__button${next.quiet ? '' : ' guide-mark__button--primary'}`}
              data-guide-focus={focusFirst === 'next' ? 'true' : undefined}
              onClick={next.onClick}
            >
              {next.label}
            </button>
          )}
        </div>
        <button type="button" className="guide-mark__skip" onClick={onSkip}>{skipLabel}</button>
      </div>
    </>
  );
}
