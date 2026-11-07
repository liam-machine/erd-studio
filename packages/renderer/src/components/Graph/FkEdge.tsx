/**
 * FkEdge — custom React Flow edge for displaying FK relationships.
 *
 * Draws its route from the one-pass line router (`EdgeRouter`, in the canvas
 * store's `edgeRoutes`) when it has one, else a smooth-step path, with Power
 * BI-style cardinality labels:
 * `*` for "many" and `1` for "one", positioned near each endpoint.
 * Built relationships are blue; design relationships are orange.
 * All edges use a solid line style.
 *
 * The edge line stops short of the node so the cardinality label sits
 * in the gap between the line end and the node boundary.
 *
 * Edges connect to node-level handles (top/right/bottom/left) rather
 * than column-specific handles, choosing the side that creates the
 * least bends.
 *
 * Edges of the hovered or selected table carry moving arrows from the 1 end
 * to the * end; one-to-one shows two dots meeting (`EdgeFlow`). While a hover
 * preview is active, the hovered table's lines are marked lit so the root
 * `erd-flow--hover-focus` class can fade every other line (`useHoverFocus`).
 */

import { memo, useCallback, useMemo, useState } from 'react';
import {
  getSmoothStepPath,
  EdgeLabelRenderer,
  Position,
  useStore,
  useStoreApi,
  useInternalNode,
  type EdgeProps,
} from '@xyflow/react';
import type { FkFlowEdge } from '../../types/graph';
import { backwardsRelationshipNote } from '@erd-studio/core';
import { useCanvasHost, useIsViewer } from '../../host/canvasEnvironment';
import { useEditorStoreOr } from '../../store/editorStore';
import { edgeFocusRole } from '../../lib/canvasFocus';
import { flowModeFor } from '../../lib/edgeFlow';
import { EdgeFlow } from './EdgeFlow';
import { swapCardinality } from '../../lib/cardinalityUtils';
import { edgeHoverText } from '../../lib/badgeLabels';
import {
  calculateEdgeOffsetInGroup,
  getEdgesOnSide,
  buildPositionsKey,
  parseSideFromHandle,
  getSideLength,
  type NodePositionMap,
} from '../../lib/edgeDistribution';
import './FkEdge.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How far (px) to shorten the edge path on each end (leaves room for label). */
const PATH_GAP = 20;

/** How far (px) from the node boundary to place the cardinality label. */
const LABEL_OFFSET = 8;

/**
 * Radius (px) of the arc drawn for self-reference edges. The loop exits the
 * top of the node, arcs outward past the top-right corner, and re-enters the
 * right side. A larger radius means the loop extends further from the node.
 */
const SELF_LOOP_RADIUS = 55;
/** How much wider each further self-loop on one node is drawn, so they nest (#133 L3). */
const SELF_LOOP_STEP = 18;

/**
 * Routed anchor side → React Flow position. Position's values are the side
 * names, so this is a cast (no runtime read of `Position`, so tests that mock
 * @xyflow/react without it still import).
 */
function sidePosition(side: 'top' | 'right' | 'bottom' | 'left'): Position {
  return side as Position;
}

