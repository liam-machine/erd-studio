/**
 * One version of an ERD Studio model, read from a list of files: every
 * table in the library, every relationship, every diagram's members and
 * every DBML relationships file's Refs. `erd-studio changes` reads two of
 * these — the files at a git ref and the files in the working tree — and
 * compares them with `diffModelSnapshots` (`modelChanges.ts`).
 *
 * Pure apart from `read`: the caller lists the files (posix paths relative
 * to the semantic dir) and hands over a function that returns a file's text,
 * so a git tree and a folder on disk are read by exactly the same code.
 * Files are parsed with the readers the extension uses (`@erd-studio/core`
 * and `@erd-studio/core/dbml`), classified with `classifySemanticFile`, and
 * a DBML Ref is attached to its table with `attachRelationships`, so a Ref
 * reads here exactly as the canvas reads it.
 *
 * No `vscode`: `dist/cli.js` bundles it.
 */

import {
  LAYERS_CONFIG_FILE,
  TABLES_DIR,
  attachRelationships,
  canonicalRelationship,
  classifySemanticFile,
  assignTableRefs,
  dbmlRefEndHints,
  dbmlTableLookup,
  tableIdKey,
  getRawSubjectAreaTableNames,
  linkKey,
  parseSubjectAreaJson,
  parseTableText,
  validateSubjectAreaDocument,
  type Cardinality,
  type ColumnDef,
  type DbmlAttachTable,
  type DbmlRefEndHint,
  type DbmlRelationshipsReading,
  type Relationship,
  type SemanticTable,
  type TableId,
} from '@erd-studio/core';
import { parseTableDbml, readRelationshipsDbml, subjectAreaMembersDbml } from '@erd-studio/core/dbml';

import { compareNames, isLayerFolder, type ListedName } from '../services/tableLibraryIndex';

/** A column as `changes` compares it. */
export interface SnapshotColumn {
  name: string;
  dataType: string;
  pk: boolean;
  fk: boolean;
  nk: boolean;
}

/** A table of the library. */
export interface SnapshotTable {
  /** As spelled in its file. */
  name: string;
  /** Its file, relative to the semantic dir. */
  file: string;
  /** `dbml` table file, `yaml` model file, or a model written inline in a v4 `json` diagram. */
  storage: 'dbml' | 'yaml' | 'json';
  /** A DBML table's layer folder; a YAML model's library folder (by convention a layer); absent at the top of a YAML library. */
  layer?: string;
  /** The table's schema: a DBML table's qualifier or schema folder, a YAML model's `schema`. */
  schema?: string;
  alias?: string;
  role?: string;
  grain?: string;
  columns: SnapshotColumn[];
  /** The file could not be read; the other fields are empty. */
  unreadable?: true;
  /**
   * Its identity, lower case: `<schema folder>/<name>` for a DBML table in a
   * schema folder, `/<name>` otherwise. Two tables of one name in two schema
   * folders are two tables; one in two layers is one (the first kept).
   */
  id?: string;
}

/** A relationship, stored the way the canvas reads it (the foreign-key end is `from` for a many-to-one). */
export interface SnapshotRelationship {
  /** Core's `linkKey`: the identity of the link, either way round, without case. */
  key: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  /** The file that holds it, relative to the semantic dir. */
  file: string;
  /** Core's `linkKey` over the two tables' identities (`SnapshotTable.id`), where they are known. */
  idKey?: string;
}

/** A diagram (a `.dbml` diagram or a `.json` domain file). */
export interface SnapshotDiagram {
  /** `<layer>/<name>`, the identity a diagram keeps when it moves from JSON to DBML. */
  id: string;
  name: string;
  layer: string;
  file: string;
  /** Its tables, as listed, without repeats. */
  tables: string[];
  /** The file could not be read: `tables` is empty. */
  unreadable?: true;
}

