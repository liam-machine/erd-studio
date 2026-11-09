/**
 * Isolation: one failure never blocks the rest. A table that does not read
 * is reported and the others import; a broken statement spoils only itself
 * (unclosed strings, comments and parentheses, routine bodies, DELIMITER
 * blocks); encoding and format noise never moves a line number.
 */
import { describe, expect, it } from 'vitest';

import { ledgerLogLines } from '../../src/services/importLedger';
import { countCreateTablesWithColumns, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlDialect } from '../../src/services/sqlDdlImport';
import { splitStatements, uncommentVersioned } from '../../src/services/sqlDdlLexer';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, files: SqlDdlFile[] | string): Converted {
  const result = sqlDdlToDbml({ dialect, files: typeof files === 'string' ? [{ name: 'a.sql', text: files }] : files });
  if (!result.ok) throw new Error(`${dialect}: ${JSON.stringify(result.problems)}`);
  return result;
}

const tableNames = (dbml: string): string[] => [...dbml.matchAll(/^Table (?:"([^"]+)"\.)?"([^"]+)"/gm)].map((m) => m[2]);

describe('a table that does not read never stops the rest', () => {
  it('ok: true with the problem, a ledger entry for it and how many tables the files hold', () => {
    const result = convert('postgres', 'CREATE TABLE a (id int);\nCREATE TABLE b (id int,, x int);\nCREATE TABLE c (id int, a_id int REFERENCES a (id));');
    expect(tableNames(result.dbml)).toEqual(['a', 'c']);
    expect(result.refCount).toBe(1);
    expect(result.tablesFound).toBe(3);
    expect(result.problems).toEqual([expect.objectContaining({ file: 'a.sql', line: 2, table: 'b', kind: 'parse', cause: 'parseError' })]);
    expect(result.ledger.filter((e) => e.outcome === 'problem')).toEqual([expect.objectContaining({ unit: 'table', what: 'CREATE TABLE', where: { file: 'a.sql', line: 2, table: 'b' } })]);
  });

  it('a foreign key to the table that did not read is said, not drawn', () => {
    const result = convert('postgres', 'CREATE TABLE b (id int,, x int);\nCREATE TABLE c (id int, b_id int REFERENCES b (id));');
    expect(result.refCount).toBe(0);
    expect(result.skipped.join('\n')).toMatch(/\bb\b/);
  });

  it('ok: false only when no table reads (every problem returned), or there are no files', () => {
    const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int,, x int);\nCREATE TABLE b (\n  id\n);' }] });
    expect(result).toMatchObject({ ok: false, tablesFound: 2 });
    expect(result.problems.map((p) => p.line)).toEqual([1, 3]);
    expect(sqlDdlToDbml({ dialect: 'mysql', files: [] })).toMatchObject({ ok: false, problems: [{ kind: 'noFiles' }] });
  });

  it.each([
    ['in one file', [{ name: 'a.sql', text: 'CREATE TABLE t (id int);\nCREATE TABLE t (id int, extra int);' }]],
    ['in two files', [{ name: 'a.sql', text: 'CREATE TABLE t (id int);' }, { name: 'b.sql', text: 'CREATE TABLE T (id int, extra int);' }]],
    ['qualified once', [{ name: 'a.sql', text: 'CREATE TABLE public.t (id int);' }, { name: 'b.sql', text: 'CREATE TABLE t (id int, extra int);' }]],
  ])('a table defined twice %s keeps the first definition and reports the second', (_label, files) => {
    const result = convert('postgres', files as SqlDdlFile[]);
    expect(result.tableCount).toBe(1);
    expect(result.dbml).not.toContain('extra');
    expect(result.problems).toEqual([expect.objectContaining({ kind: 'duplicateTable', cause: 'duplicate', message: expect.stringMatching(/defined twice .*the first definition is kept/) })]);
  });
});

