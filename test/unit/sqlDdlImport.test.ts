/**
 * Import SQL DDL…'s converter (src/services/sqlDdlImport.ts, with
 * @dbml/core's grammars bound in src/services/sqlImportEngine.ts): every
 * dialect's star-schema fixture (test/fixtures/sql-ddl/<dialect>/) becomes
 * DBML that Import DBML reads (`readDbml`) and plans (`planDbmlImport`) with
 * its tables, columns, types, keys, notes and many → one relationships; what
 * is skipped and why; problems with their file and line; dialect detection;
 * the lazy loader; and the bundle boundary that keeps @dbml/core out of
 * dist/extension.js and dist/cli.js.
 */

import * as fs from 'fs';
import * as path from 'path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

import {
  SQL_DIALECTS,
  SQL_DIALECT_LABELS,
  convertSqlDdl,
  countCreateTablesWithColumns,
  detectSqlDialect,
  isSqlDialect,
  looksLikeMigrationFile,
  looksLikeOracleSql,
  withoutSqlData,
  type SqlDdlFile,
  type SqlDdlToDbmlResult,
  type SqlDialect,
} from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine, sqlDdlToDbml } from '../../src/services/sqlImportEngine';
import { SQL_IMPORT_BUNDLE, loadSqlImport, sqlImportBundlePath } from '../../src/services/sqlImportLoader';
import { readDbml } from '../../src/services/dbmlImportParse';
import { DBML_META_KEY, describeDbmlImportPlan, planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { TABLE_NAME_PATTERN } from '../../src/types/naming';
import type { SemanticTable } from '../../src/types/semantic';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURES = path.join(ROOT, 'test/fixtures/sql-ddl');

function fixtureFiles(dir: string): SqlDdlFile[] {
  const folder = path.join(FIXTURES, dir);
  return fs.readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()
    .map((name) => ({ name, text: fs.readFileSync(path.join(folder, name), 'utf-8') }));
}

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, files: SqlDdlFile[]): Converted {
  const result = sqlDdlToDbml({ dialect, files });
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.problems)}`);
  return result;
}

function problemsOf(dialect: SqlDialect, files: SqlDdlFile[]): Extract<SqlDdlToDbmlResult, { ok: false }>['problems'] {
  const result = sqlDdlToDbml({ dialect, files });
  if (result.ok) throw new Error(`expected problems, got DBML:\n${result.dbml}`);
  return result.problems;
}

/** The problems of a conversion that still imported what read (`ok: true`: one bad table never stops the rest). */
function partialProblemsOf(dialect: SqlDialect, files: SqlDdlFile[]): Converted['problems'] {
  return convert(dialect, files).problems;
}

/** What Import DBML… does with the output: read it, then plan a new diagram from it (empty library). */
function importPlan(dbml: string): DbmlImportPlan {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(`Import DBML rejected the output: ${JSON.stringify(read.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: read.model,
    layer: 'gold',
    subjectAreaName: 'sql-import',
    fileName: 'schema.sql',
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true,
  });
}

const tableOf = (plan: DbmlImportPlan, name: string): SemanticTable => {
  const table = plan.newTables.find((t) => t.name === name);
  if (!table) throw new Error(`no table ${name} in ${plan.newTables.map((t) => t.name).join(', ')}`);
  return table;
};
const columnOf = (plan: DbmlImportPlan, table: string, column: string) => {
  const found = (tableOf(plan, table).columns ?? []).find((c) => c.name === column);
  if (!found) throw new Error(`no column ${table}.${column}`);
  return found;
};
const pkOf = (plan: DbmlImportPlan, table: string): string[] =>
  (tableOf(plan, table).columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name);
const linksOf = (plan: DbmlImportPlan): string[] =>
  plan.relationships.map((r) => `${r.fromModel}.${r.fromColumn} > ${r.toModel}.${r.toColumn} (${r.cardinality})`).sort();

// ---------------------------------------------------------------------------
// The star schema in every dialect
// ---------------------------------------------------------------------------

interface Star {
  dir: string;
  schema: string;
  fact: string;
  dims: string[];
  factPk: string[];
  /** `fact.column > dim.column`, many → one. */
  links: string[];
  types: Record<string, string>;
  descriptions: Record<string, string>;
}

