/**
 * Drives the sidebar's status while activation looks through the open
 * folders, and the notice after a look that stopped early (#357): what is
 * shown when, and what **Look for Longer**, **Stop Looking**, **Select dbt
 * Project…** and **Dismiss** do. The wording is `dbtLookStatus.ts`; the looks
 * are `folderLook.ts`.
 *
 * 1. `watch(folders)` when activation starts waiting. A look still running
 *    after {@link LOOK_STATUS_DELAY_MS} gets a status (folders checked, time
 *    left), refreshed every {@link LOOK_STATUS_EVERY_MS}.
 * 2. `settled(…)` when activation has its answer. Nothing more is said unless
 *    the look stopped before it had been everywhere **and** the host's own
 *    search did not answer either (`lookMayHaveMissed`): then a notice with
 *    Look for Longer, unless the user dismissed it in this workspace before.
 * 3. Look for Longer runs a new look per folder with
 *    {@link FOLDER_LOOK_LONGER_FACTOR} times the limits, beside the host's
 *    search given as long. A dbt project the window did not know is handed to
 *    `found` (Select dbt Project… then lists it); nothing new ends the notice.
 *
 * Everything it touches is injected, so it is vscode-free and runs under a
 * fake clock. It never changes the project the window opened: only the user
 * does, through Select dbt Project….
 */

import * as path from 'path';

import {
  LOOK_STATUS_DELAY_MS,
  LOOK_STATUS_EVERY_MS,
  foundStatus,
  lookMayHaveMissed,
  lookOutcome,
  lookingStatus,
  nothingMoreStatus,
  stoppedStatus,
  userStoppedStatus,
  type LookOutcome,
  type LookStatus,
} from './dbtLookStatus';
import { FOLDER_LOOK_LONGER_FACTOR, type DbtSearchStats } from './folderLook';
import { pathKey } from './pathKey';

/** The part of a `FolderLookRun` the notice reads and drives. */
export interface LookRun {
  dbtSearchStats(): DbtSearchStats;
  dbtProjects(options?: { everyFolder?: boolean }): Promise<string[]>;
  cancel(): void;
}

/** The part of `FolderLooks` the notice uses. */
export interface LookSource {
  peek(root: string): Pick<LookRun, 'dbtSearchStats'> | undefined;
  longer(root: string, factor: number): LookRun;
}

export interface DbtLookNoticeDeps {
  looks: LookSource;
  /** Show the status in the sidebar, or take it away (`undefined`). `onAction` gets the pressed button's index. */
  show(status: LookStatus | undefined, onAction?: (index: number) => void): void;
  /** The host's own search for `dbt_project.yml`, given this long. Never rejects. */
  hostSearch(timeoutMs: number): Promise<{ paths?: readonly string[]; outcome: 'ok' | 'timeout' | 'error' }>;
  /** Run Select dbt Project…. */
  selectProject(): void;
  /** dbt projects a longer look found that the window did not know: remember them, so Select dbt Project… lists them. */
  found(paths: readonly string[]): void;
  /** Whether the user dismissed the notice in this workspace before. */
  dismissed(): boolean;
  /** Remember that they did. */
  setDismissed(): void;
  /**
   * The look activation waits on has run for {@link LOOK_STATUS_DELAY_MS}:
   * called once, just before the first status is shown. The extension lets
   * `activate()` resolve here, since VS Code draws no glass sidebar before it.
   */
  lookIsSlow?(): void;
  /** Usage telemetry: the notice's condition held, off the trail (what activation found, not what the user did). */
  stoppedEarly(): void;
  /** Usage telemetry: Look for Longer was pressed. */
  askedLonger(): void;
  /** Usage telemetry: a longer look found a dbt project the window did not know. */
  longerFound(): void;
}

/** What `settled` needs to know about the window activation opened. */
export interface LookSettled {
  /** The host's own search answered in time: every `dbt_project.yml` is then known, whatever the walk reached. */
  hostSearchAnswered: boolean;
  /** The folder the window opened. */
  opened: string;
  /** It is a dbt project. */
  hasDbt: boolean;
  /** Every dbt project the window knows. */
  known: readonly string[];
}

