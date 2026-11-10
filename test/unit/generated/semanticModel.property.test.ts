/**
 * Generated tests for the Power BI import: TMDL (a definition folder) and
 * TMSL (model.bim).
 *
 * Valid input (any names, quoting, descriptions, CRLF, BOM, tabs or spaces):
 * imports whole — every table, column, key and relationship, each under its
 * Power BI name (kept in `meta.power_bi_name` when snake_case changed it) —
 * and the DBML it converts to always reads back.
 *
 * Broken input (`breaks.ts`, in one table's file, the relationships file, or
 * model.bim): never throws, and
 *   - every table is imported, or reported (a ledger entry naming it or its
 *     file, or the model's own problems), never lost without a word; every
 *     table in a file the break did not touch is imported with all its
 *     columns;
 *   - relationships: drawn + skipped + not read = the relationship blocks,
 *     when the relationships file is untouched;
 *   - the converted DBML always reads;
 *   - every problem names its file (and a line in it, where it has one); no
 *     shown string echoes more than a short snippet of the files.
 * Plus: time grows roughly in line with model size.
 */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { readSemanticModel, semanticModelToDbml, type SemanticModelFile } from '../../../src/services/semanticModelImport';
import { semanticModelRenameNote, semanticModelSkippedSummary } from '../../../src/services/importSources';
import type { LedgerEntry } from '../../../src/services/importLedger';
import { importDbmlFlow, withSourceNames, type ImportRun } from '../realWorldScorecard';
import { applyBreak, breakArb, type BreakKind } from './breaks';
import { echoViolations, ledgerCount, ledgerLocationViolations, ledgerStrings, lineCount, timeRatio } from './invariants';
import { BIG_RUN, copies, params, runs, schemaArb, schemaTruth, timeout, type GSchema } from './schemaArbitraries';
import { tmdlKit, tmdlName, tmdlStyleArb, tmslKit, tmslStyleArb, writeTmdl, writeTmsl, type WrittenModel } from './semanticModelWriter';

interface ModelRun {
  ok: boolean;
  problems: Array<{ file: string; line?: number; message: string }>;
  ledger: LedgerEntry[];
  /** The draft (withSourceNames: tables and columns under their Power BI names). */
  draft?: ImportRun;
  converted?: { tableCount: number; refCount: number };
  shown: string[];
}

/** The Power BI import as its command runs it, up to the draft. */
export function runSemanticModel(files: SemanticModelFile[]): ModelRun {
  const read = readSemanticModel(files);
  if (!read.ok) return { ok: false, problems: read.problems, ledger: [], shown: read.problems.map((p) => p.message) };
  const converted = semanticModelToDbml(read.model);
  const warnings = [...read.warnings, ...converted.warnings];
  const rename = semanticModelRenameNote(converted.renamed);
  const draft = importDbmlFlow(converted.dbml, 'Gen.dbml', 'semanticModel', {
    from: 'from the semantic model Gen',
    notes: [...(rename ? [rename] : []), ...warnings],
    skipped: semanticModelSkippedSummary(converted.skippedCounts),
    ledger: converted.ledger,
  });
  return {
    ok: true,
    problems: read.problems ?? [],
    ledger: converted.ledger,
    draft: draft.ok ? withSourceNames(draft) : draft,
    converted: { tableCount: converted.tableCount, refCount: converted.refCount },
    shown: [...warnings, ...converted.skipped, ...(read.problems ?? []).map((p) => p.message), ...ledgerStrings(converted.ledger), ...draft.shown, ...draft.problems.map((p) => p.message)],
  };
}

const pbiSchema = (max = 4): fc.Arbitrary<GSchema> => schemaArb({ maxTables: max, maxColumns: 4, composite: false });

const namesOf = (schema: GSchema): string[] => schema.tables.flatMap((t) => [t.name, ...t.columns.map((c) => c.name)]);

const show = (files: SemanticModelFile[], extra = ''): string =>
  `${extra}\n${files.map((f) => `--- ${f.path}\n${f.text.length > 3000 ? `${f.text.slice(0, 3000)}…` : f.text}`).join('\n')}`;

