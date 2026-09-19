import type { Edge } from '@xyflow/react';

export const NODE_WIDTH = 280;
export const DEFAULT_NODE_WIDTH = NODE_WIDTH;
export const DEFAULT_NODE_HEIGHT = 200;

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface EdgeOffset {
  x: number;
  y: number;
}

export type NodePositionMap = Map<string, { x: number; y: number }>;

function getConnectedNodePosition(
  edge: Edge,
  nodeId: string,
  nodePositions: NodePositionMap,
): { x: number; y: number } | undefined {
  const otherNodeId = edge.source === nodeId ? edge.target : edge.source;
  return nodePositions.get(otherNodeId);
}

export function getAllEdgesForSide(
  edges: Edge[],
  nodeId: string,
  side: Side,
  nodePositions?: NodePositionMap,
): string[] {
  const sourceHandle = `node-${side}-src`;
  const targetHandle = `node-${side}-tgt`;

  const edgesForSide = edges.filter((edge) => {
    const isSourceOnSide = edge.source === nodeId && edge.sourceHandle === sourceHandle;
    const isTargetOnSide = edge.target === nodeId && edge.targetHandle === targetHandle;
    return isSourceOnSide || isTargetOnSide;
  });

  return edgesForSide
    .sort((a, b) => {
      if (!nodePositions) return a.id.localeCompare(b.id);
      const posA = getConnectedNodePosition(a, nodeId, nodePositions);
      const posB = getConnectedNodePosition(b, nodeId, nodePositions);
      if (!posA || !posB) return a.id.localeCompare(b.id);
      if (side === 'left' || side === 'right') return posA.y - posB.y;
      return posA.x - posB.x;
    })
    .map((edge) => edge.id);
}

export function parseSideFromHandle(handleId: string | null | undefined): Side | undefined {
  if (!handleId) return undefined;
  const match = handleId.match(/^node-(top|right|bottom|left)-(src|tgt)$/);
  return match ? (match[1] as Side) : undefined;
}

export function getSideLength(
  side: Side,
  measured: { width?: number; height?: number } | undefined,
): number {
  const isHorizontalSide = side === 'top' || side === 'bottom';
  if (isHorizontalSide) return measured?.width ?? DEFAULT_NODE_WIDTH;
  return measured?.height ?? DEFAULT_NODE_HEIGHT;
}

export function calculateDistributionOffset(
  edgeIndex: number,
  groupSize: number,
  sideLength: number,
  side: Side,
): EdgeOffset {
  if (groupSize <= 1) return { x: 0, y: 0 };
  const spacing = sideLength / (groupSize + 1);
  const positionFromStart = spacing * (edgeIndex + 1);
  const offset = positionFromStart - sideLength / 2;
  if (side === 'top' || side === 'bottom') return { x: offset, y: 0 };
  return { x: 0, y: offset };
}

export function calculateEdgeOffset(
  edgeId: string,
  nodeId: string,
  side: Side,
  _isSource: boolean,
  allEdges: Edge[],
  sideLength: number,
  nodePositions?: NodePositionMap,
): EdgeOffset {
  const edgesForSide = getAllEdgesForSide(allEdges, nodeId, side, nodePositions);
  const edgeIndex = edgesForSide.indexOf(edgeId);
  if (edgeIndex === -1) return { x: 0, y: 0 };
  return calculateDistributionOffset(edgeIndex, edgesForSide.length, sideLength, side);
}
