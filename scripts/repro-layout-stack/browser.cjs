#!/usr/bin/env node
/*
 * REPRO (the reporter, 2026-11-12) in a real Chromium Web Worker: the canvas runs
 * ELK in a dedicated Worker made from a blob URL (webview/lib/elkLayout.ts
 * getElk), whose V8 stack is far smaller than Node's main thread. This runs
 * the same worker code (elk-worker.min.js) the same way, with the same graph
 * runElkLayout builds (planElkLayout) and the same ladder (the default
 * layout, Brandes-Koepf, no post-compaction, grouping off, then the grid with
 * no ELK), one ELK instance per diagram so the fallbacks reuse the worker, as
 * the canvas does, and runElkLayout's 30 s guard per attempt.
 *
 *   node scripts/repro-layout-stack/build.mjs
 *   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core CHROMIUM=/path/to/chrome \
 *     node scripts/repro-layout-stack/browser.cjs "<shape>:<tables>:<rels>[:seed]" ... [--strategies=auto,role,depth,none]
 */
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const layout = require(path.join(__dirname, '.out/layout.cjs'));
const { generate } = require('./run.cjs');

const root = path.resolve(__dirname, '../..');
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');

// The graphs runElkLayout hands ELK, from the product code itself (planElkLayout):
// the default layout, then each ELK fallback. When every one fails, runElkLayout
// uses the grid (no ELK), which is computed here in Node.
function elkGraphs(nodes, edges, strategy) {
  const options = layout.buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
  if (!layout.planElkLayout) {
    // A pre-fix bundle: the graph as runElkLayout built it then.
    const resolved = strategy === 'auto' ? layout.detectStrategy(nodes, edges) : strategy;
    let partitions = null;
    let base = layout.DEFAULT_ELK_OPTIONS;
    if (resolved === 'depth') { base = { ...base, 'elk.partitioning.activate': 'true' }; partitions = layout.computeDepthPartitions(nodes, edges); }
    if (resolved === 'role') { base = layout.ROLE_AWARE_ELK_OPTIONS; partitions = new Map(nodes.map((x) => [x.id, layout.roleToPartition(x.data.modelRole)])); }
    const merged = { ...base, ...options };
    if (merged['elk.partitioning.activate'] !== 'true') partitions = null;
    const graph = { id: 'root', layoutOptions: merged, children: layout.toElkChildren(nodes, partitions), edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })) };
    const rungs = [{ rung: 'default', graph }, ...layout.stackSafeFallbackRungs(merged).map((r) => ({ rung: String(r.rung), graph: { ...graph, layoutOptions: r.options } }))];
    return { resolved, rungs, grid: null, skipElk: false };
  }
  const plan = layout.planElkLayout(nodes, edges, options, strategy);
  const rungs = [{ rung: 'default', graph: plan.graph }, ...plan.fallbacks.map((f) => ({ rung: f.step, graph: f.graph }))];
  const skipElk = nodes.length >= layout.GRID_LAYOUT_MIN_TABLES || edges.length >= layout.GRID_LAYOUT_MIN_RELATIONSHIPS;
  return { resolved: `${plan.grouping}/${plan.bands}`, rungs, grid: () => layout.gridLayout(nodes, edges, plan.options, plan.gridBands), skipElk };
}

