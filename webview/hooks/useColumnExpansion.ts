/**
 * useColumnExpansion — manages column expansion state for ModelNodes.
 *
 * Tracks which model nodes have their columns expanded (showing all columns
 * vs collapsed showing first N columns). State lives in the Zustand store
 * so it can be persisted across tab switches via useStatePersistence.
 *
 * Smart collapsing: columns only collapse automatically when there are enough
 * nodes (NODE_THRESHOLD) to warrant performance optimization. Below that
 * threshold, all columns are shown by default.
 *
 * @module F405 Performance optimization
 */

import { useCallback } from 'react';
import { useEditorStore } from '../store/editorStore';

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
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Hook to manage column expansion state.
 *
 * State is stored in the Zustand editor store and persisted via
 * useStatePersistence so it survives webview re-creation on tab switches.
 */
export function useColumnExpansion(): UseColumnExpansionReturn {
  const expandedNodes = useEditorStore((s) => s.expandedNodes);
  const allExpanded = useEditorStore((s) => s.allExpanded);
  const toggleExpansion = useEditorStore((s) => s.toggleExpansion);
  const collapseAll = useEditorStore((s) => s.collapseAll);
  const expandAll = useEditorStore((s) => s.expandAll);

  const isExpanded = useCallback(
    (modelId: string) => allExpanded || expandedNodes.has(modelId),
    [expandedNodes, allExpanded],
  );

  return { isExpanded, toggleExpansion, collapseAll, expandAll, allExpanded };
}
