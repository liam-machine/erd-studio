/**
 * The SQL DDL converter's column reading: a parsed column (`RawSqlField`)
 * to the model's field. What the file wrote wins over what a grammar hands
 * back: the type is the column's own text (from after its name to its first
 * constraint word, `timestamp with time zone`, `int unsigned`,
 * `public.vector(20)`, `nvarchar(max)`), and so are its comment, its string
 * default and a generated or computed column's expression. The grammar's
 * type name is used only where there is no source span, and for an inline
 * MySQL `ENUM(…)` (the grammar's enum keeps its values).
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import { isDoubleQuotedComment, isName, isPunct, matchParen, splitTopLevel, upper, type Token } from './sqlDdlLexer';
import type { ColumnSource, ModelField, PreparedSql, RawSqlField } from './sqlDdlModel';
import { cleanTypeText, columnTypeSpan, isConstraintItem, strayTypeToken } from './sqlDdlRepair';

/** The note a SQL Server computed column gets (its type is `computed`), like Power BI's calculated columns. */
export const COMPUTED_COLUMN_NOTE = 'Computed column; its expression was not imported.';

/**
 * One parsed column as the model keeps it: the type as the file wrote it
 * (or the type a rewrite set aside, restored), identity, keys, `NOT NULL`,
 * checks, its comment and its default (`DEFAULT NULL` is no default).
 */
export function toField(rf: RawSqlField, prepared: PreparedSql, text: string, source?: ColumnSource): ModelField {
  const parsedType = rf.type?.type_name ?? '';
  let increment = !!rf.increment || prepared.identity.has(rf.name.toLowerCase());
  // SQL Server's grammar leaves `IDENTITY(1,1)` in the type text.
  let parsed = parsedType;
  const identity = /\s+IDENTITY\s*(\([^)]*\))?\s*$/i.exec(parsed);
  if (identity) { parsed = parsed.slice(0, identity.index); increment = true; }
  const restored = prepared.types.get(parsedType);
  const asWritten = source?.typeEnd !== undefined && source.typeEnd > source.typeOffset
    ? typeAsWritten(text.slice(source.typeOffset, source.typeEnd))
    : undefined;
  let type: string;
  if (restored !== undefined) type = restored;
  else if (asWritten && !grammarTypeWins(asWritten, parsed)) type = asWritten;
  else {
    type = (source ? spacedAsWritten(parsed, text, source.typeOffset) : parsed).replace(/\s+/g, ' ').trim();
    if (rf.type?.schemaName && !type.toLowerCase().startsWith(`${rf.type.schemaName.toLowerCase()}.`)) type = `${rf.type.schemaName}.${type}`;
  }
  const field: ModelField = {
    name: rf.name,
    type: type || 'unknown',
    pk: !!rf.pk,
    unique: !!rf.unique,
    notNull: !!rf.not_null,
    increment,
    checks: (rf.checks ?? []).map((c) => c.expression ?? '').filter(Boolean),
  };
  if (source?.computed) {
    // SQL Server: `name AS <expr> [PERSISTED]` has no type of its own.
    field.computed = { expression: expressionText(text.slice(source.computed.start, source.computed.end)), persisted: source.computed.persisted };
    field.type = 'computed';
    // SQL Server makes `ISNULL(expr, <constant>)` NOT NULL (its documented way to a non-nullable computed column).
    if (isNullWithConstant(field.computed.expression)) field.notNull = true;
  } else if (source?.generated) {
    field.generated = {
      expression: expressionText(text.slice(source.generated.start, source.generated.end)),
      ...(source.generated.kind ? { kind: source.generated.kind } : {}),
    };
  }
  if (asWritten && asWritten !== field.type && field.type !== 'computed') field.typeAsWritten = asWritten;
  // The grammars hand string literals back unevenly ('' and \' left in, or half-read): the tokenizer's reading wins.
  const note = source?.comment ?? prepared.comments.get(rf.name.toLowerCase()) ?? noteText(rf.note);
  if (note) field.note = note;
  else if (field.computed) field.note = COMPUTED_COLUMN_NOTE;
  const dflt = rf.dbdefault;
  if (dflt && dflt.value !== undefined && dflt.value !== null) {
    const kind = dflt.type === 'number' || dflt.type === 'string' || dflt.type === 'boolean' || dflt.type === 'expression' ? dflt.type : 'expression';
    // `DEFAULT NULL` is what a column without a default means: nothing to write.
    const isNull = kind !== 'string' && /^\(*\s*null\s*\)*$/i.test(String(dflt.value));
    if (!isNull) {
      if (kind === 'string' && source?.stringDefault !== undefined) field.default = { type: kind, value: source.stringDefault };
      else field.default = { type: kind, value: String(dflt.value) };
    }
  }
  if (source?.modifiers?.length) field.modifiers = [...source.modifiers];
  if (source?.constraints?.length) field.constraints = source.constraints.map((c) => ({ ...c }));
  return field;
}

