/**
 * Custom hook for detecting long-press (press and hold) gestures.
 *
 * Used for initiating drag-to-create-relationship interactions. After the
 * specified delay, `onLongPressStart` fires to indicate a drag has begun.
 * The consumer is responsible for tracking mouse position and handling the
 * drop via global event listeners.
 */

import { useRef, useCallback, useState, useEffect } from 'react';

export interface UseLongPressDragOptions {
  /** Delay in ms before long-press is triggered. Default: 220ms */
  delay?: number;
  /** Called when long-press threshold is reached */
  onLongPressStart?: () => void;
  /** Called when press is cancelled (mouseup before delay, or mouse leaves) */
  onCancel?: () => void;
}

export interface UseLongPressDragReturn {
  /** Whether the press timer is active (for visual feedback like pulsing) */
  isPressing: boolean;
  /** Whether long-press completed and drag is active */
  isDragging: boolean;
  /** Call this to end the drag state (e.g., after drop) */
  endDrag: () => void;
  /** Event handlers to spread onto the pressable element */
  handlers: {
    onMouseDown: (e: React.MouseEvent) => void;
    onMouseUp: () => void;
    onMouseLeave: () => void;
  };
}

export function useLongPressDrag(options: UseLongPressDragOptions = {}): UseLongPressDragReturn {
  const { delay = 220, onLongPressStart, onCancel } = options;

  const [isPressing, setIsPressing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Store callbacks in refs to avoid stale closure issues in timer callbacks.
  // This ensures the timer always calls the latest version of the callback,
  // not the one captured when the timer was set.
  const onLongPressStartRef = useRef(onLongPressStart);
  const onCancelRef = useRef(onCancel);

  // Update refs on every render to keep them current
  useEffect(() => {
    onLongPressStartRef.current = onLongPressStart;
    onCancelRef.current = onCancel;
  });

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only respond to primary button (left click)
      if (e.button !== 0) return;

      // Prevent text selection during press
      e.preventDefault();
      // Stop propagation to prevent React Flow's node drag from starting
      e.stopPropagation();

      setIsPressing(true);

      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setIsPressing(false);
        setIsDragging(true);
        // Use ref to always call the latest callback
        onLongPressStartRef.current?.();
      }, delay);
    },
    [delay],
  );

  const handleMouseUp = useCallback(() => {
    if (timerRef.current !== null) {
      // Press ended before threshold — cancel
      clearTimer();
      setIsPressing(false);
      onCancelRef.current?.();
    }
    // Note: If already dragging, we don't reset here — consumer calls endDrag
  }, [clearTimer]);

  const handleMouseLeave = useCallback(() => {
    if (timerRef.current !== null) {
      // Mouse left before threshold — cancel
      clearTimer();
      setIsPressing(false);
      onCancelRef.current?.();
    }
  }, [clearTimer]);

  const endDrag = useCallback(() => {
    clearTimer();
    setIsPressing(false);
    setIsDragging(false);
  }, [clearTimer]);

  return {
    isPressing,
    isDragging,
    endDrag,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseUp: handleMouseUp,
      onMouseLeave: handleMouseLeave,
    },
  };
}
