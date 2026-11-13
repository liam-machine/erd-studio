// REPRO (the reporter, 2026-11-12): run ONE raw ELK layout (no fallbacks) with the
// toolbar's options and print the frames of a stack overflow, grouped by
// function, to show which ELK step recursed.
//   node --stack-size=120 scripts/repro-layout-stack/frames.cjs <shape> <tables> <rels> <strategy> [seed] [rung]
//   REPRO_ELK=full (readable names)  REPRO_FRAMES=<n> (frames to capture, default 80)
Error.stackTraceLimit = Number(process.env.REPRO_FRAMES || 80);
const path = require('node:path');
const layout = require(path.join(__dirname, '.out/layout.cjs'));
const { generate } = require('./run.cjs');
const ELK = require('./elkShim.cjs');

(async () => {
  const [shape = 'reporter', n = '130', m = '80', strategy = 'auto', seed = '1', rung = '1'] = process.argv.slice(2);
  const { nodes, edges } = generate(shape, Number(n), Number(m), Number(seed));
  const options = layout.buildLayoutOptions({ partitionStrategy: strategy, layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length);
  const resolved = strategy === 'auto' ? layout.detectStrategy(nodes, edges) : strategy;
  let partitions = null;
  let base = layout.DEFAULT_ELK_OPTIONS;
  if (resolved === 'depth') { base = { ...base, 'elk.partitioning.activate': 'true' }; partitions = layout.computeDepthPartitions(nodes, edges); }
  if (resolved === 'role') { base = layout.ROLE_AWARE_ELK_OPTIONS; partitions = new Map(nodes.map((x) => [x.id, layout.roleToPartition(x.data.modelRole)])); }
  let merged = { ...base, ...options };
  if (rung !== '1') merged = layout.stackSafeFallbackRungs(merged).find((r) => String(r.rung) === rung).options;
  const graph = {
    id: 'root',
    layoutOptions: merged,
    children: layout.toElkChildren(nodes, partitions),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  };
  const t0 = Date.now();
  try {
    await new ELK().layout(graph);
    console.log(`OK ${Date.now() - t0}ms`);
  } catch (err) {
    console.log(`${err.name}: ${err.message} (${Date.now() - t0}ms)`);
    const lines = String(err.stack).split('\n').slice(1).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*$/, ''));
    console.log(`frames captured: ${lines.length}`);
    console.log('top 20:');
    for (const l of lines.slice(0, 20)) console.log('  ' + l);
    const counts = new Map();
    for (const l of lines) counts.set(l, (counts.get(l) || 0) + 1);
    console.log('most repeated:');
    for (const [l, c] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${String(c).padStart(5)}  ${l}`);
  }
})();
