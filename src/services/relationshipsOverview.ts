/**
 * Every relationship in the project, for the sidebar's Relationships view:
 * the library's (each FK table's own, YAML or DBML) and, for a YAML/JSON
 * project that still keeps some in its diagram files, those too. One entry
 * per line the canvas draws: a composite key's column pairs are folded into
 * one entry, and a link stored both in the library and in a diagram is
 * listed once (the library's copy, as the canvas draws it).
 *
 * Pure: the host reads the tables and diagrams, this only arranges them, so
 * it stays testable without VS Code and never writes.
 */
import { canonicalRelationship, linkKey } from '@erd-studio/core';
import type { Cardinality, Relationship, SemanticTable } from '../types/semantic';
import type { SubjectAreaRelationships } from '../commands/moveRelationshipsToLibrary';

/** What is wrong with a relationship, from what the library holds. */
export type RelationshipProblem =
  | { kind: 'missingTable'; table: string }
  | { kind: 'missingColumn'; table: string; column: string };

/** Where a relationship is written down. */
export type RelationshipSource =
  | { kind: 'library'; table: string }
  | { kind: 'diagram'; filePath: string; label: string };

export interface RelationshipEntry {
  /** The FK ("many") side, as the canvas draws it (`canonicalRelationship`). */
  readonly fromModel: string;
  readonly toModel: string;
  /** One column per pair, in order; a composite key has several. */
  readonly fromColumns: readonly string[];
  readonly toColumns: readonly string[];
  readonly cardinality: Cardinality;
  readonly role?: string;
  /** The first column pair as stored, to find where it is written. */
  readonly first: Relationship;
  readonly source: RelationshipSource;
  readonly problems: readonly RelationshipProblem[];
}

/** One table's relationships, read from that table's side. */
export interface TableRelationships {
  readonly table: string;
  /** This table holds the foreign key (`fromModel`). */
  readonly outgoing: readonly RelationshipEntry[];
  /** Another table points at this one (`toModel`). A self-reference is outgoing only. */
  readonly incoming: readonly RelationshipEntry[];
}

export interface RelationshipsOverview {
  readonly entries: readonly RelationshipEntry[];
  /** Tables with at least one relationship, by name. */
  readonly tables: readonly TableRelationships[];
  /** The entries with a problem, in the order of {@link entries}. */
  readonly problems: readonly RelationshipEntry[];
}

const lower = (s: string): string => s.trim().toLowerCase();

/** The key one canvas line is known by: its tables, its composite key (or its single pair). */
function lineKey(rel: Relationship): string {
  return rel.compositeKey
    ? `${lower(rel.fromModel)}\0${lower(rel.toModel)}\0#${lower(rel.compositeKey)}`
    : linkKey(rel);
}

/**
 * Arrange `tables` (the library, with their relationships) and the diagram
 * files' own relationships (`diagrams`, YAML/JSON projects only) into the
 * Relationships view's model. Library copies win a link stored in both.
 */
export function buildRelationshipsOverview(
  tables: readonly SemanticTable[],
  diagrams: readonly SubjectAreaRelationships[] = [],
): RelationshipsOverview {
  const byName = new Map<string, SemanticTable>();
  for (const t of tables) if (!byName.has(lower(t.name))) byName.set(lower(t.name), t);

  // Pairs grouped into canvas lines, library first so its copy wins.
  const lines = new Map<string, { pairs: Relationship[]; source: RelationshipSource }>();
  const seenLinks = new Set<string>();
  const add = (stored: Relationship, source: RelationshipSource): void => {
    const link = linkKey(stored);
    if (seenLinks.has(link)) return;
    seenLinks.add(link);
    const rel = canonicalRelationship(stored);
    const key = `${source.kind === 'diagram' ? `${source.filePath}\0` : ''}${lineKey(rel)}`;
    const line = lines.get(key);
    if (line) line.pairs.push(rel);
    else lines.set(key, { pairs: [rel], source });
  };
  for (const t of tables) {
    for (const rel of t.relationships ?? []) add({ fromModel: t.name, ...rel }, { kind: 'library', table: t.name });
  }
  for (const d of diagrams) {
    for (const rel of d.relationships) add(rel, { kind: 'diagram', filePath: d.filePath, label: d.label });
  }

  const entries: RelationshipEntry[] = [];
  for (const { pairs, source } of lines.values()) {
    const first = pairs[0];
    entries.push({
      fromModel: byName.get(lower(first.fromModel))?.name ?? first.fromModel,
      toModel: byName.get(lower(first.toModel))?.name ?? first.toModel,
      fromColumns: pairs.map((p) => p.fromColumn),
      toColumns: pairs.map((p) => p.toColumn),
      cardinality: first.cardinality,
      ...(first.role ? { role: first.role } : {}),
      first,
      source,
      problems: problemsOf(pairs, byName),
    });
  }
  entries.sort((a, b) => a.fromModel.localeCompare(b.fromModel) || a.toModel.localeCompare(b.toModel)
    || a.fromColumns.join(',').localeCompare(b.fromColumns.join(',')));

  const perTable = new Map<string, { table: string; outgoing: RelationshipEntry[]; incoming: RelationshipEntry[] }>();
  const slot = (name: string) => {
    let s = perTable.get(lower(name));
    if (!s) perTable.set(lower(name), (s = { table: name, outgoing: [], incoming: [] }));
    return s;
  };
  for (const e of entries) {
    slot(e.fromModel).outgoing.push(e);
    if (lower(e.toModel) !== lower(e.fromModel)) slot(e.toModel).incoming.push(e);
  }
  return {
    entries,
    tables: [...perTable.values()].sort((a, b) => a.table.localeCompare(b.table)),
    problems: entries.filter((e) => e.problems.length > 0),
  };
}

/** A missing table at either end, else each column its table does not have. */
function problemsOf(pairs: readonly Relationship[], byName: ReadonlyMap<string, SemanticTable>): RelationshipProblem[] {
  const problems: RelationshipProblem[] = [];
  const check = (tableName: string, columns: string[]): void => {
    const table = byName.get(lower(tableName));
    if (!table) {
      problems.push({ kind: 'missingTable', table: tableName });
      return;
    }
    const have = new Set((table.columns ?? []).map((c) => lower(String(c.name ?? ''))));
    for (const column of columns) {
      if (!have.has(lower(column))) problems.push({ kind: 'missingColumn', table: table.name, column });
    }
  };
  const { fromModel, toModel } = pairs[0];
  check(fromModel, pairs.map((p) => p.fromColumn));
  // A self-reference to a missing table is one problem, not two.
  if (lower(toModel) !== lower(fromModel) || byName.has(lower(fromModel))) {
    check(toModel, pairs.map((p) => p.toColumn));
  }
  return problems;
}

/** The cardinality read from the other end: many-to-one ↔ one-to-many. */
export function cardinalityFrom(entry: RelationshipEntry, side: 'from' | 'to'): Cardinality {
  if (side === 'from') return entry.cardinality;
  if (entry.cardinality === 'many-to-one') return 'one-to-many';
  if (entry.cardinality === 'one-to-many') return 'many-to-one';
  return entry.cardinality;
}

/** `a` or `(a, b)` for a composite. */
export function columnList(columns: readonly string[]): string {
  return columns.length === 1 ? columns[0] : `(${columns.join(', ')})`;
}

/** One plain sentence naming the problem. */
export function describeProblem(problem: RelationshipProblem): string {
  return problem.kind === 'missingTable'
    ? `No table named "${problem.table}" in the table library.`
    : `Table "${problem.table}" has no column "${problem.column}".`;
}