/** A type's source text as the model keeps it: comments out, whitespace collapsed, SQL Server's brackets off its names. */
export function typeAsWritten(raw: string): string {
  return cleanTypeText(raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '));
}

/**
 * Whether the grammar's type name is kept over the text: an inline MySQL
 * `ENUM(…)` the grammar made an enum of (`film_rating_enum`), so the Enum
 * block it wrote stays in use and Import keeps the values on the column.
 */
function grammarTypeWins(asWritten: string, parsed: string): boolean {
  return /^enum\s*\(/i.test(asWritten) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed) && !/^enum$/i.test(parsed);
}

/**
 * `ISNULL(expr, <constant>)` (in brackets or not): SQL Server reads a
 * computed column of it as NOT NULL (sys.columns.is_nullable = 0) when the
 * constant is a number, or a string and `expr` is a string too (it starts
 * with a string literal: `ISNULL('AW' + …, '')`). A string constant for a
 * number (`ISNULL(n, 'x')`) is nullable, so it is not read as NOT NULL;
 * neither is anything else, which SQL Server mostly reads as nullable.
 * Checked on SQL Server 2025 (docs/dev/real-world-truth.md).
 */
export function isNullWithConstant(expression: string): boolean {
  let e = expression.trim();
  const wraps = (x: string): boolean => {
    if (!x.startsWith('(') || !x.endsWith(')')) return false;
    return closingOf(x, 0) === x.length - 1;
  };
  while (wraps(e)) e = e.slice(1, -1).trim();
  const head = /^ISNULL\s*\(/i.exec(e);
  if (!head) return false;
  const open = head[0].length - 1;
  if (closingOf(e, open) !== e.length - 1) return false;
  const args = topLevelArgs(e.slice(open + 1, -1));
  if (args.length !== 2) return false;
  let constant = args[1].trim();
  while (wraps(constant)) constant = constant.slice(1, -1).trim();
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(constant)) return true;
  return /^N?'(?:[^']|'')*'$/i.test(constant) && /^\(*\s*N?'/i.test(args[0].trim());
}

/** The index of the bracket closing the one at `open` (quotes skipped), or -1. */
function closingOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** `s` split on its top-level commas (quotes and brackets respected). */
function topLevelArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") { i++; while (i < s.length && !(s[i] === "'" && s[i + 1] !== "'")) i += s[i] === "'" ? 2 : 1; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/** An expression's text, one line. */
function expressionText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Each column definition's type span, comment, string default, expressions, modifiers and named constraints, by lower-cased name. */
export function readColumnSources(tokens: Token[], open: number, close: number, angles: boolean): Map<string, ColumnSource> {
  const sources = new Map<string, ColumnSource>();
  for (const [from, to] of splitTopLevel(tokens, open + 1, close, angles)) {
    if (to <= from + 1 || !isName(tokens[from]) || isConstraintItem(tokens, from, to)) continue;
    sources.set(tokens[from].value.toLowerCase(), readColumnSource(tokens, from, to));
  }
  return sources;
}

