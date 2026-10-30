/**
 * useHoverFocus — hover a table to preview what it connects to, and keep the
 * moving relationship arrows on the right lines.
 *
 * Rest the pointer on a table and, after a short hover-intent delay, it and
 * its related tables stay bright while everything else fades, as a click
 * does. Move away and the diagram, or whatever was clicked, comes back.
 *
 * Precedence:
 *   1. Hover previews: while `hoverFocus` is set, the hovered neighbourhood is
 *      bright and everything else is faded, over click and search dimming.
 *   2. Leaving restores: hover never touches `data.dimmed`, so the click and
 *      search state reappears exactly as it was.
 *   3. The clicked table stays findable at half opacity while a hover fades it.
 *   4. Arrows follow `flowFocus = hoverFocus ?? focus(clicked table | line)`.
 *      A click selection's arrows settle (stand still, still pointing the
 *      way) after `SELECTION_FLOW_SETTLE_MS`, so a table left selected does
 *      not keep the canvas animating; a hover's arrows move while it lasts.
 *   5. The hover preview lights only the hovered table's own lines, not the
 *      lines between its neighbours (`ownLinesOnly`); a click keeps both.
 *
 * Render path: hover never rewrites the nodes or edges arrays (every
 * `setEdges` re-renders every `FkEdge`). The store holds `CanvasFocus` sets,
 * `flowClassName` on the React Flow root fades everything in CSS, and each
 * table and line reads its own part with an O(1) selector that returns a
 * primitive, so only the tables and lines whose part changed re-render.
 *
 * Ephemeral: `hoverFocus` / `flowFocus` are never persisted, posted to the
 * host or written to a file, and there is no message type. The preview is not
 * an editing affordance, so it works the same in viewer mode and on the
 * read-only Physical tab (any future viewer gate: `viewer ? … : <upstream>`).
 *
 * Suppressed (checked at event time): any mouse button held, a pane drag or
 * box selection, a viewport move (pan, wheel zoom, inertia), a column drag
 * to create a relationship, an annotation link drag, an open context menu, a
 * device without a fine hover pointer. The column and annotation drags and
 * the context menu also clear a hover at once, so a drop target is never
 * faded. A node drag freezes the focus until it stops; grabbing a table other
 * than the hovered one moves the focus to it first, and dropping a table the
 * focus is not on previews it (the pointer is still resting there).
 *
 * Lives apart from `useCanvasGraph` because it needs React Flow's store; both
 * hosts call it inside their `ReactFlowProvider`. `useOnViewportChange` takes
 * React Flow's single `onViewportChangeStart/End` slot: no host uses it.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useOnViewportChange, useStoreApi, type NodeMouseHandler, type EdgeMouseHandler, type OnNodeDrag } from '@xyflow/react';
import { useEditorStore, useEditorStoreApi, type CanvasStore } from '../store/editorStore';
import { computeCanvasFocus } from '../lib/canvasFocus';
import { createHoverIntent, type HoverIntent } from '../lib/hoverIntent';
import type { GraphNode, GraphEdge } from '../lib/nodeOverlays';

export interface HoverFocusHandlers {
  onNodeMouseEnter: NodeMouseHandler<GraphNode>;
  onNodeMouseLeave: NodeMouseHandler<GraphNode>;
  onEdgeMouseEnter: EdgeMouseHandler<GraphEdge>;
  onEdgeMouseLeave: EdgeMouseHandler<GraphEdge>;
  onNodeDragStart: OnNodeDrag<GraphNode>;
  onNodeDragStop: OnNodeDrag<GraphNode>;
}

export interface UseHoverFocusResult {
  /** Spread onto `<ReactFlow>`. Stable across renders. */
  hoverHandlers: HoverFocusHandlers;
  /** `className` for `<ReactFlow>`: `erd-flow`, plus `erd-flow--hover-focus` while a hover preview is on. */
  flowClassName: string;
}

const HOVER_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

/** A click selection's arrows move this long, then stand still. */
export const SELECTION_FLOW_SETTLE_MS = 6000;

function modelIds(nodes: readonly GraphNode[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) if (n.type === 'model') ids.add(n.id);
  return ids;
}

