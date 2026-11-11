import { describe, expect, it } from 'vitest';
import { linkKey } from '@erd-studio/core';
import type { ColumnDef, Relationship, SemanticTable } from '../../src/types/semantic';
import {
  suggestRelationships,
  suggestionRelationships,
  tableKeysForSuggestions,
  type RelationshipSuggestion,
} from '../../src/services/relationshipSuggestions';
import { extractSqlJoins, mergeSuggestions, suggestionsFromDbtTests, suggestionsFromSqlJoins } from '../../src/services/relationshipSuggestionSources';
import { columnReference, entityWords, nameWords, tableEntity, typeFamily, typesCompatible } from '../../src/services/relationshipNaming';

type Col = [name: string, type: string, flags?: string];
/** flags: P primary key, U unique, N natural key, F stored foreign-key flag. */
function t(name: string, cols: Col[], schema?: string): SemanticTable {
  return {
    name,
    ...(schema ? { schema } : {}),
    columns: cols.map(([n, type, flags = '']): ColumnDef => ({
      name: n,
      dataType: type,
      description: '',
      ...(flags.includes('P') ? { isPrimaryKey: true } : {}),
      ...(flags.includes('N') ? { isNaturalKey: true } : {}),
      ...(flags.includes('F') ? { isForeignKey: true } : {}),
      ...(flags.includes('U') ? { meta: { dbml: { unique: true } } } : {}),
    })),
  };
}
const label = (s: RelationshipSuggestion): string =>
  `${s.fromModel}.${s.pairs.map((p) => p.fromColumn).join('+')}>${s.toModel}.${s.pairs.map((p) => p.toColumn).join('+')}`;
const labels = (list: RelationshipSuggestion[]): string[] => list.map(label);
const find = (list: RelationshipSuggestion[], l: string): RelationshipSuggestion | undefined => list.find((s) => label(s) === l);

describe('naming helpers', () => {
  it('splits names into words', () => {
    expect(nameWords('CustomerKey')).toEqual(['customer', 'key']);
    expect(nameWords('dimensionSetID')).toEqual(['dimension', 'set', 'id']);
    expect(nameWords('Vendor No.')).toEqual(['vendor', 'no']);
    expect(nameWords('sha1_hub_customer')).toEqual(['sha1', 'hub', 'customer']);
  });

  it('reads a table entity without kind prefixes, copy markers or a plural', () => {
    expect(entityWords('dim_customers')).toEqual(['customer']);
    expect(entityWords('stg_categories')).toEqual(['category']);
    expect(entityWords('sales_customer', 'sales')).toEqual(['customer']);
    expect(tableEntity('payment_p2022_01')).toEqual({ words: ['payment'], copy: true });
    expect(tableEntity('orders_bak_20240101')).toEqual({ words: ['order'], copy: true });
    expect(tableEntity('raw_orders')).toEqual({ words: ['order'], copy: true });
    // Data-vault kinds are part of the entity: a satellite is not a copy of its hub.
    expect(entityWords('sat_customer')).not.toEqual(entityWords('hub_customer'));
    // A history of jobs is not the jobs table.
    expect(entityWords('job_history')).toEqual(['job', 'history']);
  });

  it('reads a column as a reference', () => {
    expect(columnReference(['customer', 'id'])).toEqual({ stem: ['customer'], suffix: 'id', family: 'id' });
    expect(columnReference(['fk', 'customer'])).toEqual({ stem: ['customer'], suffix: 'fk', family: 'id' });
    expect(columnReference(['from', 'currency'])).toEqual({ stem: ['from', 'currency'] });
  });

  it('compares types by family, loosely', () => {
    expect(typesCompatible(typeFamily('varchar(3)'), typeFamily('STRING'))).toBe(true);
    expect(typesCompatible(typeFamily('NUMBER(6)'), typeFamily('bigint'))).toBe(true);
    expect(typesCompatible(typeFamily('int'), typeFamily('varchar(10)'))).toBe(false);
    expect(typesCompatible(typeFamily('variant'), typeFamily('int'))).toBe(true);
    expect(typesCompatible(typeFamily(''), typeFamily('int'))).toBe(true);
    expect(typesCompatible(typeFamily('boolean'), typeFamily('boolean'))).toBe(false);
    expect(typesCompatible(typeFamily('array<string>'), typeFamily('string'))).toBe(false);
  });
});

