/**
 * The create paths and lifecycle planners in the layer-first DBML tree (ERD
 * Studio 2.0, §2.8), below the commands — the New Subject Area writer (one
 * library batch with its settle, the README on create and a rollback for
 * every write kind), the lifecycle planners (`src/commands/dbmlLifecycle.ts`:
 * rename, a diagram's move, Organise's moves, Give Duplicate's qualified
 * re-spelling), Draw from dbt's schema choice (`configuredSchema`) and DBML
 * refusals, Import DBML's, sync plans' new-table paths and the Export refusal
 * inside the semantic dir.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { compileDbmlProject, parseSubjectAreaDbml, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';
import { LayerService } from '../../src/services/layerService';
import { SubjectAreaService, subjectAreaTableNames } from '../../src/services/domainService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { UnsavedFilesRefused, writeNewSubjectArea } from '../../src/services/newSubjectAreaWriter';
import { FileWriteRollbackFailed, type FileWriteIo } from '../../src/services/fsFileWrites';
import { classifyWriteFailure, failedPath } from '../../src/services/commandErrors';
import { buildDbtDraft, configuredSchemaOf } from '../../src/services/dbtDraft';
import { extractManifestData } from '../../src/workers/manifestExtractor';
import { YmlParserService } from '../../src/services/ymlParserService';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';
import { firstUseDeclarationLine, readDbml, IMPORT_MULTI_FILE_MESSAGE } from '../../src/services/dbmlImportParse';
import { dbmlImportRefusal } from '../../src/commands/importDbml';
import { describeDbmlImportPlan, planDbmlImport } from '../../src/services/dbmlImport';
import { newDbmlSubjectAreaText, planDbmlDiagramMove, planDbmlDuplicateRename, planDbmlSubjectAreaRename, planDbmlTableMoves } from '../../src/commands/dbmlLifecycle';
import type { FileWrite } from '../../src/services/fileWrites';
import { exportDiagramCommand, exportInsideSemanticDirMessage, type ExportDiagramUi } from '../../src/commands/exportDiagram';
import { exportAllDiagramsCommand, type ExportAllDiagramsUi } from '../../src/commands/exportAllDiagrams';
import { allSelections, buildSyncPlan } from '../../src/services/syncPlanBuilder';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { SemanticTable } from '../../src/types/semantic';
import { formatWrittenDbml } from '../../src/services/dbmlWriters';
import { semanticReadmeText } from '../../src/services/semanticReadme';

/** The expected text in the canonical layout ERD Studio writes every .dbml in (every write is formatted). */
function canonical(text: string): string {
  return formatWrittenDbml(text, 'expected.dbml');
}

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

/** Every file the writer creates parses with no errors in 9.1.1, 10.3.1 and 11.0.0 (§9). */
const PARSERS: Array<[string, DbmlParserModule | undefined]> = [
  ['9.1.1', v9 as unknown as DbmlParserModule],
  ['10.3.1', v10 as unknown as DbmlParserModule],
  ['11.0.0', undefined],
];
function expectCompilesInEveryParser(files: Record<string, string>, entries: readonly string[]): void {
  for (const [label, parser] of PARSERS) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(files, entries, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}
const dbmlFiles = (): Record<string, string> => Object.fromEntries([...snapshot()].filter(([p]) => p.endsWith('.dbml')));

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
  it('a new, empty project writes DBML: pathForNewTable and saveTable go to <layer>/tables/<layer>/', () => {
    const { tableLibraryService: lib } = services();
    expect(lib.projectStorage()).toBe('dbml');
    expect(lib.writesDbml()).toBe(true);
    expect(lib.pathForNewTable('dim_x', 'gold')).toBe(erd('gold', 'tables', 'gold', 'dim_x.dbml'));
    lib.saveTable({ name: 'dim_x', columns: [col('id', { isPrimaryKey: true })] } as SemanticTable, 'gold');
    expect(fs.readFileSync(erd('gold', 'tables', 'gold', 'dim_x.dbml'), 'utf-8')).toMatch(/^Table gold\.dim_x \{/);
    expect(fs.existsSync(erd('logical-models'))).toBe(false);
  });

  it('a YAML project keeps writing YAML, and an existing table keeps its format in a mixed one', () => {
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    const { tableLibraryService: lib } = services();
    expect(lib.projectStorage()).toBe('yaml');
    lib.saveTable(CUSTOMERS);
    expect(fs.existsSync(erd('logical-models', 'customers.yml'))).toBe(true);
    // A DBML table beside it makes the project mixed: new files are DBML, the YAML one stays YAML.
    fs.mkdirSync(erd('gold', 'tables', 'gold'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'gold', 'dim_y.dbml'), 'Table gold.dim_y {\n  id INT [pk]\n}\n');
    lib.invalidateCache();
    expect(lib.projectStorage()).toBe('mixed');
    lib.saveTable({ ...CUSTOMERS, description: 'People' });
    expect(fs.readFileSync(erd('logical-models', 'customers.yml'), 'utf-8')).toContain('People');
    expect(lib.pathForNewTable('dim_z')).toBe(erd('gold', 'tables', 'gold', 'dim_z.dbml'));
  });
});

