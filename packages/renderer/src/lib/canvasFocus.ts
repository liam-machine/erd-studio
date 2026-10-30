/**
 * Canvas focus — which tables and relationship lines stay bright, and which
 * lines carry the moving direction arrows, for a focused table or line.
 *
 * One connectivity rule shared by click dimming (`applyNodeOverlays`) and the
 * hover preview (`useHoverFocus`), so the two can never disagree about what
 * "related" means:
 *
 *   - A table: the table plus every table one FK line away. A line stays bright
 *     when both its ends are bright (so a line between two neighbours does too).
 *     The hover preview passes `ownLinesOnly`: it answers "what does this
 *     table connect to", so only the table's own lines stay bright there.
 *   - A line: its two end tables, and only that line.
 *
 * `flowEdges` are the lines that animate: the focused table's own lines (or
 * the focused line), minus any drawn as `missing` in a comparison, because
 * motion would claim a relationship that does not exist here.
 *
 * Pure: no React, no DOM. The result is immutable by convention, and
 * `sameFocus` compares two by value so store writes can be skipped when a
 * recompute produced the same answer.
 */

import type { FkFlowEdge } from '../types/graph';
import type { GraphEdge } from './nodeOverlays';

/** Above this many flowing lines, arrows stand still (a static direction cue). */
export const FLOW_ANIMATION_LIMIT = 40;

export interface CanvasFocus {
  /** Table driving the focus (null for a line focus). */
  readonly node: string | null;
  /** FK line driving the focus (null for a table focus). */
  readonly edge: string | null;
  /** Bright tables: the table and its FK neighbours, or the line's two ends. */
  readonly nodes: ReadonlySet<string>;
  /** Bright FK lines: both ends in `nodes` (or, `ownLinesOnly`, touching `node`), or just the focused line. */
  readonly edges: ReadonlySet<string>;
  /** Lines that carry direction arrows: those touching `node`, or the focused line; never `missing` ones. */
  readonly flowEdges: ReadonlySet<string>;
  /** Whether the arrows move (`flowEdges.size <= FLOW_ANIMATION_LIMIT`). */
  readonly animate: boolean;
}

export interface CanvasFocusTarget {
  node?: string | null;
  edge?: string | null;
}

export interface CanvasFocusOptions {
  /** A table focus keeps only the table's own lines bright, not lines between its neighbours. */
  ownLinesOnly?: boolean;
}

function fkData(edge: GraphEdge): FkFlowEdge['data'] | undefined {
  return edge.type === 'fk' ? (edge.data as FkFlowEdge['data']) : undefined;
}

/**
 * The focus for a table (`target.node`) or an FK line (`target.edge`); a table
 * wins when both are given. Returns null when there is no target, the line is
 * unknown or an annotation link, or (when `nodeIds` is given) the table is not
 * one of them.
 */
export function computeCanvasFocus(
  edges: readonly GraphEdge[],
  target: CanvasFocusTarget,
  nodeIds?: ReadonlySet<string>,
  options?: CanvasFocusOptions,
): CanvasFocus | null {
  const node = target.node ?? null;
  if (node !== null) {
    if (nodeIds && !nodeIds.has(node)) return null;
    const nodes = new Set<string>([node]);
    const own = new Set<string>();
    const flowEdges = new Set<string>();
    for (const edge of edges) {
      const fk = fkData(edge);
      if (!fk) continue;
      if (fk.fromModel !== node && fk.toModel !== node) continue;
      nodes.add(fk.fromModel);
      nodes.add(fk.toModel);
      own.add(edge.id);
      if (fk.discrepancyStatus !== 'missing') flowEdges.add(edge.id);
    }
    let bright = own;
    if (!options?.ownLinesOnly) {
      bright = new Set<string>();
      for (const edge of edges) {
        const fk = fkData(edge);
        if (fk && nodes.has(fk.fromModel) && nodes.has(fk.toModel)) bright.add(edge.id);
      }
    }
    return {
      node,
      edge: null,
      nodes,
      edges: bright,
      flowEdges,
      animate: flowEdges.size <= FLOW_ANIMATION_LIMIT,
    };
  }

  const edgeId = target.edge ?? null;
  if (edgeId === null) return null;
  const edge = edges.find((e) => e.id === edgeId);
  const fk = edge ? fkData(edge) : undefined;
  if (!fk) return null;
  const flowEdges = new Set<string>(fk.discrepancyStatus === 'missing' ? [] : [edgeId]);
  return {
    node: null,
    edge: edgeId,
    nodes: new Set([fk.fromModel, fk.toModel]),
    edges: new Set([edgeId]),
    flowEdges,
    animate: flowEdges.size <= FLOW_ANIMATION_LIMIT,
  };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** Value equality: driver, `animate`, then each set's size and members. */
export function sameFocus(a: CanvasFocus | null, b: CanvasFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.node === b.node &&
    a.edge === b.edge &&
    a.animate === b.animate &&
    a.nodes.size === b.nodes.size &&
    a.edges.size === b.edges.size &&
    a.flowEdges.size === b.flowEdges.size &&
    sameSet(a.nodes, b.nodes) &&
    sameSet(a.edges, b.edges) &&
    sameSet(a.flowEdges, b.flowEdges)
  );
}

/** A table's part in a focus: the table driving it, one related to it, or neither. */
export function tableFocusRole(
  focus: CanvasFocus | null | undefined,
  id: string,
): 'origin' | 'related' | null {
  if (!focus) return null;
  if (focus.node === id) return 'origin';
  return focus.nodes.has(id) ? 'related' : null;
}

/**
 * An FK line's part in the current focus:
 *   - `'flow'`: carries moving arrows (`flowFocus`).
 *   - `'flow-static'`: carries arrows that stand still (too many lines flowing).
 *   - `'lit'`: kept bright by the hover preview, no arrows.
 *   - null: none of these.
 */
export function edgeFocusRole(
  flow: CanvasFocus | null | undefined,
  hover: CanvasFocus | null | undefined,
  id: string,
): 'flow' | 'flow-static' | 'lit' | null {
  if (flow && flow.flowEdges.has(id)) return flow.animate ? 'flow' : 'flow-static';
  if (hover && hover.edges.has(id)) return 'lit';
  return null;
}
