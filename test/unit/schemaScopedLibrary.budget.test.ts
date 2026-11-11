/**
 * The library keyed by table identity (`schemaScopedNames`) on the shape of
 * the project that asked for it: 869 tables in one layer across 15 schema
 * folders, most names repeated in several folders, every Ref written with
 * its schema qualifier and a `use` line per table (as ERD Studio writes
 * them). Owner decision (D) on performance: identities, library references
 * and Ref-end resolution come from maps built once per listing, so the work
 * stays what the old rule did — each table file read at most once, and a
 * diagram's tables read without the rest of the library.
 *
 * Counts first (they do not drift on a slow runner), then a wall-clock
 * budget with the margin `dbmlPerformance.test.ts` uses (3×, 8× on CI).
 * `DBML_PERF_LOG=1` prints every count and time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire, syncBuiltinESMExports } from 'module';

import { TableLibraryService } from '../../src/services/logicalModelService';
import { relationshipsImportsFor } from '../../src/services/dbmlRelationshipsIndex';
import type { TableId } from '../../src/types/tableId';

const SCHEMAS = 15;
const TABLES = 869;
/** The pool names are drawn from: 869 tables over 100 names, so most names are in eight or nine schema folders. */
const NAMES = 100;
const MARGIN = process.env.CI ? 8 : 3;
const LOG = Boolean(process.env.DBML_PERF_LOG);

const schemaOf = (k: number): string => `s${String(k).padStart(2, '0')}`;
const nameOf = (n: number): string => `t${String(n).padStart(3, '0')}`;

/** Each schema folder's tables, by name index: 58 a folder (57 in the last), each folder starting at another point of the pool. */
function tablesOf(k: number): number[] {
  const count = k < SCHEMAS - 1 ? 58 : TABLES - 58 * (SCHEMAS - 1);
  return Array.from({ length: count }, (_, j) => (k * 13 + j) % NAMES);
}

