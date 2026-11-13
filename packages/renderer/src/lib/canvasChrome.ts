/**
 * Canvas chrome geometry: how big the minimap is, how much room the counts
 * pill has at the bottom-left, and how tall the legend may grow, all from the
 * size of the canvas (React Flow's pane). One pure module, shared by the
 * editor and the viewer (`ErdCanvas`), so the floating pieces agree with each
 * other at every size: a short frame embedded in a page (about 760 × 380), a
 * narrow VS Code editor column and a full screen.
 *
 * The layout this keeps clear (theme.css, "Floating shell"):
 *
 *   bottom-left   the legend's ? button, the counts pill beside it
 *   bottom-right  the minimap (left of the editor's detail panel when open)
 *   top-right     the detail panel (the editor's runs down the right edge;
 *                 the viewer's stops above the minimap row)
 *
 * A width or height of 0 means "not measured yet" (the first render, or a
 * test without layout): everything is then as large as it was before this
 * module existed, so nothing shrinks by mistake.
 */

/** React Flow's panel margin, the `--shell-inset` token (theme.css). */
export const SHELL_INSET = 15;
/** Space between two floating layers, the `--shell-gap` token. */
export const SHELL_GAP = 10;
/** The legend's ? button, the `--shell-control-size` token. */
export const SHELL_CONTROL = 28;
/** The editor's detail panel width, the `--detail-panel-width` token. */
export const DETAIL_PANEL_WIDTH = 340;
/** The open legend's widest (Legend.css `max-width`). */
export const LEGEND_WIDTH = 260;

/** The minimap at its largest: React Flow's default, and its size before this module. */
export const MINIMAP_MAX = { width: 200, height: 150 } as const;
/** The smallest minimap worth drawing; below it the tile is hidden instead. */
export const MINIMAP_MIN_WIDTH = 96;
/** Share of the canvas width the minimap may take. */
const MINIMAP_WIDTH_SHARE = 0.16;
/** Share of the canvas height the minimap may take. */
const MINIMAP_HEIGHT_SHARE = 0.24;
/** Below this width or height there is no minimap: it would only cover tables. */
export const MINIMAP_HIDE_BELOW = { width: 480, height: 260 } as const;

/** A canvas size, as React Flow measures its pane (`width` / `height`). */
export interface CanvasSize {
  width: number;
  height: number;
}

/** The minimap's size in pixels, or null when it is hidden. */
export interface MinimapSize {
  width: number;
  height: number;
}

const measured = (n: number): boolean => Number.isFinite(n) && n > 0;

/**
 * The minimap for a canvas (or the part of it left of the editor's detail
 * panel): a modest share of a small canvas, never larger than today's 200 ×
 * 150, in the same 4:3 shape, and none at all below
 * {@link MINIMAP_HIDE_BELOW}. Unmeasured: the full size.
 */
export function minimapSize(canvas: CanvasSize): MinimapSize | null {
  const { width, height } = canvas;
  if (!measured(width) || !measured(height)) return { ...MINIMAP_MAX };
  if (width < MINIMAP_HIDE_BELOW.width || height < MINIMAP_HIDE_BELOW.height) return null;
  const byWidth = width * MINIMAP_WIDTH_SHARE;
  const byHeight = (height * MINIMAP_HEIGHT_SHARE * MINIMAP_MAX.width) / MINIMAP_MAX.height;
  const w = Math.round(Math.min(MINIMAP_MAX.width, Math.max(MINIMAP_MIN_WIDTH, Math.min(byWidth, byHeight))));
  return { width: w, height: Math.round((w * MINIMAP_MAX.height) / MINIMAP_MAX.width) };
}

/** What decides the chrome's layout, besides the canvas size. */
export interface ChromeState {
  /** The viewer (`ErdCanvas`): its detail panel stops above the minimap row. */
  viewer: boolean;
  /** The editor's detail panel is on screen (a tall sheet down the right edge). */
  editorPanelShown: boolean;
  /** The legend is open (the counts move to its right). */
  legendOpen: boolean;
}

/** Where everything at the canvas's edges goes. */
export interface CanvasChrome {
  /** The minimap's size, or null when hidden. */
  minimap: MinimapSize | null;
  /**
   * How far the counts pill starts from the canvas's left edge: clear of
   * the ? button, or of the open legend.
   */
  statusBarLeft: number;
  /** The widest the counts pill may be, or null when the canvas is not measured yet. */
  statusBarRoom: number | null;
  /** The tallest the legend panel may be, or null when the canvas is not measured yet. */
  legendMaxHeight: number | null;
  /**
   * How much of the canvas's height, from the bottom, the viewer's detail
   * panel leaves free: the minimap's row (or the counts row when there is
   * no minimap).
   */
  panelBottomReserve: number;
}

/** The bottom row's height: the ? button and the counts pill, with their margin and a gap. */
const BOTTOM_ROW = SHELL_INSET + SHELL_CONTROL + SHELL_GAP;

