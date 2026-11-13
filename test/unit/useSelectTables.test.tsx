// @vitest-environment jsdom
/**
 * A drop on the canvas, webview side of what follows it (`selectTables`,
 * `useSelectTables`): the tables the drop added (or found already there) are
 * marked selected once the canvas draws them, and nothing else happens: no
 * fit, no pan or zoom, no detail panel. (Open in Diagram, Go to Table and Add
 * to Diagram… keep `revealTable`: `test/unit/useRevealTable.test.tsx`.) The
 * host side is `test/unit/dropTables.test.ts`; the first-open fit a drop must
 * not set off is in `test/unit/libraryDrop.test.tsx`.
 *
 * Real store; React Flow is mocked (a fitView here would be a bug).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const mockFitView = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ fitView: mockFitView, setViewport: mockFitView, setCenter: mockFitView }),
  useNodesInitialized: () => true,
}));

import { useSelectTables } from '../../webview/hooks/useSelectTables';
import { REVEAL_TABLE_WAIT_MS } from '../../webview/hooks/useRevealTable';
import { useEditorStore } from '../../webview/store/editorStore';
import type { TableFlowNode } from '@erd-studio/renderer/editor';

const initialStoreState = useEditorStore.getState();

const node = (id: string, selected = false): TableFlowNode =>
  ({ id, type: 'model', position: { x: 0, y: 0 }, selected, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } }) as unknown as TableFlowNode;

const selectedIds = (): string[] => useEditorStore.getState().nodes.filter((n) => n.selected).map((n) => n.id);

beforeEach(() => {
  vi.useFakeTimers();
  useEditorStore.setState(initialStoreState, true);
  mockFitView.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSelectTables (after a drop on the canvas)', () => {
  it('waits for the refresh that draws the added tables, then selects exactly them: no fit, no panel, nothing else selected', () => {
    useEditorStore.setState({ nodes: [node('fct_order', true)], edges: [] });
    useEditorStore.getState().selectNode('fct_order');
    useEditorStore.getState().setDetailPanelOpen(true);
    renderHook(() => useSelectTables());
    act(() => useEditorStore.getState().setPendingTableSelection(['DIM_customer', 'dim_region']));
    // Not drawn yet: nothing happens.
    expect(selectedIds()).toEqual(['fct_order']);
    // The refresh after the edit draws them.
    act(() => useEditorStore.setState({ nodes: [node('fct_order', true), node('dim_customer'), node('dim_region')] }));
    expect(selectedIds()).toEqual(['dim_customer', 'dim_region']);
    const state = useEditorStore.getState();
    expect(state.selectedNode).toBeNull();
    expect(state.detailPanelOpen).toBe(false);
    expect(state.pendingTableSelection).toBeNull();
    act(() => { vi.advanceTimersByTime(REVEAL_TABLE_WAIT_MS * 2); });
    expect(mockFitView).not.toHaveBeenCalled();
  });

  it('tables already on the diagram are selected at once', () => {
    useEditorStore.setState({ nodes: [node('fct_order'), node('dim_customer')], edges: [] });
    renderHook(() => useSelectTables());
    act(() => useEditorStore.getState().setPendingTableSelection(['fct_order']));
    expect(selectedIds()).toEqual(['fct_order']);
    expect(mockFitView).not.toHaveBeenCalled();
  });

  it('a table the canvas never draws: the ones it does are selected after a while, without a word', () => {
    useEditorStore.setState({ nodes: [node('fct_order')], edges: [] });
    renderHook(() => useSelectTables());
    act(() => useEditorStore.getState().setPendingTableSelection(['fct_order', 'missing']));
    expect(selectedIds()).toEqual([]);
    act(() => { vi.advanceTimersByTime(REVEAL_TABLE_WAIT_MS); });
    expect(selectedIds()).toEqual(['fct_order']);
    expect(useEditorStore.getState().pendingTableSelection).toBeNull();
    expect(useEditorStore.getState().toastMessage ?? null).toBeNull();
  });
});
