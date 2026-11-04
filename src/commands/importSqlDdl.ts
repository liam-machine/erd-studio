/**
 * **Import SQL DDL…** (`erdStudio.importSqlDdl`) — CREATE TABLE scripts in as
 * a new diagram: PostgreSQL, MySQL / MariaDB, SQL Server / Azure SQL,
 * Snowflake or Databricks / Spark SQL.
 *
 * Steps: `.sql` files, or a folder (every `.sql` under it, bounded) → read
 * them (`workspace.fs`) → the dialect (a quick pick, the detected one first)
 * → convert to DBML with the lazily loaded SQL importer (`dist/sqlImport.js`,
 * `src/services/sqlImportLoader.ts`; `@dbml/core`'s grammars never enter
 * `dist/extension.js`) → scripts that do not read are reported with file and
 * line and an Open File button → the converted DBML goes through Import
 * DBML's own flow (`importDbml` with `source: 'sql'`): the user picks the
 * layer, names the diagram and confirms a dry run that says what the scripts
 * held and what was skipped (views, indexes, grants…, counted by kind).
 * Cancelling any step writes nothing.
 *
 * **The quick path** (`quickImportSqlDdl`: the start screen's **Import your
 * SQL scripts** and the start suggestion) asks nothing it can answer: the
 * files are every `.sql` with a CREATE TABLE that the bounded walk finds in
 * the open folder, the dialect is the detected one (undetected or tied: the
 * most likely dialects in turn, the first that reads every file; the pick
 * only when none does), the layer and name are Import DBML's quick defaults,
 * and the draft (the read-only preview, `docs/dev/draft-first.md` §5.1) is
 * the one question. Its **Change options…** is the step-by-step flow with
 * those answers preselected, ending in a draft too. On the automatic draft
 * (`draft.quiet`) it asks and shows nothing: no script found, or none that
 * reads, ends it silently.
 *
 * Every vscode call goes through `ImportSqlDdlUi` (and Import DBML's
 * `ImportDbmlUi`), so the flow is unit-tested with plain fakes.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
  OPEN_FILE_BUTTON,
  SEND_FEEDBACK_BUTTON,
  feedbackPrefill,
  oursMessage,
  showErrorWithActions,
  type ErrorActions,
  type FeedbackPrefill,
} from '../services/commandErrors';
import {
  convertedFileName,
  describeImportProblems,
  looksLikeSqlDdl,
  looksLikeSqlKeys,
  sqlImportFileName,
  sqlOriginPhrase,
  walkFiles,
  type DirEntries,
} from '../services/importSources';
import { log } from '../services/logger';
import {
  SQL_DIALECTS,
  SQL_DIALECT_LABELS,
  detectSqlDialect,
  rankSqlDialects,
  type SqlDdlFile,
  type SqlDialect,
} from '../services/sqlDdlImport';
import { loadSqlImport, type SqlImportModule } from '../services/sqlImportLoader';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';
import {
  IMPORT_TITLES,
  changeOptionsDraft,
  importDbml,
  suppliedDbmlUi,
  vscodeImportDbmlUi,
  type ImportDbmlDeps,
  type ImportDbmlResult,
  type ImportDbmlUi,
} from './importDbml';
import { openTableFileAt } from './openModelFile';
import { readFileStart } from '../services/readFileStart';

export const IMPORT_SQL_DDL_COMMAND = 'erdStudio.importSqlDdl';

const TITLE = IMPORT_TITLES.sql;

/** At most this many `.sql` files from one folder. */
export const MAX_SQL_FILES = 500;
/** At most this much SQL text in one import (characters). */
export const MAX_SQL_CHARS = 20 * 1024 * 1024;

/** The funnel key for the dialect a conversion ran with. */
export const SQL_DIALECT_FEATURES: Readonly<Record<SqlDialect, TelemetryFeature>> = {
  postgres: 'importSqlDialectPostgres',
  mysql: 'importSqlDialectMysql',
  sqlserver: 'importSqlDialectSqlserver',
  snowflake: 'importSqlDialectSnowflake',
  databricks: 'importSqlDialectDatabricks',
};

