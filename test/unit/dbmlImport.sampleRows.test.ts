/**
 * Import DBML keeps the sample rows (D37, `Records`) of the tables it
 * creates in a DBML project: read from the file by token, matched to the
 * table the parser resolved (nested, top-level, by alias, `public`, a
 * `records {` with a partial's column), columns renamed as the table's are,
 * an enum reference written as text, at most `SAMPLE_ROWS_LIMIT` rows, rows
 * that would start a later line with a sign left out; shown in the draft;
 * reported by table names and counts only. Rows for a reused library table
 * or a YAML project are reported as not imported. Values are invented.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYERS, SAMPLE_ROWS_LIMIT, type SampleCell, type SampleData } from '@erd-studio/core';

import {
  describeDbmlImportPlan,
  importLeftOut,
  importLedgerOf,
  importPlanNotes,
  planDbmlImport,
  summariseDbmlImportPlan,
  type DbmlImportLibrary,
  type DbmlImportPlan,
  type PlanDbmlImportInput,
} from '../../src/services/dbmlImport';
import { DEFAULT_ENTRY, MemoryProjectLayout } from '@dbml/parse';
import { readDbml } from '../../src/services/dbmlImportParse';
import { draftFromImportPlan } from '../../src/services/draftModel';
import type { SemanticTable } from '../../src/types/semantic';

const FIXTURE = fs.readFileSync(path.resolve(__dirname, '../fixtures/dbml/foreign/sample-data.dbml'), 'utf-8');
/** Every value the fixture holds that a report could echo (the numbers are too short to tell). */
const VALUES = ['gift', 'two\nlines', 'lines', 'Harbour', 'Hilltop', 'Blue widget', 'Red gadget', 'now()', '2024-01-02', 'placed', 'shipped', '1.50', '-0.0', '12.00', '007'];

const str = (text: string): SampleCell => ({ text, kind: 'string' });
const num = (text: string): SampleCell => ({ text, kind: 'number' });

const EMPTY: DbmlImportLibrary = { findTableName: () => null, getTable: () => null };

/** Import DBML's plan for a fresh DBML project (as the command plans it), or a YAML one with `sampleRows: false`. */
function plan(text: string, extra: Partial<PlanDbmlImportInput> = {}): DbmlImportPlan {
  const read = readDbml(text);
  if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
  return planDbmlImport({
    model: read.model,
    layer: 'gold',
    subjectAreaName: 'shop',
    fileName: 'shop.dbml',
    library: EMPTY,
    libraryRelationships: true,
    diagramHoldsNoRelationships: true,
    schemaScopedNames: true,
    sampleRows: true,
    ...extra,
  });
}

const rowsOf = (p: DbmlImportPlan, name: string): SampleData | undefined => {
  const table = p.newTables.find((t) => t.name === name);
  if (!table) throw new Error(`no new table ${name}`);
  return p.sampleData?.get(table);
};

/** Every string the import shows about itself: the report, its notes and left-out lines, the dry run and the modal. */
function reportStrings(p: DbmlImportPlan): string {
  const describe = { dbml: { relationshipsFiles: [] } };
  return JSON.stringify([
    p.report, importLedgerOf(p, describe), importPlanNotes(p, describe), importLeftOut(p, describe),
    describeDbmlImportPlan(p, describe), summariseDbmlImportPlan(p, describe),
  ]);
}

