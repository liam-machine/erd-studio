/**
 * StartIntentTracker (src/commands/startIntent.ts): the host's suggestion for
 * the open folder — when it looks at the folder (only when the files can
 * decide, never twice within a minute, never again after running out of
 * time), that a look is bounded and cancelled, that concurrent asks share one
 * look, that the context key is published only on a change, and that a
 * refresh asked for on activation's path is deferred.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { START_LOOK_FRESH_MS, START_LOOK_TIMEOUT_MS, StartIntentTracker, type StartIntentDeps } from '../../src/commands/startIntent';
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

  it('cancels a look that runs out of time, suggests a blank diagram, and does not look again this session', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const look = vi.fn((s: AbortSignal) => { signal = s; return new Promise<ReadonlySet<DetectedImportSource>>(() => {}); });
    const { t, published, advance } = tracker({ look });
    const pending = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await pending).toBe('blank');
    expect(signal?.aborted).toBe(true);
    expect(published).toEqual(['blank']);
    advance(10 * START_LOOK_FRESH_MS);
    await t.refresh();
    expect(look).toHaveBeenCalledTimes(1);
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

describe('the look is Import…\'s own detector, stopping when cancelled', () => {
  it('opens no more .sql files once cancelled', async () => {
    let cancelled = false;
    const readStart = vi.fn(async () => { cancelled = true; return 'select 1'; });
    const io: DetectImportIo = {
      findFiles: async (include) => (include.includes('*.sql') ? ['a.sql', 'b.sql', 'c.sql'] : []),
      readStart,
      cancelled: () => cancelled,
    };
    expect(await detectImportSources(io, '.erd-studio')).toEqual(new Set());
    expect(readStart).toHaveBeenCalledTimes(1);
  });
});
