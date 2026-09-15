import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YmlParserService } from '../../src/services/ymlParserService';

const FIXTURE_PROJECT_PATH = path.resolve(__dirname, '../fixtures/dbt-project');
const MODERN_TESTS_PROJECT_PATH = path.resolve(__dirname, '../fixtures/dbt-project-modern-tests');

describe('YmlParserService', () => {
  let service: YmlParserService;

  beforeEach(() => {
    service = new YmlParserService();
  });

  describe('loadYmlData', () => {
    it('discovers models from .yml files', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      expect(data.models).toBeInstanceOf(Map);
      // Fixture has 7 yml files across silver + gold
      expect(data.models.size).toBe(7);

      const names = Array.from(data.models.keys());
      expect(names).toContain('dim_task');
      expect(names).toContain('dim_project');
      expect(names).toContain('dim_customer');
      expect(names).toContain('fct_sale');
      expect(names).toContain('fct_order');
      expect(names).toContain('fct_task_event');
      expect(names).toContain('dim_date');
    });

    it('extracts model metadata correctly', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('dim_task');

      expect(model).toBeDefined();
      expect(model!.name).toBe('dim_task');
      expect(model!.description).toBe('Task dimension table');
      expect(model!.filePath).toContain('dim_task.yml');
      expect(model!.tags).toContain('silver');
      expect(model!.tags).toContain('domain:showcase');
    });

    it('extracts columns with data types', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('dim_task');

      expect(model!.columns).toHaveLength(4);

      const taskId = model!.columns.find((c) => c.name === 'task_id');
      expect(taskId).toBeDefined();
      expect(taskId!.description).toBe('Surrogate key for task');
      expect(taskId!.dataType).toBeNull(); // No data_type declared

      const status = model!.columns.find((c) => c.name === 'status');
      expect(status).toBeDefined();
      expect(status!.dataType).toBe('STRING');
    });

    it('extracts columns from fct_sale with data types', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('fct_sale');

      expect(model!.columns).toHaveLength(3);

      const saleId = model!.columns.find((c) => c.name === 'sale_id');
      expect(saleId!.dataType).toBe('INT');

      const amount = model!.columns.find((c) => c.name === 'amount');
      expect(amount!.dataType).toBe('DECIMAL');
    });

    it('extracts relationship tests from column-level tests', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      // dim_task.task_id -> fct_sale.amount
      // fct_sale.sale_id -> dim_project.project_id
      expect(data.relationshipTests.length).toBeGreaterThanOrEqual(2);

      const taskRel = data.relationshipTests.find(
        (t) => t.fromModel === 'dim_task' && t.fromColumn === 'task_id',
      );
      expect(taskRel).toBeDefined();
      expect(taskRel!.toModel).toBe('fct_sale');
      expect(taskRel!.toColumn).toBe('amount');

      const saleRel = data.relationshipTests.find(
        (t) => t.fromModel === 'fct_sale' && t.fromColumn === 'sale_id',
      );
      expect(saleRel).toBeDefined();
      expect(saleRel!.toModel).toBe('dim_project');
      expect(saleRel!.toColumn).toBe('project_id');
    });

    it('extracts tags from config block', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      const dimProject = data.models.get('dim_project');
      expect(dimProject!.tags).toContain('silver');
      expect(dimProject!.tags).toContain('domain:tasks');
      expect(dimProject!.tags).toContain('domain:showcase');

      const fctTaskEvent = data.models.get('fct_task_event');
      expect(fctTaskEvent!.tags).toContain('gold');
      expect(fctTaskEvent!.tags).toContain('daily');
    });

    it('handles models with no tests gracefully', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('fct_task_event');

      // fct_task_event has no tests at all in its yml
      expect(model).toBeDefined();
      expect(model!.columns).toHaveLength(4);

      // Should have no relationship tests for this model
      const relTests = data.relationshipTests.filter(
        (t) => t.fromModel === 'fct_task_event',
      );
      expect(relTests).toHaveLength(0);
    });

    it('handles models with no data_type on columns', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('fct_task_event');

      // fct_task_event has no data_type on any column
      for (const col of model!.columns) {
        expect(col.dataType).toBeNull();
      }
    });
  });

  describe('caching', () => {
    it('returns cached data on subsequent calls', async () => {
      const data1 = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const data2 = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      expect(data1).toBe(data2); // Same reference
    });

    it('re-parses after invalidate()', async () => {
      const data1 = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      service.invalidate();
      const data2 = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      expect(data1).not.toBe(data2); // Different reference
      expect(data2.models.size).toBe(data1.models.size); // Same content
    });
  });

  describe('folder filtering', () => {
    it('filters models by folder prefix', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH, 'models/silver');

      // Silver models: dim_task, dim_project, dim_customer, fct_sale, fct_order
      expect(data.models.size).toBe(5);
      expect(data.models.has('dim_task')).toBe(true);
      expect(data.models.has('dim_project')).toBe(true);
      expect(data.models.has('dim_customer')).toBe(true);
      expect(data.models.has('fct_sale')).toBe(true);
      expect(data.models.has('fct_order')).toBe(true);
      expect(data.models.has('fct_task_event')).toBe(false);
    });

    it('filters models by gold folder', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH, 'models/gold');

      // Gold models: fct_task_event, dim_date
      expect(data.models.size).toBe(2);
      expect(data.models.has('fct_task_event')).toBe(true);
      expect(data.models.has('dim_date')).toBe(true);
    });

    it('filters relationship tests to scoped models', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH, 'models/gold');

      // fct_task_event has no relationship tests, and cross-folder rels are excluded
      expect(data.relationshipTests).toHaveLength(0);
    });
  });

  describe('getModelFolders', () => {
    it('returns unique model folder prefixes', async () => {
      await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const folders = service.getModelFolders(FIXTURE_PROJECT_PATH);

      expect(folders).toContain('models/silver');
      expect(folders).toContain('models/gold');
      expect(folders).toHaveLength(2);
    });

    it('returns sorted folders', async () => {
      await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const folders = service.getModelFolders(FIXTURE_PROJECT_PATH);

      expect(folders).toEqual(['models/gold', 'models/silver']);
    });

    it('returns empty when cache is empty', () => {
      const folders = service.getModelFolders(FIXTURE_PROJECT_PATH);
      expect(folders).toEqual([]);
    });
  });

  describe('walk scope (H31 / H30)', () => {
    let tmpDir: string;

    const schema = (name: string, extra = '') =>
      `version: 2\nmodels:\n  - name: ${name}\n    description: ${name} desc${extra}\n`;

    const writeYml = (rel: string, content: string) => {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf-8');
    };

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-walk-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('ignores schema files in dbt_packages/, dbt_modules/, logs/ and venvs', async () => {
      writeYml('models/silver/dim_customer.yml', schema('dim_customer'));
      writeYml('models/dbt_packages/pkg/models/leaked.yml', schema('leaked_via_nested_packages'));
      writeYml('models/dbt_modules/pkg/models/old.yml', schema('leaked_via_dbt_modules'));
      writeYml('models/logs/x.yml', schema('leaked_via_logs'));
      writeYml('models/env/lib/site-packages/x.yml', schema('leaked_via_env'));
      writeYml('models/.direnv/x.yml', schema('leaked_via_direnv'));
      writeYml('models/target/x.yml', schema('leaked_via_target'));

      const data = await service.loadYmlData(tmpDir);
      expect(Array.from(data.models.keys())).toEqual(['dim_customer']);
    });

    it('does not let a package model shadow a project model of the same name', async () => {
      writeYml('models/silver/dim_customer.yml', schema('dim_customer', '\n    columns:\n      - name: customer_id\n        tests: [unique]'));
      writeYml(
        'dbt_packages/dbt_project_evaluator/models/dim_customer.yml',
        schema('dim_customer', '\n    columns:\n      - name: pkg_col\n        tests:\n          - relationships: { to: ref(\'other\'), field: id }'),
      );
      writeYml('dbt_packages/elementary/models/elementary_test_results.yml', schema('elementary_test_results'));

      const data = await service.loadYmlData(tmpDir);
      expect(data.models.has('elementary_test_results')).toBe(false);
      const model = data.models.get('dim_customer')!;
      expect(model.filePath).toContain(path.join('models', 'silver'));
      expect(model.columns.map((c) => c.name)).toEqual(['customer_id']);
      // Package tests are not merged into the project's test data either
      expect(data.relationshipTests).toEqual([]);
      expect(data.uniqueColumns.get('dim_customer')?.has('customer_id')).toBe(true);
    });

    it('only walks the configured model-paths', async () => {
      writeYml('models/a.yml', schema('in_models'));
      writeYml('transform/marts/b.yml', schema('in_transform'));
      writeYml('seeds/c.yml', schema('in_seeds'));

      const defaults = await new YmlParserService().loadYmlData(tmpDir);
      expect(Array.from(defaults.models.keys())).toEqual(['in_models']);

      const custom = new YmlParserService({ dbtConfig: { modelPaths: ['transform'] } });
      const data = await custom.loadYmlData(tmpDir);
      expect(Array.from(data.models.keys())).toEqual(['in_transform']);
      expect(custom.getModelFolders(tmpDir)).toEqual(['transform/marts']);

      const multi = new YmlParserService({ dbtConfig: { modelPaths: ['models', 'transform'] } });
      const both = await multi.loadYmlData(tmpDir);
      expect(Array.from(both.models.keys()).sort()).toEqual(['in_models', 'in_transform']);
    });

    it('falls back to models/ when modelPaths is empty', async () => {
      writeYml('models/a.yml', schema('in_models'));
      const svc = new YmlParserService({ dbtConfig: { modelPaths: [] } });
      const data = await svc.loadYmlData(tmpDir);
      expect(Array.from(data.models.keys())).toEqual(['in_models']);
    });
  });

  describe('source file index (physical existence without a manifest)', () => {
    let tmpDir: string;

    const write = (rel: string, content: string) => {
      const full = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf-8');
    };

    const schema = (name: string) =>
      `version: 2\nmodels:\n  - name: ${name}\n    description: ${name} desc\n`;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yml-sources-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('indexes .sql, .py and .csv files under model, seed and snapshot paths', async () => {
      write('models/silver/dim_customer.sql', 'select 1');
      write('models/gold/fct_churn.py', 'def model(dbt, session): ...');
      write('seeds/seed_status_codes.csv', 'code,label\n1,open\n');
      write('snapshots/snap_customer.sql', '{% snapshot snap_customer %}{% endsnapshot %}');

      const data = await service.loadYmlData(tmpDir);

      expect(Array.from(data.sourceFiles!.keys()).sort()).toEqual([
        'dim_customer',
        'fct_churn',
        'seed_status_codes',
        'snap_customer',
      ]);
      expect(data.sourceFiles!.get('dim_customer')).toBe('models/silver/dim_customer.sql');
      expect(data.sourceFiles!.get('seed_status_codes')).toBe('seeds/seed_status_codes.csv');
      expect(data.sourceFiles!.get('snap_customer')).toBe('snapshots/snap_customer.sql');
    });

    it('normalises the stem so a case-mismatched name still resolves', async () => {
      write('models/DIM_Customer.SQL', 'select 1');

      const data = await service.loadYmlData(tmpDir);

      expect(data.sourceFiles!.has('dim_customer')).toBe(true);
      expect(data.sourceFiles!.get('dim_customer')).toBe('models/DIM_Customer.SQL');
    });

    it('skips source files under excluded directories', async () => {
      write('models/silver/dim_customer.sql', 'select 1');
      write('models/dbt_packages/pkg/models/vendored.sql', 'select 1');
      write('models/.venv/lib/site-packages/leaked.py', 'x = 1');
      write('models/target/compiled/dim_customer_compiled.sql', 'select 1');

      const data = await service.loadYmlData(tmpDir);

      expect(Array.from(data.sourceFiles!.keys())).toEqual(['dim_customer']);
    });

    it('resolves a stem present as both .sql and .py exactly once', async () => {
      write('models/silver/dim_customer.sql', 'select 1');
      write('models/silver/dim_customer.py', 'def model(dbt, session): ...');

      const data = await service.loadYmlData(tmpDir);

      expect(Array.from(data.sourceFiles!.keys())).toEqual(['dim_customer']);
      // First entry wins; which one that is depends on readdir order, which is
      // not alphabetical on every filesystem — the point is that it is one of
      // them, once.
      expect(['models/silver/dim_customer.sql', 'models/silver/dim_customer.py']).toContain(
        data.sourceFiles!.get('dim_customer'),
      );
    });

    it('walks seed and snapshot roots for source files without parsing their schema yml', async () => {
      write('seeds/seed_status_codes.csv', 'code,label\n1,open\n');
      write('seeds/schema.yml', schema('seed_status_codes'));
      write('snapshots/snap_customer.sql', '{% snapshot snap_customer %}{% endsnapshot %}');
      write('snapshots/schema.yml', schema('snap_customer'));

      const data = await service.loadYmlData(tmpDir);

      expect(data.models.size).toBe(0);
      expect(Array.from(data.sourceFiles!.keys()).sort()).toEqual([
        'seed_status_codes',
        'snap_customer',
      ]);
    });

    it('honours configured seed-paths and snapshot-paths', async () => {
      write('data/legacy_seed.csv', 'a\n1\n');
      write('history/snap_order.sql', 'select 1');
      write('seeds/ignored.csv', 'a\n1\n');

      const custom = new YmlParserService({
        dbtConfig: { modelPaths: ['models'], seedPaths: ['data'], snapshotPaths: ['history'] },
      });
      const data = await custom.loadYmlData(tmpDir);

      expect(Array.from(data.sourceFiles!.keys()).sort()).toEqual([
        'legacy_seed',
        'snap_order',
      ]);
    });

    it('walks a root nested inside another exactly once', async () => {
      write('models/seeds/seed_status_codes.csv', 'a\n1\n');

      const custom = new YmlParserService({
        dbtConfig: { modelPaths: ['models'], seedPaths: ['models/seeds'] },
      });
      const data = await custom.loadYmlData(tmpDir);

      expect(data.sourceFiles!.get('seed_status_codes')).toBe(
        'models/seeds/seed_status_codes.csv',
      );
    });

    it('filters source files by model folder', async () => {
      write('models/silver/dim_customer.sql', 'select 1');
      write('models/gold/fct_churn.sql', 'select 1');
      write('seeds/seed_status_codes.csv', 'a\n1\n');

      const data = await service.loadYmlData(tmpDir, 'models/silver');

      expect(Array.from(data.sourceFiles!.keys())).toEqual(['dim_customer']);
    });

    it('indexes a fixture model that has no .yml and no manifest node', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      expect(data.sourceFiles!.get('dim_region')).toBe('models/silver/dim_region.sql');
      // ...and it contributes nothing to the schema-derived model list.
      expect(data.models.has('dim_region')).toBe(false);
    });
  });

  describe('graceful degradation', () => {
    it('returns empty data for non-existent directory', async () => {
      const data = await service.loadYmlData('/nonexistent/path');

      expect(data.models.size).toBe(0);
      expect(data.relationshipTests).toHaveLength(0);
      expect(data.uniqueColumns.size).toBe(0);
      expect(data.compositeUniqueGroups.size).toBe(0);
      expect(data.sourceFiles!.size).toBe(0);
    });
  });

  describe('ref() parsing', () => {
    it('extracts model name from single-arg ref()', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);

      // ref('fct_sale') in dim_task.yml
      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'dim_task',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('fct_sale');
    });
  });

  describe('modern dbt test syntax (data_tests, unique map form, arguments) — H09/H10', () => {
    it('reads column-level `data_tests:` scalar unique tests', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      expect(data.models.size).toBe(4);
      expect(data.uniqueColumns.get('dim_customer')?.has('customer_id')).toBe(true);
      expect(data.uniqueColumns.get('fct_orders')?.has('order_id')).toBe(true);
    });

    it('recognises `unique` in map form carrying config under `tests:`', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      expect(data.uniqueColumns.get('dim_product')?.has('product_id')).toBe(true);
    });

    it('recognises `unique:` with an empty value under `data_tests:`', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      expect(data.uniqueColumns.get('fct_shipments')?.has('shipment_id')).toBe(true);
    });

    it('reads relationships tests declared under `data_tests:`', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'fct_orders' && t.fromColumn === 'customer_id',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('dim_customer');
      expect(rel!.toColumn).toBe('customer_id');
    });

    it("accepts versioned ref('model', v=N) targets", async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'fct_orders' && t.fromColumn === 'product_id',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('dim_product');
    });

    it('reads relationships kwargs nested under dbt 1.10 `arguments:`', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'fct_shipments' && t.fromColumn === 'order_id',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('fct_orders');
      expect(rel!.toColumn).toBe('order_id');
    });

    it("accepts two-arg ref('project', 'model', version=N) under `arguments:`", async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'fct_shipments' && t.fromColumn === 'customer_id',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('dim_customer');
      expect(rel!.toColumn).toBe('customer_id');
    });

    it('extracts all four relationship tests across tests/data_tests/arguments forms', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      expect(data.relationshipTests).toHaveLength(4);
    });

    it('reads model-level unique_combination_of_columns nested under `arguments:`', async () => {
      const data = await service.loadYmlData(MODERN_TESTS_PROJECT_PATH);

      expect(data.compositeUniqueGroups.get('fct_orders')).toEqual([['order_id', 'product_id']]);
    });
  });
});
