/**
 * sql-fidelity: the SQL DDL converter keeps what the source says, from
 * wherever it says it. One describe per edge-case class, each with the
 * sample case that found it and variants of the same class:
 *
 *  - verbatim type text (the column's own span, not the grammar's name);
 *  - uniqueness from every source (inline, table, named, MySQL KEY,
 *    CREATE UNIQUE INDEX), before or after the FK; what cannot be a key said;
 *  - cardinality: one-to-one when the FK is its table's whole key or exactly
 *    a unique key, checked through Import DBML's own plan;
 *  - every item of an ALTER TABLE action list, and what each other action is;
 *  - constraint replay in file order (by name, by generated name, IF EXISTS,
 *    DROP PRIMARY KEY / FOREIGN KEY / INDEX, re-add, RENAME CONSTRAINT);
 *  - the schema context (USE, USE SCHEMA, SET search_path), per file;
 *  - DDL in procedural blocks at its true lines; dynamic SQL reported;
 *  - descriptions (COMMENT ON, sp_addextendedproperty) and FK actions;
 *  - what DBML cannot say: counted in the ledger or the skipped line.
 */
import { describe, expect, it } from 'vitest';
import { convertSqlDdl, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlDialect } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { readDbml } from '../../src/services/dbmlImportParse';
import { planDbmlImport, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { ledgerLeftOut, ledgerNotes, type LedgerEntry } from '../../src/services/importLedger';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(dialect: SqlDialect, input: string | SqlDdlFile[]): Converted {
  const files = typeof input === 'string' ? [{ name: 'schema.sql', text: input }] : input;
  const result = convertSqlDdl({ files, dialect }, dbmlCoreSqlEngine);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.problems)}`);
  expect(result.problems).toEqual([]);
  return result;
}

function plan(dbml: string): DbmlImportPlan {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error(`Import DBML rejected the output: ${JSON.stringify(read.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: read.model,
    layer: 'gold',
    subjectAreaName: 'fidelity',
    fileName: 'schema.sql',
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true,
  });
}

