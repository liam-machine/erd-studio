/**
 * The SQL DDL converter's output: the pending foreign keys resolved against
 * the merged tables (de-duplicated, each skipped one said, a one-to-one told
 * apart from a many-to-one), and the one self-contained DBML file Import DBML
 * reads: a one-to-one written `Ref: pk_end - fk_end` (Import stores it from
 * the FK side), every Ref with its `ON DELETE` / `ON UPDATE` actions (Import
 * lists them in its reference-settings report), never its constraint name
 * (Import would read that as a role; the ledger counts it instead).
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import { finishReading } from './sqlDdlStatements';
import {
  primaryKeyOf,
  sameIdent,
  tableKey,
  tableLabel,
  type ConverterContext,
  type ModelEnum,
  type ModelField,
  type ModelTable,
  type PendingRef,
  type ResolvedRef,
} from './sqlDdlModel';

/**
 * The refs to write, resolved and de-duplicated; one that cannot be is said
 * in `skippedLines`. Runs once every file is read (`finishReading` first
 * joins ALTER TABLE checks and counts domains and partitions). Each ref is
 * marked one-to-one when its FK columns are the FK table's whole primary key
 * or exactly one of its unique keys, and the ledger counts the constraint
 * names DBML cannot carry.
 */
export function resolveRefs(c: ConverterContext): ResolvedRef[] {
  finishReading(c);
  const out: ResolvedRef[] = [];
  const seen = new Map<string, ResolvedRef>();
  for (const ref of c.refs) {
    const where = `${ref.origin.file} line ${ref.origin.line}`;
    const from = ref.fromTable ?? c.findTable(ref.from.parts);
    // The FK's table as it is imported (a later rename applied), so the line names a table the draft has.
    const fkLabel = `${from ? tableLabel(from) : ref.from.parts.slice(-2).join('.')}(${ref.from.columns.join(', ')})`;
    const to = c.findTable(ref.to.parts);
    if (!from) { c.skippedLines.push(`${where}: foreign key ${fkLabel}: ${ref.from.parts.slice(-2).join('.')} is not in the files`); continue; }
    if (!to) { c.skippedLines.push(`${where}: foreign key ${fkLabel} → ${ref.to.parts.slice(-2).join('.')}: that table is not in the files`); continue; }
    const fromColumns = ref.from.columns.map((col) => from.fields.find((f) => sameIdent(f.name, col))?.name);
    let targetColumns = ref.to.columns;
    if (targetColumns.length === 0) targetColumns = primaryKeyOf(to);
    const toColumns = targetColumns.map((col) => to.fields.find((f) => sameIdent(f.name, col))?.name);
    if (fromColumns.length === 0 || fromColumns.some((col) => !col) || toColumns.some((col) => !col)) {
      c.skippedLines.push(`${where}: foreign key ${fkLabel} → ${tableLabel(to)}: a column it names is not in the table`);
      continue;
    }
    if (fromColumns.length !== toColumns.length) {
      c.skippedLines.push(`${where}: foreign key ${fkLabel} → ${tableLabel(to)}: ${fromColumns.length} column(s) reference ${toColumns.length}`);
      continue;
    }
    const key = [tableKey(from, c.dialect), ...fromColumns.map((col) => (col as string).toLowerCase()), '>', tableKey(to, c.dialect), ...toColumns.map((col) => (col as string).toLowerCase())].join('\u0000');
    const kept = seen.get(key);
    if (kept) {
      // The same link written twice (a partition's copy, folded into its parent): one is kept; a different action is said.
      const differs = actionDifferences(kept.pending, ref);
      if (differs.length) {
        c.ledger.lost('setting', 'other', 'FK action', { file: ref.origin.file, line: ref.origin.line, table: tableLabel(from), column: (fromColumns as string[]).join('+') },
          `not kept: ${differs.join(', ')}; the same link at ${kept.pending?.origin.file ?? ''} line ${kept.pending?.origin.line ?? '?'} is kept`);
      }
      continue;
    }
    const resolved: ResolvedRef = { from, fromColumns: fromColumns as string[], to, toColumns: toColumns as string[], pending: ref };
    seen.set(key, resolved);
    const oneToOne = cardinalityOf(resolved);
    const ledgerWhere = { file: ref.origin.file, line: ref.origin.line, table: tableLabel(from), column: resolved.fromColumns.join('+') };
    if (oneToOne === 'one-to-one') resolved.oneToOne = true;
    else if (oneToOne === 'unwritable') {
      c.ledger.changed('relationship', 'other', 'one-to-one link', ledgerWhere, 'written as many-to-one: its FK columns are their table\'s key, but it references columns that are not');
    }
    if (ref.name) c.ledger.changed('constraint', 'notDesign', 'foreign key name', ledgerWhere, 'not kept: a constraint\'s name is the database\'s, not the design\'s');
    out.push(resolved);
  }
  return out;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length > 0 && a.length === b.length && a.every((x) => b.some((y) => sameIdent(x, y)));

/**
 * A resolved ref's cardinality: one-to-one when the FK columns are the FK
 * table's whole primary key or exactly a unique key (a single unique column
 * or a composite unique), else many-to-one. Import DBML stores `Ref: a - b`
 * from `b` unless only `b` is its table's whole key, so a one-to-one whose
 * FK is its table's key but whose target is not a key cannot be written
 * from the FK side (`unwritable`: written many-to-one, and said).
 */
export function cardinalityOf(r: Pick<ResolvedRef, 'from' | 'fromColumns' | 'to' | 'toColumns'>): 'one-to-one' | 'many-to-one' | 'unwritable' {
  const fkIsKey = sameSet(r.fromColumns, primaryKeyOf(r.from));
  const fkIsUnique = r.fromColumns.length === 1
    ? !!r.from.fields.find((f) => sameIdent(f.name, r.fromColumns[0]))?.unique
    : r.from.uniques.some((u) => sameSet(u, r.fromColumns));
  if (!fkIsKey && !fkIsUnique) return 'many-to-one';
  // A self-reference from a key to itself joins nothing.
  if (r.from === r.to && sameSet(r.fromColumns, r.toColumns)) return 'many-to-one';
  const targetIsKey = sameSet(r.toColumns, primaryKeyOf(r.to));
  return targetIsKey || !fkIsKey ? 'one-to-one' : 'unwritable';
}

/** DBML's `ON DELETE` / `ON UPDATE` values. */
const REF_ACTIONS = new Set(['cascade', 'restrict', 'set null', 'set default', 'no action']);

/** A written action as DBML says it, or undefined (none written, or one DBML has no word for). */
function refAction(a: string | undefined): string | undefined {
  const v = a?.replace(/\s+/g, ' ').trim().toLowerCase();
  return v && REF_ACTIONS.has(v) ? v : undefined;
}

/** What a second copy of a link says that the kept one does not (`ON DELETE SET NULL`); none written is NO ACTION. */
function actionDifferences(kept: PendingRef | undefined, other: PendingRef): string[] {
  const out: string[] = [];
  for (const [label, k, o] of [['ON DELETE', kept?.onDelete, other.onDelete], ['ON UPDATE', kept?.onUpdate, other.onUpdate]] as const) {
    const a = refAction(k) ?? 'no action';
    const b = refAction(o) ?? 'no action';
    if (a !== b) out.push(`${label} ${b.toUpperCase()}`);
  }
  return out;
}

function refSettings(r: ResolvedRef): string {
  const del = refAction(r.pending?.onDelete);
  const upd = refAction(r.pending?.onUpdate);
  const settings = [del ? `delete: ${del}` : '', upd ? `update: ${upd}` : ''].filter(Boolean);
  return settings.length ? ` [${settings.join(', ')}]` : '';
}

// ---------------------------------------------------------------------------
// DBML output
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function dbmlString(text: string): string {
  if (text.includes('\n')) return `'''${text.replace(/\\/g, '\\\\').replace(/'''/g, "\\'''")}'''`;
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function dbmlType(type: string): string {
  // Bare when the parser reads it as one: `int`, `varchar(255)`, `numeric(10, 2)`, `sales.mood`.
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?(\(\s*[A-Za-z0-9_]+(\s*,\s*[A-Za-z0-9_]+)*\s*\))?$/.test(type)) return type;
  return quoteIdent(type);
}

export function dbmlTableName(table: { schema: string | null; name: string }): string {
  return table.schema ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}` : quoteIdent(table.name);
}

export function dbmlExpression(expr: string): string {
  return `\`${expr.replace(/`/g, "'")}\``;
}

