/**
 * **Import…** (`erdStudio.importModel`) — the start screen's Import: which
 * source to start a data model from, then that source's own command:
 *
 * - **DBML file** → `erdStudio.importDbml`
 * - **SQL DDL scripts** → `erdStudio.importSqlDdl`
 * - **Power BI or Fabric semantic model** → `erdStudio.importSemanticModel`
 *
 * The source the open folder most likely holds comes first, when a quick,
 * bounded look finds one (a `.bim` / `definition.pbism` / TMDL file, a `.sql` file with
 * a CREATE TABLE, a `.dbml` file outside the ERD Studio folder that is not its
 * own export); otherwise
 * DBML leads. The look never delays the picker by more than
 * {@link DETECT_TIMEOUT_MS}. The source runs as a command, so the
 * walkthrough's `onCommand:` completion events see it.
 *
 * Not pre-registered: an empty window gets the usual open-a-folder stub.
 */

import * as vscode from 'vscode';

import {
  MAX_SQL_FILE_BYTES,
  isOwnDbmlExport,
  listImportFiles,
  orderImportSources,
  rankSqlFiles,
  sqlScriptTableCount,
  type DirEntries,
  type ImportModelSource,
} from '../services/importSources';
import { log } from '../services/logger';
import { fileSize, readFileStart, readTextStart } from '../services/readFileStart';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';
import { IMPORT_DBML_COMMAND } from './importDbml';
import { IMPORT_SEMANTIC_MODEL_COMMAND } from './importSemanticModel';
import { IMPORT_SQL_DDL_COMMAND } from './importSqlDdl';
import { IMPORT_GUIDE_COMMAND, IMPORT_GUIDE_PICK_ITEM } from '../services/importGuide';

export const IMPORT_MODEL_COMMAND = 'erdStudio.importModel';

/** How long the picker waits for the look at the folder before showing the fixed order. */
export const DETECT_TIMEOUT_MS = 800;
/** At most this many `.sql` files are opened to look for a CREATE TABLE. */
export const DETECT_SQL_FILES = 20;
/** Only the start of each is read. */
export const DETECT_SQL_CHARS = 64 * 1024;

/** The command each source runs. */
export const IMPORT_SOURCE_COMMANDS: Readonly<Record<ImportModelSource, string>> = {
  dbml: IMPORT_DBML_COMMAND,
  sqlDdl: IMPORT_SQL_DDL_COMMAND,
  semanticModel: IMPORT_SEMANTIC_MODEL_COMMAND,
};

/** The funnel key for each pick. */
export const IMPORT_PICK_FEATURES: Readonly<Record<ImportModelSource, TelemetryFeature>> = {
  dbml: 'importPickDbml',
  sqlDdl: 'importPickSqlDdl',
  semanticModel: 'importPickSemanticModel',
};

/** What the picker shows for each source. */
export const IMPORT_SOURCE_ITEMS: Readonly<Record<ImportModelSource, { label: string; detail: string }>> = {
  dbml: { label: '$(file-code) DBML file', detail: 'A .dbml file from dbdiagram.io or any DBML tool (an open format)' },
  sqlDdl: { label: '$(database) SQL DDL scripts', detail: 'CREATE TABLE .sql files: PostgreSQL, MySQL, SQL Server, Snowflake or Databricks' },
  semanticModel: { label: '$(graph) Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder, saved as TMDL or as model.bim' },
};

/** The description of a source the folder seems to hold. */
export const FOUND_HERE = 'found in this folder';

export interface ImportSourceItem extends vscode.QuickPickItem {
  source: ImportModelSource;
}

/** The picker's last item: the import guide, for a model that is not a file yet (`importGuideFromPicker`). */
export interface ImportGuideItem extends vscode.QuickPickItem {
  guide: true;
}
export const IMPORT_GUIDE_ITEM: ImportGuideItem = { ...IMPORT_GUIDE_PICK_ITEM, guide: true };

export interface ImportModelDeps {
  /** Which sources the open folder seems to hold. */
  detect(): Promise<ReadonlySet<ImportModelSource>>;
  pick(items: ReadonlyArray<ImportSourceItem | ImportGuideItem>, options: vscode.QuickPickOptions): Thenable<ImportSourceItem | ImportGuideItem | undefined>;
  executeCommand(command: string, ...args: unknown[]): Thenable<unknown>;
  /** Default {@link DETECT_TIMEOUT_MS}. */
  detectTimeoutMs?: number;
}

/** The picker's items: found sources first (marked), then the rest. */
export function importSourceItems(found: ReadonlySet<ImportModelSource>): ImportSourceItem[] {
  return orderImportSources(found).map((source) => ({
    ...IMPORT_SOURCE_ITEMS[source],
    ...(found.has(source) ? { description: FOUND_HERE } : {}),
    source,
  }));
}

