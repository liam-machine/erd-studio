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
import { canon, loadTruth, normaliseType, qualifySameNames, runSample, scoreSample, scorecardTable, totalsOf, typeDetails, type ImportRun, type SampleScore, type Scorecard, type TruthSample } from './realWorldScorecard';
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
  /** Filtered links (dbt `relationships_where`) whose condition the draft shows. */
  conditionsShown?: number;
}
const FLOORS: Record<string, Floor> = {
  'dbml-qut-workbench': { tablesMatched: 49, columnsMatched: 466, primaryKeysMatched: 45, relationshipsMatched: 96, uniqueKeysKept: 27, typeDetailsKept: 39, descriptionsExact: 32, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // Pagila's truth folds payment's 55 partitions into payment (expected.json notes): every unit of the folded model is matched.
  'postgres-pagila': { tablesMatched: 16, columnsMatched: 94, primaryKeysMatched: 16, relationshipsMatched: 22, uniqueKeysKept: 5, typeDetailsKept: 23, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // The same dump with 'Keep each partition as a table': the 71-table reading the scorecard held before folding became the default.
  // Each partition has payment's primary key and unique index, as PostgreSQL 18 reads it back (test/real-world-truth/).
  'postgres-pagila-partitions-kept': { tablesMatched: 71, columnsMatched: 479, primaryKeysMatched: 71, relationshipsMatched: 37, uniqueKeysKept: 60, typeDetailsKept: 133, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'mysql-sakila': { tablesMatched: 16, columnsMatched: 90, primaryKeysMatched: 16, relationshipsMatched: 22, uniqueKeysKept: 2, typeDetailsKept: 60, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'sqlserver-adventureworks': { tablesMatched: 71, columnsMatched: 486, primaryKeysMatched: 71, relationshipsMatched: 90, uniqueKeysKept: 58, typeDetailsKept: 69, descriptionsExact: 530, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'snowflake-grid-reliability': { tablesMatched: 18, columnsMatched: 237, primaryKeysMatched: 18, relationshipsMatched: 12, uniqueKeysKept: 0, typeDetailsKept: 176, descriptionsExact: 13, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'databricks-open-retail-data-model': { tablesMatched: 34, columnsMatched: 635, primaryKeysMatched: 34, relationshipsMatched: 43, uniqueKeysKept: 0, typeDetailsKept: 38, descriptionsExact: 669, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'migrations-harbor': { tablesMatched: 48, columnsMatched: 397, primaryKeysMatched: 47, relationshipsMatched: 14, uniqueKeysKept: 44, typeDetailsKept: 136, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'powerbi-tmdl-salessense': { tablesMatched: 8, columnsMatched: 84, primaryKeysMatched: 3, relationshipsMatched: 5, uniqueKeysKept: 0, typeDetailsKept: 11, descriptionsExact: 7, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  'powerbi-bim-adventureworks': { tablesMatched: 9, columnsMatched: 174, primaryKeysMatched: 7, relationshipsMatched: 13, uniqueKeysKept: 0, typeDetailsKept: 0, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  'dbt-synthea-omop': { tablesMatched: 15, columnsMatched: 247, primaryKeysMatched: 15, relationshipsMatched: 113, uniqueKeysKept: 0, typeDetailsKept: 57, descriptionsExact: 223, maxSilentLosses: 0, verdictAtLeast: 'With gaps', conditionsShown: 32 },
  // Added with the Power BI robustness track (Save to Folder, TMDL isolation, M merge sources).
  'powerbi-folder-spaceparts': { tablesMatched: 23, columnsMatched: 172, primaryKeysMatched: 1, relationshipsMatched: 22, uniqueKeysKept: 0, typeDetailsKept: 9, descriptionsExact: 7, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
  // Clean once the truth lists the unique keys Power BI implies (a relationship's one end) apart from declared ones: Item(Type Key) is one.
  'powerbi-tmdl-bc-purchase': { tablesMatched: 34, columnsMatched: 511, primaryKeysMatched: 8, relationshipsMatched: 55, uniqueKeysKept: 0, typeDetailsKept: 20, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // Added with the Oracle, BigQuery, Redshift and SQLite dialects (each read with the PostgreSQL grammar after its own pre-steps).
  // One unique key (employees.email): its 6 CREATE UNIQUE INDEX statements are on exactly the primary keys (expected.json notes), never a key of their own.
  'oracle-hr': { tablesMatched: 7, columnsMatched: 35, primaryKeysMatched: 7, relationshipsMatched: 10, uniqueKeysKept: 1, typeDetailsKept: 30, descriptionsExact: 42, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'bigquery-cloud-learning-platform': { tablesMatched: 11, columnsMatched: 129, primaryKeysMatched: 0, relationshipsMatched: 0, uniqueKeysKept: 0, typeDetailsKept: 5, descriptionsExact: 54, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'redshift-tpch': { tablesMatched: 8, columnsMatched: 61, primaryKeysMatched: 8, relationshipsMatched: 0, uniqueKeysKept: 0, typeDetailsKept: 38, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'sqlite-chinook': { tablesMatched: 11, columnsMatched: 64, primaryKeysMatched: 11, relationshipsMatched: 11, uniqueKeysKept: 0, typeDetailsKept: 37, descriptionsExact: 0, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // Added from the import corpus (scripts/corpus/), at the numbers they scored when added; truth from the engine read-backs.
  // The Data Vault's five CREATE TABLE ... AS SELECT tables are skipped and only counted ("skipped 2 CREATE TABLEs without a column
  // list"), never named: 5 silent table losses. Three of them (ref_region, ref_nation, sat_order_bv) do have a column list, with
  // their keys; 2 relationships go with them.
  'snowflake-realtime-datavault': { tablesMatched: 7, columnsMatched: 53, primaryKeysMatched: 5, relationshipsMatched: 4, uniqueKeysKept: 0, typeDetailsKept: 0, descriptionsExact: 0, maxSilentLosses: 5, verdictAtLeast: 'With problems' },
  'snowflake-sqldbm-adventureworksdw': { tablesMatched: 23, columnsMatched: 284, primaryKeysMatched: 15, relationshipsMatched: 36, uniqueKeysKept: 0, typeDetailsKept: 264, descriptionsExact: 25, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // orders and refunds are each in two schemas: compared as {schema}_{name} (qualifySameNames), the names the import gives them.
  'databricks-uc-catalog-as-code': { tablesMatched: 22, columnsMatched: 118, primaryKeysMatched: 21, relationshipsMatched: 16, uniqueKeysKept: 0, typeDetailsKept: 20, descriptionsExact: 140, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  'databricks-adidas-table-manager': { tablesMatched: 3, columnsMatched: 24, primaryKeysMatched: 0, relationshipsMatched: 0, uniqueKeysKept: 0, typeDetailsKept: 0, descriptionsExact: 16, maxSilentLosses: 0, verdictAtLeast: 'Clean' },
  // 4 of the 23 foreign keys are left out and said: each is the reverse of one kept (receipts and function_calls with transactions on
  // transaction_hash, decoded_events with logs on their two-column key), which DBML cannot hold twice ("References with same endpoints exist").
  'bigquery-shibarium': { tablesMatched: 8, columnsMatched: 87, primaryKeysMatched: 8, relationshipsMatched: 19, uniqueKeysKept: 0, typeDetailsKept: 3, descriptionsExact: 95, maxSilentLosses: 0, verdictAtLeast: 'With gaps' },
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
        if (floor.conditionsShown !== undefined) expect(score.conditions.shown, `${slug} conditions shown`).toBeGreaterThanOrEqual(floor.conditionsShown);
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

  it('compares two tables of one name in two schemas as {schema}_{name}, the names the import gives them', () => {
    const two: TruthSample = {
      importer: 'sql', input: {}, counts: { tables: 3, columns: 3, primaryKeys: 2, relationships: 1 },
      tables: [
        { name: 'orders', schema: 'core', pk: ['id'], columns: [['id', 'int', 'PN']] },
        { name: 'orders', schema: 'raw', pk: ['id'], columns: [['id', 'int', 'PN']] },
        { name: 'lines', schema: 'core', pk: [], columns: [['order_id', 'int', '']] },
      ],
      relationships: [{ from: 'lines', fromColumn: 'order_id', to: 'orders', toSchema: 'core', toColumn: 'id' }],
      uniqueKeys: [],
    };
    const q = qualifySameNames(two);
    expect(q.tables.map((t) => t.name)).toEqual(['core_orders', 'raw_orders', 'lines']);
    expect(q.relationships[0]).toMatchObject({ from: 'lines', to: 'core_orders' });
    const s = scoreSample('t', two, run({
      tables: [
        { name: 'core_orders', schema: 'core', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] },
        { name: 'raw_orders', schema: 'raw', columns: [{ name: 'id', dataType: 'int', description: '', isPrimaryKey: true }] },
        { name: 'lines', schema: 'core', columns: [{ name: 'order_id', dataType: 'int', description: '' }] },
      ],
      relationships: [{ fromModel: 'lines', fromColumn: 'order_id', toModel: 'core_orders', toColumn: 'id', cardinality: 'many-to-one' }],
    }));
    expect(s.tables).toMatchObject({ matched: 3, missing: 0, extra: [] });
    expect(s.relationships).toMatchObject({ matched: 1, extra: [] });
    // A truth with no shared name is left as it is.
    expect(qualifySameNames(sample)).toBe(sample);
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
