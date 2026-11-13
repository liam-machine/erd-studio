/**
 * the reporter (2026-11-12): "Auto layout failed: Maximum call stack size
 * exceeded" with Grouping Auto or Join depth, while Table type and None work.
 *
 * Runs the real `runElkLayout` with the real ELK engine (in-process, the same
 * elk-worker.min.js the canvas loads into its Web Worker). It was NOT a memory
 * or stack-size problem: the smallest diagram is 8 tables, and it failed on
 * any stack size.
 *
 * Mechanism: grouping turns on ELK partitioning. ELK's GREEDY cycle breaker
 * reversed a relationship that crosses partitions (not on any cycle; the
 * downstream table won the greedy tie-break), then ELK's PartitionMidprocessor
 * added an edge from every table of one partition to every table of the next,
 * which closed a cycle. Coffman–Graham layering's transitive reduction
 * (`CoffmanGrahamLayerer.dfs`, minified `CGc`) recursed round that cycle for
 * ever. The fallback rungs (Brandes–Köpf, no post-compaction) did not touch
 * cycle breaking or layering, so every rung failed the same way.
 *
 * The fix (`orientEdgesForPartitions`): when grouping, every relationship ELK
 * gets points forward along one order of the bands, so there is no cycle to
 * walk. These tests assert ELK's own default layout succeeds, not a fallback.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TableFlowNode, FkFlowEdge } from '@erd-studio/renderer/editor';
import type { TableRole } from '../../src/types/semantic';

// The real engine, in-process, in place of elk-api's Worker-backed client.
vi.mock('elkjs/lib/elk-api', () => {
  const require = createRequire(import.meta.url);
  const ELKApi = require('elkjs/lib/elk-api.js').default;
  const { Worker } = require('elkjs/lib/elk-worker.min.js');
  class InProcessELK extends ELKApi {
    constructor() {
      super({ workerFactory: (url?: string) => new Worker(url) });
    }
  }
  return { default: InProcessELK };
});

import {
  runElkLayout,
  tableTypeBandCount,
  layoutLeftTablesInPlace,
  layoutUnchangedNotice,
  GRID_LAYOUT_MIN_TABLES,
  LAYOUT_TIMEOUT_MS,
  type LayoutOutcome,
  type PartitionStrategy,
} from '../../webview/lib/elkLayout';
import { buildLayoutOptions, firstOpenLayoutOptions } from '../../webview/lib/firstOpenLayout';

/** The first-open layout's time bound for a large diagram with no relationships (#294). */
const FIRST_OPEN_BOUND_MS = LAYOUT_TIMEOUT_MS / 3;

beforeAll(() => {
  (globalThis as Record<string, unknown>).__ELK_WORKER_CODE__ = '';
});

function table(id: string, role?: TableRole, measured = { width: 260, height: 180 }): TableFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    measured,
    data: { modelName: id, stage: 'logical', layer: 'silver', columns: [], isStub: false, ...(role ? { modelRole: role } : {}) },
  } as TableFlowNode;
}

function rel(id: string, source: string, target: string): FkFlowEdge {
  return { id, type: 'fk', source, target, data: {} } as unknown as FkFlowEdge;
}

/**
 * 8 tables, 14 relationships (many -> one), found by scripts/repro-layout-stack/sweep.cjs
 * (twoway 8 14, seed 192): two pairs of tables that reference each other
 * (t7 <-> t3, t0 <-> t1), parallel FKs, and FKs from the first pair's side to
 * the second's.
 */
const RELS = '7>3 3>7 4>0 3>2 1>0 0>1 3>1 6>0 5>1 3>2 1>0 6>2 1>0 1>0';

function diagram(roles?: (id: string) => TableRole | undefined): { nodes: TableFlowNode[]; edges: FkFlowEdge[] } {
  const nodes = Array.from({ length: 8 }, (_, i) => table(`t${i}`, roles?.(`t${i}`)));
  const edges = RELS.split(' ').map((pair, i) => {
    const [s, t] = pair.split('>');
    return rel(`e${i}`, `t${s}`, `t${t}`);
  });
  return { nodes, edges };
}

