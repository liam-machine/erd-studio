/**
 * The SQL DDL converter's statement readers: everything but the CREATE TABLE
 * grammar itself — what each statement is (skipped and counted by kind when
 * it is not design), and the structure a schema declares outside its CREATE
 * TABLEs:
 *
 *  - every item of an ALTER TABLE action list (`ADD CONSTRAINT a FOREIGN KEY
 *    …, CONSTRAINT b …`, `ADD …, ADD …`, `WITH CHECK | NOCHECK`), keys,
 *    foreign keys (with their name and `ON DELETE` / `ON UPDATE`), checks,
 *    defaults and column changes, applied in file order;
 *  - `CREATE UNIQUE INDEX` as a unique key (an expression or partial one is
 *    a ledger loss, a unique index on a view is skipped);
 *  - constraint replay: `DROP CONSTRAINT` (by the name written or by
 *    PostgreSQL's generated `t_col_fkey`, `t_col_key`, `t_pkey`), MySQL's
 *    `DROP FOREIGN KEY` / `DROP INDEX` / `DROP PRIMARY KEY`, `DROP INDEX`,
 *    and `RENAME CONSTRAINT`, so a dropped key leaves the model;
 *  - the schema context (`USE`, `USE SCHEMA`, `SET search_path`), per file;
 *  - DDL inside `DO $$ … $$`, `IF … BEGIN … END` and `EXECUTE IMMEDIATE
 *    $$ … $$` blocks, at its true lines (dynamic `EXECUTE '…'` is reported,
 *    not run);
 *  - descriptions: `COMMENT ON` and SQL Server's `sp_addextendedproperty`
 *    / `sp_updateextendedproperty 'MS_Description'`;
 *  - domains and SQL Server alias types, partitions, and what a table's own
 *    definition says that DBML has no field for (column modifiers, table
 *    options), counted in the ledger.
 *
 * Functions over {@link ConverterContext}, so a reader can be added or
 * changed without touching the converter (`sqlDdlImport.ts`).
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import { constraintKind } from './sqlDdlColumns';
import {
  CREATE_OBJECT_WORDS,
  isLineStart,
  isName,
  isPunct,
  matchParen,
  readColumnList,
  readName,
  splitTopLevel,
  tokenize,
  upper,
  type Statement,
  type Token,
} from './sqlDdlLexer';
import {
  DEFAULT_SCHEMA,
  primaryKeyOf,
  readerState,
  removeWhere,
  sameIdent,
  sameSchema,
  tableLabel,
  type ConverterContext,
  type ModelField,
  type ModelTable,
  type Origin,
  type PendingRef,
  type ReaderPartition,
  type SkipKind,
} from './sqlDdlModel';
import { isConstraintItem } from './sqlDdlRepair';

export function readStatement(cx: ConverterContext, file: string, text: string, st: Statement): void {
  const state = readerState(cx);
  // The schema context is a file's own: each file starts in the dialect's default schema.
  if (state.file !== file) { state.file = file; cx.currentSchema = null; state.schemaElements = undefined; }
  const elementsOf = state.schemaElements;
  if (elementsOf === undefined) { readOneStatement(cx, file, text, st); return; }
  // An element of `CREATE SCHEMA s …`: created in s; the `;` after it ends the schema's element list.
  const w0 = upper(st.tokens[0]);
  if (w0 !== 'CREATE' && w0 !== 'GRANT') { state.schemaElements = undefined; readOneStatement(cx, file, text, st); return; }
  const saved = cx.currentSchema;
  cx.currentSchema = elementsOf;
  try {
    readOneStatement(cx, file, text, st);
  } finally {
    cx.currentSchema = saved;
  }
  if (!continuesSchemaElements(text, st)) state.schemaElements = undefined;
}

/** Whether the schema element `st` is followed by another (no `;` after it, and a CREATE or GRANT next). */
function continuesSchemaElements(text: string, st: Statement): boolean {
  return /^\s*(?:CREATE|GRANT)\b/i.test(text.slice(st.end, st.end + 512));
}

function readOneStatement(cx: ConverterContext, file: string, text: string, st: Statement): void {
  const t = st.tokens;
  const origin: Origin = { file, line: st.line };
  const w0 = upper(t[0]);
  switch (w0) {
    case 'CREATE': return readCreate(cx, file, text, st);
    case 'ALTER':
      if (upper(t[1]) === 'TABLE') return readAlterTable(cx, text, st, origin);
      if (upper(t[1]) === 'INDEX' && readAlterIndex(cx, st)) return;
      return cx.skip(file, 'other');
    case 'RENAME': return upper(t[1]) === 'TABLE' ? readRenameTable(cx, st, origin) : cx.skip(file, 'other');
    case 'COMMENT': return upper(t[1]) === 'ON' || (upper(t[1]) === 'IF' && upper(t[2]) === 'EXISTS' && upper(t[3]) === 'ON') ? readCommentOn(cx, st, origin) : cx.skip(file, 'other');
    case 'EXEC': case 'EXECUTE': return readExec(cx, text, st, origin);
    case 'DO': return readDoBlock(cx, file, text, st, origin);
    case 'IF': case 'WHILE': case 'BEGIN': {
      const read = readEmbeddedDdl(cx, file, text, t, 1);
      if (read.statements > 0) return;
      return cx.skip(file, w0 === 'BEGIN' ? 'session' : read.dynamic ? 'dynamic' : 'block');
    }
    case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE': case 'COPY': case 'TRUNCATE': case 'UPSERT':
      return cx.skip(file, 'data');
    case 'GRANT': case 'REVOKE': case 'DENY': return cx.skip(file, 'grant');
    case 'USE': readUse(cx, t); return cx.skip(file, 'session');
    case 'SET': readSetSchema(cx, t); return cx.skip(file, 'session');
    // `RESET search_path` / `RESET ALL`: back to the default schema.
    case 'RESET':
      if (upper(t[1]) === 'ALL' || /^search_path$/i.test(t[1]?.value ?? '')) cx.currentSchema = null;
      return cx.skip(file, 'session');
    // A block's END (`END`, `END IF`, `END $$`) closes what started it: not a statement of its own.
    case 'END': return t.length <= 3 && !/^(TRANSACTION|TRAN|WORK)$/.test(upper(t[1])) ? undefined : cx.skip(file, 'session');
    case 'COMMIT': case 'START': case 'ROLLBACK': case 'PRINT':
    case 'DECLARE': case 'PRAGMA': case 'LOCK': case 'UNLOCK':
      return cx.skip(file, 'session');
    case 'DROP':
      if (upper(t[1]) === 'TABLE') return readDropTable(cx, st, origin);
      if (upper(t[1]) === 'INDEX' && readDropIndex(cx, st)) return;
      return cx.skip(file, 'drop');
    case 'SELECT': readSetConfig(cx, t); return cx.skip(file, 'query');
    case 'WITH': case 'SHOW': case 'DESCRIBE': case 'EXPLAIN': return cx.skip(file, 'query');
    default: return cx.skip(file, 'other');
  }
}

export function readCreate(cx: ConverterContext, file: string, text: string, st: Statement): void {
  const t = st.tokens;
  let i = 1;
  let unique = false;
  // OR REPLACE, TEMPORARY, TRANSIENT, UNIQUE, CLUSTERED, MATERIALIZED, and MySQL's
  // `DEFINER = user@host`, `ALGORITHM = x`, `SQL SECURITY DEFINER` before what is created.
  let assigned = false;
  while (i < t.length && i < 48) {
    const tok = t[i];
    if (tok.kind === 'word' && CREATE_OBJECT_WORDS.has(upper(tok))) break;
    if (isPunct(tok, '=')) { assigned = true; i++; continue; }
    if (tok.kind !== 'word' && !(assigned && (tok.kind === 'ident' || tok.kind === 'string' || isPunct(tok, '@') || isPunct(tok, '.') || isPunct(tok, '%')))) break;
    if (upper(tok) === 'UNIQUE') unique = true;
    i++;
  }
  const what = upper(t[i]);
  switch (what) {
    case 'TABLE': return readCreateTableStatement(cx, file, text, st, i + 1);
    case 'TYPE': {
      const name = readName(t, i + 1);
      if (name && upper(t[name.next]) === 'FROM') return readAliasType(cx, file, text, st, name);
      return cx.readCreateType(file, st, i + 1);
    }
    case 'DOMAIN': return readDomain(cx, file, text, st, i + 1);
    case 'VIEW': {
      let n = i + 1;
      if (upper(t[n]) === 'IF' && upper(t[n + 1]) === 'NOT' && upper(t[n + 2]) === 'EXISTS') n += 3;
      const name = readName(t, n);
      if (name) rememberView(cx, cx.qualify(name.parts));
      return cx.skip(file, 'view');
    }
    case 'INDEX': return unique ? readUniqueIndex(cx, file, st, i + 1) : cx.skip(file, 'index');
    case 'SCHEMA': {
      // `CREATE SCHEMA s [AUTHORIZATION r] CREATE TABLE …`: the elements that follow (until a `;`) are in s;
      // `CREATE SCHEMA AUTHORIZATION r …`: a schema named after its owner.
      let n = i + 1;
      if (upper(t[n]) === 'IF' && upper(t[n + 1]) === 'NOT' && upper(t[n + 2]) === 'EXISTS') n += 3;
      const owner = upper(t[n]) === 'AUTHORIZATION' && isName(t[n + 1]) ? t[n + 1].value : undefined;
      const name = owner === undefined ? readName(t, n) : undefined;
      const schema = owner ?? name?.parts[name.parts.length - 1];
      if (schema && continuesSchemaElements(text, st)) readerState(cx).schemaElements = schema;
      return cx.skip(file, 'schema');
    }
    case 'DATABASE': case 'CATALOG': return cx.skip(file, 'schema');
    case 'SEQUENCE': return cx.skip(file, 'sequence');
    case 'FUNCTION': case 'PROCEDURE': case 'PROC': case 'TRIGGER': case 'EVENT': return cx.skip(file, 'routine');
    default: return cx.skip(file, 'other');
  }
}

// -- CREATE TABLE: what the grammar does not say ---------------------------

/**
 * A CREATE TABLE: a child with no columns of its own (`PARTITION OF parent`,
 * `(…) INHERITS (parent)` with no column in the list) is remembered, and
 * folded into its parent or kept as a table once every file is read
 * (`sqlDdlPartitions.ts`); otherwise the converter's reading, then what DBML
 * has no field for.
 */
function readCreateTableStatement(cx: ConverterContext, file: string, text: string, st: Statement, at: number): void {
  const t = st.tokens;
  let i = at;
  const ifNotExists = upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS';
  if (ifNotExists) i += 3;
  const name = readName(t, i);
  // `CREATE TABLE child PARTITION OF parent [(column options, constraints)] FOR VALUES … | DEFAULT`: the parent's rows.
  if (name && upper(t[name.next]) === 'PARTITION' && upper(t[name.next + 1]) === 'OF') {
    const parent = readName(t, name.next + 2);
    if (parent) {
      readNoColumnChild(cx, file, text, st, name.parts, [parent.parts], 'PARTITION OF', isPunct(t[parent.next], '(') ? parent.next : -1, ifNotExists);
      return;
    }
  }
  // `CREATE TABLE child () INHERITS (a, b)` (or only constraints in the list): every column is a parent's.
  if (name && isPunct(t[name.next], '(')) {
    const close = matchParen(t, name.next);
    const parents = close > 0 ? inheritsParents(t, close) : undefined;
    if (parents?.length && !hasColumnDefinition(t, name.next, close)) {
      readNoColumnChild(cx, file, text, st, name.parts, parents, 'INHERITS', name.next, ifNotExists);
      return;
    }
  }
  const before = cx.tables.length;
  cx.readCreateTable(file, text, st, at);
  if (cx.tables.length > before && name && isPunct(t[name.next], '(')) {
    const close = matchParen(t, name.next);
    if (close > 0) afterCreateTable(cx, file, t, name.next, close, cx.tables[cx.tables.length - 1]);
  }
}

/** The parents an `INHERITS (a, b)` after the column list names (undefined: no INHERITS). */
function inheritsParents(t: Token[], close: number): string[][] | undefined {
  let depth = 0;
  for (let k = close + 1; k < t.length; k++) {
    if (isPunct(t[k], '(')) { depth++; continue; }
    if (isPunct(t[k], ')')) { depth--; continue; }
    if (depth !== 0 || upper(t[k]) !== 'INHERITS' || !isPunct(t[k + 1], '(')) continue;
    const end = matchParen(t, k + 1);
    const parents: string[][] = [];
    for (const [pf] of splitTopLevel(t, k + 2, end < 0 ? t.length : end)) {
      const parent = readName(t, pf);
      if (parent) parents.push(parent.parts);
    }
    return parents;
  }
  return undefined;
}

