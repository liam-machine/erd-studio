/**
 * Seeds and snapshots are documented in `seeds:` / `snapshots:` blocks (often
 * under seed-paths / snapshot-paths) and compiled into `seed.` / `snapshot.`
 * manifest nodes. Their descriptions must reach the physical stage (and the
 * CLI inventory) WITHOUT those nodes becoming models: no new existence, no new
 * columns, no new relationships.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCliContext } from '../../src/cli/context';
import { runInventory } from '../../src/cli/inventory';
import { DomainService } from '../../src/services/domainService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import type { UnifiedDomain } from '../../src/types/semantic';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-seed-docs-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function write(rel: string, content: string): void {
  const file = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const SEEDS_YML = `seeds:
  - name: raw_customers
    description: Raw export of customers.
    columns:
      - name: id
        description: Customer id from the source system.
        data_tests:
          - unique
          - relationships:
              to: ref('raw_orders')
              field: customer
`;

const SNAPSHOTS_YML = `snapshots:
  - name: customers_snapshot
    description: Customer history (SCD Type 2).
    relation: ref('stg_customers')
    config:
      unique_key: customer_id
      strategy: check
      check_cols: all
    columns:
      - name: customer_id
        description: Natural key for the customer.
`;

const MODELS_YML = `models:
  - name: stg_customers
    description: Staging customers.
    columns:
      - name: customer_id
        description: Customer key.
`;

function scaffold(opts: { seedYml?: boolean; manifest?: boolean } = {}): void {
  write('dbt_project.yml', 'name: shop\nversion: "1.0.0"\nconfig-version: 2\nprofile: shop\n');
  write('models/stg_customers.sql', 'select 1 as customer_id');
  write('models/_models.yml', MODELS_YML);
  write('seeds/raw_customers.csv', 'id,name\n1,a\n');
  if (opts.seedYml !== false) {
    write('seeds/_seeds.yml', SEEDS_YML);
    write('snapshots/customers_snapshot.yml', SNAPSHOTS_YML);
  }
  write('target/catalog.json', JSON.stringify({
    metadata: {},
    nodes: {
      'seed.shop.raw_customers': {
        metadata: { type: 'BASE TABLE', schema: 'raw', name: 'raw_customers', comment: null },
        columns: {
          id: { type: 'VARCHAR', index: 1, name: 'id', comment: null },
          name: { type: 'VARCHAR', index: 2, name: 'name', comment: null },
        },
      },
      'snapshot.shop.customers_snapshot': {
        metadata: { type: 'BASE TABLE', schema: 'snapshots', name: 'customers_snapshot', comment: null },
        columns: {
          customer_id: { type: 'VARCHAR', index: 1, name: 'customer_id', comment: null },
          dbt_valid_to: { type: 'TIMESTAMP', index: 2, name: 'dbt_valid_to', comment: null },
        },
      },
    },
    sources: {},
  }));
  if (opts.manifest) {
    write('target/manifest.json', JSON.stringify({
      metadata: {},
      nodes: {
        'model.shop.stg_customers': {
          unique_id: 'model.shop.stg_customers', name: 'stg_customers', resource_type: 'model', schema: 'staging',
          description: 'Staging customers.', columns: {}, original_file_path: 'models/stg_customers.sql',
        },
        'seed.shop.raw_customers': {
          unique_id: 'seed.shop.raw_customers', name: 'raw_customers', resource_type: 'seed', schema: 'raw',
          description: 'Manifest: raw customers.',
          columns: { id: { name: 'id', description: 'Manifest: customer id.', data_type: null } },
          original_file_path: 'seeds/raw_customers.csv',
        },
        'snapshot.shop.customers_snapshot': {
          unique_id: 'snapshot.shop.customers_snapshot', name: 'customers_snapshot', resource_type: 'snapshot', schema: 'snapshots',
          description: 'Manifest: customer history.',
          columns: { customer_id: { name: 'customer_id', description: 'Manifest: natural key.', data_type: null } },
          original_file_path: 'snapshots/customers_snapshot.yml',
        },
      },
      disabled: {},
    }));
  }
}

describe('YmlParserService — seeds: / snapshots: documentation', () => {
  it('collects seed and snapshot docs without adding models, tests or uniqueness', async () => {
    scaffold();
    const yml = await new YmlParserService().loadYmlData(tmp);
    expect([...yml.models.keys()]).toEqual(['stg_customers']);
    expect(yml.relationshipTests).toEqual([]);
    expect(yml.uniqueColumns.size).toBe(0);

    const seed = yml.resourceDocs?.get('raw_customers');
    expect(seed).toMatchObject({ resourceType: 'seed', description: 'Raw export of customers.' });
    expect(seed?.columns).toEqual([{ name: 'id', description: 'Customer id from the source system.', dataType: null }]);
    expect(path.relative(tmp, seed!.filePath)).toBe(path.join('seeds', '_seeds.yml'));

    const snap = yml.resourceDocs?.get('customers_snapshot');
    expect(snap).toMatchObject({ resourceType: 'snapshot', description: 'Customer history (SCD Type 2).' });
  });

  it('reads seeds: blocks from a property file under model-paths too', async () => {
    scaffold({ seedYml: false });
    write('models/_seeds.yml', SEEDS_YML);
    const yml = await new YmlParserService().loadYmlData(tmp);
    expect(yml.resourceDocs?.get('raw_customers')?.description).toBe('Raw export of customers.');
    expect(yml.models.has('raw_customers')).toBe(false);
    expect(yml.relationshipTests).toEqual([]);
  });
});

describe('manifest extraction — seed. / snapshot. nodes', () => {
  it('keeps them out of models and exposes them as resourceDocs', () => {
    const r = extractManifestData({
      nodes: {
        'seed.p.raw_x': { unique_id: 'seed.p.raw_x', name: 'raw_x', description: 'Seed X', columns: {} },
        'snapshot.p.snap_x': { unique_id: 'snapshot.p.snap_x', name: 'snap_x', description: 'Snap X', columns: {} },
        'model.p.m': { unique_id: 'model.p.m', name: 'm', description: '', columns: {} },
      },
    });
    expect(Object.keys(r.models)).toEqual(['m']);
    expect(Object.keys(r.resourceDocs ?? {}).sort()).toEqual(['raw_x', 'snap_x']);
    expect(r.resourceDocs?.raw_x.description).toBe('Seed X');
  });
});

describe('physical stage — seed / snapshot descriptions', () => {
  const unified = (names: string[]): UnifiedDomain => ({
    schemaVersion: 5,
    domain: 'd',
    layer: 'silver',
    description: '',
    logical: { models: names.map((name) => ({ name, columns: [] })), relationships: [] },
    viewConfig: {},
  });

  it('adds descriptions but no columns to a file-only seed', async () => {
    scaffold();
    const yml = await new YmlParserService().loadYmlData(tmp);
    const physical = new DomainService().buildPhysicalDomain(unified(['raw_customers']), yml);
    const seed = physical.models[0];
    expect(seed.description).toBe('Raw export of customers.');
    expect(seed.columns).toEqual([]);
    expect(seed.provenance).toEqual({ columns: ['file'], types: 'file' });
    expect(physical.relationships).toEqual([]);
  });

  it('inventory: yml descriptions win, columns and existence unchanged', async () => {
    scaffold({ manifest: true });
    const r = runInventory(await buildCliContext({ project: tmp, semanticDir: '.erd-studio' }));
    const seed = r.models.find((m) => m.name === 'raw_customers')!;
    expect(seed).toMatchObject({ kind: 'seed', description: 'Raw export of customers.', ymlFile: 'seeds/_seeds.yml' });
    expect(seed.columns).toEqual([
      { name: 'id', dataType: 'VARCHAR', description: 'Customer id from the source system.' },
      { name: 'name', dataType: 'VARCHAR', description: '' },
    ]);
    expect(seed.provenance).toEqual({ columns: ['catalog'], types: 'catalog' });

    const snap = r.models.find((m) => m.name === 'customers_snapshot')!;
    expect(snap).toMatchObject({ kind: 'snapshot', description: 'Customer history (SCD Type 2).', ymlFile: 'snapshots/customers_snapshot.yml' });
    expect(snap.columns?.map((c) => c.description)).toEqual(['Natural key for the customer.', '']);
    expect(r.relationships).toEqual([]);
  });

  it('inventory: falls back to the manifest when no seeds:/snapshots: yml is on disk', async () => {
    scaffold({ manifest: true, seedYml: false });
    const r = runInventory(await buildCliContext({ project: tmp, semanticDir: '.erd-studio' }));
    const seed = r.models.find((m) => m.name === 'raw_customers')!;
    expect(seed.description).toBe('Manifest: raw customers.');
    expect(seed.columns?.[0]).toEqual({ name: 'id', dataType: 'VARCHAR', description: 'Manifest: customer id.' });
    expect(seed.ymlFile).toBeNull();
    const snap = r.models.find((m) => m.name === 'customers_snapshot')!;
    expect(snap.description).toBe('Manifest: customer history.');
    expect(snap.columns?.[0].description).toBe('Manifest: natural key.');
  });
});
