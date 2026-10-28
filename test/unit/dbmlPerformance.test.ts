/**
 * Performance budgets for reading a large native DBML library (§7.6 of
 * docs/plans/native-dbml-storage.md): a flat library of 10,000 tables and
 * 30,000 Refs in one `tables/_relationships.dbml`. A time over its budget
 * is printed; the test fails above three times the budget (the margin CI
 * needs), which the quadratic reads this guards against exceed many times
 * over. `DBML_PERF_LOG=1` prints every time.
 *
 * The read budgets hold from S4 (the attachment is computed once per pass
 * and memoised, never rebuilt per table). The relationship-edit budget
 * (plan + `editRelationshipsDbml`, ≤ 3 s) joined with the editor pipeline's
 * DBML writes in S5.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { classifyWatchedSemanticPath } from '../../src/watchers/FileWatcherService';

const TABLES = 10_000;
const REFS_PER_TABLE = 3;

let root: string;

/**
 * The margin the budgets are asserted with (§7.6): a loaded CI runner may be
 * several times slower than a laptop, while the regressions this guards
 * against (a library pass per table) are tens of times slower.
 */
const MARGIN = 3;

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

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-perf-'));
  const dir = path.join(root, '.erd-studio', 'tables');
  fs.mkdirSync(dir, { recursive: true });
  const refs: string[] = ['// ERD Studio relationships.', ''];
  for (let i = 0; i < TABLES; i++) {
    const fks = Array.from({ length: REFS_PER_TABLE }, (_, k) => `  fk${k} INT`).join('\n');
    fs.writeFileSync(path.join(dir, `t${i}.dbml`), `Table t${i} {\n  id INT [pk]\n${fks}\n}\n`);
    for (let k = 0; k < REFS_PER_TABLE; k++) {
      refs.push(`Ref: t${i}.fk${k} >? t${(i + k + 1) % TABLES}.id`);
    }
  }
  fs.writeFileSync(path.join(dir, '_relationships.dbml'), `${refs.join('\n')}\n`);
}, 120_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe(`a flat DBML library of ${TABLES} tables and ${TABLES * REFS_PER_TABLE} Refs (§7.6)`, () => {
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

    // One relationship edit: the library planned (snapshot, attach, one
    // editRelationshipsDbml over the 30,000-Ref file), the file written once.
    const owner = lib.getTable('t42')!;
    owner.relationships = owner.relationships!.slice(1);
    const { writes } = withinBudget('one relationship edit (plan + editRelationshipsDbml)', 3_000, () =>
      lib.planTableWrites({ save: [{ model: owner }] }));
    expect(writes.map((w) => `${w.kind} ${path.basename(w.path)}`)).toEqual(['replace _relationships.dbml']);
    const text = (writes[0] as { text: string }).text;
    expect(text.split('\n').filter((l) => l.startsWith('Ref')).length).toBe(TABLES * REFS_PER_TABLE - 1);
  }, 120_000);

  it('the semantic watcher classifies a burst of one event per table file without listing the library each time', () => {
    const semantic = path.join(root, '.erd-studio');
    const tables = path.join(semantic, 'tables');
    const kinds = withinBudget(`classify ${TABLES} table-file events`, 500, () =>
      Array.from({ length: TABLES }, (_, i) => classifyWatchedSemanticPath(semantic, path.join(tables, `t${i}.dbml`))));
    expect(kinds.every((k) => k === 'table')).toBe(true);
    // The relationships file and a diagram are still told apart.
    expect(classifyWatchedSemanticPath(semantic, path.join(tables, '_relationships.dbml'))).toBe('relationships');
    expect(classifyWatchedSemanticPath(semantic, path.join(semantic, 'gold', 'sales.dbml'))).toBe('domain');
  });
});
