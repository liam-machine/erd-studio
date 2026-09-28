import { describe, expect, it } from 'vitest';

import { DESCRIPTION_TERMS, detectConventions, mentions, vaultKindOf, type ConventionModel } from '../../src/cli/conventions';

const term = (label: string) => DESCRIPTION_TERMS.find((t) => t.label === label)!.re;

function m(name: string, extra: Partial<ConventionModel> = {}): ConventionModel {
  return { name, kind: 'model', folder: ['marts'], schema: '', columnCount: 3, ...extra };
}

describe('mentions — negated description terms', () => {
  it.each([
    ['no surrogate key is needed', 'surrogate key'],
    ['There is no surrogate key here.', 'surrogate key'],
    ['This is not a fact table.', 'fact table'],
    ['not a fact', 'fact'],
    ['Built without a surrogate key', 'surrogate key'],
    ['no hash key', 'hash key'],
    ['Never a dimension of anything.', 'dimension'],
    ["This isn't a dimension.", 'dimension'],
    ['These aren’t satellites', 'satellite'],
    ["We don't use a hub table here", 'hub'],
    ['Not in 3NF', '3NF'],
    ['not in third normal form', 'third normal form'],
  ])('%j does not count as %s', (text, label) => {
    expect(mentions(term(label), text)).toBe(false);
  });

  it.each([
    ['This is the customer dimension', 'dimension'],
    ['Order fact — one row per order.', 'fact'],
    ['Uses a surrogate key.', 'surrogate key'],
    ['Hub table for customers', 'hub'],
    ['The satellite carries customer attributes', 'satellite'],
    ['Modelled in 3NF', '3NF'],
    // A negation in an earlier sentence does not reach across punctuation.
    ['Not a staging model. The customer dimension.', 'dimension'],
    // A negation too far back (more than two words between) does not apply.
    ['No nulls allowed in this conformed customer dimension', 'dimension'],
    // One negated mention does not hide a later plain one.
    ['Not a fact table on its own; joins to the order fact table.', 'fact table'],
  ])('%j counts as %s', (text, label) => {
    expect(mentions(term(label), text)).toBe(true);
  });

  it('does not treat words that merely contain "no"/"not" as negators', () => {
    expect(mentions(term('dimension'), 'Nothing but the customer dimension')).toBe(true);
    expect(mentions(term('dimension'), 'Notes: customer dimension')).toBe(true);
  });
});

describe('detectConventions — negated wording is not evidence', () => {
  it('a surrogate key "not needed" does not support Kimball', () => {
    const c = detectConventions({
      models: [m('orders', { description: 'Orders, not a fact table.', columns: [{ name: 'id', description: 'no surrogate key is needed' }] })],
      packages: [],
      snapshots: [],
    });
    expect(c.shape.style).toBe('none');
  });

  it('plain wording still counts', () => {
    const c = detectConventions({
      models: [m('customers', { description: 'This is the customer dimension.' }), m('orders', { description: 'Order fact table.' })],
      packages: [],
      snapshots: [],
    });
    expect(c.shape.style).toBe('kimball');
    expect(c.shape.evidence.join(' ')).toContain('dimension');
  });

  it('a column described as "no hash key" is not a hash key', () => {
    const cols = [
      { name: 'customer_ref', description: 'no hash key — natural id' },
      { name: 'load_date' },
      { name: 'record_source' },
    ];
    expect(vaultKindOf(m('x', { columns: cols }))).toBeNull();
  });
});
