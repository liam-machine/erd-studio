/**
 * The catalog export reader (`catalogCsvImport.ts`): a catalog query's CSV,
 * one row per column, to the DBML Import DBML reads. The delimited reader,
 * the column contract, types, keys, what the file did not carry (said as
 * the file's, never the model's), the truncation check and the limits.
 * Every DBML it writes is read back with Import DBML's own reader.
 */
import { describe, expect, it } from 'vitest';

import {
  CATALOG_CSV_COLUMNS,
  MAX_CATALOG_NAME_CHARS,
  MAX_CATALOG_ROWS,
  catalogColumnType,
  catalogCsvToDbml,
  catalogDefault,
  catalogImportStem,
  catalogOriginPhrase,
  isCatalogCsvName,
  isCatalogHeader,
  mapCatalogHeaders,
  readDelimited,
  type CatalogCsvResult,
} from '../../src/services/catalogCsvImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { readsAsDbml } from '../../src/services/sqlImportEngine';

type Ok = Extract<CatalogCsvResult, { ok: true }>;
type Failed = Extract<CatalogCsvResult, { ok: false }>;

const convert = (text: string, name = 'catalog.csv'): CatalogCsvResult => catalogCsvToDbml([{ name, text }], readsAsDbml);
function ok(text: string, name?: string): Ok {
  const r = convert(text, name);
  if (!r.ok) throw new Error(`refused: ${r.reason}: ${r.problems.map((p) => p.message).join(' | ')}`);
  // Whatever it writes reads back as Import DBML reads it, with nothing left out by the check.
  expect(readDbml(r.dbml).ok).toBe(true);
  expect(r.ledger.filter((e) => e.cause === 'parseError')).toEqual([]);
  return r;
}
function refused(text: string, name?: string): Failed {
  const r = convert(text, name);
  if (r.ok) throw new Error('converted, expected a refusal');
  return r;
}
const csv = (...rows: string[]): string => `${rows.join('\n')}\n`;

const KEYED_HEAD = 'table_schema,table_name,table_type,column_name,ordinal_position,data_type,is_nullable,is_primary_key,pk_ordinal,fk_constraint_name,fk_ordinal,fk_table_schema,fk_table,fk_column,column_comment';

describe('the delimited reader', () => {
  it('reads RFC 4180: quoted delimiters, line breaks and doubled quotes; a BOM; CRLF, LF and old CR line ends', () => {
    const text = '\uFEFFa,b,c\r\n1,"x, y","line one\r\nline ""two"""\r\n2,,last\r\n';
    const r = readDelimited(text);
    expect(r.delimiter).toBe(',');
    expect(r.header).toEqual(['a', 'b', 'c']);
    expect(r.rows).toEqual([['1', 'x, y', 'line one\r\nline "two"'], ['2', '', 'last']]);
    expect(r.lines).toEqual([2, 4]);
    expect(readDelimited('a,b\r1,2\r3,4\r').rows).toEqual([['1', '2'], ['3', '4']]);
  });

  it('sniffs tab, semicolon and pipe from the header; Excel\'s sep= line names it', () => {
    expect(readDelimited('a\tb\n1\t2\n').delimiter).toBe('\t');
    expect(readDelimited('a;b\n1;"2;3"\n').rows).toEqual([['1', '2;3']]);
    expect(readDelimited('sep=|\na|b\n1|2\n')).toMatchObject({ delimiter: '|', header: ['a', 'b'], rows: [['1', '2']], lines: [3] });
  });

  it('reads a tab-separated file\'s backslash escapes (mysql --batch, COPY text) in unquoted cells', () => {
    const r = readDelimited('a\tb\nline one\\nline two\tC:\\\\temp\\tx\n\\N\tNULL\n');
    expect(r.rows).toEqual([['line one\nline two', 'C:\\temp\tx'], ['\\N', 'NULL']]);
    // A comma-separated file's backslashes are text (Databricks writes C:\temp as it is).
    expect(readDelimited('a\nC:\\temp\\n\n').rows).toEqual([['C:\\temp\\n']]);
  });

  it('skips a SQL client\'s decoration: psql aligned output and mysql\'s framed table', () => {
    const psql = readDelimited(' table_name | column_name | data_type \n------------+-------------+-----------\n orders     | id          | integer   \n(1 row)\n');
    expect(psql.header).toEqual(['table_name', 'column_name', 'data_type']);
    expect(psql.rows).toEqual([['orders', 'id', 'integer']]);
    const mysql = readDelimited('+------------+-------------+\n| TABLE_NAME | COLUMN_NAME |\n+------------+-------------+\n| orders     | id          |\n+------------+-------------+\n');
    expect(mysql.header).toEqual(['TABLE_NAME', 'COLUMN_NAME']);
    expect(mysql.rows).toEqual([['orders', 'id']]);
  });

  it('counts ragged rows and an unterminated quote, and never throws', () => {
    const r = readDelimited('a,b,c\n1,2\n1,2,3,4\n5,"open\n6,7,8\n');
    expect(r.ragged).toBe(2 + 1);
    expect(r.unterminatedQuote).toBe(true);
    expect(readDelimited('')).toMatchObject({ header: [], rows: [] });
  });
});

