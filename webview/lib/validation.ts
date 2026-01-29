/**
 * Validation utilities for the semantic designer webview.
 *
 * Contains functions for detecting circular FK relationships and other
 * validation logic that requires graph traversal.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RelationshipEdge {
  fromModel: string;
  toModel: string;
}

// ---------------------------------------------------------------------------
// Circular FK Detection
// ---------------------------------------------------------------------------

/**
 * Detects if adding a new FK relationship would create a circular reference.
 *
 * Uses depth-first search from the new relationship's target model, following
 * existing FK edges to see if we can reach the source model. If yes, adding
 * the new edge would create a cycle.
 *
 * @param existingRelationships - Current relationships in the domain
 * @param newFromModel - Source model of the proposed new relationship
 * @param newToModel - Target model of the proposed new relationship
 * @returns Array of model names forming the cycle path, or null if no cycle
 *
 * @example
 * // Existing: orders → customers, customers → regions
 * // New: regions → orders
 * // Returns: ['regions', 'orders', 'customers', 'regions']
 */
export function detectCircularFk(
  existingRelationships: RelationshipEdge[],
  newFromModel: string,
  newToModel: string,
): string[] | null {
  // Self-reference is handled separately (different error message)
  if (newFromModel === newToModel) {
    return null;
  }

  // Build adjacency list: model → models it points to via FK
  const adjacency = new Map<string, Set<string>>();

  for (const rel of existingRelationships) {
    if (!adjacency.has(rel.fromModel)) {
      adjacency.set(rel.fromModel, new Set());
    }
    adjacency.get(rel.fromModel)!.add(rel.toModel);
  }

  // Add the proposed new edge to check for cycles
  if (!adjacency.has(newFromModel)) {
    adjacency.set(newFromModel, new Set());
  }
  adjacency.get(newFromModel)!.add(newToModel);

  // DFS from newFromModel to see if we can return to it (cycle detection)
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(current: string): boolean {
    if (current === newFromModel && path.length > 0) {
      // Found a cycle back to the starting model
      path.push(current);
      return true;
    }

    if (visited.has(current)) {
      return false;
    }

    visited.add(current);
    path.push(current);

    const neighbors = adjacency.get(current);
    if (neighbors) {
      for (const neighbor of neighbors) {
        if (dfs(neighbor)) {
          return true;
        }
      }
    }

    path.pop();
    return false;
  }

  // Start DFS from the target of the new relationship
  // We want to see if following edges from newToModel leads back to newFromModel
  visited.add(newFromModel);
  path.push(newFromModel);

  const neighbors = adjacency.get(newFromModel);
  if (neighbors) {
    for (const neighbor of neighbors) {
      if (dfs(neighbor)) {
        return path;
      }
    }
  }

  return null;
}

/**
 * Formats a cycle path into a human-readable string.
 *
 * @param cyclePath - Array of model names forming the cycle
 * @returns Formatted string like "orders → customers → orders"
 */
export function formatCyclePath(cyclePath: string[]): string {
  return cyclePath.join(' → ');
}
