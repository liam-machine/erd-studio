/**
 * An area of a webview, for crash reporting only (ERD Studio 2.0 B13). When
 * something inside it throws while rendering, it tags the error with its
 * area (`webview/lib/webviewErrors.ts`; the innermost boundary's tag wins)
 * and rethrows it: this boundary draws nothing of its own. The page's root
 * `CrashFallbackBoundary` (`CrashFallback.tsx`) catches it, reports the
 * crash's kind and area to the host (never its text) and shows the crash
 * screen.
 */

import { Component, type ReactNode } from 'react';

import { tagCrashArea } from '../../lib/webviewErrors';
import type { WebviewCrashArea } from '../../../src/types/webviewError';

interface AreaErrorBoundaryProps {
  area: WebviewCrashArea;
  children?: ReactNode;
}

interface AreaErrorBoundaryState {
  failed: boolean;
  error: unknown;
}

export class AreaErrorBoundary extends Component<AreaErrorBoundaryProps, AreaErrorBoundaryState> {
  state: AreaErrorBoundaryState = { failed: false, error: undefined };

  static getDerivedStateFromError(error: unknown): AreaErrorBoundaryState {
    return { failed: true, error };
  }

  render(): ReactNode {
    if (this.state.failed) {
      tagCrashArea(this.state.error, this.props.area);
      // No fallback here: the error goes on up to the page's root boundary.
      throw this.state.error;
    }
    return this.props.children;
  }
}
