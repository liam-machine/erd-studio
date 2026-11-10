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
  MAX_SQL_CHARS,
  dialectPickRows,
  gatherSqlFiles,
  importSqlDdl,
  type ImportSqlDdlDeps,
  type ImportSqlDdlUi,
  type SqlDialectItem,
  type SqlPartitionItem,
  type SqlSources,
} from '../../src/commands/importSqlDdl';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { sqlDialectOfImportArg, type SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { SHOW_LOGS_BUTTON } from '../../src/services/showLogs';
import packageJson from '../../package.json';
import { decodeText } from '../../src/services/readFileStart';
import { log } from '../../src/services/logger';

const FIXTURES = path.join(__dirname, '../fixtures/sql-ddl');

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const errors = () => error.mock.calls.map((c: unknown[]) => c[0]);
const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);

interface SqlRecorder extends ImportSqlDdlUi {
  dialectPicks: SqlDialectItem[][];
  /** The options each dialect pick was shown with (its placeholder says why when no dialect reads a table). */
  pickOptions: vscode.QuickPickOptions[];
  errors: Array<{ message: string; items: string[] }>;
  infos: string[];
  opened: Array<{ filePath: string; line?: number }>;
  logsShown: number;
}

/** A script no dialect reads a table of: an empty column definition (two commas) is a syntax error in every one. */
const UNREADABLE_SQL = '-- broken\n\nCREATE TABLE t (\n  id int,,\n  x int\n);\n';
/** A script only MySQL reads: `#` starts a comment there, and the comment's parenthesis never closes elsewhere. */
const MYSQL_ONLY_SQL = 'CREATE TABLE t (\n  id int, # the key (see the docs\n  name varchar(10)\n);\n';

