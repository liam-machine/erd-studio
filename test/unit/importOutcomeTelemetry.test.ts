/**
 * Import outcomes (`src/services/importOutcomeTelemetry.ts`): one fixed key
 * per importer and outcome, per SQL dialect and outcome, and per loss-ledger
 * cause class an import met. Never a name, path, message or size.
 */
import { describe, expect, it } from 'vitest';

import {
  GUIDE_SOURCE_OUTCOME_FEATURES,
  IMPORT_GUIDE_SOURCES,
  IMPORT_OUTCOMES,
  IMPORT_OUTCOME_FEATURES,
  LEDGER_CAUSE_FEATURES,
  SQL_DIALECT_OUTCOME_FEATURES,
  importGuideSourceOfImportArg,
  importOutcomeFeatures,
  ledgerImportOutcome,
  recordImportOutcome,
} from '../../src/services/importOutcomeTelemetry';
import { createLedger, type LedgerEntry } from '../../src/services/importLedger';
import { SQL_DIALECTS } from '../../src/services/sqlDdlImport';
import { FEATURES, type TelemetryFeature } from '../../src/services/telemetryPayload';

const ALL_KEYS: TelemetryFeature[] = [
  ...Object.values(IMPORT_OUTCOME_FEATURES).flatMap((byOutcome) => Object.values(byOutcome)),
  ...Object.values(SQL_DIALECT_OUTCOME_FEATURES).flatMap((byOutcome) => Object.values(byOutcome)),
  ...Object.values(LEDGER_CAUSE_FEATURES),
];

/** A ledger with names, paths and phrases in every field a user's file can reach. */
function ledgerOf(build: (l: ReturnType<typeof createLedger>) => void): LedgerEntry[] {
  const l = createLedger();
  build(l);
  return l.entries;
}

const WHERE = { file: '/Users/jane.doe/acme/schema.sql', line: 12, table: 'dim_customer', column: 'lifetime_value_aud' };

describe('the key tables', () => {
  it('are every importer, outcome, dialect and cause, each key in FEATURES once', () => {
    expect(Object.keys(IMPORT_OUTCOME_FEATURES)).toEqual(['sql', 'powerbi', 'dbml', 'dbt']);
    for (const byOutcome of Object.values(IMPORT_OUTCOME_FEATURES)) expect(Object.keys(byOutcome)).toEqual([...IMPORT_OUTCOMES]);
    // Oracle, BigQuery, Redshift and SQLite have no dialect keys yet (a new key is a telemetry contract change, the Worker first).
    expect(Object.keys(SQL_DIALECT_OUTCOME_FEATURES)).toEqual(SQL_DIALECTS.filter((d) => !['oracle', 'bigquery', 'redshift', 'sqlite'].includes(d)));
    for (const byOutcome of Object.values(SQL_DIALECT_OUTCOME_FEATURES)) expect(Object.keys(byOutcome)).toEqual([...IMPORT_OUTCOMES]);
    expect(Object.keys(LEDGER_CAUSE_FEATURES)).toHaveLength(21);
    expect(ALL_KEYS).toHaveLength(24 + 30 + 21);
    expect(new Set(ALL_KEYS).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) expect(FEATURES, key).toContain(key);
  });

  it('are appended to FEATURES as one run, in table order, after the last 2.0 launch key', () => {
    const at = FEATURES.indexOf('importOutcomeSqlDdlClean');
    expect(FEATURES[at - 1]).toBe('crashFallbackFeedback');
    expect(FEATURES.slice(at, at + ALL_KEYS.length)).toEqual(ALL_KEYS);
  });

  it('never end in Failed (an error code\'s suffix): `failed` is Fail', () => {
    expect(ALL_KEYS.filter((k) => /Failed$/.test(k))).toEqual([]);
    expect(IMPORT_OUTCOME_FEATURES.sql.failed).toBe('importOutcomeSqlDdlFail');
  });
});

