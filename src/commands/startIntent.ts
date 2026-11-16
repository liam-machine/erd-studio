/**
 * The start screen's suggestion for the open folder (`startIntentFor`,
 * `src/types/startActions.ts`), kept by the host for the session and
 * published as the `erdStudio.startIntent` context key, which the walkthrough
 * and the empty Diagrams view gate their start variants on.
 *
 * The folder's files are looked at (Import…'s own bounded detector,
 * `detectImportSources`) only when they can decide the suggestion — a new
 * DBML project without dbt and without a diagram — and only when a start
 * surface asks: the empty Diagrams view being drawn, the Welcome panel's
 * status, the walkthrough being opened, or the start suggestion. Never on
 * activation's own path (a refresh is always deferred), never writing
 * anything, and each look is cancelled after {@link START_LOOK_TIMEOUT_MS}
 * ({@link START_LOOK_ON_SCREEN_MS} while a surface shows the wait). What it
 * found stays on this machine: telemetry gets the suggestion's fixed key only.
 *
 * A look that runs out of time is tried once more straight away, within the
 * same ask ({@link START_LOOK_ATTEMPTS}), so the ask that timed out still gets
 * the folder's suggestion; only when every attempt ran out of time does the
 * folder count as holding nothing to import, for the rest of the session
 * (#328: a timed-out first look used to publish `blank`, and the start
 * suggestion then showed nothing).
 *
 * The empty Diagrams view of a folder without dbt shows "Looking at your
 * folder…" until the first suggestion is published (so New Diagram never
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

/** How long a first look nobody is shown waiting on may take before it is cancelled (and tried again). */
export const START_LOOK_TIMEOUT_MS = 1500;
/**
 * How long a look may take while a surface shows the wait (the empty Diagrams
 * view says "Looking at your folder…"), and how long every retry may take:
 * the folder's listing is warm in the file system's cache by then. A surface
 * that starts showing the wait while a shorter look runs stretches that look
 * to this, counted from its start.
 */
export const START_LOOK_ON_SCREEN_MS = 2 * START_LOOK_TIMEOUT_MS;
/** A finished look is reused for this long. */
export const START_LOOK_FRESH_MS = 60_000;
/**
 * Looks that may run out of time in a session: the first is tried once more
 * straight away, in the same ask, with {@link START_LOOK_ON_SCREEN_MS}; after
 * that the folder counts as holding nothing to import for the rest of the
 * session. The worst wait is 1.5 s + 3 s for an unseen ask, 3 s + 3 s for one
 * on screen.
 */
export const START_LOOK_ATTEMPTS = 2;

export interface StartRefreshOptions {
  /**
   * The asking surface shows that it waits ("Looking at your folder…" in the
   * empty Diagrams view): the look gets {@link START_LOOK_ON_SCREEN_MS}.
   */
  onScreen?: boolean;
}

