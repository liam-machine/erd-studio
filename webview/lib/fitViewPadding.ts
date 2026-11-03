/**
 * fitView padding that keeps the canvas chrome off the tables.
 *
 * The toolbar (and the stage tabs under it) floats over the top of the
 * canvas, so a plain `padding: 0.1` fit puts the top row of cards under it.
 * The top padding here is the toolbar's real bottom edge, measured from the
 * DOM, plus a gap; the other sides keep the old 0.1. When the toolbar cannot
 * be measured (first paint, tests) a fallback inset close to its usual
 * height is used.
 *
 * The Compare focus (DiscrepancyPanel) also passes a right inset, so the
 * table it zooms to is not hidden behind the Detail Panel and the
 * discrepancy panel that sit side by side on the right.
 */

import type { FitViewOptions } from '@xyflow/react';

type Padding = NonNullable<FitViewOptions['padding']>;

/** React Flow's default margin around a `<Panel>` (`.react-flow__panel`). */
export const PANEL_MARGIN_PX = 15;
/** Width of the Detail Panel (`.detail-panel` in the renderer). */
export const DETAIL_PANEL_WIDTH_PX = 340;
/** Space between the toolbar's bottom edge and the first row of cards. */
export const TOOLBAR_GAP_PX = 12;
/**
 * The toolbar plus stage tabs are about 70px tall, under a 15px margin. Used
 * until the toolbar can be measured.
 */
export const FALLBACK_TOP_INSET_PX = 96;

/** The side padding the canvas has always used. */
const BASE_PADDING = 0.1;

/**
 * How far the floating toolbar reaches into the flow area, in px from the
 * flow's top edge, plus {@link TOOLBAR_GAP_PX}. Falls back to
 * {@link FALLBACK_TOP_INSET_PX} when either element is missing or unmeasured.
 */
export function measureTopInset(toolbar: Element | null | undefined, flow: Element | null | undefined): number {
  if (!toolbar || !flow) return FALLBACK_TOP_INSET_PX;
  const t = toolbar.getBoundingClientRect();
  const f = flow.getBoundingClientRect();
  if (t.height === 0) return FALLBACK_TOP_INSET_PX;
  return Math.max(0, Math.round(t.bottom - f.top)) + TOOLBAR_GAP_PX;
}

/** Measure from any element inside the canvas (the toolbar row, a panel). */
export function measureTopInsetFrom(inside: Element | null | undefined): number {
  const toolbar = inside?.closest('.react-flow')?.querySelector('.toolbar-container')
    ?? (typeof document !== 'undefined' ? document.querySelector('.toolbar-container') : null);
  return measureTopInset(toolbar, toolbar?.closest('.react-flow'));
}

/** fitView padding: `topPx` at the top, optionally `rightPx` at the right, 0.1 elsewhere. */
export function fitViewPadding(topPx: number, rightPx?: number): Padding {
  return {
    top: `${Math.round(topPx)}px`,
    right: rightPx !== undefined ? `${Math.round(rightPx)}px` : BASE_PADDING,
    bottom: BASE_PADDING,
    left: BASE_PADDING,
  };
}

/** Initial-load fit, before the toolbar has been measured. */
export const INITIAL_FIT_VIEW_OPTIONS: FitViewOptions = { padding: fitViewPadding(FALLBACK_TOP_INSET_PX) };
