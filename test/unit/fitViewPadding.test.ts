// @vitest-environment jsdom
/**
 * fitView padding that keeps the floating toolbar off the top row of cards
 * (dev-host finding 7): the top padding is the toolbar's measured bottom edge
 * plus a gap, the other sides keep the old 0.1.
 */
import { describe, expect, it } from 'vitest';

import {
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
