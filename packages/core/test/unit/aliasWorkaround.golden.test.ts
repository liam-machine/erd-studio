// @vitest-environment jsdom
/**
 * The alias workaround (packages/core/test/fixtures/dbml/alias-workaround):
 * before a table's identity was its schema folder and name, two warehouse
 * tables called `addresse` in the schemas `bqs` and `ccc` could not both be
 * in a project, so a customer named the second `ccc_addresse` with
 * `alias: 'addresse'` (and the same for `kunde`). Projects like this exist
 * and are ordinary tables to every later version: nothing renames them,
 * nothing rewrites them on open, and they draw and export exactly as they
 * did. These goldens were made by the code as it was before schema-scoped
 * identity existed and are never regenerated: a change that alters them
 * changes how an existing project renders.
 *
 * The extension draws the same (test/unit/dbmlDisplayParity.test.ts
 * discovers this fixture), so the core loader's output is the one pinned.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import { dbmlStorageReader } from '../../src/dbml/index';
import { MERMAID_LOAD_TIMEOUT_MS, loadMermaidParsers, parseMermaid, readDbmlEverywhere, readDbmlRich } from '../exportParsers';

beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

const FIXTURES = path.resolve(__dirname, '../fixtures');
const ROOT = path.join(FIXTURES, 'dbml', 'alias-workaround');
const GOLDEN_DIR = path.join(FIXTURES, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** The fixture's diagrams: golden name → diagram path. */
const DIAGRAMS: Record<string, string> = {
  // All four tables: both source systems, the Ref between the two addresse tables, a sticky linked to ccc_addresse.
  kunden: '.erd-studio/bronze/diagrams/kunden.dbml',
  // The ccc tables only: the Ref to bqs.addresse has its other end off the diagram.
  ccc: '.erd-studio/bronze/diagrams/ccc.dbml',
};

function readFile(p: string): Promise<string | null> {
  try {
    return Promise.resolve(fs.readFileSync(path.join(ROOT, p), 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Promise.resolve(null);
    throw err;
  }
}

async function load(domainPath: string, warnings: string[] = []) {
  return loadDisplaySubjectArea({ domainPath, readFile, readOnly: false, warn: (m) => warnings.push(m), dbml: dbmlStorageReader });
}

function matchText(file: string, text: string): void {
  const golden = path.join(GOLDEN_DIR, file);
  if (UPDATE) fs.writeFileSync(golden, text);
  expect(text).toBe(fs.readFileSync(golden, 'utf-8'));
}

describe('a project that used the alias workaround (ccc_addresse with alias addresse)', () => {
  it.each(Object.entries(DIAGRAMS))('draws the %s diagram as its golden pins, with no warning', async (name, domainPath) => {
    const warnings: string[] = [];
    const display = await load(domainPath, warnings);
    expect(warnings).toEqual([]);
    matchText(`alias-workaround.${name}.display.json`, JSON.stringify(display, null, 2) + '\n');
  });

  it('keeps every table under its own name, the warehouse name in its alias', async () => {
    const display = await load(DIAGRAMS.kunden);
    expect(display.models.map((m) => [m.name, m.schema ?? null, m.alias ?? null])).toEqual([
      ['addresse', 'bqs', null],
      ['kunde', 'bqs', null],
      ['ccc_addresse', 'ccc', 'addresse'],
      ['ccc_kunde', 'ccc', 'kunde'],
    ]);
    expect(display.relationships.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`).sort()).toEqual([
      'ccc_addresse.id>addresse.id',
      'ccc_kunde.addresse_id>ccc_addresse.id',
      'kunde.addresse_id>addresse.id',
    ]);
  });

  it.each(DIAGRAM_EXPORT_FORMATS)('exports the kunden diagram as %s exactly as its golden, which old and current parsers accept', async (format) => {
    const display = await load(DIAGRAMS.kunden);
    const text = exportDiagram(display, format);
    const file = format === 'dbml-rich' ? 'alias-workaround.kunden.rich.dbml' : format === 'dbml' ? 'alias-workaround.kunden.dbml' : 'alias-workaround.kunden.mmd';
    matchText(file, text);
    if (format === 'dbml') expect(readDbmlEverywhere(text).tables.length).toBe(4);
    else if (format === 'dbml-rich') expect(readDbmlRich(text).tables.length).toBe(4);
    else expect((await parseMermaid(text)).entities.length).toBe(4);
  });
});
