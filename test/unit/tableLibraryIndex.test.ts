/**
 * The table library's name → file index (`src/services/tableLibraryIndex.ts`):
 * every answer TableLibraryService gives from it — the file a name resolves
 * to, the table listing with duplicates, the relationships files, whether
 * `tables/` is a layer — must be what per-lookup directory reads give (the
 * reference below re-reads the disk on every call), over the YAML libraries
 * (`logical-models/`, `tables/`) and the layer-first DBML tree
 * (`<layer>/tables/<schema>/`, `<layer>/relationships/`); an index must see
 * files added, removed or renamed outside ERD Studio with no invalidate call
 * (directory signatures, and the racy-mtime rule); and its listing costs no
 * `readdir` per YAML layer, and `1 + layers × (2 + schemas)` in a DBML project.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';

import { LOGICAL_MODELS_DIR, TABLES_DIR, classifySemanticFile, dbmlTableFinder, isDbmlLayerName, matchTableRef } from '@erd-studio/core';
import { TableLibraryService, hasTablesLibrary, tablesDirIsLayer } from '../../src/services/logicalModelService';
import { COARSE_RACY_MS, RACY_MS, TableLibraryIndex, isRacyBuild } from '../../src/services/tableLibraryIndex';

let root: string;
let semantic: string;

function write(rel: string, text = ''): string {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** A DBML table file of the schema folder it sits in (`Table <schema>.<name>`). */
const dbmlTable = (name: string, columns = '  id INT [pk]', schema = 'gold'): string => `Table ${schema}.${name} {\n${columns}\n}\n`;
const yamlTable = (name: string): string => `name: ${name}\ncolumns:\n  - name: id\n    dataType: INT\n`;
const HEADER = '// ERD Studio relationships: Refs only.\n';

/** Set every directory under the semantic dir (and layers.json, and the dir itself) well in the past, so an index built now is not racy. */
function ageLibrary(): void {
  const past = new Date(Date.now() - 60_000);
  const age = (p: string): void => { try { fs.utimesSync(p, past, past); } catch { /* absent */ } };
  age(path.join(semantic, 'layers.json'));
  const walk = (dir: string): void => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) walk(path.join(dir, d.name));
    age(dir);
  };
  walk(semantic);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-lib-index-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(semantic, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const service = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');

// ---------------------------------------------------------------------------
// The reference: the lookup as it was before the index, straight from disk.
// ---------------------------------------------------------------------------

const compare = new Intl.Collator().compare;
const classify = (rel: string): ReturnType<typeof classifySemanticFile> => classifySemanticFile(rel, { tablesDirIsLayer: false });
const relOf = (filePath: string): string => path.relative(semantic, filePath).split(path.sep).join('/');
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function foldersOf(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function listedFile(dir: string, name: string, ext: '.yml' | '.dbml'): string | null {
  let files: string[];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.name.endsWith(ext) && (d.isFile() || (d.isSymbolicLink() && (() => { try { return fs.statSync(path.join(dir, d.name)).isFile(); } catch { return false; } })())))
      .map((d) => d.name)
      .filter((f) => classify(relOf(path.join(dir, f))).kind === 'table');
  } catch {
    return null;
  }
  if (files.includes(`${name}${ext}`)) return path.join(dir, `${name}${ext}`);
  const file = files.sort(compare).find((f) => sameName(f.slice(0, -ext.length), name));
  return file === undefined ? null : path.join(dir, file);
}

/** Every DBML layer folder's `tables/<schema>/` directory, layers then schemas in order. */
function dbmlSchemaDirs(): string[] {
  const layers = foldersOf(semantic).filter(isDbmlLayerName).sort(compare);
  return layers.flatMap((layer) => {
    const tables = path.resolve(semantic, layer, TABLES_DIR);
    return foldersOf(tables).sort(compare).map((schema) => path.join(tables, schema));
  });
}

function referenceFind(name: string): string | null {
  const v5 = path.resolve(semantic, LOGICAL_MODELS_DIR);
  for (const folder of ['', ...foldersOf(v5)]) {
    const hit = listedFile(path.join(v5, folder), name, '.yml');
    if (hit !== null) return hit;
  }
  const v6 = path.resolve(semantic, TABLES_DIR);
  if (fs.existsSync(v6) && !tablesDirIsLayer(semantic)) {
    for (const folder of ['', ...foldersOf(v6)]) {
      const hit = listedFile(path.join(v6, folder), name, '.yml');
      if (hit !== null) return hit;
    }
  }
  for (const dir of dbmlSchemaDirs()) {
    const hit = listedFile(dir, name, '.dbml');
    if (hit !== null) return hit;
  }
  return null;
}

/**
 * The library's table files as `rel[ (shadowed by rel)]`: YAML names match
 * exactly within a library, `tables/` is shadowed by `logical-models/` in
 * any case, and a DBML table only by a YAML file of its name (any case) or
 * an earlier DBML file in a schema folder of the same name (any case, any
 * layer): a table is its schema folder and name.
 */
