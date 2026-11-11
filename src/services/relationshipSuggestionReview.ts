/**
 * Suggest Relationships, the review: what the command shows and what it
 * writes, as data. The suggestions themselves come only from the engine
 * (`relationshipSuggestions.ts`, plus the dbt-test adapter in
 * `relationshipSuggestionSources.ts`) through {@link computeSuggestions};
 * nothing here infers a relationship. Accepted ones become ordinary `add`
 * ops for `planRelationshipWrites` (the one write planner), so they are
 * stored exactly as a relationship drawn by hand.
 *
 * Pure: no `vscode`, no Node built-ins. The flow and the QuickPick live in
 * `src/providers/suggestRelationshipsFlow.ts`.
 *
 * The bands are measured (the engine's measurement report): with keys
 * declared "strong" is right ~81–91% of the time; with no keys there is no
 * strong suggestion at all and about half of a messy lakehouse's are wrong.
 * A wrong relationship is worse than a missing one, so only strong rows are
 * ticked, and nothing is ticked when there is none.
 */

import type { DbtKeyIndex } from '@erd-studio/core';
import type { Relationship, SemanticTable } from '../types/semantic';
import { CARDINALITY_NAMES, DIRECTION_QUESTION, directionChoice } from '../types/relationshipWording';
import type { RelationshipWriteOp } from './libraryRelationships';
import { bandRank, suggestionRelationships, suggestRelationships, type RelationshipSuggestion } from './relationshipSuggestions';
import { mergeSuggestions, suggestionsFromDbtTests, type DbtRelationshipTestLike } from './relationshipSuggestionSources';

// ---------------------------------------------------------------------------
// The one way in
// ---------------------------------------------------------------------------

/** What the active diagram holds, as the engine reads it. */
export interface SuggestionSource {
  /** The diagram's tables (unreadable ones already left out). */
  tables: readonly SemanticTable[];
  /** The relationships the diagram draws; each table's own `relationships` are read too. */
  relationships: readonly Relationship[];
  /** dbt's key evidence (unique tests), in a dbt project. */
  dbtKeyIndex?: DbtKeyIndex;
  /** dbt's `relationships` tests, in a dbt project: the project's own statement of a foreign key. */
  dbtTests?: readonly DbtRelationshipTestLike[];
}

/**
 * Every suggestion for a diagram: the engine's naming rules, merged with dbt's
 * relationships tests when there are any. The command, its recompute before
 * writing and the after-import offer all call this, so they always agree. The
 * SQL-join adapter is not wired (it has not been measured).
 */
export function computeSuggestions(source: SuggestionSource): RelationshipSuggestion[] {
  const input = { tables: source.tables, relationships: source.relationships };
  const named = suggestRelationships(input, source.dbtKeyIndex ? { dbtKeyIndex: source.dbtKeyIndex } : {});
  if (!source.dbtTests || source.dbtTests.length === 0) return named;
  return mergeSuggestions(named, suggestionsFromDbtTests(source.dbtTests, input));
}

// ---------------------------------------------------------------------------
// The review list
// ---------------------------------------------------------------------------

/** The list's sections, in order. A suggestion nothing orients is "direction unknown", whatever its band. */
export type ReviewGroup = 'strong' | 'likely' | 'possible' | 'direction';
export const REVIEW_GROUPS: readonly ReviewGroup[] = ['strong', 'likely', 'possible', 'direction'];

/** How many rows the list shows at first, and how many more each press of its More button adds. */
export const REVIEW_PAGE = 500;

export const reviewGroupOf = (s: RelationshipSuggestion): ReviewGroup => (s.direction === 'undecided' ? 'direction' : s.band);

/** Each section's heading: what it means, in plain words, short (VS Code draws it beside the section's first row). */
export function reviewGroupLabel(group: ReviewGroup, dbt: boolean): string {
  switch (group) {
    case 'strong': return dbt ? 'Strong: a key or a dbt test backs these' : 'Strong: a declared key backs these';
    case 'likely': return 'Likely: the names match';
    case 'possible': return 'Possible: a weak match';
    case 'direction': return "Direction unknown: you'll be asked";
  }
}

export interface ReviewRow {
  id: string;
  group: ReviewGroup;
  /** `from_table.column → to_table.column`; a composite's columns joined. */
  label: string;
  /** The cardinality. */
  description: string;
  /** The engine's reasons. */
  detail: string;
  /** Ticked: strong rows only. */
  picked: boolean;
}

export interface ReviewSection {
  group: ReviewGroup;
  label: string;
  rows: ReviewRow[];
}

export interface SuggestionReview {
  title: string;
  placeholder: string;
  sections: ReviewSection[];
  /** Rows listed, of `total`; `hidden` are not listed yet (the More button lists the next {@link REVIEW_PAGE}). */
  shown: number;
  total: number;
  hidden: number;
  /** The More button's tooltip, when rows are hidden. */
  moreLabel?: string;
}

export interface ReviewOptions {
  diagramName: string;
  /** A dbt project (dbt's tests can back a suggestion). Without one, no dbt word is shown. */
  dbt: boolean;
  /** Some table on the diagram marks a key. */
  anyKeys: boolean;
  /** Rows listed beyond the strong ones (default {@link REVIEW_PAGE}). */
  limit?: number;
}

