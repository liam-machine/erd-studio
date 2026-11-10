/**
 * The import sources behind **Import…** (`erdStudio.importModel`): a DBML
 * file, SQL DDL scripts, a Power BI or Fabric semantic model. Pure and
 * vscode-free: the picker's order, the bounded folder walk the two converting
 * imports list files with, and how their conversion problems are worded.
 *
 * SQL DDL and the semantic model are converted to DBML first
 * (`sqlDdlImport.ts` / `semanticModelImport.ts`) and then go through Import
 * DBML's own flow (`src/commands/importDbml.ts`), so every source names the
 * diagram, shows the dry run and writes the same way.
 */

import type { DetectedImportSource } from '../types/startActions';
import { ERD_STUDIO_DBML_HEADER_PREFIX } from '@erd-studio/core';

import { countCreateTablesWithColumns } from './sqlDdlImport';

/**
 * The sources Import… offers, in the order shown when the folder suggests none.
 * The same ids the start screen's suggestion reads (`DetectedImportSource`).
 */
export const IMPORT_MODEL_SOURCES = ['dbml', 'sqlDdl', 'semanticModel'] as const satisfies readonly DetectedImportSource[];
export type ImportModelSource = (typeof IMPORT_MODEL_SOURCES)[number];
/** Both lists name every source (a compile-time check). */
const SAME_SOURCES: DetectedImportSource extends ImportModelSource ? true : never = true;
void SAME_SOURCES;

/**
 * The picker's order: the sources the open folder seems to hold first (a
 * `*.SemanticModel` folder, `.sql` files with CREATE TABLE, a `.dbml` file),
 * each group in the fixed order, so with nothing found DBML leads.
 */
export function orderImportSources(found: ReadonlySet<ImportModelSource>): ImportModelSource[] {
  return [
    ...IMPORT_MODEL_SOURCES.filter((s) => found.has(s)),
    ...IMPORT_MODEL_SOURCES.filter((s) => !found.has(s)),
  ];
}

/**
 * Whether a `.sql` file's text holds a CREATE TABLE with a column list, by
 * the converter's own reading (`countCreateTablesWithColumns`): a dbt
 * model's SELECT, a CTAS (`CREATE TABLE x AS SELECT …`) or a dbt macro
 * (`create table {{ relation }} as (…)`) does not.
 */
export function looksLikeSqlDdl(text: string): boolean {
  return countSqlCreateTables(text) > 0;
}

/** ALTER TABLE … that adds a key (FOREIGN KEY, PRIMARY KEY, REFERENCES): a pg_dump-style constraints file beside the tables. */
const ALTER_TABLE_KEY = /\balter\s+table\b[^;]{0,600}?\b(?:foreign\s+key|primary\s+key|references)\b/i;

/** Whether a `.sql` file's text adds keys to tables (comments ignored): the quick import takes it with the CREATE TABLE scripts. */
export function looksLikeSqlKeys(text: string): boolean {
  return ALTER_TABLE_KEY.test(withoutSqlComments(text));
}

/** How many CREATE TABLEs with a column list a `.sql` file's text holds, comments ignored (the start suggestion's count). */
export function countSqlCreateTables(text: string): number {
  return countCreateTablesWithColumns(text);
}

function withoutSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** A Databricks notebook saved as `.sql` (its first line). */
const DATABRICKS_NOTEBOOK = /^\s*--\s*Databricks notebook source/;

/**
 * Whether a `.sql` file is one no folder look offers, whatever it holds: a
 * dbt macro (under `macros/`: Jinja, not DDL) or a Databricks notebook
 * (Import SQL DDL… reads neither). Pick such a file in Import SQL DDL… to
 * read it anyway. Oracle DDL is offered: it reads as Oracle.
 */
export function isUnofferedSqlFile(filePath: string, text: string): boolean {
  return /(^|[\\/])macros[\\/]/i.test(filePath) || DATABRICKS_NOTEBOOK.test(text);
}

