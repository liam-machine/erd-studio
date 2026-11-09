/**
 * The Power BI / Fabric semantic model converter
 * (src/services/semanticModelImport.ts): finding models under a folder,
 * reading TMDL and TMSL (the same AdventureSales model in both, under
 * test/fixtures/semantic-model/), the DBML it writes, and that DBML going
 * through Import DBML's own reader and planner whole: tables, columns, types,
 * keys, relationships, nothing renamed and nothing dropped but what the
 * converter already said.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  INACTIVE_RELATIONSHIP_ROLE,
  SEMANTIC_MODEL_META,
  findSemanticModels,
  isAutoDateTable,
  isImportableName,
  parseTmdlColumnRef,
  readSemanticModel,
  semanticModelToDbml,
  toSnakeCaseName,
  type SemanticModel,
  type SemanticModelFile,
  type SemanticModelTable,
} from '../../src/services/semanticModelImport';
import { describeDbmlImportPlan, planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import type { SemanticTable } from '../../src/types/semantic';

const FIXTURES = path.resolve(__dirname, '../fixtures/semantic-model');
const TMDL_ROOT = path.join(FIXTURES, 'pbip-tmdl/AdventureSales.SemanticModel');
const TMSL_BIM = path.join(FIXTURES, 'pbip-tmsl/AdventureSales.SemanticModel/model.bim');

/** Every file under `dir`, relative to `base`, with `/`. */
function walk(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

function filesOf(paths: string[], base = FIXTURES): SemanticModelFile[] {
  return paths.map((p) => ({ path: p, text: fs.readFileSync(path.join(base, p), 'utf-8') }));
}

function tmdlFiles(): SemanticModelFile[] {
  const rel = walk(FIXTURES).filter((p) => p.startsWith('pbip-tmdl/') && p.endsWith('.tmdl'));
  return filesOf(rel);
}

function readOk(files: SemanticModelFile[]): { model: SemanticModel; warnings: string[] } {
  const result = readSemanticModel(files);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

function table(model: SemanticModel, name: string): SemanticModelTable {
  const t = model.tables.find((x) => x.name === name);
  if (!t) throw new Error(`no table ${name}`);
  return t;
}

/** The DBML through Import DBML: readDbml, then planDbmlImport into an empty library. */
function importDbml(dbml: string): DbmlImportPlan {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(`DBML did not parse: ${JSON.stringify(read.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: read.model,
    layer: 'gold',
    subjectAreaName: 'adventure-sales',
    fileName: 'AdventureSales.dbml',
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true,
  });
}

function planned(plan: DbmlImportPlan, name: string): SemanticTable {
  const t = plan.newTables.find((x) => x.name === name);
  if (!t) throw new Error(`no planned table ${name}: ${plan.newTables.map((x) => x.name).join(', ')}`);
  return t;
}

/** Every relationship the plan stores, as `from.col >card> to.col`. */
function links(plan: DbmlImportPlan): string[] {
  return plan.relationships
    .map((r) => `${r.fromModel}.${r.fromColumn} ${r.cardinality} ${r.toModel}.${r.toColumn}${r.role ? ` (${r.role})` : ''}`)
    .sort();
}

const minimal = (tables: SemanticModelTable[], relationships: SemanticModel['relationships'] = []): SemanticModel => ({
  name: 'Test',
  kind: 'tmsl',
  tables,
  relationships,
});

const t = (name: string, columns: Array<[string, string, Partial<SemanticModelTable['columns'][number]>?]>, extra: Partial<SemanticModelTable> = {}): SemanticModelTable => ({
  name,
  isHidden: false,
  isPrivate: false,
  showAsVariationsOnly: false,
  kind: 'table',
  measures: [],
  columns: columns.map(([n, dataType, more]) => ({ name: n, dataType, isKey: false, isHidden: false, kind: 'data', ...more })),
  ...extra,
});

// ---------------------------------------------------------------------------

describe('findSemanticModels', () => {
  it('finds a PBIP TMDL model, a PBIP TMSL model and the broken ones, never the report', () => {
    const entries = findSemanticModels(walk(FIXTURES));
    expect(entries.map((e) => [e.name, e.kind, e.root])).toEqual([
      ['Broken', 'tmsl', 'broken/Broken.SemanticModel'],
      ['BrokenTmdl', 'tmdl', 'broken/BrokenTmdl.SemanticModel'],
      ['AdventureSales', 'tmdl', 'pbip-tmdl/AdventureSales.SemanticModel'],
      ['AdventureSales', 'tmsl', 'pbip-tmsl/AdventureSales.SemanticModel'],
    ]);
    const tmdl = entries[2];
    expect(tmdl.files).toHaveLength(11);
    expect(tmdl.files.every((f) => f.endsWith('.tmdl'))).toBe(true);
    expect(entries[3].files).toEqual(['pbip-tmsl/AdventureSales.SemanticModel/model.bim']);
  });

  it('keeps the separators and prefix of the paths it was given', () => {
    const entries = findSemanticModels([
      'C:\\work\\Sales.SemanticModel\\definition\\model.tmdl',
      'C:\\work\\Sales.SemanticModel\\definition\\tables\\Sales.tmdl',
      'C:\\work\\Sales.SemanticModel\\definition.pbism',
      'C:\\work\\Sales.Report\\definition.pbir',
    ]);
    expect(entries).toEqual([
      {
        name: 'Sales',
        kind: 'tmdl',
        root: 'C:\\work\\Sales.SemanticModel',
        files: ['C:\\work\\Sales.SemanticModel\\definition\\model.tmdl', 'C:\\work\\Sales.SemanticModel\\definition\\tables\\Sales.tmdl'],
      },
    ]);
  });

  it('finds the older .Dataset folder, bare .bim files and bare TMDL folders; ignores node_modules and .pbi', () => {
    const entries = findSemanticModels([
      '/r/Old.Dataset/model.bim',
      '/r/exports/Finance.bim',
      '/r/exports/Budget.bim',
      '/r/tabular/model.bim',
      '/r/te/HR/database.tmdl',
      '/r/te/HR/model.tmdl',
      '/r/te/HR/tables/Employee.tmdl',
      '/r/fabric/Ops/definition/model.tmdl',
      '/r/fabric/Ops/definition/tables/Shift.tmdl',
      '/r/node_modules/x/model.bim',
      '/r/Old.Dataset/.pbi/cache.bim',
      '/r/readme.md',
    ]);
    expect(entries.map((e) => [e.name, e.kind, e.root, e.files.length])).toEqual([
      ['Budget', 'tmsl', '/r/exports', 1],
      ['Finance', 'tmsl', '/r/exports', 1],
      ['Ops', 'tmdl', '/r/fabric/Ops', 2],
      ['Old', 'tmsl', '/r/Old.Dataset', 1],
      ['tabular', 'tmsl', '/r/tabular', 1],
      ['HR', 'tmdl', '/r/te/HR', 3],
    ]);
  });

  it('prefers TMDL when a .SemanticModel has both, and finds nothing in a folder without a model', () => {
    expect(findSemanticModels(['A.SemanticModel/model.bim', 'A.SemanticModel/definition/model.tmdl']).map((e) => e.kind)).toEqual(['tmdl']);
    expect(findSemanticModels(['A.Report/definition.pbir', 'A.SemanticModel/definition.pbism', 'notes.txt'])).toEqual([]);
  });
});

describe('readSemanticModel: TMDL', () => {
  const { model, warnings } = readOk(tmdlFiles());

  it('reads the model name from the .SemanticModel folder and every table', () => {
    expect(warnings).toEqual([]);
    expect(model.name).toBe('AdventureSales');
    expect(model.kind).toBe('tmdl');
    // In model.tmdl's `ref table` order, not file order.
    expect(model.tables.map((x) => x.name)).toEqual(
      ['Sales', 'Customer', 'Product', 'Date Table', 'Time Intelligence', 'LocalDateTable_8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f'],
    );
  });

  it('reads columns, keys, hidden flags, descriptions, calculated columns and measures (never mistaking M or DAX lines for objects)', () => {
    const sales = table(model, 'Sales');
    expect(sales.description).toBe('One row per sales order line.');
    expect(sales.columns.map((c) => c.name)).toEqual([
      'SalesOrderLineKey', 'SalesOrderNumber', 'CustomerKey', 'ProductKey', 'OrderDateKey', 'ShipDateKey',
      'OrderDate', 'Quantity', 'Unit Price', 'Sales Amount', 'Line Margin', 'IsReturned',
    ]);
    expect(sales.columns[0]).toMatchObject({ dataType: 'int64', isKey: true, isHidden: false, kind: 'data', sourceColumn: 'SalesOrderLineKey' });
    expect(sales.columns[2]).toMatchObject({ name: 'CustomerKey', isHidden: true });
    expect(sales.columns[6]).toMatchObject({ name: 'OrderDate', dataType: 'dateTime', description: 'When the order was placed (local time).' });
    expect(sales.columns[10]).toMatchObject({ name: 'Line Margin', kind: 'calculated', dataType: 'decimal', description: 'Margin on the line.' });
    expect(sales.measures.map(({ line: _line, ...m }) => m)).toEqual([
      { name: 'Total Sales', description: 'Revenue after discounts.' },
      { name: 'Sales YoY %' },
      { name: 'Order Count' },
    ]);
    expect(sales.kind).toBe('table');
  });

  it('reads a calculated table, a calculation group and an auto date table for what they are', () => {
    const date = table(model, 'Date Table');
    expect(date.kind).toBe('calculated');
    expect(date.columns.find((c) => c.name === 'Fiscal Year')).toMatchObject({ kind: 'calculated', description: 'July to June.' });
    expect(table(model, 'Time Intelligence').kind).toBe('calculationGroup');
    const ldt = table(model, 'LocalDateTable_8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f');
    expect(ldt).toMatchObject({ isHidden: true, showAsVariationsOnly: true });
    expect(isAutoDateTable(ldt)).toBe(true);
    expect(table(model, 'Customer').columns.map((c) => c.name)).toEqual(['CustomerKey', 'Customer Name', 'City', 'Country/Region', 'Yearly Income', 'Photo', 'Note']);
  });

  it('reads relationships with their defaults, inactive and cross-filter settings, quoted names, and where each is written', () => {
    const file = 'pbip-tmdl/AdventureSales.SemanticModel/definition/relationships.tmdl';
    expect(model.relationships.map((r) => [r.file, r.line])).toEqual([[file, 1], [file, 5], [file, 10], [file, 14], [file, 19]]);
    expect(model.relationships.map(({ file: _f, line: _l, ...r }) => r)).toEqual([
      { name: '5e6f7a8b-0001-4000-8000-000000000001', fromTable: 'Sales', fromColumn: 'CustomerKey', toTable: 'Customer', toColumn: 'CustomerKey', fromCardinality: 'many', toCardinality: 'one', isActive: true },
      { name: '5e6f7a8b-0002-4000-8000-000000000002', fromTable: 'Sales', fromColumn: 'ProductKey', toTable: 'Product', toColumn: 'ProductKey', fromCardinality: 'many', toCardinality: 'one', isActive: true, crossFilteringBehavior: 'bothDirections' },
      { name: '5e6f7a8b-0003-4000-8000-000000000003', fromTable: 'Sales', fromColumn: 'OrderDateKey', toTable: 'Date Table', toColumn: 'DateKey', fromCardinality: 'many', toCardinality: 'one', isActive: true },
      { name: '5e6f7a8b-0004-4000-8000-000000000004', fromTable: 'Sales', fromColumn: 'ShipDateKey', toTable: 'Date Table', toColumn: 'DateKey', fromCardinality: 'many', toCardinality: 'one', isActive: false },
      { name: '5e6f7a8b-0005-4000-8000-000000000005', fromTable: 'Sales', fromColumn: 'OrderDate', toTable: 'LocalDateTable_8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f', toColumn: 'Date', fromCardinality: 'many', toCardinality: 'one', isActive: true },
    ]);
  });

  it('reads the same model indented with spaces, with CRLF line ends, and whatever order the files come in', () => {
    const spaced = tmdlFiles()
      .reverse()
      .map((f) => ({ ...f, text: f.text.replace(/^\t+/gm, (tabs) => '    '.repeat(tabs.length)).replace(/\n/g, '\r\n') }));
    expect(readOk(spaced).model).toEqual(model);
  });

  it('skips unknown objects and properties, comments, createOrReplace scripts, and a relationship it cannot read (with a warning)', () => {
    const result = readOk([
      {
        path: 'script.tmdl',
        text: [
          'createOrReplace',
          '',
          '\t// a comment',
          '\ttable Orders',
          '\t\tsomeFutureProperty: 42',
          '\t\tisHidden: false',
          '\t\tperspectiveThing Foo',
          '\t\t\tdeep: 1',
          '\t\tcolumn OrderKey',
          '\t\t\tdataType : int64',
          '\t\t\tisKey: true',
          '\t\tcolumn \'It\'\'s odd\'',
          '\t\t\tdataType: string',
          '\t\tmeasure M =',
          '\t\t\t\t\ttable Fake',
          '\t\t\t\t\tcolumn Fake',
          '\t\t\tformatString: 0',
          '\trelationship r1',
          '\t\tfromColumn: Orders',
          '\t\ttoColumn: Orders.OrderKey',
        ].join('\n'),
      },
    ]);
    expect(result.model.tables).toEqual([
      {
        name: 'Orders',
        isHidden: false,
        isPrivate: false,
        showAsVariationsOnly: false,
        kind: 'table',
        columns: [
          { name: 'OrderKey', dataType: 'int64', isKey: true, isHidden: false, kind: 'data', line: 9 },
          { name: "It's odd", dataType: 'string', isKey: false, isHidden: false, kind: 'data', line: 12 },
        ],
        measures: [{ name: 'M', line: 14 }],
        file: 'script.tmdl',
        line: 4,
      },
    ]);
    // Unknown objects are not features: nothing to report.
    expect(result.model.features).toEqual([]);
    expect(result.model.relationships).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining('Relationship r1')]);
  });

  it('parses every column reference form TMDL writes', () => {
    expect(parseTmdlColumnRef('Sales.CustomerKey')).toEqual({ table: 'Sales', column: 'CustomerKey' });
    expect(parseTmdlColumnRef("'Date Table'.DateKey")).toEqual({ table: 'Date Table', column: 'DateKey' });
    expect(parseTmdlColumnRef("'Date Table'.'Date Key'")).toEqual({ table: 'Date Table', column: 'Date Key' });
    expect(parseTmdlColumnRef("Sales.'Unit Price'")).toEqual({ table: 'Sales', column: 'Unit Price' });
    expect(parseTmdlColumnRef("'Sales'[CustomerKey]")).toEqual({ table: 'Sales', column: 'CustomerKey' });
    expect(parseTmdlColumnRef('Sales[Sales Amount]')).toEqual({ table: 'Sales', column: 'Sales Amount' });
    expect(parseTmdlColumnRef("'O''Brien'.Key")).toEqual({ table: "O'Brien", column: 'Key' });
    expect(parseTmdlColumnRef('LocalDateTable_8f1c-2d3e.Date')).toEqual({ table: 'LocalDateTable_8f1c-2d3e', column: 'Date' });
    expect(parseTmdlColumnRef('Sales')).toBeUndefined();
    expect(parseTmdlColumnRef("'Sales.Key")).toBeUndefined();
  });
});

describe('readSemanticModel: TMSL', () => {
  const { model, warnings } = readOk(filesOf([path.relative(FIXTURES, TMSL_BIM)]));

  it('reads the model.bim, named after its .SemanticModel folder', () => {
    expect(warnings).toEqual([]);
    expect(model.name).toBe('AdventureSales');
    expect(model.kind).toBe('tmsl');
    expect(model.tables.map((x) => [x.name, x.kind])).toEqual([
      ['Sales', 'table'],
      ['Customer', 'table'],
      ['Product', 'table'],
      ['Date Table', 'calculated'],
      ['Time Intelligence', 'calculationGroup'],
      ['LocalDateTable_8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f', 'calculated'],
    ]);
    expect(table(model, 'Sales').columns[0]).toMatchObject({ kind: 'rowNumber', isHidden: true });
    expect(table(model, 'Sales').columns.find((c) => c.name === 'Line Margin')).toMatchObject({ kind: 'calculated' });
    expect(table(model, 'Sales').measures.map((m) => m.name)).toEqual(['Total Sales', 'Sales YoY %', 'Order Count']);
    expect(model.relationships.find((r) => !r.isActive)).toMatchObject({ fromColumn: 'ShipDateKey', toTable: 'Date Table' });
  });

  it('reads a createOrReplace script and strips a BOM', () => {
    const text = '\uFEFF' + JSON.stringify({
      createOrReplace: {
        object: { database: 'Finance' },
        database: { name: 'Finance', model: { tables: [{ name: 'GL', description: ['General', 'ledger'], columns: [{ name: 'Amount', dataType: 'decimal' }] }] } },
      },
    });
    const result = readOk([{ path: 'scripts/finance.bim', text }]);
    expect(result.model.name).toBe('Finance');
    expect(result.model.tables[0].description).toBe('General\nledger');
  });

  it('turns the TMDL and the TMSL copy of one model into the same DBML', () => {
    const fromTmdl = semanticModelToDbml(readOk(tmdlFiles()).model);
    // The TMDL copy formats Date Table[Date] as Long Date (so it is read as a date); the TMSL copy gains the same format.
    const [bim] = filesOf([path.relative(FIXTURES, TMSL_BIM)]);
    const json = JSON.parse(bim.text) as { model: { tables: Array<{ name: string; columns: Array<Record<string, unknown>> }> } };
    json.model.tables.find((x) => x.name === 'Date Table')!.columns.find((c) => c.name === 'Date')!.formatString = 'Long Date';
    const fromTmsl = semanticModelToDbml(readOk([{ path: bim.path, text: JSON.stringify(json) }]).model);
    expect(fromTmsl.dbml.replace('(TMSL)', '(TMDL)')).toBe(fromTmdl.dbml);
    expect(fromTmsl.skipped).toEqual(fromTmdl.skipped);
  });
});

describe('readSemanticModel: problems', () => {
  it('reports a .bim that is not valid JSON, with its line', () => {
    const result = readSemanticModel(filesOf(['broken/Broken.SemanticModel/model.bim']));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0].file).toBe('broken/Broken.SemanticModel/model.bim');
    expect(result.problems[0].message).toMatch(/^Not valid JSON/);
    expect(result.problems[0].line).toBe(10);
  });

  it('reports a TMDL ``` expression that is never closed, with its file and line', () => {
    const result = readSemanticModel(filesOf([
      'broken/BrokenTmdl.SemanticModel/definition/model.tmdl',
      'broken/BrokenTmdl.SemanticModel/definition/tables/Orders.tmdl',
    ]));
    expect(result).toEqual({
      ok: false,
      problems: [{ file: 'broken/BrokenTmdl.SemanticModel/definition/tables/Orders.tmdl', line: 3, message: expect.stringContaining('never closed') }],
    });
  });

  it('reports a .bim with no model, a model with no tables, two .bim files, and no model files at all', () => {
    const bad = (files: SemanticModelFile[]): string => {
      const r = readSemanticModel(files);
      if (r.ok) throw new Error('read');
      return r.problems.map((p) => p.message).join(' | ');
    };
    expect(bad([{ path: 'a.bim', text: '{"name":"x"}' }])).toMatch(/no "model" object/);
    expect(bad([{ path: 'a.bim', text: '{"model":{"tables":[]}}' }])).toMatch(/no tables/);
    expect(bad([{ path: 'a.tmdl', text: 'model Model\n\tculture: en-US\n' }])).toMatch(/no tables/);
    expect(bad([{ path: 'a.bim', text: '{}' }, { path: 'b.bim', text: '{}' }])).toMatch(/2 \.bim files/);
    expect(bad([{ path: 'x.json', text: '{}' }])).toMatch(/No semantic model files/);
    expect(bad([])).toMatch(/No semantic model files/);
  });

  it('warns about a duplicate table and keeps the first', () => {
    const r = readOk([{ path: 'm.bim', text: JSON.stringify({ model: { tables: [{ name: 'A', columns: [] }, { name: 'a', columns: [{ name: 'x', dataType: 'string' }] }] } }) }]);
    expect(r.model.tables).toHaveLength(1);
    expect(r.warnings).toEqual([expect.stringContaining('more than once')]);
  });
});

