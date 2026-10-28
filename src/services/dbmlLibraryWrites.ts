/**
 * The library write planner for native DBML storage (§4.6 of
 * docs/plans/native-dbml-storage.md): which table files and relationships
 * files a set of table saves, renames, moves and deletes writes, and their
 * new text, built only by core's splicers (`editTableDbml`,
 * `renderNewTableDbml`, `editRelationshipsDbml`).
 *
 * It only PLACES tables and Refs in files. Orientation, ownership and which
 * relationships exist stay with `planRelationshipWrite` and the cascades in
 * `libraryRelationships.ts`; a saved model's `relationships` are its
 * complete list. Every relationship belongs to its foreign-key table and is
 * stored in the relationships file of that table's folder (D3): a Ref found
 * in another folder's file ("misplaced") is moved home, verbatim, by the
 * next write that changes its owner's relationships, name or folder.
 *
 * Pure: no `vscode`, no file access (the snapshot reads). Paths are posix,
 * relative to the semantic dir. Throws `DbmlEditRefused` with a plain
 * message for anything it will not write.
 */

import {
  DBML_RELATIONSHIPS_FILE_NAME,
  attachRelationships,
  dbmlName,
  dbmlTableLookup,
  isReservedTableName,
  linkKey,
  reverseBareOneToOne,
} from '@erd-studio/core';
import type { DbmlAttachTable, DbmlRelationshipsReading, DbmlStoredRef } from '@erd-studio/core';
import {
  DBML_CONVERT_FIRST_MESSAGE,
  DbmlEditRefused,
  editRelationshipsDbml,
  editTableDbml,
  parseTableDbml,
  relationshipUnits,
  renamedColumnsOf,
  renderNewTableDbml,
} from '@erd-studio/core/dbml';
import type { DbmlResolvedTable, RefUnit, RelationshipsFileEdit } from '@erd-studio/core/dbml';

import type { FileWrite } from './fileWrites';
import { mergeFileWrites } from './fileWrites';
import type { Relationship, SemanticTable, TableRelationship } from '../types/semantic';
import { RESERVED_TABLE_NAME_MESSAGE } from '../types/naming';

/** A table the library lists (the winner of its name). */
export interface DbmlSnapshotTable {
  /** Its real spelling (a `.dbml` table's declared name). */
  name: string;
  /** How Ref ends and `use` specifiers spell it: `x`, or `gold.x`. */
  reference: string;
  /** Its file, posix, relative to the semantic dir. */
  path: string;
  storage: 'yaml' | 'dbml';
  /** Its library folder (`''` = the top level). */
  folder: string;
  /** Its columns' real spellings. */
  columns: string[];
  /** Its primary-key columns. */
  primaryKey?: string[];
  /** A DBML alias Refs may use (`Table fct_order as FO`). */
  dbmlAlias?: string;
}

/** What the planner reads (§4.6). */
export interface DbmlLibrarySnapshot {
  /** The semantic dir, for messages only. */
  semanticDir: string;
  /** Every table file the library lists (winners only), keyed lower-case. */
  tables: Map<string, DbmlSnapshotTable>;
  /** Every relationships file in the library, with its reading. */
  relationshipsFiles: Map<string, DbmlRelationshipsReading>;
  /** Every existing path the snapshot knows (tables, relationships files, diagrams, layouts). */
  files: ReadonlySet<string>;
  /** A file's text (an open document's first, else disk), byte-order mark stripped; null when there is none. */
  readText(path: string): string | null;
}

