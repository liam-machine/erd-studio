/**
 * The two real-world samples Import DBML and Import from dbt read directly
 * (`dbml-qut-workbench`, `dbt-synthea-omop`), run through the scorecard's
 * pipeline (the same pure functions the commands call) and held to what
 * their ANALYSIS.md found broken, now fixed:
 *
 * - QUT: the D18 note counts the 40 NOT NULL foreign keys of 96 (not 96),
 *   the four `0.0` defaults stay `0.0`, the three composite key names are
 *   kept, schema public is said, and nothing is lost silently (Clean);
 * - dbt: `not_null` is kept on every drawn column dbt tests it on, the 38
 *   required relationships are counted in the note, the 5 links to models
 *   the draft does not draw are listed, and the banner names selectors.yml.
 *
 * Conservation: for both, source = imported + reported (no silent loss).
 */

import { describe, expect, it } from 'vitest';

import { loadTruth, runSample as runDetailed, scoreSample, type ImportRun } from './realWorldScorecard';
import { runSample } from './realWorld/scorecardHarness';
import type { ColumnDef } from '../../src/types/semantic';

const truth = loadTruth();
const dbmlOf = (c: ColumnDef): Record<string, unknown> => ((c.meta as Record<string, unknown> | undefined)?.dbml ?? {}) as Record<string, unknown>;

async function run(slug: string): Promise<{ run: ImportRun; score: ReturnType<typeof scoreSample> }> {
  const sample = truth.samples[slug];
  const r = await runDetailed(sample);
  return { run: r, score: scoreSample(slug, sample, r) };
}

describe('dbml-qut-workbench (Import DBML)', () => {
  it('the optional note counts 40 required of 96 relationships (Bug 7, Gap 1)', async () => {
    const { run: r, score } = await run('dbml-qut-workbench');
    expect(r.report).toMatchObject({ relationships: 96, requiredRefs: 40 });
    const note = r.notes.find((n) => /saved as optional/.test(n));
    expect(note).toBe('Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 40 relationships were not optional (their foreign key columns are NOT NULL); the other 56 may be empty.');
    expect(score.requiredFks).toMatchObject({ source: 40, keptNotNull: 40, toldOptional: true, noteClaims: 40 });
  });

  it('the four 0.0 defaults are kept as 0.0 (Bug 3)', async () => {
    const { run: r } = await run('dbml-qut-workbench');
    const at = (table: string, column: string) => dbmlOf(r.tables.find((t) => t.name === table)!.columns!.find((c) => c.name === column)!).default;
    expect(at('anonymous_user_statistics', 'audio_download_duration')).toBe('0.0');
    expect(at('audio_recording_statistics', 'segment_download_duration')).toBe('0.0');
    expect(at('user_statistics', 'audio_download_duration')).toBe('0.0');
    expect(at('user_statistics', 'analyzed_audio_duration')).toBe('0.0');
  });

  it('the composite key names are kept (Bug 2)', async () => {
    const { run: r } = await run('dbml-qut-workbench');
    const pkName = (table: string) => (((r.tables.find((t) => t.name === table)!.meta as Record<string, unknown>).dbml as Record<string, unknown>).primary_key as { name: string }).name;
    expect(pkName('analysis_jobs_scripts')).toBe('analysis_jobs_scripts_pkey');
    expect(pkName('audio_recording_statistics')).toBe('audio_recording_statistics_pkey');
    expect(pkName('user_statistics')).toBe('user_statistics_pkey');
  });

  it('schema public and the 3 enums are said; the suggested name keeps PostgreSQL whole (Bug 4, Gap 3, Bug 8a)', async () => {
    const { run: r, score } = await run('dbml-qut-workbench');
    expect(r.notes).toContain("Tables with no schema or schema public are written in schema main, the layer's name: all 49 tables (active_storage_attachments, active_storage_blobs, active_storage_variant_records and 46 more).");
    expect(r.notes.some((n) => /^3 enums \(analysis_jobs_item_result, analysis_jobs_item_status, analysis_jobs_item_transition\) are kept as the values/.test(n))).toBe(true);
    expect(score.schemas.lostSilently).toEqual([]);
    expect(r.shown.some((s) => /baw-server-on-postgresql/.test(s))).toBe(true);
    expect(r.shown.some((s) => /postgre-sql/.test(s))).toBe(false);
  });

  it('is Clean, and conservation holds: nothing lost silently', async () => {
    const { score } = await run('dbml-qut-workbench');
    expect(score.verdict).toBe('Clean');
    expect(score.reasons).toEqual([]);
    const s = await runSample('dbml-qut-workbench');
    expect(Object.values(s.silentLoss).every((n) => n === 0)).toBe(true);
  });
});

describe('dbt-synthea-omop (Import from dbt)', () => {
  it('not_null is kept on every drawn column dbt tests it on (B1), and the 38 required relationships are counted', async () => {
    const { run: r, score } = await run('dbt-synthea-omop');
    const kept = r.tables.flatMap((t) => t.columns ?? []).filter((c) => dbmlOf(c).not_null === true).length;
    expect(kept).toBe(77);
    expect(score.requiredFks).toMatchObject({ source: 38, keptNotNull: 38 });
    expect(r.shown).toContain(`Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the source, 38 relationships were not optional (their foreign key columns are NOT NULL); the other ${r.relationships.length - 38} may be empty.`);
  });

  it('the 5 links to models the draft does not draw are listed by name (B2), so none is lost silently', async () => {
    const { run: r, score } = await run('dbt-synthea-omop');
    for (const link of ['care_site.location_id → location', 'concept.domain_id → domain', 'concept.vocabulary_id → vocabulary', 'concept.concept_class_id → concept_class', 'person.location_id → location']) {
      expect(r.shown, link).toContain(link);
    }
    expect(score.relationships.missingSilent).toEqual([]);
  });

  it('the banner says Keep also writes selectors.yml (I1), and conservation holds', async () => {
    const { run: r } = await run('dbt-synthea-omop');
    expect(r.shown.some((s) => /selectors\.yml at your dbt project's root/.test(s))).toBe(true);
    const s = await runSample('dbt-synthea-omop');
    expect(Object.values(s.silentLoss).every((n) => n === 0)).toBe(true);
  });
});
