/**
 * #357: the controller behind the sidebar's look status (`dbtLookNotice.ts`),
 * under a fake clock with fake looks. What is shown when: nothing for a look
 * that answers at once, a status with the folders checked and the time left
 * for a slow one, a notice with Look for Longer only when a project may have
 * been missed, and what each button does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';

import { DbtLookNotice, LONGER_HOST_SEARCH_GRACE_MS, type DbtLookNoticeDeps, type LookRun } from '../../src/services/dbtLookNotice';
import { LOOK_DISMISS_BUTTON, LOOK_LONGER_BUTTON, LOOK_SELECT_PROJECT_BUTTON, LOOK_STATUS_DELAY_MS, LOOK_STATUS_EVERY_MS, LOOK_STOP_BUTTON, type LookStatus } from '../../src/services/dbtLookStatus';
import { FOLDER_LOOK_LONGER_FACTOR, type DbtSearchStats } from '../../src/services/folderLook';

const ROOT = path.join(path.sep, 'ws', 'shop');
const complete: DbtSearchStats = { folders: 40, msLeft: 59_000, complete: true, stopped: undefined, maxMs: 60_000 };
const outOfTime: DbtSearchStats = { folders: 3200, msLeft: 0, complete: false, stopped: 'time', maxMs: 60_000 };

/** A longer look the test finishes by hand. */
function fakeRun(maxMs: number) {
  let finish!: (found: string[]) => void;
  const done = new Promise<string[]>((r) => { finish = r; });
  const run = {
    stats: { folders: 0, msLeft: maxMs, complete: false, stopped: undefined, maxMs } as DbtSearchStats,
    cancelled: false,
    asked: [] as Array<{ everyFolder?: boolean } | undefined>,
    dbtSearchStats(): DbtSearchStats { return run.stats; },
    dbtProjects(options?: { everyFolder?: boolean }): Promise<string[]> { run.asked.push(options); return done; },
    cancel(): void { run.cancelled = true; finish([]); },
    finish,
  };
  return run;
}

function harness(over: Partial<DbtLookNoticeDeps> = {}) {
  const shown: Array<LookStatus | undefined> = [];
  let onAction: ((index: number) => void) | undefined;
  const state = {
    activation: complete as DbtSearchStats | undefined,
    dismissed: false,
    host: { outcome: 'timeout' } as { paths?: string[]; outcome: 'ok' | 'timeout' | 'error' },
    hostAsked: [] as number[],
    longer: [] as Array<{ root: string; factor: number; run: ReturnType<typeof fakeRun> }>,
    found: [] as string[][],
    selected: 0,
    telemetry: [] as string[],
  };
  const deps: DbtLookNoticeDeps = {
    looks: {
      peek: () => (state.activation ? { dbtSearchStats: () => state.activation! } : undefined),
      longer: (root, factor) => {
        const run = fakeRun(60_000 * factor);
        state.longer.push({ root, factor, run });
        return run as unknown as LookRun;
      },
    },
    show: (status, action) => { shown.push(status); onAction = action; },
    hostSearch: async (timeoutMs) => { state.hostAsked.push(timeoutMs); return state.host; },
    selectProject: () => { state.selected++; },
    found: (paths) => { state.found.push([...paths]); },
    dismissed: () => state.dismissed,
    setDismissed: () => { state.dismissed = true; },
    stoppedEarly: () => { state.telemetry.push('dbtLookStopped'); },
    askedLonger: () => { state.telemetry.push('dbtLookLonger'); },
    longerFound: () => { state.telemetry.push('dbtLookLongerFound'); },
    ...over,
  };
  const notice = new DbtLookNotice(deps);
  const last = (): LookStatus | undefined => shown[shown.length - 1];
  const press = (label: string): void => {
    const index = last()?.actions?.indexOf(label) ?? -1;
    expect(index, `"${label}" is a button of ${JSON.stringify(last())}`).toBeGreaterThanOrEqual(0);
    onAction!(index);
  };
  return { notice, state, shown, last, press };
}

