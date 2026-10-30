/**
 * The project's relationships files as one index (ERD Studio 2.0, the
 * layer-first DBML tree): every Ref and pending line of every
 * `<layer>/relationships/*.dbml`, by owner, by link, by table pair and by
 * the tables each file's `use` lines name. It is the one implementation of
 * the settled rules for where a NEW Ref goes ({@link placeNewRef}) and which
 * relationships files a diagram imports ({@link relationshipsImportsFor}).
 * The library planner, Convert, `doctor`, `diff` and the sync plan all ask
 * it, so they can never disagree.
 *
 * Built once from a snapshot and never updated: a planner builds one index
 * before an edit and another for the state after it, and compares them
 * ({@link changedPairs}). Deterministic: the same files and Refs, in any
 * order, give the same index and the same answers. Paths are posix,
 * relative to the semantic dir, spelled as the listing spells them; "byte
 * order" is code-unit order (`<`), never a locale's.
 *
 * Pure: no `vscode`, no file access. The CLI bundles it.
 */

import { linkKey, normalisePosix, relationshipsFilePath, reverseBareOneToOne } from '@erd-studio/core';
import type { DbmlAttachTable, DbmlRelationshipsReading, DbmlStoredRef } from '@erd-studio/core';
import type { RefUnit } from '@erd-studio/core/dbml';

import type { Relationship } from '../types/semantic';

const lower = (s: string): string => s.toLowerCase();

/** Code-unit order (`<`): the same on every machine and locale. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** One Ref (or pending line, D27) of a relationships file, as the index holds it. */
export interface IndexedRef {
  /** The relationships file, semantic-relative posix, as listed. */
  file: string;
  /** The foreign-key table, lower-case, oriented as `attachRelationships` reads it. */
  owner: string;
  /** The other end's table, lower-case. */
  target: string;
  /** The Ref as one unit, with the tables' real spellings when the lookup knows them. */
  unit: RefUnit;
  /** Core's `linkKey` of each column pair. */
  links: string[];
  /** A `// erd-studio pending: Ref …` line (D27), not a live Ref. */
  pending: boolean;
  /** 1-based line in the file. */
  line: number;
  /** The owner end's schema qualifier as written (`sap` in `sap.afih.x`); absent for an unqualified end. */
  ownerQualifier?: string;
}

/** The per-pair link keys of a unit (core's `linkKey`, order-free). */
export function unitLinks(unit: RefUnit): string[] {
  return unit.fromColumns.map((c, i) => linkKey({ fromModel: unit.from, fromColumn: c, toModel: unit.to, toColumn: unit.toColumns[i] ?? '' }));
}

