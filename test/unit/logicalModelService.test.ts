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

// ---------------------------------------------------------------------------
// modelPath — path traversal guard (H21)
// ---------------------------------------------------------------------------

describe('LogicalModelService.modelPath', () => {
  let tempDir: string;
  let service: LogicalModelService;

  beforeEach(() => {
    tempDir = createTempWorkspace();
    service = new LogicalModelService(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a plain name inside logical-models/', () => {
    const p = service.modelPath('dim_customer');
    expect(path.dirname(p)).toBe(path.resolve(tempDir, '.erd-studio', 'logical-models'));
    expect(path.basename(p)).toBe('dim_customer.yml');
  });

  it.each(['../escaped', '../../outside', 'sub/dir', 'a\\b', '..', '', '  '])(
    'rejects %j',
    (name) => {
      expect(() => service.modelPath(name)).toThrow(/Invalid model name/);
    },
  );

  it('refuses to write a model whose name escapes the directory', () => {
    expect(() => service.saveModel({ name: '../escaped', columns: [] })).toThrow(/Invalid model name/);
    expect(fs.existsSync(path.join(tempDir, '.erd-studio', 'escaped.yml'))).toBe(false);
  });

  // Read paths must degrade, not explode: a hand-edited or AI-written domain
  // file referencing an unsafe name should produce one broken node, not take
  // down the whole canvas.
  it.each(['../escaped', 'sub/dir', 'a\\b', '..', ''])(
    'getModel returns null for the unsafe name %j instead of throwing',
    (name) => {
      expect(() => service.getModel(name)).not.toThrow();
      expect(service.getModel(name)).toBeNull();
    },
  );

  it.each(['../escaped', 'sub/dir', '..'])(
    'modelExists returns false for the unsafe name %j instead of throwing',
    (name) => {
      expect(() => service.modelExists(name)).not.toThrow();
      expect(service.modelExists(name)).toBe(false);
    },
  );

  it('invalidateCache tolerates an unsafe name', () => {
    expect(() => service.invalidateCache('../escaped')).not.toThrow();
  });

  it('resolveModelPath returns null for unsafe names and a path for safe ones', () => {
    expect(service.resolveModelPath('../escaped')).toBeNull();
    expect(service.resolveModelPath('dim_customer')).toBe(service.modelPath('dim_customer'));
  });
});

// ---------------------------------------------------------------------------
// Layer folders — logical-models/{folder}/{name}.yml (issue #76)
// ---------------------------------------------------------------------------

describe('LogicalModelService layer folders', () => {
  let tempDir: string;
  let service: LogicalModelService;
  let modelsDir: string;

  /** Write a raw model file at logical-models/[folder/]name.yml. */
  function writeRaw(folder: string, name: string, content = `name: ${name}\ncolumns: []\n`): string {
    const dir = folder ? path.join(modelsDir, folder) : modelsDir;
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.yml`);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  beforeEach(() => {
    tempDir = fs.realpathSync(createTempWorkspace());
    service = new LogicalModelService(tempDir);
    modelsDir = path.join(tempDir, '.erd-studio', 'logical-models');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('lookup', () => {
    it('finds a model one folder down', () => {
      const filePath = writeRaw('gold', 'rpt_sales', 'name: rpt_sales\ndescription: Sales\ncolumns: []\n');
      expect(service.findModelFile('rpt_sales')).toBe(filePath);
      expect(service.modelPath('rpt_sales')).toBe(filePath);
      expect(service.modelExists('rpt_sales')).toBe(true);
      expect(service.getModel('rpt_sales')!.description).toBe('Sales');
    });

    it('prefers the top level over any folder, then folders alphabetically', () => {
      const silver = writeRaw('silver', 'dim_a', 'name: dim_a\ndescription: silver\n');
      const gold = writeRaw('gold', 'dim_a', 'name: dim_a\ndescription: gold\n');
      // gold < silver alphabetically
      expect(service.findModelFile('dim_a')).toBe(gold);
      expect(service.getModel('dim_a')!.description).toBe('gold');

      const top = writeRaw('', 'dim_a', 'name: dim_a\ndescription: top\n');
      expect(service.findModelFile('dim_a')).toBe(top);
      expect(service.getModel('dim_a')!.description).toBe('top');
      expect(silver).not.toBe(top);
    });

    it('returns null from findModelFile when no file holds the name, and throws on an unsafe name', () => {
      expect(service.findModelFile('nope')).toBeNull();
      writeRaw('gold', 'other');
      expect(service.findModelFile('nope')).toBeNull();
      expect(() => service.findModelFile('../x')).toThrow(/Invalid model name/);
    });

    it('modelFolder reports "" for the top level, the folder name one level down, null when missing', () => {
      writeRaw('', 'top_model');
      writeRaw('gold', 'gold_model');
      expect(service.modelFolder('top_model')).toBe('');
      expect(service.modelFolder('gold_model')).toBe('gold');
      expect(service.modelFolder('missing')).toBeNull();
    });

    it('ignores dot-folders and files nested two levels deep', () => {
      writeRaw('.git', 'hidden_model');
      writeRaw(path.join('gold', 'archive'), 'deep_model');
      writeRaw('gold', 'real_model');

      expect(service.listFolders()).toEqual(['gold']);
      expect(service.findModelFile('hidden_model')).toBeNull();
      expect(service.findModelFile('deep_model')).toBeNull();
      expect(service.modelExists('deep_model')).toBe(false);
      expect(service.listModelNames()).toEqual(['real_model']);
    });

    it('does not scan a symlinked folder', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-outside-'));
      try {
        fs.writeFileSync(path.join(outside, 'linked_model.yml'), 'name: linked_model\n', 'utf-8');
        fs.mkdirSync(modelsDir, { recursive: true });
        fs.symlinkSync(outside, path.join(modelsDir, 'linked'), 'dir');
        expect(service.listFolders()).toEqual([]);
        expect(service.findModelFile('linked_model')).toBeNull();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('lists folders alphabetically and returns [] when the library does not exist', () => {
      expect(service.listFolders()).toEqual([]);
      expect(service.listModelFiles()).toEqual([]);
      writeRaw('silver', 'a');
      writeRaw('gold', 'b');
      writeRaw('bronze', 'c');
      expect(service.listFolders()).toEqual(['bronze', 'gold', 'silver']);
    });
  });

  describe('listModelFiles / listModelNames / listModels', () => {
    it('lists the top level first, then each folder alphabetically, files sorted inside each', () => {
      writeRaw('silver', 'fct_b');
      writeRaw('silver', 'dim_a');
      writeRaw('', 'zz_top');
      writeRaw('', 'aa_top');
      writeRaw('gold', 'rpt_x');

      expect(service.listModelFiles().map((e) => `${e.folder}/${e.name}`)).toEqual([
        '/aa_top', '/zz_top', 'gold/rpt_x', 'silver/dim_a', 'silver/fct_b',
      ]);
      const entry = service.listModelFiles().find((e) => e.name === 'rpt_x')!;
      expect(entry.filePath).toBe(path.join(modelsDir, 'gold', 'rpt_x.yml'));
      expect(entry.shadowedBy).toBeUndefined();
    });

    it('flags every copy of a duplicated name but the one lookup resolves to', () => {
      const top = writeRaw('', 'dim_dupe', 'name: dim_dupe\ndescription: top\n');
      writeRaw('gold', 'dim_dupe', 'name: dim_dupe\ndescription: gold\n');
      writeRaw('silver', 'dim_dupe', 'name: dim_dupe\ndescription: silver\n');
      const goldOnly = writeRaw('gold', 'dim_gold');
      writeRaw('silver', 'dim_gold');

      const entries = service.listModelFiles();
      const dupes = entries.filter((e) => e.name === 'dim_dupe');
      expect(dupes.map((e) => [e.folder, e.shadowedBy])).toEqual([
        ['', undefined],
        ['gold', top],
        ['silver', top],
      ]);
      const golds = entries.filter((e) => e.name === 'dim_gold');
      expect(golds.map((e) => [e.folder, e.shadowedBy])).toEqual([
        ['gold', undefined],
        ['silver', goldOnly],
      ]);
      // The winner of each name is what findModelFile resolves to.
      expect(service.findModelFile('dim_dupe')).toBe(top);
      expect(service.findModelFile('dim_gold')).toBe(goldOnly);
    });

    it('listModelNames and listModels return each name once (the winning copy)', () => {
      writeRaw('', 'dim_dupe', 'name: dim_dupe\ndescription: top\n');
      writeRaw('gold', 'dim_dupe', 'name: dim_dupe\ndescription: gold\n');
      writeRaw('gold', 'rpt_x');

      expect(service.listModelNames()).toEqual(['dim_dupe', 'rpt_x']);
      const models = service.listModels();
      expect(models.map((m) => m.name)).toEqual(['dim_dupe', 'rpt_x']);
      expect(models[0].description).toBe('top');
    });
  });

  describe('groupsByFolder (layer folders are opt-in)', () => {
    it('is true when logical-models/ does not exist', () => {
      expect(fs.existsSync(modelsDir)).toBe(false);
      expect(service.groupsByFolder()).toBe(true);
    });

    it('is true for an empty library — there is no flat convention to keep', () => {
      fs.mkdirSync(modelsDir, { recursive: true });
      expect(service.groupsByFolder()).toBe(true);
    });

    it('with layer ids, only a file in a layer folder opts in — a hand-made Staging/ does not', () => {
      writeRaw('', 'dim_a');
      writeRaw('Staging', 'rpt_x');
      const layers = new Set(['silver', 'gold']);
      expect(service.groupsByFolder(layers)).toBe(false);
      writeRaw('gold', 'fct_b');
      expect(service.groupsByFolder(layers)).toBe(true);
    });

    it('is false for a library of flat files only', () => {
      writeRaw('', 'dim_a');
      writeRaw('', 'fct_b');
      expect(service.groupsByFolder()).toBe(false);
    });

    it('is true once any model file lives in a folder', () => {
      writeRaw('', 'dim_a');
      writeRaw('', 'fct_b');
      writeRaw('gold', 'rpt_c');
      expect(service.groupsByFolder()).toBe(true);
    });

    it('is true for a library whose only files are in folders', () => {
      writeRaw('silver', 'dim_a');
      expect(service.groupsByFolder()).toBe(true);
    });

    it('ignores an empty sub-folder: flat files beside it keep the library flat', () => {
      writeRaw('', 'dim_a');
      fs.mkdirSync(path.join(modelsDir, 'gold'), { recursive: true });
      fs.writeFileSync(path.join(modelsDir, 'gold', 'README.md'), 'not a model\n', 'utf-8');
      expect(service.groupsByFolder()).toBe(false);
    });

    it('does not count a file in a dot-folder', () => {
      writeRaw('', 'dim_a');
      writeRaw('.git', 'hidden_model');
      expect(service.groupsByFolder()).toBe(false);
    });

    it('does not count a file nested two folders deep', () => {
      writeRaw('', 'dim_a');
      writeRaw(path.join('gold', 'archive'), 'deep_model');
      expect(service.groupsByFolder()).toBe(false);
    });
  });

  describe('modelPath for a new file', () => {
    it('uses the top level when no folder is given', () => {
      expect(service.modelPath('dim_new')).toBe(path.join(modelsDir, 'dim_new.yml'));
    });

    it('uses logical-models/{folder}/ for a layer-shaped folder', () => {
      expect(service.modelPath('dim_new', 'gold')).toBe(path.join(modelsDir, 'gold', 'dim_new.yml'));
      expect(service.modelPath('dim_new', 'raw-data_2')).toBe(path.join(modelsDir, 'raw-data_2', 'dim_new.yml'));
    });

    it.each(['../x', 'Gold', '.hidden', 'a/b', '..', '_x', '1st', 'gold\\sub', ''])(
      'falls back to the top level for the unsafe folder %j',
      (folder) => {
        expect(service.modelPath('dim_new', folder)).toBe(path.join(modelsDir, 'dim_new.yml'));
      },
    );

    it('isModelFolderName accepts only layer-id shaped names', () => {
      expect(LogicalModelService.isModelFolderName('silver')).toBe(true);
      expect(LogicalModelService.isModelFolderName('my-layer_2')).toBe(true);
      for (const bad of ['Gold', '../x', '.hidden', '', 'a/b', '9lives']) {
        expect(LogicalModelService.isModelFolderName(bad), bad).toBe(false);
      }
    });

    it('returns the existing file wherever it is, whatever folder is asked for', () => {
      const gold = writeRaw('gold', 'dim_existing');
      expect(service.modelPath('dim_existing', 'silver')).toBe(gold);
      expect(service.modelPath('dim_existing')).toBe(gold);
    });
  });

  describe('ensureDir', () => {
    it('creates the folder of a model path inside the library', () => {
      service.ensureDir(service.modelPath('dim_x', 'gold'));
      expect(fs.statSync(path.join(modelsDir, 'gold')).isDirectory()).toBe(true);
    });

    it('creates just the library for a top-level path', () => {
      service.ensureDir(service.modelPath('dim_x'));
      expect(fs.readdirSync(modelsDir)).toEqual([]);
    });

    it.each([
      ['a sibling of the library', (t: string) => path.join(t, '.erd-studio', 'silver', 'x.yml')],
      ['a folder at the workspace root', (t: string) => path.join(t, 'newdir', 'x.yml')],
      ['a relative escape', (t: string) => path.join(t, '.erd-studio', 'logical-models', '..', '..', 'evil', 'x.yml')],
      ['an unrelated absolute path', () => path.join(os.tmpdir(), 'erd-nowhere', 'x.yml')],
    ])('refuses %s', (_label, make) => {
      const target = make(tempDir);
      expect(() => service.ensureDir(target)).toThrow(/outside the logical-models directory/);
      expect(fs.existsSync(path.dirname(target))).toBe(false);
    });
  });

  describe('writes', () => {
    it('saveModel(model, "gold") creates the folder and writes the file there', () => {
      service.saveModel({ name: 'rpt_new', description: 'New', columns: [] }, 'gold');
      const expected = path.join(modelsDir, 'gold', 'rpt_new.yml');
      expect(fs.existsSync(expected)).toBe(true);
      expect(fs.existsSync(path.join(modelsDir, 'rpt_new.yml'))).toBe(false);
      expect(service.modelFolder('rpt_new')).toBe('gold');
      expect(service.getModel('rpt_new')!.description).toBe('New');
    });

    it('saveModel with an unsafe folder writes at the top level', () => {
      service.saveModel({ name: 'rpt_new', columns: [] }, '../escape');
      expect(fs.existsSync(path.join(modelsDir, 'rpt_new.yml'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.erd-studio', 'escape'))).toBe(false);
    });

    it('edits an existing file in gold/ in place, keeping its comments, with no top-level copy', () => {
      const gold = writeRaw('gold', 'rpt_sales', [
        '# owned by finance',
        'name: rpt_sales',
        'description: Old',
        'owner: finance',
        '',
      ].join('\n'));

      const model = service.getModel('rpt_sales')!;
      model.description = 'New';
      // Even an explicit different folder does not move an existing file.
      service.saveModel(model, 'silver');

      const text = fs.readFileSync(gold, 'utf-8');
      expect(text).toContain('# owned by finance');
      expect(text).toContain('owner: finance');
      expect(text).toContain('description: New');
      expect(fs.existsSync(path.join(modelsDir, 'rpt_sales.yml'))).toBe(false);
      expect(fs.existsSync(path.join(modelsDir, 'silver'))).toBe(false);
      expect(fs.readdirSync(path.join(modelsDir, 'gold'))).toEqual(['rpt_sales.yml']);
    });

    it('serializeModel edits the document of a file in a folder', () => {
      writeRaw('gold', 'rpt_sales', '# keep\nname: rpt_sales\ndescription: Old\n');
      const text = service.serializeModel({ name: 'rpt_sales', description: 'New', columns: [] });
      expect(text).toContain('# keep');
      expect(text).toContain('description: New');
    });

    it('records own writes for a file saved into a folder', () => {
      const tracker = new OwnWriteTracker();
      const tracked = new LogicalModelService(tempDir, '.erd-studio', tracker);
      tracked.saveModel({ name: 'rpt_tracked', columns: [] }, 'gold');
      expect(tracker.consume(path.join(modelsDir, 'gold', 'rpt_tracked.yml'))).toBe(true);
    });

    it('renameModel keeps the folder and carries comments across', () => {
      writeRaw('gold', 'rpt_old', '# keep me\nname: rpt_old\ndescription: Test\n');

      service.renameModel('rpt_old', 'rpt_new');

      const renamed = path.join(modelsDir, 'gold', 'rpt_new.yml');
      expect(fs.existsSync(renamed)).toBe(true);
      expect(fs.existsSync(path.join(modelsDir, 'gold', 'rpt_old.yml'))).toBe(false);
      expect(fs.existsSync(path.join(modelsDir, 'rpt_new.yml'))).toBe(false);
      const text = fs.readFileSync(renamed, 'utf-8');
      expect(text).toContain('# keep me');
      expect(text).toContain('name: rpt_new');
      expect(service.modelFolder('rpt_new')).toBe('gold');
    });

    it('renameModel keeps a hand-made folder whose name is not layer-shaped', () => {
      // Reading indexes any one-level folder, so a rename must not drop the
      // file to the top level just because `Staging` could not be *created*.
      writeRaw('Staging', 'rpt_old', '# mine\nname: rpt_old\n');

      service.renameModel('rpt_old', 'rpt_new');

      expect(fs.existsSync(path.join(modelsDir, 'Staging', 'rpt_new.yml'))).toBe(true);
      expect(fs.existsSync(path.join(modelsDir, 'rpt_new.yml'))).toBe(false);
      expect(service.modelFolder('rpt_new')).toBe('Staging');
    });

    it('modelPath writes into an existing non-layer-shaped folder but never creates one', () => {
      writeRaw('Staging', 'rpt_any');
      expect(service.modelPath('rpt_x', 'Staging')).toBe(path.join(modelsDir, 'Staging', 'rpt_x.yml'));
      expect(service.modelPath('rpt_x', 'Nope')).toBe(path.join(modelsDir, 'rpt_x.yml'));
    });

    it('renameModel of an unparseable-document file still lands in the same folder', () => {
      // A non-mapping root cannot be edited in place, so the model is regenerated.
      writeRaw('gold', 'rpt_old', 'name: rpt_old\ncolumns: []\n');
      const spy = service as unknown as { loadEditableDocument: (p: string) => unknown };
      const original = spy.loadEditableDocument.bind(service);
      spy.loadEditableDocument = () => null;
      try {
        service.renameModel('rpt_old', 'rpt_new');
      } finally {
        spy.loadEditableDocument = original;
      }
      expect(fs.existsSync(path.join(modelsDir, 'gold', 'rpt_new.yml'))).toBe(true);
      expect(fs.existsSync(path.join(modelsDir, 'rpt_new.yml'))).toBe(false);
      expect(fs.existsSync(path.join(modelsDir, 'gold', 'rpt_old.yml'))).toBe(false);
    });

    it('renameModel refuses a target name that exists in another folder', () => {
      writeRaw('gold', 'rpt_old');
      writeRaw('silver', 'rpt_taken');
      expect(() => service.renameModel('rpt_old', 'rpt_taken')).toThrow(/already exists/);
      expect(fs.existsSync(path.join(modelsDir, 'gold', 'rpt_old.yml'))).toBe(true);
    });

    it('deleteModel deletes the file in its folder', () => {
      const gold = writeRaw('gold', 'rpt_gone');
      service.deleteModel('rpt_gone');
      expect(fs.existsSync(gold)).toBe(false);
      expect(service.modelExists('rpt_gone')).toBe(false);
      // The folder itself is left alone.
      expect(fs.existsSync(path.join(modelsDir, 'gold'))).toBe(true);
    });

    it('deleteModel removes only the winning copy of a duplicated name', () => {
      const top = writeRaw('', 'dim_dupe');
      const gold = writeRaw('gold', 'dim_dupe');
      service.deleteModel('dim_dupe');
      expect(fs.existsSync(top)).toBe(false);
      expect(fs.existsSync(gold)).toBe(true);
      // The gold copy now wins the lookup.
      expect(service.findModelFile('dim_dupe')).toBe(gold);
    });

    it('createFromManifest and createFromYml seed into the given folder', () => {
      const manifest = createManifestData([{
        name: 'rpt_manifest',
        schema: 'gold',
        description: '',
        columns: [],
      } as unknown as ManifestModelInfo]);
      service.createFromManifest('rpt_manifest', manifest, 'gold');
      expect(fs.existsSync(path.join(modelsDir, 'gold', 'rpt_manifest.yml'))).toBe(true);

      service.createFromYml('stg_yml', { name: 'stg_yml', description: '', columns: [] } as never, 'silver');
      expect(fs.existsSync(path.join(modelsDir, 'silver', 'stg_yml.yml'))).toBe(true);

      // Neither overwrites nor moves an existing file.
      service.createFromYml('rpt_manifest', { name: 'rpt_manifest', description: 'x', columns: [] } as never, 'silver');
      expect(fs.existsSync(path.join(modelsDir, 'silver', 'rpt_manifest.yml'))).toBe(false);
    });

    it('invalidateCache(name) drops the cached parse of a file in a folder', () => {
      const gold = writeRaw('gold', 'rpt_cache', 'name: rpt_cache\ndescription: aaa\n');
      const pinned = new Date('2024-01-01T00:00:00Z');
      fs.utimesSync(gold, pinned, pinned);
      expect(service.getModel('rpt_cache')!.description).toBe('aaa');
      fs.writeFileSync(gold, 'name: rpt_cache\ndescription: bbb\n', 'utf-8');
      fs.utimesSync(gold, pinned, pinned);
      expect(service.getModel('rpt_cache')!.description).toBe('aaa');
      service.invalidateCache('rpt_cache');
      expect(service.getModel('rpt_cache')!.description).toBe('bbb');
    });
  });
});
