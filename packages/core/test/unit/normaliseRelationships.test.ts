import { describe, it, expect } from 'vitest';

import { normaliseRelationships } from '../../src/normaliseRelationships';
import { buildUnifiedDomain } from '../../src/domain';
import { parseLogicalModelText } from '../../src/logicalModel';
import {
  canonicalRelationship,
  linkKey,
  stripRelationshipProvenance,
  type RelationshipDiagnostic,
} from '../../src/relationships';
import type { Cardinality, ModelRelationship, Relationship, RelationshipReadIssue, SemanticModel } from '../../src/types/semantic';

const m2o = (fromModel: string, fromColumn: string, toModel: string, toColumn: string, extra: Partial<Relationship> = {}): Relationship => ({
  fromModel, fromColumn, toModel, toColumn, cardinality: 'many-to-one', ...extra,
});
const lib = (rel: Relationship): ModelRelationship => {
  const { fromModel: _f, ...rest } = rel;
  return rest;
};
const col = (name: string, flags: Partial<{ isPrimaryKey: boolean; isForeignKey: boolean; isNaturalKey: boolean }> = {}) => ({
  name, dataType: 'INT', description: '', ...flags,
});
const codes = (d: RelationshipDiagnostic[]): string[] => d.map((x) => x.code).sort();

const dim = (rels: ModelRelationship[] = []): SemanticModel => ({
  name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true }), col('name')], ...(rels.length ? { relationships: rels } : {}),
});
const fct = (rels: ModelRelationship[] = []): SemanticModel => ({
  name: 'fct_order', columns: [col('order_key', { isPrimaryKey: true }), col('customer_key', { isForeignKey: true })], ...(rels.length ? { relationships: rels } : {}),
});
const TO_CUSTOMER = m2o('fct_order', 'customer_key', 'dim_customer', 'customer_key');
const REVERSED: Relationship = { ...m2o('dim_customer', 'customer_key', 'fct_order', 'customer_key'), cardinality: 'one-to-many' };

