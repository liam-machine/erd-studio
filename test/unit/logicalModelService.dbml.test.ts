/**
 * TableLibraryService reading native DBML storage (§5.1 and §3.3 of
 * docs/plans/native-dbml-storage.md): `.dbml` tables listed beside `.yml`
 * ones, looked up from the directory listing in core's candidate order, read
 * through one private reader with their relationships attached from every
 * relationships file, cached, and written outside the editor through the
 * DBML library planner (S5).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { classifySemanticFile, tableFileCandidates } from '@erd-studio/core';
import {
  DbmlTableWriteRefused,
  TableLibraryService,
  hasTablesLibrary,
  tablesDirIsLayer,
  tablesLayerConflict,
} from '../../src/services/logicalModelService';

let root: string;
let semantic: string;

/** Write `text` at `rel` under the semantic dir, making its folders. */
function write(rel: string, text: string): string {
  const file = path.join(semantic, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function dbmlTable(name: string, columns = '  id INT [pk]', settings = ''): string {
  return `Table ${name}${settings ? ` [${settings}]` : ''} {\n${columns}\n}\n`;
}

function yamlTable(name: string): string {
  return `name: ${name}\ncolumns:\n  - name: id\n    dataType: INT\n`;
}

const HEADER = '// ERD Studio relationships.\n';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-lib-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(semantic, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const service = (): TableLibraryService => new TableLibraryService(root, '.erd-studio');

/** A file's path relative to the semantic dir, `/`-separated. */
const rel = (filePath: string | null): string | null => filePath === null ? null : path.relative(semantic, filePath).split(path.sep).join('/');

describe('listing and shadowing', () => {
  it('lists .dbml tables in tables/ with their storage, and skips relationships files', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('tables/gold/_relationships.dbml', HEADER);
    write('tables/_relationships.dbml', HEADER);
    const entries = service().listTableFiles();
    expect(entries.map((e) => [e.name, e.folder, e.storage, e.library])).toEqual([
      ['dim_date', '', 'dbml', 'tables'],
      ['fct_order', 'gold', 'dbml', 'tables'],
    ]);
  });

  it('a .dbml wins over a .yml of the same name in one directory; the .yml is shadowed by it', () => {
    const dbml = write('tables/gold/dim_customer.dbml', dbmlTable('dim_customer'));
    const yml = write('tables/gold/dim_customer.yml', yamlTable('dim_customer'));
    const entries = service().listTableFiles();
    expect(entries).toEqual([
      expect.objectContaining({ name: 'dim_customer', filePath: dbml, storage: 'dbml' }),
      expect.objectContaining({ name: 'dim_customer', filePath: yml, storage: 'yaml', shadowedBy: dbml }),
    ]);
    expect(entries[0].shadowedBy).toBeUndefined();
    expect(service().findTableFile('dim_customer')).toBe(dbml);
  });

  it('logical-models/ wins over a tables/ .dbml of the same name in any case', () => {
    const v5 = write('logical-models/dim_date.yml', yamlTable('dim_date'));
    const dbml = write('tables/Dim_Date.dbml', dbmlTable('Dim_Date'));
    const entries = service().listTableFiles();
    expect(entries.find((e) => e.filePath === dbml)).toMatchObject({ shadowedBy: v5, storage: 'dbml' });
    expect(service().findTableFile('dim_date')).toBe(v5);
  });

  it('reads any non-dot library folder (Finance, SAP FI), not only layer-shaped ones', () => {
    write('tables/Finance/gl_account.dbml', dbmlTable('gl_account'));
    write('tables/SAP FI/bkpf.dbml', dbmlTable('bkpf'));
    write('tables/.hidden/secret.dbml', dbmlTable('secret'));
    const lib = service();
    expect(lib.listTableFiles().map((e) => [e.name, e.folder])).toEqual([['gl_account', 'Finance'], ['bkpf', 'SAP FI']]);
    expect(lib.getTable('bkpf')?.name).toBe('bkpf');
    expect(lib.tableFolder('bkpf')).toBe('SAP FI');
  });

  it('keeps an existing YAML _relationships.yml as an ordinary table', () => {
    write('tables/_relationships.yml', yamlTable('_relationships'));
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    const lib = service();
    expect(lib.listTableFiles().map((e) => [e.name, e.storage])).toEqual([['_relationships', 'yaml'], ['dim_date', 'dbml']]);
    expect(lib.getTable('_relationships')?.name).toBe('_relationships');
    // The relationships FILE is never a table, whatever the lookup.
    expect(rel(lib.findTableFile('_relationships'))).toBe('tables/_relationships.yml');
  });
});

describe('the listing, the lookup and the relationships files agree with classifySemanticFile (D10, §3.5)', () => {
  it('every listed entry, found file and relationships file is what the single classifier says it is', () => {
    const files = [
      'logical-models/dim_old.yml', 'logical-models/stray.dbml', 'logical-models/gold/fct_old.yml',
      'tables/dim_date.dbml', 'tables/_relationships.dbml', 'tables/silver/_RELATIONSHIPS.dbml', 'tables/notes.txt',
      'tables/gold/fct_order.dbml', 'tables/gold/_relationships.dbml', 'tables/gold/dim_yaml.yml',
      'tables/.hidden.dbml',
    ];
    for (const f of files) write(f, f.endsWith('.yml') ? yamlTable(path.basename(f, '.yml')) : f.endsWith('.dbml') ? dbmlTable(path.basename(f, '.dbml')) : 'x\n');
    const lib = service();
    const classify = (f: string) => classifySemanticFile(f, { tablesDirIsLayer: false });
    const expected = files.filter((f) => classify(f).kind === 'table');
    expect(lib.listTableFiles().map((e) => rel(e.filePath)).sort()).toEqual([...expected].sort());
    for (const e of lib.listTableFiles()) {
      const c = classify(rel(e.filePath)!);
      expect([e.name, e.storage]).toEqual([c.name, c.storage]);
    }
    // A name only a non-table file has is not found: logical-models/stray.dbml is not a table, nor is a relationships file.
    expect(lib.findTableFile('stray')).toBeNull();
    expect(lib.findTableFile('_relationships')).toBeNull();
    expect(rel(lib.findTableFile('fct_order'))).toBe('tables/gold/fct_order.dbml');
    expect(lib.listRelationshipsFiles().map(rel)).toEqual(
      ['tables/_relationships.dbml', 'tables/gold/_relationships.dbml', 'tables/silver/_RELATIONSHIPS.dbml'].filter((f) => classify(f).kind === 'relationships'),
    );
  });
});

describe('findTableFile follows core\'s tableFileCandidates order (§3.4)', () => {
  // Each row: the files on disk, the name looked up, and the file both hosts resolve it to.
  const CASES: Array<{ title: string; files: string[]; name: string }> = [
    { title: 'top-level dbml', files: ['tables/x.dbml'], name: 'x' },
    { title: 'dbml before yml in one dir', files: ['tables/x.yml', 'tables/x.dbml'], name: 'x' },
    { title: 'top level before folders', files: ['tables/gold/x.dbml', 'tables/x.yml'], name: 'x' },
    { title: 'folders alphabetically', files: ['tables/silver/x.dbml', 'tables/gold/x.dbml'], name: 'x' },
    { title: 'logical-models before tables', files: ['tables/x.dbml', 'logical-models/x.yml'], name: 'x' },
    { title: 'logical-models folder before tables top level', files: ['tables/x.dbml', 'logical-models/gold/x.yml'], name: 'x' },
    { title: 'a gold folder yml after the tables top-level yml', files: ['tables/gold/x.yml', 'tables/x.yml'], name: 'x' },
  ];

  it.each(CASES)('$title', ({ files, name }) => {
    for (const file of files) {
      write(file, file.endsWith('.dbml') ? dbmlTable(name) : yamlTable(name));
    }
    const folders = [...new Set(files.map((f) => f.split('/')).filter((s) => s.length === 3).map((s) => s[1]))];
    const expected = tableFileCandidates('', name, folders, { dbml: true }).find((c) => files.includes(c));
    expect(rel(service().findTableFile(name))).toBe(expected);
  });
});

describe('symbolic links', () => {
  it('finds and reads a table file that is a symlink, at the top level and in a folder (as existsSync did before §3.4)', () => {
    const real = path.join(root, 'shared');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'dim_x.yml'), yamlTable('dim_x'));
    fs.writeFileSync(path.join(real, 'dim_y.dbml'), dbmlTable('dim_y'));
    fs.mkdirSync(path.join(semantic, 'logical-models/gold'), { recursive: true });
    fs.symlinkSync(path.join(real, 'dim_x.yml'), path.join(semantic, 'logical-models/gold/dim_x.yml'));
    fs.mkdirSync(path.join(semantic, 'tables'), { recursive: true });
    write('tables/dim_z.dbml', dbmlTable('dim_z'));
    fs.symlinkSync(path.join(real, 'dim_y.dbml'), path.join(semantic, 'tables/dim_y.dbml'));
    // A link to nothing is not a table file.
    fs.symlinkSync(path.join(real, 'gone.yml'), path.join(semantic, 'logical-models/gold/gone.yml'));
    const lib = service();
    expect(rel(lib.findTableFile('dim_x'))).toBe('logical-models/gold/dim_x.yml');
    expect(lib.getTable('dim_x')?.name).toBe('dim_x');
    expect(lib.tableExists('dim_x')).toBe(true);
    expect(rel(lib.findTableFile('DIM_Y'))).toBe('tables/dim_y.dbml');
    expect(lib.getTable('dim_y')?.name).toBe('dim_y');
    expect(lib.findTableFile('gone')).toBeNull();
  });
});

