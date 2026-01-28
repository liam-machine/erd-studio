import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';

/** VS Code API handle — acquired once per webview lifecycle. */
const vscode = (window as any).acquireVsCodeApi();

export function App() {
  const [domainName, setDomainName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const message = event.data;
      switch (message.type) {
        case 'domainLoaded':
          setDomainName(message.payload?.domain ?? 'unknown');
          setError(null);
          break;
        case 'error':
          setError(message.payload?.message ?? 'Unknown error');
          break;
      }
    }

    window.addEventListener('message', handleMessage);

    // Signal to extension host that the webview is ready for data.
    vscode.postMessage({ type: 'ready' });

    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100vh', padding: '16px' }}>
        {error ? (
          <p style={{ color: 'var(--vscode-errorForeground)' }}>Error: {error}</p>
        ) : domainName ? (
          <p>Semantic Domain: <strong>{domainName}</strong></p>
        ) : (
          <p>Loading domain…</p>
        )}
      </div>
    </ReactFlowProvider>
  );
}
