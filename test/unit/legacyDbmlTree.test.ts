/**
 * The ERD Studio 1.9 pre-release's DBML tree (§1.8 of the 2.0 design):
 * which projects hold one, which files it lists, that the verdict is
 * memoised until a listed directory changes, and the message. Every tree is
 * built here from inline literals, never from a fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire, syncBuiltinESMExports } from 'module';

import {
  LEGACY_DBML_TREE_NEXT_STEP,
  clearLegacyDbmlTreeVerdicts,
  detectLegacyDbmlTree,
  legacyDbmlTreeMessage,
} from '../../src/services/legacyDbmlTree';

let root: string;

/** Write `files` (semantic-relative path → text) under a fresh semantic dir. */
function project(files: Record<string, string>): string {
  const semanticRoot = path.join(root, '.erd-studio');
  fs.mkdirSync(semanticRoot, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(semanticRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return semanticRoot;
}

/** Set the mtime of `dir` and every directory under it, well in the past (out of the racy window). */
function settle(dir: string, when = new Date(Date.UTC(2026, 0, 1))): void {
  fs.utimesSync(dir, when, when);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) settle(path.join(dir, entry.name), when);
  }
}

const LAYERS = JSON.stringify({ layers: [{ id: 'gold', label: 'Gold' }] });

const TREE_1_9 = {
  'layers.json': LAYERS,
  'tables/gold/fct_order.dbml': 'Table fct_order {\n  id int [pk]\n}\n',
  'tables/gold/_relationships.dbml': 'Ref: fct_order.customer_id > dim_customer.id\n',
  'gold/sales.dbml': "use { table fct_order } from '../tables/gold/fct_order.dbml'\n\nProject sales {\n}\n",
  'gold/sales.dbdiagram': '{"tables":[]}\n',
};

beforeEach(() => {
  clearLegacyDbmlTreeVerdicts();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-legacy-tree-'));
});

