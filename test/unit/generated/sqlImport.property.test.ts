/**
 * Generated tests for the SQL DDL import, in every dialect it offers.
 *
 * Valid input (any names, quoting, keyword case, CRLF, BOM, inline or ALTER
 * foreign keys, a schema qualifier, comments between tokens): imports whole —
 * every table, column, key and foreign key, no problem — and the DBML it
 * converts to reads back through Import DBML with the same tables.
 *
 * Broken input (`breaks.ts`: a truncated file, a missing comma, parenthesis
 * or quote, an unknown type, a reserved word as a name, a table defined
 * twice, a very long statement, another dialect's syntax, a stray line, a
 * deleted line): never throws, and
 *   - conservation: tables found = imported + reported (the ledger);
 *   - nothing swallowed: every table the break left untouched is found, and
 *     imported (a failure stays in its own statement); when names are plain,
 *     by name;
 *   - every problem has its file and a line in it, in the result and in the
 *     ledger;
 *   - no message, note, ledger line or draft string echoes more than a short
 *     snippet of the file.
 * Plus: time grows roughly in line with input size (n and 8·n tables; one
 * statement of n and 8·n columns).
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SQL_DIALECTS, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlDialect } from '../../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../../src/services/sqlImportEngine';
import { runSqlImport, type SqlRun } from './sqlRun';
import { applyBreak, breakArb, headersIn, type Broken } from './breaks';
import {
  echoViolations,
  ledgerCount,
  ledgerLocationViolations,
  locationViolations,
  timeRatio,
} from './invariants';
import { allPlain, BIG_RUN, copies, params, runs, schemaArb, schemaTruth, timeout, type GSchema } from './schemaArbitraries';
import { sqlKit, sqlStyleArb, writeSql, type SqlStyle } from './sqlWriter';

type Converted = Extract<SqlDdlToDbmlResult, { ok: true }>;

/** Tables the ledger reports as not imported. */
const reportedTables = (r: SqlDdlToDbmlResult): number =>
  ledgerCount(r.ledger ?? [], (e) => e.unit === 'table' && (e.outcome === 'problem' || e.outcome === 'lost' || e.outcome === 'skipped'));

const namesOf = (schema: GSchema, extra: readonly string[] = []): string[] => [
  ...schema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]),
  ...extra,
];

const dialectArb = fc.constantFrom(...SQL_DIALECTS);

/** A short description of an input for a failure message (the file itself, cut). */
const show = (files: SqlDdlFile[], dialect: SqlDialect, extra = ''): string =>
  `${dialect}${extra}\n${files.map((f) => `--- ${f.name}\n${f.text.length > 4000 ? `${f.text.slice(0, 4000)}…` : f.text}`).join('\n')}`;

