/**
 * The real-world import scorecard (test/fixtures/real-world-imports/).
 *
 * Each sample goes through the pure pipeline its import command runs (see
 * realWorldScorecard.ts) and is compared with expected.json, the source truth
 * counted without ERD Studio.
 *
 *   SCORECARD_OUT=/tmp/claude-501/fix/baseline.json npx vitest run test/unit/realWorldImports.scorecard.test.ts
 *   SCORECARD_ONLY=mysql-sakila,postgres-pagila … (limits the samples)
 *
 * Without SCORECARD_OUT it only checks that the pipeline runs and the truth
 * still matches each sample's own SOURCE.md counts. Floors (FLOORS below) only
 * ever ratchet up: raise one when a fix lands, never lower one.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { canon, loadTruth, normaliseType, runSample, scoreSample, scorecardTable, totalsOf, typeDetails, type ImportRun, type SampleScore, type Scorecard, type TruthSample } from './realWorldScorecard';
import { SEMANTIC_MODEL_META } from '../../src/services/semanticModelImport';

const truth = loadTruth();
const only = (process.env.SCORECARD_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const slugs = Object.keys(truth.samples).filter((s) => only.length === 0 || only.includes(s));

/**
 * The least each sample must keep scoring: the results after the import-robustness
 * pass (fix/import-robustness), ratcheted from the baseline. Raise a number when a
 * fix lands; never lower one. `maxSilentLosses` is the most silent losses allowed
 * (0 wherever it was reached: a regression there fails the suite).
 * `verdictAtLeast`: Failed < With problems < With gaps < Clean.
 */
