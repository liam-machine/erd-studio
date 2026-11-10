/**
 * Adversarial edge cases for the dbml-dbt-ui package (Import DBML's plan and
 * notes, Import from dbt's draft, the suggested names): inputs the real-world
 * samples do not contain, each checked for CONSERVATION — every source
 * table, column, key and link is imported, or said with a cause; nothing
 * throws; nothing is lost without a word; no note claims more than the
 * source says.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS } from '@erd-studio/core';
import {
  describeDbmlImportPlan,
  importPlanNotes,
  planDbmlImport,
  splitWords,
  suggestDbmlSubjectAreaName,
  type DbmlImportPlan,
  type DescribeDbmlImportOptions,
  type PlanDbmlImportInput,
} from '../../src/services/dbmlImport';
import { readDbml, type DbmlModel } from '../../src/services/dbmlImportParse';
import { buildDbtDraft, freeSubjectAreaSlug, listDraftScopes, seedTableFromDbt, suggestSubjectAreaName, toSubjectAreaSlug, type DbtDraft } from '../../src/services/dbtDraft';
import { draftFromDbt } from '../../src/services/draftModel';
import { YmlParserService } from '../../src/services/ymlParserService';
import * as sqlEngine from '../../src/services/sqlImportEngine';
import type { Draft, DraftTarget } from '../../src/types/draft';
import type { YmlData } from '../../src/types/ymlData';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function model(text: string): DbmlModel {
  const result = readDbml(text);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.model;
}

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
const optionalNote = (p: DbmlImportPlan, options: DescribeDbmlImportOptions = DBML_PROJECT): string | undefined =>
  importPlanNotes(p, options).find((n) => n.startsWith('Every relationship is saved as optional'));
/** The required count the D18 note states (what the scorecard's noteClaims reads). */
const claimed = (note: string | undefined): number => Number(/In the source, ([\d,]+) relationships? (?:was|were) not optional/.exec(note ?? '')?.[1]?.replace(/,/g, '') ?? 0);
/** The "the other N may be empty" count. */
const others = (note: string | undefined): number => Number(/the other ([\d,]+) may be empty/.exec(note ?? '')?.[1]?.replace(/,/g, '') ?? 0);

// ---------------------------------------------------------------------------
// Required-ness: the D18 note's counts must add up to what is drawn
// ---------------------------------------------------------------------------

