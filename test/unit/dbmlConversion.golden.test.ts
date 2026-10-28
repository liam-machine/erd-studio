/**
 * Convert Project to DBML over each core YAML fixture equals its DBML twin
 * (`packages/core/test/fixtures/dbml/<case>`) byte for byte (native DBML
 * storage §9.6): every twin file is either one the plan creates, with the
 * same bytes, or a file Convert leaves alone (`layers.json`), and the plan
 * writes nothing else. `library-relationships`' diagram copy disagrees with
 * the library, so Convert leaves that diagram as JSON (D26/D27); its twin is
 * compared against a variant without that copy. `missing-model`'s twin is a
 * reader tolerance case (use lines for tables with no file); Convert's own
 * output for it is the `missing-model-converted` twin: two YAML files left as
 * they are, the missing members in erd_unlinked_tables, the diagram's
 * relationships from them as pending lines.
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
  ['missing-model-converted', path.join(CORE_FIXTURES, 'missing-model')],
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

describe('fixtures Convert leaves partly as they are', () => {
  it('library-relationships: the diagram copy that disagrees with the library keeps its diagram as JSON; the tables convert', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'library-relationships'), '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([{
      path: 'gold/sales.json',
      problem: 'It defines the relationship fct_order.customer_key → dim_customer.customer_key as one-to-one, but the table library defines it as many-to-one. ' +
        "Make them agree (or remove the diagram's copy).",
    }]);
    expect(plan.deletes).not.toContain('gold/sales.json');
    expect(plan.deletes.some((d) => d.endsWith('.yml'))).toBe(true);
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

  it('missing-model: the two YAML files it cannot read stay, named with their problems; the missing table stays on the diagram', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(path.join(CORE_FIXTURES, 'missing-model'), '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    expect(plan.leftAsIs).toEqual([
      { path: 'logical-models/broken.yml', line: 5, problem: expect.stringMatching(/^It does not parse as YAML \(line 5\): /) },
      { path: 'logical-models/nameless.yml', problem: 'It has no name: key, so ERD Studio does not read it as a table. Add one, or delete the file.' },
    ]);
    expect(plan.keptMissing).toEqual([{ diagram: 'silver/partial.dbml', tables: ['dim_missing'] }]);
  });
});
