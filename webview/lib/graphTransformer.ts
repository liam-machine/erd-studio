/**
 * Graph transformer — converts a DisplayDomain into React Flow nodes and edges.
 *
 * This is a pure function with no side effects, making it easy to unit test.
 * It handles:
 *   1. Mapping each DisplayModel → ModelFlowNode (with position + columns)
 *   2. Mapping each DisplayRelationship → FkFlowEdge (with handle side selection)
 *   3. Selecting optimal handle sides based on relative node positions
 *   4. Injecting discrepancy data and ghost nodes/edges when a comparison report is active
 */

import type {
  DisplayDomain,
  DisplayModel,
} from '../../src/types/display';
import type {
  DiscrepancyReport,
  ModelDiscrepancy,
} from '../../src/types/discrepancy';
import type {
  ModelFlowNode,
  FkFlowEdge,
  ColumnDisplay,
} from '../types/graph';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformResult {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
}

/** Optional parameters for discrepancy overlay rendering. */
export interface TransformOptions {
  /** Active cross-stage discrepancy report (e.g., physical vs logical). */
  discrepancyReport?: DiscrepancyReport;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default position for models without a saved position in viewConfig. */
const DEFAULT_POSITION = { x: 0, y: 0 };

/**
 * Convert a DisplayModel's columns to ColumnDisplay[].
 * Sort by key priority (PK → NK → FK → non-key).
 */
function mapColumns(model: DisplayModel): ColumnDisplay[] {
  const mapped = model.columns.map((col) => ({
    name: col.name,
    dataType: col.dataType,
    ...(col.description ? { description: col.description } : {}),
    isPrimaryKey: col.isPrimaryKey,
    isForeignKey: col.isForeignKey,
    isNaturalKey: col.isNaturalKey,
    ...(col.scdType != null ? { scdType: col.scdType } : {}),
    ...(col.additiveType ? { additiveType: col.additiveType } : {}),
  }));
  return mapped;
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
 */
function pickHandleSides(
  sourcePos: { x: number; y: number },
  targetPos: { x: number; y: number },
): { sourceSide: Side; targetSide: Side } {
  const dx = targetPos.x - sourcePos.x;
  const dy = targetPos.y - sourcePos.y;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceSide: 'right', targetSide: 'left' }
      : { sourceSide: 'left', targetSide: 'right' };
  } else {
    return dy >= 0
      ? { sourceSide: 'bottom', targetSide: 'top' }
      : { sourceSide: 'top', targetSide: 'bottom' };
  }
}

// ---------------------------------------------------------------------------
// Main transformer
// ---------------------------------------------------------------------------

/**
 * Convert a DisplayDomain into React Flow nodes and edges.
 *
 * @param domain — the display domain from extension host
 * @param options — optional discrepancy report and ghost positions
 * @returns nodes and edges ready for React Flow's `<ReactFlow>` component
 */