async function main() {
  const args = process.argv.slice(2);
  const strategies = (args.find((a) => a.startsWith('--strategies=')) || '--strategies=auto,role,depth,none').split('=')[1].split(',');
  const cases = args.filter((a) => !a.startsWith('--'));
  const apiBundle = buildSync({ entryPoints: [require.resolve('elkjs/lib/elk-api.js', { paths: [root] })], bundle: true, format: 'iife', globalName: 'ELKApi', write: false }).outputFiles[0].text;
  const workerCode = fs.readFileSync(require.resolve('elkjs/lib/elk-worker.min.js', { paths: [root] }), 'utf8');

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const page = await browser.newPage();
  page.on('crash', () => console.log('!! the page crashed (renderer process died)'));
  page.on('pageerror', (e) => console.log('!! page error', e.message));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: apiBundle });
  await page.evaluate((code) => { window.__ELK_WORKER_CODE__ = code; }, workerCode);

  // How deep a trivial recursion gets on the page's main thread and in a dedicated worker.
  const depth = await page.evaluate(async () => {
    const probe = 'function d(n){try{return d(n+1)}catch(e){return n}}';
    const main = new Function(`${probe}; return d(0);`)();
    const blob = new Blob([`${probe}; postMessage(d(0));`], { type: 'text/javascript' });
    const w = new Worker(URL.createObjectURL(blob));
    const worker = await new Promise((r) => { w.onmessage = (e) => r(e.data); });
    w.terminate();
    return { main, worker };
  });
  console.log(`chromium ${browser.version()}: trivial recursion depth main=${depth.main} worker=${depth.worker}`);

  for (const c of cases) {
    const [shape, n, m, seed = '1'] = c.split(':');
    const { nodes, edges } = generate(shape, Number(n), Number(m), Number(seed));
    for (const strategy of strategies) {
      const { resolved, rungs, grid, skipElk } = elkGraphs(nodes, edges, strategy);
      const out = skipElk ? [] : await page.evaluate(async ({ rungs, timeoutMs }) => {
        const ELK = window.ELKApi.default;
        let worker;
        const make = () => new ELK({ workerFactory: () => {
          const url = URL.createObjectURL(new Blob([window.__ELK_WORKER_CODE__], { type: 'text/javascript' }));
          worker = new Worker(url);
          URL.revokeObjectURL(url);
          return worker;
        } });
        let elk = make();
        const attempts = [];
        try {
          for (const r of rungs) {
            const t0 = performance.now();
            try {
              // runElkLayout's 30 s guard: a layout still running is abandoned and its worker replaced.
              const res = await Promise.race([
                elk.layout(r.graph),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`ELK layout timed out after ${timeoutMs / 1000}s`)), timeoutMs)),
              ]);
              const placed = (res.children || []).filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y)).length;
              if (placed < r.graph.children.length) throw new Error('ELK returned a layout with a table left unplaced');
              attempts.push({ rung: r.rung, ok: true, ms: Math.round(performance.now() - t0), placed });
              break;
            } catch (err) {
              const timedOut = /timed out/.test(String(err && err.message));
              attempts.push({ rung: r.rung, ok: false, ms: Math.round(performance.now() - t0), error: `${err && err.name}: ${err && err.message}`, stack: String(err && err.stack || '').split('\n').slice(1, 6).map((x) => x.trim()) });
              if (timedOut) { worker && worker.terminate(); break; }
            }
          }
        } finally {
          worker && worker.terminate();
        }
        return attempts;
      }, { rungs, timeoutMs: Number(process.env.REPRO_TIMEOUT_MS || 30000) });
      const final = out[out.length - 1];
      let verdict;
      if (final && final.ok) verdict = final.rung === 'default' ? 'OK' : `OK via ${final.rung}`;
      else if (grid) {
        const t0 = Date.now();
        const positions = grid();
        const placed = Object.values(positions).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)).length;
        verdict = `${placed === nodes.length ? 'OK' : 'FAIL'} via grid (${skipElk ? 'too large to try ELK' : `every ELK step failed, first="${out[0].error}"`}; ${placed}/${nodes.length} placed in ${Date.now() - t0}ms)`;
      } else verdict = `FAIL (every rung) first="${out[0].error}"`;
      console.log(`${shape.padEnd(8)} ${String(n).padStart(5)}t ${String(edges.length).padStart(6)}r ${strategy.padEnd(5)}->${resolved.padEnd(18)}  ${verdict}  ${out.map((a) => `${a.rung}:${a.ok ? 'ok' : 'x'}${a.ms}ms`).join(' ')}`);
      if (!(final && final.ok) && process.env.REPRO_STACK) for (const a of out) console.log(`    ${a.rung} ${a.error}\n      ${a.stack.join('\n      ')}`);
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(2); });
