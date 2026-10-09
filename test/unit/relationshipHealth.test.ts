import { describe, expect, it } from 'vitest';
import { linkKey } from '@erd-studio/core';
import { planRelationshipWrite } from '../../src/services/libraryRelationships';
import type { RelationshipWriteInput, RelationshipWriteOp } from '../../src/services/libraryRelationships';
import {
  INVARIANT_ERROR_CODES,
  SURVEY_FEATURES,
  auditRelationshipWrite,
  checkLibraryRewrite,
  checkRelationshipWrite,
  countUnreadableEntries,
  drawnTwiceCount,
  healthLinkKey,
  invariantErrorCodes,
  moveUsage,
  relationshipWriteUsage,
  surveyFeatures,
  surveyLibrary,
} from '../../src/services/relationshipHealth';
import type { HealthModel, RelationshipSnapshot } from '../../src/services/relationshipHealth';
import { ERROR_CODES, FEATURES } from '../../src/services/telemetryPayload';
import type { ColumnDef, ModelRelationship, Relationship, SemanticModel } from '../../src/types/semantic';

const col = (name: string, key?: 'pk' | 'nk'): ColumnDef => ({
  name, dataType: 'string', description: '',
  ...(key === 'pk' ? { isPrimaryKey: true } : {}),
  ...(key === 'nk' ? { isNaturalKey: true } : {}),
});

/** A star: `fct.k → dim.k`, plus a bystander `fct.k2 → dim.k` with a role. */
const DIM_COLS = [col('k', 'pk'), col('k_x'), col('name')];
const FCT_COLS = [col('id', 'pk'), col('k'), col('k_x'), col('k2')];
const dim = (relationships?: ModelRelationship[], columns = DIM_COLS): SemanticModel =>
  ({ name: 'dim', columns, ...(relationships ? { relationships } : {}) });
const fct = (relationships?: ModelRelationship[], columns = FCT_COLS): SemanticModel =>
  ({ name: 'fct', columns, ...(relationships ? { relationships } : {}) });

