/**
 * REPRO (Gerhard, 2026-11-12): "Auto layout failed: Maximum call stack size
 * exceeded" with Grouping Auto or Join depth, while Table type and None work.
 *
 * Runs the real `runElkLayout` with the real ELK engine (in-process, the same
 * elk-worker.min.js the canvas loads into its Web Worker) on a small diagram
 * with two-way relationships. It is NOT a memory or stack-size problem: the
 * diagram is 8 tables, and it fails on any stack size.
 *
 * Mechanism: grouping turns on ELK partitioning. ELK's GREEDY cycle breaker
 * reverses an edge that crosses partitions (it is not on any cycle, but the
 * downstream table wins the greedy tie-break), then ELK's PartitionMidprocessor
 * adds a dummy edge from every table of one partition to every table of the
 * next, which closes a cycle. Coffman-Graham layering's transitive reduction
 * (`CoffmanGrahamLayerer.dfs`, minified `CGc`) recurses around that cycle for
 * ever. The fallback rungs (Brandes-Koepf, no post-compaction) do not touch
 * cycle breaking or layering, so every rung fails the same way.
 *
 * NEXT AGENT (stage 2, the fix): these are `it.fails` so the suite stays green
 * while the bug is open. Flip each `it.fails` to `it` with the fix; they must
 * then pass. Repro scripts: scripts/repro-layout-stack/ (README in run.cjs).
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
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

import { runElkLayout, type PartitionStrategy } from '../../webview/lib/elkLayout';
import { buildLayoutOptions } from '../../webview/lib/firstOpenLayout';

beforeAll(() => {
  (globalThis as Record<string, unknown>).__ELK_WORKER_CODE__ = '';
});

function table(id: string, role?: TableRole): TableFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    measured: { width: 260, height: 180 },
    data: { modelName: id, stage: 'logical', layer: 'silver', columns: [], isStub: false, ...(role ? { modelRole: role } : {}) },
  } as TableFlowNode;
}

/**
 * 8 tables, 14 relationships (many -> one), found by scripts/repro-layout-stack/sweep.cjs
 * (twoway 8 14, seed 192): two pairs of tables that reference each other
 * (t7 <-> t3, t0 <-> t1), parallel FKs, and FKs from the first pair's side to
 * the second's. Join depth puts t3..t7 in band 0 and t0..t2 in band 4.
 */
const RELS = '7>3 3>7 4>0 3>2 1>0 0>1 3>1 6>0 5>1 3>2 1>0 6>2 1>0 1>0';

function diagram(roles?: (id: string) => TableRole | undefined): { nodes: TableFlowNode[]; edges: FkFlowEdge[] } {
  const nodes = Array.from({ length: 8 }, (_, i) => table(`t${i}`, roles?.(`t${i}`)));
  const edges = RELS.split(' ').map((pair, i) => {
    const [s, t] = pair.split('>');
    return { id: `e${i}`, type: 'fk', source: `t${s}`, target: `t${t}`, data: {} } as unknown as FkFlowEdge;
  });
  return { nodes, edges };
}

async function layOut(strategy: PartitionStrategy, roles?: (id: string) => TableRole | undefined) {
  const { nodes, edges } = diagram(roles);
  // Exactly what the toolbar's Layout button passes (Toolbar.tsx runLayout).
  const options = buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
  return runElkLayout(nodes, edges, options, strategy);
}

describe('REPRO: grouped layout of a diagram with two-way relationships', () => {
  // Controls: these already pass, as Gerhard saw.
  it('None lays every table out', async () => {
    expect(Object.keys(await layOut('none'))).toHaveLength(8);
  });

  it('Table type with no roles (one band) lays every table out', async () => {
    expect(Object.keys(await layOut('role'))).toHaveLength(8);
  });

  // The bug. Today each rejects with "Maximum call stack size exceeded".
  it.fails('Auto (resolves to Join depth) lays every table out', async () => {
    expect(Object.keys(await layOut('auto'))).toHaveLength(8);
  });

  it.fails('Join depth lays every table out', async () => {
    expect(Object.keys(await layOut('depth'))).toHaveLength(8);
  });

  // Table type is only safe for Gerhard because his imported tables have no
  // roles; with roles in two bands it takes the same path and fails too.
  it.fails('Table type with roles in two bands lays every table out', async () => {
    const roles = (id: string): TableRole => (['t0', 't1', 't2'].includes(id) ? 'gold-fact' : 'transaction-fact');
    expect(Object.keys(await layOut('role', roles))).toHaveLength(8);
  });

  // Pins today's failure, so the repro cannot silently stop reproducing.
  // Delete this one with the fix.
  it('today: Auto, Join depth and two-band Table type reject with a stack overflow (delete with the fix)', async () => {
    const roles = (id: string): TableRole => (['t0', 't1', 't2'].includes(id) ? 'gold-fact' : 'transaction-fact');
    await expect(layOut('auto')).rejects.toThrow(/Maximum call stack size exceeded/);
    await expect(layOut('depth')).rejects.toThrow(/Maximum call stack size exceeded/);
    await expect(layOut('role', roles)).rejects.toThrow(/Maximum call stack size exceeded/);
  });
});