/** The checks a valid model's import must pass. */
function expectWhole(schema: GSchema, written: WrittenModel, run: ModelRun): void {
  const where = show(written.files);
  const truth = schemaTruth(schema);
  expect(run.ok, `${where}\n${JSON.stringify(run.problems)}`).toBe(true);
  expect(run.problems, where).toEqual([]);
  const draft = run.draft!;
  expect(draft.ok, `${where}\n${JSON.stringify(draft.problems)}`).toBe(true);
  const want = schema.tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => c.name), pk: t.pk })).sort((a, b) => a.name.localeCompare(b.name));
  const got = draft.tables.map((t) => ({ name: t.name, columns: (t.columns ?? []).map((c) => c.name), pk: (t.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name) })).sort((a, b) => a.name.localeCompare(b.name));
  expect(got, where).toEqual(want);
  expect(draft.relationships.length, where).toBe(truth.relationships);
  const wantLinks = schema.tables.flatMap((t) => t.fks.map((fk) => `${t.name}.${fk.columns[0]}>${fk.table}.${fk.references[0]}`)).sort();
  const gotLinks = draft.relationships.map((l) => (l.cardinality === 'one-to-many'
    ? `${l.toModel}.${l.toColumn}>${l.fromModel}.${l.fromColumn}`
    : `${l.fromModel}.${l.fromColumn}>${l.toModel}.${l.toColumn}`)).sort();
  expect(gotLinks, where).toEqual(wantLinks);
  expect(echoViolations(run.shown, written.files.map((f) => f.text), namesOf(schema)), where).toEqual([]);
}

describe('Power BI import (generated): a valid model imports whole', () => {
  it('TMDL: every table, column, key and relationship under its Power BI name', () => {
    fc.assert(fc.property(pbiSchema(), tmdlStyleArb(), (schema, style) => {
      const written = writeTmdl(schema, style);
      expectWhole(schema, written, runSemanticModel(written.files));
    }), params(runs(60, 0.5)));
  }, timeout(30_000));

  it('TMSL (model.bim): the same', () => {
    fc.assert(fc.property(pbiSchema(), tmslStyleArb(), (schema, style) => {
      const written = writeTmsl(schema, style);
      expectWhole(schema, written, runSemanticModel(written.files));
    }), params(runs(60, 0.5)));
  }, timeout(30_000));
});

/** Whether the run reports `table` (from `file`): a ledger entry naming it or its file, or a problem in its file. */
function reported(run: ModelRun, table: string, file: string | undefined): boolean {
  if (run.problems.some((p) => p.file === file)) return true;
  return run.ledger.some((e) => (e.outcome === 'problem' || e.outcome === 'lost' || e.outcome === 'skipped')
    && ((e.where?.table === table && (e.unit === 'table' || e.unit === 'file')) || (file !== undefined && e.where?.file === file && e.outcome === 'problem')));
}

