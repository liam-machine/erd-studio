/**
 * The sidebar's keyword filter: one query syntax for the Diagrams, Table
 * Library and Relationships views and for Go to Table….
 *
 * - Plain words must all match (AND), as a case-insensitive substring of a
 *   row's name or of what that view searches (an owner, a note, a member
 *   table…). `"order line"` keeps a phrase together; `-word` excludes.
 * - `key:value` narrows to one field (`layer:gold`, `owner:"data team"`,
 *   `col:customer_id`, `is:unused`). A key the view does not know falls back
 *   to plain text and is reported, so the view can say so.
 *
 * Pure (no `vscode`): the views describe each row as a {@link SearchSubject}
 * and ask {@link matchTreeQuery} whether it matches, which ranges of its
 * label to highlight and why it matched when its name did not.
 */

/** The qualifiers a query may use. */
export type FilterKey = 'layer' | 'schema' | 'owner' | 'type' | 'col' | 'table' | 'diagram' | 'file' | 'is';

/** What `is:` can ask about a row. */
export type FilterFlag = 'unused' | 'problem' | 'cross-layer' | 'composite';

const ALL_KEYS: readonly FilterKey[] = ['layer', 'schema', 'owner', 'type', 'col', 'table', 'diagram', 'file', 'is'];

/** Other spellings of a key, read as the key. */
const KEY_ALIASES: Readonly<Record<string, FilterKey>> = {
  column: 'col',
  columns: 'col',
  role: 'type',
  domain: 'diagram',
};

/** Which keys (and `is:` flags) a view understands. */
export interface FilterSpec {
  readonly keys: readonly FilterKey[];
  readonly flags: readonly FilterFlag[];
}

/** The Diagrams view: a diagram's name, layer, description and member tables. */
export const DIAGRAMS_FILTER: FilterSpec = { keys: ['layer', 'schema', 'table', 'diagram'], flags: [] };
/** The Table Library (and Go to Table…). */
export const TABLE_LIBRARY_FILTER: FilterSpec = {
  keys: ['layer', 'schema', 'owner', 'type', 'col', 'table', 'diagram', 'is'],
  flags: ['unused'],
};
/** The Relationships view. */
export const RELATIONSHIPS_FILTER: FilterSpec = {
  keys: ['layer', 'schema', 'table', 'col', 'file', 'is'],
  flags: ['problem', 'cross-layer', 'composite'],
};

export interface FilterTerm {
  /** The qualifier; absent for a plain word or phrase. */
  readonly key?: FilterKey;
  /** What to look for, lower-cased. */
  readonly value: string;
  /** The term as typed (without its `-`), for messages. */
  readonly text: string;
  readonly negated: boolean;
  /** For `is:`, the flags its value names (a prefix names every flag it starts: `is:c`). */
  readonly flags?: readonly FilterFlag[];
}

export interface TreeQuery {
  /** The query as typed, trimmed. */
  readonly text: string;
  readonly terms: readonly FilterTerm[];
  /** What the view could not use: `unknown filter key "foo:"`, an `is:` value it has no flag for. */
  readonly warnings: readonly string[];
}

/** The query with nothing in it: every row shows. */
export const EMPTY_QUERY: TreeQuery = { text: '', terms: [], warnings: [] };

/** Whether `query` filters nothing (no terms: an empty box, or only a key still being typed). */
export function isEmptyQuery(query: TreeQuery | undefined): boolean {
  return !query || query.terms.length === 0;
}

/** Whether any term of `query` (included or excluded) uses `key`. */
export function queryUses(query: TreeQuery | undefined, key: FilterKey): boolean {
  return !!query && query.terms.some((t) => t.key === key);
}

/**
 * Whether `query` is more than one plain word: a qualifier, a phrase, an
 * exclusion or several words. Go to Table… leaves a single word to the
 * QuickPick's own (fuzzy) matching and matches anything else itself.
 */
