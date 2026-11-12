/**
 * Relationships read from DBML relationships files, attached to the tables
 * that own them (§2.4 of the native DBML storage spec). Parser-free: the
 * readers in `@erd-studio/core/dbml` turn each file into
 * {@link DbmlRelationshipsReading}s, and this one function — shared by core's
 * loader and the extension host — maps their ends onto tables, orients the
 * one-to-ones that need keys, respells, drops a link read twice, and derives
 * composite keys. Pure: no file access, no `@dbml/parse`.
 */

import type { Relationship, TableRelationship } from './types/semantic.js';
import type {
  DbmlAttachResult,
  DbmlAttachTable,
  DbmlRefEndHint,
  DbmlRefLocation,
  DbmlRelationshipsReading,
  DbmlStoredRef,
  DbmlUseTable,
} from './types/dbmlStorage.js';
import type { DbtKeyIndex } from './keyEvidence.js';
import { libraryCopyRank } from './domain.js';
import { linkKey, nextCompositeKey, reverseRelationship } from './relationships.js';
import { dbmlTablePath, dirnamePosix, normalisePosix, resolvePosix } from './storage.js';
import { tableIdKey, tableIdOfPath } from './tableIdentity.js';

const lower = (s: string): string => s.toLowerCase();

/** The schema folder that holds a project's unqualified tables: what DBML means by a name with no schema. */
const DEFAULT_SCHEMA_FOLDER = 'public';

/** Where a {@link dbmlTableLookup} keeps its full answer for {@link attachRelationships}. */
const RESOLVE = Symbol('dbmlTableLookup.resolve');

/** A lookup {@link attachRelationships} resolves Ref ends with: a table part, and what the end says beside it. */
export type DbmlTableLookup = (name: string, hint?: DbmlRefEndHint) => DbmlAttachTable | undefined;

/** How one end resolved: the table, or why none (`ambiguous`: several tables and nothing decides). */
interface EndResolution {
  entry?: DbmlAttachTable;
  ambiguous?: DbmlAttachTable[];
  /** Use paths any one of whose existence turns a lenient match into none (rule 4); set only when they decide. */
  contested?: string[];
  /** For `ambiguous`: every schema folder the end could mean (the tables' and the file's own use lines'), when the file names more than the tables in scope. */
  schemas?: string[];
  /** For `ambiguous`: rule 0 decided it (the file's `use` lines give the end's spelling to several files). */
  spelledTwice?: true;
}

/** The text a table is named by in its scope: its reference, else its name. */
const refOf = (entry: DbmlAttachTable): string => entry.ref ?? entry.table.name;

/** An entry's identity key: its schema folder and name (a table of no known folder: its name alone). */
const identityOf = (entry: DbmlAttachTable): string => tableIdKey({ schema: entry.schema ?? '', name: entry.table.name });

