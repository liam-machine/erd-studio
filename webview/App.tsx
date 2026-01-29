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
  type Connection,
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
import { NewModelDialog } from './components/NewModelDialog/NewModelDialog';
import { NewFkDialog } from './components/NewFkDialog/NewFkDialog';
import { AddExistingModelDialog } from './components/AddExistingModelDialog/AddExistingModelDialog';
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
  const setTemplates = useEditorStore((s) => s.setTemplates);
  const setManifestModels = useEditorStore((s) => s.setManifestModels);
  const openFkDialogWithPrefill = useEditorStore((s) => s.openFkDialogWithPrefill);
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const setPendingDeleteConfirmation = useEditorStore((s) => s.setPendingDeleteConfirmation);

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
          // Extract and store templates from the payload
          if (msg.payload.templates) {
            setTemplates(msg.payload.templates);
          }
          // Extract and store manifest models for "Add Existing Model" dialog
          if (msg.payload.manifestModels) {
            setManifestModels(msg.payload.manifestModels);
          }
          break;
        case 'manifestRefreshed':
          // F304: Auto-reconciliation detected design models that are now built
          setDomain(msg.payload.domain);
          if (msg.payload.domain.templates) {
            setTemplates(msg.payload.domain.templates);
          }
          if (msg.payload.domain.manifestModels) {
            setManifestModels(msg.payload.domain.manifestModels);
          }
          // Show toast notification for newly built models
          if (msg.payload.newlyBuiltModels.length > 0) {
            const modelNames = msg.payload.newlyBuiltModels.join(', ');
            setToastMessage(`Models built: ${modelNames}`);
          }
          break;
        case 'error':
          setError(msg.payload.message);
          break;
      }
    },
    [setDomain, setError, setTemplates, setManifestModels, setToastMessage],
  );

  useMessageBus(onMessage, /* sendReadyOnMount */ true);

  // Handle Delete key to delete selected design model
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle Delete/Backspace when a node is selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNode && domain) {
        // Check if user is typing in an input field
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement ||
          activeElement instanceof HTMLSelectElement
        ) {
          return; // Don't intercept if user is editing
        }

        // Find the selected model
        const model = domain.models.find((m) => m.name === selectedNode);
        if (!model || model.status !== 'design') {
          return; // Only allow delete for design models
        }

        // Prevent default browser behavior
        e.preventDefault();

        // Open detail panel if closed and trigger confirmation mode
        if (!detailPanelOpen) {
          setDetailPanelOpen(true);
        }
        // Signal to DetailPanel to show confirmation immediately
        setPendingDeleteConfirmation(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNode, domain, detailPanelOpen, setDetailPanelOpen, setPendingDeleteConfirmation]);

  // Get current selectedNode from store to preserve selection across domain updates
  const currentSelectedNode = useEditorStore((s) => s.selectedNode);

  // Initialize nodes and edges when domain changes.
  // Preserve visual selection if the selected node still exists.
  useEffect(() => {
    if (domain) {
      const { nodes: newNodes, edges: newEdges } = transformDomain(domain);

      // If we have a selected node, preserve the selection in the new nodes
      if (currentSelectedNode) {
        const selectedIdx = newNodes.findIndex((n) => n.id === currentSelectedNode);
        if (selectedIdx !== -1) {
          newNodes[selectedIdx] = { ...newNodes[selectedIdx], selected: true };
        }
      }

      setNodes(newNodes);
      setEdges(newEdges);
    }
  }, [domain, setNodes, setEdges, currentSelectedNode]);

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

  // Handle clicks on blank canvas to close the detail panel and clear selection.
  const onPaneClick = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
  }, [setDetailPanelOpen, selectNode]);

  // Close detail panel when multi-selecting (selection mismatch with single-node panel).
  // But don't close if the selection reset was caused by a domain update (nodes recreated).
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes }) => {
      if (selectedNodes.length !== 1) {
        // Check if our stored selection still exists in the domain
        // If so, this is likely a domain update, not a user deselection
        if (currentSelectedNode && domain?.models.some((m) => m.name === currentSelectedNode)) {
          // Keep the panel open - the node still exists, selection was just reset by React Flow
          return;
        }
        setDetailPanelOpen(false);
        selectNode(null);
      }
    },
    [selectNode, setDetailPanelOpen, currentSelectedNode, domain],
  );

  // Handle drag-to-connect from column handles to open the FK dialog.
  const onConnect = useCallback(
    (connection: Connection) => {
      // Only handle connections from column-level source handles
      if (!connection.source || !connection.target || !connection.sourceHandle) {
        return;
      }

      // Parse source handle ID (format: "col-{sanitized_name}-right")
      const sourceMatch = connection.sourceHandle.match(/^col-(.+)-right$/);
      if (!sourceMatch) {
        // Not a column handle, ignore (node-level handles shouldn't trigger connections)
        return;
      }

      const fromModel = connection.source; // Node ID is model name
      const toModel = connection.target;

      // Prevent self-reference (would fail validation anyway, but show toast immediately)
      if (fromModel === toModel) {
        setToastMessage('Cannot create relationship from a model to itself');
        return;
      }

      // Look up the original source column name from the domain data.
      // The handle ID is sanitized (special chars → underscores), so we need to find
      // the column whose sanitized name matches. Fallback to sanitized version if not found.
      const sanitizedSourceColumn = sourceMatch[1];
      const sourceModel = domain?.models.find((m) => m.name === fromModel);
      const originalSourceColumn = sourceModel?.columns.find(
        (c) => c.name.replace(/[^a-zA-Z0-9_-]/g, '_') === sanitizedSourceColumn,
      );
      const fromColumn = originalSourceColumn?.name ?? sanitizedSourceColumn;

      // Check if user dropped on a target column handle (format: "col-{sanitized_name}-left")
      let toColumn: string | undefined;
      if (connection.targetHandle) {
        const targetMatch = connection.targetHandle.match(/^col-(.+)-left$/);
        if (targetMatch) {
          const sanitizedTargetColumn = targetMatch[1];
          const targetModel = domain?.models.find((m) => m.name === toModel);
          const originalTargetColumn = targetModel?.columns.find(
            (c) => c.name.replace(/[^a-zA-Z0-9_-]/g, '_') === sanitizedTargetColumn,
          );
          toColumn = originalTargetColumn?.name ?? sanitizedTargetColumn;
        }
      }

      // Open the FK dialog with prefilled source and target
      openFkDialogWithPrefill({ fromModel, fromColumn, toModel, toColumn });
    },
    [openFkDialogWithPrefill, setToastMessage, domain],
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
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        onMoveEnd={onMoveEnd}
        onConnect={onConnect}
        fitView={!shouldSkipFitView}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{
          stroke: 'var(--edge-design)',
          strokeWidth: 2,
          strokeDasharray: '6 3',
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Toolbar nodes={nodes} edges={edges} />
        <StatusBar />
        <DetailPanel />
        <NewModelDialog />
        <NewFkDialog />
        <AddExistingModelDialog />
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
