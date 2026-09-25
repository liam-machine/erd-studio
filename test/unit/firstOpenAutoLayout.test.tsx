// @vitest-environment jsdom
/**
 * First-open auto layout — the webview half.
 *
 * The host sets `domainLoaded.autoLayout` when a domain has models but not one
 * stored position (typically written by an AI assistant with `viewConfig: {}`).
 * The webview then runs the same ELK layout the Layout button / Shift+L runs,
 * exactly once, and persists it with a single `updatePositions`.
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
import type { ModelFlowNode, FkFlowEdge } from '../../webview/types/graph';
import type { DisplayDomain } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

function makeDomain(stage: 'logical' | 'physical' = 'logical'): DisplayDomain {
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
  } as unknown as DisplayDomain;
}

function makeNode(id: string): ModelFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    data: { modelName: id, stage: 'logical', layer: 'silver', columns: [] },
  } as ModelFlowNode;
}

const nodes = [makeNode('model_a'), makeNode('model_b')];
const edges: FkFlowEdge[] = [];

async function renderToolbar(nodeList: ModelFlowNode[] = nodes) {
  // async act: the layout the effect starts settles inside it.
  await act(async () => {
    render(
      <StrictMode>
        <Toolbar nodes={nodeList} edges={edges} allExpanded={false} onExpandAll={vi.fn()} onCollapseAll={vi.fn()} />
      </StrictMode>,
    );
  });
}

/** What App.tsx does on a `domainLoaded` message. */
function deliverDomainLoaded(domain: DisplayDomain, autoLayout?: boolean) {
  act(() => {
    useEditorStore.getState().setDomain(domain);
    useEditorStore.getState().setPendingAutoLayout(autoLayout === true);
  });
}

const updatePositionsPosts = () =>
  mockVsCode.postMessage.mock.calls.filter(([m]) => m?.type === 'updatePositions');

beforeEach(() => {
  useEditorStore.setState(initialStoreState, true);
  vi.clearAllMocks();
  mockRunElkLayout.mockResolvedValue({ model_a: { x: 10, y: 20 }, model_b: { x: 300, y: 20 } });
});

afterEach(() => {
  cleanup();
});

describe('first-open auto layout (Toolbar + store)', () => {
  it('runs the ELK layout exactly once on a flagged load and persists it once', async () => {
    deliverDomainLoaded(makeDomain(), true);
    await renderToolbar();

    await vi.waitFor(() => expect(updatePositionsPosts()).toHaveLength(1));
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    expect(updatePositionsPosts()[0][0].payload.positions).toEqual({
      model_a: { x: 10, y: 20 },
      model_b: { x: 300, y: 20 },
    });
    expect(useEditorStore.getState().pendingAutoLayout).toBe(false);
    expect(useEditorStore.getState().domain?.viewConfig.positions?.model_b).toEqual({ x: 300, y: 20 });

    // The host's refresh after the write carries no flag; nothing runs again.
    deliverDomainLoaded(makeDomain());
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
  });

  it('does nothing on an unflagged load', async () => {
    deliverDomainLoaded(makeDomain());
    await renderToolbar();

    expect(mockRunElkLayout).not.toHaveBeenCalled();
    expect(updatePositionsPosts()).toHaveLength(0);
  });

  it('keeps positions unpersisted when ELK fails, so the next open retries', async () => {
    mockRunElkLayout.mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    deliverDomainLoaded(makeDomain(), true);
    await renderToolbar();

    await vi.waitFor(() => expect(useEditorStore.getState().toastMessage).toMatch(/Auto layout failed: boom/));
    expect(mockRunElkLayout).toHaveBeenCalledTimes(1);
    expect(updatePositionsPosts()).toHaveLength(0);
    consoleSpy.mockRestore();
  });
});

describe('useFirstOpenAutoLayout', () => {
  it('waits until every model has a node on the canvas', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverDomainLoaded(makeDomain(), true);

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
    deliverDomainLoaded(makeDomain(), true);

    const { rerender } = renderHook(
      ({ nodeList }) => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodeList, false),
      { initialProps: { nodeList: [] as ModelFlowNode[] } },
    );
    deliverDomainLoaded(makeDomain());
    rerender({ nodeList: nodes });

    expect(runLayout).not.toHaveBeenCalled();
  });

  it('waits while a layout is already running', () => {
    const runLayout = vi.fn().mockResolvedValue(undefined);
    deliverDomainLoaded(makeDomain(), true);

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
    deliverDomainLoaded(makeDomain('physical'), true);

    renderHook(() => useFirstOpenAutoLayout(runLayout, useEditorStore.getState().domain, nodes, false));
    expect(runLayout).not.toHaveBeenCalled();
  });
});
