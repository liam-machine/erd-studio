// @vitest-environment jsdom
/**
 * useCanvasShortcuts — the global keydown handler extracted from App.tsx (H35)
 * and its batched multi-select delete (H27).
 *
 *  - The window listener is registered ONCE; selection / dialog / domain
 *    changes in the store never re-subscribe it (the handler reads
 *    `useEditorStore.getState()` at keypress time).
 *  - Delete with a mixed multi-selection sends one `removeModels`, one
 *    `removeAnnotations` and one `removeRelationships` — never one message
 *    per item — and skips edges that the model batch will cascade.
 *  - The single-item priorities (annotation > columns > model > edges) and
 *    Escape / Ctrl+F / mode toggles keep their previous behaviour.
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

const mockReactFlow = vi.hoisted(() => ({
  getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
}));

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => mockReactFlow,
}));

import { useCanvasShortcuts } from '../../webview/hooks/useCanvasShortcuts';
import { useEditorStore } from '../../webview/store/editorStore';
import type { ModelFlowNode, AnnotationFlowNode } from '../../webview/types/graph';
import type { DisplayDomain } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

function modelNode(name: string, selected = false): ModelFlowNode {
  return {
    id: name,
    type: 'model',
    selected,
    position: { x: 0, y: 0 },
    data: { modelName: name, stage: 'logical', layer: 'silver', columns: [], isStub: false },
  };
}

function annotationNode(id: string, selected = false): AnnotationFlowNode {
  return {
    id: `annotation-${id}`,
    type: 'annotation',
    selected,
    position: { x: 0, y: 0 },
    data: { annotationId: id, text: id, color: 'yellow' },
  } as unknown as AnnotationFlowNode;
}

const REL_AB = { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id', cardinality: 'many-to-one' as const };
const REL_BC = { fromModel: 'b', fromColumn: 'c_id', toModel: 'c', toColumn: 'id', cardinality: 'many-to-one' as const };
const edgeId = (r: typeof REL_AB) => `fk-${r.fromModel}-${r.fromColumn}-${r.toModel}-${r.toColumn}`;

const domain = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical',
  models: [{ name: 'a', columns: [] }, { name: 'b', columns: [] }, { name: 'c', columns: [] }],
  relationships: [REL_AB, REL_BC],
  viewConfig: {
    positions: {},
    annotations: [{ id: 'n1', text: 'one', x: 0, y: 0 }, { id: 'n2', text: 'two', x: 0, y: 0 }],
  },
  readOnly: false,
} as unknown as DisplayDomain;

function press(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

const sent = () => mockVsCode.postMessage.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
  useEditorStore.setState({ domain, nodes: [modelNode('a'), modelNode('b'), modelNode('c'), annotationNode('n1'), annotationNode('n2')] });
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useCanvasShortcuts', () => {
  it('registers the keydown listener once and never re-subscribes on store changes (H35)', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { rerender, unmount } = renderHook(() => useCanvasShortcuts());

    const keydownAdds = () => addSpy.mock.calls.filter((c) => c[0] === 'keydown').length;
    expect(keydownAdds()).toBe(1);

    // Everything the old App.tsx effect depended on changes — still one listener.
    act(() => {
      useEditorStore.getState().selectNode('a');
      useEditorStore.getState().setSelectedEdges([edgeId(REL_AB)]);
      useEditorStore.getState().setNewModelDialogOpen(true);
      useEditorStore.getState().setCanvasMode('select');
      useEditorStore.getState().setDomain({ ...domain });
    });
    rerender();
    expect(keydownAdds()).toBe(1);
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(0);

    unmount();
    expect(removeSpy.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
  });

  it('Delete on a mixed multi-selection sends ONE batched message per kind (H27)', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.setState({
        nodes: [modelNode('a', true), modelNode('b'), modelNode('c'), annotationNode('n1', true), annotationNode('n2', true)],
      });
      useEditorStore.getState().setSelectedEdges([edgeId(REL_AB), edgeId(REL_BC), 'fk-not-a-real-edge']);
    });

    const event = press('Delete');

    expect(event.defaultPrevented).toBe(true);
    expect(sent()).toEqual([
      { type: 'removeModels', payload: { modelNames: ['a'] } },
      { type: 'removeAnnotations', payload: { ids: ['n1', 'n2'] } },
      // REL_AB touches model "a" which the model batch cascades — only REL_BC is sent.
      {
        type: 'removeRelationships',
        payload: { relationships: [{ fromModel: 'b', fromColumn: 'c_id', toModel: 'c', toColumn: 'id' }] },
      },
    ]);
    const s = useEditorStore.getState();
    expect(s.selectedNode).toBeNull();
    expect(s.selectedAnnotation).toBeNull();
    expect(s.selectedEdges).toEqual([]);
  });

  it('omits a batch whose list would be empty', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.setState({
        nodes: [modelNode('a'), modelNode('b'), modelNode('c'), annotationNode('n1', true), annotationNode('n2', true)],
      });
    });
    press('Backspace');
    expect(sent()).toEqual([{ type: 'removeAnnotations', payload: { ids: ['n1', 'n2'] } }]);
  });

  it('single edge delete keeps the removeRelationship message; several selected edges batch', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.getState().setSelectedEdges([edgeId(REL_AB)]);
    });
    press('Delete');
    expect(sent()).toEqual([
      { type: 'removeRelationship', payload: { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'id' } },
    ]);
  });

  it('single annotation delete beats everything else and sends removeAnnotation', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.getState().setSelectedEdges([edgeId(REL_AB)]);
      useEditorStore.getState().selectAnnotation('n1');
    });
    press('Delete');
    expect(sent()).toEqual([{ type: 'removeAnnotation', payload: { id: 'n1' } }]);
    expect(useEditorStore.getState().selectedAnnotation).toBeNull();
  });

  it('single model delete opens the confirmation instead of sending a message', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.getState().selectNode('a');
    });
    press('Delete');
    expect(sent()).toEqual([]);
    expect(useEditorStore.getState().pendingDeleteConfirmation).toBe(true);
    expect(useEditorStore.getState().detailPanelOpen).toBe(true);
  });

  it('does nothing on Delete when the domain is read-only or the user is typing', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.setState({ nodes: [modelNode('a', true), annotationNode('n1', true)] });
    });

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    press('Delete');
    expect(sent()).toEqual([]);
    input.blur();
    document.body.removeChild(input);

    act(() => {
      useEditorStore.getState().setDomain({ ...domain, readOnly: true });
    });
    press('Delete');
    expect(sent()).toEqual([]);
  });

  it('Escape closes dialogs before clearing selection, then leaves select mode', () => {
    renderHook(() => useCanvasShortcuts());
    act(() => {
      useEditorStore.getState().setNewModelDialogOpen(true);
      useEditorStore.getState().selectNode('a');
      useEditorStore.getState().setCanvasMode('select');
    });

    press('Escape');
    expect(useEditorStore.getState().newModelDialogOpen).toBe(false);
    expect(useEditorStore.getState().selectedNode).toBe('a');

    press('Escape');
    expect(useEditorStore.getState().selectedNode).toBeNull();
    expect(useEditorStore.getState().canvasMode).toBe('select');

    press('Escape');
    expect(useEditorStore.getState().canvasMode).toBe('pan');
  });

  it('reads the latest store state at keypress time (no stale closure)', () => {
    renderHook(() => useCanvasShortcuts());
    press('s');
    expect(useEditorStore.getState().canvasMode).toBe('select');
    press('v');
    expect(useEditorStore.getState().canvasMode).toBe('pan');

    // Legend toggle flips based on the current value each time
    press('?', { shiftKey: true });
    expect(useEditorStore.getState().legendOpen).toBe(true);
    press('?', { shiftKey: true });
    expect(useEditorStore.getState().legendOpen).toBe(false);
  });

  it('Alt+2 sends a switchStage request with a request id', () => {
    renderHook(() => useCanvasShortcuts());
    press('™', { altKey: true, code: 'Digit2' });
    expect(sent()).toEqual([
      { type: 'switchStage', payload: { stage: 'physical', requestId: expect.any(Number) } },
    ]);
  });
});