const L: Relationship = { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' };
const L_ENTRY: ModelRelationship = { fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' };
const BYSTANDER: ModelRelationship = { fromColumn: 'k2', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one', role: 'ship date' };
/** L read from the dimension: the same link. */
const L_FROM_DIM: Relationship = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' };
const DIM_ENTRY_1M: ModelRelationship = { fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' };

const lib = (models: SemanticModel[], domainRelationships: Relationship[] = []): RelationshipSnapshot =>
  ({ home: 'library', models, domainRelationships });
const add = (drawn: Relationship, extra: Partial<Extract<RelationshipWriteOp, { kind: 'add' }>> = {}): RelationshipWriteOp => ({ kind: 'add', drawn, ...extra });
const update = (ends: Relationship): RelationshipWriteOp => ({ kind: 'update', ends, cardinality: ends.cardinality });

describe('checkRelationshipWrite — add / ⇄ / edit', () => {
  const before = lib([dim(), fct([BYSTANDER])]);

  it('passes one canonical copy on the many side, however it was drawn', () => {
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
    expect(checkRelationshipWrite(add(L_FROM_DIM), before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('flags a one-to-many in the dimension file, a copy left in the domain file, a second copy, or none', () => {
    expect(checkRelationshipWrite(add(L_FROM_DIM), before, { models: [dim([DIM_ENTRY_1M])] })).toEqual(['notCanonical']);
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, L_ENTRY])], domainRelationships: [L] })).toEqual(['notCanonical']);
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, L_ENTRY]), dim([DIM_ENTRY_1M])] })).toEqual(['notCanonical']);
    expect(checkRelationshipWrite(add(L), before, {})).toEqual(['notCanonical']);
  });

  it('flags the wrong cardinality, and a one-to-one stored from the wrong end', () => {
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, { ...L_ENTRY, cardinality: 'many-to-many' }])] })).toEqual(['notAsIntended']);
    expect(checkRelationshipWrite(add({ ...L, cardinality: 'one-to-one' }), before, {
      models: [dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-one' }])],
    })).toEqual(['notAsIntended']);
  });

  it('flags a role the dialog gave that was not stored, or one an add invented', () => {
    expect(checkRelationshipWrite(add({ ...L, role: 'order date' }), before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual(['roleLost']);
    expect(checkRelationshipWrite(add({ ...L, role: 'order date' }), before, { models: [fct([BYSTANDER, { ...L_ENTRY, role: 'order date' }])] })).toEqual([]);
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, { ...L_ENTRY, role: 'made up' }])] })).toEqual(['roleLost']);
  });

  it('flags ⇄ that dropped the role (F2/F4), and passes one that kept it or moved the record to the other file', () => {
    const withRole = lib([dim(), fct([{ ...L_ENTRY, role: 'order date' }])]);
    const swapped: Relationship = { ...L, cardinality: 'one-to-one' };
    expect(checkRelationshipWrite(update(swapped), withRole, { models: [fct([{ ...L_ENTRY, cardinality: 'one-to-one' }])] })).toEqual(['roleLost']);
    expect(checkRelationshipWrite(update(swapped), withRole, { models: [fct([{ ...L_ENTRY, cardinality: 'one-to-one', role: 'order date' }])] })).toEqual([]);
    const turned: Relationship = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' };
    expect(checkRelationshipWrite(update(turned), withRole, {
      models: [fct([]), dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one', role: 'order date' }])],
    })).toEqual([]);
  });

  it('flags an edit that re-keys but leaves the old ends behind', () => {
    const was = lib([dim(), fct([L_ENTRY])]);
    const op: RelationshipWriteOp = { kind: 'edit', original: L, drawn: { ...L, fromColumn: 'k2' } };
    expect(checkRelationshipWrite(op, was, { models: [fct([L_ENTRY, { ...L_ENTRY, fromColumn: 'k2' }])] })).toEqual(['copyLeft']);
    expect(checkRelationshipWrite(op, was, { models: [fct([{ ...L_ENTRY, fromColumn: 'k2' }])] })).toEqual([]);
  });

  it('checks a per-diagram project against the domain file, library copies folded in', () => {
    const was: RelationshipSnapshot = { home: 'domain', models: [dim(), fct()], domainRelationships: [] };
    expect(checkRelationshipWrite(add(L_FROM_DIM), was, { domainRelationships: [L_FROM_DIM] })).toEqual([]);
    expect(checkRelationshipWrite(add(L), was, { domainRelationships: [L, L_FROM_DIM] })).toEqual(['notCanonical', 'duplicateInFile']);
    expect(checkRelationshipWrite(add(L), was, { domainRelationships: [L], models: [fct([L_ENTRY])] })).toEqual(['notCanonical']);
  });

  it('matches ends without case', () => {
    expect(checkRelationshipWrite(add({ ...L, toModel: 'DIM', toColumn: 'K' }), before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('flags a "Mark as primary key" the written model does not carry', () => {
    const noKey = lib([dim(undefined, [col('k'), col('name')]), fct()]);
    const op = add(L, { markKey: { model: 'dim', columns: ['k'] } });
    expect(checkRelationshipWrite(op, noKey, { models: [fct([L_ENTRY])] })).toEqual(['keyNotMarked']);
    expect(checkRelationshipWrite(op, noKey, { models: [fct([L_ENTRY]), dim(undefined, [col('k', 'pk'), col('name')])] })).toEqual([]);
    expect(checkRelationshipWrite(op, noKey, { models: [fct([L_ENTRY])], inlineMarkKey: true })).toEqual([]);
  });
});

describe('checkRelationshipWrite — composite keys act on the group', () => {
  const G = (card: Relationship['cardinality'] = 'many-to-one', ck = 'fk_dim'): ModelRelationship[] => [
    { ...L_ENTRY, cardinality: card, compositeKey: ck },
    { fromColumn: 'k_x', toModel: 'dim', toColumn: 'k_x', cardinality: card, compositeKey: ck },
  ];
  const pairX = [{ fromColumn: 'k_x', toColumn: 'k_x' }];

  it('passes a composite added as one group, and flags members that do not share one key', () => {
    const was = lib([dim(), fct()]);
    expect(checkRelationshipWrite(add(L, { extraPairs: pairX }), was, { models: [fct(G())] })).toEqual([]);
    expect(checkRelationshipWrite(add(L, { extraPairs: pairX }), was, { models: [fct([G()[0], { ...G()[1], compositeKey: 'other' }])] })).toEqual(['groupBroken']);
  });

  it('flags ⇄ on one member that leaves the other behind', () => {
    const was = lib([dim(), fct(G())]);
    const op = update({ ...L, cardinality: 'one-to-one' });
    expect(checkRelationshipWrite(op, was, { models: [fct(G('one-to-one'))] })).toEqual([]);
    expect(checkRelationshipWrite(op, was, { models: [fct([G('one-to-one')[0], G()[1]])] })).toEqual(['groupBroken']);
  });

  it('flags a delete of one edge that leaves another member', () => {
    const was = lib([dim(), fct([...G(), BYSTANDER])]);
    expect(checkRelationshipWrite({ kind: 'remove', keys: [L] }, was, { models: [fct([BYSTANDER])] })).toEqual([]);
    expect(checkRelationshipWrite({ kind: 'remove', keys: [L] }, was, { models: [fct([G()[1], BYSTANDER])] })).toEqual(['copyLeft']);
  });

  it('flags another composite losing its key', () => {
    const was = lib([dim(), fct(G())]);
    expect(checkRelationshipWrite(add({ ...L, fromColumn: 'k2' }), was, {
      models: [fct([{ ...L_ENTRY }, { ...G()[1], compositeKey: undefined }, { ...L_ENTRY, fromColumn: 'k2' }])],
    })).toEqual(['otherChanged']);
  });
});

describe('checkRelationshipWrite — delete and other links', () => {
  const before = lib([dim(), fct([BYSTANDER])]);

  it('passes a delete that removed every copy, and flags a stale one', () => {
    const was = lib([dim([DIM_ENTRY_1M]), fct([L_ENTRY, BYSTANDER])], [L]);
    expect(checkRelationshipWrite({ kind: 'remove', keys: [L] }, was, { models: [dim([]), fct([BYSTANDER])], domainRelationships: [] })).toEqual([]);
    expect(checkRelationshipWrite({ kind: 'remove', keys: [L_FROM_DIM] }, was, { models: [fct([BYSTANDER])], domainRelationships: [] })).toEqual(['copyLeft']);
  });

  it('flags another link that vanished or changed', () => {
    expect(checkRelationshipWrite(add(L), before, { models: [fct([L_ENTRY])] })).toEqual(['otherLost']);
    for (const changed of [{ ...BYSTANDER, role: 'order date' }, { ...BYSTANDER, role: undefined }, { ...BYSTANDER, cardinality: 'one-to-one' as const }]) {
      expect(checkRelationshipWrite(add(L), before, { models: [fct([changed, L_ENTRY])] })).toEqual(['otherChanged']);
    }
  });

  it('does not mind another link moving file in the same meaning, or gaining a role', () => {
    const plain = lib([dim(), fct([{ ...BYSTANDER, role: undefined }])]);
    expect(checkRelationshipWrite(add(L), plain, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
    const backwards = lib([dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k2', cardinality: 'one-to-many', role: 'ship date' }]), fct()]);
    expect(checkRelationshipWrite(add(L), backwards, { models: [dim([]), fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('flags a file that gains a duplicate, and a drawn result showing a link twice', () => {
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, BYSTANDER, L_ENTRY])] })).toEqual(['duplicateInFile']);
    expect(checkRelationshipWrite(add(L), before, { models: [fct([BYSTANDER, L_ENTRY])], drawn: [L, L_FROM_DIM] })).toEqual(['drawnTwice']);
    expect(drawnTwiceCount([L, L_FROM_DIM, { ...L, fromColumn: 'k2' }])).toBe(1);
  });

  it('never throws: malformed input is checkFailed', () => {
    expect(checkRelationshipWrite(add(L), { home: 'library', models: null, domainRelationships: [] } as never, {})).toEqual(['checkFailed']);
    expect(checkRelationshipWrite(null as never, before, {})).toEqual(['checkFailed']);
  });

  it('maps every invariant to a listed error code', () => {
    for (const code of Object.values(INVARIANT_ERROR_CODES)) expect(ERROR_CODES).toContain(code);
    expect(invariantErrorCodes(['otherLost', 'groupBroken'])).toEqual(['relInvOtherLost', 'relInvGroupBroken']);
  });
});

describe('auditRelationshipWrite — the real planner', () => {
  const input = (models: SemanticModel[], domainRelationships: Relationship[] = []): RelationshipWriteInput =>
    ({ home: 'library', models, domainRelationships });
  const audit = (op: RelationshipWriteOp, inp: RelationshipWriteInput) => auditRelationshipWrite(op, inp, planRelationshipWrite(op, inp));

  it('finds a sound plan sound, and names what the write used', () => {
    expect(audit(add(L_FROM_DIM), input([dim(), fct([BYSTANDER])]))).toEqual({ broken: [], usage: ['relDragTurned'] });
    expect(audit(add({ ...L, role: 'order date' }), input([dim(), fct()])).usage).toEqual(['relRoleSet']);
    const dimKx = dim(undefined, [col('k', 'pk'), col('k_x', 'pk'), col('name')]);
    expect(audit(add(L, { extraPairs: [{ fromColumn: 'k_x', toColumn: 'k_x' }] }), input([dimKx, fct()]))).toEqual({ broken: [], usage: ['relComposite'] });
    const emp: SemanticModel = { name: 'emp', columns: [col('id', 'pk'), col('mgr')] };
    expect(audit(add({ fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id', cardinality: 'many-to-one' }), input([emp])).usage).toEqual(['relSelfReference']);
  });

  it('notes the dialog asking which way round, "Mark as primary key" and "Create anyway"', () => {
    const noKeys = [dim(undefined, [col('k'), col('name')]), fct(undefined, [col('k')])];
    expect(audit(add(L), input(noKeys)).usage).toEqual(['relDirectionAsked']);
    expect(audit(add(L, { markKey: { model: 'dim', columns: ['k'] } }), input(noKeys))).toEqual({ broken: [], usage: ['relDirectionAsked', 'relMarkKey'] });
    // dim.k is dim's key, fct.k is certainly not fct's: drawn as the many side anyway.
    const against: Relationship = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' };
    expect(audit(add(against), input([dim(), fct()])).usage).toContain('relCreateAnyway');
  });

  it('notes ⇄ moving the record and a delete removing more than one copy', () => {
    const turned: Relationship = { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'one-to-many' };
    const noKeys = [dim(undefined, [col('k')]), fct([L_ENTRY], [col('k')])];
    expect(audit(update(turned), input(noKeys))).toEqual({ broken: [], usage: ['relSwapMoved'] });
    expect(audit({ kind: 'remove', keys: [L] }, input([dim([DIM_ENTRY_1M]), fct([L_ENTRY])]))).toEqual({ broken: [], usage: ['relDeleteCopies'] });
  });

  it('is empty for a refused plan, and catches a corrupted one', () => {
    const inp = input([dim(), fct([L_ENTRY])]);
    expect(auditRelationshipWrite(add(L), inp, planRelationshipWrite(add(L), inp))).toEqual({ broken: [], usage: [] });
    const op = add({ ...L, fromColumn: 'k2' });
    const plan = planRelationshipWrite(op, inp);
    if (!plan.ok) throw new Error('expected a plan');
    const lost = { ...plan, changed: plan.changed.map((m) => ({ ...m, relationships: m.relationships?.filter((r) => r.fromColumn !== 'k') })) };
    expect(auditRelationshipWrite(op, inp, lost).broken).toEqual(['otherLost']);
  });
});

describe('checkLibraryRewrite and moveUsage — the Move', () => {
  it('passes a one-to-many re-homed to the fact, and flags loss, duplicates, a missing copy and a split group', () => {
    const before = [dim([DIM_ENTRY_1M]), fct([BYSTANDER])];
    expect(checkLibraryRewrite(before, [dim([]), fct([BYSTANDER, L_ENTRY])], [L])).toEqual([]);
    expect(checkLibraryRewrite(before, [dim([]), fct([L_ENTRY])], [L])).toEqual(['otherLost']);
    expect(checkLibraryRewrite(before, [dim([]), fct([BYSTANDER, L_ENTRY, L_ENTRY])], [L])).toEqual(['notCanonical', 'duplicateInFile']);
    expect(checkLibraryRewrite(before, [dim([]), fct([BYSTANDER])], [L])).toEqual(['notCanonical', 'otherLost']);
    const group: ModelRelationship[] = [{ ...L_ENTRY, compositeKey: 'fk_dim' }, { fromColumn: 'k_x', toModel: 'dim', toColumn: 'k_x', cardinality: 'many-to-one', compositeKey: 'fk_dim' }];
    expect(checkLibraryRewrite([dim(), fct(group)], [dim(), fct([group[0], { ...group[1], compositeKey: undefined }])], [])).toEqual(['groupBroken']);
    expect(checkLibraryRewrite(null as never, [], [])).toEqual(['checkFailed']);
  });

  it('names each step a Move took', () => {
    const empty = { rehome: [], turned: [], disagreements: [], lockedFiles: [], keptLibrary: [], leftGroups: [] };
    expect(moveUsage(empty)).toEqual([]);
    expect(moveUsage({
      ...empty,
      rehome: [{ from: 'dim', stored: { ...L_FROM_DIM }, to: L }, { from: 'dim', stored: { ...L_FROM_DIM, cardinality: 'many-to-one' }, to: L }],
      disagreements: [{ stored: L, held: L }], lockedFiles: ['x'], keptLibrary: [{ domain: 'd', relationship: L, library: L }], leftGroups: [{ members: [], domains: [], reason: '' }],
    })).toEqual(['relMoveRehomed', 'relMoveTurned', 'relMoveDisagreementLeft', 'relMoveFileLocked', 'relMoveKeptLibrary', 'relMoveGroupLeft']);
    for (const f of moveUsage({ ...empty, turned: [{ domain: 'd', relationship: L, to: L }] })) expect(FEATURES).toContain(f);
  });
});

describe('relationshipWriteUsage', () => {
  it('never throws', () => {
    expect(relationshipWriteUsage(null as never, null as never, null as never)).toEqual([]);
  });
});

describe('surveyLibrary', () => {
  it('finds nothing in a clean star', () => {
    const s = surveyLibrary([dim(), fct([L_ENTRY, BYSTANDER])], []);
    expect(surveyFeatures(s)).toEqual([]);
  });

  it('counts a link stored at both ends, and the one-to-many among them', () => {
    const s = surveyLibrary([dim([DIM_ENTRY_1M]), fct([L_ENTRY])], []);
    expect([s.storedTwice, s.oneToManyInModelFile, s.backwards]).toEqual([1, 1, 0]);
  });

  it('counts a many-to-one stored backwards only where the keys say so (contradictsKeys)', () => {
    const entry: ModelRelationship = { fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' };
    const dimK = [col('k', 'pk'), col('name')];
    expect(surveyLibrary([dim([entry], dimK), fct()], []).backwards).toBe(1);
    expect(surveyLibrary([dim([entry], dimK), fct(undefined, [col('id'), col('k')])], []).backwards).toBe(0);
    expect(surveyLibrary([dim([entry], dimK), fct(undefined, [col('k', 'pk')])], []).backwards).toBe(0);
  });

  it('counts dangling models and columns, in model files and the domain file', () => {
    const s = surveyLibrary([dim(), fct([
      { fromColumn: 'k', toModel: 'gone', toColumn: 'k', cardinality: 'many-to-one' },
      { fromColumn: 'missing', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' },
    ])], [{ ...L, toColumn: 'nope' }]);
    expect([s.danglingModel, s.danglingColumn]).toEqual([1, 2]);
  });

  it('counts unreadable entries the caller counted', () => {
    expect(surveyLibrary([dim(), fct()], [], { unreadableEntries: 3 }).unreadable).toBe(3);
    expect(countUnreadableEntries([
      L_ENTRY, 'text', null, ['a'], { fromColumn: 'k', toModel: 'dim' }, { ...L_ENTRY, cardinality: 'lots' }, { ...L_ENTRY, toModel: '' },
    ])).toBe(6);
    expect(countUnreadableEntries(undefined)).toBe(0);
  });

  it('counts composite groups compositeGroupProblem rejects', () => {
    const s = surveyLibrary([dim(), fct([
      { ...L_ENTRY, compositeKey: 'a' }, { fromColumn: 'k_x', toModel: 'dim', toColumn: 'k_x', cardinality: 'many-to-one', compositeKey: 'a' },
      { fromColumn: 'k2', toModel: 'dim', toColumn: 'name', cardinality: 'many-to-one', compositeKey: 'b' },
      { fromColumn: 'id', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-many', compositeKey: 'c' },
      { fromColumn: 'k_x', toModel: 'dim', toColumn: 'name', cardinality: 'many-to-many', compositeKey: 'c' },
    ])], []);
    expect(s.partialComposite).toBe(2);
  });

  it('counts ends spelled in another case, and diagram copies of library links', () => {
    const s = surveyLibrary([dim(), fct([{ ...L_ENTRY, toModel: 'Dim', toColumn: 'K' }])], [L]);
    expect([s.caseRespelled, s.domainCopyOfLibrary, s.storedTwice]).toEqual([1, 1, 1]);
  });

  it('never throws, and maps every count to a listed feature', () => {
    expect(() => surveyLibrary(null as never, null as never)).not.toThrow();
    expect(() => surveyLibrary([{ name: 'x', relationships: [null] } as never], [])).not.toThrow();
    for (const f of Object.values(SURVEY_FEATURES)) expect(FEATURES).toContain(f);
  });

  it('stays linear on a large library', () => {
    const models: SemanticModel[] = [];
    for (let i = 0; i < 2000; i++) {
      models.push({
        name: `m${i}`, columns: [col('id', 'pk'), col('ref')],
        relationships: Array.from({ length: 10 }, (_, j) => ({ fromColumn: 'ref', toModel: `m${(i + j + 1) % 2000}`, toColumn: 'id', cardinality: 'many-to-one' as const })),
      });
    }
    const t = Date.now();
    surveyLibrary(models, []);
    checkRelationshipWrite({ kind: 'remove', keys: [{ fromModel: 'm0', fromColumn: 'ref', toModel: 'm1', toColumn: 'id' }] }, lib(models), {
      models: [{ ...models[0], relationships: models[0].relationships!.slice(1) }],
    });
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('identity agrees with core', () => {
  it('healthLinkKey is linkKey', () => {
    for (const r of [L, L_FROM_DIM, { ...L, fromModel: 'FCT ', toColumn: 'K' }, { ...L, fromModel: 'a', toModel: 'a', toColumn: 'b' }]) {
      expect(healthLinkKey(r)).toBe(linkKey(r));
    }
  });
});

describe('no name reaches the output', () => {
  it('returns only codes and counts, whatever the models and columns are called', () => {
    const names = ['acme_payroll', 'employee_salary_band', 'patient_diagnosis', 'ssn_hash', 'Secret Project Falcon', 'customer_email'];
    const [a, b, c, d, e, f] = names;
    const models: HealthModel[] = [
      { name: a, columns: [col(d, 'pk'), col(f)], relationships: [{ fromColumn: f, toModel: b, toColumn: c, cardinality: 'one-to-many', role: e, compositeKey: e }] },
      { name: b, columns: [col(c, 'pk')], relationships: [{ fromColumn: c, toModel: a, toColumn: f, cardinality: 'many-to-one', role: e }, { fromColumn: c, toModel: 'ghost_' + e, toColumn: d, cardinality: 'many-to-one' }] },
    ];
    const domain: Relationship[] = [{ fromModel: a.toUpperCase(), fromColumn: f, toModel: b, toColumn: c.toUpperCase(), cardinality: 'many-to-one', role: e }];
    const survey = surveyLibrary(models, domain, { unreadableEntries: 1 });
    const op: RelationshipWriteOp = { kind: 'add', drawn: { fromModel: a, fromColumn: f, toModel: b, toColumn: c, cardinality: 'many-to-one', role: e }, markKey: { model: b, columns: [c] }, extraPairs: [{ fromColumn: d, toColumn: c }] };
    const before: RelationshipSnapshot = { home: 'library', models, domainRelationships: domain };
    const after = { models: [{ ...models[0], relationships: [] }, { ...models[1], relationships: [] }], drawn: [...domain, ...domain] };
    const broken = checkRelationshipWrite(op, before, after);
    expect(broken.length).toBeGreaterThan(0);
    const out = JSON.stringify([
      survey, surveyFeatures(survey), broken, invariantErrorCodes(broken),
      relationshipWriteUsage(op, before, after),
      auditRelationshipWrite(op, { home: 'library', models: models as SemanticModel[], domainRelationships: domain }, planRelationshipWrite(op, { home: 'library', models: models as SemanticModel[], domainRelationships: domain })),
      checkLibraryRewrite(models, after.models, [domain[0]]),
      checkRelationshipWrite(null as never, null as never, null as never),
    ]);
    for (const name of [...names, 'ghost']) {
      expect(out.toLowerCase()).not.toContain(name.toLowerCase());
      for (const part of name.toLowerCase().split(/[_ ]/).filter((p) => p.length > 3)) expect(out.toLowerCase()).not.toContain(part);
    }
    expect(Object.values(survey).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
});
