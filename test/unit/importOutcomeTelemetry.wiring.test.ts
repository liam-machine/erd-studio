/**
 * Import outcomes as the commands record them (`importOutcomeTelemetry.ts`):
 * Import SQL DDL…, Import DBML… and Import Semantic Model… count one outcome
 * per run, off the onboarding trail (`telemetry.featureQuiet`) — a success once
 * the plan is ready (never on a redraw of it), a failure where the source
 * brought nothing in, never on the automatic draft's quiet early end, never
 * for the example. Import from dbt is in `importOutcomeTelemetry.dbt.test.ts`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { fakeDraftPreview } from './helpers/draftDriver';
import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlDeps, type ImportSqlDdlUi, type SqlSources } from '../../src/commands/importSqlDdl';
import { importSemanticModel, type ImportSemanticModelUi } from '../../src/commands/importSemanticModel';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import type { SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import type { Draft } from '../../src/types/draft';

const SQL_FIXTURES = path.join(__dirname, '../fixtures/sql-ddl');
const MODEL_FIXTURES = path.join(__dirname, '../fixtures/semantic-model');

let tmp: string;
let quietKeys: ReturnType<typeof vi.spyOn>;
let feature: ReturnType<typeof vi.spyOn>;
/** The import outcome keys recorded (every featureQuiet key is one here). */
const outcomes = (): string[] => quietKeys.mock.calls.map((c: unknown[]) => c[0] as string);

function sqlUi(sources: SqlSources | undefined, dialect?: SqlDialect): ImportSqlDdlUi {
  return {
    pickSources: async () => sources,
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items) => items.find((i) => i.dialect === dialect),
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    sendFeedback: async () => {},
  };
}

/** Import DBML's half: the layer `gold`, the suggested name, and the dry run answered `confirm` (default Cancel). */
function importUi(file?: string, confirm = false): ImportDbmlUi {
  return {
    pickFile: async () => file,
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => options.value,
    confirm: async () => confirm,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
}

function services() {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return { workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService, validateDomainName: () => undefined, onWritten: () => {} };
}

function sqlDeps(sql: ImportSqlDdlUi, more: Partial<ImportSqlDdlDeps> = {}): ImportSqlDdlDeps {
  return { ...services(), extensionPath: '/nowhere', sqlUi: sql, ui: importUi(), loadSqlImport: () => engine, ...more };
}

function dbmlDeps(file: string | undefined, more: Partial<ImportDbmlDeps> = {}): ImportDbmlDeps {
  return { ...services(), ui: importUi(file), ...more };
}

function writeFile(name: string, text: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, text);
  return file;
}

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-outcome-'));
  quietKeys = vi.spyOn(telemetry, 'featureQuiet');
  feature = vi.spyOn(telemetry, 'feature');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import SQL DDL… — its outcome', () => {
  it('a script that reads as written: clean, by dialect, with the cause classes it met (counted once the plan is ready, kept or not)', async () => {
    await importSqlDdl(sqlDeps(sqlUi({ folder: path.join(SQL_FIXTURES, 'postgres') }, 'postgres')));
    // The conversion's causes and the plan's (a new project writes DBML: D18 saves every relationship optional).
    expect(outcomes()).toEqual(['importOutcomeSqlDdlClean', 'importSqlOutcomePostgresClean', 'importCauseNoField', 'importCauseNotDesign', 'importCauseSavedOptional']);
    // Off the onboarding trail: never through telemetry.feature.
    expect(feature.mock.calls.map((c: unknown[]) => String(c[0])).filter((k) => /^import(Outcome|SqlOutcome|Cause)/.test(k))).toEqual([]);
  });

  it('a table the repair ladder had to rewrite: repaired', async () => {
    const file = writeFile('a.sql', 'CREATE TABLE a (id int primary key\n  name text\n);\n');
    await importSqlDdl(sqlDeps(sqlUi({ files: [file] }, 'postgres')));
    expect(outcomes()).toEqual(['importOutcomeSqlDdlRepaired', 'importSqlOutcomePostgresRepaired', 'importCauseParseError']);
  });

  it('a table that could not be read beside one that did: partial', async () => {
    const file = writeFile('b.sql', 'CREATE TABLE a (id int primary key);\nCREATE TABLE b (id int,, x int);\n');
    await importSqlDdl(sqlDeps(sqlUi({ files: [file] }, 'mysql')));
    expect(outcomes().slice(0, 2)).toEqual(['importOutcomeSqlDdlPartial', 'importSqlOutcomeMysqlPartial']);
  });

  it('no table reads: failed, by dialect, with the ledger\'s cause classes', async () => {
    const file = writeFile('c.sql', '-- broken\n\nCREATE TABLE t (\n  id int,,\n  x int\n);\n');
    await importSqlDdl(sqlDeps(sqlUi({ files: [file] }, 'postgres')));
    expect(outcomes()).toEqual(['importOutcomeSqlDdlFail', 'importSqlOutcomePostgresFail', 'importCauseParseError']);
  });

  it('the SQL importer does not load (ours): failed, with no dialect it ran with', async () => {
    const file = writeFile('d.sql', 'CREATE TABLE a (id int);\n');
    await importSqlDdl(sqlDeps(sqlUi({ files: [file] }, 'postgres'), { loadSqlImport: () => { throw new Error('no bundle'); } }));
    expect(outcomes()).toEqual(['importOutcomeSqlDdlFail']);
  });

  it('a folder with no scripts is failed; a closed picker or dialect pick is no outcome', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    await importSqlDdl(sqlDeps(sqlUi({ folder: empty })));
    expect(outcomes()).toEqual(['importOutcomeSqlDdlFail']);
    quietKeys.mockClear();
    await importSqlDdl(sqlDeps(sqlUi(undefined)));
    const file = writeFile('e.sql', 'CREATE TABLE a (id int);\n');
    await importSqlDdl(sqlDeps(sqlUi({ files: [file] }, undefined)));
    expect(outcomes()).toEqual([]);
  });
});

