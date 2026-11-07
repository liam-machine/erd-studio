/**
 * The draft page's crash reporting (usage telemetry, 2.0 B13): the canvas's
 * listeners (`webview/lib/webviewErrors.ts`) posting the passive `pageError`
 * with the kind only. The page looks the same as before: nothing is shown.
 */

import { installWebviewErrorReporting } from '../../webview/lib/webviewErrors';
import type { DraftHost } from './draftHost';

/** Report the page's crashes, uncaught errors and unhandled rejections to `host`; returns the uninstaller. */
export function reportDraftPageErrors(host: DraftHost, target?: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  return installWebviewErrorReporting((kind) => host.post({ type: 'pageError', kind, area: 'draft' }), 'draft', target);
}
