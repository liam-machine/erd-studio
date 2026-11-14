/**
 * Did a webview panel come up? (ERD Studio 2.0 B13.) A panel says `ready`
 * once its page has mounted; one that never does is a blank tab. This watch
 * times that from when the panel is visible — a panel opened behind another
 * tab, or hidden before it was ready, is not judged while it is hidden — and
 * reports once:
 *
 *  - `ready(slow)`: the page said ready; `slow` when it came more than
 *    {@link READY_SLOW_MS} after the panel was last shown;
 *  - `noReady()`: the panel stayed visible {@link READY_TIMEOUT_MS} without
 *    a ready;
 *  - `lateReady(range)`: the page said ready after `noReady()` had already
 *    been reported (#320): it was slow, not broken. Not reported for the
 *    ready of a page the user reloaded from the no-ready notification
 *    ({@link ReadyWatch.reloaded}): that page was replaced, it did not come up.
 *
 * It never throws into its caller (a hook that throws is swallowed), holds
 * no `vscode` and keeps no process alive (the timer is unref'd). Dispose it
 * with the panel.
 */

/** A visible panel with no `ready` after this long counts as one that never became ready. */
export const READY_TIMEOUT_MS = 30_000;

/** A `ready` later than this after the panel was shown counts as slow (`readySlowOver10s`). */
export const READY_SLOW_MS = 10_000;

/**
 * A late `ready` that came this long or more after the panel was shown counts
 * as over a minute (`readyLateOver60s`): a timeout twice as long would still
 * have reported it.
 */
export const READY_LATE_LONG_MS = 60_000;

/**
 * How long after the panel was shown a late `ready` came: the timeout plus
 * the time since it fired. That time is by the clock, hidden or not, because
 * `visibleSince` starts again each time the panel is shown.
 */
export type LateReadyRange = '30to60s' | 'over60s';

export interface ReadyWatchHooks {
  ready?(slow: boolean): void;
  noReady(): void;
  /** After `ready`, when `noReady()` had already been reported for this page. */
  lateReady?(range: LateReadyRange): void;
}

/** The feature keys one late ready counts: the total, and its range beside it. */
export function lateReadyFeatures(range: LateReadyRange): ['readyAfterNoReady', 'readyLate30to60s' | 'readyLateOver60s'] {
  return ['readyAfterNoReady', range === 'over60s' ? 'readyLateOver60s' : 'readyLate30to60s'];
}

export class ReadyWatch {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** When the panel was last shown; undefined while hidden. */
  private visibleSince: number | undefined;
  private readySeen = false;
  private timedOut = false;
  /** When `noReady()` was reported. */
  private timedOutAt: number | undefined;
  /** The page `noReady()` was about has been replaced by a new one. */
  private replaced = false;
  private disposed = false;

  constructor(
    visible: boolean,
    private readonly hooks: ReadyWatchHooks,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (visible) this.shown();
  }

  /** The panel's visibility changed (`onDidChangeViewState`). */
  visibility(visible: boolean): void {
    if (this.disposed || this.readySeen) return;
    if (visible) {
      if (this.visibleSince === undefined) this.shown();
    } else {
      this.visibleSince = undefined;
      this.clear();
    }
  }

  /** The page said `ready` (only the first one counts). */
  ready(): void {
    if (this.disposed || this.readySeen) return;
    this.readySeen = true;
    const slow = this.visibleSince !== undefined && this.now() - this.visibleSince > READY_SLOW_MS;
    this.clear();
    safely(() => this.hooks.ready?.(slow));
    if (this.timedOutAt === undefined || this.replaced) return;
    const sinceShown = READY_TIMEOUT_MS + (this.now() - this.timedOutAt);
    const range: LateReadyRange = sinceShown >= READY_LATE_LONG_MS ? 'over60s' : '30to60s';
    safely(() => this.hooks.lateReady?.(range));
  }

  /**
   * The user reloaded the page from the no-ready notification: the `ready`
   * that follows is the new page's, not a late one from the page that was
   * reported.
   */
  reloaded(): void {
    if (this.timedOut && !this.readySeen) this.replaced = true;
  }

  /** Whether the page has said `ready`. */
  get isReady(): boolean {
    return this.readySeen;
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private shown(): void {
    this.visibleSince = this.now();
    this.clear();
    if (this.timedOut) return;
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.readySeen || this.timedOut) return;
      this.timedOut = true;
      this.timedOutAt = this.now();
      safely(() => this.hooks.noReady());
    }, READY_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    this.timer = timer;
  }

  private clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telemetry never breaks a panel.
  }
}
