import { describe, it, expect } from 'vitest';

import { buildLogicalDisplayDomain } from '../../src/services/stageDisplay';
import type { SemanticDomain, SemanticModel } from '../../src/types/semantic';

function model(name: string, columns: Array<Record<string, unknown>>, extra: Partial<SemanticModel> = {}): SemanticModel {
  return { name, description: `${name} desc`, columns, ...extra } as unknown as SemanticModel;
}

function domain(overrides: Partial<SemanticDomain> = {}): SemanticDomain {
  return {
    schemaVersion: 5,
    domain: 'orders',
    layer: 'gold',
    stage: 'logical',
    description: 'Order domain',
    models: [
      model('fct_order', [
        { name: 'order_id', dataType: 'int', description: 'pk', isPrimaryKey: true },
        { name: 'customer_id', dataType: 'int', description: 'fk by relationship' },
        { name: 'legacy_ref', dataType: 'string', description: 'declared fk', isForeignKey: true },
        { name: 'amount', dataType: 'decimal', description: '', additiveType: 'additive' },
      ], { grain: 'one row per order', modelRole: 'fact' } as Partial<SemanticModel>),
      model('dim_customer', [
        { name: 'customer_id', dataType: 'int', description: '', isPrimaryKey: 'yes', isNaturalKey: 1, scdType: 2 },
      ]),
    ],
    relationships: [
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ],
    ...overrides,
  } as SemanticDomain;
}

describe('buildLogicalDisplayDomain', () => {
  it('derives isForeignKey from relationships and keeps declared FKs', () => {
    const out = buildLogicalDisplayDomain(domain(), {});
    const cols = out.models[0].columns;
    expect(cols.find((c) => c.name === 'customer_id')!.isForeignKey).toBe(true);
    expect(cols.find((c) => c.name === 'legacy_ref')!.isForeignKey).toBe(true);
    expect(cols.find((c) => c.name === 'order_id')!.isForeignKey).toBe(false);
    // The FK is only on the "from" side.
    expect(out.models[1].columns[0].isForeignKey).toBe(false);
  });

  it('coerces key flags with === true', () => {
    const out = buildLogicalDisplayDomain(domain(), {});
    expect(out.models[0].columns[0].isPrimaryKey).toBe(true);
    const cust = out.models[1].columns[0];
    expect(cust.isPrimaryKey).toBe(false); // 'yes' is not true
    expect(cust.isNaturalKey).toBe(false); // 1 is not true
    expect(cust.scdType).toBe(2);
  });

  it('carries optional model/column fields only when set', () => {
    const out = buildLogicalDisplayDomain(domain(), {});
    expect(out.models[0]).toMatchObject({ grain: 'one row per order', modelRole: 'fact', schema: '' });
    expect(out.models[1]).not.toHaveProperty('grain');
    expect(out.models[0].columns[3]).toMatchObject({ additiveType: 'additive' });
    expect(out.models[0].columns[0]).not.toHaveProperty('scdType');
  });

  it('builds the stage envelope with no canvas extras', () => {
    const viewConfig = { positions: { fct_order: { x: 1, y: 2 } } };
    const out = buildLogicalDisplayDomain(domain(), viewConfig as never);
    expect(out).toMatchObject({
      schemaVersion: 5, domain: 'orders', layer: 'gold', stage: 'logical',
      description: 'Order domain', readOnly: false, positionDraggable: true,
    });
    expect(out.viewConfig).toBe(viewConfig);
    expect(out.relationships).toEqual([
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
    expect(out.templates).toBeUndefined();
    expect(out.existingModels).toBeUndefined();
    expect(out.layerConfig).toBeUndefined();
  });

  it('includes stubColumns only when non-empty', () => {
    expect(buildLogicalDisplayDomain(domain(), {}, [])).not.toHaveProperty('stubColumns');
    expect(buildLogicalDisplayDomain(domain(), {}, ['dim_customer']).stubColumns).toEqual(['dim_customer']);
  });

  it('tolerates a model with no columns array', () => {
    const d = domain({ models: [{ name: 'bare' } as SemanticModel], relationships: [] });
    const out = buildLogicalDisplayDomain(d, {});
    expect(out.models[0]).toEqual({ name: 'bare', schema: '', description: '', columns: [] });
  });
});
