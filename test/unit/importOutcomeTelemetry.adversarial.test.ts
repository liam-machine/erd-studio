/**
 * Import outcome telemetry, attacked (`importOutcomeTelemetry.ts`):
 *
 * - only keys in FEATURES ever leave, whatever string reaches the tables
 *   (an inherited property such as `toString` is not a key);
 * - one import is one outcome: a cancel or time limit reported twice, or a
 *   redraw of a draft already counted that then fails or throws, adds nothing;
 * - a ledger of thousands of entries is still a handful of fixed keys;
 * - with telemetry off nothing is counted at all.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
  IMPORT_OUTCOMES,
  LEDGER_CAUSE_FEATURES,
  importOutcomeFeatures,
  importOutcomeOnce,
  recordImportOutcome,
} from '../../src/services/importOutcomeTelemetry';
import { createLedger, type LedgerCause } from '../../src/services/importLedger';
import { FEATURES } from '../../src/services/telemetryPayload';
import { TelemetryService, telemetry } from '../../src/services/telemetryService';

const mock = vscode as unknown as {
  _setMockConfiguration: (section: string, key: string, values: { globalValue?: unknown }) => void;
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
};

const KNOWN = new Set<string>(FEATURES);
const INHERITED = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'];

describe('only keys in FEATURES leave', () => {
  it('an inherited property name as the importer, outcome or dialect records nothing of it', () => {
    for (const name of INHERITED) {
      const asOutcome = importOutcomeFeatures({ importer: 'sql', outcome: name as never });
      const asImporter = importOutcomeFeatures({ importer: name as never, outcome: 'toString' as never });
      const asDialect = importOutcomeFeatures({ importer: 'sql', outcome: 'failed', dialect: name as never });
      for (const key of [...asOutcome, ...asImporter, ...asDialect]) {
        expect(typeof key).toBe('string');
        expect(KNOWN.has(key)).toBe(true);
      }
      expect(asOutcome).toEqual([]);
      expect(asImporter).toEqual([]);
      expect(asDialect).toEqual(['importOutcomeSqlDdlFail']);
    }
  });

  it('a ledger cause outside LedgerCause (an inherited name, a table name) adds no key', () => {
    const ledger = [
      { outcome: 'lost', unit: 'column', cause: 'toString', what: 'x', count: 1 },
      { outcome: 'lost', unit: 'column', cause: 'dim_customer', what: 'x', count: 1 },
    ] as never;
    expect(importOutcomeFeatures({ importer: 'dbml', ledger })).toEqual(['importOutcomeDbmlClean']);
  });

  it('a ledger of thousands of entries is at most one key per importer, dialect and cause, none of them a size', () => {
    const ledger = createLedger();
    const causes = Object.keys(LEDGER_CAUSE_FEATURES) as LedgerCause[];
    for (let i = 0; i < 5000; i++) {
      ledger.lost('column', causes[i % causes.length], `phrase ${i}`, { table: `t_${i}`, column: `c_${i}`, file: `/secret/${i}.sql`, line: i }, `detail ${i}`, i + 1);
    }
    const started = performance.now();
    const keys = importOutcomeFeatures({ importer: 'sql', dialect: 'mysql', ledger: ledger.entries });
    expect(performance.now() - started).toBeLessThan(200);
    expect(keys.length).toBe(2 + causes.length);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(KNOWN.has(key)).toBe(true);
      expect(key).not.toMatch(/\d/);
    }
  });
});

describe('one import is one outcome (the hook for the worker\'s cancel and time limit)', () => {
  it('a cancel reported twice, or a time limit and then a cancel, counts the first only', () => {
    const got: string[] = [];
    const count = importOutcomeOnce((k) => got.push(k));
    count({ importer: 'sql', outcome: 'cancelled', dialect: 'postgres' });
    count({ importer: 'sql', outcome: 'cancelled', dialect: 'postgres' });
    count({ importer: 'sql', outcome: 'timedOut', dialect: 'postgres' });
    expect(got).toEqual(['importOutcomeSqlDdlCancelled', 'importSqlOutcomePostgresCancelled']);
    expect(count.counted()).toBe(true);
  });

  it('a recorder that throws still uses up the import\'s one outcome, and never reaches the caller', () => {
    let calls = 0;
    const count = importOutcomeOnce(() => { calls++; throw new Error('boom'); });
    expect(() => count({ importer: 'dbt', outcome: 'timedOut' })).not.toThrow();
    expect(() => count({ importer: 'dbt', outcome: 'cancelled' })).not.toThrow();
    expect(calls).toBe(1);
  });

  it('every outcome has a key for every importer, so the hook never silently counts nothing', () => {
    for (const importer of ['sql', 'powerbi', 'dbml', 'dbt'] as const) {
      for (const outcome of IMPORT_OUTCOMES) expect(importOutcomeFeatures({ importer, outcome })).toHaveLength(1);
    }
  });
});

describe('telemetry off counts nothing', () => {
  const COUNTERS_KEY = 'erdStudio.telemetry.counters';
  let services: TelemetryService[] = [];

  function start(): vscode.ExtensionContext {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-outcome-off-'));
    const context = mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '2.0.0' } });
    const service = new TelemetryService(context);
    services.push(service);
    service.start();
    return context;
  }
  const featuresOf = (context: vscode.ExtensionContext): Record<string, number> =>
    context.globalState.get<{ features?: Record<string, number> }>(COUNTERS_KEY)?.features ?? {};

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
  });
  afterEach(() => {
    for (const s of services) s.dispose();
    services = [];
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
    vi.unstubAllGlobals();
  });

  const anImport = (): void => recordImportOutcome((k) => telemetry.featureQuiet(k), {
    importer: 'sql', dialect: 'snowflake', ledger: createLedger().entries,
  });

  it('on: the outcome is counted', () => {
    const context = start();
    anImport();
    expect(featuresOf(context)).toMatchObject({ importOutcomeSqlDdlClean: 1, importSqlOutcomeSnowflakeClean: 1 });
  });

  it('erdStudio.telemetry.enabled false: nothing is counted', () => {
    mock._setMockConfiguration('erdStudio', 'telemetry.enabled', { globalValue: false });
    const context = start();
    anImport();
    expect(Object.keys(featuresOf(context)).filter((k) => k.startsWith('import'))).toEqual([]);
  });

  it('VS Code\'s telemetry off: nothing is counted', () => {
    mock._setMockTelemetryEnabled(false);
    const context = start();
    anImport();
    expect(Object.keys(featuresOf(context)).filter((k) => k.startsWith('import'))).toEqual([]);
  });
});
