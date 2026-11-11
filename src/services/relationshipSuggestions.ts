/**
 * Relationship suggestions: after an import, a model is mostly tables with no
 * lines (a lakehouse declares almost no keys). This proposes the relationships
 * the names, keys and types point at, each with a confidence band and its
 * reasons in plain words, for the user to accept or reject. A suggestion is
 * never drawn or written as fact: accepting one goes through the ordinary
 * relationship write path (`planRelationshipWrite`), and nothing is stored for
 * the ones not accepted.
 *
 * Pure: no `vscode`, no Node built-ins (it can move to `@erd-studio/core`).
 * Deterministic: the same input gives the same suggestions in the same order.
 * Linear-ish: every lookup goes through an index built once (keys by name,
 * tables by entity, column-name counts, composite keys by their rarest column),
 * so the work is proportional to the number of columns times their word count.
 *
 * Rules (each can be switched off, so each can be measured alone):
 * - `key-name`      the column has the name of another table's single-column key (`customer_id` → customer.customer_id).
 * - `table-name`    the column is `<table>_id` / `_key` / `_code` / `_no` / `fk_<table>` / `<table>Id` … and that table
 *                   has a key (`customer_id` → customers.id). A table sharing the column's table's name prefix wins
 *                   (`comfy_cms_files.site_id` → comfy_cms_sites, not sites).
 * - `hub`           the column appears in three or more tables and exactly one of them is named for it.
 * - `role-playing`  a role in front of the name of the table it points at (`ship_date_key` → dim_date.date_key,
 *                   `from_currency` → currency.currency_code), a person's role (`creator_id` → users.id when users is
 *                   the only people table), or a self reference (`manager_id` in employees, `parent_id`).
 * - `composite`     the table has every column of another table's composite primary key, by name.
 * Filters (also switchable): the type check (`typeCheck`), and the suppression (`suppress`) of bookkeeping columns,
 * generic names, a table's own identifier, copies of one entity pointing at each other, and copies (raw_ /
 * _bak / _p2022_01 / _enriched …) of a table that is also there. Key inference (`inferKeys`): a table that declares
 * no key gets one from its naming (`<table>_id`, `<table>_key`, `id`, a first column named for the table), and
 * anything resting on an inferred key is one band lower.
 */

import { linkKey, orientLink, type DbtKeyIndex, type LinkEnd } from '@erd-studio/core';
import type { Relationship, SemanticTable } from '../types/semantic';
import {
  GENERIC_WORDS,
  PERSON_ENTITIES,
  PERSON_ROLES,
  SELF_PERSON_ROLES,
  STAFF_ENTITIES,
  columnReference,
  isAuditColumn,
  joinWords,
  keySuffixFamily,
  nameWords,
  singularWords,
  tableEntity,
  typeFamily,
  typeShape,
  typesCompatible,
  type KeySuffixFamily,
  type TypeFamily,
} from './relationshipNaming';

export type SuggestionBand = 'strong' | 'likely' | 'possible';
/** The naming rules (`suggestRelationships`), then the evidence adapters (`relationshipSuggestionSources.ts`). */
export type SuggestionRule = 'key-name' | 'table-name' | 'hub' | 'role-playing' | 'composite' | 'dbt-test' | 'sql-join';
export const NAMING_RULES: readonly SuggestionRule[] = ['key-name', 'table-name', 'hub', 'role-playing', 'composite'];
export const SUGGESTION_RULES: readonly SuggestionRule[] = [...NAMING_RULES, 'dbt-test', 'sql-join'];
export const SUGGESTION_BANDS: readonly SuggestionBand[] = ['strong', 'likely', 'possible'];

export interface SuggestionPair {
  fromColumn: string;
  toColumn: string;
}

export interface RelationshipSuggestion {
  /** Stable identity: core's `linkKey` of its pair (a composite's sorted pair keys joined). */
  id: string;
  /** The foreign key (many) side. When `direction` is `undecided`, just the end that was found first. */
  fromModel: string;
  toModel: string;
  /** One pair, or several for a composite foreign key (written as entries sharing a `compositeKey`). */
  pairs: SuggestionPair[];
  cardinality: 'many-to-one' | 'one-to-one';
  /** `undecided`: nothing says which end holds the foreign key; accepting it asks "Which way does this relationship point?". */
  direction: 'decided' | 'undecided';
  /** What decided the direction: declared keys, dbt's tests, a key inferred from naming, which table is named for the column, or nothing. */
  directionBasis: 'keys' | 'dbt' | 'inferred-key' | 'naming' | 'none';
  band: SuggestionBand;
  /** Every rule that supports it, in `SUGGESTION_RULES` order. */
  rules: SuggestionRule[];
  /** The `to` key was inferred from naming: no key is declared on that table. */
  keyInferred: boolean;
  /** Plain-words reasons, most telling first. */
  reasons: string[];
}

export interface SuggestOptions {
  /** The rules to run (default: all). */
  rules?: readonly SuggestionRule[];
  /** Drop pairs whose types cannot match (default true). */
  typeCheck?: boolean;
  /** Drop bookkeeping columns, generic names, copies and a table's own identifier (default true). */
  suppress?: boolean;
  /** Infer a key for a table that declares none (default true). */
  inferKeys?: boolean;
  /** dbt's key evidence (unique tests), when the folder is a dbt project. */
  dbtKeyIndex?: DbtKeyIndex;
}

