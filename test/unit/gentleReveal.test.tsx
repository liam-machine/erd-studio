// @vitest-environment jsdom
/**
 * The gentle reveal (`webview/lib/gentleReveal.ts`, and `useRevealTable` /
 * `useRevealRelationship` with `gentle`): a sidebar row's click selects its
 * table or line at the zoom the user has, never opens the detail panel, and
 * moves the view only when what it selects is not wholly in sight, as little
 * as brings it in, clear of the toolbar and the detail panel.
 *
 * Real store; React Flow is mocked (a viewport, node boxes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const flow = vi.hoisted(() => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  boxes: {} as Record<string, { x: number; y: number; w: number; h: number }>,
  fitView: vi.fn(),
  setViewport: vi.fn(),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({
    fitView: flow.fitView,
    setViewport: flow.setViewport,
    getViewport: () => flow.viewport,
    getInternalNode: (id: string) => {
      const b = flow.boxes[id];
      return b ? { internals: { positionAbsolute: { x: b.x, y: b.y } }, measured: { width: b.w, height: b.h } } : undefined;
    },
  }),
  useNodesInitialized: () => true,
}));

import { HIDDEN_WEBVIEW_SIZE, REVEAL_MARGIN, canvasInsets, gentlePan, isBehindAnotherTab, revealGently } from '../../webview/lib/gentleReveal';
import { useRevealTable } from '../../webview/hooks/useRevealTable';
import { REVEAL_SETTLE_MS, useRevealRelationship } from '../../webview/hooks/useRevealRelationship';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

/** A 1000 × 600 canvas, with a toolbar along its top and (optionally) the detail panel on its right. */
function mountCanvas(withPanel = false): void {
  document.body.innerHTML = '';
  const box = (cls: string, r: { left: number; top: number; right: number; bottom: number }): HTMLElement => {
    const el = document.createElement('div');
    el.className = cls;
    el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;
    return el;
  };
  // The canvas sits 100px from the window's left (a sidebar): every box below is in window coordinates.
  const pane = box('react-flow', { left: 100, top: 0, right: 1100, bottom: 600 });
  const toolbar = document.createElement('div');
  toolbar.className = 'toolbar-container';
  toolbar.appendChild(box('toolbar__island', { left: 400, top: 10, right: 800, bottom: 60 }));
  pane.appendChild(toolbar);
  if (withPanel) pane.appendChild(box('detail-panel', { left: 740, top: 70, right: 1090, bottom: 590 }));
  document.body.appendChild(pane);
}

describe('gentlePan (pure)', () => {
  const size = { width: 1000, height: 600 };

  it('leaves a box wholly in sight where it is', () => {
    expect(gentlePan({ left: 100, top: 100, right: 300, bottom: 300 }, size)).toEqual({ dx: 0, dy: 0 });
  });

  it('moves a box partly out of sight the least distance that puts it in, with the margin', () => {
    // 50px past the right edge: moved left until its right edge is a margin inside.
    expect(gentlePan({ left: 850, top: 100, right: 1050, bottom: 300 }, size)).toEqual({ dx: 1000 - REVEAL_MARGIN - 1050, dy: 0 });
    // Above the top: moved down only.
    expect(gentlePan({ left: 100, top: -80, right: 300, bottom: 40 }, size)).toEqual({ dx: 0, dy: REVEAL_MARGIN + 80 });
  });

  it('treats what the toolbar and the detail panel cover as out of sight', () => {
    const insets = { top: 60, right: 360, bottom: 0, left: 0 };
    // In the canvas, but under the detail panel.
    const { dx } = gentlePan({ left: 700, top: 200, right: 800, bottom: 300 }, size, insets);
    expect(dx).toBe(1000 - 360 - REVEAL_MARGIN - 800);
    // Under the toolbar.
    expect(gentlePan({ left: 100, top: 20, right: 200, bottom: 120 }, size, insets).dy).toBe(60 + REVEAL_MARGIN - 20);
  });

  it('shows the start of a box larger than the free area (a tall table\'s header), or its middle when asked', () => {
    const tall = { left: 100, top: -400, right: 300, bottom: 900 };
    expect(gentlePan(tall, size).dy).toBe(REVEAL_MARGIN + 400);
    const wide = { left: -500, top: 100, right: 1500, bottom: 200 };
    expect(gentlePan(wide, size, undefined, { oversize: 'center' }).dx).toBe(500 - 500);
  });

  it('reads each floating panel as eating into the side it hugs', () => {
    const canvas = { left: 0, top: 0, right: 1000, bottom: 600 };
    expect(canvasInsets(canvas, [
      { left: 300, top: 10, right: 700, bottom: 60 },
      { left: 640, top: 70, right: 990, bottom: 590 },
      // Not drawn: ignored.
      { left: 0, top: 0, right: 0, bottom: 0 },
    ])).toEqual({ top: 60, right: 360, bottom: 0, left: 0 });
  });
});

