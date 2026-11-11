/**
 * **Import SQL DDL…** (`erdStudio.importSqlDdl`) — CREATE TABLE scripts in as
 * a new diagram: PostgreSQL, MySQL / MariaDB, SQL Server / Azure SQL,
 * Snowflake, Databricks / Spark SQL, Oracle, Google BigQuery, Amazon
 * Redshift or SQLite (the last four read with the PostgreSQL grammar after
 * their own pre-steps, `sqlDdlDialects.ts`; they have no telemetry keys of
 * their own yet).
 *
 * Steps: `.sql` files, or a folder (every `.sql` under it, bounded) → read
 * them (`workspace.fs`) → the dialect (a quick pick, the detected one first)
 * → convert to DBML with the lazily loaded SQL importer (`dist/sqlImport.js`,
 * `src/services/sqlImportLoader.ts`; `@dbml/core`'s grammars never enter
 * `dist/extension.js`) → a table that does not read never stops the rest:
 * every problem goes to the log with its file and line, the draft's banner
 * says how many tables were left out and its Not imported list names them;
 * only when no table reads at all is it an error (file and line, Open File,
 * Show Logs, and Try Another Dialect when another dialect reads more) → the
 * dialect pick labels each dialect by the tables it reads (the scripts are
 * read as each first, up to {@link RANK_ALL_DIALECTS_CHARS}) → the converted
 * DBML goes through Import
 * DBML's own flow (`importDbml` with `source: 'sql'`): the user picks the
 * layer, names the diagram and confirms a dry run that says what the scripts
 * held and what was skipped (views, indexes, grants…, counted by kind).
 * When the scripts hold partitions (`PARTITION OF`, `ATTACH PARTITION`,
 * `INHERITS` children with no columns of their own), a step before the
 * layer asks whether to fold them into their parents (the default, and what
 * the quick path does) or keep each as a table.
 * Cancelling any step writes nothing.
 *
 * **A catalog export** (`.csv` / `.tsv` picked in the same dialog: a catalog
 * query's result, one row per column; `catalogCsvImport.ts`) skips the
 * dialect: it is converted on the host and goes to the same Import DBML flow
 * with `source: 'sql'` (`importCatalogExport`). A folder's walk never takes a
 * `.csv` (in a repository they are usually dbt seeds), nor does the quick path.
 *
 * **The quick path** (`quickImportSqlDdl`: the start screen's **Import your
 * SQL scripts** and the start suggestion) asks nothing it can answer: the
 * files are every `.sql` with a CREATE TABLE that the bounded walk finds in
 * the open folder, the dialect is the one that reads the most tables (the
 * detected one first, and the others only when it does not read them all as
 * written; ties go to the detected one; the pick, saying why, only when none
 * reads a table), the layer and name are Import DBML's quick defaults,
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
  MAX_SQL_FILE_BYTES,
  compareNames,
  convertedFileName,
  describeImportProblems,
  problemLabel,
  PROBLEMS_SHOWN,
  isSqlScriptTaken,
  listImportFiles,
  rankSqlFiles,
  sqlImportFileName,
  sqlOriginPhrase,
  sqlScriptTableCount,
  walkFiles,
  type DirEntries,
} from '../services/importSources';
import { getErdStudioSetting } from '../services/configService';
import { log } from '../services/logger';
import { createLedger, ledgerLogLines, type LedgerEntry } from '../services/importLedger';
import { SHOW_IMPORT_REPORT_COMMAND, SHOW_IMPORT_REPORT_LABEL } from '../services/importReport';
import { recordImportReport } from '../services/importReportStore';
import {
  SQL_DIALECTS,
  SQL_DIALECT_LABELS,
  detectSqlDialect,
  rankSqlDialectReadings,
  rankSqlDialects,
  sqlDialectReading,
  sqlDialectReadingLabel,
  timeLimitText,
  withoutSqlData,
  type SqlDdlFile,
  type SqlDdlProblem,
  type SqlDdlToDbmlResult,
  type SqlConvertProgress,
  type SqlConvertStop,
  type SqlDialect,
  type SqlDialectReading,
  type SqlStopReason,
  type SqlPartitionMode,
} from '../services/sqlDdlImport';
import {
  STOP_GRACE_MS,
  SqlConvertAbandonedError,
  SqlEngineLoadError,
  inProcessSqlConverter,
  workerSqlConverter,
  type SqlConvertControl,
  type SqlConverter,
} from '../services/sqlConverter';
import { SHOW_LOGS_BUTTON, SHOW_LOGS_COMMAND } from '../services/showLogs';
import type { SqlImportModule } from '../services/sqlImportLoader';
import { IMPORT_LIMIT_FEATURES, dropQuietly, sqlInvalidFeatures, type ImportInputLimit } from '../services/importTelemetry';
import { recordImportOutcome } from '../services/importOutcomeTelemetry';
import type { TelemetryErrorCode, TelemetryFeature } from '../services/telemetryPayload';
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
import { decodeText, fileSize, readTextStart } from '../services/readFileStart';
import {
  MAX_CATALOG_CHARS,
  catalogCsvToDbml,
  catalogFailureLedger,
  catalogImportStem,
  catalogOriginPhrase,
  isCatalogCsvName,
  type CatalogCsvResult,
} from '../services/catalogCsvImport';

export const IMPORT_SQL_DDL_COMMAND = 'erdStudio.importSqlDdl';

const TITLE = IMPORT_TITLES.sql;

/** At most this many `.sql` files from one folder. */
export const MAX_SQL_FILES = 500;
/** At most this much SQL text in one import (characters). */
export const MAX_SQL_CHARS = 20 * 1024 * 1024;

/**
 * The funnel key for the dialect a conversion ran with. Oracle, BigQuery,
 * Redshift and SQLite have none yet (a new key changes the telemetry
 * contract, the Worker first): they record only the import's own keys.
 */
export const SQL_DIALECT_FEATURES: Readonly<Partial<Record<SqlDialect, TelemetryFeature>>> = {
  postgres: 'importSqlDialectPostgres',
  mysql: 'importSqlDialectMysql',
  sqlserver: 'importSqlDialectSqlserver',
  snowflake: 'importSqlDialectSnowflake',
  databricks: 'importSqlDialectDatabricks',
};

/** The dialect quick pick's item. */
export interface SqlDialectItem extends vscode.QuickPickItem {
  dialect: SqlDialect;
  /** The dialect the scripts were detected as (and it reads at least one of their tables). */
  detected?: true;
}

/** A row of the dialect pick as shown: a dialect, or a separator heading. */
export type SqlDialectPickRow = SqlDialectItem | (vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator });

/**
 * The dialect pick as shown. A quick pick label is plain text (no bold, no colour), so the
 * detected dialect stands out the ways it can: a check icon, and, when it is the first
 * choice, a heading of its own above the others (the first item is the one Enter takes).
 */
export function dialectPickRows(items: readonly SqlDialectItem[]): SqlDialectPickRow[] {
  const shown = items.map((i): SqlDialectItem => (i.detected ? { ...i, label: `$(pass-filled) ${i.label}` } : i));
  if (!items[0]?.detected) return shown;
  const separator = (label: string): SqlDialectPickRow => ({ label, kind: vscode.QuickPickItemKind.Separator });
  return [
    separator('Detected from your SQL'),
    shown[0],
    ...(shown.length > 1 ? [separator('Other dialects'), ...shown.slice(1)] : []),
  ];
}

