/**
 * The DBML library write planner (§4.6 of docs/plans/native-dbml-storage.md,
 * §9.5): table saves, renames, moves and deletes placed in their table files
 * and their folders' relationships files — one write per file — with Refs
 * moved home verbatim, links stored twice refused, and a relationship from a
 * DBML table to a YAML one refused (D20). Pure: a snapshot built from an
 * in-memory map of files.
 */

import { describe, it, expect } from 'vitest';

import { DbmlEditRefused, parseTableDbml, readRelationshipsDbml } from '@erd-studio/core/dbml';
import { attachRelationships, dbmlTableLookup } from '@erd-studio/core';
import type { DbmlAttachTable } from '@erd-studio/core';
import { planDbmlLibraryWrites } from '../../src/services/dbmlLibraryWrites';
import { renameColumnInRelationships } from '../../src/services/libraryRelationships';
import type { DbmlLibrarySnapshot, DbmlSnapshotTable } from '../../src/services/dbmlLibraryWrites';
import type { FileWrite } from '../../src/services/fileWrites';
import type { SemanticTable } from '../../src/types/semantic';
import { projectDiagnostics } from '../../packages/core/test/dbmlWriterSupport';
import { formatWrittenDbml } from '../../src/services/dbmlWriters';

/** The expected text in the canonical layout ERD Studio writes every .dbml in (every write is formatted). */
function canonical(text: string): string {
  return formatWrittenDbml(text, 'expected.dbml');
}

const HEADER = '// ERD Studio relationships.\n';

