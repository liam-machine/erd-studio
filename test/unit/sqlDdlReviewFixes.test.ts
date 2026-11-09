/**
 * Regressions for the review of the SQL DDL importer's repair ladder,
 * salvage, placeholder pass and dialect ranking. Each block names the class
 * of input it guards, not only the one statement the review found:
 *
 *  - a comma missing between two columns is never read as one column's type
 *    (the repair ladder's placeholders, the as-written type and salvage);
 *  - a constraint the files named is never dropped by the name the database
 *    would have given it;
 *  - a key part that is an expression is never read as a column, and a key
 *    naming a column the table lacks never vetoes the rest of the import;
 *  - two placeholders with the same last part stay two names;
 *  - the dialect ranking is bounded in time;
 *  - the banner, the log and the ledger say each thing once, and only what
 *    happened.
 */

import { describe, expect, it } from 'vitest';

import { readAsDialects, sqlPartialNotice } from '../../src/commands/importSqlDdl';
import { readDbml } from '../../src/services/dbmlImportParse';
import { tokenize } from '../../src/services/sqlDdlLexer';
import { missingCommaAt, strayTypeToken } from '../../src/services/sqlDdlRepair';
import { keyPartColumn } from '../../src/services/sqlDdlSalvage';
import { ambiguousPlaceholderNames, neutralisePlaceholders } from '../../src/services/sqlDdlPlaceholders';
import type { SqlDdlToDbmlResult, SqlDialect } from '../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';
import type { SqlImportModule } from '../../src/services/sqlImportLoader';

function convert(sql: string, dialect: SqlDialect, name = 'schema.sql'): SqlDdlToDbmlResult {
  return sqlDdlToDbml({ files: [{ name, text: sql }], dialect });
}

function okResult(sql: string, dialect: SqlDialect): Extract<SqlDdlToDbmlResult, { ok: true }> {
  const result = convert(sql, dialect);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result;
}

/** The type text strayTypeToken sees for the first column item after `(` in `sql`. */
function typeTokens(sql: string): { tokens: ReturnType<typeof tokenize>; start: number; end: number } {
  const tokens = tokenize(sql, 'postgres');
  // `x <type…>`: the type starts after the column name and runs to the end.
  return { tokens, start: 1, end: tokens.length };
}

