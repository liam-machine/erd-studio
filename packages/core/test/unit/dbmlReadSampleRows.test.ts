/**
 * Sample rows (D37) on read: a table file's nested `records` block, read by
 * `parseTableDbml` in 9.1.1, 10.3.1 and 11.0.0.
 *
 * - With `sampleData: true` the table carries its rows as an enumerable
 *   `sampleData`: each value from its token's source text (never the
 *   interpreted database, which turns 007 into 7), its kind from the token,
 *   at most `SAMPLE_ROWS_LIMIT` rows and the total counted. Off by default,
 *   and then the reading is exactly what it was before rows were read.
 * - A block that does not read (every syntax error, and at least one error,
 *   inside a block) no longer hides the table: it loads without its rows,
 *   not writable, with a `recordsUnreadable` warning naming the block's line.
 *   A block open to the end of the file, or a syntax error outside every
 *   block, still makes the file unreadable, as before.
 * - The table writer refuses such a table (R1), naming the file and line.
 */
import { describe, expect, it } from 'vitest';

import { parseTableDbml } from '../../src/dbml/readTable';
import { editTableDbml } from '../../src/dbml/writeTable';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { dbmlStorageReader } from '../../src/dbml/index';
import { toDisplaySubjectArea } from '../../src/displayDomain';
import { SAMPLE_ROWS_LIMIT, tableSampleDataOf, type SampleCell, type SampleData, type SemanticTable } from '../../src/types/semantic';
import type { DbmlTableReading } from '../../src/types/dbmlStorage';
import { STORAGE_PARSERS } from '../dbmlParsers';

type Ok = Extract<DbmlTableReading, { ok: true }>;

const s = (text: string): SampleCell => ({ text, kind: 'string' });
const n = (text: string): SampleCell => ({ text, kind: 'number' });
const b = (text: string): SampleCell => ({ text, kind: 'boolean' });

/** Every value kind a block may hold. No row after the first starts with a sign (DBML 9 and 10 reject one). */
const KINDS = [
  'Enum gold.st {',
  '  active',
  '}',
  '',
  'Table gold.t {',
  '  a varchar',
  '  b varchar',
  '  c varchar',
  '',
  '  records (a, b, c) {',
  '    007, "dq", gold.st.active',
  '    1.50, -0, NuLL',
  "    1e3, '''two",
  "lines''', TRUE",
  '    12345678901234567890, , `now()`',
  "    0, 'it\\'s', false",
  "    2, '', null",
  '  }',
  '}',
  '',
].join('\n');

const KIND_ROWS: SampleData['rows'] = [
  [n('007'), s('dq'), { text: 'gold.st.active', kind: 'enum' }],
  [n('1.50'), n('-0'), null],
  [n('1e3'), s('two\nlines'), b('TRUE')],
  [n('12345678901234567890'), null, { text: '`now()`', kind: 'expression' }],
  [n('0'), s("it's"), b('false')],
  [n('2'), s(''), null],
];

function readOk(text: string, options: { sampleData?: boolean } = {}, parser = STORAGE_PARSERS[2][1], stem = 't'): Ok {
  const reading = parseTableDbml(text, stem, { schemaFolder: 'gold', ...options }, parser);
  if (!reading.ok) throw new Error(`expected ${stem} to read: ${reading.error.message}`);
  return reading;
}

const HEAD = 'Table gold.t {\n  id int [pk]\n  name varchar\n  amount decimal\n\n';