const STARS: Record<SqlDialect, Star> = {
  postgres: {
    dir: 'postgres',
    schema: 'sales',
    fact: 'fct_order_line',
    dims: ['dim_customer', 'dim_product', 'dim_date'],
    factPk: ['order_id', 'line_number'],
    links: [
      'fct_order_line.customer_id > dim_customer.customer_id',
      'fct_order_line.order_date_key > dim_date.date_key',
      'fct_order_line.product_id > dim_product.product_id',
    ],
    types: {
      'dim_customer.customer_id': 'SERIAL',
      'dim_customer.created_at': 'TIMESTAMPTZ',
      'dim_product.unit_price': 'NUMERIC(10,2)',
      'dim_product.tags': 'TEXT[]',
      'fct_order_line.amount': 'DOUBLE PRECISION',
      'fct_order_line.status': 'sales.order_status',
    },
    descriptions: {
      dim_customer: 'One row per customer',
      'dim_customer.customer_name': 'Name as the customer entered it',
      'fct_order_line.amount': 'Line amount in AUD, after discounts',
    },
  },
  mysql: {
    dir: 'mysql',
    schema: '',
    fact: 'fct_sale',
    dims: ['dim_customer', 'dim_product', 'dim_store'],
    factPk: ['sale_id', 'line_no'],
    links: [
      'fct_sale.customer_id > dim_customer.customer_id',
      'fct_sale.product_id > dim_product.product_id',
      'fct_sale.store_id > dim_store.store_id',
    ],
    types: {
      'dim_customer.customer_name': 'varchar(200)',
      'fct_sale.amount': 'decimal(12,2)',
      'fct_sale.sold_at': 'datetime',
    },
    descriptions: {
      dim_customer: 'One row per customer',
      'dim_customer.customer_id': 'Surrogate key',
      'fct_sale.amount': 'Sale amount incl. tax',
    },
  },
  sqlserver: {
    dir: 'sqlserver',
    schema: 'dbo',
    fact: 'FactSales',
    dims: ['DimCustomer', 'DimProduct', 'DimDate'],
    factPk: ['SalesOrderNumber', 'SalesOrderLineNumber'],
    links: [
      'FactSales.CustomerKey > DimCustomer.CustomerKey',
      'FactSales.OrderDateKey > DimDate.DateKey',
      'FactSales.ProductKey > DimProduct.ProductKey',
    ],
    types: {
      'DimCustomer.CustomerKey': 'int',
      'DimCustomer.CustomerName': 'nvarchar(200)',
      'FactSales.SalesAmount': 'decimal(19,4)',
      'DimProduct.ListPrice': 'money',
    },
    descriptions: {
      DimCustomer: 'One row per customer',
      'FactSales.SalesAmount': 'Sales amount in AUD',
    },
  },
  snowflake: {
    dir: 'snowflake',
    schema: 'ANALYTICS',
    fact: 'FCT_ORDER',
    dims: ['DIM_CUSTOMER', 'DIM_PRODUCT', 'DIM_DATE'],
    factPk: ['ORDER_ID', 'LINE_NO'],
    links: [
      'FCT_ORDER.CUSTOMER_ID > DIM_CUSTOMER.CUSTOMER_ID',
      'FCT_ORDER.DATE_KEY > DIM_DATE.DATE_KEY',
      'FCT_ORDER.PRODUCT_ID > DIM_PRODUCT.PRODUCT_ID',
    ],
    types: {
      'DIM_CUSTOMER.CUSTOMER_ID': 'NUMBER(38,0)',
      'DIM_CUSTOMER.ATTRIBUTES': 'VARIANT',
      'DIM_CUSTOMER.LOADED_AT': 'TIMESTAMP_NTZ(9)',
      'FCT_ORDER.AMOUNT': 'NUMBER(12,2)',
    },
    descriptions: {
      DIM_CUSTOMER: 'One row per customer',
      'DIM_CUSTOMER.CUSTOMER_ID': 'Surrogate key',
      'FCT_ORDER.AMOUNT': 'Order line amount in AUD',
    },
  },
  databricks: {
    dir: 'databricks',
    schema: 'gold',
    fact: 'fct_order',
    dims: ['dim_customer', 'dim_product', 'dim_date'],
    factPk: ['order_id', 'line_no'],
    links: [
      'fct_order.customer_id > dim_customer.customer_id',
      'fct_order.date_key > dim_date.date_key',
      'fct_order.product_id > dim_product.product_id',
    ],
    types: {
      'dim_customer.customer_id': 'BIGINT',
      'dim_customer.customer_name': 'STRING',
      'dim_customer.emails': 'ARRAY<STRING>',
      'dim_customer.address': 'STRUCT<street: STRING, city: STRING, postcode: STRING>',
      'dim_customer.updated_at': 'TIMESTAMP_NTZ',
      'dim_product.attributes': 'MAP<STRING, STRING>',
      'fct_order.amount': 'DECIMAL(12,2)',
    },
    descriptions: {
      dim_customer: 'One row per customer',
      fct_order: 'One row per order line',
      'dim_customer.customer_id': 'Surrogate key',
      'fct_order.amount': 'Order line amount in AUD',
    },
  },
};

describe.each(SQL_DIALECTS.map((d) => [d] as const))('the %s star schema', (dialect) => {
  const star = STARS[dialect];
  const files = fixtureFiles(star.dir);
  const converted = convert(dialect, files);
  const plan = importPlan(converted.dbml);

  it('converts to DBML with the fact, three dimensions and three foreign keys', () => {
    expect(converted.tableCount).toBe(4);
    expect(converted.refCount).toBe(3);
    expect(plan.newTables.map((t) => t.name).sort()).toEqual([star.fact, ...star.dims].sort());
  });

  it('is DBML Import DBML reads without a problem, with no Records, Project or use lines', () => {
    expect(readDbml(converted.dbml).ok).toBe(true);
    expect(converted.dbml).not.toMatch(/^\s*(Records|Project|use)\b/m);
    // FK actions travel on the Ref, so Import's reference-settings report lists them; nothing else is dropped.
    expect(plan.report.dropped.filter((d) => d.kind !== 'reference-settings')).toEqual([]);
    expect(plan.report.renamed).toEqual([]);
  });

  it('keeps every schema qualifier', () => {
    for (const table of plan.newTables) expect(table.schema ?? '').toBe(star.schema);
  });

  it('keeps the columns, their types and the primary keys (the fact\'s composite)', () => {
    for (const [key, type] of Object.entries(star.types)) {
      const [table, column] = key.split('.');
      expect(columnOf(plan, table, column).dataType, key).toBe(type);
    }
    expect(pkOf(plan, star.fact)).toEqual(star.factPk);
    for (const dim of star.dims) expect(pkOf(plan, dim)).toHaveLength(1);
  });

  it('keeps table and column comments as descriptions', () => {
    for (const [key, text] of Object.entries(star.descriptions)) {
      const [table, column] = key.split('.');
      const description = column ? columnOf(plan, table, column).description : tableOf(plan, table).description;
      expect(description, key).toBe(text);
    }
  });

  it('stores each foreign key many → one, from the fact', () => {
    expect(linksOf(plan)).toEqual(star.links.map((l) => `${l} (many-to-one)`).sort());
    expect(plan.report.relationships).toBe(3);
  });

  it('names every table as ERD Studio requires', () => {
    for (const table of plan.newTables) expect(table.name).toMatch(TABLE_NAME_PATTERN);
    expect(converted.notes).toEqual([]);
  });

  it('is detected as its own dialect', () => {
    expect(detectSqlDialect(files.map((f) => f.text).join('\n'))).toBe(dialect);
  });

  it('says what it skipped by kind, never quoting the file', () => {
    expect(converted.skipped.length).toBeGreaterThan(0);
    for (const line of converted.skipped) {
      expect(line).toMatch(/^[\w.]+\.sql: /);
      expect(line).not.toMatch(/SELECT|INSERT INTO|\$\$/);
    }
    expect(converted.skipped.join('\n')).toMatch(/\bview\b/);
  });
});

// ---------------------------------------------------------------------------
// What each dialect's reading has to get right
// ---------------------------------------------------------------------------