const settle = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('#357 while activation waits on the look', () => {
  it('a look that answers within a second shows nothing at all', () => {
    const h = harness();
    h.notice.watch([ROOT]);
    vi.advanceTimersByTime(LOOK_STATUS_DELAY_MS - 1);
    h.notice.settled({ hostSearchAnswered: true, opened: ROOT, hasDbt: false, known: [] });
    vi.advanceTimersByTime(10_000);
    // Only the clearing at the end: no status ever flashed.
    expect(h.shown).toEqual([undefined]);
  });

  it('a slow look says what it is doing, how far it has got and the time left, again every second', () => {
    const h = harness();
    h.state.activation = { folders: 310, msLeft: 58_900, complete: false, stopped: undefined, maxMs: 60_000 };
    h.notice.watch([ROOT]);
    vi.advanceTimersByTime(LOOK_STATUS_DELAY_MS);
    expect(h.last()).toEqual({
      title: 'Looking through shop…',
      detail: '310 folders checked so far.',
      working: true,
      countdown: { msLeft: 58_900, text: 'Stops in {time} if it has not finished.' },
    });
    h.state.activation = { folders: 1240, msLeft: 57_900, complete: false, stopped: undefined, maxMs: 60_000 };
    vi.advanceTimersByTime(LOOK_STATUS_EVERY_MS);
    expect(h.last()?.detail).toBe('1,240 folders checked so far.');
    expect(h.last()?.countdown?.msLeft).toBe(57_900);
    // It went everywhere: the status goes and nothing takes its place.
    h.state.activation = complete;
    h.notice.settled({ hostSearchAnswered: false, opened: ROOT, hasDbt: false, known: [] });
    expect(h.last()).toBeUndefined();
    const count = h.shown.length;
    vi.advanceTimersByTime(60_000);
    expect(h.shown).toHaveLength(count);
    expect(h.state.telemetry).toEqual([]);
  });

  it('several folders: the folders are summed and the clock is the one with the most left', () => {
    const h = harness({
      looks: {
        peek: (root) => ({ dbtSearchStats: () => (root.endsWith('shop')
          ? { folders: 100, msLeft: 20_000, complete: false, stopped: undefined, maxMs: 60_000 }
          : { folders: 50, msLeft: 45_000, complete: false, stopped: undefined, maxMs: 60_000 }) }),
        longer: () => { throw new Error('not asked'); },
      },
    });
    h.notice.watch([ROOT, path.join(path.sep, 'ws', 'data')]);
    vi.advanceTimersByTime(LOOK_STATUS_DELAY_MS);
    expect(h.last()).toMatchObject({ title: 'Looking through shop and data…', detail: '150 folders checked so far.', countdown: { msLeft: 45_000 } });
  });

  it('a failed activation takes the status away and stops the clock', () => {
    const h = harness();
    h.state.activation = { folders: 3, msLeft: 50_000, complete: false, stopped: undefined, maxMs: 60_000 };
    h.notice.watch([ROOT]);
    vi.advanceTimersByTime(LOOK_STATUS_DELAY_MS);
    h.notice.clear();
    expect(h.last()).toBeUndefined();
    const count = h.shown.length;
    vi.advanceTimersByTime(30_000);
    expect(h.shown).toHaveLength(count);
  });
});

