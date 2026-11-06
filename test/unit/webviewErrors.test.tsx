// @vitest-environment jsdom
/**
 * Webview crash capture (2.0 B13): the area boundaries add no fallback UI —
 * a render crash still fails the page as before — they only tag the error
 * with the innermost area, and the page's listener reports the kind and area
 * once (never the text). Capped per kind; ResizeObserver noise is dropped;
 * the draft page posts `pageError`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { AreaErrorBoundary } from '../../webview/components/ErrorBoundary/AreaErrorBoundary';
import {
  MAX_WEBVIEW_ERROR_REPORTS,
  crashAreaOf,
  installWebviewErrorReporting,
  tagCrashArea,
} from '../../webview/lib/webviewErrors';
import { reportDraftPageErrors } from '../../webview-draft/lib/pageErrors';
import { zoomFromTransform, fittedZoomOf } from '../../webview-draft/lib/fitZoom';
import type { DraftToHost } from '../../src/types/draft';

afterEach(cleanup);

let boom: Error;
function Boom(): never {
  throw boom;
}

/** Render `node`, returning what React let escape (the page failing as it does without a boundary). */
function renderCrash(node: JSX.Element): unknown {
  try {
    render(node);
  } catch (err) {
    return err;
  }
  return undefined;
}

beforeEach(() => {
  boom = new Error('secret path /Users/someone/project/x.dbml');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AreaErrorBoundary', () => {
  it('renders its children untouched', () => {
    const { getByText } = render(<AreaErrorBoundary area="toolbar"><p>fine</p></AreaErrorBoundary>);
    expect(getByText('fine')).toBeTruthy();
  });

  it('rethrows a render crash with no fallback, tagged with its area', () => {
    const escaped = renderCrash(<AreaErrorBoundary area="toolbar"><Boom /></AreaErrorBoundary>);
    expect(escaped).toBe(boom);
    expect(crashAreaOf(boom)).toBe('toolbar');
    expect(document.body.textContent).toBe('');
  });

  it('keeps the innermost area when boundaries nest', () => {
    const escaped = renderCrash(
      <AreaErrorBoundary area="canvas">
        <div>
          <AreaErrorBoundary area="dialogs"><Boom /></AreaErrorBoundary>
        </div>
      </AreaErrorBoundary>,
    );
    expect(escaped).toBe(boom);
    expect(crashAreaOf(boom)).toBe('dialogs');
  });

  it('ignores what cannot be tagged', () => {
    tagCrashArea('a string', 'canvas');
    expect(crashAreaOf('a string')).toBeUndefined();
    expect(crashAreaOf(new Error('untagged'))).toBeUndefined();
  });
});

describe('installWebviewErrorReporting', () => {
  let report: ReturnType<typeof vi.fn>;
  let uninstall: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    report = vi.fn();
    uninstall = installWebviewErrorReporting(report, 'other');
  });

  afterEach(() => {
    uninstall();
    vi.useRealTimers();
  });

  const fireError = (error: unknown, message = 'x') => {
    window.dispatchEvent(new ErrorEvent('error', { error, message }));
    vi.advanceTimersByTime(1);
  };

  it('reports a tagged render crash once, by area, and never the text', () => {
    tagCrashArea(boom, 'detailPanel');
    fireError(boom, boom.message);
    fireError(boom, boom.message);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('render', 'detailPanel');
    expect(JSON.stringify(report.mock.calls)).not.toContain('secret');
  });

  it('reports an untagged error as a window error in the fallback area', () => {
    fireError(new Error('nope'));
    expect(report).toHaveBeenCalledWith('window', 'other');
  });

  it('drops ResizeObserver loop noise', () => {
    fireError(undefined, 'ResizeObserver loop completed with undelivered notifications.');
    fireError(new Error('ResizeObserver loop limit exceeded'), '');
    expect(report).not.toHaveBeenCalled();
  });

  it('reports an unhandled rejection', () => {
    window.dispatchEvent(new Event('unhandledrejection'));
    expect(report).toHaveBeenCalledWith('rejection', 'other');
  });

  it(`caps each kind at ${MAX_WEBVIEW_ERROR_REPORTS} per page`, () => {
    for (let i = 0; i < MAX_WEBVIEW_ERROR_REPORTS + 3; i++) fireError(new Error(`e${i}`));
    for (let i = 0; i < MAX_WEBVIEW_ERROR_REPORTS + 3; i++) window.dispatchEvent(new Event('unhandledrejection'));
    expect(report.mock.calls.filter(([k]) => k === 'window')).toHaveLength(MAX_WEBVIEW_ERROR_REPORTS);
    expect(report.mock.calls.filter(([k]) => k === 'rejection')).toHaveLength(MAX_WEBVIEW_ERROR_REPORTS);
  });

  it('never throws when the reporter does', () => {
    uninstall();
    uninstall = installWebviewErrorReporting(() => { throw new Error('post failed'); }, 'other');
    expect(() => fireError(new Error('x'))).not.toThrow();
  });

  it('hears the crash a boundary let escape from a real render', () => {
    const escaped = renderCrash(<AreaErrorBoundary area="canvas"><AreaErrorBoundary area="guide"><Boom /></AreaErrorBoundary></AreaErrorBoundary>);
    fireError(escaped);
    expect(report).toHaveBeenCalledWith('render', 'guide');
  });
});

describe('draft page crash reporting', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('posts pageError with the kind only, for a crash inside the draft boundary', () => {
    const posted: DraftToHost[] = [];
    const uninstall = reportDraftPageErrors({ post: (m) => posted.push(m) });
    try {
      const escaped = renderCrash(<AreaErrorBoundary area="draft"><Boom /></AreaErrorBoundary>);
      window.dispatchEvent(new ErrorEvent('error', { error: escaped, message: boom.message }));
      window.dispatchEvent(new Event('unhandledrejection'));
      vi.advanceTimersByTime(1);
      expect(posted).toEqual([
        { type: 'pageError', kind: 'rejection', area: 'draft' },
        { type: 'pageError', kind: 'render', area: 'draft' },
      ]);
    } finally {
      uninstall();
    }
  });
});

describe('the draft page fitted zoom', () => {
  it('reads React Flow viewport scale', () => {
    expect(zoomFromTransform('translate(10px, 20px) scale(0.25)')).toBe(0.25);
    expect(zoomFromTransform('translate(10px,20px) scale(1)')).toBe(1);
    expect(zoomFromTransform('translate(10px, 20px)')).toBeUndefined();
    expect(zoomFromTransform('scale(0)')).toBeUndefined();
    expect(zoomFromTransform(undefined)).toBeUndefined();
  });

  it('finds the viewport inside the canvas', () => {
    const main = document.createElement('main');
    main.innerHTML = '<div class="react-flow__viewport" style="transform: translate(1px, 2px) scale(0.12)"></div>';
    expect(fittedZoomOf(main)).toBeCloseTo(0.12);
    expect(fittedZoomOf(document.createElement('main'))).toBeUndefined();
    expect(fittedZoomOf(null)).toBeUndefined();
  });
});
