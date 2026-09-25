/**
 * telemetryPayload — the pure half of usage telemetry.
 *
 * The heartbeat body is a contract with the Worker in `telemetry/`, so the
 * shape is pinned key for key. The last suite is the privacy guarantee: every
 * recorder is fed the kind of strings a real project is full of (model,
 * domain and column names, absolute paths, error text) wherever TypeScript
 * would let a careless caller put them, and none of it may reach the JSON.
 */

import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  FEATURES,
  MAX_ACTIVATIONS,
  MAX_CANVAS_OPENS,
  MAX_COUNTER,
  buildHeartbeat,
  daysBetween,
  domainCountBucket,
  emptyCounters,
  extVersion,
  heartbeatDue,
  modelCountBucket,
  nextDay,
  osBucket,
  recordActivation,
  recordCanvasOpen,
  recordCatalog,
  recordError,
  recordFeature,
  recordManifest,
  recordStage,
  tenureBucket,
  utcDay,
  vscodeMajor,
  type DailyCounters,
  type HeartbeatEnv,
  type TelemetryErrorCode,
  type TelemetryFeature,
} from '../../src/services/telemetryPayload';

const ENV: HeartbeatEnv = {
  installId: '3b241101-e2bb-4255-8caf-4136c566a962',
  extVersion: '1.4.0',
  vscodeVersion: '1.104.2',
  platform: 'darwin',
  firstSeenDay: '2026-09-01',
};

function repeat(state: DailyCounters, n: number, fn: (s: DailyCounters) => DailyCounters): DailyCounters {
  for (let i = 0; i < n; i++) state = fn(state);
  return state;
}

describe('buckets', () => {
  it('buckets tenure', () => {
    expect([0, 1, 7, 8, 30, 31, 90, 91, 400].map(tenureBucket)).toEqual(
      ['0', '1-7', '1-7', '8-30', '8-30', '31-90', '31-90', '90+', '90+'],
    );
  });

  it('buckets domain counts', () => {
    expect([0, 1, 3, 4, 10, 11, 500].map(domainCountBucket)).toEqual(['0', '1-3', '1-3', '4-10', '4-10', '10+', '10+']);
  });

  it('buckets model counts', () => {
    expect([0, 1, 10, 11, 50, 51, 900].map(modelCountBucket)).toEqual(['none', '1-10', '1-10', '11-50', '11-50', '51+', '51+']);
  });

  it('reduces versions and platforms to the allowed shapes', () => {
    expect(vscodeMajor('1.104.2')).toBe('1.104');
    expect(vscodeMajor('1.85.0-insider')).toBe('1.85');
    expect(vscodeMajor('garbage')).toBe('0.0');
    expect(extVersion('1.4.0-beta.1')).toBe('1.4.0');
    expect(extVersion('dev')).toBe('0.0.0');
    expect(['darwin', 'win32', 'linux', 'freebsd', 'aix'].map(osBucket)).toEqual(['darwin', 'win32', 'linux', 'other', 'other']);
  });

  it('counts whole UTC days', () => {
    expect(utcDay(new Date('2026-09-25T23:59:59Z'))).toBe('2026-09-25');
    expect(daysBetween('2026-09-24', '2026-09-25')).toBe(1);
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
    expect(daysBetween('2026-09-25', '2026-09-24')).toBe(-1);
  });
});

