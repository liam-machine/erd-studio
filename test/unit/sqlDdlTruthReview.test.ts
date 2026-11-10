/**
 * Review fixes on the import-truth branch: what the SQL import once lost
 * without a word, or reported in the wrong place.
 *
 * - A comma missing after a column whose type a dialect's pre-step (Oracle,
 *   BigQuery, Redshift, SQLite) or the repair ladder reads behind a
 *   placeholder: the placeholder ran on over the next column, which the
 *   grammar then never saw.
 * - A quote lost inside BigQuery's `OPTIONS(description = …)`: the group ran
 *   into the next column's, and setting it aside took that column with it.
 * - A pre-stepped table that does not read: salvage and the problem's hint
 *   read the file as written, where Oracle's `NOT NULL ENABLE` (which the
 *   pre-step sets aside) stopped them first.
 * - A stray quote before a column list, in a table with a column named
 *   `location` or a generated column: filed as a CREATE TABLE without a
 *   column list, and not counted.
 * - Two foreign keys joining the same columns both ways: DBML rejects both,
 *   though the first alone reads.
 * - A table the DBML read-back leaves out still counted as read.
 * - Dialect detection: a Databricks script that backquotes only its table
 *   name, or nests `ARRAY<…>` with no other sign, is Databricks again.
 */
import { describe, expect, it } from 'vitest';
import { convertSqlDdl, detectSqlDialect, type SqlDdlToDbmlResult, type SqlDialect } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine, sqlDdlToDbml } from '../../src/services/sqlImportEngine';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function read(dialect: SqlDialect, text: string): SqlDdlToDbmlResult {
  return sqlDdlToDbml({ dialect, files: [{ name: 'a.sql', text }] });
}

/** `"t"."c" type` lines of the DBML: column → type. */
function columnTypes(dbml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of dbml.split('\n')) {
    const m = /^ {2}"([^"]+)" ("[^"]*"|\S+)/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

const commaRepairs = (r: SqlDdlToDbmlResult) => (r.ledger ?? []).filter((e) => e.outcome === 'repaired' && e.what === 'missing comma');