describe('#357 a look that stopped early', () => {
  const stopEarly = (h: ReturnType<typeof harness>, hostSearchAnswered = false, hasDbt = false): void => {
    h.state.activation = outOfTime;
    h.notice.watch([ROOT]);
    h.notice.settled({ hostSearchAnswered, opened: ROOT, hasDbt, known: [] });
  };

  it('says so, with Look for Longer and Dismiss, and counts it', () => {
    const h = harness();
    stopEarly(h);
    expect(h.last()).toEqual({
      title: 'Stopped looking after 1 minute.',
      detail: 'ERD Studio checked 3,200 folders in shop, not all of them. It opened shop. A project deeper down may have been missed.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
    expect(h.state.telemetry).toEqual(['dbtLookStopped']);
  });

  it('nothing is said when the host search answered: every project is known whatever the walk reached', () => {
    const h = harness();
    stopEarly(h, true);
    expect(h.last()).toBeUndefined();
    expect(h.state.telemetry).toEqual([]);
  });

  it('Dismiss takes it away and it stays away on later starts (still counted)', () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_DISMISS_BUTTON);
    expect(h.last()).toBeUndefined();
    expect(h.state.dismissed).toBe(true);
    // The next start of the same workspace.
    const again = harness({ dismissed: () => true });
    stopEarly(again);
    expect(again.shown).toEqual([undefined]);
    expect(again.state.telemetry).toEqual(['dbtLookStopped']);
  });

  it('Look for Longer: a new look with 5 times the limits and no folder bound of its own, the host search given as long, a status that can be stopped', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    expect(h.state.telemetry).toEqual(['dbtLookStopped', 'dbtLookLonger']);
    expect(h.state.longer.map((l) => [l.root, l.factor])).toEqual([[ROOT, FOLDER_LOOK_LONGER_FACTOR]]);
    const { run } = h.state.longer[0];
    expect(run.asked).toEqual([{ everyFolder: true }]);
    expect(h.state.hostAsked).toEqual([60_000 * FOLDER_LOOK_LONGER_FACTOR]);
    expect(h.last()).toEqual({
      title: 'Looking through shop…',
      working: true,
      countdown: { msLeft: 300_000, text: 'Stops in {time} if it has not finished.' },
      actions: [LOOK_STOP_BUTTON],
    });
    run.stats = { ...run.stats, folders: 12_400, msLeft: 252_000 };
    vi.advanceTimersByTime(LOOK_STATUS_EVERY_MS);
    expect(h.last()).toMatchObject({ detail: '12,400 folders checked so far.', countdown: { msLeft: 252_000 } });
    // A second press while it runs starts nothing.
    run.finish([]);
    await settle();
  });

  it('it finds a dbt project the window did not know: remembered, counted, and Select dbt Project… runs the command', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    const { run } = h.state.longer[0];
    run.stats = { folders: 20_000, msLeft: 200_000, complete: true, stopped: undefined, maxMs: 300_000 };
    run.finish([path.join(ROOT, 'analytics', 'dbt')]);
    await vi.advanceTimersByTimeAsync(LONGER_HOST_SEARCH_GRACE_MS);
    expect(h.state.found).toEqual([[path.join(ROOT, 'analytics', 'dbt')]]);
    expect(h.state.telemetry).toEqual(['dbtLookStopped', 'dbtLookLonger', 'dbtLookLongerFound']);
    expect(h.last()).toEqual({
      title: 'Found a dbt project: analytics/dbt.',
      detail: 'Select dbt Project opens it.',
      actions: [LOOK_SELECT_PROJECT_BUTTON, LOOK_DISMISS_BUTTON],
    });
    h.press(LOOK_SELECT_PROJECT_BUTTON);
    expect(h.state.selected).toBe(1);
    // The window's project is never changed by the notice itself.
    expect(h.last()?.title).toBe('Found a dbt project: analytics/dbt.');
  });

  it('a project the window already knew, or the one it opened, is not news; the host search\'s finds count too', async () => {
    const known = path.join(ROOT, 'transform');
    const h = harness();
    h.state.activation = outOfTime;
    h.notice.watch([ROOT]);
    h.notice.settled({ hostSearchAnswered: false, opened: known, hasDbt: true, known: [known, path.join(ROOT, 'old')] });
    h.state.host = { outcome: 'ok', paths: [path.join(ROOT, 'old'), path.join(ROOT, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g')] };
    h.press(LOOK_LONGER_BUTTON);
    const { run } = h.state.longer[0];
    run.stats = { ...run.stats, complete: true };
    run.finish([known]);
    await vi.advanceTimersByTimeAsync(LONGER_HOST_SEARCH_GRACE_MS);
    expect(h.state.found).toEqual([[path.join(ROOT, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g')]]);
    expect(h.last()?.title).toBe('Found a dbt project: deep/a/b/c/d/e/f/g.');
  });

  it('it goes everywhere and finds nothing new: says so, and the notice does not come back on the next start', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    const { run } = h.state.longer[0];
    run.stats = { folders: 31_204, msLeft: 100_000, complete: true, stopped: undefined, maxMs: 300_000 };
    run.finish([]);
    await vi.advanceTimersByTimeAsync(LONGER_HOST_SEARCH_GRACE_MS);
    expect(h.last()).toEqual({
      title: 'Nothing more found.',
      detail: 'ERD Studio checked 31,204 folders in shop: every folder it looks in.',
      actions: [LOOK_DISMISS_BUTTON],
    });
    expect(h.state.dismissed).toBe(true);
    expect(h.state.found).toEqual([]);
    h.press(LOOK_DISMISS_BUTTON);
    expect(h.last()).toBeUndefined();
  });

  it('it stops at its limit again: says still, and the next Look for Longer gets 5 times as much again', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    const first = h.state.longer[0].run;
    first.stats = { folders: 90_000, msLeft: 0, complete: false, stopped: 'time', maxMs: 300_000 };
    first.finish([]);
    await settle();
    expect(h.last()).toEqual({
      title: 'Stopped looking after 5 minutes.',
      detail: 'ERD Studio checked 90,000 folders in shop, still not all of them. It opened shop. A project deeper down may have been missed.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
    h.press(LOOK_LONGER_BUTTON);
    expect(h.state.longer.map((l) => l.factor)).toEqual([FOLDER_LOOK_LONGER_FACTOR, FOLDER_LOOK_LONGER_FACTOR ** 2]);
    h.state.longer[1].run.finish([]);
    await settle();
  });

  it('Stop Looking cancels the look and offers it again with the same limits', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    const { run } = h.state.longer[0];
    run.stats = { ...run.stats, folders: 812 };
    h.press(LOOK_STOP_BUTTON);
    expect(run.cancelled).toBe(true);
    await settle();
    expect(h.last()).toEqual({
      title: 'Stopped looking.',
      detail: 'ERD Studio had checked 812 folders in shop.',
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
    h.press(LOOK_LONGER_BUTTON);
    expect(h.state.longer.map((l) => l.factor)).toEqual([FOLDER_LOOK_LONGER_FACTOR, FOLDER_LOOK_LONGER_FACTOR]);
    h.state.longer[1].run.finish([]);
    await settle();
  });

  it('the window closing cancels a longer look and shows nothing after', async () => {
    const h = harness();
    stopEarly(h);
    h.press(LOOK_LONGER_BUTTON);
    const { run } = h.state.longer[0];
    const count = h.shown.length;
    h.notice.dispose();
    expect(run.cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(LONGER_HOST_SEARCH_GRACE_MS + 60_000);
    expect(h.shown).toHaveLength(count);
  });
});
