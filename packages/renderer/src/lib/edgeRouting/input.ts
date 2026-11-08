/**
 * Edge routing — build the routing input from React Flow state.
 *
 * Mirrors what `FkEdge` does today: a line meets the side its handle names
 * (`node-{side}-{src|tgt}`, picked by the graph transformer), at the centre
 * of that side plus the evenly distributed slot from `edgeDistribution`.
 * Kept pure (no React) so routers and tests can call it.
 */

import type { Edge, InternalNode, Node } from '@xyflow/react';
import {
  calculateEdgeOffsetInGroup,
  getEdgesOnSide,
  getSideLength,
  parseSideFromHandle,
  DEFAULT_NODE_HEIGHT,
  DEFAULT_NODE_WIDTH,
  type NodePositionMap,
} from '../edgeDistribution';
import type { Anchor, EdgeSpec, Rect, RoutingInput, Side, Point } from './types';

/** The box of a node in flow coordinates. */
export function rectOfNode(node: InternalNode<Node>): Rect {
  const pos = node.internals?.positionAbsolute ?? node.position;
  return {
    id: node.id,
    x: pos.x,
    y: pos.y,
    width: node.measured?.width ?? node.width ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? node.height ?? DEFAULT_NODE_HEIGHT,
    kind: node.type === 'annotation' ? 'annotation' : 'model',
  };
}

/** Centre of a rect's side. */
export function sideCentre(rect: Rect, side: Side): Point {
  switch (side) {
    case 'top':
      return { x: rect.x + rect.width / 2, y: rect.y };
    case 'bottom':
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height };
    case 'left':
      return { x: rect.x, y: rect.y + rect.height / 2 };
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }
}

/** A point pushed `distance` px outward from a side. */
export function pushOut(p: Point, side: Side, distance: number): Point {
  switch (side) {
    case 'top':
      return { x: p.x, y: p.y - distance };
    case 'bottom':
      return { x: p.x, y: p.y + distance };
    case 'left':
      return { x: p.x - distance, y: p.y };
    case 'right':
      return { x: p.x + distance, y: p.y };
  }
}

/**
 * Every FK line's spec plus every node box, from React Flow's node lookup and
 * edge list. Edges whose nodes are not measured yet are skipped (they keep the
 * fallback path until the next pass).
 */
export function buildRoutingInput(
  nodeLookup: Map<string, InternalNode<Node>>,
  edges: Edge[],
): RoutingInput {
  const obstacles: Rect[] = [];
  const rects = new Map<string, Rect>();
  const positions: NodePositionMap = new Map();
  for (const node of nodeLookup.values()) {
    if (node.hidden) continue;
    const rect = rectOfNode(node);
    rects.set(node.id, rect);
    obstacles.push(rect);
    positions.set(node.id, { x: rect.x, y: rect.y });
  }

  const specs: EdgeSpec[] = [];
  for (const edge of edges) {
    if (edge.type !== 'fk' || edge.hidden) continue;
    const src = rects.get(edge.source);
    const tgt = rects.get(edge.target);
    if (!src || !tgt) continue;
    const sourceSide = parseSideFromHandle(edge.sourceHandle) ?? 'right';
    const targetSide = parseSideFromHandle(edge.targetHandle) ?? 'left';
    const anchorOf = (rect: Rect, nodeId: string, side: Side): Anchor => {
      const centre = sideCentre(rect, side);
      const group = getEdgesOnSide(edges, nodeId, side);
      const length = getSideLength(side, { width: rect.width, height: rect.height });
      const offset = calculateEdgeOffsetInGroup(edge.id, nodeId, side, group, length, positions);
      return { x: centre.x + offset.x, y: centre.y + offset.y, side };
    };
    const data = (edge.data ?? {}) as { isSelfLoop?: boolean; loopIndex?: number; cardinality?: string };
    specs.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceAnchor: anchorOf(src, edge.source, sourceSide),
      targetAnchor: anchorOf(tgt, edge.target, targetSide),
      isSelfLoop: data.isSelfLoop === true || edge.source === edge.target,
      loopIndex: data.loopIndex ?? 0,
      cardinality: data.cardinality ?? 'many-to-one',
    });
  }
  return { obstacles, edges: specs };
}

/**
 * A value key that changes exactly when routing input changes: node boxes and
 * edge endpoints/handles. Subscribe to this rather than the lookup Map, which
 * React Flow mutates in place.
 */
export function routingInputKey(nodeLookup: Map<string, InternalNode<Node>>, edges: Edge[]): string {
  const parts: string[] = [];
  for (const node of nodeLookup.values()) {
    if (node.hidden) continue;
    const pos = node.internals?.positionAbsolute ?? node.position;
    parts.push(`${node.id}:${Math.round(pos.x)},${Math.round(pos.y)},${node.measured?.width ?? 0},${node.measured?.height ?? 0}`);
  }
  for (const e of edges) {
    if (e.type !== 'fk' || e.hidden) continue;
    parts.push(`${e.id}:${e.sourceHandle}>${e.targetHandle}`);
  }
  return parts.join('|');
}

/**
 * The ids of the cards being dragged, joined (empty when no drag is in
 * progress): the performance guard holds the routes while it is non-empty.
 */
export function draggingNodesKey(nodeLookup: Map<string, InternalNode<Node>>): string {
  let key = '';
  for (const node of nodeLookup.values()) {
    if (node.dragging && !node.hidden) key += key ? `\u0000${node.id}` : node.id;
  }
  return key;
}

export { DEFAULT_NODE_WIDTH, DEFAULT_NODE_HEIGHT };
