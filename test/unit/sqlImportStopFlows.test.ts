/**
 * Import SQL DDL…'s flows when a reading stops in ways the plain stop does
 * not cover:
 *
 * - a worker ended because one step of the reading did not stop in time
 *   (`SqlConvertAbandonedError`) after it had read tables: the message says
 *   those tables were lost (never "before it read a table"), and the report
 *   holds the reading that was ended, at the file it was in;
 * - the time limit stopping the dialect ranking after other dialects read
 *   the scripts whole without a table: the dialect pick still says why no
 *   dialect reads a table (the conversion after the pick has its own limit);
 * - Cancel during the step-by-step ranking after a dialect read tables
 *   imports what was read, with no dialect pick;
 * - the automatic draft's time limit is its own drop reason.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, quickImportSqlDdl, type ImportSqlDdlDeps, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SHOW_IMPORT_REPORT_LABEL } from '../../src/services/importReport';
import { _resetImportReports, latestImportReport } from '../../src/services/importReportStore';
import { SqlConvertAbandonedError, type SqlConverter } from '../../src/services/sqlConverter';
import type { SqlConvertProgress, SqlDdlToDbmlResult, SqlDialect } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { generatedSql } from './sqlImportPerformance.fixture';

let tmp: string;
let sqlFile: string;

beforeEach(() => {
  _resetMockWorkspace();
  _resetImportReports();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-stop-flows-'));
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const quietKeys = (): string[] => vi.mocked(telemetry.featureQuiet).mock.calls.map((c) => c[0] as string);

interface Seen {
  picks: Array<{ placeHolder?: string; dialects: SqlDialect[] }>;
  errors: Array<{ message: string; items: string[] }>;
  infos: Array<{ message: string; items: string[] }>;
}

const seenOf = (): Seen => ({ picks: [], errors: [], infos: [] });

function sqlUi(seen: Seen, more: Partial<ImportSqlDdlUi> = {}): ImportSqlDdlUi {
  return {
    pickSources: async () => ({ files: [sqlFile] }),
    readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items, options) => {
      seen.picks.push({ ...(options?.placeHolder ? { placeHolder: options.placeHolder } : {}), dialects: items.map((i) => i.dialect) });
      return items.find((i) => i.dialect === 'postgres');
    },
    showInformationMessage: async (message, ...items) => { seen.infos.push({ message, items }); return undefined; },
    showErrorMessage: async (message, ...items) => { seen.errors.push({ message, items }); return undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showLogs: async () => {},
    openSettings: async () => {},
    showImportReport: async () => {},
    ...more,
  };
}

function importUi(): ImportDbmlUi {
  return {
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => options.value,
    confirm: async () => true,
    showInformationMessage: async () => undefined,
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

/** How far the ended reading had got: 5,000 tables, in the first of the files. */
const FAR: SqlConvertProgress = { statementsRead: 6000, tablesRead: 5000, filesRead: 0, files: 1, fraction: 0.6 };

/** Every reading is ended by the host after the grace: one step did not stop. */
const abandoned = (reason: 'cancelled' | 'timeLimit', progress?: SqlConvertProgress) => (): SqlConverter => ({
  convert: async () => { throw new SqlConvertAbandonedError(reason, progress); },
  dispose: () => {},
});

