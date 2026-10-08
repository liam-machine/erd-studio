import { describe, expect, it } from 'vitest';
import { linkKey } from '@erd-studio/core';
import {
  INVARIANT_ERROR_CODES,
  SURVEY_FEATURES,
  checkRelationshipWrite,
  countUnreadableEntries,
  drawnTwiceCount,
  healthLinkKey,
  invariantErrorCodes,
  surveyFeatures,
  surveyLibrary,
} from '../../src/services/relationshipHealth';
import type { HealthModel, RelationshipSnapshot } from '../../src/services/relationshipHealth';
import { ERROR_CODES, FEATURES } from '../../src/services/telemetryPayload';
import type { ColumnDef, ModelRelationship, Relationship } from '../../src/types/semantic';

const col = (name: string, key?: 'pk' | 'nk'): ColumnDef => ({
  name, dataType: 'string', description: '',
  ...(key === 'pk' ? { isPrimaryKey: true } : {}),
  ...(key === 'nk' ? { isNaturalKey: true } : {}),
});

/** A star: `fct.k → dim.k`, plus a bystander `fct.k2 → dim.k` with a role. */
const DIM_COLS = [col('k', 'pk'), col('name')];
const FCT_COLS = [col('id', 'pk'), col('k'), col('k2')];
const dim = (relationships?: ModelRelationship[]): HealthModel => ({ name: 'dim', columns: DIM_COLS, ...(relationships ? { relationships } : {}) });
const fct = (relationships?: ModelRelationship[]): HealthModel => ({ name: 'fct', columns: FCT_COLS, ...(relationships ? { relationships } : {}) });

const L: Relationship = { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' };
const L_ENTRY: ModelRelationship = { fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' };
const BYSTANDER: ModelRelationship = { fromColumn: 'k2', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one', role: 'ship date' };
/** L read from the dimension: the same link. */
const L_FROM_DIM: Relationship = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' };

const snap = (models: HealthModel[], domainRelationships: Relationship[] = []): RelationshipSnapshot => ({ models, domainRelationships });

describe('checkRelationshipWrite — add / swap / edit', () => {
  const before = snap([dim(), fct([BYSTANDER])]);

  it('passes one canonical copy on the many side', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('passes a line drawn from the dimension and stored turned round on the fact', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L_FROM_DIM }, before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('flags a one-to-many written into the dimension file', () => {
    const after = { models: [dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }])] };
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L_FROM_DIM }, before, after)).toEqual(['notCanonical']);
  });

  it('flags a copy left in the domain file, or a second library copy', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, { models: [fct([BYSTANDER, L_ENTRY])], domainRelationships: [L] }))
      .toEqual(['notCanonical']);
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {
      models: [fct([BYSTANDER, L_ENTRY]), dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }])],
    })).toEqual(['notCanonical']);
  });

  it('flags a write that stored nothing', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {})).toEqual(['notCanonical']);
  });

  it('flags the wrong cardinality, and a one-to-one stored from the wrong end', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {
      models: [fct([BYSTANDER, { ...L_ENTRY, cardinality: 'many-to-many' }])],
    })).toEqual(['notAsIntended']);
    const oneToOne: Relationship = { ...L, cardinality: 'one-to-one' };
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: oneToOne }, before, {
      models: [dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-one' }])],
    })).toEqual(['notAsIntended']);
  });

  it('flags a role the dialog gave that was not stored, and passes one that was', () => {
    const link = { ...L, role: 'order date' };
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link }, before, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual(['roleLost']);
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link }, before, { models: [fct([BYSTANDER, { ...L_ENTRY, role: 'order date' }])] })).toEqual([]);
  });

  it('flags a swap that dropped the role (F2/F4), and passes one that kept it', () => {
    const withRole = snap([dim(), fct([{ ...L_ENTRY, role: 'order date' }])]);
    const swapped: Relationship = { ...L, cardinality: 'one-to-one' };
    expect(checkRelationshipWrite({ kind: 'swap', home: 'library', link: swapped }, withRole, {
      models: [fct([{ ...L_ENTRY, cardinality: 'one-to-one' }])],
    })).toEqual(['roleLost']);
    expect(checkRelationshipWrite({ kind: 'swap', home: 'library', link: swapped }, withRole, {
      models: [fct([{ ...L_ENTRY, cardinality: 'one-to-one', role: 'order date' }])],
    })).toEqual([]);
  });

  it('a ⇄ that moves the record to the other file is sound', () => {
    const was = snap([dim(), fct([L_ENTRY])]);
    const turned: Relationship = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' };
    expect(checkRelationshipWrite({ kind: 'swap', home: 'library', link: turned }, was, {
      models: [fct([]), dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' }])],
    })).toEqual([]);
  });

  it('flags an edit that re-keys but leaves the old ends behind', () => {
    const was = snap([dim(), fct([L_ENTRY])]);
    const link: Relationship = { ...L, fromColumn: 'k2' };
    expect(checkRelationshipWrite({ kind: 'edit', home: 'library', link, original: L }, was, {
      models: [fct([L_ENTRY, { ...L_ENTRY, fromColumn: 'k2' }])],
    })).toEqual(['copyLeft']);
    expect(checkRelationshipWrite({ kind: 'edit', home: 'library', link, original: L }, was, {
      models: [fct([{ ...L_ENTRY, fromColumn: 'k2' }])],
    })).toEqual([]);
  });

  it('checks a per-diagram project against the domain file', () => {
    const was = snap([dim(), fct()], []);
    expect(checkRelationshipWrite({ kind: 'add', home: 'domain', link: L_FROM_DIM }, was, { domainRelationships: [L_FROM_DIM] })).toEqual([]);
    expect(checkRelationshipWrite({ kind: 'add', home: 'domain', link: L }, was, { domainRelationships: [L, L_FROM_DIM] })).toEqual(['notCanonical', 'duplicateInFile']);
  });

  it('matches ends without case', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: { ...L, toModel: 'DIM', toColumn: 'K' } }, before, {
      models: [fct([BYSTANDER, L_ENTRY])],
    })).toEqual([]);
  });
});