export interface SuggestInput {
  tables: readonly SemanticTable[];
  /** Relationships that already exist (the diagram's, the library's). Each table's own `relationships` are read too. */
  relationships?: readonly Relationship[];
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

type KeySource = 'declared' | 'dbt' | 'inferred';
type KeyKind = 'primary' | 'unique' | 'natural' | 'inferred';

interface ColInfo {
  name: string;
  canon: string;
  words: string[];
  family: TypeFamily;
  shape: string;
  audit: boolean;
}

interface TableInfo {
  table: SemanticTable;
  name: string;
  words: string[];
  schema: string;
  /** Entity, joined (`customer` for dim_customers). */
  entity: string;
  /** The name had a copy marker (raw_, _bak, _p2022_01, …). */
  marked: boolean;
  /** A copy of another table in the input (marked, and an unmarked table has the same entity). */
  copy: boolean;
  /** The whole name's words, singular, joined (`dimcustomer`). */
  nameCanon: string;
  cols: ColInfo[];
  byCanon: Map<string, ColInfo>;
  /** Single-column keys by column canon. */
  singleKeys: Map<string, { col: ColInfo; source: KeySource; kind: KeyKind }>;
  /** The primary (or inferred) single-column key, if there is one. */
  mainKey?: ColInfo;
  compositeKeys: Array<{ cols: ColInfo[]; source: KeySource }>;
  declaresKeys: boolean;
  person: boolean;
}

const lower = (s: string): string => s.trim().toLowerCase();

function dbmlMeta(m: { meta?: unknown } | undefined): Record<string, unknown> {
  const meta = (m?.meta ?? {}) as Record<string, unknown>;
  const d = meta.dbml;
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
}

function colInfo(name: string, dataType: string | undefined): ColInfo {
  const words = nameWords(name);
  return { name, canon: joinWords(words), words, family: typeFamily(dataType), shape: typeShape(dataType), audit: isAuditColumn(name, words) };
}

const sameCols = (a: readonly ColInfo[], b: readonly ColInfo[]): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => y.canon === x.canon));

function buildTableInfo(table: SemanticTable, options: SuggestOptions): TableInfo {
  const cols = (table.columns ?? []).filter((c) => c && typeof c.name === 'string' && c.name.trim()).map((c) => ({ def: c, info: colInfo(c.name, c.dataType) }));
  const byCanon = new Map<string, ColInfo>();
  for (const { info } of cols) if (!byCanon.has(info.canon)) byCanon.set(info.canon, info);
  const ent = tableEntity(table.name, table.schema);
  const info: TableInfo = {
    table,
    name: table.name,
    words: nameWords(table.name),
    schema: lower(table.schema ?? ''),
    entity: joinWords(ent.words),
    marked: ent.copy,
    copy: false,
    nameCanon: joinWords(singularWords(nameWords(table.name))),
    cols: cols.map((c) => c.info),
    byCanon,
    singleKeys: new Map(),
    compositeKeys: [],
    declaresKeys: false,
    person: false,
  };
  info.person = PERSON_ENTITIES.has(info.entity) || PERSON_ENTITIES.has(ent.words[ent.words.length - 1] ?? '');

  // Declared keys: the primary key, the natural key, unique columns and single-column unique indexes.
  const pk = cols.filter((c) => c.def.isPrimaryKey).map((c) => c.info);
  const nk = cols.filter((c) => c.def.isNaturalKey).map((c) => c.info);
  if (pk.length === 1) info.singleKeys.set(pk[0].canon, { col: pk[0], source: 'declared', kind: 'primary' });
  if (pk.length > 1) info.compositeKeys.push({ cols: pk, source: 'declared' });
  if (nk.length === 1 && !info.singleKeys.has(nk[0].canon)) info.singleKeys.set(nk[0].canon, { col: nk[0], source: 'declared', kind: 'natural' });
  for (const c of cols) {
    if (dbmlMeta(c.def).unique === true && !info.singleKeys.has(c.info.canon)) info.singleKeys.set(c.info.canon, { col: c.info, source: 'declared', kind: 'unique' });
  }
  const indexes = dbmlMeta(table).indexes;
  let compositeUnique = false;
  if (Array.isArray(indexes)) {
    for (const ix of indexes as Array<Record<string, unknown>>) {
      if (!ix || (ix.unique !== true && ix.pk !== true) || !Array.isArray(ix.columns)) continue;
      const names = (ix.columns as unknown[]).map((c) => (typeof c === 'string' ? c : String((c as Record<string, unknown>)?.value ?? '')));
      const found = names.map((n) => byCanon.get(joinWords(nameWords(n))));
      if (found.some((f) => !f)) continue;
      const set = found as ColInfo[];
      if (set.length === 1 && !info.singleKeys.has(set[0].canon)) info.singleKeys.set(set[0].canon, { col: set[0], source: 'declared', kind: ix.pk === true ? 'primary' : 'unique' });
      if (set.length > 1 && ix.pk === true && !info.compositeKeys.some((k) => sameCols(k.cols, set))) info.compositeKeys.push({ cols: set, source: 'declared' });
      if (set.length > 1 && ix.pk !== true) compositeUnique = true;
    }
  }
  info.declaresKeys = info.singleKeys.size > 0 || info.compositeKeys.length > 0 || compositeUnique;

  // dbt's unique tests, for a table that declares nothing.
  const dbt = options.dbtKeyIndex;
  if (!info.declaresKeys && dbt) {
    for (const [column, hint] of dbt.columns.get(lower(table.name)) ?? []) {
      const c = byCanon.get(joinWords(nameWords(column)));
      if (c && hint.key === 'unique') info.singleKeys.set(c.canon, { col: c, source: 'dbt', kind: 'unique' });
    }
    for (const combo of dbt.combinations.get(lower(table.name)) ?? []) {
      const set = combo.map((n) => byCanon.get(joinWords(nameWords(n))));
      if (set.every(Boolean)) info.compositeKeys.push({ cols: set as ColInfo[], source: 'dbt' });
    }
    info.declaresKeys = info.singleKeys.size > 0 || info.compositeKeys.length > 0;
  }

  const keys = [...info.singleKeys.values()];
  info.mainKey = (keys.find((k) => k.kind === 'primary') ?? keys.find((k) => k.kind === 'natural') ?? (keys.length === 1 ? keys[0] : undefined))?.col;

  // Key inference, for a table that declares none.
  if (!info.declaresKeys && options.inferKeys !== false) {
    const inferred = inferKey(info, ent.words);
    if (inferred) {
      info.singleKeys.set(inferred.canon, { col: inferred, source: 'inferred', kind: 'inferred' });
      info.mainKey = inferred;
    }
  }
  return info;
}

