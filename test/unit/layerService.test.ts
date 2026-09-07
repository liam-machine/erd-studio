/**
 * LayerService unit tests — layers.json loading, cache invalidation,
 * corrupt-file handling and filesystem layer detection (H18).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LayerService } from '../../src/services/layerService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { DEFAULT_LAYERS, LAYERS_SCHEMA_VERSION } from '../../src/types/layer';

function layerJson(ids: string[], schemaVersion = LAYERS_SCHEMA_VERSION): string {
  return JSON.stringify({
    schemaVersion,
    layers: ids.map((id, i) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      abbreviation: id.slice(0, 3).toUpperCase(),
      color: '#123456',
      creatable: true,
      order: i,
    })),
  }, null, 2) + '\n';
}

/** Write a file and bump its mtime so a stat-based cache sees a change. */
function writeWithNewMtime(filePath: string, content: string, offsetSeconds: number): void {
  fs.writeFileSync(filePath, content, 'utf-8');
  const t = new Date(Date.now() + offsetSeconds * 1000);
  fs.utimesSync(filePath, t, t);
}

describe('LayerService', () => {
  let tempDir: string;
  let semanticDir: string;
  let configPath: string;
  let tracker: OwnWriteTracker;
  let service: LayerService;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-layers-'));
    semanticDir = path.join(tempDir, '.erd-studio');
    configPath = path.join(semanticDir, 'layers.json');
    fs.mkdirSync(semanticDir, { recursive: true });
    tracker = new OwnWriteTracker();
    service = new LayerService(tempDir, '.erd-studio', tracker);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loading', () => {
    it('returns default layers when layers.json is absent', () => {
      expect(service.getAllLayers().map(l => l.id)).toEqual(DEFAULT_LAYERS.map(l => l.id));
      expect(service.getLoadError()).toBeNull();
    });

    it('loads layers from layers.json', () => {
      fs.writeFileSync(configPath, layerJson(['bronze', 'silver', 'gold']));
      expect(service.getAllLayers().map(l => l.id)).toEqual(['bronze', 'silver', 'gold']);
      expect(service.getLoadError()).toBeNull();
    });
  });

  describe('external changes (H18)', () => {
    it('picks up a layer added to layers.json on disk without invalidateCache()', () => {
      fs.writeFileSync(configPath, layerJson(['silver', 'gold']));
      expect(service.getAllLayers().map(l => l.id)).toEqual(['silver', 'gold']);

      writeWithNewMtime(configPath, layerJson(['silver', 'gold', 'platinum']), 5);

      expect(service.getAllLayers().map(l => l.id)).toEqual(['silver', 'gold', 'platinum']);
    });

    it('falls back to defaults when layers.json is deleted on disk', () => {
      fs.writeFileSync(configPath, layerJson(['bronze']));
      expect(service.getAllLayers().map(l => l.id)).toEqual(['bronze']);

      fs.unlinkSync(configPath);

      expect(service.getAllLayers().map(l => l.id)).toEqual(DEFAULT_LAYERS.map(l => l.id));
    });

    it('reloads after invalidateCache()', () => {
      fs.writeFileSync(configPath, layerJson(['silver', 'gold']));
      service.getAllLayers();
      fs.writeFileSync(configPath, layerJson(['silver', 'gold', 'platinum']));
      service.invalidateCache();
      expect(service.getAllLayers().map(l => l.id)).toEqual(['silver', 'gold', 'platinum']);
    });

    it('does not drop an externally added layer when a UI layer edit follows', async () => {
      fs.writeFileSync(configPath, layerJson(['silver', 'gold']));
      service.getAllLayers();

      // Simulate a pull that adds platinum
      writeWithNewMtime(configPath, layerJson(['silver', 'gold', 'platinum']), 5);

      await service.addLayer({ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true });

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { layers: Array<{ id: string }> };
      expect(onDisk.layers.map(l => l.id)).toEqual(['silver', 'gold', 'platinum', 'bronze']);
    });
  });

  describe('unreadable layers.json (H18)', () => {
    it('reports a load error and serves defaults for invalid JSON', () => {
      fs.writeFileSync(configPath, '{ "schemaVersion": 1, "layers": [ { "id": "bronze", }, ] }');
      expect(service.getAllLayers().map(l => l.id)).toEqual(DEFAULT_LAYERS.map(l => l.id));
      expect(service.getLoadError()).toMatch(/Invalid JSON/);
    });

    it('reports a load error for an unsupported newer schemaVersion', () => {
      fs.writeFileSync(configPath, layerJson(['bronze'], LAYERS_SCHEMA_VERSION + 1));
      service.getAllLayers();
      expect(service.getLoadError()).toMatch(/schemaVersion/);
    });

    it('refuses to overwrite a broken layers.json with defaults on addLayer', async () => {
      const broken = '{ not json';
      fs.writeFileSync(configPath, broken);

      await expect(
        service.addLayer({ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true }),
      ).rejects.toThrow(/layers\.json could not be loaded/);

      expect(fs.readFileSync(configPath, 'utf-8')).toBe(broken);
    });

    it('refuses to overwrite a newer-schema layers.json', async () => {
      const newer = layerJson(['bronze'], LAYERS_SCHEMA_VERSION + 1);
      fs.writeFileSync(configPath, newer);

      await expect(service.saveConfig([...DEFAULT_LAYERS])).rejects.toThrow(/could not be loaded/);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(newer);
    });

    it('clears the load error once the file is fixed on disk', async () => {
      fs.writeFileSync(configPath, '{ not json');
      expect(service.getLoadError()).not.toBeNull();

      writeWithNewMtime(configPath, layerJson(['bronze']), 5);
      expect(service.getLoadError()).toBeNull();

      await service.addLayer({ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true });
      expect(service.getAllLayers().map(l => l.id)).toEqual(['bronze', 'gold']);
    });

    it('allows saveConfig when no layers.json exists yet', async () => {
      await service.saveConfig([...DEFAULT_LAYERS]);
      expect(fs.existsSync(configPath)).toBe(true);
      expect(service.getLoadError()).toBeNull();
    });
  });

  describe('saveConfig', () => {
    it('records the write with the own-write tracker so the watcher can ignore it', async () => {
      await service.saveConfig([...DEFAULT_LAYERS]);
      expect(tracker.has(configPath)).toBe(true);
      expect(tracker.consume(configPath)).toBe(true);
    });

    it('serves the saved config from cache without re-reading', async () => {
      await service.saveConfig([...DEFAULT_LAYERS]);
      expect(service.getAllLayers().map(l => l.id)).toEqual(['silver', 'gold']);
    });
  });

  describe('detectLayersFromFilesystem (H18)', () => {
    it('detects layer directories and excludes logical-models, templates and dotdirs', () => {
      for (const dir of ['silver', 'gold', 'logical-models', 'templates', '.cache', 'logical', 'physical']) {
        fs.mkdirSync(path.join(semanticDir, dir), { recursive: true });
      }
      fs.writeFileSync(path.join(semanticDir, 'logical-models', 'dim_customer.yml'), 'name: dim_customer\n');
      fs.writeFileSync(path.join(semanticDir, 'silver', 'orders.json'), '{}');

      const ids = service.detectLayersFromFilesystem().map(l => l.id).sort();
      expect(ids).toEqual(['gold', 'silver']);
    });

    it('excludes a directory whose files are all YAML (a renamed model store)', () => {
      fs.mkdirSync(path.join(semanticDir, 'models'), { recursive: true });
      fs.writeFileSync(path.join(semanticDir, 'models', 'a.yml'), 'name: a\n');
      fs.writeFileSync(path.join(semanticDir, 'models', 'b.yaml'), 'name: b\n');
      fs.mkdirSync(path.join(semanticDir, 'platinum'), { recursive: true });
      fs.writeFileSync(path.join(semanticDir, 'platinum', 'x.json'), '{}');

      const ids = service.detectLayersFromFilesystem().map(l => l.id);
      expect(ids).toEqual(['platinum']);
    });

    it('keeps an empty directory (nothing to say it is not a layer)', () => {
      fs.mkdirSync(path.join(semanticDir, 'bronze'), { recursive: true });
      expect(service.detectLayersFromFilesystem().map(l => l.id)).toEqual(['bronze']);
    });

    it('uses known defaults for recognised layers and generated config otherwise', () => {
      fs.mkdirSync(path.join(semanticDir, 'gold'), { recursive: true });
      fs.mkdirSync(path.join(semanticDir, 'platinum'), { recursive: true });

      const detected = service.detectLayersFromFilesystem();
      const gold = detected.find(l => l.id === 'gold')!;
      const platinum = detected.find(l => l.id === 'platinum')!;
      expect(gold.label).toBe('Gold');
      expect(platinum.label).toBe('Platinum');
      expect(platinum.abbreviation).toBe('PLA');
      expect(platinum.creatable).toBe(true);
    });
  });
});
