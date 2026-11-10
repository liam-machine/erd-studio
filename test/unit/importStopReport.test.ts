/**
 * Import SQL DDL… stopped by Cancel or its time limit, end to end through
 * the import report and the outcome telemetry (workflow C's three tracks
 * joined):
 *
 * - stopped before a table: the report holds the stopped reading's ledger
 *   (status `cancelled` / `timedOut`, each file's unread part linked at its
 *   line), the cancel's note and the time limit's error offer Show Import
 *   Report, and the import counts one `Cancelled` / `TimedOut` outcome with
 *   its cause class (by dialect only once one was chosen);
 * - stopped after some tables: the draft (here the dry run) imports what was
 *   read, the report says it was stopped and lists the rest, the Keep toast
 *   says the rest was not read (never "could not be read"), and the outcome
 *   is `Cancelled`, not `Partial`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlDeps, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SHOW_IMPORT_REPORT_LABEL, buildImportReportView, partialImportMessage } from '../../src/services/importReport';
import { _resetImportReports, latestImportReport, latestImportReportId } from '../../src/services/importReportStore';
import { inProcessSqlConverter, type SqlConverter } from '../../src/services/sqlConverter';
import type { SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { generatedSql } from './sqlImportPerformance.fixture';

let tmp: string;
let sqlFile: string;

beforeEach(() => {
  _resetMockWorkspace();
  _resetImportReports();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-stop-report-'));
  sqlFile = path.join(tmp, 'schema.sql');
  fs.writeFileSync(sqlFile, generatedSql(20));
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'featureQuiet');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetImportReports();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const quietKeys = (): string[] => vi.mocked(telemetry.featureQuiet).mock.calls.map((c) => c[0] as string);
const outcomeKeys = (): string[] => quietKeys().filter((k) => /^import(Outcome|SqlOutcome|Cause)/.test(k));
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Seen { picks: SqlDialect[]; errors: Array<{ message: string; items: string[] }>; infos: Array<{ message: string; items: string[] }>; reports: Array<number | undefined> }

function sqlUi(seen: Seen, more: Partial<ImportSqlDdlUi> = {}): ImportSqlDdlUi {
  return {
    pickSources: async () => ({ files: [sqlFile] }),
    readDirectory: async () => [],
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items) => { seen.picks.push(items[0].dialect); return items.find((i) => i.dialect === 'postgres'); },
    // Each message's buttons are pressed: Show Import Report is what is under test.
    showInformationMessage: async (message, ...items) => { seen.infos.push({ message, items }); return items.includes(SHOW_IMPORT_REPORT_LABEL) ? SHOW_IMPORT_REPORT_LABEL : undefined; },
    showErrorMessage: async (message, ...items) => { seen.errors.push({ message, items }); return items.includes(SHOW_IMPORT_REPORT_LABEL) ? SHOW_IMPORT_REPORT_LABEL : undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showLogs: async () => {},
    openSettings: async () => {},
    showImportReport: async (id) => { seen.reports.push(id); },
    ...more,
  };
}

function importUi(infos: string[] = []): ImportDbmlUi {
  return {
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => options.value,
    confirm: async () => true,
    showInformationMessage: async (message: string) => { infos.push(message); return undefined; },
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
}

function deps(sql: ImportSqlDdlUi, more: Partial<ImportSqlDdlDeps> = {}): ImportSqlDdlDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    extensionPath: '/nowhere', validateDomainName: () => undefined, onWritten: () => {},
    sqlUi: sql, ui: importUi(), loadSqlImport: () => engine, ...more,
  };
}

const seenOf = (): Seen => ({ picks: [], errors: [], infos: [], reports: [] });

/** Cancel pressed before the reading's first statement. */
const cancelAtOnce: ImportSqlDdlUi['withProgress'] = async (_title, task) => {
  const c = new AbortController();
  c.abort();
  return task({ report: () => {} }, c.signal);
};

/** Every reading is cancelled before its first statement (Cancel pressed as the reading starts). */
const cancelledAtStart = (): SqlConverter => {
  const inner = inProcessSqlConverter(() => engine);
  return {
    convert: (request, control) => { const c = new AbortController(); c.abort(); return inner.convert(request, { ...control, signal: c.signal }); },
    dispose: () => {},
  };
};

