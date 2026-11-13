/**
 * A gentle reveal: bring a table (or a relationship's two tables) into view
 * without touching the zoom, and without moving the view at all when it is
 * already fully in sight. A sidebar row's click selects its table this way
 * (`RevealTableMessage.gentle`, `RevealRelationshipMessage.gentle`): the user
 * keeps the zoom and place they chose, and the view moves only as far as it
 * must.
 *
 * "In sight" means inside the canvas minus what floats over it: the toolbar
 * along the top, the corner buttons, and the detail panel on the right when
 * it is open ({@link FLOATING_PANEL_SELECTOR}). A box that fits is moved the
 * least distance that puts it inside with {@link REVEAL_MARGIN} to spare; one
 * larger than the free area shows its start (a tall table its header) or its
 * middle (two tables far apart), per axis.
 *
 * The geometry is pure ({@link canvasInsets}, {@link gentlePan}); {@link
 * revealGently} reads React Flow and the DOM and applies it.
 */

/** A rectangle in screen pixels, relative to the canvas's own top-left. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** What floats over the canvas and hides part of it (the editor's toolbar, its corner buttons, the detail panel). */
export const FLOATING_PANEL_SELECTOR = '.toolbar-container .toolbar__island, .toolbar-container .stage-tabs, .toolbar__corner, .detail-panel';

/** The room left around a box brought into view, in screen pixels (shrunk when the free area is small). */
export const REVEAL_MARGIN = 48;

