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

