/**
 * Import from dbt, beyond the committed dbt-synthea-omop sample: every way a
 * dbt project writes what the draft reads, each one read or reported.
 *
 * - not_null from manifest.json: the legacy `test_metadata` node, a
 *   `data_tests:` / dbt 1.10 `arguments:` test (the same node shape), dbt
 *   expectations', column and model contract constraints; a where- or
 *   row_condition-limited test is not counted; a quoted column (`quote: true`);
 * - relationships_where conditions, from the yml and the manifest alike, kept
 *   visible in the draft (the manifest copy used to clear the yml's flag);
 * - YAML merge keys and anchors in test maps;
 * - tests as strings and as maps; `arguments:` nesting;
 * - versioned models (yml `versions:` include/exclude, manifest `.vN` nodes);
 * - disabled models and sources; sources with `identifier:` and `quoting:`;
 * - packages' models: never offered, and a link to one says so.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_LAYERS } from '@erd-studio/core';
import {
  buildDbtDraft,
  dbtSourcesOf,
  dbtTestsOf,
  listDraftModels,
  listDraftScopes,
  notNullColumnsOf,
  seedTableFromDbt,
  type DbtDraft,
} from '../../src/services/dbtDraft';
import { dbtConditionText, dbtSourcesLine, draftFromDbt } from '../../src/services/draftModel';
import { ManifestService } from '../../src/services/manifestService';
import { identifierKey, parseSourceCall, unquoteIdentifier } from '../../src/services/nameUtils';
import { YmlParserService } from '../../src/services/ymlParserService';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import type { Draft } from '../../src/types/draft';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-variants-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Writes `files` (project-relative) and reads the project's schema yml. */
async function loadYml(files: Record<string, string>): Promise<YmlData> {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return new YmlParserService().loadYmlData(tmp);
}

/** Loads a manifest.json through the service, as the command does. */
async function loadManifest(manifest: Record<string, unknown>): Promise<ManifestData> {
  fs.mkdirSync(path.join(tmp, 'target'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'target', 'manifest.json'), JSON.stringify(manifest));
  return new ManifestService({ parseInProcess: true }).loadManifest(tmp);
}

/** A manifest model node. */
function modelNode(name: string, columns: string[], extra: Record<string, unknown> = {}, project = 'shop'): [string, Record<string, unknown>] {
  const version = typeof extra.version === 'number' ? `.v${extra.version}` : '';
  const id = `model.${project}.${name}${version}`;
  return [id, {
    unique_id: id, name, resource_type: 'model', schema: 'analytics', alias: name, description: '',
    original_file_path: `models/marts/${name}.sql`, config: { enabled: true },
    columns: Object.fromEntries(columns.map((c) => [c, { name: c, data_type: 'integer', description: '' }])),
    ...extra,
  }];
}

/** A manifest generic-test node attached to `model` (the node shape every dbt version writes). */
function testNode(
  id: string,
  model: string,
  name: string,
  kwargs: Record<string, unknown>,
  opts: { namespace?: string | null; where?: string | null; project?: string; file?: string } = {},
): [string, Record<string, unknown>] {
  const attached = model.startsWith('model.') ? model : `model.${opts.project ?? 'shop'}.${model}`;
  return [`test.shop.${id}`, {
    unique_id: `test.shop.${id}`, resource_type: 'test', name: id,
    test_metadata: { name, kwargs, namespace: opts.namespace ?? null },
    attached_node: attached, column_name: kwargs.column_name ?? null,
    config: { enabled: true, severity: 'ERROR', where: opts.where ?? null },
    depends_on: { nodes: [attached] },
    original_file_path: opts.file ?? 'models/marts/schema.yml',
  }];
}

