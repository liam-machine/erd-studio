/**
 * The relationships index (ERD Studio 2.0, §2.1 and §2.4 of the design):
 * where a new Ref goes (decision 5: the file holding most of the FK table's
 * Refs, else its layer's default file), which relationships files a diagram
 * imports, which table pairs an edit moves between files, and that the
 * answers do not depend on the order the Refs were read in.
 */
import { describe, it, expect } from 'vitest';

import { readRelationshipsDbml } from '@erd-studio/core/dbml';
import { dbmlTableLookup, type DbmlAttachTable } from '@erd-studio/core';
import {
  buildRelationshipsIndex,
  changedPairs,
  pairKey,
  placeNewRef,
  refEntriesOf,
  relationshipsImportsFor,
  unitLinks,
  type IndexedRef,
  type RelationshipsIndex,
} from '../../src/services/dbmlRelationshipsIndex';

/** A live Ref `owner.<col> > target.<col>` in `file` at `line`. */
function ref(file: string, owner: string, target: string, line: number, options: { pending?: boolean; col?: string } = {}): IndexedRef {
  const col = options.col ?? `${target.toLowerCase()}_id`;
  const unit = { from: owner, to: target, fromColumns: [col], toColumns: ['id'], cardinality: 'many-to-one' as const };
  return { file, owner: owner.toLowerCase(), target: target.toLowerCase(), unit, links: unitLinks(unit), pending: options.pending ?? false, line };
}

function index(files: string[], refs: IndexedRef[], extra: { unreadable?: string[]; useTargets?: Map<string, string[]> } = {}): RelationshipsIndex {
  return buildRelationshipsIndex({ files, refs, ...extra });
}

