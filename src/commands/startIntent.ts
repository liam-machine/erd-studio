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
 * status, or the walkthrough being opened. Never on activation's own path
 * (a refresh is always deferred), never writing anything, and the look is
 * cancelled after {@link START_LOOK_TIMEOUT_MS}. What it found stays on this
 * machine: telemetry gets the suggestion's fixed key only. A look that runs
 * out of time is tried once more, on the next refresh
 * ({@link START_LOOK_ATTEMPTS}).
 *
 * The empty Diagrams view of a folder without dbt shows "Loading diagrams…"
 * until the first suggestion is published (so New Diagram never shows first
 * and then turns into an import), so a refresh always publishes one: `blank`
 * when the folder's state cannot be read.
 *
 * vscode-free: the look, the context and the publishing are injected.
 */

import {
  startIntentFor,
  startNeedsLook,
  type DetectedImportSource,
  type StartContext,
  type StartIntent,
} from '../types/startActions';

/** How long the look may take before it is cancelled and the folder counts as holding nothing to import. */
export const START_LOOK_TIMEOUT_MS = 1500;
/** A finished look is reused for this long. */
export const START_LOOK_FRESH_MS = 60_000;
/**
 * Looks that ran out of time before the session stops looking: the first is
 * tried once more on the next refresh (with twice the time, the folder's
 * listing now warm in the file system's cache); after that the folder counts
 * as holding nothing to import for the rest of the session.
 */
export const START_LOOK_ATTEMPTS = 2;

export interface StartIntentDeps {
  /** Where the folder stands now (cheap: no file walk). */
  context(): Omit<StartContext, 'found'>;
  /**
   * The bounded look at the folder; it stops when `signal` aborts. The
   * sources found, or those with the CREATE TABLE count the start
   * suggestion names (`sqlTables`, only when exact).
   */
  look(signal: AbortSignal): Promise<ReadonlySet<DetectedImportSource> | StartLookFindings>;
  /** Publish a changed suggestion (the context key). */
  publish(intent: StartIntent): void;
  /** The look saw a `dbt_project.yml` while the window runs without dbt (the host notes it; never a prompt). */
  onDbtProjectSeen?(): void;
  timeoutMs?: number;
  now?(): number;
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
  private controller: AbortController | undefined;
  private published: StartIntent | undefined;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly deps: StartIntentDeps) {}

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
  async refresh(): Promise<StartIntent | undefined> {
    if (this.disposed) return this.known();
    let ctx: Omit<StartContext, 'found'>;
    try {
      ctx = this.deps.context();
    } catch {
      // The empty Diagrams view waits (Loading…) until a suggestion is published:
      // never leave it waiting. A blank diagram is always a valid start.
      if (this.published === undefined && !this.disposed) {
        this.published = 'blank';
        this.deps.publish('blank');
      }
      return undefined;
    }
    if (startNeedsLook(ctx) && !this.isFresh()) {
      await this.lookOnce();
    }
    const intent = startIntentFor({ ...ctx, found: this.found });
    if (intent && intent !== this.published && !this.disposed) {
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

  /** One look at a time; concurrent callers share it. */
  private lookOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.controller = controller;
    // A retry after a timed-out look gets more time (the listing is warm now).
    const timeoutMs = (this.deps.timeoutMs ?? START_LOOK_TIMEOUT_MS) * (1 + this.timeouts);
    const run = async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const result = await Promise.race([
          this.deps.look(controller.signal).catch(() => new Set<DetectedImportSource>()),
          timedOut,
        ]);
        if (result === 'timeout') {
          controller.abort();
          this.found = new Set();
          this.sqlTables = undefined;
          this.timeouts++;
          // Stale (looked at again on the next refresh) until the attempts run out.
          this.lookedAt = this.timeouts >= START_LOOK_ATTEMPTS ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        } else {
          const findings: StartLookFindings = isFindings(result) ? result : { sources: result };
          this.found = findings.sources;
          this.sqlTables = findings.sqlTables;
          this.lookedAt = this.now();
          if (findings.dbtProject) this.noteDbtProject();
        }
      } finally {
        if (timer) clearTimeout(timer);
        this.inFlight = undefined;
        if (this.controller === controller) this.controller = undefined;
      }
    };
    this.inFlight = run();
    return this.inFlight;
  }
}

function isFindings(value: ReadonlySet<DetectedImportSource> | StartLookFindings): value is StartLookFindings {
  return !(value instanceof Set) && typeof value === 'object' && value !== null && 'sources' in value;
}