/** Whether a column list `t(open, close)` defines a column (not only constraints, and not `LIKE other`). */
function hasColumnDefinition(t: Token[], open: number, close: number): boolean {
  for (const [from, to] of splitTopLevel(t, open + 1, close)) {
    if (from >= to) continue;
    if (upper(t[from]) === 'LIKE' || !isConstraintItem(t, from, to)) return true;
  }
  return false;
}

/**
 * A child with no columns of its own: remembered with its parents (one
 * partition record each), its list's constraints read against the child (a
 * foreign key, key or check is then the parent's or the kept table's), and
 * its column options (`col WITH OPTIONS NOT NULL`) kept for the resolution.
 */
function readNoColumnChild(
  cx: ConverterContext, file: string, text: string, st: Statement, childName: string[], parentNames: string[][],
  how: 'PARTITION OF' | 'INHERITS', open: number, ifNotExists: boolean,
): void {
  const t = st.tokens;
  const state = readerState(cx);
  const child = cx.qualify(childName);
  const live = (p: ReaderPartition): boolean => !p.detached && sameParts(p.child, child, cx);
  // A second CREATE TABLE IF NOT EXISTS of the same child (or of a table) does nothing.
  if (ifNotExists && (cx.findTable(child) || state.partitions.some(live))) { cx.skip(file, 'existing'); return; }
  const origin: Origin = { file, line: st.line };
  const columnOptions: NonNullable<ReaderPartition['columnOptions']> = [];
  const close = open >= 0 ? matchParen(t, open) : -1;
  if (close > 0) {
    for (const [from, to] of splitTopLevel(t, open + 1, close)) {
      if (from >= to) continue;
      const where: Origin = { file, line: t[from].line };
      if (isConstraintItem(t, from, to)) {
        const read = readAddItem(cx, text, child, t, from, to, where);
        if (!read) cx.ledger.lost('constraint', 'grammarGap', 'partition constraint', { file, line: where.line, table: child.slice(-2).join('.') }, 'not kept: ERD Studio does not read this constraint');
        continue;
      }
      if (!isName(t[from])) continue;
      let k = from + 1;
      if (upper(t[k]) === 'WITH' && upper(t[k + 1]) === 'OPTIONS') k += 2;
      let notNull = false;
      const other: string[] = [];
      for (; k < to; k++) {
        const w = upper(t[k]);
        if (isPunct(t[k], '(')) { const end = matchParen(t, k); if (end > 0) k = end; continue; }
        if (w === 'NOT' && upper(t[k + 1]) === 'NULL') { notNull = true; k++; continue; }
        if (w === 'NULL' || w === 'CONSTRAINT') { if (w === 'CONSTRAINT') k++; continue; }
        if (COLUMN_OPTION_PHRASES[w] && !other.includes(COLUMN_OPTION_PHRASES[w])) other.push(COLUMN_OPTION_PHRASES[w]);
      }
      columnOptions.push({ column: t[from].value, notNull, other, origin: where });
    }
  }
  for (const parent of parentNames) {
    state.partitions.push({
      child: [...child],
      parent: cx.qualify(parent),
      how,
      origin,
      noColumns: true,
      ...(columnOptions.length ? { columnOptions } : {}),
    });
  }
}

/** What a column option in a `PARTITION OF` list says beyond NOT NULL, as a fixed phrase. */
const COLUMN_OPTION_PHRASES: Readonly<Record<string, string>> = {
  DEFAULT: 'DEFAULT', CHECK: 'CHECK', UNIQUE: 'UNIQUE', PRIMARY: 'PRIMARY KEY', REFERENCES: 'REFERENCES',
  GENERATED: 'GENERATED', COLLATE: 'COLLATE', COMPRESSION: 'COMPRESSION', STORAGE: 'STORAGE',
};

/**
 * What a CREATE TABLE says beyond the grammar's model: its constraints'
 * names (for `DROP CONSTRAINT`), the names and actions of its foreign keys,
 * `INHERITS`, and — counted in the ledger — column modifiers, generated and
 * computed expressions and table options DBML has no field for.
 */
export function afterCreateTable(cx: ConverterContext, file: string, t: Token[], open: number, close: number, table: ModelTable): void {
  const label = tableLabel(table);
  const names = (table.constraintNames ??= []);
  const ownRefs = cx.refs.filter((r) => r.fromTable === table);
  for (const [from, to] of splitTopLevel(t, open + 1, close, cx.dialect === 'databricks')) {
    if (from >= to) continue;
    if (isConstraintItem(t, from, to)) {
      const c = readTableConstraint(t, from, to);
      if (!c) continue;
      if (c.name) names.push({ name: c.name, kind: c.kind, columns: c.columns });
      if (c.kind === 'fk') {
        const ref = ownRefs.find((r) => sameColumns(r.from.columns, c.columns) && !r.name) ?? ownRefs.find((r) => sameColumns(r.from.columns, c.columns));
        if (ref) nameRef(ref, c.name, readRefActions(t, from, to));
      }
      continue;
    }
    if (!isName(t[from])) continue;
    const field = table.fields.find((f) => sameIdent(f.name, t[from].value));
    if (!field) continue;
    const where = { file, line: t[from].line, table: label, column: field.name };
    for (const c of field.constraints ?? []) names.push({ name: c.name, kind: c.kind, columns: [field.name] });
    const inline = (field.constraints ?? []).find((c) => c.kind === 'fk');
    const refAt = t.slice(from, to).findIndex((tok) => upper(tok) === 'REFERENCES');
    if (refAt >= 0) {
      const ref = ownRefs.find((r) => sameColumns(r.from.columns, [field.name]) && !r.name) ?? ownRefs.find((r) => sameColumns(r.from.columns, [field.name]));
      if (ref) nameRef(ref, inline?.name, readRefActions(t, from + refAt, to));
    }
    recordColumnLosses(cx, field, where);
  }
  if (names.length === 0) delete table.constraintNames;
  recordTableOptions(cx, t, close, table, file);
}

/**
 * What a field's definition earns beyond the model: a column modifier with
 * a meaning (`ON UPDATE`) or a generated expression is a ledger loss, a
 * computed column a ledger change, a physical one (`COLLATE`, `ROWGUIDCOL`,
 * an identity's seed…) a counted column setting in the file's skipped line.
 */
export function recordColumnLosses(cx: ConverterContext, field: ModelField, where: { file: string; line: number; table: string; column: string }): void {
  for (const m of field.modifiers ?? []) {
    const why = DESIGN_MODIFIERS[m];
    if (why) cx.ledger.lost('column', 'noField', m, where, why);
    else cx.skip(where.file, 'columnSetting');
  }
  if (field.generated) {
    cx.ledger.lost('column', 'noField', 'generated column expression', where,
      `not kept: imported as a plain column${field.generated.kind === 'virtual' ? ' (VIRTUAL)' : ''}`);
  }
  if (field.computed) {
    cx.ledger.changed('column', 'noField', 'computed column', where, 'typed computed; its expression was not imported');
  }
}

/** Column modifiers that say what the data does (not how it is stored), and why each is not kept. */
const DESIGN_MODIFIERS: Readonly<Record<string, string>> = {
  'ON UPDATE': 'not kept: DBML has no on-update value',
};

/** One table constraint item `t[from, to)`: its name (`CONSTRAINT x`, or MySQL's `UNIQUE KEY x`), kind and columns. */
function readTableConstraint(t: Token[], from: number, to: number): { name?: string; kind: 'pk' | 'unique' | 'fk' | 'check'; columns: string[] } | undefined {
  let k = from;
  let name: string | undefined;
  if (upper(t[k]) === 'CONSTRAINT' && isName(t[k + 1])) { name = t[k + 1].value; k += 2; }
  const kind = constraintKind(t, k);
  if (!kind) return undefined;
  let open = k + 1;
  while (open < to && !isPunct(t[open], '(')) {
    // MySQL: `UNIQUE KEY name (…)`, `FOREIGN KEY name (…)`.
    if (!name && isName(t[open]) && isPunct(t[open + 1], '(') && !/^(KEY|INDEX|CLUSTERED|NONCLUSTERED)$/.test(upper(t[open]))) name = t[open].value;
    open++;
  }
  if (kind === 'check') return { ...(name ? { name } : {}), kind, columns: [] };
  const cols = readColumnList(t, open);
  return cols ? { ...(name ? { name } : {}), kind, columns: cols.columns } : undefined;
}

/** `ON DELETE x` / `ON UPDATE y` in `t[from, to)`, lower-cased (`cascade`, `set null`, `no action`…). */
export function readRefActions(t: readonly Token[], from: number, to: number): { onDelete?: string; onUpdate?: string } {
  const out: { onDelete?: string; onUpdate?: string } = {};
  for (let k = from; k < to; k++) {
    if (upper(t[k]) !== 'ON') continue;
    const which = upper(t[k + 1]);
    if (which !== 'DELETE' && which !== 'UPDATE') continue;
    const a = upper(t[k + 2]);
    const b = upper(t[k + 3]);
    const action = a === 'CASCADE' ? 'cascade' : a === 'RESTRICT' ? 'restrict' : a === 'NO' && b === 'ACTION' ? 'no action'
      : a === 'SET' && b === 'NULL' ? 'set null' : a === 'SET' && b === 'DEFAULT' ? 'set default' : undefined;
    if (!action) continue;
    if (which === 'DELETE') out.onDelete = action;
    else out.onUpdate = action;
  }
  return out;
}

function nameRef(ref: PendingRef, name: string | undefined, actions: { onDelete?: string; onUpdate?: string }): void {
  if (name && !ref.name) ref.name = name;
  if (actions.onDelete && !ref.onDelete) ref.onDelete = actions.onDelete;
  if (actions.onUpdate && !ref.onUpdate) ref.onUpdate = actions.onUpdate;
}

/** Table options after the column list, by first word: the phrase the ledger counts them by (COMMENT is the table's note). */
const TABLE_OPTION_PHRASES: Readonly<Record<string, string>> = {
  ENGINE: 'ENGINE', CHARSET: 'CHARSET', CHARACTER: 'CHARSET', COLLATE: 'COLLATE', ROW_FORMAT: 'ROW_FORMAT',
  AUTO_INCREMENT: 'AUTO_INCREMENT', TABLESPACE: 'TABLESPACE', ON: 'ON <filegroup>', TEXTIMAGE_ON: 'TEXTIMAGE_ON',
  FILESTREAM_ON: 'FILESTREAM_ON', WITH: 'WITH (…)', PARTITION: 'PARTITION BY', PARTITIONED: 'PARTITIONED BY',
  CLUSTER: 'CLUSTER BY', CLUSTERED: 'CLUSTERED BY', TBLPROPERTIES: 'TBLPROPERTIES', LOCATION: 'LOCATION', USING: 'USING',
  OPTIONS: 'OPTIONS', DATA_RETENTION_TIME_IN_DAYS: 'DATA_RETENTION_TIME_IN_DAYS', CHANGE_TRACKING: 'CHANGE_TRACKING',
  STORED: 'STORED AS', ROW: 'ROW FORMAT', ZORDER: 'ZORDER', DISTKEY: 'DISTKEY', SORTKEY: 'SORTKEY', DISTSTYLE: 'DISTSTYLE',
  DISTRIBUTED: 'DISTRIBUTED BY', KEY_BLOCK_SIZE: 'KEY_BLOCK_SIZE', STATS_PERSISTENT: 'STATS_PERSISTENT', PACK_KEYS: 'PACK_KEYS',
  CHECKSUM: 'CHECKSUM', DELAY_KEY_WRITE: 'DELAY_KEY_WRITE', INSERT_METHOD: 'INSERT_METHOD', MAX_ROWS: 'MAX_ROWS',
  MIN_ROWS: 'MIN_ROWS', AVG_ROW_LENGTH: 'AVG_ROW_LENGTH', COMPRESSION: 'COMPRESSION', ENCRYPTION: 'ENCRYPTION',
};

