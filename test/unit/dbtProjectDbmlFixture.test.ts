/**
 * `test/fixtures/dbt-project-dbml` is the dbt fixture after Convert Project
 * to DBML, byte for byte: every file of `dbt-project` (minus the harness files
 * and the sample sync plan, `DBT_DBML_EXCLUDE`) with the plan's deletes gone
 * and its creates written, and nothing else. A failure means one of them
 * changed without the other: rerun the generator.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { planDbmlConversion } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';
import {
  DBT_DBML_REGEN_COMMAND,
  DBT_DBML_SOURCE,
  DBT_DBML_TARGET,
  excludedFromDbtDbmlCopy,
} from '../../scripts/dbt-dbml-fixture';

const STALE = `test/fixtures/dbt-project-dbml is out of step with test/fixtures/dbt-project and Convert. Regenerate it:\n  ${DBT_DBML_REGEN_COMMAND}`;

/** Every file under `dir`, relative `/` path → bytes. */
function filesUnder(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).split(path.sep).join('/'), fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

describe('test/fixtures/dbt-project-dbml', () => {
  it('is a fresh Convert of test/fixtures/dbt-project, byte for byte', async () => {
    const plan = await planDbmlConversion(readDbmlConversionInput(DBT_DBML_SOURCE, '.erd-studio'));
    expect(plan.refusals, STALE).toEqual([]);
    expect(plan.replaces, STALE).toEqual([]);
    expect(plan.leftAsIs, STALE).toEqual([]);

    const expected = new Map<string, Buffer>();
    for (const [rel, bytes] of filesUnder(DBT_DBML_SOURCE)) if (!excludedFromDbtDbmlCopy(rel)) expected.set(rel, bytes);
    for (const d of plan.deletes) expected.delete(`.erd-studio/${d}`);
    for (const c of plan.creates) expected.set(`.erd-studio/${c.path}`, Buffer.from(c.text, 'utf-8'));

    const actual = filesUnder(DBT_DBML_TARGET);
    expect([...actual.keys()].sort(), STALE).toEqual([...expected.keys()].sort());
    for (const [rel, bytes] of expected) expect(actual.get(rel)?.equals(bytes), `${rel}\n${STALE}`).toBe(true);
  });

  it('holds only DBML storage: no model yml, no diagram JSON, no harness files', () => {
    const rels = [...filesUnder(DBT_DBML_TARGET).keys()];
    const erd = rels.filter((r) => r.startsWith('.erd-studio/'));
    expect(erd.filter((r) => r.endsWith('.yml'))).toEqual([]);
    expect(erd.filter((r) => r.endsWith('.json')).sort()).toEqual([
      '.erd-studio/layers.json',
      '.erd-studio/templates/blank.json',
      '.erd-studio/templates/bridge.json',
      '.erd-studio/templates/dimension.json',
      '.erd-studio/templates/fact.json',
      '.erd-studio/templates/scd2.json',
    ]);
    expect(erd.filter((r) => r.endsWith('.dbml')).length).toBeGreaterThan(10);
    expect(rels.some((r) => r.startsWith('.claude/') || r.startsWith('.agents/'))).toBe(false);
    // The dbt project itself came along.
    for (const f of ['dbt_project.yml', 'selectors.yml', 'target/manifest.json', 'target/catalog.json']) expect(rels).toContain(f);
  });

  it('a second Convert has nothing to do', async () => {
    const again = await planDbmlConversion(readDbmlConversionInput(DBT_DBML_TARGET, '.erd-studio'));
    expect(again.refusals).toEqual([]);
    expect([...again.creates, ...again.replaces, ...again.deletes]).toEqual([]);
  });
});
