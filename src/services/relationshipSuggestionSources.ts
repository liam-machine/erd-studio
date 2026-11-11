/**
 * Evidence adapters for relationship suggestions (`relationshipSuggestions.ts`): sources that say more than
 * names do. Each is a pure function from what the host already reads to suggestions of the same shape, and
 * `mergeSuggestions` folds them into the naming rules' list (a link found twice is one suggestion, with the
 * stronger band and both sets of reasons).
 *
 * - dbt `relationships` tests (`suggestionsFromDbtTests`): the tests the physical stage and Import from dbt
 *   already read (`YmlParserService` → `YmlData.relationshipTests`, `ManifestService` → `relationshipTests`).
 *   They are the project's own statement of a foreign key, not a guess: strong, direction from the test
 *   (the tested column is the foreign key). A conditional test (`relationships_where`, a `where:` config) is
 *   likely: it holds for some rows only.
 * - Joins in SQL text (`suggestionsFromSqlJoins`): `JOIN <relation> [AS] <alias> ON a.x = b.y` (and `AND`
 *   chains, `USING (x)`) between two relations that resolve to tables in the model, from dbt model SQL, view
 *   definitions or saved queries. A join shows the columns are used together, not which way the key runs, so
 *   it is likely when key evidence orients it and possible when nothing does. Relations it cannot resolve
 *   (CTEs, subqueries, tables outside the model) are skipped, never guessed.
 *
 * Pure: no `vscode`, no Node built-ins.
 */

import { linkKey, orientLink, type LinkEnd } from '@erd-studio/core';
import type { Relationship, SemanticTable } from '../types/semantic';
import { bandRank, sortSuggestions, tableKeysForSuggestions, type RelationshipSuggestion, type SuggestInput, type SuggestOptions } from './relationshipSuggestions';

const lower = (s: string): string => s.trim().toLowerCase();

/** Existing links (input relationships and each table's own), by core's linkKey. */
function existingLinks(input: SuggestInput): Set<string> {
  const out = new Set<string>();
  for (const r of input.relationships ?? []) out.add(linkKey(r));
  for (const t of input.tables) for (const r of t.relationships ?? []) out.add(linkKey({ ...r, fromModel: t.name } as Relationship));
  return out;
}

/** Table and column lookup without case, returning the model's own spelling. */
function resolver(tables: readonly SemanticTable[]): {
  table: (name: string) => SemanticTable | undefined;
  column: (t: SemanticTable, name: string) => string | undefined;
} {
  const byName = new Map<string, SemanticTable>();
  for (const t of tables) {
    if (!byName.has(lower(t.name))) byName.set(lower(t.name), t);
    if (t.alias && !byName.has(lower(t.alias))) byName.set(lower(t.alias), t);
  }
  return {
    table: (name) => byName.get(lower(name)),
    column: (t, name) => (t.columns ?? []).find((c) => lower(c.name) === lower(name))?.name,
  };
}

// ---------------------------------------------------------------------------
// dbt relationships tests
// ---------------------------------------------------------------------------

/** A dbt `relationships` test as `YmlRelationshipTest` / `ManifestRelationshipTest` carry it. */
export interface DbtRelationshipTestLike {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  conditional?: true;
  file?: string;
  line?: number;
}

export function suggestionsFromDbtTests(tests: readonly DbtRelationshipTestLike[], input: SuggestInput): RelationshipSuggestion[] {
  const existing = existingLinks(input);
  const find = resolver(input.tables);
  const out = new Map<string, RelationshipSuggestion>();
  for (const t of tests) {
    const from = find.table(t.fromModel);
    const to = find.table(t.toModel);
    if (!from || !to) continue;
    const fromColumn = find.column(from, t.fromColumn);
    const toColumn = find.column(to, t.toColumn);
    if (!fromColumn || !toColumn || (from === to && lower(fromColumn) === lower(toColumn))) continue;
    const id = linkKey({ fromModel: from.name, fromColumn, toModel: to.name, toColumn });
    if (existing.has(id)) continue;
    const where = t.file ? ` (${t.file}${t.line ? `:${t.line}` : ''})` : '';
    const suggestion: RelationshipSuggestion = {
      id,
      fromModel: from.name,
      toModel: to.name,
      pairs: [{ fromColumn, toColumn }],
      cardinality: 'many-to-one',
      direction: 'decided',
      directionBasis: 'dbt',
      band: t.conditional ? 'likely' : 'strong',
      rules: ['dbt-test'],
      keyInferred: false,
      reasons: [
        `a dbt relationships test checks ${from.name}.${fromColumn} against ${to.name}.${toColumn}${where}`,
        ...(t.conditional ? ['the test holds only for some rows (it has a condition)'] : []),
      ],
    };
    const prior = out.get(id);
    if (!prior || bandRank(suggestion.band) < bandRank(prior.band)) out.set(id, suggestion);
  }
  return sortSuggestions([...out.values()]);
}