describe('case (D2)', () => {
  it('a wrong-case lookup returns the listed file name, never the spelling looked up', () => {
    const file = write('tables/gold/Dim_X.dbml', dbmlTable('Dim_X'));
    const lib = service();
    expect(lib.findTableFile('dim_x')).toBe(file);
    expect(path.basename(lib.findTableFile('DIM_X')!)).toBe('Dim_X.dbml');
    // The listed stem goes to the reader, so the file reads (no false name mismatch) under its declared name.
    expect(lib.getTable('dim_x')?.name).toBe('Dim_X');
    expect(lib.getTableFileError('dim_x')).toBeNull();
  });

  it('an exact spelling is preferred over another case in the same directory', () => {
    write('logical-models/dim_y.yml', yamlTable('dim_y'));
    expect(path.basename(service().findTableFile('dim_y')!)).toBe('dim_y.yml');
  });

  it('a file whose stem and declared name differ only in case loads under the declared spelling', () => {
    write('tables/dim_drift.dbml', dbmlTable('Dim_Drift'));
    const table = service().getTable('dim_drift');
    expect(table?.name).toBe('Dim_Drift');
  });
});

describe('relationships (§2.4)', () => {
  beforeEach(() => {
    write('tables/dim_date.dbml', dbmlTable('dim_date', '  date_key INT [pk]\n  previous_date_key INT'));
    write('tables/gold/dim_customer.dbml', dbmlTable('dim_customer', '  customer_key INT [pk]'));
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order', '  order_id INT [pk]\n  customer_key INT\n  order_date_key INT\n  Ship_Date_Key INT'));
    write('tables/gold/_relationships.dbml', [
      HEADER,
      "use { table dim_date } from '../dim_date.dbml'",
      "use { table dim_customer } from './dim_customer.dbml'",
      "use { table fct_order } from './fct_order.dbml'",
      '',
      'Ref: fct_order.customer_key >? dim_customer.customer_key',
      'Ref "order date": fct_order.order_date_key >? dim_date.date_key',
      'Ref "ship date": FCT_ORDER.ship_date_key >? dim_date.date_key',
      '',
    ].join('\n'));
    // Misplaced: dim_date (top level) owns this Ref, but it sits in gold's file.
    write('tables/_relationships.dbml', `${HEADER}use { table dim_date } from './dim_date.dbml'\n\nRef "previous day": dim_date.previous_date_key > dim_date.date_key\n`);
  });

  it('listTables() returns DBML tables WITH their relationships, respelled, misplaced Refs attached', () => {
    // Move the self-reference into gold's file: misplaced, still attached and drawn.
    const goldFile = path.join(semantic, 'tables/gold/_relationships.dbml');
    fs.writeFileSync(path.join(semantic, 'tables/_relationships.dbml'), HEADER);
    fs.appendFileSync(goldFile, 'Ref "previous day": dim_date.previous_date_key > dim_date.date_key\n');
    const lib = service();
    const tables = new Map(lib.listTables().map((t) => [t.name, t]));
    expect(tables.get('fct_order')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
      { fromColumn: 'order_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'order date' },
      { fromColumn: 'Ship_Date_Key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
    ]);
    expect(tables.get('dim_date')?.relationships).toEqual([
      { fromColumn: 'previous_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'previous day' },
    ]);
    expect(tables.get('dim_customer')?.relationships).toBeUndefined();
    expect(lib.libraryAttachment()?.misplaced).toEqual([
      expect.objectContaining({ owner: 'dim_date', home: '', path: 'tables/gold/_relationships.dbml' }),
    ]);
    // getTable agrees with listTables.
    expect(lib.getTable('dim_date')?.relationships).toEqual(tables.get('dim_date')?.relationships);
  });

  it('a relationships-file change is seen without a table re-read; a table change re-reads that table only', () => {
    const lib = service();
    expect(lib.getTable('dim_date')?.relationships).toHaveLength(1);
    const relFile = path.join(semantic, 'tables/_relationships.dbml');
    fs.writeFileSync(relFile, `${HEADER}use { table dim_date } from './dim_date.dbml'\n`);
    bumpMtime(relFile);
    expect(lib.getTable('dim_date')?.relationships).toBeUndefined();
    // And invalidateRelationships() drops the cached readings outright.
    fs.writeFileSync(relFile, `${HEADER}use { table dim_date } from './dim_date.dbml'\n\nRef: dim_date.previous_date_key > dim_date.date_key\n`);
    lib.invalidateRelationships();
    expect(lib.getTable('dim_date')?.relationships).toHaveLength(1);

    const tableFile = path.join(semantic, 'tables/gold/dim_customer.dbml');
    fs.writeFileSync(tableFile, dbmlTable('dim_customer', '  customer_key INT [pk]\n  segment VARCHAR'));
    bumpMtime(tableFile);
    expect(lib.getTable('dim_customer')?.columns.map((c) => c.name)).toEqual(['customer_key', 'segment']);
    // fct_order's Refs are unchanged by a table edit elsewhere.
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    lib.invalidateCache();
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
  });

  it('listTables() attaches once per call, and a warm getTable() lists nothing (no per-table library pass)', () => {
    for (let i = 0; i < 30; i++) write(`tables/gold/t${i}.dbml`, dbmlTable(`t${i}`, '  id INT [pk]\n  customer_key INT'));
    const lib = service();
    lib.listTables();
    const listing = vi.spyOn(lib, 'listTableFiles');
    const tables = lib.listTables();
    expect(tables.find((t) => t.name === 'fct_order')?.relationships).toHaveLength(3);
    // Once for the tables listed, at most once for the attachment's key: never once per table.
    expect(listing.mock.calls.length).toBeLessThanOrEqual(2);
    listing.mockClear();
    for (let i = 0; i < 30; i++) lib.getTable(`t${i}`);
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    expect(listing).not.toHaveBeenCalled();
  });

  it('the memoised attachment sees a new table file, a new relationships file and a changed table', () => {
    const lib = service();
    expect(lib.getTable('dim_customer')?.relationships).toBeUndefined();
    // A new table owning a Ref that was an orphan: the directory changed, so the memo is rebuilt.
    fs.appendFileSync(path.join(semantic, 'tables/gold/_relationships.dbml'), 'Ref: dim_region.customer_key >? dim_customer.customer_key\n');
    bumpMtime(path.join(semantic, 'tables/gold/_relationships.dbml'));
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    write('tables/gold/dim_region.dbml', dbmlTable('dim_region', '  region_key INT [pk]\n  customer_key INT'));
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    expect(lib.listTables().find((t) => t.name === 'dim_region')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    // A relationships file in a new folder.
    write('tables/silver/stg_x.dbml', dbmlTable('stg_x', '  id INT [pk]\n  customer_key INT'));
    expect(lib.getTable('stg_x')?.relationships).toBeUndefined();
    write('tables/silver/_relationships.dbml', `${HEADER}Ref: stg_x.customer_key >? dim_customer.customer_key\n`);
    expect(lib.getTable('stg_x')?.relationships).toHaveLength(1);
    // A table edited in place, then read: its new column is what the attachment resolves against.
    const fct = path.join(semantic, 'tables/gold/fct_order.dbml');
    fs.writeFileSync(fct, dbmlTable('fct_order', '  order_id INT [pk]\n  CUSTOMER_KEY INT\n  order_date_key INT\n  Ship_Date_Key INT'));
    bumpMtime(fct);
    expect(lib.getTable('fct_order')?.relationships?.[0]).toMatchObject({ fromColumn: 'CUSTOMER_KEY' });
  });

  it('an unreadable relationships file counts as unreadable relationships', () => {
    const lib = service();
    expect(lib.hasUnreadableRelationships()).toBe(false);
    const relFile = path.join(semantic, 'tables/gold/_relationships.dbml');
    fs.writeFileSync(relFile, 'Ref: fct_order.customer_key >? dim_customer.(\n');
    bumpMtime(relFile);
    expect(lib.hasUnreadableRelationships()).toBe(true);
  });
});

describe('DBML TableFileErrors', () => {
  it.each([
    ['a syntax error', 'Table broken {\n  id INT [pk\n}\n', 'dbmlSyntax'],
    ['an unquoted word', "Table broken [grain: one row] {\n  id INT\n}\n", 'dbmlInvalid'],
    ['two Tables', 'Table broken {\n  id INT\n}\nTable other {\n  id INT\n}\n', 'dbmlStructure'],
    ['a name that is not the file\'s', 'Table other_name {\n  id INT\n}\n', 'dbmlStructure'],
  ])('%s is a %s error with its code and line', (_title, text, kind) => {
    const file = write('tables/broken.dbml', text);
    const lib = service();
    expect(lib.getTable('broken')).toBeNull();
    const error = lib.getTableFileError('broken');
    expect(error).toMatchObject({ name: 'broken', filePath: file, kind });
    expect(error?.code).toBeDefined();
    expect(error?.line).toBeGreaterThan(0);
  });

  it('git conflict markers are a dbmlSyntax error with mergeConflict', () => {
    write('tables/broken.dbml', 'Table broken {\n<<<<<<< HEAD\n  id INT\n=======\n  id BIGINT\n>>>>>>> other\n}\n');
    expect(service().getTableFileError('broken')).toMatchObject({ kind: 'dbmlSyntax', mergeConflict: true, line: 2 });
  });

  it('an empty file cannot be read', () => {
    write('tables/broken.dbml', '');
    expect(service().getTableFileError('broken')).toMatchObject({ kind: 'read' });
  });

  it('a readable table with an inline ref still loads (its problem is a warning)', () => {
    write('tables/dim_x.dbml', dbmlTable('dim_x'));
    write('tables/fct_y.dbml', 'Table fct_y {\n  id INT [pk]\n  x_id INT [ref: > dim_x.id]\n}\n');
    const table = service().getTable('fct_y');
    expect(table?.columns.map((c) => c.name)).toEqual(['id', 'x_id']);
    expect(table?.relationships).toBeUndefined();
  });
});

describe('DBML table writes outside the editor (S5: planDbmlLibraryWrites + writeFilesWithRollback)', () => {
  // Moved from the YAML/JSON guard (tableNaming.host.test.ts, the design's one guard exception), rewritten
  // for the 2.0 tree's saveTable default (§2.4): no layers.json and no DBML layer folder → main/tables/main/.
  it('a project with no library folder at all writes its first table as DBML, to main/tables/main/ (§2.4)', () => {
    fs.rmSync(semantic, { recursive: true });
    service().saveTable({ name: 'dim_first', columns: [], modelRole: 'reference' });
    expect(fs.readFileSync(path.join(semantic, 'main', 'tables', 'main', 'dim_first.dbml'), 'utf-8')).toMatch(/^Table main\.dim_first \[role: 'reference'\]/m);
    expect(fs.existsSync(path.join(semantic, 'main', 'tables', 'main', 'dim_first.yml'))).toBe(false);
    expect(fs.existsSync(path.join(semantic, 'tables'))).toBe(false);
    expect(fs.existsSync(path.join(semantic, 'logical-models'))).toBe(false);
  });

  it('serializeTable never renders a .dbml table as YAML; saveTable splices it in place', () => {
    const file = write('tables/dim_date.dbml', '// keep me\n' + dbmlTable('dim_date', '  id INT [pk]\n  label VARCHAR'));
    const lib = service();
    const table = lib.getTable('dim_date')!;
    expect(() => lib.serializeTable(table)).toThrow(DbmlTableWriteRefused);
    table.columns[1].description = 'Shown name';
    lib.saveTable(table);
    // Spliced, then aligned (every DBML write is in the canonical layout).
    expect(fs.readFileSync(file, 'utf-8')).toBe("// keep me\nTable dim_date {\n  id    INT     [pk]\n  label VARCHAR [note: 'Shown name']\n}\n");
    expect(fs.readdirSync(path.dirname(file))).toEqual(['dim_date.dbml']);
  });

  it('renameTable renames the file, splices the name and re-spells every Ref naming it', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/fct_x.dbml', dbmlTable('fct_x', '  id INT [pk]\n  date_id INT'));
    write('tables/_relationships.dbml', `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_x } from './fct_x.dbml'\n\nRef: fct_x.date_id >? dim_date.id\n`);
    const lib = service();
    lib.renameTable('dim_date', 'dim_day');
    expect(fs.existsSync(path.join(semantic, 'tables/dim_date.dbml'))).toBe(false);
    expect(fs.readFileSync(path.join(semantic, 'tables/dim_day.dbml'), 'utf-8')).toBe(dbmlTable('dim_day'));
    expect(fs.readFileSync(path.join(semantic, 'tables/_relationships.dbml'), 'utf-8'))
      .toBe(`${HEADER}use { table dim_day } from './dim_day.dbml'\nuse { table fct_x }   from './fct_x.dbml'\n\nRef: fct_x.date_id >? dim_day.id\n`);
    expect(lib.getTable('fct_x')?.relationships?.[0]).toMatchObject({ toModel: 'dim_day', toColumn: 'id' });
  });

  it('deleteTable runs the D16 cascade: the file, its Refs and other owners\' Refs to it, and their use lines', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/fct_x.dbml', dbmlTable('fct_x', '  id INT [pk]\n  date_id INT'));
    write('tables/_relationships.dbml', `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_x } from './fct_x.dbml'\n\nRef: fct_x.date_id >? dim_date.id\n`);
    const lib = service();
    lib.deleteTable('dim_date');
    expect(fs.existsSync(path.join(semantic, 'tables/dim_date.dbml'))).toBe(false);
    // The relationships file keeps its header and is never deleted (D15).
    expect(fs.readFileSync(path.join(semantic, 'tables/_relationships.dbml'), 'utf-8')).toBe(HEADER);
    expect(lib.getTable('fct_x')?.relationships).toBeUndefined();
  });

  it('deleteTable in a mixed project: a YAML table\'s relationship to it stays in its yml; DBML owners lose theirs', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/fct_x.dbml', dbmlTable('fct_x', '  id INT [pk]\n  date_id INT'));
    write('tables/_relationships.dbml', `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_x } from './fct_x.dbml'\n\nRef: fct_x.date_id >? dim_date.id\n`);
    const yml = write('tables/fct_y.yml', 'name: fct_y\ncolumns:\n  - name: date_id\n    dataType: INT\nrelationships:\n  - fromColumn: date_id\n    toModel: dim_date\n    toColumn: id\n');
    const ymlText = fs.readFileSync(yml, 'utf-8');
    const lib = service();
    lib.deleteTable('dim_date');
    expect(fs.existsSync(path.join(semantic, 'tables/dim_date.dbml'))).toBe(false);
    expect(fs.readFileSync(yml, 'utf-8')).toBe(ymlText);
    expect(fs.readFileSync(path.join(semantic, 'tables/_relationships.dbml'), 'utf-8')).toBe(HEADER);
  });

  it('renameTable refuses the reserved name `_relationships` (§2.1), and writes nothing', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    const lib = service();
    expect(() => lib.renameTable('dim_date', '_relationships')).toThrow('‘_relationships’ is the name of the relationships file');
    expect(fs.readdirSync(path.join(semantic, 'tables'))).toEqual(['dim_date.dbml']);
    expect(lib.listTables().map((t) => t.name)).toEqual(['dim_date']);
  });

  it('a folder\'s relationships file named in another case is its file: relationshipsFileFor and new tables follow the disk', () => {
    write('tables/Gold/fct_order.dbml', dbmlTable('fct_order'));
    write('tables/Gold/_Relationships.dbml', `${HEADER}\n`);
    const lib = service();
    expect(rel(lib.relationshipsFileFor('fct_order') ?? null)).toBe('tables/Gold/_Relationships.dbml');
    const { writes } = lib.planTableWrites({ save: [{ model: { name: 'dim_new', columns: [{ name: 'id', dataType: 'INT', description: '' }] } }] }, 'gold', { dbml: true });
    expect(writes.map((w) => `${w.kind} ${rel(w.path)}`)).toEqual(['create tables/Gold/dim_new.dbml']);
  });

  it('pathForNewTable names a .dbml in tables/ once the project writes DBML (the S6 switch-over), else today\'s rule', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    expect(rel(service().pathForNewTable('dim_new'))).toBe('tables/dim_new.dbml');
    expect(rel(service().pathForNewTable('dim_new', 'gold'))).toBe('tables/gold/dim_new.dbml');
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    // Mixed: still DBML for a new file.
    expect(rel(service().pathForNewTable('dim_new'))).toBe('tables/dim_new.dbml');
  });

  it('pathForNewTable keeps today\'s rule (a .yml path) in a YAML project', () => {
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    expect(rel(service().pathForNewTable('dim_new'))).toBe('logical-models/dim_new.yml');
  });

  it('tableStorage and relationshipsFileFor name a DBML table\'s format and its folder\'s relationships file', () => {
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    const lib = service();
    expect(lib.tableStorage('fct_order')).toBe('dbml');
    expect(lib.tableStorage('dim_old')).toBe('yaml');
    expect(lib.tableStorage('nothing')).toBeUndefined();
    expect(rel(lib.relationshipsFileFor('fct_order') ?? null)).toBe('tables/gold/_relationships.dbml');
    expect(lib.relationshipsFileFor('dim_old')).toBeUndefined();
  });
});

