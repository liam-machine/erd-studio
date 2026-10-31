/**
 * The DBML library write planner in the layer-first tree (2.0 design §2.4,
 * decision 5): table saves, renames, moves and deletes placed in their
 * table files (`<layer>/tables/<schema>/`) and the project's relationships
 * files (`<layer>/relationships/*.dbml`), one write per file. An existing
 * Ref is never moved: it is kept, regenerated or cut in the file that holds
 * it (match 2b included); a NEW Ref goes to the file holding most of its
 * foreign-key table's Refs, else its layer's default file. Links stored
 * twice, a new link already stored, a relationship added while a
 * relationships file does not read, and a relationship from a DBML table to
 * a YAML one (D20) are refused. Pure: a snapshot built from an in-memory
 * map of files.
 */

import { describe, it, expect } from 'vitest';

import { DbmlEditRefused, parseTableDbml, readRelationshipsDbml } from '@erd-studio/core/dbml';
import { DBML_RELATIONSHIPS_FILE_HEADER, attachRelationships, dbmlTableLookup, dbmlTreePathOf } from '@erd-studio/core';
import type { DbmlAttachTable } from '@erd-studio/core';
import { planDbmlLibraryWrites, relationshipsIndexOf } from '../../src/services/dbmlLibraryWrites';
import { changedPairs, pairKey, relationshipsImportsFor } from '../../src/services/dbmlRelationshipsIndex';
import type { RelationshipsIndex } from '../../src/services/dbmlRelationshipsIndex';
import { renameColumnInRelationships } from '../../src/services/libraryRelationships';
import type { DbmlDraftTable, DbmlLibraryOps, DbmlLibrarySnapshot, DbmlSnapshotTable } from '../../src/services/dbmlLibraryWrites';
import type { FileWrite } from '../../src/services/fileWrites';
import type { SemanticTable, TableRelationship } from '../../src/types/semantic';
import { projectDiagnostics } from '../../packages/core/test/dbmlWriterSupport';
import { formatWrittenDbml } from '../../src/services/dbmlWriters';

/** The expected text in the canonical layout ERD Studio writes every .dbml in (every write is formatted). */
function canonical(text: string): string {
  return formatWrittenDbml(text, 'expected.dbml');
}

const HEADER = `${DBML_RELATIONSHIPS_FILE_HEADER}\n`;
const GOLD = 'gold/relationships/gold.dbml';

/** A snapshot of `files` (posix paths relative to the semantic dir → text); `logical-models/*.yml` are YAML tables named by their stem. */
function snapshotOf(files: Record<string, string>): DbmlLibrarySnapshot {
  const tables = new Map<string, DbmlSnapshotTable>();
  const relationshipsFiles = new Map<string, ReturnType<typeof readRelationshipsDbml>>();
  for (const [path, text] of Object.entries(files)) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    if (path.endsWith('.yml')) {
      const name = file.slice(0, -4);
      tables.set(name.toLowerCase(), { name, reference: name, path, storage: 'yaml', folder: '', columns: ['id'], primaryKey: ['id'] });
      continue;
    }
    const tree = dbmlTreePathOf(path);
    if (tree?.kind === 'relationships') {
      relationshipsFiles.set(path, readRelationshipsDbml(text));
      continue;
    }
    if (tree?.kind !== 'table') continue;
    const reading = parseTableDbml(text, file.slice(0, -5), { schemaFolder: tree.schema });
    if (!reading.ok) throw new Error(`fixture ${path} does not read`);
    tables.set(reading.table.name.toLowerCase(), {
      name: reading.table.name,
      reference: reading.declaredReference,
      path,
      storage: 'dbml',
      folder: tree.schema!,
      layer: tree.layer,
      schema: tree.schema!,
      columns: reading.table.columns.map((c) => c.name),
      primaryKey: reading.table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    });
  }
  return {
    semanticDir: '/project/.erd-studio',
    tables,
    relationshipsFiles,
    files: new Set(Object.keys(files)),
    readText: (p) => files[p] ?? null,
  };
}

/** A table as the library reads it, with its relationships attached. */
function modelOf(files: Record<string, string>, name: string): SemanticTable {
  const snap = snapshotOf(files);
  const t = snap.tables.get(name.toLowerCase())!;
  const reading = parseTableDbml(files[t.path], t.path.slice(t.path.lastIndexOf('/') + 1, -5), { schemaFolder: t.schema });
  if (!reading.ok) throw new Error('no table');
  const attachTables: DbmlAttachTable[] = [...snap.tables.values()].map((x) => ({
    table: { name: x.name, columns: x.columns.map((c) => ({ name: c, dataType: '', description: '', ...(x.primaryKey?.includes(c) ? { isPrimaryKey: true } : {}) })) },
    storage: x.storage,
  }));
  const attached = attachRelationships([...snap.relationshipsFiles.entries()].map(([path, r]) => ({ path, reading: r })), dbmlTableLookup(attachTables));
  const rels = attached.byOwner.get(name.toLowerCase());
  return { ...reading.table, ...(rels ? { relationships: rels } : {}) };
}

/** `files` after `writes`. */
function apply(files: Record<string, string>, writes: readonly FileWrite[]): Record<string, string> {
  const out = { ...files };
  for (const w of writes) {
    if (w.kind === 'delete') delete out[w.path];
    else out[w.path] = w.text;
  }
  return out;
}

const pathsOf = (writes: readonly FileWrite[]): string[] => writes.map((w) => `${w.kind} ${w.path}`).sort();
const refLines = (text: string | undefined): string[] => (text ?? '').split('\n').filter((l) => /^Ref\b/.test(l));

/** Every `.dbml` compiles with no diagnostic in any parser. */
function expectClean(files: Record<string, string>): void {
  const dbml = Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.dbml')));
  expect(projectDiagnostics(dbml)).toEqual([]);
}