function referenceListing(): string[] {
  const out: string[] = [];
  const winners = new Map<string, string>();
  const v5Winners = new Map<string, string>();
  const yamlWinners = new Map<string, string>();
  const dbmlWinners = new Map<string, string>();
  const add = (dir: string, phase: 'v5' | 'v6' | 'dbml'): void => {
    let files: Array<{ file: string; name: string }>;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).flatMap((file) => {
        const kind = classify(relOf(path.join(dir, file)));
        return kind.kind === 'table' && kind.name !== undefined ? [{ file, name: kind.name }] : [];
      }).sort((a, b) => compare(a.file, b.file));
    } catch {
      return;
    }
    for (const { file, name } of files) {
      const filePath = path.join(dir, file);
      const lower = name.toLowerCase();
      const identity = `${path.basename(dir).toLowerCase()}/${lower.trim()}`;
      const winner = phase === 'dbml'
        ? yamlWinners.get(lower) ?? dbmlWinners.get(identity)
        : winners.get(name) ?? (phase === 'v6' ? v5Winners.get(lower) : undefined);
      if (winner === undefined) {
        winners.set(name, filePath);
        if (phase === 'v5') v5Winners.set(lower, filePath);
        if (phase !== 'dbml' && !yamlWinners.has(lower)) yamlWinners.set(lower, filePath);
        if (phase === 'dbml' && !dbmlWinners.has(identity)) dbmlWinners.set(identity, filePath);
        out.push(relOf(filePath));
      } else {
        out.push(`${relOf(filePath)} (shadowed by ${relOf(winner)})`);
      }
    }
  };
  const v5 = path.join(semantic, LOGICAL_MODELS_DIR);
  if (fs.existsSync(v5)) {
    add(v5, 'v5');
    for (const f of foldersOf(v5)) add(path.join(v5, f), 'v5');
  }
  if (hasTablesLibrary(semantic)) {
    const v6 = path.join(semantic, TABLES_DIR);
    add(v6, 'v6');
    for (const f of foldersOf(v6)) add(path.join(v6, f), 'v6');
  }
  for (const dir of dbmlSchemaDirs()) add(dir, 'dbml');
  return out;
}

function listing(lib: TableLibraryService): string[] {
  return lib.listTableFiles().map((e) => (e.shadowedBy ? `${relOf(e.filePath)} (shadowed by ${relOf(e.shadowedBy)})` : relOf(e.filePath)));
}

/** Every answer of `lib` against the reference, for `names`. */
function expectSameAsReference(lib: TableLibraryService, names: readonly string[]): void {
  for (const name of names) {
    expect(lib.findTableFile(name), name).toBe(referenceFind(name));
    expect(lib.findTableNameIgnoringCase(name), name).toBe(lib.listTableFiles().find((e) => sameName(e.name, name))?.name ?? null);
  }
  expect(listing(lib)).toEqual(referenceListing());
  expect(lib.tablesDirIsLayer()).toBe(tablesDirIsLayer(semantic));
  expect(lib.hasTablesLibrary()).toBe(hasTablesLibrary(semantic));
}

// ---------------------------------------------------------------------------