/** A stored Ref's unit, oriented as `attachRelationships` reads it; null for a Ref with no column pair. */
export function storedUnit(ref: DbmlStoredRef, lookup: (name: string) => DbmlAttachTable | undefined): { unit: RefUnit; rels: Relationship[] } | null {
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
 * A relationships file's Refs and pending lines as index entries
 * ({@link storedUnit} applied to each). None for a file that does not read:
 * an unreadable file holds no counted Ref.
 */
export function refEntriesOf(file: string, reading: DbmlRelationshipsReading, lookup: (name: string) => DbmlAttachTable | undefined): IndexedRef[] {
  if (!reading.readable) return [];
  const out: IndexedRef[] = [];
  const add = (ref: DbmlStoredRef, pending: boolean): void => {
    const read = storedUnit(ref, lookup);
    if (!read) return;
    // A bare `-` the keys turned round: its owner is the end the file wrote second.
    const ownerQualifier = read.rels === ref.relationships ? ref.ownerQualifier : ref.targetQualifier;
    out.push({
      file, owner: lower(read.unit.from), target: lower(read.unit.to), unit: read.unit, links: unitLinks(read.unit), pending, line: ref.line,
      ...(ownerQualifier !== undefined ? { ownerQualifier } : {}),
    });
  };
  for (const ref of reading.refs) add(ref, false);
  for (const ref of reading.pending ?? []) add(ref, true);
  return out;
}

/** Two tables as one order-free key: lower-case, sorted, `\u0000`-joined. */
export function pairKey(a: string, b: string): string {
  const x = lower(a);
  const y = lower(b);
  return x <= y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
}

/** The project's relationships files, read: see the module comment. */
export interface RelationshipsIndex {
  /** Every relationships file, byte-sorted. */
  readonly files: readonly string[];
  /** The files that do not read (a syntax error, conflict markers): they hold no indexed Ref. */
  readonly unreadable: ReadonlySet<string>;
  /** Every Ref and pending line, by file (byte order), then line. */
  readonly refs: readonly IndexedRef[];
  /** How many Refs and pending lines of `owner` (any case) each file holds, in file byte order. */
  ownerCounts(owner: string): ReadonlyMap<string, number>;
  /** Every Ref and pending line holding `link` (core `linkKey`). */
  holders(link: string): readonly IndexedRef[];
  /** The files holding a live Ref between `a` and `b` (either way round, a self-Ref when equal), byte-sorted. */
  filesHoldingPair(a: string, b: string): readonly string[];
  /** The files with a `use` line resolving to `tablePath` (compared case-insensitively), byte-sorted. */
  filesUsing(tablePath: string): readonly string[];
}

/** The order of {@link RelationshipsIndex.refs}: by file, line, then content, so any input order gives one index. */
function compareRefs(a: IndexedRef, b: IndexedRef): number {
  return byteOrder(a.file, b.file)
    || a.line - b.line
    || Number(a.pending) - Number(b.pending)
    || byteOrder(a.owner, b.owner)
    || byteOrder(a.target, b.target)
    || byteOrder(a.links.join('\u0001'), b.links.join('\u0001'));
}

const EMPTY_COUNTS: ReadonlyMap<string, number> = new Map();
const NONE: readonly never[] = Object.freeze([]);

/**
 * The index of `files` (every relationships file, readable or not) and
 * `refs` (from {@link refEntriesOf}). A Ref of a file in `unreadable` is not
 * indexed. `useTargets` gives each readable file's `use` lines, resolved
 * against the file's folder; {@link RelationshipsIndex.filesUsing} answers
 * from them.
 */
export function buildRelationshipsIndex(input: {
  files: readonly string[];
  refs: Iterable<IndexedRef>;
  unreadable?: Iterable<string>;
  useTargets?: ReadonlyMap<string, readonly string[]>;
}): RelationshipsIndex {
  const unreadable = new Set(input.unreadable ?? []);
  const refs = [...input.refs].filter((r) => !unreadable.has(r.file)).sort(compareRefs);
  const files = [...new Set([...input.files, ...unreadable, ...refs.map((r) => r.file)])].sort(byteOrder);

  const counts = new Map<string, Map<string, number>>();
  const byLink = new Map<string, IndexedRef[]>();
  const pairFiles = new Map<string, string[]>();
  for (const ref of refs) {
    // Refs are in file order, so each owner's map is in file byte order too.
    const owned = counts.get(ref.owner) ?? new Map<string, number>();
    counts.set(ref.owner, owned);
    owned.set(ref.file, (owned.get(ref.file) ?? 0) + 1);
    for (const link of new Set(ref.links)) {
      const list = byLink.get(link) ?? [];
      byLink.set(link, list);
      list.push(ref);
    }
    if (ref.pending) continue;
    const key = pairKey(ref.owner, ref.target);
    const holding = pairFiles.get(key) ?? [];
    pairFiles.set(key, holding);
    if (holding[holding.length - 1] !== ref.file) holding.push(ref.file);
  }

  const users = new Map<string, string[]>();
  for (const file of [...(input.useTargets?.keys() ?? [])].sort(byteOrder)) {
    if (unreadable.has(file)) continue;
    for (const target of new Set((input.useTargets!.get(file) ?? []).map((t) => lower(normalisePosix(t))))) {
      const list = users.get(target) ?? [];
      users.set(target, list);
      list.push(file);
    }
  }

  return {
    files,
    unreadable,
    refs,
    ownerCounts: (owner) => counts.get(lower(owner)) ?? EMPTY_COUNTS,
    holders: (link) => byLink.get(link) ?? NONE,
    filesHoldingPair: (a, b) => pairFiles.get(pairKey(a, b)) ?? NONE,
    filesUsing: (tablePath) => users.get(lower(normalisePosix(tablePath))) ?? NONE,
  };
}

/** Where {@link placeNewRef} puts a new Ref, and by which rule. */
export interface RefPlacement {
  file: string;
  /** The file does not exist yet. */
  create: boolean;
  rule: 1 | 2;
}

/**
 * Where a new Ref of the foreign-key table `fk.table` goes (decision 5):
 *
 * 1. the file, in any layer, holding the most Refs and pending lines of
 *    `fk.table` (its name BEFORE the edit: the index is the pre-edit
 *    snapshot), ties going to path byte order;
 * 2. otherwise the FK table's layer's default file,
 *    `<L>/relationships/<L>.dbml`, with `<L>` spelled as its folder is listed
 *    (`listedLayer`, given the lower-case layer; else `fk.layer`). A listed
 *    file equal to that path in another case is reused (`create: false`), so
 *    a create never collides with a case twin.
 *
 * `layerDefaultOnly` (Convert) skips rule 1.
 */
export function placeNewRef(
  fk: { table: string; layer: string },
  index: RelationshipsIndex,
  listedLayer?: (layerLower: string) => string | undefined,
  options: { layerDefaultOnly?: boolean } = {},
): RefPlacement {
  let best: string | undefined;
  let most = 0;
  // ownerCounts is in file byte order, so the first file with the most wins a tie.
  for (const [file, count] of options.layerDefaultOnly ? [] : index.ownerCounts(fk.table)) {
    if (index.unreadable.has(file)) continue;
    if (count > most) {
      best = file;
      most = count;
    }
  }
  if (best !== undefined) return { file: best, create: false, rule: 1 };
  const layer = listedLayer?.(lower(fk.layer)) ?? fk.layer;
  const wanted = relationshipsFilePath(layer, layer);
  const listed = index.files.find((f) => f === wanted) ?? index.files.find((f) => lower(f) === lower(wanted));
  return listed !== undefined ? { file: listed, create: false, rule: 2 } : { file: wanted, create: true, rule: 2 };
}

/**
 * The tables a diagram draws, as {@link relationshipsImportsFor} reads them:
 * its `use` members, and the members it names in `erd_unlinked_tables`
 * (D26: no `.dbml` table file to use; a missing table among them).
 */
export interface DiagramTables {
  members: Iterable<string>;
  unlinked?: Iterable<string>;
}

/**
 * The relationships files a diagram imports, the one rule every reader and
 * writer asks (the editor and its settle, Convert, the canvas display
 * filter, `doctor`): every file holding a live Ref with both ends among its
 * `use` members (a self-Ref counts), every file holding a pending line (D27)
 * with both ends among the tables it draws (`members` and `unlinked`: a
 * relationship to a missing table is drawn, as in 1.9.0), plus every file of
 * `current` (its imports now) that does not read, which is kept because it
 * may hold one. An unreadable file is never added. `exists` filters the
 * result when given. Byte-sorted. A bare list is the `use` members alone.
 */
export function relationshipsImportsFor(
  tables: Iterable<string> | DiagramTables,
  index: RelationshipsIndex,
  options: { current?: readonly string[]; exists?: (file: string) => boolean } = {},
): string[] {
  const { members, unlinked = [] } = isDiagramTables(tables) ? tables : { members: tables };
  const names = new Set([...members].map(lower));
  const drawn = new Set([...names, ...[...unlinked].map(lower)]);
  const out = new Set<string>();
  for (const ref of index.refs) {
    if (index.unreadable.has(ref.file)) continue;
    const among = ref.pending ? drawn : names;
    if (among.has(ref.owner) && among.has(ref.target)) out.add(ref.file);
  }
  if (options.current && options.current.length > 0 && index.unreadable.size > 0) {
    const unreadable = new Set([...index.unreadable].map(lower));
    for (const file of options.current) if (unreadable.has(lower(file))) out.add(file);
  }
  const result = [...out].filter((f) => !options.exists || options.exists(f));
  return result.sort(byteOrder);
}

function isDiagramTables(tables: Iterable<string> | DiagramTables): tables is DiagramTables {
  return typeof (tables as Iterable<string>)[Symbol.iterator] !== 'function';
}

/** Every table pair held by a Ref or a pending line, with its holding files (a pending holder marked). */
function pairHolders(index: RelationshipsIndex): Map<string, string> {
  const out = new Map<string, Set<string>>();
  for (const ref of index.refs) {
    const key = pairKey(ref.owner, ref.target);
    const files = out.get(key) ?? new Set<string>();
    out.set(key, files);
    files.add(ref.pending ? `${ref.file}\u0000pending` : ref.file);
  }
  return new Map([...out].map(([key, files]) => [key, [...files].sort(byteOrder).join('\u0000')]));
}

/**
 * The table pairs ({@link pairKey}) whose set of files holding a Ref or a
 * pending line differs between `before` and `after`: one added or removed,
 * moved to another file, renamed (the old pair and the new one both
 * change), or a pending line become a Ref. Pending lines count because
 * they bring an import too ({@link relationshipsImportsFor}).
 */
export function changedPairs(before: RelationshipsIndex, after: RelationshipsIndex): Set<string> {
  const a = pairHolders(before);
  const b = pairHolders(after);
  const changed = new Set<string>();
  for (const [key, files] of a) if (b.get(key) !== files) changed.add(key);
  for (const key of b.keys()) if (!a.has(key)) changed.add(key);
  return changed;
}
