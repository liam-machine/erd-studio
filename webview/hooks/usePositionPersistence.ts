/**
 * usePositionPersistence — handles node position updates with debouncing.
 *
 * Subscribes to React Flow's `onNodesChange` events, filters for position
 * changes on drag end, debounces writes (300ms), and persists to the
 * extension host via `updatePositions` message.
 *
 * Follows the optimistic update pattern: updates Zustand store immediately,
 * then sends message to extension host for JSON persistence.
 */

import { useCallback, useRef, useEffect } from 'react';
import type { OnNodesChange, NodePositionChange, Node } from '@xyflow/react';

import { useVsCodeApi } from './useVsCodeApi';
import { useEditorStore } from '../store/editorStore';
import type { WebviewMessage } from './useMessageBus';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay in milliseconds (300ms after last drag end). */
const DEBOUNCE_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns an `onNodesChange` handler that persists node positions.
 *
 * - Filters for position changes on drag end only (`dragging: false`)
 * - Skips updates if position unchanged
 * - Debounces writes (300ms after last drag end)
 * - Batches multi-node drags into single update
 * - Updates Zustand store optimistically before sending message
 */
export function usePositionPersistence(): {
  onNodesChange: OnNodesChange<Node>;
} {
  const vscode = useVsCodeApi();
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);

  // Accumulate position changes within the debounce window.
  const pendingChangesRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );

  // Debounce timeout handle.
  const timeoutRef = useRef<number | null>(null);

  // Snapshot domain ref to avoid stale closure in timeout callback.
  const domainRef = useRef(domain);
  useEffect(() => {
    domainRef.current = domain;
  }, [domain]);

  // On unmount: cancel pending timeout and flush any accumulated changes.
  // This ensures position updates aren't lost if the editor closes quickly.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Flush pending changes to extension host (skip optimistic store update
      // since component is unmounting anyway).
      if (pendingChangesRef.current.size > 0 && domainRef.current) {
        const existingPositions = domainRef.current.viewConfig.positions ?? {};
        const updatedPositions = {
          ...existingPositions,
          ...Object.fromEntries(pendingChangesRef.current),
        };

        const message: WebviewMessage = {
          type: 'updatePositions',
          payload: { positions: updatedPositions },
        };
        vscode.postMessage(message);
        pendingChangesRef.current.clear();
      }
    };
  }, [vscode]);

  const onNodesChange: OnNodesChange<Node> = useCallback(
    (changes) => {
      if (!domainRef.current) {
        return;
      }

      // Filter for position changes on drag end (dragging: false).
      const positionChanges = changes.filter(
        (change): change is NodePositionChange =>
          change.type === 'position' &&
          change.dragging === false &&
          change.position !== undefined,
      );

      if (positionChanges.length === 0) {
        return;
      }

      const currentPositions = domainRef.current.viewConfig.positions ?? {};
      let hasChanges = false;

      // Accumulate changes, skipping unchanged positions.
      for (const change of positionChanges) {
        const nodeId = change.id;
        const newPos = change.position!;
        const oldPos = currentPositions[nodeId];

        // Skip if position unchanged (avoid no-op writes).
        // Use small tolerance to handle floating-point noise.
        if (
          oldPos &&
          Math.abs(oldPos.x - newPos.x) < 0.5 &&
          Math.abs(oldPos.y - newPos.y) < 0.5
        ) {
          continue;
        }

        pendingChangesRef.current.set(nodeId, {
          x: Math.round(newPos.x),
          y: Math.round(newPos.y),
        });
        hasChanges = true;
      }

      if (!hasChanges) {
        return;
      }

      // Clear existing debounce timer (reset the 300ms window).
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
      }

      // Schedule debounced write.
      timeoutRef.current = window.setTimeout(() => {
        const currentDomain = domainRef.current;
        if (!currentDomain) {
          return;
        }

        const existingPositions = currentDomain.viewConfig.positions ?? {};
        const updatedPositions = {
          ...existingPositions,
          ...Object.fromEntries(pendingChangesRef.current),
        };

        // Optimistic update: update store so UI reflects change immediately.
        const updatedDomain = {
          ...currentDomain,
          viewConfig: {
            ...currentDomain.viewConfig,
            positions: updatedPositions,
          },
        };
        setDomain(updatedDomain);

        // Persist to extension host (writes to JSON via WorkspaceEdit).
        const message: WebviewMessage = {
          type: 'updatePositions',
          payload: { positions: updatedPositions },
        };
        vscode.postMessage(message);

        // Clear accumulated changes.
        pendingChangesRef.current.clear();
        timeoutRef.current = null;
      }, DEBOUNCE_DELAY_MS);
    },
    // domainRef is stable (refs don't change), included for semantic clarity.
    [setDomain, vscode, domainRef],
  );

  return { onNodesChange };
}
