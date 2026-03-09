/**
 * usePositionPersistence — handles React Flow node changes with position persistence.
 *
 * Uses React Flow's `applyNodeChanges` to handle all change types:
 *   - Selection: Nodes can be selected/deselected (multi-select supported)
 *   - Position: Nodes can be dragged, positions update immediately
 *   - Other: Handles add/remove/reset changes
 *
 * Position changes are persisted to the extension host with debouncing.
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
import type { ModelFlowNode } from '../types/graph';

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
  const nodes = useEditorStore((s) => s.nodes);
  const setNodes = useEditorStore((s) => s.setNodes);
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);

  // Accumulate position changes for persistence (only final positions).
  const pendingChangesRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );

  // Debounce timeout handle.
  const timeoutRef = useRef<number | null>(null);

  // Refs to avoid stale closures in timeout callback.
  const domainRef = useRef(domain);
  const nodesRef = useRef(nodes);
  useEffect(() => {
    domainRef.current = domain;
  }, [domain]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // On unmount: cancel pending timeout and flush any accumulated changes.
  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }

      // Flush pending changes to extension host.
      if (pendingChangesRef.current.size > 0 && domainRef.current) {
        const latestDomain = domainRef.current;
        const changedPositions = Object.fromEntries(pendingChangesRef.current);

        // Send only the delta — extension merges over disk positions to avoid
        // concurrent tabs clobbering each other's saves.
        const message: WebviewMessage = {
          type: 'updatePositions',
          payload: { positions: changedPositions },
        };
        vscode.postMessage(message);

        // Optimistic local update with full merge for correct UI rendering
        const existingPositions = latestDomain.viewConfig.positions ?? {};
        setDomain({
          ...latestDomain,
          viewConfig: {
            ...latestDomain.viewConfig,
            positions: { ...existingPositions, ...changedPositions },
          },
        });

        pendingChangesRef.current.clear();
      }
    };
  }, [vscode, setDomain]);

  const onNodesChange: OnNodesChange<Node> = useCallback(
    (changes: NodeChange<Node>[]) => {
      // Apply all changes to nodes (handles selection, position, etc.).
      const updatedNodes = applyNodeChanges(changes, nodesRef.current);
      setNodes(updatedNodes as ModelFlowNode[]);

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

      for (const change of dragEndChanges) {
        const newPos = change.position;
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

          const changedPositions = Object.fromEntries(pendingChangesRef.current);

          // Send only the delta — extension merges over disk positions to avoid
          // concurrent tabs clobbering each other's saves.
          const message: WebviewMessage = {
            type: 'updatePositions',
            payload: { positions: changedPositions },
          };
          vscode.postMessage(message);

          // Optimistic local update with full merge for correct UI rendering.
          const existingPositions = latestDomain.viewConfig.positions ?? {};
          setDomain({
            ...latestDomain,
            viewConfig: {
              ...latestDomain.viewConfig,
              positions: { ...existingPositions, ...changedPositions },
            },
          });

          pendingChangesRef.current.clear();
          timeoutRef.current = null;
        }, DEBOUNCE_DELAY_MS);
      }
    },
    [setNodes, setDomain, vscode],
  );

  return { onNodesChange };
}
