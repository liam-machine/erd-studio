/**
 * Import outcomes (`src/services/importOutcomeTelemetry.ts`): one fixed key
 * per importer and outcome, per SQL dialect and outcome, and per loss-ledger
 * cause class an import met. Never a name, path, message or size.
 */
import { describe, expect, it } from 'vitest';

import {
  IMPORT_OUTCOMES,
  IMPORT_OUTCOME_FEATURES,
  LEDGER_CAUSE_FEATURES,
  SQL_DIALECT_OUTCOME_FEATURES,
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
    expect(Object.keys(SQL_DIALECT_OUTCOME_FEATURES)).toEqual([...SQL_DIALECTS]);
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

describe('recordImportOutcome', () => {
  it('hands each key to the recorder, and never throws', () => {
    const got: string[] = [];
    recordImportOutcome((k) => got.push(k), { importer: 'powerbi', outcome: 'failed' });
    expect(got).toEqual(['importOutcomeSemanticModelFail']);
    expect(() => recordImportOutcome(() => { throw new Error('boom'); }, { importer: 'dbt' })).not.toThrow();
    expect(() => recordImportOutcome(() => {}, { importer: 'sql', ledger: null as never })).not.toThrow();
  });
});
