/**
 * The one write path for canvas relationship edits (issue #133, R4):
 * `planRelationshipCommit`, plus the identity rule every library helper now
 * shares (core's `linkKey`: either way round, without case) and the findings
 * helpers the canvas uses for its banner and notification.
 *
 * The property tests drive a seeded generator (no dependency): random models
 * with case variants, self-references, same-named columns, random directions,
 * duplicate and reversed copies across files, and random ops. After every
 * successful commit the link has exactly one record, at its home for the
 * mode, never `one-to-many` — and every other record is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { canonicalRelationship, checkRelationships, linkKey, parseLogicalModelText, type RelationshipEnds } from '@erd-studio/core';

import {
  RelationshipCommitError,
  describeRepairOffer,
  findingsForDomain,
  findingsNeedingRepair,
  planRelationshipCommit,
  removeLibraryRelationships,
  renameColumnInRelationships,
  renameModelInRelationships,
  resolveEndpointModels,
  routeToLibrary,
  toDisplayRelationshipIssues,
  upsertLibraryRelationship,
  type RelationshipCommitOp,
  type RelationshipMode,
} from '../../src/services/libraryRelationships';
import type { Cardinality, Relationship, SemanticModel } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, dataType: 'string', description: '', ...extra });
const FCT = (): SemanticModel => ({
  name: 'fct_order',
  columns: [col('order_key', { isPrimaryKey: true }), col('customer_key'), col('ship_date_key')],
});
const DIM = (): SemanticModel => ({ name: 'dim_customer', columns: [col('customer_key', { isPrimaryKey: true })] });
const EDGE: RelationshipEnds = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };
const REVERSED: RelationshipEnds = { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key' };
const ENTRY = { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const };

const plan = (mode: RelationshipMode, op: RelationshipCommitOp, models: SemanticModel[], domain: Relationship[] = []) =>
  planRelationshipCommit({ mode, op, endpointModels: models, domainRelationships: domain });

// ---------------------------------------------------------------------------
// Unit behaviour
// ---------------------------------------------------------------------------

describe('planRelationshipCommit — library mode', () => {
  it('adds a one-to-many drawn from the dimension to the fact, as many-to-one', () => {
    const fct = FCT();
    const dim = DIM();
    const result = plan('library', { kind: 'add', rel: { ...REVERSED, cardinality: 'one-to-many' } }, [fct, dim]);
    expect(fct.relationships).toEqual([ENTRY]);
    expect(dim.relationships).toBeUndefined();
    expect(result.changedModels).toEqual([fct]);
    expect(result.written).toEqual({ where: 'library', model: 'fct_order', index: 0 });
    expect(result.domainChanged).toBe(false);
  });

  it('refuses a link already stored anywhere in scope, either way round and in any case', () => {
    const dim = { ...DIM(), relationships: [{ fromColumn: 'Customer_Key', toModel: 'FCT_ORDER', toColumn: 'customer_key', cardinality: 'one-to-many' as const }] };
    expect(() => plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' } }, [FCT(), dim]))
      .toThrow(new RelationshipCommitError('This relationship already exists.'));
    expect(() => plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' } }, [FCT(), DIM()], [{ ...REVERSED, cardinality: 'one-to-many' }]))
      .toThrow('This relationship already exists.');
  });

  it('removing by the drawn ends takes out every copy — reversed, one-to-many, in the domain file too (D6)', () => {
    const fct = { ...FCT(), relationships: [{ ...ENTRY }] };
    const dim = { ...DIM(), relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' as const }] };
    const domain: Relationship[] = [{ ...REVERSED, cardinality: 'one-to-many' }];
    const result = plan('library', { kind: 'remove', stored: [EDGE] }, [fct, dim], domain);
    expect(fct.relationships).toBeUndefined();
    expect(dim.relationships).toBeUndefined();
    expect(result.domainRelationships).toEqual([]);
    expect(result.changedModels).toEqual([fct, dim]);
  });

  it('update reads the cardinality in the drawn direction, keeps the role, and re-homes a REL002 copy', () => {
    // Stored on the dimension as one-to-many: drawn fct → dim many-to-one.
    const fct = FCT();
    const dim = { ...DIM(), relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' as const, role: 'buyer' }] };
    // The canvas sends the stored ends (dim → fct): it is still the drawn direction a cardinality is read in.
    plan('library', { kind: 'update', stored: REVERSED, cardinality: 'one-to-one' }, [fct, dim]);
    expect(fct.relationships).toEqual([{ ...ENTRY, cardinality: 'one-to-one', role: 'buyer' }]);
    expect(dim.relationships).toBeUndefined();
  });

  it('⇄ (one-to-many on the drawn ends) moves the record to the other model', () => {
    const fct = { ...FCT(), relationships: [{ ...ENTRY, role: 'buyer' }] };
    const dim = DIM();
    plan('library', { kind: 'update', stored: EDGE, cardinality: 'one-to-many' }, [fct, dim]);
    expect(fct.relationships).toBeUndefined();
    expect(dim.relationships).toEqual([{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'buyer' }]);
  });

  it('an edit keeps the record in its place in the home file', () => {
    const other = { fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' as const };
    const fct = { ...FCT(), relationships: [{ ...other }, { ...ENTRY }, { ...other, fromColumn: 'order_key' }] };
    const result = plan('library', { kind: 'edit', stored: EDGE, next: { ...EDGE, cardinality: 'one-to-one', role: 'owner' } }, [fct, DIM()]);
    expect(fct.relationships?.[1]).toEqual({ ...ENTRY, cardinality: 'one-to-one', role: 'owner' });
    expect(fct.relationships?.[0]).toEqual(other);
    expect(result.written).toEqual({ where: 'library', model: 'fct_order', index: 1 });
  });

  it('an edit onto a link stored elsewhere is refused; onto its own link (another direction) is not', () => {
    const fct = { ...FCT(), relationships: [{ ...ENTRY }, { fromColumn: 'order_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const }] };
    expect(() => plan('library', {
      kind: 'edit', stored: EDGE, next: { ...EDGE, fromColumn: 'order_key', cardinality: 'many-to-one' },
    }, [fct, DIM()])).toThrow('A relationship with this key already exists.');
    expect(() => plan('library', {
      kind: 'edit', stored: EDGE, next: { ...REVERSED, cardinality: 'one-to-many' },
    }, [structuredClone(fct), DIM()])).not.toThrow();
  });

  it('a missing link is "Relationship not found." for update, edit and remove', () => {
    for (const op of [
      { kind: 'update', stored: EDGE, cardinality: 'one-to-one' },
      { kind: 'edit', stored: EDGE, next: { ...EDGE, cardinality: 'one-to-one' } },
      { kind: 'remove', stored: [EDGE] },
    ] as RelationshipCommitOp[]) {
      expect(() => plan('library', op, [FCT(), DIM()])).toThrow('Relationship not found.');
    }
  });

  it('writes the real model and column names (no REL005 is ever written)', () => {
    const fct = FCT();
    plan('library', { kind: 'add', rel: { fromModel: 'FCT_ORDER', fromColumn: 'Customer_Key', toModel: 'Dim_Customer', toColumn: 'CUSTOMER_KEY', cardinality: 'many-to-one' } }, [fct, DIM()]);
    expect(fct.relationships).toEqual([ENTRY]);
  });

  it('a home model without a file is reported with the host\'s message', () => {
    expect(() => planRelationshipCommit({
      mode: 'library', op: { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' } }, endpointModels: [DIM()], domainRelationships: [],
      describeMissingModel: (name) => `Model "${name}" not found in logical-models/.`,
    })).toThrow('Model "fct_order" not found in logical-models/.');
  });

  it('markKey marks the column as its model\'s key in the same commit, and only an end of the link', () => {
    const fct = FCT();
    const dim = { ...DIM(), columns: [col('customer_key')] };
    const result = plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' }, markKey: { model: 'dim_customer', column: 'Customer_Key' } }, [fct, dim]);
    expect(dim.columns?.[0].isPrimaryKey).toBe(true);
    expect(result.changedModels).toEqual([fct, dim]);
    const untouched = FCT();
    expect(() => plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' }, markKey: { model: 'fct_order', column: 'order_key' } }, [untouched, DIM()]))
      .toThrow("Can't mark fct_order.order_key as a key");
    expect(untouched.relationships).toBeUndefined();
  });

  it('markKey refuses a model that already has a primary key, leaving every model untouched (#133 review)', () => {
    const fct = FCT();
    const dim = { ...DIM(), columns: [col('customer_key', { isPrimaryKey: true }), col('id')] };
    const snapshot = JSON.stringify([fct, dim]);
    expect(() => plan('library', {
      kind: 'add',
      rel: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'id', cardinality: 'many-to-one' },
      markKey: { model: 'dim_customer', column: 'id' },
    }, [fct, dim])).toThrow("Can't mark dim_customer.id as dim_customer's key: dim_customer already has a primary key (customer_key). Re-open the dialog and try again.");
    expect(JSON.stringify([fct, dim])).toBe(snapshot);
  });

  it('markKey refuses the many side\'s foreign key, but takes either end of a one-to-one (#133 review)', () => {
    const fct = { ...FCT(), columns: [col('order_key'), col('customer_key')] };
    const dim = { ...DIM(), columns: [col('customer_key')] };
    expect(() => plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'many-to-one' }, markKey: { model: 'fct_order', column: 'customer_key' } }, [fct, dim]))
      .toThrow("Can't mark fct_order.customer_key as fct_order's key: it is the many side of this relationship");
    expect(fct.columns.some((c) => c.isPrimaryKey)).toBe(false);
    expect(fct.relationships).toBeUndefined();

    plan('library', { kind: 'add', rel: { ...EDGE, cardinality: 'one-to-one' }, markKey: { model: 'fct_order', column: 'customer_key' } }, [fct, dim]);
    expect(fct.columns[1].isPrimaryKey).toBe(true);
  });

  it('names other domain files still drawing a removed link from their own copy', () => {
    const result = planRelationshipCommit({
      mode: 'library',
      op: { kind: 'remove', stored: [EDGE] },
      endpointModels: [{ ...FCT(), relationships: [{ ...ENTRY }] }, DIM()],
      domainRelationships: [],
      otherDomains: [
        { label: 'silver/sales.json', models: ['fct_order', 'DIM_CUSTOMER'], relationships: [{ ...REVERSED, cardinality: 'one-to-many' }] },
        { label: 'silver/finance.json', models: ['fct_order'], relationships: [{ ...EDGE, cardinality: 'many-to-one' }] },
        { label: 'gold/reporting.json', models: ['fct_order', 'dim_customer'], relationships: [] },
      ],
    });
    expect(result.otherDomainCopies).toEqual(['silver/sales.json']);
  });
});

describe('planRelationshipCommit — domain mode (R3)', () => {
  it('writes to the domain file, canonical, and never touches a model file\'s relationships', () => {
    const fct = FCT();
    const dim = DIM();
    const result = plan('domain', { kind: 'add', rel: { ...REVERSED, cardinality: 'one-to-many', role: ' buyer ' } }, [fct, dim]);
    expect(result.domainRelationships).toEqual([{ ...EDGE, cardinality: 'many-to-one', role: 'buyer' }]);
    expect(result.changedModels).toEqual([]);
    expect(result.written).toEqual({ where: 'domain', index: 0 });
  });

  it('an update of a domain record stored one-to-many rewrites it canonical in place', () => {
    const other: Relationship = { fromModel: 'fct_order', fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' };
    const result = plan('domain', { kind: 'update', stored: EDGE, cardinality: 'one-to-one' }, [], [other, { ...REVERSED, cardinality: 'one-to-many' }, other]);
    expect(result.domainRelationships).toEqual([other, { ...EDGE, cardinality: 'one-to-one' }, other]);
  });

  it('ignores library entries: they are not drawn by this domain', () => {
    const fct = { ...FCT(), relationships: [{ ...ENTRY }] };
    const result = plan('domain', { kind: 'add', rel: { ...EDGE, cardinality: 'one-to-one' } }, [fct, DIM()]);
    expect(fct.relationships).toEqual([ENTRY]);
    expect(result.domainRelationships).toEqual([{ ...EDGE, cardinality: 'one-to-one' }]);
  });
});

describe('the identity rule in the library helpers (D6/D7)', () => {
  it('removeLibraryRelationships removes a reversed, differently cased copy', () => {
    const dim = { ...DIM(), relationships: [{ fromColumn: 'CUSTOMER_KEY', toModel: 'Fct_Order', toColumn: 'customer_key', cardinality: 'one-to-many' as const }] };
    expect(removeLibraryRelationships([dim], [EDGE])).toEqual([dim]);
    expect(dim.relationships).toBeUndefined();
  });

  it('upsertLibraryRelationship replaces the same link stored the other way round, once', () => {
    const fct = { ...FCT(), relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' as const }, { ...ENTRY }] };
    expect(upsertLibraryRelationship(fct, { ...EDGE, cardinality: 'many-to-one' })).toBe(true);
    expect(fct.relationships).toEqual([ENTRY]);
  });

  it('column and model renames match without case', () => {
    const fct = { ...FCT(), relationships: [{ fromColumn: 'Customer_Key', toModel: 'DIM_CUSTOMER', toColumn: 'Customer_Key', cardinality: 'many-to-one' as const }] };
    renameColumnInRelationships([fct], 'fct_order', 'customer_key', 'cust_key');
    renameColumnInRelationships([fct], 'dim_customer', 'customer_key', 'customer_sk');
    renameModelInRelationships([fct], 'dim_customer', 'dim_client');
    expect(fct.relationships).toEqual([{ fromColumn: 'cust_key', toModel: 'dim_client', toColumn: 'customer_sk', cardinality: 'many-to-one' }]);
  });

  it('routeToLibrary skips a link either end already stores, in any direction or case', () => {
    const fct = { ...FCT(), relationships: [{ fromColumn: 'CUSTOMER_KEY', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' as const }] };
    const { kept, changed } = routeToLibrary([{ ...REVERSED, cardinality: 'one-to-many' }], [], (name) => (name === 'fct_order' ? fct : DIM()));
    expect(kept).toEqual([]);
    expect(changed).toEqual([]);
  });
});

describe('findings the canvas shows', () => {
  const libraryModels = () => [
    { model: { ...DIM(), relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'one-to-many' as const }] }, file: 'lm/dim_customer.yml' },
    { model: { ...FCT(), relationships: [{ fromColumn: 'ship_date_key', toModel: 'dim_gone', toColumn: 'date_key', cardinality: 'many-to-one' as const }] }, file: 'lm/fct_order.yml' },
    { model: { name: 'dim_other', columns: [col('id')] }, file: 'lm/dim_other.yml' },
  ];

  it('keeps what concerns the domain and names why a repair is offered', () => {
    const findings = checkRelationships({ libraryModels: libraryModels(), domains: [] });
    const mine = findingsForDomain(findings, { filePath: 'silver/orders.json', models: ['fct_order', 'dim_customer'], modelFiles: ['lm/fct_order.yml', 'lm/dim_customer.yml'] });
    expect(mine.map((f) => f.code).sort()).toEqual(['REL002', 'REL003']);
    const elsewhere = findingsForDomain(findings, { filePath: 'silver/other.json', models: ['dim_other', 'dim_customer'], modelFiles: [] });
    expect(elsewhere).toEqual([]);
    expect(findingsNeedingRepair(findings).map((f) => f.code).sort()).toEqual(['REL002', 'REL003']);
    expect(describeRepairOffer(findings)).toBe('2 relationships need attention (1 saved in the file of the model it points at; ' +
      '1 pointing at a model that is not in the model library). Review the fixes with Repair Relationships…? Nothing changes until you confirm.');
    expect(toDisplayRelationshipIssues(mine).map((i) => Object.keys(i).sort())).toEqual([
      ['code', 'link', 'message', 'severity'], ['code', 'link', 'message', 'severity'],
    ]);
  });

  it('a v4 diagram gets only its own file\'s findings, never the library\'s it does not draw (#133 review)', () => {
    const findings = checkRelationships({
      libraryModels: libraryModels(),
      domains: [{
        label: 'gold/legacy', filePath: 'gold/legacy.json', mode: 'domain', olderFormat: true,
        models: [FCT(), DIM()],
        relationships: [{ ...EDGE, toColumn: 'nope', cardinality: 'many-to-one' }],
      }],
    });
    const v4 = findingsForDomain(findings, {
      filePath: 'gold/legacy.json', models: ['fct_order', 'dim_customer'], modelFiles: ['lm/fct_order.yml', 'lm/dim_customer.yml'], olderFormat: true,
    });
    expect(v4.map((f) => f.code)).toEqual(['REL004']);
    expect(v4.every((f) => f.files.includes('gold/legacy.json'))).toBe(true);
  });

  it('counts relationships, not findings: one link missing both its columns is one relationship', () => {
    const findings = checkRelationships({
      libraryModels: [
        { model: { ...FCT(), relationships: [{ fromColumn: 'no_such', toModel: 'dim_customer', toColumn: 'nor_this', cardinality: 'many-to-one' as const }] }, file: 'lm/fct_order.yml' },
        { model: DIM(), file: 'lm/dim_customer.yml' },
      ],
      domains: [],
    });
    expect(findingsNeedingRepair(findings).map((f) => f.code)).toEqual(['REL004', 'REL004']);
    expect(describeRepairOffer(findings)).toBe('1 relationship needs attention (1 pointing at a column its model does not have). ' +
      'Review the fixes with Repair Relationships…? Nothing changes until you confirm.');
  });

  it('offers nothing for info-only findings', () => {
    expect(describeRepairOffer([{ code: 'REL006', severity: 'info', message: 'x', files: [] }])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Property tests (seeded, no dependency)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
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

interface World {
  mode: RelationshipMode;
  models: SemanticModel[];
  domain: Relationship[];
  op: RelationshipCommitOp;
}

function generate(seed: number): World {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const caseVariant = (s: string): string => (rnd() < 0.2 ? (rnd() < 0.5 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1)) : s);
  const names = ['fct', 'dim', 'brg'].slice(0, 2 + Math.floor(rnd() * 2));
  const models: SemanticModel[] = names.map((name) => ({
    name,
    // Same-named columns across models on purpose.
    columns: ['id', 'key', 'ref'].map((c) => col(c, rnd() < 0.3 ? { isPrimaryKey: true } : {})),
  }));
  const randomEnds = (): RelationshipEnds => {
    const from = pick(models);
    const to = rnd() < 0.15 ? from : pick(models); // self-references
    return {
      fromModel: caseVariant(from.name), fromColumn: caseVariant(pick(from.columns!).name),
      toModel: caseVariant(to.name), toColumn: caseVariant(pick(to.columns!).name),
    };
  };
  const randomRel = (): Relationship => ({
    ...randomEnds(),
    cardinality: pick(CARDINALITIES),
    ...(rnd() < 0.3 ? { role: pick(['buyer', 'seller', '']) } : {}),
  });
  const mode: RelationshipMode = rnd() < 0.6 ? 'library' : 'domain';
  const all: Relationship[] = [];
  for (const model of models) {
    const count = Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      const rel = { ...randomRel(), fromModel: model.name };
      const { fromModel: _f, ...entry } = rel;
      model.relationships = [...(model.relationships ?? []), entry];
      all.push(rel);
    }
  }
  const domain: Relationship[] = [];
  for (let i = Math.floor(rnd() * 4); i > 0; i--) {
    // Copies of library links (either way round) and fresh ones.
    const base = all.length > 0 && rnd() < 0.5 ? pick(all) : randomRel();
    domain.push(rnd() < 0.5 ? base : {
      ...base, fromModel: base.toModel, fromColumn: base.toColumn, toModel: base.fromModel, toColumn: base.fromColumn,
    });
  }
  const existing = [...(mode === 'library' ? all : []), ...domain];
  const known = (): RelationshipEnds => (existing.length > 0 && rnd() < 0.8 ? pick(existing) : randomEnds());
  const kind = pick(['add', 'update', 'edit', 'remove'] as const);
  const op: RelationshipCommitOp =
    kind === 'add' ? { kind, rel: randomRel() }
      : kind === 'update' ? { kind, stored: known(), cardinality: pick(CARDINALITIES) }
        : kind === 'edit' ? { kind, stored: known(), next: rnd() < 0.5 ? { ...known(), cardinality: pick(CARDINALITIES) } : randomRel() }
          : { kind, stored: [known(), ...(rnd() < 0.3 ? [known()] : [])] };
  return { mode, models, domain, op };
}

/** Every record in the commit's scope, with where it is. */
function records(mode: RelationshipMode, models: readonly SemanticModel[], domain: readonly Relationship[]) {
  const out: Array<{ where: string; rel: Relationship }> = [];
  if (mode === 'library') {
    for (const m of models) for (const e of m.relationships ?? []) out.push({ where: m.name, rel: { fromModel: m.name, ...e } });
  }
  for (const r of domain) out.push({ where: '<domain>', rel: r });
  return out;
}