describe('a comma missing between two columns', () => {
  it('is a stray token in a type: after the arguments, on a new line, or before another type head', () => {
    const cases: Array<[string, string]> = [
      ['price decimal(5,2) year int', 'year'],
      ['price decimal(5,2)\n year int', 'year'],
      ['title varchar(20)\n text text', 'text'],
      ['amount int\n year int', 'year'],
      ['amount int year int', 'year'],
      ['body text text text', 'text'],
      ['amount int\n "year" int', 'year'],
    ];
    for (const [sql, word] of cases) {
      const { tokens, start, end } = typeTokens(sql);
      const stray = strayTypeToken(tokens, start, end);
      expect(stray, sql).toBeGreaterThan(start);
      expect(tokens[stray].value, sql).toBe(word);
      expect(missingCommaAt(tokens, start, end), sql).toBe(stray);
    }
  });

  it('leaves real multi-word types alone, on one line or over several', () => {
    for (const sql of [
      'x double precision', 'x double\n precision', 'x character varying(30)', 'x timestamp with time zone',
      'x timestamp(3)\n  with time zone', 'x time(6) without time zone', 'x int unsigned', 'x decimal(10,2) unsigned zerofill',
      'x interval day(2) to second(6)', 'x interval year to month', 'x long varchar', 'x national char varying(10)',
      'x char(10) binary', 'x int[]', 'x bit varying(8)', 'x geometry(Point, 4326)', 'x public.vector(20)',
    ]) {
      const { tokens, start, end } = typeTokens(sql);
      expect(strayTypeToken(tokens, start, end), sql).toBe(-1);
    }
  });

  it('is put in and the table imported, each column with its own type, recorded with its line (PostgreSQL)', () => {
    const result = okResult('CREATE TABLE film (\n id int PRIMARY KEY,\n price decimal(5,2)\n year int,\n title text NOT NULL\n);', 'postgres');
    expect(result.problems).toHaveLength(0);
    expect(result.dbml).toMatch(/"price" decimal\(5,2\)/);
    expect(result.dbml).toMatch(/"year" int/);
    expect(result.dbml).toMatch(/"title" text \[not null\]/);
    const commas = result.ledger.filter((e) => e.what === 'missing comma');
    expect(commas).toEqual([expect.objectContaining({ outcome: 'repaired', unit: 'column', where: expect.objectContaining({ line: 4, table: 'film', column: 'price' }), detail: 'a comma added between price and year' })]);
  });

  it('is put in for MySQL too (`text text` after a varchar), never a dropped column', () => {
    const result = okResult('CREATE TABLE film (\n id int PRIMARY KEY,\n title varchar(20)\n text text,\n rating int\n);', 'mysql');
    expect(result.dbml).toMatch(/"title" varchar\(20\)/);
    expect(result.dbml).toMatch(/"text" text/);
    expect(result.dbml).toMatch(/"rating" int/);
    expect(result.ledger.filter((e) => e.what === 'missing comma').map((e) => e.where?.line)).toEqual([4]);
  });

  it('puts in several missing commas, in one table and across tables, and keeps the others reading', () => {
    const sql = [
      'CREATE TABLE a (', ' id int PRIMARY KEY,', ' x int', ' y int', ' z text', ');',
      'CREATE TABLE b (', ' id int PRIMARY KEY,', ' a_id int REFERENCES a(id)', ' note varchar(10)', ');',
      'CREATE TABLE c (id int PRIMARY KEY, label text);',
    ].join('\n');
    const result = okResult(sql, 'postgres');
    expect(result.tableCount).toBe(3);
    for (const col of ['"x" int', '"y" int', '"z" text', '"note" varchar(10)']) expect(result.dbml).toContain(col);
    expect(result.refCount).toBe(1);
    const lines = result.ledger.filter((e) => e.what === 'missing comma').map((e) => `${e.where?.table}:${e.where?.line}`).sort();
    expect(lines).toEqual(['a:4', 'a:5', 'b:10']);
  });

  it('keeps the original problem, naming the missing comma, when the table still does not read with it put in', () => {
    const result = convert('CREATE TABLE film (\n id int PRIMARY KEY,\n price decimal(5,2)\n year int,\n weird int @@@ ~~~ text\n);', 'postgres');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatchObject({ line: 4, message: 'CREATE TABLE film could not be read: a comma missing before year (after the column price)' });
  });

  it('is found after a column\'s constraints too (REFERENCES, NOT NULL, DEFAULT), not inside ON DELETE lines', () => {
    const result = okResult([
      'CREATE TABLE p (id int PRIMARY KEY);',
      'CREATE TABLE c (', ' id int PRIMARY KEY,', ' p_id int NOT NULL REFERENCES p(id)', '   ON DELETE CASCADE', ' note varchar(10) DEFAULT \'x\'', ' made timestamp NOT NULL', ');',
    ].join('\n'), 'postgres');
    expect(result.dbml).toContain('"note" varchar(10)');
    expect(result.dbml).toContain('"made" timestamp');
    expect(result.ledger.filter((e) => e.what === 'missing comma').map((e) => `${e.where?.column}>${e.where?.line}`)).toEqual(['p_id>6', 'note>7']);
    expect(result.refCount).toBe(1);
  });

  it('leaves real multi-word types and tables that read alone (no comma recorded)', () => {
    const result = okResult('CREATE TABLE t (\n a double\n   precision,\n b timestamp(3)\n   with time zone,\n c int unsigned\n);', 'mysql');
    expect(result.ledger.some((e) => e.what === 'missing comma')).toBe(false);
  });

  it('keeps each column its own type when a forgiving grammar reads the columns (SQL Server)', () => {
    const result = convert('CREATE TABLE dbo.Orders (\n OrderID int NOT NULL PRIMARY KEY,\n Note nvarchar(50)\n Year int\n);', 'sqlserver');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.readWith?.grammar).toBe(1);
    expect(result.dbml).toMatch(/"Note" nvarchar\(50\)\n/);
    expect(result.dbml).toMatch(/"Year" int/);
    expect(result.dbml).not.toMatch(/nvarchar\(50\) Year/);
  });
});

describe('DROP CONSTRAINT by a name the database would have given', () => {
  it('leaves a primary key the files named', () => {
    const result = okResult('CREATE TABLE orders (id int, CONSTRAINT pk_orders PRIMARY KEY (id));\nALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_pkey;', 'postgres');
    expect(result.dbml).toMatch(/"id" int \[pk\]|\("id"\) \[pk\]/);
  });

  it('leaves a unique key the files named (inline or table-level)', () => {
    const inline = okResult('CREATE TABLE users (id int PRIMARY KEY, email text CONSTRAINT uq_email UNIQUE);\nALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;', 'postgres');
    expect(inline.dbml).toMatch(/"email" text \[unique\]/);
    const table = okResult('CREATE TABLE users (id int PRIMARY KEY, a int, b int, CONSTRAINT uq_ab UNIQUE (a, b));\nALTER TABLE users DROP CONSTRAINT IF EXISTS users_a_b_key;', 'postgres');
    expect(table.dbml).toMatch(/\("a", "b"\) \[unique\]/);
  });

  it('still drops an unnamed one by its generated name', () => {
    const pk = okResult('CREATE TABLE orders (id int PRIMARY KEY, n int);\nALTER TABLE orders DROP CONSTRAINT orders_pkey;', 'postgres');
    expect(pk.dbml).not.toMatch(/\[pk\]/);
    const uq = okResult('CREATE TABLE users (id int PRIMARY KEY, email text UNIQUE);\nALTER TABLE users DROP CONSTRAINT users_email_key;', 'postgres');
    expect(uq.dbml).not.toMatch(/unique/);
  });
});

