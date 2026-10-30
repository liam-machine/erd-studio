/**
 * The library write planner for native DBML storage in the layer-first tree
 * (§2.4 of the 2.0 design): which table files and relationships files a set
 * of table saves, renames, moves and deletes writes, and their new text,
 * built only by core's splicers (`editTableDbml`, `renderNewTableDbml`,
 * `editRelationshipsDbml`).
 *
 * Refs are placed by decision 5 and never moved. A Ref already stored stays
 * in the relationships file that holds it, whatever changes about it (its
 * cardinality, its role, a column of a composite, its other end's column);
 * a NEW Ref goes where `placeNewRef` says, from one index of the project's
 * relationships files built before the edit (`dbmlRelationshipsIndex.ts`),
 * so placement never depends on the order of the ops.
 *
 * It only PLACES tables and Refs in files. Orientation, ownership and which
 * relationships exist stay with `planRelationshipWrite` and the cascades in
 * `libraryRelationships.ts`; a saved model's `relationships` are its
 * complete list.
 *
 * Pure: no `vscode`, no file access (the snapshot reads). Paths are posix,
 * relative to the semantic dir. Throws `DbmlEditRefused` with a plain
 * message for anything it will not write.
 */

import {
  attachRelationships,
  dbmlName,
  dbmlTablePath,
  dbmlTableLookup,
  dbmlTreePathOf,
  dirnamePosix,
  isLibraryFolderName,
  normalisePosix,
  resolvePosix,
} from '@erd-studio/core';
import type { DbmlAttachTable, DbmlRelationshipsReading } from '@erd-studio/core';
import {
  DBML_CONVERT_FIRST_MESSAGE,
  DbmlEditRefused,
  parseTableDbml,
  relationshipUnits,
  relationshipUnitsWithMembers,
  renamedColumnsOf,
} from '@erd-studio/core/dbml';
import { editRelationshipsDbml, editTableDbml, renderNewTableDbml } from './dbmlWriters';
import {
  buildRelationshipsIndex,
  changedPairs as changedPairsOf,
  pairKey,
  placeNewRef,
  refEntriesOf,
  relationshipsImportsFor as importsFor,
  unitLinks,
} from './dbmlRelationshipsIndex';
import type { IndexedRef, RelationshipsIndex } from './dbmlRelationshipsIndex';
import type { DbmlResolvedTable, RefUnit, RelationshipsFileEdit } from '@erd-studio/core/dbml';

import type { FileWrite } from './fileWrites';
import { mergeFileWrites } from './fileWrites';
import type { SemanticTable, TableRelationship } from '../types/semantic';

/** A table the library lists (the winner of its name). */
export interface DbmlSnapshotTable {
  /** Its real spelling (a `.dbml` table's declared name). */
  name: string;
  /** How Ref ends and `use` specifiers spell it: `x`, or `gold.x`. */
  reference: string;
  /** Its file, posix, relative to the semantic dir. */
  path: string;
  storage: 'yaml' | 'dbml';
  /** Its library folder (`''` = the top level); a DBML table's schema folder. */
  folder: string;
  /** A DBML table's layer folder (`<layer>/tables/<schema>/`), as listed. */
  layer?: string;
  /** A DBML table's schema folder, as listed (the same as `folder`). */
  schema?: string;
  /** Its columns' real spellings. */
  columns: string[];
  /** Its primary-key columns. */
  primaryKey?: string[];
  /** A DBML alias Refs may use (`Table fct_order as FO`). */
  dbmlAlias?: string;
}

/** What the planner reads (§2.4 step 1). */
export interface DbmlLibrarySnapshot {
  /** The semantic dir, for messages only. */
  semanticDir: string;
  /** Every table file the library lists (winners only), keyed lower-case. */
  tables: Map<string, DbmlSnapshotTable>;
  /** Every relationships file in the library (`<layer>/relationships/*.dbml`), readable or not, with its reading. */
  relationshipsFiles: Map<string, DbmlRelationshipsReading>;
  /** Every existing path the snapshot knows (tables, relationships files, diagrams). */
  files: ReadonlySet<string>;
  /** A file's text (an open document's first, else disk), byte-order mark stripped; null when there is none. */
  readText(path: string): string | null;
  /**
   * `schema` as `<layer>/tables/` lists it (§1.2 One spelling): an existing
   * schema folder matching case-insensitively, else `schema`. Default: from
   * the folders of the tables listed (an empty schema folder is not seen).
   */
  schemaAsListed?(layer: string, schema: string): string;
}

/** Where a new DBML table goes: `<layer>/tables/<schema>/`. */
export interface DbmlTableHome {
  layer: string;
  schema: string;
}

/**
 * A model to save, with the schema its developer configured, when it came
 * from dbt (§2.4 step 2): a model's, seed's or snapshot's `config.schema`,
 * a source's `schema`. Transient: never written to a file, never compared.
 */
export type DbmlDraftTable = SemanticTable & { configuredSchema?: string };