describe('ledgerImportOutcome', () => {
  it('clean: nothing could not be read and nothing was repaired (fidelity notes do not count)', () => {
    expect(ledgerImportOutcome([])).toBe('clean');
    expect(ledgerImportOutcome(ledgerOf((l) => {
      l.lost('column', 'noField', 'UNSIGNED', WHERE);
      l.changed('relationship', 'savedOptional', 'NOT NULL foreign key');
      l.skipped('statement', 'notDesign', 'view', WHERE);
    }))).toBe('clean');
  });

  it('repaired: the repair ladder rewrote something, and everything read', () => {
    expect(ledgerImportOutcome(ledgerOf((l) => {
      l.changed('type', 'normalised', 'int4');
      l.repaired('column', 'parseError', 'missing comma', WHERE);
    }))).toBe('repaired');
  });

  it('partial: something could not be read, whatever else was repaired', () => {
    expect(ledgerImportOutcome(ledgerOf((l) => {
      l.repaired('column', 'parseError', 'missing comma', WHERE);
      l.problem('table', 'grammarGap', 'CREATE TABLE', WHERE);
    }))).toBe('partial');
  });

  it('cancelled / timedOut: a reading the import worker stopped early, ahead of partial', () => {
    expect(ledgerImportOutcome(ledgerOf((l) => {
      l.problem('table', 'grammarGap', 'CREATE TABLE', WHERE);
      l.problem('table', 'cancelled', 'CREATE TABLE', WHERE, 'not read: the import was cancelled first', 12);
    }))).toBe('cancelled');
    expect(ledgerImportOutcome(ledgerOf((l) => {
      l.problem('statement', 'timeLimit', '', WHERE, 'not read: the time limit (2 min) was reached first', 3);
      l.problem('table', 'cancelled', 'CREATE TABLE', WHERE);
    }))).toBe('timedOut');
    // A cause on another outcome is only a cause key.
    expect(ledgerImportOutcome(ledgerOf((l) => { l.skipped('statement', 'cancelled', '', WHERE); }))).toBe('clean');
    expect(importOutcomeFeatures({
      importer: 'sql',
      dialect: 'postgres',
      ledger: ledgerOf((l) => { l.problem('table', 'timeLimit', 'CREATE TABLE', WHERE, undefined, 40); }),
    })).toEqual(['importOutcomeSqlDdlTimedOut', 'importSqlOutcomePostgresTimedOut', 'importCauseTimeLimit']);
  });

  it('ignores an entry with no count', () => {
    expect(ledgerImportOutcome([{ outcome: 'problem', unit: 'table', cause: 'parseError', what: 'x', count: 0 }])).toBe('clean');
  });
});