/** A seeded shuffle (mulberry32), so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let a = seed >>> 0;
  const random = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('refEntriesOf', () => {
  it('reads Refs and pending lines with lower-case owners, link keys and lines, oriented as attach reads them', () => {
    const text = [
      'Ref: fct_order.customer_id > dim_customer.id',
      'Ref: fct_order.(a, b) > dim_date.(a, b)',
      '// erd-studio pending: Ref: fct_order.x_id > dim_missing.id',
      '',
    ].join('\n');
    const reading = readRelationshipsDbml(text);
    const tables: DbmlAttachTable[] = [
      { table: { name: 'FCT_Order', columns: [] }, storage: 'dbml' },
      { table: { name: 'dim_customer', columns: [] }, storage: 'dbml' },
    ];
    const entries = refEntriesOf('gold/relationships/gold.dbml', reading, dbmlTableLookup(tables));
    expect(entries.map((e) => [e.owner, e.target, e.pending, e.line, e.unit.from])).toEqual([
      ['fct_order', 'dim_customer', false, 1, 'FCT_Order'],
      ['fct_order', 'dim_date', false, 2, 'FCT_Order'],
      ['fct_order', 'dim_missing', true, 3, 'FCT_Order'],
    ]);
    expect(entries[1].links).toHaveLength(2);
    expect(entries[0].links).toEqual(['dim_customer.id\u0000fct_order.customer_id']);
  });

  it('keeps the owner end\'s qualifier as written, the other end\'s for a bare `-` the keys turn round', () => {
    const text = [
      'Ref: sap.afih.(MANDT, EQUNR) >? sap_raw.equi.(MANDT, EQUNR)',
      'Ref: dim_customer.id < gold.fct_order.customer_id',
      'Ref: gold.fct_order.customer_id - crm.dim_customer.id',
      '',
    ].join('\n');
    const tables: DbmlAttachTable[] = [
      { table: { name: 'fct_order', columns: [{ name: 'customer_id', dataType: 'int', description: '' }] }, storage: 'dbml' },
      { table: { name: 'dim_customer', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] }, storage: 'dbml' },
    ];
    const entries = refEntriesOf('gold/relationships/gold.dbml', readRelationshipsDbml(text), dbmlTableLookup(tables));
    expect(entries.map((e) => [e.owner, e.ownerQualifier])).toEqual([['afih', 'sap'], ['fct_order', 'gold'], ['fct_order', 'gold']]);
    const bare = refEntriesOf('gold/relationships/gold.dbml', readRelationshipsDbml('Ref: x.a - y.b\n'), () => undefined);
    expect(bare[0].ownerQualifier).toBeUndefined();
  });

  it('gives nothing for a file that does not read', () => {
    const reading = readRelationshipsDbml('Ref: a.b >');
    expect(reading.readable).toBe(false);
    expect(refEntriesOf('gold/relationships/gold.dbml', reading, () => undefined)).toEqual([]);
  });
});

describe('placeNewRef', () => {
  it('rule 1: the file holding most of the FK table\'s Refs, in any layer, by its name before the edit', () => {
    const idx = index(
      ['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml'],
      [
        ref('gold/relationships/gold.dbml', 'fct_order', 'dim_customer', 1),
        ref('silver/relationships/silver.dbml', 'fct_order', 'dim_date', 1),
        ref('silver/relationships/silver.dbml', 'fct_order', 'dim_store', 2),
      ],
    );
    expect(placeNewRef({ table: 'fct_order', layer: 'gold' }, idx)).toEqual({ file: 'silver/relationships/silver.dbml', create: false, rule: 1 });
    expect(placeNewRef({ table: 'FCT_ORDER', layer: 'gold' }, idx).file).toBe('silver/relationships/silver.dbml');
    // A renamed table is placed by its old name: the index is the snapshot before the edit.
    expect(placeNewRef({ table: 'fct_sales', layer: 'gold' }, idx).rule).toBe(2);
  });

  it('rule 1 keeps using a hand split', () => {
    const idx = index(
      ['silver/relationships/calendar.dbml', 'silver/relationships/silver.dbml'],
      [
        ref('silver/relationships/calendar.dbml', 'dim_date', 'dim_month', 1),
        ref('silver/relationships/calendar.dbml', 'dim_date', 'dim_year', 2),
        ref('silver/relationships/silver.dbml', 'fct_sale', 'dim_date', 1),
      ],
    );
    expect(placeNewRef({ table: 'dim_date', layer: 'silver' }, idx)).toEqual({ file: 'silver/relationships/calendar.dbml', create: false, rule: 1 });
  });

  it('a cross-layer FK table goes where its Refs already are, even in another layer', () => {
    const idx = index(['silver/relationships/silver.dbml'], [ref('silver/relationships/silver.dbml', 'fct_gold', 'dim_silver', 1)]);
    expect(placeNewRef({ table: 'fct_gold', layer: 'gold' }, idx)).toEqual({ file: 'silver/relationships/silver.dbml', create: false, rule: 1 });
  });

  it('ties go to path byte order', () => {
    const files = ['gold/relationships/gold.dbml', 'gold/relationships/Gold2.dbml'];
    const refs = [ref(files[0], 'fct', 'a', 1), ref(files[1], 'fct', 'b', 1)];
    // 'G' (0x47) sorts before 'g' (0x67): byte order, not a locale's.
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, index(files, refs)).file).toBe('gold/relationships/Gold2.dbml');
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, index([...files].reverse(), [...refs].reverse())).file).toBe('gold/relationships/Gold2.dbml');
  });

  it('pending lines count', () => {
    const idx = index(
      ['gold/relationships/a.dbml', 'gold/relationships/b.dbml'],
      [
        ref('gold/relationships/a.dbml', 'fct', 'x', 1),
        ref('gold/relationships/b.dbml', 'fct', 'y', 1, { pending: true }),
        ref('gold/relationships/b.dbml', 'fct', 'z', 2, { pending: true }),
      ],
    );
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, idx).file).toBe('gold/relationships/b.dbml');
  });

  it('never picks an unreadable file', () => {
    const idx = index(
      ['gold/relationships/a.dbml', 'gold/relationships/b.dbml'],
      [ref('gold/relationships/a.dbml', 'fct', 'x', 1), ref('gold/relationships/a.dbml', 'fct', 'y', 2), ref('gold/relationships/b.dbml', 'fct', 'z', 1)],
      { unreadable: ['gold/relationships/a.dbml'] },
    );
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, idx).file).toBe('gold/relationships/b.dbml');
  });

  it('rule 2 creates <L>/relationships/<L>.dbml, spelled as the layer folder is listed', () => {
    const idx = index([], []);
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, idx)).toEqual({ file: 'gold/relationships/gold.dbml', create: true, rule: 2 });
    const listed = (l: string): string | undefined => (l === 'gold' ? 'gold' : undefined);
    expect(placeNewRef({ table: 'fct', layer: 'GOLD' }, idx, listed)).toEqual({ file: 'gold/relationships/gold.dbml', create: true, rule: 2 });
  });

  it('rule 2 reuses the default file when it exists, even holding none of the table\'s Refs', () => {
    const idx = index(['gold/relationships/gold.dbml'], [ref('gold/relationships/gold.dbml', 'other', 'x', 1)]);
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, idx)).toEqual({ file: 'gold/relationships/gold.dbml', create: false, rule: 2 });
  });

  it('rule 2 reuses a listed file whose name differs only in case', () => {
    const idx = index(['gold/relationships/Gold.dbml'], []);
    expect(placeNewRef({ table: 'fct', layer: 'gold' }, idx)).toEqual({ file: 'gold/relationships/Gold.dbml', create: false, rule: 2 });
  });
});

describe('filesUsing', () => {
  it('names a file whose use line names a table no Ref in it names, case-insensitively', () => {
    const idx = index(
      ['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml'],
      [ref('gold/relationships/gold.dbml', 'fct', 'dim', 1)],
      {
        useTargets: new Map([
          ['silver/relationships/silver.dbml', ['gold/tables/gold/orphan.dbml']],
          ['gold/relationships/gold.dbml', ['gold/tables/gold/fct.dbml', 'gold/tables/gold/dim.dbml', 'gold/tables/gold/Orphan.dbml']],
        ]),
      },
    );
    expect(idx.filesUsing('gold/tables/gold/orphan.dbml')).toEqual(['gold/relationships/gold.dbml', 'silver/relationships/silver.dbml']);
    expect(idx.filesUsing('gold/tables/gold/ORPHAN.dbml')).toHaveLength(2);
    expect(idx.filesUsing('gold/tables/gold/fct.dbml')).toEqual(['gold/relationships/gold.dbml']);
    expect(idx.filesUsing('gold/tables/gold/none.dbml')).toEqual([]);
  });
});

describe('determinism', () => {
  it('shuffled Refs and files give the same index and the same placements', () => {
    const files = ['gold/relationships/gold.dbml', 'gold/relationships/b.dbml', 'silver/relationships/silver.dbml', 'silver/relationships/Calendar.dbml'];
    const refs: IndexedRef[] = [];
    for (let i = 0; i < 200; i++) {
      refs.push(ref(files[i % files.length], `t${i % 17}`, `t${(i * 7) % 23}`, Math.floor(i / files.length) + 1, { pending: i % 11 === 0 }));
    }
    const base = index(files, refs);
    const place = (idx: RelationshipsIndex): string[] =>
      Array.from({ length: 30 }, (_, i) => JSON.stringify(placeNewRef({ table: `t${i}`, layer: i % 2 ? 'gold' : 'silver' }, idx)));
    for (const seed of [1, 2, 3, 42]) {
      const other = index(shuffled(files, seed), shuffled(refs, seed));
      expect(other.files).toEqual(base.files);
      expect(other.refs).toEqual(base.refs);
      expect(place(other)).toEqual(place(base));
      expect(relationshipsImportsFor(['t1', 't7', 't3', 't0'], other)).toEqual(relationshipsImportsFor(['t1', 't7', 't3', 't0'], base));
    }
  });
});

describe('relationshipsImportsFor', () => {
  const files = ['gold/relationships/a.dbml', 'gold/relationships/b.dbml', 'gold/relationships/c.dbml', 'gold/relationships/broken.dbml'];

  it('imports the files holding a live Ref between two members, a self-Ref included, byte-sorted', () => {
    const idx = index(files, [
      ref(files[1], 'fct', 'dim', 1),
      ref(files[0], 'emp', 'emp', 1, { col: 'manager_id' }),
      ref(files[2], 'fct', 'other', 1),
    ]);
    expect(relationshipsImportsFor(['FCT', 'dim', 'emp'], idx)).toEqual(['gold/relationships/a.dbml', 'gold/relationships/b.dbml']);
    expect(relationshipsImportsFor(['fct'], idx)).toEqual([]);
  });

  it('imports for a pending line between two tables the diagram draws, unlinked ones included', () => {
    const idx = index(files, [ref(files[0], 'fct', 'dim', 1, { pending: true }), ref(files[2], 'fct', 'gone', 1, { pending: true })]);
    expect(relationshipsImportsFor(['fct', 'dim'], idx)).toEqual(['gold/relationships/a.dbml']);
    expect(relationshipsImportsFor({ members: ['FCT'], unlinked: ['Dim'] }, idx)).toEqual(['gold/relationships/a.dbml']);
    expect(relationshipsImportsFor({ members: ['fct'], unlinked: ['dim', 'gone'] }, idx)).toEqual(['gold/relationships/a.dbml', 'gold/relationships/c.dbml']);
    // An end outside the diagram brings no import.
    expect(relationshipsImportsFor({ members: ['fct'], unlinked: ['other'] }, idx)).toEqual([]);
    expect(relationshipsImportsFor({ members: ['fct'] }, idx)).toEqual([]);
  });

  it('a live Ref needs both ends among the use members: an unlinked end brings no import', () => {
    const idx = index(files, [ref(files[1], 'fct', 'dim', 1)]);
    expect(relationshipsImportsFor({ members: ['fct'], unlinked: ['dim'] }, idx)).toEqual([]);
    expect(relationshipsImportsFor({ members: ['fct', 'dim'], unlinked: [] }, idx)).toEqual(['gold/relationships/b.dbml']);
  });

  it('never imports an unreadable file for a pending line', () => {
    const idx = index(files, [ref(files[3], 'fct', 'dim', 1, { pending: true })], { unreadable: [files[3]] });
    expect(relationshipsImportsFor({ members: ['fct'], unlinked: ['dim'] }, idx)).toEqual([]);
  });

  it('keeps an unreadable file the diagram imports, and never adds one', () => {
    const idx = index(files, [ref(files[0], 'fct', 'dim', 1), ref(files[3], 'fct', 'dim', 2)], { unreadable: [files[3]] });
    expect(relationshipsImportsFor(['fct', 'dim'], idx)).toEqual(['gold/relationships/a.dbml']);
    expect(relationshipsImportsFor(['fct', 'dim'], idx, { current: [files[3], files[2]] })).toEqual(['gold/relationships/a.dbml', 'gold/relationships/broken.dbml']);
  });

  it('filters by exists', () => {
    const idx = index(files, [ref(files[0], 'fct', 'dim', 1), ref(files[1], 'dim', 'fct', 1)]);
    expect(relationshipsImportsFor(['fct', 'dim'], idx, { exists: (f) => f !== files[0] })).toEqual(['gold/relationships/b.dbml']);
  });
});

describe('changedPairs', () => {
  const A = 'gold/relationships/a.dbml';
  const B = 'gold/relationships/b.dbml';

  it('sees an add and a remove', () => {
    const before = index([A], [ref(A, 'fct', 'dim', 1)]);
    const after = index([A], [ref(A, 'fct', 'dim', 1), ref(A, 'fct', 'store', 2)]);
    expect(changedPairs(before, after)).toEqual(new Set([pairKey('fct', 'store')]));
    expect(changedPairs(after, before)).toEqual(new Set([pairKey('fct', 'store')]));
  });

  it('sees a Ref moved to another file, and not one that stays where it is', () => {
    const before = index([A, B], [ref(A, 'fct', 'dim', 1), ref(A, 'x', 'y', 2)]);
    const after = index([A, B], [ref(B, 'fct', 'dim', 1), ref(A, 'x', 'y', 5)]);
    expect(changedPairs(before, after)).toEqual(new Set([pairKey('dim', 'fct')]));
  });

  it('sees a second Ref of a pair in a file that already holds one as no change', () => {
    const before = index([A], [ref(A, 'fct', 'dim', 1)]);
    const after = index([A], [ref(A, 'fct', 'dim', 1), ref(A, 'dim', 'fct', 2, { col: 'fct_id' })]);
    expect(changedPairs(before, after)).toEqual(new Set());
  });

  it('sees a renamed table as the old pair and the new one', () => {
    const before = index([A], [ref(A, 'fct_order', 'dim', 1)]);
    const after = index([A], [ref(A, 'fct_sale', 'dim', 1)]);
    expect(changedPairs(before, after)).toEqual(new Set([pairKey('fct_order', 'dim'), pairKey('fct_sale', 'dim')]));
  });

  it('sees a pending line added, removed or become a Ref (it brings an import too)', () => {
    const before = index([A], []);
    const pending = index([A], [ref(A, 'fct', 'dim', 1, { pending: true })]);
    const live = index([A], [ref(A, 'fct', 'dim', 1)]);
    expect(changedPairs(before, pending)).toEqual(new Set([pairKey('fct', 'dim')]));
    expect(changedPairs(pending, before)).toEqual(new Set([pairKey('fct', 'dim')]));
    expect(changedPairs(pending, live)).toEqual(new Set([pairKey('fct', 'dim')]));
    expect(changedPairs(pending, index([A], [ref(A, 'fct', 'dim', 7, { pending: true })]))).toEqual(new Set());
  });

  it('pairKey is order-free and case-free', () => {
    expect(pairKey('B', 'a')).toBe(pairKey('a', 'b'));
    expect(pairKey('a', 'b')).toBe('a\u0000b');
  });
});

describe('performance, shaped like the settled rule', () => {
  /**
   * The margin the budget is asserted with (dbmlPerformance.test.ts): 3×
   * locally, 8× on CI. Baseline measured 2026-10-30 on an M-series laptop:
   * about 60 ms for the build, the placements and the imports together
   * (run alone).
   */
  const MARGIN = process.env.CI ? 8 : 3;
  const BUDGET_MS = 80;

  it('3 layer default files × 10,000 Refs plus a hand split, 1,100 tables: build, 1,000 placements and 100 importsFor', () => {
    const layers = ['bronze', 'silver', 'gold'];
    const files = [...layers.map((l) => `${l}/relationships/${l}.dbml`), 'silver/relationships/calendar.dbml'];
    const tables = Array.from({ length: 1100 }, (_, i) => `t${i}`);
    const refs: IndexedRef[] = [];
    for (let f = 0; f < 3; f++) {
      for (let i = 0; i < 10_000; i++) {
        const owner = tables[(i * 7 + f * 13) % tables.length];
        const target = tables[(i * 11 + f * 5 + 1) % tables.length];
        refs.push(ref(files[f], owner, target, i + 1, { col: `c${i}` }));
      }
    }
    for (let i = 0; i < 50; i++) refs.push(ref(files[3], 'dim_date', tables[i], i + 1));

    const start = performance.now();
    const idx = buildRelationshipsIndex({ files, refs });
    const placements = Array.from({ length: 1000 }, (_, i) => placeNewRef({ table: i % 10 === 0 ? `new_${i}` : tables[i], layer: layers[i % 3] }, idx));
    const imports = Array.from({ length: 100 }, (_, i) => relationshipsImportsFor(tables.slice(i * 10, i * 10 + 150), idx));
    const elapsed = performance.now() - start;

    if (elapsed > BUDGET_MS || process.env.DBML_PERF_LOG) {
      console.warn(`[dbmlRelationshipsIndex] ${elapsed.toFixed(0)} ms, budget ${BUDGET_MS} ms (fails above ${MARGIN}×)`);
    }
    expect(elapsed).toBeLessThanOrEqual(BUDGET_MS * MARGIN);
    expect(idx.refs).toHaveLength(30_050);
    expect(placements.filter((p) => p.rule === 2)).toHaveLength(100);
    expect(placeNewRef({ table: 'dim_date', layer: 'silver' }, idx).file).toBe('silver/relationships/calendar.dbml');
    expect(imports.filter((list) => list.length > 0).length).toBeGreaterThan(50);
  });
});
