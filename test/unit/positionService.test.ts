import { describe, it, expect } from 'vitest';
import {
  computeNewModelPositions,
  findOpenPosition,
  NODE_WIDTH,
  NODE_HEIGHT,
  PADDING,
} from '../../src/services/positionService';
import type { Relationship, NodePosition } from '../../src/types/semantic';

const CELL_WIDTH = NODE_WIDTH + PADDING;
const CELL_HEIGHT = NODE_HEIGHT + PADDING;

/** Check that two positions don't overlap (within one cell). */
function assertNoOverlap(positions: Record<string, NodePosition>): void {
  const entries = Object.entries(positions);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, a] = entries[i];
      const [nameB, b] = entries[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      expect(
        dx >= CELL_WIDTH || dy >= CELL_HEIGHT,
        `${nameA} (${a.x},${a.y}) overlaps ${nameB} (${b.x},${b.y})`,
      ).toBe(true);
    }
  }
}

describe('positionService', () => {
  describe('computeNewModelPositions', () => {
    it('places first model at (100, 100) in empty domain', () => {
      const result = computeNewModelPositions({
        newModels: ['dim_customer'],
        relationships: [],
        existingPositions: {},
      });

      expect(result).toHaveProperty('dim_customer');
      expect(result.dim_customer).toEqual({ x: 100, y: 100 });
    });

    it('does not modify existing positions in output', () => {
      const existing = { dim_customer: { x: 100, y: 100 } };
      const result = computeNewModelPositions({
        newModels: ['fct_orders'],
        relationships: [],
        existingPositions: existing,
      });

      // Result should only contain the new model
      expect(result).not.toHaveProperty('dim_customer');
      expect(result).toHaveProperty('fct_orders');
      // Original object unchanged
      expect(existing).toEqual({ dim_customer: { x: 100, y: 100 } });
    });

    it('places orphan model via grid scan (no relationships)', () => {
      const existing = { dim_customer: { x: 100, y: 100 } };
      const result = computeNewModelPositions({
        newModels: ['dim_product'],
        relationships: [],
        existingPositions: existing,
      });

      expect(result).toHaveProperty('dim_product');
      // Should not overlap with existing
      assertNoOverlap({ ...existing, ...result });
    });

    it('places model near related positioned model', () => {
      const existing: Record<string, NodePosition> = {
        dim_customer: { x: 100, y: 100 },
      };
      const relationships: Relationship[] = [
        {
          fromModel: 'fct_orders',
          fromColumn: 'customer_id',
          toModel: 'dim_customer',
          toColumn: 'customer_id',
          cardinality: 'many-to-one',
        },
      ];

      const result = computeNewModelPositions({
        newModels: ['fct_orders'],
        relationships,
        existingPositions: existing,
      });

      expect(result).toHaveProperty('fct_orders');
      // Should be within a few cells of dim_customer
      const pos = result.fct_orders;
      const dx = Math.abs(pos.x - 100);
      const dy = Math.abs(pos.y - 100);
      expect(dx + dy).toBeLessThan(CELL_WIDTH * 4 + CELL_HEIGHT * 4);
      assertNoOverlap({ ...existing, ...result });
    });

    it('handles batch of chained models with cascade positioning', () => {
      const existing: Record<string, NodePosition> = {
        dim_customer: { x: 100, y: 100 },
      };
      const relationships: Relationship[] = [
        {
          fromModel: 'fct_orders',
          fromColumn: 'customer_id',
          toModel: 'dim_customer',
          toColumn: 'customer_id',
          cardinality: 'many-to-one',
        },
        {
          fromModel: 'fct_line_items',
          fromColumn: 'order_id',
          toModel: 'fct_orders',
          toColumn: 'order_id',
          cardinality: 'many-to-one',
        },
      ];

      const result = computeNewModelPositions({
        newModels: ['fct_orders', 'fct_line_items'],
        relationships,
        existingPositions: existing,
      });

      expect(result).toHaveProperty('fct_orders');
      expect(result).toHaveProperty('fct_line_items');

      // All positions should be unique and non-overlapping
      assertNoOverlap({ ...existing, ...result });
    });

    it('prevents overlap with existing positions', () => {
      // Fill a few grid cells
      const existing: Record<string, NodePosition> = {
        model_a: { x: 100, y: 100 },
        model_b: { x: 100 + CELL_WIDTH, y: 100 },
        model_c: { x: 100 + CELL_WIDTH * 2, y: 100 },
      };

      const result = computeNewModelPositions({
        newModels: ['model_d'],
        relationships: [],
        existingPositions: existing,
      });

      assertNoOverlap({ ...existing, ...result });
    });

    it('handles multiple orphan models without overlap', () => {
      const result = computeNewModelPositions({
        newModels: ['model_a', 'model_b', 'model_c', 'model_d'],
        relationships: [],
        existingPositions: {},
      });

      expect(Object.keys(result)).toHaveLength(4);
      assertNoOverlap(result);
    });

    it('returns empty object for empty newModels array', () => {
      const result = computeNewModelPositions({
        newModels: [],
        relationships: [],
        existingPositions: { dim_customer: { x: 100, y: 100 } },
      });

      expect(result).toEqual({});
    });

    it('places model with multiple related positioned models near centroid', () => {
      const existing: Record<string, NodePosition> = {
        dim_customer: { x: 100, y: 100 },
        dim_product: { x: 100 + CELL_WIDTH * 4, y: 100 },
      };
      const relationships: Relationship[] = [
        {
          fromModel: 'fct_orders',
          fromColumn: 'customer_id',
          toModel: 'dim_customer',
          toColumn: 'customer_id',
          cardinality: 'many-to-one',
        },
        {
          fromModel: 'fct_orders',
          fromColumn: 'product_id',
          toModel: 'dim_product',
          toColumn: 'product_id',
          cardinality: 'many-to-one',
        },
      ];

      const result = computeNewModelPositions({
        newModels: ['fct_orders'],
        relationships,
        existingPositions: existing,
      });

      expect(result).toHaveProperty('fct_orders');
      assertNoOverlap({ ...existing, ...result });
    });
  });

  describe('findOpenPosition', () => {
    it('returns (100, 100) for empty positions', () => {
      expect(findOpenPosition({})).toEqual({ x: 100, y: 100 });
    });

    it('finds next open cell avoiding existing positions', () => {
      const existing = { model_a: { x: 100, y: 100 } };
      const pos = findOpenPosition(existing);
      expect(pos).not.toEqual({ x: 100, y: 100 });
      assertNoOverlap({ ...existing, new_model: pos });
    });
  });
});
