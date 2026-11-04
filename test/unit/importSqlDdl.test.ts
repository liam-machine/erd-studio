/**
 * Import SQL DDL… (`erdStudio.importSqlDdl`) end to end with the real SQL
 * engine (the module `dist/sqlImport.js` is built from, loaded from source):
 * files or a folder → dialect (detected first) → conversion → Import DBML's
 * own flow (layer, name, dry run, write, open), with the funnel keys. Scripts
 * that do not read are the user's, reported with file and line; a missing
 * importer bundle is ours.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import {
  IMPORT_SQL_DDL_COMMAND,
  MAX_SQL_FILES,
  SQL_DIALECT_FEATURES,
  TRY_ANOTHER_DIALECT_BUTTON,
  gatherSqlFiles,
  importSqlDdl,
  type ImportSqlDdlDeps,
  type ImportSqlDdlUi,
  type SqlDialectItem,
  type SqlSources,
} from '../../src/commands/importSqlDdl';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { sqlDialectOfImportArg, type SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import packageJson from '../../package.json';

const FIXTURES = path.join(__dirname, '../fixtures/sql-ddl');

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const errors = () => error.mock.calls.map((c: unknown[]) => c[0]);
const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);

interface SqlRecorder extends ImportSqlDdlUi {
  dialectPicks: SqlDialectItem[][];
  errors: Array<{ message: string; items: string[] }>;
  infos: string[];
  opened: Array<{ filePath: string; line?: number }>;
}

/** The SQL half: answers `sources` and `dialect` (undefined = closes the pick), reads from disk. */
function sqlUi(sources: SqlSources | undefined, dialect?: SqlDialect | ((items: SqlDialectItem[]) => SqlDialect | undefined), button?: string): SqlRecorder {
  const ui: SqlRecorder = {
    dialectPicks: [], errors: [], infos: [], opened: [],
    pickSources: async () => sources,
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items) => {
      ui.dialectPicks.push([...items]);
      const want = typeof dialect === 'function' ? dialect([...items]) : dialect;
      return items.find((i) => i.dialect === want);
    },
    showInformationMessage: async (message) => { ui.infos.push(message); return undefined; },
    showErrorMessage: async (message, ...items) => { ui.errors.push({ message, items }); return button && items.includes(button) ? button : undefined; },
    openFileAt: async (filePath, line) => { ui.opened.push({ filePath, line }); },
    sendFeedback: async () => {},
  };
  return ui;
}

interface ImportRecorder extends ImportDbmlUi {
  confirms: Array<{ message: string; detail: string }>;
  inputs: Array<string | undefined>;
  opened: string[];
  errors: string[];
}

function importUi(answers: { confirm?: boolean; layer?: string } = {}): ImportRecorder {
  const ui: ImportRecorder = {
    confirms: [], inputs: [], opened: [], errors: [],
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === (answers.layer ?? 'gold')) as unknown as T | undefined,
    showInputBox: async (options) => { ui.inputs.push(options.value); return options.value; },
    confirm: async (message, detail) => { ui.confirms.push({ message, detail }); return answers.confirm ?? true; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message) => { ui.errors.push(message); return undefined; },
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async (domainPath) => { ui.opened.push(domainPath); },
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
  return ui;
}

function deps(sql: ImportSqlDdlUi, ui: ImportDbmlUi, more: Partial<ImportSqlDdlDeps> = {}): ImportSqlDdlDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    layerService,
    subjectAreaService,
    tableLibraryService,
    extensionPath: '/nowhere',
    validateDomainName: () => undefined,
    onWritten: () => {},
    sqlUi: sql,
    ui,
    loadSqlImport: () => engine,
    ...more,
  };
}

function erdFiles(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-import-'));
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import SQL DDL… — contributed', () => {
  it('is a palette command with no legacy alias, not pre-registered, and in the + menu after Import DBML…', () => {
    const pkg = packageJson as unknown as {
      contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command?: string; when?: string; group?: string }>> };
    };
    expect(pkg.contributes.commands.find((c) => c.command === IMPORT_SQL_DDL_COMMAND)).toEqual({
      command: IMPORT_SQL_DDL_COMMAND, title: 'Import SQL DDL…', category: 'ERD Studio',
    });
    expect(NO_LEGACY_ALIAS.has(IMPORT_SQL_DDL_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(IMPORT_SQL_DDL_COMMAND)).toBe(false);
    expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === IMPORT_SQL_DDL_COMMAND)).toEqual([{ command: IMPORT_SQL_DDL_COMMAND, when: 'erdStudio.hasProject' }]);
    expect(pkg.contributes.menus['erdStudio.newMenu']).toContainEqual({ command: IMPORT_SQL_DDL_COMMAND, when: 'erdStudio.hasProject', group: '1_diagram@4' });
  });
});

