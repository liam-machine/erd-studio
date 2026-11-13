#!/usr/bin/env node
/*
 * REPRO (the reporter, 2026-11-12): "Auto layout failed: Maximum call stack size
 * exceeded" with Grouping Auto / Join depth on ~130 tables / ~80 relationships.
 *
 * Runs the real `runElkLayout` (webview/lib/elkLayout.ts, bundled by
 * build.mjs) with the real ELK engine in-process, with the exact options the
 * toolbar's Layout button builds (`buildLayoutOptions`), on a generated
 * diagram. Shrink the stack with `node --stack-size=<KB>` to stand in for a
 * Web Worker's smaller stack.
 *
 *   node scripts/repro-layout-stack/build.mjs
 *   node --stack-size=400 scripts/repro-layout-stack/run.cjs <shape> <tables> <rels> <strategy> [seed]
 *
 * shapes: random | chain | star | cycles | islands | parallel | selfref | reporter | twoway
 * strategy: auto | role | depth | none | all
 * REPRO_ELK=full uses elk-worker.js (unminified) for readable frames.
 * REPRO_JSON=1 prints one JSON line per run.
 */
Error.stackTraceLimit = 40;
const path = require('node:path');
const layout = require(path.join(__dirname, '.out/layout.cjs'));

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function makeNode(i, rand, role) {
  const cols = 3 + Math.floor(rand() * 25);
  return {
    id: `t_${i}`,
    type: 'model',
    position: { x: 0, y: 0 },
    measured: { width: 220 + Math.floor(rand() * 120), height: 40 + cols * 22 },
    data: { modelName: `t_${i}`, stage: 'logical', layer: 'silver', columns: [], isStub: false, ...(role ? { modelRole: role } : {}) },
  };
}

function edge(id, s, t) {
  return { id: `e_${id}`, type: 'fk', source: `t_${s}`, target: `t_${t}`, data: {} };
}

/** Generate a diagram. Every edge goes many (source) -> one (target), as the canvas draws an FK. */
function generate(shape, n, m, seed) {
  const rand = rng(seed);
  const nodes = Array.from({ length: n }, (_, i) => makeNode(i, rand));
  const edges = [];
  let k = 0;
  const add = (s, t) => edges.push(edge(k++, s, t));
  switch (shape) {
    case 'chain':
      for (let i = 0; i + 1 < n && edges.length < m; i++) add(i, i + 1);
      while (edges.length < m) add(Math.floor(rand() * n), Math.floor(rand() * n));
      break;
    case 'star': {
      const hubs = Math.max(1, Math.floor(n / 40));
      for (let i = hubs; i < n && edges.length < m; i++) add(i, i % hubs);
      while (edges.length < m) add(hubs + Math.floor(rand() * (n - hubs)), Math.floor(rand() * hubs));
      break;
    }
    case 'cycles':
      for (let i = 0; i < n && edges.length < m; i++) add(i, (i + 1) % n);
      while (edges.length < m) add(Math.floor(rand() * n), Math.floor(rand() * n));
      break;
    case 'islands': {
      // many small connected groups of 2-6 tables, plus isolated tables
      let i = 0;
      while (i < n && edges.length < m) {
        const size = 2 + Math.floor(rand() * 5);
        for (let j = 1; j < size && i + j < n && edges.length < m; j++) add(i + j, i + Math.floor(rand() * j));
        i += size;
      }
      break;
    }
    case 'parallel':
      while (edges.length < m) {
        const s = Math.floor(rand() * n);
        const t = Math.floor(rand() * n);
        const copies = 1 + Math.floor(rand() * 5);
        for (let c = 0; c < copies && edges.length < m; c++) add(s, t);
      }
      break;
    case 'selfref':
      for (let i = 0; i < n && edges.length < m; i += 3) add(i, i);
      while (edges.length < m) add(Math.floor(rand() * n), Math.floor(rand() * n));
      break;
    case 'reporter': {
      // An imported SAP-ish warehouse: ~1/3 of tables isolated, the rest in
      // a few loosely connected subject areas with DAG-ish FKs (fact -> dim),
      // a couple of two-way pairs and a self-reference.
      const connected = Math.floor(n * 0.65);
      for (let i = 1; i < connected && edges.length < m; i++) {
        const t = Math.floor(rand() * i);
        add(i, t);
      }
      while (edges.length < m) {
        const s = Math.floor(rand() * connected);
        const t = Math.floor(rand() * connected);
        add(s, t);
      }
      break;
    }
    case 'twoway': {
      // FKs that mostly point one way (fact -> dim), with ~1 in 8 also
      // pointing back (a two-way relationship, or a circular FK chain).
      while (edges.length < m) {
        const s = 1 + Math.floor(rand() * (n - 1));
        const t = Math.floor(rand() * s);
        add(s, t);
        if (rand() < 0.125 && edges.length < m) add(t, s);
      }
      break;
    }
    case 'random':
    default:
      while (edges.length < m) add(Math.floor(rand() * n), Math.floor(rand() * n));
  }
  return { nodes, edges };
}

