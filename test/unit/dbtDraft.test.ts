import * as path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  DRAFT_MODEL_LIMIT,
  buildDbtDraft,
  buildDraftDomainDocument,
  dbtTestsOf,
  folderRank,
  listDraftModels,
  listDraftScopes,
  markDraftKeys,
  relationshipsForAddedModels,
  seedModelFromDbt,
  serializeDraftDomainDocument,
  suggestDomainName,
  suggestDraftLayer,
  toDomainSlug,
  type DraftScope,
} from '../../src/services/dbtDraft';
import { CHOOSE_MODELS_LABEL, pickDraftScope } from '../../src/providers/dbtDraftPicker';
import { YmlParserService } from '../../src/services/ymlParserService';
import { ManifestService } from '../../src/services/manifestService';
import { CatalogService } from '../../src/services/catalogService';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { normaliseName } from '../../src/services/nameUtils';
import { detectDomainFormat } from '../../src/types/semantic';
import { isFreshLayout } from '../../src/providers/SemanticEditorProvider';
import type { YmlData, YmlModelInfo } from '../../src/types/ymlData';
import type { ManifestData, ManifestModelInfo } from '../../src/types/manifest';
import type { CatalogData, CatalogNodeInfo } from '../../src/types/catalog';
import type { UnifiedDomain } from '../../src/types/semantic';

const ROOT = path.resolve(__dirname, '../fixtures/dbt-project');

// ---------------------------------------------------------------------------
// Hand-made fixtures
// ---------------------------------------------------------------------------

function ymlModel(name: string, folder: string, columns: Array<[string, string | null]>, description = ''): YmlModelInfo {
  return {
    name,
    description,
    columns: columns.map(([n, t]) => ({ name: n, dataType: t, description: '' })),
    filePath: path.join('/proj', 'models', folder, `${name}.yml`),
    tags: [],
  };
}

function manifestModel(name: string, file: string, columns: Array<[string, string | null]> = []): ManifestModelInfo {
  return {
    name,
    uniqueId: `model.p.${name}`,
    projectName: 'p',
    schema: 'analytics',
    description: `${name} from manifest`,
    columns: columns.map(([n, t]) => ({ name: n, data_type: t, description: `${n} doc` })),
    originalFilePath: file,
  };
}

function emptyYml(): YmlData {
  return { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() };
}

function emptyManifest(): ManifestData {
  return {
    models: new Map(),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
    disabledModels: new Set(),
  };
}

