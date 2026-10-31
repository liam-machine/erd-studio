// @vitest-environment jsdom
/**
 * The Relationships view's Open in Diagram, webview side
 * (`useRevealRelationship`): the line the host names is selected as a click
 * would select it and the view is fitted to its two tables, but only once the
 * canvas has settled; a line the diagram does not draw gets a toast. The host
 * side is `test/unit/revealRelationship.test.ts`.
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

import { REVEAL_SETTLE_MS, findRevealEdge, useRevealRelationship } from '../../webview/hooks/useRevealRelationship';
import { useEditorStore } from '../../webview/store/editorStore';
import type { TableFlowNode, FkFlowEdge } from '@erd-studio/renderer/editor';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domain = (stage: 'logical' | 'physical' = 'logical'): DisplaySubjectArea => ({
  schemaVersion: 5,
  domain: 'sales',
  layer: 'gold',
  stage,
  models: [{ name: 'fct_order', columns: [] }, { name: 'dim_customer', columns: [] }, { name: 'dim_region', columns: [] }],
  relationships: [],
  viewConfig: { positions: {} },
  readOnly: false,
} as unknown as DisplaySubjectArea);

const node = (id: string): TableFlowNode =>
  ({ id, type: 'model', position: { x: 0, y: 0 }, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } }) as unknown as TableFlowNode;

const edge = (id: string, data: Record<string, unknown>): FkFlowEdge =>
  ({ id, type: 'fk', source: data.fromModel, target: data.toModel, data }) as unknown as FkFlowEdge;

const toCustomer = edge('fk-fct_order-customer_key-dim_customer-customer_key',
  { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' });
const toRegion = edge('fk-fct_order-region_code+country_code-dim_region-region_code+country_code', {
  fromModel: 'fct_order', fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one',
  compositeKey: 'region', pairs: [{ fromColumn: 'region_code', toColumn: 'region_code' }, { fromColumn: 'country_code', toColumn: 'country_code' }],
});

function loadCanvas(stage: 'logical' | 'physical' = 'logical'): void {
  useEditorStore.setState({
    domain: domain(stage),
    nodes: [node('fct_order'), node('dim_customer'), node('dim_region')],
    edges: [toCustomer, toRegion],
  });
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

describe('findRevealEdge', () => {
  it('matches a line by its column pairs, from either end and in any case', () => {
    const target = { fromModel: 'DIM_CUSTOMER', toModel: 'fct_order', pairs: [{ fromColumn: 'Customer_Key', toColumn: 'customer_key' }] };
    expect(findRevealEdge([toRegion, toCustomer], target)?.id).toBe(toCustomer.id);
  });

  it('finds a composite key\'s one line from its pairs, never a ghost line', () => {
    const target = { fromModel: 'fct_order', toModel: 'dim_region', pairs: [{ fromColumn: 'region_code', toColumn: 'region_code' }, { fromColumn: 'country_code', toColumn: 'country_code' }] };
    expect(findRevealEdge([toCustomer, toRegion], target)?.id).toBe(toRegion.id);
    expect(findRevealEdge([{ ...toRegion, id: `ghost-${toRegion.id}` }], target)).toBeUndefined();
  });
});

describe('useRevealRelationship', () => {
  const reveal = { fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'customer_key', toColumn: 'customer_key' }] };

  it('selects the line as a click does and fits the view to its two tables, after the canvas settles', () => {
    loadCanvas();
    useEditorStore.getState().selectNode('dim_region');
    renderHook(() => useRevealRelationship(false));
    act(() => useEditorStore.getState().setPendingReveal(reveal));
    expect(useEditorStore.getState().selectedEdge).toBeNull();

    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    const state = useEditorStore.getState();
    expect(state.selectedEdge).toBe(toCustomer.id);
    expect(state.selectedNode).toBeNull();
    expect([...state.highlightedColumns].sort()).toEqual(['dim_customer:customer_key', 'fct_order:customer_key']);
    expect(state.pendingReveal).toBeNull();
    expect(mockFitView).toHaveBeenCalledWith({ nodes: [{ id: 'fct_order' }, { id: 'dim_customer' }], duration: 300, padding: 0.3 });
  });

  it('waits while a layout runs, while one is pending, before React Flow has measured, and on the physical stage', () => {
    loadCanvas('physical');
    const { rerender } = renderHook(({ layouting }) => useRevealRelationship(layouting), { initialProps: { layouting: true } });
    act(() => {
      useEditorStore.getState().setPendingReveal(reveal);
      useEditorStore.getState().setPendingAutoLayout(true);
    });
    nodesInitialized.value = false;
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 4); });
    expect(useEditorStore.getState().selectedEdge).toBeNull();

    act(() => { loadCanvas('logical'); });
    act(() => { useEditorStore.getState().setPendingAutoLayout(false); });
    rerender({ layouting: false });
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS * 4); });
    expect(useEditorStore.getState().selectedEdge).toBeNull();

    nodesInitialized.value = true;
    rerender({ layouting: false });
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().selectedEdge).toBe(toCustomer.id);
  });

  it('says so when the diagram does not draw the line, and selects nothing', () => {
    loadCanvas();
    renderHook(() => useRevealRelationship(false));
    act(() => useEditorStore.getState().setPendingReveal({ fromModel: 'fct_order', toModel: 'dim_customer', pairs: [{ fromColumn: 'ship_key', toColumn: 'customer_key' }] }));
    act(() => { vi.advanceTimersByTime(REVEAL_SETTLE_MS); });
    expect(useEditorStore.getState().toastMessage).toBe("This diagram doesn't show the relationship fct_order → dim_customer.");
    expect(useEditorStore.getState().selectedEdge).toBeNull();
    expect(mockFitView).not.toHaveBeenCalled();
  });
});