/**
 * The CREATE TABLEs with a column list that a folder look counts in a `.sql`
 * file (0 for a file it does not offer, {@link isUnofferedSqlFile}). The
 * start screen's look and the quick import share it, so whatever one offers
 * the other takes.
 */
export function sqlScriptTableCount(filePath: string, text: string): number {
  return isUnofferedSqlFile(filePath, text) ? 0 : countSqlCreateTables(text);
}

/**
 * ALTER TABLE … that changes columns or the table's name (ADD / DROP / RENAME
 * COLUMN, ALTER / MODIFY / CHANGE a column, RENAME TO), or SQL Server's
 * `sp_rename`: a later migration of the same tables.
 */
const ALTER_TABLE_CHANGE = /\balter\s+table\b[^;]{0,600}?\b(?:add|drop|rename|alter|modify|change)\b|\bsp_rename\b|\brename\s+table\b/i;

/** Whether a `.sql` file's text changes tables' columns or names (comments ignored): a migration the quick import applies in order. */
export function looksLikeSqlSchemaChange(text: string): boolean {
  return ALTER_TABLE_CHANGE.test(withoutSqlComments(text));
}

/**
 * Whether the quick import takes a `.sql` file: CREATE TABLEs, keys added to
 * tables, or later changes to their columns (a migrations folder imports as
 * its final schema). A file of DROP TABLEs alone (a teardown script) is not
 * taken.
 */
export function isSqlScriptTaken(filePath: string, text: string): boolean {
  return !isUnofferedSqlFile(filePath, text) && (countSqlCreateTables(text) > 0 || looksLikeSqlKeys(text) || looksLikeSqlSchemaChange(text));
}

/**
 * Folders a walk never enters: tools' and VCS's own, dependencies, a dbt
 * project's build output and Power BI's local cache. Any other hidden folder
 * is entered (a `.devcontainer/initdb/` of CREATE TABLE scripts counts).
 */
export const IGNORED_IMPORT_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'target', 'dbt_packages',
  'dbt_modules', 'site-packages', '.pbi', '.tox', '.nox', '.cache', '.idea', '.vscode', '.vscode-test', '.terraform',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', '.next', '.nuxt', '.yarn', '.pnpm-store', '.gradle', '.npm',
  '.direnv', '.eggs', '.ipynb_checkpoints', '.history', '.Trash',
]);

/** How deep a walk goes below the folder it starts in. */
export const IMPORT_WALK_MAX_DEPTH = 16;

/** One directory's entries: a name and whether it is a folder. */
export type DirEntries = ReadonlyArray<readonly [name: string, isDirectory: boolean]>;

export interface WalkResult {
  /** Matching files, as paths joined with `/` under `root`, sorted. */
  files: string[];
  /** More than `limit` files matched: `files` holds the first `limit` found. */
  truncated: boolean;
}

/**
 * Every file under `root` that `include` accepts, breadth first (so a bound
 * keeps the shallowest), skipping {@link IGNORED_IMPORT_FOLDERS} and any
 * folder `skipFolder` names, at most `limit` of them (`truncated` says there
 * were more) and at most `maxDepth` folders deep
 * ({@link IMPORT_WALK_MAX_DEPTH}). `readDir` lists one folder (a symbolic
 * link to a folder counts as a folder); a folder that cannot be listed is
 * skipped; `cancelled` stops the walk (what was found so far is returned).
 * Sorted with numbers in order (`2_x` before `10_x`).
 */
