/**
 * The draft preview page's entry (`dist/draft.js` + `dist/draft.css`), shown
 * by `src/providers/DraftPreviewPanel.ts` under a nonce-only CSP.
 */

import { createRoot } from 'react-dom/client';
import { DraftApp } from './DraftApp';
import { getDraftHost } from './lib/draftHost';
import { reportDraftPageErrors } from './lib/pageErrors';
import { AreaErrorBoundary } from '../webview/components/ErrorBoundary/AreaErrorBoundary';
import { DraftCrashFallback } from './components/DraftCrashFallback';
import { CrashFallbackBoundary } from '../webview/components/ErrorBoundary/CrashFallback';
// The renderer's stylesheet (built from source, as webview/index.tsx does), then the page's own.
import '../packages/renderer/src/styles/theme.css';
import './styles/draft.css';

// The page has no 'unsafe-inline': if anything tries an inline style or
// script, say so loudly rather than draw a half-styled canvas in silence.
document.addEventListener('securitypolicyviolation', (event) => {
  console.error(`[draft] Content-Security-Policy blocked ${event.violatedDirective} (${event.blockedURI || 'inline'}).`);
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found. Expected <div id="root"></div> in the draft preview HTML.');
}

const host = getDraftHost();
// Usage telemetry (2.0 B13): the kind of a crash, never its text. Installed
// outside React so an error rethrown after the tree unmounts is heard; the
// area boundary tags a render crash and the root boundary catches it,
// reports it and shows the crash screen (Reload / Send Feedback) instead of
// a blank page.
reportDraftPageErrors(host);

createRoot(container).render(
  <CrashFallbackBoundary fallback={(crash) => <DraftCrashFallback host={host} crash={crash} />}>
    <AreaErrorBoundary area="draft">
      <DraftApp host={host} />
    </AreaErrorBoundary>
  </CrashFallbackBoundary>,
);
