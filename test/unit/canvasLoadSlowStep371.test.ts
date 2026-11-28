/**
 * #371: in a dbt project a Logical diagram open waits for all of dbt's files
 * (manifest.json, the schema yml walk, catalog.json) before it reads the
 * diagram. Telemetry recorded the open's range (canvasLoad*) but never which
 * step held it, and the canvas said only "Loading N tables…" the whole time.
 *
 * The rules pinned here:
 *
 * - an open over 5 s records one `canvasLoadSlow*` key naming the step that
 *   took longest, from the steps `sendSubjectAreaData` already names for a
 *   failure (#262); whatever the span holds beyond them (the `loading` posts,
 *   a host busy before ERD Studio read anything) is `other`, never blamed on
 *   the manifest;
 * - the step keys follow `canvasLoadCold`'s day rule: a slower range replaces
 *   them, the same range adds this open's, a faster one changes nothing;
 * - in a dbt project whose schema yml is not read yet, the loading note says
 *   the dbt files are being read, beside the table count;
 * - the open's order does not change: no diagram before dbt's files are read
 *   (the bounded wait was rejected: it cannot interrupt the synchronous yml walk).
 *
 * Time is simulated: each wrapped read moves a spied Date.now forward (the
 * ready handler and the step timing use Date.now), so nothing really sleeps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { telemetry } from '../../src/services/telemetryService';
import { canvasLoadFeature } from '../../src/services/telemetryCanvas';
import {
  CANVAS_LOAD_FEATURES,
  CANVAS_LOAD_SLOW_FEATURES,
  CANVAS_LOAD_SLOW_STEP_FEATURES,
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  provisionalBody,
  recordCanvasLoad,
  slowestLoadStep,
  subjectAreaLoadStepCode,
  trimHeartbeat,
  type DailyCounters,
  type HeartbeatEnv,
  type SubjectAreaLoadStep,
} from '../../src/services/telemetryPayload';
import { dbtFixtureRoot, diagramPath } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');
type Posted = { type: string; payload?: Record<string, unknown> };
type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;

let root: string;
let offset = 0;
const realNow = Date.now.bind(Date);
const realSetTimeout = globalThis.setTimeout;

function build() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const manifestService = new ManifestService();
  const ymlParserService = new YmlParserService();
  const catalogService = new CatalogService();
  const provider = new SemanticEditorProvider(
    context, subjectAreaService, manifestService, ymlParserService, new TemplateService(), layerService, root,
    new SelectorsService(subjectAreaService, root, '.erd-studio'), tableLibraryService,
  );
  provider.setCatalogService(catalogService);
  return { provider, manifestService, ymlParserService, catalogService, subjectAreaService };
}

/** Make `method` "take" `ms`: Date.now jumps when it finishes. */
function slow<T extends object>(svc: T, method: keyof T, ms: number) {
  const original = (svc[method] as unknown as (...a: unknown[]) => unknown).bind(svc);
  vi.spyOn(svc, method as never).mockImplementation(((...args: unknown[]) => {
    const result = original(...args);
    if (result instanceof Promise) return result.then((r) => { offset += ms; return r; });
    offset += ms;
    return result;
  }) as never);
}

/** Hold `loadManifest` until the returned release is called. */
function gateManifest(manifestService: ManifestService): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const original = manifestService.loadManifest.bind(manifestService);
  vi.spyOn(manifestService, 'loadManifest').mockImplementation(async (p) => { await gate; return original(p); });
  return () => release();
}

function makeDoc(file: string): import('vscode').TextDocument {
  return {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (o: number) => ({ o }), save: async () => true,
  } as unknown as import('vscode').TextDocument;
}

async function resolve(provider: SemanticEditorProvider, file: string, doc = makeDoc(file)): Promise<MockPanel> {
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  return panel;
}

/** Let the ready handler run as far as it can (up to the gated dbt read). */
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((r) => realSetTimeout(r, 2));
}

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const loadingPayloads = (panel: MockPanel) => posted(panel).filter((m) => m.type === 'loading').map((m) => m.payload ?? {});

/**
 * The `canvasLoadSlow*` keys the day would hold after the opens `canvasLoad`
 * was called with, through the bucket and the reducer as the facade does.
 */
