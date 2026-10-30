/**
 * TableLibraryService reading native DBML storage in the layer-first tree
 * (`<layer>/tables/<schema>/<name>.dbml`, `<layer>/relationships/<f>.dbml`):
 * `.dbml` tables listed after the YAML libraries, looked up from the
 * directory listing, read through one private reader with their
 * relationships attached from every relationships file, cached, and written
 * outside the editor through the DBML library planner, one batch per call
 * (one plan, one settle, one all-or-nothing write).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createRequire, syncBuiltinESMExports } from 'module';

import { classifySemanticFile, tableFileCandidates } from '@erd-studio/core';
import {
  DbmlTableWriteRefused,
  TableLibraryService,
  hasTablesLibrary,
  tablesDirIsLayer,
} from '../../src/services/logicalModelService';
import { UnsavedFilesRefused } from '../../src/services/fileWrites';
import type { SemanticTable } from '../../src/types/semantic';

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

/** A table of the layer-first tree: `Table <schema>.<name>` in `<layer>/tables/<schema>/`. */
function treeTable(layer: string, schema: string, name: string, columns = '  id INT [pk]', settings = ''): string {
  return write(`${layer}/tables/${schema}/${name}.dbml`, dbmlTable(`${schema}.${name}`, columns, settings));
}

function yamlTable(name: string): string {
  return `name: ${name}\ncolumns:\n  - name: id\n    dataType: INT\n`;
}

const HEADER = '// ERD Studio relationships: Refs only.\n';

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
  it('lists .dbml tables in <layer>/tables/<schema>/ with their storage, layer and schema folder; relationships files are never tables', () => {
    treeTable('silver', 'calendar', 'dim_date');
    treeTable('gold', 'gold', 'fct_order');
    write('gold/relationships/gold.dbml', HEADER);
    write('silver/relationships/calendar.dbml', HEADER);
    write('gold/diagrams/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n");
    const entries = service().listTableFiles();
    // Layers in name order (gold before silver), each layer's schemas in name order.
    expect(entries.map((e) => [e.name, e.layer, e.folder, e.storage, e.library])).toEqual([
      ['fct_order', 'gold', 'gold', 'dbml', undefined],
      ['dim_date', 'silver', 'calendar', 'dbml', undefined],
    ]);
  });

  it('logical-models/ and tables/ (YAML) win over a DBML table of the same name in any case; the DBML file is shadowed', () => {
    const v5 = write('logical-models/dim_date.yml', yamlTable('dim_date'));
    const v6 = write('tables/fct_order.yml', yamlTable('fct_order'));
    const dbml = treeTable('gold', 'gold', 'Dim_Date');
    const order = treeTable('gold', 'gold', 'fct_order');
    const entries = service().listTableFiles();
    expect(entries.find((e) => e.filePath === dbml)).toMatchObject({ shadowedBy: v5, storage: 'dbml', layer: 'gold' });
    expect(entries.find((e) => e.filePath === order)).toMatchObject({ shadowedBy: v6, storage: 'dbml' });
    expect(service().findTableFile('dim_date')).toBe(v5);
    expect(service().findTableFile('fct_order')).toBe(v6);
  });

  it('a name in two layers or two schemas: the first (layers, then schemas, in name order) wins, any case', () => {
    const first = treeTable('gold', 'a_schema', 'dim_x');
    const second = treeTable('gold', 'b_schema', 'DIM_X');
    const third = treeTable('silver', 'silver', 'dim_x');
    const entries = service().listTableFiles();
    expect(entries.map((e) => [rel(e.filePath), e.shadowedBy ? rel(e.shadowedBy) : null])).toEqual([
      ['gold/tables/a_schema/dim_x.dbml', null],
      ['gold/tables/b_schema/DIM_X.dbml', 'gold/tables/a_schema/dim_x.dbml'],
      ['silver/tables/silver/dim_x.dbml', 'gold/tables/a_schema/dim_x.dbml'],
    ]);
    expect(service().findTableFile('Dim_X')).toBe(first);
    expect([second, third]).not.toContain(service().findTableFile('dim_x'));
  });

  it('reads any non-dot schema folder (Finance, SAP FI), not only layer-shaped ones', () => {
    write('gold/tables/Finance/gl_account.dbml', dbmlTable('Finance.gl_account'));
    write('gold/tables/SAP FI/bkpf.dbml', dbmlTable('"SAP FI".bkpf'));
    write('gold/tables/.hidden/secret.dbml', dbmlTable('secret'));
    const lib = service();
    expect(lib.listTableFiles().map((e) => [e.name, e.folder])).toEqual([['gl_account', 'Finance'], ['bkpf', 'SAP FI']]);
    expect(lib.getTable('bkpf')?.name).toBe('bkpf');
    expect(lib.getTable('bkpf')?.schema).toBe('SAP FI');
    expect(lib.tableFolder('bkpf')).toBe('SAP FI');
  });

  it('`_relationships` is an ordinary table name in the layer-first tree, and a YAML _relationships.yml stays one too', () => {
    write('logical-models/_relationships.yml', yamlTable('_relationships'));
    treeTable('gold', 'gold', '_Relationships');
    const lib = service();
    expect(lib.listTableFiles().map((e) => [e.name, e.storage, !!e.shadowedBy])).toEqual([['_relationships', 'yaml', false], ['_Relationships', 'dbml', true]]);
    expect(lib.getTable('_relationships')?.name).toBe('_relationships');
  });

  it('a 1.9 pre-release tree is never read as tables or relationships files', () => {
    write('tables/dim_date.dbml', dbmlTable('dim_date'));
    write('tables/gold/fct_order.dbml', dbmlTable('fct_order'));
    write('tables/gold/_relationships.dbml', HEADER);
    write('gold/sales.dbml', "Project sales {\n  erd_schema_version: '7'\n}\n");
    const lib = service();
    expect(lib.listTableFiles()).toEqual([]);
    expect(lib.listRelationshipsFiles()).toEqual([]);
    expect(lib.findTableFile('dim_date')).toBeNull();
    expect(lib.hasTablesLibrary()).toBe(false);
  });
});