/** Counts each table option after the column list in the file's skipped line (`INHERITS (p)` is remembered as a partition). */
function recordTableOptions(cx: ConverterContext, t: Token[], close: number, table: ModelTable, file: string): void {
  const seen = new Set<string>();
  let depth = 0;
  let expectWord = true;
  for (let k = close + 1; k < t.length; k++) {
    const tok = t[k];
    if (isPunct(tok, '(')) { depth++; continue; }
    if (isPunct(tok, ')')) { depth--; expectWord = depth === 0; continue; }
    if (depth !== 0) continue;
    if (isPunct(tok, ',') || isPunct(tok, '=')) { expectWord = isPunct(tok, ','); continue; }
    if (tok.kind !== 'word') { expectWord = true; continue; }
    const w = upper(tok);
    if (w === 'COMMENT') { expectWord = false; continue; }
    if (w === 'DEFAULT') continue;
    if (w === 'INHERITS' && isPunct(t[k + 1], '(')) {
      const end = matchParen(t, k + 1);
      for (const [pf] of splitTopLevel(t, k + 2, end < 0 ? t.length : end)) {
        const parent = readName(t, pf);
        if (parent) readerState(cx).partitions.push({ child: [...(table.schema ? [table.schema] : []), table.name], parent: cx.qualify(parent.parts), how: 'INHERITS', origin: { file, line: tok.line } });
      }
      if (end > 0) k = end;
      expectWord = false;
      continue;
    }
    if (expectWord || TABLE_OPTION_PHRASES[w]) {
      const phrase = TABLE_OPTION_PHRASES[w] ?? 'table option';
      if (!seen.has(phrase)) {
        seen.add(phrase);
        cx.skip(file, 'tableOption');
      }
    }
    expectWord = false;
  }
}

// -- CREATE [UNIQUE] INDEX, DROP INDEX ---------------------------------------

/**
 * `CREATE UNIQUE [CLUSTERED | NONCLUSTERED] INDEX [CONCURRENTLY] [IF NOT EXISTS] [name] ON [ONLY] t [USING m] (cols)
 * [INCLUDE (…)] [WHERE …]`: a unique key on `t`, named for `DROP INDEX`. An
 * expression or partial index is not a list of columns: a ledger loss. On a
 * view it is not a key at all (skipped as an index).
 */
export function readUniqueIndex(cx: ConverterContext, file: string, st: Statement, at: number): void {
  const t = st.tokens;
  let i = at;
  if (upper(t[i]) === 'CONCURRENTLY') i++;
  if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS') i += 3;
  let indexName: string | undefined;
  if (upper(t[i]) !== 'ON') {
    const n = readName(t, i);
    if (!n) { cx.skip(file, 'index'); return; }
    indexName = n.parts[n.parts.length - 1];
    i = n.next;
  }
  // MySQL: `CREATE UNIQUE INDEX ix USING BTREE ON t (…)`.
  if (upper(t[i]) === 'USING' && isName(t[i + 1])) i += 2;
  if (upper(t[i]) !== 'ON') { cx.skip(file, 'index'); return; }
  i++;
  if (upper(t[i]) === 'ONLY') i++;
  const target = readName(t, i);
  if (!target) { cx.skip(file, 'index'); return; }
  // A key on a partition stays the partition's until partitions are resolved (`sqlDdlPartitions.ts`).
  const parts = cx.qualify(target.parts);
  if (isView(cx, parts)) { cx.skip(file, 'index'); return; }
  let open = target.next;
  if (upper(t[open]) === 'USING' && isName(t[open + 1])) open += 2;
  if (!isPunct(t[open], '(')) { cx.skip(file, 'index'); return; }
  const close = matchParen(t, open);
  if (close < 0) { cx.skip(file, 'index'); return; }
  const columns: string[] = [];
  let expression = false;
  for (const [from, to] of splitTopLevel(t, open + 1, close)) {
    const column = simpleIndexColumn(t, from, to);
    if (column === undefined) expression = true;
    else columns.push(column);
  }
  let partial = false;
  for (let k = close + 1; k < t.length; k++) {
    if (isPunct(t[k], '(')) { const end = matchParen(t, k); if (end < 0) break; k = end; continue; }
    if (upper(t[k]) === 'WHERE') { partial = true; break; }
  }
  const where = { file, line: st.line, table: parts.slice(-2).join('.'), ...(indexName ? { column: indexName } : {}) };
  if (expression || columns.length === 0) {
    cx.ledger.lost('uniqueKey', 'noField', 'expression unique index', where, 'not kept: a unique key is a list of columns, not an expression');
    return;
  }
  if (partial) {
    cx.ledger.lost('uniqueKey', 'noField', 'partial unique index', where, 'not kept: unique only WHERE its condition holds');
    return;
  }
  cx.keys.push({ table: parts, kind: 'unique', columns, origin: { file, line: st.line }, ...(indexName ? { name: indexName } : {}) });
}

/** An index item that is a column (`name`, `name DESC`, `name COLLATE "C" text_pattern_ops`), or undefined for an expression. */
function simpleIndexColumn(t: readonly Token[], from: number, to: number): string | undefined {
  if (from >= to || !isName(t[from])) return undefined;
  for (let k = from + 1; k < to; k++) {
    const tok = t[k];
    if (tok.kind === 'word' || tok.kind === 'ident') continue;
    if (isPunct(tok, '.') && k > from + 1) continue; // an opclass or collation's schema
    return undefined;
  }
  return t[from].value;
}

/** `DROP INDEX [CONCURRENTLY] [IF EXISTS] a [, b] [ON t]`: a unique key with that name leaves the model. Whether it dropped one. */
export function readDropIndex(cx: ConverterContext, st: Statement): boolean {
  const t = st.tokens;
  let i = 2;
  if (upper(t[i]) === 'CONCURRENTLY') i++;
  if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'EXISTS') i += 2;
  let dropped = 0;
  const onAt = t.findIndex((tok, k) => k > i && upper(tok) === 'ON');
  const onTable = onAt > 0 ? readName(t, onAt + 1) : undefined;
  for (const [from] of splitTopLevel(t, i, onAt > 0 ? onAt : t.length)) {
    const name = readName(t, from);
    if (!name) continue;
    const index = name.parts[name.parts.length - 1];
    // SQL Server's `DROP INDEX t.ix`, or `DROP INDEX ix ON t`.
    const tableParts = onTable ? cx.qualify(onTable.parts) : name.parts.length >= 2 && cx.dialect === 'sqlserver' ? cx.qualify(name.parts.slice(0, -1)) : undefined;
    if (dropNamedUnique(cx, index, tableParts)) dropped++;
  }
  if (dropped) cx.appliedChanges++;
  return dropped > 0;
}

/** `ALTER INDEX [IF EXISTS] a RENAME TO b`: a unique index keeps its key under the new name. Whether it renamed one. */
function readAlterIndex(cx: ConverterContext, st: Statement): boolean {
  const t = st.tokens;
  let i = 2;
  if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'EXISTS') i += 2;
  const name = readName(t, i);
  if (!name || upper(t[name.next]) !== 'RENAME' || upper(t[name.next + 1]) !== 'TO' || !isName(t[name.next + 2])) return false;
  const from = name.parts[name.parts.length - 1];
  const to = t[name.next + 2].value;
  let renamed = 0;
  for (const k of cx.keys) if (k.kind === 'unique' && k.name && sameIdent(k.name, from)) { k.name = to; renamed++; }
  for (const tb of cx.tables) for (const c of tb.constraintNames ?? []) if (c.kind === 'unique' && sameIdent(c.name, from)) { c.name = to; renamed++; }
  if (renamed) cx.appliedChanges++;
  return renamed > 0;
}

/** A unique key named `name` (a pending unique index or key, or a table's named unique constraint) leaves the model. */
function dropNamedUnique(cx: ConverterContext, name: string, tableParts?: readonly string[]): boolean {
  const table = tableParts ? cx.findTable(tableParts) : undefined;
  const before = cx.keys.length;
  removeWhere(cx.keys, (k) => k.kind === 'unique' && !!k.name && sameIdent(k.name, name) && (!table || cx.findTable(k.table) === table));
  if (cx.keys.length < before) return true;
  for (const tb of table ? [table] : cx.tables) {
    const c = tb.constraintNames?.find((n) => n.kind === 'unique' && sameIdent(n.name, name));
    if (c) { applyConstraintDrop(cx, tb, c); return true; }
  }
  return false;
}

// -- ALTER TABLE ----------------------------------------------------------

/** What continues an ALTER TABLE list item that does not start with an action. */
type Continues = 'addColumn' | 'addConstraint' | 'dropColumn' | 'dropConstraint';

export function readAlterTable(cx: ConverterContext, text: string, st: Statement, origin: Origin): void {
  const t = st.tokens;
  let i = 2;
  while (upper(t[i]) === 'ONLY' || (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'EXISTS')) i += upper(t[i]) === 'IF' ? 2 : 1;
  const name = readName(t, i);
  if (!name) { cx.skip(origin.file, 'alter'); return; }
  // What the statement adds that waits for the end (keys, foreign keys, checks, comments, partitions) names the
  // table as written: a partition's are folded or kept with it (`sqlDdlPartitions.ts`). A change applied
  // now (a column, a rename) goes to the table the partition is read as.
  const ownParts = cx.qualify(name.parts);
  const tableParts = foldPartition(cx, ownParts);
  let handled = 0;
  let checkOnly = false;
  let unhandledKind: SkipKind | undefined;
  const unhandled = (kind: SkipKind = 'alter'): void => { unhandledKind ??= kind; };
  let continues: Continues | undefined;
  for (const [from, to] of splitTopLevel(t, name.next, t.length)) {
    let k = from;
    const where: Origin = { file: origin.file, line: t[from]?.line ?? origin.line };
    if (upper(t[k]) === 'WITH' && (upper(t[k + 1]) === 'CHECK' || upper(t[k + 1]) === 'NOCHECK')) k += 2;
    // `ALTER TABLE x [WITH CHECK] CHECK CONSTRAINT fk` only re-enables a key SQL Server just added.
    if ((upper(t[k]) === 'CHECK' || upper(t[k]) === 'NOCHECK') && upper(t[k + 1]) === 'CONSTRAINT') { checkOnly = true; continues = undefined; continue; }
    let action = upper(t[k]);
    // After an ADD, an item that starts with a constraint keyword is another thing added (SQL Server: `ADD CONSTRAINT a …, CONSTRAINT b …`).
    if ((continues === 'addConstraint' || continues === 'addColumn') && ADD_CONTINUES_WORDS.has(action)) action = 'ADD…';
    else if (continues && isName(t[k]) && !ALTER_ACTION_WORDS.has(action)) {
      // SQL Server lists more after one DROP: `DROP CONSTRAINT a, b`, `DROP CONSTRAINT a, COLUMN c`.
      const dropsColumn = continues === 'dropColumn' || (continues === 'dropConstraint' && action === 'COLUMN' && isName(t[k + 1]));
      if (continues === 'addColumn' || continues === 'addConstraint') alterAddColumns(cx, text, tableParts, t, k, to, where);
      else if (dropsColumn) { alterDropColumn(cx, tableParts, t[action === 'COLUMN' ? k + 1 : k].value, where); continues = 'dropColumn'; }
      else dropConstraint(cx, tableParts, t[k].value, where, false);
      handled++;
      continue;
    }
    continues = undefined;
    if (action === 'ADD' || action === 'ADD…') {
      const added = readAddItem(cx, text, tableParts, t, action === 'ADD' ? k + 1 : k, to, where, ownParts);
      if (added === 'column') { continues = 'addColumn'; handled++; }
      else if (added === 'constraint') { continues = 'addConstraint'; handled++; }
      else if (added) handled++;
      else unhandled();
    } else if (action === 'DROP') {
      const dropped = readDropItem(cx, tableParts, t, k + 1, where);
      if (dropped === 'column') { continues = 'dropColumn'; handled++; }
      else if (dropped === 'constraint') { continues = 'dropConstraint'; handled++; }
      else if (dropped) handled++;
      else unhandled(DROP_SETTING_WORDS.has(upper(t[k + 1])) ? 'alterSetting' : 'alter');
    } else if (action === 'RENAME') {
      k++;
      if (upper(t[k]) === 'TO' || upper(t[k]) === 'AS') {
        const target = readName(t, k + 1);
        if (target && renamePartitionChild(cx, ownParts, target.parts)) handled++;
        else if (target) { renameTable(cx, tableParts, target.parts, where); handled++; } else unhandled();
      } else if (upper(t[k]) === 'CONSTRAINT' || upper(t[k]) === 'INDEX' || upper(t[k]) === 'KEY') {
        if (isName(t[k + 1]) && upper(t[k + 2]) === 'TO' && isName(t[k + 3])) { renameConstraint(cx, tableParts, t[k + 1].value, t[k + 3].value, where); handled++; } else unhandled();
      } else {
        if (upper(t[k]) === 'COLUMN') k++;
        if (isName(t[k]) && upper(t[k + 1]) === 'TO' && isName(t[k + 2])) {
          renameColumn(cx, tableParts, t[k].value, t[k + 2].value, where);
          handled++;
        } else unhandled();
      }
    } else if (action === 'CHANGE' || action === 'MODIFY') {
      // MySQL: CHANGE [COLUMN] old new <definition>; MODIFY [COLUMN] name <definition>.
      k++;
      if (upper(t[k]) === 'COLUMN') k++;
      if (!isName(t[k])) { unhandled(); continue; }
      const old = t[k].value;
      const defStart = action === 'CHANGE' ? k + 1 : k;
      if (!isName(t[defStart])) { unhandled(); continue; }
      replaceColumn(cx, text, tableParts, old, t, defStart, to, where);
      handled++;
    } else if (action === 'ALTER') {
      if (readAlterColumn(cx, text, tableParts, t, k + 1, to, where)) handled++;
      else unhandled('alterSetting');
    } else if (action === 'ATTACH' && upper(t[k + 1]) === 'PARTITION') {
      const child = readName(t, k + 2);
      if (child) { readerState(cx).partitions.push({ child: cx.qualify(child.parts), parent: [...ownParts], how: 'ATTACH PARTITION', origin: where }); handled++; } else unhandled('alterPartition');
    } else if (action === 'DETACH' && upper(t[k + 1]) === 'PARTITION') {
      // From here on a table of its own: no longer folded into this parent.
      const child = readName(t, k + 2);
      const records = child ? readerState(cx).partitions.filter((p) => !p.detached && p.how !== 'INHERITS' && sameParts(p.child, cx.qualify(child.parts), cx) && sameParts(p.parent, ownParts, cx)) : [];
      for (const p of records) p.detached = true;
      if (records.length) handled++; else unhandled('alterPartition');
    } else if (action === 'INHERIT' || (action === 'NO' && upper(t[k + 1]) === 'INHERIT')) {
      // `ALTER TABLE child [NO] INHERIT parent`: inheritance added or removed in file order.
      const parent = readName(t, action === 'NO' ? k + 2 : k + 1);
      if (!parent) { unhandled('alterPartition'); continue; }
      const parentParts = cx.qualify(parent.parts);
      if (action === 'INHERIT') readerState(cx).partitions.push({ child: [...ownParts], parent: parentParts, how: 'INHERITS', origin: where });
      else for (const p of readerState(cx).partitions) if (!p.detached && p.how === 'INHERITS' && sameParts(p.child, ownParts, cx) && sameParts(p.parent, parentParts, cx)) p.detached = true;
      handled++;
    } else if (action === 'COMMENT' && (t[k + 1]?.kind === 'string' || (isPunct(t[k + 1], '=') && t[k + 2]?.kind === 'string'))) {
      // MySQL / Snowflake: ALTER TABLE t COMMENT [=] '…' is the table's description.
      cx.comments.push({ table: [...ownParts], text: (isPunct(t[k + 1], '=') ? t[k + 2] : t[k + 1]).value, origin: where });
      handled++;
    } else if (action === 'OWNER') {
      unhandled('alterOwner');
    } else if (SETTING_ACTIONS.has(action)) {
      unhandled('alterSetting');
    } else {
      unhandled();
    }
  }
  if ((unhandledKind || !handled) && !checkOnly) cx.skip(origin.file, unhandledKind ?? 'alter');
}

