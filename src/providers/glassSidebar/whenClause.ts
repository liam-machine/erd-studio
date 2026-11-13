/**
 * A small evaluator for VS Code `when` clauses: the grammar this extension's
 * own package.json uses in `views`, `viewsWelcome` and `menus` (the glass
 * sidebar decides from them what a native tree would have shown), plus the
 * rest of VS Code's operators so a new clause is read the way VS Code reads it.
 *
 * Grammar (precedence low to high):
 *   or      := and ( '||' and )*
 *   and     := unary ( '&&' unary )*
 *   unary   := '!' unary | primary
 *   primary := '(' or ')' | 'true' | 'false'
 *            | key [ ('==' | '!=') value          -- also '===' / '!=='
 *                  | '=~' /regex/flags
 *                  | ('<' | '<=' | '>' | '>=') number
 *                  | ['not'] 'in' key ]
 *
 * Semantics follow VS Code (`contextkey.ts`):
 * - a bare key is its value's truthiness; an unknown key is undefined (falsy);
 * - `key == true` is `key` and `key == false` is `!key` (and the `!=` mirrors);
 * - `==` / `!=` compare the value with the literal's text (a number value
 *   with the literal read as a number, so `workspaceFolderCount == 0` holds
 *   for `0`); an undefined value equals nothing, so `!=` holds for it;
 * - `=~` tests the value as text (undefined / null never match);
 * - `<` … `>=` compare numbers (anything that is not a number is false);
 * - `a in b` holds when `b`'s value is an array containing `a`'s value, or
 *   an object with `a`'s value as an own key.
 *
 * Anything outside the grammar is a parse error, and a clause that fails to
 * parse is false (fail closed: the entry is hidden). Evaluation never throws.
 *
 * Pure: no `vscode` import, so it is unit-tested directly.
 */

export type ContextValue = unknown;
export type ContextLookup = (key: string) => ContextValue;

/** A parsed clause. */
export type WhenNode =
  | { kind: 'or'; left: WhenNode; right: WhenNode }
  | { kind: 'and'; left: WhenNode; right: WhenNode }
  | { kind: 'not'; operand: WhenNode }
  | { kind: 'key'; key: string }
  | { kind: 'const'; value: boolean }
  | { kind: 'eq'; key: string; value: string; negate: boolean }
  | { kind: 'regex'; key: string; regex: RegExp }
  | { kind: 'cmp'; key: string; op: '<' | '<=' | '>' | '>='; value: number }
  | { kind: 'in'; key: string; source: string; negate: boolean };

type Op = '&&' | '||' | '!' | '(' | ')' | '==' | '!=' | '=~' | '<' | '<=' | '>' | '>=';

type Token =
  | { t: 'op'; v: Op }
  /** `quoted`: a '…' literal, never a keyword (`'in'` is the text "in"). */
  | { t: 'word'; v: string; quoted: boolean }
  | { t: 'regex'; v: RegExp };

export class WhenClauseError extends Error {}

