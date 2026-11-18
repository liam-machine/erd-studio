/**
 * The start screen's suggestion for the open folder (`startIntentFor`,
 * `src/types/startActions.ts`), kept by the host for the session and
 * published as the `erdStudio.startIntent` context key, which the walkthrough
 * and the empty Diagrams view gate their start variants on.
 *
 * The folder's files are looked at (the shared look, `src/services/folderLook.ts`:
 * git's index first, then one bounded walk) only when they can decide the
 * suggestion — a new DBML project without dbt and without a diagram — and
 * only when a start surface asks: the empty Diagrams view being drawn, the
 * Welcome panel's status, the walkthrough being opened, or the start
 * suggestion. Never on activation's own path (a refresh is always deferred),
 * never writing anything. What it found stays on this machine: telemetry gets
 * the suggestion's fixed key only.
 *
 * **Running out of time is not an answer** (#347). A deadline only decides
 * how long an ask waits: {@link START_LOOK_TIMEOUT_MS} to the first mark
 * ({@link START_LOOK_ON_SCREEN_MS} while a surface shows the wait), then
 * {@link START_LOOK_PATIENCE_MS} more, as the two attempts of 2.0.8 had
 * (#328). The look itself is never cancelled and never started again from
 * the top: it runs on, and whatever it finds later is published then, so
 * "still looking" never turns into "nothing here" for the rest of the
 * session. An ask is answered as soon as the look has found something (the
 * index answers in milliseconds), a moment later when the whole look is
 * nearly done ({@link START_LOOK_SETTLE_MS}), so the suggestion rarely changes
 * under the user.
 *
 * Once a look has finished, a later one (the last is older than
 * {@link START_LOOK_FRESH_MS}) is waited for only to the first mark: the last
 * answer stands until the new one lands.
 *
 * The empty Diagrams view of a folder without dbt shows "Looking at your
 * folder…" until the first suggestion is published (so New Diagram rarely
 * shows first and then turns into an import), so a refresh always publishes
 * one: `blank` when the folder's state cannot be read.
 *
 * vscode-free: the look, the context and the publishing are injected.
 */

import type { TelemetryErrorCode, TelemetryFeature } from '../services/telemetryPayload';
import {
  isDirectImport,
  startIntentFor,
  startNeedsLook,
  type DetectedImportSource,
  type StartContext,
  type StartIntent,
} from '../types/startActions';

/**
 * How long an ask nobody is shown waiting on waits for the look before the
 * look counts as late (`startLookTimeout`). The ask keeps waiting
 * ({@link START_LOOK_PATIENCE_MS}); the look is never cancelled.
 */
export const START_LOOK_TIMEOUT_MS = 1500;
/**
 * That first mark while a surface shows the wait (the empty Diagrams view
 * says "Looking at your folder…"). A surface that starts showing the wait
 * while a shorter wait runs stretches it to this, counted from the look's
 * start.
 */
export const START_LOOK_ON_SCREEN_MS = 2 * START_LOOK_TIMEOUT_MS;
/**
 * How much longer an ask waits after the first mark before it answers with
 * what is known (`startLookGaveUp`: the ask got no answer; the look runs on).
 * The worst wait is 1.5 s + 3 s for an unseen ask, 3 s + 3 s for one on
 * screen: what 2.0.8's two attempts took.
 */
export const START_LOOK_PATIENCE_MS = START_LOOK_ON_SCREEN_MS;
/**
 * After the look's first find, how long an ask still waits for the whole
 * look: in most folders it finishes within this, so the suggestion is the
 * final one (with its table count) and never changes under the user.
 */
export const START_LOOK_SETTLE_MS = 400;
/** A finished look is reused for this long. */
export const START_LOOK_FRESH_MS = 60_000;

export interface StartRefreshOptions {
  /**
   * The asking surface shows that it waits ("Looking at your folder…" in the
   * empty Diagrams view): the first mark is {@link START_LOOK_ON_SCREEN_MS}.
   */
  onScreen?: boolean;
}

