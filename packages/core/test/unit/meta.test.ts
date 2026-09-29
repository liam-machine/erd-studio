import { describe, it, expect } from 'vitest';

import { formatMetaValue, readMeta, setMetaEntry } from '../../src/meta';
import type { Meta } from '../../src/types/semantic';

describe('readMeta', () => {
  it('normalises plain data: numbers become their text, nested values keep their shape', () => {
    expect(readMeta({ owner: 'crm', tier: 1, pii: true, gone: null, tags: ['a', 2], lineage: { up: ['x'] } })).toEqual({
      owner: 'crm', tier: '1', pii: true, gone: null, tags: ['a', '2'], lineage: { up: ['x'] },
    });
  });

  it('is nothing for a missing, empty or non-map value', () => {
    expect(readMeta(undefined)).toBeUndefined();
    expect(readMeta({})).toBeUndefined();
    expect(readMeta(['owner'])).toBeUndefined();
    expect(readMeta('owner: crm')).toBeUndefined();
    expect(readMeta(new Map([['owner', 'crm']]))).toBeUndefined();
  });

  it('merges several sources left to right, a later one winning per top-level key', () => {
    // dbt's `meta:` then `config: meta:` — the config wins, as dbt merges them.
    expect(readMeta({ owner: 'a', lineage: { up: ['x'] } }, undefined, { owner: 'b', sla: 24 })).toEqual({
      owner: 'b', lineage: { up: ['x'] }, sla: '24',
    });
  });

  it('keeps a __proto__ key as data', () => {
    const meta = readMeta(JSON.parse('{"__proto__": "x", "owner": "crm"}'))!;
    expect(Object.keys(meta)).toEqual(['__proto__', 'owner']);
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
  });
});

describe('setMetaEntry', () => {
  it('sets an own, enumerable property for any key', () => {
    const meta: Meta = {};
    setMetaEntry(meta, '__proto__', 'x');
    expect(Object.entries(meta)).toEqual([['__proto__', 'x']]);
  });
});

describe('formatMetaValue', () => {
  it('renders one line, nested values in YAML flow style', () => {
    expect(formatMetaValue('x')).toBe('x');
    expect(formatMetaValue(false)).toBe('false');
    expect(formatMetaValue(null)).toBe('—');
    expect(formatMetaValue({ a: 'b', c: { d: ['e'] } })).toBe('{ a: b, c: { d: [e] } }');
  });
});