describe('Import SQL DDL…', () => {
  it('a folder of PostgreSQL scripts (keys in a second file): detected dialect first, dry run, then the diagram in DBML', async () => {
    const sql = sqlUi({ folder: path.join(FIXTURES, 'postgres') }, 'postgres');
    const ui = importUi();

    const result = await importSqlDdl(deps(sql, ui));

    // The detected dialect is offered first, marked; all five are offered.
    expect(sql.dialectPicks).toHaveLength(1);
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect: 'postgres', description: 'detected' });
    expect(sql.dialectPicks[0].map((i) => i.dialect).sort()).toEqual(['databricks', 'mysql', 'postgres', 'snowflake', 'sqlserver']);
    // The name comes from the folder; the headline says what the tables came from.
    expect(ui.inputs).toEqual(['postgres']);
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0].message).toBe('Import 4 tables and 3 relationships from 2 SQL files (PostgreSQL) into a new diagram "postgres" in the Gold layer.');
    const detail = ui.confirms[0].detail;
    expect(detail).toContain('3 relationships');
    expect(detail).toMatch(/Layout: The diagram is laid out automatically/);
    expect(detail).not.toContain('erd_layout');
    // What the scripts held besides tables is listed by kind, never the file's text.
    expect(detail).toContain('Not imported:');
    expect(detail).toMatch(/01_tables\.sql: skipped .*session statement/);
    expect(detail).not.toContain('Left out');
    expect(ui.errors).toEqual([]);
    expect(sql.errors).toEqual([]);

    const domainPath = erd('gold', 'diagrams', 'postgres.dbml');
    expect(result?.domainPath).toBe(domainPath);
    expect(ui.opened).toEqual([domainPath]);
    const files = erdFiles();
    expect(files).toContain('gold/diagrams/postgres.dbml');
    // Each table keeps the schema the scripts give it (§2.4).
    expect(files.filter((f) => f.startsWith('gold/tables/'))).toHaveLength(4);
    expect(files.filter((f) => f.startsWith('gold/tables/')).every((f) => f.startsWith('gold/tables/sales/'))).toBe(true);
    // The description says where the diagram came from.
    expect(fs.readFileSync(domainPath, 'utf-8')).toContain('Imported from 2 SQL files in postgres (PostgreSQL).');
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdl']);
    expect(errors()).toEqual([]);
  });

  it.each([
    ['mysql', 'mysql/shop.sql', 'importSqlDialectMysql'],
    ['sqlserver', 'sqlserver/warehouse.sql', 'importSqlDialectSqlserver'],
    ['snowflake', 'snowflake/analytics.sql', 'importSqlDialectSnowflake'],
    ['databricks', 'databricks/lakehouse.sql', 'importSqlDialectDatabricks'],
  ] as const)('one %s script: detected, converted and imported whole', async (dialect, file, key) => {
    const sql = sqlUi({ files: [path.join(FIXTURES, file)] }, dialect);
    const ui = importUi();
    const result = await importSqlDdl(deps(sql, ui));
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect, description: 'detected' });
    expect(result?.plan.newTables).toHaveLength(4);
    expect(result?.plan.report.dropped).toEqual([]);
    expect(result?.plan.report.relationships).toBe(3);
    // A single file names the diagram.
    expect(ui.inputs).toEqual([path.basename(file, '.sql')]);
    expect(ui.confirms[0].message).toContain('from 1 SQL file (');
    expect(features()).toEqual([key, 'importSqlDdl']);
    expect(SQL_DIALECT_FEATURES[dialect]).toBe(key);
  });

  it('scripts that do not read: the problem with file and line, Open File there, nothing written, counted as invalid', async () => {
    const broken = path.join(FIXTURES, 'broken', 'stray_words.sql');
    const sql = sqlUi({ files: [broken] }, 'postgres', 'Open File');
    const ui = importUi();
    expect(await importSqlDdl(deps(sql, ui))).toBeUndefined();
    expect(sql.errors).toHaveLength(1);
    expect(sql.errors[0].message).toMatch(/^Import SQL DDL: nothing was imported\. stray_words\.sql line 6: /);
    expect(sql.errors[0].message).toContain('They were read as PostgreSQL.');
    expect(sql.errors[0].items).toEqual(['Open File', TRY_ANOTHER_DIALECT_BUTTON]);
    await vi.waitFor(() => expect(sql.opened).toEqual([{ filePath: broken, line: 6 }]));
    expect(erdFiles()).toEqual([]);
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdlInvalid']);
    expect(errors()).toEqual([]);
  });

  it('Try Another Dialect reads the same files again, at the dialect pick', async () => {
    let round = 0;
    const sql = sqlUi({ files: [path.join(FIXTURES, 'broken', 'stray_words.sql')] }, () => (round++ === 0 ? 'postgres' : undefined), TRY_ANOTHER_DIALECT_BUTTON);
    let reads = 0;
    const read = sql.readFile;
    sql.readFile = async (p) => { reads++; return read(p); };
    await importSqlDdl(deps(sql, importUi()));
    await vi.waitFor(() => expect(sql.dialectPicks).toHaveLength(2));
    expect(reads).toBe(1);
    await vi.waitFor(() => expect(features()).toContain('importSqlDdlCancelled'));
  });

  it('closing the file dialog or the dialect pick writes nothing and counts a cancel', async () => {
    await importSqlDdl(deps(sqlUi(undefined), importUi()));
    await importSqlDdl(deps(sqlUi({ files: [path.join(FIXTURES, 'mysql', 'shop.sql')] }, undefined), importUi()));
    expect(features()).toEqual(['importSqlDdlCancelled', 'importSqlDdlCancelled']);
    expect(erdFiles()).toEqual([]);
  });

  it('cancelled at the dry run: nothing written, counted as a SQL cancel (not an Import DBML one)', async () => {
    const ui = importUi({ confirm: false });
    expect(await importSqlDdl(deps(sqlUi({ files: [path.join(FIXTURES, 'mysql', 'shop.sql')] }, 'mysql'), ui))).toBeUndefined();
    expect(ui.confirms).toHaveLength(1);
    expect(erdFiles()).toEqual([]);
    expect(features()).toEqual(['importSqlDialectMysql', 'importSqlDdlCancelled']);
  });

  it('no SQL importer (a dev host before npm run build): ours, with Send Feedback, counted as importSqlDdlFailed', async () => {
    const sql = sqlUi({ files: [path.join(FIXTURES, 'mysql', 'shop.sql')] }, 'mysql');
    const run = importSqlDdl(deps(sql, importUi(), { loadSqlImport: () => { throw new Error('ERD Studio could not load its SQL importer (dist/sqlImport.js): missing'); } }));
    expect(await run).toBeUndefined();
    expect(sql.errors[0].message).toMatch(/^Import SQL DDL hit a problem in ERD Studio while loading its SQL importer/);
    expect(sql.errors[0].items).toEqual(['Send Feedback']);
    expect(errors()).toEqual(['importSqlDdlFailed']);
  });

  it('converted DBML that does not read back is ours: Send Feedback, importSqlDdlFailed, never "invalid"', async () => {
    const broken = { ...engine, sqlDdlToDbml: () => ({ ok: true as const, dbml: 'Table t {\n  id int [pk\n', tableCount: 1, refCount: 0, skipped: [], notes: [] }) };
    const ui = importUi();
    const run = await importSqlDdl(deps(sqlUi({ files: [path.join(FIXTURES, 'mysql', 'shop.sql')] }, 'mysql'), ui, { loadSqlImport: () => broken }));
    expect(run).toBeUndefined();
    expect(ui.errors[0]).toMatch(/^Import SQL DDL hit a problem in ERD Studio while reading the converted model/);
    expect(errors()).toEqual(['importSqlDdlFailed']);
    expect(features()).toEqual(['importSqlDialectMysql']);
    expect(erdFiles()).toEqual([]);
  });

  it('a folder with no .sql files says so, and imports nothing', async () => {
    fs.mkdirSync(path.join(tmp, 'empty'));
    const sql = sqlUi({ folder: path.join(tmp, 'empty') }, 'postgres');
    await importSqlDdl(deps(sql, importUi()));
    expect(sql.infos).toEqual(['Import SQL DDL: empty has no .sql files, so there is nothing to import.']);
    expect(sql.dialectPicks).toEqual([]);
  });
});