describe('Import DBML… — its outcome', () => {
  const DBML = 'Table customer {\n  id int [pk]\n  name varchar\n}\n';

  it('a file that reads: clean, once', async () => {
    await importDbml(dbmlDeps(writeFile('shop.dbml', DBML)));
    expect(outcomes()).toEqual(['importOutcomeDbmlClean']);
  });

  it('a file that does not read, or has no tables: failed', async () => {
    await importDbml(dbmlDeps(writeFile('bad.dbml', 'Table customer {\n  id int [pk\n')));
    await importDbml(dbmlDeps(writeFile('empty.dbml', '// nothing here\n')));
    expect(outcomes()).toEqual(['importOutcomeDbmlFail', 'importOutcomeDbmlFail']);
  });

  it('a closed Open dialog is no outcome', async () => {
    await importDbml(dbmlDeps(undefined));
    expect(outcomes()).toEqual([]);
  });

  it('the automatic draft: a quiet early end is draftDrop*, never a failed outcome; its shown draft counts', async () => {
    const drops: string[] = [];
    const preview = fakeDraftPreview(['discard']);
    const draft = { preview, trigger: 'sidebar' as const, quiet: true, quietDrop: (r: string) => { drops.push(r); } };
    await importDbml(dbmlDeps(undefined, { draft }), { filePath: path.join(tmp, 'missing.dbml') });
    expect(drops).toEqual(['unreadable']);
    expect(outcomes()).toEqual([]);

    const file = writeFile('shop.dbml', DBML);
    await importDbml(dbmlDeps(undefined, { draft }), { filePath: file, quick: true });
    expect(preview.drafts).toHaveLength(1);
    expect(outcomes()).toEqual(['importOutcomeDbmlClean']);
  });

  it('a redraw of a draft already shown is not counted again', async () => {
    const file = writeFile('shop.dbml', DBML);
    const preview = fakeDraftPreview(['discard']);
    await importDbml(dbmlDeps(file, { draft: { preview, trigger: 'palette' } }), {
      filePath: file,
      redraw: { fingerprint: 'another plan', settle: () => {}, draft: {} as Draft },
    });
    expect(preview.drafts).toHaveLength(1);
    expect(outcomes()).toEqual([]);
  });

  it('the bundled example is ERD Studio\'s own: no outcome', async () => {
    await importDbml(dbmlDeps(writeFile('example.dbml', DBML), { source: 'example' }));
    expect(outcomes()).toEqual([]);
  });
});

describe('Import Semantic Model… — its outcome', () => {
  function modelUi(folder: string | undefined): ImportSemanticModelUi {
    return {
      pickFolder: async () => folder,
      readDirectory: async (f) => fs.readdirSync(f, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
      readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
      pickModel: async () => undefined,
      showErrorMessage: async () => undefined,
      openFileAt: async () => {},
      sendFeedback: async () => {},
    };
  }

  it('a model that converts: its outcome and the ledger\'s cause classes, under SemanticModel', async () => {
    await importSemanticModel({ ...services(), modelUi: modelUi(path.join(MODEL_FIXTURES, 'pbip-tmdl')), ui: importUi() });
    const keys = outcomes();
    expect(keys[0]).toMatch(/^importOutcomeSemanticModel(Clean|Repaired|Partial)$/);
    expect(keys.slice(1).every((k) => k.startsWith('importCause'))).toBe(true);
    expect(keys.some((k) => k.startsWith('importSqlOutcome'))).toBe(false);
  });

  it('a folder with no model: failed; a closed folder pick: no outcome', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    await importSemanticModel({ ...services(), modelUi: modelUi(empty), ui: importUi() });
    await importSemanticModel({ ...services(), modelUi: modelUi(undefined), ui: importUi() });
    expect(outcomes()).toEqual(['importOutcomeSemanticModelFail']);
  });
});