export interface StartIntentDeps {
  /** Where the folder stands now (cheap: no file walk). */
  context(): Omit<StartContext, 'found'>;
  /**
   * The look at the folder: the sources found, or those with the CREATE TABLE
   * count the start suggestion names (`sqlTables`, only when exact). It may
   * say what it has found so far through `early` (any number of times, before
   * it resolves): an ask is answered from the first find. `signal` aborts
   * only when the tracker is disposed; a look is never cancelled for being
   * slow.
   */
  look(
    signal: AbortSignal,
    early?: (findings: StartLookFindings) => void,
  ): Promise<ReadonlySet<DetectedImportSource> | StartLookFindings>;
  /** Publish a changed suggestion (the context key). */
  publish(intent: StartIntent): void;
  /** The look saw a `dbt_project.yml` while the window runs without dbt (the host notes it; never a prompt). */
  onDbtProjectSeen?(): void;
  /** The session's first look passed its first mark without an answer (the host counts how far the walk had got). */
  onLate?(): void;
  /** {@link START_LOOK_TIMEOUT_MS} (tests). */
  timeoutMs?: number;
  /** {@link START_LOOK_SETTLE_MS} (tests). */
  settleMs?: number;
  now?(): number;
  /**
   * Counts a fixed key, each for the session's first look only:
   * `startLookTimeout` (no answer by the first mark), `startLookGaveUp` (the
   * asks stopped waiting without one), `startLookLateSuggestion` (an import
   * was found after the first mark, so a look cancelled there would have cost
   * the suggestion) and `startLookFoundAfterDeadline` (it was found after the
   * asks had stopped waiting). The host counts each once a day.
   */
  feature?(key: TelemetryFeature): void;
  /** Counts a fixed error code (`startLookFailed`, `startContextFailed`). */
  error?(code: TelemetryErrorCode): void;
}

/** What a look found: the sources, and how many CREATE TABLEs the `.sql` files hold when it could tell exactly. */
export interface StartLookFindings {
  sources: ReadonlySet<DetectedImportSource>;
  sqlTables?: number;
  /** The folder holds a `dbt_project.yml`. */
  dbtProject?: boolean;
}

/** One look in flight, and the wait the asks share on it. */
interface LookRun {
  controller: AbortController;
  /** No look had finished when this one started: its marks are counted, and a surface showing the wait stretches it. */
  first: boolean;
  /** A surface shows the wait. */
  onScreen: boolean;
  /** It has found something (its early answer is in). */
  found: boolean;
  /** The first mark passed without an answer. */
  late: boolean;
  /** The asks stopped waiting without an answer. */
  gaveUp: boolean;
  /** The asks no longer wait on it (answered, or out of time): what it finds from here is published as it lands. */
  waitOver: boolean;
  wait: Promise<void>;
  endWait(): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settle: ReturnType<typeof setTimeout> | undefined;
}

export class StartIntentTracker {
  private found: ReadonlySet<DetectedImportSource> | undefined;
  private sqlTables: number | undefined;
  /** When the last finished look answered. */
  private lookedAt = Number.NEGATIVE_INFINITY;
  /** A look has finished this session (whatever it found). */
  private answered = false;
  private run: LookRun | undefined;
  private published: StartIntent | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /**
   * The session's first look answered after its first mark (`late`) or after
   * the asks had stopped waiting (`afterDeadline`): the next publish decides
   * `startLookLateSuggestion` / `startLookFoundAfterDeadline`.
   */
  private lateAnswer: 'late' | 'afterDeadline' | undefined;

  constructor(private readonly deps: StartIntentDeps) {}

  /** Telemetry never changes what the tracker decides. */
  private count(record: () => void): void {
    try {
      record();
    } catch { /* ignored */ }
  }

  /** Where the folder stands now, with the last look's findings (none before the first look). */
  startContext(): StartContext {
    return { ...this.deps.context(), found: this.found };
  }

  /** How many CREATE TABLEs the last look counted, when it could tell exactly (stays on this machine). */
  sqlTableCount(): number | undefined {
    return this.sqlTables;
  }