/** The dialect quick pick's item. */
export interface SqlDialectItem extends vscode.QuickPickItem {
  dialect: SqlDialect;
}

/**
 * What the user picked: some `.sql` files, or a folder of them. `root`: the
 * files were found under that folder (the quick path, Change Options…), so
 * each is named by its path under it.
 */
export type SqlSources = { files: string[]; root?: string } | { folder: string };

/** The quick path reads only the start of a `.sql` file to tell a CREATE TABLE script from a query (the start screen's look reads as much). */
export const QUICK_SQL_SNIFF_CHARS = 64 * 1024;

/** A found script in Change Options…'s file pick. */
export interface SqlFileItem extends vscode.QuickPickItem {
  /** The full path; absent on "Other files or a folder…". */
  filePath?: string;
}

/** Change Options…'s item for the Open dialog instead. */
export const OTHER_SQL_FILES_ITEM = '$(folder-opened) Other files or a folder…';

/** Every vscode call the SQL half of the flow makes, injectable for tests. */
export interface ImportSqlDdlUi {
  /** `.sql` files or a folder; undefined when cancelled. */
  pickSources(defaultFolder: string | undefined): Promise<SqlSources | undefined>;
  /** One folder's entries (`workspace.fs.readDirectory`). */
  readDirectory(folder: string): Promise<DirEntries>;
  /** A file's text (`workspace.fs`). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  pickDialect(items: readonly SqlDialectItem[], options: vscode.QuickPickOptions): Promise<SqlDialectItem | undefined>;
  /** Change Options…: which of the found scripts (several may be picked; the found ones start picked). */
  pickFiles?(items: readonly SqlFileItem[], options: vscode.QuickPickOptions): Promise<readonly SqlFileItem[] | undefined>;
  /** The start of a file's text, at most `chars` (the quick path's look at each `.sql`). Absent: `readFile`. */
  readFileStart?(filePath: string, chars: number): Promise<string>;
  showInformationMessage(message: string): Promise<unknown>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  openFileAt(filePath: string, line?: number): Promise<void>;
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
}

export interface ImportSqlDdlDeps extends Omit<ImportDbmlDeps, 'ui' | 'source' | 'origin'> {
  /** The extension's folder: the SQL importer is `<extensionPath>/dist/sqlImport.js`. */
  extensionPath: string;
  sqlUi?: ImportSqlDdlUi;
  /** The Import DBML half (layer, name, dry run, open). */
  ui?: ImportDbmlUi;
  /** Loads the SQL importer (tests pass the engine module itself). Default `loadSqlImport(extensionPath)`. */
  loadSqlImport?: () => SqlImportModule;
}

/** Where Try Another Dialect re-enters: with the files already read. */
export interface SqlResume {
  files: SqlDdlFile[];
  /** Full path of each file, by its shown name (for Open File). */
  fullPaths: ReadonlyMap<string, string>;
  fileName: string;
  sourceLabel: string;
}

/** Change Options…: the answers the quick path chose, preselected in the step-by-step flow. */
export interface SqlPreset {
  dialect?: SqlDialect;
  /**
   * The user already chose `dialect` (the import guide's card for that
   * source: `erdStudio.importSqlDdl` with `{ dialect }`), so it is not asked
   * again. Scripts that do not read as it still offer Try Another Dialect.
   */
  dialectChosen?: boolean;
  layer?: string;
  name?: string;
}

/** The SQL UI of the automatic draft: it asks nothing and shows nothing (each message goes to the log). */
export function quietImportSqlDdlUi(base: ImportSqlDdlUi): ImportSqlDdlUi {
  const logged = async (message: string): Promise<undefined> => {
    log.info(`[ERD Studio] ${TITLE} (automatic draft, not shown): ${message}`);
    return undefined;
  };
  return {
    ...base,
    pickSources: async () => undefined,
    pickDialect: async () => undefined,
    pickFiles: async () => undefined,
    showInformationMessage: (message) => logged(message),
    showErrorMessage: (message) => logged(message),
  };
}

