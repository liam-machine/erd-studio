/**
 * withRelationshipHomes: which relationships a diagram file holds itself, so
 * the detail panel's Remove confirmation warns only about the ones that go
 * with a table (a YAML/JSON domain's own list), never for a DBML diagram.
 */
import { describe, it, expect } from 'vitest';
import type { DisplaySubjectArea } from '@erd-studio/core';

import { withRelationshipHomes } from '../../src/services/diagramRelationshipHomes';

const order = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const };
const sale = { fromModel: 'fct_sale', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' as const };
const display = { relationships: [order, sale] } as unknown as DisplaySubjectArea;

describe('withRelationshipHomes', () => {
  it('a DBML diagram holds none: every relationship stays in the Table Library', () => {
    const out = withRelationshipHomes(display, [order], true);
    expect(out.relationshipsInDiagramFile).toBe(false);
    expect(out.relationships.some((r) => r.inDiagramFile)).toBe(false);
  });

  it('a JSON diagram with no relationships of its own (library storage) holds none', () => {
    expect(withRelationshipHomes(display, undefined, false).relationshipsInDiagramFile).toBe(false);
    expect(withRelationshipHomes(display, [], false).relationshipsInDiagramFile).toBe(false);
  });

  it('marks only the relationships the file lists, matched as one link either way round and in any case', () => {
    const own = [{ fromModel: 'DIM_CUSTOMER', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'Customer_Key' }];
    const out = withRelationshipHomes(display, own, false);
    expect(out.relationshipsInDiagramFile).toBe(true);
    expect(out.relationships.map((r) => r.inDiagramFile)).toEqual([true, undefined]);
  });

  it('a file that could not be read is left unmarked, so the panel keeps its cautious warning', () => {
    expect(withRelationshipHomes(display, null, false)).toBe(display);
  });

  it('ignores entries that are not relationships', () => {
    expect(withRelationshipHomes(display, [{ fromModel: 'x' }, 'nope'], false).relationshipsInDiagramFile).toBe(false);
  });
});
