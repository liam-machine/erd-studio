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

import { RECONNECT_GRACE_MS, useReconnectWatchdog } from '../../webview/hooks/useReconnectWatchdog';
import { App } from '../../webview/App';
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
    expect(screen.getByText(/Loading domain/)).toBeTruthy();
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
    expect(screen.getByText(/Loading domain/)).toBeTruthy();
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
});
