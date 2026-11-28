// @vitest-environment jsdom
/**
 * First-open auto layout — the webview half.
 *
 * The host sets `domainLoaded.autoLayout` when a domain has models but not one
 * stored position (typically written by an AI assistant with `viewConfig: {}`).
 * The webview then runs the same ELK layout the Layout button / Shift+L runs,
 * exactly once. Opening a diagram writes nothing, so it sends the result as
 * an `updatePositions` with `unsaved` (the host holds it, never writes it),
 * unless the host says the layout is the user's own (`saveLayout`: they just
 * made the diagram, or added tables to an empty one): then it is a plain,
 * saved `updatePositions`, as the Layout button posts.
 *
 * Drives the real Toolbar against the real store; only the VS Code API, React
 * Flow and the ELK worker are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';

const mockRunElkLayout = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ model_a: { x: 10, y: 20 }, model_b: { x: 300, y: 20 } }),
);
const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));
const mockFitView = vi.hoisted(() => vi.fn());

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
}));

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: mockFitView,
    getNode: vi.fn(),
  }),
  useStore: () => 1,
  useNodesInitialized: () => true,
}));

vi.mock('../../webview/components/Toolbar/StageTabs', () => ({
  StageTabs: () => null,
}));

vi.mock('../../webview/lib/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../webview/lib/elkLayout')>();
  return { ...actual, runElkLayout: mockRunElkLayout };
});

import { Toolbar } from '../../webview/components/Toolbar/Toolbar';
import { useEditorStore } from '../../webview/store/editorStore';
import { useFirstOpenAutoLayout } from '../../webview/hooks/useFirstOpenAutoLayout';
import type { TableFlowNode, FkFlowEdge } from '../../webview/types/graph';
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

function makeSubjectArea(stage: 'logical' | 'physical' = 'logical'): DisplaySubjectArea {
  return {
    schemaVersion: 5,
    domain: 'fresh',
    layer: 'silver',
    stage,
    models: [
      { name: 'model_a', columns: [] },
      { name: 'model_b', columns: [] },
    ],
    relationships: [],
    viewConfig: { positions: { model_a: { x: 0, y: 0 }, model_b: { x: 0, y: 200 } } },
    readOnly: false,
  } as unknown as DisplaySubjectArea;
}

function makeNode(id: string): TableFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    data: { modelName: id, stage: 'logical', layer: 'silver', columns: [] },
  } as TableFlowNode;
}

const nodes = [makeNode('model_a'), makeNode('model_b')];
const edges: FkFlowEdge[] = [];

async function renderToolbar(nodeList: TableFlowNode[] = nodes) {
  // async act: the layout the effect starts settles inside it.
  await act(async () => {
    render(
      <StrictMode>
        <Toolbar nodes={nodeList} edges={edges} />
      </StrictMode>,
    );
  });
}

/** What App.tsx does on a `domainLoaded` message. */
function deliverSubjectAreaLoaded(domain: DisplaySubjectArea, autoLayout?: boolean, saveLayout?: boolean) {
  act(() => {
    useEditorStore.getState().setDomain(domain);
    useEditorStore.getState().setPendingAutoLayout(autoLayout === true, saveLayout === true);
  });
}

const updatePositionsPosts = () =>
  mockVsCode.postMessage.mock.calls.filter(([m]) => m?.type === 'updatePositions');
/** The posts the host writes: an `updatePositions` without `unsaved`. */
const writingPosts = () => updatePositionsPosts().filter(([m]) => m.payload?.unsaved !== true);

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  vi.clearAllMocks();
  mockRunElkLayout.mockResolvedValue({ model_a: { x: 10, y: 20 }, model_b: { x: 300, y: 20 } });
});

afterEach(() => {
  cleanup();
});