describe('a DBML project keeps the rows of the tables it creates', () => {
  const p = plan(FIXTURE);

  it('every block, nested and top-level, by the table the parser resolved: columns renamed, values as written, an enum as text', () => {
    expect(p.newTables.map((t) => t.name)).toEqual(['orders', 'customers', 'Order_Items', 'products']);
    expect(rowsOf(p, 'orders')).toEqual({
      columns: ['id', 'amount', 'status', 'note', 'customer_id'],
      rows: [
        [num('1'), num('1.50'), str('placed'), str("it's a gift"), num('10')],
        [num('2'), num('-0.0'), str('shipped'), str('two\nlines'), num('11')],
        [num('3'), num('12.00'), null, { text: '`now()`', kind: 'expression' }, num('10')],
      ],
      totalRows: 3,
    });
    // `records {`: every column, the partial's injected one too; an empty field is null.
    expect(rowsOf(p, 'customers')).toEqual({
      columns: ['id', 'name', 'created_at'],
      rows: [[num('10'), str('Harbour Stores'), str('2024-01-02 03:04:05')], [num('11'), str('Hilltop Traders'), null]],
      totalRows: 2,
    });
    // A top-level block naming a table the import renames, and a column it renames: the new names.
    expect(rowsOf(p, 'Order_Items')).toEqual({ columns: ['line_no', 'qty'], rows: [[num('1'), num('5')], [num('2'), num('007')]], totalRows: 2 });
    // A top-level block by the table's alias, its list in its own order.
    expect(rowsOf(p, 'products')).toEqual({ columns: ['name', 'id'], rows: [[str('Blue widget'), num('1')], [str('Red gadget'), num('2')]], totalRows: 2 });
  });

  it('says so in a note, with how many enum values became text; names and counts only', () => {
    expect(p.report.notes).toEqual(expect.arrayContaining([
      'Sample data kept for 4 tables (orders, customers, Order_Items, products).',
      '2 sample values that named an enum were written as text.',
    ]));
    expect(p.report.dropped.filter((d) => d.kind === 'records')).toEqual([]);
    const shown = reportStrings(p);
    for (const value of VALUES) expect(shown, value).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  it('no ledger entry: the telemetry the ledger feeds is unchanged', () => {
    const without = plan(FIXTURE.replace(/\n\s*records \([^)]*\) \{[\s\S]*?\n  \}\n/, '\n').replace(/Records [\s\S]*?\n\}\n/g, ''));
    expect(p.report.ledger).toEqual(without.report.ledger);
  });

  it('the draft draws the rows of the tables it creates, and of no other', () => {
    const libraryTable: SemanticTable = { name: 'products', schema: 'sales', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }, { name: 'name', dataType: 'varchar', description: '' }] };
    const library: DbmlImportLibrary = {
      findTableName: (n) => (n.toLowerCase() === 'products' ? 'products' : null),
      getTable: (n) => (n.toLowerCase() === 'products' ? libraryTable : null),
    };
    const reused = plan(FIXTURE, { library, schemaScopedNames: false });
    expect(reused.reusedTables).toEqual(['products']);
    const draft = draftFromImportPlan({
      plan: reused,
      importSource: 'file',
      trigger: 'palette',
      target: { layer: 'gold', layerLabel: 'Gold', name: 'shop', diagramFile: '.erd-studio/gold/diagrams/shop.dbml' },
      fileName: 'shop.dbml',
      describe: { layerLabel: 'Gold', dbml: { relationshipsFiles: [] } },
      // A library read carries the table's own rows: a draft drops them.
      libraryTable: (n) => (n === 'products' ? { ...libraryTable, sampleData: { columns: ['id'], rows: [[num('99')]], totalRows: 1 } } as SemanticTable : undefined),
      layers: DEFAULT_LAYERS,
      logicalOnly: true,
      hasFolder: true,
      changeOptions: false,
    });
    const shown = Object.fromEntries(draft.display.models.map((m) => [m.name, m.sampleData]));
    expect(shown.orders?.rows).toHaveLength(3);
    expect(shown.customers?.columns).toEqual(['id', 'name', 'created_at']);
    expect(shown.Order_Items?.columns).toEqual(['line_no', 'qty']);
    expect(shown.products).toBeUndefined();
    // Last key of a display table, as core places it.
    const orders = draft.display.models.find((m) => m.name === 'orders')!;
    expect(Object.keys(orders).at(-1)).toBe('sampleData');
  });
});

