import { ReactFlowProvider } from '@xyflow/react';

export function App() {
  return (
    <ReactFlowProvider>
      <div style={{ width: '100%', height: '100vh' }}>
        <p>dbt Semantic Designer — webview loaded</p>
      </div>
    </ReactFlowProvider>
  );
}
