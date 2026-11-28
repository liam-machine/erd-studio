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
  SQL_DUPLICATE_FEATURES,
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
    // What was appended after them (the major update notice's keys) comes after, never between.
    const at = FEATURES.indexOf('draftDropTimeLimit');
    expect(FEATURES.slice(at + 1, at + 3 + FABRIC_KEYS.length)).toEqual(['importGuideActionFabricCatalog', 'importGuideCopiedFabricCatalog', ...FABRIC_KEYS]);
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

describe('what a SQL import\'s tables defined twice were (#358)', () => {
  const DUP_KEYS: readonly string[] = Object.values(SQL_DUPLICATE_FEATURES);
  /** A ledger holding one duplicate problem per entry of `dups`, plus `more`. */
  const withDuplicates = (n: number, more?: (l: ReturnType<typeof createLedger>) => void): LedgerEntry[] => ledgerOf((l) => {
    for (let i = 0; i < n; i++) l.problem('table', 'duplicate', 'table defined twice', { ...WHERE, line: i + 1 }, 'not read again: the first definition is kept');
    more?.(l);
  });
  const dupKeys = (report: Parameters<typeof importOutcomeFeatures>[0]): string[] => importOutcomeFeatures(report).filter((k) => DUP_KEYS.includes(k));
  const SAME = { same: true, defaultSchema: true };
  const DIFFERS = { same: false, defaultSchema: false };
  const DIFFERS_DEFAULT = { same: false, defaultSchema: true };

  it('are the four keys, in FEATURES, after #364\'s', () => {
    expect(DUP_KEYS).toEqual(['importDuplicateSame', 'importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
    expect(FEATURES.slice(FEATURES.indexOf('noReadyClosedOver60s') + 1, FEATURES.indexOf('noReadyClosedOver60s') + 5)).toEqual(DUP_KEYS);
  });

  it('importDuplicateSame: a copy, after the cause keys', () => {
    expect(importOutcomeFeatures({ importer: 'sql', dialect: 'postgres', ledger: withDuplicates(1), duplicates: [SAME] }))
      .toEqual(['importOutcomeSqlDdlPartial', 'importSqlOutcomePostgresPartial', 'importCauseDuplicate', 'importDuplicateSame', 'importPartialDuplicateOnly']);
  });

  it('importDuplicateDiffers: one that differs, in a schema of its own', () => {
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(1), duplicates: [DIFFERS] })).toEqual(['importDuplicateDiffers', 'importPartialDuplicateOnly']);
  });

  it('importDuplicateDiffersDefaultSchema: only beside Differs; a copy in the default schema is Same alone', () => {
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(1), duplicates: [DIFFERS_DEFAULT] }))
      .toEqual(['importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly']);
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(1), duplicates: [SAME] })).toEqual(['importDuplicateSame', 'importPartialDuplicateOnly']);
    // A copy in the default schema beside a difference in another: never paired.
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(2), duplicates: [SAME, DIFFERS] }))
      .toEqual(['importDuplicateSame', 'importDuplicateDiffers', 'importPartialDuplicateOnly']);
  });

  it('importPartialDuplicateOnly: only when every problem was a duplicate; fidelity notes do not count against it', () => {
    const unread = withDuplicates(1, (l) => l.problem('statement', 'parseError', 'statement', WHERE));
    expect(dupKeys({ importer: 'sql', ledger: unread, duplicates: [SAME] })).toEqual(['importDuplicateSame']);
    const noted = withDuplicates(1, (l) => { l.lost('column', 'unsupportedModifier', 'ON UPDATE', WHERE); l.repaired('table', 'parseError', 'missing comma', WHERE); });
    expect(dupKeys({ importer: 'sql', ledger: noted, duplicates: [SAME] })).toEqual(['importDuplicateSame', 'importPartialDuplicateOnly']);
    // A cancelled or timed-out reading is not partial.
    const stopped = withDuplicates(1, (l) => l.problem('statement', 'cancelled', 'not read', WHERE));
    expect(importOutcomeFeatures({ importer: 'sql', ledger: stopped, duplicates: [SAME] })).not.toContain('importPartialDuplicateOnly');
  });

  it('each key at most once, however many tables were defined twice', () => {
    const keys = importOutcomeFeatures({ importer: 'sql', ledger: withDuplicates(6), duplicates: [SAME, SAME, DIFFERS, DIFFERS_DEFAULT, DIFFERS_DEFAULT, SAME] });
    expect(keys.filter((k) => DUP_KEYS.includes(k))).toEqual(DUP_KEYS);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('SQL only: another importer\'s report never carries them', () => {
    for (const importer of ['powerbi', 'dbml', 'dbt'] as const) {
      expect(dupKeys({ importer, ledger: withDuplicates(1), duplicates: [SAME, DIFFERS_DEFAULT] }), importer).toEqual([]);
    }
  });

  it('a class key is present if and only if there are duplicates beside importCauseDuplicate, and never without it', () => {
    const classes = [SAME, DIFFERS, DIFFERS_DEFAULT, { same: true, defaultSchema: false }];
    const ledgers: Array<[string, LedgerEntry[]]> = [
      ['none', []],
      ['duplicate', withDuplicates(1)],
      ['replaced', ledgerOf((l) => l.changed('table', 'duplicate', 'CREATE OR REPLACE', WHERE))],
      ['parse', ledgerOf((l) => l.problem('statement', 'parseError', 'statement', WHERE))],
      ['both', withDuplicates(2, (l) => l.problem('statement', 'parseError', 'statement', WHERE))],
    ];
    for (const [name, ledger] of ledgers) {
      for (let mask = 0; mask < 1 << classes.length; mask++) {
        const duplicates = classes.filter((_, i) => mask & (1 << i));
        for (const outcome of [undefined, 'clean', 'partial', 'failed'] as const) {
          const keys = importOutcomeFeatures({ importer: 'sql', dialect: 'mysql', ledger, duplicates, ...(outcome ? { outcome } : {}) });
          const classKeys = keys.filter((k) => DUP_KEYS.includes(k));
          const cause = keys.includes('importCauseDuplicate');
          expect(classKeys.length > 0, `${name} ${mask} ${outcome}`).toBe(duplicates.length > 0 && cause);
          if (classKeys.length > 0) expect(cause).toBe(true);
          if (classKeys.includes('importPartialDuplicateOnly')) expect(keys[0]).toBe('importOutcomeSqlDdlPartial');
        }
      }
    }
  });

  it('a malformed list counts nothing and never throws', () => {
    for (const duplicates of [[null], [undefined], ['same'], [1], {} as never, 'x' as never]) {
      expect(() => importOutcomeFeatures({ importer: 'sql', ledger: withDuplicates(1), duplicates: duplicates as never })).not.toThrow();
    }
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(1), duplicates: [null, 'same'] as never })).toEqual([]);
    // A class with non-boolean flags is read as a difference, never as a copy or the default schema.
    expect(dupKeys({ importer: 'sql', ledger: withDuplicates(1), duplicates: [{ same: 'yes', defaultSchema: 1 }] as never }))
      .toEqual(['importDuplicateDiffers', 'importPartialDuplicateOnly']);
  });
});
