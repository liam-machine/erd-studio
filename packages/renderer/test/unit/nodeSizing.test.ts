import { describe, it, expect } from 'vitest';
import {
  countVisibleColumnRows,
  isBareTableBody,
  estimateNodeHeight,
  estimateNodeWidth,
  resolveNodeDimensions,
} from '../../src/lib/nodeSizing';
import { COLLAPSED_COLUMN_LIMIT } from '../../src/hooks/useColumnExpansion';
import type { TableFlowNode, ColumnDisplay } from '../../src/types/graph';

function cols(n: number, keyEvery = 0): ColumnDisplay[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `c${i}`,
    dataType: 'string',
    isPrimaryKey: i === 0,
    isForeignKey: false,
    isNaturalKey: keyEvery > 0 && i > 0 && i % keyEvery === 0,
  }));
}

function node(columns: ColumnDisplay[], extra: Partial<TableFlowNode['data']> = {}, measured?: { width: number; height: number }): TableFlowNode {
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

  it('reserves room for the schema prefix with or without a known layer (physical, YAML)', () => {
    const columns = cols(1);
    const name = 'fct_order_line_item_daily_snapshot';
    const plain = estimateNodeWidth({ modelName: name, columns });
    const prefixed = estimateNodeWidth({ modelName: name, columns, shownSchema: 'analytics_gold' });
    expect(prefixed).toBeGreaterThan(plain);
    expect(estimateNodeWidth({ modelName: name, columns, shownSchema: 'analytics_gold', tableLayer: 'gold' })).toBe(prefixed);
  });

  it('gives back the badge\'s width in a single-layer project, which draws none', () => {
    const columns = cols(1);
    const name = 'fct_order_line_item_daily_snapshot';
    expect(estimateNodeWidth({ modelName: name, columns, singleLayer: true }))
      .toBeLessThan(estimateNodeWidth({ modelName: name, columns }));
  });
});

describe('node sizing at a table detail level', () => {
  // c0 is the PK; with keyEvery = 4, c4 and c8 are natural keys.
  const twelve = cols(12, 4);

  it('counts no rows at name (the footer is the button), the keys plus the button at keys, every column at all', () => {
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'name' })).toBe(0);
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'keys' })).toBe(3 + 1);
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'all' })).toBe(12);
  });

  it('counts every column plus the way back for a table opened on its own', () => {
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'keys', isExpanded: true })).toBe(13);
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'name', isExpanded: true })).toBe(13);
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, tableDetail: 'all', isExpanded: true })).toBe(12);
  });

  it('counts a stub by its PK / NK rows, with no button at keys and all', () => {
    expect(countVisibleColumnRows({ columns: twelve, isStub: true, tableDetail: 'keys' })).toBe(3);
    expect(countVisibleColumnRows({ columns: twelve, isStub: true, tableDetail: 'all' })).toBe(3);
    expect(countVisibleColumnRows({ columns: twelve, isStub: true, tableDetail: 'name' })).toBe(0);
  });

  it('is unchanged for a caller that passes no level', () => {
    expect(countVisibleColumnRows({ columns: twelve, isStub: false })).toBe(COLLAPSED_COLUMN_LIMIT + 1);
    expect(countVisibleColumnRows({ columns: twelve, isStub: false, isExpanded: true })).toBe(13);
    expect(isBareTableBody({ columns: [], isStub: false })).toBe(false);
    expect(isBareTableBody({ columns: cols(3).map((c) => ({ ...c, isPrimaryKey: false })), isStub: true })).toBe(false);
  });

  it('knows a card with no body: every closed table at name, or a stub with no keys', () => {
    expect(isBareTableBody({ columns: [], isStub: false, tableDetail: 'name' })).toBe(true);
    expect(isBareTableBody({ columns: [], isStub: false, tableDetail: 'keys' })).toBe(false); // "No columns"
    expect(isBareTableBody({ columns: [], isStub: false, tableDetail: 'name', loadError: { kind: 'read' } })).toBe(false);
    expect(isBareTableBody({ columns: twelve, isStub: false, tableDetail: 'name' })).toBe(true); // the footer is the button
    expect(isBareTableBody({ columns: twelve, isStub: false, tableDetail: 'name', isExpanded: true })).toBe(false);
    expect(isBareTableBody({ columns: cols(3).map((c) => ({ ...c, isPrimaryKey: false })), isStub: false, tableDetail: 'keys' })).toBe(false); // the button row
    const noKeys = cols(3).map((c) => ({ ...c, isPrimaryKey: false }));
    expect(isBareTableBody({ columns: noKeys, isStub: true, tableDetail: 'all' })).toBe(true);
  });

  it('estimates a bare card as header and footer only', () => {
    const bare = estimateNodeHeight(0, false, true);
    expect(bare).toBeLessThan(estimateNodeHeight(0, false));
    expect(bare).toBeLessThan(estimateNodeHeight(1, false));
    expect(estimateNodeHeight(0, true, true)).toBeGreaterThan(bare);
    // The flag only matters with no rows.
    expect(estimateNodeHeight(4, false, true)).toBe(estimateNodeHeight(4, false));
  });

  it('resolveNodeDimensions gets shorter from all to keys to name', () => {
    const height = (extra: Partial<TableFlowNode['data']>) => resolveNodeDimensions(node(twelve, extra)).height;
    expect(height({ tableDetail: 'all' })).toBe(estimateNodeHeight(12, false));
    expect(height({ tableDetail: 'keys' })).toBe(estimateNodeHeight(4, false));
    expect(height({ tableDetail: 'name' })).toBe(estimateNodeHeight(0, false, true));
    expect(height({ tableDetail: 'name', isExpanded: true })).toBe(estimateNodeHeight(13, false));
    expect(resolveNodeDimensions(node([], { tableDetail: 'name' })).height).toBe(estimateNodeHeight(0, false, true));
    // A measured size still wins.
    expect(resolveNodeDimensions(node(twelve, { tableDetail: 'name' }, { width: 300, height: 77 }))).toEqual({ width: 300, height: 77 });
  });

  it('estimates the width from the rows drawn at a level, and from every column without one', () => {
    const wide: ColumnDisplay = { name: 'a_very_long_non_key_column_name_that_sets_the_width', dataType: 'timestamp_ntz', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false };
    const columns = [...cols(2), wide];
    const base = { modelName: 'n', columns, isStub: false };
    const full = estimateNodeWidth(base);
    expect(estimateNodeWidth({ ...base, tableDetail: 'all' })).toBe(full);
    expect(estimateNodeWidth({ ...base, tableDetail: 'keys', isExpanded: true })).toBe(full);
    expect(estimateNodeWidth({ ...base, tableDetail: 'keys' })).toBeLessThan(full);
    expect(estimateNodeWidth({ ...base, tableDetail: 'name' })).toBeLessThan(full);
    // No level: the collapsed estimate still measures every column, as before.
    expect(estimateNodeWidth({ ...base, isExpanded: false })).toBe(full);
  });
});
