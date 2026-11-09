/**
 * Edge cases of Import SQL DDL…'s worker, Cancel and time limit (an
 * adversarial pass over `sqlConverter.ts`, `sqlImportWorker.ts`, the
 * converter's stop and the flow):
 *
 * - a time limit longer than a timer can hold never ends the worker early;
 * - a worker that cannot start (its bundle throws as it loads) falls back to
 *   converting in-process, as a missing bundle does;
 * - a worker that dies between conversions is replaced, never waited on, and
 *   its error never reaches the host as an uncaught exception;
 * - once the worker has stopped reading (it saw the cancel or the deadline),
 *   finishing what it read is never cut short by the grace period: only a
 *   single statement that keeps it busy is;
 * - a stop that comes while one table climbs the repair ladder ends the
 *   climb (the table is salvaged), so the limit is not overrun by a ladder;
 * - Cancel (or the time limit) during the dialect ranking, before any table
 *   is read, ends the step-by-step import: no dialect pick;
 * - a reading that stopped early is never carried into another run (Try
 *   Another Dialect): the dialect is read again, whole;
 * - a time limit under a millisecond is a limit, never "no limit".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

import { _resetMockConfiguration, _resetMockWorkspace, _setMockConfiguration } from '../__mocks__/vscode';
import type { ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, sqlImportTimeLimitMs, type ImportSqlDdlDeps, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SqlConvertAbandonedError, inProcessSqlConverter, workerSqlConverter, type SqlConverter } from '../../src/services/sqlConverter';
import { convertSqlDdl, sqlDialectReading, type SqlDdlToDbmlResult, type SqlDialect, type SqlDialectReading } from '../../src/services/sqlDdlImport';
import type { SqlParseEngine } from '../../src/services/sqlDdlModel';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { generatedSql } from './sqlImportPerformance.fixture';

const ROOT = path.resolve(__dirname, '../..');

/** A temporary extension folder with `dist/` files written from `files` (name → source). */
function extensionWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-edge-'));
  fs.mkdirSync(path.join(dir, 'dist'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'dist', name), text);
  return dir;
}

const made: string[] = [];
let workerBundle: string;

beforeAll(async () => {
  // The real worker bundle (as esbuild.js builds it); each test pairs it with a stub or the real importer.
  const out = await build({
    entryPoints: [path.join(ROOT, 'src/workers/sqlImportWorker.ts')],
    bundle: true, format: 'cjs', platform: 'node', target: 'node18', logLevel: 'silent', write: false,
  });
  workerBundle = out.outputFiles[0].text;
}, 60_000);

afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function ext(files: Record<string, string>): string {
  const dir = extensionWith(files);
  made.push(dir);
  return dir;
}

/** A stub `dist/sqlImport.js`: `body` is `sqlDdlToDbml(input)`'s body. */
function stubImporter(body: string): string {
  return `module.exports = { detectSqlDialect: () => undefined, sqlDdlToDbml: (input) => { ${body} } };`;
}

/** The engine's own result for a tiny script, as a stub returns it. */
const TINY = JSON.stringify(engine.sqlDdlToDbml({ files: [{ name: 'a.sql', text: generatedSql(2) }], dialect: 'postgres' }));

const within = <T>(ms: number, p: Promise<T>): Promise<T> =>
  Promise.race([p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms))]);

