/**
 * usePositionPersistence — handles React Flow node changes with position persistence.
 *
 * Uses React Flow's `applyNodeChanges` to handle all change types:
 *   - Selection: Nodes can be selected/deselected (multi-select supported)
 *   - Position: Nodes can be dragged, positions update immediately
 *   - Other: Handles add/remove/reset changes
 *
 * Position changes are persisted to the extension host with debouncing.
 * Pending (not yet debounced) positions are flushed immediately when the
 * webview is hidden (`visibilitychange` / `pagehide`) or unmounted so a tab
 * switch shortly after a drag never loses the move.
 */

import { useCallback, useRef, useEffect } from 'react';
import {
  applyNodeChanges,
  type OnNodesChange,
  type NodeChange,
  type Node,
} from '@xyflow/react';

import { useVsCodeApi } from './useVsCodeApi';
import { useEditorStore } from '../store/editorStore';
import type { WebviewMessage } from './useMessageBus';
import type { ModelFlowNode, AnnotationFlowNode } from '../types/graph';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay in milliseconds (300ms after last drag end). */
const DEBOUNCE_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns an `onNodesChange` handler that:
 * - Applies all changes (selection, position, etc.) to nodes in store
 * - Persists position changes to extension host with debouncing
 */
export function usePositionPersistence(): {
  onNodesChange: OnNodesChange<Node>;
} {
  const vscode = useVsCodeApi();
  const setNodes = useEditorStore((s) => s.setNodes);
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);

  // Accumulate position changes for persistence (only final positions).
  const pendingChangesRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );

  // Debounce timeout handle.
  const timeoutRef = useRef<number | null>(null);

  // Ref to avoid stale closures in timeout callback.
  const domainRef = useRef(domain);
  useEffect(() => {
    domainRef.current = domain;
  }, [domain]);

  /**
   * Send every pending position to the extension host and apply the same
   * positions to the local domain (optimistic update). Safe to call when
   * nothing is pending. Cancels any scheduled debounced flush.
   */
  const flushPending = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    const latestDomain = domainRef.current;
    if (pendingChangesRef.current.size === 0 || !latestDomain) {
      return;
    }

    // Partition changes: annotation nodes vs model nodes.
    const modelPositions: Record<string, { x: number; y: number }> = {};
    const annotationPositions: Array<{ id: string; x: number; y: number }> = [];

    for (const [nodeId, pos] of pendingChangesRef.current) {
      if (nodeId.startsWith('annotation-')) {
        annotationPositions.push({ id: nodeId.slice('annotation-'.length), x: pos.x, y: pos.y });
      } else {
        modelPositions[nodeId] = pos;
      }
    }

    // Send model position delta.
    if (Object.keys(modelPositions).length > 0) {
      const message: WebviewMessage = {
        type: 'updatePositions',
        payload: { positions: modelPositions },
      };
      vscode.postMessage(message);
    }

    // Send annotation position updates.
    for (const ann of annotationPositions) {
      vscode.postMessage({
        type: 'updateAnnotationPosition',
        payload: ann,
      } as WebviewMessage);
    }

    // Optimistic local update with full merge for correct UI rendering.
    const existingPositions = latestDomain.viewConfig.positions ?? {};
    const updatedAnnotations = annotationPositions.length > 0 && latestDomain.viewConfig.annotations
      ? latestDomain.viewConfig.annotations.map((ann) => {
          const moved = annotationPositions.find((a) => a.id === ann.id);
          return moved ? { ...ann, x: moved.x, y: moved.y } : ann;
        })
      : latestDomain.viewConfig.annotations;
    setDomain({
      ...latestDomain,
      viewConfig: {
        ...latestDomain.viewConfig,
        positions: { ...existingPositions, ...modelPositions },
        ...(updatedAnnotations ? { annotations: updatedAnnotations } : {}),
      },
    });

    pendingChangesRef.current.clear();
  }, [vscode, setDomain]);

  // Flush immediately when the webview is hidden (tab switch, editor group
  // change, window close). Without retainContextWhenHidden the iframe is torn
  // down without running React cleanups, and even with it a `pagehide` can
  // still arrive before the 300 ms debounce fires.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPending();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushPending);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pagehide', flushPending);
    };
  }, [flushPending]);

  // On unmount: cancel pending timeout and flush any accumulated changes.
  useEffect(() => {
    return () => {
      flushPending();
    };
  }, [flushPending]);

  const onNodesChange: OnNodesChange<Node> = useCallback(
    (changes: NodeChange<Node>[]) => {
      // Apply all changes to nodes (handles selection, position, etc.).
      // Read the store directly rather than a post-commit ref: two change
      // batches dispatched in the same task must both apply, and a ref that
      // only refreshes in a useEffect would make the second batch overwrite
      // the first (dropping selection or measured dimensions).
      const updatedNodes = applyNodeChanges(changes, useEditorStore.getState().nodes);
      setNodes(updatedNodes as (ModelFlowNode | AnnotationFlowNode)[]);

      // Extract position changes for persistence.
      const dragEndChanges = changes.filter(
        (change): change is NodeChange<Node> & { type: 'position'; position: { x: number; y: number } } =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false &&
          'position' in change &&
          change.position !== undefined,
      );

      if (dragEndChanges.length === 0) {
        return;
      }

      const currentDomain = domainRef.current;
      if (!currentDomain) {
        return;
      }

      const savedPositions = currentDomain.viewConfig.positions ?? {};
      // Build annotation position lookup for no-op detection
      const annotationPositions = new Map(
        (currentDomain.viewConfig.annotations ?? []).map((a) => [`annotation-${a.id}`, { x: a.x, y: a.y }]),
      );

      for (const change of dragEndChanges) {
        const newPos = change.position;
        const oldPos = change.id.startsWith('annotation-')
          ? annotationPositions.get(change.id)
          : savedPositions[change.id];

        // Skip if position unchanged (avoid no-op writes).
        if (
          oldPos &&
          Math.abs(oldPos.x - newPos.x) < 0.5 &&
          Math.abs(oldPos.y - newPos.y) < 0.5
        ) {
          continue;
        }

        pendingChangesRef.current.set(change.id, {
          x: Math.round(newPos.x),
          y: Math.round(newPos.y),
        });
      }

      // Schedule debounced persistence if we have changes.
      if (pendingChangesRef.current.size > 0) {
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
        }

        timeoutRef.current = window.setTimeout(() => {
          timeoutRef.current = null;
          flushPending();
        }, DEBOUNCE_DELAY_MS);
      }
    },
    [setNodes, flushPending],
  );

  return { onNodesChange };
}
