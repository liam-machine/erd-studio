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
  detectSqlDialect,
  isSqlDialect,
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
    expect(plan.report.dropped).toEqual([]);
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
    // Constraint names and ON DELETE actions are not written: Import would read the name as a role.
    expect(both.dbml).not.toMatch(/fct_order_line_product_fk|delete:/);
    expect(both.skipped).toContain('02_constraints.sql: skipped 1 ALTER TABLE other than adding a key');
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
    expect(result.skipped).toEqual(['warehouse.sql: skipped 3 session statements (SET, USE…), 1 index, 1 view']);
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
  it('a broken file names its file and the line of the statement that does not parse', () => {
    expect(problemsOf('postgres', fixtureFiles('broken'))).toEqual([
      { file: 'stray_words.sql', line: 6, message: expect.stringMatching(/^CREATE TABLE fct_order could not be read: .*oops/) },
    ]);
  });

  it('every file is read: problems in two files are both reported', () => {
    const broken = fixtureFiles('broken')[0];
    const problems = problemsOf('postgres', [broken, { name: 'b.sql', text: '\n\nCREATE TABLE b (id int,, x int);' }]);
    expect(problems.map((p) => `${p.file}:${p.line}`)).toEqual(['stray_words.sql:6', 'b.sql:3']);
  });

  it('a table defined twice, in two files, is a problem naming both', () => {
    const problems = problemsOf('postgres', [
      { name: 'a.sql', text: 'CREATE TABLE sales.customer (id int);' },
      { name: 'b.sql', text: '-- again\nCREATE TABLE SALES.Customer (id int, name text);' },
    ]);
    expect(problems).toEqual([{ file: 'b.sql', line: 2, message: 'Table SALES.Customer is defined twice (also in a.sql, line 1).' }]);
  });

  it('public.t and t are the same Postgres table', () => {
    expect(problemsOf('postgres', [{ name: 'a.sql', text: 'CREATE TABLE public.t (id int);\nCREATE TABLE t (id int);' }])[0].message).toMatch(/defined twice/);
  });

  it('no CREATE TABLE at all is a problem', () => {
    expect(problemsOf('postgres', [{ name: 'v.sql', text: 'CREATE VIEW v AS SELECT 1;\nGRANT SELECT ON v TO bob;' }])).toEqual([
      { file: 'v.sql', message: 'No CREATE TABLE statements with a column list were found in the file.' },
    ]);
    expect(problemsOf('postgres', [])).toEqual([{ file: '', message: 'No SQL files to import.' }]);
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
    expect(result.skipped).toEqual(['grants.sql: no tables, keys or comments in it', 'grants.sql: skipped 1 permission statement (GRANT, REVOKE)']);
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

  it('a grammar crash is reported as a problem, never thrown', () => {
    const result = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int);' }] }, () => {
      throw new TypeError("Cannot read properties of undefined (reading 'fields')");
    });
    expect(result).toEqual({ ok: false, problems: [{ file: 'a.sql', line: 1, message: 'CREATE TABLE a could not be read: the SQL parser could not read this statement' }] });
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
