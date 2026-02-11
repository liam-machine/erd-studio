import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { SchemaTagService } from '../../src/services/schemaTagService';
import { ManifestService } from '../../src/services/manifestService';

// Mock vscode module
vi.mock('vscode', () => ({
  Uri: {
    file: (fsPath: string) => ({ fsPath, scheme: 'file' }),
  },
  Position: class {
    constructor(public line: number, public character: number) {}
  },
  Range: class {
    constructor(public start: { line: number; character: number }, public end: { line: number; character: number }) {}
  },
  WorkspaceEdit: class {
    private edits: Array<{ type: string; uri: { fsPath: string }; range?: unknown; text?: string }> = [];

    replace(uri: { fsPath: string }, range: unknown, text: string) {
      this.edits.push({ type: 'replace', uri, range, text });
    }

    insert(uri: { fsPath: string }, position: unknown, text: string) {
      this.edits.push({ type: 'insert', uri, text });
    }

    createFile(uri: { fsPath: string }, options: unknown) {
      this.edits.push({ type: 'createFile', uri });
    }

    getEdits() {
      return this.edits;
    }
  },
  workspace: {
    textDocuments: [],
    applyEdit: vi.fn().mockResolvedValue(true),
  },
  window: {
    showErrorMessage: vi.fn(),
  },
}));

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
const SCHEMA_TEST_DIR = path.resolve(FIXTURES_DIR, 'dbt-project/models/silver');

describe('SchemaTagService', () => {
  let service: SchemaTagService;
  let manifestService: ManifestService;

  // Track files we create for cleanup
  const createdFiles: string[] = [];

  beforeEach(async () => {
    manifestService = new ManifestService();
    // Pre-load manifest so getModel() works synchronously
    await manifestService.loadManifest(FIXTURE_PROJECT_PATH);
    service = new SchemaTagService(manifestService);
  });

  afterEach(() => {
    // Clean up any created test files
    for (const file of createdFiles) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
    createdFiles.length = 0;
    manifestService.invalidate();
  });

  describe('deriveSchemaPath', () => {
    it('returns correct path for model in manifest', async () => {
      // dim_work_lot has originalFilePath: "models/silver/dim_work_lot.sql"
      // Use addDomainTag and check if it tries to access the right file
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');

      // Create a minimal schema file to verify path resolution
      fs.writeFileSync(schemaPath, yaml.dump({ version: 2, models: [{ name: 'dim_work_lot' }] }));
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'test-domain', FIXTURE_PROJECT_PATH);
      expect(edit).not.toBeNull();
    });

    it('returns null for model not in manifest', async () => {
      const edit = await service.addDomainTag('nonexistent_model', 'test-domain', FIXTURE_PROJECT_PATH);
      expect(edit).toBeNull();
    });
  });

  describe('addDomainTag', () => {
    it('creates new schema.yml with tag if file does not exist', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');

      // Ensure file doesn't exist
      if (fs.existsSync(schemaPath)) {
        fs.unlinkSync(schemaPath);
      }
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      // New files are written directly to disk (returns null, no WorkspaceEdit needed)
      expect(edit).toBeNull();
      expect(fs.existsSync(schemaPath)).toBe(true);

      const content = yaml.load(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
      const models = content.models as Array<{ name: string; config?: { tags?: string[] } }>;
      expect(models[0].name).toBe('dim_work_lot');
      expect(models[0].config?.tags).toContain('domain:work-lots');
    });

    it('adds tag to existing schema.yml without tags', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            description: 'Work lot dimension table',
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');
      expect(replaceEdit).toBeDefined();

      // Parse the new content and verify tag was added
      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).toContain('domain:work-lots');
    });

    it('adds tag to existing tags array', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['existing-tag', 'another-tag'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).toContain('domain:work-lots');
      expect(models[0].config?.tags).toContain('existing-tag');
      expect(models[0].config?.tags).toContain('another-tag');
    });

    it('returns null if tag already exists (idempotent)', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['domain:work-lots'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).toBeNull();
    });

    it('supports multiple domain tags', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['domain:sales'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.addDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).toContain('domain:work-lots');
      expect(models[0].config?.tags).toContain('domain:sales');
    });
  });

  describe('removeDomainTag', () => {
    it('removes domain tag from existing tags', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['other-tag', 'domain:work-lots', 'another-tag'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).not.toContain('domain:work-lots');
      expect(models[0].config?.tags).toContain('other-tag');
      expect(models[0].config?.tags).toContain('another-tag');
    });

    it('removes tags field when last tag is removed', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['domain:work-lots'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).toBeUndefined();
    });

    it('removes config field when tags was the only field', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['domain:work-lots'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: unknown }>;
      expect(models[0].config).toBeUndefined();
    });

    it('returns null if tag does not exist (idempotent)', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['other-tag'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).toBeNull();
    });

    it('returns null if schema file does not exist', async () => {
      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);
      expect(edit).toBeNull();
    });

    it('preserves other domain tags when removing one', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['domain:sales', 'domain:work-lots', 'domain:finance'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const edit = await service.removeDomainTag('dim_work_lot', 'work-lots', FIXTURE_PROJECT_PATH);

      expect(edit).not.toBeNull();
      const edits = (edit as unknown as { getEdits(): unknown[] }).getEdits();
      const replaceEdit = edits.find((e: { type: string; text?: string }) => e.type === 'replace');

      const newContent = yaml.load((replaceEdit as { text: string }).text) as Record<string, unknown>;
      const models = newContent.models as Array<{ config?: { tags?: string[] } }>;
      expect(models[0].config?.tags).toContain('domain:sales');
      expect(models[0].config?.tags).toContain('domain:finance');
      expect(models[0].config?.tags).not.toContain('domain:work-lots');
    });
  });

  describe('getDomainTags', () => {
    it('returns all domain tags for a model', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            config: {
              tags: ['other-tag', 'domain:work-lots', 'domain:sales', 'staging'],
            },
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const tags = await service.getDomainTags('dim_work_lot', FIXTURE_PROJECT_PATH);

      expect(tags).toHaveLength(2);
      expect(tags).toContain('domain:work-lots');
      expect(tags).toContain('domain:sales');
      expect(tags).not.toContain('other-tag');
      expect(tags).not.toContain('staging');
    });

    it('returns empty array if no schema file exists', async () => {
      const tags = await service.getDomainTags('dim_work_lot', FIXTURE_PROJECT_PATH);
      expect(tags).toEqual([]);
    });

    it('returns empty array if model has no tags', async () => {
      const schemaPath = path.join(FIXTURE_PROJECT_PATH, 'models/silver/dim_work_lot.yml');
      const initialContent: Record<string, unknown> = {
        version: 2,
        models: [
          {
            name: 'dim_work_lot',
            description: 'No tags here',
          },
        ],
      };
      fs.writeFileSync(schemaPath, yaml.dump(initialContent));
      createdFiles.push(schemaPath);

      const tags = await service.getDomainTags('dim_work_lot', FIXTURE_PROJECT_PATH);
      expect(tags).toEqual([]);
    });
  });
});