/** How long a host search is waited for once a longer walk has been everywhere (as Select dbt Project… waits). */
export const LONGER_HOST_SEARCH_GRACE_MS = 5000;

export class DbtLookNotice {
  private folders: string[] = [];
  private delay: ReturnType<typeof setTimeout> | undefined;
  private every: ReturnType<typeof setInterval> | undefined;
  private settledWith: LookSettled | undefined;
  private known = new Set<string>();
  /** How many times the first look's limits the next longer look gets. */
  private factor = 1;
  private longer: { runs: LookRun[]; stoppedByUser: boolean } | undefined;
  private disposed = false;

  constructor(private readonly deps: DbtLookNoticeDeps) {}

  /** Activation starts waiting on the looks at `folders` (already begun: `FolderLooks.dbtProjectsBelow`). */
  watch(folders: readonly string[]): void {
    this.stopTimers();
    this.folders = [...folders];
    if (this.folders.length === 0 || this.disposed) return;
    const say = (): void => {
      const stats = this.activationStats();
      if (stats.length === 0) return;
      this.deps.show(lookingStatus({ folderNames: this.folderNames(), folders: sum(stats), maxFolders: mostFolders(stats), msLeft: longestLeft(stats) }));
    };
    this.delay = setTimeout(() => {
      this.delay = undefined;
      this.deps.lookIsSlow?.();
      say();
      this.every = setInterval(say, LOOK_STATUS_EVERY_MS);
    }, LOOK_STATUS_DELAY_MS);
  }

  /** Activation has its answer: the looking status goes, and a look that may have missed a project says so. */
  settled(result: LookSettled): void {
    this.stopTimers();
    if (this.disposed) return;
    const outcome = lookOutcome(this.activationStats());
    if (!lookMayHaveMissed(outcome, result.hostSearchAnswered)) {
      this.deps.show(undefined);
      return;
    }
    this.deps.stoppedEarly();
    if (this.deps.dismissed()) {
      this.deps.show(undefined);
      return;
    }
    this.settledWith = result;
    this.known = new Set([result.opened, ...result.known].map((dir) => pathKey(dir)));
    this.showStopped(outcome, false);
  }

  /** Take whatever is shown away and stop (a failed activation, or the window closing). */
  clear(): void {
    this.stopTimers();
    this.cancelLonger();
    this.deps.show(undefined);
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
    this.cancelLonger();
  }

  // ------------------------------------------------------------------ notice

  private showStopped(outcome: LookOutcome, again: boolean): void {
    const at = this.settledWith;
    if (!at) return;
    this.deps.show(
      stoppedStatus({ folderNames: this.folderNames(), outcome, opened: path.basename(at.opened), hasDbt: at.hasDbt, again }),
      (index) => (index === 0 ? void this.lookLonger() : this.dismiss()),
    );
  }

  private dismiss(): void {
    this.deps.setDismissed();
    this.deps.show(undefined);
  }

  // ------------------------------------------------------------- look longer

