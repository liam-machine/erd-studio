/**
 * Edge distribution — calculates evenly-spaced connection points along node sides.
 *
 * When multiple edges connect to the same side of a node, they would normally
 * all connect at the center point, causing visual overlap. This module provides
 * functions to distribute those connection points evenly along the side.
 *
 * The algorithm:
 *   1. Group edges by (nodeId, side) — ALL edges on a side, regardless of
 *      direction (incoming/outgoing). This prevents overlap between source
 *      and target edges that would otherwise be centered independently.
 *   2. For each edge, find its index in the sorted group (consistent ordering)
 *   3. Calculate offset from center: evenly divide the side length
 *   4. Apply offset perpendicular to the edge direction
 */

import type { Edge } from '@xyflow/react';
import { NODE_WIDTH } from './elkLayout';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default node width when measured dimensions not available. */
export const DEFAULT_NODE_WIDTH = NODE_WIDTH;

/** Default node height when measured dimensions not available. */
export const DEFAULT_NODE_HEIGHT = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface EdgeOffset {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Map of node IDs to their positions. */
export type NodePositionMap = Map<string, { x: number; y: number }>;

// ---------------------------------------------------------------------------
// Edge grouping
// ---------------------------------------------------------------------------

/**
 * Get the position of the node at the other end of an edge.
 *
 * @param edge — the edge to analyze
 * @param nodeId — the node we're connecting FROM (to find the OTHER end)
 * @param nodePositions — map of all node positions
 * @returns Position of the connected node, or undefined if not found
 */
function getConnectedNodePosition(
  edge: Edge,
  nodeId: string,
  nodePositions: NodePositionMap,
): { x: number; y: number } | undefined {
  const otherNodeId = edge.source === nodeId ? edge.target : edge.source;
  return nodePositions.get(otherNodeId);
}

/**
 * Get all edge IDs that connect to a specific node side in a specific direction.
 *
 * @param edges — all edges in the graph
 * @param nodeId — the node to check connections for
 * @param side — which side of the node (top/right/bottom/left)
 * @param isSource — true to find edges where this node is the source,
 *                   false for edges where this node is the target
 * @returns Sorted array of edge IDs for consistent ordering
 */
export function getEdgesForSide(
  edges: Edge[],
  nodeId: string,
  side: Side,
  isSource: boolean,
): string[] {
  const handleSuffix = isSource ? 'src' : 'tgt';
  const expectedHandle = `node-${side}-${handleSuffix}`;

  return edges
    .filter((edge) => {
      if (isSource) {
        return edge.source === nodeId && edge.sourceHandle === expectedHandle;
      } else {
        return edge.target === nodeId && edge.targetHandle === expectedHandle;
      }
    })
    .map((edge) => edge.id)
    .sort(); // Sort for consistent ordering across renders
}

/**
 * Get all edge IDs that connect to a specific node side, regardless of direction.
 *
 * This includes both edges where the node is the source (outgoing) AND edges
 * where it's the target (incoming). Used for distribution to prevent overlap
 * between incoming and outgoing edges on the same side.
 *
 * When nodePositions is provided, edges are sorted by the position of their
 * connected node (the node at the OTHER end of the edge):
 *   - For left/right sides: sort by Y position (top to bottom)
 *   - For top/bottom sides: sort by X position (left to right)
 *
 * This sorting minimizes edge crossings by aligning connection points with
 * the visual flow of the connected nodes.
 *
 * @param edges — all edges in the graph
 * @param nodeId — the node to check connections for
 * @param side — which side of the node (top/right/bottom/left)
 * @param nodePositions — optional map of node positions for spatial sorting
 * @returns Sorted array of edge IDs for consistent ordering
 */
export function getAllEdgesForSide(
  edges: Edge[],
  nodeId: string,
  side: Side,
  nodePositions?: NodePositionMap,
): string[] {
  return sortEdgesForSide(getEdgesOnSide(edges, nodeId, side), nodeId, side, nodePositions);
}

// ---------------------------------------------------------------------------
// Per-side edge index (cached per edges array)
// ---------------------------------------------------------------------------

/** Stable empty group so callers can depend on identity. */
const NO_EDGES: readonly Edge[] = Object.freeze([]);

/** `${nodeId}|${side}` → edges touching that node side (either direction). */
type SideIndex = Map<string, Edge[]>;

/**
 * Index cache keyed on the edges array identity. React Flow hands every edge
 * component the same `edges` array until it changes, so the index is built
 * once per graph rebuild (O(E)) instead of each edge filtering the full array
 * on every render (O(E) per edge → O(E²) per pass).
 */
const sideIndexCache = new WeakMap<Edge[], SideIndex>();

function sideKey(nodeId: string, side: Side): string {
  return `${nodeId}|${side}`;
}

function buildSideIndex(edges: Edge[]): SideIndex {
  const index: SideIndex = new Map();
  const push = (key: string, edge: Edge) => {
    const group = index.get(key);
    if (group) group.push(edge);
    else index.set(key, [edge]);
  };
  for (const edge of edges) {
    const sourceSide = parseSideFromHandle(edge.sourceHandle);
    if (sourceSide && edge.sourceHandle === `node-${sourceSide}-src`) {
      push(sideKey(edge.source, sourceSide), edge);
    }
    const targetSide = parseSideFromHandle(edge.targetHandle);
    if (targetSide && edge.targetHandle === `node-${targetSide}-tgt`) {
      push(sideKey(edge.target, targetSide), edge);
    }
  }
  return index;
}

/**
 * All edges that connect to `nodeId` on `side`, in either direction.
 *
 * Returns a cached array (do not mutate) — identity is stable for a given
 * `edges` array, so it is safe to use as a memo dependency.
 */
export function getEdgesOnSide(edges: Edge[], nodeId: string, side: Side): readonly Edge[] {
  let index = sideIndexCache.get(edges);
  if (!index) {
    index = buildSideIndex(edges);
    sideIndexCache.set(edges, index);
  }
  return index.get(sideKey(nodeId, side)) ?? NO_EDGES;
}

/**
 * Sort a side group into its final connection order and return edge IDs.
 *
 * When `nodePositions` is provided, edges are ordered by the position of the
 * node at the OTHER end (Y for left/right sides, X for top/bottom) so
 * connection points follow the visual flow and edges do not cross.
 * Falls back to alphabetical ID order when positions are unavailable.
 */
export function sortEdgesForSide(
  edgesForSide: readonly Edge[],
  nodeId: string,
  side: Side,
  nodePositions?: NodePositionMap,
): string[] {
  // Sort by position of the connected node (other end of the edge)
  // - For left/right sides: sort by Y position (top to bottom)
  // - For top/bottom sides: sort by X position (left to right)
  return [...edgesForSide]
    .sort((a, b) => {
      // If no positions provided, fall back to alphabetical sort
      if (!nodePositions) {
        return a.id.localeCompare(b.id);
      }

      const posA = getConnectedNodePosition(a, nodeId, nodePositions);
      const posB = getConnectedNodePosition(b, nodeId, nodePositions);

      // Fallback to alphabetical if positions not available
      if (!posA || !posB) {
        return a.id.localeCompare(b.id);
      }

      // Choose axis based on side
      if (side === 'left' || side === 'right') {
        return posA.y - posB.y; // Sort by Y (vertical)
      } else {
        return posA.x - posB.x; // Sort by X (horizontal)
      }
    })
    .map((edge) => edge.id);
}

/**
 * Parse the side from a handle ID.
 *
 * Handle IDs follow the format "node-{side}-{src|tgt}".
 * Returns undefined if the handle ID doesn't match the expected format.
 */
export function parseSideFromHandle(handleId: string | null | undefined): Side | undefined {
  if (!handleId) return undefined;
  const match = handleId.match(/^node-(top|right|bottom|left)-(src|tgt)$/);
  return match ? (match[1] as Side) : undefined;
}

// ---------------------------------------------------------------------------
// Node dimensions
// ---------------------------------------------------------------------------

/** Node dimensions from React Flow's internal node measurement. */
interface MeasuredDimensions {
  width?: number;
  height?: number;
}

/**
 * Get the length of a node side in pixels.
 *
 * For horizontal sides (top/bottom), returns the node width.
 * For vertical sides (left/right), returns the node height.
 * Falls back to default dimensions if the node hasn't been measured yet.
 *
 * @param side — which side of the node
 * @param measured — the node's measured dimensions (may be undefined)
 * @returns Side length in pixels
 */
export function getSideLength(
  side: Side,
  measured: MeasuredDimensions | undefined,
): number {
  const isHorizontalSide = side === 'top' || side === 'bottom';
  if (isHorizontalSide) {
    return measured?.width ?? DEFAULT_NODE_WIDTH;
  } else {
    return measured?.height ?? DEFAULT_NODE_HEIGHT;
  }
}

// ---------------------------------------------------------------------------
// Offset calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the offset for a connection point along a node side.
 *
 * Distributes connection points evenly along the side. For example, with
 * 3 edges connecting to a 280px wide side:
 *   - spacing = 280 / 4 = 70px
 *   - positions: 70px, 140px, 210px (from left edge)
 *   - offsets from center (140px): -70px, 0px, +70px
 *
 * @param edgeIndex — this edge's position in the group (0-based)
 * @param groupSize — total number of edges connecting to this side
 * @param sideLength — width or height of the side in pixels
 * @param side — which side (determines offset axis)
 * @returns Offset in pixels from the center of the side
 */
export function calculateDistributionOffset(
  edgeIndex: number,
  groupSize: number,
  sideLength: number,
  side: Side,
): EdgeOffset {
  // Single edge stays centered
  if (groupSize <= 1) {
    return { x: 0, y: 0 };
  }

  // Distribute evenly: divide side into (groupSize + 1) segments
  const spacing = sideLength / (groupSize + 1);

  // Calculate position from the start of the side
  const positionFromStart = spacing * (edgeIndex + 1);

  // Convert to offset from center
  const offset = positionFromStart - sideLength / 2;

  // Apply offset perpendicular to edge direction
  // - Horizontal sides (top/bottom): edges go vertically, distribute along X
  // - Vertical sides (left/right): edges go horizontally, distribute along Y
  if (side === 'top' || side === 'bottom') {
    return { x: offset, y: 0 };
  } else {
    return { x: 0, y: offset };
  }
}

/**
 * Calculate the full offset for an edge's connection point.
 *
 * This is the main entry point — combines grouping and offset calculation.
 * Groups ALL edges on a side together (both incoming and outgoing) to prevent
 * overlap between source and target edges.
 *
 * When nodePositions is provided, edges are sorted by their connected node's
 * position to minimize visual crossings.
 *
 * @param edgeId — the edge to calculate offset for
 * @param nodeId — the node this edge connects to
 * @param side — which side of the node
 * @param isSource — true if calculating source offset, false for target (kept for API compatibility)
 * @param allEdges — all edges in the graph
 * @param sideLength — width (for top/bottom) or height (for left/right) of the node
 * @param nodePositions — optional map of node positions for spatial sorting
 * @returns Offset in pixels from the center of the side
 */
export function calculateEdgeOffset(
  edgeId: string,
  nodeId: string,
  side: Side,
  _isSource: boolean,
  allEdges: Edge[],
  sideLength: number,
  nodePositions?: NodePositionMap,
): EdgeOffset {
  // Get ALL edges connecting to this node side (both directions)
  // This ensures incoming and outgoing edges don't overlap at the same point
  return calculateEdgeOffsetInGroup(
    edgeId,
    nodeId,
    side,
    getEdgesOnSide(allEdges, nodeId, side),
    sideLength,
    nodePositions,
  );
}

/**
 * Same as `calculateEdgeOffset` but for a pre-grouped side (see
 * `getEdgesOnSide`), avoiding a scan of the full edge array per call.
 */
export function calculateEdgeOffsetInGroup(
  edgeId: string,
  nodeId: string,
  side: Side,
  edgesOnSide: readonly Edge[],
  sideLength: number,
  nodePositions?: NodePositionMap,
): EdgeOffset {
  const ordered = sortEdgesForSide(edgesOnSide, nodeId, side, nodePositions);

  // Find this edge's index in the group
  const edgeIndex = ordered.indexOf(edgeId);
  if (edgeIndex === -1) {
    // Edge not found in group — shouldn't happen, but fallback to no offset
    return { x: 0, y: 0 };
  }

  return calculateDistributionOffset(edgeIndex, ordered.length, sideLength, side);
}

/**
 * Build a compact, value-comparable key of the given nodes' positions.
 *
 * React Flow mutates its `nodeLookup` Map in place (`adoptUserNodes` clears
 * and refills it), so the Map identity never changes and cannot be used as a
 * memo dependency. Subscribing to this string instead re-renders exactly when
 * one of the listed nodes moves.
 */
export function buildPositionsKey(
  nodeLookup: ReadonlyMap<string, { position?: { x: number; y: number }; internals?: { positionAbsolute?: { x: number; y: number } } }>,
  nodeIds: readonly string[],
): string {
  let key = '';
  for (const id of nodeIds) {
    const node = nodeLookup.get(id);
    const pos = node?.internals?.positionAbsolute ?? node?.position;
    key += pos ? `${Math.round(pos.x)},${Math.round(pos.y)};` : ';';
  }
  return key;
}
