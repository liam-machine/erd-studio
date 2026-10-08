import { describe, it, expect } from 'vitest';

import { relationshipKey } from '../../src/domain';
import { parseLogicalModelText } from '../../src/logicalModel';
import {
  canonicalRelationship,
  linkKey,
  normaliseRelationshipRole,
  relationshipEnds,
  relationshipHomeModel,
  RELATIONSHIP_ROLE_MAX_LENGTH,
  sameLink,
  sameRelationshipMeaning,
  stripRelationshipProvenance,
} from '../../src/relationships';
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
      {
        fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer',
        source: { kind: 'library', model: 'fct_order', index: 0 },
        stored: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' },
        // The domain copy has no role, so it says something else — and is
        // ignored: the library's copy is drawn (REL009, never REL001).
        issues: ['REL009'],
      },
    ]);
  });
});

describe('linkKey / sameLink — one identity for a link (#133)', () => {
  it('is the same either way round and without case', () => {
    const a = rel('many-to-one');
    expect(linkKey(a)).toBe(linkKey(reversed(a)));
    expect(linkKey(a)).toBe(linkKey({ ...a, fromModel: 'DIM_Customer', toColumn: 'Customer_Key' }));
    expect(sameLink(a, reversed(a))).toBe(true);
  });

  it('is the sorted pair of lowercased model.column ends joined by NUL', () => {
    expect(linkKey(rel('many-to-one'))).toBe('dim_customer.customer_key\u0000fct_order.customer_key');
  });

  it('tells different columns apart, including two links between the same models', () => {
    const a = rel('many-to-one');
    expect(sameLink(a, { ...a, toColumn: 'ship_customer_key' })).toBe(false);
    // A dotted name cannot be confused with another split of the same text.
    expect(linkKey({ fromModel: 'a.b', fromColumn: 'c', toModel: 'x', toColumn: 'y' }))
      .not.toBe(linkKey({ fromModel: 'a', fromColumn: 'b.c', toModel: 'x', toColumn: 'y' }) + 'x');
  });

  it('ignores cardinality and role', () => {
    const labelled: Relationship = { ...rel('one-to-one'), role: 'x' };
    expect(sameLink(labelled, rel('many-to-many'))).toBe(true);
  });
});

describe('relationshipHomeModel — the home comes from the record alone', () => {
  it.each([
    ['many-to-one', 'dim_customer'],
    ['one-to-many', 'fct_order'],
    ['one-to-one', 'dim_customer'],
    ['many-to-many', 'dim_customer'],
  ] as const)('%s is stored with %s', (cardinality, home) => {
    expect(relationshipHomeModel(rel(cardinality))).toBe(home);
  });
});

describe('sameRelationshipMeaning', () => {
  it('a many-to-one and the same link stored one-to-many say the same', () => {
    expect(sameRelationshipMeaning(rel('one-to-many'), reversed(rel('many-to-one')))).toBe(true);
    // The opposite many side is a different statement about the same link.
    expect(sameRelationshipMeaning(rel('one-to-many'), rel('many-to-one'))).toBe(false);
  });

  it('a one-to-one each way round, a different role or cardinality, are different', () => {
    expect(sameRelationshipMeaning(rel('one-to-one'), reversed(rel('one-to-one')))).toBe(false);
    expect(sameRelationshipMeaning(rel('many-to-one'), { ...rel('many-to-one'), role: 'x' })).toBe(false);
    expect(sameRelationshipMeaning(rel('many-to-one'), rel('one-to-one'))).toBe(false);
  });

  it('a many-to-many has no direction', () => {
    expect(sameRelationshipMeaning(rel('many-to-many'), reversed(rel('many-to-many')))).toBe(true);
  });
});

describe('stripRelationshipProvenance / relationshipEnds', () => {
  it('drops only the runtime-only fields', () => {
    const drawn: Relationship = {
      ...rel('many-to-one'), role: 'r', source: { kind: 'domain', index: 0 }, stored: relationshipEnds(rel('many-to-one')), issues: ['REL001'],
    };
    expect(stripRelationshipProvenance(drawn)).toEqual({ ...rel('many-to-one'), role: 'r' });
    expect(relationshipEnds(drawn)).toEqual({ fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' });
  });
});