describe('the index answers exactly as the per-lookup reads did', () => {
  const NAMES = ['dim_date', 'DIM_DATE', ' dim_date ', 'fct_order', 'Fct_Order', 'dim_customer', 'only_v6', 'shared', 'Shared', 'missing', '_relationships', 'stray', 'notes'];

  it('a flat YAML library, with case-only names, stray files and an upper-case extension', () => {
    write('logical-models/dim_date.yml', yamlTable('dim_date'));
    write('logical-models/DIM_DATE.yml', yamlTable('DIM_DATE'));
    write('logical-models/fct_order.YML', yamlTable('fct_order'));
    write('logical-models/notes.txt', 'x');
    write('logical-models/.hidden.yml', yamlTable('hidden'));
    expectSameAsReference(service(), NAMES);
  });

  it('a foldered library, a name in two folders, and logical-models/ beside tables/', () => {
    write('logical-models/gold/shared.yml', yamlTable('shared'));
    write('logical-models/silver/shared.yml', yamlTable('shared'));
    write('logical-models/silver/Shared.yml', yamlTable('Shared'));
    write('logical-models/.git/fct_order.yml', yamlTable('fct_order'));
    write('logical-models/a/b/deep.yml', yamlTable('deep'));
    write('tables/only_v6.yml', yamlTable('only_v6'));
    write('tables/SHARED.yml', yamlTable('SHARED'));
    expectSameAsReference(service(), [...NAMES, 'deep']);
  });

  it('the layer-first DBML tree: tables in schema folders, relationships files never tables, a name in a YAML library and a layer', () => {
    write('silver/tables/calendar/dim_date.dbml', dbmlTable('dim_date', undefined, 'calendar'));
    write('gold/tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('gold/tables/sales/Fct_Order.dbml', dbmlTable('Fct_Order', undefined, 'sales'));
    write('silver/tables/silver/Fct_Order.dbml', dbmlTable('Fct_Order', undefined, 'silver'));
    write('gold/tables/gold/_relationships.dbml', dbmlTable('_relationships'));
    write('gold/relationships/gold.dbml', HEADER);
    write('gold/relationships/customers.dbml', HEADER);
    write('silver/relationships/silver.dbml', HEADER);
    write('gold/relationships/nested/x.dbml', HEADER);
    write('gold/tables/top.dbml', dbmlTable('top'));
    write('gold/tables/gold/stray.json', '{}');
    write('gold/diagrams/sales.dbml', 'Project sales {\n}\n');
    write('logical-models/dim_customer.yml', yamlTable('dim_customer'));
    write('logical-models/fct_order.yml', yamlTable('fct_order'));
    const lib = service();
    expectSameAsReference(lib, [...NAMES, 'top']);
    // `_relationships` is an ordinary table name in the layer-first tree.
    expect(relOf(lib.findTableFile('_relationships')!)).toBe('gold/tables/gold/_relationships.dbml');
    // A `.dbml` straight in `<layer>/tables/` is no table (a table needs a schema folder).
    expect(lib.findTableFile('top')).toBeNull();
    expect(lib.listRelationshipsFiles().map(relOf)).toEqual([
      'gold/relationships/customers.dbml', 'gold/relationships/gold.dbml', 'silver/relationships/silver.dbml',
    ]);
    const order = lib.listTableFiles().find((e) => relOf(e.filePath) === 'gold/tables/gold/fct_order.dbml');
    expect(order).toMatchObject({ name: 'fct_order', folder: 'gold', layer: 'gold', storage: 'dbml', shadowedBy: path.join(semantic, 'logical-models/fct_order.yml') });
    expect(lib.listTableFiles().find((e) => e.name === 'dim_date')).toMatchObject({ folder: 'calendar', layer: 'silver', storage: 'dbml' });
    expect(lib.listTableFiles().every((e) => e.storage === 'yaml' || e.library === undefined)).toBe(true);
  });

  it('only layer-shaped top-level folders hold DBML tables (never tables/, templates/, logical-models/ or Gold/)', () => {
    write('Gold/tables/gold/upper.dbml', dbmlTable('upper'));
    write('gold.old/tables/gold/dotted.dbml', dbmlTable('dotted'));
    write('templates/tables/gold/tpl.dbml', dbmlTable('tpl'));
    write('tables/tables/gold/twice.dbml', dbmlTable('twice'));
    write('logical/tables/gold/stage.dbml', dbmlTable('stage'));
    write('diagrams/tables/gold/in_diagrams.dbml', dbmlTable('in_diagrams'));
    write('relationships/tables/gold/in_relationships.dbml', dbmlTable('in_relationships'));
    const lib = service();
    expectSameAsReference(lib, ['upper', 'dotted', 'tpl', 'twice', 'stage', 'in_diagrams', 'in_relationships']);
    expect(lib.listTableNames().sort()).toEqual(['in_diagrams', 'in_relationships']);
  });

  it('tables/ as a layer: never read as the library', () => {
    write('layers.json', JSON.stringify({ layers: [{ id: 'tables', label: 'Tables' }] }));
    write('tables/report.json', '{}');
    write('tables/only_v6.yml', yamlTable('only_v6'));
    write('logical-models/dim_date.yml', yamlTable('dim_date'));
    const lib = service();
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(true);
    expect(lib.findTableFile('only_v6')).toBeNull();
    expect(lib.listRelationshipsFiles()).toEqual([]);
  });

  it('a 1.9 pre-release leftover in tables/ changes nothing: the YAML rule decides (a .json or layers.json listing makes it a layer)', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/gold/_relationships.dbml', HEADER);
    const lib = service();
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(false);
    expect(lib.hasTablesLibrary()).toBe(false);
    expect(lib.findTableFile('dim_date')).toBeNull();
    expect(lib.listRelationshipsFiles()).toEqual([]);
    write('tables/report.json', '{}');
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(true);
    // layers.json changing is seen by its own signature: no invalidate call.
    fs.rmSync(path.join(semantic, 'tables/report.json'));
    write('layers.json', JSON.stringify({ layers: [{ id: 'tables', label: 'Tables' }] }));
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(true);
  });

  // The DBML duplicate within one library is one schema folder and name in two layers: a name in two
  // schema folders is two tables, not a duplicate (it pinned the rule before schema-scoped identity).
  it('isCrossLibraryDuplicate: a DBML copy of a YAML table and a tables/ copy of a logical-models/ one are; a duplicate within one library is not', () => {
    write('logical-models/dim_a.yml', yamlTable('dim_a'));
    write('tables/dim_c.yml', yamlTable('dim_c'));
    write('logical-models/dim_c.yml', yamlTable('dim_c'));
    write('gold/tables/gold/dim_a.dbml', dbmlTable('dim_a'));
    write('gold/tables/sales/dim_b.dbml', dbmlTable('dim_b', undefined, 'sales'));
    write('silver/tables/sales/dim_b.dbml', dbmlTable('dim_b', undefined, 'sales'));
    write('logical-models/gold/dim_d.yml', yamlTable('dim_d'));
    write('logical-models/dim_d.yml', yamlTable('dim_d'));
    const lib = service();
    const cross = Object.fromEntries(lib.listTableFiles().filter((e) => e.shadowedBy).map((e) => [relOf(e.filePath), lib.isCrossLibraryDuplicate(e)]));
    expect(cross).toEqual({
      'logical-models/gold/dim_d.yml': false,
      'tables/dim_c.yml': true,
      'gold/tables/gold/dim_a.dbml': true,
      'silver/tables/sales/dim_b.dbml': false,
    });
  });

  it('a symlinked table file is found while it points at a file', () => {
    const target = write('elsewhere/dim_date.yml', yamlTable('dim_date'));
    fs.mkdirSync(path.join(semantic, 'logical-models'), { recursive: true });
    fs.symlinkSync(target, path.join(semantic, 'logical-models/dim_date.yml'));
    fs.symlinkSync(path.join(semantic, 'nowhere.yml'), path.join(semantic, 'logical-models/fct_order.yml'));
    const lib = service();
    expectSameAsReference(lib, NAMES);
    expect(lib.findTableFile('dim_date')).not.toBeNull();
    expect(lib.findTableFile('fct_order')).toBeNull();
    // The link's target appearing later is seen at lookup (no directory changed).
    write('nowhere.yml', yamlTable('fct_order'));
    expect(lib.findTableFile('fct_order')).not.toBeNull();
  });

  it('an unsafe name still throws, before the index is asked', () => {
    write('logical-models/dim_date.yml', yamlTable('dim_date'));
    expect(() => service().findTableFile('../dim_date')).toThrow(/path separators/);
  });
});

