/**
 * The canvas chrome's geometry (lib/canvasChrome.ts): the minimap's size,
 * the counts pill's room and what it drops so it never wraps, the legend's
 * height and the viewer's detail panel reserve, at the sizes the canvas is
 * really shown at: a short embedded frame (about 760 × 380), its
 * full-screen mode, a narrow and a wide VS Code editor.
 */
import { describe, it, expect } from 'vitest';
import {
  canvasChrome,
  fitStatusBar,
  minimapSize,
  pillWidths,
  MINIMAP_MAX,
  MINIMAP_HIDE_BELOW,
  MINIMAP_MIN_WIDTH,
} from '../../src/lib/canvasChrome';

const VIEWER = { viewer: true, editorPanelShown: false, legendOpen: false };
const EDITOR = { viewer: false, editorPanelShown: false, legendOpen: false };

describe('minimapSize', () => {
  it('is today\'s 200 × 150 on a big canvas, never larger', () => {
    expect(minimapSize({ width: 1600, height: 1000 })).toEqual(MINIMAP_MAX);
    expect(minimapSize({ width: 4000, height: 3000 })).toEqual(MINIMAP_MAX);
  });

  it('takes a modest share of a short embedded frame (760 × 380): smaller than today', () => {
    const m = minimapSize({ width: 760, height: 380 })!;
    expect(m.width).toBeLessThan(MINIMAP_MAX.width * 0.7);
    expect(m.width).toBeGreaterThanOrEqual(MINIMAP_MIN_WIDTH);
    expect(m.height).toBeLessThan(380 * 0.25);
    // The same 4:3 shape.
    expect(m.height).toBe(Math.round((m.width * 3) / 4));
  });

  it('scales with the width, and with the height of a short canvas', () => {
    const wide = minimapSize({ width: 1000, height: 900 })!;
    const narrow = minimapSize({ width: 700, height: 900 })!;
    const short = minimapSize({ width: 1000, height: 400 })!;
    expect(narrow.width).toBeLessThan(wide.width);
    expect(short.width).toBeLessThan(wide.width);
  });

  it('keeps a sane minimum, then hides below a size where it would only get in the way', () => {
    expect(minimapSize({ width: MINIMAP_HIDE_BELOW.width, height: 600 })!.width).toBe(MINIMAP_MIN_WIDTH);
    expect(minimapSize({ width: MINIMAP_HIDE_BELOW.width - 1, height: 600 })).toBeNull();
    expect(minimapSize({ width: 900, height: MINIMAP_HIDE_BELOW.height - 1 })).toBeNull();
  });

  it('unmeasured (0): the full size, as before', () => {
    expect(minimapSize({ width: 0, height: 0 })).toEqual(MINIMAP_MAX);
  });
});