/** The entries of distinct identities, each the first listed. */
function distinct(entries: readonly DbmlAttachTable[]): DbmlAttachTable[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = identityOf(e);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Index `tables` and answer how one end resolves (the rule
 * {@link dbmlTableLookup} documents). `exists` answers whether a use path
 * names a file that exists; without it a contested end stays lenient.
 * `tableDirs`: the table folders the scope's files name, given by a reader
 * that sees only some of the library (rule 4).
 */
function endResolver(
  tables: Iterable<DbmlAttachTable>,
  tableDirs?: readonly string[],
): (name: string, hint: EndHint | undefined, exists?: (path: string) => boolean) => EndResolution {
  const byName = new Map<string, DbmlAttachTable[]>();
  const byAlias = new Map<string, DbmlAttachTable>();
  const byPath = new Map<string, DbmlAttachTable>();
  for (const entry of tables) {
    const name = lower(entry.table.name);
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
    if (entry.dbmlAlias) {
      const alias = lower(entry.dbmlAlias);
      if (!byAlias.has(alias)) byAlias.set(alias, entry);
    }
    if (entry.path !== undefined) {
      const path = lower(normalisePosix(entry.path));
      if (!byPath.has(path)) byPath.set(path, entry);
    }
  }
  /** Rule 0: an end spelled as several of its file's `use` lines import, each from another table file. */
  const bySpelledFiles = (wanted: string, usePaths: readonly string[], columns: readonly string[], exists?: (path: string) => boolean): EndResolution => {
    const named = (e: DbmlAttachTable | undefined): e is DbmlAttachTable =>
      e !== undefined && (lower(e.table.name) === wanted || (e.dbmlAlias !== undefined && lower(e.dbmlAlias) === wanted));
    const paths = usePaths.map((p) => normalisePosix(p));
    const candidates = distinct(paths.map((p) => byPath.get(lower(p))).filter(named));
    // Neither table is in scope (a diagram showing neither): nothing of this end is drawn here.
    if (candidates.length === 0) return {};
    const inScope = new Set(candidates.map(identityOf));
    // A file of the spelling that is not in scope may be the one the end means, unless it does not exist
    // (a reader that sees only some of the library learns that by reading it: `contestedUsePaths`).
    const outOfScope = paths.filter((p) => {
      const id = tableIdOfPath(p);
      return !(id !== undefined && inScope.has(tableIdKey(id)));
    });
    const unseen = outOfScope.filter((p) => exists?.(p) !== false);
    const contested = outOfScope.length > 0 ? { contested: outOfScope } : {};
    const fit = columns.length === 0 ? [] : candidates.filter((e) => {
      const has = new Set((e.table.columns ?? []).map((c) => (typeof c?.name === 'string' ? lower(c.name) : '')));
      return columns.every((c) => has.has(lower(c)));
    });
    if (unseen.length === 0 && fit.length === 1) return { entry: fit[0], ...contested };
    const schemas = new Map<string, string>();
    for (const p of paths) {
      const id = tableIdOfPath(p);
      if (id !== undefined && !schemas.has(lower(id.schema))) schemas.set(lower(id.schema), id.schema);
    }
    return { ambiguous: candidates, schemas: [...schemas.values()].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0)), spelledTwice: true, ...contested };
  };
  return (name, hint, exists) => {
    const wanted = lower(name);
    const named = byName.get(wanted);
    // 0. The file's `use` lines give this spelling to several tables (`use { table adresse }` from two schema
    // folders, which every DBML parser refuses with [3003]): no line is the end's own, so the end is the one
    // of those tables that has every column it names, decided only when all of them are in scope.
    if (hint?.usePaths !== undefined && hint.usePaths.length > 1) return bySpelledFiles(wanted, hint.usePaths, hint.columns ?? [], exists);
    // 1. The relationships file's own `use` line for this spelling names the table's file.
    if (hint?.usePath !== undefined) {
      const atPath = byPath.get(lower(normalisePosix(hint.usePath)));
      if (atPath && (lower(atPath.table.name) === wanted || (atPath.dbmlAlias !== undefined && lower(atPath.dbmlAlias) === wanted))) {
        return { entry: atPath };
      }
    }
    if (!named) {
      const aliased = byAlias.get(wanted);
      return aliased ? { entry: aliased } : {};
    }
    // Tables that carry no schema folder are matched by name alone, the first listed (as before identities).
    if (named.every((e) => e.schema === undefined)) return { entry: named[0] };
    const identities = distinct(named);
    const qualifier = hint?.qualifier !== undefined ? lower(hint.qualifier) : undefined;
    if (qualifier !== undefined) {
      // 2. The tables whose schema folder, then whose declared schema, the qualifier names.
      for (const schemaOf of [(e: DbmlAttachTable) => e.schema, (e: DbmlAttachTable) => e.table.schema]) {
        const matching = identities.filter((e) => schemaOf(e) !== undefined && lower(schemaOf(e)!) === qualifier);
        if (matching.length === 1) return { entry: matching[0] };
        if (matching.length > 1) return { ambiguous: matching };
      }
    }
    // 3'. An unqualified end whose own relationships file imports tables of its name from two or more
    // schema folders means one of them, and nothing but the default schema folder says which: the one
    // table of the name a narrower scope sees (a diagram showing only one of them) would be a guess.
    if (qualifier === undefined && (hint?.useSchemas ?? 0) > 1) {
      const inPublic = identities.filter((e) => e.schema !== undefined && lower(e.schema) === DEFAULT_SCHEMA_FOLDER);
      if (inPublic.length === 1) return { entry: inPublic[0] };
      // Reported with every schema folder the file imports the name from, not only the ones in scope.
      const inScope = identities.map((e) => e.schema ?? '');
      const extra = (hint?.useSchemaNames ?? []).filter((n) => !inScope.some((t) => lower(t) === lower(n)));
      return { ambiguous: identities, ...(extra.length > 0 ? { schemas: [...inScope, ...extra].sort((a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0)) } : {}) };
    }
    if (identities.length === 1) {
      // 3. The one table of that name. 4. A qualifier that names none of it still lands on it (2.0 drew
      // that line), unless the end's own use line names another file that exists: that table is elsewhere.
      // An unqualified end is contested the same way when its own use line names a table of another
      // identity, or, with no line of its own, when its file imports the name only from other schema
      // folders: an existing file there is the table it means, and the one in scope is a namesake.
      const only = identities[0];
      const differs = (usePath: string): boolean => only.path === undefined || lower(normalisePosix(only.path)) !== lower(normalisePosix(usePath));
      const otherIdentity = (usePath: string): boolean => {
        const id = tableIdOfPath(normalisePosix(usePath));
        return id === undefined || tableIdKey(id) !== identityOf(only);
      };
      let contested: string[] | undefined;
      if (hint?.usePath !== undefined && differs(hint.usePath) && (qualifier !== undefined || otherIdentity(hint.usePath))) {
        contested = [hint.usePath];
      } else if (hint?.qualifier !== undefined && hint.usePath === undefined && tableDirs !== undefined && only.path !== undefined) {
        // A qualifier that names none of it, with no use line of its own, read where only some of the library
        // is in scope (a diagram's members): a table of its name in a folder the scope's files name, or in
        // the qualifier's own folder, is another table of the name, and then nothing says the end is this one.
        const others = namesakePaths(only.path, hint.qualifier, [...tableDirs, ...(hint.useDirs ?? [])]).filter((p) => differs(p) && otherIdentity(p));
        if (others.length > 0) contested = others;
      } else if (qualifier === undefined && hint?.usePath === undefined && only.schema !== undefined && hint?.useSchemaPaths !== undefined
        && !(hint.useSchemaNames ?? []).some((n) => lower(n) === lower(only.schema!))) {
        const others = hint.useSchemaPaths.filter((p) => differs(p) && otherIdentity(p));
        if (others.length > 0) contested = others;
      }
      if (contested !== undefined && only.path !== undefined && contested.some((p) => exists?.(p) === true)) return { contested };
      return { entry: only, ...(contested !== undefined && only.path !== undefined ? { contested } : {}) };
    }
    // 5. Several tables of the name and nothing decides: an unqualified name means the default schema's table.
    if (qualifier === undefined) {
      const inPublic = identities.filter((e) => e.schema !== undefined && lower(e.schema) === DEFAULT_SCHEMA_FOLDER);
      if (inPublic.length === 1) return { entry: inPublic[0] };
    }
    return { ambiguous: identities };
  };
}

