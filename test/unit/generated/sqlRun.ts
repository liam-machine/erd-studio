/**
 * Generated tests: the SQL import as its command runs it, up to the draft
 * the user sees (Import DBML's flow on the converted DBML), with every
 * string the user can read gathered for the no-echo rule.
 */
import { SQL_DIALECT_LABELS, type SqlDdlFile, type SqlDdlToDbmlResult, type SqlDialect } from '../../../src/services/sqlDdlImport';
import { sqlDdlToDbml } from '../../../src/services/sqlImportEngine';
import { describeImportProblems, sqlOriginPhrase } from '../../../src/services/importSources';
import { IMPORT_TITLES } from '../../../src/commands/importDbml';
import { importDbmlFlow, type ImportRun } from '../realWorldScorecard';
import { ledgerStrings } from './invariants';
import type { BreakKind, Broken } from './breaks';
import type { GSchema } from './schemaArbitraries';

export interface SqlRun {
  result: SqlDdlToDbmlResult;
  /** Import DBML's flow on the converted DBML (ok results only). */
  draft?: ImportRun;
  /** Every string a user can read. */
  shown: string[];
}

/** The SQL import as the command runs it, up to the draft. Throws only if an importer does. */
export function runSqlImport(files: SqlDdlFile[], dialect: SqlDialect): SqlRun {
  const result = sqlDdlToDbml({ files, dialect });
  const label = SQL_DIALECT_LABELS[dialect];
  if (!result.ok) {
    const failure = describeImportProblems(IMPORT_TITLES.sql, result.problems, `They were read as ${label}.`);
    return { result, shown: [failure, ...result.problems.map((p) => p.message), ...ledgerStrings(result.ledger ?? [])] };
  }
  const draft = importDbmlFlow(result.dbml, 'schema.dbml', 'sql', {
    from: sqlOriginPhrase(files.length, label),
    description: `Imported from schema.sql (${label}).`,
    notes: result.notes,
    skipped: result.skipped,
    ledger: result.ledger,
  });
  return {
    result,
    draft,
    shown: [...result.problems.map((p) => p.message), ...result.skipped, ...result.notes, ...ledgerStrings(result.ledger), ...draft.shown, ...draft.problems.map((p) => p.message)],
  };
}


/** Breaks that rename or remove a column of the table they hit (its columns are not the schema's any more). */
const COLUMN_CHANGING_BREAKS: ReadonlySet<BreakKind> = new Set<BreakKind>(['truncate', 'deleteLine', 'reservedName']);

/**
 * Column conservation, for a schema of plain names: every column of an
 * imported table is imported or reported. A table the break left untouched
 * imports with all its columns; a column missing from the table the break hit
 * has a ledger entry that names it, or the table is reported as a whole (a
 * problem or a loss). Not checked for breaks that rename or remove a column
 * of the table they hit.
 */
export function columnLossViolations(schema: GSchema, broken: Broken, kind: BreakKind, run: SqlRun): string[] {
  const r = run.result;
  if (!r.ok || !run.draft?.ok) return [];
  const out: string[] = [];
  const ledger = r.ledger ?? [];
  const tableOf = (label: string | undefined): string => (label ?? '').split('.').pop()!.replace(/^"|"$/g, '').toLowerCase();
  const imported = new Map(run.draft.tables.map((t) => [t.name.toLowerCase(), t]));
  schema.tables.forEach((t, i) => {
    const got = imported.get(t.name.toLowerCase());
    if (!got) return;
    const have = new Set((got.columns ?? []).map((c) => c.name.toLowerCase()));
    const missing = t.columns.map((c) => c.name).filter((c) => !have.has(c.toLowerCase()));
    if (!missing.length) return;
    if (broken.intact[i]) { out.push(`untouched table ${t.name} imported without ${missing.join(', ')}`); return; }
    if (i === broken.target && COLUMN_CHANGING_BREAKS.has(kind)) return;
    const entries = ledger.filter((e) => e.outcome !== 'changed' && tableOf(e.where?.table) === t.name.toLowerCase());
    const wholeTable = entries.some((e) => e.unit === 'table' && (e.outcome === 'problem' || e.outcome === 'lost'));
    for (const c of missing) {
      if (wholeTable) continue;
      if (!entries.some((e) => e.unit === 'column' && e.outcome !== 'repaired' && (e.where?.column ?? '').toLowerCase() === c.toLowerCase())) {
        out.push(`column ${t.name}.${c} neither imported nor reported`);
      }
    }
  });
  return out;
}