/** What to write (§4.6). */
export interface DbmlLibraryOps {
  /** DBML tables only; a save with `fromName` renames. */
  save?: Array<{ model: SemanticTable; fromName?: string }>;
  delete?: string[];
  /** Organise: a table to another library folder. */
  move?: Array<{ name: string; toFolder: string }>;
  /** The library folder new tables go in (`''` = the top level). */
  newTableFolder?: string;
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

/** The plan (§4.6). */
export interface DbmlLibraryWritePlan {
  writes: FileWrite[];
  /** A table after the plan: real name, declared reference, real column spellings, path, storage. */
  resolveTable(name: string): DbmlPlannedTable | undefined;
  /** The relationships files (after the plan) of the folders holding these DBML tables, when they exist after it. */
  relationshipsFilesFor(names: readonly string[]): string[];
  /** Whether a path exists after the plan. */
  fileExists(path: string): boolean;
  /** Relationships files this plan creates. */
  createdRelationshipsFiles: string[];
  /** Tables whose path changed (renamed or moved) or that were deleted: old lower-case name → new path, or null. */
  pathChanged: Map<string, string | null>;
  /**
   * Tables new in this plan (their real names): a diagram that lists one in
   * `erd_unlinked_tables` (D26) moves it to a `use` line, and a pending line
   * naming one becomes a live Ref (D27). Optional for older callers.
   */
  createdTables?: string[];
}

const lower = (s: string): string => s.toLowerCase();

const TABLES_PREFIX = 'tables/';

function dirOf(p: string): string {
  const at = p.lastIndexOf('/');
  return at < 0 ? '' : p.slice(0, at);
}

/** A table file's path in a library folder. */
function tableFilePath(folder: string, name: string): string {
  return `${TABLES_PREFIX}${folder ? `${folder}/` : ''}${name}.dbml`;
}

function stemOf(p: string): string {
  const file = p.slice(p.lastIndexOf('/') + 1);
  return file.toLowerCase().endsWith('.dbml') ? file.slice(0, -'.dbml'.length) : file.replace(/\.ya?ml$/i, '');
}

function refuse(file: string, message: string): never {
  throw new DbmlEditRefused(file, message);
}

/** A unit's identity: ends, pairs (in any order), cardinality and role. */
function unitIdentity(unit: RefUnit): string {
  const pairs = unit.fromColumns.map((c, i) => `${lower(c)}>${lower(unit.toColumns[i] ?? '')}`).sort();
  return [lower(unit.from), lower(unit.to), pairs.join(','), unit.cardinality, unit.role ?? ''].join('\u0000');
}

/** The per-pair link keys of a unit (core's `linkKey`, order-free). */
function unitLinks(unit: RefUnit): string[] {
  return unit.fromColumns.map((c, i) => linkKey({ fromModel: unit.from, fromColumn: c, toModel: unit.to, toColumn: unit.toColumns[i] ?? '' }));
}

function describeUnit(unit: RefUnit): string {
  const cols = (cs: string[]): string => (cs.length === 1 ? cs[0] : `(${cs.join(', ')})`);
  return `${unit.from}.${cols(unit.fromColumns)} → ${unit.to}.${cols(unit.toColumns)}`;
}

/** A stored Ref's unit, oriented as `attachRelationships` reads it. */
function storedUnit(ref: DbmlStoredRef, lookup: (name: string) => DbmlAttachTable | undefined): { unit: RefUnit; rels: Relationship[] } | null {
  let rels = ref.relationships;
  if (rels.length === 0) return null;
  if (ref.oneToOneDirection === 'keys') {
    const pk = (name: string): string[] | undefined => {
      const entry = lookup(name);
      return entry ? (entry.table.columns ?? []).filter((c) => c?.isPrimaryKey).map((c) => c.name) : undefined;
    };
    if (reverseBareOneToOne(pk(rels[0].fromModel), rels.map((r) => r.fromColumn), pk(rels[0].toModel), rels.map((r) => r.toColumn))) {
      rels = rels.map((r) => ({ ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn }));
    }
  }
  const from = lookup(rels[0].fromModel)?.table.name ?? rels[0].fromModel;
  const to = lookup(rels[0].toModel)?.table.name ?? rels[0].toModel;
  return {
    rels,
    unit: {
      from, to,
      fromColumns: rels.map((r) => r.fromColumn),
      toColumns: rels.map((r) => r.toColumn),
      cardinality: rels[0].cardinality,
      ...(rels[0].role !== undefined && rels[0].role !== '' ? { role: rels[0].role } : {}),
    },
  };
}

/**
 * Plan the writes for `ops` against `snapshot` (§4.6). Throws
 * `DbmlEditRefused` for an edit it will not write: a table file or
 * relationships file that does not read, a relationship stored twice, a
 * relationship from a DBML table to a YAML one (D20).
 */
export function planDbmlLibraryWrites(snapshot: DbmlLibrarySnapshot, ops: DbmlLibraryOps): DbmlLibraryWritePlan {
  // --- Folders and relationships files as the disk spells them -------------------------------
  // The library reads a relationships file named in any case
  // (`_Relationships.dbml`): each folder's is the one the snapshot lists, so
  // the planner edits that file and never creates a second one beside it.
  const listedRelationshipsFile = new Map<string, string>();
  for (const file of snapshot.relationshipsFiles.keys()) {
    const dir = lower(dirOf(file));
    if (!listedRelationshipsFile.has(dir)) listedRelationshipsFile.set(dir, file);
  }
  /** The relationships file of a table file's folder. */
  const relationshipsFileOf = (tablePath: string): string =>
    listedRelationshipsFile.get(lower(dirOf(tablePath))) ?? `${dirOf(tablePath)}/${DBML_RELATIONSHIPS_FILE_NAME}`;
  /** A library folder spelled as the disk spells it, when the snapshot knows it. */
  const listedFolders = new Map<string, string>();
  for (const t of snapshot.tables.values()) if (t.storage === 'dbml' && t.folder) listedFolders.set(lower(t.folder), t.folder);
  for (const file of snapshot.relationshipsFiles.keys()) {
    const folder = dirOf(file).slice(TABLES_PREFIX.length);
    if (dirOf(file).startsWith('tables/') && folder) listedFolders.set(lower(folder), folder);
  }
  const folderAsListed = (folder: string): string => listedFolders.get(lower(folder)) ?? folder;
  /** §2.1: a new or renamed `.dbml` table may not take the relationships file's name. */
  const refuseReserved = (name: string, where: string): void => {
    if (isReservedTableName(name)) refuse(where, RESERVED_TABLE_NAME_MESSAGE);
  };

  // --- 0. Normalise: a delete of a rename's old name is part of the rename ------------------
  const saves = (ops.save ?? []).map((s) => ({ ...s }));
  const renamedFrom = new Set(saves.filter((s) => s.fromName !== undefined && s.fromName !== s.model.name).map((s) => lower(s.fromName!)));
  const deletes = [...new Set((ops.delete ?? []).map(lower))].filter((name) => !renamedFrom.has(name));
  const moves = ops.move ?? [];

  // --- The library before, as attach reads it ------------------------------------------------
  const attachTables: DbmlAttachTable[] = [...snapshot.tables.values()].map((t) => ({
    table: { name: t.name, columns: t.columns.map((c) => ({ name: c, dataType: '', description: '', ...((t.primaryKey ?? []).some((k) => lower(k) === lower(c)) ? { isPrimaryKey: true } : {}) })) },
    folder: t.folder,
    storage: t.storage,
    ...(t.dbmlAlias !== undefined ? { dbmlAlias: t.dbmlAlias } : {}),
  }));
  const lookup = dbmlTableLookup(attachTables);
  const readings = [...snapshot.relationshipsFiles.entries()].map(([path, reading]) => ({ path, reading }));
  const attachment = attachRelationships(readings, lookup);
  /** Each relationships file's Refs, with their owners (lower-case) and texts. */
  const stored = new Map<string, Array<{ owner: string; unit: RefUnit; text: string }>>();
  for (const { path, reading } of readings) {
    if (!reading.readable) continue;
    const text = snapshot.readText(path) ?? '';
    const list: Array<{ owner: string; unit: RefUnit; text: string }> = [];
    for (const ref of reading.refs) {
      const read = storedUnit(ref, lookup);
      if (!read) continue;
      list.push({ owner: lower(read.unit.from), unit: read.unit, text: text.slice(ref.start, ref.fullEnd).replace(/\r?\n$/, '') });
    }
    stored.set(path, list);
  }
  /** Each relationships file's pending relationships (D27): the tables they name, lower-case. */
  const pendingNames = new Map<string, Set<string>>();
  for (const { path, reading } of readings) {
    const names = new Set<string>();
    for (const ref of reading.pending ?? []) {
      for (const rel of ref.relationships.slice(0, 1)) {
        names.add(lower(lookup(rel.fromModel)?.table.name ?? rel.fromModel));
        names.add(lower(lookup(rel.toModel)?.table.name ?? rel.toModel));
      }
    }
    if (names.size > 0) pendingNames.set(path, names);
  }

  // --- 1. The path overlay ------------------------------------------------------------------
  const after = new Map<string, DbmlPlannedTable>();
  const resolvedOf = (t: DbmlSnapshotTable): DbmlPlannedTable => {
    const columns = t.columns;
    return {
      name: t.name,
      reference: t.reference,
      columns: (col) => columns.find((c) => c === col) ?? columns.find((c) => lower(c) === lower(col)),
      path: t.path,
      storage: t.storage,
      ...(t.primaryKey ? { primaryKey: t.primaryKey } : {}),
    };
  };
  for (const [key, t] of snapshot.tables) after.set(key, resolvedOf(t));

  const writes: FileWrite[] = [];
  const pathChanged = new Map<string, string | null>();
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
  const plannedTable = (text: string, path: string, model: SemanticTable): DbmlPlannedTable => {
    const reading = parseTableDbml(text, stemOf(path));
    const columns = reading.ok ? (reading.table.columns ?? []).map((c) => c.name) : (model.columns ?? []).map((c) => c.name);
    const pk = reading.ok ? (reading.table.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name) : (model.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name);
    return {
      name: reading.ok ? reading.table.name : model.name,
      reference: reading.ok ? reading.declaredReference : dbmlName(model.name),
      columns: (col) => columns.find((c) => c === col) ?? columns.find((c) => lower(c) === lower(col)),
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
  const newFolder = folderAsListed(ops.newTableFolder ?? '');
  for (const { model, fromName } of saves) {
    const sourceKey = lower(fromName ?? model.name);
    const t = snapshot.tables.get(sourceKey);
    const renamed = t !== undefined && fromName !== undefined && fromName !== model.name;
    if (t && t.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    let path: string;
    let text: string;
    if (!t || renamed) refuseReserved(model.name, t ? t.path : tableFilePath(newFolder, model.name));
    if (!t) {
      path = tableFilePath(newFolder, model.name);
      if (snapshot.files.has(path)) refuse(path, `${path} already exists; choose another name.`);
      text = renderNewTableDbml(model);
      writes.push({ kind: 'create', path, text });
    } else if (renamed) {
      path = `${dirOf(t.path)}/${model.name}.dbml`;
      text = editTableDbml(tableText(t.path), model, { rename: true, file: t.path, fileStem: stemOf(t.path) });
      writes.push({ kind: 'create', path, text }, { kind: 'delete', path: t.path });
      after.delete(sourceKey);
      renames.set(sourceKey, model.name);
      pathChanged.set(sourceKey, path);
    } else {
      path = t.path;
      const old = tableText(t.path);
      text = editTableDbml(old, model, { file: t.path, fileStem: stemOf(t.path) });
      if (text !== old) writes.push({ kind: 'replace', path, text });
    }
    const planned = plannedTable(text, path, model);
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

  // Moves (organise): the file goes to the folder; its Refs go to that folder's file.
  for (const { name, toFolder } of moves) {
    const key = lower(name);
    const current = after.get(key);
    const t = snapshot.tables.get(key);
    if (!current || !t) continue;
    if (current.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    refuseReserved(stemOf(current.path), current.path);
    const path = tableFilePath(folderAsListed(toFolder), stemOf(current.path));
    if (path === current.path) continue;
    const pending = writes.findIndex((w) => w.path === current.path && w.kind !== 'delete');
    const text = pending >= 0 ? (writes[pending] as { text: string }).text : tableText(current.path);
    if (pending >= 0) writes.splice(pending, 1);
    writes.push({ kind: 'create', path, text });
    if (!writes.some((w) => w.kind === 'delete' && w.path === t.path)) writes.push({ kind: 'delete', path: t.path });
    after.set(key, { ...current, path });
    pathChanged.set(key, path);
    if (!affected.has(key)) {
      affected.set(key, { name: current.name, relationships: attachment.byOwner.get(key) ?? [] });
      oldNameOf.set(key, key);
    }
  }

  /** A unit (ends named after the plan) with the columns this plan renames spelled anew. */
  const withRenamedColumns = (unit: RefUnit): RefUnit => {
    if (columnRenames.size === 0) return unit;
    const spell = (table: string, column: string): string => columnRenames.get(lower(table))?.get(lower(column)) ?? column;
    return { ...unit, fromColumns: unit.fromColumns.map((c) => spell(unit.from, c)), toColumns: unit.toColumns.map((c) => spell(unit.to, c)) };
  };
  const renamedName = (name: string): string => renames.get(lower(name)) ?? name;

  const resolveTable = (name: string): DbmlPlannedTable | undefined => {
    const key = renames.get(lower(name)) !== undefined ? lower(renames.get(lower(name))!) : lower(name);
    return after.get(key) ?? [...after.values()].find((t) => lower(t.name) === lower(name));
  };

  // --- 3. Relationships files -----------------------------------------------------------------
  const created = new Set(writes.filter((w) => w.kind === 'create').map((w) => w.path));
  const deleted = new Set(writes.filter((w) => w.kind === 'delete').map((w) => w.path));
  const edits = new Map<string, {
    owners: Map<string, { name: string; relationships: readonly TableRelationship[] } | null>;
    incoming: Array<{ text: string; unit: RefUnit }>;
  }>();
  const editFor = (file: string) => {
    let e = edits.get(file);
    if (!e) {
      e = { owners: new Map(), incoming: [] };
      edits.set(file, e);
    }
    return e;
  };
  const touchedLinks = new Set<string>();
  for (const [key, entry] of affected) {
    const oldKey = oldNameOf.get(key) ?? key;
    const home = entry ? relationshipsFileOf(after.get(key)!.path) : undefined;
    const desiredUnits = entry ? relationshipUnits(entry.name, entry.relationships) : [];
    const desiredIds = new Set(desiredUnits.map(unitIdentity));
    for (const u of desiredUnits) for (const l of unitLinks(u)) touchedLinks.add(l);
    // The owner's Refs in every file other than its home leave that file; the ones it keeps travel home verbatim.
    for (const [file, refs] of stored) {
      if (file === home) continue;
      const mine = refs.filter((r) => r.owner === oldKey);
      if (mine.length === 0) continue;
      editFor(file).owners.set(oldKey, null);
      if (!entry) continue;
      for (const r of mine) {
        const unit = withRenamedColumns({ ...r.unit, from: entry.name, to: renamedName(r.unit.to) });
        if (desiredIds.has(unitIdentity(unit))) editFor(home!).incoming.push({ text: r.text, unit: { ...r.unit } });
      }
    }
    if (entry && home) editFor(home).owners.set(key, entry);
  }
  // D20: a relationship this plan writes from a DBML owner may name only DBML tables (Convert writes it pending, D27).
  for (const [key, entry] of affected) {
    if (!entry || ops.writePending) continue;
    const before = new Set(relationshipUnits(entry.name, attachment.byOwner.get(oldNameOf.get(key) ?? key) ?? [])
      .map((u) => unitIdentity(withRenamedColumns({ ...u, to: renamedName(u.to) }))));
    for (const unit of relationshipUnits(entry.name, entry.relationships)) {
      if (before.has(unitIdentity(unit))) continue;
      for (const end of [unit.from, unit.to]) {
        if (resolveTable(end)?.storage === 'yaml') {
          refuse(relationshipsFileOf(after.get(key)!.path), `Can't store the relationship ${describeUnit(unit)}: ${end} is a YAML table, and a DBML table's relationships can only name DBML tables. ${DBML_CONVERT_FIRST_MESSAGE}.`);
        }
      }
    }
  }
  // Files whose Refs name a renamed, moved or deleted table: their ends and use lines follow.
  // A table new in this plan gains its file too: a pending line naming it may turn live (D27).
  const newTables = saves.filter((s) => !snapshot.tables.has(lower(s.fromName ?? s.model.name))).map((s) => s.model.name);
  const changedNames = new Set<string>([...pathChanged.keys(), ...(ops.gainFile ?? []).map(lower), ...newTables.map(lower)]);
  const pathChangedAfter = new Set<string>([...(ops.gainFile ?? []), ...newTables].map((name) => lower(renamedName(name))));
  for (const [oldKey, newPath] of pathChanged) {
    if (newPath === null) pathChangedAfter.add(oldKey);
    else pathChangedAfter.add(lower(renames.get(oldKey) ?? oldKey));
  }
  // And files whose Refs name a column this plan renames: the column token follows.
  const namesRenamedColumn = (table: string, columns: readonly string[]): boolean => {
    const renamedHere = columnRenamesBefore.get(lower(table));
    return renamedHere !== undefined && columns.some((c) => renamedHere.has(lower(c)));
  };
  for (const [file, refs] of stored) {
    if (refs.some((r) => changedNames.has(lower(r.unit.from)) || changedNames.has(lower(r.unit.to))
      || namesRenamedColumn(r.unit.from, r.unit.fromColumns) || namesRenamedColumn(r.unit.to, r.unit.toColumns))) editFor(file);
  }
  for (const [file, names] of pendingNames) {
    if ([...names].some((n) => changedNames.has(n))) editFor(file);
  }
  // Convert: every file with a pending line that can be a live Ref now (both ends have .dbml files with those columns).
  if (ops.writePending) {
    for (const { path, reading } of readings) {
      const ready = (reading.pending ?? []).some((ref) => ref.relationships.length > 0 && ref.relationships.every((r) => {
        const from = resolveTable(r.fromModel);
        const to = resolveTable(r.toModel);
        return from?.storage === 'dbml' && to?.storage === 'dbml' && from.columns(r.fromColumn) !== undefined && to.columns(r.toColumn) !== undefined;
      }));
      if (ready) editFor(path);
    }
  }

  // --- 5. Cross-file duplicates, on the library as it will be -------------------------------------
  {
    const holders = new Map<string, string[]>();
    const affectedOld = new Set(oldNameOf.values());
    const add = (link: string, where: string): void => { holders.set(link, [...(holders.get(link) ?? []), where]); };
    for (const [file, refs] of stored) {
      const owners = edits.get(file)?.owners;
      for (const r of refs) {
        if (owners?.has(r.owner) || affectedOld.has(r.owner)) continue; // rewritten below (or dropped)
        for (const l of unitLinks(r.unit)) add(l, file);
      }
    }
    for (const [file, e] of edits) {
      for (const [, entry] of e.owners) {
        if (!entry) continue;
        for (const u of relationshipUnits(entry.name, entry.relationships)) for (const l of unitLinks(u)) add(l, file);
      }
    }
    for (const link of touchedLinks) {
      const where = holders.get(link) ?? [];
      if (where.length > 1) {
        const [a, b] = [where[0], where[1]];
        const [x, y] = link.split('\u0000');
        refuse(b, `${a === b ? `${a} holds` : `${a} and ${b} both hold`} the relationship ${x} → ${y}${a === b ? ' twice' : ''}. Remove one of them first.`);
      }
    }
  }

  // --- One write per relationships file ----------------------------------------------------------
  const resolveForWriter = (name: string): DbmlResolvedTable | undefined => resolveTable(name);
  const createdRelationshipsFiles: string[] = [];
  for (const [file, e] of edits) {
    const exists = snapshot.relationshipsFiles.has(file) || snapshot.files.has(file);
    const oldText = exists ? snapshot.readText(file) : null;
    if (exists && oldText === null) refuse(file, `${file} could not be read; nothing was changed.`);
    if (oldText === null && ![...e.owners.values()].some((o) => o && o.relationships.length > 0) && e.incoming.length === 0) continue;
    const fileEdit: RelationshipsFileEdit = {
      filePath: file,
      owners: e.owners,
      ...(renames.size > 0 ? { renamedOwners: renames } : {}),
      ...(columnRenames.size > 0 ? { renamedColumns: columnRenames } : {}),
      ...(e.incoming.length > 0 ? { incoming: e.incoming } : {}),
      ...(pathChangedAfter.size > 0 ? { pathChanged: pathChangedAfter } : {}),
      ...(ops.writePending ? { writePending: true } : {}),
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
    relationshipsFilesFor(names) {
      const out: string[] = [];
      for (const name of names) {
        const t = resolveTable(name);
        if (!t || t.storage !== 'dbml') continue;
        const file = relationshipsFileOf(t.path);
        if (fileExists(file) && !out.includes(file)) out.push(file);
      }
      return out;
    },
    fileExists,
    createdRelationshipsFiles,
    pathChanged,
    createdTables: newTables,
  };

  function unitsKey(owner: string, list: readonly TableRelationship[]): string {
    return relationshipUnits(owner, list).map(unitIdentity).sort().join('\n');
  }
}