describe('the listing, the lookup and the relationships files agree with classifySemanticFile (D10, §3.5)', () => {
  it('every listed entry, found file and relationships file is what the single classifier says it is', () => {
    const files = [
      'logical-models/dim_old.yml', 'logical-models/stray.dbml', 'logical-models/gold/fct_old.yml',
      'tables/dim_date.dbml', 'tables/_relationships.dbml', 'tables/notes.txt', 'tables/gold/dim_yaml.yml',
      'gold/tables/gold/fct_order.dbml', 'gold/tables/stray.dbml', 'gold/tables/gold/deep/x.dbml', 'gold/tables/gold/notes.txt',
      'gold/relationships/gold.dbml', 'gold/relationships/nested/r.dbml', 'gold/relationships/notes.txt',
      'silver/relationships/calendar.dbml', 'silver/tables/calendar/dim_day.dbml', 'gold/diagrams/sales.dbml',
      'gold/tables/gold/.hidden.dbml',
    ];
    for (const f of files) write(f, f.endsWith('.yml') ? yamlTable(path.basename(f, '.yml')) : f.endsWith('.dbml') ? dbmlTable(path.basename(f, '.dbml')) : 'x\n');
    const lib = service();
    const classify = (f: string) => classifySemanticFile(f, { tablesDirIsLayer: false });
    const expected = files.filter((f) => classify(f).kind === 'table');
    expect(lib.listTableFiles().map((e) => rel(e.filePath)).sort()).toEqual([...expected].sort());
    for (const e of lib.listTableFiles()) {
      const c = classify(rel(e.filePath)!);
      expect([e.name, e.storage, e.storage === 'dbml' ? e.layer : undefined]).toEqual([c.name, c.storage, c.layer]);
    }
    // A name only a non-table file has is not found.
    expect(lib.findTableFile('stray')).toBeNull();
    expect(lib.findTableFile('x')).toBeNull();
    expect(rel(lib.findTableFile('fct_order'))).toBe('gold/tables/gold/fct_order.dbml');
    expect(lib.listRelationshipsFiles().map(rel)).toEqual(files.filter((f) => classify(f).kind === 'relationships').sort());
  });
});

describe('findTableFile: core\'s YAML candidate order (§3.4), then the DBML layers and their schemas', () => {
  // Each row: the files on disk, the name looked up, and the file it resolves to.
  const CASES: Array<{ title: string; files: string[]; name: string; expected: string }> = [
    { title: 'a DBML table', files: ['gold/tables/gold/x.dbml'], name: 'x', expected: 'gold/tables/gold/x.dbml' },
    { title: 'logical-models before a DBML layer', files: ['gold/tables/gold/x.dbml', 'logical-models/x.yml'], name: 'x', expected: 'logical-models/x.yml' },
    { title: 'tables/ (YAML) before a DBML layer', files: ['gold/tables/gold/x.dbml', 'tables/gold/x.yml'], name: 'x', expected: 'tables/gold/x.yml' },
    { title: 'layers by name', files: ['silver/tables/silver/x.dbml', 'bronze/tables/sap/x.dbml'], name: 'x', expected: 'bronze/tables/sap/x.dbml' },
    { title: 'schemas by name within a layer', files: ['gold/tables/zeta/x.dbml', 'gold/tables/alpha/x.dbml'], name: 'x', expected: 'gold/tables/alpha/x.dbml' },
  ];

  it.each(CASES)('$title', ({ files, name, expected }) => {
    for (const file of files) {
      write(file, file.endsWith('.dbml') ? dbmlTable(name) : yamlTable(name));
    }
    expect(rel(service().findTableFile(name))).toBe(expected);
  });

  it('the YAML order is core\'s tableFileCandidates order, unchanged', () => {
    const files = ['tables/gold/x.yml', 'tables/x.yml', 'logical-models/gold/x.yml'];
    for (const file of files) write(file, yamlTable('x'));
    const expected = tableFileCandidates('', 'x', ['gold']).find((c) => files.includes(c));
    expect(rel(service().findTableFile('x'))).toBe(expected);
  });
});

