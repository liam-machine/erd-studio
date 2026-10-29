/**
 * useReconnectWatchdog — decide when the "Canvas disconnected" overlay shows.
 *
 * The webview sends `ready` on mount (and again on the error screen's Retry)
 * and waits for the host's answer. If no answer arrives within the grace
 * period, the extension host probably cannot reach this panel (typically it
 * was updated or restarted while the panel was open), so the overlay offers a
 * window reload. Activation-time auto-recovery in the host should usually fix
 * that before the overlay ever shows — this is the safety net.
 *
 * `waiting` is true only while the panel has neither a domain nor an error.
 * An `error` is an answer: it proves the host is connected, so it stops the
 * timer and hides the overlay. Retry clears the error, which makes `waiting`
 * true again and starts a fresh grace period — a host that then stays silent
 * still gets the overlay (issue #149: the timer used to keep running behind
 * the error screen, so Retry flashed the overlay before the error came back).
 *
 * The host's `loading` message is an answer too: it comes before the host
 * reads the diagram, which on a large library takes a while. The canvas then
 * waits {@link LOADING_STALL_MS} instead (the caller passes it as `delayMs`;
 * a new delay starts a fresh timer), so a slow load never looks like a lost
 * connection, while a host that stops answering half-way still gets the
 * overlay in the end.
 */
import { useEffect, useState } from 'react';

/** How long the webview waits for the host's first answer. */
export const RECONNECT_GRACE_MS = 5000;

/** How long the webview waits for the diagram once the host has said it is loading it. */
export const LOADING_STALL_MS = 120_000;

export function useReconnectWatchdog(waiting: boolean, delayMs: number = RECONNECT_GRACE_MS): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (!waiting) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [waiting, delayMs]);
  // `&& waiting` so a stale `true` can never show for the one render before the
  // reset above runs.
  return timedOut && waiting;
}
