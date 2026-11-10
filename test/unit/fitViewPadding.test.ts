// @vitest-environment jsdom
/**
 * fitView padding that keeps the floating toolbar off the top row of cards
 * (dev-host finding 7): the top padding is the toolbar's measured bottom edge
 * plus a gap, the other sides keep the old 0.1.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import {
  BESIDE_DETAIL_MIN_FLOW_PX,
  FIT_MAX_ZOOM,
  LARGE_DIAGRAM_TABLES,
  READABLE_ZOOM,
  clustersOf,
  initialFitViewOptions,
  DETAIL_PANEL_WIDTH_PX,
  DISC_PANEL_GAP_PX,
  DISC_PANEL_MAX_WIDTH_PX,
  MIN_FREE_CANVAS_PX,
  PANEL_MARGIN_PX,
  compareFocusRightInset,
  fitsBesideDetail,
  FALLBACK_TOP_INSET_PX,
  INITIAL_FIT_VIEW_OPTIONS,
  TOOLBAR_GAP_PX,
  fitViewPadding,
  measureTopInset,
  measureTopInsetFrom,
} from '../../webview/lib/fitViewPadding';

function rectEl(rect: Partial<DOMRect>, tag = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}), ...rect }) as DOMRect;
  return el;
}

describe('fitViewPadding', () => {
  it('puts the top inset in px and keeps 0.1 on the other sides', () => {
    expect(fitViewPadding(101.4)).toEqual({ top: '101px', right: 0.1, bottom: 0.1, left: 0.1 });
  });

  it('takes an optional right inset in px', () => {
    expect(fitViewPadding(90, 700)).toEqual({ top: '90px', right: '700px', bottom: 0.1, left: 0.1 });
  });

  it('the initial fit leaves the fallback toolbar inset', () => {
    expect(INITIAL_FIT_VIEW_OPTIONS.padding).toEqual(fitViewPadding(FALLBACK_TOP_INSET_PX));
  });
});

describe('measureTopInset', () => {
  it('is the toolbar bottom relative to the flow top, plus the gap', () => {
    const flow = rectEl({ top: 40, height: 700 });
    const toolbar = rectEl({ top: 55, bottom: 125, height: 70 });
    expect(measureTopInset(toolbar, flow)).toBe(125 - 40 + TOOLBAR_GAP_PX);
  });

  it('falls back when the toolbar is missing or not laid out', () => {
    expect(measureTopInset(null, rectEl({}))).toBe(FALLBACK_TOP_INSET_PX);
    expect(measureTopInset(rectEl({ height: 0 }), rectEl({}))).toBe(FALLBACK_TOP_INSET_PX);
  });

  it('measureTopInsetFrom finds the toolbar of the canvas an element sits in', () => {
    const flow = rectEl({ top: 0, height: 600 });
    flow.className = 'react-flow';
    const toolbar = rectEl({ top: 15, bottom: 95, height: 80 });
    toolbar.className = 'toolbar-container';
    const row = document.createElement('div');
    toolbar.appendChild(row);
    flow.appendChild(toolbar);
    document.body.appendChild(flow);
    try {
      expect(measureTopInsetFrom(row)).toBe(95 + TOOLBAR_GAP_PX);
    } finally {
      flow.remove();
    }
  });
});

describe('the Compare focus on a narrow canvas', () => {
  const beside = (panel: number) => DETAIL_PANEL_WIDTH_PX + PANEL_MARGIN_PX + DISC_PANEL_GAP_PX + panel + PANEL_MARGIN_PX;

  it('puts the panels side by side only where the table keeps its room', () => {
    expect(BESIDE_DETAIL_MIN_FLOW_PX).toBe(beside(DISC_PANEL_MAX_WIDTH_PX) + MIN_FREE_CANVAS_PX);
    expect(fitsBesideDetail(0)).toBe(true); // unmeasured
    expect(fitsBesideDetail(1440)).toBe(true);
    expect(fitsBesideDetail(BESIDE_DETAIL_MIN_FLOW_PX)).toBe(true);
    expect(fitsBesideDetail(BESIDE_DETAIL_MIN_FLOW_PX - 1)).toBe(false);
    expect(fitsBesideDetail(900)).toBe(false);
  });

  it('a wide canvas gets the full side-by-side inset', () => {
    expect(compareFocusRightInset(1440, 320)).toBe(beside(320));
    expect(compareFocusRightInset(0, 300)).toBe(beside(300));
  });

  it('a narrow canvas covers one stacked column, and always leaves room for the table', () => {
    for (const width of [900, 750, 600, 400, 200]) {
      const right = compareFocusRightInset(width, 320);
      expect(right).toBeLessThanOrEqual(Math.max(DETAIL_PANEL_WIDTH_PX, 320) + 2 * PANEL_MARGIN_PX);
      // What is left between the 0.1 left padding and the right inset.
      const free = width * 0.9 - right;
      expect(free, `${width}px`).toBeGreaterThanOrEqual(Math.min(MIN_FREE_CANVAS_PX, width / 2) - 0.001);
      expect(right).toBeGreaterThanOrEqual(0);
    }
    expect(compareFocusRightInset(900, 320)).toBe(DETAIL_PANEL_WIDTH_PX + 2 * PANEL_MARGIN_PX);
  });
});

describe('the panel widths match the CSS', () => {
  const css = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8');
  const rule = (text: string, selector: string): string => {
    const at = text.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return text.slice(at, text.indexOf('}', at));
  };

  it('the Detail Panel is DETAIL_PANEL_WIDTH_PX wide', () => {
    expect(rule(css('packages/renderer/src/components/DetailPanel/DetailPanel.css'), '.detail-panel'))
      .toMatch(new RegExp(`\\bwidth: ${DETAIL_PANEL_WIDTH_PX}px;`));
  });

  it('the Compare panel\'s max-width and its beside-detail margin use the same numbers', () => {
    const text = css('webview/components/DiscrepancyPanel/DiscrepancyPanel.css');
    expect(rule(text, '.disc-panel')).toMatch(new RegExp(`max-width: ${DISC_PANEL_MAX_WIDTH_PX}px;`));
    expect(rule(text, '.react-flow__panel.disc-panel--beside-detail'))
      .toContain(`margin-right: calc(${DETAIL_PANEL_WIDTH_PX}px + ${PANEL_MARGIN_PX}px + ${DISC_PANEL_GAP_PX}px);`);
  });
});

describe('the first-open fit: never past 100%, and a large diagram opens readable', () => {
  it('fits a small diagram whole, never past 100% (no jump to 200% after the first table)', () => {
    expect(FIT_MAX_ZOOM).toBe(1);
    expect(INITIAL_FIT_VIEW_OPTIONS.maxZoom).toBe(1);
    const one = initialFitViewOptions([{ id: 'a', type: 'model' }], []);
    expect(one).toBe(INITIAL_FIT_VIEW_OPTIONS);
    expect(one.nodes).toBeUndefined();
  });

  it('opens a 257-table diagram on its biggest cluster at a readable zoom', () => {
    const nodes = Array.from({ length: 257 }, (_, i) => ({ id: `t${i}`, type: 'model' }));
    // Two clusters: t0..t9 (10 tables) and t20..t49 (30 tables); the rest unrelated. A sticky note links too.
    const edges = [
      ...Array.from({ length: 9 }, (_, i) => ({ source: `t${i}`, target: `t${i + 1}` })),
      ...Array.from({ length: 29 }, (_, i) => ({ source: `t20`, target: `t${21 + i}` })),
      { source: 'note1', target: 't0' },
    ];
    const options = initialFitViewOptions([...nodes, { id: 'note1', type: 'annotation' }], edges);
    expect(options.minZoom).toBe(READABLE_ZOOM);
    expect(options.maxZoom).toBe(FIT_MAX_ZOOM);
    expect((options.nodes ?? []).map((n) => n.id).sort()).toEqual(Array.from({ length: 30 }, (_, i) => `t${20 + i}`).sort());
  });

  it('a large diagram with no relationships opens on its centre at a readable zoom', () => {
    const nodes = Array.from({ length: LARGE_DIAGRAM_TABLES }, (_, i) => ({ id: `t${i}`, type: 'model' }));
    const options = initialFitViewOptions(nodes, []);
    expect(options.nodes).toBeUndefined();
    expect(options.minZoom).toBe(READABLE_ZOOM);
  });

  it('groups related tables, biggest first', () => {
    expect(clustersOf(['a', 'b', 'c', 'd'], [{ source: 'c', target: 'd' }, { source: 'd', target: 'b' }, { source: 'x', target: 'a' }]))
      .toEqual([['b', 'c', 'd'], ['a']]);
  });
});
