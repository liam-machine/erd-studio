import { describe, expect, it } from 'vitest';

import {
  detectActivityStreams,
  detectConventions,
  detectNormalisedShape,
  detectVaultShape,
  vaultKindOf,
  type ConventionModel,
  type ConventionRelationship,
} from '../../src/cli/conventions';

/**
 * Table-shape (structure) detection beyond the Kimball star: Data Vault hubs,
 * links and satellites, Activity Schema streams, and the Inmon / 3NF guess.
 */

type Col = { name: string; dataType?: string; description?: string };
const col = (name: string, dataType = 'varchar', description = ''): Col => ({ name, dataType, description });
const model = (name: string, columns: Col[], extra: Partial<ConventionModel> = {}): ConventionModel =>
  ({ name, kind: 'model', folder: ['marts'], schema: '', columnCount: columns.length, uniqueKeys: [], ...extra, columns });
const rel = (fromModel: string, fromColumn: string, toModel: string, toColumn = fromColumn): ConventionRelationship =>
  ({ fromModel, fromColumn, toModel, toColumn });
const load = [col('load_date', 'timestamp'), col('record_source')];

// A small raw vault whose names carry no hub_/lnk_/sat_ prefix.
const vaultModels = (names = { ch: 'customer_hub', oh: 'order_hub', link: 'customer_order_link', sat: 'customer_sat' }, folder = ['raw_vault']) => [
  model(names.ch, [col('customer_hk', 'binary(16)'), col('customer_id'), ...load], { folder, uniqueKeys: ['customer_hk'] }),
  model(names.oh, [col('order_hk', 'binary(16)'), col('order_id'), ...load], { folder, uniqueKeys: ['order_hk'] }),
  model(names.link, [col('customer_order_hk', 'binary(16)'), col('customer_hk', 'binary(16)'), col('order_hk', 'binary(16)'), ...load], { folder }),
  // A numeric attribute and a key out to the hub: a fact, by the star rules — but it is a satellite.
  model(names.sat, [col('customer_hk', 'binary(16)'), col('hashdiff', 'binary(16)'), col('customer_name'), col('email'), col('credit_limit', 'decimal(12,2)'), ...load], { folder }),
];
const vaultRels = (names = { ch: 'customer_hub', oh: 'order_hub', link: 'customer_order_link', sat: 'customer_sat' }) => [
  rel(names.link, 'customer_hk', names.ch),
  rel(names.link, 'order_hk', names.oh),
  rel(names.sat, 'customer_hk', names.ch),
];

describe('vault-named tables without a catalog', () => {
  it('never judges hub_/sat_/link_ tables as Kimball facts or dimensions, even when only their keys are declared', () => {
    // No catalog: the yml lists keys and one amount, not load_date/record_source, so the column
    // check cannot see the vault — the names must still keep a Kimball rival out.
    const models = [
      model('hub_customer', [col('customer_hk'), col('customer_id')], { uniqueKeys: ['customer_hk'] }),
      model('hub_order', [col('order_hk'), col('order_id')], { uniqueKeys: ['order_hk'] }),
      model('link_customer_order', [col('customer_order_hk'), col('customer_hk'), col('order_hk')]),
      model('sat_order_details', [col('order_hk'), col('order_total', 'decimal(12,2)'), col('tax_paid', 'decimal(12,2)')]),
    ];
    const relationships = [
      rel('link_customer_order', 'customer_hk', 'hub_customer'),
      rel('link_customer_order', 'order_hk', 'hub_order'),
      rel('sat_order_details', 'order_hk', 'hub_order'),
    ];
    const shape = detectConventions({ models, packages: [], snapshots: [], relationships }).shape;
    expect(shape.style).toBe('data-vault');
    expect(shape.alternatives).not.toContain('kimball');
    expect(shape.evidence.join(' ')).not.toMatch(/look(?:s)? like (?:a )?facts?|dimensions/);
  });
});

