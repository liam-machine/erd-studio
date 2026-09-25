/**
 * useCanvasGraph — keeps the React Flow nodes and edges in the canvas store in
 * step with the domain, and provides the canvas's click/selection handlers.
 *
 *   - The transform effect rebuilds every node and edge when the domain (or
 *     the discrepancy overlay) changes, preserving measured sizes, the
 *     current selection and valid edge selections.
 *   - The overlay effect updates only the `dimmed` / `isExpanded` flags when
 *     selection, search or column expansion changes.
 *   - The handlers open the detail panel on a model click, select annotations,
 *     highlight an FK edge's columns and clear selection on a pane click.
 *
 * Must run inside a `CanvasStoreProvider`.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { OnSelectionChangeFunc } from '@xyflow/react';
import type { DiscrepancyReport } from '@erd-studio/core';
import { useEditorStore, useEditorStoreApi } from '../store/editorStore';
import { useColumnExpansion } from '../hooks/useColumnExpansion';
import { transformDomain } from '../lib/graphTransformer';
import { applyNodeOverlays } from '../lib/nodeOverlays';
import type { ModelFlowNode, FkFlowEdge, AnnotationFlowNode, AnnotationFlowEdge } from '../types/graph';

export interface UseCanvasGraphOptions {
  /** Whether the cross-stage discrepancy overlay is shown. */
  discrepancyVisible?: boolean;
  /** The discrepancy report to overlay when `discrepancyVisible` is set. */
  discrepancyReport?: DiscrepancyReport | null;
  /**
   * Called with the rebuilt nodes and edges each time the transform effect
   * runs, just before they are written to the store.
   */
  onTransformed?: (
    nodes: (ModelFlowNode | AnnotationFlowNode)[],
    edges: (FkFlowEdge | AnnotationFlowEdge)[],
  ) => void;
}

export interface UseCanvasGraphResult {
  nodes: (ModelFlowNode | AnnotationFlowNode)[];
  edges: (FkFlowEdge | AnnotationFlowEdge)[];
  onNodeClick: (event: React.MouseEvent, node: ModelFlowNode | AnnotationFlowNode) => void;
  onEdgeClick: (event: React.MouseEvent, edge: FkFlowEdge | AnnotationFlowEdge) => void;
  onPaneClick: () => void;
  onSelectionChange: OnSelectionChangeFunc;
}

