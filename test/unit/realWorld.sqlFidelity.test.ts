/**
 * sql-fidelity against the six real published SQL samples
 * (`test/fixtures/real-world-imports/`), each run through the command's own
 * pipeline (`realWorldScorecard.ts`: gather, the detected dialect, the
 * converter, then Import DBML's plan) and held to its independently counted
 * source truth (`expected.json`):
 *
 *  - pagila: 73 `timestamp with time zone` columns and `public.vector(20)`
 *    kept as written, 5 unique indexes kept as unique keys, film_embedding
 *    (FK = its whole key) one-to-one, the 55 partitions said;
 *  - AdventureWorks: all 90 FKs from the ALTER TABLE action lists (the
 *    composite too), all 530 MS_Description descriptions, every AK unique
 *    index, the 6 one-to-ones (FK = whole key);
 *  - Snowflake: `USE SCHEMA` keeps RAW / ML / STAGING / UNSTRUCTURED, and all
 *    12 FKs resolve (4 cross-schema);
 *  - Harbor: 14 FKs exactly (the dropped one gone, the one in a DO block
 *    in), no stale unique keys, 3 time zones kept;
 *  - Sakila: every UNSIGNED column kept (36: the file's other two are a
 *    procedure's parameter and its temporary table), the 22 FK actions
 *    listed by Import, the store manager one-to-one, schema sakila;
 *  - conservation on every sample: no table, column or relationship lost
 *    without a word, nothing extra.
 */
import { describe, expect, it } from 'vitest';

import { canon, loadTruth, runSample, scoreSample, type ImportRun, type SampleScore } from './realWorldScorecard';

const truth = loadTruth();
const SQL_SAMPLES = ['postgres-pagila', 'mysql-sakila', 'sqlserver-adventureworks', 'snowflake-grid-reliability', 'databricks-open-retail-data-model', 'migrations-harbor'] as const;

const runs = new Map<string, Promise<{ run: ImportRun; score: SampleScore }>>();
function sample(slug: string): Promise<{ run: ImportRun; score: SampleScore }> {
  if (!runs.has(slug)) {
    runs.set(slug, runSample(truth.samples[slug]).then((run) => ({ run, score: scoreSample(slug, truth.samples[slug], run) })));
  }
  return runs.get(slug)!;
}

const column = (run: ImportRun, table: string, name: string) =>
  run.tables.find((t) => canon(t.name) === canon(table))?.columns?.find((c) => canon(c.name) === canon(name));