/** Every live Ref's table pair → the files holding it, as an index reads it. */
function pairsOf(index: RelationshipsIndex): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const ref of index.refs) {
    if (ref.pending) continue;
    const key = pairKey(ref.owner, ref.target);
    out[key] = [...new Set([...(out[key] ?? []), ref.file])].sort();
  }
  return out;
}

/** Plan `ops`, apply the writes, and check the plan's after-index against a re-read of the result (§2.4 step 6). */
function run(files: Record<string, string>, ops: DbmlLibraryOps) {
  const plan = planDbmlLibraryWrites(snapshotOf(files), ops);
  const after = apply(files, plan.writes);
  expect(pairsOf(plan.afterIndex)).toEqual(pairsOf(relationshipsIndexOf(snapshotOf(after))));
  return { plan, after };
}

const M21 = (fromColumn: string, toModel: string, toColumn: string, extra: Partial<TableRelationship> = {}): TableRelationship =>
  ({ fromColumn, toModel, toColumn, cardinality: 'many-to-one', ...extra });

function base(): Record<string, string> {
  return {
    'silver/tables/calendar/dim_date.dbml': 'Table calendar.dim_date {\n  date_key INT [pk]\n}\n',
    'gold/tables/gold/fct_order.dbml': 'Table gold.fct_order {\n  id INT [pk]\n  date_key INT\n  customer_key INT\n  ship_date_key INT\n}\n',
    'gold/tables/gold/dim_customer.dbml': 'Table gold.dim_customer {\n  customer_key INT [pk]\n  date_key INT\n}\n',
    [GOLD]: `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\n`
      + 'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key\nRef: gold.fct_order.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me\n',
  };
}

const visit = (relationships: TableRelationship[] = [M21('date_key', 'dim_date', 'date_key')]): SemanticTable => ({
  name: 'fct_visit',
  columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'date_key', dataType: 'INT', description: '' }],
  relationships,
});