/** A DBML relationships file and its Refs. */
export interface SnapshotRelationshipsFile {
  file: string;
  /**
   * One entry per Ref: its identity (the `linkKey`s of its column pairs, so
   * a composite Ref is one entry) → what it says (each pair's direction and
   * cardinality), so a Ref whose cardinality changed is a changed Ref.
   */
  refs: Map<string, string>;
  /**
   * The same Refs by identity (each end's schema folder and name), for a Ref
   * whose ends all resolve to a table: its `refs` key → that identity and what
   * it says under it. `changes` pairs a Ref whose references changed (a
   * second table of a name appeared or left) by it.
   */
  ids?: Map<string, { id: string; says: string }>;
  unreadable?: true;
}

/** A file that could not be read, and why. */
export interface SnapshotProblem {
  file: string;
  message: string;
}

export interface ModelSnapshot {
  /**
   * By lower-case name; the first file in the Table Library's order
   * ({@link libraryOrder}) wins a name written twice, except that tables of
   * one name in different schema folders are each kept, by lower-case
   * `<schema>.<name>` (their reference).
   */
  tables: Map<string, SnapshotTable>;
  /** By `linkKey`. */
  relationships: Map<string, SnapshotRelationship>;
  /** By lower-case `id`. */
  diagrams: Map<string, SnapshotDiagram>;
  /** By file. */
  relationshipsFiles: Map<string, SnapshotRelationshipsFile>;
  problems: SnapshotProblem[];
}

/** Reads one file of the snapshot (a path relative to the semantic dir); null when it cannot be read. */
export type SnapshotReader = (rel: string) => string | null;

const lower = (s: string): string => s.toLowerCase();

/** Code-unit order, so the result never depends on the order the files were listed in. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The Table Library's listing order for two table files (`TableLibraryIndex`):
 * `logical-models/` (its top level, then each folder), then `tables/` read as
 * the YAML library (the same), then each DBML layer's schema folders, layers,
 * folders and files in `compareNames` order. The first of a name written
 * twice is the one the library keeps.
 */
