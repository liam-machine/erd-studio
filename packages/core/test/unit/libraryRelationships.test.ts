import { describe, it, expect, vi } from 'vitest';

import { buildUnifiedSubjectArea, mergeLibraryRelationships, relationshipKey } from '../../src/domain';
import { parseTableText } from '../../src/logicalModel';
import type { Relationship, SemanticTable } from '../../src/types/semantic';

/** fct_order's file says it points at dim_customer and dim_product. */
const FCT_ORDER: SemanticTable = {
  name: 'fct_order',
  columns: [],
  relationships: [
    { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    { fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'many-to-one' },
  ],
};
const LIBRARY: Record<string, SemanticTable> = {
  fct_order: FCT_ORDER,
  dim_customer: { name: 'dim_customer', columns: [] },
  dim_product: { name: 'dim_product', columns: [] },
};

const TO_CUSTOMER: Relationship = {
  fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one',
};
const TO_PRODUCT: Relationship = {
  fromModel: 'fct_order', fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'many-to-one',
};

function relationshipsOf(models: string[], own: Relationship[] = [], warn = vi.fn()): Relationship[] {
  const doc = { schemaVersion: 5, domain: 'd', layer: 'silver', logical: { models, relationships: own }, viewConfig: {} };
  return buildUnifiedSubjectArea(doc, 'v5', {
    filePath: 'silver/d.json',
    domainNameFallback: 'd',
    parentDirName: 'silver',
    layers: { hasLayer: () => true, getValidLayerIds: () => ['silver'] },
    getModel: (name) => structuredClone(LIBRARY[name] ?? null),
    warn,
  }).logical.relationships;
}

describe('a relationship stored in a model file (#126)', () => {
  it.each([
    [['fct_order', 'dim_customer'], [TO_CUSTOMER]],
    [['fct_order', 'dim_customer', 'dim_product'], [TO_CUSTOMER, TO_PRODUCT]],
    [['fct_order'], []],
    [['dim_customer', 'dim_product'], []],
  ])('is drawn only by a domain holding both ends: %j', (models, expected) => {
    expect(relationshipsOf(models)).toEqual(expected);
  });

  it('is drawn once next to the same relationship in the domain file, with the library cardinality, and says so', () => {
    const warn = vi.fn();
    const own = [{ ...TO_CUSTOMER, cardinality: 'one-to-one' as const }];
    expect(relationshipsOf(['fct_order', 'dim_customer'], own, warn)).toEqual([TO_CUSTOMER]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/the table library defines it as many-to-one/));
  });

  it('keeps the domain file\'s own relationships first and in order', () => {
    const own: Relationship = { fromModel: 'dim_product', fromColumn: 'x', toModel: 'dim_customer', toColumn: 'y', cardinality: 'one-to-many' };
    expect(relationshipsOf(['fct_order', 'dim_customer', 'dim_product'], [own])).toEqual([own, TO_CUSTOMER, TO_PRODUCT]);
  });

  it('leaves a domain with no library relationships as its file says, drawing a link it holds twice once', () => {
    const own = [TO_CUSTOMER, TO_PRODUCT, { ...TO_CUSTOMER, cardinality: 'one-to-one' as const }];
    expect(mergeLibraryRelationships([{ name: 'fct_order', columns: [] }], own)).toEqual([TO_CUSTOMER, TO_PRODUCT]);
    expect(mergeLibraryRelationships([{ name: 'fct_order', columns: [] }], [...own].reverse())).toEqual([TO_CUSTOMER, TO_PRODUCT]);
  });

  it('matches endpoints without case', () => {
    expect(relationshipKey(TO_CUSTOMER)).toBe(relationshipKey({ ...TO_CUSTOMER, fromColumn: 'Customer_Key' }));
  });
});

describe('parseTableText relationships', () => {
  it('reads the list, skipping entries without three endpoints and defaulting an unknown cardinality', () => {
    const model = parseTableText([
      'name: fct_order',
      'relationships:',
      '  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: one-to-one }',
      '  - { fromColumn: product_key, toModel: dim_product, toColumn: product_key, cardinality: sideways }',
      '  - { fromColumn: broken, toModel: dim_x }',
      '  - just a string',
    ].join('\n'), 'fct_order');
    expect(model?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' },
      { fromColumn: 'product_key', toModel: 'dim_product', toColumn: 'product_key', cardinality: 'many-to-one' },
    ]);
  });

  it('leaves the field off a model without relationships', () => {
    expect(parseTableText('name: dim_customer\n', 'dim_customer')).not.toHaveProperty('relationships');
  });
});
