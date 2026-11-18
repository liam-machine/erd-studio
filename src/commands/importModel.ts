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
 * The folder is gone over by the window's one shared look
 * (`src/services/folderLook.ts`, #347: git's index first, then one bounded
 * walk), which the start screen, the picker and the quick imports all read;
 * a caller that cannot wait for the whole of it takes what it has so far.
 *
 * Not pre-registered: an empty window gets the usual open-a-folder stub.
 */

import * as vscode from 'vscode';

import type { FolderLookRun, FolderLooks } from '../services/folderLook';
import { nodeReadDirEntries } from '../services/folderScan';
import {
  MAX_SQL_FILE_BYTES,
  isOwnDbmlExport,
  listImportFiles,
  orderImportSources,
  rankSqlFiles,
  sqlScriptTableCount,
  type DirEntries,
  type ImportListing,
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
/**
 * How long the picker and Import DBML…'s default file wait for the whole of
 * the shared look before going by what it has found so far (the reads that
 * follow fit in the rest of {@link DETECT_TIMEOUT_MS}).
 */
export const DETECT_LISTING_MS = 500;
/** A look this recent is good enough for a quick import (it takes the files the folder holds now). */
export const QUICK_IMPORT_LOOK_AGE_MS = 5000;
/** While the start screen's look walks, what it has found so far is read at most this often at first… */
const EARLY_LOOK_EVERY_MS = 250;
/** …and, after passes that found nothing, no more often than this. */
const EARLY_LOOK_SLOWEST_MS = 4000;
/** How many files' starts one look keeps (it reads the same few again as the listing grows). */
const EARLY_LOOK_STARTS_KEPT = 64;
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
  sqlDdl: { label: '$(database) SQL DDL scripts', detail: 'CREATE TABLE .sql files (PostgreSQL, MySQL, SQL Server, Snowflake, Databricks, Oracle, BigQuery, Redshift, SQLite), or a catalog export (.csv)' },
  semanticModel: { label: '$(graph) Power BI or Fabric semantic model', detail: 'A <Name>.SemanticModel folder (TMDL or model.bim), or a Tabular Editor Save to Folder model' },
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
  /** One folder's entries: a name and whether it is a folder. */
  readDirectory(folder: string): Promise<DirEntries>;
  /**
   * The folder's import files, already listed (the window's shared look).
   * Absent: they are listed here, with `readDirectory` (`listImportFiles`).
   */
  listing?(): Promise<ImportListing>;
  /** The start of a file's text (decoded by its byte order mark). */
  readStart(filePath: string, chars: number): Promise<string>;
  /** A file's size in bytes; absent or undefined: unknown. */
  size?(filePath: string): Promise<number | undefined>;
  /** The look was cancelled: stop listing and opening files. Absent: never. */
  cancelled?(): boolean;
}

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
 * dbt macro, a Databricks notebook or a file larger than the
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
  const listing = await importListingOf(io, semanticDir)
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

/**
 * The `.dbml` file the look counted (§13.2: one listing for the look and the
 * quick import): the first of the listing's first {@link DETECT_DBML_FILES}
 * that is not ERD Studio's own export, or undefined. Import DBML…'s quick
 * path drafts this one, and its Open dialog starts on it.
 */
export async function findImportDbmlFile(io: DetectImportIo, semanticDir: string): Promise<string | undefined> {
  const listing = await importListingOf(io, semanticDir).catch(() => undefined);
  for (const file of listing?.dbml.slice(0, DETECT_DBML_FILES) ?? []) {
    if (io.cancelled?.()) return undefined;
    const head = await io.readStart(file, 512).catch(() => undefined);
    if (head !== undefined && !isOwnDbmlExport(head)) return file;
  }
  return undefined;
}

