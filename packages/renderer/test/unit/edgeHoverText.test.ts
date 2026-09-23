/**
 * edgeHoverText — the hover text on a relationship line.
 *
 * A relationship's cardinality glyphs are `pointer-events: none`, so the line
 * is the only part of an edge that can carry an explanation. During a
 * comparison the line's *colour* is the whole message, which is no message at
 * all to someone who cannot tell amber from red.
 */
import { describe, it, expect } from 'vitest';
import { edgeHoverText, DISCREPANCY_PHRASE } from '../../src/lib/badgeLabels';

const base = {
  fromModel: 'fct_order',
  fromColumn: 'customer_key',
  toModel: 'dim_customer',
  toColumn: 'customer_key',
  cardinality: 'many-to-one',
};

describe('edgeHoverText', () => {
  it('names both endpoints and reads the cardinality as words', () => {
    expect(edgeHoverText(base)).toBe(
      'fct_order.customer_key → dim_customer.customer_key · many to one',
    );
  });

  it('adds nothing when there is no comparison running', () => {
    expect(edgeHoverText(base)).not.toContain('· only');
  });

  it('says in words what each discrepancy colour means', () => {
    for (const status of ['extra', 'missing', 'cardinality-mismatch'] as const) {
      expect(edgeHoverText({ ...base, discrepancyStatus: status }))
        .toContain(DISCREPANCY_PHRASE[status]);
    }
  });

  it('keeps the endpoints readable for a self-referencing relationship', () => {
    expect(edgeHoverText({
      ...base,
      fromModel: 'dim_project',
      fromColumn: 'parent_project_id',
      toModel: 'dim_project',
      toColumn: 'project_id',
    })).toBe('dim_project.parent_project_id → dim_project.project_id · many to one');
  });
});
