/**
 * useStatePersistence — persists webview UI state to VS Code's webview state API.
 *
 * Subscribes to relevant Zustand store slices (selectedNode, viewport,
 * detailPanelOpen, expandedNodes, allExpanded, canvasMode, discrepancy
 * overlay state and sync-merge selections) and debounces writes to
 * vscode.setState(). On mount, restores state from vscode.getState() if
 * available. Pending writes are flushed immediately when the webview is
 * hidden so a tab switch never loses the last 300 ms of changes.
 *
 * Returns:
 * - shouldSkipFitView: true if viewport was restored (skip React Flow's fitView)
 * - invalidSelectedNode: name of restored node that no longer exists (for toast)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewport } from '@xyflow/react';

import { useVsCodeApi } from './useVsCodeApi';
import { useEditorStore } from '../store/editorStore';
import type { Stage } from '../../src/types/semantic';
import type { GroundTruth } from '../../src/types/syncPlan';
import type { WebviewMessage } from './useMessageBus';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersistedState {
  selectedNode: string | null;
  viewport: Viewport;
  detailPanelOpen: boolean;
  expandedNodes: string[];
  allExpanded: boolean;
  /** Canvas interaction mode (pan / select). Optional for pre-existing state blobs. */
  canvasMode?: 'pan' | 'select';
  /** Whether the cross-stage discrepancy overlay was on. */
  discrepancyVisible?: boolean;
  /** The stage the overlay compared against (needed to re-request the report). */
  discrepancyCompareStage?: Stage | null;
  /** Whether the sync-merge modal was open. */
  syncMode?: boolean;
  /** Ground-truth choices made in the sync-merge modal. */
  syncSelections?: Record<string, GroundTruth>;
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
  const expandedNodes = useEditorStore((s) => s.expandedNodes);
  const allExpanded = useEditorStore((s) => s.allExpanded);
  const canvasMode = useEditorStore((s) => s.canvasMode);
  const discrepancyVisible = useEditorStore((s) => s.discrepancyVisible);
  const discrepancyCompareStage = useEditorStore((s) => s.discrepancyCompareStage);
  const syncMode = useEditorStore((s) => s.syncMode);
  const syncSelections = useEditorStore((s) => s.syncSelections);

  // Zustand actions for restoration
  const selectNode = useEditorStore((s) => s.selectNode);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const setExpandedNodes = useEditorStore((s) => s.setExpandedNodes);
  const setCanvasMode = useEditorStore((s) => s.setCanvasMode);
  const setDiscrepancyVisible = useEditorStore((s) => s.setDiscrepancyVisible);
  const setDiscrepancyCompareStage = useEditorStore((s) => s.setDiscrepancyCompareStage);
  const setSyncMode = useEditorStore((s) => s.setSyncMode);
  const setSyncSelectionBulk = useEditorStore((s) => s.setSyncSelectionBulk);

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
  const expandedNodesRef = useRef(expandedNodes);
  const allExpandedRef = useRef(allExpanded);
  const canvasModeRef = useRef(canvasMode);
  const discrepancyVisibleRef = useRef(discrepancyVisible);
  const discrepancyCompareStageRef = useRef(discrepancyCompareStage);
  const syncModeRef = useRef(syncMode);
  const syncSelectionsRef = useRef(syncSelections);

  // Keep refs in sync with state (single effect for efficiency)
  useEffect(() => {
    selectedNodeRef.current = selectedNode;
    viewportRef.current = viewport;
    detailPanelOpenRef.current = detailPanelOpen;
    expandedNodesRef.current = expandedNodes;
    allExpandedRef.current = allExpanded;
    canvasModeRef.current = canvasMode;
    discrepancyVisibleRef.current = discrepancyVisible;
    discrepancyCompareStageRef.current = discrepancyCompareStage;
    syncModeRef.current = syncMode;
    syncSelectionsRef.current = syncSelections;
  }, [
    selectedNode, viewport, detailPanelOpen, expandedNodes, allExpanded,
    canvasMode, discrepancyVisible, discrepancyCompareStage, syncMode, syncSelections,
  ]);

  // Helper to build and write persisted state (avoids duplication)
  const persistState = useCallback(() => {
    const state: PersistedState = {
      selectedNode: selectedNodeRef.current,
      viewport: viewportRef.current,
      detailPanelOpen: detailPanelOpenRef.current,
      expandedNodes: [...expandedNodesRef.current],
      allExpanded: allExpandedRef.current,
      canvasMode: canvasModeRef.current,
      discrepancyVisible: discrepancyVisibleRef.current,
      discrepancyCompareStage: discrepancyCompareStageRef.current,
      syncMode: syncModeRef.current,
      syncSelections: { ...syncSelectionsRef.current },
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

    // Restore column expansion state
    if (restored.expandedNodes !== undefined) {
      setExpandedNodes(restored.expandedNodes, restored.allExpanded ?? false);
    }

    // Restore canvas interaction mode
    if (restored.canvasMode === 'pan' || restored.canvasMode === 'select') {
      setCanvasMode(restored.canvasMode);
    }

    // Restore discrepancy overlay + sync-merge state. The report itself is not
    // persisted (it can be large and goes stale) — re-request it from the
    // extension host, which re-runs the comparison and posts `discrepancyReport`.
    // Order matters: setDiscrepancyVisible(false) clears sync state, so the
    // overlay must be enabled before sync mode / selections are restored.
    if (restored.discrepancyVisible && restored.discrepancyCompareStage) {
      const compareAgainst = restored.discrepancyCompareStage;
      setDiscrepancyCompareStage(compareAgainst);
      setDiscrepancyVisible(true);

      if (restored.syncMode) {
        setSyncMode(true);
      }
      const selections = restored.syncSelections ?? {};
      const byChoice: Record<GroundTruth, string[]> = { logical: [], physical: [] };
      for (const [key, choice] of Object.entries(selections)) {
        if (choice === 'logical' || choice === 'physical') {
          byChoice[choice].push(key);
        }
      }
      if (byChoice.logical.length > 0) setSyncSelectionBulk(byChoice.logical, 'logical');
      if (byChoice.physical.length > 0) setSyncSelectionBulk(byChoice.physical, 'physical');

      const message: WebviewMessage = {
        type: 'toggleDiscrepancy',
        payload: { enabled: true, compareAgainst },
      };
      vscode.postMessage(message);
    }
  }, [
    domain, vscode, setDetailPanelOpen, setViewport, selectNode, setExpandedNodes,
    setCanvasMode, setDiscrepancyVisible, setDiscrepancyCompareStage, setSyncMode, setSyncSelectionBulk,
  ]);

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
  }, [
    selectedNode, viewport, detailPanelOpen, expandedNodes, allExpanded,
    canvasMode, discrepancyVisible, discrepancyCompareStage, syncMode, syncSelections,
    persistState,
  ]);

  // Flush a pending debounced write the moment the webview is hidden — the
  // iframe may be torn down (or frozen) before the 300 ms timer fires.
  useEffect(() => {
    const flush = () => {
      if (!persistenceEnabledRef.current) return;
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        persistState();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flush);
    };
  }, [persistState]);

  return { shouldSkipFitView, invalidSelectedNode, persistedViewport };
}