/** The SQL UI a run uses: the automatic draft's quiet one, else `deps.sqlUi` or the real one. */
function sqlUiOf(deps: ImportSqlDdlDeps): ImportSqlDdlUi {
  const ui = deps.sqlUi ?? vscodeImportSqlDdlUi();
  return deps.draft?.quiet ? quietImportSqlDdlUi(ui) : ui;
}

/**
 * The run's shared reporting: a cancel, an error with its buttons, a failure
 * of ours. `quiet` (the automatic draft): an early end is neither the user's
 * cancel nor their file, so neither is counted.
 */
function sqlRun(ui: ImportSqlDdlUi, quiet = false) {
  const cancelled = (): undefined => {
    if (!quiet) telemetry.feature('importSqlDdlCancelled');
    return undefined;
  };
  const showError = (message: string, actions: ErrorActions = {}): void => {
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)) });
    });
  };
  const ours = (doing: string, err: unknown): undefined => {
    telemetry.error('importSqlDdlFailed');
    log.error(`[ERD Studio] ${TITLE} failed ${doing}:`, err);
    showError(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)),
    });
    return undefined;
  };
  /** A gather that gave a message: say it (an error or a plain note). */
  const gatherMessage = (gathered: { message: string; error: boolean; invalid?: boolean }): undefined => {
    if (gathered.invalid && !quiet) telemetry.feature('importSqlDdlInvalid');
    if (gathered.error) showError(gathered.message);
    else void ui.showInformationMessage(gathered.message);
    return undefined;
  };
  const invalid = (): void => {
    if (!quiet) telemetry.feature('importSqlDdlInvalid');
  };
  return { cancelled, showError, ours, gatherMessage, invalid };
}

/** The SQL importer, loaded on first use; undefined after saying it failed. */
function loadEngine(deps: ImportSqlDdlDeps, ours: (doing: string, err: unknown) => undefined): SqlImportModule | undefined {
  try {
    return deps.loadSqlImport ? deps.loadSqlImport() : loadSqlImport(deps.extensionPath);
  } catch (err) {
    return ours('while loading its SQL importer', err);
  }
}

/**
 * Run the flow. Resolves Import DBML's result once a diagram is written, or
 * undefined when the user cancels, the scripts do not read, or something
 * failed (each case has already said so). `preset`: Change Options…'s
 * answers, offered first at each step.
 */
