/**
 * How a model changed between two snapshots (`modelSnapshot.ts`): the pure
 * differ behind `erd-studio changes`, which summarises a pull request's
 * model changes for a review comment.
 *
 * This is a model-versus-model comparison — the design at a git ref against
 * the design in the working tree — and deliberately not
 * `computeSubjectAreaDiff`, which compares one diagram's logical stage with
 * what dbt built (physical) and drives the sync plan. Nothing here looks at
 * dbt, and nothing here decides a fix.
 *
 * - Tables match by name, without case. One removed and one added table
 *   with the same columns (names and types, in order) and no other such
 *   pair is a rename; anything less certain stays an add and a remove.
 * - A table moved when its layer or its schema changed (each compared only
 *   when both versions have one, so converting a flat YAML library to DBML
 *   is not a move of every table).
 * - Relationships match by core's `linkKey`; a cardinality is compared
 *   after turning the new copy to face the same way as the old one.
 * - Diagrams match by `<layer>/<name>`, so a diagram converted from JSON to
 *   DBML is the same diagram.
 */

import { reverseRelationship, type Cardinality, type Relationship } from '@erd-studio/core';

import type { ModelSnapshot, SnapshotColumn, SnapshotRelationship, SnapshotTable } from './modelSnapshot';

/** A key flag of a column. */
export type ColumnKeyFlag = 'pk' | 'fk' | 'nk';

/** Where a table lives. Paths are relative to the semantic dir here; `changes.ts` makes them project-relative. */
export interface TableAt {
  name: string;
  file: string;
  layer?: string;
  schema?: string;
}

export interface TableChange {
  name: string;
  file: string;
  /** Set when this table was renamed from another (`tables.renamed` lists it too). */
  renamedFrom?: string;
  columnsAdded: Array<{ name: string; dataType: string }>;
  columnsRemoved: Array<{ name: string; dataType: string }>;
  typesChanged: Array<{ column: string; from: string; to: string }>;
  keysChanged: Array<{ column: string; key: ColumnKeyFlag; from: boolean; to: boolean }>;
  alias?: { from: string | null; to: string | null };
  role?: { from: string | null; to: string | null };
  grain?: { from: string | null; to: string | null };
}

export interface RelationshipAt {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
  /** The file that holds it ('' when the reader could not say). */
  file: string;
}

export interface DiagramAt {
  name: string;
  layer: string;
  file: string;
  tables: string[];
}

export interface DiagramChange {
  name: string;
  layer: string;
  file: string;
  /** Set when the diagram's file changed (e.g. converted from JSON to DBML). */
  movedFrom?: string;
  tablesAdded: string[];
  tablesRemoved: string[];
}

export interface RelationshipsFileChange {
  file: string;
  status: 'added' | 'removed' | 'changed';
  refsAdded: number;
  refsRemoved: number;
  /** Refs between the same columns that now say something else (a cardinality or a direction). */
  refsChanged: number;
}

export interface ModelChanges {
  tables: {
    added: TableAt[];
    removed: TableAt[];
    renamed: Array<{ from: string; to: string; file: string }>;
    moved: Array<{ name: string; from: TableAt; to: TableAt }>;
    changed: TableChange[];
  };
  relationships: {
    added: RelationshipAt[];
    removed: RelationshipAt[];
    changed: Array<RelationshipAt & { fromCardinality: Cardinality }>;
  };
  diagrams: {
    added: DiagramAt[];
    removed: DiagramAt[];
    changed: DiagramChange[];
  };
  relationshipsFiles: RelationshipsFileChange[];
}

const lower = (s: string): string => s.toLowerCase();

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function tableAt(t: SnapshotTable): TableAt {
  return {
    name: t.name,
    file: t.file,
    ...(t.layer ? { layer: t.layer } : {}),
    ...(t.schema ? { schema: t.schema } : {}),
  };
}

function relationshipAt(r: SnapshotRelationship): RelationshipAt {
  return {
    fromTable: r.fromTable,
    fromColumn: r.fromColumn,
    toTable: r.toTable,
    toColumn: r.toColumn,
    cardinality: r.cardinality,
    file: r.file,
  };
}

/** A table's columns as one string (names and types in order, without case): what a rename must keep. */
function columnSignature(t: SnapshotTable): string {
  return t.columns.map((c) => `${lower(c.name)}:${lower(c.dataType.trim())}`).join('\u0001');
}

/** Pairs of removed → added tables that are certainly renames: identical, non-empty columns, one candidate each way. */
function detectRenames(removed: SnapshotTable[], added: SnapshotTable[]): Array<[SnapshotTable, SnapshotTable]> {
  const bySignature = (list: SnapshotTable[]): Map<string, SnapshotTable[]> => {
    const out = new Map<string, SnapshotTable[]>();
    for (const t of list) {
      if (t.unreadable || t.columns.length === 0) continue;
      const sig = columnSignature(t);
      out.set(sig, [...(out.get(sig) ?? []), t]);
    }
    return out;
  };
  const gone = bySignature(removed);
  const born = bySignature(added);
  const pairs: Array<[SnapshotTable, SnapshotTable]> = [];
  for (const [sig, from] of gone) {
    const to = born.get(sig);
    if (from.length === 1 && to?.length === 1) pairs.push([from[0], to[0]]);
  }
  return pairs;
}

