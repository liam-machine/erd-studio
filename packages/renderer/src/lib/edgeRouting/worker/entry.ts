/**
 * The line-routing worker. Built into a string at build time
 * (`packages/renderer/scripts/edgeRoutingWorker.cjs`) and started from a blob
 * URL by `worker/client.ts`, the way the ELK layout worker is: a VS Code
 * webview cannot load a worker from a file URL.
 *
 * One worker per canvas, with its own router, so the router's memory of the
 * last pass (a line keeps its side and channel while you work) stays with
 * that canvas. Pure computation: no DOM, no host, nothing posted anywhere but
 * back to the canvas that started it.
 */
import { routeAll } from '../routeAll';
import { createAvoidRouter } from '../routers/orthogonalAvoid';
import { lineStyleOptions } from '../lineStyle';
import type { WorkerRouteRequest, WorkerRouteResult } from './protocol';

const router = createAvoidRouter();
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRouteRequest>) => void) | null;
  postMessage: (message: WorkerRouteResult) => void;
};

scope.onmessage = (event) => {
  const request = event.data;
  if (!request || request.type !== 'route') return;
  let error: string | undefined;
  const result = routeAll(request.input, lineStyleOptions(request.style), {
    router,
    now: () => performance.now(),
    zoom: request.zoom,
    onError: (err) => {
      error ??= err instanceof Error ? err.message : String(err);
    },
  });
  scope.postMessage({ seq: request.seq, edges: result.edges, millis: result.millis, error });
};
