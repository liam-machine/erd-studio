/**
 * Performance budgets for reading and editing a large native DBML library in
 * the layer-first tree (ERD Studio 2.0): 10,000 tables in three layers
 * (`<L>/tables/<L>/`), 30,000 Refs, each in its owner's layer default file
 * `<L>/relationships/<L>.dbml` (about 10,000 Refs each), plus one file split
 * out by hand (`gold/relationships/hand.dbml`). A time over its budget is
 * printed; the test fails above three times the budget (eight on CI), which
 * the quadratic reads this guards against exceed many times over.
 * `DBML_PERF_LOG=1` prints every time.
 *
 * The read budgets hold from S4 (the attachment is computed once per pass
 * and memoised, never rebuilt per table). The placement (decision 5, over
 * the index of every relationships file) and the one-relationship-add
 * budgets are S6b's: an add plans against the whole library and rewrites
 * the one file that holds the owner's Refs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { placeNewRef } from '../../src/services/dbmlRelationshipsIndex';
import { classifyWatchedSemanticPath } from '../../src/watchers/FileWatcherService';

const TABLES = 10_000;
const REFS_PER_TABLE = 3;
const LAYERS = ['bronze', 'silver', 'gold'] as const;
/** Tables whose Refs were split out of gold's default file by hand. */
const HAND_SPLIT = 30;

let root: string;

/**
 * The margin the budgets are asserted with (§7.6): a loaded CI runner may be
 * several times slower than a laptop (GitHub's ubuntu runner read the cold
 * library at 3.5× the budget), while the regressions this guards against (a
 * library pass per table) are tens of times slower. So 3× locally, 8× on CI.
 */
const MARGIN = process.env.CI ? 8 : 3;

