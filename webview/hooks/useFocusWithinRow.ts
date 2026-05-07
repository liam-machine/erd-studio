/**
 * useFocusWithinRow — hook for tracking focus within a container element.
 *
 * Uses requestAnimationFrame instead of setTimeout to reliably detect
 * when focus leaves a row container. This eliminates flicker issues
 * when switching between fields (e.g., name input → data type dropdown).
 */

import { useCallback, useState } from 'react';

export interface UseFocusWithinRowResult {
  /** Whether focus is currently within the row container. */
  isFocusWithin: boolean;
  /** Props to spread on the row container element. */
  rowProps: {
    onFocus: (e: React.FocusEvent) => void;
    onBlur: (e: React.FocusEvent) => void;
  };
}

/**
 * Hook for tracking focus within a row container.
 *
 * @param onFocusLeave - Callback fired when focus leaves the row entirely.
 *                       Use this to trigger auto-save or validation.
 */
export function useFocusWithinRow(
  onFocusLeave?: () => void
): UseFocusWithinRowResult {
  const [isFocusWithin, setIsFocusWithin] = useState(false);

  const handleFocus = useCallback(() => {
    setIsFocusWithin(true);
  }, []);

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      const currentTarget = e.currentTarget;

      // Use requestAnimationFrame to ensure DOM has settled after blur
      // This gives click handlers time to register before we check activeElement
      requestAnimationFrame(() => {
        // Check if the new active element is still within this row
        if (!currentTarget.contains(document.activeElement)) {
          setIsFocusWithin(false);
          onFocusLeave?.();
        }
      });
    },
    [onFocusLeave]
  );

  return {
    isFocusWithin,
    rowProps: {
      onFocus: handleFocus,
      onBlur: handleBlur,
    },
  };
}
