/**
 * #328: a new install's first look at the folder gets to finish.
 *
 * On 2.0.0–2.0.5, 8 of 21 first runs had the start screen's look time out,
 * and 6 of those saw nothing from ERD Studio at all: a look that ran out of
 * time published `blank`, the start suggestion shows nothing for `blank`, and
 * the retry (with twice the time) ran only on a *later* refresh — never for
 * the ask that timed out. The rules pinned here:
 *
 * - one ask is answered by the look *and* its retry: `blank` is published only
 *   once both ran out of time, never in between;
 * - a surface that shows the wait (the empty Diagrams view, "Looking at your
 *   folder…") gives the first look {@link START_LOOK_ON_SCREEN_MS}, and does
 *   so too when it joins a look an unseen ask started;
 * - the empty Diagrams view says "Looking at your folder…" exactly while the
 *   suggestion is unpublished, and "Loading diagrams…" only while the tree
 *   lists: never both, never neither.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import * as startIntentModule from '../../src/commands/startIntent';
import { START_LOOK_ATTEMPTS, START_LOOK_TIMEOUT_MS, StartIntentTracker, type StartIntentDeps } from '../../src/commands/startIntent';
import { evaluateWhen } from '../../src/providers/glassSidebar/whenClause';
import { runStartSuggestion, type StartSuggestionDeps } from '../../src/services/startSuggestion';
import type { DetectedImportSource } from '../../src/types/startActions';

/** The on-screen budget (absent before #328: twice the unseen one is what it must be). */
const START_LOOK_ON_SCREEN_MS = (startIntentModule as { START_LOOK_ON_SCREEN_MS?: number }).START_LOOK_ON_SCREEN_MS ?? 2 * START_LOOK_TIMEOUT_MS;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A look that hangs (until aborted) the first `stalls` times, then answers `found` after `answerAfterMs`. */
function slowLook(stalls: number, found: DetectedImportSource[], answerAfterMs = 0) {
  let calls = 0;
  const signals: AbortSignal[] = [];
  const look = vi.fn((signal: AbortSignal) => {
    calls++;
    signals.push(signal);
    if (calls <= stalls) {
      return new Promise<ReadonlySet<DetectedImportSource>>((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return new Promise<ReadonlySet<DetectedImportSource>>((resolve) => setTimeout(() => resolve(new Set(found)), answerAfterMs));
  });
  return { look, signals };
}

function trackerWith(look: StartIntentDeps['look']) {
  const published: string[] = [];
  const keys: string[] = [];
  const t = new StartIntentTracker({
    context: () => ({ hasProject: true, hasDbt: false, storage: 'dbml', hasDiagrams: false }),
    look,
    publish: (i) => published.push(i),
    feature: (k) => keys.push(k),
    error: (c) => keys.push(`!${c}`),
  });
  return { t, published, keys };
}

/** Ask the tracker, as the empty Diagrams view does (it shows that it waits). */
const onScreen = (t: StartIntentTracker) => (t.refresh as (o?: { onScreen?: boolean }) => ReturnType<StartIntentTracker['refresh']>)({ onScreen: true });

describe('#328: one ask is answered by the look and its retry', () => {
  it('a first look that stalls, then a retry that finds CREATE TABLE scripts: the same ask gets the import, and blank is never published', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(1, ['sqlDdl'], 500);
    const { t, published, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(published).toEqual([]); // still looking: nothing published in between
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(await ask).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']);
    expect(look).toHaveBeenCalledTimes(2);
    // What the first timeout would have cost (no new key: the one #295 added).
    expect(keys).toEqual(['startLookTimeout', 'startLookLateSuggestion']);
  });

  it('blank only once every attempt ran out of time, each cancelled; then never looked at again this session', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(Infinity, []);
    const { t, published, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(published).toEqual([]);
    // The retry has the on-screen time, never more (the worst unseen wait is 1.5 s + 3 s).
    await vi.advanceTimersByTimeAsync(START_LOOK_ON_SCREEN_MS - 2);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(await ask).toBe('blank');
    expect(published).toEqual(['blank']);
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(look).toHaveBeenCalledTimes(START_LOOK_ATTEMPTS);
    expect(keys).toEqual(['startLookTimeout', 'startLookTimeout', 'startLookGaveUp']);
    expect(await t.refresh()).toBe('blank');
    expect(look).toHaveBeenCalledTimes(START_LOOK_ATTEMPTS);
  });

  it('the start suggestion, asked once off screen in a slow folder, now shows the import instead of nothing', async () => {
    vi.useFakeTimers();
    const { look } = slowLook(1, ['sqlDdl']);
    const { t } = trackerWith(look);
    const show = vi.fn(async () => undefined);
    let state: ReturnType<StartSuggestionDeps['state']> = { shown: 0 };
    let machine: ReturnType<StartSuggestionDeps['machine']> = { shown: 0, newInstall: true };
    const deps: StartSuggestionDeps = {
      intent: () => t.refresh(),
      sqlTables: () => t.sqlTableCount(),
      hasDiagrams: () => false,
      settingOn: () => true,
      convertApplies: () => false,
      state: () => state,
      saveState: async (s) => { state = s; },
      machine: () => machine,
      saveMachine: async (m) => { machine = m; },
      show,
      info: () => undefined,
      executeCommand: async () => undefined,
      recordSuggested: () => {},
      feature: () => {},
      setOffContext: () => {},
    };
    const outcome = runStartSuggestion(deps);
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    await vi.runOnlyPendingTimersAsync();
    expect((await outcome).shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('#328: a surface that shows the wait gives the first look longer', () => {
  it('asked on screen, a look that answers at 2 s is not cancelled and counts no timeout', async () => {
    vi.useFakeTimers();
    const { look } = slowLook(0, ['sqlDdl'], 2000);
    const { t, published, keys } = trackerWith(look);
    const ask = onScreen(t);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await ask).toBe('importSqlDdl');
    expect(look).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['importSqlDdl']);
    expect(keys).toEqual([]);
  });

  it('asked off screen, that same look is cancelled at 1.5 s (the unseen budget is unchanged)', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(0, ['sqlDdl'], 2000);
    const { t, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(signals[0]?.aborted).toBe(true);
    expect(keys[0]).toBe('startLookTimeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await ask;
  });

  it('the empty Diagrams view joining a look an unseen ask started gives it the longer time (counted from its start)', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(0, ['sqlDdl'], 2500);
    const { t, published, keys } = trackerWith(look);
    const startPrompt = t.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    const emptyView = onScreen(t);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await Promise.all([startPrompt, emptyView])).toEqual(['importSqlDdl', 'importSqlDdl']);
    expect(signals[0]?.aborted).toBe(false);
    expect(look).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['importSqlDdl']);
    expect(keys).toEqual([]);
  });

  it('joining does not stretch the look past the on-screen time', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(0, ['sqlDdl'], 60_000);
    const { t } = trackerWith(look);
    const startPrompt = t.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    void onScreen(t);
    await vi.advanceTimersByTimeAsync(START_LOOK_ON_SCREEN_MS - 1000 - 1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(START_LOOK_ON_SCREEN_MS);
    expect(await startPrompt).toBe('blank');
  });
});

describe('#328: the empty Diagrams view says it is looking, and only one thing at a time', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')) as {
    contributes: { viewsWelcome: { view: string; when?: string; contents: string }[] };
  };
  const entries = pkg.contributes.viewsWelcome.filter((e) => e.view === 'erdStudio.domainTree' && !e.when?.includes('hasMultipleDbtProjects'));
  const firstLine = (e: { contents: string }) => e.contents.split('\n')[0];

  const windows: Record<string, unknown>[] = [];
  for (const loading of [true, false, undefined]) {
    for (const dbt of [false, true]) {
      for (const storage of [undefined, 'dbml', 'yaml', 'mixed']) {
        const pre20 = storage === 'yaml' || storage === 'mixed';
        // What the tracker can publish there (startIntentFor), or nothing yet.
        const intents = pre20 ? [undefined, 'convert'] : dbt ? [undefined, 'drawFromDbt'] : [undefined, 'blank', 'importSqlDdl'];
        for (const intent of intents) {
          for (const tables of [false, true]) {
            windows.push({
              workspaceFolderCount: 1,
              'erdStudio.hasProject': true,
              'erdStudio.diagramsLoading': loading,
              'erdStudio.hasDbtProject': dbt,
              'erdStudio.storage': storage,
              'erdStudio.startIntent': intent,
              'erdStudio.hasTables': tables,
            });
          }
        }
      }
    }
  }

  it.each(windows.map((w) => [JSON.stringify(w), w] as const))('one entry at most, and the right waiting text: %s', (_name, w) => {
    const shown = entries.filter((e) => evaluateWhen(e.when, w)).map(firstLine);
    const pre20 = w['erdStudio.storage'] === 'yaml' || w['erdStudio.storage'] === 'mixed';
    if (w['erdStudio.diagramsLoading'] === true) {
      expect(shown).toEqual(['Loading diagrams…']);
    } else if (!w['erdStudio.hasDbtProject'] && !pre20 && w['erdStudio.startIntent'] === undefined) {
      expect(shown).toEqual(['Looking at your folder…']);
    } else {
      expect(shown).toHaveLength(1);
      expect(shown[0]).not.toMatch(/^(Loading diagrams|Looking at your folder)…$/);
    }
  });
});