/** The partitions quick pick's item: fold them into their parents, or keep each as a table. */
export interface SqlPartitionItem extends vscode.QuickPickItem {
  mode: SqlPartitionMode;
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
  /** A file's text (`workspace.fs`), decoded by its byte order mark (UTF-16 from SQL Server Management Studio). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  pickDialect(items: readonly SqlDialectItem[], options: vscode.QuickPickOptions): Promise<SqlDialectItem | undefined>;
  /** Partitions found: fold them into their parents or keep each as a table. Absent: they are folded (never asked). */
  pickPartitions?(items: readonly SqlPartitionItem[], options: vscode.QuickPickOptions): Promise<SqlPartitionItem | undefined>;
  /** Change Options…: which of the found scripts (several may be picked; the found ones start picked). */
  pickFiles?(items: readonly SqlFileItem[], options: vscode.QuickPickOptions): Promise<readonly SqlFileItem[] | undefined>;
  /** The start of a file's text, at most `chars` (the quick path's look at each `.sql`). Absent: `readFile`. */
  readFileStart?(filePath: string, chars: number): Promise<string>;
  /** A file's size in bytes (undefined: unknown). Absent: never checked before reading. */
  fileSize?(filePath: string): Promise<number | undefined>;
  /** Resolves the button picked (when `items` are given); the flow never awaits it. */
  showInformationMessage(message: string, ...items: string[]): Promise<unknown>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  openFileAt(filePath: string, line?: number): Promise<void>;
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
  /** Opens the ERD Studio output channel (`erdStudio.showLogs`). Absent: no Show Logs button. */
  showLogs?(): Promise<void>;
  /**
   * Runs `task` under a progress notification with a Cancel button (shown
   * only once the task runs longer than a moment); Cancel aborts `signal`.
   * Absent (tests, the automatic draft): no notification, never cancelled.
   */
  withProgress?<T>(title: string, task: (progress: SqlProgressReporter, signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Opens the Settings editor at one setting. Absent: no Open Settings button. */
  openSettings?(setting: string): Promise<void>;
  /** Runs Show Import Report (`erdStudio.showImportReport`) for import `reportId`. Absent: no such button. */
  showImportReport?(reportId?: number): Promise<void>;
}

/** What a reading reports to the progress notification: a line, and how far it is (0 to 1). */
export interface SqlProgressReporter {
  report(message: string, fraction?: number): void;
  /** Another reading of the scripts starts (the next dialect): its bar starts again from empty. */
  restart?(): void;
}

export interface ImportSqlDdlDeps extends Omit<ImportDbmlDeps, 'ui' | 'source' | 'origin' | 'sqlDialect'> {
  /** The extension's folder: the SQL importer is `<extensionPath>/dist/sqlImport.js`. */
  extensionPath: string;
  sqlUi?: ImportSqlDdlUi;
  /** The Import DBML half (layer, name, dry run, open). */
  ui?: ImportDbmlUi;
  /** Loads the SQL importer (tests pass the engine module itself): the conversion then runs in-process. Default: in a worker (`workerSqlConverter`). */
  loadSqlImport?: () => SqlImportModule;
  /** The converter each run uses (tests). Default: `loadSqlImport` in-process when given, else a worker. */
  sqlConverter?: () => SqlConverter;
  /**
   * How long one reading of the scripts may take (ms; `erdStudio.import.timeLimitSeconds`):
   * the dialect ranking as a whole, and the conversion after the pick. At the
   * limit what was read is imported and the rest is reported. 0: no limit.
   * Default {@link DEFAULT_SQL_TIME_LIMIT_MS}.
   */
  timeLimitMs?: number;
}

/** `erdStudio.import.timeLimitSeconds`'s default, in ms. */
export const DEFAULT_SQL_TIME_LIMIT_MS = 120_000;

/**
 * `erdStudio.import.timeLimitSeconds` in ms (0: no limit; any other value is
 * at least 1 ms, never rounded to "no limit"); a value that is not a number
 * ≥ 0 is the default.
 */
export function sqlImportTimeLimitMs(): number {
  const seconds = getErdStudioSetting<unknown>('import.timeLimitSeconds', DEFAULT_SQL_TIME_LIMIT_MS / 1000);
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return DEFAULT_SQL_TIME_LIMIT_MS;
  return seconds === 0 ? 0 : Math.max(1, Math.round(seconds * 1000));
}

/** The converter a run uses: the deps' own, the injected importer in-process, or a worker. */
function converterOf(deps: ImportSqlDdlDeps): SqlConverter {
  if (deps.sqlConverter) return deps.sqlConverter();
  if (deps.loadSqlImport) return inProcessSqlConverter(deps.loadSqlImport);
  return workerSqlConverter({
    extensionPath: deps.extensionPath,
    log: (message) => log.info(`[ERD Studio] ${TITLE}: ${message}`),
  });
}

/**
 * One reading of the scripts (the dialect ranking, or the conversion after
 * the pick) as its converter sees it: its Cancel, its deadline, its
 * progress; `stoppedBy` once a reading stopped early.
 */
export interface SqlReadingControl {
  signal?: AbortSignal;
  deadline?: number;
  timeLimitMs?: number;
  onProgress?(dialect: SqlDialect, progress: SqlConvertProgress): void;
  stoppedBy?: SqlStopReason;
  /** The reading was ended after the grace (one step did not stop): how far it had got. */
  abandoned?: SqlConvertAbandonedError;
}

/** The converter's control for one dialect's reading. */
function convertControl(control: SqlReadingControl | undefined, dialect: SqlDialect): SqlConvertControl {
  if (!control) return {};
  return {
    ...(control.signal ? { signal: control.signal } : {}),
    ...(control.deadline !== undefined ? { deadline: control.deadline } : {}),
    ...(control.timeLimitMs !== undefined ? { timeLimitMs: control.timeLimitMs } : {}),
    ...(control.onProgress ? { onProgress: (p: SqlConvertProgress) => control.onProgress!(dialect, p) } : {}),
  };
}

/** Whether a reading must not start (cancelled, or past the deadline). */
function readingStopped(control: SqlReadingControl | undefined): SqlStopReason | undefined {
  if (!control) return undefined;
  if (control.stoppedBy) return control.stoppedBy;
  if (control.signal?.aborted) return 'cancelled';
  return control.deadline !== undefined && Date.now() >= control.deadline ? 'timeLimit' : undefined;
}

/** `1,234 statements, 1,000 tables read as PostgreSQL`: a reading's progress line. */
export function sqlProgressMessage(dialect: SqlDialect, p: SqlConvertProgress): string {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const files = p.files > 1 ? ` (file ${fmt(Math.min(p.filesRead + 1, p.files))} of ${fmt(p.files)})` : '';
  return `${fmt(p.statementsRead)} ${p.statementsRead === 1 ? 'statement' : 'statements'}, ${fmt(p.tablesRead)} ${p.tablesRead === 1 ? 'table' : 'tables'} read as ${SQL_DIALECT_LABELS[dialect]}${files}`;
}

/**
 * Runs one reading under the progress notification (when the UI has one):
 * its Cancel aborts the reading's signal, its deadline is the time limit from
 * now, and each statement's progress is reported.
 */
async function withReadingControl<T>(ui: ImportSqlDdlUi, deps: ImportSqlDdlDeps, task: (control: SqlReadingControl) => Promise<T>): Promise<T> {
  const limit = Math.max(0, deps.timeLimitMs ?? DEFAULT_SQL_TIME_LIMIT_MS);
  const control = (signal: AbortSignal | undefined, progress: SqlProgressReporter | undefined): SqlReadingControl => {
    // Each dialect's reading reads the scripts from the start: its own bar, never one already full.
    let reading: SqlDialect | undefined;
    const onProgress = (dialect: SqlDialect, p: SqlConvertProgress): void => {
      if (reading !== undefined && reading !== dialect) progress!.restart?.();
      reading = dialect;
      progress!.report(sqlProgressMessage(dialect, p), p.fraction);
    };
    return {
      ...(signal ? { signal } : {}),
      ...(limit > 0 ? { deadline: Date.now() + limit, timeLimitMs: limit } : {}),
      ...(progress ? { onProgress } : {}),
    };
  };
  if (!ui.withProgress) return task(control(undefined, undefined));
  return ui.withProgress(`${TITLE}: reading the scripts`, (progress, signal) => task(control(signal, progress)));
}

/** `2 min`, `90 s`: the time limit as a message says it. */
function limitText(ms: number | undefined): string {
  return ms ? ` (${timeLimitText(ms)})` : '';
}

/** Where Try Another Dialect re-enters: with the files already read. */
export interface SqlResume {
  files: SqlDdlFile[];
  /** Full path of each file, by its shown name (for Open File). */
  fullPaths: ReadonlyMap<string, string>;
  fileName: string;
  sourceLabel: string;
  /** Each dialect's reading of the files, when already converted (the quick path's ranking): the pick reuses them. */
  readings?: ReadonlyMap<SqlDialect, SqlDialectReading>;
}

/** Above this much SQL (characters) the dialect pick does not read the scripts in every dialect first (it would be slow). */
export const RANK_ALL_DIALECTS_CHARS = 4 * 1024 * 1024;

/**
 * How long (ms) ranking the dialects may spend, all readings together: once a
 * dialect reads a table, another is read only while the time spent plus the
 * slowest reading so far stays within it. Each reading runs on the extension
 * host, so five readings of a large script would block it five times over.
 */
export const RANK_DIALECTS_MS = 3000;

/** How long each reading took (ms), for the budget of a later ranking that reuses it. */
const readingMs = new WeakMap<SqlDialectReading, number>();

/** The order dialects are read in: the detected one first, then by how likely each is. */
function dialectOrder(text: string, detected: SqlDialect | undefined): SqlDialect[] {
  return detected ? [detected, ...rankSqlDialects(text).filter((d) => d !== detected)] : rankSqlDialects(text);
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
  /** How partitions were read (the quick path folds them): offered first at the partitions step. */
  partitions?: SqlPartitionMode;
}

/** The SQL UI of the automatic draft: it asks nothing and shows nothing (each message goes to the log). */
export function quietImportSqlDdlUi(base: ImportSqlDdlUi): ImportSqlDdlUi {
  const logged = async (message: string): Promise<undefined> => {
    log.info(`[ERD Studio] ${TITLE} (automatic draft, not shown): ${message}`);
    return undefined;
  };
  // Shows nothing: no progress notification either (the time limit still holds).
  const { withProgress: _shown, ...rest } = base;
  return {
    ...rest,
    pickSources: async () => undefined,
    pickDialect: async () => undefined,
    pickFiles: async () => undefined,
    pickPartitions: undefined,
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
function sqlRun(ui: ImportSqlDdlUi, quiet = false, draft?: ImportSqlDdlDeps['draft']) {
  const cancelled = (): undefined => {
    if (!quiet) telemetry.feature('importSqlDdlCancelled');
    return undefined;
  };
  /**
   * The scripts brought nothing in (`importOutcomeSqlDdlFail`, by dialect when
   * one was chosen, with the ledger's cause classes when the reading has one).
   * A success is counted by Import DBML's flow, once its plan is ready.
   */
  const failed = (dialect?: SqlDialect, ledger?: readonly LedgerEntry[]): void => {
    if (quiet) return;
    recordImportOutcome((key) => telemetry.featureQuiet(key), {
      importer: 'sql',
      outcome: 'failed',
      ...(dialect ? { dialect } : {}),
      ...(ledger ? { ledger } : {}),
    });
  };
  const showError = (message: string, actions: ErrorActions = {}): void => {
    showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), message, actions, (choice, err) => {
      log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err);
      const doing = `while running ${choice}`;
      showError(oursMessage(TITLE, doing, 'nothing was changed'), { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)) });
    });
  };
  const ours = (doing: string, err: unknown, code: TelemetryErrorCode = 'importSqlDdlFailed', dialect?: SqlDialect): undefined => {
    telemetry.error(code);
    failed(dialect);
    log.error(`[ERD Studio] ${TITLE} failed ${doing}:`, err);
    showError(oursMessage(TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(TITLE, doing, err)),
    });
    return undefined;
  };
  /** A gather that gave a message: say it (an error or a plain note). */
  const gatherMessage = (gathered: { message: string; error: boolean; invalid?: boolean; limit?: ImportInputLimit }): undefined => {
    if (gathered.invalid && !quiet) telemetry.feature('importSqlDdlInvalid');
    if (gathered.limit && !quiet) telemetry.feature(IMPORT_LIMIT_FEATURES[gathered.limit]);
    // No scripts in the folder, a limit or a file that does not read; "no files were picked" is neither.
    if (gathered.error || gathered.invalid) failed();
    if (gathered.error) showError(gathered.message);
    else void ui.showInformationMessage(gathered.message);
    return undefined;
  };
  /**
   * SQL that did not all convert: every problem to the log (with its file and
   * line), then `importSqlDdlInvalid` and why (each problem kind, the rejected
   * clause, the dialect).
   */
  const invalid = (problems: readonly SqlDdlProblem[], dialect: SqlDialect): void => {
    logProblems(problems, dialect);
    if (quiet) return;
    telemetry.feature('importSqlDdlInvalid');
    for (const key of sqlInvalidFeatures(problems, dialect)) telemetry.feature(key);
  };
  /**
   * A reading that stopped before it read a table: a cancel is the user's
   * cancel (nothing to import: a note with Show Import Report); the time
   * limit says so, with the setting that raises it. Either way the import
   * report holds what the stopped reading left unread (`cancelled` /
   * `timedOut`, each file's unread part at its line) and the import's
   * outcome is counted; the automatic draft's quiet stop records neither
   * (its time limit is its own drop reason). A reading ended after the grace
   * (`stop.abandoned`: one step did not stop) lost what it had read: the
   * report holds the ended reading, and the message says how many tables
   * were lost rather than "before it read a table".
   */
  const stoppedBeforeATable = (reason: SqlStopReason, limitMs: number | undefined, stop: SqlStopContext = {}): undefined => {
    const status = reason === 'cancelled' ? 'cancelled' : 'timedOut';
    const ended = stop.abandoned ? abandonedReadingLedger(stop.abandoned, stop.read?.files.map((f) => f.name) ?? [], limitMs) : [];
    const ledger = [...(stop.ledger ?? []), ...ended];
    const lost = stop.abandoned?.progress?.tablesRead ?? 0;
    const lostText = lost > 0
      ? `, and one step of the reading did not stop within ${timeLimitText(STOP_GRACE_MS)} of it, so the reading was ended: the ${lost.toLocaleString('en-US')} ${lost === 1 ? 'table it had read was' : 'tables it had read were'} lost, and nothing was imported.`
      : undefined;
    if (stop.abandoned) log.warn(`[ERD Studio] ${TITLE}: ${stop.abandoned.message}${lost > 0 ? ` It had read ${lost.toLocaleString('en-US')} tables (${(stop.abandoned.progress?.statementsRead ?? 0).toLocaleString('en-US')} statements); they were lost.` : ''}`);
    let reportId: number | undefined;
    if (!quiet) {
      recordImportOutcome((key) => telemetry.featureQuiet(key), {
        importer: 'sql',
        outcome: status,
        ...(stop.dialect ? { dialect: stop.dialect } : {}),
        ledger,
      });
      reportId = recordImportReport({
        source: 'sql',
        title: TITLE,
        ...(stop.read ? { from: stoppedOriginPhrase(stop.read.files.length, stop.dialect) } : {}),
        status,
        ledger,
        ...(stop.read ? { files: Object.fromEntries(stop.read.fullPaths) } : {}),
      });
    }
    const report: Record<string, () => unknown> = reportId !== undefined && ui.showImportReport
      ? { [SHOW_IMPORT_REPORT_LABEL]: () => ui.showImportReport!(reportId) }
      : {};
    if (reason === 'cancelled') {
      if (!lostText) log.info(`[ERD Studio] ${TITLE}: cancelled before a table was read; nothing was imported.`);
      cancelled();
      // Only with the report to show, or tables lost: a bare "cancelled" would say what the user just did.
      if (Object.keys(report).length || lostText) {
        showErrorWithActions(
          (m, ...items) => Promise.resolve(ui.showInformationMessage(m, ...items)).then((c) => (typeof c === 'string' ? c : undefined)),
          lostText ? `${TITLE} was cancelled${lostText}` : `${TITLE} was cancelled before it read a table, so nothing was imported.`,
          report,
          (choice, err) => log.error(`[ERD Studio] ${TITLE}: "${choice}" failed:`, err),
        );
      }
      return undefined;
    }
    dropQuietly(draft, 'timeLimit');
    const limit = limitText(limitMs ?? DEFAULT_SQL_TIME_LIMIT_MS);
    const actions: Record<string, () => unknown> = {};
    if (ui.openSettings) actions[OPEN_SETTINGS_BUTTON] = () => ui.openSettings!(TIME_LIMIT_SETTING);
    Object.assign(actions, report);
    if (ui.showLogs) actions[SHOW_LOGS_BUTTON] = () => ui.showLogs!();
    const what = lostText ? `${TITLE} reached its time limit${limit}${lostText}` : `${TITLE} reached its time limit${limit} before it read a table, so nothing was imported.`;
    showError(`${what} Raise the limit (${TIME_LIMIT_SETTING}), or import fewer scripts at a time.`, actions);
    return undefined;
  };
  return { cancelled, showError, ours, gatherMessage, invalid, failed, stoppedBeforeATable };
}

