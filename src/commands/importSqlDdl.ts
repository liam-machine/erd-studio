/**
 * **Import SQL DDL…** (`erdStudio.importSqlDdl`) — CREATE TABLE scripts in as
 * a new diagram: PostgreSQL, MySQL / MariaDB, SQL Server / Azure SQL,
 * Snowflake or Databricks / Spark SQL.
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
 * Cancelling any step writes nothing.
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
import { log } from '../services/logger';
import { ledgerLogLines, type LedgerEntry } from '../services/importLedger';
import {
  SQL_DIALECTS,
  SQL_DIALECT_LABELS,
  detectSqlDialect,
  rankSqlDialectReadings,
  rankSqlDialects,
  sqlDialectReading,
  sqlDialectReadingLabel,
  withoutSqlData,
  type SqlDdlFile,
  type SqlDdlProblem,
  type SqlDdlToDbmlResult,
  type SqlDialect,
  type SqlDialectReading,
} from '../services/sqlDdlImport';
import { SHOW_LOGS_BUTTON, SHOW_LOGS_COMMAND } from '../services/showLogs';
import { loadSqlImport, type SqlImportModule } from '../services/sqlImportLoader';
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
  /** A file's text (`workspace.fs`), decoded by its byte order mark (UTF-16 from SQL Server Management Studio). Throws when it cannot be read. */
  readFile(filePath: string): Promise<string>;
  pickDialect(items: readonly SqlDialectItem[], options: vscode.QuickPickOptions): Promise<SqlDialectItem | undefined>;
  /** Change Options…: which of the found scripts (several may be picked; the found ones start picked). */
  pickFiles?(items: readonly SqlFileItem[], options: vscode.QuickPickOptions): Promise<readonly SqlFileItem[] | undefined>;
  /** The start of a file's text, at most `chars` (the quick path's look at each `.sql`). Absent: `readFile`. */
  readFileStart?(filePath: string, chars: number): Promise<string>;
  /** A file's size in bytes (undefined: unknown). Absent: never checked before reading. */
  fileSize?(filePath: string): Promise<number | undefined>;
  showInformationMessage(message: string): Promise<unknown>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  openFileAt(filePath: string, line?: number): Promise<void>;
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
  /** Opens the ERD Studio output channel (`erdStudio.showLogs`). Absent: no Show Logs button. */
  showLogs?(): Promise<void>;
}

export interface ImportSqlDdlDeps extends Omit<ImportDbmlDeps, 'ui' | 'source' | 'origin' | 'sqlDialect'> {
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
  return { cancelled, showError, ours, gatherMessage, invalid, failed };
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
  if (!problems.length) return undefined;
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const twice = problems.filter((p) => p.kind === 'duplicateTable').length;
  const unread = problems.filter((p) => p.table !== undefined && p.kind !== 'duplicateTable').length;
  const statements = problems.length - twice - unread;
  // Each second definition is a CREATE TABLE counted in tablesFound, not another table.
  const distinct = Math.max(result.tablesFound - twice, unread);
  const parts: string[] = [];
  if (unread > 0) parts.push(`${fmt(unread)} of ${fmt(distinct)} tables could not be read`);
  if (twice > 0) parts.push(`${fmt(twice)} ${twice === 1 ? 'table is' : 'tables are'} defined twice (the first definition is kept)`);
  if (statements > 0) parts.push(`${fmt(statements)} ${statements === 1 ? 'statement' : 'statements'} could not be read`);
  const many = problems.length > 1;
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
 * reports it).
 */
