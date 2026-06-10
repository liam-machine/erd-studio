import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findLegacySemanticDir,
  migrateLegacySemanticDir,
} from '../../src/services/migrationService';

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
        fs.writeFileSync(path.join(legacy, 'silver', 'orders.json'), '{}');
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
        fs.readFileSync(
          path.join(workspaceRoot, '.erd-studio', 'silver', 'orders.json'),
          'utf-8',
        ),
      ).toBe('{}');
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
