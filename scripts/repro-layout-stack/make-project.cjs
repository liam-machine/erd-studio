#!/usr/bin/env node
/*
 * Writes a native-DBML ERD Studio project (no dbt) with one diagram of
 * generated tables and relationships, for filming Auto Layout in a real VS Code
 * window. Write it OUTSIDE the repo (opening a diagram writes its layout).
 *
 *   node scripts/repro-layout-stack/make-project.cjs <outDir> [shape=gerhard8] [tables] [rels] [seed=1]
 *
 * shape: gerhard8 (the 8-table / 14-relationship diagram that overflowed on
 * every rung before the fix: two two-way pairs and parallel FKs), or any
 * run.cjs shape (twoway, random, chain, ...) with a size, e.g. `twoway 130 160 26`
 * or `random 1200 1500` (1,000+ tables goes to the grid).
 */
const fs = require('node:fs');
const path = require('node:path');
const { generate } = require('./run.cjs');

const [outDir, shape = 'gerhard8', n = '130', m = '160', seed = '1'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: make-project.cjs <outDir> [shape] [tables] [rels] [seed]');
  process.exit(2);
}

let tables;
let rels;
if (shape === 'gerhard8') {
  tables = Array.from({ length: 8 }, (_, i) => `t${i}`);
  rels = '7>3 3>7 4>0 3>2 1>0 0>1 3>1 6>0 5>1 3>2 1>0 6>2 1>0 1>0'.split(' ').map((p) => p.split('>').map((x) => `t${x}`));
} else {
  const g = generate(shape, Number(n), Number(m), Number(seed));
  tables = g.nodes.map((x) => x.id);
  rels = g.edges.map((e) => [e.source, e.target]);
}

const base = path.resolve(outDir, '.erd-studio');
const dirs = ['silver/tables/s', 'silver/relationships', 'silver/diagrams'].map((d) => path.join(base, d));
for (const d of dirs) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(base, 'layers.json'), JSON.stringify({
  schemaVersion: 1,
  layers: [{ id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', creatable: true, order: 1 }],
}, null, 2) + '\n');

// Each table: an id key and one FK column per relationship it starts.
const fkCols = new Map(tables.map((t) => [t, []]));
rels.forEach(([s, t], k) => fkCols.get(s).push({ col: `${t}_ref_${k}`, target: t }));
for (const t of tables) {
  const cols = [`  id INT [pk]`, `  name VARCHAR`, ...fkCols.get(t).map((c) => `  ${c.col} INT`)];
  fs.writeFileSync(path.join(base, 'silver/tables/s', `${t}.dbml`), `Table s.${t} {\n${cols.join('\n')}\n}\n`);
}
const uses = tables.map((t) => `use { table s.${t} } from '../tables/s/${t}.dbml'`);
const refs = [];
for (const [s, list] of fkCols) for (const c of list) refs.push(`Ref: s.${s}.${c.col} > s.${c.target}.id`);
fs.writeFileSync(path.join(base, 'silver/relationships/rels.dbml'), `${uses.join('\n')}\n\n${refs.join('\n')}\n`);
const name = shape === 'gerhard8' ? 'two-way-8' : `${shape}-${tables.length}`;
fs.writeFileSync(path.join(base, 'silver/diagrams', `${name}.dbml`), [
  `Project ${name.replace(/-/g, '_')} {`,
  `  Note: '${tables.length} tables, ${rels.length} relationships (${shape}) for the Auto Layout fix'`,
  `  erd_schema_version: '7'`,
  `}`,
  '',
  ...tables.map((t) => `use { table s.${t} } from '../tables/s/${t}.dbml'`),
  `use * from '../relationships/rels.dbml'`,
  '',
].join('\n'));
console.log(`wrote ${tables.length} tables, ${rels.length} relationships: ${path.join(base, 'silver/diagrams', `${name}.dbml`)}`);
