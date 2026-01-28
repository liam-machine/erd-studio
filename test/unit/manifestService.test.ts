import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { ManifestService } from '../../src/services/manifestService';

/**
 * The fixture project root is test/fixtures/ which contains
 * target/manifest.json (we symlink or place the sample there).
 *
 * For these tests, the sample-manifest.json lives at test/fixtures/
 * and we set up the expected path structure.
 */
const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

// The ManifestService expects {projectPath}/target/manifest.json,
// so our fixture project root needs a target/ subdirectory.
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
const MALFORMED_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-malformed');
const SPARSE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-sparse');

describe('ManifestService', () => {
  let service: ManifestService;

  beforeEach(() => {
    service = new ManifestService();
  });

  describe('loadManifest', () => {
    it('parses a sample manifest and returns model data', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(data).toBeDefined();
      expect(data.models).toBeInstanceOf(Map);
      // Should have 3 models (dim_work_lot, dim_project, fct_work_events)
      expect(data.models.size).toBe(3);
    });

    it('extracts only model nodes, skipping tests, seeds, and other node types', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);
      const names = Array.from(data.models.keys());

      expect(names).toContain('dim_work_lot');
      expect(names).toContain('dim_project');
      expect(names).toContain('fct_work_events');
      // Should NOT contain test or seed nodes
      expect(names).not.toContain('not_null_dim_work_lot_work_lot_id');
      expect(names).not.toContain('seed_status_codes');
    });

    it('extracts model metadata correctly', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);
      const model = data.models.get('dim_work_lot');

      expect(model).toBeDefined();
      expect(model!.name).toBe('dim_work_lot');
      expect(model!.uniqueId).toBe('model.my_dbt_project.dim_work_lot');
      expect(model!.projectName).toBe('my_dbt_project');
      expect(model!.schema).toBe('silver');
      expect(model!.description).toBe('Work lot dimension table');
    });

    it('returns cached data on subsequent calls without re-parsing', async () => {
      const data1 = await service.loadManifest(FIXTURE_PROJECT_PATH);
      const data2 = await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(data1).toBe(data2); // Same reference — cached
    });

    it('returns empty ManifestData when manifest file does not exist', async () => {
      const data = await service.loadManifest('/nonexistent/path');

      expect(data).toBeDefined();
      expect(data.models.size).toBe(0);
    });

    it('deduplicates concurrent calls', async () => {
      // Two concurrent calls should result in the same promise
      const [data1, data2] = await Promise.all([
        service.loadManifest(FIXTURE_PROJECT_PATH),
        service.loadManifest(FIXTURE_PROJECT_PATH),
      ]);

      expect(data1).toBe(data2); // Same reference
    });
  });

  describe('getModelColumns', () => {
    it('returns correct columns for a known model', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      const columns = service.getModelColumns('dim_work_lot');

      expect(columns).toHaveLength(4);

      const colNames = columns.map((c) => c.name);
      expect(colNames).toContain('work_lot_id');
      expect(colNames).toContain('project_id');
      expect(colNames).toContain('name');
      expect(colNames).toContain('status');
    });

    it('returns column data types and descriptions', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      const columns = service.getModelColumns('dim_work_lot');

      const pkCol = columns.find((c) => c.name === 'work_lot_id');
      expect(pkCol).toBeDefined();
      expect(pkCol!.data_type).toBe('INT');
      expect(pkCol!.description).toBe('Surrogate key for work lot');
    });

    it('returns empty array for non-existent model', () => {
      const columns = service.getModelColumns('nonexistent_model');
      expect(columns).toEqual([]);
    });

    it('returns empty array when manifest has not been loaded', () => {
      const columns = service.getModelColumns('dim_work_lot');
      expect(columns).toEqual([]);
    });
  });

  describe('hasModel', () => {
    it('returns true for existing models', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(service.hasModel('dim_work_lot')).toBe(true);
      expect(service.hasModel('dim_project')).toBe(true);
      expect(service.hasModel('fct_work_events')).toBe(true);
    });

    it('returns false for non-existent models', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(service.hasModel('nonexistent_model')).toBe(false);
    });

    it('returns false for non-model nodes (tests, seeds)', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(service.hasModel('not_null_dim_work_lot_work_lot_id')).toBe(false);
      expect(service.hasModel('seed_status_codes')).toBe(false);
    });

    it('returns false when manifest has not been loaded', () => {
      expect(service.hasModel('dim_work_lot')).toBe(false);
    });
  });

  describe('getModelNames', () => {
    it('returns all model names after loading', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      const names = service.getModelNames();

      expect(names).toHaveLength(3);
      expect(names).toContain('dim_work_lot');
      expect(names).toContain('dim_project');
      expect(names).toContain('fct_work_events');
    });

    it('returns empty array when manifest has not been loaded', () => {
      const names = service.getModelNames();
      expect(names).toEqual([]);
    });
  });

  describe('getModel', () => {
    it('returns full model info for a known model', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      const model = service.getModel('dim_project');

      expect(model).toBeDefined();
      expect(model!.name).toBe('dim_project');
      expect(model!.schema).toBe('silver');
      expect(model!.columns).toHaveLength(2);
    });

    it('returns undefined for unknown model', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(service.getModel('nonexistent')).toBeUndefined();
    });
  });

  describe('invalidate', () => {
    it('clears cache so next loadManifest re-parses', async () => {
      const data1 = await service.loadManifest(FIXTURE_PROJECT_PATH);
      service.invalidate();
      const data2 = await service.loadManifest(FIXTURE_PROJECT_PATH);

      // After invalidation, should be a new object (re-parsed)
      expect(data1).not.toBe(data2);
      // But should contain the same data
      expect(data2.models.size).toBe(3);
    });

    it('clears cached model lookups', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(service.hasModel('dim_work_lot')).toBe(true);

      service.invalidate();

      // After invalidation, cache is cleared
      expect(service.hasModel('dim_work_lot')).toBe(false);
      expect(service.getModelColumns('dim_work_lot')).toEqual([]);
      expect(service.getModelNames()).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('rejects when manifest JSON is malformed', async () => {
      await expect(
        service.loadManifest(MALFORMED_PROJECT_PATH)
      ).rejects.toThrow('Failed to parse manifest.json');
    });

    it('handles models with missing columns field gracefully', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);
      const model = data.models.get('no_columns');

      expect(model).toBeDefined();
      expect(model!.columns).toEqual([]);
    });

    it('handles models with empty columns object', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);
      const model = data.models.get('empty_columns');

      expect(model).toBeDefined();
      expect(model!.columns).toEqual([]);
    });

    it('handles models with null field values', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);
      const model = data.models.get('null_fields');

      expect(model).toBeDefined();
      expect(model!.schema).toBe('');
      expect(model!.description).toBe('');
      expect(model!.columns).toHaveLength(1);
      expect(model!.columns[0].data_type).toBeNull();
      expect(model!.columns[0].description).toBe('');
    });

    it('skips models with missing name field', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);

      // "missing_name" node has no name field — should be skipped
      expect(data.models.has('missing_name')).toBe(false);
    });

    it('skips models with missing unique_id field', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);

      // "no_unique_id" node has no unique_id field — should be skipped
      expect(data.models.has('no_unique_id')).toBe(false);
    });
  });
});
