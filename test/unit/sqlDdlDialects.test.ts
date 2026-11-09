/**
 * Oracle, BigQuery, Amazon Redshift and SQLite: read with the PostgreSQL
 * grammar after each dialect's own pre-steps (`sqlDdlDialects.ts`), its
 * statement splitting (Oracle's `/` lines, SQL*Plus commands, PL/SQL units;
 * BigQuery's backtick paths and `#` comments) and its readers (Oracle's
 * `ADD ( CONSTRAINT … )` lists, SQLite's virtual tables). The real-world
 * samples (`test/fixtures/real-world-imports/{oracle-hr,
 * bigquery-cloud-learning-platform, redshift-tpch, sqlite-chinook}`) and the
 * star schemas in `test/fixtures/sql-ddl/` cover the common shapes; these are
 * the variants beyond them.
 *
 * Every case holds the import's rule: import or report, never a throw, never
 * a silent loss, nothing echoed beyond a name.
 */
import { describe, expect, it } from 'vitest';
import {
  convertSqlDdl,
  detectSqlDialect,
  rankSqlDialectReadings,
  rankSqlDialects,
  sqlDialectReading,
  SQL_DIALECTS,
  type SqlDdlToDbmlResult,
  type SqlDialect,
} from '../../src/services/sqlDdlImport';
import { needsPlaceholder } from '../../src/services/sqlDdlDialects';
import { splitStatements } from '../../src/services/sqlDdlLexer';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { readDbml } from '../../src/services/dbmlImportParse';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, text: string, name = 'a.sql'): Converted {
  const result = convertSqlDdl({ dialect, files: [{ name, text }] }, dbmlCoreSqlEngine);
  if (!result.ok) throw new Error(`${dialect}: ${JSON.stringify(result.problems)}`);
  // Whatever the converter writes, Import DBML reads.
  expect(readDbml(result.dbml).ok, result.dbml).toBe(true);
  return result;
}

/** `"t"."c" type [settings]` lines of the DBML, by table: `t.c` → the rest of its line. */
function columns(dbml: string): Map<string, string> {
  const out = new Map<string, string>();
  let table = '';
  for (const line of dbml.split('\n')) {
    const head = /^Table ((?:"[^"]+"\.)?"([^"]+)")/.exec(line);
    if (head) { table = head[2]; continue; }
    const col = /^ {2}"([^"]+)" (.*)$/.exec(line);
    if (col && table) out.set(`${table}.${col[1]}`, col[2]);
  }
  return out;
}

const skippedKinds = (r: Converted): string[] => r.ledger.filter((e) => e.outcome === 'skipped').map((e) => e.what);
const asWritten = (r: Converted): boolean => (r.readWith?.repaired ?? 0) === 0 && (r.readWith?.salvaged ?? 0) === 0;

