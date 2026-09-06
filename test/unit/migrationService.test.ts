import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MigrationService,
  findLegacySemanticDir,
  migrateLegacySemanticDir,
} from '../../src/services/migrationService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';

describe('legacy semantic dir migration (erd-studio/ → .erd-studio/)', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-migration-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeLegacyDir(contents: 'layers' | 'logical-models' | 'templates' | 'layer-domains' | 'empty' | 'unrelated') {
    const legacy = path.join(workspaceRoot, 'erd-studio');
    fs.mkdirSync(legacy);
    switch (contents) {
      case 'layers':
        fs.writeFileSync(path.join(legacy, 'layers.json'), '{"layers":[]}');
        break;
      case 'logical-models':
        fs.mkdirSync(path.join(legacy, 'logical-models'));
        break;
      case 'templates':
        fs.mkdirSync(path.join(legacy, 'templates'));
        break;
      case 'layer-domains':
        fs.mkdirSync(path.join(legacy, 'silver'));
        fs.writeFileSync(
          path.join(legacy, 'silver', 'orders.json'),
          JSON.stringify({ schemaVersion: 5, domain: 'orders', layer: 'silver', logical: { models: [], relationships: [] } }),
        );
        break;
      case 'unrelated':
        fs.writeFileSync(path.join(legacy, 'notes.txt'), 'not an erd dir');
        break;
      case 'empty':
        break;
    }
    return legacy;
  }

  describe('findLegacySemanticDir', () => {
    it.each(['layers', 'logical-models', 'templates', 'layer-domains'] as const)(
      'detects a legacy dir identified by %s',
      (marker) => {
        const legacy = makeLegacyDir(marker);
        expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBe(legacy);
      },
    );

    it('returns null when no legacy dir exists', () => {
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('returns null when .erd-studio already exists', () => {
      makeLegacyDir('layers');
      fs.mkdirSync(path.join(workspaceRoot, '.erd-studio'));
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('returns null when semanticDir is customised', () => {
      makeLegacyDir('layers');
      expect(findLegacySemanticDir(workspaceRoot, 'erd-studio')).toBeNull();
      expect(findLegacySemanticDir(workspaceRoot, 'custom/dir')).toBeNull();
    });

    it('returns null for a folder that does not look like an ERD data dir', () => {
      makeLegacyDir('unrelated');
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('returns null for an empty erd-studio folder', () => {
      makeLegacyDir('empty');
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('returns null for a layer-shaped dir whose JSON is not a domain file (no schemaVersion)', () => {
      const legacy = path.join(workspaceRoot, 'erd-studio');
      fs.mkdirSync(path.join(legacy, 'src'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'src', 'tsconfig.json'), '{"compilerOptions":{}}');
      fs.writeFileSync(path.join(legacy, 'src', 'broken.json'), '{ not json');
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('does not throw on a dangling symlink inside a marker-less erd-studio/ dir', () => {
      const legacy = path.join(workspaceRoot, 'erd-studio');
      fs.mkdirSync(legacy);
      fs.symlinkSync(path.join(workspaceRoot, 'does-not-exist'), path.join(legacy, 'dangling'));
      expect(() => findLegacySemanticDir(workspaceRoot, '.erd-studio')).not.toThrow();
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
      expect(migrateLegacySemanticDir(workspaceRoot, '.erd-studio')).toBe(false);
    });

    it('does not follow a symlinked erd-studio entry', () => {
      const real = path.join(workspaceRoot, 'elsewhere');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'layers.json'), '{"layers":[]}');
      fs.symlinkSync(real, path.join(workspaceRoot, 'erd-studio'));
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });

    it('returns null when erd-studio is a file, not a directory', () => {
      fs.writeFileSync(path.join(workspaceRoot, 'erd-studio'), 'file');
      expect(findLegacySemanticDir(workspaceRoot, '.erd-studio')).toBeNull();
    });
  });

  describe('migrateLegacySemanticDir', () => {
    it('renames the legacy dir and preserves contents', () => {
      makeLegacyDir('layer-domains');
      fs.writeFileSync(
        path.join(workspaceRoot, 'erd-studio', 'layers.json'),
        '{"layers":[]}',
      );

      const renamed = migrateLegacySemanticDir(workspaceRoot, '.erd-studio');

      expect(renamed).toBe(true);
      expect(fs.existsSync(path.join(workspaceRoot, 'erd-studio'))).toBe(false);
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(workspaceRoot, '.erd-studio', 'silver', 'orders.json'),
            'utf-8',
          ),
        ).domain,
      ).toBe('orders');
      expect(
        fs.existsSync(path.join(workspaceRoot, '.erd-studio', 'layers.json')),
      ).toBe(true);
    });

    it('is a no-op when nothing to migrate', () => {
      expect(migrateLegacySemanticDir(workspaceRoot, '.erd-studio')).toBe(false);
    });

    it('is a no-op when .erd-studio already exists alongside a legacy dir', () => {
      makeLegacyDir('layers');
      fs.mkdirSync(path.join(workspaceRoot, '.erd-studio'));

      expect(migrateLegacySemanticDir(workspaceRoot, '.erd-studio')).toBe(false);
      expect(fs.existsSync(path.join(workspaceRoot, 'erd-studio'))).toBe(true);
    });
  });
});

describe('MigrationService.findV4Domains honours semanticDir', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-migration-v4-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function writeV4Domain(semanticDir: string): string {
    const layerDir = path.join(workspaceRoot, semanticDir, 'silver');
    fs.mkdirSync(layerDir, { recursive: true });
    const filePath = path.join(layerDir, 'orders.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 4,
        domain: 'orders',
        layer: 'silver',
        logical: {
          models: [{ name: 'dim_customer', columns: [{ name: 'customer_id', dataType: 'int', isPrimaryKey: true }] }],
          relationships: [],
        },
        viewConfig: {},
      }),
    );
    return filePath;
  }

  function makeService(semanticDir: string): MigrationService {
    return new MigrationService(
      workspaceRoot,
      new LayerService(workspaceRoot, semanticDir),
      new LogicalModelService(workspaceRoot, semanticDir),
      semanticDir,
    );
  }

  it('detects v4 domains under the default .erd-studio dir', () => {
    const filePath = writeV4Domain('.erd-studio');
    const svc = makeService('.erd-studio');
    expect(svc.findV4Domains()).toEqual([filePath]);
    expect(svc.needsMigration()).toBe(true);
  });

  it('detects v4 domains under a custom semanticDir', () => {
    const filePath = writeV4Domain('custom/models');
    const svc = makeService('custom/models');
    expect(svc.findV4Domains()).toEqual([filePath]);
    expect(svc.needsMigration()).toBe(true);
  });

  it('migrates a custom semanticDir project into logical-models under that dir', () => {
    const filePath = writeV4Domain('custom/models');
    const svc = makeService('custom/models');
    const result = svc.migrate();
    expect(result.domainsConverted).toBe(1);
    expect(result.modelsCreated).toBe(1);
    expect(fs.existsSync(path.join(workspaceRoot, 'custom/models', 'logical-models', 'dim_customer.yml'))).toBe(true);
    const migrated = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(migrated.schemaVersion).toBe(5);
    expect(migrated.logical.models).toEqual(['dim_customer']);
    expect(svc.needsMigration()).toBe(false);
  });

  it('does not look in .erd-studio when a custom semanticDir is configured', () => {
    writeV4Domain('.erd-studio');
    expect(makeService('custom/models').needsMigration()).toBe(false);
  });
});
