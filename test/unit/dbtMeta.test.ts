/**
 * dbt's own `meta:` — read from schema yml and the manifest for the CLI
 * inventory, and summarised as `inventory.conventions.meta` so the setup skill
 * can offer to carry it onto the logical models (#95). The physical stage and
 * the diff never read it; `displayDomainGolden.test.ts` pins that side.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCliContext } from '../../src/cli/context';
import { formatInventory, makePaint } from '../../src/cli/format';
import { runInventory } from '../../src/cli/inventory';
import { detectMetaConventions, META_EXAMPLE_LENGTH } from '../../src/cli/metaConventions';
import { YmlParserService } from '../../src/services/ymlParserService';
import { extractManifestData } from '../../src/workers/manifestExtractor';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-meta-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const SCHEMA_YML = `version: 2
models:
  - name: dim_customer
    description: One row per customer
    meta:
      owner: crm-team
      tier: 1
    config:
      meta:
        owner: customer-data-team
        contains_pii: true
    columns:
      - name: customer_id
        description: Surrogate key
      - name: email
        meta:
          pii: true
        config:
          meta:
            classification: confidential
  - name: fct_order
    config:
      meta:
        owner: sales-analytics
    columns:
      - name: order_id
        meta: {}
`;

function makeProject(files: Record<string, string>): string {
  fs.writeFileSync(path.join(tmp, 'dbt_project.yml'), 'name: tmp\nprofile: tmp\nmodel-paths: ["models"]\n');
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return tmp;
}

describe('YmlParserService meta', () => {
  it('reads model and column meta, merging config: meta: over meta: per key', async () => {
    const data = await new YmlParserService().loadYmlData(makeProject({ 'models/marts/_models.yml': SCHEMA_YML }));
    const customer = data.models.get('dim_customer')!;

    // Numbers read as their text, like every other meta value.
    expect(customer.meta).toEqual({ owner: 'customer-data-team', tier: '1', contains_pii: true });
    expect(customer.columns.find((c) => c.name === 'email')!.meta).toEqual({ pii: true, classification: 'confidential' });
    expect(customer.columns.find((c) => c.name === 'customer_id')).not.toHaveProperty('meta');
    expect(data.models.get('fct_order')!.meta).toEqual({ owner: 'sales-analytics' });
    // An empty map is no meta at all.
    expect(data.models.get('fct_order')!.columns[0]).not.toHaveProperty('meta');
  });
});

describe('YmlParserService meta — anchors, aliases and merge keys', () => {
  it('resolves them as dbt does', async () => {
    const data = await new YmlParserService().loadYmlData(makeProject({
      'models/marts/_models.yml': `version: 2
models:
  - name: dim_customer
    meta: &shared
      owner: &team crm-team
      backup_contact: *team
  - name: dim_region
    meta: *shared
  - name: fct_order
    meta:
      <<: *shared
      owner: sales-analytics
`,
    }));
    expect(data.models.get('dim_customer')!.meta).toEqual({ owner: 'crm-team', backup_contact: 'crm-team' });
    expect(data.models.get('dim_region')!.meta).toEqual({ owner: 'crm-team', backup_contact: 'crm-team' });
    expect(data.models.get('fct_order')!.meta).toEqual({ owner: 'sales-analytics', backup_contact: 'crm-team' });
  });
});

describe('extractManifestData meta', () => {
  it('reads node and column meta, config.meta winning per key', () => {
    const result = extractManifestData({
      nodes: {
        'model.p.dim_customer': {
          unique_id: 'model.p.dim_customer',
          name: 'dim_customer',
          schema: 'gold',
          description: '',
          meta: { owner: 'crm-team', lineage: { upstream: ['stg_a'] } },
          config: { meta: { owner: 'customer-data-team', sla_hours: 24 } },
          columns: {
            email: { name: 'email', description: '', data_type: null, meta: { pii: true }, config: { meta: {} } },
            id: { name: 'id', description: '', data_type: null, meta: {} },
          },
        },
      },
    });
    const model = result.models.dim_customer;
    expect(model.meta).toEqual({ owner: 'customer-data-team', lineage: { upstream: ['stg_a'] }, sla_hours: '24' });
    expect(model.columns.find((c) => c.name === 'email')!.meta).toEqual({ pii: true });
    expect(model.columns.find((c) => c.name === 'id')).not.toHaveProperty('meta');
  });
});

describe('inventory meta', () => {
  it('reports each model and column meta, and summarises the keys project-wide', async () => {
    const root = makeProject({
      'models/marts/_models.yml': SCHEMA_YML,
      'models/marts/dim_customer.sql': 'select 1',
      'models/marts/fct_order.sql': 'select 1',
      'models/marts/dim_date.sql': 'select 1',
    });
    const r = runInventory(await buildCliContext({ project: root, semanticDir: '.erd-studio' }));
    const customer = r.models.find((m) => m.name === 'dim_customer')!;

    expect(customer.meta).toEqual({ owner: 'customer-data-team', tier: '1', contains_pii: true });
    expect(customer.columns!.find((c) => c.name === 'email')!.meta).toEqual({ pii: true, classification: 'confidential' });
    expect(r.models.find((m) => m.name === 'dim_date')).not.toHaveProperty('meta');

    expect(r.conventions.meta).toEqual({
      totalModels: 3,
      modelsWithMeta: 2,
      models: [
        { key: 'owner', count: 2, kind: 'text', examples: ['customer-data-team', 'sales-analytics'] },
        { key: 'contains_pii', count: 1, kind: 'yes-no', examples: ['true'] },
        { key: 'tier', count: 1, kind: 'text', examples: ['1'] },
      ],
      columns: [
        { key: 'classification', count: 1, models: 1, kind: 'text', examples: ['confidential'] },
        { key: 'pii', count: 1, models: 1, kind: 'yes-no', examples: ['true'] },
      ],
    });
  });

  it('--summary drops the values but keeps the project-wide summary; --models keeps it project-wide', async () => {
    const root = makeProject({ 'models/marts/_models.yml': SCHEMA_YML });
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const summary = runInventory(ctx, { summary: true });
    expect(summary.models.some((m) => 'meta' in m)).toBe(false);
    expect(summary.conventions.meta.modelsWithMeta).toBe(2);

    const scoped = runInventory(ctx, { models: ['fct_order'] });
    expect(scoped.models.map((m) => m.name)).toEqual(['fct_order']);
    expect(scoped.conventions.meta.models[0]).toMatchObject({ key: 'owner', count: 2 });
  });

  it('prints a meta line in the human output only when dbt records any', async () => {
    const paint = makePaint(false);
    const withMeta = runInventory(await buildCliContext({ project: makeProject({ 'models/marts/_models.yml': SCHEMA_YML }), semanticDir: '.erd-studio' }));
    const text = formatInventory(withMeta, paint);
    expect(text).toContain('meta: on 2 of 2 models');
    expect(text).toContain('models: owner (2), contains_pii (1), tier (1)');
    expect(text).toContain('columns: classification (1), pii (1)');

    fs.rmSync(path.join(tmp, 'models'), { recursive: true, force: true });
    fs.mkdirSync(path.join(tmp, 'models'));
    fs.writeFileSync(path.join(tmp, 'models', 'a.sql'), 'select 1');
    const without = runInventory(await buildCliContext({ project: tmp, semanticDir: '.erd-studio' }));
    expect(formatInventory(without, paint)).not.toContain('meta:');
  });
});

describe('detectMetaConventions (pure)', () => {
  it('keeps the most common kind, distinct examples and shortens long values', () => {
    const long = 'x'.repeat(100);
    const r = detectMetaConventions([
      { meta: { owner: 'a' } },
      { meta: { owner: 'a' } },
      { meta: { owner: ['a', 'b'] } },
      { meta: { owner: long } },
      { meta: { owner: 'c' } },
    ]);
    expect(r.models).toEqual([{ key: 'owner', count: 5, kind: 'text', examples: ['a', '[a, b]', `${'x'.repeat(META_EXAMPLE_LENGTH - 1)}…`] }]);
    expect(r.modelsWithMeta).toBe(5);
  });

  it('counts a column key once per column and once per model for `models`', () => {
    const r = detectMetaConventions([
      { columns: [{ meta: { pii: true } }, { meta: { pii: false } }] },
      { columns: [{ meta: { pii: true } }, {}] },
      {},
    ]);
    expect(r.columns).toEqual([{ key: 'pii', count: 3, models: 2, kind: 'yes-no', examples: ['true', 'false'] }]);
    expect(r).toMatchObject({ totalModels: 3, modelsWithMeta: 2, models: [] });
  });
});
