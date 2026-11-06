/**
 * Where a table file sets its settings, and which spelling of a field is
 * read: the one module the table reader (`readTable.ts`) and the table
 * writer (`writeTable.ts`) share (context fields, amendment A7), so what an
 * edit changes is always the setting the reader read.
 *
 * **Setters.** A setting is set inline (`Table t [k: 'v']`, a column's
 * `[k: 'v']`), in a same-file `Metadata Table` / `Metadata Column` block
 * (D25), or — the description only — by a body `Note`. The same name set
 * inline and in a block is one setting whose block entry takes effect.
 *
 * **Spellings** (`fields.ts` names them; nothing else may decide them). A
 * rationale-home field `K` (a table built-in kept in `rationale`) is read
 * from the first of `erd_K`, `K`, `erd_rationale_K`, `rationale_K` whose
 * value is non-empty text. A `meta` key `k` is read from the first of
 * `erd_k` and `k` (only when {@link isBareMetaKey}), `erd_meta_k`,
 * `meta_k`, `erd_rationale_k` and `rationale_k` (only when `k` is not a
 * rationale-home field of the scope), then the `meta_json` entry `k`; there
 * `''` is a value and stops the search. A `meta` key stands in the map where
 * its winning spelling stands. ERD Studio's typed settings (`role`, `grain`,
 * `alias`, `schema`; a column's `natural_key`, `scd_type`, `additive_type`,
 * `foreign_key`) keep their own rule: `erd_<x>` wins over `<x>`.
 *
 * Parser-free apart from reading AST nodes: it imports no parser.
 */

import type { Meta, Rationale } from '../types/semantic.js';
import {
  DBML_RICH_META_JSON_PROPERTY,
  DBML_RICH_META_PREFIX,
  DBML_RICH_PLACEHOLDER_COLUMN,
  DBML_RICH_PLACEHOLDER_PROPERTY,
  DBML_RICH_PROPERTY_PREFIX,
  DBML_RICH_RATIONALE_PREFIX,
  bareDbmlProperty,
} from '../dbmlRichProperties.js';
import {
  FIELD_KEY_PATTERN,
  RATIONALE_FIELD_KEYS,
  fieldKeyToRationaleKey,
  isBareMetaKey,
  metaSpellingNames,
  rationaleKeyToFieldKey,
  rationaleSpellingNames,
  type FieldScope,
} from '../fields.js';
import { readMeta } from '../meta.js';
import type { DbmlFieldSpelling } from '../types/dbmlStorage.js';
import { attributeName, elementType, plainNames, topLevel, type AstNode } from './parser.js';

// ---------------------------------------------------------------------------
// Setters
// ---------------------------------------------------------------------------

/** Where one setting is set. */
export interface Setter {
  /** The setting's name as written, lower-case (`erd_rationale_purpose`, `primary key`). */
  name: string;
  /** {@link name} without the optional `erd_` prefix. */
  key: string;
  prefixed: boolean;
  where: 'inline' | 'block' | 'body';
  /** The attribute, block entry or body `Note` element. */
  node: AstNode;
  /** The node whose span is the value text. */
  value: AstNode | undefined;
  /** For an inline attribute: its list and its index there. */
  list?: AstNode;
  index?: number;
}

/** A same-file `Metadata` block that targets the table or one of its columns (D25). */
export interface MetadataBlock {
  node: AstNode;
  kind: 'table' | 'column';
  column?: string;
  /** The name leaves of its target (`gold`, `fct_order`, `id`). */
  leaves: AstNode[];
}

/** The leaf names of a dotted name, as nodes (`gold.x.c` → the `gold`, `x` and `c` nodes). */
export function nameLeaves(expr: AstNode | undefined): AstNode[] {
  if (!expr || typeof expr !== 'object') return [];
  if (expr.kind === '<primary-expression>') return [expr];
  if (expr.kind === '<infix-expression>' && expr.op?.value === '.') return [...nameLeaves(expr.leftExpression), ...nameLeaves(expr.rightExpression)];
  return [];
}

/** The variable name a leaf node spells. */
export function leafName(leaf: AstNode): string {
  const v = leaf?.expression?.variable?.value;
  return typeof v === 'string' ? v : '';
}