function view(draft: DbtDraft, ymlData: YmlData | undefined, manifest?: ManifestData): Draft {
  const scopes = listDraftScopes({ ymlData, manifest, projectRoot: tmp, modelPaths: ['models'] });
  return draftFromDbt({
    draft, relationships: draft.relationships, scope: scopes[0] ?? { id: 'custom', kind: 'custom', label: 'x', description: '', detail: '', modelNames: draft.modelNames, count: draft.modelNames.length },
    scopes, trigger: 'prompt',
    target: { layer: 'gold', layerLabel: 'Gold', name: 'marts', diagramFile: '.erd-studio/gold/diagrams/marts.dbml' },
    libraryTable: () => undefined, layers: DEFAULT_LAYERS,
  });
}
const items = (d: Draft, id: string) => d.details.find((s) => s.id === id)?.items ?? [];

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

describe('quoted identifiers and source() calls', () => {
  it('reads a name inside one pair of quotes, backticks or brackets', () => {
    expect(unquoteIdentifier('"Order Id"')).toBe('Order Id');
    expect(unquoteIdentifier('`id`')).toBe('id');
    expect(unquoteIdentifier('[id]')).toBe('id');
    expect(unquoteIdentifier(' id ')).toBe('id');
    expect(unquoteIdentifier('""')).toBe('""');
    expect(identifierKey('"CUSTOMER_ID"')).toBe('customer_id');
    expect(parseSourceCall("source('raw', 'customers')")).toEqual({ source: 'raw', table: 'customers' });
    expect(parseSourceCall("{{ source(\"raw\",\"orders\") }}")).toEqual({ source: 'raw', table: 'orders' });
    expect(parseSourceCall("ref('customers')")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// not_null from manifest.json
// ---------------------------------------------------------------------------

describe('not_null is read from manifest.json', () => {
  const manifest = () => ({
    metadata: { dbt_schema_version: 'https://schemas.getdbt.com/dbt/manifest/v12.json' },
    nodes: Object.fromEntries([
      modelNode('orders', ['order_id', 'customer_id', 'store_id', 'note', 'Order Ref', 'amount', 'status'], {
        // A contract: a column constraint and a model-level primary key.
        columns: {
          order_id: { name: 'order_id', data_type: 'integer', description: '', constraints: [] },
          customer_id: { name: 'customer_id', data_type: 'integer', description: '', constraints: [{ type: 'not_null' }] },
          store_id: { name: 'store_id', data_type: 'integer', description: '' },
          note: { name: 'note', data_type: 'text', description: '' },
          'Order Ref': { name: 'Order Ref', data_type: 'text', description: '' },
          amount: { name: 'amount', data_type: 'numeric', description: '' },
          status: { name: 'status', data_type: 'text', description: '' },
        },
        constraints: [{ type: 'primary_key', columns: ['order_id'] }],
      }),
      modelNode('customers', ['customer_id']),
      // Legacy `tests:` node (namespace null).
      testNode('not_null_orders_store_id', 'orders', 'not_null', { column_name: 'store_id', model: "{{ get_where_subquery(ref('orders')) }}" }),
      // A `quote: true` column: dbt passes it quoted.
      testNode('not_null_orders_order_ref', 'orders', 'not_null', { column_name: '"Order Ref"' }),
      // dbt_expectations' not-null test, and one limited by a row_condition.
      testNode('expect_amount', 'orders', 'expect_column_values_to_not_be_null', { column_name: 'amount' }, { namespace: 'dbt_expectations' }),
      testNode('expect_status', 'orders', 'expect_column_values_to_not_be_null', { column_name: 'status', row_condition: "status <> 'x'" }, { namespace: 'dbt_expectations' }),
      // A where-limited not_null says nothing about every row.
      testNode('not_null_orders_note', 'orders', 'not_null', { column_name: 'note' }, { where: 'note is not null' }),
      testNode('rel_orders_customer', 'orders', 'relationships', { column_name: 'customer_id', to: "ref('customers')", field: 'customer_id' }),
      testNode('rel_orders_store', 'orders', 'relationships', { column_name: 'store_id', to: "ref('customers')", field: 'customer_id' }),
    ]),
  });

  it('collects test nodes and contract constraints, and skips where- and row_condition-limited tests', () => {
    const raw = extractManifestData(manifest());
    expect(raw.notNullColumns?.orders?.sort()).toEqual(['"Order Ref"', 'amount', 'customer_id', 'order_id', 'store_id']);
  });

  it('marks the columns required with no schema yml at all, and counts the required relationships', async () => {
    const m = await loadManifest(manifest());
    expect([...notNullColumnsOf(undefined, 'orders', m)].sort()).toEqual(['amount', 'customer_id', 'order ref', 'order_id', 'store_id']);
    const seeded = seedTableFromDbt('orders', undefined, m);
    const required = (seeded?.columns ?? []).filter((c) => (c.meta as { dbml?: { not_null?: boolean } } | undefined)?.dbml?.not_null).map((c) => c.name);
    expect(required.sort()).toEqual(['Order Ref', 'amount', 'customer_id', 'order_id', 'store_id']);
    const draft = buildDbtDraft({ modelNames: ['orders', 'customers'], manifest: m, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(draft.requiredRelationships).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// relationships_where conditions
// ---------------------------------------------------------------------------

const CONDITIONS_YML = `version: 2
models:
  - name: concept
    columns:
      - name: concept_id
        tests: [unique, not_null]
  - name: person
    columns:
      - name: person_id
        tests: [unique]
      - name: gender_concept_id
        tests:
          - not_null
          - dbt_utils.relationships_where:
              to: ref('concept')
              field: concept_id
              from_condition: gender_concept_id <> 0
              to_condition: domain_id = 'Gender'
          - dbt_utils.relationships_where:
              arguments:
                to: ref('concept')
                field: concept_id
                from_condition: gender_concept_id != 0
                to_condition: standard_concept = 'S'
      - name: race_concept_id
        data_tests:
          - relationships:
              arguments:
                to: ref('concept')
                field: concept_id
              config:
                where: "race_concept_id > 0"
`;

describe('relationships_where conditions stay visible in the draft', () => {
  it('reads from_condition, to_condition and where: as written, with the file and line', async () => {
    const data = await loadYml({ 'models/marts/schema.yml': CONDITIONS_YML });
    const tests = dbtTestsOf(data).relationshipTests;
    const gender = tests.find((t) => t.fromColumn === 'gender_concept_id')!;
    expect(gender.conditional).toBe(true);
    expect(gender.conditions).toEqual([
      { from: 'gender_concept_id <> 0', to: "domain_id = 'Gender'" },
      { from: 'gender_concept_id != 0', to: "standard_concept = 'S'" },
    ]);
    expect(gender.file).toBe('models/marts/schema.yml');
    expect(gender.line).toBe(14);
    expect(tests.find((t) => t.fromColumn === 'race_concept_id')?.conditions).toEqual([{ where: 'race_concept_id > 0' }]);
  });

  it('a manifest copy of the same test keeps the condition (it used to clear it)', async () => {
    const data = await loadYml({ 'models/marts/schema.yml': CONDITIONS_YML });
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('concept', ['concept_id']),
        modelNode('person', ['person_id', 'gender_concept_id', 'race_concept_id']),
        testNode('rw1', 'person', 'relationships_where',
          { column_name: 'gender_concept_id', to: "ref('concept')", field: 'concept_id', from_condition: 'gender_concept_id <> 0', to_condition: "domain_id = 'Gender'" },
          { namespace: 'dbt_utils' }),
        testNode('rel_race', 'person', 'relationships', { column_name: 'race_concept_id', to: "ref('concept')", field: 'concept_id' }, { where: 'race_concept_id > 0' }),
      ]),
    });
    expect(m.relationshipTests.map((t) => [t.fromColumn, t.conditional, t.condition])).toEqual([
      ['gender_concept_id', true, { from: 'gender_concept_id <> 0', to: "domain_id = 'Gender'" }],
      ['race_concept_id', true, { where: 'race_concept_id > 0' }],
    ]);
    const draft = buildDbtDraft({ modelNames: ['concept', 'person'], ymlData: data, manifest: m, libraryHas: () => false });
    expect(draft.relationshipConditions?.map((c) => [c.fromColumn, c.conditions.length])).toEqual([['gender_concept_id', 2], ['race_concept_id', 1]]);
    const lost = draft.ledger.filter((e) => e.what === 'relationships_where condition');
    expect(lost.map((e) => e.where)).toEqual([
      { file: 'models/marts/schema.yml', line: 14, table: 'person', column: 'gender_concept_id' },
      { file: 'models/marts/schema.yml', line: 27, table: 'person', column: 'race_concept_id' },
    ]);

    const rels = items(view(draft, data, m), 'relationships');
    expect(rels.find((i) => i.path === 'person.gender_concept_id → concept.concept_id')?.text).toBe(
      "dbt tests it only where gender_concept_id <> 0 (concept: domain_id = 'Gender'), and where gender_concept_id != 0 (concept: standard_concept = 'S'). The diagram draws it for every row.",
    );
    expect(rels.find((i) => i.path === 'person.race_concept_id → concept.concept_id')?.text).toBe('dbt tests it only where race_concept_id > 0. The diagram draws it for every row.');
  });

  it('manifest-only: relationships_where is conditional, and a plain test of the same link makes it hold for every row', async () => {
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('concept', ['concept_id']),
        modelNode('person', ['person_id', 'gender_concept_id', 'race_concept_id']),
        testNode('rw1', 'person', 'relationships_where', { column_name: 'gender_concept_id', to: "ref('concept')", field: 'concept_id', to_condition: "domain_id = 'Gender'" }, { namespace: 'dbt_utils' }),
        testNode('rw2', 'person', 'relationships_where', { column_name: 'race_concept_id', to: "ref('concept')", field: 'concept_id', from_condition: 'race_concept_id <> 0' }, { namespace: 'dbt_utils' }),
        testNode('rel_race', 'person', 'relationships', { column_name: 'race_concept_id', to: "ref('concept')", field: 'concept_id' }),
      ]),
    });
    const draft = buildDbtDraft({ modelNames: ['concept', 'person'], manifest: m, libraryHas: () => false });
    expect(draft.relationships).toHaveLength(2);
    expect(draft.relationshipConditions?.map((c) => c.fromColumn)).toEqual(['gender_concept_id']);
    expect(dbtConditionText(draft.relationshipConditions![0])).toBe("dbt tests it only against concept rows where domain_id = 'Gender'. The diagram draws it for every row.");
  });

  it('cuts a very long condition to one line', () => {
    const text = dbtConditionText({ toModel: 'concept', conditions: [{ from: `a = 1 and\n${'b = 2 and '.repeat(40)}c = 3` }] });
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(230);
    expect(text).toContain('…');
  });
});

// ---------------------------------------------------------------------------
// YAML merge keys and anchors, tests as strings and maps
// ---------------------------------------------------------------------------

describe('YAML anchors and merge keys in tests', () => {
  it('reads <<: *anchor in a test map, a column map and a list of merges, the own keys winning', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
x-defaults:
  to_customers: &to_customers
    to: ref('customers')
    field: customer_id
  wrong_field: &wrong_field
    field: not_this_one
  keyed: &keyed
    data_tests: [unique, not_null]
  conditioned: &conditioned
    from_condition: customer_id <> 0
models:
  - name: customers
    columns:
      - <<: *keyed
        name: customer_id
  - name: orders
    columns:
      - name: order_id
        <<: *keyed
      - name: customer_id
        tests:
          - relationships:
              <<: *to_customers
      - name: buyer_id
        tests:
          - relationships:
              <<: [*to_customers, *wrong_field]
      - name: payer_id
        tests:
          - relationships:
              <<: *to_customers
              field: customer_id
              config:
                <<: *conditioned
                where: "payer_id is not null"
          - dbt_utils.relationships_where:
              arguments:
                <<: [*conditioned, *to_customers]
`,
    });
    expect([...(data.uniqueColumns.get('customers') ?? [])]).toEqual(['customer_id']);
    expect([...(data.notNullColumns?.get('orders') ?? [])]).toEqual(['order_id']);
    expect([...(data.uniqueColumns.get('orders') ?? [])]).toEqual(['order_id']);
    const rels = data.relationshipTests.map((t) => `${t.fromColumn}>${t.toModel}.${t.toColumn}${t.conditional ? '?' : ''}`);
    expect(rels).toEqual(['customer_id>customers.customer_id', 'buyer_id>customers.customer_id', 'payer_id>customers.customer_id?', 'payer_id>customers.customer_id?']);
    expect(data.relationshipTests[3].condition).toEqual({ from: 'customer_id <> 0' });
  });

  it('a whole test list or test given by an alias is read; an alias to nothing is skipped', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: customers
    columns:
      - name: customer_id
        tests: &key_tests
          - unique
          - not_null
  - name: orders
    columns:
      - name: order_id
        tests: *key_tests
      - name: customer_id
        tests:
          - &to_customers
            relationships:
              to: ref('customers')
              field: customer_id
      - name: other_customer_id
        tests:
          - *to_customers
`,
    });
    expect([...(data.uniqueColumns.get('orders') ?? [])]).toEqual(['order_id']);
    expect(data.relationshipTests.map((t) => t.fromColumn)).toEqual(['customer_id', 'other_customer_id']);
  });

  it('a merge that loops is cut off, not followed forever', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: t
    columns:
      - &col
        name: a
        tests: [not_null]
        <<: *col
`,
    });
    // `*col` before its anchor ends names nothing the parser can resolve; the column is still read.
    expect(data.models.get('t')?.columns.map((c) => c.name)).toEqual(['a']);
  });

  it('tests written as strings and as maps, under tests: and data_tests:, kwargs top-level or under arguments:', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: dim
    columns:
      - name: id
        tests: [unique, not_null]
  - name: fct
    columns:
      - name: a_id
        tests: ["not_null", {relationships: {to: "ref('dim')", field: id}}]
      - name: b_id
        data_tests:
          - not_null:
              config: {severity: warn}
          - relationships:
              arguments: {to: "ref('dim')", field: id}
      - name: c_id
        data_tests:
          - name: c_rel
            test_name: relationships
            to: ref('dim')
            field: id
      - name: d_id
        data_tests:
          - unique:
          - not_null:
              enabled: false
`,
    });
    expect([...(data.notNullColumns?.get('fct') ?? [])]).toEqual(['a_id', 'b_id']);
    expect([...(data.uniqueColumns.get('fct') ?? [])]).toEqual(['d_id']);
    expect(data.relationshipTests.map((t) => t.fromColumn)).toEqual(['a_id', 'b_id', 'c_id']);
    expect(data.relationshipTests.every((t) => !t.conditional)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Quoted column names
// ---------------------------------------------------------------------------

describe('quoted column names', () => {
  it('a test that names a quote: true column quoted joins the column as the table spells it', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: dim
    columns:
      - name: Id
        quote: true
  - name: fct
    columns:
      - name: Dim Id
        quote: true
    data_tests:
      - not_null:
          column_name: '"Dim Id"'
`,
    });
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('dim', ['Id']),
        modelNode('fct', ['Dim Id']),
        testNode('u', 'dim', 'unique', { column_name: '"Id"' }),
        testNode('r', 'fct', 'relationships', { column_name: '"Dim Id"', to: "ref('dim')", field: '"Id"' }),
      ]),
    });
    const draft = buildDbtDraft({ modelNames: ['dim', 'fct'], ymlData: data, manifest: m, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(draft.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`)).toEqual(['fct.Dim Id>dim.Id']);
    const dim = draft.newModels.find((t) => t.name === 'dim')!;
    const fct = draft.newModels.find((t) => t.name === 'fct')!;
    expect(dim.columns?.[0]).toMatchObject({ name: 'Id', isPrimaryKey: true });
    expect(fct.columns?.[0]).toMatchObject({ name: 'Dim Id', isForeignKey: true, meta: { dbml: { not_null: true } } });
    expect(draft.requiredRelationships).toBe(1);
  });

  it('a conditional test on a quoted column keeps its condition on the drawn line', async () => {
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('dim', ['Id']),
        modelNode('fct', ['Dim Id']),
        testNode('rw', 'fct', 'relationships_where', { column_name: '"Dim Id"', to: "ref('dim')", field: '"Id"', from_condition: '"Dim Id" <> 0' }, { namespace: 'dbt_utils' }),
      ]),
    });
    const draft = buildDbtDraft({ modelNames: ['dim', 'fct'], manifest: m, libraryHas: () => false });
    expect(draft.relationshipConditions).toEqual([{ fromModel: 'fct', fromColumn: 'Dim Id', toModel: 'dim', toColumn: 'Id', conditions: [{ from: '"Dim Id" <> 0' }] }]);
    expect(draft.ledger.find((e) => e.what === 'relationships_where condition')?.where).toEqual({ file: 'models/marts/schema.yml', table: 'fct', column: 'Dim Id' });
  });
});

