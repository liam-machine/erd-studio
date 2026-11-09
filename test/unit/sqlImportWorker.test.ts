/**
 * The SQL import worker (`dist/sqlImportWorker.js`, `src/services/sqlConverter.ts`):
 * both bundles are built here the way `esbuild.js` builds them, into a
 * temporary extension folder, and a real worker thread converts a generated
 * 5,000-table script while the host's event loop keeps running. Cancel stops
 * it between statements (a shared flag, since the worker is busy), the
 * deadline does the same, and what was read comes back with the rest in the
 * ledger. Without the worker bundle the conversion runs in-process; without
 * the importer bundle it is a load error, never the user's SQL.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build, type Plugin } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SqlEngineLoadError, inProcessSqlConverter, workerSqlConverter } from '../../src/services/sqlConverter';
import type { SqlConvertProgress } from '../../src/services/sqlDdlImport';
import * as engine from '../../src/services/sqlImportEngine';
import { generatedSql } from './sqlImportPerformance.fixture';

const ROOT = path.resolve(__dirname, '../..');
const TABLES = 5_000;

/** esbuild.js's stub for the Oracle grammar (not offered, not bundled). */
const ORACLE_GRAMMAR = /[\\/]ANTLR[\\/](parsers[\\/]oraclesql[\\/]|ASTGeneration[\\/]oraclesql[\\/])/;
const stubOracleGrammar: Plugin = {
  name: 'stub-oracle-grammar',
  setup(b) {
    b.onResolve({ filter: /oraclesql[\\/]/ }, (args) => {
      const resolved = path.resolve(args.resolveDir, args.path);
      return ORACLE_GRAMMAR.test(resolved) ? { path: resolved, namespace: 'oracle-grammar-stub' } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'oracle-grammar-stub' }, () => ({ contents: 'export default class X { constructor() { throw new Error("no Oracle"); } }', loader: 'js' }));
  },
};

let ext: string;
let workerInputs: string[];

beforeAll(async () => {
  ext = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-worker-'));
  const common = { bundle: true, format: 'cjs' as const, platform: 'node' as const, target: 'node18', logLevel: 'silent' as const };
  const [, worker] = await Promise.all([
    build({ ...common, entryPoints: [path.join(ROOT, 'src/services/sqlImportEngine.ts')], outfile: path.join(ext, 'dist/sqlImport.js'), plugins: [stubOracleGrammar] }),
    build({ ...common, entryPoints: [path.join(ROOT, 'src/workers/sqlImportWorker.ts')], outfile: path.join(ext, 'dist/sqlImportWorker.js'), metafile: true }),
  ]);
  workerInputs = Object.keys(worker.metafile!.inputs);
}, 120_000);

afterAll(() => {
  fs.rmSync(ext, { recursive: true, force: true });
});

