import { describe, it, expect } from 'vitest';

import { linkEnd, orientLink } from '../../src/orientLink';
import type { LinkEnd } from '../../src/orientLink';
import type { KeyEvidence } from '../../src/keyEvidence';

const end = (model: string, evidence: KeyEvidence, declaredFk = false, source: LinkEnd['source'] = evidence === 'unknown' ? 'none' : 'keys'): LinkEnd =>
  ({ model, columns: ['k'], evidence, declaredFk, source });

describe('orientLink — direction from key evidence (#133 L1)', () => {
  it('whole key + not key: many-to-one from the other end', () => {
    expect(orientLink(end('dim', 'whole-key'), end('fct', 'not-key'))).toMatchObject({ from: { model: 'fct' }, to: { model: 'dim' }, cardinality: 'many-to-one', decided: true, basis: 'keys' });
  });
  it('whole key + unknown: many-to-one from the unknown end', () => {
    expect(orientLink(end('fct', 'unknown'), end('dim', 'whole-key'))).toMatchObject({ from: { model: 'fct' }, cardinality: 'many-to-one', decided: true });
  });
  it('whole key + whole key: one-to-one from the end flagged as foreign key, else asks', () => {
    expect(orientLink(end('dim', 'whole-key'), end('brg', 'whole-key', true))).toMatchObject({ from: { model: 'brg' }, cardinality: 'one-to-one', decided: true });
    expect(orientLink(end('dim', 'whole-key'), end('ext', 'whole-key'))).toMatchObject({ cardinality: 'one-to-one', decided: false, basis: 'none' });
  });
  it('not key + unknown: many-to-one from the not-key end', () => {
    expect(orientLink(end('dim', 'unknown'), end('fct', 'not-key'))).toMatchObject({ from: { model: 'fct' }, to: { model: 'dim' }, cardinality: 'many-to-one', decided: true });
  });
  it('unknown + unknown: asks, many-to-one suggested', () => {
    expect(orientLink(end('b', 'unknown'), end('a', 'unknown'))).toMatchObject({ from: { model: 'a' }, cardinality: 'many-to-one', decided: false, basis: 'none' });
  });
  it('not key + not key: asks, many-to-many suggested', () => {
    expect(orientLink(end('b', 'not-key'), end('a', 'not-key'))).toMatchObject({ from: { model: 'a' }, cardinality: 'many-to-many', decided: false });
  });
  it('basis is dbt when any evidence used came from dbt', () => {
    expect(orientLink(end('dim', 'whole-key', false, 'dbt'), end('fct', 'unknown')).basis).toBe('dbt');
    expect(orientLink(end('dim', 'whole-key'), end('fct', 'not-key', false, 'dbt')).basis).toBe('dbt');
    expect(orientLink(end('dim', 'whole-key'), end('fct', 'unknown')).basis).toBe('keys');
  });

  it('is symmetric for every pair of evidence values', () => {
    const values: KeyEvidence[] = ['whole-key', 'not-key', 'unknown'];
    for (const a of values) for (const b of values) for (const fa of [false, true]) for (const fb of [false, true]) {
      const x = end('m_a', a, fa);
      const y = end('m_b', b, fb);
      expect(orientLink(x, y)).toEqual(orientLink(y, x));
    }
  });

  it('linkEnd reads evidence and the stored FK flag of every column', () => {
    const model = { name: 'pit', columns: [{ name: 'hk', isForeignKey: true }, { name: 'd', isForeignKey: true }, { name: 'id', isPrimaryKey: true }] };
    expect(linkEnd('pit', model, ['HK', 'd'])).toMatchObject({ evidence: 'not-key', declaredFk: true, source: 'keys' });
    expect(linkEnd('pit', model, ['hk', 'id']).declaredFk).toBe(false);
    expect(linkEnd('pit', model, ['hk'], { declaredFk: () => false }).declaredFk).toBe(false);
  });
});