describe('suggestRelationships', () => {
  const customer = t('customer', [['customer_id', 'bigint', 'P'], ['name', 'string']]);
  const orders = t('orders', [['order_id', 'bigint', 'P'], ['customer_id', 'bigint'], ['status', 'string'], ['created_at', 'timestamp']]);

  it('suggests a foreign key named as another table\'s key, strong, with reasons', () => {
    const out = suggestRelationships({ tables: [customer, orders] });
    expect(labels(out)).toEqual(['orders.customer_id>customer.customer_id']);
    const [s] = out;
    expect(s).toMatchObject({ band: 'strong', direction: 'decided', directionBasis: 'keys', cardinality: 'many-to-one', keyInferred: false });
    expect(s.rules).toEqual(['key-name', 'table-name']);
    expect(s.reasons[0]).toBe('customer_id is the primary key of customer, and orders has a column of the same name');
    expect(s.id).toBe(linkKey({ fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customer', toColumn: 'customer_id' }));
  });

  it('never suggests a link that exists, whichever way round it is stored', () => {
    const forward: Relationship = { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customer', toColumn: 'customer_id', cardinality: 'many-to-one' };
    const reversed: Relationship = { fromModel: 'customer', fromColumn: 'customer_id', toModel: 'orders', toColumn: 'customer_id', cardinality: 'one-to-many' };
    expect(suggestRelationships({ tables: [customer, orders], relationships: [forward] })).toEqual([]);
    expect(suggestRelationships({ tables: [customer, orders], relationships: [reversed] })).toEqual([]);
    // Stored in the model library (the table's own relationships).
    const withLibrary = { ...orders, relationships: [{ fromColumn: 'customer_id', toModel: 'customer', toColumn: 'customer_id', cardinality: 'many-to-one' as const }] };
    expect(suggestRelationships({ tables: [customer, withLibrary] })).toEqual([]);
  });

  it('points `<table>_id` at a table keyed `id`', () => {
    const users = t('users', [['id', 'integer', 'P'], ['email', 'varchar', 'U']]);
    const posts = t('posts', [['id', 'integer', 'P'], ['user_id', 'integer'], ['title', 'varchar']]);
    const out = suggestRelationships({ tables: [users, posts] });
    expect(labels(out)).toEqual(['posts.user_id>users.id']);
    expect(out[0].band).toBe('strong');
  });

  it('suggests role-playing dates as two foreign keys to one parent', () => {
    const date = t('dim_date', [['date_key', 'int', 'P'], ['date', 'date']]);
    const fact = t('fct_sales', [['order_date_key', 'int'], ['ship_date_key', 'int'], ['date_key', 'int'], ['amount', 'decimal(18,2)']]);
    const out = suggestRelationships({ tables: [date, fact] });
    expect(labels(out).sort()).toEqual(['fct_sales.date_key>dim_date.date_key', 'fct_sales.order_date_key>dim_date.date_key', 'fct_sales.ship_date_key>dim_date.date_key']);
    expect(find(out, 'fct_sales.ship_date_key>dim_date.date_key')!.band).toBe('likely');
    expect(find(out, 'fct_sales.ship_date_key>dim_date.date_key')!.reasons[0]).toBe('ship_date_key is dim_date\'s date_key in the role "ship"');
  });

  it('suggests from/to currency codes and a manager self reference', () => {
    const currency = t('currency', [['currency_code', 'varchar(3)', 'P']]);
    const fx = t('fx_transfer', [['transfer_id', 'bigint', 'P'], ['from_currency', 'varchar(3)'], ['to_currency', 'varchar(3)']]);
    const employee = t('employee', [['employee_id', 'int', 'P'], ['manager_id', 'int'], ['full_name', 'string']]);
    const out = suggestRelationships({ tables: [currency, fx, employee] });
    expect(labels(out).sort()).toEqual(['employee.manager_id>employee.employee_id', 'fx_transfer.from_currency>currency.currency_code', 'fx_transfer.to_currency>currency.currency_code']);
    const self = find(out, 'employee.manager_id>employee.employee_id')!;
    expect(self.rules).toEqual(['role-playing']);
    expect(self.direction).toBe('decided');
  });

  it('suggests a composite foreign key as one suggestion with column pairs', () => {
    const line = t('order_line', [['order_id', 'bigint', 'P'], ['line_no', 'int', 'P'], ['amount', 'decimal']]);
    const note = t('order_line_note', [['order_id', 'bigint'], ['line_no', 'int'], ['note', 'string']]);
    const out = suggestRelationships({ tables: [line, note] });
    const composite = out.find((s) => s.pairs.length === 2)!;
    expect(label(composite)).toBe('order_line_note.order_id+line_no>order_line.order_id+line_no');
    expect(composite.rules).toEqual(['composite']);
    expect(suggestionRelationships(composite, 'k1')).toEqual([
      { fromModel: 'order_line_note', fromColumn: 'order_id', toModel: 'order_line', toColumn: 'order_id', cardinality: 'many-to-one', compositeKey: 'k1' },
      { fromModel: 'order_line_note', fromColumn: 'line_no', toModel: 'order_line', toColumn: 'line_no', cardinality: 'many-to-one', compositeKey: 'k1' },
    ]);
  });

  it('drops pairs whose types cannot match, unless the type check is off', () => {
    const textual = t('orders', [['order_id', 'bigint', 'P'], ['customer_id', 'varchar(20)']]);
    expect(suggestRelationships({ tables: [customer, textual] })).toEqual([]);
    expect(labels(suggestRelationships({ tables: [customer, textual] }, { typeCheck: false }))).toEqual(['orders.customer_id>customer.customer_id']);
  });

  it('suppresses bookkeeping columns, generic names and copies of one entity', () => {
    const users = t('users', [['id', 'int', 'P']]);
    const stg = t('stg_customer', [['customer_id', 'bigint', 'P'], ['status', 'string'], ['is_active', 'boolean'], ['_loaded_at', 'timestamp'], ['id', 'int']]);
    const status = t('status', [['status', 'string', 'P']]);
    const out = suggestRelationships({ tables: [customer, stg, users, status] });
    // stg_customer is the customer entity: neither points at the other; `id` is generic; status names its table.
    expect(labels(out)).toEqual(['stg_customer.status>status.status']);
    // Partition copies of a table that is also there neither point nor are pointed at.
    const payment = t('payment', [['payment_id', 'int', 'P'], ['customer_id', 'bigint']]);
    const part = t('payment_p2022_01', [['payment_id', 'int', 'P'], ['customer_id', 'bigint']]);
    expect(labels(suggestRelationships({ tables: [customer, payment, part] }))).toEqual(['payment.customer_id>customer.customer_id']);
  });

  it('infers keys when none are declared, one band lower, and says so', () => {
    const c = t('customers', [['customer_id', 'bigint'], ['name', 'string']]);
    const o = t('orders', [['order_id', 'bigint'], ['customer_id', 'bigint']]);
    const out = suggestRelationships({ tables: [c, o] });
    expect(labels(out)).toEqual(['orders.customer_id>customers.customer_id']);
    expect(out[0]).toMatchObject({ band: 'likely', keyInferred: true, directionBasis: 'inferred-key' });
    expect(out[0].reasons[0]).toContain('looks like the key of customers (no key is declared there)');
    expect(suggestRelationships({ tables: [c, o] }, { inferKeys: false }).every((s) => s.band === 'possible')).toBe(true);
    expect(tableKeysForSuggestions(c)).toEqual([{ columns: ['customer_id'], source: 'inferred' }]);
  });

  it('leaves the direction undecided when two keys match and nothing names either', () => {
    const a = t('dup_a', [['k', 'int', 'P']]);
    const c = t('dup_c', [['k', 'int', 'P'], ['parent_k', 'int']]);
    const out = suggestRelationships({ tables: [a, c] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ direction: 'undecided', directionBasis: 'none', band: 'possible', cardinality: 'one-to-one' });
    expect(out[0].reasons).toContain('nothing says which way it points');
  });

  it('decides a key-to-key link by naming, and lets declared keys overrule naming', () => {
    const film = t('film', [['film_id', 'int', 'P']]);
    const text = t('film_text', [['film_id', 'int', 'P'], ['body', 'text']]);
    const out = suggestRelationships({ tables: [film, text] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ fromModel: 'film_text', toModel: 'film', cardinality: 'one-to-one', direction: 'decided', directionBasis: 'naming' });
    // A unique column pointing at a key: one-to-one, the table named for the column is the one pointed at.
    const store = t('store', [['store_id', 'int', 'P']]);
    const profile = t('store_profile', [['id', 'int', 'P'], ['store_id', 'int', 'U']]);
    expect(suggestRelationships({ tables: [store, profile] }).map((s) => [label(s), s.cardinality])).toEqual([['store_profile.store_id>store.store_id', 'one-to-one']]);
  });

  it('drops a naming guess the keys contradict (orientLink decides the other way)', () => {
    // customer declares no key and none is inferred; customer_profile's key is customer_id. The hub rule would point
    // customer_profile.customer_id at customer, but a key column does not point at a column that is not a key.
    const c = t('customer', [['customer_id', 'bigint'], ['name', 'string']]);
    const profile = t('customer_profile', [['customer_id', 'bigint', 'P'], ['tier', 'string']]);
    const o = t('orders', [['order_id', 'bigint', 'P'], ['customer_id', 'bigint']]);
    const out = suggestRelationships({ tables: [c, profile, o] }, { inferKeys: false });
    expect(labels(out)).not.toContain('customer_profile.customer_id>customer.customer_id');
    // orders.customer_id goes where the keys say: the one table keyed by customer_id.
    expect(labels(out)).toEqual(['orders.customer_id>customer_profile.customer_id']);
  });

  it('prefers a target sharing the table\'s name prefix', () => {
    const sites = t('sites', [['id', 'int', 'P']]);
    const cmsSites = t('cms_sites', [['id', 'int', 'P']]);
    const pages = t('cms_pages', [['id', 'int', 'P'], ['site_id', 'int']]);
    expect(labels(suggestRelationships({ tables: [sites, cmsSites, pages] }))).toEqual(['cms_pages.site_id>cms_sites.id']);
  });

  it('marks a link from one medallion layer to another as possible', () => {
    const silver = t('orders', [['order_id', 'bigint', 'P']], 'silver');
    const gold = t('fct_payments', [['payment_id', 'bigint', 'P'], ['order_id', 'bigint']], 'gold');
    const [s] = suggestRelationships({ tables: [silver, gold] });
    expect(s.band).toBe('possible');
    expect(s.reasons).toContain('it crosses from the gold layer to the silver layer');
  });

  it('gives the same suggestions in the same order whatever the table order', () => {
    const tables = [
      customer, orders,
      t('dim_date', [['date_key', 'int', 'P']]),
      t('fct', [['customer_id', 'bigint'], ['date_key', 'int'], ['ship_date_key', 'int']]),
      t('a', [['k', 'int', 'P']]), t('b', [['k', 'int', 'P']]),
    ];
    const a = suggestRelationships({ tables });
    expect(suggestRelationships({ tables: [...tables].reverse() })).toEqual(a);
    expect(suggestRelationships({ tables: [tables[3], tables[0], tables[5], tables[1], tables[4], tables[2]] })).toEqual(a);
  });
});

describe('evidence adapters', () => {
  const customer = t('customer', [['customer_id', 'bigint', 'P']]);
  const orders = t('orders', [['order_id', 'bigint', 'P'], ['customer_id', 'bigint'], ['cust_ref', 'bigint']]);

  it('turns dbt relationships tests into strong suggestions (likely when conditional), skipping existing links', () => {
    const tests = [
      { fromModel: 'orders', fromColumn: 'cust_ref', toModel: 'customer', toColumn: 'customer_id', file: 'models/schema.yml', line: 12 },
      { fromModel: 'Orders', fromColumn: 'CUSTOMER_ID', toModel: 'customer', toColumn: 'customer_id', conditional: true as const },
      { fromModel: 'orders', fromColumn: 'customer_id', toModel: 'missing_model', toColumn: 'id' },
    ];
    const out = suggestionsFromDbtTests(tests, { tables: [customer, orders] });
    expect(out.map((s) => [label(s), s.band])).toEqual([['orders.cust_ref>customer.customer_id', 'strong'], ['orders.customer_id>customer.customer_id', 'likely']]);
    expect(out[0].reasons[0]).toBe('a dbt relationships test checks orders.cust_ref against customer.customer_id (models/schema.yml:12)');
    const existing: Relationship = { fromModel: 'orders', fromColumn: 'cust_ref', toModel: 'customer', toColumn: 'customer_id', cardinality: 'many-to-one' };
    expect(suggestionsFromDbtTests(tests, { tables: [customer, orders], relationships: [existing] }).map(label)).toEqual(['orders.customer_id>customer.customer_id']);
  });

  it('merges sources into one suggestion per link, at the strongest band, with every reason', () => {
    const naming = suggestRelationships({ tables: [customer, orders] });
    const dbt = suggestionsFromDbtTests([{ fromModel: 'orders', fromColumn: 'customer_id', toModel: 'customer', toColumn: 'customer_id' }], { tables: [customer, orders] });
    const merged = mergeSuggestions(naming, dbt);
    expect(merged).toHaveLength(1);
    expect(merged[0].rules).toEqual(expect.arrayContaining(['key-name', 'dbt-test']));
    expect(merged[0].reasons.length).toBeGreaterThan(naming[0].reasons.length);
  });

  it('extracts equality joins between resolvable relations', () => {
    const sql = `
      -- a comment with JOIN x ON a.b = c.d
      with recent as (select * from {{ ref('orders') }} where order_date > '2024-01-01')
      select o.order_id, c.name
      from {{ ref('orders') }} as o
      inner join analytics.customer c on o.customer_id = c.customer_id and c.region = 'AU'
      left join recent r on r.order_id = o.order_id
      join payments using (order_id)`;
    expect(extractSqlJoins(sql)).toEqual([
      { left: { relation: 'orders', column: 'customer_id' }, right: { relation: 'customer', column: 'customer_id' } },
      { left: { relation: 'recent', column: 'order_id' }, right: { relation: 'orders', column: 'order_id' } },
      { left: { relation: 'recent', column: 'order_id' }, right: { relation: 'payments', column: 'order_id' } },
    ]);
  });

  it('suggests joined columns oriented by keys, and skips relations not in the model (CTEs, other tables)', () => {
    const sql = 'select * from orders o join customer c on c.customer_id = o.cust_ref join recent r on r.x = o.order_id';
    const out = suggestionsFromSqlJoins([{ name: 'models/report.sql', sql }], { tables: [customer, orders] });
    expect(out.map((s) => [label(s), s.band, s.direction])).toEqual([['orders.cust_ref>customer.customer_id', 'likely', 'decided']]);
    expect(out[0].reasons[0]).toBe('orders.cust_ref is joined to customer.customer_id in models/report.sql');
  });
});
