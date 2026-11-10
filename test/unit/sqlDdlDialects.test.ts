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

/**
 * The adversarial pass: real-world shapes that broke the first cut, each a
 * failing test before its fix. Detection must not read a column name, a row
 * of data or a type PostgreSQL shares as one of the four dialects; the
 * lexers must read each dialect's own strings; and what an export tool
 * writes (DBMS_METADATA, DB Browser for SQLite, Redshift's DDL view) reads
 * with the grammar, not the repair ladder.
 */
describe('the adversarial pass', () => {
  const quickOrder = (text: string): SqlDialect[] => {
    const detected = detectSqlDialect(text);
    return detected ? [detected, ...rankSqlDialects(text).filter((d) => d !== detected)] : rankSqlDialects(text);
  };

  describe('detection', () => {
    it('a PostgreSQL script with a `bytes` column and a row that says "Number" is tried as PostgreSQL first (the quick path keeps the first whole reading)', () => {
      const text = [
        'CREATE TABLE track (track_id INT NOT NULL, name VARCHAR(200) NOT NULL, milliseconds INT NOT NULL,',
        '    bytes INT, unit_price NUMERIC(10,2) NOT NULL, CONSTRAINT track_pkey PRIMARY KEY (track_id));',
        "INSERT INTO track VALUES (1, 'The Number of The Beast', 1, 2, 0.99);",
      ].join('\n');
      expect(detectSqlDialect(text)).toBeUndefined();
      expect(quickOrder(text)[0]).toBe('postgres');
      expect(quickOrder(text).slice(0, 5)).not.toContain('bigquery');
    });

    it('PostGIS geography and bool columns are PostgreSQL\'s, not BigQuery\'s', () => {
      const text = 'CREATE TABLE "places" ("id" integer PRIMARY KEY, "active" bool DEFAULT true, "geom" geography(Point,4326));';
      expect(detectSqlDialect(text)).not.toBe('bigquery');
      expect(quickOrder(text)[0]).toBe('postgres');
    });

    it('a column named number, bytes or sortkey is no signal; NUMBER and BYTES as types still are, beside a stronger one', () => {
      expect(detectSqlDialect('CREATE TABLE invoice (id integer PRIMARY KEY, number varchar(20), sortkey varchar(50), distkey int);')).toBeUndefined();
      expect(detectSqlDialect('CREATE TABLE t (id integer, x text);\nSELECT * FROM t ORDER BY sortkey;')).not.toBe('redshift');
      expect(detectSqlDialect('CREATE TABLE t (id NUMBER(6), name VARCHAR2(20));')).toBe('oracle');
      expect(detectSqlDialect('CREATE TABLE t (id int DISTKEY, a varchar(10) SORTKEY);')).toBe('redshift');
      expect(detectSqlDialect('CREATE TABLE t (id int) DISTSTYLE ALL SORTKEY (id);')).toBe('redshift');
    });

    it('a BigQuery script with `project.dataset.table` paths and STRUCTs but no INT64 is BigQuery, and keeps its datasets', () => {
      const text = [
        'CREATE TABLE `my-project.crm.customers` (customer_id STRING NOT NULL, addresses ARRAY<STRUCT<street STRING, city STRING>>, created_at TIMESTAMP);',
        'CREATE TABLE `my-project.crm.orders` (order_id STRING NOT NULL, customer_id STRING, amount NUMERIC);',
      ].join('\n');
      expect(detectSqlDialect(text)).toBe('bigquery');
      const r = convert('bigquery', text);
      expect(r.dbml).toMatch(/Table "crm"\."customers"/);
      expect(r.notes).toEqual([]);
    });
  });

  describe('Oracle', () => {
    it('reads q-quoted strings (q\'[…]\', Q\'!…!\', nq\'{…}\'): the comments are kept and nothing after them is swallowed', () => {
      const r = convert('oracle', [
        'CREATE TABLE a (id NUMBER);',
        "COMMENT ON TABLE a IS q'[It's; \"a\"]';",
        'CREATE TABLE b (id NUMBER, s VARCHAR2(10) DEFAULT q\'[it\'s]\');',
        "COMMENT ON TABLE b IS Q'!tab b!';",
        "COMMENT ON COLUMN b.id IS nq'{id's}';",
        'CREATE TABLE c (id NUMBER);',
      ].join('\n'));
      expect(r.tableCount).toBe(3);
      expect(r.tablesFound).toBe(3);
      expect(asWritten(r)).toBe(true);
      expect(r.dbml).toContain("Note: 'It\\'s; \"a\"'");
      expect(r.dbml).toContain("Note: 'tab b'");
      expect(columns(r.dbml).get('b.id')).toContain("note: 'id\\'s'");
      expect(columns(r.dbml).get('b.s')).toContain("default: 'it\\'s'");
      expect(skippedKinds(r)).not.toContain('other statement');
    });

    it('a PL/SQL unit without its / line ends at the next CREATE: the tables after it are read, even when a later unit has a /', () => {
      const r = convert('oracle', [
        'CREATE TABLE emp (id NUMBER PRIMARY KEY, name VARCHAR2(50));',
        'CREATE OR REPLACE TRIGGER emp_bi BEFORE INSERT ON emp FOR EACH ROW',
        'BEGIN',
        '  :new.name := UPPER(:new.name);',
        'END;',
        '',
        'CREATE TABLE dept (id NUMBER PRIMARY KEY, emp_id NUMBER REFERENCES emp(id));',
        'ALTER TABLE dept ADD CONSTRAINT dept_uk UNIQUE (emp_id);',
        'CREATE OR REPLACE PROCEDURE p IS',
        'BEGIN',
        "  EXECUTE IMMEDIATE 'CREATE TABLE junk (x NUMBER)';",
        'END;',
        '/',
        'CREATE TABLE loc (id NUMBER PRIMARY KEY);',
      ].join('\n'));
      expect(r.tableCount).toBe(3);
      expect(r.tablesFound).toBe(3);
      expect(r.refCount).toBe(1);
      expect(columns(r.dbml).get('dept.emp_id')).toMatch(/unique/);
      expect(r.ledger.filter((e) => e.what === 'function, procedure or trigger').map((e) => e.where?.table)).toEqual(['emp_bi', 'p']);
    });

    it('reads DBMS_METADATA\'s identity columns (sequence options without parentheses) with the grammar, as identities', () => {
      const r = convert('oracle', [
        '  CREATE TABLE "APP"."ORDERS" ',
        '   (\t"ID" NUMBER(*,0) GENERATED BY DEFAULT ON NULL AS IDENTITY MINVALUE 1 MAXVALUE 9999999999999999999999999999 INCREMENT BY 1 START WITH 1 CACHE 20 NOORDER  NOCYCLE  NOKEEP  NOSCALE  NOT NULL ENABLE, ',
        '\t"CODE" VARCHAR2(20 CHAR) COLLATE "USING_NLS_COMP" NOT NULL ENABLE, ',
        '\t"SEQ" NUMBER GENERATED ALWAYS AS IDENTITY MINVALUE -5 MAXVALUE 99 INCREMENT BY 1 START WITH -5 NOCACHE ORDER CYCLE, ',
        '\t PRIMARY KEY ("ID")',
        '  USING INDEX  ENABLE',
        '   )  DEFAULT COLLATION "USING_NLS_COMP" SEGMENT CREATION DEFERRED ',
        '  TABLESPACE "USERS" ;',
      ].join('\n'));
      expect(asWritten(r)).toBe(true);
      const cols = columns(r.dbml);
      expect(cols.get('ORDERS.ID')).toMatch(/^"NUMBER\(\*,0\)" \[pk, increment\]/);
      expect(cols.get('ORDERS.CODE')).toMatch(/^"VARCHAR2\(20 CHAR\)" \[not null\]/);
      expect(cols.get('ORDERS.SEQ')).toMatch(/^NUMBER \[increment\]/);
    });

    it('names a skipped PACKAGE BODY by the package, not "BODY"', () => {
      const r = convert('oracle', [
        'CREATE TABLE t (id NUMBER);',
        'CREATE OR REPLACE PACKAGE BODY emp_api AS',
        '  PROCEDURE hire IS BEGIN NULL; END hire;',
        'END emp_api;',
        '/',
      ].join('\n'));
      expect(r.ledger.find((e) => e.what === 'function, procedure or trigger')?.where?.table).toBe('emp_api');
    });
  });

  describe('BigQuery', () => {
    it('reads triple-quoted, raw and bytes strings: descriptions exact, and the tables after them read', () => {
      const r = convert('bigquery', [
        'CREATE TABLE ds.a (',
        '  id INT64 OPTIONS(description="""The "id"; unique"""),',
        "  name STRING OPTIONS(description=r'raw\\d+'),",
        "  note STRING DEFAULT '''multi",
        "line'''",
        ');',
        "CREATE TABLE ds.b (id INT64, a_id INT64 OPTIONS(description='''it's a; \"ref\"'''));",
        'CREATE TABLE ds.c (id INT64);',
      ].join('\n'));
      expect(r.tableCount).toBe(3);
      expect(r.problems).toEqual([]);
      const cols = columns(r.dbml);
      expect(cols.get('a.id')).toContain("note: 'The \"id\"; unique'");
      expect(cols.get('a.name')).toContain("note: 'raw\\\\d+'");
      expect(cols.get('b.a_id')).toContain("note: 'it\\'s a; \"ref\"'");
      // The value is `multi⏎line`, written as DBML's own multi-line string.
      expect(r.dbml).toContain("\"note\" STRING [default: '''multi\nline''']");
    });

    it('reads # comments inside a column list, CURRENT_TIMESTAMP() defaults and an unquoted dashed project, with the grammar', () => {
      const r = convert('bigquery', [
        'CREATE TABLE `my-proj.raw_ds.events` (',
        '  id INT64 NOT NULL, # the key',
        '  ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),',
        '  d DATE DEFAULT CURRENT_DATE()',
        ');',
        'CREATE TABLE my-proj.raw_ds.other (id INT64, e_id INT64 REFERENCES `my-proj.raw_ds.events`(id) NOT ENFORCED);',
      ].join('\n'));
      expect(asWritten(r)).toBe(true);
      expect(r.tableCount).toBe(2);
      expect(r.dbml).toContain('Ref: "raw_ds"."other"."e_id" > "raw_ds"."events"."id"');
      expect(columns(r.dbml).get('events.ts')).toMatch(/default: `CURRENT_TIMESTAMP`/);
    });

    it('ALTER TABLE … ADD COLUMN x ARRAY<STRUCT<a, b>> adds one column, and SET OPTIONS (description = …) describes the table and its columns', () => {
      const r = convert('bigquery', [
        'CREATE TABLE `p.ds.t` (id INT64, misc STRING);',
        'ALTER TABLE `p.ds.t` ADD COLUMN IF NOT EXISTS tags ARRAY<STRUCT<k STRING, v INT64>> OPTIONS(description="kv, pairs");',
        'ALTER TABLE `p.ds.t` SET OPTIONS (description = "The t table", labels = [("env", "prod")]);',
        'ALTER TABLE `p.ds.t` ALTER COLUMN misc SET OPTIONS (description = "Misc col");',
      ].join('\n'));
      expect([...columns(r.dbml).keys()]).toEqual(['t.id', 't.misc', 't.tags']);
      expect(columns(r.dbml).get('t.tags')).toMatch(/^"ARRAY<STRUCT<k STRING, v INT64>>" \[note: 'kv, pairs'\]/);
      expect(columns(r.dbml).get('t.misc')).toContain("note: 'Misc col'");
      expect(r.dbml).toContain("Note: 'The t table'");
      // The labels beside the description are a setting, said as one.
      expect(skippedKinds(r)).toContain('ALTER TABLE setting (storage, triggers, tags, masks, row security…)');
    });

    it('a table function is a routine, not a CREATE TABLE named FUNCTION', () => {
      const r = convert('bigquery', [
        'CREATE TABLE FUNCTION ds.names_by_year(y INT64) AS (SELECT 1 AS x);',
        'CREATE TABLE ds.real (id INT64);',
      ].join('\n'));
      expect(r.tableCount).toBe(1);
      expect(r.ledger.find((e) => e.what === 'function, procedure or trigger')?.where?.table).toBe('ds.names_by_year');
      expect(skippedKinds(r)).not.toContain('CREATE TABLE without a column list (AS SELECT, LIKE, CLONE)');
    });
  });

  describe('Amazon Redshift', () => {
    it('reads the DDL view\'s identity (DEFAULT "identity"(…)) as an identity, and CREATE TABLE x (LIKE y) as a table without a column list, not a problem', () => {
      const r = convert('redshift', [
        'CREATE TABLE IF NOT EXISTS "public"."users"',
        '(',
        '\t"userid" BIGINT NOT NULL DEFAULT "identity"(105323, 0, \'1,1\'::text) ENCODE az64',
        '\t,"username" CHAR(8)   ENCODE lzo',
        '\t,PRIMARY KEY (userid)',
        ')',
        'DISTSTYLE KEY',
        ' DISTKEY ("userid")',
        ' SORTKEY (',
        '\t"userid"',
        '\t)',
        ';',
        'CREATE TABLE public.users_stage (LIKE public.users INCLUDING DEFAULTS);',
      ].join('\n'));
      expect(asWritten(r)).toBe(true);
      expect(columns(r.dbml).get('users.userid')).toMatch(/^BIGINT \[pk, increment\]$/);
      expect(r.problems).toEqual([]);
      expect(r.ledger).toContainEqual(expect.objectContaining({ outcome: 'skipped', what: 'CREATE TABLE without a column list (AS SELECT, LIKE, CLONE)', where: expect.objectContaining({ table: 'public.users_stage' }) }));
    });
  });

  describe('SQLite', () => {
    it('reads DB Browser for SQLite\'s PRIMARY KEY("id" AUTOINCREMENT) with the grammar, as an identity', () => {
      const r = convert('sqlite', [
        'CREATE TABLE "Book" (',
        '\t"id"\tINTEGER,',
        '\t"title"\tTEXT NOT NULL UNIQUE,',
        '\tPRIMARY KEY("id" AUTOINCREMENT)',
        ');',
      ].join('\n'));
      expect(asWritten(r)).toBe(true);
      expect(columns(r.dbml).get('Book.id')).toMatch(/\[pk, increment\]/);
    });

    it('skips SQLite\'s own tables (sqlite_sequence, sqlite_stat1), named in the ledger', () => {
      const r = convert('sqlite', [
        'CREATE TABLE sqlite_sequence(name,seq);',
        'CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);',
        'CREATE TABLE sqlite_stat1(tbl,idx,stat);',
      ].join('\n'));
      expect(r.tableCount).toBe(1);
      expect(r.tablesFound).toBe(1);
      expect(r.ledger.filter((e) => e.what.startsWith('SQLite internal table')).map((e) => e.where?.table)).toEqual(['sqlite_sequence', 'sqlite_stat1']);
    });
  });
});