describe('SQL import (generated): valid input imports whole', () => {
  it('every table, column, key and foreign key, in every dialect, however it is written', () => {
    fc.assert(
      fc.property(schemaArb(), dialectArb, sqlStyleArb(), (schema, dialect, style) => {
        const { files } = writeSql(schema, dialect, style);
        const run = runSqlImport(files, dialect);
        const truth = schemaTruth(schema);
        const where = show(files, dialect);
        const r = run.result;
        expect(r.ok, `${where}\n${JSON.stringify(r.problems)}`).toBe(true);
        const ok = r as Converted;
        expect(ok.problems, where).toEqual([]);
        expect({ tables: ok.tableCount, found: ok.tablesFound, refs: ok.refCount }, where).toEqual({ tables: truth.tables, found: truth.tables, refs: truth.relationships });
        const draft = run.draft!;
        expect(draft.ok, where).toBe(true);
        expect(draft.tables.length, where).toBe(truth.tables);
        expect(draft.tables.reduce((n, t) => n + (t.columns?.length ?? 0), 0), where).toBe(truth.columns);
        expect(draft.tables.filter((t) => t.columns?.some((c) => c.isPrimaryKey)).length, where).toBe(truth.primaryKeys);
        const pairs = schema.tables.reduce((n, t) => n + t.fks.reduce((m, fk) => m + fk.columns.length, 0), 0);
        expect(draft.relationships.length, where).toBe(pairs);
        if (allPlain(schema)) {
          // Plain names come back as written: the same tables, columns, keys and links.
          const want = schema.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name), pk: [...t.pk].sort() })).sort((a, b) => a.name.localeCompare(b.name));
          const got = draft.tables.map((t) => ({ name: t.name, columns: (t.columns ?? []).map((c) => c.name), pk: (t.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name).sort() })).sort((a, b) => a.name.localeCompare(b.name));
          expect(got, where).toEqual(want);
          // A foreign key over unique columns (its own UNIQUE, or a unique key over a composite's) is one-to-one.
          const wantLinks = schema.tables.flatMap((t) => t.fks.flatMap((fk) => fk.columns.map((c, k) => `${t.name}.${c}>${fk.table}.${fk.references[k]} ${fk.oneToOne && dialect !== 'databricks' ? '1:1' : 'n:1'}`))).sort();
          const gotLinks = draft.relationships.map((l) => (l.cardinality === 'one-to-many'
            ? `${l.toModel}.${l.toColumn}>${l.fromModel}.${l.fromColumn} n:1`
            : `${l.fromModel}.${l.fromColumn}>${l.toModel}.${l.toColumn} ${l.cardinality === 'one-to-one' ? '1:1' : 'n:1'}`)).sort();
          expect(gotLinks, where).toEqual(wantLinks);
        }
        expect(echoViolations(run.shown, files.map((f) => f.text), namesOf(schema, style.schema ? [style.schema] : [])), where).toEqual([]);
      }),
      params(runs(60, 0.5)),
    );
  }, timeout(30_000));
});

describe('SQL import (generated): broken input is imported or reported', () => {
  it('never throws; tables found = imported + reported; untouched tables import; every problem located; no long echo', () => {
    fc.assert(
      fc.property(schemaArb({ maxTables: 4, maxColumns: 4 }), dialectArb, sqlStyleArb(), breakArb(), (schema, dialect, style, brk) => {
        const written = writeSql(schema, dialect, style);
        const file = written.files[0];
        const broken: Broken = applyBreak(file.text, written.spans, brk, sqlKit(dialect), style.eol);
        const files = [{ name: file.name, text: broken.text }];
        const where = show(files, dialect, ` ${brk.kind} in table ${broken.target}`);
        let run: SqlRun;
        try {
          run = runSqlImport(files, dialect);
        } catch (err) {
          throw new Error(`threw ${String(err)}\n${where}`);
        }
        const r = run.result;
        const imported = r.ok ? r.tableCount : 0;
        const found = r.tablesFound ?? 0;
        const violations: string[] = [];
        // Import or report.
        if (!r.ok && r.problems.length === 0) violations.push('failed with no problem');
        if (r.ok && imported + reportedTables(r) !== found) violations.push(`conservation: ${imported} imported + ${reportedTables(r)} reported ≠ ${found} found`);
        if (!r.ok && found > 0 && reportedTables(r) < found) violations.push(`failed import reports ${reportedTables(r)} of ${found} tables found`);
        // Nothing swallowed: every untouched table is found, and imported.
        const intact = broken.intact.filter(Boolean).length + (broken.duplicated ? 0 : 0);
        if (found < intact) violations.push(`only ${found} tables found; ${intact} are untouched`);
        // Every definition still in the file is counted (found), so it is imported or reported: none swallowed by its neighbour.
        // (A stray `/*` line hides what follows by SQL's own rules: there, only the untouched tables before it.)
        if (brk.kind !== 'garbageLine' && found < headersIn(broken.text, written.spans)) violations.push(`${found} tables found; the file defines ${headersIn(broken.text, written.spans)}`);
        if (found > headersIn(broken.text, written.spans) + 1) violations.push(`${found} tables found, more than the ${headersIn(broken.text, written.spans)} in the file`);
        if (imported < intact) violations.push(`only ${imported} imported; ${intact} untouched tables`);
        if (broken.duplicated && !r.problems.some((p) => p.cause === 'duplicate') && !(r.ledger ?? []).some((e) => e.cause === 'duplicate')) {
          violations.push(`table ${broken.duplicated} defined twice, and the second definition not reported`);
        }
        if (r.ok && run.draft) {
          if (!run.draft.ok) violations.push(`the converted DBML does not read: ${run.draft.problems.map((p) => `${p.line}: ${p.message}`).join('; ')}`);
          else if (run.draft.tables.length !== r.tableCount) violations.push(`DBML stage has ${run.draft.tables.length} tables, the conversion ${r.tableCount}`);
          if (allPlain(schema) && run.draft.ok) {
            const got = new Set(run.draft.tables.map((t) => t.name.toLowerCase()));
            schema.tables.forEach((t, i) => {
              if (broken.intact[i] && !got.has(t.name.toLowerCase())) violations.push(`untouched table ${t.name} not imported`);
            });
          }
        }
        violations.push(
          ...locationViolations(r.problems, files, { lineRequired: (p) => (p as { kind?: string }).kind !== 'noCreateTable' }),
          ...ledgerLocationViolations(r.ledger ?? [], files),
          ...echoViolations(run.shown, files.map((f) => f.text), namesOf(schema, style.schema ? [style.schema] : [])),
        );
        expect(violations, `${where}\nproblems: ${JSON.stringify(r.problems.slice(0, 5))}`).toEqual([]);
      }),
      params(runs(80, 1)),
    );
  }, timeout(60_000));
});