export async function walkFiles(
  root: string,
  readDir: (folder: string) => Promise<DirEntries>,
  options: {
    include: (name: string) => boolean;
    limit: number;
    maxDepth?: number;
    skipFolder?: (folderPath: string) => boolean;
    cancelled?: () => boolean;
  },
): Promise<WalkResult> {
  const maxDepth = options.maxDepth ?? IMPORT_WALK_MAX_DEPTH;
  const files: string[] = [];
  let truncated = false;
  const join = (a: string, b: string): string => (a.endsWith('/') || a.endsWith('\\') ? `${a}${b}` : `${a}/${b}`);
  let level = [root];
  for (let depth = 0; level.length > 0 && !truncated; depth++) {
    const next: string[] = [];
    for (const folder of level) {
      if (truncated || options.cancelled?.()) return { files: files.sort(compareNames), truncated };
      let entries: DirEntries;
      try {
        entries = await readDir(folder);
      } catch {
        continue;
      }
      const sorted = [...entries].sort((a, b) => compareNames(a[0], b[0]));
      for (const [name, isDirectory] of sorted) {
        if (isDirectory) {
          if (depth >= maxDepth || IGNORED_IMPORT_FOLDERS.has(name)) continue;
          const child = join(folder, name);
          if (options.skipFolder?.(child)) continue;
          next.push(child);
        } else if (options.include(name)) {
          if (files.length >= options.limit) { truncated = true; break; }
          files.push(join(folder, name));
        }
      }
    }
    level = next;
  }
  return { files: files.sort(compareNames), truncated };
}

/**
 * The largest `.sql` file the import reads (bytes): bigger is a dump with its
 * data, or more than a model. The looks never offer one, and Import SQL DDL…
 * says so when one is picked. A dump's data (pg_dump's COPY blocks, INSERT
 * statements) does not count toward the import's own SQL limit, so a dump
 * under this size with its data still imports.
 */
export const MAX_SQL_FILE_BYTES = 200 * 1024 * 1024;

/** Whether a `.dbml` file's text is ERD Studio's own export (its first non-blank line is the export header). */
export function isOwnDbmlExport(text: string): boolean {
  const first = text.replace(/^\ufeff/, '').split(/\r?\n/).find((l) => l.trim() !== '');
  return first?.trim().startsWith(ERD_STUDIO_DBML_HEADER_PREFIX) === true;
}

/** How many file names one listing of the open folder holds at most (names only; nothing is read). */
export const IMPORT_LIST_LIMIT = 5000;

/**
 * A file every semantic model Import Semantic Model… can read holds
 * (`findSemanticModels`): a `.bim`, a TMDL model's `definition.pbism`,
 * `model.tmdl` or `database.tmdl`, or a Tabular Editor Save to Folder
 * model's `database.json` (a model only with a `tables/` folder beside it:
 * {@link listImportFiles} checks).
 */
export function isSemanticModelMarker(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.bim') || lower === 'definition.pbism' || lower === 'model.tmdl' || lower === 'database.tmdl' || lower === 'database.json';
}

/** At most this many `database.json` files are looked beside for a `tables/` folder (one listing each). */
const MAX_FOLDER_MODEL_CHECKS = 20;

/** What one listing of the open folder found, by kind (paths joined with `/` under the root, sorted). */
export interface ImportListing {
  sql: string[];
  dbml: string[];
  semanticModel: string[];
  /** A `dbt_project.yml` is in the folder. */
  dbtProject: boolean;
  /** More files than {@link IMPORT_LIST_LIMIT}: the listing holds the shallowest. */
  truncated: boolean;
}

/**
 * The one listing of the open folder that the start screen's look and the
 * quick imports share: `.sql` and `.dbml` files (any letter case), semantic
 * model files and `dbt_project.yml`, by {@link walkFiles}' rules, never
 * inside the ERD Studio folder (`semanticDir`, or the legacy `erd-studio/`).
 */
