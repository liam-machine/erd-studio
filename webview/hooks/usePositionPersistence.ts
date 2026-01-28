/**
 * usePositionPersistence — handles node position updates with debouncing.
 *
 * Subscribes to React Flow's `onNodesChange` events and handles two cases:
 *   1. During drag (dragging: true): Updates store immediately for visual feedback
 *   2. On drag end (dragging: false): Debounces and persists to extension host
 *
 * This ensures smooth visual dragging while minimizing file writes.
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
 * - Updates positions immediately during drag for visual feedback
 * - Debounces persistence to extension host (300ms after drag end)
 * - Batches multi-node drags into single update
 * - Skips unchanged positions to avoid no-op writes
 */
export function usePositionPersistence(): {
  onNodesChange: OnNodesChange<Node>;
} {
  const vscode = useVsCodeApi();
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);

  // Accumulate position changes for persistence (only final positions).
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
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Flush pending changes to extension host.
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
      const currentDomain = domainRef.current;
      if (!currentDomain) {
        return;
      }

      // Filter for position changes with valid positions.
      const positionChanges = changes.filter(
        (change): change is NodePositionChange =>
          change.type === 'position' && change.position !== undefined,
      );

      if (positionChanges.length === 0) {
        return;
      }

      // Separate dragging vs drag-end changes.
      const draggingChanges = positionChanges.filter((c) => c.dragging === true);
      const dragEndChanges = positionChanges.filter((c) => c.dragging === false);

      // --- Handle dragging: update store immediately for visual feedback ---
      if (draggingChanges.length > 0) {
        const currentPositions = currentDomain.viewConfig.positions ?? {};
        const newPositions = { ...currentPositions };

        for (const change of draggingChanges) {
          newPositions[change.id] = {
            x: change.position!.x,
            y: change.position!.y,
          };
        }

        // Update store for immediate visual feedback (no persistence yet).
        const updatedDomain = {
          ...currentDomain,
          viewConfig: {
            ...currentDomain.viewConfig,
            positions: newPositions,
          },
        };
        setDomain(updatedDomain);
      }

      // --- Handle drag end: accumulate for debounced persistence ---
      if (dragEndChanges.length > 0) {
        const savedPositions = currentDomain.viewConfig.positions ?? {};

        for (const change of dragEndChanges) {
          const newPos = change.position!;
          const oldPos = savedPositions[change.id];

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
            const latestDomain = domainRef.current;
            if (!latestDomain) {
              return;
            }

            const existingPositions = latestDomain.viewConfig.positions ?? {};
            const updatedPositions = {
              ...existingPositions,
              ...Object.fromEntries(pendingChangesRef.current),
            };

            // Persist to extension host (writes to JSON via WorkspaceEdit).
            const message: WebviewMessage = {
              type: 'updatePositions',
              payload: { positions: updatedPositions },
            };
            vscode.postMessage(message);

            pendingChangesRef.current.clear();
            timeoutRef.current = null;
          }, DEBOUNCE_DELAY_MS);
        }
      }
    },
    [setDomain, vscode, domainRef],
  );

  return { onNodesChange };
}
