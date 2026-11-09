/**
 * The quick import (B): a detected source started from the start suggestion
 * or a surface's primary start asks nothing it can answer — the files the
 * folder holds, the dialect, the layer, the name — and the draft (Draft-first,
 * `docs/dev/draft-first.md` §5.1: the read-only preview, nothing written
 * until Keep) is the one question; with no preview the fallback modal is,
 * with Import, Change Options… and Cancel. Change options… is the
 * step-by-step flow with those answers preselected, ending in a draft again.
 * The explicit commands stay step by step, each prompt's first item the
 * default. The automatic draft (`quiet`) asks and shows nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import {
  CHANGE_OPTIONS_BUTTON,
  IMPORT_BUTTON,
  importDbml,
  quickImportDbml,
  type ImportDbmlDeps,
  type ImportDbmlUi,
} from '../../src/commands/importDbml';
import {
  OTHER_SQL_FILES_ITEM,
  findSqlDdlScripts,
  quickImportSqlDdl,
  type ImportSqlDdlDeps,
  type ImportSqlDdlUi,
  type SqlDialectItem,
  type SqlFileItem,
} from '../../src/commands/importSqlDdl';
import { quickImportSemanticModel, type ImportSemanticModelUi } from '../../src/commands/importSemanticModel';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService, NEW_PROJECT_LAYERS_WITHOUT_DBT } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { defaultDiagramLayer } from '../../src/services/layerWording';
import { SQL_DIALECT_LIKELIHOOD, rankSqlDialects } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { QUICK_IMPORT_ARG, isQuickImportArg, startActionArgs, startDraftTriggerOf } from '../../src/types/startActions';
import { DRAFT_REDRAWN_NOTICE } from '../../src/services/draftModel';
import { fakeDraftPreview, type ScriptedAnswer } from './helpers/draftDriver';
import { generatedSqlWithLines } from './sqlImportPerformance.fixture';

const FIXTURES = path.join(__dirname, '../fixtures');

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;
const features = () => feature.mock.calls.map((c: unknown[]) => c[0]);
const erd = (...parts: string[]) => path.join(tmp, '.erd-studio', ...parts);

interface DbmlRecorder extends ImportDbmlUi {
  chooses: Array<{ message: string; detail: string; buttons: readonly string[] }>;
  picks: string[][];
  inputs: Array<string | undefined>;
  dialogs: Array<string | undefined>;
  opened: string[];
  errors: string[];
}

/** Import DBML's half: answers the dry run with `answers.choose` in turn (default Import). */
function dbmlUi(answers: { choose?: Array<string | undefined>; file?: string; layer?: string } = {}): DbmlRecorder {
  const chooses = [...(answers.choose ?? [])];
  const ui: DbmlRecorder = {
    chooses: [], picks: [], inputs: [], dialogs: [], opened: [], errors: [],
    pickFile: async (defaultPath) => { ui.dialogs.push(defaultPath); return answers.file ?? defaultPath; },
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => {
      const ids = (items as unknown as Array<{ id: string }>).map((i) => i.id);
      ui.picks.push(ids);
      const want = answers.layer ?? ids[0];
      return (items as unknown as Array<{ id: string }>).find((i) => i.id === want) as unknown as T | undefined;
    },
    showInputBox: async (options) => { ui.inputs.push(options.value); return options.value; },
    confirm: async () => { throw new Error('the quick path uses choose'); },
    choose: async (message, detail, buttons) => {
      ui.chooses.push({ message, detail, buttons });
      return chooses.length > 0 ? chooses.shift() : IMPORT_BUTTON;
    },
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

interface SqlRecorder extends ImportSqlDdlUi {
  sourcePicks: number;
  dialectPicks: SqlDialectItem[][];
  filePicks: SqlFileItem[][];
  starts: string[];
  errors: string[];
}

function sqlUi(answers: { dialect?: SqlDialectItem['dialect']; files?: (items: readonly SqlFileItem[]) => readonly SqlFileItem[] | undefined } = {}): SqlRecorder {
  const ui: SqlRecorder = {
    sourcePicks: 0, dialectPicks: [], filePicks: [], starts: [], errors: [],
    pickSources: async () => { ui.sourcePicks++; return undefined; },
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    readFileStart: async (filePath, chars) => { ui.starts.push(filePath); return fs.readFileSync(filePath, 'utf-8').slice(0, chars); },
    pickDialect: async (items) => { ui.dialectPicks.push([...items]); return answers.dialect ? items.find((i) => i.dialect === answers.dialect) : items[0]; },
    pickFiles: async (items) => { ui.filePicks.push([...items]); return answers.files ? answers.files(items) : items.filter((i) => i.picked); },
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message) => { ui.errors.push(message); return undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
  };
  return ui;
}

function services(options: { plain?: boolean } = {}) {
  const layerService = new LayerService(tmp, '.erd-studio');
  // A brand-new folder without dbt starts with one neutral layer, as activation sets it.
  if (options.plain) layerService.useDefaultLayers(NEW_PROJECT_LAYERS_WITHOUT_DBT);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { layerService, subjectAreaService, tableLibraryService };
}

function baseDeps(options: { plain?: boolean } = {}): Omit<ImportDbmlDeps, 'ui'> {
  const s = services(options);
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    ...s,
    validateDomainName: (value, layer) =>
      s.subjectAreaService.listSubjectAreas(tmp, '.erd-studio').some((d) => d.layer === layer && d.domain === value) ? 'taken' : undefined,
    onWritten: () => s.tableLibraryService.invalidateCache?.(),
  };
}

function sqlDeps(sql: ImportSqlDdlUi, ui: ImportDbmlUi, options: { plain?: boolean } = {}): ImportSqlDdlDeps {
  return { ...baseDeps(options), extensionPath: '/nowhere', sqlUi: sql, ui, loadSqlImport: () => engine };
}

const copy = (from: string, to = ''): void => { fs.cpSync(path.join(FIXTURES, from), path.join(tmp, to), { recursive: true }); };

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-quick-import-'));
  feature = vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the quick-path argument', () => {
  it('only the three direct imports take it, from a start, with the draft\'s trigger (Import from dbt: the trigger alone)', () => {
    expect(startActionArgs('importSqlDdl')).toEqual([{ ...QUICK_IMPORT_ARG, draft: 'start' }]);
    expect(startActionArgs('importSemanticModel')).toEqual([{ ...QUICK_IMPORT_ARG, draft: 'start' }]);
    expect(startActionArgs('importDbmlFile', 'prompt')).toEqual([{ ...QUICK_IMPORT_ARG, draft: 'prompt' }]);
    expect(startActionArgs('drawFromDbt')).toEqual([{ draft: 'start' }]);
    for (const action of ['convert', 'blank', 'import', 'example'] as const) expect(startActionArgs(action)).toEqual([]);
    expect(isQuickImportArg({ quick: true })).toBe(true);
    expect(isQuickImportArg({ quick: true, draft: 'start' })).toBe(true);
    // Only the triggers a command argument may carry: the automatic draft is the host's own.
    expect(startDraftTriggerOf({ quick: true, draft: 'prompt' })).toBe('prompt');
    expect(startDraftTriggerOf({ draft: 'start' })).toBe('start');
    for (const other of [undefined, {}, { draft: 'sidebar' }, { draft: 'palette' }, [{ draft: 'start' }], 'start']) {
      expect(startDraftTriggerOf(other)).toBeUndefined();
    }
    // A file URI (the canvas's "Import these tables…") or nothing is the step-by-step flow.
    for (const other of [undefined, null, {}, { quick: 'yes' }, [{ quick: true }], { scheme: 'file', fsPath: '/x.dbml' }]) {
      expect(isQuickImportArg(other)).toBe(false);
    }
  });

  it('the first diagram\'s layer is New Diagram\'s: the only one, else the last creatable while there is no diagram, else ask', () => {
    expect(defaultDiagramLayer(['main'], 0)).toBe('main');
    expect(defaultDiagramLayer(['main'], 3)).toBe('main');
    expect(defaultDiagramLayer(['silver', 'gold'], 0)).toBe('gold');
    expect(defaultDiagramLayer(['silver', 'gold'], 1)).toBeUndefined();
    expect(defaultDiagramLayer([], 0)).toBeUndefined();
  });

  it('dialects are tried most likely first: the signals, then the most widely used', () => {
    expect(rankSqlDialects('CREATE TABLE t (id int);')).toEqual([...SQL_DIALECT_LIKELIHOOD]);
    expect(rankSqlDialects('CREATE TABLE t (id int AUTO_INCREMENT) ENGINE=InnoDB;')[0]).toBe('mysql');
    expect(rankSqlDialects('CREATE TABLE [dbo].[t] (id int IDENTITY(1,1));')[0]).toBe('sqlserver');
  });
});

