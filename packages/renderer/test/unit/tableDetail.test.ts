/**
 * resolveVisibleColumns — the one decision of which rows a table draws, at
 * each table detail level, for an opened table, a stub, and a node with no
 * level at all (the behaviour before the levels existed).
 */
import { describe, it, expect } from 'vitest';
import {
  TABLE_DETAILS,
  defaultTableDetail,
  isTableDetail,
  resolveVisibleColumns,
} from '../../src/lib/tableDetail';

type Col = { name: string; isPrimaryKey: boolean; isForeignKey: boolean; isNaturalKey: boolean };
const col = (name: string, key: '' | 'pk' | 'fk' | 'nk' | 'pk+fk' = ''): Col => ({
  name,
  isPrimaryKey: key.includes('pk'),
  isForeignKey: key.includes('fk'),
  isNaturalKey: key === 'nk',
});
const names = (cols: Col[]) => cols.map((c) => c.name);

/** PK first, an FK in the middle, an NK near the end: file order is not key order. */
const columns = [
  col('order_id', 'pk'),
  col('placed_at'),
  col('customer_id', 'fk'),
  col('amount'),
  col('status'),
  col('order_number', 'nk'),
  col('notes'),
];

describe('isTableDetail / defaultTableDetail', () => {
  it('knows the three levels and nothing else', () => {
    expect([...TABLE_DETAILS]).toEqual(['name', 'keys', 'all']);
    expect(TABLE_DETAILS.every(isTableDetail)).toBe(true);
    for (const bad of ['', 'ALL', 'columns', null, undefined, 1, {}]) expect(isTableDetail(bad)).toBe(false);
  });

  it('opens a diagram under 30 tables at all, and from 30 up at keys', () => {
    expect(defaultTableDetail(0)).toBe('all');
    expect(defaultTableDetail(29)).toBe('all');
    expect(defaultTableDetail(30)).toBe('keys');
    expect(defaultTableDetail(500)).toBe('keys');
  });
});

describe('resolveVisibleColumns at a level', () => {
  it('all: every column, no button, and the rows are the full list', () => {
    const v = resolveVisibleColumns({ columns, tableDetail: 'all' });
    expect(v.columns).toEqual(columns);
    expect(v).toMatchObject({ hiddenCount: 0, toggle: null, expanded: true, isFullList: true, placeholder: false });
  });

  it('all: ignores the per-table override', () => {
    expect(resolveVisibleColumns({ columns, tableDetail: 'all', isExpanded: true }).toggle).toBeNull();
  });

  it('keys: primary, foreign and natural keys in file order, with the way to the rest', () => {
    const v = resolveVisibleColumns({ columns, tableDetail: 'keys' });
    expect(names(v.columns)).toEqual(['order_id', 'customer_id', 'order_number']);
    expect(v).toMatchObject({ hiddenCount: 4, expandedCount: 7, toggle: 'expand', toggleInFooter: false, expanded: false, isFullList: false, placeholder: false });
  });

  it('keys: a composite key (several PK columns, one also an FK) keeps every part once', () => {
    const composite = [col('order_id', 'pk+fk'), col('line_no', 'pk'), col('sku', 'fk'), col('qty')];
    const v = resolveVisibleColumns({ columns: composite, tableDetail: 'keys' });
    expect(names(v.columns)).toEqual(['order_id', 'line_no', 'sku']);
    expect(v.hiddenCount).toBe(1);
  });

  it('keys: a table with no key columns draws no rows and says how many are hidden', () => {
    const plain = [col('a'), col('b'), col('c')];
    const v = resolveVisibleColumns({ columns: plain, tableDetail: 'keys' });
    expect(v.columns).toEqual([]);
    expect(v).toMatchObject({ hiddenCount: 3, expandedCount: 3, toggle: 'expand', placeholder: false, isFullList: false });
  });

  it('keys: a table of only key columns hides nothing, so it has no button', () => {
    const allKeys = [col('a', 'pk'), col('b', 'fk')];
    const v = resolveVisibleColumns({ columns: allKeys, tableDetail: 'keys' });
    expect(v).toMatchObject({ hiddenCount: 0, toggle: null, isFullList: true });
    // ...and an override left over from another level changes nothing.
    expect(resolveVisibleColumns({ columns: allKeys, tableDetail: 'keys', isExpanded: true }).toggle).toBeNull();
  });

  it('name: no rows at all, with the way to the columns in the footer', () => {
    const v = resolveVisibleColumns({ columns, tableDetail: 'name' });
    expect(v.columns).toEqual([]);
    expect(v).toMatchObject({ hiddenCount: 7, expandedCount: 7, toggle: 'expand', toggleInFooter: true, expanded: false, isFullList: false, placeholder: false });
  });

  it.each(['name', 'keys'] as const)('%s: an opened table shows every column and the way back', (tableDetail) => {
    const v = resolveVisibleColumns({ columns, tableDetail, isExpanded: true });
    expect(v.columns).toEqual(columns);
    expect(v).toMatchObject({ hiddenCount: 0, toggle: 'collapse', toggleInFooter: false, expanded: true, isFullList: true });
  });

  it('a table with no columns: "No columns" at keys and all, a bare card at name', () => {
    expect(resolveVisibleColumns({ columns: [], tableDetail: 'all' })).toMatchObject({ toggle: null, placeholder: true });
    expect(resolveVisibleColumns({ columns: [], tableDetail: 'keys' })).toMatchObject({ toggle: null, placeholder: true });
    expect(resolveVisibleColumns({ columns: [], tableDetail: 'name' })).toMatchObject({ toggle: null, toggleInFooter: false, placeholder: false });
  });

  it('an unreadable file keeps its message at every level', () => {
    for (const tableDetail of TABLE_DETAILS) {
      expect(resolveVisibleColumns({ columns: [], tableDetail, loadError: { kind: 'read' } }).placeholder).toBe(true);
    }
  });
});