/** The key a table's naming implies: `<table>_id` / `_key` / `_sk` / `_code` / `_no`, then `id` / `key`, then a first column named for the table. */
function inferKey(info: TableInfo, ent: readonly string[]): ColInfo | undefined {
  const usable = (c: ColInfo | undefined): c is ColInfo => !!c && c.family !== 'never' && !c.audit;
  const stems = [...new Set([info.entity, info.nameCanon, joinWords(info.words)])].filter(Boolean);
  // A warehouse surrogate (`_sk`, `_key`) before a source id (`_id`): dimensions carry both, and facts point at the surrogate.
  for (const suffix of ['sk', 'key', 'id', 'hk', 'code', 'no', 'number', 'uuid']) {
    for (const stem of stems) {
      const c = info.byCanon.get(stem + suffix);
      if (usable(c)) return c;
    }
  }
  for (const generic of ['id', 'key', 'pk', 'uuid']) {
    const c = info.byCanon.get(generic);
    if (usable(c)) return c;
  }
  const first = info.cols[0];
  if (!usable(first)) return undefined;
  // The first column named exactly for the table (the Date table's Date).
  if (stems.includes(first.canon)) return first;
  // The first column, when it carries the table's name (sha1_hub_customer in hub_customer).
  const hasRun = (outer: readonly string[], inner: readonly string[]): boolean =>
    inner.length > 0 && outer.some((_, i) => inner.every((w, j) => outer[i + j] === w));
  if (hasRun(first.words, info.words) || (ent.length > 0 && hasRun(first.words, ent) && keySuffixFamily(first.words[first.words.length - 1]))) return first;
  return undefined;
}

/** The keys a table has, as the suggestions read them (declared, from dbt, or inferred from naming). For the review UI. */
export function tableKeysForSuggestions(table: SemanticTable, options: Pick<SuggestOptions, 'inferKeys' | 'dbtKeyIndex'> = {}): Array<{ columns: string[]; source: KeySource }> {
  const info = buildTableInfo(table, options);
  return [
    ...[...info.singleKeys.values()].map((k) => ({ columns: [k.col.name], source: k.source })),
    ...info.compositeKeys.map((k) => ({ columns: k.cols.map((c) => c.name), source: k.source })),
  ];
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  from: TableInfo;
  fromCol: ColInfo;
  to: TableInfo;
  toCol: ColInfo;
  rules: Set<SuggestionRule>;
  /** Words in front of the reference (`ship` in ship_date_key), for a role-playing match. */
  role?: string[];
  /** The `to` table is named for what the column references. */
  ownerNamed: boolean;
  /** The `to` table shares the `from` table's name prefix (`comfy_cms_files` → `comfy_cms_sites`). */
  namespaced: boolean;
  /** A bare reference (`currency`, no `_id` / `_code`): weaker. */
  bare: boolean;
  /** The key's name does not follow the column's (`SalesPersonID` → SalesPerson.BusinessEntityID). */
  keyNamedDifferently: boolean;
  personRole?: string;
  hubCount?: number;
}

const refCanon = (words: readonly string[]): string => joinWords(singularWords(words));

