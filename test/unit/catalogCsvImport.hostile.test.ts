/**
 * Hostile catalog exports: every file a user could pick in Import SQL DDL…'s
 * dialog as a `.csv` (broken exports, client decorations, files that are not
 * catalog exports at all, awkward names, types and comments). Each one
 * either converts to DBML that Import DBML's own flow reads (the draft is
 * drawn) or is refused with a message; none throws. The cases are the
 * prototype's 48, with what it got wrong fixed (a 5,000-character name, two
 * tables whose names differ only by case, no size limit).
 */
import { describe, expect, it } from 'vitest';

import { MAX_CATALOG_ROWS, catalogCsvToDbml, catalogOriginPhrase, type CatalogCsvResult } from '../../src/services/catalogCsvImport';
import { readsAsDbml } from '../../src/services/sqlImportEngine';
import { importDbmlFlow, type ImportRun } from './realWorldScorecard';

type Ok = Extract<CatalogCsvResult, { ok: true }>;

/** The conversion, then Import DBML's flow, as the command runs them; a refusal is its message. */
function attempt(text: string): { result: CatalogCsvResult; run?: ImportRun } {
  const result = catalogCsvToDbml([{ name: 'export.csv', text }], readsAsDbml);
  if (!result.ok) return { result };
  const run = importDbmlFlow(result.dbml, 'export.dbml', 'sql', {
    from: catalogOriginPhrase(['export.csv']), notes: result.notes, skipped: result.skipped, ledger: result.ledger, ...(result.notice ? { notice: result.notice } : {}),
  });
  return { result, run };
}
function converts(text: string): { result: Ok; run: ImportRun } {
  const { result, run } = attempt(text);
  if (!result.ok) throw new Error(`refused: ${result.problems.map((p) => p.message).join(' | ')}`);
  expect(run?.ok, run?.failureMessage).toBe(true);
  // Nothing the writer wrote had to be left out to read back.
  expect(result.ledger.filter((e) => e.cause === 'parseError')).toEqual([]);
  return { result, run: run! };
}
function refuses(text: string): string {
  const { result } = attempt(text);
  if (result.ok) throw new Error('converted, expected a refusal');
  return result.problems.map((p) => p.message).join(' | ');
}
const columnsOf = (run: ImportRun, table: string): string => (run.tables.find((t) => t.name === table)?.columns ?? []).map((c) => `${c.name}:${c.dataType}`).join(' ');
const descOf = (run: ImportRun, table: string, column: string): string | undefined => run.tables.find((t) => t.name === table)?.columns?.find((c) => c.name === column)?.description;

const BASE = [
  'table_schema,table_name,column_name,ordinal_position,data_type,is_nullable,is_primary_key,fk_table_name,fk_column_name,column_comment',
  'shop,customer,id,1,integer,NO,YES,,,Customer id',
  'shop,customer,email,2,varchar(255),NO,NO,,,"Email, lower-cased"',
  'shop,orders,id,1,integer,NO,YES,,,',
  'shop,orders,customer_id,2,integer,NO,NO,customer,id,Who ordered',
  'shop,orders,total,3,"numeric(10,2)",YES,NO,,,',
].join('\n');
const BASE_ORDERS = 'id:integer customer_id:integer total:numeric(10,2)';

