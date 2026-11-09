/**
 * How each import ended, and which kinds of loss it met (import telemetry):
 * one fixed key per importer and outcome, one per SQL dialect and outcome,
 * and one per loss-ledger cause class the import's ledger holds. Never a
 * name, path, statement, message or size: a cause key says only that the
 * import met that cause at least once (an event count, never how many
 * tables or columns), and the outcome is decided here from the ledger's
 * outcomes, so only fixed keys leave.
 *
 * The outcomes:
 *
 * - `clean` — the source read as written: the ledger has no `problem` and
 *   no `repaired` entry (fidelity notes, `lost` / `changed` / `skipped`,
 *   are counted by their cause keys, not here).
 * - `repaired` — everything read, but only after the repair ladder
 *   rewrote something (a `repaired` entry, and no `problem`).
 * - `partial` — something could not be read at all (a `problem` entry: a
 *   table, statement or file left out), and the rest imported.
 * - `failed` — the import started on a source and brought nothing in: the
 *   source did not read or held nothing to import, an input limit, or a
 *   failure of ours. Never the automatic draft's quiet early end (that is
 *   `draftDrop*`), a project stop (`importStop*`) or a cancel.
 * - `cancelled` — the user stopped an import while it was reading the
 *   source. A closed picker or a discarded draft keeps its own keys.
 * - `timedOut` — the import's time limit stopped it while it was reading.
 *
 * `clean`, `repaired` and `partial` are counted once per plan an import
 * builds (its draft, or the dry run without one): never on a redraw of the
 * same draft; Change options… and Try Again build a new plan, so they count
 * again. `cancelled` and `timedOut` come from the import worker's outcome,
 * through {@link importOutcomeFeatures} like every other.
 *
 * vscode-free and pure: the commands call {@link recordImportOutcome} with
 * `telemetry.featureQuiet` (off the onboarding trail, like the draft quality
 * flags), so a failure to work the keys out never reaches the import.
 *
 * Adding a ledger cause (`LedgerCause` in `importLedger.ts`) fails the
 * compile here until it has a key: append `importCause<Cause>` to FEATURES
 * in `telemetryPayload.ts` and `telemetry/src/index.js` (same order), list it
 * under "Keys added in 2.0.0" in `telemetry/README.md` and in `telemetry.json`,
 * and deploy the Worker before the release.
 */

import type { LedgerCause, LedgerEntry } from './importLedger';
import type { SqlDialect } from './sqlDdlModel';
import type { TelemetryFeature } from './telemetryPayload';

/** The importers counted: SQL DDL, a Power BI / Fabric semantic model, a DBML file, a dbt project. */
export type ImportOutcomeImporter = 'sql' | 'powerbi' | 'dbml' | 'dbt';

export type ImportOutcome = 'clean' | 'repaired' | 'partial' | 'failed' | 'cancelled' | 'timedOut';

/** The outcomes a finished reading can have (the rest end an import before it has a ledger to judge). */
export type ImportReadOutcome = Extract<ImportOutcome, 'clean' | 'repaired' | 'partial'>;

export const IMPORT_OUTCOMES: readonly ImportOutcome[] = Object.freeze(['clean', 'repaired', 'partial', 'failed', 'cancelled', 'timedOut']);

/**
 * Importer × outcome. The importer tokens are the ones the other import keys
 * use (`draftThinSqlDdl`, `importSemanticModelInvalid`…): `powerbi` is
 * `SemanticModel`. `failed` is `Fail`: a feature key never ends in `Failed`
 * (that suffix is an error code's).
 */
export const IMPORT_OUTCOME_FEATURES: Readonly<Record<ImportOutcomeImporter, Readonly<Record<ImportOutcome, TelemetryFeature>>>> = {
  sql: {
    clean: 'importOutcomeSqlDdlClean',
    repaired: 'importOutcomeSqlDdlRepaired',
    partial: 'importOutcomeSqlDdlPartial',
    failed: 'importOutcomeSqlDdlFail',
    cancelled: 'importOutcomeSqlDdlCancelled',
    timedOut: 'importOutcomeSqlDdlTimedOut',
  },
  powerbi: {
    clean: 'importOutcomeSemanticModelClean',
    repaired: 'importOutcomeSemanticModelRepaired',
    partial: 'importOutcomeSemanticModelPartial',
    failed: 'importOutcomeSemanticModelFail',
    cancelled: 'importOutcomeSemanticModelCancelled',
    timedOut: 'importOutcomeSemanticModelTimedOut',
  },
  dbml: {
    clean: 'importOutcomeDbmlClean',
    repaired: 'importOutcomeDbmlRepaired',
    partial: 'importOutcomeDbmlPartial',
    failed: 'importOutcomeDbmlFail',
    cancelled: 'importOutcomeDbmlCancelled',
    timedOut: 'importOutcomeDbmlTimedOut',
  },
  dbt: {
    clean: 'importOutcomeDbtClean',
    repaired: 'importOutcomeDbtRepaired',
    partial: 'importOutcomeDbtPartial',
    failed: 'importOutcomeDbtFail',
    cancelled: 'importOutcomeDbtCancelled',
    timedOut: 'importOutcomeDbtTimedOut',
  },
};