describe('a missing comma after a type read behind a placeholder', () => {
  const cases: Array<[SqlDialect, string, Record<string, string>]> = [
    ['oracle', 'CREATE TABLE t (\n a VARCHAR2(20 BYTE)\n b NUMBER(10),\n c DATE);', { a: 'VARCHAR2(20 BYTE)', b: 'NUMBER(10)', c: 'DATE' }],
    ['oracle', 'CREATE TABLE "T" (\n "A" DATETIME\n "B" INTEGER,\n "C" DATE);', { A: 'DATETIME', B: 'INTEGER', C: 'DATE' }],
    ['bigquery', 'CREATE TABLE t (\n a ARRAY<STRING>\n b INT64,\n c DATE);', { a: 'ARRAY<STRING>', b: 'INT64', c: 'DATE' }],
    ['redshift', 'CREATE TABLE t (\n a VARCHAR(MAX)\n b INT,\n c DATE);', { a: 'VARCHAR(MAX)', b: 'INT', c: 'DATE' }],
    ['sqlite', 'CREATE TABLE t (\n a DATE\n b INTEGER,\n c TEXT);', { a: 'DATE', b: 'INTEGER', c: 'TEXT' }],
    ['sqlite', 'CREATE TABLE t (\n a DATETIME -- trailing\n b INTEGER,\n c TEXT);', { a: 'DATETIME', b: 'INTEGER', c: 'TEXT' }],
    ['sqlite', 'CREATE TABLE [t] (\n [a] DATE\n [b] INTEGER,\n [c] TEXT);', { a: 'DATE', b: 'INTEGER', c: 'TEXT' }],
  ];
  it.each(cases)('%s: %j imports every column, the comma put in and recorded', (dialect, text, want) => {
    const r = read(dialect, text);
    expect(r.ok, JSON.stringify(r.problems)).toBe(true);
    expect(columnTypes((r as Converted).dbml)).toEqual(want);
    expect(commaRepairs(r)).toHaveLength(1);
    expect(commaRepairs(r)[0].where).toMatchObject({ file: 'a.sql', line: 3 });
  });

  it('a type that is only written on the next line is still the column\'s type', () => {
    const r = read('oracle', 'CREATE TABLE t (\n a\n   VARCHAR2(20 BYTE),\n b\n   NUMBER(10)\n);');
    expect(r.ok, JSON.stringify(r.problems)).toBe(true);
    expect(columnTypes((r as Converted).dbml)).toEqual({ a: 'VARCHAR2(20 BYTE)', b: 'NUMBER(10)' });
    expect(commaRepairs(r)).toEqual([]);
  });

  it('a word before the column list (another dialect\'s syntax) never hides the first column', () => {
    for (const [dialect, text] of [
      ['oracle', 'create table "s"."t" ( COLLATE "C"\n  "hawq" VARCHAR2(100 BYTE) not null,\n  "v8c" TIMESTAMP(6)\n);'],
      ['bigquery', 'CREATE TABLE `s`.`t` ( SPARSE\n  `mf` DATE NOT NULL,\n  `fs` DATE\n);'],
      ['redshift', 'create table s.t ( SPARSE\n  q varchar(max)\n);'],
      ['postgres', 'create table "y" ( AUTO_INCREMENT\n  "t29" text not null,\n  "n90" boolean not null\n);'],
    ] as Array<[SqlDialect, string]>) {
      const r = read(dialect, text);
      const kept = r.ok ? Object.keys(columnTypes(r.dbml)) : [];
      const reported = (r.ledger ?? []).some((e) => e.unit === 'table' && e.outcome === 'problem');
      // Either every column of the file is imported, or the table is reported: never one column fewer, unsaid.
      const columns = [...text.matchAll(/^\s+[`"]?(\w+)[`"]? /gm)].map((m) => m[1]);
      expect(reported || columns.every((c) => kept.includes(c)), `${dialect}: ${JSON.stringify(kept)} ${JSON.stringify(r.problems)}`).toBe(true);
    }
  });
});

describe('BigQuery: a quote lost inside OPTIONS(description = …)', () => {
  it('the table is reported, not imported without the next column', () => {
    const r = read('bigquery', [
      'create table staging.t (',
      ' ig DATE not null options(description=Line 1 of 2"),',
      ' m8 DATE options(description="Net of tax; see the \\"rates\\" table"),',
      ' w9 NUMERIC(10,2) not null,',
      ' primary key (ig) not enforced',
      ');',
    ].join('\n'));
    const kept = r.ok ? Object.keys(columnTypes(r.dbml)) : [];
    expect(kept).not.toEqual(['ig', 'w9']);
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ file: 'a.sql', kind: 'parse', table: 'staging.t' });
  });

  it('a whole OPTIONS group is still set aside, its description kept', () => {
    const r = read('bigquery', 'create table s.t (\n a DATE options(description="When"),\n b INT64\n);');
    expect(r.ok).toBe(true);
    expect((r as Converted).dbml).toMatch(/"a" DATE \[note: 'When'\]/);
  });
});

describe('a pre-stepped table that does not read', () => {
  it('names the line and cause the pre-stepped statement fails on (Oracle\'s NOT NULL ENABLE is not the cause)', () => {
    const r = read('oracle', 'CREATE TABLE "T" (\n "A" VARCHAR2(20 BYTE) NOT NULL ENABLE,\n "B" NUMBER(10) FROBNICATE\n);');
    expect(r.ok).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ line: 3, cause: 'parseError' });
    expect(r.problems[0].message).toContain('FROBNICATE');
  });

  it('is salvaged from what the pre-step made of it', () => {
    for (const bad of ['CHECK (B > 0 AND) ENABLE', 'DEFAULT (1 +)']) {
      const r = read('oracle', `CREATE TABLE "T" (\n "A" VARCHAR2(20 BYTE) NOT NULL ENABLE,\n "B" NUMBER(10) ${bad}\n);`);
      expect(r.ok, `${bad}: ${JSON.stringify(r.problems)}`).toBe(true);
      expect((r as Converted).readWith).toEqual({ grammar: 0, repaired: 0, salvaged: 1 });
      expect(columnTypes((r as Converted).dbml)).toEqual({ A: 'VARCHAR2(20 BYTE)', B: 'NUMBER(10)' });
    }
  });
});