describe.each(STORAGE_PARSERS)('the rows a reading carries (%s)', (_label, parser) => {
  it('every value kind, as written: numbers, strings, null and booleans in any case, an expression, an enum reference, empty fields', () => {
    const reading = readOk(KINDS, { sampleData: true }, parser);
    expect(tableSampleDataOf(reading.table)).toEqual({ columns: ['a', 'b', 'c'], rows: KIND_ROWS, totalRows: 6 });
  });

  it('the same in a CRLF file with a byte-order mark (a line break inside a string reads as \\n)', () => {
    const reading = readOk(`﻿${KINDS.replace(/\n/g, '\r\n')}`, { sampleData: true }, parser);
    expect(tableSampleDataOf(reading.table)).toEqual({ columns: ['a', 'b', 'c'], rows: KIND_ROWS, totalRows: 6 });
  });

  it('a block with no list holds every column in file order; a one-name list holds that column', () => {
    const none = readOk(`${HEAD}  records {\n    1, 'a', 1.5\n    2, , -2.5\n  }\n}\n`, { sampleData: true }, parser);
    expect(tableSampleDataOf(none.table)).toEqual({ columns: ['id', 'name', 'amount'], rows: [[n('1'), s('a'), n('1.5')], [n('2'), null, n('-2.5')]], totalRows: 2 });
    const one = readOk(`${HEAD}  records (name) {\n    'a'\n    "b"\n  }\n}\n`, { sampleData: true }, parser);
    expect(tableSampleDataOf(one.table)).toEqual({ columns: ['name'], rows: [[s('a')], [s('b')]], totalRows: 2 });
    const quoted = readOk(`${HEAD}  records ("amount", id) {\n    1.5, 1\n  }\n}\n`, { sampleData: true }, parser);
    expect(tableSampleDataOf(quoted.table)?.columns).toEqual(['amount', 'id']);
  });

  it('nothing to show: an empty list, a block with no row, no block', () => {
    for (const text of [
      `${HEAD}  records () {\n  }\n}\n`,
      `${HEAD}  records (id, name) {\n  }\n}\n`,
      `${HEAD}}\n`,
    ]) {
      const reading = readOk(text, { sampleData: true }, parser);
      expect(Object.keys(reading.table)).not.toContain('sampleData');
    }
  });

  it(`at most ${SAMPLE_ROWS_LIMIT} rows, with every row counted`, () => {
    const rows = Array.from({ length: SAMPLE_ROWS_LIMIT + 5 }, (_, i) => `    ${i + 1}, 'r${i + 1}'\n`).join('');
    const data = tableSampleDataOf(readOk(`${HEAD}  records (id, name) {\n${rows}  }\n}\n`, { sampleData: true }, parser).table)!;
    expect(data.rows).toHaveLength(SAMPLE_ROWS_LIMIT);
    expect(data.totalRows).toBe(SAMPLE_ROWS_LIMIT + 5);
    expect(data.rows[SAMPLE_ROWS_LIMIT - 1]).toEqual([n(String(SAMPLE_ROWS_LIMIT)), s(`r${SAMPLE_ROWS_LIMIT}`)]);
  });

  it('a block among the columns, and a table that is not writable for another reason (a use line), still carry their rows', () => {
    const first = readOk(`Table gold.t {\n  records (id) {\n    1\n  }\n  id int [pk]\n}\n`, { sampleData: true }, parser);
    expect(tableSampleDataOf(first.table)?.rows).toEqual([[n('1')]]);
    const withUse = readOk(`use { table gold.x } from './x.dbml'\n${HEAD}  records (id) {\n    1\n  }\n}\n`, { sampleData: true }, parser);
    expect(withUse.writable).toBe(false);
    expect(tableSampleDataOf(withUse.table)?.rows).toEqual([[n('1')]]);
  });

  it('off by default: the reading is exactly the reading of the file without its block', () => {
    const block = "  records (id, name, amount) {\n    1, 'a', 1.5\n    2, , -2.5\n  }\n";
    const text = `${HEAD}${block}}\n`;
    const without = parseTableDbml(`${HEAD}}\n`, 't', { schemaFolder: 'gold' }, parser);
    for (const options of [{ schemaFolder: 'gold' }, { schemaFolder: 'gold', sampleData: false }]) {
      expect(JSON.stringify(parseTableDbml(text, 't', options, parser))).toBe(JSON.stringify(without));
    }
    // The reader object passes the option through, and leaves it off unless asked.
    expect(JSON.stringify(dbmlStorageReader.parseTable(text, 't', { schemaFolder: 'gold' }))).toBe(JSON.stringify(parseTableDbml(`${HEAD}}\n`, 't', { schemaFolder: 'gold' })));
    const asked = dbmlStorageReader.parseTable(text, 't', { schemaFolder: 'gold', sampleData: true });
    expect(asked.ok && tableSampleDataOf(asked.table)?.totalRows).toBe(2);
  });

  it('the sidecar is an ordinary enumerable property, kept by a spread and a structured clone', () => {
    const table = readOk(`${HEAD}  records (id) {\n    1\n  }\n}\n`, { sampleData: true }, parser).table;
    expect(Object.keys(table)).toContain('sampleData');
    expect(tableSampleDataOf({ ...table })).toEqual(tableSampleDataOf(table));
    expect(tableSampleDataOf(structuredClone(table) as SemanticTable)).toEqual(tableSampleDataOf(table));
  });
});