/** Lay out the canvas's chrome for its size and state. */
export function canvasChrome(canvas: CanvasSize, state: ChromeState): CanvasChrome {
  const isMeasured = measured(canvas.width) && measured(canvas.height);
  const panelReserve = state.editorPanelShown && !state.viewer ? DETAIL_PANEL_WIDTH + SHELL_GAP : 0;
  const minimap = minimapSize({ width: isMeasured ? canvas.width - panelReserve : canvas.width, height: canvas.height });

  // The open legend covers the bottom-left corner: the pill moves to its right.
  const besideLegend = state.legendOpen;
  const statusBarLeft = besideLegend
    ? SHELL_INSET + LEGEND_WIDTH + SHELL_GAP
    : SHELL_INSET + SHELL_CONTROL + SHELL_GAP;
  const rightReserve = SHELL_INSET + panelReserve + (minimap ? minimap.width + SHELL_GAP : 0);
  const statusBarRoom = isMeasured ? Math.max(0, Math.floor(canvas.width - statusBarLeft - rightReserve)) : null;

  // The legend sits on the bottom margin and may reach to the top margin.
  const legendMaxHeight = isMeasured ? Math.max(120, Math.floor(canvas.height - 2 * SHELL_INSET)) : null;
  const panelBottomReserve = Math.max(BOTTOM_ROW, minimap ? SHELL_INSET + minimap.height + SHELL_GAP : 0);

  return { minimap, statusBarLeft, statusBarRoom, legendMaxHeight, panelBottomReserve };
}

// ---------------------------------------------------------------------------
// The counts pill: what to drop so it never wraps
// ---------------------------------------------------------------------------

/** One layer chip of the pill (`StatusBarLayer`'s text). */
export interface PillLayer {
  abbreviation: string;
  label: string;
  count: number;
}

/**
 * How the pill fits its room, from the most to the least it shows:
 *
 * - `full`: the counts and every layer as badge, name and count ("[SLV] Silver 6")
 * - `badges`: the layer names dropped ("[SLV] 6"), the name in the tooltip
 * - `some`: the first `shownLayers` badges and a "+N" chip for the rest
 * - `counts`: the counts alone, the layers in the tooltip
 * - `truncate`: the counts cut off with an ellipsis (still one line)
 * - `hidden`: nothing (the pill beside the open legend, on a canvas with
 *   no room for it; it comes back when the legend closes)
 */
export type PillMode = 'full' | 'badges' | 'some' | 'counts' | 'truncate' | 'hidden';

export interface PillFit {
  mode: PillMode;
  /** Layer chips drawn (all of them in `full` / `badges`). */
  shownLayers: number;
}

// Width estimates for the pill's text (StatusBar.css: 11px medium UI text,
// 9px bold capitals in the badges), on the generous side so an estimate
// that is a little short still fits; the CSS truncates if one is not.
const CHAR = 6.6;
const BADGE_CHAR = 7;
const BADGE_PAD = 8;
const PILL_PAD = 2 * 12 + 2;
const GAP = 8;
const LAYER_GAP = 12;
const DIVIDER = 1 + 2 * GAP;

const textWidth = (s: string): number => s.length * CHAR;
const badgeWidth = (abbreviation: string): number => abbreviation.length * BADGE_CHAR + BADGE_PAD;

/** The pill's width for each way of showing it (pure, for {@link fitStatusBar} and its tests). */
export function pillWidths(counts: { tables: string; relationships: string }, layers: readonly PillLayer[]) {
  const countsWidth = PILL_PAD + textWidth(counts.tables) + DIVIDER + textWidth(counts.relationships);
  const chipsWidth = (chips: number[]): number =>
    chips.length === 0 ? 0 : DIVIDER + chips.reduce((a, b) => a + b, 0) + LAYER_GAP * (chips.length - 1);
  const full = countsWidth + chipsWidth(layers.map((l) => badgeWidth(l.abbreviation) + 4 + textWidth(`${l.label} ${l.count}`)));
  const badgeChips = layers.map((l) => badgeWidth(l.abbreviation) + 4 + textWidth(String(l.count)));
  const badges = countsWidth + chipsWidth(badgeChips);
  /** The first `k` badge chips and a "+N" chip for the rest. */
  const some = (k: number): number =>
    countsWidth + chipsWidth([...badgeChips.slice(0, k), textWidth(`+${layers.length - k}`) + BADGE_PAD]);
  return { counts: countsWidth, full, badges, some };
}

/**
 * Decide how the counts pill shows in `room` pixels without wrapping: the
 * layer names go first, then layer chips (into a "+N"), then every layer
 * chip, keeping the table and relationship counts; truncating the counts is
 * the last resort. `room` null (not measured): everything. `hideIfCramped`
 * (the pill beside the open legend): hidden rather than truncated.
 */
export function fitStatusBar(
  counts: { tables: string; relationships: string },
  layers: readonly PillLayer[],
  room: number | null,
  hideIfCramped = false,
): PillFit {
  const all = layers.length;
  if (room === null) return { mode: all > 0 ? 'full' : 'counts', shownLayers: all };
  const w = pillWidths(counts, layers);
  if (all > 0) {
    if (w.full <= room) return { mode: 'full', shownLayers: all };
    if (w.badges <= room) return { mode: 'badges', shownLayers: all };
    // Keep at least one badge beside the "+N"; one "+N" alone says too little.
    for (let k = all - 1; k >= 1; k--) {
      if (w.some(k) <= room) return { mode: 'some', shownLayers: k };
    }
  }
  if (w.counts <= room) return { mode: 'counts', shownLayers: 0 };
  return { mode: hideIfCramped ? 'hidden' : 'truncate', shownLayers: 0 };
}
