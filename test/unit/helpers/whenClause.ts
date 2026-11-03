/**
 * A small evaluator for VS Code `when` clauses, enough for the clauses
 * package.json contributes: `! && || ( ) == != =~ /re/flags`, bare keys,
 * quoted and bare values, `true` / `false` and numbers.
 *
 * `ctx` holds context-key values (an absent key is undefined, so falsy, as
 * in VS Code). A comparison whose key is listed in `wildcards` (view,
 * viewItem, focusedView, resourceLangId: they depend on where the user
 * clicks, not on the folder) evaluates to true, read as "true in some view".
 * Wildcards are only sound outside a `!`, so a negated wildcard throws.
 */
export type WhenContext = Record<string, unknown>;

type Token = { kind: 'op' | 'word' | 'regex' | 'string'; value: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    const two = expr.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '=~', '<=', '>='].includes(two)) { tokens.push({ kind: 'op', value: two }); i += 2; continue; }
    if ('!()<>'.includes(ch)) { tokens.push({ kind: 'op', value: ch }); i++; continue; }
    if (ch === '/' && tokens.at(-1)?.value === '=~') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== '/') { j += expr[j] === '\\' ? 2 : 1; }
      let k = j + 1;
      while (k < expr.length && /[a-z]/.test(expr[k])) { k++; }
      tokens.push({ kind: 'regex', value: expr.slice(i, k) });
      i = k;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = expr.indexOf(ch, i + 1);
      if (end < 0) { throw new Error(`unterminated string in: ${expr}`); }
      tokens.push({ kind: 'string', value: expr.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < expr.length && !/[\s!()&|=<>]/.test(expr[j])) { j++; }
    if (j === i) { throw new Error(`cannot read "${expr.slice(i)}" in: ${expr}`); }
    tokens.push({ kind: 'word', value: expr.slice(i, j) });
    i = j;
  }
  return tokens;
}

function literal(token: Token): unknown {
  if (token.kind === 'string') { return token.value; }
  if (token.value === 'true') { return true; }
  if (token.value === 'false') { return false; }
  if (/^-?\d+(\.\d+)?$/.test(token.value)) { return Number(token.value); }
  return token.value;
}

export function evalWhen(expr: string | undefined, ctx: WhenContext, wildcards: ReadonlySet<string> = new Set()): boolean {
  if (expr === undefined || expr.trim() === '') { return true; }
  const tokens = tokenize(expr);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  const primary = (negated: boolean): boolean => {
    const t = take();
    if (!t) { throw new Error(`unexpected end of: ${expr}`); }
    if (t.value === '!' && t.kind === 'op') { return !primary(!negated); }
    if (t.value === '(' && t.kind === 'op') {
      const v = or(negated);
      if (take()?.value !== ')') { throw new Error(`missing ) in: ${expr}`); }
      return v;
    }
    if (t.kind !== 'word') { throw new Error(`unexpected "${t.value}" in: ${expr}`); }
    if (t.value === 'true') { return true; }
    if (t.value === 'false') { return false; }
    const key = t.value;
    const op = peek();
    if (op && op.kind === 'op' && ['==', '!=', '=~', '<', '>', '<=', '>='].includes(op.value)) {
      take();
      const rhs = take();
      if (!rhs) { throw new Error(`missing value in: ${expr}`); }
      if (wildcards.has(key)) {
        if (negated) { throw new Error(`a negated ${key} comparison cannot be a wildcard: ${expr}`); }
        return true;
      }
      const left = ctx[key];
      switch (op.value) {
        case '==': return left === literal(rhs) || String(left) === String(literal(rhs));
        case '!=': return !(left === literal(rhs) || String(left) === String(literal(rhs)));
        case '=~': {
          const m = /^\/(.*)\/([a-z]*)$/.exec(rhs.value);
          if (!m) { throw new Error(`=~ needs a regex in: ${expr}`); }
          return typeof left === 'string' && new RegExp(m[1], m[2]).test(left);
        }
        case '<': return Number(left) < Number(literal(rhs));
        case '>': return Number(left) > Number(literal(rhs));
        case '<=': return Number(left) <= Number(literal(rhs));
        default: return Number(left) >= Number(literal(rhs));
      }
    }
    if (wildcards.has(key)) { throw new Error(`bare wildcard key ${key} in: ${expr}`); }
    return Boolean(ctx[key]);
  };
  const and = (negated: boolean): boolean => {
    let v = primary(negated);
    while (peek()?.value === '&&') { take(); const r = primary(negated); v = v && r; }
    return v;
  };
  const or = (negated: boolean): boolean => {
    let v = and(negated);
    while (peek()?.value === '||') { take(); const r = and(negated); v = v || r; }
    return v;
  };
  const result = or(false);
  if (pos !== tokens.length) { throw new Error(`trailing "${tokens[pos].value}" in: ${expr}`); }
  return result;
}
