/**
 * The import corpus scorer: every schema in scripts/corpus/manifest.json,
 * fetched into a local cache (scripts/corpus/fetch.mjs, never committed),
 * imported through the same pipeline as the real-world scorecard
 * (realWorldScorecard.ts: the command's own pure functions, with the
 * extension's default SQL time limit) and compared with the source truth
 * counted without ERD Studio (scripts/corpus/count_source.py).
 *
 * Skipped unless IMPORT_CORPUS_DIR names a fetched cache, so `npm test` in a
 * fresh clone is unaffected. scripts/corpus/score.mjs runs the whole loop
 * (fetch, count, this file one schema at a time, the table):
 *
 *   node scripts/corpus/score.mjs
 *   IMPORT_CORPUS_DIR=.cache/import-corpus IMPORT_CORPUS_ONLY=pg-discourse npx vitest run test/unit/importCorpus.score.test.ts
 *
 * Each schema's result goes to <cache>/results/<name>.json. Nothing here
 * asserts a score: the corpus is a measurement. It fails only when an import
 * breaks the rule every importer meets: it throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { canon, runSample, scoreSample, type ImportRun, type TruthSample } from './realWorldScorecard';
import { SQL_DIALECTS, type SqlDialect } from '../../src/services/sqlDdlImport';
import { DEFAULT_SQL_TIME_LIMIT_MS } from '../../src/commands/importSqlDdl';
import { roundTripDbml, type CanonicalImport } from './generated/dbmlRoundTrip';

interface CorpusFile { path: string; url: string; bytes: number; sha256: string }
interface CorpusSchema {
  name: string; kind: string; dialect: string; importer: 'sql' | 'dbt' | 'semanticModel' | 'none';
  pick?: 'files' | 'folder'; importAs?: SqlDialect; repo: string; commit: string; licence: string; about: string;
  files: CorpusFile[];
}

const MANIFEST = path.resolve(__dirname, '../../scripts/corpus/manifest.json');
const dir = process.env.IMPORT_CORPUS_DIR ? path.resolve(process.env.IMPORT_CORPUS_DIR) : '';
const enabled = !!dir && fs.existsSync(path.join(dir, 'files'));
const only = (process.env.IMPORT_CORPUS_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const schemas: CorpusSchema[] = enabled
  ? (JSON.parse(fs.readFileSync(MANIFEST, 'utf-8')) as { schemas: CorpusSchema[] }).schemas.filter((s) => only.length === 0 || only.includes(s.name))
  : [];

/** A message longer than this echoes source text, which no import message may do. */
export const LONG_MESSAGE = 300;

/** The sample the scorecard pipeline reads: its input under <cache>/files, its truth from <cache>/truth. */
function sampleOf(s: CorpusSchema, truth: Partial<TruthSample> | undefined): TruthSample {
  const empty = { counts: { tables: 0, columns: 0, primaryKeys: 0, relationships: 0 }, tables: [], relationships: [], uniqueKeys: [] };
  const base = { ...empty, ...(truth ?? {}) };
  if (s.importer === 'sql') {
    const dialect = (SQL_DIALECTS as readonly string[]).includes(s.dialect) ? (s.dialect as SqlDialect) : (s.importAs ?? 'postgres');
    const input = s.pick === 'folder'
      ? { folder: s.name }
      : { files: s.files.map((f) => `${s.name}/${f.path}`) };
    return { ...base, importer: 'sql', input: { ...input, dialect, timeLimitMs: DEFAULT_SQL_TIME_LIMIT_MS } };
  }
  if (s.importer === 'dbt') return { ...base, importer: 'dbt', input: { project: s.name } };
  return { ...base, importer: 'semanticModel', input: { folder: s.name } };
}

/**
 * The DBML round trip on the import's converted DBML (Import DBML → Export
 * Diagram → Import DBML, `generated/dbmlRoundTrip.ts`): what came back
 * different, with the same allowances as the generated tests. Skipped with
 * IMPORT_CORPUS_ROUND_TRIP=0.
 */
function roundTripOf(dbml: string | undefined): Record<string, unknown> | null {
  if (!dbml || process.env.IMPORT_CORPUS_ROUND_TRIP === '0') return null;
  const started = performance.now();
  try {
    const trip = roundTripDbml(dbml);
    const diff = (a: CanonicalImport, b: CanonicalImport): string[] => {
      const out: string[] = [];
      const tablesB = new Map(b.tables.map((t) => [`${t.schema}.${t.name}`, t]));
      for (const t of a.tables) {
        const other = tablesB.get(`${t.schema}.${t.name}`);
        if (!other) { out.push(`table ${t.schema ? `${t.schema}.` : ''}${t.name} missing`); continue; }
        if (JSON.stringify(t) !== JSON.stringify(other)) out.push(`table ${t.name} changed: ${JSON.stringify(t).slice(0, 200)} → ${JSON.stringify(other).slice(0, 200)}`);
      }
      if (b.tables.length !== a.tables.length) out.push(`tables ${a.tables.length} → ${b.tables.length}`);
      const relsB = new Set(b.relationships);
      for (const r of a.relationships) if (!relsB.has(r)) out.push(`relationship ${r} missing`);
      for (const r of b.relationships) if (!a.relationships.includes(r)) out.push(`relationship ${r} added`);
      return out;
    };
    const differences = diff(trip.first, trip.second);
    return {
      ok: differences.length === 0,
      tables: trip.first.tables.length,
      relationships: trip.first.relationships.length,
      differences: differences.length,
      sample: differences.slice(0, 10),
      ms: Math.round(performance.now() - started),
    };
  } catch (err) {
    return { ok: false, threw: (err instanceof Error ? err.message : String(err)).slice(0, 300), ms: Math.round(performance.now() - started) };
  }
}