const count = (n: number): string => n.toLocaleString('en-US');

/** `fct_order.customer_id → dim_customer.customer_id`, or `a.x, y → b.u, v` for a composite (Turn Round's form). */
export function suggestionLabel(s: Pick<RelationshipSuggestion, 'fromModel' | 'toModel' | 'pairs'>): string {
  return `${s.fromModel}.${s.pairs.map((p) => p.fromColumn).join(', ')} → ${s.toModel}.${s.pairs.map((p) => p.toColumn).join(', ')}`;
}

export function reviewRow(s: RelationshipSuggestion): ReviewRow {
  const group = reviewGroupOf(s);
  return {
    id: s.id,
    group,
    label: suggestionLabel(s),
    description: CARDINALITY_NAMES[s.cardinality],
    // As the engine words them: they often start with a column's name, which keeps its case.
    detail: s.reasons.join('; '),
    picked: group === 'strong',
  };
}

/** The placeholder: what is ticked and why, in one short line (VS Code cuts a long placeholder off). */
function reviewPlaceholder(strong: number, options: ReviewOptions): string {
  if (strong > 0) return 'Only strong ones are ticked: untick any that are wrong, then press OK.';
  return options.anyKeys
    ? 'Nothing is ticked: none is certain enough, so check each one.'
    : 'Nothing is ticked: no table here has a primary key, so check each one.';
}

/**
 * The review of `suggestions` (in the engine's order): every strong row, then
 * the first `limit` of the rest (likely, possible, direction unknown), each
 * section under its heading.
 */
export function buildSuggestionReview(suggestions: readonly RelationshipSuggestion[], options: ReviewOptions): SuggestionReview {
  const limit = Math.max(0, options.limit ?? REVIEW_PAGE);
  const byGroup = new Map<ReviewGroup, RelationshipSuggestion[]>(REVIEW_GROUPS.map((g) => [g, []]));
  for (const s of suggestions) byGroup.get(reviewGroupOf(s))!.push(s);
  const strong = byGroup.get('strong')!;
  let budget = limit;
  const sections: ReviewSection[] = [];
  for (const group of REVIEW_GROUPS) {
    const all = byGroup.get(group)!;
    const listed = group === 'strong' ? all : all.slice(0, budget);
    if (group !== 'strong') budget -= listed.length;
    if (listed.length > 0) sections.push({ group, label: reviewGroupLabel(group, options.dbt), rows: listed.map(reviewRow) });
  }
  const shown = sections.reduce((n, s) => n + s.rows.length, 0);
  const hidden = suggestions.length - shown;
  return {
    // When not every row is listed, the title says how many are.
    title: `Suggested relationships for ${options.diagramName}${hidden > 0 ? ` (${count(shown)} of ${count(suggestions.length)} listed)` : ''}`,
    placeholder: reviewPlaceholder(strong.length, options),
    sections,
    shown,
    total: suggestions.length,
    hidden,
    ...(hidden > 0 ? { moreLabel: `List ${count(Math.min(hidden, REVIEW_PAGE))} more (${count(hidden)} not listed yet)` } : {}),
  };
}

/** Some table marks a primary or natural key. */
export const anyDeclaredKeys = (tables: readonly SemanticTable[]): boolean =>
  tables.some((t) => (t.columns ?? []).some((c) => c.isPrimaryKey === true || c.isNaturalKey === true));

// ---------------------------------------------------------------------------
// The direction question (the New Relationship dialog's words)
// ---------------------------------------------------------------------------

export type DirectionAnswer = 'asIs' | 'reversed' | 'skip';
export const SKIP_THIS_ONE = 'Skip this one';

export interface DirectionQuestion {
  title: string;
  placeholder: string;
  items: Array<{ label: string; detail?: string; answer: DirectionAnswer }>;
}