/**
 * Run Import…: show the sources (then the import guide, last), count the
 * pick (or the close) and run the picked one. The guide counts itself
 * (`importGuideFromPicker`), not as an import source.
 */
export async function runImportModel(deps: ImportModelDeps): Promise<void> {
  const found = await withTimeout(deps.detect(), deps.detectTimeoutMs ?? DETECT_TIMEOUT_MS, new Set<ImportModelSource>());
  const choice = await deps.pick([...importSourceItems(found), IMPORT_GUIDE_ITEM], {
    title: 'Import',
    placeHolder: 'What would you like to start your data model from?',
  });
  if (!choice) {
    telemetry.feature('importPickCancelled');
    return;
  }
  if ('guide' in choice) {
    await deps.executeCommand(IMPORT_GUIDE_COMMAND, { from: 'picker' });
    return;
  }
  telemetry.feature(IMPORT_PICK_FEATURES[choice.source]);
  await deps.executeCommand(IMPORT_SOURCE_COMMANDS[choice.source]);
}

/** `promise`, or `fallback` once `ms` pass (or when it rejects). */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The file lookups {@link detectImportSources} makes, injectable for tests. */
export interface DetectImportIo {
  /** The open folder the look lists. */
  root: string;
  /** One folder's entries (`workspace.fs.readDirectory`): a name and whether it is a folder. */
  readDirectory(folder: string): Promise<DirEntries>;
  /** The start of a file's text (decoded by its byte order mark). */
  readStart(filePath: string, chars: number): Promise<string>;
  /** A file's size in bytes; absent or undefined: unknown. */
  size?(filePath: string): Promise<number | undefined>;
  /** The look was cancelled: stop listing and opening files. Absent: never. */
  cancelled?(): boolean;
}

/** A file every semantic model Import Semantic Model… can read holds (`findSemanticModels`). */
export const SEMANTIC_MODEL_GLOB = '**/{*.bim,definition.pbism,model.tmdl,database.tmdl}';

export { readFileStart };

/** Folders the DBML file search skips: tools', a dbt project's build output and ERD Studio's own. */
export function detectExcludeGlob(semanticDir: string): string {
  const own = semanticDir.replace(/[\\/]+$/, '');
  return `**/{node_modules,.git,.venv,venv,target,dbt_packages,${own}}/**`;
}

/** What the look at the folder found, and, when it could tell exactly, how many CREATE TABLEs its `.sql` files hold. */
export interface ImportFindings {
  sources: Set<ImportModelSource>;
  /**
   * The CREATE TABLE statements (with a column list) in the `.sql` files,
   * only when every `.sql` file in the folder was read whole: at most
   * {@link DETECT_SQL_FILES} files, each shorter than {@link DETECT_SQL_CHARS}.
   * Otherwise absent (never a guess). It stays on this machine.
   */
  sqlTables?: number;
  /** The folder holds a `dbt_project.yml` (the host notes it when the window runs without dbt). */
  dbtProject?: boolean;
}

/** How many `.dbml` files the look opens to find one that is not ERD Studio's own export. */
const DETECT_DBML_FILES = 5;

/**
 * Which sources the open folder seems to hold, from one listing of it
 * (`listImportFiles`, the quick imports' own) and bounded reads: a semantic
 * model file; a `.dbml` file that is not ERD Studio's own export (a copy of
 * a diagram, not a model to bring in); and the first
 * {@link DETECT_SQL_FILES} `.sql` files, names that usually hold table
 * definitions first (`rankSqlFiles`), whose start holds a CREATE TABLE with a
 * column list by the converter's own reading (`sqlScriptTableCount`: never a
 * dbt macro, a Databricks notebook, Oracle DDL or a file larger than the
 * import reads). A lookup that fails counts as nothing found. With
 * `countTables` (the start screen's look, which the start suggestion names a
 * count from) every one of those `.sql` files is read, not only up to the
 * first with a CREATE TABLE.
 */
