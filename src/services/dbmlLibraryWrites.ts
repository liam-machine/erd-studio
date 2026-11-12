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
  normalisePosix,
  qualifiedRef,
  resolvePosix,
  tableIdKey,
  tableIdOfPath,
} from '@erd-studio/core';
import type { DbmlAttachTable, DbmlRelationshipsReading, TableId } from '@erd-studio/core';
import {
  DBML_CONVERT_FIRST_MESSAGE,
  DbmlEditRefused,
  applyTextEdits,
  parseTableDbml,
  readRelationshipsDbml,
  refEndsDbml,
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
import type { IndexLookup, IndexedRef, IndexedTable, RelationshipsIndex } from './dbmlRelationshipsIndex';
import { refuseAmbiguousTableName } from './ambiguousTableName';
import type { DbmlResolvedTable, RefUnit, RelationshipsFileEdit } from '@erd-studio/core/dbml';

import type { FileWrite } from './fileWrites';
import { mergeFileWrites } from './fileWrites';
import { isSchemaFolderName } from '../types/schemaFolder';
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
  /**
   * The table's reference in the library where it differs from its name:
   * `<schema folder>.<name>`, for a name tables in two schema folders share.
   * Its key in {@link DbmlLibrarySnapshot.tables}.
   */
  ref?: string;
}

/** What the planner reads (§2.4 step 1). */
export interface DbmlLibrarySnapshot {
  /** The semantic dir, for messages only. */
  semanticDir: string;
  /**
   * Every table file the library lists (winners only), keyed lower-case by
   * its library reference: its name, or its `ref` where tables in two schema
   * folders share the name.
   */
  tables: Map<string, DbmlSnapshotTable>;
  /**
   * The library tells tables apart by identity (`TableLibraryService` always
   * sets it): its relationships index and attach resolve a Ref end by the
   * relationships file's own `use` line and its qualifier, and name tables by
   * reference. A snapshot built without it is planned by name alone, which
   * gives the same writes while no two tables share a name.
   */
  schemaScopedNames?: boolean;
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
  /** DBML tables only: see {@link DbmlLibrarySave}. */
  save?: DbmlLibrarySave[];
  /** Tables whose file is deleted: each by its identity, or by a name only one table has. */
  delete?: Array<string | TableId>;
  /**
   * A table to another layer and/or schema folder (Organise); its Refs stay
   * where they are. `table` (its identity) names it where given, else `name`.
   */
  move?: Array<{ name: string; table?: TableId; toLayer?: string; toSchema?: string }>;
  /**
   * Tables whose file declares them with no schema (`Table adresse`) to
   * declare in their schema folder's (`Table bqs.adresse`), in place: the
   * file is not moved, and every `use` specifier and Ref end naming one is
   * re-spelled with the qualified name (as a move to another schema does).
   * DBML reads an unqualified Table as `public.<name>`, so two of them in
   * one diagram or relationships file are one table to every other DBML
   * tool ([3003]). A table already qualified, under `public/`, or that does
   * not read is left as it is. By identity.
   */
  qualify?: TableId[];
  /**
   * With `qualify`: the table each Ref end means whose spelling two of its
   * file's `use` lines give to different tables of `qualify` and whose
   * columns do not decide it ({@link decideSharedSpellingEnds}), as the user
   * chose it. An end neither decides refuses the plan.
   */
  qualifyEnds?: SharedSpellingEndChoice[];
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
  gainFile?: Array<string | TableId>;
  /**
   * Convert only: a relationship that cannot be a live Ref yet (an end with
   * no `.dbml` table file, a YAML end, or a missing column) is written as a
   * pending line (D27) instead of being refused.
   */
  writePending?: boolean;
  /**
   * Convert only: every NEW Ref goes to its foreign-key table's layer default
   * file (`placeNewRef`'s rule 2), never to the file already holding the most
   * of its Refs (rule 1), so where Convert writes a Ref never depends on what
   * an earlier run or a hand edit left. A Ref already stored stays where it is.
   */
  newRefsToLayerDefault?: boolean;
  /**
   * The New Relationship dialog's pick (one relationship being added): every
   * NEW unit holding one of `links` (core `linkKey`; a composite's pairs are
   * one unit) goes to `file`, an existing, readable relationships file
   * (semantic-relative, as the snapshot lists it, any case), instead of where
   * `placeNewRef` says. Only the first placement changes: the table's later
   * Refs follow it by rule 1. It never moves a stored Ref: a unit of these
   * links already held in another file (a composite taking in a single) is
   * refused rather than left where the user did not choose.
   */
  newRefFile?: NewRefFileChoice;
}

/**
 * One table to write (D-4: every save says which table it is). `create`: a
 * new table, never matched to an existing one; its identity is its home's
 * schema folder and its name, so a table of that name in another schema
 * folder is no reason to edit it (and, with the library told apart by
 * identity, no reason to refuse it). `from`: the existing table it edits or
 * renames, by identity. With neither, the save is an edit of the table
 * `fromName ?? model.name` names (a rename when the two differ), or a new
 * table when none has that name; such an edit is refused when its own
 * `home` disagrees with the table's folder, since the caller meant another
 * table. The model's `name` is always a bare table name (never a diagram's
 * `<schema>.<name>` reference; a model with a `tableName` is refused).
 *
 * `asWritten` (Convert only): the table's file already holds exactly this
 * table, as `renderNewTableDbml` wrote it from this model, so the plan
 * neither edits nor re-reads it and only places its relationships. `home`
 * (a new table only) wins over `newTableHome`, for a batch whose new tables
 * go to different layers.
 */
export interface DbmlLibrarySave {
  model: DbmlDraftTable;
  fromName?: string;
  from?: TableId;
  create?: boolean;
  asWritten?: boolean;
  home?: DbmlTableHome;
}

/** Where the New Relationship dialog asks a new relationship to be saved ({@link DbmlLibraryOps.newRefFile}). */
export interface NewRefFileChoice {
  /** The relationships file, posix, relative to the semantic dir. */
  file: string;
  /** The new relationship's column pairs, as core `linkKey`s. */
  links: readonly string[];
}

