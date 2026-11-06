/**
 * 2.0 launch telemetry, delivery items:
 * - B2: same-day interim copies (`heartbeatProvisional`) on onboarding
 *   end-points and new errors, through the telemetry logger, at most three a day;
 * - B3: the body size guard (`heartbeatTrimmed`);
 * - B5: the update flag that survives the update reload, mixed-version days
 *   and `ERD_STUDIO_INTERNAL=1`;
 * - B15: time to the first draft and diagram, and the trail's `dayContinued`.
 *
 * The pure halves are tested directly; the service through the facade with
 * fake timers and a stubbed `fetch`, as `telemetryService.test.ts` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ERROR_CODES,
  FEATURES,
  FIRST_DRAFT_FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  MAX_PROVISIONAL_SENDS,
  MAX_TRAIL,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  heartbeatHash,
  isMajorUpdate,
  nextDay,
  provisionalBody,
  provisionalDue,
  provisionalTrigger,
  recordActivation,
  recordCanvasOpen,
  recordError,
  recordFeature,
  stampEnv,
  trimHeartbeat,
  ttfFeature,
  type CounterEnv,
  type DailyCounters,
  type HeartbeatBody,
  type HeartbeatEnv,
  type ProvisionalCheck,
  type TrailEntry,
} from '../../src/services/telemetryPayload';
import {
  PENDING_UPDATE_KEY,
  PROVISIONAL_DEBOUNCE_MS,
  PROVISIONAL_SETTLE_MS,
  TelemetryService,
  notePendingUpdate,
  setTelemetryEndpointForTests,
  telemetry,
} from '../../src/services/telemetryService';
import { DRAFT_SOURCE_FEATURES } from '../../src/providers/draftWiring';
import worker from '../../telemetry/src/index.js';

const TODAY = '2026-11-05';
const ENV: HeartbeatEnv = { installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.0', vscodeVersion: '1.104.2', platform: 'darwin', firstSeenDay: TODAY };
const COUNTER_ENV: CounterEnv = { extVersion: '2.0.0', vscodeVersion: '1.104.2', host: 'vscode', remote: 'local', dev: false };

function used(day = TODAY): DailyCounters {
  return recordActivation(emptyCounters(day), { outcome: 'project_found', hasSemanticDir: true, domainCount: 1 });
}

// ---------------------------------------------------------------------------
// B2 — pure
// ---------------------------------------------------------------------------

describe('provisionalDue', () => {
  const check = (o: Partial<ProvisionalCheck> = {}): ProvisionalCheck => ({ trailDay: true, sentToday: 0, hash: 'h1', reason: 'onboarding', ...o });
  const s = used();

  it('sends today\'s counts on a first-week day', () => {
    expect(provisionalDue(s, TODAY, check())).toBe(true);
    expect(provisionalDue(s, TODAY, check({ reason: 'settle' }))).toBe(true);
  });

  it('never sends another day\'s counts', () => {
    expect(provisionalDue(s, '2026-11-06', check())).toBe(false);
  });

  it('stops at the daily cap', () => {
    expect(provisionalDue(s, TODAY, check({ sentToday: MAX_PROVISIONAL_SENDS - 1 }))).toBe(true);
    expect(provisionalDue(s, TODAY, check({ sentToday: MAX_PROVISIONAL_SENDS }))).toBe(false);
  });

  it('does not send the same counts twice', () => {
    expect(provisionalDue(s, TODAY, check({ lastHash: 'h1' }))).toBe(false);
    expect(provisionalDue(s, TODAY, check({ lastHash: 'h0' }))).toBe(true);
  });

  it('sends on a later-tenure day only for an error', () => {
    expect(provisionalDue(s, TODAY, check({ trailDay: false }))).toBe(false);
    expect(provisionalDue(s, TODAY, check({ trailDay: false, reason: 'settle' }))).toBe(false);
    expect(provisionalDue(s, TODAY, check({ trailDay: false, reason: 'error' }))).toBe(true);
  });

  it('needs something counted, and an activation unless activation itself failed', () => {
    expect(provisionalDue(emptyCounters(TODAY), TODAY, check())).toBe(false);
    const noActivation = recordFeature(emptyCounters(TODAY), 'compare');
    expect(provisionalDue(noActivation, TODAY, check())).toBe(false);
    const failed = recordError(emptyCounters(TODAY), 'activationFailed');
    expect(provisionalDue(failed, TODAY, check({ reason: 'error' }))).toBe(true);
  });
});

describe('provisionalTrigger', () => {
  it('fires for an error code new today, not for one already counted', () => {
    const s = used();
    const once = recordError(s, 'saveFailed');
    expect(provisionalTrigger(s, once)).toBe('error');
    expect(provisionalTrigger(once, recordError(once, 'saveFailed'))).toBeUndefined();
  });

  it('never fires for the loggedError* catch-all on its own', () => {
    const s = used();
    const logged = recordError(recordError(s, 'loggedError'), 'loggedErrorCanvas');
    expect(provisionalTrigger(s, logged)).toBeUndefined();
    // A failure of ours records its own code beside the catch-all.
    expect(provisionalTrigger(s, recordError(logged, 'handlerFailedStage'))).toBe('error');
  });

  it('fires for an onboarding end-point and the day\'s first diagram with tables', () => {
    const s = used();
    for (const f of ['draftDiscarded', 'draftClosed', 'draftKept', 'guideSkippedOnDraft', 'guideSkippedOnCanvas', 'guideLeftDraft', 'draftRejectedFastDbt'] as const) {
      expect(provisionalTrigger(s, recordFeature(s, f)), f).toBe('onboarding');
    }
    expect(provisionalTrigger(s, recordFeature(s, 'compare'))).toBeUndefined();
    const opened = recordCanvasOpen(s, { stage: 'logical', format: 'v5', modelCount: 4 });
    expect(provisionalTrigger(s, opened)).toBe('onboarding');
    expect(provisionalTrigger(opened, recordCanvasOpen(opened, { stage: 'logical', format: 'v5', modelCount: 40 }))).toBeUndefined();
    expect(provisionalTrigger(s, recordCanvasOpen(s, { stage: 'logical', format: 'v5', modelCount: 0 }))).toBeUndefined();
  });

  it('ignores a day change', () => {
    expect(provisionalTrigger(used(), recordError(used('2026-11-06'), 'saveFailed'))).toBeUndefined();
  });
});

describe('heartbeatHash', () => {
  it('ignores the interim marker and changes with the counts', () => {
    const body = buildHeartbeat(used(), ENV);
    expect(heartbeatHash(provisionalBody(body))).toBe(heartbeatHash(body));
    expect(heartbeatHash(buildHeartbeat(recordFeature(used(), 'compare'), ENV))).not.toBe(heartbeatHash(body));
  });

  it('marks the body only', () => {
    const body = buildHeartbeat(used(), ENV);
    expect(provisionalBody(body).features.heartbeatProvisional).toBe(1);
    expect(body.features.heartbeatProvisional).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B3 — the size guard
// ---------------------------------------------------------------------------

/** A body with every counter at 100 and a full trail: well past the guard. */
function hugeBody(): HeartbeatBody {
  let s = used();
  s = { ...s, features: Object.fromEntries(FEATURES.map((f) => [f, 100])), errors: Object.fromEntries(ERROR_CODES.map((e) => [e, 100])) };
  const trail: TrailEntry[] = Array.from({ length: MAX_TRAIL }, () => ['!convertToDbmlUnrestored', 3600, 20, 100]);
  return buildHeartbeat({ ...s, trail, trailDropped: 5 }, ENV);
}

