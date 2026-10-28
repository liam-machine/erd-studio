/**
 * Native DBML storage, S6 (§5.7, §9.6 "Lifecycle"): the create paths in a
 * project that writes DBML, below the commands — the New Subject Area
 * writer (with its settle pass and a rollback for every write kind), the
 * lifecycle planners (`src/commands/dbmlLifecycle.ts`), Draw from dbt's and
 * Import DBML's DBML refusals, sync plans' new-table paths and the Export
 * refusal inside the semantic dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { compileDbmlProject, parseSubjectAreaDbml } from '@erd-studio/core/dbml';
import { LayerService } from '../../src/services/layerService';
import { SubjectAreaService, subjectAreaTableNames } from '../../src/services/domainService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { writeNewSubjectArea } from '../../src/services/newSubjectAreaWriter';
import type { FileWriteIo } from '../../src/services/fsFileWrites';
import { buildDbtDraft } from '../../src/services/dbtDraft';
import { firstUseDeclarationLine, readDbml, IMPORT_MULTI_FILE_MESSAGE } from '../../src/services/dbmlImportParse';
import { dbmlImportRefusal } from '../../src/commands/importDbml';
import { newDbmlSubjectAreaText, planDbmlDuplicateRename, planDbmlSubjectAreaRename, planDbmlTableMoves, currentDbmlResolver } from '../../src/commands/dbmlLifecycle';
import { exportDiagramCommand, exportInsideSemanticDirMessage, type ExportDiagramUi } from '../../src/commands/exportDiagram';
import { exportAllDiagramsCommand, type ExportAllDiagramsUi } from '../../src/commands/exportAllDiagrams';
import { allSelections, buildSyncPlan } from '../../src/services/syncPlanBuilder';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { SemanticTable } from '../../src/types/semantic';
import { RESERVED_TABLE_NAME_MESSAGE } from '../../src/types/naming';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-lifecycle-dbml-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const erd = (...p: string[]): string => path.join(tmp, '.erd-studio', ...p);

/** Every file under the semantic dir, posix, with its bytes. */
function snapshot(): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(erd())) return out;
  for (const f of fs.readdirSync(erd(), { recursive: true }) as string[]) {
    const full = erd(f);
    if (fs.statSync(full).isFile()) out.set(f.split(path.sep).join('/'), fs.readFileSync(full, 'utf-8'));
  }
  return out;
}

