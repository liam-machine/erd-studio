/**
 * #328: a new install's first look at the folder gets to finish.
 *
 * On 2.0.0–2.0.5, 8 of 21 first runs had the start screen's look time out,
 * and 6 of those saw nothing from ERD Studio at all: a look that ran out of
 * time published `blank`, and the start suggestion shows nothing for `blank`.
 * 2.0.8 tried the look once more in the same ask; on Windows that retry ran
 * out of time too on 1 install in 3, and the folder then counted as holding
 * nothing for the session (#347). Since then the look is never cancelled or
 * started again: it runs on, and the rules pinned here are
 *
 * - one ask waits as long as 2.0.8's two attempts did (1.5 s to the first
 *   mark, then 3 s more): `blank` is published only once that whole wait is
 *   over, never at the first mark;
 * - a surface that shows the wait (the empty Diagrams view, "Looking at your
 *   folder…") gives the first mark {@link START_LOOK_ON_SCREEN_MS}, and does
 *   so too when it joins a look an unseen ask started;
 * - the empty Diagrams view says "Looking at your folder…" exactly while the
 *   suggestion is unpublished, and "Loading diagrams…" only while the tree
 *   lists: never both, never neither.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { START_LOOK_ON_SCREEN_MS, START_LOOK_PATIENCE_MS, START_LOOK_TIMEOUT_MS, StartIntentTracker, type StartIntentDeps } from '../../src/commands/startIntent';
import { evaluateWhen } from '../../src/providers/glassSidebar/whenClause';
import { runStartSuggestion, type StartSuggestionDeps } from '../../src/services/startSuggestion';
import type { DetectedImportSource } from '../../src/types/startActions';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A look that answers `found` after `answerAfterMs` (never, with Infinity). */
function slowLook(found: DetectedImportSource[], answerAfterMs = 0) {
  const signals: AbortSignal[] = [];
  const look = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<ReadonlySet<DetectedImportSource>>((resolve) => {
      if (Number.isFinite(answerAfterMs)) setTimeout(() => resolve(new Set(found)), answerAfterMs);
    });
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
const onScreen = (t: StartIntentTracker) => t.refresh({ onScreen: true });

describe('#328: one ask waits for a look that runs past its first mark', () => {
  it('a look that finds CREATE TABLE scripts half a second after the first mark: the same ask gets the import, and blank is never published', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(['sqlDdl'], START_LOOK_TIMEOUT_MS + 500);
    const { t, published, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(published).toEqual([]); // still looking: nothing published in between
    expect(signals[0]?.aborted).toBe(false); // and never cancelled (#347)
    await vi.advanceTimersByTimeAsync(500);
    expect(await ask).toBe('importSqlDdl');
    expect(published).toEqual(['importSqlDdl']);
    expect(look).toHaveBeenCalledTimes(1);
    // What a look cancelled at the first mark would have cost (the key #295 added).
    expect(keys).toEqual(['startLookTimeout', 'startLookLateSuggestion']);
  });

  it('blank only once the ask\'s whole wait is over; the look is not cancelled, and what it finds after that is published then', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(['sqlDdl'], 20_000);
    const { t, published, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(published).toEqual([]);
    // The rest of the wait is the on-screen time, never more (the worst unseen wait is 1.5 s + 3 s).
    await vi.advanceTimersByTimeAsync(START_LOOK_PATIENCE_MS - 2);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(4);
    expect(await ask).toBe('blank');
    expect(published).toEqual(['blank']);
    expect(signals.map((s) => s.aborted)).toEqual([false]);
    expect(keys).toEqual(['startLookTimeout', 'startLookGaveUp']);
    // A later ask neither waits again nor starts another look.
    expect(await t.refresh()).toBe('blank');
    expect(look).toHaveBeenCalledTimes(1);
    // #347: running out of time was not an answer. The folder's scripts are suggested when the look gets to them.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(published).toEqual(['blank', 'importSqlDdl']);
    expect(keys).toEqual(['startLookTimeout', 'startLookGaveUp', 'startLookLateSuggestion', 'startLookFoundAfterDeadline']);
    expect(look).toHaveBeenCalledTimes(1);
  });

  it('the start suggestion, asked once off screen in a slow folder, shows the import instead of nothing', async () => {
    vi.useFakeTimers();
    const { look } = slowLook(['sqlDdl'], START_LOOK_TIMEOUT_MS + 200);
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
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 201);
    await vi.runOnlyPendingTimersAsync();
    expect((await outcome).shown).toBe(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});

describe('#328: a surface that shows the wait gives the first look longer', () => {
  it('asked on screen, a look that answers at 2 s counts no timeout', async () => {
    vi.useFakeTimers();
    const { look } = slowLook(['sqlDdl'], 2000);
    const { t, published, keys } = trackerWith(look);
    const ask = onScreen(t);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await ask).toBe('importSqlDdl');
    expect(look).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['importSqlDdl']);
    expect(keys).toEqual([]);
  });

  it('asked off screen, that same look passes its first mark at 1.5 s (the unseen mark is unchanged) and still answers the ask', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(['sqlDdl'], 2000);
    const { t, keys } = trackerWith(look);
    const ask = t.refresh();
    await vi.advanceTimersByTimeAsync(START_LOOK_TIMEOUT_MS + 1);
    expect(keys[0]).toBe('startLookTimeout');
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await ask).toBe('importSqlDdl');
  });

  it('the empty Diagrams view joining a look an unseen ask started gives it the longer time (counted from its start)', async () => {
    vi.useFakeTimers();
    const { look, signals } = slowLook(['sqlDdl'], 2500);
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

  it('joining does not stretch the first mark past the on-screen time', async () => {
    vi.useFakeTimers();
    const { look } = slowLook(['sqlDdl'], 60_000);
    const { t, keys } = trackerWith(look);
    const startPrompt = t.refresh();
    await vi.advanceTimersByTimeAsync(1000);
    void onScreen(t);
    await vi.advanceTimersByTimeAsync(START_LOOK_ON_SCREEN_MS - 1000 - 1);
    expect(keys).toEqual([]);
    await vi.advanceTimersByTimeAsync(3);
    expect(keys).toEqual(['startLookTimeout']);
    await vi.advanceTimersByTimeAsync(START_LOOK_PATIENCE_MS + 2);
    expect(await startPrompt).toBe('blank');
    expect(keys).toEqual(['startLookTimeout', 'startLookGaveUp']);
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