describe('planRelationshipCommit — properties over 400 seeded worlds', () => {
  const seeds = Array.from({ length: 400 }, (_, i) => 1000 + i * 7919);

  it('one record per touched link, at its home, canonical; nothing else changes', () => {
    let committed = 0;
    let refused = 0;
    for (const seed of seeds) {
      const world = generate(seed);
      const before = structuredClone(world);
      const models = structuredClone(world.models);
      let result;
      try {
        result = planRelationshipCommit({ mode: world.mode, op: world.op, endpointModels: models, domainRelationships: world.domain });
      } catch (err) {
        expect(err, `seed ${seed}`).toBeInstanceOf(RelationshipCommitError);
        // A refusal changes nothing.
        expect(models, `seed ${seed}`).toEqual(before.models);
        refused++;
        continue;
      }
      committed++;
      const op = world.op;
      const cleared = new Set(op.kind === 'remove' ? op.stored.map(linkKey) : [linkKey(op.kind === 'add' ? op.rel : op.stored)]);
      const nextKey = op.kind === 'add' ? linkKey(op.rel) : op.kind === 'edit' ? linkKey(op.next) : op.kind === 'update' ? linkKey(op.stored) : null;
      const touched = new Set([...cleared, ...(nextKey ? [nextKey] : [])]);
      const after = records(world.mode, models, result.domainRelationships);

      // R2/R3: the link written has exactly one record, at its home for the mode, never one-to-many.
      if (nextKey) {
        const mine = after.filter((r) => linkKey(r.rel) === nextKey);
        expect(mine, `seed ${seed}`).toHaveLength(1);
        expect(mine[0].rel.cardinality, `seed ${seed}`).not.toBe('one-to-many');
        expect(canonicalRelationship(mine[0].rel), `seed ${seed}`).toEqual(mine[0].rel);
        if (world.mode === 'library') expect(mine[0].where.toLowerCase(), `seed ${seed}`).toBe(mine[0].rel.fromModel.toLowerCase());
        else expect(mine[0].where, `seed ${seed}`).toBe('<domain>');
      }
      // Every other link cleared is gone.
      for (const key of cleared) {
        if (key === nextKey) continue;
        expect(after.filter((r) => linkKey(r.rel) === key), `seed ${seed}`).toEqual([]);
      }
      // Every record of every other link is unchanged, in order, in its place.
      const untouched = (list: ReturnType<typeof records>) =>
        list.filter((r) => !touched.has(linkKey(r.rel))).map((r) => JSON.stringify(r));
      expect(untouched(after), `seed ${seed}`).toEqual(untouched(records(world.mode, before.models, before.domain)));
      // Domain mode never touches a model file's relationships.
      if (world.mode === 'domain') {
        expect(models.map((m) => m.relationships), `seed ${seed}`).toEqual(before.models.map((m) => m.relationships));
      }
      // Changed models are exactly those whose relationships differ.
      const changedNames = models.filter((m, i) => JSON.stringify(m) !== JSON.stringify(before.models[i])
        || (result.written?.where === 'library' && result.written.model === m.name)).map((m) => m.name);
      expect(result.changedModels.map((m) => m.name).sort(), `seed ${seed}`).toEqual(changedNames.sort());
    }
    // The generator really exercises both outcomes.
    expect(committed).toBeGreaterThan(150);
    expect(refused).toBeGreaterThan(20);
  });

  it('an update applied twice is the same as applied once (idempotent) — one-to-many, the ⇄ swap, excepted', () => {
    let checked = 0;
    for (const seed of seeds) {
      const world = generate(seed);
      // One-to-many is read against the drawn direction: it turns the link round each time, by design.
      if (world.op.kind !== 'update' || world.op.cardinality === 'one-to-many') continue;
      const once = structuredClone(world.models);
      let first;
      try {
        first = planRelationshipCommit({ mode: world.mode, op: world.op, endpointModels: once, domainRelationships: world.domain });
      } catch {
        continue;
      }
      const twice = structuredClone(once);
      const second = planRelationshipCommit({ mode: world.mode, op: world.op, endpointModels: twice, domainRelationships: first.domainRelationships });
      expect(twice, `seed ${seed}`).toEqual(once);
      expect(second.domainRelationships, `seed ${seed}`).toEqual(first.domainRelationships);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('remove then add of the same link leaves it stored once, at home', () => {
    for (const seed of seeds.slice(0, 200)) {
      const world = generate(seed);
      if (world.op.kind !== 'remove') continue;
      const models = structuredClone(world.models);
      let removed;
      try {
        removed = planRelationshipCommit({ mode: world.mode, op: world.op, endpointModels: models, domainRelationships: world.domain });
      } catch {
        continue;
      }
      const link = world.op.stored[0];
      const added = planRelationshipCommit({
        mode: world.mode, op: { kind: 'add', rel: { ...link, cardinality: 'one-to-many' } }, endpointModels: models, domainRelationships: removed.domainRelationships,
      });
      const mine = records(world.mode, models, added.domainRelationships).filter((r) => linkKey(r.rel) === linkKey(link));
      expect(mine, `seed ${seed}`).toHaveLength(1);
      expect(mine[0].rel.cardinality).toBe('many-to-one');
    }
  });
});

describe('planRelationshipCommit — models whose names differ only in case', () => {
  it('updates from the copy the reader draws, whatever order the models come in', () => {
    const make = () => {
      const t: SemanticModel = { name: 'T', columns: [col('id', { isPrimaryKey: true })] };
      const lower: SemanticModel = { name: 'Dd', columns: [col('x')], relationships: [{ fromColumn: 'x', toModel: 'T', toColumn: 'id', cardinality: 'many-to-one', role: 'lower' }] };
      const upper: SemanticModel = { name: 'DD', columns: [col('x')], relationships: [{ fromColumn: 'x', toModel: 'T', toColumn: 'id', cardinality: 'many-to-many', role: 'upper' }] };
      return { t, lower, upper };
    };
    const stored: RelationshipEnds = { fromModel: 'Dd', fromColumn: 'x', toModel: 'T', toColumn: 'id' };
    const roles = [
      (() => { const m = make(); return plan('library', { kind: 'update', stored, cardinality: 'one-to-one' }, [m.lower, m.upper, m.t]); })(),
      (() => { const m = make(); return plan('library', { kind: 'update', stored, cardinality: 'one-to-one' }, [m.upper, m.lower, m.t]); })(),
    ].map((result) => result.changedModels.flatMap((m) => (m.relationships ?? []).map((r) => `${m.name}:${r.role ?? ''}`)));
    expect(roles[0]).toEqual(roles[1]);
    // 'DD' sorts before 'Dd' by exact name, so DD's copy (role "upper") is the one drawn and kept.
    expect(roles[0].join(',')).toContain('upper');
  });

  it('resolves each endpoint name to its own model, so a link between Dd and DD lands in Dd\'s file', () => {
    const dd: SemanticModel = { name: 'Dd', columns: [col('x')] };
    const DD: SemanticModel = { name: 'DD', columns: [col('y', { isPrimaryKey: true }), col('x')] };
    const endpoints = resolveEndpointModels(['Dd', 'DD'], [DD, dd]);
    expect(endpoints.map((m) => m.name)).toEqual(['Dd', 'DD']);
    // A name in neither exact spelling resolves to the alphabetically first variant, once.
    expect(resolveEndpointModels(['dd', 'DD'], [dd, DD]).map((m) => m.name)).toEqual(['DD']);
    const result = plan('library', {
      kind: 'add', rel: { fromModel: 'Dd', fromColumn: 'x', toModel: 'DD', toColumn: 'y', cardinality: 'many-to-one' },
    }, endpoints);
    expect(result.changedModels.map((m) => m.name)).toEqual(['Dd']);
    expect(dd.relationships).toEqual([{ fromColumn: 'x', toModel: 'DD', toColumn: 'y', cardinality: 'many-to-one' }]);
    expect(DD.relationships ?? []).toEqual([]);
  });
});

describe('planRelationshipCommit — a canvas drawn before the link changed (#133 review)', () => {
  const A = (rels: SemanticModel['relationships'] = []): SemanticModel => ({ name: 'A', columns: [col('id', { isPrimaryKey: true }), col('b_id')], ...(rels.length ? { relationships: rels } : {}) });
  const B = (rels: SemanticModel['relationships'] = []): SemanticModel => ({ name: 'B', columns: [col('id'), col('a_ref')], ...(rels.length ? { relationships: rels } : {}) });
  // The canvas drew A.b_id → B.id many-to-one; since then the link was turned
  // round elsewhere and is stored in B.yml as B.id → A.b_id many-to-one.
  const drawn: RelationshipEnds = { fromModel: 'A', fromColumn: 'b_id', toModel: 'B', toColumn: 'id' };
  const flipped = () => [A(), B([{ fromColumn: 'id', toModel: 'A', toColumn: 'b_id', cardinality: 'many-to-one' }])];
  const stored = (models: SemanticModel[]) => models.flatMap((m) => (m.relationships ?? []).map((r) => `${m.name}.${r.fromColumn}→${r.toModel}.${r.toColumn} ${r.cardinality}`));

  it('reads the cardinality against the ends the canvas drew, not the record as it is now', () => {
    // "B is the many side", as the stale canvas offered: already true — B keeps it.
    const keep = flipped();
    plan('library', { kind: 'update', stored: drawn, drawn, cardinality: 'one-to-many' }, keep);
    expect(stored(keep)).toEqual(['B.id→A.b_id many-to-one']);
    // "A is the many side": the link is stored with A.
    const turn = flipped();
    plan('library', { kind: 'update', stored: drawn, drawn, cardinality: 'many-to-one' }, turn);
    expect(stored(turn)).toEqual(['A.b_id→B.id many-to-one']);
  });

  it('a domain-mode update keeps a role longer than the canvas shows exactly as stored', () => {
    const long = 'the date the order was shipped from the warehouse to the customer address on file';
    const domain: Relationship[] = [{ fromModel: 'A', fromColumn: 'b_id', toModel: 'B', toColumn: 'id', cardinality: 'many-to-one', role: long }];
    const result = plan('domain', { kind: 'update', stored: drawn, drawn, cardinality: 'one-to-one' }, [A(), B()], domain);
    expect(result.domainRelationships).toEqual([{ ...domain[0], cardinality: 'one-to-one' }]);
    // The edit dialog sends the shortened label back unchanged: still kept.
    const edit = plan('domain', {
      kind: 'edit', stored: drawn, next: { ...drawn, cardinality: 'many-to-one', role: long.slice(0, 60) },
    }, [A(), B()], domain);
    expect(edit.domainRelationships[0].role).toBe(long);
  });

  it('refuses to move a model-file copy whose role is longer than the canvas shows (it would be cut), naming the file', () => {
    const long = 'the date the order was shipped from the warehouse to the customer address on file';
    const a = parseLogicalModelText([
      'name: A', 'columns:', '  - name: id', '    dataType: string', '    isPrimaryKey: true', '  - name: b_id', '    dataType: string',
      'relationships:', '  - fromColumn: b_id', '    toModel: B', '    toColumn: id', '    cardinality: one-to-one', `    role: ${long}`,
    ].join('\n'), 'A')!;
    const b: SemanticModel = { name: 'B', columns: [col('id', { isPrimaryKey: true })] };
    const shown = a.relationships![0].role!;
    // ⇄ on a one-to-one: the same link, stored from B now — in B's file.
    expect(() => plan('library', {
      kind: 'edit', stored: drawn, next: { fromModel: 'B', fromColumn: 'id', toModel: 'A', toColumn: 'b_id', cardinality: 'one-to-one', role: shown },
    }, [a, b])).toThrow(/role in A's model file is longer than 60 characters and would be cut by moving it/);
    expect(a.relationships![0].role).toBe(shown);
    // A role the user changes is theirs to write anywhere.
    const moved = plan('library', {
      kind: 'edit', stored: drawn, next: { fromModel: 'B', fromColumn: 'id', toModel: 'A', toColumn: 'b_id', cardinality: 'one-to-one', role: 'shipped' },
    }, [a, b]);
    expect(moved.changedModels.map((m) => m.name).sort()).toEqual(['A', 'B']);
  });
});