/** The file's `Metadata` blocks that target table `tableName` (any case) or one of its columns, in file order. */
export function metadataBlocksOf(ast: AstNode | undefined, tableName: string): MetadataBlock[] {
  const name = tableName.toLowerCase();
  const blocks: MetadataBlock[] = [];
  for (const node of topLevel(ast)) {
    if (elementType(node)?.toLowerCase() !== 'metadata') continue;
    const leaves = nameLeaves(node.name);
    const kind = String(node.targetKind?.value ?? '').toLowerCase() === 'column' ? 'column' : 'table';
    const names = leaves.map(leafName);
    if (kind === 'table') {
      if (names.length > 0 && names[names.length - 1].toLowerCase() === name) blocks.push({ node, kind, leaves });
    } else if (names.length >= 2 && names[names.length - 2].toLowerCase() === name) {
      blocks.push({ node, kind, column: names[names.length - 1], leaves });
    }
  }
  return blocks;
}

/** A block's `key: value` entries. */
export function blockEntries(block: MetadataBlock): AstNode[] {
  return (Array.isArray(block.node.body?.body) ? (block.node.body.body as AstNode[]) : []).filter((n) => n?.kind === '<element-declaration>');
}

/**
 * The setters of a table (`column` undefined) or of one column: each
 * attribute of its inline list, in order, then each entry of the blocks
 * that target it, in file order.
 */
export function settersOf(list: AstNode | undefined, blocks: readonly MetadataBlock[], column?: string): Setter[] {
  const out: Setter[] = [];
  const elements: AstNode[] = Array.isArray(list?.elementList) ? list!.elementList : [];
  elements.forEach((attribute, index) => {
    if (attribute?.kind !== '<attribute>') return;
    const name = attributeName(attribute);
    const key = bareDbmlProperty(name);
    out.push({ name, key, prefixed: key !== name, where: 'inline', node: attribute, value: attribute.value, list, index });
  });
  for (const block of blocks) {
    if (column === undefined ? block.kind !== 'table' : block.kind !== 'column' || block.column!.toLowerCase() !== column.toLowerCase()) continue;
    for (const entry of blockEntries(block)) {
      const name = String(entry.type?.value ?? '').toLowerCase();
      const key = bareDbmlProperty(name);
      out.push({ name, key, prefixed: key !== name, where: 'block', node: entry, value: entry.body });
    }
  }
  return out;
}

/** The setter that takes effect among setters of one name: a block's, else the body's, else inline; the last of them. */
export function effectiveSetter(setters: readonly Setter[]): Setter | undefined {
  if (setters.length === 0) return undefined;
  const byWhere = (where: Setter['where']): Setter[] => setters.filter((s) => s.where === where);
  const pick = byWhere('block').length > 0 ? byWhere('block') : byWhere('body').length > 0 ? byWhere('body') : [...setters];
  return pick[pick.length - 1];
}

/**
 * The setter that takes effect among setters of one typed setting (`grain`
 * and `erd_grain`, `note`): an `erd_` spelling wins over the plain one, then
 * as {@link effectiveSetter}. The reader's rule for typed settings.
 */
export function effectiveTypedSetter(setters: readonly Setter[]): Setter | undefined {
  return effectiveSetter(setters.some((s) => s.prefixed) ? setters.filter((s) => s.prefixed) : setters);
}

/** The distinct setting names of some setters, each where it first appears (inline order, then the blocks'): DBML's own order. */
export function settingNames(setters: readonly Setter[]): string[] {
  return [...new Set(setters.filter((s) => s.where !== 'body').map((s) => s.name))];
}

/** A column node of a Table body: a field line with a name. */
export interface ColumnNode {
  node: AstNode;
  name: string;
  settings: AstNode | undefined;
  type: AstNode | undefined;
  placeholder: boolean;
}

/** The column lines of a Table, in order (the placeholder column marked). */
export function columnNodesOf(tableNode: AstNode): ColumnNode[] {
  const body: AstNode[] = Array.isArray(tableNode.body?.body) ? tableNode.body.body : [];
  const columns: ColumnNode[] = [];
  for (const node of body) {
    if (node?.kind !== '<function-application>') continue;
    const name = plainNames(node.callee)?.[0];
    if (name === undefined) continue;
    const args: AstNode[] = Array.isArray(node.args) ? node.args : [];
    const settings = args.length > 0 && args[args.length - 1]?.kind === '<list-expression>' ? args[args.length - 1] : undefined;
    const type = args.length > 0 && args[0]?.kind !== '<list-expression>' ? args[0] : undefined;
    const elements: AstNode[] = Array.isArray(settings?.elementList) ? settings.elementList : [];
    const placeholder = name === DBML_RICH_PLACEHOLDER_COLUMN
      && elements.some((a) => attributeName(a) === DBML_RICH_PLACEHOLDER_PROPERTY);
    columns.push({ node, name, settings, type, placeholder });
  }
  return columns;
}

