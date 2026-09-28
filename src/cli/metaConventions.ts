/**
 * `inventory.conventions.meta` — which dbt `meta:` keys a project already
 * records, on models and on columns, with how often and a few example values.
 *
 * The `/erd-studio-setup` skill reads this to *offer* carrying those keys onto
 * the logical models (and to save the agreed list as the team's metadata
 * conventions) instead of asking the user cold which metadata they keep.
 * Pure — no I/O. Free of `vscode` — bundled into `dist/cli.js`.
 */

import { formatMetaValue, type Meta, type MetaValue } from '@erd-studio/core';

/** How a key's values look — `yes-no` is a YAML boolean. */
export type MetaValueKind = 'text' | 'yes-no' | 'list' | 'map' | 'empty';

export interface MetaKeyUsage {
  key: string;
  /** Models carrying the key — for a column key, columns carrying it. */
  count: number;
  /** Column keys only: how many models have it on at least one column. */
  models?: number;
  /** The kind most of its values are. */
  kind: MetaValueKind;
  /** Up to {@link META_EXAMPLES} distinct values, one line each, shortened to {@link META_EXAMPLE_LENGTH}. */
  examples: string[];
}

export interface MetaConventions {
  /** Models read (the project's, not only a `--models` selection). */
  totalModels: number;
  /** Models with any `meta`, on the model or on one of its columns. */
  modelsWithMeta: number;
  /** Model-level keys, most used first. */
  models: MetaKeyUsage[];
  /** Column-level keys, most used first. */
  columns: MetaKeyUsage[];
}

/** What detection needs to know about one model. */
export interface MetaConventionModel {
  meta?: Meta;
  columns?: ReadonlyArray<{ meta?: Meta }>;
}

export const META_EXAMPLES = 3;
export const META_EXAMPLE_LENGTH = 60;

export function metaValueKind(value: MetaValue): MetaValueKind {
  if (value === null) return 'empty';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'boolean') return 'yes-no';
  return Array.isArray(value) ? 'list' : 'map';
}

function shorten(text: string): string {
  return text.length > META_EXAMPLE_LENGTH ? `${text.slice(0, META_EXAMPLE_LENGTH - 1)}…` : text;
}

interface Tally {
  count: number;
  models: Set<number>;
  kinds: Map<MetaValueKind, number>;
  examples: string[];
}

function tally(byKey: Map<string, Tally>, key: string, value: MetaValue, model: number): void {
  let entry = byKey.get(key);
  if (!entry) {
    entry = { count: 0, models: new Set(), kinds: new Map(), examples: [] };
    byKey.set(key, entry);
  }
  entry.count++;
  entry.models.add(model);
  const kind = metaValueKind(value);
  entry.kinds.set(kind, (entry.kinds.get(kind) ?? 0) + 1);
  const example = shorten(formatMetaValue(value));
  if (entry.examples.length < META_EXAMPLES && !entry.examples.includes(example)) {
    entry.examples.push(example);
  }
}

function usage(byKey: Map<string, Tally>, withModels: boolean): MetaKeyUsage[] {
  return [...byKey.entries()]
    .map(([key, e]) => ({
      key,
      count: e.count,
      ...(withModels ? { models: e.models.size } : {}),
      // Most common kind; a tie keeps the kind seen first.
      kind: [...e.kinds.entries()].reduce((best, next) => (next[1] > best[1] ? next : best))[0],
      examples: e.examples,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** Pure: the `meta` keys across `models`. */
export function detectMetaConventions(models: readonly MetaConventionModel[]): MetaConventions {
  const modelKeys = new Map<string, Tally>();
  const columnKeys = new Map<string, Tally>();
  let modelsWithMeta = 0;
  models.forEach((m, i) => {
    let any = false;
    for (const [key, value] of Object.entries(m.meta ?? {})) {
      tally(modelKeys, key, value, i);
      any = true;
    }
    for (const c of m.columns ?? []) {
      for (const [key, value] of Object.entries(c.meta ?? {})) {
        tally(columnKeys, key, value, i);
        any = true;
      }
    }
    if (any) { modelsWithMeta++; }
  });
  return {
    totalModels: models.length,
    modelsWithMeta,
    models: usage(modelKeys, false),
    columns: usage(columnKeys, true),
  };
}