/** Each relationship Import plans, `from(cols)>to cardinality`, composites once. */
function links(dbml: string): string[] {
  const groups = new Map<string, DbmlImportPlan['relationships']>();
  for (const r of plan(dbml).relationships) {
    const key = r.compositeKey ? `${r.fromModel}:${r.compositeKey}` : `${r.fromModel}.${r.fromColumn}>${r.toModel}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rs) => `${rs[0].fromModel}(${rs.map((r) => r.fromColumn).join(',')})>${rs[0].toModel} ${rs[0].cardinality}`).sort();
}

/** A column's type as Import DBML reads it (DBML itself writes a type's arguments without spaces: `numeric(10,2)`). */
function typeOf(dbml: string, table: string, column: string): string | undefined {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error('unreadable DBML');
  return read.model.tables.find((t) => t.name === table)?.fields.find((f) => f.name === column)?.type;
}

/** A type with its arguments' spacing as DBML reads it. */
const dbmlArgs = (type: string): string => type.replace(/\s*,\s*/g, ',');

/** The unique keys Import DBML reads, `table(cols)`, the primary keys aside. */
function uniques(dbml: string): string[] {
  const read = readDbml(dbml);
  if (!read.ok) throw new Error('unreadable DBML');
  return read.model.tables.flatMap((t) => [
    ...t.fields.filter((f) => f.unique && !f.pk).map((f) => `${t.name}(${f.name})`),
    ...t.indexes.filter((ix) => ix.unique && !ix.pk).map((ix) => `${t.name}(${ix.columns.map((c) => c.value).join(',')})`),
  ]).sort();
}

const entries = (r: Converted, what: string | RegExp): LedgerEntry[] =>
  r.ledger.filter((e) => (typeof what === 'string' ? e.what === what : what.test(e.what)));

// ---------------------------------------------------------------------------

describe('verbatim type text', () => {
  it.each([
    ['postgres', 'timestamp with time zone'], ['postgres', 'TIMESTAMP WITH TIME ZONE'], ['postgres', 'timestamptz'],
    ['postgres', 'time(3) without time zone'], ['postgres', 'public.vector(20)'], ['postgres', 'vector(20)'],
    ['postgres', 'character varying(255)'], ['postgres', 'double precision'], ['postgres', 'public.citext'],
    ['postgres', 'text[]'], ['postgres', 'int ARRAY'], ['postgres', 'numeric(10, 2)'], ['postgres', 'public.year'],
    ['mysql', 'int unsigned'], ['mysql', 'int unsigned zerofill'], ['mysql', 'SMALLINT UNSIGNED'], ['mysql', 'decimal(10,2) unsigned'],
    ['sqlserver', 'nvarchar(max)'], ['sqlserver', 'datetimeoffset(7)'], ['sqlserver', 'decimal(18, 2)'],
    ['snowflake', 'TIMESTAMP_TZ(9)'], ['snowflake', 'NUMBER(38,0)'],
  ] as const)('%s keeps %s as written (case and details)', (dialect, type) => {
    const r = convert(dialect, `CREATE TABLE t (id int PRIMARY KEY, c ${type} NOT NULL);`);
    expect(typeOf(r.dbml, 't', 'c')).toBe(dbmlArgs(type));
    // The converter writes it exactly as the file did.
    expect(r.dbml).toMatch(new RegExp(`"c" "?${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"? \\[not null\\]`));
  });

  it('spacing is collapsed, never the words: numeric( 10 , 2 ) and a type over two lines', () => {
    const r = convert('postgres', 'CREATE TABLE t (a numeric( 10 , 2 ), b timestamp\n    with time zone, c double   precision);');
    expect(r.dbml).toContain('"a" numeric(10, 2)');
    expect(typeOf(r.dbml, 't', 'b')).toBe('timestamp with time zone');
    expect(typeOf(r.dbml, 't', 'c')).toBe('double precision');
  });

  it('SQL Server: brackets come off the names, never the details ([decimal](18, 2), [dbo].[Name], nvarchar(max))', () => {
    const r = convert('sqlserver', 'CREATE TABLE [dbo].[t] ([a] [decimal](18, 2) NULL, [b] [dbo].[Name] NOT NULL, [c] [nvarchar](max) NULL, [d] [int] IDENTITY(1,1) NOT NULL)');
    expect(r.dbml).toContain('"a" decimal(18, 2)');
    expect(typeOf(r.dbml, 't', 'b')).toBe('dbo.Name');
    expect(typeOf(r.dbml, 't', 'c')).toBe('nvarchar(max)');
    expect(typeOf(r.dbml, 't', 'd')).toBe('int');
    expect(r.dbml).toMatch(/"d" int \[[^\]]*increment/);
  });

  it('ALTER TABLE ADD COLUMN keeps its type as written too (Harbor role.created_at)', () => {
    const r = convert('postgres', 'CREATE TABLE role (id int PRIMARY KEY);\nALTER TABLE role ADD COLUMN created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now();');
    expect(typeOf(r.dbml, 'role', 'created_at')).toBe('TIMESTAMP WITH TIME ZONE');
  });

  it('a column named like a constraint word still has its type (pagila film.fulltext tsvector)', () => {
    const r = convert('postgres', 'CREATE TABLE film (id int PRIMARY KEY, fulltext tsvector NOT NULL, key varchar(10));');
    expect(typeOf(r.dbml, 'film', 'fulltext')).toBe('tsvector');
    expect(typeOf(r.dbml, 'film', 'key')).toBe('varchar(10)');
  });

  it('an inline MySQL ENUM keeps the grammar\'s enum (its values stay structured)', () => {
    const r = convert('mysql', "CREATE TABLE film (id int PRIMARY KEY, rating ENUM('G','PG') DEFAULT 'G');");
    expect(r.dbml).toMatch(/^Enum "film_rating_enum"/m);
    expect(typeOf(r.dbml, 'film', 'rating')).toBe('film_rating_enum');
  });

  it('DEFAULT NULL is not written as a default (sakila original_language_id)', () => {
    const r = convert('mysql', 'CREATE TABLE t (id int PRIMARY KEY, a tinyint unsigned DEFAULT NULL, b int DEFAULT 3, c varchar(3) DEFAULT \'NULL\');');
    expect(r.dbml).toMatch(/"a" "tinyint unsigned"\n/);
    expect(r.dbml).toContain('"b" int [default: 3]');
    expect(r.dbml).toContain('"c" varchar(3) [default: \'NULL\']');
  });
});

describe('uniqueness from every source', () => {
  const table = 'CREATE TABLE t (id int PRIMARY KEY, a int, b int, c int';
  it.each([
    ['inline UNIQUE', 'postgres', `${table} UNIQUE, d int);`, ['t(c)']],
    ['UNIQUE (a, b)', 'postgres', `${table}, UNIQUE (a, b));`, ['t(a,b)']],
    ['CONSTRAINT x UNIQUE', 'postgres', `${table}, CONSTRAINT uq_c UNIQUE (c));`, ['t(c)']],
    ['MySQL UNIQUE KEY', 'mysql', `${table}, UNIQUE KEY uq_c (c));`, ['t(c)']],
    ['MySQL UNIQUE INDEX', 'mysql', `${table}, UNIQUE INDEX uq_ab (a, b));`, ['t(a,b)']],
    ['ALTER TABLE ADD UNIQUE', 'postgres', `${table});\nALTER TABLE t ADD CONSTRAINT uq_ab UNIQUE (a, b);`, ['t(a,b)']],
    ['CREATE UNIQUE INDEX', 'postgres', `${table});\nCREATE UNIQUE INDEX uq_c ON t USING btree (c);`, ['t(c)']],
    ['CREATE UNIQUE INDEX IF NOT EXISTS, CONCURRENTLY', 'postgres', `${table});\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_ab ON ONLY t (a, b DESC);`, ['t(a,b)']],
    ['CREATE UNIQUE NONCLUSTERED INDEX … INCLUDE', 'sqlserver', `${table});\nCREATE UNIQUE NONCLUSTERED INDEX [AK_t] ON [dbo].[t] ([a], [b]) INCLUDE ([c]) WITH (FILLFACTOR = 80) ON [PRIMARY];`, ['t(a,b)']],
    ['CREATE UNIQUE CLUSTERED INDEX', 'sqlserver', `${table});\nCREATE UNIQUE CLUSTERED INDEX AK_c ON t (c);`, ['t(c)']],
  ] as const)('%s', (_label, dialect, sql, want) => {
    expect(uniques(convert(dialect, sql).dbml)).toEqual(want);
  });

  it('an expression or partial unique index is reported by name, never kept (Harbor uq_role_name)', () => {
    const r = convert('postgres', `${table});\nCREATE UNIQUE INDEX uq_lower ON t (lower(a::text));\nCREATE UNIQUE INDEX uq_live ON t (b) WHERE c IS NULL;\nCREATE UNIQUE INDEX AK_x ON t ((a + b));`);
    expect(uniques(r.dbml)).toEqual([]);
    expect(entries(r, 'expression unique index').map((e) => e.where?.column).sort()).toEqual(['AK_x', 'uq_lower']);
    expect(entries(r, 'partial unique index').map((e) => e.where?.column)).toEqual(['uq_live']);
    expect(ledgerLeftOut(r.ledger).join('\n')).toMatch(/2 unique keys: expression unique index not kept/);
  });

  it('a SQL Server filtered unique index (WHERE … IS NOT NULL) is partial: reported', () => {
    const r = convert('sqlserver', 'CREATE TABLE t (id int PRIMARY KEY, a int NULL);\nCREATE UNIQUE INDEX AK_a ON t (a) WHERE a IS NOT NULL;');
    expect(uniques(r.dbml)).toEqual([]);
    expect(entries(r, 'partial unique index')).toHaveLength(1);
  });

  it('a unique index on a view is not a key (pagila rental_by_category): counted as an index', () => {
    const r = convert('postgres', `${table});\nCREATE MATERIALIZED VIEW mv AS SELECT a FROM t;\nCREATE UNIQUE INDEX uq_mv ON mv (a);`);
    expect(uniques(r.dbml)).toEqual([]);
    expect(r.skipped.join('\n')).toMatch(/1 index/);
    expect(r.skipped.join('\n')).not.toMatch(/key on mv/);
  });

  it('a unique key over the primary key (or written twice) is written once', () => {
    const r = convert('postgres', 'CREATE TABLE t (a int, b int, PRIMARY KEY (a, b));\nCREATE UNIQUE INDEX x ON t (a, b);\nCREATE UNIQUE INDEX y ON t (b, a);');
    expect(r.dbml).not.toMatch(/\[unique\]/);
  });
});

describe('cardinality: one-to-one when the FK is its table\'s whole key or exactly a unique key', () => {
  const parent = 'CREATE TABLE p (id int PRIMARY KEY, code int UNIQUE);\n';
  it.each([
    ['FK = whole PK (pagila film_embedding)', `${parent}CREATE TABLE c (p_id int PRIMARY KEY REFERENCES p (id), v int);`, 'c(p_id)>p one-to-one'],
    ['FK exactly a unique column (sakila store.manager_staff_id)', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_id int NOT NULL UNIQUE REFERENCES p (id));`, 'c(p_id)>p one-to-one'],
    ['nullable unique FK', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_id int UNIQUE REFERENCES p (id));`, 'c(p_id)>p one-to-one'],
    ['plain FK', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_id int REFERENCES p (id));`, 'c(p_id)>p many-to-one'],
    ['FK part of the PK (partial overlap)', `${parent}CREATE TABLE c (p_id int REFERENCES p (id), n int, PRIMARY KEY (p_id, n));`, 'c(p_id)>p many-to-one'],
    ['unique declared after the FK', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_id int REFERENCES p (id));\nCREATE UNIQUE INDEX ux ON c (p_id);`, 'c(p_id)>p one-to-one'],
    ['unique declared before the FK (ALTER)', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_id int);\nALTER TABLE c ADD CONSTRAINT ux UNIQUE (p_id);\nALTER TABLE c ADD CONSTRAINT fk FOREIGN KEY (p_id) REFERENCES p (id);`, 'c(p_id)>p one-to-one'],
    ['FK to a unique non-key column, itself unique', `${parent}CREATE TABLE c (id int PRIMARY KEY, p_code int UNIQUE REFERENCES p (code));`, 'c(p_code)>p one-to-one'],
  ])('%s', (_label, sql, want) => {
    expect(links(convert('postgres', sql).dbml)).toEqual([want]);
  });

  it('a composite FK that is its table\'s whole composite key is one one-to-one link (pagila / AdventureWorks)', () => {
    const r = convert('postgres', 'CREATE TABLE l (o int, n int, PRIMARY KEY (o, n));\nCREATE TABLE s (o int, n int, at date, PRIMARY KEY (o, n), FOREIGN KEY (o, n) REFERENCES l (o, n));');
    expect(links(r.dbml)).toEqual(['s(o,n)>l one-to-one']);
  });

  it('a composite FK exactly a composite unique key is one-to-one; one column of it is not', () => {
    const r = convert('postgres', 'CREATE TABLE l (o int, n int, PRIMARY KEY (o, n));\nCREATE TABLE s (id int PRIMARY KEY, o int, n int, UNIQUE (o, n), FOREIGN KEY (o, n) REFERENCES l (o, n));\nCREATE TABLE u (id int PRIMARY KEY, o int, n int, UNIQUE (o), FOREIGN KEY (o, n) REFERENCES l (o, n));');
    expect(links(r.dbml)).toEqual(['s(o,n)>l one-to-one', 'u(o,n)>l many-to-one']);
  });

  it('a self-reference through a unique column is one-to-one (a mentor per employee)', () => {
    const r = convert('postgres', 'CREATE TABLE emp (id int PRIMARY KEY, mentor_id int UNIQUE REFERENCES emp (id));');
    expect(links(r.dbml)).toEqual(['emp(mentor_id)>emp one-to-one']);
  });

  it('an FK that is its table\'s key but references a non-key cannot be written from the FK side: many-to-one, and said', () => {
    const r = convert('postgres', 'CREATE TABLE p (id int PRIMARY KEY, code int UNIQUE);\nCREATE TABLE c (code int PRIMARY KEY REFERENCES p (code));');
    expect(links(r.dbml)).toEqual(['c(code)>p many-to-one']);
    expect(entries(r, 'one-to-one link')).toHaveLength(1);
  });

  it('SQL Server and MySQL one-to-ones read the same way (AdventureWorks Employee → Person; sakila store)', () => {
    const ss = convert('sqlserver', 'CREATE TABLE [Person].[Person] ([BusinessEntityID] int NOT NULL, CONSTRAINT [PK_Person] PRIMARY KEY CLUSTERED ([BusinessEntityID]))\nGO\nCREATE TABLE [HumanResources].[Employee] ([BusinessEntityID] int NOT NULL, CONSTRAINT [PK_Employee] PRIMARY KEY CLUSTERED ([BusinessEntityID]))\nGO\nALTER TABLE [HumanResources].[Employee] ADD CONSTRAINT [FK_Employee_Person] FOREIGN KEY ([BusinessEntityID]) REFERENCES [Person].[Person]([BusinessEntityID])\nGO');
    expect(links(ss.dbml)).toEqual(['Employee(BusinessEntityID)>Person one-to-one']);
    const my = convert('mysql', 'CREATE TABLE staff (staff_id tinyint unsigned NOT NULL, PRIMARY KEY (staff_id));\nCREATE TABLE store (store_id tinyint unsigned NOT NULL, manager_staff_id tinyint unsigned NOT NULL, PRIMARY KEY (store_id), UNIQUE KEY idx_unique_manager (manager_staff_id), CONSTRAINT fk_store_staff FOREIGN KEY (manager_staff_id) REFERENCES staff (staff_id));');
    expect(links(my.dbml)).toEqual(['store(manager_staff_id)>staff one-to-one']);
  });
});

