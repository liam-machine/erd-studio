// @vitest-environment jsdom
/**
 * The exports are a contract: every core fixture that loads is exported to
 * both formats and compared with a golden (test/fixtures/golden/<fixture>.dbml
 * and .mmd), and each golden is parsed by the real parsers, old and current
 * (see ../exportParsers.ts): every DBML golden must read the same in
 * @dbml/parse 10.2.0 and @dbml/core 3.13.4, 2.6.1 and 2.4.2, and every
 * Mermaid golden must parse in Mermaid 10.0.0 and 12.0.0. A mapping change is
 * a deliberate golden update — regenerate with UPDATE_GOLDEN=1 — plus a
 * CHANGELOG line.
 *
 * Fixtures load exactly as loadDisplayDomain.golden.test.ts loads them, so the
 * old on-disk shapes (v4 inline models, nameless columns, library
 * relationships, …) are exported too.
 */

import { beforeAll, describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { loadDisplayDomain } from '../../src/loadDisplayDomain';
import { DIAGRAM_EXPORT_FILE_EXTENSIONS, DIAGRAM_EXPORT_FORMATS, exportDiagram } from '../../src/exportDiagram';
import { MERMAID_LOAD_TIMEOUT_MS, loadMermaidParsers, parseMermaid, readDbmlEverywhere } from '../exportParsers';

// Load both Mermaid releases here, outside any test's timeout (#152).
beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS);

const FIXTURES = path.resolve(__dirname, '../fixtures');
const GOLDEN_DIR = path.join(FIXTURES, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** Every fixture that loads (the errors/ project is the one that does not). */
const DOMAIN_CASES: Record<string, string> = {
  showcase: '.erd-studio/silver/showcase.json',
  'v4-inline': '.erd-studio/bronze/orders.json',
  'missing-model': '.erd-studio/silver/partial.json',
  'no-layers': '.erd-studio/gold/accounts.json',
  'missing-positions': '.erd-studio/silver/showcase.json',
  'library-relationships': '.erd-studio/gold/sales.json',
  'v4-nameless-column': '.erd-studio/silver/orders.json',
  'composite-and-self': '.erd-studio/gold/vault.json',
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
      .filter((d) => d.isDirectory() && d.name !== 'golden' && d.name !== 'errors')
      .map((d) => d.name)
      .sort();
    expect(Object.keys(DOMAIN_CASES).sort()).toEqual(projects);
  });

  describe.each(Object.entries(DOMAIN_CASES))('%s', (name, domainPath) => {
    it.each(DIAGRAM_EXPORT_FORMATS)('matches the %s golden, which old and current parsers accept', async (format) => {
      const domain = await loadDisplayDomain({
        domainPath,
        readFile: fsReadFile(path.join(FIXTURES, name)),
        readOnly: false,
        warn: () => {},
      });
      const text = exportDiagram(domain, format);
      expect(exportDiagram(JSON.parse(JSON.stringify(domain)), format)).toBe(text);

      const golden = path.join(GOLDEN_DIR, `${name}.${DIAGRAM_EXPORT_FILE_EXTENSIONS[format]}`);
      if (UPDATE) fs.writeFileSync(golden, text);
      expect(text).toBe(fs.readFileSync(golden, 'utf-8'));

      if (format === 'dbml') {
        const read = readDbmlEverywhere(text);
        expect(read.tables.length).toBe(new Set(domain.models.filter((m) => m.columns.length > 0).map((m) => m.name.toLowerCase())).size);
      } else {
        const parsed = await parseMermaid(text);
        expect(parsed.entities.length).toBe(new Set(domain.models.map((m) => m.name.toLowerCase())).size);
      }
    });
  });
});