export function transformDomain(
  domain: DisplayDomain,
  options?: TransformOptions,
): TransformResult {
  const { models, relationships, viewConfig, layer, stage, layerConfig, readOnly } = domain;
  const positions = viewConfig.positions ?? {};

  // Build discrepancy lookup if report is active
  const discrepancyMap = new Map<string, ModelDiscrepancy>();
  if (options?.discrepancyReport) {
    for (const md of options.discrepancyReport.models) {
      discrepancyMap.set(md.name, md);
    }
  }

  // Build a map of model name → position for edge handle selection.
  const positionMap = new Map<string, { x: number; y: number }>();
  for (const model of models) {
    positionMap.set(model.name, positions[model.name] ?? DEFAULT_POSITION);
  }

  // --- Nodes ---------------------------------------------------------------

  const nodes: ModelFlowNode[] = models.map((model) => {
    const columns = mapColumns(model);
    const position = positionMap.get(model.name) ?? DEFAULT_POSITION;
    const disc = discrepancyMap.get(model.name);

    return {
      id: model.name,
      type: 'model' as const,
      position,
      data: {
        modelName: model.name,
        stage,
        layer,
        layerConfig,
        columns,
        ...(model.rationale && (model.rationale.purpose || model.rationale.design || model.rationale.grainChoice || model.rationale.roleChoice || model.rationale.scdStrategy || model.rationale.measures) ? { hasRationale: true } : {}),
        ...(model.grain ? { grain: model.grain } : {}),
        ...(model.modelRole ? { modelRole: model.modelRole } : {}),
        ...(readOnly ? { readOnly: true } : {}),
        ...(model.existsInManifest === false ? { isGhost: true } : {}),
        ...(disc ? { discrepancy: disc } : {}),
        ...(disc && options?.discrepancyReport ? {
          discrepancySourceStage: options.discrepancyReport.sourceStage,
          discrepancyTargetStage: options.discrepancyReport.targetStage,
        } : {}),
      },
    };
  });

  // Ghost nodes for 'missing' models from discrepancy report.
  // Uses global positions map first, falls back to stacked row above canvas.
  if (options?.discrepancyReport) {
    let ghostIndex = 0;
    for (const md of options.discrepancyReport.models) {
      if (md.status === 'missing') {
        const position = positions[md.name] ?? { x: 50 + ghostIndex * 260, y: -150 };
        ghostIndex++;
        positionMap.set(md.name, position);
        nodes.push({
          id: md.name,
          type: 'model' as const,
          position,
          data: {
            modelName: md.name,
            stage,
            layer,
            layerConfig,
            columns: [],
            isGhost: true,
            readOnly: true,
            discrepancy: md,
            discrepancySourceStage: options.discrepancyReport.sourceStage,
            discrepancyTargetStage: options.discrepancyReport.targetStage,
          },
        });
      }
    }
  }

  // --- Edges ---------------------------------------------------------------

  // Build relationship discrepancy lookup
  const relDiscrepancyMap = new Map<string, 'extra' | 'missing' | 'cardinality-mismatch'>();
  if (options?.discrepancyReport) {
    for (const rd of options.discrepancyReport.relationships) {
      if (rd.status !== 'matched') {
        const key = `${rd.fromModel}|${rd.fromColumn}|${rd.toModel}|${rd.toColumn}`;
        relDiscrepancyMap.set(key, rd.status);
      }
    }
  }

  // Only include edges where both endpoints exist in the models/ghost nodes.
  const allNodeNames = new Set(positionMap.keys());

  const edges: FkFlowEdge[] = relationships
    .filter((rel) => allNodeNames.has(rel.fromModel) && allNodeNames.has(rel.toModel))
    .map((rel) => {
      const sourcePos = positionMap.get(rel.fromModel)!;
      const targetPos = positionMap.get(rel.toModel)!;
      const { sourceSide, targetSide } = pickHandleSides(sourcePos, targetPos);

      const relKey = `${rel.fromModel}|${rel.fromColumn}|${rel.toModel}|${rel.toColumn}`;
      const discStatus = relDiscrepancyMap.get(relKey);

      return {
        id: `fk-${rel.fromModel}-${rel.fromColumn}-${rel.toModel}-${rel.toColumn}`,
        type: 'fk' as const,
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
          stage,
          ...(readOnly ? { readOnly: true } : {}),
          ...(discStatus ? { discrepancyStatus: discStatus } : {}),
        },
      };
    });

  // Ghost edges for 'missing' relationships from discrepancy report
  if (options?.discrepancyReport) {
    for (const rd of options.discrepancyReport.relationships) {
      if (rd.status === 'missing') {
        const sourcePos = positionMap.get(rd.fromModel);
        const targetPos = positionMap.get(rd.toModel);
        if (!sourcePos || !targetPos) continue;

        const { sourceSide, targetSide } = pickHandleSides(sourcePos, targetPos);
        edges.push({
          id: `ghost-fk-${rd.fromModel}-${rd.fromColumn}-${rd.toModel}-${rd.toColumn}`,
          type: 'fk' as const,
          source: rd.fromModel,
          target: rd.toModel,
          sourceHandle: `node-${sourceSide}-src`,
          targetHandle: `node-${targetSide}-tgt`,
          data: {
            fromModel: rd.fromModel,
            fromColumn: rd.fromColumn,
            toModel: rd.toModel,
            toColumn: rd.toColumn,
            cardinality: rd.sourceCardinality ?? rd.targetCardinality ?? 'many-to-one',
            stage,
            discrepancyStatus: 'missing',
          },
        });
      }
    }
  }

  return { nodes, edges };
}