describe('dialect details', () => {
  it('postgres: an ALTER TABLE in another file adds the foreign keys; the inline and ALTER copies are one Ref', () => {
    const [tables, constraints] = fixtureFiles('postgres');
    expect(convert('postgres', [tables]).refCount).toBe(1);
    const both = convert('postgres', [tables, constraints]);
    expect(both.refCount).toBe(3);
    expect(both.dbml.match(/^Ref: "sales"\."fct_order_line"\."customer_id"/gm)).toHaveLength(1);
    // Constraint names are not written (Import would read the name as a role); ON DELETE actions are, on the Ref.
    expect(both.dbml).not.toMatch(/fct_order_line_product_fk/);
    expect(both.dbml).toMatch(/^Ref: "sales"\."fct_order_line"\."order_date_key" > "sales"\."dim_date"\."date_key" \[delete: restrict\]$/m);
    expect(both.skipped).toContain('02_constraints.sql: skipped 1 ALTER TABLE … OWNER TO (ownership, not design)');
  });

  it('postgres: an enum type is kept for the column that uses it; identity, defaults, checks and unique come through', () => {
    const plan = importPlan(convert('postgres', fixtureFiles('postgres')).dbml);
    const status = columnOf(plan, 'fct_order_line', 'status');
    expect((status.meta?.[DBML_META_KEY] as Record<string, unknown>).enum).toEqual(['placed', 'shipped', 'returned']);
    expect(columnOf(plan, 'dim_product', 'product_id').meta?.[DBML_META_KEY]).toMatchObject({ increment: true });
    expect(columnOf(plan, 'dim_customer', 'email').meta?.[DBML_META_KEY]).toMatchObject({ unique: true });
    expect(columnOf(plan, 'dim_date', 'is_weekend').meta?.[DBML_META_KEY]).toMatchObject({ default: 'false' });
    expect(JSON.stringify(columnOf(plan, 'dim_product', 'unit_price').meta)).toContain('unit_price >= 0');
  });

  it('mysql: backticks, AUTO_INCREMENT, inline ENUM and a single-column UNIQUE KEY; plain KEYs are left out and counted', () => {
    const result = convert('mysql', fixtureFiles('mysql'));
    expect(result.dbml).toContain('"sku" varchar(32) [not null, unique]');
    expect(result.dbml).toContain('"country_code" char(2) [default: \'AU\']');
    expect(result.dbml).not.toMatch(/ix_country|ix_sold_at/);
    expect(result.skipped.join('\n')).toContain('2 non-unique indexes inside tables (indexes are not imported)');
    const plan = importPlan(result.dbml);
    expect((columnOf(plan, 'dim_product', 'category').meta?.[DBML_META_KEY] as Record<string, unknown>).enum).toEqual(['hardware', 'software', 'service']);
  });

  it('sqlserver: GO batches, [brackets], IDENTITY(1,1) and MS_Description extended properties', () => {
    const result = convert('sqlserver', fixtureFiles('sqlserver'));
    expect(result.dbml).toContain('"CustomerKey" int [pk, increment]');
    expect(result.dbml).not.toMatch(/IDENTITY|\[dbo\]/);
    expect(result.skipped).toEqual(['warehouse.sql: skipped 3 session statements (SET, USE…), 3 table options (ENGINE, CHARSET, ON [filegroup], USING, CLUSTER BY…: physical, not design), 1 index, 1 view']);
  });

  it('snowflake: CREATE OR REPLACE TRANSIENT, database.schema.table names, CLUSTER BY and COMMENT =', () => {
    const result = convert('snowflake', fixtureFiles('snowflake'));
    expect(result.dbml).toContain('Table "ANALYTICS"."DIM_CUSTOMER" {');
    expect(result.dbml).not.toMatch(/RAW_DB|cluster/i);
  });

  it('databricks: Delta clauses go, catalogs go, complex types stay as written, identity columns are increments', () => {
    const result = convert('databricks', fixtureFiles('databricks'));
    expect(result.dbml).not.toMatch(/DELTA|TBLPROPERTIES|PARTITIONED|LOCATION|OPTIONS|RELY|ENFORCED|erd_sql_type|"main"/);
    expect(result.dbml).toContain('"customer_id" BIGINT [pk, increment, note: \'Surrogate key\']');
    // A computed column keeps its type; its expression is not a default.
    expect(result.dbml).toContain('"order_month" DATE\n');
  });

  it('databricks: a syntax error names the line in the user\'s file, after the rewrite', () => {
    const text = [
      '-- lakehouse',
      'CREATE OR REPLACE TABLE main.gold.t (',
      '  id BIGINT COMMENT \'key\',',
      '  tags ARRAY<STRUCT<a: INT,',
      '    b: STRING>>,',
      '  bad BIGINT oops oops',
      ') USING DELTA',
      'TBLPROPERTIES (\'x\' = \'y\');',
    ].join('\n');
    expect(problemsOf('databricks', [{ name: 'lake.sql', text }])).toEqual([
      expect.objectContaining({ file: 'lake.sql', line: 6, message: expect.stringContaining('CREATE TABLE gold.t could not be read') }),
    ]);
  });

  it('sqlserver: a syntax error names its line inside a GO batch', () => {
    const text = 'SET NOCOUNT ON\nGO\nCREATE TABLE [dbo].[a] (\n  [id] int NOT NULL,\n  [x] int,,\n)\nGO\n';
    expect(problemsOf('sqlserver', [{ name: 'a.sql', text }])).toEqual([
      expect.objectContaining({ file: 'a.sql', line: 5 }),
    ]);
  });

  it.each([
    ['mysql', "CREATE TABLE `a` (`id` int PRIMARY KEY COMMENT 'it\\'s the ''key''', `b` varchar(9) DEFAULT 'x''y') COMMENT='the \"a\" table';"],
    ['snowflake', "create table a (id int primary key comment 'it\\'s the ''key''', b varchar(9) default 'x''y') comment = 'the \"a\" table';"],
    ['databricks', "CREATE TABLE a (id INT COMMENT 'it\\'s the \\'key\\'', b STRING DEFAULT 'x\\'y', CONSTRAINT pk PRIMARY KEY (id)) COMMENT 'the \"a\" table';"],
    ['postgres', "CREATE TABLE a (id int PRIMARY KEY, b varchar(9) DEFAULT 'x''y');\nCOMMENT ON TABLE a IS 'the \"a\" table';\nCOMMENT ON COLUMN a.id IS 'it''s the ''key''';"],
    ['sqlserver', "CREATE TABLE a (id int PRIMARY KEY, b varchar(9) DEFAULT ('x''y'))\nGO\nEXEC sp_addextendedproperty 'MS_Description', N'the \"a\" table', 'SCHEMA', 'dbo', 'TABLE', 'a'\nGO\nEXEC sp_addextendedproperty N'MS_Description', N'it''s the ''key''', N'SCHEMA', N'dbo', N'TABLE', N'a', N'COLUMN', N'id'"],
  ] as const)('%s: quotes and escapes in comments and string defaults come through once', (dialect, text) => {
    const plan = importPlan(convert(dialect, [{ name: 'a.sql', text }]).dbml);
    expect(columnOf(plan, 'a', 'id').description).toBe("it's the 'key'");
    expect(tableOf(plan, 'a').description).toBe('the "a" table');
    expect(columnOf(plan, 'a', 'b').meta?.[DBML_META_KEY]).toMatchObject({ default: "x'y" });
  });
});