describe('Data Vault structure', () => {
  it('classifies hubs, links and satellites from their columns alone', () => {
    const [hub, , link, sat] = vaultModels();
    expect(vaultKindOf(hub)).toBe('hub');
    expect(vaultKindOf(link)).toBe('link');
    expect(vaultKindOf(sat)).toBe('satellite');
    // automate_dv style: `customer_pk` typed as a digest, `load_datetime` / `rsrc`.
    expect(vaultKindOf(model('customer', [col('customer_pk', 'binary(16)'), col('customer_id'), col('load_datetime', 'timestamp'), col('rsrc')]))).toBe('hub');
    // Hash keys by name, `hk_` prefix, and "hash key" in a column description.
    expect(vaultKindOf(model('x', [col('hk_customer', 'varchar'), col('customer_number'), col('ldts'), col('rec_src')]))).toBe('hub');
    expect(vaultKindOf(model('y', [col('customer_ref', 'varchar', 'MD5 hash key of the customer'), col('customer_id'), col('loaded_at'), col('record_source')]))).toBe('hub');
  });

  it('needs a hash key and both halves of the load metadata', () => {
    expect(vaultKindOf(model('a', [col('customer_hk'), col('customer_id'), col('load_date')]))).toBeNull();
    expect(vaultKindOf(model('b', [col('customer_hk'), col('customer_id'), col('record_source')]))).toBeNull();
    expect(vaultKindOf(model('c', [col('customer_id'), col('name'), ...load]))).toBeNull();
    // An `_id` typed char(32) is not a hash key; a hashdiff never is.
    expect(vaultKindOf(model('d', [col('customer_id', 'char(32)'), col('hashdiff', 'char(32)'), col('name'), ...load]))).toBeNull();
    // A wide table with a hash key is vault-shaped but not a hub.
    const wide = model('e', [col('customer_hk'), ...Array.from({ length: 8 }, (_, i) => col(`attr_${i}`)), ...load]);
    expect(vaultKindOf(wide)).toBe('vault');
  });

  it('structure alone: a weak Data Vault guess with hub, link and satellite evidence — and no Kimball star', () => {
    const c = detectConventions({ models: vaultModels(), packages: [], snapshots: [], relationships: vaultRels() });
    expect(c.shape).toMatchObject({ style: 'data-vault', confidence: 'weak', sources: ['structure'], alternatives: [] });
    expect(c.shape.evidence).toEqual([
      'shape: customer_hub, order_hub look like hubs (hash key + business key + load date/record source)',
      'shape: customer_order_link looks like a link (two or more hash keys + load metadata)',
      'shape: customer_sat looks like a satellite (hashdiff + load metadata)',
    ]);
  });

  it('structure + hub_/lnk_/sat_ names: strong', () => {
    const names = { ch: 'hub_customer', oh: 'hub_order', link: 'lnk_customer_order', sat: 'sat_customer' };
    const c = detectConventions({ models: vaultModels(names), packages: [], snapshots: [], relationships: vaultRels(names) });
    expect(c.shape).toMatchObject({ style: 'data-vault', confidence: 'strong', sources: ['names', 'structure'], alternatives: [] });
  });

  it('hubs and satellites without a link are enough; one kind alone is not', () => {
    const [hub, orderHub, , sat] = vaultModels();
    expect(detectVaultShape([hub, sat])).toMatchObject({ hubs: ['customer_hub'], satellites: ['customer_sat'], links: [] });
    expect(detectConventions({ models: [hub, sat], packages: [], snapshots: [] }).shape).toMatchObject({ style: 'data-vault', sources: ['structure'] });
    expect(detectConventions({ models: [hub, orderHub], packages: [], snapshots: [] }).shape.style).toBe('none');
  });

  it('staging models are not judged', () => {
    const staged = vaultModels(undefined, ['staging']);
    expect(detectVaultShape(staged).vaultShaped).toEqual([]);
  });

  it('Kimball info marts beside the vault still read as a star, alongside the vault', () => {
    const marts = [
      model('customers', [col('customer_id'), col('customer_name'), col('segment')], { uniqueKeys: ['customer_id'] }),
      model('orders', [col('order_id'), col('customer_id'), col('order_total', 'decimal(12,2)')], { uniqueKeys: ['order_id'] }),
    ];
    const c = detectConventions({
      models: [...vaultModels(), ...marts], packages: [], snapshots: [],
      relationships: [...vaultRels(), rel('orders', 'customer_id', 'customers')],
    });
    // Three vault signals beat the two star signals; both are structure only, so it stays a guess.
    expect(c.shape).toMatchObject({ style: 'data-vault', confidence: 'weak', alternatives: ['kimball'] });
    expect(c.shape.evidence.at(-1)).toMatch(/^also seen — kimball: shape: orders looks like a fact/);
  });
});

