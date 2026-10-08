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