export function isStructuredQuery(query: TreeQuery): boolean {
  if (query.terms.length === 0) return false;
  if (query.terms.length > 1) return true;
  const [term] = query.terms;
  return term.key !== undefined || term.negated || /\s|"/.test(term.text);
}

const isSpace = (c: string): boolean => /\s/.test(c);

/** Read a `"quoted"` value starting at `s[i] === '"'`; an unclosed quote runs to the end. */
function readQuoted(s: string, i: number): { value: string; end: number } {
  const close = s.indexOf('"', i + 1);
  return close === -1 ? { value: s.slice(i + 1), end: s.length } : { value: s.slice(i + 1, close), end: close + 1 };
}

function readBare(s: string, i: number): { value: string; end: number } {
  let end = i;
  while (end < s.length && !isSpace(s[end])) end++;
  return { value: s.slice(i, end), end };
}

/**
 * Read `text` as a query for a view that understands `spec`'s keys. A key
 * typed with no value yet (`layer:`) is left out, so the view does not empty
 * while it is being typed.
 */
export function parseTreeQuery(text: string, spec: FilterSpec = { keys: ALL_KEYS, flags: ['unused', 'problem', 'cross-layer', 'composite'] }): TreeQuery {
  const s = text;
  const terms: FilterTerm[] = [];
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message);
  };
  let i = 0;
  while (i < s.length) {
    if (isSpace(s[i])) {
      i++;
      continue;
    }
    let negated = false;
    if (s[i] === '-' && i + 1 < s.length && !isSpace(s[i + 1])) {
      negated = true;
      i++;
    }
    if (s[i] === '"') {
      const { value, end } = readQuoted(s, i);
      i = end;
      const trimmed = value.trim();
      if (trimmed) terms.push({ value: trimmed.toLowerCase(), text: `"${trimmed}"`, negated });
      continue;
    }
    const key = /^([A-Za-z][A-Za-z-]*):/.exec(s.slice(i));
    if (!key) {
      const { value, end } = readBare(s, i);
      i = end;
      if (value) terms.push({ value: value.toLowerCase(), text: value, negated });
      continue;
    }
    i += key[0].length;
    const { value: raw, end } = s[i] === '"' ? readQuoted(s, i) : readBare(s, i);
    i = end;
    const value = raw.trim();
    if (!value) continue;
    const typed = key[1];
    const named = KEY_ALIASES[typed.toLowerCase()] ?? (ALL_KEYS as readonly string[]).find((k) => k === typed.toLowerCase()) as FilterKey | undefined;
    const shown = /\s/.test(value) ? `${typed}:"${value}"` : `${typed}:${value}`;
    if (!named || !spec.keys.includes(named)) {
      // Not a filter here: searched as the text it is, and said.
      warn(named ? `"${typed}:" doesn't filter this view` : `unknown filter key "${typed}:"`);
      terms.push({ value: `${typed}:${value}`.toLowerCase(), text: shown, negated });
      continue;
    }
    if (named === 'is') {
      const wanted = value.toLowerCase();
      const flags = spec.flags.filter((f) => f.startsWith(wanted));
      if (flags.length === 0) {
        warn(`"is:${value}" is not a filter here${spec.flags.length > 0 ? ` (try ${spec.flags.map((f) => `is:${f}`).join(', ')})` : ''}`);
      }
      terms.push({ key: 'is', value: wanted, text: shown, negated, flags });
      continue;
    }
    terms.push({ key: named, value: value.toLowerCase(), text: shown, negated });
  }
  return { text: text.trim(), terms, warnings };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** One thing a row can be found by. */
export interface SearchFacet {
  /** The qualifier that searches it (`col:` a column, `owner:` the owner). */
  readonly key?: FilterKey;
  /** Whether plain words search it too (default true). */
  readonly text?: boolean;
  /**
   * How the row says it matched this way (`column customer_id`, `on sales`),
   * given the value that matched. Absent for what the row already shows.
   */
  readonly reason?: (value: string) => string;
  readonly values: ReadonlyArray<string | undefined>;
}

