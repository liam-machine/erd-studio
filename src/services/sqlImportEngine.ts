/**
 * The SQL importer with its parser: the entry of `dist/sqlImport.js`, a
 * bundle of its own (`esbuild.js`) because `@dbml/core`'s SQL grammars are
 * several megabytes. The host never imports this module; it loads the bundle
 * at run time, only when an import runs, through `sqlImportLoader.ts`
 * (`loadSqlImport`). Tests import it from source.
 *
 * The only module in `src/` that imports `@dbml/core` (test/unit/sqlDdlImport
 * checks that `dist/extension.js` and `dist/cli.js` never reach it). It uses
 * the grammars' raw, un-validated output (`Parser.parse…ToJSON…`), so the
 * converter (`sqlDdlImport.ts`) can read one statement at a time, merge
 * files and decide itself what a reference to a missing table means.
 *
 * No `vscode`.
 */

import { Parser } from '@dbml/core';
import {
  convertSqlDdl,
  detectSqlDialect,
  isSqlDialect,
  SQL_DIALECTS,
  SQL_DIALECT_LABELS,
  type RawSqlDatabase,
  type SqlDdlConvertOptions,
  type SqlDdlToDbmlInput,
  type SqlDdlToDbmlResult,
  type SqlParseEngine,
  type SqlParseFormat,
} from './sqlDdlImport';

export { detectSqlDialect, isSqlDialect, SQL_DIALECTS, SQL_DIALECT_LABELS };
export type { SqlDdlFile, SqlDdlProblem, SqlDdlToDbmlInput, SqlDdlToDbmlResult, SqlDialect } from './sqlDdlImport';

/** `@dbml/core` 11.0.0's statement parsers, by grammar. Its Oracle grammar is not bundled: Oracle, BigQuery, Redshift and SQLite read with the PostgreSQL one (`sqlDdlDialects.ts`). */
export const dbmlCoreSqlEngine: SqlParseEngine = (sql: string, format: SqlParseFormat): RawSqlDatabase => {
  // ANTLR's default listener prints every token error (`line 16:13 token recognition error`) with
  // console.error; the parse throws its own diagnostics, so the print is only noise in the host's log
  // (the repair ladder and the dialect ranking parse a statement several ways).
  const print = console.error;
  console.error = () => {};
  try {
    switch (format) {
      case 'postgres': return Parser.parsePostgresToJSONv2(sql) as unknown as RawSqlDatabase;
      case 'mysql': return Parser.parseMySQLToJSONv2(sql) as unknown as RawSqlDatabase;
      case 'mssql': return Parser.parseMSSQLToJSONv2(sql) as unknown as RawSqlDatabase;
      case 'snowflake': return Parser.parseSnowflakeToJSON(sql) as unknown as RawSqlDatabase;
      default: throw new Error(`Unsupported SQL grammar: ${String(format)}`);
    }
  } finally {
    console.error = print;
  }
};

/**
 * SQL DDL files → one DBML file for the Import DBML flow. See
 * `convertSqlDdl` in `sqlDdlImport.ts` for what is read and what is skipped
 * (a table that does not read never stops the rest; `options` can turn the
 * repair ladder and salvage off).
 */
export function sqlDdlToDbml(input: SqlDdlToDbmlInput & { options?: SqlDdlConvertOptions }): SqlDdlToDbmlResult {
  return convertSqlDdl(input, dbmlCoreSqlEngine);
}