/** A snapshot of `files` (posix paths relative to the semantic dir → text); `.yml` files are YAML tables named by their stem. */
function snapshotOf(files: Record<string, string>): DbmlLibrarySnapshot {
  const tables = new Map<string, DbmlSnapshotTable>();
  const relationshipsFiles = new Map<string, ReturnType<typeof readRelationshipsDbml>>();
  for (const [path, text] of Object.entries(files)) {
    const segments = path.split('/');
    const file = segments[segments.length - 1];
    const folder = segments.length === 3 ? segments[1] : '';
    if (file.toLowerCase() === '_relationships.dbml') {
      relationshipsFiles.set(path, readRelationshipsDbml(text));
      continue;
    }
    if (file.endsWith('.yml')) {
      const name = file.slice(0, -4);
      tables.set(name.toLowerCase(), { name, reference: name, path, storage: 'yaml', folder, columns: ['id'], primaryKey: ['id'] });
      continue;
    }
    const reading = parseTableDbml(text, file.slice(0, -5));
    if (!reading.ok) throw new Error(`fixture ${path} does not read`);
    tables.set(reading.table.name.toLowerCase(), {
      name: reading.table.name,
      reference: reading.declaredReference,
      path,
      storage: 'dbml',
      folder,
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
  const reading = parseTableDbml(files[t.path], name);
  if (!reading.ok) throw new Error('no table');
  const attachTables: DbmlAttachTable[] = [...snap.tables.values()].map((x) => ({
    table: { name: x.name, columns: x.columns.map((c) => ({ name: c, dataType: '', description: '', ...(x.primaryKey?.includes(c) ? { isPrimaryKey: true } : {}) })) },
    folder: x.folder, storage: x.storage,
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

/** Every `.dbml` compiles with no diagnostic in any parser. */
function expectClean(files: Record<string, string>): void {
  const dbml = Object.fromEntries(Object.entries(files).filter(([p]) => p.endsWith('.dbml')));
  expect(projectDiagnostics(dbml)).toEqual([]);
}

function base(): Record<string, string> {
  return {
    'tables/dim_date.dbml': 'Table dim_date {\n  date_key INT [pk]\n}\n',
    'tables/gold/fct_order.dbml': 'Table fct_order {\n  id INT [pk]\n  date_key INT\n  customer_key INT\n}\n',
    'tables/gold/dim_customer.dbml': 'Table dim_customer {\n  customer_key INT [pk]\n}\n',
    'tables/gold/_relationships.dbml': `${HEADER}use { table dim_date } from '../dim_date.dbml'\nuse { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\nRef: fct_order.date_key >? dim_date.date_key [delete: cascade] // keep me\n`,
  };
}

describe('each op kind: one write per file', () => {
  it('a column-only save writes the table file only', () => {
    const files = base();
    const model = modelOf(files, 'fct_order');
    model.columns.push({ name: 'amount', dataType: 'DECIMAL', description: '' });
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/fct_order.dbml']);
    expect(plan.pathChanged.size).toBe(0);
    expect(plan.createdRelationshipsFiles).toEqual([]);
    expectClean(apply(files, plan.writes));
  });

  it('a relationship change writes the owner\'s folder file, nothing else', () => {
    const files = base();
    const model = modelOf(files, 'fct_order');
    model.relationships = model.relationships!.filter((r) => r.toModel !== 'dim_customer');
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/_relationships.dbml']);
    const after = apply(files, plan.writes);
    expect(after['tables/gold/_relationships.dbml']).toBe(canonical(`${HEADER}use { table dim_date } from '../dim_date.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.date_key >? dim_date.date_key [delete: cascade] // keep me\n`));
    expectClean(after);
  });

  it('a new table with a relationship in a folder with no relationships file creates both', () => {
    const files = base();
    const model: SemanticTable = {
      name: 'fct_visit',
      columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'date_key', dataType: 'INT', description: '' }],
      relationships: [{ fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }],
    };
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }], newTableFolder: 'silver' });
    expect(pathsOf(plan.writes)).toEqual(['create tables/silver/_relationships.dbml', 'create tables/silver/fct_visit.dbml']);
    expect(plan.createdRelationshipsFiles).toEqual(['tables/silver/_relationships.dbml']);
    expect(plan.relationshipsFilesFor(['fct_visit', 'fct_order'])).toEqual(['tables/silver/_relationships.dbml', 'tables/gold/_relationships.dbml']);
    expect(plan.resolveTable('FCT_VISIT')).toMatchObject({ name: 'fct_visit', path: 'tables/silver/fct_visit.dbml', storage: 'dbml' });
    expectClean(apply(files, plan.writes));
  });

  it('a delete removes the file, the Refs it owns and its use lines; the file stays (D15)', () => {
    const files = base();
    const plan = planDbmlLibraryWrites(snapshotOf(files), { delete: ['fct_order'] });
    expect(pathsOf(plan.writes)).toEqual(['delete tables/gold/fct_order.dbml', 'replace tables/gold/_relationships.dbml']);
    expect(plan.pathChanged).toEqual(new Map([['fct_order', null]]));
    expect(apply(files, plan.writes)['tables/gold/_relationships.dbml']).toBe(canonical(`${HEADER}\n`));
    expect(plan.resolveTable('fct_order')).toBeUndefined();
    expect(plan.fileExists('tables/gold/fct_order.dbml')).toBe(false);
  });

  it('a move carries the file and its Refs verbatim to the new folder\'s file', () => {
    const files = base();
    const plan = planDbmlLibraryWrites(snapshotOf(files), { move: [{ name: 'fct_order', toFolder: 'silver' }] });
    expect(pathsOf(plan.writes)).toEqual([
      'create tables/silver/_relationships.dbml',
      'create tables/silver/fct_order.dbml',
      'delete tables/gold/fct_order.dbml',
      'replace tables/gold/_relationships.dbml',
    ]);
    const after = apply(files, plan.writes);
    expect(after['tables/silver/_relationships.dbml']).toContain('Ref: fct_order.date_key >? dim_date.date_key [delete: cascade] // keep me');
    expect(after['tables/silver/_relationships.dbml']).toContain("use { table dim_customer } from '../gold/dim_customer.dbml'");
    expect(after['tables/gold/_relationships.dbml']).not.toMatch(/^Ref/m);
    expect(plan.pathChanged).toEqual(new Map([['fct_order', 'tables/silver/fct_order.dbml']]));
    expectClean(after);
  });

  it('a refusal passes through (a table file holding a use line is not rewritten)', () => {
    const files = { ...base(), 'tables/gold/dim_customer.dbml': "use { table dim_date } from '../dim_date.dbml'\nTable dim_customer {\n  customer_key INT [pk]\n}\n" };
    const model = modelOf(files, 'dim_customer');
    model.description = 'Customers';
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(DbmlEditRefused);
  });
});

describe('folders and relationships files as the disk spells them', () => {
  /** base() with the gold folder's relationships file named `_Relationships.dbml`. */
  const caseVariant = (): Record<string, string> => {
    const files = base();
    files['tables/gold/_Relationships.dbml'] = files['tables/gold/_relationships.dbml'];
    delete files['tables/gold/_relationships.dbml'];
    return files;
  };

  it('a relationships file named in another case is the folder\'s file: edited in place, never a second one created', () => {
    const files = caseVariant();
    const model = modelOf(files, 'fct_order');
    model.relationships = [...(model.relationships ?? []).filter((r) => r.toModel !== 'dim_customer'), { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' }];
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/_Relationships.dbml']);
    expect(plan.createdRelationshipsFiles).toEqual([]);
    expect(plan.relationshipsFilesFor(['fct_order'])).toEqual(['tables/gold/_Relationships.dbml']);
    const after = apply(files, plan.writes);
    // Its other Refs stay where they were.
    expect(after['tables/gold/_Relationships.dbml']).toContain('Ref: fct_order.date_key >? dim_date.date_key [delete: cascade] // keep me');
    expect(after['tables/gold/_Relationships.dbml']).toContain('Ref: dim_customer.customer_key ?- fct_order.customer_key');
  });

  it('a new table in that folder is placed there too, with no new relationships file', () => {
    const files = caseVariant();
    const model: SemanticTable = {
      name: 'fct_visit',
      columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: true }, { name: 'date_key', dataType: 'INT', description: '' }],
      relationships: [{ fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }],
    };
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }], newTableFolder: 'GOLD' });
    expect(pathsOf(plan.writes)).toEqual(['create tables/gold/fct_visit.dbml', 'replace tables/gold/_Relationships.dbml']);
    expect(plan.createdRelationshipsFiles).toEqual([]);
  });
});

