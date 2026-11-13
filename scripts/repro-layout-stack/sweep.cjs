// REPRO helper: how often the toolbar's Auto grouping (depth partitions)
// overflows on generated diagrams, through the real runElkLayout (fallbacks
// included). Prints each failing seed.
//   node scripts/repro-layout-stack/sweep.cjs <shape> <tables> <rels> <seeds> [strategy=auto]
const path = require('node:path');
const { runOne } = require('./run.cjs');
(async () => {
  const [shape = 'twoway', n = '130', m = '80', seeds = '50', strategy = 'auto'] = process.argv.slice(2);
  let fail = 0;
  const t0 = Date.now();
  for (let s = 1; s <= Number(seeds); s++) {
    const r = await runOne(shape, Number(n), Number(m), strategy, s);
    if (!r.ok) { fail++; console.log(`seed ${s}: ${r.error} [${r.failure}${r.exhausted ? `, every fallback failed, last=${r.lastFailure}` : ''}] bands=${r.bands}`); }
  }
  console.log(`${shape} ${n}t/${m}r ${strategy}: ${fail}/${seeds} failed (${Date.now() - t0}ms)`);
})();