function services(): { layerService: LayerService; subjectAreaService: SubjectAreaService; tableLibraryService: TableLibraryService } {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

function copyNative(): void {
  fs.cpSync(DBML_NATIVE, tmp, { recursive: true });
}

const col = (name: string, extra: Record<string, unknown> = {}) => ({ name, dataType: 'INT', description: '', ...extra });
const ORDERS: SemanticTable = {
  name: 'orders',
  columns: [col('order_id', { isPrimaryKey: true }), col('customer_id')],
  relationships: [{ fromColumn: 'customer_id', toModel: 'customers', toColumn: 'customer_id', cardinality: 'many-to-one' }],
} as SemanticTable;
const CUSTOMERS: SemanticTable = { name: 'customers', columns: [col('customer_id', { isPrimaryKey: true })] } as SemanticTable;

describe('the default switch-over (§3.2)', () => {
  it('a new, empty project writes DBML: pathForNewTable, saveTable and newTableLibraryDirName', () => {
    const { tableLibraryService: lib } = services();
    expect(lib.projectStorage()).toBe('dbml');
    expect(lib.writesDbml()).toBe(true);
    expect(lib.pathForNewTable('dim_x', 'gold')).toBe(erd('tables', 'gold', 'dim_x.dbml'));
    expect(lib.newTableLibraryDirName()).toBe('tables');
    lib.saveTable({ name: 'dim_x', columns: [col('id', { isPrimaryKey: true })] } as SemanticTable, 'gold');
    expect(fs.existsSync(erd('tables', 'gold', 'dim_x.dbml'))).toBe(true);
    expect(fs.existsSync(erd('logical-models'))).toBe(false);
  });

  it('a YAML project keeps writing YAML, and an existing table keeps its format in a mixed one', () => {
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    const { tableLibraryService: lib } = services();
    expect(lib.projectStorage()).toBe('yaml');
    lib.saveTable(CUSTOMERS);
    expect(fs.existsSync(erd('logical-models', 'customers.yml'))).toBe(true);
    // A DBML table beside it makes the project mixed: new files are DBML, the YAML one stays YAML.
    fs.mkdirSync(erd('tables'), { recursive: true });
    fs.writeFileSync(erd('tables', 'dim_y.dbml'), 'Table dim_y {\n  id INT [pk]\n}\n');
    lib.invalidateCache();
    expect(lib.projectStorage()).toBe('mixed');
    lib.saveTable({ ...CUSTOMERS, description: 'People' });
    expect(fs.readFileSync(erd('logical-models', 'customers.yml'), 'utf-8')).toContain('People');
    expect(lib.pathForNewTable('dim_z')).toBe(erd('tables', 'dim_z.dbml'));
  });
});

describe('writeNewSubjectArea for a .dbml diagram (§5.7)', () => {
  const layouted = (): Record<string, unknown> => ({
    domain: 'shop', layer: 'silver', description: 'Shop', logical: { models: ['orders', 'customers'], relationships: [] },
    viewConfig: { positions: { orders: { x: 10, y: 20 }, customers: { x: 300, y: 20 } }, annotations: [] },
  });

  it('writes the tables, the relationships file, the diagram and its layout, all of which compile', async () => {
    const s = services();
    const domainPath = erd('silver', 'shop.dbml');
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath, newTables: [ORDERS, CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => { throw new Error('not JSON'); },
      document: layouted,
    }, s);
    expect(result).toEqual({ ok: true, written: ['orders', 'customers'], changed: [] });
    expect([...snapshot().keys()].sort()).toEqual([
      'layers.json', 'silver/shop.dbdiagram', 'silver/shop.dbml',
      'tables/silver/_relationships.dbml', 'tables/silver/customers.dbml', 'tables/silver/orders.dbml',
    ]);
    const text = fs.readFileSync(domainPath, 'utf-8');
    expect(subjectAreaTableNames(text, domainPath)).toEqual(['orders', 'customers']);
    expect(text).toContain("use * from '../tables/silver/_relationships.dbml'");
    const diagnostics = compileDbmlProject(Object.fromEntries([...snapshot()].filter(([p]) => p.endsWith('.dbml'))), ['silver/shop.dbml']);
    expect(Object.values(diagnostics).flat()).toEqual([]);
    // The canvas reads it back with its positions and the relationship from the library.
    s.tableLibraryService.invalidateCache();
    const area = s.subjectAreaService.getSubjectArea(domainPath);
    expect(area.logical.models.map((m) => m.name)).toEqual(['orders', 'customers']);
    expect(area.viewConfig.positions?.orders).toEqual({ x: 10, y: 20 });
  });

  it('settles another DBML diagram whose member\'s folder gains a relationships file', async () => {
    const s = services();
    // A first diagram with one table and no relationship yet: no relationships file.
    await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'one.dbml'), newTables: [CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'one', logical: { models: ['customers'] }, viewConfig: {} }),
    }, s);
    expect(fs.readFileSync(erd('silver', 'one.dbml'), 'utf-8')).not.toContain('_relationships');
    s.tableLibraryService.invalidateCache();
    // The second creates tables/silver/_relationships.dbml: the first now imports it too.
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'two.dbml'), newTables: [ORDERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'two', logical: { models: ['orders', 'customers'] }, viewConfig: {} }),
    }, s);
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(erd('silver', 'one.dbml'), 'utf-8')).toContain("use * from '../tables/silver/_relationships.dbml'");
  });

  /** An io that fails on the `n`-th rename (the atomic write's last step). */
  function failingIo(n: number): FileWriteIo {
    let renames = 0;
    return {
      readFile: (p) => fs.readFileSync(p),
      writeFile: (p, d) => fs.writeFileSync(p, d),
      rename: (from, to) => {
        renames++;
        if (renames === n) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC', path: to });
        fs.renameSync(from, to);
      },
      unlink: (p) => fs.unlinkSync(p),
      exists: (p) => fs.existsSync(p),
      mkdir: (p) => fs.mkdirSync(p),
      rmdir: (p) => fs.rmdirSync(p),
    };
  }

  it('a failure at any write puts every file back: table, relationships file, diagram, layout, other diagrams (rollback of every write kind)', async () => {
    // A project with a diagram that the new one settles, and a relationships file the new one changes.
    const seed = services();
    await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'one.dbml'), newTables: [CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'one', logical: { models: ['customers'] }, viewConfig: {} }),
    }, seed);
    const before = snapshot();
    // Creates: relationships file, two tables (one new, the orders table), diagram, layout; replaces: one.dbml (settle).
    for (let n = 1; n <= 5; n++) {
      const s = services();
      const result = await writeNewSubjectArea({
        workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'shop.dbml'), newTables: [ORDERS], folder: 'silver', changedTables: [],
        documentText: () => '', document: layouted,
      }, { ...s, io: failingIo(n) });
      expect(result.ok, `failure at write ${n}`).toBe(false);
      if (!result.ok) expect(result.undone).toBe(true);
      expect(snapshot(), `failure at write ${n}`).toEqual(before);
    }
    // And with no failure, every kind was written.
    const s = services();
    const ok = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'shop.dbml'), newTables: [ORDERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: layouted,
    }, s);
    expect(ok.ok).toBe(true);
    const after = snapshot();
    expect(after.get('silver/one.dbml')).not.toBe(before.get('silver/one.dbml'));
    for (const p of ['silver/shop.dbml', 'silver/shop.dbdiagram', 'tables/silver/orders.dbml', 'tables/silver/_relationships.dbml']) expect(after.has(p), p).toBe(true);
  });

  it('a project with no ERD folder: a failed write removes the folder and its layers.json', async () => {
    const s = services();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'shop.dbml'), newTables: [ORDERS, CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: layouted,
    }, { ...s, io: failingIo(2) });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(erd())).toBe(false);
  });

  it('the diagram name taken since it was checked is nameTaken, and nothing else is written', async () => {
    const s = services();
    fs.mkdirSync(erd('silver'), { recursive: true });
    fs.writeFileSync(erd('layers.json'), fs.readFileSync(path.join(DBML_NATIVE, '.erd-studio', 'layers.json')));
    fs.writeFileSync(erd('silver', 'shop.dbml'), 'Project shop {\n}\n');
    const before = snapshot();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'shop.dbml'), newTables: [CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'shop', logical: { models: ['customers'] }, viewConfig: {} }),
    }, s);
    expect(result).toMatchObject({ ok: false, nameTaken: true, undone: true });
    expect(snapshot()).toEqual(before);
  });

  it('a YAML table cannot join a DBML diagram (D20): refused before any write', async () => {
    fs.mkdirSync(erd('tables'), { recursive: true });
    fs.writeFileSync(erd('tables', 'dim_y.dbml'), 'Table dim_y {\n  id INT [pk]\n}\n');
    fs.writeFileSync(erd('tables', 'customers.yml'), 'name: customers\ncolumns:\n  - name: customer_id\n    dataType: INT\n    description: ""\n');
    const s = services();
    const before = snapshot();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'shop.dbml'), newTables: [], changedTables: [],
      documentText: () => '', document: () => ({ domain: 'shop', logical: { models: ['customers'] }, viewConfig: {} }),
    }, s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String((result.error as Error).message)).toContain('Convert the project to DBML first');
    expect(snapshot()).toEqual(before);
  });
});

