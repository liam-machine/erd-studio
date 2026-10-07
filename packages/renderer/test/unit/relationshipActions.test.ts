/**
 * The relationship messages every canvas surface shares (#133): the drawn
 * ends plus the stored ends, and ⇄ chosen by cardinality.
 */
import { describe, it, expect } from 'vitest';
import {
  edgeIssues,
  edgeIssueTitle,
  relationshipStoredIn,
  relationshipSwap,
  relationshipTarget,
  removeRelationshipRequest,
  updateCardinalityRequest,
} from '../../src/lib/relationshipActions';

const DRAWN = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
const STORED = { fromModel: 'FCT_ORDER', fromColumn: 'Customer_Key', toModel: 'dim_customer', toColumn: 'customer_key' };

describe('relationshipTarget', () => {
  it('carries only the four ends, plus the stored ends when known', () => {
    expect(relationshipTarget({ ...DRAWN, stored: { ...STORED, cardinality: 'x' } as never })).toEqual({ ...DRAWN, stored: STORED });
    expect(relationshipTarget(DRAWN)).toEqual(DRAWN);
    expect(Object.keys(relationshipTarget(DRAWN))).not.toContain('stored');
  });
});

describe('update / remove requests', () => {
  it('update keeps the drawn ends and adds the stored ones', () => {
    expect(updateCardinalityRequest({ ...DRAWN, cardinality: 'many-to-one', stored: STORED }, 'one-to-one')).toEqual({
      type: 'updateRelationship',
      payload: { ...DRAWN, stored: STORED, cardinality: 'one-to-one' },
    });
  });
  it('remove carries the stored ends', () => {
    expect(removeRelationshipRequest({ ...DRAWN, stored: STORED })).toEqual({
      type: 'removeRelationship',
      payload: { ...DRAWN, stored: STORED },
    });
  });
});

describe('relationshipSwap', () => {
  it('many-to-one flips the many side via updateRelationship', () => {
    const swap = relationshipSwap({ ...DRAWN, cardinality: 'many-to-one' });
    expect(swap.title).toBe('Make dim_customer the many side');
    expect(swap.request).toEqual({ type: 'updateRelationship', payload: { ...DRAWN, cardinality: 'one-to-many' } });
  });
  it('a one-to-many (read-only legacy) names its from model as the next many side', () => {
    expect(relationshipSwap({ ...DRAWN, cardinality: 'one-to-many' }).title).toBe('Make fct_order the many side');
  });
  it('one-to-one and many-to-many swap the ends with the role kept', () => {
    for (const cardinality of ['one-to-one', 'many-to-many'] as const) {
      const swap = relationshipSwap({ ...DRAWN, cardinality, role: 'ship date', stored: STORED });
      expect(swap.request).toEqual({
        type: 'editRelationship',
        payload: {
          originalFromModel: 'fct_order', originalFromColumn: 'customer_key',
          originalToModel: 'dim_customer', originalToColumn: 'customer_key',
          fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
          cardinality, role: 'ship date', stored: STORED,
        },
      });
    }
  });
  it('a swap without a role sends an empty role (nothing to clear)', () => {
    const swap = relationshipSwap({ ...DRAWN, cardinality: 'one-to-one' });
    expect(swap.request.type).toBe('editRelationship');
    expect((swap.request.payload as { role: string }).role).toBe('');
  });
});

describe('edge issues', () => {
  it('keeps only the badge codes, in code order', () => {
    expect(edgeIssues(['REL006', 'REL009', 'REL001', 'REL003'])).toEqual(['REL001', 'REL006']);
    expect(edgeIssues(undefined)).toEqual([]);
  });
  it('titles list one line per code', () => {
    const title = edgeIssueTitle(['REL001', 'REL002']);
    expect(title.split('\n')).toHaveLength(3);
    expect(title).toContain('REL002');
  });
  it('on an older-format (v4) diagram, never promises what Repair Relationships… does not do there', () => {
    const title = edgeIssueTitle(['REL001'], { olderFormat: true });
    expect(title).not.toContain('Repair Relationships… keeps one copy');
    expect(title).toContain('Migrate Domains to Central Model Store');
    // Edit / ⇄ keep one copy only when the copies agree: a commit refuses copies that disagree (#133 review).
    expect(title).not.toContain('or use Edit or ⇄ on the line, which keeps one copy');
    expect(title).toContain('only when every copy says the same — copies that disagree are refused there');
    expect(edgeIssueTitle(['REL006'], { olderFormat: true })).toBe(edgeIssueTitle(['REL006']));
  });
});

describe('relationshipStoredIn', () => {
  const domain = { layer: 'gold', domain: 'sales' };
  it('names the model file or this diagram', () => {
    expect(relationshipStoredIn({ kind: 'library', model: 'fct_order', index: 0 }, domain)).toBe('fct_order.yml (model library)');
    expect(relationshipStoredIn({ kind: 'domain', index: 2 }, domain)).toBe('gold/sales.json (this diagram)');
    expect(relationshipStoredIn(undefined, domain)).toBeUndefined();
  });
});
