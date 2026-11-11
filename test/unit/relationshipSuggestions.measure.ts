/**
 * The relationship-suggestion measurement: each real-world sample's import (the same pipeline the
 * scorecard drives) with its foreign keys stripped, compared with the source truth in expected.json.
 *
 * Conditions:
 * - A: foreign keys stripped, primary keys and unique keys kept;
 * - B: foreign keys and every key stripped (the lakehouse case: keys are inferred from naming);
 * - C: nothing stripped (nothing that exists may be suggested; what else is proposed is reported).
 *
 * A suggestion is `correct` when its column pairs are exactly a truth link's, in the truth's direction
 * (an undecided suggestion may match either way round); `reversed` when it is a truth link the wrong way
 * round; `partial` when its pairs are part of a composite truth link; otherwise `wrong`.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Relationship, SemanticTable } from '../../src/types/semantic';
import { SEMANTIC_MODEL_META } from '../../src/services/semanticModelImport';
import {
  NAMING_RULES,
  SUGGESTION_BANDS,
  SUGGESTION_RULES,
  suggestRelationships,
  type RelationshipSuggestion,
  type SuggestOptions,
  type SuggestionBand,
  type SuggestionRule,
} from '../../src/services/relationshipSuggestions';
import { importDbmlFlow, canon, loadTruth, qualifySameNames, runSample, type ImportRun, type TruthSample } from './realWorldScorecard';
import { messyLakehouse, messyLakehouseHoldout, type SyntheticLink } from './relationshipSuggestions.samples';

export type Condition = 'A' | 'B' | 'C';
export const CONDITIONS: readonly Condition[] = ['A', 'B', 'C'];

/**
 * Tuned on these samples; the rest (and the live Databricks probe) are only reported. Pagila's two
 * readings and Sakila (the same schema) are all in the tuning half, so nothing leaks across.
 */
export const TUNE_SAMPLES = [
  'dbml-qut-workbench', 'postgres-pagila', 'postgres-pagila-partitions-kept', 'mysql-sakila', 'sqlserver-adventureworks',
  'databricks-open-retail-data-model', 'powerbi-tmdl-bc-purchase', 'oracle-hr', 'snowflake-realtime-datavault',
  'databricks-uc-catalog-as-code', 'bigquery-cloud-learning-platform', 'databricks-adidas-table-manager',
] as const;
export const PROBE_SLUG = 'databricks-uc-probe (live)';
export const MESSY_SLUG = 'synthetic messy lakehouse';
export const MESSY_HOLDOUT_SLUG = 'synthetic messy lakehouse 2 (holdout)';

export interface TruthLink {
  from: string;
  to: string;
  /** canon pair keys `from.fc>to.tc`, FK side first. */
  pairs: string[];
  label: string;
  fromSchema?: string;
  toSchema?: string;
}

export interface Sample {
  slug: string;
  /** `synthetic`: the messy lakehouse built while tuning; `holdout`: the second one, written after the rules were frozen. */
  half: 'tune' | 'test' | 'synthetic' | 'holdout';
  tables: SemanticTable[];
  relationships: Relationship[];
  truth: TruthLink[];
  /** Truth links whose tables the import did not draw (out of reach, not counted). */
  outOfReach: number;
  /** Maps an imported table / column name to the source's (Power BI keeps the original in meta). */
  sourceTable: (name: string) => string;
  sourceColumn: (table: string, column: string) => string;
  /** Messy lakehouse only: defensible links that are not in the truth. */
  plausible?: (s: ScoredSuggestion) => boolean;
}

const pairKey = (from: string, fc: string, to: string, tc: string): string => `${canon(from)}.${canon(fc)}>${canon(to)}.${canon(tc)}`;

