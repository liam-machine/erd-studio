/**
 * Sample rows (D37) through the table writer, byte for byte: the splices
 * that keep a nested `records` block in step with a column edit, the
 * refusals (a drop that would start a later row with a sign, a cut that
 * would cross a line break), the safety net that reads every output back,
 * the spans a message sanitiser uses, and the rule that the writers never
 * read a table's `sampleData` sidecar. No message here may hold a cell value.
 * The §3.3 matrix and the hand-written shapes are writer cases
 * (`../dbmlWriterCases/tableCases.ts`), compiled again in every parser by
 * `dbmlMultiParser.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as DbmlParse from '@dbml/parse';

import { editTableDbml, renderNewTableDbml } from '../../src/dbml/writeTable';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { parseTableDbml } from '../../src/dbml/readTable';
import { compileOne, lineAt } from '../../src/dbml/parser';
import { recordsSpansOf } from '../../src/dbml/records';
import type { DbmlParserModule } from '../../src/dbml/parserModule';
import { SAMPLE_ROWS_LIMIT, tableSampleDataOf, type SampleData, type SemanticTable, type TableWithSampleData } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';
import { clone, readTable } from '../dbmlWriterSupport';

/** A value that must never reach a message. */
const SENTINEL = 'zqSENTX7';

const HEAD = 'Table gold.t {\n  id int\n  name varchar\n  amount decimal\n\n';

/** Read `text` as table `t`, apply `change`, and write it back. */
function write(text: string, change: (t: SemanticTable) => void, options: Parameters<typeof editTableDbml>[2] = {}): string {
  const desired = clone(readTable(text, 't').table);
  change(desired);
  return editTableDbml(text, desired, { fileStem: 't', file: 'gold/tables/gold/t.dbml', ...options });
}

const keep = (...names: string[]) => (t: SemanticTable): void => { t.columns = t.columns!.filter((c) => names.includes(c.name)); };

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the edit to be refused');
}

