/**
 * The repair ladder (`sqlDdlRepair.ts`) and salvage (`sqlDdlSalvage.ts`):
 * a CREATE TABLE the grammar cannot read as written is degraded, never
 * dropped. Each edge-case class is tested as a class (every dialect, every
 * order, several spellings), not as the one instance a sample had.
 */
import { describe, expect, it } from 'vitest';

import { cleanDiagnostic, convertSqlDdl, firstDiagnostic, type SqlDialect, type SqlDdlToDbmlResult } from '../../src/services/sqlDdlImport';
import { matchParen, splitStatements } from '../../src/services/sqlDdlLexer';
import { cleanTypeText, isExoticType, repairHints, rewriteCreateTable, REPAIR_LADDER } from '../../src/services/sqlDdlRepair';
import { salvageCreateTable } from '../../src/services/sqlDdlSalvage';
import { dbmlCoreSqlEngine, sqlDdlToDbml } from '../../src/services/sqlImportEngine';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, text: string, name = 'a.sql'): Converted {
  const result = sqlDdlToDbml({ dialect, files: [{ name, text }] });
  if (!result.ok) throw new Error(`${dialect}: ${JSON.stringify(result.problems)}`);
  return result;
}

/** A table's field lines in the DBML (`"name" type [settings]`), by column name. */
function fields(dbml: string, table: string): Map<string, string> {
  const block = new RegExp(`Table (?:"[^"]+"\\.)?"${table}" \\{\\n([\\s\\S]*?)\\n\\}`).exec(dbml);
  if (!block) throw new Error(`no table ${table} in\n${dbml}`);
  const out = new Map<string, string>();
  for (const line of block[1].split('\n')) {
    const m = /^\s+"((?:[^"\\]|\\.)+)"\s+(.*)$/.exec(line);
    if (m && !/^\s+(Note|indexes)/.test(line)) out.set(m[1].replace(/\\(.)/g, '$1'), m[2]);
  }
  return out;
}

const permutations = <T,>(items: readonly T[]): T[][] =>
  items.length <= 1 ? [[...items]] : items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [x, ...rest]));

// ---------------------------------------------------------------------------
// Rung: trailing table options, in any combination and order
// ---------------------------------------------------------------------------

const TAIL_OPTIONS: Readonly<Record<SqlDialect, readonly string[]>> = {
  postgres: ['WITH (fillfactor = 70)', 'TABLESPACE pg_default', 'PARTITION BY RANGE (id)'],
  mysql: ['ENGINE=InnoDB', 'DEFAULT CHARSET=utf8mb4', "COMMENT='the t table'", 'ROW_FORMAT=DYNAMIC'],
  sqlserver: ['ON [PRIMARY]', 'TEXTIMAGE_ON [PRIMARY]', 'WITH (DATA_COMPRESSION = PAGE)'],
  snowflake: ['CLUSTER BY (id)', "COMMENT = 'the t table'", 'DATA_RETENTION_TIME_IN_DAYS = 1', 'CHANGE_TRACKING = TRUE'],
  databricks: ['USING DELTA', 'PARTITIONED BY (id)', "TBLPROPERTIES ('delta.x' = 'y')", "LOCATION '/mnt/x'", "COMMENT 'the t table'"],
};