  /** The suggestion from what is known now, without a look (the last look's findings, if any). */
  known(): StartIntent | undefined {
    return startIntentFor(this.startContext());
  }

  /** The suggestion, looking at the folder first when its files decide it and the last look is stale. Never throws. */
  async refresh(options: StartRefreshOptions = {}): Promise<StartIntent | undefined> {
    if (this.disposed) return this.known();
    let ctx: Omit<StartContext, 'found'>;
    try {
      ctx = this.deps.context();
    } catch {
      this.count(() => this.deps.error?.('startContextFailed'));
      // The empty Diagrams view waits (Looking at your folder…) until a suggestion is published:
      // never leave it waiting. A blank diagram is always a valid start.
      if (this.published === undefined && !this.disposed) {
        this.published = 'blank';
        this.deps.publish('blank');
      }
      return undefined;
    }
    if (startNeedsLook(ctx) && !this.isFresh()) {
      await this.waitForLook(options.onScreen === true);
      // The folder may have changed while the ask waited (a diagram made): publish for how it stands now.
      try {
        ctx = this.deps.context();
      } catch { /* as it stood when the ask began */ }
    }
    return this.publishFrom(ctx);
  }

  /** A refresh on a later tick (coalesced): for callers on activation's path, such as the tree's first listing. */
  scheduleRefresh(): void {
    if (this.disposed || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.refresh();
    }, 0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = undefined;
    const run = this.run;
    this.run = undefined;
    run?.controller.abort();
    run?.endWait();
  }