describe('ALTER TABLE action lists: every item', () => {
  const tables = 'CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE q (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY, p_id int, q_id int, r_id int);\n';

  it('SQL Server: ADD CONSTRAINT a …, CONSTRAINT b … (AdventureWorks BillOfMaterials), with WITH CHECK / NOCHECK', () => {
    for (const check of ['', ' WITH CHECK', ' WITH NOCHECK']) {
      const r = convert('sqlserver', `${tables}GO\nALTER TABLE c${check} ADD\n  CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id),\n  CONSTRAINT fk_q FOREIGN KEY\n  (\n    q_id\n  ) REFERENCES q(\n    id\n  ),\n  CONSTRAINT fk_r FOREIGN KEY (r_id) REFERENCES c (id)\nGO\nALTER TABLE c CHECK CONSTRAINT fk_p\nGO`);
      expect(r.refCount, check).toBe(3);
      expect(r.skipped.join('\n'), check).not.toMatch(/ALTER TABLE/);
    }
  });

  it('PostgreSQL: ADD …, ADD … in one statement, ONLY and IF EXISTS', () => {
    const r = convert('postgres', `${tables}ALTER TABLE ONLY c ADD CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id), ADD CONSTRAINT fk_q FOREIGN KEY (q_id) REFERENCES q (id);\nALTER TABLE IF EXISTS ONLY c ADD FOREIGN KEY (r_id) REFERENCES c (id);`);
    expect(r.refCount).toBe(3);
  });

  it('a composite FK in a list is one link (AdventureWorks SpecialOfferProduct)', () => {
    const r = convert('sqlserver', 'CREATE TABLE l (o int, n int, CONSTRAINT pk_l PRIMARY KEY (o, n))\nGO\nCREATE TABLE s (id int PRIMARY KEY, o int, n int, x int)\nGO\nALTER TABLE s ADD CONSTRAINT fk_x FOREIGN KEY (x) REFERENCES s (id), CONSTRAINT fk_l FOREIGN KEY (o, n) REFERENCES l (o, n)\nGO');
    expect(links(r.dbml)).toEqual(['s(o,n)>l many-to-one', 's(x)>s many-to-one']);
  });

  it('MySQL: ADD COLUMN, ADD KEY and DROP in one statement; ADD after a column continues the list', () => {
    const r = convert('mysql', `${tables}ALTER TABLE c ADD COLUMN note text AFTER id, ADD KEY ix_note (note(10)), ADD CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id), DROP COLUMN r_id;`);
    expect(r.dbml).toContain('"note" text');
    expect(r.dbml).not.toContain('"r_id"');
    expect(r.refCount).toBe(1);
    expect(r.skipped.join('\n')).toMatch(/1 non-unique index inside a table/);
  });

  it('ADD [CONSTRAINT x] CHECK (…) is a table check, even before its table (Databricks relationships.sql)', () => {
    const r = convert('databricks', [
      { name: 'a_relationships.sql', text: 'ALTER TABLE s.c ADD CONSTRAINT chk_status CHECK (status IN (\'open\', \'closed\'));\nALTER TABLE s.c ADD CHECK (amount >= 0);' },
      { name: 'b_tables.sql', text: 'CREATE TABLE s.c (id BIGINT, status STRING, amount DECIMAL(10,2));' },
    ]);
    expect(r.dbml).toMatch(/checks \{\n\s+`status IN \('open', 'closed'\)` \[name: 'chk_status'\]\n\s+`amount >= 0`\n\s+\}/);
    expect(r.skipped.join('\n')).not.toMatch(/a_relationships\.sql/);
  });

  it('each other action is labelled for what it is, never "other than a key"', () => {
    const r = convert('postgres', [
      { name: 'a.sql', text: 'CREATE TABLE payment (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE payment_p1 (id int, at date);\nALTER TABLE payment OWNER TO app;\nALTER TABLE ONLY payment ATTACH PARTITION payment_p1 FOR VALUES FROM (\'2022-01-01\') TO (\'2022-02-01\');\nALTER TABLE payment ENABLE ROW LEVEL SECURITY;\nALTER TABLE payment ALTER COLUMN at SET STATISTICS 100;\nALTER TABLE payment DETACH PARTITION payment_p1;' },
      { name: 'b.sql', text: 'ALTER TABLE payment SET TAGS (\'a\' = \'b\');' },
    ]);
    const skipped = r.skipped.join('\n');
    expect(skipped).toMatch(/1 ALTER TABLE … OWNER TO/);
    expect(skipped).toMatch(/a\.sql: .*2 ALTER TABLE settings/);
    expect(skipped).toMatch(/b\.sql: skipped 1 ALTER TABLE setting \(/);
    expect(skipped).toMatch(/1 ATTACH \/ DETACH PARTITION/);
    expect(skipped).not.toMatch(/other than a key/);
  });

  it('ALTER COLUMN … SET / DROP DEFAULT and SQL Server ADD DEFAULT … FOR change the default', () => {
    const pg = convert('postgres', 'CREATE TABLE t (id int, n int, s text DEFAULT \'x\');\nALTER TABLE ONLY t ALTER COLUMN id SET DEFAULT nextval(\'t_id_seq\'::regclass);\nALTER TABLE t ALTER COLUMN n SET DEFAULT 0;\nALTER TABLE t ALTER COLUMN s DROP DEFAULT;');
    expect(pg.dbml).toContain('"id" int [default: `nextval(\'t_id_seq\'::regclass)`]');
    expect(pg.dbml).toContain('"n" int [default: 0]');
    expect(pg.dbml).toMatch(/"s" text\n/);
    const ss = convert('sqlserver', 'CREATE TABLE t (id int, at datetime NOT NULL)\nGO\nALTER TABLE t ADD CONSTRAINT DF_t_at DEFAULT (getdate()) FOR at\nGO');
    expect(ss.dbml).toContain('"at" datetime [not null, default: `getdate()`]');
  });
});

describe('constraint replay, in file order', () => {
  const pg = (...statements: string[]): Converted => convert('postgres', [
    { name: '001_init.sql', text: 'CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int, p_id int REFERENCES p (id), a int, b int, CONSTRAINT c_pk PRIMARY KEY (id), CONSTRAINT uq_ab UNIQUE (a, b), UNIQUE (a));' },
    { name: '002_change.sql', text: statements.join('\n') },
  ]);

  it('DROP CONSTRAINT by PostgreSQL\'s generated name: t_col_fkey, t_col_key (Harbor artifact_accessory)', () => {
    const r = pg('ALTER TABLE c DROP CONSTRAINT c_p_id_fkey;', 'ALTER TABLE c DROP CONSTRAINT IF EXISTS c_a_key;');
    expect(r.refCount).toBe(0);
    expect(uniques(r.dbml)).toEqual(['c(a,b)']);
  });

  it('DROP CONSTRAINT by the name written (Harbor unique_project_id), and t_pkey', () => {
    const r = pg('ALTER TABLE c DROP CONSTRAINT uq_ab;', 'ALTER TABLE p DROP CONSTRAINT p_pkey;');
    expect(uniques(r.dbml)).toEqual(['c(a)']);
    expect(r.dbml).toMatch(/Table "p" \{\n\s+"id" int\n\}/);
  });

  it('IF EXISTS of a name never given drops nothing, silently; without IF EXISTS it is said', () => {
    const r = pg('ALTER TABLE c DROP CONSTRAINT IF EXISTS never_was;', 'ALTER TABLE c DROP CONSTRAINT also_never;');
    expect(r.refCount).toBe(1);
    expect(r.skipped.filter((l) => /never_was/.test(l))).toEqual([]);
    expect(r.skipped.some((l) => /002_change\.sql line 2: constraint also_never dropped from c/.test(l))).toBe(true);
  });

  it('re-added after the drop: the new definition stands (Harbor unique_artifact_accessory)', () => {
    const r = pg('ALTER TABLE c DROP CONSTRAINT uq_ab;', 'ALTER TABLE c ADD CONSTRAINT uq_ab UNIQUE (b);', 'ALTER TABLE c DROP CONSTRAINT c_p_id_fkey;', 'ALTER TABLE c ADD CONSTRAINT fk_again FOREIGN KEY (b) REFERENCES p (id);');
    expect(uniques(r.dbml)).toEqual(['c(a)', 'c(b)']);
    expect(links(r.dbml)).toEqual(['c(b)>p one-to-one']);
  });

  it('RENAME CONSTRAINT: the new name is the one a later DROP uses (written and generated names)', () => {
    const r = pg('ALTER TABLE c RENAME CONSTRAINT uq_ab TO uq_ab2;', 'ALTER TABLE c RENAME CONSTRAINT c_p_id_fkey TO fk_c_p;', 'ALTER TABLE c DROP CONSTRAINT uq_ab2;', 'ALTER TABLE c DROP CONSTRAINT fk_c_p;');
    expect(uniques(r.dbml)).toEqual(['c(a)']);
    expect(r.refCount).toBe(0);
  });

  it('MySQL: DROP FOREIGN KEY, DROP INDEX of a unique key, DROP PRIMARY KEY, and t_ibfk_N', () => {
    const r = convert('mysql', [
      { name: 'V1__init.sql', text: 'CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int NOT NULL, p_id int, q_id int, e varchar(9), PRIMARY KEY (id), UNIQUE KEY uq_e (e), CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id), FOREIGN KEY (q_id) REFERENCES p (id));' },
      { name: 'V2__drop.sql', text: 'ALTER TABLE c DROP FOREIGN KEY fk_p, DROP INDEX uq_e;\nALTER TABLE c DROP FOREIGN KEY c_ibfk_1;\nALTER TABLE c DROP PRIMARY KEY;' },
    ]);
    expect(r.refCount).toBe(0);
    expect(uniques(r.dbml)).toEqual([]);
    expect(r.dbml).toMatch(/"id" int \[not null\]/);
  });

  it('DROP INDEX of a unique index, across files (migration order)', () => {
    const r = convert('postgres', [
      { name: '001.sql', text: 'CREATE TABLE job_log (id int PRIMARY KEY, job_uuid text);\nCREATE UNIQUE INDEX job_log_uuid ON job_log (job_uuid);' },
      { name: '002.sql', text: 'DROP INDEX IF EXISTS job_log_uuid;' },
      { name: '003.sql', text: 'CREATE UNIQUE INDEX job_log_uuid2 ON job_log (job_uuid);' },
    ]);
    expect(uniques(r.dbml)).toEqual(['job_log(job_uuid)']);
    expect(r.skipped.join('\n')).not.toMatch(/002\.sql/);
  });

  it('SQL Server: DROP CONSTRAINT a, b in one statement', () => {
    const r = convert('sqlserver', 'CREATE TABLE p (id int PRIMARY KEY)\nGO\nCREATE TABLE c (id int PRIMARY KEY, p_id int, CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id), CONSTRAINT uq_p UNIQUE (p_id))\nGO\nALTER TABLE c DROP CONSTRAINT fk_p, uq_p\nGO');
    expect(r.refCount).toBe(0);
    expect(uniques(r.dbml)).toEqual([]);
  });

  it('the applied drops count as later schema changes', () => {
    expect(pg('ALTER TABLE c DROP CONSTRAINT uq_ab;').notes.join('\n')).toMatch(/1 later schema change was applied/);
  });
});

describe('the schema context', () => {
  it('MySQL USE db: unqualified tables and references are in it (sakila)', () => {
    const r = convert('mysql', 'CREATE DATABASE sakila;\nUSE sakila;\nCREATE TABLE a (id int PRIMARY KEY);\nCREATE TABLE b (id int PRIMARY KEY, a_id int, FOREIGN KEY (a_id) REFERENCES a (id));');
    expect(r.dbml).toContain('Table "sakila"."a"');
    expect(r.dbml).toContain('Ref: "sakila"."b"."a_id" > "sakila"."a"."id"');
  });

  it('Snowflake USE SCHEMA, USE db.s, and a reference to another schema (grid RAW.ASSET_MASTER)', () => {
    const r = convert('snowflake', 'USE DATABASE grid;\nUSE SCHEMA RAW;\nCREATE TABLE ASSET (ASSET_ID VARCHAR(50) PRIMARY KEY);\nUSE SCHEMA ML;\nCREATE TABLE MODEL (ID INT PRIMARY KEY, ASSET_ID VARCHAR(50), FOREIGN KEY (ASSET_ID) REFERENCES RAW.ASSET (ASSET_ID));\nUSE grid.STAGING;\nCREATE TABLE STG (ID INT, MODEL_ID INT, FOREIGN KEY (MODEL_ID) REFERENCES ML.MODEL (ID));');
    expect(r.dbml).toContain('Table "RAW"."ASSET"');
    expect(r.dbml).toContain('Table "ML"."MODEL"');
    expect(r.dbml).toContain('Table "STAGING"."STG"');
    expect(r.refCount).toBe(2);
  });

  it('PostgreSQL SET search_path TO s, public and SET SCHEMA; pg_dump\'s set_config(\'search_path\', \'\') resets it', () => {
    const r = convert('postgres', 'SET search_path TO app, public;\nCREATE TABLE a (id int PRIMARY KEY);\nSET SCHEMA \'audit\';\nCREATE TABLE b (id int PRIMARY KEY, a_id int REFERENCES app.a (id));\nSELECT pg_catalog.set_config(\'search_path\', \'\', false);\nCREATE TABLE c (id int);\nSET search_path = "$user", hr;\nCREATE TABLE d (id int);');
    expect(r.dbml).toContain('Table "app"."a"');
    expect(r.dbml).toContain('Table "audit"."b"');
    expect(r.dbml).toMatch(/^Table "c" \{/m);
    expect(r.dbml).toContain('Table "hr"."d"');
    expect(r.refCount).toBe(1);
  });

  it('the dialect\'s default schema is no schema (USE SCHEMA PUBLIC, search_path public)', () => {
    expect(convert('snowflake', 'USE SCHEMA PUBLIC;\nCREATE TABLE a (id int);').dbml).toMatch(/^Table "a" \{/m);
    expect(convert('postgres', 'SET search_path TO public;\nCREATE TABLE a (id int);').dbml).toMatch(/^Table "a" \{/m);
  });

  it('SQL Server USE db picks a database, never a schema', () => {
    expect(convert('sqlserver', 'USE [AdventureWorks]\nGO\nCREATE TABLE a (id int)\nGO').dbml).toMatch(/^Table "a" \{/m);
  });

  it('each file starts in the default schema; a reference resolves in its own file\'s context', () => {
    const r = convert('mysql', [
      { name: '1.sql', text: 'USE shop;\nCREATE TABLE a (id int PRIMARY KEY);' },
      { name: '2.sql', text: 'CREATE TABLE b (id int PRIMARY KEY);\nUSE shop;\nCREATE TABLE c (id int PRIMARY KEY, a_id int, FOREIGN KEY (a_id) REFERENCES a (id));' },
    ]);
    expect(r.dbml).toContain('Table "shop"."a"');
    expect(r.dbml).toMatch(/^Table "b" \{/m);
    expect(r.dbml).toContain('Ref: "shop"."c"."a_id" > "shop"."a"."id"');
  });
});

describe('DDL in procedural blocks', () => {
  it('DO $$ … $$ with IF NOT EXISTS (SELECT …) THEN ALTER …: the FK is kept (Harbor fk_project_member_role)', () => {
    const r = convert('postgres', 'CREATE TABLE role (role_id int PRIMARY KEY);\nCREATE TABLE project_member (id int PRIMARY KEY, role int);\nDO $$\nBEGIN\n    IF NOT EXISTS (\n        SELECT 1 FROM pg_constraint WHERE conname = \'fk_project_member_role\'\n    ) THEN\n        ALTER TABLE project_member\n            ADD CONSTRAINT fk_project_member_role\n            FOREIGN KEY (role) REFERENCES role (role_id) ON DELETE RESTRICT;\n    END IF;\nEND $$;');
    expect(r.dbml).toContain('Ref: "project_member"."role" > "role"."role_id" [delete: restrict]');
  });

  it('a $tag$ body, several statements, and the true line of each (a change to a missing table is said at its line)', () => {
    const r = convert('postgres', 'CREATE TABLE t (id int PRIMARY KEY, a int);\n\nDO $body$\nBEGIN\n  ALTER TABLE t ADD CONSTRAINT uq_a UNIQUE (a);\n  ALTER TABLE missing ADD COLUMN x int;\nEND\n$body$;');
    expect(uniques(r.dbml)).toEqual(['t(a)']);
    expect(r.skipped.some((l) => /^schema\.sql line 6: a column added on missing/.test(l))).toBe(true);
  });

  it('a DO block of data only is counted as a block, and its UPDATEs never read as DDL', () => {
    const r = convert('postgres', 'CREATE TABLE t (id int PRIMARY KEY, n text);\nDO $$\nBEGIN\n  WHILE EXISTS (SELECT 1) LOOP\n    UPDATE t SET n = \'x\';\n  END LOOP;\nEND $$;');
    expect(r.skipped.join('\n')).toMatch(/1 procedural block \(DO, IF … BEGIN\) with no schema change in it/);
  });

  it('SQL Server IF NOT EXISTS (…) BEGIN … END, on one line or over several', () => {
    const r = convert('sqlserver', 'CREATE TABLE p (id int PRIMARY KEY)\nGO\nCREATE TABLE c (id int PRIMARY KEY, p_id int, q_id int)\nGO\nIF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = N\'fk_p\') BEGIN ALTER TABLE c ADD CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id) END\nGO\nIF OBJECT_ID(N\'fk_q\') IS NULL\nBEGIN\n    ALTER TABLE c ADD CONSTRAINT fk_q FOREIGN KEY (q_id) REFERENCES p (id);\nEND\nGO');
    expect(r.refCount).toBe(2);
    expect(r.skipped.join('\n')).not.toMatch(/session/);
  });

  it('Snowflake EXECUTE IMMEDIATE $$ … $$ is read; EXECUTE \'dynamic DDL\' is reported, not run', () => {
    const sf = convert('snowflake', 'CREATE TABLE t (id INT);\nEXECUTE IMMEDIATE $$\nBEGIN\n  ALTER TABLE t ADD COLUMN extra INT;\nEND;\n$$;');
    expect(sf.dbml).toContain('"extra" INT');
    const pg = convert('postgres', 'CREATE TABLE t (id int);\nDO $$\nBEGIN\n  EXECUTE \'ALTER TABLE t ADD COLUMN y int\';\n  EXECUTE format(\'ALTER TABLE %I ADD COLUMN z int\', \'t\');\nEND $$;');
    expect(pg.dbml).not.toMatch(/"y"|"z"/);
    expect(entries(pg, 'dynamic DDL')).toHaveLength(2);
    expect(ledgerLeftOut(pg.ledger).join('\n')).toMatch(/2 statements: dynamic DDL not run/);
  });

  it('a routine\'s body is never imported (a CREATE TABLE in a function or procedure)', () => {
    const r = convert('postgres', 'CREATE TABLE t (id int);\nCREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  CREATE TEMPORARY TABLE tmp_x (id int);\n  ALTER TABLE t ADD COLUMN q int;\nEND;\n$$ LANGUAGE plpgsql;');
    expect(r.tableCount).toBe(1);
    expect(r.dbml).not.toMatch(/tmp_x|"q"/);
  });
});

describe('descriptions and FK actions', () => {
  it('sp_addextendedproperty with bracketed level names, N\'…\' and named @level arguments; sp_updateextendedproperty', () => {
    const r = convert('sqlserver', 'CREATE TABLE [Person].[Address] ([AddressID] int NOT NULL PRIMARY KEY, [City] nvarchar(30) NULL)\nGO\n'
      + 'EXECUTE [sys].[sp_addextendedproperty] N\'MS_Description\', N\'Street address information.\', N\'SCHEMA\', [Person], N\'TABLE\', [Address], NULL, NULL;\n'
      + 'EXEC sys.sp_addextendedproperty @name = N\'MS_Description\', @value = N\'Primary key for Address records.\', @level0type = N\'SCHEMA\', @level0name = N\'Person\', @level1type = N\'TABLE\', @level1name = N\'Address\', @level2type = N\'COLUMN\', @level2name = N\'AddressID\';\n'
      + 'EXEC sp_addextendedproperty \'MS_Description\', \'Name of the city.\', \'SCHEMA\', Person, \'TABLE\', Address, \'COLUMN\', City;\n'
      + 'EXEC sp_updateextendedproperty N\'MS_Description\', N\'Name of the city; as written "here".\', N\'SCHEMA\', [Person], N\'TABLE\', [Address], N\'COLUMN\', [City];\n'
      + 'EXECUTE [sys].[sp_addextendedproperty] N\'MS_Description\', N\'Index desc.\', N\'SCHEMA\', [Person], N\'TABLE\', [Address], N\'INDEX\', [PK_Address];\nGO');
    const t = plan(r.dbml).newTables.find((x) => x.name === 'Address')!;
    expect(t.description).toBe('Street address information.');
    expect(t.columns?.find((c) => c.name === 'AddressID')?.description).toBe('Primary key for Address records.');
    expect(t.columns?.find((c) => c.name === 'City')?.description).toBe('Name of the city; as written "here".');
    expect(r.skipped.join('\n')).toMatch(/1 comment on something other than a table or column/);
  });

  it('COMMENT ON with E\'…\' and $$…$$ strings, quotes, newlines and semicolons', () => {
    const r = convert('postgres', 'CREATE TABLE t (id int PRIMARY KEY, a text);\nCOMMENT ON TABLE t IS E\'Line one\\nline two\';\nCOMMENT ON COLUMN t.a IS $$It\'s "quoted"; with a semicolon$$;\nCOMMENT ON COLUMN t.id IS \'Doubled \'\'quote\'\'\';');
    const t = plan(r.dbml).newTables.find((x) => x.name === 't')!;
    expect(t.description).toBe('Line one\nline two');
    expect(t.columns?.find((c) => c.name === 'a')?.description).toBe('It\'s "quoted"; with a semicolon');
    expect(t.columns?.find((c) => c.name === 'id')?.description).toBe('Doubled \'quote\'');
  });

  it('MySQL and Snowflake COMMENT = on the table, COMMENT on the column', () => {
    const my = convert('mysql', 'CREATE TABLE t (id int PRIMARY KEY COMMENT \'The key; it\\\'s here\') ENGINE=InnoDB COMMENT=\'Rows; one each\';');
    const sf = convert('snowflake', 'CREATE TABLE t (id INT PRIMARY KEY COMMENT \'The key\') COMMENT = \'Rows; one each\';');
    for (const r of [my, sf]) {
      const t = plan(r.dbml).newTables.find((x) => x.name === 't')!;
      expect(t.description).toBe('Rows; one each');
    }
    expect(plan(my.dbml).newTables[0].columns?.[0].description).toBe('The key; it\'s here');
  });

  it.each([
    ['CASCADE', 'cascade'], ['RESTRICT', 'restrict'], ['NO ACTION', 'no action'], ['SET NULL', 'set null'], ['SET DEFAULT', 'set default'],
  ])('ON DELETE / ON UPDATE %s is written on the Ref, and Import lists it', (sql, dbml) => {
    for (const where of ['inline', 'table', 'alter'] as const) {
      const fk = `FOREIGN KEY (p_id) REFERENCES p (id) ON DELETE ${sql} ON UPDATE ${sql}`;
      const text = where === 'inline'
        ? `CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY, p_id int REFERENCES p (id) ON DELETE ${sql} ON UPDATE ${sql});`
        : where === 'table'
          ? `CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY, p_id int, CONSTRAINT fk ${fk});`
          : `CREATE TABLE p (id int PRIMARY KEY);\nCREATE TABLE c (id int PRIMARY KEY, p_id int);\nALTER TABLE c ADD CONSTRAINT fk ${fk};`;
      const r = convert('postgres', text);
      expect(r.dbml, where).toContain(`Ref: "c"."p_id" > "p"."id" [delete: ${dbml}, update: ${dbml}]`);
      expect(plan(r.dbml).report.dropped.find((d) => d.kind === 'reference-settings')?.item, where).toBe(`delete: ${dbml}, update: ${dbml}`);
    }
  });

  it('FK constraint names are counted in the ledger, never written as a role (snowflake FK_SENSOR_ASSET)', () => {
    const r = convert('snowflake', 'CREATE TABLE A (ID INT PRIMARY KEY);\nCREATE TABLE B (ID INT PRIMARY KEY, A_ID INT, CONSTRAINT FK_B_A FOREIGN KEY (A_ID) REFERENCES A (ID));');
    expect(r.dbml).not.toContain('FK_B_A');
    expect(entries(r, 'foreign key name')).toHaveLength(1);
    expect(plan(r.dbml).relationships[0].role).toBeUndefined();
  });
});

describe('what DBML cannot say is counted, never dropped silently', () => {
  it('MySQL: ON UPDATE CURRENT_TIMESTAMP and a generated expression are ledger losses; CHARACTER SET / COLLATE and ENGINE / CHARSET are counted settings', () => {
    const r = convert('mysql', 'CREATE TABLE t (\n  id int NOT NULL,\n  name varchar(9) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,\n  updated timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,\n  full varchar(20) AS (concat(name, \'x\')) STORED,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;');
    expect(entries(r, 'ON UPDATE').map((e) => e.where)).toEqual([{ file: 'schema.sql', line: 4, table: 't', column: 'updated' }]);
    expect(entries(r, 'generated column expression')).toHaveLength(1);
    const skipped = r.skipped.join('\n');
    expect(skipped).toMatch(/2 column settings \(COLLATE, CHARACTER SET/);
    expect(skipped).toMatch(/4 table options \(ENGINE, CHARSET/);
    expect(ledgerLeftOut(r.ledger).join('\n')).toMatch(/1 column: ON UPDATE not kept/);
  });

  it('PostgreSQL GENERATED … VIRTUAL and STORED expressions are said; the column is kept with its type', () => {
    const r = convert('postgres', 'CREATE TABLE film (id int PRIMARY KEY, length int, hours numeric(4,2) GENERATED ALWAYS AS (round(length / 60.0, 2)) VIRTUAL, h2 int GENERATED ALWAYS AS (length * 2) STORED, n int GENERATED ALWAYS AS IDENTITY);');
    expect(typeOf(r.dbml, 'film', 'hours')).toBe('numeric(4,2)');
    expect(entries(r, 'generated column expression').map((e) => e.where?.column)).toEqual(['hours', 'h2']);
    expect(r.dbml).toMatch(/"n" int \[increment\]/);
  });

  it('SQL Server computed columns are typed computed with a note; IDENTITY seed, ROWGUIDCOL, SPARSE, NOT FOR REPLICATION are counted', () => {
    const r = convert('sqlserver', 'CREATE TABLE [Sales].[Customer] (\n  [CustomerID] int IDENTITY (100, 5) NOT FOR REPLICATION NOT NULL,\n  [AccountNumber] AS ISNULL(\'AW\' + [dbo].[ufnLeadingZeros](CustomerID), \'\'),\n  [Total] AS ([CustomerID] * 2) PERSISTED,\n  [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL,\n  [Doc] nvarchar(max) SPARSE NULL\n) ON [PRIMARY]');
    expect(r.dbml).toContain('"AccountNumber" computed [note: \'Computed column; its expression was not imported.\']');
    expect(r.dbml).toContain('"Total" computed');
    expect(r.dbml).toMatch(/"CustomerID" int \[[^\]]*increment/);
    expect(entries(r, 'computed column')).toHaveLength(2);
    expect(r.skipped.join('\n')).toMatch(/4 column settings/);
  });

  it('CREATE DOMAIN and SQL Server alias types: columns keep the name; the ledger names the base and how many use it', () => {
    const pg = convert('postgres', 'CREATE DOMAIN public.year AS integer CONSTRAINT year_check CHECK (VALUE >= 1901 AND VALUE <= 2155);\nCREATE TABLE film (id int PRIMARY KEY, release_year public.year, y2 year);');
    expect(typeOf(pg.dbml, 'film', 'release_year')).toBe('public.year');
    expect(entries(pg, 'domain year').map((e) => e.where?.column)).toEqual(['release_year', 'y2']);
    expect(ledgerNotes(pg.ledger).join('\n')).toMatch(/2 columns: domain year kept by name; based on integer, its CHECK not imported/);
    const ss = convert('sqlserver', 'CREATE TYPE [dbo].[Name] FROM [nvarchar](50) NULL\nGO\nCREATE TABLE t ([a] [dbo].[Name] NOT NULL, [b] [Name] NULL)\nGO');
    expect(entries(ss, 'alias type Name')).toHaveLength(2);
    expect(entries(ss, 'alias type Name')[0].detail).toBe('kept by name; based on nvarchar(50)');
  });

  it('a DEFINER view is counted as a view (sakila), not as another statement', () => {
    const r = convert('mysql', 'CREATE TABLE t (id int);\nCREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW v AS SELECT id FROM t;\nCREATE DEFINER=CURRENT_USER VIEW w AS SELECT 1;');
    expect(r.skipped.join('\n')).toMatch(/2 views/);
    expect(r.skipped.join('\n')).not.toMatch(/other statement/);
  });

  it('partitions: PARTITION OF folds into the parent (its FKs re-pointed); ATTACHed tables are kept and said (pagila payment)', () => {
    const folded = convert('postgres', 'CREATE TABLE customer (id int PRIMARY KEY);\nCREATE TABLE payment (id int, customer_id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE payment_2022 PARTITION OF payment FOR VALUES FROM (\'2022-01-01\') TO (\'2023-01-01\');\nCREATE TABLE payment_2023 PARTITION OF payment FOR VALUES FROM (\'2023-01-01\') TO (\'2024-01-01\');\nALTER TABLE payment_2022 ADD CONSTRAINT p22_fk FOREIGN KEY (customer_id) REFERENCES customer (id);\nALTER TABLE payment_2023 ADD CONSTRAINT p23_fk FOREIGN KEY (customer_id) REFERENCES customer (id);');
    expect(folded.tableCount).toBe(2);
    expect(links(folded.dbml)).toEqual(['payment(customer_id)>customer many-to-one']);
    expect(ledgerNotes(folded.ledger).join('\n')).toMatch(/2 tables: partitions of payment folded into payment/);
    const attached = convert('postgres', 'CREATE TABLE payment (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE payment_p1 (id int, at date);\nCREATE TABLE payment_p2 (id int, at date);\nALTER TABLE ONLY payment ATTACH PARTITION payment_p1 FOR VALUES FROM (\'2022-01-01\') TO (\'2022-02-01\');\nALTER TABLE ONLY payment ATTACH PARTITION payment_p2 FOR VALUES FROM (\'2022-02-01\') TO (\'2022-03-01\');');
    expect(attached.tableCount).toBe(3);
    expect(ledgerNotes(attached.ledger).join('\n')).toMatch(/2 tables: partitions of payment kept as tables of their own \(ATTACH PARTITION payment\) \(payment_p1, payment_p2\)/);
  });

  it('every item the ledger names is a plain name: never file text beyond a name', () => {
    const r = convert('postgres', 'CREATE TABLE t (id int PRIMARY KEY, g int GENERATED ALWAYS AS (id * 2) STORED);\nCREATE UNIQUE INDEX "weird; name" ON t (lower(id::text));');
    for (const e of r.ledger) expect(JSON.stringify(e)).not.toMatch(/lower\(|id \* 2/);
  });
});

describe('more places a schema says structure', () => {
  it('pg_dump: ALTER COLUMN … ADD GENERATED AS IDENTITY makes the column an identity', () => {
    const r = convert('postgres', 'CREATE TABLE public.t (id integer NOT NULL, n text);\nALTER TABLE public.t ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (\n    SEQUENCE NAME public.t_id_seq\n    START WITH 1\n);');
    expect(r.dbml).toMatch(/"id" integer \[increment, not null\]/);
    expect(r.skipped.join('\n')).not.toMatch(/ALTER TABLE/);
  });

  it('ALTER TABLE … COMMENT = and ALTER COLUMN … COMMENT are descriptions (MySQL, Databricks, Snowflake)', () => {
    const my = convert('mysql', 'CREATE TABLE t (id int PRIMARY KEY);\nALTER TABLE t COMMENT = \'Rows; one each\';');
    expect(plan(my.dbml).newTables[0].description).toBe('Rows; one each');
    const db = convert('databricks', 'CREATE TABLE s.t (id BIGINT, a STRING);\nALTER TABLE s.t ALTER COLUMN a COMMENT \'The a\';');
    expect(plan(db.dbml).newTables[0].columns?.find((c) => c.name === 'a')?.description).toBe('The a');
    const sf = convert('snowflake', 'CREATE TABLE T (ID INT, A VARCHAR);\nALTER TABLE T ALTER COLUMN A SET COMMENT = \'The A\';');
    expect(plan(sf.dbml).newTables[0].columns?.find((c) => c.name === 'A')?.description).toBe('The A');
  });

  it('ALTER INDEX … RENAME TO, then DROP INDEX by the new name; MySQL CREATE UNIQUE INDEX … USING BTREE ON', () => {
    const pg = convert('postgres', 'CREATE TABLE t (id int PRIMARY KEY, a int);\nCREATE UNIQUE INDEX ux ON t (a);\nALTER INDEX ux RENAME TO ux2;\nDROP INDEX ux2;');
    expect(uniques(pg.dbml)).toEqual([]);
    const my = convert('mysql', 'CREATE TABLE t (id int PRIMARY KEY, a int);\nCREATE UNIQUE INDEX ux USING BTREE ON t (a);');
    expect(uniques(my.dbml)).toEqual(['t(a)']);
  });
});

describe('SQL Server DROP lists', () => {
  it('DROP CONSTRAINT a, COLUMN c: the constraint, then the column', () => {
    const r = convert('sqlserver', 'CREATE TABLE p (id int PRIMARY KEY)\nGO\nCREATE TABLE c (id int PRIMARY KEY, p_id int, x int, CONSTRAINT fk_p FOREIGN KEY (p_id) REFERENCES p (id))\nGO\nALTER TABLE c DROP CONSTRAINT fk_p, COLUMN x\nGO');
    expect(r.refCount).toBe(0);
    expect(r.dbml).not.toContain('"x"');
  });
});
