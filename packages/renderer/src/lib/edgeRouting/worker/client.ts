/**
 * Starts a canvas's line-routing worker, or says it cannot (returns null) so
 * the canvas routes on the main thread with a lower cap instead.
 *
 * The worker's code is inlined at build time as `__ERD_EDGE_ROUTING_WORKER__`
 * (the extension's `esbuild.js` and the package's `build.mjs` both define
 * it). Where it is not defined (unit tests, a consumer bundling the source
 * itself), where `Worker` or blob URLs are missing, or where the page's CSP
 * refuses a blob worker, there is no worker.
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

export const createRoutingWorker: RoutingWorkerFactory = (events) => {
  const code = inlinedWorkerCode();
  if (!code || typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL?.createObjectURL !== 'function') {
    return null;
  }
  let worker: Worker;
  try {
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
  } catch {
    // A CSP without `worker-src blob:` (or no worker support at all): route on the main thread.
    return null;
  }
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
};
