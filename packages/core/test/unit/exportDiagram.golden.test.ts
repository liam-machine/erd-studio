// @vitest-environment jsdom
/**
 * The exports are a contract: every core fixture that loads is exported to
 * every format and compared with a golden (test/fixtures/golden/<fixture>.mmd,
 * .dbml and .rich.dbml, whose Project carries the positions in erd_layout),
 * and each golden is parsed by the real parsers, old and current (see
 * ../exportParsers.ts): every DBML golden must read the same in @dbml/parse
 * 10.3.1 and @dbml/core 3.13.4, 2.6.1 and 2.4.2; every rich DBML golden must
 * read the same in @dbml/parse 9.1.1, 10.3.1 and 11.0.0 with no error, no
 * warning and no lint info about NULL; and every Mermaid golden must parse in
 * Mermaid 10.0.0 and 12.0.0. A mapping change is a deliberate golden update —
 * regenerate with UPDATE_GOLDEN=1 — plus a CHANGELOG line.
 *
 * Fixtures load exactly as loadDisplaySubjectArea.golden.test.ts loads them, so the
 * old on-disk shapes (v4 inline models, nameless columns, library
 * relationships, …) are exported too.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplaySubjectArea } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import { dbmlStorageReader, readErdLayoutDbml } from '../../src/dbml/index';
import { MERMAID_LOAD_TIMEOUT_MS, goldenFileName, loadMermaidParsers, parseMermaid, readDbmlEverywhere, readDbmlRich } from '../exportParsers';

// Load both Mermaid releases here, outside any test's timeout (#152).
beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

const FIXTURES = path.resolve(__dirname, '../fixtures');
const GOLDEN_DIR = path.join(FIXTURES, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Every fixture that loads (the errors/ project is the one that does not). */
const SUBJECT_AREA_CASES: Record<string, string> = {
  showcase: '.erd-studio/silver/showcase.json',
  'v4-inline': '.erd-studio/bronze/orders.json',
  'missing-model': '.erd-studio/silver/partial.json',
  'no-layers': '.erd-studio/gold/accounts.json',
  'missing-positions': '.erd-studio/silver/showcase.json',
  'library-relationships': '.erd-studio/gold/sales.json',
  'v4-nameless-column': '.erd-studio/silver/orders.json',
  'composite-and-self': '.erd-studio/gold/vault.json',
  'data-type-alias': '.erd-studio/silver/orders.json',
  'domain-one-to-many': '.erd-studio/gold/sales.json',
  'duplicate-key': '.erd-studio/silver/orders.json',
};

function fsReadFile(root: string) {
  return async (p: string): Promise<string | null> => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}

describe('diagram export goldens', () => {
  it('covers every fixture project that has a domain to load', () => {
    const projects = fs
      .readdirSync(FIXTURES, { withFileTypes: true })
      // naming-*: v6 and mixed copies of other projects, held to those projects' goldens (#181).
      // dbml/: the native DBML twins, held to the YAML goldens through the storage comparator.
      .filter((d) => d.isDirectory() && d.name !== 'golden' && d.name !== 'errors' && d.name !== 'dbml' && !d.name.startsWith('naming-'))
      .map((d) => d.name)
      .sort();
    expect(Object.keys(SUBJECT_AREA_CASES).sort()).toEqual(projects);
  });

  describe.each(Object.entries(SUBJECT_AREA_CASES))('%s', (name, domainPath) => {
    const load = () =>
      loadDisplaySubjectArea({
        domainPath,
        readFile: fsReadFile(path.join(FIXTURES, name)),
        readOnly: false,
        warn: () => {},
      });

    it.each(DIAGRAM_EXPORT_FORMATS)('matches the %s golden, which old and current parsers accept', async (format) => {
      const domain = await load();
      const text = exportDiagram(domain, format);
      expect(exportDiagram(JSON.parse(JSON.stringify(domain)), format)).toBe(text);

      const golden = path.join(GOLDEN_DIR, goldenFileName(name, format));
      if (UPDATE) fs.writeFileSync(golden, text);
      expect(text).toBe(fs.readFileSync(golden, 'utf-8'));

      if (format === 'dbml') {
        const read = readDbmlEverywhere(text);
        expect(read.tables.length).toBe(new Set(domain.models.filter((m) => m.columns.length > 0).map((m) => m.name.toLowerCase())).size);
      } else if (format === 'dbml-rich') {
        // Every table is written, a table without columns with a placeholder column.
        const read = readDbmlRich(text);
        expect(read.tables.length).toBe(new Set(domain.models.map((m) => m.name.toLowerCase())).size);
        // erd_layout places only tables the export writes, each under its own name, and reads back with no problem.
        const layout = readErdLayoutDbml(text)!;
        expect(layout.problemsAt).toEqual([]);
        const tables = new Set(read.tables.map((t) => t.name));
        for (const placed of Object.keys(layout.positions)) expect(tables.has(placed), placed).toBe(true);
      } else {
        const parsed = await parseMermaid(text);
        expect(parsed.entities.length).toBe(new Set(domain.models.map((m) => m.name.toLowerCase())).size);
      }
    });
  });

  // The native DBML twins (packages/core/test/fixtures/dbml/<case>) export
  // through the same exporters. They draw their relationships in the sorted
  // order of a relationships file, so their exports are not byte-equal to the
  // YAML goldens; they are held to the parsers instead, with the same counts.
  describe.each([
    ['showcase', '.erd-studio/silver/diagrams/showcase.dbml'],
    ['library-relationships', '.erd-studio/gold/diagrams/sales.dbml'],
    ['composite-and-self', '.erd-studio/gold/diagrams/vault.dbml'],
    ['missing-positions', '.erd-studio/silver/diagrams/showcase.dbml'],
    ['missing-model', '.erd-studio/silver/diagrams/partial.dbml'],
    ['missing-model-converted', '.erd-studio/silver/diagrams/partial.dbml'],
  ])('the DBML twin of %s', (name, domainPath) => {
    it.each(DIAGRAM_EXPORT_FORMATS)('exports %s that old and current parsers accept', async (format) => {
      const domain = await loadDisplaySubjectArea({
        domainPath,
        readFile: fsReadFile(path.join(FIXTURES, 'dbml', name)),
        readOnly: false,
        warn: () => {},
        dbml: dbmlStorageReader,
      });
      const text = exportDiagram(domain, format);
      if (format === 'dbml') {
        expect(readDbmlEverywhere(text).tables.length).toBe(new Set(domain.models.filter((m) => m.columns.length > 0).map((m) => m.name.toLowerCase())).size);
      } else if (format === 'dbml-rich') {
        expect(readDbmlRich(text).tables.length).toBe(new Set(domain.models.map((m) => m.name.toLowerCase())).size);
      } else {
        expect((await parseMermaid(text)).entities.length).toBe(new Set(domain.models.map((m) => m.name.toLowerCase())).size);
      }
    });
  });
});
