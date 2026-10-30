/**
 * The relationships-file writer (§2.3, §4.5 of the native DBML storage
 * spec): Refs inserted at their sorted place, kept byte for byte, rewritten
 * in place or cut; `use` lines maintained only for the tables an edit
 * touches; the operators that mark the foreign-key end; the refusals. The
 * cases live in `../dbmlWriterCases/relationshipsCases.ts`, so
 * `dbmlMultiParser.test.ts` can compile each output again in every parser.
 */
import { describe, it, expect } from 'vitest';

import { DbmlEditRefused } from '../../src/dbml/errors';
import type { TableRelationship } from '../../src/types/semantic';
import { editRelationshipsDbml, relationshipUnits } from '../../src/dbml/writeRelationships';
import {
  HAND_WRITTEN,
  LIBRARY,
  RELATIONSHIPS_CASES,
  currentOwners,
  relEdit,
} from '../dbmlWriterCases/relationshipsCases';
import { libraryOf, relationshipsResolver } from '../dbmlWriterSupport';

describe('editRelationshipsDbml', () => {
  for (const c of RELATIONSHIPS_CASES) it(c.name, () => c.check(c.run()));

  it('groups composite entries into one unit and canonicalises one-to-many', () => {
    expect(relationshipUnits('a', [
      { fromColumn: 'x', toModel: 'b', toColumn: 'u', cardinality: 'many-to-one', compositeKey: 'k' },
      { fromColumn: 'y', toModel: 'b', toColumn: 'v', cardinality: 'many-to-one', compositeKey: 'k' },
      { fromColumn: 'z', toModel: 'c', toColumn: 'w', cardinality: 'one-to-many' },
    ])).toEqual([
      { from: 'a', to: 'b', fromColumns: ['x', 'y'], toColumns: ['u', 'v'], cardinality: 'many-to-one' },
      { from: 'c', to: 'a', fromColumns: ['w'], toColumns: ['z'], cardinality: 'many-to-one' },
    ]);
  });
});

describe('editRelationshipsDbml refusals', () => {
  const owner = (relationships: TableRelationship[]) => ({ owners: new Map([['fct_order', { name: 'fct_order', relationships }]]) });

  it('a Ref joining a column set to itself', () => {
    expect(() => relEdit(null, owner([{ fromColumn: 'order_id', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-one' }])))
      .toThrow(/joins a column set to itself/);
  });

  it('two Refs joining the same column sets, either way round', () => {
    expect(() => relEdit(null, {
      owners: new Map([
        ['fct_order', { name: 'fct_order', relationships: [{ fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }] }],
        ['dim_date', { name: 'dim_date', relationships: [{ fromColumn: 'date_key', toModel: 'fct_order', toColumn: 'order_date_key', cardinality: 'many-to-many' }] }],
      ]),
    })).toThrow(DbmlEditRefused);
  });

  it('a Ref whose other end is a YAML table (D20)', () => {
    const library = { ...LIBRARY };
    const err = (() => {
      try {
        relEdit(HAND_WRITTEN, owner([{ fromColumn: 'order_id', toModel: 'yml_table', toColumn: 'id', cardinality: 'many-to-one' }]), library);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    // No such table at all: a new Ref to it would not compile, so it is refused too.
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err!.message).toBe('The relationship fct_order.(order_id) → yml_table.(id) names yml_table, which has no table file, so it cannot be written to gold/relationships/gold.dbml.');
    // A dangling Ref already in the file is kept as it is.
    const dangling = `${HAND_WRITTEN}Ref: gold.fct_order.order_id > nowhere.id\n`;
    expect(relEdit(dangling, owner([...currentOwners(dangling).get('fct_order')!]))).toBe(dangling);
    expect(() => editRelationshipsDbml(HAND_WRITTEN, {
      filePath: 'gold/relationships/gold.dbml',
      resolve: relationshipsResolver(libraryOf(LIBRARY, { yml_table: 'tables/yml_table.yml' })),
      ...owner([{ fromColumn: 'order_id', toModel: 'yml_table', toColumn: 'id', cardinality: 'many-to-one' }]),
    })).toThrow(/Convert the project to DBML first \(ERD Studio: Convert Project to DBML\)/);
  });

  it('a file with a syntax error or conflict markers', () => {
    expect(() => relEdit('Ref: a.b > \n', owner([]))).toThrow(/^Fix the DBML in gold\/relationships\/gold\.dbml first/);
    expect(() => relEdit('<<<<<<< HEAD\nRef: a.b > c.d\n=======\n>>>>>>> x\n', owner([]))).toThrow(DbmlEditRefused);
  });
});