/** What a reading that stopped before it read a table leaves for the import report and the outcome count. */
interface SqlStopContext {
  /** The scripts the import read: their count, and their paths by the names the ledger gives them. */
  read?: Pick<SqlResume, 'files' | 'fullPaths'>;
  /** The dialect the stopped conversion ran as; none for the dialect ranking (no dialect was chosen yet). */
  dialect?: SqlDialect;
  /** The stopped reading's ledger: its unread statements, each file's at the line its unread part starts. */
  ledger?: readonly LedgerEntry[];
  /** The reading was ended after the grace: nothing it read was kept. */
  abandoned?: SqlConvertAbandonedError;
}

/**
 * A reading ended after the grace, in the ledger: one `problem` entry with the
 * stop's cause, at the file it was busy in (from its last progress), saying
 * that nothing was imported and how many tables it had read were lost. No
 * statement can be placed: what it read never came back from the worker.
 */
function abandonedReadingLedger(err: SqlConvertAbandonedError, fileNames: readonly string[], limitMs: number | undefined): LedgerEntry[] {
  const p = err.progress;
  const at = fileNames.length ? fileNames[Math.min(Math.max(0, p?.filesRead ?? 0), fileNames.length - 1)] : undefined;
  const why = err.reason === 'cancelled' ? 'the import was cancelled' : `the time limit${limitText(limitMs ?? DEFAULT_SQL_TIME_LIMIT_MS)} was reached`;
  const lost = p && p.tablesRead > 0 ? `; the ${p.tablesRead.toLocaleString('en-US')} ${p.tablesRead === 1 ? 'table' : 'tables'} it had read were lost` : '';
  const ledger = createLedger();
  ledger.problem('file', err.reason, 'reading ended', at ? { file: at } : undefined,
    `nothing was imported: ${why}, and the reading (busy in this file) did not stop within ${timeLimitText(STOP_GRACE_MS)}, so it was ended${lost}`);
  return ledger.entries;
}

