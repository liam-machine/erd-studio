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
  type SqlDdlFile,
  type SqlDialect,
} from '../services/sqlDdlImport';
import { loadSqlImport, type SqlImportModule } from '../services/sqlImportLoader';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';
import {
  IMPORT_TITLES,
  importDbml,
  suppliedDbmlUi,
  vscodeImportDbmlUi,
  type ImportDbmlDeps,
  type ImportDbmlResult,
  type ImportDbmlUi,
} from './importDbml';
import { openTableFileAt } from './openModelFile';

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

/** What the user picked: some `.sql` files, or a folder of them. */
export type SqlSources = { files: string[] } | { folder: string };

/** Every vscode call the SQL half of the flow makes, injectable for tests. */
export interface ImportSqlDdlUi {
  /** `.sql` files or a folder; undefined when cancelled. */
  pickSources(defaultFolder: string | undefined): Promise<SqlSources | undefined>;
  /** One folder's entries (`workspace.fs.readDirectory`). */
  readDirectory(folder: string): Promise<DirEntries>;
  /** A file's text (`workspace.fs`). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  pickDialect(items: readonly SqlDialectItem[], options: vscode.QuickPickOptions): Promise<SqlDialectItem | undefined>;
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
interface SqlResume {
  files: SqlDdlFile[];
  /** Full path of each file, by its shown name (for Open File). */
  fullPaths: ReadonlyMap<string, string>;
  fileName: string;
  sourceLabel: string;
}

/**
 * Run the flow. Resolves Import DBML's result once a diagram is written, or
 * undefined when the user cancels, the scripts do not read, or something
 * failed (each case has already said so).
 */
export async function importSqlDdl(deps: ImportSqlDdlDeps, resume?: SqlResume): Promise<ImportDbmlResult | undefined> {
  const ui = deps.sqlUi ?? vscodeImportSqlDdlUi();
  const cancelled = (): undefined => {
    telemetry.feature('importSqlDdlCancelled');
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

  // 1. The scripts.
  let read = resume;
  if (!read) {
    const sources = await ui.pickSources(deps.workspaceRoot || undefined);
    if (!sources) return cancelled();
    const gathered = await gatherSqlFiles(sources, ui);
    if ('message' in gathered) {
      if (gathered.invalid) telemetry.feature('importSqlDdlInvalid');
      if (gathered.error) showError(gathered.message);
      else void ui.showInformationMessage(gathered.message);
      return undefined;
    }
    read = gathered;
  }
  const { files, fullPaths } = read;

  // 2. The dialect: the one the scripts look like first.
  const detected = detectSqlDialect(files.map((f) => f.text).join('\n'));
  const ordered = detected ? [detected, ...SQL_DIALECTS.filter((d) => d !== detected)] : [...SQL_DIALECTS];
  const choice = await ui.pickDialect(
    ordered.map((dialect) => ({
      label: SQL_DIALECT_LABELS[dialect],
      ...(dialect === detected ? { description: 'detected' } : {}),
      dialect,
    })),
    { title: TITLE, placeHolder: `Which SQL dialect ${files.length === 1 ? 'is the script' : 'are the scripts'} written in?`, ignoreFocusOut: true },
  );
  if (!choice) return cancelled();
  const dialect = choice.dialect;
  telemetry.feature(SQL_DIALECT_FEATURES[dialect]);

  // 3. Convert, with the importer loaded only now.
  let engine: SqlImportModule;
  try {
    engine = deps.loadSqlImport ? deps.loadSqlImport() : loadSqlImport(deps.extensionPath);
  } catch (err) {
    return ours('while loading its SQL importer', err);
  }
  let result: ReturnType<SqlImportModule['sqlDdlToDbml']>;
  try {
    result = engine.sqlDdlToDbml({ files, dialect });
  } catch (err) {
    return ours('while converting the SQL', err);
  }
  if (!result.ok) {
    telemetry.feature('importSqlDdlInvalid');
    const first = result.problems.find((p) => p.file && fullPaths.has(p.file));
    const actions: Record<string, () => unknown> = {};
    if (first) actions[OPEN_FILE_BUTTON] = () => ui.openFileAt(fullPaths.get(first.file)!, first.line);
    actions[TRY_ANOTHER_DIALECT_BUTTON] = () => importSqlDdl(deps, read);
    showError(describeImportProblems(TITLE, result.problems, `They were read as ${SQL_DIALECT_LABELS[dialect]}.`), actions);
    return undefined;
  }
  for (const line of [...result.skipped, ...result.notes]) log.info(`[ERD Studio] ${TITLE}: ${line}`);

  // 4. Import DBML's flow, with the converted DBML as its file.
  const dialectLabel = SQL_DIALECT_LABELS[dialect];
  // The name Import DBML suggests for the diagram: not `database` for a database/ folder.
  const filePath = path.join(deps.workspaceRoot, sqlImportFileName(read.fileName, result.dbml, deps.workspaceRoot));
  const { extensionPath: _extensionPath, sqlUi: _sqlUi, loadSqlImport: _load, ui: importUi, ...rest } = deps;
  return importDbml({
    ...rest,
    ui: suppliedDbmlUi(importUi ?? vscodeImportDbmlUi(), filePath, result.dbml),
    source: 'sql',
    origin: {
      from: sqlOriginPhrase(files.length, dialectLabel),
      description: `Imported from ${read.sourceLabel} (${dialectLabel}).`,
      notes: result.notes,
      skipped: result.skipped,
    },
  }, { filePath });
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
    showInformationMessage: async (message) => vscode.window.showInformationMessage(message),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
  };
}
