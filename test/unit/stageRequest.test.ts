/**
 * Tests for the switchStage → stageData sequence tokens (H23).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetStageRequests,
  currentStageRequestId,
  isStaleStageReply,
  nextStageRequestId,
} from '../../webview/lib/stageRequest';

describe('stageRequest', () => {
  beforeEach(() => {
    _resetStageRequests();
  });

  it('allocates increasing ids', () => {
    expect(nextStageRequestId()).toBe(1);
    expect(nextStageRequestId()).toBe(2);
    expect(currentStageRequestId()).toBe(2);
  });

  it('accepts untagged replies (host-initiated switches)', () => {
    nextStageRequestId();
    expect(isStaleStageReply(undefined)).toBe(false);
  });

  it('accepts the reply to the latest request and drops older ones', () => {
    const first = nextStageRequestId();
    const second = nextStageRequestId();
    // Slow reply for the first request arrives after the second was sent
    expect(isStaleStageReply(first)).toBe(true);
    expect(isStaleStageReply(second)).toBe(false);
  });
});