describe('statement boundaries', () => {
  const procedure = (open: string, close: string) => [
    'CREATE TABLE film (id int PRIMARY KEY);',
    `DELIMITER ${open}`,
    'CREATE PROCEDURE rewards()',
    'BEGIN',
    '  CREATE TEMPORARY TABLE tmpCustomer (customer_id SMALLINT UNSIGNED NOT NULL PRIMARY KEY);',
    '  INSERT INTO tmpCustomer SELECT 1;',
    '  DROP TABLE tmpCustomer;',
    `END ${close}`,
    'DELIMITER ;',
    'CREATE TABLE actor (id int PRIMARY KEY);',
  ].join('\n');

  it.each([[';;', ';;'], ['//', '//'], ['$$', '$$'], ['$$', 'x$$'.slice(1)]])('MySQL DELIMITER %s: a routine body is one statement, skipped as a routine; its CREATE TEMPORARY TABLE is never imported', (open, close) => {
    const result = convert('mysql', procedure(open, close));
    expect(tableNames(result.dbml)).toEqual(['film', 'actor']);
    expect(result.tablesFound).toBe(2);
    expect(result.skipped).toEqual(['a.sql: skipped 1 function, procedure or trigger']);
    // The start screen counts the same 2 tables (sakila's said 17 for 16).
    expect(countCreateTablesWithColumns(procedure(open, close), 'mysql')).toBe(2);
  });

  it('a routine body ending END$$ with no space, and trigger bodies in mysqldump versioned comments', () => {
    const text = 'DELIMITER $$\nCREATE TRIGGER t1 BEFORE INSERT ON film FOR EACH ROW BEGIN\n  SET NEW.x = 1;\nEND$$\nDELIMITER ;\n/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER t2 AFTER INSERT ON film FOR EACH ROW BEGIN SET @a = 1; END */;\nCREATE TABLE film (id int);';
    const result = convert('mysql', text);
    expect(tableNames(result.dbml)).toEqual(['film']);
  });

  it.each([
    ['sqlserver', 'CREATE TABLE a (id int)\nGO\nCREATE PROCEDURE dbo.p AS\n  CREATE TABLE tmp_x (id int);\n  INSERT INTO tmp_x VALUES (1);\n  DROP TABLE tmp_x;\nGO\nCREATE TABLE b (id int)\nGO'],
    ['sqlserver', 'CREATE TABLE a (id int);\nCREATE OR ALTER PROCEDURE p AS BEGIN\n  CREATE TABLE tmp_x (id int);\n  IF 1 = 1 BEGIN SELECT 1; END;\nEND;\nCREATE TABLE b (id int);'],
    ['mysql', 'CREATE TABLE a (id int);\nCREATE PROCEDURE p()\nBEGIN\n  DECLARE x INT;\n  IF x > 0 THEN\n    CREATE TEMPORARY TABLE tmp_x (id int);\n  END IF;\n  SET x = CASE WHEN x > 1 THEN 1 ELSE 0 END;\nEND;\nCREATE TABLE b (id int);'],
    ['snowflake', "CREATE TABLE a (id int);\nCREATE OR REPLACE PROCEDURE p() RETURNS STRING LANGUAGE SQL AS\nBEGIN\n  CREATE TABLE tmp_x (id int);\n  RETURN 'x';\nEND;\nCREATE TABLE b (id int);"],
    ['postgres', 'CREATE TABLE a (id int);\nCREATE FUNCTION f() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT 1;\nEND;\nCREATE TABLE b (id int);'],
  ] as const)('%s: a routine body with semicolons and a CREATE TABLE inside, without DELIMITER, is one statement', (dialect, text) => {
    const result = convert(dialect, text);
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(result.skipped.join('\n')).toMatch(/1 function, procedure or trigger/);
  });

  it('MySQL /*!NNNNN … */ versioned comments are read as code: the column and key inside them are kept', () => {
    const text = 'CREATE TABLE address (\n  id int NOT NULL,\n  /*!50705 location GEOMETRY */ /*!80003 SRID 0 */ /*!50705 NOT NULL,*/\n  last_update TIMESTAMP NOT NULL,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB;';
    const result = convert('mysql', text);
    expect(result.dbml).toMatch(/"location" GEOMETRY \[not null\]/);
    expect(uncommentVersioned('/*!40101 SET x = 1 */; /* plain */ \'/*!str*/\'')).toBe('         SET x = 1   ; /* plain */ \'/*!str*/\'');
  });

  it('GO n, a missing final semicolon, and statements run together without semicolons each split', () => {
    const result = convert('sqlserver', 'CREATE TABLE a (id int)\nGO 2\nCREATE TABLE b (id int)\nCREATE TABLE c (id int)');
    expect(tableNames(result.dbml)).toEqual(['a', 'b', 'c']);
  });

  it.each([
    ['an unclosed string', "CREATE TABLE a (id int);\nCREATE TABLE b (id int DEFAULT 'oops);\nCREATE TABLE c (id int);"],
    ['an unclosed quoted name', 'CREATE TABLE a (id int);\nCREATE TABLE "b (id int);\nCREATE TABLE c (id int);'],
    ['an unclosed block comment', 'CREATE TABLE a (id int);\nCREATE TABLE b (id int /* never closed);\nCREATE TABLE c (id int);'],
    ['unbalanced parentheses', 'CREATE TABLE a (id int);\nCREATE TABLE b (id int, x numeric(10, 2;\nCREATE TABLE c (id int);'],
  ])('%s spoils one statement only, not the rest of the file', (_label, text) => {
    const result = convert('postgres', text);
    expect(tableNames(result.dbml)).toEqual(expect.arrayContaining(['a', 'c']));
    expect(tableNames(result.dbml)).toHaveLength(result.tableCount);
  });

  it('a `;` inside parentheses that never close ends the statement when the next line starts one', () => {
    const statements = splitStatements('CREATE TABLE b (id int, x numeric(10, 2;\nALTER TABLE a ADD COLUMN y int;', 'postgres');
    expect(statements.map((s) => s.line)).toEqual([1, 2]);
  });
});