export function readAsDialects(
  engine: SqlImportModule, files: SqlDdlFile[], order: readonly SqlDialect[], known?: ReadonlyMap<SqlDialect, SqlDialectReading>,
  budget: { ms?: number; now?: () => number } = {},
): Map<SqlDialect, SqlDialectReading> {
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
      const readsATable = [...readings.values()].some((r) => r.tablesRead > 0);
      if (readsATable && spent + slowest > limit) {
        log.info(`[ERD Studio] ${TITLE}: the scripts were not read as every dialect first (${(spent / 1000).toFixed(1)} s spent; the rest would take longer than ${(limit / 1000).toFixed(0)} s).`);
        break;
      }
      const started = now();
      try {
        const reading = sqlDialectReading(dialect, engine.sqlDdlToDbml({ files, dialect }));
        readings.set(dialect, reading);
        const ms = Math.max(0, now() - started);
        readingMs.set(reading, ms);
        spent += ms;
        slowest = Math.max(slowest, ms);
      } catch (err) {
        spent += Math.max(0, now() - started);
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

/** The SQL importer, loaded on first use; undefined after saying it failed. */
function loadEngine(deps: ImportSqlDdlDeps, ours: (doing: string, err: unknown, code?: TelemetryErrorCode) => undefined): SqlImportModule | undefined {
  try {
    return deps.loadSqlImport ? deps.loadSqlImport() : loadSqlImport(deps.extensionPath);
  } catch (err) {
    // Its own code: a VSIX missing dist/sqlImport.js shows up as exactly this.
    return ours('while loading its SQL importer', err, 'importSqlEngineLoadFailed');
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
  const { cancelled, showError, ours, gatherMessage, invalid, failed } = sqlRun(ui, deps.draft?.quiet === true);

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

  // 2. The dialect: the one the user chose already (the import guide's card), else a pick
  //    with the one chosen before (Change Options…) first, then every dialect by how many
  //    tables it reads (the scripts are read as each first, when they are not too big).
  const detected = detectSqlDialect(files.map((f) => f.text).join('\n'));
  let readings: ReadonlyMap<SqlDialect, SqlDialectReading> | undefined = read.readings;
  let dialect: SqlDialect;
  if (preset.dialect && preset.dialectChosen) {
    dialect = preset.dialect;
  } else {
    if (!readings || readings.size < SQL_DIALECTS.length) {
      let early: SqlImportModule | undefined;
      try { early = deps.loadSqlImport ? deps.loadSqlImport() : loadSqlImport(deps.extensionPath); } catch { early = undefined; }
      if (early) readings = readAsDialects(early, files, dialectOrder(files.map((f) => f.text).join('\n'), detected), readings);
    }
    const ranked = readings && readings.size ? rankSqlDialectReadings([...readings.values()], detected).map((r) => r.dialect) : [];
    const rest = [...ranked, ...SQL_DIALECTS.filter((d) => !ranked.includes(d))];
    const first = preset.dialect ?? (ranked.length ? undefined : detected);
    const ordered = first ? [first, ...rest.filter((d) => d !== first)] : rest;
    const why = readings ? noDialectReason(readings, detected) : undefined;
    if (why) log.info(`[ERD Studio] ${TITLE}: no dialect reads a table in the scripts: ${why}`);
    const describe = (d: SqlDialect): string | undefined => {
      const reading = readings?.get(d);
      const parts: string[] = [];
      // Never "detected" for a dialect that reads none of the tables.
      if (d === detected && (!reading || reading.tablesRead > 0)) parts.push('detected');
      if (d === preset.dialect) parts.push('read as this before');
      if (reading) parts.push(sqlDialectReadingLabel(reading));
      return parts.length ? parts.join(' · ') : undefined;
    };
    const these = files.length === 1 ? 'the script' : 'the scripts';
    const choice = await ui.pickDialect(
      ordered.map((d) => {
        const description = describe(d);
        return { label: SQL_DIALECT_LABELS[d], ...(description ? { description } : {}), dialect: d };
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
  telemetry.feature(SQL_DIALECT_FEATURES[dialect]);

  // 3. Convert, with the importer loaded only now (or the pick's reading of this dialect).
  let result: SqlDdlToDbmlResult;
  const known = readings?.get(dialect);
  if (known) {
    result = known.result;
  } else {
    const engine = loadEngine(deps, ours);
    if (!engine) return undefined;
    try {
      result = engine.sqlDdlToDbml({ files, dialect });
    } catch (err) {
      return ours('while converting the SQL', err, undefined, dialect);
    }
  }
  if (!result.ok) {
    invalid(result.problems, dialect);
    failed(dialect, result.ledger ?? []);
    for (const line of ledgerLogLinesWithoutProblems(result.ledger ?? [])) log.info(`[ERD Studio] ${line}`);
    const firstProblem = result.problems.find((p) => p.file && fullPaths.has(p.file));
    const actions: Record<string, () => unknown> = {};
    if (firstProblem) actions[OPEN_FILE_BUTTON] = () => ui.openFileAt(fullPaths.get(firstProblem.file)!, firstProblem.line);
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
    },
    ...(changeOptions ? { changeOptions } : {}),
  }, { filePath, ...resume });
}

/**
 * Every `.sql` file in the open folder that the quick import takes — whose
 * start holds a CREATE TABLE with a column list, and, when there is one,
 * every file that adds keys to tables (ALTER TABLE … FOREIGN KEY, a
 * pg_dump-style constraints file: its relationships belong to the same
 * tables) or changes their columns (a later migration, applied in file
 * order) — from the start screen's own listing (`listImportFiles`: the same
 * folders skipped, the ERD Studio folder never read) and by its own test
 * (`isSqlScriptTaken`: never a dbt macro, a Databricks notebook or Oracle
 * DDL), so whatever the start screen offers is taken here. At most
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
  const { ours, gatherMessage } = sqlRun(ui, quiet);
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
  const engine = loadEngine(deps, ours);
  if (!engine) return undefined;
  const first = readAsDialects(engine, gathered.files, [order[0]]);
  const firstReading = first.get(order[0]);
  const whole = firstReading && firstReading.tablesRead === firstReading.tablesFound && firstReading.salvaged === 0 && firstReading.repaired === 0 && !firstReading.result.problems?.length;
  const readings = whole ? first : readAsDialects(engine, gathered.files, order, first);
  if (readings.size === 0) return ours('while converting the SQL', new Error('no dialect could convert the scripts'));
  const best = rankSqlDialectReadings([...readings.values()], detected)[0];
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
  telemetry.feature(SQL_DIALECT_FEATURES[chosenDialect]);
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
  const files: SqlDdlFile[] = [];
  const fullPaths = new Map<string, string>();
  let chars = 0;
  for (const entry of entries) {
    const size = await ui.fileSize?.(entry.fullPath).catch(() => undefined);
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
    // A dump's data (COPY blocks, INSERT statements) is not SQL to import: it neither counts nor is read.
    const { text, sqlChars } = withoutSqlData(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
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
    readFile: async (filePath) => decodeText(await vscode.workspace.fs.readFile(vscode.Uri.file(filePath))),
    pickDialect: async (items, options) => vscode.window.showQuickPick([...items], options),
    pickFiles: async (items, options) => vscode.window.showQuickPick([...items], { ...options, canPickMany: true }),
    readFileStart: (filePath, chars) => readTextStart(filePath, chars),
    fileSize: (filePath) => fileSize(filePath),
    showInformationMessage: async (message) => vscode.window.showInformationMessage(message),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    openFileAt: (filePath, line) => openTableFileAt(filePath, line),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
    showLogs: async () => { await vscode.commands.executeCommand(SHOW_LOGS_COMMAND); },
  };
}