/** SQL dialect × outcome, beside the SQL importer's own key (only when the import had a dialect). */
export const SQL_DIALECT_OUTCOME_FEATURES: Readonly<Record<SqlDialect, Readonly<Record<ImportOutcome, TelemetryFeature>>>> = {
  postgres: {
    clean: 'importSqlOutcomePostgresClean',
    repaired: 'importSqlOutcomePostgresRepaired',
    partial: 'importSqlOutcomePostgresPartial',
    failed: 'importSqlOutcomePostgresFail',
    cancelled: 'importSqlOutcomePostgresCancelled',
    timedOut: 'importSqlOutcomePostgresTimedOut',
  },
  mysql: {
    clean: 'importSqlOutcomeMysqlClean',
    repaired: 'importSqlOutcomeMysqlRepaired',
    partial: 'importSqlOutcomeMysqlPartial',
    failed: 'importSqlOutcomeMysqlFail',
    cancelled: 'importSqlOutcomeMysqlCancelled',
    timedOut: 'importSqlOutcomeMysqlTimedOut',
  },
  sqlserver: {
    clean: 'importSqlOutcomeSqlserverClean',
    repaired: 'importSqlOutcomeSqlserverRepaired',
    partial: 'importSqlOutcomeSqlserverPartial',
    failed: 'importSqlOutcomeSqlserverFail',
    cancelled: 'importSqlOutcomeSqlserverCancelled',
    timedOut: 'importSqlOutcomeSqlserverTimedOut',
  },
  snowflake: {
    clean: 'importSqlOutcomeSnowflakeClean',
    repaired: 'importSqlOutcomeSnowflakeRepaired',
    partial: 'importSqlOutcomeSnowflakePartial',
    failed: 'importSqlOutcomeSnowflakeFail',
    cancelled: 'importSqlOutcomeSnowflakeCancelled',
    timedOut: 'importSqlOutcomeSnowflakeTimedOut',
  },
  databricks: {
    clean: 'importSqlOutcomeDatabricksClean',
    repaired: 'importSqlOutcomeDatabricksRepaired',
    partial: 'importSqlOutcomeDatabricksPartial',
    failed: 'importSqlOutcomeDatabricksFail',
    cancelled: 'importSqlOutcomeDatabricksCancelled',
    timedOut: 'importSqlOutcomeDatabricksTimedOut',
  },
};

/** One key per ledger cause class, in `LedgerCause`'s order (the order they are recorded in). */
export const LEDGER_CAUSE_FEATURES: Readonly<Record<LedgerCause, TelemetryFeature>> = {
  parseError: 'importCauseParseError',
  grammarGap: 'importCauseGrammarGap',
  templatePlaceholder: 'importCauseTemplatePlaceholder',
  unknownType: 'importCauseUnknownType',
  reservedWord: 'importCauseReservedWord',
  trailingOption: 'importCauseTrailingOption',
  unsupportedModifier: 'importCauseUnsupportedModifier',
  proceduralBlock: 'importCauseProceduralBlock',
  notInFiles: 'importCauseNotInFiles',
  droppedLater: 'importCauseDroppedLater',
  noField: 'importCauseNoField',
  notDesign: 'importCauseNotDesign',
  renamed: 'importCauseRenamed',
  normalised: 'importCauseNormalised',
  inferred: 'importCauseInferred',
  capped: 'importCauseCapped',
  savedOptional: 'importCauseSavedOptional',
  duplicate: 'importCauseDuplicate',
  other: 'importCauseOther',
};

/** How a finished reading went, from its ledger alone (see the module comment). */
export function ledgerImportOutcome(entries: readonly LedgerEntry[]): ImportReadOutcome {
  let repaired = false;
  for (const e of entries) {
    if (!(e.count > 0)) continue;
    if (e.outcome === 'problem') return 'partial';
    if (e.outcome === 'repaired') repaired = true;
  }
  return repaired ? 'repaired' : 'clean';
}

/** What one import reports: the importer, how it ended (else read from the ledger), its SQL dialect and its ledger. */
export interface ImportOutcomeReport {
  importer: ImportOutcomeImporter;
  /** Omitted: {@link ledgerImportOutcome} of `ledger` (a finished reading). */
  outcome?: ImportOutcome;
  /** SQL only: the dialect the conversion ran with. */
  dialect?: SqlDialect;
  /** The import's loss ledger, conversion and plan together; its cause classes are counted once each. */
  ledger?: readonly LedgerEntry[];
}

/**
 * The keys one import records: its importer and outcome, its dialect and
 * outcome (SQL with a dialect), then one key per cause class its ledger holds,
 * in {@link LEDGER_CAUSE_FEATURES}' order. Each key at most once.
 */
export function importOutcomeFeatures(report: ImportOutcomeReport): TelemetryFeature[] {
  const ledger = report.ledger ?? [];
  const outcome = report.outcome ?? ledgerImportOutcome(ledger);
  const keys: TelemetryFeature[] = [];
  const byImporter = IMPORT_OUTCOME_FEATURES[report.importer]?.[outcome];
  if (!byImporter) return keys;
  keys.push(byImporter);
  if (report.importer === 'sql' && report.dialect) {
    const byDialect = SQL_DIALECT_OUTCOME_FEATURES[report.dialect]?.[outcome];
    if (byDialect) keys.push(byDialect);
  }
  const met = new Set<LedgerCause>();
  for (const e of ledger) if (e.count > 0) met.add(e.cause);
  for (const [cause, key] of Object.entries(LEDGER_CAUSE_FEATURES) as Array<[LedgerCause, TelemetryFeature]>) {
    if (met.has(cause)) keys.push(key);
  }
  return keys;
}

/** Records {@link importOutcomeFeatures} through `record`. Never throws: telemetry never breaks an import. */
export function recordImportOutcome(record: (key: TelemetryFeature) => void, report: ImportOutcomeReport): void {
  try {
    for (const key of importOutcomeFeatures(report)) record(key);
  } catch { /* never reaches the import */ }
}