/** Words that, after an ADD, start another thing added. */
const ADD_CONTINUES_WORDS = new Set(['CONSTRAINT', 'FOREIGN', 'PRIMARY', 'UNIQUE', 'CHECK']);

/** ALTER TABLE actions that change a setting, not the design (storage, triggers, security, tags…). */
const SETTING_ACTIONS = new Set([
  'SET', 'RESET', 'ENABLE', 'DISABLE', 'CLUSTER', 'REPLICA', 'FORCE', 'NO', 'INHERIT', 'OF', 'NOT', 'VALIDATE', 'ALGORITHM',
  'LOCK', 'ENGINE', 'AUTO_INCREMENT', 'CONVERT', 'DEFAULT', 'CHARACTER', 'COMMENT', 'ORDER', 'PARTITION', 'REMOVE', 'TRUNCATE',
  'COALESCE', 'REORGANIZE', 'EXCHANGE', 'ANALYZE', 'OPTIMIZE', 'REBUILD', 'REPAIR', 'SWAP', 'UNSET', 'SUSPEND', 'RESUME',
  'RECLUSTER', 'CLUSTERING', 'SWITCH', 'TRIGGER', 'ROW', 'SPLIT', 'MERGE', 'DISCARD', 'IMPORT', 'TABLESPACE', 'ROW_FORMAT',
]);

/** After DROP, words that name a setting rather than design. */
const DROP_SETTING_WORDS = new Set(['DEFAULT', 'NOT', 'IDENTITY', 'EXPRESSION', 'PARTITION', 'PERIOD', 'SYSTEM', 'CLUSTERING', 'ROW', 'SEARCH', 'TAG', 'MASKING', 'ROWS']);

/**
 * One thing an ALTER TABLE adds, from `k` (after ADD): a foreign key, a
 * primary or unique key, a check, a SQL Server `DEFAULT … FOR col`, an index
 * (counted), or columns. What it was, or undefined when it does not read.
 */
function readAddItem(
  cx: ConverterContext, text: string, tableParts: string[], t: Token[], k: number, to: number, where: Origin, ownParts: string[] = tableParts,
): 'column' | 'columns' | 'constraint' | 'index' | undefined {
  const columnWord = upper(t[k]) === 'COLUMN' || upper(t[k]) === 'COLUMNS';
  if (columnWord) k++;
  if (upper(t[k]) === 'IF' && upper(t[k + 1]) === 'NOT' && upper(t[k + 2]) === 'EXISTS') k += 3;
  let name: string | undefined;
  if (upper(t[k]) === 'CONSTRAINT' && isName(t[k + 1])) { name = t[k + 1].value; k += 2; }
  const kind = upper(t[k]);
  if (kind === 'FOREIGN' && upper(t[k + 1]) === 'KEY') {
    let c = k + 2;
    if (isName(t[c]) && isPunct(t[c + 1], '(')) { name ??= t[c].value; c++; }
    const fkCols = readColumnList(t, c);
    if (!fkCols || upper(t[fkCols.next]) !== 'REFERENCES') return undefined;
    const target = readName(t, fkCols.next + 1);
    if (!target) return undefined;
    const pkCols = isPunct(t[target.next], '(') ? readColumnList(t, target.next) : undefined;
    cx.refs.push({
      from: { parts: [...ownParts], columns: fkCols.columns },
      to: { parts: cx.qualify(target.parts), columns: pkCols?.columns ?? [] },
      origin: where,
      ...(name ? { name } : {}),
      ...readRefActions(t, pkCols?.next ?? target.next, to),
    });
    return 'constraint';
  }
  if ((kind === 'PRIMARY' && upper(t[k + 1]) === 'KEY') || kind === 'UNIQUE') {
    let open = kind === 'PRIMARY' ? k + 2 : k + 1;
    while (open < to && !isPunct(t[open], '(')) {
      if (kind === 'UNIQUE' && !name && isName(t[open]) && isPunct(t[open + 1], '(') && !/^(KEY|INDEX|CLUSTERED|NONCLUSTERED)$/.test(upper(t[open]))) name = t[open].value;
      open++;
    }
    const cols = readColumnList(t, open);
    if (!cols) return undefined;
    cx.keys.push({ table: [...ownParts], kind: kind === 'PRIMARY' ? 'pk' : 'unique', columns: cols.columns, origin: where, ...(name ? { name } : {}) });
    return 'constraint';
  }
  if (kind === 'CHECK' && isPunct(t[k + 1], '(')) {
    const close = matchParen(t, k + 1);
    if (close < 0 || close === k + 2) return undefined;
    readerState(cx).checks.push({
      table: [...ownParts],
      expression: text.slice(t[k + 2].start, t[close - 1].end).replace(/\s+/g, ' ').trim(),
      ...(name ? { name } : {}),
      origin: where,
    });
    return 'constraint';
  }
  if (kind === 'DEFAULT') {
    // SQL Server: ADD [CONSTRAINT df] DEFAULT <expr> FOR col.
    const forAt = t.findIndex((tok, x) => x > k && x < to && upper(tok) === 'FOR');
    if (forAt < 0 || !isName(t[forAt + 1])) return undefined;
    setDefault(cx, tableParts, t[forAt + 1].value, text, t, k + 1, forAt, where);
    return 'constraint';
  }
  if (kind === 'INDEX' || kind === 'KEY' || kind === 'FULLTEXT' || kind === 'SPATIAL') {
    cx.skip(where.file, 'plainIndex');
    return 'index';
  }
  if (isPunct(t[k], '(') && (columnWord || cx.dialect !== 'sqlserver')) {
    // ADD [COLUMNS] (a INT, b STRING): MySQL, Databricks.
    const close = matchParen(t, k);
    if (close < 0) return undefined;
    for (const [cf, ct] of splitTopLevel(t, k + 1, close, cx.dialect === 'databricks')) alterAddColumns(cx, text, tableParts, t, cf, ct, where);
    return 'columns';
  }
  if (isName(t[k]) && !ADD_NOT_COLUMN_WORDS.has(kind)) {
    alterAddColumns(cx, text, tableParts, t, k, to, where);
    return 'column';
  }
  return undefined;
}

/**
 * One thing an ALTER TABLE drops, from `k` (after DROP): a constraint by
 * name (also MySQL's FOREIGN KEY / INDEX / KEY / CHECK by name), the primary
 * key, or a column. What it was, or undefined when it does not read.
 */
function readDropItem(cx: ConverterContext, tableParts: string[], t: Token[], k: number, where: Origin): 'column' | 'constraint' | 'key' | undefined {
  const word = upper(t[k]);
  const ifExistsAt = (at: number): number => (upper(t[at]) === 'IF' && upper(t[at + 1]) === 'EXISTS' ? at + 2 : at);
  if (word === 'CONSTRAINT' || (word === 'FOREIGN' && upper(t[k + 1]) === 'KEY') || word === 'INDEX' || word === 'KEY' || (word === 'CHECK' && isName(t[k + 1]))) {
    let at = word === 'FOREIGN' ? k + 2 : k + 1;
    const before = at;
    at = ifExistsAt(at);
    if (!isName(t[at])) return undefined;
    dropConstraint(cx, tableParts, t[at].value, where, at > before, word === 'INDEX' || word === 'KEY' ? 'index' : undefined);
    return 'constraint';
  }
  if (word === 'PRIMARY' && upper(t[k + 1]) === 'KEY') {
    dropPrimaryKey(cx, tableParts, where);
    return 'key';
  }
  let at = k;
  const columnWord = upper(t[at]) === 'COLUMN';
  if (columnWord) at++;
  at = ifExistsAt(at);
  if (isName(t[at]) && (columnWord || !DROP_NOT_COLUMN_WORDS.has(upper(t[at])))) {
    alterDropColumn(cx, tableParts, t[at].value, where);
    return 'column';
  }
  return undefined;
}

/** `ALTER [COLUMN] x …` from `k`: a type, NOT NULL or default change. Whether it read (the rest are settings: masks, tags, statistics). */
function readAlterColumn(cx: ConverterContext, text: string, tableParts: string[], t: Token[], k: number, to: number, where: Origin): boolean {
  if (upper(t[k]) === 'COLUMN') k++;
  if (!isName(t[k])) return false;
  const column = t[k].value;
  k++;
  if (upper(t[k]) === 'SET' && upper(t[k + 1]) === 'DATA' && upper(t[k + 2]) === 'TYPE') k += 2;
  if (upper(t[k]) === 'TYPE') {
    let end = k + 1;
    while (end < to && !['USING', 'COLLATE'].includes(upper(t[end]))) end++;
    if (end <= k + 1) return false;
    alterColumn(cx, tableParts, column, { type: text.slice(t[k + 1].start, t[end - 1].end) }, where);
    return true;
  }
  if ((upper(t[k]) === 'SET' || upper(t[k]) === 'DROP') && upper(t[k + 1]) === 'NOT' && upper(t[k + 2]) === 'NULL') {
    alterColumn(cx, tableParts, column, { notNull: upper(t[k]) === 'SET' }, where);
    return true;
  }
  if (upper(t[k]) === 'SET' && upper(t[k + 1]) === 'DEFAULT' && k + 2 < to) {
    setDefault(cx, tableParts, column, text, t, k + 2, to, where);
    return true;
  }
  // Databricks / Snowflake: ALTER COLUMN c COMMENT '…' (Snowflake also SET COMMENT = '…'): the column's description.
  const commentAt = upper(t[k]) === 'COMMENT' ? k + 1 : upper(t[k]) === 'SET' && upper(t[k + 1]) === 'COMMENT' ? k + 2 : -1;
  if (commentAt > 0) {
    const value = isPunct(t[commentAt], '=') ? t[commentAt + 1] : t[commentAt];
    if (value?.kind !== 'string') return false;
    cx.comments.push({ table: [...tableParts], column, text: value.value, origin: where });
    return true;
  }
  // PostgreSQL (pg_dump): ALTER COLUMN id ADD GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY (…).
  if (upper(t[k]) === 'ADD' && upper(t[k + 1]) === 'GENERATED' && t.slice(k + 2, to).some((tok) => upper(tok) === 'IDENTITY')) {
    const table = alterTarget(cx, tableParts, where, `an identity on ${column}`);
    const field = table?.fields.find((f) => sameIdent(f.name, column));
    if (field) field.increment = true;
    return true;
  }
  if (upper(t[k]) === 'DROP' && upper(t[k + 1]) === 'DEFAULT') {
    const table = alterTarget(cx, tableParts, where, `a default dropped from ${column}`);
    const field = table?.fields.find((f) => sameIdent(f.name, column));
    if (!table) return true;
    if (!field) { cx.notApplied(where, `a default dropped from ${tableLabel(table)}.${column}, which it does not have (not applied)`); return true; }
    delete field.default;
    return true;
  }
  return false;
}