/**
 * A lookup over `tables` for {@link attachRelationships}: a Ref end's table
 * part matched by name, without case, and then by a DBML alias declared in
 * a table file (`Table fct_order as FO`). A name always beats an alias.
 *
 * Tables that carry their schema folder (`schema`) can share a name; what
 * the end says beside its name (`hint`) then tells them apart, in order:
 *
 * 0. when the relationships file's `use` lines give the end's spelling to
 *    two or more different table files (`hint.usePaths`: two unqualified
 *    `Table adresse` files imported side by side, which every DBML parser
 *    refuses with [3003]), the one of those tables that has every column the
 *    end names (`hint.columns`), when all of them are in scope (or
 *    `options.exists` says the others do not exist); otherwise none, reported
 *    as ambiguous. The first such line is never taken for the end's own;
 * 1. the relationships file's own `use` line for the end's spelling names
 *    the table's file (`path`): exact, and what ERD Studio always writes;
 * 2. else the one table whose schema folder, then whose declared schema
 *    (`table.schema`), the end's qualifier names, without case;
 * 3. else, when one table has the name, that table, unless the end is
 *    unqualified and its relationships file's own `use` lines import tables
 *    of its name from two or more schema folders (then rule 5 decides,
 *    so a diagram showing one of them never draws the other's Ref on it);
 * 4. a qualifier that names none of it included (a stale qualifier draws as
 *    it always did), unless the end's use path names another file and
 *    `options.exists` says that file exists; or, for a lookup told
 *    `options.tableDirs` (a reader that sees only some of the library: the
 *    table folders its files' `use` lines name), unless the end has no use
 *    line and `options.exists` says a file of its name exists in one of
 *    those folders, or its relationships file's, or in the qualifier's own
 *    schema folder: then another table has the name, and the qualifier says
 *    neither is this one;
 * 5. else, for an unqualified end, the one table of the name in the default
 *    schema folder (`tables/public/`, where unqualified tables live);
 *    otherwise none: nothing is guessed.
 *
 * Tables of one schema folder and name in two layers are one table (the
 * first listed), as are tables that carry no schema folder (YAML), which
 * keep the rule that held before identities: the first of the name.
 */
export function dbmlTableLookup(
  tables: Iterable<DbmlAttachTable>,
  options: { exists?: (path: string) => boolean; tableDirs?: readonly string[] } = {},
): DbmlTableLookup {
  const resolve = endResolver(tables, options.tableDirs);
  const lookup: DbmlTableLookup = (name, hint) => resolve(name, hint, options.exists).entry;
  // So attachRelationships can say why an end found nothing; a caller's own lookup function has no such answer.
  Object.defineProperty(lookup, RESOLVE, { value: (name: string, hint?: DbmlRefEndHint) => resolve(name, hint, options.exists) });
  return lookup;
}

