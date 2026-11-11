/**
 * The relationship-suggestion measurement, with floors (see relationshipSuggestions.measure.ts for the
 * conditions and how a suggestion is scored). The rules were tuned on TUNE_SAMPLES only; the floors are set
 * a little under what the test half and the holdout scored on their first run, so a change that makes the
 * suggestions worse fails here.
 *
 * Write the full readable report with
 *   SUGGEST_REPORT_DIR=/some/dir npx vitest run test/unit/relationshipSuggestions.measure.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { YmlParserService } from '../../src/services/ymlParserService';
import { suggestRelationships, type SuggestionBand } from '../../src/services/relationshipSuggestions';
import { suggestionsFromDbtTests, suggestionsFromSqlJoins } from '../../src/services/relationshipSuggestionSources';
import {
  CONDITIONS,
  MESSY_HOLDOUT_SLUG,
  MESSY_SLUG,
  PROBE_SLUG,
  TUNE_SAMPLES,
  bandTable,
  contributionTable,
  loadSamples,
  missTable,
  pct,
  precision,
  recallAtOrAbove,
  ruleRuns,
  ruleTable,
  sampleTable,
  scoreSample,
  tally,
  type Condition,
  type Sample,
  type SampleResult,
} from './relationshipSuggestions.measure';
import { largeModel } from './relationshipSuggestions.samples';
import { SAMPLES_ROOT } from './realWorldScorecard';

let samples: Sample[] = [];
const results = new Map<Condition, SampleResult[]>();
const corpus = (c: Condition, half?: Sample['half']): SampleResult[] =>
  results.get(c)!.filter((r) => (half ? r.half === half : r.half === 'tune' || r.half === 'test'));
const byBand = (rs: readonly SampleResult[], band: SuggestionBand) => tally(rs, (s) => s.s.band === band);

beforeAll(async () => {
  samples = await loadSamples();
  for (const c of CONDITIONS) results.set(c, samples.map((s) => scoreSample(s, c)));
}, 120_000);

describe('relationship suggestions on the real-world truth corpus', () => {
  it('splits the corpus into the tuning half and the reported half', () => {
    const tune = samples.filter((s) => s.half === 'tune').map((s) => s.slug);
    expect(tune.sort()).toEqual([...TUNE_SAMPLES].sort());
    expect(samples.filter((s) => s.half === 'test').length).toBeGreaterThanOrEqual(10);
    expect(samples.some((s) => s.slug === PROBE_SLUG && s.half === 'test')).toBe(true);
  });

  it('never suggests a link that already exists (condition C)', () => {
    for (const r of results.get('C')!) expect(r.duplicates, r.slug).toBe(0);
  });

  it('condition A (keys kept): the strong band is precise enough to pre-tick', () => {
    // Raw precision against declared foreign keys only; most "wrong" strong suggestions are true in the data
    // but undeclared (see the report's hand classification).
    expect(precision(byBand(corpus('A'), 'strong'))).toBeGreaterThanOrEqual(0.85);
    expect(precision(byBand(corpus('A', 'test'), 'strong'))).toBeGreaterThanOrEqual(0.78);
    const r = recallAtOrAbove(corpus('A'), 'likely');
    expect(r.found / r.truth).toBeGreaterThanOrEqual(0.8);
  });

  it('condition B (no keys): nothing is strong, and likely holds up', () => {
    expect(byBand(corpus('B'), 'strong').suggested).toBe(0);
    expect(precision(byBand(corpus('B'), 'likely'))).toBeGreaterThanOrEqual(0.75);
    expect(precision(byBand(corpus('B', 'test'), 'likely'))).toBeGreaterThanOrEqual(0.72);
    const r = recallAtOrAbove(corpus('B'), 'possible');
    expect(r.found / r.truth).toBeGreaterThanOrEqual(0.7);
  });

  it('every suggestion carries a reason, a band and a decided or undecided direction', () => {
    for (const c of CONDITIONS) {
      for (const r of results.get(c)!) {
        for (const { s } of r.scored) {
          expect(s.reasons.length, `${r.slug} ${s.id}`).toBeGreaterThan(0);
          expect(s.direction === 'undecided' ? s.band : 'ok').not.toBe('strong');
          expect(s.rules.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the messy lakehouses: the false-suggestion rate is measured, and no strong suggestion is made', () => {
    const messy = results.get('B')!.find((r) => r.slug === MESSY_SLUG)!;
    const holdout = results.get('B')!.find((r) => r.slug === MESSY_HOLDOUT_SLUG)!;
    expect(messy.scored.some((s) => s.s.band === 'strong')).toBe(false);
    expect(holdout.scored.some((s) => s.s.band === 'strong')).toBe(false);
    expect(precision(tally([messy]))).toBeGreaterThanOrEqual(0.85);
    // The holdout was written after the rules froze: half of what it suggests is wrong. This floor only stops it getting worse.
    expect(precision(tally([holdout]))).toBeGreaterThanOrEqual(0.4);
    expect(holdout.found).toBeGreaterThanOrEqual(13);
  });

  it('is deterministic: the same tables in another order give the same suggestions', () => {
    for (const s of samples.slice(0, 6)) {
      const tables = [...s.tables];
      const a = suggestRelationships({ tables });
      const b = suggestRelationships({ tables: [...tables].reverse() });
      expect(b).toEqual(a);
    }
  });

  it('runs in linear-ish time: 2,000 tables of 40 columns', () => {
    const tables = largeModel(2000, 40);
    const t0 = performance.now();
    const out = suggestRelationships({ tables });
    const ms = performance.now() - t0;
    expect(out.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(5000);
    if (process.env.SUGGEST_REPORT_DIR) timing.push({ label: '2,000 tables × 40 columns (80,000 columns)', ms, suggestions: out.length });
    const small = largeModel(500, 40);
    const t1 = performance.now();
    suggestRelationships({ tables: small });
    if (process.env.SUGGEST_REPORT_DIR) timing.push({ label: '500 tables × 40 columns', ms: performance.now() - t1, suggestions: 0 });
  }, 60_000);
});

const timing: Array<{ label: string; ms: number; suggestions: number }> = [];

describe('evidence adapters on the dbt sample', () => {
  const dbtSample = (): Sample => samples.find((s) => s.slug === 'dbt-synthea-omop')!;
  const project = path.join(SAMPLES_ROOT, 'dbt-synthea-omop');

  it('dbt relationships tests: exact, strong, and nothing already drawn', async () => {
    const yml = await new YmlParserService().loadYmlData(project);
    const r = scoreSample(dbtSample(), 'A', {}, (input) => suggestionsFromDbtTests(yml.relationshipTests, input));
    expect(r.scored.every((s) => s.s.band === 'strong' || s.s.band === 'likely')).toBe(true);
    expect(precision(tally([r]))).toBeGreaterThanOrEqual(0.95);
    const c = scoreSample(dbtSample(), 'C', {}, (input) => suggestionsFromDbtTests(yml.relationshipTests, input));
    expect(c.duplicates).toBe(0);
    adapterRows.push({ name: 'dbt relationships tests (condition A)', r }, { name: 'dbt relationships tests (condition C)', r: c });
  });

  it('SQL joins in the dbt models: what resolves to the drawn tables', () => {
    const files: Array<{ name: string; sql: string }> = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.sql')) files.push({ name: path.relative(project, full), sql: fs.readFileSync(full, 'utf-8') });
      }
    };
    walk(path.join(project, 'models'));
    expect(files.length).toBeGreaterThan(50);
    const r = scoreSample(dbtSample(), 'A', {}, (input) => suggestionsFromSqlJoins(files, input));
    adapterRows.push({ name: `SQL joins in ${files.length} dbt model files (condition A)`, r });
    // Every join it does resolve names two drawn tables; whatever it finds is reported, never asserted to be many.
    expect(r.duplicates).toBe(0);
  });
});

const adapterRows: Array<{ name: string; r: SampleResult }> = [];

afterAll(() => {
  const dir = process.env.SUGGEST_REPORT_DIR;
  if (!dir || samples.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const h = (t: string): void => { lines.push('', t, ''); };
  lines.push('# Relationship suggestions: measurement', '', `Generated ${new Date().toISOString()} by test/unit/relationshipSuggestions.measure.test.ts.`);
  lines.push('', `Tuned on (${TUNE_SAMPLES.length}): ${TUNE_SAMPLES.join(', ')}.`, `Reported on (test half): ${samples.filter((s) => s.half === 'test').map((s) => s.slug).join(', ')}.`);
  for (const c of CONDITIONS) {
    h(`## Condition ${c} — ${c === 'A' ? 'foreign keys stripped, keys kept' : c === 'B' ? 'foreign keys and every key stripped (lakehouse)' : 'nothing stripped'}`);
    for (const [label, half] of [['Tuning half', 'tune'], ['Test half', 'test'], ['Both halves', undefined]] as const) {
      const rs = corpus(c, half);
      h(`### ${label}`);
      lines.push(sampleTable(rs), '', bandTable(rs), '', missTable(rs), '', contributionTable(rs));
    }
    for (const [label, half] of [['Messy lakehouse (built while tuning)', 'synthetic'], ['Messy lakehouse 2 (holdout, written after the rules froze)', 'holdout']] as const) {
      const rs = results.get(c)!.filter((r) => r.half === half);
      const t = tally(rs);
      h(`### ${label}`);
      lines.push(sampleTable(rs), '', bandTable(rs), '', `Wrong suggestions that are defensible (a copy's own-layer link mirroring a truth link): ${t.plausible} of ${t.suggested - t.correct}. False-suggestion rate: ${pct((t.suggested - t.correct) / t.suggested)} raw, ${pct((t.suggested - t.correct - t.plausible) / t.suggested)} excluding the defensible ones.`);
    }
  }
  for (const c of ['A', 'B'] as const) {
    for (const [label, half] of [['tuning half', 'tune'], ['test half', 'test']] as const) {
      h(`## Each rule alone, and each filter off — condition ${c}, ${label}`);
      lines.push(ruleTable(ruleRuns(samples.filter((s) => s.half === half), c)));
    }
  }
  h('## Evidence adapters');
  lines.push('| Adapter | Truth | Suggested | Correct | Wrong | Precision | Recall |', '|---|---:|---:|---:|---:|---:|---:|');
  for (const { name, r } of adapterRows) {
    const t = tally([r]);
    lines.push(`| ${name} | ${r.truth} | ${t.suggested} | ${t.correct} | ${t.suggested - t.correct} | ${pct(precision(t))} | ${r.truth ? pct(r.found / r.truth) : '–'} |`);
  }
  h('## Timing');
  for (const t of timing) lines.push(`- ${t.label}: ${t.ms.toFixed(0)} ms${t.suggestions ? ` (${t.suggestions} suggestions)` : ''}`);
  for (const c of CONDITIONS) {
    h(`## Every suggestion not in the truth, and every miss — condition ${c}`);
    for (const r of results.get(c)!) {
      const wrong = r.scored.filter((s) => s.outcome !== 'correct');
      if (wrong.length === 0 && r.missed.length === 0) continue;
      lines.push('', `### ${r.slug} (${r.half})`);
      for (const s of wrong) lines.push(`- ${s.outcome}${s.plausible ? ' (defensible)' : ''} [${s.s.band}] ${s.label} {${s.s.rules.join(', ')}${s.s.keyInferred ? ', key inferred' : ''}${s.s.direction === 'undecided' ? ', undecided' : ''}} — ${s.s.reasons.join('; ')}`);
      for (const m of r.missed) lines.push(`- MISSED (${m.reason}${m.crossSchema ? ', cross-schema' : ''}) ${m.link.label}`);
    }
  }
  fs.writeFileSync(path.join(dir, 'measurement.md'), lines.join('\n') + '\n');
});