describe('the splices, byte for byte', () => {
  it('a drop cuts the list name and the value at comma tokens, the rest of the file untouched', () => {
    const text = `${HEAD}  records (id, name, amount) { // from a script\n    1, 'a', 1.5\n    , 'b', 2.5 // two\n    3, , 3.5\n  }\n}\n`;
    expect(write(text, keep('id', 'amount'))).toBe(
      'Table gold.t {\n  id int\n  amount decimal\n\n  records (id, amount) { // from a script\n    1, 1.5\n    , 2.5 // two\n    3, 3.5\n  }\n}\n',
    );
  });

  it('a one-value row left with an empty field gets null, and the output passes the safety net', () => {
    const text = `${HEAD}  records (id, name) {\n    1, 'a'\n    , 'b'\n    3,\n  }\n}\n`;
    expect(write(text, keep('name', 'amount'))).toBe("Table gold.t {\n  name varchar\n  amount decimal\n\n  records (name) {\n    'a'\n    'b'\n    null\n  }\n}\n");
    expect(write(text, keep('id', 'amount'))).toBe('Table gold.t {\n  id int\n  amount decimal\n\n  records (id) {\n    1\n    null\n    3\n  }\n}\n');
  });

  it('a block with no list gets the old list once on an add, and no row changes; the next add needs nothing', () => {
    const text = `${HEAD}  records {\n    1, 'a', 1.5\n  }\n}\n`;
    const added = write(text, (t) => { t.columns!.push({ name: 'extra', dataType: 'int', description: '' }); });
    expect(added).toBe("Table gold.t {\n  id int\n  name varchar\n  amount decimal\n  extra int\n\n  records (id, name, amount) {\n    1, 'a', 1.5\n  }\n}\n");
    const again = clone(readTable(added, 't').table);
    again.columns!.push({ name: 'more', dataType: 'int', description: '' });
    expect(editTableDbml(added, again)).toBe(added.replace('  extra int\n', '  extra int\n  more int\n'));
  });

  it('a block with no list, on a reorder that renames in place, gets the old order with the new name', () => {
    const text = `${HEAD}  records {\n    1, 'a', 1.5\n  }\n}\n`;
    const out = write(text, (t) => { t.columns = [{ ...t.columns![0], name: 'code' }, t.columns![2], t.columns![1]]; });
    expect(out).toBe("Table gold.t {\n  code int\n  amount decimal\n  name varchar\n\n  records (code, name, amount) {\n    1, 'a', 1.5\n  }\n}\n");
  });

  it('a reorder that moves a renamed column is a drop plus an add (as Refs read it): its value goes', () => {
    const text = `${HEAD}  records {\n    1, 'a', 1.5\n  }\n}\n`;
    const out = write(text, (t) => { t.columns = [t.columns![2], { ...t.columns![0], name: 'code' }, t.columns![1]]; });
    expect(out).toBe("Table gold.t {\n  amount decimal\n  code int\n  name varchar\n\n  records (name, amount) {\n    'a', 1.5\n  }\n}\n");
  });

  it('a no-op is byte-identical, with or without a list, in a CRLF file after a byte-order mark', () => {
    for (const block of ["  records (id, name) {\r\n    1, 'a'\r\n  }\r\n", "  records {\r\n    1, 'a', 1.5\r\n  }\r\n", '  records () {\r\n    1\r\n  }\r\n']) {
      const text = `﻿${HEAD.replace(/\n/g, '\r\n')}${block}}\r\n`;
      expect(editTableDbml(text, readTable(text, 't').table)).toBe(text);
    }
  });

  it.each(STORAGE_PARSERS)('the splices are the same under %s (one syntax tree shape in every parser)', (_label, parser) => {
    const text = `${HEAD}  records (id, name, amount) {\n    1, 'a', 1.5\n    , 'b', 2.5\n    3, , 3.5\n    4, 'd',\n  }\n}\n`;
    const desired = clone(readTable(text, 't').table);
    keep('name')(desired);
    expect(editTableDbml(text, desired, { parser })).toBe("Table gold.t {\n  name varchar\n\n  records (name) {\n    'a'\n    'b'\n    null\n    'd'\n  }\n}\n");
  });

  it('a column named records is a column, not a block', () => {
    const text = 'Table gold.t {\n  id int\n  records int\n}\n';
    expect(write(text, (t) => { t.columns!.reverse(); })).toBe('Table gold.t {\n  records int\n  id int\n}\n');
  });
});

describe('refusals', () => {
  const NEGATIVE = `${HEAD}  records (id, amount, name) {\n    1, -1.5, '${SENTINEL}'\n    2, -2.5, 'b'\n  }\n}\n`;

  it('R2: a drop that would start a row after the first with a sign is refused, naming the file, column, row and line only', () => {
    const err = thrown(() => write(NEGATIVE, keep('amount', 'name')));
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err.message).toBe('gold/tables/gold/t.dbml: removing id would start sample row 2 (records, line 8) with a minus or plus sign, which DBML 9 and 10 tools reject. Edit that row in the file first.');
    expect((err as DbmlEditRefused).line).toBe(8);
    expect((err as DbmlEditRefused).file).toBe('gold/tables/gold/t.dbml');
  });

  it('R2: the first row may start with a sign (every parser reads it), and a plus sign is refused too', () => {
    const first = `${HEAD}  records (id, amount) {\n    1, -1.5\n    2, 2.5\n  }\n}\n`;
    expect(write(first, keep('amount', 'name'))).toBe('Table gold.t {\n  name varchar\n  amount decimal\n\n  records (amount) {\n    -1.5\n    2.5\n  }\n}\n');
    const plus = `${HEAD}  records (id, amount) {\n    1, 1.5\n    2, +2.5\n  }\n}\n`;
    expect(thrown(() => write(plus, keep('amount')))).toBeInstanceOf(DbmlEditRefused);
  });

  it('R2: a row that already started with a sign (DBML 11 only) does not block an unrelated drop', () => {
    const text = `${HEAD}  records (amount, id, name) {\n    1.5, 1, 'a'\n    -2.5, 2, 'b'\n  }\n}\n`;
    expect(write(text, keep('id', 'amount'))).toBe('Table gold.t {\n  id int\n  amount decimal\n\n  records (amount, id) {\n    1.5, 1\n    -2.5, 2\n  }\n}\n');
  });

  it('a cut that would cross a line break throws the fixed internal message (file and line only), and nothing is written', () => {
    const text = `${HEAD}  records (id, name) {\n    1, /* a note\n    over two lines */ '${SENTINEL}'\n  }\n}\n`;
    const err = thrown(() => write(text, keep('name')));
    expect(err).not.toBeInstanceOf(DbmlEditRefused);
    expect(err.message).toBe('ERD Studio stopped this edit: a sample data (records) cut in gold/tables/gold/t.dbml at line 7 crossed a line break. Nothing was changed.');
  });

  it('every refusal message is free of the cell values', () => {
    const messages = [
      thrown(() => write(NEGATIVE, keep('amount', 'name'))).message,
      thrown(() => write(`${HEAD}  records (id, name) {\n    1, /* x\n */ '${SENTINEL}'\n  }\n}\n`, keep('name'))).message,
    ];
    for (const m of messages) expect(m).not.toContain(SENTINEL);
  });
});

