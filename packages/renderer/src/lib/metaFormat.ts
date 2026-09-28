/**
 * Plain-text rendering of a `meta` map, shared by the Detail panel's
 * MetaEditor and the canvas hover tips.
 */

import type { Meta, MetaValue } from '@erd-studio/core';

/** A value as one line of text: nested values in a compact YAML-flow style. */
export function formatMetaValue(value: MetaValue): string {
  if (value === null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(formatMetaValue).join(', ')}]`;
  return `{ ${Object.entries(value).map(([k, v]) => `${k}: ${formatMetaValue(v)}`).join(', ')} }`;
}

/** `[key, text]` pairs in file order; empty for a missing or empty map. */
export function metaRows(meta: Meta | undefined): [string, string][] {
  return Object.entries(meta ?? {}).map(([key, value]) => [key, formatMetaValue(value)]);
}
