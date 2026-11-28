/**
 * #333 (option 5, "see it in the field"): how long a diagram takes to open.
 * Before, telemetry saw a slow open only past fixed limits
 * (`canvasLoadOver20s`, `readySlowOver10s`), so an open of 2 to 15 s (what a
 * 500-table diagram takes on a slow machine) left no trace, nothing said
 * whether the open had to read its table files from disk, and nothing timed
 * the webview's first paint. Three families of presence keys now say it:
 *
 * - `canvasLoad*` (host, `ready` → diagram posted): Under1s, 1to5s, 5to20s,
 *   and the existing Over20s as the top rung;
 * - `canvasLoadCold`: the slowest open read at least one table file;
 * - `canvasPaint*` (webview, first diagram received → first paint after its
 *   tables are drawn): Under1s, 1to5s, Over5s.
 *
 * The rule pinned here: one key per family per day, the slowest open wins,
 * the cold flag belongs to that slowest open, every edge sits where the
 * existing keys put theirs, `canvasLoadOver20s` keeps its meaning (and its
 * one trail event), the keys survive the size guard, and nothing but a fixed
 * key ever leaves: never a number of milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  CANVAS_LOAD_FEATURES,
  CANVAS_PAINT_FEATURES,
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  buildHeartbeat,
  emptyCounters,
  hasCounts,
  heartbeatBytes,
  nextDay,
  provisionalBody,
  recordCanvasLoad,
  recordCanvasPaint,
  trimHeartbeat,
  type DailyCounters,
  type HeartbeatBody,
  type HeartbeatEnv,
} from '../../src/services/telemetryPayload';
import { canvasLoadFeature, canvasPaintFeature, slowCanvasLoad } from '../../src/services/telemetryCanvas';
import { TelemetryService, setTelemetryEndpointForTests, telemetry } from '../../src/services/telemetryService';
import { CANVAS_PAINTED_MAX_MS, validateCanvasPaintedPayload } from '../../src/providers/payloadValidation';
import {
  _resetPaintTimingForTests,
  answerFirstPaint,
  notePageHidden,
  notePayloadReceived,
  type PaintTimingDeps,
} from '../../webview/lib/paintTiming';

const ENV: HeartbeatEnv = {
  installId: '3b241101-e2bb-4255-8caf-4136c566a962',
  extVersion: '2.0.7',
  vscodeVersion: '1.104.2',
  platform: 'win32',
  firstSeenDay: '2026-09-01',
};
const DAY = '2026-11-16';

/** One open of `ms`, cold or warm, through the bucket and the reducer as the facade does. */
const load = (s: DailyCounters, ms: number, cold: boolean): DailyCounters => {
  const key = canvasLoadFeature(ms);
  return key ? recordCanvasLoad(s, key, cold) : s;
};
const paint = (s: DailyCounters, ms: number): DailyCounters => {
  const key = canvasPaintFeature(ms);
  return key ? recordCanvasPaint(s, key) : s;
};
const timingKeys = (s: { features: Record<string, number | undefined> }) =>
  Object.fromEntries(Object.entries(s.features).filter(([k]) => /^canvas(Load|Paint)/.test(k)));

