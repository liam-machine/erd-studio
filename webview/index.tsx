import { createRoot } from 'react-dom/client';
import { App } from './App';
// The extension builds @erd-studio/renderer from its workspace source (not its
// published dist/), so the renderer's stylesheet is imported by path here, in
// the same place in the cascade as before: last, after every component's CSS.
import '../packages/renderer/src/styles/theme.css';
// Page sizing for the webview (html/body/#root). Must come after theme.css.
import './styles/host.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found. Expected <div id="root"></div> in webview HTML.');
}

const root = createRoot(container);
root.render(<App />);