function sameLocationPart(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || lower(a) === lower(b);
}

function optionalChange(from: string | undefined, to: string | undefined): { from: string | null; to: string | null } | undefined {
  const a = from?.trim() ? from : undefined;
  const b = to?.trim() ? to : undefined;
  if (a === b) return undefined;
  return { from: a ?? null, to: b ?? null };
}

/** What changed inside one table; null when nothing did (or either version could not be read). */
function tableChange(base: SnapshotTable, head: SnapshotTable): TableChange | null {
  if (base.unreadable || head.unreadable) return null;
  const baseCols = new Map<string, SnapshotColumn>(base.columns.map((c) => [lower(c.name), c]));
  const headCols = new Map<string, SnapshotColumn>(head.columns.map((c) => [lower(c.name), c]));
  const change: TableChange = {
    name: head.name,
    file: head.file,
    columnsAdded: head.columns.filter((c) => !baseCols.has(lower(c.name))).map((c) => ({ name: c.name, dataType: c.dataType })),
    columnsRemoved: base.columns.filter((c) => !headCols.has(lower(c.name))).map((c) => ({ name: c.name, dataType: c.dataType })),
    typesChanged: [],
    keysChanged: [],
  };
  for (const c of head.columns) {
    const was = baseCols.get(lower(c.name));
    if (!was) continue;
    if (lower(was.dataType.trim()) !== lower(c.dataType.trim())) {
      change.typesChanged.push({ column: c.name, from: was.dataType, to: c.dataType });
    }
    for (const key of ['pk', 'fk', 'nk'] as const) {
      if (was[key] !== c[key]) change.keysChanged.push({ column: c.name, key, from: was[key], to: c[key] });
    }
  }
  const alias = optionalChange(base.alias, head.alias);
  const role = optionalChange(base.role, head.role);
  const grain = optionalChange(base.grain, head.grain);
  if (alias) change.alias = alias;
  if (role) change.role = role;
  if (grain) change.grain = grain;
  const changed = change.columnsAdded.length + change.columnsRemoved.length + change.typesChanged.length
    + change.keysChanged.length > 0 || !!alias || !!role || !!grain;
  return changed ? change : null;
}

/** `head` turned to face the way `base` does, so their cardinalities compare. */
function facing(base: SnapshotRelationship, head: SnapshotRelationship): Cardinality {
  const sameFrom = lower(base.fromTable) === lower(head.fromTable) && lower(base.fromColumn) === lower(head.fromColumn);
  if (sameFrom) return head.cardinality;
  const asRelationship: Relationship = {
    fromModel: head.fromTable, fromColumn: head.fromColumn, toModel: head.toTable, toColumn: head.toColumn, cardinality: head.cardinality,
  };
  return reverseRelationship(asRelationship).cardinality;
}