describe('the ranges (#333)', () => {
  it('a load is under 1 s, 1–5 s, 5–20 s or over 20 s, with the edges the layout keys and canvasLoadOver20s use', () => {
    const ms = [0, 999, 1000, 4999, 5000, 5001, 19_999, 20_000, 20_001, 600_000];
    expect(ms.map(canvasLoadFeature)).toEqual([
      'canvasLoadUnder1s', 'canvasLoadUnder1s',
      'canvasLoad1to5s', 'canvasLoad1to5s', 'canvasLoad1to5s',
      'canvasLoad5to20s', 'canvasLoad5to20s', 'canvasLoad5to20s',
      'canvasLoadOver20s', 'canvasLoadOver20s',
    ]);
    // The top rung is exactly the old slow-load rule, so canvasLoadOver20s keeps its meaning.
    for (const m of ms) expect(canvasLoadFeature(m) === 'canvasLoadOver20s', String(m)).toBe(slowCanvasLoad(m));
  });

  it('a paint is under 1 s, 1–5 s or over 5 s', () => {
    const ms = [0, 999, 1000, 5000, 5001, 600_000];
    expect(ms.map(canvasPaintFeature)).toEqual([
      'canvasPaintUnder1s', 'canvasPaintUnder1s', 'canvasPaint1to5s', 'canvasPaint1to5s', 'canvasPaintOver5s', 'canvasPaintOver5s',
    ]);
  });

  it('a time that is not one records nothing', () => {
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(canvasLoadFeature(bad), String(bad)).toBeUndefined();
      expect(canvasPaintFeature(bad), String(bad)).toBeUndefined();
    }
  });

  it('the families are listed in FEATURES, fastest first, and the new keys are appended after #332\'s (only #347\'s, #364\'s, #358\'s and #371\'s follow them)', () => {
    expect([...CANVAS_LOAD_FEATURES]).toEqual(['canvasLoadUnder1s', 'canvasLoad1to5s', 'canvasLoad5to20s', 'canvasLoadOver20s']);
    expect([...CANVAS_PAINT_FEATURES]).toEqual(['canvasPaintUnder1s', 'canvasPaint1to5s', 'canvasPaintOver5s']);
    expect(FEATURES.slice(FEATURES.indexOf('modelRepoHasRemote') + 1)).toEqual([
      'canvasLoadUnder1s', 'canvasLoad1to5s', 'canvasLoad5to20s', 'canvasLoadCold',
      'canvasPaintUnder1s', 'canvasPaint1to5s', 'canvasPaintOver5s',
      // #347: the one shared look at the folder.
      'startLookFromIndex', 'startLookIndexFallback',
      'startLookFoldersUnder200', 'startLookFolders200to2000', 'startLookFoldersOver2000',
      'startLookFoundAfterDeadline', 'dbtSearchFromIndex',
      // #364: what a panel that never said ready met.
      'noReadyHostHeld', 'noReadyClosed30to60s', 'noReadyClosedOver60s',
      // #358: what a SQL import's tables defined twice were.
      'importDuplicateSame', 'importDuplicateDiffers', 'importDuplicateDiffersDefaultSchema', 'importPartialDuplicateOnly',
      // #371: which step held a slow open.
      'canvasLoadSlowManifest', 'canvasLoadSlowYml', 'canvasLoadSlowCatalog', 'canvasLoadSlowRead',
      'canvasLoadSlowPositions', 'canvasLoadSlowPhysical', 'canvasLoadSlowDisplay', 'canvasLoadSlowOther',
    ]);
    // canvasLoadOver20s stays where 2.0.0 put it.
    expect(FEATURES.indexOf('canvasLoadOver20s')).toBeLessThan(FEATURES.indexOf('draftDropTimeLimit'));
  });
});

describe('the slowest open of the day (#333)', () => {
  it('300 ms warm, 3 s cold, 500 ms cold, 25 s warm: only canvasLoadOver20s, and not cold', () => {
    let s = emptyCounters(DAY);
    s = load(s, 300, false);
    expect(timingKeys(s)).toEqual({ canvasLoadUnder1s: 1 });
    s = load(s, 3000, true);
    expect(timingKeys(s)).toEqual({ canvasLoad1to5s: 1, canvasLoadCold: 1 });
    s = load(s, 500, true);
    expect(timingKeys(s)).toEqual({ canvasLoad1to5s: 1, canvasLoadCold: 1 });
    s = load(s, 25_000, false);
    // The slowest open was warm: the faster one's cold flag goes with it.
    expect(timingKeys(s)).toEqual({ canvasLoadOver20s: 1 });
  });

  it('a slow cold open, then a fast warm one: the slow one and its cold flag stay', () => {
    let s = load(emptyCounters(DAY), 7000, true);
    s = load(s, 200, false);
    expect(timingKeys(s)).toEqual({ canvasLoad5to20s: 1, canvasLoadCold: 1 });
  });

  it('two opens in the same range: cold if either was', () => {
    expect(timingKeys(load(load(emptyCounters(DAY), 1500, false), 4000, true))).toEqual({ canvasLoad1to5s: 1, canvasLoadCold: 1 });
    expect(timingKeys(load(load(emptyCounters(DAY), 1500, true), 4000, false))).toEqual({ canvasLoad1to5s: 1, canvasLoadCold: 1 });
    expect(timingKeys(load(load(emptyCounters(DAY), 1500, false), 4000, false))).toEqual({ canvasLoad1to5s: 1 });
  });

  it('a faster open changes nothing (the same object back, so nothing is written)', () => {
    const s = load(emptyCounters(DAY), 6000, false);
    expect(load(s, 10, true)).toBe(s);
    expect(load(s, 6500, false)).toBe(s);
  });

  it('for any sequence of opens: exactly one load key, the slowest, and cold exactly when an open in that range was', () => {
    const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const next = rng(333);
    for (let run = 0; run < 300; run++) {
      let s = emptyCounters(DAY);
      const opens: Array<[number, boolean]> = [];
      for (let i = 0; i < 1 + Math.floor(next() * 8); i++) {
        const open: [number, boolean] = [Math.floor(next() * 30_000), next() < 0.5];
        opens.push(open);
        s = load(s, ...open);
      }
      const rank = (ms: number) => CANVAS_LOAD_FEATURES.indexOf(canvasLoadFeature(ms)!);
      const top = Math.max(...opens.map(([ms]) => rank(ms)));
      const loadKeys = CANVAS_LOAD_FEATURES.filter((f) => s.features[f]);
      expect(loadKeys, JSON.stringify(opens)).toEqual([CANVAS_LOAD_FEATURES[top]]);
      const cold = opens.some(([ms, c]) => c && rank(ms) === top);
      expect(s.features.canvasLoadCold === 1, JSON.stringify(opens)).toBe(cold);
    }
  });

  it('the paint keeps its slowest range the same way, apart from the load', () => {
    let s = paint(emptyCounters(DAY), 6000);
    s = paint(s, 300);
    expect(timingKeys(s)).toEqual({ canvasPaintOver5s: 1 });
    s = load(s, 300, true);
    expect(timingKeys(s)).toEqual({ canvasPaintOver5s: 1, canvasLoadUnder1s: 1, canvasLoadCold: 1 });
    expect(timingKeys(paint(paint(emptyCounters(DAY), 200), 1200))).toEqual({ canvasPaint1to5s: 1 });
  });

  it('none of them carries over to the next day, so an idle day sends nothing', () => {
    const s = paint(load(emptyCounters(DAY), 25_000, true), 7000);
    const tomorrow = nextDay(s, '2026-11-17');
    expect(timingKeys(tomorrow)).toEqual({});
    expect(hasCounts(tomorrow)).toBe(false);
  });
});

