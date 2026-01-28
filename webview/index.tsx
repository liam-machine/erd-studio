import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element not found. Expected <div id="root"></div> in webview HTML.');
}

const root = createRoot(container);
root.render(<App />);
