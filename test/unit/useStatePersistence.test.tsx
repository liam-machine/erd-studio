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
import type { DisplaySubjectArea } from '../../src/types/display';

const initialStoreState = useEditorStore.getState();

const subjectArea = {
  domain: 'test',
  layer: 'silver',
  stage: 'logical',
  models: [{ name: 'a', columns: [] }],
  relationships: [],
  viewConfig: { positions: {} },
  readOnly: false,
} as unknown as DisplaySubjectArea;

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
    useEditorStore.setState({ domain: subjectArea });

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

  it('restores which table decisions were inferred, only where the selection still holds that side', () => {
    mockVsCode.getState.mockReturnValue({
      selectedNode: null, viewport: { x: 0, y: 0, zoom: 1 }, detailPanelOpen: false, expandedNodes: [], allExpanded: false,
      discrepancyVisible: true, discrepancyCompareStage: 'physical', syncMode: true,
      syncSelections: { 'model:a': 'logical', 'model:b': 'physical' },
      // model:b's selection no longer holds the inferred side; model:c has none.
      syncInferredTableKeys: { 'model:a': 'logical', 'model:b': 'logical', 'model:c': 'physical' },
    } satisfies PersistedState);
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    expect(useEditorStore.getState().syncInferredTableKeys).toEqual({ 'model:a': 'logical' });
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
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.discrepancyVisible).toBe(false);
    expect(s.syncMode).toBe(false);
    expect(s.syncSelections).toEqual({});
    expect(s.canvasMode).toBe('pan');
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('does not restore Diff or ask for a report without a dbt project (logicalOnly)', () => {
    mockVsCode.getState.mockReturnValue({
      selectedNode: null,
      viewport: { x: 0, y: 0, zoom: 1 },
      detailPanelOpen: false,
      expandedNodes: [],
      allExpanded: false,
      discrepancyVisible: true,
      discrepancyCompareStage: 'physical',
      syncMode: true,
      syncSelections: { 'model:a': 'logical' },
    } satisfies PersistedState);
    useEditorStore.setState({ domain: subjectArea, logicalOnly: true });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.discrepancyVisible).toBe(false);
    expect(s.discrepancyCompareStage).toBeNull();
    expect(s.syncMode).toBe(false);
    expect(s.syncSelections).toEqual({});
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
    useEditorStore.setState({ domain: subjectArea });
    expect(() => renderHook(() => useStatePersistence())).not.toThrow();
    expect(useEditorStore.getState().canvasMode).toBe('pan');
  });
});

describe('useStatePersistence persist', () => {
  it('writes the new fields after the debounce', () => {
    vi.useFakeTimers();
    useEditorStore.setState({ domain: subjectArea });
    renderHook(() => useStatePersistence());

    act(() => {
      useEditorStore.getState().setCanvasMode('select');
      useEditorStore.getState().setDiscrepancyCompareStage('physical');
      useEditorStore.getState().setDiscrepancyVisible(true);
      useEditorStore.getState().setSyncMode(true);
      useEditorStore.getState().setSyncSelection('model:a', 'physical');
      useEditorStore.getState().setInferredTableChoice('model:b', 'logical');
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
      syncSelections: { 'model:a': 'physical', 'model:b': 'logical' },
      syncInferredTableKeys: { 'model:b': 'logical' },
    });
  });

  it('flushes a pending write immediately when the webview is hidden', () => {
    vi.useFakeTimers();
    useEditorStore.setState({ domain: subjectArea });
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

describe('useStatePersistence table detail level', () => {
  const base = { selectedNode: null, viewport: { x: 0, y: 0, zoom: 1 }, detailPanelOpen: false };

  it('restores the level and the tables opened on their own', () => {
    mockVsCode.getState.mockReturnValue({ ...base, expandedNodes: ['a'], allExpanded: false, tableDetail: 'name' } satisfies PersistedState);
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.tableDetail).toBe('name');
    expect([...s.expandedNodes]).toEqual(['a']);
    expect(s.allExpanded).toBe(false);
  });

  it('reads a blob from before the levels: "all expanded" is the all level', () => {
    mockVsCode.getState.mockReturnValue({ ...base, expandedNodes: ['a', 'b'], allExpanded: true } satisfies PersistedState);
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.tableDetail).toBe('all');
    expect(s.allExpanded).toBe(true);
    expect(s.expandedNodes.size).toBe(0);
  });

  it('reads a blob from before the levels: collapsed is the keys level, with the expanded tables still opened', () => {
    mockVsCode.getState.mockReturnValue({ ...base, expandedNodes: ['a'], allExpanded: false } satisfies PersistedState);
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    const s = useEditorStore.getState();
    expect(s.tableDetail).toBe('keys');
    expect(s.allExpanded).toBe(false);
    expect([...s.expandedNodes]).toEqual(['a']);
  });

  it('ignores a level it does not know and falls back to the expansion state', () => {
    mockVsCode.getState.mockReturnValue({ ...base, expandedNodes: [], allExpanded: true, tableDetail: 'everything' });
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    expect(useEditorStore.getState().tableDetail).toBe('all');
  });

  it('leaves the level alone for a blob with no expansion state at all', () => {
    mockVsCode.getState.mockReturnValue({ ...base });
    useEditorStore.setState({ domain: subjectArea });

    renderHook(() => useStatePersistence());

    expect(useEditorStore.getState().tableDetail ?? null).toBeNull();
  });

  it('writes the chosen level and the opened tables', () => {
    vi.useFakeTimers();
    useEditorStore.setState({ domain: subjectArea });
    renderHook(() => useStatePersistence());

    act(() => {
      useEditorStore.getState().setTableDetail('keys');
      useEditorStore.getState().toggleExpansion('a');
    });
    act(() => { vi.advanceTimersByTime(400); });

    const written = mockVsCode.setState.mock.calls.at(-1)![0] as PersistedState;
    expect(written).toMatchObject({ tableDetail: 'keys', expandedNodes: ['a'], allExpanded: false });

    act(() => { useEditorStore.getState().setTableDetail('all'); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(mockVsCode.setState.mock.calls.at(-1)![0]).toMatchObject({ tableDetail: 'all', expandedNodes: [], allExpanded: true });
  });
});
