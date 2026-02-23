/**
 * useColumnExpansion — manages column expansion state for ModelNodes.
 *
 * Tracks which model nodes have their columns expanded (showing all columns
 * vs collapsed showing first N columns). State is persisted via the webview
 * state API through useStatePersistence so it survives tab switches.
 *
 * Smart collapsing: columns only collapse automatically when there are enough
 * nodes (NODE_THRESHOLD) to warrant performance optimization. Below that
 * threshold, all columns are shown by default on first load.
 *
 * @module F405 Performance optimization
 */

import { useState, useCallback, useMemo } from 'react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of columns to show when collapsed. */
export const COLLAPSED_COLUMN_LIMIT = 5;

/** Number of nodes required before auto-collapsing columns for performance. */
export const NODE_THRESHOLD = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseColumnExpansionReturn {
  /** Check if a model's columns are expanded (or should be shown due to low node count). */
  isExpanded: (modelId: string) => boolean;
  /** Toggle expansion state for a model. */
  toggleExpansion: (modelId: string) => void;
  /** Collapse all expanded models. */
  collapseAll: () => void;
  /** Expand all models (show all columns). */
  expandAll: (modelIds: string[]) => void;
  /** Whether columns are in "all expanded" mode. */
  allExpanded: boolean;
  /** Expanded model IDs as an array (for persistence). */
  expandedNodeIds: string[];
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook to manage column expansion state.
 *
 * Accepts optional initial state for restoration from persisted webview state.
 * Exposes `expandedNodeIds` array for external persistence.
 */
export function useColumnExpansion(
  initialExpandedNodes?: string[],
  initialAllExpanded?: boolean,
): UseColumnExpansionReturn {
  const [expandedSet, setExpandedSet] = useState<Set<string>>(
    () => new Set(initialExpandedNodes ?? []),
  );
  // Track if user has explicitly set "all expanded" mode
  const [allExpanded, setAllExpanded] = useState(initialAllExpanded ?? false);

  const isExpanded = useCallback(
    (modelId: string) => allExpanded || expandedSet.has(modelId),
    [expandedSet, allExpanded],
  );

  const toggleExpansion = useCallback((modelId: string) => {
    // If in allExpanded mode, switch to individual tracking and collapse this one
    setAllExpanded(false);
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
    setAllExpanded(false);
    setExpandedSet(new Set());
  }, []);

  const expandAll = useCallback((modelIds: string[]) => {
    setAllExpanded(true);
    setExpandedSet(new Set(modelIds));
  }, []);

  // Expose expanded IDs as a stable array for persistence
  const expandedNodeIds = useMemo(() => Array.from(expandedSet), [expandedSet]);

  return { isExpanded, toggleExpansion, collapseAll, expandAll, allExpanded, expandedNodeIds };
}