describe('rows the import does not keep are reported by table and count', () => {
  it('a table the Table Library already has: its file is not changed', () => {
    const libraryTable: SemanticTable = { name: 'products', schema: 'sales', columns: [{ name: 'id', dataType: 'int', description: '' }, { name: 'name', dataType: 'varchar', description: '' }] };
    const p = plan(FIXTURE, {
      schemaScopedNames: false,
      library: { findTableName: (n) => (n.toLowerCase() === 'products' ? 'products' : null), getTable: (n) => (n.toLowerCase() === 'products' ? libraryTable : null) },
    });
    expect(p.reusedTables).toEqual(['products']);
    expect([...(p.sampleData?.keys() ?? [])].map((t) => t.name)).toEqual(['orders', 'customers', 'Order_Items']);
    expect(p.report.dropped.filter((d) => d.kind === 'records')).toEqual([{
      kind: 'records',
      what: 'Sample data for sales.products (2 rows)',
      item: 'sales.products',
      why: "your Table Library's products is used as it is, so its file is not changed.",
    }]);
    expect(importLeftOut(p)).toContain("Sample data for sales.products (2 rows): your Table Library's products is used as it is, so its file is not changed");
    expect(p.report.notes).toContain('Sample data kept for 3 tables (orders, customers, Order_Items).');
  });

  it('a project that stores YAML: no place for them', () => {
    const p = plan(FIXTURE, { sampleRows: false, schemaScopedNames: false, diagramHoldsNoRelationships: false });
    expect(p.sampleData).toBeUndefined();
    expect(p.report.dropped.filter((d) => d.kind === 'records').map((d) => d.what)).toEqual([
      'Sample data for sales.orders (3 rows)', 'Sample data for customers (2 rows)', 'Sample data for Order Items (2 rows)', 'Sample data for sales.products (2 rows)',
    ]);
    expect(describeDbmlImportPlan(p)).toContain('• Sample data for 4 tables (sales.orders, customers, Order Items and 1 more): this project stores tables as YAML, which has no place for sample rows.');
    expect(p.report.notes.join('\n')).not.toMatch(/Sample data kept|enum were written/);
    const shown = reportStrings(p);
    for (const value of VALUES) expect(shown, value).not.toContain(JSON.stringify(value).slice(1, -1));
  });

  it('rows past the limit: the first SAMPLE_ROWS_LIMIT kept, the rest counted', () => {
    const rows = Array.from({ length: SAMPLE_ROWS_LIMIT + 20 }, (_, i) => `    ${i + 1}, 'v${i + 1}'`).join('\n');
    const p = plan(`Table t {\n  id int [pk]\n  name varchar\n  records (id, name) {\n${rows}\n  }\n}\n`);
    expect(rowsOf(p, 't')).toMatchObject({ columns: ['id', 'name'], totalRows: SAMPLE_ROWS_LIMIT });
    expect(rowsOf(p, 't')?.rows).toHaveLength(SAMPLE_ROWS_LIMIT);
    expect(p.report.dropped).toEqual([{ kind: 'records', what: 'Sample data for t', item: 't', why: `kept the first ${SAMPLE_ROWS_LIMIT} of ${SAMPLE_ROWS_LIMIT + 20} rows.` }]);
    expect(importLeftOut(p)).toContain(`Sample data for t: kept the first ${SAMPLE_ROWS_LIMIT} of ${SAMPLE_ROWS_LIMIT + 20} rows`);
  });

  it('a later row that would start with a sign whichever column led: left out and counted', () => {
    const p = plan('Table t {\n  a int\n  b int\n  records (a, b) {\n    1, 2\n    -3, -4\n    5, 6\n    +7, 8\n  }\n}\n');
    expect(rowsOf(p, 't')).toEqual({ columns: ['a', 'b'], rows: [[num('1'), num('2')], [num('5'), num('6')]], totalRows: 2 });
    expect(p.report.dropped).toEqual([{
      kind: 'records',
      what: 'Sample data for t',
      item: 't',
      why: '2 rows left out, because DBML 9 and 10 tools reject a row that starts with a minus or plus sign.',
    }]);
    // When a column can lead, every row is kept (the writer puts that column first).
    const led = plan('Table t {\n  a int\n  b int\n  records (a, b) {\n    1, 2\n    -3, 4\n  }\n}\n');
    expect(rowsOf(led, 't')?.rows).toHaveLength(2);
    expect(led.report.dropped).toEqual([]);
  });

  it('a block with only the placeholder column keeps nothing and says nothing of rows', () => {
    const p = plan("Table t {\n  erd_placeholder unknown [erd_placeholder: 'true']\n  records (erd_placeholder) {\n    'x'\n  }\n}\n");
    expect(p.sampleData).toBeUndefined();
    expect(p.report.notes.join('\n')).not.toMatch(/Sample data/);
  });
});