/** A row, as the filter sees it. */
export interface SearchSubject {
  /** The row's label: plain words match it, and are highlighted in it. */
  readonly name: string;
  /** Qualifiers that match the label too (`table:` a table's name, `diagram:` a diagram's). */
  readonly nameKeys?: readonly FilterKey[];
  readonly facets: readonly SearchFacet[];
  readonly flags?: readonly FilterFlag[];
}

export interface TreeMatch {
  /** Ranges of the label to highlight: `[start, end)`, sorted, never overlapping. */
  readonly highlights: ReadonlyArray<[number, number]>;
  /** Why the row matched where its name did not: `column customer_id`, `has dim_customer`. */
  readonly reasons: readonly string[];
}

type Hit = { range?: [number, number]; reason?: string };

function hitIn(term: FilterTerm, subject: SearchSubject): Hit | undefined {
  if (term.key === 'is') {
    const flags = subject.flags ?? [];
    return (term.flags ?? []).some((f) => flags.includes(f)) ? {} : undefined;
  }
  if (term.key === undefined || subject.nameKeys?.includes(term.key)) {
    const at = subject.name.toLowerCase().indexOf(term.value);
    if (at !== -1) return { range: [at, at + term.value.length] };
  }
  for (const facet of subject.facets) {
    if (term.key === undefined ? facet.text === false : facet.key !== term.key) continue;
    for (const value of facet.values) {
      if (value && value.toLowerCase().includes(term.value)) return { reason: facet.reason?.(value) };
    }
  }
  return undefined;
}

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Whether `subject` matches every included term and none of the excluded
 * ones; undefined when it does not. An empty query matches everything.
 */
export function matchTreeQuery(query: TreeQuery, subject: SearchSubject): TreeMatch | undefined {
  const ranges: Array<[number, number]> = [];
  const reasons: string[] = [];
  for (const term of query.terms) {
    const hit = hitIn(term, subject);
    if (term.negated) {
      if (hit) return undefined;
      continue;
    }
    if (!hit) return undefined;
    if (hit.range) ranges.push(hit.range);
    else if (hit.reason && !reasons.includes(hit.reason)) reasons.push(hit.reason);
  }
  return { highlights: mergeRanges(ranges), reasons };
}

/**
 * The ranges of `label` the query's plain words (and `nameKeys`) name: for a
 * row kept only because something under it matched (a layer, a schema).
 */
export function labelHighlights(query: TreeQuery | undefined, label: string, nameKeys: readonly FilterKey[] = []): Array<[number, number]> {
  if (!query) return [];
  const lower = label.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const term of query.terms) {
    if (term.negated || (term.key !== undefined && !nameKeys.includes(term.key))) continue;
    const at = lower.indexOf(term.value);
    if (at !== -1) ranges.push([at, at + term.value.length]);
  }
  return mergeRanges(ranges);
}

/** A row's description with why it matched after it: `on 2 diagrams · column customer_id`. */
export function withReasons(description: string | undefined, reasons: readonly string[], max = 2): string | undefined {
  if (reasons.length === 0) return description;
  const why = reasons.slice(0, max).join(' · ');
  return description ? `${description} · ${why}` : why;
}

// ---------------------------------------------------------------------------
// Table roles
// ---------------------------------------------------------------------------

/** The canvas's label for each table role (the renderer's `ROLE_OPTIONS`). */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  'conformed-dim': 'Conformed dimension',
  'domain-dim': 'Local dimension',
  'transaction-fact': 'Transaction fact',
  'periodic-snapshot': 'Periodic snapshot',
  'accumulating-snapshot': 'Accumulating snapshot',
  'factless-fact': 'Factless fact (bridge)',
  reference: 'Reference',
  'gold-fact': 'Pre-joined fact',
  'gold-dim': 'Flattened dimension',
};

/**
 * What `type:` finds a table by: its role's label first (what a match
 * reports), then the role as stored and the family it is in (`fact`, `dim`,
 * `bridge`…), so `type:fact` finds every kind of fact and `type:conformed` a
 * conformed dimension. Empty without a role.
 */
