import React from 'react';
import { createRoot } from 'react-dom/client';
import ConfigPanel from './ConfigPanel';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <ConfigPanel />
  </React.StrictMode>
);
