/**
 * Node/edge overlays — ephemeral per-node presentation state layered on top
 * of the graph produced by `transformSubjectArea`:
 *
 *   - `dimmed`: search-miss or not-connected-to-selection dimming (F402)
 *   - `isExpanded` / `onToggleExpansion`: column expansion (F405)
 *
 * `applyNodeOverlays` is a pure function that preserves object identity for
 * every node/edge whose overlay values did not change, so React Flow's
 * `adoptUserNodes` short-circuits on unchanged nodes and memoised
 * `TableNode` / `FkEdge` components skip re-rendering. When nothing changed
 * at all, the *same arrays* are returned so callers can skip `setNodes`.
 *
 * This lets selection / search / expansion changes avoid re-running the full
 * domain transform (which would also drop `measured` and force React Flow to
 * re-measure every node).
 *
 * What counts as "connected" is `computeCanvasFocus` (`canvasFocus.ts`), the
 * same rule the hover preview uses. Hover itself never comes through here:
 * every `setEdges` re-renders every `FkEdge`, which is fine once per click but
 * not on every pointer move, so hover dims with a root CSS class instead
 * (`useHoverFocus`).
 */

import type {
  TableFlowNode,
  FkFlowEdge,
  AnnotationFlowNode,
  AnnotationFlowEdge,
} from '../types/graph';
import { matchesTableSearch } from './modelLabels';
import { computeCanvasFocus } from './canvasFocus';

export type GraphNode = TableFlowNode | AnnotationFlowNode;
export type GraphEdge = FkFlowEdge | AnnotationFlowEdge;

export interface OverlayState {
  /** Currently selected model (drives connected-node dimming). */
  selectedNode: string | null;
  /** Currently selected FK edge id (drives endpoint dimming). */
  selectedEdge: string | null;
  /** Raw search query; blank means no search dimming. */
  searchQuery: string;
  /** Column expansion lookup per model. */
  isExpanded: (modelName: string) => boolean;
  /** Stable toggle callback injected into node data. */
  toggleExpansion: (modelName: string) => void;
}

/**
 * Apply dimming + expansion overlays to nodes and edges.
 *
 * Returns the input arrays untouched (same reference) when no element changed.
 */
export function applyNodeOverlays(
  nodes: GraphNode[],
  edges: GraphEdge[],
  state: OverlayState,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { selectedNode, selectedEdge, searchQuery, isExpanded, toggleExpansion } = state;
  const hasSelection = selectedNode !== null || selectedEdge !== null;
  // The shared connectivity rule (`computeCanvasFocus`): a selected node and
  // its FK neighbours, or a selected edge's two endpoints. An unknown edge
  // leaves nothing bright, as before.
  const connected: ReadonlySet<string> = hasSelection
    ? computeCanvasFocus(edges, { node: selectedNode, edge: selectedEdge })?.nodes ?? new Set<string>()
    : new Set<string>();
  const query = searchQuery.trim() ? searchQuery.toLowerCase() : '';

  let nodesChanged = false;
  const nextNodes = nodes.map((node) => {
    if (node.type === 'annotation') {
      // Annotations: not search-dimmable, not selection-dimmable
      return node;
    }
    const data = node.data as TableFlowNode['data'];
    const searchDimmed = query ? !matchesTableSearch(data, query) : false;
    const selectionDimmed = hasSelection && !connected.has(node.id);
    const dimmed = searchDimmed || selectionDimmed;
    const expanded = isExpanded(node.id);

    if (
      (data.dimmed ?? false) === dimmed &&
      (data.isExpanded ?? false) === expanded &&
      data.onToggleExpansion === toggleExpansion
    ) {
      return node;
    }
    nodesChanged = true;
    return {
      ...node,
      data: {
        ...data,
        dimmed,
        isExpanded: expanded,
        onToggleExpansion: toggleExpansion,
      },
    } as TableFlowNode;
  });

  let edgesChanged = false;
  const nextEdges = edges.map((edge) => {
    if (edge.type !== 'fk' || !edge.data) return edge;
    const fk = edge.data as FkFlowEdge['data'];
    if (!fk) return edge;
    // Node selection: bright only if both endpoints are connected.
    // Edge selection: only the selected edge stays bright.
    const dimmed = hasSelection && (selectedEdge
      ? edge.id !== selectedEdge
      : !connected.has(fk.fromModel) || !connected.has(fk.toModel));
    if ((fk.dimmed ?? false) === dimmed) {
      return edge;
    }
    edgesChanged = true;
    return { ...edge, data: { ...fk, dimmed } } as FkFlowEdge;
  });

  return {
    nodes: nodesChanged ? nextNodes : nodes,
    edges: edgesChanged ? nextEdges : edges,
  };
}