/** One column definition `tokens[from, to)` (its name first). */
export function readColumnSource(tokens: Token[], from: number, to: number): ColumnSource {
  const span = columnTypeSpan(tokens, from, to);
  const source: ColumnSource = { typeOffset: tokens[from + 1]?.start ?? tokens[from].end };
  if (span.end > span.start) {
    // The type as written ends at a word no type has there: with a comma missing (`nvarchar(50)⏎ Year int`), the next
    // column's name and type are not this one's type, even when a forgiving grammar read them as their own column.
    const stray = strayTypeToken(tokens, span.start, span.end);
    source.typeEnd = tokens[(stray > span.start ? stray : span.end) - 1].end;
  }
  const modifiers: string[] = [];
  const constraints: NonNullable<ColumnSource['constraints']> = [];
  const modifier = (phrase: string): void => { if (!modifiers.includes(phrase)) modifiers.push(phrase); };
  for (let k = span.end; k < to; k++) {
    const tok = tokens[k];
    if (isPunct(tok, '(')) { const end = matchParen(tokens, k); if (end < 0 || end >= to) break; k = end; continue; }
    const word = upper(tok);
    if (!word) continue;
    if (word === 'COMMENT') {
      const value = isPunct(tokens[k + 1], '=') ? tokens[k + 2] : tokens[k + 1];
      if (value?.kind === 'string' || isDoubleQuotedComment(value)) source.comment = value.value;
    } else if (word === 'DEFAULT') {
      let v = k + 1;
      while (isPunct(tokens[v], '(')) v++;
      if (upper(tokens[v]) === 'N' && tokens[v + 1]?.kind === 'string') v++;
      if (tokens[v]?.kind === 'string') source.stringDefault = tokens[v].value;
    } else if (word === 'GENERATED' || (word === 'AS' && isPunct(tokens[k + 1], '(') && span.end > span.start)) {
      // GENERATED { ALWAYS | BY DEFAULT } AS ( expr ) [STORED | VIRTUAL]; MySQL's `type AS (expr)`. `AS IDENTITY` and `AS ROW START` are not expressions.
      let a = k;
      if (word === 'GENERATED') { a = k + 1; while (a < to && upper(tokens[a]) !== 'AS') a++; }
      if (!isPunct(tokens[a + 1], '(')) continue;
      const end = matchParen(tokens, a + 1);
      if (end < 0 || end >= to) continue;
      const after = upper(tokens[end + 1]);
      const kind = after === 'STORED' || after === 'PERSISTENT' ? 'stored' : after === 'VIRTUAL' ? 'virtual' : undefined;
      if (end > a + 2) source.generated = { start: tokens[a + 2].start, end: tokens[end - 1].end, ...(kind ? { kind } : {}) };
      k = end;
    } else if (word === 'AS' && span.end === span.start && k === from + 1) {
      // SQL Server: `name AS <expr> [PERSISTED] [NOT NULL]` — a computed column.
      let end = to;
      let persisted = false;
      let depth = 0;
      for (let e = k + 1; e < to; e++) {
        if (isPunct(tokens[e], '(')) depth++;
        else if (isPunct(tokens[e], ')')) depth--;
        else if (depth === 0 && COMPUTED_TAIL.has(upper(tokens[e]))) { end = e; break; }
      }
      for (let e = end; e < to; e++) if (upper(tokens[e]) === 'PERSISTED') persisted = true;
      if (end > k + 1) source.computed = { start: tokens[k + 1].start, end: tokens[end - 1].end, persisted };
      break;
    } else if (word === 'ON' && upper(tokens[k + 1]) === 'UPDATE' && !isPreceededByReferences(tokens, from, k)) {
      modifier('ON UPDATE');
      k++;
    } else if (word === 'COLLATE') {
      modifier('COLLATE');
      k++;
    } else if ((word === 'CHARACTER' && upper(tokens[k + 1]) === 'SET') || word === 'CHARSET') {
      modifier('CHARACTER SET');
      k += word === 'CHARSET' ? 1 : 2;
    } else if (word === 'IDENTITY' && isPunct(tokens[k + 1], '(')) {
      const end = matchParen(tokens, k + 1);
      const args = tokens.slice(k + 2, end < 0 ? k + 2 : end).filter((t) => t.kind === 'number').map((t) => t.value);
      if (args.some((a) => a !== '1')) modifier('IDENTITY seed');
      if (end > 0) k = end;
    } else if (word === 'NOT' && upper(tokens[k + 1]) === 'FOR' && upper(tokens[k + 2]) === 'REPLICATION') {
      modifier('NOT FOR REPLICATION');
      k += 2;
    } else if (MODIFIER_WORDS[word]) {
      modifier(MODIFIER_WORDS[word]);
    } else if (word === 'CONSTRAINT' && isName(tokens[k + 1])) {
      const kind = constraintKind(tokens, k + 2);
      if (kind) constraints.push({ name: tokens[k + 1].value, kind });
      k++;
    }
  }
  if (modifiers.length) source.modifiers = modifiers;
  if (constraints.length) source.constraints = constraints;
  return source;
}

