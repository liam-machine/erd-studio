/**
 * Edge handle sides for nodes moved on the canvas.
 *
 * `transformDomain` picks the side of each node an edge attaches to from the
 * node positions in the domain. When nodes are dragged without the domain
 * being rebuilt (the read-only viewer, where moves are never saved), the edges
 * touching the moved nodes need the same choice made again from the nodes'
 * new positions — otherwise an edge keeps leaving from the side that faced its
 * partner before the move.
 *
 * The rectangles are the ones `transformDomain` uses: the node's position plus
 * its measured size, falling back to the model-node estimate or the default
 * annotation size. So a moved node gets exactly the sides the extension would
 * show after the move was saved and the domain reloaded.
 */

import { pickHandleSides, type NodeRect } from './graphTransformer';
import { resolveNodeDimensions } from './nodeSizing';
import type { GraphNode, GraphEdge } from './nodeOverlays';

/** Size of an annotation that has never been resized (its CSS min size). */
const ANNOTATION_DEFAULT_SIZE = { width: 160, height: 80 };

/** A node's top-left position and its size, as used to choose edge sides. */
export function nodeRect(node: GraphNode): NodeRect {
  const { x, y } = node.position;
  const measuredWidth = node.measured?.width;
  const measuredHeight = node.measured?.height;
  if (measuredWidth != null && measuredHeight != null) {
    return { x, y, width: measuredWidth, height: measuredHeight };
  }
  if (node.type === 'annotation') {
    return {
      x,
      y,
      width: node.data.width ?? ANNOTATION_DEFAULT_SIZE.width,
      height: node.data.height ?? ANNOTATION_DEFAULT_SIZE.height,
    };
  }
  const { width, height } = resolveNodeDimensions({ data: node.data, measured: undefined });
  return { x, y, width, height };
}

/**
 * Re-pick the handle sides of every edge with an end on one of `movedIds`.
 *
 * Self-referencing edges keep their fixed top/right handles. Edges whose
 * sides do not change keep their object identity, and when no edge changes
 * the input array itself is returned, so callers can skip a store update.
 */
export function repickHandleSides(
  nodes: readonly GraphNode[],
  edges: GraphEdge[],
  movedIds: ReadonlySet<string>,
): GraphEdge[] {
  if (movedIds.size === 0) return edges;

  const nodesById = new Map<string, GraphNode>();
  for (const node of nodes) nodesById.set(node.id, node);

  let changed = false;
  const next = edges.map((edge) => {
    if (!movedIds.has(edge.source) && !movedIds.has(edge.target)) return edge;
    if (edge.source === edge.target) return edge;

    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) return edge;

    const { sourceSide, targetSide } = pickHandleSides(nodeRect(source), nodeRect(target));
    const sourceHandle = `node-${sourceSide}-src`;
    const targetHandle = `node-${targetSide}-tgt`;
    if (edge.sourceHandle === sourceHandle && edge.targetHandle === targetHandle) return edge;

    changed = true;
    return { ...edge, sourceHandle, targetHandle };
  });

  return changed ? next : edges;
}
