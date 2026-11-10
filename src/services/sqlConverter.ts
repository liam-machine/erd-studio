/**
 * Runs Import SQL DDL…'s conversion (`sqlDdlToDbml`: `convertSqlDdl` with
 * the repair ladder and salvage) off the extension host's thread, with
 * progress, Cancel and a time limit.
 *
 * - {@link workerSqlConverter}: the extension's converter. Each conversion
 *   runs in `dist/sqlImportWorker.js` (one worker per import, started on the
 *   first conversion and ended by `dispose`), the manifest worker's pattern
 *   (`manifestService.ts`). Without the worker bundle (a dev host before
 *   `npm run build`, a test) it converts in-process instead.
 * - {@link inProcessSqlConverter}: the same conversion on this thread (tests,
 *   the fallback). Cancel and the time limit still stop it between
 *   statements; only a signal aborted from inside `onProgress` (or before
 *   the call) can cancel it, since nothing else runs meanwhile.
 *
 * Stopping is cooperative: between statements the converter asks whether
 * the import was cancelled or the deadline passed, and what was read so far
 * is the result (`result.stopped`; the unread statements are in its ledger,
 * file and line). Once the reading has stopped or ended (the worker says
 * `stopping` or `read`), converting what was read is never cut short: a
 * deadline or Cancel after that changes nothing. Only when a single step of
 * the reading (one statement, or preparing a file) keeps a worker busy past
 * {@link STOP_GRACE_MS} after the stop is the worker ended, rejecting with
 * {@link SqlConvertAbandonedError}: what it had read is lost (the error
 * carries how far it had got).
 *
 * No `vscode` (the CLI may bundle it): the caller passes the extension path
 * and an optional log.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

import type { SqlConvertProgress, SqlDdlToDbmlResult, SqlStopReason } from './sqlDdlImport';
import { loadSqlImport, type SqlImportModule } from './sqlImportLoader';
import {
  SQL_IMPORT_WORKER_BUNDLE,
  SQL_WORKER_CANCELLED,
  type SqlConvertRequest,
  type SqlWorkerData,
  type SqlWorkerMessage,
  type SqlWorkerRequest,
} from '../workers/sqlImportProtocol';

export type { SqlConvertRequest } from '../workers/sqlImportProtocol';

/** How one conversion is watched and stopped. */
export interface SqlConvertControl {
  /** Aborted: the reading stops at the next statement (`cancelled`). */
  signal?: AbortSignal;
  /** `Date.now()` at which the reading stops at the next statement (`timeLimit`). */
  deadline?: number;
  /** The time limit (ms) the deadline comes from, for the ledger's wording. */
  timeLimitMs?: number;
  /** How far the reading has got (from a worker: at most every {@link PROGRESS_MS}). */
  onProgress?: (progress: SqlConvertProgress) => void;
}

/** Converts SQL DDL to DBML; one conversion at a time. */
export interface SqlConverter {
  convert(request: SqlConvertRequest, control?: SqlConvertControl): Promise<SqlDdlToDbmlResult>;
  /** Ends the worker, if one was started. The converter can still be used (a new worker starts). */
  dispose(): void;
}

/** The SQL importer (`dist/sqlImport.js`) could not be loaded: a broken install, never the user's SQL. */
export class SqlEngineLoadError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SqlEngineLoadError';
  }
}

/**
 * A worker that did not stop within {@link STOP_GRACE_MS} of a cancel or the
 * time limit was ended: nothing it read is kept. `progress`: how far it had
 * got (its last progress message), so the import can say what was lost.
 */
export class SqlConvertAbandonedError extends Error {
  constructor(readonly reason: SqlStopReason, readonly progress?: SqlConvertProgress) {
    super(reason === 'cancelled'
      ? 'The SQL conversion did not stop when it was cancelled, so it was ended.'
      : 'The SQL conversion did not stop at its time limit, so it was ended.');
    this.name = 'SqlConvertAbandonedError';
  }
}