describe('Draw from dbt and Import DBML in a DBML project (§5.7)', () => {
  it('Draw skips a library table stored as YAML and a new table named _relationships, with their reasons', () => {
    const draft = buildDbtDraft({
      modelNames: ['dim_yaml', '_relationships', 'fct_new'],
      libraryHas: (n) => n === 'dim_yaml',
      seed: (n) => ({ name: n, columns: [col('id')] } as SemanticTable),
      dbml: { tableStorage: (n) => (n === 'dim_yaml' ? 'yaml' : undefined) },
    });
    expect(draft.modelNames).toEqual(['fct_new']);
    expect(draft.skipped).toEqual([{ name: 'dim_yaml', reason: 'yaml-table' }, { name: '_relationships', reason: 'reserved-name' }]);
    // Outside DBML both are drawn as before.
    const plain = buildDbtDraft({ modelNames: ['dim_yaml', 'fct_new'], libraryHas: (n) => n === 'dim_yaml', seed: (n) => ({ name: n, columns: [col('id')] } as SemanticTable) });
    expect(plain.modelNames).toEqual(['dim_yaml', 'fct_new']);
  });

  it('Import refuses a file with use lines (a multi-file project), naming the export route', () => {
    const text = "// a comment: use * from 'x'\nuse { table a } from './a.dbml'\nTable b {\n  id int\n}\n";
    expect(firstUseDeclarationLine(text)).toBe(2);
    const read = readDbml(text);
    expect(read).toMatchObject({ ok: false, importsOtherFiles: true });
    if (!read.ok) expect(read.diagnostics[0].message).toBe(IMPORT_MULTI_FILE_MESSAGE);
    expect(IMPORT_MULTI_FILE_MESSAGE).toContain('Export Diagram… → DBML (rich)');
    // `use` inside a string, a Note or a block comment is not a declaration.
    expect(firstUseDeclarationLine("Table t [note: 'use * from x'] {\n  id int\n}\n/*\nuse x\n*/\nNote n {\n'''\nuse x\n'''\n}\n")).toBeUndefined();
    expect(firstUseDeclarationLine('Table user_use {\n  use_count int\n}\n')).toBeUndefined();
  });

  it('Import into a DBML project refuses to reuse a YAML table, and refuses a new table named _relationships', () => {
    const plan = { reusedTables: ['dim_yaml'], newTables: [] } as unknown as Parameters<typeof dbmlImportRefusal>[0];
    expect(dbmlImportRefusal(plan, () => 'yaml')).toContain("a YAML table can't join a DBML diagram. Convert the project to DBML first");
    expect(dbmlImportRefusal({ reusedTables: ['x'], newTables: [] } as never, () => 'dbml')).toBeUndefined();
    expect(dbmlImportRefusal({ reusedTables: [], newTables: [{ name: '_Relationships' }] } as never, () => undefined)).toBe(RESERVED_TABLE_NAME_MESSAGE);
  });
});

