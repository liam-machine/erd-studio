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
 * discrepancy panel on the right: side by side on a wide canvas, stacked in
 * one column on a narrow one (`fitsBesideDetail`). The inset is capped so a
 * narrow canvas still leaves room for the table (`compareFocusRightInset`).
 *
 * The widths here mirror CSS: `test/unit/fitViewPadding.test.ts` reads
 * DetailPanel.css and DiscrepancyPanel.css and fails if they drift apart.
 */

import type { FitViewOptions } from '@xyflow/react';

type Padding = NonNullable<FitViewOptions['padding']>;

/** React Flow's default margin around a `<Panel>` (`.react-flow__panel`). */
export const PANEL_MARGIN_PX = 15;
/** Width of the Detail Panel (`.detail-panel` in the renderer). */
export const DETAIL_PANEL_WIDTH_PX = 340;
/** Space between the Compare panel and the Detail Panel side by side (`.disc-panel--beside-detail`). */
export const DISC_PANEL_GAP_PX = 12;
/** `.disc-panel`'s max-width, used when the panel cannot be measured. */
export const DISC_PANEL_MAX_WIDTH_PX = 320;
/** Canvas width the Compare focus always leaves for the table (half of a canvas narrower than twice this). */
export const MIN_FREE_CANVAS_PX = 300;
/**
 * The narrowest canvas that fits the Compare panel beside the Detail Panel
 * and still leaves {@link MIN_FREE_CANVAS_PX}: below it the two stack in the
 * right-hand column, as before the side-by-side layout.
 */
export const BESIDE_DETAIL_MIN_FLOW_PX =
  PANEL_MARGIN_PX + DISC_PANEL_MAX_WIDTH_PX + DISC_PANEL_GAP_PX + DETAIL_PANEL_WIDTH_PX + PANEL_MARGIN_PX + MIN_FREE_CANVAS_PX;
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

/** Whether a canvas `flowWidth` px wide fits the Compare panel beside the Detail Panel. Unmeasured (0) counts as wide. */
export function fitsBesideDetail(flowWidth: number): boolean {
  return !(flowWidth > 0) || flowWidth >= BESIDE_DETAIL_MIN_FLOW_PX;
}

/**
 * The Compare focus's right inset, in px: what the Detail Panel and the
 * Compare panel (`panelWidth` wide) cover at the right of a canvas
 * `flowWidth` px wide, side by side or stacked ({@link fitsBesideDetail}),
 * capped so at least {@link MIN_FREE_CANVAS_PX} (or half the canvas) stays
 * free for the table beside the 0.1 left padding. An unmeasured canvas (0)
 * gets the uncapped side-by-side inset.
 */
export function compareFocusRightInset(flowWidth: number, panelWidth: number): number {
  const covered = fitsBesideDetail(flowWidth)
    ? DETAIL_PANEL_WIDTH_PX + PANEL_MARGIN_PX + DISC_PANEL_GAP_PX + panelWidth + PANEL_MARGIN_PX
    : Math.max(DETAIL_PANEL_WIDTH_PX, panelWidth) + 2 * PANEL_MARGIN_PX;
  if (!(flowWidth > 0)) return covered;
  const room = flowWidth * (1 - BASE_PADDING) - Math.min(MIN_FREE_CANVAS_PX, flowWidth / 2);
  return Math.max(0, Math.min(covered, room));
}

/** Initial-load fit, before the toolbar has been measured. */
export const INITIAL_FIT_VIEW_OPTIONS: FitViewOptions = { padding: fitViewPadding(FALLBACK_TOP_INSET_PX) };
