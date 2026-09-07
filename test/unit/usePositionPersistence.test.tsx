// @vitest-environment jsdom
/**
 * usePositionPersistence — node change application and position flushing.
 *
 *  - Two onNodesChange batches in the same task must both apply (H41):
 *    changes are applied against the live store, not a post-commit ref.
 *  - Pending (debounced) drag positions are flushed immediately when the
 *    webview is hidden (H20).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
}));

import { usePositionPersistence } from '../../webview/hooks/usePositionPersistence';
import { useEditorStore } from '../../webview/store/editorStore';
import type { ModelFlowNode } from '../../webview/types/graph';
import type { DisplayDomain } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

function makeNode(id: string): ModelFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    data: { modelName: id, stage: 'logical', layer: 'silver', columns: [], isStub: false },
  };
}

const domain = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical',
  models: [{ name: 'a', columns: [] }, { name: 'b', columns: [] }],
  relationships: [],
  viewConfig: { positions: { a: { x: 0, y: 0 }, b: { x: 0, y: 0 } } },
  readOnly: false,
} as unknown as DisplayDomain;

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
  useEditorStore.setState({ nodes: [makeNode('a'), makeNode('b')], domain });
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePositionPersistence', () => {
  it('applies two synchronous change batches without dropping the first (H41)', () => {
    const { result } = renderHook(() => usePositionPersistence());

    act(() => {
      result.current.onNodesChange([{ type: 'select', id: 'a', selected: true }]);
      result.current.onNodesChange([
        { type: 'dimensions', id: 'a', dimensions: { width: 280, height: 120 } },
      ]);
    });

    const a = useEditorStore.getState().nodes.find((n) => n.id === 'a')!;
    expect(a.selected).toBe(true);
    expect(a.measured).toEqual({ width: 280, height: 120 });
  });

  it('debounces drag-end positions and flushes them on visibilitychange → hidden (H20)', () => {
    const { result } = renderHook(() => usePositionPersistence());

    act(() => {
      result.current.onNodesChange([
        { type: 'position', id: 'a', position: { x: 100.4, y: 200.6 }, dragging: false },
      ]);
    });

    // Debounced — nothing sent yet
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();

    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockVsCode.postMessage).toHaveBeenCalledTimes(1);
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: 'updatePositions',
      payload: { positions: { a: { x: 100, y: 201 } } },
    });
    // Optimistic local update applied
    expect(useEditorStore.getState().domain?.viewConfig.positions?.a).toEqual({ x: 100, y: 201 });

    // The debounce timer must not fire a duplicate later
    vi.useFakeTimers();
    vi.advanceTimersByTime(1000);
    expect(mockVsCode.postMessage).toHaveBeenCalledTimes(1);
  });

  it('flushes on pagehide as well', () => {
    const { result } = renderHook(() => usePositionPersistence());
    act(() => {
      result.current.onNodesChange([
        { type: 'position', id: 'b', position: { x: 5, y: 6 }, dragging: false },
      ]);
    });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: 'updatePositions',
      payload: { positions: { b: { x: 5, y: 6 } } },
    });
  });

  it('does nothing on hide when no positions are pending', () => {
    renderHook(() => usePositionPersistence());
    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('still sends after the debounce when the webview stays visible', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePositionPersistence());
    act(() => {
      result.current.onNodesChange([
        { type: 'position', id: 'a', position: { x: 42, y: 42 }, dragging: false },
      ]);
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(mockVsCode.postMessage).toHaveBeenCalledTimes(1);
  });
});