/** A column's default set to `t[from, to)` (`ALTER COLUMN x SET DEFAULT …`, SQL Server's `ADD DEFAULT … FOR x`); NULL clears it. */
function setDefault(cx: ConverterContext, parts: readonly string[], column: string, text: string, t: Token[], from: number, to: number, where: Origin): void {
  const table = alterTarget(cx, parts, where, `a default set on ${column}`);
  if (!table) return;
  const field = table.fields.find((f) => sameIdent(f.name, column));
  if (!field) { cx.notApplied(where, `a default set on ${tableLabel(table)}.${column}, which it does not have (not applied)`); return; }
  let a = from;
  let b = to;
  // `DEFAULT ((0))`, `DEFAULT (getdate())`: the parentheses around the whole value.
  while (isPunct(t[a], '(') && matchParen(t, a) === b - 1) { a++; b--; }
  if (a >= b) return;
  const only = b - a === 1 ? t[a] : undefined;
  const negative = b - a === 2 && isPunct(t[a], '-') && t[a + 1].kind === 'number';
  if (only && upper(only) === 'NULL') delete field.default;
  else if (only?.kind === 'string') field.default = { type: 'string', value: only.value };
  else if (b - a === 2 && upper(t[a]) === 'N' && t[a + 1].kind === 'string') field.default = { type: 'string', value: t[a + 1].value };
  else if (only?.kind === 'number' || negative) field.default = { type: 'number', value: negative ? `-${t[a + 1].value}` : only!.value };
  else if (only && /^(TRUE|FALSE)$/.test(upper(only))) field.default = { type: 'boolean', value: upper(only).toLowerCase() };
  else field.default = { type: 'expression', value: text.slice(t[a].start, t[b - 1].end).replace(/\s+/g, ' ').trim() };
}

// -- constraint replay ------------------------------------------------------

/**
 * A constraint dropped by name, in file order: a pending foreign key or key
 * of that name, one the table's CREATE named, or one PostgreSQL named
 * itself (`t_pkey`, `t_a_b_fkey`, `t_a_key`, `t_a_check`) or MySQL did
 * (`t_ibfk_N`). `IF EXISTS` of a name the files never gave drops nothing,
 * silently; without it the drop is said (not applied). `kind` 'index': a
 * MySQL `DROP INDEX` / `DROP KEY` of a plain index the import never kept is
 * not worth a word either.
 */
export function dropConstraint(cx: ConverterContext, parts: readonly string[], name: string, where: Origin, ifExists: boolean, kind?: 'index'): boolean {
  const table = cx.findTable(parts);
  const fromIt = (r: PendingRef): boolean => {
    const from = r.fromTable ?? cx.findTable(r.from.parts);
    return table ? from === table : sameParts(r.from.parts, parts, cx);
  };
  let removed = 0;
  const count = <T>(items: T[], drop: (item: T) => boolean): void => {
    const before = items.length;
    removeWhere(items, drop);
    removed += before - items.length;
  };
  count(cx.refs, (r) => !!r.name && sameIdent(r.name, name) && fromIt(r));
  count(cx.keys, (k) => !!k.name && sameIdent(k.name, name) && (table ? cx.findTable(k.table) === table : sameParts(k.table, parts, cx)));
  count(readerState(cx).checks, (c) => !!c.name && sameIdent(c.name, name) && (table ? cx.findTable(c.table) === table : sameParts(c.table, parts, cx)));
  if (!removed && table) {
    const named = table.constraintNames?.find((c) => sameIdent(c.name, name));
    if (named) { applyConstraintDrop(cx, table, named); removed++; }
  }
  if (!removed && table) removed += dropGeneratedName(cx, table, name);
  if (removed) { cx.appliedChanges++; return true; }
  if (!ifExists && kind !== 'index') {
    cx.notApplied(where, `constraint ${name} dropped from ${parts.slice(-2).join('.')}, which the files never defined by that name (not applied)`);
  }
  return false;
}

/** A named constraint of `table`'s own CREATE (or a later ALTER's, once applied) leaves it. */
function applyConstraintDrop(cx: ConverterContext, table: ModelTable, c: NonNullable<ModelTable['constraintNames']>[number]): void {
  table.constraintNames = table.constraintNames?.filter((x) => x !== c);
  if (c.kind === 'pk') clearPrimaryKey(table);
  else if (c.kind === 'unique') removeUnique(table, c.columns);
  else if (c.kind === 'fk') removeWhere(cx.refs, (r) => (r.fromTable ?? cx.findTable(r.from.parts)) === table && sameColumns(r.from.columns, c.columns));
  else {
    const before = table.checks.length;
    table.checks = table.checks.filter((x) => !(x.name && sameIdent(x.name, c.name)));
    // A named column CHECK: its field's only check.
    if (table.checks.length === before && c.columns.length === 1) {
      const field = table.fields.find((f) => sameIdent(f.name, c.columns[0]));
      if (field && field.checks.length === 1) field.checks = [];
    }
  }
}

/** What a database-generated constraint name stands for on a table. */
type GeneratedConstraint =
  | { kind: 'pk'; columns: string[] }
  | { kind: 'fk'; refs: PendingRef[]; columns: string[] }
  | { kind: 'unique'; columns: string[] }
  | { kind: 'check'; columns: string[] };

/**
 * The constraint a name the database gave stands for: PostgreSQL's
 * `t_pkey`, `t_a_b_fkey`, `t_a_b_key`, `t_a_check`, and MySQL's `t_ibfk_N`
 * (the table's Nth unnamed foreign key). Undefined when the table has none.
 */
function generatedConstraint(cx: ConverterContext, table: ModelTable, name: string): GeneratedConstraint | undefined {
  const n = name.toLowerCase();
  const base = table.name.toLowerCase();
  if (!n.startsWith(`${base}_`)) return undefined;
  const rest = n.slice(base.length + 1);
  const joined = (columns: readonly string[]): string => columns.map((c) => c.toLowerCase()).join('_');
  const fromIt = (r: PendingRef): boolean => (r.fromTable ?? cx.findTable(r.from.parts)) === table;
  // A constraint the files named has that name, never the one the database would have given it
  // (`CONSTRAINT pk_orders PRIMARY KEY` is not `orders_pkey`): only an unnamed one matches.
  const named = (kind: GeneratedConstraint['kind'], columns?: readonly string[]): boolean =>
    (table.constraintNames ?? []).some((c) => c.kind === kind && (!columns || sameColumns(c.columns, columns)));
  if (rest === 'pkey') {
    if (named('pk')) return undefined;
    const pending = cx.keys.find((k) => k.kind === 'pk' && !k.name && cx.findTable(k.table) === table);
    const columns = primaryKeyOf(table).length ? primaryKeyOf(table) : pending?.columns ?? [];
    return columns.length ? { kind: 'pk', columns } : undefined;
  }
  if (rest.endsWith('_fkey')) {
    const cols = rest.slice(0, -'_fkey'.length);
    const refs = cx.refs.filter((r) => !r.name && fromIt(r) && joined(r.from.columns) === cols);
    return refs.length ? { kind: 'fk', refs, columns: refs[0].from.columns } : undefined;
  }
  const ibfk = /^ibfk_(\d+)$/.exec(rest);
  if (ibfk) {
    const ref = cx.refs.filter((r) => !r.name && fromIt(r))[Number(ibfk[1]) - 1];
    return ref ? { kind: 'fk', refs: [ref], columns: ref.from.columns } : undefined;
  }
  if (rest.endsWith('_key')) {
    const cols = rest.slice(0, -'_key'.length);
    const pending = cx.keys.find((k) => k.kind === 'unique' && !k.name && cx.findTable(k.table) === table && joined(k.columns) === cols);
    if (pending) return { kind: 'unique', columns: pending.columns };
    const single = table.fields.find((f) => f.unique && f.name.toLowerCase() === cols && !named('unique', [f.name]));
    if (single) return { kind: 'unique', columns: [single.name] };
    const composite = table.uniques.find((u) => joined(u) === cols && !named('unique', u));
    return composite ? { kind: 'unique', columns: composite } : undefined;
  }
  if (rest.endsWith('_check')) {
    const field = table.fields.find((f) => f.name.toLowerCase() === rest.slice(0, -'_check'.length) && f.checks.length > 0 && !named('check', [f.name]));
    return field ? { kind: 'check', columns: [field.name] } : undefined;
  }
  return undefined;
}

/** Drops the constraint a database-generated name stands for; how many things left the model. */
function dropGeneratedName(cx: ConverterContext, table: ModelTable, name: string): number {
  const g = generatedConstraint(cx, table, name);
  if (!g) return 0;
  if (g.kind === 'fk') { removeWhere(cx.refs, (r) => g.refs.includes(r)); return g.refs.length; }
  if (g.kind === 'pk') {
    clearPrimaryKey(table);
    removeWhere(cx.keys, (k) => k.kind === 'pk' && !k.name && cx.findTable(k.table) === table);
    return 1;
  }
  if (g.kind === 'unique') {
    const pending = cx.keys.findIndex((k) => k.kind === 'unique' && !k.name && cx.findTable(k.table) === table && sameColumns(k.columns, g.columns));
    if (pending >= 0) cx.keys.splice(pending, 1);
    else removeUnique(table, g.columns);
    return 1;
  }
  const field = table.fields.find((f) => sameIdent(f.name, g.columns[0]));
  if (field) field.checks = [];
  return 1;
}

function clearPrimaryKey(table: ModelTable): void {
  table.primaryKey = undefined;
  for (const f of table.fields) f.pk = false;
}

function removeUnique(table: ModelTable, columns: readonly string[]): void {
  if (columns.length === 1) {
    const field = table.fields.find((f) => sameIdent(f.name, columns[0]));
    if (field) field.unique = false;
  }
  table.uniques = table.uniques.filter((u) => !sameColumns(u, columns));
}

/** MySQL's `DROP PRIMARY KEY`. */
function dropPrimaryKey(cx: ConverterContext, parts: readonly string[], where: Origin): void {
  const table = alterTarget(cx, parts, where, 'a primary key dropped');
  removeWhere(cx.keys, (k) => k.kind === 'pk' && (table ? cx.findTable(k.table) === table : sameParts(k.table, parts, cx)));
  if (table) clearPrimaryKey(table);
  cx.appliedChanges++;
}

/** `RENAME CONSTRAINT a TO b` (and MySQL's `RENAME INDEX | KEY`): what is named `a` is named `b`. */
function renameConstraint(cx: ConverterContext, parts: readonly string[], from: string, to: string, where: Origin): void {
  const table = cx.findTable(parts);
  let renamed = 0;
  for (const r of cx.refs) if (r.name && sameIdent(r.name, from) && (r.fromTable ?? cx.findTable(r.from.parts)) === table) { r.name = to; renamed++; }
  for (const k of cx.keys) if (k.name && sameIdent(k.name, from) && cx.findTable(k.table) === table) { k.name = to; renamed++; }
  for (const c of readerState(cx).checks) if (c.name && sameIdent(c.name, from) && cx.findTable(c.table) === table) { c.name = to; renamed++; }
  for (const c of table?.constraintNames ?? []) if (sameIdent(c.name, from)) { c.name = to; renamed++; }
  for (const c of table?.checks ?? []) if (c.name && sameIdent(c.name, from)) { c.name = to; renamed++; }
  // A name the database gave (`t_pkey`, `t_a_fkey`…) is the constraint's from now on.
  const generated = !renamed && table ? generatedConstraint(cx, table, from) : undefined;
  if (generated && table) {
    if (generated.kind === 'fk') for (const r of generated.refs) r.name = to;
    else (table.constraintNames ??= []).push({ name: to, kind: generated.kind, columns: [...generated.columns] });
    renamed++;
  }
  if (renamed) cx.appliedChanges++;
  else cx.notApplied(where, `constraint ${from} renamed on ${parts.slice(-2).join('.')}, which the files never defined by that name (not applied)`);
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => sameIdent(c, b[i]));
}

