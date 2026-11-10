// Self-tests for record/bigProject.mjs, the 2,000-table project of the scale scene:
//   node --test video/test/bigProject.test.mjs
// (node:test, like pipeline.test.mjs: never part of the root vitest run.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, cardHeight, cardWidth, DIAGRAM, generateBigProject, LAYER, layoutModel } from '../record/bigProject.mjs';

// src/types/naming.ts
const TABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const COLUMN_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

const big = generateBigProject();
const { tables } = buildModel();

test('2,000 tables and about 2,700 relationships by default', () => {
  assert.equal(big.stats.tables, 2000);
  assert.ok(big.stats.relationships >= 2700 && big.stats.relationships < 2800, `${big.stats.relationships} relationships`);
  assert.equal(tables.length, 2000);
});

test('--tables is exact at other sizes, with no region copies until the domains run out', () => {
  for (const n of [40, 250, 1000]) assert.equal(buildModel({ tables: n }).tables.length, n);
  assert.ok(!buildModel({ tables: 2000 }).tables.some((t) => /_(emea|apac)$/.test(t.schema)));
  assert.equal(buildModel({ tables: 2600 }).tables.length, 2600);
});

test('deterministic: the same arguments write the same bytes', () => {
  assert.deepEqual(generateBigProject().files, big.files);
  assert.notDeepEqual(generateBigProject({ seed: 8 }).files, big.files);
});

test('names follow the naming rules and are unique case-insensitively', () => {
  const seen = new Set();
  for (const t of tables) {
    assert.match(t.name, TABLE_NAME_PATTERN);
    assert.ok(!seen.has(t.name.toLowerCase()), `duplicate ${t.name}`);
    seen.add(t.name.toLowerCase());
    const cols = new Set();
    for (const c of t.columns) {
      assert.match(c.name, COLUMN_NAME_PATTERN);
      assert.ok(!cols.has(c.name.toLowerCase()), `${t.name}.${c.name} twice`);
      cols.add(c.name.toLowerCase());
    }
  }
});

test('every Ref joins a foreign-key column to the referenced table\'s key', () => {
  const live = new Set(tables);
  for (const t of tables) {
    for (const r of t.refs) {
      assert.ok(live.has(r.to), `${t.name} points at a trimmed table`);
      assert.ok(t.columns.some((c) => c.name === r.column && c.fk), `${t.name}.${r.column}`);
      assert.ok(r.to.columns.some((c) => c.name === r.toColumn && c.pk), `${r.to.name}.${r.toColumn}`);
    }
  }
});

test('the 2.0 layer-first tree, and nothing that would ask to convert or migrate', () => {
  const paths = Object.keys(big.files);
  assert.ok(paths.includes('layers.json') && paths.includes('README.md'));
  for (const p of paths.filter((x) => x.endsWith('.dbml'))) {
    assert.match(p, new RegExp(`^${LAYER}/(tables/[a-z_]+/[A-Za-z0-9_]+|relationships/[a-z_]+|diagrams/${DIAGRAM})\\.dbml$`));
  }
  assert.ok(!paths.some((p) => /\.(ya?ml|json|dbdiagram)$/.test(p) && p !== 'layers.json'), 'no YAML/JSON models or 1.9 layout files');
  assert.ok(!paths.some((p) => p.endsWith('dbt_project.yml')));
  assert.deepEqual(JSON.parse(big.files['layers.json']).layers.map((l) => l.id), [LAYER]);
});

test('use lines: each relationships file names every table its Refs name; the diagram uses every table and file', () => {
  const diagram = big.files[`${LAYER}/diagrams/${DIAGRAM}.dbml`];
  const relFiles = Object.keys(big.files).filter((p) => p.startsWith(`${LAYER}/relationships/`));
  for (const p of relFiles) {
    const text = big.files[p];
    const used = new Set([...text.matchAll(/^use \{ table ([\w.]+) \}/gm)].map((m) => m[1]));
    for (const m of text.matchAll(/^Ref: ([\w]+\.[\w]+)\.\w+ >\? ([\w]+\.[\w]+)\.\w+$/gm)) {
      assert.ok(used.has(m[1]) && used.has(m[2]), `${p}: ${m[0]}`);
    }
    assert.ok(diagram.includes(`use * from '../relationships/${p.split('/').pop()}'`), p);
  }
  const tableUses = [...diagram.matchAll(/^use \{ table (\w+)\.(\w+) \}\s+from '\.\.\/tables\/(\w+)\/(\w+)\.dbml'$/gm)];
  assert.equal(tableUses.length, 2000);
  for (const m of tableUses) assert.ok(m[1] === m[3] && m[2] === m[4], m[0]);
  const refs = relFiles.reduce((n, p) => n + (big.files[p].match(/^Ref: /gm) ?? []).length, 0);
  assert.equal(refs, big.stats.relationships);
});

test('every table is positioned in erd_layout, sorted, and no two cards overlap', () => {
  const diagram = big.files[`${LAYER}/diagrams/${DIAGRAM}.dbml`];
  const block = diagram.slice(diagram.indexOf("erd_layout: '''") + 15, diagram.lastIndexOf("'''"));
  const lines = block.trim().split('\n').map((l) => l.trim().split(' '));
  assert.equal(lines.length, 2000);
  const names = lines.map((l) => l[0]);
  assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  for (const l of lines) assert.ok(Number.isInteger(+l[1]) && Number.isInteger(+l[2]), l.join(' '));

  const { positions } = layoutModel(tables);
  const rects = tables.map((t) => ({ t, ...positions.get(t.name), w: cardWidth(t), h: cardHeight(t) }));
  rects.sort((a, b) => a.x - b.x);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length && rects[j].x < rects[i].x + rects[i].w; j++) {
      const a = rects[i], b = rects[j];
      assert.ok(!(a.y < b.y + b.h && b.y < a.y + a.h), `${a.t.name} overlaps ${b.t.name}`);
    }
  }
});

test('a focus table for the zoom and the hover', () => {
  assert.ok(big.stats.focus && big.stats.focus.lines >= 4, JSON.stringify(big.stats.focus));
  assert.match(big.stats.focus.table, /^fct_/);
});

test('--fit lays it out to show whole at the least zoom in that canvas (the README tour: 1390 x 475)', () => {
  const fit = generateBigProject({ fit: { width: 1390, height: 475 } });
  assert.equal(fit.stats.fit.fits, true, JSON.stringify(fit.stats.extent));
  assert.ok(fit.stats.extent.width <= 27500 && fit.stats.extent.height <= 9300, JSON.stringify(fit.stats.extent));
  // Same tables and relationships as the default layout; only the positions differ.
  const paths = (f) => Object.keys(f.files).filter((p) => !p.includes('/diagrams/')).sort();
  assert.deepEqual(paths(fit), paths(big));
  assert.ok(fit.files[`${LAYER}/tables/ecommerce/fct_site_search.dbml`], 'fct_site_search, which the tour hovers');
});
