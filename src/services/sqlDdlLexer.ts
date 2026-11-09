/**
 * The SQL DDL converter's lexer: a tokenizer that knows strings, quoted
 * names, comments and `$$` bodies per dialect, the statement splitter (`;`,
 * a SQL Server `GO` line, or a new statement keyword at the start of a line
 * ends one), and the token helpers every reader shares.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import type { SqlDialect } from './sqlDdlModel';

export type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct';

export interface Token {
  kind: TokenKind;
  /** A word as written; a quoted identifier or string without its quotes. */
  value: string;
  start: number;
  end: number;
  /** 1-based line of the token's first character. */
  line: number;
  /** A quoted identifier's opening quote. */
  quote?: '"' | '`' | '[';
  /**
   * Inside a MySQL `DELIMITER` block (`DELIMITER ;;` … `DELIMITER ;`): a `;`
   * here does not end the statement, and neither does a keyword at the start
   * of a line; only the block's own delimiter does (read as a `;` without
   * this flag).
   */
  delimited?: boolean;
}

export interface Statement {
  tokens: Token[];
  start: number;
  end: number;
  line: number;
}

/** Dialects whose '…' strings take backslash escapes (`'it\'s'`). */
export const BACKSLASH_ESCAPES: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['mysql', 'databricks', 'snowflake']);

/** Words that start a statement when they open a line outside any parentheses. */
export const STATEMENT_KEYWORDS: ReadonlySet<string> = new Set(['CREATE', 'ALTER', 'DROP', 'INSERT', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'USE', 'TRUNCATE']);