describe('the column contract', () => {
  it('reads headers in any case, with spaces or punctuation; the first spelling listed wins; a header is one column', () => {
    expect(mapCatalogHeaders(['TABLE_NAME', 'Column Name', 'data-type'])).toEqual({ table: 0, column: 1, dataType: 2 });
    // COLUMN_TYPE (a whole type) is the full type; DATA_TYPE then the bare one.
    expect(mapCatalogHeaders(['table_name', 'column_name', 'data_type', 'column_type'])).toMatchObject({ fullType: 3, dataType: 2 });
    // `name` is a column only when no better header is there.
    expect(mapCatalogHeaders(['table_name', 'column_name', 'name', 'type'])).toMatchObject({ column: 1, dataType: 3 });
    expect(mapCatalogHeaders(['table_name', 'name', 'type'])).toMatchObject({ column: 1 });
    // A header names one column: `comment` read as the column comment is not also the table's.
    expect(mapCatalogHeaders(['table_name', 'column_name', 'type', 'comment']).tableComment).toBeUndefined();
  });

  it('needs a table, a column and a type, and nothing else', () => {
    expect(isCatalogHeader(['table_name', 'column_name', 'data_type'])).toBe(true);
    expect(isCatalogHeader(['table_name', 'column_name'])).toBe(false);
    expect(isCatalogHeader(['id', 'name', 'type', 'description'])).toBe(false);
    const r = ok(csv('table_name,column_name,data_type', 'orders,id,int', 'orders,total,"decimal(10,2)"'));
    expect(r.tableCount).toBe(1);
    expect(r.columnCount).toBe(2);
  });

  it('every spelling in the contract is distinct, and none is two columns', () => {
    const all = Object.values(CATALOG_CSV_COLUMNS).flat().map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    expect(new Set(all).size).toBe(all.length);
  });

  it('names catalog exports by their extension only', () => {
    for (const n of ['catalog.csv', 'CATALOG.CSV', 'x.tsv', 'dir/a.Tsv']) expect(isCatalogCsvName(n)).toBe(true);
    for (const n of ['schema.sql', 'catalog.csv.sql', 'data.txt', 'a.dbml']) expect(isCatalogCsvName(n)).toBe(false);
  });

  it('says where the tables came from, and names the diagram after something better than a download\'s name', () => {
    expect(catalogOriginPhrase(['exports/catalog.csv'])).toBe('from a catalog export (exports/catalog.csv)');
    expect(catalogOriginPhrase(['a.csv', 'b.csv'])).toBe('from 2 catalog exports');
    expect(catalogImportStem('export.dbml')).toBe('import.dbml');
    expect(catalogImportStem('catalog (3).dbml')).toBe('import.dbml');
    expect(catalogImportStem('sales_catalog.dbml')).toBe('sales_catalog.dbml');
  });
});