  /** A dbt_project.yml the look saw, in a window without dbt: the host's to note (once). */
  private noteDbtProject(): void {
    try {
      if (!this.deps.context().hasDbt) this.deps.onDbtProjectSeen?.();
    } catch { /* the suggestion never depends on it */ }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private isFresh(): boolean {
    return this.answered && this.now() - this.lookedAt < START_LOOK_FRESH_MS;
  }

  /**
   * The suggestion for `ctx` with what the look has found, published when it
   * changed. A look that answered late decides its two keys here: only an
   * import replacing nothing (or a blank diagram) is what the deadline would
   * have cost.
   */
  private publishFrom(ctx: Omit<StartContext, 'found'>): StartIntent | undefined {
    const intent = startIntentFor({ ...ctx, found: this.found });
    const late = this.lateAnswer;
    this.lateAnswer = undefined;
    if (intent && intent !== this.published && !this.disposed) {
      if (late && (this.published === undefined || this.published === 'blank') && isDirectImport(intent)) {
        this.count(() => this.deps.feature?.('startLookLateSuggestion'));
        if (late === 'afterDeadline') this.count(() => this.deps.feature?.('startLookFoundAfterDeadline'));
      }
      this.published = intent;
      this.deps.publish(intent);
    }
    return intent;
  }

  /**
   * Wait on the look in flight (starting one when none is): until it has
   * answered, or its time for the asks is up. Concurrent asks share the wait;
   * an on-screen ask joining stretches a short first mark. Once the wait on a
   * look is over, later asks do not wait on that look again: what it finds is
   * published as it lands.
   */
  private waitForLook(onScreen: boolean): Promise<void> {
    let run = this.run;
    if (!run) run = this.startLook(onScreen);
    else if (onScreen) run.onScreen = true;
    return run.waitOver ? Promise.resolve() : run.wait;
  }

  private startLook(onScreen: boolean): LookRun {
    const controller = new AbortController();
    let release!: () => void;
    const run: LookRun = {
      controller,
      first: !this.answered,
      onScreen,
      found: false,
      late: false,
      gaveUp: false,
      waitOver: false,
      wait: new Promise<void>((resolve) => { release = resolve; }),
      endWait: () => {
        if (run.waitOver) return;
        run.waitOver = true;
        if (run.timer) clearTimeout(run.timer);
        if (run.settle) clearTimeout(run.settle);
        run.timer = undefined;
        run.settle = undefined;
        release();
      },
      timer: undefined,
      settle: undefined,
    };
    this.run = run;
    const short = this.deps.timeoutMs ?? START_LOOK_TIMEOUT_MS;
    const long = 2 * short;
    // A timer that fires after the extension host was busy runs before the
    // answers the disk gave meanwhile are handled: give those one turn of the
    // event loop (a timer of its own runs after them) before the look counts
    // as late.
    const afterTurn = (then: () => void): void => {
      run.timer = setTimeout(() => { if (!run.waitOver && !this.disposed) then(); }, 0);
    };
    const patienceOver = (): void => afterTurn(() => {
      // It has found something meanwhile: that is the answer, and nobody gave up.
      if (run.found) { run.endWait(); return; }
      run.gaveUp = true;
      this.count(() => this.deps.feature?.('startLookGaveUp'));
      run.endWait();
    });
    // Only the session's first look stretches for a surface that shows the wait.
    let stretched = !run.first || onScreen;
    const firstMark = (): void => {
      // A surface started showing the wait meanwhile: the rest of the on-screen time, from the look's start.
      if (!stretched && run.onScreen) {
        stretched = true;
        run.timer = setTimeout(firstMark, long - short);
        return;
      }
      afterTurn(() => {
        // It has found something: that is the answer (the rest lands late).
        if (run.found) { run.endWait(); return; }
        run.late = true;
        // A later look: the last answer stands until this one lands.
        if (!run.first) { run.endWait(); return; }
        this.count(() => this.deps.feature?.('startLookTimeout'));
        this.count(() => this.deps.onLate?.());
        run.timer = setTimeout(patienceOver, long);
      });
    };
    run.timer = setTimeout(firstMark, run.first && onScreen ? long : short);

    let pending: Promise<ReadonlySet<DetectedImportSource> | StartLookFindings>;
    try {
      pending = Promise.resolve(this.deps.look(controller.signal, (early) => this.absorb(run, early, false)));
    } catch (err) {
      pending = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    void pending.then(
      (answer) => this.absorb(run, answer, true),
      () => {
        // Our own abort (dispose) is not a failure of the look.
        if (!controller.signal.aborted) this.count(() => this.deps.error?.('startLookFailed'));
        // What it had found before it failed still stands.
        this.absorb(run, run.found && this.found ? this.found : new Set<DetectedImportSource>(), true);
      },
    );
    return run;
  }

  /**
   * What a look found: so far (`final` false) or in all. The asks waiting on
   * it are released (a first find waits {@link START_LOOK_SETTLE_MS} for the
   * rest); with nobody waiting any more, a changed suggestion is published
   * here.
   */
  private absorb(run: LookRun, answer: ReadonlySet<DetectedImportSource> | StartLookFindings, final: boolean): void {
    if (this.disposed || this.run !== run) return;
    const findings: StartLookFindings = isFindings(answer) ? answer : { sources: answer };
    if (findings.dbtProject) this.noteDbtProject();
    if (!final) {
      // What a look has found so far counts only before any look has finished
      // (a later look's first finds would hide what the last one found), and
      // only when it holds something.
      if (!run.first || findings.sources.size === 0) return;
      run.found = true;
    }
    this.found = findings.sources;
    this.sqlTables = findings.sqlTables;
    if (final) {
      this.lookedAt = this.now();
      this.answered = true;
      this.run = undefined;
    }
    if (run.first && run.late) this.lateAnswer = run.gaveUp ? 'afterDeadline' : 'late';
    if (run.waitOver) {
      this.publishLate();
      return;
    }
    if (final) {
      run.endWait();
    } else if (!run.settle) {
      run.settle = setTimeout(() => run.endWait(), this.deps.settleMs ?? START_LOOK_SETTLE_MS);
    }
  }

  /** The look answered with nobody waiting: publish the suggestion if it changed. */
  private publishLate(): void {
    let ctx: Omit<StartContext, 'found'>;
    try {
      ctx = this.deps.context();
    } catch {
      return; // the next refresh counts and publishes
    }
    this.publishFrom(ctx);
  }
}

function isFindings(value: ReadonlySet<DetectedImportSource> | StartLookFindings): value is StartLookFindings {
  return !(value instanceof Set) && typeof value === 'object' && value !== null && 'sources' in value;
}