/** The report's source phrase for a stopped reading: `from 3 SQL files (PostgreSQL)`, or `from 3 SQL files` before a dialect. */
function stoppedOriginPhrase(fileCount: number, dialect: SqlDialect | undefined): string {
  return dialect ? sqlOriginPhrase(fileCount, SQL_DIALECT_LABELS[dialect]) : `from ${fileCount.toLocaleString('en-US')} SQL ${fileCount === 1 ? 'file' : 'files'}`;
}

/** Whether any dialect's reading read a table. */
function readsATable(readings: ReadonlyMap<SqlDialect, SqlDialectReading> | undefined): boolean {
  return [...(readings?.values() ?? [])].some((r) => r.tablesRead > 0);
}

/** The reading of a ranking that stopped early (its ledger holds the unread statements), if any did. */
function stoppedReadingOf(readings: ReadonlyMap<SqlDialect, SqlDialectReading> | undefined): SqlDialectReading | undefined {
  return [...(readings?.values() ?? [])].find((r) => r.result.stopped);
}

/** The setting that holds the time limit (seconds). */
export const TIME_LIMIT_SETTING = 'erdStudio.import.timeLimitSeconds';
/** The button that opens the settings at {@link TIME_LIMIT_SETTING}. */
export const OPEN_SETTINGS_BUTTON = 'Open Settings';

/** A reading that stopped early in the log: one line, then each file's unread part (file and line) from the ledger. */
function logStop(stop: SqlConvertStop, ledger: readonly LedgerEntry[] | undefined, limitMs: number | undefined): void {
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const why = stop.reason === 'cancelled' ? 'cancelled' : `stopped at its time limit${limitText(limitMs ?? DEFAULT_SQL_TIME_LIMIT_MS)}`;
  const others = stop.statementsUnread - stop.tablesUnread;
  log.warn(`[ERD Studio] ${TITLE}: ${why} at ${stop.at.file} line ${stop.at.line}, after ${fmt(stop.statementsRead)} statements. Not read: ${fmt(stop.tablesUnread)} CREATE TABLE ${stop.tablesUnread === 1 ? 'statement' : 'statements'} and ${fmt(others)} other ${others === 1 ? 'statement' : 'statements'}; where each file's unread part starts follows.`);
  for (const line of ledgerLogLines((ledger ?? []).filter((e) => e.cause === stop.reason), TITLE)) log.warn(`[ERD Studio] ${line}`);
}

/** Readings of the files that read them whole: one that stopped early is never reused by another run. */
function withoutStoppedReadings(readings: ReadonlyMap<SqlDialect, SqlDialectReading>): ReadonlyMap<SqlDialect, SqlDialectReading> {
  return new Map([...readings].filter(([, r]) => !r.result.stopped));
}

/** Every problem of a conversion, one log line each with its file and line. */
function logProblems(problems: readonly SqlDdlProblem[], dialect: SqlDialect): void {
  for (const p of problems) log.warn(`[ERD Studio] ${TITLE} (${SQL_DIALECT_LABELS[dialect]}): ${problemLabel(p)}`);
}

/**
 * The draft's banner for a conversion that left something out: `3 of 71
 * tables could not be read; Show details lists them.` A table defined twice
 * was read (its first definition is kept), so it is said apart, never counted
 * as a table that could not be read.
 */
export function sqlPartialNotice(result: Extract<SqlDdlToDbmlResult, { ok: true }>): string | undefined {
  const problems = result.problems ?? [];
  const stop = result.stopped;
  if (!problems.length && !stop) return undefined;
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const twice = problems.filter((p) => p.kind === 'duplicateTable').length;
  const unread = problems.filter((p) => p.table !== undefined && p.kind !== 'duplicateTable').length;
  const statements = problems.length - twice - unread;
  // Each second definition is a CREATE TABLE counted in tablesFound, not another table; tables
  // the import stopped before are said apart (they were never tried).
  const distinct = Math.max(result.tablesFound - twice - (stop?.tablesUnread ?? 0), unread);
  const parts: string[] = [];
  if (stop) {
    const why = stop.reason === 'cancelled' ? 'The import was cancelled' : 'The import reached its time limit';
    const others = stop.statementsUnread - stop.tablesUnread;
    const rest = stop.tablesUnread > 0
      ? `${fmt(stop.tablesUnread)} of ${fmt(result.tablesFound - twice)} tables were not read`
      : `${fmt(others)} ${others === 1 ? 'statement was' : 'statements were'} not read`;
    parts.push(`${why} at ${stop.at.file} line ${fmt(stop.at.line)}: ${rest}`);
  }
  if (unread > 0) parts.push(`${fmt(unread)} of ${fmt(distinct)} tables could not be read`);
  if (twice > 0) parts.push(`${fmt(twice)} ${twice === 1 ? 'table is' : 'tables are'} defined twice (the first definition is kept)`);
  if (statements > 0) parts.push(`${fmt(statements)} ${statements === 1 ? 'statement' : 'statements'} could not be read`);
  const many = problems.length + (stop ? 2 : 0) > 1;
  return `${parts.join('; ')}; Show details lists ${many ? 'them' : 'it'}.`;
}

/** The ledger's log lines, without its problems: each problem is logged once, with its message, by {@link logProblems}. */
function ledgerLogLinesWithoutProblems(ledger: readonly LedgerEntry[]): string[] {
  return ledgerLogLines(ledger.filter((e) => e.outcome !== 'problem'), TITLE);
}

/**
 * The scripts read as each dialect in `order` (every one when the SQL is at
 * most {@link RANK_ALL_DIALECTS_CHARS}, else the first, and the next only
 * while none reads every table as written), within {@link RANK_DIALECTS_MS}:
 * until a dialect reads a table every one is tried (as one would be after
 * the pick anyway), and after that another only while it fits the budget. A
 * dialect whose conversion throws is left out (the conversion after the pick
 * reports it). Each reading runs on `engine` (a worker's converter, or the
 * importer itself in-process). `budget.control`: the reading's Cancel,
 * deadline and progress; once a reading stops early (or is abandoned) no
 * other dialect is tried, and `control.stoppedBy` says why. Throws
 * {@link SqlEngineLoadError} when the importer cannot be loaded.
 */
export async function readAsDialects(
  engine: SqlConverter | SqlImportModule, files: SqlDdlFile[], order: readonly SqlDialect[], known?: ReadonlyMap<SqlDialect, SqlDialectReading>,
  budget: { ms?: number; now?: () => number; control?: SqlReadingControl } = {},
): Promise<Map<SqlDialect, SqlDialectReading>> {
  const converter = 'convert' in engine ? engine : inProcessSqlConverter(() => engine);
  const control = budget.control;
  const readings = new Map<SqlDialect, SqlDialectReading>(known ?? []);
  const chars = files.reduce((n, f) => n + f.text.length, 0);
  const all = chars <= RANK_ALL_DIALECTS_CHARS;
  const limit = budget.ms ?? RANK_DIALECTS_MS;
  const now = budget.now ?? Date.now;
  let spent = 0;
  let slowest = 0;
  for (const r of readings.values()) { const ms = readingMs.get(r) ?? 0; spent += ms; slowest = Math.max(slowest, ms); }
  for (const dialect of order) {
    if (!readings.has(dialect)) {
      const stop = readingStopped(control);
      if (stop) {
        if (control) control.stoppedBy = stop;
        log.info(`[ERD Studio] ${TITLE}: the scripts were not read as another dialect (${stop === 'cancelled' ? 'cancelled' : 'the time limit was reached'}).`);
        break;
      }
      const readsATable = [...readings.values()].some((r) => r.tablesRead > 0);
      if (readsATable && spent + slowest > limit) {
        log.info(`[ERD Studio] ${TITLE}: the scripts were not read as every dialect first (${(spent / 1000).toFixed(1)} s spent; the rest would take longer than ${(limit / 1000).toFixed(0)} s).`);
        break;
      }
      const started = now();
      try {
        const result = await converter.convert({ files, dialect }, convertControl(control, dialect));
        const reading = sqlDialectReading(dialect, result);
        readings.set(dialect, reading);
        const ms = Math.max(0, now() - started);
        readingMs.set(reading, ms);
        spent += ms;
        slowest = Math.max(slowest, ms);
        // Stopped early (cancelled, or the time limit): what it read is kept, and no other dialect is read.
        if (result.stopped) {
          if (control) control.stoppedBy = result.stopped.reason;
          break;
        }
      } catch (err) {
        if (err instanceof SqlEngineLoadError) throw err;
        spent += Math.max(0, now() - started);
        if (err instanceof SqlConvertAbandonedError) {
          if (control) { control.stoppedBy = err.reason; control.abandoned = err; }
          log.warn(`[ERD Studio] ${TITLE}: reading the scripts as ${SQL_DIALECT_LABELS[dialect]}: ${err.message}`);
          break;
        }
        log.warn(`[ERD Studio] ${TITLE}: reading the scripts as ${SQL_DIALECT_LABELS[dialect]} failed:`, err);
        continue;
      }
    }
    const r = readings.get(dialect)!;
    if (!all && r.tablesRead === r.tablesFound && r.repaired === 0 && r.salvaged === 0) break;
  }
  return readings;
}

