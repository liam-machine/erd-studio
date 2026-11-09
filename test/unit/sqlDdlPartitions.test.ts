/**
 * Partitions and inheritance in SQL DDL (`sqlDdlPartitions.ts`): a child
 * with no columns of its own (`PARTITION OF`, an `ATTACH PARTITION`ed copy of
 * its parent, `() INHERITS`) folds into its parent by default, one ledger
 * note per child at its line; `partitions: 'tables'` keeps each as a table.
 * Beyond Pagila's 55 ATTACHed monthly partitions: range, list, hash and
 * default partitions, several levels, ATTACH before the parent or the child
 * (and in another file), quoted and schema-qualified names, a child with
 * columns or constraints of its own, several parents, a parent never
 * declared, DETACH, and what each child's foreign keys, keys and comments
 * become. Every result is read by Import DBML, and every child is accounted
 * for: a table, a folded note or a reported loss.
 */
import { describe, expect, it } from 'vitest';
import { convertSqlDdl, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlPartitionMode } from '../../src/services/sqlDdlImport';
import { dbmlCoreSqlEngine } from '../../src/services/sqlImportEngine';
import { readDbml } from '../../src/services/dbmlImportParse';
import { planDbmlImport } from '../../src/services/dbmlImport';
import { ledgerLeftOut, ledgerNotes, type LedgerEntry } from '../../src/services/importLedger';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