describe('revealGently', () => {
  beforeEach(() => {
    flow.viewport = { x: 0, y: 0, zoom: 1 };
    flow.boxes = {};
    flow.setViewport.mockClear();
  });

  it('keeps the zoom and pans only for a node out of sight, clear of the toolbar and the open detail panel', () => {
    mountCanvas(true);
    flow.viewport = { x: 10, y: 20, zoom: 0.5 };
    // On screen at x = 10 + 1400 * 0.5 = 710 .. 810: under the detail panel (which starts at 640 in the canvas).
    flow.boxes.a = { x: 1400, y: 300, w: 200, h: 100 };
    expect(revealGently(useReactFlowMock(), ['a'])).toBe(true);
    const [viewport, options] = flow.setViewport.mock.calls[0];
    expect(viewport.zoom).toBe(0.5);
    expect(viewport.y).toBe(20);
    expect(viewport.x).toBe(10 + (640 - REVEAL_MARGIN - 810));
    expect(options).toEqual({ duration: expect.any(Number) });
  });

  it('does not move a node already wholly in sight', () => {
    mountCanvas(true);
    flow.boxes.a = { x: 100, y: 200, w: 200, h: 100 };
    expect(revealGently(useReactFlowMock(), ['a'])).toBe(false);
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a node under the toolbar is brought just below it', () => {
    mountCanvas(false);
    flow.boxes.a = { x: 400, y: 0, w: 200, h: 100 };
    revealGently(useReactFlowMock(), ['a']);
    expect(flow.setViewport.mock.calls[0][0]).toEqual({ x: 0, y: 60 + REVEAL_MARGIN, zoom: 1 });
  });
});

/** The mocked hook's instance, outside a component. */
function useReactFlowMock() {
  return {
    setViewport: flow.setViewport,
    getViewport: () => flow.viewport,
    getInternalNode: (id: string) => {
      const b = flow.boxes[id];
      return b ? { internals: { positionAbsolute: { x: b.x, y: b.y } }, measured: { width: b.w, height: b.h } } : undefined;
    },
  };
}