export async function listImportFiles(
  root: string,
  readDir: (folder: string) => Promise<DirEntries>,
  options: { semanticDir: string; cancelled?: () => boolean; limit?: number },
): Promise<ImportListing> {
  const own = new Set([options.semanticDir.replace(/[\\/]+$/, ''), 'erd-studio'].map((d) => normaliseSlashes(`${root}/${d}`)));
  const walk = await walkFiles(root, readDir, {
    include: (name) => /\.(sql|dbml)$/i.test(name) || isSemanticModelMarker(name) || name === 'dbt_project.yml',
    limit: options.limit ?? IMPORT_LIST_LIMIT,
    skipFolder: (folder) => own.has(normaliseSlashes(folder)),
    cancelled: options.cancelled,
  });
  const base = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  // A database.json is a Save to Folder model only with a tables/ folder beside it (not db-migrate's, say).
  const folderModels = new Set<string>();
  for (const f of walk.files.filter((x) => base(x).toLowerCase() === 'database.json').slice(0, MAX_FOLDER_MODEL_CHECKS)) {
    if (options.cancelled?.()) break;
    const entries = await readDir(f.slice(0, f.length - base(f).length - 1)).catch(() => [] as DirEntries);
    if (entries.some(([name, isDirectory]) => isDirectory && name.toLowerCase() === 'tables')) folderModels.add(f);
  }
  return {
    sql: walk.files.filter((f) => /\.sql$/i.test(f)),
    dbml: walk.files.filter((f) => /\.dbml$/i.test(f)),
    semanticModel: walk.files.filter((f) => isSemanticModelMarker(base(f)) && (base(f).toLowerCase() !== 'database.json' || folderModels.has(f))),
    dbtProject: walk.files.some((f) => base(f) === 'dbt_project.yml'),
    truncated: walk.truncated,
  };
}

function normaliseSlashes(p: string): string {
  return p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

/** File and folder names that usually hold table definitions (`ddl/`, `schema.sql`, `V1__init.sql`, `migrations/`). */
const DDL_LIKE_NAME = /(^|[\\/_.-])(ddl|schemas?|tables?|create|create_tables|structure|init|initdb|migrations?|changelog|dump)([\\/_.-]|$)|(^|[\\/])V\d+(?:_\d+)*__/i;

/**
 * `.sql` files in the order the looks read them: names that usually hold
 * table definitions first ({@link DDL_LIKE_NAME}), each group in its listed
 * order. A look reads the start of only the first few, so a folder of
 * hundreds of queries does not hide its one `schema/tables.sql`.
 */
export function rankSqlFiles(files: readonly string[], root = ''): string[] {
  const likely: string[] = [];
  const rest: string[] = [];
  const prefix = root.replace(/[\\/]+$/, '');
  for (const file of files) {
    // Only the part under the open folder: the folder's own path says nothing.
    const rel = prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file;
    (DDL_LIKE_NAME.test(rel) ? likely : rest).push(file);
  }
  return [...likely, ...rest];
}

/** One collator for every comparison: `localeCompare` with options builds a new one per call, too slow for a folder of 100,000 files. */
const NAME_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Names compared as people read them: case-insensitive, numbers by value. */
export function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** A problem a conversion found in the user's files. */
export interface ImportProblem {
  /** The file as shown to the user ('' when it is about the input as a whole). */
  file: string;
  /** 1-based. */
  line?: number;
  message: string;
}

/** How many of a conversion's problems a message names; the rest are counted. */
export const PROBLEMS_SHOWN = 3;

/** One problem as a message names it: `a.sql line 6: …`. */
export function problemLabel(problem: ImportProblem): string {
  const where = problem.file ? `${problem.file}${problem.line ? ` line ${problem.line}` : ''}: ` : '';
  const message = problem.message.trim();
  return `${where}${message}${/[.!?]$/.test(message) ? '' : '.'}`;
}

/**
 * The message for files a conversion could not read: the first few problems
 * with file and line, the rest counted, and `hint` (for SQL, the dialect it
 * was read as). The user's files, not a failure of ours.
 */
export function describeImportProblems(title: string, problems: readonly ImportProblem[], hint = ''): string {
  const labels = [...new Set(problems.map(problemLabel))];
  const shown = labels.slice(0, PROBLEMS_SHOWN);
  const more = labels.length - shown.length;
  const tail = more > 0 ? ` And ${more} more ${more === 1 ? 'problem' : 'problems'}.` : '';
  return `${title}: nothing was imported. ${shown.join(' ')}${tail}${hint ? ` ${hint}` : ''}`;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The name the import shows for converted DBML (`<stem>.dbml`, never on
 * disk), from the files read: one file's own name, else the folder they
 * share. Import DBML suggests the diagram name from it.
 */
export function convertedFileName(paths: readonly string[], folder?: string): string {
  const base = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const stem = paths.length === 1 && !folder
    ? base(paths[0]).replace(/\.[^.]+$/, '')
    : base(folder ?? paths[0].replace(/[\\/][^\\/]*$/, ''));
  return `${stem || 'import'}.dbml`;
}

/** Folder and file names that say nothing about the model (`database/`, `ddl/`, `schema.sql`): not worth a diagram's name. */
const GENERIC_SQL_STEMS = new Set([
  'database', 'databases', 'db', 'sql', 'ddl', 'schema', 'schemas', 'script', 'scripts', 'migration', 'migrations',
  'table', 'tables', 'create', 'create_tables', 'init', 'setup', 'src', 'source', 'import', 'dump', 'export', 'model', 'models',
]);
/** Schemas every database has: they name nobody's model either. */
const DEFAULT_SQL_SCHEMAS = new Set(['public', 'dbo', 'main']);

/**
 * A better name for converted SQL than a generic folder or file name
 * (onboarding story 04 was offered `database`): the schema most of the
 * tables share, when it is not a default one (`sales`), else the project
 * folder's name; a name that already says something is kept. `dbml` is the
 * converted text (`Table sales.x {` lines), `projectFolder` the open folder.
 */
export function sqlImportFileName(fileName: string, dbml: string, projectFolder?: string): string {
  const stem = fileName.replace(/\.dbml$/i, '');
  if (!GENERIC_SQL_STEMS.has(stem.toLowerCase())) return fileName;
  const counts = new Map<string, number>();
  for (const m of dbml.matchAll(/^Table\s+(?:"([^"]+)"|([A-Za-z_][\w$]*))\./gm)) {
    const schema = (m[1] ?? m[2]).toLowerCase();
    counts.set(schema, (counts.get(schema) ?? 0) + 1);
  }
  const ranked = [...counts].filter(([schema]) => !DEFAULT_SQL_SCHEMAS.has(schema)).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1])) return `${ranked[0][0]}.dbml`;
  const folder = projectFolder?.split(/[\\/]/).filter(Boolean).pop();
  if (folder && !GENERIC_SQL_STEMS.has(folder.toLowerCase())) return `${folder}.dbml`;
  return fileName;
}

