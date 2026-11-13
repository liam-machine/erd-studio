// FIX PROTOTYPE (stage 1, not product code): raw ELK rung 1 on generated diagrams, as today (raw),
// with every edge oriented along one order consistent with the partitions (orient), or with
// ELK DEPTH_FIRST cycle breaking (dfs).  node scripts/repro-layout-stack/proto-orient.cjs twoway 15 28 200 orient
// Prototype fix check: orient every edge along one total order consistent with the partitions
// (partition, then SCC-condensation topological order), or try ELK DEPTH_FIRST cycle breaking.
const R = __dirname + '/';
const ELK = require(R + 'elkShim.cjs');
const L = require(R + '.out/layout.cjs');
const { generate } = require(R + 'run.cjs');
function sccOrder(ids, edges) { // iterative Tarjan; returns map id -> topo index of its SCC (sources first)
  const adj = new Map(ids.map((i) => [i, []])); for (const e of edges) if (adj.has(e.source) && adj.has(e.target)) adj.get(e.source).push(e.target);
  let index = 0; const idx = new Map(), low = new Map(), on = new Set(), st = [], comp = new Map(); let c = 0;
  for (const root of ids) { if (idx.has(root)) continue;
    const work = [[root, 0]]; idx.set(root, index); low.set(root, index); index++; st.push(root); on.add(root);
    while (work.length) { const top = work[work.length - 1]; const [v, i] = top; const nb = adj.get(v);
      if (i < nb.length) { top[1]++; const w = nb[i];
        if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; st.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w))); }
      else { work.pop(); if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
        if (low.get(v) === idx.get(v)) { let w; do { w = st.pop(); on.delete(w); comp.set(w, c); } while (w !== v); c++; } } } }
  return new Map([...comp].map(([k, v]) => [k, c - 1 - v])); // Tarjan emits SCCs in reverse topological order
}
(async () => {
  const [shape, n, m, seeds, mode] = process.argv.slice(2);
  let fail = 0;
  for (let s = 1; s <= Number(seeds); s++) {
    const { nodes, edges } = generate(shape, Number(n), Number(m), s);
    const part = L.computeDepthPartitions(nodes, edges);
    const opts = { ...L.DEFAULT_ELK_OPTIONS, 'elk.partitioning.activate': 'true', ...L.buildLayoutOptions({ partitionStrategy: 'auto', layerBound: 5, direction: 'RIGHT', spacing: 'M' }, nodes.length) };
    let elkEdges = edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }));
    if (mode === 'orient') {
      const topo = sccOrder(nodes.map((x) => x.id), edges); const pos = new Map(nodes.map((x, i) => [x.id, i]));
      const key = (id) => [part.get(id), topo.get(id), pos.get(id)];
      const less = (a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i]; return false; };
      elkEdges = edges.map((e) => (e.source === e.target || less(e.source, e.target)) ? { id: e.id, sources: [e.source], targets: [e.target] } : { id: e.id, sources: [e.target], targets: [e.source] });
    }
    if (mode === 'dfs') opts['elk.layered.cycleBreaking.strategy'] = 'DEPTH_FIRST';
    try { await new ELK().layout({ id: 'root', layoutOptions: opts, children: L.toElkChildren(nodes, part), edges: elkEdges }); }
    catch (e) { fail++; if (fail < 4) console.log(`  seed ${s}: ${e.message}`); }
  }
  console.log(`${shape} ${n}/${m} mode=${mode}: ${fail}/${seeds} failed`);
})();