/** Why no dialect reads the scripts: the best reading's first problem, for the pick's placeholder and the log. */
function noDialectReason(readings: ReadonlyMap<SqlDialect, SqlDialectReading>, detected?: SqlDialect): string | undefined {
  const ranked = rankSqlDialectReadings([...readings.values()], detected);
  if (ranked.length === 0 || ranked[0].tablesRead > 0) return undefined;
  const first = ranked[0].result.problems?.[0];
  return first ? problemLabel(first) : undefined;
}

/**
 * Run the flow. Resolves Import DBML's result once a diagram is written, or
 * undefined when the user cancels, the scripts do not read, or something
 * failed (each case has already said so). `preset`: Change Options…'s
 * answers, offered first at each step.
 */
export async function importSqlDdl(deps: ImportSqlDdlDeps, resume?: SqlResume, preset: SqlPreset = {}): Promise<ImportDbmlResult | undefined> {
  const ui = sqlUiOf(deps);
  const { cancelled, showError, ours, gatherMessage, invalid, failed, stoppedBeforeATable } = sqlRun(ui, deps.draft?.quiet === true, deps.draft);

  // 1. The scripts.
  let read = resume;
  if (!read) {
    const sources = await ui.pickSources(deps.workspaceRoot || undefined);
    if (!sources) return cancelled();
    const gathered = await gatherSqlFiles(sources, ui, deps.workspaceRoot || undefined);
    if ('message' in gathered) return gatherMessage(gathered);
    read = gathered;
  }
  const { files, fullPaths } = read;

  // 1b. A catalog query's export (.csv / .tsv, one row per column): no dialect, no SQL grammar.
  if (isCatalogRead(read)) return importCatalogExport(deps, read, preset);

  // 2. The dialect: the one the user chose already (the import guide's card), else a pick
  //    with the one chosen before (Change Options…) first, then every dialect by how many
  //    tables it reads (the scripts are read as each first, when they are not too big).
  //    Every reading runs in a worker (`converterOf`), under a progress notification with
  //    Cancel and the time limit; the worker ends with this step.
  const converter = converterOf(deps);
  let dialect: SqlDialect;
  // A reading that stopped early (cancelled, or the time limit) belongs to the run it stopped in:
  // another run (Try Another Dialect, the quick path's hand-over) reads that dialect again, whole.
  let readings: ReadonlyMap<SqlDialect, SqlDialectReading> | undefined = read.readings && withoutStoppedReadings(read.readings);
  let result: SqlDdlToDbmlResult;
  try {
    const detected = detectSqlDialect(files.map((f) => f.text).join('\n'));
    let stoppedBy: SqlStopReason | undefined;
    if (!(preset.dialect && preset.dialectChosen)) {
      if (!readings || readings.size < SQL_DIALECTS.length) {
        const order = dialectOrder(files.map((f) => f.text).join('\n'), detected);
        const before = readings;
        let abandoned: SqlConvertAbandonedError | undefined;
        try {
          readings = await withReadingControl(ui, deps, async (control) => {
            try {
              return await readAsDialects(converter, files, order, before, { control });
            } finally {
              stoppedBy = control.stoppedBy;
              abandoned = control.abandoned;
            }
          });
        } catch (err) {
          // The importer did not load: the conversion after the pick says so.
          if (!(err instanceof SqlEngineLoadError)) log.warn(`[ERD Studio] ${TITLE}: reading the scripts as each dialect failed:`, err);
        }
        // Cancelled (or the time limit) before any dialect read a table: the import ends here, as
        // the quick path's does; a dialect pick would only read the scripts again. Once other
        // dialects have read the scripts whole without a table, the time limit does not end it:
        // the pick says why no dialect reads one (the conversion after it has its own limit).
        if (stoppedBy && !readsATable(readings) && (stoppedBy === 'cancelled' || !readings || withoutStoppedReadings(readings).size === 0)) {
          return stoppedBeforeATable(stoppedBy, deps.timeLimitMs, { read, ledger: stoppedReadingOf(readings)?.result.ledger, abandoned });
        }
      }
    }
    if (preset.dialect && preset.dialectChosen) {
      dialect = preset.dialect;
    } else if (stoppedBy === 'cancelled' && readings && readsATable(readings)) {
      // Cancel imports the tables read so far: the dialect that read the most, without a pick.
      dialect = rankSqlDialectReadings([...readings.values()], detected)[0].dialect;
      log.info(`[ERD Studio] ${TITLE}: cancelled while reading the scripts as each dialect; importing what ${SQL_DIALECT_LABELS[dialect]} read.`);
    } else {
      const ranked = readings && readings.size ? rankSqlDialectReadings([...readings.values()], detected).map((r) => r.dialect) : [];
      const rest = [...ranked, ...SQL_DIALECTS.filter((d) => !ranked.includes(d))];
      const first = preset.dialect ?? (ranked.length ? undefined : detected);
      const ordered = first ? [first, ...rest.filter((d) => d !== first)] : rest;
      // A reading the time limit stopped says nothing about why a dialect does not read the scripts.
      const whole = readings && withoutStoppedReadings(readings);
      const why = readings ? noDialectReason(whole && whole.size ? whole : readings, detected) : undefined;
      if (why) log.info(`[ERD Studio] ${TITLE}: no dialect reads a table in the scripts: ${why}`);
      // Never "detected" for a dialect that reads none of the tables.
      const isDetected = (d: SqlDialect): boolean => {
        const reading = readings?.get(d);
        return d === detected && (!reading || reading.tablesRead > 0);
      };
      const describe = (d: SqlDialect): string | undefined => {
        const reading = readings?.get(d);
        const parts: string[] = [];
        if (isDetected(d)) parts.push('detected');
        if (d === preset.dialect) parts.push('read as this before');
        if (reading) parts.push(sqlDialectReadingLabel(reading));
        if (reading?.result.stopped) parts.push(reading.result.stopped.reason === 'cancelled' ? 'stopped when cancelled' : 'stopped at the time limit');
        return parts.length ? parts.join(' · ') : undefined;
      };
      const these = files.length === 1 ? 'the script' : 'the scripts';
      const choice = await ui.pickDialect(
        ordered.map((d) => {
          const description = describe(d);
          return { label: SQL_DIALECT_LABELS[d], ...(description ? { description } : {}), dialect: d, ...(isDetected(d) ? { detected: true as const } : {}) };
        }),
        {
          title: TITLE,
          placeHolder: why
            ? `No dialect reads a table in ${these} (${why.length > 120 ? `${why.slice(0, 119)}…` : why}). Which dialect ${files.length === 1 ? 'is it' : 'are they'} written in?`
            : `Which SQL dialect ${files.length === 1 ? 'is the script' : 'are the scripts'} written in?`,
          ignoreFocusOut: true,
        },
      );
      if (!choice) return cancelled();
      dialect = choice.dialect;
    }
    const dialectKey = SQL_DIALECT_FEATURES[dialect];
    if (dialectKey) telemetry.feature(dialectKey);

    // 3. Convert (or the pick's reading of this dialect).
    // A reading stopped before it read a table is read again, under a limit of its own.
    const known = readings?.get(dialect);
    if (known && !(known.result.stopped && known.tablesRead === 0)) {
      result = known.result;
    } else {
      try {
        result = await withReadingControl(ui, deps, (control) => converter.convert({ files, dialect }, convertControl(control, dialect)));
      } catch (err) {
        if (err instanceof SqlEngineLoadError) {
          // Its own code: a VSIX missing dist/sqlImport.js shows up as exactly this.
          return ours('while loading its SQL importer', err.cause ?? err, 'importSqlEngineLoadFailed');
        }
        if (err instanceof SqlConvertAbandonedError) return stoppedBeforeATable(err.reason, deps.timeLimitMs, { read, dialect, abandoned: err });
        return ours('while converting the SQL', err, undefined, dialect);
      }
    }
  } finally {
    converter.dispose();
  }
  // Stopped (cancelled, or the time limit) before a table was read: nothing to import.
  if (!result.ok && result.stopped) return stoppedBeforeATable(result.stopped.reason, deps.timeLimitMs, { read, dialect, ledger: result.ledger });
  if (result.stopped) logStop(result.stopped, result.ledger, deps.timeLimitMs);
  if (!result.ok) {
    invalid(result.problems, dialect);
    failed(dialect, result.ledger ?? []);
    for (const line of ledgerLogLinesWithoutProblems(result.ledger ?? [])) log.info(`[ERD Studio] ${line}`);
    const firstProblem = result.problems.find((p) => p.file && fullPaths.has(p.file));
    const actions: Record<string, () => unknown> = {};
    if (firstProblem) actions[OPEN_FILE_BUTTON] = () => ui.openFileAt(fullPaths.get(firstProblem.file)!, firstProblem.line);
    // The report lists every problem with its file and line (the message names the first few).
    if (ui.showImportReport && deps.draft?.quiet !== true) {
      const reportId = recordImportReport({
        source: 'sql',
        title: TITLE,
        from: sqlOriginPhrase(files.length, SQL_DIALECT_LABELS[dialect]),
        status: 'failed',
        ledger: result.ledger ?? [],
        files: Object.fromEntries(fullPaths),
      });
      actions[SHOW_IMPORT_REPORT_LABEL] = () => ui.showImportReport!(reportId);
    }
    if (ui.showLogs) actions[SHOW_LOGS_BUTTON] = () => ui.showLogs!();
    // Another dialect only when one reads more (or nobody has looked).
    const mine = sqlDialectReading(dialect, result).tablesRead;
    const better = !readings || [...readings.values()].some((r) => r.dialect !== dialect && r.tablesRead > mine);
    if (better) {
      actions[TRY_ANOTHER_DIALECT_BUTTON] = () => {
        telemetry.feature('importSqlTryAnotherDialect');
        return importSqlDdl(deps, { ...read, ...(readings ? { readings } : {}) });
      };
    }
    showError(describeImportProblems(TITLE, result.problems, `They were read as ${SQL_DIALECT_LABELS[dialect]}.${result.problems.length > PROBLEMS_SHOWN ? ' Show Logs lists every one.' : ''}`), actions);
    return undefined;
  }
  // Tables that did not read do not stop the rest: said in the log, the draft's banner and its Not imported list.
  if (result.problems?.length) invalid(result.problems, dialect);

  // 3b. Partitions: folded into their parents (each one a ledger note), unless the user keeps them as tables.
  const folded = result.partitions?.folded ?? 0;
  if (folded > 0 && ui.pickPartitions) {
    const mode = await pickPartitionMode(ui, folded, preset.partitions);
    if (!mode) return cancelled();
    if (mode === 'tables') {
      // Read again with the partitions kept: in the worker, under its own progress, Cancel and time limit.
      const again = converterOf(deps);
      let kept: SqlDdlToDbmlResult;
      try {
        kept = await withReadingControl(ui, deps, (control) => again.convert({ files, dialect, options: { partitions: 'tables' } }, convertControl(control, dialect)));
      } catch (err) {
        if (err instanceof SqlEngineLoadError) return ours('while loading its SQL importer', err.cause ?? err, 'importSqlEngineLoadFailed');
        if (err instanceof SqlConvertAbandonedError) return stoppedBeforeATable(err.reason, deps.timeLimitMs, { read, dialect, abandoned: err });
        return ours('while converting the SQL', err, undefined, dialect);
      } finally {
        again.dispose();
      }
      if (!kept.ok && kept.stopped) return stoppedBeforeATable(kept.stopped.reason, deps.timeLimitMs, { read, dialect, ledger: kept.ledger });
      if (!kept.ok) return ours('while converting the SQL', new Error('keeping the partitions as tables read no table'));
      if (kept.stopped) logStop(kept.stopped, kept.ledger, deps.timeLimitMs);
      result = kept;
    }
  }

  // 4. Import DBML's flow, with the converted DBML as its file.
  return importConvertedSql(deps, read, dialect, result, {
    ...(preset.layer ? { preferredLayer: preset.layer } : {}),
    ...(preset.name ? { name: preset.name } : {}),
  });
}