/** The folder's import files for a look: the ones already listed for it (`io.listing`), else listed here. */
function importListingOf(io: DetectImportIo, semanticDir: string): Promise<ImportListing> {
  return io.listing ? io.listing() : listImportFiles(io.root, (f) => io.readDirectory(f), { semanticDir, cancelled: io.cancelled });
}

/**
 * {@link findImportDbmlFile} on the open folder, or undefined after
 * `timeoutMs`. With the window's `looks`, from the shared look (what it has
 * found by {@link DETECT_LISTING_MS} when it is still walking).
 */
export async function vscodeFindImportDbmlFile(
  root: string,
  semanticDir: string,
  timeoutMs = DETECT_TIMEOUT_MS,
  looks?: FolderLooks,
): Promise<string | undefined> {
  const source = new vscode.CancellationTokenSource();
  try {
    const io = vscodeDetectImportIo(root, source.token, looks ? soonListing(looks.run(root)) : undefined);
    return await withTimeout(findImportDbmlFile(io, semanticDir), timeoutMs, undefined);
  } catch (err) {
    log.warn('[ERD Studio] Import: could not look for a DBML file to suggest:', err);
    return undefined;
  } finally {
    source.cancel();
    source.dispose();
  }
}

/** {@link detectImportFindings}' sources: Import…'s picker order. */
export async function detectImportSources(io: DetectImportIo, semanticDir: string): Promise<Set<ImportModelSource>> {
  return (await detectImportFindings(io, semanticDir)).sources;
}

/**
 * The real lookups, under `root`; `token` stops the listing and the reads.
 * Folders are listed with Node, not `vscode.workspace.fs` (which waits on a
 * round trip to VS Code's window for every listing, #347). `listing`: the
 * folder's import files, already listed by the window's shared look.
 */
export function vscodeDetectImportIo(root: string, token?: vscode.CancellationToken, listing?: () => Promise<ImportListing>): DetectImportIo {
  return {
    root,
    readDirectory: (folder) => nodeReadDirEntries(folder),
    readStart: (filePath, chars) => readTextStart(filePath, chars),
    size: (filePath) => fileSize(filePath),
    cancelled: () => token?.isCancellationRequested === true,
    ...(listing ? { listing } : {}),
  };
}

/**
 * A shared look's listing for a caller with little time: the whole of it
 * when the walk is over within {@link DETECT_LISTING_MS}, else what it has
 * found so far (with the index's files for the folders it has not reached).
 */