describe('the schema-scoped rule: a DBML table is shadowed only by its own identity, or a YAML table of its name', () => {
  const scoped = (): TableLibraryService => service();
  const NAMES = ['addresse', 'Addresse', 'kunde', 'x', 'X', 'orders', 'dim_date', 'fct_order', 'missing'];

  /** Two layers, three schema folders, names shared across folders, a case-twin folder, a layer twin and a YAML table. */
  function twins(): void {
    write('bronze/tables/bqs/addresse.dbml', dbmlTable('addresse', undefined, 'bqs'));
    write('bronze/tables/bqs/kunde.dbml', dbmlTable('kunde', undefined, 'bqs'));
    write('bronze/tables/ccc/Addresse.dbml', dbmlTable('Addresse', undefined, 'ccc'));
    write('bronze/tables/ccc/kunde.dbml', dbmlTable('kunde', undefined, 'ccc'));
    // The same schema folder and name in another layer: one identity, a duplicate.
    write('silver/tables/bqs/addresse.dbml', dbmlTable('addresse', undefined, 'bqs'));
    // A schema folder spelled in another case: one identity, a duplicate.
    write('silver/tables/CCC/kunde.dbml', dbmlTable('kunde', undefined, 'CCC'));
    // A YAML table of a name still shadows every DBML table of it.
    write('logical-models/fct_order.yml', yamlTable('fct_order'));
    write('gold/tables/sales/fct_order.dbml', dbmlTable('fct_order', undefined, 'sales'));
    write('gold/tables/finance/fct_order.dbml', dbmlTable('fct_order', undefined, 'finance'));
    // Two layers, two schemas (medallion silver.orders / gold.orders): two tables.
    write('silver/tables/silver/orders.dbml', dbmlTable('orders', undefined, 'silver'));
    write('gold/tables/gold/orders.dbml', dbmlTable('orders'));
  }

  it('the rule matches its reference; the second schema folder\'s tables of a name are tables, a layer twin or case twin is not', () => {
    twins();
    expectSameAsReference(scoped(), NAMES);
    const shadowed = (lib: TableLibraryService): string[] => lib.listTableFiles().filter((e) => e.shadowedBy).map((e) => relOf(e.filePath));
    expect(shadowed(scoped()).sort()).toEqual([
      'gold/tables/finance/fct_order.dbml', 'gold/tables/sales/fct_order.dbml',
      'silver/tables/CCC/kunde.dbml', 'silver/tables/bqs/addresse.dbml',
    ]);
  });

  it('every entry carries its identity from its path: a DBML table\'s schema folder as listed, a YAML table\'s name alone', () => {
    twins();
    for (const lib of [service(), scoped()]) {
      for (const entry of lib.listTableFiles()) {
        expect(entry.id, relOf(entry.filePath)).toEqual(entry.storage === 'dbml' ? { schema: entry.folder, name: entry.name } : { schema: '', name: entry.name });
      }
    }
  });

  it('lookups by identity, name and library reference, all from the listing', () => {
    twins();
    const lib = scoped();
    expect(relOf(lib.findTableById({ schema: 'CCC', name: 'ADDRESSE' })!.filePath)).toBe('bronze/tables/ccc/Addresse.dbml');
    expect(relOf(lib.findTableById({ schema: 'bqs', name: 'addresse' })!.filePath)).toBe('bronze/tables/bqs/addresse.dbml');
    expect(lib.findTableById({ schema: 'ddd', name: 'addresse' })).toBeUndefined();
    expect(lib.isAmbiguousName('addresse')).toBe(true);
    expect(lib.isAmbiguousName('KUNDE')).toBe(true);
    expect(lib.isAmbiguousName('orders')).toBe(true);
    expect(lib.isAmbiguousName('fct_order')).toBe(false);
    expect(lib.isAmbiguousName('missing')).toBe(false);
    expect(lib.tablesNamed('addresse').map((e) => relOf(e.filePath))).toEqual(['bronze/tables/bqs/addresse.dbml', 'bronze/tables/ccc/Addresse.dbml']);
    // A name one table has keeps its bare reference; a shared one is `<schema folder>.<name>`, the folder as listed.
    expect(lib.libraryRef({ schema: 'bqs', name: 'addresse' })).toBe('bqs.addresse');
    expect(lib.libraryRef({ schema: 'ccc', name: 'addresse' })).toBe('ccc.Addresse');
    expect(lib.libraryRef({ schema: '', name: 'fct_order' })).toBe('fct_order');
    expect(lib.libraryRef({ schema: 'silver', name: 'orders' })).toBe('silver.orders');
    // A bare read still answers the first file in index order (today's answer).
    expect(relOf(lib.findTableFile('addresse')!)).toBe('bronze/tables/bqs/addresse.dbml');
    expect(lib.hasSharedNames()).toBe(true);
  });

  it('a library where no two schema folders share a name has no shared names, and every reference is bare', () => {
    write('bronze/tables/bqs/addresse.dbml', dbmlTable('addresse', undefined, 'bqs'));
    write('silver/tables/bqs/addresse.dbml', dbmlTable('addresse', undefined, 'bqs'));
    write('bronze/tables/ccc/kunde.dbml', dbmlTable('kunde', undefined, 'ccc'));
    const lib = scoped();
    expect(lib.hasSharedNames()).toBe(false);
    expect(lib.isAmbiguousName('addresse')).toBe(false);
    expect(lib.libraryRef({ schema: 'bqs', name: 'addresse' })).toBe('addresse');
  });

  it('resolveLibraryRef answers as core\'s matchTableRef over the library\'s tables', () => {
    twins();
    const lib = scoped();
    const tables = lib.listTableFiles().filter((e) => !e.shadowedBy);
    const candidates = tables.map((e) => ({ ...e.id!, ref: lib.libraryRef(e.id!)! }));
    const texts = ['addresse', 'bqs.addresse', 'BQS.Addresse', 'ccc.addresse', 'ddd.addresse', 'kunde', 'ccc.kunde', 'fct_order', 'sales.fct_order',
      'orders', 'gold.orders', 'silver.orders', 'missing', ' bqs.addresse '];
    for (const text of texts) {
      const want = matchTableRef(text, candidates);
      const got = lib.resolveLibraryRef(text);
      const shown = got.kind === 'found' ? relOf(got.entry.filePath) : got.kind === 'ambiguous' ? got.entries.map((e) => relOf(e.filePath)) : null;
      const expected = want.kind === 'found' ? relOf(tables[want.index].filePath)
        : want.kind === 'ambiguous' ? [...new Set(want.candidates.map((i) => relOf(tables[i].filePath)))] : null;
      expect(shown, text).toEqual(expected);
    }
  });
});