describe('the safety net', () => {
  const TEXT = `${HEAD}  records (id, name, amount) {\n    1, '${SENTINEL}', 1.5\n    2, 'b', 2.5\n  }\n}\n`;

  /** The pinned parser, but any text without `amount` loses its row `2, 'b'` when compiled: an output that reads back with a row gone. */
  function droppingParser(): DbmlParserModule {
    const pinned = DbmlParse as unknown as DbmlParserModule;
    const Base = pinned.MemoryProjectLayout as unknown as new () => { setSource(path: unknown, text: string): void };
    class RowDropping extends Base {
      setSource(path: unknown, text: string): void {
        super.setSource(path, text.includes('amount') ? text : text.replace("\n    2, 'b'", ''));
      }
    }
    return { Compiler: pinned.Compiler, MemoryProjectLayout: RowDropping, Filepath: pinned.Filepath };
  }

  it('an output whose rows do not read back as the old rows projected through the edit is refused (forced with a stub parser)', () => {
    const parser = droppingParser();
    // The stub reads the input as it is, so the writer gets as far as the net.
    expect(compileOne(TEXT, parser).errors).toEqual([]);
    const err = thrown(() => write(TEXT, keep('id', 'name'), { parser }));
    expect(err).toBeInstanceOf(DbmlEditRefused);
    expect(err.message).toBe('ERD Studio stopped this edit: it would not keep the sample data (records, line 6) of gold/tables/gold/t.dbml in step. Nothing was changed.');
    expect((err as DbmlEditRefused).line).toBe(6);
    expect(err.message).not.toContain(SENTINEL);
    // The same edit with the real parser passes the net.
    expect(write(TEXT, keep('id', 'name'))).toBe(`Table gold.t {\n  id int\n  name varchar\n\n  records (id, name) {\n    1, '${SENTINEL}'\n    2, 'b'\n  }\n}\n`);
  });

  it('a rename plus a drop in one edit passes the net (read as a drop plus an add)', () => {
    const out = write(TEXT, (t) => { t.columns = [t.columns![0], { ...t.columns![1], name: 'label' }]; });
    expect(out).toBe('Table gold.t {\n  id int\n  label varchar\n\n  records (id) {\n    1\n    2\n  }\n}\n');
  });

  it('a table rename and a move are read back under their new name and schema folder', () => {
    expect(write(TEXT, (t) => { t.name = 'renamed'; }, { rename: true })).toBe(TEXT.replace('gold.t {', 'gold.renamed {'));
    expect(write(TEXT, (t) => { t.schema = 'silver'; }, { requalify: true, schemaFolder: 'gold' })).toBe(TEXT.replace('gold.t {', 'silver.t {'));
  });
});

