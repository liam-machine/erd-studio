/**
 * Partitions and inheritance children, resolved once every file is read
 * (before keys, comments and foreign keys are applied):
 *
 *  - `CREATE TABLE c PARTITION OF p …` and `CREATE TABLE c () INHERITS (p)`:
 *    no columns of their own;
 *  - `CREATE TABLE c (…)` then `ALTER TABLE p ATTACH PARTITION c …` (pg_dump),
 *    in either order, and `CREATE TABLE c (…) INHERITS (p)` /
 *    `ALTER TABLE c INHERIT p`: a child with columns of its own, which has
 *    none beyond its parent's when every column is also the parent's.
 *
 * By default ({@link SqlPartitionMode} `fold`) a child with no columns of its
 * own is its parent's rows, not a table: it folds into its parent (through
 * every level), with one ledger note per child at its CREATE TABLE's line.
 * What the files say about it is then about the parent: its foreign keys are
 * drawn from the parent, one to it points at the parent, and a key, check,
 * description or column detail the parent does not already have is a ledger
 * loss at its own line. A child with columns its parent does not have, or
 * with several parents, stays a table (said). `tables` keeps every child as
 * a table: one with no columns of its own gets its parent's. A child whose
 * parent is not in the files is kept when it has columns, else reported as
 * lost; an `INHERITS` child always gets the columns it inherits.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import {
  DEFAULT_SCHEMA,
  primaryKeyOf,
  readerState,
  removeWhere,
  sameIdent,
  tableKey,
  tableLabel,
  type ChildChange,
  type ConverterContext,
  type ModelField,
  type ModelTable,
  type Origin,
  type PendingComment,
  type PendingKey,
  type ReaderPartition,
} from './sqlDdlModel';

/** Why a child is a table when partitions are kept (`partitions: 'tables'`): one phrase, so the notes group them. */
const KEPT_AS_ASKED = 'as tables of their own, as asked';

type Fate =
  | { kind: 'fold'; into: ModelTable }
  | { kind: 'table'; table: ModelTable }
  | { kind: 'lost' };

/** A child folded into its parent: its own table (when it had one), its records, where the ledger places it. */
interface Fold {
  key: string;
  own?: ModelTable;
  label: string;
  into: ModelTable;
  how: ReaderPartition['how'];
  where: Origin;
  columnOptions: NonNullable<ReaderPartition['columnOptions']>;
  /** Its own table was built from its parent's columns and the ALTER TABLE changes made to it: where each change was written. */
  changes?: Replayed;
}

/** ALTER TABLE changes replayed on a child's table: the change that last touched each column (by lower-case name), and each column dropped. */
interface Replayed {
  at: Map<string, Origin>;
  dropped: Array<{ column: string; origin: Origin }>;
}

const partsOf = (table: ModelTable): string[] => [...(table.schema !== null ? [table.schema] : []), table.name];

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && a.length === b.length && a.every((x) => b.some((y) => sameIdent(x, y)));

const typeText = (type: string): string => type.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Folds every partition and inheritance child into its parent, or keeps it
 * as a table, as {@link ConverterContext.partitionMode} says; records the
 * counts in the reader state (`partitionsResolved`). Runs once, before
 * `applyDeferred` applies the pending keys and comments.
 */
