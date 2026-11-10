/**
 * Import SQL DDL… on a large script: a generated 5,000-table PostgreSQL file
 * (built here, never committed; `sqlImportPerformance.fixture.ts`).
 *
 * - The conversion (the quick path's reading: `readAsDialects`, in-process
 *   here; the worker runs the same function, `sqlImportWorker.test.ts`)
 *   finishes within a generous bound and reads every table.
 * - Cancel mid-way, through the flow's own progress hook (`withProgress`'s
 *   signal, aborted once half the text is read): the step-by-step flow
 *   imports the tables read so far and reports the rest, from the line where
 *   reading stopped, in the dry run's notice and the ledger (conservation:
 *   tables imported + tables reported = 5,000).
 * - The time limit before a table is read: nothing imported, an error that
 *   names the setting, with Open Settings.
 *
 * A time over its budget is printed; the test fails above three times the
 * budget (eight on CI), as `dbmlPerformance.test.ts` does.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import {
  OPEN_SETTINGS_BUTTON,
  TIME_LIMIT_SETTING,
  importSqlDdl,
  readAsDialects,
  sqlPartialNotice,
  type ImportSqlDdlDeps,
  type ImportSqlDdlUi,
} from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { inProcessSqlConverter, type SqlConverter } from '../../src/services/sqlConverter';
import type { SqlDdlToDbmlResult } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { generatedSqlWithLines } from './sqlImportPerformance.fixture';

const TABLES = 5_000;
const MARGIN = process.env.CI ? 8 : 3;
/** The whole conversion of 5,000 tables (about 2 s on a laptop). */
const CONVERT_BUDGET_MS = 6_000;

let tmp: string;
let sqlFile: string;
let lines: number[];

async function withinBudget<T>(label: string, budgetMs: number, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  if (elapsed > budgetMs || process.env.SQL_PERF_LOG) {
    console.warn(`[sqlImportPerformance] ${label}: ${elapsed.toFixed(0)} ms, budget ${budgetMs} ms (fails above ${MARGIN}×)`);
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms`).toBeLessThanOrEqual(budgetMs * MARGIN);
  return result;
}

function sqlUi(options: { abortAtFraction?: number; errors?: Array<{ message: string; items: string[] }>; settings?: string[] } = {}): ImportSqlDdlUi {
  return {
    pickSources: async () => ({ files: [sqlFile] }),
    readDirectory: async () => [],
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickDialect: async (items) => items.find((i) => i.dialect === 'postgres'),
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message, ...items) => { options.errors?.push({ message, items }); return undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showLogs: async () => {},
    openSettings: async (setting) => { options.settings?.push(setting); },
    // The notification's Cancel, pressed once the reading is past `abortAtFraction`.
    withProgress: async (_title, task) => {
      const cancel = new AbortController();
      return task({ report: (_message, fraction) => { if (options.abortAtFraction !== undefined && (fraction ?? 0) >= options.abortAtFraction) cancel.abort(); } }, cancel.signal);
    },
  };
}

function importUi(confirms: Array<{ message: string; detail: string }>): ImportDbmlUi {
  return {
    pickFile: async () => { throw new Error('no Open dialog for converted DBML'); },
    readFile: async () => { throw new Error('converted DBML is never read from disk'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) =>
      (items as unknown as Array<{ id: string }>).find((i) => i.id === 'gold') as unknown as T | undefined,
    showInputBox: async (options) => options.value,
    confirm: async (message, detail) => { confirms.push({ message, detail }); return true; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
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

beforeEach(() => {
  _resetMockWorkspace();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-perf-'));
  const generated = generatedSqlWithLines(TABLES);
  lines = generated.lines;
  sqlFile = path.join(tmp, 'big.sql');
  fs.writeFileSync(sqlFile, generated.text);
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import SQL DDL… on 5,000 tables', () => {
  it('reads every table within the budget', async () => {
    const files = [{ name: 'big.sql', text: fs.readFileSync(sqlFile, 'utf-8') }];
    const readings = await withinBudget('5,000 tables read as PostgreSQL', CONVERT_BUDGET_MS,
      () => readAsDialects(inProcessSqlConverter(() => engine), files, ['postgres']));
    const reading = readings.get('postgres')!;
    expect(reading.tablesRead).toBe(TABLES);
    expect(reading.result.ok && reading.result.refCount).toBe(TABLES - 1);
    expect(reading.result.stopped).toBeUndefined();
  }, 120_000);

  it('Cancel half-way: the tables read so far are imported, the rest reported from where reading stopped', async () => {
    const confirms: Array<{ message: string; detail: string }> = [];
    // The conversion's own result (its ledger travels to the draft as the origin's).
    const converted: SqlDdlToDbmlResult[] = [];
    const recording = (): SqlConverter => {
      const inner = inProcessSqlConverter(() => engine);
      return { convert: async (request, control) => { const r = await inner.convert(request, control); converted.push(r); return r; }, dispose: () => {} };
    };
    const run = await importSqlDdl(deps(sqlUi({ abortAtFraction: 0.5 }), importUi(confirms), { sqlConverter: recording }));
    expect(run).toBeDefined();
    const imported = run!.plan.modelNames.length;
    expect(imported).toBeGreaterThan(TABLES * 0.4);
    expect(imported).toBeLessThan(TABLES * 0.6);
    // One reading: the ranking stops at the cancel and reads no other dialect; the pick reuses it.
    expect(converted).toHaveLength(1);
    expect(converted[0].stopped?.reason).toBe('cancelled');
    const ledger = converted[0].ledger ?? [];
    const reported = ledger.filter((e) => e.cause === 'cancelled' && e.unit === 'table');
    // Conservation: every table is imported or reported, and the report says where reading stopped.
    expect(imported + reported.reduce((n, e) => n + e.count, 0)).toBe(TABLES);
    expect(reported).toHaveLength(1);
    expect(reported[0].where).toEqual({ file: 'big.sql', line: lines[imported] });
    // The dry run's Not imported line counts them; the draft's notice says where (sqlConvertStop.test.ts).
    expect(confirms).toHaveLength(1);
    expect(confirms[0].detail).toContain(`Not imported: ${(TABLES - imported).toLocaleString('en-US')} tables: CREATE TABLE not read: the import was cancelled first`);
    expect(converted[0].ok && sqlPartialNotice(converted[0])).toBe(`The import was cancelled at big.sql line ${lines[imported].toLocaleString('en-US')}: ${(TABLES - imported).toLocaleString('en-US')} of 5,000 tables were not read; Show details lists them.`);
  }, 120_000);

  it('the time limit before a table is read: nothing imported, an error naming the setting, with Open Settings', async () => {
    const errors: Array<{ message: string; items: string[] }> = [];
    const settings: string[] = [];
    const confirms: Array<{ message: string; detail: string }> = [];
    const sql = sqlUi({ errors, settings });
    // A deadline already passed: the reading stops before its first statement.
    const run = await importSqlDdl(deps(sql, importUi(confirms), { timeLimitMs: 5_000, sqlConverter: () => {
      const inner = inProcessSqlConverter(() => engine);
      return { convert: (request, control) => inner.convert(request, { ...control, deadline: Date.now() - 1 }), dispose: () => {} };
    } }));
    expect(run).toBeUndefined();
    expect(confirms).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(new RegExp(`reached its time limit \\(5 s\\) before it read a table, so nothing was imported\\. Raise the limit \\(${TIME_LIMIT_SETTING.replace(/\./g, '\\.')}\\)`));
    expect(errors[0].items).toEqual([OPEN_SETTINGS_BUTTON, 'Show Logs']);
    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
  }, 120_000);
});