function brokenViolations(
  schema: GSchema, written: WrittenModel, files: SemanticModelFile[], touched: string, intactTables: boolean[], kind: BreakKind, run: ModelRun,
  columnHeader?: (column: string) => RegExp,
): string[] {
  const out: string[] = [];
  if (!run.ok) {
    if (run.problems.length === 0) out.push('failed with no problem');
  } else if (run.draft && !run.draft.ok) {
    out.push(`the converted DBML does not read: ${run.draft.problems.map((p) => `${p.line}: ${p.message}`).join('; ')}`);
  } else if (run.draft) {
    const byName = new Map(run.draft.tables.map((t) => [t.name, t]));
    schema.tables.forEach((t, i) => {
      const file = written.spans[i].file;
      const got = byName.get(t.name);
      const text = files.find((f) => f.path === file)?.text ?? '';
      const gone = !text.includes(written.spans[i].header);
      if (intactTables[i]) {
        if (!got) out.push(`untouched table ${t.name} not imported`);
        else if ((got.columns ?? []).length !== t.columns.length) out.push(`untouched table ${t.name}: ${(got.columns ?? []).length} of ${t.columns.length} columns`);
      } else if (!got && !gone && !reported(run, t.name, file)) {
        out.push(`table ${t.name} (${kind}) neither imported nor reported`);
      } else if (got && columnHeader) {
        // Columns of the touched table: every one still declared is imported, or reported.
        const names = new Set((got.columns ?? []).map((c) => c.name));
        const reportedColumns = ledgerCount(run.ledger, (e) => e.unit === 'column' && e.outcome === 'problem' && (e.where?.table === t.name || e.where?.file === file));
        const declared = t.columns.filter((c) => columnHeader(c.name).test(text));
        const missing = declared.filter((c) => !names.has(c.name));
        if (missing.length > reportedColumns) out.push(`table ${t.name} (${kind}): columns ${missing.map((c) => c.name).join(', ')} neither imported nor reported`);
      }
    });
    // Relationships: conservation when their file is untouched (TMDL), or the whole model read (TMSL).
    const blocks = schema.tables.reduce((n, t) => n + t.fks.length, 0);
    if (blocks > 0 && touched !== written.relationshipsFile && written.relationshipsFile) {
      const skipped = ledgerCount(run.ledger, (e) => e.unit === 'relationship' && (e.outcome === 'skipped' || e.outcome === 'problem' || e.outcome === 'lost'));
      const drawn = run.converted?.refCount ?? 0;
      if (drawn + skipped !== blocks) out.push(`relationships: ${drawn} drawn + ${skipped} reported ≠ ${blocks} in the file`);
    }
  }
  // Every problem names its file, and a line inside it when it has one.
  for (const p of run.problems) {
    const f = files.find((x) => x.path === p.file);
    if (!f) out.push(`problem names no file of the model: ${p.file}: ${p.message}`);
    else if (p.line !== undefined && (p.line < 1 || p.line > lineCount(f.text))) out.push(`problem line ${p.line} outside ${p.file}`);
  }
  out.push(...ledgerLocationViolations(run.ledger.filter((e) => !(e.unit === 'file' || /\bfile\b/.test(e.what))), files.map((f) => ({ name: f.path, text: f.text }))));
  out.push(...echoViolations(run.shown, files.map((f) => f.text), namesOf(schema)));
  return out;
}