// ---------------------------------------------------------------------------
// Problems, skips, names
// ---------------------------------------------------------------------------

describe('problems', () => {
  it('a broken file names its file and the line of the statement that does not parse; the rest still imports', () => {
    const result = convert('postgres', fixtureFiles('broken'));
    expect(result.problems).toEqual([
      { file: 'stray_words.sql', line: 6, message: expect.stringMatching(/^CREATE TABLE fct_order could not be read: .*oops/), kind: 'parse', clause: 'CreateTable', cause: 'parseError', table: 'fct_order' },
    ]);
    // dim_customer read: one bad table never stops the import.
    expect(result.tableCount).toBe(1);
    expect(result.tablesFound).toBe(2);
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'problem', unit: 'table', where: { file: 'stray_words.sql', line: 6, table: 'fct_order' } }));
  });

  it('every file is read: problems in two files are both reported', () => {
    const broken = fixtureFiles('broken')[0];
    const problems = partialProblemsOf('postgres', [broken, { name: 'b.sql', text: '\n\nCREATE TABLE b (id int,, x int);' }]);
    expect(problems.map((p) => `${p.file}:${p.line}`)).toEqual(['stray_words.sql:6', 'b.sql:3']);
  });

  it('a table defined twice, in two files: the first is kept, the second reported naming both', () => {
    const result = convert('postgres', [
      { name: 'a.sql', text: 'CREATE TABLE sales.customer (id int);' },
      { name: 'b.sql', text: '-- again\nCREATE TABLE SALES.Customer (id int, name text);' },
    ]);
    expect(result.problems).toEqual([{
      file: 'b.sql', line: 2, message: 'Table SALES.Customer is defined twice (also in a.sql, line 1); the first definition is kept.',
      kind: 'duplicateTable', cause: 'duplicate', table: 'SALES.Customer',
    }]);
    expect(result.tableCount).toBe(1);
    expect(result.dbml).not.toMatch(/"name"/);
  });

  it('public.t and t are the same Postgres table', () => {
    expect(partialProblemsOf('postgres', [{ name: 'a.sql', text: 'CREATE TABLE public.t (id int);\nCREATE TABLE t (id int);' }])[0].message).toMatch(/defined twice/);
  });

  it('no CREATE TABLE at all is a problem', () => {
    expect(problemsOf('postgres', [{ name: 'v.sql', text: 'CREATE VIEW v AS SELECT 1;\nGRANT SELECT ON v TO bob;' }])).toEqual([
      { file: 'v.sql', message: 'No CREATE TABLE statements with a column list were found in the file.', kind: 'noCreateTable' },
    ]);
    expect(problemsOf('postgres', [])).toEqual([{ file: '', message: 'No SQL files to import.', kind: 'noFiles' }]);
  });

  it('a column defined twice is a problem', () => {
    expect(problemsOf('mysql', [{ name: 'a.sql', text: 'CREATE TABLE a (id int, ID int);' }])[0].message).toBe('CREATE TABLE a has the column ID twice.');
  });
});

describe('skips', () => {
  it('a foreign key to a table not in the files is skipped and said so', () => {
    const result = convert('postgres', [{
      name: 'a.sql',
      text: 'CREATE TABLE fct (id int PRIMARY KEY, c int REFERENCES crm.customer (id));\nALTER TABLE fct ADD FOREIGN KEY (id) REFERENCES fct (nope);',
    }]);
    expect(result.refCount).toBe(0);
    expect(result.dbml).not.toContain('Ref:');
    expect(result.skipped).toEqual([
      'a.sql line 1: foreign key fct(c) → crm.customer: that table is not in the files',
      'a.sql line 2: foreign key fct(id) → fct: a column it names is not in the table',
    ]);
  });

  it('REFERENCES with no columns means the primary key; composite foreign keys stay composite', () => {
    const result = convert('postgres', [{
      name: 'a.sql',
      text: [
        'CREATE TABLE d (a int, b int, PRIMARY KEY (a, b));',
        'CREATE TABLE f (id int PRIMARY KEY, x int, y int, FOREIGN KEY (x, y) REFERENCES d);',
      ].join('\n'),
    }]);
    expect(result.dbml).toContain('Ref: "f".("x", "y") > "d".("a", "b")');
    const plan = importPlan(result.dbml);
    expect(plan.relationships.map((r) => [r.fromColumn, r.toColumn, !!r.compositeKey])).toEqual([['x', 'a', true], ['y', 'b', true]]);
  });

  it('CREATE TABLE … AS SELECT has no column list and is skipped', () => {
    const result = convert('snowflake', [{ name: 'a.sql', text: 'create table a (id number);\ncreate or replace table b as select * from a;\ncreate table c clone a;' }]);
    expect(result.tableCount).toBe(1);
    expect(result.skipped).toEqual(['a.sql: skipped 2 CREATE TABLEs without a column list (AS SELECT, LIKE, CLONE)']);
  });

  it('a file that gives nothing says so', () => {
    const result = convert('postgres', [
      { name: 'a.sql', text: 'CREATE TABLE a (id int);' },
      { name: 'grants.sql', text: 'GRANT SELECT ON a TO bob;' },
    ]);
    // Said once: a file whose statements were only skipped is not also "no tables, keys or comments".
    expect(result.skipped).toEqual(['grants.sql: skipped 1 permission statement (GRANT, REVOKE)']);
    const empty = convert('postgres', [{ name: 'a.sql', text: 'CREATE TABLE a (id int);' }, { name: 'empty.sql', text: '-- nothing here\n' }]);
    expect(empty.skipped).toEqual(['empty.sql: no tables, keys or comments in it']);
  });

  it('a comment on a column that does not exist is skipped', () => {
    const result = convert('postgres', [{ name: 'a.sql', text: "CREATE TABLE a (id int);\nCOMMENT ON COLUMN a.nope IS 'x';\nCOMMENT ON COLUMN b.id IS 'y';" }]);
    expect(result.skipped).toEqual([
      'a.sql line 2: a comment on a.nope, which is not one of its columns',
      'a.sql line 3: a comment on b, which is not in the files',
    ]);
  });
});