describe('the rename ops shape (§4.6 step 0)', () => {
  it('save [{model, fromName: old}] + delete [old] is one rename: the owner\'s Refs are re-spelled, never dropped', () => {
    const files = base();
    const model = { ...modelOf(files, 'fct_order'), name: 'fct_sale' };
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model, fromName: 'fct_order' }], delete: ['fct_order'] });
    expect(pathsOf(plan.writes)).toEqual([
      'create tables/gold/fct_sale.dbml',
      'delete tables/gold/fct_order.dbml',
      'replace tables/gold/_relationships.dbml',
    ]);
    const after = apply(files, plan.writes);
    expect(after['tables/gold/fct_sale.dbml']).toBe(canonical('Table fct_sale {\n  id INT [pk]\n  date_key INT\n  customer_key INT\n}\n'));
    expect(after['tables/gold/_relationships.dbml']).toBe(canonical(`${HEADER}use { table dim_date } from '../dim_date.dbml'\nuse { table dim_customer } from './dim_customer.dbml'\nuse { table fct_sale } from './fct_sale.dbml'\n\nRef: fct_sale.customer_key >? dim_customer.customer_key\nRef: fct_sale.date_key >? dim_date.date_key [delete: cascade] // keep me\n`));
    expect(plan.pathChanged).toEqual(new Map([['fct_order', 'tables/gold/fct_sale.dbml']]));
    expectClean(after);
  });
});

