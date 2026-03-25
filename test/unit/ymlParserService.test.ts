import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { YmlParserService } from '../../src/services/ymlParserService';

const FIXTURE_PROJECT_PATH = path.resolve(__dirname, '../fixtures/dbt-project');

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
      expect(names).toContain('dim_work_lot');
      expect(names).toContain('dim_project');
      expect(names).toContain('dim_customer');
      expect(names).toContain('fct_sale');
      expect(names).toContain('fct_order');
      expect(names).toContain('fct_work_events');
      expect(names).toContain('dim_date');
    });

    it('extracts model metadata correctly', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('dim_work_lot');

      expect(model).toBeDefined();
      expect(model!.name).toBe('dim_work_lot');
      expect(model!.description).toBe('Work lot dimension table');
      expect(model!.filePath).toContain('dim_work_lot.yml');
      expect(model!.tags).toContain('silver');
      expect(model!.tags).toContain('domain:showcase');
    });

    it('extracts columns with data types', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('dim_work_lot');

      expect(model!.columns).toHaveLength(4);

      const workLotId = model!.columns.find((c) => c.name === 'work_lot_id');
      expect(workLotId).toBeDefined();
      expect(workLotId!.description).toBe('Surrogate key for work lot');
      expect(workLotId!.dataType).toBeNull(); // No data_type declared

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

      // dim_work_lot.work_lot_id -> fct_sale.amount
      // fct_sale.sale_id -> dim_project.project_id
      expect(data.relationshipTests.length).toBeGreaterThanOrEqual(2);

      const workLotRel = data.relationshipTests.find(
        (t) => t.fromModel === 'dim_work_lot' && t.fromColumn === 'work_lot_id',
      );
      expect(workLotRel).toBeDefined();
      expect(workLotRel!.toModel).toBe('fct_sale');
      expect(workLotRel!.toColumn).toBe('amount');

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
      expect(dimProject!.tags).toContain('domain:work-lots');
      expect(dimProject!.tags).toContain('domain:showcase');

      const fctWorkEvents = data.models.get('fct_work_events');
      expect(fctWorkEvents!.tags).toContain('gold');
      expect(fctWorkEvents!.tags).toContain('daily');
    });

    it('handles models with no tests gracefully', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('fct_work_events');

      // fct_work_events has no tests at all in its yml
      expect(model).toBeDefined();
      expect(model!.columns).toHaveLength(4);

      // Should have no relationship tests for this model
      const relTests = data.relationshipTests.filter(
        (t) => t.fromModel === 'fct_work_events',
      );
      expect(relTests).toHaveLength(0);
    });

    it('handles models with no data_type on columns', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH);
      const model = data.models.get('fct_work_events');

      // fct_work_events has no data_type on any column
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

      // Silver models: dim_work_lot, dim_project, dim_customer, fct_sale, fct_order
      expect(data.models.size).toBe(5);
      expect(data.models.has('dim_work_lot')).toBe(true);
      expect(data.models.has('dim_project')).toBe(true);
      expect(data.models.has('dim_customer')).toBe(true);
      expect(data.models.has('fct_sale')).toBe(true);
      expect(data.models.has('fct_order')).toBe(true);
      expect(data.models.has('fct_work_events')).toBe(false);
    });

    it('filters models by gold folder', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH, 'models/gold');

      // Gold models: fct_work_events, dim_date
      expect(data.models.size).toBe(2);
      expect(data.models.has('fct_work_events')).toBe(true);
      expect(data.models.has('dim_date')).toBe(true);
    });

    it('filters relationship tests to scoped models', async () => {
      const data = await service.loadYmlData(FIXTURE_PROJECT_PATH, 'models/gold');

      // fct_work_events has no relationship tests, and cross-folder rels are excluded
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

      // ref('fct_sale') in dim_work_lot.yml
      const rel = data.relationshipTests.find(
        (t) => t.fromModel === 'dim_work_lot',
      );
      expect(rel).toBeDefined();
      expect(rel!.toModel).toBe('fct_sale');
    });
  });
});
