/**
 * Why an import, a draft or Convert to DBML did not get there (telemetry 2.0
 * B7, B9, B11): the fixed keys each reason is counted as, chosen on the device
 * from a code branch or a fixed enum. Never a name, path, line, statement or
 * parser message: those stay in the log.
 *
 * vscode-free and pure: the commands call these and record what they return.
 */

import { classifyWriteFailure } from './commandErrors';
import type { SqlClause, SqlDdlProblem, SqlDialect, SqlProblemKind } from './sqlDdlImport';
import type { TelemetryErrorCode, TelemetryFeature } from './telemetryPayload';
import type { DbmlConversionRefusalKind } from './dbmlConversion';
import type { ProjectStorage } from '@erd-studio/core';
import type { StartIntent } from '../types/startActions';

// ---------------------------------------------------------------------------
// B7: SQL DDL
// ---------------------------------------------------------------------------

const SQL_INVALID_KIND_FEATURES: Readonly<Partial<Record<SqlProblemKind, TelemetryFeature>>> = {
  parse: 'importSqlInvalidParse',
  structure: 'importSqlInvalidStructure',
  duplicateTable: 'importSqlInvalidDuplicateTable',
  noCreateTable: 'importSqlInvalidNoCreateTable',
};

export const SQL_CLAUSE_FEATURES: Readonly<Record<SqlClause, TelemetryFeature>> = {
  CreateTable: 'importSqlRejectedCreateTable',
  CreateOrReplace: 'importSqlRejectedCreateOrReplace',
  AlterTable: 'importSqlRejectedAlterTable',
  CreateView: 'importSqlRejectedCreateView',
  CommentOn: 'importSqlRejectedCommentOn',
  CreateIndex: 'importSqlRejectedCreateIndex',
  Grant: 'importSqlRejectedGrant',
  SetUse: 'importSqlRejectedSetUse',
  Other: 'importSqlRejectedOther',
};

/** The dialect SQL that did not convert was read as (Oracle, BigQuery, Redshift and SQLite have no key yet). */
export const SQL_FAIL_DIALECT_FEATURES: Readonly<Partial<Record<SqlDialect, TelemetryFeature>>> = {
  postgres: 'importSqlFailPostgres',
  mysql: 'importSqlFailMysql',
  sqlserver: 'importSqlFailSqlserver',
  snowflake: 'importSqlFailSnowflake',
  databricks: 'importSqlFailDatabricks',
};

/**
 * What SQL that did not convert records, beside `importSqlDdlInvalid`: one
 * key per distinct problem kind, the first parse problem's clause, and the
 * dialect it was read as.
 */
export function sqlInvalidFeatures(problems: readonly Pick<SqlDdlProblem, 'kind' | 'clause'>[], dialect: SqlDialect): TelemetryFeature[] {
  const out: TelemetryFeature[] = [];
  for (const p of problems) {
    const key = p.kind ? SQL_INVALID_KIND_FEATURES[p.kind] : undefined;
    if (key && !out.includes(key)) out.push(key);
  }
  const firstParse = problems.find((p) => p.kind === 'parse');
  if (firstParse) out.push(SQL_CLAUSE_FEATURES[firstParse.clause ?? 'Other']);
  const failed = SQL_FAIL_DIALECT_FEATURES[dialect];
  if (failed) out.push(failed);
  return out;
}

// ---------------------------------------------------------------------------
// B7: input limits, write stops and write class (every import)
// ---------------------------------------------------------------------------

/** Why an import's input could not be taken in (`gatherSqlFiles` and the semantic-model and DBML reads). */
export type ImportInputLimit = 'tooManyFiles' | 'fileTooBig' | 'tooMuchText' | 'unreadable';

export const IMPORT_LIMIT_FEATURES: Readonly<Record<ImportInputLimit, TelemetryFeature>> = {
  tooManyFiles: 'importLimitTooManyFiles',
  fileTooBig: 'importLimitFileTooBig',
  tooMuchText: 'importLimitTooMuchText',
  unreadable: 'importInputUnreadable',
};

/** Why an import stopped before writing, on the project's state (Import DBML's write step, Import from dbt's). */
export type ImportStop = 'noLayers' | 'yamlInDbml' | 'unsaved' | 'nameTaken' | 'refusedWrite';

export const IMPORT_STOP_FEATURES: Readonly<Record<ImportStop, TelemetryFeature>> = {
  noLayers: 'importStopNoLayers',
  yamlInDbml: 'importStopYamlInDbml',
  unsaved: 'importStopUnsaved',
  nameTaken: 'importStopNameTaken',
  refusedWrite: 'importStopRefusedWrite',
};

/**
 * A write that failed, by class (`classifyWriteFailure`): the user's disk or
 * permissions are features; anything else is ours, an error. Recorded beside
 * the command's own `*Failed` code; the exception never leaves the device.
 */
