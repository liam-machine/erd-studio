import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { DomainService } from '../../src/services/domainService';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
const MALFORMED_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-malformed');
const SPARSE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-sparse');

describe('DomainService', () => {
  let service: DomainService;

  beforeEach(() => {
    service = new DomainService();
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

      expect(domain.relationships).toHaveLength(3);

      const repoRel = domain.relationships.find((r) => r.fromModel === 'dim_work_lot');
      expect(repoRel).toBeDefined();
      expect(repoRel!.cardinality).toBe('many-to-one');
      expect(repoRel!.source).toBeUndefined();

      const designRel = domain.relationships.find((r) => r.fromModel === 'dim_work_lot_status');
      expect(designRel).toBeDefined();
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
      expect(domain.viewConfig.positions!['dim_work_lot']).toEqual({ x: 309, y: -151 });
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