describe('a column rename keeps the Ref (Law 4)', () => {
  /** Rename `table.from` → `to` as the editor does: the table's column, its own Refs and every other table's (#126). */
  function renameColumn(files: Record<string, string>, table: string, from: string, to: string) {
    const model = modelOf(files, table);
    model.columns = model.columns.map((c) => (c.name === from ? { ...c, name: to } : c));
    renameColumnInRelationships([model], table, from, to);
    const others = Object.keys(files)
      .filter((p) => p.endsWith('.dbml') && !p.endsWith('_relationships.dbml'))
      .map((p) => p.slice(p.lastIndexOf('/') + 1, -'.dbml'.length))
      .filter((n) => n !== table)
      .map((n) => modelOf(files, n));
    const changed = renameColumnInRelationships(others, table, from, to);
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }, ...changed.map((m) => ({ model: m }))] });
    return apply(files, plan.writes);
  }

  it('the referenced column: settings, trailing comment and operator keep their bytes', () => {
    const after = renameColumn(base(), 'dim_date', 'date_key', 'day_key');
    expect(after['tables/gold/_relationships.dbml']).toBe(canonical(`${HEADER}use { table dim_date } from '../dim_date.dbml'\nuse { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\nRef: fct_order.date_key >? dim_date.day_key [delete: cascade] // keep me\n`));
    expectClean(after);
  });

  it('the foreign-key column, with a hand-written operator', () => {
    const files = base();
    files['tables/gold/_relationships.dbml'] = files['tables/gold/_relationships.dbml'].replace('date_key >? dim_date', 'date_key > dim_date');
    const after = renameColumn(files, 'fct_order', 'date_key', 'order_date_key');
    expect(after['tables/gold/_relationships.dbml']).toContain('\nRef: fct_order.order_date_key > dim_date.date_key [delete: cascade] // keep me\n');
    expectClean(after);
  });

  it('a block-form Ref keeps its block, its comment lines and its settings', () => {
    const files: Record<string, string> = {
      'tables/fct_order.dbml': 'Table fct_order {\n  id INT [pk]\n  dim_key INT\n}\n',
      'tables/dim.dbml': 'Table dim {\n  dim_key INT [pk]\n}\n',
      'tables/_relationships.dbml': `${HEADER}use { table dim } from './dim.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef r1 {\n  // my comment\n  fct_order.dim_key > dim.dim_key [delete: cascade]\n}\n`,
    };
    const after = renameColumn(files, 'dim', 'dim_key', 'k');
    expect(after['tables/_relationships.dbml']).toBe(canonical(`${HEADER}use { table dim } from './dim.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef r1 {\n  // my comment\n  fct_order.dim_key > dim.k [delete: cascade]\n}\n`));
    expectClean(after);
  });

  it('one column of a composite Ref, on a schema-qualified table', () => {
    const files: Record<string, string> = {
      'tables/employee.dbml': 'Table employee {\n  id INT [pk]\n  a INT\n  b INT\n}\n',
      'tables/badge.dbml': 'Table gold.badge {\n  id INT [pk]\n  a INT\n  b INT\n  indexes {\n    (a, b) [unique]\n  }\n}\n',
      'tables/_relationships.dbml': `${HEADER}use { table gold.badge } from './badge.dbml'\nuse { table employee } from './employee.dbml'\n\nRef: employee.(a, b) > gold.badge.(a, b) [update: cascade] // composite\n`,
    };
    const after = renameColumn(files, 'badge', 'b', 'b2');
    expect(after['tables/_relationships.dbml']).toContain('\nRef: employee.(a, b) > gold.badge.(a, b2) [update: cascade] // composite\n');
    expectClean(after);
  });

  it('a Ref whose owner the edit does not list still follows the column', () => {
    const files = base();
    const model = modelOf(files, 'dim_date');
    model.columns = model.columns.map((c) => (c.name === 'date_key' ? { ...c, name: 'day_key' } : c));
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    const after = apply(files, plan.writes);
    expect(after['tables/gold/_relationships.dbml']).toContain('\nRef: fct_order.date_key >? dim_date.day_key [delete: cascade] // keep me\n');
    expectClean(after);
  });
});