describe('the lifecycle planners (src/commands/dbmlLifecycle.ts)', () => {
  it('New Diagram: a Project with its Note and keys and no members, that reads back', () => {
    const filePath = erd('gold', 'orders.dbml');
    const text = newDbmlSubjectAreaText({ semanticRoot: erd(), filePath, domain: 'orders', description: 'Orders', modelFolder: 'marts' });
    const obj = parseSubjectAreaDbml(text, 'gold/orders.dbml', null).obj;
    expect(obj).toMatchObject({ domain: 'orders', layer: 'gold', description: 'Orders', modelFolder: 'marts', logical: { models: [] } });
  });

  it('Rename Subject Area: the Project name spliced, the use lines and the layout kept byte for byte', () => {
    copyNative();
    const { tableLibraryService } = services();
    const oldPath = erd('gold', 'sales.dbml');
    const text = fs.readFileSync(oldPath, 'utf-8');
    const layoutText = fs.readFileSync(erd('gold', 'sales.dbdiagram'), 'utf-8');
    const writes = planDbmlSubjectAreaRename({
      semanticRoot: erd(), oldPath, newPath: erd('gold', 'revenue.dbml'), newSlug: 'revenue', text, layoutText,
      resolver: currentDbmlResolver(tableLibraryService).resolver,
    });
    expect(writes.map((w) => `${w.kind} ${path.relative(erd(), w.path)}`)).toEqual([
      'create gold/revenue.dbml', 'delete gold/sales.dbml', 'create gold/revenue.dbdiagram', 'delete gold/sales.dbdiagram',
    ]);
    const created = writes[0] as { text: string };
    expect(created.text).toBe(text.replace('Project sales {', 'Project revenue {'));
    expect((writes[2] as { text: string }).text).toBe(layoutText);
  });

  it('Organise: a top-level .dbml table moves into its layer\'s folder with its Refs and every use line', () => {
    copyNative();
    // dim_only_gold is used by the gold diagram only, and owns a Ref.
    fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n  date_key INT\n}\n');
    fs.appendFileSync(erd('tables', '_relationships.dbml'), "use { table dim_only_gold } from './dim_only_gold.dbml'\nRef: dim_only_gold.date_key >? dim_date.date_key\n");
    const sales = erd('gold', 'sales.dbml');
    fs.writeFileSync(sales, fs.readFileSync(sales, 'utf-8').replace("use * from '../tables/_relationships.dbml'", "use { table dim_only_gold } from '../tables/dim_only_gold.dbml'\nuse * from '../tables/_relationships.dbml'"));
    const { tableLibraryService, subjectAreaService } = services();
    const readText = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
    const diagrams = subjectAreaService.listSubjectAreas(tmp, '.erd-studio').filter((d) => d.storage === 'dbml').map((d) => d.filePath);
    const writes = planDbmlTableMoves({ tableLibraryService, moves: [{ name: 'dim_only_gold', toFolder: 'gold' }], diagrams, readText });
    const byPath = new Map(writes.map((w) => [path.relative(erd(), w.path).split(path.sep).join('/'), w]));
    expect(byPath.get('tables/dim_only_gold.dbml')?.kind).toBe('delete');
    expect(byPath.get('tables/gold/dim_only_gold.dbml')?.kind).toBe('create');
    const goldRels = byPath.get('tables/gold/_relationships.dbml') as { text: string };
    expect(goldRels.text).toContain('dim_only_gold.date_key');
    expect((byPath.get('tables/_relationships.dbml') as { text: string }).text).not.toContain('dim_only_gold');
    expect((byPath.get('gold/sales.dbml') as { text: string }).text).toContain("use { table dim_only_gold } from '../tables/gold/dim_only_gold.dbml'");
    // Applied, the project compiles from the diagram.
    for (const w of writes) {
      if (w.kind === 'delete') fs.rmSync(w.path);
      else { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.text); }
    }
    const files = Object.fromEntries([...snapshot()].filter(([p]) => p.endsWith('.dbml')));
    expect(Object.values(compileDbmlProject(files, ['gold/sales.dbml', 'silver/staging.dbml'])).flat()).toEqual([]);
  });

  it('Give Duplicate Its Own Name: the .dbml copy is renamed with its alias, and only the diagram that uses the copy is repointed', () => {
    copyNative();
    // A second dim_date in tables/gold/: the top-level one wins (§3.4), the gold one is the ignored copy.
    fs.writeFileSync(erd('tables', 'gold', 'dim_date.dbml'), 'Table dim_date {\n  date_key INT [pk]\n}\n');
    const { tableLibraryService, subjectAreaService } = services();
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'dim_date')!;
    expect(path.relative(erd(), entry.filePath)).toBe(path.join('tables', 'gold', 'dim_date.dbml'));
    // The silver diagram uses the copy by its path.
    const staging = erd('silver', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("from '../tables/dim_date.dbml'", "from '../tables/gold/dim_date.dbml'"));
    const readText = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
    const diagrams = subjectAreaService.listSubjectAreas(tmp, '.erd-studio').filter((d) => d.storage === 'dbml').map((d) => d.filePath);
    const planned = planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'dim_date' }, newName: 'gold_dim_date', alias: 'dim_date', diagrams, readText,
    });
    expect(planned.repointed).toEqual([staging]);
    const byPath = new Map(planned.writes.map((w) => [path.relative(erd(), w.path).split(path.sep).join('/'), w]));
    expect(byPath.get('tables/gold/dim_date.dbml')?.kind).toBe('delete');
    const created = byPath.get('tables/gold/gold_dim_date.dbml') as { text: string };
    expect(created.text).toMatch(/^Table gold_dim_date \[alias: 'dim_date'\]/m);
    const stagingText = (byPath.get('silver/staging.dbml') as { text: string }).text;
    expect(stagingText).toContain("use { table gold_dim_date } from '../tables/gold/gold_dim_date.dbml'");
    // The gold diagram, which uses the winner, and every Ref naming dim_date are left alone.
    expect(byPath.has('gold/sales.dbml')).toBe(false);
    expect([...byPath.keys()].some((p) => p.endsWith('_relationships.dbml'))).toBe(false);
  });
});