describe('symbolic links', () => {
  it('finds and reads a table file that is a symlink, in a YAML folder and a schema folder (as existsSync did before §3.4)', () => {
    const real = path.join(root, 'shared');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'dim_x.yml'), yamlTable('dim_x'));
    fs.writeFileSync(path.join(real, 'dim_y.dbml'), dbmlTable('gold.dim_y'));
    fs.mkdirSync(path.join(semantic, 'logical-models/gold'), { recursive: true });
    fs.symlinkSync(path.join(real, 'dim_x.yml'), path.join(semantic, 'logical-models/gold/dim_x.yml'));
    treeTable('gold', 'gold', 'dim_z');
    fs.symlinkSync(path.join(real, 'dim_y.dbml'), path.join(semantic, 'gold/tables/gold/dim_y.dbml'));
    // A link to nothing is not a table file.
    fs.symlinkSync(path.join(real, 'gone.yml'), path.join(semantic, 'logical-models/gold/gone.yml'));
    const lib = service();
    expect(rel(lib.findTableFile('dim_x'))).toBe('logical-models/gold/dim_x.yml');
    expect(lib.getTable('dim_x')?.name).toBe('dim_x');
    expect(lib.tableExists('dim_x')).toBe(true);
    expect(rel(lib.findTableFile('DIM_Y'))).toBe('gold/tables/gold/dim_y.dbml');
    expect(lib.getTable('dim_y')?.name).toBe('dim_y');
    expect(lib.findTableFile('gone')).toBeNull();
  });
});

describe('case (D2)', () => {
  it('a wrong-case lookup returns the listed file name, never the spelling looked up', () => {
    const file = treeTable('gold', 'gold', 'Dim_X');
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
    write('gold/tables/gold/dim_drift.dbml', dbmlTable('gold.Dim_Drift'));
    const table = service().getTable('dim_drift');
    expect(table?.name).toBe('Dim_Drift');
  });
});