describe('encoding and format noise never moves a line number', () => {
  const broken = (eol: string) => ['CREATE TABLE a (id int);', '', 'CREATE TABLE b (', '  id int,,', '  x int', ');'].join(eol);

  it.each([['LF', '\n'], ['CRLF', '\r\n'], ['lone CR', '\r']])('%s: the problem names line 4', (_label, eol) => {
    const result = convert('postgres', broken(eol));
    expect(result.problems[0]).toMatchObject({ line: 4, table: 'b' });
  });

  it('a UTF-8 byte order mark, tabs, no-break spaces and mixed-case keywords', () => {
    const result = convert('postgres', '﻿cReAtE\ttAbLe a (\n\tid int PrImArY kEy,\n\tname TEXT nOt NuLl\n);');
    expect(tableNames(result.dbml)).toEqual(['a']);
    expect(result.dbml).toMatch(/"id" int \[pk\]/);
  });

  it('an empty file is said once; a very long line reads', () => {
    const wide = `CREATE TABLE w (${Array.from({ length: 400 }, (_, i) => `c${i} varchar(${i + 1})`).join(', ')});`;
    const result = convert('postgres', [{ name: 'empty.sql', text: '' }, { name: 'wide.sql', text: wide }]);
    expect(result.skipped).toEqual(['empty.sql: no tables, keys or comments in it']);
    expect(result.dbml.split('\n').filter((l) => /^\s+"c\d+"/.test(l))).toHaveLength(400);
  });

  it('5,000 tables read within a few seconds, and 5,000 that all need repair stay fast (the budget)', () => {
    const plain = Array.from({ length: 5000 }, (_, i) => `CREATE TABLE t${i} (id int PRIMARY KEY, p int REFERENCES t${Math.max(0, i - 1)} (id));`).join('\n');
    let t0 = Date.now();
    expect(convert('postgres', plain).tableCount).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(20000);
    const repaired = Array.from({ length: 5000 }, (_, i) => `CREATE TABLE t${i} (id int, v VECTOR(FLOAT, 768)) COMMENT = 'x' CLUSTER BY (id);`).join('\n');
    t0 = Date.now();
    const result = convert('snowflake', repaired);
    expect(result.tableCount).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(30000);
  }, 60000);
});

describe('what was skipped is said once, and named in the log', () => {
  it('a file holding only CHECKs or masks (Databricks), or only skipped statements, is its skipped line alone (never also "empty")', () => {
    const result = convert('databricks', [
      { name: 'tables.sql', text: 'CREATE TABLE t (id BIGINT, email STRING);' },
      { name: 'checks.sql', text: 'ALTER TABLE t ADD CONSTRAINT ck CHECK (id > 0);' },
      { name: 'masks.sql', text: 'ALTER TABLE t ALTER COLUMN email SET MASK mask_email;' },
    ]);
    expect(result.skipped.filter((l) => /no tables, keys or comments/.test(l))).toEqual([]);
    expect(result.skipped.some((l) => l.startsWith('masks.sql: skipped'))).toBe(true);
  });

  it('each skipped object is named with its line in the log; the draft keeps the counts', () => {
    const result = convert('postgres', 'CREATE TABLE job_log (id int, uuid text);\n\nCREATE INDEX job_log_uuid ON job_log (uuid);\nCREATE VIEW recent AS SELECT * FROM job_log;\nINSERT INTO job_log VALUES (1, \'x\');');
    expect(result.skipped).toEqual(['a.sql: skipped 1 index, 1 view, 1 data statement (INSERT, UPDATE…)']);
    const log = ledgerLogLines(result.ledger, 'Import SQL DDL');
    expect(log).toContainEqual(expect.stringMatching(/a\.sql line 3: statement job_log_uuid: skipped, notDesign: index/));
    expect(log).toContainEqual(expect.stringMatching(/a\.sql line 4: statement recent: skipped, notDesign: view/));
    // Data statements are counted, never named.
    expect(log.some((l) => /line 5/.test(l))).toBe(false);
  });
});
