/**
 * The summary scorecard against its frozen baseline (test/unit/realWorld/).
 *
 * Every sample under test/fixtures/real-world-imports/ goes through its
 * import command's own pure pipeline (`scorecardHarness.ts`) and is held to
 * conservation: source = imported + reported + silent loss. The test fails
 * when any sample imports less, or loses more without a word, than
 * `baseline.json` records; an improvement passes (refresh the baseline in
 * the same change so it ratchets).
 *
 *   npx vitest run test/unit/realWorldScorecard.test.ts                      # check, print before/after
 *   ERD_SCORECARD_OUT=/tmp/after.json npx vitest run test/unit/realWorldScorecard.test.ts
 *   UPDATE_BASELINE=1 npx vitest run test/unit/realWorldScorecard.test.ts    # rewrite baseline.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { EXPECTED, SAMPLE_SLUGS } from './realWorld/expected';
import { COUNT_KEYS, regressions, runSample, scorecardMarkdown, type SampleScore } from './realWorld/scorecardHarness';
import { SAMPLES_ROOT, loadTruth, qualifySameNames, scoreSample, type ImportRun, type TruthSample } from './realWorldScorecard';

const BASELINE = path.join(__dirname, 'realWorld', 'baseline.json');

interface Baseline { samples: SampleScore[] }

const baseline: Baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf-8')) as Baseline;

describe('real-world scorecard against its baseline', () => {
  const after: SampleScore[] = [];

  it('has a baseline and expected counts for every sample', () => {
    expect(baseline.samples.map((s) => s.slug).sort()).toEqual([...SAMPLE_SLUGS].sort());
    for (const s of baseline.samples) expect(s.expected, s.slug).toEqual(EXPECTED[s.slug].counts);
  });

  it('covers every sample folder, and the same samples as the detailed scorecard (expected.json)', () => {
    const truth = loadTruth();
    expect([...SAMPLE_SLUGS].sort()).toEqual(Object.keys(truth.samples).sort());
    // Each folder under test/fixtures/real-world-imports/ is some sample's input.
    const inputs = new Set(Object.values(truth.samples).flatMap((s) => [s.input.folder, s.input.file, s.input.project, ...(s.input.files ?? [])])
      .filter((p): p is string => !!p).map((p) => p.split('/')[0]));
    const folders = fs.readdirSync(SAMPLES_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const folder of folders) expect(inputs.has(folder), folder).toBe(true);
    // A sample's counts here are its truth's.
    for (const slug of SAMPLE_SLUGS) {
      const { descriptions: _d, ...counts } = EXPECTED[slug].counts;
      expect(counts, slug).toEqual(truth.samples[slug].counts);
    }
  });

  for (const slug of SAMPLE_SLUGS) {
    it(`scores ${slug}, conserving every unit`, async () => {
      const score = await runSample(slug);
      after.push(score);
      for (const k of COUNT_KEYS) {
        // Nothing is counted twice: what came across, what was said and what was lost never add up past the source.
        expect(score.imported[k] + score.reported[k] + score.silentLoss[k], `${slug} ${k}`).toBeLessThanOrEqual(score.expected[k]);
      }
      // A table is imported, reported or lost silently: exactly one.
      if (score.verdict !== 'Failed') {
        expect(score.imported.tables + score.reported.tables + score.silentLoss.tables, `${slug} tables`).toBe(score.expected.tables);
      }
    }, 120_000);
  }

  it('regresses on no sample, and prints the before/after table', () => {
    const ordered = SAMPLE_SLUGS.map((s) => after.find((x) => x.slug === s)).filter((s): s is SampleScore => !!s);
    if (ordered.length < SAMPLE_SLUGS.length) return; // a sample failed above
    console.log(scorecardMarkdown(baseline.samples, ordered));
    const out = process.env.ERD_SCORECARD_OUT;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ samples: ordered }, null, 2) + '\n');
    }
    if (process.env.UPDATE_BASELINE) {
      fs.writeFileSync(BASELINE, JSON.stringify({ samples: ordered }, null, 2) + '\n');
      return;
    }
    expect(regressions(baseline.samples, ordered)).toEqual([]);
  });
});

describe('same-name tables in two schemas', () => {
  it('are scored as Import DBML names them: schema_name, with t_ before a name that starts with a digit', () => {
    const table = (schema: string, name: string) => ({ schema, name, pk: [], columns: [['id', 'INT', '']] });
    const truth = {
      importer: 'sql', input: {}, counts: { tables: 3, columns: 3, primaryKeys: 0, relationships: 1 },
      tables: [table('sales', 'customer'), table('340b_slvr', 'customer'), table('sales', 'orders')],
      relationships: [{ from: 'orders', fromSchema: 'sales', fromColumn: 'id', to: 'customer', toSchema: '340b_slvr', toColumn: 'id' }],
      uniqueKeys: [],
    } as unknown as TruthSample;
    const q = qualifySameNames(truth);
    expect(q.tables.map((t) => t.name)).toEqual(['sales_customer', 't_340b_slvr_customer', 'orders']);
    expect(q.relationships[0].to).toBe('t_340b_slvr_customer');
  });
});

describe('a primary key chosen differently from the source', () => {
  const truth = {
    importer: 'sql', input: {}, counts: { tables: 1, columns: 2, primaryKeys: 1, relationships: 0 },
    tables: [{ name: 'DimDate', pk: ['Date'], columns: [['Date', 'DATE', 'PN'], ['DateKey', 'INT', '']] }],
    relationships: [], uniqueKeys: [],
  } as unknown as TruthSample;
  const run = (shown: string[]): ImportRun => ({
    ok: true, tables: [{ name: 'DimDate', columns: [{ name: 'Date', dataType: 'DATE' }, { name: 'DateKey', dataType: 'INT', isPrimaryKey: true }] }] as ImportRun['tables'],
    relationships: [], problems: [], warnings: [], notes: [], leftOut: [], shown, leftOutTables: [],
  });

  it('is a gap when a shown note names the table, the key and the source\'s key columns', () => {
    const s = scoreSample('s', truth, run(['DimDate: every relationship joins DateKey, so it is the key; Date, which Mark as date table flags isKey, is marked unique.']));
    expect(s.primaryKeys.wrongReported).toBe(1);
    expect(s.silentLosses.primaryKeys).toBe(0);
    expect(s.verdict).toBe('With gaps');
  });

  it('is a silent loss when nothing says so', () => {
    const s = scoreSample('s', truth, run(['DimDate: 2 columns']));
    expect(s.silentLosses.primaryKeys).toBe(1);
    expect(s.verdict).toBe('With problems');
  });

  it('is a silent loss when the words are only scattered over lines that say nothing of the choice', () => {
    // A table named as its key column (Date.Date): `date_key` alone names the table and a key, and any line names Date.
    const dated = {
      ...truth,
      tables: [{ name: 'Date', pk: ['Date'], columns: [['Date', 'DATE', 'PN'], ['DateKey', 'INT', '']] }],
    } as unknown as TruthSample;
    const given = run(['date: 2 columns · primary key date_key', 'sales.order_date_key → date.date_key']);
    given.tables[0].name = 'Date';
    const s = scoreSample('s', dated, given);
    expect(s.primaryKeys.wrongReported).toBe(0);
    expect(s.silentLosses.primaryKeys).toBe(1);
  });
});

describe('scorecard harness rules', () => {
  const zero = { tables: 0, columns: 0, primaryKeys: 0, relationships: 0, descriptions: 0 };
  const score = (over: Partial<SampleScore>): SampleScore => ({
    slug: 's', verdict: 'With gaps', expected: { ...zero, tables: 3 }, imported: { ...zero, tables: 3 }, reported: zero, silentLoss: zero,
    ledger: { lost: {}, changed: {}, repaired: {}, skipped: {}, problem: {} }, problems: 0, reasons: [], ...over,
  });

  it('a sample that imports less, or loses more silently, is a regression; one that improves is not', () => {
    const before = [score({})];
    expect(regressions(before, [score({ imported: { ...zero, tables: 2 }, silentLoss: { ...zero, tables: 1 }, verdict: 'With problems' })])).toEqual([
      's: verdict With gaps → With problems',
      's: tables imported 3 → 2',
      's: tables lost silently 0 → 1',
    ]);
    expect(regressions(before, [score({ verdict: 'Clean' })])).toEqual([]);
    // A failed sample that starts importing may lose some silently: that is not worse than importing nothing.
    expect(regressions([score({ verdict: 'Failed', imported: zero })], [score({ silentLoss: { ...zero, columns: 4 } })])).toEqual([]);
  });

  it('prints one row per sample, with the change when there is one', () => {
    const table = scorecardMarkdown([score({ verdict: 'Failed', imported: zero })], [score({})]);
    expect(table.split('\n')).toHaveLength(3);
    expect(table).toContain('| s | Failed → With gaps | 0/3 → 3/3 |');
  });
});
