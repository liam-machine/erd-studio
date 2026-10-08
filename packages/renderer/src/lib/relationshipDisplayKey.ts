/**
 * One line per relationship, a composite foreign key included (#133 L2).
 *
 * The members of a composite (entries sharing a `compositeKey`) are folded
 * into one relationship carrying all its column pairs: edges attach to node
 * sides, not column rows, so N member lines between two nodes would only
 * crowd the side. `fromColumn` / `toColumn` stay the first pair, which is what
 * a delete or ⇄ sends — the host expands it to the group.
 */

import type { ColumnPair } from '@erd-studio/core';

type Ends = { fromModel: string; fromColumn: string; toModel: string; toColumn: string };
type WithPairs = Ends & { pairs?: readonly ColumnPair[] };

/** The column pairs a (possibly folded) relationship joins: its `pairs`, else its one pair. */
export function columnPairs(rel: WithPairs): ColumnPair[] {
  return rel.pairs && rel.pairs.length > 0
    ? rel.pairs.map((p) => ({ fromColumn: p.fromColumn, toColumn: p.toColumn }))
    : [{ fromColumn: rel.fromColumn, toColumn: rel.toColumn }];
}

/** `from|a+b|to|c+d`: how an edge and its discrepancy entry find each other. */
export function relationshipDisplayKey(rel: WithPairs): string {
  const pairs = columnPairs(rel);
  return `${rel.fromModel}|${pairs.map((p) => p.fromColumn).join('+')}|${rel.toModel}|${pairs.map((p) => p.toColumn).join('+')}`;
}

/** The React Flow edge id graphTransformer gives a relationship. */
export function relationshipEdgeId(rel: WithPairs): string {
  const pairs = columnPairs(rel);
  return `fk-${rel.fromModel}-${pairs.map((p) => p.fromColumn).join('+')}-${rel.toModel}-${pairs.map((p) => p.toColumn).join('+')}`;
}

/**
 * Fold the members of each composite foreign key into one relationship with
 * `pairs` (two or more), placed where its first member falls; everything else
 * passes through unchanged. Members are grouped by from-model, to-model and
 * `compositeKey`, without case.
 */
export function foldComposites<T extends Ends & { compositeKey?: string }>(rels: readonly T[]): Array<T & { pairs?: ColumnPair[] }> {
  const groups = new Map<string, T[]>();
  const idOf = (r: T): string => [r.fromModel, r.toModel, r.compositeKey!].map((s) => s.toLowerCase()).join('\u0000');
  for (const r of rels) {
    if (!r.compositeKey) continue;
    groups.set(idOf(r), [...(groups.get(idOf(r)) ?? []), r]);
  }
  const out: Array<T & { pairs?: ColumnPair[] }> = [];
  const placed = new Set<string>();
  for (const r of rels) {
    if (!r.compositeKey) {
      out.push(r);
      continue;
    }
    const id = idOf(r);
    if (placed.has(id)) continue;
    placed.add(id);
    const members = groups.get(id)!;
    out.push(members.length < 2 ? r : { ...members[0], pairs: members.map((m) => ({ fromColumn: m.fromColumn, toColumn: m.toColumn })) });
  }
  return out;
}