// ---------------------------------------------------------------------------
// Versioned models
// ---------------------------------------------------------------------------

describe('versioned models', () => {
  it('the yml draws the latest version: the top-level columns it includes, minus excludes, plus its own', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: dim_customers
    latest_version: 2
    columns:
      - name: customer_id
        tests: [unique, not_null]
      - name: country_name
      - name: legacy_flag
        tests: [not_null]
    versions:
      - v: 1
      - v: 2
        columns:
          - include: all
            exclude: [legacy_flag]
          - name: country_name
            data_type: varchar(2)
            tests: [not_null]
          - name: region
          - v: 3
      - v: 3
        columns:
          - include: [customer_id]
  - name: fct_orders
    columns:
      - name: order_id
      - name: customer_id
        tests:
          - relationships:
              to: ref('dim_customers', v=2)
              field: customer_id
`,
    });
    const dim = data.models.get('dim_customers')!;
    expect(dim.version).toBe(2);
    expect(dim.columns.map((c) => [c.name, c.dataType])).toEqual([['customer_id', null], ['country_name', 'varchar(2)'], ['region', null]]);
    expect([...(data.notNullColumns?.get('dim_customers') ?? [])]).toEqual(['customer_id', 'country_name']);
    expect(data.relationshipTests.map((t) => t.toModel)).toEqual(['dim_customers']);
  });

  it('without latest_version the highest v wins; a version with no columns: has every top-level column', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: m
    columns:
      - name: a
      - name: b
    versions:
      - v: 1
        columns:
          - include: '*'
            exclude: [b]
      - v: 4
`,
    });
    expect(data.models.get('m')?.version).toBe(4);
    expect(data.models.get('m')?.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('manifest .vN nodes: the latest version is drawn and its tests attach to the model name', async () => {
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('dim', ['id', 'old'], { version: 1, latest_version: 2 }),
        modelNode('dim', ['id'], { version: 2, latest_version: 2 }),
        modelNode('fct', ['dim_id']),
        testNode('nn', 'model.shop.dim.v2', 'not_null', { column_name: 'id' }),
        testNode('u', 'model.shop.dim.v2', 'unique', { column_name: 'id' }),
        testNode('r', 'fct', 'relationships', { column_name: 'dim_id', to: "ref('dim', v=2)", field: 'id' }),
      ]),
    });
    expect(m.models.get('dim')?.columns.map((c) => c.name)).toEqual(['id']);
    const draft = buildDbtDraft({ modelNames: ['dim', 'fct'], manifest: m, libraryHas: () => false });
    expect(draft.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`)).toEqual(['fct.dim_id>dim.id']);
    expect(draft.newModels.find((t) => t.name === 'dim')?.columns?.[0]).toMatchObject({ isPrimaryKey: true, meta: { dbml: { not_null: true } } });
  });
});

// ---------------------------------------------------------------------------
// Disabled models, packages' models
// ---------------------------------------------------------------------------

describe('disabled models and packages\' models', () => {
  it('a yml config: enabled: false model is not offered, and a link to it says why', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: dim_old
    config:
      enabled: false
    columns:
      - name: id
  - name: fct
    columns:
      - name: old_id
        tests:
          - relationships:
              to: ref('dim_old')
              field: id
`,
    });
    expect(listDraftModels({ ymlData: data, projectRoot: tmp, modelPaths: ['models'] }).map((m) => m.name)).toEqual(['fct']);
    const draft = buildDbtDraft({ modelNames: ['fct', 'dim_old'], ymlData: data, libraryHas: () => false });
    expect(draft.skipped).toEqual([{ name: 'dim_old', reason: 'disabled' }]);
    expect(draft.undrawnLinks?.map((l) => [l.toModel, l.why])).toEqual([['dim_old', 'disabled']]);
    expect(items(view(draft, data), 'leftOut').map((i) => i.text)).toContain('dim_old is disabled in dbt, so it can\'t be drawn.');
  });

  it('a package\'s model is never offered, and a link to it names the package', async () => {
    const data = await loadYml({
      'models/marts/schema.yml': `version: 2
models:
  - name: fct
    columns:
      - name: day
        tests:
          - relationships:
              to: ref('dbt_date', 'dates')
              field: date_day
`,
      'models/marts/fct.sql': 'select 1',
    });
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('fct', ['day']),
        modelNode('dates', ['date_day'], {}, 'dbt_date'),
        testNode('r', 'fct', 'relationships', { column_name: 'day', to: "ref('dbt_date', 'dates')", field: 'date_day' }),
      ]),
    });
    expect(listDraftModels({ ymlData: data, manifest: m, projectRoot: tmp, modelPaths: ['models'] }).map((e) => e.name)).toEqual(['fct']);
    const draft = buildDbtDraft({ modelNames: ['fct'], ymlData: data, manifest: m, libraryHas: () => false });
    expect(draft.undrawnLinks?.map((l) => [l.toModel, l.why])).toEqual([['dates', 'package']]);
    expect(items(view(draft, data, m), 'leftOut').map((i) => i.text)).toContain('dates is a model from an installed dbt package, so it can\'t be drawn.');
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const SOURCES_YML = `version: 2
sources:
  - name: raw
    schema: "{{ env_var('RAW_SCHEMA', 'raw') }}"
    quoting:
      identifier: true
    tables:
      - name: customers
        identifier: Customers_v2
        columns:
          - name: id
          - name: name
      - name: orders
        quoting:
          identifier: false
      - name: legacy
        config:
          enabled: false
  - name: off
    config:
      enabled: false
    tables:
      - name: nothing
`;