describe('Oracle', () => {
  it('reads a SQL*Plus script: REM, PROMPT (with an apostrophe), SET, CONNECT, DEFINE and @file lines are the client\'s', () => {
    const r = convert('oracle', [
      'REM It\'s the HR schema',
      'SET ECHO OFF',
      'SET SERVEROUTPUT ON SIZE UNLIMITED',
      'CONNECT hr/hr@//localhost/orclpdb',
      'DEFINE tbs = users',
      'PROMPT Creating the employee\'s table ...',
      'CREATE TABLE employees (',
      '  employee_id NUMBER(6) CONSTRAINT emp_id_nn NOT NULL,',
      '  prompt VARCHAR2(20),',
      '  "ORDER" NUMBER',
      ');',
      '@@hr_comments.sql',
      'PRO done',
    ].join('\n'));
    expect(r.tableCount).toBe(1);
    expect([...columns(r.dbml).keys()]).toEqual(['employees.employee_id', 'employees.prompt', 'employees.ORDER']);
    expect(r.problems).toEqual([]);
    expect(asWritten(r)).toBe(true);
    // Seven client commands (the REM line is a comment), each counted, none read as a statement of the schema.
    expect(r.ledger.find((e) => e.what.startsWith('SQL*Plus command'))?.count).toBe(7);
    expect(skippedKinds(r)).not.toContain('other statement');
  });

  it('ends statements and PL/SQL units at a / line: a package\'s semicolons and an EXECUTE IMMEDIATE \'CREATE TABLE …\' are no tables', () => {
    const text = [
      'CREATE TABLE a (id NUMBER PRIMARY KEY)',
      '/',
      'CREATE OR REPLACE PACKAGE BODY pkg AS',
      '  PROCEDURE p IS',
      '  BEGIN',
      '    EXECUTE IMMEDIATE \'CREATE TABLE tmp_x (id NUMBER)\';',
      '    INSERT INTO a VALUES (1);',
      '  END p;',
      'END pkg;',
      '/',
      'DECLARE',
      '  n NUMBER;',
      'BEGIN',
      '  SELECT COUNT(*) INTO n FROM a;',
      'END;',
      '/',
      'CREATE TABLE b (id NUMBER PRIMARY KEY, a_id NUMBER REFERENCES a)',
      '/',
    ].join('\n');
    expect(splitStatements(text, 'oracle').map((s) => s.line)).toEqual([1, 3, 11, 17]);
    const r = convert('oracle', text);
    expect(r.tableCount).toBe(2);
    expect(r.tablesFound).toBe(2);
    expect(r.dbml).toContain('Ref: "b"."a_id" > "a"."id"');
  });

  it('reads ALTER TABLE … ADD ( CONSTRAINT …, CONSTRAINT … ): keys and foreign keys, one with no column list (the primary key)', () => {
    const r = convert('oracle', [
      'CREATE TABLE departments (department_id NUMBER(4), manager_id NUMBER(6));',
      'CREATE TABLE employees (employee_id NUMBER(6), department_id NUMBER(4), email VARCHAR2(25 BYTE));',
      'ALTER TABLE departments ADD ( CONSTRAINT dept_id_pk PRIMARY KEY (department_id) );',
      'ALTER TABLE employees',
      'ADD ( CONSTRAINT emp_emp_id_pk PRIMARY KEY (employee_id)',
      '    , CONSTRAINT emp_email_uk UNIQUE (email)',
      '    , CONSTRAINT emp_dept_fk FOREIGN KEY (department_id) REFERENCES departments',
      '    ) ;',
      'ALTER TABLE hr.departments ADD CONSTRAINT dept_mgr_fk FOREIGN KEY (manager_id) REFERENCES hr.employees (employee_id) ENABLE NOVALIDATE;',
    ].join('\n'));
    const cols = columns(r.dbml);
    expect(cols.get('departments.department_id')).toMatch(/\[pk\]/);
    expect(cols.get('employees.employee_id')).toMatch(/\[pk\]/);
    expect(cols.get('employees.email')).toMatch(/unique/);
    expect(r.refCount).toBe(2);
    expect(r.dbml).toContain('Ref: "employees"."department_id" > "departments"."department_id"');
    // `hr.departments` is the unqualified departments: an Oracle script runs in the user's schema.
    expect(r.dbml).toContain('Ref: "departments"."manager_id" > "employees"."employee_id"');
    expect(r.skipped.join('\n')).not.toMatch(/not in the files/);
  });

  it('keeps Oracle types as written, identity columns, virtual columns, and every physical clause set aside', () => {
    const r = convert('oracle', [
      'CREATE TABLE t (',
      '  id NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY (START WITH 1 INCREMENT BY 1),',
      '  code VARCHAR2(10 BYTE) DEFAULT ON NULL \'x\' NOT NULL ENABLE,',
      '  big NUMBER(*,0),',
      '  seen TIMESTAMP(6) WITH LOCAL TIME ZONE,',
      '  span INTERVAL DAY(2) TO SECOND(6),',
      '  doc CLOB,',
      '  total AS (big * 2),',
      '  CONSTRAINT t_pk PRIMARY KEY (id) USING INDEX (CREATE UNIQUE INDEX t_pk_ix ON t (id) TABLESPACE idx) ENABLE',
      ')',
      'TABLESPACE users PCTFREE 10 STORAGE (INITIAL 64K) NOCOMPRESS LOGGING',
      'PARTITION BY RANGE (id) (PARTITION p1 VALUES LESS THAN (100), PARTITION p2 VALUES LESS THAN (MAXVALUE));',
    ].join('\n'));
    expect(asWritten(r)).toBe(true);
    const cols = columns(r.dbml);
    expect(cols.get('t.id')).toMatch(/\[pk, increment/);
    expect(cols.get('t.code')).toMatch(/^"VARCHAR2\(10 BYTE\)" \[not null/);
    expect(cols.get('t.big')).toMatch(/^"NUMBER\(\*,0\)"/);
    expect(cols.get('t.seen')).toMatch(/^"TIMESTAMP\(6\) WITH LOCAL TIME ZONE"/);
    expect(cols.get('t.span')).toMatch(/^"INTERVAL DAY\(2\) TO SECOND\(6\)"/);
    expect(cols.get('t.total')).toMatch(/^computed/);
    expect(skippedKinds(r).some((w) => w.startsWith('table option'))).toBe(true);
  });

  it('follows ALTER SESSION SET CURRENT_SCHEMA, and a comment on a view is a skipped comment, never "not in the files"', () => {
    const r = convert('oracle', [
      'ALTER SESSION SET CURRENT_SCHEMA = sales;',
      'CREATE TABLE orders (id NUMBER PRIMARY KEY);',
      'CREATE VIEW v_orders AS SELECT * FROM orders;',
      'COMMENT ON TABLE v_orders IS \'Every order\';',
      'COMMENT ON TABLE orders IS \'One row per order\';',
    ].join('\n'));
    expect(r.dbml).toMatch(/Table "sales"\."orders"/);
    expect(r.dbml).toContain("Note: 'One row per order'");
    expect(r.skipped.join('\n')).not.toMatch(/not in the files/);
    expect(skippedKinds(r)).toContain('comment on something other than a table or column');
  });

  it('a table that does not read is a problem with its line, never quoting the file, and the rest is imported', () => {
    const long = `x${'y'.repeat(400)}`;
    const result = convertSqlDdl({ dialect: 'oracle', files: [{ name: 'a.sql', text: `CREATE TABLE ok_t (id NUMBER);\n\nCREATE TABLE bad_t (\n  a NUMBER,,\n  ${long} NUMBER\n);` }] }, dbmlCoreSqlEngine);
    if (!result.ok) throw new Error('expected ok');
    expect(result.tableCount).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ file: 'a.sql', table: 'bad_t' });
    expect(result.problems[0].line).toBeGreaterThanOrEqual(3);
    expect(result.problems[0].message.length).toBeLessThan(300);
    expect(result.problems[0].message).not.toContain(long);
    expect(result.ledger.filter((e) => e.outcome === 'problem').every((e) => e.where?.file === 'a.sql' && (e.where.line ?? 0) > 0)).toBe(true);
  });
});