function ledgerSummary(run: ImportRun, importer: string) {
  const byKey: Record<string, number> = {};
  let unlocated = 0;
  for (const e of run.ledger ?? []) {
    const key = `${e.outcome}/${e.unit}/${e.cause}/${e.what}`;
    byKey[key] = (byKey[key] ?? 0) + e.count;
    // SQL repairs, losses and problems point at a file and line; the other imports name the table.
    if (importer === 'sql' && e.outcome !== 'changed' && e.outcome !== 'skipped' && (!e.where?.file || e.where.line === undefined)) unlocated += e.count;
  }
  return { entries: (run.ledger ?? []).length, byKey, unlocated, timeLimit: (run.ledger ?? []).some((e) => e.cause === 'timeLimit') };
}

describe.skipIf(!enabled)('import corpus', () => {
  for (const s of schemas) {
    it(`scores ${s.name}`, async () => {
      const outDir = path.join(dir, 'results');
      fs.mkdirSync(outDir, { recursive: true });
      const truthFile = path.join(dir, 'truth', `${s.name}.json`);
      const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf-8')) as Partial<TruthSample> & { method?: string; approximateCount?: number; partitionsFolded?: number } : undefined;
      const record: Record<string, unknown> = {
        name: s.name, kind: s.kind, dialect: s.dialect, importer: s.importer,
        truth: truth ? { counts: truth.counts, method: truth.method, approximate: truth.approximateCount ?? 0, partitionsFolded: truth.partitionsFolded ?? 0 } : null,
      };
      if (s.importer === 'none') {
        fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify({ ...record, status: 'no importer' }, null, 1));
        return;
      }
      const sample = sampleOf(s, truth);
      const started = performance.now();
      let run: ImportRun;
      try {
        run = await runSample(sample, path.join(dir, 'files'));
      } catch (err) {
        const message = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 400) : String(err).slice(0, 400);
        fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify({ ...record, status: 'threw', ms: Math.round(performance.now() - started), error: message }, null, 1));
        throw err;
      }
      const ms = Math.round(performance.now() - started);
      // dbt draws one folder of the project (the default scope); the rest are other scopes, not losses.
      // The truth is cut to that folder's models, as the real-world scorecard's dbt sample is.
      let scored = sample;
      if (s.importer === 'dbt' && run.scope) {
        const inScope = new Set(run.scope.models.map((m) => m.toLowerCase()));
        const tables = sample.tables.filter((t) => inScope.has(t.name.toLowerCase()));
        const relationships = sample.relationships.filter((r) => inScope.has(r.from.toLowerCase()));
        scored = { ...sample, tables, relationships };
        record.dbtScope = { id: run.scope.id, models: run.scope.models.length, projectModelsWithColumns: sample.tables.length };
      }
      const score = scoreSample(s.name, scored, run);
      const messages = [...run.shown, ...run.problems.map((p) => p.message), ...run.notes, ...run.leftOut, ...run.warnings];
      const long = messages.filter((m) => m.length > LONG_MESSAGE);
      // Source text echoed: a message holding a 40-character run of a source line that is more than a name.
      const source = s.importer === 'sql' ? s.files.map((f) => fs.readFileSync(path.join(dir, 'files', s.name, f.path), 'utf-8')).join('\n') : '';
      const echoes = (m: string): boolean => {
        for (let i = 0; i + 40 <= m.length; i += 8) {
          const w = m.slice(i, i + 40);
          if ((w.match(/ /g) ?? []).length >= 2 && /[(=']/.test(w) && source.includes(w)) return true;
        }
        return false;
      };
      const echoed = source ? [...new Set(messages)].filter(echoes) : [];
      const truthTables = scored.tables;
      const gotTables = new Map(run.tables.map((t) => [canon(t.name), t]));
      const missingTables = truthTables.filter((t) => !gotTables.has(canon(t.name))).map((t) => t.name);
      const missingColumns = truthTables.flatMap((t) => {
        const got = gotTables.get(canon(t.name));
        if (!got) return [];
        const have = new Set((got.columns ?? []).map((c) => canon(c.name)));
        return t.columns.filter((c) => !have.has(canon(c[0]))).map((c) => `${t.name}.${c[0]}`);
      });
      const result = {
        ...record,
        status: truth ? 'scored' : 'no truth',
        ms,
        importedAs: run.dialect ?? null,
        detectedDialect: run.detectedDialect ?? null,
        ok: run.ok,
        tablesImported: run.tables.length,
        columnsImported: run.tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0),
        relationshipsImported: run.relationships.length,
        ledger: ledgerSummary(run, s.importer),
        roundTrip: run.ok ? roundTripOf(run.convertedDbml) : null,
        longMessages: { count: long.length, longest: long.reduce((n, m) => Math.max(n, m.length), 0), sample: long.slice(0, 2).map((m) => `${m.slice(0, 120)}…`) },
        echoedSource: { count: echoed.length, sample: echoed.slice(0, 2).map((m) => `${m.slice(0, 160)}…`) },
        missingTables: missingTables.slice(0, 30),
        missingColumns: missingColumns.slice(0, 30),
        problemMessages: run.problems.slice(0, 40).map((p) => `${p.file ?? ''}${p.line !== undefined ? `:${p.line}` : ''} ${p.message}`.trim().slice(0, 300)),
        score: { ...score, problems: { ...score.problems, messages: score.problems.messages.slice(0, 40).map((m) => m.slice(0, 300)) } },
      };
      fs.writeFileSync(path.join(outDir, `${s.name}.json`), JSON.stringify(result, null, 1));
      // The one rule the corpus enforces here: an import reports, it never throws (above). The rest is measured.
      expect(run).toBeTruthy();
    }, 900_000);
  }
});
