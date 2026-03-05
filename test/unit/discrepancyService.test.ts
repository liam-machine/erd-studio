import { describe, it, expect } from 'vitest';
import { compare } from '../../src/services/discrepancyService';
import type { DisplayDomain, DisplayModel, DisplayRelationship } from '../../src/types/display';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDomain(overrides: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 2,
    domain: 'test',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [],
    relationships: [],
    viewConfig: { positions: {} },
    readOnly: false,
    ...overrides,
  };
}

function makeModel(name: string, columns: DisplayModel['columns'] = []): DisplayModel {
  return { name, schema: '', description: '', columns };
}

function makeColumn(name: string, dataType = 'VARCHAR'): DisplayModel['columns'][0] {
  return { name, dataType, description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false };
}

function makeRel(
  from: [string, string],
  to: [string, string],
  cardinality: DisplayRelationship['cardinality'] = 'many-to-one',
): DisplayRelationship {
  return { fromModel: from[0], fromColumn: from[1], toModel: to[0], toColumn: to[1], cardinality };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscrepancyService.compare', () => {
  describe('model matching', () => {
    it('reports all models as matched when both domains have the same models', () => {
      const source = makeDomain({ models: [makeModel('dim_customer'), makeModel('fct_orders')] });
      const target = makeDomain({ models: [makeModel('dim_customer'), makeModel('fct_orders')] });

      const report = compare(source, target);

      expect(report.models).toHaveLength(2);
      expect(report.models.every((m) => m.status === 'matched')).toBe(true);
      expect(report.summary.matchedModels).toBe(2);
      expect(report.summary.extraModels).toBe(0);
      expect(report.summary.missingModels).toBe(0);
    });

    it('reports extra models that exist in source but not target', () => {
      const source = makeDomain({ models: [makeModel('dim_customer'), makeModel('stg_raw')] });
      const target = makeDomain({ models: [makeModel('dim_customer')] });

      const report = compare(source, target);

      const extra = report.models.find((m) => m.name === 'stg_raw');
      expect(extra?.status).toBe('extra');
      expect(report.summary.extraModels).toBe(1);
    });

    it('reports missing models that exist in target but not source', () => {
      const source = makeDomain({ models: [makeModel('dim_customer')] });
      const target = makeDomain({ models: [makeModel('dim_customer'), makeModel('fct_orders')] });

      const report = compare(source, target);

      const missing = report.models.find((m) => m.name === 'fct_orders');
      expect(missing?.status).toBe('missing');
      expect(report.summary.missingModels).toBe(1);
    });
  });

  describe('column matching', () => {
    it('reports matched columns with identical name and dataType', () => {
      const source = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id', 'INT'), makeColumn('name', 'VARCHAR')])],
      });
      const target = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id', 'INT'), makeColumn('name', 'VARCHAR')])],
      });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'dim_customer')!;
      expect(model.columns.every((c) => c.status === 'matched')).toBe(true);
      expect(report.summary.matchedColumns).toBe(2);
    });

    it('reports extra columns in source but not target', () => {
      const source = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id'), makeColumn('_loaded_at')])],
      });
      const target = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id')])],
      });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'dim_customer')!;
      const extra = model.columns.find((c) => c.name === '_loaded_at');
      expect(extra?.status).toBe('extra');
      expect(extra?.sourceDataType).toBe('VARCHAR');
      expect(report.summary.extraColumns).toBe(1);
    });

    it('reports missing columns in target but not source', () => {
      const source = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id')])],
      });
      const target = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id'), makeColumn('email')])],
      });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'dim_customer')!;
      const missing = model.columns.find((c) => c.name === 'email');
      expect(missing?.status).toBe('missing');
      expect(missing?.targetDataType).toBe('VARCHAR');
      expect(report.summary.missingColumns).toBe(1);
    });

    it('reports data type mismatches', () => {
      const source = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('email_hash', 'VARCHAR')])],
      });
      const target = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('email_hash', 'TEXT')])],
      });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'dim_customer')!;
      const mismatch = model.columns.find((c) => c.name === 'email_hash');
      expect(mismatch?.status).toBe('type-mismatch');
      expect(mismatch?.sourceDataType).toBe('VARCHAR');
      expect(mismatch?.targetDataType).toBe('TEXT');
      expect(report.summary.dataTypeMismatches).toBe(1);
    });

    it('populates columns as missing for missing models', () => {
      const source = makeDomain({ models: [] });
      const target = makeDomain({
        models: [makeModel('dim_customer', [makeColumn('id', 'INT'), makeColumn('name', 'VARCHAR')])],
      });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'dim_customer')!;
      expect(model.columns).toHaveLength(2);
      expect(model.columns[0]).toEqual({ name: 'id', status: 'missing', targetDataType: 'INT' });
      expect(model.columns[1]).toEqual({ name: 'name', status: 'missing', targetDataType: 'VARCHAR' });
      expect(report.summary.missingColumns).toBe(2);
      expect(report.summary.totalColumns).toBe(2);
    });

    it('populates columns as extra for extra models', () => {
      const source = makeDomain({
        models: [makeModel('stg_raw', [makeColumn('id', 'INT'), makeColumn('val', 'TEXT')])],
      });
      const target = makeDomain({ models: [] });

      const report = compare(source, target);
      const model = report.models.find((m) => m.name === 'stg_raw')!;
      expect(model.columns).toHaveLength(2);
      expect(model.columns[0]).toEqual({ name: 'id', status: 'extra', sourceDataType: 'INT' });
      expect(model.columns[1]).toEqual({ name: 'val', status: 'extra', sourceDataType: 'TEXT' });
      expect(report.summary.extraColumns).toBe(2);
    });
  });

  describe('relationship matching', () => {
    it('reports matched relationships with same composite key and cardinality', () => {
      const rel = makeRel(['fct_orders', 'customer_id'], ['dim_customer', 'id']);
      const source = makeDomain({ relationships: [rel] });
      const target = makeDomain({ relationships: [rel] });

      const report = compare(source, target);
      expect(report.relationships).toHaveLength(1);
      expect(report.relationships[0].status).toBe('matched');
    });

    it('reports extra relationships in source but not target', () => {
      const rel = makeRel(['fct_orders', 'customer_id'], ['dim_customer', 'id']);
      const source = makeDomain({ relationships: [rel] });
      const target = makeDomain({ relationships: [] });

      const report = compare(source, target);
      expect(report.relationships[0].status).toBe('extra');
      expect(report.relationships[0].sourceCardinality).toBe('many-to-one');
    });

    it('reports missing relationships in target but not source', () => {
      const rel = makeRel(['fct_orders', 'customer_id'], ['dim_customer', 'id']);
      const source = makeDomain({ relationships: [] });
      const target = makeDomain({ relationships: [rel] });

      const report = compare(source, target);
      expect(report.relationships[0].status).toBe('missing');
      expect(report.relationships[0].targetCardinality).toBe('many-to-one');
    });

    it('reports cardinality mismatches', () => {
      const sourceRel = makeRel(['fct_orders', 'customer_id'], ['dim_customer', 'id'], 'many-to-one');
      const targetRel = makeRel(['fct_orders', 'customer_id'], ['dim_customer', 'id'], 'one-to-one');
      const source = makeDomain({ relationships: [sourceRel] });
      const target = makeDomain({ relationships: [targetRel] });

      const report = compare(source, target);
      expect(report.relationships[0].status).toBe('cardinality-mismatch');
      expect(report.relationships[0].sourceCardinality).toBe('many-to-one');
      expect(report.relationships[0].targetCardinality).toBe('one-to-one');
    });
  });

  describe('report metadata', () => {
    it('populates domain, layer, and stage fields from source/target', () => {
      const source = makeDomain({ domain: 'orders', layer: 'silver', stage: 'physical' });
      const target = makeDomain({ domain: 'orders', layer: 'silver', stage: 'logical' });

      const report = compare(source, target);
      expect(report.domain).toBe('orders');
      expect(report.layer).toBe('silver');
      expect(report.sourceStage).toBe('physical');
      expect(report.targetStage).toBe('logical');
    });

    it('produces correct totalModels count including missing', () => {
      const source = makeDomain({ models: [makeModel('a'), makeModel('b')] });
      const target = makeDomain({ models: [makeModel('a'), makeModel('c')] });

      const report = compare(source, target);
      // a=matched, b=extra, c=missing → total=3
      expect(report.summary.totalModels).toBe(3);
    });
  });

  describe('empty domains', () => {
    it('returns empty report when both domains have no models', () => {
      const report = compare(makeDomain(), makeDomain());
      expect(report.models).toHaveLength(0);
      expect(report.relationships).toHaveLength(0);
      expect(report.summary.totalModels).toBe(0);
      expect(report.summary.totalColumns).toBe(0);
    });
  });
});