describe('BigQuery', () => {
  it('reads backtick paths (one pair, or one per part) as dataset.table, # comments, and keeps descriptions from OPTIONS', () => {
    const r = convert('bigquery', [
      '# A dataset export',
      'CREATE OR REPLACE TABLE `my-project.sales.customers` (',
      '  id INT64 NOT NULL OPTIONS(description="Surrogate key"),',
      '  name STRING OPTIONS(description = \'It\\\'s the "name"\', labels = [("pii", "yes")]),',
      '  `timestamp` TIMESTAMP,',
      '  PRIMARY KEY (id) NOT ENFORCED',
      ') OPTIONS(description = "One row per customer");',
      'CREATE TABLE IF NOT EXISTS `my-project`.`sales`.`orders` (',
      '  id INT64, customer_id INT64, status STRING DEFAULT "new",',
      '  FOREIGN KEY (customer_id) REFERENCES `my-project.sales.customers`(id) NOT ENFORCED',
      ') PARTITION BY DATE(_PARTITIONTIME) CLUSTER BY customer_id;',
    ].join('\n'));
    expect(asWritten(r)).toBe(true);
    expect(r.dbml).toMatch(/Table "sales"\."customers"/);
    expect(r.dbml).toMatch(/Table "sales"\."orders"/);
    expect(r.dbml).toContain('Ref: "sales"."orders"."customer_id" > "sales"."customers"."id"');
    const cols = columns(r.dbml);
    expect(cols.get('customers.id')).toMatch(/note: 'Surrogate key'/);
    expect(cols.get('customers.name')).toContain('It\\\'s the "name"');
    expect(cols.get('customers.timestamp')).toMatch(/^TIMESTAMP/);
    expect(r.dbml).toContain("Note: 'One row per customer'");
    expect(r.notes).toEqual([]);
  });

  it('keeps STRUCT and ARRAY types whole (commas, NOT NULL and OPTIONS inside them)', () => {
    const r = convert('bigquery', [
      'CREATE TABLE ds.events (',
      '  actor STRUCT < uuid STRING NOT NULL OPTIONS(description = "UUID"), names ARRAY < STRING > > NOT NULL OPTIONS(description = "Actor"),',
      '  tags ARRAY<STRUCT<k STRING, v INT64>>,',
      '  amount BIGNUMERIC(40, 2),',
      '  geo GEOGRAPHY,',
      '  span RANGE<DATE>',
      ');',
    ].join('\n'));
    const cols = columns(r.dbml);
    expect([...cols.keys()]).toEqual(['events.actor', 'events.tags', 'events.amount', 'events.geo', 'events.span']);
    expect(cols.get('events.actor')).toMatch(/^"STRUCT<uuid STRING NOT NULL OPTIONS\(description = UUID\), names ARRAY<STRING>>" \[not null, note: 'Actor'\]/);
    expect(cols.get('events.tags')).toMatch(/^"ARRAY<STRUCT<k STRING, v INT64>>"/);
    expect(cols.get('events.span')).toMatch(/^"RANGE<DATE>"/);
  });

  it('is detected (INT64, OPTIONS, backtick paths), not Databricks, even with STRING and ARRAY<…>', () => {
    expect(detectSqlDialect('CREATE TABLE `p.d.t` (id INT64, tags ARRAY<STRING>, name STRING OPTIONS(description="x"));')).toBe('bigquery');
    expect(detectSqlDialect('CREATE TABLE IF NOT EXISTS t (a STRING, b FLOAT64) PARTITION BY DATE(ts);')).toBe('bigquery');
    expect(detectSqlDialect('CREATE TABLE `cat`.`sch`.`t` (id BIGINT, a STRING, m MAP<STRING, INT>) USING DELTA;')).toBe('databricks');
  });
});