export function resolvePartitions(cx: ConverterContext): void {
  const state = readerState(cx);
  const records = state.partitions;
  if (records.length === 0) return;
  const foldMode = cx.partitionMode !== 'tables';
  const normKey = (parts: readonly string[]): string =>
    `${(parts.length >= 2 ? parts[parts.length - 2] : DEFAULT_SCHEMA[cx.dialect] ?? '').toLowerCase()}.${parts[parts.length - 1].toLowerCase()}`;
  const keyOf = (parts: readonly string[]): string => {
    const table = cx.findTable(parts);
    return table ? tableKey(table, cx.dialect) : normKey(parts);
  };

  const groups = new Map<string, ReaderPartition[]>();
  for (const r of records) {
    const key = keyOf(r.child);
    const group = groups.get(key);
    if (group) group.push(r); else groups.set(key, [r]);
  }

  const fates = new Map<string, Fate>();
  const visiting = new Set<string>();
  const folds: Fold[] = [];
  let kept = 0;

  // Column changes made to a child with no table yet, by child: replayed on its table, or reported when it folds.
  const changesByKey = new Map<string, ChildChange[]>();
  for (const c of state.childChanges) {
    const key = keyOf(c.child);
    const list = changesByKey.get(key);
    if (list) list.push(c); else changesByKey.set(key, [c]);
  }
  state.childChanges.length = 0;
  const replay = (key: string, table: ModelTable): Replayed => {
    const out: Replayed = { at: new Map(), dropped: [] };
    const changes = changesByKey.get(key) ?? [];
    changesByKey.delete(key);
    for (const c of changes) {
      const before = new Map(table.fields.map((f) => [f, JSON.stringify(f)] as const));
      c.run(partsOf(table));
      for (const f of table.fields) if (before.get(f) !== JSON.stringify(f)) out.at.set(f.name.toLowerCase(), c.origin);
      for (const f of before.keys()) {
        if (!table.fields.includes(f) && !table.fields.some((g) => sameIdent(g.name, f.name))) out.dropped.push({ column: f.name, origin: c.origin });
      }
    }
    return out;
  };

  /** The table `parts` ends up as: itself, the parent it folds into, the table it is kept as; undefined when it is not in the files. */
  const finalTable = (parts: readonly string[]): ModelTable | undefined => {
    const key = keyOf(parts);
    if (!groups.has(key)) return cx.findTable(parts);
    const fate = decide(key);
    return fate.kind === 'fold' ? fate.into : fate.kind === 'table' ? fate.table : undefined;
  };

  const decide = (key: string): Fate => {
    const known = fates.get(key);
    if (known) return known;
    const recs = groups.get(key)!;
    if (visiting.has(key)) {
      // A loop (a child of its own child): it stays what the files made it.
      const own = cx.findTable(recs[0].child);
      return own ? { kind: 'table', table: own } : { kind: 'lost' };
    }
    visiting.add(key);
    const fate = decideFresh(key, recs);
    visiting.delete(key);
    fates.set(key, fate);
    return fate;
  };

  const decideFresh = (key: string, recs: ReaderPartition[]): Fate => {
    const own = cx.findTable(recs[0].child);
    const live = recs.filter((r) => !r.detached);
    const first = live[0] ?? recs[0];
    const how = first.how;
    const label = own ? tableLabel(own) : first.child.slice(-2).join('.');
    const origin = own?.origin ?? first.origin;
    const where = { file: origin.file, line: origin.line, table: label };
    const noColumns = !own && recs.some((r) => r.noColumns);
    const columnOptions = live.find((r) => r.columnOptions)?.columnOptions ?? [];

    // Detached from every parent: an ordinary table from then on.
    if (live.length === 0) {
      if (own) return { kind: 'table', table: own };
      if (!noColumns) return { kind: 'lost' };
      const parent = finalTable(first.parent);
      if (!parent) {
        cx.ledger.lost('table', 'notInFiles', 'detached partition', where, `not kept: a partition of ${first.parent.slice(-2).join('.')}, which is not in the files`);
        return { kind: 'lost' };
      }
      const table = materialise(cx, first.child, [parent], 'PARTITION OF', first.origin, columnOptions, label);
      replay(key, table);
      kept++;
      cx.ledger.changed('table', 'other', 'detached partitions kept', where, `as tables of their own, with the columns of ${tableLabel(parent)} (DETACH PARTITION)`);
      return { kind: 'table', table };
    }

    // Each parent once, in the order the files name them.
    const parents: Array<{ record: ReaderPartition; table?: ModelTable }> = [];
    for (const r of live) {
      if (parents.some((p) => keyOf(p.record.parent) === keyOf(r.parent))) continue;
      parents.push({ record: r, table: finalTable(r.parent) });
    }
    const found = parents.filter((p): p is { record: ReaderPartition; table: ModelTable } => !!p.table && p.table !== own);
    const missing = parents.filter((p) => !p.table).map((p) => p.record.parent.slice(-2).join('.'));
    const whatOf = (names: string): string => (how === 'INHERITS' ? `tables inheriting from ${names}` : `partitions of ${names}`);
    const named = (found.length ? found.map((p) => tableLabel(p.table)) : missing).join(', ');
    const notInFiles = missing.length ? `; ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in the files` : '';

    if (found.length === 0 && missing.length === 0) {
      // Every parent is the child itself, through a loop of partition links: it stays what the files made it.
      const what = how === 'INHERITS' ? 'tables inheriting from themselves' : 'partitions of themselves';
      if (own) {
        kept++;
        cx.ledger.changed('table', 'other', `${what} kept`, where, 'as a table of its own: its partition links loop back to it');
        return { kind: 'table', table: own };
      }
      cx.ledger.lost('table', 'other', what, where, 'not kept: its partition links loop back to it, so it has no columns');
      return { kind: 'lost' };
    }

    if (!own && !noColumns) {
      // `ATTACH PARTITION c` of a table the files never create.
      cx.notApplied(first.origin, `${label} attached as a partition of ${named}, which is not in the files (not applied)`);
      return { kind: 'lost' };
    }

    if (found.length === 0) {
      if (own) {
        cx.ledger.changed('table', 'notInFiles', `${whatOf(named)} kept`, where, `as a table of its own: ${how} ${named}, which is not in the files`);
        kept++;
        return { kind: 'table', table: own };
      }
      cx.ledger.lost('table', 'notInFiles', how === 'INHERITS' ? 'inheriting table' : 'partition', where, `not kept: ${how} ${named}, which is not in the files`);
      return { kind: 'lost' };
    }

    const single = found.length === 1 && missing.length === 0 ? found[0].table : undefined;
    const several = found.length > 1 ? ` (it ${how === 'INHERITS' ? 'inherits from' : 'is a partition of'} ${found.length} tables)` : '';
    if (own) {
      // An INHERITS child has its parents' columns too (inherited first, as PostgreSQL lists them).
      const inherited = how === 'INHERITS' ? inheritColumns(own, found.map((p) => p.table)) : 0;
      const parent = found.length === 1 ? found[0].table : undefined;
      const extra = parent ? own.fields.filter((f) => !parent.fields.some((g) => sameIdent(g.name, f.name))).map((f) => f.name) : [];
      if (foldMode && single && extra.length === 0) {
        folds.push({ key, own, label, into: single, how, where, columnOptions: [] });
        return { kind: 'fold', into: single };
      }
      kept++;
      let reason = KEPT_AS_ASKED;
      if (foldMode) {
        reason = extra.length
          ? `as a table of its own: it has columns ${named} does not (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', …' : ''})`
          : `as a table of its own${several}`;
        if (inherited) reason += `; ${inherited} inherited ${inherited === 1 ? 'column' : 'columns'} added`;
      }
      cx.ledger.changed('table', 'other', `${whatOf(named)} kept`, where, `${reason}${notInFiles}`);
      return { kind: 'table', table: own };
    }

    // No columns of its own, unless an ALTER TABLE changed them: its table is its parent's columns with those changes.
    if (foldMode && single && changesByKey.has(key)) {
      const table = materialise(cx, first.child, [single], how, first.origin, [], label);
      const changes = replay(key, table);
      const extra = table.fields.filter((f) => !single.fields.some((g) => sameIdent(g.name, f.name))).map((f) => f.name);
      if (extra.length === 0) {
        folds.push({ key, own: table, label, into: single, how, where, columnOptions, changes });
        return { kind: 'fold', into: single };
      }
      reportColumnOptions(cx, columnOptions, table, label, true);
      kept++;
      cx.ledger.changed('table', 'other', `${whatOf(named)} kept`, where,
        `as a table of its own: it has columns ${named} does not (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', …' : ''}), added by ALTER TABLE`);
      return { kind: 'table', table };
    }
    if (foldMode && single) {
      folds.push({ key, label, into: single, how, where, columnOptions });
      return { kind: 'fold', into: single };
    }
    const table = materialise(cx, first.child, found.map((p) => p.table), how, first.origin, columnOptions, label);
    replay(key, table);
    kept++;
    const reason = foldMode ? `as a table of its own, with the columns of ${named}${several}` : KEPT_AS_ASKED;
    cx.ledger.changed('table', 'other', `${whatOf(named)} kept`, where, `${reason}${notInFiles}`);
    return { kind: 'table', table };
  };

  for (const key of groups.keys()) decide(key);
  // Changes to a child that is not kept (its parent is not in the files): said, not applied.
  for (const [key, changes] of changesByKey) {
    for (const c of changes) c.run(c.child);
    changesByKey.delete(key);
  }

  // What the files said about each folded child is now about its parent.
  if (folds.length === 0) {
    state.partitionsResolved = { folded: 0, kept };
    return;
  }
  const intoByKey = new Map(folds.map((f) => [f.key, f.into] as const));
  const intoByTable = new Map(folds.filter((f) => f.own).map((f) => [f.own!, f.into] as const));
  // Tables do not change from here until the folded ones leave: each name is looked up once (a dump of thousands of partitions stays linear).
  const found = new Map<string, ModelTable | undefined>();
  const find = (parts: readonly string[]): ModelTable | undefined => {
    const k = parts.join('\u0000');
    if (!found.has(k)) found.set(k, cx.findTable(parts));
    return found.get(k);
  };
  const foldedInto = (parts: readonly string[]): ModelTable | undefined => {
    const table = find(parts);
    if (table) return intoByTable.get(table);
    return intoByKey.get(normKey(parts));
  };
  /** What stays: the table a pending item names, unless it is a folded child's. */
  const stays = (parts: readonly string[]): ModelTable | undefined => (foldedInto(parts) ? undefined : find(parts));
  for (const f of folds) {
    const what = f.how === 'INHERITS' ? `tables inheriting from ${tableLabel(f.into)}` : `partitions of ${tableLabel(f.into)}`;
    cx.ledger.changed('table', 'other', what, f.where, `folded into ${tableLabel(f.into)} (${f.how}: the parent's rows)`);
    reportColumnOptions(cx, f.columnOptions, f.into, f.label, false);
  }
  for (const ref of cx.refs) {
    const from = ref.fromTable ? intoByTable.get(ref.fromTable) : foldedInto(ref.from.parts);
    if (from) {
      if (ref.fromTable) ref.fromTable = from;
      ref.from.parts = partsOf(from);
    }
    const to = foldedInto(ref.to.parts);
    if (to) ref.to.parts = partsOf(to);
  }
  const pendingKeys = new Map<ModelTable, PendingKey[]>();
  for (const k of cx.keys) {
    const table = stays(k.table);
    if (!table) continue;
    const list = pendingKeys.get(table);
    if (list) list.push(k); else pendingKeys.set(table, [k]);
  }
  const pendingKeysOf = (table: ModelTable): PendingKey[] => pendingKeys.get(table) ?? [];
  const hasKey = (into: ModelTable, kind: 'pk' | 'unique', columns: readonly string[]): boolean => {
    if (kind === 'pk' && sameSet(columns, primaryKeyOf(into))) return true;
    if (kind === 'unique') {
      if (columns.length === 1 && into.fields.some((f) => f.unique && sameIdent(f.name, columns[0]))) return true;
      if (into.uniques.some((u) => sameSet(u, columns))) return true;
      // A partition's copy of its parent's key is unique on the partition too.
      if (sameSet(columns, primaryKeyOf(into))) return true;
    }
    return pendingKeysOf(into).some((k) => (k.kind === kind || kind === 'unique') && sameSet(k.columns, columns));
  };
  removeWhere(cx.keys, (key) => {
    const into = foldedInto(key.table);
    if (!into) return false;
    if (!hasKey(into, key.kind, key.columns)) {
      cx.ledger.lost(key.kind === 'pk' ? 'primaryKey' : 'uniqueKey', 'other', key.kind === 'pk' ? 'partition primary key' : 'partition unique key',
        { file: key.origin.file, line: key.origin.line, table: key.table.slice(-2).join('.'), column: key.columns.join('+') },
        `not kept: a key of the partition, not of ${tableLabel(into)}`);
    }
    return true;
  });
  const checks = state.checks;
  const pendingChecks = new Map<ModelTable, Set<string>>();
  for (const c of checks) {
    const table = stays(c.table);
    if (!table) continue;
    const set = pendingChecks.get(table) ?? new Set<string>();
    set.add(c.expression);
    pendingChecks.set(table, set);
  }
  removeWhere(checks, (check) => {
    const into = foldedInto(check.table);
    if (!into) return false;
    const onParent = into.checks.some((c) => c.expression === check.expression) || !!pendingChecks.get(into)?.has(check.expression);
    if (!onParent) {
      cx.ledger.lost('constraint', 'other', 'partition check', { file: check.origin.file, line: check.origin.line, table: check.table.slice(-2).join('.') }, `not kept: a check of the partition, not of ${tableLabel(into)}`);
    }
    return true;
  });
  const columnKey = (c: PendingComment): string => (c.column === undefined ? '' : `.${c.column.toLowerCase()}`);
  const targetKey = (c: PendingComment): string => {
    const table = find(c.table);
    return `${table ? tableKey(table, cx.dialect) : normKey(c.table)}${columnKey(c)}`;
  };
  // A later comment on the same target replaces an earlier one (comments apply in file order).
  const replaced = new Set<PendingComment>();
  const seenTargets = new Set<string>();
  for (let i = cx.comments.length - 1; i >= 0; i--) {
    const key = targetKey(cx.comments[i]);
    if (seenTargets.has(key)) replaced.add(cx.comments[i]); else seenTargets.add(key);
  }
  // The last pending comment on each table that stays, by column ('' for the table).
  const lastPending = new Map<ModelTable, Map<string, PendingComment>>();
  for (const c of cx.comments) {
    const table = stays(c.table);
    if (!table) continue;
    const byColumn = lastPending.get(table) ?? new Map<string, PendingComment>();
    byColumn.set(columnKey(c), c);
    lastPending.set(table, byColumn);
  }
  removeWhere(cx.comments, (comment) => {
    const into = foldedInto(comment.table);
    if (!into) return false;
    if (replaced.has(comment)) return true;
    // What the parent ends up with: its last pending comment, else what its definition says.
    const field = comment.column ? into.fields.find((f) => sameIdent(f.name, comment.column!)) : undefined;
    const pending = lastPending.get(into)?.get(columnKey(comment));
    const parentText = pending ? pending.text : comment.column ? field?.note : into.note;
    if (comment.text && parentText !== comment.text) {
      cx.ledger.lost('description', 'other', 'partition description', { file: comment.origin.file, line: comment.origin.line, table: comment.table.slice(-2).join('.'), ...(comment.column ? { column: comment.column } : {}) },
        `not kept: the partition's, not ${tableLabel(into)}'s`);
    }
    return true;
  });
  // A folded child's own table: what it says that its parent does not, said; then it leaves the model.
  for (const f of folds) {
    if (!f.own) continue;
    reportOwnDifferences(cx, f.own, f.into, hasKey, f.changes);
    const at = cx.tables.indexOf(f.own);
    if (at >= 0) cx.tables.splice(at, 1);
  }
  state.partitionsResolved = { folded: folds.length, kept };
}