describe('sql-fidelity: the real-world samples', () => {
  it('pagila: time zones, vector(20), unique indexes, film_embedding one-to-one, partitions said', async () => {
    const { run, score } = await sample('postgres-pagila');
    expect(score.tables.matched).toBe(71);
    expect(run.tables.flatMap((t) => t.columns ?? []).filter((c) => /with time zone/i.test(c.dataType))).toHaveLength(73);
    expect(column(run, 'film_embedding', 'embedding')?.dataType).toBe('public.vector(20)');
    expect(score.uniqueKeys).toMatchObject({ source: 5, kept: 5, lost: 0 });
    expect(score.oneToOne).toMatchObject({ source: 1, imported: 1, drawnAsMany: [] });
    expect(run.relationships.find((r) => r.fromModel === 'film_embedding')).toMatchObject({ toModel: 'film', cardinality: 'one-to-one' });
    expect(score.types.detailLost).toEqual([]);
    expect(run.notes.some((n) => /55 tables: partitions of public\.payment/.test(n))).toBe(true);
    expect(run.leftOut.some((n) => /generated column expression/.test(n) && /length_hours/.test(n))).toBe(true);
  });

  it('AdventureWorks: 90 FKs from the ALTER lists, 530 descriptions, every AK, 6 one-to-ones', async () => {
    const { run, score } = await sample('sqlserver-adventureworks');
    expect(score.relationships).toMatchObject({ source: 90, matched: 90, missing: 0, extra: [], wrongDirection: 0 });
    expect(score.descriptions).toMatchObject({ source: 530, exact: 530, changed: 0, missing: 0 });
    expect(score.uniqueKeys).toMatchObject({ source: 58, kept: 58, lost: 0, extra: [] });
    expect(score.oneToOne).toMatchObject({ source: 6, imported: 6, drawnAsMany: [] });
    // The composite FK came in whole (SpecialOfferProduct's pair).
    expect(run.relationships.filter((r) => r.compositeKey).length).toBeGreaterThan(0);
    // Alias types keep their name; the ledger names the base.
    expect(run.notes.some((n) => /alias type Name kept by name; based on nvarchar\(50\)/.test(n))).toBe(true);
    // Computed columns are typed `computed`, said, never `AS <expr>`.
    expect(column(run, 'SalesOrderHeader', 'TotalDue')?.dataType).toBe('computed');
    expect(run.tables.flatMap((t) => t.columns ?? []).some((c) => /^AS\b|PERSISTED/i.test(c.dataType))).toBe(false);
  });

  it('Snowflake: USE SCHEMA keeps the schemas and resolves the 4 cross-schema FKs', async () => {
    const { score } = await sample('snowflake-grid-reliability');
    expect(score.relationships).toMatchObject({ source: 12, matched: 12, missing: 0, extra: [] });
    expect(score.schemas.lostSilently).toEqual([]);
    expect([...score.schemas.imported].sort()).toEqual(['ML', 'RAW', 'STAGING', 'UNSTRUCTURED']);
    expect(score.schemas.kept).toBe(18);
  });

  it('Harbor: 14 FKs exactly (DROP CONSTRAINT and DO blocks replayed), no stale unique keys, 3 time zones', async () => {
    const { run, score } = await sample('migrations-harbor');
    expect(score.relationships).toMatchObject({ source: 14, matched: 14, missing: 0, extra: [], missingSilent: [] });
    expect(score.uniqueKeys.extra).toEqual([]);
    expect(score.uniqueKeys.lost).toBe(0);
    expect(run.relationships.some((r) => r.fromModel === 'artifact_accessory' && r.fromColumn === 'subject_artifact_id')).toBe(false);
    expect(run.relationships.some((r) => r.fromModel === 'project_member' && r.fromColumn === 'role' && r.toModel === 'role')).toBe(true);
    for (const [t, c] of [['job_queue_status', 'update_time'], ['role', 'created_at'], ['role', 'modified_at']]) {
      expect(column(run, t, c)?.dataType, `${t}.${c}`).toMatch(/with time zone/i);
    }
    // The expression unique index is said, not dropped silently.
    expect(run.leftOut.some((n) => /expression unique index/.test(n) && /uq_role_name/.test(n))).toBe(true);
  });

  it('Sakila: all 36 UNSIGNED columns kept, 22 FK actions listed, the store manager one-to-one, schema sakila', async () => {
    const { run, score } = await sample('mysql-sakila');
    // 38 in the file: one is rewards_report's parameter, one its temporary table's column.
    expect(run.tables.flatMap((t) => t.columns ?? []).filter((c) => /\bunsigned\b/i.test(c.dataType))).toHaveLength(36);
    expect(score.types.detailLost.filter((d) => /unsigned/i.test(d))).toEqual([]);
    expect(score.oneToOne).toMatchObject({ source: 1, imported: 1, drawnAsMany: [] });
    expect(run.relationships.find((r) => r.fromModel === 'store' && r.fromColumn === 'manager_staff_id')).toMatchObject({ toModel: 'staff', cardinality: 'one-to-one' });
    expect(score.schemas).toMatchObject({ kept: 16, lostSilently: [] });
    expect(run.leftOut.some((n) => /Settings on 22 references/.test(n))).toBe(true);
    expect(run.leftOut.some((n) => /15 columns: ON UPDATE not kept/.test(n))).toBe(true);
  });

  for (const slug of SQL_SAMPLES) {
    it(`${slug}: conservation — nothing structural lost without a word, nothing extra`, async () => {
      const { score } = await sample(slug);
      expect(score.silentLosses).toMatchObject({ tables: 0, columns: 0, primaryKeys: 0, relationships: 0, oneToOne: 0, schemas: 0 });
      expect(score.tables.extra).toEqual([]);
      expect(score.relationships.extra).toEqual([]);
      expect(score.relationships.wrongDirection).toBe(0);
      expect(score.primaryKeys.wrong).toEqual([]);
      expect(score.falseNotLostNote).toBe(false);
      expect(['Clean', 'With gaps']).toContain(score.verdict);
    }, 60_000);
  }
});