export async function detectImportFindings(
  io: DetectImportIo,
  semanticDir: string,
  options: { countTables?: boolean } = {},
): Promise<ImportFindings> {
  const found = new Set<ImportModelSource>();
  const listing = await listImportFiles(io.root, (f) => io.readDirectory(f), { semanticDir, cancelled: io.cancelled })
    .catch(() => ({ sql: [], dbml: [], semanticModel: [], dbtProject: false, truncated: false }));
  // No `*.pbip`: a report-only (thin) Power BI Project has one and no model,
  // and every model Import Semantic Model… reads has one of these files.
  if (listing.semanticModel.length > 0) found.add('semanticModel');
  for (const file of listing.dbml.slice(0, DETECT_DBML_FILES)) {
    if (io.cancelled?.()) break;
    const head = await io.readStart(file, 512).catch(() => undefined);
    if (head !== undefined && !isOwnDbmlExport(head)) { found.add('dbml'); break; }
  }
  const sqlFiles = rankSqlFiles(listing.sql, io.root).slice(0, DETECT_SQL_FILES);
  // The count is exact only when every .sql file was listed and read whole.
  let exact = options.countTables === true && !listing.truncated && listing.sql.length <= DETECT_SQL_FILES;
  let tables = 0;
  for (const file of sqlFiles) {
    if (io.cancelled?.()) { exact = false; break; }
    const size = await io.size?.(file).catch(() => undefined);
    if (size !== undefined && size > MAX_SQL_FILE_BYTES) { exact = false; continue; }
    const text = await io.readStart(file, DETECT_SQL_CHARS).catch(() => undefined);
    if (text === undefined || text.length >= DETECT_SQL_CHARS) exact = false;
    const count = text === undefined ? 0 : sqlScriptTableCount(file, text);
    if (count > 0) {
      found.add('sqlDdl');
      if (!options.countTables) break;
      tables += count;
    }
  }
  return {
    sources: found,
    ...(exact && found.has('sqlDdl') && tables > 0 ? { sqlTables: tables } : {}),
    ...(listing.dbtProject ? { dbtProject: true } : {}),
  };
}

/** {@link detectImportFindings}' sources: Import…'s picker order. */
export async function detectImportSources(io: DetectImportIo, semanticDir: string): Promise<Set<ImportModelSource>> {
  return (await detectImportFindings(io, semanticDir)).sources;
}

/** The real lookups, under `root`; `token` stops the listing and the reads. */
export function vscodeDetectImportIo(root: string, token?: vscode.CancellationToken): DetectImportIo {
  return {
    root,
    readDirectory: async (folder) =>
      (await vscode.workspace.fs.readDirectory(vscode.Uri.file(folder)))
        .map(([name, type]) => [name, (type & vscode.FileType.Directory) !== 0] as const),
    readStart: (filePath, chars) => readTextStart(filePath, chars),
    size: (filePath) => fileSize(filePath),
    cancelled: () => token?.isCancellationRequested === true,
  };
}

/**
 * The first file matching `glob` in the open folder, by the look's own rules
 * (never under a tool's folder or the ERD Studio folder), or undefined after
 * `timeoutMs`: Import DBML…'s Open dialog starts on the DBML file the start
 * screen found (`ImportDbmlDeps.findDefaultFile`).
 */
export async function vscodeFindFirstFile(root: string, semanticDir: string, glob: string, timeoutMs = DETECT_TIMEOUT_MS): Promise<string | undefined> {
  const source = new vscode.CancellationTokenSource();
  try {
    const found = Promise.resolve(vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file(root), glob), detectExcludeGlob(semanticDir), 1, source.token,
    )).then((files) => files[0]?.fsPath);
    return await withTimeout(found, timeoutMs, undefined);
  } catch (err) {
    log.warn('[ERD Studio] Import: could not look for a file to suggest:', err);
    return undefined;
  } finally {
    source.cancel();
    source.dispose();
  }
}

/**
 * The start screen's look at the folder (`StartIntentTracker`): the same
 * detector as Import…'s picker, counting CREATE TABLEs for the start
 * suggestion, cancelled when `signal` aborts. Reads only; what it finds
 * never leaves the machine.
 */
export function vscodeStartLook(root: string, semanticDir: string): (signal: AbortSignal) => Promise<ImportFindings> {
  return async (signal) => {
    const source = new vscode.CancellationTokenSource();
    const abort = (): void => source.cancel();
    signal.addEventListener('abort', abort);
    try {
      if (signal.aborted) return { sources: new Set() };
      return await detectImportFindings(vscodeDetectImportIo(root, source.token), semanticDir, { countTables: true });
    } catch (err) {
      log.warn('[ERD Studio] Start screen: could not look for import sources:', err);
      return { sources: new Set() };
    } finally {
      signal.removeEventListener('abort', abort);
      source.dispose();
    }
  };
}

/** The real Import… deps for a folder. */
export function vscodeImportModelDeps(root: string, semanticDir: string): ImportModelDeps {
  return {
    detect: () => detectImportSources(vscodeDetectImportIo(root), semanticDir).catch((err: unknown) => {
      log.warn('[ERD Studio] Import: could not look for import sources:', err);
      return new Set<ImportModelSource>();
    }),
    pick: (items, options) => vscode.window.showQuickPick([...items], options),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  };
}