/** Exactly what the toolbar's Layout button passes (Toolbar.tsx runLayout). */
async function layOut(nodes: TableFlowNode[], edges: FkFlowEdge[], strategy: PartitionStrategy) {
  const options = buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
  const outcomes: LayoutOutcome[] = [];
  const positions = await runElkLayout(nodes, edges, options, strategy, { onOutcome: (o) => outcomes.push(o) });
  expect(outcomes).toHaveLength(1);
  return { positions, outcome: outcomes[0] };
}

const goldFacts = (id: string): TableRole => (['t0', 't1', 't2'].includes(id) ? 'gold-fact' : 'transaction-fact');

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** FKs that mostly point one way, about 1 in 8 also pointing back (scripts/repro-layout-stack/run.cjs `twoway`). */
function twoWay(n: number, m: number, seed: number): { nodes: TableFlowNode[]; edges: FkFlowEdge[] } {
  const rand = rng(seed);
  const nodes = Array.from({ length: n }, (_, i) => table(`t${i}`, undefined, { width: 220 + Math.floor(rand() * 120), height: 40 + (3 + Math.floor(rand() * 25)) * 22 }));
  const edges: FkFlowEdge[] = [];
  while (edges.length < m) {
    const s = 1 + Math.floor(rand() * (n - 1));
    const t = Math.floor(rand() * s);
    edges.push(rel(`e${edges.length}`, `t${s}`, `t${t}`));
    if (rand() < 0.125 && edges.length < m) edges.push(rel(`e${edges.length}`, `t${t}`, `t${s}`));
  }
  return { nodes, edges };
}

const placedEverywhere = (positions: Record<string, { x: number; y: number }>, n: number) =>
  Object.keys(positions).length === n && Object.values(positions).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

describe('grouped layout of a diagram with two-way relationships (the reporter, 2026-11-12)', () => {
  it('None lays every table out', async () => {
    const { nodes, edges } = diagram();
    const { positions, outcome } = await layOut(nodes, edges, 'none');
    expect(Object.keys(positions)).toHaveLength(8);
    expect(outcome.step).toBe('default');
  });

  it('Table type with no roles (one band) lays every table out', async () => {
    const { nodes, edges } = diagram();
    expect(Object.keys((await layOut(nodes, edges, 'role')).positions)).toHaveLength(8);
  });

  // The bug: each rejected with "Maximum call stack size exceeded" on every rung.
  it('Auto (resolves to Join depth) lays every table out with ELK\'s own grouped layout', async () => {
    const { nodes, edges } = diagram();
    const { positions, outcome } = await layOut(nodes, edges, 'auto');
    expect(Object.keys(positions)).toHaveLength(8);
    expect(outcome).toEqual({ step: 'default', grouping: 'depth', bands: 'partitioned' });
  });

  it('Join depth lays every table out with ELK\'s own grouped layout', async () => {
    const { nodes, edges } = diagram();
    const { positions, outcome } = await layOut(nodes, edges, 'depth');
    expect(Object.keys(positions)).toHaveLength(8);
    expect(outcome).toEqual({ step: 'default', grouping: 'depth', bands: 'partitioned' });
  });

  // Table type was only safe for the reporter because his imported tables have no
  // roles; with roles in two bands it took the same path and failed too.
  it('Table type with roles in two bands lays every table out with ELK\'s own grouped layout', async () => {
    const { nodes, edges } = diagram(goldFacts);
    const { positions, outcome } = await layOut(nodes, edges, 'role');
    expect(Object.keys(positions)).toHaveLength(8);
    expect(outcome).toEqual({ step: 'default', grouping: 'role', bands: 'partitioned' });
  });

  // Seeds the stage-1 sweep found failing before the fix (5 of 200 at 15/28,
  // 3 of 30 at 40/80); every seed must now lay out in ELK, grouped.
  it.each([
    [15, 28, 120],
    [40, 80, 12],
  ])('two-way diagrams of %i tables / %i relationships: %i seeds all lay out in ELK, grouped', async (n, m, seeds) => {
    for (let seed = 1; seed <= seeds; seed++) {
      const { nodes, edges } = twoWay(n, m, seed);
      for (const strategy of ['auto', 'depth'] as const) {
        const { positions, outcome } = await layOut(nodes, edges, strategy);
        expect(placedEverywhere(positions, n), `seed ${seed} ${strategy}`).toBe(true);
        // ELK itself, grouped: not the grouping-off step or the grid.
        expect(['default', 'brandesKoepf', 'noCompaction'], `seed ${seed} ${strategy}: ${outcome.step}`).toContain(outcome.step);
        expect(outcome.bands).not.toBe('off');
      }
    }
  }, 60_000);
});

