/**
 * `meta` values — the one normalisation every reader of a `meta:` map shares:
 * a logical model file, a dbt schema .yml and a dbt manifest node all become
 * the same {@link Meta} shape, and all render as the same one-line text.
 *
 * No `yaml` import: the manifest worker bundles this file.
 */

import type { Meta, MetaValue } from './types/semantic.js';

/**
 * Set one `meta` entry as an own property. A user's key may be any text,
 * `__proto__` included, and plain assignment would swallow that one.
 */
export function setMetaEntry(meta: Meta, key: string, value: MetaValue): void {
  Object.defineProperty(meta, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Normalise a parsed value into a {@link MetaValue}. Numbers become their text
 * (`1` reads as `'1'`), as every other model field reads them; anything else
 * that is not plain data is read as text too.
 */
function toMetaValue(value: unknown): MetaValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(toMetaValue);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return toMeta(value as Record<string, unknown>);
  }
  return String(value);
}

function toMeta(obj: Record<string, unknown>): Meta {
  const meta: Meta = {};
  for (const [key, value] of Object.entries(obj)) setMetaEntry(meta, key, toMetaValue(value));
  return meta;
}

/**
 * A parsed `meta:` value as a model or column gets it: a non-empty map, or
 * nothing. Several sources merge left to right, a later one winning per
 * top-level key — how dbt merges `meta:` with `config: meta:`.
 */
export function readMeta(...values: unknown[]): Meta | undefined {
  const meta: Meta = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (Object.getPrototypeOf(value) !== Object.prototype) continue;
    for (const [key, entry] of Object.entries(toMeta(value as Record<string, unknown>))) setMetaEntry(meta, key, entry);
  }
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** A value as one line of text: nested values in a compact YAML-flow style. */
export function formatMetaValue(value: MetaValue): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatMetaValue).join(', ')}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${formatMetaValue(v)}`).join(', ')} }`;
}