/** Stable empty sibling group for edges whose handle side is unknown. */
const NO_SIBLINGS: readonly import('@xyflow/react').Edge[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Offset a point away from its node along the edge direction.
 * `position` is the handle side (Right/Left/Top/Bottom).
 */
function offsetPoint(
  x: number,
  y: number,
  position: Position,
  distance: number,
): { x: number; y: number } {
  switch (position) {
    case Position.Right:
      return { x: x + distance, y };
    case Position.Left:
      return { x: x - distance, y };
    case Position.Bottom:
      return { x, y: y + distance };
    case Position.Top:
      return { x, y: y - distance };
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function FkEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  targetHandleId,
  data,
}: EdgeProps<FkFlowEdge>) {
  // Access all edges from React Flow store for distribution calculation
  const allEdges = useStore((state) => state.edges);
  const storeApi = useStoreApi();

  const fromModel = data?.fromModel ?? '';
  const toModel = data?.toModel ?? '';

  // Get source and target node dimensions for calculating side lengths
  const sourceNode = useInternalNode(fromModel);
  const targetNode = useInternalNode(toModel);

  // Parse which side each handle is on (top/right/bottom/left)
  const sourceSide = parseSideFromHandle(sourceHandleId);
  const targetSide = parseSideFromHandle(targetHandleId);

  // Sibling edges sharing each endpoint side (cached per edges array — O(1)).
  const sourceGroup = sourceSide ? getEdgesOnSide(allEdges, fromModel, sourceSide) : NO_SIBLINGS;
  const targetGroup = targetSide ? getEdgesOnSide(allEdges, toModel, targetSide) : NO_SIBLINGS;

  // Nodes at the far end of every sibling edge — their positions decide this
  // edge's slot along the side.
  const neighbourIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of sourceGroup) ids.add(e.source === fromModel ? e.target : e.source);
    for (const e of targetGroup) ids.add(e.source === toModel ? e.target : e.source);
    return [...ids];
  }, [sourceGroup, targetGroup, fromModel, toModel]);

  // React Flow mutates `nodeLookup` in place, so memoising on the Map identity
  // froze the spatial ordering at first render. Subscribe to a value key of the
  // neighbours' positions instead — it changes exactly when one of them moves
  // (drag, auto-layout, undo) and stays stable otherwise.
  const positionsKey = useStore((state) => buildPositionsKey(state.nodeLookup, neighbourIds));

  const nodePositions = useMemo((): NodePositionMap => {
    const lookup = storeApi.getState().nodeLookup;
    const positions: NodePositionMap = new Map();
    for (const id of neighbourIds) {
      const node = lookup.get(id);
      if (!node) continue;
      positions.set(id, node.internals?.positionAbsolute ?? node.position);
    }
    return positions;
    // positionsKey is the real dependency: it encodes the positions read here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positionsKey, neighbourIds, storeApi]);

  const host = useCanvasHost();
  const viewer = useIsViewer();
  const [hovered, setHovered] = useState(false);
  const [backwardsHovered, setBackwardsHovered] = useState(false);

  const handleSwap = useCallback(
    (e: React.MouseEvent) => {
      if (!data) return;
      e.stopPropagation();
      host.postMessage({
        type: 'updateRelationship',
        payload: {
          fromModel: data.fromModel,
          fromColumn: data.fromColumn,
          toModel: data.toModel,
          toColumn: data.toColumn,
          cardinality: swapCardinality(data.cardinality),
        },
      });
    },
    [host, data],
  );

  // This edge's part in the hover preview / flowing focus. A primitive, so an
  // edge outside the focus never re-renders when the focus moves elsewhere.
  const focusRole = useEditorStoreOr((s) => edgeFocusRole(s.flowFocus, s.hoverFocus, id), null);
  // This line's route from the one-pass router (EdgeRouter), if any. Without
  // one (a self-loop, routing off or held during a drag) the smooth-step
  // fallback below is drawn.
  const storedRoute = useEditorStoreOr((s) => s.edgeRoutes?.get(id), undefined);

  if (!data) return null;
  const { cardinality, role, stage, discrepancyStatus, dimmed, readOnly, isSelfLoop, fromColumn, toColumn } = data;
  // A self-loop always draws its own loop.
  const route = isSelfLoop ? undefined : storedRoute;
  const loopRadius = SELF_LOOP_RADIUS + SELF_LOOP_STEP * (data.loopIndex ?? 0);

  // For cardinality mismatch edges, pull the mismatch details from the report
  // The edge data only has status — we need to find the original relationship discrepancy
  // to get both cardinalities. For now, we show a visual indicator on the edge itself.

  // Calculate distribution offsets to spread multiple edges along node sides
  let adjustedSourceX = sourceX;
  let adjustedSourceY = sourceY;
  let adjustedTargetX = targetX;
  let adjustedTargetY = targetY;

  if (sourceSide) {
    const sideLength = getSideLength(sourceSide, sourceNode?.measured);
    const sourceOffset = calculateEdgeOffsetInGroup(
      id,
      fromModel,
      sourceSide,
      sourceGroup,
      sideLength,
      nodePositions,
    );
    adjustedSourceX += sourceOffset.x;
    adjustedSourceY += sourceOffset.y;
  }

  if (targetSide) {
    const sideLength = getSideLength(targetSide, targetNode?.measured);
    const targetOffset = calculateEdgeOffsetInGroup(
      id,
      toModel,
      targetSide,
      targetGroup,
      sideLength,
      nodePositions,
    );
    adjustedTargetX += targetOffset.x;
    adjustedTargetY += targetOffset.y;
  }

  // Shorten the path so the line stops before the node, leaving room
  // for the cardinality label in the gap.
  const src = offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, PATH_GAP);
  const tgt = offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, PATH_GAP);

  // Self-refs use a cubic bezier arcing outward past the top-right corner.
  // Both control points are pulled diagonally north-east so the curve sweeps
  // *around* the corner instead of sagging through it — perpendicular-only
  // control points let the midsection collapse onto the node corner.
  const fallbackPath = isSelfLoop
    ? `M ${src.x},${src.y} C ${src.x + loopRadius},${src.y - loopRadius} ${tgt.x + loopRadius},${tgt.y - loopRadius} ${tgt.x},${tgt.y}`
    : getSmoothStepPath({
        sourceX: src.x,
        sourceY: src.y,
        targetX: tgt.x,
        targetY: tgt.y,
        sourcePosition,
        targetPosition,
        borderRadius: 8,
      })[0];
  const edgePath = route ? route.d : fallbackPath;
  // The halo style: the visible line (and its casing) is broken where it
  // passes under another, so the line on top is the same whatever order the
  // edges are drawn in; EdgeFlow and the hit area keep the whole path.
  const strokePath = route?.strokeD ?? edgePath;

  const statusKey = discrepancyStatus
    ? `discrepancy-${discrepancyStatus}`
    : (stage ?? 'logical');
  const statusClass = `fk-edge--${statusKey}`;

  // Flow: on the focused table's lines, unless the line is `missing` here or
  // one of its tables is being dragged (the path moves every frame).
  const flowing = focusRole === 'flow' || focusRole === 'flow-static';
  // Every focused line is marked lit. The lit rules only apply under the root
  // `erd-flow--hover-focus` class, so a click-only flow looks as before (its
  // lines are already bright through `dimmed`), and no edge has to subscribe
  // to whether a hover is active.
  const lit = focusRole !== null;
  const flowMode = flowing ? flowModeFor(cardinality, discrepancyStatus) : null;
  const showFlow = flowMode !== null && !(sourceNode?.dragging || targetNode?.dragging);
  const focusClass = `${lit ? ' fk-edge--lit' : ''}${flowing ? ' fk-edge--flowing' : ''}`;
  // Labels, chips and badges in the HTML layer fade with the hover preview too.
  const adornClass = ` fk-edge__adornment${lit ? ' fk-edge__adornment--lit' : ''}`;

  const edgeTitle = edgeHoverText({
    fromModel, fromColumn, toModel, toColumn, cardinality, role, discrepancyStatus, pairs: data.pairs,
  });
  const compositeSize = data.pairs && data.pairs.length > 1 ? data.pairs.length : 0;
  // Cardinality labels at each end:
  // - many-to-one: * at source, 1 at target
  // - one-to-one: 1 at both ends
  // - one-to-many: 1 at source, * at target
  // - many-to-many: * at both ends
  let sourceLabel: string;
  let targetLabel: string;
  switch (cardinality) {
    case 'many-to-one':
      sourceLabel = '*';
      targetLabel = '1';
      break;
    case 'one-to-one':
      sourceLabel = '1';
      targetLabel = '1';
      break;
    case 'one-to-many':
      sourceLabel = '1';
      targetLabel = '*';
      break;
    case 'many-to-many':
      sourceLabel = '*';
      targetLabel = '*';
      break;
    default:
      sourceLabel = '*';
      targetLabel = '1';
  }
  const srcLabelClass = sourceLabel === '*' ? ' fk-edge__label--many' : '';
  const tgtLabelClass = targetLabel === '*' ? ' fk-edge__label--many' : '';

  // Use discrepancy colour for labels when edge has a discrepancy status
  const labelColorClass = discrepancyStatus
    ? `fk-edge__label--discrepancy-${discrepancyStatus}`
    : `fk-edge__label--${stage ?? 'logical'}`;

  // Labels sit close to the node, in the gap before the shortened path.
  // Use adjusted coordinates so labels align with distributed connection points.
  const srcLabel = route
    ? offsetPoint(route.sourceAnchor.x, route.sourceAnchor.y, sidePosition(route.sourceAnchor.side), LABEL_OFFSET)
    : offsetPoint(adjustedSourceX, adjustedSourceY, sourcePosition, LABEL_OFFSET);
  const tgtLabel = route
    ? offsetPoint(route.targetAnchor.x, route.targetAnchor.y, sidePosition(route.targetAnchor.side), LABEL_OFFSET)
    : offsetPoint(adjustedTargetX, adjustedTargetY, targetPosition, LABEL_OFFSET);

  // Midpoint for cardinality mismatch badge / swap button.
  // For self-loops the straight midpoint falls inside the node; instead we
  // compute the bezier's exact midpoint at t=0.5, which sits northeast of
  // the top-right corner. (Derived from B(0.5) with diagonal control points:
  // the R terms aggregate to 0.75·R along each axis.)
  const midX = route
    ? route.mid.x
    : isSelfLoop
    ? (src.x + tgt.x) / 2 + loopRadius * 0.75
    : (adjustedSourceX + adjustedTargetX) / 2;
  const midY = route
    ? route.mid.y
    : isSelfLoop
    ? (src.y + tgt.y) / 2 - loopRadius * 0.75
    : (adjustedSourceY + adjustedTargetY) / 2;

  return (
    <>
      {route?.halo && <path d={strokePath} className={`fk-edge__halo${dimmed ? ' fk-edge--dimmed' : ''}`} />}
      <path
        id={id}
        d={strokePath}
        className={`fk-edge ${statusClass}${dimmed ? ' fk-edge--dimmed' : ''}${focusClass}`}
      />
      {showFlow && flowMode && (
        <EdgeFlow
          d={edgePath}
          mode={flowMode}
          animate={focusRole === 'flow'}
          statusKey={statusKey}
        />
      )}
      {/* Invisible wider path for easier hover/click targeting. It also carries
          the edge's only hover text: the `*`/`1` glyphs are pointer-events:none
          so the line is the one part of an edge that can hold a <title>. */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ pointerEvents: 'stroke' }}
      >
        <title>{edgeTitle}</title>
      </path>
      <EdgeLabelRenderer>
        <span
          className={`fk-edge__label ${labelColorClass}${srcLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}${adornClass}`}
          style={{
            transform: `translate(-50%, -50%) translate(${srcLabel.x}px, ${srcLabel.y}px)`,
          }}
        >
          {sourceLabel}
        </span>
        <span
          className={`fk-edge__label ${labelColorClass}${tgtLabelClass}${dimmed ? ' fk-edge__label--dimmed' : ''}${adornClass}`}
          style={{
            transform: `translate(-50%, -50%) translate(${tgtLabel.x}px, ${tgtLabel.y}px)`,
          }}
        >
          {targetLabel}
        </span>
        {role && (
          <span
            className={`fk-edge__role ${labelColorClass}${dimmed ? ' fk-edge__label--dimmed' : ''}${adornClass}`}
            style={{
              transform: `translate(-50%, calc(-100% - 10px)) translate(${midX}px, ${midY}px)`,
            }}
          >
            {role}
          </span>
        )}
        {compositeSize > 0 && (
          <span
            className={`fk-edge__composite ${labelColorClass}${dimmed ? ' fk-edge__label--dimmed' : ''}${adornClass}`}
            style={{
              transform: `translate(-50%, calc(100% + 6px)) translate(${midX}px, ${midY}px)`,
            }}
            title={`Composite foreign key: ${compositeSize} column pairs`}
          >
            ⧉ {compositeSize}
          </span>
        )}
        {discrepancyStatus === 'cardinality-mismatch' && (
          <span
            className={`fk-edge__mismatch-badge${adornClass}`}
            style={{
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
            }}
            title="Cardinality differs between stages"
          >
            !
          </span>
        )}
        {viewer ? null : (data.keysContradict && !readOnly && discrepancyStatus !== 'missing' && (
          <span
            className={`fk-edge__backwards${dimmed ? ' fk-edge__backwards--dimmed' : ''}${adornClass}`}
            // On the midpoint, in place of the ⇄ zone (Turn round is ⇄): the icon
            // is centred on the line and Turn round opens to its right, clear of
            // the role above and the composite chip below.
            style={{
              transform: `translate(-9px, -50%) translate(${midX}px, ${midY}px)`,
            }}
            onMouseEnter={(e) => { e.stopPropagation(); setBackwardsHovered(true); }}
            onMouseLeave={(e) => { e.stopPropagation(); setBackwardsHovered(false); }}
          >
            <span
              className="fk-edge__backwards-icon"
              role="img"
              aria-label="Probably drawn backwards"
              title={backwardsRelationshipNote(data, data.pairs ?? [{ fromColumn, toColumn }])}
            >
              &#x26A0;
            </span>
            {backwardsHovered && (
              // Turn round is ⇄: a backwards many-to-one becomes the one-to-many it
              // reads as, which the host stores the right way round (#163).
              <button className="fk-edge__backwards-btn" onClick={handleSwap} title="Turn this relationship round">
                Turn round
              </button>
            )}
          </span>
        ))}
        {!readOnly && discrepancyStatus !== 'missing' && !(data.keysContradict && !viewer) && (
          <span
            className={`fk-edge__swap-zone${dimmed ? ' fk-edge__swap-zone--dimmed' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)`,
            }}
            onMouseEnter={(e) => { e.stopPropagation(); setHovered(true); }}
            onMouseLeave={(e) => { e.stopPropagation(); setHovered(false); }}
          >
            {hovered && (
              <button
                className="fk-edge__swap-btn"
                onClick={handleSwap}
                title={`Swap cardinality (${cardinality} → ${swapCardinality(cardinality)})`}
                aria-label="Swap cardinality direction"
              >
                &#x21c4;
              </button>
            )}
          </span>
        )}
      </EdgeLabelRenderer>
    </>
  );
}

export const FkEdge = memo(FkEdgeComponent);