/** The partitions step: fold them into their parents (first unless the user kept them before) or keep each as a table. */
async function pickPartitionMode(ui: ImportSqlDdlUi, folded: number, before: SqlPartitionMode | undefined): Promise<SqlPartitionMode | undefined> {
  const n = folded.toLocaleString('en-US');
  const one = folded === 1;
  const items: SqlPartitionItem[] = [
    {
      label: 'Fold partitions into their parent tables',
      description: ['recommended', ...(before === 'fold' ? ['read this way before'] : []), `${n} ${one ? 'partition is' : 'partitions are'} the parent's rows`].join(' · '),
      mode: 'fold',
    },
    {
      label: 'Keep each partition as a table',
      description: [...(before === 'tables' ? ['read this way before'] : []), `${n} more ${one ? 'table' : 'tables'}, each with its parent's columns`].join(' · '),
      mode: 'tables',
    },
  ];
  const ordered = before === 'tables' ? [items[1], items[0]] : items;
  const choice = await ui.pickPartitions!(ordered, {
    title: TITLE,
    placeHolder: `The scripts hold ${n} ${one ? 'partition' : 'partitions'} with no columns of ${one ? 'its' : 'their'} own (PARTITION OF, ATTACH PARTITION, INHERITS). Fold ${one ? 'it' : 'them'} into ${one ? 'its parent' : 'their parents'}?`,
    ignoreFocusOut: true,
  });
  return choice?.mode;
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
  // Every unit not brought across as written, with its file and line (`importLedger.ts`).
  const ledger = result.ledger ?? [];
  for (const line of ledgerLogLinesWithoutProblems(ledger)) log.info(`[ERD Studio] ${line}`);
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
    sqlDialect: dialect,
    origin: {
      from: sqlOriginPhrase(read.files.length, dialectLabel),
      description: `Imported from ${read.sourceLabel} (${dialectLabel}).`,
      notes: result.notes,
      skipped: result.skipped,
      ledger,
      ...(sqlPartialNotice(result) ? { notice: sqlPartialNotice(result) } : {}),
      // The scripts, by the names the ledger gives them: Show Import Report opens them at a line.
      sourceFiles: Object.fromEntries(read.fullPaths),
    },
    ...(changeOptions ? { changeOptions } : {}),
  }, { filePath, ...resume });
}

/** Whether the files picked are catalog exports (`.csv` / `.tsv`): every one is, or none (`gatherSqlFiles` refuses a mix). */
function isCatalogRead(read: Pick<SqlResume, 'files'>): boolean {
  return read.files.length > 0 && read.files.every((f) => isCatalogCsvName(f.name));
}

/**
 * Step 3 for a catalog export (a catalog query's result as CSV, one row per
 * column; `catalogCsvImport.ts`): converted on the host (it needs no SQL
 * grammar, so no worker and no dialect), then Import DBML's own flow, as
 * converted SQL is (`source: 'sql'`). The conversion runs no DBML check of
 * its own: Import DBML reads the result once, as it reads every converted
 * model (a 100,000-row export reads in about 4 s; a second check would double
 * it). A file that is not a catalog export, is cut short (`total_rows`) or is
 * over the limits says so and imports nothing.
 */
async function importCatalogExport(deps: ImportSqlDdlDeps, read: SqlResume, preset: SqlPreset): Promise<ImportDbmlResult | undefined> {
  const ui = sqlUiOf(deps);
  const quiet = deps.draft?.quiet === true;
  const { showError, ours, failed } = sqlRun(ui, quiet, deps.draft);
  let result: CatalogCsvResult;
  try {
    result = catalogCsvToDbml(read.files);
  } catch (err) {
    return ours('while reading the catalog export', err);
  }
  if (!result.ok) {
    if (result.reason === 'unwritable') return ours('while converting the catalog export', new Error(result.problems[0]?.message ?? 'no table could be written'));
    for (const p of result.problems) log.warn(`[ERD Studio] ${TITLE}: ${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.message}`);
    if (!quiet) telemetry.feature(result.reason === 'tooBig' ? IMPORT_LIMIT_FEATURES.tooMuchText : 'importSqlDdlInvalid');
    const ledger = catalogFailureLedger(result);
    failed(undefined, ledger);
    const first = result.problems[0];
    const actions: Record<string, () => unknown> = {};
    if (first?.file && read.fullPaths.has(first.file)) actions[OPEN_FILE_BUTTON] = () => ui.openFileAt(read.fullPaths.get(first.file)!, first.line);
    if (ui.showImportReport && !quiet) {
      const reportId = recordImportReport({
        source: 'sql', title: TITLE, from: catalogOriginPhrase(read.files.map((f) => f.name)), status: 'failed', ledger, files: Object.fromEntries(read.fullPaths),
      });
      actions[SHOW_IMPORT_REPORT_LABEL] = () => ui.showImportReport!(reportId);
    }
    if (ui.showLogs) actions[SHOW_LOGS_BUTTON] = () => ui.showLogs!();
    const pointer = result.reason === 'notCatalog' ? ' The queries in ERD Studio: Bring In Your Data Model… write one.' : '';
    showError(`${TITLE}: ${first?.message ?? 'the catalog export could not be read.'}${pointer}`, actions);
    return undefined;
  }
  // Tables or columns left out (a name too long to be one): logged, listed in the draft's Not imported.
  for (const p of result.problems) log.warn(`[ERD Studio] ${TITLE}: ${p.file}${p.line ? ` line ${p.line}` : ''}: ${p.message}`);
  if (result.problems.length && !quiet) telemetry.feature('importSqlDdlInvalid');
  for (const line of [...(result.notice ? [result.notice] : []), ...result.skipped, ...result.notes]) log.info(`[ERD Studio] ${TITLE}: ${line}`);
  for (const line of ledgerLogLinesWithoutProblems(result.ledger)) log.info(`[ERD Studio] ${line}`);
  const filePath = path.join(deps.workspaceRoot, sqlImportFileName(catalogImportStem(read.fileName), result.dbml, deps.workspaceRoot));
  const { extensionPath: _extensionPath, sqlUi: _sqlUi, loadSqlImport: _load, ui: importUi, ...rest } = deps;
  return importDbml({
    ...rest,
    ui: suppliedDbmlUi(importUi ?? vscodeImportDbmlUi(), filePath, result.dbml),
    source: 'sql',
    origin: {
      from: catalogOriginPhrase(read.files.map((f) => f.name)),
      description: `Imported from ${read.sourceLabel}.`,
      notes: result.notes,
      skipped: result.skipped,
      ledger: result.ledger,
      ...(result.notice ? { notice: result.notice } : {}),
      sourceFiles: Object.fromEntries(read.fullPaths),
    },
  }, {
    filePath,
    ...(preset.layer ? { preferredLayer: preset.layer } : {}),
    ...(preset.name ? { name: preset.name } : {}),
  });
}

