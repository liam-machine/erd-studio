/**
 * DBML's own column settings that a `.dbml` table file stores natively for
 * what an import keeps in `meta.dbml`: `not_null` ⇄ `not null`, `unique` ⇄
 * `unique`, `increment` ⇄ `increment` (each `true`) and `default` ⇄
 * `default: …` (the value as Import DBML keeps it: an expression in
 * backticks, else the text). The one mapping the table reader and writer
 * share, so the model is `meta.dbml` in every format (YAML, the rich export,
 * Import DBML) and only a table file spells it as DBML does.
 *
 * Still read: a `meta_json` that holds these keys (what 2.0 pre-releases
 * wrote) reads as before, and the writer leaves it where it is until the
 * value changes. A `default` that reads as a number, `true`, `false` or
 * `null` stays in `meta_json`: the text alone cannot say whether it was
 * quoted.
 *
 * Pure and parser-free.
 */

import { DBML_IMPORT_META_KEY } from '../fields.js';
import { dbmlString } from '../dbmlText.js';
import type { Meta, MetaValue } from '../types/semantic.js';

/** A `meta.dbml` key and the column setting that holds it, in the canonical column settings order. */
export const NATIVE_COLUMN_SETTINGS: ReadonlyArray<{ key: string; setting: string }> = [
  { key: 'not_null', setting: 'not null' },
  { key: 'unique', setting: 'unique' },
  { key: 'increment', setting: 'increment' },
  { key: 'default', setting: 'default' },
];

const AMBIGUOUS_DEFAULT = /^\s*(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|true|false|null)\s*$/i;

/** Set `key` as an own property, even `__proto__`. */
function put(target: Record<string, MetaValue>, key: string, value: MetaValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isMap(value: unknown): value is Record<string, MetaValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `meta.dbml` when it is a map. */
export function dbmlMetaOf(meta: Meta | undefined): Record<string, MetaValue> | undefined {
  const value = meta?.[DBML_IMPORT_META_KEY];
  return isMap(value) ? value : undefined;
}

/**
 * The column setting that stores `meta.dbml[key] = value` (`not null`,
 * `default: 'new'`, `` default: `now()` ``), or undefined when the value
 * stays in `meta_json` (not `true` for a flag, a default that is not text or
 * whose text would read back as another type).
 */
export function nativeColumnSettingText(key: string, value: MetaValue | undefined): string | undefined {
  const spec = NATIVE_COLUMN_SETTINGS.find((s) => s.key === key);
  if (!spec) return undefined;
  if (key !== 'default') return value === true ? spec.setting : undefined;
  if (typeof value !== 'string' || AMBIGUOUS_DEFAULT.test(value)) return undefined;
  if (/^`[^`\r\n]+`$/.test(value)) return `default: ${value}`;
  return /[`\r\n]/.test(value) ? undefined : `default: ${dbmlString(value)}`;
}

/** The value text of a `default` setting (`'new'`, `` `now()` ``), for an edit that splices the value. */
export function nativeDefaultValueText(value: string): string {
  return nativeColumnSettingText('default', value)!.slice('default: '.length);
}

/** `meta` without the `meta.dbml` keys in `keys` (and without a `dbml` map left empty), or `meta` itself. */
export function withoutDbmlKeys(meta: Meta | undefined, keys: ReadonlySet<string>): Meta | undefined {
  const dbml = dbmlMetaOf(meta);
  if (!dbml || keys.size === 0 || !Object.keys(dbml).some((k) => keys.has(k))) return meta;
  const rest: Record<string, MetaValue> = {};
  for (const [k, v] of Object.entries(dbml)) if (!keys.has(k)) put(rest, k, v);
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta!)) {
    if (k !== DBML_IMPORT_META_KEY) put(out, k, v);
    else if (Object.keys(rest).length > 0) put(out, k, rest);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A new file's split of a column's meta: the settings that store
 * `meta.dbml` natively (in {@link NATIVE_COLUMN_SETTINGS} order) and the
 * meta left for the field settings and `meta_json`.
 */
export function splitNativeColumnSettings(meta: Meta | undefined): { settings: string[]; meta: Meta | undefined } {
  const dbml = dbmlMetaOf(meta);
  if (!dbml) return { settings: [], meta };
  const settings: string[] = [];
  const hoisted = new Set<string>();
  for (const { key } of NATIVE_COLUMN_SETTINGS) {
    const text = nativeColumnSettingText(key, dbml[key]);
    if (text === undefined) continue;
    settings.push(text);
    hoisted.add(key);
  }
  return { settings, meta: withoutDbmlKeys(meta, hoisted) };
}

/**
 * A parsed column's own DBML settings (`field.not_null`, `.unique`,
 * `.increment`, `.dbdefault` of the parser's model) as `meta.dbml` entries.
 */
export function nativeColumnEntries(field: { not_null?: unknown; unique?: unknown; increment?: unknown; dbdefault?: unknown } | undefined): Record<string, MetaValue> {
  const out: Record<string, MetaValue> = {};
  if (!field) return out;
  if (field.not_null === true) out.not_null = true;
  if (field.unique === true) out.unique = true;
  if (field.increment === true) out.increment = true;
  const d = field.dbdefault;
  if (isMap(d) && (typeof d.value === 'string' || typeof d.value === 'number' || typeof d.value === 'boolean')) {
    out.default = d.type === 'expression' ? `\`${d.value}\`` : String(d.value);
  }
  return out;
}

/**
 * `meta` with a column's own DBML settings merged into `meta.dbml` (a new
 * `dbml` entry goes last; a setting wins over a `meta_json` copy of the same
 * key; the map's keys in the order Import DBML writes them). A `meta.dbml` that is not a map is left as it is, and so are the
 * settings (kept in the file, as before).
 */
export function withNativeColumnEntries(meta: Meta | undefined, entries: Record<string, MetaValue>): Meta | undefined {
  if (Object.keys(entries).length === 0) return meta;
  const current = meta?.[DBML_IMPORT_META_KEY];
  if (current !== undefined && !isMap(current)) return meta;
  // In Import DBML's key order (`name`, the settings' keys, then the rest), a setting's value winning.
  const rest: Record<string, MetaValue> = current ?? {};
  const dbml: Record<string, MetaValue> = {};
  const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (has(rest, 'name')) put(dbml, 'name', rest.name);
  for (const { key } of NATIVE_COLUMN_SETTINGS) {
    if (has(entries, key)) put(dbml, key, entries[key]);
    else if (has(rest, key)) put(dbml, key, rest[key]);
  }
  for (const [k, v] of Object.entries(rest)) if (!has(dbml, k)) put(dbml, k, v);
  const out: Meta = {};
  for (const [k, v] of Object.entries(meta ?? {})) put(out, k, v);
  put(out, DBML_IMPORT_META_KEY, dbml);
  return out;
}
