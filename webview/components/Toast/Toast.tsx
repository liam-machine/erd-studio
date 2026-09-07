/**
 * Toast — brief notification component for user feedback.
 *
 * Auto-dismisses after 4 seconds by default (pass `autoDismissMs={null}` to
 * keep it on screen until the user dismisses it — used for host errors).
 * Positioned bottom-right. Uses VS Code theme tokens for consistency.
 */

import { useEffect } from 'react';
import './Toast.css';

export type ToastVariant = 'info' | 'warning' | 'error';

export interface ToastProps {
  message: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss; `null` disables auto-dismiss. Default 4000. */
  autoDismissMs?: number | null;
  onDismiss: () => void;
}

export const TOAST_AUTO_DISMISS_MS = 4000;

export function Toast({
  message,
  variant = 'info',
  autoDismissMs = TOAST_AUTO_DISMISS_MS,
  onDismiss,
}: ToastProps) {
  useEffect(() => {
    if (autoDismissMs === null) return;
    const timer = window.setTimeout(() => {
      onDismiss();
    }, autoDismissMs);

    return () => clearTimeout(timer);
  }, [onDismiss, autoDismissMs]);

  return (
    <div className={`toast toast--${variant}`} role="alert">
      <span className="toast__message">{message}</span>
      <button
        className="toast__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        &times;
      </button>
    </div>
  );
}