const WHITESPACE = /\s/;
/** Characters that end an unquoted key or value. */
const WORD_END = /[\s()!&|=<>'"]/;

/** Read `/body/flags` starting at `src[start] === '/'`; returns the regex and the index after it. */
function readRegex(src: string, start: number): { regex: RegExp; end: number } {
  let j = start + 1;
  let body = '';
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length) { body += ch + src[j + 1]; j += 2; continue; }
    if (ch === '/' && !inClass) break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    body += ch;
    j++;
  }
  if (j >= src.length) throw new WhenClauseError('Unterminated regex');
  j++; // the closing '/'
  let flags = '';
  while (j < src.length && /[a-z]/i.test(src[j])) { flags += src[j]; j++; }
  if (!/^[imsu]*$/.test(flags.replace(/[gy]/g, ''))) throw new WhenClauseError(`Unknown regex flags "${flags}"`);
  if (new Set(flags).size !== flags.length) throw new WhenClauseError(`Repeated regex flags "${flags}"`);
  let regex: RegExp;
  try {
    // `g` and `y` make `test()` stateful (lastIndex) on a cached regex: drop them.
    regex = new RegExp(body, flags.replace(/[gy]/g, ''));
  } catch (err) {
    throw new WhenClauseError(`Invalid regex /${body}/: ${(err as Error).message}`);
  }
  return { regex, end: j };
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (WHITESPACE.test(c)) { i++; continue; }
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') {
      tokens.push({ t: 'op', v: three === '===' ? '==' : '!=' });
      i += 3;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (two === '=~') {
      tokens.push({ t: 'op', v: '=~' });
      i += 2;
      while (i < src.length && WHITESPACE.test(src[i])) i++;
      if (src[i] !== '/') throw new WhenClauseError(`Expected a /regex/ after =~ at ${i}`);
      const { regex, end } = readRegex(src, i);
      tokens.push({ t: 'regex', v: regex });
      i = end;
      continue;
    }
    if (c === '!' || c === '(' || c === ')' || c === '<' || c === '>') {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new WhenClauseError('Unterminated string');
      tokens.push({ t: 'word', v: src.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }
    // A key or an unquoted literal: anything up to whitespace, a quote or an operator character.
    let j = i;
    while (j < src.length && !WORD_END.test(src[j])) j++;
    if (j === i) throw new WhenClauseError(`Unexpected "${c}" at ${i}`);
    tokens.push({ t: 'word', v: src.slice(i, j), quoted: false });
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): WhenNode {
    if (this.tokens.length === 0) throw new WhenClauseError('Empty clause');
    const node = this.or();
    if (this.pos !== this.tokens.length) throw new WhenClauseError('Trailing tokens');
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private peekOp(v: Op): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.t === 'op' && tok.v === v;
  }

  private peekKeyword(v: string): boolean {
    const tok = this.peek();
    return tok !== undefined && tok.t === 'word' && !tok.quoted && tok.v === v;
  }

  private or(): WhenNode {
    let left = this.and();
    while (this.peekOp('||')) { this.pos++; left = { kind: 'or', left, right: this.and() }; }
    return left;
  }

  private and(): WhenNode {
    let left = this.unary();
    while (this.peekOp('&&')) { this.pos++; left = { kind: 'and', left, right: this.unary() }; }
    return left;
  }

  private unary(): WhenNode {
    if (this.peekOp('!')) { this.pos++; return { kind: 'not', operand: this.unary() }; }
    return this.primary();
  }

  /** The literal after `==` / `!=` / a comparison: an unquoted word or a quoted string. */
  private value(): Token & { t: 'word' } {
    const tok = this.peek();
    if (!tok || tok.t !== 'word') throw new WhenClauseError('Expected a value');
    this.pos++;
    return tok;
  }

  private primary(): WhenNode {
    const tok = this.peek();
    if (!tok) throw new WhenClauseError('Unexpected end');
    if (tok.t === 'op' && tok.v === '(') {
      this.pos++;
      const inner = this.or();
      if (!this.peekOp(')')) throw new WhenClauseError('Missing )');
      this.pos++;
      return inner;
    }
    if (tok.t !== 'word' || tok.v === '') throw new WhenClauseError('Expected a key');
    this.pos++;
    const key = tok.v;
    // `true` / `false` are keywords, as in VS Code (`true == x` is a parse error).
    if (!tok.quoted && (key === 'true' || key === 'false')) return { kind: 'const', value: key === 'true' };
    if (this.peekOp('==') || this.peekOp('!=')) {
      const negate = (this.peek() as { v: string }).v === '!=';
      this.pos++;
      const value = this.value();
      // VS Code: `key == true` is `key`, `key == false` is `!key`.
      if (!value.quoted && (value.v === 'true' || value.v === 'false')) {
        const truthy: WhenNode = { kind: 'key', key };
        const wantTrue = (value.v === 'true') !== negate;
        return wantTrue ? truthy : { kind: 'not', operand: truthy };
      }
      return { kind: 'eq', key, value: value.v, negate };
    }
    if (this.peekOp('=~')) {
      this.pos++;
      const re = this.peek();
      if (!re || re.t !== 'regex') throw new WhenClauseError('Expected a regex');
      this.pos++;
      return { kind: 'regex', key, regex: re.v };
    }
    for (const op of ['<', '<=', '>', '>='] as const) {
      if (this.peekOp(op)) {
        this.pos++;
        const raw = this.value().v;
        const value = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(value)) throw new WhenClauseError(`Expected a number after ${op}`);
        return { kind: 'cmp', key, op, value };
      }
    }
    if (this.peekKeyword('not')) {
      this.pos++;
      if (!this.peekKeyword('in')) throw new WhenClauseError("Expected 'in' after 'not'");
      this.pos++;
      return { kind: 'in', key, source: this.inSource(), negate: true };
    }
    if (this.peekKeyword('in')) {
      this.pos++;
      return { kind: 'in', key, source: this.inSource(), negate: false };
    }
    return { kind: 'key', key };
  }

  private inSource(): string {
    const tok = this.peek();
    if (!tok || tok.t !== 'word' || tok.v === '') throw new WhenClauseError("Expected a key after 'in'");
    this.pos++;
    return tok.v;
  }
}