describe('D18 note: required + the others = the relationships drawn', () => {
  it('a composite wider than a composite can be (9 pairs) is drawn as 9 relationships, and the note counts 9', () => {
    const cols = Array.from({ length: 9 }, (_, i) => `c${i}`);
    const p = plan(`
Table wide {
${cols.map((c) => `  ${c} int`).join('\n')}
  indexes { (${cols.join(', ')}) [pk] }
}
Table child {
  id int [pk]
${cols.map((c) => `  w_${c} int [not null]`).join('\n')}
}
Table other {
  id int [pk]
}
Table side {
  id int [pk]
  other_id int
}
Ref: child.(${cols.map((c) => `w_${c}`).join(', ')}) > wide.(${cols.join(', ')})
Ref: side.other_id > other.id
`);
    expect(p.report.relationships).toBe(10);
    const note = optionalNote(p);
    // Every relationship drawn is either counted required or among "the other".
    expect(claimed(note) + others(note)).toBe(p.report.relationships);
    expect(claimed(note)).toBe(9);
  });

  it('a many-to-many (<>) has no foreign key: never counted required, even over NOT NULL columns', () => {
    const p = plan(`
Table a {
  id int [pk]
  code int [not null]
}
Table b {
  id int [pk]
  code int [not null]
}
Ref: a.code <> b.code
`);
    expect(p.report.requiredRefs).toBe(0);
    expect(optionalNote(p)).toBeUndefined();
  });

  it('a self-reference and a TablePartial FK column are read by their NOT NULL', () => {
    const p = plan(`
TablePartial owned {
  owner_id int [not null]
}
Table users {
  id int [pk]
  manager_id int [not null]
  ~owned
}
Ref: users.manager_id > users.id
Ref: users.owner_id > users.id
`);
    expect(p.report).toMatchObject({ requiredRefs: 2, countedRefs: 2 });
  });

  it('a quoted FK name with a space (renamed on import) is matched to its field', () => {
    const p = plan(`
Table users {
  id int [pk]
}
Table orders {
  id int [pk]
  "User Id" int [not null]
}
Ref: orders."User Id" > users.id
`);
    expect(p.report.renamed.length).toBeGreaterThan(0);
    expect(p.report.requiredRefs).toBe(1);
  });

  it('a single ref replaced by a composite over the same columns is counted once (the composite)', () => {
    const p = plan(`
Table a {
  x int
  y int
  indexes { (x, y) [pk] }
}
Table b {
  id int [pk]
  ax int [not null]
  ay int
}
Ref: b.ax > a.x
Ref: b.(ax, ay) > a.(x, y)
`);
    expect(p.report.relationships).toBe(1);
    expect(p.report).toMatchObject({ countedRefs: 1, requiredRefs: 0 });
    expect(optionalNote(p)).toBeUndefined();
  });

  it('a ref repeating some pairs of a wide one counts only the pairs it adds', () => {
    const cols = Array.from({ length: 9 }, (_, i) => `c${i}`);
    const p = plan(`
Table wide {
${cols.map((c) => `  ${c} int`).join('\n')}
}
Table child {
  id int [pk]
${cols.map((c) => `  w_${c} int [not null]`).join('\n')}
}
Ref: child.w_c0 > wide.c0
Ref: child.(${cols.map((c) => `w_${c}`).join(', ')}) > wide.(${cols.join(', ')})
`);
    expect(p.report.relationships).toBe(9);
    expect(p.report).toMatchObject({ countedRefs: 9, requiredRefs: 9 });
  });

  it('a junction table whose FKs are its composite primary key (no NOT NULL written) is required', () => {
    const p = plan(`
Table actor {
  id int [pk]
}
Table film {
  id int [pk]
}
Table film_actor {
  actor_id int
  film_id int
  indexes { (actor_id, film_id) [pk] }
}
Ref: film_actor.actor_id > actor.id
Ref: film_actor.film_id > film.id
`);
    expect(p.report.requiredRefs).toBe(2);
  });
});

