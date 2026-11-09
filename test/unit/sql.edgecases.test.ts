/**
 * The SQL importer, attacked: real-world-style inputs the ten samples do not
 * hold (vendor exports, templated SQL, hostile files), each held to the
 * conservation invariant — every source table, column, key and link is
 * imported or reported with a cause and a place; nothing throws; no shown
 * line echoes a wall of the file. Each block names the class of input it
 * covers, so a fix covers the class, not one sample.
 */
import { describe, expect, it } from 'vitest';

import { ledgerLogLines } from '../../src/services/importLedger';
import { countCreateTablesWithColumns, MAX_GRAMMAR_PAREN_DEPTH, MAX_SHOWN_RUN, SQL_DIALECTS, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlDialect } from '../../src/services/sqlDdlImport';
import { neutralisePlaceholders } from '../../src/services/sqlDdlPlaceholders';
import { sqlDdlToDbml } from '../../src/services/sqlImportEngine';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, files: SqlDdlFile[] | string, options?: { ladderTables?: number }): Converted {
  const result = sqlDdlToDbml({ dialect, files: typeof files === 'string' ? [{ name: 'a.sql', text: files }] : files, ...(options ? { options } : {}) });
  if (!result.ok) throw new Error(`${dialect}: ${JSON.stringify(result.problems)}`);
  return result;
}

