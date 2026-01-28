/**
 * Graph transformer — converts a SemanticDomain into React Flow nodes and edges.
 *
 * This is a pure function with no side effects, making it easy to unit test.
 * It handles:
 *   1. Mapping each SemanticModel → ModelFlowNode (with position + columns)
 *   2. Mapping each Relationship → FkFlowEdge (with handle side selection)
 *   3. Enriching columns with isForeignKey by cross-referencing relationships
 *   4. Selecting optimal handle sides based on relative node positions
 */

import type {
  SemanticDomain,
  SemanticModel,
  Relationship,
} from '../../src/types/semantic';
import type {
  ModelFlowNode,
  FkFlowEdge,
  ColumnDisplay,
} from '../types/graph';
import { getModelStatus, getRelationshipStatus } from './colorScheme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformResult {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default position for models without a saved position in viewConfig. */
const DEFAULT_POSITION = { x: 0, y: 0 };

/**
 * Build a set of column names that are FK sources within a domain.
 * A column is an FK source if it appears as `fromColumn` in any relationship
 * where `fromModel` matches the given model name.
 */
function buildFkColumnSet(
  modelName: string,
  relationships: Relationship[],
): Set<string> {
  const fkCols = new Set<string>();
  for (const rel of relationships) {
    if (rel.fromModel === modelName) {
      fkCols.add(rel.fromColumn);
    }
  }
  return fkCols;
}

/**
 * Convert a SemanticModel's columns into ColumnDisplay[], enriching each
 * column with isPrimaryKey and isForeignKey flags.
 *
 * - Repo models: columns will eventually come from the manifest via F111.
 *   For now, repo models have no inline columns so we return an empty array.
 * - Design models: columns come from the inline `columns` array.
 */
function buildColumns(
  model: SemanticModel,
  fkColumns: Set<string>,
): ColumnDisplay[] {
  const cols = model.columns ?? [];
  return cols.map((col) => ({
    name: col.name,
    dataType: col.dataType,
    isPrimaryKey: col.isPrimaryKey === true,
    isForeignKey: fkColumns.has(col.name),
  }));
}

// ---------------------------------------------------------------------------
// Handle side selection
// ---------------------------------------------------------------------------

type Side = 'top' | 'right' | 'bottom' | 'left';

/**
 * Choose which side of each node to connect, minimising visual bends.
 *
 * Compares the relative position of source and target nodes and picks
 * the axis (horizontal or vertical) with the greater distance. On that
 * axis, the source connects on the side facing the target and vice versa.
 *
 * Example: source at (350, 100), target at (50, 100) → source uses left,
 * target uses right (horizontal distance dominates).
 */
function pickHandleSides(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
): { sourceSide: Side; targetSide: Side } {
  const dx = targetPos.x - sourcePos.x;
  const dy = targetPos.y - sourcePos.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal connection
    return dx >= 0
      ? { sourceSide: 'right', targetSide: 'left' }
      : { sourceSide: 'left', targetSide: 'right' };
  } else {
    // Vertical connection
    return dy >= 0
      ? { sourceSide: 'bottom', targetSide: 'top' }
      : { sourceSide: 'top', targetSide: 'bottom' };
  }
}

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------

/**
 * Convert a SemanticDomain into React Flow nodes and edges.
 *
 * @param domain — the semantic domain loaded from JSON (via extension host).
 * @returns nodes and edges ready for React Flow's `<ReactFlow>` component.
 */
export function transformDomain(domain: SemanticDomain): TransformResult {
  const { models, relationships, viewConfig, layer } = domain;
  const positions = viewConfig.positions ?? {};

  // Build a map of model name → position for edge handle selection.
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const model of models) {
    positionMap.set(model.name, positions[model.name] ?? DEFAULT_POSITION);
  }

  // --- Nodes ---------------------------------------------------------------

  const nodes: ModelFlowNode[] = models.map((model) => {
    const fkColumns = buildFkColumnSet(model.name, relationships);
    const columns = buildColumns(model, fkColumns);
    const position = positionMap.get(model.name) ?? DEFAULT_POSITION;

    return {
      id: model.name,
      type: 'model',
      position,
      data: {
        modelName: model.name,
        status: getModelStatus(model),
        layer,
        columns,
      },
    };
  });

  // --- Edges ---------------------------------------------------------------

  // Only include edges where both endpoints exist in the models array.
  // Relationships can reference models from other domains — those edges
  // would cause React Flow errors if rendered without matching nodes.
  const modelNames = new Set(models.map((m) => m.name));

  const edges: FkFlowEdge[] = relationships
    .filter((rel) => modelNames.has(rel.fromModel) && modelNames.has(rel.toModel))
    .map((rel) => {
      const sourcePos = positionMap.get(rel.fromModel)!;
      const targetPos = positionMap.get(rel.toModel)!;
      const { sourceSide, targetSide } = pickHandleSides(sourcePos, targetPos);

      return {
        id: `fk-${rel.fromModel}-${rel.fromColumn}-${rel.toModel}-${rel.toColumn}`,
        type: 'fk',
        source: rel.fromModel,
        target: rel.toModel,
        sourceHandle: `node-${sourceSide}-src`,
        targetHandle: `node-${targetSide}-tgt`,
        data: {
          fromModel: rel.fromModel,
          fromColumn: rel.fromColumn,
          toModel: rel.toModel,
          toColumn: rel.toColumn,
          cardinality: rel.cardinality,
          status: getRelationshipStatus(rel),
        },
      };
    });

  return { nodes, edges };
}