describe('toSnakeCaseName', () => {
  it.each([
    ['Date Table', 'table', 'date_table'],
    ['Sales', 'table', 'sales'],
    ['CustomerKey', 'column', 'customer_key'],
    ['Sales Amount', 'column', 'sales_amount'],
    ['SKU', 'column', 'sku'],
    ['ProductID', 'column', 'product_id'],
    ['HTTPStatusCode', 'column', 'http_status_code'],
    ['Country/Region', 'column', 'country_region'],
    ['Sales YoY %', 'column', 'sales_yo_y_pct'],
    ['Order Date (UTC)', 'column', 'order_date_utc'],
    ['Café Name', 'column', 'cafe_name'],
    ['2024 Budget', 'table', 't_2024_budget'],
    ['2024 Budget', 'column', '2024_budget'],
    ['---', 'table', 'table'],
    ['', 'column', 'column'],
    ['already_snake', 'column', 'already_snake'],
  ] as const)('%s (%s) → %s', (input, kind, expected) => {
    const out = toSnakeCaseName(input, kind);
    expect(out).toBe(expected);
    expect(isImportableName(out, kind)).toBe(true);
    expect(toSnakeCaseName(out, kind)).toBe(out);
  });
});

describe('semanticModelToDbml: the fixture through Import DBML', () => {
  const { model } = readOk(tmdlFiles());
  const result = semanticModelToDbml(model);
  const plan = importDbml(result.dbml);

  it('counts what it wrote', () => {
    expect(result.tableCount).toBe(4);
    expect(result.refCount).toBe(4);
  });

  it('lists measures (never their DAX), the calculation group and the auto date table as skipped', () => {
    const text = result.skipped.join('\n');
    expect(text).toContain('3 measures in Sales (Total Sales, Sales YoY %, Order Count)');
    expect(text).toContain('Calculation group Time Intelligence');
    expect(text).toContain('Auto date/time table LocalDateTable_8f1c2d3e-4b5a-4c6d-9e8f-0a1b2c3d4e5f');
    expect(result.skipped).toHaveLength(3);
    expect(text).not.toMatch(/SUM|DISTINCTCOUNT|CALCULATE/);
    expect(result.dbml).not.toMatch(/SUM|DISTINCTCOUNT|CALCULATE|Sql\.Database/);
  });

  it('imports four tables with snake_case names and nothing renamed by the import', () => {
    expect(plan.modelNames).toEqual(['sales', 'customer', 'product', 'date_table']);
    expect(plan.report.renamed).toEqual([]);
    expect(plan.report.newTables).toEqual(['sales', 'customer', 'product', 'date_table']);
    for (const tbl of plan.newTables) {
      expect(isImportableName(tbl.name, 'table')).toBe(true);
      for (const c of tbl.columns) expect(isImportableName(c.name, 'column')).toBe(true);
    }
  });

  it('maps every column, its type and description; drops the auto date link but keeps the column', () => {
    const sales = planned(plan, 'sales');
    expect(sales.columns.map((c) => [c.name, c.dataType])).toEqual([
      ['sales_order_line_key', 'bigint'],
      ['sales_order_number', 'varchar'],
      ['customer_key', 'bigint'],
      ['product_key', 'bigint'],
      ['order_date_key', 'bigint'],
      ['ship_date_key', 'bigint'],
      ['order_date', 'timestamp'],
      ['quantity', 'bigint'],
      ['unit_price', 'decimal'],
      ['sales_amount', 'decimal'],
      ['line_margin', 'decimal'],
      ['is_returned', 'boolean'],
    ]);
    expect(sales.description).toBe('One row per sales order line.');
    expect(sales.columns.find((c) => c.name === 'order_date')?.description).toBe('When the order was placed (local time).');
    expect(planned(plan, 'customer').columns.map((c) => [c.name, c.dataType])).toEqual([
      ['customer_key', 'bigint'],
      ['customer_name', 'varchar'],
      ['city', 'varchar'],
      ['country_region', 'varchar'],
      ['yearly_income', 'double'],
      ['photo', 'binary'],
      ['note', 'varchar'],
    ]);
  });

  it('keeps keys: isKey as the primary key, else the one column relationships point at (in the ledger); a joined column that is not the key is unique', () => {
    const pk = (name: string): string[] => planned(plan, name).columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    expect(pk('sales')).toEqual(['sales_order_line_key']);
    expect(pk('customer')).toEqual(['customer_key']);
    expect(pk('product')).toEqual(['product_key']);
    // Date Table is marked as a date table, which flags Date isKey; every relationship joins DateKey,
    // so DateKey is the key and Date stays unique.
    expect(pk('date_table')).toEqual(['date_key']);
    expect(planned(plan, 'date_table').columns.find((c) => c.name === 'date')?.meta).toMatchObject({ dbml: { unique: true } });
    expect(result.warnings).toContain('Date Table: every relationship joins date_key, so it is the key; date, which Mark as date table flags isKey, is marked unique.');
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'primaryKey', cause: 'inferred', where: expect.objectContaining({ table: 'Product', column: 'ProductKey' }) }));
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'primaryKey', what: 'date table key', where: expect.objectContaining({ table: 'Date Table', column: 'DateKey' }) }));
    const fks = planned(plan, 'sales').columns.filter((c) => c.isForeignKey).map((c) => c.name);
    expect(fks).toEqual(['customer_key', 'product_key', 'order_date_key', 'ship_date_key']);
  });

  it('imports the relationships from the many side, the inactive one with its role', () => {
    expect(links(plan)).toEqual([
      'sales.customer_key many-to-one customer.customer_key',
      'sales.order_date_key many-to-one date_table.date_key',
      'sales.product_key many-to-one product.product_key',
      `sales.ship_date_key many-to-one date_table.date_key (${INACTIVE_RELATIONSHIP_ROLE})`,
    ]);
    expect(plan.report.relationships).toBe(4);
    // Nothing left out: "inactive" travels as the role, not as a setting the import would drop.
    expect(plan.report.dropped).toEqual([]);
    expect(result.dbml).toContain(`Ref "${INACTIVE_RELATIONSHIP_ROLE}": sales.ship_date_key > date_table.date_key\n`);
    // Filtering both ways has no place in a diagram: named as not kept, with the relationship's line.
    expect(result.ledger).toContainEqual(expect.objectContaining({
      outcome: 'lost', unit: 'setting', what: 'cross-filter direction',
      where: expect.objectContaining({ table: 'Sales', column: 'ProductKey', line: expect.any(Number) }),
    }));
  });

  it('keeps the original names, hidden flags and calculated markers in meta, descriptions exactly, and names the DAX not kept', () => {
    const sales = planned(plan, 'sales');
    expect(sales.meta?.[SEMANTIC_MODEL_META.name]).toBe('Sales');
    expect(planned(plan, 'date_table').meta).toEqual({ [SEMANTIC_MODEL_META.name]: 'Date Table', [SEMANTIC_MODEL_META.calculated]: 'true' });
    // The description is kept exactly as written; that the DAX was not imported is in the ledger.
    expect(planned(plan, 'date_table').description).toBe('The calendar every date in the model uses.');
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', unit: 'table', what: 'DAX expression', where: expect.objectContaining({ table: 'Date Table' }) }));
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', unit: 'column', what: 'DAX expression', where: expect.objectContaining({ table: 'Sales', column: 'Line Margin' }) }));
    const customerKey = sales.columns.find((c) => c.name === 'customer_key');
    expect(customerKey?.meta).toEqual({ [SEMANTIC_MODEL_META.name]: 'CustomerKey', [SEMANTIC_MODEL_META.hidden]: 'true' });
    const margin = sales.columns.find((c) => c.name === 'line_margin');
    expect(margin?.description).toBe('Margin on the line.');
    expect(margin?.meta).toMatchObject({ [SEMANTIC_MODEL_META.calculated]: 'true', [SEMANTIC_MODEL_META.name]: 'Line Margin' });
    expect(result.renamed).toContainEqual({ kind: 'table', table: 'date_table', from: 'Date Table', to: 'date_table' });
    expect(result.renamed).toContainEqual({ kind: 'column', table: 'sales', from: 'Sales Amount', to: 'sales_amount' });
    // date_table.date_key's unique (relationships join it) is the one detail kept in the table files.
    expect(plan.report.keptInMeta).toBe(1);
  });

  it('names the diagram after the model and describes it', () => {
    expect(plan.document.description).toBe('Converted from the Power BI semantic model AdventureSales.');
    const summary = describeDbmlImportPlan(plan);
    expect(summary).toContain('Import 4 tables into a new diagram "adventure-sales" in the gold layer.');
    expect(summary).toContain('• New: sales, customer, product, date_table.');
    expect(summary).toContain('4 relationships');
    expect(summary).not.toContain('Left out');
  });

  it('is deterministic', () => {
    expect(semanticModelToDbml(readOk(tmdlFiles()).model).dbml).toBe(result.dbml);
  });
});