describe('a key part that is an expression', () => {
  it('is never read as a column by salvage', () => {
    const tokens = tokenize('(lower(email)) , email(10) DESC, a + b, b COLLATE "C"', 'mysql');
    const items: Array<[number, number]> = [];
    let from = 0;
    for (let k = 0; k <= tokens.length; k++) {
      if (k === tokens.length || (tokens[k].kind === 'punct' && tokens[k].value === ',')) { items.push([from, k]); from = k + 1; }
    }
    expect(items.map(([a, b]) => keyPartColumn(tokens, a, b))).toEqual([undefined, 'email', undefined, 'b']);
  });

  it('never vetoes the import from a salvaged table: the key is left out and said', () => {
    const deep = `${'('.repeat(46)}1${')'.repeat(46)}`;
    const sql = `CREATE TABLE users (id int PRIMARY KEY, email varchar(100) NOT NULL CHECK (id > ${deep}), UNIQUE KEY uk_email ((lower(email))));\nCREATE TABLE orders (id int PRIMARY KEY, user_id int REFERENCES users (id));`;
    const result = okResult(sql, 'mysql');
    expect(result.readWith?.salvaged).toBe(1);
    expect(result.dbml).not.toMatch(/"lower"/);
    expect(readDbml(result.dbml).ok).toBe(true);
    expect(result.ledger?.some((e) => e.outcome === 'lost' && e.unit === 'uniqueKey' && /expression/.test(e.what))).toBe(true);
  });

  it('is not kept as a weaker key on its other columns', () => {
    const result = okResult('CREATE TABLE users (id int PRIMARY KEY, a int, b varchar(10), UNIQUE KEY uk (a, (lower(b))));', 'mysql');
    expect(result.dbml).not.toMatch(/\("a"\) \[unique\]|"a" int \[unique\]/);
  });
});

describe('two placeholders with the same last part', () => {
  it('read as their full names, so two tables stay two', () => {
    const sql = 'CREATE TABLE ${bronze.schema}.orders (id INT, amount DOUBLE);\nCREATE TABLE ${silver.schema}.orders (id INT, total DOUBLE, extra STRING);';
    const result = okResult(sql, 'databricks');
    expect(result.problems ?? []).toEqual([]);
    expect(result.dbml).toMatch(/bronze_schema/);
    expect(result.dbml).toMatch(/silver_schema/);
    expect(result.dbml).toMatch(/"extra"/);
  });

  it('dbt sources of the same table name stay apart too', () => {
    const ambiguous = ambiguousPlaceholderNames(["select * from {{ source('raw','orders') }}", "x {{ source('stg','orders') }}"], 'postgres');
    expect([...ambiguous]).toEqual(['orders']);
    const pass = neutralisePlaceholders("CREATE TABLE {{ source('raw','orders') }} (id int);", 'postgres', ambiguous);
    expect(pass.text.replace(/\s+/g, ' ').trim()).toBe('CREATE TABLE raw_orders (id int);');
  });

  it('keep the short name when it names one thing, in every file alike', () => {
    expect([...ambiguousPlaceholderNames(['CREATE TABLE {{ target.schema }}.a (id int);', 'CREATE TABLE {{ target.schema }}.b (id int);'], 'postgres')]).toEqual([]);
    expect(neutralisePlaceholders('CREATE TABLE {{ target.schema }}.orders (id int);', 'postgres').text.replace(/\s+/g, ' ').trim()).toBe('CREATE TABLE schema.orders (id int);');
  });

  it('the ledger names no placeholder as a table and says a catalog was dropped only when one was', () => {
    const noCatalog = okResult('CREATE TABLE ${schema}.orders (id INT);', 'databricks');
    const entry = noCatalog.ledger?.find((e) => e.cause === 'templatePlaceholder');
    expect(entry?.where?.table).toBeUndefined();
    expect(entry?.detail).not.toMatch(/catalog/);
    const withCatalog = okResult('CREATE TABLE ${catalog}.${schema}.orders (id INT);', 'databricks');
    expect(withCatalog.ledger?.find((e) => e.cause === 'templatePlaceholder')?.detail).toMatch(/1 catalog placeholder dropped/);
  });
});