describe('importOutcomeFeatures', () => {
  it('SQL: the importer and the dialect by outcome, then each cause class met once, in the table order', () => {
    const ledger = ledgerOf((l) => {
      l.skipped('statement', 'notDesign', 'view', WHERE);
      l.problem('table', 'parseError', 'CREATE TABLE', WHERE);
      l.problem('table', 'parseError', 'CREATE TABLE', { ...WHERE, table: 'fct_order' });
      l.lost('column', 'unknownType', 'VECTOR', WHERE, undefined, 40);
    });
    expect(importOutcomeFeatures({ importer: 'sql', dialect: 'snowflake', ledger })).toEqual([
      'importOutcomeSqlDdlPartial',
      'importSqlOutcomeSnowflakePartial',
      'importCauseParseError',
      'importCauseUnknownType',
      'importCauseNotDesign',
    ]);
  });

  it('an outcome given wins over the ledger (failed, cancelled, timed out)', () => {
    const ledger = ledgerOf((l) => l.problem('file', 'other', 'no CREATE TABLE with a column list'));
    expect(importOutcomeFeatures({ importer: 'sql', outcome: 'failed', dialect: 'mysql', ledger }))
      .toEqual(['importOutcomeSqlDdlFail', 'importSqlOutcomeMysqlFail', 'importCauseOther']);
    expect(importOutcomeFeatures({ importer: 'sql', outcome: 'timedOut', dialect: 'databricks' }))
      .toEqual(['importOutcomeSqlDdlTimedOut', 'importSqlOutcomeDatabricksTimedOut']);
    expect(importOutcomeFeatures({ importer: 'dbml', outcome: 'cancelled' })).toEqual(['importOutcomeDbmlCancelled']);
  });

  it('no dialect key without a dialect, or for an importer that is not SQL', () => {
    expect(importOutcomeFeatures({ importer: 'sql' })).toEqual(['importOutcomeSqlDdlClean']);
    expect(importOutcomeFeatures({ importer: 'powerbi', dialect: 'postgres' })).toEqual(['importOutcomeSemanticModelClean']);
    expect(importOutcomeFeatures({ importer: 'dbt', ledger: ledgerOf((l) => l.changed('relationship', 'savedOptional', 'NOT NULL foreign key', undefined, undefined, 12)) }))
      .toEqual(['importOutcomeDbtClean', 'importCauseSavedOptional']);
  });

  it('an unknown importer or outcome (a caller outside the types) records nothing', () => {
    expect(importOutcomeFeatures({ importer: 'excel' as never })).toEqual([]);
    expect(importOutcomeFeatures({ importer: 'sql', outcome: 'exploded' as never })).toEqual([]);
  });

  it('says nothing of the file: only fixed keys, never a name, path, phrase or count', () => {
    const ledger = ledgerOf((l) => {
      for (const cause of Object.keys(LEDGER_CAUSE_FEATURES)) {
        l.lost('column', cause as never, 'WITH TIME ZONE', WHERE, 'kept as text (jane.doe)', 73);
      }
    });
    const keys = importOutcomeFeatures({ importer: 'sql', dialect: 'postgres', ledger });
    for (const key of keys) expect(FEATURES).toContain(key);
    const text = JSON.stringify(keys);
    for (const secret of ['jane', 'acme', 'dim_customer', 'lifetime_value_aud', 'schema.sql', 'WITH TIME ZONE', '73', '12']) {
      expect(text).not.toContain(secret);
    }
    expect(keys.filter((k) => k.startsWith('importCause'))).toEqual(Object.values(LEDGER_CAUSE_FEATURES));
  });
});

