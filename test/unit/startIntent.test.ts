/**
 * StartIntentTracker (src/commands/startIntent.ts): the host's suggestion for
 * the open folder — when it looks at the folder (only when the files can
 * decide, never twice within a minute), that running out of time is never an
 * answer (#347: the look is neither cancelled nor started again; the ask is
 * answered with what is known and what the look finds later is published
 * then), that an ask is answered from the look's first find, that concurrent
 * asks share one look, that the context key is published only on a change,
 * and that a refresh asked for on activation's path is deferred.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  START_LOOK_FRESH_MS,
  START_LOOK_PATIENCE_MS,
  START_LOOK_SETTLE_MS,
  START_LOOK_TIMEOUT_MS,
  StartIntentTracker,
  type StartIntentDeps,
  type StartLookFindings,
} from '../../src/commands/startIntent';
import { detectImportSources, type DetectImportIo } from '../../src/commands/importModel';
import type { DetectedImportSource, StartContext } from '../../src/types/startActions';

/** A look the test answers by hand: `early` for what it has found so far, `answer` for the whole of it. */
function heldLook() {
  const signals: AbortSignal[] = [];
  const earlies: Array<(findings: StartLookFindings) => void> = [];
  const answers: Array<(found: ReadonlySet<DetectedImportSource> | StartLookFindings) => void> = [];
  const look = vi.fn((signal: AbortSignal, early?: (findings: StartLookFindings) => void) => {
    signals.push(signal);
    earlies.push(early ?? (() => {}));
    return new Promise<ReadonlySet<DetectedImportSource> | StartLookFindings>((resolve) => { answers.push(resolve); });
  });
  return {
    look,
    signals,
    early: (sources: DetectedImportSource[], n = earlies.length - 1) => earlies[n]({ sources: new Set(sources) }),
    answer: (found: DetectedImportSource[] | StartLookFindings, n = answers.length - 1) => answers[n](Array.isArray(found) ? new Set(found) : found),
  };
}

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

  it('a look that runs out of time is neither cancelled nor started again: the ask gets a blank diagram after 1.5 s + 3 s, and what the look finds later is published then', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const { t, published } = tracker({ look: held.look });
    const pending = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(published).toEqual([]); // still waited for: nothing published at the first mark (#328)
    await vi.advanceTimersByTimeAsync(START_LOOK_PATIENCE_MS + 1);
    expect(await pending).toBe('blank');
    expect(published).toEqual(['blank']);
    expect(held.signals[0]?.aborted).toBe(false); // never cancelled for being slow
    // While that look runs on, a later ask neither waits again nor starts another.
    expect(await t.refresh()).toBe('blank');
    expect(held.look).toHaveBeenCalledTimes(1);
    held.answer(['sqlDdl']);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual(['blank', 'importSqlDdl']); // published as it lands, with nobody asking
    expect(t.known()).toBe('importSqlDdl');
    expect(held.look).toHaveBeenCalledTimes(1);
  });

  it('an ask is answered from the look\'s first find, a moment later (the settle time), without waiting for the whole look', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const { t, published } = tracker({ look: held.look });
    const pending = t.refresh();
    held.early(['sqlDdl']); // git's index: milliseconds in
    await vi.advanceTimersByTimeAsync(START_LOOK_SETTLE_MS - 1);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']);
    expect(t.sqlTableCount()).toBeUndefined(); // the count is exact only once the whole folder was looked at
    // The whole look: its count, and a stronger find, are published as they land.
    held.answer({ sources: new Set<DetectedImportSource>(['sqlDdl', 'semanticModel']), sqlTables: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual(['importSqlDdl', 'importSemanticModel']);
    expect(t.sqlTableCount()).toBe(4);
  });

  it('a look that finishes within the settle time is the answer: one publish, with its table count', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const { t, published } = tracker({ look: held.look });
    const pending = t.refresh();
    held.early(['dbml']);
    await vi.advanceTimersByTimeAsync(START_LOOK_SETTLE_MS / 2);
    held.answer({ sources: new Set<DetectedImportSource>(['dbml', 'sqlDdl']), sqlTables: 7 });
    expect(await pending).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']); // never importDbmlFile first
    expect(t.sqlTableCount()).toBe(7);
  });

  it('a first find that says nothing does not answer the ask', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const { t, published } = tracker({ look: held.look });
    const pending = t.refresh();
    held.early([]);
    await vi.advanceTimersByTimeAsync(START_LOOK_SETTLE_MS + 1);
    expect(published).toEqual([]);
    held.answer(['dbml']);
    expect(await pending).toBe('importDbmlFile');
  });

  it('a diagram made while an ask waits: the ask publishes for the folder as it stands when the look answers', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const state = { hasProject: true, hasDbt: false, storage: 'dbml' as const, hasDiagrams: false };
    const published: string[] = [];
    // A new object each time, as the extension builds it.
    const t = new StartIntentTracker({ context: () => ({ ...state }), look: held.look, publish: (i) => published.push(i) });
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(500);
    state.hasDiagrams = true;
    expect(await t.refresh()).toBe('blank');
    held.answer(['sqlDdl']);
    expect(await ask).toBe('blank');
    expect(published).toEqual(['blank']);
  });

  it('a look that fails after its first find keeps the find', async () => {
    vi.useFakeTimers();
    const earlies: Array<(f: StartLookFindings) => void> = [];
    let fail!: (err: Error) => void;
    const look = vi.fn((_s: AbortSignal, early?: (f: StartLookFindings) => void) => {
      earlies.push(early ?? (() => {}));
      return new Promise<ReadonlySet<DetectedImportSource>>((_r, reject) => { fail = reject; });
    });
    const { t, published } = tracker({ look });
    const ask = t.refresh();
    earlies[0]({ sources: new Set<DetectedImportSource>(['sqlDdl']) });
    await vi.advanceTimersByTimeAsync(START_LOOK_SETTLE_MS);
    expect(await ask).toBe('importSqlDdl');
    fail(new Error('disk'));
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual(['importSqlDdl']);
    expect(t.known()).toBe('importSqlDdl');
  });

  it('once a look has finished, a later one is waited for only to the first mark: the last answer stands until the new one lands', async () => {
    vi.useFakeTimers();
    const held = heldLook();
    const { t, published, advance } = tracker({ look: held.look });
    const first = t.refresh();
    held.answer(['sqlDdl']);
    expect(await first).toBe('importSqlDdl');
    advance(START_LOOK_FRESH_MS + 1);
    const second = t.refresh();
    expect(held.look).toHaveBeenCalledTimes(2);
    held.early(['dbml']); // what a later look has found so far never hides what the last one found
    await vi.advanceTimersByTimeAsync(START_LOOK_SETTLE_MS + 1);
    expect(published).toEqual(['importSqlDdl']);
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS);
    expect(await second).toBe('importSqlDdl');
    held.answer(['semanticModel']);
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toEqual(['importSqlDdl', 'importSemanticModel']);
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

  it('no answer by the first mark counts startLookTimeout (and tells the host how far the walk got); the asks giving up counts startLookGaveUp; each once', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const onLate = vi.fn();
    const held = heldLook();
    const { t } = tracker({ look: held.look, feature: r.feature, error: r.error, onLate });
    const first = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(r.keys).toEqual(['startLookTimeout']);
    expect(onLate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(START_LOOK_PATIENCE_MS + 1);
    await first;
    expect(r.keys).toEqual(['startLookTimeout', 'startLookGaveUp']);
    await t.refresh();
    await vi.advanceTimersByTimeAsync(10 * START_LOOK_PATIENCE_MS);
    expect(r.keys).toHaveLength(2);
    expect(onLate).toHaveBeenCalledTimes(1);
  });

  it('an import found between the marks counts startLookLateSuggestion; found after the asks gave up, startLookFoundAfterDeadline too', async () => {
    vi.useFakeTimers();
    const between = recorders();
    const a = heldLook();
    const one = tracker({ look: a.look, feature: between.feature });
    const ask = one.t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    a.answer(['sqlDdl']);
    expect(await ask).toBe('importSqlDdl');
    expect(between.keys).toEqual(['startLookTimeout', 'startLookLateSuggestion']);
    expect(one.published).toEqual(['importSqlDdl']); // blank was never shown

    const after = recorders();
    const b = heldLook();
    const two = tracker({ look: b.look, feature: after.feature });
    const late = two.t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + START_LOOK_PATIENCE_MS + 2);
    expect(await late).toBe('blank');
    b.answer(['dbml']);
    await vi.advanceTimersByTimeAsync(0);
    expect(after.keys).toEqual(['startLookTimeout', 'startLookGaveUp', 'startLookLateSuggestion', 'startLookFoundAfterDeadline']);
    expect(two.published).toEqual(['blank', 'importDbmlFile']);
  });

  it('a late look that finds nothing to import counts neither late key', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const held = heldLook();
    const { t, published } = tracker({ look: held.look, feature: r.feature });
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + START_LOOK_PATIENCE_MS + 2);
    await ask;
    held.answer([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.keys).toEqual(['startLookTimeout', 'startLookGaveUp']);
    expect(published).toEqual(['blank']);
  });

  it('a find in the last moments before the asks would give up is the answer: nobody gave up', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const held = heldLook();
    const { t } = tracker({ look: held.look, feature: r.feature });
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(START_LOOK_PATIENCE_MS - 100);
    held.early(['sqlDdl']);
    await vi.advanceTimersByTimeAsync(150);
    expect(await ask).toBe('importSqlDdl');
    expect(r.keys).toEqual(['startLookTimeout', 'startLookLateSuggestion']);
  });

  it('a look that has found something by the first mark is not late', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const held = heldLook();
    // A settle time longer than the first mark: the mark comes first and takes the find as the answer.
    const { t } = tracker({ look: held.look, feature: r.feature, settleMs: 10 * START_LOOK_TIMEOUT_MS });
    const ask = t.refresh();
    held.early(['sqlDdl']);
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await ask).toBe('importSqlDdl');
    expect(r.keys).toEqual([]);
  });

  it('an answer the disk gave while the extension host was busy past the mark is handled before the look counts as late', async () => {
    vi.useFakeTimers();
    const r = recorders();
    // The answer lands in the same turn the first mark's timer fires in (the timer runs first).
    const look = vi.fn(() => new Promise<ReadonlySet<DetectedImportSource>>((resolve) => {
      setTimeout(() => resolve(new Set<DetectedImportSource>(['sqlDdl'])), START_LOOK_TIMEOUT_MS);
    }));
    const { t } = tracker({ look, feature: r.feature });
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await ask).toBe('importSqlDdl');
    expect(r.keys).toEqual([]);
  });

  it('a later look running late counts nothing (the keys are about the session\'s first look)', async () => {
    vi.useFakeTimers();
    const r = recorders();
    const held = heldLook();
    const { t, advance } = tracker({ look: held.look, feature: r.feature });
    const first = t.refresh();
    held.answer([]);
    await first;
    advance(START_LOOK_FRESH_MS + 1);
    const second = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(await second).toBe('blank');
    held.answer(['sqlDdl']); // a file added since
    await vi.advanceTimersByTimeAsync(0);
    expect(r.keys).toEqual([]);
  });

  it('a rejection after our own abort (dispose) records nothing', async () => {
    const r = recorders();
    const look = vi.fn((signal: AbortSignal) => new Promise<ReadonlySet<DetectedImportSource>>((_, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const { t } = tracker({ look, feature: r.feature, error: r.error });
    const pending = t.refresh();
    t.dispose();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.keys).toEqual([]);
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
