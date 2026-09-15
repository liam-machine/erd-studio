import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CatalogService,
  extractCatalogData,
  parseCatalogNodeId,
} from '../../src/services/catalogService';
import { readDbtProjectConfig } from '../../src/services/dbtProjectConfig';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
/** Deliberately catalog-free: the "dbt docs generate has never run" baseline. */
const SPARSE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-sparse');

/** Minimal node body — the tests that care about content spell it out themselves. */
const node = (overrides: Record<string, unknown> = {}) => ({
  metadata: { type: 'BASE TABLE', schema: 'analytics', name: 'relation', database: 'db' },
  columns: {},
  stats: {},
  ...overrides,
});

describe('parseCatalogNodeId', () => {
  it('parses unique_ids, not metadata.name', () => {
    expect(parseCatalogNodeId('model.proj.dim_customer')).toEqual({
      resourceType: 'model',
      name: 'dim_customer',
      version: undefined,
    });
    expect(parseCatalogNodeId('model.proj.dim_customer.v2')).toEqual({
      resourceType: 'model',
      name: 'dim_customer',
      version: '2',
    });
  });

  it('accepts float and arbitrary-string version tokens', () => {
    expect(parseCatalogNodeId('model.proj.m.v1.1')).toEqual({
      resourceType: 'model',
      name: 'm',
      version: '1.1',
    });
    expect(parseCatalogNodeId('model.proj.m.vprod')).toEqual({
      resourceType: 'model',
      name: 'm',
      version: 'prod',
    });
  });

  it('does not mistake a model literally named v2 for a version token', () => {
    expect(parseCatalogNodeId('model.proj.v2')).toEqual({
      resourceType: 'model',
      name: 'v2',
      version: undefined,
    });
  });

  it('keeps seed and snapshot ids and rejects everything else', () => {
    expect(parseCatalogNodeId('seed.proj.seed_status_codes')?.resourceType).toBe('seed');
    expect(parseCatalogNodeId('snapshot.proj.snap_orders')?.resourceType).toBe('snapshot');
    expect(parseCatalogNodeId('test.proj.unique_dim_task_task_id')).toBeNull();
    expect(parseCatalogNodeId('source.proj.raw.raw_payments')).toBeNull();
    expect(parseCatalogNodeId('model.proj')).toBeNull();
  });
});