describe('types', () => {
  const t = (p: Partial<Parameters<typeof catalogColumnType>[0]>) =>
    catalogColumnType({ full: '', dataType: '', udt: '', domain: '', domainSchema: '', charLength: '', dataLength: '', precision: '', scale: '', oracle: false, ...p });

  it('keeps a whole type as written, by its content whatever the header (decision 5)', () => {
    expect(t({ dataType: 'varchar(50)', charLength: '20' })).toEqual({ type: 'varchar(50)', how: 'asWritten' });
    expect(t({ dataType: 'decimal(18,4)', precision: '10', scale: '0' })).toEqual({ type: 'decimal(18,4)', how: 'asWritten' });
    expect(t({ dataType: 'struct<a:int,b:array<string>>' })).toEqual({ type: 'struct<a:int,b:array<string>>', how: 'asWritten' });
    expect(t({ full: 'character varying(255)', dataType: 'character varying' })).toEqual({ type: 'character varying(255)', how: 'full' });
  });

  it('rebuilds a size only for the types that take one', () => {
    expect(t({ dataType: 'character varying', charLength: '50' }).type).toBe('character varying(50)');
    expect(t({ dataType: 'nvarchar', charLength: '-1' }).type).toBe('nvarchar(max)');
    expect(t({ dataType: 'numeric', precision: '10', scale: '2' }).type).toBe('numeric(10,2)');
    expect(t({ dataType: 'NUMBER', precision: '6', scale: '0', oracle: true }).type).toBe('NUMBER(6)');
    expect(t({ dataType: 'NUMBER', scale: '0', oracle: true }).type).toBe('NUMBER(*,0)');
    expect(t({ dataType: 'TEXT', charLength: '50' }).type).toBe('TEXT(50)');
    expect(t({ dataType: 'TEXT', charLength: '16777216' }).type).toBe('TEXT');
    // Never an integer's binary precision, a timestamp's or a text column's octet length.
    expect(t({ dataType: 'integer', precision: '32', scale: '0' }).type).toBe('integer');
    expect(t({ dataType: 'timestamp', precision: '6' }).type).toBe('timestamp');
    expect(t({ dataType: 'double precision', precision: '53' }).type).toBe('double precision');
    expect(t({ dataType: 'date', dataLength: '7' }).type).toBe('date');
  });

  it('names a domain, an array and a user-defined type by their own names', () => {
    expect(t({ dataType: 'integer', domain: 'year', domainSchema: 'public' }).type).toBe('year');
    expect(t({ dataType: 'nvarchar', domain: 'Name', domainSchema: 'dbo' }).type).toBe('Name');
    expect(t({ dataType: 'integer', domain: 'money_t', domainSchema: 'fin' }).type).toBe('fin.money_t');
    expect(t({ dataType: 'ARRAY', udt: '_text' }).type).toBe('text[]');
    expect(t({ dataType: 'USER-DEFINED', udt: 'mpaa_rating' }).type).toBe('mpaa_rating');
    expect(t({})).toEqual({ type: 'unknown', how: 'unknown' });
  });

  it('a file of whole types says nothing about sizes; one of bare types says the file gave none', () => {
    expect(ok(csv('table_name,column_name,data_type', 't,a,varchar(3)', 't,b,string', 't,c,int')).notes.join(' ')).not.toMatch(/size/);
    const bare = ok(csv('table_name,column_name,data_type', 't,a,varchar', 't,b,decimal', 't,c,int'));
    expect(bare.notes).toContain('2 columns have a type that usually carries a size (varchar, decimal…), but the file gives no full type and no length, precision or scale column, so their sizes did not come in.');
    expect(bare.coverage.types).toBe('bare');
    // Sizes from the length columns: a changed note, counted.
    const rebuilt = ok(csv('table_name,column_name,data_type,character_maximum_length', 't,a,varchar,30', 't,b,int,'));
    expect(rebuilt.dbml).toContain('"a" varchar(30)');
    expect(rebuilt.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'type', count: 1, detail: 'sized from the length, precision and scale columns' }));
  });
});

