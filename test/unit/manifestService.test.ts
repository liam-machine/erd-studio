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
const EMPTY_MANIFEST_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-empty-manifest');
const ZERO_BYTE_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-zero-byte');

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
      expect(data.models.size).toBe(4);
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

      expect(names).toHaveLength(4);
      expect(names).toContain('dim_work_lot');
      expect(names).toContain('dim_project');
      expect(names).toContain('fct_work_events');
      expect(names).toContain('stg_raw_payments');
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
      expect(data2.models.size).toBe(4);
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
    it('returns empty ManifestData when manifest JSON is malformed (stale-while-revalidate)', async () => {
      // Malformed manifest should NOT reject — it returns empty/stale data
      // so the graph stays visible during transient parse failures (e.g. mid-write)
      const data = await service.loadManifest(MALFORMED_PROJECT_PATH);
      expect(data.models.size).toBe(0);
      expect(data.relationshipTests).toEqual([]);
      expect(service.isStale).toBe(true);
    });

    it('returns lastKnownGood data when re-parse fails after a successful load', async () => {
      // First load succeeds — populates lastKnownGood
      const goodData = await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(goodData.models.size).toBe(4);

      // Invalidate so it will re-parse
      service.invalidate();

      // Re-parse against a malformed manifest — should return stale good data
      const fallbackData = await service.loadManifest(MALFORMED_PROJECT_PATH);
      expect(fallbackData.models.size).toBe(4);
      expect(service.isStale).toBe(true);
    });

    it('resets isStale to false after a successful re-parse following a failure', async () => {
      // Trigger a failure first
      await service.loadManifest(MALFORMED_PROJECT_PATH);
      expect(service.isStale).toBe(true);

      service.invalidate();

      // Successful parse should clear stale flag
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(service.isStale).toBe(false);
    });

    it('resets isStale to false on invalidate', async () => {
      await service.loadManifest(MALFORMED_PROJECT_PATH);
      expect(service.isStale).toBe(true);

      service.invalidate();
      expect(service.isStale).toBe(false);
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

  describe('relationship test extraction (F409)', () => {
    it('extracts relationship tests from manifest', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(data.relationshipTests).toBeDefined();
      expect(data.relationshipTests).toHaveLength(2);
    });

    it('parses relationship test fields correctly', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      // Find the dim_work_lot → dim_project relationship test
      const relTest = data.relationshipTests.find(
        (r) => r.fromModel === 'dim_work_lot' && r.toModel === 'dim_project'
      );

      expect(relTest).toBeDefined();
      expect(relTest!.fromColumn).toBe('project_id');
      expect(relTest!.toColumn).toBe('project_id');
    });

    it('extracts fromModel from attached_node when available', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      // Both relationship tests in fixture use attached_node
      const relTest = data.relationshipTests.find(
        (r) => r.fromModel === 'fct_work_events'
      );

      expect(relTest).toBeDefined();
      expect(relTest!.fromModel).toBe('fct_work_events');
      expect(relTest!.toModel).toBe('dim_work_lot');
    });

    it('returns empty array when no relationship tests exist', async () => {
      // Sparse project has no relationship tests
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);

      expect(data.relationshipTests).toEqual([]);
    });

    it('provides getRelationshipTests() accessor', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);

      const tests = service.getRelationshipTests();
      expect(tests).toHaveLength(2);
    });

    it('returns empty from getRelationshipTests() when cache is empty', () => {
      // Without loading manifest, should return empty array
      expect(service.getRelationshipTests()).toEqual([]);
    });

    it('clears relationship tests on invalidate', async () => {
      await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(service.getRelationshipTests()).toHaveLength(2);

      service.invalidate();

      expect(service.getRelationshipTests()).toEqual([]);
    });
  });

  describe('unique test extraction', () => {
    it('extracts unique tests from manifest', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      expect(data.uniqueColumns).toBeInstanceOf(Map);
      // dim_work_lot.work_lot_id, dim_project.project_id, fct_work_events.event_id
      expect(data.uniqueColumns.get('dim_work_lot')?.has('work_lot_id')).toBe(true);
      expect(data.uniqueColumns.get('dim_project')?.has('project_id')).toBe(true);
      expect(data.uniqueColumns.get('fct_work_events')?.has('event_id')).toBe(true);
    });

    it('does not include non-unique columns', async () => {
      const data = await service.loadManifest(FIXTURE_PROJECT_PATH);

      // project_id on dim_work_lot has a not_null test but not a unique test
      expect(data.uniqueColumns.get('dim_work_lot')?.has('project_id')).toBeFalsy();
    });

    it('returns empty maps when no unique tests exist', async () => {
      const data = await service.loadManifest(SPARSE_PROJECT_PATH);

      expect(data.uniqueColumns.size).toBe(0);
      expect(data.compositeUniqueGroups.size).toBe(0);
    });
  });

  describe('blank-screen defense (truncated manifest)', () => {
    it('returns lastKnownGood when manifest is 0 bytes after having good data', async () => {
      // First load succeeds — populates lastKnownGood
      const goodData = await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(goodData.models.size).toBe(4);

      service.invalidate();

      // 0-byte manifest triggers the stat guard → falls back to lastKnownGood
      const fallback = await service.loadManifest(ZERO_BYTE_PATH);
      expect(fallback.models.size).toBe(4);
      expect(service.isStale).toBe(true);
    });

    it('returns lastKnownGood when re-parse succeeds with 0 models after having good data', async () => {
      // First load succeeds
      const goodData = await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(goodData.models.size).toBe(4);

      service.invalidate();

      // Empty-but-valid manifest triggers the semantic regression guard
      const fallback = await service.loadManifest(EMPTY_MANIFEST_PATH);
      expect(fallback.models.size).toBe(4);
      expect(service.isStale).toBe(true);
    });

    it('does not flag stale when first load returns 0 models (legitimate empty project)', async () => {
      // No prior data — 0 models is a valid first load (user hasn't added models yet)
      const data = await service.loadManifest(EMPTY_MANIFEST_PATH);
      expect(data.models.size).toBe(0);
      expect(service.isStale).toBe(false);
    });

    it('returns empty and marks stale when first load is 0 bytes (no lastKnownGood)', async () => {
      // 0-byte file with no prior data — parse error path, no fallback available
      const data = await service.loadManifest(ZERO_BYTE_PATH);
      expect(data.models.size).toBe(0);
      expect(service.isStale).toBe(true);
    });

    it('simulates full manifest-change cycle: load → invalidate → truncated file → fallback preserves data', async () => {
      // This simulates the real-world sequence when dbt compiles:
      // 1. Extension starts, loads good manifest
      const goodData = await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(goodData.models.size).toBe(4);
      expect(goodData.relationshipTests.length).toBe(2);
      expect(service.isStale).toBe(false);

      // 2. dbt starts writing → file watcher fires → extension calls invalidate()
      service.invalidate();
      expect(service.isStale).toBe(false); // reset by invalidate

      // 3. loadManifest is called again but manifest is 0-bytes (truncated by dbt)
      const afterTruncation = await service.loadManifest(ZERO_BYTE_PATH);
      // Should get the SAME good data back, not empty
      expect(afterTruncation.models.size).toBe(4);
      expect(afterTruncation.relationshipTests.length).toBe(2);
      expect(service.isStale).toBe(true);
      // Verify it's the same object reference (lastKnownGood)
      expect(afterTruncation).toBe(goodData);

      // 4. Repeat with empty-but-valid JSON ({"nodes":{}}) — second failure mode
      service.invalidate();
      const afterEmptyJson = await service.loadManifest(EMPTY_MANIFEST_PATH);
      expect(afterEmptyJson.models.size).toBe(4);
      expect(afterEmptyJson).toBe(goodData);
      expect(service.isStale).toBe(true);

      // 5. dbt finishes writing → retry fires → good manifest again
      service.invalidate();
      const recovered = await service.loadManifest(FIXTURE_PROJECT_PATH);
      expect(recovered.models.size).toBe(4);
      expect(service.isStale).toBe(false);
    });
  });
});