describe('Activity Schema structure', () => {
  const stream = (name: string, extra: Col[] = []) => model(name, [
    col('activity_id'), col('ts', 'timestamp'), col('customer'), col('activity'), col('anonymous_customer_id'),
    col('feature_json', 'variant'), col('revenue_impact', 'decimal(12,2)'), col('link'), ...extra,
  ]);

  it('a narrow activity + entity + timestamp table is a stream, whatever its name', () => {
    expect(detectActivityStreams([stream('events')])).toEqual(['events']);
    const c = detectConventions({ models: [stream('events'), model('customers', [col('customer_id'), col('name')], { uniqueKeys: ['customer_id'] })], packages: [], snapshots: [], relationships: [rel('events', 'customer', 'customers', 'customer_id')] });
    // The stream's revenue_impact and key out do not make it a Kimball fact.
    expect(c.shape).toMatchObject({ style: 'activity-schema', confidence: 'weak', sources: ['structure'], alternatives: [] });
    expect(c.shape.evidence).toEqual(['shape: events looks like an activity stream (activity + entity + timestamp)']);
  });

  it('with a _stream name it is strong; a wide table or a missing column is not a stream', () => {
    expect(detectConventions({ models: [stream('customer_stream')], packages: [], snapshots: [] }).shape)
      .toMatchObject({ style: 'activity-schema', confidence: 'strong', sources: ['names', 'structure'] });
    const wide = stream('events', Array.from({ length: 5 }, (_, i) => col(`extra_${i}`)));
    expect(detectActivityStreams([wide])).toEqual([]);
    expect(detectActivityStreams([model('events', [col('activity'), col('customer_id')])])).toEqual([]);
  });
});