export function writeFailureKey(err: unknown): { feature: TelemetryFeature } | { error: TelemetryErrorCode } {
  let failure: ReturnType<typeof classifyWriteFailure>;
  try {
    failure = classifyWriteFailure(err);
  } catch {
    failure = 'other';
  }
  if (failure === 'permission') return { feature: 'writeFailedPermission' };
  if (failure === 'disk-full') return { feature: 'writeFailedDiskFull' };
  return { error: 'writeFailedOurs' };
}

/** Record {@link writeFailureKey} through the given recorders. Never throws. */
export function recordWriteFailure(
  err: unknown,
  record: { feature(key: TelemetryFeature): void; error(code: TelemetryErrorCode): void },
): void {
  try {
    const key = writeFailureKey(err);
    if ('feature' in key) record.feature(key.feature);
    else record.error(key.error);
  } catch { /* telemetry never breaks the failure report it sits beside */ }
}

// ---------------------------------------------------------------------------
// B9: why the automatic draft did not appear
// ---------------------------------------------------------------------------

/**
 * Why a quiet run (the automatic draft) ended before its draft showed. Every
 * quiet early end reports one, through `quietDrop` on the draft options.
 */
export type DraftDropReason =
  | 'nothingFound'
  | 'unreadable'
  | 'noLayer'
  | 'badName'
  | 'nothingDrawable'
  | 'noDialect'
  /** Several dialects or models, or any other question the quiet run cannot ask. */
  | 'needsChoice'
  /** The import's time limit was reached before a table was read (SQL). */
  | 'timeLimit';

export const DRAFT_DROP_FEATURES: Readonly<Record<DraftDropReason, TelemetryFeature>> = {
  nothingFound: 'draftDropNothingFound',
  unreadable: 'draftDropUnreadable',
  noLayer: 'draftDropNoLayer',
  badName: 'draftDropBadName',
  nothingDrawable: 'draftDropNothingDrawable',
  noDialect: 'draftDropNoDialect',
  needsChoice: 'draftDropNeedsChoice',
  timeLimit: 'draftDropTimeLimit',
};

/** A quiet run (the automatic draft) ends before its draft: tell the host why. Only while quiet; never throws. */
export function dropQuietly(draft: { quiet?: boolean; quietDrop?(reason: DraftDropReason): void } | undefined, reason: DraftDropReason): void {
  if (!draft?.quiet) return;
  try {
    draft.quietDrop?.(reason);
  } catch { /* telemetry never changes how the run ends */ }
}

/** The automatic draft did not appear: which one it was going to be (`undefined` intent: the example). */
export function draftUnavailableFeature(kind: 'find' | 'example', intent: StartIntent | undefined): TelemetryFeature | undefined {
  if (kind === 'example') return 'draftUnavailableExample';
  switch (intent) {
    case 'importSqlDdl': return 'draftUnavailableSqlDdl';
    case 'importSemanticModel': return 'draftUnavailableSemanticModel';
    case 'importDbmlFile': return 'draftUnavailableDbml';
    case 'drawFromDbt': return 'draftUnavailableDbt';
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// B11: Convert to DBML
// ---------------------------------------------------------------------------

/** A refusal's kind, beside `convertToDbmlRefused` (the self-check is ours: an error). */
export function convertRefusalKey(kind: DbmlConversionRefusalKind): { feature: TelemetryFeature } | { error: TelemetryErrorCode } {
  switch (kind) {
    case 'selfCheck': return { error: 'convertToDbmlSelfCheck' };
    case 'reservedLayer': return { feature: 'convertRefusedReservedLayer' };
    case 'legacyFiles': return { feature: 'convertRefusedLegacyFiles' };
    default: return { feature: 'convertRefusedOther' };
  }
}

/** The keys a refused plan records: one per distinct refusal kind, in the order first met. */
export function convertRefusalKeys(kinds: readonly DbmlConversionRefusalKind[]): Array<{ feature: TelemetryFeature } | { error: TelemetryErrorCode }> {
  const seen = new Set<DbmlConversionRefusalKind>();
  const out: Array<{ feature: TelemetryFeature } | { error: TelemetryErrorCode }> = [];
  for (const kind of kinds) {
    if (seen.has(kind)) continue;
    seen.add(kind);
    out.push(convertRefusalKey(kind));
  }
  return out;
}

/** A conversion apply this slow is counted (`convertOver60s`). */
export const CONVERT_SLOW_MS = 60_000;

export const STORAGE_FEATURES: Readonly<Record<ProjectStorage, TelemetryFeature>> = {
  yaml: 'storageYaml',
  dbml: 'storageDbml',
  mixed: 'storageMixed',
};
