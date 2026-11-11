/**
 * useColumnExpansion — manages column expansion state for ModelNodes.
 *
 * Tracks which model nodes are opened on their own (every column shown,
 * whatever the diagram's table detail level). State lives in the Zustand
 * store so it can be persisted across tab switches via useStatePersistence.
 *
 * A diagram opens with every column shown below NODE_THRESHOLD tables, and
 * with less above it (`defaultTableDetail` in lib/tableDetail.ts).
 *
 * @module F405 Performance optimization
 */

import { useCallback } from 'react';
import { useEditorStore } from '../store/editorStore';
import { LEGACY_COLLAPSED_COLUMN_LIMIT, TABLE_DETAIL_ALL_BELOW } from '../lib/tableDetail';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of columns a table with no detail level shows when collapsed. */
export const COLLAPSED_COLUMN_LIMIT = LEGACY_COLLAPSED_COLUMN_LIMIT;

/** Number of nodes at which a diagram stops opening with every column shown. */
export const NODE_THRESHOLD = TABLE_DETAIL_ALL_BELOW;

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

  const tableDetail = useEditorStore((s) => s.tableDetail ?? null);

  // At a table detail level `expandedNodes` holds the tables opened on their
  // own; `allExpanded` only mirrors the `all` level. Without a level it is
  // the older global switch.
  const isExpanded = useCallback(
    (modelId: string) => (tableDetail === null && allExpanded) || expandedNodes.has(modelId),
    [expandedNodes, allExpanded, tableDetail],
  );

  return { isExpanded, toggleExpansion, collapseAll, expandAll, allExpanded };
}
