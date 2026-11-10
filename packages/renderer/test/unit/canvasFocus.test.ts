/**
 * computeCanvasFocus is the one connectivity rule behind both click dimming
 * and the hover preview: a table and its FK neighbours, or a line's two ends;
 * which lines carry the moving arrows; and when the arrows stand still.
 */
import { describe, it, expect } from 'vitest';
import {
  computeCanvasFocus,
  sameFocus,
  tableFocusRole,
  edgeFocusRole,
  FLOW_ANIMATION_LIMIT,
  type CanvasFocus,
} from '../../src/lib/canvasFocus';
import type { GraphEdge } from '../../src/lib/nodeOverlays';
import type { FkEdgeData } from '../../src/types/graph';

function fk(id: string, from: string, to: string, extra: Partial<FkEdgeData> = {}): GraphEdge {
  return {
    id, source: from, target: to, type: 'fk',
    data: { fromModel: from, fromColumn: `${to}_id`, toModel: to, toColumn: `${to}_id`, cardinality: 'many-to-one', ...extra },
  } as GraphEdge;
}

function annotationLink(id: string, from: string, to: string): GraphEdge {
  return { id, source: from, target: to, type: 'annotationLink', data: {} } as unknown as GraphEdge;
}

// orders → customers, orders → products, products → customers (between two
// neighbours of orders), returns → orders, suppliers → products (2 hops).
const EDGES: GraphEdge[] = [
  fk('o-c', 'orders', 'customers'),
  fk('o-p', 'orders', 'products'),
  fk('p-c', 'products', 'customers'),
  fk('r-o', 'returns', 'orders'),
  fk('s-p', 'suppliers', 'products'),
  annotationLink('note-o', 'note1', 'orders'),
];

describe('computeCanvasFocus — a table', () => {
  const focus = computeCanvasFocus(EDGES, { node: 'orders' })!;

  it('keeps the table and its FK neighbours bright', () => {
    expect([...focus.nodes].sort()).toEqual(['customers', 'orders', 'products', 'returns']);
    expect(focus.node).toBe('orders');
    expect(focus.edge).toBeNull();
  });

  it('keeps a line between two neighbours bright, but not one to a table two hops away', () => {
    expect(focus.edges.has('p-c')).toBe(true);
    expect(focus.edges.has('s-p')).toBe(false);
    expect(focus.edges.has('note-o')).toBe(false);
  });

  it('flows only on the lines that touch the table', () => {
    expect([...focus.flowEdges].sort()).toEqual(['o-c', 'o-p', 'r-o']);
    expect(focus.animate).toBe(true);
  });

  it('ownLinesOnly (the hover preview) lights only the table\'s own lines, missing ones included', () => {
    const edges = [...EDGES, fk('o-x', 'orders', 'customers', { discrepancyStatus: 'missing' })];
    const own = computeCanvasFocus(edges, { node: 'orders' }, undefined, { ownLinesOnly: true })!;
    expect([...own.nodes].sort()).toEqual(['customers', 'orders', 'products', 'returns']);
    expect([...own.edges].sort()).toEqual(['o-c', 'o-p', 'o-x', 'r-o']);
    expect(own.edges.has('p-c')).toBe(false);
    expect([...own.flowEdges].sort()).toEqual(['o-c', 'o-p', 'r-o']);
  });

  it('never flows on a line drawn as missing', () => {
    const edges = [fk('a-b', 'a', 'b', { discrepancyStatus: 'missing' }), fk('a-c', 'a', 'c', { discrepancyStatus: 'extra' })];
    const f = computeCanvasFocus(edges, { node: 'a' })!;
    expect([...f.flowEdges]).toEqual(['a-c']);
    expect(f.nodes.has('b')).toBe(true);
    expect(f.edges.has('a-b')).toBe(true);
  });

  it('handles a self-loop', () => {
    const f = computeCanvasFocus([fk('loop', 'emp', 'emp', { isSelfLoop: true })], { node: 'emp' })!;
    expect([...f.nodes]).toEqual(['emp']);
    expect([...f.edges]).toEqual(['loop']);
    expect([...f.flowEdges]).toEqual(['loop']);
  });

  it('a table with no lines is a focus of itself alone', () => {
    const f = computeCanvasFocus(EDGES, { node: 'lonely' })!;
    expect([...f.nodes]).toEqual(['lonely']);
    expect(f.edges.size).toBe(0);
    expect(f.flowEdges.size).toBe(0);
  });

  it(`stops animating above ${FLOW_ANIMATION_LIMIT} touching lines`, () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => fk(`e${i}`, `t${i}`, 'hub'));
    expect(computeCanvasFocus(many(FLOW_ANIMATION_LIMIT), { node: 'hub' })!.animate).toBe(true);
    const f = computeCanvasFocus(many(FLOW_ANIMATION_LIMIT + 1), { node: 'hub' })!;
    expect(f.flowEdges.size).toBe(41);
    expect(f.animate).toBe(false);
  });
});

