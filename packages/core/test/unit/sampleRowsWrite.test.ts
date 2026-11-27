/**
 * Writing sample rows (D37) into a block of its own: `renderRecordsBlock`
 * (the one writer of row text), `sampleCellAsText` (an enum reference as
 * text) and the order that keeps a row after the first from starting with a
 * sign; `renderNewTableDbml` with rows (a new table file, as Import writes
 * it), read back by all three parsers and left alone by the formatter; and
 * `readRecordsBlocks`, which reads every block's values for Import. Values
 * are invented.
 */
import { describe, expect, it } from 'vitest';

import { renderRecordsBlock, sampleCellAsText, sampleRowsWriteOrder } from '../../src/sampleRows';
import { renderNewTableDbml } from '../../src/dbml/writeTable';
import { parseTableDbml } from '../../src/dbml/readTable';
import { readRecordsBlocks } from '../../src/dbml/records';
import { formatDbml } from '../../src/dbml/format';
import { tableSampleDataOf, type SampleCell, type SampleData, type SemanticTable } from '../../src/types/semantic';
import { STORAGE_PARSERS } from '../dbmlParsers';
import { cleanEverywhere, projectDiagnostics } from '../dbmlWriterSupport';

const str = (text: string): SampleCell => ({ text, kind: 'string' });
const num = (text: string): SampleCell => ({ text, kind: 'number' });
const en = (text: string): SampleCell => ({ text, kind: 'enum' });

describe('sampleCellAsText', () => {
  it('an enum reference becomes a string of its last segment', () => {
    expect(sampleCellAsText(en('status.active'))).toEqual(str('active'));
    expect(sampleCellAsText(en('sales.status.shipped'))).toEqual(str('shipped'));
    expect(sampleCellAsText(en('status."in progress"'))).toEqual(str('in progress'));
    expect(sampleCellAsText(en('"s.x"."a.b"'))).toEqual(str('a.b'));
    expect(sampleCellAsText(en('st."say \\"hi\\""'))).toEqual(str('say "hi"'));
  });

  it('every other cell is returned as it is', () => {
    for (const cell of [str('a.b'), num('-1.50'), { text: 'TRUE', kind: 'boolean' } as SampleCell, { text: '`now()`', kind: 'expression' } as SampleCell]) {
      expect(sampleCellAsText(cell)).toBe(cell);
    }
  });
});

describe('sampleRowsWriteOrder', () => {
  it('keeps the order when the first column has no signed value after the first row', () => {
    expect(sampleRowsWriteOrder(2, [[num('-1'), num('2')], [num('3'), num('-4')]])).toEqual({ order: [0, 1], rows: [0, 1], leftOut: 0 });
  });

  it('leads with the first column that has none', () => {
    expect(sampleRowsWriteOrder(3, [[num('1'), num('2'), num('3')], [num('-1'), num('+2'), str('-x')]])).toEqual({ order: [2, 0, 1], rows: [0, 1], leftOut: 0 });
  });

  it('when no column can lead, leaves out each later row whose first value is signed, and counts them', () => {
    const rows = [[num('-1'), num('-2')], [num('-3'), num('4')], [num('5'), num('-6')], [num('+7'), num('8')]];
    expect(sampleRowsWriteOrder(2, rows)).toEqual({ order: [0, 1], rows: [0, 2], leftOut: 2 });
  });

  it('a null, a string or an enum reference is never signed', () => {
    expect(sampleRowsWriteOrder(1, [[num('1')], [null], [str('-1')], [en('s.minus')]]).leftOut).toBe(0);
  });
});

