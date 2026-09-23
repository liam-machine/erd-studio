import { describe, it, expect } from 'vitest';
import {
  countVisibleColumnRows,
  estimateNodeHeight,
  estimateNodeWidth,
  resolveNodeDimensions,
} from '../../src/lib/nodeSizing';
import { COLLAPSED_COLUMN_LIMIT } from '../../src/hooks/useColumnExpansion';
import type { ModelFlowNode, ColumnDisplay } from '../../src/types/graph';

function cols(n: number, keyEvery = 0): ColumnDisplay[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `c${i}`,
    dataType: 'string',
    isPrimaryKey: i === 0,
    isForeignKey: false,
    isNaturalKey: keyEvery > 0 && i > 0 && i % keyEvery === 0,
  }));
}

function node(columns: ColumnDisplay[], extra: Partial<ModelFlowNode['data']> = {}, measured?: { width: number; height: number }): ModelFlowNode {
  return {
    id: 'n',
    type: 'model',
    position: { x: 0, y: 0 },
    ...(measured ? { measured } : {}),
    data: { modelName: 'n', stage: 'logical', layer: 'silver', columns, isStub: false, ...extra },
  };
}

describe('countVisibleColumnRows', () => {
  it('shows every column when under the collapse limit', () => {
    expect(countVisibleColumnRows({ columns: cols(3), isStub: false })).toBe(3);
  });

  it('collapses to the limit plus the "...and N more" row', () => {
    expect(countVisibleColumnRows({ columns: cols(60), isStub: false })).toBe(COLLAPSED_COLUMN_LIMIT + 1);
  });

  it('shows all columns plus the "Show less" row when expanded', () => {
    expect(countVisibleColumnRows({ columns: cols(60), isStub: false, isExpanded: true })).toBe(61);
    expect(countVisibleColumnRows({ columns: cols(3), isStub: false, isExpanded: true })).toBe(3);
  });

  it('counts only PK/NK columns for stub models', () => {
    // 1 PK + NKs at 5,10,15,20 → 5 key columns (≤ limit, no button row)
    expect(countVisibleColumnRows({ columns: cols(21, 5), isStub: true })).toBe(5);
  });
});

describe('resolveNodeDimensions', () => {
  it('prefers React Flow measured dimensions', () => {
    expect(resolveNodeDimensions(node(cols(60), {}, { width: 333, height: 444 }))).toEqual({ width: 333, height: 444 });
  });

  it('estimates from visible rows when unmeasured', () => {
    const collapsed = resolveNodeDimensions(node(cols(60)));
    const expanded = resolveNodeDimensions(node(cols(60), { isExpanded: true }));
    expect(collapsed.height).toBe(estimateNodeHeight(COLLAPSED_COLUMN_LIMIT + 1, false));
    expect(expanded.height).toBe(estimateNodeHeight(61, false));
    expect(expanded.height).toBeGreaterThan(collapsed.height + 1000);
    expect(collapsed.width).toBe(estimateNodeWidth(node(cols(60)).data));
  });

  it('adds the grain row to the estimate', () => {
    const plain = resolveNodeDimensions(node(cols(2)));
    const grain = resolveNodeDimensions(node(cols(2), { grain: 'One row per order' }));
    expect(grain.height).toBeGreaterThan(plain.height);
  });
});

describe('estimateNodeWidth', () => {
  it('reserves room for the provenance chip so it cannot crowd the title', () => {
    // A long name keeps the header, not a column row, as the widest term —
    // otherwise the extra 30px is absorbed by the clamp and proves nothing.
    const columns = cols(1);
    const plain = estimateNodeWidth({ modelName: 'fct_order_line_item_daily_snapshot', columns });
    const withChip = estimateNodeWidth({
      modelName: 'fct_order_line_item_daily_snapshot',
      columns,
      provenance: { columns: ['catalog'], types: 'catalog' },
    });
    expect(withChip).toBeGreaterThan(plain);
  });

  it('leaves the estimate alone for a logical node, which has no chip', () => {
    const columns = cols(1);
    expect(estimateNodeWidth({ modelName: 'dim_customer', columns }))
      .toBe(estimateNodeWidth({ modelName: 'dim_customer', columns, provenance: undefined }));
  });
});
