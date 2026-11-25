/**
 * The column filter (#359): at the `keys` level a column is drawn when it
 * matches ANY rule that is on — primary key, foreign key, natural key, or a
 * name pattern. Without a filter `keys` is what it always was, and the rows
 * drawn are the rows the size estimate counts.
 */
import { describe, it, expect } from 'vitest';
import {
  COLUMN_NAME_PATTERN_MAX,
  TABLE_DETAILS,
  columnNameTerms,
  normaliseColumnFilter,
  resolveVisibleColumns,
  sameColumnFilter,
  type ColumnFilter,
} from '../../src/lib/tableDetail';
import { countVisibleColumnRows, estimateNodeWidth } from '../../src/lib/nodeSizing';

type Col = { name: string; dataType: string; isPrimaryKey: boolean; isForeignKey: boolean; isNaturalKey: boolean };
const col = (name: string, key: '' | 'pk' | 'fk' | 'nk' = ''): Col => ({
  name,
  dataType: 'string',
  isPrimaryKey: key === 'pk',
  isForeignKey: key === 'fk',
  isNaturalKey: key === 'nk',
});
const names = (cols: Col[]) => cols.map((c) => c.name);

const columns = [col('id', 'pk'), col('customer_id', 'fk'), col('code', 'nk'), col('_loaded_at'), col('amount'), col('ORDER_DATE')];
const NONE = { primaryKeys: false, foreignKeys: false, naturalKeys: false };

const resolve = (columnFilter: ColumnFilter | null | undefined, extra: Partial<Parameters<typeof resolveVisibleColumns<Col>>[0]> = {}) =>
  resolveVisibleColumns({ columns, tableDetail: 'keys', columnFilter, ...extra });
const shown = (columnFilter: ColumnFilter | null | undefined) => names(resolve(columnFilter).columns);

describe('column filter: any rule that is on shows the column', () => {
  it('each key kind on its own', () => {
    expect(shown({ ...NONE, primaryKeys: true })).toEqual(['id']);
    expect(shown({ ...NONE, foreignKeys: true })).toEqual(['customer_id']);
    expect(shown({ ...NONE, naturalKeys: true })).toEqual(['code']);
  });

  it('rules are OR-ed, and the rows stay in file order', () => {
    expect(shown({ ...NONE, primaryKeys: true, namePattern: '*_at' })).toEqual(['id', '_loaded_at']);
    expect(shown({ ...NONE, namePattern: 'amount, *_at' })).toEqual(['_loaded_at', 'amount']);
  });

  it('a flag left out counts as on', () => {
    expect(shown({ foreignKeys: false })).toEqual(['id', 'code']);
    expect(shown({ namePattern: 'amount' })).toEqual(['id', 'customer_id', 'code', 'amount']);
  });

  it('no rule on shows no column, with the table still openable', () => {
    const v = resolve(NONE);
    expect(v.columns).toEqual([]);
    expect(v.toggle).toBe('expand');
    expect(v.hiddenCount).toBe(columns.length);
  });

  it('the counts follow the filter, so "Show all N" stays right', () => {
    const v = resolve({ ...NONE, foreignKeys: true });
    expect(v.hiddenCount).toBe(columns.length - 1);
    expect(v.expandedCount).toBe(columns.length);
    expect(v.hiddenCount + v.columns.length).toBe(v.expandedCount);
    expect(v.isFullList).toBe(false);
  });

  it('a table opened on its own shows every column, and offers the way back', () => {
    const v = resolve({ ...NONE, namePattern: 'amount' }, { isExpanded: true });
    expect(names(v.columns)).toEqual(names(columns));
    expect(v.toggle).toBe('collapse');
  });
});

