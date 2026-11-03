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

/** The sources Import… offers, in the order shown when the folder suggests none. */
export const IMPORT_MODEL_SOURCES = ['dbml', 'sqlDdl', 'semanticModel'] as const;
export type ImportModelSource = (typeof IMPORT_MODEL_SOURCES)[number];

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
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  return CREATE_TABLE.test(withoutComments);
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

/** The dry run's note on renamed names: Power BI names become snake_case, the originals kept in meta. */
export function semanticModelRenameNote(renamed: ReadonlyArray<{ kind: 'table' | 'column' }>, metaKey: string): string | undefined {
  if (renamed.length === 0) return undefined;
  const tables = renamed.filter((r) => r.kind === 'table').length;
  const columns = renamed.length - tables;
  const what = [tables ? plural(tables, 'table name') : '', columns ? plural(columns, 'column name') : ''].filter(Boolean).join(' and ');
  return `${what} written in snake_case; each Power BI name is kept in its meta, as ${metaKey}.`;
}