export function fieldSettings(field: ModelField): string {
  const settings: string[] = [];
  if (field.pk) settings.push('pk');
  if (field.increment) settings.push('increment');
  if (field.notNull && !field.pk) settings.push('not null');
  if (field.unique && !field.pk) settings.push('unique');
  if (field.default) {
    const d = field.default;
    if (d.type === 'number' && /^-?\d+(\.\d+)?$/.test(d.value)) settings.push(`default: ${d.value}`);
    else if (d.type === 'boolean' && /^(true|false)$/i.test(d.value)) settings.push(`default: ${d.value.toLowerCase()}`);
    else if (d.type === 'null') settings.push('default: null');
    else if (d.type === 'string') settings.push(`default: ${dbmlString(d.value)}`);
    else settings.push(`default: ${dbmlExpression(d.value)}`);
  }
  for (const check of field.checks) settings.push(`check: ${dbmlExpression(check)}`);
  if (field.note) settings.push(`note: ${dbmlString(field.note)}`);
  return settings.length ? ` [${settings.join(', ')}]` : '';
}

export function writeDbml(
  enums: readonly ModelEnum[],
  tables: readonly ModelTable[],
  refs: readonly ResolvedRef[],
): string {
  const blocks: string[] = [];
  for (const e of enums) {
    const lines = e.values.map((v) => `  ${quoteIdent(v.name)}${v.note ? ` [note: ${dbmlString(v.note)}]` : ''}`);
    blocks.push(`Enum ${dbmlTableName(e)} {\n${lines.join('\n')}\n}`);
  }
  for (const table of tables) {
    const header = table.alias ? ` [alias: ${dbmlString(table.alias)}]` : '';
    const lines = table.fields.map((f) => `  ${quoteIdent(f.name)} ${dbmlType(f.type)}${fieldSettings(f)}`);
    const indexes: string[] = [];
    if (table.primaryKey) indexes.push(`    (${table.primaryKey.map(quoteIdent).join(', ')}) [pk]`);
    // A unique key over the primary key's columns, or one already written, says nothing more.
    const written: string[][] = table.primaryKey ? [table.primaryKey] : [];
    for (const unique of table.uniques) {
      if (written.some((w) => sameSet(w, unique))) continue;
      written.push(unique);
      indexes.push(`    (${unique.map(quoteIdent).join(', ')}) [unique]`);
    }
    if (indexes.length) lines.push('', '  Indexes {', ...indexes, '  }');
    if (table.checks.length) {
      lines.push('', '  checks {', ...table.checks.map((c) => `    ${dbmlExpression(c.expression)}${c.name ? ` [name: ${dbmlString(c.name)}]` : ''}`), '  }');
    }
    if (table.note) lines.push('', `  Note: ${dbmlString(table.note)}`);
    blocks.push(`Table ${dbmlTableName(table)}${header} {\n${lines.join('\n')}\n}`);
  }
  if (refs.length) {
    const end = (table: ModelTable, columns: string[]): string =>
      columns.length === 1 ? `${dbmlTableName(table)}.${quoteIdent(columns[0])}` : `${dbmlTableName(table)}.(${columns.map(quoteIdent).join(', ')})`;
    blocks.push(refs.map((r) => (r.oneToOne
      ? `Ref: ${end(r.to, r.toColumns)} - ${end(r.from, r.fromColumns)}${refSettings(r)}`
      : `Ref: ${end(r.from, r.fromColumns)} > ${end(r.to, r.toColumns)}${refSettings(r)}`)).join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}
