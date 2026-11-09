/**
 * Generated tests for Import DBML, and the DBML round trip.
 *
 * Valid DBML (any names, inline or block Refs, composite keys, notes, a
 * schema, comments, CRLF, BOM): imports whole — every table, column, key and
 * relationship.
 *
 * Broken DBML (`breaks.ts`): never throws. The DBML parser builds no model
 * when it finds an error, so a file either reads whole or fails whole; a
 * failure must name at least one problem, each with a line inside the file,
 * and no message may echo more than a short snippet of it. A file that reads
 * imports every table it holds (or reports it in the plan's ledger).
 *
 * Round trip: import → export (core's `toDbmlRich`) → import gives the same
 * tables, columns, keys and relationships (`dbmlRoundTrip.ts`), for
 * generated DBML, every committed DBML sample, and DBML other tools wrote
 * (test/fixtures/dbml-other-tools/).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readDbml } from '../../../src/services/dbmlImportParse';
import { importDbmlFlow, loadTruth, SAMPLES_ROOT } from '../realWorldScorecard';
import { gatherSqlFiles } from '../../../src/commands/importSqlDdl';
import { walkSemanticModelFiles } from '../../../src/commands/importSemanticModel';
import { detectSqlDialect, SQL_DIALECTS } from '../../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../../src/services/sqlImportEngine';
import { findSemanticModels, readSemanticModel, semanticModelToDbml } from '../../../src/services/semanticModelImport';
import { writeSql, sqlStyleArb } from './sqlWriter';
import { applyBreak, breakArb, headersIn } from './breaks';
import { dbmlKit, dbmlStyleArb, writeDbml } from './dbmlWriter';
import { roundTripDbml } from './dbmlRoundTrip';
import { echoViolations, ledgerCount, lineCount, timeRatio } from './invariants';
import { allPlain, BIG_RUN, copies, params, runs, schemaArb, schemaTruth, timeout, type GSchema } from './schemaArbitraries';

const namesOf = (schema: GSchema): string[] => schema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);

const cut = (text: string): string => (text.length > 3000 ? `${text.slice(0, 3000)}…` : text);

describe('Import DBML (generated): valid DBML imports whole', () => {
  it('every table, column, key and relationship', () => {
    fc.assert(fc.property(schemaArb(), dbmlStyleArb(), (schema, style) => {
      const { text } = writeDbml(schema, style);
      const run = importDbmlFlow(text.replace(/^﻿/, ''), 'gen.dbml', 'file');
      const truth = schemaTruth(schema);
      expect(run.ok, `${cut(text)}\n${JSON.stringify(run.problems)}`).toBe(true);
      expect(run.tables.length, cut(text)).toBe(truth.tables);
      expect(run.tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0), cut(text)).toBe(truth.columns);
      expect(run.tables.filter((t) => t.columns?.some((c) => c.isPrimaryKey)).length, cut(text)).toBe(truth.primaryKeys);
      const pairs = schema.tables.reduce((n, t) => n + t.fks.reduce((m, fk) => m + fk.columns.length, 0), 0);
      expect(run.relationships.length, cut(text)).toBe(pairs);
      if (allPlain(schema)) {
        expect(run.tables.map((t) => t.name).sort(), cut(text)).toEqual(schema.tables.map((t) => t.name).sort());
        // Each link from its foreign-key end; `-` is one-to-one.
        const want = schema.tables.flatMap((t) => t.fks.flatMap((fk) => fk.columns.map((c, k) => `${t.name}.${c}>${fk.table}.${fk.references[k]} ${fk.oneToOne ? '1:1' : 'n:1'}`))).sort();
        const got = run.relationships.map((l) => (l.cardinality === 'one-to-many'
          ? `${l.toModel}.${l.toColumn}>${l.fromModel}.${l.fromColumn} n:1`
          : `${l.fromModel}.${l.fromColumn}>${l.toModel}.${l.toColumn} ${l.cardinality === 'one-to-one' ? '1:1' : 'n:1'}`)).sort();
        expect(got, cut(text)).toEqual(want);
      }
      expect(echoViolations(run.shown, [text], namesOf(schema)), cut(text)).toEqual([]);
    }), params(runs(60, 0.5)));
  }, timeout(30_000));
});

describe('Import DBML (generated): broken DBML reads whole or fails with located problems', () => {
  it('never throws; a failure names its problems by line; what reads imports every table; no long echo', () => {
    fc.assert(fc.property(schemaArb({ maxTables: 4, maxColumns: 4 }), dbmlStyleArb(), breakArb(), (schema, style, brk) => {
      const written = writeDbml(schema, style);
      const broken = applyBreak(written.text, written.spans, brk, dbmlKit(), style.eol);
      const text = broken.text.replace(/^﻿/, '');
      const where = `${brk.kind} in table ${broken.target}\n${cut(text)}`;
      let run: ReturnType<typeof importDbmlFlow>;
      try {
        run = importDbmlFlow(text, 'gen.dbml', 'file');
      } catch (err) {
        throw new Error(`threw ${String(err)}\n${where}`);
      }
      const v: string[] = [];
      if (!run.ok) {
        if (run.problems.length === 0) v.push('failed with no problem');
        for (const p of run.problems) {
          if (p.line === undefined || p.line < 1 || p.line > lineCount(text)) v.push(`problem line ${p.line} outside the file (${lineCount(text)} lines): ${p.message.slice(0, 120)}`);
        }
        v.push(...echoViolations([...run.shown, ...run.problems.map((p) => p.message)], [text], namesOf(schema)));
      } else {
        // Read whole: every table defined in the text is imported, or reported in the plan's ledger.
        const reported = ledgerCount(run.ledger ?? [], (e) => e.unit === 'table' && e.outcome !== 'changed' && e.outcome !== 'repaired');
        const defined = headersIn(text, written.spans);
        const intact = broken.intact.filter(Boolean).length;
        if (run.tables.length + reported < Math.min(defined, intact)) v.push(`${run.tables.length} imported + ${reported} reported < ${intact} untouched tables`);
        v.push(...echoViolations(run.shown, [text], namesOf(schema)));
      }
      expect(v, `${where}\nproblems: ${JSON.stringify(run.problems.slice(0, 3))}`).toEqual([]);
    }), params(runs(100)));
  }, timeout(30_000));
});

describe('Import DBML (generated): time grows in line with size', () => {
  const K = 8;
  const fixed = schemaArb({ minTables: 4, maxTables: 4, maxColumns: 6, kinds: { reserved: 0, unicode: 0, spaced: 0, mixedCase: 0, huge: 0 } });
  const [schema] = fc.sample(fixed, { seed: 3, numRuns: 1 });
  const style = { eol: '\n', bom: false, inlineRefs: false, quoteAll: false, notes: true, noise: true, project: true, seed: 1 } as const;

  it('n and 8·n tables, imported and round-tripped', () => {
    const n = BIG_RUN ? 20 : 5;
    const small = writeDbml(copies(schema, n), style).text;
    const big = writeDbml(copies(schema, n * K), style).text;
    const t = timeRatio(() => importDbmlFlow(small, 'a.dbml', 'file'), () => importDbmlFlow(big, 'a.dbml', 'file'), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
    const r = timeRatio(() => roundTripDbml(small), () => roundTripDbml(big), K, { tries: 2 });
    expect(r.ratio, JSON.stringify(r)).toBeLessThan(4);
  }, timeout(30_000));

  it('one table of n and 8·n columns', () => {
    const wide = (cols: number): string => `Table wide {\n  id int [pk]\n${Array.from({ length: cols }, (_v, i) => `  c_${i} int [note: 'n']`).join('\n')}\n}\n`;
    const c = BIG_RUN ? 1000 : 200;
    const t = timeRatio(() => readDbml(wide(c)), () => readDbml(wide(c * K)), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
  }, timeout(30_000));
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('DBML round trip (generated): import → export → import gives the same diagram', () => {
  it('generated DBML', () => {
    fc.assert(fc.property(schemaArb(), dbmlStyleArb(), (schema, style) => {
      const { text } = writeDbml(schema, style);
      const trip = roundTripDbml(text.replace(/^﻿/, ''));
      expect(trip.second, `${cut(text)}\n--- exported\n${cut(trip.exported)}`).toEqual(trip.first);
    }), params(runs(60, 0.5)));
  }, timeout(30_000));
});

const ROOT = path.resolve(__dirname, '../../fixtures');
/** Every committed DBML file: the real-world sample, the DBML fixtures (ours, a dbdiagram pull, foreign), other tools' published examples. */
const SAMPLES = [
  'real-world-imports/dbml-qut-workbench/schema.dbml',
  ...(fs.readdirSync(path.join(ROOT, 'dbml'), { recursive: true }) as string[]).filter((f) => f.endsWith('.dbml')).map((f) => `dbml/${f}`),
  ...(fs.readdirSync(path.join(ROOT, 'dbml-other-tools'), { recursive: true }) as string[]).filter((f) => f.endsWith('.dbml')).map((f) => `dbml-other-tools/${f}`),
].map((f) => f.split(path.sep).join('/')).sort();

