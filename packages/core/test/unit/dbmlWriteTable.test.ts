/**
 * The table-file writer (§2.2, §4.5, §4.5.x of the native DBML storage
 * spec): every table operation, splicing only what changes, and the files
 * it refuses. The cases live in `../dbmlWriterCases/tableCases.ts`, so
 * `dbmlMultiParser.test.ts` can compile each output again in every parser.
 */
import { describe, it, expect } from 'vitest';

import { editTableDbml } from '../../src/dbml/writeTable';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { applyTextEdits, refuseOverlaps } from '../../src/dbml/splice';
import * as DbmlParse from '@dbml/parse';
import { METADATA_TABLE, NEW_TABLE_CASES, TABLE_CASES } from '../dbmlWriterCases/tableCases';
import { clone, projectDiagnostics, readTable } from '../dbmlWriterSupport';
import { parseTableDbml } from '../../src/dbml/readTable';
import { STORAGE_PARSERS } from '../dbmlParsers';

describe('editTableDbml', () => {
  for (const c of TABLE_CASES) it(c.name, () => c.check(c.run()));
});

const BARE_TABLE = 'Table fct_order {\n  id int [pk]\n}\n';

describe('editTableDbml refusals', () => {
  const refusal = (fn: () => unknown): DbmlEditRefused => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(DbmlEditRefused);
      return err as DbmlEditRefused;
    }
    throw new Error('expected a refusal');
  };

  it('a file that does not parse is refused with the reader\'s message, never rewritten', () => {
    const err = refusal(() => editTableDbml('Table fct_order {\n  id int [pk\n}\n', { name: 'fct_order', columns: [] }, { file: 'tables/fct_order.dbml' }));
    expect(err.message).toMatch(/^Fix the DBML in tables\/fct_order\.dbml first \(Line \d+, column \d+: /);
    expect(err.line).toBeGreaterThan(0);
    expect(err.message).toMatch(/ERD Studio never rewrites a file it cannot read\.$/);
    expect(err.file).toBe('tables/fct_order.dbml');
  });

  it('a file holding an inline ref (writable: false) is refused with the line to move', () => {
    const text = 'Table fct_order {\n  id int [pk]\n  customer_key int [ref: > dim_customer.customer_key]\n}\n';
    const table = readTable(text, 'fct_order').table;
    const err = refusal(() => editTableDbml(text, table));
    expect(err.message).toContain('Ref: fct_order.customer_key >? dim_customer.customer_key');
  });

  it('a file with git conflict markers is refused', () => {
    const text = 'Table fct_order {\n<<<<<<< HEAD\n  id int\n=======\n  id bigint\n>>>>>>> branch\n}\n';
    expect(() => editTableDbml(text, { name: 'fct_order', columns: [] })).toThrow(DbmlEditRefused);
  });

  it('a schema change on a schema-qualified name is refused with the qualifier advice', () => {
    const text = 'Table gold.fct_order {\n  id int\n}\n';
    const table = readTable(text, 'fct_order').table;
    expect(table.schema).toBe('gold');
    const err = refusal(() => editTableDbml(text, { ...table, schema: 'silver' }, { file: 'tables/gold/fct_order.dbml' }));
    expect(err.message).toBe("tables/gold/fct_order.dbml names its schema in the Table name (`Table gold.fct_order`). Change it there, or remove the qualifier and use `[schema: 'gold']`.");
  });

  it('a name that differs from the declared one is refused unless the edit is a rename', () => {
    const table = readTable(BARE_TABLE, 'fct_order').table;
    const err = refusal(() => editTableDbml(BARE_TABLE, { ...table, name: 'fct_line' }, { file: 'tables/fct_order.dbml' }));
    expect(err.message).toBe('tables/fct_order.dbml declares Table fct_order, not fct_line; a rename must say so.');
    expect(editTableDbml(BARE_TABLE, { ...table, name: 'fct_line' }, { rename: true })).toBe(BARE_TABLE.replace('fct_order', 'fct_line'));
  });

  it('a parser that throws is refused like a file that does not read', () => {
    const throwing = { ...DbmlParse, Compiler: class { constructor() { throw new Error('boom'); } } };
    const err = refusal(() => editTableDbml(BARE_TABLE, { name: 'fct_order', columns: [] }, { file: 'tables/fct_order.dbml', parser: throwing }));
    expect(err.message).toBe('Fix the DBML in tables/fct_order.dbml first (the DBML parser stopped: boom). ERD Studio never rewrites a file it cannot read.');
  });

  it('an overlap of a writer\'s own edits is refused, never thrown as an unexpected error', () => {
    const err = refusal(() => refuseOverlaps('tables/x.dbml', () => applyTextEdits('abc', [{ start: 0, end: 2, text: '' }, { start: 1, end: 3, text: '' }])));
    expect(err.message).toBe('ERD Studio could not apply this change to tables/x.dbml safely, so nothing was written. Make the change in the file by hand.');
    expect(err.file).toBe('tables/x.dbml');
  });

  it('a property a Metadata block in another file sets is refused (D25)', () => {
    const table = readTable(METADATA_TABLE(), 'fct_order').table;
    const err = refusal(() => editTableDbml(METADATA_TABLE(), { ...table, modelRole: 'x' as never }, {
      foreignMetadata: [{ file: 'gold/sales.dbml', line: 12, property: 'role' }],
    }));
    expect(err.message).toBe('role is set by a Metadata block in gold/sales.dbml:12; edit it there.');
    // A property no block elsewhere sets edits as usual.
    expect(() => editTableDbml(METADATA_TABLE(), { ...table, grain: 'ok' }, {
      foreignMetadata: [{ file: 'gold/sales.dbml', line: 12, property: 'role' }],
    })).not.toThrow();
  });
});

describe('Metadata blocks (D25) read back the same in every parser', () => {
  it.each(STORAGE_PARSERS)('an edit of block-set values re-reads as the edit (%s)', (_label, parser) => {
    const desired = clone(readTable(METADATA_TABLE(), 'fct_order').table);
    desired.grain = 'from the edit';
    desired.columns![0].description = 'new note';
    desired.columns![0].meta = { owner: 'z' };
    const out = editTableDbml(METADATA_TABLE(), desired, { parser });
    const reading = parseTableDbml(out, 'fct_order', parser);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.table.grain).toBe('from the edit');
    expect(reading.table.columns![0].description).toBe('new note');
    expect(reading.table.columns![0].meta).toEqual({ owner: 'z' });
    // Clearing removes the block entry and the shadowed inline value: nothing resurfaces.
    delete desired.grain;
    const clearedText = editTableDbml(out, desired, { parser });
    const cleared = parseTableDbml(clearedText, 'fct_order', parser);
    expect(cleared.ok && cleared.table.grain).toBeUndefined();
    // Law 5: both outputs compile with no error or warning in every parser.
    for (const text of [out, clearedText]) expect(projectDiagnostics({ 'tables/fct_order.dbml': text })).toEqual([]);
  });
});

describe('renderNewTableDbml', () => {
  for (const c of NEW_TABLE_CASES) it(c.name, () => c.check(c.run()));
});
