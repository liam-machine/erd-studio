/**
 * StartIntentTracker (src/commands/startIntent.ts): the host's suggestion for
 * the open folder — when it looks at the folder (only when the files can
 * decide, never twice within a minute, once more after running out of
 * time, then not again), that a look is bounded and cancelled, that concurrent asks share one
 * look, that the context key is published only on a change, and that a
 * refresh asked for on activation's path is deferred.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { START_LOOK_ATTEMPTS, START_LOOK_FRESH_MS, START_LOOK_TIMEOUT_MS, StartIntentTracker, type StartIntentDeps } from '../../src/commands/startIntent';
import { detectImportSources, type DetectImportIo } from '../../src/commands/importModel';
import type { DetectedImportSource, StartContext } from '../../src/types/startActions';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tracker(over: Partial<StartIntentDeps> & { ctx?: Omit<StartContext, 'found'> } = {}) {
  let now = 1_000;
  const published: string[] = [];
  const ctx = { hasProject: true, hasDbt: false, storage: 'dbml' as const, hasDiagrams: false, ...over.ctx };
  const look = over.look ?? vi.fn(async (): Promise<ReadonlySet<DetectedImportSource>> => new Set(['sqlDdl']));
  const t = new StartIntentTracker({
    context: () => ctx,
    look,
    publish: (intent) => published.push(intent),
    now: () => now,
    ...over,
  });
  return { t, look, published, ctx, advance: (ms: number) => { now += ms; } };
}

describe('StartIntentTracker', () => {
  it('looks at the folder when its files decide, publishes the suggestion once, and reuses the look for a minute', async () => {
    const { t, look, published, advance } = tracker();
    expect(t.known()).toBe('blank'); // nothing looked at yet
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(t.known()).toBe('importSqlDdl');
    expect(t.startContext().found).toEqual(new Set(['sqlDdl']));
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(look).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['importSqlDdl']);
    advance(START_LOOK_FRESH_MS + 1);
    await t.refresh();
    expect(look).toHaveBeenCalledTimes(2);
    expect(published).toEqual(['importSqlDdl']); // unchanged: not published again
  });

  it('a folder whose state cannot be read still gets a suggestion published (blank), so the empty view never stays on Loading', async () => {
    const { t, look, published } = tracker({ context: () => { throw new Error('unreadable'); } });
    expect(await t.refresh()).toBeUndefined();
    expect(published).toEqual(['blank']);
    await t.refresh();
    expect(published).toEqual(['blank']); // once
    expect(look).not.toHaveBeenCalled();
  });

  it('never looks when the files cannot decide: dbt, a project from before 2.0, a project with a diagram', async () => {
    for (const [ctx, intent] of [
      [{ hasProject: true, hasDbt: true }, 'drawFromDbt'],
      [{ hasProject: true, hasDbt: false, storage: 'yaml' as const }, 'convert'],
      [{ hasProject: true, hasDbt: false, storage: 'dbml' as const, hasDiagrams: true }, 'blank'],
    ] as const) {
      const { t, look, published } = tracker({ ctx });
      expect(await t.refresh()).toBe(intent);
      expect(look).not.toHaveBeenCalled();
      expect(published).toEqual([intent]);
    }
  });

  it('shares one look between concurrent asks', async () => {
    let resolve!: (found: ReadonlySet<DetectedImportSource>) => void;
    const look = vi.fn(() => new Promise<ReadonlySet<DetectedImportSource>>((r) => { resolve = r; }));
    const { t, published } = tracker({ look });
    const a = t.refresh();
    const b = t.refresh();
    resolve(new Set(['semanticModel']));
    expect(await Promise.all([a, b])).toEqual(['importSemanticModel', 'importSemanticModel']);
    expect(look).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['importSemanticModel']);
  });

  it('cancels a look that runs out of time and suggests a blank diagram; tries once more (with twice the time) on the next refresh, then not again this session', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const look = vi.fn((s: AbortSignal) => { signals.push(s); return new Promise<ReadonlySet<DetectedImportSource>>(() => {}); });
    const { t, published, advance } = tracker({ look });
    const pending = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await pending).toBe('blank');
    expect(signals[0]?.aborted).toBe(true);
    expect(published).toEqual(['blank']);
    // The retry: twice the time.
    const retry = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await retry).toBe('blank');
    expect(signals[1]?.aborted).toBe(true);
    expect(look).toHaveBeenCalledTimes(START_LOOK_ATTEMPTS);
    advance(10 * START_LOOK_FRESH_MS);
    await t.refresh();
    expect(look).toHaveBeenCalledTimes(START_LOOK_ATTEMPTS);
  });

  it('a retried look that answers counts', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const look = vi.fn(() => (++calls === 1 ? new Promise<ReadonlySet<DetectedImportSource>>(() => {}) : Promise.resolve(new Set<DetectedImportSource>(['sqlDdl']))));
    const { t } = tracker({ look });
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await first).toBe('blank');
    expect(await t.refresh()).toBe('importSqlDdl');
  });

  it('tells the host when the look saw a dbt_project.yml in a window without dbt (never in one with dbt)', async () => {
    const onDbtProjectSeen = vi.fn();
    const { t } = tracker({ look: vi.fn(async () => ({ sources: new Set<DetectedImportSource>(), dbtProject: true })), onDbtProjectSeen });
    expect(await t.refresh()).toBe('blank');
    expect(onDbtProjectSeen).toHaveBeenCalledTimes(1);
  });

  it('a look that fails counts as nothing found', async () => {
    const { t } = tracker({ look: vi.fn(async () => { throw new Error('search unavailable'); }) });
    expect(await t.refresh()).toBe('blank');
  });

  it('publishes a change when the folder changes (a diagram made, a later look)', async () => {
    const found = new Set<DetectedImportSource>(['dbml']);
    const { t, published, ctx, advance } = tracker({ look: vi.fn(async () => found) });
    expect(await t.refresh()).toBe('importDbmlFile');
    (ctx as { hasDiagrams: boolean }).hasDiagrams = true;
    expect(await t.refresh()).toBe('blank');
    (ctx as { hasDiagrams: boolean }).hasDiagrams = false;
    found.clear();
    found.add('sqlDdl');
    advance(START_LOOK_FRESH_MS + 1);
    expect(await t.refresh()).toBe('importSqlDdl');
    expect(published).toEqual(['importDbmlFile', 'blank', 'importSqlDdl']);
  });

  it('scheduleRefresh runs on a later tick (never inside the caller), coalesced; dispose stops it and aborts a look', async () => {
    vi.useFakeTimers();
    const context = vi.fn(() => ({ hasProject: true, hasDbt: false }));
    let signal: AbortSignal | undefined;
    const look = vi.fn((s: AbortSignal) => { signal = s; return new Promise<ReadonlySet<DetectedImportSource>>(() => {}); });
    const t = new StartIntentTracker({ context, look, publish: () => {} });
    t.scheduleRefresh();
    t.scheduleRefresh();
    expect(context).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(look).toHaveBeenCalledTimes(1);
    t.dispose();
    expect(signal?.aborted).toBe(true);
    t.scheduleRefresh();
    await vi.advanceTimersByTimeAsync(10);
    expect(look).toHaveBeenCalledTimes(1);
  });
});

describe('StartIntentTracker telemetry (2.0 B9): fixed keys only, never what the look found', () => {
  const recorders = () => {
    const keys: string[] = [];
    return { keys, feature: (k: string) => { keys.push(k); }, error: (c: string) => { keys.push(`!${c}`); } };
  };

  it('each timeout counts startLookTimeout; running out of attempts counts startLookGaveUp once', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const look = vi.fn(() => new Promise<ReadonlySet<DetectedImportSource>>(() => {}));
    const { t, advance } = tracker({ look, feature: r.feature, error: r.error });
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    await first;
    expect(r.keys).toEqual(['startLookTimeout']);
    const retry = t.refresh();
    await vi.advanceTimersByTimeAsync(2 * START_LOOK_TIMEOUT_MS);
    await retry;
    expect(r.keys).toEqual(['startLookTimeout', 'startLookTimeout', 'startLookGaveUp']);
    advance(10 * START_LOOK_FRESH_MS);
    await t.refresh();
    expect(r.keys).toHaveLength(3);
  });

  it('a rejection after our own abort (the timeout) records nothing', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const look = vi.fn((signal: AbortSignal) => new Promise<ReadonlySet<DetectedImportSource>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { t } = tracker({ look, feature: r.feature, error: r.error });
    const pending = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await pending).toBe('blank');
    await vi.advanceTimersByTimeAsync(0);
    expect(r.keys).toEqual(['startLookTimeout']);
  });

  it('a real rejection records the error startLookFailed', async () => {
    const r = recorders();
    const { t } = tracker({ look: vi.fn(async () => { throw new Error('search unavailable'); }), feature: r.feature, error: r.error });
    expect(await t.refresh()).toBe('blank');
    expect(r.keys).toEqual(['!startLookFailed']);
  });

  it('a context that throws records startContextFailed; a recorder that throws changes nothing', async () => {
    const r = recorders();
    const { t, published } = tracker({ context: () => { throw new Error('unreadable'); }, feature: r.feature, error: r.error });
    await t.refresh();
    expect(r.keys).toEqual(['!startContextFailed']);
    const broken = tracker({ look: vi.fn(async () => { throw new Error('x'); }), error: () => { throw new Error('telemetry'); } });
    expect(await broken.t.refresh()).toBe('blank');
    expect(published).toEqual(['blank']);
  });
});

describe('the look is Import…\'s own detector, stopping when cancelled', () => {
  it('opens no more .sql files once cancelled', async () => {
    let cancelled = false;
    const readStart = vi.fn(async () => { cancelled = true; return 'select 1'; });
    const io: DetectImportIo = {
      root: '/w',
      readDirectory: async (folder) => (folder === '/w' ? [['a.sql', false], ['b.sql', false], ['c.sql', false]] as const : []),
      readStart,
      cancelled: () => cancelled,
    };
    expect(await detectImportSources(io, '.erd-studio')).toEqual(new Set());
    expect(readStart).toHaveBeenCalledTimes(1);
  });

  it('lists nothing once cancelled', async () => {
    const readDirectory = vi.fn(async () => [['sub', true], ['a.sql', false]] as const);
    const io: DetectImportIo = { root: '/w', readDirectory, readStart: vi.fn(async () => ''), cancelled: () => true };
    expect(await detectImportSources(io, '.erd-studio')).toEqual(new Set());
    expect(readDirectory).not.toHaveBeenCalled();
  });
});