describe('DBML round trip: committed samples and other tools\' DBML', () => {
  it('has the samples', () => {
    expect(SAMPLES.filter((s) => s.startsWith('dbml-other-tools/')).length).toBeGreaterThanOrEqual(7);
  });

  it.each(SAMPLES)('%s', (file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf-8').replace(/^﻿/, '');
    const trip = roundTripDbml(text, path.basename(file));
    expect(trip.first.tables.length).toBeGreaterThan(0);
    expect(trip.second).toEqual(trip.first);
  });
});

describe('DBML round trip: the DBML the other importers convert to', () => {
  it('generated SQL, converted in every dialect', () => {
    fc.assert(fc.property(schemaArb({ maxTables: 4 }), fc.constantFrom(...SQL_DIALECTS), sqlStyleArb(), (schema, dialect, style) => {
      const converted = sqlDdlToDbml({ files: writeSql(schema, dialect, style).files, dialect });
      if (!converted.ok) throw new Error(JSON.stringify(converted.problems));
      const trip = roundTripDbml(converted.dbml);
      expect(trip.second, `${dialect}\n${cut(converted.dbml)}\n--- exported\n${cut(trip.exported)}`).toEqual(trip.first);
    }), params(runs(30, 0.25)));
  }, timeout(30_000));

  const truth = loadTruth();
  const fsDir = async (folder: string): Promise<Array<readonly [string, boolean]>> => fs.readdirSync(folder, { withFileTypes: true }).map((e) => [e.name, e.isDirectory()] as const);
  const sqlSamples = Object.entries(truth.samples).filter(([, t]) => t.importer === 'sql' && !t.input.partitions);
  const modelSamples = Object.entries(truth.samples).filter(([, t]) => t.importer === 'semanticModel');

  it.each(sqlSamples.map(([slug]) => slug))('real-world SQL sample %s, converted', async (slug) => {
    const input = truth.samples[slug].input;
    const sources = input.folder ? { folder: path.join(SAMPLES_ROOT, input.folder) } : { files: (input.files ?? []).map((f) => path.join(SAMPLES_ROOT, f)) };
    const gathered = await gatherSqlFiles(sources, { readDirectory: fsDir, readFile: async (f) => fs.readFileSync(f, 'utf-8'), fileSize: async (f) => fs.statSync(f).size });
    if ('message' in gathered) throw new Error(gathered.message);
    const dialect = detectSqlDialect(gathered.files.map((f) => f.text).join('\n')) ?? input.dialect ?? 'postgres';
    const converted = sqlDdlToDbml({ files: gathered.files, dialect });
    if (!converted.ok) throw new Error(JSON.stringify(converted.problems.slice(0, 3)));
    const trip = roundTripDbml(converted.dbml);
    expect(trip.second).toEqual(trip.first);
  }, timeout(30_000));

  it.each(modelSamples.map(([slug]) => slug))('real-world Power BI sample %s, converted', async (slug) => {
    const folder = path.join(SAMPLES_ROOT, truth.samples[slug].input.folder!);
    const walk = await walkSemanticModelFiles(folder, fsDir);
    const rel = (full: string): string => path.join(path.basename(folder), path.relative(folder, full)).split(path.sep).join('/');
    const fullOf = new Map(walk.files.map((full) => [rel(full), full]));
    const entry = findSemanticModels([...fullOf.keys()])[0];
    const read = readSemanticModel(entry.files.map((f) => ({ path: f, text: fs.readFileSync(fullOf.get(f)!, 'utf-8') })));
    if (!read.ok) throw new Error(JSON.stringify(read.problems));
    const trip = roundTripDbml(semanticModelToDbml(read.model).dbml);
    expect(trip.second).toEqual(trip.first);
  }, timeout(30_000));
});

