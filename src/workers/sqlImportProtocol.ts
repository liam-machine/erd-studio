/**
 * The messages between the host and the SQL import worker
 * (`sqlImportWorker.ts`, `dist/sqlImportWorker.js`). Types and constants
 * only, so both sides import it without pulling anything in. Plain data: the
 * request carries no functions (the worker builds `shouldStop` and
 * `onProgress` itself), and the result is the converter's own JSON-safe
 * result, ledger included.
 *
 * No `vscode`.
 */

import type { SqlConvertProgress, SqlDdlConvertOptions, SqlDdlToDbmlInput, SqlDdlToDbmlResult } from '../services/sqlDdlImport';

/** The worker bundle's file name under `dist/`. */
export const SQL_IMPORT_WORKER_BUNDLE = 'sqlImportWorker.js';

/** What a worker is started with (`workerData`). */
export interface SqlWorkerData {
  /** The extension's folder: the worker loads the converter from `<extensionPath>/dist/sqlImport.js`. */
  extensionPath: string;
}

/** The options that cross to the worker: plain data only. */
export type SqlConvertPlainOptions = Pick<SqlDdlConvertOptions, 'repair' | 'ladderTables' | 'ladderMs'>;

/** One conversion, as the host asks for it. */
export interface SqlConvertRequest extends SqlDdlToDbmlInput {
  options?: SqlConvertPlainOptions;
}

/** Host → worker: convert, stopping when `control[0]` becomes {@link SQL_WORKER_CANCELLED} or at `deadline`. */
export interface SqlWorkerRequest {
  id: number;
  request: SqlConvertRequest;
  /** A `SharedArrayBuffer` of one Int32: the host stores 1 there to cancel (read with `Atomics.load` between statements). */
  control: SharedArrayBuffer;
  /** `Date.now()` at which the reading stops with `timeLimit`; absent: no limit. */
  deadline?: number;
  /** The time limit (ms), for the ledger's wording. */
  timeLimitMs?: number;
  /** At most one progress message per this many ms. */
  progressMs: number;
}

/** The value of `control[0]` once the host cancels. */
export const SQL_WORKER_CANCELLED = 1;

/** Worker → host. */
export type SqlWorkerMessage =
  | { id: number; type: 'progress'; progress: SqlConvertProgress }
  | { id: number; type: 'result'; result: SqlDdlToDbmlResult }
  /** `load`: the converter bundle could not be loaded (a broken install), not a failed conversion. */
  | { id: number; type: 'error'; error: string; load?: boolean };
