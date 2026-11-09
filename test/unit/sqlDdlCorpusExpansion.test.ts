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
import type { SqlDdlToDbmlResult, SqlDialect } from '../../src/services/sqlDdlImport';
import { tokenize } from '../../src/services/sqlDdlLexer';
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

  it('names at most 20 per file, then counts the rest', () => {
    const text = ['CREATE TABLE keep (id INT);', ...Array.from({ length: 23 }, (_, k) => `CREATE TABLE c${k} AS SELECT * FROM keep;`)].join('\n');
    const r = read('snowflake', text);
    const line = r.skipped.find((l) => l.includes('not imported, made from a query'))!;
    expect(line).toContain('c0 (line 2)');
    expect(line).toContain('c19 (line 21)');
    expect(line).not.toContain('c20 ');
    expect(line.endsWith(' and 3 more')).toBe(true);
  });
});
