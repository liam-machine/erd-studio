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

import {
  runElkLayout, LAYOUT_TIMEOUT_MS, STACK_SAFE_NODE_PLACEMENT, isStackOverflow, stackSafeFallbacks, stackSafeFallbackRungs,
  classifyLayoutFailure, layoutFailureReport, GRID_LAYOUT_MIN_TABLES, GRID_LAYOUT_MIN_RELATIONSHIPS,
  layoutOutcomeNotice, layoutOutcomeLogMessage, layoutFailureNotice,
} from '../../webview/lib/elkLayout';
import type { TableFlowNode } from '@erd-studio/renderer/editor';
import type { LayoutOutcome } from '../../webview/lib/elkLayout';
import { firstOpenLayoutOptions } from '../../webview/lib/firstOpenLayout';

const node: TableFlowNode = {
  id: 'a',
  type: 'model',
  position: { x: 0, y: 0 },
  data: { modelName: 'a', stage: 'logical', layer: 'silver', columns: [], isStub: false },
};

/**
 * A table whose size can be read twice (the ELK graph's build reads it) and
 * then throws: the only way to make the grid fallback fail, to test what is
 * reported when even it does.
 */
function nodeThatBreaksTheGrid(): TableFlowNode {
  let reads = 0;
  return {
    ...node,
    get measured() {
      if (++reads > 2) throw new Error('grid failed');
      return { width: 260, height: 180 };
    },
  } as TableFlowNode;
}

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
  it('a worker that dies mid-layout is recycled and the grid lays the diagram out; the next run uses a fresh worker', async () => {
    const pending = runElkLayout([node], []);
    expect(fakes.state.workers).toHaveLength(1);
    const worker = fakes.state.workers[0];
    expect(typeof worker.onerror).toBe('function');
    const instancesAfterFirst = fakes.state.elkInstances;

    worker.onerror!({ message: 'out of memory' });

    // No other ELK step is tried after a dead worker: the grid places the table.
    await expect(pending).resolves.toEqual({ a: { x: 0, y: 0 } });
    expect(worker.terminate).toHaveBeenCalled();

    // Next run must build a new ELK instance + worker (singleton was reset)
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [{ id: 'a', x: 10.4, y: 20.6 }] });
    const positions = await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesAfterFirst + 1);
    expect(fakes.state.workers).toHaveLength(2);
    expect(positions).toEqual({ a: { x: 10, y: 21 } });
  });

  it('a layout that exceeds the timeout recycles the worker and goes to the grid', async () => {
    vi.useFakeTimers();
    const pending = runElkLayout([node], []);
    // The singleton from the previous test is reused — its worker is the last one created
    const worker = fakes.state.workers[fakes.state.workers.length - 1];
    expect(worker).toBeDefined();
    const instancesBefore = fakes.state.elkInstances;
    const outcomes: LayoutOutcome[] = [];
    const settled = runElkLayout([node], [], undefined, 'auto', { onOutcome: (o) => outcomes.push(o) });

    vi.advanceTimersByTime(LAYOUT_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ a: { x: 0, y: 0 } });
    await expect(settled).resolves.toEqual({ a: { x: 0, y: 0 } });
    expect(outcomes).toEqual([{ step: 'grid', grouping: 'none', bands: 'off', reason: `ELK layout timed out after ${LAYOUT_TIMEOUT_MS / 1000}s`, failure: 'timeout' }]);
    expect(worker.terminate).toHaveBeenCalled();

    // A fresh instance is built for the next run
    vi.useRealTimers();
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [{ id: 'a', x: 0, y: 0 }] });
    await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesBefore + 1);
  });

  // A 257-table import: NETWORK_SIMPLEX overflowed the worker's stack and the
  // canvas showed "Auto layout failed: Maximum call stack size exceeded".
  it('lays out again with Brandes–Köpf node placement when the layout overflows the stack', async () => {
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

  // A 130-table diagram with many relationships: Brandes–Köpf overflowed too,
  // in the post-compaction's own network simplex, and Auto Layout still failed.
  it('a second overflow is laid out again without post-compaction', async () => {
    const graphs: Array<{ layoutOptions: Record<string, string> }> = [];
    let told = 0;
    fakes.state.layoutImpl = (graph) => {
      graphs.push(graph as { layoutOptions: Record<string, string> });
      return graphs.length < 3
        ? Promise.reject(new RangeError('Maximum call stack size exceeded'))
        : Promise.resolve({ id: 'root', children: [{ id: 'a', x: 3, y: 4 }] });
    };
    expect(await runElkLayout([node], [], undefined, 'auto', { onStackFallback: () => { told++; } })).toEqual({ a: { x: 3, y: 4 } });
    expect(graphs.map((g) => g.layoutOptions['elk.layered.nodePlacement.strategy'])).toEqual(['NETWORK_SIMPLEX', STACK_SAFE_NODE_PLACEMENT, STACK_SAFE_NODE_PLACEMENT]);
    expect(graphs.map((g) => g.layoutOptions['elk.layered.compaction.postCompaction.strategy'])).toEqual(['EDGE_LENGTH', 'EDGE_LENGTH', 'NONE']);
    // The fallback is reported once, however many steps it takes.
    expect(told).toBe(1);
  });

  it('the fallbacks skip a step the diagram\'s own options already take', () => {
    expect(stackSafeFallbacks({ 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT, 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' }))
      .toEqual([{ 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT, 'elk.layered.compaction.postCompaction.strategy': 'NONE' }]);
    expect(stackSafeFallbacks({ 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT })).toEqual([]);
    expect(stackSafeFallbacks({ 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT, 'elk.layered.compaction.postCompaction.strategy': 'NONE' })).toEqual([]);
  });

  // the reporter (2026-11-12): every ELK step overflowed and the canvas showed
  // "Auto layout failed: Maximum call stack size exceeded". The grid, which
  // needs no ELK, now lays the diagram out instead.
  it('an overflow of every ELK step is laid out by the grid', async () => {
    let calls = 0;
    const outcomes: LayoutOutcome[] = [];
    const rungs: number[] = [];
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(new RangeError('Maximum call stack size exceeded')); };
    expect(await runElkLayout([node], [], undefined, 'auto', { onOutcome: (o) => outcomes.push(o), onFallbackRung: (r) => rungs.push(r) }))
      .toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(3);
    expect(outcomes).toEqual([{ step: 'grid', grouping: 'none', bands: 'off', reason: 'Maximum call stack size exceeded', failure: 'stack' }]);
    // Telemetry has no key for the grid yet: it is told as the deepest rung.
    expect(rungs).toEqual([3]);
  });

  // ELK's own failures on the default layout (its compaction's "Invalid
  // hitboxes for scanline" on two-way relationships) take the same fallbacks.
  it('any other failure of the default layout takes the fallbacks too, and is the error reported when none works', async () => {
    let calls = 0; let told = 0;
    fakes.state.layoutImpl = () => { calls++; return calls === 1 ? Promise.reject(new Error('Invalid hitboxes for scanline constraint calculation.')) : Promise.resolve({ id: 'root', children: [{ id: 'a', x: 5, y: 6 }] }); };
    expect(await runElkLayout([node], [], undefined, 'auto', { onStackFallback: () => { told++; } })).toEqual({ a: { x: 5, y: 6 } });
    expect(calls).toBe(2);
    // Only a stack overflow is reported as the stack fallback.
    expect(told).toBe(0);
    calls = 0;
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(new Error(calls === 1 ? 'cycle detected' : 'later failure')); };
    expect(await runElkLayout([node], [])).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(3);
    expect(isStackOverflow(new Error('too much recursion'))).toBe(true);
    expect(isStackOverflow(new Error('ELK layout timed out after 30s'))).toBe(false);
  });

  it('an ordinary layout rejection falls back without killing the worker', async () => {
    fakes.state.layoutImpl = () => Promise.reject(new Error('cycle detected'));
    expect(await runElkLayout([node], [])).toEqual({ a: { x: 0, y: 0 } });
    const worker = fakes.state.workers[fakes.state.workers.length - 1];
    expect(worker.terminate).not.toHaveBeenCalled();

    // Same ELK instance (and worker) is reused on the next run
    const instancesBefore = fakes.state.elkInstances;
    const workersBefore = fakes.state.workers.length;
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [{ id: 'a', x: 0, y: 0 }] });
    await runElkLayout([node], []);
    expect(fakes.state.elkInstances).toBe(instancesBefore);
    expect(fakes.state.workers.length).toBe(workersBefore);
  });
});

