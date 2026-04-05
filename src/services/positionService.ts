/**
 * PositionService — pure-function service for computing positions of new models.
 *
 * When AI agents or the "New Model" dialog add models without positions,
 * this service determines where to place them on the canvas:
 *   1. Models with related positioned models → placed near centroid of neighbours
 *   2. Orphan models → grid-scanned into the first open cell
 */

import type { NodePosition, Relationship } from '../types/semantic';

// ---------------------------------------------------------------------------
// Constants (match existing layout dimensions)
// ---------------------------------------------------------------------------

export const NODE_WIDTH = 280;
export const NODE_HEIGHT = 200;
export const PADDING = 40;
const CELL_WIDTH = NODE_WIDTH + PADDING;
const CELL_HEIGHT = NODE_HEIGHT + PADDING;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PositionContext {
  /** Model names that need positions. */
  newModels: string[];
  /** All relationships in the domain (used to find neighbours). */
  relationships: Relationship[];
  /** Existing positions (keyed by model name). These are never modified. */
  existingPositions: Record<string, NodePosition>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute positions for a set of new models.
 *
 * Returns a map of model name → position for ONLY the new models.
 * Existing positions are never included or modified in the output.
 */
export function computeNewModelPositions(
  ctx: PositionContext,
): Record<string, NodePosition> {
  if (ctx.newModels.length === 0) return {};

  // Mutable working copy: existing + already-placed new models
  const allPositions: Record<string, NodePosition> = { ...ctx.existingPositions };
  const result: Record<string, NodePosition> = {};

  // Build adjacency from relationships
  const neighbours = buildNeighbourMap(ctx.newModels, ctx.relationships);

  // Sort: models with positioned neighbours first (dependency order)
  const ordered = sortByConnectedness(ctx.newModels, neighbours, allPositions);

  for (const modelName of ordered) {
    const relatedPositioned = getPositionedNeighbours(modelName, neighbours, allPositions);
    let pos: NodePosition;

    if (relatedPositioned.length > 0) {
      pos = placeNearCentroid(relatedPositioned, allPositions);
    } else {
      pos = gridScan(allPositions);
    }

    allPositions[modelName] = pos;
    result[modelName] = pos;
  }

  return result;
}

/**
 * Find the first open grid cell. Extracted from the former
 * `findOpenPosition` private method for reuse.
 */
export function findOpenPosition(
  existingPositions: Record<string, NodePosition>,
): NodePosition {
  return gridScan(existingPositions);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a map of model → set of related model names from relationships. */
function buildNeighbourMap(
  newModels: string[],
  relationships: Relationship[],
): Map<string, Set<string>> {
  const newSet = new Set(newModels);
  const map = new Map<string, Set<string>>();

  for (const name of newModels) {
    map.set(name, new Set());
  }

  for (const rel of relationships) {
    if (newSet.has(rel.fromModel)) {
      map.get(rel.fromModel)!.add(rel.toModel);
    }
    if (newSet.has(rel.toModel)) {
      map.get(rel.toModel)!.add(rel.fromModel);
    }
  }

  return map;
}

/** Sort new models so those connected to already-positioned models come first. */
function sortByConnectedness(
  newModels: string[],
  neighbours: Map<string, Set<string>>,
  currentPositions: Record<string, NodePosition>,
): string[] {
  const placed = new Set(Object.keys(currentPositions));
  const remaining = new Set(newModels);
  const ordered: string[] = [];

  // Iterative waves: pick models with at least one placed neighbour
  let changed = true;
  while (changed && remaining.size > 0) {
    changed = false;
    for (const name of remaining) {
      const nbrs = neighbours.get(name)!;
      const hasPlacedNeighbour = [...nbrs].some((n) => placed.has(n));
      if (hasPlacedNeighbour) {
        ordered.push(name);
        remaining.delete(name);
        placed.add(name);
        changed = true;
      }
    }
  }

  // Remaining orphans (no positioned neighbours at all)
  for (const name of remaining) {
    ordered.push(name);
  }

  return ordered;
}

/** Get positions of a model's neighbours that are already placed. */
function getPositionedNeighbours(
  modelName: string,
  neighbours: Map<string, Set<string>>,
  positions: Record<string, NodePosition>,
): NodePosition[] {
  const nbrs = neighbours.get(modelName);
  if (!nbrs) return [];

  const result: NodePosition[] = [];
  for (const n of nbrs) {
    if (positions[n]) {
      result.push(positions[n]);
    }
  }
  return result;
}

/** Place a model near the centroid of its positioned neighbours, offset to avoid overlap. */
function placeNearCentroid(
  neighbourPositions: NodePosition[],
  allPositions: Record<string, NodePosition>,
): NodePosition {
  const cx =
    neighbourPositions.reduce((sum, p) => sum + p.x, 0) / neighbourPositions.length;
  const cy =
    neighbourPositions.reduce((sum, p) => sum + p.y, 0) / neighbourPositions.length;

  // Try placing one cell to the right of centroid, then scan nearby cells
  const offsets: [number, number][] = [
    [1, 0],   // right
    [0, 1],   // below
    [-1, 0],  // left
    [0, -1],  // above
    [1, 1],   // bottom-right
    [-1, 1],  // bottom-left
    [1, -1],  // top-right
    [-1, -1], // top-left
    [2, 0],   // two right
    [0, 2],   // two below
  ];

  // Snap centroid to nearest grid cell
  const baseCol = Math.max(0, Math.round((cx - 100) / CELL_WIDTH));
  const baseRow = Math.max(0, Math.round((cy - 100) / CELL_HEIGHT));

  for (const [dc, dr] of offsets) {
    const col = baseCol + dc;
    const row = baseRow + dr;
    if (col < 0 || row < 0) continue;

    const candidate: NodePosition = {
      x: col * CELL_WIDTH + 100,
      y: row * CELL_HEIGHT + 100,
    };

    if (!isOverlapping(candidate, allPositions)) {
      return candidate;
    }
  }

  // All nearby cells occupied — fall back to full grid scan
  return gridScan(allPositions);
}

/** Check if a candidate position overlaps any existing position. */
function isOverlapping(
  candidate: NodePosition,
  positions: Record<string, NodePosition>,
): boolean {
  for (const existing of Object.values(positions)) {
    const dx = Math.abs(candidate.x - existing.x);
    const dy = Math.abs(candidate.y - existing.y);
    if (dx < CELL_WIDTH && dy < CELL_HEIGHT) {
      return true;
    }
  }
  return false;
}

/** Scan the grid for the first unoccupied cell. */
function gridScan(positions: Record<string, NodePosition>): NodePosition {
  const values = Object.values(positions);

  if (values.length === 0) {
    return { x: 100, y: 100 };
  }

  const maxX = Math.max(...values.map((p) => p.x), 0);

  for (let row = 0; row < 20; row++) {
    for (let col = 0; col < 10; col++) {
      const candidate: NodePosition = {
        x: col * CELL_WIDTH + 100,
        y: row * CELL_HEIGHT + 100,
      };
      if (!isOverlapping(candidate, positions)) {
        return candidate;
      }
    }
  }

  // All grid cells exhausted — place after rightmost
  return { x: maxX + CELL_WIDTH, y: 100 };
}