describe('the dialect ranking', () => {
  const files = [{ name: 'a.sql', text: 'CREATE TABLE a (id int PRIMARY KEY);' }];
  const reading = (tables: number): SqlDdlToDbmlResult => (tables > 0
    ? { ok: true, dbml: '', tableCount: tables, tablesFound: 1, relationshipCount: 0, skipped: [], notes: [], readWith: { grammar: 0, repaired: tables, salvaged: 0 } } as unknown as SqlDdlToDbmlResult
    : { ok: false, problems: [{ file: 'a.sql', message: 'no', table: 'a' }] } as unknown as SqlDdlToDbmlResult);

  it('stops reading more dialects once one reads a table and the budget is spent', async () => {
    let clock = 0;
    const calls: string[] = [];
    const engine = { sqlDdlToDbml: ({ dialect }: { dialect: SqlDialect }) => { calls.push(dialect); clock += 2000; return reading(1); } } as unknown as SqlImportModule;
    const readings = await readAsDialects(engine, files, ['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks'], undefined, { ms: 3000, now: () => clock });
    expect(calls).toEqual(['postgres']);
    expect(readings.size).toBe(1);
  });

  it('keeps trying while no dialect reads a table (the user would be asked otherwise)', async () => {
    let clock = 0;
    const calls: string[] = [];
    const engine = { sqlDdlToDbml: ({ dialect }: { dialect: SqlDialect }) => { calls.push(dialect); clock += 5000; return reading(dialect === 'snowflake' ? 1 : 0); } } as unknown as SqlImportModule;
    await readAsDialects(engine, files, ['postgres', 'mysql', 'snowflake', 'sqlserver', 'databricks'], undefined, { ms: 3000, now: () => clock });
    expect(calls).toEqual(['postgres', 'mysql', 'snowflake']);
  });

  it('reads every dialect when they are quick', async () => {
    const calls: string[] = [];
    const engine = { sqlDdlToDbml: ({ dialect }: { dialect: SqlDialect }) => { calls.push(dialect); return reading(1); } } as unknown as SqlImportModule;
    await readAsDialects(engine, files, ['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks'], undefined, { ms: 3000, now: () => 0 });
    expect(calls).toHaveLength(5);
  });

  it('counts the time of readings it is given', async () => {
    let clock = 0;
    const calls: string[] = [];
    const engine = { sqlDdlToDbml: ({ dialect }: { dialect: SqlDialect }) => { calls.push(dialect); clock += 2500; return reading(1); } } as unknown as SqlImportModule;
    const first = await readAsDialects(engine, files, ['postgres'], undefined, { ms: 3000, now: () => clock });
    await readAsDialects(engine, files, ['postgres', 'mysql', 'sqlserver'], first, { ms: 3000, now: () => clock });
    expect(calls).toEqual(['postgres']);
  });
});

describe('what the import says', () => {
  it('a table defined twice is not a table that could not be read', () => {
    const result = okResult('CREATE TABLE a (id int PRIMARY KEY); CREATE TABLE b (id int); CREATE TABLE a (id int PRIMARY KEY);', 'postgres');
    expect(result.tableCount).toBe(2);
    expect(sqlPartialNotice(result)).toBe('1 table is defined twice (the first definition is kept); Show details lists it.');
  });

  it('counts unread tables out of the distinct tables', () => {
    const result = okResult('CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int,, x int);\nCREATE TABLE c (id int);', 'postgres');
    expect(sqlPartialNotice(result)).toBe('1 of 3 tables could not be read; 1 table is defined twice (the first definition is kept); Show details lists them.');
  });

  it('a column named like a keyword is not "quoted so it reads" when quoting was not the fix', () => {
    const result = okResult('CREATE TABLE people (\n id int PRIMARY KEY,\n name text,\n upper_name text GENERATED ALWAYS AS (upper(name)) VIRTUAL\n);', 'postgres');
    const repaired = (result.ledger ?? []).filter((e) => e.outcome === 'repaired');
    expect(repaired.some((e) => /VIRTUAL/.test(e.detail ?? '') || /VIRTUAL/.test(e.what))).toBe(true);
    expect(repaired.some((e) => e.what === 'names like keywords')).toBe(false);
  });

  it('a column named like a keyword is still noted when quoting was the fix', () => {
    const result = okResult('CREATE TABLE t (\n id int PRIMARY KEY,\n order int\n);', 'postgres');
    expect(result.readWith?.repaired).toBe(1);
    expect((result.ledger ?? []).filter((e) => e.outcome === 'repaired').map((e) => e.what)).toEqual(['names like keywords']);
  });
});