describe('tables/: library or layer (§3.3)', () => {
  const LISTED = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 1 }] });

  it.each([
    // DBML evidence, json, listed → tables/ is a layer?, library?, conflict?
    { dbml: false, json: false, listed: false, layer: false, conflict: false },
    { dbml: false, json: true, listed: false, layer: true, conflict: false },
    { dbml: false, json: false, listed: true, layer: true, conflict: false },
    { dbml: false, json: true, listed: true, layer: true, conflict: false },
    { dbml: true, json: false, listed: false, layer: false, conflict: false },
    { dbml: true, json: false, listed: true, layer: false, conflict: /layers\.json lists `tables`, but tables\/ is the DBML table library/ },
    { dbml: true, json: true, listed: false, layer: false, conflict: /tables\/sales\.json/ },
    { dbml: true, json: true, listed: true, layer: true, conflict: /tables\/dim_x\.dbml/ },
  ])('dbml $dbml, json $json, listed $listed → layer $layer', ({ dbml, json, listed, layer, conflict }) => {
    fs.mkdirSync(path.join(semantic, 'tables'), { recursive: true });
    if (dbml) write('tables/dim_x.dbml', dbmlTable('dim_x'));
    else write('tables/dim_x.yml', yamlTable('dim_x'));
    if (json) write('tables/sales.json', '{}');
    if (listed) write('layers.json', LISTED);
    expect(tablesDirIsLayer(semantic)).toBe(layer);
    expect(hasTablesLibrary(semantic)).toBe(!layer);
    const text = tablesLayerConflict(semantic);
    if (conflict === false) expect(text).toBeUndefined();
    else expect(text).toMatch(conflict);
  });

  it('a relationships file alone makes tables/ the library', () => {
    write('tables/gold/_relationships.dbml', HEADER);
    expect(hasTablesLibrary(semantic)).toBe(true);
    expect(tablesDirIsLayer(semantic)).toBe(false);
  });

  it('a DBML library is found only in tables/, never listed from a tables layer', () => {
    write('tables/dim_x.dbml', dbmlTable('dim_x'));
    write('tables/sales.json', '{}');
    write('layers.json', LISTED);
    expect(service().listTableFiles()).toEqual([]);
    expect(service().findTableFile('dim_x')).toBeNull();
  });
});

/** Move a file's mtime forward a second, so a cache keyed on mtime + size sees a same-size rewrite. */
function bumpMtime(file: string): void {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
}
