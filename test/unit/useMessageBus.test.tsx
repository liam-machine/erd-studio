// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockVsCode = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(),
  setState: vi.fn(),
}));

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => mockVsCode,
}));

import { useMessageBus, useSend } from '../../webview/hooks/useMessageBus';

beforeEach(() => {
  vi.clearAllMocks();
});

function messageListenerCount(spy: ReturnType<typeof vi.spyOn>): number {
  return spy.mock.calls.filter(([type]) => type === 'message').length;
}

describe('useSend', () => {
  it('does not register a window message listener', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const { result, rerender } = renderHook(() => useSend());
    rerender();
    expect(messageListenerCount(addSpy)).toBe(0);
    addSpy.mockRestore();

    act(() => {
      result.current({ type: 'undo' } as never);
    });
    expect(mockVsCode.postMessage).toHaveBeenCalledWith({ type: 'undo' });
  });

  it('returns a stable function across renders', () => {
    const { result, rerender } = renderHook(() => useSend());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useMessageBus', () => {
  it('registers exactly one message listener and forwards typed messages', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
    const onMessage = vi.fn();
    const { rerender, unmount } = renderHook(() => useMessageBus(onMessage));
    rerender();
    expect(messageListenerCount(addSpy)).toBe(1);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', payload: { message: 'x' } } }));
    });
    expect(onMessage).toHaveBeenCalledWith({ type: 'error', payload: { message: 'x' } });

    const removeSpy = vi.spyOn(window, 'removeEventListener');
    unmount();
    expect(messageListenerCount(removeSpy)).toBe(1);
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
