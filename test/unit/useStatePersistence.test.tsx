// @vitest-environment jsdom
/**
 * useStatePersistence — restore + persist of the extended PersistedState
 * (canvas mode, discrepancy overlay, sync-merge selections) and the
 * hide-time flush (H20).
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

import { useStatePersistence, type PersistedState } from '../../webview/hooks/useStatePersistence';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const domain = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical',
  models: [{ name: 'a', columns: [] }],
  relationships: [],
  viewConfig: { positions: {} },
  readOnly: false,
} as unknown as DisplayDomain;

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  vi.clearAllMocks();
  mockVsCode.getState.mockReturnValue(undefined);
  useEditorStore.setState(initialStoreState, true);
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useStatePersistence restore', () => {
  it('restores canvas mode, discrepancy overlay and sync-merge selections and re-requests the report', () => {
    const persisted: PersistedState = {
      selectedNode: 'a',
      viewport: { x: 1, y: 2, zoom: 1.5 },
      detailPanelOpen: true,
      expandedNodes: ['a'],
      allExpanded: false,
      canvasMode: 'select',
      discrepancyVisible: true,
      discrepancyCompareStage: 'physical',
      syncMode: true,
      syncSelections: { 'model:a': 'logical', 'model:b': 'physical', 'column:a.x': 'logical' },
    };
    mockVsCode.getState.mockReturnValue(persisted);
    useEditorStore.setState({ domain });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.canvasMode).toBe('select');
    expect(s.discrepancyVisible).toBe(true);
    expect(s.discrepancyCompareStage).toBe('physical');
    expect(s.syncMode).toBe(true);
    expect(s.syncSelections).toEqual(persisted.syncSelections);
    expect(s.selectedNode).toBe('a');
    expect(s.detailPanelOpen).toBe(true);
    expect(s.expandedNodes.has('a')).toBe(true);

    // The report is not persisted — the host is asked to re-run the comparison
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({
      type: 'toggleDiscrepancy',
      payload: { enabled: true, compareAgainst: 'physical' },
    });
  });

  it('does not touch overlay state or request a report when the overlay was off', () => {
    mockVsCode.getState.mockReturnValue({
      selectedNode: null,
      viewport: { x: 0, y: 0, zoom: 1 },
      detailPanelOpen: false,
      expandedNodes: [],
      allExpanded: false,
      discrepancyVisible: false,
      syncMode: true, // stale without an overlay — must be ignored
      syncSelections: { 'model:a': 'logical' },
    } satisfies PersistedState);
    useEditorStore.setState({ domain });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.discrepancyVisible).toBe(false);
    expect(s.syncMode).toBe(false);
    expect(s.syncSelections).toEqual({});
    expect(s.canvasMode).toBe('pan');
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('tolerates legacy state blobs without the new fields', () => {
    mockVsCode.getState.mockReturnValue({
      selectedNode: null,
      viewport: { x: 0, y: 0, zoom: 1 },
      detailPanelOpen: false,
      expandedNodes: [],
      allExpanded: false,
    });
    useEditorStore.setState({ domain });
    expect(() => renderHook(() => useStatePersistence())).not.toThrow();
    expect(useEditorStore.getState().canvasMode).toBe('pan');
  });
});

describe('useStatePersistence persist', () => {
  it('writes the new fields after the debounce', () => {
    vi.useFakeTimers();
    useEditorStore.setState({ domain });
    renderHook(() => useStatePersistence());

    act(() => {
      useEditorStore.getState().setCanvasMode('select');
      useEditorStore.getState().setDiscrepancyCompareStage('physical');
      useEditorStore.getState().setDiscrepancyVisible(true);
      useEditorStore.getState().setSyncMode(true);
      useEditorStore.getState().setSyncSelection('model:a', 'physical');
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });

    const last = mockVsCode.setState.mock.calls.at(-1)?.[0] as PersistedState;
    expect(last).toMatchObject({
      canvasMode: 'select',
      discrepancyVisible: true,
      discrepancyCompareStage: 'physical',
      syncMode: true,
      syncSelections: { 'model:a': 'physical' },
    });
  });

  it('flushes a pending write immediately when the webview is hidden', () => {
    vi.useFakeTimers();
    useEditorStore.setState({ domain });
    renderHook(() => useStatePersistence());
    mockVsCode.setState.mockClear();

    act(() => {
      useEditorStore.getState().setCanvasMode('select');
    });
    // The debounced write for the new value has not fired yet
    expect(
      mockVsCode.setState.mock.calls.some((c) => (c[0] as PersistedState).canvasMode === 'select'),
    ).toBe(false);
    mockVsCode.setState.mockClear();

    act(() => {
      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(mockVsCode.setState).toHaveBeenCalledTimes(1);
    expect((mockVsCode.setState.mock.calls[0][0] as PersistedState).canvasMode).toBe('select');

    // Timer must not double-write
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(mockVsCode.setState).toHaveBeenCalledTimes(1);
  });
});
