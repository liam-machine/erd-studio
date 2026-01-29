/**
 * Unit tests for AutoReconciliationService (F304).
 */

import { describe, it, expect } from 'vitest';
import { AutoReconciliationService } from '../../src/services/autoReconciliationService';
import type { SemanticDomain } from '../../src/types/semantic';
import type { ManifestData } from '../../src/types/manifest';

describe('AutoReconciliationService', () => {
  const service = new AutoReconciliationService();

  // Helper to create a mock manifest
  function createMockManifest(
    models: Array<{ name: string; columns: Array<{ name: string; data_type: string }> }>,
  ): ManifestData {
    const modelMap = new Map<string, { name: string; schema: string; description: string; columns: Array<{ name: string; data_type: string; description: string }> }>();
    for (const model of models) {
      modelMap.set(model.name, {
        name: model.name,
        schema: 'public',
        description: `Description for ${model.name}`,
        columns: model.columns.map((c) => ({ ...c, description: '' })),
      });
    }
    return { models: modelMap };
  }

  describe('findNewlyBuiltModels', () => {
    it('returns empty array when no design models exist', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          { name: 'existing_model', source: 'repo' },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'existing_model', columns: [{ name: 'id', data_type: 'integer' }] },
      ]);

      const result = service.findNewlyBuiltModels(domain, manifest);

      expect(result).toEqual([]);
    });

    it('returns empty array when design model is not in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([]); // Empty manifest

      const result = service.findNewlyBuiltModels(domain, manifest);

      expect(result).toEqual([]);
    });

    it('returns design model name when it exists in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }] },
      ]);

      const result = service.findNewlyBuiltModels(domain, manifest);

      expect(result).toEqual(['dim_customer']);
    });

    it('returns multiple design models when they exist in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
          {
            name: 'dim_product',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
          { name: 'existing_model', source: 'repo' },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }] },
        { name: 'dim_product', columns: [{ name: 'id', data_type: 'integer' }] },
        { name: 'existing_model', columns: [{ name: 'id', data_type: 'integer' }] },
      ]);

      const result = service.findNewlyBuiltModels(domain, manifest);

      expect(result).toEqual(['dim_customer', 'dim_product']);
    });
  });

  describe('transitionModelToRepo', () => {
    it('changes source from design to repo', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            schema: 'staging',
            description: 'Customer dimension',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      expect(model.source).toBe('repo');
    });

    it('removes inline columns array', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [
              { name: 'id', dataType: 'integer' },
              { name: 'name', dataType: 'string' },
            ],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }, { name: 'name', data_type: 'string' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      expect(model.columns).toBeUndefined();
    });

    it('moves columns NOT in manifest to plannedColumns', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [
              { name: 'id', dataType: 'integer' },
              { name: 'name', dataType: 'string' },
              { name: 'email', dataType: 'string', description: 'Customer email' }, // NOT in manifest
            ],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }, { name: 'name', data_type: 'string' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      expect(model.plannedColumns).toBeDefined();
      expect(model.plannedColumns).toHaveLength(1);
      expect(model.plannedColumns![0].name).toBe('email');
      expect(model.plannedColumns![0].dataType).toBe('string');
      expect(model.plannedColumns![0].description).toBe('Customer email');
    });

    it('does not add plannedColumns when all columns are in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [
              { name: 'id', dataType: 'integer' },
              { name: 'name', dataType: 'string' },
            ],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }, { name: 'name', data_type: 'string' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      expect(model.plannedColumns).toBeUndefined();
    });

    it('extracts primaryKey from isPrimaryKey flag', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [
              { name: 'customer_id', dataType: 'integer', isPrimaryKey: true },
              { name: 'name', dataType: 'string' },
            ],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'customer_id', data_type: 'integer' }, { name: 'name', data_type: 'string' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      expect(model.primaryKey).toBe('customer_id');
    });

    it('does not set primaryKey if PK column is not in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [
              { name: 'customer_id', dataType: 'integer', isPrimaryKey: true }, // NOT in manifest
              { name: 'name', dataType: 'string' },
            ],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      // Manifest only has 'name' column, not 'customer_id'
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'name', data_type: 'string' }] },
      ]);

      service.transitionModelToRepo(domain, 'dim_customer', manifest);

      const model = domain.models[0];
      // primaryKey should NOT be set because customer_id is not in manifest
      expect(model.primaryKey).toBeUndefined();
      // customer_id should be in plannedColumns instead
      expect(model.plannedColumns).toHaveLength(1);
      expect(model.plannedColumns![0].name).toBe('customer_id');
    });

    it('throws error when model not found in domain', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([]);

      expect(() => {
        service.transitionModelToRepo(domain, 'nonexistent', manifest);
      }).toThrow('Model "nonexistent" not found in domain');
    });

    it('throws error when model is not a design model', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [{ name: 'existing', source: 'repo' }],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'existing', columns: [] },
      ]);

      expect(() => {
        service.transitionModelToRepo(domain, 'existing', manifest);
      }).toThrow('Model "existing" is not a design model');
    });
  });

  describe('reconcileDomain', () => {
    it('returns transitioned: false when no design models need transition', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [{ name: 'existing', source: 'repo' }],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'existing', columns: [] },
      ]);

      const result = service.reconcileDomain(domain, manifest);

      expect(result.transitioned).toBe(false);
      expect(result.newlyBuiltModels).toEqual([]);
    });

    it('returns transitioned: true and transitions all eligible models', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
          {
            name: 'dim_product',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }] },
        { name: 'dim_product', columns: [{ name: 'id', data_type: 'integer' }] },
      ]);

      const result = service.reconcileDomain(domain, manifest);

      expect(result.transitioned).toBe(true);
      expect(result.newlyBuiltModels).toEqual(['dim_customer', 'dim_product']);
      expect(domain.models[0].source).toBe('repo');
      expect(domain.models[1].source).toBe('repo');
    });

    it('only transitions models that exist in manifest', () => {
      const domain: SemanticDomain = {
        schemaVersion: 1,
        domain: 'test',
        layer: 'silver',
        description: '',
        models: [
          {
            name: 'dim_customer',
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
          {
            name: 'dim_product', // NOT in manifest
            source: 'design',
            columns: [{ name: 'id', dataType: 'integer' }],
          },
        ],
        relationships: [],
        viewConfig: {},
      };
      const manifest = createMockManifest([
        { name: 'dim_customer', columns: [{ name: 'id', data_type: 'integer' }] },
        // dim_product NOT in manifest
      ]);

      const result = service.reconcileDomain(domain, manifest);

      expect(result.transitioned).toBe(true);
      expect(result.newlyBuiltModels).toEqual(['dim_customer']);
      expect(domain.models[0].source).toBe('repo'); // Transitioned
      expect(domain.models[1].source).toBe('design'); // Still design
    });
  });
});