describe('extractCatalogData', () => {
  it('parses unique_ids and prefers them over an aliased metadata.name', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.dim_customer': node({
          metadata: { name: 'customers_tbl', schema: 'analytics' },
          unique_id: 'model.proj.dim_customer',
        }),
      },
    });

    const info = data.byUniqueId.get('model.proj.dim_customer');
    expect(info?.name).toBe('dim_customer');
    expect(info?.relationName).toBe('customers_tbl');
    expect(data.byName.get('dim_customer')).toBe(info);
  });

  it('falls back to the map key when unique_id is absent', () => {
    const data = extractCatalogData({
      nodes: { 'model.proj.dim_customer': node() },
    });
    expect(data.byUniqueId.get('model.proj.dim_customer')?.uniqueId).toBe(
      'model.proj.dim_customer',
    );
  });

  it('collapses versioned nodes to the highest version in byName while byUniqueId keeps every node', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.dim_customer.v1': node(),
        'model.proj.dim_customer.v10': node(),
        'model.proj.dim_customer.v9': node(),
      },
    });

    expect(data.byUniqueId.size).toBe(3);
    // Numeric compare, so v10 beats v9 (a lexicographic compare would not).
    expect(data.byName.get('dim_customer')?.version).toBe('10');
  });

  it('compares non-numeric version tokens lexicographically', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.m.vprod': node(),
        'model.proj.m.vdev': node(),
      },
    });
    expect(data.byName.get('m')?.version).toBe('prod');
  });

  it('prefers any versioned node over an unversioned one in byName', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.m': node(),
        'model.proj.m.v2': node(),
      },
    });
    expect(data.byName.get('m')?.version).toBe('2');
  });

  it('keeps seed and snapshot nodes and ignores everything else', () => {
    const data = extractCatalogData({
      nodes: {
        'seed.proj.seed_status_codes': node(),
        'snapshot.proj.snap_orders': node(),
        'test.proj.unique_dim_task_task_id': node(),
      },
      sources: {
        'source.proj.raw.raw_payments': node({ columns: { id: { type: 'integer', index: 1 } } }),
      },
    });

    expect([...data.byUniqueId.keys()].sort()).toEqual([
      'seed.proj.seed_status_codes',
      'snapshot.proj.snap_orders',
    ]);
    expect(data.byUniqueId.get('seed.proj.seed_status_codes')?.resourceType).toBe('seed');
    expect(data.byUniqueId.get('snapshot.proj.snap_orders')?.resourceType).toBe('snapshot');
    expect(data.byName.has('raw_payments')).toBe(false);
  });

  it('returns empty maps for missing or non-object nodes', () => {
    for (const catalog of [{}, { nodes: null }, { nodes: [] }, { nodes: 'nope' }]) {
      const data = extractCatalogData(catalog as Record<string, unknown>);
      expect(data.byUniqueId.size).toBe(0);
      expect(data.byName.size).toBe(0);
    }
  });

  it('preserves warehouse column spelling and relation order', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.dim_task': node({
          columns: {
            STATUS: { type: 'TEXT', index: 4, name: 'STATUS', comment: null },
            TASK_ID: { type: 'NUMBER(38,0)', index: 1, name: 'TASK_ID', comment: 'the key' },
            // No `name` key: the map key is the fallback spelling.
            NAME: { type: 'TEXT', index: 3 },
            // No `type`: null, never ''.
            PROJECT_ID: { type: null, index: 2, name: 'PROJECT_ID' },
          },
        }),
      },
    });

    const columns = data.byUniqueId.get('model.proj.dim_task')!.columns;
    expect(columns.map((c) => c.name)).toEqual(['TASK_ID', 'PROJECT_ID', 'NAME', 'STATUS']);
    expect(columns[0].dataType).toBe('NUMBER(38,0)');
    expect(columns[0].comment).toBe('the key');
    expect(columns[1].dataType).toBeNull();
    expect(columns[3].comment).toBeNull();
  });

  it('sorts an index-less column last and skips non-object column entries', () => {
    const data = extractCatalogData({
      nodes: {
        'model.proj.m': node({
          columns: {
            b: { type: 'TEXT' },
            a: { type: 'TEXT', index: 1 },
            junk: 'not an object',
          },
        }),
      },
    });
    expect(data.byUniqueId.get('model.proj.m')!.columns.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('tolerates a node with no columns at all (--empty-catalog)', () => {
    const data = extractCatalogData({
      nodes: { 'model.proj.m': { metadata: { name: 'm', schema: 'analytics' } } },
    });
    expect(data.byUniqueId.get('model.proj.m')!.columns).toEqual([]);
    expect(data.byUniqueId.get('model.proj.m')!.schema).toBe('analytics');
  });

  it('reads metadata and errors', () => {
    const withErrors = extractCatalogData({
      metadata: { generated_at: '2026-02-11T04:12:57.913204Z' },
      nodes: {},
      errors: ['Database Error in model dim_task: permission denied'],
    });
    expect(withErrors.generatedAt).toBe('2026-02-11T04:12:57.913204Z');
    expect(withErrors.partial).toBe(true);

    const clean = extractCatalogData({ metadata: {}, nodes: {}, errors: null });
    expect(clean.generatedAt).toBeNull();
    expect(clean.partial).toBe(false);
  });
});

describe('CatalogService', () => {
  let tmpDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-catalog-'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    warn.mockRestore();
  });

  const writeCatalog = (root: string, content: string, targetPath = 'target') => {
    fs.mkdirSync(path.join(root, targetPath), { recursive: true });
    fs.writeFileSync(path.join(root, targetPath, 'catalog.json'), content, 'utf-8');
  };

  it('reads the fixture project catalog', async () => {
    const data = await new CatalogService().loadCatalog(FIXTURE_PROJECT_PATH);

    expect(data).toBeDefined();
    expect(data!.generatedAt).toBe('2026-02-11T04:12:57.913204Z');
    expect(data!.partial).toBe(false);
    // Four models plus the seed; the `sources` section is ignored.
    expect([...data!.byUniqueId.keys()].sort()).toEqual([
      'model.my_dbt_project.dim_project',
      'model.my_dbt_project.dim_task',
      'model.my_dbt_project.fct_task_event',
      'model.my_dbt_project.stg_raw_payments',
      'seed.my_dbt_project.seed_status_codes',
    ]);

    const dimTask = data!.byUniqueId.get('model.my_dbt_project.dim_task')!;
    expect(dimTask.schema).toBe('SILVER_SCHEMA');
    expect(dimTask.columns.map((c) => c.name)).toEqual([
      'TASK_ID',
      'PROJECT_ID',
      'NAME',
      'STATUS',
    ]);
    // The catalog knows a column the schema .yml never declared.
    expect(
      data!.byUniqueId
        .get('model.my_dbt_project.fct_task_event')!
        .columns.map((c) => c.name),
    ).toContain('loaded_at');
    // …and is missing one the .yml does declare (the stale-catalog case).
    expect(
      data!.byUniqueId.get('model.my_dbt_project.dim_project')!.columns.map((c) => c.name),
    ).not.toContain('project_code');
    // Normalised name index, for when no manifest resolved the model.
    expect(data!.byName.get('dim_task')).toBe(dimTask);
  });

  it('caches the parsed catalog until invalidate()', async () => {
    const service = new CatalogService();
    const first = await service.loadCatalog(FIXTURE_PROJECT_PATH);
    expect(await service.loadCatalog(FIXTURE_PROJECT_PATH)).toBe(first);

    service.invalidate();
    const second = await service.loadCatalog(FIXTURE_PROJECT_PATH);
    expect(second).not.toBe(first);
    expect(second!.byUniqueId.size).toBe(first!.byUniqueId.size);
  });

  it('shares one read between concurrent callers', async () => {
    const service = new CatalogService();
    const [a, b] = await Promise.all([
      service.loadCatalog(FIXTURE_PROJECT_PATH),
      service.loadCatalog(FIXTURE_PROJECT_PATH),
    ]);
    expect(a).toBe(b);
  });

  it('returns undefined — quietly — when there is no catalog', async () => {
    expect(await new CatalogService().loadCatalog(SPARSE_PROJECT_PATH)).toBeUndefined();
    // A missing catalog is the normal state, not something to warn about.
    expect(warn).not.toHaveBeenCalled();
  });

  it('caches the "no catalog" answer too', async () => {
    const service = new CatalogService();
    expect(await service.loadCatalog(tmpDir)).toBeUndefined();
    writeCatalog(tmpDir, JSON.stringify({ nodes: { 'model.p.m': node() } }));
    expect(await service.loadCatalog(tmpDir)).toBeUndefined();

    service.invalidate();
    expect(await service.loadCatalog(tmpDir)).toBeDefined();
  });

  it('returns undefined for malformed JSON', async () => {
    writeCatalog(tmpDir, '{"nodes": {');
    expect(await new CatalogService().loadCatalog(tmpDir)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('returns undefined for a zero-byte catalog (dbt mid-write)', async () => {
    writeCatalog(tmpDir, '');
    expect(await new CatalogService().loadCatalog(tmpDir)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a catalog larger than maxBytes without parsing it', async () => {
    writeCatalog(tmpDir, JSON.stringify({ nodes: { 'model.p.m': node() } }));
    const service = new CatalogService({ maxBytes: 8 });
    expect(await service.loadCatalog(tmpDir)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('limit 8'));
  });

  it('honours a custom target-path from dbt_project.yml', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'dbt_project.yml'),
      'name: proj\ntarget-path: build\n',
      'utf-8',
    );
    writeCatalog(tmpDir, JSON.stringify({ nodes: { 'model.p.m': node() } }), 'build');

    const service = new CatalogService({ dbtConfig: readDbtProjectConfig(tmpDir) });
    expect(service.getCatalogPath(tmpDir)).toBe(path.join(tmpDir, 'build', 'catalog.json'));

    const data = await service.loadCatalog(tmpDir);
    expect(data!.byUniqueId.has('model.p.m')).toBe(true);
    // …and the default target/ location is not silently consulted.
    expect(await new CatalogService().loadCatalog(tmpDir)).toBeUndefined();
  });

  describe('BigQuery nested field paths', () => {
    it('drops STRUCT leaves whose parent column is present', () => {
      // dbt-bigquery aliases `field_path as column_name`, so a STRUCT emits one
      // entry for the parent and one per leaf. Only the parent is a column.
      const data = extractCatalogData({
        nodes: {
          'model.proj.fct_order': node({
            columns: {
              order_id: { name: 'order_id', type: 'INT64', index: 1 },
              address: { name: 'address', type: 'STRUCT<city STRING>', index: 2 },
              'address.city': { name: 'address.city', type: 'STRING', index: 2 },
              'address.postcode': { name: 'address.postcode', type: 'STRING', index: 2 },
            },
          }),
        },
      });

      const names = data.byName.get('fct_order')!.columns.map((c) => c.name);
      expect(names).toEqual(['order_id', 'address']);
    });

    it('keeps a dotted column whose prefix is not itself a column', () => {
      // A quoted identifier, or a nested field the user documented in yml as
      // `- name: address.city` without documenting the parent. Nothing proves
      // it is a leaf, so it survives.
      const data = extractCatalogData({
        nodes: {
          'model.proj.fct_order': node({
            columns: {
              'legacy.code': { name: 'legacy.code', type: 'STRING', index: 1 },
            },
          }),
        },
      });

      expect(data.byName.get('fct_order')!.columns.map((c) => c.name)).toEqual(['legacy.code']);
    });
  });

});