// Usage telemetry: how far the fallbacks got, and what kind of failure it was.
describe('runElkLayout fallback rungs and failure reports', () => {
  const overflow = () => new RangeError('Maximum call stack size exceeded');
  const placed = { id: 'root', children: [{ id: 'a', x: 1, y: 2 }] };
  const size = { tables: 1100, relationships: 2400 };

  const failing = async (run: Promise<unknown>): Promise<unknown> => {
    try {
      await run;
    } catch (err) {
      return err;
    }
    throw new Error('the layout did not fail');
  };

  it('a default layout that works reports no rung', async () => {
    const rungs: number[] = [];
    fakes.state.layoutImpl = () => Promise.resolve(placed);
    await runElkLayout([node], [], undefined, 'auto', { onFallbackRung: (r) => rungs.push(r) });
    expect(rungs).toEqual([]);
  });

  it('rung 2: Brandes–Köpf produced the layout', async () => {
    const rungs: number[] = [];
    let calls = 0;
    fakes.state.layoutImpl = () => (++calls === 1 ? Promise.reject(overflow()) : Promise.resolve(placed));
    await runElkLayout([node], [], undefined, 'auto', { onFallbackRung: (r) => rungs.push(r) });
    expect(rungs).toEqual([2]);
  });

  it('rung 3: leaving post-compaction out produced the layout, told once, for a failure that is not a stack overflow too', async () => {
    const rungs: number[] = [];
    let calls = 0; let stack = 0;
    fakes.state.layoutImpl = () => (++calls < 3 ? Promise.reject(new Error('java.lang.IllegalStateException: Invalid hitboxes')) : Promise.resolve(placed));
    await runElkLayout([node], [], undefined, 'auto', { onFallbackRung: (r) => rungs.push(r), onStackFallback: () => { stack++; } });
    expect(rungs).toEqual([3]);
    // layoutStackFallback keeps its meaning: only a stack overflow.
    expect(stack).toBe(0);
  });

  it('a rung is named by what it drops: a diagram already on Brandes–Köpf has only rung 3', async () => {
    const own = { 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT };
    expect(stackSafeFallbackRungs({ ...own, 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' }).map((s) => s.rung)).toEqual([3]);
    expect(stackSafeFallbackRungs({ 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' }).map((s) => s.rung)).toEqual([2, 3]);
    expect(stackSafeFallbackRungs({ 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' }).map((s) => s.options))
      .toEqual(stackSafeFallbacks({ 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' }));
    const rungs: number[] = [];
    let calls = 0;
    fakes.state.layoutImpl = () => (++calls === 1 ? Promise.reject(overflow()) : Promise.resolve(placed));
    await runElkLayout([node], [], own, 'auto', { onFallbackRung: (r) => rungs.push(r) });
    expect(rungs).toEqual([3]);
  });

  it('a hook that throws never stops the layout', async () => {
    let calls = 0;
    fakes.state.layoutImpl = () => (++calls === 1 ? Promise.reject(overflow()) : Promise.resolve(placed));
    expect(await runElkLayout([node], [], undefined, 'auto', { onFallbackRung: () => { throw new Error('telemetry'); } })).toEqual({ a: { x: 1, y: 2 } });
  });

  it('every step failed, the grid too: the first error is thrown and reported with the last step\'s class', async () => {
    let calls = 0;
    fakes.state.layoutImpl = () => (++calls < 3 ? Promise.reject(overflow()) : Promise.reject(new RangeError('Invalid array length')));
    const err = await failing(runElkLayout([nodeThatBreaksTheGrid()], [], undefined, 'auto'));
    expect((err as Error).message).toBe('Maximum call stack size exceeded');
    // Out of memory on rung 3 goes straight to the grid, which failed with an error of its own (`other`).
    expect(layoutFailureReport(err, size)).toEqual({
      failure: 'stack', tableBucket: '500plus', relBucket: '2000plus', exhausted: true, lastFailure: 'other',
      log: { tables: 1100, relationships: 2400, message: 'RangeError: Maximum call stack size exceeded' },
    });
  });

  it('a fallback that runs out of time goes straight to the grid', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const outcomes: LayoutOutcome[] = [];
    fakes.state.layoutImpl = () => (++calls === 1 ? Promise.reject(overflow()) : new Promise(() => {}));
    const run = runElkLayout([node], [], undefined, 'auto', { onOutcome: (o) => outcomes.push(o) });
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT_MS + 10);
    expect(await run).toEqual({ a: { x: 0, y: 0 } });
    // Rung 3 is not tried after rung 2 ran out of time.
    expect(calls).toBe(2);
    expect(outcomes.map((o) => o.step)).toEqual(['grid']);
  });

  it('a timeout, a dead worker or memory running out on the default layout tries no other ELK step: the grid lays it out', async () => {
    vi.useFakeTimers();
    let calls = 0;
    fakes.state.layoutImpl = () => { calls++; return new Promise(() => {}); };
    const timedOut = runElkLayout([node], []);
    await vi.advanceTimersByTimeAsync(LAYOUT_TIMEOUT_MS + 10);
    expect(await timedOut).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(1);

    calls = 0;
    const crashed = runElkLayout([node], []);
    fakes.state.workers.at(-1)!.onerror!({ message: 'boom' });
    expect(await crashed).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(1);

    vi.useRealTimers();
    calls = 0;
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(new RangeError('Invalid array length')); };
    expect(await runElkLayout([node], [])).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(1);
  });

  it('no ELK fallback to try (the diagram\'s own options already take both): the grid lays it out', async () => {
    let calls = 0;
    const outcomes: LayoutOutcome[] = [];
    fakes.state.layoutImpl = () => { calls++; return Promise.reject(overflow()); };
    const own = { 'elk.layered.nodePlacement.strategy': STACK_SAFE_NODE_PLACEMENT, 'elk.layered.compaction.postCompaction.strategy': 'NONE' };
    expect(await runElkLayout([node], [], own, 'auto', { onOutcome: (o) => outcomes.push(o) })).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(1);
    expect(outcomes.map((o) => o.step)).toEqual(['grid']);
  });

  it.each([
    ['a table missing from the result', { id: 'root', children: [] }],
    ['no children at all', { id: 'root' }],
    ['a missing coordinate', { id: 'root', children: [{ id: 'a', x: 1 }] }],
    ['a coordinate that is not a number', { id: 'root', children: [{ id: 'a', x: Number.NaN, y: 2 }] }],
    ['an infinite coordinate', { id: 'root', children: [{ id: 'a', x: 1, y: Number.POSITIVE_INFINITY }] }],
  ])('an unusable result (%s) from every ELK step is laid out by the grid', async (_name, result) => {
    let calls = 0;
    fakes.state.layoutImpl = () => { calls++; return Promise.resolve(result); };
    expect(await runElkLayout([node], [])).toEqual({ a: { x: 0, y: 0 } });
    expect(calls).toBe(3);
  });

  it('an unusable result that even the grid cannot fix fails as its own class', async () => {
    fakes.state.layoutImpl = () => Promise.resolve({ id: 'root', children: [] });
    const report = layoutFailureReport(await failing(runElkLayout([nodeThatBreaksTheGrid()], [])), size);
    expect(report).toMatchObject({ failure: 'result', exhausted: true, lastFailure: 'other' });
  });

  it('an unusable default result is laid out again by the next rung', async () => {
    const rungs: number[] = [];
    let calls = 0;
    fakes.state.layoutImpl = () => Promise.resolve(++calls === 1 ? { id: 'root', children: [{ id: 'a' }] } : placed);
    expect(await runElkLayout([node], [], undefined, 'auto', { onFallbackRung: (r) => rungs.push(r) })).toEqual({ a: { x: 1, y: 2 } });
    expect(rungs).toEqual([2]);
  });

  it('classifies an error by its type and the engine\'s fixed text', () => {
    expect(classifyLayoutFailure(overflow())).toBe('stack');
    expect(classifyLayoutFailure(new RangeError('Invalid array length'))).toBe('memory');
    expect(classifyLayoutFailure(new Error('org.eclipse.elk.core.UnsupportedConfigurationException: x'))).toBe('unsupported');
    expect(classifyLayoutFailure(new Error('org.eclipse.elk.graph.json.JsonImportException: x'))).toBe('input');
    expect(classifyLayoutFailure(new Error('java.lang.IllegalStateException: x'))).toBe('engine');
    expect(classifyLayoutFailure(new Error('cycle detected'))).toBe('other');
    expect(classifyLayoutFailure('too much recursion')).toBe('stack');
    expect(classifyLayoutFailure(undefined)).toBe('other');
  });

  it('the report cuts the message for the log and bounds the counts', () => {
    const report = layoutFailureReport(new Error('x'.repeat(2000)), { tables: 5e9, relationships: -3 });
    expect(report.log).toEqual({ tables: 1_000_000, relationships: 0, message: 'x'.repeat(500) });
    expect(report.tableBucket).toBe('500plus');
    expect(report.relBucket).toBe('under100');
  });
});


// the reporter (2026-11-12): grouping by Join depth or Table type failed on every
// ELK step. What ELK is handed when grouping, and the steps after rung 3.
describe('runElkLayout grouping, the grouping-off step and the grid', () => {
  type Graph = {
    layoutOptions: Record<string, string>;
    children: Array<{ id: string; layoutOptions?: Record<string, string> }>;
    edges: Array<{ id: string; sources: string[]; targets: string[] }>;
  };
  const table = (id: string, measured = { width: 260, height: 180 }): TableFlowNode => ({ ...node, id, measured, data: { ...node.data, modelName: id } });
  const rel = (id: string, source: string, target: string) => ({ id, type: 'fk', source, target, data: {} }) as unknown as import('@erd-studio/renderer/editor').FkFlowEdge;
  const placeAll = (graph: unknown) => Promise.resolve({ id: 'root', children: (graph as Graph).children.map((c, i) => ({ id: c.id, x: i * 10, y: 0 })) });

  it('with grouping on, every relationship ELK gets points forward along the bands, and one to a missing table is left out', async () => {
    const graphs: Graph[] = [];
    fakes.state.layoutImpl = (graph) => { graphs.push(graph as Graph); return placeAll(graph); };
    const nodes = ['a', 'b', 'c', 'd'].map((id) => table(id));
    // a -> b -> c -> d, and d -> b closing a cycle; one relationship to a table not on the diagram.
    const edges = [rel('e1', 'a', 'b'), rel('e2', 'b', 'c'), rel('e3', 'c', 'd'), rel('e4', 'd', 'b'), rel('e5', 'a', 'gone')];
    await runElkLayout(nodes, edges, undefined, 'depth');
    const [graph] = graphs;
    expect(graph.layoutOptions['elk.partitioning.activate']).toBe('true');
    const band = new Map(graph.children.map((c) => [c.id, Number(c.layoutOptions?.['elk.partitioning.partition'])]));
    expect(graph.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
    for (const e of graph.edges) expect(band.get(e.sources[0])!).toBeLessThanOrEqual(band.get(e.targets[0])!);
    // The cycle b -> c -> d -> b is turned into a chain: no edge closes it any more.
    const order = new Map(['a', 'b', 'c', 'd'].map((id, i) => [id, i]));
    const forward = graph.edges.filter((e) => order.get(e.sources[0])! < order.get(e.targets[0])!);
    expect(forward).toHaveLength(4);
  });

  it('None hands ELK the relationships as they are (only one to a missing table is left out)', async () => {
    const graphs: Graph[] = [];
    fakes.state.layoutImpl = (graph) => { graphs.push(graph as Graph); return placeAll(graph); };
    await runElkLayout([table('a'), table('b')], [rel('e1', 'b', 'a'), rel('e2', 'a', 'b'), rel('e3', 'a', 'x')], undefined, 'none');
    expect(graphs[0].edges).toEqual([
      { id: 'e1', sources: ['b'], targets: ['a'] },
      { id: 'e2', sources: ['a'], targets: ['b'] },
    ]);
  });

  it('after rung 3 a grouped layout is tried once more with grouping off, before the grid', async () => {
    const graphs: Graph[] = [];
    const outcomes: LayoutOutcome[] = [];
    const rungs: number[] = [];
    fakes.state.layoutImpl = (graph) => {
      graphs.push(graph as Graph);
      return graphs.length < 4 ? Promise.reject(new RangeError('Maximum call stack size exceeded')) : placeAll(graph);
    };
    const nodes = ['a', 'b', 'c'].map((id) => table(id));
    await runElkLayout(nodes, [rel('e1', 'a', 'b'), rel('e2', 'b', 'c')], undefined, 'auto', { onOutcome: (o) => outcomes.push(o), onFallbackRung: (r) => rungs.push(r) });
    expect(graphs.map((g) => g.layoutOptions['elk.partitioning.activate'])).toEqual(['true', 'true', 'true', 'false']);
    expect(graphs[3].children.every((c) => c.layoutOptions === undefined)).toBe(true);
    expect(graphs[3].layoutOptions['elk.layered.nodePlacement.strategy']).toBe(STACK_SAFE_NODE_PLACEMENT);
    expect(graphs[3].layoutOptions['elk.layered.compaction.postCompaction.strategy']).toBe('NONE');
    expect(outcomes).toEqual([{ step: 'ungrouped', grouping: 'depth', bands: 'off', reason: 'Maximum call stack size exceeded', failure: 'stack' }]);
    expect(rungs).toEqual([3]);
  });

  it('a diagram whose bands ELK would join with too many edges keeps them by direction only, on Brandes–Köpf', async () => {
    const graphs: Graph[] = [];
    const outcomes: LayoutOutcome[] = [];
    fakes.state.layoutImpl = (graph) => { graphs.push(graph as Graph); return placeAll(graph); };
    // A 300-table chain: five bands of about 60, about 14,000 joins.
    const nodes = Array.from({ length: 300 }, (_, i) => table(`t${i}`));
    const edges = nodes.slice(1).map((n, i) => rel(`e${i}`, nodes[i].id, n.id));
    await runElkLayout(nodes, edges, undefined, 'auto', { onOutcome: (o) => outcomes.push(o) });
    expect(graphs[0].layoutOptions['elk.partitioning.activate']).toBe('false');
    expect(graphs[0].layoutOptions['elk.layered.nodePlacement.strategy']).toBe(STACK_SAFE_NODE_PLACEMENT);
    expect(graphs[0].children.every((c) => c.layoutOptions === undefined)).toBe(true);
    expect(outcomes).toEqual([{ step: 'default', grouping: 'depth', bands: 'direction' }]);
    // The diagram's own node placement still wins.
    graphs.length = 0;
    await runElkLayout(nodes, edges, { 'elk.layered.nodePlacement.strategy': 'LINEAR_SEGMENTS' }, 'auto');
    expect(graphs[0].layoutOptions['elk.layered.nodePlacement.strategy']).toBe('LINEAR_SEGMENTS');
  });

  it(`a diagram of ${GRID_LAYOUT_MIN_TABLES} tables or ${GRID_LAYOUT_MIN_RELATIONSHIPS} relationships goes to the grid without ELK`, async () => {
    let calls = 0;
    const outcomes: LayoutOutcome[] = [];
    fakes.state.layoutImpl = (graph) => { calls++; return placeAll(graph); };
    const many = Array.from({ length: GRID_LAYOUT_MIN_TABLES }, (_, i) => table(`t${i}`));
    // #294: with the first-open layout's own options, as the canvas passes them.
    const positions = await runElkLayout(many, [], firstOpenLayoutOptions(many.length), 'auto', { onOutcome: (o) => outcomes.push(o) });
    expect(calls).toBe(0);
    expect(Object.keys(positions)).toHaveLength(GRID_LAYOUT_MIN_TABLES);
    expect(outcomes).toEqual([{ step: 'grid', grouping: 'none', bands: 'off', reason: 'size' }]);
    const few = [table('a'), table('b')];
    const dense = Array.from({ length: GRID_LAYOUT_MIN_RELATIONSHIPS }, (_, i) => rel(`e${i}`, 'a', 'b'));
    await runElkLayout(few, dense);
    expect(calls).toBe(0);
  });

  it('says what a degraded layout did, for the user and for the log', () => {
    expect(layoutOutcomeNotice({ step: 'default', grouping: 'depth', bands: 'partitioned' }, 130)).toBeUndefined();
    expect(layoutOutcomeNotice({ step: 'brandesKoepf', grouping: 'depth', bands: 'partitioned', reason: 'x' }, 130)).toBeUndefined();
    expect(layoutOutcomeNotice({ step: 'ungrouped', grouping: 'depth', bands: 'off', reason: 'x' }, 130)).toEqual({ message: expect.stringMatching(/Grouping by Join depth failed .* no grouping/), actions: [] });
    expect(layoutOutcomeNotice({ step: 'grid', grouping: 'none', bands: 'off', reason: 'size' }, 2400)).toEqual({ message: expect.stringMatching(/This diagram \(2400 tables\) is too large/), actions: [] });
    // A grid after a failure (#294): the failure class's plain words, never the error's text.
    expect(layoutOutcomeNotice({ step: 'grid', grouping: 'none', bands: 'off', reason: 'ELK layout timed out after 30s', failure: 'timeout' }, 300))
      .toEqual(layoutFailureNotice('timeout', true));
    expect(layoutOutcomeNotice({ step: 'grid', grouping: 'none', bands: 'off', reason: 'boom' }, 12)).toEqual(layoutFailureNotice('other', true));
    expect(layoutOutcomeLogMessage({ step: 'default', grouping: 'depth', bands: 'partitioned' })).toBeUndefined();
    expect(layoutOutcomeLogMessage({ step: 'default', grouping: 'depth', bands: 'direction' })).toMatch(/relationship direction only/);
    expect(layoutOutcomeLogMessage({ step: 'ungrouped', grouping: 'depth', bands: 'off', reason: 'RangeError: Maximum call stack size exceeded' }))
      .toBe('used the fallback with grouping off (asked for grouping depth); the default layout failed: RangeError: Maximum call stack size exceeded');
    expect(layoutOutcomeLogMessage({ step: 'grid', grouping: 'role', bands: 'direction', reason: 'size' })).toBe('used the grid fallback (no ELK), grouping role; too large to try ELK');
  });
});
