/**
 * Edge sides re-picked for moved nodes: the same choice transformDomain makes
 * when the moved positions come back in the domain.
 */
import { describe, it, expect } from 'vitest';
import type { DisplayDomain, DisplayModel } from '@erd-studio/core';
import { nodeRect, repickHandleSides } from '../../src/lib/dragHandleSides';
import { transformDomain } from '../../src/lib/graphTransformer';
import { resolveNodeDimensions } from '../../src/lib/nodeSizing';
import type { GraphEdge, GraphNode } from '../../src/lib/nodeOverlays';
import type { AnnotationFlowNode, ModelFlowNode } from '../../src/types/graph';

function model(name: string, columnCount = 3): DisplayModel {
  return {
    name,
    schema: 'sales',
    description: '',
    columns: Array.from({ length: columnCount }, (_, i) => ({
      name: `${name}_c${i}`,
      dataType: 'bigint',
      description: '',
      isPrimaryKey: i === 0,
      isForeignKey: false,
      isNaturalKey: false,
    })),
  };
}

function domainWith(positions: Record<string, { x: number; y: number }>): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [model('orders', 8), model('customers', 2), model('products', 4)],
    relationships: [
      { fromModel: 'orders', fromColumn: 'orders_c1', toModel: 'customers', toColumn: 'customers_c0', cardinality: 'many-to-one' },
      { fromModel: 'orders', fromColumn: 'orders_c2', toModel: 'products', toColumn: 'products_c0', cardinality: 'many-to-one' },
      { fromModel: 'customers', fromColumn: 'customers_c1', toModel: 'customers', toColumn: 'customers_c0', cardinality: 'many-to-one' },
    ],
    viewConfig: {
      positions,
      annotations: [
        { id: 'n1', text: 'note', x: -400, y: 0, linkedModel: 'orders' },
        { id: 'n2', text: 'sized', x: 0, y: 900, width: 300, height: 200, linkedModel: 'products' },
      ],
    },
    readOnly: true,
    positionDraggable: true,
  };
}

const START = {
  orders: { x: 0, y: 0 },
  customers: { x: 600, y: 0 },
  products: { x: 0, y: 500 },
};

/** Move nodes the way React Flow does: a new position on the same node. */
function moveNodes(nodes: GraphNode[], moves: Record<string, { x: number; y: number }>): GraphNode[] {
  return nodes.map((n) => (moves[n.id] ? ({ ...n, position: moves[n.id] } as GraphNode) : n));
}

function handles(edges: GraphEdge[]) {
  return Object.fromEntries(edges.map((e) => [e.id, [e.sourceHandle, e.targetHandle]]));
}

describe('nodeRect', () => {
  it('uses the measured size when React Flow has measured the node', () => {
    const { nodes } = transformDomain(domainWith(START));
    const orders = { ...nodes[0], measured: { width: 311, height: 222 } } as GraphNode;
    expect(nodeRect(orders)).toEqual({ x: 0, y: 0, width: 311, height: 222 });
  });

  it('falls back to the model-node size estimate', () => {
    const { nodes } = transformDomain(domainWith(START));
    const customers = nodes.find((n) => n.id === 'customers') as ModelFlowNode;
    expect(nodeRect(customers)).toEqual({
      x: 600,
      y: 0,
      ...resolveNodeDimensions({ data: customers.data, measured: undefined }),
    });
  });

  it('ignores a half-measured node', () => {
    const { nodes } = transformDomain(domainWith(START));
    const customers = { ...nodes[1], measured: { width: 999 } } as GraphNode;
    expect(nodeRect(customers).width).not.toBe(999);
  });

  it('uses an annotation’s own size, else its default size', () => {
    const { nodes } = transformDomain(domainWith(START));
    const plain = nodes.find((n) => n.id === 'annotation-n1') as AnnotationFlowNode;
    const sized = nodes.find((n) => n.id === 'annotation-n2') as AnnotationFlowNode;
    expect(nodeRect(plain)).toEqual({ x: -400, y: 0, width: 160, height: 80 });
    expect(nodeRect(sized)).toEqual({ x: 0, y: 900, width: 300, height: 200 });
  });
});

