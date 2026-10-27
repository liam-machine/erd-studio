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
  meaning,
  relEdit,
} from '../dbmlWriterCases/relationshipsCases';
import { comparableRelationships, libraryOf, relationshipsResolver } from '../dbmlWriterSupport';

describe('editRelationshipsDbml', () => {
  for (const c of RELATIONSHIPS_CASES) it(c.name, () => c.check(c.run()));

  it('reads back as the relationships it was given (Law 3) and is idempotent (Law 2)', () => {
    const owners = currentOwners(HAND_WRITTEN);
    const desired = new Map([['fct_order', {
      name: 'fct_order',
      relationships: [
        ...owners.get('fct_order')!.filter((r) => r.toModel !== 'dim_date'),
        { fromColumn: 'region_code', toModel: 'dim_region', toColumn: 'region_code', cardinality: 'many-to-one' as const, compositeKey: 'k' },
        { fromColumn: 'country_code', toModel: 'dim_region', toColumn: 'country_code', cardinality: 'many-to-one' as const, compositeKey: 'k' },
        { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'one-to-one' as const, role: 'order date' },
      ],
    }]]);
    const once = relEdit(HAND_WRITTEN, { owners: desired });
    expect(comparableRelationships(currentOwners(once).get('fct_order'))).toEqual(comparableRelationships(desired.get('fct_order')!.relationships));
    expect(relEdit(once, { owners: desired })).toBe(once);
    // Owners the edit did not list read as before.
    expect(meaning(once).customer_profile).toEqual(meaning(HAND_WRITTEN).customer_profile);
  });

  it('a byte-order mark and CRLF line endings are kept', () => {
    const crlf = `﻿${HAND_WRITTEN.replace(/\n/g, '\r\n')}`;
    const out = relEdit(crlf, { owners: new Map([['bridge', { name: 'bridge', relationships: [{ fromColumn: 'a_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }] }]]) });
    expect(out.startsWith('﻿')).toBe(true);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('Ref: bridge.a_key >? dim_date.date_key\r\n');
  });

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
    // No such table at all: a dangling Ref is written with its in-memory spelling, not refused.
    expect(err).toBeUndefined();
    expect(() => editRelationshipsDbml(HAND_WRITTEN, {
      filePath: 'tables/gold/_relationships.dbml',
      resolve: relationshipsResolver(libraryOf(LIBRARY, { yml_table: 'tables/yml_table.yml' })),
      ...owner([{ fromColumn: 'order_id', toModel: 'yml_table', toColumn: 'id', cardinality: 'many-to-one' }]),
    })).toThrow(/Convert the project to DBML first \(ERD Studio: Convert Project to DBML\)/);
  });

  it('a file with a syntax error or conflict markers', () => {
    expect(() => relEdit('Ref: a.b > \n', owner([]))).toThrow(/^Fix the DBML in tables\/gold\/_relationships\.dbml first/);
    expect(() => relEdit('<<<<<<< HEAD\nRef: a.b > c.d\n=======\n>>>>>>> x\n', owner([]))).toThrow(DbmlEditRefused);
  });
});