describe('D18 note from a SQL conversion counts the SQL NOT NULLs and primary-key members', () => {
  it('NOT NULL, a nullable FK, a composite-PK junction and an ALTER TABLE FK', () => {
    const sql = `
CREATE TABLE actor (actor_id int PRIMARY KEY);
CREATE TABLE film (film_id int PRIMARY KEY, lang_id int NOT NULL, orig_lang_id int);
CREATE TABLE lang (lang_id int PRIMARY KEY);
CREATE TABLE film_actor (actor_id int, film_id int, PRIMARY KEY (actor_id, film_id),
  FOREIGN KEY (actor_id) REFERENCES actor(actor_id), FOREIGN KEY (film_id) REFERENCES film(film_id));
ALTER TABLE film ADD CONSTRAINT fk_lang FOREIGN KEY (lang_id) REFERENCES lang(lang_id);
ALTER TABLE film ADD CONSTRAINT fk_orig FOREIGN KEY (orig_lang_id) REFERENCES lang(lang_id);
`;
    const result = sqlEngine.sqlDdlToDbml({ files: [{ name: 'schema.sql', text: sql }], dialect: 'postgres' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = plan(result.dbml);
    const note = optionalNote(p, { ...DBML_PROJECT, origin: { from: 'from 1 SQL file (PostgreSQL)', ledger: result.ledger } });
    expect(claimed(note)).toBe(3);
    expect(others(note)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Defaults kept as written: more literal shapes
// ---------------------------------------------------------------------------

describe('defaults keep their source text, more shapes', () => {
  it('1E3, +1, 1.0e-3, FALSE, Null, a negative zero decimal and a big integer', () => {
    const p = plan(`
Table t {
  a float [default: 1E3]
  b int [default: +1]
  c float [default: 1.0e-3]
  d bool [default: FALSE]
  e int [default: Null]
  f numeric [default: -0.00]
  g bigint [default: 12345678901234567890]
  h varchar [default: 'it\\'s']
}
`);
    const t = p.newTables[0];
    const dflt = (c: string) => ((t.columns!.find((x) => x.name === c)!.meta as { dbml?: { default?: unknown } }).dbml?.default);
    expect(dflt('a')).toBe('1E3');
    expect(dflt('b')).toBe('+1');
    expect(dflt('c')).toBe('1.0e-3');
    expect(dflt('d')).toBe('FALSE');
    expect(dflt('e')).toBe('Null');
    expect(dflt('f')).toBe('-0.00');
    expect(dflt('g')).toBe('12345678901234567890');
  });
});

// ---------------------------------------------------------------------------
// Enums: same name in two schemas, public
// ---------------------------------------------------------------------------

describe('enums in several schemas are each named', () => {
  it('a.status and b.status both used: the note names both, qualified', () => {
    const p = plan(`
Enum a.status {
  x
}
Enum b.status {
  y
}
Enum public.kind {
  k
}
Table a.t1 {
  id int [pk]
  s a.status
}
Table b.t2 {
  id int [pk]
  s b.status
  k kind
}
`);
    const note = importPlanNotes(p, DBML_PROJECT).find((n) => /enums? \(/.test(n)) ?? '';
    expect(note).toContain('a.status');
    expect(note).toContain('b.status');
    expect(note).toMatch(/kind/);
  });
});

// ---------------------------------------------------------------------------
// Suggested names
// ---------------------------------------------------------------------------

describe('suggested names: letters NFKD cannot take apart, cuts and collisions', () => {
  const named = (name: string) => suggestDbmlSubjectAreaName(model(`Project "${name}" {\n  database_type: 'PostgreSQL'\n}\nTable t {\n  id int\n}\n`));
  it.each([
    ['Straße', 'strasse'],
    ['Œuvre Æther', 'oeuvre-aether'],
    ['Łódź Sales', 'lodz-sales'],
    ['Søndergaard', 'sondergaard'],
    ['URLsAndIDs', 'urls-and-ids'],
    ['SQLServer2019DB', 'sql-server2019-db'],
    ['2024 Sales Model', 'sales-model'],
  ])('%s → %s', (name, slug) => {
    expect(named(name)).toBe(slug);
  });

  it('a dbt folder with accents keeps its letters (Ventes_Café → ventes_cafe)', () => {
    expect(toSubjectAreaSlug('Ventes_Café')).toBe('ventes_cafe');
    expect(suggestSubjectAreaName({ id: 'f', kind: 'folder', folder: 'marts/Ventes_Café', label: '', description: '', detail: '', modelNames: [], count: 0 })).toBe('ventes_cafe');
  });

  it('a 64-character name cut for its -2 suffix never leaves a doubled separator', () => {
    const base = `${'a'.repeat(61)}-bc`;
    expect(base.length).toBe(64);
    const free = freeSubjectAreaSlug(base, [base]);
    expect(free).not.toMatch(/[-_]{2}/);
    expect(free.length).toBeLessThanOrEqual(64);
    expect(free.endsWith('-2')).toBe(true);
  });

  it('splitWords never turns a control character in a name into "undefined"', () => {
    expect(splitWords('a\u00000\u0001b')).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// dbt: odd tests
// ---------------------------------------------------------------------------

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-edge-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function load(yml: string): Promise<YmlData> {
  fs.mkdirSync(path.join(tmp, 'models', 'marts'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'models', 'marts', 'schema.yml'), yml);
  return new YmlParserService().loadYmlData(tmp);
}

const target = (name: string, layer = 'gold'): DraftTarget => ({
  layer, layerLabel: layer, name, diagramFile: `.erd-studio/${layer}/diagrams/${name}.dbml`,
});
function view(draft: DbtDraft, data: YmlData): Draft {
  const scopes = listDraftScopes({ ymlData: data, projectRoot: tmp, modelPaths: ['models'] });
  return draftFromDbt({
    draft, relationships: draft.relationships, scope: scopes[0], scopes, trigger: 'prompt',
    target: target('marts'), libraryTable: () => undefined, layers: DEFAULT_LAYERS,
  });
}
const texts = (d: Draft, id: string): string[] => (d.details.find((s) => s.id === id)?.items ?? []).map((i) => [i.path, i.text].filter(Boolean).join(': '));
const notNullOf = (data: YmlData, m: string): string[] => [...(data.notNullColumns?.get(m) ?? [])].sort();

describe('dbt not_null in the forms the first pass did not read', () => {
  it('the test_name alternative format, dbt_expectations not-null (not with row_condition), and contract primary keys', async () => {
    const data = await load(`version: 2
models:
  - name: t
    columns:
      - name: a
        tests:
          - name: a_is_required
            test_name: not_null
      - name: b
        data_tests:
          - dbt_expectations.expect_column_values_to_not_be_null
      - name: c
        data_tests:
          - dbt_expectations.expect_column_values_to_not_be_null:
              row_condition: "c_type = 'x'"
      - name: d
        constraints:
          - type: primary_key
      - name: e
      - name: f
      - name: g
        data_tests:
          - name: g_where
            test_name: not_null
            config:
              where: "g > 0"
    constraints:
      - type: primary_key
        columns: [e, f]
`);
    expect(notNullOf(data, 't')).toEqual(['a', 'b', 'd', 'e', 'f']);
  });

  it('YAML anchors and aliases (a test list reused with *alias) are read like the list itself', async () => {
    const data = await load(`version: 2
models:
  - name: dim
    columns:
      - name: id
        tests: &key_tests
          - unique
          - not_null
  - name: fct
    columns:
      - name: id
        tests: *key_tests
      - name: dim_id
        tests:
          - not_null
          - relationships: &to_dim
              to: ref('dim')
              field: id
      - name: dim_id2
        tests:
          - relationships: *to_dim
`);
    expect(notNullOf(data, 'fct')).toEqual(['dim_id', 'id']);
    expect(data.uniqueColumns.get('fct')?.has('id')).toBe(true);
    expect(data.relationshipTests.map((t) => `${t.fromModel}.${t.fromColumn}`).sort()).toEqual(['fct.dim_id', 'fct.dim_id2']);
  });
});

describe('YAML aliases on descriptions and data types', () => {
  it('description: *anchor and data_type: *anchor read as the string the anchor names (model, column, seed)', async () => {
    const data = await load(`version: 2
models:
  - name: dim
    description: &model_desc Trips, one row each.
    columns:
      - name: start_time
        data_type: &time_type STRING
        description: &start_desc |
          The trip's start time,
          as the feed writes it.
  - name: fct
    description: *model_desc
    columns:
      - name: vp_start_time
        data_type: *time_type
        description: *start_desc
seeds:
  - name: lookup
    description: *model_desc
`);
    const fct = data.models.get('fct')!;
    expect(fct.description).toBe('Trips, one row each.');
    expect(fct.columns[0]).toMatchObject({ name: 'vp_start_time', dataType: 'STRING', description: "The trip's start time,\nas the feed writes it.\n" });
    expect(data.resourceDocs.get('lookup')?.description).toBe('Trips, one row each.');
  });

  it('aliases resolve in time linear in the file: 600 models x 10 columns, every description and data_type an alias', async () => {
    // Each alias used to walk the whole document again (yaml's Alias.resolve without a
    // cache), so 6,000 aliases cost aliases x nodes: about 70 s here.
    const lines = ['version: 2', 'models:', '  - name: m0', '    description: &d Shared.', '    columns:', '      - name: c0', '        data_type: &t VARCHAR'];
    for (let m = 1; m <= 600; m++) {
      lines.push(`  - name: m${m}`, '    description: *d', '    columns:');
      for (let c = 0; c < 10; c++) lines.push(`      - name: c${c}`, '        description: *d', '        data_type: *t');
    }
    const started = Date.now();
    const data = await load(lines.join('\n') + '\n');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(data.models.size).toBe(601);
    expect(data.models.get('m600')!.columns[9]).toMatchObject({ name: 'c9', description: 'Shared.', dataType: 'VARCHAR' });
  });

  it('an alias names the last anchor of that name before it, as YAML reads it', async () => {
    const data = await load(`version: 2
models:
  - name: a
    description: &d First.
  - name: b
    description: *d
  - name: c
    description: &d Second.
  - name: e
    description: *d
`);
    expect(data.models.get('b')!.description).toBe('First.');
    expect(data.models.get('e')!.description).toBe('Second.');
  });

  it('seeds and snapshots read YAML 1.1 merges and aliased lists as models do (`<<: *defaults`, `columns: *cols`)', async () => {
    const data = await load(`version: 2
x-defaults: &col_defaults
  description: Shared description
  data_type: VARCHAR
seeds:
  - name: lookup
    columns: &lookup_cols
      - name: code
        <<: *col_defaults
      - name: label
        description: The label
  - name: lookup2
    columns: *lookup_cols
  - <<: &seed_base
      description: Base seed description
    name: lookup3
snapshots:
  - name: snap
    <<: *seed_base
    columns: *lookup_cols
`);
    const doc = (n: string) => data.resourceDocs.get(n);
    expect(doc('lookup')?.columns).toEqual([
      { name: 'code', description: 'Shared description', dataType: 'VARCHAR' },
      { name: 'label', description: 'The label', dataType: null },
    ]);
    expect(doc('lookup2')?.columns.map((c) => c.name)).toEqual(['code', 'label']);
    expect(doc('lookup3')?.description).toBe('Base seed description');
    expect(doc('snap')).toMatchObject({ resourceType: 'snapshot', description: 'Base seed description' });
    expect(doc('snap')?.columns).toHaveLength(2);
  });
});

describe('dbt relationship tests that leave the draft are never dropped without a word', () => {
  it('a relationships test to a source() is named in Not drawn', async () => {
    const data = await load(`version: 2
models:
  - name: stg_orders
    columns:
      - name: order_id
        tests: [unique, not_null]
      - name: customer_id
        tests:
          - relationships:
              to: source('raw', 'customers')
              field: id
`);
    const draft = buildDbtDraft({ modelNames: ['stg_orders'], ymlData: data, libraryHas: () => false });
    const notDrawn = texts(view(draft, data), 'leftOut');
    expect(notDrawn.some((l) => /stg_orders\.customer_id/.test(l) && /raw\.customers/.test(l) && /source/.test(l))).toBe(true);
  });

  it('a disabled relationships test is not said to have a condition', async () => {
    const data = await load(`version: 2
models:
  - name: a
    columns:
      - name: id
        tests: [unique]
  - name: b
    columns:
      - name: id
      - name: a_id
        tests:
          - relationships:
              to: ref('a')
              field: id
              config:
                enabled: false
`);
    const draft = buildDbtDraft({ modelNames: ['a', 'b'], ymlData: data, libraryHas: () => false });
    expect(draft.relationships).toHaveLength(1);
    expect(draft.ledger.some((e) => /condition/.test(e.what))).toBe(false);
  });

  it('the D18 count of a dbt draft and the note\'s "other" add up to the relationships drawn', async () => {
    const data = await load(`version: 2
models:
  - name: a
    columns:
      - name: id
        tests: [unique, not_null]
  - name: b
    columns:
      - name: id
        tests: [unique, not_null]
      - name: a_id
        tests:
          - not_null
          - relationships:
              to: ref('a')
              field: id
      - name: a2_id
        tests:
          - relationships:
              to: ref('a')
              field: id
`);
    const draft = buildDbtDraft({ modelNames: ['a', 'b'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    const note = texts(view(draft, data), 'notes').find((n) => n.startsWith('Every relationship'));
    expect(claimed(note)).toBe(1);
    expect(claimed(note) + others(note)).toBe(draft.relationships.length);
  });

  it('a column tested not_null in the yml keeps its other meta (seeded columns carry only meta.dbml)', async () => {
    const data = await load(`version: 2
models:
  - name: t
    columns:
      - name: a
        tests: [not_null]
`);
    const col = seedTableFromDbt('t', data)!.columns![0];
    expect(col.meta).toEqual({ dbml: { not_null: true } });
  });
});

describe('the dry run text from a conversion never says "not lost" and lists the D18 count once', () => {
  it('an origin with a ledger loss', () => {
    const p = plan(`
Table users {
  id int [pk]
}
Table orders {
  id int [pk]
  user_id int [not null]
}
Ref: orders.user_id > users.id
`);
    const text = describeDbmlImportPlan(p, {
      ...DBML_PROJECT,
      origin: { from: 'from 1 SQL file', ledger: [{ outcome: 'lost', unit: 'column', cause: 'noField', what: 'CHECK constraint', count: 1, where: { table: 'orders', column: 'user_id' } }] },
    });
    expect(text).not.toMatch(/not lost/);
    expect(text.match(/saved as optional/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Hostile and odd DBML input
// ---------------------------------------------------------------------------

describe('hostile DBML input reads, or fails with a cause, and never throws', () => {
  it('a byte-order mark (Windows editors) is not DBML: the file still reads, defaults kept', () => {
    const r = readDbml('﻿Table t {\n  id int [pk]\n  a numeric [default: 0.0]\n}\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = plan('﻿Table t {\n  id int [pk]\n  a numeric [default: 0.0]\n}\n');
    expect(((p.newTables[0].columns![1].meta as { dbml?: { default?: unknown } }).dbml?.default)).toBe('0.0');
  });

  it('CRLF line ends: NOT NULL and a default literal read as with LF', () => {
    const p = plan('Table t {\r\n  id int [pk]\r\n  a numeric [not null, default: 0.0]\r\n}\r\nTable u {\r\n  id int [pk]\r\n  t_id int [not null]\r\n}\r\nRef: u.t_id > t.id\r\n');
    expect(p.report).toMatchObject({ requiredRefs: 1, countedRefs: 1 });
    expect(((p.newTables[0].columns![1].meta as { dbml?: { default?: unknown } }).dbml?.default)).toBe('0.0');
  });

  it('an empty or blank file plans nothing and says nothing optional', () => {
    for (const text of ['', ' \n\n', '// only a comment\n']) {
      const p = plan(text);
      expect(p.newTables).toEqual([]);
      expect(optionalNote(p)).toBeUndefined();
    }
  });

  it('an unterminated string is a parse failure with a line, not a throw', () => {
    const r = readDbml("Table t {\n  id int [note: 'abc\n}\n");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0].line).toBeGreaterThan(0);
  });

  it('tables whose names differ only in case, or share a name in two schemas, both import; the renames are said and the FK stays required', () => {
    const p = plan(`
Table Users {
  id int [pk]
}
Table users {
  id int [pk]
}
Table a.orders {
  id int [pk]
  user_id int [not null]
}
Table b.orders {
  id int [pk]
  user_id int
}
Ref: a.orders.user_id > Users.id
Ref: b.orders.user_id > users.id
`);
    expect(p.newTables).toHaveLength(4);
    expect(p.report.renamed.length).toBeGreaterThanOrEqual(2);
    expect(p.report).toMatchObject({ relationships: 2, requiredRefs: 1, countedRefs: 2 });
    const text = describeDbmlImportPlan(p, DBML_PROJECT);
    expect(text).toMatch(/Renamed/);
  });
});

describe('dbt model-level tests that name their column (column_name:)', () => {
  it('relationships, not_null and unique at model level are read as the column\'s; an expression column_name is not', async () => {
    const data = await load(`version: 2
models:
  - name: customers
    columns:
      - name: id
    data_tests:
      - unique:
          column_name: id
      - unique:
          column_name: "coalesce(id, 0)"
  - name: orders
    columns:
      - name: order_id
      - name: customer_id
    data_tests:
      - not_null:
          column_name: customer_id
      - relationships:
          column_name: customer_id
          to: ref('customers')
          field: id
      - name: orders_pk_not_null
        test_name: not_null
        column_name: order_id
`);
    expect(notNullOf(data, 'orders')).toEqual(['customer_id', 'order_id']);
    expect([...(data.uniqueColumns.get('customers') ?? [])]).toEqual(['id']);
    expect(data.relationshipTests.map((t) => `${t.fromModel}.${t.fromColumn} > ${t.toModel}.${t.toColumn}`)).toEqual(['orders.customer_id > customers.id']);
    const draft = buildDbtDraft({ modelNames: ['orders', 'customers'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(draft.relationships).toHaveLength(1);
    expect(draft.requiredRelationships).toBe(1);
  });

  it('a relationships test declared on the key side (dim → fact) counts the fact\'s not_null FK', async () => {
    const data = await load(`version: 2
models:
  - name: dim
    columns:
      - name: id
        tests:
          - unique
          - relationships:
              to: ref('fct')
              field: dim_id
  - name: fct
    columns:
      - name: id
        tests: [unique]
      - name: dim_id
        tests: [not_null]
`);
    const draft = buildDbtDraft({ modelNames: ['dim', 'fct'], ymlData: data, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(draft.relationships.map((r) => `${r.fromModel}.${r.fromColumn} > ${r.toModel}`)).toEqual(['fct.dim_id > dim']);
    expect(draft.requiredRelationships).toBe(1);
  });

  it('hostile schema files (empty, BOM + CRLF, a broken one, null test items) never stop the others', async () => {
    fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
    const files: Record<string, string> = {
      'a.yml': '',
      'b.yml': 'version: 2\nmodels:\n  name: not_a_list\n',
      'c.yml': 'version: 2\nmodels:\n  - name: [broken\n',
      'd.yml': '﻿version: 2\r\nmodels:\r\n  - name: m2\r\n    columns:\r\n      - name: id\r\n        tests: [not_null]\r\n',
      'e.yml': 'version: 2\nmodels:\n  - name: m1\n    columns:\n      - name: id\n        tests:\n          -\n          - ~\n          - not_null\n      - name: z\n        tests: ~\n',
    };
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(tmp, 'models', f), t);
    const data = await new YmlParserService().loadYmlData(tmp);
    expect([...data.models.keys()].sort()).toEqual(['m1', 'm2']);
    expect(notNullOf(data, 'm1')).toEqual(['id']);
    expect(notNullOf(data, 'm2')).toEqual(['id']);
  });

  it('an alias bomb stops at the expansion cap instead of hanging', async () => {
    const levels = ['a: &a [x, x, x, x, x, x, x, x, x, x]'];
    for (let i = 1; i < 8; i++) levels.push(`l${i}: &l${i} [${Array(10).fill(i === 1 ? '*a' : `*l${i - 1}`).join(', ')}]`);
    const started = Date.now();
    const data = await load(`version: 2
${levels.join('\n')}
models:
  - name: t
    columns:
      - name: id
        tests: [not_null]
`);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(notNullOf(data, 't')).toEqual(['id']);
  });
});