describe('each op kind: one write per file', () => {
  it('a column-only save writes the table file only', () => {
    const files = base();
    const model = modelOf(files, 'fct_order');
    model.columns.push({ name: 'amount', dataType: 'DECIMAL', description: '' });
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/tables/gold/fct_order.dbml']);
    expect(plan.pathChanged.size).toBe(0);
    expect(plan.createdRelationshipsFiles).toEqual([]);
    expect(plan.changedPairs.size).toBe(0);
    expect(after['gold/tables/gold/fct_order.dbml']).toMatch(/^Table gold\.fct_order \{/);
    expectClean(after);
  });

  it('a relationship removed is cut from the file holding it, nothing else written', () => {
    const files = base();
    const model = modelOf(files, 'fct_order');
    model.relationships = model.relationships!.filter((r) => r.toModel !== 'dim_customer');
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual([`replace ${GOLD}`]);
    expect(after[GOLD]).toBe(canonical(`${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me\n`));
    expect(plan.changedPairs).toEqual(new Set([pairKey('fct_order', 'dim_customer')]));
    expectClean(after);
  });

  it('a new table goes to <layer>/tables/<layer>/, and its first Ref to the layer\'s default file, created', () => {
    const files = base();
    const { plan, after } = run(files, { save: [{ model: visit() }], newTableHome: { layer: 'silver', schema: 'silver' } });
    expect(pathsOf(plan.writes)).toEqual(['create silver/relationships/silver.dbml', 'create silver/tables/silver/fct_visit.dbml']);
    expect(plan.createdRelationshipsFiles).toEqual(['silver/relationships/silver.dbml']);
    expect(plan.createdTables).toEqual(['fct_visit']);
    expect(after['silver/tables/silver/fct_visit.dbml']).toMatch(/^Table silver\.fct_visit \{/);
    expect(after['silver/relationships/silver.dbml']).toBe(canonical(`${HEADER}use { table calendar.dim_date } from '../tables/calendar/dim_date.dbml'\nuse { table silver.fct_visit } from '../tables/silver/fct_visit.dbml'\n\nRef: silver.fct_visit.date_key >? calendar.dim_date.date_key\n`));
    expect(plan.resolveTable('FCT_VISIT')).toMatchObject({ name: 'fct_visit', reference: 'silver.fct_visit', path: 'silver/tables/silver/fct_visit.dbml', storage: 'dbml' });
    expectClean(after);
  });

  it('a delete removes the file, the Refs it owns and its use lines; the file stays (D15)', () => {
    const files = base();
    const { plan, after } = run(files, { delete: ['fct_order'] });
    expect(pathsOf(plan.writes)).toEqual(['delete gold/tables/gold/fct_order.dbml', `replace ${GOLD}`]);
    expect(plan.pathChanged).toEqual(new Map([['fct_order', null]]));
    expect(after[GOLD]).toBe(canonical(HEADER));
    expect(plan.resolveTable('fct_order')).toBeUndefined();
    expect(plan.fileExists('gold/tables/gold/fct_order.dbml')).toBe(false);
  });

  it('a rename (save with fromName + delete of the old name) re-spells the Refs in place, never drops them', () => {
    const files = base();
    const model = { ...modelOf(files, 'fct_order'), name: 'fct_sale' };
    const { plan, after } = run(files, { save: [{ model, fromName: 'fct_order' }], delete: ['fct_order'] });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/gold/fct_sale.dbml', 'delete gold/tables/gold/fct_order.dbml', `replace ${GOLD}`]);
    expect(after['gold/tables/gold/fct_sale.dbml']).toMatch(/^Table gold\.fct_sale \{/);
    expect(refLines(after[GOLD])).toEqual([
      'Ref: gold.fct_sale.customer_key >? gold.dim_customer.customer_key',
      'Ref: gold.fct_sale.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me',
    ]);
    expect(after[GOLD]).toMatch(/^use \{ table gold\.fct_sale \} +from '\.\.\/tables\/gold\/fct_sale\.dbml'$/m);
    expect(after[GOLD]).not.toContain('fct_order');
    expect(plan.pathChanged).toEqual(new Map([['fct_order', 'gold/tables/gold/fct_sale.dbml']]));
    expectClean(after);
  });

  it('a refusal passes through (a table file holding a use line is not rewritten)', () => {
    const files = { ...base(), 'gold/tables/gold/dim_customer.dbml': "use { table calendar.dim_date } from '../../../../silver/tables/calendar/dim_date.dbml'\nTable gold.dim_customer {\n  customer_key INT [pk]\n}\n" };
    const model = modelOf(files, 'dim_customer');
    model.description = 'Customers';
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(DbmlEditRefused);
  });
});

describe('the partition, in place (§2.4 step 3)', () => {
  /** fct_order's Refs split by hand: two in gold.dbml, one in dates.dbml. */
  function split(): Record<string, string> {
    const files = base();
    files['gold/tables/gold/dim_region.dbml'] = 'Table gold.dim_region {\n  region_key INT [pk]\n}\n';
    files['gold/tables/gold/fct_order.dbml'] = 'Table gold.fct_order {\n  id INT [pk]\n  date_key INT\n  customer_key INT\n  ship_date_key INT\n  region_key INT\n}\n';
    files[GOLD] = `${HEADER}use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.dim_region } from '../tables/gold/dim_region.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\n`
      + 'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key\nRef: gold.fct_order.region_key >? gold.dim_region.region_key\n';
    files['gold/relationships/dates.dbml'] = `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\n`
      + 'Ref: gold.fct_order.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me\n';
    return files;
  }

  it('one owner across two files: a removal and an add in the file with most of its Refs, a regenerate in the other', () => {
    const files = split();
    const model = modelOf(files, 'fct_order');
    model.relationships = [
      ...model.relationships!.filter((r) => r.toModel !== 'dim_region').map((r) => (r.toModel === 'dim_date' ? { ...r, role: 'order date' } : r)),
      M21('ship_date_key', 'dim_date', 'date_key', { role: 'ship date' }),
    ];
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/relationships/dates.dbml', `replace ${GOLD}`]);
    // dates.dbml: the role change, regenerated in place with its settings and comment.
    expect(refLines(after['gold/relationships/dates.dbml'])).toEqual(['Ref "order date": gold.fct_order.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me']);
    // gold.dbml (2 of fct_order's 3 Refs): dim_region cut, the new Ref added, dim_customer kept.
    expect(refLines(after[GOLD])).toEqual([
      'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key',
      'Ref "ship date": gold.fct_order.ship_date_key >? calendar.dim_date.date_key',
    ]);
    expect(after[GOLD]).toContain("from '../../silver/tables/calendar/dim_date.dbml'");
    expect(after[GOLD]).not.toContain('dim_region }');
    expectClean(after);
  });

  it('the turn-round of a one-to-one stays in the file that held it', () => {
    const files = base();
    files['gold/relationships/hand.dbml'] = `${HEADER}use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key ?- gold.dim_customer.customer_key\n`;
    files[GOLD] = files[GOLD].replace('Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n', '');
    // hand.dbml's Ref is owned by dim_customer (the `?` marks fct_order as the one side); turn it round.
    const customer = modelOf(files, 'dim_customer');
    expect(customer.relationships).toHaveLength(1);
    const order = modelOf(files, 'fct_order');
    customer.relationships = [];
    order.relationships = [...order.relationships!, { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }];
    const { plan, after } = run(files, { save: [{ model: customer }, { model: order }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/relationships/hand.dbml']);
    expect(refLines(after['gold/relationships/hand.dbml'])).toEqual(['Ref: gold.dim_customer.customer_key ?- gold.fct_order.customer_key']);
    expect(after[GOLD]).toBe(files[GOLD]);
    expectClean(after);
  });

  it('rename + add in one plan: the add follows the owner\'s Refs under its name before the plan', () => {
    const files = base();
    // fct_order's Refs live in hand.dbml only; gold.dbml (its layer's default) holds none of them.
    files['gold/relationships/hand.dbml'] = files[GOLD];
    files[GOLD] = HEADER;
    const model = { ...modelOf(files, 'fct_order'), name: 'fct_sale' };
    model.relationships = [...model.relationships!, M21('ship_date_key', 'dim_date', 'date_key', { role: 'ship' })];
    const { plan, after } = run(files, { save: [{ model, fromName: 'fct_order' }], delete: ['fct_order'] });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/gold/fct_sale.dbml', 'delete gold/tables/gold/fct_order.dbml', 'replace gold/relationships/hand.dbml']);
    expect(refLines(after['gold/relationships/hand.dbml'])).toContain('Ref ship: gold.fct_sale.ship_date_key >? calendar.dim_date.date_key');
    expectClean(after);
  });
});

describe('match 2b: a column change stays in its file', () => {
  /** A composite in a hand-split file, and two other Refs of the owner in the layer default (where a new Ref would go). */
  function composite(): Record<string, string> {
    return {
      'gold/tables/gold/ord.dbml': 'Table gold.ord {\n  k1 INT\n  k2 INT\n  k3 INT\n  id INT [pk]\n  code INT [unique]\n  indexes {\n    (k1, k2) [unique]\n    (k1, k2, k3) [unique]\n    k1 [unique]\n  }\n}\n',
      'gold/tables/gold/line.dbml': 'Table gold.line {\n  id INT [pk]\n  k1 INT\n  k2 INT\n  k3 INT\n  ord_id INT\n  a_id INT\n  b_id INT\n}\n',
      'gold/tables/gold/dim_a.dbml': 'Table gold.dim_a {\n  id INT [pk]\n}\n',
      'gold/tables/gold/dim_b.dbml': 'Table gold.dim_b {\n  id INT [pk]\n}\n',
      [GOLD]: `${HEADER}use { table gold.dim_a } from '../tables/gold/dim_a.dbml'\nuse { table gold.dim_b } from '../tables/gold/dim_b.dbml'\nuse { table gold.line } from '../tables/gold/line.dbml'\n\nRef: gold.line.a_id >? gold.dim_a.id\nRef: gold.line.b_id >? gold.dim_b.id\n`,
      'gold/relationships/lines.dbml': `${HEADER}use { table gold.line } from '../tables/gold/line.dbml'\nuse { table gold.ord } from '../tables/gold/ord.dbml'\n\nRef: gold.line.(k1, k2) > gold.ord.(k1, k2) [delete: cascade] // composite\nRef: gold.line.ord_id > gold.ord.id\n`,
    };
  }
  const compositeOf = (files: Record<string, string>): TableRelationship[] => modelOf(files, 'line').relationships!.filter((r) => r.compositeKey);

  it('a composite gaining a column is rewritten in place in its hand-split file, as one Ref (never split), its settings, comment and operator kept', () => {
    const files = composite();
    const model = modelOf(files, 'line');
    const key = compositeOf(files)[0].compositeKey!;
    model.relationships = [...model.relationships!, { fromColumn: 'k3', toModel: 'ord', toColumn: 'k3', cardinality: 'many-to-one', compositeKey: key }];
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/relationships/lines.dbml']);
    expect(refLines(after['gold/relationships/lines.dbml'])).toEqual([
      'Ref: gold.line.(k1, k2, k3) > gold.ord.(k1, k2, k3) [delete: cascade] // composite',
      'Ref: gold.line.ord_id > gold.ord.id',
    ]);
    expect(after[GOLD]).toBe(files[GOLD]);
    expect(modelOf(after, 'line').relationships!.filter((r) => r.compositeKey)).toHaveLength(3);
    expectClean(after);
  });

  it('a composite losing a column stays in its file too', () => {
    const files = composite();
    const model = modelOf(files, 'line');
    model.relationships = model.relationships!.filter((r) => !(r.compositeKey && r.fromColumn === 'k2'));
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/relationships/lines.dbml']);
    expect(refLines(after['gold/relationships/lines.dbml'])).toEqual(['Ref: gold.line.k1 > gold.ord.k1 [delete: cascade] // composite', 'Ref: gold.line.ord_id > gold.ord.id']);
    expectClean(after);
  });

  it('a target-column change (ord.id → ord.code) stays in its file', () => {
    const files = composite();
    const model = modelOf(files, 'line');
    model.relationships = model.relationships!.map((r) => (r.fromColumn === 'ord_id' ? { ...r, toColumn: 'code' } : r));
    const { plan, after } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/relationships/lines.dbml']);
    expect(refLines(after['gold/relationships/lines.dbml'])).toEqual([
      'Ref: gold.line.(k1, k2) > gold.ord.(k1, k2) [delete: cascade] // composite',
      'Ref: gold.line.ord_id > gold.ord.code',
    ]);
    expectClean(after);
  });

  /** The composite and the plain Ref in two files of their own, the composite's first in byte order. */
  function twoFiles(): Record<string, string> {
    const files = composite();
    const lines = files['gold/relationships/lines.dbml'];
    delete files['gold/relationships/lines.dbml'];
    files['gold/relationships/a_comp.dbml'] = lines.replace('Ref: gold.line.ord_id > gold.ord.id\n', '');
    files['gold/relationships/b_ord.dbml'] = lines.replace('Ref: gold.line.(k1, k2) > gold.ord.(k1, k2) [delete: cascade] // composite\n', '');
    return files;
  }

  it('a retarget sharing no column pair still pairs with the Ref sharing its foreign-key column, not the first file', () => {
    const files = twoFiles();
    const model = modelOf(files, 'line');
    model.relationships = model.relationships!.filter((r) => !r.compositeKey).map((r) => (r.fromColumn === 'ord_id' ? { ...r, toColumn: 'code' } : r));
    const { after } = run(files, { save: [{ model }] });
    expect(refLines(after['gold/relationships/a_comp.dbml'])).toEqual([]);
    expect(refLines(after['gold/relationships/b_ord.dbml'])).toEqual(['Ref: gold.line.ord_id > gold.ord.code']);
    expectClean(after);
  });

  it('two column changes in one save keep their own files, whatever order the units are listed in', () => {
    for (const plainFirst of [true, false]) {
      const files = twoFiles();
      const model = modelOf(files, 'line');
      const key = compositeOf(files)[0].compositeKey!;
      const plain = model.relationships!.filter((r) => !r.compositeKey).map((r) => (r.fromColumn === 'ord_id' ? { ...r, toColumn: 'code' } : r));
      const comp = [...compositeOf(files), { fromColumn: 'k3', toModel: 'ord', toColumn: 'k3', cardinality: 'many-to-one' as const, compositeKey: key }];
      model.relationships = plainFirst ? [...plain, ...comp] : [...comp, ...plain];
      const { after } = run(files, { save: [{ model }] });
      expect(refLines(after['gold/relationships/a_comp.dbml'])).toEqual(['Ref: gold.line.(k1, k2, k3) > gold.ord.(k1, k2, k3) [delete: cascade] // composite']);
      expect(refLines(after['gold/relationships/b_ord.dbml'])).toEqual(['Ref: gold.line.ord_id > gold.ord.code']);
      expectClean(after);
    }
  });
});

describe('moves (Organise): the file moves, the Refs never do', () => {
  it('a move to another layer keeps the schema, and re-paths the use lines where the Refs are', () => {
    const files = base();
    const { plan, after } = run(files, { move: [{ name: 'fct_order', toLayer: 'silver' }] });
    expect(pathsOf(plan.writes)).toEqual(['create silver/tables/gold/fct_order.dbml', 'delete gold/tables/gold/fct_order.dbml', `replace ${GOLD}`]);
    expect(after['silver/tables/gold/fct_order.dbml']).toBe(files['gold/tables/gold/fct_order.dbml']);
    expect(refLines(after[GOLD])).toEqual(refLines(files[GOLD]));
    expect(after[GOLD]).toMatch(/^use \{ table gold\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/gold\/fct_order\.dbml'$/m);
    expect(plan.requalified.size).toBe(0);
    expect(plan.pathChanged).toEqual(new Map([['fct_order', 'silver/tables/gold/fct_order.dbml']]));
    expect(plan.changedPairs.size).toBe(0);
    expectClean(after);
  });

  it('a requalifying move re-spells every end and use line naming the table, in every file', () => {
    const files = base();
    files['gold/relationships/dates.dbml'] = `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef ship: gold.fct_order.ship_date_key >? calendar.dim_date.date_key\n`;
    const { plan, after } = run(files, { move: [{ name: 'fct_order', toLayer: 'silver', toSchema: 'sales' }] });
    expect(pathsOf(plan.writes)).toEqual([
      'create silver/tables/sales/fct_order.dbml', 'delete gold/tables/gold/fct_order.dbml', 'replace gold/relationships/dates.dbml', `replace ${GOLD}`,
    ]);
    expect(after['silver/tables/sales/fct_order.dbml']).toMatch(/^Table sales\.fct_order \{/);
    expect(plan.requalified).toEqual(new Set(['fct_order']));
    expect(refLines(after[GOLD])).toEqual([
      'Ref: sales.fct_order.customer_key >? gold.dim_customer.customer_key',
      'Ref: sales.fct_order.date_key >? calendar.dim_date.date_key [delete: cascade] // keep me',
    ]);
    expect(refLines(after['gold/relationships/dates.dbml'])).toEqual(['Ref ship: sales.fct_order.ship_date_key >? calendar.dim_date.date_key']);
    expect(after['gold/relationships/dates.dbml']).toMatch(/^use \{ table sales\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/sales\/fct_order\.dbml'$/m);
    expect(after[GOLD]).toMatch(/^use \{ table sales\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/sales\/fct_order\.dbml'$/m);
    expect(plan.resolveTable('fct_order')).toMatchObject({ reference: 'sales.fct_order', path: 'silver/tables/sales/fct_order.dbml' });
    expectClean(after);
  });

  it('a move whose path differs only in case is refused; so is one onto an existing file', () => {
    // A schema folder listed in another case is reused (§1.2), so only a listing that keeps the spelling asked for gets here.
    const asked = { ...snapshotOf(base()), schemaAsListed: (_layer: string, schema: string) => schema };
    expect(() => planDbmlLibraryWrites(asked, { move: [{ name: 'fct_order', toSchema: 'GOLD' }] }))
      .toThrow('A move that only changes case is not supported; rename the folder by hand.');
    expect(planDbmlLibraryWrites(snapshotOf(base()), { move: [{ name: 'fct_order', toSchema: 'GOLD' }] }).writes).toEqual([]);
    const taken = { ...base(), 'silver/tables/gold/fct_order.dbml': 'Table gold.fct_order {\n  id INT [pk]\n}\n' };
    // The snapshot lists the winner (gold/…); the silver copy is a file the move would overwrite.
    const snapshot = snapshotOf(taken);
    snapshot.tables.set('fct_order', snapshotOf(base()).tables.get('fct_order')!);
    expect(() => planDbmlLibraryWrites(snapshot, { move: [{ name: 'fct_order', toLayer: 'silver' }] })).toThrow(/already exists/);
  });

  it('a stale use line with no Ref naming the table is rewritten on a move and cut on a delete', () => {
    const files = {
      ...base(),
      'gold/relationships/extra.dbml': `${HEADER}use { table gold.fct_order } from '../tables/gold/fct_order.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n`,
    };
    const moved = run(files, { move: [{ name: 'fct_order', toLayer: 'silver' }] });
    expect(moved.after['gold/relationships/extra.dbml']).toMatch(/^use \{ table gold\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/gold\/fct_order\.dbml'$/m);
    expect(moved.after['gold/relationships/extra.dbml']).toMatch(/^use \{ table gold\.dim_customer \} +from '\.\.\/tables\/gold\/dim_customer\.dbml'$/m);
    const deleted = run(files, { delete: ['fct_order'] });
    expect(deleted.after['gold/relationships/extra.dbml']).not.toContain('fct_order');
    expect(deleted.after['gold/relationships/extra.dbml']).toContain('use { table gold.dim_customer }');
  });
});

describe('where a new table goes (§2.4 step 2): the layer from the home, the schema the developer wrote', () => {
  const draft = (name: string, extra: Partial<DbmlDraftTable> = {}): DbmlDraftTable => ({
    name, columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'date_key', dataType: 'INT', description: '' }], ...extra,
  });
  const HOME = { layer: 'gold', schema: 'gold' };

  it('a canvas Add from dbt with the built schema dbt_x and no config.schema lands in gold/tables/gold/', () => {
    const { plan, after } = run(base(), { save: [{ model: draft('stg_x', { schema: 'dbt_x' }) }], newTableHome: HOME });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/gold/stg_x.dbml']);
    expect(after['gold/tables/gold/stg_x.dbml']).toMatch(/^Table gold\.stg_x \{/);
    expect(after['gold/tables/gold/stg_x.dbml']).not.toContain('dbt_x');
  });

  it('config.schema: finance (built as dbt_liam_finance) lands in gold/tables/finance/, as Table finance.<name>, and is never written', () => {
    const { plan, after } = run(base(), { save: [{ model: draft('fct_gl', { schema: 'dbt_liam_finance', configuredSchema: 'finance' }) }], newTableHome: HOME });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/finance/fct_gl.dbml']);
    expect(after['gold/tables/finance/fct_gl.dbml']).toMatch(/^Table finance\.fct_gl \{/);
    expect(after['gold/tables/finance/fct_gl.dbml']).not.toMatch(/dbt_liam|configured/i);
  });

  it('a source raw.tasks whose yml says schema: sap_raw lands in gold/tables/sap_raw/', () => {
    const { plan } = run(base(), { save: [{ model: draft('tasks', { configuredSchema: 'sap_raw' }) }], newTableHome: HOME });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/sap_raw/tasks.dbml']);
  });

  it('Import: Table Sales.x into a layer with sales/ is written Table sales.x in gold/tables/sales/, its use specifiers and Ref ends agreeing', () => {
    const files = { ...base(), 'gold/tables/sales/dim_store.dbml': 'Table sales.dim_store {\n  store_key INT [pk]\n}\n' };
    const model = draft('x', { schema: 'Sales', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'store_key', dataType: 'INT', description: '' }], relationships: [M21('store_key', 'dim_store', 'store_key')] });
    const { plan, after } = run(files, { save: [{ model }], newTableHome: HOME, schemaFromSource: true });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/sales/x.dbml', `replace ${GOLD}`]);
    expect(after['gold/tables/sales/x.dbml']).toMatch(/^Table sales\.x \{/);
    expect(refLines(after[GOLD])).toContain('Ref: sales.x.store_key >? sales.dim_store.store_key');
    expect(after[GOLD]).toMatch(/use \{ table sales\.x \} +from '\.\.\/tables\/sales\/x\.dbml'/);
    expectClean(after);
  });

  it('two new tables in one plan agree on one spelling of a new schema folder', () => {
    const { plan } = run(base(), { save: [{ model: draft('a', { configuredSchema: 'Finance' }) }, { model: draft('b', { configuredSchema: 'finance' }) }], newTableHome: HOME });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/Finance/a.dbml', 'create gold/tables/Finance/b.dbml']);
  });

  it('a schema that cannot be a folder (unrendered dbt jinja, a Windows-reserved character, a slash) falls back to the home\'s', () => {
    for (const configuredSchema of ['{{ target.schema }}', "{{ env_var('DBT_SCHEMA') }}", '{% if x %}a{% endif %}', 'a:b', 'a/b']) {
      const { plan, after } = run(base(), { save: [{ model: draft('a', { configuredSchema }) }], newTableHome: HOME });
      expect(pathsOf(plan.writes)).toEqual(['create gold/tables/gold/a.dbml']);
      expect(after['gold/tables/gold/a.dbml']).toMatch(/^Table gold\.a \{/);
    }
  });
});

describe('a column rename keeps the Ref (Law 4)', () => {
  /** Rename `table.from` → `to` as the editor does: the table's column, its own Refs and every other table's (#126). */
  function renameColumn(files: Record<string, string>, table: string, from: string, to: string) {
    const model = modelOf(files, table);
    model.columns = model.columns.map((c) => (c.name === from ? { ...c, name: to } : c));
    renameColumnInRelationships([model], table, from, to);
    const others = [...snapshotOf(files).tables.values()].filter((t) => t.storage === 'dbml' && t.name !== table).map((t) => modelOf(files, t.name));
    const changed = renameColumnInRelationships(others, table, from, to);
    return run(files, { save: [{ model }, ...changed.map((m) => ({ model: m }))] }).after;
  }

  it('the referenced column: settings, trailing comment and operator keep their bytes', () => {
    const after = renameColumn(base(), 'dim_date', 'date_key', 'day_key');
    expect(refLines(after[GOLD])).toEqual([
      'Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key',
      'Ref: gold.fct_order.date_key >? calendar.dim_date.day_key [delete: cascade] // keep me',
    ]);
    expectClean(after);
  });

  it('the foreign-key column, with a hand-written operator', () => {
    const files = base();
    files[GOLD] = files[GOLD].replace('date_key >? calendar', 'date_key > calendar');
    const after = renameColumn(files, 'fct_order', 'date_key', 'order_date_key');
    expect(after[GOLD]).toContain('\nRef: gold.fct_order.order_date_key > calendar.dim_date.date_key [delete: cascade] // keep me\n');
    expectClean(after);
  });

  it('a Ref whose owner the edit does not list still follows the column', () => {
    const files = base();
    const model = modelOf(files, 'dim_date');
    model.columns = model.columns.map((c) => (c.name === 'date_key' ? { ...c, name: 'day_key' } : c));
    const { after } = run(files, { save: [{ model }] });
    expect(after[GOLD]).toContain('\nRef: gold.fct_order.date_key >? calendar.dim_date.day_key [delete: cascade] // keep me\n');
    expectClean(after);
  });
});

describe('refusals', () => {
  it('a pre-existing duplicate (one link in two files) is still refused when its owner is edited', () => {
    const files = { ...base(), 'gold/relationships/copy.dbml': `${HEADER}use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n` };
    const model = modelOf(files, 'fct_order');
    model.relationships = [...model.relationships!, M21('ship_date_key', 'dim_date', 'date_key')];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow('gold/relationships/copy.dbml and gold/relationships/gold.dbml both hold the relationship dim_customer.customer_key → fct_order.customer_key. Remove one of them first.');
  });

  it('a link stored twice in one file', () => {
    const files = { ...base() };
    files[GOLD] = files[GOLD].replace('// keep me\n', '// keep me\nRef: gold.fct_order.customer_key > gold.dim_customer.customer_key\n');
    const model = modelOf(files, 'fct_order');
    model.relationships = [...model.relationships!.filter((r, i, all) => all.findIndex((x) => x.toModel === r.toModel) === i), M21('ship_date_key', 'dim_date', 'date_key')];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(/holds the relationship .* twice/);
  });

  it('a new link another table\'s Ref already holds, in another file, is refused: edit it there', () => {
    const files = {
      ...base(),
      'gold/relationships/hand.dbml': `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n\nRef: calendar.dim_date.date_key ?- gold.dim_customer.date_key\n`,
    };
    // hand.dbml's one-to-one is owned by dim_customer; dim_date now claims the same link as its own.
    const dim = modelOf(files, 'dim_date');
    expect(dim.relationships).toBeUndefined();
    dim.relationships = [{ fromColumn: 'date_key', toModel: 'dim_customer', toColumn: 'date_key', cardinality: 'one-to-one' }];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: dim }] }))
      .toThrow('gold/relationships/hand.dbml line 5 already holds the relationship dim_customer.date_key → dim_date.date_key; edit it there.');
  });

  it('an unreadable relationships file refuses an add, naming it; a column-description edit still goes through', () => {
    const files = { ...base(), 'silver/relationships/silver.dbml': 'Ref: calendar.dim_date.date_key > \n' };
    const model = modelOf(files, 'fct_order');
    model.relationships = [...model.relationships!, M21('ship_date_key', 'dim_date', 'date_key')];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] }))
      .toThrow('silver/relationships/silver.dbml does not read (Line 2, column 1: Unexpected EOF [1002]); fix it first: it may already hold this relationship.');
    const described = modelOf(files, 'fct_order');
    described.columns[1].description = 'Order day';
    expect(pathsOf(planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: described }] }).writes)).toEqual(['replace gold/tables/gold/fct_order.dbml']);
    // A cardinality change in a readable file goes through too.
    const card = modelOf(files, 'fct_order');
    card.relationships = card.relationships!.map((r) => (r.toModel === 'dim_customer' ? { ...r, cardinality: 'one-to-one' as const } : r));
    expect(pathsOf(planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: card }] }).writes)).toEqual([`replace ${GOLD}`]);
  });

  it('a rename, move, delete or column rename of a table an unreadable file names is refused; one it does not name goes through', () => {
    const conflicted = `${HEADER}<<<<<<< HEAD\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n=======\n>>>>>>> theirs\n`;
    const files = { ...base(), 'gold/relationships/gold.dbml': base()[GOLD].replace(/Ref: gold\.fct_order\.customer_key[^\n]*\n/, ''), 'gold/relationships/hand.dbml': conflicted };
    const snapshot = snapshotOf(files);
    expect(snapshot.relationshipsFiles.get('gold/relationships/hand.dbml')!.readable).toBe(false);
    const refused = /^gold\/relationships\/hand\.dbml does not read \(.*\); fix it first: it may name dim_customer, which this edit (renames|moves|deletes|renames a column of)\.$/;
    const renamed = { ...modelOf(files, 'dim_customer'), name: 'dim_client' };
    expect(() => planDbmlLibraryWrites(snapshot, { save: [{ model: renamed, fromName: 'dim_customer' }], delete: ['dim_customer'] })).toThrow(refused);
    expect(() => planDbmlLibraryWrites(snapshot, { delete: ['dim_customer'] })).toThrow(refused);
    expect(() => planDbmlLibraryWrites(snapshot, { move: [{ name: 'dim_customer', toLayer: 'silver' }] })).toThrow(refused);
    const column = modelOf(files, 'dim_customer');
    column.columns = column.columns.map((c) => (c.name === 'customer_key' ? { ...c, name: 'client_key' } : c));
    expect(() => planDbmlLibraryWrites(snapshot, { save: [{ model: column }] })).toThrow(refused);
    // dim_date is named nowhere in the unreadable file: its rename goes through.
    const date = { ...modelOf(files, 'dim_date'), name: 'dim_day' };
    expect(pathsOf(planDbmlLibraryWrites(snapshot, { save: [{ model: date, fromName: 'dim_date' }], delete: ['dim_date'] }).writes))
      .toEqual(['create silver/tables/calendar/dim_day.dbml', 'delete silver/tables/calendar/dim_date.dbml', `replace ${GOLD}`]);
  });

  it('a relationship from a DBML table to a YAML table (D20)', () => {
    const files = { ...base(), 'logical-models/dim_yaml.yml': 'name: dim_yaml\n' };
    const model = modelOf(files, 'fct_order');
    model.relationships = [...(model.relationships ?? []), { fromColumn: 'id', toModel: 'dim_yaml', toColumn: 'id', cardinality: 'one-to-one' }];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(/dim_yaml is a YAML table.*Convert the project to DBML first/);
  });

  it('`_relationships` is an ordinary table name in the layer-first tree', () => {
    const fresh: SemanticTable = { name: '_relationships', columns: [{ name: 'id', dataType: 'INT', description: '' }] };
    const { plan } = run(base(), { save: [{ model: fresh }], newTableHome: { layer: 'gold', schema: 'gold' } });
    expect(pathsOf(plan.writes)).toEqual(['create gold/tables/gold/_relationships.dbml']);
  });
});