describe('column filter: the name pattern', () => {
  it('a plain term matches anywhere in the name, in any case', () => {
    expect(shown({ ...NONE, namePattern: 'date' })).toEqual(['ORDER_DATE']);
    expect(shown({ ...NONE, namePattern: 'ID' })).toEqual(['id', 'customer_id']);
  });

  it('a term with * or ? must match the whole name', () => {
    expect(shown({ ...NONE, namePattern: '*_id' })).toEqual(['customer_id']);
    expect(shown({ ...NONE, namePattern: 'cod?' })).toEqual(['code']);
    expect(shown({ ...NONE, namePattern: 'co?' })).toEqual([]);
    expect(shown({ ...NONE, namePattern: '_*' })).toEqual(['_loaded_at']);
    // The issue's own example.
    expect(shown({ ...NONE, namePattern: '*oun*' })).toEqual(['amount']);
  });

  it('is never a regular expression: its characters are matched as typed', () => {
    for (const namePattern of ['(', '[a-z', '*xyz*', '(a+)+$', '.', '\\', '^id$', '+']) {
      expect(() => resolve({ ...NONE, namePattern })).not.toThrow();
    }
    expect(shown({ ...NONE, namePattern: '.' })).toEqual([]);
    expect(shown({ ...NONE, namePattern: '^id$' })).toEqual([]);
    const odd = [col('a.b'), col('axb')];
    expect(names(resolveVisibleColumns({ columns: odd, tableDetail: 'keys', columnFilter: { ...NONE, namePattern: 'a.b' } }).columns)).toEqual(['a.b']);
  });

  it('a pattern built to make a regex run away returns at once', () => {
    const long = [col(`${'a'.repeat(120)}b`)];
    const started = Date.now();
    const v = resolveVisibleColumns({ columns: long, tableDetail: 'keys', columnFilter: { ...NONE, namePattern: `${'*a'.repeat(60)}*c` } });
    expect(v.columns).toEqual([]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('blank terms are ignored, and the pattern is cut at its limit', () => {
    expect(columnNameTerms(' , Date ,, *_AT ')).toEqual(['date', '*_at']);
    expect(shown({ ...NONE, namePattern: ' , ' })).toEqual([]);
    const cut = normaliseColumnFilter({ namePattern: 'x'.repeat(COLUMN_NAME_PATTERN_MAX + 50) });
    expect(cut?.namePattern).toHaveLength(COLUMN_NAME_PATTERN_MAX);
  });
});

describe('column filter: what did not change', () => {
  it('without a filter, every level and state draws what it drew before', () => {
    for (const tableDetail of [...TABLE_DETAILS, null]) {
      for (const isExpanded of [false, true]) {
        for (const isStub of [false, true]) {
          const base = { columns, tableDetail, isExpanded, isStub };
          const expected = resolveVisibleColumns(base);
          expect(resolveVisibleColumns({ ...base, columnFilter: null })).toEqual(expected);
          expect(resolveVisibleColumns({ ...base, columnFilter: undefined })).toEqual(expected);
          // The default filter spelled out is the same rule.
          expect(resolveVisibleColumns({ ...base, columnFilter: { primaryKeys: true, foreignKeys: true, naturalKeys: true, namePattern: '' } })).toEqual(expected);
        }
      }
    }
    expect(names(resolveVisibleColumns({ columns, tableDetail: 'keys' }).columns)).toEqual(['id', 'customer_id', 'code']);
  });

  it('the filter is read at `keys` only', () => {
    const columnFilter = { ...NONE, namePattern: 'amount' };
    for (const tableDetail of ['name', 'all', null] as const) {
      expect(resolveVisibleColumns({ columns, tableDetail, columnFilter })).toEqual(resolveVisibleColumns({ columns, tableDetail }));
    }
  });

  it('a stub lists its primary and natural keys whatever the filter', () => {
    const v = resolve({ ...NONE, namePattern: 'amount' }, { isStub: true });
    expect(names(v.columns)).toEqual(['id', 'code']);
  });

  it('the rows drawn are the rows the size estimate counts and measures', () => {
    const columnFilter = { ...NONE, namePattern: '*_at' };
    const data = { modelName: 't', label: 't', columns, isStub: false, isExpanded: false, tableDetail: 'keys' as const, columnFilter };
    expect(countVisibleColumnRows(data)).toBe(resolve(columnFilter).columns.length + 1);
    // A long name the filter hides does not widen the card.
    const wide = [...columns, col('a_very_long_column_name_that_would_widen_the_card_if_it_were_measured')];
    expect(estimateNodeWidth({ ...data, columns: wide })).toBe(estimateNodeWidth(data));
  });
});

describe('column filter: a filter object changed in place', () => {
  it('is read as it now stands, not as it was first seen', () => {
    const columnFilter: ColumnFilter = { ...NONE, namePattern: 'amount' };
    expect(shown(columnFilter)).toEqual(['amount']);
    columnFilter.namePattern = 'code';
    expect(shown(columnFilter)).toEqual(['code']);
    columnFilter.primaryKeys = true;
    expect(shown(columnFilter)).toEqual(['id', 'code']);
  });
});

describe('normaliseColumnFilter / sameColumnFilter', () => {
  it('the default, and anything that is not a filter, is null', () => {
    for (const value of [null, undefined, 'keys', 3, [], {}, { primaryKeys: true }, { namePattern: '' }, { namePattern: {} }, { foreignKeys: 'no' }]) {
      expect(normaliseColumnFilter(value)).toBeNull();
    }
  });

  it('a filter comes back with all four fields, unknown keys dropped', () => {
    expect(normaliseColumnFilter({ foreignKeys: false, later: 1 })).toEqual({ primaryKeys: true, foreignKeys: false, naturalKeys: true, namePattern: '' });
    expect(normaliseColumnFilter({ namePattern: '*_at' })).toEqual({ primaryKeys: true, foreignKeys: true, naturalKeys: true, namePattern: '*_at' });
  });

  it('compares by value, with null and absent as the default', () => {
    expect(sameColumnFilter(null, undefined)).toBe(true);
    expect(sameColumnFilter(null, { primaryKeys: true })).toBe(true);
    expect(sameColumnFilter({ foreignKeys: false }, { foreignKeys: false, namePattern: '' })).toBe(true);
    expect(sameColumnFilter({ foreignKeys: false }, null)).toBe(false);
    expect(sameColumnFilter({ namePattern: 'a' }, { namePattern: 'b' })).toBe(false);
  });
});
