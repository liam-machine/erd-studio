import { describe, it, expect } from 'vitest';

import { relationshipKey } from '../../src/domain';
import { parseLogicalModelText } from '../../src/logicalModel';
import {
  canonicalRelationship, linkKey, normaliseRelationshipRole, RELATIONSHIP_ROLE_MAX_LENGTH, reverseRelationship, sameLink,
} from '../../src/relationships';
import type { Cardinality, Relationship } from '../../src/types/semantic';

const rel = (cardinality: Cardinality): Relationship => ({
  fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality,
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
    const fromFact = reverseRelationship(rel('one-to-many'));
    expect(relationshipKey(canonicalRelationship(rel('one-to-many')))).toBe(relationshipKey(canonicalRelationship(fromFact)));
  });
});

describe('linkKey / sameLink / reverseRelationship — one identity (#133)', () => {
  it('the same two columns, either way round and in any case, are one link', () => {
    expect(sameLink(rel('many-to-one'), reverseRelationship(rel('many-to-one')))).toBe(true);
    expect(linkKey(rel('many-to-one'))).toBe(linkKey({ ...rel('one-to-one'), fromModel: ' DIM_Customer', toColumn: 'CUSTOMER_KEY' }));
    expect(sameLink(rel('many-to-one'), { ...rel('many-to-one'), toColumn: 'other_key' })).toBe(false);
  });

  it('reverseRelationship swaps the ends and flips many-to-one and one-to-many only', () => {
    expect(reverseRelationship(rel('one-to-many'))).toEqual({ ...rel('many-to-one'), fromModel: 'fct_order', toModel: 'dim_customer' });
    expect(reverseRelationship(rel('one-to-one')).cardinality).toBe('one-to-one');
    expect(reverseRelationship(reverseRelationship(rel('many-to-many')))).toEqual(rel('many-to-many'));
  });

  it('a self-reference is stored on its own model, whichever way it is drawn', () => {
    const drawn: Relationship = { fromModel: 'employee', fromColumn: 'employee_id', toModel: 'employee', toColumn: 'manager_id', cardinality: 'one-to-many' };
    expect(canonicalRelationship(drawn)).toEqual({ ...reverseRelationship(drawn), fromColumn: 'manager_id', cardinality: 'many-to-one' });
    expect(canonicalRelationship(reverseRelationship(drawn)).fromModel).toBe('employee');
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

describe('mergeLibraryRelationships — the same copy wins whatever the file order (#133)', () => {
  const FACT = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const, role: 'buyer' };
  const { fromModel: _f, ...stored } = FACT;
  const fact = { name: 'fct_order', columns: [], relationships: [stored] };
  it.each(['one-to-many', 'many-to-one'] as const)('a 1.6.7 copy on the dimension (%s) loses to the fact\'s', async (cardinality) => {
    const { mergeLibraryRelationships } = await import('../../src/domain');
    const dim = {
      name: 'dim_customer',
      columns: [{ name: 'customer_key', dataType: 'int', description: '', isPrimaryKey: true }],
      relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality }],
    };
    expect(mergeLibraryRelationships([dim, fact], [])).toEqual([FACT]);
    expect(mergeLibraryRelationships([fact, dim], [])).toEqual([FACT]);
  });
});
