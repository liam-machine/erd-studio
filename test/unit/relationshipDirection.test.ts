/**
 * A dragged relationship points from the column that refers to a key at the
 * key (issue #133), so the drag that starts on a dimension's key still opens
 * the dialog with the fact as "from" — the many side, which stores it.
 */

import { describe, it, expect } from 'vitest';

import { keysContradictionWarning, orientDraggedRelationship } from '../../webview/lib/relationshipDirection';

const col = (name: string, keys: { pk?: boolean; nk?: boolean; fk?: boolean } = {}) => ({
  name, dataType: 'string', description: '',
  isPrimaryKey: keys.pk ?? false, isNaturalKey: keys.nk ?? false, isForeignKey: keys.fk ?? false,
});
const MODELS = [
  { name: 'dim_customer', columns: [col('customer_key', { pk: true }), col('customer_code', { nk: true })] },
  { name: 'fct_order', columns: [col('order_key', { pk: true }), col('customer_key')] },
  { name: 'brg_account_customer', columns: [col('customer_key', { pk: true, fk: true })] },
];

const HUB = { name: 'hub_customer', columns: [col('customer_hk', { pk: true }), col('customer_id', { nk: true })] };
const SAT = { name: 'sat_customer', columns: [col('customer_hk', { pk: true }), col('load_date', { pk: true }), col('name')] };
const LNK = { name: 'lnk_order_customer', columns: [col('order_customer_hk', { pk: true }), col('customer_hk'), col('order_hk')] };
const FCT_GRAIN = { name: 'fct_daily', columns: [col('customer_key', { pk: true }), col('date_key', { pk: true }), col('amount')] };

describe('orientDraggedRelationship — Data Vault and composite keys (#133)', () => {
  const MODELS2 = [...MODELS, HUB, SAT, LNK, FCT_GRAIN];
  const turned = (fm: string, fc: string, tm: string, tc: string) =>
    orientDraggedRelationship({ fromModel: fm, fromColumn: fc, toModel: tm, toColumn: tc }, MODELS2).fromModel;

  it('a drag from a hub to its satellite is stored on the satellite (part of its composite key)', () => {
    expect(turned('hub_customer', 'customer_hk', 'sat_customer', 'customer_hk')).toBe('sat_customer');
  });
  it('a drag from a hub to a link is stored on the link', () => {
    expect(turned('hub_customer', 'customer_hk', 'lnk_order_customer', 'customer_hk')).toBe('lnk_order_customer');
  });
  it('a drag from a dimension to a fact keyed by its dimension keys is stored on the fact', () => {
    expect(turned('dim_customer', 'customer_key', 'fct_daily', 'customer_key')).toBe('fct_daily');
  });
  it('a drag already from the satellite is left alone', () => {
    expect(turned('sat_customer', 'customer_hk', 'hub_customer', 'customer_hk')).toBe('sat_customer');
  });
});

describe('orientDraggedRelationship (#133)', () => {
  it('turns a drag from a dimension key to a fact column round', () => {
    expect(orientDraggedRelationship(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      MODELS,
    )).toEqual({
      fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
      cardinality: 'many-to-one', direction: 'decided', basis: 'keys',
    });
  });

  it('turns a drag from a natural key round too', () => {
    expect(orientDraggedRelationship(
      { fromModel: 'dim_customer', fromColumn: 'customer_code', toModel: 'fct_order', toColumn: 'customer_key' },
      MODELS,
    ).fromModel).toBe('fct_order');
  });

  it('keeps a drag that already starts on the referring column, decided', () => {
    const prefill = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
    expect(orientDraggedRelationship(prefill, MODELS)).toEqual({ ...prefill, cardinality: 'many-to-one', direction: 'decided', basis: 'keys' });
  });

  it('key-to-key drags are a one-to-one the user decides: ends as dragged, undecided', () => {
    const prefill = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'order_key' };
    expect(orientDraggedRelationship(prefill, MODELS)).toEqual({ ...prefill, cardinality: 'one-to-one', direction: 'undecided', basis: 'none' });
  });

  it('a key that is also flagged as a foreign key holds the other key: one-to-one from the bridge', () => {
    expect(orientDraggedRelationship(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'brg_account_customer', toColumn: 'customer_key' },
      MODELS.map((m) => ({ ...m, columns: m.columns.map((c) => ({ ...c, isForeignKeyDeclared: c.isForeignKey })) })),
    )).toMatchObject({ fromModel: 'brg_account_customer', cardinality: 'one-to-one', direction: 'decided' });
  });

  it('leaves a drag with no target column, or unknown columns, alone', () => {
    const noTarget = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order' };
    expect(orientDraggedRelationship(noTarget, MODELS)).toBe(noTarget);
    const unknown = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'nope' };
    expect(orientDraggedRelationship(unknown, MODELS)).toBe(unknown);
  });
});

