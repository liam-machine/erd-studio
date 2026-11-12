#!/usr/bin/env node
/*
 * REPRO (Gerhard, 2026-11-12) in a real Chromium Web Worker: the canvas runs
 * ELK in a dedicated Worker made from a blob URL (webview/lib/elkLayout.ts
 * getElk), whose V8 stack is far smaller than Node's main thread. This runs
 * the same worker code (elk-worker.min.js) the same way, with the same graph
 * runElkLayout builds and the same fallback ladder (rung 1 = the default
 * options, 2 = Brandes-Koepf, 3 = no post-compaction), one ELK instance per
 * diagram so the fallbacks reuse the worker, as the canvas does.
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

function elkGraphs(nodes, edges, strategy) {
  const options = layout.buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
  const resolved = strategy === 'auto' ? layout.detectStrategy(nodes, edges) : strategy;
  let partitions = null;
  let base = layout.DEFAULT_ELK_OPTIONS;
  if (resolved === 'depth') { base = { ...base, 'elk.partitioning.activate': 'true' }; partitions = layout.computeDepthPartitions(nodes, edges); }
  if (resolved === 'role') { base = layout.ROLE_AWARE_ELK_OPTIONS; partitions = new Map(nodes.map((x) => [x.id, layout.roleToPartition(x.data.modelRole)])); }
  const merged = { ...base, ...options };
  if (merged['elk.partitioning.activate'] !== 'true') partitions = null;
  const graph = {
    id: 'root',
    layoutOptions: merged,
    children: layout.toElkChildren(nodes, partitions),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const rungs = [{ rung: 1, options: merged }, ...layout.stackSafeFallbackRungs(merged)];
  return { resolved, graph, rungs };
}

async function main() {
  const args = process.argv.slice(2);
  const strategies = (args.find((a) => a.startsWith('--strategies=')) || '--strategies=auto,role,depth,none').split('=')[1].split(',');
  const cases = args.filter((a) => !a.startsWith('--'));
  const apiBundle = buildSync({ entryPoints: [require.resolve('elkjs/lib/elk-api.js', { paths: [root] })], bundle: true, format: 'iife', globalName: 'ELKApi', write: false }).outputFiles[0].text;
  const workerCode = fs.readFileSync(require.resolve('elkjs/lib/elk-worker.min.js', { paths: [root] }), 'utf8');

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, headless: true });
  const page = await browser.newPage();
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
      const { resolved, graph, rungs } = elkGraphs(nodes, edges, strategy);
      const out = await page.evaluate(async ({ graph, rungs }) => {
        const ELK = window.ELKApi.default;
        let worker;
        const elk = new ELK({ workerFactory: () => {
          const url = URL.createObjectURL(new Blob([window.__ELK_WORKER_CODE__], { type: 'text/javascript' }));
          worker = new Worker(url);
          URL.revokeObjectURL(url);
          return worker;
        } });
        const attempts = [];
        try {
          for (const r of rungs) {
            const t0 = performance.now();
            try {
              const res = await elk.layout({ ...graph, layoutOptions: r.options });
              attempts.push({ rung: r.rung, ok: true, ms: Math.round(performance.now() - t0), placed: (res.children || []).length });
              break;
            } catch (err) {
              attempts.push({ rung: r.rung, ok: false, ms: Math.round(performance.now() - t0), error: `${err && err.name}: ${err && err.message}`, stack: String(err && err.stack || '').split('\n').slice(1, 6).map((s) => s.trim()) });
            }
          }
        } finally {
          worker && worker.terminate();
        }
        return attempts;
      }, { graph, rungs });
      const final = out[out.length - 1];
      const verdict = final.ok ? (final.rung === 1 ? 'OK' : `OK via rung ${final.rung}`) : `FAIL (every rung) first="${out[0].error}"`;
      console.log(`${shape.padEnd(8)} ${String(n).padStart(5)}t ${String(edges.length).padStart(6)}r ${strategy.padEnd(5)}->${resolved.padEnd(5)}  ${verdict}  ${out.map((a) => `r${a.rung}:${a.ok ? 'ok' : 'x'}${a.ms}ms`).join(' ')}`);
      if (!final.ok && process.env.REPRO_STACK) for (const a of out) console.log(`    r${a.rung} ${a.error}\n      ${a.stack.join('\n      ')}`);
    }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(2); });