describe('Amazon Redshift', () => {
  it('folds the case of unquoted key columns: Primary Key(L_ORDERKEY, L_LINENUMBER) names l_orderkey and l_linenumber', () => {
    const r = convert('redshift', [
      'create table lineitem (',
      '  l_orderkey int8 not null,',
      '  l_linenumber int4 not null,',
      '  l_note varchar(44),',
      '  Primary Key(L_ORDERKEY, L_LINENUMBER),',
      '  Unique (L_NOTE, l_linenumber)',
      ') distkey(l_orderkey) sortkey(l_orderkey);',
    ].join('\n'));
    expect(r.dbml).toContain('("l_orderkey", "l_linenumber") [pk]');
    expect(r.dbml).toContain('("l_note", "l_linenumber") [unique]');
  });

  it('sets column attributes aside (ENCODE, DISTKEY, SORTKEY, IDENTITY), counting them as column settings, and reads a column DISTKEY before its PRIMARY KEY', () => {
    const r = convert('redshift', [
      'CREATE TABLE shippers (',
      '  shipper_id INTEGER DISTKEY PRIMARY KEY,',
      '  company_name VARCHAR(MAX) ENCODE zstd NOT NULL,',
      '  seq BIGINT IDENTITY(0, 1) ENCODE az64,',
      '  payload SUPER,',
      '  added TIMESTAMPTZ DEFAULT GETDATE() SORTKEY',
      ') DISTSTYLE KEY COMPOUND SORTKEY (added) BACKUP NO;',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, shipper_id INTEGER REFERENCES shippers(shipper_id));',
      "COPY orders FROM 's3://bucket/orders/' IAM_ROLE default FORMAT AS PARQUET;",
      'ANALYZE orders;',
      'VACUUM orders;',
    ].join('\n'));
    expect(asWritten(r)).toBe(true);
    const cols = columns(r.dbml);
    expect(cols.get('shippers.shipper_id')).toMatch(/\[pk\]/);
    expect(cols.get('shippers.company_name')).toMatch(/^VARCHAR\(MAX\) \[not null\]/);
    expect(cols.get('shippers.seq')).toMatch(/increment/);
    expect(cols.get('shippers.payload')).toMatch(/^SUPER/);
    expect(r.refCount).toBe(1);
    expect(r.problems).toEqual([]);
    expect(r.skipped.join('\n')).toMatch(/column settings \(COLLATE, CHARACTER SET, ENCODE/);
  });

  it('names a foreign key to a table outside the files, by the table as imported (a later rename applied)', () => {
    const r = convert('redshift', [
      'CREATE TABLE atomic.ev_1 (root_id char(36) encode raw not null, FOREIGN KEY (root_id) REFERENCES atomic.events(event_id)) DISTSTYLE KEY DISTKEY (root_id);',
      'ALTER TABLE atomic.ev_1 RENAME TO ev_1_r1;',
    ].join('\n'));
    expect(r.skipped).toContain('a.sql line 1: foreign key atomic.ev_1_r1(root_id) → atomic.events: that table is not in the files');
  });
});