describe('a reading ended after the grace, once it had read tables', () => {
  it('the conversion after the pick: the message says the tables read were lost, never "before it read a table"; the report holds it', async () => {
    const seen = seenOf();
    const run = await importSqlDdl(
      deps(sqlUi(seen), { timeLimitMs: 120_000, sqlConverter: abandoned('timeLimit', FAR) }),
      undefined,
      { dialect: 'postgres', dialectChosen: true },
    );
    await flush();
    expect(run).toBeUndefined();
    expect(seen.errors).toHaveLength(1);
    const message = seen.errors[0].message;
    expect(message).not.toContain('before it read a table');
    expect(message).toContain('reached its time limit (2 min)');
    expect(message).toContain('5,000 tables it had read were lost');
    expect(seen.errors[0].items).toContain(SHOW_IMPORT_REPORT_LABEL);

    const report = latestImportReport()!;
    expect(report.status).toBe('timedOut');
    const ended = report.ledger.filter((e) => e.cause === 'timeLimit');
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: 'problem', unit: 'file', where: { file: 'schema.sql' } });
    expect(ended[0].detail).toContain('5,000 tables');
    expect(quietKeys()).toContain('importCauseTimeLimit');
  });

  it('the dialect ranking (step by step): the same message, and no dialect pick', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen), { timeLimitMs: 120_000, sqlConverter: abandoned('timeLimit', FAR) }));
    await flush();
    expect(seen.picks).toEqual([]);
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0].message).toContain('5,000 tables it had read were lost');
  });

  it('the quick path: the same message', async () => {
    const seen = seenOf();
    await quickImportSqlDdl(deps(sqlUi(seen), { timeLimitMs: 120_000, sqlConverter: abandoned('timeLimit', FAR) }));
    await flush();
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0].message).toContain('5,000 tables it had read were lost');
  });

  it('Cancel: the note says the tables read were lost, with the report', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen), { sqlConverter: abandoned('cancelled', FAR) }), undefined, { dialect: 'postgres', dialectChosen: true });
    await flush();
    expect(seen.infos).toHaveLength(1);
    expect(seen.infos[0].message).toContain('was cancelled');
    expect(seen.infos[0].message).toContain('5,000 tables it had read were lost');
    expect(seen.infos[0].items).toEqual([SHOW_IMPORT_REPORT_LABEL]);
  });

  it('ended before it read a table: still "before it read a table", and the report still holds the ended reading', async () => {
    const seen = seenOf();
    await importSqlDdl(
      deps(sqlUi(seen), { timeLimitMs: 5_000, sqlConverter: abandoned('timeLimit', { ...FAR, tablesRead: 0 }) }),
      undefined,
      { dialect: 'postgres', dialectChosen: true },
    );
    await flush();
    expect(seen.errors[0].message).toContain('reached its time limit (5 s) before it read a table');
    expect(latestImportReport()!.ledger.some((e) => e.cause === 'timeLimit' && e.unit === 'file')).toBe(true);
  });
});

/** A result no dialect reads a table of: one parse problem. */
const unreadable = (dialect: SqlDialect): SqlDdlToDbmlResult => ({
  ok: false,
  problems: [{ file: 'schema.sql', line: 3, message: `CREATE TABLE t0: ${dialect} cannot read it.`, kind: 'parse', table: 't0' }],
  ledger: [{ outcome: 'problem', unit: 'table', cause: 'parseError', what: 'CREATE TABLE', count: 20, where: { file: 'schema.sql', line: 1 } }],
  tablesFound: 20,
});

/** Every dialect reads no table; the reading that comes `stopAt`-th (1-based) is stopped by the time limit first. */
const noneReadsThenTimeLimit = (stopAt: number) => (): SqlConverter => {
  let calls = 0;
  return {
    convert: async (request) => {
      calls++;
      if (calls !== stopAt) return unreadable(request.dialect);
      return {
        ok: false, problems: [], tablesFound: 20,
        ledger: [{ outcome: 'problem', unit: 'table', cause: 'timeLimit', what: 'CREATE TABLE', count: 20, where: { file: 'schema.sql', line: 1 } }],
        stopped: { reason: 'timeLimit', statementsRead: 0, statementsUnread: 20, tablesUnread: 20, at: { file: 'schema.sql', line: 1 } },
      };
    },
    dispose: () => {},
  };
};