/** Run `fn`, print its time when it exceeds `budgetMs`, assert it within {@link MARGIN}× the budget, and return its result. */
function withinBudget<T>(label: string, budgetMs: number, fn: () => T): T {
  const start = performance.now();
  const result = fn();
  const elapsed = performance.now() - start;
  if (elapsed > budgetMs || process.env.DBML_PERF_LOG) {
    console.warn(`[dbmlPerformance] ${label}: ${elapsed.toFixed(0)} ms, budget ${budgetMs} ms (${(elapsed / budgetMs).toFixed(1)}× the budget; fails above ${MARGIN}×)`);
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, ${MARGIN}× margin)`).toBeLessThanOrEqual(budgetMs * MARGIN);
  return result;
}

const layerOf = (i: number): string => LAYERS[i % LAYERS.length];
const tablePath = (i: number): string => `${layerOf(i)}/tables/${layerOf(i)}/t${i}.dbml`;
/** Every Ref of table `i` is in its layer's default file, but the first HAND_SPLIT gold tables', which are in hand.dbml. */
const refsFileOf = (i: number): string => (layerOf(i) === 'gold' && i < HAND_SPLIT * LAYERS.length ? 'gold/relationships/hand.dbml' : `${layerOf(i)}/relationships/${layerOf(i)}.dbml`);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-perf-'));
  const sem = path.join(root, '.erd-studio');
  for (const l of LAYERS) {
    fs.mkdirSync(path.join(sem, l, 'tables', l), { recursive: true });
    fs.mkdirSync(path.join(sem, l, 'relationships'), { recursive: true });
  }
  fs.writeFileSync(path.join(sem, 'layers.json'), JSON.stringify({
    schemaVersion: 1,
    layers: LAYERS.map((id, order) => ({ id, label: id, abbreviation: id.slice(0, 3).toUpperCase(), color: '#a0a0a0', creatable: true, order })),
  }));
  const files = new Map<string, { uses: Set<number>; refs: string[] }>();
  for (let i = 0; i < TABLES; i++) {
    const fks = Array.from({ length: REFS_PER_TABLE }, (_, k) => `  fk${k} INT`).join('\n');
    fs.writeFileSync(path.join(sem, tablePath(i)), `Table ${layerOf(i)}.t${i} {\n  id INT [pk]\n${fks}\n}\n`);
    const file = refsFileOf(i);
    const entry = files.get(file) ?? { uses: new Set<number>(), refs: [] };
    files.set(file, entry);
    for (let k = 0; k < REFS_PER_TABLE; k++) {
      const to = (i + k + 1) % TABLES;
      entry.uses.add(i).add(to);
      entry.refs.push(`Ref: ${layerOf(i)}.t${i}.fk${k} >? ${layerOf(to)}.t${to}.id`);
    }
  }
  for (const [file, { uses, refs }] of files) {
    const lines = [...uses].sort((a, b) => a - b)
      .map((i) => `use { table ${layerOf(i)}.t${i} } from '${path.posix.relative(path.posix.dirname(file), tablePath(i))}'`);
    fs.writeFileSync(path.join(sem, file), `// ERD Studio relationships: Refs only.\n${lines.join('\n')}\n\n${refs.join('\n')}\n`);
  }
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe(`a layer-first DBML library of ${TABLES} tables and ${TABLES * REFS_PER_TABLE} Refs (three default files and one split by hand)`, () => {
  it('reads every table, every relationships file and attaches within budget, then serves a 50-table canvas load', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    const tables = withinBudget('read and attach (cold)', 5_000, () => lib.listTables());
    expect(tables).toHaveLength(TABLES);
    expect(tables.every((t) => t.relationships?.length === REFS_PER_TABLE)).toBe(true);

    // A canvas load: every member read, plus the library listing the canvas
    // payload and the relationship survey ask for.
    withinBudget('canvas load of a 50-table diagram (warm)', 3_000, () => {
      for (let i = 0; i < 50; i++) expect(lib.getTable(`t${i * 7}`)?.relationships).toHaveLength(REFS_PER_TABLE);
      lib.listTables();
    });

    // A second listTables is linear, not one library pass per table.
    withinBudget('listTables (warm)', 2_000, () => lib.listTables());
  }, 120_000);

  it('places a new Ref by decision 5 over the index of every relationships file within budget', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    // Cold, the index is built from the planner's snapshot, which reads every table file as well (S6a).
    const index = withinBudget('the relationships index (cold: every table and relationships file read)', 6_000, () => lib.relationshipsIndex());
    expect(index.files).toEqual(['bronze/relationships/bronze.dbml', 'gold/relationships/gold.dbml', 'gold/relationships/hand.dbml', 'silver/relationships/silver.dbml']);
    expect(index.refs).toHaveLength(TABLES * REFS_PER_TABLE);
    const placements = withinBudget('1,000 placements', 500, () =>
      Array.from({ length: 1_000 }, (_, k) => placeNewRef({ table: `t${k}`, layer: layerOf(k) }, index)));
    // Rule 1 everywhere: the file holding the owner's Refs, hand.dbml for the split ones.
    expect(placements.every((p, k) => p.rule === 1 && p.file === refsFileOf(k))).toBe(true);
    expect(placements[2].file).toBe('gold/relationships/hand.dbml');
    expect(placements[92].file).toBe('gold/relationships/gold.dbml');
  }, 120_000);

  it('one relationship add plans against the whole library and rewrites only the file holding the owner\'s Refs, within budget', () => {
    const lib = new TableLibraryService(root, '.erd-studio');
    lib.listTables();
    // t43 is a silver table (its layer's default file), t2 one of gold's split out by hand.
    for (const [table, file] of [['t43', 'silver/relationships/silver.dbml'], ['t2', 'gold/relationships/hand.dbml']] as const) {
      expect(refsFileOf(Number(table.slice(1)))).toBe(file);
      const owner = lib.getTable(table)!;
      owner.columns = [...owner.columns, { name: 'extra', dataType: 'INT', description: '' }];
      owner.relationships = [...owner.relationships!, { fromColumn: 'extra', toModel: 't9999', toColumn: 'id', cardinality: 'many-to-one' }];
      const { writes } = withinBudget(`one relationship add to ${file} (plan + editRelationshipsDbml)`, 3_000, () =>
        lib.planTableWrites({ save: [{ model: owner }] }));
      const rel = (p: string): string => path.relative(path.join(root, '.erd-studio'), p).split(path.sep).join('/');
      expect(writes.map((w) => `${w.kind} ${rel(w.path)}`).sort()).toEqual([`replace ${file}`, `replace ${tablePath(Number(table.slice(1)))}`].sort());
      const text = (writes.find((w) => rel(w.path) === file) as { text: string }).text;
      expect(text).toContain(`Ref: ${layerOf(Number(table.slice(1)))}.${table}.extra >? ${layerOf(9999)}.t9999.id`);
    }
  }, 120_000);

  it('the semantic watcher classifies a burst of one event per table file without listing the library each time', () => {
    const semantic = path.join(root, '.erd-studio');
    const kinds = withinBudget(`classify ${TABLES} table-file events`, 500, () =>
      Array.from({ length: TABLES }, (_, i) => classifyWatchedSemanticPath(semantic, path.join(semantic, ...tablePath(i).split('/')))));
    expect(kinds.every((k) => k === 'table')).toBe(true);
    // The relationships files and a diagram are still told apart.
    expect(classifyWatchedSemanticPath(semantic, path.join(semantic, 'gold', 'relationships', 'gold.dbml'))).toBe('relationships');
    expect(classifyWatchedSemanticPath(semantic, path.join(semantic, 'gold', 'relationships', 'hand.dbml'))).toBe('relationships');
    expect(classifyWatchedSemanticPath(semantic, path.join(semantic, 'gold', 'diagrams', 'sales.dbml'))).toBe('domain');
  });
});