describe('two schemas share a table name', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `    ${i + 1}`).join('\n');
  const TWO = [
    'Table a.t {', '  id int [pk]', '  records (id) {', rows(SAMPLE_ROWS_LIMIT + 2), '  }', '}',
    'Table b.t {', '  id int [pk]', '  v int', '  records (id, v) {', '    1, 2', '    -3, -4', '  }', '}', '',
  ].join('\n');
  const p = plan(TWO);
  const draftOf = (q: DbmlImportPlan) => draftFromImportPlan({
    plan: q,
    importSource: 'file',
    trigger: 'palette',
    target: { layer: 'gold', layerLabel: 'Gold', name: 'shop', diagramFile: '.erd-studio/gold/diagrams/shop.dbml' },
    fileName: 'shop.dbml',
    describe: { layerLabel: 'Gold', dbml: { relationshipsFiles: [] } },
    libraryTable: () => undefined,
    layers: DEFAULT_LAYERS,
    logicalOnly: true,
    hasFolder: true,
    changeOptions: false,
  });

  it('the report names each table by schema, as its New line does', () => {
    expect(p.modelNames).toEqual(['a.t', 'b.t']);
    expect(p.report.notes).toContain('Sample data kept for 2 tables (a.t, b.t).');
    expect(p.report.dropped.filter((d) => d.kind === 'records')).toEqual([
      { kind: 'records', what: 'Sample data for a.t', item: 'a.t', why: `kept the first ${SAMPLE_ROWS_LIMIT} of ${SAMPLE_ROWS_LIMIT + 2} rows.` },
      { kind: 'records', what: 'Sample data for b.t', item: 'b.t', why: '1 row left out, because DBML 9 and 10 tools reject a row that starts with a minus or plus sign.' },
    ]);
  });

  it('the draft draws both tables under those names, each with its own columns and rows', () => {
    const shown = draftOf(p).display.models.map((m) => [m.name, m.schema, m.columns.map((c) => c.name), m.sampleData?.columns, m.sampleData?.rows.length]);
    expect(shown).toEqual([
      ['a.t', 'a', ['id'], ['id'], SAMPLE_ROWS_LIMIT],
      ['b.t', 'b', ['id', 'v'], ['id', 'v'], 1],
    ]);
    const b = draftOf(p).display.models.find((m) => m.name === 'b.t')!;
    expect(b.sampleData?.rows).toEqual([[num('1'), num('2')]]);
  });
});

describe('a value with escaped line-break characters', () => {
  it('is kept as the parser reads it: a carriage return and line feed written as escapes stay both', () => {
    const p = plan("Table t {\n  id int [pk]\n  v varchar\n  records (id, v) {\n    1, 'x\\r\\ny'\n  }\n}\n");
    expect(rowsOf(p, 't')?.rows).toEqual([[num('1'), str('x\r\ny')]]);
  });
});

describe('a parser that throws on a file with sample rows', () => {
  it("Import says only that it stopped, never the parser's message", () => {
    const sentinel = 'zqSENTX7';
    class Throwing {
      constructor() {
        throw new Error(`stopped at ${sentinel}`);
      }
    }
    const parser = { Compiler: Throwing, MemoryProjectLayout, DEFAULT_ENTRY };
    const read = readDbml(`Table t {\n  id int [pk]\n  v varchar\n  records (id, v) {\n    1, '${sentinel}'\n  }\n}\n`, parser);
    expect(read.ok).toBe(false);
    expect(read.ok ? [] : read.diagnostics.map((d) => d.message)).toEqual(['The DBML parser stopped.']);
  });
});
