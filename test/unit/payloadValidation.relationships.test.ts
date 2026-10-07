/**
 * Relationship payload validators (issue #133): the four ends, the optional
 * `stored` ends and `markKey`, and the no-payload `repairRelationships`.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidRelationshipEnds,
  validateMarkKey,
  validateRepairRelationshipsPayload,
  validateStoredEnds,
} from '../../src/providers/payloadValidation';

const ENDS = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };

describe('isValidRelationshipEnds', () => {
  it('accepts four text ends, in any case dbt allows', () => {
    expect(isValidRelationshipEnds(ENDS)).toBe(true);
    expect(isValidRelationshipEnds({ ...ENDS, fromModel: 'DimDate', toColumn: '2nd_key' })).toBe(true);
  });
  it.each([
    ['null', null],
    ['an array', [ENDS]],
    ['a missing end', { ...ENDS, toColumn: undefined }],
    ['a blank end', { ...ENDS, fromColumn: '  ' }],
    ['a number', { ...ENDS, toModel: 7 }],
    ['a NUL', { ...ENDS, toModel: 'a\0b' }],
    ['an over-long name', { ...ENDS, fromModel: 'x'.repeat(257) }],
  ])('refuses %s', (_label, value) => {
    expect(isValidRelationshipEnds(value)).toBe(false);
  });
});

describe('validateStoredEnds', () => {
  it('is optional', () => expect(validateStoredEnds(undefined)).toBeNull());
  it('accepts four ends', () => expect(validateStoredEnds(ENDS)).toBeNull());
  it('refuses anything else', () => {
    expect(validateStoredEnds({ fromModel: 'a' })).toBe('The stored ends of the relationship are not valid.');
    expect(validateStoredEnds('fct_order')).not.toBeNull();
  });
});

describe('validateMarkKey', () => {
  it('is optional', () => expect(validateMarkKey(undefined)).toBeNull());
  it('accepts a model and a column', () => expect(validateMarkKey({ model: 'dim_customer', column: 'customer_key' })).toBeNull());
  it.each([
    ['a string', 'dim_customer.customer_key'],
    ['a missing column', { model: 'dim_customer' }],
    ['a blank model', { model: '', column: 'x' }],
    ['an extra key', { model: 'm', column: 'c', value: true }],
  ])('refuses %s', (_label, value) => {
    expect(validateMarkKey(value)).toBe('The key to mark must name a model and a column.');
  });
});

describe('validateRepairRelationshipsPayload', () => {
  it('takes nothing', () => {
    expect(validateRepairRelationshipsPayload(undefined)).toBeNull();
    expect(validateRepairRelationshipsPayload({})).toBeNull();
    expect(validateRepairRelationshipsPayload({ apply: true })).toBe('Repair Relationships takes no payload.');
    expect(validateRepairRelationshipsPayload('go')).toBe('Repair Relationships takes no payload.');
  });
});
