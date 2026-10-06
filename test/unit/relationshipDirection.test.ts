/**
 * A dragged relationship points from the column that refers to a key at the
 * key (issue #133), so the drag that starts on a dimension's key still opens
 * the dialog with the fact as "from" — the many side, which stores it.
 */

import { describe, it, expect } from 'vitest';

import { isReferencedKey, orientDraggedRelationship } from '../../webview/lib/relationshipDirection';

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
    )).toEqual({ fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' });
  });

  it('turns a drag from a natural key round too', () => {
    expect(orientDraggedRelationship(
      { fromModel: 'dim_customer', fromColumn: 'customer_code', toModel: 'fct_order', toColumn: 'customer_key' },
      MODELS,
    ).fromModel).toBe('fct_order');
  });

  it('leaves a drag that already starts on the referring column alone', () => {
    const prefill = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
    expect(orientDraggedRelationship(prefill, MODELS)).toBe(prefill);
  });

  it('leaves key-to-key drags as drawn (one-to-one: the user decides)', () => {
    const prefill = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'order_key' };
    expect(orientDraggedRelationship(prefill, MODELS)).toBe(prefill);
  });

  it('treats a bridge key that is also a foreign key as the referring end', () => {
    expect(orientDraggedRelationship(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'brg_account_customer', toColumn: 'customer_key' },
      MODELS,
    ).fromModel).toBe('brg_account_customer');
    expect(isReferencedKey(col('k', { pk: true, fk: true }))).toBe(false);
  });

  it('leaves a drag with no target column, or unknown columns, alone', () => {
    const noTarget = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order' };
    expect(orientDraggedRelationship(noTarget, MODELS)).toBe(noTarget);
    const unknown = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'nope' };
    expect(orientDraggedRelationship(unknown, MODELS)).toBe(unknown);
  });
});
