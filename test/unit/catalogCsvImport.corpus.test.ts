/**
 * The catalog-export route scored on SYNTHESISED exports: each engine
 * read-back of the real-world samples (`test/real-world-truth/engine/`)
 * written as three CSV shapes (`catalogCsv/readbackCsv.ts`: a raw
 * `information_schema.columns`, the same joined to its key views, and a
 * catalog query in the contract's own names), each run through the catalog
 * reader and Import DBML's flow, and scored with the real-world scorecard
 * (`realWorldScorecard.ts`, unchanged) against the same truth as the SQL DDL
 * route.
 *
 * These files were written from the engines' documentation, not exported by
 * them (see `GUESSES`): the score says how the reader handles each shape.
 * The real exports are scored in `catalogCsvImport.fixtures.test.ts`.
 *
 * "Not carried": a shape with no key, foreign key, comment or size columns
 * cannot bring those in. The scorecard counts what is missing as lost
 * silently; here it is moved out of the silent count only when the file
 * really had no such column (the reader's own `coverage`) AND the draft says
 * so in the sentence the reader writes for it. Everything else stays silent.
 *
 * `FLOORS` only ratchet up. `CATALOG_CORPUS_OUT=<file>` writes the table.
 */
import * as fs from 'fs';
import { describe, expect, it } from 'vitest';

import { catalogCsvToDbml, catalogOriginPhrase, type CatalogCsvResult } from '../../src/services/catalogCsvImport';
import { readsAsDbml } from '../../src/services/sqlImportEngine';
import { readbackToCsv, type CsvVariant } from './catalogCsv/readbackCsv';
import { ENGINE_PAIRS, foldPartitions, loadReadback } from './realWorldEngineTruth';
import { importDbmlFlow, loadTruth, scoreSample, type ImportRun, type SampleScore } from './realWorldScorecard';

type Ok = Extract<CatalogCsvResult, { ok: true }>;

interface Line { sample: string; variant: CsvVariant; score: SampleScore; notCarried: Record<string, number>; unexplained: number }

const VARIANTS: readonly CsvVariant[] = ['catalog', 'keyed', 'raw'];

/** The sentences the reader writes for a file that lacks a kind of column (`catalogCsvImport.ts`). */
const SAID = {
  keys: /This file has no key columns/,
  primaryKeys: /no key columns|no primary key column/,
  foreignKeys: /no key columns|no foreign key columns/,
  uniqueKeys: /no key columns, so its tables came in without primary keys, unique keys/,
  comments: /no comment columns, so no descriptions came in/,
  sizes: /the file gives no full type and no length, precision or scale column/,
};

/** What the file did not carry and the draft says it did not: moved out of the silent count, by kind. */
function notCarried(score: SampleScore, result: Ok, run: ImportRun): Record<string, number> {
  const said = (re: RegExp): boolean => run.shown.some((s) => re.test(s));
  const L = score.silentLosses;
  const c = result.coverage;
  const out: Record<string, number> = {};
  if (!c.primaryKeyColumn && said(SAID.primaryKeys) && L.primaryKeys) out.primaryKeys = L.primaryKeys;
  if (!c.foreignKeyColumns && said(SAID.foreignKeys)) {
    if (L.relationships) out.relationships = L.relationships;
    if (L.requiredFks) out.requiredFks = L.requiredFks;
    if (L.oneToOne) out.oneToOne = L.oneToOne;
  }
  if (!c.uniqueColumn && said(SAID.uniqueKeys) && L.uniqueKeys) out.uniqueKeys = L.uniqueKeys;
  if (!c.comments && said(SAID.comments) && L.descriptions) out.descriptions = L.descriptions;
  if (c.types === 'bare' && said(SAID.sizes) && L.typeDetail) out.typeDetail = L.typeDetail;
  return out;
}

/** Floors per shape, over every sample: matched counts never fall, unexplained silent losses never rise. */
const FLOORS: Record<CsvVariant, { tables: number; columns: number; primaryKeys: number; relationships: number; maxUnexplained: number; clean: number }> = {
  // The shape the shipped queries write. The unexplained 24 are Snowflake's (a synthesised guess at its
  // catalog's types: 22 + 2 type details); no shipped query reads Snowflake.
  catalog: { tables: 281, columns: 2551, primaryKeys: 264, relationships: 282, maxUnexplained: 24, clean: 10 },
  // information_schema's own key views: no unique indexes (SQL Server's 56), no Snowflake keys at all, and
  // PostgreSQL's partitions listed as tables (Pagila's +55 and their 18 foreign keys).
  keyed: { tables: 281, columns: 2551, primaryKeys: 223, relationships: 225, maxUnexplained: 118, clean: 6 },
  // A bare information_schema.columns: no keys of any kind, said in the banner.
  raw: { tables: 281, columns: 2551, primaryKeys: 27, relationships: 0, maxUnexplained: 113, clean: 1 },
};

