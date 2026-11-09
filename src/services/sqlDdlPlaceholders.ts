/**
 * Template placeholders in SQL DDL, neutralised before anything reads the
 * text: `${catalog}.${schema}.orders` (Databricks bundles, Terraform),
 * `{{ schema }}` and `{{ var('schema') }}` (dbt, Jinja), `$(schema)`
 * (sqlcmd), `@schema@` (Ant, Maven), `<%= schema %>` (ERB), `%(schema)s` and
 * `{schema}.orders` (Python), `&schema.` (SQL*Plus). Real deployments fill them in; an import
 * reads the file as written, so each placeholder becomes the name inside it:
 *
 *  - a placeholder that is a whole catalog (the first part of a three-part
 *    name) is dropped with its dot: `${catalog}.${sales}.orders` reads as
 *    `sales.orders`;
 *  - any other placeholder becomes its inner name: `${schema}.orders` reads
 *    as `schema.orders`, `stg_${env}_orders` as `stg_env_orders`;
 *  - a Jinja statement or comment (`{% … %}`, `{# … #}`) and a Jinja call
 *    that is not a name (`{{ config(…) }}`) become spaces.
 *
 * The pass is **length-preserving** and keeps every line break: each run of
 * name characters that held a placeholder is padded on the left with spaces
 * to its old length, so every offset, and so every line number, still points
 * into the user's file. Strings, comments and `$$` bodies are never touched;
 * a quoted name holding a placeholder (`[$(Schema)]`, `"stg_${env}"`) is read
 * the same way inside its quotes, so it names the same table as the bare one.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import { isEscapeStringPrefix, lostQuote, nonStandardStrings } from './sqlDdlLexer';
import type { SqlDialect } from './sqlDdlModel';

export interface PlaceholderPass {
  /** The text with every placeholder neutralised (same length, same line breaks). */
  text: string;
  /** How many placeholders were neutralised. */
  count: number;
  /** Offsets (in the text) of each neutralised placeholder, in order. */
  offsets: number[];
  /** The first placeholder as written (cut short), and its line: the example a note gives. */
  example?: { text: string; line: number };
  /** How many whole-catalog placeholders were dropped with their dot. */
  catalogs?: number;
  /** How many read as their full name, because their short one was ambiguous ({@link ambiguousPlaceholderNames}). */
  qualified?: number;
}

interface Match {
  start: number;
  end: number;
  /** The name it stands for; '' when it stands for nothing (a Jinja statement or comment). */
  name: string;
  /**
   * Every part of a qualified placeholder, joined with `_` (`${bronze.schema}`
   * → bronze_schema, `{{ source('raw', 'orders') }}` → raw_orders): the name
   * used instead of `name` when two different placeholders would read as the
   * same `name` ({@link ambiguousPlaceholderNames}). Absent when it has one part.
   */
  full?: string;
  /** A quoted name holding placeholders (`[$(Schema)]`): `name` is the whole quoted name, rewritten. */
  quoted?: boolean;
  /** How many placeholders a quoted match holds. */
  inner?: number;
}

/** The characters that quote a name (not a string) in each dialect. */
const IDENT_QUOTES: Readonly<Record<SqlDialect, string>> = {
  postgres: '"', snowflake: '"', sqlserver: '"[', mysql: '`', databricks: '`',
  oracle: '"', bigquery: '`', redshift: '"', sqlite: '"[`',
};