describe('renderRecordsBlock', () => {
  it('always writes the column list; every kind of cell reads back as itself', () => {
    const block = renderRecordsBlock(
      ['id', 'note', 'amount', 'flag', 'at', 'status', 'two words'],
      [
        [num('1'), str("it's \\ here"), num('1.50'), { text: 'TRUE', kind: 'boolean' }, { text: '`now()`', kind: 'expression' }, en('status.placed'), null],
        [num('2'), str('two\nlines'), num('-0.0'), null, null, null, str('')],
      ],
    );
    expect(block).toEqual({
      text: [
        '  records (id, "note", amount, flag, at, status, "two words") {',
        "    1, 'it\\'s \\\\ here', 1.50, TRUE, `now()`, 'placed', null",
        "    2, '''two\nlines''', -0.0, null, null, null, ''",
        '  }',
      ].join('\n'),
      leftOut: 0,
    });
  });

  it('writes a carriage return as \\r, so a row never holds a bare one', () => {
    expect(renderRecordsBlock(['a'], [[str('x\ry')]]).text).toContain("'x\\ry'");
  });

  it('orders the list so no later row starts with a sign, and leaves out what cannot be helped', () => {
    expect(renderRecordsBlock(['a', 'b'], [[num('1'), num('2')], [num('-1'), num('3')]]).text)
      .toBe('  records (b, a) {\n    2, 1\n    3, -1\n  }');
    expect(renderRecordsBlock(['a', 'b'], [[num('1'), num('2')], [num('-1'), num('-3')], [num('4'), num('5')]]))
      .toEqual({ text: '  records (a, b) {\n    1, 2\n    4, 5\n  }', leftOut: 1 });
  });

  it('nothing for no column or no row', () => {
    expect(renderRecordsBlock([], [[num('1')]])).toEqual({ text: '', leftOut: 0 });
    expect(renderRecordsBlock(['a'], [])).toEqual({ text: '', leftOut: 0 });
  });

  it('with comments: the rows beyond those given, and the rows left out, counted (no value)', () => {
    const rows = [[num('1')], [num('-2')], [num('-3')]];
    expect(renderRecordsBlock(['a'], rows, '  ', '\r\n', { comments: true, totalRows: 120 }).text).toBe([
      '  records (a) {',
      '    1',
      '    // 117 more rows are in the table file',
      '    // 2 rows left out: DBML 9 and 10 read no row that starts with a sign',
      '  }',
    ].join('\r\n'));
    expect(renderRecordsBlock(['a'], [[num('1')], [num('-2')]], '', '\n', { comments: true, totalRows: 3 }).text)
      .toBe('records (a) {\n  1\n  // 1 more row is in the table file\n  // 1 row left out: DBML 9 and 10 read no row that starts with a sign\n}');
  });
});