/** The SQL half: answers `sources` and `dialect` (undefined = closes the pick), reads from disk. */
function sqlUi(sources: SqlSources | undefined, dialect?: SqlDialect | ((items: SqlDialectItem[]) => SqlDialect | undefined), button?: string): SqlRecorder {
  const ui: SqlRecorder = {
    dialectPicks: [], pickOptions: [], errors: [], infos: [], opened: [], logsShown: 0,
    pickSources: async () => sources,
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items, options) => {
      ui.dialectPicks.push([...items]);
      ui.pickOptions.push(options);
      const want = typeof dialect === 'function' ? dialect([...items]) : dialect;
      return items.find((i) => i.dialect === want);
    },
    showInformationMessage: async (message) => { ui.infos.push(message); return undefined; },
    showErrorMessage: async (message, ...items) => { ui.errors.push({ message, items }); return button && items.includes(button) ? button : undefined; },
    openFileAt: async (filePath, line) => { ui.opened.push({ filePath, line }); },
    sendFeedback: async () => {},
    showLogs: async () => { ui.logsShown++; },
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
    // Every dialect is labelled by how many of the tables it reads, the detected one marked first.
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect: 'postgres', description: 'detected · reads all 4 tables', detected: true });
    expect(sql.dialectPicks[0].filter((i) => i.detected).map((i) => i.dialect)).toEqual(['postgres']);
    expect(sql.dialectPicks[0].map((i) => i.dialect).sort()).toEqual(['bigquery', 'databricks', 'mysql', 'oracle', 'postgres', 'redshift', 'snowflake', 'sqlite', 'sqlserver']);
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
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect, description: 'detected · reads all 4 tables' });
    expect(result?.plan.newTables).toHaveLength(4);
    // FK actions travel on the Ref, so Import's reference-settings report lists them; nothing else is dropped.
    expect(result?.plan.report.dropped.filter((d) => d.kind !== 'reference-settings')).toEqual([]);
    expect(result?.plan.report.relationships).toBe(3);
    // A single file names the diagram.
    expect(ui.inputs).toEqual([path.basename(file, '.sql')]);
    expect(ui.confirms[0].message).toContain('from 1 SQL file (');
    expect(features()).toEqual([key, 'importSqlDdl']);
    expect(SQL_DIALECT_FEATURES[dialect]).toBe(key);
  });

  it('one table that does not read never stops the rest: the others import, the problem is logged, listed and counted as invalid', async () => {
    const broken = path.join(FIXTURES, 'broken', 'stray_words.sql');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = sqlUi({ files: [broken] }, 'postgres');
    const ui = importUi();
    const result = await importSqlDdl(deps(sql, ui));
    expect(sql.errors).toEqual([]);
    expect(result?.plan.newTables.map((t) => t.name)).toEqual(['dim_customer']);
    // The dry run says what was not imported, with the table and its line.
    expect(ui.confirms[0].detail).toMatch(/Not imported:[\s\S]*1 table: CREATE TABLE could not be read: a syntax error \(Show Logs has each line\) \(fct_order\)/);
    // Every problem is in the log with its file and line.
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/Import SQL DDL \(PostgreSQL\): stray_words\.sql line 6: CREATE TABLE fct_order could not be read: unexpected "oops"/));
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdlInvalid', 'importSqlInvalidParse', 'importSqlRejectedCreateTable', 'importSqlFailPostgres', 'importSqlDdl']);
  });

  it('scripts no dialect reads: the problem with file and line, Open File there and Show Logs, no Try Another Dialect, nothing written', async () => {
    const file = path.join(tmp, 'broken.sql');
    fs.writeFileSync(file, UNREADABLE_SQL);
    const sql = sqlUi({ files: [file] }, 'postgres', 'Open File');
    const ui = importUi();
    expect(await importSqlDdl(deps(sql, ui))).toBeUndefined();
    // The pick said why before asking: no dialect reads a table, and the first problem.
    expect(sql.pickOptions[0].placeHolder).toMatch(/^No dialect reads a table in the script \(broken\.sql line 4: CREATE TABLE t could not be read: an empty column definition/);
    expect(sql.dialectPicks[0].every((i) => /^reads none|^does not read/.test(String(i.description)))).toBe(true);
    expect(sql.dialectPicks[0].some((i) => /detected/.test(String(i.description)))).toBe(false);
    expect(sql.dialectPicks[0].some((i) => i.detected)).toBe(false);
    expect(sql.errors).toHaveLength(1);
    expect(sql.errors[0].message).toMatch(/^Import SQL DDL: nothing was imported\. broken\.sql line 4: /);
    expect(sql.errors[0].message).toContain('They were read as PostgreSQL.');
    // No dialect reads more, so there is no Try Another Dialect.
    expect(sql.errors[0].items).toEqual(['Open File', SHOW_LOGS_BUTTON]);
    await vi.waitFor(() => expect(sql.opened).toEqual([{ filePath: file, line: 4 }]));
    expect(erdFiles()).toEqual([]);
    // Why, as fixed keys: the problem kind, the clause the parser rejected, the dialect it was read as.
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdlInvalid', 'importSqlInvalidParse', 'importSqlRejectedCreateTable', 'importSqlFailPostgres']);
    expect(errors()).toEqual([]);
  });

  it('Show Logs on a failed import opens the log', async () => {
    const file = path.join(tmp, 'broken.sql');
    fs.writeFileSync(file, UNREADABLE_SQL);
    const sql = sqlUi({ files: [file] }, 'postgres', SHOW_LOGS_BUTTON);
    await importSqlDdl(deps(sql, importUi()));
    await vi.waitFor(() => expect(sql.logsShown).toBe(1));
  });

  it('the pick labels every dialect by the tables it reads; Try Another Dialect only when another reads more, and reads the same files again', async () => {
    const file = path.join(tmp, 'notes.sql');
    fs.writeFileSync(file, MYSQL_ONLY_SQL);
    let round = 0;
    const sql = sqlUi({ files: [file] }, () => (round++ === 0 ? 'postgres' : undefined), TRY_ANOTHER_DIALECT_BUTTON);
    let reads = 0;
    const read = sql.readFile;
    sql.readFile = async (p) => { reads++; return read(p); };
    await importSqlDdl(deps(sql, importUi()));
    // MySQL reads the table, so it is offered first; PostgreSQL reads none.
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect: 'mysql', description: 'reads the table' });
    expect(sql.dialectPicks[0].find((i) => i.dialect === 'postgres')?.description).toBe('does not read the table');
    expect(sql.errors[0].items).toContain(TRY_ANOTHER_DIALECT_BUTTON);
    await vi.waitFor(() => expect(sql.dialectPicks).toHaveLength(2));
    expect(reads).toBe(1);
    await vi.waitFor(() => expect(features()).toContain('importSqlDdlCancelled'));
    expect(features()).toContain('importSqlTryAnotherDialect');
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

  it('no SQL importer (a dev host before npm run build): ours, with Send Feedback, counted as importSqlEngineLoadFailed', async () => {
    const sql = sqlUi({ files: [path.join(FIXTURES, 'mysql', 'shop.sql')] }, 'mysql');
    const run = importSqlDdl(deps(sql, importUi(), { loadSqlImport: () => { throw new Error('ERD Studio could not load its SQL importer (dist/sqlImport.js): missing'); } }));
    expect(await run).toBeUndefined();
    expect(sql.errors[0].message).toMatch(/^Import SQL DDL hit a problem in ERD Studio while loading its SQL importer/);
    expect(sql.errors[0].items).toEqual(['Send Feedback']);
    // Its own code, not folded into importSqlDdlFailed: a VSIX missing dist/sqlImport.js shows up as exactly this.
    expect(errors()).toEqual(['importSqlEngineLoadFailed']);
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

  it('one labelling rule for every entry point: a file under the open folder is named by its path under it (picked files, a folder, the quick path)', async () => {
    fs.mkdirSync(path.join(tmp, 'project', 'scripts'), { recursive: true });
    const file = path.join(tmp, 'project', 'scripts', '02_schema.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id int);');
    const root = path.join(tmp, 'project');
    const picked = await gatherSqlFiles({ files: [file] }, ui, root);
    const folder = await gatherSqlFiles({ folder: path.join(root, 'scripts') }, ui, root);
    const quick = await gatherSqlFiles({ files: [file], root }, ui, root);
    for (const read of [picked, folder, quick]) {
      if ('message' in read) throw new Error(read.message);
      expect(read.files.map((f) => f.name)).toEqual(['scripts/02_schema.sql']);
      expect(read.fullPaths.get('scripts/02_schema.sql')).toBe(file);
    }
    // Outside the open folder, the old names: the base name of a picked file.
    const outside = await gatherSqlFiles({ files: [file] }, ui, path.join(tmp, 'elsewhere'));
    expect('message' in outside ? [] : outside.files.map((f) => f.name)).toEqual(['02_schema.sql']);
  });

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
    expect(read).toMatchObject({ error: true, limit: 'tooManyFiles' });
    expect('message' in read && read.message).toContain(`more than ${MAX_SQL_FILES} .sql files`);
  });

  it('a dump\'s data does not count toward the SQL limit, nor is it read: a 25 MB pg_dump with COPY rows imports', async () => {
    const file = path.join(tmp, 'prod.sql');
    const row = '1\tuser@example.com\t2026-01-01 00:00:00+00\n';
    const head = 'CREATE TABLE public.customer (\n  customer_id integer NOT NULL,\n  email text\n);\nCOPY public.customer (customer_id, email, created_at) FROM stdin;\n';
    fs.writeFileSync(file, head + row.repeat(Math.ceil((25 * 1024 * 1024) / row.length)) + '\\.\n\nALTER TABLE ONLY public.customer ADD CONSTRAINT customer_pkey PRIMARY KEY (customer_id);\n');
    const read = await gatherSqlFiles({ files: [file] }, ui);
    if ('message' in read) throw new Error(read.message);
    expect(read.files[0].text.length).toBeLessThan(MAX_SQL_CHARS);
    expect(read.files[0].text).toContain('ADD CONSTRAINT customer_pkey');
    expect(read.files[0].text).not.toContain('user@example.com');
  });

  it('a file larger than it reads at all is refused before reading, with how to export the schema alone', async () => {
    const file = path.join(tmp, 'huge.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id int);');
    const read = await gatherSqlFiles({ files: [file] }, { ...ui, fileSize: async () => 300 * 1024 * 1024, readFile: async () => { throw new Error('never read'); } });
    expect(read).toMatchObject({ error: true, limit: 'fileTooBig', message: expect.stringContaining('huge.sql is larger than 200 MB') });
    expect('message' in read && read.message).toContain('pg_dump --schema-only');
  });

  it('reads a UTF-16 script (SQL Server Management Studio\'s Generate Scripts) by its byte order mark, little or big endian', () => {
    const sql = 'CREATE TABLE [dbo].[Customer](\r\n\t[Id] [int] NOT NULL\r\n)\r\nGO\r\n';
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sql, 'utf16le')]);
    const be = Buffer.from(le.subarray(2)).swap16();
    expect(decodeText(le)).toBe(sql);
    expect(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))).toBe(sql);
    // No mark, but every other byte zero: UTF-16 all the same.
    expect(decodeText(Buffer.from(sql, 'utf16le'))).toBe(sql);
    expect(decodeText(Buffer.from(`\ufeff${sql}`, 'utf8'))).toBe(sql);
    expect(decodeText(Buffer.from('CREATE TABLE café (id int);', 'utf8'))).toBe('CREATE TABLE café (id int);');
  });

  it('a file it cannot read is named', async () => {
    const read = await gatherSqlFiles({ files: [path.join(tmp, 'gone.sql')] }, ui);
    expect(read).toMatchObject({ error: true, limit: 'unreadable', message: expect.stringContaining("couldn't read gone.sql") });
  });
});

