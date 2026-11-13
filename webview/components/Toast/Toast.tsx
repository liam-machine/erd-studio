/**
 * Toast — brief notification component for user feedback.
 *
 * Auto-dismisses after 4 seconds by default (pass `autoDismissMs={null}` to
 * keep it on screen until the user dismisses it — used for host errors and
 * for a toast with buttons). Optional `actions` are buttons under the message;
 * each dismisses the toast, then runs.
 * Positioned bottom-right. Uses VS Code theme tokens for consistency.
 */

import { useEffect } from 'react';
import './Toast.css';

export type ToastVariant = 'info' | 'warning' | 'error';

export interface ToastActionButton {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  message: string;
  /** Buttons under the message (none by default). */
  actions?: ToastActionButton[];
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss; `null` disables auto-dismiss. Default 4000. */
  autoDismissMs?: number | null;
  onDismiss: () => void;
}

export const TOAST_AUTO_DISMISS_MS = 4000;

export function Toast({
  message,
  actions,
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
      <div className="toast__body">
        <span className="toast__message">{message}</span>
        {actions && actions.length > 0 && (
          <div className="toast__actions">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="toast__action"
                onClick={() => {
                  onDismiss();
                  action.onClick();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
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