/** A body of `bytes` bytes or a little more: a full trail, and as many features (count 2) as it takes. */
function bodyOfAbout(bytes: number): HeartbeatBody {
  const entry: TrailEntry = ['!convertToDbmlUnrestored', 3600, 20, 100];
  const trail = Array.from({ length: MAX_TRAIL }, () => entry);
  const counted: Record<string, number> = {};
  let body = buildHeartbeat({ ...used(), trail, trailDropped: 0 }, ENV);
  for (const f of FEATURES) {
    if (f === 'heartbeatProvisional' || f === 'heartbeatTrimmed') continue;
    if (heartbeatBytes(body) >= bytes) break;
    counted[f] = 2;
    body = buildHeartbeat({ ...used(), features: { ...counted }, trail, trailDropped: 0 }, ENV);
  }
  return body;
}

async function workerAccepts(body: HeartbeatBody): Promise<number> {
  const db = {
    prepare() {
      return { bind() { return this; }, async run() { return { meta: { changes: 1 } }; } };
    },
  };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const response = await worker.fetch(
      new Request('https://telemetry.example/v1/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      { DB: db, KILL_SWITCH: 'off' } as never,
    );
    return response.status;
  } finally {
    log.mockRestore();
  }
}

describe('trimHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`));
  });
  afterEach(() => vi.useRealTimers());

  it('leaves a body under the guard alone', () => {
    const body = buildHeartbeat(recordFeature(used(), 'compare'), ENV);
    expect(trimHeartbeat(body)).toBe(body);
  });

  it('drops the trail and trailDropped together first, and says so', () => {
    const body = bodyOfAbout(15_500);
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(trimmed.trail).toBeUndefined();
    expect('trailDropped' in trimmed).toBe(false);
    expect(trimmed.features.heartbeatTrimmed).toBe(1);
    // Only the trail had to go.
    expect(Object.keys(trimmed.features)).toHaveLength(Object.keys(body.features).length + 1);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
  });

  it('gets the worst case under the guard, single counts and newest keys first, and keeps the send markers', () => {
    const body = provisionalBody(hugeBody());
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    expect(trimmed.features.heartbeatProvisional).toBe(1);
    expect(trimmed.features.heartbeatTrimmed).toBe(1);
    // The oldest keys outlive the newest.
    expect(trimmed.features[FEATURES[0]]).toBe(100);
    expect(trimmed.errors[ERROR_CODES[0]]).toBe(100);
  });

  it('a trimmed body is one the Worker accepts', async () => {
    expect(await workerAccepts(trimHeartbeat(bodyOfAbout(15_500)))).toBe(204);
    expect(await workerAccepts(trimHeartbeat(hugeBody()))).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// B5 — pure
// ---------------------------------------------------------------------------

describe('updates and mixed versions', () => {
  it('isMajorUpdate compares the major only', () => {
    expect(isMajorUpdate('1.9.8', '2.0.0')).toBe(true);
    expect(isMajorUpdate('2.0.0', '2.0.1')).toBe(false);
    expect(isMajorUpdate('1.7.2', '1.9.0')).toBe(false);
  });

  it('stampEnv sets versionMixed only when another version had counted today', () => {
    let s = stampEnv(used(), COUNTER_ENV);
    expect(stampEnv(s, COUNTER_ENV)).toBe(s);
    expect(stampEnv(s, { ...COUNTER_ENV, vscodeVersion: '1.105.0' }).features.versionMixed).toBeUndefined();
    s = stampEnv(s, { ...COUNTER_ENV, extVersion: '2.0.1' });
    expect(s.features.versionMixed).toBe(1);
    expect(s.env?.extVersion).toBe('2.0.1');
    // Presence flag: flipping back does not count again.
    expect(stampEnv(s, COUNTER_ENV).features.versionMixed).toBe(1);
  });

  it('is not set by the first stamp, or by the env carried over to an empty new day', () => {
    expect(stampEnv(used(), COUNTER_ENV).features.versionMixed).toBeUndefined();
    const yesterday = stampEnv(used('2026-11-04'), COUNTER_ENV);
    const carried = nextDay(yesterday, TODAY);
    expect(carried.env?.extVersion).toBe('2.0.0');
    expect(stampEnv(carried, { ...COUNTER_ENV, extVersion: '2.0.1' }).features.versionMixed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B15 — pure
// ---------------------------------------------------------------------------

describe('ttfFeature', () => {
  const t0 = Date.parse(`${TODAY}T10:00:00Z`);
  it('buckets by minutes, then by day', () => {
    expect(ttfFeature('draft', t0, t0 + 59_999)).toBe('ttfDraftUnder1m');
    expect(ttfFeature('draft', t0, t0 + 60_000)).toBe('ttfDraft1to5m');
    expect(ttfFeature('draft', t0, t0 + 299_999)).toBe('ttfDraft1to5m');
    expect(ttfFeature('draft', t0, t0 + 300_000)).toBe('ttfDraft5to30m');
    expect(ttfFeature('draft', t0, t0 + 1_799_999)).toBe('ttfDraft5to30m');
    expect(ttfFeature('draft', t0, t0 + 1_800_000)).toBe('ttfDraftOver30m');
    expect(ttfFeature('diagram', t0, t0 + 13 * 3_600_000)).toBe('ttfDiagramOver30m');
    expect(ttfFeature('diagram', t0, t0 + 14 * 3_600_000)).toBe('ttfDiagramLaterDay');
    expect(ttfFeature('diagram', t0, t0 - 5_000)).toBe('ttfDiagramUnder1m');
  });

  it('counts a short wait across midnight by minutes', () => {
    const late = Date.parse(`${TODAY}T23:58:00Z`);
    expect(ttfFeature('draft', late, late + 4 * 60_000)).toBe('ttfDraft1to5m');
    expect(ttfFeature('draft', late, late + 40 * 60_000)).toBe('ttfDraftLaterDay');
  });

  it('FIRST_DRAFT_FEATURES are the draft preview\'s non-example sources', () => {
    expect([...FIRST_DRAFT_FEATURES].sort()).toEqual(Object.values(DRAFT_SOURCE_FEATURES).sort());
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

const mock = vscode as unknown as {
  _setMockConfiguration: (section: string, key: string, values: { globalValue?: unknown }) => void;
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
};

const SECOND = 1000;
const HOUR = 3_600_000;
let fetchMock: ReturnType<typeof vi.fn>;
let services: TelemetryService[] = [];

function makeContext(seed: { firstSeen?: string; version?: string } = {}): vscode.ExtensionContext {
  const root = path.join(os.tmpdir(), 'erd-telemetry-delivery-test');
  const context = mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: seed.version ?? '2.0.0' } });
  if (seed.firstSeen) void context.globalState.update('erdStudio.telemetry.firstSeenDay', seed.firstSeen);
  return context;
}

function startService(context = makeContext()): { service: TelemetryService; context: vscode.ExtensionContext } {
  const service = new TelemetryService(context);
  services.push(service);
  service.start();
  return { service, context };
}

function sentBodies(): HeartbeatBody[] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string) as HeartbeatBody);
}
const provisional = () => sentBodies().filter((b) => b.features.heartbeatProvisional === 1);
const finals = () => sentBodies().filter((b) => b.features.heartbeatProvisional === undefined);
const stored = (context: vscode.ExtensionContext) => context.globalState.get<DailyCounters>('erdStudio.telemetry.counters');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T10:00:00Z`));
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  mock._resetMockConfiguration();
  mock._setMockTelemetryEnabled(true);
});

afterEach(() => {
  for (const s of services) s.dispose();
  services = [];
  setTelemetryEndpointForTests(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  mock._setMockTelemetryEnabled(true);
  delete process.env.ERD_STUDIO_INTERNAL;
});

describe('B2: interim copies', () => {
  it('an error recorded through relationshipInvariants posts one interim copy 30 s later, through the logger, on any tenure', async () => {
    const create = vscode.env.createTelemetryLogger;
    const logUsage = vi.fn();
    const spy = vi.spyOn(vscode.env, 'createTelemetryLogger').mockImplementation((sender, options) => {
      const logger = create(sender, options);
      return Object.assign(Object.create(logger) as vscode.TelemetryLogger, {
        logUsage: (name: string, data?: Record<string, unknown>) => { logUsage(name, data); logger.logUsage(name, data); },
      });
    });
    const { context } = startService(makeContext({ firstSeen: '2026-01-01' }));
    spy.mockRestore();
    telemetry.activation('project_found', true, 1);
    telemetry.relationshipInvariants(['otherLost']);
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS - SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(provisional()).toHaveLength(1);
    expect(provisional()[0]).toMatchObject({ day: TODAY, tenure: '90+', errors: { relInvOtherLost: 1 } });
    // Never in the stored counters.
    expect(stored(context)?.features.heartbeatProvisional).toBeUndefined();
    expect(logUsage).toHaveBeenCalledTimes(1);
    expect(logUsage.mock.calls[0][0]).toBe('heartbeat');
    expect((logUsage.mock.calls[0][1] as HeartbeatBody).features.heartbeatProvisional).toBe(1);
  });

  it('the next day\'s final replaces it and carries no interim marker', async () => {
    startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    telemetry.error('saveFailed');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS);
    vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(provisional()).toHaveLength(1);
    expect(finals()).toHaveLength(1);
    expect(finals()[0]).toMatchObject({ day: TODAY, errors: { saveFailed: 1 } });
  });

  it('goes through the logger: nothing is sent while VS Code\'s telemetry is off', async () => {
    startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    telemetry.error('saveFailed');
    mock._setMockTelemetryEnabled(false);
    await vi.advanceTimersByTimeAsync(5 * 60 * SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a first-week onboarding end-point sends one, debounced', async () => {
    startService();
    telemetry.activation('project_found', true, 1);
    telemetry.feature('draftShown');
    telemetry.feature('draftDiscarded');
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    telemetry.feature('draftClosed');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS - SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SECOND);
    expect(provisional()).toHaveLength(1);
    expect(provisional()[0].features).toMatchObject({ draftDiscarded: 1, draftClosed: 1, heartbeatProvisional: 1 });
    expect(provisional()[0].tenure).toBe('0');
  });

  it('an onboarding end-point on a later-tenure day sends nothing', async () => {
    startService(makeContext({ firstSeen: '2026-10-01' }));
    telemetry.activation('project_found', true, 1);
    telemetry.feature('draftDiscarded');
    telemetry.canvasOpened('logical', 'v5', 4);
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('settles: a first-week day sends what it has two minutes after start, and not the same counts again', async () => {
    const { service } = startService();
    telemetry.activation('project_found', true, 1);
    await vi.advanceTimersByTimeAsync(PROVISIONAL_SETTLE_MS);
    expect(provisional()).toHaveLength(1);
    service.sendProvisional('onboarding');
    expect(provisional()).toHaveLength(1);
  });

  it('sends at most three a day', async () => {
    startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    for (const code of ['saveFailed', 'other', 'layoutFailed', 'domainLoad', 'relHandlerFailed'] as const) {
      telemetry.error(code);
      await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS + SECOND);
    }
    expect(provisional()).toHaveLength(MAX_PROVISIONAL_SENDS);
    // A new day starts the count again.
    vi.setSystemTime(new Date('2026-11-06T09:00:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    telemetry.activation('project_found', true, 1);
    telemetry.error('saveFailed');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS);
    expect(provisional().filter((b) => b.day === '2026-11-06')).toHaveLength(1);
  });

  it('an install whose first counted start was an update gets no onboarding copies, but still error ones', async () => {
    const context = makeContext();
    await context.globalState.update(PENDING_UPDATE_KEY, { major: true });
    startService(context);
    telemetry.activation('project_found', true, 1);
    telemetry.feature('draftDiscarded');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_SETTLE_MS + SECOND);
    expect(fetchMock).not.toHaveBeenCalled();
    telemetry.error('saveFailed');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS);
    expect(provisional()).toHaveLength(1);
  });

  it('opting out clears the record and cancels a pending copy', async () => {
    const { context } = startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    telemetry.error('saveFailed');
    await vi.advanceTimersByTimeAsync(PROVISIONAL_DEBOUNCE_MS);
    expect(context.globalState.get('erdStudio.telemetry.provisional')).toMatchObject({ day: TODAY, sent: 1 });
    telemetry.error('other');
    mock._setMockTelemetryEnabled(false);
    expect(context.globalState.get('erdStudio.telemetry.provisional')).toBeUndefined();
    mock._setMockTelemetryEnabled(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * SECOND);
    expect(provisional()).toHaveLength(1);
  });
});

describe('B3: the size guard in the send', () => {
  it('trims an oversized day before it goes out', async () => {
    const { context } = startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    const s = stored(context)!;
    await context.globalState.update('erdStudio.telemetry.counters', {
      ...s,
      features: Object.fromEntries(FEATURES.filter((f) => f !== 'heartbeatProvisional').map((f) => [f, 100])),
      errors: Object.fromEntries(ERROR_CODES.map((e) => [e, 100])),
    });
    vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new TextEncoder().encode(init.body as string).byteLength).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    expect(finals()[0].features.heartbeatTrimmed).toBe(1);
  });
});

describe('B5: updates and internal installs', () => {
  it('an update before the update reload is still counted on the next activation', async () => {
    const context = makeContext({ firstSeen: '2026-01-01' });
    // activate(): the flag is written, then the reload returns before telemetry starts.
    await notePendingUpdate(context, '1.9.8', '2.0.0');
    expect(context.globalState.get(PENDING_UPDATE_KEY)).toEqual({ major: true });
    // The reloaded window: same version now, so only the flag carries the update.
    await notePendingUpdate(context, '2.0.0', '2.0.0');
    startService(context);
    telemetry.activation('project_found', true, 1);
    expect(context.globalState.get(PENDING_UPDATE_KEY)).toBeUndefined();
    expect(stored(context)?.features).toMatchObject({ extUpdated: 1, extUpdatedMajor: 1 });
    // A second start counts nothing more.
    startService(context);
    expect(stored(context)?.features).toMatchObject({ extUpdated: 1, extUpdatedMajor: 1 });
  });

  it('a minor update is extUpdated only; no version text is kept', async () => {
    const context = makeContext({ firstSeen: '2026-01-01' });
    await notePendingUpdate(context, '2.0.0', '2.0.1');
    expect(JSON.stringify(context.globalState.get(PENDING_UPDATE_KEY))).not.toMatch(/\d\.\d/);
    startService(context);
    expect(stored(context)?.features.extUpdated).toBe(1);
    expect(stored(context)?.features.extUpdatedMajor).toBeUndefined();
  });

  it('keeps nothing for a fresh install, or while telemetry is off', async () => {
    const context = makeContext();
    await notePendingUpdate(context, undefined, '2.0.0');
    expect(context.globalState.get(PENDING_UPDATE_KEY)).toBeUndefined();
    mock._setMockConfiguration('erdStudio', 'telemetry.enabled', { globalValue: false });
    await notePendingUpdate(context, '1.9.8', '2.0.0');
    expect(context.globalState.get(PENDING_UPDATE_KEY)).toBeUndefined();
  });

  it('ERD_STUDIO_INTERNAL=1 marks the day dev', async () => {
    process.env.ERD_STUDIO_INTERNAL = '1';
    startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(finals()[0].dev).toBe(true);
  });

  it('without it a production install is not dev', async () => {
    process.env.ERD_STUDIO_INTERNAL = '0';
    startService(makeContext({ firstSeen: '2026-01-01' }));
    telemetry.activation('project_found', true, 1);
    vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(finals()[0].dev).toBe(false);
  });

  it('a mid-day update marks the day versionMixed', async () => {
    const context = makeContext({ firstSeen: '2026-01-01', version: '2.0.0' });
    startService(context);
    telemetry.activation('project_found', true, 1);
    services[0].dispose();
    (context.extension as { packageJSON: unknown }).packageJSON = { version: '2.0.1' };
    startService(context);
    telemetry.activation('project_found', true, 1);
    expect(stored(context)?.features.versionMixed).toBe(1);
  });
});

describe('B15: time to first draft and diagram', () => {
  it('times the first real draft and the first diagram with tables, once per install', async () => {
    const { context } = startService();
    telemetry.featureOnce('firstRun');
    expect(typeof context.globalState.get('erdStudio.telemetry.firstRunAt')).toBe('number');
    vi.setSystemTime(new Date(`${TODAY}T10:00:30Z`));
    // An example draft is not the first draft.
    telemetry.feature('draftShown');
    telemetry.feature('draftExampleShown');
    expect(context.globalState.get('erdStudio.telemetry.firstDraftDone')).toBeUndefined();
    vi.setSystemTime(new Date(`${TODAY}T10:02:00Z`));
    telemetry.feature('draftShown');
    telemetry.feature('draftSourceDbt');
    telemetry.canvasOpened('logical', 'v5', 0);
    expect(context.globalState.get('erdStudio.telemetry.firstDiagramDone')).toBeUndefined();
    vi.setSystemTime(new Date(`${TODAY}T10:10:00Z`));
    telemetry.canvasOpened('logical', 'v5', 6);
    vi.setSystemTime(new Date(`${TODAY}T10:11:00Z`));
    telemetry.feature('draftSourceSqlDdl');
    telemetry.canvasOpened('logical', 'v5', 6);
    const f = stored(context)!.features;
    expect(f.ttfDraft1to5m).toBe(1);
    expect(f.ttfDiagram5to30m).toBe(1);
    const ttf = Object.keys(f).filter((k) => k.startsWith('ttf'));
    expect(ttf).toEqual(['ttfDraft1to5m', 'ttfDiagram5to30m']);
  });

  it('a first run is noted once; an install without one is never timed', () => {
    const { context } = startService();
    telemetry.featureOnce('firstRun');
    const at = context.globalState.get<number>('erdStudio.telemetry.firstRunAt');
    vi.setSystemTime(new Date(`${TODAY}T11:00:00Z`));
    telemetry.featureOnce('firstRun');
    expect(context.globalState.get('erdStudio.telemetry.firstRunAt')).toBe(at);

    const other = startService(makeContext({ firstSeen: '2026-01-01' })).context;
    telemetry.feature('draftSourceDbt');
    telemetry.canvasOpened('logical', 'v5', 3);
    expect(Object.keys(stored(other)!.features).some((k) => k.startsWith('ttf'))).toBe(false);
    expect(other.globalState.get('erdStudio.telemetry.firstDraftDone')).toBeUndefined();
  });

  it('switching telemetry off forgets the first-run time and the done flags', () => {
    const { context } = startService();
    telemetry.featureOnce('firstRun');
    telemetry.feature('draftSourceDbt');
    telemetry.canvasOpened('logical', 'v5', 3);
    expect(context.globalState.get('erdStudio.telemetry.firstDraftDone')).toBe(true);
    void context.globalState.update(PENDING_UPDATE_KEY, { major: false });
    mock._setMockTelemetryEnabled(false);
    for (const key of ['firstRunAt', 'firstDraftDone', 'firstDiagramDone', 'pendingUpdate', 'provisional']) {
      expect(context.globalState.get(`erdStudio.telemetry.${key}`), key).toBeUndefined();
    }
  });
});

describe('B15: dayContinued', () => {
  it('begins the day\'s trail in a window that crossed midnight, and only there', async () => {
    const { context } = startService();
    telemetry.activation('project_found', true, 1);
    vi.setSystemTime(new Date('2026-11-06T00:10:00Z'));
    telemetry.feature('editColumn');
    telemetry.feature('addModel');
    expect(stored(context)?.trail?.map((e) => e[0])).toEqual(['dayContinued', 'editColumn', 'addModel']);

    // A window activated today does not add it.
    const fresh = startService(makeContext()).context;
    telemetry.activation('project_found', true, 1);
    expect(stored(fresh)?.trail?.[0][0]).toBe('windowOpened');
  });
});