describe('relationships (§2.4): every <layer>/relationships/*.dbml, a hand split included', () => {
  beforeEach(() => {
    treeTable('silver', 'calendar', 'dim_date', '  date_key INT [pk]\n  previous_date_key INT');
    treeTable('gold', 'gold', 'dim_customer', '  customer_key INT [pk]');
    treeTable('gold', 'gold', 'fct_order', '  order_id INT [pk]\n  customer_key INT\n  order_date_key INT\n  Ship_Date_Key INT');
    write('gold/relationships/gold.dbml', [
      HEADER,
      "use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'",
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
      "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'",
      '',
      'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key',
      'Ref "order date": gold.fct_order.order_date_key >? calendar.dim_date.date_key',
      'Ref "ship date": gold.FCT_ORDER.ship_date_key >? calendar.dim_date.date_key',
      '',
    ].join('\n'));
    write('silver/relationships/calendar.dbml', `${HEADER}use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\n\nRef "previous day": calendar.dim_date.previous_date_key > calendar.dim_date.date_key\n`);
  });

  it('listTables() returns DBML tables WITH their relationships, respelled, from whichever file holds each Ref (no misplaced Refs)', () => {
    // A Ref of dim_date (silver) held in gold's file: attached all the same.
    const goldFile = path.join(semantic, 'gold/relationships/gold.dbml');
    fs.writeFileSync(path.join(semantic, 'silver/relationships/calendar.dbml'), HEADER);
    fs.appendFileSync(goldFile, 'Ref "previous day": calendar.dim_date.previous_date_key > calendar.dim_date.date_key\n');
    const lib = service();
    expect(lib.listRelationshipsFiles().map(rel)).toEqual(['gold/relationships/gold.dbml', 'silver/relationships/calendar.dbml']);
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
    expect(lib.libraryAttachment()?.misplaced ?? []).toEqual([]);
    // getTable agrees with listTables.
    expect(lib.getTable('dim_date')?.relationships).toEqual(tables.get('dim_date')?.relationships);
  });

  it('a relationships-file change is seen without a table re-read; a table change re-reads that table only', () => {
    const lib = service();
    expect(lib.getTable('dim_date')?.relationships).toHaveLength(1);
    const relFile = path.join(semantic, 'silver/relationships/calendar.dbml');
    fs.writeFileSync(relFile, `${HEADER}use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\n`);
    bumpMtime(relFile);
    expect(lib.getTable('dim_date')?.relationships).toBeUndefined();
    // And invalidateRelationships() drops the cached readings outright.
    fs.writeFileSync(relFile, `${HEADER}use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\n\nRef: calendar.dim_date.previous_date_key > calendar.dim_date.date_key\n`);
    lib.invalidateRelationships();
    expect(lib.getTable('dim_date')?.relationships).toHaveLength(1);

    const tableFile = path.join(semantic, 'gold/tables/gold/dim_customer.dbml');
    fs.writeFileSync(tableFile, dbmlTable('gold.dim_customer', '  customer_key INT [pk]\n  segment VARCHAR'));
    bumpMtime(tableFile);
    expect(lib.getTable('dim_customer')?.columns.map((c) => c.name)).toEqual(['customer_key', 'segment']);
    // fct_order's Refs are unchanged by a table edit elsewhere.
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    lib.invalidateCache();
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
  });

  it('listTables() attaches once per call, and a warm getTable() lists nothing (no per-table library pass)', () => {
    for (let i = 0; i < 30; i++) treeTable('gold', 'gold', `t${i}`, '  id INT [pk]\n  customer_key INT');
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

  it('the memoised attachment sees a new table file, a new relationships file (in a new layer) and a changed table', () => {
    const lib = service();
    expect(lib.getTable('dim_customer')?.relationships).toBeUndefined();
    // A new table owning a Ref that was an orphan: the directory changed, so the memo is rebuilt.
    fs.appendFileSync(path.join(semantic, 'gold/relationships/gold.dbml'), 'Ref: gold.dim_region.customer_key >? gold.dim_customer.customer_key\n');
    bumpMtime(path.join(semantic, 'gold/relationships/gold.dbml'));
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    treeTable('gold', 'gold', 'dim_region', '  region_key INT [pk]\n  customer_key INT');
    expect(lib.getTable('fct_order')?.relationships).toHaveLength(3);
    expect(lib.listTables().find((t) => t.name === 'dim_region')?.relationships).toEqual([
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    ]);
    // A relationships file in a new layer.
    treeTable('bronze', 'raw', 'stg_x', '  id INT [pk]\n  customer_key INT');
    expect(lib.getTable('stg_x')?.relationships).toBeUndefined();
    write('bronze/relationships/bronze.dbml', `${HEADER}Ref: raw.stg_x.customer_key >? gold.dim_customer.customer_key\n`);
    expect(lib.getTable('stg_x')?.relationships).toHaveLength(1);
    // A table edited in place, then read: its new column is what the attachment resolves against.
    const fct = path.join(semantic, 'gold/tables/gold/fct_order.dbml');
    fs.writeFileSync(fct, dbmlTable('gold.fct_order', '  order_id INT [pk]\n  CUSTOMER_KEY INT\n  order_date_key INT\n  Ship_Date_Key INT'));
    bumpMtime(fct);
    expect(lib.getTable('fct_order')?.relationships?.[0]).toMatchObject({ fromColumn: 'CUSTOMER_KEY' });
  });

  it('an unreadable relationships file counts as unreadable relationships', () => {
    const lib = service();
    expect(lib.hasUnreadableRelationships()).toBe(false);
    const relFile = path.join(semantic, 'gold/relationships/gold.dbml');
    fs.writeFileSync(relFile, 'Ref: gold.fct_order.customer_key >? gold.dim_customer.(\n');
    bumpMtime(relFile);
    expect(lib.hasUnreadableRelationships()).toBe(true);
  });
});

describe('dbmlSnapshot: what the planner reads (S6a consumes layer and schema)', () => {
  it('each DBML table carries its layer and schema folder; its reference is the declared one, else `<schema>.<name>`', () => {
    treeTable('gold', 'gold', 'fct_order');
    write('gold/tables/Sales Area/broken.dbml', 'Table "Sales Area".broken {\n  id INT [pk\n');
    write('gold/tables/gold/plain.dbml', dbmlTable('plain'));
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    write('gold/relationships/gold.dbml', HEADER);
    const snapshot = service().dbmlSnapshot();
    expect(snapshot.tables.get('fct_order')).toMatchObject({ layer: 'gold', schema: 'gold', folder: 'gold', reference: 'gold.fct_order', path: 'gold/tables/gold/fct_order.dbml', storage: 'dbml' });
    // A file that does not read is still spelled as its writer would spell it.
    expect(snapshot.tables.get('broken')).toMatchObject({ layer: 'gold', schema: 'Sales Area', reference: '"Sales Area".broken' });
    // An unqualified Table keeps its declared (unqualified) spelling.
    expect(snapshot.tables.get('plain')).toMatchObject({ reference: 'plain', schema: 'gold' });
    expect(snapshot.tables.get('dim_old')).not.toHaveProperty('layer');
    expect([...snapshot.relationshipsFiles.keys()]).toEqual(['gold/relationships/gold.dbml']);
    expect(snapshot.files.has('gold/relationships/gold.dbml')).toBe(true);
  });
});

describe('ensureDir and pathForNewTable in the layer-first tree', () => {
  it('ensureDir creates <layer>/tables/<schema>/ and <layer>/relationships/, and refuses any other folder outside the library', () => {
    write('gold/tables/gold/fct_order.dbml', dbmlTable('gold.fct_order'));
    const lib = service();
    lib.ensureDir(path.join(semantic, 'silver/tables/calendar/dim_date.dbml'));
    expect(fs.statSync(path.join(semantic, 'silver/tables/calendar')).isDirectory()).toBe(true);
    lib.ensureDir(path.join(semantic, 'silver/relationships/silver.dbml'));
    expect(fs.statSync(path.join(semantic, 'silver/relationships')).isDirectory()).toBe(true);
    expect(() => lib.ensureDir(path.join(semantic, 'silver/elsewhere/x.dbml'))).toThrow(/outside the Table Library/);
    expect(() => lib.ensureDir(path.join(semantic, 'silver/tables/x.dbml'))).toThrow(/outside the Table Library/);
  });

  it('pathForNewTable in a DBML project: <layer>/tables/<layer>/<name>.dbml, the schema folder as listed, the default layer without one', () => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'silver', label: 'Silver', abbreviation: 'S', color: '#888888', creatable: true, order: 1 }] }));
    treeTable('gold', 'gold', 'fct_order');
    expect(rel(service().pathForNewTable('dim_new', 'gold'))).toBe('gold/tables/gold/dim_new.dbml');
    // The first layer layers.json lists.
    expect(rel(service().pathForNewTable('dim_new'))).toBe('silver/tables/silver/dim_new.dbml');
    // An existing schema folder of another case is used as listed (§1.2 One spelling).
    write('silver/tables/Silver/dim_x.dbml', dbmlTable('Silver.dim_x'));
    expect(rel(service().pathForNewTable('dim_new', 'silver'))).toBe('silver/tables/Silver/dim_new.dbml');
    // No layers.json: the first DBML layer folder, sorted.
    fs.rmSync(path.join(semantic, 'layers.json'));
    expect(rel(service().pathForNewTable('dim_new'))).toBe('gold/tables/gold/dim_new.dbml');
    expect(() => service().pathForNewTable('../x')).toThrow(/path separators/);
  });

  it('pathForNewTable in an empty project is main/tables/main/', () => {
    expect(rel(service().pathForNewTable('dim_new'))).toBe('main/tables/main/dim_new.dbml');
  });

  it('pathForNewTable keeps today\'s rule (a .yml path) in a YAML project', () => {
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    expect(rel(service().pathForNewTable('dim_new'))).toBe('logical-models/dim_new.yml');
  });

  it('tableStorage names a table\'s format', () => {
    treeTable('gold', 'gold', 'fct_order');
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    const lib = service();
    expect(lib.tableStorage('fct_order')).toBe('dbml');
    expect(lib.tableStorage('dim_old')).toBe('yaml');
    expect(lib.tableStorage('nothing')).toBeUndefined();
  });
});

