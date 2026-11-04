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

import { promises as fsp } from 'fs';
import * as vscode from 'vscode';

import {
  looksLikeSqlDdl,
  orderImportSources,
  type ImportModelSource,
} from '../services/importSources';
import { log } from '../services/logger';
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

/**
 * The first `bytes` bytes of a file, never more: the look runs unasked (the
 * start screen), and a folder of database dumps holds files of gigabytes.
 */
export async function readFileStart(filePath: string, bytes: number): Promise<Uint8Array> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Folders the look skips: tools', a dbt project's build output and ERD Studio's own. */
export function detectExcludeGlob(semanticDir: string): string {
  const own = semanticDir.replace(/[\\/]+$/, '');
  return `**/{node_modules,.git,.venv,venv,target,dbt_packages,${own}}/**`;
}

/**
 * Which sources the open folder seems to hold, with bounded lookups: one
 * semantic-model file, one `.dbml` file, and up to {@link DETECT_SQL_FILES}
 * `.sql` files whose start holds a CREATE TABLE. A lookup that fails counts
 * as nothing found.
 */
export async function detectImportSources(io: DetectImportIo, semanticDir: string): Promise<Set<ImportModelSource>> {
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
  for (const file of sqlFiles) {
    if (io.cancelled?.()) break;
    const text = await io.readStart(file, DETECT_SQL_CHARS).catch(() => '');
    if (looksLikeSqlDdl(text)) { found.add('sqlDdl'); break; }
  }
  return found;
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
 * detector as Import…'s picker, cancelled when `signal` aborts. Reads only;
 * what it finds never leaves the machine.
 */
export function vscodeStartLook(root: string, semanticDir: string): (signal: AbortSignal) => Promise<ReadonlySet<ImportModelSource>> {
  return async (signal) => {
    const source = new vscode.CancellationTokenSource();
    const abort = (): void => source.cancel();
    signal.addEventListener('abort', abort);
    try {
      if (signal.aborted) return new Set();
      return await detectImportSources(vscodeDetectImportIo(root, source.token), semanticDir);
    } catch (err) {
      log.warn('[ERD Studio] Start screen: could not look for import sources:', err);
      return new Set();
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