describe('dbt sources are listed, never drawn', () => {
  it('reads enabled source tables with identifier, quoting, file and line', async () => {
    const data = await loadYml({ 'models/staging/_sources.yml': SOURCES_YML });
    expect(data.sources).toEqual([
      { source: 'raw', name: 'customers', identifier: 'Customers_v2', quoted: true, description: '', columns: [{ name: 'id', description: '', dataType: null }, { name: 'name', description: '', dataType: null }], file: 'models/staging/_sources.yml', line: 8 },
      { source: 'raw', name: 'orders', description: '', columns: [], file: 'models/staging/_sources.yml', line: 13 },
    ]);
  });

  it('the draft names every source in Not drawn and records each with its file and line; the manifest adds any the yml lacks', async () => {
    const data = await loadYml({
      'models/staging/_sources.yml': SOURCES_YML,
      'models/marts/schema.yml': `version: 2
models:
  - name: stg_customers
    columns:
      - name: customer_id
        data_tests:
          - relationships:
              arguments:
                to: source('raw', 'customers')
                field: id
`,
    });
    const m = await loadManifest({
      nodes: Object.fromEntries([modelNode('stg_customers', ['customer_id'])]),
      sources: {
        'source.shop.raw.customers': { name: 'customers', source_name: 'raw', identifier: 'Customers_v2', columns: {}, original_file_path: 'models/staging/_sources.yml', quoting: { identifier: true }, config: { enabled: true } },
        'source.shop.erp.invoices': { name: 'invoices', source_name: 'erp', identifier: 'invoices', columns: {}, original_file_path: 'models/staging/_erp.yml', quoting: {}, config: { enabled: true } },
      },
    });
    expect(dbtSourcesOf(data, m).map((s) => s.name)).toEqual(['erp.invoices', 'raw.customers', 'raw.orders']);
    const draft = buildDbtDraft({ modelNames: ['stg_customers'], ymlData: data, manifest: m, libraryHas: () => false });
    expect(draft.sources?.map((s) => [s.name, s.identifier, s.file, s.line])).toEqual([
      ['erp.invoices', undefined, 'models/staging/_erp.yml', undefined],
      ['raw.customers', 'Customers_v2', 'models/staging/_sources.yml', 8],
      ['raw.orders', undefined, 'models/staging/_sources.yml', 13],
    ]);
    expect(draft.ledger.filter((e) => e.what === 'dbt source').map((e) => e.where)).toEqual([
      { file: 'models/staging/_erp.yml', table: 'erp.invoices' },
      { file: 'models/staging/_sources.yml', line: 8, table: 'raw.customers' },
      { file: 'models/staging/_sources.yml', line: 13, table: 'raw.orders' },
    ]);
    // The relationships test to a source: listed with its file and line.
    expect(draft.undrawnLinks).toEqual([{ fromModel: 'stg_customers', fromColumn: 'customer_id', toModel: 'raw.customers', toColumn: 'id', why: 'source' }]);
    expect(draft.ledger.find((e) => e.what === 'link to a source')?.where).toEqual({ file: 'models/marts/schema.yml', line: 7, table: 'stg_customers', column: 'customer_id' });

    const leftOut = items(view(draft, data, m), 'leftOut');
    expect(leftOut.find((i) => i.tag === 'sources')?.text).toBe(
      "3 dbt sources are not drawn: Import from dbt draws models, and a source is a table dbt reads but doesn't build. They are erp.invoices, raw.customers (table Customers_v2), raw.orders.",
    );
  });

  it('a manifest-only source relationships test is still listed', async () => {
    const m = await loadManifest({
      nodes: Object.fromEntries([
        modelNode('stg', ['id']),
        testNode('r', 'stg', 'relationships', { column_name: 'id', to: "source('raw', 'customers')", field: 'id' }),
      ]),
    });
    expect(m.relationshipTests).toEqual([]);
    const draft = buildDbtDraft({ modelNames: ['stg'], manifest: m, libraryHas: () => false });
    expect(draft.undrawnLinks?.map((l) => [l.toModel, l.why])).toEqual([['raw.customers', 'source']]);
  });

  it('a long list of sources names as many as fit in 300 characters and counts the rest', () => {
    const many = Array.from({ length: 23 }, (_, i) => ({ name: `raw.t${String(i).padStart(2, '0')}`, columns: 0 }));
    const line = dbtSourcesLine(many);
    expect(line.length).toBeLessThanOrEqual(300);
    expect(line).toMatch(/^23 dbt sources are not drawn: .* raw\.t00, raw\.t01, .* and \d+ more \(ERD Studio: Show Logs lists every one\)\.$/);
    const shown = (line.match(/raw\.t\d\d/g) ?? []).length;
    expect(shown + Number(/and (\d+) more/.exec(line)![1])).toBe(23);
    // An uncompiled project's table name is still Jinja: not a name, so it is not given (Fivetran's packages).
    const jinja = Array.from({ length: 75 }, (_, i) => ({ name: `hubspot.table_number_${i}`, identifier: `{{ var('hubspot_table_number_${i}_identifier', 'table_number_${i}')}}`, columns: 0 }));
    const long = dbtSourcesLine(jinja);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long).not.toContain('{{');
    expect(long).toContain('hubspot.table_number_0, hubspot.table_number_1');
    expect(dbtSourcesLine([{ name: 'raw.a', columns: 0 }])).toBe("1 dbt source is not drawn: Import from dbt draws models, and a source is a table dbt reads but doesn't build. It is raw.a.");
  });
});
