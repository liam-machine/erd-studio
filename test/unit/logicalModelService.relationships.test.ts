/**
 * Saving a model never destroys what it did not understand (issue #133, R6 /
 * defect D4): the `relationships:` list is synced entry by entry. Entries the
 * reader skipped are kept wherever they are; unknown keys, comments and a
 * cardinality the reader defaulted stay unless the entry is the one an edit
 * wrote (`relationshipTargets`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseLogicalModelText } from '@erd-studio/core';

import { LogicalModelService } from '../../src/services/logicalModelService';
import type { SemanticModel } from '../../src/types/semantic';

let root: string;
let service: LogicalModelService;

const write = (name: string, text: string): string => {
  const file = path.join(root, '.erd-studio', 'logical-models', `${name}.yml`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const read = (name: string): SemanticModel => {
  service.invalidateCache();
  return service.getModel(name)!;
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-rel-sync-'));
  service = new LogicalModelService(root, '.erd-studio');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const FILE = `name: fct_order
description: Orders
columns:
  - name: customer_key
    dataType: string
  - name: date_key
    dataType: date
relationships:
  # the customer
  - fromColumn: customer_key
    toModel: dim_customer
    toColumn: customer_key
    cardinality: one_to_many # typo: read as many-to-one
    owner: data-team
  - just a note someone left
  - fromColumn: date_key
    toColumn: date_key
    cardinality: many-to-one
  - fromColumn: date_key # ship date
    toModel: dim_date
    toColumn: date_key
    cardinality: many-to-one
    role: ship date
`;

describe('relationships are synced entry by entry (R6)', () => {
  it('an unrelated save leaves the list byte for byte — typo, comments, unknown keys, unreadable entries', () => {
    write('fct_order', FILE);
    const model = read('fct_order');
    expect(model.relationships).toHaveLength(2);
    expect(model.relationshipIssues?.map((i) => i.reason)).toEqual(['unknown-cardinality', 'not-a-mapping', 'missing-endpoint']);
    const text = service.serializeModel({ ...model, description: 'All orders' });
    expect(text).toBe(FILE.replace('description: Orders', 'description: All orders'));
  });

  it('removing the readable entries keeps the unreadable ones (never deletes what it could not read)', () => {
    write('fct_order', FILE);
    const model = read('fct_order');
    const text = service.serializeModel({ ...model, relationships: undefined });
    expect(text).toContain('- just a note someone left');
    expect(text).toContain('toColumn: date_key\n    cardinality: many-to-one\n');
    expect(text).not.toContain('dim_customer');
    expect(text).not.toContain('ship date');
    const reread = parseLogicalModelText(text, 'fct_order')!;
    expect(reread.relationships).toBeUndefined();
    expect(reread.relationshipIssues?.map((i) => i.reason)).toEqual(['not-a-mapping', 'missing-endpoint']);
  });

  it('a cascade that changes one field of an entry touches only that field (the typo stays)', () => {
    write('fct_order', FILE);
    const model = read('fct_order');
    model.relationships![0].toColumn = 'customer_sk';
    const text = service.serializeModel(model);
    expect(text).toContain('    toColumn: customer_sk\n    cardinality: one_to_many # typo: read as many-to-one\n    owner: data-team');
    expect(text).toContain('# the customer');
  });

  it('the entry an edit targets is written in full: the typo and a stray fromModel go, its comments and unknown keys stay', () => {
    write('fct_order', FILE.replace('    owner: data-team', '    owner: data-team\n    fromModel: fct_order'));
    const model = read('fct_order');
    model.relationships![0] = { ...model.relationships![0], cardinality: 'many-to-one', role: 'buyer' };
    const text = service.serializeModel(model, undefined, { relationshipTargets: [0] });
    expect(text).toContain('  # the customer\n  - fromColumn: customer_key\n    toModel: dim_customer\n    toColumn: customer_key\n    cardinality: many-to-one');
    expect(text).toContain('owner: data-team');
    expect(text).toContain('role: buyer');
    expect(text).not.toContain('fromModel');
    expect(text).toContain('- just a note someone left');
    const reread = parseLogicalModelText(text, 'fct_order')!;
    expect(reread.relationshipIssues?.map((i) => i.reason)).toEqual(['not-a-mapping', 'missing-endpoint']);
  });

  it('a new entry is appended; a removed readable one goes; the order of the rest holds', () => {
    write('fct_order', FILE);
    const model = read('fct_order');
    model.relationships = [model.relationships![1], { fromColumn: 'customer_key', toModel: 'dim_x', toColumn: 'id', cardinality: 'one-to-one' }];
    const text = service.serializeModel(model);
    const reread = parseLogicalModelText(text, 'fct_order')!;
    expect(reread.relationships).toEqual(model.relationships);
    expect(text.indexOf('just a note')).toBeLessThan(text.indexOf('ship date'));
    expect(text.indexOf('ship date')).toBeLessThan(text.indexOf('dim_x'));
    expect(text).not.toContain('one_to_many');
  });

  it('an edit that changes the ends of an entry keeps its place and comments', () => {
    write('fct_order', FILE);
    const model = read('fct_order');
    model.relationships![1] = { fromColumn: 'date_key', toModel: 'dim_calendar', toColumn: 'calendar_key', cardinality: 'many-to-one' };
    const text = service.serializeModel(model, undefined, { relationshipTargets: [1] });
    expect(text).toContain('  - fromColumn: date_key # ship date\n    toModel: dim_calendar\n    toColumn: calendar_key\n    cardinality: many-to-one\n');
    expect(text).not.toContain('role: ship date');
  });

  it('a relationships key that is not a list is left alone, and refused only when something must be written', () => {
    const odd = 'name: fct_order\nrelationships:\n  customer: dim_customer\n';
    write('fct_order', odd);
    const model = read('fct_order');
    expect(service.serializeModel({ ...model, description: 'x' })).toContain('relationships:\n  customer: dim_customer\n');
    expect(() => service.serializeModel({ ...model, relationships: [{ fromColumn: 'a', toModel: 'b', toColumn: 'c', cardinality: 'many-to-one' }] }))
      .toThrow('fct_order.yml: "relationships:" is not a list');
  });

  it('a flow-style list that did not change keeps its flow style', () => {
    const flow = 'name: fct_order\nrelationships: [ { fromColumn: a, toModel: b, toColumn: c, cardinality: many-to-one } ]\n';
    write('fct_order', flow);
    const model = read('fct_order');
    expect(service.serializeModel({ ...model, grain: 'One row per order' })).toContain('relationships: [ { fromColumn: a, toModel: b, toColumn: c, cardinality: many-to-one } ]');
  });

  it('an entry that is an alias is left as it is; an edit targeting it is refused, naming the file and entry', () => {
    const aliased = 'name: fct_order\nx-shared: &rel\n  fromColumn: a\n  toModel: b\n  toColumn: c\n  cardinality: many-to-one\nrelationships:\n  - *rel\n';
    write('fct_order', aliased);
    const model = read('fct_order');
    expect(model.relationships).toHaveLength(1);
    expect(service.serializeModel({ ...model, description: 'd' })).toContain('  - *rel\n');
    model.relationships![0] = { ...model.relationships![0], cardinality: 'one-to-one' };
    expect(() => service.serializeModel(model, undefined, { relationshipTargets: [0] }))
      .toThrow('fct_order.yml, relationship entry 1 cannot be edited in place');
  });
});

// ---------------------------------------------------------------------------
// Round trips over seeded random files
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

function randomFile(seed: number, numbers = true): string {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const lines = ['name: fct', 'columns:', '  - name: a', '    dataType: string', 'relationships:'];
  for (let i = Math.floor(rnd() * 6); i > 0; i--) {
    const kind = rnd();
    if (kind < 0.15) {
      lines.push(`  - ${pick(numbers ? ['free text', '42', '[ a, b ]'] : ['free text', '[ a, b ]'])}`);
    } else if (kind < 0.3) {
      lines.push(`  - fromColumn: ${pick(['a', 'b'])}`, `    cardinality: many-to-one`);
    } else {
      lines.push(`  - fromColumn: ${pick(['a', 'b', 'A'])}${rnd() < 0.3 ? ' # why' : ''}`);
      lines.push(`    toModel: ${pick(['dim', 'Dim', 'fct'])}`);
      lines.push(`    toColumn: ${pick(numbers ? ['id', 'key', '007'] : ['id', 'key'])}`);
      if (rnd() < 0.85) lines.push(`    cardinality: ${pick(numbers ? ['many-to-one', 'one-to-one', 'one-to-many', 'many-to-many', 'one_to_many', '3'] : ['many-to-one', 'one-to-many', 'one_to_many'])}`);
      if (rnd() < 0.3) lines.push(`    role: ${pick(numbers ? ['buyer', '"  ship  date "', '7'] : ['buyer', '"  ship  date "'])}`);
      if (rnd() < 0.3) lines.push(`    x-note: ${pick(['keep me', 'true'])}`);
    }
  }
  if (lines[lines.length - 1] === 'relationships:') lines.pop();
  return `${lines.join('\n')}\n`;
}

describe('read → write → read (seeded)', () => {
  const seeds = Array.from({ length: 150 }, (_, i) => 77 + i * 104729);

  it('an unchanged model writes back the same bytes', () => {
    for (const seed of seeds) {
      const text = randomFile(seed, false);
      write('fct', text);
      expect(service.serializeModel(read('fct')), `seed ${seed}`).toBe(text);
    }
  });

  it('an unchanged model reads back the same — numbers the parser would coerce keep their text', () => {
    for (const seed of seeds) {
      const text = randomFile(seed);
      write('fct', text);
      const model = read('fct');
      const reread = parseLogicalModelText(service.serializeModel(model), 'fct')!;
      expect(reread.relationships, `seed ${seed}`).toEqual(model.relationships);
      expect(reread.relationshipIssues?.map((i) => i.reason), `seed ${seed}`).toEqual(model.relationshipIssues?.map((i) => i.reason));
    }
  });

  it('dropping and adding entries: what is read back is what was wanted, and every unreadable entry survives', () => {
    for (const seed of seeds) {
      const rnd = mulberry32(seed ^ 0x5bd1e995);
      const text = randomFile(seed);
      write('fct', text);
      const model = read('fct');
      const skipped = (model.relationshipIssues ?? []).filter((i) => i.skipped).length;
      const kept = (model.relationships ?? []).filter(() => rnd() < 0.6);
      if (rnd() < 0.5) kept.push({ fromColumn: 'a', toModel: 'dim_new', toColumn: `c${seed}`, cardinality: 'one-to-one' });
      const out = service.serializeModel({ ...model, relationships: kept.length > 0 ? kept : undefined });
      const reread = parseLogicalModelText(out, 'fct')!;
      expect(reread.relationships ?? [], `seed ${seed}`).toEqual(kept);
      expect((reread.relationshipIssues ?? []).filter((i) => i.skipped).length, `seed ${seed}`).toBe(skipped);
    }
  });
});