// ---------------------------------------------------------------------------
// Joins in SQL text
// ---------------------------------------------------------------------------

export interface SqlJoinPair {
  left: { relation: string; column: string };
  right: { relation: string; column: string };
}

const IDENT = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const unquote = (s: string): string => s.replace(/^["`[]|["`\]]$/g, '');
const RESERVED = new Set(['on', 'using', 'where', 'inner', 'left', 'right', 'full', 'cross', 'join', 'outer', 'natural', 'group', 'order', 'limit', 'union', 'having', 'lateral', 'window', 'qualify', 'as', 'select', 'with']);

/** Comments, string literals and Jinja comments out; `{{ ref('x') }}` / `{{ source('s', 'x') }}` in as plain names. */
function normaliseSql(sql: string): string {
  return sql
    .replace(/\{#[\s\S]*?#\}/g, ' ')
    .replace(/\{\{\s*ref\s*\(\s*(?:'[^']*'\s*,\s*)?'([^']+)'\s*(?:,[^)]*)?\)\s*\}\}/gi, ' $1 ')
    .replace(/\{\{\s*ref\s*\(\s*(?:"[^"]*"\s*,\s*)?"([^"]+)"\s*(?:,[^)]*)?\)\s*\}\}/gi, ' $1 ')
    .replace(/\{\{\s*source\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi, ' $1 ')
    .replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * The equality join conditions in one SQL text, with each side's relation resolved through its alias:
 * `FROM a AS x JOIN b y ON x.k = y.k AND y.z = x.z`, `JOIN b USING (k)`. Only conditions whose two sides are
 * `alias.column` on two different relations of the same query block are kept. Names are as written
 * (schema-qualified names keep only the table part).
 */
export function extractSqlJoins(sql: string): SqlJoinPair[] {
  const text = normaliseSql(sql);
  const out: SqlJoinPair[] = [];
  // alias → relation, per text (aliases are usually unique within one model's SQL; a clash is dropped).
  const aliases = new Map<string, string | null>();
  const relRe = new RegExp(String.raw`\b(from|join)\s+((?:${IDENT}\s*\.\s*){0,2}${IDENT})(?:\s+(?:as\s+)?(${IDENT}))?`, 'gi');
  const order: Array<{ index: number; relation: string }> = [];
  for (let m = relRe.exec(text); m; m = relRe.exec(text)) {
    const relation = unquote(m[2].split('.').pop()!.trim());
    if (RESERVED.has(relation.toLowerCase()) || relation === '(') continue;
    const aliasRaw = m[3] && !RESERVED.has(m[3].toLowerCase()) ? unquote(m[3]) : relation;
    const key = aliasRaw.toLowerCase();
    if (aliases.has(key) && aliases.get(key) !== relation) aliases.set(key, null);
    else aliases.set(key, relation);
    if (!aliases.has(relation.toLowerCase())) aliases.set(relation.toLowerCase(), relation);
    order.push({ index: m.index, relation });
  }
  const rel = (alias: string): string | undefined => aliases.get(alias.toLowerCase()) ?? undefined;

  // ON clauses: from each ON to the next clause keyword.
  const onRe = /\bon\b([\s\S]*?)(?=\b(?:inner|left|right|full|cross|join|where|group|order|limit|union|having|qualify|window)\b|\)|;|$)/gi;
  const eqRe = new RegExp(String.raw`(${IDENT})\s*\.\s*(${IDENT})\s*=\s*(${IDENT})\s*\.\s*(${IDENT})`, 'g');
  for (let m = onRe.exec(text); m; m = onRe.exec(text)) {
    for (let e = eqRe.exec(m[1]); e; e = eqRe.exec(m[1])) {
      const l = rel(unquote(e[1]));
      const r = rel(unquote(e[3]));
      if (!l || !r || l.toLowerCase() === r.toLowerCase()) continue;
      out.push({ left: { relation: l, column: unquote(e[2]) }, right: { relation: r, column: unquote(e[4]) } });
    }
  }
  // USING (a, b): the joined relation against the relation named just before it.
  const usingRe = new RegExp(String.raw`\bjoin\s+((?:${IDENT}\s*\.\s*){0,2}${IDENT})(?:\s+(?:as\s+)?${IDENT})?\s+using\s*\(([^)]*)\)`, 'gi');
  for (let m = usingRe.exec(text); m; m = usingRe.exec(text)) {
    const joined = unquote(m[1].split('.').pop()!.trim());
    const before = order.filter((o) => o.index < m!.index).pop();
    if (!before || before.relation.toLowerCase() === joined.toLowerCase()) continue;
    for (const c of m[2].split(',').map((x) => unquote(x.trim())).filter(Boolean)) {
      out.push({ left: { relation: before.relation, column: c }, right: { relation: joined, column: c } });
    }
  }
  return out;
}

/**
 * Suggestions from the joins in some SQL texts (`sources`: one text per model, view or query). Each join
 * pair is oriented by key evidence (declared keys, then the naming rules' inferred keys); a pair joining two
 * non-key columns, or two keys nothing orders, is possible and undecided.
 */
export function suggestionsFromSqlJoins(sources: ReadonlyArray<{ name: string; sql: string }>, input: SuggestInput, options: Pick<SuggestOptions, 'inferKeys' | 'dbtKeyIndex'> = {}): RelationshipSuggestion[] {
  const existing = existingLinks(input);
  const find = resolver(input.tables);
  const keysOf = new Map<SemanticTable, Array<{ columns: string[]; source: string }>>();
  const keys = (t: SemanticTable): Array<{ columns: string[]; source: string }> => {
    let k = keysOf.get(t);
    if (!k) { k = tableKeysForSuggestions(t, options); keysOf.set(t, k); }
    return k;
  };
  const seen = new Map<string, { s: RelationshipSuggestion; where: Set<string> }>();
  for (const { name, sql } of sources) {
    for (const j of extractSqlJoins(sql)) {
      const a = find.table(j.left.relation);
      const b = find.table(j.right.relation);
      if (!a || !b || a === b) continue;
      const ac = find.column(a, j.left.column);
      const bc = find.column(b, j.right.column);
      if (!ac || !bc) continue;
      const id = linkKey({ fromModel: a.name, fromColumn: ac, toModel: b.name, toColumn: bc });
      if (existing.has(id)) continue;
      const prior = seen.get(id);
      if (prior) { prior.where.add(name); continue; }
      const end = (t: SemanticTable, c: string): LinkEnd => {
        const ks = keys(t);
        const whole = ks.some((k) => k.columns.length === 1 && lower(k.columns[0]) === lower(c));
        return { model: t.name, columns: [c], evidence: whole ? 'whole-key' : ks.length > 0 ? 'not-key' : 'unknown', declaredFk: false, source: whole ? 'keys' : 'none' };
      };
      const o = orientLink(end(a, ac), end(b, bc));
      const decided = o.decided && o.cardinality !== 'many-to-many';
      const [from, fc, to, tc] = decided && o.from.model === b.name && o.from.columns[0] === bc ? [b, bc, a, ac] : [a, ac, b, bc];
      const inferred = keys(to).some((k) => k.source === 'inferred' && k.columns.length === 1 && lower(k.columns[0]) === lower(tc));
      seen.set(id, {
        where: new Set([name]),
        s: {
          id,
          fromModel: from.name,
          toModel: to.name,
          pairs: [{ fromColumn: fc, toColumn: tc }],
          cardinality: o.cardinality === 'one-to-one' ? 'one-to-one' : 'many-to-one',
          direction: decided ? 'decided' : 'undecided',
          directionBasis: decided ? (inferred ? 'inferred-key' : 'keys') : 'none',
          band: decided && !inferred ? 'likely' : 'possible',
          rules: ['sql-join'],
          keyInferred: inferred,
          reasons: [],
        },
      });
    }
  }
  return sortSuggestions([...seen.values()].map(({ s, where }) => {
    const names = [...where].sort();
    const listed = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
    s.reasons = [`${s.fromModel}.${s.pairs[0].fromColumn} is joined to ${s.toModel}.${s.pairs[0].toColumn} in ${listed}`, ...(s.direction === 'undecided' ? ['nothing says which way it points'] : [])];
    return s;
  }));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** One list from several: a link found by more than one source is one suggestion, at the strongest band, with every reason. */
export function mergeSuggestions(...lists: ReadonlyArray<readonly RelationshipSuggestion[]>): RelationshipSuggestion[] {
  const out = new Map<string, RelationshipSuggestion>();
  for (const list of lists) {
    for (const s of list) {
      const prior = out.get(s.id);
      if (!prior) { out.set(s.id, { ...s, rules: [...s.rules], reasons: [...s.reasons] }); continue; }
      // A decided source beats an undecided one; a stronger band wins; reasons and rules accumulate.
      const better = (s.direction === 'decided' && prior.direction === 'undecided') || (s.direction === prior.direction && bandRank(s.band) < bandRank(prior.band));
      const base = better ? { ...s } : { ...prior };
      base.rules = [...new Set([...(better ? s.rules : prior.rules), ...(better ? prior.rules : s.rules)])];
      base.reasons = [...new Set([...(better ? s.reasons : prior.reasons), ...(better ? prior.reasons : s.reasons)])].filter((r) => base.direction === 'undecided' || r !== 'nothing says which way it points');
      out.set(s.id, base);
    }
  }
  return sortSuggestions([...out.values()]);
}
