/**
 * `outlineDbmlFile` (native DBML storage §7.1): the `use` lines, Enums and
 * Metadata targets `doctor` checks, read from the AST alone.
 */

import { describe, expect, it } from 'vitest';
import { outlineDbmlFile } from '../../src/dbml/index.js';
import { findConflictMarkers } from '../../src/index.js';

describe('outlineDbmlFile', () => {
  it('resolves each use line against the file\'s folder, with its specifiers and line', () => {
    const text = [
      '// relationships',
      "use { table dim_date } from '../dim_date.dbml'",
      "use { table fct_order } from './fct_order'",
      "use * from '../_relationships.dbml'",
      '',
      'Ref: fct_order.date_key >? dim_date.date_key',
      '',
    ].join('\n');
    expect(outlineDbmlFile(text, 'tables/gold/_relationships.dbml')).toEqual({
      parses: true,
      enums: [],
      metadata: [],
      uses: [
        { path: '../dim_date.dbml', resolved: 'tables/dim_date.dbml', line: 2, wildcard: false, tables: ['dim_date'] },
        { path: './fct_order', resolved: 'tables/gold/fct_order.dbml', line: 3, wildcard: false, tables: ['fct_order'] },
        { path: '../_relationships.dbml', resolved: 'tables/_relationships.dbml', line: 4, wildcard: true, tables: [] },
      ],
    });
  });

  it('lists the Enums a table file declares, with their lines; a leading byte-order mark is ignored', () => {
    const text = '﻿Table t {\n  s status\n}\n\nEnum status {\n  a\n}\n\nEnum gold.kind {\n  b\n}\n';
    expect(outlineDbmlFile(text, 'tables/t.dbml').enums).toEqual([{ name: 'status', line: 5 }, { name: 'gold.kind', line: 9 }]);
  });

  it('lists the target of each Metadata block (D25), table or column, with its line', () => {
    const text = [
      "use { table fct_order } from '../tables/gold/fct_order.dbml'",
      '',
      'Metadata Table fct_order {',
      "  grain: 'One row per order'",
      '}',
      '',
      'Metadata Column fct_order.customer_key {',
      "  note: 'The buyer'",
      '}',
      '',
    ].join('\n');
    expect(outlineDbmlFile(text, 'gold/sales.dbml').metadata).toEqual([
      { table: 'fct_order', line: 3 },
      { table: 'fct_order', column: 'customer_key', line: 7 },
    ]);
  });

  it('a file with a syntax error has no outline', () => {
    expect(outlineDbmlFile('Table t {\n  id int\n', 'tables/t.dbml')).toEqual({ parses: false, uses: [], enums: [], metadata: [] });
  });

  it('findConflictMarkers is exported from the main entry', () => {
    expect(findConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n')).toBe(2);
    expect(findConflictMarkers('Table t {\n  id int\n}\n')).toBeNull();
  });
});