  private async lookLonger(): Promise<void> {
    if (this.longer || this.disposed || !this.settledWith) return;
    this.deps.askedLonger();
    this.factor *= FOLDER_LOOK_LONGER_FACTOR;
    const runs = this.folders.map((folder) => this.deps.looks.longer(folder, this.factor));
    const state = { runs, stoppedByUser: false };
    this.longer = state;
    const maxMs = runs.reduce((most, run) => Math.max(most, run.dbtSearchStats().maxMs), 0);
    const stop = (): void => {
      state.stoppedByUser = true;
      for (const run of runs) run.cancel();
    };
    const say = (): void => {
      const stats = runs.map((run) => run.dbtSearchStats());
      this.deps.show(lookingStatus({ folderNames: this.folderNames(), folders: sum(stats), maxFolders: mostFolders(stats), msLeft: longestLeft(stats), canStop: true }), stop);
    };
    const walking = Promise.all(runs.map((run) => run.dbtProjects({ everyFolder: true }).catch((): string[] => [])));
    const host = this.deps.hostSearch(maxMs).catch(() => ({ outcome: 'error' as const, paths: undefined }));
    say();
    this.every = setInterval(say, LOOK_STATUS_EVERY_MS);
    let walked: string[][];
    try {
      walked = await walking;
    } finally {
      this.stopTimers();
    }
    const stats = runs.map((run) => run.dbtSearchStats());
    const outcome = lookOutcome(stats);
    // A walk that has been everywhere waits only a little for the host's search; one that stopped has given it as long already.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const hosted = await Promise.race([
      host,
      new Promise<undefined>((resolve) => { grace = setTimeout(() => resolve(undefined), outcome.stoppedEarly || state.stoppedByUser ? 0 : LONGER_HOST_SEARCH_GRACE_MS); }),
    ]);
    if (grace) clearTimeout(grace);
    if (this.longer !== state) return;
    this.longer = undefined;
    if (this.disposed) return;

    const fresh: string[] = [];
    for (const dir of [...walked.flat(), ...(hosted?.paths ?? [])]) {
      const key = pathKey(dir);
      if (this.known.has(key)) continue;
      this.known.add(key);
      fresh.push(dir);
    }
    if (fresh.length > 0) {
      this.deps.found(fresh);
      this.deps.longerFound();
      this.deps.show(foundStatus(fresh.map((dir) => this.under(dir))), (index) => {
        if (index === 0) this.deps.selectProject();
        else this.dismiss();
      });
      return;
    }
    if (state.stoppedByUser) {
      // The next Look for Longer runs with the limits this one had.
      this.factor /= FOLDER_LOOK_LONGER_FACTOR;
      this.deps.show(userStoppedStatus({ folderNames: this.folderNames(), folders: outcome.folders }), (index) => (index === 0 ? void this.lookLonger() : this.dismiss()));
      return;
    }
    if (lookMayHaveMissed(outcome, hosted?.outcome === 'ok')) {
      this.showStopped(outcome, true);
      return;
    }
    // The question is answered: the notice does not come back on the next start.
    this.deps.setDismissed();
    this.deps.show(nothingMoreStatus({ folderNames: this.folderNames(), folders: outcome.folders }), () => this.deps.show(undefined));
  }

  // ----------------------------------------------------------------- helpers

  private activationStats(): DbtSearchStats[] {
    const stats: DbtSearchStats[] = [];
    for (const folder of this.folders) {
      const run = this.deps.looks.peek(folder);
      if (run) stats.push(run.dbtSearchStats());
    }
    return stats;
  }

  private folderNames(): string[] {
    return this.folders.map((folder) => path.basename(folder) || folder);
  }

  /** A found project by its path under the open folder it is in (with the folder's name when several are open). */
  private under(dir: string): string {
    for (const folder of this.folders) {
      const rel = path.relative(folder, dir);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const shown = rel.split(path.sep).join('/');
      return this.folders.length > 1 ? `${path.basename(folder)}/${shown}` : shown;
    }
    return path.basename(dir);
  }

  private stopTimers(): void {
    if (this.delay) clearTimeout(this.delay);
    if (this.every) clearInterval(this.every);
    this.delay = undefined;
    this.every = undefined;
  }

  private cancelLonger(): void {
    const state = this.longer;
    this.longer = undefined;
    if (state) for (const run of state.runs) run.cancel();
  }
}

function sum(stats: readonly DbtSearchStats[]): number {
  return stats.reduce((total, s) => total + s.folders, 0);
}

/** The most folders the looks list between them (each folder's look has its own bound). */
function mostFolders(stats: readonly DbtSearchStats[]): number {
  return stats.reduce((total, s) => total + s.maxFolders, 0);
}

/** The most any look that is not done still has: when they have all stopped (undefined when one has no limit, or all are done). */
function longestLeft(stats: readonly DbtSearchStats[]): number | undefined {
  const running = stats.filter((s) => !s.complete);
  if (running.length === 0 || running.some((s) => s.msLeft === undefined)) return undefined;
  return running.reduce((most, s) => Math.max(most, s.msLeft ?? 0), 0);
}
