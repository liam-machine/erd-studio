/**
 * A table's identity, and the text that names it.
 *
 * A DBML table is identified by its schema folder and its file stem, the
 * `<schema>` and `<name>` of `<layer>/tables/<schema>/<name>.dbml`: one file
 * per folder and stem, so the pair is unique by construction and known from
 * a directory listing without reading the file. Both parts compare without
 * case (`tables/Sales/x.dbml` and `tables/sales/x.dbml` are one folder on
 * macOS and Windows); the layer is not part of it (`Table sales.x` in two
 * layers declares the same thing, and no Ref end can tell them apart). A YAML
 * table, or a diagram member with no file, has no schema folder: its schema
 * is `''` and its name alone identifies it, as it always has.
 *
 * Text never carries an identity by being split on a dot (`ccc.addresse`
 * can be a schema and a table or one file stem with a dot in it). A table is
 * named in a scope (one diagram's members, or the library) by a reference:
 * its bare name when no other table in that scope has that name, else
 * `<schema>.<name>` ({@link assignTableRefs}). Text is turned back into a
 * table by comparison with what the scope's tables are called
 * ({@link matchTableRef}). A project where no two tables share a name has
 * only bare references, so everything that stores or compares names reads
 * and writes exactly what it did before identities existed.
 */

import { dbmlTreePathOf } from './storage.js';

/** A table's identity: its schema folder and its bare name. */
export interface TableId {
  /**
   * The schema folder, spelled as the path that names the table spells it
   * (compared without case). `''` for a table with no schema folder: a YAML
   * table, or a diagram member with no file.
   */
  readonly schema: string;
  /** The table's bare name: its file stem. */
  readonly name: string;
}

/** A {@link TableId} read from a table file's path, with the layer that file sits in (not part of the identity). */
export interface TableFileId extends TableId {
  readonly layer: string;
}

/**
 * The key of a table's identity, for maps and comparison: the schema folder
 * and the trimmed name, both lower-cased, joined by `/`. Neither a folder
 * name nor a table name can hold a `/`, so two identities have one key only
 * when they are the same table. A YAML table's key is `/<name>`. The key is
 * never shown or written to a file.
 */
export function tableIdKey(id: TableId): string {
  return `${id.schema.toLowerCase()}/${id.name.trim().toLowerCase()}`;
}

/** Whether two identities are the same table: the same schema folder and name, without case. */
export function sameTableId(a: TableId, b: TableId): boolean {
  return tableIdKey(a) === tableIdKey(b);
}

/**
 * The identity of the table file at `rel`, a posix path relative to the
 * semantic dir in the layer-first tree (`<layer>/tables/<schema>/<name>.dbml`,
 * as `dbmlTreePathOf` reads it), with its layer. Undefined for any other path:
 * a diagram, a relationships file, a YAML file, or a path outside the tree.
 */
export function tableIdOfPath(rel: string): TableFileId | undefined {
  const tree = dbmlTreePathOf(rel);
  if (tree?.kind !== 'table' || tree.schema === undefined) return undefined;
  return { layer: tree.layer, schema: tree.schema, name: tree.name };
}

/** `<schema>.<name>`: how a table is named where its bare name is shared. A table with no schema folder has only its name. */
export function qualifiedRef(schema: string, name: string): string {
  return schema === '' ? name : `${schema}.${name}`;
}

/** How two names are compared everywhere a reference is resolved: trimmed, without case. */
const comparable = (text: string): string => text.trim().toLowerCase();

/**
 * The reference of each table in one scope (one diagram's members, in their
 * order, or the library's tables), in the order given. A table's reference is
 * its bare name, spelled as given, unless another table in the scope (a
 * different identity: not the same table listed twice, nor the same schema
 * and name in another layer) has the same name without case; then it is
 * `<schema>.<name>`, the schema spelled as given. A table with no schema
 * folder keeps its bare name.
 *
 * A reference is also qualified when its text would equal another table's
 * (a file stem `ccc.addresse` beside the table `addresse` in `ccc` while
 * `bqs` has an `addresse` too): both are then `<schema>.<name>`, until no
 * two tables share one. Two tables whose qualified texts are still equal
 * (`a.b` + `c` and `a` + `b.c`) keep equal references, read as one table
 * listed twice, as such a pair always was.
 */
export function assignTableRefs(tables: readonly TableId[]): string[] {
  const keys = tables.map(tableIdKey);
  const qualified = new Set<string>();
  const refOf = (i: number): string => (qualified.has(keys[i]) ? qualifiedRef(tables[i].schema, tables[i].name) : tables[i].name);
  // Qualify every table whose reference names more than one table. The first
  // round compares bare names (nothing is qualified yet); later rounds catch a
  // qualified reference that equals another table's text. Qualifying only
  // ever adds, so this ends.
  const qualifyShared = (): boolean => {
    const texts = tables.map((_, i) => comparable(refOf(i)));
    const keysByText = new Map<string, Set<string>>();
    texts.forEach((text, i) => {
      const group = keysByText.get(text);
      if (group) group.add(keys[i]);
      else keysByText.set(text, new Set([keys[i]]));
    });
    let changed = false;
    tables.forEach((table, i) => {
      if (table.schema === '' || qualified.has(keys[i])) return;
      if ((keysByText.get(texts[i])?.size ?? 0) > 1) {
        qualified.add(keys[i]);
        changed = true;
      }
    });
    return changed;
  };
  while (qualifyShared());
  return tables.map((_, i) => refOf(i));
}

