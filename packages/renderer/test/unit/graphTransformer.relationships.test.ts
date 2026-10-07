/**
 * graphTransformer and relationships (#133): an endpoint that differs from its
 * node only in case is still drawn (D3), the edge carries the logical stage's
 * provenance (stored ends, source, issues) for the canvas's edits and badge,
 * and a physical / provenance-free payload produces exactly the edge data it
 * always did.
 */
import { describe, expect, it } from 'vitest';

import { nodeIdResolver, transformDomain } from '../../src/lib/graphTransformer';
import type { DisplayDomain, DisplayModel, DisplayRelationship } from '@erd-studio/core';
import type { FkFlowEdge } from '../../src/types/graph';

function model(name: string, columns: string[]): DisplayModel {
  return {
    name, schema: 'silver', description: '',
    columns: columns.map((c, i) => ({ name: c, dataType: 'string', description: '', isPrimaryKey: i === 0, isForeignKey: false, isNaturalKey: false })),
  };
}

function domain(relationships: DisplayRelationship[], overrides: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 5, domain: 'orders', layer: 'silver', stage: 'logical', description: '',
    models: [model('fct_order', ['order_key', 'customer_key']), model('dim_customer', ['customer_key'])],
    relationships, viewConfig: {}, readOnly: false, positionDraggable: true,
    ...overrides,
  } as DisplayDomain;
}

const fkEdges = (d: DisplayDomain) => transformDomain(d).edges.filter((e) => e.type === 'fk') as FkFlowEdge[];

describe('nodeIdResolver', () => {
  it('prefers the exact id, then the single id equal without case', () => {
    const resolve = nodeIdResolver(['fct_order', 'Dim_Customer']);
    expect(resolve('fct_order')).toBe('fct_order');
    expect(resolve('FCT_ORDER')).toBe('fct_order');
    expect(resolve('dim_customer')).toBe('Dim_Customer');
    expect(resolve('nope')).toBeUndefined();
  });
  it('never guesses between two ids that differ only in case', () => {
    const resolve = nodeIdResolver(['orders', 'Orders']);
    expect(resolve('orders')).toBe('orders');
    expect(resolve('Orders')).toBe('Orders');
    expect(resolve('ORDERS')).toBeUndefined();
  });
});

describe('transformDomain relationship edges (#133)', () => {
  it('marks an edge with issues on an older-format (v4) diagram, so its badge points at the migration', () => {
    const rel: DisplayRelationship = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', issues: ['REL001'] };
    expect(fkEdges(domain([rel], { schemaVersion: 4 }))[0].data!.olderFormat).toBe(true);
    expect(fkEdges(domain([rel]))[0].data!.olderFormat).toBeUndefined();
    expect(fkEdges(domain([{ ...rel, issues: undefined }], { schemaVersion: 4 }))[0].data!.olderFormat).toBeUndefined();
  });
  it('draws a relationship whose model names differ from the nodes only in case (D3)', () => {
    const edges = fkEdges(domain([
      { fromModel: 'FCT_ORDER', fromColumn: 'customer_key', toModel: 'Dim_Customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]));
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe('fct_order');
    expect(edges[0].target).toBe('dim_customer');
    expect(edges[0].data!.fromModel).toBe('fct_order');
    expect(edges[0].data!.toModel).toBe('dim_customer');
    // The edge id keeps the relationship's own spelling (selection maps it back).
    expect(edges[0].id).toBe('fk-FCT_ORDER-customer_key-Dim_Customer-customer_key');
  });

  it('still drops a relationship whose model is not on the canvas', () => {
    expect(fkEdges(domain([
      { fromModel: 'fct_sale', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]))).toHaveLength(0);
  });

  it('passes the stored ends, source and issues through to the edge data', () => {
    const stored = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' };
    const [edge] = fkEdges(domain([
      {
        fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
        cardinality: 'many-to-one', stored, source: { kind: 'library', model: 'dim_customer', index: 0 }, issues: ['REL002'],
      },
    ]));
    expect(edge.data!.stored).toEqual(stored);
    expect(edge.data!.source).toEqual({ kind: 'library', model: 'dim_customer', index: 0 });
    expect(edge.data!.issues).toEqual(['REL002']);
  });

  it('adds nothing for a payload without provenance (physical stage unchanged)', () => {
    const [edge] = fkEdges(domain([
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ], { stage: 'physical', readOnly: true }));
    expect(edge.data).toEqual({
      fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
      cardinality: 'many-to-one', stage: 'physical', readOnly: true,
    });
  });

  it('an empty issues list adds no issues field', () => {
    const [edge] = fkEdges(domain([
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', issues: [] },
    ]));
    expect(edge.data).not.toHaveProperty('issues');
  });
});