/** The columns `own` inherits from `parents` (in their order, before its own); how many were added. */
function inheritColumns(own: ModelTable, parents: readonly ModelTable[]): number {
  const fields: ModelField[] = [];
  let added = 0;
  for (const parent of parents) {
    for (const f of parent.fields) {
      if (fields.some((g) => sameIdent(g.name, f.name))) continue;
      const mine = own.fields.find((g) => sameIdent(g.name, f.name));
      if (mine) { fields.push(mine); continue; }
      fields.push(cloneField(f, false));
      added++;
    }
  }
  if (!added) return 0;
  own.fields = [...fields, ...own.fields.filter((g) => !fields.includes(g))];
  return added;
}

/** A parent's column for a child: a partition keeps its parent's key flags; an inheriting table does not inherit keys. */
function cloneField(f: ModelField, keys: boolean): ModelField {
  const out: ModelField = { ...f, checks: [...f.checks], pk: keys && f.pk, unique: keys && f.unique };
  delete out.note;
  delete out.constraints;
  if (f.modifiers) out.modifiers = [...f.modifiers];
  return out;
}

/** A child with no columns of its own kept as a table: its parents' columns (and, for one partition parent, its keys). */
function materialise(
  cx: ConverterContext, childParts: readonly string[], parents: readonly ModelTable[], how: ReaderPartition['how'], origin: Origin,
  columnOptions: NonNullable<ReaderPartition['columnOptions']>, label: string,
): ModelTable {
  const keys = how !== 'INHERITS' && parents.length === 1;
  const table: ModelTable = {
    name: childParts[childParts.length - 1],
    schema: childParts.length >= 2 ? childParts[childParts.length - 2] : null,
    fields: [],
    uniques: keys ? parents[0].uniques.map((u) => [...u]) : [],
    checks: [],
    origin: { ...origin },
  };
  for (const parent of parents) {
    for (const f of parent.fields) if (!table.fields.some((g) => sameIdent(g.name, f.name))) table.fields.push(cloneField(f, keys));
  }
  if (keys && parents[0].primaryKey) table.primaryKey = [...parents[0].primaryKey];
  reportColumnOptions(cx, columnOptions, table, label, true);
  cx.tables.push(table);
  return table;
}