describe('orientDraggedRelationship — no key flagged (#133 L1)', () => {
  const unflagged = [
    { name: 'dim_customer', columns: [col('customer_id')] },
    { name: 'fct_order', columns: [col('customer_id')] },
  ];
  const drag = { fromModel: 'dim_customer', fromColumn: 'customer_id', toModel: 'fct_order', toColumn: 'customer_id' };

  it('a drag from a column dbt tests as unique turns round', () => {
    const tested = unflagged.map((m) => (m.name === 'dim_customer'
      ? { ...m, columns: [{ ...col('customer_id'), dbtKey: { key: 'unique' as const, because: 'unique-test' as const } }] } : m));
    expect(orientDraggedRelationship(drag, tested)).toEqual({
      fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id',
      cardinality: 'many-to-one', direction: 'decided', basis: 'dbt',
    });
  });

  it('with no evidence, the ends stay as dragged and nothing is decided — whichever way it was dragged', () => {
    expect(orientDraggedRelationship(drag, unflagged)).toEqual({ ...drag, cardinality: 'many-to-one', direction: 'undecided', basis: 'none' });
    const back = { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id' };
    expect(orientDraggedRelationship(back, unflagged)).toMatchObject({ ...back, direction: 'undecided' });
  });

  it('a Data Vault satellite with no flags is oriented by its unique combination', () => {
    const part = { key: 'not-unique' as const, because: 'part-of-unique-combination' as const, combinations: [['customer_hk', 'load_date']] };
    const models = [
      { name: 'hub_customer', columns: [{ ...col('customer_hk'), dbtKey: { key: 'unique' as const, because: 'unique-test' as const } }] },
      { name: 'sat_customer', columns: [{ ...col('customer_hk'), dbtKey: part }, { ...col('load_date'), dbtKey: part }] },
    ];
    expect(orientDraggedRelationship(
      { fromModel: 'hub_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk' }, models,
    )).toMatchObject({ fromModel: 'sat_customer', toModel: 'hub_customer', direction: 'decided', basis: 'dbt' });
  });
});

describe('keysContradictionWarning — the dialog\'s keys-win warning (#133)', () => {
  const rel = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' as const };
  it('warns when the many side is its model\'s whole key and the other end is certainly not a key', () => {
    expect(keysContradictionWarning(rel, MODELS)).toMatch(/^dim_customer\.customer_key is dim_customer's key, so each value appears only once/);
  });
  it('names dbt\'s test when the many end\'s evidence came from dbt', () => {
    const tested = [
      { name: 'dim_customer', columns: [{ ...col('customer_key'), dbtKey: { key: 'unique' as const, because: 'unique-test' as const } }] },
      { name: 'fct_order', columns: [{ ...col('customer_key'), dbtKey: { key: 'not-unique' as const, because: 'relationships-test' as const } }] },
    ];
    expect(keysContradictionWarning(rel, tested)).toMatch(/^dbt tests dim_customer\.customer_key as unique, so each value appears only once/);
  });
  it('says nothing the other way round, for a one-to-one, or without a key on the other end', () => {
    expect(keysContradictionWarning({ ...rel, fromModel: 'fct_order', toModel: 'dim_customer' }, MODELS)).toBeNull();
    expect(keysContradictionWarning({ ...rel, cardinality: 'one-to-one' }, MODELS)).toBeNull();
    expect(keysContradictionWarning(rel, [MODELS[0], { name: 'fct_order', columns: [col('customer_key')] }])).toBeNull();
  });
});