/** Characters that continue a plain name. */
const NAME_CHAR = /[A-Za-z0-9_$#\u0080-￿]/;
/** Characters that start one (no digit: `9${x}` is not a name). */
const NAME_START = /[A-Za-z_\u0080-￿]/;

/** Dialects whose `'…'` strings take backslash escapes (kept in step with the lexer's). */
const BACKSLASH = new Set<SqlDialect>(['mysql', 'databricks', 'snowflake', 'bigquery']);

/** A cheap first test: none of the syntaxes' opening characters means nothing to do. */
const MAY_HOLD = /\$\{|\{\{|\{%|\{#|\{[A-Za-z_]\w*\}|\$\(|@[A-Za-z_]\w*@|<%|%\(|&&?[A-Za-z_]\w*\./;

/** The placeholder starting at `i`, or undefined. */
function placeholderAt(text: string, i: number): Match | undefined {
  const c = text[i];
  const rest = (n: number): string => text.slice(i, i + n);
  if (c === '$' && text[i + 1] === '{') {
    // `${schema}`, `${a.b}`, Flyway's `${flyway:defaultSchema}`, shell defaults `${x:-public}`.
    const m = /^\$\{\s*([A-Za-z_][\w.]*(?::[A-Za-z_][\w.]*)*)\s*(?::?[-=?+][^}\n]*)?\}/.exec(rest(256));
    if (m) return { start: i, end: i + m[0].length, ...qualified(m[1].replace(/:/g, '.')) };
    return undefined;
  }
  if (c === '$' && text[i + 1] === '(') {
    const m = /^\$\(\s*([A-Za-z_]\w*)\s*\)/.exec(rest(128));
    return m ? { start: i, end: i + m[0].length, name: m[1] } : undefined;
  }
  if (c === '{' && (text[i + 1] === '%' || text[i + 1] === '#')) {
    const close = text[i + 1] === '%' ? '%}' : '#}';
    const end = text.indexOf(close, i + 2);
    if (end < 0 || end - i > 4096) return undefined;
    return { start: i, end: end + 2, name: '' };
  }
  if (c === '{' && text[i + 1] === '{') {
    const end = text.indexOf('}}', i + 2);
    if (end < 0 || end - i > 1024 || text.slice(i + 2, end).includes('\n\n')) return undefined;
    return { start: i, end: end + 2, ...jinjaName(text.slice(i + 2, end)) };
  }
  if (c === '{') {
    // Python's str.format: `{schema}.orders`, `stg_{env}` (only where it joins a name: a dot or a name character beside it).
    const m = /^\{([A-Za-z_]\w*)\}/.exec(rest(128));
    if (!m) return undefined;
    const before = i > 0 ? text[i - 1] : '';
    const after = text[i + m[0].length] ?? '';
    return before === '.' || NAME_CHAR.test(before) || after === '.' || NAME_CHAR.test(after) ? { start: i, end: i + m[0].length, name: m[1] } : undefined;
  }
  if (c === '@') {
    if (i > 0 && text[i - 1] === '@') return undefined;
    const m = /^@([A-Za-z_]\w*)@(?!@)/.exec(rest(128));
    return m ? { start: i, end: i + m[0].length, name: m[1] } : undefined;
  }
  if (c === '<' && text[i + 1] === '%') {
    const m = /^<%[=-]?\s*([A-Za-z_][\w.]*)\s*-?%>/.exec(rest(256));
    return m ? { start: i, end: i + m[0].length, ...qualified(m[1]) } : undefined;
  }
  if (c === '%' && text[i + 1] === '(') {
    const m = /^%\(([A-Za-z_]\w*)\)s/.exec(rest(128));
    return m ? { start: i, end: i + m[0].length, name: m[1] } : undefined;
  }
  if (c === '&') {
    if (i > 0 && NAME_CHAR.test(text[i - 1])) return undefined;
    // SQL*Plus substitution: `&name.` (the dot ends the variable; kept as the qualifier dot).
    const m = /^&&?([A-Za-z_]\w*)(?=\.)/.exec(rest(128));
    if (!m) return undefined;
    // `&schema..orders` (SQL*Plus's own spelling of a qualified name): the first dot is the variable's end.
    const end = i + m[0].length + (text[i + m[0].length + 1] === '.' ? 1 : 0);
    return { start: i, end, name: m[1] };
  }
  return undefined;
}

/** A dotted placeholder's name (its last part) and, when it has more than one, every part joined. */
function qualified(dotted: string): { name: string; full?: string } {
  const parts = dotted.split('.').filter(Boolean);
  const name = parts[parts.length - 1] ?? dotted;
  return parts.length > 1 ? { name, full: parts.join('_') } : { name };
}

/**
 * The name a Jinja expression stands for: `{{ schema }}` → schema,
 * `{{ target.schema }}` and `{{ params['schema'] }}` → schema, `{{ var('schema', 'x') }}` → schema,
 * `{{ source('raw', 'orders') }}` → orders, `{{ ref('orders') }}` → orders;
 * '' for anything else (`{{ config(…) }}`), which then reads as spaces.
 */
function jinjaName(inner: string): { name: string; full?: string } {
  const expr = inner.replace(/^-|-$/g, '').split('|')[0].trim();
  const bare = /^([A-Za-z_][\w.]*)$/.exec(expr);
  if (bare) return qualified(bare[1]);
  // `{{ params['name'] }}` (Airflow, Jinja's subscript): the key, as `{{ params.name }}` reads.
  const subscript = /^([A-Za-z_][\w.]*)\s*\[\s*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)")\s*\]$/.exec(expr);
  if (subscript) return qualified(`${subscript[1]}.${subscript[2] ?? subscript[3]}`);
  const call = /^([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/.exec(expr);
  if (!call) return { name: '' };
  const strings = [...call[2].matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
  const fn = call[1].toLowerCase();
  const pick = fn === 'source' ? strings[strings.length - 1] : fn === 'var' || fn === 'env_var' || fn === 'ref' ? strings[0] : undefined;
  if (!pick || !/^[A-Za-z_][\w]*$/.test(pick)) return { name: '' };
  // `source('raw', 'orders')`: the source's name too, so two sources' tables stay apart when they must.
  const source = fn === 'source' && strings.length >= 2 && /^[A-Za-z_][\w]*$/.test(strings[0]) ? strings[0] : undefined;
  return source ? { name: pick, full: `${source}_${pick}` } : { name: pick };
}

/**
 * The names (lower-cased) that two different placeholders across `texts`
 * would both read as (`${bronze.schema}` and `${silver.schema}` are both
 * schema): those placeholders read as their full names instead
 * (bronze_schema, silver_schema), so two tables they name stay two tables.
 * Every file of one import is passed, so a placeholder reads the same way in
 * every file.
 */
export function ambiguousPlaceholderNames(texts: readonly string[], dialect: SqlDialect): Set<string> {
  const forms = new Map<string, Set<string>>();
  const add = (m: Match): void => {
    if (!m.name || m.quoted) return;
    const key = m.name.toLowerCase();
    let set = forms.get(key);
    if (!set) { set = new Set(); forms.set(key, set); }
    set.add((m.full ?? m.name).toLowerCase());
  };
  for (const text of texts) {
    if (!MAY_HOLD.test(text)) continue;
    for (const m of findPlaceholders(text, dialect)) {
      if (!m.quoted) { add(m); continue; }
      // A quoted name's placeholders, one by one.
      const inner = text.slice(m.start + 1, m.end - 1);
      for (let k = 0; k < inner.length;) {
        const p = placeholderAt(inner, k);
        if (p) { add(p); k = p.end; } else k++;
      }
    }
  }
  const out = new Set<string>();
  for (const [name, set] of forms) if (set.size > 1) out.add(name);
  return out;
}

/** The name a placeholder reads as: its full name when its short one is ambiguous. */
function readAs(m: Match, ambiguous: ReadonlySet<string> | undefined): string {
  return m.full && ambiguous?.has(m.name.toLowerCase()) ? m.full : m.name;
}

/**
 * The text with its template placeholders neutralised (see the module
 * comment). Returns the text itself when it holds none.
 */
export function neutralisePlaceholders(text: string, dialect: SqlDialect, ambiguous?: ReadonlySet<string>): PlaceholderPass {
  if (!MAY_HOLD.test(text)) return { text, count: 0, offsets: [] };
  const matches = findPlaceholders(text, dialect, ambiguous);
  if (matches.length === 0) return { text, count: 0, offsets: [] };
  const out: string[] = [];
  let at = 0;
  let m = 0;
  let catalogs = 0;
  while (m < matches.length) {
    // The run of name characters and placeholders around this placeholder.
    let runStart = matches[m].start;
    while (runStart > at && NAME_CHAR.test(text[runStart - 1])) runStart--;
    let runEnd = matches[m].end;
    let last = m;
    for (;;) {
      while (runEnd < text.length && NAME_CHAR.test(text[runEnd]) && !(last + 1 < matches.length && matches[last + 1].start === runEnd)) runEnd++;
      if (last + 1 < matches.length && matches[last + 1].start === runEnd) { last++; runEnd = matches[last].end; continue; }
      break;
    }
    // The run as it reads: name characters kept, each placeholder its name.
    let replaced = '';
    let k = runStart;
    for (let j = m; j <= last; j++) {
      replaced += text.slice(k, matches[j].start) + readAs(matches[j], ambiguous);
      k = matches[j].end;
    }
    replaced += text.slice(k, runEnd);
    if (matches[m].quoted) {
      // A quoted name holding placeholders: rewritten inside its quotes, padded on the left (`[$(Schema)]` → `    [Schema]`).
      const match = matches[m];
      if (text[match.end] === '.' && isCatalogQualifier(text, match.end + 1, matches)) {
        catalogs++;
        out.push(text.slice(at, match.start), ' '.repeat(match.end + 1 - match.start));
        at = match.end + 1;
      } else {
        out.push(text.slice(at, match.start), ' '.repeat(Math.max(0, match.end - match.start - match.name.length)), match.name);
        at = match.end;
      }
      m++;
      continue;
    }
    const alone = m === last && runStart === matches[m].start && runEnd === matches[m].end;
    // A whole-catalog placeholder (`${catalog}.x.y`): dropped with its dot.
    if (alone && text[runEnd] === '.' && isCatalogQualifier(text, runEnd + 1, matches)) {
      catalogs++;
      out.push(text.slice(at, runStart), ' '.repeat(runEnd + 1 - runStart));
      at = runEnd + 1;
    } else {
      const span = text.slice(runStart, runEnd);
      // Line breaks inside a placeholder (`{% … %}` over lines) stay where they were.
      const breaks = (span.match(/\n/g) ?? []).length;
      const body = replaced.replace(/\s+/g, ' ').trim().replace(/ /g, '_');
      const pad = span.length - body.length - breaks;
      out.push(text.slice(at, runStart), pad >= 0 ? ' '.repeat(pad) + '\n'.repeat(breaks) + body : spacesKeepingBreaks(span));
      at = runEnd;
    }
    m = last + 1;
  }
  out.push(text.slice(at));
  const first = matches[0];
  return {
    text: out.join(''),
    count: matches.reduce((n, x) => n + (x.inner ?? 1), 0),
    offsets: matches.map((x) => x.start),
    example: { text: text.slice(first.start, Math.min(first.end, first.start + 40)), line: lineAt(text, first.start) },
    catalogs,
    qualified: ambiguous?.size ? matches.filter((x) => !x.quoted && readAs(x, ambiguous) !== x.name).length : 0,
  };
}

function spacesKeepingBreaks(span: string): string {
  return span.replace(/[^\n]/g, ' ');
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

/** Whether a name part starts at `from` and is followed by `.` and another part: `from` is a schema, so what came before it is a catalog. */
function isCatalogQualifier(text: string, from: number, matches: readonly Match[]): boolean {
  const end = partEnd(text, from, matches);
  if (end === undefined || text[end] !== '.') return false;
  return partEnd(text, end + 1, matches) !== undefined;
}

/** The end of one name part at `from` (plain, quoted or a placeholder run), or undefined. */
function partEnd(text: string, from: number, matches: readonly Match[]): number | undefined {
  const c = text[from];
  if (c === '"' || c === '`' || c === '[') {
    const close = text.indexOf(c === '[' ? ']' : c, from + 1);
    return close < 0 ? undefined : close + 1;
  }
  let i = from;
  for (;;) {
    const match = matches.find((x) => x.start === i);
    if (match) { i = match.end; continue; }
    if (i < text.length && (i === from ? NAME_START.test(text[i]) : NAME_CHAR.test(text[i]))) { i++; continue; }
    break;
  }
  return i > from ? i : undefined;
}

/** Every placeholder in code (outside strings, quoted names, comments and `$$` bodies). */
function findPlaceholders(text: string, dialect: SqlDialect, ambiguous?: ReadonlySet<string>): Match[] {
  const out: Match[] = [];
  const n = text.length;
  const escapes = BACKSLASH.has(dialect);
  const nonStandardAt = nonStandardStrings(text, dialect);
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') { i = lineEnd(text, i); continue; }
    if (c === '#' && (dialect === 'mysql' || dialect === 'bigquery') && text[i + 1] !== '}') { i = lineEnd(text, i); continue; }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? lineEnd(text, i) : close + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && (dialect === 'sqlserver' || dialect === 'sqlite'))) {
      const closeChar = c === '[' ? ']' : c;
      // PostgreSQL's E'…' reads backslash escapes whatever the dialect (the lexer's rule).
      const backslash = (c === "'" && (escapes || isEscapeStringPrefix(text, i) || nonStandardAt(i)))
        || (c === '"' && (dialect === 'mysql' || dialect === 'databricks' || dialect === 'bigquery'));
      let j = i + 1;
      for (; j < n; j++) {
        if (backslash && text[j] === '\\') { j++; continue; }
        if (text[j] === closeChar) {
          if (text[j + 1] === closeChar) { j++; continue; }
          break;
        }
      }
      if (j < n && c !== "'" && IDENT_QUOTES[dialect].includes(c)) {
        const quoted = quotedPlaceholders(text, i, j, closeChar, ambiguous);
        if (quoted) { out.push(quoted); i = j + 1; continue; }
      }
      // Unterminated, or a quote lost: only to the end of its line (the lexer reads it the same way).
      const string = c === "'" || backslash;
      i = j >= n || lostQuote(text, i, j + 1, string ? 'string' : 'name') ? lineEnd(text, i) : j + 1;
      continue;
    }
    if (c === '$' && text[i + 1] !== '{' && text[i + 1] !== '(') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? i + tag[0].length : close + tag[0].length;
        continue;
      }
    }
    const match = placeholderAt(text, i);
    if (match) { out.push(match); i = match.end; continue; }
    i++;
  }
  return out;
}

/**
 * A quoted name `text[open..close]` with the placeholders inside it read as
 * their names (`[stg_$(env)_orders]` → `[stg_env_orders]`), or undefined
 * when it holds none. Never a line break: a quoted name is one line.
 */
function quotedPlaceholders(text: string, open: number, close: number, closeChar: string, ambiguous?: ReadonlySet<string>): Match | undefined {
  const inner = text.slice(open + 1, close);
  if (inner.includes('\n') || !MAY_HOLD.test(inner)) return undefined;
  let name = '';
  let count = 0;
  for (let k = 0; k < inner.length;) {
    const match = placeholderAt(inner, k);
    if (match) { name += readAs(match, ambiguous); count++; k = match.end; continue; }
    name += inner[k];
    k++;
  }
  if (count === 0 || !name.trim()) return undefined;
  // `inner` is as written (a doubled quote stays doubled); a placeholder's name is only name characters.
  return { start: open, end: close + 1, name: `${text[open]}${name}${closeChar}`, quoted: true, inner: count };
}

function lineEnd(text: string, from: number): number {
  const eol = text.indexOf('\n', from);
  return eol < 0 ? text.length : eol;
}