export async function importSqlDdl(deps: ImportSqlDdlDeps, resume?: SqlResume, preset: SqlPreset = {}): Promise<ImportDbmlResult | undefined> {
  const ui = sqlUiOf(deps);
  const { cancelled, showError, ours, gatherMessage, invalid } = sqlRun(ui, deps.draft?.quiet === true);

  // 1. The scripts.
  let read = resume;
  if (!read) {
    const sources = await ui.pickSources(deps.workspaceRoot || undefined);
    if (!sources) return cancelled();
    const gathered = await gatherSqlFiles(sources, ui);
    if ('message' in gathered) return gatherMessage(gathered);
    read = gathered;
  }
  const { files, fullPaths } = read;

  // 2. The dialect: the one the user chose already (the import guide's card), else a pick
  //    with the one chosen before (Change Options…), else the one the scripts look like, first.
  let dialect: SqlDialect;
  if (preset.dialect && preset.dialectChosen) {
    dialect = preset.dialect;
  } else {
    const detected = detectSqlDialect(files.map((f) => f.text).join('\n'));
    const first = preset.dialect ?? detected;
    const ordered = first ? [first, ...SQL_DIALECTS.filter((d) => d !== first)] : [...SQL_DIALECTS];
    const choice = await ui.pickDialect(
      ordered.map((d) => ({
        label: SQL_DIALECT_LABELS[d],
        ...(d === detected ? { description: 'detected' } : d === preset.dialect ? { description: 'read as this before' } : {}),
        dialect: d,
      })),
      { title: TITLE, placeHolder: `Which SQL dialect ${files.length === 1 ? 'is the script' : 'are the scripts'} written in?`, ignoreFocusOut: true },
    );
    if (!choice) return cancelled();
    dialect = choice.dialect;
  }
  telemetry.feature(SQL_DIALECT_FEATURES[dialect]);

  // 3. Convert, with the importer loaded only now.
  const engine = loadEngine(deps, ours);
  if (!engine) return undefined;
  let result: ReturnType<SqlImportModule['sqlDdlToDbml']>;
  try {
    result = engine.sqlDdlToDbml({ files, dialect });
  } catch (err) {
    return ours('while converting the SQL', err);
  }
  if (!result.ok) {
    invalid();
    const firstProblem = result.problems.find((p) => p.file && fullPaths.has(p.file));
    const actions: Record<string, () => unknown> = {};
    if (firstProblem) actions[OPEN_FILE_BUTTON] = () => ui.openFileAt(fullPaths.get(firstProblem.file)!, firstProblem.line);
    actions[TRY_ANOTHER_DIALECT_BUTTON] = () => importSqlDdl(deps, read);
    showError(describeImportProblems(TITLE, result.problems, `They were read as ${SQL_DIALECT_LABELS[dialect]}.`), actions);
    return undefined;
  }

  // 4. Import DBML's flow, with the converted DBML as its file.
  return importConvertedSql(deps, read, dialect, result, {
    ...(preset.layer ? { preferredLayer: preset.layer } : {}),
    ...(preset.name ? { name: preset.name } : {}),
  });
}

/** Step 4 of both paths: the converted DBML through Import DBML's own flow (layer, name, dry run, write, open). */
function importConvertedSql(
  deps: ImportSqlDdlDeps,
  read: SqlResume,
  dialect: SqlDialect,
  result: Extract<ReturnType<SqlImportModule['sqlDdlToDbml']>, { ok: true }>,
  resume: { quick?: boolean; preferredLayer?: string; name?: string },
  changeOptions?: (chosen: { layer: string; name: string }) => unknown,
): Promise<ImportDbmlResult | undefined> {
  for (const line of [...result.skipped, ...result.notes]) log.info(`[ERD Studio] ${TITLE}: ${line}`);
  const dialectLabel = SQL_DIALECT_LABELS[dialect];
  // The name Import DBML suggests for the diagram: not `database` for a database/ folder.
  // The quick path names it after the tables' common schema first, else the folder.
  const stem = resume.quick ? 'import.dbml' : read.fileName;
  const filePath = path.join(deps.workspaceRoot, sqlImportFileName(stem, result.dbml, deps.workspaceRoot));
  const { extensionPath: _extensionPath, sqlUi: _sqlUi, loadSqlImport: _load, ui: importUi, ...rest } = deps;
  return importDbml({
    ...rest,
    ui: suppliedDbmlUi(importUi ?? vscodeImportDbmlUi(), filePath, result.dbml),
    source: 'sql',
    origin: {
      from: sqlOriginPhrase(read.files.length, dialectLabel),
      description: `Imported from ${read.sourceLabel} (${dialectLabel}).`,
      notes: result.notes,
      skipped: result.skipped,
    },
    ...(changeOptions ? { changeOptions } : {}),
  }, { filePath, ...resume });
}

/**
 * Every `.sql` file under `root` whose start holds a CREATE TABLE with a
 * column list — and, when there is one, every file that adds keys to tables
 * (ALTER TABLE … FOREIGN KEY, a pg_dump-style constraints file: its
 * relationships belong to the same tables) — by Import…'s own bounded walk
 * (its ignored folders and dot-folders, the ERD Studio folder, at most
 * {@link MAX_SQL_FILES} `.sql` files listed). Queries, seeds and the like
 * are not taken. `truncated`: more `.sql` files than that, so "every one"
 * cannot be promised.
 */
