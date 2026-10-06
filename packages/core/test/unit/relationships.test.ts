import { describe, it, expect } from 'vitest';

import { relationshipKey } from '../../src/domain';
import { parseLogicalModelText } from '../../src/logicalModel';
import { canonicalRelationship, normaliseRelationshipRole, RELATIONSHIP_ROLE_MAX_LENGTH } from '../../src/relationships';
import type { Cardinality, Relationship } from '../../src/types/semantic';

const rel = (cardinality: Cardinality): Relationship => ({
  fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality,
});
const reversed = (r: Relationship): Relationship => ({
  ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn,
});

describe('canonicalRelationship — the many side owns a relationship (#133)', () => {
  it('turns a one-to-many round into a many-to-one from the other end, keeping its role', () => {
    expect(canonicalRelationship({ ...rel('one-to-many'), role: 'buyer' })).toEqual({
      fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
      cardinality: 'many-to-one', role: 'buyer',
    });
  });

  it.each(['many-to-one', 'one-to-one', 'many-to-many'] as const)('keeps a %s exactly as drawn', (cardinality) => {
    const drawn = rel(cardinality);
    expect(canonicalRelationship(drawn)).toBe(drawn);
  });

  it.each(['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'] as const)(
    'is idempotent and never yields one-to-many (%s)',
    (cardinality) => {
      const once = canonicalRelationship(rel(cardinality));
      expect(canonicalRelationship(once)).toEqual(once);
      expect(once.cardinality).not.toBe('one-to-many');
    },
  );

  it('stores a link and the same link read from the other end identically', () => {
    const fromFact = reversed(rel('many-to-one'));
    expect(relationshipKey(canonicalRelationship(rel('one-to-many')))).toBe(relationshipKey(canonicalRelationship(fromFact)));
  });
});

describe('normaliseRelationshipRole', () => {
  it('trims, collapses whitespace and drops blanks and non-strings', () => {
    expect(normaliseRelationshipRole('  ship\n  date ')).toBe('ship date');
    expect(normaliseRelationshipRole('   ')).toBeUndefined();
    expect(normaliseRelationshipRole(7)).toBeUndefined();
    expect(normaliseRelationshipRole(undefined)).toBeUndefined();
  });

  it('cuts a long label to the maximum', () => {
    expect(normaliseRelationshipRole('x'.repeat(200))).toHaveLength(RELATIONSHIP_ROLE_MAX_LENGTH);
  });

  it('is read from a model file, and an invalid one is dropped', () => {
    const model = parseLogicalModelText([
      'name: fct_order',
      'relationships:',
      '  - { fromColumn: order_date_key, toModel: dim_date, toColumn: date_key, cardinality: many-to-one, role: order date }',
      '  - { fromColumn: ship_date_key, toModel: dim_date, toColumn: date_key, cardinality: many-to-one, role: [x] }',
    ].join('\n'), 'fct_order');
    expect(model?.relationships).toEqual([
      { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'order date' },
      { fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' },
    ]);
  });
});

describe('mergeLibraryRelationships — one line per link (#133)', () => {
  it('draws a domain copy stored the other way round once, as the library has it', async () => {
    const { mergeLibraryRelationships } = await import('../../src/domain');
    const models = [
      { name: 'fct_order', columns: [], relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const, role: 'buyer' }] },
      { name: 'dim_customer', columns: [] },
    ];
    const merged = mergeLibraryRelationships(models, [rel('one-to-many')]);
    expect(merged).toEqual([
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' },
    ]);
  });
});
