// @vitest-environment jsdom
/**
 * #333, the page's half wired up (`useFirstPaintTiming` over
 * `webview/lib/paintTiming.ts`): the canvas posts `canvasPainted` once, after
 * the paint that follows React Flow measuring the first diagram's tables (or
 * at once for a diagram with nothing to draw), and never while the canvas is
 * behind another tab. `canvasOpenTiming.test.ts` pins the timing module
 * itself; this pins when the hook calls it.
 *
 * Real store; React Flow's `useNodesInitialized` and the message bus are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const nodesInitialized = vi.hoisted(() => ({ value: false }));
const send = vi.hoisted(() => vi.fn());

vi.mock('@xyflow/react', () => ({
  useNodesInitialized: () => nodesInitialized.value,
}));
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));

import { useFirstPaintTiming } from '../../webview/hooks/useFirstPaintTiming';
import { _resetPaintTimingForTests, notePayloadReceived } from '../../webview/lib/paintTiming';
import { useEditorStore } from '../../webview/store/editorStore';
import type { TableFlowNode } from '@erd-studio/renderer/editor';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domain = (names: string[]): DisplaySubjectArea => ({
  schemaVersion: 5,
  domain: 'sales',
  layer: 'gold',
  stage: 'logical',
  models: names.map((name) => ({ name, columns: [] })),
  relationships: [],
  viewConfig: { positions: {} },
  readOnly: false,
} as unknown as DisplaySubjectArea);

const node = (id: string): TableFlowNode =>
  ({ id, type: 'model', position: { x: 0, y: 0 }, data: { modelName: id, stage: 'logical', layer: 'gold', columns: [] } }) as unknown as TableFlowNode;

/** What App's `domainLoaded` case does: start the clock, then hand the diagram to the store. */
function domainLoaded(names: string[]): void {
  notePayloadReceived();
  act(() => useEditorStore.setState({ domain: domain(names), nodes: [], edges: [] }));
}

/** useCanvasGraph's effect: the nodes follow the diagram; React Flow measures them later. */
function nodesBuilt(names: string[], measured: boolean, rerender: () => void): void {
  nodesInitialized.value = measured;
  act(() => useEditorStore.setState({ nodes: names.map(node) }));
  rerender();
}

const painted = () => send.mock.calls.filter(([m]) => (m as { type: string }).type === 'canvasPainted');

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  _resetPaintTimingForTests();
  nodesInitialized.value = false;
  send.mockClear();
});

afterEach(() => cleanup());

describe('useFirstPaintTiming (#333)', () => {
  it('posts once, only after React Flow has measured the first diagram\'s tables', async () => {
    const { rerender } = renderHook(() => useFirstPaintTiming());
    domainLoaded(['a', 'b']);
    nodesBuilt(['a', 'b'], false, rerender);
    await new Promise((r) => setTimeout(r, 50));
    expect(painted()).toEqual([]);

    nodesBuilt(['a', 'b'], true, rerender);
    await waitFor(() => expect(painted()).toHaveLength(1));
    const [[message]] = painted();
    expect(message).toEqual({ type: 'canvasPainted', payload: { ms: expect.any(Number) } });
    expect((message as { payload: { ms: number } }).payload.ms).toBeGreaterThanOrEqual(0);

    // A refresh, an undo or a stage switch re-posts the diagram: not an open.
    domainLoaded(['a', 'b', 'c']);
    nodesBuilt(['a', 'b', 'c'], false, rerender);
    nodesBuilt(['a', 'b', 'c'], true, rerender);
    await new Promise((r) => setTimeout(r, 50));
    expect(painted()).toHaveLength(1);
  });

  it('a diagram with nothing to draw is drawn as soon as it arrives', async () => {
    renderHook(() => useFirstPaintTiming());
    domainLoaded([]);
    await waitFor(() => expect(painted()).toHaveLength(1));
  });

  it('a canvas that goes behind another tab before it is drawn posts nothing, then or later', async () => {
    const { rerender } = renderHook(() => useFirstPaintTiming());
    domainLoaded(['a']);
    act(() => useEditorStore.getState().setCanvasOnScreen(false));
    act(() => useEditorStore.getState().setCanvasOnScreen(true));
    nodesBuilt(['a'], true, rerender);
    await new Promise((r) => setTimeout(r, 50));
    expect(painted()).toEqual([]);
  });

  it('nothing is posted while no diagram has arrived', async () => {
    const { rerender } = renderHook(() => useFirstPaintTiming());
    nodesBuilt(['a'], true, rerender);
    await new Promise((r) => setTimeout(r, 50));
    expect(painted()).toEqual([]);
  });
});
