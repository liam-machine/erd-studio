/**
 * The table-file writer (§2.2, §4.5, §4.5.x of the native DBML storage
 * spec): every table operation, splicing only what changes, and the files
 * it refuses. The cases live in `../dbmlWriterCases/tableCases.ts`, so
 * `dbmlMultiParser.test.ts` can compile each output again in every parser.
 */
import { describe, it, expect } from 'vitest';

import { editTableDbml, renderNewTableDbml } from '../../src/dbml/writeTable';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { FCT_ORDER, METADATA_TABLE, NEW_TABLE_CASES, TABLE_CASES, edited } from '../dbmlWriterCases/tableCases';
import { clone, readTable } from '../dbmlWriterSupport';
import { parseTableDbml } from '../../src/dbml/readTable';
import { STORAGE_PARSERS } from '../dbmlParsers';

describe('editTableDbml', () => {
  for (const c of TABLE_CASES) it(c.name, () => c.check(c.run()));

  it('a no-op is byte-identical (Law 1)', () => {
    expect(edited(FCT_ORDER, () => undefined)).toBe(FCT_ORDER);
  });

  it('is idempotent (Law 2)', () => {
    const change = (t: Parameters<Parameters<typeof edited>[1]>[0]): void => {
      t.grain = 'g2';
      t.columns!.splice(2, 1);
      t.columns!.push({ name: 'z', dataType: 'int', description: 'zz', isNaturalKey: true });
      t.columns![0].isPrimaryKey = false;
      t.columns![1].isPrimaryKey = true;
      t.meta = { owner: 'o', n: ['1', true, null] };
    };
    const once = edited(FCT_ORDER, change);
    const desired = clone(readTable(FCT_ORDER, 'fct_order').table);
    change(desired);
    expect(editTableDbml(once, desired)).toBe(once);
  });
});

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

  it('a schema-qualified name with a schema property edits the property', () => {
    const text = "Table gold.fct_order [schema: 'gold'] {\n  id int\n}\n";
    const table = readTable(text, 'fct_order').table;
    expect(editTableDbml(text, { ...table, schema: 'silver' })).toBe("Table gold.fct_order [schema: 'silver'] {\n  id int\n}\n");
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
    const cleared = parseTableDbml(editTableDbml(out, desired, { parser }), 'fct_order', parser);
    expect(cleared.ok && cleared.table.grain).toBeUndefined();
  });
});

describe('renderNewTableDbml', () => {
  for (const c of NEW_TABLE_CASES) it(c.name, () => c.check(c.run()));

  it('reads back as the table it was given', () => {
    const table = {
      name: 'dim_customer',
      schema: 'silver',
      alias: 'customers',
      modelRole: 'conformed-dim' as const,
      rationale: { scdStrategy: 'Type 2 on segment' },
      description: 'Customers\n  - indented bullet',
      meta: { tags: ['a', 'b'], owner: 'crm', 'Odd Key': 'x' },
      columns: [
        { name: 'customer_key', dataType: 'INT', description: 'Surrogate', isPrimaryKey: true, scdType: 0 as const },
        { name: 'segment', dataType: 'VARCHAR', description: '', scdType: 2 as const, isNaturalKey: true },
      ],
    };
    const read = readTable(renderNewTableDbml(table), 'dim_customer').table;
    expect(read).toEqual(table);
  });
});
