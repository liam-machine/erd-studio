/**
 * LayerService — lookup helpers and the mutation API (add / remove / rename /
 * recolour / update / reorder) that the layer commands in extension.ts drive.
 * Complements layerService.test.ts (loading, cache invalidation, corrupt files).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LayerService } from '../../src/services/layerService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import { DEFAULT_LAYERS, LAYERS_SCHEMA_VERSION, type LayerConfig } from '../../src/types/layer';

const bronze: LayerConfig = { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 0 };
const silver: LayerConfig = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 };
const staging: LayerConfig = { id: 'staging', label: 'Staging', abbreviation: 'STG', color: '#123456', creatable: false, order: 2 };

describe('LayerService lookups and mutations', () => {
  let tempDir: string;
  let configPath: string;
  let service: LayerService;

  const onDisk = (): { schemaVersion: number; layers: LayerConfig[] } =>
    JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const idsOnDisk = () => onDisk().layers.map((l) => l.id);

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-layer-mut-'));
    configPath = path.join(tempDir, '.erd-studio', 'layers.json');
    service = new LayerService(tempDir, '.erd-studio', new OwnWriteTracker());
    await service.saveConfig([bronze, silver, staging]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('lookups', () => {
    it('serves the configured layers and their metadata', () => {
      expect(service.getValidLayerIds()).toEqual(['bronze', 'silver', 'staging']);
      expect(service.getLayer('bronze')).toEqual(bronze);
      expect(service.hasLayer('bronze')).toBe(true);
      expect(service.getLabel('silver')).toBe('Silver');
      expect(service.getAbbreviation('silver')).toBe('SLV');
      expect(service.getColor('silver')).toBe('#a0a0a0');
      expect(service.isCreatable('silver')).toBe(true);
      expect(service.isCreatable('staging')).toBe(false);
    });

    it('getCreatableLayers filters on the creatable flag', () => {
      expect(service.getCreatableLayers().map((l) => l.id)).toEqual(['bronze', 'silver']);
    });

    it('derives label / abbreviation / colour for an unknown layer id', () => {
      expect(service.hasLayer('platinum')).toBe(false);
      expect(service.getLayer('platinum')).toBeUndefined();
      expect(service.getLabel('platinum')).toBe('Platinum');
      expect(service.getAbbreviation('platinum')).toBe('PLA');
      expect(service.getColor('platinum')).toBe('#808080');
      expect(service.isCreatable('platinum')).toBe(false);
    });

    it('serves the default layers when no layers.json exists', () => {
      const fresh = new LayerService(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-layer-none-')), '.erd-studio', new OwnWriteTracker());
      expect(fresh.configFileExists()).toBe(false);
      expect(fresh.getValidLayerIds()).toEqual(DEFAULT_LAYERS.map((l) => l.id));
      expect(fresh.hasLayer(DEFAULT_LAYERS[0].id)).toBe(true);
    });
  });

  describe('saveConfig', () => {
    it('writes the current schema version and re-derives order from list position when missing', async () => {
      await service.saveConfig([
        { ...silver, order: undefined as unknown as number },
        { ...bronze, order: undefined as unknown as number },
      ]);
      const file = onDisk();
      expect(file.schemaVersion).toBe(LAYERS_SCHEMA_VERSION);
      expect(file.layers.map((l) => [l.id, l.order])).toEqual([['silver', 0], ['bronze', 1]]);
    });
  });

  describe('addLayer', () => {
    it('appends after the highest existing order and persists', async () => {
      await service.addLayer({ id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true });
      expect(service.getValidLayerIds()).toEqual(['bronze', 'silver', 'staging', 'gold']);
      expect(service.getLayer('gold')?.order).toBe(3);
      expect(idsOnDisk()).toEqual(['bronze', 'silver', 'staging', 'gold']);
    });

    it('rejects a duplicate id without touching the file', async () => {
      const before = fs.readFileSync(configPath, 'utf-8');
      await expect(service.addLayer({ ...bronze })).rejects.toThrow('already exists');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });

  describe('removeLayer', () => {
    it('removes an existing layer and persists', async () => {
      await service.removeLayer('silver');
      expect(service.getValidLayerIds()).toEqual(['bronze', 'staging']);
      expect(idsOnDisk()).toEqual(['bronze', 'staging']);
    });

    it('rejects an unknown layer', async () => {
      await expect(service.removeLayer('platinum')).rejects.toThrow('not found');
    });
  });

  describe('renameLayer', () => {
    it('changes the id (and label when given) and keeps the other fields', async () => {
      await service.renameLayer('bronze', 'raw', 'Raw');
      expect(service.hasLayer('bronze')).toBe(false);
      expect(service.getLayer('raw')).toEqual({ ...bronze, id: 'raw', label: 'Raw' });
      expect(idsOnDisk()).toEqual(['raw', 'silver', 'staging']);
    });

    it('keeps the label when none is given', async () => {
      await service.renameLayer('bronze', 'raw');
      expect(service.getLabel('raw')).toBe('Bronze');
    });

    it('allows renaming onto the same id (label-only change)', async () => {
      await service.renameLayer('bronze', 'bronze', 'Raw');
      expect(service.getLabel('bronze')).toBe('Raw');
    });

    it('rejects an unknown source, a colliding target and malformed ids', async () => {
      await expect(service.renameLayer('platinum', 'x')).rejects.toThrow('not found');
      await expect(service.renameLayer('bronze', 'silver')).rejects.toThrow('already exists');
      await expect(service.renameLayer('bronze', 'Bronze')).rejects.toThrow(/Layer ID must start/);
      await expect(service.renameLayer('bronze', '1st')).rejects.toThrow(/Layer ID must start/);
      await expect(service.renameLayer('bronze', 'has space')).rejects.toThrow(/Layer ID must start/);
      expect(idsOnDisk()).toEqual(['bronze', 'silver', 'staging']);
    });
  });

  describe('updateLayerColor', () => {
    it('validates the hex format before touching the config', async () => {
      for (const bad of ['red', '#fff', '#12345g', 'cd7f32']) {
        await expect(service.updateLayerColor('bronze', bad)).rejects.toThrow(/valid hex color/);
      }
      expect(service.getColor('bronze')).toBe('#cd7f32');
    });

    it('accepts upper- and lower-case hex and persists', async () => {
      await service.updateLayerColor('bronze', '#ABCDEF');
      expect(service.getColor('bronze')).toBe('#ABCDEF');
      expect(onDisk().layers[0].color).toBe('#ABCDEF');
    });

    it('rejects an unknown layer', async () => {
      await expect(service.updateLayerColor('platinum', '#123456')).rejects.toThrow('not found');
    });
  });

  describe('updateLayer', () => {
    it('trims label and abbreviation, validates colour and toggles creatable', async () => {
      await service.updateLayer('staging', { label: '  Stage  ', abbreviation: ' ST ', color: '#00ff00', creatable: true });
      expect(service.getLayer('staging')).toEqual({ ...staging, label: 'Stage', abbreviation: 'ST', color: '#00ff00', creatable: true });
      expect(onDisk().layers[2].label).toBe('Stage');
    });

    it('leaves fields alone when they are not part of the update', async () => {
      await service.updateLayer('silver', { creatable: false });
      expect(service.getLayer('silver')).toEqual({ ...silver, creatable: false });
    });

    it('rejects empty label / abbreviation and bad colours', async () => {
      await expect(service.updateLayer('silver', { label: '   ' })).rejects.toThrow('label cannot be empty');
      await expect(service.updateLayer('silver', { abbreviation: '' })).rejects.toThrow('abbreviation cannot be empty');
      await expect(service.updateLayer('silver', { color: 'silver' })).rejects.toThrow(/valid hex color/);
      expect(service.getLayer('silver')).toEqual(silver);
    });

    it('rejects an unknown layer', async () => {
      await expect(service.updateLayer('platinum', { label: 'x' })).rejects.toThrow('not found');
    });
  });

  describe('reorderLayers', () => {
    it('rewrites order to match the given sequence and persists', async () => {
      await service.reorderLayers(['staging', 'bronze', 'silver']);
      expect(service.getAllLayers().map((l) => [l.id, l.order])).toEqual([['staging', 0], ['bronze', 1], ['silver', 2]]);
      expect(idsOnDisk()).toEqual(['staging', 'bronze', 'silver']);
    });

    it('rejects unknown ids, omissions and duplicates without touching the file', async () => {
      const before = fs.readFileSync(configPath, 'utf-8');
      await expect(service.reorderLayers(['bronze', 'silver', 'platinum'])).rejects.toThrow('"platinum" not found');
      await expect(service.reorderLayers(['bronze', 'silver'])).rejects.toThrow(/"staging" is missing/);
      await expect(service.reorderLayers(['bronze', 'silver', 'staging', 'bronze'])).rejects.toThrow('Duplicate');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    });
  });
});
