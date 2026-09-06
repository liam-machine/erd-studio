import { describe, it, expect } from 'vitest';

import {
  detectDomainFormat,
  describeUnsupportedDomainFormat,
  getRawDomainModelNames,
  isDomainV5,
} from '../../src/types/semantic';

function doc(schemaVersion: number | undefined, models: unknown[] | undefined, extra: Record<string, unknown> = {}) {
  return {
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    domain: 'x',
    layer: 'silver',
    ...(models !== undefined ? { logical: { models, relationships: [] } } : {}),
    viewConfig: {},
    ...extra,
  };
}

describe('detectDomainFormat', () => {
  it('returns v5 for schemaVersion 5 with name references', () => {
    expect(detectDomainFormat(doc(5, ['dim_a', 'fct_b']))).toBe('v5');
  });

  it('returns v5 for an empty models array at schemaVersion 5', () => {
    expect(detectDomainFormat(doc(5, []))).toBe('v5');
    expect(detectDomainFormat(doc(5, undefined))).toBe('v5');
  });

  it('returns v4 for schemaVersion 4 with inline model objects', () => {
    expect(detectDomainFormat(doc(4, [{ name: 'dim_a', columns: [] }]))).toBe('v4');
  });

  it('returns v4 for an empty models array at schemaVersion 4', () => {
    expect(detectDomainFormat(doc(4, []))).toBe('v4');
  });

  it('lets content win: string references at schemaVersion 4 are v5', () => {
    expect(detectDomainFormat(doc(4, ['dim_a']))).toBe('v5');
  });

  it('returns hybrid for schemaVersion 5 with inline model objects (renameDomain bug shape)', () => {
    expect(detectDomainFormat(doc(5, [{ name: 'dim_a', columns: [] }]))).toBe('hybrid');
  });

  it('returns hybrid for a mix of strings and objects regardless of order', () => {
    expect(detectDomainFormat(doc(5, ['dim_a', { name: 'inline', columns: [] }]))).toBe('hybrid');
    expect(detectDomainFormat(doc(4, [{ name: 'inline', columns: [] }, 'dim_a']))).toBe('hybrid');
  });

  it('returns hybrid when an entry is neither string nor object', () => {
    expect(detectDomainFormat(doc(5, ['dim_a', null]))).toBe('hybrid');
    expect(detectDomainFormat(doc(5, [42]))).toBe('hybrid');
    expect(detectDomainFormat(doc(5, [['nested']]))).toBe('hybrid');
  });

  it('returns legacy for schemaVersion below 4', () => {
    expect(detectDomainFormat(doc(3, ['dim_a']))).toBe('legacy');
    expect(detectDomainFormat(doc(2, []))).toBe('legacy');
    expect(detectDomainFormat(doc(1, undefined))).toBe('legacy');
  });

  it('returns legacy for a top-level models array even at a modern schemaVersion', () => {
    expect(detectDomainFormat(doc(4, undefined, { models: [{ name: 'dim_a' }], relationships: [] }))).toBe('legacy');
    expect(detectDomainFormat(doc(5, ['dim_a'], { models: [] }))).toBe('legacy');
  });

  it('returns legacy for non-object input', () => {
    expect(detectDomainFormat(null)).toBe('legacy');
    expect(detectDomainFormat([])).toBe('legacy');
    expect(detectDomainFormat('nope')).toBe('legacy');
  });
});

describe('describeUnsupportedDomainFormat', () => {
  it('returns null for supported formats', () => {
    expect(describeUnsupportedDomainFormat('v4', '/p.json')).toBeNull();
    expect(describeUnsupportedDomainFormat('v5', '/p.json')).toBeNull();
  });

  it('names the file and the migration command for legacy and hybrid', () => {
    const legacy = describeUnsupportedDomainFormat('legacy', '/p.json')!;
    expect(legacy).toContain('/p.json');
    expect(legacy).toContain('Migrate to v5');
    const hybrid = describeUnsupportedDomainFormat('hybrid', '/p.json')!;
    expect(hybrid).toContain('/p.json');
    expect(hybrid).toContain('Migrate to v5');
  });
});

describe('getRawDomainModelNames', () => {
  it('reads v5 name strings', () => {
    expect(getRawDomainModelNames(doc(5, ['a', 'b']))).toEqual(['a', 'b']);
  });

  it('reads v4 inline object names', () => {
    expect(getRawDomainModelNames(doc(4, [{ name: 'a' }, { name: 'b' }]))).toEqual(['a', 'b']);
  });

  it('reads hybrid arrays and skips junk entries', () => {
    expect(getRawDomainModelNames(doc(5, ['a', { name: 'b' }, null, 7, { columns: [] }]))).toEqual(['a', 'b']);
  });

  it('reads legacy top-level models', () => {
    expect(getRawDomainModelNames(doc(2, undefined, { models: [{ name: 'a' }] }))).toEqual(['a']);
  });

  it('returns [] for non-objects', () => {
    expect(getRawDomainModelNames(null)).toEqual([]);
    expect(getRawDomainModelNames('x')).toEqual([]);
  });
});

describe('isDomainV5 (deprecated wrapper)', () => {
  it('agrees with detectDomainFormat', () => {
    expect(isDomainV5(doc(5, ['a']) as never)).toBe(true);
    expect(isDomainV5(doc(4, [{ name: 'a' }]) as never)).toBe(false);
    // Previously returned true for any empty array; now follows schemaVersion
    expect(isDomainV5(doc(4, []) as never)).toBe(false);
    expect(isDomainV5(doc(5, []) as never)).toBe(true);
    // Hybrid is not v5
    expect(isDomainV5(doc(5, [{ name: 'a' }]) as never)).toBe(false);
  });
});