describe('SQL import (generated): time grows in line with size', () => {
  const style: SqlStyle = { quote: 'needed', keywordCase: 'upper', eol: '\n', bom: false, fkStyle: 'inline', inlinePk: false, noise: true, seed: 7 };
  const fixed = schemaArb({ minTables: 4, maxTables: 4, maxColumns: 6, kinds: { reserved: 0, unicode: 0, spaced: 0, mixedCase: 0, huge: 0 } });
  const K = 8;

  it.each(SQL_DIALECTS)('%s: n and 8·n tables (valid, and one break in every table)', (dialect) => {
    const [schema] = fc.sample(fixed, { seed: 11, numRuns: 1 });
    const n = BIG_RUN ? 6 : 2;
    const small = writeSql(copies(schema, n), dialect, style).files;
    const big = writeSql(copies(schema, n * K), dialect, style).files;
    const t = timeRatio(() => sqlDdlToDbml({ files: small, dialect }), () => sqlDdlToDbml({ files: big, dialect }), K, { tries: 2 });
    // Generous: 4× worse than linear is still "in line" under load; a quadratic step would be ~8×.
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
    // Broken: an unknown type in every table (each goes down the repair ladder).
    const breakAll = (files: SqlDdlFile[]): SqlDdlFile[] => files.map((f) => ({ ...f, text: f.text.replace(/ (integer|int|bigint|number\(38,0\)) /g, ' frobnicator(3) ') }));
    const tb = timeRatio(() => sqlDdlToDbml({ files: breakAll(small), dialect }), () => sqlDdlToDbml({ files: breakAll(big), dialect }), K, { tries: 1 });
    expect(tb.ratio, JSON.stringify(tb)).toBeLessThan(4);
  }, timeout(60_000));

  it.each(SQL_DIALECTS)('%s: one statement of n and 8·n columns', (dialect) => {
    const wide = (n: number): SqlDdlFile[] => {
      const cols = Array.from({ length: n }, (_v, i) => `  c_${i} int`).join(',\n');
      return [{ name: 'wide.sql', text: `CREATE TABLE wide (\n  id int NOT NULL,\n${cols},\n  PRIMARY KEY (id)\n);\n` }];
    };
    const t = timeRatio(() => sqlDdlToDbml({ files: wide(150), dialect }), () => sqlDdlToDbml({ files: wide(150 * K), dialect }), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
  }, timeout(60_000));
});
