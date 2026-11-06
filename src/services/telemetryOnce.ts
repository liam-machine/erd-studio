/**
 * Count a thrown error once (telemetry plan B12). A canvas handler that
 * records its own failure and the message boundary it may reach both see the
 * same error object; whichever records first marks it, and the other skips
 * it. Two messages awaiting one queued edit (folded position batches) share
 * one rejection, which is likewise counted once.
 *
 * vscode-free. Holds the errors weakly, so nothing is kept alive by it. A
 * thrown value that is not an object cannot be marked and is always counted.
 */

const recorded = new WeakSet<object>();

/** Mark `err` as counted. */
export function markRecorded(err: unknown): void {
  if (typeof err === 'object' && err !== null) recorded.add(err);
}

/** Whether `err` was already counted. */
export function wasRecorded(err: unknown): boolean {
  return typeof err === 'object' && err !== null && recorded.has(err);
}
