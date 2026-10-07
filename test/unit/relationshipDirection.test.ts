/**
 * A dragged relationship points from the column that refers to a key at the
 * key (issue #133), so the drag that starts on a dimension's key still opens
 * the dialog with the fact as "from" — the many side, which stores it. The
 * webview helper is a thin wrapper over core's `resolveDirection`: it turns a
 * drag round only on certain or likely evidence, and reads only the
 * *declared* foreign-key flag, never the FK badge relationships set (D2).
 */

import { describe, it, expect } from 'vitest';

import {
  directionFor,
  isReferencedKey,
  orientDrag,
  orientDraggedRelationship,
} from '../../webview/lib/relationshipDirection';

/** `fk` is a foreign key the model file declares (the badge is set too, as the host does). */
const col = (name: string, keys: { pk?: boolean; nk?: boolean; fk?: boolean; badge?: boolean } = {}) => ({
  name, dataType: 'string', description: '',
  isPrimaryKey: keys.pk ?? false, isNaturalKey: keys.nk ?? false,
  isForeignKey: (keys.fk || keys.badge) ?? false,
  ...(keys.fk ? { isForeignKeyDeclared: true } : {}),
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

describe('orientDrag — evidence, never drag order (#133)', () => {
  it('reports that it turned a drag round, and why', () => {
    const { prefill, turned, verdict } = orientDrag(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_daily', toColumn: 'customer_key' },
      [...MODELS, FCT_GRAIN],
    );
    expect(turned).toBe(true);
    expect(prefill.fromModel).toBe('fct_daily');
    expect(verdict?.confidence).toBe('certain');
    expect(verdict?.reasons.join(' ')).toMatch(/primary key/);
  });

  it('a likely verdict (one end unknown) still turns the drag round', () => {
    const { turned, verdict } = orientDrag(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      MODELS,
    );
    expect(turned).toBe(true);
    expect(verdict?.confidence).toBe('likely');
  });

  it('an ambiguous drag (no keys at all) is left as dragged, whichever end it starts on', () => {
    const plain = [
      { name: 'a', columns: [col('x')] },
      { name: 'b', columns: [col('y')] },
    ];
    const ab = orientDrag({ fromModel: 'a', fromColumn: 'x', toModel: 'b', toColumn: 'y' }, plain);
    const ba = orientDrag({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' }, plain);
    expect(ab.turned).toBe(false);
    expect(ba.turned).toBe(false);
    expect(ab.verdict?.confidence).toBe('ambiguous');
    // The verdict itself does not depend on which end the drag started on.
    expect(ab.verdict).toEqual(ba.verdict);
  });

  it('the FK badge alone is not evidence (D2): a wrongly drawn relationship cannot confirm itself', () => {
    // dim_customer.customer_key carries the FK badge only because some
    // relationship was drawn from it; it is still the dimension's whole key.
    const models = [
      { name: 'dim_customer', columns: [col('customer_key', { pk: true, badge: true })] },
      { name: 'fct_order', columns: [col('order_key', { pk: true }), col('customer_key')] },
    ];
    const { prefill, turned } = orientDrag(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      models,
    );
    expect(turned).toBe(true);
    expect(prefill.fromModel).toBe('fct_order');
    expect(isReferencedKey({ isPrimaryKey: true, isNaturalKey: false })).toBe(true);
  });

  it('dbt evidence decides when keys say nothing (likely)', () => {
    const models = [
      { name: 'customers', columns: [{ ...col('id'), dbtEvidence: { unique: true } }] },
      { name: 'orders', columns: [{ ...col('customer_id'), dbtEvidence: { relationshipsTest: true } }] },
    ];
    const verdict = directionFor(models, { fromModel: 'customers', fromColumn: 'id', toModel: 'orders', toColumn: 'customer_id' });
    expect(verdict?.confidence).toBe('likely');
    expect(verdict?.from.model).toBe('orders');
    expect(orientDraggedRelationship(
      { fromModel: 'customers', fromColumn: 'id', toModel: 'orders', toColumn: 'customer_id' },
      models,
    ).fromModel).toBe('orders');
  });

  it('keys and dbt disagreeing is ambiguous with a conflict, and the drag is left alone', () => {
    const models = [
      { name: 'dim_customer', columns: [{ ...col('customer_key', { pk: true }), dbtEvidence: { unique: false } }] },
      { name: 'fct_order', columns: [col('customer_key')] },
    ];
    const { turned, verdict } = orientDrag(
      { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      models,
    );
    expect(verdict?.confidence).toBe('ambiguous');
    expect(verdict?.conflict).toBe(true);
    expect(turned).toBe(false);
  });

  it('finds models without case', () => {
    expect(directionFor(MODELS, { fromModel: 'DIM_CUSTOMER', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' }))
      .toBeDefined();
  });
});

describe('orientDrag — models whose names differ only in case (#133 review 6)', () => {
  it('turns a drag from Dd.id to DD.id round when DD is the many side', () => {
    const models = [
      { name: 'Dd', columns: [col('id', { pk: true })] },
      { name: 'DD', columns: [col('k', { pk: true }), col('id', { fk: true })] },
    ];
    const oriented = orientDrag({ fromModel: 'Dd', fromColumn: 'id', toModel: 'DD', toColumn: 'id' }, models);
    expect(oriented.verdict?.from).toEqual({ model: 'DD', column: 'id' });
    expect(oriented.turned).toBe(true);
    expect(oriented.prefill).toMatchObject({ fromModel: 'DD', toModel: 'Dd' });
    // Already the right way round: left alone.
    expect(orientDrag({ fromModel: 'DD', fromColumn: 'id', toModel: 'Dd', toColumn: 'id' }, models).turned).toBe(false);
  });
});