/** Every reading is already past its deadline. */
const pastDeadline = (): SqlConverter => {
  const inner = inProcessSqlConverter(() => engine);
  return { convert: (request, control) => inner.convert(request, { ...control, deadline: Date.now() - 1, timeLimitMs: 5_000 }), dispose: () => {} };
};

/** Stops (`cancelled`) after `statements` statements. */
const cancelAfter = (statements: number): (() => SqlConverter) => () => ({
  convert: async (request) => {
    let asked = 0;
    return engine.sqlDdlToDbml({ ...request, options: { shouldStop: () => (asked++ >= statements ? 'cancelled' : undefined) } });
  },
  dispose: () => {},
});

describe('stopped before a table was read', () => {
  it('Cancel during the dialect ranking: the report holds what was not read, the note links to it, one Cancelled outcome (no dialect)', async () => {
    const seen = seenOf();
    const run = await importSqlDdl(deps(sqlUi(seen), { sqlConverter: cancelledAtStart }));
    await flush();
    expect(run).toBeUndefined();
    expect(seen.picks).toEqual([]);

    const report = latestImportReport()!;
    expect(report.status).toBe('cancelled');
    expect(report.source).toBe('sql');
    expect(report.from).toBe('from 1 SQL file');
    expect(report.files).toEqual({ 'schema.sql': sqlFile });
    const unread = report.ledger.filter((e) => e.cause === 'cancelled');
    expect(unread.reduce((n, e) => n + (e.unit === 'table' ? e.count : 0), 0)).toBe(20);
    expect(unread.every((e) => e.where?.file === 'schema.sql' && e.where.line === 1)).toBe(true);
    const view = buildImportReportView(report);
    expect(view.status).toMatch(/stopped before it finished/);
    expect(view.links[0]).toEqual({ file: sqlFile, line: 1 });

    expect(seen.infos).toEqual([{ message: 'Import SQL DDL was cancelled before it read a table, so nothing was imported.', items: [SHOW_IMPORT_REPORT_LABEL] }]);
    expect(seen.reports).toEqual([latestImportReportId()]);
    expect(vi.mocked(telemetry.feature).mock.calls.map((c) => c[0])).toEqual(['importSqlDdlCancelled']);
    expect(outcomeKeys()).toEqual(['importOutcomeSqlDdlCancelled', 'importCauseCancelled']);
  });

  it('a cancel with no Show Import Report in the UI says nothing (the user just pressed Cancel), and still counts once', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen, { showImportReport: undefined }), { sqlConverter: cancelledAtStart }));
    await flush();
    expect(seen.infos).toEqual([]);
    expect(latestImportReport()?.status).toBe('cancelled');
    expect(outcomeKeys()).toEqual(['importOutcomeSqlDdlCancelled', 'importCauseCancelled']);
  });

  it('Cancel before the ranking read anything: an empty report (it says so), still linked and counted', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen, { withProgress: cancelAtOnce })));
    await flush();
    const report = latestImportReport()!;
    expect(report.status).toBe('cancelled');
    expect(report.ledger).toEqual([]);
    expect(seen.infos.map((i) => i.items)).toEqual([[SHOW_IMPORT_REPORT_LABEL]]);
    expect(outcomeKeys()).toEqual(['importOutcomeSqlDdlCancelled']);
  });

  it('the time limit on the chosen dialect: the error offers the setting and the report, one TimedOut outcome by dialect', async () => {
    const seen = seenOf();
    const run = await importSqlDdl(
      deps(sqlUi(seen), { timeLimitMs: 5_000, sqlConverter: pastDeadline }),
      undefined,
      { dialect: 'postgres', dialectChosen: true },
    );
    await flush();
    expect(run).toBeUndefined();
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0].message).toContain('reached its time limit (5 s) before it read a table');
    expect(seen.errors[0].items).toEqual(['Open Settings', SHOW_IMPORT_REPORT_LABEL, 'Show Logs']);
    expect(seen.reports).toEqual([latestImportReportId()]);

    const report = latestImportReport()!;
    expect(report.status).toBe('timedOut');
    expect(report.from).toBe('from 1 SQL file (PostgreSQL)');
    expect(report.ledger.some((e) => e.cause === 'timeLimit' && e.unit === 'table' && e.count === 20)).toBe(true);
    expect(outcomeKeys()).toEqual(['importOutcomeSqlDdlTimedOut', 'importSqlOutcomePostgresTimedOut', 'importCauseTimeLimit']);
  });

  it('the automatic draft\'s quiet stop records no report and no outcome (its drop reason says it)', async () => {
    const seen = seenOf();
    const dropped: string[] = [];
    await importSqlDdl(
      deps(sqlUi(seen), {
        timeLimitMs: 5_000,
        sqlConverter: pastDeadline,
        draft: { quiet: true, onDrop: (reason: string) => dropped.push(reason) } as unknown as ImportSqlDdlDeps['draft'],
      }),
      undefined,
      { dialect: 'postgres', dialectChosen: true },
    );
    await flush();
    expect(latestImportReport()).toBeUndefined();
    expect(outcomeKeys()).toEqual([]);
  });
});

