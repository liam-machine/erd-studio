/**
 * HoverTip — a plain-text hover card for canvas marks, and the hook that drives it.
 *
 * The browser's own `title` attribute is not a reliable tooltip inside a React
 * Flow node: the node is a drag surface, and what the user gets on hover is the
 * grab cursor and nothing else. The canvas already solved this once for column
 * rows (`ColumnTooltip`), so the node header's badges use the same mechanism
 * rather than a second, worse one.
 *
 * Rendered through a portal to document.body, so it is never clipped by the
 * node's `overflow: hidden`, and `pointer-events: none` so it cannot steal a
 * drag. Positioning mirrors ColumnTooltip: centred on the anchor, clamped to
 * the viewport, flipped below when there is no room above, and measured once in
 * a callback ref rather than in an effect that would re-render.
 */

import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './HoverTip.css';

/** Delay before the tip appears, matching ColumnTooltip. */
const HOVER_DELAY_MS = 450;

/** Minimum space (px) above the anchor before the tip flips below. */
const FLIP_THRESHOLD = 60;

/** Gap (px) between anchor and tip. */
const TIP_GAP = 6;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HoverTipProps {
  text: string;
  anchorRef: React.RefObject<HTMLElement | null>;
  visible: boolean;
}

export function HoverTip({ text, anchorRef, visible }: HoverTipProps) {
  const positionRef = useCallback(
    (tip: HTMLDivElement | null) => {
      if (!tip || !anchorRef.current) { return; }

      const anchor = anchorRef.current.getBoundingClientRect();
      const self = tip.getBoundingClientRect();

      let left = anchor.left + anchor.width / 2 - self.width / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - self.width - 8));

      const flipped = anchor.top < FLIP_THRESHOLD + self.height;
      const top = flipped ? anchor.bottom + TIP_GAP : anchor.top - self.height - TIP_GAP;

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
      if (flipped) { tip.classList.add('hover-tip--flipped'); }
      tip.classList.add('hover-tip--visible');
    },
    [anchorRef],
  );

  if (!visible || !text) { return null; }

  return createPortal(
    <div ref={positionRef} className="hover-tip" role="tooltip">{text}</div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseHoverTipReturn<T extends HTMLElement> {
  /**
   * Spread onto the element the tip describes.
   *
   * `ref` is typed as React 18's non-nullable `RefObject<T>` so it can be
   * spread straight onto an intrinsic element; the object underneath is an
   * ordinary mutable ref that starts null, which is what React expects.
   */
  anchorProps: {
    ref: React.RefObject<T>;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    'aria-label': string;
  };
  /** Render this next to the anchor; it portals itself out. */
  tip: React.ReactNode;
}

/**
 * Attach a hover tip to one element.
 *
 * `aria-label` carries the same text, so the explanation is not lost to a
 * screen reader that will never fire a mouseenter.
 */
export function useHoverTip<T extends HTMLElement = HTMLElement>(text: string): UseHoverTipReturn<T> {
  const ref = useRef<T | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);

  const onMouseEnter = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); }
    timer.current = setTimeout(() => setVisible(true), HOVER_DELAY_MS);
  }, []);

  const onMouseLeave = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setVisible(false);
  }, []);

  return {
    anchorProps: { ref: ref as React.RefObject<T>, onMouseEnter, onMouseLeave, 'aria-label': text },
    tip: <HoverTip text={text} anchorRef={ref} visible={visible} />,
  };
}