describe('gatherSqlFiles', () => {
  const ui = sqlUi(undefined);

  it('reads every .sql under a folder in name order, named by path under it, skipping tool folders', async () => {
    const root = path.join(tmp, 'ddl');
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, '10_keys.sql'), 'ALTER TABLE t ADD PRIMARY KEY (id);');
    fs.writeFileSync(path.join(root, '2_tables.sql'), '﻿CREATE TABLE t (id int);');
    fs.writeFileSync(path.join(root, 'b', 'more.SQL'), 'CREATE TABLE u (id int);');
    fs.writeFileSync(path.join(root, 'notes.md'), '# not SQL');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'dep.sql'), 'CREATE TABLE dep (id int);');
    const read = await gatherSqlFiles({ folder: root }, ui);
    if ('message' in read) throw new Error(read.message);
    expect(read.files.map((f) => f.name)).toEqual(['2_tables.sql', '10_keys.sql', 'b/more.SQL']);
    // A byte-order mark is not SQL.
    expect(read.files[0].text.startsWith('CREATE')).toBe(true);
    expect(read.fileName).toBe('ddl.dbml');
    expect(read.sourceLabel).toBe('3 SQL files in ddl');
  });

  it('refuses a folder with more than the bound', async () => {
    const root = path.join(tmp, 'many');
    fs.mkdirSync(root);
    for (let i = 0; i <= MAX_SQL_FILES; i++) fs.writeFileSync(path.join(root, `${i}.sql`), '');
    const read = await gatherSqlFiles({ folder: root }, ui);
    expect(read).toMatchObject({ error: true });
    expect('message' in read && read.message).toContain(`more than ${MAX_SQL_FILES} .sql files`);
  });

  it('a file it cannot read is named', async () => {
    const read = await gatherSqlFiles({ files: [path.join(tmp, 'gone.sql')] }, ui);
    expect(read).toMatchObject({ error: true, message: expect.stringContaining("couldn't read gone.sql") });
  });
});