describe('defaults', () => {
  it('a number, a quoted literal, an expression; MySQL\'s bare literal is a string unless EXTRA says it is generated', () => {
    expect(catalogDefault('0')).toEqual({ type: 'number', value: '0' });
    expect(catalogDefault("'AU'")).toEqual({ type: 'string', value: 'AU' });
    expect(catalogDefault("'it''s'")).toEqual({ type: 'string', value: "it's" });
    expect(catalogDefault("'AU'::bpchar")).toEqual({ type: 'expression', value: "'AU'::bpchar" });
    expect(catalogDefault('now()')).toEqual({ type: 'expression', value: 'now()' });
    expect(catalogDefault('AU', '')).toEqual({ type: 'string', value: 'AU' });
    expect(catalogDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED')).toEqual({ type: 'expression', value: 'CURRENT_TIMESTAMP' });
    expect(catalogDefault('CURRENT_TIMESTAMP', '')).toEqual({ type: 'expression', value: 'CURRENT_TIMESTAMP' });
    expect(catalogDefault('NULL')).toBeUndefined();
    expect(catalogDefault('')).toBeUndefined();
  });
});

describe('keys and relationships', () => {
  it('a composite primary key in pk_ordinal order; a composite foreign key paired by fk_ordinal; a column in two foreign keys is two rows', () => {
    const r = ok(csv(
      KEYED_HEAD,
      's,line,BASE TABLE,line_no,0,int,NO,YES,2,,,,,,',
      's,line,BASE TABLE,order_id,1,int,NO,YES,1,,,,,,',
      's,orders,BASE TABLE,order_id,0,int,NO,YES,1,,,,,,',
      's,note,BASE TABLE,ln,0,int,NO,NO,,note_line_fk,2,s,line,line_no,',
      's,note,BASE TABLE,ord,1,int,NO,NO,,note_line_fk,1,s,line,order_id,',
      's,note,BASE TABLE,ord,1,int,NO,NO,,note_order_fk,1,s,orders,order_id,',
    ));
    expect(r.dbml).toContain('("order_id", "line_no") [pk]');
    expect(r.dbml).toContain('Ref: "s"."note".("ord", "ln") > "s"."line".("order_id", "line_no")');
    expect(r.dbml).toContain('Ref: "s"."note"."ord" > "s"."orders"."order_id"');
    expect(r.refCount).toBe(2);
    expect(r.columnCount).toBe(2 + 1 + 2);
    // 0-based ordinals (Databricks) order the columns as 1-based ones do: line_no is line's column 0.
    const line = r.dbml.slice(r.dbml.indexOf('Table "s"."line"'));
    expect(line.indexOf('"line_no" int')).toBeLessThan(line.indexOf('"order_id" int'));
  });

  it('the constraint-join shape, with Oracle\'s P / U / R', () => {
    const r = ok(csv(
      'owner,table_name,column_name,data_type,constraint_name,constraint_type,referenced_table_name,referenced_column_name',
      'HR,DEPT,DEPT_ID,NUMBER,DEPT_PK,P,,',
      'HR,DEPT,DEPT_NAME,VARCHAR2,DEPT_NAME_UK,U,,',
      'HR,EMP,EMP_ID,NUMBER,EMP_PK,P,,',
      'HR,EMP,DEPT_ID,NUMBER,EMP_DEPT_FK,R,DEPT,DEPT_ID',
    ));
    expect(r.dbml).toMatch(/"DEPT_ID" NUMBER \[pk\]/);
    expect(r.dbml).toMatch(/"DEPT_NAME" VARCHAR2 \[unique\]/);
    expect(r.dbml).toContain('Ref: "HR"."EMP"."DEPT_ID" > "HR"."DEPT"."DEPT_ID"');
  });

  it('MySQL\'s COLUMN_KEY and EXTRA; SQLite\'s pk position and notnull', () => {
    const my = ok(csv('TABLE_NAME\tCOLUMN_NAME\tDATA_TYPE\tCOLUMN_KEY\tEXTRA\tIS_NULLABLE', 'a\tid\tint\tPRI\tauto_increment\tNO', 'a\tcode\tvarchar(9)\tUNI\t\tYES').replace(/\n/g, '\n'), 'a.tsv');
    expect(my.dbml).toContain('"id" int [pk, increment]');
    expect(my.dbml).toContain('"code" varchar(9) [unique]');
    const lite = ok(csv('table_name,cid,name,type,notnull,pk', 't,0,b,INTEGER,1,2', 't,1,a,INTEGER,1,1', 't,2,c,TEXT,0,0'));
    expect(lite.dbml).toContain('("a", "b") [pk]');
  });

  it('with no constraint name, columns that together reference a whole composite key are one foreign key (said)', () => {
    const r = ok(csv(
      'table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name',
      'line,order_id,int,YES,,', 'line,line_no,int,YES,,',
      'ship,order_id,int,NO,line,order_id', 'ship,line_no,int,NO,line,line_no',
    ));
    expect(r.dbml).toContain('Ref: "ship".("order_id", "line_no") > "line".("order_id", "line_no")');
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'relationship', cause: 'inferred' }));
  });

  it('a foreign key with a table and no column references its primary key; one to a table not in the file is said, not dropped silently', () => {
    const r = ok(csv(
      'table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name',
      'customer,id,int,YES,,', 'orders,id,int,YES,,', 'orders,customer_id,int,NO,customer,', 'orders,shipper_id,int,NO,shipper,id',
    ));
    expect(r.dbml).toContain('Ref: "orders"."customer_id" > "customer"."id"');
    expect(r.refCount).toBe(1);
    expect(r.skipped.join('\n')).toMatch(/foreign key orders\(shipper_id\) → shipper: shipper is not in the file/);
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', unit: 'relationship', cause: 'notInFiles' }));
  });

  it('two links between the same columns, either way round, keep the first and say the other (DBML reads only one)', () => {
    const r = ok(csv('table_name,column_name,data_type,is_primary_key,fk_table_name,fk_column_name', 'a,id,int,YES,b,id', 'b,id,int,YES,a,id'));
    expect(r.refCount).toBe(1);
    expect(r.ledger.some((e) => e.outcome === 'lost' && /already joined the other way round/.test(e.detail ?? ''))).toBe(true);
  });
});

