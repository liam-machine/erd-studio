// @vitest-environment jsdom
/**
 * The crash screen in the page: a render crash anywhere under the root
 * `CrashFallbackBoundary` (through the area boundaries, which tag and rethrow
 * it) shows plain words — a problem in ERD Studio, not in the user's files —
 * with Reload and Send Feedback instead of a blank panel. The crash is
 * reported once, by kind and area, never its text. The canvas's buttons post
 * `crashFallback` through `useSend()`; the draft page's post its passive
 * `crashFallback`. Send Feedback carries the first line only, paths redacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));

import { AreaErrorBoundary } from '../../webview/components/ErrorBoundary/AreaErrorBoundary';
import { CrashFallback, CrashFallbackBoundary, RELOAD_STUCK_MS, caughtCrashOf } from '../../webview/components/ErrorBoundary/CrashFallback';
import { CanvasCrashFallback } from '../../webview/components/ErrorBoundary/CanvasCrashFallback';
import { DraftCrashFallback } from '../../webview-draft/components/DraftCrashFallback';
import { installWebviewErrorReporting, reportCaughtRenderCrash, tagCrashArea } from '../../webview/lib/webviewErrors';
import type { DraftToHost } from '../../src/types/draft';
import { CRASH_DETAIL_MAX, cutCrashDetail } from '../../src/types/webviewError';
import { validateCrashFallbackPayload } from '../../src/providers/payloadValidation';

let boom: Error;
function Boom(): never {
  throw boom;
}

beforeEach(() => {
  boom = new TypeError('Cannot read x of /Users/someone/acme/.erd-studio/gold/diagrams/sales.dbml\n    at Boom (webview.js:1:1)');
  mockPostMessage.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CrashFallbackBoundary', () => {
  it('renders its children while nothing crashes', () => {
    render(<CrashFallbackBoundary fallback={() => <p>crashed</p>}><p>fine</p></CrashFallbackBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.queryByText('crashed')).toBeNull();
  });

  it('catches a crash the area boundaries rethrow, with the innermost area and a redacted first line', () => {
    const seen: unknown[] = [];
    render(
      <CrashFallbackBoundary fallback={(crash) => { seen.push(crash); return <p>crashed</p>; }}>
        <AreaErrorBoundary area="canvas">
          <AreaErrorBoundary area="toolbar"><Boom /></AreaErrorBoundary>
        </AreaErrorBoundary>
      </CrashFallbackBoundary>,
    );
    expect(screen.getByText('crashed')).toBeTruthy();
    const crash = seen.at(-1) as { area?: string; detail: string };
    expect(crash.area).toBe('toolbar');
    expect(crash.detail).toMatch(/^TypeError: Cannot read x of /);
    expect(crash.detail).not.toContain('someone');
    expect(crash.detail).not.toContain('sales');
    expect(crash.detail).not.toContain('webview.js:1:1');
  });

  it('reports the crash once, as a render crash in its area, never its text', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const uninstall = installWebviewErrorReporting(report, 'other');
    try {
      render(
        <CrashFallbackBoundary fallback={() => <p>crashed</p>}>
          <AreaErrorBoundary area="detailPanel"><Boom /></AreaErrorBoundary>
        </CrashFallbackBoundary>,
      );
      // React's development build also dispatches the error to the window: still counted once.
      vi.advanceTimersByTime(5);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report).toHaveBeenCalledWith('render', 'detailPanel');
      expect(JSON.stringify(report.mock.calls)).not.toContain('someone');
      // The same error reported again by the boundary route is not counted twice.
      reportCaughtRenderCrash(boom);
      expect(report).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
      vi.useRealTimers();
    }
  });

  it('a caught crash outside every area counts in the fallback area; nothing installed is a no-op', () => {
    const report = vi.fn();
    const uninstall = installWebviewErrorReporting(report, 'draft');
    reportCaughtRenderCrash(new Error('outside'));
    expect(report).toHaveBeenCalledWith('render', 'draft');
    uninstall();
    expect(() => reportCaughtRenderCrash(new Error('after'))).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('caughtCrashOf leaves out the draft page\'s area (not a canvas area) and anything that is not text', () => {
    const tagged = new Error('d');
    tagCrashArea(tagged, 'draft');
    expect(caughtCrashOf(tagged)).toEqual({ detail: 'd' });
    expect(caughtCrashOf(42)).toEqual({ detail: '' });
  });

  it('caughtCrashOf redacts before it cuts, so a detail that redaction lengthens still fits and is accepted', () => {
    const raw = new Error('Could not draw /a/b.yml ' + 'x'.repeat(400));
    const { detail } = caughtCrashOf(raw);
    expect(detail.length).toBeLessThanOrEqual(CRASH_DETAIL_MAX);
    expect(detail.startsWith('Could not draw {path}/{file}.yml x')).toBe(true);
    expect(detail.endsWith('…')).toBe(true);
    expect(validateCrashFallbackPayload({ action: 'feedback', detail })).toBe(true);
  });

  it('a cut never leaves half a placeholder', () => {
    // The 300-character cut would land inside the `{project}` a path near the end becomes.
    const raw = new Error(`${'w'.repeat(CRASH_DETAIL_MAX - 6)} /Users/someone/acme/.erd-studio/silver/sales.json`);
    const { detail } = caughtCrashOf(raw);
    expect(detail.length).toBeLessThanOrEqual(CRASH_DETAIL_MAX);
    expect(detail).not.toContain('someone');
    expect(detail).toMatch(/w…$/);
    expect(cutCrashDetail('short')).toBe('short');
  });
});

describe('CrashFallback', () => {
  it('says the problem is ERD Studio\'s, not the user\'s files, and offers Reload and Send Feedback', () => {
    const onReload = vi.fn();
    const onSendFeedback = vi.fn();
    render(<CrashFallback surface="canvas" onReload={onReload} onSendFeedback={onSendFeedback} />);
    const alert = screen.getByRole('alert');
    expect(alert.className).toBe('crash-fallback');
    expect(alert.textContent).toContain('This diagram stopped working');
    expect(alert.textContent).toContain('This is a problem in ERD Studio, not in your files.');
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));
    expect(onSendFeedback).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    // Pressed once: it says so and cannot be pressed again while the page reloads.
    const reloading = screen.getByRole('button', { name: 'Reloading…' }) as HTMLButtonElement;
    expect(reloading.disabled).toBe(true);
  });

  it('a Reload the host never answers comes back after a while with a way out', async () => {
    vi.useFakeTimers();
    try {
      const onReload = vi.fn();
      render(<CrashFallback surface="canvas" onReload={onReload} onSendFeedback={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      expect(screen.queryByRole('status')).toBeNull();
      await act(async () => { vi.advanceTimersByTime(RELOAD_STUCK_MS); });
      const again = screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement;
      expect(again.disabled).toBe(false);
      expect(screen.getByRole('status').textContent).toContain('Close and reopen the tab, or run Developer: Reload Window.');
      expect(screen.getByRole('status').className).toBe('crash-fallback__hint');
      fireEvent.click(again);
      expect(onReload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the draft page says nothing has been written yet', () => {
    render(<CrashFallback surface="draft" onReload={() => {}} onSendFeedback={() => {}} />);
    expect(screen.getByRole('alert').textContent).toContain('The draft preview stopped working');
    expect(screen.getByRole('alert').textContent).toContain('Nothing has been written yet.');
  });
});

describe('the canvas and draft crash screens post their buttons', () => {
  it('the canvas posts crashFallback through useSend, with the area and detail for feedback only', () => {
    render(<CanvasCrashFallback crash={{ area: 'toolbar', detail: 'TypeError: nope' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(mockPostMessage.mock.calls.map(([m]) => m)).toEqual([
      { type: 'crashFallback', payload: { action: 'feedback', area: 'toolbar', detail: 'TypeError: nope' } },
      { type: 'crashFallback', payload: { action: 'reload' } },
    ]);
  });

  it('the canvas leaves out an empty detail and an unknown area', () => {
    render(<CanvasCrashFallback crash={{ detail: '' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'crashFallback', payload: { action: 'feedback' } });
  });

  it('the draft page posts its passive crashFallback to its host', () => {
    const sent: DraftToHost[] = [];
    render(<DraftCrashFallback host={{ post: (m) => sent.push(m) }} crash={{ detail: 'boom' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send Feedback' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(sent).toEqual([
      { type: 'crashFallback', action: 'feedback', detail: 'boom' },
      { type: 'crashFallback', action: 'reload' },
    ]);
    expect(mockPostMessage).not.toHaveBeenCalled();
  });
});