/**
 * the reporter: "None does not fail but I cannot tell whether it did anything".
 * Real-app check (2026-11-12): Table type -> None -> Re-apply moved nothing,
 * with no message. With no table types, Table type and None ARE the same
 * layout; the canvas must say so instead of looking like it never ran.
 */
describe('Table type and None on tables with no table types (real engine)', () => {
  it('produce identical positions, which is why a switch between them moves nothing', async () => {
    const { nodes, edges } = diagram();
    expect(tableTypeBandCount(nodes)).toBe(1);
    const role = await layOut(nodes, edges, 'role');
    const none = await layOut(nodes, edges, 'none');
    expect(role.positions).toEqual(none.positions);
    // Placed where the last layout put them, the next layout reports "nothing moved".
    const placed = nodes.map((n) => ({ ...n, position: role.positions[n.id] }));
    expect(layoutLeftTablesInPlace(placed, none.positions)).toBe(true);
    expect(layoutUnchangedNotice(none.outcome, tableTypeBandCount(nodes))).toMatch(/no table types to group by, so Table type and None arrange them the same way/);
  });

  it('differ once the tables have two table types', async () => {
    const { nodes, edges } = diagram(goldFacts);
    expect(tableTypeBandCount(nodes)).toBe(2);
    const role = await layOut(nodes, edges, 'role');
    const none = await layOut(nodes, edges, 'none');
    expect(role.positions).not.toEqual(none.positions);
  });
});

