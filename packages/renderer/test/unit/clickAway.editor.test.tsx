// @vitest-environment jsdom
/**
 * The two-step click-away on the editor's canvas (no viewer flag), wired as
 * webview/App.tsx wires it: `useCanvasGraph`'s pane click, and React Flow's
 * node changes passed through `keepSelection` before they are applied.
 *
 * Covers the host-driven selections that open no panel (a gentle reveal,
 * `selectTables`): with no panel to close, one click clears them.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { useCallback } from 'react';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlow, ReactFlowProvider, applyNodeChanges, type NodeChange } from '@xyflow/react';
import type { DisplaySubjectArea } from '@erd-studio/core';
import { CanvasStoreProvider, createCanvasStore, useEditorStore, useEditorStoreApi, type CanvasStoreApi } from '../../src/store/editorStore';
import { useCanvasGraph } from '../../src/canvas/useCanvasGraph';
import { canvasNodeTypes, canvasEdgeTypes } from '../../src/canvas/flowTypes';
import type { GraphNode } from '../../src/lib/nodeOverlays';

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(cleanup);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

const col = (name: string, pk = false) => ({ name, dataType: 'bigint', description: '', isPrimaryKey: pk, isForeignKey: !pk, isNaturalKey: false });

const DOMAIN: DisplaySubjectArea = {
  schemaVersion: 6, domain: 'sales', layer: 'silver', stage: 'logical', description: '',
  readOnly: false, positionDraggable: true,
  models: [
    { name: 'orders', schema: 'silver', description: '', columns: [col('order_id', true), col('customer_id')] },
    { name: 'customers', schema: 'silver', description: '', columns: [col('customer_id', true)] },
    { name: 'products', schema: 'silver', description: '', columns: [col('product_id', true)] },
  ],
  relationships: [{ fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' }],
  viewConfig: { positions: { orders: { x: 0, y: 0 }, customers: { x: 600, y: 0 }, products: { x: 1200, y: 0 } } },
} as DisplaySubjectArea;

/** The editor's canvas, as App.tsx builds it (the parts the click-away touches). */
function EditorCanvas() {
  const storeApi = useEditorStoreApi();
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const { onNodeClick, onEdgeClick, onPaneClick, onSelectionChange, keepSelection } = useCanvasGraph();
  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    storeApi.getState().setNodes(applyNodeChanges(keepSelection(changes), storeApi.getState().nodes) as GraphNode[] as never);
  }, [storeApi, keepSelection]);
  return (
    <div style={{ width: 1200, height: 800 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={canvasNodeTypes}
        edgeTypes={canvasEdgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        multiSelectionKeyCode="Shift"
      />
    </div>
  );
}

async function renderEditor(): Promise<{ container: HTMLElement; store: CanvasStoreApi }> {
  const store = createCanvasStore({ domain: DOMAIN });
  const { container } = render(
    <CanvasStoreProvider store={store}>
      <ReactFlowProvider><EditorCanvas /></ReactFlowProvider>
    </CanvasStoreProvider>,
  );
  await flush();
  return { container, store };
}

const nodeEl = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
const pane = (c: HTMLElement) => c.querySelector<HTMLElement>('.react-flow__pane')!;
const marked = (store: CanvasStoreApi) => store.getState().nodes.filter((n) => n.selected).map((n) => n.id).sort();

describe('the editor canvas — two-step click-away', () => {
  it('first click closes the panel and keeps the table selected, its lines lit; the second clears', async () => {
    const { container, store } = await renderEditor();
    fireEvent.click(nodeEl(container, 'orders'));
    await flush();
    expect(store.getState().detailPanelOpen).toBe(true);

    fireEvent.click(pane(container));
    await flush();
    expect(store.getState().detailPanelOpen).toBe(false);
    expect(store.getState().selectedNode).toBe('orders');
    expect(marked(store)).toEqual(['orders']);
    expect(store.getState().nodes.find((n) => n.id === 'products')!.data.dimmed).toBe(true);

    fireEvent.click(pane(container));
    await flush();
    expect(store.getState().selectedNode).toBeNull();
    expect(marked(store)).toEqual([]);
    expect(store.getState().nodes.find((n) => n.id === 'products')!.data.dimmed).toBeFalsy();
  });

  it('keeps a multi-selection on the first click (Delete still sees it), clears it on the second', async () => {
    const { container, store } = await renderEditor();
    fireEvent.click(nodeEl(container, 'orders'));
    fireEvent.keyDown(document, { key: 'Shift' });
    fireEvent.click(nodeEl(container, 'products'), { shiftKey: true });
    fireEvent.keyUp(document, { key: 'Shift' });
    await flush();
    expect(marked(store)).toEqual(['orders', 'products']);

    fireEvent.click(pane(container));
    await flush();
    expect(store.getState().detailPanelOpen).toBe(false);
    expect(marked(store)).toEqual(['orders', 'products']);

    fireEvent.click(pane(container));
    await flush();
    expect(marked(store)).toEqual([]);
  });

  it('a gentle reveal (selected, no panel) clears on one click', async () => {
    const { container, store } = await renderEditor();
    act(() => {
      const s = store.getState();
      s.selectNode('customers');
      s.setNodes(s.nodes.map((n) => (n.id === 'customers' ? { ...n, selected: true } : n)));
    });
    await flush();
    fireEvent.click(pane(container));
    await flush();
    expect(store.getState().selectedNode).toBeNull();
    expect(marked(store)).toEqual([]);
  });

  it('a host\'s selectTables selection (marked, nothing picked out, no panel) clears on one click', async () => {
    const { container, store } = await renderEditor();
    act(() => {
      const s = store.getState();
      s.setNodes(s.nodes.map((n) => (n.id !== 'orders' ? { ...n, selected: true } : n)));
    });
    await flush();
    expect(marked(store)).toEqual(['customers', 'products']);
    fireEvent.click(pane(container));
    await flush();
    expect(marked(store)).toEqual([]);
  });

  it('Escape on the focused table: React Flow\'s own deselect is held off while the step only closes the panel', async () => {
    const { container, store } = await renderEditor();
    fireEvent.click(nodeEl(container, 'orders'));
    await flush();
    // The editor's Escape is a window listener (useCanvasShortcuts); stand in for its step.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = store.getState();
      if (s.detailPanelOpen && s.selectedNode) s.setDetailPanelOpen(false);
    };
    window.addEventListener('keydown', onEscape);
    try {
      fireEvent.keyDown(nodeEl(container, 'orders'), { key: 'Escape' });
      await flush();
      expect(store.getState().detailPanelOpen).toBe(false);
      expect(marked(store)).toEqual(['orders']);
    } finally {
      window.removeEventListener('keydown', onEscape);
    }
  });
});
