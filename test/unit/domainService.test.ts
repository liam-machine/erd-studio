import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { DomainService } from '../../src/services/domainService';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
const MALFORMED_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-malformed');
const SPARSE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-sparse');

// Mock LayerService that returns the classic bronze/silver/gold layers
function createMockLayerService(): LayerService {
  const layers: LayerConfig[] = [
    { id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: false, order: 0 },
    { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 },
    { id: 'gold', label: 'Gold', abbreviation: 'GLD', color: '#d4a800', creatable: true, order: 2 },
  ];
  return {
    getAllLayers: () => layers,
    getLayer: (id: string) => layers.find(l => l.id === id),
    hasLayer: (id: string) => layers.some(l => l.id === id),
    getValidLayerIds: () => layers.map(l => l.id),
    getCreatableLayers: () => layers.filter(l => l.creatable),
    getLabel: (id: string) => layers.find(l => l.id === id)?.label ?? id,
    getAbbreviation: (id: string) => layers.find(l => l.id === id)?.abbreviation ?? id.substring(0, 3).toUpperCase(),
    getColor: (id: string) => layers.find(l => l.id === id)?.color ?? '#808080',
    isCreatable: (id: string) => layers.find(l => l.id === id)?.creatable ?? false,
  } as LayerService;
}

describe('DomainService', () => {
  let service: DomainService;
  let mockLayerService: LayerService;

  beforeEach(() => {
    mockLayerService = createMockLayerService();
    service = new DomainService(mockLayerService);
  });

  describe('listDomains', () => {
    it('discovers all .json files under models/semantic/ grouped by layer', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);

      expect(domains.length).toBe(2);

      const silverDomains = domains.filter((d) => d.layer === 'silver');
      const goldDomains = domains.filter((d) => d.layer === 'gold');

      expect(silverDomains).toHaveLength(1);
      expect(silverDomains[0].domain).toBe('work-lots');

      expect(goldDomains).toHaveLength(1);
      expect(goldDomains[0].domain).toBe('finance');
    });

    it('returns correct file paths', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const workLots = domains.find((d) => d.domain === 'work-lots');

      expect(workLots).toBeDefined();
      expect(workLots!.filePath).toBe(
        path.join(FIXTURE_PROJECT_PATH, 'models', 'semantic', 'silver', 'work-lots.json')
      );
    });

    it('returns empty array when semantic directory does not exist', () => {
      const domains = service.listDomains('/nonexistent/path');
      expect(domains).toEqual([]);
    });

    it('returns empty array when no JSON files exist', () => {
      // bronze directory exists but has no files
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const bronzeDomains = domains.filter((d) => d.layer === 'bronze');
      expect(bronzeDomains).toHaveLength(0);
    });

    it('supports custom semantic directory', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH, 'models/semantic');
      expect(domains.length).toBeGreaterThan(0);
    });

    it('iterates layers in order: bronze, silver, gold', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const layers = domains.map((d) => d.layer);

      // Silver should come before gold since bronze is empty
      const silverIdx = layers.indexOf('silver');
      const goldIdx = layers.indexOf('gold');
      expect(silverIdx).toBeLessThan(goldIdx);
    });
  });

  describe('getDomain', () => {
    it('reads and parses a valid domain file into a typed SemanticDomain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'models', 'semantic', 'silver', 'work-lots.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(1);
      expect(domain.domain).toBe('work-lots');
      expect(domain.layer).toBe('silver');
      expect(domain.description).toContain('Work lot domain');
    });

    it('parses models correctly', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'models', 'semantic', 'silver', 'work-lots.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.models).toHaveLength(4);

      const repoModel = domain.models.find((m) => m.name === 'dim_work_lot');
      expect(repoModel).toBeDefined();
      expect(repoModel!.source).toBe('repo');
      expect(repoModel!.columns).toBeUndefined();

      const designModel = domain.models.find((m) => m.name === 'dim_work_lot_status');
      expect(designModel).toBeDefined();
      expect(designModel!.source).toBe('design');
      expect(designModel!.columns).toHaveLength(2);
      expect(designModel!.columns![0].isPrimaryKey).toBe(true);
    });

    it('parses relationships correctly', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'models', 'semantic', 'silver', 'work-lots.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.relationships).toHaveLength(1);

      const designRel = domain.relationships.find((r) => r.fromModel === 'brg_lot_contractor');
      expect(designRel).toBeDefined();
      expect(designRel!.toModel).toBe('dim_work_lot');
      expect(designRel!.cardinality).toBe('many-to-one');
      expect(designRel!.source).toBe('design');
    });

    it('parses viewConfig correctly', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'models', 'semantic', 'silver', 'work-lots.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.viewConfig.showFkEdges).toBe(true);
      expect(domain.viewConfig.layoutOptions).toBeDefined();
      expect(domain.viewConfig.layoutOptions!['elk.algorithm']).toBe('layered');
      expect(domain.viewConfig.positions).toBeDefined();
      expect(domain.viewConfig.positions!['dim_work_lot']).toEqual({ x: -44, y: -9 });
    });

    it('handles missing files with descriptive error', () => {
      expect(() => service.getDomain('/nonexistent/domain.json')).toThrow(
        'Domain file not found'
      );
    });

    it('handles invalid JSON with descriptive error', () => {
      const filePath = path.join(
        MALFORMED_PROJECT_PATH, 'models', 'semantic', 'silver', 'broken.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('Invalid JSON');
    });

    it('throws when schemaVersion is missing', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'models', 'semantic', 'silver', 'no-schema-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('schemaVersion');
    });

    it('throws when schemaVersion is from the future', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'models', 'semantic', 'silver', 'future-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('update the extension');
    });

    it('applies defaults for missing optional fields', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'models', 'semantic', 'silver', 'minimal.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(1);
      expect(domain.layer).toBe('silver');
      // Domain name defaults to filename
      expect(domain.domain).toBe('minimal');
      expect(domain.description).toBe('');
      expect(domain.models).toEqual([]);
      expect(domain.relationships).toEqual([]);
    });

    it('parses a domain with minimal viewConfig (no layoutOptions)', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'models', 'semantic', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.viewConfig).toBeDefined();
      expect(domain.viewConfig.positions).toBeDefined();
      expect(domain.viewConfig.layoutOptions).toBeUndefined();
    });
  });
});
