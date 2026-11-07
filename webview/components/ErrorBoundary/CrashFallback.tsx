/**
 * The crash screen (ERD Studio 2.0): what a webview shows when something in
 * it throws while rendering, instead of the blank panel React leaves behind.
 * Shared by the canvas (`webview/index.tsx`) and the draft page
 * (`webview-draft/index.tsx`), each of which says what its two buttons post.
 *
 * {@link CrashFallbackBoundary} wraps the whole page, outside every area
 * boundary: those tag the crash's area and rethrow it, and this one catches
 * it, reports its kind and area for usage telemetry (never its text:
 * `reportCaughtRenderCrash`), and draws {@link CrashFallback}. The screen says
 * in plain words that the problem is ERD Studio's, not the user's files, and
 * offers Reload (the host reloads the panel) and Send Feedback (the host opens
 * the existing Send Feedback flow, prefilled with the crash's first line, paths
 * reduced to their shape, for the user to read before anything is sent).
 *
 * The canvas's in-page Feedback dialog is not used here: it lived in the tree
 * that just crashed, and may be what crashed.
 */

import { Component, useState, type ErrorInfo, type ReactNode } from 'react';

import { crashAreaOf, reportCaughtRenderCrash } from '../../lib/webviewErrors';
import { redactPaths } from '../../../src/types/feedback';
import { crashDetailOf, isWebviewErrorArea, type WebviewErrorArea } from '../../../src/types/webviewError';

import './CrashFallback.css';

/** What the screen knows of the crash: where it started and its first line, paths already redacted. */
export interface CaughtCrash {
  /** The innermost canvas area it started in (absent: outside every area, or the draft page). */
  area?: WebviewErrorArea;
  /** The error's first line, through `redactPaths` and cut to `CRASH_DETAIL_MAX`. Empty when it had none. */
  detail: string;
}

/** Turn a caught error into what the screen may hold (never the stack). */
export function caughtCrashOf(error: unknown): CaughtCrash {
  const area = crashAreaOf(error);
  return {
    ...(isWebviewErrorArea(area) ? { area } : {}),
    detail: redactPaths(crashDetailOf(error)),
  };
}

interface CrashFallbackBoundaryProps {
  /** The screen to draw for a caught crash. */
  fallback: (crash: CaughtCrash) => ReactNode;
  children?: ReactNode;
}

interface CrashFallbackBoundaryState {
  crash: CaughtCrash | undefined;
}

export class CrashFallbackBoundary extends Component<CrashFallbackBoundaryProps, CrashFallbackBoundaryState> {
  state: CrashFallbackBoundaryState = { crash: undefined };

  static getDerivedStateFromError(error: unknown): CrashFallbackBoundaryState {
    return { crash: caughtCrashOf(error) };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    // A caught crash never reaches the window's listeners in a production build.
    reportCaughtRenderCrash(error);
  }

  render(): ReactNode {
    const { crash } = this.state;
    return crash ? this.props.fallback(crash) : this.props.children;
  }
}

export interface CrashFallbackProps {
  /** Which page crashed: the words differ a little (a draft has written nothing yet). */
  surface: 'canvas' | 'draft';
  /** Reload the panel (the host does it). */
  onReload: () => void;
  /** Open Send Feedback (the host does it). */
  onSendFeedback: () => void;
}

/** The crash screen itself: plain words and two buttons. */
export function CrashFallback({ surface, onReload, onSendFeedback }: CrashFallbackProps) {
  const [reloading, setReloading] = useState(false);
  const what = surface === 'draft' ? 'The draft preview' : 'This diagram';
  return (
    <div className="crash-fallback" role="alert">
      <div className="crash-fallback__panel">
        <p className="crash-fallback__title">{what} stopped working</p>
        <p className="crash-fallback__body">
          This is a problem in ERD Studio, not in your files.{' '}
          {surface === 'draft'
            ? 'Nothing has been written yet.'
            : 'Nothing in your files was changed.'}
        </p>
        <p className="crash-fallback__body">
          Reload to carry on. If it happens again, please send us a report so we can fix it.
        </p>
        <div className="crash-fallback__actions">
          <button
            type="button"
            className="crash-fallback__button"
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              onReload();
            }}
          >
            {reloading ? 'Reloading…' : 'Reload'}
          </button>
          <button
            type="button"
            className="crash-fallback__button crash-fallback__button--secondary"
            onClick={onSendFeedback}
          >
            Send Feedback
          </button>
        </div>
      </div>
    </div>
  );
}