/** A table that text can name in one scope: its identity and the reference {@link assignTableRefs} gave it there. */
export interface TableRefCandidate extends TableId {
  readonly ref: string;
  /**
   * Other schema spellings that name this table, beside its folder: the
   * qualifier its file declares (`Table ccc.addresse` in `tables/bqs/`), the
   * qualifier of the `use` specifier that imports it.
   */
  readonly qualifiers?: readonly string[];
}

/**
 * Which comparison found a table, in the order they are tried: its
 * reference; `<folder>.<name>`; `<qualifier>.<name>` for one of its other
 * qualifiers; its bare name, when no other table has it.
 */
export type TableRefStep = 'reference' | 'folder' | 'qualifier' | 'bareName';

/** What text names among a scope's tables: one table (its index), several that nothing tells apart, or none. */
export type TableRefMatch =
  | { readonly kind: 'found'; readonly index: number; readonly step: TableRefStep }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly number[] }
  | { readonly kind: 'missing' };

export interface ResolveTableRefOptions {
  /**
   * What text that names several tables answers: `'none'` (the default) —
   * nothing, for anything that means something (a relationship end, an
   * edit); `'first'` — the first of them in the scope's order, for what only
   * places a table (an `erd_layout` line, a sticky note's link), so an old
   * bare line still lands somewhere deterministic.
   */
  readonly onAmbiguous?: 'none' | 'first';
  /**
   * Tables (by index) that more specific text has already named. Text that
   * names a table only by its bare name does not take one of these: a stray
   * `addresse 1 1` line never moves a table its `bqs.addresse 10 20` line placed.
   */
  readonly claimed?: ReadonlySet<number>;
}

/** Whether `candidate`'s reference is its bare name (no other table in the scope has the name). */
const refIsBare = (candidate: TableRefCandidate): boolean => comparable(candidate.ref) === comparable(candidate.name);

/**
 * What `text` names among a scope's `candidates`, compared without case and
 * never by splitting it: a table whose reference it is (the first, for a
 * table listed twice); else the one table whose `<folder>.<name>` it is;
 * else the one whose `<qualifier>.<name>` it is for another of its
 * qualifiers; else the one table with that bare name. Several distinct
 * tables at a step are `ambiguous`, unless `onAmbiguous` is `'first'`.
 */
export function matchTableRef(text: string, candidates: readonly TableRefCandidate[], options: ResolveTableRefOptions = {}): TableRefMatch {
  if (typeof text !== 'string') return { kind: 'missing' };
  const wanted = comparable(text);
  const claimed = options.claimed;
  const free = (i: number): boolean => !claimed?.has(i);

  // 1. A reference, exactly what the scope calls a table. A bare one does not take a claimed table.
  const byRef = candidates.findIndex((c, i) => comparable(c.ref) === wanted && (free(i) || !refIsBare(c)));
  if (byRef >= 0) return { kind: 'found', index: byRef, step: 'reference' };

  // At each later step, the tables that match: one identity is found (its first listing), several are ambiguous.
  const decide = (step: TableRefStep, matches: (c: TableRefCandidate, i: number) => boolean): TableRefMatch | undefined => {
    const indexes = candidates.flatMap((c, i) => (matches(c, i) ? [i] : []));
    if (indexes.length === 0) return undefined;
    const identities = new Set(indexes.map((i) => tableIdKey(candidates[i])));
    if (identities.size === 1 || options.onAmbiguous === 'first') return { kind: 'found', index: indexes[0], step };
    return { kind: 'ambiguous', candidates: indexes };
  };
  return decide('folder', (c) => c.schema !== '' && comparable(qualifiedRef(c.schema, c.name)) === wanted)
    ?? decide('qualifier', (c) => (c.qualifiers ?? []).some((q) => q !== '' && comparable(qualifiedRef(q, c.name)) === wanted))
    ?? decide('bareName', (c, i) => free(i) && comparable(c.name) === wanted)
    ?? { kind: 'missing' };
}

/** The index of the table `text` names among `candidates` ({@link matchTableRef}), or undefined when none or several do. */
export function resolveTableRef(text: string, candidates: readonly TableRefCandidate[], options: ResolveTableRefOptions = {}): number | undefined {
  const match = matchTableRef(text, candidates, options);
  return match.kind === 'found' ? match.index : undefined;
}

/**
 * The table each of several texts names in one scope (an `erd_layout`
 * block's lines, say), in two passes: first the texts that name a table by a
 * qualified spelling (its `<schema>.<name>` reference, folder or qualifier),
 * then the bare ones, which do not take a table the first pass named. So
 * `bqs.addresse 10 20` places bqs's table whatever line comes first, and a
 * bare `addresse` line beside it places the other `addresse`, or nothing.
 * Undefined for a text that names nothing (or several, with `onAmbiguous`
 * `'none'`). Two texts may name the same table: which one wins is the caller's rule.
 */
export function resolveTableRefs(
  texts: readonly string[],
  candidates: readonly TableRefCandidate[],
  options: Pick<ResolveTableRefOptions, 'onAmbiguous'> = {},
): Array<number | undefined> {
  const out: Array<number | undefined> = texts.map(() => undefined);
  const claimed = new Set<number>();
  const deferred: number[] = [];
  texts.forEach((text, t) => {
    const match = matchTableRef(text, candidates, options);
    const qualifiedText = match.kind === 'found'
      && (match.step === 'folder' || match.step === 'qualifier' || (match.step === 'reference' && !refIsBare(candidates[match.index])));
    if (qualifiedText) {
      out[t] = match.index;
      claimed.add(match.index);
    } else deferred.push(t);
  });
  for (const t of deferred) out[t] = resolveTableRef(texts[t], candidates, { ...options, claimed });
  return out;
}
