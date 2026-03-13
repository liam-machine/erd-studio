import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SchemaTagService } from '../../src/services/schemaTagService';
import type { ManifestService } from '../../src/services/manifestService';
import type { DomainService } from '../../src/services/domainService';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');

/**
 * Copy a fixture YAML file to a temp directory for mutation tests.
 * Returns the temp dir path (which acts as workspaceRoot).
 */
function setupTempYaml(fixtureRelPath: string): { tmpDir: string; yamlPath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
  const srcPath = path.join(FIXTURE_PROJECT_PATH, fixtureRelPath);
  const destPath = path.join(tmpDir, fixtureRelPath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  return { tmpDir, yamlPath: destPath };
}

function createMockManifestService(
  models: Record<string, { originalFilePath?: string }> = {},
): ManifestService {
  return {
    getModel: (name: string) => {
      const m = models[name];
      if (!m) { return undefined; }
      return { name, originalFilePath: m.originalFilePath } as ReturnType<ManifestService['getModel']>;
    },
    getModelNames: () => Object.keys(models),
    loadManifest: vi.fn().mockResolvedValue({ models: new Map() }),
  } as unknown as ManifestService;
}

function createMockDomainService(
  domains: Array<{ domain: string; layer: string; filePath: string; models: string[] }> = [],
): DomainService {
  return {
    listDomains: () =>
      domains.map((d) => ({ domain: d.domain, layer: d.layer, filePath: d.filePath })),
    getDomain: (filePath: string) => {
      const found = domains.find((d) => d.filePath === filePath);
      if (!found) { throw new Error(`Not found: ${filePath}`); }
      return {
        logical: {
          models: found.models.map((name) => ({ name })),
          relationships: [],
        },
      };
    },
  } as unknown as DomainService;
}

describe('SchemaTagService', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
    vi.restoreAllMocks();
  });

  describe('addDomainTag', () => {
    it('adds a domain tag to a model YAML file', async () => {
      const { tmpDir } = setupTempYaml('models/silver/dim_project.yml');
      tmpDirs.push(tmpDir);

      const service = new SchemaTagService(
        createMockManifestService({
          dim_project: { originalFilePath: 'models/silver/dim_project.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_project', 'new-domain');

      const content = fs.readFileSync(path.join(tmpDir, 'models/silver/dim_project.yml'), 'utf-8');
      expect(content).toContain('domain:new-domain');
    });

    it('does not duplicate an existing domain tag', async () => {
      const { tmpDir } = setupTempYaml('models/silver/dim_project.yml');
      tmpDirs.push(tmpDir);

      const service = new SchemaTagService(
        createMockManifestService({
          dim_project: { originalFilePath: 'models/silver/dim_project.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      // dim_project.yml fixture already has domain:work-lots
      await service.addDomainTag('dim_project', 'work-lots');

      const content = fs.readFileSync(path.join(tmpDir, 'models/silver/dim_project.yml'), 'utf-8');
      const matches = content.match(/domain:work-lots/g);
      expect(matches).toHaveLength(1);
    });

    it('skips silently when model is not in manifest', async () => {
      const service = new SchemaTagService(
        createMockManifestService({}),
        createMockDomainService(),
        '/nonexistent',
        'erd-studio',
      );

      // Should not throw
      await service.addDomainTag('nonexistent_model', 'some-domain');
    });

    it('skips silently when YAML file does not exist', async () => {
      const service = new SchemaTagService(
        createMockManifestService({
          dim_project: { originalFilePath: 'models/silver/dim_project.sql' },
        }),
        createMockDomainService(),
        '/nonexistent',
        'erd-studio',
      );

      await service.addDomainTag('dim_project', 'some-domain');
    });

    it('creates config.tags structure if absent', async () => {
      // Create a minimal YAML file with no config.tags
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_bare.yml');
      fs.writeFileSync(yamlPath, `version: 2\nmodels:\n  - name: dim_bare\n    description: No config\n`, 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_bare: { originalFilePath: 'models/silver/dim_bare.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_bare', 'test-domain');

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('domain:test-domain');
      expect(content).toContain('config:');
      expect(content).toContain('tags:');
    });

    it('preserves existing comments in YAML', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_commented.yml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        '# This is a model with comments',
        'models:',
        '  - name: dim_commented',
        '    description: Has comments # inline comment',
        '    config:',
        '      tags:',
        '        - silver',
        '',
      ].join('\n'), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_commented: { originalFilePath: 'models/silver/dim_commented.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_commented', 'my-domain');

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('# This is a model with comments');
      expect(content).toContain('# inline comment');
      expect(content).toContain('domain:my-domain');
    });

    it('preserves existing non-domain tags', async () => {
      const { tmpDir } = setupTempYaml('models/silver/dim_project.yml');
      tmpDirs.push(tmpDir);

      const service = new SchemaTagService(
        createMockManifestService({
          dim_project: { originalFilePath: 'models/silver/dim_project.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_project', 'new-domain');

      const content = fs.readFileSync(path.join(tmpDir, 'models/silver/dim_project.yml'), 'utf-8');
      // Original tags should be preserved
      expect(content).toContain('silver');
      expect(content).toContain('domain:work-lots');
      expect(content).toContain('domain:new-domain');
    });
  });

  describe('removeDomainTag', () => {
    it('removes a domain tag from a model YAML file', async () => {
      const { tmpDir } = setupTempYaml('models/gold/fct_work_events.yml');
      tmpDirs.push(tmpDir);

      const service = new SchemaTagService(
        createMockManifestService({
          fct_work_events: { originalFilePath: 'models/gold/fct_work_events.sql' },
        }),
        createMockDomainService([]),
        tmpDir,
        'erd-studio',
      );

      await service.removeDomainTag('fct_work_events', 'work-lots', '/some/domain.json');

      const content = fs.readFileSync(path.join(tmpDir, 'models/gold/fct_work_events.yml'), 'utf-8');
      expect(content).not.toContain('domain:work-lots');
      // Other tags preserved
      expect(content).toContain('gold');
      expect(content).toContain('daily');
    });

    it('skips removal when model is in another domain with same name', async () => {
      const { tmpDir } = setupTempYaml('models/gold/fct_work_events.yml');
      tmpDirs.push(tmpDir);

      const service = new SchemaTagService(
        createMockManifestService({
          fct_work_events: { originalFilePath: 'models/gold/fct_work_events.sql' },
        }),
        createMockDomainService([
          {
            domain: 'work-lots',
            layer: 'gold',
            filePath: '/other/work-lots.json',
            models: ['fct_work_events'],
          },
        ]),
        tmpDir,
        'erd-studio',
      );

      await service.removeDomainTag('fct_work_events', 'work-lots', '/current/work-lots.json');

      const content = fs.readFileSync(path.join(tmpDir, 'models/gold/fct_work_events.yml'), 'utf-8');
      // Tag should NOT be removed because model is still in another domain
      expect(content).toContain('domain:work-lots');
    });

    it('cleans up empty tags array and config map', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_single_tag.yml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        'models:',
        '  - name: dim_single_tag',
        '    description: Has only one domain tag',
        '    config:',
        '      tags:',
        '        - domain:my-domain',
        '',
      ].join('\n'), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_single_tag: { originalFilePath: 'models/silver/dim_single_tag.sql' },
        }),
        createMockDomainService([]),
        tmpDir,
        'erd-studio',
      );

      await service.removeDomainTag('dim_single_tag', 'my-domain', '/some/domain.json');

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).not.toContain('domain:my-domain');
      expect(content).not.toContain('config:');
      expect(content).not.toContain('tags:');
    });
  });

  describe('reconcileAll', () => {
    it('adds missing domain tags and removes stale ones', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);

      // Set up a YAML file with a stale tag and missing expected tag
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_test.yml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        'models:',
        '  - name: dim_test',
        '    description: Test model',
        '    config:',
        '      tags:',
        '        - silver',
        '        - domain:stale-domain',
        '',
      ].join('\n'), 'utf-8');

      // Set up domain files in erd-studio
      const erdDir = path.join(tmpDir, 'erd-studio', 'silver');
      fs.mkdirSync(erdDir, { recursive: true });
      const domainFile = path.join(erdDir, 'active-domain.json');
      fs.writeFileSync(domainFile, JSON.stringify({
        schemaVersion: 4,
        domain: 'active-domain',
        layer: 'silver',
        description: '',
        logical: {
          models: [{ name: 'dim_test', schema: '', description: '', columns: [] }],
          relationships: [],
        },
        viewConfig: {},
      }), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_test: { originalFilePath: 'models/silver/dim_test.sql' },
        }),
        createMockDomainService([
          {
            domain: 'active-domain',
            layer: 'silver',
            filePath: domainFile,
            models: ['dim_test'],
          },
        ]),
        tmpDir,
        'erd-studio',
      );

      const result = await service.reconcileAll();

      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('domain:active-domain');
      expect(content).not.toContain('domain:stale-domain');
      expect(content).toContain('silver'); // non-domain tag preserved
    });

    it('returns skipped count for models without YAML files', async () => {
      const service = new SchemaTagService(
        createMockManifestService({}), // no models in manifest
        createMockDomainService([
          {
            domain: 'some-domain',
            layer: 'silver',
            filePath: '/fake/domain.json',
            models: ['missing_model'],
          },
        ]),
        '/nonexistent',
        'erd-studio',
      );

      const result = await service.reconcileAll();
      expect(result.skipped).toBe(1);
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('removes stale tags from models no longer in any domain', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);

      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_orphan.yml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        'models:',
        '  - name: dim_orphan',
        '    description: Was in a domain, now removed',
        '    config:',
        '      tags:',
        '        - silver',
        '        - domain:old-domain',
        '',
      ].join('\n'), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_orphan: { originalFilePath: 'models/silver/dim_orphan.sql' },
        }),
        createMockDomainService([]), // no domains at all
        tmpDir,
        'erd-studio',
      );

      const result = await service.reconcileAll();

      expect(result.removed).toBe(1);
      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).not.toContain('domain:old-domain');
      expect(content).toContain('silver');
    });
  });

  describe('edge cases', () => {
    it('preserves scalar tag value when adding domain tag', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_scalar.yml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        'models:',
        '  - name: dim_scalar',
        '    description: Has scalar tag',
        '    config:',
        '      tags: my-tag',
        '',
      ].join('\n'), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_scalar: { originalFilePath: 'models/silver/dim_scalar.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_scalar', 'test-domain');

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('my-tag');
      expect(content).toContain('domain:test-domain');
    });

    it('resolves .yaml extension when .yml does not exist', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-tag-'));
      tmpDirs.push(tmpDir);
      const yamlDir = path.join(tmpDir, 'models', 'silver');
      fs.mkdirSync(yamlDir, { recursive: true });
      const yamlPath = path.join(yamlDir, 'dim_yaml_ext.yaml');
      fs.writeFileSync(yamlPath, [
        'version: 2',
        'models:',
        '  - name: dim_yaml_ext',
        '    description: Uses .yaml extension',
        '',
      ].join('\n'), 'utf-8');

      const service = new SchemaTagService(
        createMockManifestService({
          dim_yaml_ext: { originalFilePath: 'models/silver/dim_yaml_ext.sql' },
        }),
        createMockDomainService(),
        tmpDir,
        'erd-studio',
      );

      await service.addDomainTag('dim_yaml_ext', 'test-domain');

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('domain:test-domain');
    });
  });
});
