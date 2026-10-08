/**
 * A teammate on ERD Studio 1.6.7 and a composite foreign key (#133 L2): the
 * design's §5 proofs, run. 1.6.7's writer is simulated from its source
 * (`git show v1.6.7:…`): `readRelationships` keeps an entry only with string
 * fromColumn / toModel / toColumn and reads those four fields; `modelToPlain`
 * writes back exactly those four; `syncMap` replaces the whole
 * `relationships:` node whenever it differs from that (an extra key on any
 * entry is a difference). Domain-file handlers rewrite the entry they touch
 * as a fresh object and leave the others' keys alone.
 *
 * Grouped single-column entries degrade to single links — never a lost pair.
 * The rejected array form (`fromColumns: [a, b]`) would be deleted outright.
 */

import { describe, it, expect } from 'vitest';
import { isSeq, parseDocument } from 'yaml';

import { linkKey, mergeLibraryRelationships, parseLogicalModelText } from '@erd-studio/core';
import type { Relationship } from '@erd-studio/core';

type Entry167 = { fromColumn: string; toModel: string; toColumn: string; cardinality: string };

/** 1.6.7's `readRelationships`: the four fields of every entry it can read. */
function read167(value: unknown): Entry167[] {
  if (!Array.isArray(value)) return [];
  const out: Entry167[] = [];
  for (const r of value as Array<Record<string, unknown> | null>) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const { fromColumn, toModel, toColumn, cardinality } = r;
    if (typeof fromColumn !== 'string' || typeof toModel !== 'string' || typeof toColumn !== 'string') continue;
    if (!fromColumn || !toModel || !toColumn) continue;
    const valid = ['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many'];
    out.push({ fromColumn, toModel, toColumn, cardinality: typeof cardinality === 'string' && valid.includes(cardinality) ? cardinality : 'many-to-one' });
  }
  return out;
}

/** A 1.6.7 save of a model file: its parse, an optional edit to the list, then `syncMap`'s relationships branch. */
function save167(text: string, edit: (rels: Entry167[]) => Entry167[] = (r) => r): string {
  const doc = parseDocument(text);
  const desired = edit(read167((doc.toJSON() as { relationships?: unknown }).relationships));
  const existing = doc.get('relationships', true);
  // sameMetaValue: same item count and the same keys and values on every entry.
  const same = isSeq(existing) && JSON.stringify(existing.toJSON()) === JSON.stringify(desired);
  if (same) return doc.toString();
  if (desired.length === 0) doc.delete('relationships');
  else doc.set('relationships', doc.createNode(desired));
  return doc.toString();
}

const PIT_YML = [
  'name: pit_customer',
  'columns:',
  '  - name: customer_hk',
  '    dataType: string',
  '  - name: as_of_date',
  '    dataType: date',
  'relationships:',
  '  - fromColumn: customer_hk',
  '    toModel: sat_customer',
  '    toColumn: customer_hk',
  '    cardinality: many-to-one',
  '    compositeKey: fk_sat_customer',
  '    role: as of',
  '  - fromColumn: as_of_date',
  '    toModel: sat_customer',
  '    toColumn: load_date',
  '    cardinality: many-to-one',
  '    compositeKey: fk_sat_customer',
  '    role: as of',
  '',
].join('\n');
const SAT = { name: 'sat_customer', columns: [{ name: 'customer_hk', dataType: 'string', description: '' }, { name: 'load_date', dataType: 'date', description: '' }] };
const PAIRS = [
  linkKey({ fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk' }),
  linkKey({ fromModel: 'pit_customer', fromColumn: 'as_of_date', toModel: 'sat_customer', toColumn: 'load_date' }),
].sort();

/** What this version draws from a pit_customer.yml text. */
function drawn(text: string): Relationship[] {
  return mergeLibraryRelationships([parseLogicalModelText(text, 'pit_customer')!, SAT], []);
}

describe('a composite foreign key and a teammate on 1.6.7 (#133 L2, §5)', () => {
  it('this version draws the group as one composite (the starting point)', () => {
    expect(drawn(PIT_YML).map((r) => [r.compositeKey, r.role])).toEqual([['fk_sat_customer', 'as of'], ['fk_sat_customer', 'as of']]);
  });

  it('1.6.7 reads every member as a single link', () => {
    expect(read167((parseDocument(PIT_YML).toJSON() as { relationships: unknown }).relationships)).toHaveLength(2);
  });

  it('a 1.6.7 save of the grouped file (any edit) keeps every pair, losing only the grouping and the role', () => {
    const after = save167(PIT_YML);
    expect(after).not.toContain('compositeKey');
    expect(after).not.toContain('role:');
    expect(drawn(after).map(linkKey).sort()).toEqual(PAIRS);
    expect(drawn(after).every((r) => r.compositeKey === undefined)).toBe(true);
  });

  it('1.6.7 deleting one member removes exactly that pair; the other survives as a single link', () => {
    const after = save167(PIT_YML, (rels) => rels.filter((r) => r.fromColumn !== 'as_of_date'));
    expect(drawn(after).map(linkKey)).toEqual([PAIRS.find((k) => k.includes('customer_hk'))]);
  });

  it('a domain file: 1.6.7 rewrites only the entry it edits; no pair is lost, and the rest read as singles', () => {
    const own: Array<Record<string, unknown>> = [
      { fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', compositeKey: 'fk_sat' },
      { fromModel: 'pit_customer', fromColumn: 'as_of_date', toModel: 'sat_customer', toColumn: 'load_date', cardinality: 'many-to-one', compositeKey: 'fk_sat' },
    ];
    // 1.6.7 handleEditRelationship: the edited entry becomes a fresh object.
    const after = own.map((r, i) => (i === 0 ? { fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, cardinality: 'one-to-one' } : r));
    const warnings: string[] = [];
    const lines = mergeLibraryRelationships([parseLogicalModelText(PIT_YML.slice(0, PIT_YML.indexOf('relationships:')), 'pit_customer')!, SAT],
      after as unknown as Relationship[], 'd.json', (m) => warnings.push(m));
    expect(lines.map(linkKey).sort()).toEqual(PAIRS);
    expect(lines.every((r) => r.compositeKey === undefined)).toBe(true);
    expect(warnings).toEqual([expect.stringContaining('do not form one composite key (it has only one column pair)')]);
  });

  it('the rejected array form would lose the relationship on any 1.6.7 save (why the design groups single entries)', () => {
    const arrayForm = PIT_YML.slice(0, PIT_YML.indexOf('relationships:')) + [
      'relationships:',
      '  - fromColumns: [customer_hk, as_of_date]',
      '    toModel: sat_customer',
      '    toColumns: [customer_hk, load_date]',
      '    cardinality: many-to-one',
      '',
    ].join('\n');
    expect(save167(arrayForm)).not.toContain('relationships:');
  });
});
