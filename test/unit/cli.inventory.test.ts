import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCliContext } from '../../src/cli/context';
import { main } from '../../src/cli/index';
import { detectConventions, medallionLayerOf } from '../../src/cli/conventions';
import { clustersOf, runInventory, suggestLayer } from '../../src/cli/inventory';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PROJECT = path.join(FIXTURES, 'dbt-project');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-inv-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function ctxFor(project: string) {
  return buildCliContext({ project, semanticDir: '.erd-studio' });
}

describe('inventory', () => {
  it('lists every project model with physical-stage columns, keys and relationships', async () => {
    const r = runInventory(await ctxFor(PROJECT));
    const names = r.models.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['dim_customer', 'dim_project', 'dim_task', 'fct_order', 'fct_sale', 'fct_task_event', 'dim_date', 'dim_region']));
    // Sorted by folder, then name.
    const keys = r.models.map((m) => `${m.folder.join('/')}|${m.name}`);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));

    const dimProject = r.models.find((m) => m.name === 'dim_project')!;
    expect(dimProject).toMatchObject({
      kind: 'model',
      folder: ['silver'],
      suggestedLayer: 'silver',
      existsInProject: true,
      ymlFile: 'models/silver/dim_project.yml',
      file: 'models/silver/dim_project.sql',
      keyCandidates: { unique: ['project_key'], compositeUnique: [] },
    });
    expect(dimProject.columns!.length).toBe(dimProject.columnCount);

    const region = r.models.find((m) => m.name === 'dim_region')!;
    expect(region).toMatchObject({ columnCount: 0, provenance: { columns: ['file'], types: 'file' }, ymlFile: null });

    const fctOrder = r.models.find((m) => m.name === 'fct_order')!;
    expect(fctOrder.foreignKeys.sort()).toEqual(['customer_key', 'project_key']);
    expect(r.relationships).toContainEqual({ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' });

    expect(r.clusters.length).toBeGreaterThan(0);
    expect(r.clusters[0]).toContain('fct_order');
    expect(r.alreadyModelled).toContain('dim_project');
    expect(r.alreadyModelled).not.toContain('dim_region');
    expect(r.domains).toContainEqual(expect.objectContaining({ file: '.erd-studio/silver/showcase.json', layer: 'silver', domain: 'showcase' }));
    expect(r.domains.find((d) => d.domain === 'showcase')!.models).toContain('fct_task_event');
    expect(r.inputs.catalog).toBe('ok');
    expect(r.cliVersion).toBeTruthy();
    expect(r.semanticDir).toBe('.erd-studio');
  });

  it('--summary omits columns but keeps counts', async () => {
    const r = runInventory(await ctxFor(PROJECT), { summary: true });
    for (const m of r.models) {
      expect(m).not.toHaveProperty('columns');
      expect(typeof m.columnCount).toBe('number');
    }
  });

  it('--models scopes relationships exactly as a domain would', async () => {
    const r = runInventory(await ctxFor(PROJECT), { models: ['fct_order', 'dim_customer'] });
    expect(r.models.map((m) => m.name).sort()).toEqual(['dim_customer', 'fct_order']);
    expect(r.relationships).toEqual([
      { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    expect(r.clusters).toEqual([['dim_customer', 'fct_order']]);
  });

  it('--models reports unknown names as not in the project and invalid names as skipped', async () => {
    const r = runInventory(await ctxFor(PROJECT), { models: ['nope_model', 'Bad-Name'] });
    expect(r.models).toHaveLength(1);
    expect(r.models[0]).toMatchObject({ name: 'nope_model', existsInProject: false, provenance: null, columnCount: 0 });
    expect(r.skipped).toEqual([{ name: 'Bad-Name', reason: 'invalid-name' }]);
  });

  it('works with no .erd-studio folder and no layers.json (never throws on layers)', async () => {
    const root = path.join(tmp, 'p');
    fs.cpSync(PROJECT, root, { recursive: true });
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true });
    const r = runInventory(await ctxFor(root));
    expect(r.models.length).toBeGreaterThan(0);
    expect(r.alreadyModelled).toEqual([]);
    expect(r.domains).toEqual([]);
  });

  it('reads modern tests (data_tests / arguments) with no manifest', async () => {
    const r = runInventory(await ctxFor(path.join(FIXTURES, 'dbt-project-modern-tests')));
    expect(r.inputs).toEqual({ manifest: 'missing', catalog: 'missing' });
    expect(r.models.map((m) => m.name).sort()).toEqual(['dim_customer', 'dim_product', 'fct_orders', 'fct_shipments']);
    expect(r.relationships.length).toBeGreaterThan(0);
    expect(r.models.every((m) => m.suggestedLayer === 'gold')).toBe(true); // marts → gold
  });

  it('handles the sparse and empty-manifest fixtures', async () => {
    const sparse = runInventory(await ctxFor(path.join(FIXTURES, 'dbt-project-sparse')));
    expect(sparse.models.map((m) => m.name).sort()).toEqual(['empty_columns', 'no_columns', 'null_fields']);

    const root = path.join(tmp, 'empty');
    fs.cpSync(path.join(FIXTURES, 'dbt-project-empty-manifest'), root, { recursive: true });
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), "name: empty\nprofile: empty\n");
    const empty = runInventory(await ctxFor(root));
    expect(empty.models).toEqual([]);
    expect(empty.inputs.manifest).not.toBe('missing');
  });

  it('skips dbt models whose names break the naming rule', async () => {
    const root = path.join(tmp, 'p');
    fs.cpSync(PROJECT, root, { recursive: true });
    fs.writeFileSync(path.join(root, 'models', 'silver', 'DimWeird.sql'), 'select 1');
    const r = runInventory(await ctxFor(root));
    expect(r.skipped).toContainEqual({ name: 'DimWeird', reason: 'invalid-name' });
    expect(r.models.map((m) => m.name)).not.toContain('DimWeird');
  });
});