describe('SQLite', () => {
  it('reads AUTOINCREMENT, a column without a type, ON CONFLICT, COLLATE, key directions, WITHOUT ROWID and STRICT', () => {
    const r = convert('sqlite', [
      'CREATE TABLE [artist] ([ArtistId] INTEGER PRIMARY KEY AUTOINCREMENT, [Name] NVARCHAR(120) COLLATE NOCASE, [misc]);',
      'CREATE TABLE "album" (',
      '  "AlbumId" INTEGER NOT NULL,',
      '  `ArtistId` INTEGER NOT NULL REFERENCES artist ON DELETE CASCADE,',
      '  big UNSIGNED BIG INT,',
      '  PRIMARY KEY ("AlbumId" DESC) ON CONFLICT REPLACE',
      ') WITHOUT ROWID, STRICT;',
    ].join('\n'));
    expect(asWritten(r)).toBe(true);
    const cols = columns(r.dbml);
    expect(cols.get('artist.ArtistId')).toMatch(/\[pk, increment\]/);
    expect(cols.get('artist.Name')).toMatch(/^NVARCHAR\(120\)/);
    expect(cols.get('artist.misc')).toMatch(/^unknown/);
    expect(cols.get('album.AlbumId')).toMatch(/\[pk/);
    expect(cols.get('album.big')).toMatch(/^"UNSIGNED BIG INT"/);
    expect(r.dbml).toContain('Ref: "album"."ArtistId" > "artist"."ArtistId" [delete: cascade]');
    // The typeless column is said, with its line.
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', what: 'column without a type', where: expect.objectContaining({ file: 'a.sql', line: 1, column: 'misc' }) }));
  });

  it('skips a virtual table (not counted as a table found) and a trigger body with its semicolons', () => {
    const r = convert('sqlite', [
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);',
      'CREATE VIRTUAL TABLE notes_fts USING fts5(body, content=notes);',
      'CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN',
      '  INSERT INTO notes_fts(rowid, body) VALUES (new.id, new.body);',
      '  UPDATE notes SET body = trim(body) WHERE id = new.id;',
      'END;',
      'CREATE UNIQUE INDEX ux_body ON notes (body) WHERE body IS NOT NULL;',
    ].join('\n'));
    expect(r.tableCount).toBe(1);
    expect(r.tablesFound).toBe(1);
    expect(skippedKinds(r)).toContain('SQLite virtual table (USING fts4, fts5, rtree…: a search or index module, not design)');
    expect(skippedKinds(r)).toContain('function, procedure or trigger');
    expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'lost', what: 'partial unique index' }));
  });

  it('is detected from square brackets with INTEGER (Chinook), while [dbo].[x] with GO stays SQL Server', () => {
    expect(detectSqlDialect('CREATE TABLE [Album]\n(\n    [AlbumId] INTEGER  NOT NULL,\n    [Title] NVARCHAR(160)  NOT NULL\n);')).toBe('sqlite');
    expect(detectSqlDialect('CREATE TABLE [dbo].[Album] ([AlbumId] INT NOT NULL IDENTITY(1,1), [Title] NVARCHAR(160))\nGO')).toBe('sqlserver');
    expect(detectSqlDialect('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);')).toBe('sqlite');
  });
});