describe('the worker', () => {
  it('a time limit longer than a timer can hold (about 24.8 days) never ends the worker early', async () => {
    // A slow but finite conversion: 600 ms, never stopping.
    const dir = ext({
      'sqlImportWorker.js': workerBundle,
      'sqlImport.js': stubImporter(`const until = Date.now() + 600; while (Date.now() < until) { input.options.shouldStop(); } return ${TINY};`),
    });
    const converter = workerSqlConverter({ extensionPath: dir, graceMs: 100 });
    try {
      const timeLimitMs = 40 * 24 * 3600 * 1000;
      const result = await converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' }, { deadline: Date.now() + timeLimitMs, timeLimitMs });
      expect(result.ok).toBe(true);
    } finally {
      converter.dispose();
    }
  }, 20_000);

  it('a worker that cannot start (its bundle throws as it loads) falls back to converting in-process, and says so once', async () => {
    const dir = ext({ 'sqlImportWorker.js': 'throw new Error("this worker cannot start");' });
    const said: string[] = [];
    const converter = workerSqlConverter({ extensionPath: dir, loadInProcess: () => engine, log: (m) => said.push(m) });
    try {
      const files = [{ name: 'a.sql', text: generatedSql(2) }];
      expect(await within(10_000, converter.convert({ files, dialect: 'postgres' }))).toEqual(engine.sqlDdlToDbml({ files, dialect: 'postgres' }));
      await converter.convert({ files, dialect: 'postgres' });
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(/^the SQL conversion runs on the extension host \(the worker could not start: .*this worker cannot start/);
    } finally {
      converter.dispose();
    }
  }, 20_000);

  it('a worker that exits between conversions is replaced: the next conversion is never posted to a dead worker', async () => {
    // Answers once, then its thread ends.
    const dir = ext({
      'sqlImportWorker.js': `const { parentPort } = require('worker_threads');
parentPort.on('message', (msg) => { parentPort.postMessage({ id: msg.id, type: 'result', result: ${TINY} }); setTimeout(() => process.exit(0), 5); });`,
    });
    const converter = workerSqlConverter({ extensionPath: dir });
    try {
      const request = { files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' as SqlDialect };
      expect((await within(5_000, converter.convert(request))).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect((await within(5_000, converter.convert(request))).ok).toBe(true);
    } finally {
      converter.dispose();
    }
  }, 20_000);

  it('an error a worker raises between conversions never reaches the host as an uncaught exception', async () => {
    const dir = ext({
      'sqlImportWorker.js': `const { parentPort } = require('worker_threads');
parentPort.on('message', (msg) => { parentPort.postMessage({ id: msg.id, type: 'result', result: ${TINY} }); setTimeout(() => { throw new Error('late failure'); }, 5); });`,
    });
    const uncaught: unknown[] = [];
    const record = (err: unknown): void => { uncaught.push(err); };
    process.on('uncaughtException', record);
    const converter = workerSqlConverter({ extensionPath: dir });
    try {
      expect((await converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' })).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(uncaught).toEqual([]);
      // And the next conversion gets a working worker.
      expect((await within(5_000, converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' }))).ok).toBe(true);
    } finally {
      process.off('uncaughtException', record);
      converter.dispose();
    }
  }, 20_000);

  it('once the worker has stopped reading, finishing what it read is never cut short by the grace period', async () => {
    // Sees the cancel at a statement boundary, then spends 600 ms converting what it read (longer than the grace).
    const dir = ext({
      'sqlImportWorker.js': workerBundle,
      'sqlImport.js': stubImporter(`let reason; while (!(reason = input.options.shouldStop())) {}
const until = Date.now() + 600; while (Date.now() < until) {}
const r = ${TINY}; r.stopped = { reason, statementsRead: 1, statementsUnread: 1, tablesUnread: 1, at: { file: 'a.sql', line: 5 } }; return r;`),
    });
    const converter = workerSqlConverter({ extensionPath: dir, graceMs: 150 });
    const abort = new AbortController();
    try {
      setTimeout(() => abort.abort(), 50);
      const result = await converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' }, { signal: abort.signal });
      expect(result.stopped?.reason).toBe('cancelled');
    } finally {
      converter.dispose();
    }
  }, 20_000);

  it('one statement that keeps the worker busy past the grace: ended (nothing read), and the next conversion gets a new worker', async () => {
    const dir = ext({
      'sqlImportWorker.js': workerBundle,
      'sqlImport.js': stubImporter(`if (input.files[0].text === 'hang') { for (;;) {} } return ${TINY};`),
    });
    const converter = workerSqlConverter({ extensionPath: dir, graceMs: 100 });
    const abort = new AbortController();
    try {
      setTimeout(() => { abort.abort(); abort.abort(); }, 50); // pressed twice
      await expect(converter.convert({ files: [{ name: 'a.sql', text: 'hang' }], dialect: 'postgres' }, { signal: abort.signal }))
        .rejects.toBeInstanceOf(SqlConvertAbandonedError);
      expect((await within(5_000, converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' }))).ok).toBe(true);
    } finally {
      converter.dispose();
    }
  }, 20_000);
});

describe('the converter', () => {
  it('a stop that comes while a table climbs the repair ladder ends the climb: the table is salvaged, the limit not overrun', () => {
    // A grammar that never reads and takes 40 ms a try: the whole ladder would be about ten tries.
    let tries = 0;
    const slow: SqlParseEngine = () => {
      tries++;
      const until = Date.now() + 40;
      while (Date.now() < until) { /* busy */ }
      throw new Error('no');
    };
    const deadline = Date.now() + 60;
    const result = convertSqlDdl({
      files: [{ name: 'a.sql', text: 'CREATE TABLE t (id INTEGER, name TEXT);\n' }],
      dialect: 'postgres',
      options: { shouldStop: () => (Date.now() >= deadline ? 'timeLimit' : undefined), timeLimitMs: 60 },
    }, slow);
    expect(tries).toBeLessThanOrEqual(3);
    expect(result.ok && result.tableCount).toBe(1);
    expect(result.readWith?.salvaged).toBe(1);
  });
});

describe('erdStudio.import.timeLimitSeconds', () => {
  afterEach(() => _resetMockConfiguration());
  it('a limit under a millisecond is still a limit (1 ms), never "no limit"', () => {
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { globalValue: 0.0001 });
    expect(sqlImportTimeLimitMs()).toBe(1);
    _setMockConfiguration('erdStudio', 'import.timeLimitSeconds', { globalValue: 0 });
    expect(sqlImportTimeLimitMs()).toBe(0);
  });
});

describe('the step-by-step flow', () => {
  let tmp: string;
  let sqlFile: string;
  beforeEach(() => {
    _resetMockWorkspace();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-edge-flow-'));
    sqlFile = path.join(tmp, 'schema.sql');
    fs.writeFileSync(sqlFile, generatedSql(20));
    vi.spyOn(telemetry, 'feature');
    vi.spyOn(telemetry, 'error');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const features = (): string[] => vi.mocked(telemetry.feature).mock.calls.map((c) => c[0] as string);

  function sqlUi(more: Partial<ImportSqlDdlUi> & { picks?: SqlDialect[]; errors?: string[] } = {}): ImportSqlDdlUi {
    return {
      pickSources: async () => ({ files: [sqlFile] }),
      readDirectory: async () => [],
      readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
      pickDialect: async (items) => { more.picks?.push(items[0].dialect); return items.find((i) => i.dialect === 'postgres'); },
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message) => { more.errors?.push(message); return undefined; },
      openFileAt: async () => {},
      sendFeedback: async () => {},
      showLogs: async () => {},
      openSettings: async () => {},
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

  /** Cancel pressed before the reading's first statement. */
  const cancelAtOnce: ImportSqlDdlUi['withProgress'] = async (_title, task) => {
    const c = new AbortController();
    c.abort();
    return task({ report: () => {} }, c.signal);
  };

  it('Cancel during the dialect ranking, before a table is read: the import ends, no dialect pick, counted as its cancel', async () => {
    const picks: SqlDialect[] = [];
    const run = await importSqlDdl(deps(sqlUi({ picks, withProgress: cancelAtOnce })));
    expect(run).toBeUndefined();
    expect(picks).toEqual([]);
    expect(features()).toEqual(['importSqlDdlCancelled']);
    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
  });

  it('the time limit during the dialect ranking, before a table is read: the error that names the setting, no dialect pick', async () => {
    const picks: SqlDialect[] = [];
    const errors: string[] = [];
    const late: () => SqlConverter = () => {
      const inner = inProcessSqlConverter(() => engine);
      return { convert: (request, control) => inner.convert(request, { ...control, deadline: Date.now() - 1 }), dispose: () => {} };
    };
    const run = await importSqlDdl(deps(sqlUi({ picks, errors }), { timeLimitMs: 5_000, sqlConverter: late }));
    expect(run).toBeUndefined();
    expect(picks).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('reached its time limit (5 s) before it read a table');
  });

  it('a reading that stopped early is never carried into another run: Try Another Dialect reads the dialect again, whole', async () => {
    const files = [{ name: 'schema.sql', text: fs.readFileSync(sqlFile, 'utf-8') }];
    let asked = 0;
    const partial = engine.sqlDdlToDbml({ files, dialect: 'postgres', options: { shouldStop: () => (asked++ >= 5 ? 'cancelled' : undefined) } });
    expect(partial.stopped).toBeDefined();
    const readings = new Map<SqlDialect, SqlDialectReading>([['postgres', sqlDialectReading('postgres', partial)]]);
    const converted: SqlDdlToDbmlResult[] = [];
    const recording = (): SqlConverter => {
      const inner = inProcessSqlConverter(() => engine);
      return { convert: async (request, control) => { const r = await inner.convert(request, control); if (request.dialect === 'postgres') converted.push(r); return r; }, dispose: () => {} };
    };
    const run = await importSqlDdl(deps(sqlUi(), { sqlConverter: recording }), {
      files, fullPaths: new Map([['schema.sql', sqlFile]]), fileName: 'schema.sql', sourceLabel: 'schema.sql', readings,
    });
    expect(run?.plan.modelNames).toHaveLength(20);
    expect(converted).toHaveLength(1);
    expect(converted[0].stopped).toBeUndefined();
  });
});