describe('Import SQL DDL… — the quick path', () => {
  it('takes every CREATE TABLE script in the folder (not queries, not ignored folders), the detected dialect, the default layer and the schema\'s name: one confirm', async () => {
    copy('sql-ddl/postgres', 'database');
    // A query and a script in a folder the walk never enters are not taken.
    fs.writeFileSync(path.join(tmp, 'report.sql'), 'SELECT * FROM sales.dim_customer;\n');
    fs.mkdirSync(path.join(tmp, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'x', 'schema.sql'), 'CREATE TABLE other (id int);\n');
    const sql = sqlUi();
    const ui = dbmlUi();

    const result = await quickImportSqlDdl(sqlDeps(sql, ui, { plain: true }));

    // No file dialog, no dialect pick, no layer pick, no name box.
    expect(sql.sourcePicks).toBe(0);
    expect(sql.dialectPicks).toEqual([]);
    expect(ui.picks).toEqual([]);
    expect(ui.inputs).toEqual([]);
    expect(ui.chooses).toHaveLength(1);
    expect(ui.chooses[0].message).toBe('Import 4 tables and 3 relationships from 2 SQL files (PostgreSQL) into a new diagram "sales" in the Main layer.');
    expect(ui.chooses[0].buttons).toEqual([IMPORT_BUTTON, CHANGE_OPTIONS_BUTTON]);
    expect(result?.domainPath).toBe(erd('main', 'diagrams', 'sales.dbml'));
    expect(result?.plan.modelNames).toHaveLength(4);
    expect(ui.opened).toEqual([result!.domainPath]);
    expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdl', 'quickImport']);
  });

  it('a dialect the text does not decide: the most likely in turn, the first that reads every file (no pick)', async () => {
    fs.writeFileSync(path.join(tmp, 'plain.sql'), 'CREATE TABLE customers (\n  id INT PRIMARY KEY,\n  name VARCHAR(40)\n);\n');
    const sql = sqlUi();
    const ui = dbmlUi();
    const result = await quickImportSqlDdl(sqlDeps(sql, ui, { plain: true }));
    expect(sql.dialectPicks).toEqual([]);
    // No schema: named after the folder.
    expect(ui.chooses[0].message).toMatch(/^Import 1 table from 1 SQL file \(PostgreSQL\) into a new diagram "erd-quick-import-[a-z0-9-]+" in the Main layer\.$/);
    expect(result?.plan.modelNames).toEqual(['customers']);
  });

  it('no dialect reads every file: asks the dialect, as the step-by-step flow does, and reports the problems', async () => {
    fs.writeFileSync(path.join(tmp, 'broken.sql'), 'CREATE TABLE t (id int,, x);\n');
    const sql = sqlUi({ dialect: 'postgres' });
    const ui = dbmlUi();
    expect(await quickImportSqlDdl(sqlDeps(sql, ui))).toBeUndefined();
    expect(sql.dialectPicks).toHaveLength(1);
    expect(sql.errors[0]).toMatch(/^Import SQL DDL: nothing was imported\. broken\.sql line \d+/);
    expect(ui.chooses).toEqual([]);
    expect(features()[0]).toBe('quickSqlNoDialect');
  });

  it('the first dialect tried does not read the script but a later one does: counted quickSqlDialectFallback', async () => {
    // Nothing in the text decides it, so PostgreSQL is tried first; only MySQL reads UNSIGNED and TINYTEXT.
    fs.writeFileSync(path.join(tmp, 'shop.sql'), 'CREATE TABLE t (id INT UNSIGNED, n TINYTEXT);\n');
    const result = await quickImportSqlDdl(sqlDeps(sqlUi(), dbmlUi(), { plain: true }));
    expect(result).toBeDefined();
    expect(features()).toEqual(expect.arrayContaining(['importSqlDialectMysql', 'quickSqlDialectFallback']));
    expect(features()).not.toContain('quickSqlNoDialect');
  });

  it('the dialect that reads the most tables wins, not the first that reads every file: a partial read beats none', async () => {
    // Only MySQL reads `#` comments; the detected PostgreSQL (SERIAL) reads none of the table.
    fs.writeFileSync(path.join(tmp, 'shop.sql'), 'CREATE TABLE t (\n  id SERIAL, # the key (see docs\n  n int\n);\nCREATE TABLE u (id int);\n');
    const result = await quickImportSqlDdl(sqlDeps(sqlUi(), dbmlUi(), { plain: true }));
    expect(result?.plan.newTables.map((t) => t.name).sort()).toEqual(['t', 'u']);
    expect(features()).toEqual(expect.arrayContaining(['importSqlDialectMysql', 'quickSqlDialectFallback']));
  });

  it('no dialect reads a table: the pick says why before it asks', async () => {
    fs.writeFileSync(path.join(tmp, 'broken.sql'), 'CREATE TABLE t (id int,, x);\n');
    const sql = sqlUi({ dialect: 'postgres' });
    const placeholders: Array<string | undefined> = [];
    const pick = sql.pickDialect;
    sql.pickDialect = async (items, options) => { placeholders.push(options.placeHolder); return pick(items, options); };
    await quickImportSqlDdl(sqlDeps(sql, dbmlUi()));
    expect(placeholders[0]).toMatch(/^No dialect reads a table in the script \(broken\.sql line 1: CREATE TABLE t could not be read: an empty column definition/);
    // Every dialect says it read none; none is "detected".
    expect(sql.dialectPicks[0].map((i) => i.description)).toEqual(Array(5).fill('does not read the table'));
  });

  it('no CREATE TABLE script in the folder: the step-by-step flow (the file dialog), counted as a fall-back', async () => {
    fs.writeFileSync(path.join(tmp, 'query.sql'), 'SELECT 1;\n');
    const sql = sqlUi();
    await quickImportSqlDdl(sqlDeps(sql, dbmlUi()));
    expect(sql.sourcePicks).toBe(1);
    expect(features()).toContain('quickImportFellBack');
  });

  it('reads only the start of each .sql: the CREATE TABLE scripts and the keys added beside them, never a query or the ERD Studio folder', async () => {
    copy('sql-ddl/postgres', 'db');
    fs.writeFileSync(path.join(tmp, 'seed.sql'), "INSERT INTO sales.dim_date VALUES (1, '2026-01-01', false);\n");
    fs.mkdirSync(erd('main'), { recursive: true });
    fs.writeFileSync(erd('main', 'old.sql'), 'CREATE TABLE stray (id int);\n');
    const sql = sqlUi();
    const found = await findSqlDdlScripts(tmp, '.erd-studio', sql);
    // 02_constraints.sql holds only ALTER TABLE … FOREIGN KEY: its relationships belong to the tables.
    expect(found).toEqual({ files: [path.join(tmp, 'db', '01_tables.sql'), path.join(tmp, 'db', '02_constraints.sql')], truncated: false });
    expect(sql.starts.every((f) => !f.includes('.erd-studio'))).toBe(true);
    // Keys alone are no reason to import: nothing to attach them to.
    fs.rmSync(path.join(tmp, 'db', '01_tables.sql'));
    expect((await findSqlDdlScripts(tmp, '.erd-studio', sql)).files).toEqual([]);
  });

  it('takes exactly what the start screen\'s look offers: the same listing (hidden folders, .SQL, deeper than before) and the same test (never a dbt macro, a CTAS, a notebook or Oracle DDL)', async () => {
    const write = (rel: string, text: string | Buffer): string => {
      const file = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    };
    const taken = [
      write('.devcontainer/initdb/01_schema.sql', 'CREATE TABLE a (id int);\n'),
      write('DDL/TABLES.SQL', 'CREATE TABLE b (id int);\n'),
      write('a/b/c/d/e/f/g/h/i/j/k/l/m/tables.sql', 'CREATE TABLE c (id int);\n'),
    ];
    write('macros/m.sql', '{% macro m() %}create or replace table {{ relation }} as ({{ sql }});{% endmacro %}\n');
    write('analyses/backfill.sql', 'create table tmp as (\n  select 1\n);\n');
    write('src/nb.sql', '-- Databricks notebook source\nCREATE TABLE gold.x (id INT);\n');
    write('oracle/hr.sql', 'CREATE TABLE HR.E (ID NUMBER(6), EMAIL VARCHAR2(25 BYTE));\n');
    const found = await findSqlDdlScripts(tmp, '.erd-studio', sqlUi());
    expect(found).toEqual({ files: [...taken].sort((x, y) => x.localeCompare(y, 'en', { numeric: true, sensitivity: 'base' })), truncated: false });
  });

  it('a folder of more .sql files than it opens: the names that usually hold tables are opened first, and what it found is taken', async () => {
    for (let i = 0; i < 520; i++) {
      const file = path.join(tmp, 'reports', `q${String(i).padStart(3, '0')}.sql`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `select ${i};\n`);
    }
    const ddl = path.join(tmp, 'zz', 'schema', 'create_tables.sql');
    fs.mkdirSync(path.dirname(ddl), { recursive: true });
    fs.writeFileSync(ddl, 'CREATE TABLE a (id int);\n');
    expect(await findSqlDdlScripts(tmp, '.erd-studio', sqlUi())).toEqual({ files: [ddl], truncated: true });
  });

  it('a migrations folder: the later scripts that only change columns are taken too (applied in order), a teardown of DROP TABLEs is not', async () => {
    const dir = path.join(tmp, 'db', 'migration');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'V1__init.sql'), 'CREATE TABLE customer (id int PRIMARY KEY, email text);\n');
    fs.writeFileSync(path.join(dir, 'V2__rename.sql'), 'ALTER TABLE customer RENAME COLUMN email TO email_address;\n');
    fs.writeFileSync(path.join(dir, 'V10__add.sql'), 'ALTER TABLE customer ADD COLUMN phone text;\n');
    fs.writeFileSync(path.join(tmp, 'teardown.sql'), 'DROP TABLE customer;\n');
    const found = await findSqlDdlScripts(tmp, '.erd-studio', sqlUi());
    expect(found.files.map((f) => path.basename(f))).toEqual(['V1__init.sql', 'V2__rename.sql', 'V10__add.sql']);
  });

  it('a file larger than the import reads is never taken', async () => {
    const file = path.join(tmp, 'dump.sql');
    fs.writeFileSync(file, 'CREATE TABLE a (id int);\n');
    const sql = { ...sqlUi(), fileSize: async () => 300 * 1024 * 1024 };
    expect((await findSqlDdlScripts(tmp, '.erd-studio', sql)).files).toEqual([]);
  });

  it('Change Options…: the found scripts (all picked), the dialect it used first, then the layer and name it chose first', async () => {
    copy('sql-ddl/postgres', 'database');
    fs.writeFileSync(path.join(tmp, 'extra.sql'), 'CREATE TABLE extra (id INT PRIMARY KEY);\n');
    const sql = sqlUi();
    const ui = dbmlUi({ choose: [CHANGE_OPTIONS_BUTTON] });
    const layered = sqlDeps(sql, ui);
    expect(await quickImportSqlDdl(layered)).toBeUndefined();
    expect(features()).toContain('quickImportChangeOptions');
    // The step-by-step flow runs on a later tick.
    await vi.waitFor(() => expect(ui.chooses).toHaveLength(2));
    expect(sql.filePicks).toHaveLength(1);
    expect(sql.filePicks[0][0].label).toBe(OTHER_SQL_FILES_ITEM);
    expect(sql.filePicks[0].slice(1).map((i) => [i.label, i.picked])).toEqual([
      ['database/01_tables.sql', true], ['database/02_constraints.sql', true], ['extra.sql', true],
    ]);
    expect(sql.dialectPicks[0][0]).toMatchObject({ dialect: 'postgres', description: expect.stringMatching(/^detected · read as this before · reads all 5 tables$/) });
    // silver and gold, no diagram yet: gold was chosen, so gold leads the pick; the name box offers the same name.
    expect(ui.picks[0][0]).toBe('gold');
    expect(ui.inputs).toEqual([ui.chooses[0].message.match(/diagram "([^"]+)"/)![1]]);
    // The step-by-step dry run has no Change Options… of its own.
    expect(ui.chooses[1].buttons).toEqual([IMPORT_BUTTON]);
  });

  it('Change Options… with "Other files or a folder…" opens the file dialog instead', async () => {
    copy('sql-ddl/postgres', 'database');
    const sql = sqlUi({ files: (items) => [items[0]] });
    const ui = dbmlUi({ choose: [CHANGE_OPTIONS_BUTTON] });
    await quickImportSqlDdl(sqlDeps(sql, ui));
    await vi.waitFor(() => expect(sql.sourcePicks).toBe(1));
  });
});