export interface StartIntentDeps {
  /** Where the folder stands now (cheap: no file walk). */
  context(): Omit<StartContext, 'found'>;
  /**
   * The bounded look at the folder; it stops when `signal` aborts. The
   * sources found, or those with the CREATE TABLE count the start
   * suggestion names (`sqlTables`, only when exact).
   */
  look(signal: AbortSignal): Promise<ReadonlySet<DetectedImportSource> | StartLookFindings>;
  /** Publish a changed suggestion (the context key). Never while a look and its retry run. */
  publish(intent: StartIntent): void;
  /** The look saw a `dbt_project.yml` while the window runs without dbt (the host notes it; never a prompt). */
  onDbtProjectSeen?(): void;
  timeoutMs?: number;
  now?(): number;
  /**
   * Counts a fixed key (`startLookTimeout`, `startLookGaveUp`,
   * `startLookLateSuggestion`: the look that answered after a timeout found
   * an import, so the timeout would have cost the suggestion; the host counts
   * each once a day).
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

export class StartIntentTracker {
  private found: ReadonlySet<DetectedImportSource> | undefined;
  private sqlTables: number | undefined;
  /** When `found` was looked up; Infinity once {@link START_LOOK_ATTEMPTS} looks ran out of time. */
  private lookedAt = Number.NEGATIVE_INFINITY;
  /** Looks that ran out of time so far. */
  private timeouts = 0;
  private inFlight: Promise<void> | undefined;
  /** A surface asked for the look in flight and shows the wait: its short first attempt is stretched. */
  private inFlightOnScreen = false;
  private controller: AbortController | undefined;
  private published: StartIntent | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /**
   * The first look that answered after a timeout has run (whatever it found):
   * `startLookLateSuggestion` is decided on that look only, once a session.
   */
  private retrySettled = false;
  /** That look just answered: the refresh that resumes after it decides the key. */
  private retryJustSettled = false;

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
      await this.lookOnce(options.onScreen === true);
    }
    const intent = startIntentFor({ ...ctx, found: this.found });
    // What the first timeout would have cost: the retry (the first look that
    // answered after it) found an import, which a timed-out look used to hide
    // behind blank. A later look finding a file added since is not counted,
    // nor one that changes a suggestion other than blank.
    const afterRetry = this.retryJustSettled;
    this.retryJustSettled = false;
    if (intent && intent !== this.published && !this.disposed) {
      if (afterRetry && (this.published === undefined || this.published === 'blank') && isDirectImport(intent)) {
        this.count(() => this.deps.feature?.('startLookLateSuggestion'));
      }
      this.published = intent;
      this.deps.publish(intent);
    }
    return intent;
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
    this.controller?.abort();
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
    if (this.lookedAt === Number.POSITIVE_INFINITY) return true;
    return this.found !== undefined && this.now() - this.lookedAt < START_LOOK_FRESH_MS;
  }

  /**
   * One look at a time, retried in the same ask after a timeout; concurrent
   * callers share it. An on-screen caller joining a look in flight stretches
   * its short first attempt to {@link START_LOOK_ON_SCREEN_MS}.
   */
  private lookOnce(onScreen: boolean): Promise<void> {
    if (this.inFlight) {
      if (onScreen) this.inFlightOnScreen = true;
      return this.inFlight;
    }
    this.inFlightOnScreen = onScreen;
    const run = async (): Promise<void> => {
      try {
        while (!this.disposed && this.timeouts < START_LOOK_ATTEMPTS) {
          if (await this.lookAttempt()) return;
        }
      } finally {
        this.inFlight = undefined;
        this.inFlightOnScreen = false;
      }
    };
    this.inFlight = run();
    return this.inFlight;
  }

  /** One bounded look. True when it answered; false when it ran out of time (counted, and the folder given up on after the last attempt). */
  private async lookAttempt(): Promise<boolean> {
    const controller = new AbortController();
    this.controller = controller;
    const short = this.deps.timeoutMs ?? START_LOOK_TIMEOUT_MS;
    const long = 2 * short;
    // A retry gets the long time (the listing is warm now), and so does a look a surface shows waiting on.
    const budget = this.timeouts > 0 || this.inFlightOnScreen ? long : short;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      let stretched = false;
      const expire = (): void => {
        // A surface started showing the wait meanwhile: the rest of the long time, from the look's start.
        if (budget < long && !stretched && this.inFlightOnScreen) {
          stretched = true;
          timer = setTimeout(expire, long - budget);
          return;
        }
        resolve('timeout');
      };
      timer = setTimeout(expire, budget);
    });
    try {
      const result = await Promise.race([
        this.deps.look(controller.signal).catch(() => {
          // Our own abort after a timeout is not a failure of the look.
          if (!controller.signal.aborted) this.count(() => this.deps.error?.('startLookFailed'));
          return new Set<DetectedImportSource>();
        }),
        timedOut,
      ]);
      if (result === 'timeout') {
        controller.abort();
        this.timeouts++;
        this.count(() => this.deps.feature?.('startLookTimeout'));
        if (this.timeouts >= START_LOOK_ATTEMPTS) {
          // Out of attempts: the folder counts as holding nothing to import, and is not looked at again this session.
          this.found = new Set();
          this.sqlTables = undefined;
          this.lookedAt = Number.POSITIVE_INFINITY;
          this.count(() => this.deps.feature?.('startLookGaveUp'));
        }
        return false;
      }
      const findings: StartLookFindings = isFindings(result) ? result : { sources: result };
      this.found = findings.sources;
      this.sqlTables = findings.sqlTables;
      this.lookedAt = this.now();
      if (this.timeouts > 0 && !this.retrySettled) {
        this.retrySettled = true;
        this.retryJustSettled = true;
      }
      if (findings.dbtProject) this.noteDbtProject();
      return true;
    } finally {
      if (timer) clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
    }
  }
}

function isFindings(value: ReadonlySet<DetectedImportSource> | StartLookFindings): value is StartLookFindings {
  return !(value instanceof Set) && typeof value === 'object' && value !== null && 'sources' in value;
}