describe('repickHandleSides', () => {
  it('returns the same array when nothing moved', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    expect(repickHandleSides(nodes, edges, new Set())).toBe(edges);
  });

  it('returns the same array when a move changes no side', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    const moved = moveNodes(nodes, { customers: { x: 650, y: 10 } });
    expect(repickHandleSides(moved, edges, new Set(['customers']))).toBe(edges);
  });

  it('flips the sides of the edges on a node moved to the other side', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    expect(handles(edges)['fk-orders-orders_c1-customers-customers_c0']).toEqual(['node-right-src', 'node-left-tgt']);

    const moved = moveNodes(nodes, { customers: { x: -900, y: 0 } });
    const next = repickHandleSides(moved, edges, new Set(['customers']));

    expect(next).not.toBe(edges);
    expect(handles(next)['fk-orders-orders_c1-customers-customers_c0']).toEqual(['node-left-src', 'node-right-tgt']);
    // Edges that touch no moved node keep their identity.
    const untouched = edges.findIndex((e) => e.id === 'fk-orders-orders_c2-products-products_c0');
    expect(next[untouched]).toBe(edges[untouched]);
  });

  it('keeps a self-referencing edge on its fixed top/right handles', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    const moved = moveNodes(nodes, { customers: { x: -900, y: 3000 } });
    const next = repickHandleSides(moved, edges, new Set(['customers']));
    const selfLoop = next.find((e) => e.id === 'fk-customers-customers_c1-customers-customers_c0')!;
    expect([selfLoop.sourceHandle, selfLoop.targetHandle]).toEqual(['node-top-src', 'node-right-tgt']);
  });

  it('re-picks annotation link edges when the note moves', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    expect(handles(edges)['ann-link-n1']).toEqual(['node-right-src', 'node-left-tgt']);
    const moved = moveNodes(nodes, { 'annotation-n1': { x: 0, y: -900 } });
    const next = repickHandleSides(moved, edges, new Set(['annotation-n1']));
    expect(handles(next)['ann-link-n1']).toEqual(['node-bottom-src', 'node-top-tgt']);
  });

  it('leaves an edge alone when one of its nodes is missing', () => {
    const { nodes, edges } = transformDomain(domainWith(START));
    const withoutCustomers = moveNodes(nodes, { orders: { x: 2000, y: 0 } }).filter((n) => n.id !== 'customers');
    const next = repickHandleSides(withoutCustomers, edges, new Set(['orders']));
    const edge = next.find((e) => e.id === 'fk-orders-orders_c1-customers-customers_c0')!;
    expect([edge.sourceHandle, edge.targetHandle]).toEqual(['node-right-src', 'node-left-tgt']);
  });

  it('gives the sides transformDomain gives once the moves are saved in the domain', () => {
    const moves = {
      orders: { x: 900, y: 700 },
      products: { x: -500, y: -300 },
      'annotation-n2': { x: 1500, y: -200 },
    };
    const { nodes, edges } = transformDomain(domainWith(START));
    const live = repickHandleSides(moveNodes(nodes, moves), edges, new Set(Object.keys(moves)));

    const saved = domainWith({ ...START, orders: moves.orders, products: moves.products });
    saved.viewConfig.annotations = saved.viewConfig.annotations!.map((a) =>
      a.id === 'n2' ? { ...a, ...moves['annotation-n2'] } : a,
    );
    expect(handles(live)).toEqual(handles(transformDomain(saved).edges));
  });

  it('matches transformDomain with measured sizes too', () => {
    const measured = { width: 280, height: 400 };
    const moves = { customers: { x: 100, y: 600 } };
    const { nodes, edges } = transformDomain(domainWith(START));
    const measuredNodes = nodes.map((n) => ({ ...n, measured }) as GraphNode);
    const live = repickHandleSides(moveNodes(measuredNodes, moves), edges, new Set(['customers']));

    const nodeDimensions = new Map(nodes.map((n) => [n.id, measured]));
    const expected = transformDomain(domainWith({ ...START, ...moves }), { nodeDimensions }).edges;
    expect(handles(live)).toEqual(handles(expected));
  });
});