describe('the heartbeat (#333)', () => {
  it('sends presence flags only: never a number of milliseconds', () => {
    const s = paint(load(emptyCounters(DAY), 7321, true), 4567);
    const body = buildHeartbeat(s, ENV);
    expect(timingKeys(body)).toEqual({ canvasLoad5to20s: 1, canvasLoadCold: 1, canvasPaint1to5s: 1 });
    expect(JSON.stringify(body)).not.toMatch(/7321|4567/);
  });

  it('a day over the size guard keeps them: they are the newest keys, and the trim would take them first', () => {
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const s: DailyCounters = { ...emptyCounters(DAY), features: all };
    const body = provisionalBody(buildHeartbeat(s, ENV));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    for (const key of [...CANVAS_LOAD_FEATURES, 'canvasLoadCold', ...CANVAS_PAINT_FEATURES]) expect(trimmed.features[key as keyof typeof trimmed.features], key).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The facade: canvasLoadOver20s keeps its one trail event a day; the rest are off the trail
// ---------------------------------------------------------------------------

const mock = vscode as unknown as {
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
};

describe('telemetry.canvasLoad / canvasPaint (#333)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let service: TelemetryService | undefined;
  const at = (iso: string) => vi.setSystemTime(new Date(`2026-11-16T${iso}Z`));

  beforeEach(() => {
    vi.useFakeTimers();
    at('10:00:00');
    fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    mock._resetMockConfiguration();
    mock._setMockTelemetryEnabled(true);
    const root = path.join(os.tmpdir(), 'erd-canvas-open-timing-test');
    fs.mkdirSync(root, { recursive: true });
    const context = mock.createMockExtensionContext({ storageRoot: root, extensionRoot: root, packageJSON: { version: '2.0.7' } });
    // A new install: the onboarding trail is kept today.
    void context.globalState.update('erdStudio.telemetry.firstSeenDay', '2026-11-16');
    service = new TelemetryService(context);
    service.start();
  });
  afterEach(() => {
    service?.dispose();
    service = undefined;
    setTelemetryEndpointForTests(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function sent(): Promise<HeartbeatBody> {
    vi.setSystemTime(new Date('2026-11-17T00:30:00Z'));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return JSON.parse(init.body as string) as HeartbeatBody;
  }

  it('records the slowest ranges; only the first canvasLoadOver20s of the day is a trail event', async () => {
    telemetry.activation('project_found', true, 1);
    at('10:00:05'); telemetry.canvasLoad(300, true);
    telemetry.canvasPaint(800);
    at('10:01:00'); telemetry.canvasLoad(25_000, false);
    at('10:02:00'); telemetry.canvasLoad(26_000, true);
    telemetry.canvasPaint(6000);
    telemetry.canvasLoad(Number.NaN, true);
    telemetry.canvasPaint(-1);
    const body = await sent();
    expect(timingKeys(body)).toEqual({ canvasLoadOver20s: 1, canvasLoadCold: 1, canvasPaintOver5s: 1 });
    expect(body.trail?.map(([event]) => event)).toEqual(['windowOpened', 'canvasLoadOver20s']);
  });

  it('records nothing while telemetry is off', () => {
    mock._setMockTelemetryEnabled(false);
    telemetry.canvasLoad(25_000, true);
    telemetry.canvasPaint(6000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The page's half: one canvasPainted per page, never while hidden, never from the viewer
// ---------------------------------------------------------------------------

describe('the canvas says when its first diagram is drawn (#333)', () => {
  type Sent = { type: 'canvasPainted'; payload: { ms: number } };
  function fakePage() {
    let clock = 0;
    let visible = true;
    const frames: Array<() => void> = [];
    const tasks: Array<() => void> = [];
    const deps: PaintTimingDeps = {
      now: () => clock,
      frame: (cb) => { frames.push(cb); },
      later: (cb) => { tasks.push(cb); },
      visible: () => visible,
    };
    return {
      deps,
      advance: (ms: number) => { clock += ms; },
      hide: () => { visible = false; },
      show: () => { visible = true; },
      /** The next paint: the frame callbacks run, then the tasks they queued. */
      paint: () => { frames.splice(0).forEach((f) => f()); tasks.splice(0).forEach((t) => t()); },
    };
  }

  beforeEach(() => _resetPaintTimingForTests());

  it('posts once, after the paint that follows the tables being measured, with the page\'s own time since its first diagram', () => {
    const page = fakePage();
    const sent: Sent[] = [];
    notePayloadReceived(page.deps);
    page.advance(1200);
    answerFirstPaint((m) => sent.push(m), page.deps);
    expect(sent).toEqual([]);
    page.advance(34.4);
    page.paint();
    expect(sent).toEqual([{ type: 'canvasPainted', payload: { ms: 1234 } }]);
    expect(validateCanvasPaintedPayload(sent[0].payload)).toBe(true);
  });

  it('a later diagram (a refresh, an undo, a stage switch) is not an open: nothing more is sent', () => {
    const page = fakePage();
    const sent: Sent[] = [];
    notePayloadReceived(page.deps);
    answerFirstPaint((m) => sent.push(m), page.deps);
    page.paint();
    notePayloadReceived(page.deps);
    page.advance(5000);
    answerFirstPaint((m) => sent.push(m), page.deps);
    page.paint();
    expect(sent).toHaveLength(1);
  });

  it('nothing is drawn before the first diagram arrives, so nothing is sent', () => {
    const page = fakePage();
    const sent: Sent[] = [];
    answerFirstPaint((m) => sent.push(m), page.deps);
    page.paint();
    expect(sent).toEqual([]);
  });

  it('a page hidden at any point sends nothing: on arrival, while waiting, or at the paint', () => {
    for (const when of ['arrival', 'waiting', 'measuring', 'paint'] as const) {
      _resetPaintTimingForTests();
      const page = fakePage();
      const sent: Sent[] = [];
      if (when === 'arrival') page.hide();
      notePayloadReceived(page.deps);
      page.show();
      if (when === 'waiting') notePageHidden();
      answerFirstPaint((m) => sent.push(m), page.deps);
      if (when === 'measuring') notePageHidden();
      if (when === 'paint') page.hide();
      page.paint();
      expect(sent, when).toEqual([]);
      // And it is not timed later, when shown again.
      page.show();
      answerFirstPaint((m) => sent.push(m), page.deps);
      page.paint();
      expect(sent, when).toEqual([]);
    }
  });

  it('caps a time at the host\'s limit, so a very slow paint still counts as Over5s', () => {
    const page = fakePage();
    const sent: Sent[] = [];
    notePayloadReceived(page.deps);
    page.advance(CANVAS_PAINTED_MAX_MS + 50_000);
    answerFirstPaint((m) => sent.push(m), page.deps);
    page.paint();
    expect(sent[0].payload.ms).toBe(CANVAS_PAINTED_MAX_MS);
    expect(validateCanvasPaintedPayload(sent[0].payload)).toBe(true);
  });

  it('the host refuses anything but a time of 0 to 10 minutes', () => {
    for (const ok of [{ ms: 0 }, { ms: 1200 }, { ms: 12.5 }, { ms: CANVAS_PAINTED_MAX_MS }]) expect(validateCanvasPaintedPayload(ok), JSON.stringify(ok)).toBe(true);
    for (const bad of [undefined, null, [], {}, { ms: '1200' }, { ms: -1 }, { ms: CANVAS_PAINTED_MAX_MS + 1 }, { ms: Number.NaN }, { ms: Number.POSITIVE_INFINITY }]) {
      expect(validateCanvasPaintedPayload(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the sender is the editor\'s, never the renderer\'s: the Confluence viewer cannot post it', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(full);
      }
    };
    walk(path.resolve(__dirname, '../../packages/renderer/src'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => fs.readFileSync(f, 'utf8').includes('canvasPainted'))).toEqual([]);
    // The editor's page has the one sender, from its first domainLoaded.
    const app = fs.readFileSync(path.resolve(__dirname, '../../webview/App.tsx'), 'utf8');
    expect(app).toMatch(/case 'domainLoaded':[\s\S]{0,300}notePayloadReceived\(\)/);
    expect(app).toContain('<FirstPaintTiming />');
  });
});
