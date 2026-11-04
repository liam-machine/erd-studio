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

/** SQL text that declares a table with a column list (CREATE [OR REPLACE] [TEMP…] TABLE x (…)), comments ignored. */
const CREATE_TABLE = /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:(?:temp|temporary|transient|external|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?[^;(]{1,300}\(/i;

/** Whether a `.sql` file's text holds a CREATE TABLE with columns (a dbt model's SELECT does not). */
export function looksLikeSqlDdl(text: string): boolean {
  return CREATE_TABLE.test(withoutSqlComments(text));
}

/** ALTER TABLE … that adds a key (FOREIGN KEY, PRIMARY KEY, REFERENCES): a pg_dump-style constraints file beside the tables. */
const ALTER_TABLE_KEY = /\balter\s+table\b[^;]{0,600}?\b(?:foreign\s+key|primary\s+key|references)\b/i;

/** Whether a `.sql` file's text adds keys to tables (comments ignored): the quick import takes it with the CREATE TABLE scripts. */
export function looksLikeSqlKeys(text: string): boolean {
  return ALTER_TABLE_KEY.test(withoutSqlComments(text));
}

/** How many CREATE TABLEs with a column list a `.sql` file's text holds, comments ignored (the start suggestion's count). */
export function countSqlCreateTables(text: string): number {
  return [...withoutSqlComments(text).matchAll(new RegExp(CREATE_TABLE.source, 'gi'))].length;
}

function withoutSqlComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** Folders a walk never enters: tools' and VCS's own, a dbt project's build output. */
export const IGNORED_IMPORT_FOLDERS: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.hg', '.svn', '.venv', 'venv', '__pycache__', 'target', 'dbt_packages', '.pbi',
]);

/** One directory's entries: a name and whether it is a folder. */
export type DirEntries = ReadonlyArray<readonly [name: string, isDirectory: boolean]>;

export interface WalkResult {
  /** Matching files, as paths joined with `/` under `root`, sorted. */
  files: string[];
  /** More than `limit` files matched: `files` holds the first `limit` found. */
  truncated: boolean;
}

/**
 * Every file under `root` that `include` accepts, depth first, skipping
 * {@link IGNORED_IMPORT_FOLDERS} and dot-folders (apart from `root` itself),
 * at most `limit` of them (`truncated` says there were more) and at most
 * `maxDepth` folders deep. `readDir` lists one folder; a folder that cannot
 * be listed is skipped. Sorted with numbers in order (`2_x` before `10_x`).
 */
export async function walkFiles(
  root: string,
  readDir: (folder: string) => Promise<DirEntries>,
  options: { include: (name: string) => boolean; limit: number; maxDepth?: number },
): Promise<WalkResult> {
  const maxDepth = options.maxDepth ?? 12;
  const files: string[] = [];
  let truncated = false;
  const join = (a: string, b: string): string => (a.endsWith('/') || a.endsWith('\\') ? `${a}${b}` : `${a}/${b}`);
  const visit = async (folder: string, depth: number): Promise<void> => {
    if (truncated) return;
    let entries: DirEntries;
    try {
      entries = await readDir(folder);
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => compareNames(a[0], b[0]));
    for (const [name, isDirectory] of sorted) {
      if (truncated) return;
      if (isDirectory) {
        if (depth >= maxDepth || IGNORED_IMPORT_FOLDERS.has(name) || name.startsWith('.')) continue;
        await visit(join(folder, name), depth + 1);
      } else if (options.include(name)) {
        if (files.length >= options.limit) { truncated = true; return; }
        files.push(join(folder, name));
      }
    }
  };
  await visit(root, 0);
  return { files: files.sort(compareNames), truncated };
}

/** Names compared as people read them: case-insensitive, numbers by value. */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
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