describe('layout at scale (real engine)', () => {
  it('300 tables / 400 relationships with Auto keeps the grouping by direction and finishes in seconds', async () => {
    const { nodes, edges } = twoWay(300, 400, 3);
    const started = Date.now();
    const { positions, outcome } = await layOut(nodes, edges, 'auto');
    expect(placedEverywhere(positions, 300)).toBe(true);
    expect(outcome.bands).toBe('direction');
    // Before: over a minute on this size (ELK's band joins), past the 30 s guard.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  // #294: a large import with no relationships, laid out with the first-open
  // layout's own options. Measured at about 0.2 s; the bound is a third of the
  // 30 s guard, so a slower machine or worker still finishes well inside it.
  // One table more and it is the grid's, without ELK.
  it(`${GRID_LAYOUT_MIN_TABLES - 1} tables with no relationships lay out in ELK, with the first-open options, inside ${FIRST_OPEN_BOUND_MS / 1000} s`, async () => {
    const nodes = Array.from({ length: GRID_LAYOUT_MIN_TABLES - 1 }, (_, i) => table(`t${i}`));
    const outcomes: LayoutOutcome[] = [];
    const started = Date.now();
    const positions = await runElkLayout(nodes, [], firstOpenLayoutOptions(nodes.length), 'auto', { onOutcome: (o) => outcomes.push(o) });
    expect(Date.now() - started).toBeLessThan(FIRST_OPEN_BOUND_MS);
    expect(placedEverywhere(positions, nodes.length)).toBe(true);
    expect(outcomes).toEqual([expect.objectContaining({ step: 'default' })]);

    const more = [...nodes, table(`t${nodes.length}`)];
    outcomes.length = 0;
    await runElkLayout(more, [], firstOpenLayoutOptions(more.length), 'auto', { onOutcome: (o) => outcomes.push(o) });
    expect(outcomes).toEqual([expect.objectContaining({ step: 'grid', reason: 'size' })]);
  }, LAYOUT_TIMEOUT_MS);

  it.each(['auto', 'role', 'depth', 'none'] as const)('5,000 tables / 10,000 relationships (%s) are placed by the grid in well under a second', async (strategy) => {
    const { nodes, edges } = twoWay(5000, 10_000, 5);
    const started = Date.now();
    const { positions, outcome } = await layOut(nodes, edges, strategy);
    expect(placedEverywhere(positions, 5000)).toBe(true);
    expect(outcome).toMatchObject({ step: 'grid', reason: 'size' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// A Web Worker's stack is far smaller than a test process's (about 500 KB in
// Chromium, depth ~4,500 against ~8,800 on the page). Run the same layouts in
// a Node process with a deliberately small stack, as a weaker machine might.
describe('layout on a small stack (child process, node --stack-size)', () => {
  it('Auto, Join depth and None never surface a stack overflow, from 8 to 5,000 tables', async () => {
    const root = path.resolve(__dirname, '../..');
    const dir = path.join(root, 'node_modules/.cache/erd-layout-small-stack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'elkShim.cjs'), [
      "const ELKApi = require('elkjs/lib/elk-api.js').default;",
      "const { Worker } = require('elkjs/lib/elk-worker.min.js');",
      'class ELK extends ELKApi { constructor() { super({ workerFactory: (url) => new Worker(url) }); } }',
      'module.exports = ELK; module.exports.default = ELK;',
    ].join('\n'));
    const { build } = await import('esbuild');
    await build({
      stdin: {
        contents: "export * from './webview/lib/elkLayout'; export * from './webview/lib/firstOpenLayout';",
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: path.join(dir, 'layout.cjs'),
      tsconfig: path.join(root, 'tsconfig.webview.json'),
      define: { __ELK_WORKER_CODE__: '""' },
      alias: { 'elkjs/lib/elk-api': path.join(dir, 'elkShim.cjs') },
      external: ['elkjs/*'],
      logLevel: 'error',
    });
    // The diagrams are made here and handed over as JSON; the child only lays them out.
    const reporter8 = diagram();
    const cases: Array<{ label: string; strategy: PartitionStrategy; nodes: TableFlowNode[]; edges: FkFlowEdge[] }> = [
      ...(['auto', 'depth', 'none'] as const).map((strategy) => ({ label: '8/14 two-way', strategy, ...reporter8 })),
      { label: '8/14 two bands', strategy: 'role', ...diagram(goldFacts) },
      ...(['auto', 'none'] as const).map((strategy) => ({ label: '130/160 two-way', strategy, ...twoWay(130, 160, 1) })),
      { label: '130/80 two-way', strategy: 'auto', ...twoWay(130, 80, 2) },
      { label: '500/1000 two-way', strategy: 'auto', ...twoWay(500, 1000, 3) },
      ...(['auto', 'none'] as const).map((strategy) => ({ label: '5000/10000 two-way', strategy, ...twoWay(5000, 10_000, 4) })),
    ];
    fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
    fs.writeFileSync(path.join(dir, 'run.cjs'), `
      const L = require('./layout.cjs');
      const cases = require('./cases.json');
      (async () => {
        const results = [];
        for (const { label, strategy, nodes, edges } of cases) {
          const options = L.buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
          let step = '-';
          try {
            const p = await L.runElkLayout(nodes, edges, options, strategy, { onOutcome: (o) => { step = o.step; } });
            const ok = Object.keys(p).length === nodes.length && Object.values(p).every((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
            results.push({ label, strategy, ok, step });
          } catch (err) {
            results.push({ label, strategy, ok: false, error: String(err && err.message) });
          }
        }
        console.log(JSON.stringify(results));
      })();
    `);
    const started = Date.now();
    const child = spawnSync(process.execPath, ['--stack-size=200', path.join(dir, 'run.cjs')], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
    expect(child.status, child.stderr).toBe(0);
    const results = JSON.parse(child.stdout.trim().split('\n').pop()!) as Array<{ label: string; strategy: string; ok: boolean; step?: string; error?: string }>;
    expect(results).toHaveLength(cases.length);
    for (const r of results) expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    // The small diagrams lay out in ELK, grouped where asked, even on this stack: never the grid.
    for (const r of results.filter((x) => x.label.startsWith('8/14'))) expect(['default', 'brandesKoepf', 'noCompaction'], JSON.stringify(r)).toContain(r.step);
    expect(Date.now() - started).toBeLessThan(120_000);
  }, 180_000);
});