function soonListing(run: FolderLookRun, waitMs = DETECT_LISTING_MS): () => Promise<ImportListing> {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run.listing(),
        new Promise<ImportListing>((resolve) => { timer = setTimeout(() => resolve(run.listingSoFar()), waitMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

/** What the start screen's look counts (fixed keys, never what it found). */
export interface StartLookHooks {
  feature?(key: TelemetryFeature): void;
}

/**
 * The start screen's look at the folder (`StartIntentTracker`), on the
 * window's shared look: the same detector as Import…'s picker, counting
 * CREATE TABLEs for the start suggestion. It answers `early` as soon as it
 * has found something: from git's index (tracked files, one file read) or as
 * the walk goes; then in full once the walk is over. `signal` stops its file
 * reads (the tracker is disposed); the shared look itself runs on for its
 * other callers. Reads only; what it finds never leaves the machine.
 */
export function folderStartLook(
  looks: FolderLooks,
  root: string,
  semanticDir: string,
  hooks: StartLookHooks = {},
): (signal: AbortSignal, early?: (findings: ImportFindings) => void) => Promise<ImportFindings> {
  return async (signal, early) => {
    if (signal.aborted) return { sources: new Set() };
    try {
      const run = looks.run(root);
      // One read of a file's start per look, however often the listing is gone over (the newest kept).
      const starts = new Map<string, Promise<string>>();
      const io = (listing: ImportListing): DetectImportIo => ({
        root,
        readDirectory: (folder) => nodeReadDirEntries(folder),
        readStart: (filePath, chars) => {
          const key = `${chars}\u0000${filePath}`;
          let start = starts.get(key);
          if (!start) {
            start = readTextStart(filePath, chars);
            starts.set(key, start);
            // A read that failed is tried again by the next pass.
            start.catch(() => { starts.delete(key); });
            if (starts.size > EARLY_LOOK_STARTS_KEPT) starts.delete(starts.keys().next().value as string);
          }
          return start;
        },
        size: (filePath) => fileSize(filePath),
        cancelled: () => signal.aborted,
        listing: async () => listing,
      });

      // What has been found so far is read a pass at a time, until a pass finds
      // something (the ask is answered from that) or the walk is over. A pass
      // runs only when the listing holds a file the last pass did not see, and
      // each fruitless pass waits twice as long for the next: a folder of
      // thousands of scripts without a CREATE TABLE costs a handful of passes.
      let over = false;
      let reading = false;
      let seen = 0;
      let every = EARLY_LOOK_EVERY_MS;
      let lastPass = Number.NEGATIVE_INFINITY;
      let waiting: ReturnType<typeof setTimeout> | undefined;
      const stopped = (): boolean => over || signal.aborted || !early;
      const pass = async (): Promise<void> => {
        if (stopped() || reading) return;
        const listing = run.listingSoFar();
        const size = listing.sql.length + listing.dbml.length + listing.semanticModel.length + (listing.dbtProject ? 1 : 0);
        if (size === seen) return;
        seen = size;
        reading = true;
        lastPass = Date.now();
        try {
          const findings = await detectImportFindings(io(listing), semanticDir);
          if (stopped()) return;
          if (findings.sources.size > 0) over = true;
          else every = Math.min(2 * every, EARLY_LOOK_SLOWEST_MS);
          if (findings.sources.size > 0 || findings.dbtProject) {
            early?.({ sources: findings.sources, ...(findings.dbtProject ? { dbtProject: true } : {}) });
          }
        } catch (err) {
          log.warn('[ERD Studio] Start screen: could not read what the folder look has found so far:', err);
        } finally {
          reading = false;
          // More may have been found while this pass read.
          soFarChanged();
        }
      };
      function soFarChanged(): void {
        if (stopped() || reading || waiting) return;
        const wait = every - (Date.now() - lastPass);
        if (wait <= 0) {
          void pass();
          return;
        }
        waiting = setTimeout(() => { waiting = undefined; void pass(); }, wait);
      }

      // The walk starts now (it never waits on the index read for long); what it finds is read as it goes.
      const stop = run.onProgress(soFarChanged);
      const whole = run.listing();
      let listing: ImportListing;
      try {
        const stage = await run.index;
        if (stage.usable) hooks.feature?.('startLookFromIndex');
        else if (stage.repository) hooks.feature?.('startLookIndexFallback');
        // Git's index has answered for the tracked files (and the dbt search may have walked already): read those now.
        soFarChanged();
        listing = await whole;
      } finally {
        // The whole answer follows: no more passes over what was found so far.
        over = true;
        stop();
        if (waiting) clearTimeout(waiting);
      }
      return await detectImportFindings(io(listing), semanticDir, { countTables: true });
    } catch (err) {
      log.warn('[ERD Studio] Start screen: could not look for import sources:', err);
      return { sources: new Set() };
    }
  };
}

/** The real Import… deps for a folder (with the window's `looks`, from the shared look). */
export function vscodeImportModelDeps(root: string, semanticDir: string, looks?: FolderLooks): ImportModelDeps {
  return {
    detect: () => detectImportSources(
      vscodeDetectImportIo(root, undefined, looks ? soonListing(looks.run(root)) : undefined),
      semanticDir,
    ).catch((err: unknown) => {
      log.warn('[ERD Studio] Import: could not look for import sources:', err);
      return new Set<ImportModelSource>();
    }),
    pick: (items, options) => vscode.window.showQuickPick([...items], options),
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  };
}