describe('sync plans name the new .dbml path and the relationships file (§5.7)', () => {
  it('newTableFilePath wins for a table with no file; relationshipsPath is set for a DBML table', () => {
    const report = {
      domain: 'sales', layer: 'gold', sourceStage: 'logical', targetStage: 'physical',
      models: [
        { name: 'fct_order', status: 'matched', columns: [{ name: 'amount', status: 'type-mismatch', sourceDataType: 'float', targetDataType: 'decimal(18,2)' }] },
        { name: 'new_one', status: 'missing', columns: [] },
      ],
      relationships: [],
      summary: {},
    } as unknown as DiscrepancyReport;
    const plan = buildSyncPlan(report, allSelections(report, 'physical'), {
      manifest: { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() } as never,
      ymlData: { models: new Map() } as never,
      projectRoot: tmp,
      semanticDir: '.erd-studio',
      domain: 'sales',
      layer: 'gold',
      tableLibraryFile: (n) => (n === 'fct_order' ? 'tables/gold/fct_order.dbml' : null),
      newTableFilePath: (n) => `tables/${n}.dbml`,
      relationshipsFile: (n) => (n === 'fct_order' ? 'tables/gold/_relationships.dbml' : undefined),
    });
    expect(plan.modelContext.new_one?.logicalModelPath).toBe('.erd-studio/tables/new_one.dbml');
    expect(plan.modelContext.new_one?.relationshipsPath).toBeUndefined();
    expect(plan.modelContext.fct_order).toMatchObject({
      logicalModelPath: '.erd-studio/tables/gold/fct_order.dbml',
      relationshipsPath: '.erd-studio/tables/gold/_relationships.dbml',
    });
  });

  it('the host passes pathForNewTable: tables/<name>.dbml in a DBML project', () => {
    copyNative();
    const { tableLibraryService: lib } = services();
    expect(lib.libraryRelativePath(lib.pathForNewTable('new_one'))).toBe('tables/new_one.dbml');
    expect(lib.libraryRelativePath(lib.relationshipsFileFor('fct_order')!)).toBe('tables/gold/_relationships.dbml');
  });
});

