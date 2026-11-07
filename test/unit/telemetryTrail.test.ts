/**
 * The onboarding trail (telemetryPayload.ts `recordTrail`, telemetryService.ts):
 * the day's events in order, with the seconds between them, the window each
 * came from and repeats folded, kept for an install's first week and any day
 * the guide runs. Fixed event ids only; the Worker keeps the same list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ERROR_CODES,
  FEATURES,
  MAX_COUNTER,
  MAX_TRAIL,
  MAX_TRAIL_DROPPED,
  MAX_TRAIL_GAP_S,
  MAX_TRAIL_WINDOWS,
  TRAIL_DAYS,
  TRAIL_GENERAL_MAX,
  TRAIL_MARKERS,
  buildHeartbeat,
  emptyCounters,
  isTrailEvent,
  nextDay,
  nextTrailWindow,
  recordTrail,
  retractTrail,
  trailKept,
  type DailyCounters,
  type HeartbeatBody,
  type HeartbeatEnv,
  type TrailEvent,
} from '../../src/services/telemetryPayload';
import { TelemetryService, setTelemetryEndpointForTests, telemetry } from '../../src/services/telemetryService';

const ENV: HeartbeatEnv = { installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.0', vscodeVersion: '1.104.2', platform: 'darwin', firstSeenDay: '2026-11-05' };
const T0 = Date.parse('2026-11-05T10:00:00Z');
const day = (): DailyCounters => emptyCounters('2026-11-05');

describe('recordTrail', () => {
  it('keeps events in order with whole seconds since the previous one, the first at 0', () => {
    let s = recordTrail(day(), 'windowOpened', T0, 1);
    s = recordTrail(s, 'draftShown', T0 + 2400, 1);
    s = recordTrail(s, 'guideStepDraftBanner', T0 + 14_000, 1);
    expect(s.trail).toEqual([['windowOpened', 0, 1, 1], ['draftShown', 2, 1, 1], ['guideStepDraftBanner', 12, 1, 1]]);
  });

  it('caps a gap at an hour', () => {
    let s = recordTrail(day(), 'windowOpened', T0, 1);
    s = recordTrail(s, 'windowBack', T0 + 5 * 3600_000, 1);
    expect(s.trail![1][1]).toBe(MAX_TRAIL_GAP_S);
  });

  it('folds the same event from the same window straight after into one entry, up to the counter cap', () => {
    let s = recordTrail(day(), 'canvasOpened', T0, 1);
    for (let i = 1; i <= 150; i++) s = recordTrail(s, 'editLayout', T0 + i * 1000, 1);
    expect(s.trail).toEqual([['canvasOpened', 0, 1, 1], ['editLayout', 1, 1, MAX_COUNTER]]);
    // The next entry's gap counts from the last of the run.
    s = recordTrail(s, 'editColumn', T0 + 153_000, 1);
    expect(s.trail![2]).toEqual(['editColumn', 3, 1, 1]);
  });

  it('does not fold across windows', () => {
    let s = recordTrail(day(), 'editLayout', T0, 1);
    s = recordTrail(s, 'editLayout', T0 + 1000, 2);
    expect(s.trail).toHaveLength(2);
  });

  it('keeps the first TRAIL_GENERAL_MAX ordinary entries and counts the rest', () => {
    let s = day();
    for (let i = 0; i < MAX_TRAIL + 7; i++) s = recordTrail(s, i % 2 ? 'windowAway' : 'windowBack', T0 + i * 1000, 1);
    expect(s.trail).toHaveLength(TRAIL_GENERAL_MAX);
    expect(s.trailDropped).toBe(MAX_TRAIL + 7 - TRAIL_GENERAL_MAX);
  });

  it('keeps its last places for errors and the closing markers, up to MAX_TRAIL', () => {
    let s = day();
    for (let i = 0; i < 95; i++) s = recordTrail(s, i % 2 ? 'windowAway' : 'windowBack', T0 + i * 1000, 1);
    expect(s.trail).toHaveLength(TRAIL_GENERAL_MAX);
    s = recordTrail(s, '!saveFailed', T0 + 100_000, 1);
    s = recordTrail(s, 'editColumn', T0 + 101_000, 1);
    s = recordTrail(s, 'canvasClosed', T0 + 102_000, 1);
    s = recordTrail(s, 'windowClosed', T0 + 103_000, 1);
    expect(s.trail!.slice(TRAIL_GENERAL_MAX).map((e) => e[0])).toEqual(['!saveFailed', 'canvasClosed', 'windowClosed']);
    expect(s.trailDropped).toBe(95 - TRAIL_GENERAL_MAX + 1);
    for (let i = 0; i < 20; i++) s = recordTrail(s, i % 2 ? '!saveFailed' : '!other', T0 + 104_000 + i, 1);
    expect(s.trail).toHaveLength(MAX_TRAIL);
    expect(s.trail!.every((e) => isTrailEvent(e[0]))).toBe(true);
  });

  it('writes an error code as !code, apart from a feature of the same name', () => {
    let s = recordTrail(day(), 'layoutFailed', T0, 1);
    s = recordTrail(s, '!layoutFailed', T0, 1);
    expect(s.trail!.map((e) => e[0])).toEqual(['layoutFailed', '!layoutFailed']);
    expect(isTrailEvent('!compare')).toBe(false);
    expect(isTrailEvent('!!layoutFailed')).toBe(false);
  });

  it('ignores anything that is not a listed event', () => {
    const s = recordTrail(day(), 'dim_customer' as TrailEvent, T0, 1);
    expect(s).toBe(s);
    expect(s.trail).toBeUndefined();
  });

  it('numbers windows 1, 2, … by when each first joined the day\'s trail, capped', () => {
    expect(nextTrailWindow(day())).toBe(1);
    let s = recordTrail(day(), 'windowOpened', T0, 1);
    s = recordTrail(s, 'windowOpened', T0, 2);
    expect(nextTrailWindow(s)).toBe(3);
    expect(recordTrail(day(), 'windowOpened', T0, 99).trail![0][2]).toBe(MAX_TRAIL_WINDOWS);
  });

  it('retractTrail takes back a quick away marker only when nothing came since', () => {
    let s = recordTrail(day(), 'canvasOpened', T0, 1);
    s = recordTrail(s, 'windowAway', T0 + 1000, 1);
    expect(retractTrail(s, 'windowAway', 1).trail).toEqual([['canvasOpened', 0, 1, 1]]);
    expect(retractTrail(s, 'windowAway', 2)).toBe(s);
    const later = recordTrail(s, 'editColumn', T0 + 2000, 2);
    expect(retractTrail(later, 'windowAway', 1)).toBe(later);
  });

  it('the trail starts again each day', () => {
    const s = recordTrail(day(), 'windowOpened', T0, 1);
    expect(nextDay(s, '2026-11-06').trail).toBeUndefined();
  });
});

describe('when the trail is kept', () => {
  it('an install\'s first seven days, then not', () => {
    for (let d = 0; d < TRAIL_DAYS; d++) expect(trailKept(emptyCounters(`2026-11-${String(5 + d).padStart(2, '0')}`), '2026-11-05', 'compare')).toBe(true);
    expect(trailKept(emptyCounters('2026-11-12'), '2026-11-05', 'compare')).toBe(false);
  });

  it('the seven days from the first start after a major update, then not', () => {
    for (let d = 0; d < TRAIL_DAYS; d++) expect(trailKept(emptyCounters(`2027-02-${String(1 + d).padStart(2, '0')}`), '2026-11-05', 'compare', '2027-02-01')).toBe(true);
    expect(trailKept(emptyCounters('2027-02-08'), '2026-11-05', 'compare', '2027-02-01')).toBe(false);
    expect(trailKept(emptyCounters('2027-01-31'), '2026-11-05', 'compare', '2027-02-01')).toBe(false);
    expect(trailKept(emptyCounters('2027-02-01'), '2026-11-05', 'compare', undefined)).toBe(false);
  });

  it('any later day the guide runs, from guideStarted on, for the rest of that day', () => {
    const late = emptyCounters('2027-02-01');
    expect(trailKept(late, '2026-11-05', 'compare')).toBe(false);
    expect(trailKept(late, '2026-11-05', 'guideStarted')).toBe(true);
    const begun = recordTrail(late, 'guideStarted', T0, 1);
    expect(trailKept(begun, '2026-11-05', 'compare')).toBe(true);
  });
});

describe('the heartbeat', () => {
  it('carries the trail and its dropped count only on a day that kept one', () => {
    expect(buildHeartbeat(day(), ENV)).not.toHaveProperty('trail');
    const s = recordTrail(day(), 'windowOpened', T0, 1);
    const body = buildHeartbeat(s, ENV);
    expect(body.trail).toEqual([['windowOpened', 0, 1, 1]]);
    expect(body.trailDropped).toBe(0);
    expect(body).not.toHaveProperty('trailAt');
  });

  it('rebuilds stored entries value by value: junk, names and paths never reach the wire', () => {
    const stored = {
      ...day(),
      trail: [
        ['windowOpened', 0, 1, 1],
        ['/Users/jane/acme/models/dim_customer.sql', 3, 1, 1],
        ['editColumn', 1e9, -4, 0.5],
        ['compare', 'x', 1, 1, 'extra'],
        'dim_customer',
      ],
      trailDropped: 1e12,
      trailAt: T0,
    } as unknown as DailyCounters;
    const body = buildHeartbeat(stored, ENV);
    expect(body.trail).toEqual([['windowOpened', 0, 1, 1], ['editColumn', MAX_TRAIL_GAP_S, 1, 1]]);
    expect(body.trailDropped).toBe(MAX_TRAIL_DROPPED);
    const json = JSON.stringify(body);
    for (const secret of ['jane', 'acme', 'dim_customer']) expect(json).not.toContain(secret);
  });

  it('stays under the Worker\'s body limit with every counter at its cap and a full trail of the longest events', () => {
    const worker = fs.readFileSync(path.join(__dirname, '../../telemetry/src/index.js'), 'utf8');
    const limit = Number(/const MAX_BODY_BYTES = (\d+);/.exec(worker)?.[1]);
    const longest = [...TRAIL_MARKERS, ...FEATURES, ...ERROR_CODES.map((c) => `!${c}`)].sort((a, b) => b.length - a.length).slice(0, 2) as TrailEvent[];
    let s: DailyCounters = day();
    s = { ...s, features: Object.fromEntries(FEATURES.map((f) => [f, 100])), errors: Object.fromEntries(ERROR_CODES.map((e) => [e, 100])) };
    // Built directly: recordTrail keeps its last places for errors, and the worst case is a full trail of the longest ids.
    s = { ...s, trail: Array.from({ length: MAX_TRAIL }, (_, i) => [longest[i % 2]!, MAX_TRAIL_GAP_S, MAX_TRAIL_WINDOWS, MAX_COUNTER]), trailDropped: MAX_TRAIL_DROPPED };
    const bytes = new TextEncoder().encode(JSON.stringify(buildHeartbeat(s, ENV))).byteLength;
    expect(bytes).toBeLessThan(limit);
  });
});

describe('the Worker agrees', () => {
  const worker = fs.readFileSync(path.join(__dirname, '../../telemetry/src/index.js'), 'utf8');
  it('TRAIL_MARKERS match key for key, in order, and no event id is listed twice', () => {
    const match = worker.match(/const TRAIL_MARKERS = \[([^\]]*)\]/);
    expect(match).not.toBeNull();
    expect([...match![1].matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1])).toEqual([...TRAIL_MARKERS]);
    const all = [...TRAIL_MARKERS, ...FEATURES, ...ERROR_CODES.map((c) => `!${c}`)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.every(isTrailEvent)).toBe(true);
  });

  it('the limits match', () => {
    const num = (name: string) => Number(new RegExp(`const ${name} = (\\d+);`).exec(worker)?.[1]);
    expect(num('MAX_TRAIL')).toBe(MAX_TRAIL);
    expect(num('MAX_TRAIL_GAP_S')).toBe(MAX_TRAIL_GAP_S);
    expect(num('MAX_TRAIL_WINDOWS')).toBe(MAX_TRAIL_WINDOWS);
    expect(num('MAX_TRAIL_REPEAT')).toBe(MAX_COUNTER);
    expect(num('MAX_TRAIL_DROPPED')).toBe(MAX_TRAIL_DROPPED);
  });

  it('telemetry.json and the Worker README describe the trail', () => {
    const json = fs.readFileSync(path.join(__dirname, '../../telemetry.json'), 'utf8');
    const readme = fs.readFileSync(path.join(__dirname, '../../telemetry/README.md'), 'utf8');
    expect(JSON.parse(json).events?.usage?.heartbeat ?? JSON.parse(json)).toBeDefined();
    for (const m of TRAIL_MARKERS) {
      expect(json, m).toContain(m);
      expect(readme, m).toContain(`\`${m}\``);
    }
    expect(json).toContain('"trail"');
    expect(readme).toMatch(/^\| Trail \|/m);
  });
});

// ---------------------------------------------------------------------------
// The service, through the facade
// ---------------------------------------------------------------------------

const mock = vscode as unknown as {
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  _fireDidChangeWindowState: (focused: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
};
let fetchMock: ReturnType<typeof vi.fn>;
let services: TelemetryService[] = [];

function start(firstSeen?: string): vscode.ExtensionContext {
  const root = path.join(os.tmpdir(), 'erd-telemetry-trail-test');
  const context = mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '2.0.0' } });
  if (firstSeen) void context.globalState.update('erdStudio.telemetry.firstSeenDay', firstSeen);
  const service = new TelemetryService(context);
  services.push(service);
  service.start();
  return context;
}

async function sentTrail(): Promise<HeartbeatBody['trail']> {
  vi.setSystemTime(new Date('2026-11-06T00:30:00Z'));
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return (JSON.parse(init.body as string) as HeartbeatBody).trail;
}

const at = (iso: string) => vi.setSystemTime(new Date(`2026-11-05T${iso}Z`));

describe('the service keeps the trail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    at('10:00:00');
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
  });

  it('in a new install: activation, features (a once-a-day flag only the first time), errors, markers and the time between them', async () => {
    start();
    telemetry.activation('no_project', false, 0);
    at('10:00:03'); telemetry.feature('draftShown');
    at('10:00:04'); telemetry.feature('guideStarted');
    at('10:00:05'); telemetry.feature('guideStepDraftBanner');
    at('10:00:47'); telemetry.featureOnce('dbtProjectUnused');
    telemetry.featureOnce('dbtProjectUnused');
    at('10:00:50'); telemetry.error('draftBuildFailed');
    at('10:01:00'); telemetry.canvasOpened('logical', 'v5', 4);
    telemetry.canvasVisible('k', false);
    at('10:01:30'); telemetry.canvasVisible('k', true);
    at('10:02:00'); telemetry.canvasClosed('k');
    expect(await sentTrail()).toEqual([
      ['windowOpened', 0, 1, 1],
      ['draftShown', 3, 1, 1],
      ['guideStarted', 1, 1, 1],
      ['guideStepDraftBanner', 1, 1, 1],
      ['dbtProjectUnused', 42, 1, 1],
      ['!draftBuildFailed', 3, 1, 1],
      ['canvasOpened', 10, 1, 1],
      ['canvasHidden', 0, 1, 1],
      ['canvasShown', 30, 1, 1],
      ['canvasClosed', 30, 1, 1],
    ]);
  });

  it('a focus change shorter than five seconds is taken back; a longer one is kept as away and back', async () => {
    start();
    telemetry.activation('project_found', true, 1);
    at('10:00:10'); mock._fireDidChangeWindowState(false);
    at('10:00:12'); mock._fireDidChangeWindowState(true);
    at('10:00:20'); mock._fireDidChangeWindowState(false);
    at('10:01:20'); mock._fireDidChangeWindowState(true);
    expect(await sentTrail()).toEqual([['windowOpened', 0, 1, 1], ['windowAway', 20, 1, 1], ['windowBack', 60, 1, 1]]);
  });

  it('after the first week, nothing, until the guide starts that day', async () => {
    start('2026-09-01');
    telemetry.activation('project_found', true, 1);
    telemetry.feature('compare');
    at('10:00:30'); telemetry.feature('guideStarted');
    at('10:00:31'); telemetry.feature('guideStepCanvasTable');
    expect(await sentTrail()).toEqual([['guideStarted', 0, 1, 1], ['guideStepCanvasTable', 1, 1, 1]]);
  });

  it('a later day without the guide sends no trail at all', async () => {
    start('2026-09-01');
    telemetry.activation('project_found', true, 1);
    telemetry.feature('compare');
    expect(await sentTrail()).toBeUndefined();
  });

  it('two windows on one day are numbered 1 and 2', async () => {
    const context = start();
    telemetry.activation('project_found', true, 1);
    const second = new TelemetryService(context);
    services.push(second);
    at('10:00:05');
    second.record((s) => s, 'windowOpened');
    expect(await sentTrail()).toEqual([['windowOpened', 0, 1, 1], ['windowOpened', 5, 2, 1]]);
  });

  it('nothing at all while telemetry is off', async () => {
    mock._setMockTelemetryEnabled(false);
    const context = start();
    telemetry.activation('project_found', true, 1);
    telemetry.feature('guideStarted');
    expect((context.globalState.get('erdStudio.telemetry.counters') as DailyCounters | undefined)?.trail).toBeUndefined();
  });
});
