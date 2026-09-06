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

  describe('hand-edited files survive UI edits (comment/ordering preservation)', () => {
    function writeModelFile(name: string, content: string): string {
      service.ensureDir();
      const filePath = service.modelPath(name);
      fs.writeFileSync(filePath, content, 'utf-8');
      return filePath;
    }

    it('keeps comments, key order and unknown keys when a column is edited', () => {
      const filePath = writeModelFile('dim_customer', [
        '# Owned by the customer data team',
        'name: dim_customer',
        'description: Customer dimension',
        'owner: data-team # not an ERD Studio field',
        'columns:',
        '  # surrogate key',
        '  - name: customer_id',
        '    dataType: INT',
        '    isPrimaryKey: true',
        '  # contact details',
        '  - name: email',
        '    dataType: VARCHAR',
        '    description: Primary email',
        '',
      ].join('\n'));

      const model = service.getModel('dim_customer')!;
      model.columns![1].dataType = 'TEXT';
      service.saveModel(model);

      const after = fs.readFileSync(filePath, 'utf-8');
      expect(after).toContain('# Owned by the customer data team');
      expect(after).toContain('# surrogate key');
      expect(after).toContain('# contact details');
      expect(after).toContain('owner: data-team # not an ERD Studio field');
      expect(after).toContain('dataType: TEXT');
      expect(after).not.toContain('dataType: VARCHAR');
      // Key order untouched: name still first, description before owner.
      expect(after.indexOf('name: dim_customer')).toBeLessThan(after.indexOf('description:'));
      expect(after.indexOf('description:')).toBeLessThan(after.indexOf('owner:'));
    });

    it('does not rewrite untouched fields (byte-identical apart from the edit)', () => {
      const original = [
        'name: fct_orders',
        'description: A very long plain description that would be re-wrapped by a default 80-column stringifier if the whole file were regenerated on save.',
        'grain: |',
        '  One row per order line. This literal block keeps its own line breaks even though it is longer than eighty columns.',
        '  Second line of the literal block.',
        'columns:',
        '  - name: order_id',
        '    dataType: INT',
        '',
      ].join('\n');
      const filePath = writeModelFile('fct_orders', original);

      const model = service.getModel('fct_orders')!;
      model.columns!.push({ name: 'order_total', dataType: 'DECIMAL', description: '' });
      service.saveModel(model);

      const after = fs.readFileSync(filePath, 'utf-8');
      expect(after.startsWith(original.trimEnd())).toBe(true);
      expect(after).toContain('  - name: order_total\n    dataType: DECIMAL');
    });

    it('keeps date-like and numeric-looking scalars as strings on read and write', () => {
      const filePath = writeModelFile('dim_date', [
        'name: dim_date',
        'description: 2024-01-01',
        'columns:',
        '  - name: 007',
        '    dataType: INT',
        '    scdType: 2',
        '  - name: on',
        '    dataType: VARCHAR',
        '',
      ].join('\n'));

      const model = service.getModel('dim_date')!;
      expect(model.description).toBe('2024-01-01');
      expect(model.columns![0].name).toBe('007');
      expect(model.columns![0].scdType).toBe(2);
      expect(model.columns![1].name).toBe('on');

      // Re-saving an unchanged model must not coerce anything. The
      // numeric-looking name is pinned as an explicit string (quoted) rather
      // than being written back as `7`.
      service.saveModel(model);
      const after = fs.readFileSync(filePath, 'utf-8');
      expect(after).toContain('description: 2024-01-01');
      expect(after).not.toContain('T00:00:00');
      expect(after).toMatch(/name: ["']007["']/);
      expect(after).not.toMatch(/name: 7\b/);
      expect(after).toContain('scdType: 2');
      expect(service.getModel('dim_date')!.columns![0].name).toBe('007');
    });

    it('removes managed keys the model no longer has and preserves a renamed column\'s comment', () => {
      const filePath = writeModelFile('dim_product', [
        'name: dim_product',
        'grain: One row per product',
        'columns:',
        '  - name: product_id',
        '    dataType: INT',
        '    isPrimaryKey: true',
        '  # legacy name, to be renamed',
        '  - name: prod_nm',
        '    dataType: VARCHAR',
        '',
      ].join('\n'));

      const model = service.getModel('dim_product')!;
      delete model.grain;
      model.columns![1].name = 'product_name';
      service.saveModel(model);

      const after = fs.readFileSync(filePath, 'utf-8');
      expect(after).not.toContain('grain:');
      expect(after).not.toContain('prod_nm');
      expect(after).toContain('# legacy name, to be renamed');
      expect(after).toContain('name: product_name');
    });

    it('carries the existing document across a rename', () => {
      writeModelFile('old_model', [
        '# keep me',
        'name: old_model',
        'description: Test',
        '',
      ].join('\n'));

      service.renameModel('old_model', 'new_model');
      const after = fs.readFileSync(service.modelPath('new_model'), 'utf-8');
      expect(after).toContain('# keep me');
      expect(after).toContain('name: new_model');
      expect(service.modelExists('old_model')).toBe(false);
    });

    it('returns null for a file with YAML syntax errors instead of a partial model', () => {
      writeModelFile('broken', 'name: broken\ncolumns: [unclosed\n');
      expect(service.getModel('broken')).toBeNull();
      expect(service.listModels()).toHaveLength(0);
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