export function tableRoleValues(role: string | undefined): string[] {
  if (!role) return [];
  const key = role.trim().toLowerCase();
  const values = [ROLE_LABELS[key] ?? role, role];
  if (/dim/.test(key)) values.push('dimension');
  if (/fact|snapshot/.test(key)) values.push('fact');
  if (/factless|bridge/.test(key)) values.push('bridge');
  if (/reference|lookup/.test(key)) values.push('lookup');
  return values;
}

/** What the Table Library and Go to Table… know of a table, for {@link tableSearchSubject}. */
export interface TableSearchInput {
  readonly name: string;
  /** The warehouse name. */
  readonly alias?: string;
  readonly schema?: string;
  /** The layer id, and its label. */
  readonly layer?: string;
  readonly layerLabel?: string;
  readonly owner?: string;
  /** The role as stored (`conformed-dim`). */
  readonly role?: string;
  readonly description?: string;
  /** Column names; known once the table's file has been read. */
  readonly columns?: readonly string[];
  /** The diagrams that show it. */
  readonly diagrams: readonly string[];
  /** A duplicate file that is ignored: never `is:unused`. */
  readonly ignored?: boolean;
}

/**
 * A table as the Table Library and Go to Table… search it. Plain words: its
 * name, warehouse name, schema, layer (id or label), owner, role and
 * description. `col:` its columns and `diagram:` the diagrams that show it
 * (only by key); `is:unused` a table on no diagram.
 */
export function tableSearchSubject(table: TableSearchInput): SearchSubject {
  const roles = tableRoleValues(table.role);
  return {
    name: table.name,
    nameKeys: ['table'],
    facets: [
      { key: 'table', values: [table.alias] },
      { key: 'schema', values: [table.schema] },
      { key: 'layer', values: [table.layer, table.layerLabel] },
      { key: 'owner', values: [table.owner] },
      { key: 'type', values: roles, reason: () => roles[0] },
      { values: [table.description], reason: () => 'in description' },
      { key: 'col', text: false, values: table.columns ?? [], reason: (v) => `column ${v}` },
      { key: 'diagram', text: false, values: table.diagrams, reason: (v) => `on ${v}` },
    ],
    flags: !table.ignored && table.diagrams.length === 0 ? ['unused'] : [],
  };
}

// ---------------------------------------------------------------------------
// The view's words
// ---------------------------------------------------------------------------

/** What a view filters, in its own words. */
export interface FilterNoun {
  readonly one: string;
  readonly many: string;
}

/** What a filtered listing found, for the view's message. */
export interface FilterOutcome {
  readonly query: TreeQuery;
  /** Rows of the view's own kind that match (tables, diagrams, relationships). */
  readonly shown: number;
  readonly total: number;
  /** Table files are still being read for a `col:` term: more may match. */
  readonly reading?: boolean;
}

/**
 * The TreeView message while filtered: `Filtered: "cust layer:gold" — 4 of 52
 * tables`, or `No tables match "…"`, then anything the view could not use.
 */
export function describeFilterOutcome(outcome: FilterOutcome, noun: FilterNoun): string {
  const { query, shown, total } = outcome;
  const head = shown === 0
    ? `No ${noun.many} match "${query.text}"`
    : `Filtered: "${query.text}" — ${shown} of ${total} ${total === 1 ? noun.one : noun.many}`;
  const tail = [...query.warnings, ...(outcome.reading ? ['reading table files…'] : [])];
  return tail.length > 0 ? `${head} · ${tail.join(' · ')}` : head;
}

/** The filter box's prompt for a view: how words work and the keys it knows. */
export function filterPrompt(spec: FilterSpec): string {
  const keys = spec.keys.filter((k) => k !== 'is').map((k) => `${k}:`);
  const flags = spec.flags.map((f) => `is:${f}`);
  return `Every word must match · "a phrase" · -exclude · ${[...keys, ...flags].join(' ')}`;
}
