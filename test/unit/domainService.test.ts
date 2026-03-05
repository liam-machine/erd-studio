import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { DomainService } from '../../src/services/domainService';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';
import type { ManifestData } from '../../src/types/manifest';
import type { SemanticDomain } from '../../src/types/semantic';

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
    it('discovers all .json files under erd-studio/{stage}/{layer}/', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);

      // Should find files under conceptual/silver and conceptual/gold
      const silverDomains = domains.filter((d) => d.layer === 'silver');
      const goldDomains = domains.filter((d) => d.layer === 'gold');

      expect(silverDomains.length).toBeGreaterThan(0);
      expect(goldDomains).toHaveLength(1);
      expect(goldDomains[0].domain).toBe('finance');
    });

    it('includes stage in domain summaries', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);

      // All fixture domains are under conceptual/
      for (const d of domains) {
        expect(d.stage).toBe('conceptual');
      }
    });

    it('returns correct file paths with stage directory', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const finance = domains.find((d) => d.domain === 'finance');

      expect(finance).toBeDefined();
      expect(finance!.filePath).toBe(
        path.join(FIXTURE_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json')
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

    it('iterates stages then layers in order', () => {
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
        FIXTURE_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(1);
      expect(domain.domain).toBe('finance');
      expect(domain.layer).toBe('gold');
      expect(domain.description).toContain('Finance');
    });

    it('infers stage from grandparent directory', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.stage).toBe('conceptual');
    });

    it('parses models correctly', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.models).toHaveLength(1);
      expect(domain.models[0].name).toBe('fct_transactions');
    });

    it('parses viewConfig correctly', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'conceptual', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.viewConfig).toBeDefined();
      expect(domain.viewConfig.positions).toBeDefined();
      expect(domain.viewConfig.positions!['fct_transactions']).toEqual({ x: 12, y: 12 });
    });

    it('handles missing files with descriptive error', () => {
      expect(() => service.getDomain('/nonexistent/domain.json')).toThrow(
        'Domain file not found'
      );
    });

    it('handles invalid JSON with descriptive error', () => {
      const filePath = path.join(
        MALFORMED_PROJECT_PATH, 'erd-studio', 'conceptual', 'silver', 'broken.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('Invalid JSON');
    });

    it('throws when schemaVersion is missing', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'conceptual', 'silver', 'no-schema-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('schemaVersion');
    });

    it('throws when schemaVersion is from the future', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'conceptual', 'silver', 'future-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('update the extension');
    });

    it('applies defaults for missing optional fields', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'conceptual', 'silver', 'minimal.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(1);
      expect(domain.layer).toBe('silver');
      expect(domain.stage).toBe('conceptual');
      // Domain name defaults to filename
      expect(domain.domain).toBe('minimal');
      expect(domain.description).toBe('');
      expect(domain.models).toEqual([]);
      expect(domain.relationships).toEqual([]);
    });
  });

  describe('buildPhysicalDomain', () => {
    function createLogicalDomain(): SemanticDomain {
      return {
        schemaVersion: 2,
        domain: 'test-domain',
        layer: 'silver',
        stage: 'logical',
        description: 'Test logical domain',
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
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      expect(result.stage).toBe('physical');
      expect(result.readOnly).toBe(true);
      expect(result.domain).toBe('test-domain');
      expect(result.layer).toBe('silver');
    });

    it('populates found models with manifest columns', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer).toBeDefined();
      expect(customer!.existsInManifest).toBe(true);
      expect(customer!.schema).toBe('silver_schema');
      expect(customer!.columns).toHaveLength(3); // manifest has 3 columns
      expect(customer!.columns[0].dataType).toBe('bigint');
    });

    it('carries forward PK/FK/NK flags from logical domain', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      const pkCol = customer!.columns.find(c => c.name === 'customer_id');
      expect(pkCol!.isPrimaryKey).toBe(true);
    });

    it('marks missing models as ghosts with existsInManifest=false', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      const orders = result.models.find(m => m.name === 'fct_orders');
      expect(orders).toBeDefined();
      expect(orders!.existsInManifest).toBe(false);
      expect(orders!.columns).toHaveLength(2); // keeps logical columns
    });

    it('copies relationships from logical domain', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].fromModel).toBe('fct_orders');
      expect(result.relationships[0].cardinality).toBe('many-to-one');
    });

    it('copies viewConfig positions from logical domain', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      expect(result.viewConfig.positions).toEqual({
        dim_customer: { x: 100, y: 200 },
        fct_orders: { x: 300, y: 200 },
      });
    });

    it('does not include templates or manifestModels', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      expect(result.templates).toBeUndefined();
      expect(result.manifestModels).toBeUndefined();
    });

    it('carries forward grain and modelRole from logical domain', () => {
      const result = service.buildPhysicalDomain(createLogicalDomain(), createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer!.grain).toBe('One row per customer');
      expect(customer!.modelRole).toBe('domain-dim');
    });
  });
});