// ---------------------------------------------------------------------------
// Spellings
// ---------------------------------------------------------------------------

/** What one setting name spells: a rationale-home field, a `meta` key, or `meta_json`. */
export type SettingField =
  | { home: 'rationale'; key: keyof Rationale; fieldKey: string; rank: number; spelling: DbmlFieldSpelling['spelling'] }
  | { home: 'meta'; key: string; rank: number; spelling: DbmlFieldSpelling['spelling'] }
  | { home: 'json' };

/** The precedence of a `meta_json` entry: after every setting. */
const JSON_RANK = 6;

/** The `meta` key whose `meta_` spelling would be `meta_json` itself. */
const META_JSON_KEY = DBML_RICH_META_JSON_PROPERTY.slice(DBML_RICH_META_PREFIX.length);

/** Whether a name is a `meta_json` setting (`meta_json`, `erd_meta_json`). */
function isMetaJsonName(name: string): boolean {
  return bareDbmlProperty(name) === DBML_RICH_META_JSON_PROPERTY;
}

/**
 * The field a setting name spells for the table (`scope: 'table'`) or a
 * column, or undefined for a setting that holds no field (ERD Studio's typed
 * settings, DBML's own, every other reserved name, a multi-word name).
 */
export function fieldOfSetting(name: string, scope: FieldScope): SettingField | undefined {
  if (isMetaJsonName(name)) return { home: 'json' };
  const erd = name.startsWith(DBML_RICH_PROPERTY_PREFIX) && name !== DBML_RICH_PLACEHOLDER_PROPERTY;
  const rest = erd ? name.slice(DBML_RICH_PROPERTY_PREFIX.length) : name;
  const kind = (plain: DbmlFieldSpelling['spelling']): DbmlFieldSpelling['spelling'] => (erd ? 'erd' : plain);
  const rank = (plain: number): number => plain - (erd ? 1 : 0);
  if (scope === 'table') {
    const bare = fieldKeyToRationaleKey(rest);
    if (bare) return { home: 'rationale', key: bare, fieldKey: rest, rank: rank(1), spelling: kind('bare') };
    if (rest.startsWith(DBML_RICH_RATIONALE_PREFIX)) {
      const fieldKey = rest.slice(DBML_RICH_RATIONALE_PREFIX.length);
      const key = fieldKeyToRationaleKey(fieldKey);
      if (key) return { home: 'rationale', key, fieldKey, rank: rank(3), spelling: kind('rationale') };
    }
  }
  if (rest.startsWith(DBML_RICH_META_PREFIX)) {
    const key = rest.slice(DBML_RICH_META_PREFIX.length);
    // Any key after `meta_` (today's read path), `json` excepted: that is `meta_json` itself.
    if (key !== '' && key !== META_JSON_KEY) return { home: 'meta', key, rank: rank(3), spelling: kind('meta') };
    return undefined;
  }
  if (rest.startsWith(DBML_RICH_RATIONALE_PREFIX)) {
    const key = rest.slice(DBML_RICH_RATIONALE_PREFIX.length);
    if (FIELD_KEY_PATTERN.test(key) && !(scope === 'table' && fieldKeyToRationaleKey(key) !== undefined)) {
      return { home: 'meta', key, rank: rank(5), spelling: kind('rationale') };
    }
    return undefined;
  }
  if (isBareMetaKey(rest, scope)) return { home: 'meta', key: rest, rank: rank(1), spelling: kind('bare') };
  return undefined;
}

/** The setting names that spell the rationale-home field `key` (camelCase), in precedence order. */
export function rationaleSettingNames(key: keyof Rationale): string[] {
  return rationaleSpellingNames(rationaleKeyToFieldKey(key));
}

/**
 * The setting names that spell the `meta` key `key` of `scope`, in
 * precedence order (its `meta_json` entry aside): {@link metaSpellingNames},
 * and for a key that is not an identifier (read today from `meta_<key>`
 * only) its `meta_` spellings.
 */
export function metaSettingNames(key: string, scope: FieldScope): string[] {
  const names = metaSpellingNames(key, scope);
  if (names.length > 0 || key === '' || key === META_JSON_KEY) return names;
  return [`${DBML_RICH_PROPERTY_PREFIX}${DBML_RICH_META_PREFIX}${key}`, `${DBML_RICH_META_PREFIX}${key}`];
}

/** One setting's value as the reader reads it. */
export interface SettingReading {
  name: string;
  text: string;
}

