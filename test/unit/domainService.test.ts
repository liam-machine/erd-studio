import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { DomainService, derivePhysicalRelationships, relationshipReferencesColumn } from '../../src/services/domainService';
import type { LayerService } from '../../src/services/layerService';
import type { LayerConfig } from '../../src/types/layer';
import type { ManifestData, ManifestRelationshipTest } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';
import type { UnifiedDomain, StageData } from '../../src/types/semantic';

/** Empty YmlData — forces buildPhysicalDomain to use the manifest-only fallback. */
const EMPTY_YML_DATA: YmlData = {
  models: new Map(),
  relationshipTests: [],
  uniqueColumns: new Map(),
  compositeUniqueGroups: new Map(),
};

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
    it('reads and parses a valid domain file into a UnifiedDomain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(4);
      expect(domain.domain).toBe('finance');
      expect(domain.layer).toBe('gold');
      expect(domain.description).toContain('Finance');
    });

    it('returns logical stage section', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.logical).toBeDefined();
      expect(domain.logical.models).toHaveLength(0);
    });

    it('parses viewConfig correctly from top-level', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
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

    it('applies defaults for missing optional fields', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, 'erd-studio', 'silver', 'minimal.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.layer).toBe('silver');
      // Domain name defaults to filename
      expect(domain.domain).toBe('minimal');
      expect(domain.description).toBe('');
      expect(domain.logical.models).toEqual([]);
      expect(domain.logical.relationships).toEqual([]);
    });
  });

  describe('getDomainStage', () => {
    it('extracts logical stage from unified domain', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'gold', 'finance.json'
      );
      const stage = service.getDomainStage(filePath);

      expect(stage.stage).toBe('logical');
      expect(stage.domain).toBe('finance');
      expect(stage.models).toHaveLength(0);
    });

    it('includes shared metadata in extracted stage', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, 'erd-studio', 'silver', 'ncr.json'
      );
      const stage = service.getDomainStage(filePath);

      expect(stage.description).toBe('ncr');
      expect(stage.modelFolder).toBe('models/silver');
    });
  });

  describe('buildPhysicalDomain', () => {
    function createUnifiedDomain(): UnifiedDomain {
      return {
        schemaVersion: 4,
        domain: 'test-domain',
        layer: 'silver',
        description: 'Test domain',
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
        },
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
        uniqueColumns: new Map(),
        compositeUniqueGroups: new Map(),
      };
    }

    function createManifestWithBothModels(): ManifestData {
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
            ],
          }],
          ['fct_orders', {
            name: 'fct_orders',
            uniqueId: 'model.my_project.fct_orders',
            projectName: 'my_project',
            schema: 'silver_schema',
            description: 'Order facts from manifest',
            columns: [
              { name: 'order_id', data_type: 'bigint', description: 'Primary key' },
              { name: 'customer_id', data_type: 'bigint', description: 'FK to customer' },
            ],
          }],
        ]),
        relationshipTests: [
          {
            fromModel: 'fct_orders',
            fromColumn: 'customer_id',
            toModel: 'dim_customer',
            toColumn: 'customer_id',
          },
        ],
        uniqueColumns: new Map([
          ['dim_customer', new Set(['customer_id'])],
          ['fct_orders', new Set(['order_id'])],
        ]),
        compositeUniqueGroups: new Map(),
      };
    }

    it('creates a physical DisplayDomain with stage=physical and readOnly=true', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      expect(result.stage).toBe('physical');
      expect(result.readOnly).toBe(true);
      expect(result.domain).toBe('test-domain');
      expect(result.layer).toBe('silver');
    });

    it('populates found models with manifest columns', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer).toBeDefined();
      expect(customer!.existsInManifest).toBe(true);
      expect(customer!.schema).toBe('silver_schema');
      expect(customer!.columns).toHaveLength(3); // manifest has 3 columns
      expect(customer!.columns[0].dataType).toBe('bigint');
    });

    it('carries forward PK/FK/NK flags from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      const pkCol = customer!.columns.find(c => c.name === 'customer_id');
      expect(pkCol!.isPrimaryKey).toBe(true);
    });

    it('excludes models not found in manifest from physical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      const orders = result.models.find(m => m.name === 'fct_orders');
      expect(orders).toBeUndefined();
      expect(result.models).toHaveLength(1); // only dim_customer
    });

    it('excludes relationships when referenced models not in manifest', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      // fct_orders is not in manifest, so no relationship tests can match
      expect(result.relationships).toHaveLength(0);
    });

    it('derives relationships from manifest relationship tests with cardinality', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifestWithBothModels());

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0].fromModel).toBe('fct_orders');
      expect(result.relationships[0].fromColumn).toBe('customer_id');
      expect(result.relationships[0].toModel).toBe('dim_customer');
      expect(result.relationships[0].toColumn).toBe('customer_id');
      // customer_id is unique on dim_customer but NOT on fct_orders → many-to-one
      expect(result.relationships[0].cardinality).toBe('many-to-one');
    });

    it('uses global viewConfig positions', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      expect(result.viewConfig.positions).toEqual({
        dim_customer: { x: 100, y: 200 },
        fct_orders: { x: 300, y: 200 },
      });
    });

    it('does not include templates or manifestModels', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      expect(result.templates).toBeUndefined();
      expect(result.manifestModels).toBeUndefined();
    });

    it('carries forward grain and modelRole from logical domain', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer!.grain).toBe('One row per customer');
      expect(customer!.modelRole).toBe('domain-dim');
    });
  });

  describe('derivePhysicalRelationships', () => {
    const models = new Set(['dim_customer', 'fct_orders', 'dim_product']);

    it('derives many-to-one when toColumn is unique and fromColumn is not', () => {
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
      ];
      const unique = new Map([['dim_customer', new Set(['customer_id'])]]);

      const result = derivePhysicalRelationships(tests, models, unique, new Map());

      expect(result).toHaveLength(1);
      expect(result[0].cardinality).toBe('many-to-one');
    });

    it('derives one-to-one when both columns are unique', () => {
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
      ];
      const unique = new Map([
        ['dim_customer', new Set(['customer_id'])],
        ['fct_orders', new Set(['customer_id'])],
      ]);

      const result = derivePhysicalRelationships(tests, models, unique, new Map());

      expect(result[0].cardinality).toBe('one-to-one');
    });

    it('derives one-to-many when fromColumn is unique and toColumn is not', () => {
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'order_id', toModel: 'dim_customer', toColumn: 'customer_name' },
      ];
      const unique = new Map([['fct_orders', new Set(['order_id'])]]);

      const result = derivePhysicalRelationships(tests, models, unique, new Map());

      expect(result[0].cardinality).toBe('one-to-many');
    });

    it('derives many-to-many when neither column has unique test', () => {
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_name' },
      ];

      const result = derivePhysicalRelationships(tests, models, new Map(), new Map());

      expect(result[0].cardinality).toBe('many-to-many');
    });

    it('scopes relationships to domain models (conformed dim safety)', () => {
      // dim_customer is a conformed dim. fct_orders is in domain, but dim_product is in domain too.
      // A relationship from an outside model should be excluded.
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
        { fromModel: 'fct_external', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
      ];
      const unique = new Map([['dim_customer', new Set(['customer_id'])]]);

      const result = derivePhysicalRelationships(tests, models, unique, new Map());

      // fct_external is NOT in the domain model set
      expect(result).toHaveLength(1);
      expect(result[0].fromModel).toBe('fct_orders');
    });

    it('handles multiple independent FKs between same model pair', () => {
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'billing_customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
        { fromModel: 'fct_orders', fromColumn: 'shipping_customer_id', toModel: 'dim_customer', toColumn: 'customer_id' },
      ];
      const unique = new Map([['dim_customer', new Set(['customer_id'])]]);

      const result = derivePhysicalRelationships(tests, models, unique, new Map());

      expect(result).toHaveLength(2);
      expect(result[0].cardinality).toBe('many-to-one');
      expect(result[1].cardinality).toBe('many-to-one');
    });

    it('uses composite unique groups for cardinality derivation', () => {
      // dim_product has a composite unique on (product_id, region_id)
      // Two relationship tests from fct_orders cover both columns
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'product_id', toModel: 'dim_product', toColumn: 'product_id' },
        { fromModel: 'fct_orders', fromColumn: 'region_id', toModel: 'dim_product', toColumn: 'region_id' },
      ];
      const compositeGroups = new Map([
        ['dim_product', [['product_id', 'region_id']]],
      ]);

      const result = derivePhysicalRelationships(tests, models, new Map(), compositeGroups);

      // Both toColumns covered by composite unique → to side is "one"
      // fromColumns have no unique → from side is "many"
      expect(result).toHaveLength(2);
      expect(result[0].cardinality).toBe('many-to-one');
      expect(result[1].cardinality).toBe('many-to-one');
    });

    it('composite unique does not apply when not all columns are covered', () => {
      // dim_product has composite unique on (product_id, region_id)
      // Only ONE relationship test exists — partial coverage
      const tests: ManifestRelationshipTest[] = [
        { fromModel: 'fct_orders', fromColumn: 'product_id', toModel: 'dim_product', toColumn: 'product_id' },
      ];
      const compositeGroups = new Map([
        ['dim_product', [['product_id', 'region_id']]],
      ]);

      const result = derivePhysicalRelationships(tests, models, new Map(), compositeGroups);

      // Only one of two composite columns present → NOT unique → many-to-many
      expect(result).toHaveLength(1);
      expect(result[0].cardinality).toBe('many-to-many');
    });

    it('returns empty array when no relationship tests exist', () => {
      const result = derivePhysicalRelationships([], models, new Map(), new Map());
      expect(result).toEqual([]);
    });
  });

  describe('relationshipReferencesColumn', () => {
    const rel = {
      fromModel: 'fct_orders',
      fromColumn: 'customer_id',
      toModel: 'dim_customer',
      toColumn: 'customer_id',
    };

    it('matches when the column is the from-endpoint', () => {
      expect(relationshipReferencesColumn(rel, 'fct_orders', 'customer_id')).toBe(true);
    });

    it('matches when the column is the to-endpoint', () => {
      expect(relationshipReferencesColumn(rel, 'dim_customer', 'customer_id')).toBe(true);
    });

    it('does not match when only the model name matches', () => {
      expect(relationshipReferencesColumn(rel, 'fct_orders', 'order_id')).toBe(false);
    });

    it('does not match when only the column name matches a different model', () => {
      expect(relationshipReferencesColumn(rel, 'dim_product', 'customer_id')).toBe(false);
    });

    it('matches a self-referencing relationship on either endpoint', () => {
      const selfRef = {
        fromModel: 'dim_employee',
        fromColumn: 'employee_id',
        toModel: 'dim_employee',
        toColumn: 'manager_id',
      };
      expect(relationshipReferencesColumn(selfRef, 'dim_employee', 'employee_id')).toBe(true);
      expect(relationshipReferencesColumn(selfRef, 'dim_employee', 'manager_id')).toBe(true);
      expect(relationshipReferencesColumn(selfRef, 'dim_employee', 'other_col')).toBe(false);
    });

    it('handles relationships with missing endpoint fields without throwing', () => {
      expect(relationshipReferencesColumn({}, 'fct_orders', 'customer_id')).toBe(false);
    });
  });
});
