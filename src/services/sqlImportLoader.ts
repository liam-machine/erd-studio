/**
 * Loads the SQL importer (`dist/sqlImport.js`, built from
 * `sqlImportEngine.ts`) at run time. The bundle holds `@dbml/core`'s SQL
 * grammars — several megabytes — so it stays out of `dist/extension.js` and
 * is read from disk only the first time an Import SQL DDL… runs.
 *
 * Only a type import of the engine module here: esbuild drops it, so nothing
 * of `@dbml/core` reaches the extension bundle (test/unit/sqlDdlImport checks
 * the bundle's inputs). For the dialect picker's default, import
 * `detectSqlDialect` from `sqlDdlImport.ts` directly — it needs no bundle.
 *
 * No `vscode`: the caller passes `context.extensionPath`.
 */

import * as path from 'path';
import type * as SqlImportEngine from './sqlImportEngine';

/** What `dist/sqlImport.js` exports. */
export type SqlImportModule = Pick<typeof SqlImportEngine, 'sqlDdlToDbml' | 'detectSqlDialect'>;

/** The bundle's file name under `dist/`. */
export const SQL_IMPORT_BUNDLE = 'sqlImport.js';

/** Where the bundle is in an installed (or dev-host) extension. */
export function sqlImportBundlePath(extensionPath: string): string {
  return path.join(extensionPath, 'dist', SQL_IMPORT_BUNDLE);
}

const loaded = new Map<string, SqlImportModule>();

/**
 * The SQL importer, loaded once per bundle path. Throws an `Error` naming the
 * bundle when it is missing or not the importer (a broken install, or a dev
 * host started before `npm run build`). `load` is for tests.
 */
export function loadSqlImport(extensionPath: string, load: (file: string) => unknown = defaultLoad): SqlImportModule {
  const file = sqlImportBundlePath(extensionPath);
  const cached = loaded.get(file);
  if (cached) return cached;
  let mod: unknown;
  try {
    mod = load(file);
  } catch (error) {
    throw new Error(`ERD Studio could not load its SQL importer (dist/${SQL_IMPORT_BUNDLE}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = mod as Partial<SqlImportModule> | undefined;
  if (typeof candidate?.sqlDdlToDbml !== 'function' || typeof candidate.detectSqlDialect !== 'function') {
    throw new Error(`ERD Studio could not load its SQL importer: dist/${SQL_IMPORT_BUNDLE} is not the importer.`);
  }
  const ready: SqlImportModule = { sqlDdlToDbml: candidate.sqlDdlToDbml, detectSqlDialect: candidate.detectSqlDialect };
  loaded.set(file, ready);
  return ready;
}

/** Node's `require`, resolved at run time (esbuild leaves a non-literal require alone). */
function defaultLoad(file: string): unknown {
  return require(file);
}