describe('semanticModelToDbml: relationships and names', () => {
  it('writes one-to-one as -, many-to-many as <>, and turns a one → many round', () => {
    const model = minimal(
      [
        t('Person', [['PersonKey', 'int64', { isKey: true }], ['Name', 'string']]),
        t('Passport', [['PersonKey', 'int64'], ['Number', 'string', { isKey: true }]]),
        t('Budget', [['Category', 'string'], ['Amount', 'decimal']]),
        t('Product', [['ProductKey', 'int64', { isKey: true }], ['Category', 'string']]),
        t('Visit', [['VisitKey', 'int64', { isKey: true }], ['PersonKey', 'int64']]),
      ],
      [
        { fromTable: 'Passport', fromColumn: 'PersonKey', toTable: 'Person', toColumn: 'PersonKey', fromCardinality: 'one', toCardinality: 'one', isActive: true },
        { fromTable: 'Budget', fromColumn: 'Category', toTable: 'Product', toColumn: 'Category', fromCardinality: 'many', toCardinality: 'many', isActive: true },
        { fromTable: 'Person', fromColumn: 'PersonKey', toTable: 'Visit', toColumn: 'PersonKey', fromCardinality: 'one', toCardinality: 'many', isActive: true },
      ],
    );
    const result = semanticModelToDbml(model);
    expect(result.dbml).toContain('Ref: person.person_key - passport.person_key');
    expect(result.dbml).toContain('Ref: budget.category <> product.category');
    expect(result.dbml).toContain('Ref: visit.person_key > person.person_key');
    const plan = importDbml(result.dbml);
    expect(links(plan)).toEqual([
      'budget.category many-to-many product.category',
      'passport.person_key one-to-one person.person_key',
      'visit.person_key many-to-one person.person_key',
    ]);
  });

  it('skips inactive relationships when asked, and relationships it cannot resolve, saying why', () => {
    const model = minimal(
      [t('Fact', [['A', 'int64'], ['B', 'int64']]), t('Dim', [['Key', 'int64', { isKey: true }]])],
      [
        { fromTable: 'Fact', fromColumn: 'A', toTable: 'Dim', toColumn: 'Key', fromCardinality: 'many', toCardinality: 'one', isActive: true },
        { fromTable: 'Fact', fromColumn: 'B', toTable: 'Dim', toColumn: 'Key', fromCardinality: 'many', toCardinality: 'one', isActive: false },
        { fromTable: 'Fact', fromColumn: 'Missing', toTable: 'Dim', toColumn: 'Key', fromCardinality: 'many', toCardinality: 'one', isActive: true },
        { fromTable: 'Gone', fromColumn: 'A', toTable: 'Dim', toColumn: 'Key', fromCardinality: 'many', toCardinality: 'one', isActive: true },
        { fromTable: 'Dim', fromColumn: 'Key', toTable: 'Fact', toColumn: 'A', fromCardinality: 'one', toCardinality: 'many', isActive: true },
      ],
    );
    const result = semanticModelToDbml(model, { inactiveRelationships: 'skip' });
    expect(result.refCount).toBe(1);
    expect(result.skipped).toEqual([
      'Inactive relationship Fact[B] → Dim[Key].',
      'Relationship Fact[Missing] → Dim[Key]: Fact has no column Missing.',
      'Relationship Gone[A] → Dim[Key]: the model has no table Gone.',
      'Relationship Dim[Key] → Fact[A]: the same two columns are already joined.',
    ]);
    expect(links(importDbml(result.dbml))).toEqual(['fact.a many-to-one dim.key']);
  });

  it('gives colliding names a suffix, warns, and keeps refs pointing at the right column', () => {
    const model = minimal(
      [
        t('Sales Order', [['Order Key', 'int64', { isKey: true }], ['OrderKey', 'string'], ['Customer Key', 'int64']]),
        t('SalesOrder', [['x', 'string']]),
        t('Customer', [['Customer Key', 'int64', { isKey: true }]]),
      ],
      [{ fromTable: 'Sales Order', fromColumn: 'Customer Key', toTable: 'Customer', toColumn: 'Customer Key', fromCardinality: 'many', toCardinality: 'one', isActive: true }],
    );
    const result = semanticModelToDbml(model);
    expect(result.warnings).toEqual([
      'In Sales Order, columns OrderKey and another both become order_key, so OrderKey is order_key_2.',
      'Tables SalesOrder and another both become sales_order, so SalesOrder is sales_order_2.',
    ]);
    const plan = importDbml(result.dbml);
    expect(plan.modelNames).toEqual(['sales_order', 'sales_order_2', 'customer']);
    expect(planned(plan, 'sales_order').columns.map((c) => c.name)).toEqual(['order_key', 'order_key_2', 'customer_key']);
    expect(planned(plan, 'sales_order').columns[1].meta).toEqual({ [SEMANTIC_MODEL_META.name]: 'OrderKey' });
    expect(links(plan)).toEqual(['sales_order.customer_key many-to-one customer.customer_key']);
    expect(plan.report.renamed).toEqual([]);
  });

  it('maps every Power BI type, unknown ones to variant, and drops TMSL row-number columns', () => {
    const model = minimal([
      t('All Types', [
        ['RowNumber-2662979B-1795-4F74-8F37-6A1BA8059B61', 'int64', { kind: 'rowNumber', isHidden: true, isKey: true }],
        ['i', 'int64'], ['s', 'String'], ['d', 'double'], ['m', 'decimal'], ['t', 'dateTime'],
        ['b', 'boolean'], ['bin', 'binary'], ['v', 'variant'], ['u', 'unknown'], ['none', ''],
      ]),
    ]);
    const plan = importDbml(semanticModelToDbml(model).dbml);
    expect(planned(plan, 'all_types').columns.map((c) => `${c.name}:${c.dataType}`)).toEqual([
      'i:bigint', 's:varchar', 'd:double', 'm:decimal', 't:timestamp', 'b:boolean', 'bin:binary', 'v:variant', 'u:variant', 'none:variant',
    ]);
    expect(planned(plan, 'all_types').columns.some((c) => c.isPrimaryKey)).toBe(false);
  });

  it('writes descriptions with quotes, backslashes and line breaks so they import exactly', () => {
    const description = "It's a \\path\\ and\nsecond line";
    const model = minimal([t('Notes', [['Text', 'string', { description }]], { description })]);
    const plan = importDbml(semanticModelToDbml(model).dbml);
    // Kept exactly as written: no full stop added to the user's own text.
    expect(planned(plan, 'notes').description).toBe(description);
    expect(planned(plan, 'notes').columns[0].description).toBe(description);
  });

  it('does not infer a key on a table that flags one, or that relationships reach through two columns', () => {
    const model = minimal(
      [
        t('Fact', [['A', 'int64'], ['B', 'int64']]),
        t('Dim', [['K1', 'int64'], ['K2', 'int64']]),
      ],
      [
        { fromTable: 'Fact', fromColumn: 'A', toTable: 'Dim', toColumn: 'K1', fromCardinality: 'many', toCardinality: 'one', isActive: true },
        { fromTable: 'Fact', fromColumn: 'B', toTable: 'Dim', toColumn: 'K2', fromCardinality: 'many', toCardinality: 'one', isActive: true },
      ],
    );
    const plan = importDbml(semanticModelToDbml(model).dbml);
    expect(planned(plan, 'dim').columns.some((c) => c.isPrimaryKey)).toBe(false);
    const noInfer = importDbml(semanticModelToDbml(minimal([t('F', [['A', 'int64']]), t('D', [['K', 'int64']])], [
      { fromTable: 'F', fromColumn: 'A', toTable: 'D', toColumn: 'K', fromCardinality: 'many', toCardinality: 'one', isActive: true },
    ]), { inferKeys: false }).dbml);
    expect(planned(noInfer, 'd').columns[0].isPrimaryKey).toBeFalsy();
  });

  it('uses the projectName option for the DBML Project', () => {
    const result = semanticModelToDbml(minimal([t('A', [['x', 'string']])]), { projectName: 'My "Sales" model' });
    const read = readDbml(result.dbml);
    expect(read.ok && read.model.project?.name).toBe('My "Sales" model');
  });
});
