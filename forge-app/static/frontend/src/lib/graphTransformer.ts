import type { DisplayDomain, DisplayModel } from '../types/display';
import type { ModelFlowNode, FkFlowEdge, ColumnDisplay } from '../types/graph';

export interface TransformResult {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
}

const DEFAULT_POSITION = { x: 0, y: 0 };

function mapColumns(model: DisplayModel): ColumnDisplay[] {
  return model.columns.map((col) => ({
    name: col.name,
    dataType: col.dataType,
    ...(col.description ? { description: col.description } : {}),
    isPrimaryKey: col.isPrimaryKey,
    isForeignKey: col.isForeignKey,
    isNaturalKey: col.isNaturalKey,
    ...(col.scdType != null ? { scdType: col.scdType } : {}),
    ...(col.additiveType ? { additiveType: col.additiveType } : {}),
  }));
}

type Side = 'top' | 'right' | 'bottom' | 'left';

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

export function transformDomain(domain: DisplayDomain): TransformResult {
  const { models, relationships, viewConfig, layer, stage, layerConfig, readOnly } = domain;
  const positions = viewConfig.positions ?? {};

  const positionMap = new Map<string, { x: number; y: number }>();
  for (const model of models) {
    positionMap.set(model.name, positions[model.name] ?? DEFAULT_POSITION);
  }

  const nodes: ModelFlowNode[] = models.map((model) => {
    const columns = mapColumns(model);
    const position = positionMap.get(model.name) ?? DEFAULT_POSITION;

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
        ...(model.rationale && (model.rationale.purpose || model.rationale.design) ? { hasRationale: true } : {}),
        ...(model.grain ? { grain: model.grain } : {}),
        ...(model.modelRole ? { modelRole: model.modelRole } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      },
    };
  });

  const allNodeNames = new Set(positionMap.keys());

  const edges: FkFlowEdge[] = relationships
    .filter((rel) => allNodeNames.has(rel.fromModel) && allNodeNames.has(rel.toModel))
    .map((rel) => {
      const sourcePos = positionMap.get(rel.fromModel)!;
      const targetPos = positionMap.get(rel.toModel)!;
      const { sourceSide, targetSide } = pickHandleSides(sourcePos, targetPos);

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
        },
      };
    });

  return { nodes, edges };
}