describe('Refs moved home verbatim (§4.6 step 3)', () => {
  it('a misplaced Ref goes home, settings and comment kept, when its owner\'s relationships change', () => {
    const files = {
      ...base(),
      'tables/gold/_relationships.dbml': `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\n`,
      'tables/_relationships.dbml': `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_order } from './gold/fct_order.dbml'\n\nRef: fct_order.date_key > dim_date.date_key [delete: cascade] // hand-placed\n`,
    };
    const model = modelOf(files, 'fct_order');
    model.relationships = model.relationships!.map((r) => (r.toModel === 'dim_customer' ? { ...r, role: 'buyer' } : r));
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/_relationships.dbml', 'replace tables/gold/_relationships.dbml']);
    const after = apply(files, plan.writes);
    expect(after['tables/_relationships.dbml']).not.toMatch(/^Ref/m);
    expect(after['tables/gold/_relationships.dbml']).toContain('Ref: fct_order.date_key > dim_date.date_key [delete: cascade] // hand-placed');
    expect(after['tables/gold/_relationships.dbml']).toContain('Ref buyer: fct_order.customer_key >? dim_customer.customer_key');
    expectClean(after);
  });

  it('a column-only save of that owner moves nothing', () => {
    const files = {
      ...base(),
      'tables/gold/_relationships.dbml': `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\n`,
      'tables/_relationships.dbml': `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_order } from './gold/fct_order.dbml'\n\nRef: fct_order.date_key > dim_date.date_key\n`,
    };
    const model = modelOf(files, 'fct_order');
    model.description = 'Orders';
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/fct_order.dbml']);
  });
});

describe('refusals', () => {
  it('a link stored in two folders\' files', () => {
    const files = {
      ...base(),
      'tables/gold/dim_customer.dbml': 'Table dim_customer {\n  customer_key INT [pk]\n  date_key INT\n}\n',
      'tables/_relationships.dbml': `${HEADER}use { table dim_date } from './dim_date.dbml'\nuse { table fct_order } from './gold/fct_order.dbml'\n\nRef: fct_order.date_key ?- dim_date.date_key\n`,
      'tables/gold/_relationships.dbml': `${HEADER}use { table dim_date } from '../dim_date.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: dim_date.date_key ?- fct_order.date_key\n`,
    };
    // Each file's one-to-one is marked from a different end (`?-` marks the foreign key), so each has
    // another owner; editing fct_order keeps dim_date's copy beside its own.
    const model = modelOf(files, 'fct_order');
    model.description = 'x';
    model.relationships = [...(model.relationships ?? []), { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(/both hold the relationship/);
  });

  it('a link stored twice in one file', () => {
    const files = {
      ...base(),
      'tables/gold/_relationships.dbml': `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key ?- dim_customer.customer_key\nRef: dim_customer.customer_key ?- fct_order.customer_key\n`,
    };
    const model = modelOf(files, 'fct_order');
    model.relationships = [...(model.relationships ?? []), { fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(/holds the relationship .* twice/);
  });

  it('the reserved name `_relationships` (§2.1): a new table, a rename target, in any case', () => {
    const files = base();
    const fresh: SemanticTable = { name: '_relationships', columns: [{ name: 'id', dataType: 'INT', description: '' }] };
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: fresh }], newTableFolder: 'gold' }))
      .toThrow('‘_relationships’ is the name of the relationships file; choose another table name.');
    const renamed = { ...modelOf(files, 'dim_customer'), name: '_Relationships' };
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: renamed, fromName: 'dim_customer' }] }))
      .toThrow(DbmlEditRefused);
  });

  it('a relationship from a DBML table to a YAML table (D20)', () => {
    const files = { ...base(), 'tables/gold/dim_yaml.yml': 'name: dim_yaml\n' };
    const model = modelOf(files, 'fct_order');
    model.relationships = [...(model.relationships ?? []), { fromColumn: 'id', toModel: 'dim_yaml', toColumn: 'id', cardinality: 'one-to-one' }];
    expect(() => planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] })).toThrow(/dim_yaml is a YAML table.*Convert the project to DBML first/);
  });
});