/** `schema.table` (or `table`) for every Table block, in order. */
const tableNames = (dbml: string): string[] => [...dbml.matchAll(/^Table (?:"([^"]+)"\.)?"([^"]+)"/gm)].map((m) => (m[1] ? `${m[1]}.${m[2]}` : m[2]));
/** One table block's text. */
const tableBlock = (dbml: string, name: string): string => {
  const at = dbml.search(new RegExp(`^Table (?:"[^"]+"\\.)?"${name}" \\{`, 'm'));
  return at < 0 ? '' : dbml.slice(at, dbml.indexOf('\n}', at) + 2);
};
const refLines = (dbml: string): string[] => dbml.split('\n').filter((l) => l.startsWith('Ref:'));
/** Every line the user can read from a result. */
const shown = (r: SqlDdlToDbmlResult): string[] => [
  ...r.problems.map((p) => p.message),
  ...(r.ok ? [...r.skipped, ...r.notes] : []),
  ...ledgerLogLines(r.ledger ?? [], 'Import SQL DDL'),
];

// ---------------------------------------------------------------------------
// Template placeholders: every syntax, in every position, quoted or bare
// ---------------------------------------------------------------------------

describe('template placeholders', () => {
  const SYNTAXES: Record<string, (n: string) => string> = {
    '${x}': (n) => `\${${n}}`,
    '${x:-default}': (n) => `\${${n}:-prod}`,
    '${flyway:x}': (n) => `\${flyway:${n}}`,
    '{{ x }}': (n) => `{{ ${n} }}`,
    "{{ var('x') }}": (n) => `{{ var('${n}') }}`,
    '$(x)': (n) => `$(${n})`,
    '@x@': (n) => `@${n}@`,
    '<%= x %>': (n) => `<%= ${n} %>`,
    '%(x)s': (n) => `%(${n})s`,
  };
  const QUOTE: Record<SqlDialect, (s: string) => string> = {
    postgres: (s) => `"${s}"`, snowflake: (s) => `"${s}"`, sqlserver: (s) => `[${s}]`, mysql: (s) => `\`${s}\``, databricks: (s) => `\`${s}\``,
  };

  for (const dialect of SQL_DIALECTS) {
    for (const [label, ph] of Object.entries(SYNTAXES)) {
      it(`${dialect} ${label}: as a schema, a catalog, part of a name, in REFERENCES and ALTER TABLE, the link is drawn`, () => {
        const cases: Array<[string, string, string[]]> = [
          ['schema', `CREATE TABLE ${ph('sch')}.orders (id int PRIMARY KEY);\nCREATE TABLE ${ph('sch')}.items (id int, oid int, FOREIGN KEY (oid) REFERENCES ${ph('sch')}.orders(id));`, ['sch.orders', 'sch.items']],
          ['catalog', `CREATE TABLE ${ph('cat')}.sales.orders (id int PRIMARY KEY);\nCREATE TABLE ${ph('cat')}.sales.items (id int, oid int, FOREIGN KEY (oid) REFERENCES ${ph('cat')}.sales.orders(id));`, ['sales.orders', 'sales.items']],
          ['part of a name', `CREATE TABLE stg_${ph('env')}_orders (id int PRIMARY KEY);\nCREATE TABLE stg_${ph('env')}_items (id int, oid int, FOREIGN KEY (oid) REFERENCES stg_${ph('env')}_orders(id));`, ['stg_env_orders', 'stg_env_items']],
          ['ALTER TABLE', `CREATE TABLE ${ph('sch')}.orders (id int PRIMARY KEY);\nCREATE TABLE ${ph('sch')}.items (id int, oid int);\nALTER TABLE ${ph('sch')}.items ADD CONSTRAINT fk FOREIGN KEY (oid) REFERENCES ${ph('sch')}.orders(id);`, ['sch.orders', 'sch.items']],
        ];
        for (const [where, text, tables] of cases) {
          const result = convert(dialect, text);
          expect(tableNames(result.dbml), `${where}`).toEqual(tables);
          expect(result.refCount, `${where}`).toBe(1);
          expect(result.ledger.some((e) => e.cause === 'templatePlaceholder'), where).toBe(true);
        }
      });

      it(`${dialect} ${label}: a quoted placeholder name is the same table as the bare one`, () => {
        // sqlcmd scripts write `[$(Schema)].[orders]` in one place and `$(Schema).orders` in another.
        const result = convert(dialect, `CREATE TABLE ${QUOTE[dialect](ph('sch'))}.orders (id int PRIMARY KEY);\nCREATE TABLE ${ph('sch')}.items (id int, oid int, FOREIGN KEY (oid) REFERENCES ${QUOTE[dialect](ph('sch'))}.orders(id));`);
        expect(tableNames(result.dbml)).toEqual(['sch.orders', 'sch.items']);
        expect(result.refCount).toBe(1);
        expect(result.skipped.join('\n')).not.toMatch(/not in the files/);
      });
    }
  }

  it('a placeholder inside a string or comment is never touched (a quoted placeholder name keeps its length)', () => {
    const text = "-- ${commented}\nCREATE TABLE \"${s}\".t (\n  a text DEFAULT '${kept}', /* {{ also }} */\n  b text\n);";
    const pass = neutralisePlaceholders(text, 'postgres');
    expect(pass.text).toHaveLength(text.length);
    expect(pass.text).toContain("'${kept}'");
    expect(pass.text).toContain('/* {{ also }} */');
    expect(pass.text).toContain('-- ${commented}');
    expect(pass.text.split('\n').length).toBe(text.split('\n').length);
    expect(pass.text).toContain('"s".t');
    // A Spark "…" is a string: never a name.
    expect(neutralisePlaceholders("CREATE TABLE t (a string DEFAULT \"${x}\");", 'databricks').count).toBe(0);
  });

  it("SQL*Plus `&schema..table` (the dot ends the variable) and `&cat..sales.t` read as qualified names", () => {
    expect(tableNames(convert('postgres', 'CREATE TABLE &cat..sales.orders (id int);\nCREATE TABLE &&sch..items (id int);').dbml)).toEqual(['sales.orders', 'sch.items']);
  });
});

// ---------------------------------------------------------------------------
// Strings: PostgreSQL escape strings never run past their end
// ---------------------------------------------------------------------------

describe("E'…' escape strings", () => {
  it.each(['postgres', 'sqlserver', 'snowflake'] as const)("%s: an E'it\\'s' comment keeps every statement after it", (dialect) => {
    const result = convert(dialect, [
      'CREATE TABLE a (id int PRIMARY KEY, n text);',
      "COMMENT ON TABLE a IS E'line1\\nline2 it\\'s';",
      "COMMENT ON COLUMN a.n IS 'the n';",
      "COMMENT ON COLUMN a.id IS E'C:\\\\path';",
      'CREATE TABLE b (id int, a_id int REFERENCES a(id));',
    ].join('\n'));
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(result.refCount).toBe(1);
    const a = tableBlock(result.dbml, 'a');
    expect(a).toContain("note: 'the n'");
    expect(a).toMatch(/line2 it\\?'s/);
    // One backslash, read once (never `C:path`).
    expect(a).toMatch(/C:\\\\path/);
  });

  it('a backslash in a plain PostgreSQL string (no E before it) is a character, not an escape', () => {
    const result = convert('postgres', "CREATE TABLE a (id int PRIMARY KEY, t text DEFAULT 'none\\');\nCREATE TABLE b (id int);");
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
  });
});

describe('string modes', () => {
  it("pg_dump's SET standard_conforming_strings = off: 'it\\'s' ends where PostgreSQL ends it, so no statement after it is lost", () => {
    const result = convert('postgres', [
      'SET standard_conforming_strings = off;',
      'CREATE TABLE a (id int);',
      "COMMENT ON TABLE a IS 'it\\'s';",
      'CREATE TABLE b (id int, a_id int REFERENCES a(id));',
      "COMMENT ON TABLE b IS 'bee';",
      'SET standard_conforming_strings = on;',
      "COMMENT ON TABLE b IS 'C:\\new';",
    ].join('\n'));
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(result.refCount).toBe(1);
    expect(tableBlock(result.dbml, 'a')).toMatch(/Note: 'it\\'s'/);
    // Back on: the backslash is a character again.
    expect(tableBlock(result.dbml, 'b')).toContain('C:\\\\new');
  });

  it.each(['mysql', 'databricks'] as const)('%s: COMMENT "…" is a string, its \\" escapes read', (dialect) => {
    const result = convert(dialect, 'CREATE TABLE a (id int COMMENT "the \\"id\\"; yes") COMMENT "tbl";\nCREATE TABLE b (id int);');
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(tableBlock(result.dbml, 'a')).toContain('note: \'the "id"; yes\'');
    expect(tableBlock(result.dbml, 'a')).toContain("Note: 'tbl'");
  });
});

// ---------------------------------------------------------------------------
// Descriptions replayed in file order
// ---------------------------------------------------------------------------

describe('descriptions', () => {
  it('COMMENT ON … IS NULL clears an earlier comment; IS \'\' too', () => {
    const result = convert('postgres', "CREATE TABLE a (id int, n text);\nCOMMENT ON TABLE a IS 'old';\nCOMMENT ON COLUMN a.n IS 'old n';\nCOMMENT ON TABLE a IS NULL;\nCOMMENT ON COLUMN a.n IS '';");
    expect(tableBlock(result.dbml, 'a')).not.toMatch(/old/);
  });

  it('Snowflake COMMENT IF EXISTS ON TABLE is read', () => {
    const result = convert('snowflake', "CREATE TABLE a (id int);\nCOMMENT IF EXISTS ON TABLE a IS 'kept';\nCOMMENT IF EXISTS ON COLUMN a.id IS 'the id';");
    expect(tableBlock(result.dbml, 'a')).toContain("Note: 'kept'");
    expect(tableBlock(result.dbml, 'a')).toContain("note: 'the id'");
    expect(result.skipped).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Column types and modifiers the grammars do not all have
// ---------------------------------------------------------------------------

describe('column types and modifiers', () => {
  it("SQL Server's inline `int FOREIGN KEY REFERENCES t(id)`: the type is int, the link drawn", () => {
    const sql = 'CREATE TABLE dbo.p (id int PRIMARY KEY);\nCREATE TABLE dbo.c (id int, p_id int FOREIGN KEY REFERENCES dbo.p(id) ON DELETE CASCADE);';
    for (const options of [undefined, { ladderTables: 0 }]) {
      const result = convert('sqlserver', sql, options);
      expect(tableBlock(result.dbml, 'c')).toMatch(/"p_id" int\n/);
      expect(refLines(result.dbml)).toEqual(['Ref: "dbo"."c"."p_id" > "dbo"."p"."id" [delete: cascade]']);
    }
  });

  it('MySQL COLUMN_FORMAT and ENGINE_ATTRIBUTE end the type', () => {
    const result = convert('mysql', "CREATE TABLE t (id int PRIMARY KEY, x int COLUMN_FORMAT FIXED, y varchar(5) ENGINE_ATTRIBUTE='{}');");
    expect(tableBlock(result.dbml, 't')).toMatch(/"x" int\n/);
    expect(tableBlock(result.dbml, 't')).toMatch(/"y" varchar\(5\)\n/);
  });

  // Salvage (ladderTables: 0) must read what the ladder reads.
  for (const [label, options] of [['the repair ladder', undefined], ['salvage', { ladderTables: 0 }]] as const) {
    it(`Snowflake [WITH] MASKING | PROJECTION POLICY with qualified policy names (${label})`, () => {
      const result = convert('snowflake', [
        'CREATE TABLE t (',
        '  id NUMBER PRIMARY KEY,',
        '  e VARCHAR MASKING POLICY gov.policies.email_mask USING (e, id) COMMENT \'email\',',
        '  p VARCHAR PROJECTION POLICY gov.policies.proj,',
        '  q VARCHAR WITH MASKING POLICY gov.policies.m2,',
        '  r VARCHAR WITH PROJECTION POLICY pp',
        ');',
      ].join('\n'), options);
      expect(result.problems).toEqual([]);
      const t = tableBlock(result.dbml, 't');
      for (const c of ['e', 'p', 'q', 'r']) expect(t).toMatch(new RegExp(`"${c}" VARCHAR`));
      expect(t).toContain("note: 'email'");
    });

    it(`Databricks MASK catalog.schema.fn USING COLUMNS (…) (${label})`, () => {
      const result = convert('databricks', 'CREATE TABLE main.s.t (\n  id BIGINT NOT NULL,\n  ssn STRING MASK main.gov.mask_ssn USING COLUMNS (id),\n  x STRING MASK m\n);', options);
      expect(result.problems).toEqual([]);
      expect(tableBlock(result.dbml, 't')).toMatch(/"ssn" STRING/);
    });

    it(`PostgreSQL 15 ON DELETE SET NULL (cols) keeps the link and its action (${label})`, () => {
      const result = convert('postgres', [
        'CREATE TABLE p (id int PRIMARY KEY);',
        'CREATE TABLE c (id int,',
        '  a int REFERENCES p ON DELETE CASCADE ON UPDATE NO ACTION,',
        '  b int REFERENCES p(id) ON UPDATE SET DEFAULT ON DELETE RESTRICT,',
        '  c int REFERENCES p(id) ON DELETE SET NULL (c),',
        '  d int, FOREIGN KEY (d) REFERENCES p(id) MATCH FULL ON DELETE SET DEFAULT (d) DEFERRABLE INITIALLY IMMEDIATE);',
      ].join('\n'), options);
      expect(result.problems).toEqual([]);
      expect(refLines(result.dbml)).toEqual([
        'Ref: "c"."a" > "p"."id" [delete: cascade, update: no action]',
        'Ref: "c"."b" > "p"."id" [delete: restrict, update: set default]',
        'Ref: "c"."c" > "p"."id" [delete: set null]',
        'Ref: "c"."d" > "p"."id" [delete: set default]',
      ]);
    });
  }

  it('a reference action is never mistaken for MySQL ON UPDATE CURRENT_TIMESTAMP when another column needs a repair', () => {
    // `geography` sends the table down the ladder, whose modifier rung sets ON UPDATE aside.
    const result = convert('postgres', 'CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int, g geography(Point), a int REFERENCES p ON UPDATE NO ACTION ON DELETE SET NULL);');
    expect(refLines(result.dbml)).toEqual(['Ref: "c"."a" > "p"."id" [delete: set null, update: no action]']);
  });
});

// ---------------------------------------------------------------------------
// Snowflake's grammar gaps, read as written
// ---------------------------------------------------------------------------

describe('Snowflake', () => {
  it('an inline REFERENCES (and CONSTRAINT x REFERENCES) reads with the grammar, not the repair ladder', () => {
    const result = convert('snowflake', 'CREATE TABLE t0 (id int PRIMARY KEY);\nCREATE TABLE t1 (id int PRIMARY KEY, p_id int REFERENCES t0(id), q int CONSTRAINT fk REFERENCES t0 (id) ON DELETE CASCADE, z int FOREIGN KEY REFERENCES t0(id), FOREIGN KEY (q) REFERENCES t0(id));');
    expect(result.readWith).toEqual({ grammar: 2, repaired: 0, salvaged: 0 });
    expect(result.refCount).toBe(3);
  });

  it("GET_DDL's `cluster by (…)` before the column list: the table reads, the clause counts as an option, lines stay", () => {
    const text = [
      'create or replace TABLE ANALYTICS.CORE.ORDERS cluster by (ORDER_DATE)(',
      '\tID NUMBER(38,0) NOT NULL autoincrement start 1 increment 1 noorder,',
      '\tCUSTOMER_ID NUMBER(38,0),',
      '\tORDER_DATE DATE,',
      '\tconstraint PK_ORDERS primary key (ID),',
      '\tconstraint FK_C foreign key (CUSTOMER_ID) references ANALYTICS.CORE.CUSTOMERS(ID)',
      ")COMMENT='Orders table'",
      ';',
      'create or replace TRANSIENT TABLE ANALYTICS.CORE.CUSTOMERS cluster by (ID) (ID NUMBER(38,0) NOT NULL, constraint PK primary key (ID));',
      'create or replace TABLE ANALYTICS.CORE.BROKEN cluster by (X)(X NUMBER,, Y NUMBER);',
    ].join('\n');
    const result = convert('snowflake', text);
    expect(tableNames(result.dbml)).toEqual(['CORE.ORDERS', 'CORE.CUSTOMERS']);
    expect(result.refCount).toBe(1);
    expect(tableBlock(result.dbml, 'ORDERS')).toContain("Note: 'Orders table'");
    expect(result.problems).toEqual([expect.objectContaining({ line: 10, table: 'CORE.BROKEN' })]);
    expect(result.skipped.join('\n')).toMatch(/table option/);
    expect(countCreateTablesWithColumns(text, 'snowflake')).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Encoding and format noise
// ---------------------------------------------------------------------------

describe('encoding and format noise', () => {
  const base = ['CREATE TABLE a (id int PRIMARY KEY);', 'CREATE TABLE b (id int,, x int);', 'CREATE TABLE c (', '  id int,', '  a_id int REFERENCES a(id)', ');'];

  it.each([
    ['no-break spaces', (s: string) => s.replace(/ /g, '\u00a0')],
    ['ideographic and thin spaces', (s: string) => s.replace(/ /g, (_m) => '\u3000').replace(/\(/g, '\u2009(')],
    ['form feeds between statements', (s: string) => s.replace(/\n/g, '\n\f')],
    ['vertical tabs', (s: string) => s.replace(/ int/g, '\vint')],
    ['a zero-width space', (s: string) => s.replace(/TABLE /g, 'TABLE \u200b')],
  ])('%s read as spaces: the grammar reads every table as written, lines stay', (_label, noise) => {
    const result = convert('postgres', noise(base.join('\n')));
    expect(tableNames(result.dbml)).toEqual(['a', 'c']);
    expect(result.readWith?.grammar).toBe(2);
    expect(result.refCount).toBe(1);
    expect(result.problems).toEqual([expect.objectContaining({ line: 2, table: 'b' })]);
  });

  it('a no-break space inside a string is the string\'s own', () => {
    const result = convert('postgres', "CREATE TABLE a (id int);\nCOMMENT ON TABLE a IS 'x\u00a0y';");
    expect(tableBlock(result.dbml, 'a')).toContain('x\u00a0y');
  });

  it('UTF-16 text read as UTF-8 (every other character a NUL) imports', () => {
    const text = Array.from(base.join('\r\n')).map((c) => `${c}\0`).join('');
    const result = convert('postgres', text);
    expect(tableNames(result.dbml)).toEqual(['a', 'c']);
    expect(result.problems).toEqual([expect.objectContaining({ line: 2 })]);
  });
});

// ---------------------------------------------------------------------------
// Names: accents, embedded quotes, keywords
// ---------------------------------------------------------------------------

describe('names', () => {
  it('a renamed table keeps its letters (Über → Uber, straße → strasse, café → cafe), and says so', () => {
    const result = convert('postgres', 'CREATE TABLE "Über" (id int PRIMARY KEY);\nCREATE TABLE straße (id int, u int REFERENCES "Über"(id));\nCREATE TABLE café (id int);');
    expect(tableNames(result.dbml)).toEqual(['Uber', 'strasse', 'cafe']);
    expect(result.refCount).toBe(1);
    expect(result.notes.join('\n')).toMatch(/"Über".*imported as Uber/);
  });

  it.each([
    ['postgres', '"a""b"', '"x""y"', 'x\\"y'],
    ['snowflake', '"a""b"', '"x""y"', 'x\\"y'],
    ['sqlserver', '[a]]b]', '[x]]y]', 'x]y'],
    ['mysql', '`a``b`', '`x``y`', 'x`y'],
  ] as const)('%s: a doubled quote inside a quoted name is one quote, and a link to it resolves', (dialect, table, column, written) => {
    const result = convert(dialect, `CREATE TABLE ${table} (${column} int PRIMARY KEY);\nCREATE TABLE c (id int, r int, FOREIGN KEY (r) REFERENCES ${table}(${column}));`);
    expect(tableBlock(result.dbml, 'a_b')).toContain(`"${written}" int [pk]`);
    expect(result.refCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema context
// ---------------------------------------------------------------------------

describe('schema context', () => {
  it('SET search_path TO DEFAULT and RESET search_path go back to no schema', () => {
    const result = convert('postgres', 'SET search_path TO hr;\nCREATE TABLE a (id int);\nSET search_path TO DEFAULT;\nCREATE TABLE b (id int);\nSET search_path = sales;\nCREATE TABLE c (id int);\nRESET search_path;\nCREATE TABLE d (id int);');
    expect(tableNames(result.dbml)).toEqual(['hr.a', 'b', 'sales.c', 'd']);
  });

  it.each([
    ['one line', 'CREATE SCHEMA hollywood CREATE TABLE films (id int PRIMARY KEY) CREATE TABLE cast_m (id int, film_id int REFERENCES films(id)) CREATE VIEW v AS SELECT 1;\nCREATE TABLE outside (id int);'],
    ['one element per line', 'CREATE SCHEMA hollywood\n  CREATE TABLE films (id int PRIMARY KEY)\n  CREATE TABLE cast_m (id int, film_id int REFERENCES films(id))\n  CREATE VIEW winners AS SELECT 1;\nCREATE TABLE outside (id int);'],
  ])('CREATE SCHEMA s CREATE TABLE … (%s): the elements are tables in s; the next statement is not', (_label, text) => {
    const result = convert('postgres', text);
    expect(tableNames(result.dbml)).toEqual(['hollywood.films', 'hollywood.cast_m', 'outside']);
    expect(result.refCount).toBe(1);
  });

  it('SQL Server CREATE SCHEMA AUTHORIZATION owner CREATE TABLE …: the schema is the owner\'s; a plain CREATE SCHEMA changes nothing', () => {
    expect(tableNames(convert('sqlserver', 'CREATE SCHEMA AUTHORIZATION sales\n  CREATE TABLE orders (id int PRIMARY KEY)\n  GRANT SELECT ON orders TO bob;\nGO\nCREATE TABLE dbo.x (id int);').dbml)).toEqual(['sales.orders', 'dbo.x']);
    expect(tableNames(convert('postgres', 'CREATE SCHEMA s;\nCREATE TABLE a (id int);').dbml)).toEqual(['a']);
    expect(tableNames(convert('sqlserver', 'CREATE SCHEMA Sales\nGO\nCREATE TABLE x (id int);').dbml)).toEqual(['x']);
  });
});

// ---------------------------------------------------------------------------
// Statement boundaries
// ---------------------------------------------------------------------------

describe('statement boundaries', () => {
  it('two CREATE TABLEs on one line without a `;` are two tables (and the start screen counts two)', () => {
    const text = 'CREATE TABLE a (id int PRIMARY KEY) CREATE TABLE b (id int, a_id int REFERENCES a(id))';
    const result = convert('postgres', text);
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(result.refCount).toBe(1);
    expect(countCreateTablesWithColumns(text, 'postgres')).toBe(2);
  });

  it("SQL Server #temp tables are skipped as temporary tables (not 'without a column list')", () => {
    const result = convert('sqlserver', 'CREATE TABLE #tmp (id int);\nCREATE TABLE ##g (id int);\nCREATE TABLE a (id int);');
    expect(tableNames(result.dbml)).toEqual(['a']);
    expect(result.skipped).toEqual(["a.sql: skipped 2 SQL Server temporary tables (#name: a session's scratch tables, not design)"]);
  });

  it("mysqldump's /*!50001 CREATE ALGORITHM=… DEFINER=… VIEW `v` */ is logged as view v", () => {
    const result = convert('mysql', 'CREATE TABLE a (id int);\n/*!50001 CREATE ALGORITHM=UNDEFINED */ /*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ /*!50001 VIEW `v` AS select 1 AS `x` */;');
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'skipped', what: 'view', where: expect.objectContaining({ table: 'v' }) }));
  });
});

// ---------------------------------------------------------------------------
// Hostile input: time and message size
// ---------------------------------------------------------------------------

describe('hostile input', () => {
  it(`parentheses nested past ${MAX_GRAMMAR_PAREN_DEPTH} levels never reach a grammar (seconds to minutes each): read without it, at once, and said`, () => {
    const deep = (n: number) => `${'('.repeat(n)}id${')'.repeat(n)}`;
    const started = Date.now();
    const result = convert('postgres', `CREATE TABLE a (id int PRIMARY KEY CHECK (${deep(3000)} > 0), b_id int REFERENCES b(id));\nCREATE TABLE b (id int PRIMARY KEY);`);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(tableNames(result.dbml)).toEqual(['a', 'b']);
    expect(result.refCount).toBe(1);
    expect(result.readWith).toEqual({ grammar: 1, repaired: 0, salvaged: 1 });
    expect(result.ledger).toContainEqual(expect.objectContaining({ outcome: 'repaired', detail: expect.stringMatching(/nested more than/) }));
  });

  it('a 5,000-character, multi-line or control-character name is never echoed whole', () => {
    const long = 'x'.repeat(5000);
    const texts = [
      `CREATE TABLE "${long}" (id int,, x int);\nCREATE TABLE ok (id int);`,
      `CREATE TABLE "${long}" (id int);\nCREATE TABLE "${long}" (id int);`,
      `CREATE TABLE ok (id int, x int REFERENCES "${long}"(id));`,
      `CREATE TABLE ok (id int);\nCOMMENT ON COLUMN ok.${long} IS 'x';`,
      'CREATE TABLE "a\nb\nc" (id int,, x int);\nCREATE TABLE ok (id int REFERENCES "q\nz"(id));\nCOMMENT ON TABLE "m\nn" IS \'x\';',
      'CREATE TABLE "a\u0007\u001b[31m" (id int,, x int);\nCREATE TABLE ok (id int);',
    ];
    for (const text of texts) {
      const result = sqlDdlToDbml({ dialect: 'postgres', files: [{ name: 'a.sql', text }] });
      for (const line of shown(result)) {
        expect(line.length, line.slice(0, 60)).toBeLessThanOrEqual(240);
        // eslint-disable-next-line no-control-regex
        expect(line).not.toMatch(/[\n\r\u0000-\u0008\u000b-\u001f]/);
        expect(line).not.toMatch(new RegExp(`\\S{${MAX_SHOWN_RUN + 1},}`));
      }
    }
  });

  it("a long file name is the user's file: kept whole in what is shown", () => {
    const name = `${'deep/'.repeat(30)}schema.sql`;
    const result = convert('postgres', [{ name, text: 'CREATE TABLE ok (id int, x int REFERENCES gone(id));' }]);
    expect(result.skipped.join('\n')).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// Trailing table options: every pair, both orders, per dialect
// ---------------------------------------------------------------------------

describe('trailing table options in any order', () => {
  const OPTIONS: Record<SqlDialect, string[]> = {
    databricks: ['USING DELTA', "COMMENT 'tbl'", 'CLUSTER BY (id)', 'PARTITIONED BY (d)', "TBLPROPERTIES ('a' = 'b')", "LOCATION 's3://x/y'", "OPTIONS (path 'x')"],
    snowflake: ["COMMENT = 'tbl'", 'CLUSTER BY (id)', 'DATA_RETENTION_TIME_IN_DAYS = 1', 'CHANGE_TRACKING = TRUE', 'COPY GRANTS', "WITH TAG (a.b.c = 'x')", 'STAGE_FILE_FORMAT = (TYPE = CSV)'],
    mysql: ['ENGINE=InnoDB', 'DEFAULT CHARSET=utf8mb4', 'COLLATE=utf8mb4_bin', "COMMENT='tbl'", 'AUTO_INCREMENT=10', 'ROW_FORMAT=DYNAMIC', 'PARTITION BY HASH (id) PARTITIONS 4'],
    sqlserver: ['ON [PRIMARY]', 'TEXTIMAGE_ON [PRIMARY]', 'WITH (DATA_COMPRESSION = PAGE)', 'FILESTREAM_ON fs'],
    postgres: ['INHERITS (base)', 'TABLESPACE fast', 'WITH (fillfactor=70)', 'PARTITION BY RANGE (d)', 'USING heap'],
  };
  for (const dialect of SQL_DIALECTS) {
    it(`${dialect}: every pair of options, both orders, keeps both tables, the link and the table comment`, () => {
      const opts = OPTIONS[dialect];
      const failures: string[] = [];
      for (const a of opts) {
        for (const b of opts) {
          if (a === b) continue;
          const text = `CREATE TABLE t (id int NOT NULL, d date${dialect === 'databricks' ? '' : ', PRIMARY KEY (id)'})\n${a}\n${b};\nCREATE TABLE u (id int, t_id int REFERENCES t(id));`;
          const r = sqlDdlToDbml({ dialect, files: [{ name: 'a.sql', text }] });
          const comment = /COMMENT/.test(a + b);
          if (!r.ok || r.tableCount !== 2 || r.refCount !== 1 || (comment && !/Note: 'tbl'/.test(r.dbml))) failures.push(`${a} + ${b}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});