/** At most one progress message per this many ms from a worker. */
export const PROGRESS_MS = 100;

/** How long a worker may take to stop after a cancel or its deadline before it is ended. */
export const STOP_GRACE_MS = 10_000;

/** Why to stop now, if at all. */
function stopReason(control: SqlConvertControl, now = Date.now()): SqlStopReason | undefined {
  if (control.signal?.aborted) return 'cancelled';
  return control.deadline !== undefined && now >= control.deadline ? 'timeLimit' : undefined;
}

/** A converter on this thread; `load` is called once, on the first conversion. */
export function inProcessSqlConverter(load: () => SqlImportModule): SqlConverter {
  let engine: SqlImportModule | undefined;
  return {
    async convert(request, control = {}) {
      if (!engine) {
        try {
          engine = load();
        } catch (err) {
          throw err instanceof SqlEngineLoadError ? err : new SqlEngineLoadError(err instanceof Error ? err.message : String(err), err);
        }
      }
      return engine.sqlDdlToDbml({
        ...request,
        options: {
          ...request.options,
          ...(control.timeLimitMs !== undefined ? { timeLimitMs: control.timeLimitMs } : {}),
          shouldStop: () => stopReason(control),
          ...(control.onProgress ? { onProgress: control.onProgress } : {}),
        },
      });
    },
    dispose() {},
  };
}

/** Where the worker bundle is in an installed (or dev-host) extension. */
export function sqlImportWorkerPath(extensionPath: string): string {
  return path.join(extensionPath, 'dist', SQL_IMPORT_WORKER_BUNDLE);
}

export interface WorkerSqlConverterOptions {
  /** The extension's folder: `dist/sqlImportWorker.js` and `dist/sqlImport.js` are under it. */
  extensionPath: string;
  /** The in-process fallback's importer (default `loadSqlImport(extensionPath)`). */
  loadInProcess?: () => SqlImportModule;
  /** Where to say that the worker could not be used (the output log). */
  log?: (message: string) => void;
  /** For tests: how long a stop may take before the worker is ended (default {@link STOP_GRACE_MS}). */
  graceMs?: number;
}

/** The longest delay a timer holds: a longer one fires at once (Node's TimeoutOverflowWarning). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * The extension's converter: each conversion in a worker thread
 * (`dist/sqlImportWorker.js`), started on the first conversion and kept for
 * the next (the dialect ranking reads the scripts several times) until
 * `dispose`. Without the worker bundle, or when a worker cannot start (it
 * fails or exits before it says anything), every conversion runs in-process
 * (`loadInProcess`). A worker that dies between conversions is replaced by
 * the next one, and its error never reaches the host uncaught.
 */