describe('the SQL import worker', () => {
  it('stays small: no grammar and no vscode in its bundle (it loads dist/sqlImport.js at run time)', () => {
    expect(workerInputs.filter((i) => i.includes('node_modules/@dbml/core/'))).toEqual([]);
    expect(workerInputs.filter((i) => /sqlImportEngine|vscode/.test(i))).toEqual([]);
  });

  it('converts 5,000 tables off the host thread: the result matches the in-process one, and the host keeps running', async () => {
    const files = [{ name: 'big.sql', text: generatedSql(TABLES) }];
    const converter = workerSqlConverter({ extensionPath: ext, log: (m) => { throw new Error(`fell back: ${m}`); } });
    let ticks = 0;
    const tick = setInterval(() => { ticks++; }, 10);
    const progress: SqlConvertProgress[] = [];
    try {
      const started = Date.now();
      const result = await converter.convert({ files, dialect: 'postgres' }, { onProgress: (p) => progress.push(p) });
      const ms = Date.now() - started;
      expect(result.ok && result.tableCount).toBe(TABLES);
      expect(result).toEqual(engine.sqlDdlToDbml({ files, dialect: 'postgres' }));
      // The host's timers ran while the worker read (a blocked host would tick once at the end).
      expect(ticks).toBeGreaterThan(Math.min(20, ms / 40));
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      clearInterval(tick);
      converter.dispose();
    }
  }, 120_000);

  it('the partitions choice crosses to the worker: folded by default, kept as tables when asked', async () => {
    const text = [
      'CREATE TABLE payment (payment_id int NOT NULL, paid_on date NOT NULL, PRIMARY KEY (payment_id, paid_on)) PARTITION BY RANGE (paid_on);',
      "CREATE TABLE payment_2024 PARTITION OF payment FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');",
      "CREATE TABLE payment_2025 PARTITION OF payment FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');",
    ].join('\n');
    const files = [{ name: 'payment.sql', text }];
    const converter = workerSqlConverter({ extensionPath: ext, log: (m) => { throw new Error(`fell back: ${m}`); } });
    try {
      const folded = await converter.convert({ files, dialect: 'postgres' });
      const kept = await converter.convert({ files, dialect: 'postgres', options: { partitions: 'tables' } });
      expect(folded.ok && folded.tableCount).toBe(1);
      expect(folded.ok && folded.partitions).toEqual({ folded: 2, kept: 0 });
      expect(kept.ok && kept.tableCount).toBe(3);
      expect(kept).toEqual(engine.sqlDdlToDbml({ files, dialect: 'postgres', options: { partitions: 'tables' } }));
    } finally {
      converter.dispose();
    }
  }, 60_000);

  it('Cancel mid-way: the worker stops at the next statement and returns what it read, the rest in the ledger', async () => {
    const files = [{ name: 'big.sql', text: generatedSql(TABLES) }];
    const converter = workerSqlConverter({ extensionPath: ext });
    const abort = new AbortController();
    try {
      const result = await converter.convert({ files, dialect: 'postgres' }, {
        signal: abort.signal,
        onProgress: (p) => { if (p.tablesRead >= 1_000) abort.abort(); },
      });
      expect(result.stopped?.reason).toBe('cancelled');
      expect(result.ok).toBe(true);
      if (!result.ok || !result.stopped) return;
      expect(result.tableCount).toBeGreaterThanOrEqual(1_000);
      expect(result.tableCount).toBeLessThan(TABLES);
      const reported = (result.ledger ?? []).filter((e) => e.cause === 'cancelled' && e.unit === 'table').reduce((n, e) => n + e.count, 0);
      expect(result.tableCount + reported).toBe(TABLES);
      expect(result.stopped.at.file).toBe('big.sql');
      // The worker is kept for the next conversion (the dialect ranking reads again).
      const again = await converter.convert({ files: [{ name: 'small.sql', text: generatedSql(3) }], dialect: 'postgres' });
      expect(again.ok && again.tableCount).toBe(3);
    } finally {
      converter.dispose();
    }
  }, 120_000);

  it('the deadline stops it the same way (timeLimit), with the limit in the ledger\'s words', async () => {
    const files = [{ name: 'big.sql', text: generatedSql(TABLES) }];
    const converter = workerSqlConverter({ extensionPath: ext });
    try {
      const result = await converter.convert({ files, dialect: 'postgres' }, { deadline: Date.now() + 300, timeLimitMs: 300 });
      expect(result.stopped?.reason).toBe('timeLimit');
      const entry = (result.ledger ?? []).find((e) => e.cause === 'timeLimit');
      expect(entry?.detail).toBe('not read: the time limit (0.3 s) was reached first');
    } finally {
      converter.dispose();
    }
  }, 120_000);

  it('without dist/sqlImportWorker.js: converts in-process, and says so once', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-noworker-'));
    const said: string[] = [];
    const converter = workerSqlConverter({ extensionPath: bare, loadInProcess: () => engine, log: (m) => said.push(m) });
    try {
      const files = [{ name: 'a.sql', text: generatedSql(2) }];
      expect(await converter.convert({ files, dialect: 'postgres' })).toEqual(engine.sqlDdlToDbml({ files, dialect: 'postgres' }));
      await converter.convert({ files, dialect: 'postgres' });
      expect(said).toEqual(['the SQL conversion runs on the extension host (no sqlImportWorker.js).']);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('a worker without dist/sqlImport.js: a load error (ours), not a failed conversion', async () => {
    const half = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sql-noengine-'));
    fs.mkdirSync(path.join(half, 'dist'));
    fs.copyFileSync(path.join(ext, 'dist/sqlImportWorker.js'), path.join(half, 'dist/sqlImportWorker.js'));
    const converter = workerSqlConverter({ extensionPath: half });
    try {
      await expect(converter.convert({ files: [{ name: 'a.sql', text: generatedSql(1) }], dialect: 'postgres' })).rejects.toBeInstanceOf(SqlEngineLoadError);
    } finally {
      converter.dispose();
      fs.rmSync(half, { recursive: true, force: true });
    }
  }, 30_000);

  it('in-process: an importer that does not load is a load error too', async () => {
    const converter = inProcessSqlConverter(() => { throw new Error('missing'); });
    await expect(converter.convert({ files: [{ name: 'a.sql', text: 'x' }], dialect: 'postgres' })).rejects.toBeInstanceOf(SqlEngineLoadError);
  });
});