/** Compare two snapshots: everything `head` (the working tree) changed since `base` (the git ref). */
export function diffModelSnapshots(base: ModelSnapshot, head: ModelSnapshot): ModelChanges {
  const byName = (a: { name: string }, b: { name: string }): number => byteOrder(lower(a.name), lower(b.name)) || byteOrder(a.name, b.name);

  // Tables.
  const removedTables = [...base.tables].filter(([k]) => !head.tables.has(k)).map(([, t]) => t);
  const addedTables = [...head.tables].filter(([k]) => !base.tables.has(k)).map(([, t]) => t);
  const renames = detectRenames(removedTables, addedTables);
  const renamedFrom = new Set(renames.map(([from]) => lower(from.name)));
  const renamedTo = new Set(renames.map(([, to]) => lower(to.name)));

  const changed: TableChange[] = [];
  const moved: ModelChanges['tables']['moved'] = [];
  const matched: Array<[SnapshotTable, SnapshotTable, string | undefined]> = [
    ...[...head.tables].filter(([k]) => base.tables.has(k)).map(([k, t]) => [base.tables.get(k)!, t, undefined] as [SnapshotTable, SnapshotTable, undefined]),
    ...renames.map(([from, to]) => [from, to, from.name] as [SnapshotTable, SnapshotTable, string]),
  ];
  for (const [was, now, renamed] of matched) {
    if (!sameLocationPart(was.layer, now.layer) || !sameLocationPart(was.schema, now.schema)) {
      moved.push({ name: now.name, from: tableAt(was), to: tableAt(now) });
    }
    const change = tableChange(was, now);
    if (change) {
      changed.push(renamed !== undefined ? { ...change, renamedFrom: renamed } : change);
    }
  }

  // Relationships.
  const relationshipsAdded: RelationshipAt[] = [];
  const relationshipsRemoved: RelationshipAt[] = [];
  const relationshipsChanged: ModelChanges['relationships']['changed'] = [];
  for (const [key, r] of head.relationships) {
    const was = base.relationships.get(key);
    if (!was) {
      relationshipsAdded.push(relationshipAt(r));
    } else if (facing(was, r) !== was.cardinality) {
      relationshipsChanged.push({ ...relationshipAt(r), fromCardinality: was.cardinality });
    }
  }
  for (const [key, r] of base.relationships) {
    if (!head.relationships.has(key)) relationshipsRemoved.push(relationshipAt(r));
  }
  const relOrder = (a: RelationshipAt, b: RelationshipAt): number =>
    byteOrder(lower(`${a.fromTable}.${a.fromColumn}`), lower(`${b.fromTable}.${b.fromColumn}`))
    || byteOrder(lower(`${a.toTable}.${a.toColumn}`), lower(`${b.toTable}.${b.toColumn}`));

  // Diagrams.
  const diagramAt = (d: { name: string; layer: string; file: string; tables: string[] }): DiagramAt =>
    ({ name: d.name, layer: d.layer, file: d.file, tables: [...d.tables] });
  const diagramsAdded = [...head.diagrams].filter(([k]) => !base.diagrams.has(k)).map(([, d]) => diagramAt(d));
  const diagramsRemoved = [...base.diagrams].filter(([k]) => !head.diagrams.has(k)).map(([, d]) => diagramAt(d));
  const diagramsChanged: DiagramChange[] = [];
  for (const [k, now] of head.diagrams) {
    const was = base.diagrams.get(k);
    if (!was || was.unreadable || now.unreadable) continue;
    const before = new Set(was.tables.map(lower));
    const after = new Set(now.tables.map(lower));
    const tablesAdded = now.tables.filter((t) => !before.has(lower(t)));
    const tablesRemoved = was.tables.filter((t) => !after.has(lower(t)));
    const fileMoved = was.file !== now.file;
    if (tablesAdded.length === 0 && tablesRemoved.length === 0 && !fileMoved) continue;
    diagramsChanged.push({
      name: now.name,
      layer: now.layer,
      file: now.file,
      ...(fileMoved ? { movedFrom: was.file } : {}),
      tablesAdded,
      tablesRemoved,
    });
  }
  const diagramOrder = (a: { layer: string; name: string }, b: { layer: string; name: string }): number =>
    byteOrder(lower(`${a.layer}/${a.name}`), lower(`${b.layer}/${b.name}`));

  // Relationships files.
  const relationshipsFiles: RelationshipsFileChange[] = [];
  const files = [...new Set([...base.relationshipsFiles.keys(), ...head.relationshipsFiles.keys()])].sort(byteOrder);
  for (const file of files) {
    const was = base.relationshipsFiles.get(file);
    const now = head.relationshipsFiles.get(file);
    if ((was?.unreadable && now) || (now?.unreadable && was)) continue;
    const before = was?.refs ?? new Map<string, string>();
    const after = now?.refs ?? new Map<string, string>();
    const refsAdded = [...after.keys()].filter((r) => !before.has(r)).length;
    const refsRemoved = [...before.keys()].filter((r) => !after.has(r)).length;
    const refsChanged = [...after].filter(([r, says]) => before.has(r) && before.get(r) !== says).length;
    const status: RelationshipsFileChange['status'] = !was ? 'added' : !now ? 'removed' : 'changed';
    if (status === 'changed' && refsAdded + refsRemoved + refsChanged === 0) continue;
    relationshipsFiles.push({ file, status, refsAdded, refsRemoved, refsChanged });
  }

  return {
    tables: {
      added: addedTables.filter((t) => !renamedTo.has(lower(t.name))).map(tableAt).sort(byName),
      removed: removedTables.filter((t) => !renamedFrom.has(lower(t.name))).map(tableAt).sort(byName),
      renamed: renames.map(([from, to]) => ({ from: from.name, to: to.name, file: to.file })).sort((a, b) => byteOrder(lower(a.to), lower(b.to))),
      moved: moved.sort(byName),
      changed: changed.sort(byName),
    },
    relationships: {
      added: relationshipsAdded.sort(relOrder),
      removed: relationshipsRemoved.sort(relOrder),
      changed: relationshipsChanged.sort(relOrder),
    },
    diagrams: {
      added: diagramsAdded.sort(diagramOrder),
      removed: diagramsRemoved.sort(diagramOrder),
      changed: diagramsChanged.sort(diagramOrder),
    },
    relationshipsFiles,
  };
}

/** Whether anything changed at all. */
export function hasModelChanges(c: ModelChanges): boolean {
  return c.tables.added.length + c.tables.removed.length + c.tables.renamed.length + c.tables.moved.length + c.tables.changed.length
    + c.relationships.added.length + c.relationships.removed.length + c.relationships.changed.length
    + c.diagrams.added.length + c.diagrams.removed.length + c.diagrams.changed.length
    + c.relationshipsFiles.length > 0;
}