/** The reader's problem for a block that does not read, by its line. */
const unreadable = (line: number) => ({
  code: 'recordsUnreadable',
  severity: 'warning',
  line,
  message: `Line ${line}: the sample data (records) does not read as DBML, so it is not shown. Other DBML tools reject this file, and ERD Studio will not edit this table until the rows are fixed or removed.`,
});

/** A table whose block (keyword on line 6) holds `row`. */
const broken = (row: string, list: string): string => `${HEAD}  records ${list} {\n    1, 'a', 1.5\n${row}  }\n}\n`;

/** Blocks a script is likely to break, each loading the table without its rows. */
const LOADS_WITHOUT_ROWS: Record<string, string> = {
  "an unescaped apostrophe ('O'Brien')": broken("    2, 'O'Brien', 2.5\n", '(id, name, amount)'),
  "SQL-style '' escaping": broken("    2, 'O''Brien', 2.5\n", '(id, name, amount)'),
  'a bare word with a space': broken('    2, jane doe, 2.5\n', '(id, name, amount)'),
  'a dotted bare word (an enum that does not exist)': broken('    2, jane.doe, 2.5\n', '(id, name, amount)'),
  'a raw line break in a string': broken("    2, 'a\nb', 2.5\n", '(id, name, amount)'),
  'a short row': broken('    2, 2.5\n', '(id, name, amount)'),
  'a list naming a column the table lacks (2.0.10 after a drop)': broken("    2, 'b', 2.5\n", '(id, name, gone)'),
  'a value in the header': broken("    2, 'b', 2.5\n", '(id, "x@y", amount)'),
};