describe('Export refuses a target inside the semantic dir (§5.7)', () => {
  const exported = { fileName: 'sales.dbml', content: 'Table x {\n}\n' };

  function exportUi(saveTo: string | undefined): ExportDiagramUi & { written: string[]; errors: string[]; dialogs: string[] } {
    const ui = {
      written: [] as string[], errors: [] as string[], dialogs: [] as string[],
      showQuickPick: async (items: readonly vscode.QuickPickItem[]) => (items as Array<{ format?: string; action?: string }>).find((i) => i.format === 'dbml' || i.action === 'save') as never,
      writeClipboard: async () => {}, getLanguages: async () => [], openUntitled: async () => {},
      showSaveDialog: async (options: vscode.SaveDialogOptions) => { ui.dialogs.push(options.defaultUri!.fsPath); return saveTo ? vscode.Uri.file(saveTo) as never : undefined; },
      fileExists: async () => false,
      writeFile: async (uri: vscode.Uri) => { ui.written.push(uri.fsPath); },
      openFile: async () => {}, openFileAt: async () => {}, sendFeedback: async () => {},
      showInformationMessage: async () => undefined, showModalWarning: async () => undefined,
      showErrorMessage: async (message: string) => { ui.errors.push(message); return undefined; },
    };
    return ui as never;
  }

  it('Export Diagram: a Save As inside .erd-studio/ writes nothing and says why; the default folder is the project root', async () => {
    const semanticRoot = erd();
    const domainPath = erd('gold', 'sales.dbml');
    const inside = exportUi(erd('gold', 'sales.dbml'));
    const deps = {
      exportDomain: async () => exported as never, activeDomainPath: () => domainPath, hasDiagrams: () => true, pickDomain: async () => undefined,
      projectRoot: tmp, semanticRoot,
    };
    await exportDiagramCommand({ ...deps, ui: inside });
    expect(inside.written).toEqual([]);
    expect(inside.errors).toEqual([exportInsideSemanticDirMessage(semanticRoot)]);
    expect(inside.errors[0]).toBe("Save the export outside .erd-studio/: files there are your diagrams' own storage.");
    // No defaultSaveFolder: a diagram in the semantic dir starts at the project root, not its layer folder.
    expect(inside.dialogs[0]).toBe(path.join(tmp, 'sales.dbml'));
    const outside = exportUi(path.join(tmp, 'exports', 'sales.dbml'));
    await exportDiagramCommand({ ...deps, ui: outside });
    expect(outside.written).toEqual([path.join(tmp, 'exports', 'sales.dbml')]);
  });

  it('Export All Diagrams: a folder inside .erd-studio/ writes nothing and says why', async () => {
    const semanticRoot = erd();
    const errors: string[] = [];
    const written: string[] = [];
    const ui = {
      showQuickPick: async (items: readonly vscode.QuickPickItem[]) => (items as Array<{ format?: string }>).find((i) => i.format === 'mermaid') as never,
      showOpenDialog: async () => [vscode.Uri.file(erd('gold'))] as never,
      fileExists: async () => false,
      writeFile: async (uri: vscode.Uri) => { written.push(uri.fsPath); },
      showModalWarning: async () => undefined,
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => { errors.push(message); return undefined; },
      openFile: async () => {}, openFileAt: async () => {}, revealFolder: async () => {}, sendFeedback: async () => {},
    } as unknown as ExportAllDiagramsUi;
    await exportAllDiagramsCommand({
      listSubjectAreas: () => [{ filePath: erd('gold', 'sales.dbml'), domain: 'sales', layer: 'gold' } as never],
      exportAll: async () => ({ files: [{ fileName: 'sales.mmd', content: 'erDiagram\n', domainPath: erd('gold', 'sales.dbml') }], skipped: [] }) as never,
      defaultFolder: tmp, projectRoot: tmp, semanticRoot, ui,
    });
    expect(written).toEqual([]);
    expect(errors).toEqual([exportInsideSemanticDirMessage(semanticRoot)]);
  });
});
