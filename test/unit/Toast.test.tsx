// @vitest-environment jsdom
/**
 * Toast component tests.
 *
 * Verifies the H03 behaviour: an error toast is dismissable, stays on screen
 * when auto-dismiss is disabled, and the default variant still auto-dismisses.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { Toast, TOAST_AUTO_DISMISS_MS } from '../../webview/components/Toast/Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Toast', () => {
  it('renders the message with the variant modifier class', () => {
    render(<Toast message="Failed to rename model" variant="error" onDismiss={() => {}} />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toContain('toast--error');
    expect(alert.textContent).toContain('Failed to rename model');
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(<Toast message="boom" variant="error" autoDismissMs={null} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does not auto-dismiss when autoDismissMs is null', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="boom" variant="error" autoDismissMs={null} onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 10);
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('auto-dismisses after the default delay', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast message="heads up" variant="warning" onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