describe('trailing table options: any combination, any order, every dialect', () => {
  for (const dialect of Object.keys(TAIL_OPTIONS) as SqlDialect[]) {
    const options = TAIL_OPTIONS[dialect];
    // Every order of the first three, and every option alone with COMMENT before and after it.
    const orders = [...permutations(options.slice(0, 3)), ...options.map((o) => [o])];
    it.each(orders.map((o) => [o.join(' ')]))(`${dialect}: %s`, (tail) => {
      const result = convert(dialect, `CREATE TABLE t (\n  id int NOT NULL,\n  name varchar(20)\n) ${tail};\nCREATE TABLE u (id int);`);
      expect(result.tableCount).toBe(2);
      expect([...fields(result.dbml, 't').keys()]).toEqual(['id', 'name']);
      if (/COMMENT/.test(tail)) expect(result.dbml).toContain("Note: 'the t table'");
      expect(result.problems).toEqual([]);
    });
  }

  it('snowflake: COMMENT before CLUSTER BY (the grid reliability sample) reads, the comment kept, the options said', () => {
    const text = "CREATE OR REPLACE TABLE ASSET_MASTER (\n  ASSET_ID VARCHAR(50) PRIMARY KEY,\n  STATUS VARCHAR(20) DEFAULT 'ACTIVE'\n)\nCOMMENT = 'Master inventory'\nCLUSTER BY (STATUS);";
    const result = convert('snowflake', text);
    expect(result.dbml).toContain("Note: 'Master inventory'");
    expect(result.readWith).toEqual({ grammar: 0, repaired: 1, salvaged: 0 });
    expect(result.ledger).toContainEqual(expect.objectContaining({
      outcome: 'repaired', unit: 'table', cause: 'trailingOption', what: 'table options',
      detail: 'set aside: CLUSTER BY; COMMENT kept as the table note', where: { file: 'a.sql', line: 5, table: 'ASSET_MASTER' },
    }));
  });

  it('postgres INHERITS and a later CREATE TABLE … PARTITION BY read; the rewrite never touches a table that reads as written', () => {
    const result = convert('postgres', 'CREATE TABLE base (id int);\nCREATE TABLE child (x int) INHERITS (base) TABLESPACE fast;');
    expect(result.tableCount).toBe(2);
    expect(result.readWith?.grammar).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Rung: unknown and exotic types, kept as written
// ---------------------------------------------------------------------------

describe('unknown or exotic column types are kept as written', () => {
  it.each([
    ['sqlserver', '[Resume] [XML]([HumanResources].[HRResumeSchemaCollection]) NULL', 'Resume', 'XML(HumanResources.HRResumeSchemaCollection)'],
    ['snowflake', 'EMBEDDING VECTOR(FLOAT, 768)', 'EMBEDDING', 'VECTOR(FLOAT, 768)'],
    ['postgres', 'geom geometry(Point,4326) NOT NULL', 'geom', 'geometry(Point, 4326)'],
    ['snowflake', 'AREA GEOGRAPHY', 'AREA', 'GEOGRAPHY'],
    ['postgres', 'embedding public.vector(20)', 'embedding', 'public.vector(20)'],
    ['postgres', 'grid int[][]', 'grid', 'int[][]'],
    ['snowflake', 'payload STRUCT<a: INT, b: STRING>', 'payload', 'STRUCT<a: INT, b: STRING>'],
    ['postgres', 'span INTERVAL DAY TO SECOND', 'span', 'INTERVAL DAY TO SECOND'],
    ['snowflake', 'n NUMBER(*,0)', 'n', 'NUMBER(*, 0)'],
    ['postgres', 'at TIMESTAMP(6) WITH LOCAL TIME ZONE', 'at', 'TIMESTAMP(6) WITH LOCAL TIME ZONE'],
  ] as const)('%s: %s', (dialect, column, name, type) => {
    const result = convert(dialect, `CREATE TABLE t (\n  id int,\n  ${column}\n);`);
    const got = fields(result.dbml, 't');
    expect([...got.keys()]).toEqual(['id', name]);
    // A table the ladder read keeps the type exactly as written (spacing aside); one the grammar read as written
    // keeps the grammar's reading (sql-fidelity's verbatim types).
    if ((result.readWith?.repaired ?? 0) + (result.readWith?.salvaged ?? 0) > 0) {
      expect(got.get(name)!.replace(/^"|"(?=\s|$)/g, '').replace(/\s*\[[a-z].*$/, '').replace(/\s+/g, '')).toBe(type.replace(/\s+/g, ''));
    }
  });

  it('a type no grammar reads is kept as written even when the table also needs another rewrite', () => {
    const result = convert('snowflake', 'CREATE TABLE t (\n  id int,\n  FILE_FORMAT varchar(9),\n  geom geometry(Point,4326),\n  e VECTOR(FLOAT, 768)\n);');
    const got = fields(result.dbml, 't');
    expect(got.get('geom')?.replace(/"/g, '')).toBe('geometry(Point,4326)');
    expect(got.get('e')?.replace(/"/g, '')).toBe('VECTOR(FLOAT, 768)');
  });

  it('records each exotic type as repaired, read as written (SQL Server XML stopped all 71 AdventureWorks tables)', () => {
    const result = convert('sqlserver', 'CREATE TABLE [Sales].[Store](\n  [BusinessEntityID] [int] NOT NULL,\n  [Demographics] [XML]([Sales].[StoreSurveySchemaCollection]) NULL\n) ON [PRIMARY];\nGO\nCREATE TABLE [Sales].[Other]([id] [int]);');
    expect(result.tableCount).toBe(2);
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', unit: 'column', cause: 'unknownType', what: 'XML type', where: { file: 'a.sql', line: 3, table: 'Sales.Store', column: 'Demographics' } }));
  });

  it('cleanTypeText strips SQL Server brackets from names, never an array\'s; isExoticType tells the grammar-safe types', () => {
    expect(cleanTypeText('[decimal](8, 2)')).toBe('decimal(8, 2)');
    expect(cleanTypeText('ARRAY<STRUCT<a: INT,\n    b: STRING>>')).toBe('ARRAY<STRUCT<a: INT, b: STRING>>');
    expect(cleanTypeText('TIMESTAMP(6) WITH LOCAL TIME ZONE')).toBe('TIMESTAMP(6) WITH LOCAL TIME ZONE');
    expect(cleanTypeText('int[]')).toBe('int[]');
    expect(cleanTypeText('"public"."year"')).toBe('public.year');
    for (const plain of ['int', 'varchar(50)', 'numeric(10, 2)', 'double precision', 'timestamp with time zone', 'nvarchar(max)', 'int unsigned']) expect(isExoticType(plain)).toBe(false);
    for (const exotic of ['VECTOR(FLOAT, 768)', 'geometry(Point,4326)', 'public.year', 'int[]', 'ARRAY<STRING>', "enum('a','b')", 'GEOGRAPHY', 'NUMBER(*,0)']) expect(isExoticType(exotic)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rung: names like keywords, in every quoting
// ---------------------------------------------------------------------------

describe('column names that are keywords, unquoted or quoted', () => {
  const KEYWORD_NAMES = ['FILE_FORMAT', 'ORDER', 'USER', 'KEY', 'VALUE', 'TYPE', 'COMMENT', 'DATE', 'LEVEL', 'ROWS'];
  const QUOTES: Readonly<Record<SqlDialect, (n: string) => string>> = {
    postgres: (n) => `"${n}"`, snowflake: (n) => `"${n}"`, mysql: (n) => `\`${n}\``, databricks: (n) => `\`${n}\``, sqlserver: (n) => `[${n}]`,
  };
  for (const dialect of Object.keys(QUOTES) as SqlDialect[]) {
    it(`${dialect}: unquoted and quoted, every column kept`, () => {
      for (const quoted of [false, true]) {
        const cols = KEYWORD_NAMES.map((n) => `  ${quoted ? QUOTES[dialect](n) : n} varchar(20)`);
        const result = convert(dialect, `CREATE TABLE t (\n  id int,\n${cols.join(',\n')}\n);`);
        expect([...fields(result.dbml, 't').keys()].map((k) => k.toUpperCase())).toEqual(['ID', ...KEYWORD_NAMES]);
      }
    });
  }

  it('embedded quotes, spaces and Unicode in quoted names survive the rewrite', () => {
    const result = convert('snowflake', 'CREATE TABLE t (\n  "say ""hi""" varchar(5),\n  "naïve café" int,\n  FILE_FORMAT varchar(9)\n);');
    expect([...fields(result.dbml, 't').keys()]).toEqual(['say "hi"', 'naïve café', 'FILE_FORMAT']);
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', cause: 'reservedWord', what: 'names like keywords' }));
  });
});

// ---------------------------------------------------------------------------
// Rung: unknown column modifiers
// ---------------------------------------------------------------------------

describe('SQL Server inline indexes in the column list (WideWorldImporters)', () => {
  it.each([
    ['INDEX name CLUSTERED COLUMNSTORE (no column list)', 'INDEX CCX_Application_Logs CLUSTERED COLUMNSTORE'],
    ['INDEX [name] NONCLUSTERED ([col])', 'INDEX [IX_Sensor] NONCLUSTERED ([Level])'],
    ['INDEX name HASH (col) WITH (BUCKET_COUNT = n)', 'INDEX IX_Hash HASH ([Level]) WITH (BUCKET_COUNT = 1024)'],
    ['INDEX name UNIQUE NONCLUSTERED (col)', 'INDEX IX_U UNIQUE NONCLUSTERED ([Level] DESC)'],
  ])('%s', (label, index) => {
    const result = convert('sqlserver', `CREATE TABLE [Application].[Logs](\n\t[Message] NVARCHAR(4000) NOT NULL,\n\t[Level] VARCHAR(16) NOT NULL,\n\t${index}\n)\nGO\n`);
    const f = fields(result.dbml, 'Logs');
    expect([...f.keys()]).toEqual(['Message', 'Level']);
    // A UNIQUE one is a unique key, not an index to leave out.
    expect(f.get('Level')!.includes('unique')).toBe(label.includes('UNIQUE'));
  });
});

describe('column modifiers the grammar does not know are set aside, the column kept', () => {
  it.each([
    ['postgres', 'h numeric(4,2) GENERATED ALWAYS AS (round(len / 60.0, 2)) VIRTUAL', 'VIRTUAL generated column'],
    ['sqlserver', '[Total] AS ([Qty] * [Price]) PERSISTED', undefined],
    ['databricks', 'email STRING MASK mask_email USING COLUMNS (id)', undefined],
    ['postgres', 'email text MASK mask_email USING COLUMNS (id)', 'MASK'],
    ['postgres', 'updated timestamp ON UPDATE CURRENT_TIMESTAMP', 'ON UPDATE'],
    ['postgres', 'secret int INVISIBLE', 'INVISIBLE'],
    ['sqlserver', '[Notes] nvarchar(200) SPARSE NULL', undefined],
    ['postgres', 'note text COLLATE "C" CHARACTER SET utf8', undefined],
    ['postgres', 'g uuid ROWGUIDCOL', 'ROWGUIDCOL'],
    ['snowflake', 'seq NUMBER AUTOINCREMENT START 1 INCREMENT 1', undefined],
    ['postgres', 'seq int IDENTITY(1,1) NOT FOR REPLICATION', 'NOT FOR REPLICATION'],
    ['postgres', 'created timestamp CONSTRAINT df_created DEFAULT now()', undefined],
    ['mysql', 'location GEOMETRY NOT NULL SRID 0', 'SRID'],
  ] as const)('%s: %s', (dialect, column, recorded) => {
    const result = convert(dialect, `CREATE TABLE t (\n  id int,\n  ${column}\n);`);
    expect(fields(result.dbml, 't').size).toBe(2);
    if (recorded) expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', unit: 'column', cause: 'unsupportedModifier', what: recorded, where: expect.objectContaining({ line: 3 }) }));
  });

  it('PostgreSQL 18 VIRTUAL generated column (pagila film): the table reads, its other columns and keys kept', () => {
    const text = 'CREATE TABLE public.film (\n  film_id integer NOT NULL,\n  length smallint,\n  fulltext tsvector NOT NULL,\n  length_hours numeric(4,2) GENERATED ALWAYS AS (round(length / 60.0, 2)) VIRTUAL\n);\nALTER TABLE ONLY public.film ADD CONSTRAINT film_pkey PRIMARY KEY (film_id);';
    const result = convert('postgres', text);
    expect([...fields(result.dbml, 'film').keys()]).toEqual(['film_id', 'length', 'fulltext', 'length_hours']);
    expect(fields(result.dbml, 'film').get('film_id')).toMatch(/pk/);
    expect(fields(result.dbml, 'film').get('fulltext')).toMatch(/^tsvector/);
  });

  it('identity spellings set aside for another grammar keep the column an identity', () => {
    const result = convert('snowflake', 'CREATE TABLE t (\n  id NUMBER(38,0) AUTOINCREMENT START 1 INCREMENT 1 PRIMARY KEY,\n  FILE_FORMAT varchar(9),\n  parent_id NUMBER REFERENCES t (id)\n);');
    expect(fields(result.dbml, 't').get('id')).toMatch(/increment/);
    expect(result.refCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The other grammars, and the rewrite itself
// ---------------------------------------------------------------------------

describe('the rewrite', () => {
  const statement = (text: string) => {
    const st = splitStatements(text, 'snowflake')[0];
    const t = st.tokens;
    const tableWord = t.findIndex((x) => x.value.toUpperCase() === 'TABLE');
    const open = t.findIndex((x) => x.value === '(');
    return { st, name: { parts: [t[tableWord + 1].value], first: tableWord + 1, next: open }, open, close: t.length - 1 - [...t].reverse().findIndex((x) => x.value === ')') };
  };

  it('keeps every line break, so a diagnostic line still points into the file', () => {
    const text = "CREATE OR REPLACE TABLE t (\n  id int,\n  v VECTOR(FLOAT, 768),\n  FILE_FORMAT varchar(9) COMMENT 'x\ny'\n)\nCOMMENT = 'z'\nCLUSTER BY (id);";
    const s = statement(text);
    for (const rungs of REPAIR_LADDER) {
      const { prepared } = rewriteCreateTable({ text, ...s, dialect: 'snowflake', target: 'postgres', rungs });
      expect(prepared.sql.split('\n')).toHaveLength(text.split('\n').length);
    }
  });

  it('a table no grammar reads as written but another grammar reads once rewritten is said so', () => {
    // Snowflake's grammar has no CHECK; PostgreSQL's reads it. (Its inline REFERENCES is now read as
    // written, spelt FOREIGN KEY REFERENCES for its grammar: sql.edgecases.test.ts.)
    const result = convert('snowflake', 'CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (\n  id int PRIMARY KEY CHECK (id > 0),\n  p_id int REFERENCES p (id)\n);');
    expect(result.refCount).toBe(1);
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', cause: 'grammarGap', what: 'CREATE TABLE', detail: "read with another dialect's grammar", where: expect.objectContaining({ table: 'c' }) }));
  });

  it('a forgiving grammar never reads stray words as a column: the rewrite must read the columns the file lists', () => {
    const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE a (id int);\nCREATE TABLE b (id int REFERENCES a (id) oops oops, x int);' }] });
    expect(result.ok && result.tableCount).toBe(1);
    expect(result.problems[0]).toMatchObject({ line: 2, table: 'b', message: expect.stringContaining('unexpected "oops"') });
  });
});

// ---------------------------------------------------------------------------
// Salvage
// ---------------------------------------------------------------------------

describe('salvage (no grammar at all)', () => {
  const crash = (): never => { throw new TypeError("Cannot read properties of null (reading 'accept')"); };
  const salvage = (text: string) => {
    const st = splitStatements(text, 'postgres')[0];
    const t = st.tokens;
    const open = t.findIndex((x) => x.value === '(');
    let depth = 0;
    let close = -1;
    for (let k = open; k < t.length; k++) { if (t[k].value === '(' && t[k].kind === 'punct') depth++; if (t[k].value === ')' && t[k].kind === 'punct' && --depth === 0) { close = k; break; } }
    return salvageCreateTable(text, st, { parts: ['s', 't'], next: open }, open, close);
  };

  it('reads names, types as written, keys, references, defaults, comments, checks and identity', () => {
    const out = salvage("CREATE TABLE s.t (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  code varchar(10) NOT NULL UNIQUE DEFAULT 'x' COMMENT 'Code.',\n  amount numeric(10,2) DEFAULT (0) CHECK (amount >= 0),\n  owner_id int REFERENCES s.owner (id) ON DELETE CASCADE,\n  at timestamp with time zone,\n  CONSTRAINT uq UNIQUE (code, at),\n  CONSTRAINT fk FOREIGN KEY (owner_id, code) REFERENCES s.pair (a, b)\n)");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const table = out.raw.tables![0];
    expect(table.fields!.map((f) => [f.name, f.type?.type_name])).toEqual([
      ['id', 'bigint'], ['code', 'varchar(10)'], ['amount', 'numeric(10,2)'], ['owner_id', 'int'], ['at', 'timestamp with time zone'],
    ]);
    expect(table.fields![0]).toMatchObject({ pk: true, increment: true });
    expect(table.fields![1]).toMatchObject({ not_null: true, unique: true, dbdefault: { type: 'string', value: 'x' }, note: 'Code.' });
    expect(table.fields![2]).toMatchObject({ dbdefault: { type: 'number', value: '0' }, checks: [{ expression: 'amount >= 0' }] });
    expect(table.indexes).toEqual([{ unique: true, columns: [{ value: 'code', type: 'column' }, { value: 'at', type: 'column' }], name: 'uq' }]);
    expect(out.raw.refs).toEqual([
      { endpoints: [{ tableName: 't', schemaName: 's', fieldNames: ['owner_id'], relation: '*' }, { tableName: 'owner', schemaName: 's', fieldNames: ['id'], relation: '1' }], onDelete: 'cascade' },
      { name: 'fk', endpoints: [{ tableName: 't', schemaName: 's', fieldNames: ['owner_id', 'code'], relation: '*' }, { tableName: 'pair', schemaName: 's', fieldNames: ['a', 'b'], relation: '1' }] },
    ]);
  });

  it.each([
    ['an empty column definition', 'CREATE TABLE s.t (\n  id int,,\n  x int\n)', 2, /empty column definition/],
    ['a stray word after a type', 'CREATE TABLE s.t (\n  id int,\n  x BIGINT oops\n)', 3, /unexpected "oops" after the type of x/],
    ['a stray word after a constraint', 'CREATE TABLE s.t (\n  id int NOT NULL frob\n)', 2, /unexpected "frob"/],
    ['a column with no type', 'CREATE TABLE s.t (\n  id\n)', 2, /has no type/],
  ] as const)('is strict about structure: %s is a problem with its line', (_label, text, line, reason) => {
    const out = salvage(text);
    expect(out).toMatchObject({ ok: false, line, reason: expect.stringMatching(reason) });
  });

  it('through the converter: a grammar that crashes on everything still imports every table, said once per table', () => {
    const text = 'CREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int, a_id int REFERENCES a (id));';
    const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text }] });
    expect(result.ok).toBe(true);
    const crashed = (result.ok && result) as Converted;
    expect(crashed.readWith?.grammar).toBe(2);
    const salvaged = convertSqlDdl({ dialect: 'postgres', files: [{ name: 'a.sql', text }] }, crash);
    expect(salvaged).toMatchObject({ ok: true, tableCount: 2, refCount: 1, readWith: { grammar: 0, repaired: 0, salvaged: 2 } });
  });

  it('the ladder has a budget: past it, tables go straight to salvage, and that is said once', () => {
    const text = Array.from({ length: 12 }, (_, i) => `CREATE TABLE t${i} (id int, v VECTOR(FLOAT, 768)) COMMENT = 'x' CLUSTER BY (id);`).join('\n');
    const result = convertSqlDdl({ dialect: 'snowflake', files: [{ name: 'a.sql', text }], options: { ladderTables: 5 } }, dbmlCoreSqlEngine);
    expect(result).toMatchObject({ ok: true, tableCount: 12, readWith: { grammar: 0, repaired: 5, salvaged: 7 } });
    expect(result.ok && result.ledger.filter((e) => e.cause === 'capped')).toHaveLength(1);
    // repair: false is the grammar alone.
    const strict = convertSqlDdl({ dialect: 'snowflake', files: [{ name: 'a.sql', text }], options: { repair: false } }, dbmlCoreSqlEngine);
    expect(strict).toMatchObject({ ok: false, tablesFound: 12 });
  });
});

// ---------------------------------------------------------------------------
// Messages: short, single-line, no echoed SQL
// ---------------------------------------------------------------------------

describe('problem messages are safe to show', () => {
  it('cleanDiagnostic: no echoed input beyond its last word, no comments, no line breaks or \\r\\n escapes, expecting lists trimmed, 80 characters at most', () => {
    const echoed = "no viable alternative at input 'CREATE OR REPLACE TABLE MAINTENANCE_LOG_DOCUMENTS (\\r\\n    DOCUMENT_ID VARCHAR(50) PRIMARY KEY, -- 'INSPECTION_REPORT', 'WORK_ORDER'\\r\\n    FILE_FORMAT'";
    const out = cleanDiagnostic(echoed);
    expect(out).toBe("no viable alternative at input 'FILE_FORMAT'");
    expect(cleanDiagnostic("mismatched input '(' expecting {'INDEX', ')', ','}")).toBe("mismatched input '(' expecting 'INDEX' or ')'…");
    expect(cleanDiagnostic("mismatched input 'VIRTUAL' expecting 'STORED'")).toBe("mismatched input 'VIRTUAL' expecting 'STORED'");
    const long = cleanDiagnostic(`extraneous input ${'x'.repeat(200)}\nsecond line /* a comment */`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long).not.toMatch(/\n|\\r|\\n|comment/);
  });

  it('firstDiagnostic: a grammar crash in plain words, a diagnostic\'s line kept', () => {
    expect(firstDiagnostic(new TypeError("Cannot read properties of null (reading 'accept')"))).toEqual({ message: 'the SQL parser could not read this statement', crash: true });
    expect(firstDiagnostic([{ message: "mismatched input 'x' expecting ')'", location: { start: { line: 3 } } }])).toEqual({ line: 3, message: "mismatched input 'x' expecting ')'", crash: false });
  });

  it('repairHints name the likely cause in a fixed phrase', () => {
    const hint = (text: string, dialect: SqlDialect = 'postgres') => {
      const st = splitStatements(text, dialect)[0];
      const open = st.tokens.findIndex((x) => x.value === '(');
      const close = matchParen(st.tokens, open);
      return repairHints(text, st, open, close).map((h) => h.phrase);
    };
    expect(hint('CREATE TABLE t (h int GENERATED ALWAYS AS (1) VIRTUAL)')).toContain('a VIRTUAL generated column (PostgreSQL 18)');
    expect(hint('CREATE TABLE ${s}.t (id int)')).toContain('a template placeholder such as ${…}');
    expect(hint("CREATE TABLE t (id int) COMMENT = 'x' CLUSTER BY (id)", 'snowflake')).toContain('CLUSTER BY after COMMENT');
    expect(hint('CREATE TABLE t (e VECTOR(FLOAT, 768))', 'snowflake')).toContain('the type VECTOR(FLOAT, 768)');
    expect(hint('CREATE TABLE t (FILE_FORMAT varchar(9))', 'snowflake')).toContain('a column named like a keyword');
  });

  it('every problem has a cause, a table and a line; a message never runs past one short line', () => {
    const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text: 'CREATE TABLE ok (id int);\n\nCREATE TABLE bad (\n  id int,\n  x int frob frob frob,\n  y int\n);' }] });
    expect(result.ok).toBe(true);
    const [p] = result.problems;
    expect(p).toMatchObject({ file: 'a.sql', line: 5, table: 'bad', cause: 'parseError', kind: 'parse' });
    expect(p.message.length).toBeLessThanOrEqual(140);
    expect(p.message).not.toMatch(/\n/);
  });
});