/** The reader's choice for a `meta` key: a setting (its name), or the `meta_json` entry. */
export type MetaWinner = { kind: 'setting'; name: string } | { kind: 'json' };

/** What the field settings of the table or one column read as. */
export interface FieldSettings {
  rationale: Rationale;
  /** The setting each rationale value is read from. */
  rationaleWinners: Map<keyof Rationale, string>;
  meta: Meta | undefined;
  metaWinners: Map<string, MetaWinner>;
  /** The `meta_json` setting read (an `erd_meta_json` wins over `meta_json`): its text and its entries. */
  json?: { text: string; object: Record<string, unknown>; valid: boolean };
  /** Every field-bearing setting and `meta_json` entry, in order, without `owner` and `old`. */
  spellings: Array<Omit<DbmlFieldSpelling, 'owner' | 'old'> & { value: unknown }>;
}

/**
 * Read the field settings of the table or one column: `readings` are its
 * settings in DBML's order (each name once, with the value that takes
 * effect). Pure: the reader reads this, and the writer edits the setting it
 * says each value came from.
 */
export function resolveFieldSettings(readings: readonly SettingReading[], scope: FieldScope): FieldSettings {
  const classified = readings.map((r, position) => ({ ...r, position, field: fieldOfSetting(r.name, scope) }));

  // meta_json: an erd_ spelling wins, standing where the first of them stands.
  const jsons = classified.filter((c) => c.field?.home === 'json');
  let json: FieldSettings['json'];
  const jsonPosition = jsons.length > 0 ? jsons[0].position : -1;
  if (jsons.length > 0) {
    const chosen = jsons.find((c) => c.name !== DBML_RICH_META_JSON_PROPERTY) ?? jsons[0];
    let parsed: unknown;
    let valid = false;
    try {
      parsed = JSON.parse(chosen.text);
      valid = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      valid = false;
    }
    const object: Record<string, unknown> = {};
    if (valid) {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        Object.defineProperty(object, k, { value: v, enumerable: true, writable: true, configurable: true });
      }
    } else {
      Object.defineProperty(object, META_JSON_KEY, { value: chosen.text, enumerable: true, writable: true, configurable: true });
    }
    json = { text: chosen.text, object, valid };
  }

  // Rationale: the first spelling with text, the keys in the order their settings stand.
  const rationale: Rationale = {};
  const rationaleWinners = new Map<keyof Rationale, string>();
  const rationaleSettings = classified.filter((c) => c.field?.home === 'rationale');
  const won: Array<{ key: keyof Rationale; position: number; text: string; name: string }> = [];
  for (const key of RATIONALE_FIELD_KEYS) {
    const mine = rationaleSettings
      .filter((c) => (c.field as { key: string }).key === key)
      .sort((a, b) => (a.field as { rank: number }).rank - (b.field as { rank: number }).rank);
    const winner = mine.find((c) => c.text !== '');
    if (winner) won.push({ key, position: winner.position, text: winner.text, name: winner.name });
  }
  for (const w of won.sort((a, b) => a.position - b.position)) {
    rationale[w.key] = w.text;
    rationaleWinners.set(w.key, w.name);
  }

  // Meta: the first spelling present, '' included; the meta_json entry last.
  const metaSettings = classified.filter((c) => c.field?.home === 'meta');
  const candidates = new Map<string, Array<{ rank: number; winner: MetaWinner; position: number; sub: number; value: unknown }>>();
  const offer = (key: string, entry: { rank: number; winner: MetaWinner; position: number; sub: number; value: unknown }): void => {
    const list = candidates.get(key);
    if (list) list.push(entry);
    else candidates.set(key, [entry]);
  };
  for (const c of metaSettings) {
    const field = c.field as { key: string; rank: number };
    offer(field.key, { rank: field.rank, winner: { kind: 'setting', name: c.name }, position: c.position, sub: 0, value: c.text });
  }
  if (json) {
    Object.keys(json.object).forEach((k, sub) => offer(k, { rank: JSON_RANK, winner: { kind: 'json' }, position: jsonPosition, sub, value: json!.object[k] }));
  }
  const metaWinners = new Map<string, MetaWinner>();
  const placed: Array<{ key: string; position: number; sub: number; value: unknown }> = [];
  for (const [key, list] of candidates) {
    const best = [...list].sort((a, b) => a.rank - b.rank)[0];
    metaWinners.set(key, best.winner);
    placed.push({ key, position: best.position, sub: best.sub, value: best.value });
  }
  placed.sort((a, b) => a.position - b.position || a.sub - b.sub);
  const raw: Record<string, unknown> = {};
  for (const p of placed) Object.defineProperty(raw, p.key, { value: p.value, enumerable: true, writable: true, configurable: true });
  const meta = readMeta(raw);

  // Every spelling found, in the order it stands.
  const spellings: FieldSettings['spellings'] = [];
  for (const c of classified) {
    const field = c.field;
    if (!field) continue;
    if (field.home === 'rationale') {
      spellings.push({ home: 'rationale', key: field.fieldKey, spelling: field.spelling, name: c.name, used: rationaleWinners.get(field.key) === c.name, value: c.text });
    } else if (field.home === 'meta') {
      const winner = metaWinners.get(field.key);
      spellings.push({ home: 'meta', key: field.key, spelling: field.spelling, name: c.name, used: winner?.kind === 'setting' && winner.name === c.name, value: c.text });
    } else if (json && c.position === jsonPosition) {
      for (const k of Object.keys(json.object)) {
        spellings.push({ home: 'meta', key: k, spelling: 'json', name: c.name, used: metaWinners.get(k)?.kind === 'json', value: json.object[k] });
      }
    }
  }
  return { rationale, rationaleWinners, meta, metaWinners, ...(json ? { json } : {}), spellings };
}