describe('pending relationships (D27) through renames and moves, as a project Convert left mixed has them', () => {
  /** fct_order with a live Ref and pending lines: to a YAML table, to a table with no file, to a column dim_date lacks. */
  function pendingBase(): Record<string, string> {
    return {
      ...base(),
      'tables/gold/_relationships.dbml': `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\nRef: fct_order.customer_key >? dim_customer.customer_key\n\n`
        + '// erd-studio pending: Ref: fct_order.id >? left_yaml.id\n'
        + '// erd-studio pending: Ref: fct_order.date_key >? dim_missing.date_key\n'
        + '// erd-studio pending: Ref: fct_order.customer_key >? dim_date.nope\n',
      'tables/gold/left_yaml.yml': 'name: left_yaml\n',
    };
  }
  const pendingLines = (text: string): string[] => text.split('\n').filter((l) => l.startsWith('// erd-studio pending:'));

  it('renaming the owner re-spells its pending lines, so they still belong to it', () => {
    const files = pendingBase();
    const model = { ...modelOf(files, 'fct_order'), name: 'fct_sale' };
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model, fromName: 'fct_order' }], delete: ['fct_order'] });
    const after = apply(files, plan.writes);
    expect(pendingLines(after['tables/gold/_relationships.dbml'])).toEqual([
      '// erd-studio pending: Ref: fct_sale.id >? left_yaml.id',
      '// erd-studio pending: Ref: fct_sale.date_key >? dim_missing.date_key',
      '// erd-studio pending: Ref: fct_sale.customer_key >? dim_date.nope',
    ]);
    expect(modelOf(after, 'fct_sale').relationships).toHaveLength(4);
    expectClean(Object.fromEntries(Object.entries(after).filter(([p]) => !p.endsWith('.yml'))));
  });

  it('renaming a pending line\'s target (the owner following, as the provider does) re-spells that end only', () => {
    const files = pendingBase();
    const dim = { ...modelOf(files, 'dim_date'), name: 'dim_day' };
    const fct = modelOf(files, 'fct_order');
    fct.relationships = fct.relationships!.map((r) => (r.toModel === 'dim_date' ? { ...r, toModel: 'dim_day' } : r));
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: dim, fromName: 'dim_date' }, { model: fct }], delete: ['dim_date'] });
    const after = apply(files, plan.writes);
    expect(pendingLines(after['tables/gold/_relationships.dbml'])).toContain('// erd-studio pending: Ref: fct_order.customer_key >? dim_day.nope');
  });

  it('renaming a column a pending line names writes the relationships file, the column re-spelled', () => {
    const files = pendingBase();
    const model = modelOf(files, 'fct_order');
    model.columns = model.columns.map((c) => (c.name === 'date_key' ? { ...c, name: 'order_date_key' } : c));
    model.relationships = model.relationships!.map((r) => (r.fromColumn === 'date_key' ? { ...r, fromColumn: 'order_date_key' } : r));
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/_relationships.dbml', 'replace tables/gold/fct_order.dbml']);
    expect(pendingLines(apply(files, plan.writes)['tables/gold/_relationships.dbml'])).toContain('// erd-studio pending: Ref: fct_order.order_date_key >? dim_missing.date_key');
  });

  it('moving the owner to another folder carries its pending lines there, still pending, and the old file keeps no copy', () => {
    const files = pendingBase();
    const plan = planDbmlLibraryWrites(snapshotOf(files), { move: [{ name: 'fct_order', toFolder: 'silver' }] });
    const after = apply(files, plan.writes);
    expect(pendingLines(after['tables/gold/_relationships.dbml'])).toEqual([]);
    expect(pendingLines(after['tables/silver/_relationships.dbml'])).toEqual([
      '// erd-studio pending: Ref: fct_order.customer_key >? dim_date.nope',
      '// erd-studio pending: Ref: fct_order.date_key >? dim_missing.date_key',
      '// erd-studio pending: Ref: fct_order.id >? left_yaml.id',
    ]);
    expect(after['tables/silver/_relationships.dbml']).toContain('Ref: fct_order.customer_key >? dim_customer.customer_key');
    expect(modelOf(after, 'fct_order').relationships).toHaveLength(4);
    expectClean(Object.fromEntries(Object.entries(after).filter(([p]) => !p.endsWith('.yml'))));
  });
});