export function useCanvasGraph({
  discrepancyVisible = false,
  discrepancyReport = null,
  onTransformed,
}: UseCanvasGraphOptions = {}): UseCanvasGraphResult {
  const storeApi = useEditorStoreApi();
  const domain = useEditorStore((s) => s.domain);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setNodes = useEditorStore((s) => s.setNodes);
  const setEdges = useEditorStore((s) => s.setEdges);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const setSelectedEdges = useEditorStore((s) => s.setSelectedEdges);
  const setHighlightedColumns = useEditorStore((s) => s.setHighlightedColumns);
  const selectedEdge = useEditorStore((s) => s.selectedEdge);
  const setSelectedEdge = useEditorStore((s) => s.setSelectedEdge);
  const selectAnnotation = useEditorStore((s) => s.selectAnnotation);
  const searchQuery = useEditorStore((s) => s.searchQuery);

  const { isExpanded, toggleExpansion } = useColumnExpansion();

  // Latest callback without re-running the transform when it changes.
  const onTransformedRef = useRef(onTransformed);
  onTransformedRef.current = onTransformed;

  // Get current selectedNode from store to preserve selection across domain updates
  const currentSelectedNode = useEditorStore((s) => s.selectedNode);

  // Initialize nodes and edges when the domain (or discrepancy overlay) changes.
  // Preserve visual selection if the selected node still exists.
  // Clear stale edge selections that no longer exist.
  //
  // Selection / search / expansion are NOT dependencies here — they are
  // applied by the lightweight overlay effect below. Re-running the full
  // transform on every click used to rebuild every node/edge object (defeating
  // memo) and drop `measured`, forcing React Flow to re-measure all nodes.
  useEffect(() => {
    if (domain) {
      const state = storeApi.getState();
      const prevById = new Map(state.nodes.map((n) => [n.id, n]));

      // Measured sizes from the current React Flow state — used both for
      // centre-based handle side selection and to carry `measured` across
      // the rebuild so React Flow does not re-measure unchanged nodes.
      const nodeDimensions = new Map<string, { width: number; height: number }>();
      for (const n of state.nodes) {
        if (n.measured?.width != null && n.measured?.height != null) {
          nodeDimensions.set(n.id, { width: n.measured.width, height: n.measured.height });
        }
      }
      const isExpandedNow = (id: string) => state.allExpanded || state.expandedNodes.has(id);

      const transformOptions = {
        ...(discrepancyVisible && discrepancyReport ? { discrepancyReport } : {}),
        nodeDimensions,
        isExpanded: isExpandedNow,
      };
      let { nodes: newNodes, edges: newEdges } = transformDomain(domain, transformOptions);

      // Carry measured dimensions over from the previous nodes.
      newNodes = newNodes.map((n) => {
        const prev = prevById.get(n.id);
        return prev?.measured?.width != null && prev.measured.height != null
          ? { ...n, measured: prev.measured }
          : n;
      });

      // F402 search dimming, selection dimming, F405 column expansion.
      ({ nodes: newNodes, edges: newEdges } = applyNodeOverlays(newNodes, newEdges, {
        selectedNode: state.selectedNode,
        selectedEdge: state.selectedEdge,
        searchQuery: state.searchQuery,
        isExpanded: isExpandedNow,
        toggleExpansion,
      }));

      // Preserve React Flow's current selection across this rebuild.
      // Without this, any store change that re-triggers this effect wipes the
      // multi-selection React Flow just applied via applyNodeChanges. Read store
      // state directly to avoid adding `nodes` to the dep array (which would
      // cause an infinite loop since we call setNodes below).
      const preserveSelected = new Set<string>();
      if (state.selectedNode) preserveSelected.add(state.selectedNode);
      for (const n of state.nodes) {
        if (n.selected) preserveSelected.add(n.id);
      }
      if (preserveSelected.size > 0) {
        newNodes = newNodes.map((n) => preserveSelected.has(n.id) ? { ...n, selected: true } : n);
      }

      // Clear stale edge selections (edges that no longer exist after domain update)
      const newEdgeIds = new Set(newEdges.map((e) => e.id));
      const currentSelectedEdges = state.selectedEdges;
      if (currentSelectedEdges.length > 0) {
        const validEdges = currentSelectedEdges.filter((id) => newEdgeIds.has(id));
        if (validEdges.length !== currentSelectedEdges.length) {
          setSelectedEdges(validEdges);
        }
      }
      if (state.selectedEdge && !newEdgeIds.has(state.selectedEdge)) {
        setSelectedEdge(null);
      }

      onTransformedRef.current?.(newNodes, newEdges);
      setNodes(newNodes);
      setEdges(newEdges);
    }
    // storeApi is stable for the lifetime of the provider (upstream read the
    // module singleton here), so it is left out like upstream's dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, setNodes, setEdges, setSelectedEdges, setSelectedEdge, toggleExpansion, discrepancyVisible, discrepancyReport]);

  // Lightweight overlay pass: update only the `dimmed` / `isExpanded` flags on
  // the nodes and edges already in the store when selection, search or column
  // expansion changes. Unchanged nodes keep their object identity so memoised
  // components skip re-rendering and React Flow keeps its measurements.
  useEffect(() => {
    const { nodes: currentNodes, edges: currentEdges } = storeApi.getState();
    if (currentNodes.length === 0) return;
    const result = applyNodeOverlays(currentNodes, currentEdges, {
      selectedNode: currentSelectedNode,
      selectedEdge,
      searchQuery,
      isExpanded,
      toggleExpansion,
    });
    if (result.nodes !== currentNodes) setNodes(result.nodes);
    if (result.edges !== currentEdges) setEdges(result.edges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSelectedNode, selectedEdge, searchQuery, isExpanded, toggleExpansion, setNodes, setEdges]);

  // Handle node clicks to open the detail panel (model nodes) or select (annotations).
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: ModelFlowNode | AnnotationFlowNode) => {
      if (node.type === 'annotation') {
        const annData = (node as AnnotationFlowNode).data;
        selectAnnotation(annData.annotationId);
        return;
      }
      selectNode(node.id);
      setDetailPanelOpen(true);
      setHighlightedColumns(new Set());
      setSelectedEdge(null);
    },
    [selectNode, selectAnnotation, setDetailPanelOpen, setHighlightedColumns, setSelectedEdge],
  );

  // Handle edge clicks to highlight the FK columns involved and dim unrelated nodes/edges.
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: FkFlowEdge | AnnotationFlowEdge) => {
      if (edge.type !== 'fk') return; // Annotation link edges are not interactive
      if (edge.data) {
        const cols = new Set<string>();
        cols.add(`${edge.data.fromModel}:${edge.data.fromColumn}`);
        cols.add(`${edge.data.toModel}:${edge.data.toColumn}`);
        setHighlightedColumns(cols);
        // Clear node selection and activate edge dimming
        selectNode(null);
        setDetailPanelOpen(false);
        setSelectedEdge(edge.id);
      }
    },
    [setHighlightedColumns, selectNode, setDetailPanelOpen, setSelectedEdge],
  );

  // Handle clicks on blank canvas to close the detail panel and clear selection.
  const onPaneClick = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
    selectAnnotation(null);
    setHighlightedColumns(new Set());
    setSelectedEdge(null);
  }, [setDetailPanelOpen, selectNode, selectAnnotation, setHighlightedColumns, setSelectedEdge]);

  // Close detail panel when multi-selecting (selection mismatch with single-node panel).
  // But don't close if the selection reset was caused by a domain update (nodes recreated).
  // Also track edge selection for keyboard shortcuts.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdgesInFlow }) => {
      // Track edge selection in store for keyboard shortcuts
      setSelectedEdges(selectedEdgesInFlow.map((e) => e.id));

      if (selectedNodes.length !== 1) {
        // Don't interfere if an edge dimming selection is active (onEdgeClick handles state)
        if (selectedEdge !== null) return;

        // Check if our stored selection still exists in the domain
        // If so, this is likely a domain update, not a user deselection
        if (currentSelectedNode && domain?.models.some((m) => m.name === currentSelectedNode)) {
          // Keep the panel open - the node still exists, selection was just reset by React Flow
          return;
        }
        setDetailPanelOpen(false);
        selectNode(null);
      }
    },
    [selectNode, setDetailPanelOpen, setSelectedEdges, currentSelectedNode, selectedEdge, domain],
  );

  return { nodes, edges, onNodeClick, onEdgeClick, onPaneClick, onSelectionChange };
}