/** Whether a reference with this suffix family may point at `key` of `to`, and whether the key is named otherwise. */
function suffixFits(ref: { family?: KeySuffixFamily }, key: ColInfo, to: TableInfo): { ok: boolean; differently: boolean } {
  const keyRef = columnReference(key.words);
  const keyStem = refCanon(keyRef.stem);
  // A bare generic key (`id`, `code`, `key`) or a key named for its table fits any identifying suffix.
  const keyNamedForTable = keyRef.stem.length === 0 || keyStem === to.entity || keyStem === to.nameCanon;
  if (!ref.family) return { ok: true, differently: !keyNamedForTable };
  if (!keyRef.family) return { ok: keyNamedForTable, differently: false };
  if (keyRef.family !== ref.family && keyRef.stem.length > 0) return { ok: false, differently: false };
  return { ok: true, differently: !keyNamedForTable };
}

export function suggestRelationships(input: SuggestInput, options: SuggestOptions = {}): RelationshipSuggestion[] {
  const rulesOn = new Set<SuggestionRule>(options.rules ?? NAMING_RULES);
  const typeCheck = options.typeCheck !== false;
  const suppress = options.suppress !== false;

  const tables = input.tables.map((t) => buildTableInfo(t, options));

  // Existing links, and the columns that already hold a foreign key.
  const existing = new Set<string>();
  const fkColumns = new Set<string>();
  const addExisting = (r: Relationship): void => {
    if (!r || typeof r.fromModel !== 'string' || typeof r.toModel !== 'string' || typeof r.fromColumn !== 'string' || typeof r.toColumn !== 'string') return;
    existing.add(linkKey(r));
    const fkAtTo = r.cardinality === 'one-to-many';
    fkColumns.add(`${lower(fkAtTo ? r.toModel : r.fromModel)}\u0000${lower(fkAtTo ? r.toColumn : r.fromColumn)}`);
  };
  for (const r of input.relationships ?? []) addExisting(r);
  for (const t of input.tables) for (const r of t.relationships ?? []) addExisting({ ...r, fromModel: t.name } as Relationship);

  // Indexes: single-column keys by name, tables by entity, how many tables have each column name.
  const keyIndex = new Map<string, TableInfo[]>();
  const entityIndex = new Map<string, TableInfo[]>();
  const columnCount = new Map<string, number>();
  const push = <T>(map: Map<string, T[]>, k: string, v: T): void => {
    const list = map.get(k);
    if (list) { if (!list.includes(v)) list.push(v); } else map.set(k, [v]);
  };
  for (const t of tables) {
    if (t.entity) push(entityIndex, t.entity, t);
    if (t.nameCanon && t.nameCanon !== t.entity) push(entityIndex, t.nameCanon, t);
    if (t.table.alias) push(entityIndex, joinWords(tableEntity(t.table.alias).words), t);
    for (const c of t.byCanon.keys()) columnCount.set(c, (columnCount.get(c) ?? 0) + 1);
  }
  // A copy is a marked table whose entity an unmarked table also has: it neither points nor is pointed at.
  for (const t of tables) t.copy = suppress && t.marked && (entityIndex.get(t.entity) ?? []).some((o) => o !== t && !o.marked);
  for (const t of tables) if (!t.copy) for (const k of t.singleKeys.keys()) push(keyIndex, k, t);
  const people = tables.filter((t) => t.person && t.mainKey && !t.copy);

  /** Tables a reference stem names: those sharing the from table's name prefix first (`comfy_cms_` + site). */
  const ownersFor = (from: TableInfo, stem: string): { tables: TableInfo[]; namespaced: boolean } => {
    if (!stem) return { tables: [], namespaced: false };
    for (let i = from.words.length - 1; i >= 1; i--) {
      const prefix = joinWords(from.words.slice(0, i));
      if (stem.startsWith(prefix)) continue;
      const hit = (entityIndex.get(prefix + stem) ?? []).filter((t) => t !== from && !t.copy && t.entity === prefix + stem && t.mainKey);
      if (hit.length > 0) return { tables: hit, namespaced: true };
    }
    return { tables: (entityIndex.get(stem) ?? []).filter((t) => !t.copy), namespaced: false };
  };

  const candidates: Candidate[] = [];
  for (const from of tables) {
    if (from.copy) continue;
    for (const col of from.cols) {
      if (fkColumns.has(`${lower(from.name)}\u0000${lower(col.name)}`)) continue;
      if (col.family === 'never') continue;
      if (suppress && col.audit) continue;
      const ref = columnReference(col.words);
      const stem = refCanon(ref.stem);
      // The table's own identifier (EmailAddress.EmailAddressID, customers.customer_id) points nowhere.
      if (suppress && stem && (stem === from.entity || stem === from.nameCanon)) continue;
      const found = new Map<string, Candidate>();
      const add = (to: TableInfo, toCol: ColInfo, rule: SuggestionRule, extra: Partial<Candidate> = {}): void => {
        if (to === from && toCol === col) return;
        if (to.copy) return;
        const k = `${to.name}\u0000${toCol.name}`;
        const c = found.get(k);
        if (c) {
          c.rules.add(rule);
          if (extra.ownerNamed) c.ownerNamed = true;
          if (extra.namespaced) c.namespaced = true;
          if (extra.bare === false) c.bare = false;
          if (extra.keyNamedDifferently === false) c.keyNamedDifferently = false;
          if (extra.hubCount) c.hubCount = extra.hubCount;
          if (rule !== 'role-playing') { c.role = undefined; c.personRole = undefined; }
          return;
        }
        found.set(k, { from, fromCol: col, to, toCol, rules: new Set([rule]), ownerNamed: false, namespaced: false, bare: false, keyNamedDifferently: false, ...extra });
      };
      const genericStem = ref.stem.length === 0 || ref.stem.every((w) => GENERIC_WORDS.has(w));
      const owners = ownersFor(from, stem);

      // (a) key-name: the column is named as another table's single-column key.
      if (rulesOn.has('key-name')) {
        for (const to of keyIndex.get(col.canon) ?? []) {
          if (to === from) continue;
          const named = owners.tables.includes(to) || to.entity === col.canon || to.nameCanon === col.canon;
          if (suppress && genericStem && !named) continue;
          add(to, to.singleKeys.get(col.canon)!.col, 'key-name', { ownerNamed: named, namespaced: named && owners.namespaced });
        }
      }
      // (b) table-name: `<table>_id` and friends, pointing at that table's key.
      if (rulesOn.has('table-name') && stem && !(suppress && genericStem && owners.tables.length === 0)) {
        for (const to of owners.tables) {
          if (to === from || !to.mainKey) continue;
          const fit = suffixFits(ref, to.mainKey, to);
          if (!fit.ok) continue;
          add(to, to.mainKey, 'table-name', { ownerNamed: true, namespaced: owners.namespaced, bare: !ref.family, keyNamedDifferently: fit.differently });
        }
      }
      // (c) hub: the column is in three or more tables, and exactly one of them is named for it.
      if (rulesOn.has('hub') && stem && (columnCount.get(col.canon) ?? 0) >= 3 && !(suppress && genericStem)) {
        const hubOwners = owners.tables.filter((t) => t.byCanon.has(col.canon));
        if (hubOwners.length === 1 && hubOwners[0] !== from) {
          const to = hubOwners[0];
          const toCol = to.byCanon.get(col.canon)!;
          const contradicted = to.singleKeys.size > 0 && !to.singleKeys.has(col.canon);
          if (!contradicted) add(to, toCol, 'hub', { ownerNamed: true, namespaced: owners.namespaced, hubCount: columnCount.get(col.canon) });
        }
      }
      // (e) role-playing: a role in front of the name of the table pointed at; a person's role; a self reference.
      if (rulesOn.has('role-playing') && found.size === 0) {
        for (let k = 1; k < col.words.length && found.size === 0; k++) {
          const role = col.words.slice(0, k);
          const tail = col.words.slice(k);
          const tailRef = columnReference(tail);
          // A bare generic tail (`order_date`, `document_type`) names a table only as a date column names the date table.
          if (!tailRef.family && tailRef.stem.every((w) => GENERIC_WORDS.has(w)) && col.family !== 'temporal') continue;
          const tailOwners = ownersFor(from, refCanon(tailRef.stem));
          if (tailOwners.tables.length === 0) continue;
          const tailCanon = joinWords(tail);
          for (const to of keyIndex.get(tailCanon) ?? []) {
            if (!tailOwners.tables.includes(to) || (to === from && !tailRef.family)) continue;
            add(to, to.singleKeys.get(tailCanon)!.col, 'role-playing', { role, ownerNamed: true, namespaced: tailOwners.namespaced, bare: !tailRef.family });
          }
          if (found.size === 0) {
            for (const to of tailOwners.tables) {
              if (!to.mainKey || (to === from && !tailRef.family)) continue;
              const fit = suffixFits(tailRef, to.mainKey, to);
              if (!fit.ok) continue;
              add(to, to.mainKey, 'role-playing', { role, ownerNamed: true, namespaced: tailOwners.namespaced, bare: !tailRef.family, keyNamedDifferently: fit.differently });
            }
          }
        }
        if (found.size === 0 && ref.stem.length > 0 && (ref.family === 'id' || !ref.family)) {
          const roleName = joinWords(ref.stem);
          if (PERSON_ROLES.has(roleName)) {
            // An organisation's role (manager) points at the staff table, an application's (creator) at the users; else the one people table.
            const org = SELF_PERSON_ROLES.has(roleName);
            const staff = people.filter((t) => STAFF_ENTITIES.has(t.entity));
            const targets = org && from.person ? [from] : org && staff.length > 0 ? staff : !org && people.length > 1 ? people.filter((t) => !STAFF_ENTITIES.has(t.entity)) : people;
            if (targets.length === 1 && targets[0].mainKey) add(targets[0], targets[0].mainKey, 'role-playing', { role: ref.stem, personRole: roleName });
          } else if (ref.stem[0] === 'parent' && from.mainKey && ref.family === 'id') {
            const rest = refCanon(ref.stem.slice(1));
            if (!rest || rest === from.entity || rest === from.nameCanon) add(from, from.mainKey, 'role-playing', { role: ['parent'] });
          }
        }
      }
      candidates.push(...found.values());
    }
  }

  // Filters; then one column per target in each table (customer_sk beats customer_id for dim_customer.customer_sk); then one target per column.
  const byTarget = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (typeCheck && !typesCompatible(c.fromCol.family, c.toCol.family)) continue;
    // A bare reference (no _id / _code) to a number key is a count or a measure (`orders`, `customers`), not a link.
    if (suppress && c.bare && !c.rules.has('key-name') && (c.toCol.family === 'number' || c.fromCol.family === 'number')) continue;
    // Copies of one entity (stg_orders and orders, customer and customer_hist) do not point at each other.
    if (suppress && c.from !== c.to && c.from.entity === c.to.entity) continue;
    const k = `${c.from.name}\u0000${c.to.name}\u0000${c.toCol.name}`;
    const list = byTarget.get(k);
    if (list) list.push(c); else byTarget.set(k, [c]);
  }
  const byColumn = new Map<string, Candidate[]>();
  for (const list of byTarget.values()) {
    // A role-playing column is a second foreign key to the same parent by design (ship_date_key beside date_key): never folded.
    const plain = list.filter((c) => !c.role);
    const best = Math.max(...plain.map(evidenceScore));
    for (const c of list) {
      if (!c.role && plain.length > 1 && evidenceScore(c) < best) continue;
      const k = `${c.from.name}\u0000${c.fromCol.name}`;
      const l = byColumn.get(k);
      if (l) l.push(c); else byColumn.set(k, [c]);
    }
  }
  const kept: Candidate[] = [];
  for (const list of byColumn.values()) {
    const best = pickTarget(list);
    if (best) kept.push(best);
  }

  // Suggestions, one per link (a link found from both ends is one).
  const out = new Map<string, RelationshipSuggestion>();
  for (const c of kept) {
    const s = toSuggestion(c, keyIndex.get(c.fromCol.canon)?.length ?? 0);
    if (!s || existing.has(s.id)) continue;
    const prior = out.get(s.id);
    // Found from both ends: the stronger band, then the end that sorts first (whatever the table order).
    const endKey = (x: RelationshipSuggestion): string => `${x.fromModel.toLowerCase()}\u0000${x.pairs[0].fromColumn.toLowerCase()}`;
    if (!prior || bandRank(s.band) < bandRank(prior.band) || (s.band === prior.band && endKey(s) < endKey(prior))) out.set(s.id, s);
  }
  if (rulesOn.has('composite')) {
    for (const s of compositeSuggestions(tables, existing, typeCheck, suppress)) if (!out.has(s.id)) out.set(s.id, s);
  }
  return sortSuggestions([...out.values()]);
}