describe('inventory helpers', () => {
  it('suggestLayer', () => {
    expect(suggestLayer(['gold', 'x'], ['silver', 'gold'])).toBe('gold');
    expect(suggestLayer(['staging'], ['silver', 'gold'])).toBe('silver');
    expect(suggestLayer(['intermediate'], [])).toBe('silver');
    expect(suggestLayer(['marts', 'finance'], [])).toBe('gold');
    expect(suggestLayer(['misc'], [])).toBeNull();
    expect(suggestLayer([], ['silver'])).toBeNull();
  });

  it('clustersOf finds connected components and omits singletons', () => {
    const rel = (a: string, b: string) => ({ fromModel: a, fromColumn: 'k', toModel: b, toColumn: 'k', cardinality: 'many-to-one' as const });
    expect(clustersOf([rel('f1', 'd1'), rel('f1', 'd2'), rel('f2', 'd3'), rel('d3', 'd3')])).toEqual([['d1', 'd2', 'f1'], ['d3', 'f2']]);
    expect(clustersOf([])).toEqual([]);
  });
});

describe('inventory via main', () => {
  it('exits 3 with a JSON error when there is no dbt project', async () => {
    let out = '';
    const io = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: tmp, env: {} };
    expect(await main(['inventory', '--json'], io)).toBe(3);
    expect(JSON.parse(out).error.code).toBe('no-project');
  });

  it('keeps service diagnostics off stdout', async () => {
    let out = '';
    const io = { stdout: { write: (s: string) => { out += s; } }, stderr: { write: () => undefined }, cwd: PROJECT, env: {} };
    expect(await main(['inventory', '--json', '--summary'], io)).toBe(0);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out).conventions.layering.style).toBe('medallion');
  });
});