/** "Which way does this relationship point?" for one suggestion nothing orients: both ways, by `directionChoice`, then Skip. */
export function directionQuestion(s: RelationshipSuggestion, index: number, of: number): DirectionQuestion {
  const from = { model: s.fromModel, columns: s.pairs.map((p) => p.fromColumn) };
  const to = { model: s.toModel, columns: s.pairs.map((p) => p.toColumn) };
  const asIs = directionChoice(from, to, s.cardinality);
  const reversed = directionChoice(to, from, s.cardinality);
  return {
    title: of > 1 ? `${DIRECTION_QUESTION} (${index} of ${of})` : DIRECTION_QUESTION,
    placeholder: `${suggestionLabel(s).replace(' → ', ' and ')}: nothing in the tables says which way it points. Pick one, or skip it.`,
    items: [
      { label: asIs.text, detail: asIs.detail, answer: 'asIs' },
      { label: reversed.text, detail: reversed.detail, answer: 'reversed' },
      { label: SKIP_THIS_ONE, answer: 'skip' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface AcceptedSuggestion {
  suggestion: RelationshipSuggestion;
  /** The user turned an undecided suggestion round ("Which way…?"). */
  reversed?: boolean;
}

const pairKeysOf = (s: RelationshipSuggestion): string[] => (s.pairs.length > 1 ? s.id.split('\u0001') : [s.id]);

/**
 * What was accepted, still valid against a fresh run of the engine: a
 * suggestion it no longer makes (the link was drawn meanwhile, a table or
 * column went) is dropped, and so is a decided one whose direction changed.
 * A single link that is also a member of an accepted composite is dropped
 * too (the composite takes it in).
 */
export function stillValid(accepted: readonly AcceptedSuggestion[], fresh: readonly RelationshipSuggestion[]): { keep: AcceptedSuggestion[]; dropped: number } {
  const byId = new Map(fresh.map((s) => [s.id, s]));
  const sameWay = (a: RelationshipSuggestion, b: RelationshipSuggestion): boolean =>
    a.fromModel.toLowerCase() === b.fromModel.toLowerCase()
    && a.pairs.length === b.pairs.length
    && a.pairs.every((p, i) => p.fromColumn.toLowerCase() === b.pairs[i].fromColumn.toLowerCase());
  const valid = accepted.filter(({ suggestion: s }) => {
    const now = byId.get(s.id);
    if (!now) return false;
    return s.direction === 'undecided' || (now.direction === 'decided' && sameWay(s, now));
  });
  const inComposites = new Set(valid.filter((a) => a.suggestion.pairs.length > 1).flatMap((a) => pairKeysOf(a.suggestion)));
  const keep = valid.filter((a) => a.suggestion.pairs.length > 1 || !inComposites.has(a.suggestion.id));
  return { keep, dropped: accepted.length - keep.length };
}

/**
 * The accepted suggestions as `add` ops, the shape the New Relationship
 * dialog sends: the first pair drawn, a composite's other pairs as
 * `extraPairs` (the planner gives them one `compositeKey`), turned round when
 * the user said so. No key is marked.
 */
export function suggestionWriteOps(accepted: readonly AcceptedSuggestion[]): RelationshipWriteOp[] {
  return accepted.map(({ suggestion, reversed }) => {
    const entries = suggestionRelationships(suggestion).map((r): Relationship => (reversed
      ? { fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn, cardinality: r.cardinality }
      : { fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, cardinality: r.cardinality }));
    const [drawn, ...rest] = entries;
    return { kind: 'add', drawn, ...(rest.length > 0 ? { extraPairs: rest.map((r) => ({ fromColumn: r.fromColumn, toColumn: r.toColumn })) } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Messages and the after-import offer
// ---------------------------------------------------------------------------

export const SUGGEST_RELATIONSHIPS_TITLE = 'Suggest Relationships';
export const NO_CANVAS_MESSAGE = 'Open a diagram first: Suggest Relationships works on the diagram on screen.';
export const PHYSICAL_STAGE_MESSAGE = 'Relationships are added on the Logical tab. Switch to it, then run Suggest Relationships again.';
export const NOTHING_STILL_APPLIES_MESSAGE =
  'Nothing was added: the diagram changed while you were choosing, and none of the relationships you picked still apply.';

export const noTablesMessage = (diagram: string): string => `${diagram} has no tables yet, so there is nothing to suggest.`;

export const noSuggestionsMessage = (diagram: string): string =>
  `No relationships to suggest for ${diagram}. ERD Studio looks for columns named after another table on the diagram, or after its key.`;

export const unreadableDiagramMessage = (diagram: string, reason: string): string =>
  `Can't suggest relationships: ${diagram} doesn't read (${reason.replace(/\.$/, '')}). Fix it, then try again.`;

export function addedMessage(added: number, diagram: string, dropped: number): string {
  const lead = `Added ${added === 1 ? '1 relationship' : `${count(added)} relationships`} to ${diagram}. Edit > Undo takes ${added === 1 ? 'it' : 'them all'} back.`;
  if (dropped === 0) return lead;
  return `${lead} ${dropped === 1 ? '1 you picked no longer applied and was' : `${count(dropped)} you picked no longer applied and were`} left out.`;
}

/** A refusal from the write path, as the user reads it. */
export const notAddedMessage = (reason: string): string => `Couldn't add the suggested relationships: ${reason}`;

export const REVIEW_SUGGESTIONS_BUTTON = 'Review Suggestions';
export const NOT_NOW_BUTTON = 'Not Now';
export const DONT_ASK_AGAIN_BUTTON = "Don't Ask Again";

/** The offer needs at least this many suggestions at likely or above (the diagram has no relationship at all). */
export const OFFER_MIN_SUGGESTIONS = 1;

/** After an import: offer the review only on a diagram with no relationship, when something likely or stronger was found. */
export function offerAfterImport(relationships: number, suggestions: readonly RelationshipSuggestion[]): boolean {
  if (relationships > 0) return false;
  return suggestions.filter((s) => s.direction === 'decided' && bandRank(s.band) <= bandRank('likely')).length >= OFFER_MIN_SUGGESTIONS;
}

export const importOfferMessage = (suggested: number): string =>
  `This diagram has no relationships yet. ERD Studio found ${count(suggested)} it can suggest.`;
