import { describe, it, expect } from 'vitest';

import {
  EMPTY_DBT_KEY_INDEX, buildDbtKeyIndex, keyEvidence, keyEvidenceDetail, keyEvidenceOf,
} from '../../src/keyEvidence';
import type { DbtTestSource } from '../../src/keyEvidence';
import { contradictsKeys, keyedRelationship } from '../../src/relationships';

const col = (name: string, flags: Record<string, boolean> = {}) => ({ name, ...flags });

describe('keyEvidence — flags (#133 rule 1)', () => {
  const dim = { name: 'dim', columns: [col('k', { isPrimaryKey: true })] };
  const fct = { name: 'fct', columns: [col('id', { isPrimaryKey: true }), col('K')] };
  const bare = { name: 'bare', columns: [col('k')] };
  const composite = { name: 'sat', columns: [col('k', { isPrimaryKey: true }), col('v', { isPrimaryKey: true }), col('x')] };
  const natural = { name: 'nat', columns: [col('id', { isPrimaryKey: true }), col('k', { isNaturalKey: true })] };

  it('says whole-key for the full PK or NK set, not-key for anything else in a keyed model', () => {
    expect([keyEvidence(dim, 'K'), keyEvidence(fct, 'k'), keyEvidence(natural, 'k'), keyEvidence(natural, 'id')])
      .toEqual(['whole-key', 'not-key', 'whole-key', 'whole-key']);
  });

  it('M: a model with no key flagged (or no model) is unknown', () => {
    expect([keyEvidence(bare, 'k'), keyEvidence(null, 'k')]).toEqual(['unknown', 'unknown']);
  });

  it('column sets: the composite key whole, in any order and case, and none of its parts', () => {
    expect(keyEvidenceOf(composite, ['V', 'k'])).toBe('whole-key');
    expect(keyEvidenceOf(composite, ['k'])).toBe('not-key');
    expect(keyEvidenceOf(composite, ['k', 'v', 'x'])).toBe('not-key');
  });

  it('builds contradictsKeys and keyedRelationship on it', () => {
    const models: Record<string, { name: string; columns: Array<{ name: string }> }> = { dim, fct, bare };
    const back = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' as const };
    expect(contradictsKeys(back, (n) => models[n])).toBe(true);
    expect(contradictsKeys({ ...back, toModel: 'bare' }, (n) => models[n])).toBe(false);
    expect(keyedRelationship(back, (n) => models[n])).toEqual({ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' });
  });
});

describe('keyEvidence — dbt tests (#133 rule 2)', () => {
  const source: DbtTestSource = {
    uniqueColumns: new Map([['Dim', new Set(['K'])]]),
    compositeUniqueGroups: new Map([['sat', [['hk', 'load_date']]], ['ref', [['code']]]]),
    relationshipTests: [{ fromModel: 'fct', fromColumn: 'k' }, { fromModel: 'dim', fromColumn: 'k' }],
  };
  const index = buildDbtKeyIndex([source]);
  const bare = (name: string, ...names: string[]) => ({ name, columns: names.map((n) => col(n)) });

  it('a unique test, a one-column unique combination, part of a combination, a relationships test', () => {
    expect(keyEvidenceDetail(bare('dim', 'k'), ['k'], index)).toEqual({ evidence: 'whole-key', source: 'dbt', because: 'unique-test' });
    expect(keyEvidenceDetail(bare('ref', 'code'), ['code'], index)).toEqual({ evidence: 'whole-key', source: 'dbt', because: 'unique-combination' });
    expect(keyEvidenceDetail(bare('sat', 'hk', 'load_date'), ['hk'], index))
      .toEqual({ evidence: 'not-key', source: 'dbt', because: 'part-of-unique-combination' });
    expect(keyEvidenceDetail(bare('fct', 'k'), ['k'], index)).toEqual({ evidence: 'not-key', source: 'dbt', because: 'relationships-test' });
    expect(keyEvidenceDetail(bare('other', 'k'), ['k'], index)).toEqual({ evidence: 'unknown', source: 'none' });
  });

  it('column sets: a combination equal to the set is the whole key', () => {
    expect(keyEvidenceOf(bare('sat', 'hk', 'load_date'), ['LOAD_DATE', 'hk'], index)).toBe('whole-key');
    expect(keyEvidenceOf(bare('sat', 'hk', 'load_date', 'x'), ['hk', 'x'], index)).toBe('unknown');
  });

  it('flags win over dbt: a flagged model never consults the tests', () => {
    const flagged = { name: 'dim', columns: [col('k'), col('k_x', { isPrimaryKey: true })] };
    expect(keyEvidenceDetail(flagged, ['k'], index)).toEqual({ evidence: 'not-key', source: 'keys' });
  });

  it('a column\'s own dbtKey hint is read before the index (the canvas payload)', () => {
    const canvas = { name: 'x', columns: [{ name: 'k', dbtKey: { key: 'unique' as const, because: 'unique-test' as const } }] };
    expect(keyEvidenceOf(canvas, ['k'], EMPTY_DBT_KEY_INDEX)).toBe('whole-key');
    const parts = { name: 'y', columns: ['a', 'b'].map((n) => ({ name: n, dbtKey: { key: 'not-unique' as const, because: 'part-of-unique-combination' as const, combinations: [['a', 'b']] } })) };
    expect(keyEvidenceOf(parts, ['b', 'a'])).toBe('whole-key');
    expect(keyEvidenceOf(parts, ['a'])).toBe('not-key');
  });

  it('unique beats not-unique in any source order', () => {
    const a: DbtTestSource = { relationshipTests: [{ fromModel: 'm', fromColumn: 'c' }], compositeUniqueGroups: new Map([['m', [['c', 'd']]]]) };
    const b: DbtTestSource = { uniqueColumns: Object.entries({ M: ['C'] }) };
    for (const sources of [[a, b], [b, a], [undefined, b, a]]) {
      expect(buildDbtKeyIndex(sources).columns.get('m')?.get('c')).toEqual({ key: 'unique', because: 'unique-test', combinations: [['c', 'd']] });
    }
    expect(buildDbtKeyIndex([a]).columns.get('m')?.get('c')?.key).toBe('not-unique');
    expect(buildDbtKeyIndex([a, b])).toEqual(buildDbtKeyIndex([b, a]));
  });

  it('dbt evidence reaches contradictsKeys and keyedRelationship for models with no flags', () => {
    const models: Record<string, { name: string; columns: Array<{ name: string }> }> = { dim: bare('dim', 'k'), fct: bare('fct', 'k') };
    const back = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'many-to-one' as const };
    expect(contradictsKeys(back, (n) => models[n])).toBe(false);
    expect(contradictsKeys(back, (n) => models[n], index)).toBe(true);
    expect(keyedRelationship(back, (n) => models[n], index).fromModel).toBe('fct');
  });
});