/** A MySQL client `DELIMITER x` line: `x` is one to four punctuation characters (`;;`, `//`, `$$`, `|`, `;`). */
const DELIMITER_LINE = /^[ \t]*DELIMITER[ \t]+([^\sA-Za-z0-9_(),'"`]{1,4})[ \t]*(?:--[^\n]*)?\r?$/i;

/**
 * The text's tokens. Strings, quoted names, comments and `$$` bodies are one
 * token each (or none, for a comment); one left open at the end of the text
 * runs only to the end of its line, so a stray quote spoils one statement,
 * not the rest of the file. MySQL also reads `/*!NNNNN … *\/` versioned
 * comments as code (mysqldump writes columns and keys in them) and the
 * client's `DELIMITER` blocks (see {@link Token.delimited}).
 */
export function tokenize(text: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const nonStandardAt = nonStandardStrings(text, dialect);
  const mysql = dialect === 'mysql';
  /** The statement delimiter a MySQL `DELIMITER` line set; ';' outside a block. */
  let delimiter = ';';
  /** Open `/*!` versioned comments (MySQL), read as code. */
  let versioned = 0;
  const advanceLines = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) line++;
  };
  const lineEnd = (from: number): number => {
    const eol = text.indexOf('\n', from);
    return eol < 0 ? n : eol;
  };
  const push = (token: Token): void => {
    if (delimiter !== ';') token.delimited = true;
    tokens.push(token);
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    // Every Unicode space (a no-break space pasted from a web page, an ideographic space) is a space.
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || (c > '\u007f' && /\s/.test(c))) { i++; continue; }
    // A MySQL DELIMITER line: ends the statement before it, and sets what ends the next ones.
    if ((c === 'D' || c === 'd') && isLineStart(text, i)) {
      const m = DELIMITER_LINE.exec(text.slice(i, lineEnd(i)));
      if (m && /^delimiter\b/i.test(text.slice(i, i + 10))) {
        tokens.push({ kind: 'punct', value: ';', start: i, end: i, line });
        delimiter = m[1];
        i = lineEnd(i);
        continue;
      }
    }
    if (delimiter !== ';' && text.startsWith(delimiter, i)) {
      tokens.push({ kind: 'punct', value: ';', start: i, end: i + delimiter.length, line });
      i += delimiter.length;
      continue;
    }
    // Comments (MySQL's versioned `/*!NNNNN … */` are code).
    if (c === '-' && text[i + 1] === '-') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '#' && mysql) { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      if (mysql && (text[i + 2] === '!' || (text[i + 2] === 'M' && text[i + 3] === '!'))) {
        i += text[i + 2] === '!' ? 3 : 4;
        while (i < n && text[i] >= '0' && text[i] <= '9') i++;
        versioned++;
        continue;
      }
      const close = text.indexOf('*/', i + 2);
      const stop = close < 0 ? lineEnd(i) : close + 2;
      advanceLines(i, stop);
      i = stop;
      continue;
    }
    if (versioned > 0 && c === '*' && text[i + 1] === '/') { versioned--; i += 2; continue; }
    const start = i;
    const startLine = line;
    // Strings: '…' (and N'…' / E'…' prefixes, read as words followed by a string).
    if (c === "'") {
      let value = '';
      let closed = false;
      // PostgreSQL's E'…' (escape string) reads backslash escapes in every dialect's file: `E'it\'s'`.
      const escapes = BACKSLASH_ESCAPES.has(dialect) || isEscapeStringPrefix(text, i) || nonStandardAt(i);
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\' && escapes && i + 1 < n) { value += unescapeChar(text[i + 1]); i += 2; continue; }
        if (ch === "'") {
          if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) {
        // Open at the end of the text: only to the end of its line.
        i = lineEnd(start);
        value = text.slice(start + 1, i);
      }
      advanceLines(start, i);
      push({ kind: 'string', value, start, end: i, line: startLine });
      continue;
    }
    // Dollar-quoted bodies ($$ … $$, $tag$ … $tag$): one string token.
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const stop = close < 0 ? lineEnd(i) : close + tag[0].length;
        advanceLines(i, stop);
        push({ kind: 'string', value: text.slice(i + tag[0].length, close < 0 ? stop : close), start, end: stop, line: startLine });
        i = stop;
        continue;
      }
    }
    // Quoted identifiers.
    if (c === '"' || c === '`' || c === '[') {
      const closeChar = c === '[' ? ']' : c;
      let value = '';
      let closed = false;
      // MySQL's and Spark's "…" is a string, with the same backslash escapes as '…' (`"the \"id\""`).
      const escapes = c === '"' && DOUBLE_QUOTED_STRINGS.has(dialect);
      i++;
      while (i < n) {
        if (escapes && text[i] === '\\' && i + 1 < n) { value += unescapeChar(text[i + 1]); i += 2; continue; }
        if (text[i] === closeChar) {
          if (text[i + 1] === closeChar) { value += closeChar; i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        value += text[i];
        i++;
      }
      if (!closed) {
        i = lineEnd(start);
        value = text.slice(start + 1, i);
      }
      advanceLines(start, i);
      push({ kind: 'ident', value, start, end: i, line: startLine, quote: c });
      continue;
    }
    if (/[A-Za-z_]/.test(c) || (c > '\u007f' && !/\s/.test(c))) {
      // A block's delimiter ends a word (`END$$`, `END//`); so does any Unicode space.
      while (i < n && (/[A-Za-z0-9_$@#]/.test(text[i]) || (text[i] > '\u007f' && !/\s/.test(text[i]))) && !(delimiter !== ';' && text.startsWith(delimiter, i))) i++;
      push({ kind: 'word', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (c === '@') {
      i++;
      while (i < n && /[A-Za-z0-9_@$#]/.test(text[i])) i++;
      push({ kind: 'word', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      while (i < n && /[0-9.eE]/.test(text[i])) i++;
      push({ kind: 'number', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (c === ':' && text[i + 1] === ':') {
      push({ kind: 'punct', value: '::', start, end: i + 2, line: startLine });
      i += 2;
      continue;
    }
    push({ kind: 'punct', value: c, start, end: i + 1, line: startLine });
    i++;
  }
  return tokens;
}

/** Dialects whose "…" is a string (not a name), read with backslash escapes. */
const DOUBLE_QUOTED_STRINGS: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['mysql', 'databricks']);

/** `SET standard_conforming_strings = off` (older pg_dump output), and back `on`. */
const STANDARD_STRINGS = /^[ \t]*SET\s+(?:SESSION\s+)?standard_conforming_strings\s*(?:=|TO)\s*'?(on|off|true|false)'?/gim;

/**
 * Whether a '…' string at an offset reads backslash escapes because the
 * script turned PostgreSQL's `standard_conforming_strings` off before it
 * (pg_dump before 9.1 writes `'it\'s'` then). Always false when it never does.
 */
export function nonStandardStrings(text: string, dialect: SqlDialect): (offset: number) => boolean {
  if (dialect !== 'postgres' || !/standard_conforming_strings/i.test(text)) return () => false;
  const toggles: Array<[at: number, off: boolean]> = [];
  STANDARD_STRINGS.lastIndex = 0;
  for (let m = STANDARD_STRINGS.exec(text); m; m = STANDARD_STRINGS.exec(text)) toggles.push([m.index, /^(off|false)$/i.test(m[1])]);
  if (!toggles.some(([, off]) => off)) return () => false;
  return (offset) => {
    let off = false;
    for (const [at, value] of toggles) { if (at > offset) break; off = value; }
    return off;
  };
}

/**
 * Whether the `'` at `quote` opens a PostgreSQL escape string: `E'…'` (or
 * `e'…'`), the E a word of its own (not the end of a name such as `type'`).
 */
export function isEscapeStringPrefix(text: string, quote: number): boolean {
  const e = text[quote - 1];
  if (e !== 'E' && e !== 'e') return false;
  return quote < 2 || !/[A-Za-z0-9_$@#\u0080-\uffff]/.test(text[quote - 2]);
}

function unescapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '';
    default: return ch;
  }
}

/**
 * MySQL's versioned comments as code: each `/*!NNNNN` (or MariaDB's `/*M!`)
 * and its `*\/` become spaces, so the grammar reads what mysqldump wrote in
 * them (`/*!50705 location GEOMETRY *\/`). Strings, quoted names and other
 * comments are left alone; the text keeps its length and line breaks.
 */
export function uncommentVersioned(text: string): string {
  if (!text.includes('/*!') && !text.includes('/*M!')) return text;
  const out = text.split('');
  const n = text.length;
  let open = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      for (i++; i < n; i++) {
        if (text[i] === '\\' && c !== '`') { i++; continue; }
        if (text[i] === c) { if (text[i + 1] === c) { i++; continue; } break; }
        if (text[i] === '\n' && c !== "'") break;
      }
      i++;
      continue;
    }
    if ((c === '-' && text[i + 1] === '-') || c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const bang = text[i + 2] === '!' ? 3 : text[i + 2] === 'M' && text[i + 3] === '!' ? 4 : 0;
      if (bang) {
        let j = i + bang;
        while (j < n && text[j] >= '0' && text[j] <= '9') j++;
        for (let k = i; k < j; k++) out[k] = ' ';
        open++;
        i = j;
        continue;
      }
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (open > 0 && c === '*' && text[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; open--; i += 2; continue; }
    i++;
  }
  return out.join('');
}

/** SQL Server's batch separator: `GO` (optionally a count) alone on its line. */
export const GO_LINE = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*;?[ \t\r]*$/i;

/**
 * The text's statements: `;` (outside parentheses), a SQL Server `GO` line,
 * a MySQL `DELIMITER` block's own delimiter, or a statement keyword at the
 * start of a line ends one. Unbalanced parentheses spoil one statement only:
 * a `;` inside them still ends it when the next line starts a statement, and
 * so does a line that starts `CREATE … TABLE | VIEW | …` or `ALTER TABLE`.
 */
export function splitStatements(text: string, dialect: SqlDialect): Statement[] {
  const tokens = tokenize(text, dialect);
  const goLines = new Set<number>();
  if (dialect === 'sqlserver') {
    text.split('\n').forEach((lineText, index) => { if (GO_LINE.test(lineText)) goLines.add(index + 1); });
  }
  const statements: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;
  const flush = (): void => {
    if (current.length) {
      statements.push({ tokens: current, start: current[0].start, end: current[current.length - 1].end, line: current[0].line });
    }
    current = [];
    depth = 0;
  };
  let lastLine = 0;
  /** A `;` met inside unbalanced parentheses: the statement ends if the next line starts one. */
  let openSemicolon = false;
  /**
   * The statement is a routine (CREATE PROCEDURE | FUNCTION | TRIGGER | EVENT):
   * its body's `;`s and line-start keywords do not end it. SQL Server: it runs
   * to its batch's GO; elsewhere to the `;` after its last `END` (BEGIN and
   * CASE open a block, END closes one; `END IF` / `END LOOP` close blocks never
   * counted).
   */
  let routine = false;
  let blocks = 0;
  const toBatchEnd = dialect === 'sqlserver' && goLines.size > 0;
  const baseFlush = flush;
  const flushAll = (): void => { baseFlush(); routine = false; blocks = 0; };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (goLines.has(token.line) && token.kind === 'word' && /^GO$/i.test(token.value) && !token.delimited) { flushAll(); continue; }
    if (goLines.has(token.line) && token.kind === 'number' && current.length === 0) continue;
    if (!routine && current.length > 0 && current.length < 12 && token.kind === 'word' && ROUTINE_WORDS.has(upper(token)) && upper(current[0]) === 'CREATE'
      && current.every((t) => t.kind === 'word' || isPunct(t, '=') || isPunct(t, '@') || t.kind === 'ident' || t.kind === 'string')) {
      routine = true;
    }
    if (routine && !token.delimited && token.kind === 'word') {
      const w = upper(token);
      const next = upper(tokens[index + 1]);
      if ((w === 'BEGIN' && !/^(TRANSACTION|TRAN|WORK|DISTRIBUTED)$/.test(next)) || w === 'CASE') blocks++;
      else if (w === 'END' && !/^(IF|LOOP|WHILE|REPEAT|FOR)$/.test(next) && blocks > 0) blocks--;
    }
    const inBody = routine && (toBatchEnd || blocks > 0);
    if (token.kind === 'punct' && token.value === ';' && !token.delimited && !inBody) {
      if (depth <= 0) { flushAll(); lastLine = token.line; openSemicolon = false; continue; }
      openSemicolon = true;
    }
    // Mid-line, a CREATE ends the CREATE before it when nothing else can follow there: after a
    // CREATE TABLE's closing parenthesis (a missing `;`), or inside `CREATE SCHEMA s CREATE TABLE …`
    // (PostgreSQL's and SQL Server's schema elements).
    if (current.length > 1 && depth <= 0 && !inBody && !routine && upper(token) === 'CREATE' && upper(current[0]) === 'CREATE'
      && (isPunct(current[current.length - 1], ')') || upper(current[1]) === 'SCHEMA') && startsDefinition(tokens, index)) {
      flushAll();
    }
    const startsLine = token.line !== lastLine && token.kind === 'word' && !token.delimited && !inBody && isLineStart(text, token.start);
    if (current.length && startsLine) {
      // `COMMENT ON` opens a statement too (a table option is `COMMENT [=] '…'`, never `COMMENT ON`).
      const keyword = STATEMENT_KEYWORDS.has(token.value.toUpperCase()) || (upper(token) === 'COMMENT' && upper(tokens[index + 1]) === 'ON');
      if ((depth <= 0 && keyword) || (depth > 0 && ((openSemicolon && keyword) || startsDefinition(tokens, index)))) flushAll();
    }
    if (token.kind === 'punct' && token.value === '(') depth++;
    if (token.kind === 'punct' && token.value === ')') depth--;
    if (!(token.kind === 'punct' && token.value === ';' && token.start === token.end)) current.push(token);
    if (!(token.kind === 'punct' && token.value === ';')) openSemicolon = openSemicolon && depth > 0;
    lastLine = token.line;
  }
  flushAll();
  return statements;
}

/** Words after CREATE [OR REPLACE | DEFINER = …] that make the statement a routine with a body. */
const ROUTINE_WORDS = new Set(['PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'EVENT']);

/** Whether `tokens[i]` starts `CREATE [modifiers] <object>` or `ALTER TABLE` (a statement, wherever the parentheses stand). */
function startsDefinition(tokens: readonly Token[], i: number): boolean {
  const w = upper(tokens[i]);
  if (w === 'ALTER') return upper(tokens[i + 1]) === 'TABLE';
  if (w !== 'CREATE') return false;
  for (let k = i + 1; k < Math.min(tokens.length, i + 6); k++) {
    if (tokens[k].kind !== 'word') return false;
    if (CREATE_OBJECT_WORDS.has(upper(tokens[k]))) return true;
  }
  return false;
}

/** Whether only spaces precede `offset` on its line. */
export function isLineStart(text: string, offset: number): boolean {
  for (let k = offset - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

export const upper = (t: Token | undefined): string => (t && t.kind === 'word' ? t.value.toUpperCase() : '');
export const isPunct = (t: Token | undefined, p: string): boolean => !!t && t.kind === 'punct' && t.value === p;
export const isName = (t: Token | undefined): boolean => !!t && (t.kind === 'word' || t.kind === 'ident');

/** A dotted name from `i` (`a`, `a.b`, `[a].[b].[c]`); its parts, and the index after it. */
export function readName(tokens: Token[], i: number): { parts: string[]; next: number; first: number } | undefined {
  if (!isName(tokens[i])) return undefined;
  const first = i;
  const parts = [tokens[i].value];
  i++;
  while (isPunct(tokens[i], '.') && isName(tokens[i + 1])) {
    parts.push(tokens[i + 1].value);
    i += 2;
  }
  // `a..b` (SQL Server's default-schema shorthand).
  while (isPunct(tokens[i], '.') && isPunct(tokens[i + 1], '.') && isName(tokens[i + 2])) {
    parts.push(tokens[i + 2].value);
    i += 3;
  }
  return { parts, next: i, first };
}

/** The index of the `)` closing the `(` at `open`, or -1. */
export function matchParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(')) depth++;
    else if (isPunct(tokens[k], ')')) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** `(a, b DESC, [c])` from `open`: the names, and the index after `)`. */
export function readColumnList(tokens: Token[], open: number): { columns: string[]; next: number } | undefined {
  if (!isPunct(tokens[open], '(')) return undefined;
  const close = matchParen(tokens, open);
  if (close < 0) return undefined;
  const columns: string[] = [];
  let expectName = true;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k];
    if (isPunct(t, ',')) { expectName = true; continue; }
    if (expectName && isName(t)) { columns.push(t.value); expectName = false; }
  }
  return { columns, next: close + 1 };
}

/** Split `[from, to)` at commas outside parentheses (and, when `angles`, outside `<…>`). */
export function splitTopLevel(tokens: Token[], from: number, to: number, angles = false): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let angle = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    else if (angles && depth === 0 && isPunct(t, '<')) angle++;
    else if (angles && depth === 0 && isPunct(t, '>') && angle > 0) angle--;
    else if (depth === 0 && angle === 0 && isPunct(t, ',')) { parts.push([start, k]); start = k + 1; }
  }
  if (start < to) parts.push([start, to]);
  return parts;
}

/** Words after CREATE [modifiers] that name what is created. */
export const CREATE_OBJECT_WORDS = new Set([
  'TABLE', 'TYPE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'CATALOG', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER',
  'EXTENSION', 'ROLE', 'USER', 'STAGE', 'STREAM', 'TASK', 'PIPE', 'WAREHOUSE', 'DOMAIN', 'POLICY', 'TAG', 'VOLUME', 'LOGIN',
  'SYNONYM', 'RULE', 'AGGREGATE', 'CAST', 'COLLATION', 'PUBLICATION', 'SUBSCRIPTION', 'SERVER', 'EVENT', 'FILE', 'SHARE',
]);

/**
 * The text `[start, end)` with `edits` applied (each a span replaced; an empty
 * replacement leaves a space), keeping every line break a replaced span had,
 * so a line number in the result still points into the user's file.
 */
export function applyEdits(text: string, start: number, end: number, edits: Array<{ start: number; end: number; text: string }>): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = start;
  for (const edit of sorted) {
    if (edit.start < at) continue; // nested in an edit already applied
    out += text.slice(at, edit.start);
    // Keep the line breaks the replaced text had, so lines still match the file.
    const breaks = (text.slice(edit.start, edit.end).match(/\n/g) ?? []).length;
    out += edit.text + (edit.text ? '' : ' ') + '\n'.repeat(breaks);
    at = edit.end;
  }
  return out + text.slice(at, end);
}

/** The string literals of the `( … )` at `open` (an enum's values), or undefined when there is none. */
export function readStringList(tokens: Token[], open: number): string[] | undefined {
  if (!isPunct(tokens[open], '(')) return undefined;
  const close = matchParen(tokens, open);
  if (close < 0) return undefined;
  return tokens.slice(open + 1, close).filter((t) => t.kind === 'string').map((t) => t.value);
}

/** A table's `COMMENT [=] '…'` after its column list (Snowflake, Databricks, MySQL). */
export function tailComment(tokens: Token[], from: number): string | undefined {
  for (let k = from; k < tokens.length; k++) {
    if (upper(tokens[k]) !== 'COMMENT') continue;
    const value = isPunct(tokens[k + 1], '=') ? tokens[k + 2] : tokens[k + 1];
    if (value?.kind === 'string' || isDoubleQuotedComment(value)) return value.value;
  }
  return undefined;
}

/** A `COMMENT "…"` value: a double-quoted token after COMMENT is a string in every dialect that has COMMENT (MySQL, Spark). */
export function isDoubleQuotedComment(token: Token | undefined): token is Token {
  return !!token && token.kind === 'ident' && token.quote === '"';
}