/** How `tables` resolves an end: in full for a {@link dbmlTableLookup}, else by its answer alone. */
function resolverOf(tables: DbmlTableLookup): (name: string, hint: DbmlRefEndHint) => EndResolution {
  const full = (tables as { [RESOLVE]?: (name: string, hint?: DbmlRefEndHint) => EndResolution })[RESOLVE];
  if (full) return full;
  return (name, hint) => {
    const entry = tables(name, hint);
    return entry ? { entry } : {};
  };
}

/** A relationships file as {@link attachRelationships} reads it. */
export interface DbmlAttachReading {
  /** The file, as the caller names it in reports. */
  path: string;
  reading: DbmlRelationshipsReading;
  /**
   * The file's path relative to the semantic dir (posix), so its `use` lines
   * resolve to table files (rule 1 of {@link dbmlTableLookup}). Without it a
   * Ref end is told apart by its qualifier and name only.
   */
  semanticPath?: string;
}

/** `path` with `.dbml` added when a `use` line left it out. */
const withDbmlExtension = (path: string): string => (lower(path).endsWith('.dbml') ? path : `${path}.dbml`);

/**
 * What each end of `ref` (a Ref or pending line of `item`) says beside its
 * table part, as {@link attachRelationships} reads it: its qualifier, and the
 * table file the file's `use` line for that exact spelling (qualifier and
 * name, without case) names, resolved against the file's folder
 * (`item.semanticPath`; without it, no use path). The ends as written: a
 * caller that turns a bare one-to-one round swaps them too.
 */
export function dbmlRefEndHints(item: DbmlAttachReading, ref: DbmlStoredRef): { owner: DbmlRefEndHint; target: DbmlRefEndHint } {
  return endHints(item, ref);
}

/** A `use` specifier's spelling as one key: its qualifier (or none) and its name, without case. */
const useKey = (table: string, qualifier: string | undefined): string =>
  `${qualifier === undefined ? '\u0001' : lower(qualifier)}\u0000${lower(table)}`;

/**
 * Each file's selective `use` lines by spelling ({@link useKey}), the first
 * line of a spelling kept: built once per reading, so resolving every Ref end
 * of a file that imports hundreds of tables stays linear.
 */
const useTablesBySpelling = new WeakMap<readonly DbmlUseTable[], Map<string, DbmlUseTable>>();

/**
 * What {@link endHints} says of an end beside its {@link DbmlRefEndHint}: for
 * an unqualified end, how many schema folders the relationships file's own
 * `use` lines import a table of its name from (`useSchemas`). Internal: the
 * lookup's rule 3 asks it.
 */
type EndHint = DbmlRefEndHint & {
  readonly useSchemas?: number;
  /** The schema folders (as the paths spell them, one per folder) the file's own `use` lines import the end's name from. */
  readonly useSchemaNames?: readonly string[];
  /** Those `use` lines' table files, resolved against the semantic dir. */
  readonly useSchemaPaths?: readonly string[];
  /** For a qualified end: the table folders the file's own `use` lines name. */
  readonly useDirs?: readonly string[];
};

/** What a file's selective `use` lines import a table name from: its schema folders (lower case → as spelled) and table files. */
interface UsedFrom { schemas: Map<string, string>; names: string[]; paths: string[] }

/** Each file's selective `use` lines by the table name they import (lower case). */
const useSchemasByName = new WeakMap<object, Map<string, UsedFrom>>();

/** The schema folders and table files `item`'s `use` lines import a table called `table` from. */
function useSchemasOf(item: DbmlAttachReading, table: string): UsedFrom | undefined {
  const useTables = item.reading.useTables;
  if (item.semanticPath === undefined || useTables === undefined || useTables.length === 0) return undefined;
  let byName = useSchemasByName.get(useTables);
  if (byName === undefined) {
    byName = new Map();
    for (const use of useTables) {
      const path = normalisePosix(resolvePosix(dirnamePosix(item.semanticPath), withDbmlExtension(use.path)));
      const id = tableIdOfPath(path);
      if (id === undefined) continue;
      const key = lower(id.name);
      const used = byName.get(key) ?? { schemas: new Map<string, string>(), names: [], paths: [] };
      if (!used.schemas.has(lower(id.schema))) {
        used.schemas.set(lower(id.schema), id.schema);
        used.names.push(id.schema);
      }
      if (!used.paths.includes(path)) used.paths.push(path);
      byName.set(key, used);
    }
    useSchemasByName.set(useTables, byName);
  }
  return byName.get(lower(table));
}

/** Each file's selective `use` lines' table folders. */
const useDirsByFile = new WeakMap<readonly DbmlUseTable[], string[]>();

