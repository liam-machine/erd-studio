/**
 * Toast — brief notification component for user feedback.
 *
 * Auto-dismisses after 4 seconds. Positioned bottom-right.
 * Uses VS Code theme tokens for consistency.
 */

import { useEffect } from 'react';
import './Toast.css';

export interface ToastProps {
  message: string;
  variant?: 'info' | 'warning';
  onDismiss: () => void;
}

export function Toast({ message, variant = 'info', onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onDismiss();
    }, 4000);

    return () => clearTimeout(timer);
  }, [onDismiss]);

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