afterEach(() => {
  clearLegacyDbmlTreeVerdicts();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('detectLegacyDbmlTree', () => {
  it('finds a 1.9 tree and lists its files, byte-sorted', () => {
    const semanticRoot = project(TREE_1_9);
    expect(detectLegacyDbmlTree(semanticRoot)).toEqual({
      files: ['gold/sales.dbdiagram', 'gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/fct_order.dbml'],
    });
  });

  it('finds a flat 1.9 library and a lone layout file', () => {
    expect(detectLegacyDbmlTree(project({ 'tables/fct_order.dbml': 'Table fct_order {\n  id int\n}\n' }))).toEqual({ files: ['tables/fct_order.dbml'] });
    clearLegacyDbmlTreeVerdicts();
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    expect(detectLegacyDbmlTree(project({ 'gold/sales.dbdiagram': '{}' }))).toEqual({ files: ['gold/sales.dbdiagram'] });
  });

  it('gives no verdict for a YAML project', () => {
    const semanticRoot = project({
      'layers.json': LAYERS,
      'logical-models/dim_customer.yml': 'name: dim_customer\n',
      'logical-models/gold/fct_order.yml': 'name: fct_order\n',
      'gold/sales.json': '{"schemaVersion":5}\n',
      'templates/default.yml': 'columns: []\n',
    });
    expect(detectLegacyDbmlTree(semanticRoot)).toBeNull();
  });

  it('gives no verdict for a lone <layer>/x.dbml', () => {
    expect(detectLegacyDbmlTree(project({ 'layers.json': LAYERS, 'gold/x.dbml': 'Table x {\n  id int\n}\n' }))).toBeNull();
  });

  it('gives no verdict for a v6 tables/ library of yml', () => {
    expect(detectLegacyDbmlTree(project({ 'tables/dim_customer.yml': 'name: dim_customer\n', 'tables/gold/fct_order.yml': 'name: fct_order\n' }))).toBeNull();
  });

  it('gives no verdict for the layer-first tree', () => {
    const semanticRoot = project({
      'layers.json': LAYERS,
      'gold/diagrams/sales.dbml': "use { table sales.fct_order } from '../tables/sales/fct_order.dbml'\n\nProject sales {\n}\n",
      'gold/tables/sales/fct_order.dbml': 'Table sales.fct_order {\n  id int [pk]\n}\n',
      'gold/relationships/gold.dbml': '// ERD Studio relationships\n',
      'README.md': '# .erd-studio\n',
    });
    expect(detectLegacyDbmlTree(semanticRoot)).toBeNull();
  });

  it('gives no verdict for a semantic dir that does not exist', () => {
    expect(detectLegacyDbmlTree(path.join(root, 'nowhere'))).toBeNull();
  });

  describe('the memo', () => {
    const cjsFs = createRequire(__filename)('fs') as typeof fs;
    const realReaddir = cjsFs.readdirSync;
    let listings = 0;

    beforeEach(() => {
      listings = 0;
      (cjsFs as { readdirSync: unknown }).readdirSync = function (this: unknown, ...args: unknown[]) {
        listings++;
        return (realReaddir as (...a: unknown[]) => unknown).apply(this, args);
      };
      syncBuiltinESMExports();
    });

    afterEach(() => {
      cjsFs.readdirSync = realReaddir;
      syncBuiltinESMExports();
    });

    it('re-lists only after a listed directory changes', () => {
      const semanticRoot = project(TREE_1_9);
      settle(semanticRoot);
      listings = 0;
      const first = detectLegacyDbmlTree(semanticRoot);
      // The semantic dir, tables/, gold/ and tables/gold/.
      expect(listings).toBe(4);
      expect(detectLegacyDbmlTree(semanticRoot)).toBe(first);
      expect(listings).toBe(4);

      fs.writeFileSync(path.join(semanticRoot, 'tables', 'gold', 'dim_date.dbml'), 'Table dim_date {\n  id int\n}\n');
      settle(path.join(semanticRoot, 'tables', 'gold'), new Date(Date.UTC(2026, 0, 2)));
      listings = 0;
      const second = detectLegacyDbmlTree(semanticRoot);
      expect(listings).toBe(4);
      expect(second?.files).toContain('tables/gold/dim_date.dbml');
      expect(detectLegacyDbmlTree(semanticRoot)).toBe(second);
      expect(listings).toBe(4);
    });

    it('re-lists when the verdict was taken while a directory was still changing', () => {
      const semanticRoot = project(TREE_1_9);
      detectLegacyDbmlTree(semanticRoot);
      const after = listings;
      // Just written: within the racy window, so the signature alone is not trusted.
      detectLegacyDbmlTree(semanticRoot);
      expect(listings).toBeGreaterThan(after);
    });
  });
});

describe('legacyDbmlTreeMessage', () => {
  it('names at most three files, then how many more', () => {
    const files = ['gold/sales.dbdiagram', 'gold/sales.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/fct_order.dbml', 'tables/gold/x.dbml'];
    expect(legacyDbmlTreeMessage({ files })).toBe(
      "This project's DBML files were written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read "
        + '(gold/sales.dbdiagram, gold/sales.dbml, tables/gold/_relationships.dbml and 2 more). '
        + 'Undo the conversion with git revert <the conversion commit>, or restore the YAML/JSON files from git and delete the 1.9 files '
        + '(the .dbml files under tables/, the <layer>/*.dbml diagrams and every .dbdiagram). '
        + 'Then run ERD Studio: Convert Project to DBML again. Edits made since the 1.9 conversion need to be made again.',
    );
  });

  it('lists every file when there are three or fewer', () => {
    expect(legacyDbmlTreeMessage({ files: ['tables/x.dbml'] })).toContain('does not read (tables/x.dbml). Undo');
  });

  it('has a doctor next step', () => {
    expect(LEGACY_DBML_TREE_NEXT_STEP).toBe('reconvert-dbml-project');
  });
});
