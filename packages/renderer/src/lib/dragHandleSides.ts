/**
 * Handle sides for edges after nodes are moved on the canvas.
 *
 * `transformDomain` chooses the handle side at each end of an edge from the
 * saved positions: `pickHandleSides` compares the two node rectangles, and a
 * self-referencing relationship always uses the top (source) and right
 * (target) handles. A canvas that lets nodes be dragged without rebuilding the
 * domain has to make that choice again for the edges on the dragged nodes, or
 * those edges stay attached to the side that faced the old position.
 *
 * The rectangles follow `transformDomain` too: a node's size is its measured
 * size when React Flow has one, otherwise the model-node estimate from
 * `resolveNodeDimensions`, or an annotation's own (or default) size.
 */

import { pickHandleSides, type NodeDimensions, type NodeRect } from './graphTransformer';
import { resolveNodeDimensions } from './nodeSizing';
import type { GraphNode, GraphEdge } from './nodeOverlays';

/** Upstream's default note size in `transformDomain` (the annotation CSS minimum). */
const DEFAULT_ANNOTATION_WIDTH = 160;
const DEFAULT_ANNOTATION_HEIGHT = 80;

/** Handles `transformDomain` gives a relationship from a model to itself. */
const SELF_REFERENCE_HANDLES = { sourceHandle: 'node-top-src', targetHandle: 'node-right-tgt' } as const;

interface EdgeHandles {
  sourceHandle: string;
  targetHandle: string;
}

function sizeOf(node: GraphNode): NodeDimensions {
  const measured = node.measured;
  if (measured?.width != null && measured.height != null) {
    return { width: measured.width, height: measured.height };
  }
  if (node.type === 'annotation') {
    return {
      width: node.data.width ?? DEFAULT_ANNOTATION_WIDTH,
      height: node.data.height ?? DEFAULT_ANNOTATION_HEIGHT,
    };
  }
  return resolveNodeDimensions({ data: node.data, measured: undefined });
}

/** The rectangle `pickHandleSides` compares for `node`: its position and size. */
export function nodeRect(node: GraphNode): NodeRect {
  return { x: node.position.x, y: node.position.y, ...sizeOf(node) };
}

/** The handles an edge between `source` and `target` should use, as `transformDomain` picks them. */
function handlesBetween(source: GraphNode, target: GraphNode): EdgeHandles {
  if (source.id === target.id) return SELF_REFERENCE_HANDLES;
  const sides = pickHandleSides(nodeRect(source), nodeRect(target));
  return {
    sourceHandle: `node-${sides.sourceSide}-src`,
    targetHandle: `node-${sides.targetSide}-tgt`,
  };
}

/**
 * Recompute the handles of the edges attached to any node in `movedIds`.
 *
 * Only edges whose handles actually change are replaced; every other entry is
 * the original edge. If none change, `edges` is returned as is, which lets a
 * caller compare by reference and skip a store update. Edges with an endpoint
 * missing from `nodes` are left as they are.
 */
export function repickHandleSides(
  nodes: ReadonlyArray<GraphNode>,
  edges: GraphEdge[],
  movedIds: ReadonlySet<string>,
): GraphEdge[] {
  const attached: number[] = [];
  edges.forEach((edge, index) => {
    if (movedIds.has(edge.source) || movedIds.has(edge.target)) attached.push(index);
  });
  if (attached.length === 0) return edges;

  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  let result: GraphEdge[] | undefined;
  for (const index of attached) {
    const edge = edges[index];
    const sourceNode = byId.get(edge.source);
    const targetNode = byId.get(edge.target);
    if (sourceNode === undefined || targetNode === undefined) continue;

    const wanted = handlesBetween(sourceNode, targetNode);
    const same = wanted.sourceHandle === edge.sourceHandle && wanted.targetHandle === edge.targetHandle;
    if (same) continue;

    result ??= [...edges];
    result[index] = { ...edge, ...wanted };
  }
  return result ?? edges;
}
