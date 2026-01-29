/**
 * useStatePersistence — persists webview UI state to VS Code's webview state API.
 *
 * Subscribes to relevant Zustand store slices (selectedNode, viewport,
 * detailPanelOpen) and debounces writes to vscode.setState(). On mount, restores
 * state from vscode.getState() if available.
 *
 * Returns:
 * - shouldSkipFitView: true if viewport was restored (skip React Flow's fitView)
 * - invalidSelectedNode: name of restored node that no longer exists (for toast)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';

import { useVsCodeApi } from './useVsCodeApi';
import { useEditorStore } from '../store/editorStore';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PersistedState {
  selectedNode: string | null;
  viewport: Viewport;
  detailPanelOpen: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay in milliseconds (300ms after last change). */
const DEBOUNCE_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useStatePersistence(): {
  shouldSkipFitView: boolean;
  invalidSelectedNode: string | null;
  persistedViewport: Viewport | null;
} {
  const vscode = useVsCodeApi();

  // Zustand selectors
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const viewport = useEditorStore((s) => s.viewport);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const domain = useEditorStore((s) => s.domain);

  // Zustand actions for restoration
  const selectNode = useEditorStore((s) => s.selectNode);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);

  // Check synchronously on mount if we have a persisted viewport (for fitView skip)
  const [initialState] = useState(() => {
    const restored = vscode.getState() as PersistedState | null | undefined;
    return {
      shouldSkipFitView: restored?.viewport !== undefined,
      persistedViewport: restored?.viewport ?? null,
    };
  });
  const { shouldSkipFitView, persistedViewport } = initialState;

  // Track invalid selected node for toast notification
  const [invalidSelectedNode, setInvalidSelectedNode] = useState<string | null>(
    null,
  );

  // Debounce timeout
  const timeoutRef = useRef<number | null>(null);

  // Restoration flag (only restore once on mount)
  const hasRestoredRef = useRef(false);

  // Track if persistence is enabled (disabled until first domain load)
  const persistenceEnabledRef = useRef(false);

  // Refs to avoid stale closures in timeout callback
  const selectedNodeRef = useRef(selectedNode);
  const viewportRef = useRef(viewport);
  const detailPanelOpenRef = useRef(detailPanelOpen);

  // Keep refs in sync with state (single effect for efficiency)
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    viewportRef.current = viewport;
    detailPanelOpenRef.current = detailPanelOpen;
  }, [selectedNode, viewport, detailPanelOpen]);

  // Helper to build and write persisted state (avoids duplication)
  const persistState = useCallback(() => {
    const state: PersistedState = {
      selectedNode: selectedNodeRef.current,
      viewport: viewportRef.current,
      detailPanelOpen: detailPanelOpenRef.current,
    };
    vscode.setState(state);
  }, [vscode]);

  // ---------------------------------------------------------------------------
  // Restore state on mount (once domain is loaded)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!domain || hasRestoredRef.current) {
      return;
    }

    hasRestoredRef.current = true;
    // Enable persistence before applying restored state to avoid race condition
    persistenceEnabledRef.current = true;

    const restored = vscode.getState() as PersistedState | null | undefined;
    if (!restored) {
      return;
    }

    // Restore detail panel state
    if (restored.detailPanelOpen !== undefined) {
      setDetailPanelOpen(restored.detailPanelOpen);
    }

    // Restore viewport (shouldSkipFitView was already set synchronously on mount)
    if (restored.viewport) {
      setViewport(restored.viewport);
    }

    // Restore selected node (if it still exists)
    if (restored.selectedNode) {
      const nodeExists = domain.models.some(
        (m) => m.name === restored.selectedNode,
      );

      if (nodeExists) {
        selectNode(restored.selectedNode);
      } else {
        // Node no longer exists — clear selection and flag for toast
        selectNode(null);
        setDetailPanelOpen(false);
        setInvalidSelectedNode(restored.selectedNode);
      }
    }
  }, [domain, vscode, setDetailPanelOpen, setViewport, selectNode]);

  // ---------------------------------------------------------------------------
  // Persist state changes (debounced)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    // Skip persistence until first domain load and restoration complete
    if (!persistenceEnabledRef.current) {
      return;
    }

    // Clear existing timeout
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
    }

    // Schedule debounced write
    timeoutRef.current = window.setTimeout(() => {
      persistState();
      timeoutRef.current = null;
    }, DEBOUNCE_DELAY_MS);

    // Cleanup: flush on unmount
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        persistState();
      }
    };
  }, [selectedNode, viewport, detailPanelOpen, persistState]);

  return { shouldSkipFitView, invalidSelectedNode, persistedViewport };
}
