/**
 * Hover intent — decides when a pointer resting on a table becomes a hover
 * focus, so skimming across the canvas does not flash every table it crosses.
 *
 *   - From nothing to a table: wait `HOVER_ENTER_DELAY_MS`.
 *   - From table A to table B: wait `HOVER_SWITCH_DELAY_MS`, then commit B
 *     directly (never null in between, so nothing un-dims and re-dims).
 *   - Leaving: wait `HOVER_LEAVE_GRACE_MS` before clearing; entering again,
 *     or `hold()` (the pointer is on one of the focus's bright lines), cancels
 *     the clear.
 *
 * An enter is ignored while a mouse button is held (`buttons !== 0`), while
 * `isSuppressed()` says so (it is asked again when the timer fires), or when
 * the table is already the focus. At most two timers exist at a time.
 *
 * Framework-free; timers are injected so tests can use fake ones.
 */

export const HOVER_ENTER_DELAY_MS = 120;
export const HOVER_SWITCH_DELAY_MS = 60;
export const HOVER_LEAVE_GRACE_MS = 150;

type TimerId = ReturnType<typeof setTimeout>;

export interface HoverIntentOptions {
  /** Make `id` the focus, or clear it with null. */
  commit: (id: string | null) => void;
  /** The id currently in focus (read at event time). */
  current: () => string | null;
  /** True while hover must not start a focus (drags, menus, pans). */
  isSuppressed: () => boolean;
  setTimeout?: (fn: () => void, ms: number) => TimerId;
  clearTimeout?: (id: TimerId) => void;
}

export interface HoverIntent {
  enter(id: string, buttons: number): void;
  leave(): void;
  hold(): void;
  cancelPending(): void;
  dispose(): void;
}

export function createHoverIntent(options: HoverIntentOptions): HoverIntent {
  const { commit, current, isSuppressed } = options;
  const schedule = options.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.clearTimeout ?? ((id: TimerId) => clearTimeout(id));

  let enterTimer: TimerId | null = null;
  let pendingId: string | null = null;
  let leaveTimer: TimerId | null = null;
  let disposed = false;

  const cancelEnter = () => {
    if (enterTimer !== null) cancel(enterTimer);
    enterTimer = null;
    pendingId = null;
  };
  const cancelLeave = () => {
    if (leaveTimer !== null) cancel(leaveTimer);
    leaveTimer = null;
  };

  return {
    enter(id, buttons) {
      if (disposed || buttons !== 0 || isSuppressed()) return;
      cancelLeave();
      if (id === current()) {
        cancelEnter();
        return;
      }
      if (id === pendingId) return;
      cancelEnter();
      pendingId = id;
      const delay = current() === null ? HOVER_ENTER_DELAY_MS : HOVER_SWITCH_DELAY_MS;
      enterTimer = schedule(() => {
        enterTimer = null;
        pendingId = null;
        if (disposed || isSuppressed()) return;
        commit(id);
      }, delay);
    },
    leave() {
      if (disposed) return;
      cancelEnter();
      cancelLeave();
      if (current() === null) return; // nothing to clear
      leaveTimer = schedule(() => {
        leaveTimer = null;
        if (disposed) return;
        commit(null);
      }, HOVER_LEAVE_GRACE_MS);
    },
    hold() {
      if (disposed) return;
      cancelLeave();
    },
    cancelPending() {
      cancelEnter();
      cancelLeave();
    },
    dispose() {
      cancelEnter();
      cancelLeave();
      disposed = true;
    },
  };
}
