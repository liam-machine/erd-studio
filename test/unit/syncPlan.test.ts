import { describe, it, expect } from 'vitest';
import {
  deriveModelAction,
  deriveColumnAction,
  deriveRelationshipAction,
  modelKey,
  columnKey,
  relationshipKey,
} from '../../src/types/syncPlan';

describe('syncPlan — selection keys', () => {
  it('modelKey builds "model:{name}"', () => {
    expect(modelKey('dim_customer')).toBe('model:dim_customer');
  });

  it('columnKey builds "col:{model}:{column}"', () => {
    expect(columnKey('dim_customer', 'email')).toBe('col:dim_customer:email');
  });

  it('relationshipKey builds "rel:{from}:{fromCol}:{to}:{toCol}"', () => {
    expect(relationshipKey('fct_sale', 'customer_id', 'dim_customer', 'customer_id'))
      .toBe('rel:fct_sale:customer_id:dim_customer:customer_id');
  });
});

describe('syncPlan — deriveModelAction', () => {
  describe('sourceStage = logical', () => {
    it('extra + logical truth = no-op (null)', () => {
      expect(deriveModelAction('extra', 'logical', 'logical')).toBeNull();
    });

    it('extra + physical truth = remove-from-logical', () => {
      expect(deriveModelAction('extra', 'physical', 'logical')).toBe('remove-from-logical');
    });

    it('missing + logical truth = remove-from-physical', () => {
      expect(deriveModelAction('missing', 'logical', 'logical')).toBe('remove-from-physical');
    });

    it('missing + physical truth = add-to-logical', () => {
      expect(deriveModelAction('missing', 'physical', 'logical')).toBe('add-to-logical');
    });
  });

  describe('sourceStage = physical', () => {
    it('extra + physical truth = no-op (null)', () => {
      expect(deriveModelAction('extra', 'physical', 'physical')).toBeNull();
    });

    it('extra + logical truth = remove-from-physical', () => {
      expect(deriveModelAction('extra', 'logical', 'physical')).toBe('remove-from-physical');
    });

    it('missing + physical truth = remove-from-logical', () => {
      expect(deriveModelAction('missing', 'physical', 'physical')).toBe('remove-from-logical');
    });

    it('missing + logical truth = add-to-physical', () => {
      expect(deriveModelAction('missing', 'logical', 'physical')).toBe('add-to-physical');
    });
  });
});

describe('syncPlan — deriveColumnAction', () => {
  describe('type-mismatch (stage-independent)', () => {
    it('logical truth = update-type-in-physical', () => {
      expect(deriveColumnAction('type-mismatch', 'logical', 'logical')).toBe('update-type-in-physical');
    });

    it('physical truth = update-type-in-logical', () => {
      expect(deriveColumnAction('type-mismatch', 'physical', 'logical')).toBe('update-type-in-logical');
    });
  });

  describe('sourceStage = logical', () => {
    it('extra + logical truth = add-column-to-physical', () => {
      expect(deriveColumnAction('extra', 'logical', 'logical')).toBe('add-column-to-physical');
    });

    it('extra + physical truth = remove-column-from-logical', () => {
      expect(deriveColumnAction('extra', 'physical', 'logical')).toBe('remove-column-from-logical');
    });

    it('missing + logical truth = remove-column-from-physical', () => {
      expect(deriveColumnAction('missing', 'logical', 'logical')).toBe('remove-column-from-physical');
    });

    it('missing + physical truth = add-column-to-logical', () => {
      expect(deriveColumnAction('missing', 'physical', 'logical')).toBe('add-column-to-logical');
    });
  });

  describe('sourceStage = physical', () => {
    it('extra + physical truth = add-column-to-logical', () => {
      expect(deriveColumnAction('extra', 'physical', 'physical')).toBe('add-column-to-logical');
    });

    it('extra + logical truth = remove-column-from-physical', () => {
      expect(deriveColumnAction('extra', 'logical', 'physical')).toBe('remove-column-from-physical');
    });

    it('missing + physical truth = remove-column-from-logical', () => {
      expect(deriveColumnAction('missing', 'physical', 'physical')).toBe('remove-column-from-logical');
    });

    it('missing + logical truth = add-column-to-physical', () => {
      expect(deriveColumnAction('missing', 'logical', 'physical')).toBe('add-column-to-physical');
    });
  });
});

describe('syncPlan — deriveRelationshipAction', () => {
  describe('cardinality-mismatch (stage-independent)', () => {
    it('logical truth = update-cardinality-in-physical', () => {
      expect(deriveRelationshipAction('cardinality-mismatch', 'logical', 'logical'))
        .toBe('update-cardinality-in-physical');
    });

    it('physical truth = update-cardinality-in-logical', () => {
      expect(deriveRelationshipAction('cardinality-mismatch', 'physical', 'logical'))
        .toBe('update-cardinality-in-logical');
    });
  });

  describe('sourceStage = logical', () => {
    it('extra + logical truth = add-relationship-test-to-physical', () => {
      expect(deriveRelationshipAction('extra', 'logical', 'logical'))
        .toBe('add-relationship-test-to-physical');
    });

    it('extra + physical truth = remove-relationship-from-logical', () => {
      expect(deriveRelationshipAction('extra', 'physical', 'logical'))
        .toBe('remove-relationship-from-logical');
    });

    it('missing + logical truth = remove-relationship-test-from-physical', () => {
      expect(deriveRelationshipAction('missing', 'logical', 'logical'))
        .toBe('remove-relationship-test-from-physical');
    });

    it('missing + physical truth = add-relationship-to-logical', () => {
      expect(deriveRelationshipAction('missing', 'physical', 'logical'))
        .toBe('add-relationship-to-logical');
    });
  });

  describe('sourceStage = physical', () => {
    it('extra + physical truth = add-relationship-to-logical', () => {
      expect(deriveRelationshipAction('extra', 'physical', 'physical'))
        .toBe('add-relationship-to-logical');
    });

    it('extra + logical truth = remove-relationship-test-from-physical', () => {
      expect(deriveRelationshipAction('extra', 'logical', 'physical'))
        .toBe('remove-relationship-test-from-physical');
    });

    it('missing + physical truth = remove-relationship-from-logical', () => {
      expect(deriveRelationshipAction('missing', 'physical', 'physical'))
        .toBe('remove-relationship-from-logical');
    });

    it('missing + logical truth = add-relationship-test-to-physical', () => {
      expect(deriveRelationshipAction('missing', 'logical', 'physical'))
        .toBe('add-relationship-test-to-physical');
    });
  });
});
