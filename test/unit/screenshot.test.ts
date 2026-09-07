/**
 * Screenshot capture guards.
 *
 * The rasteriser (`html-to-image`) resolves inside a `requestAnimationFrame`
 * callback, which the browser stops firing while the document is hidden — so a
 * capture started just before the user switches VS Code tabs never settles.
 * `withTimeout` is what stops the Feedback dialog hanging on "Capturing the
 * canvas…" forever in that case.
 */

import { describe, it, expect, vi } from 'vitest';

import { withTimeout, CAPTURE_TIMEOUT_MS, MAX_PNG_BYTES } from '../../webview/lib/screenshot';

describe('screenshot capture guards', () => {
  describe('withTimeout', () => {
    it('passes through a value that resolves in time', async () => {
      await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
    });

    it('resolves to a sentinel (not the value) when the promise never settles', async () => {
      vi.useFakeTimers();
      try {
        // A promise that never settles — exactly what a hidden-tab capture produces.
        const pending = withTimeout(new Promise<string>(() => {}), 5000);
        await vi.advanceTimersByTimeAsync(5001);
        const settled = await pending;
        expect(settled).not.toBe('done');
        expect(typeof settled).toBe('symbol');
      } finally {
        vi.useRealTimers();
      }
    });

    it('propagates rejection rather than swallowing it into a timeout', async () => {
      await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    });

    it('clears its timer so a slow success does not keep a pending handle', async () => {
      vi.useFakeTimers();
      try {
        const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
        await withTimeout(Promise.resolve('ok'), 10_000);
        expect(clearSpy).toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        clearSpy.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it('uses a capture budget long enough for a large canvas but short enough to notice', () => {
      expect(CAPTURE_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
      expect(CAPTURE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
    });
  });

  // The attachment helpers apply the same ceiling to a captured canvas, so the
  // constant has to be exported rather than module-private.
  it('exports the PNG ceiling the attachment helpers reuse', () => {
    expect(MAX_PNG_BYTES).toBe(12 * 1024 * 1024);
  });
});
