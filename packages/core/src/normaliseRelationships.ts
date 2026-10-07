/**
 * The one read path for relationships (issue #133).
 *
 * A domain draws its own `logical.relationships` plus every relationship a
 * model library file holds whose two ends are both in the domain. Those
 * records can disagree with each other — the same link stored twice, a
 * `one-to-many` left on the "one" side, an endpoint spelled in another case —
 * and every host (the canvas, the CLI's `diff` and `check`, the MCP server, the
 * read-only viewer) must draw exactly the same thing from the same files.
 * `normaliseRelationships` is that one interpretation. It is pure and
 * deterministic: the result — the drawn relationships and the diagnostics,
 * order included — never depends on the order of the domain's models.
 */

import type { Relationship, SemanticModel } from './types/semantic.js';
import { modelLoadErrorOf } from './types/semantic.js';
import {
  canonicalRelationship,
  linkKey,
  relationshipEnds,
  relationshipFilePositions,
  sameRelationshipMeaning,
  type RelationshipDiagnostic,
  type RelationshipEnds,
  type RelationshipIssueCode,
  type RelationshipSource,
} from './relationships.js';
import { endEvidenceFromModel, resolveDirection } from './relationshipDirection.js';

export interface NormaliseRelationshipsInput {
  /**
   * The domain's models, as resolved. Their `relationships` (library entries)
   * are drawn when both ends are in the domain; pass models without that field
   * for a domain whose models are inline (v4).
   */
  models: readonly SemanticModel[];
  /** The domain file's own `logical.relationships`, as parsed. */
  own: readonly Relationship[];
  /** How the domain file is named in messages. */
  filePath?: string;
  /**
   * Position of each of `own` in the domain file's list as written (entries
   * the reader skipped counted), for "entry N" in messages. Without it, the
   * n-th of `own` is called entry n.
   */
  ownPositions?: readonly number[];
}

export interface NormalisedRelationships {
  /**
   * What the domain draws: one relationship per link (`linkKey`), canonical
   * (never `one-to-many`), endpoints spelled as the real model and column
   * names, each carrying `source`, `stored` and — when something is wrong
   * with its link — `issues`. The domain file's own links come first, in file
   * order; links only the library holds follow, ordered by the model file
   * that holds them, then by position in it.
   */
  relationships: Relationship[];
  /** Everything noticed on the way; nothing is ever dropped without one. */
  diagnostics: RelationshipDiagnostic[];
}

/** One record read from disk, prepared for grouping. */
interface Candidate {
  /** Canonical, respelled, with source/stored attached. */
  rel: Relationship;
  source: RelationshipSource;
  /** Library only: the record sits in the file of its canonical from-model. */
  atHome: boolean;
  /** Lowercased model whose file holds it ('' for the domain file). */
  holder: string;
  index: number;
  respelled: string[];
  /** Stored as `one-to-many` (turned round on read). */
  wasOneToMany: boolean;
}

/**
 * Normalise every relationship a domain draws: canonicalise each record (a
 * `one-to-many` is turned round), fix endpoint spelling to the real model
 * name (case-insensitive among the domain's models) and to the real column
 * name when that model has it, group records by `linkKey`, and draw one per
 * link. The winner is deterministic: a library record beats a domain-file
 * one; among library records, the one in its canonical home file, then the
 * lowest lowercased holding-model name, then the exact name, then the lowest index; among domain
 * records, the lowest index.
 *
 * Diagnostics: REL001 (a link stored more than once: an error when the copies
 * differ in cardinality, role or one-to-one direction, else a warning),
 * REL003 (a domain-file record naming a model the domain does not hold — kept,
 * but there is nothing to draw it between),
 * REL002 (a `one-to-many` in a model file), REL005 (a case-only spelling
 * match), REL006 (the drawn direction contradicts certain key evidence),
 * REL008 (model file entries skipped or defaulted on read) and REL009 (a
 * domain-file copy agreeing with the library's).
 */
