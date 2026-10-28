/**
 * The table library's name → file index (`src/services/tableLibraryIndex.ts`):
 * every answer TableLibraryService gives from it — the file a name resolves
 * to, the table listing with duplicates, the relationships files, whether
 * `tables/` is a layer — must be what the per-lookup directory reads gave
 * before the index (the reference below re-reads the disk on every call),
 * and an index must see files added, removed or renamed outside ERD Studio
 * with no invalidate call (directory signatures, and the racy-mtime rule).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LOGICAL_MODELS_DIR, TABLES_DIR, classifySemanticFile } from '@erd-studio/core';
import { TableLibraryService, hasTablesLibrary, tablesDirIsLayer } from '../../src/services/logicalModelService';
import { RACY_MS, TableLibraryIndex } from '../../src/services/tableLibraryIndex';

let root: string;
let semantic: string;

function write(rel: string, text = ''): string {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

const dbmlTable = (name: string, columns = '  id INT [pk]'): string => `Table ${name} {\n${columns}\n}\n`;
const yamlTable = (name: string): string => `name: ${name}\ncolumns:\n  - name: id\n    dataType: INT\n`;
const HEADER = '// ERD Studio relationships.\n';

/** Set every library directory's (and layers.json's) times well in the past, so an index built now is not racy. */
function ageLibrary(): void {
  const past = new Date(Date.now() - 60_000);
  const age = (p: string): void => { try { fs.utimesSync(p, past, past); } catch { /* absent */ } };
  age(path.join(semantic, 'layers.json'));
  for (const lib of [LOGICAL_MODELS_DIR, TABLES_DIR]) {
    const dir = path.join(semantic, lib);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory()) age(path.join(dir, d.name));
    age(dir);
  }
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

function referenceFind(name: string): string | null {
  const v5 = path.resolve(semantic, LOGICAL_MODELS_DIR);
  for (const folder of ['', ...foldersOf(v5)]) {
    const hit = listedFile(path.join(v5, folder), name, '.yml');
    if (hit !== null) return hit;
  }
  const v6 = path.resolve(semantic, TABLES_DIR);
  if (!fs.existsSync(v6) || tablesDirIsLayer(semantic)) return null;
  for (const folder of ['', ...foldersOf(v6)]) {
    const dir = path.join(v6, folder);
    const hit = listedFile(dir, name, '.dbml') ?? listedFile(dir, name, '.yml');
    if (hit !== null) return hit;
  }
  return null;
}