/**
 * A `PARTITION OF … (col WITH OPTIONS …)` list's column options: on a kept
 * table its NOT NULL applies; anything its target does not already say is a
 * ledger loss at its line.
 */
function reportColumnOptions(cx: ConverterContext, options: NonNullable<ReaderPartition['columnOptions']>, target: ModelTable, label: string, apply: boolean): void {
  for (const o of options) {
    const where = { file: o.origin.file, line: o.origin.line, table: label, column: o.column };
    const field = target.fields.find((f) => sameIdent(f.name, o.column));
    if (!field) {
      cx.ledger.lost('column', 'notInFiles', 'partition column option', where, `not kept: ${tableLabel(target)} has no such column`);
      continue;
    }
    if (o.notNull && !field.notNull) {
      if (apply) field.notNull = true;
      else cx.ledger.lost('constraint', 'other', 'partition NOT NULL', where, `not kept: NOT NULL on the partition only, not on ${tableLabel(target)}`);
    }
    if (o.other.length) cx.ledger.lost('setting', 'other', 'partition column option', where, `not kept: ${o.other.join(', ')} on the partition's column`);
  }
}

/**
 * A folded child's own definition (pg_dump writes each partition's columns,
 * or an ALTER TABLE changed them): every key, check, description or column
 * detail its parent lacks, a ledger loss at the line that wrote it.
 */
