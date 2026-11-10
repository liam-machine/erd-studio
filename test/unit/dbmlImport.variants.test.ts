/**
 * Import DBML's fidelity, by class of input rather than by sample: each rule
 * the real-world scorecard found broken (dbml-qut-workbench, and every
 * conversion that goes through Import DBML's flow) is held here over the
 * sample's own case and variants of the same class.
 *
 * - Required-ness: the D18 note ("every relationship is saved as optional")
 *   counts the relationships whose foreign-key columns are all NOT NULL in
 *   the source, not the refs written without a `?` (qut Bug 7, cross/4).
 * - Defaults keep their source text (`0.0`, not `0`: qut Bug 3).
 * - A primary key index's own name is kept (qut Bug 2).
 * - Enums kept only as column values, and tables written in the layer's
 *   schema, are said (qut Gap 3, qut Bug 4, cross/7).
 * - The suggested name keeps acronyms whole and one separator (qut Bug 8a,
 *   tmdl Bug 3).
 */

import { describe, expect, it } from 'vitest';

import { DBML_RICH_EXPORT_HEADER } from '@erd-studio/core';
import {
  describeDbmlImportPlan,
  importPlanNotes,
  layerSchemaNote,
  planDbmlImport,
  splitWords,
  suggestDbmlSubjectAreaName,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
  type PlanDbmlImportInput,
} from '../../src/services/dbmlImport';
import { readDbml, writtenDefaultLiteral, type DbmlModel } from '../../src/services/dbmlImportParse';
import type { ColumnDef, SemanticTable } from '../../src/types/semantic';

function model(text: string): DbmlModel {
  const result = readDbml(text);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}

/** Import DBML's flow for a fresh DBML project (as the scorecard and the command run it). */
function plan(text: string, extra: Partial<PlanDbmlImportInput> = {}): DbmlImportPlan {
  return planDbmlImport({
    model: model(text),
    layer: 'main',
    subjectAreaName: 'imported',
    library: { findTableName: () => null, getTable: () => null },
    libraryRelationships: true,
    diagramCopies: [],
    diagramHoldsNoRelationships: true,
    ...extra,
  });
}

const DBML_PROJECT: DescribeDbmlImportOptions = { dbml: { relationshipsFiles: ['main/relationships/main.dbml'] } };

const tableOf = (p: DbmlImportPlan, name: string): SemanticTable => {
  const t = p.newTables.find((m) => m.name === name);
  if (!t) throw new Error(`no table ${name}`);
  return t;
};
const columnOf = (t: SemanticTable, name: string): ColumnDef => {
  const c = t.columns?.find((col) => col.name === name);
  if (!c) throw new Error(`no column ${name}`);
  return c;
};
const dbmlMeta = (x: { meta?: unknown }): Record<string, unknown> => ((x.meta as Record<string, unknown> | undefined)?.dbml ?? {}) as Record<string, unknown>;
const optionalNote = (p: DbmlImportPlan, options: DescribeDbmlImportOptions = DBML_PROJECT): string | undefined =>
  importPlanNotes(p, options).find((n) => n.startsWith('Every relationship is saved as optional'));

// ---------------------------------------------------------------------------
// Required-ness (D18 stays: every Ref is saved `>?`; only the count changes)
// ---------------------------------------------------------------------------

const PEOPLE = `
Table users {
  id int [pk]
}
Table orders {
  id int [pk]
  user_id int [not null]
  coupon_id int
}
Table coupons {
  id int [pk]
}
`;