/** marts/ (fct_orders, dim_customers, dim_products), staging/ (stg_*), intermediate/ (int_orders). */
function shopYml(): YmlData {
  const y = emptyYml();
  const add = (m: YmlModelInfo) => y.models.set(m.name, m);
  add(ymlModel('fct_orders', 'marts', [['order_id', 'int'], ['customer_id', null], ['product_id', 'int'], ['amount', 'decimal']]));
  add(ymlModel('dim_customers', 'marts', [['customer_id', 'int'], ['name', 'varchar']]));
  add(ymlModel('dim_products', 'marts', [['product_id', 'int']]));
  add(ymlModel('stg_orders', 'staging', [['order_id', 'int']]));
  add(ymlModel('stg_customers', 'staging', [['customer_id', 'int']]));
  add(ymlModel('int_orders', 'intermediate', [['order_id', 'int']]));
  y.relationshipTests = [
    { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customers', toColumn: 'customer_id' },
    { fromModel: 'fct_orders', fromColumn: 'product_id', toModel: 'dim_products', toColumn: 'product_id' },
  ];
  y.uniqueColumns = new Map([
    ['dim_customers', new Set(['customer_id'])],
    ['dim_products', new Set(['product_id'])],
    ['fct_orders', new Set(['order_id'])],
  ]);
  return y;
}

const shopInput = (over: Partial<Parameters<typeof listDraftScopes>[0]> = {}) => ({
  ymlData: shopYml(),
  projectRoot: '/proj',
  modelPaths: ['models'],
  ...over,
});

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

describe('listDraftScopes', () => {
  it('offers one scope per folder, presentation folders first, staging last', () => {
    const scopes = listDraftScopes(shopInput({ includeClusters: false }));
    expect(scopes.map((s) => s.id)).toEqual(['folder:marts', 'folder:intermediate', 'folder:staging']);
    const marts = scopes[0];
    expect(marts.count).toBe(3);
    expect(marts.description).toBe('3 models');
    // Most connected first: the fact joins both dimensions.
    expect(marts.modelNames[0]).toBe('fct_orders');
    expect(marts.suggestedLayer).toBe('gold');
    expect(scopes[2].suggestedLayer).toBe('silver');
  });

  it('adds relationship clusters that are not already a folder', () => {
    const y = shopYml();
    y.relationshipTests.push({ fromModel: 'stg_orders', fromColumn: 'customer_id', toModel: 'stg_customers', toColumn: 'customer_id' });
    y.relationshipTests.push({ fromModel: 'int_orders', fromColumn: 'order_id', toModel: 'stg_orders', toColumn: 'order_id' });
    const scopes = listDraftScopes(shopInput({ ymlData: y }));
    const clusters = scopes.filter((s) => s.kind === 'cluster');
    // marts cluster equals the marts folder, so only the staging+intermediate one is added.
    expect(clusters).toHaveLength(1);
    expect(clusters[0].modelNames.sort()).toEqual(['int_orders', 'stg_customers', 'stg_orders']);
    expect(clusters[0].label).toContain('stg_orders');
  });

  it('excludes disabled models and works from the manifest alone', () => {
    const m = emptyManifest();
    m.models.set('fct_a', manifestModel('fct_a', 'models/marts/finance/fct_a.sql', [['id', 'int']]));
    m.models.set('dim_b', manifestModel('dim_b', 'models/marts/finance/dim_b.sql', [['id', 'int']]));
    m.models.set('stg_c', manifestModel('stg_c', 'models/staging/stg_c.sql', [['id', 'int']]));
    m.disabledModels = new Set(['dim_b']);
    const scopes = listDraftScopes({ manifest: m, projectRoot: '/proj', modelPaths: ['models'] });
    expect(scopes.map((s) => [s.id, s.modelNames])).toEqual([
      ['folder:marts/finance', ['fct_a']],
      ['folder:staging', ['stg_c']],
    ]);
  });

  it('only suggests configured layers when layerIds is given', () => {
    const scopes = listDraftScopes(shopInput({ includeClusters: false, layerIds: ['silver'] }));
    expect(scopes[0].suggestedLayer).toBeUndefined();
    expect(scopes[2].suggestedLayer).toBe('silver');
  });

  it('reads the fixture project (yml + manifest)', async () => {
    const ymlData = await new YmlParserService().loadYmlData(ROOT);
    const manifest = await new ManifestService({ parseInProcess: true }).loadManifest(ROOT);
    const scopes = listDraftScopes({ ymlData, manifest, projectRoot: ROOT, modelPaths: ['models'], includeClusters: false });
    expect(scopes.map((s) => s.id)).toEqual(['folder:gold', 'folder:silver', 'folder:staging']);
    // dim_region has only a .sql file — nothing to copy — so it is not offered.
    expect(scopes.flatMap((s) => s.modelNames)).not.toContain('dim_region');
    expect(scopes.find((s) => s.id === 'folder:staging')!.modelNames).toEqual(['stg_raw_payments']);
  });
});

describe('listDraftModels / folderRank / suggestDraftLayer', () => {
  it('lists yml and manifest models once each, yml spelling first', () => {
    const m = emptyManifest();
    m.models.set('FCT_ORDERS', manifestModel('FCT_ORDERS', 'models/marts/fct_orders.sql'));
    const models = listDraftModels({ ...shopInput(), manifest: m });
    expect(models.filter((e) => e.name.toLowerCase() === 'fct_orders').map((e) => e.name)).toEqual(['fct_orders']);
    expect(models[0].folder).toBe('marts');
  });

  it('leaves out a manifest model with no columns (a .sql file dbt parsed, no schema yml)', () => {
    const m = emptyManifest();
    m.models.set('dim_bare', manifestModel('dim_bare', 'models/marts/dim_bare.sql'));
    m.models.set('dim_documented', manifestModel('dim_documented', 'models/marts/dim_documented.sql', [['id', 'int']]));
    const names = listDraftModels({ ...shopInput(), manifest: m }).map((e) => e.name);
    expect(names).not.toContain('dim_bare');
    expect(names).toContain('dim_documented');
  });

  it('leaves out models from installed dbt packages, even when their folder matches one of the project\'s', () => {
    const m = emptyManifest();
    const own = manifestModel('fct_orders', 'models/marts/fct_orders.sql', [['order_id', 'int']]);
    const pkg: ManifestModelInfo = {
      ...manifestModel('fct_direct_join_to_source', 'models/marts/fct_direct_join_to_source.sql', [['id', 'int']]),
      uniqueId: 'model.dbt_project_evaluator.fct_direct_join_to_source',
      projectName: 'dbt_project_evaluator',
    };
    m.models.set(own.name, own);
    m.models.set(pkg.name, pkg);
    const names = listDraftModels({ ...shopInput(), manifest: m }).map((e) => e.name);
    expect(names).toContain('fct_orders');
    expect(names).not.toContain('fct_direct_join_to_source');
    // With no yml data nothing can be told apart, so every manifest model is kept.
    expect(listDraftModels({ ...shopInput(), ymlData: undefined, manifest: m }).map((e) => e.name))
      .toEqual(expect.arrayContaining(['fct_orders', 'fct_direct_join_to_source']));
  });

  it('ranks folders', () => {
    expect(folderRank('marts/finance')).toBe(0);
    expect(folderRank('intermediate')).toBe(1);
    expect(folderRank('misc')).toBe(2);
    expect(folderRank('staging/sap')).toBe(3);
  });

  it('suggests a layer', () => {
    expect(suggestDraftLayer('marts/finance')).toBe('gold');
    expect(suggestDraftLayer('domain/silver/x')).toBe('silver');
    expect(suggestDraftLayer('staging')).toBe('silver');
    expect(suggestDraftLayer('misc')).toBeUndefined();
    expect(suggestDraftLayer('reporting', ['reporting'])).toBe('reporting');
  });
});

// ---------------------------------------------------------------------------
// Seeding and relationships
// ---------------------------------------------------------------------------

describe('seedModelFromDbt', () => {
  it('copies the yml and fills gaps from the manifest', () => {
    const m = emptyManifest();
    m.models.set('fct_orders', manifestModel('fct_orders', 'models/marts/fct_orders.sql', [['customer_id', 'bigint']]));
    const model = seedModelFromDbt('fct_orders', shopYml(), m)!;
    expect(model.schema).toBe('analytics');
    expect(model.columns!.find((c) => c.name === 'customer_id')).toEqual({ name: 'customer_id', dataType: 'bigint', description: 'customer_id doc' });
    expect(model.columns!.find((c) => c.name === 'amount')!.dataType).toBe('decimal');
  });

  it('falls back to the manifest and returns undefined when neither has it', () => {
    const m = emptyManifest();
    m.models.set('x', manifestModel('x', 'models/x.sql', [['id', null]]));
    // No source has a type: empty, never an invented 'unknown'.
    expect(seedModelFromDbt('x', undefined, m)!.columns).toEqual([{ name: 'id', dataType: '', description: 'id doc' }]);
    expect(seedModelFromDbt('nope', shopYml(), m)).toBeUndefined();
  });
});

describe('seedModelFromDbt — column types from catalog.json', () => {
  function catalogOf(nodes: Array<Pick<CatalogNodeInfo, 'uniqueId' | 'name' | 'columns'>>): CatalogData {
    const full: CatalogNodeInfo[] = nodes.map((n) => ({
      ...n, resourceType: 'model', relationName: n.name.toUpperCase(), schema: 'ANALYTICS', database: 'PROD', comment: null,
    }));
    return {
      byUniqueId: new Map(full.map((n) => [n.uniqueId, n])),
      byName: new Map(full.map((n) => [normaliseName(n.name), n])),
      generatedAt: '2026-09-01T00:00:00Z',
      partial: false,
    };
  }
  const col = (name: string, index: number, dataType: string | null) => ({ name, index, dataType, comment: null });

  // The erd-studio-sample shape: the yml lists columns with no data_type, so the
  // manifest (a compiled copy of it) has none either; only the catalog does.
  function untypedProject() {
    const y = emptyYml();
    y.models.set('fct_orders', ymlModel('fct_orders', 'marts', [['order_id', null], ['customer_id', null], ['note', null]]));
    const m = emptyManifest();
    m.models.set('fct_orders', manifestModel('fct_orders', 'models/marts/fct_orders.sql', [['order_id', null], ['customer_id', null], ['note', null]]));
    const c = catalogOf([{
      uniqueId: 'model.p.fct_orders', name: 'fct_orders',
      // Warehouse order and UPPERCASE spelling, plus a column dbt never declared.
      columns: [col('CUSTOMER_ID', 0, 'NUMBER(38,0)'), col('ORDER_ID', 1, 'NUMBER(38,0)'), col('LOADED_AT', 2, 'TIMESTAMP_NTZ'), col('NOTE', 3, null)],
    }]);
    return { y, m, c };
  }

  it('fills types from the catalog, keeping the declared names and order and adding no column', () => {
    const { y, m, c } = untypedProject();
    expect(seedModelFromDbt('fct_orders', y, m, c)!.columns!.map((x) => [x.name, x.dataType])).toEqual([
      ['order_id', 'NUMBER(38,0)'],
      ['customer_id', 'NUMBER(38,0)'],
      ['note', ''],
    ]);
  });

  it('leaves types empty without a catalog — the gap this closes', () => {
    const { y, m } = untypedProject();
    expect(seedModelFromDbt('fct_orders', y, m)!.columns!.map((x) => x.dataType)).toEqual(['', '', '']);
  });

  it('resolves catalog, then yml data_type, then manifest — as the physical stage does', () => {
    const y = emptyYml();
    y.models.set('dim_x', ymlModel('dim_x', 'marts', [['a', 'int'], ['b', 'int'], ['c', null]]));
    const m = emptyManifest();
    m.models.set('dim_x', manifestModel('dim_x', 'models/marts/dim_x.sql', [['a', 'm_a'], ['b', 'm_b'], ['c', 'bigint']]));
    const c = catalogOf([{ uniqueId: 'model.p.dim_x', name: 'dim_x', columns: [col('A', 0, 'NUMBER')] }]);
    expect(seedModelFromDbt('dim_x', y, m, c)!.columns!.map((x) => x.dataType)).toEqual(['NUMBER', 'int', 'bigint']);
  });

  it('joins the catalog by manifest unique_id first, by name without a manifest', () => {
    const y = emptyYml();
    y.models.set('orders', ymlModel('orders', 'marts', [['id', null]]));
    const m = emptyManifest();
    m.models.set('orders', { ...manifestModel('orders', 'models/marts/orders.sql', [['id', null]]), uniqueId: 'model.p.orders.v2' });
    const c = catalogOf([
      { uniqueId: 'model.p.orders.v2', name: 'orders', columns: [col('ID', 0, 'v2type')] },
      { uniqueId: 'model.p.orders.v1', name: 'orders', columns: [col('ID', 0, 'v1type')] },
    ]);
    expect(seedModelFromDbt('orders', y, m, c)!.columns![0].dataType).toBe('v2type');
    expect(seedModelFromDbt('orders', y, undefined, c)!.columns![0].dataType).toBe('v1type');
  });

  it('buildDbtDraft passes the catalog to its default seeding', () => {
    const { y, m, c } = untypedProject();
    const draft = buildDbtDraft({ modelNames: ['fct_orders'], ymlData: y, manifest: m, catalog: c, libraryHas: () => false });
    expect(draft.newModels[0].columns!.map((x) => x.dataType)).toEqual(['NUMBER(38,0)', 'NUMBER(38,0)', '']);
  });

  it('seeds the fixture project with the same types the physical stage shows', async () => {
    const ymlData = await new YmlParserService().loadYmlData(ROOT);
    const manifest = await new ManifestService({ parseInProcess: true }).loadManifest(ROOT);
    const catalog = await new CatalogService().loadCatalog(ROOT);
    expect(catalog).toBeDefined();
    // fct_task_event's yml declares no data_type; the catalog has the warehouse types.
    const seeded = seedModelFromDbt('fct_task_event', ymlData, manifest, catalog)!;
    expect(seeded.columns!.map((x) => [x.name, x.dataType])).toEqual([
      ['event_id', 'integer'],
      ['task_key', 'integer'],
      ['event_date', 'timestamp without time zone'],
      ['amount', 'numeric(15,2)'],
    ]);

    // One rule: the physical stage resolves every column of every drawable model identically.
    const names = listDraftModels({ ymlData, manifest, projectRoot: ROOT, modelPaths: ['models'] }).map((e) => e.name);
    const models = names.map((n) => seedModelFromDbt(n, ymlData, manifest, catalog)!);
    const unified: UnifiedDomain = {
      schemaVersion: 4, domain: 'parity', layer: 'silver', description: '',
      logical: { models, relationships: [] }, viewConfig: {},
    };
    const physical = new DomainService(new LayerService(ROOT)).buildPhysicalDomain(unified, ymlData, manifest, catalog);
    for (const model of models) {
      const shown = physical.models.find((pm) => pm.name === model.name)!;
      const shownTypes = new Map(shown.columns.map((pc) => [normaliseName(pc.name), pc.dataType]));
      for (const column of model.columns ?? []) {
        expect([model.name, column.name, column.dataType]).toEqual([model.name, column.name, shownTypes.get(normaliseName(column.name))]);
      }
    }
  });
});

describe('relationshipsForAddedModels', () => {
  const tests = dbtTestsOf(shopYml());

  it('keeps only edges touching an added model whose other end is in the domain', () => {
    const rels = relationshipsForAddedModels(['dim_customers'], ['fct_orders'], tests.relationshipTests, tests.unique);
    expect(rels).toEqual([
      { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
  });

  it('is one-to-one only when both ends are unique', () => {
    const y = shopYml();
    y.relationshipTests = [{ fromModel: 'fct_orders', fromColumn: 'order_id', toModel: 'dim_customers', toColumn: 'customer_id' }];
    const t = dbtTestsOf(y);
    expect(relationshipsForAddedModels([], ['fct_orders', 'dim_customers'], t.relationshipTests, t.unique)[0].cardinality).toBe('one-to-one');
    // Neither side unique is still many-to-one: the test names the "one" side.
    y.uniqueColumns = new Map();
    const t2 = dbtTestsOf(y);
    expect(relationshipsForAddedModels([], ['fct_orders', 'dim_customers'], t2.relationshipTests, t2.unique)[0].cardinality).toBe('many-to-one');
  });

  it('skips relationships the domain already has and dedupes yml + manifest', () => {
    const m = emptyManifest();
    m.relationshipTests = [{ fromModel: 'FCT_ORDERS', fromColumn: 'CUSTOMER_ID', toModel: 'dim_customers', toColumn: 'customer_id' }];
    const t = dbtTestsOf(shopYml(), m);
    expect(t.relationshipTests).toHaveLength(2);
    const rels = relationshipsForAddedModels(
      ['dim_customers', 'dim_products'], ['fct_orders'], t.relationshipTests, t.unique,
      [{ fromModel: 'fct_orders', fromColumn: 'product_id', toModel: 'dim_products', toColumn: 'product_id' }],
    );
    expect(rels.map((r) => r.toModel)).toEqual(['dim_customers']);
  });
});

describe('markDraftKeys', () => {
  it('marks a sole unique column as PK and relationship sources as FK', () => {
    const model = seedModelFromDbt('fct_orders', shopYml())!;
    const t = dbtTestsOf(shopYml());
    const marked = markDraftKeys(model, t.unique, [
      { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
    const col = (n: string) => marked.columns!.find((c) => c.name === n)!;
    expect(col('order_id').isPrimaryKey).toBe(true);
    expect(col('customer_id').isForeignKey).toBe(true);
    expect(col('amount').isPrimaryKey).toBeUndefined();
  });

  it('marks no PK when a composite key exists', () => {
    const y = shopYml();
    y.compositeUniqueGroups = new Map([['fct_orders', [['order_id', 'product_id']]]]);
    const marked = markDraftKeys(seedModelFromDbt('fct_orders', y)!, dbtTestsOf(y).unique, []);
    expect(marked.columns!.some((c) => c.isPrimaryKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildDbtDraft
// ---------------------------------------------------------------------------

describe('buildDbtDraft', () => {
  it('stores a test declared on the dimension on the fact, with no FK flag on the key (#133)', () => {
    const y = shopYml();
    y.relationshipTests = [{ fromModel: 'dim_customers', fromColumn: 'customer_id', toModel: 'fct_orders', toColumn: 'customer_id' }];
    const draft = buildDbtDraft({ modelNames: ['fct_orders', 'dim_customers'], ymlData: y, libraryHas: () => false });
    expect(draft.relationships).toEqual([
      { fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customers', toColumn: 'customer_id', cardinality: 'many-to-one' },
    ]);
    const key = (m: string) => draft.newModels.find((x) => x.name === m)!.columns!.find((c) => c.name === 'customer_id')!;
    expect([key('dim_customers').isPrimaryKey, key('dim_customers').isForeignKey, key('fct_orders').isForeignKey]).toEqual([true, undefined, true]);
  });

  it('draws a self-referencing relationships test, keys flagged (#133 L3)', () => {
    const y = emptyYml();
    y.models.set('employee', ymlModel('employee', 'marts', [['employee_id', 'int'], ['manager_id', 'int']]));
    y.relationshipTests = [{ fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id' }];
    y.uniqueColumns = new Map([['employee', new Set(['employee_id'])]]);
    const draft = buildDbtDraft({ modelNames: ['employee'], ymlData: y, libraryHas: () => false });
    expect(draft.relationships).toEqual([
      { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' },
    ]);
    const cols = draft.newModels[0].columns!;
    expect(cols.map((c) => [c.name, !!c.isPrimaryKey, !!c.isForeignKey])).toEqual([['employee_id', true, false], ['manager_id', false, true]]);
  });

  it('creates new models, reuses library ones and joins them', () => {
    const draft = buildDbtDraft({
      modelNames: ['fct_orders', 'dim_customers', 'dim_products'],
      ymlData: shopYml(),
      libraryHas: (n) => n === 'dim_products',
    });
    expect(draft.modelNames).toEqual(['fct_orders', 'dim_customers', 'dim_products']);
    expect(draft.newModels.map((m) => m.name)).toEqual(['fct_orders', 'dim_customers']);
    expect(draft.reusedModels).toEqual(['dim_products']);
    expect(draft.relationships).toHaveLength(2);
    expect(draft.truncated).toBe(false);
    expect(draft.skipped).toEqual([]);
    expect(draft.newModels[0].columns!.find((c) => c.name === 'product_id')!.isForeignKey).toBe(true);
  });

  it('skips unsafe, unknown, duplicate, disabled and already-present names with reasons', () => {
    const m = emptyManifest();
    m.models.set('dim_gone', manifestModel('dim_gone', 'models/x/dim_gone.sql'));
    m.disabledModels = new Set(['dim_gone']);
    const draft = buildDbtDraft({
      modelNames: ['../evil', 'nope', 'fct_orders', 'FCT_ORDERS', 'dim_gone', 'dim_customers'],
      ymlData: shopYml(),
      manifest: m,
      libraryHas: () => false,
      existingModelNames: ['dim_customers'],
    });
    expect(draft.modelNames).toEqual(['fct_orders']);
    expect(draft.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['../evil', 'invalid-name'],
      ['nope', 'not-found'],
      ['FCT_ORDERS', 'duplicate'],
      ['dim_gone', 'disabled'],
      ['dim_customers', 'already-in-domain'],
    ]);
    expect(draft.skipped[0].message).toMatch(/path separators/);
    // The edge to the model already in the domain is still drawn.
    expect(draft.relationships.map((r) => r.toModel)).toEqual(['dim_customers']);
  });

  it('truncates to the limit in the order given', () => {
    const y = emptyYml();
    const names = Array.from({ length: DRAFT_MODEL_LIMIT + 3 }, (_, i) => `m_${String(i).padStart(2, '0')}`);
    for (const n of names) { y.models.set(n, ymlModel(n, 'marts', [['id', 'int']])); }
    const draft = buildDbtDraft({ modelNames: names, ymlData: y, libraryHas: () => false });
    expect(DRAFT_MODEL_LIMIT).toBe(15);
    expect(draft.modelNames).toEqual(names.slice(0, DRAFT_MODEL_LIMIT));
    expect(draft.truncated).toBe(true);
    expect(draft.skipped.filter((s) => s.reason === 'over-limit').map((s) => s.name)).toEqual(names.slice(DRAFT_MODEL_LIMIT));
  });

  it('uses a caller-supplied seed', () => {
    const draft = buildDbtDraft({
      modelNames: ['anything'],
      libraryHas: () => false,
      seed: (name) => ({ name, columns: [] }),
    });
    expect(draft.newModels).toEqual([{ name: 'anything', columns: [] }]);
  });
});

// ---------------------------------------------------------------------------
// Domain document and names
// ---------------------------------------------------------------------------

describe('buildDraftDomainDocument', () => {
  it('writes a v5 domain with an empty viewConfig, so the canvas auto-lays it out', () => {
    const doc = buildDraftDomainDocument({
      domain: 'marts',
      layer: 'gold',
      description: ' From dbt ',
      modelNames: ['fct_orders', 'dim_customers'],
      relationships: [{ fromModel: 'fct_orders', fromColumn: 'customer_id', toModel: 'dim_customers', toColumn: 'customer_id', cardinality: 'many-to-one' }],
    });
    expect(Object.keys(doc)).toEqual(['schemaVersion', 'domain', 'layer', 'description', 'logical', 'viewConfig']);
    expect(doc.description).toBe('From dbt');
    const text = serializeDraftDomainDocument(doc);
    expect(text.endsWith('}\n')).toBe(true);
    const parsed = JSON.parse(text);
    expect(detectDomainFormat(parsed)).toBe('v5');
    expect(isFreshLayout({ logical: { models: parsed.logical.models.map((name: string) => ({ name })) }, viewConfig: parsed.viewConfig })).toBe(true);
  });
});

describe('suggestDomainName / toDomainSlug', () => {
  const folder = (f: string): DraftScope => ({
    id: `folder:${f}`, kind: 'folder', label: f, description: '', detail: '', modelNames: ['a'], count: 1, folder: f,
  });

  it('names folders after their last segment and clusters after their hub', () => {
    expect(suggestDomainName(folder('marts/finance'))).toBe('finance');
    expect(suggestDomainName({ ...folder(''), kind: 'cluster', folder: undefined, modelNames: ['dim_customer', 'fct_x'] })).toBe('customer');
    expect(suggestDomainName(folder(''))).toBe('dbt-draft');
    expect(suggestDomainName(undefined)).toBe('dbt-draft');
  });

  it('avoids taken names', () => {
    expect(suggestDomainName(folder('marts'), ['marts', 'marts-2'])).toBe('marts-3');
  });

  it('slugs free text', () => {
    expect(toDomainSlug('2024 Sales & Returns')).toBe('sales-returns');
    expect(toDomainSlug('Finance')).toBe('finance');
    expect(toDomainSlug('123')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

describe('pickDraftScope', () => {
  let scopes: DraftScope[];
  let models: ReturnType<typeof listDraftModels>;
  beforeAll(() => {
    scopes = listDraftScopes(shopInput({ includeClusters: false }));
    models = listDraftModels(shopInput());
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns a scope that fits', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementationOnce(async (items: any) => (await items)[0]);
    const pick = await pickDraftScope(scopes, { models });
    expect(pick!.scope.id).toBe('folder:marts');
    expect(pick!.modelNames).toHaveLength(3);
  });

  it('returns undefined when cancelled', async () => {
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValueOnce(undefined as any);
    expect(await pickDraftScope(scopes, { models })).toBeUndefined();
  });

  it('excludes names already in the domain and drops emptied scopes', async () => {
    const spy = vi.spyOn(vscode.window, 'showQuickPick').mockImplementationOnce(async (items: any) => (await items)[0]);
    const pick = await pickDraftScope(scopes, { models, excludeNames: ['FCT_ORDERS', 'int_orders'] });
    const offered = (spy.mock.calls[0][0] as any[]).map((i) => i.label);
    expect(offered.some((l: string) => l.includes('intermediate'))).toBe(false);
    expect(pick!.modelNames).toEqual(['dim_customers', 'dim_products']);
  });

  it('pre-ticks the first models of an oversized folder', async () => {
    const spy = vi.spyOn(vscode.window, 'showQuickPick')
      .mockImplementationOnce(async (items: any) => (await items)[0])
      .mockImplementationOnce(async (items: any) => (await items).filter((i: any) => i.picked));
    const pick = await pickDraftScope(scopes, { models, limit: 2 });
    const second = spy.mock.calls[1][0] as any[];
    expect(second.filter((i) => i.picked)).toHaveLength(2);
    expect(pick!.modelNames).toEqual(scopes[0].modelNames.slice(0, 2));
    expect(pick!.scope.count).toBe(2);
  });

  it('"Choose models…" caps the selection, warns and lets the user choose again', async () => {
    vi.spyOn(vscode.window, 'showQuickPick')
      .mockImplementationOnce(async (items: any) => (await items).find((i: any) => i.label === CHOOSE_MODELS_LABEL))
      .mockImplementationOnce(async (items: any) => (await items).slice(0, 3))
      .mockImplementationOnce(async (items: any) => {
        const list = await items;
        expect(list.filter((i: any) => i.picked)).toHaveLength(3);
        return list.slice(0, 2);
      });
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValueOnce('Choose Again' as any);
    const pick = await pickDraftScope(scopes, { models, limit: 2 });
    expect(warn).toHaveBeenCalledOnce();
    expect(pick!.scope.kind).toBe('custom');
    expect(pick!.modelNames).toEqual(models.slice(0, 2).map((m) => m.name));
    expect(pick!.scope.suggestedLayer).toBe('gold');
  });

  it('returns undefined when nothing is left to offer', async () => {
    const spy = vi.spyOn(vscode.window, 'showQuickPick');
    expect(await pickDraftScope([], { models: [] })).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
