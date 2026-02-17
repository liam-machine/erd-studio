/**
 * Graph transformer — converts a ReconciledDomain into React Flow nodes and edges.
 *
 * This is a pure function with no side effects, making it easy to unit test.
 * It handles:
 *   1. Mapping each ReconciledModel → ModelFlowNode (with position + columns)
 *   2. Mapping each ReconciledRelationship → FkFlowEdge (with handle side selection)
 *   3. Selecting optimal handle sides based on relative node positions
 *
 * Column resolution and status determination is done by ReconciliationService
 * in the extension host — the transformer just maps to React Flow shapes.
 */

import type {
  ReconciledDomain,
  ReconciledModel,
} from '../../src/types/reconciled';
import type {
  ModelFlowNode,
  FkFlowEdge,
  ColumnDisplay,
} from '../types/graph';
import { sortColumnsByKeyPriority } from './columnSort';

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
 * Convert a ReconciledModel's columns to ColumnDisplay[].
 * Columns are already resolved by ReconciliationService — we just map the shape
 * and sort by key priority (PK → NK → FK → non-key).
 */
function mapColumns(model: ReconciledModel): ColumnDisplay[] {
  const mapped = model.columns.map((col) => ({
    name: col.name,
    dataType: col.dataType,
    isPrimaryKey: col.isPrimaryKey,
    isForeignKey: col.isForeignKey,
    isNaturalKey: col.isNaturalKey,
    status: col.status,
    approved: col.approved,
  }));
  return sortColumnsByKeyPriority(mapped);
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
 * Convert a ReconciledDomain into React Flow nodes and edges.
 *
 * @param domain — the reconciled domain from extension host (already merged with manifest)
 * @returns nodes and edges ready for React Flow's `<ReactFlow>` component
 */
export function transformDomain(domain: ReconciledDomain): TransformResult {
  const { models, relationships, viewConfig, layer, layerConfig } = domain;
  const positions = viewConfig.positions ?? {};

  // Build a map of model name → position for edge handle selection.
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const model of models) {
    positionMap.set(model.name, positions[model.name] ?? DEFAULT_POSITION);
  }

  // --- Nodes ---------------------------------------------------------------

  const nodes: ModelFlowNode[] = models.map((model) => {
    const columns = mapColumns(model);
    const position = positionMap.get(model.name) ?? DEFAULT_POSITION;

    return {
      id: model.name,
      type: 'model',
      position,
      data: {
        modelName: model.name,
        status: model.status,
        approved: model.approved,
        layer,
        layerConfig,
        columns,
        ...(model.discrepancyCount ? { discrepancyCount: model.discrepancyCount } : {}),
        ...(model.ai && (model.ai.what || model.ai.why) ? { hasAiRationale: true } : {}),
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
          status: rel.status,
          approved: rel.approved,
        },
      };
    });

  return { nodes, edges };
}
