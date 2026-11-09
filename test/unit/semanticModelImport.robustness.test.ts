/**
 * Import or report, for Power BI semantic models: one file that does not read
 * never fails the model, every loss is a ledger entry with its file and line,
 * and nothing goes unsaid. Covers TMDL isolation (a deliberately broken copy
 * of a real model in test/fixtures/semantic-model-broken-copy, and
 * small cases), Tabular Editor's Save to Folder layout, TMSL line numbers,
 * relationship settings with no place in a diagram, and the sources of
 * Power Query merges and appends.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { walkSemanticModelFiles } from '../../src/commands/importSemanticModel';
import { planDbmlImport } from '../../src/services/dbmlImport';
import { readDbml } from '../../src/services/dbmlImportParse';
import { ledgerLeftOut, ledgerNotes, type LedgerEntry } from '../../src/services/importLedger';
import { MAX_JSON_DEPTH, parseJsonWithLines } from '../../src/services/jsonLines';
import { mCombineCalls, mName, parseMLet } from '../../src/services/powerQueryLet';
import { readFolderModel } from '../../src/services/semanticModelFolder';
import {
  SEMANTIC_MODEL_META,
  findSemanticModels,
  mCombinedSources,
  readSemanticModel,
  semanticModelToDbml,
  type SemanticModel,
  type SemanticModelFile,
} from '../../src/services/semanticModelImport';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const REAL = path.join(FIXTURES, 'real-world-imports');

/** Every file under `dir`, with paths relative to `base` (`/`-joined), read as UTF-8. */
function filesUnder(dir: string, base = path.dirname(dir), include = (f: string): boolean => /\.(tmdl|bim|json)$|\.platform$/i.test(f)): SemanticModelFile[] {
  const out: SemanticModelFile[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (include(e.name)) out.push({ path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf-8') });
    }
  };
  walk(dir);
  return out;
}

function readOk(files: SemanticModelFile[]): Extract<ReturnType<typeof readSemanticModel>, { ok: true }> {
  const r = readSemanticModel(files);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}

function plan(dbml: string): ReturnType<typeof planDbmlImport> {
  const r = readDbml(dbml);
  if (!r.ok) throw new Error(`${JSON.stringify(r.diagnostics)}\n${dbml}`);
  return planDbmlImport({
    model: r.model, layer: 'main', subjectAreaName: 's', fileName: 's.dbml',
    library: { findTableName: () => null, getTable: () => null }, libraryRelationships: true,
  });
}

const problems = (ledger: readonly LedgerEntry[]): LedgerEntry[] => ledger.filter((e) => e.outcome === 'problem');
const count = (ledger: readonly LedgerEntry[], pred: (e: LedgerEntry) => boolean): number => ledger.filter(pred).reduce((n, e) => n + e.count, 0);

// ---------------------------------------------------------------------------
// TMDL: a broken copy of a real model
// ---------------------------------------------------------------------------

describe('TMDL: one broken file never fails the model (a broken copy of the Business Central Purchase app)', () => {
  const brokenDir = path.join(FIXTURES, 'semantic-model-broken-copy', 'Purchase app.SemanticModel');
  const realDir = path.join(REAL, 'powerbi-tmdl-bc-purchase', 'Purchase app.SemanticModel');
  const broken = filesUnder(brokenDir);
  const real = filesUnder(realDir);
  const result = readOk(broken);
  const ledger = result.model.ledger ?? [];
  const converted = semanticModelToDbml(result.model);
  const file = (name: string): string => `Purchase app.SemanticModel/definition/${name}`;

  it('reads every file that reads, and names the model from .platform', () => {
    expect(result.model.name).toBe('Purchase app');
    // 28 table files in the copy, one of them (Item) not text.
    expect(result.model.tables).toHaveLength(27);
    expect(result.model.tables.map((t) => t.name)).not.toContain('Item');
    expect(result.problems?.length).toBeGreaterThanOrEqual(4);
  });

  it('records each loss as a problem with its file and line (and the table, column or relationship it was)', () => {
    expect(problems(ledger)).toEqual(expect.arrayContaining([
      expect.objectContaining({ unit: 'column', what: 'TMDL column with no closing quote', where: { file: file('tables/Vendor.tmdl'), line: 82, table: 'Vendor', column: 'Vendor Name' } }),
      expect.objectContaining({ unit: 'column', what: 'TMDL column with a ``` block never closed', where: { file: file('tables/Location.tmdl'), line: 13, table: 'Location', column: 'Location Label' } }),
      expect.objectContaining({ unit: 'column', what: 'TMDL column after a ``` block never closed', where: { file: file('tables/Location.tmdl'), line: 16, table: 'Location', column: 'Location Name' } }),
      expect.objectContaining({ unit: 'column', what: 'TMDL column after a ``` block never closed', where: expect.objectContaining({ table: 'Location', column: 'Location Adjustment Bin Code' }) }),
      expect.objectContaining({ unit: 'relationship', what: 'TMDL relationship with no closing quote', where: { file: file('relationships.tmdl'), line: 5, table: 'Purchase Budget', column: 'Vendor No.' } }),
      expect.objectContaining({ unit: 'table', what: 'TMDL table file that is not UTF-8 text', where: { file: file('tables/Item.tmdl'), table: 'Item' } }),
    ]));
    // Every problem says where it is.
    for (const p of problems(ledger)) expect(p.where?.file, JSON.stringify(p)).toBeTruthy();
  });

  it('conserves columns: the copy\'s columns are imported or reported, one each', () => {
    const realModel = readOk(real).model;
    const vendor = (m: SemanticModel): string[] => m.tables.find((t) => t.name === 'Vendor')!.columns.map((c) => c.name);
    expect(vendor(result.model)).toEqual(vendor(realModel).filter((c) => c !== 'Vendor Name'));
    // Location: the key read before the broken block; its 3 other columns (the broken one and the 2 after it) reported.
    expect(result.model.tables.find((t) => t.name === 'Location')!.columns.map((c) => c.name)).toEqual(['Location Code']);
    expect(count(ledger, (e) => e.outcome === 'problem' && e.unit === 'column' && e.where?.table === 'Location')).toBe(3);
  });

  it('conserves relationships: drawn, skipped (an end not in the copy) or not read, each counted', () => {
    const blocks = broken.find((f) => f.path.endsWith('relationships.tmdl'))!.text.split('\n').filter((l) => /^relationship\s/.test(l)).length;
    expect(blocks).toBe(55);
    const all = converted.ledger;
    const skipped = count(all, (e) => e.outcome === 'skipped' && e.unit === 'relationship');
    const notRead = count(all, (e) => e.outcome === 'problem' && e.unit === 'relationship');
    expect(notRead).toBe(1);
    expect(converted.refCount + skipped + notRead).toBe(blocks);
  });

  it('reads CRLF with a BOM, and four-space indents, as the real files read', () => {
    const realModel = readOk(real).model;
    for (const name of ['Purchaser', 'Reason Codes']) {
      const got = result.model.tables.find((t) => t.name === name)!;
      const want = realModel.tables.find((t) => t.name === name)!;
      expect(got.columns.map((c) => [c.name, c.dataType, c.isKey]), name).toEqual(want.columns.map((c) => [c.name, c.dataType, c.isKey]));
    }
  });

  it('says what was not read in the draft\'s Not imported list, by name', () => {
    const leftOut = ledgerLeftOut(converted.ledger).join('\n');
    expect(leftOut).toMatch(/1 column: TMDL column with no closing quote not read \(Vendor\.Vendor Name\)/);
    expect(leftOut).toContain('Vendor.Vendor Name');
    expect(leftOut).toContain('Item');
    // The DBML still imports.
    expect(plan(converted.dbml).newTables.length).toBe(27);
  });
});

// ---------------------------------------------------------------------------
// TMDL: small cases
// ---------------------------------------------------------------------------

describe('TMDL isolation, case by case', () => {
  const good = (name: string): SemanticModelFile => ({
    path: `M.SemanticModel/definition/tables/${name}.tmdl`,
    text: `table '${name.replace(/'/g, "''")}'\n\tcolumn Id\n\t\tdataType: int64\n\t\tisKey\n\tcolumn 'Customer''s Name'\n\t\tdataType: string\n`,
  });

  it('a table whose name has no closing quote is left out by name; the others (quoted names with spaces and apostrophes) read', () => {
    const r = readOk([
      good("Customer's Orders"),
      { path: 'M.SemanticModel/definition/tables/Bad.tmdl', text: "table 'Bad Table\n\tcolumn Id\n\t\tdataType: int64\n" },
      good('Store Front'),
    ]);
    expect(r.model.tables.map((t) => t.name)).toEqual(["Customer's Orders", 'Store Front']);
    expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['Id', "Customer's Name"]);
    expect(problems(r.model.ledger ?? [])).toEqual([
      expect.objectContaining({ unit: 'table', what: 'TMDL table with no closing quote', where: { file: 'M.SemanticModel/definition/tables/Bad.tmdl', line: 1, table: 'Bad Table' } }),
    ]);
    expect(r.problems).toEqual([expect.objectContaining({ file: 'M.SemanticModel/definition/tables/Bad.tmdl', line: 1 })]);
  });

  it('a measure whose ``` block is never closed: the table keeps what came before, and names the rest', () => {
    const r = readOk([{
      path: 't/tables/Sales.tmdl',
      text: ['table Sales', '\tcolumn A', '\t\tdataType: int64', '\tmeasure Total = ```', '\t\tSUM(Sales[A])', '\tcolumn B', '\t\tdataType: string', '\tcolumn C', ''].join('\r\n'),
    }]);
    expect(r.model.tables[0].columns.map((c) => c.name)).toEqual(['A']);
    const ledger = r.model.ledger ?? [];
    expect(problems(ledger).map((e) => [e.unit, e.what, e.where?.line, e.where?.column ?? e.where?.table])).toEqual([
      ['object', 'TMDL measure with a ``` block never closed', 4, 'Sales'],
      ['column', 'TMDL column after a ``` block never closed', 6, 'B'],
      ['column', 'TMDL column after a ``` block never closed', 8, 'C'],
    ]);
  });

  it('a file that is not text, under tables/, names the table its file is named after (%2F decoded)', () => {
    const r = readOk([good('Kept'), { path: 'm/definition/tables/G%2FL Accounts.tmdl', text: 't\u0000a\u0000b' }]);
    expect(r.model.tables.map((t) => t.name)).toEqual(['Kept']);
    expect(problems(r.model.ledger ?? [])).toEqual([expect.objectContaining({ unit: 'table', where: { file: 'm/definition/tables/G%2FL Accounts.tmdl', table: 'G/L Accounts' } })]);
  });

  it('a role whose table permission does not read is left out whole, and named', () => {
    const r = readOk([good('T'), { path: 'm/definition/roles/R.tmdl', text: "role Readers\n\ttablePermission 'T = [Id] > 0\n" }]);
    expect(problems(r.model.ledger ?? [])).toEqual([expect.objectContaining({ unit: 'object', what: 'TMDL role with no closing quote', where: expect.objectContaining({ line: 2, table: 'Readers' }) })]);
    expect((r.model.features ?? []).filter((f) => f.kind === 'role')).toEqual([]);
  });

  it('only broken files: nothing to draw, so the import fails with every problem', () => {
    const r = readSemanticModel([{ path: 'm/definition/tables/A.tmdl', text: "table 'A\n" }, { path: 'm/definition/tables/B.tmdl', text: 'x\u0000' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems.map((p) => p.file).sort()).toEqual(['m/definition/tables/A.tmdl', 'm/definition/tables/B.tmdl']);
  });
});

// ---------------------------------------------------------------------------
// Tabular Editor Save to Folder
// ---------------------------------------------------------------------------

const db = (model: Record<string, unknown> = {}): string => JSON.stringify({ name: 'Shop', compatibilityLevel: 1604, model: { culture: 'en-US', ...model } }, null, 2);
const json = (v: unknown): string => JSON.stringify(v, null, 2);
const col = (name: string, extra: Record<string, unknown> = {}): string => json({ name, dataType: 'int64', sourceColumn: name, ...extra });

describe('Save to Folder: finding it', () => {
  it('finds database.json with tables/<T>/*.json beside it, its .json files only; ignores a lone database.json and a .bim inside it', () => {
    const entries = findSemanticModels([
      'repo/models/Shop/database.json',
      'repo/models/Shop/tables/Sales/Sales.json',
      'repo/models/Shop/tables/Sales/columns/Id.json',
      'repo/models/Shop/relationships/r1.json',
      'repo/models/Shop/old.bim',
      'repo/app/database.json',
      'repo/app/config.json',
    ]);
    expect(entries).toEqual([{
      name: 'Shop', kind: 'folder', root: 'repo/models/Shop',
      files: ['repo/models/Shop/database.json', 'repo/models/Shop/tables/Sales/Sales.json', 'repo/models/Shop/tables/Sales/columns/Id.json', 'repo/models/Shop/relationships/r1.json'],
    }]);
  });

  it('the command\'s walk lists the real sample\'s every JSON file, and only model files elsewhere', async () => {
    const folder = path.join(REAL, 'powerbi-folder-spaceparts');
    const readDir = async (d: string): Promise<Array<readonly [string, boolean]>> => fs.readdirSync(d, { withFileTypes: true }).map((e) => [e.name, e.isDirectory()] as const);
    const walk = await walkSemanticModelFiles(folder, readDir);
    expect(walk.truncated).toBe(false);
    expect(walk.files).toHaveLength(454);
    expect(walk.files.every((f) => f.endsWith('.json'))).toBe(true);
  });
});

describe('Save to Folder: reading', () => {
  const files = (): SemanticModelFile[] => [
    { path: 'Shop/database.json', text: db() },
    { path: "Shop/tables/Customer's Orders/Customer's Orders.json", text: json({ name: "Customer's Orders", annotations: [{ name: 'TabularEditor_Relationships', value: json([{ name: 'r1', fromTable: "Customer's Orders", fromColumn: 'Store Id', toTable: 'Store Front', toColumn: 'Id', relyOnReferentialIntegrity: true, securityFilteringBehavior: 'bothDirections' }]).split('\n') }] }) },
    { path: "Shop/tables/Customer's Orders/columns/Id.json", text: col('Id', { isKey: true }) },
    { path: "Shop/tables/Customer's Orders/columns/Store Id.json", text: col('Store Id') },
    { path: 'Shop/tables/Store Front/Store Front.json', text: json({ name: 'Store Front', description: ['Every store', 'we run'] }) },
    { path: 'Shop/tables/Store Front/columns/Id.json', text: col('Id') },
    { path: 'Shop/relationships/r2.json', text: json({ name: 'r2', fromTable: 'Store Front', fromColumn: 'Id', toTable: "Customer's Orders", toColumn: 'Id', crossFilteringBehavior: 'bothDirections', fromCardinality: 'one', toCardinality: 'one' }) },
  ];

  it('puts the files back together: tables, columns, descriptions, relationships from a table\'s annotation and from relationships/', () => {
    const r = readOk(files());
    expect(r.model.kind).toBe('folder');
    expect(r.model.name).toBe('Shop');
    expect(r.model.tables.map((t) => [t.name, t.columns.map((c) => c.name)])).toEqual([["Customer's Orders", ['Id', 'Store Id']], ['Store Front', ['Id']]]);
    expect(r.model.tables[1].description).toBe('Every store\nwe run');
    expect(r.model.relationships.map((x) => [x.name, x.file, x.line])).toEqual([
      ['r2', 'Shop/relationships/r2.json', 1],
      // The annotation is split one string per line: the relationship's `{` is on line 8 of the table's file.
      ['r1', "Shop/tables/Customer's Orders/Customer's Orders.json", 8],
    ]);
    const tableFile = files()[1].text.split('\n');
    expect(tableFile[8 - 1]).toMatch(/"\s*\{",?$/);
    expect(tableFile[8]).toContain('"name\\": \\"r1\\"');
  });

  it('names relationship settings a diagram has no place for, on the relationship\'s line', () => {
    const converted = semanticModelToDbml(readOk(files()).model);
    const lost = converted.ledger.filter((e) => e.outcome === 'lost' && e.unit === 'setting').map((e) => [e.what, e.where?.table, e.where?.line]);
    expect(lost).toEqual(expect.arrayContaining([
      ['assume referential integrity', "Customer's Orders", 8],
      ['security filter direction', "Customer's Orders", 8],
      ['cross-filter direction', 'Store Front', 1],
    ]));
    expect(ledgerLeftOut(converted.ledger).join('\n')).toMatch(/assume referential integrity not kept/);
  });

  it('one file that does not read never fails the model: a column, a table (its own files counted), database.json', () => {
    const broken = files();
    broken[3] = { ...broken[3], text: '{\n  "name": "Store Id",\n  "dataType": int64\n}' };
    broken[4] = { ...broken[4], text: '{ "name": ' };
    broken[0] = { ...broken[0], text: '{\n  "name": "Shop",\n,\n}' };
    broken.push({ path: 'Shop/notes/readme.json', text: '{}' }, { path: 'Shop/tables/Store Front/extra/x.json', text: '{}' });
    const r = readOk(broken);
    expect(r.model.tables.map((t) => [t.name, t.columns.map((c) => c.name)])).toEqual([["Customer's Orders", ['Id']]]);
    expect(r.model.name).toBe('Shop');
    const ledger = r.model.ledger ?? [];
    expect(problems(ledger).map((e) => [e.unit, e.what, e.where?.file, e.where?.line, e.where?.table, e.where?.column, e.count])).toEqual(expect.arrayContaining([
      ['file', 'database.json that does not parse', 'Shop/database.json', 3, undefined, undefined, 1],
      ['column', 'column file that does not parse', "Shop/tables/Customer's Orders/columns/Store Id.json", 3, "Customer's Orders", 'Store Id', 1],
      ['table', 'table file that does not parse', 'Shop/tables/Store Front/Store Front.json', 1, 'Store Front', undefined, 1],
      ['column', 'column file of a table that did not read', undefined, undefined, 'Store Front', undefined, 1],
    ]));
    expect(ledger.filter((e) => e.outcome === 'skipped' && e.unit === 'file').map((e) => e.where?.file).sort()).toEqual(['Shop/notes/readme.json', 'Shop/tables/Store Front/extra/x.json']);
    // The relationship into the table that did not read is skipped and counted; the one in relationships/ too.
    const converted = semanticModelToDbml(r.model);
    expect(converted.refCount).toBe(0);
    expect(count(converted.ledger, (e) => e.outcome === 'skipped' && e.unit === 'relationship')).toBe(2);
  });

  it('local perspectives and translations are named, counted per culture', () => {
    const base = files();
    base[0] = { path: 'Shop/database.json', text: db({ annotations: [{ name: 'TabularEditor_Perspectives', value: json([{ Name: 'Finance' }, { Name: 'Ops' }]) }] }) };
    base[4] = { ...base[4], text: json({ name: 'Store Front', annotations: [{ name: 'TabularEditor_TranslatedNames', value: json({ 'fr-FR': 'Magasin', 'de-DE': 'Laden' }) }] }) };
    base.push({ path: 'Shop/cultures/fr-FR.json', text: json({ name: 'fr-FR' }) });
    const model = readOk(base).model;
    const features = (model.features ?? []).map((f) => [f.kind, f.name, f.count ?? 1]);
    expect(features).toEqual(expect.arrayContaining([['perspective', 'Finance', 1], ['perspective', 'Ops', 1], ['translation', 'fr-FR', 1], ['translation', 'de-DE', 1]]));
  });

  it('readFolderModel never throws on junk', () => {
    expect(() => readFolderModel([{ path: 'database.json', text: '[]' }, { path: 'tables/X/X.json', text: '' }, { path: 'tables/X/columns/c.json', text: 'null' }])).not.toThrow();
  });
});

describe('Save to Folder: the real SpaceParts sample', () => {
  const model = readOk(filesUnder(path.join(REAL, 'powerbi-folder-spaceparts', 'SpacePartsSaveToFolder'))).model;

  it('reads every table and relationship, each relationship with the line of its table file it is written on', () => {
    expect(model.tables).toHaveLength(36);
    expect(model.relationships).toHaveLength(27);
    for (const r of model.relationships) {
      expect(r.file, r.name).toMatch(new RegExp(`^SpacePartsSaveToFolder/tables/[^/]+/[^/]+\\.json$`));
      const lines = fs.readFileSync(path.join(REAL, 'powerbi-folder-spaceparts', r.file!), 'utf-8').split('\n');
      expect(lines[r.line! - 1].trim(), r.name).toBe('"  {",');
      expect(lines[r.line!], r.name).toContain(r.name!);
    }
  });

  it('names a column setting with its own file and line', () => {
    const converted = semanticModelToDbml(model);
    const setting = converted.ledger.find((e) => e.what === 'displayFolder' && e.where?.table === 'Customers' && e.where.column === 'Customer Key')!;
    expect(setting.where).toMatchObject({ file: 'SpacePartsSaveToFolder/tables/Customers/columns/Customer Key.json', line: 6 });
  });
});

// ---------------------------------------------------------------------------
// TMSL line numbers
// ---------------------------------------------------------------------------

describe('TMSL: ledger entries carry their model.bim line', () => {
  const bim = JSON.stringify({
    name: 'Shop',
    model: {
      tables: [
        { name: 'Sales', columns: [{ name: 'Id', dataType: 'int64', formatString: '0' }, { name: 'Margin', dataType: 'double', type: 'calculated', expression: '1' }], hierarchies: [{ name: 'H', levels: [] }] },
        { name: 'Store', columns: [{ name: 'Id', dataType: 'int64' }] },
      ],
      relationships: [{ name: 'r', fromTable: 'Sales', fromColumn: 'Id', toTable: 'Store', toColumn: 'Id', relyOnReferentialIntegrity: true, securityFilteringBehavior: 'none' }],
      roles: [{ name: 'Readers', tablePermissions: [{ name: 'Sales', filterExpression: 'TRUE()' }] }],
    },
  }, null, 2);
  const lines = bim.split('\n');
  const converted = semanticModelToDbml(readOk([{ path: 'Shop.SemanticModel/model.bim', text: bim }]).model);
  const at = (what: string): LedgerEntry => converted.ledger.find((e) => e.what === what)!;

  it.each([
    ['hierarchy', '"name": "H"'],
    ['security role', '"name": "Readers"'],
    ['DAX expression', '"name": "Margin"'],
    ['assume referential integrity', '"name": "r"'],
    ['security filter direction', '"name": "r"'],
  ])('%s: the line of its object', (what, next) => {
    const e = at(what);
    expect(e.where?.file).toBe('Shop.SemanticModel/model.bim');
    expect(lines[e.where!.line! - 1].trim()).toMatch(/^\{$/);
    expect(lines[e.where!.line!]).toContain(next);
  });

  it('a report setting: the line of the property itself', () => {
    expect(lines[at('formatString').where!.line! - 1]).toContain('"formatString": "0"');
  });

  it('a row filter: the line of its filterExpression', () => {
    expect(lines[at('row filter').where!.line! - 1]).toContain('"filterExpression"');
  });
});

// ---------------------------------------------------------------------------
// Power Query merges and appends
// ---------------------------------------------------------------------------

describe('Power Query: every source of a merge or an append', () => {
  it('a merge of two navigations from one connection, with comments and quoted step names', () => {
    const m = [
      'let',
      '    // the warehouse',
      '    Source = Sql.Database("srv", "dw"),',
      '    Orders = Source{[Schema="sales",Item="Orders"]}[Data],',
      '    #"Customers (all)" = Source{[Schema="crm",Item="Customer"]}[Data],',
      '    /* join them */ Merged = Table.NestedJoin(Orders, {"CustomerId"}, #"Customers (all)", {"Id"}, "C", JoinKind.LeftOuter),',
      '    Expanded = Table.ExpandTableColumn(Merged, "C", {"Name"})',
      'in',
      '    Expanded',
    ].join('\n');
    expect(mCombinedSources(m)).toEqual({ kind: 'merge', inputs: ['sales.Orders', 'crm.Customer'] });
  });

  it('an append of other queries and tables, by name; a shared query that navigates, by its warehouse table', () => {
    const queries = new Map([['Archive', 'let S = Sql.Database("s","d"), T = S{[Schema="old",Item="Sales2019"]}[Data] in T'], ['Server', '"srv" meta [IsParameterQuery=true]']]);
    const m = 'let\n  Combined = Table.Combine({#"Sales 2024", Archive, Sales2023})\nin\n  Combined';
    expect(mCombinedSources(m, queries, new Set(['Sales 2024', 'Sales2023']))).toEqual({ kind: 'append', inputs: ['Sales 2024', 'old.Sales2019', 'Sales2023'] });
  });

  it('merges and appends nested in each other, Table.Join with an inline navigation, a list built at run time, and a query with no let', () => {
    const m = [
      'let',
      '  Source = Snowflake.Databases("acct"),',
      '  Db = Source{[Name="DW",Kind="Database"]}[Data],',
      '  A = Table.Combine({Jan, Feb}),',
      '  J = Table.Join(A, "k", Db{[Name="PUBLIC",Kind="Schema"]}[Data]{[Name="DIM",Kind="Table"]}[Data], "k"),',
      '  F = Table.Combine(Folder.Files("c:\\\\x")[Content])',
      'in',
      '  J',
    ].join('\n');
    expect(mCombinedSources(m, new Map(), new Set(['Jan', 'Feb']))).toEqual({ kind: 'merge and append', inputs: ['Jan', 'Feb', 'PUBLIC.DIM', 'tables listed at run time'] });
    expect(mCombinedSources('Table.Combine({A, B})', new Map(), new Set(['A', 'B']))).toEqual({ kind: 'append', inputs: ['A', 'B'] });
    expect(mCombinedSources('let S = Sql.Database("a","b"), T = S{[Schema="dbo",Item="X"]}[Data] in T')).toBeUndefined();
  });

  it('strings, comments and quoted names never read as calls or steps', () => {
    expect(mCombineCalls('Text.Combine({"Table.Combine({a,b})"}) // Table.NestedJoin(x, y, z, w)')).toEqual([]);
    expect(parseMLet('let\n  #"a, b = c" = 1,\n  // x = 2\n  y = "in"\nin\n  y').steps.map((s) => s.name)).toEqual(['a, b = c', 'y']);
    expect(parseMLet('let f = (x) => let y = x in y, z = f(1) in z').steps.map((s) => s.name)).toEqual(['f', 'z']);
    expect(mName('#"Merged ""Queries"""')).toBe('Merged "Queries"');
  });

  it('the real Purchase app: Type appends three tables, Purchase Value Entries merges a shared query; kept as power_bi_sources and in the ledger', () => {
    const model = readOk(filesUnder(path.join(REAL, 'powerbi-tmdl-bc-purchase', 'Purchase app.SemanticModel'))).model;
    const source = (t: string) => model.tables.find((x) => x.name === t)!.source;
    expect(source('Type')?.combined).toEqual({ kind: 'append', inputs: ['Item', 'Resources', 'G/L Accounts'] });
    expect(source('Purchase Value Entries')?.combined).toEqual({ kind: 'merge', inputs: ['its own rows', 'Capacity Ledger Entries'] });
    expect(source('Documents')?.combined).toEqual({ kind: 'append', inputs: ['Purchase Lines', 'Purchase Value Entries', 'Purchase Invoice Lines', 'Purchase Credit Lines'] });
    const converted = semanticModelToDbml(model);
    const type = plan(converted.dbml).newTables.find((t) => t.name === 'type')!;
    expect(type.meta?.[SEMANTIC_MODEL_META.sources]).toBe('Item, Resources, G/L Accounts');
    expect(converted.ledger).toContainEqual(expect.objectContaining({
      outcome: 'changed', what: 'Power Query append',
      where: expect.objectContaining({ file: 'Purchase app.SemanticModel/definition/tables/Type.tmdl', table: 'Type', line: expect.any(Number) }),
      detail: 'reads Item, Resources and G/L Accounts; all kept as power_bi_sources',
    }));
    expect(ledgerNotes(converted.ledger).join('\n')).toMatch(/Power Query merge reads its own rows and Capacity Ledger Entries/);
  });
});

// ---------------------------------------------------------------------------
// JSON with lines
// ---------------------------------------------------------------------------

describe('parseJsonWithLines', () => {
  it('gives what JSON.parse gives: escapes, numbers, repeated keys, __proto__', () => {
    const text = '{\n "a": "x\\u00e9\\n\\"q\\"\\ud83d\\ude00",\n "n": [-1.5e3, 0, 12],\n "a2": {"k": 1, "k": 2},\n "__proto__": {"p": true},\n "z": null, "t": true, "f": false\n}';
    const { value } = parseJsonWithLines(text);
    expect(value).toEqual(JSON.parse(text));
    expect(Object.keys(value as object)).toEqual(Object.keys(JSON.parse(text) as object));
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('knows the line of each object, array and key, across LF, CRLF and CR', () => {
    for (const eol of ['\n', '\r\n', '\r']) {
      const text = ['{', '  "tables": [', '    {', '      "name": "A"', '    }', '  ]', '}'].join(eol);
      const { value, lines } = parseJsonWithLines(text);
      const tables = (value as { tables: object[] }).tables;
      expect(lines.lineOf(value)).toBe(1);
      expect(lines.lineOf(tables)).toBe(2);
      expect(lines.lineOf(tables[0])).toBe(3);
      expect(lines.keyLine(tables[0], 'name')).toBe(4);
    }
  });

  it('throws what JSON.parse throws on bad JSON, and reads (without lines inside it) what is nested too deep to follow', () => {
    for (const bad of ['{"a": 01}', '{"a": }', '[1,]', '{"a": "x\u0001"}', '']) {
      let mine = '';
      let theirs = '';
      try { parseJsonWithLines(bad); } catch (e) { mine = String(e); }
      try { JSON.parse(bad); } catch (e) { theirs = String(e); }
      expect(mine, bad).toBe(theirs);
    }
    const deep = `${'['.repeat(MAX_JSON_DEPTH + 10)}1${']'.repeat(MAX_JSON_DEPTH + 10)}`;
    const r = parseJsonWithLines(deep);
    expect(JSON.stringify(r.value)).toBe(deep);
    // Lines are kept down to the depth followed; inside the deeper value, none.
    expect(r.lines.lineOf(r.value)).toBe(1);
    let inner: unknown = r.value;
    for (let d = 0; d < MAX_JSON_DEPTH + 5; d++) inner = (inner as unknown[])[0];
    expect(r.lines.lineOf(inner)).toBeUndefined();
  });
});
