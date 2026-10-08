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
  relationshipDifferences,
  relationshipFilePositions,
  sameRelationshipMeaning,
  type RelationshipDiagnostic,
  type RelationshipEnds,
  type RelationshipIssueCode,
  type RelationshipSource,
} from './relationships.js';
import { endEvidenceFromModel, resolveDirection, type EndEvidence } from './relationshipDirection.js';

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
  /**
   * Whether the model library holds a model named exactly `name`. A library
   * entry whose `toModel` matches none of the domain's models exactly is
   * drawn against a case variant (`Dd` → `DD`) only when the library has no
   * model of that exact name: `Dd` and `DD` are then two real models, the
   * entry points at the one this diagram does not hold, and it is not drawn
   * (as any library relationship with an end outside the domain). Without it
   * — a host that cannot list the library — a case variant is assumed to be
   * a respelling.
   */
  libraryHasModel?: (name: string) => boolean;
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
 * one; among library records, the one in its canonical home file, then one
 * whose direction the key flags do not contradict (REL006), then the
 * lowest lowercased holding-model name, then the exact name, then the lowest index; among domain
 * records, the lowest index.
 *
 * Diagnostics: REL001 (a link stored more than once — twice in the library,
 * or, for a link the library does not hold, twice in the domain file: an
 * error when the copies differ in cardinality, role or one-to-one direction,
 * else a warning),
 * REL003 (a domain-file record naming a model the domain does not hold — kept,
 * but there is nothing to draw it between),
 * REL002 (a `one-to-many` in a model file), REL005 (a case-only spelling
 * match), REL006 (the drawn direction contradicts certain key evidence),
 * REL008 (model file entries skipped or defaulted on read) and REL009 (the
 * domain file's own copy of a link the library holds — whatever it says, the
 * library's is drawn and the copy ignored; the message says whether it
 * differs).
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
  // A library entry's target, resolved the way `checkRelationships` resolves
  // it: the domain's exact name, else — only when no library model has that
  // exact name — a case variant among the domain's models.
  const libraryTargetInDomain = (name: string): boolean => {
    if (byExact.has(name)) return true;
    if (!byLower.has(name.toLowerCase())) return false;
    return !(input.libraryHasModel?.(name) ?? false);
  };
  for (const model of modelsInNameOrder) {
    (model.relationships ?? []).forEach((entry, index) => {
      if (!libraryTargetInDomain(entry.toModel)) return;
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

  // Whether the key flags contradict a record's direction (REL006), asked
  // only of records that compete for a link.
  const contradictedCache = new Map<Candidate, boolean>();
  const contradicted = (c: Candidate): boolean => {
    let known = contradictedCache.get(c);
    if (known === undefined) {
      known = keyEvidenceContradiction(c.rel, findModel) !== null;
      contradictedCache.set(c, known);
    }
    return known;
  };
  const rank = (a: Candidate, b: Candidate): number => {
    if (a.source.kind !== b.source.kind) return a.source.kind === 'library' ? -1 : 1;
    if (a.source.kind === 'library') {
      if (a.atHome !== b.atHome) return a.atHome ? -1 : 1;
      // Two copies both at home (a fact's and a dimension's, after a merge
      // with a 1.6.7 teammate's branch): the one the key flags agree with is
      // drawn, never the backwards one because its holder sorts first.
      const ca = contradicted(a);
      const cb = contradicted(b);
      if (ca !== cb) return ca ? 1 : -1;
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
      const library = ordered.filter((c) => c.source.kind === 'library');
      const domain = ordered.filter((c) => c.source.kind === 'domain');
      // A duplicate is two copies a reader chooses between: two in the model
      // library, or — for a link the library does not hold — two in this
      // domain file. The domain file's own copy of a library link is never
      // one: the library's is drawn on every diagram and the copy ignored
      // (REL009), whatever it says.
      const contenders = library.length > 0 ? library : domain;
      if (contenders.length > 1) {
        // A model-library copy in the 1.6.7 shape of the drawn one says the
        // same thing turned round: Repair Relationships… removes it on its
        // own, so it is a warning, never copies to choose between.
        const backwardsCopy = (c: Candidate): boolean => c.source.kind === 'library'
          && !sameRelationshipMeaning(c.rel, winner.rel)
          && isStoredBackwards(c.rel, findModel)
          && sameRelationshipMeaning(turnedRoundRelationship(c.rel), winner.rel);
        const differs = contenders.some((c) => !sameRelationshipMeaning(c.rel, winner.rel) && !backwardsCopy(c));
        const backwards = differs ? [] : contenders.filter(backwardsCopy);
        note('REL001', differs ? 'error' : 'warning',
          differs
            ? `Relationship ${describe(winner.rel)} is stored ${contenders.length} times and the copies disagree ` +
              `(${contenders.map(copy).join('; ')}); ` +
              `drawing the one in ${place(winner.source)}`
            : `Relationship ${describe(winner.rel)} is stored ${contenders.length} times (${contenders.map((c) => place(c.source)).join(', ')}); ` +
              (backwards.length > 0
                ? `the copy in ${backwards.map((c) => place(c.source)).join(' and ')} is the same relationship saved backwards ` +
                  '(the shape ERD Studio 1.6.7 saved for a line drawn from a dimension to a fact) — Repair Relationships… removes it; '
                : '') +
              `drawing the one in ${place(winner.source)}`,
          contenders);
      }
      if (library.length > 0 && domain.length > 0) {
        const differences = [...new Set(domain.flatMap((c) => relationshipDifferences(c.rel, winner.rel)))];
        const here = domain.length === 1 ? `its own copy (${place(domain[0].source)})` : `its own ${domain.length} copies`;
        note('REL009', 'info',
          differences.length === 0
            ? `Relationship ${describe(winner.rel)} is in the model library (${place(winner.source)}) and ${fileName} keeps ${here}, ` +
              'which says the same; the model library\'s is drawn, so the domain file copy is not needed — Repair Relationships… removes it'
            : `Relationship ${describe(winner.rel)} is in the model library (${place(winner.source)}) and ${fileName} keeps ${here}, ` +
              `which differs on ${differences.join(' and ')} (${[winner, ...domain.filter((c) => !sameRelationshipMeaning(c.rel, winner.rel))].map(copy).join('; ')}); ` +
              'the model library\'s is drawn and the domain file copy ignored — delete it if it is wrong',
          [winner, ...domain]);
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

/** `rel` with its two ends swapped (cardinality and role kept). */
function turnedRoundRelationship(rel: Relationship): Relationship {
  return { ...rel, fromModel: rel.toModel, fromColumn: rel.toColumn, toModel: rel.fromModel, toColumn: rel.fromColumn };
}

/**
 * A sentence when the relationship's direction contradicts what the two
 * models' keys say for certain (REL006), else null. Only many-to-one and
 * one-to-one have a direction; a model without that column (a placeholder,
 * an unreadable file) gives no evidence.
 *
 * One contradiction needs only one end's flags: a many-to-one whose from
 * column is its model's whole primary or natural key. A unique column can
 * never be the many side, whatever is known about the other end — the shape
 * 1.6.7 saved for a line dragged from a dimension to a fact (#133 review 8).
 * It is reported when the key flags say nothing about the other end; when
 * they say that end is unique too, the cardinality is what is wrong, not the
 * direction.
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
  const wholeKey = (e: EndEvidence): string | null =>
    e.isPrimaryKey && e.pkColumnCount === 1 ? 'primary key'
      : e.isNaturalKey && e.nkColumnCount === 1 ? 'natural key'
        : null;
  const flagsSilent = (e: EndEvidence): boolean => !e.isPrimaryKey && !e.isNaturalKey && !e.isForeignKeyDeclared;
  const fromKey = wholeKey(a);
  if (canonical.cardinality === 'many-to-one' && fromKey && flagsSilent(b)) {
    return (
      `Relationship ${canonical.fromModel}.${canonical.fromColumn} → ${canonical.toModel}.${canonical.toColumn} ` +
      `makes ${canonical.fromModel} the many side, but ${a.model}.${a.column} is ${a.model}'s ${fromKey}, ` +
      // Only this end is known: the record is turned round, or it is a
      // one-to-one (a subtype sharing its parent's key) — never claim which.
      'so its values are unique and it cannot be the many side: either the relationship runs the other way, ' +
      'or both sides are unique and it is one-to-one'
    );
  }
  const verdict = resolveDirection(a, b);
  if (verdict.confidence !== 'certain') return null;
  // Compared exactly, with the real names the evidence carries: two models
  // whose names differ only in case (`Dd`, `DD`) are two models, and folding
  // them here would call a backwards record agreeing with its own keys.
  if (verdict.from.model === a.model && verdict.from.column === a.column) return null;
  return (
    `Relationship ${canonical.fromModel}.${canonical.fromColumn} → ${canonical.toModel}.${canonical.toColumn} ` +
    `makes ${canonical.fromModel} the ${canonical.cardinality === 'one-to-one' ? 'foreign-key' : 'many'} side, but ` +
    `${verdict.reasons.join('; ')}`
  );
}

/**
 * Whether `rel` is, beyond reasonable doubt, the shape ERD Studio 1.6.7 saved
 * for a line drawn from a dimension to a fact — stored backwards, so turning
 * it round changes nothing the user meant. Read canonically (a `one-to-many`
 * is turned first): a many-to-one whose from-column is its model's whole
 * primary or natural key, whose to-column is no primary or natural key,
 * **and** whose to-model has its own whole primary or natural key on another
 * column (a fact with its own key) or whose to-column is declared a foreign
 * key. REL006 (`keyEvidenceContradiction`) is wider: it
 * also covers a one-to-one aggregate at a dimension's grain pointing at an
 * unflagged dimension, or an SCD2 dimension's natural key pointing at an
 * unflagged source — readings only the user can settle, so they are listed,
 * never turned round on their own (Repair Relationships…, the move, `check`'s
 * `fix: 'rehome'` and the reader's choice between copies all ask this).
 */
export function isStoredBackwards(
  rel: Relationship,
  findModel: (name: string) => SemanticModel | undefined,
): boolean {
  const canonical = canonicalRelationship(rel);
  if (canonical.cardinality !== 'many-to-one') return false;
  const fromModel = findModel(canonical.fromModel);
  const toModel = findModel(canonical.toModel);
  if (!fromModel || !toModel || modelLoadErrorOf(fromModel) || modelLoadErrorOf(toModel)) return false;
  const a = endEvidenceFromModel(fromModel, canonical.fromColumn);
  const b = endEvidenceFromModel(toModel, canonical.toColumn);
  if (!a || !b) return false;
  const fromWholeKey = (a.isPrimaryKey && a.pkColumnCount === 1) || (a.isNaturalKey && a.nkColumnCount === 1);
  if (!fromWholeKey || b.isPrimaryKey || b.isNaturalKey) return false;
  // The to-model's own key on a column other than the one pointed at, or the
  // to-column declared a foreign key: either says the to-model is the many side.
  const toOwnKey = b.pkColumnCount === 1 || b.nkColumnCount === 1;
  if (!toOwnKey && !b.isForeignKeyDeclared) return false;
  return keyEvidenceContradiction(canonical, findModel) !== null;
}