describe('DBML TableFileErrors', () => {
  it.each([
    ['a syntax error', 'Table gold.broken {\n  id INT [pk\n}\n', 'dbmlSyntax'],
    ['an unquoted word', "Table gold.broken [grain: one row] {\n  id INT\n}\n", 'dbmlInvalid'],
    ['two Tables', 'Table gold.broken {\n  id INT\n}\nTable gold.other {\n  id INT\n}\n', 'dbmlStructure'],
    ['a name that is not the file\'s', 'Table gold.other_name {\n  id INT\n}\n', 'dbmlStructure'],
  ])('%s is a %s error with its code and line', (_title, text, kind) => {
    const file = write('gold/tables/gold/broken.dbml', text);
    const lib = service();
    expect(lib.getTable('broken')).toBeNull();
    const error = lib.getTableFileError('broken');
    expect(error).toMatchObject({ name: 'broken', filePath: file, kind });
    expect(error?.code).toBeDefined();
    expect(error?.line).toBeGreaterThan(0);
  });

  it('git conflict markers are a dbmlSyntax error with mergeConflict', () => {
    write('gold/tables/gold/broken.dbml', 'Table gold.broken {\n<<<<<<< HEAD\n  id INT\n=======\n  id BIGINT\n>>>>>>> other\n}\n');
    expect(service().getTableFileError('broken')).toMatchObject({ kind: 'dbmlSyntax', mergeConflict: true, line: 2 });
  });

  it('an empty file cannot be read', () => {
    write('gold/tables/gold/broken.dbml', '');
    expect(service().getTableFileError('broken')).toMatchObject({ kind: 'read' });
  });

  it('a readable table with an inline ref still loads (its problem is a warning)', () => {
    treeTable('gold', 'gold', 'dim_x');
    write('gold/tables/gold/fct_y.dbml', 'Table gold.fct_y {\n  id INT [pk]\n  x_id INT [ref: > gold.dim_x.id]\n}\n');
    const table = service().getTable('fct_y');
    expect(table?.columns.map((c) => c.name)).toEqual(['id', 'x_id']);
    expect(table?.relationships).toBeUndefined();
  });
});

