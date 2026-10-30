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
      "use { table shared.dim_date } from '../../silver/tables/shared/dim_date.dbml'",
      "use { table gold.fct_order } from '../tables/gold/fct_order'",
      "use * from './calendar.dbml'",
      '',
      'Ref: gold.fct_order.date_key >? shared.dim_date.date_key',
      '',
    ].join('\n');
    expect(outlineDbmlFile(text, 'gold/relationships/gold.dbml')).toEqual({
      parses: true,
      enums: [],
      metadata: [],
      tables: [],
      uses: [
        { path: '../../silver/tables/shared/dim_date.dbml', resolved: 'silver/tables/shared/dim_date.dbml', line: 2, wildcard: false, tables: ['dim_date'], specifiers: ['shared.dim_date'] },
        { path: '../tables/gold/fct_order', resolved: 'gold/tables/gold/fct_order.dbml', line: 3, wildcard: false, tables: ['fct_order'], specifiers: ['gold.fct_order'] },
        { path: './calendar.dbml', resolved: 'gold/relationships/calendar.dbml', line: 4, wildcard: true, tables: [], specifiers: [] },
      ],
    });
  });

  it('keeps each table specifier in its case as written, quoted only where DBML needs it, for an exact compare with a declared reference', () => {
    const text = "use { table Gold.Fct_Order } from '../tables/gold/fct_order.dbml'\nuse { table \"SAP FI\".afih } from '../tables/SAP FI/afih.dbml'\n"
      + "use { table \"gold\".\"dim_date\" } from '../tables/gold/dim_date.dbml'\n";
    const uses = outlineDbmlFile(text, 'gold/diagrams/sales.dbml').uses;
    expect(uses.map((u) => u.tables)).toEqual([['fct_order'], ['afih'], ['dim_date']]);
    expect(uses.map((u) => u.specifiers)).toEqual([['Gold.Fct_Order'], ['"SAP FI".afih'], ['gold.dim_date']]);
  });

  it('lists the Enums a table file declares, with their lines; a leading byte-order mark is ignored', () => {
    const text = '﻿Table t {\n  s status\n}\n\nEnum status {\n  a\n}\n\nEnum gold.kind {\n  b\n}\n';
    expect(outlineDbmlFile(text, 'gold/tables/gold/t.dbml').enums).toEqual([{ name: 'status', line: 5 }, { name: 'gold.kind', line: 9 }]);
  });

  it('lists the target of each Metadata block (D25), table or column, with its line', () => {
    const text = [
      "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'",
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
    expect(outlineDbmlFile(text, 'gold/diagrams/sales.dbml').metadata).toEqual([
      { table: 'fct_order', line: 3 },
      { table: 'fct_order', column: 'customer_key', line: 7 },
    ]);
  });

  it('lists the Tables the file itself declares, by their last name part', () => {
    const text = 'Table a {\n  id int [pk]\n}\n\nTable gold."b c" {\n  id int\n}\n\nMetadata Table a {\n  grain: \'x\'\n}\n';
    expect(outlineDbmlFile(text, 'gold/diagrams/pulled.dbml').tables).toEqual(['a', 'b c']);
  });

  it('a file with a syntax error has no outline', () => {
    expect(outlineDbmlFile('Table gold.t {\n  id int\n', 'gold/tables/gold/t.dbml')).toEqual({ parses: false, uses: [], enums: [], metadata: [], tables: [] });
  });

  it('findConflictMarkers is exported from the main entry', () => {
    expect(findConflictMarkers('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n')).toBe(2);
    expect(findConflictMarkers('Table t {\n  id int\n}\n')).toBeNull();
  });
});