/** The table folders (`<layer>/tables/<schema>`) `item`'s `use` lines name, sorted, without repeats. */
function useDirsOf(item: DbmlAttachReading): string[] | undefined {
  const useTables = item.reading.useTables;
  if (item.semanticPath === undefined || useTables === undefined || useTables.length === 0) return undefined;
  let dirs = useDirsByFile.get(useTables);
  if (dirs === undefined) {
    const found = new Set<string>();
    for (const use of useTables) {
      const path = resolvedUsePath(use, item.semanticPath);
      if (tableIdOfPath(path) !== undefined) found.add(dirnamePosix(path));
    }
    dirs = [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    useDirsByFile.set(useTables, dirs);
  }
  return dirs;
}

/**
 * Where another table of the name of the table at `path` would be, for an
 * end qualified `qualifier` (rule 4): the file of its name in each of `dirs`
 * (table folders), and in the qualifier's own schema folder in each of their
 * layers and the table's own. Normalised, in order, without repeats; never
 * a path that is not a table file's.
 */
function namesakePaths(path: string, qualifier: string, dirs: readonly string[]): string[] {
  const own = tableIdOfPath(normalisePosix(path));
  if (own === undefined) return [];
  const file = `${own.name}.dbml`;
  const layers = new Set<string>([own.layer]);
  const out = new Set<string>();
  for (const dir of dirs) {
    const candidate = normalisePosix(`${dir}/${file}`);
    const id = tableIdOfPath(candidate);
    if (id === undefined) continue;
    out.add(candidate);
    layers.add(id.layer);
  }
  for (const layer of layers) {
    const candidate = normalisePosix(dbmlTablePath(layer, qualifier, own.name));
    if (tableIdOfPath(candidate) !== undefined) out.add(candidate);
  }
  return [...out];
}

function useTableFor(useTables: readonly DbmlUseTable[] | undefined, table: string, qualifier: string | undefined): DbmlUseTable | undefined {
  if (useTables === undefined || useTables.length === 0) return undefined;
  let bySpelling = useTablesBySpelling.get(useTables);
  if (bySpelling === undefined) {
    bySpelling = new Map();
    for (const use of useTables) {
      const key = useKey(use.table, use.qualifier);
      if (!bySpelling.has(key)) bySpelling.set(key, use);
    }
    useTablesBySpelling.set(useTables, bySpelling);
  }
  return bySpelling.get(useKey(table, qualifier));
}

/** Each selective `use` line's table file, resolved against the folder of the file that holds it: once per line, not per Ref end. */
const resolvedUsePaths = new WeakMap<DbmlUseTable, { from: string; path: string }>();

function resolvedUsePath(use: DbmlUseTable, semanticPath: string): string {
  const known = resolvedUsePaths.get(use);
  if (known !== undefined && known.from === semanticPath) return known.path;
  const path = normalisePosix(resolvePosix(dirnamePosix(semanticPath), withDbmlExtension(use.path)));
  resolvedUsePaths.set(use, { from: semanticPath, path });
  return path;
}

/** Each file's selective `use` lines' table files by spelling ({@link useKey}), for the spellings two or more files share. */
const sharedSpellings = new WeakMap<readonly DbmlUseTable[], { from: string; byKey: Map<string, string[]> }>();

/**
 * The table files of different identities `item`'s own `use` lines import
 * under the spelling `qualifier.table` (resolved, in line order), when two or
 * more do: the spelling names none of them alone. Undefined otherwise.
 */
function spelledFilesOf(item: DbmlAttachReading, table: string, qualifier: string | undefined): string[] | undefined {
  const useTables = item.reading.useTables;
  if (item.semanticPath === undefined || useTables === undefined || useTables.length < 2) return undefined;
  let known = sharedSpellings.get(useTables);
  if (known === undefined || known.from !== item.semanticPath) {
    const all = new Map<string, { paths: string[]; ids: Set<string> }>();
    for (const use of useTables) {
      const path = resolvedUsePath(use, item.semanticPath);
      const id = tableIdOfPath(path);
      const key = useKey(use.table, use.qualifier);
      const entry = all.get(key) ?? { paths: [], ids: new Set<string>() };
      const idKey = id !== undefined ? tableIdKey(id) : lower(path);
      if (!entry.ids.has(idKey)) {
        entry.ids.add(idKey);
        entry.paths.push(path);
      }
      all.set(key, entry);
    }
    const byKey = new Map<string, string[]>();
    for (const [key, entry] of all) if (entry.paths.length > 1) byKey.set(key, entry.paths);
    known = { from: item.semanticPath, byKey };
    sharedSpellings.set(useTables, known);
  }
  return known.byKey.get(useKey(table, qualifier));
}

function endHints(item: DbmlAttachReading, ref: DbmlStoredRef): { owner: EndHint; target: EndHint } {
  const hintOf = (table: string, qualifier: string | undefined, columns: () => string[]): EndHint => {
    // Rule 0: a spelling two or more of the file's use lines import from different files is no one line's.
    const spelled = spelledFilesOf(item, table, qualifier);
    if (spelled !== undefined) return { ...(qualifier !== undefined ? { qualifier } : {}), usePaths: spelled, columns: columns() };
    const use = item.semanticPath !== undefined ? useTableFor(item.reading.useTables, table, qualifier) : undefined;
    const usePath = use ? resolvedUsePath(use, item.semanticPath!) : undefined;
    // An unqualified end with no use line of its own: which schema folders the file imports its name from.
    const used = qualifier === undefined && usePath === undefined ? useSchemasOf(item, table) : undefined;
    // A qualified one: which table folders the file's lines name (rule 4 looks there for namesakes).
    const useDirs = qualifier !== undefined && usePath === undefined ? useDirsOf(item) : undefined;
    return {
      ...(qualifier !== undefined ? { qualifier } : {}),
      ...(usePath !== undefined ? { usePath } : {}),
      ...(useDirs !== undefined && useDirs.length > 0 ? { useDirs } : {}),
      ...(used !== undefined && used.schemas.size > 1 ? { useSchemas: used.schemas.size } : {}),
      ...(used !== undefined ? { useSchemaNames: used.names, useSchemaPaths: used.paths } : {}),
    };
  };
  return {
    owner: hintOf(ref.owner, ref.ownerQualifier, () => ref.relationships.map((r) => r.fromColumn)),
    target: hintOf(ref.target, ref.targetQualifier, () => ref.relationships.map((r) => r.toColumn)),
  };
}

/**
 * The use paths whose existence decides where a Ref end of `readings` lands
 * among `tables` (rule 4 of {@link dbmlTableLookup}): an end whose qualifier
 * names none of the one table of its name, while its own `use` line names
 * another file (or, with `options.tableDirs`, while it has none: the
 * namesake paths rule 4 names). Empty for a project whose Ref ends all name
 * their tables by a use line or a qualifier that matches. In path order,
 * without repeats.
 */
export function contestedUsePaths(
  readings: readonly DbmlAttachReading[],
  tables: Iterable<DbmlAttachTable>,
  options: { tableDirs?: readonly string[] } = {},
): string[] {
  const resolve = endResolver(tables, options.tableDirs);
  const out = new Set<string>();
  for (const item of readings) {
    if (!item.reading?.readable) continue;
    for (const ref of [...item.reading.refs, ...(item.reading.pending ?? [])]) {
      const hints = endHints(item, ref);
      for (const [name, hint] of [[ref.owner, hints.owner], [ref.target, hints.target]] as const) {
        for (const path of resolve(name, hint).contested ?? []) out.add(path);
      }
    }
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Whether `columns` are exactly the key `key` (without case); an empty key is no key. */
function isWholeKey(key: readonly string[], columns: readonly string[]): boolean {
  const k = new Set(key.map(lower));
  const cols = new Set(columns.map(lower));
  return k.size > 0 && k.size === cols.size && [...cols].every((c) => k.has(c));
}

/**
 * The §2.3 rule for a bare `-` Ref (`oneToOneDirection: 'keys'`), read with
 * its second end as the foreign key (`from`): whether to reverse it, so its
 * first end is the foreign key. Only when both tables' primary keys are
 * known, the read `from` columns are exactly their table's whole key and the
 * read `to` columns are not. The one rule the reader's attach step and the
 * relationships writer share.
 */
export function reverseBareOneToOne(
  fromKey: readonly string[] | undefined,
  fromColumns: readonly string[],
  toKey: readonly string[] | undefined,
  toColumns: readonly string[],
): boolean {
  return fromKey !== undefined && toKey !== undefined && isWholeKey(fromKey, fromColumns) && !isWholeKey(toKey, toColumns);
}

/** A table's primary-key columns (by flag), or undefined when there is no table. */
function primaryKeyOf(entry: DbmlAttachTable | undefined): string[] | undefined {
  if (!entry) return undefined;
  return (entry.table.columns ?? []).filter((c) => c?.isPrimaryKey).map((c) => String(c.name));
}

/** A column's real spelling in `entry` (exact first, then without case), or `column` as written. */
function realColumn(entry: DbmlAttachTable | undefined, column: string): string {
  const names = (entry?.table.columns ?? []).map((c) => c?.name).filter((n): n is string => typeof n === 'string');
  return names.find((n) => n === column) ?? names.find((n) => lower(n) === lower(column)) ?? column;
}

function describeLink(rel: Relationship): string {
  return `${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn}`;
}

function at(location: DbmlRefLocation): string {
  return `${location.path} line ${location.line}`;
}

/**
 * How an end that resolved to no table is spelled: as written, with its
 * qualifier when it names a table that is elsewhere or that several share,
 * so it is never what the scope calls one of them.
 */
function unresolvedEnd(name: string, hint: DbmlRefEndHint, end: EndResolution): string {
  return hint.qualifier !== undefined && (end.contested !== undefined || end.ambiguous !== undefined) ? `${hint.qualifier}.${name}` : name;
}

/**
 * Attach every Ref of `readings` (in path byte order, whatever order they
 * are given in, each file in file order) to its owner, when the owner is a
 * DBML table:
 *
 * - ends are matched by `tables` (a table part, qualifier already removed;
 *   a DBML alias resolves through {@link dbmlTableLookup}), each told its
 *   qualifier and the table file the reading's own `use` line for that
 *   spelling names (resolved against `semanticPath`), so two tables of one
 *   name in different schema folders are told apart; an end several tables
 *   could be and nothing decides is not attached, with a warning. Ends are
 *   respelled to the table's reference (`ref`, else its real name) and the
 *   real column spellings;
 * - a one-to-one the reader left to the keys (`oneToOneDirection: 'keys'`)
 *   reads its first end as the foreign key only when the second end alone is
 *   its table's whole primary key; with a table missing it stays as read
 *   (the second end is the foreign key);
 * - a Ref is attached from whichever relationships file holds it (no file is
 *   a table's home, decision 5); a Ref owned by a YAML table or by no table
 *   is `orphaned`;
 * - a link read more than once (`linkKey`, in any files, either way round) is
 *   attached once, the copy {@link libraryCopyRank} ranks first, and
 *   reported in `duplicates`;
 * - `locations` says where each attached link is stored: the copy kept;
 * - a Ref of several column pairs is one composite: its surviving members
 *   share `nextCompositeKey(entriesSoFar, toModel)`, in file order.
 *
 * A dangling end (a target with no table, or a column it does not have) is
 * kept in the owner's list, as written. A reading's `pending` relationships
 * (D27, `// erd-studio pending: Ref …` lines) are attached exactly like its
 * Refs.
 *
 * `options.partial` says `tables` holds only some of the library (core's
 * loader reads a diagram's members, not every table file): a Ref whose owner
 * it does not have is skipped without a word, since the owner may be a DBML
 * table that is simply not on this diagram, or one whose file did not read
 * (that table carries its own load error). A YAML owner is still orphaned.
 * The host, which passes the whole library, leaves it unset.
 */
export function attachRelationships(
  readings: ReadonlyArray<DbmlAttachReading>,
  tables: DbmlTableLookup,
  options: { dbt?: DbtKeyIndex; partial?: boolean } = {},
): DbmlAttachResult {
  const result: DbmlAttachResult = { byOwner: new Map(), orphaned: [], duplicates: [], warnings: [], locations: new Map() };
  interface Candidate { rel: Relationship; unit: number; at: DbmlRefLocation; rank: string; owner: string }
  const candidates: Candidate[] = [];
  const resolve = resolverOf(tables);
  let unit = 0;
  let index = 0;

  // Path byte order, so the copy a tie keeps and the order of each owner's list
  // never depend on the order a host happened to list the files in.
  const ordered = [...readings].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const item of ordered) {
    const { path, reading } = item;
    if (!reading || !reading.readable) continue;
    // Pending relationships (D27) belong to their owner exactly like live Refs: drawn when both ends are shown.
    for (const ref of [...reading.refs, ...(reading.pending ?? [])]) {
      if (ref.relationships.length === 0) continue;
      let rels = ref.relationships;
      let { owner: ownerHint, target: targetHint } = endHints(item, ref);
      if (ref.oneToOneDirection === 'keys') {
        // Read with the second end as the foreign key; the first is, only when the second alone is a whole key.
        if (reverseBareOneToOne(
          primaryKeyOf(tables(rels[0].fromModel, ownerHint)), rels.map((r) => r.fromColumn),
          primaryKeyOf(tables(rels[0].toModel, targetHint)), rels.map((r) => r.toColumn),
        )) {
          rels = rels.map((r) => reverseRelationship(r));
          [ownerHint, targetHint] = [targetHint, ownerHint];
        }
      }
      const owner = resolve(rels[0].fromModel, ownerHint);
      const target = resolve(rels[0].toModel, targetHint);
      const ownerEntry = owner.entry;
      const targetEntry = target.entry;
      const location: DbmlRefLocation = {
        path,
        line: ref.line,
        owner: ownerEntry ? refOf(ownerEntry) : unresolvedEnd(rels[0].fromModel, ownerHint, owner),
        target: targetEntry ? refOf(targetEntry) : unresolvedEnd(rels[0].toModel, targetHint, target),
        ...(ownerEntry?.path !== undefined ? { ownerPath: ownerEntry.path } : {}),
        ...(targetEntry?.path !== undefined ? { targetPath: targetEntry.path } : {}),
      };
      for (const [name, end, hint] of [[rels[0].fromModel, owner, ownerHint], [rels[0].toModel, target, targetHint]] as const) {
        if (!end.ambiguous) continue;
        const schemas = end.schemas ?? end.ambiguous.map((e) => e.schema ?? '');
        result.warnings.push(end.spelledTwice
          ? `Ref ${describeLink(rels[0])} in ${at(location)} names ${name}, which the file's use lines import from more than one schema folder (${schemas.join(', ')}) under that one spelling, and its columns do not say which: it is not drawn. Declare each table with its schema (Table ${schemas[0] ?? '<schema>'}.${name}) and write the end as <schema>.${name}`
          : `Ref ${describeLink(rels[0])} in ${at(location)} names ${name}, which tables in more than one schema folder have (${schemas.join(', ')}), and nothing says which: it is not drawn until the end names its schema, as in <schema>.${name}`);
        // The schema the end wrote, so a checker can say that schema has no table of the name.
        (result.unresolved ??= []).push({ path, line: ref.line, kind: 'ambiguous', table: name, schemas, ...(hint?.qualifier !== undefined ? { qualifier: hint.qualifier } : {}) });
      }
      if (!ownerEntry && options.partial) continue;
      // The reader keeps a Ref whose ends' qualifiers differ (`ccc.addresse.id > bqs.addresse.id` joins two
      // tables), but when both ends land on one table (a stale qualifier) it joins a column set to itself,
      // which is never drawn: the reader drops it as such when the qualifiers agree.
      if (ownerEntry && targetEntry && identityOf(ownerEntry) === identityOf(targetEntry)
        && rels.every((r) => lower(r.fromColumn) === lower(r.toColumn))) {
        result.warnings.push(`Ref ${describeLink(rels[0])} in ${at(location)} joins a column set to itself (both ends name ${location.owner}); it is not drawn`);
        (result.unresolved ??= []).push({ path, line: ref.line, kind: 'selfJoin', table: location.owner });
        continue;
      }
      if (!ownerEntry || ownerEntry.storage !== 'dbml') {
        result.orphaned.push(location);
        result.warnings.push(ownerEntry
          ? `Ref ${describeLink(rels[0])} in ${at(location)} belongs to ${location.owner}, a YAML table, which keeps its relationships in its own file; it is not drawn from here`
          : `Ref ${describeLink(rels[0])} in ${at(location)} names no table in the library as its foreign-key end (${location.owner}); it is not drawn`);
        continue;
      }
      unit++;
      for (const raw of rels) {
        const rel: Relationship = {
          ...raw,
          fromModel: refOf(ownerEntry),
          fromColumn: realColumn(ownerEntry, raw.fromColumn),
          toModel: location.target,
          toColumn: realColumn(targetEntry, raw.toColumn),
        };
        candidates.push({ rel, unit, at: location, rank: libraryCopyRank(rel, ownerEntry.table, index++, options.dbt), owner: refOf(ownerEntry) });
      }
    }
  }

  // One copy of each link: the lowest rank wins, wherever it was read.
  const winners = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = linkKey(c.rel);
    const held = winners.get(key);
    if (!held || c.rank < held.rank) winners.set(key, c);
  }
  for (const [key, kept] of winners) result.locations!.set(key, kept.at);
  const reported = new Set<Candidate>();
  for (const c of candidates) {
    const kept = winners.get(linkKey(c.rel))!;
    if (kept === c || reported.has(c)) continue;
    reported.add(c);
    const link = describeLink(kept.rel);
    result.duplicates.push({ link, kept: kept.at, dropped: c.at });
    result.warnings.push(`The relationship ${link} is stored twice (${at(kept.at)} and ${at(c.at)}); it is drawn once, from ${at(kept.at)}`);
  }

  // Attach in file order; a unit of several surviving pairs is one composite.
  const surviving = candidates.filter((c) => winners.get(linkKey(c.rel)) === c);
  const unitSize = new Map<number, number>();
  for (const c of surviving) unitSize.set(c.unit, (unitSize.get(c.unit) ?? 0) + 1);
  const unitKey = new Map<number, string>();
  for (const c of surviving) {
    const ownerKey = lower(c.owner);
    const list = result.byOwner.get(ownerKey) ?? [];
    if (!result.byOwner.has(ownerKey)) result.byOwner.set(ownerKey, list);
    const { fromModel: _owner, compositeKey: _none, ...entry } = c.rel;
    if ((unitSize.get(c.unit) ?? 0) > 1) {
      let key = unitKey.get(c.unit);
      if (key === undefined) {
        key = nextCompositeKey(list, c.rel.toModel);
        unitKey.set(c.unit, key);
      }
      list.push({ ...entry, compositeKey: key } as TableRelationship);
    } else {
      list.push(entry as TableRelationship);
    }
  }
  return result;
}