describe('checkRelationshipWrite — delete', () => {
  it('passes a delete that removed every copy, in every file', () => {
    const was = snap([dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }]), fct([L_ENTRY, BYSTANDER])], [L]);
    expect(checkRelationshipWrite({ kind: 'delete', links: [L] }, was, { models: [dim([]), fct([BYSTANDER])], domainRelationships: [] })).toEqual([]);
  });

  it('flags a stale copy left behind', () => {
    const was = snap([dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }]), fct([L_ENTRY])]);
    expect(checkRelationshipWrite({ kind: 'delete', links: [L_FROM_DIM] }, was, { models: [fct([])] })).toEqual(['copyLeft']);
  });
});

describe('checkRelationshipWrite — other links', () => {
  const before = snap([dim(), fct([BYSTANDER])]);

  it('flags another link that vanished', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, { models: [fct([L_ENTRY])] })).toEqual(['otherLost']);
  });

  it('flags another link whose role, cardinality or direction changed', () => {
    for (const changed of [
      { ...BYSTANDER, role: 'order date' },
      { ...BYSTANDER, role: undefined },
      { ...BYSTANDER, cardinality: 'one-to-one' as const },
    ]) {
      expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, { models: [fct([changed, L_ENTRY])] })).toEqual(['otherChanged']);
    }
    // Turned round onto the dimension: the same words, the other way round.
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {
      models: [fct([L_ENTRY]), dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k2', cardinality: 'many-to-one', role: 'ship date' }])],
    })).toEqual(['otherChanged']);
  });

  it('does not mind another link moving file in the same meaning, or gaining a role', () => {
    const plain = snap([dim(), fct([{ ...BYSTANDER, role: undefined }])]);
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, plain, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
    const backwards = snap([dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k2', cardinality: 'one-to-many', role: 'ship date' }]), fct()]);
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, backwards, {
      models: [dim([]), fct([BYSTANDER, L_ENTRY])],
    })).toEqual([]);
  });

  it('flags a file that gains a duplicate, but not one that already had it and was not written', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {
      models: [fct([BYSTANDER, BYSTANDER, L_ENTRY])],
    })).toEqual(['duplicateInFile']);
    const dupe = snap([dim([{ fromColumn: 'name', toModel: 'fct', toColumn: 'k2', cardinality: 'one-to-one' }, { fromColumn: 'name', toModel: 'fct', toColumn: 'k2', cardinality: 'one-to-one' }]), fct([BYSTANDER])]);
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, dupe, { models: [fct([BYSTANDER, L_ENTRY])] })).toEqual([]);
  });

  it('flags a drawn result showing a link twice', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, before, {
      models: [fct([BYSTANDER, L_ENTRY])],
      drawn: [L, L_FROM_DIM, { ...BYSTANDER, fromModel: 'fct' }],
    })).toEqual(['drawnTwice']);
    expect(drawnTwiceCount([L, L_FROM_DIM, { ...L, fromColumn: 'k2' }])).toBe(1);
  });
});