function evidenceScore(c: Candidate): number {
  const key = c.to.singleKeys.get(c.toCol.canon);
  let s = 0;
  if (c.rules.has('key-name')) s += 3;
  if (c.rules.has('table-name')) s += 2;
  if (c.rules.has('hub')) s += 2;
  if (c.rules.has('role-playing')) s += 1;
  if (key?.source === 'declared' || key?.source === 'dbt') s += 2;
  else if (key?.source === 'inferred') s += 1;
  if (c.ownerNamed) s += 1;
  if (c.namespaced) s += 2;
  if (c.from.schema && c.from.schema === c.to.schema) s += 1;
  if (c.fromCol.shape && c.fromCol.shape === c.toCol.shape) s += 1;
  if (c.bare) s -= 1;
  if (c.keyNamedDifferently) s -= 1;
  return s;
}

/** One target per column: the best-supported one; a tie between tables of different schemas goes to the column's own schema, any other tie to none. */
function pickTarget(list: Candidate[]): Candidate | undefined {
  if (list.length === 1) return list[0];
  const scored = list.map((c) => ({ c, s: evidenceScore(c) })).sort((a, b) => b.s - a.s || (a.c.to.name < b.c.to.name ? -1 : 1));
  const top = scored.filter((x) => x.s === scored[0].s);
  if (top.length === 1) return top[0].c;
  const sameSchema = top.filter((x) => x.c.from.schema === x.c.to.schema);
  if (sameSchema.length === 1) return sameSchema[0].c;
  return undefined;
}

