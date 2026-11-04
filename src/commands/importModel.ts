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
 * a CREATE TABLE, a `.dbml` file outside the ERD Studio folder); otherwise
 * DBML leads. The look never delays the picker by more than
 * {@link DETECT_TIMEOUT_MS}. The source runs as a command, so the
 * walkthrough's `onCommand:` completion events see it.
 *
 * Not pre-registered: an empty window gets the usual open-a-folder stub.
 */

import * as vscode from 'vscode';

import {
  countSqlCreateTables,
  looksLikeSqlDdl,
  orderImportSources,
  type ImportModelSource,
} from '../services/importSources';
import { log } from '../services/logger';
import { readFileStart } from '../services/readFileStart';
import type { TelemetryFeature } from '../services/telemetryPayload';
import { telemetry } from '../services/telemetryService';
import { IMPORT_DBML_COMMAND } from './importDbml';
import { IMPORT_SEMANTIC_MODEL_COMMAND } from './importSemanticModel';
import { IMPORT_SQL_DDL_COMMAND } from './importSqlDdl';

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

export interface ImportModelDeps {
  /** Which sources the open folder seems to hold. */
  detect(): Promise<ReadonlySet<ImportModelSource>>;
  pick(items: readonly ImportSourceItem[], options: vscode.QuickPickOptions): Thenable<ImportSourceItem | undefined>;
  executeCommand(command: string): Thenable<unknown>;
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

/** Run Import…: show the sources, count the pick (or the close) and run the picked one. */
export async function runImportModel(deps: ImportModelDeps): Promise<void> {
  const found = await withTimeout(deps.detect(), deps.detectTimeoutMs ?? DETECT_TIMEOUT_MS, new Set<ImportModelSource>());
  const choice = await deps.pick(importSourceItems(found), {
    title: 'Import',
    placeHolder: 'What would you like to start your data model from?',
  });
  if (!choice) {
    telemetry.feature('importPickCancelled');
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
  /** Up to `max` files matching `include` (a glob under the folder), none under `exclude`. */
  findFiles(include: string, exclude: string, max: number): Promise<string[]>;
  /** The start of a file's text. */
  readStart(filePath: string, chars: number): Promise<string>;
  /** The look was cancelled: stop opening files. Absent: never. */
  cancelled?(): boolean;
}

/** A file every semantic model Import Semantic Model… can read holds (`findSemanticModels`). */
export const SEMANTIC_MODEL_GLOB = '**/{*.bim,definition.pbism,model.tmdl,database.tmdl}';

export { readFileStart };

/** Folders the look skips: tools', a dbt project's build output and ERD Studio's own. */
export function detectExcludeGlob(semanticDir: string): string {
  const own = semanticDir.replace(/[\\/]+$/, '');
  return `**/{node_modules,.git,.venv,venv,target,dbt_packages,${own}}/**`;
}

/** What the look at the folder found, and, when it could tell exactly, how many CREATE TABLEs its `.sql` files hold. */
export interface ImportFindings {
  sources: Set<ImportModelSource>;
  /**
   * The CREATE TABLE statements (with a column list) in the `.sql` files,
   * only when every `.sql` file in the folder was read whole: fewer than
   * {@link DETECT_SQL_FILES} files, each shorter than {@link DETECT_SQL_CHARS}.
   * Otherwise absent (never a guess). It stays on this machine.
   */
  sqlTables?: number;
}

/**
 * Which sources the open folder seems to hold, with bounded lookups: one
 * semantic-model file, one `.dbml` file, and up to {@link DETECT_SQL_FILES}
 * `.sql` files whose start holds a CREATE TABLE. A lookup that fails counts
 * as nothing found. With `countTables` (the start screen's look, which the
 * start suggestion names a count from) every one of those `.sql` files is
 * read, not only up to the first with a CREATE TABLE.
 */
export async function detectImportFindings(
  io: DetectImportIo,
  semanticDir: string,
  options: { countTables?: boolean } = {},
): Promise<ImportFindings> {
  const exclude = detectExcludeGlob(semanticDir);
  const found = new Set<ImportModelSource>();
  const any = async (glob: string): Promise<boolean> => (await io.findFiles(glob, exclude, 1).catch(() => [])).length > 0;
  const [semanticModel, dbml, sqlFiles] = await Promise.all([
    // No `*.pbip`: a report-only (thin) Power BI Project has one and no model,
    // and every model Import Semantic Model… reads has one of these files.
    any(SEMANTIC_MODEL_GLOB),
    any('**/*.dbml'),
    io.findFiles('**/*.sql', exclude, DETECT_SQL_FILES).catch(() => [] as string[]),
  ]);
  if (semanticModel) found.add('semanticModel');
  if (dbml) found.add('dbml');
  // The count is exact only when every .sql file was listed and read whole.
  let exact = options.countTables === true && sqlFiles.length < DETECT_SQL_FILES;
  let tables = 0;
  for (const file of sqlFiles) {
    if (io.cancelled?.()) { exact = false; break; }
    const text = await io.readStart(file, DETECT_SQL_CHARS).catch(() => undefined);
    if (text === undefined || text.length >= DETECT_SQL_CHARS) exact = false;
    if (text !== undefined && looksLikeSqlDdl(text)) {
      found.add('sqlDdl');
      if (!options.countTables) break;
      tables += countSqlCreateTables(text);
    }
  }
  return { sources: found, ...(exact && found.has('sqlDdl') && tables > 0 ? { sqlTables: tables } : {}) };
}

/** {@link detectImportFindings}' sources: Import…'s picker order. */
export async function detectImportSources(io: DetectImportIo, semanticDir: string): Promise<Set<ImportModelSource>> {
  return (await detectImportFindings(io, semanticDir)).sources;
}

/** The real lookups, under `root`; `token` cancels the searches and stops the reads. */
export function vscodeDetectImportIo(root: string, token?: vscode.CancellationToken): DetectImportIo {
  return {
    findFiles: async (include, exclude, max) =>
      (await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), include), exclude, max, token)).map((u) => u.fsPath),
    readStart: async (filePath, chars) => {
      const bytes = await readFileStart(filePath, chars * 4);
      return new TextDecoder('utf-8').decode(bytes).slice(0, chars);
    },
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
    const io = vscodeDetectImportIo(root, source.token);
    const found = io.findFiles(glob, detectExcludeGlob(semanticDir), 1).then((files) => files[0]);
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
    executeCommand: (command) => vscode.commands.executeCommand(command),
  };
}