describe('an import started from the import guide\'s Microsoft Fabric card', () => {
  const FABRIC_KEYS = Object.values(GUIDE_SOURCE_OUTCOME_FEATURES.fabric);

  it('has one key per outcome, appended to FEATURES after every earlier key, in outcome order', () => {
    expect([...IMPORT_GUIDE_SOURCES]).toEqual(['fabric']);
    expect(Object.keys(GUIDE_SOURCE_OUTCOME_FEATURES.fabric)).toEqual([...IMPORT_OUTCOMES]);
    expect(FABRIC_KEYS).toEqual([
      'importFabricOutcomeClean', 'importFabricOutcomeRepaired', 'importFabricOutcomePartial',
      'importFabricOutcomeFail', 'importFabricOutcomeCancelled', 'importFabricOutcomeTimedOut',
    ]);
    expect(FABRIC_KEYS.filter((k) => /Failed$/.test(k))).toEqual([]);
    // Appended (the contract is additive): after the 2.0.0 list's last key, the guide's two Fabric keys first.
    const at = FEATURES.indexOf('draftDropTimeLimit');
    expect(FEATURES.slice(at + 1)).toEqual(['importGuideActionFabricCatalog', 'importGuideCopiedFabricCatalog', ...FABRIC_KEYS]);
  });

  it('counts the Fabric key beside the importer\'s and the dialect\'s, for every outcome, never instead of them', () => {
    for (const outcome of IMPORT_OUTCOMES) {
      expect(importOutcomeFeatures({ importer: 'sql', outcome, dialect: 'sqlserver', guideSource: 'fabric' }), outcome).toEqual([
        IMPORT_OUTCOME_FEATURES.sql[outcome],
        SQL_DIALECT_OUTCOME_FEATURES.sqlserver![outcome],
        GUIDE_SOURCE_OUTCOME_FEATURES.fabric[outcome],
      ]);
      // A catalog CSV has no dialect: the importer's key and the Fabric key.
      expect(importOutcomeFeatures({ importer: 'sql', outcome, guideSource: 'fabric' }), outcome).toEqual([
        IMPORT_OUTCOME_FEATURES.sql[outcome],
        GUIDE_SOURCE_OUTCOME_FEATURES.fabric[outcome],
      ]);
    }
    // From the ledger too, ahead of the cause keys.
    const ledger = ledgerOf((l) => l.problem('table', 'parseError', 'CREATE TABLE', WHERE));
    expect(importOutcomeFeatures({ importer: 'sql', dialect: 'sqlserver', guideSource: 'fabric', ledger }))
      .toEqual(['importOutcomeSqlDdlPartial', 'importSqlOutcomeSqlserverPartial', 'importFabricOutcomePartial', 'importCauseParseError']);
  });

  it('is absent without the marker, for an importer that is not SQL, and for a marker that is not the fixed literal', () => {
    const fabric = (keys: string[]) => keys.filter((k) => k.startsWith('importFabric'));
    for (const outcome of IMPORT_OUTCOMES) {
      expect(fabric(importOutcomeFeatures({ importer: 'sql', outcome, dialect: 'sqlserver' }))).toEqual([]);
      expect(fabric(importOutcomeFeatures({ importer: 'powerbi', outcome, guideSource: 'fabric' }))).toEqual([]);
      expect(fabric(importOutcomeFeatures({ importer: 'dbml', outcome, guideSource: 'fabric' }))).toEqual([]);
      for (const marker of ['Fabric', 'sqlServer', 'toString', '__proto__', 'constructor', '', 1, {}, ['fabric']]) {
        expect(importOutcomeFeatures({ importer: 'sql', outcome, dialect: 'sqlserver', guideSource: marker as never }), String(marker))
          .toEqual([IMPORT_OUTCOME_FEATURES.sql[outcome], SQL_DIALECT_OUTCOME_FEATURES.sqlserver![outcome]]);
      }
    }
  });

  it('the command argument carries it as one fixed literal; anything else is ignored, and { quick } wins', () => {
    expect(importGuideSourceOfImportArg({ dialect: 'sqlserver', source: 'fabric' })).toBe('fabric');
    expect(importGuideSourceOfImportArg({ source: 'fabric' })).toBe('fabric');
    for (const arg of [
      undefined, null, 'fabric', ['fabric'], [{ source: 'fabric' }], {}, { dialect: 'sqlserver' }, { source: 'Fabric' }, { source: 'databricks' },
      { source: 'sqlServer' }, { source: 1 }, { source: ['fabric'] }, { source: { toString: () => 'fabric' } }, { source: '/Users/jane.doe/acme' },
      { quick: true }, { quick: true, source: 'fabric' },
    ]) {
      expect(importGuideSourceOfImportArg(arg), JSON.stringify(arg)).toBeUndefined();
    }
  });
});

describe('recordImportOutcome', () => {
  it('hands each key to the recorder, and never throws', () => {
    const got: string[] = [];
    recordImportOutcome((k) => got.push(k), { importer: 'powerbi', outcome: 'failed' });
    expect(got).toEqual(['importOutcomeSemanticModelFail']);
    expect(() => recordImportOutcome(() => { throw new Error('boom'); }, { importer: 'dbt' })).not.toThrow();
    expect(() => recordImportOutcome(() => {}, { importer: 'sql', ledger: null as never })).not.toThrow();
  });
});
