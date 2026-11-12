// @vitest-environment jsdom
/**
 * Open in Diagram / Go to Table / Add to Diagram… on a table, webview side
 * (`useRevealTable`): the table the host names is selected as a click would
 * select it, with its detail panel open and the view fitted to it, once the
 * canvas has settled; a table the diagram does not show yet gets a little
 * longer (Add to Diagram…'s refresh may follow the reveal), then a toast.
 * The host side is `test/unit/revealTable.test.ts`.
 *
 * Real store; React Flow is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mockFitView = vi.hoisted(() => vi.fn());
const nodesInitialized = vi.hoisted(() => ({ value: true }));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView: mockFitView }),
  useNodesInitialized: () => nodesInitialized.value,
}));

import { REVEAL_TABLE_WAIT_MS, findRevealNode, useRevealTable } from '../../webview/hooks/useRevealTable';
import { REVEAL_SETTLE_MS } from '../../webview/hooks/useRevealRelationship';
import { useEditorStore } from '../../webview/store/editorStore';
import type { TableFlowNode } from '@erd-studio/renderer/editor';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domain = (names: string[], stage: 'logical' | 'physical' = 'logical'): DisplaySubjectArea => ({
  schemaVersion: 5,
  domain: 'sales',
  layer: 'gold',
  stage,
  models: names.map((name) => ({ name, columns: [] })),
  relationships: [],
  viewConfig: { positions: {} },
  readOnly: false,
} as unknown as DisplaySubjectArea);

const node = (id: string): TableFlowNode =>
  ({ id, type: 'model', position: { x: 0, y: 0 }, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } }) as unknown as TableFlowNode;

function loadCanvas(names: string[], stage: 'logical' | 'physical' = 'logical'): void {
  useEditorStore.setState({ domain: domain(names, stage), nodes: names.map(node), edges: [] });
}

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState(initialStoreState, true);
  mockFitView.mockClear();
  nodesInitialized.value = true;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('findRevealNode', () => {
  it('matches a table node by name, ignoring case, never an annotation', () => {
    const nodes = [{ id: 'note-1', type: 'annotation' }, { id: 'fct_order', type: 'model' }];
    expect(findRevealNode(nodes, ' FCT_Order ')).toBe('fct_order');
    expect(findRevealNode(nodes, 'note-1')).toBeUndefined();
  });

  it('two tables of one name: the diagram\'s name for one first, then a bare name only one node has as its own', () => {
    const nodes = [
      { id: 'bqs.addresse', type: 'model', data: { tableName: 'addresse' } },
      { id: 'ccc.addresse', type: 'model', data: { tableName: 'addresse' } },
      { id: 'ccc.kunde', type: 'model', data: { tableName: 'kunde' } },
      { id: 'kunde_alt', type: 'model', data: {} },
    ];
    expect(findRevealNode(nodes, 'CCC.addresse')).toBe('ccc.addresse');
    expect(findRevealNode(nodes, 'addresse')).toBeUndefined();
    expect(findRevealNode(nodes, 'kunde')).toBe('ccc.kunde');
  });
});

describe('useRevealTable', () => {
  it('selects the table as a click does, opens its panel and fits the view to it, after the canvas settles', () => {
    loadCanvas(['fct_order', 'dim_customer']);
    useEditorStore.getState().setSelectedEdge('some-edge');
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('DIM_CUSTOMER'));
    expect(useEditorStore.getState().selectedNode).toBeNull();

    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    const state = useEditorStore.getState();
    expect(state.selectedNode).toBe('dim_customer');
    expect(state.detailPanelOpen).toBe(true);
    expect(state.selectedEdge).toBeNull();
    expect(state.pendingTableReveal).toBeNull();
    expect(mockFitView).toHaveBeenCalledWith({ nodes: [{ id: 'dim_customer' }], duration: 300, padding: 0.3 });
  });

  it('waits while a layout runs, before React Flow has measured, and on the physical stage', () => {
    loadCanvas(['fct_order'], 'physical');
    const { rerender } = renderHook(({ layouting }) => useRevealTable(layouting), { initialProps: { layouting: true } });
    act(() => useEditorStore.getState().setPendingTableReveal('fct_order'));
    nodesInitialized.value = false;
    act(() => { vi.advanceTimersByTime(REVEAL_TABLE_WAIT_MS * 2); });
    expect(useEditorStore.getState().selectedNode).toBeNull();
    expect(useEditorStore.getState().toastMessage).toBeNull();

    act(() => { loadCanvas(['fct_order']); });
    rerender({ layouting: false });
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 4); });
    expect(useEditorStore.getState().selectedNode).toBeNull();

    nodesInitialized.value = true;
    rerender({ layouting: false });
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedNode).toBe('fct_order');
  });

  it('waits for a refresh that adds the table (Add to Diagram…)', () => {
    loadCanvas(['fct_order']);
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_region'));
    act(() => { vi.advanceTimersByTime(REVEAL_TABLE_WAIT_MS / 2); });
    act(() => { loadCanvas(['fct_order', 'dim_region']); });
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedNode).toBe('dim_region');
    expect(useEditorStore.getState().toastMessage).toBeNull();
  });

  it('says so when the diagram does not show the table, and selects nothing', () => {
    loadCanvas(['fct_order']);
    renderHook(() => useRevealTable(false));
    act(() => useEditorStore.getState().setPendingTableReveal('dim_region'));
    act(() => { vi.advanceTimersByTime(REVEAL_TABLE_WAIT_MS); });
    expect(useEditorStore.getState().toastMessage).toBe("This diagram doesn't show the table dim_region.");
    expect(useEditorStore.getState().selectedNode).toBeNull();
    expect(useEditorStore.getState().pendingTableReveal).toBeNull();
    expect(mockFitView).not.toHaveBeenCalled();
  });
});