describe('a stray quote before a column list', () => {
  it.each([
    ['name text'],
    ['location text'],
    ['total int GENERATED ALWAYS AS (id * 2) STORED'],
    ['copy_of text USING INDEX'],
  ])('with a column %s: a table found and reported, never a CTAS', (column) => {
    const r = read('postgres', `CREATE TABLE b" (\n id int,\n ${column}\n);\nCREATE TABLE ok (id int);`);
    expect(r.ok).toBe(true);
    expect(r.tablesFound).toBe(2);
    expect(r.problems).toEqual([expect.objectContaining({ kind: 'structure', table: 'b', line: 1 })]);
    expect((r.ledger ?? []).some((e) => e.outcome === 'skipped' && e.cause === 'notDesign')).toBe(false);
  });

  it('a CREATE TABLE … AS SELECT behind a stray quote is still not a table with columns', () => {
    const r = read('postgres', 'CREATE TABLE x" AS SELECT * FROM (\n SELECT 1 AS a\n) q;\nCREATE TABLE ok (id int);');
    expect(r.ok).toBe(true);
    expect(r.tablesFound).toBe(1);
  });
});

describe('the DBML read-back', () => {
  it('two foreign keys joining the same columns both ways: the first is kept, the second reported', () => {
    const r = read('postgres', [
      'CREATE TABLE a0 (id int PRIMARY KEY, x int UNIQUE);',
      'CREATE TABLE b0 (id int PRIMARY KEY, y int UNIQUE);',
      'ALTER TABLE a0 ADD FOREIGN KEY (x) REFERENCES b0(y);',
      'ALTER TABLE b0 ADD FOREIGN KEY (y) REFERENCES a0(x);',
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect((r as Converted).refCount).toBe(1);
    const lost = (r.ledger ?? []).filter((e) => e.outcome === 'lost' && e.unit === 'relationship');
    expect(lost).toHaveLength(1);
    expect(lost[0].where).toMatchObject({ file: 'a.sql', line: 4, table: 'b0' });
  });

  it('a table it leaves out is not counted as read', () => {
    let calls = 0;
    // A read-back that rejects the second table's first line once.
    const r = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int);\nCREATE TABLE b (id int);' }] }, dbmlCoreSqlEngine, (dbml) => {
      if (calls++ > 0) return [];
      const line = dbml.split('\n').findIndex((l) => /^Table "b"/.test(l)) + 1;
      return [{ line, message: 'rejected' }];
    });
    expect(r.ok).toBe(true);
    expect((r as Converted).tableCount).toBe(1);
    expect(r.tablesFound).toBe(2);
    expect(r.readWith).toEqual({ grammar: 1, repaired: 0, salvaged: 0 });
  });
});

describe('dialect detection', () => {
  it('a Databricks script that backquotes only its table name is Databricks', () => {
    expect(detectSqlDialect('CREATE TABLE `main`.`sales`.`orders` (id BIGINT, name STRING, qty INT);')).toBe('databricks');
  });

  it('ARRAY<…> alone is Databricks; beside a BigQuery sign it is BigQuery', () => {
    expect(detectSqlDialect('CREATE TABLE main.sales.orders (id BIGINT, tags ARRAY<STRING>)')).toBe('databricks');
    expect(detectSqlDialect('CREATE TABLE ds.orders (id INT64, tags ARRAY<STRING>)')).toBe('bigquery');
  });

  it('MySQL with backquoted names and a string that says String stays MySQL', () => {
    expect(detectSqlDialect("CREATE TABLE `Artist` (`ArtistId` INT NOT NULL, `Name` NVARCHAR(120));\nINSERT INTO `Artist` VALUES (1, N'Emerson String Quartet');")).toBe('mysql');
  });
});

describe('Oracle: CREATE UNIQUE INDEX on columns that are not the primary key', () => {
  it('is kept as a unique key', () => {
    const r = read('oracle', [
      'CREATE TABLE emp (id NUMBER(6) NOT NULL, email VARCHAR2(25) NOT NULL, dept NUMBER(4), code VARCHAR2(10));',
      'CREATE UNIQUE INDEX emp_email_ix ON emp (email);',
      'CREATE UNIQUE INDEX emp_dept_code_ix ON emp (dept, code);',
      'ALTER TABLE emp ADD ( CONSTRAINT emp_pk PRIMARY KEY (id) );',
    ].join('\n'));
    expect(r.ok, JSON.stringify(r.problems)).toBe(true);
    const dbml = (r as Converted).dbml;
    expect(dbml).toMatch(/"email" VARCHAR2\(25\) \[[^\]]*unique/);
    expect(dbml).toMatch(/\("dept", "code"\) \[[^\]]*unique/);
  });
});