describe('stopped after some tables were read', () => {
  it('imports what was read; the report says it was stopped; the outcome is Cancelled, not Partial', async () => {
    const seen = seenOf();
    const infos: string[] = [];
    const run = await importSqlDdl(
      deps(sqlUi(seen), { sqlConverter: cancelAfter(6), ui: importUi(infos) }),
      undefined,
      { dialect: 'postgres', dialectChosen: true },
    );
    await flush();
    const tables = run?.plan.modelNames.length ?? 0;
    expect(tables).toBeGreaterThan(0);
    expect(tables).toBeLessThan(20);

    const report = latestImportReport()!;
    expect(report.status).toBe('kept');
    const unreadTables = report.ledger.filter((e) => e.cause === 'cancelled' && e.unit === 'table').reduce((n, e) => n + e.count, 0);
    expect(tables + unreadTables).toBe(20);
    const view = buildImportReportView(report);
    expect(view.status).toMatch(/^Kept as the diagram .*\. The import was cancelled before it read every statement/);

    expect(outcomeKeys()).toEqual(['importOutcomeSqlDdlCancelled', 'importSqlOutcomePostgresCancelled', 'importCauseCancelled']);
    expect(quietKeys()).not.toContain('importOutcomeSqlDdlPartial');
    // A partial import is never the import's cancel.
    expect(vi.mocked(telemetry.feature).mock.calls.map((c) => c[0])).not.toContain('importSqlDdlCancelled');
  });

  it('the Keep toast says the rest was not read before the import stopped, apart from what could not be read', () => {
    expect(partialImportMessage('Import SQL DDL', [
      { outcome: 'problem', unit: 'table', cause: 'cancelled', what: 'CREATE TABLE', count: 14 },
      { outcome: 'problem', unit: 'statement', cause: 'cancelled', what: '', count: 1 },
    ])).toBe('Import SQL DDL: 14 tables and 1 statement were not read before the import was stopped, so the diagram leaves them out. Show Import Report lists each one with its file and line.');
    expect(partialImportMessage('Import SQL DDL', [
      { outcome: 'problem', unit: 'table', cause: 'parseError', what: 'CREATE TABLE', count: 2 },
      { outcome: 'problem', unit: 'table', cause: 'timeLimit', what: 'CREATE TABLE', count: 1 },
    ])).toBe('Import SQL DDL: 2 tables could not be read and 1 table was not read before the import was stopped, so the diagram leaves them out. Show Import Report lists each one with its file and line.');
  });
});

describe('a ledger from across the worker boundary', () => {
  it('an entry with a unit this build does not know logs as an item, never throws', async () => {
    const { ledgerLogLines } = await import('../../src/services/importLedger');
    const lines = ledgerLogLines([
      { outcome: 'problem', unit: 'widget' as never, cause: 'cancelled', what: 'CREATE TABLE', count: 2, where: { file: 'a.sql', line: 3 } },
      { outcome: 'problem', unit: '__proto__' as never, cause: 'timeLimit', what: '', count: 1 },
    ], 'Import SQL DDL');
    expect(lines).toEqual([
      'Import SQL DDL: a.sql line 3: 2 × item: problem, cancelled: CREATE TABLE',
      'Import SQL DDL: item: problem, timeLimit:',
    ]);
  });
});