describe('normaliseRelationships — one read path (#133)', () => {
  it('draws a library relationship with its provenance', () => {
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct([lib(TO_CUSTOMER)]), dim()], own: [] });
    expect(relationships).toEqual([{
      ...TO_CUSTOMER,
      source: { kind: 'library', model: 'fct_order', index: 0 },
      stored: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' },
    }]);
    expect(diagnostics).toEqual([]);
  });

  it('keeps a domain record whose end is not one of the domain\'s models, and says so (REL003)', () => {
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct()], own: [TO_CUSTOMER], filePath: 'gold/o.json' });
    expect(relationships).toHaveLength(1);
    expect(relationships[0].issues).toEqual(['REL003']);
    expect(codes(diagnostics)).toEqual(['REL003']);
    expect(diagnostics[0]).toMatchObject({ severity: 'error' });
    expect(diagnostics[0].message).toMatch(/dim_customer, which is not in this diagram, so it is not drawn/);
  });

  it('turns a one-to-many in a model file round, keeps the stored ends, and says so (REL002)', () => {
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct(), dim([lib(REVERSED)])], own: [] });
    expect(relationships).toEqual([{
      ...TO_CUSTOMER,
      source: { kind: 'library', model: 'dim_customer', index: 0 },
      stored: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
      issues: ['REL002'],
    }]);
    expect(codes(diagnostics)).toEqual(['REL002']);
    expect(diagnostics[0].message).toMatch(/belongs in fct_order's model file as many-to-one/);
  });

  it('prefers the copy in its canonical home, whatever the model order (REL001 warning when they agree)', () => {
    for (const models of [[fct([lib(TO_CUSTOMER)]), dim([lib(REVERSED)])], [dim([lib(REVERSED)]), fct([lib(TO_CUSTOMER)])]]) {
      const { relationships, diagnostics } = normaliseRelationships({ models, own: [] });
      expect(relationships).toHaveLength(1);
      expect(relationships[0].source).toEqual({ kind: 'library', model: 'fct_order', index: 0 });
      expect(relationships[0].issues).toEqual(['REL001', 'REL002']);
      expect(diagnostics.find((d) => d.code === 'REL001')?.severity).toBe('warning');
    }
  });

  it('reports disagreeing copies as an error and draws the deterministic winner', () => {
    const one2one = { ...TO_CUSTOMER, cardinality: 'one-to-one' as Cardinality };
    const { relationships, diagnostics } = normaliseRelationships({
      models: [dim([lib({ ...REVERSED, fromColumn: 'customer_key' })]), fct([lib(one2one)])],
      own: [],
    });
    // Both are at home? fct_order's 1:1 is at home; dim_customer's one-to-many is not.
    expect(relationships[0].cardinality).toBe('one-to-one');
    expect(diagnostics.find((d) => d.code === 'REL001')).toMatchObject({ severity: 'error' });
  });

  it('treats a one-to-one stored each way as different', () => {
    const ab = { ...m2o('a', 'k', 'b', 'k'), cardinality: 'one-to-one' as Cardinality };
    const ba = { ...m2o('b', 'k', 'a', 'k'), cardinality: 'one-to-one' as Cardinality };
    const { diagnostics } = normaliseRelationships({
      models: [{ name: 'a', relationships: [lib(ab)] }, { name: 'b', relationships: [lib(ba)] }],
      own: [],
    });
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['REL001', 'error']]);
  });

  it('a library record beats a domain copy; an agreeing domain copy is only info (REL009)', () => {
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct([lib(TO_CUSTOMER)]), dim()], own: [REVERSED], filePath: 'gold/x.json' });
    expect(relationships).toHaveLength(1);
    expect(relationships[0].source).toEqual({ kind: 'library', model: 'fct_order', index: 0 });
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([['REL009', 'info']]);
    expect(diagnostics[0].message).toMatch(/also in gold\/x\.json/);
  });

  it('fixes endpoint spelling to the real names (REL005) — a case-only match is drawn, not lost', () => {
    const own = [m2o('FCT_Order', 'Customer_Key', 'dim_CUSTOMER', 'customer_KEY')];
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct(), dim()], own });
    expect(stripRelationshipProvenance(relationships[0])).toEqual(TO_CUSTOMER);
    expect(relationships[0].stored).toEqual({ fromModel: 'FCT_Order', fromColumn: 'Customer_Key', toModel: 'dim_CUSTOMER', toColumn: 'customer_KEY' });
    expect(codes(diagnostics)).toEqual(['REL005']);
  });

  it('respells a library entry\'s target too, and keeps a column it cannot find as written', () => {
    const { relationships, diagnostics } = normaliseRelationships({
      models: [fct([lib(m2o('fct_order', 'customer_key', 'DIM_customer', 'gone'))]), dim()],
      own: [],
    });
    expect(relationships[0]).toMatchObject({ toModel: 'dim_customer', toColumn: 'gone' });
    expect(codes(diagnostics)).toEqual(['REL005']);
  });

  it('flags a direction that contradicts certain key evidence (REL006, info only)', () => {
    const backwards = m2o('dim_customer', 'customer_key', 'fct_order', 'customer_key');
    const { relationships, diagnostics } = normaliseRelationships({ models: [fct(), dim([lib(backwards)])], own: [] });
    expect(relationships[0].issues).toEqual(['REL006']);
    expect(diagnostics).toMatchObject([{ code: 'REL006', severity: 'info' }]);
    expect(diagnostics[0].message).toMatch(/fct_order\.customer_key is marked as a foreign key/);
  });

  it('surfaces entries the model reader skipped (REL008), with the line', () => {
    const model = parseLogicalModelText([
      'name: fct_order',
      'columns:',
      '  - { name: customer_key, dataType: INT }',
      'relationships:',
      '  - { fromColumn: customer_key, toModel: dim_customer, toColumn: customer_key, cardinality: one_to_many }',
    ].join('\n'), 'fct_order')!;
    const { relationships, diagnostics } = normaliseRelationships({ models: [model, dim()], own: [] });
    expect(relationships).toHaveLength(1);
    expect(diagnostics).toMatchObject([{ code: 'REL008', severity: 'error' }]);
    expect(diagnostics[0].message).toMatch(/"one_to_many".*\(line 5\)/);
  });

  it('ignores library entries whose other end is not in the domain', () => {
    expect(normaliseRelationships({ models: [fct([lib(TO_CUSTOMER)])], own: [] }).relationships).toEqual([]);
  });

  it('keeps domain records whose ends are not in the domain (the canvas decides), as written', () => {
    const own = [m2o('ghost', 'k', 'other', 'k')];
    expect(normaliseRelationships({ models: [], own }).relationships.map((r) => stripRelationshipProvenance(r))).toEqual(own);
  });

  it('reads a model listed twice once', () => {
    const f = fct([lib(TO_CUSTOMER)]);
    const { relationships, diagnostics } = normaliseRelationships({ models: [f, dim(), f], own: [] });
    expect(relationships).toHaveLength(1);
    expect(diagnostics).toEqual([]);
  });

  it('turns a self-reference stored one-to-many round within the same model', () => {
    const staff: SemanticModel = {
      name: 'staff',
      columns: [col('staff_id', { isPrimaryKey: true }), col('manager_id')],
      relationships: [{ fromColumn: 'staff_id', toModel: 'staff', toColumn: 'manager_id', cardinality: 'one-to-many' }],
    };
    const { relationships } = normaliseRelationships({ models: [staff], own: [] });
    expect(stripRelationshipProvenance(relationships[0])).toEqual(m2o('staff', 'manager_id', 'staff', 'staff_id'));
  });

  it('never reads library relationships from inline v4 models', () => {
    const doc = {
      schemaVersion: 4, domain: 'd', layer: 'bronze',
      logical: { models: [{ ...fct(), relationships: [lib(TO_CUSTOMER)] }, dim()], relationships: [REVERSED] },
      viewConfig: {},
    };
    const u = buildUnifiedDomain(doc, 'v4', {
      filePath: 'bronze/d.json', domainNameFallback: 'd', parentDirName: 'bronze',
      layers: { hasLayer: () => true, getValidLayerIds: () => ['bronze'] }, warn: () => {},
    });
    expect(u.logical.relationships).toEqual([{
      ...TO_CUSTOMER,
      source: { kind: 'domain', index: 0 },
      stored: { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' },
    }]);
  });

  it('hands every diagnostic, info included, to onRelationshipDiagnostics', () => {
    const seen: RelationshipDiagnostic[][] = [];
    const warned: string[] = [];
    buildUnifiedDomain(
      { schemaVersion: 5, domain: 'd', layer: 'silver', logical: { models: ['fct_order', 'dim_customer'], relationships: [REVERSED] }, viewConfig: {} },
      'v5',
      {
        filePath: 'silver/d.json', domainNameFallback: 'd', parentDirName: 'silver',
        layers: { hasLayer: () => true, getValidLayerIds: () => ['silver'] },
        getModel: (name) => (name === 'fct_order' ? fct([lib(TO_CUSTOMER)]) : dim()),
        warn: (m) => warned.push(m),
        onRelationshipDiagnostics: (d) => seen.push(d),
      },
    );
    expect(seen.map(codes)).toEqual([['REL009']]);
    expect(warned).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Property tests (R12): seeded, no dependency
// ---------------------------------------------------------------------------

/** mulberry32: a small, well-mixed seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARDINALITIES: Cardinality[] = ['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'];

/** Randomly flip the case of some letters. */
function caseVariant(next: () => number, s: string): string {
  if (next() < 0.7) return s;
  return [...s].map((ch) => (next() < 0.5 ? ch.toUpperCase() : ch)).join('');
}

interface World {
  models: SemanticModel[];
  own: Relationship[];
}

/**
 * A random domain: 2–5 models sharing column names (`id`, `key`, `ref`), with
 * library relationships (some self-references, random directions and
 * cardinalities, duplicates across files, case variants, roles) and domain
 * copies of the same and other links.
 */
function world(seed: number): World {
  const next = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];
  const names = ['m_a', 'm_b', 'm_c', 'm_d', 'm_e'].slice(0, 2 + Math.floor(next() * 4));
  const columns = ['id', 'key', 'ref'];
  const randomRel = (): Relationship => {
    const fromModel = pick(names);
    const toModel = next() < 0.15 ? fromModel : pick(names);
    const fromColumn = pick(columns);
    let toColumn = pick(columns);
    if (fromModel === toModel && toColumn === fromColumn) toColumn = columns[(columns.indexOf(fromColumn) + 1) % columns.length];
    return {
      fromModel, fromColumn, toModel, toColumn,
      cardinality: pick(CARDINALITIES),
      ...(next() < 0.2 ? { role: pick(['ship', 'order', 'bill']) } : {}),
    };
  };
  const pool = Array.from({ length: 1 + Math.floor(next() * 5) }, randomRel);
  const variant = (r: Relationship): Relationship => {
    const reversed = next() < 0.4;
    const base = reversed && r.cardinality !== 'one-to-one'
      ? { ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn,
          cardinality: r.cardinality === 'many-to-one' ? 'one-to-many' as const : r.cardinality === 'one-to-many' ? 'many-to-one' as const : r.cardinality }
      : r;
    return {
      ...base,
      fromColumn: caseVariant(next, base.fromColumn),
      toModel: caseVariant(next, base.toModel),
      toColumn: caseVariant(next, base.toColumn),
      ...(next() < 0.1 ? { cardinality: pick(CARDINALITIES) } : {}),
    };
  };
  const libraryRels = new Map<string, ModelRelationship[]>(names.map((n) => [n, []]));
  const own: Relationship[] = [];
  for (let i = 0; i < 2 + Math.floor(next() * 8); i++) {
    const r = variant(pick(pool));
    if (next() < 0.6) {
      const { fromModel, ...rest } = r;
      libraryRels.get(fromModel)!.push(rest);
    } else {
      own.push({ ...r, fromModel: caseVariant(next, r.fromModel) });
    }
  }
  const models: SemanticModel[] = names.map((name) => ({
    name,
    columns: columns.map((c) => ({ name: c, dataType: 'INT', description: '', ...(c === 'id' ? { isPrimaryKey: true } : {}) })),
    ...(libraryRels.get(name)!.length ? { relationships: libraryRels.get(name)! } : {}),
  }));
  return { models, own };
}

function shuffle<T>(seed: number, xs: readonly T[]): T[] {
  const next = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i * 7919 + 13);

describe('normaliseRelationships properties (seeded)', () => {
  it('the generator reaches every case the properties are about', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const w = world(seed);
      const { relationships, diagnostics } = normaliseRelationships(w);
      for (const d of diagnostics) seen.add(`${d.code}:${d.severity}`);
      if (relationships.some((r) => r.fromModel === r.toModel)) seen.add('self-reference');
      if (w.own.length > 0 && w.models.some((m) => m.relationships?.length)) seen.add('library+domain');
    }
    for (const expected of ['REL001:warning', 'REL001:error', 'REL002:warning', 'REL005:warning', 'REL009:info', 'self-reference', 'library+domain']) {
      expect(seen, expected).toContain(expected);
    }
  });

  it('draws each link once, canonically, with real names and provenance pointing at a real record', () => {
    for (const seed of SEEDS) {
      const w = world(seed);
      const { relationships } = normaliseRelationships(w);
      const keys = relationships.map(linkKey);
      expect(new Set(keys).size).toBe(keys.length);
      const names = new Set(w.models.map((m) => m.name));
      for (const r of relationships) {
        expect(r.cardinality).not.toBe('one-to-many');
        expect(names.has(r.fromModel) || r.source?.kind === 'domain').toBe(true);
        const src = r.source!;
        const stored = src.kind === 'library'
          ? { ...w.models.find((m) => m.name === src.model)!.relationships![src.index], fromModel: src.model }
          : w.own[src.index];
        expect(r.stored).toEqual({ fromModel: stored.fromModel, fromColumn: stored.fromColumn, toModel: stored.toModel, toColumn: stored.toColumn });
        expect(linkKey(stored)).toBe(linkKey(r));
      }
    }
  });

  it('preserves meaning: every record\'s link is drawn, and a lone record is drawn as its canonical self', () => {
    for (const seed of SEEDS) {
      const w = world(seed);
      const { relationships } = normaliseRelationships(w);
      const drawn = new Map(relationships.map((r) => [linkKey(r), r]));
      const records: Relationship[] = [
        ...w.own,
        ...w.models.flatMap((m) => (m.relationships ?? []).map((r) => ({ ...r, fromModel: m.name }))),
      ];
      const count = new Map<string, number>();
      for (const r of records) count.set(linkKey(r), (count.get(linkKey(r)) ?? 0) + 1);
      for (const r of records) {
        const d = drawn.get(linkKey(r));
        expect(d, `seed ${seed}: ${linkKey(r)}`).toBeDefined();
        if (count.get(linkKey(r)) === 1) {
          const c = canonicalRelationship(r);
          expect(d!.cardinality).toBe(c.cardinality);
          expect(d!.role).toBe(c.role);
          expect(`${d!.fromModel}.${d!.fromColumn}`.toLowerCase()).toBe(`${c.fromModel}.${c.fromColumn}`.toLowerCase());
        }
      }
    }
  });

  it('is idempotent: normalising what is drawn draws it again unchanged', () => {
    for (const seed of SEEDS) {
      const w = world(seed);
      const once = normaliseRelationships(w).relationships.map((r) => stripRelationshipProvenance(r));
      const bare = w.models.map(({ relationships: _r, ...m }) => m);
      const twice = normaliseRelationships({ models: bare, own: once });
      expect(twice.relationships.map((r) => stripRelationshipProvenance(r))).toEqual(once);
      expect(twice.diagnostics.filter((d) => d.code !== 'REL006')).toEqual([]);
    }
  });

  it('never depends on the order of the domain\'s models', () => {
    for (const seed of SEEDS) {
      const w = world(seed);
      const base = normaliseRelationships(w);
      for (const s of [1, 2, 3]) {
        const shuffled = normaliseRelationships({ models: shuffle(seed + s, w.models), own: w.own });
        expect(shuffled.relationships).toEqual(base.relationships);
        // The whole result, diagnostics in order included — not only their codes.
        expect(shuffled.diagnostics).toEqual(base.diagnostics);
      }
    }
  });

  it('orders the diagnostics the same whichever way round the models are listed (REL008 and library-only links)', () => {
    const issue = (message: string): RelationshipReadIssue[] => [{ index: 9, reason: 'missing-endpoint', skipped: true, message }];
    const f: SemanticModel = { ...fct([lib(TO_CUSTOMER)]), relationshipIssues: issue('fct bad') };
    const d: SemanticModel = { ...dim([lib({ ...TO_CUSTOMER, fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' })]), relationshipIssues: issue('dim bad') };
    const g: SemanticModel = { name: 'dim_geo', columns: [col('geo_key', { isPrimaryKey: true })], relationshipIssues: issue('geo bad') };
    const fwd = normaliseRelationships({ models: [f, d, g], own: [] });
    const back = normaliseRelationships({ models: [g, d, f], own: [] });
    expect(fwd.diagnostics.length).toBeGreaterThanOrEqual(4);
    expect(back).toEqual(fwd);
  });
});

describe('normaliseRelationships — models whose names differ only in case', () => {
  const t: SemanticModel = { name: 'T', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }] };
  const holder = (name: string, cardinality: Cardinality): SemanticModel => ({
    name,
    columns: [{ name: 'x', dataType: 'INT', description: '' }],
    relationships: [{ fromColumn: 'x', toModel: 'T', toColumn: 'id', cardinality }],
  });
  const dd1 = holder('Dd', 'many-to-one');
  const dd2 = holder('DD', 'many-to-many');

  it('draws the same winner whatever order the domain lists them in', () => {
    const orders = [[t, dd1, dd2], [t, dd2, dd1], [dd2, dd1, t], [dd1, t, dd2]];
    const drawn = orders.map((models) => normaliseRelationships({ models, own: [] }).relationships);
    for (const result of drawn) expect(result).toEqual(drawn[0]);
    // 'DD' < 'Dd' by exact name: DD's copy is drawn.
    expect(drawn[0]).toHaveLength(1);
    expect(drawn[0][0]).toMatchObject({ fromModel: 'DD', cardinality: 'many-to-many', source: { kind: 'library', model: 'DD', index: 0 } });
  });
});