describe('resolveVisibleColumns for a stub table', () => {
  it('lists only its primary and natural keys at keys and all, never the full list', () => {
    for (const tableDetail of ['keys', 'all'] as const) {
      const v = resolveVisibleColumns({ columns, isStub: true, tableDetail });
      expect(names(v.columns)).toEqual(['order_id', 'order_number']);
      expect(v).toMatchObject({ hiddenCount: 0, toggle: null, isFullList: false });
    }
  });

  it('is header only at name, and opens to its keys', () => {
    const closed = resolveVisibleColumns({ columns, isStub: true, tableDetail: 'name' });
    expect(closed.columns).toEqual([]);
    expect(closed).toMatchObject({ hiddenCount: 2, expandedCount: 2, toggle: 'expand', toggleInFooter: true });
    const opened = resolveVisibleColumns({ columns, isStub: true, tableDetail: 'name', isExpanded: true });
    expect(names(opened.columns)).toEqual(['order_id', 'order_number']);
    expect(opened).toMatchObject({ toggle: 'collapse', isFullList: false });
  });

  it('with no key columns has nothing to open', () => {
    const v = resolveVisibleColumns({ columns: [col('a'), col('b')], isStub: true, tableDetail: 'name' });
    expect(v).toMatchObject({ columns: [], toggle: null, placeholder: false });
  });
});

describe('resolveVisibleColumns without a level (older callers)', () => {
  const many = Array.from({ length: 12 }, (_, i) => col(`c${i}`, i === 0 ? 'pk' : ''));

  it('shows the first five columns and counts the rest', () => {
    const v = resolveVisibleColumns({ columns: many });
    expect(names(v.columns)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(v).toMatchObject({ hiddenCount: 7, toggle: 'expand', toggleInFooter: false, expanded: false, isFullList: false });
  });

  it('shows everything with "Show less" when expanded', () => {
    const v = resolveVisibleColumns({ columns: many, isExpanded: true, tableDetail: null });
    expect(v.columns).toEqual(many);
    expect(v).toMatchObject({ hiddenCount: 0, toggle: 'collapse', expanded: true, isFullList: true });
  });

  it('shows a short table whole with no button', () => {
    const v = resolveVisibleColumns({ columns: many.slice(0, 5) });
    expect(v).toMatchObject({ hiddenCount: 0, toggle: null, isFullList: true });
  });

  it('a stub with few keys is not the full list, so its rows are never reordered by index', () => {
    const v = resolveVisibleColumns({ columns: [col('a'), col('id', 'pk'), col('b')], isStub: true });
    expect(names(v.columns)).toEqual(['id']);
    expect(v).toMatchObject({ hiddenCount: 0, toggle: null, isFullList: false });
  });

  it('keeps the "No columns" line for an empty table', () => {
    expect(resolveVisibleColumns({ columns: [] }).placeholder).toBe(true);
  });
});