/** What to write (§2.4 step 2). */
export interface DbmlLibraryOps {
  /**
   * DBML tables only; a save with `fromName` renames. `asWritten` (Convert
   * only): the table's file already holds exactly this table, as
   * `renderNewTableDbml` wrote it from this model, so the plan neither edits
   * nor re-reads it and only places its relationships. `home` (a new table
   * only) wins over `newTableHome`, for a batch whose new tables go to
   * different layers.
   */
  save?: Array<{ model: DbmlDraftTable; fromName?: string; asWritten?: boolean; home?: DbmlTableHome }>;
  delete?: string[];
  /** A table to another layer and/or schema folder (Organise); its Refs stay where they are. */
  move?: Array<{ name: string; toLayer?: string; toSchema?: string }>;
  /** Where new tables go (the diagram's layer, its name as the schema); default: the first layer listed, else `main`. */
  newTableHome?: DbmlTableHome;
  /**
   * Import and Convert only: a new table's schema is its own `model.schema`
   * (the source's qualifier) when set. Without it (every canvas path) the
   * schema is `model.configuredSchema`, else the home's; a `model.schema`
   * from a manifest is the BUILT schema, never a folder.
   */
  schemaFromSource?: boolean;
  /**
   * Tables that gain their `.dbml` file in this edit although the snapshot
   * already lists them there (Convert lists the files it is about to write):
   * every relationships file whose Refs name one re-resolves its `use` lines,
   * so a Ref written against the table while it was YAML compiles after.
   */
  gainFile?: string[];
  /**
   * Convert only: a relationship that cannot be a live Ref yet (an end with
   * no `.dbml` table file, a YAML end, or a missing column) is written as a
   * pending line (D27) instead of being refused.
   */
  writePending?: boolean;
}

/** A table as the plan leaves it. */
export type DbmlPlannedTable = DbmlResolvedTable;

/** The plan (§2.4 step 7). */
export interface DbmlLibraryWritePlan {
  writes: FileWrite[];
  /** A table after the plan: real name, declared reference, real column spellings, path, storage. */
  resolveTable(name: string): DbmlPlannedTable | undefined;
  /**
   * The relationships files a diagram showing `members` imports after the
   * plan (`relationshipsImportsFor` over the after-index): every file holding
   * a live Ref with both ends among them, plus every file of `current` (its
   * imports now) that does not read. Byte-sorted; only files that exist after.
   */
  relationshipsImportsFor(members: Iterable<string>, current?: readonly string[]): string[];
  /**
   * {@link relationshipsImportsFor} with no current imports.
   * @deprecated 2.0-switch: S6b / S7 / S8a move their callers to `relationshipsImportsFor`.
   */
  relationshipsFilesFor(names: readonly string[]): string[];
  /** The table pairs (`pairKey`) whose set of files holding a live Ref the plan changes. */
  changedPairs: Set<string>;
  /** Tables whose qualifier the plan changes (a move to another schema), lower-case, named as after the plan. */
  requalified: Set<string>;
  /** Whether a path exists after the plan. */
  fileExists(path: string): boolean;
  /** Relationships files this plan creates. */
  createdRelationshipsFiles: string[];
  /** Tables whose path changed (renamed or moved) or that were deleted: old lower-case name → new path, or null. */
  pathChanged: Map<string, string | null>;
  /**
   * Tables new in this plan (their real names): a diagram that lists one in
   * `erd_unlinked_tables` (D26) moves it to a `use` line, and a pending line
   * naming one becomes a live Ref (D27).
   */
  createdTables: string[];
  /** The project's relationships files before the plan (the index every placement read). */
  index: RelationshipsIndex;
  /** The same after the plan, worked out without re-reading (§2.4 step 6). */
  afterIndex: RelationshipsIndex;
}

const lower = (s: string): string => s.toLowerCase();

/** Code-unit order (`<`): the same on every machine and locale. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(p: string): string {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
}

function stemOf(p: string): string {
  const file = p.slice(p.lastIndexOf('/') + 1);
  return file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file.replace(/\.ya?ml$/i, '');
}

/** `path` with `.dbml` added when it has none (a `use` path may leave it out). */
function withExtension(path: string): string {
  return path.toLowerCase().endsWith('.dbml') ? path : `${path}.dbml`;
}

/**
 * Whether a schema asked for (a dbt `config.schema`, a source's `schema`, an
 * imported qualifier) can be a new schema folder: a library folder name with
 * no dbt Jinja (`{{ target.schema }}`, `{% … %}`, `{# … #}`, which a schema
 * yml read without a manifest leaves unrendered) and no character Windows
 * refuses in a file name. Otherwise the home's schema is used.
 */