describe('the canonical layout (every write is formatted; a no-op stays a no-op)', () => {
  /** A library as ERD Studio 1.9.x wrote it: the body Note last, the column note before its other settings, nothing aligned, no blank line between foreign-key tables. */
  const OLD_LAYOUT = (): Record<string, string> => ({
    'tables/gold/dim_customer.dbml': "Table dim_customer {\n  customer_key INT [pk, note: 'Surrogate key']\n  name VARCHAR\n  Note: 'Customers'\n}\n",
    'tables/gold/dim_date.dbml': 'Table dim_date {\n  date_key INT [pk]\n}\n',
    'tables/gold/fct_order.dbml': "Table fct_order {\n  id INT [pk]\n  customer_key INT [note: 'Who ordered', foreign_key: 'true']\n  date_key INT\n  Note: 'Orders'\n}\n",
    'tables/gold/_relationships.dbml': `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table dim_date } from './dim_date.dbml'\nuse { table fct_order } from './fct_order.dbml'\n\n` +
      'Ref: dim_customer.name >? dim_date.date_key\nRef: fct_order.customer_key >? dim_customer.customer_key\n',
  });

  it('a save that changes nothing writes nothing, however the files are laid out', () => {
    const files = OLD_LAYOUT();
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model: modelOf(files, 'fct_order') }, { model: modelOf(files, 'dim_customer') }] });
    expect(plan.writes).toEqual([]);
  });

  it('the first change to a 1.9.x table file writes it once, in the canonical layout, keeping its element and setting order', () => {
    const files = OLD_LAYOUT();
    const model = modelOf(files, 'fct_order');
    model.columns[2].description = 'Order day';
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(pathsOf(plan.writes)).toEqual(['replace tables/gold/fct_order.dbml']);
    const after = apply(files, plan.writes)['tables/gold/fct_order.dbml'];
    expect(after).toBe(
      'Table fct_order {\n' +
      '  id           INT [pk]\n' +
      "  customer_key INT [note: 'Who ordered', foreign_key: 'true']\n" +
      "  date_key     INT [note: 'Order day']\n" +
      "  Note: 'Orders'\n" +
      '}\n',
    );
    expect(canonical(after)).toBe(after);
    // The same change again is a no-op.
    const again = apply(files, plan.writes);
    expect(planDbmlLibraryWrites(snapshotOf(again), { save: [{ model: modelOf(again, 'fct_order') }] }).writes).toEqual([]);
  });

  it('a relationships change on a 1.9.x file aligns its use lines and puts a blank line between foreign-key tables', () => {
    const files = OLD_LAYOUT();
    const model = modelOf(files, 'fct_order');
    model.relationships = [...(model.relationships ?? []), { fromColumn: 'date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one' }];
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }] });
    expect(apply(files, plan.writes)['tables/gold/_relationships.dbml']).toBe(
      `${HEADER}use { table dim_customer } from './dim_customer.dbml'\nuse { table dim_date }     from './dim_date.dbml'\nuse { table fct_order }    from './fct_order.dbml'\n\n` +
      'Ref: dim_customer.name >? dim_date.date_key\n\nRef: fct_order.customer_key >? dim_customer.customer_key\nRef: fct_order.date_key >? dim_date.date_key\n',
    );
    expectClean(apply(files, plan.writes));
  });

  it('a new table is written Note first, its columns aligned and their notes last', () => {
    const files = OLD_LAYOUT();
    const model: SemanticTable = {
      name: 'fct_visit',
      description: 'Visits',
      columns: [
        { name: 'visit_id', dataType: 'BIGINT', description: 'The visit', isPrimaryKey: true, isNaturalKey: true },
        { name: 'date_key', dataType: 'INT', description: '', isForeignKey: true },
      ],
    };
    const plan = planDbmlLibraryWrites(snapshotOf(files), { save: [{ model }], newTableFolder: 'gold' });
    expect(apply(files, plan.writes)['tables/gold/fct_visit.dbml']).toBe(
      'Table fct_visit {\n' +
      "  Note: 'Visits'\n" +
      '\n' +
      "  visit_id BIGINT [pk, natural_key: 'true', note: 'The visit']\n" +
      "  date_key INT    [foreign_key: 'true']\n" +
      '}\n',
    );
  });
});