describe('Import SQL DDL… with a dialect chosen ({ dialect }: the import guide\'s SQL cards)', () => {
  it('accepts exactly { dialect: <a dialect it reads> }; anything else is the step-by-step flow, and { quick } wins', () => {
    for (const dialect of ['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks', 'oracle', 'bigquery', 'redshift', 'sqlite'] as const) {
      expect(sqlDialectOfImportArg({ dialect })).toBe(dialect);
    }
    for (const arg of [
      undefined, null, 'databricks', ['databricks'], [{ dialect: 'databricks' }], {}, { dialect: 'db2' }, { dialect: 'teradata' },
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
    const file = path.join(tmp, 'notes.sql');
    fs.writeFileSync(file, MYSQL_ONLY_SQL);
    const files = [file];
    const sql = sqlUi({ files }, 'mysql', TRY_ANOTHER_DIALECT_BUTTON);
    const ui = importUi();
    await importSqlDdl(deps(sql, ui), undefined, { dialect: 'postgres', dialectChosen: true });
    await vi.waitFor(() => expect(sql.dialectPicks).toHaveLength(1));
    // Asked, the dialect that reads the table leads the pick, and the import goes on as it.
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect: 'mysql', description: 'reads the table' });
    await vi.waitFor(() => expect(ui.confirms).toHaveLength(1));
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

describe('Import SQL DDL… — why it did not import (telemetry, fixed keys only)', () => {
  it('a COMMENT ON run into the CREATE TABLE before it (no semicolon) is a statement of its own: imported whole, the comment kept', async () => {
    const file = path.join(tmp, 'glued.sql');
    fs.writeFileSync(file, "CREATE TABLE a (id int)\nCOMMENT ON TABLE a IS 'the a table';\n");
    const result = await importSqlDdl(deps(sqlUi({ files: [file] }, 'postgres'), importUi()));
    expect(result?.plan.newTables[0]).toMatchObject({ name: 'a', description: 'the a table' });
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdl']);
  });

  it('a table defined twice records its kind (no clause: nothing was rejected by the grammar); the first definition imports', async () => {
    const file = path.join(tmp, 'twice.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id int);\nCREATE TABLE a (id int);\n');
    const result = await importSqlDdl(deps(sqlUi({ files: [file] }, 'mysql'), importUi()));
    expect(result?.plan.newTables.map((t) => t.name)).toEqual(['a']);
    expect(features()).toEqual(['importSqlDialectMysql', 'importSqlDdlInvalid', 'importSqlInvalidDuplicateTable', 'importSqlFailMysql', 'importSqlDdl']);
  });

  it('a file too big to read records importLimitFileTooBig beside the message', async () => {
    const file = path.join(tmp, 'huge.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id int);');
    const sql = { ...sqlUi({ files: [file] }, 'postgres'), fileSize: async () => 300 * 1024 * 1024 };
    await importSqlDdl(deps(sql, importUi()));
    expect(features()).toEqual(['importLimitFileTooBig']);
  });
});

describe('Import SQL DDL… — partitions (fold them into their parents, or keep each as a table)', () => {
  const PARTITIONED = [
    'CREATE TABLE payment (id int NOT NULL, at date NOT NULL, PRIMARY KEY (id, at)) PARTITION BY RANGE (at);',
    "CREATE TABLE payment_2024 PARTITION OF payment FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
    'CREATE TABLE payment_2025 (id int NOT NULL, at date NOT NULL);',
    "ALTER TABLE ONLY payment ATTACH PARTITION payment_2025 FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
  ].join('\n');

  /** The SQL UI with a partitions step that answers `mode` (undefined: closes the pick). */
  function partitionUi(file: string, mode: 'fold' | 'tables' | undefined) {
    const picks: Array<{ items: SqlPartitionItem[]; options: vscode.QuickPickOptions }> = [];
    const sql = {
      ...sqlUi({ files: [file] }, 'postgres'),
      pickPartitions: async (items: readonly SqlPartitionItem[], options: vscode.QuickPickOptions) => {
        picks.push({ items: [...items], options });
        return items.find((i) => i.mode === mode);
      },
    };
    return { sql, picks };
  }

  it('asks once, fold first and recommended; folding imports the parent alone, each partition said', async () => {
    const file = path.join(tmp, 'payments.sql');
    fs.writeFileSync(file, PARTITIONED);
    const { sql, picks } = partitionUi(file, 'fold');
    const ui = importUi();
    const info = vi.spyOn(log, 'info');
    const result = await importSqlDdl(deps(sql, ui));
    expect(picks).toHaveLength(1);
    expect(picks[0].items.map((i) => [i.mode, i.label, i.description])).toEqual([
      ['fold', 'Fold partitions into their parent tables', 'recommended · 2 partitions are the parent\'s rows'],
      ['tables', 'Keep each partition as a table', '2 more tables, each with its parent\'s columns'],
    ]);
    expect(picks[0].options.placeHolder).toMatch(/^The scripts hold 2 partitions with no columns of their own \(PARTITION OF, ATTACH PARTITION, INHERITS\)\. Fold them into their parents\?$/);
    expect(result?.plan.newTables.map((t) => t.name)).toEqual(['payment']);
    // Each folded partition is logged with its file and line.
    const logged = info.mock.calls.map((c) => String(c[0])).filter((l) => /partitions of payment/.test(l));
    expect(logged).toEqual([
      expect.stringMatching(/payments\.sql line 2: table payment_2024: changed, other: partitions of payment \(folded into payment \(PARTITION OF: the parent's rows\)\)$/),
      expect.stringMatching(/payments\.sql line 3: table payment_2025: changed, other: partitions of payment \(folded into payment \(ATTACH PARTITION: the parent's rows\)\)$/),
    ]);
  });

  it('keeping them imports each partition as a table with its parent\'s columns', async () => {
    const file = path.join(tmp, 'payments.sql');
    fs.writeFileSync(file, PARTITIONED);
    const { sql } = partitionUi(file, 'tables');
    const result = await importSqlDdl(deps(sql, importUi()));
    expect(result?.plan.newTables.map((t) => t.name).sort()).toEqual(['payment', 'payment_2024', 'payment_2025']);
    expect(result?.plan.newTables.find((t) => t.name === 'payment_2024')?.columns?.map((c) => c.name)).toEqual(['id', 'at']);
  });

  it('closing the pick cancels and writes nothing; scripts without partitions are never asked', async () => {
    const file = path.join(tmp, 'payments.sql');
    fs.writeFileSync(file, PARTITIONED);
    const { sql, picks } = partitionUi(file, undefined);
    const ui = importUi();
    expect(await importSqlDdl(deps(sql, ui))).toBeUndefined();
    expect(picks).toHaveLength(1);
    expect(ui.confirms).toEqual([]);
    expect(erdFiles()).toEqual([]);
    expect(features()).toContain('importSqlDdlCancelled');

    const plain = path.join(tmp, 'plain.sql');
    fs.writeFileSync(plain, 'CREATE TABLE a (id int);');
    const other = partitionUi(plain, 'tables');
    expect(await importSqlDdl(deps(other.sql, importUi()))).toBeDefined();
    expect(other.picks).toEqual([]);
  });

  it('Change Options…: the answer read before is offered first', async () => {
    const file = path.join(tmp, 'payments.sql');
    fs.writeFileSync(file, PARTITIONED);
    const { sql, picks } = partitionUi(file, 'fold');
    await importSqlDdl(deps(sql, importUi()), undefined, { partitions: 'tables' });
    expect(picks[0].items.map((i) => [i.mode, i.description])).toEqual([
      ['tables', 'read this way before · 2 more tables, each with its parent\'s columns'],
      ['fold', 'recommended · 2 partitions are the parent\'s rows'],
    ]);
  });
});

describe('the dialect pick as shown (dialectPickRows)', () => {
  const pg: SqlDialectItem = { label: 'PostgreSQL', description: 'detected · reads all 4 tables', dialect: 'postgres', detected: true };
  const my: SqlDialectItem = { label: 'MySQL / MariaDB', description: 'reads 3 of 4 tables', dialect: 'mysql' };
  const ms: SqlDialectItem = { label: 'SQL Server / Azure SQL', dialect: 'sqlserver' };
  const SEPARATOR = -1; // vscode.QuickPickItemKind.Separator

  it('the detected dialect first: a heading of its own, a check icon, then the others under theirs', () => {
    const rows = dialectPickRows([pg, my, ms]);
    expect(rows.map((r) => r.label)).toEqual(['Detected from your SQL', '$(pass-filled) PostgreSQL', 'Other dialects', 'MySQL / MariaDB', 'SQL Server / Azure SQL']);
    expect(rows.map((r) => r.kind === SEPARATOR)).toEqual([true, false, true, false, false]);
    // The description and the dialect are kept; the items passed in are not changed.
    expect(rows[1]).toMatchObject({ dialect: 'postgres', description: 'detected · reads all 4 tables' });
    expect(pg.label).toBe('PostgreSQL');
  });

  it('only the detected dialect: its heading and no empty "Other dialects"', () => {
    expect(dialectPickRows([pg]).map((r) => r.label)).toEqual(['Detected from your SQL', '$(pass-filled) PostgreSQL']);
  });

  it('a dialect that reads more comes first: the detected one keeps its icon, no headings', () => {
    expect(dialectPickRows([my, pg, ms]).map((r) => r.label)).toEqual(['MySQL / MariaDB', '$(pass-filled) PostgreSQL', 'SQL Server / Azure SQL']);
  });

  it('nothing detected: the items as they are', () => {
    expect(dialectPickRows([my, ms])).toEqual([my, ms]);
  });
});