function isNewSchemaFolder(schema: string): boolean {
  return isLibraryFolderName(schema) && !/[{}%#<>:"|?*\u0000-\u001f]/.test(schema) && !/[ .]$/.test(schema);
}

function refuse(file: string, message: string, line?: number): never {
  throw new DbmlEditRefused(file, message, line);
}

/** A unit's identity: ends, pairs (in any order), cardinality and role. */
function unitIdentity(unit: RefUnit): string {
  return `${endsKey(unit)}\u0000${unit.cardinality}\u0000${unit.role ?? ''}`;
}

/** A unit's ends and column pairs, in any pair order and any case. */
function endsKey(unit: RefUnit): string {
  return [lower(unit.from), lower(unit.to), columnPairs(unit).sort().join(',')].join('\u0000');
}

function columnPairs(unit: RefUnit): string[] {
  return unit.fromColumns.map((c, i) => `${lower(c)}>${lower(unit.toColumns[i] ?? '')}`);
}

/** A unit's links (core `linkKey`), sorted and joined: equal for a unit and the same unit turned round. */
function linkSet(unit: RefUnit): string {
  return [...new Set(unitLinks(unit))].sort(byteOrder).join('\u0001');
}

function describeUnit(unit: RefUnit): string {
  const cols = (cs: string[]): string => (cs.length === 1 ? cs[0] : `(${cs.join(', ')})`);
  return `${unit.from}.${cols(unit.fromColumns)} → ${unit.to}.${cols(unit.toColumns)}`;
}

/** The attach step's view of the snapshot's tables. */
function attachTablesOf(snapshot: Pick<DbmlLibrarySnapshot, 'tables'>): DbmlAttachTable[] {
  return [...snapshot.tables.values()].map((t) => ({
    table: { name: t.name, columns: t.columns.map((c) => ({ name: c, dataType: '', description: '', ...((t.primaryKey ?? []).some((k) => lower(k) === lower(c)) ? { isPrimaryKey: true } : {}) })) },
    storage: t.storage,
    ...(t.dbmlAlias !== undefined ? { dbmlAlias: t.dbmlAlias } : {}),
  }));
}

/**
 * The index of the snapshot's relationships files (§2.4 "one snapshot, one
 * index"): their Refs and pending lines, which files do not read, and the
 * tables each file's `use` lines name.
 */
export function relationshipsIndexOf(
  snapshot: Pick<DbmlLibrarySnapshot, 'tables' | 'relationshipsFiles'>,
  lookup: (name: string) => DbmlAttachTable | undefined = dbmlTableLookup(attachTablesOf(snapshot)),
): RelationshipsIndex {
  const refs: IndexedRef[] = [];
  const unreadable: string[] = [];
  const useTargets = new Map<string, string[]>();
  for (const [file, reading] of snapshot.relationshipsFiles) {
    if (!reading.readable) {
      unreadable.push(file);
      continue;
    }
    refs.push(...refEntriesOf(file, reading, lookup));
    if (reading.uses && reading.uses.length > 0) {
      const dir = dirnamePosix(file);
      useTargets.set(file, reading.uses.map((p) => normalisePosix(resolvePosix(dir, withExtension(p)))));
    }
  }
  return buildRelationshipsIndex({ files: [...snapshot.relationshipsFiles.keys()], refs, unreadable, useTargets });
}

/**
 * Plan the writes for `ops` against `snapshot` (§2.4). Throws
 * `DbmlEditRefused` for an edit it will not write: a table file or
 * relationships file that does not read, a relationship stored twice or
 * already stored elsewhere, a relationship from a DBML table to a YAML one
 * (D20), a relationship added while a relationships file does not read.
 */
export function planDbmlLibraryWrites(snapshot: DbmlLibrarySnapshot, ops: DbmlLibraryOps): DbmlLibraryWritePlan {
  // --- Layers and schema folders as the disk spells them -------------------------------------
  const listedLayers = new Map<string, string>();
  const listedSchemas = new Map<string, Map<string, string>>();
  const noteSchema = (layer: string, schema: string): void => {
    let schemas = listedSchemas.get(lower(layer));
    if (!schemas) listedSchemas.set(lower(layer), schemas = new Map());
    if (!schemas.has(lower(schema))) schemas.set(lower(schema), schema);
  };
  for (const t of snapshot.tables.values()) {
    if (t.storage !== 'dbml' || t.layer === undefined) continue;
    if (!listedLayers.has(lower(t.layer))) listedLayers.set(lower(t.layer), t.layer);
    if (t.schema !== undefined) noteSchema(t.layer, t.schema);
  }
  for (const file of snapshot.relationshipsFiles.keys()) {
    const layer = dbmlTreePathOf(file)?.layer;
    if (layer !== undefined && !listedLayers.has(lower(layer))) listedLayers.set(lower(layer), layer);
  }
  /** Schema folders this plan creates, so two new tables in one plan agree on one spelling. */
  const plannedSchemas = new Map<string, string>();
  const schemaAsListed = (layer: string, schema: string): string => {
    const planned = plannedSchemas.get(`${lower(layer)}\u0000${lower(schema)}`);
    if (planned !== undefined) return planned;
    if (snapshot.schemaAsListed) return snapshot.schemaAsListed(layer, schema);
    const schemas = listedSchemas.get(lower(layer));
    return [...(schemas?.values() ?? [])].find((s) => s === schema) ?? schemas?.get(lower(schema)) ?? schema;
  };
  const listedFiles = new Set([...snapshot.files].map(lower));
  const fileListed = (p: string): boolean => snapshot.files.has(p) || listedFiles.has(lower(p));
  const defaultHome = (): DbmlTableHome => {
    const layer = [...listedLayers.values()].sort(byteOrder)[0] ?? 'main';
    return { layer, schema: layer };
  };

  // --- 0. Normalise: a delete of a rename's old name is part of the rename ------------------
  const saves = (ops.save ?? []).map((s) => ({ ...s }));
  const renamedFrom = new Set(saves.filter((s) => s.fromName !== undefined && s.fromName !== s.model.name).map((s) => lower(s.fromName!)));
  const deletes = [...new Set((ops.delete ?? []).map(lower))].filter((name) => !renamedFrom.has(name));
  const moves = ops.move ?? [];

  // --- The library before: its attachment and its one index ----------------------------------
  const lookup = dbmlTableLookup(attachTablesOf(snapshot));
  const readings = [...snapshot.relationshipsFiles.entries()].map(([path, reading]) => ({ path, reading }));
  const attachment = attachRelationships(readings, lookup);
  const index = relationshipsIndexOf(snapshot, lookup);
  const refsByOwner = new Map<string, IndexedRef[]>();
  for (const ref of index.refs) {
    const list = refsByOwner.get(ref.owner) ?? [];
    refsByOwner.set(ref.owner, list);
    list.push(ref);
  }
  /** Every pending unit before the plan, named as before it: one the plan writes stays pending while it cannot be live (D27). */
  const pendingBefore = index.refs.filter((r) => r.pending).map((r) => r.unit);

  // --- 1. The path overlay ------------------------------------------------------------------
  const after = new Map<string, DbmlPlannedTable>();
  const columnsOf = (columns: readonly string[]) => (col: string): string | undefined => columns.find((c) => c === col) ?? columns.find((c) => lower(c) === lower(col));
  for (const [key, t] of snapshot.tables) {
    after.set(key, {
      name: t.name,
      reference: t.reference,
      columns: columnsOf(t.columns),
      path: t.path,
      storage: t.storage,
      ...(t.primaryKey ? { primaryKey: t.primaryKey } : {}),
    });
  }

  const writes: FileWrite[] = [];
  const pathChanged = new Map<string, string | null>();
  const requalified = new Set<string>();
  const renames = new Map<string, string>(); // old lower → new name
  /** Column renames, per table: its lower name after the plan → old lower column → new name (the table writer's own pairing). */
  const columnRenames = new Map<string, Map<string, string>>();
  /** The same, keyed by the table's lower name before the plan. */
  const columnRenamesBefore = new Map<string, Map<string, string>>();
  /** Owners whose relationships this plan places: lower name after → desired list, or null (deleted). */
  const affected = new Map<string, { name: string; relationships: readonly TableRelationship[] } | null>();
  /** Old lower name of each affected owner (for finding its Refs). */
  const oldNameOf = new Map<string, string>();
  const tableText = (path: string): string => {
    const text = snapshot.readText(path);
    if (text === null) refuse(path, `${path} could not be read; nothing was changed.`);
    return text;
  };
  const schemaFolderOf = (path: string): { schemaFolder?: string } => {
    const schema = dbmlTreePathOf(path)?.schema;
    return schema !== undefined ? { schemaFolder: schema } : {};
  };
  const plannedTable = (text: string, path: string, model: SemanticTable, asWritten = false): DbmlPlannedTable => {
    const reading = asWritten ? null : parseTableDbml(text, stemOf(path), schemaFolderOf(path));
    const ok = reading?.ok ? reading : null;
    const columns = ok ? (ok.table.columns ?? []).map((c) => c.name) : (model.columns ?? []).map((c) => c.name);
    const pk = ok ? (ok.table.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name) : (model.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name);
    return {
      name: ok ? ok.table.name : model.name,
      reference: ok ? ok.declaredReference : model.schema ? `${dbmlName(model.schema)}.${dbmlName(model.name)}` : dbmlName(model.name),
      columns: columnsOf(columns),
      path,
      storage: 'dbml',
      primaryKey: pk,
    };
  };

  // Deletes.
  for (const name of deletes) {
    const t = snapshot.tables.get(name);
    if (!t) continue;
    if (t.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    writes.push({ kind: 'delete', path: t.path });
    after.delete(name);
    pathChanged.set(name, null);
    affected.set(name, null);
    oldNameOf.set(name, name);
  }

  // Saves (edits, renames, new tables).
  for (const { model: draft, fromName, asWritten, home } of saves) {
    const { configuredSchema, ...given } = draft;
    let model: SemanticTable = given;
    const sourceKey = lower(fromName ?? model.name);
    const t = snapshot.tables.get(sourceKey);
    const renamed = t !== undefined && fromName !== undefined && fromName !== model.name;
    if (t && t.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    let path: string;
    let text: string;
    if (!t) {
      // §2.4 step 2: the layer is the home's; the schema is the source's (Import, Convert), else the
      // one the developer configured, else the home's; spelled as the layer's tables/ lists it.
      const where = home ?? ops.newTableHome ?? defaultHome();
      const requested = ops.schemaFromSource ? model.schema || where.schema : configuredSchema || where.schema;
      const schema = schemaAsListed(where.layer, isNewSchemaFolder(requested) ? requested : where.schema);
      plannedSchemas.set(`${lower(where.layer)}\u0000${lower(schema)}`, schema);
      model = { ...model, schema };
      path = dbmlTablePath(where.layer, schema, model.name);
      if (fileListed(path)) refuse(path, `${path} already exists; choose another name.`);
      text = renderNewTableDbml(model);
      writes.push({ kind: 'create', path, text });
    } else if (renamed) {
      path = `${dirOf(t.path)}/${model.name}.dbml`;
      text = editTableDbml(tableText(t.path), model, { rename: true, file: t.path, fileStem: stemOf(t.path), ...schemaFolderOf(t.path) });
      writes.push({ kind: 'create', path, text }, { kind: 'delete', path: t.path });
      after.delete(sourceKey);
      renames.set(sourceKey, model.name);
      pathChanged.set(sourceKey, path);
    } else {
      path = t.path;
      const old = tableText(t.path);
      text = asWritten ? old : editTableDbml(old, model, { file: t.path, fileStem: stemOf(t.path), ...schemaFolderOf(t.path) });
      if (text !== old) writes.push({ kind: 'replace', path, text });
    }
    const planned = plannedTable(text, path, model, asWritten === true && !!t && !renamed);
    after.set(lower(model.name), planned);
    if (t) {
      const columnsRenamed = renamedColumnsOf(t.columns, (model.columns ?? []).map((c) => c.name));
      if (columnsRenamed.size > 0) {
        columnRenames.set(lower(model.name), columnsRenamed);
        columnRenamesBefore.set(sourceKey, columnsRenamed);
      }
    }
    // Relationships: placed when they changed, or the owner was renamed or is new.
    const desired = model.relationships ?? [];
    const current = t ? attachment.byOwner.get(lower(t.name)) ?? [] : [];
    const changed = renamed || !t || unitsKey(planned.name, desired) !== unitsKey(t.name, current);
    if (changed && (t || desired.length > 0)) {
      affected.set(lower(model.name), { name: planned.name, relationships: desired });
      oldNameOf.set(lower(model.name), t ? lower(t.name) : lower(model.name));
    }
  }

  // Moves (Organise): the file goes to another layer and/or schema folder; its Refs stay where they are.
  for (const { name, toLayer, toSchema } of moves) {
    const key = lower(name);
    const current = after.get(key);
    const t = snapshot.tables.get(key);
    if (!current || !t) continue;
    if (current.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    const from = dbmlTreePathOf(current.path);
    if (!from || from.kind !== 'table' || from.schema === undefined) refuse(current.path, `${current.path} is not in a <layer>/tables/<schema>/ folder; move it by hand.`);
    const layer = toLayer ?? from.layer;
    const schema = schemaAsListed(layer, toSchema ?? from.schema);
    const stem = stemOf(current.path);
    const path = dbmlTablePath(layer, schema, stem);
    if (path === current.path) continue;
    if (lower(path) === lower(current.path)) refuse(current.path, 'A move that only changes case is not supported; rename the folder by hand.');
    if (fileListed(path)) refuse(path, `${path} already exists; nothing was moved.`);
    const pending = writes.findIndex((w) => w.path === current.path && w.kind !== 'delete');
    let text = pending >= 0 ? (writes[pending] as { text: string }).text : tableText(current.path);
    if (pending >= 0) writes.splice(pending, 1);
    const reading = parseTableDbml(text, stem, { schemaFolder: from.schema });
    if (!reading.ok) refuse(current.path, `${current.path} does not read (${reading.error.message}); fix it first, then move it.`);
    // §2.4 step 2: the qualifier the file declares (not its folder) follows the schema folder.
    const qualifier = reading.schemaQualified ? reading.table.schema : undefined;
    if (qualifier !== schema) {
      text = editTableDbml(text, { ...reading.table, schema }, { requalify: true, file: current.path, fileStem: stem, schemaFolder: from.schema });
      requalified.add(key);
    }
    plannedSchemas.set(`${lower(layer)}\u0000${lower(schema)}`, schema);
    writes.push({ kind: 'create', path, text });
    if (!writes.some((w) => w.kind === 'delete' && w.path === t.path)) writes.push({ kind: 'delete', path: t.path });
    after.set(key, { ...current, path, reference: plannedTable(text, path, reading.table).reference });
    pathChanged.set(key, path);
  }

  /** A unit (ends named after the plan) with the columns this plan renames spelled anew. */
  const withRenamedColumns = (unit: RefUnit): RefUnit => {
    if (columnRenames.size === 0) return unit;
    const spell = (table: string, column: string): string => columnRenames.get(lower(table))?.get(lower(column)) ?? column;
    return { ...unit, fromColumns: unit.fromColumns.map((c) => spell(unit.from, c)), toColumns: unit.toColumns.map((c) => spell(unit.to, c)) };
  };
  const renamedName = (name: string): string => renames.get(lower(name)) ?? name;
  /** A stored Ref's unit as it reads after the plan's renames. */
  const storedAfter = (ref: IndexedRef): RefUnit => withRenamedColumns({ ...ref.unit, from: renamedName(ref.unit.from), to: renamedName(ref.unit.to) });

  const resolveTable = (name: string): DbmlPlannedTable | undefined => {
    const key = renames.get(lower(name)) !== undefined ? lower(renames.get(lower(name))!) : lower(name);
    return after.get(key) ?? [...after.values()].find((t) => lower(t.name) === lower(name));
  };
  /** Both ends have `.dbml` files with these columns after the plan: the unit can be a live Ref. */
  const liveable = (unit: RefUnit): boolean => [[unit.from, unit.fromColumns], [unit.to, unit.toColumns]].every(([n, cs]) => {
    const table = resolveTable(n as string);
    return table !== undefined && table.storage === 'dbml' && (cs as string[]).every((c) => table.columns(c) !== undefined);
  });

  // --- 3. Partition, in place, for each affected owner ------------------------------------------
  type Member = { unit: RefUnit; relationships: TableRelationship[] };
  /** Each affected owner's desired units, with the stored Refs (and so the files) each was matched to. */
  interface OwnerPlan {
    key: string;
    oldKey: string;
    entry: { name: string; relationships: readonly TableRelationship[] } | null;
    desired: Member[];
    matched: Map<Member, IndexedRef[]>;
    /** How each matched unit was matched: 1 identity, 2 ends, 3 turn-round, 4 column change. */
    how: Map<Member, 1 | 2 | 3 | 4>;
    unmatchedStored: IndexedRef[];
  }
  const ownerPlans: OwnerPlan[] = [...affected.keys()].sort(byteOrder).map((key) => {
    const entry = affected.get(key) ?? null;
    const oldKey = oldNameOf.get(key) ?? key;
    const desired = entry ? relationshipUnitsWithMembers(entry.name, entry.relationships) : [];
    return { key, oldKey, entry, desired, matched: new Map(), how: new Map(), unmatchedStored: [...(refsByOwner.get(oldKey) ?? [])] };
  });
  const claim = (plan: OwnerPlan, member: Member, refs: IndexedRef[], how: 1 | 2 | 3 | 4): void => {
    plan.matched.set(member, refs);
    plan.how.set(member, how);
  };
  for (const plan of ownerPlans) {
    // 1. The same identity: every stored copy is assigned, so a pre-existing duplicate still reaches the refusal.
    for (const member of plan.desired) {
      const id = unitIdentity(member.unit);
      const copies = plan.unmatchedStored.filter((r) => unitIdentity(storedAfter(r)) === id);
      if (copies.length === 0) continue;
      plan.unmatchedStored = plan.unmatchedStored.filter((r) => !copies.includes(r));
      claim(plan, member, copies, 1);
    }
    // 2. The same ends and column pairs: a cardinality or role change.
    for (const member of plan.desired) {
      if (plan.matched.has(member)) continue;
      const ends = endsKey(member.unit);
      const copies = plan.unmatchedStored.filter((r) => endsKey(storedAfter(r)) === ends);
      if (copies.length === 0) continue;
      plan.unmatchedStored = plan.unmatchedStored.filter((r) => !copies.includes(r));
      claim(plan, member, copies, 2);
    }
  }
  // 3. A turn-round: the same links as a unit some owner cuts in this plan. It takes that unit's file.
  const cutUnits = ownerPlans.flatMap((plan) => plan.unmatchedStored.map((ref) => ({ plan, ref, links: linkSet(storedAfter(ref)) })));
  const claimedCuts = new Set<IndexedRef>();
  for (const plan of ownerPlans) {
    for (const member of plan.desired) {
      if (plan.matched.has(member)) continue;
      const links = linkSet(member.unit);
      const cut = cutUnits.find((c) => !claimedCuts.has(c.ref) && c.links === links);
      if (!cut) continue;
      claimedCuts.add(cut.ref);
      cut.plan.unmatchedStored = cut.plan.unmatchedStored.filter((r) => r !== cut.ref);
      claim(plan, member, [cut.ref], 3);
    }
  }
  // 4 (2b). A column change: each owner's unmatched stored unit of the same table pair is paired with
  // the desired unit it shares the most with, assigned best first over the owner's whole list, so the
  // order the units are listed in never decides it. Scored by column pairs shared, then foreign-key
  // columns, then referenced columns; ties: the stored unit's file byte order, then its line, then the
  // desired list's order. A pairing that shares nothing comes only after every one that shares some.
  for (const plan of ownerPlans) {
    const candidates: Array<{ member: Member; ref: IndexedRef; score: number[]; order: number }> = [];
    plan.desired.forEach((member, order) => {
      if (plan.matched.has(member)) return;
      const pair = pairKey(member.unit.from, member.unit.to);
      const wanted = new Set(columnPairs(member.unit));
      const wantedFrom = new Set(member.unit.fromColumns.map(lower));
      const wantedTo = new Set(member.unit.toColumns.map(lower));
      for (const ref of plan.unmatchedStored) {
        const unit = storedAfter(ref);
        if (pairKey(unit.from, unit.to) !== pair) continue;
        const score = [
          columnPairs(unit).filter((p) => wanted.has(p)).length,
          unit.fromColumns.filter((c) => wantedFrom.has(lower(c))).length,
          unit.toColumns.filter((c) => wantedTo.has(lower(c))).length,
        ];
        candidates.push({ member, ref, score, order });
      }
    });
    candidates.sort((a, b) => b.score[0] - a.score[0] || b.score[1] - a.score[1] || b.score[2] - a.score[2]
      || byteOrder(a.ref.file, b.ref.file) || a.ref.line - b.ref.line || a.order - b.order);
    const taken = new Set<IndexedRef>();
    for (const { member, ref } of candidates) {
      if (plan.matched.has(member) || taken.has(ref)) continue;
      taken.add(ref);
      claim(plan, member, [ref], 4);
    }
    plan.unmatchedStored = plan.unmatchedStored.filter((r) => !taken.has(r));
  }

  // --- 5. Refusals ------------------------------------------------------------------------------
  const newMembers = ownerPlans.flatMap((plan) => plan.desired.filter((m) => !plan.matched.has(m)).map((member) => ({ plan, member })));
  const changesUnits = newMembers.length > 0 || ownerPlans.some((plan) => [...plan.how.values()].some((h) => h === 3 || h === 4));
  /** Why an unreadable relationships file does not read, for a refusal: `(line 3: …)`. */
  const notReading = (file: string): { text: string; line?: number } => {
    const problem = snapshot.relationshipsFiles.get(file)?.problems[0];
    const message = (problem?.message ?? 'it does not read').replace(/\. No relationship is read from (it|the file) until[^]*$/, '').replace(/\.$/, '');
    const where = problem?.line !== undefined && !/^line \d/i.test(message) ? `line ${problem.line}: ` : '';
    return { text: `${file} does not read (${where}${message})`, line: problem?.line };
  };
  if (changesUnits && index.unreadable.size > 0) {
    // The single default file per layer is where merge conflicts land: adding the Ref elsewhere
    // would make a duplicate once the conflict is fixed.
    const file = [...index.unreadable].sort(byteOrder)[0];
    const why = notReading(file);
    refuse(file, `${why.text}; fix it first: it may already hold this relationship.`, why.line);
  }
  // A rename, move, requalify, delete or column rename of a table an unreadable file may name: that
  // file would keep the old spelling (a Ref end, a use line) once it reads again, so it is refused.
  // The file has no reading to ask, so its text is searched: the table's name or its file's stem as a
  // whole word, in any case. A table it does not name goes through.
  if (index.unreadable.size > 0) {
    const respelled = new Set<string>([...pathChanged.keys(), ...requalified, ...columnRenamesBefore.keys()]);
    const verbOf = (key: string): string => (pathChanged.get(key) === null ? 'deletes'
      : renames.has(key) ? 'renames'
        : pathChanged.has(key) || requalified.has(key) ? 'moves' : 'renames a column of');
    const mentions = (text: string, word: string): boolean =>
      new RegExp(`(^|[^A-Za-z0-9_])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`, 'i').test(text);
    for (const file of [...index.unreadable].sort(byteOrder)) {
      const text = snapshot.readText(file);
      for (const key of [...respelled].sort(byteOrder)) {
        const before = snapshot.tables.get(key);
        const name = before?.name ?? key;
        const words = [name, ...(before ? [stemOf(before.path)] : [])];
        if (text !== null && !words.some((w) => mentions(text, w))) continue;
        const why = notReading(file);
        refuse(file, `${why.text}; fix it first: it may name ${name}, which this edit ${verbOf(key)}.`, why.line);
      }
    }
  }
  // A new unit whose link a Ref this plan keeps already holds: it is edited where it is, never written twice.
  const affectedOld = new Set(ownerPlans.map((p) => p.oldKey));
  for (const { member } of newMembers) {
    for (const link of unitLinks(member.unit)) {
      const holder = index.holders(link).find((r) => !affectedOld.has(r.owner));
      if (holder) {
        refuse(holder.file, `${holder.file} line ${holder.line} already holds the relationship ${describeUnit(holder.unit)}; edit it there.`, holder.line);
      }
    }
  }

  // --- Placement of new units (decision 5) ------------------------------------------------------
  const layerOf = (p: string): string => dbmlTreePathOf(p)?.layer ?? (p.includes('/') ? p.slice(0, p.indexOf('/')) : defaultHome().layer);
  const placed = new Map<Member, string>();
  for (const { plan, member } of newMembers) {
    const owner = after.get(plan.key);
    const placement = placeNewRef(
      { table: plan.oldKey, layer: owner ? layerOf(owner.path) : defaultHome().layer },
      index,
      (l) => listedLayers.get(l),
    );
    placed.set(member, placement.file);
  }
  /** The file each desired unit goes in (a matched one: its stored copies' files). */
  const filesOf = (plan: OwnerPlan, member: Member): string[] => {
    const refs = plan.matched.get(member);
    if (refs) return [...new Set(refs.map((r) => r.file))];
    const file = placed.get(member);
    return file !== undefined ? [file] : [];
  };

  // D20: a relationship this plan writes from a DBML owner may name only DBML tables (Convert writes it pending, D27).
  if (!ops.writePending) {
    for (const plan of ownerPlans) {
      if (!plan.entry) continue;
      for (const member of plan.desired) {
        if (plan.how.get(member) === 1) continue;
        for (const end of [member.unit.from, member.unit.to]) {
          if (resolveTable(end)?.storage === 'yaml') {
            refuse(filesOf(plan, member)[0] ?? '', `Can't store the relationship ${describeUnit(member.unit)}: ${end} is a YAML table, and a DBML table's relationships can only name DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`);
          }
        }
      }
    }
  }

  // --- The edits, one per relationships file ------------------------------------------------------
  const edits = new Map<string, { owners: Map<string, { name: string; relationships: TableRelationship[] } | null>; ownersBefore: Set<string> }>();
  const editFor = (file: string) => {
    let e = edits.get(file);
    if (!e) edits.set(file, e = { owners: new Map(), ownersBefore: new Set() });
    return e;
  };
  /** Per file, the stored Refs a column change (match 2b) rewrites in place: line → the unit it becomes. */
  const columnChanges = new Map<string, Map<number, RefUnit>>();
  for (const plan of ownerPlans) {
    for (const [member, how] of plan.how) {
      if (how !== 4) continue;
      for (const ref of plan.matched.get(member) ?? []) {
        let lines = columnChanges.get(ref.file);
        if (!lines) columnChanges.set(ref.file, lines = new Map());
        lines.set(ref.line, member.unit);
      }
    }
  }
  for (const plan of ownerPlans) {
    // Every file holding a Ref or pending line of the owner lists it: what is not assigned there is cut.
    for (const file of index.ownerCounts(plan.oldKey).keys()) {
      const e = editFor(file);
      e.ownersBefore.add(plan.oldKey);
      e.owners.set(plan.key, plan.entry ? { name: plan.entry.name, relationships: [] } : null);
    }
    if (!plan.entry) continue;
    for (const member of plan.desired) {
      for (const file of filesOf(plan, member)) {
        const e = editFor(file);
        e.ownersBefore.add(plan.oldKey);
        let held = e.owners.get(plan.key);
        if (!held) e.owners.set(plan.key, held = { name: plan.entry.name, relationships: [] });
        held.relationships.push(...member.relationships);
      }
    }
  }

  // --- 4. Re-spelling: files whose Refs or use lines name a table whose path, name or columns change ---
  const newTables = saves.filter((s) => !snapshot.tables.has(lower(s.fromName ?? s.model.name))).map((s) => s.model.name);
  const changedNames = new Set<string>([...pathChanged.keys(), ...requalified, ...(ops.gainFile ?? []).map(lower), ...newTables.map(lower)]);
  const pathChangedAfter = new Set<string>([...(ops.gainFile ?? []), ...newTables].map((name) => lower(renamedName(name))));
  for (const [oldKey, newPath] of pathChanged) {
    if (newPath === null) pathChangedAfter.add(oldKey);
    else pathChangedAfter.add(lower(renames.get(oldKey) ?? oldKey));
  }
  const namesRenamedColumn = (table: string, columns: readonly string[]): boolean => {
    const renamedHere = columnRenamesBefore.get(lower(table));
    return renamedHere !== undefined && columns.some((c) => renamedHere.has(lower(c)));
  };
  for (const ref of index.refs) {
    if (changedNames.has(ref.owner) || changedNames.has(ref.target)
      || namesRenamedColumn(ref.unit.from, ref.unit.fromColumns) || namesRenamedColumn(ref.unit.to, ref.unit.toColumns)) editFor(ref.file);
  }
  // A use line naming a moved, renamed or deleted table, even with no Ref naming it (§1.3).
  for (const oldKey of pathChanged.keys()) {
    const before = snapshot.tables.get(oldKey);
    if (before) for (const file of index.filesUsing(before.path)) editFor(file);
  }
  // Convert: every file with a pending line that can be a live Ref now (both ends have .dbml files with those columns).
  if (ops.writePending) {
    for (const ref of index.refs) if (ref.pending && liveable(storedAfter(ref))) editFor(ref.file);
  }

  // --- 6. The after-state, without re-reading ------------------------------------------------------
  const pendingBeforeKeys = new Set(pendingBefore.map((u) => unitIdentity(withRenamedColumns({ ...u, from: renamedName(u.from), to: renamedName(u.to) }))));
  const realName = (name: string): string => resolveTable(name)?.name ?? name;
  const afterRefs: IndexedRef[] = [];
  const renamesNothing = renames.size === 0 && columnRenames.size === 0;
  for (const ref of edits.size === 0 ? [] : index.refs) {
    const e = edits.get(ref.file);
    if (e?.ownersBefore.has(ref.owner)) continue; // the file's listed owners say what it holds after
    if (!e && renamesNothing) {
      afterRefs.push(ref); // a file the plan does not touch holds what it held
      continue;
    }
    const unit = storedAfter(ref);
    afterRefs.push({
      ...ref,
      // The index's names are the real ones already; only a rename changes them.
      owner: lower(renames.get(ref.owner) ?? ref.owner),
      target: lower(renames.get(ref.target) ?? ref.target),
      unit,
      links: renamesNothing ? ref.links : unitLinks(unit),
      // An edited file turns a pending line live once it can be (D27).
      pending: e ? ref.pending && !liveable(unit) : ref.pending,
    });
  }
  for (const plan of ownerPlans) {
    if (!plan.entry) continue;
    for (const member of plan.desired) {
      const unit: RefUnit = { ...member.unit, from: realName(member.unit.from), to: realName(member.unit.to) };
      const stored = plan.matched.get(member);
      const pending = !liveable(unit) && (ops.writePending === true || pendingBeforeKeys.has(unitIdentity(unit)));
      // One entry per stored copy (a duplicate stays a duplicate, and is refused below), else the placement.
      const at = stored ? stored.map((r) => ({ file: r.file, line: r.line })) : filesOf(plan, member).map((file) => ({ file, line: 0 }));
      for (const { file, line } of at) {
        afterRefs.push({ file, owner: lower(unit.from), target: lower(unit.to), unit, links: unitLinks(unit), pending, line });
      }
    }
  }
  const createdFiles = [...edits.keys()].filter((f) => !snapshot.relationshipsFiles.has(f) && !fileListed(f));
  // A plan that edits no relationships file leaves every Ref where and as it was (a rename names none).
  const afterIndex = edits.size === 0 ? index : buildRelationshipsIndex({
    files: [...index.files, ...createdFiles.filter((f) => afterRefs.some((r) => r.file === f))],
    refs: afterRefs,
    unreadable: index.unreadable,
  });

  // Duplicate links, on the library as it will be (pending lines counted).
  {
    const touched = new Set(ownerPlans.flatMap((plan) => plan.desired.flatMap((m) => unitLinks(m.unit))));
    for (const link of [...touched].sort(byteOrder)) {
      const holders = afterIndex.holders(link);
      if (holders.length < 2) continue;
      const [a, b] = [holders[0].file, holders[1].file];
      const [x, y] = link.split('\u0000');
      refuse(b, `${a === b ? `${a} holds` : `${a} and ${b} both hold`} the relationship ${x} → ${y}${a === b ? ' twice' : ''}. Remove one of them first.`);
    }
  }

  // --- One write per relationships file (in path order) ---------------------------------------------
  const resolveForWriter = (name: string): DbmlResolvedTable | undefined => resolveTable(name);
  const created = new Set(writes.filter((w) => w.kind === 'create').map((w) => w.path));
  const deleted = new Set(writes.filter((w) => w.kind === 'delete').map((w) => w.path));
  const createdRelationshipsFiles: string[] = [];
  for (const file of [...edits.keys()].sort(byteOrder)) {
    const e = edits.get(file)!;
    const exists = snapshot.relationshipsFiles.has(file) || fileListed(file);
    const oldText = exists ? snapshot.readText(file) : null;
    if (exists && oldText === null) refuse(file, `${file} could not be read; nothing was changed.`);
    if (oldText === null && ![...e.owners.values()].some((o) => o && o.relationships.length > 0)) continue;
    const fileEdit: RelationshipsFileEdit = {
      filePath: file,
      owners: e.owners,
      ...(renames.size > 0 ? { renamedOwners: renames } : {}),
      ...(columnRenames.size > 0 ? { renamedColumns: columnRenames } : {}),
      ...(pathChangedAfter.size > 0 ? { pathChanged: pathChangedAfter } : {}),
      ...(requalified.size > 0 ? { requalified } : {}),
      ...(ops.writePending ? { writePending: true } : {}),
      ...(pendingBefore.length > 0 ? { pendingBefore } : {}),
      ...(columnChanges.has(file) ? { columnChanges: columnChanges.get(file)! } : {}),
      resolve: resolveForWriter,
    };
    const text = editRelationshipsDbml(oldText, fileEdit);
    if (oldText === null) {
      writes.push({ kind: 'create', path: file, text });
      createdRelationshipsFiles.push(file);
      created.add(file);
    } else if (text !== oldText) {
      writes.push({ kind: 'replace', path: file, text });
    }
  }

  const merged = mergeFileWrites(writes);
  const fileExists = (p: string): boolean => created.has(p) || (snapshot.files.has(p) && !deleted.has(p));
  return {
    writes: merged,
    resolveTable,
    relationshipsImportsFor: (members, current = []) => importsFor(members, afterIndex, { current, exists: fileExists }),
    relationshipsFilesFor: (names) => importsFor(names, afterIndex, { exists: fileExists }),
    changedPairs: afterIndex === index ? new Set() : changedPairsOf(index, afterIndex),
    requalified: new Set(requalified),
    fileExists,
    createdRelationshipsFiles,
    pathChanged,
    createdTables: newTables,
    index,
    afterIndex,
  };

  function unitsKey(owner: string, list: readonly TableRelationship[]): string {
    return relationshipUnits(owner, list).map(unitIdentity).sort().join('\n');
  }
}