describe('the dialect pick and the quick path', () => {
  const rankOf = (text: string): SqlDialect[] => {
    const detected = detectSqlDialect(text);
    const readings = SQL_DIALECTS.map((d) => sqlDialectReading(d, convertSqlDdl({ dialect: d, files: [{ name: 'a.sql', text }] }, dbmlCoreSqlEngine)));
    return rankSqlDialectReadings(readings, detected).map((r) => r.dialect);
  };

  it('a PostgreSQL script stays PostgreSQL, even where the pre-stepped dialects read more of it as written (they quote every name)', () => {
    const text = 'CREATE TABLE public.orders (id serial PRIMARY KEY, "order" int, payload jsonb, created timestamptz);\nCOMMENT ON TABLE public.orders IS \'x\';';
    expect(detectSqlDialect(text)).toBe('postgres');
    expect(rankOf(text)[0]).toBe('postgres');
    // With nothing detected the dialects with a grammar of their own still come first.
    expect(rankOf('CREATE TABLE t (id int PRIMARY KEY, offset int);').slice(0, 5)).not.toContain('oracle');
  });

  it('each dialect\'s own script ranks it first', () => {
    expect(rankOf("CREATE TABLE t (id NUMBER(6), name VARCHAR2(20 BYTE)) TABLESPACE users;")[0]).toBe('oracle');
    expect(rankOf('CREATE TABLE `p.d.t` (id INT64 OPTIONS(description="k"), tags ARRAY<STRING>);')[0]).toBe('bigquery');
    expect(rankOf('CREATE TABLE t (id int ENCODE az64 DISTKEY, a varchar(10)) DISTSTYLE KEY;')[0]).toBe('redshift');
    expect(rankOf('CREATE TABLE [t] ([id] INTEGER PRIMARY KEY AUTOINCREMENT, [x]);')[0]).toBe('sqlite');
  });

  it('ranks the new dialects after the others when the text says nothing', () => {
    expect(rankSqlDialects('CREATE TABLE t (id int);').slice(-4)).toEqual(['redshift', 'bigquery', 'oracle', 'sqlite']);
  });
});

describe('the pre-steps change only what the dialect itself writes', () => {
  it('placeholders only the dialect\'s own types', () => {
    expect(needsPlaceholder('oracle', 'VARCHAR2(25 BYTE)')).toBe(true);
    expect(needsPlaceholder('oracle', 'VARCHAR2(25)')).toBe(false);
    expect(needsPlaceholder('oracle', 'ARRAY<STRING>')).toBe(false);
    expect(needsPlaceholder('bigquery', 'ARRAY<STRING>')).toBe(true);
    expect(needsPlaceholder('bigquery', 'NUMERIC(10, 2)')).toBe(false);
    expect(needsPlaceholder('redshift', 'VARCHAR(MAX)')).toBe(true);
    expect(needsPlaceholder('redshift', 'geometry(Point,4326)')).toBe(false);
    expect(needsPlaceholder('sqlite', 'UNSIGNED BIG INT')).toBe(true);
    expect(needsPlaceholder('sqlite', 'DOUBLE PRECISION')).toBe(false);
  });

  it('a Redshift attribute in a SQLite script, or a SQLite one in an Oracle script, is not set aside (the repair ladder says so)', () => {
    const sqlite = convertSqlDdl({ dialect: 'sqlite', files: [{ name: 'a.sql', text: 'CREATE TABLE t (id int ENCODE az64);' }] }, dbmlCoreSqlEngine);
    expect(sqlite.ok && sqlite.readWith?.grammar).toBe(0);
    const oracle = convertSqlDdl({ dialect: 'oracle', files: [{ name: 'a.sql', text: 'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);' }] }, dbmlCoreSqlEngine);
    expect(oracle.ok && oracle.readWith?.grammar).toBe(0);
  });
});
