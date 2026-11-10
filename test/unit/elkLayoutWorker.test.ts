/**
 * Worker robustness for runElkLayout: an uncaught worker error or a timeout
 * must settle the layout promise (so the Layout button re-enables) and
 * recycle the ELK instance so the next run gets a fresh worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Fakes (hoisted so vi.mock factories can see them) ---------------------

const fakes = vi.hoisted(() => {
  class FakeWorker {
    onerror: ((event: { message?: string }) => void) | null = null;
    onmessage: unknown = null;
    terminate = vi.fn();
  }
  const state = {
    workers: [] as FakeWorker[],
    elkInstances: 0,
    layoutImpl: (_graph?: unknown): Promise<unknown> => new Promise(() => {}), // never settles by default
  };
  class FakeELK {
    constructor(opts: { workerFactory: () => FakeWorker }) {
      state.elkInstances++;
      opts.workerFactory();
    }
    layout(graph: unknown): Promise<unknown> {
      return state.layoutImpl(graph);
    }
  }
  return { FakeWorker, FakeELK, state };
});

vi.mock('elkjs/lib/elk-api', () => ({ default: fakes.FakeELK }));

import { runElkLayout, LAYOUT_TIMEOUT_MS, STACK_SAFE_NODE_PLACEMENT, isStackOverflow } from '../../webview/lib/elkLayout';
import type { TableFlowNode } from '@erd-studio/renderer/editor';

const node: TableFlowNode = {
  id: 'a',
  type: 'model',
  position: { x: 0, y: 0 },
  data: { modelName: 'a', stage: 'logical', layer: 'silver', columns: [], isStub: false },
};

beforeEach(() => {
  // Note: `workers` is cumulative across tests — the ELK singleton (and its
  // worker) survives between runs unless a crash/timeout resets it.
  fakes.state.layoutImpl = () => new Promise(() => {});
  (globalThis as Record<string, unknown>).__ELK_WORKER_CODE__ = '';
  (globalThis as Record<string, unknown>).Worker = class extends fakes.FakeWorker {
    constructor() {
      super();
      fakes.state.workers.push(this);
    }
  };
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => 'blob:fake');
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runElkLayout worker guard', () => {
  it('rejects the in-flight layout when the worker raises an uncaught error, then uses a fresh worker', async () => {
    const pending = runElkLayout([node], []);
    expect(fakes.state.workers).toHaveLength(1);
    const worker = fakes.state.workers[0];
    expect(typeof worker.onerror).toBe('function');
    const instancesAfterFirst = fakes.state.elkInstances;

    worker.onerror!({ message: 'out of memory' });

    await expect(pending).rejects.toThrow(/ELK layout worker crashed: out of memory/);
    expect(worker.terminate).toHaveBeenCalled();

    // Next run must build a new ELK instance + worker (singleton was reset)
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [{ id: 'a', x: 10.4, y: 20.6 }] });
    const positions = await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesAfterFirst + 1);
    expect(fakes.state.workers).toHaveLength(2);
    expect(positions).toEqual({ a: { x: 10, y: 21 } });
  });

  it('rejects when the layout exceeds the timeout and recycles the worker', async () => {
    vi.useFakeTimers();
    const pending = runElkLayout([node], []);
    // The singleton from the previous test is reused — its worker is the last one created
    const worker = fakes.state.workers[fakes.state.workers.length - 1];
    expect(worker).toBeDefined();
    const instancesBefore = fakes.state.elkInstances;
    const rejection = expect(pending).rejects.toThrow(/timed out/);

    vi.advanceTimersByTime(LAYOUT_TIMEOUT_MS + 1);

    await rejection;
    expect(worker.terminate).toHaveBeenCalled();

    // A fresh instance is built for the next run
    vi.useRealTimers();
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [] });
    await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesBefore + 1);
  });

  // A 257-table import: NETWORK_SIMPLEX overflowed the worker's stack and the
  // canvas showed "Auto layout failed: Maximum call stack size exceeded".
  it('retries once with Brandes–Köpf node placement when the layout overflows the stack', async () => {
    const graphs: Array<{ layoutOptions: Record<string, string> }> = [];
    fakes.state.layoutImpl = (graph) => {
      graphs.push(graph as { layoutOptions: Record<string, string> });
      return graphs.length === 1
        ? Promise.reject(new RangeError('Maximum call stack size exceeded'))
        : Promise.resolve({ id: 'root', children: [{ id: 'a', x: 1, y: 2 }] });
    };
    expect(await runElkLayout([node], [])).toEqual({ a: { x: 1, y: 2 } });
    expect(graphs.map((g) => g.layoutOptions['elk.layered.nodePlacement.strategy'])).toEqual(['NETWORK_SIMPLEX', STACK_SAFE_NODE_PLACEMENT]);
    // Everything else is the same layout.
    const { ['elk.layered.nodePlacement.strategy']: _a, ...first } = graphs[0].layoutOptions;
    const { ['elk.layered.nodePlacement.strategy']: _b, ...second } = graphs[1].layoutOptions;
    expect(second).toEqual(first);
  });

  it('a second overflow, or another error, is not retried', async () => {
    let calls = 0;
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(new RangeError('Maximum call stack size exceeded')); };
    await expect(runElkLayout([node], [])).rejects.toThrow('Maximum call stack size exceeded');
    expect(calls).toBe(2);
    calls = 0;
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(new Error('cycle detected')); };
    await expect(runElkLayout([node], [])).rejects.toThrow('cycle detected');
    expect(calls).toBe(1);
    expect(isStackOverflow(new Error('too much recursion'))).toBe(true);
    expect(isStackOverflow(new Error('ELK layout timed out after 30s'))).toBe(false);
  });

  it('propagates ordinary layout rejections without killing the worker', async () => {
    fakes.state.layoutImpl = () => Promise.reject(new Error('cycle detected'));
    await expect(runElkLayout([node], [])).rejects.toThrow('cycle detected');
    const worker = fakes.state.workers[fakes.state.workers.length - 1];
    expect(worker.terminate).not.toHaveBeenCalled();

    // Same ELK instance (and worker) is reused on the next run
    const instancesBefore = fakes.state.elkInstances;
    const workersBefore = fakes.state.workers.length;
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [] });
    await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesBefore);
    expect(fakes.state.workers.length).toBe(workersBefore);
  });
});