describe('names', () => {
  it('a table name ERD Studio cannot use becomes the nearest one it can, and the note says so', () => {
    const result = convert('postgres', [{
      name: 'odd.sql',
      text: 'CREATE TABLE "Order Items" (id int PRIMARY KEY);\nCREATE TABLE _staging (id int, item int REFERENCES "Order Items" (id));\nCREATE TABLE "Order_Items" (id int);',
    }]);
    const plan = importPlan(result.dbml);
    expect(plan.newTables.map((t) => [t.name, t.alias])).toEqual([['Order_Items_2', undefined], ['staging', '_staging'], ['Order_Items', undefined]]);
    expect(linksOf(plan)).toEqual(['staging.item > Order_Items_2.id (many-to-one)']);
    expect(result.notes).toEqual([
      'Table "Order Items" (odd.sql) is imported as Order_Items_2: table names start with a letter and use only letters, digits and underscores.',
      'Table "_staging" (odd.sql) is imported as staging: table names start with a letter and use only letters, digits and underscores; _staging stays its warehouse name.',
    ]);
    expect(plan.report.renamed).toEqual([]);
  });

  it('a schema with odd characters is made a folder-safe name', () => {
    const result = convert('postgres', [{ name: 'a.sql', text: 'CREATE TABLE "my schema".t (id int);' }]);
    expect(result.dbml).toContain('Table "my_schema"."t"');
    expect(result.notes).toEqual(['Schema "my schema" is imported as my_schema: schema names use letters, digits and underscores.']);
  });

  it('describeDbmlImportPlan has nothing to say about dropped DBML features', () => {
    const plan = importPlan(convert('sqlserver', fixtureFiles('sqlserver')).dbml);
    const summary = describeDbmlImportPlan(plan);
    expect(summary).not.toMatch(/Records|optional|reference setting|role/i);
  });
});

// ---------------------------------------------------------------------------
// Dialects, detection, the engine seam
// ---------------------------------------------------------------------------