function sameParts(a: readonly string[], b: readonly string[], cx: ConverterContext): boolean {
  if (!sameIdent(a[a.length - 1], b[b.length - 1])) return false;
  const sa = a.length >= 2 ? a[a.length - 2] : null;
  const sb = b.length >= 2 ? b[b.length - 2] : null;
  return sa === null || sb === null || sameSchema(sa, sb, cx.dialect);
}

// -- RENAME TABLE, DROP TABLE ------------------------------------------------

/** MySQL's `RENAME TABLE a TO b [, c TO d]`. */
export function readRenameTable(cx: ConverterContext, st: Statement, origin: Origin): void {
  const t = st.tokens;
  let renamed = 0;
  for (const [from] of splitTopLevel(t, 2, t.length)) {
    const source = readName(t, from);
    if (!source || upper(t[source.next]) !== 'TO') continue;
    const target = readName(t, source.next + 1);
    if (!target) continue;
    renameTable(cx, cx.qualify(source.parts), target.parts, { file: origin.file, line: t[from].line });
    renamed++;
  }
  if (!renamed) cx.skip(origin.file, 'other');
}

/**
 * `DROP TABLE [IF EXISTS] a [, b]` in a migration: a table the files defined
 * earlier is gone; one they never defined is a skipped DROP. In a file of
 * DROPs alone (`dropsApply` false) every one is a skipped DROP.
 */
export function readDropTable(cx: ConverterContext, st: Statement, origin: Origin): void {
  if (!cx.dropsApply) {
    cx.skip(origin.file, 'drop');
    return;
  }
  const t = st.tokens;
  let i = 2;
  if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'EXISTS') i += 2;
  let dropped = 0;
  for (const [from] of splitTopLevel(t, i, t.length)) {
    const name = readName(t, from);
    const table = name ? cx.findTable(cx.qualify(name.parts)) : undefined;
    if (!table) continue;
    removeTable(cx, table);
    cx.appliedChanges++;
    dropped++;
  }
  if (!dropped) cx.skip(origin.file, 'drop');
}

// -- schema changes, applied in file order ---------------------------------

/** The table an ALTER names, or undefined (said) when the files have not defined it. */
export function alterTarget(cx: ConverterContext, parts: readonly string[], where: Origin, what: string): ModelTable | undefined {
  const table = cx.findTable(parts);
  if (!table) cx.notApplied(where, `${what} on ${parts.slice(-2).join('.')}, which is not in the files (not applied)`);
  return table;
}

export function alterAddColumns(cx: ConverterContext, text: string, parts: readonly string[], tokens: Token[], from: number, end: number, where: Origin): void {
  const table = alterTarget(cx, parts, where, 'a column added');
  if (!table) return;
  const to = withoutColumnPosition(tokens, from, end);
  const read = cx.readColumnDefinitions(text, tokens, from, to, where.file);
  if (!read) { cx.notApplied(where, `a column added to ${tableLabel(table)} could not be read (not applied)`); return; }
  const label = tableLabel(table);
  for (const field of read.table.fields) {
    if (table.fields.some((f) => sameIdent(f.name, field.name))) continue; // ADD COLUMN IF NOT EXISTS, or added twice.
    table.fields.push(field);
    for (const c of field.constraints ?? []) (table.constraintNames ??= []).push({ name: c.name, kind: c.kind, columns: [field.name] });
    recordColumnLosses(cx, field, { file: where.file, line: where.line, table: label, column: field.name });
    cx.appliedChanges++;
  }
  for (const ref of read.refs) {
    const actions = readRefActions(tokens, from, to);
    const inlineName = read.table.fields.find((f) => sameColumns([f.name], ref.from.columns))?.constraints?.find((c) => c.kind === 'fk')?.name;
    cx.refs.push({
      ...ref,
      from: { parts: [...parts], columns: ref.from.columns },
      to: { parts: ref.to.parts, columns: ref.to.columns },
      fromTable: table,
      origin: where,
      ...(ref.name || inlineName ? { name: ref.name ?? inlineName } : {}),
      ...(ref.onDelete || actions.onDelete ? { onDelete: ref.onDelete ?? actions.onDelete } : {}),
      ...(ref.onUpdate || actions.onUpdate ? { onUpdate: ref.onUpdate ?? actions.onUpdate } : {}),
    });
  }
  if (read.table.primaryKey) cx.setPrimaryKey(table, read.table.primaryKey);
  for (const unique of read.table.uniques) cx.addUnique(table, unique);
}

export function replaceColumn(cx: ConverterContext, text: string, parts: readonly string[], oldName: string, tokens: Token[], from: number, to: number, where: Origin): void {
  const table = alterTarget(cx, parts, where, `a change to column ${oldName}`);
  if (!table) return;
  const index = table.fields.findIndex((f) => sameIdent(f.name, oldName));
  if (index < 0) { cx.notApplied(where, `a change to ${tableLabel(table)}.${oldName}, which it does not have (not applied)`); return; }
  const read = cx.readColumnDefinitions(text, tokens, from, withoutColumnPosition(tokens, from, to), where.file);
  const field = read?.table.fields[0];
  if (!field) { cx.notApplied(where, `a change to ${tableLabel(table)}.${oldName} could not be read (not applied)`); return; }
  const before = table.fields[index];
  if (!sameIdent(before.name, field.name)) renameColumn(cx, parts, before.name, field.name, where);
  table.fields[index] = { ...field, pk: field.pk || before.pk, note: field.note ?? before.note };
  cx.appliedChanges++;
}

export function alterColumn(cx: ConverterContext, parts: readonly string[], column: string, change: { type?: string; notNull?: boolean }, where: Origin): void {
  const table = alterTarget(cx, parts, where, `a change to column ${column}`);
  if (!table) return;
  const field = table.fields.find((f) => sameIdent(f.name, column));
  if (!field) { cx.notApplied(where, `a change to ${tableLabel(table)}.${column}, which it does not have (not applied)`); return; }
  if (change.type !== undefined) field.type = change.type.replace(/\s+/g, ' ').trim() || field.type;
  if (change.notNull !== undefined) field.notNull = change.notNull;
  cx.appliedChanges++;
}

export function renameColumn(cx: ConverterContext, parts: readonly string[], oldName: string, newName: string, where: Origin): void {
  const table = alterTarget(cx, parts, where, `a column renamed (${oldName} to ${newName})`);
  if (!table) return;
  const field = table.fields.find((f) => sameIdent(f.name, oldName));
  if (!field) { cx.notApplied(where, `${tableLabel(table)}.${oldName} renamed, but it has no such column (not applied)`); return; }
  field.name = newName;
  const rename = (columns: string[]): string[] => columns.map((c) => (sameIdent(c, oldName) ? newName : c));
  if (table.primaryKey) table.primaryKey = rename(table.primaryKey);
  table.uniques = table.uniques.map(rename);
  for (const c of table.constraintNames ?? []) c.columns = rename(c.columns);
  for (const ref of cx.refs) {
    if ((ref.fromTable ?? cx.findTable(ref.from.parts)) === table) ref.from.columns = rename(ref.from.columns);
    if (cx.findTable(ref.to.parts) === table) ref.to.columns = rename(ref.to.columns);
  }
  for (const key of cx.keys) if (cx.findTable(key.table) === table) key.columns = rename(key.columns);
  for (const comment of cx.comments) {
    if (comment.column && sameIdent(comment.column, oldName) && cx.findTable(comment.table) === table) comment.column = newName;
  }
  cx.appliedChanges++;
}

export function alterDropColumn(cx: ConverterContext, parts: readonly string[], column: string, where: Origin): void {
  const table = alterTarget(cx, parts, where, `a column dropped (${column})`);
  if (!table) return;
  const index = table.fields.findIndex((f) => sameIdent(f.name, column));
  if (index < 0) { cx.notApplied(where, `${tableLabel(table)}.${column} dropped, but it has no such column (not applied)`); return; }
  table.fields.splice(index, 1);
  const uses = (columns: readonly string[]): boolean => columns.some((c) => sameIdent(c, column));
  if (table.primaryKey && uses(table.primaryKey)) table.primaryKey = undefined;
  table.uniques = table.uniques.filter((u) => !uses(u));
  if (table.constraintNames) table.constraintNames = table.constraintNames.filter((c) => !uses(c.columns));
  // Its keys go with it.
  removeWhere(cx.refs, (ref) =>
    ((ref.fromTable ?? cx.findTable(ref.from.parts)) === table && uses(ref.from.columns)) ||
    (cx.findTable(ref.to.parts) === table && uses(ref.to.columns)));
  removeWhere(cx.keys, (key) => cx.findTable(key.table) === table && uses(key.columns));
  removeWhere(cx.comments, (c) => c.column !== undefined && sameIdent(c.column, column) && cx.findTable(c.table) === table);
  cx.appliedChanges++;
}

export function renameTable(cx: ConverterContext, parts: readonly string[], target: readonly string[], where: Origin): void {
  const table = alterTarget(cx, parts, where, `a table renamed to ${target.join('.')}`);
  if (!table) return;
  const newName = target[target.length - 1];
  const newSchema = target.length >= 2 ? target[target.length - 2] : table.schema;
  const newParts = [...(newSchema !== null ? [newSchema] : []), newName];
  // What still names it by its old name follows it.
  for (const ref of cx.refs) {
    if (!ref.fromTable && cx.findTable(ref.from.parts) === table) ref.from.parts = [...newParts];
    if (cx.findTable(ref.to.parts) === table) ref.to.parts = [...newParts];
  }
  for (const key of cx.keys) if (cx.findTable(key.table) === table) key.table = [...newParts];
  for (const comment of cx.comments) if (cx.findTable(comment.table) === table) comment.table = [...newParts];
  for (const check of readerState(cx).checks) if (cx.findTable(check.table) === table) check.table = [...newParts];
  for (const p of readerState(cx).partitions) {
    if (cx.findTable(p.child) === table) p.child = [...newParts];
    if (cx.findTable(p.parent) === table) p.parent = [...newParts];
  }
  table.name = newName;
  table.schema = newSchema;
  cx.appliedChanges++;
}

/** A dropped table, and everything still pending that names it. */
export function removeTable(cx: ConverterContext, table: ModelTable): void {
  removeWhere(cx.refs, (ref) => (ref.fromTable ?? cx.findTable(ref.from.parts)) === table || cx.findTable(ref.to.parts) === table);
  removeWhere(cx.keys, (key) => cx.findTable(key.table) === table);
  removeWhere(cx.comments, (c) => cx.findTable(c.table) === table);
  removeWhere(readerState(cx).checks, (c) => cx.findTable(c.table) === table);
  // A dropped child is no one's partition; a dropped parent takes its partitions with it.
  removeWhere(readerState(cx).partitions, (p) => cx.findTable(p.child) === table || cx.findTable(p.parent) === table);
  cx.tables.splice(cx.tables.indexOf(table), 1);
}

// -- schema context ----------------------------------------------------------

/** `name` as the current schema; the dialect's default schema (public, dbo) is no schema. */
function setCurrentSchema(cx: ConverterContext, name: string | undefined): void {
  const fallback = DEFAULT_SCHEMA[cx.dialect];
  cx.currentSchema = name && !(fallback && sameIdent(name, fallback)) ? name : null;
}

/**
 * `USE SCHEMA s`, `USE db.s`, and `USE s` where a database is a schema
 * (MySQL, Databricks); `USE DATABASE | CATALOG` resets it. SQL Server's
 * `USE db` and Snowflake's `USE db` pick a database, not a schema;
 * `USE WAREHOUSE | ROLE` change neither.
 */