describe('the catalog-export route on synthesised exports of the engine-verified samples', () => {
  const truth = loadTruth();
  const lines: Line[] = [];
  // The partitions-kept reading is the SQL route's choice; the shipped PostgreSQL query always folds partitions.
  const pairs = ENGINE_PAIRS.filter((p) => p.truth !== 'postgres-pagila-partitions-kept');

  for (const pair of pairs) {
    it(`${pair.truth}`, () => {
      const rb = loadReadback(pair.engine)!;
      for (const variant of VARIANTS) {
        // The catalog shape is what the shipped query writes: partitions folded into their parent. A raw
        // information_schema export lists every partition as a table, as the engine does.
        const source = variant === 'catalog' && pair.foldPartitions ? foldPartitions(rb) : rb;
        const csv = readbackToCsv(source, pair.dialect, variant);
        const result = catalogCsvToDbml([{ name: `${pair.engine}.csv`, text: csv.text }], readsAsDbml);
        if (!result.ok) throw new Error(`${pair.truth} ${variant}: ${result.problems.map((p) => p.message).join(' | ')}`);
        // The writer's DBML always reads back: nothing left out by the check.
        expect(result.ledger.filter((e) => e.cause === 'parseError'), `${pair.truth} ${variant}`).toEqual([]);
        const run = importDbmlFlow(result.dbml, `${pair.engine}.dbml`, 'sql', {
          from: catalogOriginPhrase([`${pair.engine}.csv`]), notes: result.notes, skipped: result.skipped, ledger: result.ledger, ...(result.notice ? { notice: result.notice } : {}),
        });
        expect(run.ok, `${pair.truth} ${variant}`).toBe(true);
        const score = scoreSample(pair.truth, truth.samples[pair.truth], run);
        const explained = notCarried(score, result, run);
        const unexplained = score.silentLosses.total - Object.values(explained).reduce((a, b) => a + b, 0);
        lines.push({ sample: pair.truth, variant, score, notCarried: explained, unexplained });
      }
    }, 120_000);
  }

  it('meets the floors, shape by shape', () => {
    const rows: string[] = ['| Sample | Shape | Verdict | Tables | Columns | PKs | Rels (extra) | Unique | Types verbatim | Type detail | Descriptions | Silent, not carried (said) | Silent, unexplained |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
    for (const variant of VARIANTS) {
      const ls = lines.filter((l) => l.variant === variant);
      const sum = (f: (s: SampleScore) => number): number => ls.reduce((n, l) => n + f(l.score), 0);
      for (const l of ls) {
        const s = l.score;
        const nc = Object.entries(l.notCarried).map(([k, v]) => `${k} ${v}`).join(', ');
        rows.push(`| ${l.sample} | ${variant} | ${s.verdict} | ${s.tables.matched}/${s.tables.source}${s.tables.extra.length ? ` (+${s.tables.extra.length})` : ''} | ${s.columns.matched}/${s.columns.source} | ${s.primaryKeys.matched}/${s.primaryKeys.source} | ${s.relationships.matched}/${s.relationships.source} (${s.relationships.extra.length}) | ${s.uniqueKeys.kept}/${s.uniqueKeys.source} | ${s.types.verbatim}/${s.types.checked} | ${s.types.detailKept}/${s.types.detailSource} | ${s.descriptions.exact}/${s.descriptions.source} | ${nc || '0'} | ${l.unexplained} |`);
      }
      const totals = {
        tables: sum((s) => s.tables.matched), columns: sum((s) => s.columns.matched), primaryKeys: sum((s) => s.primaryKeys.matched),
        relationships: sum((s) => s.relationships.matched), unexplained: ls.reduce((n, l) => n + l.unexplained, 0), clean: ls.filter((l) => l.score.verdict === 'Clean').length,
      };
      rows.push(`| **TOTAL** | ${variant} | ${totals.clean} Clean of ${ls.length} | ${totals.tables}/${sum((s) => s.tables.source)} | ${totals.columns}/${sum((s) => s.columns.source)} | ${totals.primaryKeys}/${sum((s) => s.primaryKeys.source)} | ${totals.relationships}/${sum((s) => s.relationships.source)} | ${sum((s) => s.uniqueKeys.kept)}/${sum((s) => s.uniqueKeys.source)} | ${sum((s) => s.types.verbatim)}/${sum((s) => s.types.checked)} | ${sum((s) => s.types.detailKept)}/${sum((s) => s.types.detailSource)} | ${sum((s) => s.descriptions.exact)}/${sum((s) => s.descriptions.source)} | ${ls.reduce((n, l) => n + Object.values(l.notCarried).reduce((a, b) => a + b, 0), 0)} | ${totals.unexplained} |`);
      const floor = FLOORS[variant];
      expect(totals.tables, `${variant} tables`).toBeGreaterThanOrEqual(floor.tables);
      expect(totals.columns, `${variant} columns`).toBeGreaterThanOrEqual(floor.columns);
      expect(totals.primaryKeys, `${variant} primary keys`).toBeGreaterThanOrEqual(floor.primaryKeys);
      expect(totals.relationships, `${variant} relationships`).toBeGreaterThanOrEqual(floor.relationships);
      expect(totals.unexplained, `${variant} unexplained silent losses`).toBeLessThanOrEqual(floor.maxUnexplained);
      expect(totals.clean, `${variant} clean samples`).toBeGreaterThanOrEqual(floor.clean);
    }
    if (process.env.CATALOG_CORPUS_OUT) fs.writeFileSync(process.env.CATALOG_CORPUS_OUT, `${rows.join('\n')}\n`);
    expect(lines).toHaveLength(pairs.length * VARIANTS.length);
  });
});
