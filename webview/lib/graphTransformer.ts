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
  AnnotationFlowNode,
  AnnotationFlowEdge,
  ColumnDisplay,
} from '../types/graph';
import { resolveNodeDimensions } from './elkLayout';
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TransformResult {
  nodes: (ModelFlowNode | AnnotationFlowNode)[];
  edges: (FkFlowEdge | AnnotationFlowEdge)[];
}

/** Width/height of a rendered node, in canvas pixels. */
export interface NodeDimensions {
  width: number;
  height: number;
}

/** Optional parameters for discrepancy overlay rendering. */
export interface TransformOptions {
  /** Active cross-stage discrepancy report (e.g., physical vs logical). */
  discrepancyReport?: DiscrepancyReport;
  /**
   * Measured node sizes (keyed by node id) from the current React Flow state.
   * Used to pick edge handle sides from node centres rather than top-left
   * corners. Nodes without an entry fall back to an estimate.
   */
  nodeDimensions?: ReadonlyMap<string, NodeDimensions>;
  /** Column expansion state per model — sharpens the height estimate fallback. */
  isExpanded?: (modelName: string) => boolean;
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

/** A node's top-left position plus its rendered size. */
export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Default annotation size when the note has not been resized (matches CSS min-width/height). */
const DEFAULT_ANNOTATION_WIDTH = 160;
const DEFAULT_ANNOTATION_HEIGHT = 80;

/**
 * Choose which side of each node to connect, minimising visual bends.
 *
 * Compares the relative position of the source and target node *centres*
 * and picks the axis (horizontal or vertical) with the greater distance.
 * On that axis, the source connects on the side facing the target and vice
 * versa. Centres (not top-left corners) matter because a tall node next to a
 * short one would otherwise route its edge out of the wrong side.
 */
export function pickHandleSides(
  source: NodeRect,
  target: NodeRect,
): { sourceSide: Side; targetSide: Side } {
  const dx = (target.x + target.width / 2) - (source.x + source.width / 2);
  const dy = (target.y + target.height / 2) - (source.y + source.height / 2);

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

  // Node id → rendered size (measured when known, else estimated) so handle
  // sides are chosen from node centres.
  const dimensionMap = new Map<string, NodeDimensions>();
  const rectOf = (id: string): NodeRect => {
    const pos = positionMap.get(id) ?? DEFAULT_POSITION;
    const dims = dimensionMap.get(id) ?? { width: 0, height: 0 };
    return { x: pos.x, y: pos.y, width: dims.width, height: dims.height };
  };
  const dimensionsFor = (id: string, data: ModelFlowNode['data']): NodeDimensions =>
    options?.nodeDimensions?.get(id)
      ?? resolveNodeDimensions({
        data: { ...data, isExpanded: options?.isExpanded?.(id) ?? false },
        measured: undefined,
      });

  // --- Nodes ---------------------------------------------------------------

  const nodes: (ModelFlowNode | AnnotationFlowNode)[] = models.map((model) => {
    const columns = mapColumns(model);
    const position = positionMap.get(model.name) ?? DEFAULT_POSITION;
    const disc = discrepancyMap.get(model.name);

    const node: ModelFlowNode = {
      id: model.name,
      type: 'model' as const,
      position,
      data: {
        modelName: model.name,
        stage,
        layer,
        layerConfig,
        ...(model.schema ? { schema: model.schema } : {}),
        columns,
        isStub: domain.stubColumns?.includes(model.name) ?? false,
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
    dimensionMap.set(model.name, dimensionsFor(model.name, node.data));
    return node;
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
        const ghost: ModelFlowNode = {
          id: md.name,
          type: 'model' as const,
          position,
          data: {
            modelName: md.name,
            stage,
            layer,
            layerConfig,
            columns: [],
            isStub: false,
            isGhost: true,
            readOnly: true,
            discrepancy: md,
            discrepancySourceStage: options.discrepancyReport.sourceStage,
            discrepancyTargetStage: options.discrepancyReport.targetStage,
          },
        };
        dimensionMap.set(md.name, dimensionsFor(md.name, ghost.data));
        nodes.push(ghost);
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

  const edges: (FkFlowEdge | AnnotationFlowEdge)[] = relationships
    .filter((rel) => allNodeNames.has(rel.fromModel) && allNodeNames.has(rel.toModel))
    .map((rel) => {
      const isSelfLoop = rel.fromModel === rel.toModel;
      // Self-refs attach to top (source) and right (target) handles so the
      // FkEdge component can arc the path over the top-right corner.
      const { sourceSide, targetSide } = isSelfLoop
        ? { sourceSide: 'top' as Side, targetSide: 'right' as Side }
        : pickHandleSides(rectOf(rel.fromModel), rectOf(rel.toModel));

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
          ...(isSelfLoop ? { isSelfLoop: true } : {}),
        },
      };
    });

  // Ghost edges for 'missing' relationships from discrepancy report
  if (options?.discrepancyReport) {
    for (const rd of options.discrepancyReport.relationships) {
      if (rd.status === 'missing') {
        if (!positionMap.has(rd.fromModel) || !positionMap.has(rd.toModel)) continue;

        const isSelfLoop = rd.fromModel === rd.toModel;
        const { sourceSide, targetSide } = isSelfLoop
          ? { sourceSide: 'top' as Side, targetSide: 'right' as Side }
          : pickHandleSides(rectOf(rd.fromModel), rectOf(rd.toModel));
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
            ...(isSelfLoop ? { isSelfLoop: true } : {}),
          },
        });
      }
    }
  }

  // --- Annotations ----------------------------------------------------------

  const annotations = domain.viewConfig.annotations ?? [];
  for (const ann of annotations) {
    const annNodeId = `annotation-${ann.id}`;
    nodes.push({
      id: annNodeId,
      type: 'annotation' as const,
      position: { x: ann.x, y: ann.y },
      data: {
        annotationId: ann.id,
        text: ann.text,
        color: ann.color ?? 'yellow',
        ...(ann.width != null ? { width: ann.width } : {}),
        ...(ann.height != null ? { height: ann.height } : {}),
        ...(ann.linkedModel ? { linkedModel: ann.linkedModel } : {}),
        ...(readOnly ? { readOnly: true } : {}),
      },
    } as AnnotationFlowNode);

    // Dashed edge to linked model (only if model exists in node set)
    if (ann.linkedModel && positionMap.has(ann.linkedModel)) {
      const annDims = options?.nodeDimensions?.get(annNodeId);
      const annRect: NodeRect = {
        x: ann.x,
        y: ann.y,
        width: annDims?.width ?? ann.width ?? DEFAULT_ANNOTATION_WIDTH,
        height: annDims?.height ?? ann.height ?? DEFAULT_ANNOTATION_HEIGHT,
      };
      const { sourceSide, targetSide } = pickHandleSides(annRect, rectOf(ann.linkedModel));
      edges.push({
        id: `ann-link-${ann.id}`,
        type: 'annotationLink' as const,
        source: annNodeId,
        target: ann.linkedModel,
        sourceHandle: `node-${sourceSide}-src`,
        targetHandle: `node-${targetSide}-tgt`,
        data: {
          annotationId: ann.id,
          targetModel: ann.linkedModel,
        },
      } as AnnotationFlowEdge);
    }
  }

  return { nodes, edges };
}