describe('what the file did not carry is said as the file\'s', () => {
  it('no key columns: the banner says the file had none (never that the tables have none), with where to find a query that has them', () => {
    const r = ok(csv('table_schema,table_name,column_name,data_type,is_nullable', 's,a,id,int,NO', 's,b,a_id,int,YES'));
    expect(r.notice).toBe('This file has no key columns, so its tables came in without primary keys, unique keys or relationships. The catalog queries in ERD Studio: Bring In Your Data Model… include them.');
    expect([r.notice, ...r.notes].join(' ')).not.toMatch(/(tables|model) (have|has) no (primary )?keys/i);
    expect(r.coverage).toMatchObject({ primaryKeyColumn: false, foreignKeyColumns: false });
  });

  it('a key column that marks no key is the file\'s answer: no table in it has one', () => {
    const r = ok(csv('table_name,column_name,data_type,is_primary_key,fk_table,fk_column', 'a,id,int,NO,,'));
    expect(r.notice).toBeUndefined();
    expect(r.notes).toContain('No table in the file has a primary key: its key column marks none.');
  });

  it('keys but no foreign key columns, and the other way round', () => {
    expect(ok(csv('table_name,column_name,data_type,is_primary_key', 'a,id,int,YES')).notes)
      .toContain('The file has no foreign key columns, so no relationships came in. The catalog queries in ERD Studio: Bring In Your Data Model… include them.');
    expect(ok(csv('table_name,column_name,data_type,fk_table,fk_column', 'a,id,int,,', 'b,a_id,int,a,id')).notes)
      .toContain('The file has no primary key column, so its tables came in without primary keys. The catalog queries in ERD Studio: Bring In Your Data Model… include them.');
  });

  it('views: skipped and said when table_type says so; without table_type, the notes say views may have come in as tables', () => {
    const typed = ok(csv('table_schema,table_name,table_type,column_name,data_type', 'p,orders,BASE TABLE,id,int', 'p,v_orders,VIEW,id,int', 'p,mv,MATERIALIZED VIEW,id,int', 'p,live,MATERIALIZED_VIEW,id,int'));
    expect(typed.tableCount).toBe(1);
    expect(typed.skipped).toContain('3 views (table_type says so)');
    expect(typed.notes.join(' ')).not.toMatch(/table_type/);
    const untyped = ok(csv('table_name,column_name,data_type', 'orders,id,int', 'v_orders,id,int'));
    expect(untyped.tableCount).toBe(2);
    expect(untyped.notes).toContain('The file has no table_type column, so views cannot be told from tables: any views in it came in as tables.');
  });

  it('no is_nullable and no comment columns are said; system schemas are left out and counted', () => {
    const r = ok(csv('table_schema,table_name,column_name,data_type', 'information_schema,columns,table_name,name', 'pg_catalog,pg_class,oid,oid', 'sys,objects,id,int', 'app,a,id,int'));
    expect(r.tableCount).toBe(1);
    expect(r.notes).toContain('The file has no is_nullable column, so no column came in as NOT NULL.');
    expect(r.notes).toContain('The file has no comment columns, so no descriptions came in.');
    expect(r.skipped).toContain('3 rows of system schemas (information_schema, pg_catalog, sys…)');
  });
});