/** Schemas named for a medallion or dbt layer. */
const LAYER_SCHEMAS = new Set([
  'bronze', 'silver', 'gold', 'platinum', 'raw', 'landing', 'staging', 'stg', 'stage', 'intermediate', 'int', 'curated', 'refined', 'trusted',
  'mart', 'marts', 'presentation', 'consumption', 'semantic', 'reporting', 'analytics',
]);

export const bandRank = (b: SuggestionBand): number => SUGGESTION_BANDS.indexOf(b);
const lowerBand = (b: SuggestionBand): SuggestionBand => (b === 'strong' ? 'likely' : 'possible');

function keyPhrase(t: TableInfo, col: ColInfo): string {
  const k = t.singleKeys.get(col.canon);
  if (!k) return `${t.name} has ${col.name}`;
  if (k.source === 'dbt') return `${col.name} is unique in ${t.name} (a dbt test says so)`;
  switch (k.kind) {
    case 'primary': return `${col.name} is the primary key of ${t.name}`;
    case 'unique': return `${col.name} is a unique column of ${t.name}`;
    case 'natural': return `${col.name} is the natural key of ${t.name}`;
    case 'inferred': return `${col.name} looks like the key of ${t.name} (no key is declared there)`;
  }
}

/** `keyedBy`: how many tables have a single-column key named as the from column (3+ = a shared key: the target may be a subtype). */
function toSuggestion(c: Candidate, keyedBy: number): RelationshipSuggestion | undefined {
  if (c.from === c.to && c.fromCol === c.toCol) return undefined;
  const toKey = c.to.singleKeys.get(c.toCol.canon);
  const fromKey = c.from.singleKeys.get(c.fromCol.canon);
  const keyInferred = toKey?.source === 'inferred';
  // Direction: the repo's one rule (orientLink) over the ends' evidence; naming settles what it leaves open.
  const end = (t: TableInfo, col: ColInfo, k: typeof toKey): LinkEnd => ({
    model: t.name,
    columns: [col.name],
    evidence: k ? 'whole-key' : t.declaresKeys ? 'not-key' : 'unknown',
    declaredFk: (t.table.columns ?? []).some((d) => d.name === col.name && d.isForeignKey === true),
    source: k ? (k.source === 'dbt' ? 'dbt' : 'keys') : 'none',
  });
  const o = orientLink(end(c.from, c.fromCol, fromKey), end(c.to, c.toCol, toKey));
  let direction: RelationshipSuggestion['direction'] = 'undecided';
  let basis: RelationshipSuggestion['directionBasis'] = 'none';
  let cardinality: RelationshipSuggestion['cardinality'] = o.cardinality === 'one-to-one' ? 'one-to-one' : 'many-to-one';
  if (o.cardinality === 'many-to-many') return undefined;
  if (o.decided) {
    // The keys point the other way: keys win, and the naming guess is dropped.
    if (o.from.model !== c.from.name || o.from.columns[0] !== c.fromCol.name) return undefined;
    direction = 'decided';
    basis = keyInferred || (o.cardinality === 'one-to-one' && fromKey?.source === 'inferred') ? 'inferred-key' : o.basis === 'dbt' ? 'dbt' : 'keys';
  } else if (c.ownerNamed && c.from.entity !== c.to.entity) {
    // Both ends are keys (one-to-one), or neither is known: the table named for the column is the one pointed at.
    direction = 'decided';
    basis = 'naming';
  }
  if (cardinality !== 'one-to-one' && o.cardinality === 'one-to-one') cardinality = 'one-to-one';

  // Band.
  const declared = toKey?.source === 'declared' || toKey?.source === 'dbt';
  const direct = c.rules.has('key-name') || (c.rules.has('table-name') && !c.bare && !c.keyNamedDifferently);
  let band: SuggestionBand;
  if (direct && toKey && !c.role) band = 'strong';
  else if (direct || (c.rules.has('hub') && toKey) || (c.role && toKey && !c.bare && !c.keyNamedDifferently)) band = 'likely';
  else band = 'possible';
  // A unique (not primary) key matched by name alone, from a column that does not name its table: an alternate key.
  if (band === 'strong' && toKey?.kind === 'unique' && !c.ownerNamed) band = 'likely';
  // Several tables keyed by this column (BusinessEntityID): the right target may be a subtype.
  if (band === 'strong' && keyedBy >= 3) band = 'likely';
  if (band !== 'possible' && keyInferred) band = lowerBand(band);
  if (!declared && !toKey) band = 'possible';
  if (direction === 'undecided') band = 'possible';
  if (c.from === c.to && band === 'strong') band = 'likely';
  // From one medallion layer to another (gold → silver) is lineage more often than a relationship.
  const crossLayer = c.from.schema !== c.to.schema && LAYER_SCHEMAS.has(c.from.schema) && LAYER_SCHEMAS.has(c.to.schema);
  if (crossLayer) band = 'possible';

  const reasons: string[] = [];
  if (c.personRole) {
    reasons.push(c.from === c.to
      ? `${c.fromCol.name} names a person's role, and ${c.to.name} holds people`
      : `${c.fromCol.name} names a person's role, and ${c.to.name} is the only table of people`);
  } else if (c.role && c.from === c.to) {
    reasons.push(`${c.fromCol.name} points back at ${c.to.name} (its ${c.role.join(' ')})`);
  } else if (c.role) {
    reasons.push(`${c.fromCol.name} is ${c.to.name}'s ${c.toCol.name} in the role "${c.role.join(' ')}"`);
  }
  if (c.rules.has('key-name') && !c.role) reasons.push(`${keyPhrase(c.to, c.toCol)}, and ${c.from.name} has a column of the same name`);
  else if (toKey) reasons.push(keyPhrase(c.to, c.toCol));
  if (c.rules.has('table-name') && !c.rules.has('key-name')) reasons.push(`${c.fromCol.name} names the table ${c.to.name}`);
  if (c.rules.has('hub') && c.hubCount) reasons.push(`${c.fromCol.name} is in ${c.hubCount} tables, and ${c.to.name} is the one named for it`);
  if (c.namespaced) reasons.push(`${c.to.name} shares ${c.from.name}'s name prefix`);
  if (c.fromCol.shape && c.fromCol.shape === c.toCol.shape && c.fromCol.family !== 'loose') reasons.push(`both are ${c.fromCol.shape}`);
  if (keyedBy >= 3 && !c.role) reasons.push(`${keyedBy} tables are keyed by ${c.fromCol.name}: it may point at one of the others`);
  if (crossLayer) reasons.push(`it crosses from the ${c.from.schema} layer to the ${c.to.schema} layer`);
  if (direction === 'undecided') reasons.push('nothing says which way it points');
  if (c.keyNamedDifferently) reasons.push(`the key's name, ${c.toCol.name}, does not follow the column's`);

  return {
    id: linkKey({ fromModel: c.from.name, fromColumn: c.fromCol.name, toModel: c.to.name, toColumn: c.toCol.name }),
    fromModel: c.from.name,
    toModel: c.to.name,
    pairs: [{ fromColumn: c.fromCol.name, toColumn: c.toCol.name }],
    cardinality,
    direction,
    directionBasis: basis,
    band,
    rules: SUGGESTION_RULES.filter((r) => c.rules.has(r)),
    keyInferred,
    reasons: [...new Set(reasons)],
  };
}

