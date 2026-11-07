/**
 * Does the first draft look any good? (telemetry 2.0 B6,
 * `src/services/draftTelemetry.ts`): presence flags from a draft about to
 * show, computed on the device. Table-driven over synthetic drafts: each
 * threshold's edge, the examples left out, the source-qualified keys, and the
 * key-name inference. Fixed keys only: never a name, a type or a count.
 */
import { describe, expect, it } from 'vitest';

import {
  DRAFT_REJECTED_FAST_MS,
  DRAFT_WIDE_TABLE_COLUMNS,
  draftKeptQualityFeature,
  draftQualityFlags,
  draftRejectedFastFeature,
  draftShownQualityFeatures,
} from '../../src/services/draftTelemetry';
import { FEATURES } from '../../src/services/telemetryPayload';
import type { DisplayColumn, DisplayRelationship, DisplayTable } from '../../src/types/display';
import type { Draft, DraftSource, DraftSummary } from '../../src/types/draft';

function column(name: string, more: Partial<DisplayColumn> = {}): DisplayColumn {
  return { name, dataType: 'int', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...more };
}

function table(name: string, columns: DisplayColumn[]): DisplayTable {
  return { name, schema: '', description: '', columns } as DisplayTable;
}

function rel(from: string, to: string): DisplayRelationship {
  return { fromModel: from, fromColumn: 'x', toModel: to, toColumn: 'id', cardinality: 'many-to-one' } as DisplayRelationship;
}

const SUMMARY: DraftSummary = { tables: 0, relationships: 0, newTables: 0, reusedTables: 0, changedTables: 0, schemas: [], notes: 0, leftOut: 0 };

function draftOf(source: DraftSource, models: DisplayTable[], relationships: DisplayRelationship[] = [], summary: Partial<DraftSummary> = {}): Pick<Draft, 'source' | 'summary' | 'display'> {
  return {
    source,
    summary: { ...SUMMARY, tables: models.length, relationships: relationships.length, ...summary },
    display: { models, relationships } as unknown as Draft['display'],
  };
}

/** `n` keyed, typed tables (`t0`, `t1`, …), each with `cols` columns. */
function tables(n: number, cols = 2, more: (i: number) => Partial<DisplayColumn> = () => ({})): DisplayTable[] {
  return Array.from({ length: n }, (_, i) => table(`t${i}`, Array.from({ length: cols }, (_, c) => column(c === 0 ? 'id' : `c${c}`, { isPrimaryKey: c === 0, ...more(i) }))));
}

/** A chain t0 → t1 → … → t(n-1): every table in a relationship. */
function chain(n: number): DisplayRelationship[] {
  return Array.from({ length: n - 1 }, (_, i) => rel(`t${i}`, `t${i + 1}`));
}