describe('Inmon / 3NF structure (a guess)', () => {
  const entity = (name: string, cols: string[], extra: Partial<ConventionModel> = {}) =>
    model(name, cols.map((c) => col(c, c.endsWith('_date') ? 'date' : 'varchar')), { uniqueKeys: [cols[0]], ...extra });
  const normalised = (descriptions: Record<string, string> = {}) => [
    entity('customer', ['customer_id', 'customer_name', 'email'], { description: descriptions.customer }),
    entity('address', ['address_id', 'street', 'city', 'postcode']),
    entity('customer_address', ['customer_id', 'address_id', 'address_type'], { uniqueKeys: [] }),
    entity('category', ['category_id', 'category_name']),
    entity('product', ['product_id', 'product_name', 'category_id']),
    entity('sales_order', ['order_id', 'customer_id', 'order_date', 'status'], { description: descriptions.sales_order }),
    entity('order_line', ['order_line_id', 'order_id', 'product_id', 'line_status']),
    entity('department', ['department_id', 'department_name']),
    entity('employee', ['employee_id', 'employee_name', 'department_id']),
    entity('audit_log', ['audit_id', 'message']),
    entity('app_setting', ['setting_id', 'setting_value']),
  ];
  const normalisedRels = [
    rel('customer_address', 'customer_id', 'customer'),
    rel('customer_address', 'address_id', 'address'),
    rel('product', 'category_id', 'category'),
    rel('sales_order', 'customer_id', 'customer'),
    rel('order_line', 'order_id', 'sales_order'),
    rel('order_line', 'product_id', 'product'),
    rel('employee', 'department_id', 'department'),
  ];

  it('many models joined by keys, no amounts, association tables → weak inmon-3nf', () => {
    expect(detectNormalisedShape(normalised(), normalisedRels)).toMatchObject({
      total: 11, withMeasures: [], associations: ['customer_address', 'order_line'],
    });
    const c = detectConventions({ models: normalised(), packages: [], snapshots: [], relationships: normalisedRels });
    expect(c.shape).toMatchObject({ style: 'inmon-3nf', confidence: 'weak', sources: ['structure'], alternatives: [] });
    expect(c.shape.evidence).toEqual([
      'shape: 9 of 11 models are joined by keys with no amounts to add up — normalised (3NF-style)',
      'shape: customer_address, order_line look like association tables (keys to two tables, little else)',
    ]);
  });

  it('descriptions saying 3NF / EDW / normalised make it strong', () => {
    const c = detectConventions({ models: normalised({ sales_order: 'Sales orders in the enterprise data warehouse, kept in third normal form.' }), packages: [], snapshots: [], relationships: normalisedRels });
    expect(c.shape).toMatchObject({ style: 'inmon-3nf', confidence: 'strong', sources: ['descriptions', 'structure'] });
    expect(c.shape.evidence).toContain('descriptions: sales_order says "third normal form"');
    // "normalised" counts beside the 3NF shape…
    const n = detectConventions({ models: normalised({ customer: 'Normalised customer entity.' }), packages: [], snapshots: [], relationships: normalisedRels });
    expect(n.shape).toMatchObject({ style: 'inmon-3nf', confidence: 'strong' });
    // …but alone it is plain English, and "denormalized" is not it.
    expect(detectConventions({ models: [model('customers', [col('customer_id')], { description: 'Customers with normalised phone numbers.' })], packages: [], snapshots: [] }).shape.style).toBe('none');
    // Explicit Inmon wording alone is a weak description guess.
    expect(detectConventions({ models: [model('customers', [col('customer_id')], { description: 'Core entity of our Inmon-style warehouse.' })], packages: [], snapshots: [] }).shape)
      .toMatchObject({ style: 'inmon-3nf', confidence: 'weak', sources: ['descriptions'] });
  });

  it('is never guessed next to dim_/fct_ or vault names, a star, too few models, amounts or no association table', () => {
    const renamed = normalised().map((m) => (m.name === 'customer' ? { ...m, name: 'dim_customer' } : m));
    expect(detectConventions({ models: renamed, packages: [], snapshots: [], relationships: normalisedRels }).shape.style).toBe('kimball');
    expect(detectNormalisedShape(normalised().slice(0, 5), normalisedRels)).toBeNull();
    const noBridge = normalisedRels.filter((r) => r.fromModel !== 'customer_address' && r.fromModel !== 'order_line');
    expect(detectNormalisedShape(normalised(), noBridge)).toBeNull();
    const withAmounts = normalised().map((m) => (['sales_order', 'order_line', 'product'].includes(m.name)
      ? { ...m, columns: [...(m.columns ?? []), { name: 'total_amount' }] } : m));
    expect(detectNormalisedShape(withAmounts, normalisedRels)).toBeNull();
    // Typed amounts on the orders make a star: Kimball structure wins and the 3NF guess is not made.
    const typed = normalised().map((m) => (m.name === 'sales_order' ? { ...m, columns: [...(m.columns ?? []), col('order_total', 'decimal(12,2)')] } : m));
    expect(detectConventions({ models: typed, packages: [], snapshots: [], relationships: normalisedRels }).shape)
      .toMatchObject({ style: 'kimball', alternatives: [] });
  });
});