/** `value == literal` as VS Code reads it (`getValue(key) == literal`, without JavaScript's odd coercions). */
function looselyEqual(value: ContextValue, literal: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value === literal;
  if (typeof value === 'number') return literal.trim() !== '' && Number(literal) === value;
  if (typeof value === 'boolean') return String(value) === literal;
  if (Array.isArray(value)) return value.length === 1 && looselyEqual(value[0], literal);
  return false;
}

function evaluateNode(node: WhenNode, get: ContextLookup): boolean {
  switch (node.kind) {
    case 'or': return evaluateNode(node.left, get) || evaluateNode(node.right, get);
    case 'and': return evaluateNode(node.left, get) && evaluateNode(node.right, get);
    case 'not': return !evaluateNode(node.operand, get);
    case 'const': return node.value;
    case 'key': return Boolean(get(node.key));
    case 'eq': {
      const equal = looselyEqual(get(node.key), node.value);
      return node.negate ? !equal : equal;
    }
    case 'regex': {
      const value = get(node.key);
      if (value === undefined || value === null) return false;
      return node.regex.test(typeof value === 'string' ? value : String(value));
    }
    case 'cmp': {
      const raw = get(node.key);
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (Number.isNaN(value)) return false;
      switch (node.op) {
        case '<': return value < node.value;
        case '<=': return value <= node.value;
        case '>': return value > node.value;
        case '>=': return value >= node.value;
      }
      return false;
    }
    case 'in': {
      const item = get(node.key);
      const source = get(node.source);
      let found = false;
      if (Array.isArray(source)) found = source.includes(item);
      else if (typeof item === 'string' && typeof source === 'object' && source !== null) {
        found = Object.prototype.hasOwnProperty.call(source, item);
      }
      return node.negate ? !found : found;
    }
  }
}

const cache = new Map<string, WhenNode | null>();

/** Parse a clause (cached). Throws {@link WhenClauseError} on a clause outside the grammar. */
export function parseWhenClause(clause: string): WhenNode {
  const hit = cache.get(clause);
  if (hit) return hit;
  if (hit === null) throw new WhenClauseError(`Unsupported when clause: ${clause}`);
  try {
    const node = new Parser(tokenize(clause)).parse();
    cache.set(clause, node);
    return node;
  } catch (err) {
    cache.set(clause, null);
    throw err instanceof WhenClauseError ? err : new WhenClauseError(String(err));
  }
}

/** Whether `clause` is inside the grammar (a clause that is not always evaluates to false). */
export function isSupportedWhenClause(clause: string): boolean {
  try {
    parseWhenClause(clause);
    return true;
  } catch {
    return false;
  }
}

function lookupOf(context: ContextLookup | ReadonlyMap<string, ContextValue> | Record<string, ContextValue>): ContextLookup {
  if (typeof context === 'function') return context;
  if (context instanceof Map) return (key) => context.get(key);
  // Own keys only: `toString` or `constructor` must not read Object.prototype.
  const record = context as Record<string, ContextValue>;
  return (key) => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
}

/**
 * Whether `clause` holds for `context` (a lookup, a Map or a plain object).
 * No clause (or an empty one) holds; a clause the grammar cannot read does
 * not, nor does a non-string one or one whose lookup throws. Never throws.
 */
export function evaluateWhen(clause: string | undefined, context: ContextLookup | ReadonlyMap<string, ContextValue> | Record<string, ContextValue>): boolean {
  if (clause === undefined || clause === null) return true;
  if (typeof clause !== 'string') return false;
  if (clause.trim() === '') return true;
  try {
    return evaluateNode(parseWhenClause(clause), lookupOf(context));
  } catch {
    return false;
  }
}