export function normaliseRelationships(input: NormaliseRelationshipsInput): NormalisedRelationships {
  const { own } = input;
  const diagnostics: RelationshipDiagnostic[] = [];

  // Distinct models by exact name (a domain may list one twice), resolved
  // without case: an exact match first, then the alphabetically first variant.
  const byExact = new Map<string, SemanticModel>();
  for (const model of input.models) {
    if (!byExact.has(model.name)) byExact.set(model.name, model);
  }
  const byLower = new Map<string, SemanticModel>();
  for (const name of [...byExact.keys()].sort()) {
    const lower = name.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, byExact.get(name)!);
  }
  const findModel = (name: string): SemanticModel | undefined => byExact.get(name) ?? byLower.get(name.toLowerCase());
  const realColumn = (model: SemanticModel | undefined, column: string): string => {
    const columns = model?.columns ?? [];
    if (columns.some((c) => c.name === column)) return column;
    return columns.find((c) => c.name.toLowerCase() === column.toLowerCase())?.name ?? column;
  };

  /** Respell a record's endpoints; returns the respelled record and what changed. */
  const respell = (rel: Relationship): { fixed: Relationship; changed: string[] } => {
    const changed: string[] = [];
    const fromModel = findModel(rel.fromModel);
    const toModel = findModel(rel.toModel);
    const fixed: Relationship = {
      ...rel,
      fromModel: fromModel?.name ?? rel.fromModel,
      fromColumn: realColumn(fromModel, rel.fromColumn),
      toModel: toModel?.name ?? rel.toModel,
      toColumn: realColumn(toModel, rel.toColumn),
    };
    for (const key of ['fromModel', 'fromColumn', 'toModel', 'toColumn'] as const) {
      if (fixed[key] !== rel[key]) changed.push(`${rel[key]} → ${fixed[key]}`);
    }
    return { fixed, changed };
  };

  const candidates: Candidate[] = [];
  const add = (record: Relationship, stored: RelationshipEnds, source: RelationshipSource, holder: string, index: number): void => {
    const { fixed, changed } = respell(record);
    const canonical = canonicalRelationship(fixed);
    const { source: _s, stored: _st, issues: _i, ...plain } = canonical;
    candidates.push({
      rel: { ...plain, source, stored },
      source,
      atHome: source.kind === 'library' && canonical.fromModel.toLowerCase() === holder,
      holder,
      index,
      respelled: changed,
      wasOneToMany: record.cardinality === 'one-to-many',
    });
  };

  // A domain-file record whose end is not one of the domain's models has no
  // node to be drawn between: it is kept (nothing is ever dropped) and marked
  // REL003, so the canvas, `check` and the banner all say so.
  const outside: Array<{ index: number; models: string[] }> = [];
  own.forEach((rel, index) => {
    const missing = [rel.fromModel, rel.toModel].filter((name, i, all) => !findModel(name) && all.indexOf(name) === i);
    if (missing.length > 0) outside.push({ index, models: missing });
    add(rel, relationshipEnds(rel), { kind: 'domain', index }, '', index);
  });
  const outsideByIndex = new Map(outside.map((o) => [o.index, o.models]));
  // Models in name order (lowercased, then exact), never the domain's listing
  // order: the candidates' order decides the order of the link groups and so
  // of the diagnostics, which must not change when `logical.models` is
  // reordered (REL008 included).
  const modelsInNameOrder = [...byExact.values()].sort((a, b) => {
    const la = a.name.toLowerCase();
    const lb = b.name.toLowerCase();
    if (la !== lb) return la < lb ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  for (const model of modelsInNameOrder) {
    (model.relationships ?? []).forEach((entry, index) => {
      if (!findModel(entry.toModel)) return;
      const record: Relationship = { ...entry, fromModel: model.name };
      add(record, relationshipEnds(record), { kind: 'library', model: model.name, index }, model.name.toLowerCase(), index);
    });
    for (const issue of model.relationshipIssues ?? []) {
      diagnostics.push({
        code: 'REL008',
        severity: 'error',
        message: issue.line !== undefined ? `${issue.message} (line ${issue.line})` : issue.message,
        link: '',
        sources: [],
      });
    }
  }

  // Group by link, remembering where each link first appears in the domain file.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = linkKey(c.rel);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }

  const rank = (a: Candidate, b: Candidate): number => {
    if (a.source.kind !== b.source.kind) return a.source.kind === 'library' ? -1 : 1;
    if (a.source.kind === 'library') {
      if (a.atHome !== b.atHome) return a.atHome ? -1 : 1;
      if (a.holder !== b.holder) return a.holder < b.holder ? -1 : 1;
      // Two models whose names differ only in case (`Dd` and `DD`): the exact
      // name decides, so the winner never depends on the domain's model order.
      const ma = (a.source as { model: string }).model;
      const mb = (b.source as { model: string }).model;
      if (ma !== mb) return ma < mb ? -1 : 1;
    }
    return a.index - b.index;
  };

  const describe = (r: Relationship): string => `${r.fromModel}.${r.fromColumn} → ${r.toModel}.${r.toColumn}`;
  const fileName = input.filePath || 'the domain file';
  // "entry N" counts the file's own list, entries the reader skipped included.
  const positions = new Map([...byExact.values()].map((m) => [m.name, relationshipFilePositions(m.relationships?.length ?? 0, m.relationshipIssues)]));
  const place = (s: RelationshipSource): string =>
    s.kind === 'library'
      ? `entry ${(positions.get(s.model)?.[s.index] ?? s.index) + 1} of ${s.model}'s model file`
      : `entry ${(input.ownPositions?.[s.index] ?? s.index) + 1} of ${fileName}`;
  const copy = (c: Candidate): string =>
    `${describe(c.rel)} ${c.rel.cardinality}${c.rel.role ? ` "${c.rel.role}"` : ''} in ${place(c.source)}`;

  const drawn = new Map<string, Relationship>();
  for (const [key, group] of groups) {
    const ordered = [...group].sort(rank);
    const winner = ordered[0];
    const issues = new Set<RelationshipIssueCode>();
    const note = (code: RelationshipIssueCode, severity: RelationshipDiagnostic['severity'], message: string, involved: Candidate[]): void => {
      issues.add(code);
      diagnostics.push({ code, severity, message, link: key, sources: involved.map((c) => c.source) });
    };

    for (const c of ordered) {
      const notHere = c.source.kind === 'domain' ? outsideByIndex.get(c.source.index) : undefined;
      if (notHere) {
        note('REL003', 'error',
          `Relationship ${describe(c.rel)} in ${place(c.source)} points at ${notHere.length === 1 ? 'model' : 'models'} ` +
          `${notHere.join(' and ')}, which ${notHere.length === 1 ? 'is' : 'are'} not in this diagram, so it is not drawn`, [c]);
      }
      if (c.respelled.length > 0) {
        note('REL005', 'warning',
          `Relationship ${describe(c.rel)} in ${place(c.source)} names ${c.respelled.join(', ')} only when case is ignored; ` +
          'drawn with the real names', [c]);
      }
      if (c.source.kind === 'library' && c.wasOneToMany) {
        note('REL002', 'warning',
          `Relationship ${describe(c.rel)} is stored in ${place(c.source)} as one-to-many; it belongs in ` +
          `${c.rel.fromModel}'s model file as many-to-one`, [c]);
      }
    }

    if (ordered.length > 1) {
      const others = ordered.slice(1);
      const library = ordered.filter((c) => c.source.kind === 'library');
      const domain = ordered.filter((c) => c.source.kind === 'domain');
      const differs = others.some((c) => !sameRelationshipMeaning(c.rel, winner.rel));
      if (differs || library.length > 1 || domain.length > 1) {
        const sites = ordered.map((c) => place(c.source));
        note('REL001', differs ? 'error' : 'warning',
          differs
            ? `Relationship ${describe(winner.rel)} is stored ${ordered.length} times and the copies disagree ` +
              `(${ordered.map(copy).join('; ')}); ` +
              `drawing the one in ${place(winner.source)}`
            : `Relationship ${describe(winner.rel)} is stored ${ordered.length} times (${sites.join(', ')}); ` +
              `drawing the one in ${place(winner.source)}`,
          ordered);
      }
      if (!differs && library.length > 0 && domain.length > 0) {
        note('REL009', 'info',
          `Relationship ${describe(winner.rel)} is in the model library (${place(winner.source)}) and also in ${fileName}; ` +
          'the domain file copy is not needed', ordered);
      }
    }

    const direction = keyEvidenceContradiction(winner.rel, findModel);
    if (direction) note('REL006', 'info', direction, [winner]);

    drawn.set(key, issues.size > 0 ? { ...winner.rel, issues: [...issues].sort() } : winner.rel);
  }

  // Domain-file links in file order, then library-only links by holder, index.
  const relationships: Relationship[] = [];
  const emitted = new Set<string>();
  for (const c of candidates) {
    if (c.source.kind !== 'domain') continue;
    const key = linkKey(c.rel);
    if (emitted.has(key)) continue;
    emitted.add(key);
    relationships.push(drawn.get(key)!);
  }
  const rest = [...drawn.entries()].filter(([key]) => !emitted.has(key)).map(([, rel]) => rel);
  rest.sort((a, b) => {
    const sa = a.source as Extract<RelationshipSource, { kind: 'library' }>;
    const sb = b.source as Extract<RelationshipSource, { kind: 'library' }>;
    const ma = sa.model.toLowerCase();
    const mb = sb.model.toLowerCase();
    if (ma !== mb) return ma < mb ? -1 : 1;
    if (sa.model !== sb.model) return sa.model < sb.model ? -1 : 1;
    return sa.index - sb.index;
  });
  relationships.push(...rest);

  return { relationships, diagnostics };
}

/**
 * A sentence when the relationship's direction contradicts what the two
 * models' keys say for certain (REL006), else null. Only many-to-one and
 * one-to-one have a direction; a model without that column (a placeholder,
 * an unreadable file) gives no evidence.
 */
export function keyEvidenceContradiction(
  rel: Relationship,
  findModel: (name: string) => SemanticModel | undefined,
): string | null {
  if (rel.cardinality === 'many-to-many') return null;
  const canonical = canonicalRelationship(rel);
  const fromModel = findModel(canonical.fromModel);
  const toModel = findModel(canonical.toModel);
  if (!fromModel || !toModel || modelLoadErrorOf(fromModel) || modelLoadErrorOf(toModel)) return null;
  const a = endEvidenceFromModel(fromModel, canonical.fromColumn);
  const b = endEvidenceFromModel(toModel, canonical.toColumn);
  if (!a || !b) return null;
  const verdict = resolveDirection(a, b);
  if (verdict.confidence !== 'certain') return null;
  const sameEnd = (x: { model: string; column: string }, model: string, column: string): boolean =>
    x.model.toLowerCase() === model.toLowerCase() && x.column.toLowerCase() === column.toLowerCase();
  if (sameEnd(verdict.from, canonical.fromModel, canonical.fromColumn)) return null;
  return (
    `Relationship ${canonical.fromModel}.${canonical.fromColumn} → ${canonical.toModel}.${canonical.toColumn} ` +
    `makes ${canonical.fromModel} the ${canonical.cardinality === 'one-to-one' ? 'foreign-key' : 'many'} side, but ` +
    `${verdict.reasons.join('; ')}`
  );
}