/**
 * Every `.sql` file in the open folder that the quick import takes — whose
 * start holds a CREATE TABLE with a column list, and, when there is one,
 * every file that adds keys to tables (ALTER TABLE … FOREIGN KEY, a
 * pg_dump-style constraints file: its relationships belong to the same
 * tables) or changes their columns (a later migration, applied in file
 * order) — from the start screen's own listing (`listImportFiles`: the same
 * folders skipped, the ERD Studio folder never read) and by its own test
 * (`isSqlScriptTaken`: never a dbt macro or a Databricks notebook), so whatever the start screen offers is taken here. At most
 * {@link MAX_SQL_FILES} files are opened, names that usually hold table
 * definitions first (`rankSqlFiles`, the look's order); a file larger than
 * the import reads is left out. `truncated`: not every `.sql` file in the
 * folder was looked at, so "every one" cannot be promised.
 */
export async function findSqlDdlScripts(
  root: string,
  semanticDir: string,
  ui: Pick<ImportSqlDdlUi, 'readDirectory' | 'readFile' | 'readFileStart' | 'fileSize'>,
): Promise<{ files: string[]; truncated: boolean }> {
  const listing = await listImportFiles(root, (f) => ui.readDirectory(f), { semanticDir });
  const ranked = rankSqlFiles(listing.sql, root);
  const opened = ranked.slice(0, MAX_SQL_FILES);
  const files: string[] = [];
  let tables = false;
  for (const file of opened) {
    const size = await ui.fileSize?.(file).catch(() => undefined);
    if (size !== undefined && size > MAX_SQL_FILE_BYTES) continue;
    const start = await (ui.readFileStart
      ? ui.readFileStart(file, QUICK_SQL_SNIFF_CHARS)
      : ui.readFile(file).then((t) => t.slice(0, QUICK_SQL_SNIFF_CHARS))).catch(() => '');
    if (!isSqlScriptTaken(file, start)) continue;
    tables ||= sqlScriptTableCount(file, start) > 0;
    files.push(file);
  }
  return { files: tables ? files.sort(compareNames) : [], truncated: listing.truncated || ranked.length > opened.length };
}

/**
 * The quick path: the found scripts, the dialect that reads the most of
 * their tables, Import DBML's quick layer and name, one confirm. Tables that
 * do not read are logged and listed in the draft; none reading at all asks
 * the dialect, saying why. Nothing found to take (no CREATE TABLE script, or
 * more `.sql` files than the walk lists): the step-by-step flow.
 */