describe('computeCanvasFocus — a line', () => {
  it('keeps both ends bright and only that line', () => {
    const f = computeCanvasFocus(EDGES, { edge: 'p-c' })!;
    expect([...f.nodes].sort()).toEqual(['customers', 'products']);
    expect([...f.edges]).toEqual(['p-c']);
    expect([...f.flowEdges]).toEqual(['p-c']);
    expect(f.node).toBeNull();
    expect(f.edge).toBe('p-c');
  });

  it('a table wins when both are given', () => {
    expect(computeCanvasFocus(EDGES, { node: 'orders', edge: 'p-c' })!.node).toBe('orders');
  });
});

describe('computeCanvasFocus — nothing to focus', () => {
  it('returns null for no target, an unknown line or an annotation link', () => {
    expect(computeCanvasFocus(EDGES, {})).toBeNull();
    expect(computeCanvasFocus(EDGES, { node: null, edge: null })).toBeNull();
    expect(computeCanvasFocus(EDGES, { edge: 'nope' })).toBeNull();
    expect(computeCanvasFocus(EDGES, { edge: 'note-o' })).toBeNull();
  });

  it('returns null for a table not among the given ids (an annotation, a removed table)', () => {
    const ids = new Set(['orders', 'customers']);
    expect(computeCanvasFocus(EDGES, { node: 'note1' }, ids)).toBeNull();
    expect(computeCanvasFocus(EDGES, { node: 'gone' }, ids)).toBeNull();
    expect(computeCanvasFocus(EDGES, { node: 'orders' }, ids)).not.toBeNull();
  });
});

describe('sameFocus', () => {
  const a = computeCanvasFocus(EDGES, { node: 'orders' })!;

  it('is true for equal sets, whatever their identity', () => {
    expect(sameFocus(a, computeCanvasFocus(EDGES, { node: 'orders' }))).toBe(true);
    expect(sameFocus(a, a)).toBe(true);
    expect(sameFocus(null, null)).toBe(true);
  });

  it('is false on any difference', () => {
    expect(sameFocus(a, null)).toBe(false);
    expect(sameFocus(null, a)).toBe(false);
    expect(sameFocus(a, { ...a, animate: false })).toBe(false);
    expect(sameFocus(a, { ...a, node: 'x' })).toBe(false);
    expect(sameFocus(a, { ...a, edge: 'x' })).toBe(false);
    const swapped = new Set(a.nodes);
    swapped.delete('returns');
    swapped.add('suppliers');
    expect(sameFocus(a, { ...a, nodes: swapped })).toBe(false);
    expect(sameFocus(a, { ...a, edges: new Set([...a.edges, 'zzz']) })).toBe(false);
    const flow = new Set(a.flowEdges);
    flow.delete('r-o');
    flow.add('s-p');
    expect(sameFocus(a, { ...a, flowEdges: flow })).toBe(false);
  });
});

describe('tableFocusRole / edgeFocusRole', () => {
  const hover = computeCanvasFocus(EDGES, { node: 'orders' })!;
  const still: CanvasFocus = { ...hover, animate: false };

  it('names the origin, a related table, or neither', () => {
    expect(tableFocusRole(hover, 'orders')).toBe('origin');
    expect(tableFocusRole(hover, 'customers')).toBe('related');
    expect(tableFocusRole(hover, 'suppliers')).toBeNull();
    expect(tableFocusRole(null, 'orders')).toBeNull();
    expect(tableFocusRole(undefined, 'orders')).toBeNull();
    // A line focus has no origin table: both ends are related.
    const line = computeCanvasFocus(EDGES, { edge: 'p-c' })!;
    expect(tableFocusRole(line, 'products')).toBe('related');
  });

  it('flow, flow-static, lit or nothing', () => {
    expect(edgeFocusRole(hover, hover, 'o-c')).toBe('flow');
    expect(edgeFocusRole(still, still, 'o-c')).toBe('flow-static');
    expect(edgeFocusRole(hover, hover, 'p-c')).toBe('lit');
    expect(edgeFocusRole(hover, hover, 's-p')).toBeNull();
    expect(edgeFocusRole(null, null, 'o-c')).toBeNull();
    expect(edgeFocusRole(undefined, undefined, 'o-c')).toBeNull();
    // A click flow with no hover: not lit, only flowing lines matter.
    expect(edgeFocusRole(hover, null, 'p-c')).toBeNull();
  });
});
