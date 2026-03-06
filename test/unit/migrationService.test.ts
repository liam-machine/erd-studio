/**
 * MigrationService unit tests.
 *
 * Tests v2→v3 domain migration: scanning old stage directories,
 * merging sibling files, and full filesystem migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  scanV2Domains,
  mergeV2Siblings,
  migrateV2ToV3,
  hasLegacyLayout,
} from '../../src/services/migrationService';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const LEGACY_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-legacy');

// Temporary directory for migration tests that modify the filesystem
let tempDir: string;

function createTempProject(): string {
  tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'migration-test-'));
  return tempDir;
}

function cleanupTempDir(): void {
  if (tempDir && fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('MigrationService', () => {
  afterEach(() => {
    cleanupTempDir();
  });

  describe('scanV2Domains', () => {
    it('discovers domains in conceptual and logical stage directories', () => {
      const result = scanV2Domains(LEGACY_PROJECT_PATH, 'erd-studio');

      expect(result.domains.length).toBeGreaterThan(0);
      expect(result.fileCount).toBeGreaterThan(0);
    });

    it('returns correct domain entries with paths', () => {
      const result = scanV2Domains(LEGACY_PROJECT_PATH, 'erd-studio');

      const finance = result.domains.find(d => d.domain === 'finance' && d.layer === 'gold');
      expect(finance).toBeDefined();
      expect(finance!.conceptualPath).toContain('conceptual/gold/finance.json');
      // No logical sibling in the legacy fixtures
      expect(finance!.logicalPath).toBeNull();
    });

    it('returns empty result when no stage directories exist', () => {
      const result = scanV2Domains('/nonexistent/path', 'erd-studio');

      expect(result.domains).toHaveLength(0);
      expect(result.fileCount).toBe(0);
    });

    it('handles domains with only conceptual file (orphan)', () => {
      const result = scanV2Domains(LEGACY_PROJECT_PATH, 'erd-studio');

      const finance = result.domains.find(d => d.domain === 'finance');
      expect(finance).toBeDefined();
      expect(finance!.conceptualPath).not.toBeNull();
      expect(finance!.logicalPath).toBeNull();
    });

    it('merges conceptual and logical siblings into one entry', () => {
      const dir = createTempProject();
      const erdDir = path.join(dir, 'erd-studio');

      // Create both conceptual and logical files for same domain
      fs.mkdirSync(path.join(erdDir, 'conceptual', 'silver'), { recursive: true });
      fs.mkdirSync(path.join(erdDir, 'logical', 'silver'), { recursive: true });
      fs.writeFileSync(
        path.join(erdDir, 'conceptual', 'silver', 'test.json'),
        JSON.stringify({ schemaVersion: 1, domain: 'test', layer: 'silver', models: [] }),
      );
      fs.writeFileSync(
        path.join(erdDir, 'logical', 'silver', 'test.json'),
        JSON.stringify({ schemaVersion: 1, domain: 'test', layer: 'silver', models: [{ name: 'dim_a' }] }),
      );

      const result = scanV2Domains(dir, 'erd-studio');

      expect(result.domains).toHaveLength(1);
      expect(result.domains[0].conceptualPath).not.toBeNull();
      expect(result.domains[0].logicalPath).not.toBeNull();
      expect(result.fileCount).toBe(2);
    });
  });

  describe('mergeV2Siblings', () => {
    it('merges conceptual-only file into unified domain', () => {
      const conceptualPath = path.join(
        LEGACY_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const result = mergeV2Siblings(conceptualPath, null, 'finance', 'gold');

      expect(result.schemaVersion).toBe(3);
      expect(result.domain).toBe('finance');
      expect(result.layer).toBe('gold');
      expect(result.conceptual.models.length).toBeGreaterThan(0);
      expect(result.logical.models).toHaveLength(0);
    });

    it('merges logical-only file into unified domain', () => {
      // Create a temp logical file
      const dir = createTempProject();
      const logicalPath = path.join(dir, 'logical.json');
      fs.writeFileSync(logicalPath, JSON.stringify({
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: 'Logical only',
        models: [{ name: 'dim_test', columns: [] }],
        relationships: [],
        viewConfig: {},
      }));

      const result = mergeV2Siblings(null, logicalPath, 'test', 'silver');

      expect(result.schemaVersion).toBe(3);
      expect(result.conceptual.models).toHaveLength(0);
      expect(result.logical.models).toHaveLength(1);
      expect(result.logical.models[0].name).toBe('dim_test');
      expect(result.description).toBe('Logical only');
    });

    it('merges both siblings, preferring logical for metadata', () => {
      const dir = createTempProject();
      const conceptualPath = path.join(dir, 'conceptual.json');
      const logicalPath = path.join(dir, 'logical.json');

      fs.writeFileSync(conceptualPath, JSON.stringify({
        schemaVersion: 1, domain: 'test', layer: 'silver',
        description: 'Conceptual desc',
        modelFolder: 'models/conceptual',
        models: [{ name: 'entity_a' }],
        relationships: [], viewConfig: {},
      }));

      fs.writeFileSync(logicalPath, JSON.stringify({
        schemaVersion: 1, domain: 'test', layer: 'silver',
        description: 'Logical desc',
        modelFolder: 'models/logical',
        models: [{ name: 'dim_a', columns: [{ name: 'id', dataType: 'INT', description: '' }] }],
        relationships: [{ fromModel: 'dim_a', fromColumn: 'id', toModel: 'dim_b', toColumn: 'id', cardinality: 'many-to-one' }],
        viewConfig: { positions: { dim_a: { x: 10, y: 20 } } },
      }));

      const result = mergeV2Siblings(conceptualPath, logicalPath, 'test', 'silver');

      // Metadata from logical (preferred)
      expect(result.description).toBe('Logical desc');
      expect(result.modelFolder).toBe('models/logical');
      // Both stages populated
      expect(result.conceptual.models).toHaveLength(1);
      expect(result.conceptual.models[0].name).toBe('entity_a');
      expect(result.logical.models).toHaveLength(1);
      expect(result.logical.models[0].name).toBe('dim_a');
      expect(result.logical.relationships).toHaveLength(1);
      expect(result.logical.viewConfig.positions).toBeDefined();
    });

    it('produces empty stages when both paths are null', () => {
      const result = mergeV2Siblings(null, null, 'empty', 'silver');

      expect(result.schemaVersion).toBe(3);
      expect(result.domain).toBe('empty');
      expect(result.conceptual.models).toHaveLength(0);
      expect(result.logical.models).toHaveLength(0);
    });
  });

  describe('migrateV2ToV3', () => {
    it('migrates domains from stage dirs to layer dirs', () => {
      const dir = createTempProject();
      const erdDir = path.join(dir, 'erd-studio');

      // Create v2 structure
      fs.mkdirSync(path.join(erdDir, 'conceptual', 'silver'), { recursive: true });
      fs.writeFileSync(
        path.join(erdDir, 'conceptual', 'silver', 'test.json'),
        JSON.stringify({
          schemaVersion: 1, domain: 'test', layer: 'silver',
          description: 'Test', models: [{ name: 'entity_a' }],
          relationships: [], viewConfig: {},
        }),
      );

      const count = migrateV2ToV3(dir, 'erd-studio');

      expect(count).toBe(1);
      // New v3 file should exist
      const v3Path = path.join(erdDir, 'silver', 'test.json');
      expect(fs.existsSync(v3Path)).toBe(true);
      const v3Content = JSON.parse(fs.readFileSync(v3Path, 'utf-8'));
      expect(v3Content.schemaVersion).toBe(3);
      expect(v3Content.conceptual.models).toHaveLength(1);
      // Old directories should be removed
      expect(fs.existsSync(path.join(erdDir, 'conceptual'))).toBe(false);
    });

    it('returns 0 when no legacy domains exist', () => {
      const dir = createTempProject();
      fs.mkdirSync(path.join(dir, 'erd-studio'), { recursive: true });

      const count = migrateV2ToV3(dir, 'erd-studio');
      expect(count).toBe(0);
    });

    it('throws when migration would overwrite existing v3 file', () => {
      const dir = createTempProject();
      const erdDir = path.join(dir, 'erd-studio');

      // Create both v2 and v3 files for same domain
      fs.mkdirSync(path.join(erdDir, 'conceptual', 'silver'), { recursive: true });
      fs.mkdirSync(path.join(erdDir, 'silver'), { recursive: true });
      fs.writeFileSync(
        path.join(erdDir, 'conceptual', 'silver', 'test.json'),
        JSON.stringify({ schemaVersion: 1, domain: 'test', layer: 'silver', models: [] }),
      );
      fs.writeFileSync(
        path.join(erdDir, 'silver', 'test.json'),
        JSON.stringify({ schemaVersion: 3, domain: 'test', layer: 'silver' }),
      );

      expect(() => migrateV2ToV3(dir, 'erd-studio')).toThrow('overwrite');
    });

    it('merges conceptual and logical siblings during migration', () => {
      const dir = createTempProject();
      const erdDir = path.join(dir, 'erd-studio');

      fs.mkdirSync(path.join(erdDir, 'conceptual', 'silver'), { recursive: true });
      fs.mkdirSync(path.join(erdDir, 'logical', 'silver'), { recursive: true });
      fs.writeFileSync(
        path.join(erdDir, 'conceptual', 'silver', 'test.json'),
        JSON.stringify({
          schemaVersion: 1, domain: 'test', layer: 'silver',
          models: [{ name: 'entity_a' }], relationships: [], viewConfig: {},
        }),
      );
      fs.writeFileSync(
        path.join(erdDir, 'logical', 'silver', 'test.json'),
        JSON.stringify({
          schemaVersion: 1, domain: 'test', layer: 'silver',
          models: [{ name: 'dim_a' }], relationships: [], viewConfig: {},
        }),
      );

      const count = migrateV2ToV3(dir, 'erd-studio');

      expect(count).toBe(1);
      const v3Content = JSON.parse(
        fs.readFileSync(path.join(erdDir, 'silver', 'test.json'), 'utf-8'),
      );
      expect(v3Content.conceptual.models).toHaveLength(1);
      expect(v3Content.logical.models).toHaveLength(1);
      // Both stage dirs removed
      expect(fs.existsSync(path.join(erdDir, 'conceptual'))).toBe(false);
      expect(fs.existsSync(path.join(erdDir, 'logical'))).toBe(false);
    });
  });

  describe('hasLegacyLayout', () => {
    it('returns true when legacy stage directories contain domains', () => {
      expect(hasLegacyLayout(LEGACY_PROJECT_PATH, 'erd-studio')).toBe(true);
    });

    it('returns false when no legacy directories exist', () => {
      expect(hasLegacyLayout('/nonexistent/path', 'erd-studio')).toBe(false);
    });

    it('returns false for empty stage directories', () => {
      const dir = createTempProject();
      const erdDir = path.join(dir, 'erd-studio');
      fs.mkdirSync(path.join(erdDir, 'conceptual'), { recursive: true });
      fs.mkdirSync(path.join(erdDir, 'logical'), { recursive: true });

      expect(hasLegacyLayout(dir, 'erd-studio')).toBe(false);
    });
  });
});