function recordedSlowKeys(canvasLoad: { mock: { calls: unknown[][] } }): string[] {
  let s = emptyCounters('2026-11-28');
  for (const [ms, cold, step] of canvasLoad.mock.calls as Array<[number, boolean, SubjectAreaLoadStep | undefined]>) {
    const key = canvasLoadFeature(ms);
    if (key) s = recordCanvasLoad(s, key, cold, step);
  }
  return CANVAS_LOAD_SLOW_FEATURES.filter((f) => s.features[f]);
}

const SHOWCASE = () => diagramPath(root, 'yaml', 'silver', 'showcase');

beforeEach(() => {
  vscode._resetMockWorkspace();
  offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-371-'));
  fs.cpSync(dbtFixtureRoot('dbt-project'), root, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#371 the open keeps its order (no bounded wait)', () => {
  it('a Logical open does not read or post the diagram until manifest.json has been parsed', async () => {
    const { provider, manifestService, subjectAreaService } = build();
    const release = gateManifest(manifestService);
    const read = vi.spyOn(subjectAreaService, 'getSubjectArea');

    const panel = await resolve(provider, SHOWCASE());
    const ready = panel._simulateMessage({ type: 'ready' });
    await settle();

    expect(posted(panel).filter((m) => m.type === 'domainLoaded')).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();

    release();
    await ready;
    expect(read).toHaveBeenCalled();
    expect(posted(panel).filter((m) => m.type === 'domainLoaded')).toHaveLength(1);
    // No extra post: the sequence is the one every loading test pins.
    expect(posted(panel).map((m) => m.type).slice(0, 5)).toEqual(['loading', 'loading', 'lineStyle', 'tableSubtitle', 'domainLoaded']);
  });
});

describe('#371 which step held a slow open', () => {
  it('FEATURES carries one canvasLoadSlow* key per open step, other included', () => {
    expect([...CANVAS_LOAD_SLOW_FEATURES]).toEqual([
      'canvasLoadSlowManifest', 'canvasLoadSlowYml', 'canvasLoadSlowCatalog', 'canvasLoadSlowRead',
      'canvasLoadSlowPositions', 'canvasLoadSlowPhysical', 'canvasLoadSlowDisplay', 'canvasLoadSlowOther',
    ]);
    // Appended at the tail, after #347's keys.
    expect(FEATURES.slice(FEATURES.indexOf('dbtSearchFromIndex') + 1)).toEqual([...CANVAS_LOAD_SLOW_FEATURES]);
  });

  it('the step-to-key map covers every SubjectAreaLoadStep, one key each, in the steps\' order', () => {
    const steps: SubjectAreaLoadStep[] = ['manifest', 'yml', 'catalog', 'read', 'positions', 'physical', 'display', 'other'];
    // The failure codes (#262) and the slow keys name the same steps.
    for (const step of steps) expect(subjectAreaLoadStepCode(step)).toMatch(/^domainLoadInternal/);
    expect(steps.map((s) => CANVAS_LOAD_SLOW_STEP_FEATURES[s])).toEqual([...CANVAS_LOAD_SLOW_FEATURES]);
    expect(Object.keys(CANVAS_LOAD_SLOW_STEP_FEATURES)).toEqual(steps);
  });

  it.each([
    ['manifest', 'canvasLoadSlowManifest', 'loadManifest'],
    ['yml', 'canvasLoadSlowYml', 'loadYmlData'],
    ['catalog', 'canvasLoadSlowCatalog', 'loadCatalog'],
  ] as const)('a slow open whose %s read held it records %s', async (step, key, method) => {
    const built = build();
    const svc = method === 'loadManifest' ? built.manifestService : method === 'loadYmlData' ? built.ymlParserService : built.catalogService;
    slow(svc as never, method as never, 25_000);
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel = await resolve(built.provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(posted(panel).some((m) => m.type === 'domainLoaded')).toBe(true);
    expect(canvasLoad).toHaveBeenCalledTimes(1);
    expect(canvasLoad.mock.calls[0][0]).toBeGreaterThan(20_000);
    expect(canvasLoad.mock.calls[0][2]).toBe(step);
    expect(recordedSlowKeys(canvasLoad)).toEqual([key]);
  });

  it('a slow diagram read records canvasLoadSlowRead', async () => {
    const { provider, subjectAreaService } = build();
    slow(subjectAreaService, 'getSubjectArea', 8000);
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(canvasLoad.mock.calls[0][2]).toBe('read');
    expect(recordedSlowKeys(canvasLoad)).toEqual(['canvasLoadSlowRead']);
  });

  it('a host busy before any step (postLoading blocks 6 s, the dbt reads are instant) is other, not the manifest', async () => {
    const { provider, subjectAreaService } = build();
    slow(subjectAreaService, 'countSubjectAreaTablesInText', 6000);
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(canvasLoad.mock.calls[0][0]).toBeGreaterThan(5000);
    expect(canvasLoad.mock.calls[0][2]).toBe('other');
    expect(recordedSlowKeys(canvasLoad)).toEqual(['canvasLoadSlowOther']);
  });

  it('a manifest invalidate makes the next warm open pay again, and the step names it though no table file was read', async () => {
    const { provider, manifestService, ymlParserService } = build();
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    manifestService.invalidate();
    ymlParserService.invalidate();
    slow(manifestService, 'loadManifest', 25_000);
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel2 = await resolve(provider, SHOWCASE());
    await panel2._simulateMessage({ type: 'ready' });
    expect(canvasLoad.mock.calls[0][0]).toBeGreaterThanOrEqual(20_000);
    // Warm tables: canvasLoadCold is not set, so only the step says dbt held it.
    expect(canvasLoad.mock.calls[0][1]).toBe(false);
    expect(recordedSlowKeys(canvasLoad)).toEqual(['canvasLoadSlowManifest']);
  });

  it('two opens at once (a window restored with both): one open\'s yml walk is never blamed on the other\'s manifest', async () => {
    // Steps are timed by wall clock across awaits. Both opens wait on the same
    // manifest read; when it resolves, the first runs the schema yml walk
    // (synchronous, 6 s here) and the second's continuation waits behind it,
    // so its manifest step would hold those 6 s. Overlapping loads blame each
    // other's work, so each records `other` instead of a step.
    const { provider, manifestService, ymlParserService } = build();
    const release = gateManifest(manifestService);
    const walk = (ymlParserService as unknown as { findProjectFiles: (p: string) => unknown });
    const findProjectFiles = walk.findProjectFiles.bind(ymlParserService);
    vi.spyOn(walk, 'findProjectFiles').mockImplementation((p: string) => { offset += 6000; return findProjectFiles(p); });
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');

    const a = await resolve(provider, SHOWCASE());
    const b = await resolve(provider, diagramPath(root, 'yaml', 'silver', 'ncr'));
    const readyA = a._simulateMessage({ type: 'ready' });
    const readyB = b._simulateMessage({ type: 'ready' });
    await settle();
    release();
    await Promise.all([readyA, readyB]);

    expect(canvasLoad).toHaveBeenCalledTimes(2);
    for (const [ms] of canvasLoad.mock.calls) expect(ms).toBeGreaterThan(5000);
    expect(canvasLoad.mock.calls.map((c) => c[2])).toEqual(['other', 'other']);
    expect(recordedSlowKeys(canvasLoad)).toEqual(['canvasLoadSlowOther']);
  });

  it('an open that overlapped nothing keeps its step after an earlier load finished', async () => {
    const { provider, ymlParserService } = build();
    const first = await resolve(provider, SHOWCASE());
    await first._simulateMessage({ type: 'ready' });
    ymlParserService.invalidate();
    slow(ymlParserService, 'loadYmlData', 7000);
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const second = await resolve(provider, diagramPath(root, 'yaml', 'silver', 'ncr'));
    await second._simulateMessage({ type: 'ready' });
    expect(canvasLoad.mock.calls[0][2]).toBe('yml');
  });

  it('a fast open still passes its step, and the reducer records no slow key for it', async () => {
    const { provider } = build();
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(canvasLoad).toHaveBeenCalledTimes(1);
    expect(canvasLoad.mock.calls[0][0]).toBeLessThan(5000);
    expect(recordedSlowKeys(canvasLoad)).toEqual([]);
  });

  it('a refresh (no persistPositions) still returns the posted count and records no canvasLoad', async () => {
    const { provider } = build();
    const doc = makeDoc(SHOWCASE());
    const panel = await resolve(provider, SHOWCASE(), doc);
    await panel._simulateMessage({ type: 'ready' });
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const count = await (provider as unknown as {
      sendSubjectAreaData(d: unknown, w: unknown, k?: string): Promise<number | undefined>;
    }).sendSubjectAreaData(doc, panel.webview);
    expect(typeof count).toBe('number');
    expect(count).toBeGreaterThan(0);
    expect(canvasLoad).not.toHaveBeenCalled();
  });

  it('a throw in the yml step still reports domainLoadInternalYml, and an open that posted nothing records no canvasLoad', async () => {
    const { provider, ymlParserService } = build();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(ymlParserService, 'loadYmlData').mockRejectedValue(new Error('boom'));
    const error = vi.spyOn(telemetry, 'error');
    const canvasLoad = vi.spyOn(telemetry, 'canvasLoad');
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(error.mock.calls.map(([code]) => code)).toContain('domainLoadInternalYml');
    expect(canvasLoad).not.toHaveBeenCalled();
  });
});

describe('#371 the loading note says dbt is being read', () => {
  it('a cold dbt open sends the count with reading: dbt, on the existing second post', async () => {
    const { provider, manifestService } = build();
    const release = gateManifest(manifestService);
    const panel = await resolve(provider, SHOWCASE());
    const ready = panel._simulateMessage({ type: 'ready' });
    await settle();
    // While dbt's files are read, the note is already out, with the count.
    expect(loadingPayloads(panel)).toEqual([{}, { tables: expect.any(Number), reading: 'dbt' }]);
    expect((loadingPayloads(panel)[1] as { tables: number }).tables).toBeGreaterThan(0);
    release();
    await ready;
  });

  it('a logical-only folder never says it reads dbt', async () => {
    const { provider } = build();
    provider.setLogicalOnly(true);
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(loadingPayloads(panel)).toEqual([{}, { tables: expect.any(Number) }]);
  });

  it('with the schema yml already read (a warm window), there is nothing to say', async () => {
    const { provider, ymlParserService } = build();
    await ymlParserService.loadYmlData(root, undefined);
    const panel = await resolve(provider, SHOWCASE());
    await panel._simulateMessage({ type: 'ready' });
    expect(loadingPayloads(panel)).toEqual([{}, { tables: expect.any(Number) }]);
  });
});

// ---------------------------------------------------------------------------
// The pure halves: the slowest step, and the day rule
// ---------------------------------------------------------------------------

const DAY = '2026-11-28';
const slowKeys = (s: DailyCounters) => CANVAS_LOAD_SLOW_FEATURES.filter((f) => s.features[f]);
const loadKeys = (s: DailyCounters) => CANVAS_LOAD_FEATURES.filter((f) => s.features[f]);

describe('slowestLoadStep (#371)', () => {
  it('the longest named step wins', () => {
    expect(slowestLoadStep({ manifest: 400, yml: 5800, catalog: 200, read: 40, display: 30, other: 5 }, 6500)).toBe('yml');
  });

  it('what the span holds beyond the named steps is other, with the time after the post', () => {
    // 6 s before any step ran (postLoading, a busy host), 50 ms of steps.
    expect(slowestLoadStep({ manifest: 10, yml: 10, catalog: 10, read: 10, display: 5, other: 5 }, 6050)).toBe('other');
    // Never less than what ran after the post, even with a span shorter than the steps.
    expect(slowestLoadStep({ manifest: 1, other: 9000 }, 100)).toBe('other');
  });

  it('a tie goes to the earlier step', () => {
    expect(slowestLoadStep({ manifest: 3000, yml: 3000 }, 6000)).toBe('manifest');
    expect(slowestLoadStep({ read: 3000 }, 6000)).toBe('read');
  });

  it('ignores a time that is not one', () => {
    expect(slowestLoadStep({ manifest: Number.NaN, yml: -5, catalog: 7000 }, 7100)).toBe('catalog');
    expect(slowestLoadStep({}, Number.NaN)).toBe('manifest');
  });
});

describe('recordCanvasLoad with a step (#371)', () => {
  const load = (s: DailyCounters, ms: number, cold: boolean, step?: SubjectAreaLoadStep) => recordCanvasLoad(s, canvasLoadFeature(ms)!, cold, step);

  it('Over20s(read) then 5to20s(manifest): only canvasLoadSlowRead', () => {
    const s = load(load(emptyCounters(DAY), 25_000, false, 'read'), 7000, true, 'manifest');
    expect(loadKeys(s)).toEqual(['canvasLoadOver20s']);
    expect(slowKeys(s)).toEqual(['canvasLoadSlowRead']);
    expect(s.features.canvasLoadCold).toBeUndefined();
  });

  it('5to20s(yml, cold) then Over20s(read, warm): only canvasLoadSlowRead, and the cold flag goes with the slower range', () => {
    let s = load(emptyCounters(DAY), 7000, true, 'yml');
    expect(slowKeys(s)).toEqual(['canvasLoadSlowYml']);
    expect(s.features.canvasLoadCold).toBe(1);
    s = load(s, 25_000, false, 'read');
    expect(loadKeys(s)).toEqual(['canvasLoadOver20s']);
    expect(slowKeys(s)).toEqual(['canvasLoadSlowRead']);
    expect(s.features.canvasLoadCold).toBeUndefined();
  });

  it('two opens in the same range keep both steps', () => {
    const s = load(load(emptyCounters(DAY), 7000, false, 'yml'), 12_000, false, 'catalog');
    expect(slowKeys(s)).toEqual(['canvasLoadSlowYml', 'canvasLoadSlowCatalog']);
  });

  it('a faster open returns the same object, so nothing is written', () => {
    const s = load(emptyCounters(DAY), 7000, false, 'yml');
    expect(load(s, 300, true, 'manifest')).toBe(s);
    expect(load(s, 3000, false, 'read')).toBe(s);
    // The same range and step again: nothing new either.
    expect(load(s, 6000, false, 'yml')).toBe(s);
  });

  it('an open under 5 s records no step key, and a slower one under 5 s drops none it does not have', () => {
    expect(slowKeys(load(emptyCounters(DAY), 300, true, 'manifest'))).toEqual([]);
    expect(slowKeys(load(load(emptyCounters(DAY), 300, true, 'manifest'), 3000, true, 'yml'))).toEqual([]);
  });

  it('a raise from under 5 s to over 5 s adds the step', () => {
    const s = load(load(emptyCounters(DAY), 3000, true), 9000, false, 'positions');
    expect(loadKeys(s)).toEqual(['canvasLoad5to20s']);
    expect(slowKeys(s)).toEqual(['canvasLoadSlowPositions']);
  });

  it('without a step (an older caller) the rule is #333\'s alone', () => {
    const s = load(load(emptyCounters(DAY), 7000, true), 25_000, false);
    expect(loadKeys(s)).toEqual(['canvasLoadOver20s']);
    expect(slowKeys(s)).toEqual([]);
  });

  it('for any sequence of opens: the step keys are exactly the steps of the slowest range\'s opens, when over 5 s', () => {
    const steps = Object.keys(CANVAS_LOAD_SLOW_STEP_FEATURES) as SubjectAreaLoadStep[];
    const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const next = rng(371);
    for (let run = 0; run < 300; run++) {
      let s = emptyCounters(DAY);
      const opens: Array<[number, SubjectAreaLoadStep]> = [];
      for (let i = 0; i < 1 + Math.floor(next() * 8); i++) {
        const open: [number, SubjectAreaLoadStep] = [Math.floor(next() * 30_000), steps[Math.floor(next() * steps.length)]];
        opens.push(open);
        s = load(s, open[0], false, open[1]);
      }
      const rank = (ms: number) => CANVAS_LOAD_FEATURES.indexOf(canvasLoadFeature(ms)!);
      const top = Math.max(...opens.map(([ms]) => rank(ms)));
      const expected = top >= CANVAS_LOAD_FEATURES.indexOf('canvasLoad5to20s')
        ? CANVAS_LOAD_SLOW_FEATURES.filter((f) => opens.some(([ms, step]) => rank(ms) === top && CANVAS_LOAD_SLOW_STEP_FEATURES[step] === f))
        : [];
      expect(slowKeys(s), JSON.stringify(opens)).toEqual(expected);
    }
  });

  it('an oversized day keeps every canvasLoadSlow* key: the size guard never drops them', () => {
    const env: HeartbeatEnv = {
      installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.13', vscodeVersion: '1.104.2', platform: 'win32', firstSeenDay: '2026-09-01',
    };
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const body = provisionalBody(buildHeartbeat({ ...emptyCounters(DAY), features: all }, env));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    for (const key of CANVAS_LOAD_SLOW_FEATURES) expect(trimmed.features[key], key).toBe(1);
  });
});
