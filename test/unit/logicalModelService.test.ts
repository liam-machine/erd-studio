/**
 * Tests for LogicalModelService — YAML model file I/O for .erd-studio/logical-models/.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { LogicalModelService } from '../../src/services/logicalModelService';
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