describe('canvasChrome', () => {
  it('the editor\'s open detail panel: the minimap sizes from the canvas left of it, and hides when that is too small', () => {
    const open = { ...EDITOR, editorPanelShown: true };
    const wide = canvasChrome({ width: 1400, height: 900 }, open);
    expect(wide.minimap).not.toBeNull();
    expect(canvasChrome({ width: 760, height: 900 }, open).minimap).toBeNull();
    // The viewer's panel stops above the minimap row, so it never takes the minimap's width.
    expect(canvasChrome({ width: 760, height: 900 }, { ...VIEWER, editorPanelShown: true }).minimap).not.toBeNull();
  });

  it('the pill\'s room runs from the ? button to the minimap (and the editor\'s panel)', () => {
    const c = canvasChrome({ width: 760, height: 380 }, VIEWER);
    expect(c.statusBarLeft).toBe(15 + 28 + 10);
    expect(c.statusBarRoom).toBe(760 - 53 - (15 + c.minimap!.width + 10));
    const editorPanel = canvasChrome({ width: 1400, height: 900 }, { ...EDITOR, editorPanelShown: true });
    expect(editorPanel.statusBarRoom).toBe(1400 - 53 - (15 + 340 + 10 + editorPanel.minimap!.width + 10));
  });

  it('the pill moves beside the open legend', () => {
    const c = canvasChrome({ width: 1200, height: 800 }, { ...VIEWER, legendOpen: true });
    expect(c.statusBarLeft).toBe(15 + 260 + 10);
    // The editor's too: the open legend covers the corner.
    expect(canvasChrome({ width: 1200, height: 800 }, { ...EDITOR, legendOpen: true }).statusBarLeft).toBe(15 + 260 + 10);
  });

  it('the legend is never taller than its canvas; the viewer\'s panel leaves the minimap row free', () => {
    const c = canvasChrome({ width: 760, height: 380 }, VIEWER);
    expect(c.legendMaxHeight).toBe(380 - 30);
    expect(c.panelBottomReserve).toBe(15 + c.minimap!.height + 10);
    // No minimap: the bottom row (the ? button and the pill) is still kept free.
    expect(canvasChrome({ width: 400, height: 380 }, VIEWER).panelBottomReserve).toBe(15 + 28 + 10);
  });

  it('unmeasured: no room or height limit', () => {
    const c = canvasChrome({ width: 0, height: 0 }, VIEWER);
    expect(c.statusBarRoom).toBeNull();
    expect(c.legendMaxHeight).toBeNull();
  });
});

describe('fitStatusBar — the pill never wraps', () => {
  const counts = { tables: '6 tables', relationships: '7 relationships' };
  const layers = [
    { abbreviation: 'SLV', label: 'Silver', count: 4 },
    { abbreviation: 'GLD', label: 'Gold', count: 1 },
    { abbreviation: 'BRZ', label: 'Bronze', count: 1 },
  ];
  const w = pillWidths(counts, layers);

  it('shows everything when it fits, or when the room is not known', () => {
    expect(fitStatusBar(counts, layers, w.full)).toEqual({ mode: 'full', shownLayers: 3 });
    expect(fitStatusBar(counts, layers, null)).toEqual({ mode: 'full', shownLayers: 3 });
    expect(fitStatusBar(counts, [], null)).toEqual({ mode: 'counts', shownLayers: 0 });
  });

  it('drops the layer names first, keeping each badge and count', () => {
    expect(fitStatusBar(counts, layers, w.full - 1)).toEqual({ mode: 'badges', shownLayers: 3 });
  });

  it('then folds badges into a "+N", keeping at least one', () => {
    expect(fitStatusBar(counts, layers, w.badges - 1)).toEqual({ mode: 'some', shownLayers: 2 });
    expect(fitStatusBar(counts, layers, w.some(1))).toEqual({ mode: 'some', shownLayers: 1 });
  });

  it('then drops the layer key, keeping the two counts', () => {
    expect(fitStatusBar(counts, layers, w.some(1) - 1)).toEqual({ mode: 'counts', shownLayers: 0 });
    expect(fitStatusBar(counts, [], w.counts)).toEqual({ mode: 'counts', shownLayers: 0 });
  });

  it('truncates the counts only as the last resort (or hides, beside the viewer\'s open legend)', () => {
    expect(fitStatusBar(counts, layers, w.counts - 1)).toEqual({ mode: 'truncate', shownLayers: 0 });
    expect(fitStatusBar(counts, layers, w.counts - 1, true)).toEqual({ mode: 'hidden', shownLayers: 0 });
  });

  it('every step is narrower than the one before', () => {
    expect(w.full).toBeGreaterThan(w.badges);
    expect(w.badges).toBeGreaterThan(w.some(2));
    expect(w.some(2)).toBeGreaterThan(w.some(1));
    expect(w.some(1)).toBeGreaterThan(w.counts);
  });

  it('in a short embedded frame the counts and a layer key fit on one line', () => {
    const room = canvasChrome({ width: 760, height: 380 }, VIEWER).statusBarRoom!;
    const fit = fitStatusBar(counts, layers.slice(0, 1), room);
    expect(['full', 'badges']).toContain(fit.mode);
  });
});