function libraryOrder(a: string, aCls: { storage?: string; layer?: string; schema?: string }, b: string, bCls: { storage?: string; layer?: string; schema?: string }): number {
  const place = (rel: string, cls: { storage?: string; layer?: string; schema?: string }): [number, string, string, string] => {
    const parts = rel.split('/');
    const file = parts[parts.length - 1];
    if (cls.storage === 'dbml') return [4, cls.layer ?? '', cls.schema ?? '', file];
    const library = parts[0] === TABLES_DIR ? 2 : 0;
    return parts.length > 2 ? [library + 1, parts[1], '', file] : [library, '', '', file];
  };
  const [pa, pb] = [place(a, aCls), place(b, bCls)];
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  for (let i = 1; i < 4; i++) {
    const order = compareNames(pa[i] as string, pb[i] as string);
    if (order !== 0) return order;
  }
  return byteOrder(a, b);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function columnOf(c: ColumnDef): SnapshotColumn {
  return {
    name: String(c.name ?? ''),
    dataType: typeof c.dataType === 'string' ? c.dataType : '',
    pk: c.isPrimaryKey === true,
    fk: c.isForeignKey === true,
    nk: c.isNaturalKey === true,
  };
}

function tableOf(t: SemanticTable, file: string, storage: SnapshotTable['storage'], layer: string | undefined, schema: string | undefined): SnapshotTable {
  return {
    name: t.name,
    file,
    storage,
    ...(layer ? { layer } : {}),
    ...(schema ? { schema } : {}),
    ...(t.alias ? { alias: t.alias } : {}),
    ...(t.modelRole ? { role: String(t.modelRole) } : {}),
    ...(t.grain ? { grain: t.grain } : {}),
    columns: (t.columns ?? []).filter((c) => c && typeof c.name === 'string' && c.name !== '').map(columnOf),
  };
}

function fileStem(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Whether `tables/` is a layer folder rather than the v6 library, from a
 * file list: the rule of `tablesDirIsLayer` (`isLayerFolder`), fed from the
 * list and `layers.json` instead of a directory listing.
 */
export function tablesDirIsLayerOf(files: readonly string[], layersText: string | null): boolean {
  const prefix = `${TABLES_DIR}/`;
  const top: ListedName[] = files
    .filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/'))
    .map((f) => ({ name: f.slice(prefix.length), file: true, dir: false, link: false }));
  let listsTables = false;
  if (layersText !== null) {
    try {
      const config = JSON.parse(layersText.replace(/^﻿/, '')) as { layers?: unknown };
      listsTables = Array.isArray(config.layers)
        && config.layers.some((l) => !!l && typeof l === 'object' && (l as { id?: unknown }).id === TABLES_DIR);
    } catch {
      listsTables = false;
    }
  }
  return isLayerFolder(top.length > 0 || files.some((f) => f.startsWith(prefix)) ? top : null, listsTables);
}

/**
 * Add a relationship under its link key; the first copy read (in path order) wins, as the canvas keeps one.
 * `idOf` gives a table's identity from what an end names it by (its reference), when known.
 */
function addRelationship(out: Map<string, SnapshotRelationship>, rel: Relationship, file: string, idOf: (table: string) => string | undefined = () => undefined): void {
  if (!rel || typeof rel.fromModel !== 'string' || typeof rel.toModel !== 'string') return;
  const canonical = canonicalRelationship(rel);
  const key = linkKey(canonical);
  if (out.has(key)) return;
  const fromId = idOf(canonical.fromModel);
  const toId = idOf(canonical.toModel);
  out.set(key, {
    key,
    fromTable: canonical.fromModel,
    fromColumn: String(canonical.fromColumn ?? ''),
    toTable: canonical.toModel,
    toColumn: String(canonical.toColumn ?? ''),
    cardinality: canonical.cardinality,
    file,
    ...(fromId !== undefined && toId !== undefined ? { idKey: linkKey({ ...canonical, fromModel: fromId, toModel: toId }) } : {}),
  });
}

/**
 * Read a snapshot. `files` are posix paths relative to the semantic dir, as
 * `listSemanticFiles` lists them or `git ls-tree` prints them under it.
 */
export function readModelSnapshot(
  files: readonly string[],
  read: SnapshotReader,
): ModelSnapshot {
  const sorted = [...new Set(files)].sort(byteOrder);
  const snapshot: ModelSnapshot = {
    tables: new Map(),
    relationships: new Map(),
    diagrams: new Map(),
    relationshipsFiles: new Map(),
    problems: [],
  };
  const tablesDirIsLayer = tablesDirIsLayerOf(sorted, sorted.includes(LAYERS_CONFIG_FILE) ? read(LAYERS_CONFIG_FILE) : null);
  const classified = sorted.map((rel) => ({ rel, cls: classifySemanticFile(rel, { tablesDirIsLayer }) }));
  // Tables are read in the Table Library's order, so the first of a name written twice is the one the library keeps.
  const tablesInOrder = classified.filter(({ cls }) => cls.kind === 'table').sort((a, b) => libraryOrder(a.rel, a.cls, b.rel, b.cls));

  // The library's tables are keyed once all are read: by name, or by `<schema>.<name>` where two schema folders share it.
  // A v4 diagram's inline models, read after that, are added by name, first wins, as ever.
  const libraryTables: SnapshotTable[] = [];
  let keyed = false;
  const addTable = (t: SnapshotTable): void => {
    if (!keyed) { libraryTables.push(t); return; }
    const key = lower(t.name);
    if (!snapshot.tables.has(key)) snapshot.tables.set(key, t);
  };
  const libraryRelationships: Array<{ rel: Relationship; file: string }> = [];
  const attachTables: DbmlAttachTable[] = [];
  /** The identity of a table file: its schema folder (a DBML table in one) and name. */
  const folderOfId = new Map<string, string>();
  const identityOf = (name: string, schemaFolder: string | undefined): TableId => {
    const id = { schema: schemaFolder ?? '', name };
    if (!folderOfId.has(tableIdKey(id))) folderOfId.set(tableIdKey(id), id.schema);
    return id;
  };
  const withId = (t: SnapshotTable, name: string, schemaFolder: string | undefined): SnapshotTable =>
    ({ ...t, id: tableIdKey(identityOf(name, schemaFolder)) });

  // Tables first: relationships and diagrams resolve against them.
  for (const { rel, cls } of tablesInOrder) {
    const text = read(rel);
    const stem = cls.name ?? fileStem(rel);
    if (text === null) {
      snapshot.problems.push({ file: rel, message: 'The file could not be read.' });
      // An unreadable file still has its identity: it never hides a readable table of its name in another schema folder.
      addTable(withId({ name: stem, file: rel, storage: cls.storage === 'dbml' ? 'dbml' : 'yaml', columns: [], unreadable: true }, stem, cls.storage === 'dbml' ? cls.schema : undefined));
      continue;
    }
    if (cls.storage === 'dbml') {
      const reading = parseTableDbml(text, stem, cls.schema !== undefined ? { schemaFolder: cls.schema } : {});
      if (!reading.ok) {
        snapshot.problems.push({ file: rel, message: reading.error.message });
        addTable(withId({ name: stem, file: rel, storage: 'dbml', ...(cls.layer ? { layer: cls.layer } : {}), columns: [], unreadable: true }, stem, cls.schema));
        continue;
      }
      addTable(withId(tableOf(reading.table, rel, 'dbml', cls.layer, reading.table.schema ?? cls.schema), reading.table.name, cls.schema));
      attachTables.push({
        table: reading.table, storage: 'dbml', ...(reading.alias ? { dbmlAlias: reading.alias } : {}),
        // Its file and schema folder, so a Ref end is told apart by identity, as the canvas tells it.
        path: rel, ...(cls.schema !== undefined ? { schema: cls.schema } : {}),
      });
      continue;
    }
    try {
      const table = parseTableText(text, stem, { duplicateKeys: 'last' });
      if (!table) {
        snapshot.problems.push({ file: rel, message: 'The file holds no table (no name).' });
        addTable(withId({ name: stem, file: rel, storage: 'yaml', columns: [], unreadable: true }, stem, undefined));
        continue;
      }
      addTable(withId(tableOf(table, rel, 'yaml', cls.folder, table.schema), table.name, undefined));
      attachTables.push({ table, storage: 'yaml', path: rel });
      for (const r of table.relationships ?? []) {
        libraryRelationships.push({ rel: { ...r, fromModel: table.name } as Relationship, file: rel });
      }
    } catch (err) {
      snapshot.problems.push({ file: rel, message: messageOf(err) });
      addTable(withId({ name: stem, file: rel, storage: 'yaml', columns: [], unreadable: true }, stem, undefined));
    }
  }

  // Each table's reference: its name, or `<schema>.<name>` where another schema folder's table has its name.
  // Distinct identities only (a name in two layers is one table, the first file kept); unreadable files keep their name.
  const firstOfIdentity = new Map<string, number>();
  libraryTables.forEach((t, i) => { if (t.id !== undefined && !firstOfIdentity.has(t.id)) firstOfIdentity.set(t.id, i); });
  const distinct = [...firstOfIdentity.values()].map((i) => libraryTables[i]);
  const refs = assignTableRefs(distinct.map((t) => ({ schema: folderOfId.get(t.id!) ?? '', name: t.name })));
  // A name a table outside any schema folder has (a YAML table) stays one table, the first file kept:
  // YAML keeps its bare-name rule, and doctor reports the DBML copies as a format conflict.
  const unscopedNames = new Set(distinct.filter((t) => (folderOfId.get(t.id!) ?? '') === '').map((t) => lower(t.name)));
  const refOfId = new Map(distinct.map((t, i) => [t.id!, unscopedNames.has(lower(t.name)) ? t.name : refs[i]]));
  const idOfRef = new Map<string, string>();
  for (const t of libraryTables) {
    const ref = t.id !== undefined ? refOfId.get(t.id) ?? t.name : t.name;
    if (t.id !== undefined && !idOfRef.has(lower(ref))) idOfRef.set(lower(ref), t.id);
    const key = lower(ref);
    if (!snapshot.tables.has(key)) snapshot.tables.set(key, t);
  }
  keyed = true;
  for (const entry of attachTables) {
    if (entry.schema === undefined) continue;
    const ref = refOfId.get(tableIdKey(identityOf(entry.table.name, entry.schema)));
    if (ref !== undefined && ref !== entry.table.name) entry.ref = ref;
  }
  const idOf = (table: string): string | undefined => idOfRef.get(lower(table));

  // DBML relationships files: each Ref attached to its table the canvas's way.
  const readings: Array<{ path: string; reading: DbmlRelationshipsReading; semanticPath?: string }> = [];
  for (const { rel, cls } of classified) {
    if (cls.kind !== 'relationships') continue;
    const text = read(rel);
    const reading = text === null ? null : readRelationshipsDbml(text);
    if (reading === null || !reading.readable) {
      const first = reading?.problems.find((p) => p.severity === 'error');
      snapshot.problems.push({ file: rel, message: first?.message ?? 'The file could not be read.' });
      snapshot.relationshipsFiles.set(rel, { file: rel, refs: new Map(), unreadable: true });
      continue;
    }
    readings.push({ path: rel, reading, semanticPath: rel });
  }
  const lookup = dbmlTableLookup(attachTables);
  // An end's table as the canvas names it (its reference), found by what the end and its use line say.
  const realName = (spelled: string, hint?: DbmlRefEndHint): string => {
    const entry = lookup(spelled, hint);
    return entry ? entry.ref ?? entry.table.name : spelled;
  };
  const identityOfPairs = (pairs: readonly Relationship[]): string => pairs.map((r) => linkKey(r)).sort(byteOrder).join('\u0001');
  const saysOfPairs = (pairs: readonly Relationship[]): string => pairs
    .map((r) => lower(`${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}:${r.cardinality}`))
    .sort(byteOrder)
    .join('\u0001');
  for (const item of readings) {
    const { path, reading } = item;
    const refs = new Map<string, string>();
    const ids = new Map<string, { id: string; says: string }>();
    for (const ref of [...reading.refs, ...(reading.pending ?? [])]) {
      const hints = dbmlRefEndHints(item, ref);
      // Each end by its own hint (`fromModel` is the owner as read): two ends of one spelling may be two tables.
      const pairs = ref.relationships.map((r) => ({ ...r, fromModel: realName(r.fromModel, hints.owner), toModel: realName(r.toModel, hints.target) }));
      const identity = identityOfPairs(pairs);
      if (refs.has(identity)) continue;
      refs.set(identity, saysOfPairs(pairs));
      const byId = pairs.map((r) => ({ ...r, fromModel: idOf(r.fromModel) ?? '', toModel: idOf(r.toModel) ?? '' }));
      if (byId.every((r) => r.fromModel !== '' && r.toModel !== '')) ids.set(identity, { id: identityOfPairs(byId), says: saysOfPairs(byId) });
    }
    snapshot.relationshipsFiles.set(path, { file: path, refs, ...(ids.size > 0 ? { ids } : {}) });
  }
  const attached = attachRelationships(readings, lookup);
  const locations = attached.locations ?? new Map();
  for (const [owner, list] of [...attached.byOwner.entries()].sort(([a], [b]) => byteOrder(a, b))) {
    // The attach names an owner by its reference: `<schema>.<name>` where the name is shared, kept as it is.
    const t = snapshot.tables.get(lower(owner));
    const shared = t?.id !== undefined ? refOfId.get(t.id) : undefined;
    const name = shared !== undefined && shared !== t!.name ? shared : lookup(owner)?.table.name ?? owner;
    for (const r of list) {
      const full = { ...r, fromModel: name } as Relationship;
      addRelationship(snapshot.relationships, full, locations.get(linkKey(full))?.path ?? '', idOf);
    }
  }
  for (const { rel, file } of libraryRelationships) addRelationship(snapshot.relationships, rel, file, idOf);

  // Diagrams: their members, and (JSON) relationships kept in the domain file and v4's inline models.
  for (const { rel, cls } of classified) {
    if (cls.kind !== 'diagram' || !cls.layer || !cls.name) continue;
    const id = `${cls.layer}/${cls.name}`;
    if (snapshot.diagrams.has(lower(id))) continue;
    const diagram: SnapshotDiagram = { id, name: cls.name, layer: cls.layer, file: rel, tables: [] };
    snapshot.diagrams.set(lower(id), diagram);
    const text = read(rel);
    if (text === null) {
      snapshot.problems.push({ file: rel, message: 'The file could not be read.' });
      diagram.unreadable = true;
      continue;
    }
    let members: string[] | null;
    if (cls.storage === 'dbml') {
      members = subjectAreaMembersDbml(text, rel);
      if (members === null) {
        snapshot.problems.push({ file: rel, message: 'The diagram does not parse as DBML.' });
      }
    } else {
      members = readJsonDiagram(text, rel, snapshot, addTable);
    }
    if (members === null) {
      diagram.unreadable = true;
      continue;
    }
    const seen = new Set<string>();
    for (const m of members) {
      if (typeof m !== 'string' || m === '' || seen.has(lower(m))) continue;
      seen.add(lower(m));
      // A member named `<schema>.<name>` keeps that reference: its own name would not say which table.
      const t = snapshot.tables.get(lower(m));
      diagram.tables.push(t && lower(t.name) === lower(m) ? t.name : m);
    }
  }
  return snapshot;
}

/** A JSON diagram's members; its domain-file relationships and v4 inline models go into `snapshot`. Null when unreadable. */
function readJsonDiagram(
  text: string,
  rel: string,
  snapshot: ModelSnapshot,
  addTable: (t: SnapshotTable) => void,
): string[] | null {
  let raw: unknown;
  try {
    raw = parseSubjectAreaJson(text, rel);
  } catch (err) {
    snapshot.problems.push({ file: rel, message: messageOf(err) });
    return null;
  }
  let obj: Record<string, unknown>;
  try {
    obj = validateSubjectAreaDocument(raw, rel).obj;
  } catch (err) {
    // A newer or mixed-up file still lists its tables; nothing else of it is read.
    snapshot.problems.push({ file: rel, message: messageOf(err) });
    return getRawSubjectAreaTableNames(raw);
  }
  const logical = (obj.logical && typeof obj.logical === 'object' ? obj.logical : {}) as Record<string, unknown>;
  const models = Array.isArray(logical.models) ? logical.models as unknown[] : [];
  for (const entry of models) {
    if (entry && typeof entry === 'object' && typeof (entry as SemanticTable).name === 'string') {
      const t = entry as SemanticTable;
      addTable(tableOf(t, rel, 'json', undefined, typeof t.schema === 'string' ? t.schema : undefined));
    }
  }
  const relationships = Array.isArray(logical.relationships) ? logical.relationships as Relationship[] : [];
  for (const r of relationships) {
    if (r && typeof r === 'object' && typeof r.fromColumn === 'string' && typeof r.toColumn === 'string') {
      addRelationship(snapshot.relationships, r, rel);
    }
  }
  return getRawSubjectAreaTableNames(obj);
}