export function workerSqlConverter(options: WorkerSqlConverterOptions): SqlConverter {
  const { extensionPath } = options;
  const graceMs = options.graceMs ?? STOP_GRACE_MS;
  const workerFile = sqlImportWorkerPath(extensionPath);
  let fallback: SqlConverter | undefined;
  let worker: Worker | undefined;
  /** Workers that have posted anything (`ready` first): a failure before that is one that could not start. */
  const spoke = new WeakSet<Worker>();
  let nextId = 1;

  const inProcess = (why: string): SqlConverter => {
    if (!fallback) {
      options.log?.(`the SQL conversion runs on the extension host (${why}).`);
      fallback = inProcessSqlConverter(options.loadInProcess ?? (() => loadSqlImport(extensionPath)));
    }
    return fallback;
  };

  const start = (): Worker => {
    const data: SqlWorkerData = { extensionPath };
    const w = new Worker(workerFile, { workerData: data });
    // Listened to for the worker's whole life, not only during a conversion: an error while it
    // is idle is never an uncaught exception on the host, and one that ended is never posted to.
    w.on('message', () => { spoke.add(w); });
    w.on('error', () => {});
    w.on('exit', () => { if (worker === w) worker = undefined; });
    return w;
  };

  const end = (w: Worker): void => {
    if (worker === w) worker = undefined;
    void w.terminate();
  };

  return {
    async convert(request, control = {}) {
      if (fallback) return fallback.convert(request, control);
      if (!fs.existsSync(workerFile)) return inProcess(`no ${SQL_IMPORT_WORKER_BUNDLE}`).convert(request, control);
      if (!worker) {
        try {
          worker = start();
        } catch (err) {
          return inProcess(`the worker could not start: ${err instanceof Error ? err.message : String(err)}`).convert(request, control);
        }
      }
      const w = worker;
      const id = nextId++;
      const flag = new Int32Array(new SharedArrayBuffer(4));
      const message: SqlWorkerRequest = {
        id,
        request,
        control: flag.buffer as SharedArrayBuffer,
        ...(control.deadline !== undefined ? { deadline: control.deadline } : {}),
        ...(control.timeLimitMs !== undefined ? { timeLimitMs: control.timeLimitMs } : {}),
        progressMs: PROGRESS_MS,
      };
      return new Promise<SqlDdlToDbmlResult>((resolve, reject) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
        /** The worker said its reading stopped or ended: what is left is converting what it read, never cut short. */
        let stopping = false;
        /** How far the reading had got, for an abandoned worker's error. */
        let last: SqlConvertProgress | undefined;
        const settle = (): void => {
          clearTimeout(grace);
          clearTimeout(deadlineTimer);
          control.signal?.removeEventListener('abort', onAbort);
          w.off('message', onMessage);
          w.off('error', onError);
          w.off('exit', onExit);
        };
        // A stop the worker does not reach (one statement keeps it busy): end it after the grace.
        const abandonAfterGrace = (reason: SqlStopReason): void => {
          if (grace || stopping) return;
          grace = setTimeout(() => {
            settle();
            end(w);
            reject(new SqlConvertAbandonedError(reason, last));
          }, graceMs);
        };
        const onAbort = (): void => {
          Atomics.store(flag, 0, SQL_WORKER_CANCELLED);
          abandonAfterGrace('cancelled');
        };
        /** A worker that failed before it said anything could not start: this conversion and the rest run in-process. */
        const failed = (what: string, err: Error): void => {
          settle();
          end(w);
          if (!spoke.has(w)) {
            inProcess(`the worker could not start: ${what}`).convert(request, control).then(resolve, reject);
            return;
          }
          reject(err);
        };
        const onMessage = (msg: SqlWorkerMessage): void => {
          if (msg.id !== id) return;
          if (msg.type === 'progress') { last = msg.progress; control.onProgress?.(msg.progress); return; }
          if (msg.type === 'stopping' || msg.type === 'read') {
            stopping = true;
            clearTimeout(grace);
            grace = undefined;
            return;
          }
          settle();
          if (msg.type === 'result') { resolve(msg.result); return; }
          if (msg.load) {
            // The worker cannot load the importer: no later conversion would either.
            end(w);
            reject(new SqlEngineLoadError(msg.error));
            return;
          }
          reject(new Error(msg.error));
        };
        const onError = (err: Error): void => failed(err.message, new Error(`The SQL import worker stopped: ${err.message}`));
        const onExit = (code: number): void => failed(`it exited (code ${code})`, new Error(`The SQL import worker exited unexpectedly (code ${code}).`));
        w.on('message', onMessage);
        w.once('error', onError);
        w.once('exit', onExit);
        if (control.signal?.aborted) onAbort();
        else control.signal?.addEventListener('abort', onAbort, { once: true });
        if (control.deadline !== undefined) {
          const delay = Math.max(0, control.deadline - Date.now());
          // Beyond what a timer holds the deadline is weeks away: the worker still stops at it, between statements.
          if (delay <= MAX_TIMER_MS) deadlineTimer = setTimeout(() => abandonAfterGrace('timeLimit'), delay);
        }
        w.postMessage(message);
      });
    },
    dispose() {
      if (worker) end(worker);
    },
  };
}
