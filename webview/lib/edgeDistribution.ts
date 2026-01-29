/**
 * Edge distribution — calculates evenly-spaced connection points along node sides.
 *
 * When multiple edges connect to the same side of a node, they would normally
 * all connect at the center point, causing visual overlap. This module provides
 * functions to distribute those connection points evenly along the side.
 *
 * The algorithm:
 *   1. Group edges by (nodeId, side, direction) — e.g., all source edges from
 *      "orders" node on the "right" side
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
// Edge grouping
// ---------------------------------------------------------------------------

/**
 * Get all edge IDs that connect to a specific node side.
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
 *
 * @param edgeId — the edge to calculate offset for
 * @param nodeId — the node this edge connects to
 * @param side — which side of the node
 * @param isSource — true if calculating source offset, false for target
 * @param allEdges — all edges in the graph
 * @param sideLength — width (for top/bottom) or height (for left/right) of the node
 * @returns Offset in pixels from the center of the side
 */
export function calculateEdgeOffset(
  edgeId: string,
  nodeId: string,
  side: Side,
  isSource: boolean,
  allEdges: Edge[],
  sideLength: number,
): EdgeOffset {
  // Get all edges connecting to this node side
  const edgesForSide = getEdgesForSide(allEdges, nodeId, side, isSource);

  // Find this edge's index in the group
  const edgeIndex = edgesForSide.indexOf(edgeId);
  if (edgeIndex === -1) {
    // Edge not found in group — shouldn't happen, but fallback to no offset
    return { x: 0, y: 0 };
  }

  return calculateDistributionOffset(edgeIndex, edgesForSide.length, sideLength, side);
}
