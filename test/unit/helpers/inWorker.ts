/**
 * Call a synchronous source function in a worker thread, with a deadline.
 *
 * A performance test that times a synchronous call with `Date.now()` cannot
 * fail when the call never returns: vitest's timeout cannot interrupt
 * synchronous code, so a regression to an exponential walk hangs the run
 * instead of failing it. Here the call runs in a worker that is terminated
 * at the deadline, so the test fails with a message instead.
 *
 * `entry` (a source file) is bundled with esbuild (the repo's tsconfig
 * paths resolve `@erd-studio/core`); `args` and the result cross by
 * structured clone (Maps and Sets included, never functions).
 */
import { buildSync } from 'esbuild';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';

const ROOT = path.resolve(__dirname, '../../..');
const bundles = new Map<string, string>();

function bundle(entry: string): string {
  const full = path.resolve(ROOT, entry);
  let out = bundles.get(full);
  if (out) return out;
  out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-in-worker-')), 'entry.cjs');
  buildSync({ entryPoints: [full], bundle: true, platform: 'node', format: 'cjs', outfile: out, tsconfig: path.join(ROOT, 'tsconfig.json'), logLevel: 'silent' });
  bundles.set(full, out);
  return out;
}

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const fn = require(workerData.bundle)[workerData.name];
const started = performance.now();
const value = fn(...workerData.args);
parentPort.postMessage({ value, ms: performance.now() - started });
`;

/**
 * `entry`'s export `name` called with `args` in a worker: its result and how
 * long the call took (ms). Rejects when it has not returned by `deadlineMs`
 * (the worker is terminated) or throws.
 */
export function callInWorker<T>(entry: string, name: string, args: unknown[], deadlineMs: number): Promise<{ value: T; ms: number }> {
  const worker = new Worker(WORKER, { eval: true, workerData: { bundle: bundle(entry), name, args } });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`${name} did not return within ${deadlineMs} ms`));
    }, deadlineMs);
    worker.once('message', (m: { value: T; ms: number }) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(m);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
