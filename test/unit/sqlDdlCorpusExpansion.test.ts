/**
 * Failure classes the grown import corpus showed (scripts/corpus), each
 * fixed in general and pinned here with the smallest SQL that showed it.
 *
 * - A name that starts with a digit (`cat.340b_silver.t`, a column
 *   `3RD_PARTY_VENDOR`; Spark, MySQL and Hive take them unquoted) was read
 *   as a number and a word: the table was filed as one without a column
 *   list and lost with no name.
 * - `CREATE TABLE t (a INT, …) AS SELECT` (Snowflake, Databricks) types
 *   every column: its column list is the table. It was skipped as a CTAS.
 * - A CREATE TABLE made from a query or another table with no column list
 *   of its own was only counted: the summary now names it.
 */
import { describe, expect, it } from 'vitest';
import { detectSqlDialect, type SqlDdlToDbmlResult, type SqlDialect } from '../../src/services/sqlDdlImport';
import { tokenize } from '../../src/services/sqlDdlLexer';
import { neutralisePlaceholders } from '../../src/services/sqlDdlPlaceholders';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function read(dialect: SqlDialect, text: string): Converted {
  const r = sqlDdlToDbml({ dialect, files: [{ name: 'a.sql', text }] });
  expect(r.ok, JSON.stringify(r.ok ? [] : r.problems)).toBe(true);
  return r as Converted;
}

