/**
 * Tests for LogicalModelService — YAML model file I/O for .erd-studio/logical-models/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestData, ManifestModelInfo } from '../../src/types/manifest';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-test-'));
  return dir;
}

function createManifestData(models: ManifestModelInfo[]): ManifestData {
  const map = new Map<string, ManifestModelInfo>();
  for (const m of models) { map.set(m.name, m); }
  return {
    models: map,
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogicalModelService', () => {
  let tempDir: string;
  let service: LogicalModelService;

  beforeEach(() => {
    tempDir = createTempWorkspace();
    service = new LogicalModelService(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('directory management', () => {
    it('reports dirExists as false when logical-models/ does not exist', () => {
      expect(service.dirExists()).toBe(false);
    });

    it('creates the logical-models/ directory via ensureDir', () => {
      service.ensureDir();
      expect(service.dirExists()).toBe(true);
    });
  });

  describe('write and read', () => {
    it('saves a model as YAML and reads it back', () => {
      const model = {
        name: 'dim_customer',
        schema: 'silver',
        description: 'Customer dimension',
        grain: 'One row per customer',
        modelRole: 'conformed-dim' as const,
        columns: [
          { name: 'customer_id', dataType: 'INT', description: 'PK', isPrimaryKey: true },
          { name: 'email', dataType: 'VARCHAR', description: 'Email' },
        ],
      };

      service.saveModel(model);
      expect(service.modelExists('dim_customer')).toBe(true);

      const loaded = service.getModel('dim_customer');
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('dim_customer');
      expect(loaded!.schema).toBe('silver');
      expect(loaded!.grain).toBe('One row per customer');
      expect(loaded!.modelRole).toBe('conformed-dim');
      expect(loaded!.columns).toHaveLength(2);
      expect(loaded!.columns![0].isPrimaryKey).toBe(true);
      expect(loaded!.columns![1].name).toBe('email');
    });

    it('returns null for non-existent model', () => {
      expect(service.getModel('nonexistent')).toBeNull();
    });

    it('lists all model names', () => {
      service.saveModel({ name: 'model_a', columns: [] });
      service.saveModel({ name: 'model_b', columns: [] });

      const names = service.listModelNames();
      expect(names).toContain('model_a');
      expect(names).toContain('model_b');
      expect(names).toHaveLength(2);
    });

    it('lists all models with full data', () => {
      service.saveModel({ name: 'dim_x', description: 'X', columns: [{ name: 'id', dataType: 'INT', description: '' }] });
      service.saveModel({ name: 'dim_y', description: 'Y', columns: [] });

      const models = service.listModels();
      expect(models).toHaveLength(2);
      expect(models.find(m => m.name === 'dim_x')?.description).toBe('X');
    });
  });

  describe('own-write tracking and parse cache (H11)', () => {
    it('records saves and deletes with the own-write tracker', () => {
      const tracker = new OwnWriteTracker();
      const tracked = new LogicalModelService(tempDir, '.erd-studio', tracker);

      tracked.saveModel({ name: 'dim_a', columns: [] });
      const filePath = tracked.modelPath('dim_a');
      expect(tracker.has(filePath)).toBe(true);
      expect(tracker.consume(filePath)).toBe(true);

      tracked.deleteModel('dim_a');
      expect(tracker.consume(filePath)).toBe(true);
    });

    /**
     * Rewrite a model file with same-length content and the original mtime so
     * the stat signature is unchanged. Only a cache hit can then explain a
     * read that still returns the old content.
     */
    const PINNED_MTIME = new Date('2024-01-01T00:00:00Z');

    /** Pin mtime to a whole second so utimes round-trips exactly. */
    function pinMtime(filePath: string): void {
      fs.utimesSync(filePath, PINNED_MTIME, PINNED_MTIME);
    }

    function rewriteKeepingSignature(filePath: string, content: string): void {
      const before = fs.statSync(filePath);
      fs.writeFileSync(filePath, content, 'utf-8');
      pinMtime(filePath);
      const after = fs.statSync(filePath);
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    }

    it('serves repeated reads from the cache while the stat signature is unchanged', () => {
      service.saveModel({ name: 'dim_cached', description: 'v1', columns: [] });
      pinMtime(service.modelPath('dim_cached'));
      expect(service.getModel('dim_cached')!.description).toBe('v1');

      const filePath = service.modelPath('dim_cached');
      rewriteKeepingSignature(filePath, fs.readFileSync(filePath, 'utf-8').replace('v1', 'v2'));

      expect(service.getModel('dim_cached')!.description).toBe('v1');
      expect(service.listModels().find(m => m.name === 'dim_cached')!.description).toBe('v1');
    });

    it('returns independent copies so callers cannot corrupt the cache', () => {
      service.saveModel({ name: 'dim_copy', description: 'orig', columns: [{ name: 'id', dataType: 'INT', description: '' }] });
      const a = service.getModel('dim_copy')!;
      a.description = 'mutated';
      a.columns!.push({ name: 'x', dataType: 'INT', description: '' });

      const b = service.getModel('dim_copy')!;
      expect(b.description).toBe('orig');
      expect(b.columns).toHaveLength(1);
    });

    it('re-reads when the file changes on disk', () => {
      service.saveModel({ name: 'dim_ext', description: 'v1', columns: [] });
      expect(service.getModel('dim_ext')!.description).toBe('v1');

      const filePath = service.modelPath('dim_ext');
      fs.writeFileSync(filePath, 'name: dim_ext\ndescription: edited externally by an agent\n');
      const t = new Date(Date.now() + 5000);
      fs.utimesSync(filePath, t, t);

      expect(service.getModel('dim_ext')!.description).toBe('edited externally by an agent');
    });

    it('re-reads after invalidateCache(name) and invalidateCache()', () => {
      service.saveModel({ name: 'dim_inv', description: 'v1', columns: [] });
      const filePath = service.modelPath('dim_inv');
      pinMtime(filePath);
      expect(service.getModel('dim_inv')!.description).toBe('v1');

      rewriteKeepingSignature(filePath, fs.readFileSync(filePath, 'utf-8').replace('v1', 'v2'));
      expect(service.getModel('dim_inv')!.description).toBe('v1'); // cached
      service.invalidateCache('dim_inv');
      expect(service.getModel('dim_inv')!.description).toBe('v2');

      rewriteKeepingSignature(filePath, fs.readFileSync(filePath, 'utf-8').replace('v2', 'v3'));
      expect(service.getModel('dim_inv')!.description).toBe('v2'); // cached
      service.invalidateCache();
      expect(service.getModel('dim_inv')!.description).toBe('v3');
    });

    it('reflects a save immediately in the next read', () => {
      service.saveModel({ name: 'dim_save', description: 'v1', columns: [] });
      service.getModel('dim_save');
      service.saveModel({ name: 'dim_save', description: 'v2', columns: [] });
      expect(service.getModel('dim_save')!.description).toBe('v2');
    });
  });

  describe('delete', () => {
    it('deletes a model file', () => {
      service.saveModel({ name: 'to_delete', columns: [] });
      expect(service.modelExists('to_delete')).toBe(true);

      service.deleteModel('to_delete');
      expect(service.modelExists('to_delete')).toBe(false);
    });

    it('does not throw when deleting a non-existent model', () => {
      expect(() => service.deleteModel('nonexistent')).not.toThrow();
    });
  });

  describe('rename', () => {
    it('renames a model file and updates the name field', () => {
      service.saveModel({ name: 'old_name', description: 'Test', columns: [] });
      service.renameModel('old_name', 'new_name');

      expect(service.modelExists('old_name')).toBe(false);
      expect(service.modelExists('new_name')).toBe(true);

      const model = service.getModel('new_name');
      expect(model!.name).toBe('new_name');
      expect(model!.description).toBe('Test');
    });

    it('throws when renaming a non-existent model', () => {
      expect(() => service.renameModel('nonexistent', 'new')).toThrow();
    });

    it('refuses to rename onto an existing model file (shared library must not be overwritten)', () => {
      service.saveModel({
        name: 'dim_customer',
        columns: [{ name: 'customer_key', dataType: 'string', description: '', isPrimaryKey: true }],
      });
      service.saveModel({ name: 'dim_customer_tmp', columns: [{ name: 'x', dataType: 'int', description: '' }] });

      expect(() => service.renameModel('dim_customer_tmp', 'dim_customer')).toThrow(/already exists/);

      // Neither file was touched
      expect(service.getModel('dim_customer')!.columns!.map((c) => c.name)).toEqual(['customer_key']);
      expect(service.modelExists('dim_customer_tmp')).toBe(true);
    });
  });

  describe('atomic writes', () => {
    it('saveModel leaves no temp files behind and writes the full content', () => {
      service.saveModel({ name: 'dim_a', columns: [{ name: 'a_key', dataType: 'string', description: '' }] });
      service.saveModel({ name: 'dim_a', columns: [{ name: 'a_key', dataType: 'string', description: '' }, { name: 'b', dataType: 'int', description: '' }] });

      const files = fs.readdirSync(service.getModelsDir());
      expect(files).toEqual(['dim_a.yml']);
      expect(service.getModel('dim_a')!.columns!.map((c) => c.name)).toEqual(['a_key', 'b']);
    });

    it('serializeModel returns exactly what saveModel writes', () => {
      const model = {
        name: 'fct_sales',
        description: 'Sales facts',
        grain: 'one row per sale',
        columns: [
          { name: 'sale_key', dataType: 'string', description: 'PK', isPrimaryKey: true },
          { name: 'amount', dataType: 'decimal', description: '', additiveType: 'additive' as const },
        ],
      };
      service.saveModel(model);
      const onDisk = fs.readFileSync(service.modelPath('fct_sales'), 'utf-8');
      expect(service.serializeModel(model)).toBe(onDisk);
    });
  });

  describe('createFromManifest', () => {
    it('creates a model file from manifest data', () => {
      const manifest = createManifestData([{
        name: 'dim_product',
        uniqueId: 'model.test.dim_product',
        projectName: 'test',
        schema: 'silver',
        description: 'Product dimension',
        columns: [
          { name: 'product_id', data_type: 'INT', description: 'PK' },
          { name: 'product_name', data_type: 'VARCHAR', description: 'Name' },
        ],
      }]);

      const result = service.createFromManifest('dim_product', manifest);
      expect(result).not.toBeNull();
      expect(result!.name).toBe('dim_product');
      expect(result!.columns).toHaveLength(2);
      expect(result!.schema).toBe('silver');

      // Verify it was written to disk
      expect(service.modelExists('dim_product')).toBe(true);
    });

    it('returns existing model without overwriting if file already exists', () => {
      service.saveModel({ name: 'dim_existing', description: 'Original', columns: [] });

      const manifest = createManifestData([{
        name: 'dim_existing',
        uniqueId: 'model.test.dim_existing',
        projectName: 'test',
        schema: 'silver',
        description: 'From manifest',
        columns: [],
      }]);

      const result = service.createFromManifest('dim_existing', manifest);
      expect(result!.description).toBe('Original'); // Not overwritten
    });

    it('returns null if model is not in manifest', () => {
      const manifest = createManifestData([]);
      expect(service.createFromManifest('nonexistent', manifest)).toBeNull();
    });
  });

  describe('reads fixture files', () => {
    it('reads dim_project.yml from test fixtures', () => {
      const fixtureService = new LogicalModelService(
        path.join(__dirname, '../fixtures/dbt-project'),
      );

      const model = fixtureService.getModel('dim_project');
      expect(model).not.toBeNull();
      expect(model!.name).toBe('dim_project');
      expect(model!.modelRole).toBe('conformed-dim');
      expect(model!.columns!.length).toBeGreaterThan(0);
      expect(model!.columns![0].isPrimaryKey).toBe(true);
    });

    it('lists fixture models', () => {
      const fixtureService = new LogicalModelService(
        path.join(__dirname, '../fixtures/dbt-project'),
      );

      const names = fixtureService.listModelNames();
      expect(names).toContain('dim_project');
      expect(names).toContain('fct_sale');
    });
  });
});
