/**
 * Sequence tokens for switchStage → stageData round-trips.
 *
 * Every `switchStage` the webview sends carries a fresh, increasing
 * `requestId`. The host echoes it on the matching `stageData` reply. If the
 * user switches again before a slow reply arrives (e.g. a cold manifest parse
 * for the physical stage), the older reply's token no longer matches the
 * latest request and the webview drops it instead of rendering a stage the
 * user has already left.
 *
 * Replies without a token (host-initiated switches from the tree view or a
 * watcher refresh) are always accepted.
 */

let latestRequestId = 0;

/** Allocate the token for a new switchStage request. */
export function nextStageRequestId(): number {
  latestRequestId += 1;
  return latestRequestId;
}

/** The token of the most recent switchStage request (0 before any request). */
export function currentStageRequestId(): number {
  return latestRequestId;
}

/**
 * True when a `stageData` reply should be ignored because a newer switchStage
 * request has been sent since. Untagged replies are never stale.
 */
export function isStaleStageReply(requestId: number | undefined): boolean {
  return requestId !== undefined && requestId !== latestRequestId;
}

/** Test helper — reset the sequence. */
export function _resetStageRequests(): void {
  latestRequestId = 0;
}
