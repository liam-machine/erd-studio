/**
 * badgeLabels — the abbreviations and symbols the canvas stamps on nodes and
 * columns, and the prose that decodes them.
 *
 * These live here rather than in ModelNode because the Legend explains exactly
 * this vocabulary. Two copies of "WH means the warehouse catalog" is two things
 * to keep in step, and the legend is precisely the copy nobody edits when the
 * node changes. Both ends import these maps, so a new source or a renamed chip
 * shows up in the legend for free.
 *
 * Pure data — no vscode, no DOM.
 */

import type { PhysicalColumnSource } from '@erd-studio/core';

/**
 * Header chip text for each physical column source. Three letters, because the
 * chip shares a fixed-height header row with the name and the schema badge —
 * the sentence-length explanation lives in the chip's title and in the
 * DetailPanel's "Columns from" row.
 */
export const SOURCE_LABEL: Record<PhysicalColumnSource, string> = {
  catalog: 'WH',
  yml: 'YML',
  manifest: 'DBT',
  file: 'SQL',
};

/** How each source is named in prose (chip tooltip). */
export const SOURCE_PHRASE: Record<PhysicalColumnSource, string> = {
  catalog: 'the warehouse catalog',
  yml: 'your dbt .yml',
  manifest: 'the dbt manifest',
  file: 'the source file only',
};

/**
 * The order the legend lists the sources in: most authoritative first, which is
 * also the order `provenance.columns` arrives in.
 */
export const SOURCE_ORDER: PhysicalColumnSource[] = ['catalog', 'yml', 'manifest', 'file'];

/** One line per source for the legend, saying what having that chip means. */
export const SOURCE_LEGEND_DESC: Record<PhysicalColumnSource, string> = {
  catalog: 'Warehouse catalog — types read back from the database',
  yml: 'Your dbt schema .yml — the types you declared',
  manifest: 'The compiled dbt manifest',
  file: 'A source file only — nothing declares its columns',
};

/** Unicode circled numbers for SCD type badges. */
export const SCD_BADGE: Record<number, string> = {
  0: '⓪', // ⓪
  1: '①', // ①
  2: '②', // ②
};

/**
 * What each SCD badge is claiming, for the badge's title. A bare "SCD Type 2"
 * only re-reads the number back to someone who is hovering precisely because
 * the number meant nothing to them.
 */
export const SCD_TITLE: Record<number, string> = {
  0: 'SCD Type 0 — fixed at first load; later changes are ignored',
  1: 'SCD Type 1 — changes overwrite the old value, no history kept',
  2: 'SCD Type 2 — each change opens a new row, history preserved',
};

/** Symbols for additive type badges. */
export const ADDITIVE_BADGE: Record<string, string> = {
  'additive': 'Σ',      // Σ
  'semi-additive': '~',
  'non-additive': '÷',  // ÷
};

/** The same courtesy for the additive symbols. */
export const ADDITIVE_TITLE: Record<string, string> = {
  'additive': 'Additive (Σ) — safe to sum across every dimension',
  'semi-additive': 'Semi-additive (~) — summable across some dimensions, but not over time',
  'non-additive': 'Non-additive (÷) — cannot be summed at all, e.g. a ratio or a rate',
};

// ---------------------------------------------------------------------------
// Relationship edges
// ---------------------------------------------------------------------------

/**
 * What a coloured or dashed edge is claiming during a comparison. The colours
 * alone carry this today, which is unreadable to anyone who has not just read
 * the legend — and invisible to anyone who cannot tell amber from red.
 */
export const DISCREPANCY_PHRASE: Record<'extra' | 'missing' | 'cardinality-mismatch', string> = {
  'extra': 'only in the stage you are viewing',
  'missing': 'only in the stage being compared against',
  'cardinality-mismatch': 'cardinality differs between stages',
};

/** The fields of an edge that its hover text is built from. */
export interface EdgeHoverInput {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: string;
  discrepancyStatus?: 'extra' | 'missing' | 'cardinality-mismatch';
}

/**
 * Hover text for a relationship line: which columns it joins, its cardinality,
 * and — during a comparison — what its colour is saying. The `*` / `1` glyphs
 * are `pointer-events: none` so the line itself is the only part of an edge
 * that can carry this.
 */
export function edgeHoverText(edge: EdgeHoverInput): string {
  return [
    `${edge.fromModel}.${edge.fromColumn} \u2192 ${edge.toModel}.${edge.toColumn}`,
    edge.cardinality.replace(/-/g, ' '),
    edge.discrepancyStatus ? DISCREPANCY_PHRASE[edge.discrepancyStatus] : '',
  ].filter(Boolean).join(' \u00b7 ');
}
