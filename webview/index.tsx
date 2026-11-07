import { createRoot } from 'react-dom/client';
import { App } from './App';
import { getVsCodeApi } from './hooks/useVsCodeApi';
import { installWebviewErrorReporting } from './lib/webviewErrors';
import { CrashFallbackBoundary } from './components/ErrorBoundary/CrashFallback';
import { CanvasCrashFallback } from './components/ErrorBoundary/CanvasCrashFallback';
import type { WebviewMessage } from '../src/types/messages';
// The extension builds @erd-studio/renderer from its workspace source (not its
// published dist/), so the renderer's stylesheet is imported by path here, in
// the same place in the cascade as before: last, after every component's CSS.
import '../packages/renderer/src/styles/theme.css';
// Page sizing for the webview (html/body/#root). Must come after theme.css.
import './styles/host.css';

// Usage telemetry (2.0 B13): a crash's kind and area go to the host, never
// its text. Installed before the first render, outside React, so an error
// React rethrows after unmounting the tree is still heard; a render crash is
// caught by the root boundary below, which reports it and shows the crash
// screen instead of a blank panel.
installWebviewErrorReporting((kind, area) => {
  const message: WebviewMessage = { type: 'webviewError', payload: { kind, area: area === 'draft' ? 'other' : area } };
  getVsCodeApi().postMessage(message);
}, 'other');

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found. Expected <div id="root"></div> in webview HTML.');
}

const root = createRoot(container);
// The crash screen (2.0): a render crash anywhere in the canvas shows plain
// words and Reload / Send Feedback, not a blank panel.
root.render(
  <CrashFallbackBoundary fallback={(crash) => <CanvasCrashFallback crash={crash} />}>
    <App />
  </CrashFallbackBoundary>,
);
