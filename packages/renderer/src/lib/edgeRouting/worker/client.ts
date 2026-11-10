/**
 * Starts a canvas's line-routing worker, or says it cannot (returns null) so
 * the canvas routes on the main thread with a lower cap instead.
 *
 * Two ways to start it, tried in this order:
 * - from a URL the host serves the worker file at (`ErdCanvas`'s
 *   `routingWorkerUrl`; the package publishes the file as
 *   `@erd-studio/renderer/edge-routing-worker.js`). A page whose CSP allows
 *   its own scripts (`script-src 'self'`) but not `blob:` (as some app-hosting
 *   platforms set it)
 *   can run a same-origin worker file;
 * - from the code inlined at build time as `__ERD_EDGE_ROUTING_WORKER__` (the
 *   extension's `esbuild.js` and the package's `build.mjs` both define it),
 *   through a blob URL: a VS Code webview cannot load a worker from a file.
 * Where neither starts (unit tests, no `Worker`, a CSP that refuses both, or
 * a URL worker that fails to load, which `onFailure` reports), the canvas
 * routes on the main thread.
 */
import type { WorkerRouteRequest, WorkerRouteResult } from './protocol';

declare const __ERD_EDGE_ROUTING_WORKER__: string | undefined;

export interface RoutingWorkerEvents {
  onResult: (result: WorkerRouteResult) => void;
  /** The worker failed to start or crashed: it is terminated and never answers again. */
  onFailure: (err: unknown) => void;
}

export interface RoutingWorkerHandle {
  post: (request: WorkerRouteRequest) => void;
  terminate: () => void;
}

/** Starts a worker for one canvas. */
export type RoutingWorkerFactory = (events: RoutingWorkerEvents) => RoutingWorkerHandle | null;

function inlinedWorkerCode(): string | null {
  return typeof __ERD_EDGE_ROUTING_WORKER__ === 'string' && __ERD_EDGE_ROUTING_WORKER__.length > 0
    ? __ERD_EDGE_ROUTING_WORKER__
    : null;
}

/** A worker from the host's own worker file, or null when it cannot start. */
function workerFromUrl(url: string | null | undefined): Worker | null {
  if (!url || typeof Worker === 'undefined') return null;
  try {
    return new Worker(url);
  } catch {
    // A bad URL, or a CSP that refuses it up front: try the inlined code.
    return null;
  }
}

/** A worker from the inlined code through a blob URL, or null when it cannot start. */
function workerFromInlinedCode(): Worker | null {
  const code = inlinedWorkerCode();
  if (!code || typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return null;
  }
  try {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    return worker;
  } catch {
    // A CSP without `worker-src blob:` (or no worker support at all): route on the main thread.
    return null;
  }
}

/**
 * A worker factory that starts from `url` (the host's copy of
 * `edge-routing-worker.js`) when given one, else, or when that cannot start,
 * from the inlined code.
 */
export function routingWorkerFactory(url?: string | null): RoutingWorkerFactory {
  return (events) => {
    const worker = workerFromUrl(url) ?? workerFromInlinedCode();
    return worker ? handleFor(worker, events) : null;
  };
}

/** Starts a worker from the inlined code (no host URL). */
export const createRoutingWorker: RoutingWorkerFactory = routingWorkerFactory(null);

function handleFor(worker: Worker, events: RoutingWorkerEvents): RoutingWorkerHandle {
  let alive = true;
  const fail = (err: unknown) => {
    if (!alive) return;
    alive = false;
    worker.terminate();
    events.onFailure(err);
  };
  worker.onmessage = (event: MessageEvent<WorkerRouteResult>) => {
    if (alive) events.onResult(event.data);
  };
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault?.();
    fail(new Error(event?.message || 'line routing worker failed'));
  };
  worker.onmessageerror = () => fail(new Error('line routing worker sent a message that could not be read'));
  return {
    post: (request) => {
      if (!alive) return;
      try {
        worker.postMessage(request);
      } catch (err) {
        fail(err);
      }
    },
    terminate: () => {
      if (!alive) return;
      alive = false;
      worker.terminate();
    },
  };
}