describe('pending relationships (D27) through renames, as a project Convert left mixed has them', () => {
  function pendingBase(): Record<string, string> {
    return {
      ...base(),
      [GOLD]: `${HEADER}use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n\n`
        + '// erd-studio pending: Ref: fct_order.id >? left_yaml.id\n'
        + '// erd-studio pending: Ref: fct_order.date_key >? dim_missing.date_key\n',
      'logical-models/left_yaml.yml': 'name: left_yaml\n',
    };
  }
  const pendingLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('// erd-studio pending:'));

  it('renaming the owner re-spells its pending lines in place, so they still belong to it', () => {
    const files = pendingBase();
    const model = { ...modelOf(files, 'fct_order'), name: 'fct_sale' };
    const { after } = run(files, { save: [{ model, fromName: 'fct_order' }], delete: ['fct_order'] });
    expect(pendingLines(after[GOLD])).toEqual([
      // The renamed end is spelled as the table declares itself now; the other ends keep their bytes.
      '// erd-studio pending: Ref: gold.fct_sale.id >? left_yaml.id',
      '// erd-studio pending: Ref: gold.fct_sale.date_key >? dim_missing.date_key',
    ]);
    expect(modelOf(after, 'fct_sale').relationships).toHaveLength(3);
  });

  it('a column-only save leaves the pending lines where they are', () => {
    const files = pendingBase();
    const model = modelOf(files, 'fct_order');
    model.description = 'Orders';
    const { plan } = run(files, { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace gold/tables/gold/fct_order.dbml']);
  });
});

describe('the plan\'s answers: relationshipsImportsFor and changedPairs (§2.4 step 7)', () => {
  it('imports are the files holding a live Ref with both ends among the members, after the plan', () => {
    const files = { ...base(), 'gold/relationships/dates.dbml': `${HEADER}use { table calendar.dim_date } from '../../silver/tables/calendar/dim_date.dbml'\nuse { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\n\nRef: gold.dim_customer.date_key >? calendar.dim_date.date_key\n` };
    const { plan } = run(files, { save: [{ model: visit() }], newTableHome: { layer: 'silver', schema: 'silver' } });
    expect(plan.relationshipsImportsFor(['fct_order', 'dim_customer'])).toEqual([GOLD]);
    expect(plan.relationshipsImportsFor(['fct_order', 'dim_customer', 'DIM_DATE'])).toEqual(['gold/relationships/dates.dbml', GOLD]);
    expect(plan.relationshipsImportsFor(['fct_visit', 'dim_date'])).toEqual(['silver/relationships/silver.dbml']);
    expect(plan.relationshipsImportsFor(['fct_visit'])).toEqual([]);
    expect(plan.changedPairs).toEqual(new Set([pairKey('fct_visit', 'dim_date')]));
    expect(plan.changedPairs).toEqual(changedPairs(plan.index, plan.afterIndex));
    // An unreadable file the diagram imports now is kept; one it does not import is never added.
    const broken = { ...files, 'gold/relationships/broken.dbml': 'Ref: x.y >\n' };
    const p2 = planDbmlLibraryWrites(snapshotOf(broken), {});
    expect(p2.relationshipsImportsFor(['fct_order', 'dim_customer'], ['gold/relationships/broken.dbml', GOLD])).toEqual(['gold/relationships/broken.dbml', GOLD]);
    expect(p2.relationshipsImportsFor(['fct_order', 'dim_customer'])).toEqual(relationshipsImportsFor(['fct_order', 'dim_customer'], p2.afterIndex));
  });

  it('a rename changes the old pair and the new one', () => {
    const files = base();
    const model = { ...modelOf(files, 'dim_customer'), name: 'dim_client' };
    const order = modelOf(files, 'fct_order');
    order.relationships = order.relationships!.map((r) => (r.toModel === 'dim_customer' ? { ...r, toModel: 'dim_client' } : r));
    const { plan } = run(files, { save: [{ model, fromName: 'dim_customer' }, { model: order }], delete: ['dim_customer'] });
    expect(plan.changedPairs).toEqual(new Set([pairKey('fct_order', 'dim_customer'), pairKey('fct_order', 'dim_client')]));
  });
});

describe('determinism', () => {
  /** A seeded shuffle (mulberry32), so a failure reproduces. */
  function shuffled<T>(items: readonly T[], seed: number): T[] {
    let a = seed >>> 0;
    const random = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  it('the save ops in any order write the same bytes', () => {
    const files = base();
    files['gold/relationships/hand.dbml'] = `${HEADER}use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'\nuse { table gold.fct_order } from '../tables/gold/fct_order.dbml'\n\nRef: gold.fct_order.customer_key ?- gold.dim_customer.customer_key\n`;
    files[GOLD] = files[GOLD].replace('Ref: gold.fct_order.customer_key >? gold.dim_customer.customer_key\n', '');
    const customer = modelOf(files, 'dim_customer');
    customer.relationships = [M21('date_key', 'dim_date', 'date_key')];
    const order = modelOf(files, 'fct_order');
    order.relationships = [...order.relationships!, { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }, M21('ship_date_key', 'dim_date', 'date_key', { role: 'ship' })];
    const saves = [{ model: customer }, { model: order }, { model: visit() }, { model: { ...visit(), name: 'fct_visit2' } }];
    const bytes = (list: typeof saves): Record<string, string> => {
      const plan = planDbmlLibraryWrites(snapshotOf(files), { save: list, newTableHome: { layer: 'gold', schema: 'gold' } });
      return apply(files, plan.writes);
    };
    const expected = bytes(saves);
    for (let seed = 1; seed <= 12; seed++) expect(bytes(shuffled(saves, seed)), `seed ${seed}`).toEqual(expected);
    expectClean(expected);
  });
});

describe('the canonical layout (every write is formatted; a no-op stays a no-op)', () => {
  it('a save that changes nothing writes nothing', () => {
    const files = base();
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: modelOf(files, 'fct_order') }, { model: modelOf(files, 'dim_customer') }] });
    expect(plan.writes).toEqual([]);
    expect(plan.changedPairs.size).toBe(0);
  });

  it('a new table is written Note first, its columns aligned and their notes last', () => {
    const model: SemanticTable = {
      name: 'fct_visit',
      description: 'Visits',
      columns: [
        { name: 'visit_id', dataType: 'BIGINT', description: 'The visit', isPrimaryKey: true, isNaturalKey: true },
        { name: 'date_key', dataType: 'INT', description: '', isForeignKey: true },
      ],
    };
    const { after } = run(base(), { save: [{ model }], newTableHome: { layer: 'gold', schema: 'gold' } });
    expect(after['gold/tables/gold/fct_visit.dbml']).toBe(
      'Table gold.fct_visit {\n' +
      "  Note: 'Visits'\n" +
      '\n' +
      "  visit_id BIGINT [pk, natural_key: 'true', note: 'The visit']\n" +
      "  date_key INT    [foreign_key: 'true']\n" +
      '}\n',
    );
  });
});
