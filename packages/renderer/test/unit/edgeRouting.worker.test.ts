/**
 * The line-routing worker: its script answers a route request the way the
 * main thread would, its client starts nothing where the code is not inlined
 * (as here, in the unit tests), and the build helper bundles it without the
 * canvas around it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createRoutingWorker, lineStyleOptions, routeAll, routingWorkerFactory, type WorkerRouteResult } from '../../src/lib/edgeRouting';
import { readFileSync } from 'node:fs';
import { scenarioRoutingInput } from '../fixtures/edgeRouting/scenarios';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('the worker script', () => {
  it('answers a route request with the same lines the main thread draws, and its sequence number', async () => {
    const answers: WorkerRouteResult[] = [];
    const scope: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: WorkerRouteResult) => void } = {
      onmessage: null,
      postMessage: (m) => answers.push(m),
    };
    vi.stubGlobal('self', scope);
    await import('../../src/lib/edgeRouting/worker/entry');
    const input = scenarioRoutingInput('tangle');
    scope.onmessage!({ data: { type: 'route', seq: 7, input, style: 'hops', zoom: 1 } });
    scope.onmessage!({ data: { type: 'something else' } });
    expect(answers).toHaveLength(1);
    expect(answers[0].seq).toBe(7);
    expect(answers[0].error).toBeUndefined();
    const expected = routeAll(input, lineStyleOptions('hops'));
    expect([...answers[0].edges.keys()].sort()).toEqual([...expected.edges.keys()].sort());
    for (const [id, route] of expected.edges) expect(answers[0].edges.get(id)!.d, id).toBe(route.d);
  });
});

describe('the worker client', () => {
  it('starts no worker where its code is not inlined', () => {
    const factory = vi.fn();
    vi.stubGlobal('Worker', factory);
    expect(createRoutingWorker({ onResult: () => {}, onFailure: () => {} })).toBeNull();
    expect(factory).not.toHaveBeenCalled();
  });
});

/** A stand-in for `Worker` that records how each one was started. */
function fakeWorkerClass(refuse: (url: string) => boolean = () => false) {
  const started: string[] = [];
  class FakeWorker {
    onmessage: unknown = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    constructor(url: string) {
      if (refuse(url)) throw new DOMException('refused by the CSP', 'SecurityError');
      started.push(url);
    }
    postMessage() {}
    terminate() {}
  }
  return { FakeWorker, started };
}

const events = { onResult: () => {}, onFailure: () => {} };

describe('the worker client with a host worker URL (ErdCanvas routingWorkerUrl)', () => {
  it('starts the worker from the URL, not from a blob', () => {
    const { FakeWorker, started } = fakeWorkerClass();
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('__ERD_EDGE_ROUTING_WORKER__', 'self.onmessage = () => {};');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const handle = routingWorkerFactory('./assets/edge-routing-worker.js')(events);
    expect(handle).not.toBeNull();
    expect(started).toEqual(['./assets/edge-routing-worker.js']);
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
  });

  it('falls back to the inlined code when the URL cannot start a worker', () => {
    const { FakeWorker, started } = fakeWorkerClass((url) => !url.startsWith('blob:'));
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('__ERD_EDGE_ROUTING_WORKER__', 'self.onmessage = () => {};');
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:worker');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    expect(routingWorkerFactory('https://elsewhere.example/worker.js')(events)).not.toBeNull();
    expect(started).toEqual(['blob:worker']);
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  it('starts nothing when neither the URL nor a blob can (the canvas routes on the main thread)', () => {
    const { FakeWorker, started } = fakeWorkerClass(() => true);
    vi.stubGlobal('Worker', FakeWorker);
    expect(routingWorkerFactory('./assets/edge-routing-worker.js')(events)).toBeNull();
    expect(started).toEqual([]);
  });

  it('ignores an empty or missing URL and keeps the inlined start', () => {
    const { FakeWorker, started } = fakeWorkerClass();
    vi.stubGlobal('Worker', FakeWorker);
    expect(routingWorkerFactory('')(events)).toBeNull();
    expect(routingWorkerFactory(null)(events)).toBeNull();
    expect(createRoutingWorker(events)).toBeNull();
    expect(started).toEqual([]);
  });
});

describe('the published worker file', () => {
  it('is exported as ./edge-routing-worker.js and written by the package build from the same code it inlines', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./edge-routing-worker.js']).toBe('./dist/edge-routing-worker.js');
    const build = readFileSync(new URL('../../build.mjs', import.meta.url), 'utf8');
    expect(build).toMatch(/__ERD_EDGE_ROUTING_WORKER__: JSON\.stringify\(workerCode\)/);
    expect(build).toMatch(/writeFileSync\(new URL\('\.\/dist\/edge-routing-worker\.js'[^)]*\), workerCode\)/);
  });
});

describe('the worker build', () => {
  it('bundles the router into one script, without React or React Flow', () => {
    const require = createRequire(import.meta.url);
    const { edgeRoutingWorkerCode } = require('../../scripts/edgeRoutingWorker.cjs');
    const code: string = edgeRoutingWorkerCode();
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/react|xyflow|document\./i);
    expect(code).toContain('postMessage');
  });
});