// ---------------------------------------------------------------------------
// How a new file spells meta
// ---------------------------------------------------------------------------

/** How a new file writes one `meta` entry: a bare setting, `meta_<key>`, or inside `meta_json`. */
export type MetaSpelling = 'bare' | 'meta' | 'json';

/**
 * How a `meta` entry is written when it has a setting of its own: text under
 * a key that {@link isBareMetaKey} allows is bare; text under any other
 * identifier key (a reserved one, a built-in kept elsewhere: `meta.note`,
 * `meta.purpose`) is `meta_<key>`; anything else needs `meta_json`.
 */
export function ownMetaSpelling(key: string, value: unknown, scope: FieldScope): 'bare' | 'meta' | undefined {
  if (typeof value !== 'string') return undefined;
  if (isBareMetaKey(key, scope)) return 'bare';
  return FIELD_KEY_PATTERN.test(key) && key !== META_JSON_KEY ? 'meta' : undefined;
}

/** The setting name an entry with its own setting is written under. */
export function ownMetaSettingName(key: string, spelling: 'bare' | 'meta'): string {
  return spelling === 'bare' ? key : `${DBML_RICH_META_PREFIX}${key}`;
}

/**
 * How a new file spells each entry of a `meta` map, in its key order: its
 * own setting ({@link ownMetaSpelling}), except that every entry from the
 * first that needs `meta_json` to the last goes into it, so the map reads
 * back in its key order.
 */
export function metaPlacement(meta: Meta | undefined, scope: FieldScope): Array<{ key: string; value: unknown; spelling: MetaSpelling }> {
  const entries = Object.entries(meta ?? {}).filter(([, value]) => value !== undefined);
  const own = entries.map(([key, value]) => ownMetaSpelling(key, value, scope));
  const first = own.indexOf(undefined);
  const last = own.lastIndexOf(undefined);
  return entries.map(([key, value], i) => ({
    key,
    value,
    spelling: first !== -1 && i >= first && i <= last ? 'json' : own[i]!,
  }));
}

/**
 * Whether a spelling found in a file is an old one: a new file would write
 * that field another way (spec A8). `rationale_<K>` of a built-in, and a
 * `meta` key held as `meta_<k>`, `rationale_<k>` or as a text `meta_json`
 * entry where a new file writes it bare. `erd_` spellings, bare ones,
 * `meta_<k>` of a reserved key and non-text `meta_json` entries are never old.
 */
export function isOldSpelling(
  entry: { home: 'rationale' | 'meta'; key: string; spelling: DbmlFieldSpelling['spelling']; value: unknown },
  placement: ReadonlyMap<string, MetaSpelling>,
  scope: FieldScope,
): boolean {
  if (entry.spelling === 'erd' || entry.spelling === 'bare') return false;
  if (entry.home === 'rationale') return entry.spelling === 'rationale';
  if (entry.spelling === 'rationale') return true;
  if (entry.spelling === 'meta') return isBareMetaKey(entry.key, scope);
  // A meta_json entry: old when it is text a new file writes bare (outside the meta_json span).
  if (typeof entry.value !== 'string' || !isBareMetaKey(entry.key, scope)) return false;
  return placement.get(entry.key) !== 'json';
}