export async function findSqlDdlScripts(
  root: string,
  semanticDir: string,
  ui: Pick<ImportSqlDdlUi, 'readDirectory' | 'readFile' | 'readFileStart'>,
): Promise<{ files: string[]; truncated: boolean }> {
  const walk = await walkFiles(root, (f) => ui.readDirectory(f), { include: (n) => /\.sql$/i.test(n), limit: MAX_SQL_FILES });
  if (walk.truncated) return { files: [], truncated: true };
  const own = path.join(root, semanticDir) + path.sep;
  const files: string[] = [];
  let tables = false;
  for (const file of walk.files) {
    if (path.normalize(file).startsWith(own)) continue;
    const start = await (ui.readFileStart
      ? ui.readFileStart(file, QUICK_SQL_SNIFF_CHARS)
      : ui.readFile(file).then((t) => t.slice(0, QUICK_SQL_SNIFF_CHARS))).catch(() => '');
    const ddl = looksLikeSqlDdl(start);
    tables ||= ddl;
    if (ddl || looksLikeSqlKeys(start)) files.push(file);
  }
  return { files: tables ? files : [], truncated: false };
}

/**
 * The quick path: the found scripts, the dialect they read as, Import DBML's
 * quick layer and name, one confirm. Nothing found to take (no CREATE TABLE
 * script, or more `.sql` files than the walk lists): the step-by-step flow.
 */
export async function quickImportSqlDdl(deps: ImportSqlDdlDeps): Promise<ImportDbmlResult | undefined> {
  const ui = sqlUiOf(deps);
  const quiet = deps.draft?.quiet === true;
  const { ours, gatherMessage } = sqlRun(ui, quiet);
  const found = await findSqlDdlScripts(deps.workspaceRoot, deps.semanticDir, ui).catch(() => ({ files: [] as string[], truncated: false }));
  if (found.files.length === 0) {
    // The automatic draft never asks: nothing to take is the end of it.
    if (quiet) {
      log.info(`[ERD Studio] ${TITLE}: no CREATE TABLE script to draft (automatic draft dropped).`);
      return undefined;
    }
    log.info(`[ERD Studio] ${TITLE}: ${found.truncated ? `more than ${MAX_SQL_FILES} .sql files in the folder` : 'no CREATE TABLE script found'}; asking which files.`);
    telemetry.feature('quickImportFellBack');
    return importSqlDdl(deps);
  }
  const gathered = await gatherSqlFiles({ files: found.files, root: deps.workspaceRoot }, ui);
  if ('message' in gathered) return gatherMessage(gathered);

  // The dialect: the detected one, else the most likely in turn; the first that reads every file.
  const text = gathered.files.map((f) => f.text).join('\n');
  const detected = detectSqlDialect(text);
  const order = detected ? [detected, ...rankSqlDialects(text).filter((d) => d !== detected)] : rankSqlDialects(text);
  const engine = loadEngine(deps, ours);
  if (!engine) return undefined;
  let converted: { dialect: SqlDialect; result: Extract<ReturnType<SqlImportModule['sqlDdlToDbml']>, { ok: true }> } | undefined;
  for (const dialect of order) {
    let result: ReturnType<SqlImportModule['sqlDdlToDbml']>;
    try {
      result = engine.sqlDdlToDbml({ files: gathered.files, dialect });
    } catch (err) {
      return ours('while converting the SQL', err);
    }
    if (result.ok) { converted = { dialect, result }; break; }
  }
  // No dialect reads every file: ask which (the step-by-step flow's dialect step, which reports the problems).
  if (!converted) {
    if (quiet) {
      log.info(`[ERD Studio] ${TITLE}: the scripts read as no one dialect (automatic draft dropped).`);
      return undefined;
    }
    return importSqlDdl(deps, gathered);
  }
  telemetry.feature(SQL_DIALECT_FEATURES[converted.dialect]);
  const chosenDialect = converted.dialect;
  return importConvertedSql(deps, gathered, chosenDialect, converted.result, { quick: true },
    ({ layer, name }) => changeSqlOptions(deps, found.files, { dialect: chosenDialect, layer, name }));
}