/** How long the pan takes, when there is one. */
export const REVEAL_PAN_MS = 250;

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The size a VS Code webview reports while its tab is behind another: the
 * HTML default for an iframe with no size of its own (300 × 150). Its timers
 * keep running there, so a reveal that runs then would read a table in plain
 * sight as out of it and pan the view, a pan that lands when the tab comes
 * back. The host's `canvasVisibility` says so too, but only after the
 * webview has already been laid out at this size (a row's double-click opens
 * the file over the canvas just as its first click's reveal runs).
 */
export const HIDDEN_WEBVIEW_SIZE = { width: 300, height: 150 } as const;

/** The webview is laid out at {@link HIDDEN_WEBVIEW_SIZE}: behind another tab, so nothing in it can be measured. */
export function isBehindAnotherTab(win: Pick<Window, 'innerWidth' | 'innerHeight'> = window): boolean {
  return win.innerWidth === HIDDEN_WEBVIEW_SIZE.width && win.innerHeight === HIDDEN_WEBVIEW_SIZE.height;
}

/**
 * How far each floating panel eats into the canvas, from the side it hugs:
 * for each panel over the canvas, the side that loses the least to it (the
 * toolbar along the top costs its height there, the detail panel on the right
 * its width there). The largest per side wins.
 */
export function canvasInsets(canvas: Box, panels: readonly Box[]): Insets {
  const out = { ...NO_INSETS };
  for (const p of panels) {
    // Not over the canvas, or not drawn (a zero box): nothing hidden.
    if (p.right <= canvas.left || p.left >= canvas.right || p.bottom <= canvas.top || p.top >= canvas.bottom) continue;
    if (p.right - p.left <= 0 || p.bottom - p.top <= 0) continue;
    const sides: Array<[keyof Insets, number]> = [
      ['top', p.bottom - canvas.top],
      ['bottom', canvas.bottom - p.top],
      ['left', p.right - canvas.left],
      ['right', canvas.right - p.left],
    ];
    const [side, cost] = sides.reduce((best, s) => (s[1] < best[1] ? s : best));
    if (cost > 0) out[side] = Math.max(out[side], cost);
  }
  return out;
}

/** The shift along one axis that brings [lo, hi] inside [min, max] (see {@link gentlePan}). */
function shiftAxis(lo: number, hi: number, min: number, max: number, margin: number, oversize: 'start' | 'center'): number {
  // Already wholly in sight: never moved.
  if (lo >= min && hi <= max) return 0;
  const room = max - min;
  const size = hi - lo;
  const m = Math.max(0, Math.min(margin, (room - size) / 2));
  if (size + 2 * m <= room) {
    // Fits: the least move that puts it inside with the margin.
    if (lo < min + m) return min + m - lo;
    return max - m - hi;
  }
  // Larger than the free area: its start (a table's header), or its middle.
  return oversize === 'start' ? min + Math.min(margin, room / 4) - lo : (min + max) / 2 - (lo + hi) / 2;
}

/**
 * The pan (screen pixels, added to the viewport's x and y) that brings
 * `target` into the canvas's free area (`size` less `insets`), or 0 and 0
 * when it is wholly there already. The zoom is never part of it.
 */
export function gentlePan(
  target: Box,
  size: { width: number; height: number },
  insets: Insets = NO_INSETS,
  options: { margin?: number; oversize?: 'start' | 'center' } = {},
): { dx: number; dy: number } {
  const margin = options.margin ?? REVEAL_MARGIN;
  const oversize = options.oversize ?? 'start';
  const minX = insets.left;
  const maxX = size.width - insets.right;
  const minY = insets.top;
  const maxY = size.height - insets.bottom;
  // A canvas with no free area (not laid out yet): leave it.
  if (maxX <= minX || maxY <= minY) return { dx: 0, dy: 0 };
  return {
    dx: shiftAxis(target.left, target.right, minX, maxX, margin, oversize),
    dy: shiftAxis(target.top, target.bottom, minY, maxY, margin, oversize),
  };
}

/** What {@link revealGently} needs of React Flow (`useReactFlow()`). */
export interface GentleFlow {
  getViewport(): { x: number; y: number; zoom: number };
  setViewport(viewport: { x: number; y: number; zoom: number }, options?: { duration?: number }): unknown;
  getInternalNode(id: string): {
    internals: { positionAbsolute: { x: number; y: number } };
    measured?: { width?: number; height?: number };
    width?: number;
    height?: number;
  } | undefined;
}

/**
 * Bring the nodes `ids` into view at the current zoom, panning only when
 * they are not wholly in sight (see the module comment). Returns whether it
 * panned. Reads the canvas (`.react-flow`) and the panels over it from `doc`.
 */
export function revealGently(
  flow: GentleFlow,
  ids: readonly string[],
  oversize: 'start' | 'center' = 'start',
  doc: Pick<Document, 'querySelector' | 'querySelectorAll'> = document,
): boolean {
  const viewport = flow.getViewport();
  let flowBox: Box | undefined;
  for (const id of ids) {
    const node = flow.getInternalNode(id);
    if (!node) continue;
    const { x, y } = node.internals.positionAbsolute;
    const w = node.measured?.width ?? node.width ?? 0;
    const h = node.measured?.height ?? node.height ?? 0;
    flowBox = flowBox
      ? { left: Math.min(flowBox.left, x), top: Math.min(flowBox.top, y), right: Math.max(flowBox.right, x + w), bottom: Math.max(flowBox.bottom, y + h) }
      : { left: x, top: y, right: x + w, bottom: y + h };
  }
  const pane = doc.querySelector('.react-flow');
  if (!flowBox || !pane) return false;
  const rect = pane.getBoundingClientRect();
  const canvas: Box = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  // The panels in the canvas's own coordinates, as the target is.
  const panels = Array.from(doc.querySelectorAll(FLOATING_PANEL_SELECTOR)).map((el): Box => {
    const r = el.getBoundingClientRect();
    return { left: r.left - canvas.left, top: r.top - canvas.top, right: r.right - canvas.left, bottom: r.bottom - canvas.top };
  });
  const size = { width: canvas.right - canvas.left, height: canvas.bottom - canvas.top };
  const insets = canvasInsets({ left: 0, top: 0, right: size.width, bottom: size.height }, panels);
  const z = viewport.zoom;
  const target: Box = {
    left: flowBox.left * z + viewport.x,
    top: flowBox.top * z + viewport.y,
    right: flowBox.right * z + viewport.x,
    bottom: flowBox.bottom * z + viewport.y,
  };
  const { dx, dy } = gentlePan(target, size, insets, { oversize });
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false;
  void flow.setViewport({ x: viewport.x + dx, y: viewport.y + dy, zoom: z }, { duration: REVEAL_PAN_MS });
  return true;
}