interface Floor {
  tablesMatched: number;
  columnsMatched: number;
  primaryKeysMatched: number;
  relationshipsMatched: number;
  uniqueKeysKept: number;
  typeDetailsKept: number;
  descriptionsExact: number;
  maxSilentLosses: number;
  verdictAtLeast: SampleScore['verdict'];
}
const FLOORS: Record<string, Floor> = {
  'dbml-qut-workbench': { tablesMatched: 49, columnsMatched: 466, primaryKeysMatched: 45, relationshipsMatched: 96, uniqueKeysKept: 27, typeDetailsKept: 39, descriptionsExact: 32, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // Pagila's truth folds payment's 55 partitions into payment (expected.json notes): every unit of the folded model is matched.
  'postgres-pagila': { tablesMatched: 16, columnsMatched: 94, primaryKeysMatched: 16, relationshipsMatched: 22, uniqueKeysKept: 5, typeDetailsKept: 23, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'mysql-sakila': { tablesMatched: 16, columnsMatched: 90, primaryKeysMatched: 16, relationshipsMatched: 22, uniqueKeysKept: 2, typeDetailsKept: 60, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'sqlserver-adventureworks': { tablesMatched: 71, columnsMatched: 486, primaryKeysMatched: 71, relationshipsMatched: 90, uniqueKeysKept: 58, typeDetailsKept: 69, descriptionsExact: 530, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'snowflake-grid-reliability': { tablesMatched: 18, columnsMatched: 237, primaryKeysMatched: 18, relationshipsMatched: 12, uniqueKeysKept: 0, typeDetailsKept: 176, descriptionsExact: 13, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'databricks-open-retail-data-model': { tablesMatched: 34, columnsMatched: 635, primaryKeysMatched: 34, relationshipsMatched: 43, uniqueKeysKept: 0, typeDetailsKept: 38, descriptionsExact: 669, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'migrations-harbor': { tablesMatched: 48, columnsMatched: 397, primaryKeysMatched: 47, relationshipsMatched: 14, uniqueKeysKept: 44, typeDetailsKept: 136, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'powerbi-tmdl-salessense': { tablesMatched: 8, columnsMatched: 84, primaryKeysMatched: 3, relationshipsMatched: 5, uniqueKeysKept: 0, typeDetailsKept: 11, descriptionsExact: 7, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  'powerbi-bim-adventureworks': { tablesMatched: 9, columnsMatched: 174, primaryKeysMatched: 7, relationshipsMatched: 13, uniqueKeysKept: 0, typeDetailsKept: 0, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  // Added with the Power BI robustness track (Save to Folder, TMDL isolation, M merge sources).
  'powerbi-folder-spaceparts': { tablesMatched: 23, columnsMatched: 172, primaryKeysMatched: 1, relationshipsMatched: 22, uniqueKeysKept: 0, typeDetailsKept: 9, descriptionsExact: 7, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  'powerbi-tmdl-bc-purchase': { tablesMatched: 34, columnsMatched: 511, primaryKeysMatched: 8, relationshipsMatched: 55, uniqueKeysKept: 0, typeDetailsKept: 20, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  'dbt-synthea-omop': { tablesMatched: 15, columnsMatched: 247, primaryKeysMatched: 15, relationshipsMatched: 113, uniqueKeysKept: 0, typeDetailsKept: 57, descriptionsExact: 223, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
};
const RANK: Record<SampleScore['verdict'], number> = { Failed: 0, 'With problems': 1, 'With gaps': 2, Clean: 3 };

describe('real-world import scorecard', () => {
  const scores: SampleScore[] = [];

  it('has source truth that matches each sample\'s SOURCE.md counts', () => {
    for (const slug of slugs) {
      const s = truth.samples[slug];
      const links = new Set(s.relationships.map((r) => (r.composite ? `${r.from}:${r.composite}` : `${r.from}.${r.fromColumn}>${r.to}.${r.toColumn}`)));
      expect({
        tables: s.tables.length,
        columns: s.tables.reduce((n, t) => n + t.columns.length, 0),
        primaryKeys: s.tables.filter((t) => t.pk.length > 0).length,
        relationships: links.size,
      }, slug).toEqual(s.counts);
    }
  });

  for (const slug of slugs) {
    it(`imports ${slug} through the command's own pipeline`, async () => {
      const run = await runSample(truth.samples[slug]);
      const score = scoreSample(slug, truth.samples[slug], run);
      scores.push(score);
      const floor = FLOORS[slug];
      if (floor) {
        expect(score.tables.matched, `${slug} tables`).toBeGreaterThanOrEqual(floor.tablesMatched);
        expect(score.columns.matched, `${slug} columns`).toBeGreaterThanOrEqual(floor.columnsMatched);
        expect(score.primaryKeys.matched, `${slug} primary keys`).toBeGreaterThanOrEqual(floor.primaryKeysMatched);
        expect(score.relationships.matched, `${slug} relationships`).toBeGreaterThanOrEqual(floor.relationshipsMatched);
        expect(score.uniqueKeys.kept, `${slug} unique keys`).toBeGreaterThanOrEqual(floor.uniqueKeysKept);
        expect(score.types.detailKept, `${slug} type details`).toBeGreaterThanOrEqual(floor.typeDetailsKept);
        expect(score.descriptions.exact, `${slug} descriptions`).toBeGreaterThanOrEqual(floor.descriptionsExact);
        expect(score.silentLosses.total, `${slug} silent losses ${JSON.stringify(score.silentLosses)}`).toBeLessThanOrEqual(floor.maxSilentLosses);
        expect(RANK[score.verdict], `${slug} verdict ${score.verdict}: ${score.reasons.join('; ')}`).toBeGreaterThanOrEqual(RANK[floor.verdictAtLeast]);
      }
    }, 120_000);
  }

  it('writes the scorecard when SCORECARD_OUT is set', () => {
    const out = process.env.SCORECARD_OUT;
    if (!out) return;
    const ordered = slugs.map((s) => scores.find((x) => x.slug === s)).filter((s): s is SampleScore => !!s);
    const card: Scorecard = { samples: ordered, totals: totalsOf(ordered) };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(card, null, 2) + '\n');
    console.log(scorecardTable(ordered));
  });
});

describe('scorecard rules', () => {
  it('compares names and types as documented', () => {
    expect(canon('Internet Sales')).toBe(canon('internet_sales'));
    expect(canon('DateKey')).toBe(canon('date_key'));
    expect(normaliseType('[nvarchar] (60)')).toBe('nvarchar(60)');
    expect(typeDetails('SMALLINT UNSIGNED')).toEqual(['unsigned']);
    expect(typeDetails('TIMESTAMP WITH TIME ZONE')).toEqual(['time zone']);
    expect(typeDetails('timestamptz')).toEqual(['time zone']);
    expect(typeDetails('DECIMAL(5,2)')).toEqual(['(5,2)']);
    expect(typeDetails('int')).toEqual([]);
  });

  const sample: TruthSample = {
    importer: 'sql',
    input: { files: [] },
    counts: { tables: 3, columns: 6, primaryKeys: 3, relationships: 2 },
    tables: [
      { name: 'store', pk: ['id'], columns: [['id', 'int', 'PN'], ['manager_id', 'int UNSIGNED', 'NU']] },
      { name: 'staff', pk: ['id'], columns: [['id', 'int', 'PN'], ['store_id', 'int', 'N']] },
      { name: 'gone', pk: ['id'], columns: [['id', 'int', 'PN'], ['x', 'text', '']] },
    ],
    relationships: [
      { from: 'store', fromColumn: 'manager_id', to: 'staff', toColumn: 'id' },
      { from: 'staff', fromColumn: 'store_id', to: 'store', toColumn: 'id' },
    ],
    uniqueKeys: [{ table: 'store', columns: ['manager_id'] }],
  };
  const run = (over: Partial<ImportRun> = {}): ImportRun => ({
    ok: true,
    tables: [
      { name: 'store', columns: [
        { name: 'id', dataType: 'int', description: '', isPrimaryKey: true },
        { name: 'manager_id', dataType: 'int', description: '', meta: { dbml: { not_null: true, unique: true } } },
      ] },
      { name: 'staff', columns: [
        { name: 'id', dataType: 'int', description: '', isPrimaryKey: true },
        { name: 'store_id', dataType: 'int', description: '', meta: { dbml: { not_null: true } } },
      ] },
    ],
    relationships: [
      { fromModel: 'store', fromColumn: 'manager_id', toModel: 'staff', toColumn: 'id', cardinality: 'many-to-one' },
      { fromModel: 'staff', fromColumn: 'store_id', toModel: 'store', toColumn: 'id', cardinality: 'many-to-one' },
    ],
    problems: [], warnings: [], notes: [], leftOut: [], shown: [], leftOutTables: [],
    ...over,
  });

  it('counts silent losses and gives With problems for a table lost without a word', () => {
    const s = scoreSample('t', sample, run());
    expect(s.tables).toMatchObject({ matched: 2, missing: 1, missingReported: 0 });
    expect(s.silentLosses).toMatchObject({ tables: 1, oneToOne: 1, typeDetail: 1 });
    expect(s.oneToOne.drawnAsMany).toEqual(['store.manager_id → staff']);
    expect(s.requiredFks).toMatchObject({ source: 2, keptNotNull: 2, toldOptional: false });
    expect(s.verdict).toBe('With problems');
  });

  it('a table the draft names as left out is reported, not silent', () => {
    const s = scoreSample('t', sample, run({
      relationships: [
        { fromModel: 'store', fromColumn: 'manager_id', toModel: 'staff', toColumn: 'id', cardinality: 'one-to-one' },
        { fromModel: 'staff', fromColumn: 'store_id', toModel: 'store', toColumn: 'id', cardinality: 'many-to-one' },
      ],
      shown: ['gone: left out', 'store.manager_id: type int UNSIGNED kept as int'],
      notes: ['Every relationship is saved as optional (?), as ERD Studio saves them all. In the file, 2 references were not optional.'],
    }));
    expect(s.tables.missingReported).toBe(1);
    expect(s.silentLosses.total).toBe(0);
    expect(s.requiredFks.noteClaims).toBe(2);
    expect(s.verdict).toBe('With gaps');
  });

  it('a semantic model is compared by the Power BI names the import keeps in meta, not the snake_case ones', () => {
    const pbi: TruthSample = {
      importer: 'semanticModel', input: {}, counts: { tables: 2, columns: 3, primaryKeys: 1, relationships: 1 },
      tables: [
        { name: '1) Selected Metric', pk: [], columns: [['YOY%', 'double', '']] },
        { name: 'Store', pk: ['Id'], columns: [['Id', 'int64', 'P'], ['Metric #', 'int64', '']] },
      ],
      relationships: [{ from: 'Store', fromColumn: 'Metric #', to: '1) Selected Metric', toColumn: 'YOY%' }],
      uniqueKeys: [],
    };
    const meta = (name: string) => ({ [SEMANTIC_MODEL_META.name]: name });
    const s = scoreSample('pbi', pbi, run({
      tables: [
        { name: 't_1_selected_metric', meta: meta('1) Selected Metric'), columns: [{ name: 'yoy_pct', dataType: 'double', description: '', meta: meta('YOY%') }] },
        { name: 'store', meta: meta('Store'), columns: [{ name: 'id', dataType: 'bigint', description: '', isPrimaryKey: true, meta: meta('Id') }, { name: 'metric_num', dataType: 'bigint', description: '', meta: meta('Metric #') }] },
      ] as never,
      relationships: [{ fromModel: 'store', fromColumn: 'metric_num', toModel: 't_1_selected_metric', toColumn: 'yoy_pct', cardinality: 'many-to-one' }] as never,
    }));
    expect(s.tables).toMatchObject({ matched: 2, extra: [] });
    expect(s.columns).toMatchObject({ matched: 3, extra: 0 });
    expect(s.relationships).toMatchObject({ matched: 1, extra: [] });
  });

  it('a failed import is Failed, with every loss reported', () => {
    const s = scoreSample('t', sample, run({ ok: false, tables: [], relationships: [], problems: [{ file: 'a.sql', line: 3, message: 'CREATE TABLE store could not be read: the SQL parser could not read this statement' }] }));
    expect(s.verdict).toBe('Failed');
    expect(s.silentLosses.total).toBe(0);
    expect(s.problems).toMatchObject({ count: 1, withCause: 0, withLocation: 1 });
  });
});