function topFrames(err, count = 8) {
  const stack = (err && err.stack) ? String(err.stack).split('\n').slice(1) : [];
  const frames = stack.map((l) => l.trim().replace(/^at /, '').replace(/\(.*elkjs\/lib\//, '(').replace(/\(\/.*\//, '('));
  return frames.slice(0, count);
}

/** The partition sizes the depth grouping produces (how the diagram is cut into bands). */
function bandSizes(nodes, edges) {
  const p = layout.computeDepthPartitions(nodes, edges);
  const sizes = [0, 0, 0, 0, 0];
  for (const v of p.values()) sizes[v]++;
  return sizes;
}

async function runOne(shape, n, m, strategy, seed) {
  const { nodes, edges } = generate(shape, n, m, seed);
  const options = layout.buildLayoutOptions(
    { partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' },
    nodes.length,
    undefined,
  );
  const resolved = strategy === 'auto' ? layout.detectStrategy(nodes, edges) : strategy;
  let rung;
  let stackFallback = false;
  let outcome;
  const t0 = Date.now();
  const out = { shape, tables: n, rels: edges.length, strategy, resolved, bound: options['elk.layered.layering.coffmanGraham.layerBound'], bands: resolved === 'depth' ? bandSizes(nodes, edges).join('/') : '-' };
  try {
    const positions = await layout.runElkLayout(nodes, edges, options, strategy, {
      onStackFallback: () => { stackFallback = true; },
      onFallbackRung: (r) => { rung = r; },
      onOutcome: (o) => { outcome = o; },
    });
    const finite = Object.values(positions).every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    Object.assign(out, { ok: true, placed: Object.keys(positions).length, finite, rung: rung ?? 1, step: outcome ? outcome.step : '-', bandsUsed: outcome ? outcome.bands : '-', stackFallback, ms: Date.now() - t0 });
  } catch (err) {
    // layoutFailureReport is develop-only (#299); a v2.0.4 bundle has just the error.
    const report = layout.layoutFailureReport
      ? layout.layoutFailureReport(err, { tables: n, relationships: edges.length })
      : { failure: layout.classifyLayoutFailure ? layout.classifyLayoutFailure(err) : 'n/a (v2.0.4)' };
    Object.assign(out, { ok: false, ms: Date.now() - t0, error: `${err && err.name}: ${err && err.message}`, failure: report.failure, exhausted: !!report.exhausted, lastFailure: report.lastFailure, stackFallback, frames: topFrames(err) });
  }
  return out;
}

function print(r) {
  if (process.env.REPRO_JSON) { console.log(JSON.stringify(r)); return; }
  const head = `${r.shape.padEnd(8)} ${String(r.tables).padStart(5)}t ${String(r.rels).padStart(6)}r  ${r.strategy.padEnd(5)}->${r.resolved.padEnd(5)} bound=${r.bound} bands=${r.bands}`;
  if (r.ok) console.log(`${head}  OK   rung=${r.rung} step=${r.step} bandsUsed=${r.bandsUsed} placed=${r.placed}${r.finite ? '' : ' NON-FINITE'} ${r.ms}ms`);
  else {
    console.log(`${head}  FAIL ${r.error} [${r.failure}${r.exhausted ? `, every fallback failed, last=${r.lastFailure}` : ''}] ${r.ms}ms`);
    for (const f of r.frames) console.log(`        at ${f}`);
  }
}

async function main() {
  const [shape = 'reporter', n = '130', m = '80', strategy = 'all', seed = '1'] = process.argv.slice(2);
  const strategies = strategy === 'all' ? ['auto', 'role', 'depth', 'none'] : [strategy];
  for (const s of strategies) print(await runOne(shape, Number(n), Number(m), s, Number(seed)));
}

module.exports = { generate, runOne };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(2); });