/** A table as the plan leaves it. */
export type DbmlPlannedTable = DbmlResolvedTable;

/** The plan (§2.4 step 7). */
export interface DbmlLibraryWritePlan {
  writes: FileWrite[];
  /** A table after the plan: real name, declared reference, real column spellings, path, storage. */
  resolveTable(name: string): DbmlPlannedTable | undefined;
  /**
   * The relationships files a diagram showing `members` (its `use` members)
   * and `unlinked` (its `erd_unlinked_tables`) imports after the plan
   * (`relationshipsImportsFor` over the after-index): every file holding a
   * live Ref with both ends among the members, every file holding a pending
   * line with both ends among the members or unlinked, plus every file of
   * `current` (its imports now) that does not read. Byte-sorted; only files
   * that exist after.
   */
  relationshipsImportsFor(members: Iterable<IndexedTable>, current?: readonly string[], unlinked?: Iterable<string>): string[];
  /** The table pairs (`pairKey`) whose set of files holding a Ref or a pending line the plan changes. */
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
  /**
   * The table whose file was `path` before the plan (any case), as the plan
   * leaves it: null when the plan deletes it, undefined when no table was
   * there. How a diagram's member is found by its `use` path, never by a
   * name another schema folder may share.
   */
  tableAtPath?(path: string): DbmlPlannedTable | null | undefined;
  /** The files of the tables this plan creates (in {@link createdTables}' order). */
  createdTablePaths?: string[];
  /**
   * Set when the library tells tables apart by identity (`schemaScopedNames`):
   * the plan's names are library references (`ccc.addresse` where two schema
   * folders share `addresse`), its relationships indexes carry identities,
   * {@link changedPairs} names pairs by identity keys (`ccc/addresse`), and
   * these sets hold the identity keys the plan touches, before and after, so
   * the settle compares a diagram's members by the files they read.
   */
  identities?: {
    /** Tables whose path changes or that are deleted: identity keys before and after. */
    pathChanged: ReadonlySet<string>;
    /** Tables the plan creates. */
    created: ReadonlySet<string>;
    /** Tables moved to another schema folder, before and after. */
    requalified: ReadonlySet<string>;
    /** Lower-case paths before the plan of every table whose path changes, that is deleted or re-qualified. */
    changedPaths: ReadonlySet<string>;
  };
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
 * Whether a schema can be a NEW schema folder, the one check every writer
 * shares (`src/types/schemaFolder.ts`, so the New Table dialog checks the
 * same rule). Otherwise the caller falls back (the home's schema here;
 * Convert's next step).
 */
export { isSchemaFolderName };

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
function attachTablesOf(snapshot: Pick<DbmlLibrarySnapshot, 'tables' | 'schemaScopedNames'>): DbmlAttachTable[] {
  return [...snapshot.tables.values()].map((t) => ({
    table: { name: t.name, columns: t.columns.map((c) => ({ name: c, dataType: '', description: '', ...((t.primaryKey ?? []).some((k) => lower(k) === lower(c)) ? { isPrimaryKey: true } : {}) })) },
    storage: t.storage,
    ...(t.dbmlAlias !== undefined ? { dbmlAlias: t.dbmlAlias } : {}),
    // Told apart by identity: the file a `use` line can name, the folder a qualifier can, the name Refs are attached under.
    ...(snapshot.schemaScopedNames ? { path: t.path, ...(t.schema !== undefined ? { schema: t.schema } : {}), ...(t.ref !== undefined ? { ref: t.ref } : {}) } : {}),
  }));
}

/**
 * The lookup the planner, its index and the attach resolve Ref ends with.
 * Told apart by identity, it knows which files exist (rule 2(d): a stale
 * qualifier lands on the one table of its name unless its `use` line names
 * another file that exists), as the library's own attach does.
 */
function lookupOf(snapshot: Pick<DbmlLibrarySnapshot, 'tables' | 'schemaScopedNames' | 'files'>): IndexLookup {
  if (!snapshot.schemaScopedNames) return dbmlTableLookup(attachTablesOf(snapshot));
  const listed = new Set([...snapshot.files].map(lower));
  return dbmlTableLookup(attachTablesOf(snapshot), { exists: (p) => snapshot.files.has(p) || listed.has(lower(p)) });
}

/** The snapshot's relationships files as the attach reads them: with their own path as `semanticPath` when tables are told apart by identity. */
function attachReadingsOf(snapshot: Pick<DbmlLibrarySnapshot, 'relationshipsFiles' | 'schemaScopedNames'>): Array<{ path: string; reading: DbmlRelationshipsReading; semanticPath?: string }> {
  return [...snapshot.relationshipsFiles.entries()].map(([path, reading]) => ({ path, reading, ...(snapshot.schemaScopedNames ? { semanticPath: path } : {}) }));
}

/**
 * The relationships `name` owns in the snapshot's relationships files, as
 * the planner's own attach step reads them (a table's complete list, for a
 * save that keeps them: a rename planned from a snapshot, not a canvas).
 */
export function ownedRelationshipsOf(snapshot: Pick<DbmlLibrarySnapshot, 'tables' | 'relationshipsFiles' | 'schemaScopedNames' | 'files'>, name: string): TableRelationship[] {
  const owned = attachRelationships(attachReadingsOf(snapshot), lookupOf(snapshot)).byOwner.get(lower(name));
  return owned ? structuredClone(owned) : [];
}

/**
 * The index of the snapshot's relationships files (§2.4 "one snapshot, one
 * index"): their Refs and pending lines, which files do not read, and the
 * tables each file's `use` lines name.
 */
export function relationshipsIndexOf(
  snapshot: Pick<DbmlLibrarySnapshot, 'tables' | 'relationshipsFiles' | 'schemaScopedNames' | 'files'>,
  lookup: IndexLookup = lookupOf(snapshot),
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
  return buildRelationshipsIndex({
    files: [...snapshot.relationshipsFiles.keys()], refs, unreadable, useTargets,
    ...(snapshot.schemaScopedNames ? { identities: true } : {}),
  });
}

/**
 * Plan the writes for `ops` against `snapshot` (§2.4). Throws
 * `DbmlEditRefused` for an edit it will not write: a table file or
 * relationships file that does not read, a relationship stored twice or
 * already stored elsewhere, a relationship from a DBML table to a YAML one
 * (D20), a relationship added while a relationships file does not read.
 */
export function planDbmlLibraryWrites(snapshot: DbmlLibrarySnapshot, ops: DbmlLibraryOps): DbmlLibraryWritePlan {
  // --- Qualify: every Ref end two use lines spell alike is told its table first (its columns, else the user's pick) ---
  const decidedText = new Map<string, string>();
  if ((ops.qualify?.length ?? 0) > 0) {
    const decided = decideSharedSpellingEnds(snapshot, ops.qualify!, ops.qualifyEnds ?? []);
    if (decided.undecided.length > 0) {
      const first = decided.undecided[0];
      const tables = listNames(first.candidates.map((c) => `${c.schema}.${c.name}`));
      refuse(first.file, `${first.file} line ${first.line}: ${first.refText} names ${first.spelling}, which more than one table is imported as, and its columns do not say which (${first.fitting === 0 ? `neither ${tables} has ${first.endText}` : `${tables} both have them`}). Write the end as <schema>.${first.spelling}; nothing was changed.`, first.line);
    }
    for (const [file, reading] of decided.snapshot.relationshipsFiles) {
      if (reading !== snapshot.relationshipsFiles.get(file)) decidedText.set(file, decided.snapshot.readText(file)!);
    }
    // An edit's table whose relationships still name the shared spelling names the table its Ref was told.
    if (ops.save && decided.decidedRefs.length > 0) {
      const told = decided.decidedRefs;
      const before = snapshot;
      ops = { ...ops, save: ops.save.map((save) => withToldEnds(save, told, before)) };
    }
    snapshot = decided.snapshot;
  }
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

  // --- Tables by identity and by name -------------------------------------------------------
  // Told apart by identity (`schemaScopedNames`), the snapshot's keys are library references
  // (`ccc.addresse` where two schema folders share `addresse`), and every op is turned into one
  // of them here, once: by its TableId, or by a string only one table answers to.
  const scoped = snapshot.schemaScopedNames === true;
  /** A table's identity: a DBML file's schema folder and stem; a YAML table's name. */
  const idOf = (t: Pick<DbmlSnapshotTable, 'path' | 'name' | 'storage'>): TableId =>
    (t.storage === 'dbml' ? tableIdOfPath(t.path) : undefined) ?? { schema: '', name: t.name };
  const keyById = new Map<string, string>();
  const keysByName = new Map<string, string[]>();
  for (const [key, t] of snapshot.tables) {
    const id = tableIdKey(idOf(t));
    if (!keyById.has(id)) keyById.set(id, key);
    const named = keysByName.get(lower(t.name)) ?? [];
    keysByName.set(lower(t.name), named);
    named.push(key);
  }
  /**
   * The snapshot key of the table `table` names, or undefined when none: a
   * TableId's own table; a string as the key it is (a name, or a library
   * reference), else (told apart by identity) the one table of that name. A
   * name tables in two schema folders share throws `AmbiguousTableName`
   * (D-5): it is never answered with the first of them.
   */
  const keyOf = (table: string | TableId): string | undefined => {
    if (typeof table !== 'string') return keyById.get(tableIdKey(table));
    if (snapshot.tables.has(lower(table))) return lower(table);
    if (!scoped) return undefined;
    const named = keysByName.get(lower(table)) ?? [];
    if (named.length > 1) refuseAmbiguousTableName(table, named.map((k) => idOf(snapshot.tables.get(k)!)));
    return named[0];
  };
  /**
   * D-4 and D-7: a table that a create, rename or move gives the identity
   * `(schema, name)` must not meet another table of that identity in any
   * layer or case-twin folder (DBML cannot tell them apart), nor a YAML table
   * of that name; told apart by name alone, no other table may have the
   * name. `self` is the table being renamed or moved. The refusal names the
   * other file.
   */
  const refuseTaken = (name: string, schema: string, path: string, self: string | undefined, outcome: string): void => {
    const others = (keysByName.get(lower(name)) ?? []).filter((k) => k !== self && after.has(k));
    const clash = scoped
      ? others.find((k) => tableIdKey(idOf(snapshot.tables.get(k)!)) === tableIdKey({ schema, name })) ?? others.find((k) => snapshot.tables.get(k)!.storage === 'yaml')
      : others[0];
    if (clash === undefined) return;
    const other = snapshot.tables.get(clash)!;
    const layer = dbmlTreePathOf(other.path)?.layer;
    refuse(path, scoped && other.storage === 'dbml'
      ? `${qualifiedRef(schema, name)} already exists${layer !== undefined ? ` in layer ${layer}` : ''} (${other.path}); ${outcome}`
      : `${other.path} already holds a table named ${other.name}; ${outcome}`);
  };

  // --- 0. Normalise: a delete of a rename's old name is part of the rename ------------------
  const saves = (ops.save ?? []).map((s) => ({ ...s }));
  for (const { model } of saves) {
    // A diagram's `<schema>.<name>` reference is never a table's name: it would be written into its file.
    if ((model as { tableName?: unknown }).tableName !== undefined) {
      throw new Error(`planDbmlLibraryWrites: ${model.name} is named as a diagram names it; save the table under its own name.`);
    }
  }
  const oldNameOfSave = (s: DbmlLibrarySave): string | undefined => (s.from !== undefined ? s.from.name : s.fromName);
  const isRename = (s: DbmlLibrarySave): boolean => oldNameOfSave(s) !== undefined && oldNameOfSave(s) !== s.model.name;
  /** Each save's table before the plan (its snapshot key); undefined for a new one. */
  const sourceKeys = saves.map((s) => (s.create ? undefined : keyOf(s.from ?? s.fromName ?? s.model.name)));
  const renamedFrom = new Set(saves.flatMap((s, i) => (isRename(s) ? [sourceKeys[i] ?? lower(s.fromName ?? s.model.name)] : [])));
  const deletes = [...new Set((ops.delete ?? []).flatMap((d) => {
    const key = typeof d === 'string' && !scoped ? lower(d) : keyOf(d);
    return key === undefined ? [] : [key];
  }))].filter((key) => !renamedFrom.has(key));
  const moves = ops.move ?? [];
  /** Tables that gain their file, by key. */
  const gained = (ops.gainFile ?? []).flatMap((g) => {
    const key = typeof g === 'string' && !scoped ? lower(g) : keyOf(g);
    return key === undefined ? [] : [key];
  });

  // --- The library before: its attachment and its one index ----------------------------------
  const lookup = lookupOf(snapshot);
  const readings = attachReadingsOf(snapshot);
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
  /** How the plan names each table, by key: its library reference (its name, unless two schema folders share it). */
  const labelOf = new Map<string, string>();
  for (const [key, t] of snapshot.tables) labelOf.set(key, scoped ? t.ref ?? t.name : t.name);
  /**
   * The names more than one table this plan creates or renames into takes
   * (two schema folders each getting an `addresse` in one Import): each of
   * them is `<schema>.<name>` from the start, so the first is never the bare
   * name a unit naming the other would resolve to.
   */
  const formedTwice = new Set<string>();
  {
    const seen = new Set<string>();
    saves.forEach((s, i) => {
      if (!s.create && sourceKeys[i] !== undefined && !isRename(s)) return;
      const bare = lower(s.model.name);
      if (seen.has(bare)) formedTwice.add(bare);
      seen.add(bare);
    });
  }
  /**
   * The key of a table new or renamed in this plan: its name, unless (told
   * apart by identity) a table of that name stays or this plan forms
   * another, then `<schema>.<name>`. Existing tables keep their keys for the
   * whole plan, so a twin appearing never changes what the plan calls its
   * namesake.
   */
  const keyFor = (name: string, schema: string | undefined, self?: string): string => {
    const bare = lower(name);
    if (!scoped || schema === undefined) return bare;
    const stays = (keysByName.get(bare) ?? []).some((k) => k !== self && after.has(k));
    return after.has(bare) || stays || formedTwice.has(bare) ? lower(qualifiedRef(schema, name)) : bare;
  };
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
  const newTables: string[] = [];
  const createdKeys: string[] = [];
  const createdPaths: string[] = [];
  for (const [at, save] of saves.entries()) {
    const { model: draft, asWritten, home } = save;
    const { configuredSchema, ...given } = draft;
    let model: SemanticTable = given;
    const sourceKey = sourceKeys[at] ?? lower(save.fromName ?? model.name);
    const t = save.create ? undefined : snapshot.tables.get(sourceKey);
    if (save.from !== undefined && !t) {
      refuse('', `The table ${qualifiedRef(save.from.schema, save.from.name)} is not in the table library; nothing was changed.`);
    }
    const renamed = t !== undefined && isRename(save);
    if (t && t.storage !== 'dbml') throw new Error(`planDbmlLibraryWrites: ${t.name} is not a DBML table`);
    // D-4: an edit named by its name alone whose own home is another folder meant another table.
    if (t && save.from === undefined && home !== undefined) {
      const tree = dbmlTreePathOf(t.path);
      if (tree?.kind === 'table' && (lower(tree.layer) !== lower(home.layer) || lower(tree.schema ?? '') !== lower(home.schema))) {
        refuse(t.path, `${t.path} already holds the table ${t.name}, which is not in ${home.layer}/tables/${home.schema}/; the change does not say whether it means that table or a new one, so nothing was changed.`);
      }
    }
    let path: string;
    let text: string;
    if (!t) {
      // §2.4 step 2: the layer is the home's; the schema is the source's (Import, Convert), else the
      // one the developer configured, else the home's; spelled as the layer's tables/ lists it.
      const where = home ?? ops.newTableHome ?? defaultHome();
      const requested = ops.schemaFromSource ? model.schema || where.schema : configuredSchema || where.schema;
      const schema = schemaAsListed(where.layer, isSchemaFolderName(requested) ? requested : where.schema);
      plannedSchemas.set(`${lower(where.layer)}\u0000${lower(schema)}`, schema);
      model = { ...model, schema };
      path = dbmlTablePath(where.layer, schema, model.name);
      if (save.create) refuseTaken(model.name, schema, path, undefined, 'choose another name.');
      if (fileListed(path)) refuse(path, `${path} already exists; choose another name.`);
      text = renderNewTableDbml(model);
      writes.push({ kind: 'create', path, text });
    } else if (renamed) {
      path = `${dirOf(t.path)}/${model.name}.dbml`;
      if (scoped) {
        const schema = dbmlTreePathOf(path)?.schema;
        if (schema !== undefined) refuseTaken(model.name, schema, path, sourceKey, 'choose another name.');
        if (lower(path) !== lower(t.path) && fileListed(path)) refuse(path, `${path} already exists; choose another name.`);
      }
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
    const afterKey = t && !renamed ? sourceKey : keyFor(model.name, dbmlTreePathOf(path)?.schema, t ? sourceKey : undefined);
    if (renamed) {
      labelOf.set(afterKey, scoped && afterKey !== lower(model.name) ? qualifiedRef(dbmlTreePathOf(path)!.schema!, model.name) : model.name);
      renames.set(sourceKey, labelOf.get(afterKey)!);
    } else if (!t) {
      labelOf.set(afterKey, scoped && afterKey !== lower(model.name) ? qualifiedRef(model.schema ?? '', model.name) : model.name);
      newTables.push(model.name);
      createdKeys.push(afterKey);
      createdPaths.push(path);
    }
    after.set(afterKey, planned);
    if (t) {
      const columnsRenamed = renamedColumnsOf(t.columns, (model.columns ?? []).map((c) => c.name));
      if (columnsRenamed.size > 0) {
        columnRenames.set(afterKey, columnsRenamed);
        columnRenamesBefore.set(sourceKey, columnsRenamed);
      }
    }
    // Relationships: placed when they changed, or the owner was renamed or is new. Told apart by
    // identity, an owner's units are named by its library reference, as the index names them.
    const desired = model.relationships ?? [];
    const ownerAfter = scoped ? labelOf.get(afterKey)! : planned.name;
    const ownerBefore = t ? labelOf.get(sourceKey) ?? t.name : undefined;
    const current = t ? attachment.byOwner.get(lower(scoped ? ownerBefore! : t.name)) ?? [] : [];
    const changed = renamed || !t || unitsKey(ownerAfter, desired) !== unitsKey(scoped ? ownerBefore! : t.name, current);
    if (changed && (t || desired.length > 0)) {
      affected.set(afterKey, { name: ownerAfter, relationships: desired });
      oldNameOf.set(afterKey, t ? (scoped ? sourceKey : lower(t.name)) : afterKey);
    }
  }

  // Moves (Organise): the file goes to another layer and/or schema folder; its Refs stay where they are.
  for (const { name, table, toLayer, toSchema } of moves) {
    const key = scoped || table !== undefined ? keyOf(table ?? name) : lower(name);
    if (key === undefined) continue;
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
    if (scoped) refuseTaken(stem, schema, path, key, 'nothing was moved.');
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

  // Qualify in place: an unqualified header declared in its schema folder's schema; the file stays.
  for (const id of ops.qualify ?? []) {
    const key = keyOf(id);
    if (key === undefined) continue;
    const current = after.get(key);
    if (!current || current.storage !== 'dbml' || pathChanged.has(key)) continue;
    const from = dbmlTreePathOf(current.path);
    if (!from || from.kind !== 'table' || from.schema === undefined || lower(from.schema) === 'public') continue;
    const stem = stemOf(current.path);
    const pending = writes.findIndex((w) => w.path === current.path && w.kind !== 'delete');
    const text = pending >= 0 ? (writes[pending] as { text: string }).text : tableText(current.path);
    const reading = parseTableDbml(text, stem, { schemaFolder: from.schema });
    if (!reading.ok) continue;
    if (reading.schemaQualified) {
      // Declared in its folder's schema already (by hand, or by an earlier Qualify): only the `use` lines
      // and Ref ends that still spell it bare are re-spelled, so Qualify never offers a fix it cannot make.
      if (lower(reading.declaredReference) === lower(`${dbmlName(from.schema)}.${dbmlName(reading.declaredName)}`)) requalified.add(key);
      continue;
    }
    // Read without its folder, so the header's missing qualifier is what the edit changes.
    const qualified = editTableDbml(text, { ...reading.table, schema: from.schema }, { requalify: true, file: current.path, fileStem: stem });
    if (qualified === text) continue;
    if (pending >= 0) writes.splice(pending, 1);
    writes.push({ kind: 'replace', path: current.path, text: qualified });
    requalified.add(key);
    after.set(key, { ...current, reference: plannedTable(qualified, current.path, reading.table).reference });
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

  /** Each table's key after the plan by its `<schema folder>.<name>`, lower-case (told apart by identity; built on first use). */
  let keysByQualified: Map<string, string[]> | undefined;
  /** The key after the plan of the table `name` names: a key (renamed tables followed), else its name. */
  const keyAfter = (name: string): string | undefined => {
    const key = renames.get(lower(name)) !== undefined ? lower(renames.get(lower(name))!) : lower(name);
    if (after.has(key)) return key;
    // A name only one table has after the plan; told apart by identity, a shared one names none of them.
    const named = [...after].filter(([, t]) => lower(t.name) === lower(name));
    if (named.length === 1 || (!scoped && named.length > 0)) return named[0][0];
    if (!scoped || named.length > 0) return undefined;
    // A diagram names each table of a pair `<schema folder>.<name>` (D-3), also one the plan still keys by its
    // bare name because the pair forms in this plan (ccc.x renamed to orte beside bqs.orte, which a diagram
    // holding both now calls bqs.orte). `after` is final here, so its qualified names are listed once.
    if (keysByQualified === undefined) {
      keysByQualified = new Map();
      for (const [k, t] of after) {
        const schema = t.storage === 'dbml' ? dbmlTreePathOf(t.path)?.schema : undefined;
        if (schema === undefined) continue;
        const q = lower(qualifiedRef(schema, t.name));
        keysByQualified.set(q, [...(keysByQualified.get(q) ?? []), k]);
      }
    }
    const qualified = keysByQualified.get(lower(name)) ?? [];
    return qualified.length === 1 ? qualified[0] : undefined;
  };
  const resolveTable = (name: string): DbmlPlannedTable | undefined => {
    const key = keyAfter(name);
    return key === undefined ? undefined : after.get(key);
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
  // The New Relationship dialog's pick: a listed relationships file that reads, spelled as listed.
  const chosen = ops.newRefFile;
  const chosenLinks = new Set(chosen?.links ?? []);
  const takesChosen = (unit: RefUnit): boolean => chosen !== undefined && unitLinks(unit).some((l) => chosenLinks.has(l));
  let chosenFile: string | undefined;
  if (chosen) {
    const listed = [...snapshot.relationshipsFiles.keys()];
    chosenFile = listed.find((f) => f === chosen.file) ?? listed.find((f) => lower(f) === lower(chosen.file));
    if (chosenFile === undefined) refuse(chosen.file, `${chosen.file} is not a relationships file of this project; nothing was changed.`);
    if (index.unreadable.has(chosenFile)) {
      const why = notReading(chosenFile);
      refuse(chosenFile, `${why.text}; fix it first, or save the relationship in another file.`, why.line);
    }
    // A unit of these links stored in another file stays there (an existing Ref is never moved).
    for (const plan of ownerPlans) {
      for (const [member, refs] of plan.matched) {
        if (!takesChosen(member.unit)) continue;
        const elsewhere = refs.find((r) => r.file !== chosenFile);
        if (elsewhere) {
          refuse(elsewhere.file, `${describeUnit(member.unit)} takes in a relationship ${elsewhere.file} line ${elsewhere.line} already holds, and an existing relationship is never moved to another file. Save it in ${elsewhere.file}, or leave the file as it is.`, elsewhere.line);
        }
      }
    }
  }
  for (const { plan, member } of newMembers) {
    if (chosenFile !== undefined && takesChosen(member.unit)) {
      placed.set(member, chosenFile);
      continue;
    }
    const owner = after.get(plan.key);
    const placement = placeNewRef(
      {
        table: plan.oldKey,
        layer: owner ? layerOf(owner.path) : defaultHome().layer,
        ...(owner && dbmlTreePathOf(owner.path)?.schema !== undefined ? { schema: dbmlTreePathOf(owner.path)!.schema } : {}),
      },
      index,
      (l) => listedLayers.get(l),
      ops.newRefsToLayerDefault ? { layerDefaultOnly: true } : {},
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
  const changedNames = new Set<string>([...pathChanged.keys(), ...requalified, ...gained, ...createdKeys]);
  const pathChangedAfter = new Set<string>([...gained, ...createdKeys].map((key) => lower(renamedName(key))));
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
  // A use line naming a table Qualify declares in its schema, even with no Ref naming it: never left bare.
  for (const key of requalified) {
    const before = snapshot.tables.get(key);
    if (before) for (const file of index.filesUsing(before.path)) editFor(file);
  }
  // Convert: every file with a pending line that can be a live Ref now (both ends have .dbml files with those columns).
  if (ops.writePending) {
    for (const ref of index.refs) if (ref.pending && liveable(storedAfter(ref))) editFor(ref.file);
  }

  // --- 6. The after-state, without re-reading ------------------------------------------------------
  const pendingBeforeKeys = new Set(pendingBefore.map((u) => unitIdentity(withRenamedColumns({ ...u, from: renamedName(u.from), to: renamedName(u.to) }))));
  // Told apart by identity, a unit's ends keep the plan's names (library references): a twin's real
  // name would make its Refs its namesake's.
  const realName = (name: string): string => {
    if (!scoped) return resolveTable(name)?.name ?? name;
    const key = keyAfter(name);
    return key === undefined ? name : labelOf.get(key) ?? name;
  };
  /** A table's identity key after the plan, by its key; undefined when it has no table after. */
  const idAfter = (key: string): string | undefined => {
    const t = after.get(key);
    return t === undefined ? undefined : tableIdKey(idOf(t));
  };
  /** Told apart by identity, an after-index entry carries its ends' identities, as the index before does. */
  const idsOf = (owner: string, target: string, ref?: IndexedRef): Pick<IndexedRef, 'ownerId' | 'targetId'> => {
    if (!scoped) return {};
    const ownerId = idAfter(owner) ?? ref?.ownerId;
    const targetId = idAfter(target) ?? ref?.targetId;
    return { ...(ownerId !== undefined ? { ownerId } : {}), ...(targetId !== undefined ? { targetId } : {}) };
  };
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
    const owner = lower(renames.get(ref.owner) ?? ref.owner);
    const target = lower(renames.get(ref.target) ?? ref.target);
    afterRefs.push({
      ...ref,
      // The index's names are the real ones already; only a rename changes them.
      owner,
      target,
      ...idsOf(owner, target, ref),
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
        afterRefs.push({ file, owner: lower(unit.from), target: lower(unit.to), ...idsOf(keyAfter(unit.from) ?? lower(unit.from), keyAfter(unit.to) ?? lower(unit.to)), unit, links: unitLinks(unit), pending, line });
      }
    }
  }
  const createdFiles = [...edits.keys()].filter((f) => !snapshot.relationshipsFiles.has(f) && !fileListed(f));
  // A plan that edits no relationships file leaves every Ref where and as it was (a rename names none).
  const afterIndex = edits.size === 0 ? index : buildRelationshipsIndex({
    files: [...index.files, ...createdFiles.filter((f) => afterRefs.some((r) => r.file === f))],
    refs: afterRefs,
    unreadable: index.unreadable,
    ...(scoped ? { identities: true } : {}),
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
  // Ref ends written anew: a table moved to another schema, and one that gains its file (Convert), whose
  // ends a file may spell as it was while it was YAML (`dim`, not `gold.dim`).
  const endsRespelled = new Set<string>([...requalified, ...gained]);
  // Told apart by identity, the writer names each Ref end and `use` specifier by the table its own `use`
  // line and qualifier say (its key before the plan), so an edit of one table never touches its namesake's.
  const identify = scoped
    ? (table: { name: string; qualifier?: string; path?: string; paths?: readonly string[]; columns?: readonly string[] }): string | undefined => {
      const entry = lookup(table.name, {
        ...(table.qualifier !== undefined ? { qualifier: table.qualifier } : {}),
        ...(table.path !== undefined ? { usePath: table.path } : {}),
        ...(table.paths !== undefined ? { usePaths: table.paths, columns: table.columns ?? [] } : {}),
      });
      return entry === undefined ? undefined : entry.ref ?? entry.table.name;
    }
    : undefined;
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
      ...(endsRespelled.size > 0 ? { requalified: endsRespelled } : {}),
      ...(ops.writePending ? { writePending: true } : {}),
      ...(pendingBefore.length > 0 ? { pendingBefore } : {}),
      ...(columnChanges.has(file) ? { columnChanges: columnChanges.get(file)! } : {}),
      ...(identify ? { identify } : {}),
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

  // A relationships file whose ends Qualify told their tables, that the plan wrote nothing else to.
  for (const [file, text] of decidedText) if (!writes.some((w) => w.path === file)) writes.push({ kind: 'replace', path: file, text });
  const merged = mergeFileWrites(writes);
  const fileExists = (p: string): boolean => created.has(p) || (snapshot.files.has(p) && !deleted.has(p));
  /** Each table's key by its file before the plan (lower-case path). */
  const keyAtPath = new Map([...snapshot.tables].map(([key, t]) => [lower(t.path), key]));
  const tableAtPath = (p: string): DbmlPlannedTable | null | undefined => {
    const key = keyAtPath.get(lower(p));
    if (key === undefined) return undefined;
    const renamedTo = renames.get(key);
    return after.get(renamedTo !== undefined ? lower(renamedTo) : key) ?? null;
  };
  let identities: DbmlLibraryWritePlan['identities'];
  if (scoped) {
    const before = (key: string): DbmlSnapshotTable | undefined => snapshot.tables.get(key);
    const idsChanged = new Set<string>();
    const changedPaths = new Set<string>();
    for (const [key, newPath] of pathChanged) {
      const t = before(key);
      if (t) {
        idsChanged.add(tableIdKey(idOf(t)));
        changedPaths.add(lower(t.path));
      }
      const id = newPath === null ? undefined : tableIdOfPath(newPath);
      if (id) idsChanged.add(tableIdKey(id));
    }
    const idsRequalified = new Set<string>();
    for (const key of requalified) {
      const t = before(key);
      if (t) {
        idsRequalified.add(tableIdKey(idOf(t)));
        changedPaths.add(lower(t.path));
      }
      const now = idAfter(key);
      if (now !== undefined) idsRequalified.add(now);
    }
    const idsCreated = new Set(createdPaths.flatMap((p) => {
      const id = tableIdOfPath(p);
      return id ? [tableIdKey(id)] : [];
    }));
    identities = { pathChanged: idsChanged, created: idsCreated, requalified: idsRequalified, changedPaths };
  }
  return {
    writes: merged,
    resolveTable,
    relationshipsImportsFor: (members, current = [], unlinked = []) => importsFor({ members, unlinked }, afterIndex, { current, exists: fileExists }),
    changedPairs: afterIndex === index ? new Set() : changedPairsOf(index, afterIndex),
    requalified: new Set(requalified),
    fileExists,
    createdRelationshipsFiles,
    pathChanged,
    createdTables: newTables,
    createdTablePaths: createdPaths,
    tableAtPath,
    ...(identities ? { identities } : {}),
    index,
    afterIndex,
  };

  function unitsKey(owner: string, list: readonly TableRelationship[]): string {
    return relationshipUnits(owner, list).map(unitIdentity).sort().join('\n');
  }
}


/**
 * A Ref end in a relationships file whose spelling two of the file's `use`
 * lines give to different table files (`use { table adresse }` from
 * tables/bqs/ and from tables/ccc/, as ERD Studio 2.0.4 wrote them), which
 * the end's columns do not decide (both tables have `id`): only the person
 * who drew it knows which table it means. See {@link decideSharedSpellingEnds}.
 */
export interface SharedSpellingEnd {
  /** The relationships file, relative to the semantic dir. */
  file: string;
  /** 1-based line of the Ref. */
  line: number;
  /** Which end of the Ref as written: before or after its operator. */
  side: 'left' | 'right';
  /** The end's table spelling as written (`adresse`). */
  spelling: string;
  /** The Ref as written, on one line. */
  refText: string;
  /** The end as written (`adresse.id`). */
  endText: string;
  /** The tables the spelling's `use` lines import, in line order. */
  candidates: TableId[];
  /** Each candidate's file, relative to the semantic dir. */
  paths: string[];
  /** How many candidates have every column the end names: 0 (none: a broken Ref) or 2 and more. */
  fitting: number;
}

/** The table a {@link SharedSpellingEnd} means, as the person chose it. */
export interface SharedSpellingEndChoice {
  file: string;
  line: number;
  side: 'left' | 'right';
  table: TableId;
}

/** The key a choice is matched by. */
const endChoiceKey = (e: { file: string; line: number; side: string }): string => `${lower(e.file)}\u0000${e.line}\u0000${e.side}`;

/**
 * Before Qualify (`DbmlLibraryOps.qualify`) re-spells the tables in
 * `qualify`, say which table every Ref end means whose spelling its
 * relationships file's `use` lines give to two or more of them: the one
 * whose columns the end names when exactly one has them (the lookup's rule
 * 0, the same answer the canvas draws), else the table `choices` names for
 * that end. Each such end is written `<schema>.<name>` in the snapshot the
 * planner then reads (a table under `public/` keeps its bare name), so the
 * plan re-spells it with its table. Ends neither decides are returned in
 * `undecided`, in file and line order: the caller asks, or refuses. Pure.
 */
export function decideSharedSpellingEnds(
  snapshot: DbmlLibrarySnapshot,
  qualify: readonly TableId[],
  choices: readonly SharedSpellingEndChoice[] = [],
): { snapshot: DbmlLibrarySnapshot; undecided: SharedSpellingEnd[]; decidedRefs: DecidedRefEnds[] } {
  const decidedRefs: DecidedRefEnds[] = [];
  const qualifying = new Set(qualify.map(tableIdKey));
  const chosen = new Map(choices.map((c) => [endChoiceKey(c), c.table]));
  const lookup = lookupOf(snapshot);
  const byPath = new Map([...snapshot.tables.values()].map((t) => [lower(t.path), t]));
  const undecided: SharedSpellingEnd[] = [];
  const decidedText = new Map<string, string>();
  for (const file of [...snapshot.relationshipsFiles.keys()].sort(byteOrder)) {
    const reading = snapshot.relationshipsFiles.get(file)!;
    if (!reading.readable || (reading.useTables?.length ?? 0) < 2) continue;
    // Each spelling's table files, in line order, once per identity.
    const folder = dirnamePosix(file);
    const groups = new Map<string, { paths: string[]; ids: TableId[] }>();
    for (const u of reading.useTables ?? []) {
      const resolved = normalisePosix(resolvePosix(folder, withExtension(u.path)));
      const id = tableIdOfPath(resolved);
      if (id === undefined) continue;
      const key = `${u.qualifier === undefined ? '\u0001' : lower(u.qualifier)}\u0000${lower(u.table)}`;
      const group = groups.get(key) ?? { paths: [], ids: [] };
      groups.set(key, group);
      if (group.ids.some((g) => tableIdKey(g) === tableIdKey(id))) continue;
      group.paths.push(resolved);
      group.ids.push(id);
    }
    for (const [key, group] of groups) if (group.ids.length < 2 || !group.ids.some((id) => qualifying.has(tableIdKey(id)))) groups.delete(key);
    if (groups.size === 0) continue;
    const text = snapshot.readText(file);
    if (text === null) continue;
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const ref of refEndsDbml(text)) {
      const told: DecidedRefEnds = ref.ends.map((end) => ({ table: end.table, ...(end.qualifier !== undefined ? { qualifier: end.qualifier } : {}), columns: end.columns }));
      ref.ends.forEach((end, i) => {
        const group = groups.get(`${end.qualifier === undefined ? '\u0001' : lower(end.qualifier)}\u0000${lower(end.table)}`);
        if (!group) return;
        const side = i === 0 ? 'left' : 'right';
        const entry = lookup(end.table, { ...(end.qualifier !== undefined ? { qualifier: end.qualifier } : {}), usePaths: group.paths, columns: end.columns });
        const byColumns = entry?.path !== undefined ? tableIdOfPath(normalisePosix(entry.path)) : undefined;
        const id = byColumns ?? chosen.get(endChoiceKey({ file, line: ref.line, side }));
        if (id === undefined || !group.ids.some((g) => tableIdKey(g) === tableIdKey(id))) {
          const refText = text.slice(ref.start, text.indexOf('\n', ref.start) < 0 ? text.length : text.indexOf('\n', ref.start)).trim();
          const spelling = end.qualifier !== undefined ? `${end.qualifier}.${end.table}` : end.table;
          const columns = end.columns.length === 1 ? end.columns[0] : `(${end.columns.join(', ')})`;
          const fitting = group.paths.filter((p) => {
            const has = new Set((byPath.get(lower(p))?.columns ?? []).map(lower));
            return end.columns.every((c) => has.has(lower(c)));
          }).length;
          undecided.push({ file, line: ref.line, side, spelling, endText: `${spelling}.${columns}`, refText, candidates: group.ids.map((g) => ({ ...g })), paths: [...group.paths], fitting });
          return;
        }
        told[i].id = id;
        // A table under public/ is what a bare name means once its namesakes are qualified.
        if (lower(id.schema) === 'public') return;
        const table = byPath.get(lower(group.paths[group.ids.findIndex((g) => tableIdKey(g) === tableIdKey(id))]));
        edits.push({ start: end.tableStart, end: end.tableEnd, text: `${dbmlName(id.schema)}.${dbmlName(table?.name ?? id.name)}` });
      });
      if (told.some((e) => e.id !== undefined)) decidedRefs.push(told);
    }
    if (edits.length > 0) decidedText.set(file, applyTextEdits(text, edits));
  }
  if (decidedText.size === 0) return { snapshot, undecided, decidedRefs };
  const relationshipsFiles = new Map(snapshot.relationshipsFiles);
  for (const [file, text] of decidedText) relationshipsFiles.set(file, readRelationshipsDbml(text));
  return {
    snapshot: { ...snapshot, relationshipsFiles, readText: (p) => decidedText.get(p) ?? snapshot.readText(p) },
    undecided,
    decidedRefs,
  };
}

/** A Ref's two ends as written, each shared-spelling end with the table it was told it means (`id`). */
type DecidedRefEnds = Array<{ table: string; qualifier?: string; columns: string[]; id?: TableId }>;

/**
 * A table's relationships as the editor hands them to the plan, with each
 * other end that names a spelling two tables share (`adresse`, which the
 * library could not resolve) named by the table {@link decideSharedSpellingEnds}
 * told its Ref it means, so the plan matches it with that Ref, now spelled
 * `ccc.adresse`. A relationship no told Ref holds is kept as it is.
 */
function withToldEnds(save: DbmlLibrarySave, refs: readonly DecidedRefEnds[], snapshot: DbmlLibrarySnapshot): DbmlLibrarySave {
  const list = save.model.relationships;
  if (!list || list.length === 0 || refs.length === 0) return save;
  const byId = new Map([...snapshot.tables.values()].flatMap((t) => {
    const id = t.storage === 'dbml' ? tableIdOfPath(t.path) : undefined;
    return id ? [[tableIdKey(id), t] as const] : [];
  }));
  const owner = snapshot.tables.get(lower(save.fromName ?? save.model.name));
  const ownerBare = lower(owner?.name ?? save.model.name);
  const ownerId = owner?.storage === 'dbml' ? tableIdOfPath(owner.path) : undefined;
  const told = new Set<TableRelationship>();
  const relationships = list.map((r) => {
    if (snapshot.tables.has(lower(r.toModel))) return r;
    for (const ends of refs) {
      for (const [o, t] of [[ends[0], ends[1]], [ends[1], ends[0]]] as const) {
        if (!o || !t || t.id === undefined || lower(t.table) !== lower(r.toModel) || lower(o.table) !== ownerBare) continue;
        if (o.id !== undefined && (ownerId === undefined || tableIdKey(o.id) !== tableIdKey(ownerId))) continue;
        const i = o.columns.findIndex((c) => lower(c) === lower(r.fromColumn));
        if (i < 0 || lower(t.columns[i] ?? '') !== lower(r.toColumn)) continue;
        const table = byId.get(tableIdKey(t.id));
        if (!table) continue;
        const named = { ...r, toModel: table.ref ?? table.name };
        told.add(named);
        return named;
      }
    }
    return r;
  });
  if (told.size === 0) return save;
  return { ...save, model: { ...save.model, relationships: withoutToldTwins(save.model.name, relationships, told) } };
}

/**
 * `relationships` with each unit dropped whose links an earlier unit already
 * has, when either of the two is one a told Ref end just named: the
 * relationship the user drew to `ccc.adresse` while the Ref meaning it was
 * still spelled `adresse` (and so not drawn) is that Ref, which keeps its
 * line and text, as an add of a stored relationship would. Two copies the
 * user stored themselves are left for the duplicate check to name.
 */
function withoutToldTwins(owner: string, relationships: readonly TableRelationship[], told: ReadonlySet<TableRelationship>): TableRelationship[] {
  const units = relationshipUnitsWithMembers(owner, relationships);
  const seen: Array<{ links: string; told: boolean }> = [];
  const dropped = new Set<TableRelationship>();
  for (const { unit, relationships: members } of units) {
    const links = [...unitLinks(unit)].sort().join('\n');
    const isTold = members.some((m) => told.has(m));
    if (seen.some((s) => s.links === links && (s.told || isTold))) {
      for (const m of members) dropped.add(m);
      continue;
    }
    seen.push({ links, told: isTold });
  }
  return dropped.size === 0 ? [...relationships] : relationships.filter((r) => !dropped.has(r));
}

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: readonly string[]): string {
  return names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ');
}
