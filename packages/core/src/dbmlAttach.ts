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
  DbmlRefLocation,
  DbmlRelationshipsReading,
} from './types/dbmlStorage.js';
import type { DbtKeyIndex } from './keyEvidence.js';
import { libraryCopyRank } from './domain.js';
import { linkKey, nextCompositeKey, reverseRelationship } from './relationships.js';
import { TABLES_DIR } from './logicalModel.js';

const lower = (s: string): string => s.toLowerCase();

/**
 * A lookup over `tables` for {@link attachRelationships}: a Ref end's table
 * part matched by name, without case, and then by a DBML alias declared in
 * a table file (`Table fct_order as FO`). A name always beats an alias.
 */
export function dbmlTableLookup(tables: Iterable<DbmlAttachTable>): (name: string) => DbmlAttachTable | undefined {
  const byName = new Map<string, DbmlAttachTable>();
  const byAlias = new Map<string, DbmlAttachTable>();
  for (const entry of tables) {
    const name = lower(entry.table.name);
    if (!byName.has(name)) byName.set(name, entry);
    if (entry.dbmlAlias) {
      const alias = lower(entry.dbmlAlias);
      if (!byAlias.has(alias)) byAlias.set(alias, entry);
    }
  }
  return (name) => byName.get(lower(name)) ?? byAlias.get(lower(name));
}

/**
 * The library folder a relationships file sits in: `tables/_relationships.dbml`
 * → `''`, `tables/gold/_relationships.dbml` → `gold`. Any prefix (the
 * semantic dir, an absolute path) and either separator are allowed.
 */
export function relationshipsFileFolder(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s !== '');
  return segments.length >= 3 && segments[segments.length - 3] === TABLES_DIR ? segments[segments.length - 2] : '';
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
 * Attach every Ref of `readings` (in the order given, each file in file
 * order) to its owner, when the owner is a DBML table:
 *
 * - ends are matched by `tables` (a table part, qualifier already removed;
 *   a DBML alias resolves through {@link dbmlTableLookup}) and respelled to
 *   the real table and column spellings;
 * - a one-to-one the reader left to the keys (`oneToOneDirection: 'keys'`)
 *   reads its first end as the foreign key only when the second end alone is
 *   its table's whole primary key; with a table missing it stays as read
 *   (the second end is the foreign key);
 * - a Ref in a file other than its owner's folder's is attached and reported
 *   `misplaced`; one owned by a YAML table or by no table is `orphaned`;
 * - a link read more than once (`linkKey`, in any files, either way round) is
 *   attached once, the copy {@link libraryCopyRank} ranks first, and
 *   reported in `duplicates`;
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
  readings: ReadonlyArray<{ path: string; folder?: string; reading: DbmlRelationshipsReading }>,
  tables: (name: string) => DbmlAttachTable | undefined,
  options: { dbt?: DbtKeyIndex; partial?: boolean } = {},
): DbmlAttachResult {
  const result: DbmlAttachResult = { byOwner: new Map(), misplaced: [], orphaned: [], duplicates: [], warnings: [] };
  interface Candidate { rel: Relationship; unit: number; at: DbmlRefLocation; rank: string; owner: string }
  const candidates: Candidate[] = [];
  let unit = 0;
  let index = 0;

  for (const { path, folder: givenFolder, reading } of readings) {
    if (!reading || !reading.readable) continue;
    const folder = givenFolder ?? relationshipsFileFolder(path);
    // Pending relationships (D27) belong to their owner exactly like live Refs: drawn when both ends are shown.
    for (const ref of [...reading.refs, ...(reading.pending ?? [])]) {
      if (ref.relationships.length === 0) continue;
      let rels = ref.relationships;
      if (ref.oneToOneDirection === 'keys') {
        // Read with the second end as the foreign key; the first is, only when the second alone is a whole key.
        if (reverseBareOneToOne(
          primaryKeyOf(tables(rels[0].fromModel)), rels.map((r) => r.fromColumn),
          primaryKeyOf(tables(rels[0].toModel)), rels.map((r) => r.toColumn),
        )) {
          rels = rels.map((r) => reverseRelationship(r));
        }
      }
      const ownerEntry = tables(rels[0].fromModel);
      const targetEntry = tables(rels[0].toModel);
      const location: DbmlRefLocation = {
        path,
        line: ref.line,
        owner: ownerEntry?.table.name ?? rels[0].fromModel,
        target: targetEntry?.table.name ?? rels[0].toModel,
      };
      if (!ownerEntry && options.partial) continue;
      if (!ownerEntry || ownerEntry.storage !== 'dbml') {
        result.orphaned.push(location);
        result.warnings.push(ownerEntry
          ? `Ref ${describeLink(rels[0])} in ${at(location)} belongs to ${location.owner}, a YAML table, which keeps its relationships in its own file; it is not drawn from here`
          : `Ref ${describeLink(rels[0])} in ${at(location)} names no table in the library as its foreign-key end (${location.owner}); it is not drawn`);
        continue;
      }
      if (ownerEntry.folder !== folder) {
        const home = ownerEntry.folder;
        result.misplaced.push({ ...location, home });
        result.warnings.push(
          `Ref ${describeLink(rels[0])} in ${at(location)} belongs to ${location.owner}, whose relationships file is in ` +
          `${home === '' ? 'tables/' : `tables/${home}/`}; it is drawn, and the next edit of ${location.owner}'s relationships moves it there`,
        );
      }
      unit++;
      for (const raw of rels) {
        const rel: Relationship = {
          ...raw,
          fromModel: ownerEntry.table.name,
          fromColumn: realColumn(ownerEntry, raw.fromColumn),
          toModel: targetEntry?.table.name ?? raw.toModel,
          toColumn: realColumn(targetEntry, raw.toColumn),
        };
        candidates.push({ rel, unit, at: location, rank: libraryCopyRank(rel, ownerEntry.table, index++, options.dbt), owner: ownerEntry.table.name });
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