/**
 * Change Options…: the step-by-step flow with the quick path's answers
 * preselected — the found scripts (all picked; "Other files or a folder…"
 * opens the dialog), the dialect it read them as first, then the layer and
 * name it chose first.
 */
export async function changeSqlOptions(quickDeps: ImportSqlDdlDeps, found: readonly string[], preset: SqlPreset): Promise<ImportDbmlResult | undefined> {
  // The step-by-step flow the user asked for: never quiet, ending in a draft (`changeOptions`).
  const deps: ImportSqlDdlDeps = { ...quickDeps, ...changeOptionsDraft(quickDeps.draft) };
  const ui = sqlUiOf(deps);
  const { cancelled, gatherMessage } = sqlRun(ui);
  if (!ui.pickFiles) return importSqlDdl(deps, undefined, preset);
  const rel = (file: string): string => path.relative(deps.workspaceRoot, file).split(path.sep).join('/');
  const picked = await ui.pickFiles(
    [
      { label: OTHER_SQL_FILES_ITEM, alwaysShow: true },
      ...found.map((file): SqlFileItem => ({ label: rel(file), picked: true, filePath: file })),
    ],
    { title: TITLE, placeHolder: 'Which scripts? Every CREATE TABLE script found in this folder is picked.', canPickMany: true, ignoreFocusOut: true },
  );
  if (!picked || picked.length === 0) return cancelled();
  if (picked.some((item) => item.filePath === undefined)) return importSqlDdl(deps, undefined, preset);
  const gathered = await gatherSqlFiles({ files: picked.map((item) => item.filePath!), root: deps.workspaceRoot }, ui);
  if ('message' in gathered) return gatherMessage(gathered);
  return importSqlDdl(deps, gathered, preset);
}

/** The button that reads the same scripts again as another dialect. */
export const TRY_ANOTHER_DIALECT_BUTTON = 'Try Another Dialect';

/**
 * The picked files, or every `.sql` under the picked folder, read. Names are
 * the base name of a picked file, or the path under the picked folder, so a
 * problem points at one file. Or a message: nothing to read (information),
 * too many files or a file that cannot be read (an error).
 */