describe('checkRelationshipWrite — never throws', () => {
  it('reports checkFailed for malformed input', () => {
    expect(checkRelationshipWrite({ kind: 'add', home: 'library', link: L }, { models: null, domainRelationships: [] } as never, {})).toEqual(['checkFailed']);
    expect(checkRelationshipWrite({ kind: 'delete', links: [null] } as never, snap([dim()]), {})).toEqual(['checkFailed']);
  });

  it('maps every invariant to a listed error code', () => {
    for (const code of Object.values(INVARIANT_ERROR_CODES)) expect(ERROR_CODES).toContain(code);
    expect(invariantErrorCodes(['otherLost', 'roleLost'])).toEqual(['relInvOtherLost', 'relInvRoleLost']);
  });
});

describe('surveyLibrary', () => {
  it('finds nothing in a clean star', () => {
    const s = surveyLibrary([dim(), fct([L_ENTRY, BYSTANDER])], []);
    expect(surveyFeatures(s)).toEqual([]);
    expect(Object.values(s).every((n) => n === 0)).toBe(true);
  });

  it('counts a link stored at both ends, and the one-to-many among them', () => {
    const s = surveyLibrary([dim([{ fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' }]), fct([L_ENTRY])], []);
    expect(s.storedTwice).toBe(1);
    expect(s.oneToManyInModelFile).toBe(1);
    expect(s.backwards).toBe(0);
  });

  it('counts a many-to-one stored backwards only where the keys make it certain', () => {
    const entry: ModelRelationship = { fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' };
    expect(surveyLibrary([dim([entry]), fct()], []).backwards).toBe(1);
    // No key on the target: not certain (M).
    expect(surveyLibrary([dim([entry]), { name: 'fct', columns: [col('id'), col('k')] }], []).backwards).toBe(0);
    // A 1:1 extension table pointing at its own key's twin: whole key to whole key.
    expect(surveyLibrary([dim([entry]), { name: 'fct', columns: [col('k', 'pk')] }], []).backwards).toBe(0);
  });

  it('counts dangling models and columns, in model files and the domain file', () => {
    const s = surveyLibrary([dim(), fct([
      { fromColumn: 'k', toModel: 'gone', toColumn: 'k', cardinality: 'many-to-one' },
      { fromColumn: 'missing', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' },
    ])], [{ ...L, toColumn: 'nope' }]);
    expect(s.danglingModel).toBe(1);
    expect(s.danglingColumn).toBe(2);
  });

  it('counts unreadable entries from the caller and from relationshipIssues', () => {
    const m = { ...fct(), relationshipIssues: [{}, {}] } as HealthModel;
    expect(surveyLibrary([dim(), m], [], { unreadableEntries: 3 }).unreadable).toBe(5);
    expect(countUnreadableEntries([
      L_ENTRY, 'text', null, ['a'], { fromColumn: 'k', toModel: 'dim' }, { ...L_ENTRY, cardinality: 'lots' }, { ...L_ENTRY, toModel: '' },
    ])).toBe(6);
    expect(countUnreadableEntries(undefined)).toBe(0);
  });

  it('counts partial composite groups', () => {
    const group = (g: string) => ({ ...L_ENTRY, group: g }) as ModelRelationship;
    const s = surveyLibrary([dim(), fct([
      group('a'), { ...group('a'), fromColumn: 'k2' },        // whole: two columns, one pair of models
      group('b'),                                             // one member
      group('c'), { ...group('c'), toModel: 'gone' },         // a member dangles
    ])], [], { compositeGroupOf: (r) => (r as { group?: string }).group });
    expect(s.partialComposite).toBe(2);
  });

  it('counts ends spelled in another case, and diagram copies of library links', () => {
    const s = surveyLibrary([dim(), fct([{ ...L_ENTRY, toModel: 'Dim', toColumn: 'K' }])], [L]);
    expect(s.caseRespelled).toBe(1);
    expect(s.domainCopyOfLibrary).toBe(1);
    expect(s.storedTwice).toBe(1);
  });

  it('never throws', () => {
    expect(() => surveyLibrary(null as never, null as never)).not.toThrow();
    expect(() => surveyLibrary([{ name: 'x', relationships: [null] } as never], [])).not.toThrow();
  });

  it('maps every count to a listed feature', () => {
    for (const f of Object.values(SURVEY_FEATURES)) expect(FEATURES).toContain(f);
  });

  it('stays linear on a large library', () => {
    const models: HealthModel[] = [];
    for (let i = 0; i < 2000; i++) {
      models.push({
        name: `m${i}`, columns: [col('id', 'pk'), col('ref')],
        relationships: Array.from({ length: 10 }, (_, j) => ({ fromColumn: 'ref', toModel: `m${(i + j + 1) % 2000}`, toColumn: 'id', cardinality: 'many-to-one' as const })),
      });
    }
    const t = Date.now();
    surveyLibrary(models, []);
    checkRelationshipWrite({ kind: 'delete', links: [{ fromModel: 'm0', fromColumn: 'ref', toModel: 'm1', toColumn: 'id' }] }, { models, domainRelationships: [] }, {
      models: [{ ...models[0], relationships: models[0].relationships!.slice(1) }],
    });
    expect(Date.now() - t).toBeLessThan(1500);
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
      { name: a, columns: [col(d, 'pk'), col(f)], relationships: [{ fromColumn: f, toModel: b, toColumn: c, cardinality: 'one-to-many', role: e }] },
      { name: b, columns: [col(c, 'pk')], relationships: [{ fromColumn: c, toModel: a, toColumn: f, cardinality: 'many-to-one', role: e }, { fromColumn: c, toModel: 'ghost_' + e, toColumn: d, cardinality: 'many-to-one' }] },
    ];
    const domain: Relationship[] = [{ fromModel: a.toUpperCase(), fromColumn: f, toModel: b, toColumn: c.toUpperCase(), cardinality: 'many-to-one', role: e }];
    const survey = surveyLibrary(models, domain, { unreadableEntries: 1, compositeGroupOf: () => e });
    const broken = checkRelationshipWrite(
      { kind: 'swap', home: 'library', link: { fromModel: a, fromColumn: f, toModel: b, toColumn: c, cardinality: 'many-to-many' } },
      { models, domainRelationships: domain },
      { models: [{ ...models[0], relationships: [] }, { ...models[1], relationships: [] }], drawn: [...domain, ...domain] },
    );
    expect(broken.length).toBeGreaterThan(0);
    const out = JSON.stringify([survey, surveyFeatures(survey), broken, invariantErrorCodes(broken), checkRelationshipWrite(null as never, null as never, null as never)]);
    for (const name of [...names, 'ghost']) {
      expect(out.toLowerCase()).not.toContain(name.toLowerCase());
      for (const part of name.toLowerCase().split(/[_ ]/).filter((p) => p.length > 3)) expect(out.toLowerCase()).not.toContain(part);
    }
    expect(Object.values(survey).every((n) => Number.isInteger(n) && n >= 0)).toBe(true);
  });
});
