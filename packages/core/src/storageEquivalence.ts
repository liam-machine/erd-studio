/**
 * The one storage-equivalence comparator (D24 of the native DBML storage
 * spec): a subject area read from DBML and the same subject area read from
 * YAML/JSON are "the same" when this function gives equal results for both.
 * The DBML-twin goldens, the writers' round-trip law, Convert's self-check and
 * the end-to-end script all compare through it, so they cannot each invent a
 * tolerance and disagree.
 *
 * It applies exactly the normalisations of §2.8 and nothing else:
 *
 * - description, column note and sticky-note text: leading white space
 *   dropped (`dbmlNoteText`, the writer's own rule, so DBML's shared-indent
 *   trim never applies to text ERD Studio writes);
 * - positions (and sticky-note boxes) rounded to two decimals, and an empty
 *   sticky-note list the same as none (a diagram with no Note blocks reads
 *   back with no list);
 * - relationship ends respelled to the real table and column spelling;
 * - a library `one-to-many` stored canonically (many-to-one, ends swapped);
 * - a one-member composite group's key dropped, and every composite key
 *   renamed to the `nextCompositeKey` sequence in its owner's order;
 * - `schemaVersion` overridden (4/5/6 → 7);
 * - every relationship list in one order: by from table, to table, from
 *   column and to column (case-insensitive), as a relationships file keeps
 *   its Refs sorted (§4.5), so the drawn order of a link carries no meaning;
 * - and, with `convert: true` only, the Convert rows: a link stored twice
 *   kept once, a composite group's role taken from its first member,
 *   dangling relationships dropped, annotation ids ignored, and relationships
 *   held in a diagram file moved to their owner in a Unified shape (the
 *   diagram's own list left empty, as a DBML diagram holds no Refs, D5).
 *
 * It accepts the Display shape (`models`, `relationships`) and the Unified
 * shape (`logical.models`, each table's own `relationships`, and
 * `logical.relationships`), and returns a normalised deep copy. Pure and
 * parser-free; never throws on a well-formed JSON value.
 */

import { DBML_SCHEMA_VERSION } from './types/semantic.js';
import { canonicalRelationship, linkKey, nextCompositeKey } from './relationships.js';
import { dbmlNoteText } from './dbmlText.js';
import type { Relationship } from './types/semantic.js';