describe('DBML table writes outside the editor (one batch: planDbmlLibraryWrites, one settle, writeFilesWithRollback)', () => {
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

  it('saveTable(model, layer): <layer>/tables/<layer>/, or the configured schema; a non-layer folder takes the default layer', () => {
    write('layers.json', JSON.stringify({ schemaVersion: 1, layers: [{ id: 'silver', label: 'Silver', abbreviation: 'S', color: '#888888', creatable: true, order: 1 }] }));
    treeTable('gold', 'gold', 'fct_order');
    const lib = service();
    lib.saveTable({ name: 'dim_a', columns: [] }, 'gold');
    lib.saveTable({ name: 'dim_b', columns: [], configuredSchema: 'finance', schema: 'dbt_liam_finance' } as SemanticTable, 'gold');
    lib.saveTable({ name: 'dim_c', columns: [] }, 'Not A Layer');
    expect(fs.readFileSync(path.join(semantic, 'gold/tables/gold/dim_a.dbml'), 'utf-8')).toMatch(/^Table gold\.dim_a \{/);
    expect(fs.readFileSync(path.join(semantic, 'gold/tables/finance/dim_b.dbml'), 'utf-8')).toMatch(/^Table finance\.dim_b \{/);
    expect(fs.existsSync(path.join(semantic, 'silver/tables/silver/dim_c.dbml'))).toBe(true);
  });

  it('serializeTable never renders a .dbml table as YAML; saveTable splices it in place', () => {
    const file = write('gold/tables/gold/dim_date.dbml', '// keep me\n' + dbmlTable('gold.dim_date', '  id INT [pk]\n  label VARCHAR'));
    const lib = service();
    const table = lib.getTable('dim_date')!;
    expect(() => lib.serializeTable(table)).toThrow(DbmlTableWriteRefused);
    table.columns[1].description = 'Shown name';
    lib.saveTable(table);
    // Spliced, then aligned (every DBML write is in the canonical layout).
    expect(fs.readFileSync(file, 'utf-8')).toBe("// keep me\nTable gold.dim_date {\n  id    INT     [pk]\n  label VARCHAR [note: 'Shown name']\n}\n");
    expect(fs.readdirSync(path.dirname(file))).toEqual(['dim_date.dbml']);
  });

  /** gold's dim_date and fct_x, with fct_x's Ref in gold's default relationships file. */
  function goldLibrary(): string {
    treeTable('gold', 'gold', 'dim_date');
    treeTable('gold', 'gold', 'fct_x', '  id INT [pk]\n  date_id INT');
    return write('gold/relationships/gold.dbml', `${HEADER}use { table gold.dim_date } from '../tables/gold/dim_date.dbml'\nuse { table gold.fct_x } from '../tables/gold/fct_x.dbml'\n\nRef: gold.fct_x.date_id >? gold.dim_date.id\n`);
  }

  it('renameTable renames the file, splices the name and re-spells every Ref naming it, in place', () => {
    const relFile = goldLibrary();
    const lib = service();
    lib.renameTable('dim_date', 'dim_day');
    expect(fs.existsSync(path.join(semantic, 'gold/tables/gold/dim_date.dbml'))).toBe(false);
    expect(fs.readFileSync(path.join(semantic, 'gold/tables/gold/dim_day.dbml'), 'utf-8')).toBe(dbmlTable('gold.dim_day'));
    expect(fs.readFileSync(relFile, 'utf-8'))
      .toBe(`${HEADER}use { table gold.dim_day } from '../tables/gold/dim_day.dbml'\nuse { table gold.fct_x }   from '../tables/gold/fct_x.dbml'\n\nRef: gold.fct_x.date_id >? gold.dim_day.id\n`);
    expect(lib.getTable('fct_x')?.relationships?.[0]).toMatchObject({ toModel: 'dim_day', toColumn: 'id' });
  });

  it('renameTable to `_relationships`: an ordinary table name in the layer-first tree', () => {
    treeTable('gold', 'gold', 'dim_date');
    const lib = service();
    lib.renameTable('dim_date', '_relationships');
    expect(fs.readdirSync(path.join(semantic, 'gold/tables/gold'))).toEqual(['_relationships.dbml']);
    expect(lib.listTables().map((t) => t.name)).toEqual(['_relationships']);
  });

  it('deleteTable runs the D16 cascade from the index: the file, its Refs and other owners\' Refs to it, and their use lines', () => {
    const relFile = goldLibrary();
    const lib = service();
    const listing = vi.spyOn(lib, 'listTables');
    expect(lib.dbmlDeleteCascadeOps(['dim_date']).save.map((s) => s.model.name)).toEqual(['fct_x']);
    lib.deleteTable('dim_date');
    expect(listing).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(semantic, 'gold/tables/gold/dim_date.dbml'))).toBe(false);
    // The relationships file keeps its header and is never deleted (D15).
    expect(fs.readFileSync(relFile, 'utf-8')).toBe(HEADER);
    expect(lib.getTable('fct_x')?.relationships).toBeUndefined();
  });

  it('deleteTable in a mixed project: a YAML table\'s relationship to it stays in its yml; DBML owners lose theirs', () => {
    const relFile = goldLibrary();
    const yml = write('logical-models/fct_y.yml', 'name: fct_y\ncolumns:\n  - name: date_id\n    dataType: INT\nrelationships:\n  - fromColumn: date_id\n    toModel: dim_date\n    toColumn: id\n');
    const ymlText = fs.readFileSync(yml, 'utf-8');
    const lib = service();
    lib.deleteTable('dim_date');
    expect(fs.existsSync(path.join(semantic, 'gold/tables/gold/dim_date.dbml'))).toBe(false);
    expect(fs.readFileSync(yml, 'utf-8')).toBe(ymlText);
    expect(fs.readFileSync(relFile, 'utf-8')).toBe(HEADER);
  });

  it('relationshipsFileForNewRef follows decision 5; relationshipsFileHolding names where a Ref is; YAML tables have neither', () => {
    goldLibrary();
    treeTable('gold', 'gold', 'fct_new', '  id INT [pk]\n  date_id INT');
    treeTable('silver', 'silver', 'stg_x', '  id INT [pk]\n  date_id INT');
    write('gold/relationships/hand.dbml', `${HEADER}use { table gold.dim_date } from '../tables/gold/dim_date.dbml'\nuse { table gold.fct_x } from '../tables/gold/fct_x.dbml'\n\nRef "b": gold.fct_x.id >? gold.dim_date.id\n`);
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    const lib = service();
    // fct_x: one Ref in each file; the tie goes to path byte order.
    expect(rel(lib.relationshipsFileForNewRef('fct_x') ?? null)).toBe('gold/relationships/gold.dbml');
    // No Ref yet: its layer's default file (which may not exist).
    expect(rel(lib.relationshipsFileForNewRef('fct_new') ?? null)).toBe('gold/relationships/gold.dbml');
    expect(rel(lib.relationshipsFileForNewRef('STG_X') ?? null)).toBe('silver/relationships/silver.dbml');
    expect(lib.relationshipsFileForNewRef('dim_old')).toBeUndefined();
    expect(lib.relationshipsFileFor('stg_x')).toBe(lib.relationshipsFileForNewRef('stg_x'));
    expect(rel(lib.relationshipsFileHolding({ fromModel: 'fct_x', fromColumn: 'id', toModel: 'dim_date', toColumn: 'id' }) ?? null)).toBe('gold/relationships/hand.dbml');
    expect(rel(lib.relationshipsFileHolding({ fromModel: 'DIM_DATE', fromColumn: 'ID', toModel: 'fct_x', toColumn: 'date_id' }) ?? null)).toBe('gold/relationships/gold.dbml');
    expect(lib.relationshipsFileHolding({ fromModel: 'stg_x', fromColumn: 'date_id', toModel: 'dim_date', toColumn: 'id' })).toBeUndefined();
  });

  it('planTableWrites: a diagram\'s { layer, schema } home, a layer name, the schema folder as listed', () => {
    write('gold/tables/Gold/fct_order.dbml', dbmlTable('Gold.fct_order'));
    const lib = service();
    const model = { name: 'dim_new', columns: [{ name: 'id', dataType: 'INT', description: '' }] };
    const paths = (home: Parameters<TableLibraryService['planTableWrites']>[1]): string[] =>
      lib.planTableWrites({ save: [{ model }] }, home, { dbml: true }).writes.map((w) => `${w.kind} ${rel(w.path)}`);
    expect(paths('gold')).toEqual(['create gold/tables/Gold/dim_new.dbml']);
    expect(paths({ layer: 'silver', schema: 'crm' })).toEqual(['create silver/tables/crm/dim_new.dbml']);
    // Import keeps the source's schema (spelled as listed).
    const imported = lib.planTableWrites({ save: [{ model: { ...model, schema: 'GOLD' } }] }, { layer: 'gold', schema: 'gold' }, { dbml: true, schemaFromSource: true });
    expect(imported.writes.map((w) => rel(w.path))).toEqual(['gold/tables/Gold/dim_new.dbml']);
  });

  it('applyDbmlBatch: one plan and one settle for many ops; a dirty diagram it would change refuses everything', () => {
    goldLibrary();
    treeTable('gold', 'gold', 'dim_store', '  id INT [pk]');
    treeTable('gold', 'gold', 'fct_y', '  id INT [pk]\n  store_id INT');
    const diagram = write('gold/diagrams/sales.dbml', "use { table gold.dim_store } from '../tables/gold/dim_store.dbml'\nuse { table gold.fct_y } from '../tables/gold/fct_y.dbml'\n\nProject sales {\n  erd_schema_version: '7'\n}\n");
    const diagramText = fs.readFileSync(diagram, 'utf-8');
    const lib = service();
    const fctY = { ...lib.getTable('fct_y')!, relationships: [{ fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'id', cardinality: 'many-to-one' as const }] };
    const before = snapshotTree();
    expect(() => lib.applyDbmlBatch({ ops: { save: [{ model: fctY }] }, dirtyFiles: (paths) => paths.filter((p) => p === diagram) }))
      .toThrow(UnsavedFilesRefused);
    expect(snapshotTree()).toEqual(before);
    const listing = vi.spyOn(lib, 'listDbmlDiagrams');
    const fctX = { ...lib.getTable('fct_x')!, description: 'X' };
    const { writes } = lib.applyDbmlBatch({ ops: { save: [{ model: fctY }, { model: fctX }, { model: { name: 'dim_new', columns: [] } }], newTableHome: { layer: 'gold', schema: 'gold' } } });
    expect(listing).toHaveBeenCalledTimes(1);
    expect(writes.map((w) => `${w.kind} ${rel(w.path)}`).sort()).toEqual([
      'create gold/tables/gold/dim_new.dbml',
      'replace gold/diagrams/sales.dbml',
      'replace gold/relationships/gold.dbml',
      'replace gold/tables/gold/fct_x.dbml',
    ]);
    // The diagram imports the file now holding a Ref between its members (the settle).
    expect(fs.readFileSync(diagram, 'utf-8')).not.toBe(diagramText);
    expect(fs.readFileSync(diagram, 'utf-8')).toContain("use * from '../relationships/gold.dbml'");
    // A column-description edit settles nothing: no diagram is even listed.
    listing.mockClear();
    lib.saveTable({ ...lib.getTable('dim_store')!, description: 'Stores' });
    expect(listing).not.toHaveBeenCalled();
  });

  it('after a batch, the written relationships file\'s reading is primed: the next snapshot reads it from no disk', () => {
    const relFile = goldLibrary();
    treeTable('gold', 'gold', 'dim_store', '  id INT [pk]');
    const lib = service();
    lib.dbmlSnapshot();
    const fctX = { ...lib.getTable('fct_x')!, columns: [...lib.getTable('fct_x')!.columns, { name: 'store_id', dataType: 'INT', description: '' }] };
    fctX.relationships = [...(fctX.relationships ?? []), { fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'id', cardinality: 'many-to-one' }];
    lib.saveTable(fctX);
    expect(fs.readFileSync(relFile, 'utf-8')).toContain('Ref: gold.fct_x.store_id >? gold.dim_store.id');
    const reads = countReads(() => lib.dbmlSnapshot());
    expect(reads.filter((p) => p.endsWith('/gold/relationships/gold.dbml'))).toEqual([]);
    expect(lib.dbmlSnapshot().relationshipsFiles.get('gold/relationships/gold.dbml')?.refs).toHaveLength(2);
  });

  it('a configured schema is never written to a YAML table', () => {
    write('logical-models/dim_old.yml', yamlTable('dim_old'));
    service().saveTable({ name: 'dim_new', columns: [], configuredSchema: 'finance' } as SemanticTable);
    expect(fs.readFileSync(path.join(semantic, 'logical-models/dim_new.yml'), 'utf-8')).not.toContain('finance');
  });
});