function truthLinks(truth: Pick<TruthSample, 'relationships'>): TruthLink[] {
  const groups = new Map<string, TruthSample['relationships']>();
  for (const r of truth.relationships) {
    const k = r.composite ? `${canon(r.from)}:${r.composite}` : pairKey(r.from, r.fromColumn, r.to, r.toColumn);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  return [...groups.values()].map((rs) => ({
    from: rs[0].from,
    to: rs[0].to,
    pairs: rs.map((r) => pairKey(r.from, r.fromColumn, r.to, r.toColumn)),
    label: `${rs[0].from}.${rs.map((r) => r.fromColumn).join('+')} → ${rs[0].to}.${rs.map((r) => r.toColumn).join('+')}`,
    ...(rs[0].fromSchema ? { fromSchema: rs[0].fromSchema } : {}),
    ...(rs[0].toSchema ? { toSchema: rs[0].toSchema } : {}),
  }));
}

function nameMaps(run: ImportRun): Pick<Sample, 'sourceTable' | 'sourceColumn'> {
  const original = (m: { meta?: unknown }): string | undefined => {
    const v = ((m.meta ?? {}) as Record<string, unknown>)[SEMANTIC_MODEL_META.name];
    return typeof v === 'string' && v.trim() ? v : undefined;
  };
  const tables = new Map<string, string>();
  const columns = new Map<string, string>();
  for (const t of run.tables) {
    tables.set(t.name, original(t) ?? t.name);
    for (const c of t.columns ?? []) columns.set(`${t.name}\u0000${c.name}`, original(c) ?? c.name);
  }
  return {
    sourceTable: (n) => tables.get(n) ?? n,
    sourceColumn: (t, c) => columns.get(`${t}\u0000${c}`) ?? c,
  };
}

function sampleFromRun(slug: string, half: Sample['half'], run: ImportRun, truthLinksAll: TruthLink[]): Sample {
  const maps = nameMaps(run);
  const have = new Set(run.tables.map((t) => canon(maps.sourceTable(t.name))));
  const truth = truthLinksAll.filter((l) => have.has(canon(l.from)) && have.has(canon(l.to)));
  return { slug, half, tables: run.tables, relationships: run.relationships, truth, outOfReach: truthLinksAll.length - truth.length, ...maps };
}

export async function loadSamples(): Promise<Sample[]> {
  const truth = loadTruth();
  const out: Sample[] = [];
  for (const [slug, raw] of Object.entries(truth.samples)) {
    const run = await runSample(raw);
    if (!run.ok) continue;
    const t = qualifySameNames(raw);
    out.push(sampleFromRun(slug, (TUNE_SAMPLES as readonly string[]).includes(slug) ? 'tune' : 'test', run, truthLinks(t)));
  }
  out.push(probeSample());
  out.push(messySample());
  out.push(messySample(true));
  return out;
}

/** The live Unity Catalog probe through Import DBML's flow; its truth is its nine foreign-key pairs. */
export function probeSample(): Sample {
  const file = path.join(__dirname, '../fixtures/suggest-relationships/databricks-uc-probe.dbml');
  const run = importDbmlFlow(fs.readFileSync(file, 'utf-8'), 'databricks-uc-probe.dbml', 'file');
  const rel = (from: string, fromColumn: string, to: string, toColumn: string, composite?: string): TruthSample['relationships'][number] =>
    ({ from, fromColumn, to, toColumn, ...(composite ? { composite } : {}) });
  const links = truthLinks({
    relationships: [
      rel('dup_c', 'parent_k', 'dup_a', 'k'),
      rel('employee', 'manager_id', 'employee', 'employee_id'),
      rel('dup_b', 'parent_k', 'dup_a', 'k'),
      rel('fx_transfer', 'from_currency', 'currency', 'currency_code'),
      rel('fx_transfer', 'to_currency', 'currency', 'currency_code'),
      rel('order_line', 'order_id', 'orders', 'order_id'),
      rel('order_line_note', 'ln_no', 'order_line', 'line_no', 'c1'),
      rel('order_line_note', 'ord_id', 'order_line', 'order_id', 'c1'),
      rel('order_line_note', 'ord_id', 'orders', 'order_id'),
      rel('orders', 'customer_id', 'customer', 'customer_id'),
    ],
  });
  return sampleFromRun(PROBE_SLUG, 'test', run, links);
}

export function messySample(holdout = false): Sample {
  const { tables, truth } = holdout ? messyLakehouseHoldout() : messyLakehouse();
  const links = truth.map((l: SyntheticLink) => ({
    from: l.from, to: l.to, pairs: [pairKey(l.from, l.fromColumn, l.to, l.toColumn)], label: `${l.from}.${l.fromColumn} → ${l.to}.${l.toColumn}`,
  }));
  const schemaOf = new Map(tables.map((t) => [t.name, t.schema ?? '']));
  // Defensible: a bronze or silver copy's link that mirrors a truth link (same columns, the copy's own layer).
  const truthByColumns = new Set(truth.map((l) => `${canon(l.fromColumn)}>${canon(l.toColumn)}`));
  const plausible = (s: ScoredSuggestion): boolean => {
    if (schemaOf.get(s.s.fromModel) !== schemaOf.get(s.s.toModel)) return false;
    // The holdout's silver `region` lookup: a silver table's region text pointing at it is defensible (decided before the first run).
    if (holdout && s.s.toModel === 'region' && s.s.pairs.length === 1 && s.s.pairs[0].fromColumn === 'region' && s.s.pairs[0].toColumn === 'region') return true;
    return s.s.pairs.every((p) => truthByColumns.has(`${canon(p.fromColumn)}>${canon(p.toColumn)}`) || truthByColumns.has(`${canon(p.toColumn)}>${canon(p.fromColumn)}`));
  };
  return {
    slug: holdout ? MESSY_HOLDOUT_SLUG : MESSY_SLUG, half: holdout ? 'holdout' : 'synthetic', tables, relationships: [], truth: links, outOfReach: 0,
    sourceTable: (n) => n, sourceColumn: (_t, c) => c, plausible,
  };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

function stripKeysFromMeta(meta: unknown, column: boolean): unknown {
  if (!meta || typeof meta !== 'object') return meta;
  const m = { ...(meta as Record<string, unknown>) };
  const d = m.dbml;
  if (d && typeof d === 'object') {
    const dbml = { ...(d as Record<string, unknown>) };
    if (column) delete dbml.unique;
    else if (Array.isArray(dbml.indexes)) dbml.indexes = (dbml.indexes as Array<Record<string, unknown>>).filter((i) => !i || (i.unique !== true && i.pk !== true));
    m.dbml = dbml;
  }
  return m;
}

export function applyCondition(sample: Sample, condition: Condition): { tables: SemanticTable[]; relationships: Relationship[] } {
  if (condition === 'C') return { tables: sample.tables, relationships: sample.relationships };
  const tables = sample.tables.map((t) => {
    const { relationships: _drop, ...rest } = t;
    void _drop;
    const columns = (t.columns ?? []).map((c) => {
      const { isForeignKey: _fk, ...col } = c;
      void _fk;
      if (condition === 'A') return col;
      const { isPrimaryKey: _pk, isNaturalKey: _nk, ...bare } = col;
      void _pk; void _nk;
      return { ...bare, ...(c.meta ? { meta: stripKeysFromMeta(c.meta, true) as typeof c.meta } : {}) };
    });
    const table: SemanticTable = { ...rest, columns };
    if (condition === 'B' && t.meta) table.meta = stripKeysFromMeta(t.meta, false) as typeof t.meta;
    return table;
  });
  return { tables, relationships: [] };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type Outcome = 'correct' | 'reversed' | 'partial' | 'wrong';
export interface ScoredSuggestion {
  s: RelationshipSuggestion;
  outcome: Outcome;
  label: string;
  /** Messy lakehouse: a wrong suggestion that is defensible. */
  plausible?: boolean;
}
export type MissReason = 'composite' | 'no key' | 'role-playing' | 'same name, not chosen' | 'odd naming';
export interface Miss {
  link: TruthLink;
  reason: MissReason;
  crossSchema: boolean;
}

export interface SampleResult {
  slug: string;
  half: Sample['half'];
  condition: Condition;
  truth: number;
  outOfReach: number;
  scored: ScoredSuggestion[];
  found: number;
  missed: Miss[];
  /** Condition C: suggestions that duplicate an existing link (must be 0). */
  duplicates: number;
  ms: number;
}

export function scoreSample(sample: Sample, condition: Condition, options: SuggestOptions = {}): SampleResult {
  const input = applyCondition(sample, condition);
  const t0 = performance.now();
  const suggestions = suggestRelationships(input, options);
  const ms = performance.now() - t0;

  // Condition C: the existing links are not to be found again; recall is over what is not drawn.
  const existingPairs = new Set<string>();
  const existingLinks = condition === 'C'
    ? [...input.relationships, ...input.tables.flatMap((t) => (t.relationships ?? []).map((r) => ({ ...r, fromModel: t.name }) as Relationship))]
    : [];
  for (const r of existingLinks) {
    const fkAtTo = r.cardinality === 'one-to-many';
    const [f, fc, to, tc] = fkAtTo ? [r.toModel, r.toColumn, r.fromModel, r.fromColumn] : [r.fromModel, r.fromColumn, r.toModel, r.toColumn];
    const k = pairKey(sample.sourceTable(f), sample.sourceColumn(f, fc), sample.sourceTable(to), sample.sourceColumn(to, tc));
    existingPairs.add(k);
    existingPairs.add(pairKey(sample.sourceTable(to), sample.sourceColumn(to, tc), sample.sourceTable(f), sample.sourceColumn(f, fc)));
  }
  const truth = sample.truth.filter((l) => !l.pairs.every((p) => existingPairs.has(p)));

  const truthPairs = new Map<string, TruthLink>();
  for (const l of truth) for (const p of l.pairs) truthPairs.set(p, l);
  const pairsOf = (s: RelationshipSuggestion, reversed: boolean): string[] =>
    s.pairs.map((p) => {
      const f = sample.sourceTable(s.fromModel); const to = sample.sourceTable(s.toModel);
      const fc = sample.sourceColumn(s.fromModel, p.fromColumn); const tc = sample.sourceColumn(s.toModel, p.toColumn);
      return reversed ? pairKey(to, tc, f, fc) : pairKey(f, fc, to, tc);
    });
  const exactly = (pairs: string[]): TruthLink | undefined => {
    const l = truthPairs.get(pairs[0]);
    return l && l.pairs.length === pairs.length && pairs.every((p) => l.pairs.includes(p)) ? l : undefined;
  };
  let duplicates = 0;
  const foundLinks = new Set<TruthLink>();
  const scored: ScoredSuggestion[] = suggestions.map((s) => {
    const fwd = pairsOf(s, false);
    const rev = pairsOf(s, true);
    if (fwd.every((p) => existingPairs.has(p))) duplicates++;
    const label = `${s.fromModel}.${s.pairs.map((p) => p.fromColumn).join('+')} → ${s.toModel}.${s.pairs.map((p) => p.toColumn).join('+')}`;
    let outcome: Outcome = 'wrong';
    const hit = exactly(fwd) ?? (s.direction === 'undecided' ? exactly(rev) : undefined);
    if (hit) { outcome = 'correct'; foundLinks.add(hit); }
    else if (exactly(rev)) outcome = 'reversed';
    else if (fwd.every((p) => truthPairs.has(p))) outcome = 'partial';
    const out: ScoredSuggestion = { s, outcome, label };
    if (outcome !== 'correct' && sample.plausible) out.plausible = sample.plausible(out);
    return out;
  });

  // Why each missed link was missed.
  const tableByName = new Map(input.tables.map((t) => [canon(sample.sourceTable(t.name)), t]));
  const missed: Miss[] = truth.filter((l) => !foundLinks.has(l)).map((l) => {
    const from = tableByName.get(canon(l.from));
    const to = tableByName.get(canon(l.to));
    const crossSchema = !!from && !!to && (from.schema ?? '') !== (to.schema ?? '');
    if (l.pairs.length > 1) return { link: l, reason: 'composite', crossSchema };
    const [fromPart, toPart] = l.pairs[0].split('>');
    const fc = fromPart.slice(fromPart.indexOf('.') + 1);
    const tc = toPart.slice(toPart.indexOf('.') + 1);
    const toCol = (to?.columns ?? []).find((c) => canon(sample.sourceColumn(to!.name, c.name)) === tc);
    const declaredKey = !!toCol && (toCol.isPrimaryKey === true || ((toCol.meta as Record<string, Record<string, unknown>> | undefined)?.dbml?.unique === true));
    const toEntity = canon(l.to).replace(/^(dim|fct|fact|stg|tbl)/, '').replace(/(ies)$/, 'y').replace(/s$/, '');
    if (fc === tc) return { link: l, reason: condition === 'B' || declaredKey ? 'same name, not chosen' : 'no key', crossSchema };
    if (fc.endsWith(tc) || (toEntity && fc.includes(toEntity) && !fc.startsWith(toEntity))) return { link: l, reason: 'role-playing', crossSchema };
    if (!declaredKey && condition !== 'B') return { link: l, reason: 'no key', crossSchema };
    return { link: l, reason: 'odd naming', crossSchema };
  });
  return { slug: sample.slug, half: sample.half, condition, truth: truth.length, outOfReach: sample.outOfReach, scored, found: foundLinks.size, missed, duplicates, ms };
}

// ---------------------------------------------------------------------------
// Totals and the report
// ---------------------------------------------------------------------------

export interface Tally {
  suggested: number;
  correct: number;
  reversed: number;
  partial: number;
  wrong: number;
  plausible: number;
}
const emptyTally = (): Tally => ({ suggested: 0, correct: 0, reversed: 0, partial: 0, wrong: 0, plausible: 0 });
function addTo(t: Tally, s: ScoredSuggestion): void {
  t.suggested++;
  t[s.outcome]++;
  if (s.plausible) t.plausible++;
}

export function tally(results: readonly SampleResult[], filter: (s: ScoredSuggestion) => boolean = () => true): Tally {
  const t = emptyTally();
  for (const r of results) for (const s of r.scored) if (filter(s)) addTo(t, s);
  return t;
}

export const precision = (t: Tally): number => (t.suggested === 0 ? NaN : t.correct / t.suggested);
export const pct = (x: number): string => (Number.isNaN(x) ? '–' : `${(100 * x).toFixed(1)}%`);

/** Recall of everything at or above `band` (strong; strong+likely; all). */
export function recallAtOrAbove(results: readonly SampleResult[], band: SuggestionBand): { found: number; truth: number } {
  const ok = (b: SuggestionBand): boolean => SUGGESTION_BANDS.indexOf(b) <= SUGGESTION_BANDS.indexOf(band);
  let found = 0;
  let truth = 0;
  for (const r of results) {
    truth += r.truth;
    found += r.scored.filter((s) => s.outcome === 'correct' && ok(s.s.band)).length;
  }
  return { found, truth };
}

export function bandTable(results: readonly SampleResult[]): string {
  const rows = ['| Band | Suggested | Correct | Reversed | Partial | Wrong | Precision | Recall (this band and above) |', '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const b of SUGGESTION_BANDS) {
    const t = tally(results, (s) => s.s.band === b);
    const r = recallAtOrAbove(results, b);
    rows.push(`| ${b} | ${t.suggested} | ${t.correct} | ${t.reversed} | ${t.partial} | ${t.wrong} | ${pct(precision(t))} | ${r.found}/${r.truth} = ${pct(r.found / r.truth)} |`);
  }
  const all = tally(results);
  const r = recallAtOrAbove(results, 'possible');
  rows.push(`| **all** | ${all.suggested} | ${all.correct} | ${all.reversed} | ${all.partial} | ${all.wrong} | ${pct(precision(all))} | ${r.found}/${r.truth} = ${pct(r.found / r.truth)} |`);
  return rows.join('\n');
}

export function sampleTable(results: readonly SampleResult[]): string {
  const rows = ['| Sample | Half | Truth (out of reach) | Suggested (S/L/P) | Correct (S/L/P) | Wrong+rev+partial | Strong precision | Recall all | ms |', '|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const r of results) {
    const by = (b: SuggestionBand, o?: Outcome): number => r.scored.filter((s) => s.s.band === b && (!o || s.outcome === o)).length;
    const strong = tally([r], (s) => s.s.band === 'strong');
    rows.push(`| ${r.slug} | ${r.half} | ${r.truth} (${r.outOfReach}) | ${r.scored.length} (${by('strong')}/${by('likely')}/${by('possible')}) | ${r.found} (${by('strong', 'correct')}/${by('likely', 'correct')}/${by('possible', 'correct')}) | ${r.scored.length - r.found} | ${pct(precision(strong))} | ${r.found}/${r.truth} | ${r.ms.toFixed(1)} |`);
  }
  return rows.join('\n');
}

export function missTable(results: readonly SampleResult[]): string {
  const reasons: MissReason[] = ['composite', 'no key', 'role-playing', 'same name, not chosen', 'odd naming'];
  const rows = ['| Reason | Missed | of which cross-schema |', '|---|---:|---:|'];
  for (const reason of reasons) {
    const ms = results.flatMap((r) => r.missed.filter((m) => m.reason === reason));
    rows.push(`| ${reason} | ${ms.length} | ${ms.filter((m) => m.crossSchema).length} |`);
  }
  return rows.join('\n');
}

/** Each rule alone, then the whole engine with each filter switched off. */
export function ruleRuns(samples: readonly Sample[], condition: Condition): Array<{ name: string; results: SampleResult[] }> {
  const runs: Array<{ name: string; results: SampleResult[] }> = [];
  for (const rule of NAMING_RULES) {
    runs.push({ name: `${rule} alone`, results: samples.map((s) => scoreSample(s, condition, { rules: [rule] as SuggestionRule[] })) });
  }
  runs.push({ name: 'all rules', results: samples.map((s) => scoreSample(s, condition)) });
  runs.push({ name: 'all, type check off', results: samples.map((s) => scoreSample(s, condition, { typeCheck: false })) });
  runs.push({ name: 'all, suppression off', results: samples.map((s) => scoreSample(s, condition, { suppress: false })) });
  runs.push({ name: 'all, key inference off', results: samples.map((s) => scoreSample(s, condition, { inferKeys: false })) });
  return runs;
}

export function ruleTable(runs: ReturnType<typeof ruleRuns>): string {
  const rows = ['| Run | Suggested | Correct | Wrong (+rev+partial) | Precision | Recall | Strong: suggested / precision |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const { name, results } of runs) {
    const t = tally(results);
    const r = recallAtOrAbove(results, 'possible');
    const st = tally(results, (s) => s.s.band === 'strong');
    rows.push(`| ${name} | ${t.suggested} | ${t.correct} | ${t.suggested - t.correct} | ${pct(precision(t))} | ${pct(r.found / r.truth)} | ${st.suggested} / ${pct(precision(st))} |`);
  }
  return rows.join('\n');
}

/** Per supporting rule within the full engine: the suggestions each rule took part in. */
export function contributionTable(results: readonly SampleResult[]): string {
  const rows = ['| Rule (in the full engine) | Suggestions it supports | Correct | Precision |', '|---|---:|---:|---:|'];
  for (const rule of SUGGESTION_RULES) {
    const t = tally(results, (s) => s.s.rules.includes(rule));
    if (t.suggested) rows.push(`| ${rule} | ${t.suggested} | ${t.correct} | ${pct(precision(t))} |`);
  }
  const inf = tally(results, (s) => s.s.keyInferred);
  rows.push(`| (key inferred) | ${inf.suggested} | ${inf.correct} | ${pct(precision(inf))} |`);
  const und = tally(results, (s) => s.s.direction === 'undecided');
  rows.push(`| (direction undecided) | ${und.suggested} | ${und.correct} | ${pct(precision(und))} |`);
  return rows.join('\n');
}