describe('the time limit stops the ranking after other dialects read the scripts whole without a table', () => {
  it('step by step: the dialect pick says why no dialect reads a table, and the chosen dialect\'s problems are reported', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen), { timeLimitMs: 120_000, sqlConverter: noneReadsThenTimeLimit(5) }));
    await flush();
    expect(seen.picks).toHaveLength(1);
    expect(seen.picks[0].placeHolder).toMatch(/^No dialect reads a table in the script \(/);
    // The chosen dialect's own problems, never advice to raise the limit.
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0].message).not.toContain('time limit');
    expect(seen.errors[0].message).toContain('cannot read it');
  });

  it('the quick path hands over to the dialect pick, which says why', async () => {
    const seen = seenOf();
    await quickImportSqlDdl(deps(sqlUi(seen), { timeLimitMs: 120_000, sqlConverter: noneReadsThenTimeLimit(5) }));
    await flush();
    expect(seen.picks).toHaveLength(1);
    expect(seen.picks[0].placeHolder).toMatch(/^No dialect reads a table/);
    expect(seen.errors.every((e) => !e.message.includes('time limit'))).toBe(true);
  });

  it('the time limit before any dialect read the scripts whole still ends the import with the time-limit error', async () => {
    const seen = seenOf();
    await importSqlDdl(deps(sqlUi(seen), { timeLimitMs: 5_000, sqlConverter: noneReadsThenTimeLimit(1) }));
    await flush();
    expect(seen.picks).toEqual([]);
    expect(seen.errors[0].message).toContain('reached its time limit (5 s) before it read a table');
  });
});

describe('Cancel during the step-by-step ranking after a dialect read tables', () => {
  it('imports what was read: no dialect pick', async () => {
    const seen = seenOf();
    // The first dialect read is stopped by Cancel after six statements.
    const cancelAfterSix = (): SqlConverter => ({
      convert: async (request) => {
        let asked = 0;
        return engine.sqlDdlToDbml({ ...request, options: { shouldStop: () => (asked++ >= 6 ? 'cancelled' : undefined) } });
      },
      dispose: () => {},
    });
    const run = await importSqlDdl(deps(sqlUi(seen), { sqlConverter: cancelAfterSix }));
    await flush();
    expect(seen.picks).toEqual([]);
    const tables = run?.plan.modelNames.length ?? 0;
    expect(tables).toBeGreaterThan(0);
    expect(tables).toBeLessThan(20);
    expect(latestImportReport()!.ledger.some((e) => e.cause === 'cancelled')).toBe(true);
  });
});

describe('the automatic draft', () => {
  it('a time-limit stop before a table is its own drop reason, never "unreadable"', async () => {
    const seen = seenOf();
    const dropped: string[] = [];
    const pastDeadline = (): SqlConverter => ({
      convert: async (request, control) => engine.sqlDdlToDbml({ ...request, options: { shouldStop: () => 'timeLimit', ...(control?.timeLimitMs ? { timeLimitMs: control.timeLimitMs } : {}) } }),
      dispose: () => {},
    });
    await quickImportSqlDdl(deps(sqlUi(seen), {
      timeLimitMs: 5_000,
      sqlConverter: pastDeadline,
      draft: { quiet: true, quietDrop: (reason: string) => dropped.push(reason) } as unknown as ImportSqlDdlDeps['draft'],
    }));
    await flush();
    expect(dropped).toEqual(['timeLimit']);
    expect(latestImportReport()).toBeUndefined();
  });
});

describe('the progress notification during the dialect ranking', () => {
  it('each dialect read after the first starts its bar again (restart), never sharing one already full', async () => {
    const seen = seenOf();
    const events: string[] = [];
    const withProgress: ImportSqlDdlUi['withProgress'] = async (_title, task) => task({
      report: (message) => { const d = /read as (.*?)( \(|$)/.exec(message)?.[1] ?? '?'; if (events[events.length - 1] !== d) events.push(d); },
      restart: () => { events.push('restart'); },
    }, new AbortController().signal);
    await importSqlDdl(deps(sqlUi(seen, { withProgress })));
    const dialects = events.filter((e) => e !== 'restart');
    expect(dialects.length).toBeGreaterThan(1);
    // Every change of dialect comes after a restart.
    for (let i = 1; i < events.length; i++) {
      if (events[i] !== 'restart' && events[i - 1] !== 'restart') throw new Error(`no restart before ${events[i]}: ${events.join(', ')}`);
    }
  });
});
