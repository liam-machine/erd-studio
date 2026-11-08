/**
 * The line-routing worker: its script answers a route request the way the
 * main thread would, its client starts nothing where the code is not inlined
 * (as here, in the unit tests), and the build helper bundles it without the
 * canvas around it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createRoutingWorker, lineStyleOptions, routeAll, type WorkerRouteResult } from '../../src/lib/edgeRouting';
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