let root: string;
let semantic: string;
const ids: TableId[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-schema-scoped-budget-'));
  semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(path.join(semantic, 'bronze', 'relationships'), { recursive: true });
  fs.writeFileSync(path.join(semantic, 'layers.json'), JSON.stringify({ schemaVersion: 1, layers: [{ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 1 }] }));
  for (let k = 0; k < SCHEMAS; k++) {
    const schema = schemaOf(k);
    const dir = path.join(semantic, 'bronze', 'tables', schema);
    fs.mkdirSync(dir, { recursive: true });
    const names = tablesOf(k).map(nameOf);
    for (const name of names) {
      fs.writeFileSync(path.join(dir, `${name}.dbml`), `Table ${schema}.${name} {\n  id INT [pk]\n  a_id INT\n  b_id INT\n  label VARCHAR\n}\n`);
      ids.push({ schema, name });
    }
    // Each table points at the next two of its folder: Refs of one name in every folder that has it.
    const uses = names.map((n) => `use { table ${schema}.${n} } from '../tables/${schema}/${n}.dbml'`);
    const refs = names.flatMap((n, j) => [
      `Ref: ${schema}.${n}.a_id > ${schema}.${names[(j + 1) % names.length]}.id`,
      `Ref: ${schema}.${n}.b_id > ${schema}.${names[(j + 2) % names.length]}.id`,
    ]);
    fs.writeFileSync(path.join(semantic, 'bronze', 'relationships', `${schema}.dbml`), `// ERD Studio relationships: Refs only.\n${uses.join('\n')}\n\n${refs.join('\n')}\n`);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const library = (): TableLibraryService => new TableLibraryService(root, '.erd-studio', undefined, { schemaScopedNames: true });

// Table file reads, counted through the module object the services read with.
const cjsFs = createRequire(__filename)('fs') as typeof fs;
const realReadFileSync = cjsFs.readFileSync;

function measure<T>(label: string, budgetMs: number, fn: () => T): { result: T; tableReads: number; maxReadsOfOneFile: number } {
  const perFile = new Map<string, number>();
  (cjsFs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...args: unknown[]) {
    const p = String(args[0]).split(path.sep).join('/');
    if (/\/bronze\/tables\//.test(p)) perFile.set(p, (perFile.get(p) ?? 0) + 1);
    return (realReadFileSync as (...a: unknown[]) => unknown).apply(this, args);
  };
  syncBuiltinESMExports();
  const start = performance.now();
  let result: T;
  try {
    result = fn();
  } finally {
    (cjsFs as { readFileSync: unknown }).readFileSync = realReadFileSync;
    syncBuiltinESMExports();
  }
  const elapsed = performance.now() - start;
  const tableReads = [...perFile.values()].reduce((a, b) => a + b, 0);
  const maxReadsOfOneFile = Math.max(0, ...perFile.values());
  if (LOG || elapsed > budgetMs) {
    console.warn(`[schemaScopedLibrary] ${label}: ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, fails above ${MARGIN}×), ${tableReads} table reads, at most ${maxReadsOfOneFile} of one file`);
  }
  expect(elapsed, `${label} took ${elapsed.toFixed(0)} ms (budget ${budgetMs} ms, ${MARGIN}× margin)`).toBeLessThanOrEqual(budgetMs * MARGIN);
  return { result, tableReads, maxReadsOfOneFile };
}

describe(`${TABLES} tables in ${SCHEMAS} schema folders, names repeated across them, told apart by identity`, () => {
  it('the listing, every library reference and every lookup by text, from the listing alone', () => {
    const lib = library();
    const { result, tableReads } = measure('list and resolve', 150, () => {
      const entries = lib.listTableFiles();
      const refs = ids.map((id) => lib.libraryRef(id)!);
      const resolved = refs.map((ref) => lib.resolveLibraryRef(ref));
      const bare = Array.from({ length: NAMES }, (_, n) => lib.resolveLibraryRef(nameOf(n)));
      return { entries, refs, resolved, bare };
    });
    expect(tableReads).toBe(0);
    expect(result.entries.filter((e) => !e.shadowedBy)).toHaveLength(TABLES);
    // Every name is in more than one folder: every reference is qualified, and resolves to its own table.
    expect(result.refs.every((ref, i) => ref === `${ids[i].schema}.${ids[i].name}`)).toBe(true);
    expect(result.resolved.every((m, i) => m.kind === 'found' && m.entry.id!.schema === ids[i].schema && m.entry.id!.name === ids[i].name)).toBe(true);
    expect(result.bare.every((m) => m.kind === 'ambiguous')).toBe(true);
  });

  it('every table with its relationships: each file read once, each Ref on its own schema\'s tables', () => {
    const lib = library();
    const { result, tableReads, maxReadsOfOneFile } = measure('listTables (the whole library attached)', 600, () => lib.listTables());
    expect(tableReads).toBe(TABLES);
    expect(maxReadsOfOneFile).toBe(1);
    expect(result).toHaveLength(TABLES);
    for (const model of result) {
      expect(model.relationships, `${model.schema}.${model.name}`).toHaveLength(2);
      for (const r of model.relationships ?? []) expect(r.toModel.startsWith(`${model.schema}.`), `${model.schema}.${model.name} > ${r.toModel}`).toBe(true);
    }
  });

  it('a 300-table diagram\'s tables read with their own Refs, without the whole library', () => {
    const members = ids.slice(0, 300);
    const whole = library();
    const expected = members.map((id) => whole.getTable(id)?.relationships);
    const lib = library();
    const { result, tableReads, maxReadsOfOneFile } = measure('a diagram\'s tables, scoped', 500, () =>
      lib.readingTables(members.map((id) => id.name), () => members.map((id) => lib.getTable(id)?.relationships)));
    expect(result).toEqual(expected);
    expect(maxReadsOfOneFile).toBe(1);
    // Its members' names and the other ends of their Refs: most of the library here (most names are in most folders), never more.
    expect(tableReads).toBeLessThanOrEqual(TABLES);
  });

  it('the relationships index by identity: build, a placement per table and imports for 50 diagrams', () => {
    const lib = library();
    lib.listTables();
    const { result } = measure('index, placements and imports', 400, () => {
      const index = lib.relationshipsIndex();
      const placed = lib.newRelationshipPlacements(ids);
      const imports = Array.from({ length: 50 }, (_, i) => relationshipsImportsFor(ids.slice(i * 17, i * 17 + 40), index));
      return { index, placed, imports };
    });
    expect(result.index.refs).toHaveLength(TABLES * 2);
    expect(result.index.refs.every((r) => r.ownerId?.split('/')[0] === r.targetId?.split('/')[0])).toBe(true);
    // Each table's new Ref goes to its own schema's file (rule 1, counted by identity).
    for (const id of ids) {
      expect(result.placed.get(`${id.schema}/${id.name}`)?.file).toBe(path.join(semantic, 'bronze', 'relationships', `${id.schema}.dbml`));
    }
    expect(result.imports.every((files) => files.length >= 1 && files.length <= 3)).toBe(true);
  });

  it('one relationships file for the layer (where new Refs go by default): every `use` line and Ref in it, still linear', () => {
    // The same tables and Refs, moved into `bronze/relationships/bronze.dbml`: 869 `use` lines and
    // 1,738 Refs in one file. Each Ref end finds its `use` line from a map built once per file; a
    // scan of the file's `use` lines per end made this quadratic.
    const dir = path.join(semantic, 'bronze', 'relationships');
    const files = fs.readdirSync(dir).map((f) => path.join(dir, f));
    const texts = files.map((f) => fs.readFileSync(f, 'utf-8'));
    const lines = texts.flatMap((t) => t.split('\n'));
    try {
      for (const f of files) fs.rmSync(f);
      fs.writeFileSync(path.join(dir, 'bronze.dbml'), [...lines.filter((l) => l.startsWith('use ')), '', ...lines.filter((l) => l.startsWith('Ref:')), ''].join('\n'));
      for (const scopedNames of [false, true]) {
        const lib = new TableLibraryService(root, '.erd-studio', undefined, { schemaScopedNames: scopedNames });
        lib.listTables();
        const { result } = measure(`the index over one layer file (schemaScopedNames ${scopedNames})`, 150, () => lib.relationshipsIndex());
        expect(result.refs).toHaveLength(TABLES * 2);
      }
    } finally {
      fs.rmSync(path.join(dir, 'bronze.dbml'));
      files.forEach((f, i) => fs.writeFileSync(f, texts[i]));
    }
  });
});