/** The library's table files as `rel[ (shadowed by rel)]`, the pre-index rules. */
function referenceListing(): string[] {
  const out: string[] = [];
  const winners = new Map<string, string>();
  const v5Winners = new Map<string, string>();
  const dbmlWinners = new Map<string, { filePath: string; dbml: boolean }>();
  let library = false;
  const add = (dir: string): void => {
    let files: Array<{ file: string; name: string; storage: string }>;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name).flatMap((file) => {
        const kind = classify(relOf(path.join(dir, file)));
        return kind.kind === 'table' && kind.name !== undefined ? [{ file, name: kind.name, storage: kind.storage! }] : [];
      }).sort((a, b) => a.name.toLowerCase() === b.name.toLowerCase() && a.storage !== b.storage ? (a.storage === 'dbml' ? -1 : 1) : compare(a.file, b.file));
    } catch {
      return;
    }
    for (const { file, name, storage } of files) {
      const filePath = path.join(dir, file);
      const lower = name.toLowerCase();
      const dbmlWinner = dbmlWinners.get(lower);
      const winner = winners.get(name) ?? (library ? v5Winners.get(lower) : undefined)
        ?? (dbmlWinner && (storage === 'dbml' || dbmlWinner.dbml) ? dbmlWinner.filePath : undefined);
      if (winner === undefined) {
        winners.set(name, filePath);
        if (!library) v5Winners.set(lower, filePath);
        else if (!dbmlWinners.has(lower)) dbmlWinners.set(lower, { filePath, dbml: storage === 'dbml' });
        out.push(relOf(filePath));
      } else {
        out.push(`${relOf(filePath)} (shadowed by ${relOf(winner)})`);
      }
    }
  };
  const v5 = path.join(semantic, LOGICAL_MODELS_DIR);
  if (fs.existsSync(v5)) {
    add(v5);
    for (const f of foldersOf(v5)) add(path.join(v5, f));
  }
  if (hasTablesLibrary(semantic)) {
    library = true;
    const v6 = path.join(semantic, TABLES_DIR);
    add(v6);
    for (const f of foldersOf(v6)) add(path.join(v6, f));
  }
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

  it('a DBML library: .dbml before .yml in one folder, relationships files never tables, a name in both libraries', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/dim_date.yml', yamlTable('dim_date'));
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('tables/silver/Fct_Order.dbml', dbmlTable('Fct_Order'));
    write('tables/_relationships.dbml', HEADER);
    write('tables/gold/_RELATIONSHIPS.dbml', HEADER);
    write('tables/gold/stray.json', '{}');
    write('logical-models/dim_customer.yml', yamlTable('dim_customer'));
    write('logical-models/fct_order.yml', yamlTable('fct_order'));
    const lib = service();
    expectSameAsReference(lib, NAMES);
    expect(lib.listRelationshipsFiles().map(relOf)).toEqual(['tables/_relationships.dbml', 'tables/gold/_RELATIONSHIPS.dbml']);
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

  it('DBML evidence keeps tables/ the library unless layers.json lists it AND it holds a .json', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/report.json', '{}');
    const lib = service();
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(false);
    // layers.json changing is seen by its own signature: no invalidate call.
    write('layers.json', JSON.stringify({ layers: [{ id: 'tables', label: 'Tables' }] }));
    expectSameAsReference(lib, NAMES);
    expect(lib.tablesDirIsLayer()).toBe(true);
    expect(lib.findTableFile('dim_date')).toBeNull();
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

describe('the index sees changes made outside ERD Studio, with no invalidate call', () => {
  it('a file added, renamed and removed in a library folder, and a new folder', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    ageLibrary();
    const lib = service();
    expect(lib.findTableFile('fct_order')).toBeNull();
    const builds = lib.indexBuilds;

    write('tables/fct_order.dbml', dbmlTable('fct_order'));
    expect(relOf(lib.findTableFile('fct_order')!)).toBe('tables/fct_order.dbml');
    expect(lib.indexBuilds).toBe(builds + 1);

    fs.renameSync(path.join(semantic, 'tables/fct_order.dbml'), path.join(semantic, 'tables/fct_sale.dbml'));
    expect(lib.findTableFile('fct_order')).toBeNull();
    expect(relOf(lib.findTableFile('fct_sale')!)).toBe('tables/fct_sale.dbml');

    fs.rmSync(path.join(semantic, 'tables/fct_sale.dbml'));
    expect(lib.findTableFile('fct_sale')).toBeNull();
    expect(lib.listTableNames()).toEqual(['dim_date']);

    write('tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('tables/gold/_relationships.dbml', HEADER);
    expect(relOf(lib.findTableFile('fct_order')!)).toBe('tables/gold/fct_order.dbml');
    expect(lib.listRelationshipsFiles().map(relOf)).toEqual(['tables/gold/_relationships.dbml']);
    expect(lib.tableFolder('fct_order')).toBe('gold');
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

  it('an unchanged library is listed once, however many lookups follow', () => {
    for (let i = 0; i < 50; i++) write(`tables/gold/t${i}.dbml`, dbmlTable(`t${i}`));
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
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    const dir = path.join(semantic, 'tables');
    const index = new TableLibraryIndex(semantic, path.join(semantic, LOGICAL_MODELS_DIR), dir);
    // The directory changed just now: the index built from it is not trusted on its signature alone.
    fs.utimesSync(dir, new Date(), new Date());
    const before = fs.statSync(dir);
    expect(index.find('dim_date')).not.toBeNull();
    expect(index.isCold()).toBe(true);
    // A file added and the directory's times put back as they were: only the racy rule can see it.
    write('tables/fct_order.dbml', dbmlTable('fct_order'));
    fs.utimesSync(dir, before.atime, before.mtime);
    expect(Date.now() - before.mtimeMs).toBeLessThan(RACY_MS * 50);
    expect(index.find('fct_order')).not.toBeNull();
  });

  it('a directory older than the racy window is trusted on its signature (the next build is the only one)', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
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
});

describe('invalidatePaths: only what was written', () => {
  const caches = (lib: TableLibraryService) => lib as unknown as {
    dbmlCache: Map<string, unknown>;
    cache: Map<string, unknown>;
    attachMemo: { result: unknown } | undefined;
  };

  beforeEach(() => {
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order', '  id INT [pk]\n  customer_key INT [note: \'first\']'));
    write('tables/gold/dim_customer.dbml', dbmlTable('dim_customer', '  customer_key INT [pk]'));
    write('tables/gold/_relationships.dbml', `${HEADER}Ref: fct_order.customer_key > dim_customer.customer_key\n`);
    write('logical-models/dim_yaml.yml', yamlTable('dim_yaml'));
  });

  it('an edit to one table drops that table\'s parse only', () => {
    const lib = service();
    lib.listTables();
    const order = path.join(semantic, 'tables/gold/fct_order.dbml');
    const customer = path.join(semantic, 'tables/gold/dim_customer.dbml');
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
    const order = path.join(semantic, 'tables/gold/fct_order.dbml');

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
    const relFile = path.join(semantic, 'tables/gold/_relationships.dbml');
    fs.appendFileSync(relFile, 'Ref: fct_order.id > dim_yaml.ID\n');
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
    const relFile = path.join(semantic, 'tables/gold/_relationships.dbml');
    fs.writeFileSync(relFile, HEADER);
    lib.invalidatePaths([relFile]);
    const second = lib.libraryAttachment();
    expect(second).not.toBe(first);
    expect(second?.byOwner.get('fct_order')).toBeUndefined();
  });

  it('a table file created or deleted in the same clock tick is seen through invalidatePaths', () => {
    const lib = service();
    expect(lib.findTableFile('dim_region')).toBeNull();
    const created = write('tables/gold/dim_region.dbml', dbmlTable('dim_region'));
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
    const customer = path.join(semantic, 'tables/gold/dim_customer.dbml');
    const reading = caches(lib).dbmlCache.get(customer);
    lib.invalidateCache('fct_order');
    expect(caches(lib).dbmlCache.get(customer)).toBe(reading);
    lib.invalidateCache();
    expect(caches(lib).dbmlCache.size).toBe(0);
    expect(lib.indexIsCold()).toBe(true);
  });
});

describe('peekTableFileError', () => {
  it('is undefined for a file not read in its current version, and the error once it is', () => {
    write('tables/broken.dbml', 'Table broken {\n  id INT [pk\n');
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