function reportOwnDifferences(
  cx: ConverterContext, own: ModelTable, into: ModelTable, hasKey: (into: ModelTable, kind: 'pk' | 'unique', columns: readonly string[]) => boolean, changes?: Replayed,
): void {
  const label = tableLabel(own);
  const lines = readerState(cx).itemLines;
  const items = lines.get(own);
  const constraintLines = Array.isArray(items) ? items : [];
  const fieldLine = (name: string): number | undefined => {
    const f = own.fields.find((x) => sameIdent(x.name, name));
    const line = f ? lines.get(f) : undefined;
    return typeof line === 'number' ? line : undefined;
  };
  /** Where a column's detail was written: the ALTER that last changed it, else its line in the CREATE TABLE. */
  const columnAt = (column: string): { file: string; line: number } => {
    const changed = changes?.at.get(column.toLowerCase());
    if (changed) return { file: changed.file, line: changed.line };
    return { file: own.origin.file, line: fieldLine(column) ?? own.origin.line };
  };
  /** Where a key was written: its constraint item, else its column's line (an inline key), else the CREATE TABLE. */
  const keyAt = (kind: 'pk' | 'unique', columns: readonly string[]): { file: string; line: number } => {
    const item = constraintLines.find((c) => c.kind === kind && sameSet(c.columns, columns));
    if (item) return { file: own.origin.file, line: item.line };
    return columns.length === 1 ? columnAt(columns[0]) : { file: own.origin.file, line: own.origin.line };
  };
  const pk = primaryKeyOf(own);
  if (pk.length && !hasKey(into, 'pk', pk)) {
    cx.ledger.lost('primaryKey', 'other', 'partition primary key', { ...keyAt('pk', pk), table: label, column: pk.join('+') }, `not kept: a key of the partition, not of ${tableLabel(into)}`);
  }
  const uniques = [...own.fields.filter((f) => f.unique).map((f) => [f.name]), ...own.uniques];
  for (const u of uniques) {
    if (!hasKey(into, 'unique', u)) cx.ledger.lost('uniqueKey', 'other', 'partition unique key', { ...keyAt('unique', u), table: label, column: u.join('+') }, `not kept: a key of the partition, not of ${tableLabel(into)}`);
  }
  const intoChecks = new Set([...into.checks.map((c) => c.expression), ...into.fields.flatMap((f) => f.checks)]);
  const checkItems = constraintLines.filter((c) => c.kind === 'check');
  own.checks.forEach((c, i) => {
    if (intoChecks.has(c.expression)) return;
    const line = checkItems[i]?.line ?? own.origin.line;
    cx.ledger.lost('constraint', 'other', 'partition check', { file: own.origin.file, line, table: label }, `not kept: a check of the partition, not of ${tableLabel(into)}`);
  });
  for (const f of own.fields) {
    for (const c of f.checks) {
      if (!intoChecks.has(c)) cx.ledger.lost('constraint', 'other', 'partition check', { ...columnAt(f.name), table: label, column: f.name }, `not kept: a check of the partition, not of ${tableLabel(into)}`);
    }
  }
  if (own.note && own.note !== into.note) cx.ledger.lost('description', 'other', 'partition description', { file: own.origin.file, line: own.origin.line, table: label }, `not kept: the partition's, not ${tableLabel(into)}'s`);
  for (const f of own.fields) {
    const g = into.fields.find((x) => sameIdent(x.name, f.name));
    if (!g) continue;
    const where = { ...columnAt(f.name), table: label, column: f.name };
    if (f.note && f.note !== g.note) cx.ledger.lost('description', 'other', 'partition description', where, `not kept: the partition's, not ${tableLabel(into)}'s`);
    const differs: string[] = [];
    if (typeText(f.typeAsWritten ?? f.type) !== typeText(g.typeAsWritten ?? g.type)) differs.push(`type ${f.typeAsWritten ?? f.type}`);
    if (f.notNull && !g.notNull) differs.push('NOT NULL');
    if (f.default && (f.default.value !== g.default?.value)) differs.push('its default');
    if (f.increment && !g.increment) differs.push('its identity');
    if (differs.length) cx.ledger.lost('column', 'other', 'partition column', where, `not kept: ${differs.join(', ')} on the partition only (folded into ${tableLabel(into)})`);
  }
  for (const d of changes?.dropped ?? []) {
    cx.notApplied(d.origin, `${label}.${d.column} dropped on the partition only, folded into ${tableLabel(into)} (not applied)`);
  }
}