/** `from 2 SQL files (PostgreSQL)`: what the dry run's headline says a SQL import came from. */
export function sqlOriginPhrase(fileCount: number, dialectLabel: string): string {
  return `from ${plural(fileCount, 'SQL file')} (${dialectLabel})`;
}

/**
 * What a semantic model's conversion skipped, counted by kind (no names: the
 * full list goes to the log). Kinds with none are left out.
 */
export function semanticModelSkippedSummary(counts: {
  measures: number; autoDateTables: number; calculationGroups: number; relationships: number;
}): string[] {
  const out: string[] = [];
  if (counts.measures > 0) out.push(`${plural(counts.measures, 'measure')}: DAX calculations, not columns.`);
  if (counts.calculationGroups > 0) out.push(`${plural(counts.calculationGroups, 'calculation group')}: they hold DAX, not data.`);
  if (counts.autoDateTables > 0) out.push(`${plural(counts.autoDateTables, 'auto date/time table')}: Power BI makes one per date column.`);
  if (counts.relationships > 0) {
    out.push(`${plural(counts.relationships, 'relationship')} with an end that is missing, skipped or already joined.`);
  }
  return out;
}

/**
 * The dry run's note on renamed names: Power BI names become snake_case, the
 * originals kept in the table files (`meta.power_bi_name`; plain words, where
 * they are kept is the reference doc's business).
 */
export function semanticModelRenameNote(renamed: ReadonlyArray<{ kind: 'table' | 'column' }>): string | undefined {
  if (renamed.length === 0) return undefined;
  const tables = renamed.filter((r) => r.kind === 'table').length;
  const columns = renamed.length - tables;
  const what = [tables ? plural(tables, 'table name') : '', columns ? plural(columns, 'column name') : ''].filter(Boolean).join(' and ');
  return `${what} written in snake_case; the original Power BI names are kept in the table files.`;
}