export function readUse(cx: ConverterContext, t: Token[]): void {
  const w1 = upper(t[1]);
  if (w1 === 'SCHEMA' || (w1 === 'DATABASE' && cx.dialect === 'databricks')) {
    const name = readName(t, 2);
    if (name) setCurrentSchema(cx, name.parts[name.parts.length - 1]);
    return;
  }
  if (w1 === 'DATABASE' || w1 === 'CATALOG') {
    if (cx.dialect === 'mysql') { const name = readName(t, 2); if (name) setCurrentSchema(cx, name.parts[name.parts.length - 1]); return; }
    cx.currentSchema = null;
    return;
  }
  if (w1 === 'WAREHOUSE' || w1 === 'ROLE' || w1 === 'SECONDARY') return;
  const name = readName(t, 1);
  if (!name) return;
  if (name.parts.length >= 2 && cx.dialect !== 'sqlserver') { setCurrentSchema(cx, name.parts[name.parts.length - 1]); return; }
  if (cx.dialect === 'mysql' || cx.dialect === 'databricks') setCurrentSchema(cx, name.parts[0]);
  else if (cx.dialect === 'snowflake') cx.currentSchema = null;
}

/** `SET [SESSION | LOCAL] search_path TO | = s [, …]`, `SET SCHEMA 's'`, `SET CURRENT SCHEMA s`. */
export function readSetSchema(cx: ConverterContext, t: Token[]): void {
  let i = 1;
  if (upper(t[i]) === 'SESSION' || upper(t[i]) === 'LOCAL') i++;
  const w = upper(t[i]) || (t[i]?.kind === 'ident' ? t[i].value.toUpperCase() : '');
  if (w === 'SEARCH_PATH') {
    i++;
    if (upper(t[i]) === 'TO' || isPunct(t[i], '=')) i++;
    setCurrentSchema(cx, firstSearchPathEntry(t.slice(i).filter((tok) => !isPunct(tok, ',')).map((tok) => tok.value)));
    return;
  }
  if (w === 'CURRENT' && upper(t[i + 1]) === 'SCHEMA') i++;
  if (upper(t[i]) === 'SCHEMA') {
    i++;
    if (isPunct(t[i], '=')) i++;
    const v = t[i];
    if (v && (v.kind === 'string' || isName(v))) setCurrentSchema(cx, v.value || undefined);
  }
}

/** pg_dump's `SELECT pg_catalog.set_config('search_path', 's', false)`. */
export function readSetConfig(cx: ConverterContext, t: Token[]): void {
  const at = t.findIndex((tok) => tok.kind === 'word' && tok.value.toLowerCase() === 'set_config');
  if (at < 0 || !isPunct(t[at + 1], '(') || t[at + 2]?.kind !== 'string' || t[at + 2].value.toLowerCase() !== 'search_path') return;
  const value = t[at + 4];
  if (value?.kind !== 'string') return;
  setCurrentSchema(cx, firstSearchPathEntry(value.value.split(',')));
}

/** The first schema a search path names (`"$user"` aside). */
function firstSearchPathEntry(entries: readonly string[]): string | undefined {
  for (const raw of entries) {
    const e = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!e || e === '$user') continue;
    // `SET search_path TO DEFAULT`: back to the server's path (no schema of its own).
    if (raw.trim().toUpperCase() === 'DEFAULT') return undefined;
    return e;
  }
  return undefined;
}

// -- procedural blocks -------------------------------------------------------

/** `DO [LANGUAGE x] $$ … $$`: the DDL in its body, at its true lines. */
export function readDoBlock(cx: ConverterContext, file: string, text: string, st: Statement, origin: Origin): void {
  const body = st.tokens.find((tok) => tok.kind === 'string');
  const read = body ? readBodyDdl(cx, file, text, body) : { statements: 0, dynamic: 0, unreadable: true };
  if (read.unreadable) {
    cx.ledger.lost('statement', 'proceduralBlock', 'DO block', { file, line: origin.line }, 'not read: its body is not a $$ string');
  }
  if (read.statements === 0) cx.skip(file, read.dynamic ? 'dynamic' : 'block');
}

/**
 * The DDL inside a `$$`-quoted body string token (`DO $$ … $$`, Snowflake's
 * `EXECUTE IMMEDIATE $$ … $$`): the body is tokenized where it stands, so
 * every statement read in it keeps its file offsets and lines.
 */
function readBodyDdl(cx: ConverterContext, file: string, text: string, body: Token): { statements: number; dynamic: number; unreadable?: boolean } {
  const raw = text.slice(body.start, body.end);
  const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(raw);
  if (!tag) return { statements: 0, dynamic: 0, unreadable: true };
  const bodyStart = body.start + tag[0].length;
  const bodyEnd = raw.endsWith(tag[0]) && raw.length >= 2 * tag[0].length ? body.end - tag[0].length : body.end;
  const lineOffset = body.line - 1 + countBreaks(text, body.start, bodyStart);
  const tokens = tokenize(text.slice(bodyStart, bodyEnd), cx.dialect).map((tok) => ({ ...tok, start: tok.start + bodyStart, end: tok.end + bodyStart, line: tok.line + lineOffset }));
  return readEmbeddedDdl(cx, file, text, tokens, 0);
}

function countBreaks(text: string, from: number, to: number): number {
  let n = 0;
  for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) n++;
  return n;
}

/** Words after which a statement may start inside a block. */
const BLOCK_WORDS = new Set(['BEGIN', 'THEN', 'ELSE', 'LOOP', 'DO', 'AS', 'ELSIF', 'ELSEIF']);

/**
 * The schema statements inside a block's tokens (from `from`): each
 * `ALTER TABLE`, `CREATE … TABLE | INDEX | TYPE | DOMAIN`, `COMMENT ON`,
 * `DROP TABLE | INDEX`, `RENAME TABLE` or `EXEC sp_…` that starts a block
 * statement (after `;`, `BEGIN`, `THEN`, `ELSE`, `LOOP`, or a condition's
 * `)`), read up to its `;` (or, without one, the block's `END` / `ELSE` or
 * the next statement on a new line). The IF / THEN wrappers are not
 * statements. A dynamic `EXECUTE '…'` that builds DDL is a ledger loss: it
 * is not run.
 */
export function readEmbeddedDdl(cx: ConverterContext, file: string, text: string, tokens: Token[], from: number): { statements: number; dynamic: number } {
  let statements = 0;
  let dynamic = 0;
  for (let k = from; k < tokens.length; k++) {
    const prev = tokens[k - 1];
    const startsHere = k === from || isPunct(prev, ';') || isPunct(prev, ')') || BLOCK_WORDS.has(upper(prev));
    if (!startsHere) continue;
    const w = upper(tokens[k]);
    if ((w === 'EXECUTE' || w === 'EXEC') && upper(tokens[k + 1]) === 'IMMEDIATE' && tokens[k + 2]?.kind === 'string') {
      const inner = readBodyDdl(cx, file, text, tokens[k + 2]);
      statements += inner.statements;
      if (inner.unreadable) { dynamic++; recordDynamic(cx, file, tokens[k + 2]); }
      continue;
    }
    if ((w === 'EXECUTE' || w === 'EXEC') && (tokens[k + 1]?.kind === 'string' || upper(tokens[k + 1]) === 'FORMAT')) {
      dynamic++;
      recordDynamic(cx, file, tokens[k + 1]);
      continue;
    }
    if (!startsDdl(tokens, k)) continue;
    let end = k;
    let depth = 0;
    for (; end < tokens.length; end++) {
      const tok = tokens[end];
      if (isPunct(tok, '(')) depth++;
      else if (isPunct(tok, ')')) depth--;
      if (depth > 0) continue;
      if (isPunct(tok, ';')) break;
      if (end > k && tok.kind === 'word' && (/^(END|ELSE|ELSIF|ELSEIF)$/.test(upper(tok)) || (isLineStart(text, tok.start) && startsDdl(tokens, end)))) break;
    }
    if (end > k) {
      const stTokens = tokens.slice(k, end);
      readStatement(cx, file, text, { tokens: stTokens, start: stTokens[0].start, end: stTokens[stTokens.length - 1].end, line: stTokens[0].line });
      statements++;
    }
    k = end;
  }
  return { statements, dynamic };
}

/** A dynamic `EXECUTE '…'` whose text builds DDL: reported, not run. */
function recordDynamic(cx: ConverterContext, file: string, tok: Token | undefined): void {
  if (tok?.kind === 'string' && !/\b(ALTER|CREATE|DROP)\s+(TABLE|INDEX|UNIQUE)\b/i.test(tok.value)) return;
  cx.ledger.lost('statement', 'proceduralBlock', 'dynamic DDL', { file, ...(tok ? { line: tok.line } : {}) }, 'not run: EXECUTE builds the statement at run time');
}

/** Whether `t[k]` starts a schema statement the readers read. */
function startsDdl(t: readonly Token[], k: number): boolean {
  const w = upper(t[k]);
  const w1 = upper(t[k + 1]);
  if (w === 'ALTER' || w === 'RENAME') return w1 === 'TABLE';
  if (w === 'COMMENT') return w1 === 'ON';
  if (w === 'DROP') return w1 === 'TABLE' || w1 === 'INDEX';
  if (w === 'EXEC' || w === 'EXECUTE') return t.slice(k + 1, k + 6).some((tok) => /^sp_(rename|addextendedproperty|updateextendedproperty)$/i.test(tok.value));
  if (w !== 'CREATE') return false;
  for (let j = k + 1; j < Math.min(t.length, k + 6); j++) {
    const word = upper(t[j]);
    if (word === 'TABLE' || word === 'INDEX' || word === 'TYPE' || word === 'DOMAIN' || word === 'VIEW') return true;
    if (CREATE_OBJECT_WORDS.has(word) || t[j].kind !== 'word') return false;
  }
  return false;
}

// -- descriptions -----------------------------------------------------------

export function readCommentOn(cx: ConverterContext, st: Statement, origin: Origin): void {
  const t = st.tokens;
  // Snowflake's `COMMENT IF EXISTS ON …`.
  const at = upper(t[1]) === 'IF' && upper(t[2]) === 'EXISTS' && upper(t[3]) === 'ON' ? 4 : 2;
  const object = upper(t[at]);
  if (object !== 'TABLE' && object !== 'COLUMN') { cx.skip(origin.file, 'comment'); return; }
  const name = readName(t, at + 1);
  if (!name || upper(t[name.next]) !== 'IS') { cx.skip(origin.file, 'comment'); return; }
  let v = name.next + 1;
  // E'…' and N'…' read as a word before the string (the lexer has already read E'…''s escapes).
  if ((upper(t[v]) === 'E' || upper(t[v]) === 'N') && t[v + 1]?.kind === 'string') v++;
  const value = t[v];
  // IS NULL (or IS '') clears a comment: an empty text, applied in file order like any other.
  const textValue = value?.kind === 'string' ? value.value : upper(value) === 'NULL' ? '' : undefined;
  if (textValue === undefined) return;
  // A comment on a partition stays the partition's until partitions are resolved (`sqlDdlPartitions.ts`).
  if (object === 'TABLE') cx.comments.push({ table: cx.qualify(name.parts), text: textValue, origin });
  else if (name.parts.length >= 2) cx.comments.push({ table: cx.qualify(name.parts.slice(0, -1)), column: name.parts[name.parts.length - 1], text: textValue, origin });
}

/** One argument of an `EXEC` call `t[from, to)`: a string (`N'…'`), a quoted or bare name, a number; NULL is none. */
function execArgument(t: readonly Token[], from: number, to: number): string | undefined {
  let k = from;
  if (upper(t[k]) === 'N' && t[k + 1]?.kind === 'string') k++;
  const tok = t[k];
  if (!tok || k >= to) return undefined;
  if (tok.kind === 'string' || tok.kind === 'ident' || tok.kind === 'number') return tok.value;
  if (tok.kind === 'word' && upper(tok) !== 'NULL' && upper(tok) !== 'DEFAULT') return tok.value;
  return undefined;
}

/** `EXEC proc arg, @name = arg …`: the arguments by name (positional ones take `positional`'s names in order). */
function execArguments(t: readonly Token[], from: number, positional: readonly string[]): Map<string, string> {
  const args = new Map<string, string>();
  let position = 0;
  for (const [start, end] of splitTopLevel(t as Token[], from, t.length)) {
    let k = start;
    let key = positional[position];
    if (t[k]?.kind === 'word' && t[k].value.startsWith('@') && isPunct(t[k + 1], '=')) { key = t[k].value.toLowerCase(); k += 2; }
    const value = execArgument(t, k, end);
    if (value !== undefined && key) args.set(key, value);
    position++;
  }
  return args;
}

const EXTENDED_PROPERTY_ARGS = ['@name', '@value', '@level0type', '@level0name', '@level1type', '@level1name', '@level2type', '@level2name'];

