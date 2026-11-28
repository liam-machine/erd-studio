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
 *    ({@link ReadyWatch.reloaded}): that page was replaced, it did not come up;
 *  - `noReadyHostHeld()`: right after `noReady()`, when its timer ran
 *    {@link NO_READY_HOST_HELD_MS} or more late (#364): the extension host was
 *    too busy to run timers, so it was busy at 30 s. It does not say the page
 *    had mounted: a ready that reached the host would have cleared the timer
 *    or followed as `lateReady`. Timed on a monotonic clock, so a machine that
 *    slept through the 30 s is not counted;
 *  - `closedBlank(range)`: the panel was disposed after `noReady()` with no
 *    ready and no reload since (#364): the tab went away still blank, `range`
 *    after it was shown. Once, from {@link ReadyWatch.dispose}.
 *
 * It never throws into its caller (a hook that throws is swallowed), holds
 * no `vscode` and keeps no process alive (the timer is unref'd). Dispose it
 * with the panel.
 */

import type { LateReadyRange } from '../types/webviewError';

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
 * A `noReady()` whose timer ran this long or more after its 30 s were up
 * counts as on a held host (`noReadyHostHeld`, #364): a timer that late means
 * the host's one thread was not running timers.
 */
export const NO_READY_HOST_HELD_MS = 5_000;

/**
 * How long after the panel was shown a late `ready` came, timed by the clock
 * from the show that ran out (hidden or not since): `visibleSince` starts
 * again each time the panel is shown, and a busy host runs the timer late, so
 * neither the last show nor the moment `noReady()` ran is the start.
 */
export type { LateReadyRange };

export interface ReadyWatchHooks {
  ready?(slow: boolean): void;
  noReady(): void;
  /** After `ready`, when `noReady()` had already been reported for this page. */
  lateReady?(range: LateReadyRange): void;
  /** Right after `noReady()`, when its timer ran 5 s or more late (#364). */
  noReadyHostHeld?(): void;
  /** On dispose, when `noReady()` was reported and no ready or reload came since (#364). */
  closedBlank?(range: LateReadyRange): void;
}

/** The feature key a tab closed while still blank counts (#364): how long after it was shown. */
export function closedBlankFeature(range: LateReadyRange): 'noReadyClosed30to60s' | 'noReadyClosedOver60s' {
  return range === 'over60s' ? 'noReadyClosedOver60s' : 'noReadyClosed30to60s';
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
  /** When the panel was shown for the 30 s `noReady()` reported; undefined until it is reported. */
  private noReadyShownAt: number | undefined;
  /** The page `noReady()` was about has been replaced by a new one. */
  private replaced = false;
  private disposed = false;

  constructor(
    visible: boolean,
    private readonly hooks: ReadyWatchHooks,
    private readonly now: () => number = () => Date.now(),
    /**
     * A monotonic clock, used only to tell how late the timer ran (#364): it
     * does not jump with the wall clock, and on macOS and Linux it does not
     * run while the machine sleeps, so a sleep is not a held host.
     */
    private readonly elapsed: () => number = () => performance.now(),
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
    if (this.noReadyShownAt === undefined || this.replaced) return;
    const sinceShown = this.now() - this.noReadyShownAt;
    const range: LateReadyRange = sinceShown >= READY_LATE_LONG_MS ? 'over60s' : '30to60s';
    safely(() => this.hooks.lateReady?.(range));
  }

  /**
   * The page was replaced by a new one (Reload on the no-ready notification
   * or the crash screen, or a panel that does not keep its page was hidden):
   * the `ready` that follows is the new page's, not a late one from the page
   * that was reported.
   */
  reloaded(): void {
    if (this.timedOut && !this.readySeen) this.replaced = true;
  }

  /** Whether the page has said `ready`. */
  get isReady(): boolean {
    return this.readySeen;
  }

  /**
   * The panel closed. A page that was reported as not ready, never said ready
   * and was not replaced went away blank (#364): `closedBlank` is told once,
   * with how long after the show that ran out.
   */
  dispose(): void {
    if (!this.disposed && this.timedOut && !this.readySeen && !this.replaced) {
      const sinceShown = this.now() - this.noReadyShownAt!;
      const range: LateReadyRange = sinceShown >= READY_LATE_LONG_MS ? 'over60s' : '30to60s';
      safely(() => this.hooks.closedBlank?.(range));
    }
    this.disposed = true;
    this.clear();
  }

  /** Whether `noReady()` has been reported. */
  private get timedOut(): boolean {
    return this.noReadyShownAt !== undefined;
  }

  private shown(): void {
    const shownAt = this.now();
    this.visibleSince = shownAt;
    this.clear();
    if (this.timedOut) return;
    const armedAt = this.elapsed();
    const timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed || this.readySeen || this.timedOut) return;
      this.noReadyShownAt = shownAt;
      safely(() => this.hooks.noReady());
      if (this.elapsed() - armedAt >= READY_TIMEOUT_MS + NO_READY_HOST_HELD_MS) {
        safely(() => this.hooks.noReadyHostHeld?.());
      }
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