describe('Import Semantic Model… and Import DBML… — the quick path', () => {
  const modelUi = (): ImportSemanticModelUi & { folders: number; picks: number } => {
    const ui = {
      folders: 0, picks: 0,
      pickFolder: async () => { ui.folders++; return undefined; },
      readDirectory: async (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
      readFile: async (filePath: string) => fs.readFileSync(filePath, 'utf-8'),
      pickModel: async (items: readonly { entry: unknown }[]) => { ui.picks++; return items[0] as never; },
      showErrorMessage: async () => undefined,
      openFileAt: async () => {},
      sendFeedback: async () => {},
    };
    return ui;
  };

  it('the one semantic model in the folder: no folder dialog, no pick, no layer or name question', async () => {
    copy('semantic-model/pbip-tmdl', '');
    const model = modelUi();
    const ui = dbmlUi();
    const result = await quickImportSemanticModel({ ...baseDeps({ plain: true }), modelUi: model, ui });
    expect(model.folders).toBe(0);
    expect(model.picks).toBe(0);
    expect(ui.picks).toEqual([]);
    expect(ui.inputs).toEqual([]);
    expect(ui.chooses[0].buttons).toEqual([IMPORT_BUTTON, CHANGE_OPTIONS_BUTTON]);
    expect(result?.domainPath.startsWith(erd('main', 'diagrams'))).toBe(true);
    expect(features()).toContain('quickImport');
  });

  it('several models: the pick (the one question it cannot answer); none: the folder dialog', async () => {
    copy('semantic-model', 'models');
    const model = modelUi();
    await quickImportSemanticModel({ ...baseDeps(), modelUi: model, ui: dbmlUi({ choose: [undefined] }) });
    expect(model.picks).toBe(1);
    expect(model.folders).toBe(0);

    fs.rmSync(path.join(tmp, 'models'), { recursive: true });
    const none = modelUi();
    await quickImportSemanticModel({ ...baseDeps(), modelUi: none, ui: dbmlUi() });
    expect(none.folders).toBe(1);
    expect(features()).toContain('quickImportFellBack');
  });

  it('the DBML file the folder holds: no dialog, no questions; Change Options… opens the dialog on it, its layer and name first', async () => {
    const file = path.join(tmp, 'design', 'shop.dbml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'Table customers {\n  id int [pk]\n}\n');
    const ui = dbmlUi({ choose: [CHANGE_OPTIONS_BUTTON] });
    await quickImportDbml({ ...baseDeps(), ui, findDefaultFile: async () => file });
    expect(ui.chooses[0].message).toBe('Import 1 table into a new diagram "shop" in the Gold layer.');
    await vi.waitFor(() => expect(ui.chooses).toHaveLength(2));
    // One dialog in all: Change Options…'s, on the file the quick path took.
    expect(ui.dialogs).toEqual([file]);
    expect(ui.picks[0][0]).toBe('gold');
    expect(ui.inputs).toEqual(['shop']);
  });

  it('no DBML file found: the step-by-step flow', async () => {
    const ui = dbmlUi();
    await quickImportDbml({ ...baseDeps(), ui, findDefaultFile: async () => undefined });
    expect(ui.dialogs).toHaveLength(1);
    expect(features()).toContain('quickImportFellBack');
  });

  it('the explicit Import DBML…: every prompt asked, each with its default first (Enter just works)', async () => {
    const file = path.join(tmp, 'sales.dbml');
    fs.writeFileSync(file, 'Table orders {\n  id int [pk]\n}\n');
    const ui = dbmlUi({ file });
    await importDbml({ ...baseDeps(), ui });
    expect(ui.dialogs).toHaveLength(1);
    expect(ui.picks).toEqual([['gold', 'silver']]);
    expect(ui.inputs).toEqual(['sales']);
    expect(ui.chooses[0].buttons).toEqual([IMPORT_BUTTON]);
  });
});

/** Every file under `.erd-studio/`, project-relative, with its bytes. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(path.join(root, '.erd-studio'));
  return out;
}

describe('Draft-first: the quick path ends in the draft (docs/dev/draft-first.md §5.1)', () => {
  const draft = (answers: ScriptedAnswer[], extra: { quiet?: boolean; generation?: () => number } = {}) => {
    const preview = fakeDraftPreview(answers);
    return { preview, options: { preview, trigger: 'start' as const, ...extra } };
  };

  it('Keep writes exactly the files the modal\'s Import writes, byte for byte, and settles kept', async () => {
    copy('sql-ddl/postgres', 'database');
    const modal = await quickImportSqlDdl(sqlDeps(sqlUi(), dbmlUi(), { plain: true }));
    const viaModal = snapshot(tmp);
    expect(Object.keys(viaModal).length).toBeGreaterThan(3);
    fs.rmSync(erd(), { recursive: true });

    const { preview, options } = draft(['keep']);
    const ui = dbmlUi();
    const kept = await quickImportSqlDdl({ ...sqlDeps(sqlUi(), ui, { plain: true }), draft: options });
    expect(ui.chooses).toEqual([]);
    expect(kept?.domainPath).toBe(modal?.domainPath);
    expect(snapshot(tmp)).toEqual(viaModal);
    expect(preview.settled).toEqual([{ kept: true }]);
    expect(ui.opened).toEqual([kept!.domainPath]);
    const shown = preview.drafts[0];
    expect(shown.keep).toMatchObject({ writer: 'importDbml', importSource: 'sql', target: { layer: 'main', name: 'sales', diagramFile: '.erd-studio/main/diagrams/sales.dbml' } });
    expect(shown.trigger).toBe('start');
    expect(shown.banner.changeOptions).toBe(true);
  });

  it('nothing is written before Keep: Discard and closing the tab write nothing and count the import\'s cancel', async () => {
    copy('sql-ddl/postgres', 'database');
    for (const answer of ['discard', 'closed'] as const) {
      feature.mockClear();
      const { options } = draft([answer]);
      expect(await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi(), { plain: true }), draft: options })).toBeUndefined();
      expect(fs.existsSync(erd())).toBe(false);
      expect(features()).toEqual(['importSqlDialectPostgres', 'importSqlDdlCancelled']);
    }
  });

  it('a table that does not read never stops the draft: the rest is drafted, the banner says how many were left out, Not imported names it', async () => {
    fs.mkdirSync(path.join(tmp, 'db'));
    fs.writeFileSync(path.join(tmp, 'db', 'schema.sql'), 'CREATE TABLE customer (id int PRIMARY KEY);\nCREATE TABLE orders (id int PRIMARY KEY, customer_id int REFERENCES customer (id));\n\nCREATE TABLE broken (\n  id int,,\n  x int\n);\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { preview, options } = draft(['keep']);
    const kept = await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi(), { plain: true }), draft: options });
    expect(kept?.plan.newTables.map((t) => t.name).sort()).toEqual(['customer', 'orders']);
    const shown = preview.drafts[0];
    expect(shown.banner.notice).toBe('1 of 3 tables could not be read; Show details lists it.');
    expect(JSON.stringify(shown)).toMatch(/1 table: CREATE TABLE could not be read: a syntax error \(Show Logs has each line\) \(broken\)/);
    // Logged with its file (named under the open folder, as every entry point names it) and line.
    expect(warn.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/db\/schema\.sql line 5: CREATE TABLE broken could not be read/));
    expect(features()).toEqual(expect.arrayContaining(['importSqlDialectPostgres', 'importSqlDdlInvalid', 'importSqlInvalidParse']));
  });

  it('Cancel on the progress notification mid-way: the tables read so far are drafted, the banner says where reading stopped, no other dialect is read', async () => {
    fs.mkdirSync(path.join(tmp, 'db'));
    const { text, lines } = generatedSqlWithLines(300);
    fs.writeFileSync(path.join(tmp, 'db', 'schema.sql'), text);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { preview, options } = draft(['keep']);
    const titles: string[] = [];
    const sql: ImportSqlDdlUi = {
      ...sqlUi(),
      withProgress: async (title, task) => {
        titles.push(title);
        const cancel = new AbortController();
        return task({ report: (_message, fraction) => { if ((fraction ?? 0) >= 0.5) cancel.abort(); } }, cancel.signal);
      },
    };
    const kept = await quickImportSqlDdl({ ...sqlDeps(sql, dbmlUi(), { plain: true }), draft: options });
    const read = kept!.plan.newTables.length;
    expect(read).toBeGreaterThan(100);
    expect(read).toBeLessThan(200);
    expect(titles).toEqual(['Import SQL DDL: reading the scripts']);
    expect(preview.drafts[0].banner.notice).toBe(`The import was cancelled at db/schema.sql line ${lines[read].toLocaleString('en-US')}: ${300 - read} of 300 tables were not read; Show details lists them.`);
    expect(JSON.stringify(preview.drafts[0])).toContain(`"${300 - read} tables: CREATE TABLE not read: the import was cancelled first"`);
    // Kept as the import, never counted as a cancelled one.
    expect(features()).toEqual(expect.arrayContaining(['importSqlDialectPostgres']));
    expect(features()).not.toContain('importSqlDdlCancelled');
    expect(features()).not.toContain('quickSqlDialectFallback');
  });

  it('Cancel before a table is read: nothing is drafted or written, counted as the import\'s cancel', async () => {
    fs.mkdirSync(path.join(tmp, 'db'));
    fs.writeFileSync(path.join(tmp, 'db', 'schema.sql'), generatedSqlWithLines(20).text);
    const { preview, options } = draft(['keep']);
    const sql: ImportSqlDdlUi = { ...sqlUi(), withProgress: async (_title, task) => { const c = new AbortController(); c.abort(); return task({ report: () => {} }, c.signal); } };
    expect(await quickImportSqlDdl({ ...sqlDeps(sql, dbmlUi(), { plain: true }), draft: options })).toBeUndefined();
    expect(preview.drafts).toEqual([]);
    expect(fs.existsSync(erd())).toBe(false);
    expect(features()).toEqual(['importSqlDdlCancelled']);
  });

  it('Change options… runs the preselected step-by-step flow, which ends in a draft of its own (trigger changeOptions)', async () => {
    copy('sql-ddl/postgres', 'database');
    const { preview, options } = draft(['changeOptions', 'keep']);
    const sql = sqlUi();
    const ui = dbmlUi();
    expect(await quickImportSqlDdl({ ...sqlDeps(sql, ui), draft: options })).toBeUndefined();
    expect(features()).toContain('quickImportChangeOptions');
    await vi.waitFor(() => expect(preview.drafts).toHaveLength(2));
    expect(sql.filePicks).toHaveLength(1);
    expect(ui.picks[0][0]).toBe('gold');
    expect(preview.drafts[1].trigger).toBe('changeOptions');
    // The step-by-step draft has no Change options… of its own.
    expect(preview.drafts[1].banner.changeOptions).toBe(false);
    await vi.waitFor(() => expect(preview.settled).toEqual([{ kept: true }]));
    expect(ui.chooses).toEqual([]);
  });

  it('staleness: files changed since the draft but the plan is the same → written at once; another plan → redrawn with the notice', async () => {
    copy('sql-ddl/postgres', 'database');
    let generation = 0;
    // Same plan: a change elsewhere in the folder, between the draft (the plan) and Keep.
    const same = draft(['keep'], { generation: () => generation });
    const sameAsk = same.preview.ask.bind(same.preview);
    same.preview.ask = async (d) => {
      const answer = await sameAsk(d);
      generation += 1;
      return answer;
    };
    const written = await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi(), { plain: true }), draft: same.options });
    expect(written).toBeDefined();
    // Planned again, the same plan: written at once, the one Keep settled kept, no second draft.
    expect(same.preview.drafts).toHaveLength(1);
    expect(same.preview.settled).toEqual([{ kept: true }]);
    expect(fs.existsSync(written!.domainPath)).toBe(true);
    expect(features()).not.toContain('draftRefreshed');

    // Another plan: a table of the same name appeared in the library since.
    fs.rmSync(erd(), { recursive: true });
    feature.mockClear();
    let gen = 0;
    const answers: ScriptedAnswer[] = ['keep', 'discard'];
    const preview = fakeDraftPreview(answers);
    const origAsk = preview.ask.bind(preview);
    preview.ask = async (d) => {
      const answer = await origAsk(d);
      if (preview.drafts.length === 1) {
        // Between the draft and Keep: an assistant adds a library table.
        fs.mkdirSync(erd('main', 'tables', 'sales'), { recursive: true });
        fs.writeFileSync(erd('main', 'tables', 'sales', 'dim_customer.dbml'), 'Table sales.dim_customer {\n  id int [pk]\n}\n');
        gen += 1;
      }
      return answer;
    };
    const stale = await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi(), { plain: true }), draft: { preview, trigger: 'start', generation: () => gen } });
    expect(stale).toBeUndefined();
    expect(preview.drafts).toHaveLength(2);
    expect(preview.settled[0]).toEqual({ kept: false });
    expect(preview.drafts[1].banner.notice).toBe(DRAFT_REDRAWN_NOTICE);
    expect(features()).toContain('draftRefreshed');
  });

  it('a Keep that does not save (the name was taken since) says why, even on the automatic draft, then asks the same draft again', async () => {
    copy('sql-ddl/postgres', 'database');
    const ui = dbmlUi();
    const { preview, options } = draft(['keep', 'discard'], { quiet: true });
    const ask = preview.ask.bind(preview);
    preview.ask = async (d) => {
      if (preview.drafts.length === 0) {
        // Between the draft and Keep: another window saves a diagram of the same name.
        fs.mkdirSync(erd('main', 'diagrams'), { recursive: true });
        fs.writeFileSync(erd('main', 'diagrams', 'sales.dbml'), 'Project sales {\n}\n');
      }
      return ask(d);
    };
    expect(await quickImportSqlDdl({ ...sqlDeps(sqlUi(), ui, { plain: true }), draft: options })).toBeUndefined();
    expect(preview.settled).toEqual([{ kept: false }]);
    // The same Draft object again, so the page's buttons keep answering (Discard here).
    expect(preview.drafts).toHaveLength(2);
    expect(preview.drafts[1]).toBe(preview.drafts[0]);
    // Shown, not only logged: the user pressed Keep and is waiting on it.
    expect(ui.errors.some((e) => /sales/.test(e) && /already/i.test(e))).toBe(true);
  });

  it('quiet (the automatic draft): nothing asked or shown, and an early end counts no cancel and no invalid', async () => {
    // No dialect reads every file: the explicit path asks; the quiet one ends.
    fs.writeFileSync(path.join(tmp, 'broken.sql'), 'CREATE TABLE t (id int,, x);\n');
    const sql = sqlUi({ dialect: 'postgres' });
    const ui = dbmlUi();
    const { preview, options } = draft([], { quiet: true });
    expect(await quickImportSqlDdl({ ...sqlDeps(sql, ui), draft: options })).toBeUndefined();
    expect(sql.dialectPicks).toEqual([]);
    expect(sql.errors).toEqual([]);
    expect(preview.drafts).toEqual([]);
    expect(features().filter((f) => /Cancelled|Invalid|FellBack/.test(f))).toEqual([]);

    // No script at all: no file dialog.
    fs.rmSync(path.join(tmp, 'broken.sql'));
    expect(await quickImportSqlDdl({ ...sqlDeps(sql, ui), draft: options })).toBeUndefined();
    expect(sql.sourcePicks).toBe(0);
    expect(features().filter((f) => /Cancelled|Invalid|FellBack/.test(f))).toEqual([]);

    // A semantic model folder with none, and a DBML file that is not there: nothing asked either.
    expect(await quickImportDbml({ ...baseDeps(), ui, findDefaultFile: async () => undefined, draft: options })).toBeUndefined();
    expect(ui.dialogs).toEqual([]);
  });

  it('quiet with a buildable find: the draft is shown, nothing asked; the user\'s Discard counts the cancel', async () => {
    copy('sql-ddl/postgres', 'database');
    const ui = dbmlUi();
    const { preview, options } = draft(['discard'], { quiet: true });
    await quickImportSqlDdl({ ...sqlDeps(sqlUi(), ui), draft: { ...options, trigger: 'sidebar' } });
    expect(preview.drafts).toHaveLength(1);
    expect(preview.drafts[0].trigger).toBe('sidebar');
    expect(ui.picks).toEqual([]);
    expect(ui.inputs).toEqual([]);
    expect(fs.existsSync(erd())).toBe(false);
  });

  it('several semantic models: the first is drawn, with the Model switcher; a switch re-enters with that model and the same preview', async () => {
    copy('semantic-model/pbip-tmdl', 'models/a');
    copy('semantic-model/pbip-tmsl', 'models/b');
    const model = modelUiForDraft();
    const { preview, options } = draft([]);
    let scoped: string | undefined;
    await quickImportSemanticModel({ ...baseDeps(), modelUi: model, ui: dbmlUi(), draft: { ...options, onScope: (id) => { scoped = id; } } });
    expect(model.picks).toBe(0);
    const scopes = preview.drafts[0].scopes!;
    expect(scopes.label).toBe('Model');
    expect(scopes.options.length).toBeGreaterThan(1);
    expect(scopes.current).toBe(scopes.options[0].id);
    // Its own onScope is the semantic model's re-entry, not the caller's.
    expect(scoped).toBeUndefined();

    const switched = draft([{ scope: scopes.options[1].id }]);
    await quickImportSemanticModel({ ...baseDeps(), modelUi: model, ui: dbmlUi(), draft: switched.options });
    await vi.waitFor(() => expect(switched.preview.drafts).toHaveLength(2));
    expect(switched.preview.drafts[1].scopes!.current).toBe(scopes.options[1].id);
    expect(fs.existsSync(erd())).toBe(false);
  });
});

function modelUiForDraft(): ImportSemanticModelUi & { folders: number; picks: number } {
  const ui = {
    folders: 0, picks: 0,
    pickFolder: async () => { ui.folders++; return undefined; },
    readDirectory: async (folder: string) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath: string) => fs.readFileSync(filePath, 'utf-8'),
    pickModel: async (items: readonly { entry: unknown }[]) => { ui.picks++; return items[0] as never; },
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    sendFeedback: async () => {},
  };
  return ui;
}

describe('the automatic draft says why it was dropped (quietDrop, telemetry 2.0 B9)', () => {
  const quietDraft = (quiet = true) => {
    const preview = fakeDraftPreview([]);
    const drops: string[] = [];
    return { preview, drops, options: { preview, trigger: 'sidebar' as const, quiet, quietDrop: (reason: string) => { drops.push(reason); } } };
  };

  it('SQL: no CREATE TABLE script, a script no dialect reads, a script that cannot be read', async () => {
    const q = quietDraft();
    await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi()), draft: q.options });
    fs.writeFileSync(path.join(tmp, 'broken.sql'), 'CREATE TABLE t (id int,, x);\n');
    await quickImportSqlDdl({ ...sqlDeps(sqlUi(), dbmlUi()), draft: q.options });
    const unreadable = { ...sqlUi(), readFile: async () => { throw new Error('EACCES'); } };
    fs.writeFileSync(path.join(tmp, 'broken.sql'), 'CREATE TABLE t (id int);\n');
    await quickImportSqlDdl({ ...sqlDeps(unreadable, dbmlUi()), draft: q.options });
    expect(q.drops).toEqual(['nothingFound', 'noDialect', 'unreadable']);
    expect(q.preview.drafts).toEqual([]);
    // Quiet: none of the import's own reason keys either (the host counts draftUnavailable and the drop).
    expect(features().filter((f) => /^import|^quickSql/.test(f))).toEqual([]);
  });

  it('DBML: no file found, not valid DBML, no tables, no layer, a name it cannot take', async () => {
    const q = quietDraft();
    await quickImportDbml({ ...baseDeps(), ui: dbmlUi(), findDefaultFile: async () => undefined, draft: q.options });
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, 'Table a {\n  id int [pk]\n');
    await quickImportDbml({ ...baseDeps(), ui: dbmlUi(), findDefaultFile: async () => file, draft: q.options });
    fs.writeFileSync(file, "Project p {\n  Note: 'nothing'\n}\n");
    await quickImportDbml({ ...baseDeps(), ui: dbmlUi(), findDefaultFile: async () => file, draft: q.options });
    fs.writeFileSync(file, 'Table a {\n  id int [pk]\n}\n');
    const noLayers = baseDeps();
    noLayers.layerService = Object.assign(Object.create(noLayers.layerService), { getCreatableLayers: () => [] });
    await quickImportDbml({ ...noLayers, ui: dbmlUi(), findDefaultFile: async () => file, draft: q.options });
    await quickImportDbml({ ...baseDeps(), validateDomainName: () => 'not valid', ui: dbmlUi(), findDefaultFile: async () => file, draft: q.options });
    expect(q.drops).toEqual(['nothingFound', 'unreadable', 'nothingDrawable', 'noLayer', 'badName']);
    // The project's own state is counted, quiet or not.
    expect(features()).toEqual(['importStopNoLayers']);
  });

  it('a semantic model folder with none in it', async () => {
    const q = quietDraft();
    await quickImportSemanticModel({ ...baseDeps(), modelUi: modelUiForDraft(), ui: dbmlUi(), draft: q.options });
    expect(q.drops).toEqual(['nothingFound']);
  });

  it('a run that is not quiet never reports a drop: its own keys say why', async () => {
    const q = quietDraft(false);
    fs.writeFileSync(path.join(tmp, 'shop.dbml'), 'Table a {\n  id int [pk]\n');
    await quickImportDbml({ ...baseDeps(), ui: dbmlUi(), findDefaultFile: async () => path.join(tmp, 'shop.dbml'), draft: q.options });
    expect(q.drops).toEqual([]);
    expect(features()).toEqual(['importDbmlInvalid', 'importDbmlInvalidSyntax']);
  });
});