describe('writeNewSubjectArea for a .dbml diagram (§2.8)', () => {
  const ORDERS_PLAIN: SemanticTable = { ...ORDERS, relationships: [] } as SemanticTable;
  const ITEMS: SemanticTable = { name: 'items', columns: [col('item_id', { isPrimaryKey: true })] } as SemanticTable;
  const layouted = (): Record<string, unknown> => ({
    domain: 'shop', layer: 'silver', description: 'Shop', logical: { models: ['orders', 'customers'], relationships: [] },
    viewConfig: { positions: { orders: { x: 10, y: 20 }, customers: { x: 300, y: 20 } }, annotations: [] },
  });
  const shopPath = (): string => erd('silver', 'diagrams', 'shop.dbml');

  /** silver/diagrams/one.dbml showing orders and customers, which have no relationship yet. */
  async function seedOne(): Promise<void> {
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'diagrams', 'one.dbml'), newTables: [ORDERS_PLAIN, CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'one', logical: { models: ['orders', 'customers'] }, viewConfig: {} }),
    }, services());
    expect(result.ok).toBe(true);
  }

  it('writes the tables, the layer\'s relationships file, the diagram (erd_layout, Project last) and a new project\'s README, all of which compile', async () => {
    const s = services();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [ORDERS, CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => { throw new Error('not JSON'); },
      document: layouted,
    }, s);
    expect(result).toEqual({ ok: true, written: ['orders', 'customers'], changed: [] });
    expect([...snapshot().keys()].sort()).toEqual([
      'README.md', 'layers.json', 'silver/diagrams/shop.dbml', 'silver/relationships/silver.dbml',
      'silver/tables/silver/customers.dbml', 'silver/tables/silver/orders.dbml',
    ]);
    expect(snapshot().get('README.md')).toBe(semanticReadmeText());
    const text = fs.readFileSync(shopPath(), 'utf-8');
    expect(text).toMatch(/\nProject shop \{\n[^]*  erd_layout: '''\n    customers 300 20\n    orders 10 20\n  '''\n\}\n$/);
    expect(subjectAreaTableNames(text, shopPath())).toEqual(['orders', 'customers']);
    expect(text).toMatch(/^use \{ table silver\.orders \} +from '\.\.\/tables\/silver\/orders\.dbml'$/m);
    expect(text).toContain("use * from '../relationships/silver.dbml'");
    expect(snapshot().get('silver/relationships/silver.dbml')).toContain('Ref: silver.orders.customer_id >? silver.customers.customer_id');
    expectCompilesInEveryParser(dbmlFiles(), ['silver/diagrams/shop.dbml']);
    // The canvas reads it back with its positions and the relationship from the library.
    s.tableLibraryService.invalidateCache();
    const area = s.subjectAreaService.getSubjectArea(shopPath());
    expect(area.logical.models.map((m) => m.name)).toEqual(['orders', 'customers']);
    expect(area.viewConfig.positions?.orders).toEqual({ x: 10, y: 20 });
  });

  it('settles another DBML diagram that shows both ends of a relationship the write adds, in the same batch', async () => {
    await seedOne();
    expect(fs.readFileSync(erd('silver', 'diagrams', 'one.dbml'), 'utf-8')).not.toContain('relationships/');
    const s = services();
    const batch = vi.spyOn(s.tableLibraryService, 'applyDbmlBatch');
    // two.dbml gives orders its relationship: one.dbml shows both ends, so it imports the file too.
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'diagrams', 'two.dbml'), newTables: [], folder: 'silver', changedTables: [ORDERS],
      documentText: () => '', document: () => ({ domain: 'two', logical: { models: ['orders'] }, viewConfig: {} }),
    }, s);
    expect(result).toEqual({ ok: true, written: [], changed: ['orders'] });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(erd('silver', 'diagrams', 'one.dbml'), 'utf-8')).toContain("use * from '../relationships/silver.dbml'");
    // two.dbml shows orders alone: no Ref has both ends among its members, so it imports nothing.
    expect(fs.readFileSync(erd('silver', 'diagrams', 'two.dbml'), 'utf-8')).not.toContain('relationships/');
    expectCompilesInEveryParser(dbmlFiles(), ['silver/diagrams/one.dbml', 'silver/diagrams/two.dbml']);
  });

  it('refuses, writing nothing, when a diagram the settle pass would re-render has unsaved edits', async () => {
    await seedOne();
    const s = services();
    const before = snapshot();
    const asked: string[][] = [];
    const one = erd('silver', 'diagrams', 'one.dbml');
    // one.dbml is open with an unsaved member: its open text is what the settle reads.
    const openText = `${fs.readFileSync(one, 'utf-8')}// unsaved\n`;
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('silver', 'diagrams', 'two.dbml'), newTables: [], folder: 'silver', changedTables: [ORDERS],
      documentText: () => '', document: () => ({ domain: 'two', logical: { models: ['orders', 'customers'] }, viewConfig: {} }),
    }, {
      ...s,
      readText: (p) => (path.resolve(p) === one ? openText : (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null)),
      dirtyFiles: (paths) => { asked.push([...paths]); return paths.filter((p) => path.resolve(p) === one); },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(UnsavedFilesRefused);
      expect((result.error as UnsavedFilesRefused).filePaths).toEqual([one]);
      expect(result.undone).toBe(true);
    }
    // Every planned path was checked: the settled diagram, the new relationships file and the diagram.
    expect(asked[0]).toEqual(expect.arrayContaining([one, erd('silver', 'relationships', 'silver.dbml'), erd('silver', 'diagrams', 'two.dbml')]));
    expect(snapshot()).toEqual(before);
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

  it('a failure at any write puts every file back: table, relationships file, diagram, other diagrams (rollback of every write kind)', async () => {
    // A project with a diagram that the new one settles.
    await seedOne();
    const before = snapshot();
    const shop = (): Record<string, unknown> => ({ domain: 'shop', logical: { models: ['orders', 'customers', 'items'] }, viewConfig: {} });
    // Creates: the items table, the relationships file, the diagram; replaces: one.dbml (settle).
    for (let n = 1; n <= 4; n++) {
      const result = await writeNewSubjectArea({
        workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [ITEMS], folder: 'silver', changedTables: [ORDERS],
        documentText: () => '', document: shop,
      }, { ...services(), io: failingIo(n) });
      expect(result.ok, `failure at write ${n}`).toBe(false);
      if (!result.ok) expect(result.undone).toBe(true);
      expect(snapshot(), `failure at write ${n}`).toEqual(before);
    }
    // And with no failure, every kind was written (and no README: the project was there already).
    const ok = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [ITEMS], folder: 'silver', changedTables: [ORDERS],
      documentText: () => '', document: shop,
    }, services());
    expect(ok.ok).toBe(true);
    const after = snapshot();
    expect(after.get('silver/diagrams/one.dbml')).not.toBe(before.get('silver/diagrams/one.dbml'));
    for (const p of ['silver/diagrams/shop.dbml', 'silver/tables/silver/items.dbml', 'silver/relationships/silver.dbml']) expect(after.has(p), p).toBe(true);
    expect(after.get('README.md')).toBe(before.get('README.md'));
  });

  it('a project with no ERD folder: a failed write removes the folder, its layers.json and its README, at any write', async () => {
    // Creates: two tables, the relationships file, the diagram, the README (last).
    for (const n of [1, 2, 3, 4, 5]) {
      const result = await writeNewSubjectArea({
        workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [ORDERS, CUSTOMERS], folder: 'silver', changedTables: [],
        documentText: () => '', document: layouted,
      }, { ...services(), io: failingIo(n) });
      expect(result.ok, `failure at write ${n}`).toBe(false);
      if (!result.ok) expect(result.undone).toBe(true);
      expect(fs.existsSync(erd()), `failure at write ${n}`).toBe(false);
    }
  });

  it('the diagram name taken since it was checked is nameTaken, and nothing else is written', async () => {
    const s = services();
    fs.mkdirSync(erd('silver', 'diagrams'), { recursive: true });
    fs.writeFileSync(erd('layers.json'), fs.readFileSync(path.join(DBML_NATIVE, '.erd-studio', 'layers.json')));
    fs.writeFileSync(shopPath(), 'Project shop {\n}\n');
    const before = snapshot();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [CUSTOMERS], folder: 'silver', changedTables: [],
      documentText: () => '', document: () => ({ domain: 'shop', logical: { models: ['customers'] }, viewConfig: {} }),
    }, s);
    expect(result).toMatchObject({ ok: false, nameTaken: true, undone: true });
    expect(snapshot()).toEqual(before);
  });

  it('a YAML table cannot join a DBML diagram (D20): refused before any write', async () => {
    fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_y.dbml'), 'Table silver.dim_y {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'customers.yml'), 'name: customers\ncolumns:\n  - name: customer_id\n    dataType: INT\n    description: ""\n');
    const s = services();
    const before = snapshot();
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: shopPath(), newTables: [], changedTables: [],
      documentText: () => '', document: () => ({ domain: 'shop', logical: { models: ['customers'] }, viewConfig: {} }),
    }, s);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(String((result.error as Error).message)).toContain('Convert the project to DBML first');
    expect(snapshot()).toEqual(before);
  });

  it('Import\'s tables keep the schema they bring (schemaFromSource), as the layer\'s folder spells it', async () => {
    fs.mkdirSync(erd('gold', 'tables', 'sales'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'sales', 'dim_rep.dbml'), 'Table sales.dim_rep {\n  rep_id INT [pk]\n}\n');
    const result = await writeNewSubjectArea({
      workspaceRoot: tmp, semanticDir: '.erd-studio', domainPath: erd('gold', 'diagrams', 'deals.dbml'),
      newTables: [{ name: 'deals', schema: 'Sales', columns: [col('deal_id', { isPrimaryKey: true })] } as SemanticTable, { ...CUSTOMERS }],
      folder: 'gold', schemaFromSource: true, changedTables: [],
      documentText: () => '', document: () => ({ domain: 'deals', logical: { models: ['deals', 'customers'] }, viewConfig: {} }),
    }, services());
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(erd('gold', 'tables', 'sales', 'deals.dbml'), 'utf-8')).toMatch(/^Table sales\.deals \{/);
    // A table that brings no schema takes the layer's.
    expect(fs.readFileSync(erd('gold', 'tables', 'gold', 'customers.dbml'), 'utf-8')).toMatch(/^Table gold\.customers \{/);
    expect(fs.readFileSync(erd('gold', 'diagrams', 'deals.dbml'), 'utf-8')).toMatch(/^use \{ table sales\.deals \} +from '\.\.\/tables\/sales\/deals\.dbml'$/m);
    expectCompilesInEveryParser(dbmlFiles(), ['gold/diagrams/deals.dbml']);
  });
});