export async function quickImportSqlDdl(deps: ImportSqlDdlDeps): Promise<ImportDbmlResult | undefined> {
  const ui = sqlUiOf(deps);
  const quiet = deps.draft?.quiet === true;
  const { ours, gatherMessage, stoppedBeforeATable } = sqlRun(ui, quiet, deps.draft);
  const found = await findSqlDdlScripts(deps.workspaceRoot, deps.semanticDir, ui).catch(() => ({ files: [] as string[], truncated: false }));
  if (found.truncated && found.files.length > 0) {
    log.info(`[ERD Studio] ${TITLE}: the folder holds more .sql files than are looked at; importing the ${found.files.length} CREATE TABLE scripts found first.`);
  }
  if (found.files.length === 0) {
    // The automatic draft never asks: nothing to take is the end of it.
    if (quiet) {
      log.info(`[ERD Studio] ${TITLE}: no CREATE TABLE script to draft (automatic draft dropped).`);
      dropQuietly(deps.draft, 'nothingFound');
      return undefined;
    }
    log.info(`[ERD Studio] ${TITLE}: ${found.truncated ? `more than ${MAX_SQL_FILES} .sql files in the folder` : 'no CREATE TABLE script found'}; asking which files.`);
    telemetry.feature('quickImportFellBack');
    return importSqlDdl(deps);
  }
  const gathered = await gatherSqlFiles({ files: found.files, root: deps.workspaceRoot }, ui);
  if ('message' in gathered) {
    if (quiet) dropQuietly(deps.draft, 'unreadable');
    return gatherMessage(gathered);
  }

  // The dialect: the one that reads the most tables (the detected one first; every dialect
  // only when it does not read them all as written), ties going to the detected one.
  const text = gathered.files.map((f) => f.text).join('\n');
  const detected = detectSqlDialect(text);
  const order = dialectOrder(text, detected);
  // Every reading in a worker, under one progress notification with Cancel and the time limit:
  // a reading that stops early is kept (what it read is the import) and no other dialect is read.
  const converter = converterOf(deps);
  let stoppedBy: SqlStopReason | undefined;
  let abandoned: SqlConvertAbandonedError | undefined;
  let readings: Map<SqlDialect, SqlDialectReading>;
  try {
    readings = await withReadingControl(ui, deps, async (control) => {
      try {
        const first = await readAsDialects(converter, gathered.files, [order[0]], undefined, { control });
        const firstReading = first.get(order[0]);
        const whole = firstReading && firstReading.tablesRead === firstReading.tablesFound && firstReading.salvaged === 0 && firstReading.repaired === 0 && !firstReading.result.problems?.length;
        return whole || control.stoppedBy ? first : await readAsDialects(converter, gathered.files, order, first, { control });
      } finally {
        stoppedBy = control.stoppedBy;
        abandoned = control.abandoned;
      }
    });
  } catch (err) {
    if (err instanceof SqlEngineLoadError) return ours('while loading its SQL importer', err.cause ?? err, 'importSqlEngineLoadFailed');
    return ours('while converting the SQL', err);
  } finally {
    converter.dispose();
  }
  if (readings.size === 0) {
    if (stoppedBy) return stoppedBeforeATable(stoppedBy, deps.timeLimitMs, { read: gathered, abandoned });
    return ours('while converting the SQL', new Error('no dialect could convert the scripts'));
  }
  const best = rankSqlDialectReadings([...readings.values()], detected)[0];
  // Stopped (cancelled, or the time limit) before any dialect read a table: nothing to import. Once
  // another dialect read the scripts whole without a table, the time limit hands over to the pick
  // below, which says why no dialect reads one.
  if (!best.result.ok && stoppedBy && (stoppedBy === 'cancelled' || withoutStoppedReadings(readings).size === 0)) {
    return stoppedBeforeATable(stoppedBy, deps.timeLimitMs, { read: gathered, ledger: stoppedReadingOf(readings)?.result.ledger, abandoned });
  }
  if (best.result.stopped) logStop(best.result.stopped, best.result.ledger, deps.timeLimitMs);
  // No dialect reads a table: ask which (the step-by-step flow's dialect step, which says why and reports the problems).
  if (!best.result.ok) {
    const why = noDialectReason(readings, detected);
    log.info(`[ERD Studio] ${TITLE}: no dialect reads a table in the scripts${why ? `: ${why}` : ''}; asking which dialect.`);
    if (quiet) {
      log.info(`[ERD Studio] ${TITLE}: the scripts read as no one dialect (automatic draft dropped).`);
      dropQuietly(deps.draft, 'noDialect');
      return undefined;
    }
    telemetry.feature('quickSqlNoDialect');
    return importSqlDdl(deps, { ...gathered, readings });
  }
  const chosenDialect = best.dialect;
  const chosenKey = SQL_DIALECT_FEATURES[chosenDialect];
  if (chosenKey) telemetry.feature(chosenKey);
  // The first dialect tried was not the one that read the most.
  if (!quiet && chosenDialect !== order[0]) telemetry.feature('quickSqlDialectFallback');
  if (best.result.problems?.length) {
    logProblems(best.result.problems, chosenDialect);
    if (!quiet) {
      telemetry.feature('importSqlDdlInvalid');
      for (const key of sqlInvalidFeatures(best.result.problems, chosenDialect)) telemetry.feature(key);
    }
  }
  return importConvertedSql(deps, gathered, chosenDialect, best.result, { quick: true },
    ({ layer, name }) => changeSqlOptions(deps, found.files, { dialect: chosenDialect, layer, name, partitions: 'fold' }));
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
  ui: Pick<ImportSqlDdlUi, 'readDirectory' | 'readFile' | 'fileSize'>,
  projectRoot?: string,
): Promise<SqlResume | { message: string; error: boolean; invalid?: boolean; limit?: ImportInputLimit }> {
  let entries: Array<{ name: string; fullPath: string }>;
  let fileName: string;
  let sourceLabel: string;
  if ('folder' in sources) {
    const folder = sources.folder;
    const folderName = path.basename(folder);
    const walk = await walkFiles(folder, (f) => ui.readDirectory(f), { include: (n) => /\.sql$/i.test(n), limit: MAX_SQL_FILES });
    if (walk.truncated) {
      return { message: `${TITLE}: ${folderName} holds more than ${MAX_SQL_FILES} .sql files. Pick a folder with fewer, or the files themselves.`, error: true, limit: 'tooManyFiles' };
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

  // One labelling rule for every entry point (the quick path, a folder, picked files): a file under
  // the open folder is named by its path under it, so a problem names it the same way each time.
  if (projectRoot && entries.length && entries.every((e) => isUnder(projectRoot, e.fullPath))) {
    entries = entries.map((e) => ({ ...e, name: path.relative(projectRoot, e.fullPath).split(path.sep).join('/') }));
  }
  // Catalog exports (.csv / .tsv, picked by hand: a folder's walk lists .sql only) are read as they are.
  const catalogs = entries.filter((e) => isCatalogCsvName(e.name)).length;
  if (catalogs > 0 && catalogs < entries.length) {
    return { message: `${TITLE}: pick SQL scripts or a catalog export (.csv), not both in one import.`, error: true, invalid: true };
  }
  if (catalogs > 0 && 'files' in sources && sources.root === undefined && entries.length > 1) {
    sourceLabel = `${entries.length} catalog exports`;
  }
  const files: SqlDdlFile[] = [];
  const fullPaths = new Map<string, string>();
  let chars = 0;
  for (const entry of entries) {
    const size = await ui.fileSize?.(entry.fullPath).catch(() => undefined);
    if (catalogs > 0 && size !== undefined && size > MAX_CATALOG_CHARS) {
      return { message: catalogTooBigMessage(entries.length), error: true, limit: 'fileTooBig' };
    }
    if (size !== undefined && size > MAX_SQL_FILE_BYTES) {
      return { message: tooBigMessage(entry.name), error: true, limit: 'fileTooBig' };
    }
    let raw: string;
    try {
      raw = await ui.readFile(entry.fullPath);
    } catch (err) {
      log.error(`[ERD Studio] ${TITLE}: could not read a file:`, err);
      return { message: `${TITLE} couldn't read ${entry.name}. Check that the file still exists and that you can open it, then try again.`, error: true, limit: 'unreadable' };
    }
    const unmarked = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    if (catalogs > 0) {
      // A catalog export is rows, not SQL: nothing in it is a dump's data.
      chars += unmarked.length;
      if (chars > MAX_CATALOG_CHARS) return { message: catalogTooBigMessage(entries.length), error: true, limit: 'tooMuchText' };
      files.push({ name: entry.name, text: unmarked });
      fullPaths.set(entry.name, entry.fullPath);
      continue;
    }
    // A dump's data (COPY blocks, INSERT statements) is not SQL to import: it neither counts nor is read.
    const { text, sqlChars } = withoutSqlData(unmarked);
    chars += sqlChars;
    if (chars > MAX_SQL_CHARS) {
      return { message: `${TITLE}: the scripts hold more than ${Math.round(MAX_SQL_CHARS / 1024 / 1024)} MB of SQL, not counting data. Import the table definitions on their own.`, error: true, limit: 'tooMuchText' };
    }
    files.push({ name: entry.name, text });
    fullPaths.set(entry.name, entry.fullPath);
  }
  return { files, fullPaths, fileName, sourceLabel };
}

function isUnder(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Catalog exports larger than the import reads. */
function catalogTooBigMessage(count: number): string {
  return `${TITLE}: the catalog ${count === 1 ? 'export holds' : 'exports hold'} more than ${Math.round(MAX_CATALOG_CHARS / 1024 / 1024)} MB. ` +
    'Export one schema at a time (add a schema filter to the query\'s WHERE clause) and import each.';
}

/** A script larger than the import reads. */
function tooBigMessage(name: string): string {
  return `${TITLE}: ${name} is larger than ${Math.round(MAX_SQL_FILE_BYTES / 1024 / 1024)} MB, too big to read. ` +
    'Export the schema without its data (pg_dump --schema-only, mysqldump --no-data, or SQL Server\'s Generate Scripts with schema only) and import that.';
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
            { label: '$(file) SQL files…', detail: 'Pick one or more .sql files, or a catalog export (.csv)', folders: false },
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
        ...(files ? { filters: { 'SQL scripts or a catalog export': ['sql', 'csv', 'tsv'] } } : {}),
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
    readFile: async (filePath) => decodeText(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    pickDialect: async (items, options) => {
      const picked = await vscode.window.showQuickPick(dialectPickRows(items), options);
      // A separator cannot be picked; map the shown row back to the item it was made from.
      return picked && 'dialect' in picked ? items.find((i) => i.dialect === picked.dialect) : undefined;
    },
    pickFiles: async (items, options) => vscode.window.showQuickPick([...items], { ...options, canPickMany: true }),
    pickPartitions: async (items, options) => vscode.window.showQuickPick([...items], options),
    readFileStart: (filePath, chars) => readTextStart(filePath, chars),
    fileSize: (filePath) => fileSize(filePath),
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
    showLogs: async () => { await vscode.commands.executeCommand(SHOW_LOGS_COMMAND); },
    withProgress: (title, task) => withDelayedProgress(title, task),
    openSettings: async (setting) => { await vscode.commands.executeCommand('workbench.action.openSettings', setting); },
    showImportReport: async (reportId) => { await vscode.commands.executeCommand(SHOW_IMPORT_REPORT_COMMAND, reportId); },
  };
}

/** A reading shorter than this never shows a progress notification. */
export const PROGRESS_DELAY_MS = 400;

/**
 * `task` under a cancellable progress notification, shown only once it has
 * run {@link PROGRESS_DELAY_MS} (a small script reads before it would
 * flash). The bar follows the largest fraction reported, as a bar cannot go
 * back; `restart` (the ranking's next dialect reads the scripts from the
 * start) replaces a notification whose bar has moved with a new, empty one,
 * so a bar is never full while a reading still runs.
 */
export function withDelayedProgress<T>(
  title: string,
  task: (progress: SqlProgressReporter, signal: AbortSignal) => Promise<T>,
  delayMs = PROGRESS_DELAY_MS,
): Promise<T> {
  const controller = new AbortController();
  let latest: { message: string; fraction?: number } | undefined;
  let shown: ((message: string, fraction?: number) => void) | undefined;
  /** Ends the notification on show, and whether its bar had moved. */
  let close: (() => void) | undefined;
  let moved = false;
  let done = false;
  const show = (): void => {
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        let percent = 0;
        moved = false;
        shown = (message, fraction) => {
          const next = fraction === undefined ? percent : Math.max(percent, Math.min(100, Math.round(fraction * 100)));
          progress.report({ message, ...(next > percent ? { increment: next - percent } : {}) });
          if (next > percent) moved = true;
          percent = next;
        };
        if (latest) shown(latest.message, latest.fraction);
        const closed = new Promise<undefined>((resolve) => { close = () => resolve(undefined); });
        return Promise.race([work.then(() => undefined, () => undefined), closed]);
      },
    );
  };
  const work = task({
    report: (message, fraction) => {
      latest = { message, ...(fraction !== undefined ? { fraction } : {}) };
      shown?.(message, fraction);
    },
    restart: () => {
      latest = undefined;
      if (!shown || !moved || done) return;
      shown = undefined;
      close?.();
      show();
    },
  }, controller.signal);
  const timer = setTimeout(() => {
    if (!done) show();
  }, delayMs);
  return work.finally(() => { done = true; clearTimeout(timer); });
}