function blocking(s: CanvasStore): boolean {
  return s.dragLineState !== null || s.annotationLinkDrag !== null || s.contextMenu !== null;
}

function selectionFocus(s: CanvasStore) {
  return computeCanvasFocus(s.edges, {
    node: s.selectedNode,
    edge: s.selectedNode ? null : s.selectedEdge,
  });
}

function selectionKey(s: CanvasStore): string | null {
  if (s.selectedNode) return `n:${s.selectedNode}`;
  return s.selectedEdge ? `e:${s.selectedEdge}` : null;
}

/** The hover preview for a table: it and its neighbours, its own lines lit. */
function hoverFocusFor(s: CanvasStore, id: string) {
  return computeCanvasFocus(s.edges, { node: id }, modelIds(s.nodes), { ownLinesOnly: true });
}

export function useHoverFocus(): UseHoverFocusResult {
  const storeApi = useEditorStoreApi();
  const flowApi = useStoreApi();
  const hoverActive = useEditorStore((s) => s.hoverFocus !== null);

  const controllerRef = useRef<HoverIntent | null>(null);
  const draggingRef = useRef(false);
  const movingRef = useRef(false);
  const pointerListRef = useRef<MediaQueryList | null | undefined>(undefined);

  useEffect(() => {
    const pointerCanHover = (): boolean => {
      if (pointerListRef.current === undefined) {
        pointerListRef.current =
          typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(HOVER_POINTER_QUERY) ?? null
            : null;
      }
      // No matchMedia: allowed.
      return pointerListRef.current ? pointerListRef.current.matches : true;
    };

    const controller = createHoverIntent({
      current: () => storeApi.getState().hoverFocus?.node ?? null,
      isSuppressed: () => {
        const s = storeApi.getState();
        if (blocking(s) || draggingRef.current || movingRef.current) return true;
        const flow = flowApi.getState();
        if (flow.paneDragging || flow.userSelectionActive) return true;
        return !pointerCanHover();
      },
      commit: (id) => {
        const s = storeApi.getState();
        s.setHoverFocus(id === null ? null : hoverFocusFor(s, id));
      },
    });
    controllerRef.current = controller;

    // The selection whose arrows have settled (stand still), and the timer
    // that settles them. A hover or a new selection starts them moving again.
    let settledKey: string | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearSettle = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
    };
    const nextFlow = (s: CanvasStore) => {
      if (s.hoverFocus) return s.hoverFocus;
      const focus = selectionFocus(s);
      if (focus && focus.animate && settledKey !== null && settledKey === selectionKey(s)) {
        return { ...focus, animate: false };
      }
      return focus;
    };
    const scheduleSettle = () => {
      clearSettle();
      const s = storeApi.getState();
      if (s.hoverFocus || !s.flowFocus || !s.flowFocus.animate) return;
      const key = selectionKey(s);
      if (key === null) return;
      settleTimer = setTimeout(() => {
        settleTimer = null;
        const now = storeApi.getState();
        if (now.hoverFocus || selectionKey(now) !== key) return;
        settledKey = key;
        now.setFlowFocus(nextFlow(now));
      }, SELECTION_FLOW_SETTLE_MS);
    };

    // Keep both focuses true to the graph and the selection. Writes go through
    // the `sameFocus` guards, so a drag frame that leaves the topology as it
    // was writes nothing; a write re-enters this listener once and stops there.
    const unsubscribe = storeApi.subscribe((s, prev) => {
      if (s.flowFocus !== prev.flowFocus) scheduleSettle();
      if (s.hoverFocus !== null && prev.hoverFocus === null) settledKey = null;
      if (s.selectedNode !== prev.selectedNode || s.selectedEdge !== prev.selectedEdge) settledKey = null;

      if (blocking(s)) {
        if (!blocking(prev)) controller.cancelPending();
        if (s.hoverFocus) {
          s.setHoverFocus(null);
          return; // the nested call recomputes the flow
        }
      }

      if (s.hoverFocus && s.hoverFocus === prev.hoverFocus) {
        const hovered = s.hoverFocus.node;
        if (s.edges !== prev.edges) {
          s.setHoverFocus(hovered === null ? null : hoverFocusFor(s, hovered));
          if (storeApi.getState().hoverFocus !== s.hoverFocus) return;
        } else if (s.nodes !== prev.nodes && hovered !== null && !s.nodes.some((n) => n.id === hovered)) {
          s.setHoverFocus(null);
          return;
        }
      }

      if (
        s.hoverFocus !== prev.hoverFocus ||
        s.edges !== prev.edges ||
        s.selectedNode !== prev.selectedNode ||
        s.selectedEdge !== prev.selectedEdge
      ) {
        s.setFlowFocus(nextFlow(s));
      }
    });

    // Whatever is selected when the canvas mounts flows straight away.
    const initial = storeApi.getState();
    initial.setFlowFocus(nextFlow(initial));
    scheduleSettle();

    return () => {
      unsubscribe();
      clearSettle();
      controller.dispose();
      controllerRef.current = null;
      const s = storeApi.getState();
      s.setHoverFocus(null);
      s.setFlowFocus(null);
    };
  }, [storeApi, flowApi]);

  // Pans, wheel zooms and inertia: no new focus while the viewport moves.
  const onViewportStart = useCallback(() => {
    movingRef.current = true;
    controllerRef.current?.cancelPending();
  }, []);
  const onViewportEnd = useCallback(() => {
    movingRef.current = false;
  }, []);
  useOnViewportChange({ onStart: onViewportStart, onEnd: onViewportEnd });

  const onNodeMouseEnter = useCallback<NodeMouseHandler<GraphNode>>((event, node) => {
    if (draggingRef.current || node.type !== 'model') return;
    controllerRef.current?.enter(node.id, event.buttons ?? 0);
  }, []);

  const onNodeMouseLeave = useCallback<NodeMouseHandler<GraphNode>>((_event, node) => {
    if (draggingRef.current || node.type !== 'model') return;
    controllerRef.current?.leave();
  }, []);

  // Following one of the focus's bright lines off the table keeps the focus.
  const onEdgeMouseEnter = useCallback<EdgeMouseHandler<GraphEdge>>((_event, edge) => {
    if (draggingRef.current) return;
    if (storeApi.getState().hoverFocus?.edges.has(edge.id)) controllerRef.current?.hold();
  }, [storeApi]);

  const onEdgeMouseLeave = useCallback<EdgeMouseHandler<GraphEdge>>((_event, edge) => {
    if (draggingRef.current) return;
    if (storeApi.getState().hoverFocus?.edges.has(edge.id)) controllerRef.current?.leave();
  }, [storeApi]);

  // A node drag freezes the focus: no flash, nothing new until it stops. A
  // quick grab of another table (inside the switch delay) moves the preview
  // to the table being dragged first, so it is not the one left faded.
  const onNodeDragStart = useCallback<OnNodeDrag<GraphNode>>((_event, node) => {
    draggingRef.current = true;
    controllerRef.current?.cancelPending();
    const s = storeApi.getState();
    if (s.hoverFocus && node.type === 'model' && s.hoverFocus.node !== node.id && !blocking(s)) {
      s.setHoverFocus(hoverFocusFor(s, node.id));
    }
  }, [storeApi]);

  // The pointer is still on the dropped table, so no mouseenter will come:
  // preview it now (through the usual delay and suppression checks).
  const onNodeDragStop = useCallback<OnNodeDrag<GraphNode>>((_event, node) => {
    draggingRef.current = false;
    if (node.type !== 'model') return;
    if (storeApi.getState().hoverFocus?.node !== node.id) controllerRef.current?.enter(node.id, 0);
  }, [storeApi]);

  const hoverHandlers = useMemo<HoverFocusHandlers>(
    () => ({ onNodeMouseEnter, onNodeMouseLeave, onEdgeMouseEnter, onEdgeMouseLeave, onNodeDragStart, onNodeDragStop }),
    [onNodeMouseEnter, onNodeMouseLeave, onEdgeMouseEnter, onEdgeMouseLeave, onNodeDragStart, onNodeDragStop],
  );

  return {
    hoverHandlers,
    flowClassName: hoverActive ? 'erd-flow erd-flow--hover-focus' : 'erd-flow',
  };
}