describe('dialects', () => {
  it('lists five dialects with labels; sqlserver reads with the mssql grammar', () => {
    expect([...SQL_DIALECTS]).toEqual(['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks']);
    for (const d of SQL_DIALECTS) expect(SQL_DIALECT_LABELS[d]).toBeTruthy();
    expect(isSqlDialect('sqlserver')).toBe(true);
    expect(isSqlDialect('oracle')).toBe(false);
    const formats: string[] = [];
    convertSqlDdl({ dialect: 'sqlserver', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int)' }] }, (sql, format) => {
      formats.push(format);
      return dbmlCoreSqlEngine(sql, format);
    });
    expect(formats).toEqual(['mssql']);
  });

  it('an unknown dialect is a problem, not a throw', () => {
    expect(convertSqlDdl({ dialect: 'oracle' as SqlDialect, files: [{ name: 'a.sql', text: '' }] }, dbmlCoreSqlEngine)).toEqual({
      ok: false,
      problems: [{ file: '', message: 'Unknown SQL dialect: oracle.' }],
    });
  });

  it('detects from cheap signals, and says nothing when nothing points anywhere', () => {
    expect(detectSqlDialect('CREATE TABLE [dbo].[a] ([id] int)\nGO')).toBe('sqlserver');
    expect(detectSqlDialect('CREATE TABLE t (a STRING) USING DELTA')).toBe('databricks');
    expect(detectSqlDialect('CREATE TABLE `t` (`a` int) ENGINE=InnoDB;')).toBe('mysql');
    expect(detectSqlDialect('CREATE OR REPLACE TRANSIENT TABLE t (a NUMBER(38,0));')).toBe('snowflake');
    expect(detectSqlDialect('CREATE TABLE t (id SERIAL, j JSONB);')).toBe('postgres');
    expect(detectSqlDialect('CREATE TABLE t (id int);')).toBeUndefined();
    expect(detectSqlDialect('-- USING DELTA in a comment\nCREATE TABLE t (id int);')).toBeUndefined();
  });

  it('a grammar crash is never thrown: the table is salvaged without the grammar', () => {
    const crash = (): never => { throw new TypeError("Cannot read properties of undefined (reading 'fields')"); };
    const result = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int);' }] }, crash);
    expect(result).toMatchObject({ ok: true, tableCount: 1, problems: [], tablesFound: 1, readWith: { grammar: 0, repaired: 0, salvaged: 1 } });
    expect(result.ok && result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', unit: 'table', cause: 'grammarGap', what: 'column list', where: { file: 'a.sql', line: 1, table: 'a' } }));
  });

  it('a grammar crash on a table salvage cannot read either is a problem, in plain words, never thrown', () => {
    const crash = (): never => { throw new TypeError("Cannot read properties of undefined (reading 'fields')"); };
    const result = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int frobnicate);' }] }, crash);
    expect(result).toEqual({
      ok: false,
      problems: [{ file: 'a.sql', line: 1, message: 'CREATE TABLE a could not be read: unexpected "frobnicate" after the type of id', kind: 'parse', clause: 'CreateTable', cause: 'parseError', table: 'a' }],
      // The ledger holds the same problem, by class and place (no message text), and how many tables the files hold.
      ledger: [{ outcome: 'problem', unit: 'table', cause: 'parseError', what: 'CREATE TABLE', count: 1, where: { file: 'a.sql', line: 1, table: 'a' }, detail: 'could not be read: a syntax error (Show Logs has each line)' }],
      tablesFound: 1,
      readWith: { grammar: 0, repaired: 0, salvaged: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// The loader and the bundle boundary
// ---------------------------------------------------------------------------

describe('loadSqlImport', () => {
  it('requires dist/sqlImport.js under the extension once, and checks it is the importer', () => {
    const loads: string[] = [];
    const fake = { sqlDdlToDbml, detectSqlDialect };
    const extensionPath = path.join(ROOT, 'fake-extension-' + Date.now());
    const first = loadSqlImport(extensionPath, (file) => { loads.push(file); return fake; });
    const second = loadSqlImport(extensionPath, (file) => { loads.push(file); return fake; });
    expect(first).toBe(second);
    expect(loads).toEqual([path.join(extensionPath, 'dist', SQL_IMPORT_BUNDLE)]);
    expect(sqlImportBundlePath('/ext')).toBe(path.join('/ext', 'dist', 'sqlImport.js'));
    expect(first.sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int);' }] }).ok).toBe(true);
  });

  it('says which file it could not load', () => {
    expect(() => loadSqlImport('/missing-' + Date.now(), () => { throw new Error('Cannot find module'); }))
      .toThrow(/could not load its SQL importer \(dist\/sqlImport\.js\): Cannot find module/);
    expect(() => loadSqlImport('/wrong-' + Date.now(), () => ({})))
      .toThrow(/dist\/sqlImport\.js is not the importer/);
  });
});

describe('bundle boundary', () => {
  const inputsOf = async (entry: string, options: Parameters<typeof build>[0] = {}): Promise<string[]> => {
    const result = await build({
      entryPoints: [path.join(ROOT, entry)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      loader: { '.md': 'text' },
      metafile: true,
      logLevel: 'silent',
      ...options,
    });
    return Object.keys(result.metafile!.inputs);
  };

  it('dist/extension.js and dist/cli.js never bundle @dbml/core (the loader only type-imports the engine)', async () => {
    const extension = await inputsOf('src/extension.ts', { external: ['vscode'], define: { __ERD_EXAMPLES__: '[]' } });
    const cli = await inputsOf('src/cli/index.ts', { define: { __ERD_CLI_VERSION__: '"0.0.0-test"' } });
    for (const inputs of [extension, cli]) {
      expect(inputs.filter((i) => i.includes('node_modules/@dbml/core/'))).toEqual([]);
      expect(inputs.filter((i) => i.endsWith('src/services/sqlImportEngine.ts'))).toEqual([]);
    }
  }, 60_000);

  it('dist/sqlImport.js bundles @dbml/core with one @dbml/parse and no vscode', async () => {
    const vscodeImporters: string[] = [];
    const inputs = await inputsOf('src/services/sqlImportEngine.ts', {
      plugins: [{
        name: 'no-vscode',
        setup(b) {
          b.onResolve({ filter: /^vscode$/ }, (args) => {
            vscodeImporters.push(args.importer);
            return { path: 'vscode', external: true };
          });
        },
      }],
    });
    expect(vscodeImporters).toEqual([]);
    expect(inputs.some((i) => i.startsWith('node_modules/@dbml/core/'))).toBe(true);
    expect(inputs.filter((i) => /node_modules\/.+\/node_modules\/@dbml\/parse\//.test(i))).toEqual([]);
  }, 60_000);

  it('the importer pins @dbml/core 11.0.0, which shares the root @dbml/parse pin', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@dbml/core']).toBe('11.0.0');
    expect(pkg.dependencies['@dbml/parse']).toBe('11.0.0');
    expect(fs.existsSync(path.join(ROOT, 'node_modules/@dbml/core/node_modules/@dbml/parse'))).toBe(false);
  });
});

describe('migrations: later schema changes applied in file order', () => {
  const flyway: SqlDdlFile[] = [
    { name: 'V1__init.sql', text: 'CREATE TABLE public.customer (\n  customer_id serial PRIMARY KEY,\n  email text NOT NULL UNIQUE\n);\nCREATE TABLE public.orders (\n  order_id bigserial PRIMARY KEY,\n  customer_id integer NOT NULL REFERENCES public.customer(customer_id)\n);\nCREATE TABLE public.legacy (id int);\n' },
    { name: 'V2__add_product.sql', text: 'CREATE TABLE public.product (\n  product_id serial PRIMARY KEY,\n  sku varchar(40) NOT NULL\n);\nALTER TABLE public.orders ADD COLUMN product_id integer;\n' },
    { name: 'V3__fk.sql', text: 'ALTER TABLE public.orders ADD CONSTRAINT fk_orders_product FOREIGN KEY (product_id) REFERENCES public.product(product_id);\n' },
    { name: 'V4__rename.sql', text: 'ALTER TABLE public.customer RENAME COLUMN email TO email_address;\nDROP TABLE IF EXISTS public.legacy;\nALTER TABLE public.orders RENAME TO purchase;\n' },
    { name: 'V5__drop.sql', text: 'ALTER TABLE public.product DROP COLUMN sku;\nALTER TABLE public.purchase ALTER COLUMN order_id SET DATA TYPE numeric(20,0);\nCREATE TABLE IF NOT EXISTS public.customer (id int);\n' },
  ];

  it('Flyway: columns added, renamed, retyped and dropped, a table renamed and one dropped, and the keys follow', () => {
    const result = convert('postgres', flyway);
    expect(result.tableCount).toBe(3);
    expect(result.dbml).toContain('"email_address" text [not null, unique]');
    expect(result.dbml).not.toMatch(/"email" text|legacy|"sku"/);
    expect(result.dbml).toMatch(/Table "public"\."purchase" \{[\s\S]*"order_id" numeric\(20,0\)[\s\S]*"product_id" integer/);
    expect(result.dbml).toContain('Ref: "public"."purchase"."product_id" > "public"."product"."product_id"');
    expect(result.dbml).toContain('Ref: "public"."purchase"."customer_id" > "public"."customer"."customer_id"');
    expect(result.notes.some((n) => /^\d+ later schema changes were applied in file order/.test(n))).toBe(true);
    expect(result.skipped).toContain('V5__drop.sql: skipped 1 CREATE TABLE IF NOT EXISTS of a table already defined');
  });

  it('what cannot be applied is skipped and said, with its file and line, never silently', () => {
    const result = convert('postgres', [
      { name: 'a.sql', text: 'CREATE TABLE t (id int);\n' },
      { name: 'b.sql', text: 'ALTER TABLE missing ADD COLUMN x int;\nALTER TABLE t RENAME COLUMN nope TO yes;\nALTER TABLE t DROP COLUMN gone;\n' },
    ]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      'b.sql line 1: a column added on missing, which is not in the files (not applied)',
      'b.sql line 2: t.nope renamed, but it has no such column (not applied)',
      'b.sql line 3: t.gone dropped, but it has no such column (not applied)',
    ]));
  });

  it('MySQL CHANGE / MODIFY / RENAME TABLE, SQL Server ADD a, b and sp_rename, Databricks ADD COLUMNS (…)', () => {
    const mysql = convert('mysql', [{ name: 'm.sql', text: 'CREATE TABLE `c` (`id` int NOT NULL, `nm` varchar(10));\nALTER TABLE `c` CHANGE COLUMN `nm` `name` varchar(100) NOT NULL AFTER `id`, MODIFY `id` bigint NOT NULL;\nRENAME TABLE `c` TO `customer`;\n' }]);
    expect(mysql.dbml).toMatch(/Table "customer" \{\n  "id" bigint \[not null\]\n  "name" varchar\(100\) \[not null\]\n\}/);
    const mssql = convert('sqlserver', [{ name: 's.sql', text: 'CREATE TABLE [dbo].[Customer] ([Id] INT NOT NULL, [Email] NVARCHAR(256));\nGO\nALTER TABLE [dbo].[Customer] ADD [Phone] NVARCHAR(20) NULL, [Tier] INT;\nGO\nEXEC sp_rename \'dbo.Customer.Email\', \'EmailAddress\', \'COLUMN\';\nGO\n' }]);
    expect(mssql.dbml).toMatch(/"EmailAddress" NVARCHAR\(256\)/);
    expect(mssql.dbml).toMatch(/"Phone" NVARCHAR\(20\)/);
    expect(mssql.dbml).toMatch(/"Tier" INT/);
    const spark = convert('databricks', [{ name: 'd.sql', text: 'CREATE TABLE main.s.t (id BIGINT);\nALTER TABLE main.s.t ADD COLUMNS (tags ARRAY<STRING> COMMENT \'labels\', amount DECIMAL(12,2));\n' }]);
    expect(spark.dbml).toMatch(/"tags" "ARRAY<STRING>" \[note: 'labels'\]|"tags" ARRAY<STRING> \[note: 'labels'\]/);
    expect(spark.dbml).toMatch(/"amount" DECIMAL\(12,2\)/i);
  });

  it('a teardown script read after the CREATEs (a folder or a multi-pick) drops nothing: its DROPs are skipped, as before', () => {
    const result = convert('postgres', [
      { name: 'sql/create_tables.sql', text: 'CREATE TABLE customer (id int PRIMARY KEY);\nCREATE TABLE orders (id int, customer_id int REFERENCES customer(id));\n' },
      { name: 'sql/drop_tables.sql', text: 'DROP TABLE IF EXISTS orders;\nDROP TABLE IF EXISTS customer;\n' },
    ]);
    expect(result.tableCount).toBe(2);
    expect(result.skipped).toContain('sql/drop_tables.sql: skipped 2 DROP statements');
    expect(result.notes.some((n) => /later schema change/.test(n))).toBe(false);
  });

  it('a migration of DROPs alone is still applied when it is named like one', () => {
    const files = [
      { name: 'V1__init.sql', text: 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n' },
      { name: 'V2__drop_b.sql', text: 'DROP TABLE b;\n' },
    ];
    expect(convert('postgres', files).tableCount).toBe(1);
    expect(convert('postgres', [files[0], { name: 'db/migrations/drop_b.sql', text: 'DROP TABLE b;\n' }]).tableCount).toBe(1);
    expect(convert('postgres', [files[0], { name: '002_drop_b.sql', text: 'DROP TABLE b;\n' }]).tableCount).toBe(1);
    expect(looksLikeMigrationFile('sql/teardown.sql')).toBe(false);
    expect(looksLikeMigrationFile('reset.sql')).toBe(false);
  });

  it('a dump that drops each table before creating it is unchanged (nothing to drop yet)', () => {
    const result = convert('mysql', [{ name: 'dump.sql', text: 'DROP TABLE IF EXISTS `a`;\nCREATE TABLE `a` (`id` int);\nDROP TABLE IF EXISTS `b`;\nCREATE TABLE `b` (`id` int);\n' }]);
    expect(result.tableCount).toBe(2);
    expect(result.skipped).toContain('dump.sql: skipped 2 DROP statements');
    expect(result.notes.some((n) => /later schema change/.test(n))).toBe(false);
  });
});

describe('what the folder looks count, and a dump without its data', () => {
  it('counts CREATE TABLEs with a column list by the converter\'s own reading', () => {
    expect(countCreateTablesWithColumns('CREATE TABLE a (id int);\nCREATE TABLE b AS SELECT 1;\ncreate table c as (select 1);\nCREATE TABLE d (x, y) AS SELECT 1, 2;\n')).toBe(1);
    expect(countCreateTablesWithColumns("{% macro m() %}\ncreate or replace table {{ relation }}\n as (\n {{ sql }} );\n{% endmacro %}")).toBe(0);
    expect(countCreateTablesWithColumns("SELECT 'CREATE TABLE x (id int)';")).toBe(0);
    expect(countCreateTablesWithColumns('CREATE TABLE [dbo].[A]([Id] [int])\nGO\nCREATE TABLE `b` (`id` INT) ENGINE=InnoDB;')).toBe(2);
    expect(countCreateTablesWithColumns('CREATE TABLE IF NOT EXISTS "users" ("id" SERIAL PRIMARY KEY);')).toBe(1);
    // A typed empty SELECT is a column list; a SELECT from a table is not.
    expect(countCreateTablesWithColumns('CREATE TABLE p USING DELTA AS SELECT CAST(NULL AS int) AS id WHERE 1 = 0;\nCREATE TABLE q AS SELECT CAST(id AS int) AS id FROM p;')).toBe(1);
  });

  it('knows Oracle DDL, and not Snowflake\'s NUMBER', () => {
    expect(looksLikeOracleSql('CREATE TABLE HR.E (ID NUMBER(6), EMAIL VARCHAR2(25 BYTE));')).toBe(true);
    expect(looksLikeOracleSql('create or replace TABLE A.B.C (ID NUMBER(38,0), E VARCHAR(16777216));')).toBe(false);
  });

  it('takes pg_dump\'s COPY rows and a big dump\'s INSERTs out, keeping every line break and the statements to count', () => {
    const dump = 'CREATE TABLE a (id int, note text);\nCOPY public.a (id, note) FROM stdin;\n1\tO\'Brien;\n2\tx\n\\.\nALTER TABLE ONLY a ADD CONSTRAINT a_pkey PRIMARY KEY (id);\n';
    const out = withoutSqlData(dump);
    expect(out.text.split('\n')).toHaveLength(dump.split('\n').length);
    expect(out.text).not.toContain("O'Brien");
    expect(out.text).toContain('ALTER TABLE ONLY a ADD CONSTRAINT a_pkey PRIMARY KEY (id);');
    expect(out.sqlChars).toBeLessThan(dump.length);
    const result = convert('postgres', [{ name: 'd.sql', text: out.text }]);
    expect(result.dbml).toContain('"id" int [pk]');
    // A small script keeps its INSERTs; a big one loses them (strings with ; and \' respected).
    expect(withoutSqlData("INSERT INTO a VALUES (1, 'x;y');\n").text).toBe("INSERT INTO a VALUES (1, 'x;y');\n");
    const rows = Array.from({ length: 30_000 }, (_, i) => `INSERT INTO \`a\` VALUES (${i},'it\\'s; fine'),(${i},'b');`).join('\n');
    const big = `-- MySQL dump 10.13\nCREATE TABLE \`a\` (\`id\` int, \`note\` text);\n${rows}\nCREATE TABLE \`b\` (\`id\` int);\n`;
    const stripped = withoutSqlData(big);
    expect(stripped.text.split('\n')).toHaveLength(big.split('\n').length);
    expect(stripped.sqlChars).toBeLessThan(200);
    const converted = convert('mysql', [{ name: 'dump.sql', text: stripped.text }]);
    expect(converted.tableCount).toBe(2);
    expect(converted.skipped).toContain('dump.sql: skipped 30000 data statements (INSERT, UPDATE…)');
  });

  it('a folder with no CREATE TABLE in it says so for each file, at its first line', () => {
    const result = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'SELECT 1;' }, { name: 'keys/b.sql', text: 'CREATE VIEW v AS SELECT 1;' }] }, dbmlCoreSqlEngine);
    expect(result.ok).toBe(false);
    expect(result.ledger?.filter((e) => e.outcome === 'problem').map((e) => e.where)).toEqual([{ file: 'a.sql', line: 1 }, { file: 'keys/b.sql', line: 1 }]);
  });

  it('splits a file\'s skipped summary into lines of at most 300 characters, every kind still counted', () => {
    const sql = [
      'SET x = 1;', 'CREATE VIEW v AS SELECT 1;', 'CREATE INDEX i ON a (id);', 'CREATE SEQUENCE s;', 'DROP TABLE IF EXISTS z;',
      'CREATE SCHEMA k;', 'GRANT SELECT ON a TO u;', 'SELECT 1;', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;',
      'CREATE TYPE r AS (a int);', 'COMMENT ON SCHEMA k IS \'x\';', 'ALTER TABLE a OWNER TO u;', 'ALTER TABLE a ENABLE ROW LEVEL SECURITY;',
      'CREATE TABLE a (id int) WITH (fillfactor = 70);', 'CREATE TABLE b AS SELECT 1;', 'VACUUM a;',
    ].join('\n');
    const result = convert('postgres', [{ name: 'pagila-schema.sql', text: sql }]);
    expect(result.skipped.length).toBeGreaterThan(1);
    for (const line of result.skipped) expect(line.length).toBeLessThanOrEqual(300);
    expect(result.skipped[0]).toMatch(/^pagila-schema\.sql: skipped /);
    expect(result.skipped[1]).toMatch(/^pagila-schema\.sql: also skipped /);
    const all = result.skipped.join(', ');
    for (const kind of ['1 view', '1 index', '1 sequence', '1 DROP statement', '1 query', '1 CREATE TABLE without a column list']) expect(all).toContain(kind);
  });

  it('ends a big script\'s INSERT with no `;` at its GO line or the next statement, never at a `;` further on', () => {
    // SQL Server install scripts (Northwind) write INSERTs with no `;`, batched by GO: a CREATE TABLE after them is kept.
    const rows = Array.from({ length: 40_000 }, (_, i) => `Insert Into Region Values (${i},'Eastern')`).join('\n');
    const big = `CREATE TABLE [dbo].[A] ([Id] [int] NOT NULL)\nGO\n${rows}\nGo\nCREATE TABLE [dbo].[B] ([Id] [int] NOT NULL)\nINSERT INTO B VALUES (1)\nCREATE TABLE [dbo].[C] ([Id] [int] NOT NULL);\nSELECT 1;\n`;
    const stripped = withoutSqlData(big);
    expect(stripped.text.split('\n')).toHaveLength(big.split('\n').length);
    expect(stripped.text).toContain('CREATE TABLE [dbo].[B]');
    expect(stripped.text).toContain('CREATE TABLE [dbo].[C]');
    expect(stripped.text).not.toContain('Eastern');
    const converted = convert('sqlserver', [{ name: 'instnwnd.sql', text: stripped.text }]);
    expect(converted.tableCount).toBe(3);
  });
});
