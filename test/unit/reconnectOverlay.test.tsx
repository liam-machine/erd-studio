// @vitest-environment jsdom
/**
 * The "Canvas disconnected" overlay (issue #149).
 *
 * It is the safety net for a host that never answers the webview's `ready`.
 * An `error` is an answer, so the full-screen load-error page must never start
 * or keep the 5 s timer, and Retry must start a fresh grace period instead of
 * reopening the loading screen with the overlay already set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
  getVsCodeApi: () => mockVsCode,
}));

import { LOADING_STALL_MS, RECONNECT_GRACE_MS, useReconnectWatchdog } from '../../webview/hooks/useReconnectWatchdog';
import { App } from '../../webview/App';
import { ReconnectOverlay } from '../../webview/components/ReconnectOverlay/ReconnectOverlay';
import { useEditorStore } from '../../webview/store/editorStore';

const initialStoreState = useEditorStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useEditorStore.setState(initialStoreState, true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useReconnectWatchdog', () => {
  it('times out after the grace period while waiting', () => {
    const { result } = renderHook(() => useReconnectWatchdog(true));
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });

  it('never times out while not waiting', () => {
    const { result } = renderHook(() => useReconnectWatchdog(false));
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS * 3); });
    expect(result.current).toBe(false);
  });

  it('an answer hides a shown overlay, and waiting again starts a fresh grace period', () => {
    const { result, rerender } = renderHook(({ waiting }) => useReconnectWatchdog(waiting), {
      initialProps: { waiting: true },
    });
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS); });
    expect(result.current).toBe(true);

    rerender({ waiting: false });
    expect(result.current).toBe(false);

    rerender({ waiting: true });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1); });
    expect(result.current).toBe(false);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(true);
  });
});

describe('App load-error page and the reconnect overlay', () => {
  function postFromHost(data: unknown) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data }));
    });
  }

  function hostError() {
    postFromHost({ type: 'error', payload: { message: 'Invalid JSON in domain file', kind: 'domain-file' } });
  }

  const overlay = () => screen.queryByText('Canvas disconnected');

  it('a silent host gets the overlay after the grace period', () => {
    render(<App />);
    expect(screen.getByText(/Loading diagram/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS); });
    expect(overlay()).not.toBeNull();
  });

  it('an error page does not arm the timer, and Retry shows the loading screen without the overlay', () => {
    render(<App />);
    hostError();
    expect(screen.getByRole('alert').textContent).toContain('Invalid JSON in domain file');

    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2); });
    expect(overlay()).toBeNull();

    fireEvent.click(screen.getByText('Retry'));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'ready' });
    expect(screen.getByText(/Loading diagram/)).toBeTruthy();
    expect(overlay()).toBeNull();

    // The host re-reads and answers with the error again: still no overlay.
    act(() => { vi.advanceTimersByTime(1200); });
    hostError();
    expect(overlay()).toBeNull();
  });

  it('an error that arrives after the overlay showed replaces it', () => {
    render(<App />);
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS); });
    expect(overlay()).not.toBeNull();
    hostError();
    expect(overlay()).toBeNull();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('a Retry that gets no answer shows the overlay after a fresh grace period', () => {
    render(<App />);
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1000); });
    hostError();
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS * 2); });

    fireEvent.click(screen.getByText('Retry'));
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS - 1); });
    expect(overlay()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(overlay()).not.toBeNull();
  });

  it('the host\'s loading message stops the disconnect timer and says how many tables are loading', () => {
    render(<App />);
    act(() => { vi.advanceTimersByTime(1000); });
    postFromHost({ type: 'loading', payload: {} });
    expect(screen.getByText(/Loading diagram/)).toBeTruthy();
    postFromHost({ type: 'loading', payload: { tables: 1100 } });
    expect(screen.getByText(`Loading ${(1100).toLocaleString()} tables…`)).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
    // A large diagram that takes far longer than the old 5 s grace: no overlay.
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS * 6); });
    expect(overlay()).toBeNull();
  });

  it('a loading message that arrives after the grace period hides the overlay and starts the longer wait', () => {
    render(<App />);
    // The host was busy (another tab's open, activation) for longer than the grace period.
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS + 10); });
    expect(overlay()).not.toBeNull();
    postFromHost({ type: 'loading', payload: { tables: 500 } });
    expect(overlay()).toBeNull();
    act(() => { vi.advanceTimersByTime(LOADING_STALL_MS - 1); });
    expect(overlay()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(overlay()).not.toBeNull();
  });

  it('one table is "1 table"', () => {
    render(<App />);
    postFromHost({ type: 'loading', payload: { tables: 1 } });
    expect(screen.getByText('Loading 1 table…')).toBeTruthy();
  });

  it('a host that says it is loading and then never answers still gets the overlay, after the longer wait', () => {
    render(<App />);
    postFromHost({ type: 'loading', payload: { tables: 500 } });
    act(() => { vi.advanceTimersByTime(LOADING_STALL_MS - 1); });
    expect(overlay()).toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(overlay()).not.toBeNull();
  });

  it('an error after loading shows the error page, and its Retry gets the short grace period again', () => {
    render(<App />);
    postFromHost({ type: 'loading', payload: { tables: 500 } });
    hostError();
    expect(screen.getByText('Retry')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(screen.getByText(/Loading diagram/)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS); });
    expect(overlay()).not.toBeNull();
  });

  it('existingTables replaces the Add Existing Table rows', () => {
    render(<App />);
    const rows = [{ name: 'a', schema: 's', description: 'd', columnCount: 4, source: 'logical', sourcePath: 'x/a.dbml' }];
    postFromHost({ type: 'existingTables', payload: { existingModels: rows, manifestModels: [] } });
    expect(useEditorStore.getState().existingModels).toEqual(rows);
  });
});

describe('Show Logs on the reconnect overlay', () => {
  it('offers Reload Window and Show Logs, each calling its own handler', () => {
    const onReload = vi.fn();
    const onShowLogs = vi.fn();
    render(<ReconnectOverlay onReload={onReload} onShowLogs={onShowLogs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show Logs' }));
    expect(onShowLogs).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload Window' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('without onShowLogs there is no Show Logs button', () => {
    render(<ReconnectOverlay onReload={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Show Logs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reload Window' })).not.toBeNull();
  });

  it('in the canvas, the overlay\'s Show Logs asks the host to open the ERD Studio log', () => {
    render(<App />);
    act(() => { vi.advanceTimersByTime(RECONNECT_GRACE_MS); });
    fireEvent.click(screen.getByRole('button', { name: 'Show Logs' }));
    expect(mockVsCode.postMessage).toHaveBeenLastCalledWith({ type: 'showLogs' });
  });
});