describe('refusals and limits', () => {
  it('a file that is not a catalog export says which column it lacks and what it read as the header', () => {
    const seed = refused('id,first_name,email\n1,Ada,ada@example.com\n', 'seeds/customers.csv');
    expect(seed.reason).toBe('notCatalog');
    expect(seed.problems[0].message).toBe('seeds/customers.csv is not a catalog export ERD Studio can read: it has no table_name, no column_name, no data_type column. Its first line is read as the column names: id, first_name, email.');
    expect(refused('').reason).toBe('empty');
    expect(refused('table_name,column_name,data_type\n').reason).toBe('noRows');
    expect(refused('table_name,table_type,column_name,data_type\nv,VIEW,id,int\n').problems[0].message).toBe('No tables to import: every row is a view or a system table (1 row).');
  });

  it('total_rows: a file with fewer rows than the query returned was cut short and is refused; equal reads', () => {
    const rows = Array.from({ length: 5 }, (_, i) => `t,c${i},int,5`);
    expect(ok(csv('table_name,column_name,data_type,total_rows', ...rows)).coverage.totalRows).toBe(true);
    const cut = refused(csv('table_name,column_name,data_type,total_rows', ...rows.slice(0, 3).map((r) => r.replace(/5$/, '1000'))), 'export.csv');
    expect(cut.reason).toBe('truncated');
    expect(cut.problems[0].message).toBe('export.csv holds 3 of the query\'s 1,000 rows (its total_rows column), so it was cut short: a results grid\'s download often holds only the rows it shows (Databricks\' "first 1,000 rows" is one). Download all the rows and import that file.');
    expect(refused(csv('table_name,column_name,data_type,total_rows', ...rows.map((r) => r.replace(/5$/, '2')))).problems[0].message).toMatch(/holds 5 rows, but the query returned 2/);
  });

  it(`more than ${MAX_CATALOG_ROWS.toLocaleString('en-US')} rows is refused, with how to export less`, () => {
    const big = ['table_name,column_name,data_type'];
    for (let i = 0; i <= MAX_CATALOG_ROWS; i++) big.push(`t${Math.floor(i / 50)},c${i % 50},int`);
    const r = refused(big.join('\n'));
    expect(r.reason).toBe('tooBig');
    expect(r.problems[0].message).toBe('The file lists more than 100,000 columns, more than one import brings in. Export one schema at a time (add a schema filter to the query\'s WHERE clause).');
  });

  it(`a name longer than ${MAX_CATALOG_NAME_CHARS} characters leaves its table or column out, said with its line`, () => {
    const r = ok(csv('table_name,column_name,data_type', `${'x'.repeat(5000)},id,int`, `t,${'y'.repeat(256)},int`, 't,ok,int'));
    expect(r.tableCount).toBe(1);
    expect(r.columnCount).toBe(1);
    expect(r.problems.map((p) => p.message)).toEqual([
      'A table has a name longer than 255 characters, so it is left out.',
      'A column of t has a name longer than 255 characters, so it is left out.',
    ]);
    expect(r.ledger.filter((e) => e.outcome === 'problem').map((e) => e.where?.line)).toEqual([2, 3]);
    // Never the name itself in full.
    expect(JSON.stringify(r.ledger)).not.toContain('x'.repeat(100));
  });

  it('a name of exactly 255 characters (the most Snowflake and Databricks allow) comes in whole; 256 is left out', () => {
    expect(MAX_CATALOG_NAME_CHARS).toBe(255);
    const table = `t${'a'.repeat(254)}`;
    const column = `c${'b'.repeat(254)}`;
    const r = ok(csv('table_name,column_name,data_type', `${table},${column},int`, `${table},id,int`, `u${'a'.repeat(255)},id,int`, `t,${column}x,int`, 't,id,int'));
    expect(r.tableCount).toBe(2);
    expect(r.columnCount).toBe(3);
    expect(r.dbml).toContain(`"${table}"`);
    expect(r.dbml).toContain(`"${column}"`);
    expect(r.problems.map((p) => p.message)).toEqual([
      'A table has a name longer than 255 characters, so it is left out.',
      'A column of t has a name longer than 255 characters, so it is left out.',
    ]);
  });
});

