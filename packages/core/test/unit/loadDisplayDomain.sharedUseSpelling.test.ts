/**
 * `loadDisplaySubjectArea` on two tables of one name whose files declare it
 * with no schema (packages/core/test/fixtures/dbml/same-name-unqualified:
 * `Table adresse` in tables/bqs/ and in tables/ccc/), imported side by side
 * under one spelling as ERD Studio 2.0.4 wrote them (Gerhard, photo-2):
 *
 *   use { table adresse } from '../tables/bqs/adresse.dbml'
 *   use { table adresse } from '../tables/ccc/adresse.dbml'
 *
 * Every DBML parser refuses the second line ([3003]). A Ref end `adresse`
 * in a file that imports both names neither line's table alone: it is the
 * one of them that has every column the end names, decided only when both
 * are in scope (or the other's file is gone); otherwise it is not drawn,
 * with a warning. Before, it was always the first line's table, so a Ref
 * to ccc.adresse was drawn on bqs.adresse and one between them was a
 * self-loop.
 *
 * Goldens (packages/core/test/fixtures/golden/same-name-unqualified.*):
 * regenerate with UPDATE_GOLDEN=1 for an intended change.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { dbmlStorageReader } from '../../src/dbml/index';
import type { DisplaySubjectArea } from '../../src/types/display';

type Files = Record<string, string>;

const UPDATE = process.env.UPDATE_GOLDEN === '1';
const FIXTURE = path.resolve(__dirname, '../fixtures/dbml/same-name-unqualified');
const GOLDEN_DIR = path.resolve(__dirname, '../fixtures/golden');
const diagramPath = (name: string): string => `.erd-studio/bronze/diagrams/${name}.dbml`;

function fixture(): Files {
  const out: Files = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(FIXTURE, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(FIXTURE);
  return out;
}

async function load(files: Files, domainPath: string): Promise<{ display: DisplaySubjectArea; warnings: string[]; reads: string[] }> {
  const warnings: string[] = [];
  const reads: string[] = [];
  const display = await loadDisplaySubjectArea({
    domainPath,
    readFile: async (p) => {
      reads.push(p);
      return files[p] ?? null;
    },
    readOnly: false,
    warn: (m) => warnings.push(m),
    dbml: dbmlStorageReader,
  });
  return { display, warnings, reads };
}

const links = (display: DisplaySubjectArea): string[] =>
  display.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`).sort();

describe('a diagram showing both unqualified adresse tables (sap)', () => {
  it('draws both, each from its own file, and each Ref on the adresse whose columns it names: no collapse, no self-loop', async () => {
    const { display } = await load(fixture(), diagramPath('sap'));
    expect(display.models.map((m) => ({ name: m.name, columns: m.columns.map((c) => c.name) })).sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
      { name: 'bqs.adresse', columns: ['id', 'strasse', 'ort'] },
      { name: 'bqs__v_sap_prod_unit2', columns: ['unit_id', 'bqs_adresse_id', 'ccc_adresse_id'] },
      { name: 'ccc.adresse', columns: ['adr_id', 'street', 'city', 'postcode'] },
    ]);
    expect(links(display)).toEqual([
      'bqs__v_sap_prod_unit2.bqs_adresse_id>bqs.adresse.id',
      'bqs__v_sap_prod_unit2.ccc_adresse_id>ccc.adresse.adr_id',
      'ccc.adresse.adr_id>bqs.adresse.id',
    ]);
  });

  it('a Ref end whose columns neither table has is not drawn, and the warning says how to write it', async () => {
    const { display, warnings } = await load(fixture(), diagramPath('sap'));
    expect(links(display).some((l) => l.includes('nowhere'))).toBe(false);
    const said = warnings.filter((w) => w.includes('nowhere'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("names adresse, which the file's use lines import from more than one schema folder (bqs, ccc) under that one spelling");
    expect(said[0]).toContain('Table bqs.adresse');
  });
});

describe('a diagram showing one of them (bqs-only)', () => {
  it('reads the other adresse file to learn it exists, and then draws no Ref whose spelling both share: never guessed', async () => {
    const { display, reads } = await load(fixture(), diagramPath('bqs-only'));
    expect(display.models.map((m) => m.name).sort()).toEqual(['adresse', 'bqs__v_sap_prod_unit2']);
    expect(reads).toContain('.erd-studio/bronze/tables/ccc/adresse.dbml');
    expect(links(display)).toEqual([]);
  });

  it('when the other file is gone, the Refs whose columns the shown table has are drawn on it', async () => {
    const files = fixture();
    delete files['.erd-studio/bronze/tables/ccc/adresse.dbml'];
    const { display } = await load(files, diagramPath('bqs-only'));
    expect(links(display)).toEqual(['bqs__v_sap_prod_unit2.bqs_adresse_id>adresse.id']);
  });
});

describe('golden: what core draws for the unqualified twin fixture', () => {
  it.each(['sap', 'bqs-only'])('the %s diagram', async (name) => {
    const { display } = await load(fixture(), diagramPath(name));
    const file = path.join(GOLDEN_DIR, `same-name-unqualified.${name}.display.json`);
    const text = JSON.stringify(display, null, 2) + '\n';
    if (UPDATE) fs.writeFileSync(file, text);
    expect(text).toBe(fs.readFileSync(file, 'utf-8'));
  });
});