/** Options for {@link normaliseForStorageEquivalence}. */
export interface StorageEquivalenceOptions {
  /** Apply the Convert-only rows of §2.8 as well (comparing a Convert result). */
  convert?: boolean;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Rounded to two decimals, with no `-0`. */
function round(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Note text as ERD Studio's DBML writer stores it and DBML reads it back:
 * leading white space dropped (`dbmlNoteText`, §2.8). The writer emits
 * `dbmlString(dbmlNoteText(text))`, so the first line has no indent and the
 * parser's shared-indent trim never applies; an indent the other lines keep
 * is kept. Idempotent.
 */
export function storageNoteText(value: string): string {
  return dbmlNoteText(value);
}

function normaliseText(holder: Json, key: string): void {
  if (typeof holder[key] === 'string') holder[key] = storageNoteText(holder[key] as string);
}

/** A table as the comparator respells against: its name and column names. */
interface SpelledTable {
  name: string;
  columns: string[];
}

function tablesOf(models: unknown): SpelledTable[] {
  if (!Array.isArray(models)) return [];
  const out: SpelledTable[] = [];
  for (const model of models) {
    if (!isObject(model) || typeof model.name !== 'string') continue;
    const columns = Array.isArray(model.columns)
      ? model.columns.filter(isObject).map((c) => c.name).filter((n): n is string => typeof n === 'string')
      : [];
    out.push({ name: model.name, columns });
  }
  return out;
}

const lower = (s: string): string => s.toLowerCase();

function findTable(tables: readonly SpelledTable[], name: unknown): SpelledTable | undefined {
  if (typeof name !== 'string') return undefined;
  return tables.find((t) => t.name === name) ?? tables.find((t) => lower(t.name) === lower(name));
}

function findColumn(table: SpelledTable | undefined, column: unknown): string | undefined {
  if (!table || typeof column !== 'string') return undefined;
  return table.columns.find((c) => c === column) ?? table.columns.find((c) => lower(c) === lower(column));
}

/** One relationship with its ends respelled to the real spellings (unknown ends kept as written). */
function respell(rel: Json, owner: string | undefined, tables: readonly SpelledTable[]): void {
  const fromName = owner ?? rel.fromModel;
  const from = findTable(tables, fromName);
  const to = findTable(tables, rel.toModel);
  if (owner === undefined && from) rel.fromModel = from.name;
  if (to) rel.toModel = to.name;
  const fromColumn = findColumn(from, rel.fromColumn);
  if (fromColumn !== undefined) rel.fromColumn = fromColumn;
  const toColumn = findColumn(to, rel.toColumn);
  if (toColumn !== undefined) rel.toColumn = toColumn;
}

/** `rel` stored canonically: a `one-to-many` becomes many-to-one from the other end. */
function canonical(rel: Json, owner: string | undefined): { rel: Json; owner: string | undefined } {
  if (rel.cardinality !== 'one-to-many') return { rel, owner };
  const full = { ...rel, fromModel: owner ?? rel.fromModel } as unknown as Relationship;
  const turned = canonicalRelationship(full) as unknown as Json;
  if (owner === undefined) return { rel: turned, owner };
  const { fromModel, ...rest } = turned;
  return { rel: rest, owner: typeof fromModel === 'string' ? fromModel : owner };
}

function endsOf(rel: Json, owner: string | undefined): { fromModel: string; fromColumn: string; toModel: string; toColumn: string } {
  return {
    fromModel: String(owner ?? rel.fromModel ?? ''),
    fromColumn: String(rel.fromColumn ?? ''),
    toModel: String(rel.toModel ?? ''),
    toColumn: String(rel.toColumn ?? ''),
  };
}

/**
 * Composite keys in one owner's list (or a flat list grouped by `fromModel`):
 * a key on one entry only is dropped, then every key is renamed to the
 * `nextCompositeKey` sequence in list order. With `convert`, a group's role
 * becomes its first member's.
 */
function normaliseCompositeKeys(entries: Json[], ownerOf: (rel: Json) => string, convert: boolean): void {
  const byOwner = new Map<string, Json[]>();
  for (const rel of entries) {
    const key = lower(ownerOf(rel));
    const list = byOwner.get(key);
    if (list) list.push(rel);
    else byOwner.set(key, [rel]);
  }
  for (const list of byOwner.values()) {
    const counts = new Map<string, number>();
    for (const rel of list) {
      if (typeof rel.compositeKey === 'string') counts.set(lower(rel.compositeKey), (counts.get(lower(rel.compositeKey)) ?? 0) + 1);
    }
    for (const rel of list) {
      if (typeof rel.compositeKey === 'string' && counts.get(lower(rel.compositeKey)) === 1) delete rel.compositeKey;
      else if (rel.compositeKey !== undefined && typeof rel.compositeKey !== 'string') delete rel.compositeKey;
    }
    const renamed = new Map<string, string>();
    const assigned: Array<{ compositeKey?: string }> = [];
    const firstRole = new Map<string, unknown>();
    for (const rel of list) {
      if (typeof rel.compositeKey !== 'string') continue;
      const old = lower(rel.compositeKey);
      let next = renamed.get(old);
      if (next === undefined) {
        next = nextCompositeKey(assigned, String(rel.toModel ?? ''));
        renamed.set(old, next);
        assigned.push({ compositeKey: next });
        firstRole.set(next, rel.role);
      }
      rel.compositeKey = next;
      if (convert) {
        const role = firstRole.get(next);
        if (role === undefined) delete rel.role;
        else rel.role = role;
      }
    }
  }
}

/**
 * `entries` in the order a relationships file keeps its Refs (§4.5 sort
 * key): from table, to table, from column, to column, without case. A
 * composite group is one Ref: it moves as a unit, at its first member's key,
 * with its members in their order. Stable, so entries that tie keep their
 * order. `ownerOf` gives an entry's from table.
 */
function sortRelationships(entries: Json[], ownerOf: (rel: Json) => string): void {
  const keyOf = (rel: Json): string =>
    [ownerOf(rel), rel.toModel, rel.fromColumn, rel.toColumn].map((part) => lower(String(part ?? ''))).join('\u0000');
  const groupKeys = new Map<string, string>();
  const keyed = entries.map((rel, index) => {
    let key = keyOf(rel);
    if (typeof rel.compositeKey === 'string') {
      const group = `${lower(ownerOf(rel))}\u0000${lower(rel.compositeKey)}`;
      const first = groupKeys.get(group);
      if (first === undefined) groupKeys.set(group, key);
      else key = first;
    }
    return { rel, index, key };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index));
  keyed.forEach(({ rel }, i) => { entries[i] = rel; });
}

/** A relationship list normalised in place order: respelled, canonical, deduped (convert) and dangling dropped (convert). */
function normaliseList(
  list: unknown,
  owner: string | undefined,
  tables: readonly SpelledTable[],
  convert: boolean,
): { entries: Json[]; moved: Array<{ owner: string; rel: Json }> } {
  const entries: Json[] = [];
  const moved: Array<{ owner: string; rel: Json }> = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(list) ? list : []) {
    if (!isObject(item)) continue;
    const copy = { ...item };
    respell(copy, owner, tables);
    const turned = canonical(copy, owner);
    if (convert) {
      const ends = endsOf(turned.rel, turned.owner);
      const to = findTable(tables, ends.toModel);
      if (!to || findColumn(to, ends.toColumn) === undefined) continue;
      const key = linkKey(ends);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (owner !== undefined && turned.owner !== owner) {
      // A one-to-many in a table's own list belongs to its other end once stored canonically.
      moved.push({ owner: turned.owner!, rel: turned.rel });
      continue;
    }
    entries.push(turned.rel);
  }
  return { entries, moved };
}

/**
 * `area` normalised for the storage comparison: a deep copy, with exactly the
 * §2.8 rows applied (see the module comment). `options.convert` adds the
 * Convert-only rows.
 */
export function normaliseForStorageEquivalence<T>(area: T, options: StorageEquivalenceOptions = {}): T {
  if (!isObject(area)) return area;
  const convert = options.convert === true;
  const copy = JSON.parse(JSON.stringify(area)) as Json;

  if (isFiniteNumber(copy.schemaVersion)) copy.schemaVersion = DBML_SCHEMA_VERSION;
  normaliseText(copy, 'description');

  const logical = isObject(copy.logical) ? copy.logical : undefined;
  const models: unknown = Array.isArray(copy.models) ? copy.models : logical?.models;
  const tables = tablesOf(models);

  // Tables and columns: descriptions; a table's own relationships (Unified).
  const ownLists: Array<{ model: Json; owner: string }> = [];
  for (const model of Array.isArray(models) ? models : []) {
    if (!isObject(model)) continue;
    normaliseText(model, 'description');
    for (const column of Array.isArray(model.columns) ? model.columns : []) {
      if (isObject(column)) normaliseText(column, 'description');
    }
    if (typeof model.name === 'string' && Array.isArray(model.relationships)) ownLists.push({ model, owner: model.name });
  }
  const movedToOwners: Array<{ owner: string; rel: Json }> = [];
  for (const { model, owner } of ownLists) {
    const { entries, moved } = normaliseList(model.relationships, owner, tables, convert);
    model.relationships = entries;
    movedToOwners.push(...moved);
  }

  // The flat lists: the Display's `relationships`, the Unified's `logical.relationships`.
  const flatHolders: Json[] = [];
  if (Array.isArray(copy.relationships)) flatHolders.push(copy);
  if (logical && Array.isArray(logical.relationships)) flatHolders.push(logical);
  for (const holder of flatHolders) {
    const { entries } = normaliseList(holder.relationships, undefined, tables, convert);
    holder.relationships = entries;
    sortRelationships(entries, (rel) => String(rel.fromModel ?? ''));
    normaliseCompositeKeys(entries, (rel) => String(rel.fromModel ?? ''), convert);
  }

  // Relationships a table list now holds for another owner (a one-to-many
  // read canonically), and, with convert, a diagram file's own relationships
  // (Unified) moved to the library: attached to their owner's list.
  if (logical && convert && Array.isArray(logical.relationships)) {
    for (const rel of logical.relationships as Json[]) {
      const { fromModel, ...rest } = rel;
      if (typeof fromModel === 'string') movedToOwners.push({ owner: fromModel, rel: rest });
    }
    // A converted (DBML) diagram holds no Refs (D5): its own list is empty.
    logical.relationships = [];
  }
  for (const { owner, rel } of movedToOwners) {
    const target = ownLists.find((l) => lower(l.owner) === lower(owner))?.model
      ?? (Array.isArray(models) ? (models as unknown[]).find((m): m is Json => isObject(m) && typeof m.name === 'string' && lower(m.name) === lower(owner)) : undefined);
    if (!target) continue;
    const list = Array.isArray(target.relationships) ? (target.relationships as Json[]) : [];
    // A link stored twice is kept once only when comparing a Convert result (§2.8).
    if (convert) {
      const key = linkKey(endsOf(rel, owner));
      if (list.some((r) => linkKey(endsOf(r, owner)) === key)) continue;
    }
    list.push(rel);
    target.relationships = list;
    if (!ownLists.some((l) => l.model === target)) ownLists.push({ model: target, owner });
  }
  for (const { model, owner } of ownLists) {
    sortRelationships(model.relationships as Json[], () => owner);
    normaliseCompositeKeys(model.relationships as Json[], () => owner, convert);
  }

  // Positions and sticky notes.
  const viewConfig = isObject(copy.viewConfig) ? copy.viewConfig : undefined;
  if (viewConfig && isObject(viewConfig.positions)) {
    for (const position of Object.values(viewConfig.positions)) {
      if (!isObject(position)) continue;
      if (isFiniteNumber(position.x)) position.x = round(position.x);
      if (isFiniteNumber(position.y)) position.y = round(position.y);
    }
  }
  if (viewConfig && Array.isArray(viewConfig.annotations) && viewConfig.annotations.length === 0) {
    delete viewConfig.annotations;
  }
  if (viewConfig && Array.isArray(viewConfig.annotations)) {
    for (const annotation of viewConfig.annotations) {
      if (!isObject(annotation)) continue;
      normaliseText(annotation, 'text');
      for (const key of ['x', 'y', 'width', 'height']) {
        if (isFiniteNumber(annotation[key])) annotation[key] = round(annotation[key] as number);
      }
      if (convert) delete annotation.id;
    }
  }
  return copy as T;
}