export async function gatherSqlFiles(
  sources: SqlSources,
  ui: Pick<ImportSqlDdlUi, 'readDirectory' | 'readFile'>,
): Promise<SqlResume | { message: string; error: boolean; invalid?: boolean }> {
  let entries: Array<{ name: string; fullPath: string }>;
  let fileName: string;
  let sourceLabel: string;
  if ('folder' in sources) {
    const folder = sources.folder;
    const folderName = path.basename(folder);
    const walk = await walkFiles(folder, (f) => ui.readDirectory(f), { include: (n) => /\.sql$/i.test(n), limit: MAX_SQL_FILES });
    if (walk.truncated) {
      return { message: `${TITLE}: ${folderName} holds more than ${MAX_SQL_FILES} .sql files. Pick a folder with fewer, or the files themselves.`, error: true };
    }
    if (walk.files.length === 0) {
      return { message: `${TITLE}: ${folderName} has no .sql files, so there is nothing to import.`, error: false, invalid: true };
    }
    entries = walk.files.map((fullPath) => ({ name: path.relative(folder, fullPath).split(path.sep).join('/'), fullPath }));
    fileName = convertedFileName(walk.files, folder);
    sourceLabel = entries.length === 1 ? entries[0].name : `${entries.length} SQL files in ${folderName}`;
  } else if (sources.root !== undefined) {
    // Found under the open folder (the quick path): each named by its path under it.
    const root = sources.root;
    const rootName = path.basename(root);
    entries = [...sources.files]
      .map((fullPath) => ({ name: path.relative(root, fullPath).split(path.sep).join('/'), fullPath }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    if (entries.length === 0) return { message: `${TITLE}: no files were picked.`, error: false };
    fileName = convertedFileName(sources.files, root);
    sourceLabel = entries.length === 1 ? entries[0].name : `${entries.length} SQL files in ${rootName}`;
  } else {
    const sorted = [...sources.files].sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'en', { numeric: true }));
    const taken = new Set<string>();
    entries = sorted.map((fullPath) => {
      // Two picked files with one name (not possible in one dialog, but cheap to rule out) keep their folder.
      let name = path.basename(fullPath);
      if (taken.has(name)) name = fullPath.split(path.sep).join('/');
      taken.add(name);
      return { name, fullPath };
    });
    if (entries.length === 0) return { message: `${TITLE}: no files were picked.`, error: false };
    fileName = convertedFileName(sorted);
    sourceLabel = entries.length === 1 ? entries[0].name : `${entries.length} SQL files`;
  }

  const files: SqlDdlFile[] = [];
  const fullPaths = new Map<string, string>();
  let chars = 0;
  for (const entry of entries) {
    let text: string;
    try {
      text = await ui.readFile(entry.fullPath);
    } catch (err) {
      log.error(`[ERD Studio] ${TITLE}: could not read a file:`, err);
      return { message: `${TITLE} couldn't read ${entry.name}. Check that the file still exists and that you can open it, then try again.`, error: true };
    }
    chars += text.length;
    if (chars > MAX_SQL_CHARS) {
      return { message: `${TITLE}: the scripts hold more than ${Math.round(MAX_SQL_CHARS / 1024 / 1024)} MB of SQL. Import the table definitions on their own.`, error: true };
    }
    files.push({ name: entry.name, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text });
    fullPaths.set(entry.name, entry.fullPath);
  }
  return { files, fullPaths, fileName, sourceLabel };
}

/** The real UI. */
export function vscodeImportSqlDdlUi(): ImportSqlDdlUi {
  return {
    pickSources: async (defaultFolder) => {
      const defaultUri = defaultFolder ? { defaultUri: vscode.Uri.file(defaultFolder) } : {};
      // One dialog takes files and folders on macOS only; elsewhere, ask which first.
      let folders = false;
      let files = true;
      if (process.platform !== 'darwin') {
        const kind = await vscode.window.showQuickPick(
          [
            { label: '$(file) SQL files…', detail: 'Pick one or more .sql files', folders: false },
            { label: '$(folder) A folder of SQL files…', detail: 'Every .sql file under the folder is read', folders: true },
          ],
          { title: TITLE, placeHolder: 'Import from files or from a folder?' },
        );
        if (!kind) return undefined;
        folders = kind.folders;
        files = !kind.folders;
      } else {
        folders = true;
      }
      const picked = await vscode.window.showOpenDialog({
        title: TITLE,
        openLabel: 'Import',
        canSelectFiles: files,
        canSelectFolders: folders,
        canSelectMany: files,
        ...(files ? { filters: { SQL: ['sql'] } } : {}),
        ...defaultUri,
      });
      if (!picked || picked.length === 0) return undefined;
      if (picked.length === 1 && folders) {
        try {
          const stat = await vscode.workspace.fs.stat(picked[0]);
          if (stat.type & vscode.FileType.Directory) return { folder: picked[0].fsPath };
        } catch { /* read as a file below; its read reports the problem */ }
      }
      return { files: picked.map((u) => u.fsPath) };
    },
    readDirectory: async (folder) =>
      (await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)))
        .map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0] as const),
    readFile: async (filePath) => new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    pickDialect: async (items, options) => vscode.window.showQuickPick([...items], options),
    pickFiles: async (items, options) => vscode.window.showQuickPick([...items], { ...options, canPickMany: true }),
    readFileStart: async (filePath, chars) => {
      const bytes = await readFileStart(filePath, chars * 4);
      return new TextDecoder('utf-8').decode(bytes).slice(0, chars);
    },
    showInformationMessage: async (message) => vscode.window.showInformationMessage(message),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
  };
}
