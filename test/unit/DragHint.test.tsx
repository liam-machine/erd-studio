// @vitest-environment jsdom
/**
 * DragHint — the one-time drag-to-relate tip. It shows on a logical, editable
 * diagram with two or more tables and no relationships; closing it hides it
 * for good in this webview (vscode state, written by useStatePersistence) and
 * never posts to the host. Never on the physical stage or read-only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
}));

import { DragHint, DRAG_HINT_TEXT } from '../../webview/components/Canvas/DragHint';
import { useStatePersistence, type PersistedState } from '../../webview/hooks/useStatePersistence';
import { useEditorStore } from '../../webview/store/editorStore';

const initial = useEditorStore.getState();
const table = (name: string) => ({ name, columns: [] });

function setDiagram(overrides: Record<string, unknown> = {}) {
  useEditorStore.setState({
    domain: {
      domain: 'd', layer: 'silver', stage: 'logical', readOnly: false, viewConfig: { positions: {} },
      models: [table('dim_customer'), table('fct_order')], relationships: [], ...overrides,
    } as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVsCode.getState.mockReturnValue(undefined);
  useEditorStore.setState(initial, true);
  setDiagram();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('DragHint', () => {
  it('teaches the gesture on a diagram with two tables and no relationships', () => {
    render(<DragHint />);
    expect(screen.getByRole('status').textContent).toContain(DRAG_HINT_TEXT);
    expect(DRAG_HINT_TEXT).toBe('Tip: press and hold a column, then drag it onto a column of another table to relate them.');
  });

  it.each([
    ['fewer than two tables', { models: [table('dim_customer')] }],
    ['a diagram that already has a relationship', {
      relationships: [{ fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }],
    }],
    ['the physical stage', { stage: 'physical' }],
    ['a read-only diagram', { readOnly: true }],
  ])('is hidden on %s', (_label, overrides) => {
    setDiagram(overrides);
    const { container } = render(<DragHint />);
    expect(container.innerHTML).toBe('');
  });

  it('is hidden before a diagram has loaded', () => {
    useEditorStore.setState({ domain: null });
    const { container } = render(<DragHint />);
    expect(container.innerHTML).toBe('');
  });

  it('steps aside while the New Relationship dialog is open', () => {
    useEditorStore.getState().setNewFkDialogOpen(true);
    const { container } = render(<DragHint />);
    expect(container.innerHTML).toBe('');
  });

  it('closes on ×, without posting anything to the host', () => {
    render(<DragHint />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss tip' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(useEditorStore.getState().dragHintDismissed).toBe(true);
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('stays closed when the webview state says it was dismissed, even before the store is restored', () => {
    mockVsCode.getState.mockReturnValue({ dragHintDismissed: true });
    const { container } = render(<DragHint />);
    expect(container.innerHTML).toBe('');
  });
});

describe('DragHint dismissal persistence (useStatePersistence)', () => {
  it('writes the dismissal to the webview state', () => {
    vi.useFakeTimers();
    renderHook(() => useStatePersistence());
    act(() => { useEditorStore.getState().setDragHintDismissed(true); });
    act(() => { vi.advanceTimersByTime(300); });
    const last = mockVsCode.setState.mock.calls.at(-1)?.[0] as PersistedState;
    expect(last.dragHintDismissed).toBe(true);
    expect(mockVsCode.postMessage).not.toHaveBeenCalled();
  });

  it('restores the dismissal into the store', () => {
    mockVsCode.getState.mockReturnValue({
      selectedNode: null, viewport: { x: 0, y: 0, zoom: 1 }, detailPanelOpen: false, expandedNodes: [], allExpanded: false,
      dragHintDismissed: true,
    } satisfies PersistedState);
    renderHook(() => useStatePersistence());
    expect(useEditorStore.getState().dragHintDismissed).toBe(true);
  });

  it('leaves the field out until the tip is dismissed', () => {
    vi.useFakeTimers();
    renderHook(() => useStatePersistence());
    act(() => { useEditorStore.getState().setCanvasMode('select'); });
    act(() => { vi.advanceTimersByTime(300); });
    const last = mockVsCode.setState.mock.calls.at(-1)?.[0] as PersistedState;
    expect(last).not.toHaveProperty('dragHintDismissed');
  });
});