describe('Power BI import (generated): a broken model is imported or reported', () => {
  it('TMDL: never throws; untouched tables import whole; the rest imported or reported; located; no long echo', () => {
    fc.assert(fc.property(pbiSchema(), tmdlStyleArb(), breakArb(), (schema, style, brk) => {
      const written = writeTmdl(schema, style);
      // The break lands in one table's file, or the relationships file.
      const targets = [...written.spans.map((s) => s.file!), ...(written.relationshipsFile ? [written.relationshipsFile] : [])];
      const touched = targets[brk.table % targets.length];
      const file = written.files.find((f) => f.path === touched)!;
      const broken = applyBreak(file.text, [{ table: touched, start: 0, end: file.text.length, header: '', file: touched }], { ...brk, table: 0 }, tmdlKit(style.spaces), style.eol);
      const files = written.files.map((f) => (f.path === touched ? { ...f, text: broken.text } : f));
      const intact = written.spans.map((s) => s.file !== touched || broken.text === file.text);
      let run: ModelRun;
      try {
        run = runSemanticModel(files);
      } catch (err) {
        throw new Error(`threw ${String(err)}\n${show(files, brk.kind)}`);
      }
      const header = (c: string): RegExp => new RegExp(`^${style.spaces ? ' {4}' : '\\t'}column ${tmdlName(c, style.quoteAll).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?$`, 'm');
      // The test's own reading: every column's declaration is found in the file as written.
      schema.tables.forEach((t, i) => {
        const own = written.files.find((f) => f.path === written.spans[i].file)!.text;
        for (const c of t.columns) expect(header(c.name).test(own), `${c.name} in\n${own}`).toBe(true);
      });
      expect(brokenViolations(schema, written, files, touched, intact, brk.kind, run, header), `${show(files, `${brk.kind} in ${touched}`)}\nproblems: ${JSON.stringify(run.problems.slice(0, 4))}`).toEqual([]);
    }), params(runs(100)));
  }, timeout(30_000));

  it('TMSL: never throws; a model.bim that does not parse is one located problem; one that parses imports or reports every table', () => {
    fc.assert(fc.property(pbiSchema(), tmslStyleArb(), breakArb(), (schema, style, brk) => {
      const written = writeTmsl(schema, style);
      const file = written.files[0];
      const broken = applyBreak(file.text, written.spans, brk, tmslKit(), style.eol);
      const files = [{ ...file, text: broken.text }];
      let run: ModelRun;
      try {
        run = runSemanticModel(files);
      } catch (err) {
        throw new Error(`threw ${String(err)}\n${show(files, brk.kind)}`);
      }
      // A break that renamed a table to another's name made a duplicate (the first is kept, the second reported): neither is untouched.
      let intact = broken.intact;
      try {
        const names = (JSON.parse(broken.text.replace(/^\uFEFF/, '')) as { model: { tables: Array<{ name?: string }> } }).model.tables.map((t) => t?.name);
        intact = intact.map((ok, i) => ok && names.filter((n) => n === schema.tables[i].name).length === 1);
      } catch {
        // Not JSON: the import fails whole, and the check is on its problem.
      }
      const v = brokenViolations(schema, { ...written, relationshipsFile: undefined }, files, file.path, intact, brk.kind, run);
      if (!run.ok && run.problems.some((p) => p.line === undefined && !/UTF-8/.test(p.message))) v.push(`a model.bim problem with no line: ${run.problems[0].message}`);
      expect(v, `${show(files, `${brk.kind} in table ${broken.target}`)}\nproblems: ${JSON.stringify(run.problems.slice(0, 4))}`).toEqual([]);
    }), params(runs(100)));
  }, timeout(30_000));
});

describe('Power BI import (generated): time grows in line with size', () => {
  const K = 8;
  const fixed = schemaArb({ minTables: 4, maxTables: 4, maxColumns: 6, composite: false, kinds: { reserved: 0, unicode: 0, spaced: 0, mixedCase: 0, huge: 0 } });
  const [schema] = fc.sample(fixed, { seed: 5, numRuns: 1 });
  const n = BIG_RUN ? 20 : 5;

  it('TMDL: n and 8·n tables', () => {
    const small = writeTmdl(copies(schema, n), { eol: '\n', bom: false, quoteAll: false, descriptions: true, spaces: false }).files;
    const big = writeTmdl(copies(schema, n * K), { eol: '\n', bom: false, quoteAll: false, descriptions: true, spaces: false }).files;
    const t = timeRatio(() => runSemanticModel(small), () => runSemanticModel(big), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
  }, timeout(30_000));

  it('TMSL: n and 8·n tables', () => {
    const style = { eol: '\n', bom: false, indent: 2, descriptions: true } as const;
    const small = writeTmsl(copies(schema, n), style).files;
    const big = writeTmsl(copies(schema, n * K), style).files;
    const t = timeRatio(() => runSemanticModel(small), () => runSemanticModel(big), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
  }, timeout(30_000));

  it('TMDL: one table of n and 8·n columns', () => {
    const wide = (cols: number): SemanticModelFile[] => writeTmdl({ tables: [{ name: 'wide', kind: 'plain', pk: ['c_0'], fks: [], columns: Array.from({ length: cols }, (_v, i) => ({ name: `c_${i}`, kind: 'plain' as const, type: 'int' as const, notNull: false })) }] },
      { eol: '\n', bom: false, quoteAll: false, descriptions: false, spaces: false }).files;
    const small = wide(BIG_RUN ? 400 : 150);
    const big = wide((BIG_RUN ? 400 : 150) * K);
    const t = timeRatio(() => runSemanticModel(small), () => runSemanticModel(big), K, { tries: 2 });
    expect(t.ratio, JSON.stringify(t)).toBeLessThan(4);
  }, timeout(30_000));
});
