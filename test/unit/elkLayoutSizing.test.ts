import { describe, it, expect } from 'vitest';
import {
  countVisibleColumnRows,
  estimateNodeHeight,
  estimateNodeWidth,
  resolveNodeDimensions,
  toElkChildren,
} from '../../webview/lib/elkLayout';
import { COLLAPSED_COLUMN_LIMIT } from '../../webview/hooks/useColumnExpansion';
import type { ModelFlowNode, ColumnDisplay } from '../../webview/types/graph';

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

describe('toElkChildren', () => {
  it('uses measured size when present and the collapse-aware estimate otherwise', () => {
    const measured = { ...node(cols(60), {}, { width: 300, height: 180 }), id: 'measured' };
    const unmeasured = { ...node(cols(60)), id: 'unmeasured' };
    const children = toElkChildren([measured, unmeasured], null);
    expect(children[0]).toMatchObject({ id: 'measured', width: 300, height: 180 });
    expect(children[1].height).toBe(estimateNodeHeight(COLLAPSED_COLUMN_LIMIT + 1, false));
    expect(children[1].layoutOptions).toBeUndefined();
  });

  it('adds partition layout options when partitions are provided', () => {
    const children = toElkChildren([{ ...node(cols(1)), id: 'a' }], new Map([['a', 3]]));
    expect(children[0].layoutOptions).toEqual({ 'elk.partitioning.partition': '3' });
  });
});
