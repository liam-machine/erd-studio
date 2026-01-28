/**
 * Root application component for the semantic domain editor webview.
 *
 * Renders a React Flow canvas inside the custom editor. Communicates with the
 * extension host via the message bus to receive domain data and send user
 * actions. UI state (mode, selection, viewport) is managed by the Zustand
 * editor store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  SelectionMode,
  type Viewport,
  type NodeTypes,
  type EdgeTypes,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useMessageBus, type ExtensionMessage } from './hooks/useMessageBus';
import { usePositionPersistence } from './hooks/usePositionPersistence';
import { useStatePersistence } from './hooks/useStatePersistence';
import { useEditorStore } from './store/editorStore';
import { ModelNode } from './components/Graph/ModelNode';
import { FkEdge } from './components/Graph/FkEdge';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/Toolbar/StatusBar';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { Toast } from './components/Toast/Toast';
import { transformDomain } from './lib/graphTransformer';
import type { ModelFlowNode } from './types/graph';

// ---------------------------------------------------------------------------
// Inner component (must be inside ReactFlowProvider)
// ---------------------------------------------------------------------------

/** Custom node types for React Flow — must be memoised or stable. */
const nodeTypes: NodeTypes = { model: ModelNode };

/** Custom edge types for React Flow — must be memoised or stable. */
const edgeTypes: EdgeTypes = { fk: FkEdge };

function EditorCanvas() {
  const domain = useEditorStore((s) => s.domain);
  const error = useEditorStore((s) => s.error);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setDomain = useEditorStore((s) => s.setDomain);
  const setError = useEditorStore((s) => s.setError);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setNodes = useEditorStore((s) => s.setNodes);
  const setEdges = useEditorStore((s) => s.setEdges);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);

  // State persistence (zoom, pan, selection, mode, detail panel)
  const { shouldSkipFitView, invalidSelectedNode, persistedViewport } =
    useStatePersistence();
  const { setViewport: setReactFlowViewport } = useReactFlow();

  // Toast notification for invalid selection after restore
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (invalidSelectedNode) {
      setToastMessage(
        `Previously selected model "${invalidSelectedNode}" no longer exists.`,
      );
    }
  }, [invalidSelectedNode]);

  // Memoized callback for toast dismissal (prevents timer re-creation)
  const dismissToast = useCallback(() => setToastMessage(null), []);

  const onMessage = useCallback(
    (msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'domainLoaded':
          setDomain(msg.payload);
          break;
        case 'error':
          setError(msg.payload.message);
          break;
      }
    },
    [setDomain, setError],
  );

  useMessageBus(onMessage, /* sendReadyOnMount */ true);

  // Initialize nodes and edges when domain changes.
  useEffect(() => {
    if (domain) {
      const { nodes: newNodes, edges: newEdges } = transformDomain(domain);
      setNodes(newNodes);
      setEdges(newEdges);
    }
  }, [domain, setNodes, setEdges]);

  // Apply persisted viewport after nodes are loaded (React Flow needs nodes first)
  const hasAppliedViewportRef = useRef(false);
  useEffect(() => {
    if (nodes.length > 0 && persistedViewport && !hasAppliedViewportRef.current) {
      hasAppliedViewportRef.current = true;
      // Use setTimeout to ensure React Flow has finished rendering
      setTimeout(() => {
        setReactFlowViewport(persistedViewport);
      }, 0);
    }
  }, [nodes.length, persistedViewport, setReactFlowViewport]);

  // Position persistence and selection handling.
  const { onNodesChange } = usePositionPersistence();

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      setViewport(viewport);
    },
    [setViewport],
  );

  // Handle node clicks to open the detail panel.
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: ModelFlowNode) => {
      selectNode(node.id);
      setDetailPanelOpen(true);
    },
    [selectNode, setDetailPanelOpen],
  );

  // Close detail panel when multi-selecting (selection mismatch with single-node panel).
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      if (selectedNodes.length !== 1) {
        setDetailPanelOpen(false);
        selectNode(null);
      }
    },
    [selectNode, setDetailPanelOpen],
  );

  // --- Error state -----------------------------------------------------------

  if (error) {
    return (
      <div className="editor-message">
        <p style={{ color: 'var(--error-fg)' }}>Error: {error}</p>
      </div>
    );
  }

  // --- Loading state ---------------------------------------------------------

  if (!domain) {
    return (
      <div className="editor-message">
        <p>Loading domain&hellip;</p>
      </div>
    );
  }

  // --- Graph canvas ----------------------------------------------------------

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onSelectionChange={onSelectionChange}
        onMoveEnd={onMoveEnd}
        fitView={!shouldSkipFitView}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Toolbar nodes={nodes} edges={edges} />
        <StatusBar />
        <DetailPanel />
      </ReactFlow>

      {toastMessage && (
        <Toast message={toastMessage} variant="warning" onDismiss={dismissToast} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function App() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  );
}
