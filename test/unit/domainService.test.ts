import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { DomainService } from '../../src/services/domainService';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';
import type { ManifestData } from '../../src/types/manifest';
import type { UnifiedDomain, StageData } from '../../src/types/semantic';

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');
const FIXTURE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project');
const MALFORMED_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-malformed');
const SPARSE_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-sparse');
const LEGACY_PROJECT_PATH = path.resolve(FIXTURES_DIR, 'dbt-project-legacy');

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
    it('discovers all .json files under erd-studio/{layer}/', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);

      const silverDomains = domains.filter((d) => d.layer === 'silver');
      const goldDomains = domains.filter((d) => d.layer === 'gold');

      expect(silverDomains.length).toBeGreaterThan(0);
      expect(goldDomains).toHaveLength(1);
      expect(goldDomains[0].domain).toBe('finance');
    });

    it('does not include stage in domain summaries', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);

      for (const d of domains) {
        expect(d).not.toHaveProperty('stage');
      }
    });

    it('returns correct file paths with layer directory', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const finance = domains.find((d) => d.domain === 'finance');

      expect(finance).toBeDefined();
      expect(finance!.filePath).toBe(
        path.join(FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json')
      );
    });

    it('returns empty array when erd-studio directory does not exist', () => {
      const domains = service.listDomains('/nonexistent/path');
      expect(domains).toEqual([]);
    });

    it('returns empty array when no JSON files exist in layer', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const bronzeDomains = domains.filter((d) => d.layer === 'bronze');
      expect(bronzeDomains).toHaveLength(0);
    });

    it('supports custom semantic directory', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH, 'erd-studio');
      expect(domains.length).toBeGreaterThan(0);
    });

    it('orders domains by layer', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const layers = domains.map((d) => d.layer);

      // Silver should come before gold since bronze is empty
      const silverIdx = layers.indexOf('silver');
      const goldIdx = layers.indexOf('gold');
      expect(silverIdx).toBeLessThan(goldIdx);
    });
  });

  describe('getDomain', () => {
    it('reads and parses a valid v3 domain file into a UnifiedDomain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(3);
      expect(domain.domain).toBe('finance');
      expect(domain.layer).toBe('gold');
      expect(domain.description).toContain('Finance');
    });

    it('returns both conceptual and logical stage sections', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.conceptual).toBeDefined();
      expect(domain.logical).toBeDefined();
      expect(domain.conceptual.models).toHaveLength(1);
      expect(domain.conceptual.models[0].name).toBe('fct_transactions');
      expect(domain.logical.models).toHaveLength(0);
    });

    it('parses viewConfig correctly from conceptual section', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.conceptual.viewConfig).toBeDefined();
      expect(domain.conceptual.viewConfig.positions).toBeDefined();
      expect(domain.conceptual.viewConfig.positions!['fct_transactions']).toEqual({ x: 12, y: 12 });
    });

    it('handles missing files with descriptive error', () => {
      expect(() => service.getDomain('/nonexistent/domain.json')).toThrow(
        'Domain file not found'
      );
    });

    it('handles invalid JSON with descriptive error', () => {
      const filePath = path.join(
        MALFORMED_PROJECT_PATH, 'erd-studio', 'silver', 'broken.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('Invalid JSON');
    });

    it('throws when schemaVersion is missing', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'silver', 'no-schema-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('schemaVersion');
    });

    it('throws when schemaVersion is from the future', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'silver', 'future-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('update the extension');
    });

    it('applies defaults for missing optional fields in v3', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'silver', 'minimal.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(3);
      expect(domain.layer).toBe('silver');
      // Domain name defaults to filename
      expect(domain.domain).toBe('minimal');
      expect(domain.description).toBe('');
      expect(domain.conceptual.models).toEqual([]);
      expect(domain.conceptual.relationships).toEqual([]);
      expect(domain.logical.models).toEqual([]);
      expect(domain.logical.relationships).toEqual([]);
    });
  });

  describe('getDomain (v2 backward compatibility)', () => {
    it('auto-upgrades a v1/v2 file to UnifiedDomain in memory', () => {
      const filePath = path.join(
        LEGACY_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      // Should have been wrapped into a UnifiedDomain
      expect(domain.domain).toBe('finance');
      expect(domain.layer).toBe('gold');
      expect(domain.conceptual.models).toHaveLength(1);
      expect(domain.conceptual.models[0].name).toBe('fct_transactions');
      // Logical side should be empty (only conceptual file existed)
      expect(domain.logical.models).toHaveLength(0);
    });

    it('infers stage from grandparent directory for v2 files', () => {
      const filePath = path.join(
        LEGACY_PROJECT_PATH, 'erd-studio', 'conceptual', 'silver', 'ncr.json'
      );
      const domain = service.getDomain(filePath);

      // Content should be in the conceptual section
      expect(domain.conceptual.models.length).toBeGreaterThan(0);
      expect(domain.logical.models).toHaveLength(0);
    });
  });

  describe('getDomainStage', () => {
    it('extracts conceptual stage from unified domain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const stage = service.getDomainStage(filePath, 'conceptual');

      expect(stage.stage).toBe('conceptual');
      expect(stage.domain).toBe('finance');
      expect(stage.layer).toBe('gold');
      expect(stage.models).toHaveLength(1);
      expect(stage.models[0].name).toBe('fct_transactions');
    });

    it('extracts logical stage from unified domain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const stage = service.getDomainStage(filePath, 'logical');

      expect(stage.stage).toBe('logical');
      expect(stage.domain).toBe('finance');
      expect(stage.models).toHaveLength(0);
    });

    it('includes shared metadata in extracted stage', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'silver', 'ncr.json'
      );
      const stage = service.getDomainStage(filePath, 'conceptual');

      expect(stage.description).toBe('ncr');
      expect(stage.modelFolder).toBe('models/silver');
      expect(stage.schemaVersion).toBe(3);
    });
  });

  describe('buildPhysicalDomain', () => {
    function createUnifiedDomain(): UnifiedDomain {
      return {
        schemaVersion: 3,
        domain: 'test-domain',
        layer: 'silver',
        description: 'Test domain',
        conceptual: {
          models: [],
          relationships: [],
          viewConfig: {},
        },
        logical: {
          models: [
            {
              name: 'dim_customer',
              schema: 'silver',
              description: 'Customer dimension',
              columns: [
                { name: 'customer_id', dataType: 'integer', description: 'PK', isPrimaryKey: true },
                { name: 'customer_name', dataType: 'varchar', description: 'Name' },
              ],
              grain: 'One row per customer',
              modelRole: 'domain-dim',
            },
            {
              name: 'fct_orders',
              schema: 'silver',
              description: 'Order facts',
              columns: [
                { name: 'order_id', dataType: 'integer', description: 'PK', isPrimaryKey: true },
                { name: 'customer_id', dataType: 'integer', description: 'FK', isForeignKey: true },
              ],
            },
          ],
          relationships: [
            {
              fromModel: 'fct_orders',
              fromColumn: 'customer_id',
              toModel: 'dim_customer',
              toColumn: 'customer_id',
              cardinality: 'many-to-one',
            },
          ],
          viewConfig: {
            positions: {
              dim_customer: { x: 100, y: 200 },
              fct_orders: { x: 300, y: 200 },
            },
          },
        },
      };
    }

    function createManifest(): ManifestData {
      return {
        models: new Map([
          ['dim_customer', {
            name: 'dim_customer',
            uniqueId: 'model.my_project.dim_customer',
            projectName: 'my_project',
            schema: 'silver_schema',
            description: 'Customer dimension from manifest',
            columns: [
              { name: 'customer_id', data_type: 'bigint', description: 'Primary key' },
              { name: 'customer_name', data_type: 'text', description: 'Customer name' },
              { name: 'customer_email', data_type: 'text', description: 'Email address' },
            ],
          }],
        ]),
        relationshipTests: [],
      };
    }

    it('creates a physical DisplayDomain with stage=physical and readOnly=true', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      expect(result.stage).toBe('physical');
      expect(result.readOnly).toBe(true);
      expect(result.domain).toBe('test-domain');
      expect(result.layer).toBe('silver');
    });

    it('populates found models with manifest columns', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer).toBeDefined();
      expect(customer!.existsInManifest).toBe(true);
      expect(customer!.schema).toBe('silver_schema');
      expect(customer!.columns).toHaveLength(3); // manifest has 3 columns
      expect(customer!.columns[0].dataType).toBe('bigint');
    });

    it('carries forward PK/FK/NK flags from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      const pkCol = customer!.columns.find(c => c.name === 'customer_id');
      expect(pkCol!.isPrimaryKey).toBe(true);
    });

    it('marks missing models as ghosts with existsInManifest=false', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      const orders = result.models.find(m => m.name === 'fct_orders');
      expect(orders).toBeDefined();
      expect(orders!.existsInManifest).toBe(false);
      expect(orders!.columns).toHaveLength(2); // keeps logical columns
    });

    it('copies relationships from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].fromModel).toBe('fct_orders');
      expect(result.relationships[0].cardinality).toBe('many-to-one');
    });

    it('copies viewConfig positions from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      expect(result.viewConfig.positions).toEqual({
        dim_customer: { x: 100, y: 200 },
        fct_orders: { x: 300, y: 200 },
      });
    });

    it('does not include templates or manifestModels', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      expect(result.templates).toBeUndefined();
      expect(result.manifestModels).toBeUndefined();
    });

    it('carries forward grain and modelRole from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer!.grain).toBe('One row per customer');
      expect(customer!.modelRole).toBe('domain-dim');
    });
  });
});
