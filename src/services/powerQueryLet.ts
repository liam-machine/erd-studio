/**
 * Just enough of Power Query M's shape to say where a query's rows come
 * from when it merges or appends tables: a query's `let` steps, the
 * `Table.NestedJoin` / `Table.Join` / `Table.Combine`… calls in them, and
 * the steps and queries an expression names. Strings, `#"quoted names"` and
 * comments are respected; nothing is evaluated.
 *
 * Pure: no `vscode`, no Node built-ins.
 */

/** One `name = expression` step of a `let`. */
export interface MStep {
  name: string;
  expr: string;
}

/** A query's steps (in order) and what follows its `in`; a query with no `let` is one unnamed step. */
export interface MLet {
  steps: MStep[];
  result: string;
}

/** A merge or append call: what it does and the expressions of the tables it reads. */
export interface MCombineCall {
  kind: 'merge' | 'append';
  /** `Table.NestedJoin`… as written. */
  fn: string;
  /** The table arguments as written (each list element of a `Table.Combine({…})`). */
  tables: string[];
  /** A `Table.Combine` whose list is built at run time (`Table.Combine(Source[Content])`). */
  dynamic?: boolean;
}

/** Merge functions and the argument positions of their two tables. */
const MERGES: Readonly<Record<string, readonly number[]>> = {
  'table.nestedjoin': [0, 2],
  'table.join': [0, 2],
  'table.fuzzynestedjoin': [0, 2],
  'table.fuzzyjoin': [0, 2],
  'table.addjoincolumn': [0, 2],
};
const APPENDS = new Set(['table.combine']);

/**
 * `m` with the text of every string and quoted name, and every comment,
 * replaced by spaces (same length, so positions still line up): what is left
 * is the code's structure.
 */
export function maskM(m: string, opts: { keepStrings?: boolean } = {}): string {
  let out = '';
  let i = 0;
  while (i < m.length) {
    const ch = m[i];
    if (ch === '"' || (ch === '#' && m[i + 1] === '"')) {
      const start = i;
      let j = ch === '#' ? i + 2 : i + 1;
      while (j < m.length) {
        if (m[j] === '"') {
          if (m[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j++;
      }
      // Keep the quotes (and the #) so a quoted name still reads as a name; blank what is inside.
      const end = Math.min(j, m.length - 1);
      const open = ch === '#' ? '#"' : '"';
      out += opts.keepStrings ? m.slice(start, j + 1) : open + ' '.repeat(Math.max(0, end - start - open.length)) + (j < m.length ? '"' : '');
      i = j + 1;
    } else if (ch === '/' && m[i + 1] === '/') {
      const start = i;
      while (i < m.length && m[i] !== '\n' && m[i] !== '\r') i++;
      out += ' '.repeat(i - start);
    } else if (ch === '/' && m[i + 1] === '*') {
      const end = m.indexOf('*/', i + 2);
      const stop = end < 0 ? m.length : end + 2;
      out += m.slice(i, stop).replace(/[^\r\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const WORD = /[A-Za-z0-9_.]/;

/** Whether the masked text has the keyword `word` at `i` (not part of a longer name). */
function keywordAt(masked: string, i: number, word: string): boolean {
  if (!masked.startsWith(word, i)) return false;
  if (i > 0 && WORD.test(masked[i - 1])) return false;
  const after = masked[i + word.length];
  return after === undefined || !WORD.test(after);
}

/** The parts of `text` split at top-level `sep` (outside brackets, strings and nested `let … in`). */
function splitTop(text: string, masked: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let lets = 0;
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && keywordAt(masked, i, 'let')) lets++;
    else if (depth === 0 && lets > 0 && keywordAt(masked, i, 'in')) lets--;
    else if (c === sep && depth === 0 && lets === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A name as M writes it: `Source`, `#"Merged Queries"` (`""` a quote inside). Undefined when `text` is not just a name. */
export function mName(text: string): string | undefined {
  const t = text.trim();
  const quoted = /^#"((?:[^"]|"")*)"$/.exec(t);
  if (quoted) return quoted[1].replace(/""/g, '"');
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(t) ? t : undefined;
}

/** A query's `let` steps; one unnamed step (the whole query) when it has no top-level `let`. */
export function parseMLet(m: string): MLet {
  const masked = maskM(m);
  const lead = /^\s*/.exec(masked)![0].length;
  if (!keywordAt(masked, lead, 'let')) return { steps: [{ name: '', expr: m.trim() }], result: m.trim() };
  // The `in` that closes this `let`: the first at depth 0 once every nested `let` is closed.
  let depth = 0;
  let lets = 0;
  let inAt = -1;
  for (let i = lead; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && keywordAt(masked, i, 'let')) lets++;
    else if (depth === 0 && keywordAt(masked, i, 'in')) {
      lets--;
      if (lets === 0) { inAt = i; break; }
    }
  }
  const bodyStart = lead + 3;
  const bodyEnd = inAt < 0 ? m.length : inAt;
  const body = m.slice(bodyStart, bodyEnd);
  const steps: MStep[] = [];
  for (const part of splitTop(body, masked.slice(bodyStart, bodyEnd), ',')) {
    const maskedPart = maskM(part);
    const eq = maskedPart.indexOf('=');
    if (eq < 0) continue;
    // A comment before the step (`// Items`) is not part of its name.
    const name = mName(maskM(part.slice(0, eq), { keepStrings: true }));
    if (name === undefined) continue;
    steps.push({ name, expr: part.slice(eq + 1).trim() });
  }
  return { steps, result: inAt < 0 ? '' : m.slice(inAt + 2).trim() };
}

/** The merge and append calls in an expression, in the order they are written (nested ones too). */
export function mCombineCalls(expr: string): MCombineCall[] {
  const masked = maskM(expr);
  const calls: MCombineCall[] = [];
  const re = /\b(Table\.(?:NestedJoin|Join|FuzzyNestedJoin|FuzzyJoin|AddJoinColumn|Combine))\s*\(/gi;
  for (const m of masked.matchAll(re)) {
    const fn = m[1];
    const key = fn.toLowerCase();
    if (m.index! > 0 && WORD.test(masked[m.index! - 1])) continue;
    const open = m.index! + m[0].length - 1;
    // The matching `)`.
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const args = splitTop(expr.slice(open + 1, close), masked.slice(open + 1, close), ',').map((a) => a.trim());
    if (APPENDS.has(key)) {
      const list = args[0] ?? '';
      if (/^\{[\s\S]*\}$/.test(list)) {
        const inner = list.slice(1, -1);
        const items = splitTop(inner, maskM(inner), ',').map((x) => x.trim()).filter((x) => x !== '');
        calls.push({ kind: 'append', fn, tables: items });
      } else {
        calls.push({ kind: 'append', fn, tables: [], dynamic: true });
      }
    } else {
      const positions = MERGES[key] ?? [];
      calls.push({ kind: 'merge', fn, tables: positions.map((p) => args[p]).filter((x): x is string => !!x) });
    }
  }
  return calls;
}

/** The names among `names` (steps or queries) that `expr` refers to, in the order first written. */
export function mReferences(expr: string, names: Iterable<string>): string[] {
  const masked = maskM(expr);
  const out: string[] = [];
  for (const name of names) {
    if (name === '') continue;
    const quoted = `#"${name.replace(/"/g, '""')}"`;
    let found = expr.includes(quoted);
    if (!found && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)) {
      const re = new RegExp(`(^|[^A-Za-z0-9_.#])${name.replace(/[.]/g, '\\.')}(?![A-Za-z0-9_])`);
      found = re.test(masked);
    }
    if (found) out.push(name);
  }
  return out;
}