describe('the writers never read the sidecar', () => {
  const sidecar: SampleData = { columns: ['id', 'name'], rows: [[{ text: SENTINEL, kind: 'string' }, null]], totalRows: 1 };

  it('editTableDbml writes the file\'s own rows, never sampleData', () => {
    const text = `${HEAD}  records (id, name) {\n    1, 'a'\n  }\n}\n`;
    const desired: TableWithSampleData = { ...clone(readTable(text, 't').table), sampleData: sidecar };
    expect(tableSampleDataOf(desired)).toBe(sidecar);
    expect(editTableDbml(text, desired)).toBe(text);
    desired.columns!.push({ name: 'extra', dataType: 'int', description: '' });
    expect(editTableDbml(text, desired)).not.toContain(SENTINEL);
    const bare = 'Table gold.t {\n  id int\n}\n';
    expect(editTableDbml(bare, { ...readTable(bare, 't').table, sampleData: sidecar } as TableWithSampleData)).toBe(bare);
  });

  it('renderNewTableDbml writes no rows from sampleData', () => {
    const table: TableWithSampleData = { name: 't', schema: 'gold', columns: [{ name: 'id', dataType: 'int', description: '' }], sampleData: sidecar };
    const out = renderNewTableDbml(table);
    expect(out).toBe('Table gold.t {\n  id int\n}\n');
    expect(out).not.toMatch(/records/i);
  });

  it('a reading carries no sidecar yet, and the row cap is 100', () => {
    const reading = parseTableDbml(`${HEAD}  records (id) {\n    1\n  }\n}\n`, 't');
    expect(reading.ok && tableSampleDataOf(reading.table)).toBe(undefined);
    expect(SAMPLE_ROWS_LIMIT).toBe(100);
  });
});

describe('recordsSpansOf', () => {
  it('a nested block: the keyword, the body and the closing brace; its line', () => {
    const text = `${HEAD}  records (id, name) {\n    1, 'a'\n  }\n}\n`;
    const start = text.indexOf('records');
    expect(recordsSpansOf(text)).toEqual([{ start, bodyStart: text.indexOf('{', start), end: text.indexOf('}', start) + 1, line: 6, nested: true }]);
  });

  it('a top-level Records block, and a block left open to the end of the file', () => {
    const top = "Table gold.t {\n  id int\n}\nRecords gold.t(id) {\n  1\n}\n";
    expect(recordsSpansOf(top)).toEqual([{ start: top.indexOf('Records'), bodyStart: top.indexOf('{', top.indexOf('Records')), end: top.lastIndexOf('}') + 1, line: 4, nested: false }]);
    const open = 'Table gold.t {\n  id int\n  records (id) {\n    1\n';
    expect(recordsSpansOf(open)).toMatchObject([{ start: open.indexOf('records'), end: open.length, nested: true }]);
  });

  it('a block whose row does not parse still has its span, holding the parser\'s error', () => {
    const text = `${HEAD}  records (id, name) {\n    1, 'O'Brien'\n  }\n}\n`;
    const [span] = recordsSpansOf(text);
    const errors = compileOne(text).errors;
    expect(errors.length).toBeGreaterThan(0);
    for (const e of errors) expect(e.start >= span.bodyStart && e.start < span.end).toBe(true);
  });

  it('offsets count a byte-order mark; no block, a column named records, and text without the word give none', () => {
    const text = `${HEAD}  records (id) {\n    1\n  }\n}\n`;
    const [plain] = recordsSpansOf(text);
    const [bom] = recordsSpansOf(`﻿${text}`);
    expect(bom).toEqual({ ...plain, start: plain.start + 1, bodyStart: plain.bodyStart + 1, end: plain.end + 1 });
    expect(lineAt(text, plain.start)).toBe(plain.line);
    expect(recordsSpansOf('Table gold.t {\n  records int\n}\n')).toEqual([]);
    expect(recordsSpansOf('Table gold.t {\n  id int\n}\n')).toEqual([]);
  });
});
