/**
 * Import from dbt with messy real-world files: each case broke the reader or
 * the draft once (a hang, a link drawn from a column the table does not have,
 * a model dbt builds left out, a package's source listed as the project's, a
 * condition the manifest knows dropped). Import or report: nothing here may
 * throw, hang or vanish without a word.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDbtDraft, dbtSourcesOf, dbtTestsOf, listDraftModels, type DbtDraft } from '../../src/services/dbtDraft';
import { dbtDraftLogLines, dbtSourcesLine } from '../../src/services/draftModel';
import { ManifestService } from '../../src/services/manifestService';
import { unquoteIdentifier } from '../../src/services/nameUtils';
import { YmlParserService } from '../../src/services/ymlParserService';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbt-edge-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function loadYml(files: Record<string, string>): Promise<YmlData> {
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return new YmlParserService().loadYmlData(tmp);
}

async function loadManifest(manifest: Record<string, unknown>): Promise<ManifestData> {
  fs.mkdirSync(path.join(tmp, 'target'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'target', 'manifest.json'), JSON.stringify(manifest));
  return new ManifestService({ parseInProcess: true }).loadManifest(tmp);
}

function modelNode(id: string, name: string, columns: string[], extra: Record<string, unknown> = {}): [string, Record<string, unknown>] {
  return [id, {
    unique_id: id, name, resource_type: 'model', schema: 'analytics', alias: name, description: '',
    original_file_path: `models/${name}.sql`, config: { enabled: true },
    columns: Object.fromEntries(columns.map((c) => [c, { name: c, data_type: 'integer', description: '' }])),
    ...extra,
  }];
}

function testNode(id: string, attached: string, name: string, kwargs: Record<string, unknown>, where: string | null = null): [string, Record<string, unknown>] {
  return [`test.shop.${id}`, {
    unique_id: `test.shop.${id}`, resource_type: 'test', name: id,
    test_metadata: { name, kwargs, namespace: null },
    attached_node: attached, column_name: kwargs.column_name ?? null,
    config: { enabled: true, severity: 'ERROR', where },
    depends_on: { nodes: [attached] },
    original_file_path: 'models/schema.yml',
  }];
}

const linkLabels = (d: DbtDraft): string[] => d.relationships.map((r) => `${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn}`);

describe('YAML merge keys cannot blow up', () => {
  it('a fan-out of merges (each anchor merging the one before many times) reads in linear time', async () => {
    const lines = ['x0: &a0 { tests: [not_null] }'];
    for (let i = 1; i <= 6; i++) lines.push(`x${i}: &a${i} { <<: [${Array(12).fill(`*a${i - 1}`).join(', ')}] }`);
    lines.push('models:', '  - name: m', '    columns:', '      - name: id', '        <<: *a6');
    const started = Date.now();
    const data = await loadYml({ 'models/schema.yml': lines.join('\n') });
    expect(Date.now() - started).toBeLessThan(2000);
    expect([...(data.notNullColumns.get('m') ?? [])]).toEqual(['id']);
  });

  it('a map that merges itself is read once, not followed round', async () => {
    // Each map's merge is built once: without the self-merge guard, `defaults` would be rebuilt at every level down to the depth limit.
    const built = vi.spyOn(YmlParserService.prototype as unknown as { buildMerged: (map: unknown, depth: number) => unknown }, 'buildMerged');
    const data = await loadYml({ 'models/schema.yml': `
defaults: &d
  tests: [not_null]
  <<: *d
models:
  - name: m
    columns:
      - name: id
        <<: *d
` });
    expect([...(data.notNullColumns.get('m') ?? [])]).toEqual(['id']);
    const maps = built.mock.calls.map((c) => c[0]);
    expect(new Set(maps).size).toBe(maps.length);
    expect(maps).toHaveLength(2); // the column's map and `defaults`, once each
    built.mockRestore();
  });
});

describe('a column_name that is an expression names no column', () => {
  it('quotes round an expression are not a quoted column', () => {
    expect(unquoteIdentifier('"a" || "b"')).toBe('"a" || "b"');
    expect(unquoteIdentifier('"Order ""Ref"""')).toBe('Order "Ref"');
    expect(unquoteIdentifier('[a] + [b]')).toBe('[a] + [b]');
    expect(unquoteIdentifier('`a`.`b`')).toBe('`a`.`b`');
  });

  it('a model-level test on "a" || "b" is not read as a column test', async () => {
    const data = await loadYml({ 'models/schema.yml': `
models:
  - name: orders
    columns: [{name: id}, {name: a}, {name: b}]
    tests:
      - relationships: { column_name: '"a" || "b"', to: ref('customers'), field: id }
      - not_null: { column_name: '"a" || "b"' }
  - name: customers
    columns: [{name: id, tests: [unique]}]
` });
    expect(data.relationshipTests).toEqual([]);
    expect(data.notNullColumns.get('orders')).toBeUndefined();
  });
});

describe('a link is drawn only between columns the tables have', () => {
  it("a test from an older version's column is listed, not drawn from a column the table lacks", async () => {
    const m = await loadManifest({
      metadata: {},
      nodes: Object.fromEntries([
        modelNode('model.shop.orders.v1', 'orders', ['id', 'old_cid'], { version: 1, latest_version: 2 }),
        modelNode('model.shop.orders.v2', 'orders', ['id', 'cid'], { version: 2, latest_version: 2 }),
        modelNode('model.shop.customers', 'customers', ['id']),
        testNode('r1', 'model.shop.orders.v1', 'relationships', { column_name: 'old_cid', to: "ref('customers')", field: 'id' }),
        testNode('r2', 'model.shop.orders.v2', 'relationships', { column_name: 'cid', to: "ref('customers')", field: 'id' }),
        testNode('u', 'model.shop.customers', 'unique', { column_name: 'id' }),
      ]),
    });
    const draft = buildDbtDraft({ modelNames: ['orders', 'customers'], manifest: m, libraryHas: () => false });
    expect(linkLabels(draft)).toEqual(['orders.cid → customers.id']);
    // Not dropped without a word: Not drawn names it, and the ledger records it.
    expect(draft.undrawnLinks?.map((l) => [l.fromModel, l.fromColumn, l.toModel, l.why])).toEqual([['orders', 'old_cid', 'customers', 'noColumn']]);
    expect(draft.ledger.find((e) => e.unit === 'relationship' && e.where?.column === 'old_cid')?.where)
      .toEqual({ file: 'models/schema.yml', table: 'orders', column: 'old_cid' });
  });
});

describe("the manifest decides whether a model dbt builds is disabled", () => {
  it('a yml `enabled: false` the SQL config overrides (the manifest builds it) is still offered', async () => {
    const data = await loadYml({
      'models/schema.yml': 'models:\n  - name: orders\n    config: {enabled: false}\n    columns: [{name: id}]\n',
      'models/orders.sql': "{{ config(enabled=true) }}\nselect 1 as id",
    });
    const m = await loadManifest({ metadata: {}, nodes: Object.fromEntries([modelNode('model.shop.orders', 'orders', ['id'])]) });
    expect(listDraftModels({ ymlData: data, manifest: m, projectRoot: tmp, modelPaths: ['models'] } as Parameters<typeof listDraftModels>[0]).map((x) => x.name)).toEqual(['orders']);
    expect(buildDbtDraft({ modelNames: ['orders'], ymlData: data, manifest: m, libraryHas: () => false }).modelNames).toEqual(['orders']);
  });

  it('without a manifest, the yml `enabled: false` still keeps it out', async () => {
    const data = await loadYml({ 'models/schema.yml': 'models:\n  - name: orders\n    config: {enabled: false}\n    columns: [{name: id}]\n' });
    expect(buildDbtDraft({ modelNames: ['orders'], ymlData: data, libraryHas: () => false }).skipped).toEqual([{ name: 'orders', reason: 'disabled' }]);
  });
});

describe("an installed package's sources are not the project's", () => {
  it('lists only the sources of the dbt projects the open project owns', async () => {
    const data = await loadYml({
      'models/schema.yml': 'models:\n  - name: orders\n    columns: [{name: id}]\nsources:\n  - name: raw\n    tables: [{name: orders}]\n',
    });
    const m = await loadManifest({
      metadata: {},
      nodes: Object.fromEntries([modelNode('model.shop.orders', 'orders', ['id'])]),
      sources: {
        'source.shop.raw.orders': { unique_id: 'source.shop.raw.orders', name: 'orders', source_name: 'raw', package_name: 'shop', original_file_path: 'models/schema.yml', config: { enabled: true }, columns: {} },
        'source.shop.raw.refunds': { unique_id: 'source.shop.raw.refunds', name: 'refunds', source_name: 'raw', package_name: 'shop', original_file_path: 'models/other.yml', config: { enabled: true }, columns: {} },
        'source.stripe_source.stripe.charge': { unique_id: 'source.stripe_source.stripe.charge', name: 'charge', source_name: 'stripe', package_name: 'stripe_source', original_file_path: 'models/src_stripe.yml', config: { enabled: true }, columns: {} },
      },
    });
    expect(dbtSourcesOf(data, m).map((s) => s.name)).toEqual(['raw.orders', 'raw.refunds']);
  });
});

describe('a condition only the manifest knows (a project-wide `+where`) is not dropped', () => {
  it('the yml copy of the same test does not make it hold for every row', async () => {
    const data = await loadYml({ 'models/schema.yml': `
models:
  - name: orders
    columns:
      - name: cid
        tests:
          - relationships: { to: ref('customers'), field: id }
  - name: customers
    columns: [{name: id, tests: [unique]}]
` });
    const m = await loadManifest({
      metadata: {},
      nodes: Object.fromEntries([
        modelNode('model.shop.orders', 'orders', ['cid']),
        modelNode('model.shop.customers', 'customers', ['id']),
        // dbt_project.yml `tests: +where: "loaded_at > current_date - 3"` lands on every test node.
        testNode('rel', 'model.shop.orders', 'relationships', { column_name: 'cid', to: "ref('customers')", field: 'id' }, 'loaded_at > current_date - 3'),
      ]),
    });
    const test = dbtTestsOf(data, m).relationshipTests[0];
    expect(test.conditional).toBe(true);
    expect(test.conditions).toEqual([{ where: 'loaded_at > current_date - 3' }]);
    // The yml still gives the line.
    expect([test.file, test.line]).toEqual(['models/schema.yml', 7]);
  });

  it('a row_condition is said as the condition, from the yml and the manifest alike', async () => {
    const data = await loadYml({ 'models/schema.yml': `
models:
  - name: orders
    columns:
      - name: cid
        tests:
          - relationships: { to: ref('customers'), field: id, config: { row_condition: "cid > 0" } }
` });
    expect(dbtTestsOf(data).relationshipTests[0].conditions).toEqual([{ where: 'cid > 0' }]);
    const m = await loadManifest({
      metadata: {},
      nodes: Object.fromEntries([
        modelNode('model.shop.orders', 'orders', ['cid']),
        testNode('rel', 'model.shop.orders', 'relationships', { column_name: 'cid', to: "ref('customers')", field: 'id', row_condition: 'cid > 0' }),
      ]),
    });
    expect(m.relationshipTests.map((t) => [t.conditional, t.condition])).toEqual([[true, { where: 'cid > 0' }]]);
  });

  it('two tests of one link, one of them plain, still hold for every row', async () => {
    const m = await loadManifest({
      metadata: {},
      nodes: Object.fromEntries([
        modelNode('model.shop.orders', 'orders', ['cid']),
        modelNode('model.shop.customers', 'customers', ['id']),
        testNode('rel', 'model.shop.orders', 'relationships', { column_name: 'cid', to: "ref('customers')", field: 'id' }),
        testNode('relw', 'model.shop.orders', 'relationships', { column_name: 'cid', to: "ref('customers')", field: 'id' }, 'x > 0'),
      ]),
    });
    expect(dbtTestsOf(undefined, m).relationshipTests[0].conditional).toBeUndefined();
  });
});

describe("Not drawn's sources line and the output log", () => {
  it('cuts a long or multi-line source name, and the log lists every source, file and line or not', () => {
    const long = `raw.${'x'.repeat(500)}`;
    const line = dbtSourcesLine([{ name: long, columns: 0 }, { name: 'raw.a\nb', columns: 0 }]);
    expect(line.length).toBeLessThan(400);
    expect(line).not.toContain('\n');

    const sources = Array.from({ length: 25 }, (_, i) => ({ name: `raw.t${i}`, columns: 0, ...(i % 2 ? { file: 'models/src.yml', line: i } : {}) }));
    const draft = { modelNames: [], newModels: [], relationships: [], skipped: [], truncated: false, ledger: [], sources } as unknown as DbtDraft;
    const log = dbtDraftLogLines(draft).join('\n');
    for (const s of sources) expect(log).toContain(s.name);
  });
});