describe('the hooks, gently', () => {
  const domain = {
    schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical',
    models: [{ name: 'fct_order', columns: [] }, { name: 'dim_customer', columns: [] }],
    relationships: [], viewConfig: { positions: {} }, readOnly: false,
  } as unknown as DisplaySubjectArea;
  const node = (id: string) => ({ id, type: 'model', position: { x: 0, y: 0 }, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } });
  const edge = {
    id: 'fk-1', type: 'fk', source: 'fct_order', target: 'dim_customer',
    data: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useEditorStore.setState(initialStoreState, true);
    useEditorStore.setState({ domain, nodes: [node('fct_order'), node('dim_customer')] as never, edges: [edge] as never });
    flow.viewport = { x: 0, y: 0, zoom: 0.8 };
    flow.boxes = { fct_order: { x: 100, y: 100, w: 200, h: 100 }, dim_customer: { x: 400, y: 150, w: 200, h: 100 } };
    flow.fitView.mockClear();
    flow.setViewport.mockClear();
    mountCanvas(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('a table: selected, no detail panel opened, no fit and no zoom; the view left alone when it is in sight', () => {
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('DIM_CUSTOMER', true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    const state = useEditorStore.getState();
    expect(state.selectedNode).toBe('dim_customer');
    expect(state.detailPanelOpen).toBe(false);
    expect(state.pendingTableReveal).toBeNull();
    expect(state.pendingTableRevealGentle).toBe(false);
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a table: marked selected on the canvas (its outline, the only cue with no panel), any earlier selection cleared', () => {
    // An earlier selection: a drop's tables, marked selected by useSelectTables.
    useEditorStore.setState({ nodes: [{ ...node('fct_order'), selected: true }, node('dim_customer')] as never });
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_customer', true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    const selected = useEditorStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);
    expect(selected).toEqual(['dim_customer']);
  });

  it('waits while the canvas is behind another tab (its stand-in size would read the table as out of sight), then runs', () => {
    // A double-click: the first click's reveal arrives as the second opens the file over the canvas.
    act(() => useEditorStore.getState().setCanvasOnScreen(false));
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_customer', true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 10); });
    expect(flow.setViewport).not.toHaveBeenCalled();
    expect(useEditorStore.getState().selectedNode).toBeNull();
    expect(useEditorStore.getState().pendingTableReveal).toBe('dim_customer');
    // Back in front, at its real size: selected, and left where it is (it is in sight).
    act(() => useEditorStore.getState().setCanvasOnScreen(true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedNode).toBe('dim_customer');
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('keeps waiting when the webview is already behind another tab before the host has said so (the stand-in 300 × 150)', () => {
    const size = { w: window.innerWidth, h: window.innerHeight };
    const setSize = (w: number, h: number) => {
      Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    };
    // The table is in sight on the real canvas; the stand-in size would read it as out of sight.
    renderHook(() => useRevealTable(false));
    renderHook(() => useRevealRelationship(false));
    setSize(HIDDEN_WEBVIEW_SIZE.width, HIDDEN_WEBVIEW_SIZE.height);
    try {
      expect(isBehindAnotherTab()).toBe(true);
      act(() => useEditorStore.getState().setPendingTableReveal('dim_customer', true));
      act(() => useEditorStore.getState().setPendingReveal({ fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_key', toColumn: 'customer_key' }], gentle: true }));
      act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 5); });
      expect(useEditorStore.getState().pendingTableReveal).toBe('dim_customer');
      expect(useEditorStore.getState().pendingReveal).not.toBeNull();
      expect(flow.setViewport).not.toHaveBeenCalled();
    } finally {
      setSize(size.w, size.h);
    }
    // The tab is back: both run, and nothing in sight moves.
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 2); });
    expect(useEditorStore.getState().pendingTableReveal).toBeNull();
    expect(useEditorStore.getState().pendingReveal).toBeNull();
    expect(flow.setViewport).not.toHaveBeenCalled();
  });

  it('a relationship\'s gentle reveal waits for the canvas to be on screen too', () => {
    act(() => useEditorStore.getState().setCanvasOnScreen(false));
    renderHook(() => useRevealRelationship(false));
    act(() => useEditorStore.getState().setPendingReveal({ fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_key', toColumn: 'customer_key' }], gentle: true }));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 10); });
    expect(useEditorStore.getState().selectedEdge).toBeNull();
    act(() => useEditorStore.getState().setCanvasOnScreen(true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedEdge).toBe('fk-1');
  });

  it('a table out of sight: panned into view at the same zoom', () => {
    flow.boxes.dim_customer = { x: 2000, y: 150, w: 200, h: 100 };
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_customer', true));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(flow.setViewport.mock.calls[0][0].zoom).toBe(0.8);
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(useEditorStore.getState().detailPanelOpen).toBe(false);
  });

  it('a table not gentle (Go to Table…): centred with its panel, as before', () => {
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_customer'));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().detailPanelOpen).toBe(true);
    expect(flow.fitView).toHaveBeenCalledTimes(1);
  });

  it('a relationship: its line selected, no fit; panned only when its tables are out of sight', () => {
    renderHook(() => useRevealRelationship(false));
    const target = { fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_key', toColumn: 'customer_key' }], gentle: true };
    act(() => useEditorStore.getState().setPendingReveal(target));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedEdge).toBe('fk-1');
    expect(flow.fitView).not.toHaveBeenCalled();
    expect(flow.setViewport).not.toHaveBeenCalled();

    flow.boxes.dim_customer = { x: 1600, y: 150, w: 200, h: 100 };
    act(() => useEditorStore.getState().setPendingReveal({ ...target }));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(flow.setViewport).toHaveBeenCalledTimes(1);
    expect(flow.setViewport.mock.calls[0][0].zoom).toBe(0.8);
    expect(flow.fitView).not.toHaveBeenCalled();
  });
});