describe('hostile catalog exports: converted, with Import DBML reading the result', () => {
  it('the baseline: 2 tables, 5 columns, 1 relationship, a quoted comma kept', () => {
    const { result, run } = converts(BASE);
    expect([result.tableCount, result.columnCount, result.refCount]).toEqual([2, 5, 1]);
    expect(columnsOf(run, 'orders')).toBe(BASE_ORDERS);
    expect(descOf(run, 'customer', 'email')).toBe('Email, lower-cased');
  });

  it('a BOM, CRLF and trailing blank lines; old Mac CR line ends', () => {
    expect(descOf(converts(`﻿${BASE.replace(/\n/g, '\r\n')}\r\n\r\n\r\n`).run, 'customer', 'email')).toBe('Email, lower-cased');
    expect(converts(BASE.replace(/\n/g, '\r')).result.refCount).toBe(1);
  });

  it('quoted cells holding a comma, a line break and a doubled quote', () => {
    const { run } = converts(`${BASE}\nshop,orders,note,4,text,YES,NO,,,"Line one\nline ""two"", with a comma\r\nand a third"\n`);
    expect(descOf(run, 'orders', 'note')).toBe('Line one\nline "two", with a comma\r\nand a third');
  });

  it('tab-, semicolon- and Excel sep=-delimited', () => {
    const tsv = BASE.replace(/"numeric\(10,2\)"/, 'numeric(10;2)').replace(/"Email, lower-cased"/, 'Email; lower-cased').replace(/,/g, '\t').replace(/;/g, ',');
    expect(columnsOf(converts(tsv).run, 'orders')).toBe(BASE_ORDERS);
    const semi = BASE.replace(/"numeric\(10,2\)"/, 'numeric(10,2)').replace(/"Email, lower-cased"/, 'Email lower-cased').replace(/,/g, ';').replace('numeric(10;2)', '"numeric(10,2)"');
    expect(columnsOf(converts(semi).run, 'orders')).toBe(BASE_ORDERS);
    expect(converts(`sep=;\n${BASE.replace(/"numeric\(10,2\)"/, 'numeric').replace(/"Email, lower-cased"/, 'Email').replace(/,/g, ';')}`).result.tableCount).toBe(2);
  });

  it('a SQL client\'s table: psql aligned output, mysql\'s framed table', () => {
    const psql = [' table_schema | table_name | column_name | data_type | is_nullable ', '--------------+------------+-------------+-----------+-------------',
      ' shop         | customer   | id          | integer   | NO          ', ' shop         | customer   | email       | text      | YES         ', '(2 rows)', ''].join('\n');
    expect(columnsOf(converts(psql).run, 'customer')).toBe('id:integer email:text');
    const mysql = ['+--------------+------------+-------------+-----------+', '| TABLE_SCHEMA | TABLE_NAME | COLUMN_NAME | DATA_TYPE |', '+--------------+------------+-------------+-----------+',
      '| shop         | customer   | id          | int       |', '+--------------+------------+-------------+-----------+'].join('\n');
    expect(columnsOf(converts(mysql).run, 'customer')).toBe('id:int');
  });

  it('NULL written as null, NULL or \\N; every row twice; one column twice with another type', () => {
    const nulls = converts(BASE.replace(/,,,/g, ',null,NULL,').replace(/NULL,$/gm, 'NULL,\\N'));
    expect(nulls.result.refCount).toBe(1);
    expect(descOf(nulls.run, 'orders', 'id')).toBeFalsy();
    expect(converts(`${BASE}\n${BASE.split('\n').slice(1).join('\n')}`).result.columnCount).toBe(5);
    const twice = converts(`${BASE}\nshop,orders,total,3,text,YES,NO,,,`);
    expect(columnsOf(twice.run, 'orders')).toBe(BASE_ORDERS);
    expect(twice.result.ledger.some((e) => e.what === 'repeated row')).toBe(true);
  });

  it('NUL bytes between characters (a UTF-16 file read as UTF-8); an unterminated quote; ragged rows', () => {
    expect(converts(BASE.split('').join('\u0000')).result.refCount).toBe(1);
    const open = converts(`${BASE}\nshop,orders,note,4,text,YES,NO,,,"never closed\nshop,orders,more,5,text,YES,NO,,,\n`);
    expect(columnsOf(open.run, 'orders')).toBe(`${BASE_ORDERS} note:text`);
    expect(open.result.skipped.join(' ')).toMatch(/a quoted cell that never closes/);
    const ragged = converts(`${BASE}\nshop,orders,short,6,text\nshop,orders,long,7,text,YES,NO,,,c,extra,extra\n`);
    expect(columnsOf(ragged.run, 'orders')).toBe(`${BASE_ORDERS} short:text long:text`);
    expect(ragged.result.skipped).toContain('2 rows with more or fewer cells than the column names (read by position)');
  });

  it('duplicate header names (the first is read); headers with spaces and another case', () => {
    expect(columnsOf(converts('table_name,table_name,column_name,data_type,data_type\na,IGNORED,x,int,text\n').run, 'a')).toBe('x:int');
    expect(columnsOf(converts('Table Name,Column Name,Data Type,Is Nullable\nCustomer,Id,INT,No\n').run, 'Customer')).toBe('Id:INT');
  });

  it('table names that differ only by case (and the same name in two catalogs): each kept, renamed with the database\'s name as its alias, and said', () => {
    const cased = converts('table_name,column_name,data_type\nOrders,id,int\norders,id,int\nORDERS,id,int\nlines,order_id,int\n');
    expect(cased.result.tableCount).toBe(4);
    expect(cased.result.ledger.filter((e) => e.cause === 'renamed').map((e) => e.detail)).toEqual([
      'imported as orders_2: the file has another table orders in this schema in another case',
      'imported as ORDERS_3: the file has another table ORDERS in this schema in another case',
    ]);
    const catalogs = converts('table_catalog,table_schema,table_name,column_name,data_type\ndev,s,orders,id,int\nprod,s,orders,id,int\n');
    expect(catalogs.result.tableCount).toBe(2);
    expect(catalogs.result.dbml).toContain('Table "s"."orders_2" [alias: \'orders\']');
    // The same name in two schemas is two tables, not a clash.
    expect(converts('table_schema,table_name,column_name,data_type\nraw,orders,id,int\ncore,orders,id,int\n').result.ledger.filter((e) => e.cause === 'renamed')).toEqual([]);
  });

  it('column names that differ only by case: the first kept, the others said', () => {
    const { run, result } = converts('table_name,column_name,data_type\nt,Id,int\nt,ID,int\nt,id,int\n');
    expect(columnsOf(run, 't')).toBe('Id:int');
    expect(result.ledger.filter((e) => e.cause === 'duplicate' && e.unit === 'column').map((e) => e.where?.column)).toEqual(['ID', 'id']);
  });

  it('awkward table and column names come in, made safe by Import DBML as it makes any name', () => {
    const { run } = converts([
      'table_name,column_name,data_type',
      'Order Details,Unit Price,money', '2024_sales,1st,int', 'tbl$audit,col#1,int', 'select,from,int', 'café,naïve,text',
      '"quo""ted","col""umn",text', '"multi\nline","a\nb",text', 'back\\slash,c\\d,text', '${catalog}.t,{{ col }},text',
    ].join('\n'));
    expect(run.tables).toHaveLength(9);
  });

  it('awkward types are kept as written (quoted when DBML needs it); a row with no type is typed unknown and said', () => {
    const { run, result } = converts([
      'table_name,column_name,data_type',
      't,a,"enum(\'G\',\'PG-13\')"', 't,b,"struct<a:int,b:array<string>>"', 't,c,', 't,d,"decimal(10, 2)"', 't,e,timestamp with time zone',
      't,f,"varchar(""x"")"', 't,g,character varying', 't,h,"map<string,decimal(10,2)>"', 't,i,`weird`', 't,j,"a\nb"',
    ].join('\n'));
    expect(columnsOf(run, 't')).toBe('a:enum(\'G\',\'PG-13\') b:struct<a:int,b:array<string>> c:unknown d:decimal(10,2) e:timestamp with time zone f:varchar("x") g:character varying h:map<string,decimal(10,2)> i:`weird` j:a b');
    expect(result.ledger.some((e) => e.detail === 'typed unknown: the row gives no type')).toBe(true);
  });

  it('awkward comments and defaults: quotes, backslashes, braces, a 100,000-character comment', () => {
    const { run } = converts([
      'table_name,column_name,data_type,column_default,column_comment',
      't,a,int,"nextval(\'t_a_seq\'::regclass)","It\'s \'\'\'triple\'\'\' and \\ backslash"', 't,b,text,"\'x`y\'::text","back`tick"',
      't,c,text,"line1\nline2",' + `"${'long '.repeat(20000)}"`, 't,d,int,((0)),"${not} a {{ template }}"', 't,e,int,NULL,"]] [note: \'x\'] }"',
    ].join('\n'));
    expect(descOf(run, 't', 'a')).toBe("It's '''triple''' and \\ backslash");
    expect(descOf(run, 't', 'b')).toBe('back`tick');
    expect(descOf(run, 't', 'e')).toBe("]] [note: 'x'] }");
    expect(descOf(run, 't', 'c')?.length).toBe(100_000);
  });

  it('a foreign key to a table or column not in the file is said, never drawn to nothing', () => {
    const table = converts(`${BASE}\nshop,orders,shipper_id,4,integer,YES,NO,shipper,id,`);
    expect(table.result.refCount).toBe(1);
    expect(table.run.shown.some((s) => /shipper/.test(s))).toBe(true);
    const column = converts(`${BASE}\nshop,orders,x,4,integer,YES,NO,customer,nope,`);
    expect(column.result.skipped.join(' ')).toMatch(/a column it names is not in shop\.customer/);
    expect(converts(`${BASE}\nshop,orders,c2,4,integer,YES,NO,customer,,`).result.refCount).toBe(2);
  });

  it('a self-reference and a two-table cycle: both drawn; the same two columns joined both ways is one link and a word', () => {
    const { run, result } = converts(['table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name', 'emp,id,int,YES,,', 'emp,manager_id,int,NO,emp,id', 'a,id,int,YES,b,id', 'b,id,int,YES,a,id'].join('\n'));
    expect(result.refCount).toBe(2);
    expect(run.relationships.map((x) => `${x.fromModel}.${x.fromColumn}>${x.toModel}.${x.toColumn}:${x.cardinality}`)).toEqual(['emp.manager_id>emp.id:many-to-one', 'a.id>b.id:one-to-one']);
    expect(run.shown.some((s) => /already joined the other way round/.test(s))).toBe(true);
  });

  it('a composite foreign key with no constraint name; one column in two foreign keys (a row per constraint)', () => {
    const composite = converts(['table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name', 'line,order_id,int,YES,,', 'line,line_no,int,YES,,', 'ship,order_id,int,NO,line,order_id', 'ship,line_no,int,NO,line,line_no', 'ship,qty,int,NO,,'].join('\n'));
    expect(composite.run.relationships.map((x) => `${x.fromColumn}>${x.toColumn}:${x.compositeKey ? 'c' : '-'}`)).toEqual(['order_id>order_id:c', 'line_no>line_no:c']);
    const twoFks = converts(['table_name,column_name,data_type,constraint_name,constraint_type,referenced_table_name,referenced_column_name', 'a,id,int,a_pk,PRIMARY KEY,,', 'b,id,int,b_pk,PRIMARY KEY,,', 'c,x,int,fk1,FOREIGN KEY,a,id', 'c,x,int,fk2,FOREIGN KEY,b,id', 'c,x,int,c_uq,UNIQUE,,'].join('\n'));
    expect(twoFks.run.relationships.map((x) => `${x.fromModel}.${x.fromColumn}>${x.toModel}.${x.toColumn}:${x.cardinality}`)).toEqual(['c.x>a.id:one-to-one', 'c.x>b.id:one-to-one']);
  });

  it('views and system schemas with table_type are left out and counted; with no table_type the notes say views may be tables', () => {
    const typed = converts(['table_schema,table_name,table_type,column_name,data_type', 'public,orders,BASE TABLE,id,integer', 'public,v_orders,VIEW,id,integer', 'public,mv,MATERIALIZED VIEW,id,integer', 'pg_catalog,pg_class,BASE TABLE,oid,oid', 'information_schema,columns,VIEW,table_name,name'].join('\n'));
    expect(typed.run.tables.map((t) => t.name)).toEqual(['orders']);
    expect(typed.result.skipped).toEqual(['2 views (table_type says so)', '2 rows of system schemas (information_schema, pg_catalog, sys…)']);
    const untyped = converts('table_schema,table_name,column_name,data_type\npublic,orders,id,integer\npublic,v_orders,id,integer\n');
    expect(untyped.run.tables.map((t) => t.name)).toEqual(['orders', 'v_orders']);
    expect(untyped.run.shown).toContain('The file has no table_type column, so views cannot be told from tables: any views in it came in as tables.');
  });

  it('one table with 2,000 columns', () => {
    expect(converts(['table_name,column_name,data_type', ...Array.from({ length: 2000 }, (_, i) => `wide,c${i},int`)].join('\n')).run.tables[0].columns).toHaveLength(2000);
  });

  it('a 5,000-character table name is left out and said (it was imported whole before); the rest comes in', () => {
    const { result } = converts(`table_name,column_name,data_type\n${'x'.repeat(5000)},id,int\nok,id,int\n`);
    expect(result.tableCount).toBe(1);
    expect(result.problems[0].message).toBe('A table has a name longer than 255 characters, so it is left out.');
  });

  it('255-character table and column names (Snowflake\'s and Databricks\' longest) come in whole, and Import DBML reads them', () => {
    const table = `t${'a'.repeat(254)}`;
    const column = `c${'b'.repeat(254)}`;
    const { result, run } = converts(`table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name\n${table},${column},int,YES,,\nok,id,int,YES,,\nok,ref,int,NO,${table},${column}\n`);
    expect(result.problems).toEqual([]);
    expect(run.tables.map((t) => t.name).sort()).toEqual(['ok', table]);
    expect(run.tables.find((t) => t.name === table)?.columns?.map((c) => c.name)).toEqual([column]);
    expect(result.refCount).toBe(1);
  });

  it('a seed that happens to have table_name, column_name and data_type (a data dictionary) reads as one', () => {
    expect(converts('table_name,column_name,data_type,owner_team\norders,id,integer,sales\norders,total,money,sales\n').result.columnCount).toBe(2);
  });
});