/** A throwaway dbt project: `files` maps project-relative paths to contents. */
function makeProject(dir: string, files: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dbt_project.yml'), 'name: tmp\nprofile: tmp\nmodel-paths: ["models"]\nsnapshot-paths: ["snapshots"]\n');
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return dir;
}

describe('inventory conventions', () => {
  it('fixture: medallion (silver, gold) with strong Kimball marts', async () => {
    const r = runInventory(await ctxFor(PROJECT), { summary: true });
    expect(r.conventions.layering).toMatchObject({ style: 'medallion', layers: ['silver', 'gold'] });
    expect(r.conventions.layering.evidence).toContain('folders silver, gold');
    expect(r.conventions.shape).toMatchObject({ style: 'kimball', confidence: 'strong', alternatives: [] });
    expect(r.conventions.shape.evidence.some((e) => e.startsWith('5 models named dim_'))).toBe(true);
    expect(r.conventions.shape.evidence.some((e) => e.startsWith('3 models named fct_'))).toBe(true);
    expect(r.conventions.history).toEqual({ snapshots: [] });
  });

  it('is present in full output and stays project-wide under --models', async () => {
    const full = runInventory(await ctxFor(PROJECT));
    const scoped = runInventory(await ctxFor(PROJECT), { models: ['dim_customer'] });
    expect(full.conventions.shape.style).toBe('kimball');
    expect(scoped.conventions).toEqual(full.conventions);
  });

  it('medallion bronze/silver/gold + Kimball + snapshots; bronze models suggest the bronze layer', async () => {
    const root = makeProject(path.join(tmp, 'med'), {
      'models/bronze/raw_customers.sql': 'select 1',
      'models/bronze/raw_orders.sql': 'select 1',
      'models/silver/customers_clean.sql': 'select 1',
      'models/gold/dim_customer.sql': 'select 1',
      'models/gold/dim_date.sql': 'select 1',
      'models/gold/fct_order.sql': 'select 1',
      'snapshots/customers_snapshot.sql': '{% snapshot customers_snapshot %}\nselect 1\n{% endsnapshot %}\n',
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.conventions.layering).toMatchObject({ style: 'medallion', layers: ['bronze', 'silver', 'gold'] });
    expect(r.conventions.shape).toMatchObject({ style: 'kimball', confidence: 'strong' });
    expect(r.conventions.shape.evidence.some((e) => e.includes('snapshot') && e.includes('customers_snapshot'))).toBe(true);
    expect(r.conventions.history.snapshots).toEqual(['customers_snapshot']);
    const layerOf = (n: string) => r.models.find((m) => m.name === n)!.suggestedLayer;
    expect(layerOf('raw_customers')).toBe('bronze');
    expect(layerOf('customers_clean')).toBe('silver');
    expect(layerOf('fct_order')).toBe('gold');
  });

  it('Data Vault via the automate_dv package is strong even with Kimball info marts', async () => {
    const root = makeProject(path.join(tmp, 'dv'), {
      'packages.yml': 'packages:\n  - package: Datavault-UK/automate_dv\n    version: 0.11.0\n',
      'models/raw_vault/hub_customer.sql': 'select 1',
      'models/marts/dim_customer.sql': 'select 1',
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.conventions.shape).toMatchObject({ style: 'data-vault', confidence: 'strong', alternatives: ['kimball'] });
    expect(r.conventions.shape.evidence).toContain('package Datavault-UK/automate_dv');
    expect(r.conventions.shape.evidence.some((e) => e.startsWith('also seen — kimball'))).toBe(true);
  });

  it('reads the package from package-lock.yml too', async () => {
    const root = makeProject(path.join(tmp, 'lock'), {
      'package-lock.yml': 'packages:\n  - name: datavault4dbt\n    package: ScalefreeCOM/datavault4dbt\n    version: 1.4.0\n',
      'models/customers.sql': 'select 1',
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.conventions.shape).toMatchObject({ style: 'data-vault', confidence: 'strong' });
  });

  it('no signal: layering none, shape none, no snapshots', async () => {
    const root = makeProject(path.join(tmp, 'plain'), {
      'models/customers.sql': 'select 1',
      'models/orders.sql': 'select 1',
      'models/reports/revenue.sql': 'select 1',
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.conventions).toEqual({
      layering: { style: 'none', evidence: [], layers: [] },
      shape: { style: 'none', confidence: 'weak', evidence: [], alternatives: [], sources: [] },
      history: { snapshots: [] },
    });
    expect(r.models.every((m) => m.suggestedLayer === null)).toBe(true);
  });

  it('dbt layered by folders and stg_ prefixes', async () => {
    const root = makeProject(path.join(tmp, 'layered'), {
      'models/staging/stg_orders.sql': 'select 1',
      'models/intermediate/int_orders_joined.sql': 'select 1',
      'models/marts/orders.sql': 'select 1',
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.conventions.layering).toMatchObject({ style: 'dbt-layered', layers: ['staging', 'intermediate', 'marts'] });
    expect(r.conventions.shape.style).toBe('none');
  });
});

describe('detectConventions (pure)', () => {
  const m = (name: string, extra: Partial<{ folder: string[]; schema: string; columnCount: number; kind: 'model' | 'seed' | 'snapshot' }> = {}) =>
    ({ name, kind: 'model' as const, folder: [], schema: '', columnCount: 5, ...extra });

  it('medallion by schema tokens alone', () => {
    const c = detectConventions({ models: [m('a', { schema: 'analytics_bronze' }), m('b', { schema: 'analytics_gold' })], packages: [], snapshots: [] });
    expect(c.layering).toEqual({ style: 'medallion', evidence: ['schemas bronze, gold'], layers: ['bronze', 'gold'] });
  });

  it('one medallion name alone is not a layout', () => {
    expect(detectConventions({ models: [m('a', { folder: ['gold'] })], packages: [], snapshots: [] }).layering.style).toBe('none');
  });

  it('a single Kimball signal is weak', () => {
    expect(detectConventions({ models: [m('dim_customer')], packages: [], snapshots: [] }).shape)
      .toMatchObject({ style: 'kimball', confidence: 'weak' });
  });

  it('mixed Kimball and Data Vault prefixes without a package: top one, weak, alternative listed', () => {
    const c = detectConventions({ models: [m('dim_a'), m('fct_b'), m('hub_c')], packages: [], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'kimball', confidence: 'weak', alternatives: ['data-vault'] });
    expect(c.shape.evidence.at(-1)).toMatch(/^also seen — data-vault: 1 model named hub_/);
  });

  it('a tie is weak', () => {
    const c = detectConventions({ models: [m('dim_a'), m('hub_b')], packages: [], snapshots: [] });
    expect(c.shape.confidence).toBe('weak');
    expect(c.shape.alternatives).toHaveLength(1);
  });

  it('snapshots alone are not Kimball evidence, but support it', () => {
    expect(detectConventions({ models: [m('customers')], packages: [], snapshots: ['snap_customers'] }).shape.style).toBe('none');
    const c = detectConventions({ models: [m('dim_customer')], packages: [], snapshots: ['snap_customers'] });
    expect(c.shape).toMatchObject({ style: 'kimball', confidence: 'strong' });
    expect(c.history.snapshots).toEqual(['snap_customers']);
  });

  it('One Big Table: obt_ names plus a few very wide marts', () => {
    const c = detectConventions({ models: [m('obt_sales', { columnCount: 120 }), m('customers')], packages: [], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'one-big-table', confidence: 'strong' });
    // Wide tables in a big project are not OBT evidence.
    const many = Array.from({ length: 20 }, (_, i) => m(`mart_${i}`, { columnCount: i === 0 ? 80 : 5 }));
    expect(detectConventions({ models: many, packages: [], snapshots: [] }).shape.style).toBe('none');
  });

  it('Activity Schema: stream models and the package', () => {
    const c = detectConventions({ models: [m('customer_stream')], packages: ['tnightengale/dbt_activity_schema'], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'activity-schema', confidence: 'strong' });
  });

  it('medallion layer of a model: folder at any depth, then schema', () => {
    expect(medallionLayerOf(['sales', 'Bronze'], '')).toBe('bronze');
    expect(medallionLayerOf([], 'dev_silver')).toBe('silver');
    expect(medallionLayerOf(['marts'], 'analytics')).toBeNull();
    expect(suggestLayer(['sales', 'bronze'], ['silver', 'gold'], { schema: '' })).toBe('bronze');
    expect(suggestLayer(['sales', 'bronze'], ['silver', 'gold'])).toBeNull();
  });
});

describe('detectConventions — descriptions and table shape', () => {
  type Col = { name: string; dataType?: string; description?: string };
  const col = (name: string, dataType = 'varchar', description = ''): Col => ({ name, dataType, description });
  const mart = (name: string, extra: Partial<{ description: string; columns: Col[]; uniqueKeys: string[]; folder: string[]; kind: 'model' | 'seed' | 'snapshot' }> = {}) => {
    const columns = extra.columns ?? [];
    return { name, kind: 'model' as const, folder: ['marts'], schema: '', columnCount: columns.length, uniqueKeys: [] as string[], ...extra, columns };
  };
  const rel = (fromModel: string, fromColumn: string, toModel: string, toColumn = fromColumn) => ({ fromModel, fromColumn, toModel, toColumn });

  // A jaffle-shop-like star: facts with keys out and amounts, dimensions with descriptive attributes.
  const starModels = (descriptions: Record<string, string> = {}) => [
    mart('orders', { description: descriptions.orders, uniqueKeys: ['order_id'], columns: [col('order_id'), col('customer_id'), col('location_id'), col('ordered_at', 'timestamp'), col('subtotal', 'decimal(16,2)'), col('tax_paid', 'decimal(16,2)'), col('order_total', 'decimal(16,2)')] }),
    mart('order_items', { description: descriptions.order_items, uniqueKeys: ['order_item_id'], columns: [col('order_item_id'), col('order_id'), col('product_id'), col('product_price', 'decimal(16,2)'), col('is_food_item', 'boolean')] }),
    mart('customers', { description: descriptions.customers, uniqueKeys: ['customer_id'], columns: [col('customer_id'), col('customer_name'), col('customer_type')] }),
    mart('products', { description: descriptions.products, uniqueKeys: ['product_id'], columns: [col('product_id'), col('product_name'), col('product_type'), col('product_price', 'decimal(16,2)')] }),
    mart('locations', { description: descriptions.locations, uniqueKeys: ['location_id'], columns: [col('location_id'), col('location_name'), col('tax_rate', 'double'), col('opened_date', 'timestamp')] }),
  ];
  const starRels = [
    rel('orders', 'customer_id', 'customers'),
    rel('orders', 'location_id', 'locations'),
    rel('order_items', 'order_id', 'orders'),
    rel('order_items', 'product_id', 'products'),
  ];
  const kimballWords = {
    products: 'Product dimension table. The grain of the table is one row per product.',
    locations: 'Location dimension table. The grain of the table is one row per location.',
    orders: 'Order overview data mart. One row per order.',
    order_items: 'Items contained in each order. The grain of the table is one row per order item.',
  };

  it('descriptions alone: Kimball, weak, sourced from descriptions, naming the models', () => {
    const models = [mart('products', { description: kimballWords.products }), mart('locations', { description: kimballWords.locations }), mart('orders', { description: kimballWords.orders })];
    const c = detectConventions({ models, packages: [], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'kimball', confidence: 'weak', sources: ['descriptions'], alternatives: [] });
    expect(c.shape.evidence).toContain('descriptions: locations, products say "dimension table"');
    // Grain wording is quoted as support, never counted as a signal of its own.
    expect(c.shape.evidence.some((e) => e.includes('orders is "one row per order"'))).toBe(true);
  });

  it('structure alone: a star is a weak Kimball guess', () => {
    const c = detectConventions({ models: starModels(), packages: [], snapshots: [], relationships: starRels });
    expect(c.shape).toMatchObject({ style: 'kimball', confidence: 'weak', sources: ['structure'] });
    expect(c.shape.evidence).toContain('shape: order_items, orders look like facts (keys to other tables + amounts to add up)');
    expect(c.shape.evidence.some((e) => e.startsWith('shape: customers, locations, products look like dimensions'))).toBe(true);
  });

  it('descriptions + structure agree: strong, without any dim_/fct_ names', () => {
    const c = detectConventions({ models: starModels(kimballWords), packages: [], snapshots: [], relationships: starRels });
    expect(c.shape).toMatchObject({ style: 'kimball', confidence: 'strong', sources: ['descriptions', 'structure'], alternatives: [] });
    expect(c.shape.evidence[0]).toBe('descriptions: locations, products say "dimension table"');
    expect(c.shape.evidence.at(-1)).toMatch(/^descriptions: order_items is "one row per order item", orders is "one row per order"/);
  });

  it('names alone are one family: dim_ + fct_ without anything else is weak; with structure, strong', () => {
    const named = [mart('dim_customer', { uniqueKeys: ['customer_id'], columns: [col('customer_id'), col('customer_name')] }),
      mart('fct_order', { columns: [col('order_id'), col('customer_id'), col('amount', 'numeric')] })];
    expect(detectConventions({ models: named, packages: [], snapshots: [] }).shape)
      .toMatchObject({ style: 'kimball', confidence: 'weak', sources: ['names'] });
    expect(detectConventions({ models: named, packages: [], snapshots: [], relationships: [rel('fct_order', 'customer_id', 'dim_customer')] }).shape)
      .toMatchObject({ style: 'kimball', confidence: 'strong', sources: ['names', 'structure'] });
  });

  it('Data Vault by descriptions (hubs, satellites, hash keys); "business key" alone is not enough', () => {
    const vault = [
      mart('customer', { description: 'Customer hub table keyed on the customer hash key.' }),
      mart('customer_details', { description: 'Satellite holding descriptive customer attributes.', columns: [col('hashdiff', 'varchar', 'Hash diff of the payload')] }),
    ];
    const c = detectConventions({ models: vault, packages: [], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'data-vault', confidence: 'weak', sources: ['descriptions'] });
    expect(c.shape.evidence).toContain('descriptions: customer says "hub"');
    expect(c.shape.evidence).toContain('descriptions: customer_details says "satellite"');
    const plain = [mart('customers', { description: 'Customers, identified by their business key.' })];
    expect(detectConventions({ models: plain, packages: [], snapshots: [] }).shape.style).toBe('none');
  });

  it('One Big Table wording; "denormalized" alone is not enough', () => {
    const c = detectConventions({ models: [mart('sales', { description: 'One big table of sales, denormalized for BI.' })], packages: [], snapshots: [] });
    expect(c.shape).toMatchObject({ style: 'one-big-table', sources: ['descriptions'] });
    expect(c.shape.evidence).toEqual(['descriptions: sales says "one big table"', 'descriptions: sales says "denormalized"']);
    expect(detectConventions({ models: [mart('sales', { description: 'Sales, denormalized for BI.' })], packages: [], snapshots: [] }).shape.style).toBe('none');
  });

  it('staging boilerplate is not counted: grain wording and staging structure alone say nothing', () => {
    const stg = (name: string, description: string, columns: Col[] = []) => mart(name, { folder: ['staging'], description, columns, uniqueKeys: columns.length ? [columns[0].name] : [] });
    const models = [
      stg('stg_customers', 'Customer data with basic cleaning applied, one row per customer.', [col('customer_id'), col('customer_name')]),
      stg('stg_orders', 'Order data with basic cleaning applied, one row per order.', [col('order_id'), col('customer_id'), col('order_total', 'decimal(16,2)')]),
      mart('revenue', { description: 'Revenue report, one row per day. In fact, the numbers come straight from orders.' }),
    ];
    const c = detectConventions({ models, packages: [], snapshots: [], relationships: [rel('stg_orders', 'customer_id', 'stg_customers')] });
    expect(c.shape).toEqual({ style: 'none', confidence: 'weak', evidence: [], alternatives: [], sources: [] });
    // …but an explicit "dimension" in a staging model still counts.
    const explicit = [stg('stg_products', 'Staged product dimension table.')];
    expect(detectConventions({ models: explicit, packages: [], snapshots: [] }).shape).toMatchObject({ style: 'kimball', sources: ['descriptions'] });
  });

  it('words need word boundaries: agg_time_dimension, factory and surrogate keys alone are not Kimball', () => {
    const models = [
      mart('orders', { description: 'Orders from the factory floor; agg_time_dimension is ordered_at.', columns: [col('order_sk', 'varchar', 'Surrogate key built with generate_surrogate_key.')] }),
    ];
    expect(detectConventions({ models, packages: [], snapshots: [] }).shape.style).toBe('none');
  });

  it('a plain project with descriptions and columns stays none', () => {
    const models = [
      mart('customers', { description: 'Everyone who has bought something.', uniqueKeys: ['customer_id'], columns: [col('customer_id'), col('name')] }),
      mart('orders', { description: 'All orders.', uniqueKeys: ['order_id'], columns: [col('order_id'), col('status')] }),
    ];
    const c = detectConventions({ models, packages: [], snapshots: [], relationships: [rel('orders', 'customer_id', 'customers')] });
    expect(c.shape).toEqual({ style: 'none', confidence: 'weak', evidence: [], alternatives: [], sources: [] });
  });

  it('snapshots back an explicit statement, never structure alone', () => {
    expect(detectConventions({ models: starModels(), packages: [], snapshots: ['customers_snapshot'], relationships: starRels }).shape)
      .toMatchObject({ confidence: 'weak', sources: ['structure'] });
    const withWords = detectConventions({ models: [mart('products', { description: kimballWords.products })], packages: [], snapshots: ['customers_snapshot'] });
    expect(withWords.shape).toMatchObject({ confidence: 'strong', sources: ['descriptions', 'snapshots'] });
  });

  it('inventory reads yml descriptions and relationships into conventions, also with --summary', async () => {
    const root = makeProject(path.join(tmp, 'spirit'), {
      'models/marts/products.sql': 'select 1',
      'models/marts/orders.sql': 'select 1',
      'models/marts/schema.yml': [
        'models:',
        '  - name: products',
        '    description: Product dimension table. One row per product.',
        '    columns:',
        '      - name: product_id',
        '        data_tests: [unique]',
        '      - name: product_name',
        '        data_type: varchar',
        '  - name: orders',
        '    description: One row per order.',
        '    columns:',
        '      - name: order_id',
        '      - name: product_id',
        '        data_tests:',
        '          - relationships:',
        "              to: ref('products')",
        '              field: product_id',
        '      - name: order_total',
        '        data_type: numeric',
        '',
      ].join('\n'),
    });
    const r = runInventory(await ctxFor(root), { summary: true });
    expect(r.models.every((m) => m.columns === undefined)).toBe(true);
    expect(r.conventions.shape).toMatchObject({ style: 'kimball', confidence: 'strong', sources: ['descriptions', 'structure'] });
    expect(r.conventions.shape.evidence).toContain('descriptions: products says "dimension table"');
    expect(r.conventions.shape.evidence).toContain('shape: orders looks like a fact (keys to other tables + amounts to add up)');
  });
});
