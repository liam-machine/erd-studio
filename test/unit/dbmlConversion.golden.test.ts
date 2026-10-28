/**
 * Convert Project to DBML over each core YAML fixture equals its DBML twin
 * (`packages/core/test/fixtures/dbml/<case>`) byte for byte (native DBML
 * storage §9.6): every twin file is either one the plan creates, with the
 * same bytes, or a file Convert leaves alone (`layers.json`), and the plan
 * writes nothing else. `library-relationships` refuses (its diagram copy
 * disagrees with the library), so its twin is compared against a variant
 * without that copy; `missing-model`'s twin is a reader tolerance case that
 * Convert cannot write, so Convert's own answer for it is asserted instead.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { planDbmlConversion } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';

const CORE_FIXTURES = path.resolve(__dirname, '../../packages/core/test/fixtures');
const VARIANTS = path.resolve(__dirname, '../fixtures/dbml-convert');

/** Every file under `dir`, relative path → text. */
function filesUnder(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf-8'));
    }
  };
  walk(dir);
  return out;
}

describe.each([
  ['composite-and-self', path.join(CORE_FIXTURES, 'composite-and-self')],
  ['showcase', path.join(CORE_FIXTURES, 'showcase')],
  ['missing-positions', path.join(CORE_FIXTURES, 'missing-positions')],
  ['library-relationships', path.join(VARIANTS, 'library-relationships-variant')],
])('Convert of the %s fixture', (twin, source) => {
  it('is its DBML twin, byte for byte', async () => {
    const input = readDbmlConversionInput(source, '.erd-studio');
    const plan = await planDbmlConversion(input);
    expect(plan.refusals).toEqual([]);
    expect(plan.replaces).toEqual([]);
    expect(plan.resumed).toEqual([]);

    // The project after the plan: untouched sources, plus the creates, minus the deletes.
    const after = filesUnder(path.join(source, '.erd-studio'));
    for (const d of plan.deletes) after.delete(d);
    for (const c of plan.creates) after.set(c.path, c.text);
    const expected = filesUnder(path.join(CORE_FIXTURES, 'dbml', twin, '.erd-studio'));
    expect([...after.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [p, text] of expected) expect(after.get(p), p).toBe(text);
    // Every YAML and JSON source goes.
    expect(plan.deletes.every((d) => d.endsWith('.yml') || d.endsWith('.json'))).toBe(true);
  });
});

describe('fixtures Convert refuses', () => {
  it('library-relationships: the diagram copy that disagrees with the library', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'library-relationships'), '.erd-studio'));
    expect(plan.refusals).toEqual([expect.stringMatching(/^gold\/sales\.json defines the relationship fct_order\.customer_key → dim_customer\.customer_key as one-to-one, but the table library defines it as many-to-one/)]);
    expect([...plan.creates, ...plan.replaces, ...plan.deletes]).toEqual([]);
  });

  it('library-relationships: the variant differs from it only by that copy', () => {
    const original = JSON.parse(fs.readFileSync(path.join(CORE_FIXTURES, 'library-relationships', '.erd-studio', 'gold', 'sales.json'), 'utf-8'));
    const variant = JSON.parse(fs.readFileSync(path.join(VARIANTS, 'library-relationships-variant', '.erd-studio', 'gold', 'sales.json'), 'utf-8'));
    expect(original.logical.relationships).toHaveLength(1);
    expect({ ...original, logical: { ...original.logical, relationships: [] } }).toEqual(variant);
    const others = (root: string): Map<string, string> => {
      const all = filesUnder(path.join(root, '.erd-studio'));
      all.delete('gold/sales.json');
      return all;
    };
    expect(others(path.join(VARIANTS, 'library-relationships-variant'))).toEqual(others(path.join(CORE_FIXTURES, 'library-relationships')));
  });

  it('missing-model (excluded from the byte check): a table file that does not parse, and one with no name', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'missing-model'), '.erd-studio'));
    expect(plan.refusals).toEqual([
      expect.stringMatching(/^logical-models\/broken\.yml does not parse as YAML \(line 5\)/),
      'logical-models/nameless.yml has no name: key, so it is not a table. Add one, or delete the file, then convert.',
    ]);
    expect([...plan.creates, ...plan.replaces, ...plan.deletes]).toEqual([]);
  });
});