describe('command errors see through a rollback that could not finish', () => {
  it('names what the disk refused and where', () => {
    const err = new FileWriteRollbackFailed(Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC', path: '/p/x.dbml' }), ['/p/y.dbml']);
    expect(classifyWriteFailure(err)).toBe('disk-full');
    expect(failedPath(err)).toBe('/p/x.dbml');
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

  it('Draw gives a new table its dbt custom schema (configuredSchema), never the schema it is built in, and only for a DBML diagram', () => {
    const manifest = {
      models: new Map([
        ['fct_fin', { name: 'fct_fin', uniqueId: 'model.p.fct_fin', projectName: 'p', schema: 'dbt_liam_finance', configSchema: 'finance', description: '', columns: [{ name: 'id', data_type: 'int', description: '' }] }],
        ['fct_plain', { name: 'fct_plain', uniqueId: 'model.p.fct_plain', projectName: 'p', schema: 'dbt_liam', description: '', columns: [{ name: 'id', data_type: 'int', description: '' }] }],
      ]),
      relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set(),
    } as unknown as ManifestData;
    // No manifest entry: the schema yml model's `config: schema:`.
    const ymlData = { models: new Map([['dim_yml', { name: 'dim_yml', description: '', columns: [{ name: 'id', description: '', dataType: 'int' }], filePath: '/x.yml', tags: [], configSchema: 'sales' }]]), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() } as unknown as YmlData;
    const dbml = buildDbtDraft({ modelNames: ['fct_fin', 'fct_plain', 'dim_yml'], manifest, ymlData, libraryHas: () => false, dbml: { tableStorage: () => undefined } });
    expect(dbml.newModels.map((m) => [m.name, m.configuredSchema, m.schema])).toEqual([
      ['fct_fin', 'finance', 'dbt_liam_finance'],
      ['fct_plain', undefined, 'dbt_liam'],
      ['dim_yml', 'sales', undefined],
    ]);
    expect(configuredSchemaOf('FCT_FIN', undefined, manifest)).toBe('finance');
    // A manifest that lists the model is dbt's own answer: a yml `config: schema:` it does not carry is not used.
    const staleYml = { ...ymlData, models: new Map([['fct_plain', { name: 'fct_plain', description: '', columns: [], filePath: '/x.yml', tags: [], configSchema: 'sales' }]]) } as unknown as YmlData;
    expect(configuredSchemaOf('fct_plain', staleYml, manifest)).toBeUndefined();
    expect(configuredSchemaOf('fct_plain', staleYml)).toBe('sales');
    // A JSON diagram's draft is unchanged: no configuredSchema at all.
    const plain = buildDbtDraft({ modelNames: ['fct_fin'], manifest, ymlData, libraryHas: () => false });
    expect(plain.newModels[0]).not.toHaveProperty('configuredSchema');
  });

  it('the manifest and the schema yml carry a model\'s config.schema (configSchema), and nothing when it has none', async () => {
    const node = (extra: Record<string, unknown>) => ({ unique_id: 'model.p.fct', resource_type: 'model', name: 'fct', schema: 'dbt_liam_finance', columns: {}, ...extra });
    expect(extractManifestData({ nodes: { 'model.p.fct': node({ config: { schema: 'finance' } }) } }).models.fct.configSchema).toBe('finance');
    expect(extractManifestData({ nodes: { 'model.p.fct': node({ config: { schema: null } }) } }).models.fct).not.toHaveProperty('configSchema');
    expect(extractManifestData({ nodes: { 'model.p.fct': node({}) } }).models.fct).not.toHaveProperty('configSchema');
    fs.writeFileSync(path.join(tmp, 'dbt_project.yml'), 'name: tmp\nprofile: tmp\nmodel-paths: ["models"]\n');
    fs.mkdirSync(path.join(tmp, 'models'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'models', '_models.yml'), 'version: 2\nmodels:\n  - name: fct\n    config:\n      schema: finance\n  - name: dim\n');
    const data = await new YmlParserService().loadYmlData(tmp);
    expect(data.models.get('fct')?.configSchema).toBe('finance');
    expect(data.models.get('dim')).not.toHaveProperty('configSchema');
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
    // No Markdown: a notification shows it as plain text.
    expect(IMPORT_MULTI_FILE_MESSAGE).not.toMatch(/\*\*|`/);
  });

  it('Import accepts a column or an enum value named use (inside a body, use is not a declaration)', () => {
    const column = 'Table t {\n  id int [pk]\n  use varchar\n}\n';
    const enumValue = 'Enum kind {\n  use\n  other\n}\n';
    const indexed = 'Table t {\n  use int\n  indexes {\n    (\n      use\n    )\n  }\n}\n';
    for (const text of [column, enumValue, indexed]) {
      expect(firstUseDeclarationLine(text)).toBeUndefined();
      expect(readDbml(text)).toMatchObject({ ok: true });
    }
    // A top-level use after a body is still found.
    expect(firstUseDeclarationLine(`${column}use { table a } from './a.dbml'\n`)).toBe(5);
  });

  it('Import into a DBML diagram names a relationship it cannot store, and does not count it', () => {
    const read = readDbml('Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    if (!read.ok) throw new Error('unreadable');
    // orders is in the library but its file cannot be read: the relationship has no owner file.
    const plan = (flag: boolean) => planDbmlImport({
      model: read.model, layer: 'gold', subjectAreaName: 'shop',
      library: { findTableName: (n) => (n === 'orders' ? 'orders' : null), getTable: () => null },
      libraryRelationships: true,
      ...(flag ? { diagramHoldsNoRelationships: true } : {}),
    });
    // A JSON diagram keeps it in the diagram, as before.
    expect(plan(false).document.logical.relationships).toHaveLength(1);
    const dbml = plan(true);
    expect(dbml.document.logical.relationships).toEqual([]);
    expect(dbml.report.relationships).toBe(0);
    expect(dbml.report.dropped).toEqual([expect.objectContaining({
      kind: 'reference', what: 'Reference orders.customer_id – customers.id', why: "not stored, because its table's file could not be read.",
    })]);
    expect(describeDbmlImportPlan(dbml)).toContain("• Reference orders.customer_id – customers.id: not stored, because its table's file could not be read.");
  });

  it('Import into a DBML project refuses to reuse a YAML table; a new table named _relationships is an ordinary table now', () => {
    const plan = { reusedTables: ['dim_yaml'], newTables: [] } as unknown as Parameters<typeof dbmlImportRefusal>[0];
    expect(dbmlImportRefusal(plan, () => 'yaml')).toContain("a YAML table can't join a DBML diagram. Convert the project to DBML first");
    expect(dbmlImportRefusal({ reusedTables: ['x'], newTables: [] } as never, () => 'dbml')).toBeUndefined();
    expect(dbmlImportRefusal({ reusedTables: [], newTables: [{ name: '_Relationships' }] } as never, () => undefined)).toBeUndefined();
  });
});

describe('the lifecycle planners (src/commands/dbmlLifecycle.ts)', () => {
  const readText = (p: string): string | null => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
  const rel = (p: string): string => path.relative(erd(), p).split(path.sep).join('/');
  const byPathOf = (writes: readonly FileWrite[]): Map<string, FileWrite> => new Map(writes.map((w) => [rel(w.path), w]));
  const textOf = (w: FileWrite | undefined): string => (w && w.kind !== 'delete' ? w.text : '');
  function apply(writes: readonly FileWrite[]): void {
    for (const w of writes) {
      if (w.kind === 'delete') fs.rmSync(w.path);
      else { fs.mkdirSync(path.dirname(w.path), { recursive: true }); fs.writeFileSync(w.path, w.text); }
    }
  }
  const diagramsOf = (subjectAreaService: SubjectAreaService): string[] =>
    subjectAreaService.listSubjectAreas(tmp, '.erd-studio').filter((d) => d.storage === 'dbml').map((d) => d.filePath);
  const ALL_DIAGRAMS = ['gold/diagrams/sales.dbml', 'silver/diagrams/staging.dbml'];

  it('New Diagram: a Project with its Note and keys and no members, that reads back', () => {
    const filePath = erd('gold', 'diagrams', 'orders.dbml');
    const text = newDbmlSubjectAreaText({ semanticRoot: erd(), filePath, domain: 'orders', description: 'Orders', modelFolder: 'marts' });
    const obj = parseSubjectAreaDbml(text, 'gold/diagrams/orders.dbml').obj;
    expect(obj).toMatchObject({ domain: 'orders', layer: 'gold', description: 'Orders', modelFolder: 'marts', logical: { models: [] } });
  });

  it('Rename Subject Area: one file in the same folder, the Project name spliced, the use lines and erd_layout kept (no library read)', () => {
    copyNative();
    const oldPath = erd('gold', 'diagrams', 'sales.dbml');
    const text = fs.readFileSync(oldPath, 'utf-8');
    const writes = planDbmlSubjectAreaRename({ semanticRoot: erd(), oldPath, newPath: erd('gold', 'diagrams', 'revenue.dbml'), newSlug: 'revenue', text });
    expect(writes.map((w) => `${w.kind} ${rel(w.path)}`)).toEqual(['create gold/diagrams/revenue.dbml', 'delete gold/diagrams/sales.dbml']);
    const created = textOf(writes[0]);
    expect(created).toBe(canonical(text.replace('Project sales {', 'Project revenue {')));
    expect(created).toContain("  erd_layout: '''\n    bridge_empty 760 400\n");
    for (const line of text.split('\n').filter((l) => l.startsWith('use '))) expect(created).toContain(line.replace(/ +from/, ' from').split(' from ')[1]);
  });

  it('a diagram\'s move to another layer re-derives every use path from the new folder, specifiers and Project kept (planDbmlDiagramMove)', () => {
    copyNative();
    const text = fs.readFileSync(erd('gold', 'diagrams', 'sales.dbml'), 'utf-8');
    const writes = planDbmlDiagramMove({ oldRel: 'gold/diagrams/sales.dbml', newRel: 'silver/diagrams/sales.dbml', text });
    expect(writes.map((w) => `${w.kind} ${w.path}`)).toEqual(['create silver/diagrams/sales.dbml', 'delete gold/diagrams/sales.dbml']);
    const moved = textOf(writes[0]);
    expect(moved.split('\n').filter((l) => l.startsWith('use '))).toEqual([
      "use { table gold.fct_order } from '../../gold/tables/gold/fct_order.dbml'",
      "use { table gold.dim_customer } from '../../gold/tables/gold/dim_customer.dbml'",
      "use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'",
      "use { table gold.dim_region } from '../../gold/tables/gold/dim_region.dbml'",
      "use { table gold.customer_profile } from '../../gold/tables/gold/customer_profile.dbml'",
      "use { table gold.bridge_empty } from '../../gold/tables/gold/bridge_empty.dbml'",
      "use * from '../relationships/calendar.dbml'",
      "use * from '../../gold/relationships/customers.dbml'",
      "use * from '../../gold/relationships/gold.dbml'",
    ]);
    // Nothing else changes: the Project (name and erd_layout) and the Notes keep their bytes.
    expect(moved.slice(moved.indexOf('Note "'))).toBe(text.slice(text.indexOf('Note "')));
    expect(moved.slice(0, moved.indexOf('use '))).toBe(text.slice(0, text.indexOf('use ')));
    const files = Object.fromEntries(Object.entries(dbmlFiles()).filter(([p]) => p !== 'gold/diagrams/sales.dbml'));
    expectCompilesInEveryParser({ ...files, 'silver/diagrams/sales.dbml': moved }, ['silver/diagrams/sales.dbml']);
    // The same move back is the text it started from.
    expect(textOf(planDbmlDiagramMove({ oldRel: 'silver/diagrams/sales.dbml', newRel: 'gold/diagrams/sales.dbml', text: moved })[0])).toBe(text);
  });

  it('a diagram\'s move re-derives the path of a use declaration written over several lines (planDbmlDiagramMove)', () => {
    copyNative();
    const original = fs.readFileSync(erd('gold', 'diagrams', 'sales.dbml'), 'utf-8');
    const single = "use { table gold.fct_order } from '../tables/gold/fct_order.dbml'";
    expect(original).toContain(single);
    const text = original.replace(single, "use {\n  table gold.fct_order // the fact\n}\nfrom '../tables/gold/fct_order.dbml'");
    expectCompilesInEveryParser({ ...dbmlFiles(), 'gold/diagrams/sales.dbml': text }, ['gold/diagrams/sales.dbml']);
    const moved = textOf(planDbmlDiagramMove({ oldRel: 'gold/diagrams/sales.dbml', newRel: 'silver/diagrams/sales.dbml', text })[0]);
    expect(moved).toContain("use {\n  table gold.fct_order // the fact\n}\nfrom '../../gold/tables/gold/fct_order.dbml'");
    expect(moved).not.toContain("'../tables/gold/");
    const files = Object.fromEntries(Object.entries(dbmlFiles()).filter(([p]) => p !== 'gold/diagrams/sales.dbml'));
    expectCompilesInEveryParser({ ...files, 'silver/diagrams/sales.dbml': moved }, ['silver/diagrams/sales.dbml']);
  });

  it('Organise: a table moves to another layer with its schema kept; no Ref moves, every use line follows', () => {
    copyNative();
    // dim_rate sits in gold but only the silver diagram shows it; gold's relationships file holds its Ref.
    fs.writeFileSync(erd('gold', 'tables', 'gold', 'dim_rate.dbml'), 'Table gold.dim_rate {\n  rate_key INT [pk]\n  date_key INT\n}\n');
    const goldRels = erd('gold', 'relationships', 'gold.dbml');
    fs.writeFileSync(goldRels, fs.readFileSync(goldRels, 'utf-8')
      .replace("use { table gold.dim_region }", "use { table gold.dim_rate } from '../tables/gold/dim_rate.dbml'\nuse { table gold.dim_region }")
      .concat('\nRef: gold.dim_rate.date_key >? calendar.dim_date.date_key\n'));
    const staging = erd('silver', 'diagrams', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table gold.dim_rate } from '../../gold/tables/gold/dim_rate.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const { tableLibraryService, subjectAreaService } = services();
    const planned = planDbmlTableMoves({ tableLibraryService, moves: [{ name: 'dim_rate', toLayer: 'silver' }], diagrams: diagramsOf(subjectAreaService), readText });
    expect(planned.requalified).toEqual([]);
    const byPath = byPathOf(planned.writes);
    expect([...byPath.keys()].sort()).toEqual(['gold/relationships/gold.dbml', 'gold/tables/gold/dim_rate.dbml', 'silver/diagrams/staging.dbml', 'silver/tables/gold/dim_rate.dbml']);
    expect(byPath.get('gold/tables/gold/dim_rate.dbml')?.kind).toBe('delete');
    expect(textOf(byPath.get('silver/tables/gold/dim_rate.dbml'))).toMatch(/^Table gold\.dim_rate \{/);
    // The Ref stays in gold's file; only its use line follows the table.
    const rels = textOf(byPath.get('gold/relationships/gold.dbml'));
    expect(rels).toContain('Ref: gold.dim_rate.date_key >? calendar.dim_date.date_key');
    expect(rels).toMatch(/^use \{ table gold\.dim_rate \} +from '\.\.\/\.\.\/silver\/tables\/gold\/dim_rate\.dbml'$/m);
    expect(textOf(byPath.get('silver/diagrams/staging.dbml'))).toMatch(/^use \{ table gold\.dim_rate \} +from '\.\.\/tables\/gold\/dim_rate\.dbml'$/m);
    apply(planned.writes);
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
  });

  it('Organise: a table whose schema the new layer spells otherwise is re-qualified there, and listed', () => {
    copyNative();
    // gold/tables/Calendar/: silver already lists its schema as calendar/.
    fs.mkdirSync(erd('gold', 'tables', 'Calendar'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'Calendar', 'dim_holiday.dbml'), 'Table Calendar.dim_holiday {\n  holiday_key INT [pk]\n  date_key INT\n}\n');
    const goldRels = erd('gold', 'relationships', 'gold.dbml');
    fs.writeFileSync(goldRels, fs.readFileSync(goldRels, 'utf-8')
      .replace("use { table gold.dim_customer }", "use { table Calendar.dim_holiday } from '../tables/Calendar/dim_holiday.dbml'\nuse { table gold.dim_customer }")
      .concat('\nRef: Calendar.dim_holiday.date_key >? calendar.dim_date.date_key\n'));
    const staging = erd('silver', 'diagrams', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table Calendar.dim_holiday } from '../../gold/tables/Calendar/dim_holiday.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const { tableLibraryService, subjectAreaService } = services();
    const planned = planDbmlTableMoves({ tableLibraryService, moves: [{ name: 'dim_holiday', toLayer: 'silver' }], diagrams: diagramsOf(subjectAreaService), readText });
    expect(planned.requalified).toEqual(['dim_holiday']);
    const byPath = byPathOf(planned.writes);
    expect(textOf(byPath.get('silver/tables/calendar/dim_holiday.dbml'))).toMatch(/^Table calendar\.dim_holiday \{/);
    const rels = textOf(byPath.get('gold/relationships/gold.dbml'));
    expect(rels).toContain('Ref: calendar.dim_holiday.date_key >? calendar.dim_date.date_key');
    expect(rels).not.toContain('Calendar.');
    expect(textOf(byPath.get('silver/diagrams/staging.dbml'))).toMatch(/^use \{ table calendar\.dim_holiday \} +from '\.\.\/tables\/calendar\/dim_holiday\.dbml'$/m);
    apply(planned.writes);
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
  });

  /**
   * A second dim_customer in silver/tables/silver/ (`silver.dim_customer`): gold's comes first in
   * the listing and wins, so the silver one is the ignored copy. silver's relationships file and
   * two silver diagrams use the copy; one of them has a merge conflict in its erd_layout.
   */
  function seedDuplicate(): { third: string; thirdLayout: string } {
    copyNative();
    fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_customer.dbml'), 'Table silver.dim_customer {\n  customer_key INT [pk]\n}\n');
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'fct_visit.dbml'), 'Table silver.fct_visit {\n  visit_key INT [pk]\n  customer_key INT\n}\n');
    fs.writeFileSync(erd('silver', 'relationships', 'silver.dbml'), [
      "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'",
      "use { table silver.fct_visit } from '../tables/silver/fct_visit.dbml'",
      '',
      'Ref: silver.fct_visit.customer_key >? silver.dim_customer.customer_key',
      '',
    ].join('\n'));
    const staging = erd('silver', 'diagrams', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
    const thirdLayout = "  erd_layout: '''\n<<<<<<< HEAD\n    dim_customer 10 10\n=======\n    dim_customer 20 20\n>>>>>>> other\n    fct_visit 100 100\n  '''\n}\n";
    const third = [
      "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'",
      "use { table silver.fct_visit } from '../tables/silver/fct_visit.dbml'",
      "use * from '../relationships/silver.dbml'",
      '',
      'Project third {',
      "  erd_schema_version: '7'",
    ].join('\n') + '\n' + thirdLayout;
    fs.writeFileSync(erd('silver', 'diagrams', 'third.dbml'), third);
    expectCompilesInEveryParser(dbmlFiles(), [...ALL_DIAGRAMS, 'silver/diagrams/third.dbml']);
    return { third: erd('silver', 'diagrams', 'third.dbml'), thirdLayout };
  }

  it('Give Duplicate Its Own Name: the copy\'s qualified ends are re-spelled, the other copy\'s keep their bytes, and a diagram with a conflicted erd_layout is repointed, not refused', () => {
    const { third, thirdLayout } = seedDuplicate();
    const { tableLibraryService, subjectAreaService } = services();
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'dim_customer')!;
    expect(rel(entry.filePath)).toBe('silver/tables/silver/dim_customer.dbml');
    const before = snapshot();
    const planned = planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'dim_customer' }, newName: 'silver_dim_customer', alias: 'dim_customer',
      diagrams: diagramsOf(subjectAreaService), readText,
    });
    const byPath = byPathOf(planned.writes);
    expect([...byPath.keys()].sort()).toEqual([
      'silver/diagrams/staging.dbml', 'silver/diagrams/third.dbml', 'silver/relationships/silver.dbml',
      'silver/tables/silver/dim_customer.dbml', 'silver/tables/silver/silver_dim_customer.dbml',
    ]);
    expect(planned.repointed.map(rel).sort()).toEqual(['silver/diagrams/staging.dbml', 'silver/diagrams/third.dbml', 'silver/relationships/silver.dbml']);
    expect(byPath.get('silver/tables/silver/dim_customer.dbml')?.kind).toBe('delete');
    expect(textOf(byPath.get('silver/tables/silver/silver_dim_customer.dbml'))).toMatch(/^Table silver\.silver_dim_customer \[alias: 'dim_customer'\]/m);
    // The copy's end is re-spelled, and its use line follows the renamed file.
    const rels = textOf(byPath.get('silver/relationships/silver.dbml'));
    expect(rels).toContain('Ref: silver.fct_visit.customer_key >? silver.silver_dim_customer.customer_key');
    expect(rels).toMatch(/^use \{ table silver\.silver_dim_customer \} +from '\.\.\/tables\/silver\/silver_dim_customer\.dbml'$/m);
    expect(rels).not.toContain("'../tables/silver/dim_customer.dbml'");
    // gold's Refs name gold.dim_customer, the table the library uses: not a byte changes there.
    for (const p of ['gold/relationships/gold.dbml', 'gold/relationships/customers.dbml', 'gold/diagrams/sales.dbml']) expect(byPath.has(p), p).toBe(false);
    // Both diagrams that show the copy are repointed; the conflicted erd_layout is kept byte for byte.
    expect(textOf(byPath.get('silver/diagrams/staging.dbml'))).toMatch(/^use \{ table silver\.silver_dim_customer \} +from '\.\.\/tables\/silver\/silver_dim_customer\.dbml'$/m);
    const thirdText = textOf(byPath.get('silver/diagrams/third.dbml'));
    // Its imports are exactly its tables and the file holding the renamed copy's Ref: gold's files hold only
    // gold.dim_customer's Refs, the table the library uses, so they are not imported.
    expect(thirdText.split('\n').filter((l) => l.startsWith('use ')).map((l) => l.replace(/ +from/, ' from'))).toEqual([
      "use { table silver.silver_dim_customer } from '../tables/silver/silver_dim_customer.dbml'",
      "use { table silver.fct_visit } from '../tables/silver/fct_visit.dbml'",
      "use * from '../relationships/silver.dbml'",
    ]);
    expect(thirdText.endsWith(thirdLayout)).toBe(true);
    expect(before.get(rel(third))!.endsWith(thirdLayout)).toBe(true);
    apply(planned.writes);
    expectCompilesInEveryParser(dbmlFiles(), [...ALL_DIAGRAMS, 'silver/diagrams/third.dbml']);
    const after = new TableLibraryService(tmp, '.erd-studio');
    expect(after.getTable('fct_visit')?.relationships?.map((r) => r.toModel)).toEqual(['silver_dim_customer']);
    expect(after.getTable('fct_order')?.relationships?.filter((r) => r.toModel === 'dim_customer')).toHaveLength(1);
  });

  it('Give Duplicate Its Own Name: an unqualified copy whose name is also a schema re-spells only the ends whose table part is the copy', () => {
    copyNative();
    fs.writeFileSync(erd('gold', 'tables', 'gold', 'sales.dbml'), 'Table gold.sales {\n  sale_key INT [pk]\n}\n');
    fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'sales.dbml'), 'Table sales {\n  sale_key INT [pk]\n}\n');
    fs.mkdirSync(erd('silver', 'tables', 'sales'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'sales', 'orders.dbml'), 'Table sales.orders {\n  order_key INT [pk]\n  sale_key INT\n}\n');
    fs.writeFileSync(erd('silver', 'relationships', 'silver.dbml'), [
      "use { table sales } from '../tables/silver/sales.dbml'",
      "use { table sales.orders } from '../tables/sales/orders.dbml'",
      '',
      'Ref: sales.orders.sale_key > sales.sale_key',
      '',
    ].join('\n'));
    const { tableLibraryService, subjectAreaService } = services();
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'sales')!;
    expect(rel(entry.filePath)).toBe('silver/tables/silver/sales.dbml');
    const planned = planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'sales' }, newName: 'silver_sales', alias: 'sales',
      diagrams: diagramsOf(subjectAreaService), readText,
    });
    const rels = textOf(byPathOf(planned.writes).get('silver/relationships/silver.dbml'));
    // `sales` in `sales.orders.sale_key` is the schema of sales.orders, not the copy: that end keeps its bytes.
    expect(rels).toContain('Ref: sales.orders.sale_key > silver_sales.sale_key');
  });

  it('Give Duplicate Its Own Name: a diagram that names the copy and does not read refuses the rename, naming it', () => {
    seedDuplicate();
    const broken = erd('silver', 'diagrams', 'broken.dbml');
    fs.writeFileSync(broken, "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'\n\nProject broken {\n");
    const { tableLibraryService, subjectAreaService } = services();
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'dim_customer')!;
    expect(() => planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'dim_customer' }, newName: 'silver_dim_customer', alias: 'dim_customer',
      diagrams: diagramsOf(subjectAreaService), readText,
    })).toThrow(/silver\/diagrams\/broken\.dbml does not read \(.*\); fix it first, or it would keep a use line to silver\/tables\/silver\/dim_customer\.dbml\./);
  });

  it('Give Duplicate Its Own Name: copies declared the same way cannot be told apart, so the Refs stay with the table the library uses and a use line importing the copy is repointed at it', () => {
    copyNative();
    // A team merge: silver/tables/gold/dim_customer.dbml (`gold.dim_customer`, like gold's own) came first and
    // gold's customers.dbml imports it; gold/tables/gold/dim_customer.dbml wins the listing.
    fs.mkdirSync(erd('silver', 'tables', 'gold'), { recursive: true });
    fs.copyFileSync(erd('gold', 'tables', 'gold', 'dim_customer.dbml'), erd('silver', 'tables', 'gold', 'dim_customer.dbml'));
    const rels = erd('gold', 'relationships', 'customers.dbml');
    const relsBefore = fs.readFileSync(rels, 'utf-8');
    fs.writeFileSync(rels, relsBefore.replace("from '../tables/gold/dim_customer.dbml'", "from '../../silver/tables/gold/dim_customer.dbml'"));
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const { tableLibraryService, subjectAreaService } = services();
    const relationshipsBefore = tableLibraryService.getTable('customer_profile')?.relationships ?? [];
    expect(relationshipsBefore.length).toBeGreaterThan(0);
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'dim_customer')!;
    expect(rel(entry.filePath)).toBe('silver/tables/gold/dim_customer.dbml');
    const planned = planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'dim_customer' }, newName: 'silver_dim_customer', alias: 'dim_customer',
      diagrams: diagramsOf(subjectAreaService), readText,
    });
    expect(planned.repointed).toEqual([rels]);
    const edited = textOf(byPathOf(planned.writes).get('gold/relationships/customers.dbml'));
    expect(edited).toMatch(/^use \{ table gold\.dim_customer \} +from '\.\.\/tables\/gold\/dim_customer\.dbml'$/m);
    expect(edited).not.toContain('silver');
    for (const line of relsBefore.split('\n').filter((l) => l.startsWith('Ref'))) expect(edited).toContain(line);
    apply(planned.writes);
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const after = new TableLibraryService(tmp, '.erd-studio');
    expect(after.getTable('customer_profile')?.relationships ?? []).toEqual(relationshipsBefore);
  });

  it('Give Duplicate Its Own Name: a use declaration written over several lines that imports the copy is repointed too', () => {
    copyNative();
    // A team merge: silver/tables/gold/dim_customer.dbml (`gold.dim_customer`, like gold's own) came first and
    // gold's customers.dbml imports it; gold/tables/gold/dim_customer.dbml wins the listing.
    fs.mkdirSync(erd('silver', 'tables', 'gold'), { recursive: true });
    fs.copyFileSync(erd('gold', 'tables', 'gold', 'dim_customer.dbml'), erd('silver', 'tables', 'gold', 'dim_customer.dbml'));
    const rels = erd('gold', 'relationships', 'customers.dbml');
    const relsBefore = fs.readFileSync(rels, 'utf-8');
    fs.writeFileSync(rels, relsBefore.replace(/use \{ table gold\.dim_customer \} +from '\.\.\/tables\/gold\/dim_customer\.dbml'/, "use {\n  table gold.dim_customer\n} from '../../silver/tables/gold/dim_customer.dbml'"));
    expect(fs.readFileSync(rels, 'utf-8')).toContain("use {\n  table gold.dim_customer\n} from '../../silver/");
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const { tableLibraryService, subjectAreaService } = services();
    const relationshipsBefore = tableLibraryService.getTable('customer_profile')?.relationships ?? [];
    expect(relationshipsBefore.length).toBeGreaterThan(0);
    const entry = tableLibraryService.listTableFiles().find((e) => e.shadowedBy && e.name.toLowerCase() === 'dim_customer')!;
    expect(rel(entry.filePath)).toBe('silver/tables/gold/dim_customer.dbml');
    const planned = planDbmlDuplicateRename({
      tableLibraryService, copy: { filePath: entry.filePath, name: 'dim_customer' }, newName: 'silver_dim_customer', alias: 'dim_customer',
      diagrams: diagramsOf(subjectAreaService), readText,
    });
    expect(planned.repointed).toEqual([rels]);
    const edited = textOf(byPathOf(planned.writes).get('gold/relationships/customers.dbml'));
    expect(edited).toMatch(/^use \{ table gold\.dim_customer \} +from '\.\.\/tables\/gold\/dim_customer\.dbml'$/m);
    expect(edited).not.toContain('use {\n');
    expect(edited).not.toContain('silver');
    for (const line of relsBefore.split('\n').filter((l) => l.startsWith('Ref'))) expect(edited).toContain(line);
    apply(planned.writes);
    expectCompilesInEveryParser(dbmlFiles(), ALL_DIAGRAMS);
    const after = new TableLibraryService(tmp, '.erd-studio');
    expect(after.getTable('customer_profile')?.relationships ?? []).toEqual(relationshipsBefore);
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
      tableLibraryFile: (n) => (n === 'fct_order' ? 'gold/tables/gold/fct_order.dbml' : null),
      newTableFilePath: (n) => `gold/tables/gold/${n}.dbml`,
      relationshipsFile: (n) => (n === 'fct_order' ? 'gold/relationships/gold.dbml' : undefined),
    });
    expect(plan.modelContext.new_one?.logicalModelPath).toBe('.erd-studio/gold/tables/gold/new_one.dbml');
    expect(plan.modelContext.new_one?.relationshipsPath).toBeUndefined();
    expect(plan.modelContext.fct_order).toMatchObject({
      logicalModelPath: '.erd-studio/gold/tables/gold/fct_order.dbml',
      relationshipsPath: '.erd-studio/gold/relationships/gold.dbml',
    });
  });

  it('the host passes pathForNewTable (the first layer\'s tables) and the file a new Ref goes to', () => {
    copyNative();
    const { tableLibraryService: lib } = services();
    expect(lib.libraryRelativePath(lib.pathForNewTable('new_one'))).toBe('silver/tables/silver/new_one.dbml');
    expect(lib.libraryRelativePath(lib.relationshipsFileForNewRef('fct_order')!)).toBe('gold/relationships/gold.dbml');
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
