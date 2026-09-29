/**
 * telemetryPayload — the pure half of usage telemetry.
 *
 * The heartbeat body is a contract with the Worker in `telemetry/`, so the
 * shape is pinned key for key. The last suite is the privacy guarantee: every
 * recorder is fed the kind of strings a real project is full of (model,
 * domain and column names, absolute paths, error text) wherever TypeScript
 * would let a careless caller put them, and none of it may reach the JSON.
 */

import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  ASSISTANTS,
  ERROR_CODES,
  FEATURES,
  HARNESSES,
  HOSTS,
  REMOTES,
  RETENTION_WINDOW_DAYS,
  firstCanvasBucket,
  hostBucket,
  layoutFeature,
  recentDaysBucket,
  recentDaysCount,
  recordAssistants,
  recordHarnesses,
  rememberDay,
  remoteBucket,
  stampEnv,
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
  modelFileErrorCode,
  nextDay,
  osBucket,
  recordActivation,
  recordCanvasOpen,
  recordCatalog,
  recordError,
  recordFeature,
  recordFeatureOnce,
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
      host: 'other',
      remote: 'local',
      dev: false,
      assistants: [],
      harnesses: [],
      activeDays28: '0',
      canvasDays28: '0',
      firstCanvas: 'never',
    });
  });

  it('sends the stamped environment, detected assistants, harnesses and retention buckets', () => {
    let s = emptyCounters('2026-09-24');
    s = recordActivation(s, { outcome: 'project_found', hasSemanticDir: true, domainCount: 2 });
    s = stampEnv(s, { extVersion: '1.6.3', vscodeVersion: '1.105.0', host: 'cursor', remote: 'wsl', dev: false });
    s = recordAssistants(s, ['gemini', 'claude']);
    s = recordHarnesses(s, ['agents']);
    const body = buildHeartbeat(s, {
      ...ENV,
      // Running a newer build when the heartbeat goes out: the day keeps the version that counted it.
      extVersion: '1.7.0',
      vscodeVersion: '1.106.1',
      host: 'vscode',
      activeDays: ['2026-08-20', '2026-09-10', '2026-09-20', '2026-09-24', '2026-09-25'],
      canvasDays: ['2026-09-24'],
      firstCanvasDay: '2026-09-24',
    });
    expect(body).toMatchObject({
      extVersion: '1.6.3',
      vscodeMajor: '1.105',
      host: 'cursor',
      remote: 'wsl',
      dev: false,
      assistants: ['claude', 'gemini'],
      harnesses: ['agents'],
      // 08-20 is outside the 28 days ending 09-24, and 09-25 is after it.
      activeDays28: '2-3',
      canvasDays28: '1',
      firstCanvas: '8-30',
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

  it('stays under the Worker\'s 4 KB body limit with every counter and list set', () => {
    let s = recordActivation(emptyCounters('2026-09-24'), { outcome: 'project_found', hasSemanticDir: true, domainCount: 99 });
    for (const f of FEATURES) s = repeat(s, 150, x => recordFeature(x, f));
    for (const e of ERROR_CODES) s = repeat(s, 150, x => recordError(x, e));
    s = recordHarnesses(recordAssistants(s, ASSISTANTS), HARNESSES);
    s = stampEnv(s, { extVersion: '10.10.10', vscodeVersion: '1.999.9', host: 'vscodeInsiders', remote: 'codespaces', dev: true });
    expect(JSON.stringify(buildHeartbeat(s, ENV)).length).toBeLessThan(4096);
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
      s = recordAssistants(s, [sneak]);
      s = recordHarnesses(s, [sneak]);
      s = stampEnv(s, { extVersion: secret, vscodeVersion: secret, host: hostBucket(secret), remote: remoteBucket(secret, false), dev: false });
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

describe('allowlists agree with the Worker', () => {
  // The Worker drops any `features` / `errors` key it does not list, so a key
  // added on one side only would be counted here and silently lost there.
  const worker = fs.readFileSync(path.join(__dirname, '../../telemetry/src/index.js'), 'utf8');
  const workerList = (name: string): string[] => {
    const match = worker.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    expect(match, `${name} not found in telemetry/src/index.js`).not.toBeNull();
    return [...match![1].matchAll(/'([A-Za-z0-9]+)'/g)].map(m => m[1]);
  };

  it('FEATURES matches the Worker key for key, in order', () => {
    expect(workerList('FEATURES')).toEqual([...FEATURES]);
  });

  it('ERROR_CODES matches the Worker key for key, in order', () => {
    expect(workerList('ERROR_CODES')).toEqual([...ERROR_CODES]);
  });

  it('the host, remote, assistant and harness values match the Worker', () => {
    const workerSet = (name: string): string[] => {
      const match = worker.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]`));
      expect(match, `${name} not found in telemetry/src/index.js`).not.toBeNull();
      return [...match![1].matchAll(/'([A-Za-z0-9-+]+)'/g)].map(m => m[1]);
    };
    expect(workerSet('HOST_VALUES')).toEqual([...HOSTS]);
    expect(workerSet('REMOTE_VALUES')).toEqual([...REMOTES]);
    expect(workerSet('RECENT_DAYS_VALUES')).toEqual(['0', '1', '2-3', '4-7', '8-14', '15-28']);
    expect(workerSet('FIRST_CANVAS_VALUES')).toEqual(['never', '0', '1-7', '8-30', '31-90', '90+']);
    expect(workerList('ASSISTANTS')).toEqual([...ASSISTANTS]);
    expect(workerList('HARNESSES')).toEqual([...HARNESSES]);
  });

  it('counts the onboarding flows', () => {
    let s = emptyCounters('2026-09-24');
    s = recordFeature(s, 'drawFromDbt');
    s = recordFeature(s, 'addFromDbt');
    s = recordFeature(s, 'addFromDbt');
    s = recordFeature(s, 'emptyCanvas');
    expect(buildHeartbeat(s, ENV).features).toEqual({ drawFromDbt: 1, addFromDbt: 2, emptyCanvas: 1 });
  });

  it('telemetry.json documents every feature key', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../telemetry.json'), 'utf8');
    for (const f of FEATURES) expect(doc).toContain(f);
  });

  it('telemetry.json documents every error key', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../telemetry.json'), 'utf8');
    for (const e of ERROR_CODES) expect(doc).toContain(e);
  });
});

describe('model file failure sub-codes (#110)', () => {
  it('maps every ModelFileErrorKind to its own listed error code', () => {
    const kinds = ['read', 'yamlIndent', 'yamlScalar', 'yamlStructure', 'yamlDuplicateKey', 'yamlOther'] as const;
    const codes = kinds.map(modelFileErrorCode);
    expect(codes).toEqual([
      'modelFileRead',
      'modelFileYamlIndent',
      'modelFileYamlScalar',
      'modelFileYamlStructure',
      'modelFileYamlDuplicateKey',
      'modelFileYamlOther',
    ]);
    for (const code of codes) expect(ERROR_CODES).toContain(code);
  });

  it('appends the sub-codes after `other`, so no existing index moves', () => {
    const other = ERROR_CODES.indexOf('other');
    expect(ERROR_CODES.slice(other + 1, other + 7)).toEqual([
      'modelFileRead',
      'modelFileYamlIndent',
      'modelFileYamlScalar',
      'modelFileYamlStructure',
      'modelFileYamlDuplicateKey',
      'modelFileYamlOther',
    ]);
  });

  it('counts the sub-code alongside the modelFileParse total', () => {
    let s = emptyCounters('2026-09-24');
    for (const kind of ['yamlScalar', 'yamlScalar', 'yamlIndent'] as const) {
      s = recordError(s, 'modelFileParse');
      s = recordError(s, modelFileErrorCode(kind));
    }
    expect(buildHeartbeat(s, ENV).errors).toEqual({ modelFileParse: 3, modelFileYamlScalar: 2, modelFileYamlIndent: 1 });
  });
});

describe('recordFeatureOnce', () => {
  it('counts a presence flag at most once per day', () => {
    let s = emptyCounters('2026-09-24');
    s = repeat(s, 5, x => recordFeatureOnce(x, 'harnessPresent'));
    expect(s.features.harnessPresent).toBe(1);
    expect(nextDay(s, '2026-09-25').features.harnessPresent).toBeUndefined();
  });

  it('returns the same state when already counted', () => {
    const s = recordFeatureOnce(emptyCounters('2026-09-24'), 'harnessPresent');
    expect(recordFeatureOnce(s, 'harnessPresent')).toBe(s);
  });
});

describe('environment, assistants and retention (1.6.3)', () => {
  it('maps editor app names to a fixed host id', () => {
    expect(hostBucket('Visual Studio Code')).toBe('vscode');
    expect(hostBucket('Visual Studio Code - Insiders')).toBe('vscodeInsiders');
    expect(hostBucket('Cursor')).toBe('cursor');
    expect(hostBucket('Windsurf')).toBe('windsurf');
    expect(hostBucket('Windsurf - Next')).toBe('windsurf');
    expect(hostBucket('VSCodium')).toBe('vscodium');
    expect(hostBucket('Trae')).toBe('trae');
    expect(hostBucket('Kiro')).toBe('kiro');
    expect(hostBucket('Positron')).toBe('positron');
    expect(hostBucket('Antigravity')).toBe('antigravity');
    expect(hostBucket('Jane\'s Private Editor')).toBe('other');
    expect(hostBucket('')).toBe('other');
  });

  it('maps remote names to a fixed remote kind', () => {
    expect(remoteBucket(undefined, false)).toBe('local');
    expect(remoteBucket(undefined, true)).toBe('web');
    expect(remoteBucket('ssh-remote', false)).toBe('ssh');
    expect(remoteBucket('wsl', false)).toBe('wsl');
    expect(remoteBucket('dev-container', false)).toBe('container');
    expect(remoteBucket('attached-container', false)).toBe('container');
    expect(remoteBucket('codespaces', true)).toBe('codespaces');
    expect(remoteBucket('tunnel', false)).toBe('other');
  });

  it('buckets recent-day counts', () => {
    expect([0, 1, 2, 3, 4, 7, 8, 14, 15, 28].map(recentDaysBucket))
      .toEqual(['0', '1', '2-3', '2-3', '4-7', '4-7', '8-14', '8-14', '15-28', '15-28']);
  });

  it('remembers only the window of days, sorted and without duplicates', () => {
    let days: string[] = [];
    for (const d of ['2026-09-01', '2026-09-20', '2026-09-20', '2026-09-10']) days = rememberDay(days, d);
    expect(days).toEqual(['2026-09-01', '2026-09-10', '2026-09-20']);
    // 2026-10-15 is 44 days after 09-01 and 25 after 09-20.
    expect(rememberDay(days, '2026-10-15')).toEqual(['2026-09-20', '2026-10-15']);
    expect(rememberDay(['not a day', '2026-10-15'], '2026-10-15')).toEqual(['2026-10-15']);
    expect(RETENTION_WINDOW_DAYS).toBe(28);
  });

  it('counts days in the 28 days ending on the reported day', () => {
    const days = ['2026-08-27', '2026-08-28', '2026-09-24', '2026-09-25'];
    // 08-28 is 27 days before 09-24 (inside), 08-27 is 28 (outside), 09-25 is after.
    expect(recentDaysCount(days, '2026-09-24')).toBe(2);
    expect(recentDaysCount(undefined, '2026-09-24')).toBe(0);
  });

  it('buckets the days to the first canvas, or never', () => {
    expect(firstCanvasBucket('2026-09-01', null, '2026-09-24')).toBe('never');
    expect(firstCanvasBucket('2026-09-01', '2026-09-01', '2026-09-24')).toBe('0');
    expect(firstCanvasBucket('2026-09-01', '2026-09-05', '2026-09-24')).toBe('1-7');
    // A first canvas after the reported day had not happened yet on that day.
    expect(firstCanvasBucket('2026-09-01', '2026-09-25', '2026-09-24')).toBe('never');
  });

  it('keeps the dev flag once set for the day, and carries env, assistants and harnesses over', () => {
    const env = { extVersion: '1.6.3', vscodeVersion: '1.105.0', host: 'vscode' as const, remote: 'local' as const };
    let s = stampEnv(emptyCounters('2026-09-24'), { ...env, dev: true });
    s = stampEnv(s, { ...env, dev: false });
    expect(s.env?.dev).toBe(true);
    s = recordHarnesses(recordAssistants(s, ['copilot']), ['copilot']);
    const next = nextDay(s, '2026-09-25');
    expect(next.env).toEqual(s.env);
    expect(next.assistants).toEqual(['copilot']);
    expect(next.harnesses).toEqual(['copilot']);
  });

  it('unions assistants and harnesses in a fixed order and returns stamped state unchanged', () => {
    let s = recordAssistants(emptyCounters('2026-09-24'), ['cursor']);
    s = recordAssistants(s, ['claude', 'cursor']);
    expect(s.assistants).toEqual(['claude', 'cursor']);
    const env = { extVersion: '1.6.3', vscodeVersion: '1.105.0', host: 'vscode' as const, remote: 'local' as const, dev: false };
    const stamped = stampEnv(s, env);
    expect(stampEnv(stamped, env)).toBe(stamped);
  });

  it('buckets layout durations into feature keys', () => {
    expect(layoutFeature(120, true)).toBe('layoutUnder1s');
    expect(layoutFeature(1000, true)).toBe('layout1to5s');
    expect(layoutFeature(5000, true)).toBe('layout1to5s');
    expect(layoutFeature(5001, true)).toBe('layoutOver5s');
    expect(layoutFeature(10, false)).toBe('layoutFailed');
  });
});