describe('draftQualityFlags', () => {
  it('an example draft (the coffee shop, a bundled project) has no flags', () => {
    expect(draftQualityFlags(draftOf('example', tables(5)))).toBeNull();
    expect(draftQualityFlags(draftOf('exampleProject', tables(5)))).toBeNull();
    expect(draftShownQualityFeatures(null)).toEqual([]);
    expect(draftKeptQualityFeature(null)).toBeUndefined();
  });

  it('a good draft (connected, typed, keyed, narrow) raises nothing', () => {
    for (const source of ['dbt', 'sqlDdl', 'semanticModel', 'dbml'] as const) {
      const q = draftQualityFlags(draftOf(source, tables(6), chain(6)));
      expect(draftShownQualityFeatures(q), source).toEqual([]);
    }
  });

  it('a draft with missing display parts reads as empty, never throws', () => {
    expect(draftQualityFlags({ source: 'dbt', summary: SUMMARY, display: {} as Draft['display'] })).toMatchObject({ thin: false, relsNone: false });
  });

  it.each([
    // [tables, orphans, expected]: orphansMost needs 3+ tables and at least half of them in no relationship.
    [2, 2, false],
    [3, 2, true],
    [4, 1, false],
    [4, 2, true],
    [100, 49, false],
    [100, 50, true],
  ])('orphansMost: %i tables, %i in no relationship → %s', (n, orphans, expected) => {
    // The first n - orphans tables are chained (2+ of them), the rest stand alone.
    const linked = n - orphans;
    const relationships = linked >= 2 ? chain(linked) : linked === 1 ? [rel('t0', 't0')] : [];
    expect(draftQualityFlags(draftOf('sqlDdl', tables(n), relationships))?.orphansMost).toBe(expected);
  });

  it.each([
    [100, 49, false],
    [100, 50, true],
  ])('emptyTablesMost: %i tables, %i with no columns → %s', (n, empty, expected) => {
    const models = tables(n).map((t, i) => (i < empty ? { ...t, columns: [] } : t));
    expect(draftQualityFlags(draftOf('dbt', models, chain(n)))?.emptyTablesMost).toBe(expected);
  });

  it.each([
    [100, 49, false],
    [100, 50, true],
  ])('untypedMost: %i columns, %i with no type ("" or unknown, any case) → %s', (n, untyped, expected) => {
    const columns = Array.from({ length: n }, (_, i) => column(`c${i}`, { dataType: i < untyped ? (i % 2 ? 'UNKNOWN' : '') : 'varchar' }));
    const models = [table('a', columns.slice(0, n / 2)), table('b', columns.slice(n / 2))];
    expect(draftQualityFlags(draftOf('dbt', models, [rel('a', 'b')]))?.untypedMost).toBe(expected);
  });

  it('noPkMost: SQL DDL and DBML only, at least half the tables with no primary key; never for dbt or a semantic model', () => {
    const half = tables(4).map((t, i) => (i < 2 ? { ...t, columns: t.columns.map((c) => ({ ...c, isPrimaryKey: false })) } : t));
    const fewer = tables(4).map((t, i) => (i < 1 ? { ...t, columns: t.columns.map((c) => ({ ...c, isPrimaryKey: false })) } : t));
    expect(draftQualityFlags(draftOf('sqlDdl', half, chain(4)))?.noPkMost).toBe(true);
    expect(draftQualityFlags(draftOf('dbml', half, chain(4)))?.noPkMost).toBe(true);
    expect(draftQualityFlags(draftOf('sqlDdl', fewer, chain(4)))?.noPkMost).toBe(false);
    expect(draftQualityFlags(draftOf('dbt', half, chain(4)))?.noPkMost).toBe(false);
    expect(draftQualityFlags(draftOf('semanticModel', half, chain(4)))?.noPkMost).toBe(false);
  });

  it('wideTablesMost: at least half the tables with more than 30 columns', () => {
    const wide = DRAFT_WIDE_TABLE_COLUMNS + 1;
    expect(draftQualityFlags(draftOf('dbt', [...tables(1, wide), table('t1', [column('id')])], [rel('t0', 't1')]))?.wideTablesMost).toBe(true);
    expect(draftQualityFlags(draftOf('dbt', [...tables(1, DRAFT_WIDE_TABLE_COLUMNS), table('t1', [column('id')])], [rel('t0', 't1')]))?.wideTablesMost).toBe(false);
  });

  it('relsNone and thin, tagged with the source', () => {
    const q = draftQualityFlags(draftOf('dbt', tables(3)));
    expect(q).toMatchObject({ relsNone: true, orphansMost: true, thin: true, source: 'Dbt' });
    expect(draftShownQualityFeatures(q)).toEqual(['draftOrphansMost', 'draftThinDbt', 'draftRelsNoneDbt']);
    expect(draftKeptQualityFeature(q)).toBe('draftKeptThinDbt');
    // Two tables and no relationship: no relationships, but too small to be thin.
    const two = draftQualityFlags(draftOf('semanticModel', tables(2)));
    expect(two).toMatchObject({ relsNone: true, thin: false });
    expect(draftShownQualityFeatures(two)).toEqual(['draftRelsNoneSemanticModel']);
    expect(draftKeptQualityFeature(two)).toBeUndefined();
    // One table: neither.
    expect(draftQualityFlags(draftOf('sqlDdl', tables(1)))).toMatchObject({ relsNone: false, thin: false });
  });

  it('relsInferable: columns named like another drafted table\'s key (customer_id → customer or dim_customer), at least two', () => {
    const facts = (name: string) => table(name, [column('id', { isPrimaryKey: true }), column('customer_id'), column('PRODUCT_KEY')]);
    const named = (dim: string, prod: string) => [table(dim, [column('id', { isPrimaryKey: true })]), table(prod, [column('id', { isPrimaryKey: true })]), facts('fct_sale')];
    expect(draftQualityFlags(draftOf('sqlDdl', named('customer', 'product')))?.relsInferable).toBe(true);
    expect(draftQualityFlags(draftOf('sqlDdl', named('dim_customer', 'stg_product')))?.relsInferable).toBe(true);
    // Only one such column: not enough.
    const one = [table('customer', [column('id')]), table('sale', [column('customer_id')]), table('note', [column('text')])];
    expect(draftQualityFlags(draftOf('sqlDdl', one))?.relsInferable).toBe(false);
    // A table's own key name does not count: customer.customer_id points nowhere else.
    const own = [table('customer', [column('customer_id'), column('customer_key')]), table('a', []), table('b', [])];
    expect(draftQualityFlags(draftOf('sqlDdl', own))?.relsInferable).toBe(false);
    // Only asked when the draft is short of relationships.
    expect(draftQualityFlags(draftOf('sqlDdl', named('customer', 'product'), [rel('fct_sale', 'customer'), rel('fct_sale', 'product')]))?.relsInferable).toBe(false);
  });

  it('leftOut, capped and reusesLibrary come from the summary', () => {
    const q = draftQualityFlags(draftOf('dbt', tables(3), chain(3), { leftOut: 2, available: 400, reusedTables: 1 }));
    expect(draftShownQualityFeatures(q)).toEqual(['draftLeftOut', 'draftCapped', 'draftReusesLibrary']);
    expect(draftQualityFlags(draftOf('dbt', tables(3), chain(3), { changedTables: 1 }))?.reusesLibrary).toBe(true);
  });

  it('every key it can return is an allowlisted feature, and none is a size bucket', () => {
    const all = draftShownQualityFeatures({
      source: 'Dbml', thin: true, relsNone: true, orphansMost: true, emptyTablesMost: true, untypedMost: true,
      noPkMost: true, wideTablesMost: true, relsInferable: true, leftOut: true, capped: true, reusesLibrary: true,
    });
    for (const key of all) expect(FEATURES as readonly string[]).toContain(key);
    expect(all.some((k) => k.startsWith('draftTables'))).toBe(false);
  });
});

describe('draftRejectedFastFeature', () => {
  it('a discard or close within 15 s with no details opened, per source; not for an example', () => {
    expect(draftRejectedFastFeature('dbt', 10_000, false)).toBe('draftRejectedFastDbt');
    expect(draftRejectedFastFeature('sqlDdl', 0, false)).toBe('draftRejectedFastSqlDdl');
    expect(draftRejectedFastFeature('semanticModel', DRAFT_REJECTED_FAST_MS - 1, false)).toBe('draftRejectedFastSemanticModel');
    expect(draftRejectedFastFeature('dbml', DRAFT_REJECTED_FAST_MS, false)).toBeUndefined();
    expect(draftRejectedFastFeature('dbt', 10_000, true)).toBeUndefined();
    expect(draftRejectedFastFeature('example', 1_000, false)).toBeUndefined();
    expect(draftRejectedFastFeature('dbt', -5, false)).toBeUndefined();
  });
});