/** Every file under the semantic dir, relative path → text. */
function snapshotTree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(semantic, abs).split(path.sep).join('/')] = fs.readFileSync(abs, 'utf-8');
    }
  };
  walk(semantic);
  return out;
}

/** The files `fn` reads (through the CommonJS `fs`, which the services' ESM namespace follows once synced), posix. */
function countReads(fn: () => void): string[] {
  const cjsFs = createRequire(__filename)('fs') as typeof fs;
  const real = cjsFs.readFileSync;
  const reads: string[] = [];
  (cjsFs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]) {
    reads.push(String(args[0]).split(path.sep).join('/'));
    return (real as (...a: unknown[]) => unknown).apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    fn();
  } finally {
    cjsFs.readFileSync = real;
    syncBuiltinESMExports();
  }
  return reads;
}

describe('tables/: library or layer, the YAML rule (develop\'s: a .json or a layers.json listing)', () => {
  const LISTED = JSON.stringify({ schemaVersion: 1, layers: [{ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 1 }] });

  it.each([
    // a 1.9 .dbml leftover, json, listed → tables/ is a layer?
    { leftover: false, json: false, listed: false, layer: false },
    { leftover: false, json: true, listed: false, layer: true },
    { leftover: false, json: false, listed: true, layer: true },
    { leftover: false, json: true, listed: true, layer: true },
    { leftover: true, json: false, listed: false, layer: false },
    { leftover: true, json: false, listed: true, layer: true },
    { leftover: true, json: true, listed: false, layer: true },
    { leftover: true, json: true, listed: true, layer: true },
  ])('leftover $leftover, json $json, listed $listed → layer $layer', ({ leftover, json, listed, layer }) => {
    write('tables/dim_x.yml', yamlTable('dim_x'));
    if (leftover) write('tables/gold/dim_y.dbml', dbmlTable('dim_y'));
    if (json) write('tables/sales.json', '{}');
    if (listed) write('layers.json', LISTED);
    expect(tablesDirIsLayer(semantic)).toBe(layer);
    expect(hasTablesLibrary(semantic)).toBe(!layer);
    expect(service().tablesDirIsLayer()).toBe(layer);
    expect(service().hasTablesLibrary()).toBe(!layer);
  });

  it('a tables/ holding only .dbml (a 1.9 leftover) is no library', () => {
    write('tables/gold/_relationships.dbml', HEADER);
    write('tables/dim_x.dbml', dbmlTable('dim_x'));
    expect(hasTablesLibrary(semantic)).toBe(false);
    expect(tablesDirIsLayer(semantic)).toBe(false);
    expect(service().hasTablesLibrary()).toBe(false);
  });
});

/** Move a file's mtime forward a second, so a cache keyed on mtime + size sees a same-size rewrite. */
function bumpMtime(file: string): void {
  const stat = fs.statSync(file);
  fs.utimesSync(file, stat.atime, new Date(stat.mtimeMs + 1000));
}