function convert(input: string | SqlDdlFile[], partitions?: SqlPartitionMode): Converted {
  const files = typeof input === 'string' ? [{ name: 'schema.sql', text: input }] : input;
  const result = convertSqlDdl({ files, dialect: 'postgres', ...(partitions ? { options: { partitions } } : {}) }, dbmlCoreSqlEngine);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.problems)}`);
  expect(result.problems).toEqual([]);
  // Import DBML reads every result.
  const read = readDbml(result.dbml);
  if (!read.ok) throw new Error(`Import DBML rejected the output: ${JSON.stringify(read.diagnostics)}\n${result.dbml}`);
  return result;
}

/** Table names as Import DBML plans them (`schema.name` when the DBML gives a schema). */
function tables(r: Converted): string[] {
  const read = readDbml(r.dbml);
  if (!read.ok) throw new Error('unreadable');
  return read.model.tables.map((t) => (t.schema ? `${t.schema}.${t.name}` : t.name)).sort();
}

/** Each relationship Import plans, `from.col>to.col`. */
function links(r: Converted): string[] {
  const read = readDbml(r.dbml);
  if (!read.ok) throw new Error('unreadable');
  const plan = planDbmlImport({
    model: read.model, layer: 'gold', subjectAreaName: 'p', fileName: 'schema.sql',
    library: { findTableName: () => null, getTable: () => null }, libraryRelationships: true,
  });
  return plan.relationships.map((x) => `${x.fromModel}.${x.fromColumn}>${x.toModel}.${x.toColumn}`).sort();
}

/** Column lines of one DBML table block. */
function columnsOf(r: Converted, table: string): string[] {
  const m = new RegExp(`Table ${table.split('.').map((p) => `"${p}"`).join('\\.')} \\{\\n([\\s\\S]*?)\\n\\}`).exec(r.dbml);
  if (!m) throw new Error(`no table ${table} in\n${r.dbml}`);
  return m[1].split('\n').map((l) => l.trim()).filter((l) => l.startsWith('"')).map((l) => l.split(' ')[0].replace(/"/g, ''));
}

/** One DBML table block, up to its closing brace. */
function blockOf(r: Converted, table: string): string {
  const m = new RegExp(`Table "${table}" \\{\\n[\\s\\S]*?\\n\\}`).exec(r.dbml);
  if (!m) throw new Error(`no table ${table} in\n${r.dbml}`);
  return m[0];
}

const folded = (ledger: readonly LedgerEntry[]): LedgerEntry[] =>
  ledger.filter((e) => e.unit === 'table' && e.outcome === 'changed' && /^folded into /.test(e.detail ?? ''));
const tableLosses = (ledger: readonly LedgerEntry[]): LedgerEntry[] => ledger.filter((e) => e.unit === 'table' && e.outcome === 'lost');

/** Every CREATE TABLE is a table, a folded child or a reported loss: nothing goes without a word. */
function expectConserved(r: Converted, text: string): void {
  const creates = (text.match(/\bCREATE\s+TABLE\b/gi) ?? []).length;
  expect(r.tableCount + folded(r.ledger).length + tableLosses(r.ledger).length).toBe(creates);
}

describe('partitions fold into their parent by default', () => {
  const RANGE = [
    'CREATE TABLE measurement (city_id int NOT NULL, logdate date NOT NULL, peaktemp int, PRIMARY KEY (city_id, logdate)) PARTITION BY RANGE (logdate);',
    "CREATE TABLE measurement_y2024 PARTITION OF measurement FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
    "CREATE TABLE measurement_y2025 PARTITION OF measurement FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
    'CREATE TABLE measurement_old PARTITION OF measurement DEFAULT;',
  ].join('\n');

  it('range partitions and a DEFAULT partition: one table, one note per child at its line', () => {
    const r = convert(RANGE);
    expect(tables(r)).toEqual(['measurement']);
    expect(r.partitions).toEqual({ folded: 3, kept: 0 });
    expect(folded(r.ledger).map((e) => [e.where?.table, e.where?.line])).toEqual([
      ['measurement_y2024', 2], ['measurement_y2025', 3], ['measurement_old', 4],
    ]);
    expect(folded(r.ledger).every((e) => e.where?.file === 'schema.sql')).toBe(true);
    expect(ledgerNotes(r.ledger).join('\n')).toMatch(/3 tables: partitions of measurement folded into measurement \(PARTITION OF: the parent's rows\) \(measurement_y2024, measurement_y2025, measurement_old\)/);
    expect(ledgerLeftOut(r.ledger)).toEqual([]);
    expectConserved(r, RANGE);
  });

  it('list and hash partitions fold the same way', () => {
    const text = [
      'CREATE TABLE orders (id bigint, region text, PRIMARY KEY (id, region)) PARTITION BY LIST (region);',
      "CREATE TABLE orders_eu PARTITION OF orders FOR VALUES IN ('de', 'fr');",
      "CREATE TABLE orders_us PARTITION OF orders FOR VALUES IN ('us');",
      'CREATE TABLE events (id bigint PRIMARY KEY, payload jsonb) PARTITION BY HASH (id);',
      'CREATE TABLE events_0 PARTITION OF events FOR VALUES WITH (MODULUS 2, REMAINDER 0);',
      'CREATE TABLE events_1 PARTITION OF events FOR VALUES WITH (MODULUS 2, REMAINDER 1);',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['events', 'orders']);
    expect(folded(r.ledger)).toHaveLength(4);
    expectConserved(r, text);
  });

  it('pg_dump style: CREATE TABLE copies of the parent, ATTACHed later, with FKs only on some partitions (Pagila)', () => {
    const text = [
      'CREATE TABLE public.customer (customer_id integer NOT NULL);',
      'CREATE TABLE public.payment (payment_id integer NOT NULL, customer_id integer NOT NULL, payment_date timestamp with time zone NOT NULL, PRIMARY KEY (payment_date, payment_id)) PARTITION BY RANGE (payment_date);',
      'CREATE TABLE public.payment_p2022_01 (payment_id integer NOT NULL, customer_id integer NOT NULL, payment_date timestamp with time zone NOT NULL);',
      'CREATE TABLE public.payment_p2022_02 (payment_id integer NOT NULL, customer_id integer NOT NULL, payment_date timestamp with time zone NOT NULL);',
      "ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_01 FOR VALUES FROM ('2022-01-01') TO ('2022-02-01');",
      "ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p2022_02 FOR VALUES FROM ('2022-02-01') TO ('2022-03-01');",
      'ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);',
      'ALTER TABLE ONLY public.payment_p2022_01 ADD CONSTRAINT payment_p2022_01_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);',
      'ALTER TABLE ONLY public.payment_p2022_02 ADD CONSTRAINT payment_p2022_02_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['customer', 'payment']);
    // The two partitions' FKs are one relationship, drawn from payment.
    expect(links(r)).toEqual(['payment.customer_id>customer.customer_id']);
    expect(folded(r.ledger).map((e) => [e.where?.table, e.where?.line])).toEqual([['public.payment_p2022_01', 3], ['public.payment_p2022_02', 4]]);
    // Copies of the parent's columns lose nothing.
    expect(ledgerLeftOut(r.ledger)).toEqual([]);
    expectConserved(r, text);
  });

  it('several levels: sub-partitions fold into the root, by PARTITION OF and by ATTACH', () => {
    const text = [
      'CREATE TABLE sales (id int, sold date, region text, PRIMARY KEY (id, sold, region)) PARTITION BY RANGE (sold);',
      "CREATE TABLE sales_2024 PARTITION OF sales FOR VALUES FROM ('2024-01-01') TO ('2025-01-01') PARTITION BY LIST (region);",
      "CREATE TABLE sales_2024_eu PARTITION OF sales_2024 FOR VALUES IN ('eu');",
      "CREATE TABLE sales_2024_us PARTITION OF sales_2024 FOR VALUES IN ('us') PARTITION BY HASH (id);",
      'CREATE TABLE sales_2024_us_0 PARTITION OF sales_2024_us FOR VALUES WITH (MODULUS 2, REMAINDER 0);',
      'CREATE TABLE sales_2025 (id int, sold date, region text) PARTITION BY LIST (region);',
      'CREATE TABLE sales_2025_eu (id int, sold date, region text);',
      "ALTER TABLE ONLY sales_2025 ATTACH PARTITION sales_2025_eu FOR VALUES IN ('eu');",
      "ALTER TABLE ONLY sales ATTACH PARTITION sales_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
      'CREATE TABLE ref (id int PRIMARY KEY);',
      'ALTER TABLE sales_2024_us_0 ADD FOREIGN KEY (id) REFERENCES ref (id);',
      'ALTER TABLE sales_2025_eu ADD FOREIGN KEY (id) REFERENCES ref (id);',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['ref', 'sales']);
    expect(links(r)).toEqual(['sales.id>ref.id']);
    expect(folded(r.ledger).map((e) => e.detail)).toEqual(new Array(6).fill("folded into sales (PARTITION OF: the parent's rows)").map((d, i) => (i >= 4 ? d.replace('PARTITION OF', 'ATTACH PARTITION') : d)));
    expectConserved(r, text);
  });

  it('ATTACH before the parent and the child, and from another file read first', () => {
    const attachFirst = [
      "ALTER TABLE ONLY t_parent ATTACH PARTITION t_child FOR VALUES IN (1);",
      'CREATE TABLE t_child (id int, kind int);',
      'CREATE TABLE t_parent (id int PRIMARY KEY, kind int) PARTITION BY LIST (kind);',
    ].join('\n');
    expect(tables(convert(attachFirst))).toEqual(['t_parent']);
    const r = convert([
      { name: 'a_constraints.sql', text: "ALTER TABLE ONLY p ATTACH PARTITION p_1 FOR VALUES IN (1);\nALTER TABLE p_1 ADD CONSTRAINT p_1_fk FOREIGN KEY (o) REFERENCES o (id);" },
      { name: 'b_tables.sql', text: 'CREATE TABLE o (id int PRIMARY KEY);\nCREATE TABLE p (id int, o int) PARTITION BY LIST (id);\nCREATE TABLE p_1 (id int, o int);' },
    ]);
    expect(tables(r)).toEqual(['o', 'p']);
    expect(links(r)).toEqual(['p.o>o.id']);
    expect(folded(r.ledger)[0].where).toEqual({ file: 'b_tables.sql', line: 3, table: 'p_1' });
  });

  it('quoted and schema-qualified names, and the search_path', () => {
    const text = [
      'CREATE SCHEMA "Sales";',
      'CREATE TABLE "Sales"."Order Lines" (id int, "Line No" int, at date) PARTITION BY RANGE (at);',
      'CREATE TABLE "Sales"."Order Lines 2024" PARTITION OF "Sales"."Order Lines" FOR VALUES FROM (\'2024-01-01\') TO (\'2025-01-01\');',
      'CREATE TABLE "Sales"."Order Lines 2025" ("id" int, "Line No" int, "at" date);',
      'ALTER TABLE ONLY "Sales"."Order Lines" ATTACH PARTITION "Sales"."Order Lines 2025" FOR VALUES FROM (\'2025-01-01\') TO (\'2026-01-01\');',
      'SET search_path = audit;',
      'CREATE TABLE log (id int, at date) PARTITION BY RANGE (at);',
      "CREATE TABLE log_2024 PARTITION OF log FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      "CREATE TABLE public.log_x PARTITION OF audit.log FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['Sales.Order_Lines', 'audit.log']);
    expect(folded(r.ledger).map((e) => e.where?.table)).toEqual(['Sales.Order Lines 2024', 'Sales.Order Lines 2025', 'audit.log_2024', 'public.log_x']);
    expectConserved(r, text);
  });
});

describe('a child with something of its own', () => {
  it('extra columns: kept as a table, and said why', () => {
    const text = 'CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p_1 (id int, at date, note text);\nALTER TABLE p ATTACH PARTITION p_1 FOR VALUES FROM (\'2024-01-01\') TO (\'2025-01-01\');';
    const r = convert(text);
    expect(tables(r)).toEqual(['p', 'p_1']);
    expect(r.partitions).toEqual({ folded: 0, kept: 1 });
    expect(r.ledger).toContainEqual(expect.objectContaining({
      outcome: 'changed', unit: 'table', what: 'partitions of p kept', where: { file: 'schema.sql', line: 2, table: 'p_1' },
      detail: 'as a table of its own: it has columns p does not (note)',
    }));
  });

  it('its own keys, checks, descriptions and column details: folded, each one the parent lacks reported at its line', () => {
    const text = [
      'CREATE TABLE p (id int NOT NULL, code text, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);',
      "COMMENT ON TABLE p IS 'All rows';",
      'CREATE TABLE p_1 (id int NOT NULL, code varchar(3) NOT NULL, at date, PRIMARY KEY (id, at), UNIQUE (code), CHECK (id > 0));',
      "ALTER TABLE p ATTACH PARTITION p_1 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      "COMMENT ON TABLE p_1 IS '2024 only';",
      "COMMENT ON TABLE p_1 IS 'All rows';",
      'CREATE UNIQUE INDEX p_1_code_at ON p_1 (code, at);',
      'ALTER TABLE p_1 ADD CONSTRAINT p_1_chk CHECK (at > \'2000-01-01\');',
      "COMMENT ON COLUMN p_1.code IS 'partition code';",
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['p']);
    const losses = r.ledger.filter((e) => e.outcome === 'lost').map((e) => `${e.unit} ${e.what} line ${e.where?.line}${e.where?.column ? ` ${e.where.column}` : ''}`);
    expect(losses.sort()).toEqual([
      'column partition column line 3 code',
      'constraint partition check line 3',
      'constraint partition check line 8',
      'description partition description line 9 code',
      'uniqueKey partition unique key line 3 code',
      'uniqueKey partition unique key line 7 code+at',
    ].sort());
    // The partition's own primary key is the parent's: nothing lost. The comment the parent shares is not a loss either.
    expect(r.dbml).toContain("Note: 'All rows'");
    expect(ledgerLeftOut(r.ledger).join('\n')).toMatch(/partition unique key not kept: a key of the partition, not of p/);
  });

  it('a PARTITION OF list: its foreign key is the parent\'s, its options and other constraints are said', () => {
    const text = [
      'CREATE TABLE o (id int PRIMARY KEY);',
      'CREATE TABLE p (id int, o int, at date) PARTITION BY RANGE (at);',
      'CREATE TABLE p_1 PARTITION OF p (',
      '  o WITH OPTIONS NOT NULL DEFAULT 0,',
      '  CONSTRAINT p_1_o FOREIGN KEY (o) REFERENCES o (id),',
      '  CONSTRAINT p_1_pos CHECK (id > 0)',
      ") FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['o', 'p']);
    expect(links(r)).toEqual(['p.o>o.id']);
    const losses = r.ledger.filter((e) => e.outcome === 'lost').map((e) => `${e.what} line ${e.where?.line}`);
    expect(losses.sort()).toEqual(['partition NOT NULL line 4', 'partition check line 6', 'partition column option line 4'].sort());
    // Kept as a table, the same list applies to it.
    const kept = convert(text, 'tables');
    expect(tables(kept)).toEqual(['o', 'p', 'p_1']);
    expect(kept.dbml).toMatch(/Table "p_1" \{\n\s+"id" int\n\s+"o" int \[not null\]/);
    expect(kept.dbml).toMatch(/`id > 0` \[name: 'p_1_pos'\]/);
    expect(links(kept)).toEqual(['p_1.o>o.id']);
  });

  it('a foreign key to a partition points at its parent', () => {
    const r = convert([
      'CREATE TABLE p (id int PRIMARY KEY, at date) PARTITION BY RANGE (at);',
      "CREATE TABLE p_1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      'CREATE TABLE c (id int, p_id int REFERENCES p_1 (id));',
    ].join('\n'));
    expect(links(r)).toEqual(['c.p_id>p.id']);
  });
});

describe('INHERITS', () => {
  it('a child with no columns of its own folds; one with columns is kept with what it inherits; several parents keep it', () => {
    const text = [
      'CREATE TABLE cities (name text PRIMARY KEY, population int);',
      'CREATE TABLE capitals () INHERITS (cities);',
      'CREATE TABLE towns (name text, population int) INHERITS (cities);',
      'CREATE TABLE states (state char(2)) INHERITS (cities);',
      'CREATE TABLE audited (changed_at timestamp);',
      'CREATE TABLE audited_cities () INHERITS (cities, audited);',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['audited', 'audited_cities', 'cities', 'states']);
    expect(folded(r.ledger).map((e) => e.where?.table)).toEqual(['capitals', 'towns']);
    expect(folded(r.ledger)[0].detail).toBe("folded into cities (INHERITS: the parent's rows)");
    // Inherited columns come first, as PostgreSQL lists them; a key is not inherited.
    expect(columnsOf(r, 'states')).toEqual(['name', 'population', 'state']);
    expect(r.dbml).toMatch(/Table "states" \{\n\s+"name" text\n/);
    expect(columnsOf(r, 'audited_cities')).toEqual(['name', 'population', 'changed_at']);
    const notes = ledgerNotes(r.ledger).join('\n');
    expect(notes).toMatch(/tables inheriting from cities kept as a table of its own: it has columns cities does not \(state\); 2 inherited columns added \(states\)/);
    expect(notes).toMatch(/tables inheriting from cities, audited kept as a table of its own, with the columns of cities, audited \(it inherits from 2 tables\) \(audited_cities\)/);
    expectConserved(r, text);
  });

  it('ALTER TABLE … INHERIT and NO INHERIT, in file order', () => {
    const r = convert('CREATE TABLE base (id int);\nCREATE TABLE a (id int);\nCREATE TABLE b (id int);\nALTER TABLE a INHERIT base;\nALTER TABLE b INHERIT base;\nALTER TABLE b NO INHERIT base;');
    expect(tables(r)).toEqual(['b', 'base']);
    expect(r.skipped.join('\n')).not.toMatch(/ALTER TABLE action/);
  });
});

describe('a parent the files never declare', () => {
  it('PARTITION OF a missing parent is reported lost at its line; ATTACHed or INHERITing tables are kept and said', () => {
    const text = [
      'CREATE TABLE p_1 PARTITION OF missing FOR VALUES IN (1);',
      'CREATE TABLE q (id int);',
      'ALTER TABLE ONLY nowhere ATTACH PARTITION q FOR VALUES IN (2);',
      'CREATE TABLE r (id int) INHERITS (gone);',
      'CREATE TABLE s () INHERITS (gone);',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['q', 'r']);
    expect(tableLosses(r.ledger).map((e) => [e.where?.table, e.where?.line, e.detail])).toEqual([
      ['p_1', 1, 'not kept: PARTITION OF missing, which is not in the files'],
      ['s', 5, 'not kept: INHERITS gone, which is not in the files'],
    ]);
    expect(ledgerLeftOut(r.ledger).join('\n')).toMatch(/1 table: partition not kept: PARTITION OF missing, which is not in the files \(p_1\)/);
    expect(r.ledger).toContainEqual(expect.objectContaining({ what: 'partitions of nowhere kept', detail: 'as a table of its own: ATTACH PARTITION nowhere, which is not in the files' }));
    expect(r.ledger).toContainEqual(expect.objectContaining({ what: 'tables inheriting from gone kept', detail: 'as a table of its own: INHERITS gone, which is not in the files' }));
    expectConserved(r, text);
  });

  it('ATTACH of a table the files never create is said, not applied', () => {
    const r = convert('CREATE TABLE p (id int) PARTITION BY LIST (id);\nALTER TABLE p ATTACH PARTITION nobody FOR VALUES IN (1);');
    expect(tables(r)).toEqual(['p']);
    expect(r.skipped.join('\n')).toMatch(/schema\.sql line 2: nobody attached as a partition of p, which is not in the files \(not applied\)/);
  });
});

describe('DETACH, renames and drops, in file order', () => {
  it('a detached partition is a table of its own again (with its parent\'s columns when it had none)', () => {
    const r = convert([
      'CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);',
      "CREATE TABLE p_1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      "CREATE TABLE p_2 PARTITION OF p FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
      'ALTER TABLE p DETACH PARTITION p_2 CONCURRENTLY;',
    ].join('\n'));
    expect(tables(r)).toEqual(['p', 'p_2']);
    expect(columnsOf(r, 'p_2')).toEqual(['id', 'at']);
    expect(r.ledger).toContainEqual(expect.objectContaining({ what: 'detached partitions kept', where: { file: 'schema.sql', line: 3, table: 'p_2' } }));
  });

  it('a renamed partition and a renamed parent keep their link; a dropped parent takes its partitions', () => {
    const r = convert([
      'CREATE TABLE p (id int PRIMARY KEY, at date) PARTITION BY RANGE (at);',
      "CREATE TABLE p_1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      'ALTER TABLE p_1 RENAME TO p_2024;',
      'ALTER TABLE p RENAME TO facts;',
      'CREATE TABLE gone (id int) PARTITION BY RANGE (id);',
      'CREATE TABLE gone_1 PARTITION OF gone FOR VALUES FROM (0) TO (10);',
      'DROP TABLE gone;',
    ].join('\n'));
    expect(tables(r)).toEqual(['facts']);
    expect(folded(r.ledger).map((e) => e.where?.table)).toEqual(['p_2024']);
    expect(tableLosses(r.ledger)).toEqual([]);
  });
});

describe("partitions: 'tables' keeps each partition as a table", () => {
  it('PARTITION OF children get their parent\'s columns and key; ATTACHed ones stay as written; each is said', () => {
    const text = [
      'CREATE TABLE p (id int NOT NULL, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);',
      "CREATE TABLE p_1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      'CREATE TABLE p_2 (id int NOT NULL, at date NOT NULL);',
      "ALTER TABLE p ATTACH PARTITION p_2 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
      'ALTER TABLE p ADD COLUMN amount numeric(10,2);',
    ].join('\n');
    const r = convert(text, 'tables');
    expect(tables(r)).toEqual(['p', 'p_1', 'p_2']);
    expect(r.partitions).toEqual({ folded: 0, kept: 2 });
    // A column the parent gains later is the partition's too.
    expect(columnsOf(r, 'p_1')).toEqual(['id', 'at', 'amount']);
    expect(r.dbml).toMatch(/Table "p_1" \{[\s\S]*?\("id", "at"\) \[pk\]/);
    const notes = ledgerNotes(r.ledger).join('\n');
    expect(notes).toMatch(/2 tables: partitions of p kept as tables of their own, as asked \(p_1, p_2\)/);
    expectConserved(r, text);
  });

  it("an ATTACHed partition (pg_dump) gets its parent's primary key, unique keys and foreign keys, as PostgreSQL gives every partition", () => {
    // Pagila's payment: PostgreSQL 18 reads back each payment_p2022_xx with payment's primary key and
    // unique index (test/real-world-truth/engine/postgres-pagila.json), though the dump writes neither on them.
    const text = [
      'CREATE TABLE customer (id int PRIMARY KEY);',
      'CREATE TABLE payment (id int NOT NULL, at date NOT NULL, customer_id int NOT NULL, uuid uuid NOT NULL, PRIMARY KEY (at, id)) PARTITION BY RANGE (at);',
      'CREATE TABLE payment_p1 (id int NOT NULL, at date NOT NULL, customer_id int NOT NULL, uuid uuid NOT NULL);',
      "ALTER TABLE ONLY payment ATTACH PARTITION payment_p1 FOR VALUES FROM ('2022-01-01') TO ('2022-02-01');",
      'CREATE UNIQUE INDEX payment_uuid ON payment USING btree (uuid, at);',
      'CREATE UNIQUE INDEX payment_id_only ON ONLY payment USING btree (id, at, customer_id);',
      'ALTER TABLE payment ADD CONSTRAINT payment_customer FOREIGN KEY (customer_id) REFERENCES customer (id);',
    ].join('\n');
    const r = convert(text, 'tables');
    expect(tables(r)).toEqual(['customer', 'payment', 'payment_p1']);
    expect(blockOf(r, 'payment_p1')).toMatch(/\("at", "id"\) \[pk\][\s\S]*\("uuid", "at"\) \[unique\]/);
    // ON ONLY after the ATTACH: the parent's own index (pg_dump then attaches one written on each partition).
    expect(blockOf(r, 'payment')).toMatch(/\("id", "at", "customer_id"\) \[unique\]/);
    expect(blockOf(r, 'payment_p1')).not.toMatch(/customer_id"\) \[unique\]/);
    expect(links(r)).toEqual(['payment.customer_id>customer.id', 'payment_p1.customer_id>customer.id']);
    expectConserved(r, text);
  });

  it('an ONLY key goes to a partition attached after it, not to one attached before (as PostgreSQL 18 reads it back)', () => {
    const r = convert([
      'CREATE TABLE p (id int NOT NULL, at date NOT NULL, code text NOT NULL) PARTITION BY RANGE (at);',
      'ALTER TABLE ONLY p ADD CONSTRAINT p_pkey PRIMARY KEY (id, at);',
      'CREATE UNIQUE INDEX p_code ON ONLY p (code, at);',
      'CREATE TABLE p1 (id int NOT NULL, at date NOT NULL, code text NOT NULL);',
      "ALTER TABLE ONLY p ATTACH PARTITION p1 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      'CREATE TABLE q (id int NOT NULL, at date NOT NULL) PARTITION BY RANGE (at);',
      'CREATE TABLE q1 (id int NOT NULL, at date NOT NULL);',
      "ALTER TABLE ONLY q ATTACH PARTITION q1 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      'ALTER TABLE ONLY q ADD CONSTRAINT q_pkey PRIMARY KEY (id, at);',
    ].join('\n'), 'tables');
    expect(blockOf(r, 'p1')).toMatch(/\("id", "at"\) \[pk\][\s\S]*\("code", "at"\) \[unique\]/);
    expect(blockOf(r, 'q')).toMatch(/\[pk\]/);
    expect(blockOf(r, 'q1')).not.toMatch(/\[pk\]/);
  });

  it("a partition of a partition gets its grandparent's key; an INHERITS child and a partition with its own key do not get another", () => {
    const r = convert([
      'CREATE TABLE s (id int NOT NULL, region text NOT NULL, PRIMARY KEY (id, region)) PARTITION BY LIST (region);',
      "CREATE TABLE s_eu PARTITION OF s FOR VALUES IN ('eu') PARTITION BY HASH (id);",
      'CREATE TABLE s_eu_0 (id int NOT NULL, region text NOT NULL);',
      'ALTER TABLE s_eu ATTACH PARTITION s_eu_0 FOR VALUES WITH (MODULUS 2, REMAINDER 0);',
      'CREATE TABLE s_us (id int NOT NULL, region text NOT NULL, CONSTRAINT s_us_pk PRIMARY KEY (id, region));',
      "ALTER TABLE s ATTACH PARTITION s_us FOR VALUES IN ('us');",
      'CREATE TABLE base (id int PRIMARY KEY, note text UNIQUE);',
      'CREATE TABLE child (extra text) INHERITS (base);',
    ].join('\n'), 'tables');
    expect(blockOf(r, 's_eu_0')).toMatch(/\("id", "region"\) \[pk\]/);
    expect(blockOf(r, 's_us').match(/\[pk\]/g)).toHaveLength(1);
    expect(blockOf(r, 'child')).not.toMatch(/\bpk\b|unique/);
  });

  it('several levels kept: each child has its own parent\'s columns, its foreign keys its own', () => {
    const r = convert([
      'CREATE TABLE o (id int PRIMARY KEY);',
      'CREATE TABLE s (id int, o int, region text) PARTITION BY LIST (region);',
      "CREATE TABLE s_eu PARTITION OF s FOR VALUES IN ('eu') PARTITION BY HASH (id);",
      'CREATE TABLE s_eu_0 PARTITION OF s_eu FOR VALUES WITH (MODULUS 2, REMAINDER 0);',
      'ALTER TABLE s_eu_0 ADD FOREIGN KEY (o) REFERENCES o (id);',
    ].join('\n'), 'tables');
    expect(tables(r)).toEqual(['o', 's', 's_eu', 's_eu_0']);
    expect(links(r)).toEqual(['s_eu_0.o>o.id']);
  });
});

describe('messy files: changes, drops and loops around a partition', () => {
  const P = "CREATE TABLE p (id int, at date, CONSTRAINT pos CHECK (id > 0)) PARTITION BY RANGE (at);\nCREATE TABLE p_1 PARTITION OF p FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');";

  it('an ALTER on a folded partition never changes its parent: each change is reported at its own line', () => {
    const text = [
      P,
      'ALTER TABLE p_1 ALTER COLUMN id SET NOT NULL;',
      'ALTER TABLE p_1 ALTER COLUMN at SET DEFAULT now();',
      'ALTER TABLE p_1 DROP CONSTRAINT pos;',
    ].join('\n');
    const r = convert(text);
    expect(tables(r)).toEqual(['p']);
    expect(r.dbml).toMatch(/Table "p" \{\n\s+"id" int\n\s+"at" date\n/);
    expect(r.dbml).toContain('`id > 0`');
    const losses = r.ledger.filter((e) => e.outcome === 'lost').map((e) => `${e.unit} ${e.where?.file}:${e.where?.line} ${e.where?.column ?? ''}`);
    expect(losses).toEqual(['column schema.sql:3 id', 'column schema.sql:4 at']);
    // A constraint the partition never had by that name is said, not taken from the parent.
    expect(r.skipped.join('\n')).toMatch(/line 5: constraint pos dropped from p_1, which the files never defined by that name \(not applied\)/);
    expectConserved(r, text);
  });

  it('a column renamed on a folded partition does not rename its parent\'s', () => {
    const r = convert(`${P}\nALTER TABLE p_1 RENAME COLUMN id TO ident;`);
    expect(columnsOf(r, 'p')).toEqual(['id', 'at']);
  });

  it("a partition's own check dropped later is gone, not reported lost", () => {
    const r = convert("CREATE TABLE p (id int, at date) PARTITION BY RANGE (at);\nCREATE TABLE p_1 PARTITION OF p (CONSTRAINT p_1_pos CHECK (id > 0)) FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');\nALTER TABLE p_1 DROP CONSTRAINT p_1_pos;");
    expect(r.ledger.filter((e) => e.outcome === 'lost')).toEqual([]);
    expect(r.skipped.join('\n')).not.toMatch(/not applied/);
  });

  it('a column added to an empty INHERITS child keeps it as a table; the parent is untouched', () => {
    const text = 'CREATE TABLE base (id int);\nCREATE TABLE c () INHERITS (base);\nALTER TABLE c ADD COLUMN extra text;';
    const r = convert(text);
    expect(tables(r)).toEqual(['base', 'c']);
    expect(columnsOf(r, 'base')).toEqual(['id']);
    expect(columnsOf(r, 'c')).toEqual(['id', 'extra']);
    expect(r.partitions).toEqual({ folded: 0, kept: 1 });
    expectConserved(r, text);
  });

  it("kept as tables, an ALTER on a partition applies to it (it is in the files)", () => {
    const r = convert(`${P}\nALTER TABLE p_1 ALTER COLUMN id SET NOT NULL;`, 'tables');
    expect(r.dbml).toMatch(/Table "p_1" \{\n\s+"id" int \[not null\]/);
    expect(r.dbml).toMatch(/Table "p" \{\n\s+"id" int\n/);
    expect(r.skipped.join('\n')).not.toMatch(/not in the files/);
  });

  it('a column added to a detached partition is its own', () => {
    const r = convert(`${P}\nALTER TABLE p DETACH PARTITION p_1;\nALTER TABLE p_1 ADD COLUMN extra text;`);
    expect(columnsOf(r, 'p_1')).toEqual(['id', 'at', 'extra']);
    expect(columnsOf(r, 'p')).toEqual(['id', 'at']);
    expect(r.skipped.join('\n')).not.toMatch(/not in the files/);
  });

  it('DROP TABLE of a partition drops it; a table created again by that name is a table of its own', () => {
    const dropped = convert(`${P}\nDROP TABLE p_1;`);
    expect(folded(dropped.ledger)).toEqual([]);
    expect(dropped.skipped.join('\n')).not.toMatch(/DROP/);
    const again = convert(`${P}\nDROP TABLE p_1;\nCREATE TABLE p_1 (id int, x text);`);
    expect(tables(again)).toEqual(['p', 'p_1']);
    expect(again.ledger.filter((e) => e.unit === 'table')).toEqual([]);
    // A dropped parent takes every level of its partitions with it.
    const deep = convert('CREATE TABLE p (id int) PARTITION BY LIST (id);\nCREATE TABLE p_1 PARTITION OF p FOR VALUES IN (1) PARTITION BY LIST (id);\nCREATE TABLE p_1_a PARTITION OF p_1 FOR VALUES IN (1);\nDROP TABLE p;\nCREATE TABLE z (id int);');
    expect(tables(deep)).toEqual(['z']);
    expect(deep.ledger.filter((e) => e.unit === 'table')).toEqual([]);
  });

  it('CREATE TABLE IF NOT EXISTS of a partition already created does nothing', () => {
    const r = convert('CREATE TABLE p (id int) PARTITION BY LIST (id);\nCREATE TABLE p_1 PARTITION OF p FOR VALUES IN (1);\nCREATE TABLE IF NOT EXISTS p_1 (id int, other text);');
    expect(tables(r)).toEqual(['p']);
    expect(folded(r.ledger).map((e) => e.where?.line)).toEqual([2]);
  });

  it('a loop of partitions names no empty table', () => {
    for (const text of [
      'CREATE TABLE a (id int);\nCREATE TABLE b (id int);\nALTER TABLE a ATTACH PARTITION b FOR VALUES IN (1);\nALTER TABLE b ATTACH PARTITION a FOR VALUES IN (1);',
      'CREATE TABLE a (id int);\nCREATE TABLE a PARTITION OF a FOR VALUES IN (1);',
    ]) {
      const r = convert(text);
      for (const e of r.ledger) {
        expect(`${e.what} ${e.detail ?? ''}`).not.toMatch(/ of +kept|, which|  /);
      }
      expect(r.tableCount).toBeGreaterThan(0);
    }
  });

  it("pg_dump's multi-line partition: each detail its parent lacks is reported at its own line", () => {
    const text = [
      'CREATE TABLE p (',
      '    id integer NOT NULL,',
      '    at date NOT NULL',
      ') PARTITION BY RANGE (at);',
      'CREATE TABLE p_1 (',
      '    id integer DEFAULT 0 NOT NULL,',
      '    at date NOT NULL,',
      '    CONSTRAINT p_1_uq UNIQUE (id),',
      '    CONSTRAINT p_1_ck CHECK (id > 0)',
      ');',
      "ALTER TABLE ONLY p ATTACH PARTITION p_1 FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
    ].join('\n');
    const r = convert(text);
    const losses = r.ledger.filter((e) => e.outcome === 'lost').map((e) => `${e.unit} ${e.where?.line}`).sort();
    expect(losses).toEqual(['column 6', 'constraint 9', 'uniqueKey 8']);
  });

  it("two partitions' copies of one foreign key with different actions: the one not kept is reported", () => {
    const r = convert([
      'CREATE TABLE o (id int PRIMARY KEY);',
      'CREATE TABLE p (id int, o int) PARTITION BY LIST (id);',
      'CREATE TABLE p_1 PARTITION OF p FOR VALUES IN (1);',
      'CREATE TABLE p_2 PARTITION OF p FOR VALUES IN (2);',
      'CREATE TABLE p_3 PARTITION OF p FOR VALUES IN (3);',
      'ALTER TABLE p_1 ADD FOREIGN KEY (o) REFERENCES o (id) ON DELETE CASCADE;',
      'ALTER TABLE p_2 ADD FOREIGN KEY (o) REFERENCES o (id) ON DELETE SET NULL;',
      'ALTER TABLE p_3 ADD FOREIGN KEY (o) REFERENCES o (id) ON DELETE CASCADE;',
    ].join('\n'));
    expect(links(r)).toEqual(['p.o>o.id']);
    expect(r.dbml).toContain('[delete: cascade]');
    const lost = r.ledger.filter((e) => e.outcome === 'lost');
    expect(lost.map((e) => [e.unit, e.where?.line])).toEqual([['setting', 7]]);
  });

  it('a pg_dump of a thousand partitions, each with its key, foreign key, index and comment, stays fast', () => {
    const n = 1000;
    const lines = [
      'CREATE TABLE public.customer (customer_id integer NOT NULL);',
      'ALTER TABLE ONLY public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);',
      'CREATE TABLE public.payment (\n    payment_id integer NOT NULL,\n    customer_id integer NOT NULL,\n    payment_date timestamp with time zone NOT NULL\n) PARTITION BY RANGE (payment_date);',
      'ALTER TABLE ONLY public.payment ADD CONSTRAINT payment_pkey PRIMARY KEY (payment_date, payment_id);',
    ];
    for (let i = 0; i < n; i++) lines.push(`CREATE TABLE public.payment_p${i} (\n    payment_id integer NOT NULL,\n    customer_id integer NOT NULL,\n    payment_date timestamp with time zone NOT NULL\n);`);
    for (let i = 0; i < n; i++) lines.push(`ALTER TABLE ONLY public.payment ATTACH PARTITION public.payment_p${i} FOR VALUES FROM ('${i}') TO ('${i + 1}');`);
    for (let i = 0; i < n; i++) {
      lines.push(`ALTER TABLE ONLY public.payment_p${i} ADD CONSTRAINT payment_p${i}_pkey PRIMARY KEY (payment_date, payment_id);`);
      lines.push(`CREATE INDEX payment_p${i}_idx ON public.payment_p${i} USING btree (customer_id);`);
      lines.push(`ALTER TABLE ONLY public.payment_p${i} ADD CONSTRAINT payment_p${i}_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customer(customer_id);`);
      lines.push(`COMMENT ON TABLE public.payment_p${i} IS 'one month';`);
    }
    const text = lines.join('\n');
    const started = Date.now();
    const r = convertSqlDdl({ files: [{ name: 'dump.sql', text }], dialect: 'postgres' }, dbmlCoreSqlEngine);
    const ms = Date.now() - started;
    if (!r.ok) throw new Error('expected ok');
    expect(r.tableCount).toBe(2);
    expect(r.partitions).toEqual({ folded: n, kept: 0 });
    // Each partition's comment is its own: reported, once each.
    expect(r.ledger.filter((e) => e.outcome === 'lost').reduce((s, e) => s + e.count, 0)).toBe(n);
    expect(ms).toBeLessThan(8000);
  }, 60_000);
});
