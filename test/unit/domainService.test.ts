import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DomainService, derivePhysicalRelationships, relationshipReferencesColumn, renameDomainInRaw } from '../../src/services/domainService';
import { LogicalModelService } from '../../src/services/logicalModelService';
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
    it('discovers all .json files under .erd-studio/{layer}/', () => {
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
        path.join(FIXTURE_PROJECT_PATH, '.erd-studio', 'gold', 'finance.json')
      );
    });

    it('returns empty array when .erd-studio directory does not exist', () => {
      const domains = service.listDomains('/nonexistent/path');
      expect(domains).toEqual([]);
    });

    it('returns empty array when no JSON files exist in layer', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH);
      const bronzeDomains = domains.filter((d) => d.layer === 'bronze');
      expect(bronzeDomains).toHaveLength(0);
    });

    it('supports custom semantic directory', () => {
      const domains = service.listDomains(FIXTURE_PROJECT_PATH, '.erd-studio');
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
        FIXTURE_PROJECT_PATH, '.erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.schemaVersion).toBe(4);
      expect(domain.domain).toBe('finance');
      expect(domain.layer).toBe('gold');
      expect(domain.description).toContain('Finance');
    });

    it('returns logical stage section', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, '.erd-studio', 'gold', 'finance.json'
      );
      const domain = service.getDomain(filePath);

      expect(domain.logical).toBeDefined();
      expect(domain.logical.models).toHaveLength(0);
    });

    it('parses viewConfig correctly from top-level', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, '.erd-studio', 'gold', 'finance.json'
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
        MALFORMED_PROJECT_PATH, '.erd-studio', 'silver', 'broken.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('Invalid JSON');
    });

    it('throws when schemaVersion is missing', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, '.erd-studio', 'silver', 'no-schema-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('schemaVersion');
    });

    it('throws when schemaVersion is from the future', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, '.erd-studio', 'silver', 'future-version.json'
      );
      expect(() => service.getDomain(filePath)).toThrow('update the extension');
    });

    it('applies defaults for missing optional fields', () => {
      const filePath = path.join(
        SPARSE_PROJECT_PATH, '.erd-studio', 'silver', 'minimal.json'
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
        FIXTURE_PROJECT_PATH, '.erd-studio', 'gold', 'finance.json'
      );
      const stage = service.getDomainStage(filePath);

      expect(stage.stage).toBe('logical');
      expect(stage.domain).toBe('finance');
      expect(stage.models).toHaveLength(0);
    });

    it('includes shared metadata in extracted stage', () => {
      const filePath = path.join(
        FIXTURE_PROJECT_PATH, '.erd-studio', 'silver', 'ncr.json'
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

    // -----------------------------------------------------------------------
    // H09 — per-model yml/manifest resolution and relationship-test union
    // -----------------------------------------------------------------------

    /** yml covering ONLY dim_customer (fct_orders has no schema.yml entry). */
    function createPartialYmlData(): YmlData {
      return {
        models: new Map([
          ['dim_customer', {
            name: 'dim_customer',
            description: 'Customer dimension from yml',
            filePath: '/proj/models/dim_customer.yml',
            tags: [],
            columns: [
              { name: 'customer_id', description: 'PK from yml', dataType: null },
              { name: 'customer_name', description: '', dataType: 'STRING' },
            ],
          }],
        ]),
        relationshipTests: [],
        uniqueColumns: new Map([['dim_customer', new Set(['customer_id'])]]),
        compositeUniqueGroups: new Map(),
      };
    }

    it('includes manifest-only models when yml covers other models (partial yml is not all-or-nothing)', () => {
      const result = service.buildPhysicalDomain(
        createUnifiedDomain(), createPartialYmlData(), createManifestWithBothModels(),
      );

      expect(result.models.map(m => m.name).sort()).toEqual(['dim_customer', 'fct_orders']);

      // fct_orders came from the manifest: manifest columns + schema
      const orders = result.models.find(m => m.name === 'fct_orders')!;
      expect(orders.existsInManifest).toBe(true);
      expect(orders.schema).toBe('silver_schema');
      expect(orders.columns.map(c => c.name)).toEqual(['order_id', 'customer_id']);
      expect(orders.columns[0].dataType).toBe('bigint');
      // PK flag carried over from logical even for the manifest-resolved model
      expect(orders.columns.find(c => c.name === 'order_id')!.isPrimaryKey).toBe(true);
      expect(orders.columns.find(c => c.name === 'customer_id')!.isForeignKey).toBe(true);
    });

    it('prefers yml columns over manifest columns when both exist, enriching data types from manifest', () => {
      const result = service.buildPhysicalDomain(
        createUnifiedDomain(), createPartialYmlData(), createManifestWithBothModels(),
      );

      const customer = result.models.find(m => m.name === 'dim_customer')!;
      expect(customer.description).toBe('Customer dimension from yml');
      // yml has no data_type on customer_id → enriched from manifest
      expect(customer.columns.find(c => c.name === 'customer_id')!.dataType).toBe('bigint');
      expect(customer.columns.find(c => c.name === 'customer_id')!.description).toBe('PK from yml');
      // yml data_type wins where declared
      expect(customer.columns.find(c => c.name === 'customer_name')!.dataType).toBe('STRING');
    });

    it('derives relationships from manifest tests even when yml has none', () => {
      const result = service.buildPhysicalDomain(
        createUnifiedDomain(), createPartialYmlData(), createManifestWithBothModels(),
      );

      expect(result.relationships).toHaveLength(1);
      expect(result.relationships[0]).toMatchObject({
        fromModel: 'fct_orders', fromColumn: 'customer_id',
        toModel: 'dim_customer', toColumn: 'customer_id',
        cardinality: 'many-to-one',
      });
    });

    it('unions yml and manifest relationship tests, deduping identical ones', () => {
      const yml = createPartialYmlData();
      yml.models.set('fct_orders', {
        name: 'fct_orders', description: '', filePath: '/proj/models/fct_orders.yml', tags: [],
        columns: [
          { name: 'order_id', description: '', dataType: null },
          { name: 'customer_id', description: '', dataType: null },
        ],
      });
      // Same test as the manifest (should dedupe) — spelled in a different case
      yml.relationshipTests.push({
        fromModel: 'FCT_ORDERS', fromColumn: 'CUSTOMER_ID', toModel: 'DIM_CUSTOMER', toColumn: 'CUSTOMER_ID',
      });

      const manifest = createManifestWithBothModels();
      // Manifest carries an extra test the yml does not have
      manifest.relationshipTests.push({
        fromModel: 'dim_customer', fromColumn: 'customer_name', toModel: 'fct_orders', toColumn: 'order_id',
      });

      const result = service.buildPhysicalDomain(createUnifiedDomain(), yml, manifest);

      expect(result.relationships).toHaveLength(2);
      const keys = result.relationships.map(r => `${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn}`).sort();
      expect(keys).toEqual([
        'dim_customer.customer_name->fct_orders.order_id',
        'fct_orders.CUSTOMER_ID->dim_customer.CUSTOMER_ID',
      ]);
    });

    it('omits models present in neither yml nor manifest', () => {
      const result = service.buildPhysicalDomain(createUnifiedDomain(), createPartialYmlData(), undefined);

      expect(result.models.map(m => m.name)).toEqual(['dim_customer']);
      expect(result.models[0].existsInManifest).toBe(false);
      expect(result.models[0].schema).toBe('');
    });

    // -----------------------------------------------------------------------
    // H32 — case-insensitive model/column matching in physical enrichment
    // -----------------------------------------------------------------------

    it('matches yml model and column names case-insensitively, keeping logical spelling for the model', () => {
      const yml: YmlData = {
        models: new Map([
          ['DIM_CUSTOMER', {
            name: 'DIM_CUSTOMER', description: '', filePath: '/p/x.yml', tags: [],
            columns: [
              { name: 'CUSTOMER_ID', description: '', dataType: null },
              { name: 'CUSTOMER_NAME', description: '', dataType: null },
            ],
          }],
        ]),
        relationshipTests: [],
        uniqueColumns: new Map(),
        compositeUniqueGroups: new Map(),
      };

      const result = service.buildPhysicalDomain(createUnifiedDomain(), yml, createManifest());

      const customer = result.models.find(m => m.name === 'dim_customer');
      expect(customer).toBeDefined();
      // yml column spelling is displayed, manifest data type enriched, PK flag carried from logical
      const pk = customer!.columns.find(c => c.name === 'CUSTOMER_ID')!;
      expect(pk.dataType).toBe('bigint');
      expect(pk.isPrimaryKey).toBe(true);
    });

    it('derives cardinality case-insensitively from uniqueness tests', () => {
      const manifest = createManifestWithBothModels();
      manifest.uniqueColumns = new Map([['DIM_CUSTOMER', new Set(['CUSTOMER_ID'])]]);
      manifest.relationshipTests = [{
        fromModel: 'FCT_ORDERS', fromColumn: 'customer_id', toModel: 'Dim_Customer', toColumn: 'Customer_Id',
      }];

      const result = service.buildPhysicalDomain(createUnifiedDomain(), EMPTY_YML_DATA, manifest);

      expect(result.relationships).toHaveLength(1);
      // Edge model names are rewritten to the domain's (logical) spelling
      expect(result.relationships[0].fromModel).toBe('fct_orders');
      expect(result.relationships[0].toModel).toBe('dim_customer');
      expect(result.relationships[0].cardinality).toBe('many-to-one');
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

// ---------------------------------------------------------------------------
// Domain format handling (H01 / H26 / H40)
// ---------------------------------------------------------------------------

describe('DomainService format handling', () => {
  let tmpRoot: string;
  let service: DomainService;

  /** Write a domain JSON into a temp .erd-studio/silver/ dir and return its path. */
  function writeDomain(name: string, body: unknown): string {
    const dir = path.join(tmpRoot, '.erd-studio', 'silver');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(body, null, 2));
    return filePath;
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-domain-format-'));
    service = new DomainService(createMockLayerService());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('legacy (pre-v4) documents', () => {
    it('throws a clear error naming the migration command instead of loading an empty domain', () => {
      const filePath = writeDomain('legacy', {
        schemaVersion: 2,
        domain: 'legacy',
        layer: 'silver',
        stage: 'logical',
        models: [{ name: 'dim_x', columns: [] }],
        relationships: [],
        viewConfig: {},
      });
      expect(() => service.getDomain(filePath)).toThrow(/no longer supported/);
      expect(() => service.getDomain(filePath)).toThrow(/Migrate to v5/);
    });

    it('rejects a top-level models array even at schemaVersion 5', () => {
      const filePath = writeDomain('toplevel', {
        schemaVersion: 5,
        domain: 'toplevel',
        layer: 'silver',
        models: [{ name: 'dim_x' }],
        relationships: [],
        viewConfig: {},
      });
      expect(() => service.getDomain(filePath)).toThrow(/no longer supported/);
    });
  });

  describe('hybrid documents', () => {
    it('rejects schemaVersion 5 with inline model objects', () => {
      const filePath = writeDomain('inline5', {
        schemaVersion: 5,
        domain: 'inline5',
        layer: 'silver',
        logical: { models: [{ name: 'dim_x', columns: [] }], relationships: [] },
        viewConfig: {},
      });
      expect(() => service.getDomain(filePath)).toThrow(/Migrate to v5/);
    });

    it('rejects mixed string/object model arrays instead of creating placeholder nodes', () => {
      const filePath = writeDomain('mixed', {
        schemaVersion: 5,
        domain: 'mixed',
        layer: 'silver',
        logical: { models: ['dim_project', { name: 'inline_obj', columns: [] }], relationships: [] },
        viewConfig: {},
      });
      expect(() => service.getDomain(filePath)).toThrow(/mixes inline model objects/);
    });
  });

  describe('per-entry validation', () => {
    it('skips inline v4 models that lack a string name', () => {
      const filePath = writeDomain('v4bad', {
        schemaVersion: 4,
        domain: 'v4bad',
        layer: 'silver',
        logical: {
          models: [{ name: 'dim_ok', columns: [] }, { columns: [] }, { name: 42 }],
          relationships: [],
        },
        viewConfig: {},
      });
      const domain = service.getDomain(filePath);
      expect(domain.logical.models.map((m) => m.name)).toEqual(['dim_ok']);
    });

    it('drops malformed relationship entries and defaults invalid cardinality', () => {
      const filePath = writeDomain('rels', {
        schemaVersion: 5,
        domain: 'rels',
        layer: 'silver',
        logical: {
          models: ['dim_a', 'fct_b'],
          relationships: [
            { fromModel: 'fct_b', fromColumn: 'a_id', toModel: 'dim_a', toColumn: 'a_id', cardinality: 'many-to-one' },
            { fromModel: 'fct_b', fromColumn: 'a_id', toModel: 'dim_a', toColumn: 'a_id', cardinality: 'lots-to-few' },
            { fromModel: 'dim_a' },
            'garbage',
            null,
            42,
          ],
        },
        viewConfig: {},
      });
      const domain = service.getDomain(filePath);
      expect(domain.logical.relationships).toEqual([
        { fromModel: 'fct_b', fromColumn: 'a_id', toModel: 'dim_a', toColumn: 'a_id', cardinality: 'many-to-one' },
        { fromModel: 'fct_b', fromColumn: 'a_id', toModel: 'dim_a', toColumn: 'a_id', cardinality: 'many-to-one' },
      ]);
    });

    it('keeps only viewConfig.positions entries with finite numeric x/y', () => {
      const filePath = writeDomain('positions', {
        schemaVersion: 5,
        domain: 'positions',
        layer: 'silver',
        logical: { models: ['dim_a', 'dim_b', 'dim_c', 'dim_d'], relationships: [] },
        viewConfig: {
          positions: {
            dim_a: { x: 100, y: 200 },
            dim_b: { x: '100', y: null },
            dim_c: 'str',
            dim_d: { x: 1e400, y: 0 },
            dim_e: null,
          },
        },
      });
      const domain = service.getDomain(filePath);
      expect(domain.viewConfig.positions).toEqual({ dim_a: { x: 100, y: 200 } });
    });
  });

  describe('renameDomainInRaw (H01)', () => {
    it('rewrites only the domain slug, preserving v5 name references and unknown keys', () => {
      const original = {
        schemaVersion: 5,
        domain: 'showcase',
        layer: 'silver',
        description: 'desc',
        modelFolder: 'models/silver',
        stubColumns: ['dim_project'],
        someFutureKey: { nested: true },
        logical: {
          models: ['fct_task_event', 'dim_project'],
          relationships: [
            { fromModel: 'fct_task_event', fromColumn: 'project_id', toModel: 'dim_project', toColumn: 'project_id', cardinality: 'many-to-one' },
          ],
        },
        viewConfig: { positions: { dim_project: { x: 1, y: 2 } }, unknownViewKey: 'kept' },
      };

      const renamed = JSON.parse(renameDomainInRaw(JSON.stringify(original), 'renamed'));
      expect(renamed).toEqual({ ...original, domain: 'renamed' });
      expect(renamed.logical.models.every((m: unknown) => typeof m === 'string')).toBe(true);
    });

    it('ends with a trailing newline and 2-space indentation', () => {
      const out = renameDomainInRaw('{"schemaVersion":5,"domain":"a","layer":"silver","logical":{"models":[],"relationships":[]},"viewConfig":{}}', 'b');
      expect(out.endsWith('}\n')).toBe(true);
      expect(out).toContain('\n  "domain": "b"');
    });

    it('throws for non-object JSON', () => {
      expect(() => renameDomainInRaw('[]', 'x')).toThrow('JSON object');
      expect(() => renameDomainInRaw('null', 'x')).toThrow('JSON object');
    });

    it('end-to-end: a renamed v5 fixture still resolves models live from logical-models/', () => {
      // Copy the fixture project so we can rename and mutate yml safely
      fs.cpSync(path.join(FIXTURE_PROJECT_PATH, '.erd-studio'), path.join(tmpRoot, '.erd-studio'), { recursive: true });
      const lms = new LogicalModelService(tmpRoot);
      service.setLogicalModelService(lms);

      const oldPath = path.join(tmpRoot, '.erd-studio', 'silver', 'showcase.json');
      const newPath = path.join(tmpRoot, '.erd-studio', 'silver', 'renamed.json');
      fs.writeFileSync(newPath, renameDomainInRaw(fs.readFileSync(oldPath, 'utf-8'), 'renamed'));

      // The renamed file is still a clean v5 document
      const rawRenamed = JSON.parse(fs.readFileSync(newPath, 'utf-8'));
      expect(rawRenamed.domain).toBe('renamed');
      expect(rawRenamed.schemaVersion).toBe(5);
      expect(typeof rawRenamed.logical.models[0]).toBe('string');

      // A yml edit made after the rename is visible through the renamed domain
      const before = service.getDomain(newPath);
      const target = before.logical.models.find((m) => m.name === 'fct_task_event')!;
      expect(target.columns!.some((c) => c.name === 'zzz_new_col')).toBe(false);

      const model = lms.getModel('fct_task_event')!;
      model.columns = [...(model.columns ?? []), { name: 'zzz_new_col', dataType: 'INT', description: '' }];
      lms.saveModel(model);

      const after = service.getDomain(newPath);
      const updated = after.logical.models.find((m) => m.name === 'fct_task_event')!;
      expect(updated.columns!.some((c) => c.name === 'zzz_new_col')).toBe(true);
    });

    it('regression: re-serialising the resolved UnifiedDomain produces a hybrid file that is now rejected', () => {
      fs.cpSync(path.join(FIXTURE_PROJECT_PATH, '.erd-studio'), path.join(tmpRoot, '.erd-studio'), { recursive: true });
      service.setLogicalModelService(new LogicalModelService(tmpRoot));

      const oldPath = path.join(tmpRoot, '.erd-studio', 'silver', 'showcase.json');
      const resolved = service.getDomain(oldPath);
      resolved.domain = 'broken';
      const brokenPath = path.join(tmpRoot, '.erd-studio', 'silver', 'broken.json');
      fs.writeFileSync(brokenPath, JSON.stringify(resolved, null, 2));

      expect(() => service.getDomain(brokenPath)).toThrow(/Migrate to v5/);
    });
  });
});