/** `Table "s"."t"` / `Table "t"` headers of the DBML, as `s.t` / `t`. */
function tableNames(dbml: string): string[] {
  return [...dbml.matchAll(/^Table ((?:"[^"]+"\.)?"[^"]+")/gm)].map((m) => m[1].replace(/"/g, ''));
}

/** Column names of every table, in order. */
function columnNames(dbml: string): string[] {
  return [...dbml.matchAll(/^ {2}"([^"]+)" /gm)].map((m) => m[1]);
}

describe('a name that starts with a digit', () => {
  it('a schema part like 340b_silver is a name, and the table imports', () => {
    const r = read('databricks', 'CREATE TABLE IF NOT EXISTS cat.340b_slvr.t_x (\n id INT,\n name STRING\n);\nCREATE TABLE cat.s.y (a INT);');
    expect(tableNames(r.dbml)).toEqual(['340b_slvr.t_x', 's.y']);
    expect(r.skipped).toEqual([]);
  });

  it.each<[SqlDialect, string]>([
    ['databricks', 'CREATE TABLE t (\n CUST STRING,\n 340B_ID STRING,\n 3RD_PARTY_VENDOR STRING COMMENT \'x\'\n) USING DELTA;'],
    ['mysql', 'CREATE TABLE t (\n CUST VARCHAR(10),\n 340B_ID VARCHAR(10),\n 3RD_PARTY_VENDOR VARCHAR(10)\n);'],
  ])('%s: columns like 340B_ID and 3RD_PARTY_VENDOR are columns', (dialect, text) => {
    expect(columnNames(read(dialect, text).dbml)).toEqual(['CUST', '340B_ID', '3RD_PARTY_VENDOR']);
  });

  it('numbers stay numbers: 1e5, 10L, 1.5BD, 8K, .5 and DECIMAL(10,2)', () => {
    const kinds = (text: string): string[] => tokenize(text, 'databricks').map((t) => `${t.kind}:${t.value}`);
    expect(kinds('1e5 10L 1.5BD .5')).toEqual(['number:1e5', 'number:10', 'word:L', 'number:1.5', 'word:BD', 'number:.5']);
    expect(kinds('a.5')).toEqual(['word:a', 'number:.5']);
    expect(kinds('DECIMAL(10,2)')).toEqual(['word:DECIMAL', 'punct:(', 'number:10', 'punct:,', 'number:2', 'punct:)']);
    expect(kinds('cat.340b_x.t')).toEqual(['word:cat', 'punct:.', 'word:340b_x', 'punct:.', 'word:t']);
    expect(kinds('340b.t')).toEqual(['word:340b', 'punct:.', 'word:t']);
  });
});

describe('CREATE TABLE … AS SELECT', () => {
  it('a typed column list is the table: read, the query left out, recorded', () => {
    const r = read('snowflake', 'CREATE TABLE t (a INT, b STRING, CONSTRAINT pk PRIMARY KEY (a))\nAS SELECT 1, \'x\';');
    expect(r.dbml).toContain('"a" INT [pk]');
    expect(columnNames(r.dbml)).toEqual(['a', 'b']);
    // The query is not a table option.
    expect(r.skipped).toEqual([]);
    const changed = (r.ledger ?? []).filter((e) => e.outcome === 'changed' && e.what === 'CREATE TABLE … AS SELECT');
    expect(changed).toHaveLength(1);
    expect(changed[0].where).toMatchObject({ file: 'a.sql', line: 1, table: 't' });
  });

  it('a typed column list with keys and references keeps them', () => {
    const r = read('snowflake', [
      'CREATE TABLE hub (id INT PRIMARY KEY, name STRING);',
      'CREATE OR REPLACE TABLE sat (hub_id INT NOT NULL REFERENCES hub (id), v STRING, PRIMARY KEY (hub_id)) AS SELECT * FROM stg;',
    ].join('\n'));
    expect(tableNames(r.dbml)).toEqual(['hub', 'sat']);
    expect(r.dbml).toMatch(/Ref[^\n]*"sat"\."hub_id"[^\n]*"hub"\."id"|Ref[^\n]*"hub"\."id"[^\n]*"sat"\."hub_id"/);
  });

  it.each([
    ['names only', 'CREATE TABLE t (a, b) AS SELECT 1, 2;'],
    ['names with comments', 'CREATE TABLE t (a COMMENT \'x\', b) AS SELECT 1, 2;'],
    ['no column list', 'CREATE TABLE t AS SELECT 1 AS a;'],
  ])('%s: skipped, and named with its line', (_label, sql) => {
    const r = sqlDdlToDbml({ dialect: 'databricks', files: [{ name: 'a.sql', text: `CREATE TABLE keep (id INT);\n${sql}` }] }) as Converted;
    expect(tableNames(r.dbml)).toEqual(['keep']);
    expect(r.skipped).toContain('a.sql: not imported, made from a query or another table with no column list of its own: t (line 2)');
  });

  it('names at most 20 per file, then counts the rest, in lines of at most 300 characters', () => {
    const text = ['CREATE TABLE keep (id INT);', ...Array.from({ length: 23 }, (_, k) => `CREATE TABLE a_long_schema_name.c${k}_with_a_long_table_name AS SELECT * FROM keep;`)].join('\n');
    const r = read('snowflake', text);
    const lines = r.skipped.filter((l) => l.includes('not imported'));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(300);
    const all = lines.join('\n');
    expect(all).toContain('a_long_schema_name.c0_with_a_long_table_name (line 2)');
    expect(all).toContain('a_long_schema_name.c19_with_a_long_table_name (line 21)');
    expect(all).not.toContain('c20_');
    expect(lines[lines.length - 1].endsWith(' and 3 more')).toBe(true);
    expect(lines.slice(1).every((l) => l.startsWith('a.sql: also not imported (made from a query or another table): '))).toBe(true);
  });
});

describe('a table comment before the column list', () => {
  it('Snowflake: CREATE TABLE x COMMENT = \'…\' (columns) imports, the comment as its note', () => {
    const r = read('snowflake', [
      'create or replace table db.s.factory comment=\'{"origin":"x","v":{"a":1}}\' (',
      '\tID NUMBER(4,0) NOT NULL,',
      '\tNAME VARCHAR(12),',
      '\tGEN INT AS (ID + 1)',
      ');',
      'create table t2 comment = \'before\' (a int) comment = \'after\';',
    ].join('\n'));
    expect(tableNames(r.dbml)).toEqual(['s.factory', 't2']);
    expect(columnNames(r.dbml)).toEqual(['ID', 'NAME', 'GEN', 'a']);
    expect(r.dbml).toContain('Note: \'{"origin":"x","v":{"a":1}}\'');
    // The comment after the column list is the table's own.
    expect(r.dbml).toContain('Note: \'after\'');
    // What the column list says beyond the model is still recorded, with its line.
    const gen = (r.ledger ?? []).find((e) => e.what === 'generated column expression');
    expect(gen?.where).toMatchObject({ table: 's.factory', column: 'GEN', line: 4 });
  });
});

describe('template placeholders', () => {
  it('Jinja subscripts: {{ params[\'name\'] }}.t reads as name.t', () => {
    const r = read('bigquery', 'CREATE SCHEMA IF NOT EXISTS {{ params[\'name\'] }};\nCREATE TABLE IF NOT EXISTS\n  {{ params["name"] }}.all_clicks(\n    id STRING,\n    n INT64\n);');
    expect(tableNames(r.dbml)).toEqual(['name.all_clicks']);
  });

  it('Python format fields: {schema}.t and stg_{env} read as names; a lone {x} in an expression is left alone', () => {
    const r = read('redshift', 'CREATE TABLE IF NOT EXISTS {redshift_schema_edl}.student_profiles\n(\n    sid VARCHAR NOT NULL,\n    feed VARCHAR(max) NOT NULL\n)\nDISTKEY (sid);\nCREATE TABLE stg_{env} (a INT);');
    expect(tableNames(r.dbml)).toEqual(['redshift_schema_edl.student_profiles', 'stg_env']);
    expect(columnNames(r.dbml)).toEqual(['sid', 'feed', 'a']);
    expect(neutralisePlaceholders('SELECT { x } , {x} FROM t', 'snowflake').count).toBe(0);
  });
});

describe('dialect detection', () => {
  it.each<[string, SqlDialect]>([
    // Snowflake's own types and objects outweigh the `::` casts and `$$` bodies it shares with PostgreSQL.
    ['CREATE OR REPLACE WAREHOUSE wh;\nCREATE TABLE t (a VARIANT, ts TIMESTAMP_NTZ, d DATE DEFAULT \'2020-01-01\'::DATE);\nCREATE FUNCTION f() RETURNS INT AS $$ 1 $$;', 'snowflake'],
    ['CREATE TABLE t (ts TIMESTAMP_LTZ DEFAULT CURRENT_TIMESTAMP()::TIMESTAMP_LTZ, n NUMBER);\nCREATE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS $$ BEGIN RETURN \'x\'; END $$;', 'snowflake'],
    // BigQuery paths in one pair of backquotes, with template placeholders in them.
    ['CREATE OR REPLACE TABLE `${project_id}.${dataset}.trips` (id STRING);', 'bigquery'],
    ['CREATE OR REPLACE TABLE `{project_id}.{dataset_id}.{kind}_lookup` AS SELECT * FROM `{ga4_project}.{ga4_dataset}.events_*`;', 'bigquery'],
    // Lakeflow pipelines, and a column's own CONSTRAINT … FOREIGN KEY REFERENCES.
    ['CREATE OR REFRESH STREAMING TABLE rides (\n  ride_id STRING COMMENT "id",\n  CONSTRAINT ok EXPECT (ride_id IS NOT NULL) ON VIOLATION DROP ROW\n) AS SELECT * FROM STREAM(raw) WHERE x::int > 0;', 'databricks'],
    ['CREATE OR REPLACE TABLE fact (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  store_id BIGINT NOT NULL CONSTRAINT store_fk FOREIGN KEY REFERENCES dim_store\n);', 'databricks'],
  ])('%#: %s', (text, want) => {
    expect(detectSqlDialect(text)).toBe(want);
  });
});

describe('Lakeflow (Delta Live Tables) streaming tables', () => {
  it('a streaming table with a typed column list imports; its expectations are recorded as not kept; COMMENT "…" is a description', () => {
    const r = read('databricks', [
      'CREATE OR REFRESH STREAMING TABLE rides (',
      '  ride_id STRING COMMENT "Unique identifier for the ride.",',
      '  start_time TIMESTAMP,',
      '  CONSTRAINT valid_id EXPECT (ride_id IS NOT NULL) ON VIOLATION DROP ROW,',
      '  CONSTRAINT logged EXPECT (start_time > \'2020-01-01\')',
      ')',
      'COMMENT "Processed rides."',
      'AS SELECT ride_id, start_time FROM STREAM (rides_raw);',
    ].join('\n'));
    expect(columnNames(r.dbml)).toEqual(['ride_id', 'start_time']);
    expect(r.dbml).toContain("[note: 'Unique identifier for the ride.']");
    const expectations = (r.ledger ?? []).filter((e) => e.what === 'expectation');
    expect(expectations.map((e) => [e.outcome, e.where?.line, e.where?.column])).toEqual([['lost', 4, 'valid_id'], ['lost', 5, 'logged']]);
  });

  it('an expectation first in the list goes with the comma after it', () => {
    const r = read('databricks', 'CREATE OR REFRESH STREAMING TABLE t (\n  CONSTRAINT ok EXPECT (a > 0),\n  a INT\n) AS SELECT 1 AS a;');
    expect(columnNames(r.dbml)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// The adversarial pass on the fixes above: each a break found, then fixed in general.
// ---------------------------------------------------------------------------

describe('dialect detection: signals two warehouses share decide nothing alone', () => {
  it.each<[string, SqlDialect]>([
    // Snowflake writes a column's FOREIGN KEY REFERENCES too: with its own NUMBER types it is no Databricks.
    ['CREATE OR REPLACE TABLE c (id NUMBER(10,0) PRIMARY KEY);\nCREATE OR REPLACE TABLE o (id NUMBER(10,0), c_id NUMBER(10,0) CONSTRAINT f FOREIGN KEY REFERENCES c(id));', 'snowflake'],
    ['CREATE TABLE c (id INT PRIMARY KEY);\nCREATE TABLE o (id INT, c_id INT CONSTRAINT f FOREIGN KEY REFERENCES c(id), ts TIMESTAMP_LTZ);', 'snowflake'],
    // TIMESTAMP_NTZ is Spark's type too (Databricks Runtime 13+): beside USING DELTA, Databricks.
    ['CREATE TABLE IF NOT EXISTS s.t (id BIGINT, ts TIMESTAMP_NTZ, n STRING) USING DELTA;', 'databricks'],
    // Unity Catalog's catalogs are Databricks' (Snowflake's CREATE CATALOG INTEGRATION is not one).
    ['CREATE CATALOG IF NOT EXISTS c;\nUSE CATALOG c;\nCREATE OR REPLACE TABLE customer AS SELECT * FROM samples.tpch.customer;\nCREATE TABLE t (id INT);', 'databricks'],
    // A Databricks notebook exported as SQL says so in its comments.
    ['-- Databricks notebook source\nCREATE OR REPLACE TABLE dim (id BIGINT, name STRING);\n\n-- COMMAND ----------\n\n-- MAGIC %md ## Facts', 'databricks'],
    // STRING is BigQuery's type as much as Databricks': one backquoted reserved name (`offset`) makes no Databricks of INT64s.
    ['create table @cdm.person (\n person_id INT64 not null,\n `offset` STRING,\n v STRING\n);', 'bigquery'],
  ])('%#: %s', (text, want) => {
    expect(detectSqlDialect(text)).toBe(want);
  });

  it('CREATE CATALOG INTEGRATION is Snowflake\'s', () => {
    expect(detectSqlDialect('CREATE CATALOG INTEGRATION glue CATALOG_SOURCE = GLUE;\nCREATE TABLE t (v VARIANT);')).toBe('snowflake');
  });
});

describe('IDENTIFIER(…) names a table from a variable or a string (Snowflake, Databricks)', () => {
  it('IDENTIFIER($v), IDENTIFIER(:v), IDENTIFIER(\'db.s.t\') and a concatenation read as names, recorded as placeholders', () => {
    const r = read('snowflake', [
      "SET tbl = 'db.s.orders';",
      'CREATE TABLE IDENTIFIER($tbl) (id INT, name VARCHAR);',
      'CREATE TABLE IDENTIFIER(:tbl2) (id INT);',
      "CREATE TABLE IDENTIFIER('db.s.customers') (id INT, o INT REFERENCES IDENTIFIER($tbl)(id));",
      "CREATE TABLE IDENTIFIER($db || '.s.x') (id INT);",
      'CREATE TABLE ok (identifier VARCHAR(10), x INT);',
    ].join('\n'));
    expect(tableNames(r.dbml)).toEqual(['tbl', 'tbl2', 's.customers', 's.x', 'ok']);
    expect(r.dbml).toMatch(/Ref[^\n]*"s"\."customers"\."o"[^\n]*"tbl"\."id"/);
    expect((r.ledger ?? []).filter((e) => e.outcome === 'problem')).toEqual([]);
    const placeholders = (r.ledger ?? []).find((e) => e.what === 'template placeholders');
    expect(placeholders?.where?.line).toBe(2);
    // Counted by statement: the four CREATE TABLEs that hold one.
    expect(placeholders?.count).toBe(4);
  });

  it('Databricks: IDENTIFIER(:catalog || \'.s.t\') drops the catalog as any three-part name does', () => {
    const r = read('databricks', "CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.s.t') (id INT);\nCREATE TABLE IDENTIFIER('main.s.u') (id INT) USING DELTA;");
    expect(tableNames(r.dbml)).toEqual(['s.t', 's.u']);
  });

  it('only in the dialects that have it, and never inside a string or an expression that is not a name', () => {
    expect(neutralisePlaceholders("CREATE TABLE IDENTIFIER('a.b') (x INT);", 'postgres').count).toBe(0);
    expect(neutralisePlaceholders("SELECT 'IDENTIFIER($x)', IDENTIFIER(UPPER($x)) FROM t;", 'snowflake').count).toBe(0);
  });
});

describe('Spark and MySQL names that start with a digit and have no underscore', () => {
  it.each<[SqlDialect, string]>([
    // (`3d` is Spark's double literal 3.0, so a Spark name says `3rd`; MySQL has no such literal.)
    ['databricks', 'CREATE TABLE t (\n  id BIGINT,\n  2fa BOOLEAN,\n  3rd STRING\n) USING DELTA;'],
    ['mysql', 'CREATE TABLE t (\n  id INT,\n  2fa TINYINT(1) DEFAULT 0,\n  3rd VARCHAR(10)\n) ENGINE=InnoDB;'],
  ])('%s: 2fa and 3rd are columns', (dialect, text) => {
    expect(columnNames(read(dialect, text).dbml)).toEqual(['id', '2fa', '3rd']);
  });

  it('number literals with letters stay numbers there: 1e5, 1e-5, 0x1F, 0b101, and Spark\'s 10L, 3D, 1BD', () => {
    const numbers = (text: string, dialect: SqlDialect): string[] => tokenize(text, dialect).filter((t) => t.kind === 'number').map((t) => t.value);
    expect(numbers('1e5 1e-5 10L 3D 1BD 0x1F 0b101', 'databricks')).toEqual(['1e5', '1e', '5', '10', '3', '1', '0', '0']);
    expect(numbers('1e5 0x1F 0b101 3d', 'mysql')).toEqual(['1e5', '0', '0']);
    expect(tokenize('2fa 3d', 'postgres').map((t) => t.kind)).toEqual(['number', 'word', 'number', 'word']);
  });
});

describe('CREATE OR REPLACE of a table already read', () => {
  it('replaces it, as the database does, and says so with both lines; its own references go with it', () => {
    const r = read('snowflake', [
      'CREATE TABLE d (id INT PRIMARY KEY);',
      'CREATE OR REPLACE TABLE t (a INT, d_id INT REFERENCES d(id));',
      'CREATE TABLE u (t_a INT REFERENCES t(a));',
      'CREATE OR REPLACE TABLE t (a INT PRIMARY KEY, b INT);',
    ].join('\n'));
    expect(r.dbml).toContain('"b" INT');
    expect(r.dbml).not.toContain('"d_id"');
    expect(r.dbml).not.toMatch(/Ref[^\n]*"d_id"/);
    // A reference into it from another table stays: it names the table, not the definition.
    expect(r.dbml).toMatch(/Ref[^\n]*"u"\."t_a"[^\n]*"t"\."a"/);
    expect((r.ledger ?? []).filter((e) => e.outcome === 'problem')).toEqual([]);
    const replaced = (r.ledger ?? []).filter((e) => e.what === 'CREATE OR REPLACE');
    expect(replaced.map((e) => [e.outcome, e.where?.line, e.where?.table, e.detail])).toEqual([
      ['changed', 4, 't', 'replaces the definition at a.sql, line 2, as the database does'],
    ]);
  });

  it('a plain CREATE TABLE of a table already read is still refused (the first stays) and reported', () => {
    const r = read('postgres', 'CREATE TABLE t (a INT, b INT);\nCREATE TABLE t (a INT);');
    expect(r.dbml).toContain('"b" INT');
    expect((r.ledger ?? []).filter((e) => e.outcome === 'problem').map((e) => e.what)).toEqual(['table defined twice']);
  });
});

describe('the skipped lines stay at most 300 characters', () => {
  it('with a deep path and long names: the path is shown by its end, every name with its line', () => {
    const file = `${'deep/'.repeat(30)}setup.sql`;
    const long = `T_${'X'.repeat(240)}`;
    const text = Array.from({ length: 25 }, (_, k) => `CREATE TABLE ${long}_${k} AS SELECT 1;`).join('\n') + '\nCREATE TABLE ok (a INT);\n';
    const r = sqlDdlToDbml({ dialect: 'snowflake', files: [{ name: file, text }] }) as Converted;
    expect(r.ok).toBe(true);
    for (const line of r.skipped) expect(line.length, line).toBeLessThanOrEqual(300);
    const named = r.skipped.filter((l) => /not imported/.test(l));
    expect(named.join(' ')).toMatch(/\(line 1\)[\s\S]*\(line 20\) and 5 more$/);
    expect(named[0]).toMatch(/^….*setup\.sql: not imported/);
  });
});

describe('a session\'s temporary table is not part of the design', () => {
  it('CREATE TEMPORARY / TEMP / VOLATILE / LOCAL TEMPORARY TABLE is skipped and named with its line (a procedure\'s IDENTIFIER(:name) work table too)', () => {
    const r = read('snowflake', [
      'CREATE TABLE keep (a INT);',
      'CREATE OR REPLACE TEMPORARY TABLE IDENTIFIER(:TABLE_NAME) (EXECUTION_ID VARCHAR);',
      'CREATE TEMP TABLE scratch (a INT);',
      'CREATE LOCAL TEMPORARY TABLE scratch2 (a INT);',
      'CREATE VOLATILE TABLE scratch3 (a INT);',
    ].join('\n'));
    expect(tableNames(r.dbml)).toEqual(['keep']);
    const skipped = (r.ledger ?? []).filter((e) => e.outcome === 'skipped' && /temporary table/.test(e.what));
    expect(skipped.map((e) => [e.where?.line, e.where?.table])).toEqual([[2, 'TABLE_NAME'], [3, 'scratch'], [4, 'scratch2'], [5, 'scratch3']]);
  });

  it('Oracle\'s GLOBAL TEMPORARY TABLE is a lasting definition: imported', () => {
    const r = read('oracle', 'CREATE GLOBAL TEMPORARY TABLE gtt (a NUMBER(10)) ON COMMIT DELETE ROWS;');
    expect(tableNames(r.dbml)).toEqual(['gtt']);
  });
});

describe('a reference the grammar does not read is read from the file, never dropped', () => {
  it.each<[SqlDialect, string]>([
    // Snowflake: a column's FOREIGN KEY REFERENCES t with no column list names t's primary key.
    ['snowflake', 'CREATE TABLE T2 (C2 STRING, PRIMARY KEY (C2));\nCREATE TABLE T3 (C3 STRING FOREIGN KEY REFERENCES T2 MATCH PARTIAL ON UPDATE SET NULL ON DELETE RESTRICT);'],
    ['snowflake', 'CREATE TABLE T2 (C2 STRING, PRIMARY KEY (C2));\nCREATE TABLE T3 (C3 STRING REFERENCES T2);'],
  ])('%s: %s', (dialect, text) => {
    const r = read(dialect, text);
    expect(r.dbml).toMatch(/Ref[^\n]*"T3"\."C3"[^\n]*"T2"\."C2"/);
    const read2 = (r.ledger ?? []).filter((e) => e.unit === 'relationship' && e.outcome === 'repaired');
    expect(read2.map((e) => [e.where?.line, e.where?.table, e.where?.column])).toEqual([[2, 'T3', 'C3']]);
  });

  it('a table constraint\'s REFERENCES t MATCH FULL (read by the repair ladder) keeps its reference and action', () => {
    const r = read('snowflake', 'CREATE TABLE T2 (C2 STRING, PRIMARY KEY (C2));\nCREATE TABLE T3 (C3 STRING, CONSTRAINT f FOREIGN KEY (C3) REFERENCES T2 MATCH FULL ON DELETE RESTRICT);');
    expect(r.dbml).toMatch(/Ref[^\n]*"T3"\."C3"[^\n]*"T2"\."C2" \[delete: restrict\]/);
  });
});

describe('CREATE OR ALTER of a table already read', () => {
  it('takes the new column list and keeps the foreign keys it does not name, once each', () => {
    const r = read('snowflake', [
      'CREATE TABLE another_table (id INT PRIMARY KEY);',
      'CREATE OR REPLACE TABLE some_table (id INTEGER NOT NULL, CONSTRAINT MY_FK FOREIGN KEY (id) REFERENCES another_table (id));',
      'CREATE OR ALTER TABLE some_table (id INTEGER NOT NULL, note STRING);',
      'CREATE OR ALTER TABLE some_table (id INTEGER NOT NULL REFERENCES another_table (id), note STRING);',
    ].join('\n'));
    expect(columnNames(r.dbml)).toEqual(['id', 'id', 'note']);
    expect(r.dbml.match(/^Ref/gm)).toHaveLength(1);
    expect(r.dbml).toMatch(/Ref[^\n]*"some_table"\."id"[^\n]*"another_table"\."id"/);
    expect((r.ledger ?? []).filter((e) => e.what === 'CREATE OR REPLACE').map((e) => e.where?.line)).toEqual([3, 4]);
  });
});