export function readExec(cx: ConverterContext, text: string, st: Statement, origin: Origin): void {
  const t = st.tokens;
  // Snowflake's EXECUTE IMMEDIATE $$ … $$, and dynamic SQL (EXECUTE '…', EXECUTE format(…)).
  if (upper(t[1]) === 'IMMEDIATE' && t[2]?.kind === 'string') {
    const read = readBodyDdl(cx, origin.file, text, t[2]);
    if (read.unreadable) recordDynamic(cx, origin.file, t[2]);
    if (read.statements === 0) cx.skip(origin.file, 'dynamic');
    return;
  }
  if (t[1]?.kind === 'string' || (upper(t[1]) === 'N' && t[2]?.kind === 'string') || isPunct(t[1], '(')) {
    recordDynamic(cx, origin.file, t[1]?.kind === 'string' ? t[1] : t[2]);
    cx.skip(origin.file, 'dynamic');
    return;
  }
  const proc = readName(t, 1);
  const procName = proc ? proc.parts[proc.parts.length - 1].toLowerCase() : '';
  if (proc && procName === 'sp_rename') { readSpRename(cx, st, proc.next, origin); return; }
  if (!proc || (procName !== 'sp_addextendedproperty' && procName !== 'sp_updateextendedproperty')) { cx.skip(origin.file, 'routine'); return; }
  const args = execArguments(t, proc.next, EXTENDED_PROPERTY_ARGS);
  if ((args.get('@name') ?? '').toLowerCase() !== 'ms_description') { cx.skip(origin.file, 'comment'); return; }
  const value = args.get('@value');
  const level0 = (args.get('@level0type') ?? '').toUpperCase();
  const level1 = (args.get('@level1type') ?? '').toUpperCase();
  const level2 = (args.get('@level2type') ?? '').toUpperCase();
  if (!value || level1 !== 'TABLE' || !args.get('@level1name')) { cx.skip(origin.file, 'comment'); return; }
  const schema = level0 === 'SCHEMA' || level0 === 'USER' ? args.get('@level0name') : undefined;
  const table = schema ? [schema, args.get('@level1name') as string] : cx.qualify([args.get('@level1name') as string]);
  if (level2 === 'COLUMN' && args.get('@level2name')) cx.comments.push({ table, column: args.get('@level2name'), text: value, origin });
  else if (!level2) cx.comments.push({ table, text: value, origin });
  else cx.skip(origin.file, 'comment');
}

/** SQL Server's `EXEC sp_rename 'dbo.t.col', 'new', 'COLUMN'` (a column) or `sp_rename 'dbo.t', 'new'` (a table). */
export function readSpRename(cx: ConverterContext, st: Statement, from: number, origin: Origin): void {
  const args = execArguments(st.tokens, from, ['@objname', '@newname', '@objtype']);
  const objectParts = (args.get('@objname') ?? '').split('.').map((p) => p.trim().replace(/^[[\]"`]+|[[\]"`]+$/g, '')).filter(Boolean);
  const newName = (args.get('@newname') ?? '').trim().replace(/^[[\]"`]+|[[\]"`]+$/g, '');
  const type = (args.get('@objtype') ?? '').toUpperCase();
  if (!newName || objectParts.length === 0) { cx.skip(origin.file, 'routine'); return; }
  if (type === 'COLUMN' && objectParts.length >= 2) {
    renameColumn(cx, objectParts.slice(0, -1), objectParts[objectParts.length - 1], newName, origin);
  } else if (!type || type === 'OBJECT') {
    if (cx.findTable(objectParts)) renameTable(cx, objectParts, [newName], origin);
    else cx.skip(origin.file, 'routine');
  } else {
    cx.skip(origin.file, 'routine');
  }
}

// -- domains, alias types, views, partitions --------------------------------

/** `CREATE DOMAIN name [AS] base [DEFAULT …] [CONSTRAINT c] CHECK (…)`: columns of it keep its name; the ledger names its base. */
function readDomain(cx: ConverterContext, file: string, text: string, st: Statement, at: number): void {
  const t = st.tokens;
  const name = readName(t, at);
  if (!name) { cx.skip(file, 'type'); return; }
  let k = name.next;
  if (upper(t[k]) === 'AS') k++;
  let end = k;
  for (; end < t.length; end++) {
    if (isPunct(t[end], '(')) { const close = matchParen(t, end); if (close < 0) break; end = close; continue; }
    if (DOMAIN_STOP.has(upper(t[end]))) break;
  }
  const base = end > k ? text.slice(t[k].start, t[end - 1].end).replace(/\s+/g, ' ').trim() : '';
  const check = t.slice(end).some((tok) => upper(tok) === 'CHECK');
  const parts = cx.qualify(name.parts);
  readerState(cx).domains.push({ name: parts[parts.length - 1], schema: parts.length >= 2 ? parts[parts.length - 2] : null, kind: 'domain', base, check, origin: { file, line: st.line } });
  cx.skip(file, 'type');
}

const DOMAIN_STOP = new Set(['COLLATE', 'DEFAULT', 'CONSTRAINT', 'NOT', 'NULL', 'CHECK']);

/** SQL Server's `CREATE TYPE name FROM base [NULL | NOT NULL]`. */
function readAliasType(cx: ConverterContext, file: string, text: string, st: Statement, name: { parts: string[]; next: number }): void {
  const t = st.tokens;
  const k = name.next + 1;
  let end = k;
  for (; end < t.length; end++) {
    if (isPunct(t[end], '(')) { const close = matchParen(t, end); if (close < 0) break; end = close; continue; }
    if (upper(t[end]) === 'NOT' || upper(t[end]) === 'NULL') break;
  }
  const base = end > k ? text.slice(t[k].start, t[end - 1].end).replace(/\[([^\]]*)\]/g, '$1').replace(/\s+/g, ' ').trim() : '';
  readerState(cx).domains.push({
    name: name.parts[name.parts.length - 1],
    schema: name.parts.length >= 2 ? name.parts[name.parts.length - 2] : null,
    kind: 'alias type',
    base,
    check: false,
    origin: { file, line: st.line },
  });
  cx.skip(file, 'type');
}

function viewKey(parts: readonly string[]): string {
  return parts.slice(-2).map((p) => p.toLowerCase()).join('.');
}

function rememberView(cx: ConverterContext, parts: readonly string[]): void {
  const views = readerState(cx).views;
  views.add(viewKey(parts));
  views.add(parts[parts.length - 1].toLowerCase());
}

function isView(cx: ConverterContext, parts: readonly string[]): boolean {
  if (cx.findTable(parts)) return false;
  const views = readerState(cx).views;
  return views.has(viewKey(parts)) || (parts.length === 1 && views.has(parts[0].toLowerCase()));
}

/** A child with no columns of its own (no table to rename) renamed: its partition records follow. */
function renamePartitionChild(cx: ConverterContext, parts: readonly string[], target: readonly string[]): boolean {
  if (cx.findTable(parts)) return false;
  const state = readerState(cx);
  const records = state.partitions.filter((p) => p.noColumns && sameParts(p.child, parts, cx));
  if (!records.length) return false;
  const schema = target.length >= 2 ? target[target.length - 2] : parts.length >= 2 ? parts[parts.length - 2] : undefined;
  const renamed = [...(schema !== undefined ? [schema] : []), target[target.length - 1]];
  for (const p of records) p.child = [...renamed];
  // What waits for the end and names it by its old name follows it.
  for (const ref of cx.refs) {
    if (!ref.fromTable && sameParts(ref.from.parts, parts, cx)) ref.from.parts = [...renamed];
    if (sameParts(ref.to.parts, parts, cx)) ref.to.parts = [...renamed];
  }
  for (const key of cx.keys) if (sameParts(key.table, parts, cx)) key.table = [...renamed];
  for (const comment of cx.comments) if (sameParts(comment.table, parts, cx)) comment.table = [...renamed];
  for (const check of state.checks) if (sameParts(check.table, parts, cx)) check.table = [...renamed];
  for (const p of state.partitions) if (sameParts(p.parent, parts, cx)) p.parent = [...renamed];
  cx.appliedChanges++;
  return true;
}

/**
 * The table a change applied now (a column, a rename) goes to: a child with
 * no columns of its own (`PARTITION OF`, `() INHERITS` from one parent) is
 * read as its parent, through every level, when partitions fold. Keys,
 * foreign keys, checks and comments wait for the end instead
 * (`sqlDdlPartitions.ts`), where they are folded or kept with the child.
 */
function foldPartition(cx: ConverterContext, parts: string[]): string[] {
  if (cx.partitionMode === 'tables') return parts;
  const partitions = readerState(cx).partitions;
  let current = parts;
  for (let depth = 0; depth < 32 && !cx.findTable(current); depth++) {
    const records = partitions.filter((x) => x.noColumns && !x.detached && sameParts(x.child, current, cx));
    if (records.length !== 1) break;
    current = [...records[0].parent];
  }
  return current;
}

/**
 * After every file is read, before foreign keys resolve: checks added by
 * ALTER TABLE join their tables, and the ledger counts domains and alias
 * types (by the columns that use them). Partitions were resolved before
 * (`sqlDdlPartitions.ts`, from `applyDeferred`).
 */
export function finishReading(cx: ConverterContext): void {
  const state = readerState(cx);
  for (const check of state.checks) {
    const table = cx.findTable(check.table);
    if (!table) { cx.notApplied(check.origin, `a check on ${check.table.slice(-2).join('.')}, which is not in the files (not applied)`); continue; }
    if (table.checks.some((c) => c.expression === check.expression)) continue;
    table.checks.push({ expression: check.expression, ...(check.name ? { name: check.name } : {}) });
  }
  state.checks.length = 0;
  for (const d of state.domains) {
    for (const table of cx.tables) {
      for (const f of table.fields) {
        const parts = f.type.split('.');
        const last = parts[parts.length - 1].replace(/\(.*$/, '');
        if (!sameIdent(last, d.name)) continue;
        if (parts.length >= 2 && d.schema !== null && !sameSchema(parts[parts.length - 2], d.schema, cx.dialect)) continue;
        const detail = `kept by name; based on ${d.base || 'another type'}${d.check ? ', its CHECK not imported' : ''}`;
        cx.ledger.changed('column', 'noField', `${d.kind} ${d.name}`, { file: table.origin.file, line: table.origin.line, table: tableLabel(table), column: f.name }, detail);
      }
    }
  }
}

// -- words -----------------------------------------------------------------

/** Words that start an ALTER TABLE action: a list item starting with one is not another column. */
export const ALTER_ACTION_WORDS = new Set([
  'ADD', 'DROP', 'ALTER', 'MODIFY', 'CHANGE', 'RENAME', 'SET', 'RESET', 'OWNER', 'ENABLE', 'DISABLE', 'VALIDATE', 'CLUSTER',
  'INHERIT', 'NO', 'OF', 'NOT', 'REPLICA', 'FORCE', 'ATTACH', 'DETACH', 'WITH', 'CHECK', 'NOCHECK', 'ALGORITHM', 'LOCK',
  'ENGINE', 'AUTO_INCREMENT', 'CONVERT', 'DEFAULT', 'CHARACTER', 'COMMENT', 'ORDER', 'PARTITION', 'REMOVE', 'TRUNCATE',
  'COALESCE', 'REORGANIZE', 'EXCHANGE', 'ANALYZE', 'OPTIMIZE', 'REBUILD', 'REPAIR', 'SWAP', 'UNSET', 'SUSPEND', 'RESUME',
  'RECLUSTER', 'CLUSTERING', 'SWITCH', 'TRIGGER', 'CONSTRAINT', 'FOREIGN', 'PRIMARY', 'UNIQUE',
]);

/** After ADD: what is added when it is not a column. */
export const ADD_NOT_COLUMN_WORDS = new Set([
  'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'INDEX', 'KEY', 'FULLTEXT', 'SPATIAL', 'PARTITION', 'PERIOD',
  'DEFAULT', 'ROW', 'ROWS', 'EXCLUDE', 'TABLE', 'CLUSTERING', 'SEARCH', 'TAG', 'MASKING',
]);

/** After DROP: what is dropped when it is not a column. */
export const DROP_NOT_COLUMN_WORDS = new Set([
  'CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'INDEX', 'KEY', 'DEFAULT', 'PARTITION', 'PERIOD', 'SYSTEM',
  'NOT', 'IDENTITY', 'EXPRESSION', 'CLUSTERING', 'ROW', 'ROWS', 'SEARCH', 'TAG', 'MASKING', 'FULLTEXT', 'SPATIAL',
]);

/** `[from, to)` without MySQL's trailing `FIRST` / `AFTER col` (where a column goes, not what it is). */
export function withoutColumnPosition(tokens: Token[], from: number, to: number): number {
  if (to - 2 > from && upper(tokens[to - 2]) === 'AFTER' && isName(tokens[to - 1])) return to - 2;
  if (to - 1 > from && upper(tokens[to - 1]) === 'FIRST') return to - 1;
  return to;
}
