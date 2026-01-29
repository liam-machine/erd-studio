/**
 * useColumnExpansion — manages ephemeral column expansion state for ModelNodes.
 *
 * Tracks which model nodes have their columns expanded (showing all columns
 * vs collapsed showing first N columns). State is ephemeral — it resets when
 * the domain changes because the hook recreates with a fresh Set.
 *
 * @module F405 Performance optimization
 */

import { useState, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of columns to show when collapsed. */
export const COLLAPSED_COLUMN_LIMIT = 5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseColumnExpansionReturn {
  /** Check if a model's columns are expanded. */
  isExpanded: (modelId: string) => boolean;
  /** Toggle expansion state for a model. */
  toggleExpansion: (modelId: string) => void;
  /** Collapse all expanded models. */
  collapseAll: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook to manage column expansion state.
 *
 * State is local to this hook instance — when the component using this hook
 * unmounts or re-mounts (e.g., on domain change), all expansion state resets.
 */
export function useColumnExpansion(): UseColumnExpansionReturn {
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() => new Set());

  const isExpanded = useCallback(
    (modelId: string) => expandedSet.has(modelId),
    [expandedSet],
  );

  const toggleExpansion = useCallback((modelId: string) => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpandedSet(new Set());
  }, []);

  return { isExpanded, toggleExpansion, collapseAll };
}