describe('first-open auto layout (Toolbar + store)', () => {
  it('runs the ELK layout exactly once on a flagged load and sends it unsaved: never a writing updatePositions', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea(), true);
    await renderToolbar();

    await vi.waitFor(() => expect(updatePositionsPosts()).toHaveLength(1));
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    expect(mockVsCode.postMessage.mock.calls.find(([m]) => m?.type === 'layoutFinished')?.[0].payload)
      .toMatchObject({ ok: true, firstOpen: true });
    expect(updatePositionsPosts()[0][0].payload).toEqual({
      positions: { model_a: { x: 10, y: 20 }, model_b: { x: 300, y: 20 } },
      unsaved: true,
    });
    expect(writingPosts()).toHaveLength(0);
    expect(useEditorStore.getState().pendingAutoLayout).toBe(false);
    expect(useEditorStore.getState().domain?.viewConfig.positions?.model_b).toEqual({ x: 300, y: 20 });

    // The host's refresh carries the held layout and no flag; nothing runs again.
    deliverSubjectAreaLoaded(makeSubjectArea());
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
  });

  it('saves a flagged layout the host says is the user\'s own (saveLayout) with one writing updatePositions', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea(), true, true);
    await renderToolbar();

    await vi.waitFor(() => expect(writingPosts()).toHaveLength(1));
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    expect(updatePositionsPosts()).toHaveLength(1);
    expect(writingPosts()[0][0].payload).toEqual({ positions: { model_a: { x: 10, y: 20 }, model_b: { x: 300, y: 20 } } });
    expect(useEditorStore.getState().pendingAutoLayoutSaves).toBe(false);
  });

  it('a later flagged load without saveLayout is not saved: the flag follows each payload', () => {
    deliverSubjectAreaLoaded(makeSubjectArea(), true, true);
    expect(useEditorStore.getState().pendingAutoLayoutSaves).toBe(true);
    deliverSubjectAreaLoaded(makeSubjectArea(), true);
    expect(useEditorStore.getState().pendingAutoLayoutSaves).toBe(false);
  });

  it('does nothing on an unflagged load', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea());
    await renderToolbar();

    expect(mockRunElkLayout).not.toHaveBeenCalled();
    expect(updatePositionsPosts()).toHaveLength(0);
  });

  // runElkLayout rejects only when even its grid fallback failed (a timeout is
  // laid out by the grid and saved, #294): then nothing is written.
  it('keeps positions unpersisted when even the grid fails, so the next open retries', async () => {
    mockRunElkLayout.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deliverSubjectAreaLoaded(makeSubjectArea(), true);
    await renderToolbar();

    await vi.waitFor(() => expect(useEditorStore.getState().toastMessage).toMatch(/^ERD Studio couldn't arrange this diagram\./));
    expect(useEditorStore.getState().toastMessage).not.toMatch(/boom|ELK/);
    expect(useEditorStore.getState().toastActions).toEqual(['retryLayout', 'layoutFeedback']);
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    expect(updatePositionsPosts()).toHaveLength(0);
    // The host counts it as a failed first-open layout (usage telemetry).
    const finished = mockVsCode.postMessage.mock.calls.filter(([m]) => m?.type === 'layoutFinished');
    expect(finished).toHaveLength(1);
    expect(finished[0][0].payload).toMatchObject({ ok: false, firstOpen: true });
    consoleSpy.mockRestore();
  });
});

describe('first-open auto layout writes nothing until the user acts', () => {
  it('lays the fresh diagram out once and draws it, posting only the unsaved form', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea(), true);
    await renderToolbar();

    await vi.waitFor(() => expect(mockRunElkLayout).toHaveBeenCalledTimes(1));
    // The canvas shows the ELK result...
    await vi.waitFor(() => expect(useEditorStore.getState().domain?.viewConfig.positions?.model_b).toEqual({ x: 300, y: 20 }));
    // ...but opening the diagram did not ask the host to save it.
    await vi.waitFor(() => expect(updatePositionsPosts()).toHaveLength(1));
    expect(writingPosts()).toHaveLength(0);
  });

  it('guard: the Layout button (a user action) still saves with one writing updatePositions', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea());
    await renderToolbar();
    await act(async () => { useEditorStore.getState().triggerAutoLayout(); });
    await vi.waitFor(() => expect(writingPosts()).toHaveLength(1));
    expect(updatePositionsPosts()).toHaveLength(1);
  });

  it('guard: the Layout button after an unsaved first-open layout saves', async () => {
    deliverSubjectAreaLoaded(makeSubjectArea(), true);
    await renderToolbar();
    await vi.waitFor(() => expect(updatePositionsPosts()).toHaveLength(1));
    await act(async () => { useEditorStore.getState().triggerAutoLayout(); });
    await vi.waitFor(() => expect(writingPosts()).toHaveLength(1));
    expect(mockRunElkLayout).toHaveBeenCalledTimes(2);
  });
});

describe('useFirstOpenAutoLayout', () => {
  it('waits until every model has a node on the canvas', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverSubjectAreaLoaded(makeSubjectArea(), true);

    const { rerender } = renderHook(
      ({ nodeList }) => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodeList, false),
      { initialProps: { nodeList: [makeNode('model_a')] } },
    );
    expect(runLayout).not.toHaveBeenCalled();
    expect(useEditorStore.getState().pendingAutoLayout).toBe(true);

    rerender({ nodeList: nodes });
    expect(runLayout).toHaveBeenCalledTimes(1);
    rerender({ nodeList: [...nodes] });
    expect(runLayout).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by a later load without the flag', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverSubjectAreaLoaded(makeSubjectArea(), true);

    const { rerender } = renderHook(
      ({ nodeList }) => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodeList, false),
      { initialProps: { nodeList: [] as TableFlowNode[] } },
    );
    deliverSubjectAreaLoaded(makeSubjectArea());
    rerender({ nodeList: nodes });

    expect(runLayout).not.toHaveBeenCalled();
  });

  it('waits while a layout is already running', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverSubjectAreaLoaded(makeSubjectArea(), true);

    const { rerender } = renderHook(
      ({ busy }) => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodes, busy),
      { initialProps: { busy: true } },
    );
    expect(runLayout).not.toHaveBeenCalled();

    rerender({ busy: false });
    expect(runLayout).toHaveBeenCalledTimes(1);
  });

  it('never runs on the physical stage', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverSubjectAreaLoaded(makeSubjectArea('physical'), true);

    renderHook(() => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodes, false));
    expect(runLayout).not.toHaveBeenCalled();
  });
});