describe('reducers', () => {
  it('caps every counter', () => {
    let s = emptyCounters('2026-09-24');
    s = repeat(s, 80, x => recordActivation(x, { outcome: 'project_found', hasSemanticDir: true, domainCount: 2 }));
    s = repeat(s, 300, x => recordCanvasOpen(x, { stage: 'logical', format: 'v5', modelCount: 3 }));
    s = repeat(s, 250, x => recordFeature(x, 'addModel'));
    s = repeat(s, 250, x => recordError(x, 'domainLoad'));
    expect(s.activations).toBe(MAX_ACTIVATIONS);
    expect(s.canvasOpens).toBe(MAX_CANVAS_OPENS);
    expect(s.features.addModel).toBe(MAX_COUNTER);
    expect(s.errors.domainLoad).toBe(MAX_COUNTER);
  });

  it('keeps the largest model bucket and each stage and format once', () => {
    let s = emptyCounters('2026-09-24');
    s = recordCanvasOpen(s, { stage: 'logical', format: 'v5', modelCount: 60 });
    s = recordCanvasOpen(s, { stage: 'logical', format: 'v4', modelCount: 4 });
    s = recordStage(s, 'physical');
    s = recordStage(s, 'physical');
    expect(s.modelCount).toBe('51+');
    expect(s.stages).toEqual(['logical', 'physical']);
    expect(s.schemaFormats).toEqual(['v5', 'v4']);
  });

  it('never mutates its input', () => {
    const s = emptyCounters('2026-09-24');
    const frozen = JSON.stringify(s);
    recordFeature(s, 'compare');
    recordCanvasOpen(s, { stage: 'physical', format: 'v5', modelCount: 5 });
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('carries only the project facts into the next day', () => {
    let s = recordActivation(emptyCounters('2026-09-24'), { outcome: 'project_found', hasSemanticDir: true, domainCount: 5 });
    s = recordFeature(recordManifest(recordCatalog(s, true), 'ok'), 'syncPlan');
    const next = nextDay(s, '2026-09-25');
    expect(next).toEqual({
      ...emptyCounters('2026-09-25'),
      activation: 'project_found',
      hasSemanticDir: true,
      domainCount: '4-10',
    });
  });
});

describe('heartbeatDue', () => {
  const active = recordActivation(emptyCounters('2026-09-24'), { outcome: 'no_project', hasSemanticDir: false, domainCount: 0 });

  it('is due the day after an active day', () => {
    expect(heartbeatDue(active, '2026-09-25')).toBe(true);
  });

  it('is not due on the same day, for a future day, or past the Worker window', () => {
    expect(heartbeatDue(active, '2026-09-24')).toBe(false);
    expect(heartbeatDue(active, '2026-09-23')).toBe(false);
    expect(heartbeatDue(active, '2026-10-01')).toBe(true);
    expect(heartbeatDue(active, '2026-10-02')).toBe(false);
  });

  it('is not due for an idle carried-over day', () => {
    expect(heartbeatDue(nextDay(active, '2026-09-25'), '2026-09-26')).toBe(false);
    expect(heartbeatDue(recordFeature(nextDay(active, '2026-09-25'), 'compare'), '2026-09-26')).toBe(true);
  });
});

describe('buildHeartbeat', () => {
  it('produces exactly the contract body', () => {
    let s = emptyCounters('2026-09-24');
    s = recordActivation(s, { outcome: 'project_found', hasSemanticDir: true, domainCount: 7 });
    s = recordCanvasOpen(s, { stage: 'logical', format: 'v5', modelCount: 12 });
    s = recordStage(s, 'physical');
    s = recordManifest(s, 'stale');
    s = recordCatalog(s, true);
    s = recordFeature(recordFeature(s, 'compare'), 'compare');
    s = recordError(s, 'manifestMalformed');

    expect(buildHeartbeat(s, ENV)).toStrictEqual({
      v: 1,
      installId: ENV.installId,
      day: '2026-09-24',
      extVersion: '1.4.0',
      vscodeMajor: '1.104',
      os: 'darwin',
      tenure: '8-30',
      activation: 'project_found',
      hasSemanticDir: true,
      domainCount: '4-10',
      activations: 1,
      canvasOpens: 1,
      stages: ['logical', 'physical'],
      schemaFormats: ['v5'],
      modelCount: '11-50',
      manifest: 'stale',
      catalog: true,
      features: { compare: 2 },
      errors: { manifestMalformed: 1 },
    });
  });

  it('omits zero counts and drops any key outside the allowlists', () => {
    const s = {
      ...emptyCounters('2026-09-24'),
      activation: 'no_project' as const,
      features: { addModel: 0, compare: 3, dim_customer: 9 } as Record<string, number>,
      errors: { other: 1, '/Users/jane/secret.json': 4 } as Record<string, number>,
      domainName: 'customer-360',
    } as unknown as DailyCounters;
    const body = buildHeartbeat(s, ENV);
    expect(body.features).toEqual({ compare: 3 });
    expect(body.errors).toEqual({ other: 1 });
    expect(Object.keys(body)).not.toContain('domainName');
  });

  it('coerces corrupt stored values back into the allowed set', () => {
    const s = {
      ...emptyCounters('2026-09-24'),
      activation: 'project_found',
      domainCount: 'lots',
      modelCount: 42,
      manifest: 'broken',
      activations: 1e9,
      canvasOpens: -3,
      stages: ['logical', 'gold'],
      schemaFormats: ['v3'],
    } as unknown as DailyCounters;
    const body = buildHeartbeat(s, ENV);
    expect(body).toMatchObject({
      domainCount: '0',
      modelCount: 'none',
      manifest: 'unknown',
      activations: MAX_ACTIVATIONS,
      canvasOpens: 0,
      stages: ['logical'],
      schemaFormats: [],
    });
  });

  it('stays well under the 2 KB body limit with every counter set', () => {
    let s = recordActivation(emptyCounters('2026-09-24'), { outcome: 'project_found', hasSemanticDir: true, domainCount: 99 });
    for (const f of FEATURES) s = repeat(s, 150, x => recordFeature(x, f));
    for (const e of ERROR_CODES) s = repeat(s, 150, x => recordError(x, e));
    expect(JSON.stringify(buildHeartbeat(s, ENV)).length).toBeLessThan(2048);
  });
});

describe('nothing identifying reaches the heartbeat', () => {
  const SECRETS = [
    'dim_customer',
    'fct_order_line',
    'customer-360',
    'gold/commercial',
    'customer_id',
    'lifetime_value_aud',
    '/Users/jane.doe/work/acme-dbt/.erd-studio/gold/commercial.json',
    'C:\\Users\\jane\\acme\\target\\manifest.json',
    'manifest.json not found at /home/jane/acme/target',
    'jane.doe@acme.com.au',
  ];

  it('drops every string fed through every recorder', () => {
    let s = emptyCounters('2026-09-24');
    for (const secret of SECRETS) {
      const sneak = secret as never;
      s = recordActivation(s, { outcome: sneak, hasSemanticDir: sneak, domainCount: sneak });
      s = recordCanvasOpen(s, { stage: sneak, format: sneak, modelCount: sneak });
      s = recordStage(s, sneak);
      s = recordManifest(s, sneak);
      s = recordCatalog(s, sneak);
      s = recordFeature(s, sneak as TelemetryFeature);
      s = recordError(s, sneak as TelemetryErrorCode);
    }
    // Stored state must also survive an env that carries junk around the id.
    const json = JSON.stringify(buildHeartbeat(s, { ...ENV, extVersion: `1.4.0 ${SECRETS[6]}`, vscodeVersion: `1.104 ${SECRETS[0]}` }));
    for (const secret of SECRETS) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toContain('jane');
    expect(json).not.toContain('acme');
  });
});
