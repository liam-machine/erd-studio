/**
 * Worker thread for Import SQL DDL…'s conversion (`convertSqlDdl`, with the
 * repair ladder and salvage), so reading a large script never blocks the
 * extension host. `dist/sqlImportWorker.js` stays small: it loads the
 * converter and its grammars from `dist/sqlImport.js` (`loadSqlImport`) on
 * the first request, so the grammars are bundled once.
 *
 * One request at a time (the host awaits each). Between statements the
 * converter asks whether to stop: the host's cancel flag (a shared Int32,
 * set while this thread is busy, which a message could not be) or the
 * deadline. Progress is posted at most every `progressMs`.
 *
 * The host side is `src/services/sqlConverter.ts` (`workerSqlConverter`),
 * which falls back to converting in-process when this bundle is missing.
 * No `vscode`.
 */

import { parentPort, workerData } from 'worker_threads';
import type { SqlStopReason } from '../services/sqlDdlImport';
import { loadSqlImport, type SqlImportModule } from '../services/sqlImportLoader';
import { SQL_WORKER_CANCELLED, type SqlWorkerData, type SqlWorkerMessage, type SqlWorkerRequest } from './sqlImportProtocol';

const { extensionPath } = workerData as SqlWorkerData;
let engine: SqlImportModule | undefined;

const post = (message: SqlWorkerMessage): void => parentPort!.postMessage(message);

parentPort!.on('message', (msg: SqlWorkerRequest) => {
  try {
    engine ??= loadSqlImport(extensionPath);
  } catch (err) {
    post({ id: msg.id, type: 'error', error: err instanceof Error ? err.message : String(err), load: true });
    return;
  }
  const flag = new Int32Array(msg.control);
  let lastPost = 0;
  try {
    const result = engine.sqlDdlToDbml({
      ...msg.request,
      options: {
        ...msg.request.options,
        ...(msg.timeLimitMs !== undefined ? { timeLimitMs: msg.timeLimitMs } : {}),
        shouldStop: (): SqlStopReason | undefined => {
          if (Atomics.load(flag, 0) === SQL_WORKER_CANCELLED) return 'cancelled';
          return msg.deadline !== undefined && Date.now() >= msg.deadline ? 'timeLimit' : undefined;
        },
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastPost < msg.progressMs) return;
          lastPost = now;
          post({ id: msg.id, type: 'progress', progress });
        },
      },
    });
    post({ id: msg.id, type: 'result', result });
  } catch (err) {
    post({ id: msg.id, type: 'error', error: err instanceof Error ? err.message : String(err) });
  }
});