/** Composite primary keys: a table holding every column of another table's composite key, by name. */
function compositeSuggestions(tables: readonly TableInfo[], existing: ReadonlySet<string>, typeCheck: boolean, suppress: boolean): RelationshipSuggestion[] {
  // Index each composite key by its rarest column, so each table checks only the keys it could hold.
  const count = new Map<string, number>();
  for (const t of tables) for (const c of t.byCanon.keys()) count.set(c, (count.get(c) ?? 0) + 1);
  const byColumn = new Map<string, Array<{ to: TableInfo; cols: ColInfo[]; source: KeySource }>>();
  for (const to of tables) {
    if (to.copy) continue;
    for (const k of to.compositeKeys) {
      const rarest = [...k.cols].sort((a, b) => (count.get(a.canon) ?? 0) - (count.get(b.canon) ?? 0) || (a.canon < b.canon ? -1 : 1))[0];
      const list = byColumn.get(rarest.canon) ?? [];
      list.push({ to, cols: k.cols, source: k.source });
      byColumn.set(rarest.canon, list);
    }
  }
  const out: RelationshipSuggestion[] = [];
  for (const from of tables) {
    if (from.copy) continue;
    for (const canon of from.byCanon.keys()) {
      for (const key of byColumn.get(canon) ?? []) {
        if (key.to === from) continue;
        if (suppress && key.to.entity === from.entity) continue;
        const fromCols = key.cols.map((k) => from.byCanon.get(k.canon));
        if (fromCols.some((c) => !c)) continue;
        // Keyed by the same columns: two tables keyed alike, which way round nothing says.
        if (from.compositeKeys.some((k) => sameCols(k.cols, key.cols))) continue;
        // The from table's own key is part of the target's key: the target is its child (a satellite, a line), not its parent.
        if (from.mainKey && key.cols.some((k) => k.canon === from.mainKey!.canon)) continue;
        const pairs = key.cols.map((k, i) => ({ from: fromCols[i]!, to: k }));
        if (typeCheck && pairs.some((p) => !typesCompatible(p.from.family, p.to.family))) continue;
        if (suppress && pairs.some((p) => p.from.audit)) continue;
        const ids = pairs.map((p) => linkKey({ fromModel: from.name, fromColumn: p.from.name, toModel: key.to.name, toColumn: p.to.name }));
        if (ids.some((id) => existing.has(id))) continue;
        out.push({
          id: [...ids].sort().join('\u0001'),
          fromModel: from.name,
          toModel: key.to.name,
          pairs: pairs.map((p) => ({ fromColumn: p.from.name, toColumn: p.to.name })),
          cardinality: 'many-to-one',
          direction: 'decided',
          directionBasis: key.source === 'dbt' ? 'dbt' : 'keys',
          band: 'possible',
          rules: ['composite'],
          keyInferred: false,
          reasons: [
            `(${key.cols.map((c) => c.name).join(', ')}) is the ${key.source === 'dbt' ? 'unique combination (a dbt test says so)' : 'composite primary key'} of ${key.to.name}, and ${from.name} has all ${key.cols.length} columns`,
          ],
        });
      }
    }
  }
  return out;
}

/** Strongest band first, then by table and column names: the same input always gives the same order. */
export function sortSuggestions(list: RelationshipSuggestion[]): RelationshipSuggestion[] {
  const k = (s: RelationshipSuggestion): string => `${s.fromModel.toLowerCase()}\u0000${s.pairs[0].fromColumn.toLowerCase()}\u0000${s.toModel.toLowerCase()}\u0000${s.id}`;
  return list.sort((a, b) => bandRank(a.band) - bandRank(b.band) || (k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0));
}

/**
 * The relationship entries accepting a suggestion adds, as the write planner takes them: one per pair, a
 * composite's sharing `compositeKey` (the caller supplies it, from core's `nextCompositeKey`).
 */
export function suggestionRelationships(s: RelationshipSuggestion, compositeKey?: string): Relationship[] {
  return s.pairs.map((p) => ({
    fromModel: s.fromModel,
    fromColumn: p.fromColumn,
    toModel: s.toModel,
    toColumn: p.toColumn,
    cardinality: s.cardinality,
    ...(s.pairs.length > 1 && compositeKey ? { compositeKey } : {}),
  }));
}