describe('the index sees changes made outside ERD Studio, with no invalidate call', () => {
  it('a file added, renamed and removed in a schema folder, a new schema, a new layer and a later mkdir of <layer>/relationships', () => {
    write('gold/tables/gold/dim_date.dbml', dbmlTable('dim_date'));
    ageLibrary();
    const lib = service();
    expect(lib.findTableFile('fct_order')).toBeNull();
    const builds = lib.indexBuilds;

    write('gold/tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    expect(relOf(lib.findTableFile('fct_order')!)).toBe('gold/tables/gold/fct_order.dbml');
    expect(lib.indexBuilds).toBe(builds + 1);

    fs.renameSync(path.join(semantic, 'gold/tables/gold/fct_order.dbml'), path.join(semantic, 'gold/tables/gold/fct_sale.dbml'));
    expect(lib.findTableFile('fct_order')).toBeNull();
    expect(relOf(lib.findTableFile('fct_sale')!)).toBe('gold/tables/gold/fct_sale.dbml');

    fs.rmSync(path.join(semantic, 'gold/tables/gold/fct_sale.dbml'));
    expect(lib.findTableFile('fct_sale')).toBeNull();
    expect(lib.listTableNames()).toEqual(['dim_date']);

    write('gold/tables/sales/fct_order.dbml', dbmlTable('fct_order', undefined, 'sales'));
    expect(relOf(lib.findTableFile('fct_order')!)).toBe('gold/tables/sales/fct_order.dbml');
    expect(lib.tableFolder('fct_order')).toBe('sales');

    ageLibrary();
    lib.findTableFile('fct_order');
    // `relationships/` made after the build: the layer's own signature changed.
    write('gold/relationships/gold.dbml', HEADER);
    expect(lib.listRelationshipsFiles().map(relOf)).toEqual(['gold/relationships/gold.dbml']);
    // A new layer folder: the semantic dir's signature changed.
    write('silver/tables/calendar/dim_day.dbml', dbmlTable('dim_day', undefined, 'calendar'));
    expect(relOf(lib.findTableFile('dim_day')!)).toBe('silver/tables/calendar/dim_day.dbml');
  });

  it('a library folder created after the first lookup, and one deleted', () => {
    const lib = service();
    expect(lib.dirExists()).toBe(false);
    expect(lib.findTableFile('dim_date')).toBeNull();
    write('logical-models/dim_date.yml', yamlTable('dim_date'));
    expect(lib.dirExists()).toBe(true);
    expect(lib.findTableFile('dim_date')).not.toBeNull();
    fs.rmSync(path.join(semantic, 'logical-models'), { recursive: true });
    expect(lib.dirExists()).toBe(false);
    expect(lib.findTableFile('dim_date')).toBeNull();
  });

  it('an absent layers.json, logical-models/ or tables/ is seen when created later, through the semantic dir\'s own signature', () => {
    write('gold/finance.json', '{}');
    ageLibrary();
    const lib = service();
    expect(lib.findTableFile('dim_date')).toBeNull();
    expect(lib.hasTablesLibrary()).toBe(false);

    write('tables/dim_date.yml', yamlTable('dim_date'));
    expect(relOf(lib.findTableFile('dim_date')!)).toBe('tables/dim_date.yml');
    expect(lib.hasTablesLibrary()).toBe(true);

    ageLibrary();
    lib.findTableFile('dim_date');
    write('logical-models/dim_date.yml', yamlTable('dim_date'));
    expect(relOf(lib.findTableFile('dim_date')!)).toBe('logical-models/dim_date.yml');

    ageLibrary();
    lib.findTableFile('dim_date');
    write('layers.json', JSON.stringify({ layers: [{ id: 'tables', label: 'Tables' }] }));
    expect(lib.tablesDirIsLayer()).toBe(true);
    expect(lib.hasTablesLibrary()).toBe(false);
  });

  it('an unchanged library is listed once, however many lookups follow', () => {
    for (let i = 0; i < 50; i++) write(`gold/tables/gold/t${i}.dbml`, dbmlTable(`t${i}`));
    ageLibrary();
    const lib = service();
    lib.findTableFile('t0');
    const builds = lib.indexBuilds;
    for (let i = 0; i < 50; i++) {
      expect(lib.findTableFile(`t${i}`)).not.toBeNull();
      lib.tableStorage(`t${i}`);
      lib.getTableFileError(`t${i}`);
    }
    lib.listTableFiles();
    lib.listRelationshipsFiles();
    lib.hasTablesLibrary();
    expect(lib.indexBuilds).toBe(builds);
  });

  it('a directory changed within the racy window is listed again even when its signature looks unchanged', () => {
    write('gold/tables/gold/dim_date.dbml', dbmlTable('dim_date'));
    const dir = path.join(semantic, 'gold/tables/gold');
    const index = new TableLibraryIndex(semantic, path.join(semantic, LOGICAL_MODELS_DIR), path.join(semantic, TABLES_DIR));
    // The directory changed just now: the index built from it is not trusted on its signature alone.
    fs.utimesSync(dir, new Date(), new Date());
    const before = fs.statSync(dir);
    expect(index.find('dim_date')).not.toBeNull();
    expect(index.isCold()).toBe(true);
    // A file added and the directory's times put back as they were: only the racy rule can see it.
    write('gold/tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    fs.utimesSync(dir, before.atime, before.mtime);
    expect(Date.now() - before.mtimeMs).toBeLessThan(RACY_MS * 50);
    expect(index.find('fct_order')).not.toBeNull();
  });

  it('a directory older than the racy window is trusted on its signature (the next build is the only one)', () => {
    write('gold/tables/gold/dim_date.dbml', dbmlTable('dim_date'));
    ageLibrary();
    const index = new TableLibraryIndex(semantic, path.join(semantic, LOGICAL_MODELS_DIR), path.join(semantic, 'tables'));
    index.find('dim_date');
    index.find('dim_date');
    index.find('fct_order');
    expect(index.builds).toBe(1);
    expect(index.isCold()).toBe(false);
    index.invalidate();
    expect(index.isCold()).toBe(true);
  });

  it('a directory dated ahead of the host clock is trusted on its signature, not rebuilt on every lookup', () => {
    for (let i = 0; i < 20; i++) write(`gold/tables/gold/t${i}.dbml`, dbmlTable(`t${i}`));
    ageLibrary();
    // A VM or WSL2 clock behind the machine that stamped the files, or a restored archive.
    const future = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(semantic, 'gold', 'tables', 'gold'), future, future);
    const lib = service();
    lib.findTableFile('t0');
    const builds = lib.indexBuilds;
    for (let i = 0; i < 20; i++) expect(lib.findTableFile(`t${i}`)).not.toBeNull();
    expect(lib.indexBuilds).toBe(builds);
    expect(lib.indexIsCold()).toBe(false);
    // A later change still re-stamps the directory and is seen.
    write('gold/tables/gold/t_new.dbml', dbmlTable('t_new'));
    expect(lib.findTableFile('t_new')).not.toBeNull();
  });

  it('isRacyBuild: inside the window either side of the build, wider for whole-second mtimes', () => {
    const now = 1_800_000_000_123;
    expect(isRacyBuild(now - RACY_MS + 1, now)).toBe(true);
    expect(isRacyBuild(now - RACY_MS - 1, now)).toBe(false);
    expect(isRacyBuild(now + RACY_MS - 1, now)).toBe(true);
    expect(isRacyBuild(now + 120_000, now)).toBe(false);
    // A whole-second volume floors the mtime: a change 0.9 s ago in the same second is racy.
    expect(isRacyBuild(1_800_000_000_000, 1_800_000_000_900)).toBe(true);
    expect(isRacyBuild(1_800_000_000_000, 1_800_000_000_000 + COARSE_RACY_MS + 1)).toBe(false);
    expect(isRacyBuild(0, now)).toBe(false);
  });

  it('on a whole-second volume, a same-second rename after a build is still seen', () => {
    write('logical-models/old_name.yml', yamlTable('old_name'));
    const lib = path.join(semantic, LOGICAL_MODELS_DIR);
    const sec = Math.floor(Date.now() / 1000);
    fs.utimesSync(lib, sec, sec);
    const svc = service();
    expect(svc.listTableNames()).toEqual(['old_name']);
    fs.renameSync(path.join(lib, 'old_name.yml'), path.join(lib, 'new_name.yml'));
    fs.utimesSync(lib, sec, sec);
    expect(svc.listTableNames()).toEqual(['new_name']);
    expect(svc.findTableFile('new_name')).not.toBeNull();
  });
});

describe('invalidatePaths: only what was written', () => {
  const caches = (lib: TableLibraryService) => lib as unknown as {
    dbmlCache: Map<string, unknown>;
    cache: Map<string, unknown>;
    attachMemo: { result: unknown } | undefined;
  };

  beforeEach(() => {
    write('gold/tables/gold/fct_order.dbml', dbmlTable('fct_order', '  id INT [pk]\n  customer_key INT [note: \'first\']'));
    write('gold/tables/gold/dim_customer.dbml', dbmlTable('dim_customer', '  customer_key INT [pk]'));
    write('gold/relationships/gold.dbml', `${HEADER}Ref: gold.fct_order.customer_key > gold.dim_customer.customer_key\n`);
    write('logical-models/dim_yaml.yml', yamlTable('dim_yaml'));
  });

  it('an edit to one table drops that table\'s parse only', () => {
    const lib = service();
    lib.listTables();
    const order = path.join(semantic, 'gold/tables/gold/fct_order.dbml');
    const customer = path.join(semantic, 'gold/tables/gold/dim_customer.dbml');
    const yaml = path.join(semantic, 'logical-models/dim_yaml.yml');
    const customerReading = caches(lib).dbmlCache.get(customer);
    const yamlEntry = caches(lib).cache.get(yaml);
    expect(customerReading).toBeDefined();

    lib.invalidatePaths([order]);
    expect(caches(lib).dbmlCache.has(order)).toBe(false);
    // The other tables are not re-read: the very same cached readings.
    expect(caches(lib).dbmlCache.get(customer)).toBe(customerReading);
    expect(caches(lib).cache.get(yaml)).toBe(yamlEntry);
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(1);
    expect(caches(lib).dbmlCache.get(customer)).toBe(customerReading);
  });

  it('keeps the attachment when a table changed nothing it reads, and recomputes it when its columns changed', () => {
    const lib = service();
    const first = lib.libraryAttachment();
    expect(first?.byOwner.get('fct_order')).toHaveLength(1);
    const order = path.join(semantic, 'gold/tables/gold/fct_order.dbml');

    // A note changed: same name, columns and keys — the attachment is kept as is.
    fs.writeFileSync(order, dbmlTable('fct_order', '  id INT [pk]\n  customer_key INT [note: \'second, longer\']'));
    lib.invalidatePaths([order]);
    expect(lib.libraryAttachment()).toBe(first);
    expect(lib.getTable('fct_order')?.columns[1].description).toBe('second, longer');

    // A column renamed: what the Ref resolves against changed — attached again.
    fs.writeFileSync(order, dbmlTable('fct_order', '  id INT [pk]\n  Customer_Key INT'));
    lib.invalidatePaths([order]);
    const second = lib.libraryAttachment();
    expect(second).not.toBe(first);
    expect(second?.byOwner.get('fct_order')?.[0].fromColumn).toBe('Customer_Key');
  });

  it('a table file that did not read before and reads now is seen by the attachment', () => {
    const yml = write('logical-models/dim_yaml.yml', 'name: dim_yaml\ncolumns: [\n');
    const relFile = path.join(semantic, 'gold/relationships/gold.dbml');
    fs.appendFileSync(relFile, 'Ref: gold.fct_order.id > dim_yaml.ID\n');
    const lib = service();
    const first = lib.libraryAttachment();
    expect(first?.byOwner.get('fct_order')?.find((r) => r.toModel === 'dim_yaml')?.toColumn).toBe('ID');
    // Fixed (no cache entry to drop: the broken file never had one); the column is respelled from the file now.
    fs.writeFileSync(yml, yamlTable('dim_yaml'));
    lib.invalidatePaths([yml]);
    expect(lib.libraryAttachment()?.byOwner.get('fct_order')?.find((r) => r.toModel === 'dim_yaml')?.toColumn).toBe('id');
  });

  it('a relationships file written drops the attachment', () => {
    const lib = service();
    const first = lib.libraryAttachment();
    const relFile = path.join(semantic, 'gold/relationships/gold.dbml');
    fs.writeFileSync(relFile, HEADER);
    lib.invalidatePaths([relFile]);
    const second = lib.libraryAttachment();
    expect(second).not.toBe(first);
    expect(second?.byOwner.get('fct_order')).toBeUndefined();
  });

  it('a table file created or deleted in the same clock tick is seen through invalidatePaths', () => {
    const lib = service();
    expect(lib.findTableFile('dim_region')).toBeNull();
    const created = write('gold/tables/gold/dim_region.dbml', dbmlTable('dim_region'));
    const dir = path.dirname(created);
    // Pretend the directory's signature did not move (a coarse clock), and the index is not racy.
    const index = (lib as unknown as { index: { validation: { racy: boolean; paths: string[]; sigs: string[] } } }).index;
    index.validation.racy = false;
    index.validation.sigs = index.validation.paths.map((p) => { try { const s = fs.statSync(p); return `${s.ino}:${s.mtimeMs}:${s.size}`; } catch { return '-'; } });
    expect(lib.findTableFile('dim_region')).toBeNull();
    lib.invalidatePaths([created]);
    expect(lib.findTableFile('dim_region')).toBe(path.join(dir, 'dim_region.dbml'));
  });

  it('invalidateCache(name) is invalidatePaths of that table\'s file; invalidateCache() drops everything', () => {
    const lib = service();
    lib.listTables();
    const customer = path.join(semantic, 'gold/tables/gold/dim_customer.dbml');
    const reading = caches(lib).dbmlCache.get(customer);
    lib.invalidateCache('fct_order');
    expect(caches(lib).dbmlCache.get(customer)).toBe(reading);
    lib.invalidateCache();
    expect(caches(lib).dbmlCache.size).toBe(0);
    expect(lib.indexIsCold()).toBe(true);
  });
});

describe('ERD Studio\'s own YAML writes outside the editor tell the index (the watchers swallow them)', () => {
  // On a file system with whole-second times whose directory size does not
  // follow its entries (FAT, some network mounts), a create or delete in the
  // same second as the last build leaves every signature as it was: only an
  // explicit drop of the index makes the next lookup list the library again.
  const indexOf = (lib: TableLibraryService): TableLibraryIndex => (lib as unknown as { index: TableLibraryIndex }).index;

  it('saveTable of a new table and the YAML deleteTable drop the index, and the next lookup sees them', () => {
    write('logical-models/old_name.yml', yamlTable('old_name'));
    write('logical-models/keep.yml', yamlTable('keep'));
    ageLibrary();
    const lib = service();
    expect(lib.listTableNames().sort()).toEqual(['keep', 'old_name']);
    lib.saveTable({ name: 'new_name', columns: [{ name: 'id', dataType: 'INT' }] } as never);
    expect(indexOf(lib).peek()).toBeUndefined();
    expect(lib.findTableFile('new_name')).not.toBeNull();
    lib.deleteTable('old_name');
    expect(indexOf(lib).peek()).toBeUndefined();
    expect(lib.listTableNames().sort()).toEqual(['keep', 'new_name']);
  });

  it('saving an existing table leaves the index as it is', () => {
    write('logical-models/keep.yml', yamlTable('keep'));
    ageLibrary();
    const lib = service();
    const table = lib.getTable('keep')!;
    const builds = lib.indexBuilds;
    lib.saveTable(table);
    expect(indexOf(lib).peek()).toBeDefined();
    expect(lib.indexBuilds).toBe(builds);
  });
});

describe('peekTableFileError', () => {
  it('is undefined for a file not read in its current version, and the error once it is', () => {
    write('gold/tables/gold/broken.dbml', 'Table gold.broken {\n  id INT [pk\n');
    write('logical-models/bad.yml', 'name: bad\ncolumns: [\n');
    write('logical-models/good.yml', yamlTable('good'));
    const lib = service();
    expect(lib.peekTableFileError('broken')).toBeUndefined();
    expect(lib.peekTableFileError('bad')).toBeUndefined();
    expect(lib.peekTableFileError('good')).toBeUndefined();
    expect(lib.peekTableFileError('missing')).toBeNull();
    expect(lib.getTableFileError('broken')?.kind).toMatch(/^dbml/);
    expect(lib.getTableFileError('bad')).not.toBeNull();
    lib.getTable('good');
    expect(lib.peekTableFileError('broken')?.kind).toMatch(/^dbml/);
    expect(lib.peekTableFileError('bad')).not.toBeNull();
    expect(lib.peekTableFileError('good')).toBeNull();
  });
});

describe('peekTableSummary', () => {
  it('answers alias and meta from a file read in its current version only, with no copy and no read', () => {
    write('gold/tables/gold/orders.dbml', 'Table gold.orders [alias: "fct_orders"] {\n  id INT [pk]\n}\n');
    write('logical-models/dim_account.yml', 'name: dim_account\nalias: accounts\nmeta:\n  owner: accounts-team\ncolumns:\n  - name: id\n    data_type: INT\n');
    write('gold/tables/gold/broken.dbml', 'Table gold.broken {\n  id INT [pk\n');
    const lib = service();
    expect(lib.peekTableSummary('orders')).toBeUndefined();
    expect(lib.peekTableSummary('dim_account')).toBeUndefined();
    expect(lib.peekTableSummary('missing')).toBeUndefined();
    lib.getTableFileError('orders');
    lib.getTableFileError('dim_account');
    lib.getTableFileError('broken');
    expect(lib.peekTableSummary('orders')).toEqual({ alias: 'fct_orders' });
    const yaml = lib.peekTableSummary('dim_account');
    expect(yaml).toEqual({ alias: 'accounts', meta: { owner: 'accounts-team' } });
    // A file that does not read has no summary.
    expect(lib.peekTableSummary('broken')).toBeUndefined();
    // A newer version of the file is not answered from the old reading.
    write('logical-models/dim_account.yml', 'name: dim_account\nalias: accounts_v2\ncolumns:\n  - name: id\n    data_type: INT\n    description: changed so the size differs\n');
    expect(lib.peekTableSummary('dim_account')).toBeUndefined();
  });
});

describe('peekTableSummary: an owner field however it is spelt (context fields)', () => {
  it('a bare owner: setting reaches meta.owner, as meta_owner and meta_json do, and the sidebar names it', async () => {
    const { tableOwnerOf } = await import('../../src/providers/ModelLibraryTreeProvider');
    write('gold/tables/gold/bare.dbml', "Table gold.bare [owner: 'crm-team'] {\n  id INT [pk]\n}\n");
    write('gold/tables/gold/old.dbml', "Table gold.old [meta_owner: 'sales-data'] {\n  id INT [pk]\n}\n");
    write('gold/tables/gold/json.dbml', "Table gold.json [meta_json: '{\"owner\":\"finance\"}'] {\n  id INT [pk]\n}\n");
    const lib = service();
    for (const name of ['bare', 'old', 'json']) lib.getTableFileError(name);
    expect(lib.peekTableSummary('bare')).toEqual({ meta: { owner: 'crm-team' } });
    expect(tableOwnerOf(lib.peekTableSummary('bare'))).toBe('crm-team');
    expect(tableOwnerOf(lib.peekTableSummary('old'))).toBe('sales-data');
    expect(tableOwnerOf(lib.peekTableSummary('json'))).toBe('finance');
  });
});

describe('what one listing costs (readdir calls, counted)', () => {
  const cjsFs = createRequire(__filename)('fs') as typeof fs;

  /** The `readdir` calls `fn` makes. */
  function readdirsOf(fn: () => void): number {
    const real = cjsFs.readdirSync;
    let count = 0;
    (cjsFs as { readdirSync: unknown }).readdirSync = function (this: unknown, ...args: unknown[]) {
      count++;
      return (real as (...a: unknown[]) => unknown).apply(this, args);
    };
    // The services use the ESM namespace of `fs`, whose bindings follow the CommonJS module once synced.
    syncBuiltinESMExports();
    try {
      fn();
    } finally {
      (cjsFs as { readdirSync: unknown }).readdirSync = real;
      syncBuiltinESMExports();
    }
    return count;
  }

  it('a YAML project adds no readdir for its layer folders: the semantic dir, logical-models/ and its folders, whatever the layers', () => {
    write('layers.json', JSON.stringify({ layers: [{ id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }] }));
    write('logical-models/silver/a.yml', yamlTable('a'));
    write('logical-models/gold/b.yml', yamlTable('b'));
    write('silver/sales.json', '{}');
    write('gold/finance.json', '{}');
    // YAML layers called `diagrams` and `relationships` stay plain YAML layers.
    write('diagrams/overview.json', '{}');
    write('relationships/links.json', '{}');
    const small = readdirsOf(() => service().listTableFiles());
    expect(small).toBe(1 + 1 + 2);
    for (let i = 0; i < 6; i++) write(`layer_${i}/d${i}.json`, '{}');
    expect(readdirsOf(() => service().listTableFiles())).toBe(small);
    expect(service().listTableNames().sort()).toEqual(['a', 'b']);
    expect(service().listRelationshipsFiles()).toEqual([]);
  });

  it('a DBML project lists 1 + layers × (2 + schemas) directories', () => {
    const LAYERS = ['bronze', 'silver', 'gold'];
    const SCHEMAS = 4;
    for (const layer of LAYERS) {
      for (let s = 0; s < SCHEMAS; s++) {
        for (let t = 0; t < 3; t++) write(`${layer}/tables/s${s}/${layer}_s${s}_t${t}.dbml`, dbmlTable(`${layer}_s${s}_t${t}`, undefined, `s${s}`));
      }
      write(`${layer}/relationships/${layer}.dbml`, HEADER);
      write(`${layer}/diagrams/${layer}.dbml`, 'Project p {\n}\n');
    }
    write('layers.json', JSON.stringify({ layers: LAYERS.map((id) => ({ id, label: id })) }));
    const lib = service();
    expect(readdirsOf(() => lib.listTableFiles())).toBe(1 + LAYERS.length * (2 + SCHEMAS));
    expect(lib.listTableFiles()).toHaveLength(LAYERS.length * SCHEMAS * 3);
    expect(lib.listRelationshipsFiles()).toHaveLength(LAYERS.length);
    // Unchanged: no listing at all on the next lookups.
    ageLibrary();
    lib.invalidateIndex();
    lib.listTableFiles();
    expect(readdirsOf(() => { for (let i = 0; i < 20; i++) lib.findTableFile('gold_s1_t2'); })).toBe(0);
  });
});

describe('core\'s dbmlTableFinder answers what the index answers (the Confluence app\'s findDbmlTable)', () => {
  it('in a DBML project, for every name and spelling, over layers, schema folders and case variants', () => {
    write('gold/tables/finance/fct_order.dbml', dbmlTable('fct_order', undefined, 'finance'));
    write('gold/tables/sales/Fct_Order.dbml', dbmlTable('Fct_Order', undefined, 'sales'));
    write('silver/tables/crm/fct_order.dbml', dbmlTable('fct_order', undefined, 'crm'));
    write('silver/tables/crm/Dim_Date.dbml', dbmlTable('Dim_Date', undefined, 'crm'));
    write('bronze/tables/raw/dim_date.dbml', dbmlTable('dim_date', undefined, 'raw'));
    write('Platinum/tables/x/dim_odd.dbml', dbmlTable('dim_odd', undefined, 'x'));
    write('silver/tables/zeta/dim_odd.dbml', dbmlTable('dim_odd', undefined, 'zeta'));
    write('gold/relationships/gold.dbml', HEADER);
    write('gold/diagrams/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n");
    ageLibrary();
    const listed: string[] = [];
    const walk = (dir: string): void => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else listed.push(relOf(p));
      }
    };
    walk(semantic);
    const find = dbmlTableFinder(listed);
    const lib = service();
    for (const name of ['fct_order', 'Fct_Order', 'FCT_ORDER', ' fct_order', 'dim_date', 'Dim_Date', 'dim_odd', 'missing']) {
      const byIndex = lib.findTableFile(name);
      expect([name, find(name)]).toEqual([name, byIndex === null ? null : relOf(byIndex)]);
    }
  });
});