describe('hostile catalog exports: refused with a message', () => {
  it('a header and no rows (and blank lines); an empty file; whitespace only', () => {
    expect(refuses(BASE.split('\n')[0])).toBe('export.csv has column names but no rows.');
    expect(refuses(`${BASE.split('\n')[0]}\n\n\n`)).toBe('export.csv has column names but no rows.');
    expect(refuses('')).toBe('export.csv is empty.');
    expect(refuses(' \n\n  \n')).toBe('export.csv is empty.');
  });

  it('files that are not catalog exports: a dbt seed, a seed with name and type columns, data with no header, JSON, SQL, binary noise', () => {
    expect(refuses('id,first_name,last_name,email,created_at\n1,Ada,Lovelace,ada@example.com,2024-01-01\n'))
      .toBe('export.csv is not a catalog export ERD Studio can read: it has no table_name, no column_name, no data_type column. Its first line is read as the column names: id, first_name, last_name, email, created_at.');
    expect(refuses('id,name,type,description\n1,widget,physical,A widget\n')).toMatch(/it has no table_name column\./);
    expect(refuses('shop,customer,id,1,integer,NO\nshop,customer,email,2,text,YES\n')).toMatch(/not a catalog export/);
    expect(refuses('[{"table_name":"a","column_name":"b","data_type":"int"}]')).toMatch(/not a catalog export/);
    expect(refuses('CREATE TABLE a (id int, name text);\nCREATE TABLE b (id int);\n')).toMatch(/not a catalog export/);
    const noise = refuses(Array.from({ length: 4000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join(''));
    expect(noise).toMatch(/not a catalog export/);
    // Never more than a short piece of the file in the message.
    expect(noise.length).toBeLessThan(500);
  });

  it('only views', () => {
    expect(refuses('table_name,table_type,column_name,data_type\nv,VIEW,id,int\n')).toBe('No tables to import: every row is a view or a system table (1 row).');
  });

  it(`over ${MAX_CATALOG_ROWS.toLocaleString('en-US')} rows (it was read whole before, at 2.9 GB of heap for 200,000)`, () => {
    const rows = ['table_name,column_name,data_type'];
    for (let i = 0; i < 200_000; i++) rows.push(`t${Math.floor(i / 40)},c${i % 40},int`);
    expect(refuses(rows.join('\n'))).toMatch(/more than 100,000 columns/);
  });
});