/** The kind of the constraint whose keyword is at `k` (`PRIMARY KEY`, `UNIQUE`, `REFERENCES`, `FOREIGN KEY`, `CHECK`). */
export function constraintKind(tokens: readonly Token[], k: number): 'pk' | 'unique' | 'fk' | 'check' | undefined {
  const w = upper(tokens[k]);
  if (w === 'PRIMARY') return 'pk';
  if (w === 'UNIQUE') return 'unique';
  if (w === 'REFERENCES' || w === 'FOREIGN') return 'fk';
  if (w === 'CHECK') return 'check';
  return undefined;
}

/** Whether the `ON` at `k` belongs to a `REFERENCES … ON UPDATE` (an FK action, not MySQL's `ON UPDATE CURRENT_TIMESTAMP`). */
function isPreceededByReferences(tokens: readonly Token[], from: number, k: number): boolean {
  for (let j = k - 1; j > from; j--) if (upper(tokens[j]) === 'REFERENCES') return true;
  return false;
}

/** Words that end a SQL Server computed column's expression. */
const COMPUTED_TAIL = new Set(['PERSISTED', 'NOT', 'NULL', 'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'REFERENCES', 'FOREIGN']);

/** Column modifier words DBML has no field for, and the phrase the ledger counts each by. */
const MODIFIER_WORDS: Readonly<Record<string, string>> = {
  ROWGUIDCOL: 'ROWGUIDCOL',
  SPARSE: 'SPARSE',
  FILESTREAM: 'FILESTREAM',
  INVISIBLE: 'INVISIBLE',
  MASK: 'MASK',
  MASKED: 'MASK',
  MASKING: 'MASK',
  NONCLUSTERED: 'NONCLUSTERED',
  SRID: 'SRID',
  ENCRYPTED: 'ENCRYPTED',
  COMPRESSION: 'COMPRESSION',
};

/**
 * The parser's type text with the spaces the file wrote: the grammars join a
 * type's words (`DOUBLE PRECISION` comes back as `DOUBLEPRECISION`). Reads
 * the file from the column's type on, matching the parsed text character by
 * character with whitespace ignored; anything else (a bracketed SQL Server
 * type, say) keeps the parsed text. Used only when there is no source span.
 */
export function spacedAsWritten(parsed: string, text: string, offset: number): string {
  const compact = parsed.replace(/\s+/g, '');
  if (!compact) return parsed;
  let out = '';
  let j = 0;
  for (let i = offset; i < text.length && j < compact.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (out && !out.endsWith(' ')) out += ' '; continue; }
    if (ch.toLowerCase() !== compact[j].toLowerCase()) return parsed;
    out += ch;
    j++;
  }
  return j === compact.length ? out.trim() : parsed;
}

/** Words that start a table constraint inside a column list (a column named like one is told apart by `isConstraintItem`). */
export const TABLE_CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'EXCLUDE', 'LIKE']);

/** Words that end a Spark column's type and start its constraints. */
export const COLUMN_CONSTRAINT_WORDS = new Set(['NOT', 'NULL', 'DEFAULT', 'GENERATED', 'COMMENT', 'PRIMARY', 'CONSTRAINT', 'REFERENCES', 'UNIQUE', 'CHECK', 'MASK', 'COLLATE']);

export function noteText(note: RawSqlField['note']): string | undefined {
  if (typeof note === 'string') return note || undefined;
  if (note && typeof note === 'object' && typeof note.value === 'string') return note.value || undefined;
  return undefined;
}
