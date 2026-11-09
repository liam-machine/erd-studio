/**
 * Why an import, a draft or Convert to DBML did not get there (telemetry 2.0
 * B7, B9, B11; `src/services/importTelemetry.ts`): the fixed key each reason
 * is counted as, the clause classes matched on the device, the write class,
 * Convert's refusal kinds, and the featureQuiet recorder that keeps flags off
 * the onboarding trail. Every key is allowlisted; none carries a name or path.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERT_SLOW_MS,
  DRAFT_DROP_FEATURES,
  IMPORT_LIMIT_FEATURES,
  IMPORT_STOP_FEATURES,
  SQL_CLAUSE_FEATURES,
  SQL_FAIL_DIALECT_FEATURES,
  STORAGE_FEATURES,
  convertRefusalKeys,
  draftUnavailableFeature,
  dropQuietly,
  recordWriteFailure,
  sqlInvalidFeatures,
  writeFailureKey,
} from '../../src/services/importTelemetry';
import { DBML_SELF_CHECK_REFUSAL_END, dbmlConversionRefusalKind, planDbmlConversion } from '../../src/services/dbmlConversion';
import { rejectedSqlClause, sqlClauseOf, SQL_DIALECTS } from '../../src/services/sqlDdlImport';
import { ERROR_CODES, FEATURES, type HeartbeatBody } from '../../src/services/telemetryPayload';
import { TelemetryService, setTelemetryEndpointForTests, telemetry } from '../../src/services/telemetryService';
import { START_INTENTS } from '../../src/types/startActions';

const features = FEATURES as readonly string[];
const errors = ERROR_CODES as readonly string[];

describe('the SQL clause classes (matched on the device; only the class leaves)', () => {
  it.each([
    ['CREATE TABLE a (id int)', 'CreateTable'],
    ['create temporary table a (id int)', 'CreateTable'],
    ['CREATE GLOBAL TEMPORARY TABLE a', 'CreateTable'],
    ['CREATE OR REPLACE TABLE a (id int)', 'CreateOrReplace'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'CreateOrReplace'],
    ['ALTER TABLE a ADD COLUMN b int', 'AlterTable'],
    ['ALTER SEQUENCE s RESTART', 'Other'],
    ['CREATE VIEW v AS SELECT 1', 'CreateView'],
    ['CREATE MATERIALIZED VIEW v AS SELECT 1', 'CreateView'],
    ["COMMENT ON TABLE a IS 'x'", 'CommentOn'],
    ['CREATE UNIQUE INDEX ix ON a (id)', 'CreateIndex'],
    ['GRANT SELECT ON a TO bob', 'Grant'],
    ['REVOKE ALL ON a FROM bob', 'Grant'],
    ['SET search_path = x', 'SetUse'],
    ['USE warehouse', 'SetUse'],
    ['INSERT INTO a VALUES (1)', 'Other'],
    ['CREATE SCHEMA s', 'Other'],
  ] as const)('%s → %s', (text, clause) => {
    expect(sqlClauseOf(text)).toBe(clause);
  });

  it('a line that starts no statement (a column definition) is no class; a parse problem then takes its statement\'s', () => {
    expect(sqlClauseOf('  grant_id int,')).toBeUndefined();
    expect(sqlClauseOf(')')).toBeUndefined();
    const sql = 'CREATE TABLE a (\n  id int,\n  x int oops\n)';
    expect(rejectedSqlClause(sql, 3)).toBe('CreateTable');
    expect(rejectedSqlClause("CREATE TABLE a (id int)\nCOMMENT ON TABLE a IS 'x';", 2)).toBe('CommentOn');
    expect(rejectedSqlClause('CREATE OR REPLACE TABLE a (id int,,)', undefined)).toBe('CreateOrReplace');
    expect(rejectedSqlClause('', 9)).toBe('Other');
  });
});

describe('sqlInvalidFeatures', () => {
  it('one key per distinct kind, the first parse problem\'s clause, and the dialect it was read as', () => {
    expect(sqlInvalidFeatures([
      { kind: 'structure' },
      { kind: 'parse', clause: 'CommentOn' },
      { kind: 'parse', clause: 'Grant' },
      { kind: 'structure' },
      { kind: 'duplicateTable' },
    ], 'snowflake')).toEqual(['importSqlInvalidStructure', 'importSqlInvalidParse', 'importSqlInvalidDuplicateTable', 'importSqlRejectedCommentOn', 'importSqlFailSnowflake']);
    // No parse problem: no clause. A parse problem with no clause: Other. noFiles and an unknown kind count nothing.
    expect(sqlInvalidFeatures([{ kind: 'noCreateTable' }], 'mysql')).toEqual(['importSqlInvalidNoCreateTable', 'importSqlFailMysql']);
    expect(sqlInvalidFeatures([{ kind: 'parse' }], 'postgres')).toEqual(['importSqlInvalidParse', 'importSqlRejectedOther', 'importSqlFailPostgres']);
    expect(sqlInvalidFeatures([{ kind: 'noFiles' }, {}], 'databricks')).toEqual(['importSqlFailDatabricks']);
  });

  it('every dialect with a key and every clause has its allowlisted key (Oracle, BigQuery, Redshift and SQLite have none yet)', () => {
    for (const d of SQL_DIALECTS) {
      const key = SQL_FAIL_DIALECT_FEATURES[d];
      if (['oracle', 'bigquery', 'redshift', 'sqlite'].includes(d)) expect(key, d).toBeUndefined();
      else expect(features).toContain(key);
    }
    expect(sqlInvalidFeatures([{ kind: 'noCreateTable' }], 'oracle')).toEqual(['importSqlInvalidNoCreateTable']);
    for (const key of Object.values(SQL_CLAUSE_FEATURES)) expect(features).toContain(key);
  });
});

describe('the write class', () => {
  const fsError = (code: string) => Object.assign(new Error(`${code}: failed`), { code });

  it('permission and a full disk are the user\'s (features); anything else is ours (an error)', () => {
    expect(writeFailureKey(fsError('EACCES'))).toEqual({ feature: 'writeFailedPermission' });
    expect(writeFailureKey(fsError('EROFS'))).toEqual({ feature: 'writeFailedPermission' });
    expect(writeFailureKey(fsError('ENOSPC'))).toEqual({ feature: 'writeFailedDiskFull' });
    expect(writeFailureKey(new Error('boom'))).toEqual({ error: 'writeFailedOurs' });
    expect(writeFailureKey(undefined)).toEqual({ error: 'writeFailedOurs' });
    // A rollback failure carries the fs error as its cause.
    expect(writeFailureKey(Object.assign(new Error('could not put back'), { cause: fsError('EDQUOT') }))).toEqual({ feature: 'writeFailedDiskFull' });
  });

  it('recordWriteFailure records through the given recorders and never throws', () => {
    const seen: string[] = [];
    recordWriteFailure(fsError('EPERM'), { feature: (k) => seen.push(k), error: (c) => seen.push(`!${c}`) });
    recordWriteFailure(new Error('x'), { feature: (k) => seen.push(k), error: (c) => seen.push(`!${c}`) });
    expect(seen).toEqual(['writeFailedPermission', '!writeFailedOurs']);
    expect(() => recordWriteFailure(new Error('x'), { feature: () => { throw new Error('a'); }, error: () => { throw new Error('b'); } })).not.toThrow();
  });
});

describe('quiet drops and the automatic draft', () => {
  it('dropQuietly tells only a quiet run\'s host, and never throws', () => {
    const seen: string[] = [];
    dropQuietly({ quiet: true, quietDrop: (r) => seen.push(r) }, 'noDialect');
    dropQuietly({ quiet: false, quietDrop: (r) => seen.push(r) }, 'noLayer');
    dropQuietly(undefined, 'noLayer');
    dropQuietly({ quiet: true }, 'noLayer');
    expect(seen).toEqual(['noDialect']);
    expect(() => dropQuietly({ quiet: true, quietDrop: () => { throw new Error('x'); } }, 'badName')).not.toThrow();
  });

  it('draftUnavailableFeature names the draft it was going to be', () => {
    expect(draftUnavailableFeature('example', undefined)).toBe('draftUnavailableExample');
    expect(draftUnavailableFeature('example', 'importSqlDdl')).toBe('draftUnavailableExample');
    expect(draftUnavailableFeature('find', 'importSqlDdl')).toBe('draftUnavailableSqlDdl');
    expect(draftUnavailableFeature('find', 'importSemanticModel')).toBe('draftUnavailableSemanticModel');
    expect(draftUnavailableFeature('find', 'importDbmlFile')).toBe('draftUnavailableDbml');
    expect(draftUnavailableFeature('find', 'drawFromDbt')).toBe('draftUnavailableDbt');
    expect(draftUnavailableFeature('find', 'blank')).toBeUndefined();
    for (const intent of START_INTENTS) {
      const key = draftUnavailableFeature('find', intent);
      if (key) expect(features).toContain(key);
    }
  });
});

describe('Convert to DBML\'s refusal kinds', () => {
  it('reads each kind back from the planner\'s own refusals', async () => {
    const reserved = await planDbmlConversion({ layers: ['tables'], tablesDirIsLayer: false } as never);
    expect(reserved.refusals.map(dbmlConversionRefusalKind)).toEqual(['reservedLayer']);
    const legacy = await planDbmlConversion({ layers: [], legacyDbmlFiles: ['main/old.dbml'] } as never);
    expect(legacy.refusals.map(dbmlConversionRefusalKind)).toEqual(['legacyFiles']);
    expect(dbmlConversionRefusalKind(`Convert would write DBML that does not compile: a.dbml:1 x [1]. ${DBML_SELF_CHECK_REFUSAL_END}`)).toBe('selfCheck');
    expect(dbmlConversionRefusalKind('gold/tables/a.dbml: it holds a self-join')).toBe('other');
  });

  it('one key per distinct kind; the self-check is ours, an error', () => {
    expect(convertRefusalKeys(['other', 'selfCheck', 'other', 'reservedLayer', 'legacyFiles', 'selfCheck'])).toEqual([
      { feature: 'convertRefusedOther' },
      { error: 'convertToDbmlSelfCheck' },
      { feature: 'convertRefusedReservedLayer' },
      { feature: 'convertRefusedLegacyFiles' },
    ]);
    expect(CONVERT_SLOW_MS).toBe(60_000);
  });
});

describe('every key these maps hold is allowlisted', () => {
  it('features and error codes', () => {
    for (const key of [
      ...Object.values(IMPORT_LIMIT_FEATURES), ...Object.values(IMPORT_STOP_FEATURES),
      ...Object.values(DRAFT_DROP_FEATURES), ...Object.values(STORAGE_FEATURES),
      'writeFailedPermission', 'writeFailedDiskFull', 'importSqlTryAnotherDialect', 'quickSqlNoDialect', 'quickSqlDialectFallback',
      'importDbmlInvalidUse', 'importDbmlInvalidSyntax', 'importDbmlSeveralFieldsOneLine', 'importDbmlNoTables',
      'importSemanticModelNoModel', 'importSemanticModelParseTmdl', 'importSemanticModelParseBim', 'importSemanticModelSeveral',
      'draftWaitedForPrompt', 'startLookTimeout', 'startLookGaveUp', 'convertStopUnsaved', 'convertStopChangedDuringPreview',
      'convertNothingToDo', 'convertLeftAsIs', 'convertOver60s', 'legacyDbmlTreeWarned', 'canvasJsonV6', 'diagramDeleted',
    ]) expect(features, key).toContain(key);
    for (const code of ['importSqlEngineLoadFailed', 'importDbmlParserThrew', 'writeFailedOurs', 'startLookFailed', 'startContextFailed',
      'convertToDbmlSelfCheck', 'convertToDbmlUnrestored', 'convertSaveFailed']) expect(errors, code).toContain(code);
  });
});

describe('telemetry.featureQuiet: counted, never on the onboarding trail', () => {
  const mock = vscode as unknown as {
    _resetMockConfiguration: () => void;
    _setMockTelemetryEnabled: (enabled: boolean) => void;
    createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
  };
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: TelemetryService | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T10:00:00Z'));
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
  });
  afterEach(() => {
    service?.dispose();
    service = undefined;
    setTelemetryEndpointForTests(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a quiet key counts (once a day with once) while the trail keeps only what the user did', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-telemetry-quiet-'));
    service = new TelemetryService(mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '2.0.0' } }));
    service.start();
    telemetry.activation('project_found', true, 0);
    telemetry.feature('draftShown');
    telemetry.featureQuiet('draftThinDbt');
    telemetry.featureQuiet('draftThinDbt');
    telemetry.featureQuiet('storageYaml', true);
    telemetry.featureQuiet('storageYaml', true);

    vi.setSystemTime(new Date('2026-11-08T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as HeartbeatBody;
    expect(body.features).toMatchObject({ draftShown: 1, draftThinDbt: 2, storageYaml: 1 });
    expect((body.trail ?? []).map((e) => e[0])).toEqual(['windowOpened', 'draftShown']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
