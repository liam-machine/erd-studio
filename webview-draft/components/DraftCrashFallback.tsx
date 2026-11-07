/**
 * The draft page's crash screen: the shared {@link CrashFallback} whose
 * buttons post the passive `crashFallback` (`src/types/draft.ts`). The
 * preview reloads the page for Reload; the wiring opens Send Feedback,
 * prefilled with the crash's redacted first line. Neither closes the tab or
 * answers the flow that is waiting on the draft.
 */

import { CrashFallback, type CaughtCrash } from '../../webview/components/ErrorBoundary/CrashFallback';
import type { DraftHost } from '../lib/draftHost';

export function DraftCrashFallback({ host, crash }: { host: DraftHost; crash: CaughtCrash }) {
  return (
    <CrashFallback
      surface="draft"
      onReload={() => host.post({ type: 'crashFallback', action: 'reload' })}
      onSendFeedback={() =>
        host.post({ type: 'crashFallback', action: 'feedback', ...(crash.detail ? { detail: crash.detail } : {}) })
      }
    />
  );
}