describe.each(STORAGE_PARSERS)('a block that does not read (%s)', (_label, parser) => {
  for (const [shape, text] of Object.entries(LOADS_WITHOUT_ROWS)) {
    it(`${shape}: the table loads with its columns, without its rows, read-only, warned by line`, () => {
      const reading = readOk(text, { sampleData: true }, parser);
      expect(reading.table.columns?.map((c) => c.name)).toEqual(['id', 'name', 'amount']);
      expect(reading.writable).toBe(false);
      expect(reading.problems).toEqual([unreadable(6)]);
      expect(Object.keys(reading.table)).not.toContain('sampleData');
      expect(JSON.stringify(reading)).not.toMatch(/O'?'?Brien|jane|x@y/);
    });
  }

  it('two blocks: both are left out, and each one an error lies in is named', () => {
    const reading = readOk(`${HEAD}  records (id) {\n    1\n  }\n  records (id) {\n    2\n  }\n}\n`, { sampleData: true }, parser);
    expect(reading.writable).toBe(false);
    expect(reading.problems.every((p) => p.code === 'recordsUnreadable')).toBe(true);
    expect(reading.problems.map((p) => p.line)).toContain(9);
    expect(Object.keys(reading.table)).not.toContain('sampleData');
  });

  it('a block before the columns, in a CRLF file with a byte-order mark: the same, by the block\'s own line', () => {
    const text = `﻿Table gold.t {\r\n  records (id, name) {\r\n    1, 'O'Brien'\r\n  }\r\n  id int [pk]\r\n  name varchar\r\n}\r\n`;
    const reading = readOk(text, {}, parser);
    expect(reading.table.columns?.map((c) => c.name)).toEqual(['id', 'name']);
    expect(reading.problems).toEqual([unreadable(2)]);
  });

  it('beside a use line: both are reported, and the table reads', () => {
    const reading = readOk(`use { table gold.x } from './x.dbml'\n${HEAD}  records (id, name) {\n    1, jane doe\n  }\n}\n`, {}, parser);
    expect(reading.writable).toBe(false);
    expect(reading.problems.map((p) => [p.code, p.line])).toEqual([['useInTableFile', 1], ['recordsUnreadable', 7]]);
  });

  it("a block open to the end of the file (an unclosed ''') or a Table left unclosed: still unreadable, in fixed words", () => {
    for (const text of [broken("    2, '''abc\n", '(id, name, amount)'), `${HEAD}  records (id, name) {\n    1, 'O'Brien'\n}\n`]) {
      const reading = parseTableDbml(text, 't', { schemaFolder: 'gold' }, parser);
      expect(reading.ok).toBe(false);
      if (!reading.ok) expect(reading.error.message).toMatch(/^Line \d+, column \d+: a value in the sample data \(records\) does not read as DBML \[\d+\]\.$/);
    }
  });

  it('a syntax error outside every block: unreadable, as before', () => {
    const reading = parseTableDbml(`Table gold.t {\n  id int [pk]\n  name varchar(10\n\n  records (id, name) {\n    1, 'O'Brien'\n  }\n}\n`, 't', { schemaFolder: 'gold' }, parser);
    expect(reading.ok).toBe(false);
  });

  it('R1: the writer refuses the table, naming the file and the block\'s line, and changes nothing', () => {
    for (const text of Object.values(LOADS_WITHOUT_ROWS)) {
      const reading = readOk(text, {}, parser);
      for (const desired of [reading.table, { ...reading.table, description: 'changed' }]) {
        let err: unknown;
        try {
          editTableDbml(text, desired, { fileStem: 't', file: 'gold/tables/gold/t.dbml', schemaFolder: 'gold', parser });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(DbmlEditRefused);
        expect((err as DbmlEditRefused).message).toBe(
          'gold/tables/gold/t.dbml: the sample data (records) on line 6 does not read as DBML. Fix or remove it in the file; ERD Studio will not edit this table until it reads.',
        );
        expect((err as DbmlEditRefused).line).toBe(6);
      }
    }
  });

  it('R1 waits behind a use line\'s refusal, which names what to move first', () => {
    const text = `use { table gold.x } from './x.dbml'\n${HEAD}  records (id, name) {\n    1, jane doe\n  }\n}\n`;
    expect(() => editTableDbml(text, readOk(text, {}, parser).table, { fileStem: 't', file: 't.dbml', schemaFolder: 'gold', parser })).toThrow(/^t\.dbml: A table file needs no other file/);
  });
});

describe('the display copies the rows, and only the rows a reading carried', () => {
  it('a table read with rows draws them; a table without (YAML, or read without them) has no sampleData key', () => {
    const withRows = readOk(`${HEAD}  records (id, name) {\n    1, 'a'\n  }\n}\n`, { sampleData: true }).table;
    const without = readOk(`${HEAD}  records (id, name) {\n    1, 'a'\n  }\n}\n`).table;
    const yaml: SemanticTable = { name: 'y', schema: 'gold', columns: [{ name: 'id', dataType: 'int', description: '' }] };
    const display = toDisplaySubjectArea(
      { schemaVersion: 7, domain: 'd', layer: 'gold', stage: 'logical', description: '', models: [withRows, { ...without, name: 'u' }, yaml], relationships: [] },
      { viewConfig: {}, layerConfig: undefined, readOnly: false },
    );
    expect(display.models[0].sampleData).toEqual({ columns: ['id', 'name'], rows: [[n('1'), s('a')]], totalRows: 1 });
    expect(Object.keys(display.models[0]).pop()).toBe('sampleData');
    expect(Object.keys(display.models[1])).not.toContain('sampleData');
    expect(Object.keys(display.models[2])).not.toContain('sampleData');
  });
});