describe('required relationships are counted by their NOT NULL foreign-key columns', () => {
  it('a NOT NULL FK with no ? is required; a nullable one with no ? is not (the sample: 40 of 96, not 96)', () => {
    const p = plan(`${PEOPLE}
Ref: orders.user_id > users.id
Ref: orders.coupon_id > coupons.id
`);
    expect(p.report).toMatchObject({ requiredRefs: 1, countedRefs: 2 });
    expect(optionalNote(p)).toBe('Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 1 relationship was not optional (its foreign key columns are NOT NULL); the other 1 may be empty.');
    // The note is a counted ledger entry too (cause savedOptional), never rendered twice.
    expect(p.report.ledger).toContainEqual(expect.objectContaining({ outcome: 'changed', unit: 'relationship', cause: 'savedOptional', count: 1 }));
    expect(importPlanNotes(p, DBML_PROJECT).filter((n) => /optional/.test(n))).toHaveLength(1);
  });

  it('a ? on a NOT NULL FK (the source contradicts itself) is counted by NOT NULL: required', () => {
    const p = plan(`${PEOPLE}\nRef: orders.user_id >? users.id\n`);
    expect(p.report).toMatchObject({ requiredRefs: 1, optionalRefs: 1 });
  });

  it('a composite FK is required only when every column is NOT NULL', () => {
    const text = (second: string) => `
Table a {
  x int
  y int
  indexes { (x, y) [pk] }
}
Table b {
  id int [pk]
  ax int [not null]
  ay int ${second}
}
Ref: b.(ax, ay) > a.(x, y)
`;
    expect(plan(text('')).report.requiredRefs).toBe(0);
    expect(plan(text('[not null]')).report.requiredRefs).toBe(1);
    // One link, as the canvas counts it.
    expect(plan(text('[not null]')).report.countedRefs).toBe(1);
  });

  it('an inline [ref: >] and a < written from the key side read the FK end, not the declaring end', () => {
    const inline = plan(`
Table users {
  id int [pk]
}
Table orders {
  id int [pk]
  user_id int [not null, ref: > users.id]
}
`);
    expect(inline.report.requiredRefs).toBe(1);
    const lessThan = plan(`${PEOPLE}\nRef: users.id < orders.user_id\nRef: coupons.id < orders.coupon_id\n`);
    expect(lessThan.report).toMatchObject({ requiredRefs: 1, countedRefs: 2 });
  });

  it("a one-to-one: the FK end is the second as DBML reads it, required by its own columns; a whole-key FK is never null", () => {
    const oneToOne = (fkSetting: string) => plan(`
Table users {
  id int [pk]
}
Table profiles {
  id int [pk]
  user_id int ${fkSetting}
}
Ref: users.id - profiles.user_id
`);
    expect(oneToOne('[not null]').report.requiredRefs).toBe(1);
    expect(oneToOne('').report.requiredRefs).toBe(0);
    // film_embedding: the FK is the table's whole primary key, written without not null.
    const wholeKey = plan(`
Table film {
  film_id int [pk]
}
Table film_embedding {
  film_id int [pk]
}
Ref: film_embedding.film_id - film.film_id
`);
    expect(wholeKey.report.requiredRefs).toBe(1);
  });

  it('a conversion (SQL, a semantic model) gets the note; ERD Studio\'s own export, the bundled example and a YAML project do not', () => {
    const text = `${PEOPLE}\nRef: orders.user_id > users.id\n`;
    const p = plan(text);
    expect(optionalNote(p, { ...DBML_PROJECT, origin: { from: 'from 1 SQL file (PostgreSQL)' } })).toContain('1 relationship was not optional');
    expect(describeDbmlImportPlan(p, { ...DBML_PROJECT, origin: { from: 'from the semantic model Sales' } })).toContain('1 relationship was not optional');
    expect(optionalNote(p, { ...DBML_PROJECT, example: true })).toBeUndefined();
    // A YAML project's relationships record no optionality: no D18 note.
    expect(optionalNote(p, {})).toBeUndefined();
    const own = plan(`${DBML_RICH_EXPORT_HEADER}\n${text}`);
    expect(own.report.erdStudioExport).toBe(true);
    expect(optionalNote(own)).toBeUndefined();
    expect(own.report.ledger.some((e) => e.cause === 'savedOptional')).toBe(false);
  });

  it('no required relationship: no note, and the plan records nothing', () => {
    const p = plan(`${PEOPLE}\nRef: orders.coupon_id > coupons.id\n`);
    expect(optionalNote(p)).toBeUndefined();
    expect(p.report.ledger.some((e) => e.cause === 'savedOptional')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Defaults kept as written
// ---------------------------------------------------------------------------

describe('defaults keep their source text', () => {
  const DEFAULTS = `
Table t {
  a numeric [default: 0.0]
  b numeric [note: 'default: 5', default: 10.50]
  c float [default: 1e3]
  d int [default: -0]
  e varchar [default: '0.0']
  f bool [default: TRUE]
  g bool [default: true]
  h int [not null, default: NULL]
  i timestamp [default: \`now()\`]
  "default" numeric [default: -1.50]
  j numeric [default: 0]
}
`;
  it('0.0, 10.50, 1e3, -0, TRUE, NULL and -1.50 stay as the file writes them; strings and expressions as before', () => {
    const t = tableOf(plan(DEFAULTS), 't');
    const dflt = (c: string) => dbmlMeta(columnOf(t, c)).default;
    expect(dflt('a')).toBe('0.0');
    expect(dflt('b')).toBe('10.50');
    expect(dflt('c')).toBe('1e3');
    expect(dflt('d')).toBe('-0');
    expect(dflt('e')).toBe('0.0');
    expect(dflt('f')).toBe('TRUE');
    expect(dflt('g')).toBe('true');
    expect(dflt('h')).toBe('NULL');
    expect(dflt('i')).toBe('`now()`');
    expect(dflt('default')).toBe('-1.50');
    expect(dflt('j')).toBe('0');
  });

  it('the literal is read only from a setting that starts with default:, never from a note, a name or a string', () => {
    expect(writtenDefaultLiteral(`price numeric [not null, default: 0.0]`)).toBe('0.0');
    expect(writtenDefaultLiteral(`price numeric [note: 'default: 5', default: 7.50]`)).toBe('7.50');
    expect(writtenDefaultLiteral(`"default" numeric [default: 2.0]`)).toBe('2.0');
    expect(writtenDefaultLiteral(`a int [note: '''a\ndefault: 9\n''', default: 1.0]`)).toBe('1.0');
    expect(writtenDefaultLiteral(`a varchar [default: 'x']`)).toBeUndefined();
    expect(writtenDefaultLiteral(`defaults int [note: "it's default: 3"]`)).toBeUndefined();
  });

  it('a field from a TablePartial keeps its default text too', () => {
    const p = plan(`
TablePartial money {
  amount numeric [default: 0.00]
}
Table invoice {
  id int [pk]
  ~money
}
`);
    expect(dbmlMeta(columnOf(tableOf(p, 'invoice'), 'amount')).default).toBe('0.00');
  });
});

// ---------------------------------------------------------------------------
// Primary-key names
// ---------------------------------------------------------------------------

describe("a primary key index's own name is kept", () => {
  it('composite [pk, name: …] (the sample), a named single-column pk index, and a named composite unique', () => {
    const p = plan(`
Table analysis_jobs_scripts {
  analysis_job_id int
  script_id int
  indexes {
    (analysis_job_id, script_id) [pk, name: "analysis_jobs_scripts_pkey"]
  }
}
Table users {
  id int
  email varchar
  tenant int
  indexes {
    id [pk, name: 'users_pkey', note: 'surrogate']
    (email, tenant) [unique, name: 'users_email_tenant_key']
  }
}
Table plain {
  a int
  b int
  indexes {
    (a, b) [pk]
  }
}
`);
    const scripts = tableOf(p, 'analysis_jobs_scripts');
    expect(dbmlMeta(scripts).primary_key).toEqual({ name: 'analysis_jobs_scripts_pkey' });
    expect(scripts.columns?.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(['analysis_job_id', 'script_id']);
    const users = tableOf(p, 'users');
    expect(dbmlMeta(users).primary_key).toEqual({ name: 'users_pkey', note: 'surrogate' });
    expect(dbmlMeta(users).indexes).toEqual([{ columns: ['email', 'tenant'], unique: true, name: 'users_email_tenant_key' }]);
    // An unnamed key has nothing to keep.
    expect(dbmlMeta(tableOf(p, 'plain')).primary_key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Enums and schemas said
// ---------------------------------------------------------------------------

describe('enums and schemas are said, once', () => {
  it('an Enum kept only as its columns\' values is named in a note; an unused one is left out (as before)', () => {
    const p = plan(`
Enum job_status {
  new
  done
}
Enum shop.order_state {
  open
}
Enum unused_kind {
  a
}
Table jobs {
  id int [pk]
  status job_status
}
Table shop.orders {
  id int [pk]
  state shop.order_state
}
`);
    expect(dbmlMeta(columnOf(tableOf(p, 'jobs'), 'status')).enum).toEqual(['new', 'done']);
    expect(importPlanNotes(p, DBML_PROJECT)).toContain('2 enums (job_status, shop.order_state) are kept as the values on the columns of their types, not as Enum blocks: other DBML tools see only the type name.');
    expect(p.report.dropped).toContainEqual(expect.objectContaining({ kind: 'enum', item: 'unused_kind' }));
    expect(p.report.ledger.filter((e) => e.what === 'Enum block').map((e) => e.where?.table)).toEqual(['job_status', 'shop.order_state']);
  });

  it('tables with no schema (or public, which DBML reads as none) are written in the layer\'s schema: said once with a count', () => {
    const all = plan('Table a {\n  id int\n}\nTable public.b {\n  id int\n}\nTable c {\n  id int\n}\n');
    expect(layerSchemaNote(all, DBML_PROJECT)).toBe("Tables with no schema or schema public are written in schema main, the layer's name: all 3 tables (a, b, c).");
    expect(importPlanNotes(all, DBML_PROJECT).filter((n) => /schema main/.test(n))).toHaveLength(1);
    // Several schemas in one layer: only the unqualified are said; sales and Sales stay the file's.
    const mixed = plan('Table a {\n  id int\n}\nTable sales.b {\n  id int\n}\nTable dbo.c {\n  id int\n}\n');
    expect(layerSchemaNote(mixed, DBML_PROJECT)).toBe("Tables with no schema or schema public are written in schema main, the layer's name: 1 table (a).");
    expect(mixed.newTables.map((t) => t.schema)).toEqual([undefined, 'sales', 'dbo']);
    // Schemas that differ only in case stay as the file writes them (the write re-spells them to one folder and says so).
    const cased = plan('Table Sales.a {\n  id int\n}\nTable sales.b {\n  id int\n}\n');
    expect(cased.newTables.map((t) => t.schema)).toEqual(['Sales', 'sales']);
    expect(layerSchemaNote(cased, DBML_PROJECT)).toBe('');
    // Every table qualified, a YAML project, or the bundled example: nothing to say.
    expect(layerSchemaNote(plan('Table sales.b {\n  id int\n}\n'), DBML_PROJECT)).toBe('');
    expect(layerSchemaNote(all, {})).toBe('');
    expect(layerSchemaNote(all, { ...DBML_PROJECT, example: true })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The suggested diagram name
// ---------------------------------------------------------------------------

describe('the suggested name keeps acronyms whole and uses one separator', () => {
  const named = (name: string) => suggestDbmlSubjectAreaName(model(`Project "${name}" {\n  database_type: 'PostgreSQL'\n}\nTable t {\n  id int\n}\n`));
  it.each([
    ['BAW Server on PostgreSQL', 'baw-server-on-postgresql'],
    ['BawServerOnPostgreSQL', 'baw-server-on-postgresql'],
    ['MySQLSakila', 'mysql-sakila'],
    ['SQLServer', 'sql-server'],
    ['OMOP', 'omop'],
    ['CustomerID', 'customer-id'],
    ['customerIDs', 'customer-ids'],
    ['ImageURL', 'image-url'],
    ['SM_SalesSense', 'sm-sales-sense'],
    ['sales_-  mart', 'sales-mart'],
    ['Sales2024Q1', 'sales2024-q1'],
    ['ADVENTUREWORKS', 'adventureworks'],
    ['Café Ventes', 'cafe-ventes'],
  ])('%s → %s', (name, slug) => {
    expect(named(name)).toBe(slug);
  });

  it('a name with no usable letters falls back to the file name, then dbml-import; a very long one is cut to 64', () => {
    expect(suggestDbmlSubjectAreaName(model('Project "日本" {\n  Note: \'x\'\n}\nTable t {\n  id int\n}\n'), 'SM_SalesSense.dbml')).toBe('sm-sales-sense');
    expect(suggestDbmlSubjectAreaName(model('Table t {\n  id int\n}\n'))).toBe('dbml-import');
    const long = named(`${'Warehouse'.repeat(12)}Model`);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long).toMatch(/^[a-z][a-z0-9_-]*[a-z0-9]$/);
  });

  it('splitWords keeps capital runs whole and splits camel case', () => {
    expect(splitWords('PostgreSQL')).toBe('PostgreSQL');
    expect(splitWords('DBMLProject')).toBe('DBML Project');
    expect(splitWords('AdventureSales')).toBe('Adventure Sales');
    expect(splitWords('MySQLServerDB')).toBe('MySQL Server DB');
  });
});
