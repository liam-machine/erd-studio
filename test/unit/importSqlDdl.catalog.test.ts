/**
 * Import SQL DDL… with a catalog export picked (`.csv` / `.tsv`, a catalog
 * query's result, one row per column): no dialect pick, the same Import
 * DBML flow (layer, name, dry run or draft, write, open) and the same
 * telemetry keys as converted SQL, no new key. A file that is not a catalog
 * export, is cut short or mixes with `.sql` files is refused and writes
 * nothing. A folder's walk still reads `.sql` files only.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlDeps, type ImportSqlDdlUi, type SqlDialectItem, type SqlSources } from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { MAX_CATALOG_CHARS } from '../../src/services/catalogCsvImport';
import { fakeDraftPreview } from './helpers/draftDriver';

const FIXTURES = path.join(__dirname, '../fixtures/catalog-csv');
const SQL_FIXTURES = path.join(__dirname, '../fixtures/sql-ddl');

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const features = (): string[] => feature.mock.calls.map((c: unknown[]) => c[0] as string);
const erd = (...parts: string[]): string => path.join(tmp, '.erd-studio', ...parts);

interface SqlRecorder extends ImportSqlDdlUi {
  dialectPicks: SqlDialectItem[][];
  errors: Array<{ message: string; items: string[] }>;
  infos: string[];
  read: string[];
}

function sqlUi(sources: SqlSources | undefined, sizes: Record<string, number> = {}): SqlRecorder {
  const ui: SqlRecorder = {
    dialectPicks: [], errors: [], infos: [], read: [],
    pickSources: async () => sources,
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => { ui.read.push(path.basename(filePath)); return fs.readFileSync(filePath, 'utf-8'); },
    fileSize: async (filePath) => sizes[path.basename(filePath)] ?? fs.statSync(filePath).size,
    pickDialect: async (items) => { ui.dialectPicks.push([...items]); return items[0]; },
    showInformationMessage: async (message) => { ui.infos.push(message); return undefined; },
    showErrorMessage: async (message, ...items) => { ui.errors.push({ message, items }); return undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showLogs: async () => {},
  };
  return ui;
}

interface ImportRecorder extends ImportDbmlUi {
  confirms: Array<{ message: string; detail: string }>;
  inputs: Array<string | undefined>;
  opened: string[];
  errors: string[];
}

function importUi(): ImportRecorder {
  const ui: ImportRecorder = {
    confirms: [], inputs: [], opened: [], errors: [],
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => { ui.inputs.push(options.value); return options.value; },
    confirm: async (message, detail) => { ui.confirms.push({ message, detail }); return true; },
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
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    extensionPath: '/nowhere', validateDomainName: () => undefined, onWritten: () => {},
    sqlUi: sql, ui, loadSqlImport: () => engine, ...more,
  };
}

function erdFiles(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[]).filter((f) => fs.statSync(erd(f)).isFile()).map((f) => f.split(path.sep).join('/')).sort();
}

/** A file in the open folder (named by its path under it, as a picked file is). */
function inFolder(name: string, text: string): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-catalog-import-'));
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  vi.spyOn(telemetry, 'featureQuiet');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import SQL DDL… with a catalog export', () => {
  it('the Databricks download: no dialect pick, Import DBML\'s dry run, then the diagram in DBML; counted as an Import SQL DDL', async () => {
    const csv = inFolder('exports/probe.csv', fs.readFileSync(path.join(FIXTURES, 'databricks/probe.csv'), 'utf-8'));
    const sql = sqlUi({ files: [csv] });
    const ui = importUi();
    const result = await importSqlDdl(deps(sql, ui));

    expect(sql.dialectPicks).toEqual([]);
    expect(ui.confirms).toHaveLength(1);
    expect(ui.confirms[0].message).toBe('Import 12 tables and 9 relationships from a catalog export (exports/probe.csv) into a new diagram "probe" in the Gold layer.');
    expect(ui.confirms[0].detail).toMatch(/Not imported:[\s\S]*1 view \(table_type says so\)/);
    expect(sql.errors).toEqual([]);
    expect(ui.errors).toEqual([]);
    expect(result?.domainPath).toBe(erd('gold', 'diagrams', 'probe.dbml'));
    const files = erdFiles();
    expect(files.filter((f) => /\/tables\//.test(f))).toHaveLength(12);
    expect(files).toContain('gold/diagrams/probe.dbml');
    const orders = fs.readFileSync(erd('gold', 'tables', 'probe_sales', 'order_line_note.dbml'), 'utf-8');
    expect(orders).toContain('Table probe_sales.order_line_note');
    // The same keys as converted SQL, and no dialect key: the export has none.
    expect(features()).toContain('importSqlDdl');
    expect(features().filter((k) => k.startsWith('importSqlDialect'))).toEqual([]);
    expect(features()).not.toContain('importSqlDdlInvalid');
    expect(error).not.toHaveBeenCalled();
  });

  it('from the import guide\'s Databricks card (the dialect chosen): the CSV is read as a catalog export all the same', async () => {
    const csv = inFolder('probe.csv', fs.readFileSync(path.join(FIXTURES, 'databricks/probe.csv'), 'utf-8'));
    const ui = importUi();
    await importSqlDdl(deps(sqlUi({ files: [csv] }), ui), undefined, { dialect: 'databricks', dialectChosen: true });
    expect(ui.confirms[0]?.message).toMatch(/^Import 12 tables and 9 relationships from a catalog export \(probe\.csv\)/);
  });

  it('MySQL\'s tab-separated output (.tsv) reads too', async () => {
    const tsv = inFolder('catalog.tsv', fs.readFileSync(path.join(FIXTURES, 'mysql/sakila.tsv'), 'utf-8'));
    const ui = importUi();
    await importSqlDdl(deps(sqlUi({ files: [tsv] }), ui));
    expect(ui.confirms[0]?.message).toBe('Import 16 tables and 22 relationships from a catalog export (catalog.tsv) into a new diagram "sakila" in the Gold layer.');
  });

  it('a file with no key columns: the draft\'s banner says what the file did not carry, never that the tables have no keys', async () => {
    const csv = inFolder('columns.csv', 'table_schema,table_name,column_name,data_type,is_nullable\nsales,orders,id,int,NO\nsales,orders,customer_id,int,YES\n');
    const preview = fakeDraftPreview(['keep']);
    await importSqlDdl(deps(sqlUi({ files: [csv] }), importUi(), { draft: { preview, trigger: 'palette' } }));
    const shown = preview.drafts[0];
    expect(shown.banner.headline).toBe('Draft from a catalog export (columns.csv) · 1 table, no relationships · not saved');
    expect(shown.banner.notice).toBe('This file has no key columns, so its tables came in without primary keys, unique keys or relationships. The catalog queries in ERD Studio: Bring In Your Data Model… include them.');
    expect(JSON.stringify(shown)).not.toMatch(/(tables|model) (have|has) no (primary )?keys/i);
    expect(preview.settled).toEqual([{ kept: true }]);
    // A generic download name names the diagram after the tables' schema.
    expect(shown.keep).toMatchObject({ target: { name: 'sales' } });
  });

  it('a dbt seed is not a catalog export: refused with what it lacks and where to find a query, nothing written, counted as the user\'s file', async () => {
    const seed = inFolder('seeds/customers.csv', 'id,first_name,email\n1,Ada,ada@example.com\n');
    const sql = sqlUi({ files: [seed] });
    const ui = importUi();
    expect(await importSqlDdl(deps(sql, ui))).toBeUndefined();
    expect(sql.errors).toHaveLength(1);
    expect(sql.errors[0].message).toBe('Import SQL DDL: seeds/customers.csv is not a catalog export ERD Studio can read: it has no table_name, no column_name, no data_type column. Its first line is read as the column names: id, first_name, email. The queries in ERD Studio: Bring In Your Data Model… write one.');
    expect(sql.errors[0].items).toContain('Open File');
    expect(ui.confirms).toEqual([]);
    expect(erdFiles()).toEqual([]);
    expect(features()).toContain('importSqlDdlInvalid');
    expect(error).not.toHaveBeenCalled();
  });

  it('a download cut short (total_rows) is refused, nothing written', async () => {
    const full = fs.readFileSync(path.join(FIXTURES, 'postgres/pagila.csv'), 'utf-8');
    const csv = inFolder('pagila.csv', full.split('\n').slice(0, 40).join('\n') + '\n');
    const sql = sqlUi({ files: [csv] });
    await importSqlDdl(deps(sql, importUi()));
    expect(sql.errors[0]?.message).toBe('Import SQL DDL: pagila.csv holds 39 of the query\'s 153 rows (its total_rows column), so it was cut short: a results grid\'s download often holds only the rows it shows (Databricks\' "first 1,000 rows" is one). Download all the rows and import that file.');
    expect(erdFiles()).toEqual([]);
  });

  it('SQL scripts and a catalog export in one pick are refused; nothing is read or written', async () => {
    const csv = inFolder('probe.csv', fs.readFileSync(path.join(FIXTURES, 'databricks/probe.csv'), 'utf-8'));
    const script = inFolder('schema.sql', 'CREATE TABLE a (id int PRIMARY KEY);\n');
    const sql = sqlUi({ files: [csv, script] });
    await importSqlDdl(deps(sql, importUi()));
    expect(sql.errors.map((e) => e.message)).toEqual(['Import SQL DDL: pick SQL scripts or a catalog export (.csv), not both in one import.']);
    expect(sql.read).toEqual([]);
    expect(erdFiles()).toEqual([]);
    expect(features()).toContain('importSqlDdlInvalid');
  });

  it(`a catalog export over ${Math.round(MAX_CATALOG_CHARS / 1024 / 1024)} MB is refused before it is read`, async () => {
    const csv = inFolder('huge.csv', 'table_name,column_name,data_type\nt,a,int\n');
    const sql = sqlUi({ files: [csv] }, { 'huge.csv': MAX_CATALOG_CHARS + 1 });
    await importSqlDdl(deps(sql, importUi()));
    expect(sql.errors[0]?.message).toBe('Import SQL DDL: the catalog export holds more than 64 MB. Export one schema at a time (add a schema filter to the query\'s WHERE clause) and import each.');
    expect(sql.read).toEqual([]);
    expect(features()).toContain('importLimitFileTooBig');
  });

  it('a folder still reads only its .sql files: a .csv beside them (a dbt seed, a catalog export) is not read', async () => {
    const folder = path.join(tmp, 'db');
    fs.mkdirSync(folder);
    for (const f of fs.readdirSync(path.join(SQL_FIXTURES, 'postgres'))) fs.copyFileSync(path.join(SQL_FIXTURES, 'postgres', f), path.join(folder, f));
    fs.copyFileSync(path.join(FIXTURES, 'databricks/probe.csv'), path.join(folder, 'probe.csv'));
    const sql = sqlUi({ folder });
    const ui = importUi();
    await importSqlDdl(deps(sql, ui));
    expect(sql.read.every((f) => f.endsWith('.sql'))).toBe(true);
    expect(sql.dialectPicks).toHaveLength(1);
    expect(ui.confirms[0].message).toBe('Import 4 tables and 3 relationships from 2 SQL files (PostgreSQL) into a new diagram "sales" in the Gold layer.');
  });
});