describe('Import SQL DDL… with a dialect chosen ({ dialect }: the import guide\'s SQL cards)', () => {
  it('accepts exactly { dialect: <a dialect it reads> }; anything else is the step-by-step flow, and { quick } wins', () => {
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks'] as const) {
      expect(sqlDialectOfImportArg({ dialect })).toBe(dialect);
    }
    for (const arg of [
      undefined, null, 'databricks', ['databricks'], [{ dialect: 'databricks' }], {}, { dialect: 'oracle' }, { dialect: 'bigquery' },
      { dialect: 'Databricks' }, { dialect: 1 }, { dialect: { toString: () => 'mysql' } }, { quick: true }, { quick: true, dialect: 'mysql' },
    ]) {
      expect(sqlDialectOfImportArg(arg), JSON.stringify(arg)).toBeUndefined();
    }
  });

  it('reads the scripts as that dialect without asking: Databricks notebook output (the guide\'s snippet) becomes a diagram', async () => {
    const sql = sqlUi({ files: [path.join(FIXTURES, 'databricks-notebook/schema.sql')] }, 'postgres');
    const ui = importUi();
    const result = await importSqlDdl(deps(sql, ui), undefined, { dialect: 'databricks', dialectChosen: true });
    expect(sql.dialectPicks).toEqual([]);
    expect(result).toBeDefined();
    expect(features()).toContain(SQL_DIALECT_FEATURES.databricks);
    expect(ui.confirms[0].message).toContain('(Databricks / Spark SQL)');
    expect(erdFiles()).toEqual(expect.arrayContaining(['gold/tables/sales/customers.dbml', 'gold/tables/sales/orders.dbml']));
    expect(fs.readFileSync(erd('gold/tables/sales/orders.dbml'), 'utf-8')).toContain('order_id');
  });

  it('a Fabric Warehouse script (SSMS, GO batches, NOT ENFORCED keys) reads as SQL Server, keys and the foreign key kept', async () => {
    const sql = sqlUi({ files: [path.join(FIXTURES, 'fabric-warehouse/warehouse.sql')] });
    const ui = importUi();
    await importSqlDdl(deps(sql, ui), undefined, { dialect: 'sqlserver', dialectChosen: true });
    expect(sql.dialectPicks).toEqual([]);
    expect(ui.confirms[0].message).toMatch(/^Import 2 tables and 1 relationship from 1 SQL file \(SQL Server \/ Azure SQL\)/);
    expect(fs.readFileSync(erd('gold/tables/dbo/dim_customer.dbml'), 'utf-8')).toMatch(/customer_id.*\[pk\]/);
  });

  it('scripts that do not read as the chosen dialect: the problem, and Try Another Dialect asks which', async () => {
    const files = [path.join(FIXTURES, 'fabric-warehouse/warehouse.sql')];
    const sql = sqlUi({ files }, 'sqlserver', TRY_ANOTHER_DIALECT_BUTTON);
    const ui = importUi();
    await importSqlDdl(deps(sql, ui), undefined, { dialect: 'postgres', dialectChosen: true });
    await vi.waitFor(() => expect(sql.dialectPicks).toHaveLength(1));
    expect(sql.errors[0].message).toContain('They were read as PostgreSQL.');
    expect(sql.errors[0].items).toContain(TRY_ANOTHER_DIALECT_BUTTON);
  });

  it('without dialectChosen, a preset dialect is only offered first (Change Options…), still asked', async () => {
    const sql = sqlUi({ files: [path.join(FIXTURES, 'fabric-warehouse/warehouse.sql')] }, 'sqlserver');
    await importSqlDdl(deps(sql, importUi()), undefined, { dialect: 'mysql' });
    expect(sql.dialectPicks).toHaveLength(1);
    expect(sql.dialectPicks[0][0].dialect).toBe('mysql');
  });
});
