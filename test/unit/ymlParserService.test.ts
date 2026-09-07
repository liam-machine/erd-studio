import { describe, it, expect, beforeEach } from 'vitest';
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

  describe('graceful degradation', () => {
    it('returns empty data for non-existent directory', async () => {
      const data = await service.loadYmlData('/nonexistent/path');

      expect(data.models.size).toBe(0);
      expect(data.relationshipTests).toHaveLength(0);
      expect(data.uniqueColumns.size).toBe(0);
      expect(data.compositeUniqueGroups.size).toBe(0);
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
