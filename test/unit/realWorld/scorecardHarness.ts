/**
 * The summary scorecard: each real-world sample run through the same pure
 * pipeline its import command calls (`../realWorldScorecard.ts`'s
 * `runSample`, the detailed harness: convert → `readDbml` → `planDbmlImport`
 * → the draft; semantic model → `semanticModelToDbml` → the plan; yml →
 * `buildDbtDraft` → the draft), reduced to the counts conservation is about:
 *
 *   source (expected.ts) = imported + reported + silent loss
 *
 * per unit (tables, columns, primary keys, relationships, descriptions),
 * plus the import's loss ledger by outcome and unit, and its blocking
 * problems. `baseline.json` freezes a run; `realWorldScorecard.test.ts`
 * fails when a sample imports less or loses more silently than it did.
 */
import { ledgerTotals } from '../../../src/services/importLedger';
import {
  loadTruth,
  runSample as runDetailed,
  scoreSample,
  type SampleScore as DetailedScore,
  type Truth,
  type Verdict,
} from '../realWorldScorecard';
import { EXPECTED, type ExpectedCounts } from './expected';

export type Counts = ExpectedCounts;

export const COUNT_KEYS: ReadonlyArray<keyof Counts> = ['tables', 'columns', 'primaryKeys', 'relationships', 'descriptions'];

export interface SampleScore {
  slug: string;
  verdict: Verdict;
  /** The source's own counts (`expected.ts`). */
  expected: Counts;
  /** What came across and matches the source. */
  imported: Counts;
  /** Not imported, and a string the user reads says so. */
  reported: Counts;
  /** Not imported and not said: what conservation forbids (0 for a failed import, which says nothing was imported). */
  silentLoss: Counts;
  /** The import's ledger, by outcome and unit. */
  ledger: ReturnType<typeof ledgerTotals>;
  /** Blocking problems (a failed import's), counted. */
  problems: number;
  /** Why the verdict is not Clean. */
  reasons: string[];
}

let truth: Truth | undefined;
const truthOf = (): Truth => (truth ??= loadTruth());

/** A sample's detailed score (`../realWorldScorecard.ts`) and its ledger. */
export async function runDetailedSample(slug: string): Promise<{ detail: DetailedScore; ledger: ReturnType<typeof ledgerTotals> }> {
  const sample = truthOf().samples[slug];
  if (!sample) throw new Error(`No such sample: ${slug}`);
  const run = await runDetailed(sample);
  return { detail: scoreSample(slug, sample, run), ledger: ledgerTotals(run.ledger ?? []) };
}

/** One sample, scored for conservation. */
export async function runSample(slug: string): Promise<SampleScore> {
  const expected = EXPECTED[slug]?.counts;
  if (!expected) throw new Error(`No expected counts for ${slug} (test/unit/realWorld/expected.ts)`);
  const { detail: d, ledger } = await runDetailedSample(slug);
  const failed = d.verdict === 'Failed';
  const imported: Counts = failed
    ? { tables: 0, columns: 0, primaryKeys: 0, relationships: 0, descriptions: 0 }
    : { tables: d.tables.matched, columns: d.columns.matched, primaryKeys: d.primaryKeys.matched, relationships: d.relationships.matched, descriptions: d.descriptions.exact };
  const reported: Counts = failed
    ? { ...expected }
    : {
      tables: d.tables.missingReported,
      columns: d.columns.missingReported,
      primaryKeys: 0,
      relationships: d.relationships.missingReported,
      descriptions: 0,
    };
  const silentLoss: Counts = failed
    ? { tables: 0, columns: 0, primaryKeys: 0, relationships: 0, descriptions: 0 }
    : {
      tables: d.silentLosses.tables,
      columns: d.silentLosses.columns,
      primaryKeys: d.silentLosses.primaryKeys,
      relationships: d.silentLosses.relationships,
      descriptions: d.silentLosses.descriptions,
    };
  return { slug, verdict: d.verdict, expected, imported, reported, silentLoss, ledger, problems: d.problems.count, reasons: d.reasons };
}

const sum = (c: Counts): number => COUNT_KEYS.reduce((n, k) => n + c[k], 0);

/** A sample's cell: `imported/expected`, with the silent loss when there is one. */
function cell(s: SampleScore | undefined, key: keyof Counts): string {
  if (!s) return '–';
  const loss = s.silentLoss[key] > 0 ? ` (−${s.silentLoss[key]} silent)` : '';
  return `${s.imported[key]}/${s.expected[key]}${loss}`;
}

/**
 * Before and after, one row per sample: the verdict, each unit as
 * `imported/expected` (and its silent loss), the ledger's losses and
 * problems, and the total silent loss.
 */
export function scorecardMarkdown(before: readonly SampleScore[], after: readonly SampleScore[]): string {
  const head = '| Sample | Verdict | Tables | Columns | PKs | Relationships | Descriptions | Ledger lost / problems | Silent loss |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const slugs = [...new Set([...before.map((s) => s.slug), ...after.map((s) => s.slug)])];
  const rows = slugs.map((slug) => {
    const b = before.find((s) => s.slug === slug);
    const a = after.find((s) => s.slug === slug);
    const pair = (f: (s: SampleScore | undefined) => string): string => {
      const x = f(b);
      const y = f(a);
      return x === y ? y : `${x} → ${y}`;
    };
    const ledger = (s: SampleScore | undefined): string => {
      if (!s) return '–';
      const total = (o: keyof SampleScore['ledger']): number => Object.values(s.ledger[o] ?? {}).reduce((n, v) => n + (v ?? 0), 0);
      return `${total('lost')} / ${total('problem')}`;
    };
    return `| ${slug} | ${pair((s) => s?.verdict ?? '–')} | ${COUNT_KEYS.map((k) => pair((s) => cell(s, k))).join(' | ')} | ${pair(ledger)} | ${pair((s) => (s ? String(sum(s.silentLoss)) : '–'))} |`;
  });
  return [head, sep, ...rows].join('\n');
}

/** Regressions of `after` against `before`: fewer imported, or more lost silently, in any unit. */
export function regressions(before: readonly SampleScore[], after: readonly SampleScore[]): string[] {
  const out: string[] = [];
  const rank: Record<Verdict, number> = { Failed: 0, 'With problems': 1, 'With gaps': 2, Clean: 3 };
  for (const b of before) {
    const a = after.find((s) => s.slug === b.slug);
    if (!a) continue;
    if (rank[a.verdict] < rank[b.verdict]) out.push(`${b.slug}: verdict ${b.verdict} → ${a.verdict}`);
    for (const k of COUNT_KEYS) {
      if (a.imported[k] < b.imported[k]) out.push(`${b.slug}: ${k} imported ${b.imported[k]} → ${a.imported[k]}`);
      // A sample that imports for the first time can only now lose silently: judge it by its total imported instead.
      if (rank[b.verdict] > 0 && a.silentLoss[k] > b.silentLoss[k]) out.push(`${b.slug}: ${k} lost silently ${b.silentLoss[k]} → ${a.silentLoss[k]}`);
    }
  }
  return out;
}