describe('renderNewTableDbml with sample rows', () => {
  const table: SemanticTable = {
    name: 'fct_order',
    schema: 'sales',
    description: 'Orders',
    columns: [
      { name: 'order_id', dataType: 'int', description: '', isPrimaryKey: true },
      { name: 'line_no', dataType: 'int', description: '', isPrimaryKey: true },
      { name: 'amount', dataType: 'decimal(10,2)', description: '' },
      { name: 'note', dataType: 'text', description: '' },
      { name: 'status', dataType: 'varchar', description: '' },
    ],
  };
  const sampleData: SampleData = {
    columns: ['order_id', 'line_no', 'amount', 'note', 'status', 'gone'],
    rows: [
      [num('1'), num('1'), num('1.50'), str("it's a gift"), en('status.placed'), str('dropped')],
      [num('1'), num('2'), num('-0.25'), str('two\nlines'), null, str('dropped')],
      [num('2'), num('1'), num('12.00'), null, en('status.shipped'), str('dropped')],
    ],
    totalRows: 3,
  };

  it('writes the block after the columns and the indexes, with an explicit list of the columns the table has', () => {
    const out = renderNewTableDbml(table, { sampleData });
    expect(out).toBe([
      'Table sales.fct_order {',
      "  Note: 'Orders'",
      '',
      '  order_id int',
      '  line_no int',
      '  amount "decimal(10,2)"',
      '  "note" text',
      '  status varchar',
      '  indexes {',
      '    (order_id, line_no) [pk]',
      '  }',
      '',
      '  records (order_id, line_no, amount, "note", status) {',
      "    1, 1, 1.50, 'it\\'s a gift', 'placed'",
      "    1, 2, -0.25, '''two\nlines''', null",
      "    2, 1, 12.00, null, 'shipped'",
      '  }',
      '}',
      '',
    ].join('\n'));
    expect(out).not.toContain('dropped');
  });

  it('is read back by all three parsers as the same rows (an enum reference as text), with no diagnostic', () => {
    const out = formatDbml(renderNewTableDbml(table, { sampleData })).text;
    expect(cleanEverywhere({ 'sales/tables/sales/fct_order.dbml': out }), JSON.stringify(projectDiagnostics({ 'sales/tables/sales/fct_order.dbml': out }))).toBe(true);
    for (const [label, parser] of STORAGE_PARSERS) {
      const reading = parseTableDbml(out, 'fct_order', { schemaFolder: 'sales', sampleData: true }, parser);
      expect(reading.ok && reading.writable, label).toBe(true);
      if (!reading.ok) continue;
      expect(tableSampleDataOf(reading.table), label).toEqual({
        columns: ['order_id', 'line_no', 'amount', 'note', 'status'],
        rows: sampleData.rows.map((row) => row.slice(0, 5).map((c) => (c ? sampleCellAsText(c) : null))),
        totalRows: 3,
      });
    }
  });

  it('is a fixed point of the formatter, which leaves the block as written', () => {
    const raw = renderNewTableDbml(table, { sampleData });
    const once = formatDbml(raw).text;
    expect(formatDbml(once).text).toBe(once);
    const block = (text: string): string => text.slice(text.indexOf('  records'), text.lastIndexOf('}'));
    expect(block(once)).toBe(block(raw));
  });

  it('a later row that would start with a sign: another column leads', () => {
    const out = renderNewTableDbml({ name: 't', schema: 'gold', columns: [{ name: 'delta', dataType: 'int', description: '' }, { name: 'id', dataType: 'int', description: '' }] },
      { sampleData: { columns: ['delta', 'id'], rows: [[num('1'), num('1')], [num('-1'), num('2')]], totalRows: 2 } });
    expect(out).toContain('  records (id, delta) {\n    1, 1\n    2, -1\n  }');
    for (const [label, parser] of STORAGE_PARSERS) expect(parseTableDbml(out, 't', { schemaFolder: 'gold' }, parser).ok, label).toBe(true);
  });

  it('no block for no row, or no column the table has; never from the table\'s own sidecar', () => {
    const bare = 'Table gold.t {\n  id int\n}\n';
    const t: SemanticTable = { name: 't', schema: 'gold', columns: [{ name: 'id', dataType: 'int', description: '' }] };
    expect(renderNewTableDbml(t, { sampleData: { columns: ['id'], rows: [], totalRows: 0 } })).toBe(bare);
    expect(renderNewTableDbml(t, { sampleData: { columns: ['other'], rows: [[num('1')]], totalRows: 1 } })).toBe(bare);
    expect(renderNewTableDbml({ ...t, columns: [] }, { sampleData: { columns: ['id'], rows: [[num('1')]], totalRows: 1 } })).not.toMatch(/records/);
    expect(renderNewTableDbml({ ...t, sampleData: { columns: ['id'], rows: [[num('1')]], totalRows: 1 } } as SemanticTable)).toBe(bare);
  });
});

describe('readRecordsBlocks', () => {
  const text = [
    'Table gold.t {',
    '  id int',
    '  name varchar',
    '  records {',
    "    1, 'a'",
    '    2,',
    '  }',
    '}',
    'Table gold.u {',
    '  id int',
    '}',
    'Records gold.u(id) {',
    '  007',
    '}',
    '',
  ].join('\n');

  it('every block, nested and top-level, its values as written, with no list (the caller has the parser\'s)', () => {
    expect(readRecordsBlocks(text)).toEqual([
      { start: text.indexOf('records'), line: 4, nested: true, rows: [[num('1'), str('a')], [num('2'), null]], totalRows: 2 },
      { start: text.indexOf('Records'), line: 12, nested: false, rows: [[num('007')]], totalRows: 1 },
    ]);
  });

  it('offsets count a byte-order mark; a limit keeps the first rows and counts the rest', () => {
    expect(readRecordsBlocks(`﻿${text}`)[0].start).toBe(text.indexOf('records') + 1);
    expect(readRecordsBlocks(text, 1)[0]).toMatchObject({ rows: [[num('1'), str('a')]], totalRows: 2 });
  });

  it('a text with no block, or one the parser cannot read, gives none', () => {
    expect(readRecordsBlocks('Table t {\n  id int\n}\n')).toEqual([]);
    expect(readRecordsBlocks('')).toEqual([]);
  });
});