describe('names', () => {
  it('two tables whose names differ only by case keep both: the second is renamed, its alias the database\'s name, and said', () => {
    const r = ok(csv('table_name,column_name,data_type', 'Orders,id,int', 'orders,id,int', 'ORDERS,id,int'));
    expect(r.tableCount).toBe(3);
    expect(r.dbml).toContain('Table "orders_2" [alias: \'orders\']');
    expect(r.dbml).toContain('Table "ORDERS_3" [alias: \'ORDERS\']');
    expect(r.ledger.filter((e) => e.cause === 'renamed')).toHaveLength(2);
  });

  it('two columns whose names differ only by case keep the first, and say the other', () => {
    const r = ok(csv('table_name,column_name,data_type', 't,Id,int', 't,ID,int'));
    expect(r.columnCount).toBe(1);
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', unit: 'column', cause: 'duplicate' }));
  });

  it('a table or column called null keeps its name: a name is never SQL NULL (found by the generated tests)', () => {
    const r = ok(csv('table_schema,table_name,column_name,data_type,column_comment', 'NULL,null,null,int,null', 's,t,NULL,int,'));
    expect(r.dbml).toContain('Table "null" {\n  "null" int\n}');
    expect(r.dbml).toContain('"NULL" int');
  });

  it('repeated rows are one column; a repeat with another type keeps the first and says so', () => {
    const r = ok(csv('table_name,column_name,data_type', 't,a,int', 't,a,int', 't,a,text'));
    expect(r.columnCount).toBe(1);
    expect(r.dbml).toContain('"a" int');
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'column', cause: 'duplicate', count: 1 }));
  });

  it('several files are one model, and a foreign key may cross them', () => {
    const r = catalogCsvToDbml([
      { name: 'ref.csv', text: csv('table_schema,table_name,column_name,data_type,is_primary_key,fk_table_schema,fk_table,fk_column', 'ref,country,code,char(2),YES,,,') },
      { name: 'sales.csv', text: csv('table_schema,table_name,column_name,data_type,is_primary_key,fk_table_schema,fk_table,fk_column', 'sales,customer,country,char(2),NO,ref,country,code') },
    ], readsAsDbml);
    expect(r.ok && r.dbml).toContain('Ref: "sales"."customer"."country" > "ref"."country"."code"');
    const mixed = catalogCsvToDbml([{ name: 'a.csv', text: csv('table_name,column_name,data_type', 't,a,int') }, { name: 'seed.csv', text: 'id,name\n1,x\n' }]);
    expect(!mixed.ok && mixed.reason).toBe('notCatalog');
  });
});
