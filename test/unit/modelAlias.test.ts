/**
 * Same table name in two layers (issue #76 follow-up): a model's NAME is its
 * identity, its `alias` is the warehouse table it builds. `silver_date` and
 * `gold_date` can both be the table `date`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DomainService } from '../../src/services/domainService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import { validateModelAliasPayload } from '../../src/providers/payloadValidation';
import {
  describeDuplicateFix,
  planDuplicateFix,
  repointDomainModel,
  suggestDuplicateName,
  type DomainReference,
} from '../../src/services/duplicateModelResolver';
import { normaliseName } from '../../src/services/nameUtils';
import type { LayerService } from '../../src/services/layerService';
import type { ManifestData, ManifestModelInfo } from '../../src/types/manifest';
import type { CatalogData, CatalogNodeInfo } from '../../src/types/catalog';
import type { YmlData } from '../../src/types/ymlData';
import type { SemanticModel, UnifiedDomain } from '../../src/types/semantic';

const EMPTY_YML: YmlData = {
  models: new Map(),
  relationshipTests: [],
  uniqueColumns: new Map(),
  compositeUniqueGroups: new Map(),
};

function manifestModel(name: string, schema: string, alias?: string, columns = ['date_key']): ManifestModelInfo {
  return {
    name,
    uniqueId: `model.proj.${name}`,
    projectName: 'proj',
    schema,
    ...(alias ? { alias } : {}),
    description: `${name} from dbt`,
    columns: columns.map((c) => ({ name: c, data_type: 'int', description: '' })),
  };
}

function manifest(models: ManifestModelInfo[], tests: ManifestData['relationshipTests'] = []): ManifestData {
  return {
    models: new Map(models.map((m) => [m.name, m])),
    relationshipTests: tests,
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
    disabledModels: new Set(),
  };
}

function domain(models: SemanticModel[], layer = 'gold'): UnifiedDomain {
  return {
    schemaVersion: 5,
    domain: 'finance',
    layer,
    description: '',
    logical: { models, relationships: [] },
    viewConfig: {},
  };
}

const service = new DomainService({} as LayerService);

describe('physical stage: matching by warehouse relation', () => {
  it('matches by model name first — the alias never overrides the identity', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'date' }]),
      EMPTY_YML,
      manifest([manifestModel('gold_date', 'gold', 'date', ['date_key', 'fiscal_year'])]),
    );
    const m = result.models[0];
    expect(m.existsInProject).toBe(true);
    expect(m.columns.map((c) => c.name)).toEqual(['date_key', 'fiscal_year']);
    expect(m.alias).toBe('date');
  });

  it('falls back to (schema, alias) when the dbt model has another name', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'date' }]),
      EMPTY_YML,
      // dbt calls it dim_date, built as gold.date
      manifest([manifestModel('dim_date', 'gold', 'date', ['date_key', 'fiscal_year'])]),
    );
    const m = result.models[0];
    expect(m.name).toBe('gold_date'); // the logical identity is kept for positions and diffs
    expect(m.existsInProject).toBe(true);
    expect(m.columns.map((c) => c.name)).toEqual(['date_key', 'fiscal_year']);
  });

  it('never matches on the alias alone: silver.date is not gold.date', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'date' }]),
      EMPTY_YML,
      manifest([manifestModel('silver_date', 'silver', 'date')]),
    );
    expect(result.models[0].existsInProject).toBe(false);
  });

  it('does not use the relation route for a model with no schema', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', alias: 'date' }]),
      EMPTY_YML,
      manifest([manifestModel('dim_date', 'gold', 'date')]),
    );
    expect(result.models[0].existsInProject).toBe(false);
  });

  it('treats a relation two dbt models share as ambiguous, not a guess', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'date' }]),
      EMPTY_YML,
      manifest([manifestModel('dim_date_a', 'gold', 'date'), manifestModel('dim_date_b', 'GOLD', 'DATE')]),
    );
    expect(result.models[0].existsInProject).toBe(false);
  });

  it('matches the relation case-insensitively', () => {
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'Date' }]),
      EMPTY_YML,
      manifest([manifestModel('dim_date', 'GOLD', 'DATE')]),
    );
    expect(result.models[0].existsInProject).toBe(true);
  });

  it('draws relationship tests for a relation-matched model on its logical node', () => {
    const result = service.buildPhysicalDomain(
      domain([
        { name: 'gold_date', schema: 'gold', alias: 'date' },
        { name: 'fct_sale', schema: 'gold' },
      ]),
      EMPTY_YML,
      manifest(
        [manifestModel('dim_date', 'gold', 'date'), manifestModel('fct_sale', 'gold', undefined, ['sale_id', 'date_key'])],
        [{ fromModel: 'fct_sale', fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key' }],
      ),
    );
    expect(result.relationships).toEqual([
      expect.objectContaining({ fromModel: 'fct_sale', toModel: 'gold_date', toColumn: 'date_key' }),
    ]);
  });

  it('shows the alias dbt builds under, falling back to the design', () => {
    const result = service.buildPhysicalDomain(
      domain([
        { name: 'gold_date', schema: 'gold', alias: 'date' },
        { name: 'gold_calendar', schema: 'gold', alias: 'calendar' },
      ]),
      EMPTY_YML,
      manifest([manifestModel('gold_date', 'gold', 'dim_date'), manifestModel('gold_calendar', 'gold')]),
    );
    expect(result.models.find((m) => m.name === 'gold_date')!.alias).toBe('dim_date');
    expect(result.models.find((m) => m.name === 'gold_calendar')!.alias).toBe('calendar');
  });

  it('finds a catalog relation by (schema, relation) when there is no manifest', () => {
    const node: CatalogNodeInfo = {
      uniqueId: 'model.proj.dim_date',
      resourceType: 'model',
      name: 'dim_date',
      relationName: 'DATE',
      schema: 'GOLD',
      database: 'PROD',
      comment: null,
      columns: [{ name: 'DATE_KEY', index: 0, dataType: 'NUMBER', comment: null }],
    };
    const catalog: CatalogData = {
      byUniqueId: new Map([[node.uniqueId, node]]),
      byName: new Map([[normaliseName(node.name), node]]),
      generatedAt: null,
      partial: false,
    };
    const result = service.buildPhysicalDomain(
      domain([{ name: 'gold_date', schema: 'gold', alias: 'date' }]),
      EMPTY_YML,
      undefined,
      catalog,
    );
    expect(result.models[0].existsInProject).toBe(true);
    expect(result.models[0].columns.map((c) => c.dataType)).toEqual(['NUMBER']);
  });
});

describe('manifest extraction: alias', () => {
  const node = (extra: Record<string, unknown>) => ({
    unique_id: 'model.proj.gold_date',
    name: 'gold_date',
    schema: 'gold',
    columns: {},
    ...extra,
  });

  it('records an alias that differs from the model name', () => {
    const r = extractManifestData({ nodes: { 'model.proj.gold_date': node({ alias: 'date' }) } });
    expect(r.models.gold_date.alias).toBe('date');
  });

  it('leaves out the alias dbt fills in by default (the name itself)', () => {
    const r = extractManifestData({ nodes: { 'model.proj.gold_date': node({ alias: 'gold_date' }) } });
    expect(r.models.gold_date).not.toHaveProperty('alias');
  });

  it("leaves out a versioned model's default <name>_v<N> alias", () => {
    const r = extractManifestData({
      nodes: { 'model.proj.gold_date.v2': node({ unique_id: 'model.proj.gold_date.v2', version: 2, alias: 'gold_date_v2' }) },
    });
    expect(r.models.gold_date).not.toHaveProperty('alias');
  });
});

describe('LogicalModelService: alias in the model file', () => {
  let dir: string;
  let lms: LogicalModelService;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-alias-'));
    lms = new LogicalModelService(dir);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips alias right after schema', () => {
    lms.saveModel({ name: 'gold_date', schema: 'gold', alias: 'date', description: 'Dates' }, 'gold');
    const text = fs.readFileSync(path.join(lms.getModelsDir(), 'gold', 'gold_date.yml'), 'utf-8');
    expect(text).toBe('name: gold_date\nschema: gold\nalias: date\ndescription: Dates\n');
    expect(lms.getModel('gold_date')!.alias).toBe('date');
  });

  it('removes the key when the alias is cleared, keeping hand-written comments', () => {
    const file = path.join(lms.getModelsDir(), 'gold_date.yml');
    fs.mkdirSync(lms.getModelsDir(), { recursive: true });
    fs.writeFileSync(file, '# the gold calendar\nname: gold_date\nalias: date # table name\n');
    const model = lms.getModel('gold_date')!;
    delete model.alias;
    lms.saveModel(model);
    expect(fs.readFileSync(file, 'utf-8')).toBe('# the gold calendar\nname: gold_date\n');
  });

  it('serializeModelAt edits the file at the given path, not the one the name resolves to', () => {
    const models = lms.getModelsDir();
    fs.mkdirSync(path.join(models, 'silver'), { recursive: true });
    fs.mkdirSync(path.join(models, 'gold'), { recursive: true });
    fs.writeFileSync(path.join(models, 'silver', 'date.yml'), 'name: date\n');
    fs.writeFileSync(path.join(models, 'gold', 'date.yml'), '# gold copy\nname: date\nowner: finance\n');
    const text = lms.serializeModelAt({ name: 'gold_date', alias: 'date' }, path.join(models, 'gold', 'date.yml'));
    expect(text).toBe('# gold copy\nname: gold_date\nowner: finance\nalias: date\n');
  });
});

describe('validateModelAliasPayload', () => {
  it('accepts an identifier, keeping its case', () => {
    expect(validateModelAliasPayload({ modelName: 'gold_date', alias: 'Date' })).toBeNull();
    expect(validateModelAliasPayload({ modelName: 'gold_date', alias: '_date_2' })).toBeNull();
  });

  it('accepts an empty alias, which clears it', () => {
    expect(validateModelAliasPayload({ modelName: 'gold_date', alias: '  ' })).toBeNull();
  });

  it('rejects what is not a plain table name', () => {
    for (const alias of ['gold.date', 'my date', '2date', 'date;drop', 'a'.repeat(129)]) {
      expect(validateModelAliasPayload({ modelName: 'gold_date', alias })).not.toBeNull();
    }
    expect(validateModelAliasPayload({ modelName: 'gold_date', alias: 7 })).not.toBeNull();
    expect(validateModelAliasPayload({ modelName: '../x', alias: 'date' })).not.toBeNull();
    expect(validateModelAliasPayload(null)).not.toBeNull();
  });
});

describe('duplicate model files', () => {
  const refs: DomainReference[] = [
    { filePath: '/p/.erd-studio/silver/core.json', domain: 'core', layer: 'silver' },
    { filePath: '/p/.erd-studio/gold/finance.json', domain: 'finance', layer: 'gold' },
    { filePath: '/p/.erd-studio/gold/sales.json', domain: 'sales', layer: 'gold' },
  ];

  it('suggests {layer}_{name}, skipping names that are taken', () => {
    expect(suggestDuplicateName('date', 'gold', new Set(['date']))).toBe('gold_date');
    expect(suggestDuplicateName('date', 'gold', new Set(['gold_date']))).toBe('gold_date_2');
    expect(suggestDuplicateName('date', 'my-layer', new Set())).toBe('my_layer_date');
    expect(suggestDuplicateName('date', 'Gold', new Set())).toBe('gold_date');
  });

  it("repoints the domains of the copy's layer and keeps the rest", () => {
    const plan = planDuplicateFix('date', 'gold', 'gold_date', undefined, refs);
    expect(plan.alias).toBe('date');
    expect(plan.repoint.map((r) => r.domain)).toEqual(['finance', 'sales']);
    expect(plan.keep.map((r) => r.domain)).toEqual(['core']);
    const text = describeDuplicateFix(plan, 'logical-models/gold/date.yml', 'logical-models/gold/gold_date.yml');
    expect(text).toContain('alias: date');
    expect(text).toContain('gold/finance');
    expect(text).toContain('Still using "date"');
  });

  it("keeps an alias the copy already has, and repoints nothing for a top-level copy", () => {
    const plan = planDuplicateFix('date', '', 'date_copy', 'calendar', refs);
    expect(plan.alias).toBe('calendar');
    expect(plan.repoint).toEqual([]);
  });

  it('repoints every reference in a v5 domain document', () => {
    const doc: Record<string, unknown> = {
      schemaVersion: 5,
      logical: {
        models: ['fct_sale', 'date'],
        relationships: [{ fromModel: 'fct_sale', fromColumn: 'date_key', toModel: 'date', toColumn: 'date_key' }],
      },
      viewConfig: {
        positions: { date: { x: 1, y: 2 }, fct_sale: { x: 3, y: 4 } },
        annotations: [{ id: 'n1', text: 'calendar', x: 0, y: 0, linkedModel: 'date' }],
      },
      stubColumns: ['date'],
    };
    expect(repointDomainModel(doc, 'date', 'gold_date')).toBe(true);
    expect(doc).toEqual({
      schemaVersion: 5,
      logical: {
        models: ['fct_sale', 'gold_date'],
        relationships: [{ fromModel: 'fct_sale', fromColumn: 'date_key', toModel: 'gold_date', toColumn: 'date_key' }],
      },
      viewConfig: {
        positions: { gold_date: { x: 1, y: 2 }, fct_sale: { x: 3, y: 4 } },
        annotations: [{ id: 'n1', text: 'calendar', x: 0, y: 0, linkedModel: 'gold_date' }],
      },
      stubColumns: ['gold_date'],
    });
  });

  it('leaves a domain that does not use the name, or has inline (v4) models, alone', () => {
    const other = { logical: { models: ['fct_sale'], relationships: [] } };
    expect(repointDomainModel(other, 'date', 'gold_date')).toBe(false);
    const v4 = { logical: { models: [{ name: 'date' }], relationships: [] } };
    expect(repointDomainModel(v4, 'date', 'gold_date')).toBe(false);
    expect(v4.logical.models).toEqual([{ name: 'date' }]);
  });
});
