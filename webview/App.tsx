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
  MiniMap,
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
import { useVsCodeApi } from './hooks/useVsCodeApi';
import { useColumnExpansion, NODE_THRESHOLD } from './hooks/useColumnExpansion';
import { useEditorStore } from './store/editorStore';
import { ModelNode } from './components/Graph/ModelNode';
import { FkEdge } from './components/Graph/FkEdge';
import { DragLine } from './components/Graph/DragLine';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/Toolbar/StatusBar';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { NewModelDialog } from './components/NewModelDialog/NewModelDialog';
import { NewFkDialog } from './components/NewFkDialog/NewFkDialog';
import { AddExistingModelDialog } from './components/AddExistingModelDialog/AddExistingModelDialog';
import { Toast } from './components/Toast/Toast';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { Legend } from './components/Legend/Legend';
import { WelcomeModal } from './components/WelcomeModal/WelcomeModal';
import { transformDomain } from './lib/graphTransformer';
import {
  applyPalette,
  loadPersistedPalette,
  getPaletteColors,
} from './lib/colorPalettes';
import type { ModelFlowNode, FkFlowEdge } from './types/graph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build and show a toast notification for newly built models/relationships.
 */
function showBuiltNotification(
  models: string[],
  relationships: Array<{ fromModel: string; fromColumn: string; toModel: string; toColumn: string }>,
  setToastMessage: (msg: string) => void,
): void {
  const modelCount = models.length;
  const relCount = relationships.length;

  if (modelCount === 0 && relCount === 0) return;

  const parts: string[] = [];
  if (modelCount > 0) {
    parts.push(`Models: ${models.join(', ')}`);
  }
  if (relCount > 0) {
    parts.push(`${relCount} relationship${relCount > 1 ? 's' : ''}`);
  }
  setToastMessage(`Built: ${parts.join(' | ')}`);
}

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
  const selectedEdges = useEditorStore((s) => s.selectedEdges);
  const setSelectedEdges = useEditorStore((s) => s.setSelectedEdges);
  // Dialog state for Escape key handling
  const newModelDialogOpen = useEditorStore((s) => s.newModelDialogOpen);
  const newFkDialogOpen = useEditorStore((s) => s.newFkDialogOpen);
  const addExistingModelDialogOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const setNewFkDialogOpen = useEditorStore((s) => s.setNewFkDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const clearFkDialogPrefill = useEditorStore((s) => s.clearFkDialogPrefill);
  const clearFkDialogEditData = useEditorStore((s) => s.clearFkDialogEditData);
  // Context menu state
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);
  const contextMenu = useEditorStore((s) => s.contextMenu);
  // Search state (F402)
  const searchQuery = useEditorStore((s) => s.searchQuery);
  const focusSearchInput = useEditorStore((s) => s.focusSearchInput);
  // Legend state
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const setLegendOpen = useEditorStore((s) => s.setLegendOpen);
  // Palette state
  const paletteId = useEditorStore((s) => s.paletteId);
  const setPaletteId = useEditorStore((s) => s.setPaletteId);

  // VS Code API for sending messages directly (edge deletion)
  const vscode = useVsCodeApi();

  // F405: Column expansion state (ephemeral, resets on domain change)
  const { isExpanded, toggleExpansion, collapseAll, expandAll, allExpanded } = useColumnExpansion();

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

  // Initialize colour palette on mount
  useEffect(() => {
    const savedPalette = loadPersistedPalette();
    setPaletteId(savedPalette);
    applyPalette(savedPalette);
  }, [setPaletteId]);

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
          // F405: Auto-expand all columns if below node threshold for better UX
          if (msg.payload.models.length < NODE_THRESHOLD) {
            expandAll(msg.payload.models.map((m) => m.name));
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
          // Show toast notification for newly built models and relationships
          showBuiltNotification(
            msg.payload.newlyBuiltModels,
            msg.payload.newlyBuiltRelationships ?? [],
            setToastMessage,
          );
          break;
        case 'error':
          setError(msg.payload.message);
          break;
      }
    },
    [setDomain, setError, setTemplates, setManifestModels, setToastMessage, expandAll],
  );

  useMessageBus(onMessage, /* sendReadyOnMount */ true);

  // Unified keyboard shortcut handler (Escape, Delete/Backspace, Ctrl+F)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F / Cmd+F: Focus search input (F402)
      // This should work regardless of focus state
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        focusSearchInput();
        return;
      }

      // Shift+? : Toggle legend panel
      if (e.shiftKey && e.key === '?') {
        e.preventDefault();
        setLegendOpen(!legendOpen);
        return;
      }

      // Guard: Don't intercept if user is typing in an input field
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement
      ) {
        return;
      }

      // ESCAPE KEY: Close dialogs first, then deselect
      if (e.key === 'Escape') {
        e.preventDefault();

        // Close any open dialog (priority order)
        if (newModelDialogOpen) {
          setNewModelDialogOpen(false);
          return;
        }
        if (newFkDialogOpen) {
          setNewFkDialogOpen(false);
          clearFkDialogPrefill();
          clearFkDialogEditData();
          return;
        }
        if (addExistingModelDialogOpen) {
          setAddExistingModelDialogOpen(false);
          return;
        }

        // No dialogs open — deselect nodes and edges
        if (selectedNode || selectedEdges.length > 0) {
          selectNode(null);
          setDetailPanelOpen(false);
          setSelectedEdges([]);
        }
        return;
      }

      // DELETE KEY: Delete selected design models or edges
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!domain) return;

        // Priority 1: Remove selected node (with confirmation)
        if (selectedNode) {
          const model = domain.models.find((m) => m.name === selectedNode);
          if (model) {
            if (model.status === 'design' || model.status === 'built') {
              e.preventDefault();
              // Open detail panel if closed and trigger confirmation mode
              if (!detailPanelOpen) {
                setDetailPanelOpen(true);
              }
              setPendingDeleteConfirmation(true);
              return;
            } else {
              // Missing model — show toast
              e.preventDefault();
              setToastMessage('Cannot remove missing models');
              return;
            }
          }
        }

        // Priority 2: Delete selected edges (no confirmation, immediate)
        if (selectedEdges.length > 0) {
          e.preventDefault();
          let deletedCount = 0;
          let builtCount = 0;

          for (const edgeId of selectedEdges) {
            // Find the relationship in domain data by edge ID
            const rel = domain.relationships.find((r) => {
              const expectedId = `fk-${r.fromModel}-${r.fromColumn}-${r.toModel}-${r.toColumn}`;
              return expectedId === edgeId;
            });

            if (!rel) continue;

            if (rel.status === 'design') {
              // Delete design relationship immediately
              vscode.postMessage({
                type: 'removeRelationship',
                payload: {
                  fromModel: rel.fromModel,
                  fromColumn: rel.fromColumn,
                  toModel: rel.toModel,
                  toColumn: rel.toColumn,
                },
              });
              deletedCount++;
            } else {
              builtCount++;
            }
          }

          // Show toast feedback
          if (builtCount > 0 && deletedCount === 0) {
            setToastMessage('Cannot delete built relationships');
          } else if (builtCount > 0 && deletedCount > 0) {
            setToastMessage(`Deleted ${deletedCount} design relationship(s). Cannot delete ${builtCount} built relationship(s).`);
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedNode,
    selectedEdges,
    domain,
    detailPanelOpen,
    newModelDialogOpen,
    newFkDialogOpen,
    addExistingModelDialogOpen,
    setDetailPanelOpen,
    setPendingDeleteConfirmation,
    setNewModelDialogOpen,
    setNewFkDialogOpen,
    setAddExistingModelDialogOpen,
    clearFkDialogPrefill,
    clearFkDialogEditData,
    selectNode,
    setSelectedEdges,
    setToastMessage,
    focusSearchInput,
    legendOpen,
    setLegendOpen,
    // Note: vscode is omitted as it's a stable ref from useVsCodeApi
  ]);

  // Get current selectedNode from store to preserve selection across domain updates
  const currentSelectedNode = useEditorStore((s) => s.selectedNode);

  // Initialize nodes and edges when domain changes.
  // Preserve visual selection if the selected node still exists.
  // Clear stale edge selections that no longer exist.
  // Apply search dimming (F402), selection dimming, and column expansion (F405).
  useEffect(() => {
    if (domain) {
      let { nodes: newNodes, edges: newEdges } = transformDomain(domain);

      // Compute connected nodes for selection dimming.
      // When a node is selected, only the selected node and its direct neighbors stay bright.
      const connectedNodeIds = new Set<string>();
      if (currentSelectedNode) {
        connectedNodeIds.add(currentSelectedNode);
        // Find all nodes connected to the selected node via edges
        newEdges.forEach((edge) => {
          if (edge.data) {
            if (edge.data.fromModel === currentSelectedNode) {
              connectedNodeIds.add(edge.data.toModel);
            }
            if (edge.data.toModel === currentSelectedNode) {
              connectedNodeIds.add(edge.data.fromModel);
            }
          }
        });
      }

      // F402: Search dimming + selection dimming (additive)
      // F405: Inject column expansion state into node data
      const query = searchQuery.trim() ? searchQuery.toLowerCase() : '';
      newNodes = newNodes.map((node) => {
        const searchDimmed = query ? !node.data.modelName.toLowerCase().includes(query) : false;
        const selectionDimmed = currentSelectedNode !== null && !connectedNodeIds.has(node.id);

        return {
          ...node,
          data: {
            ...node.data,
            // Node is dimmed if either search doesn't match OR it's not connected to selection
            dimmed: searchDimmed || selectionDimmed,
            // F405: Column expansion (ephemeral state)
            // Pass stable toggleExpansion reference — ModelNode calls it with its own modelName
            isExpanded: isExpanded(node.id),
            onToggleExpansion: toggleExpansion,
          },
        };
      });

      // Apply selection dimming to edges.
      // An edge is bright only if both endpoints are in the connected set.
      newEdges = newEdges.map((edge) => ({
        ...edge,
        data: edge.data ? {
          ...edge.data,
          dimmed: currentSelectedNode !== null &&
            (!connectedNodeIds.has(edge.data.fromModel) || !connectedNodeIds.has(edge.data.toModel)),
        } : edge.data,
      }));

      // If we have a selected node, preserve the selection in the new nodes
      if (currentSelectedNode) {
        const selectedIdx = newNodes.findIndex((n) => n.id === currentSelectedNode);
        if (selectedIdx !== -1) {
          newNodes[selectedIdx] = { ...newNodes[selectedIdx], selected: true };
        }
      }

      // Clear stale edge selections (edges that no longer exist after domain update)
      if (selectedEdges.length > 0) {
        const newEdgeIds = new Set(newEdges.map((e) => e.id));
        const validEdges = selectedEdges.filter((id) => newEdgeIds.has(id));
        if (validEdges.length !== selectedEdges.length) {
          setSelectedEdges(validEdges);
        }
      }

      setNodes(newNodes);
      setEdges(newEdges);
    }
  }, [domain, setNodes, setEdges, setSelectedEdges, selectedEdges, currentSelectedNode, searchQuery, isExpanded, toggleExpansion]);

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
  // Also track edge selection for keyboard shortcuts.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdgesInFlow }) => {
      // Track edge selection in store for keyboard shortcuts
      setSelectedEdges(selectedEdgesInFlow.map((e) => e.id));

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
    [selectNode, setDetailPanelOpen, setSelectedEdges, currentSelectedNode, domain],
  );

  // Handle long-press column drag to create relationships.
  // Listens for custom events dispatched by ColumnRow in ModelNode.
  useEffect(() => {
    const handleColumnRelationshipDrop = (e: Event) => {
      const { fromModel, fromColumn, toModel, toColumn } = (e as CustomEvent).detail;
      openFkDialogWithPrefill({ fromModel, fromColumn, toModel, toColumn });
    };

    const handleColumnRelationshipSelfDrop = () => {
      setToastMessage('Cannot create relationship from a model to itself');
    };

    window.addEventListener('column-relationship-drop', handleColumnRelationshipDrop);
    window.addEventListener('column-relationship-self-drop', handleColumnRelationshipSelfDrop);

    return () => {
      window.removeEventListener('column-relationship-drop', handleColumnRelationshipDrop);
      window.removeEventListener('column-relationship-self-drop', handleColumnRelationshipSelfDrop);
    };
  }, [openFkDialogWithPrefill, setToastMessage]);

  // Handle right-click on edges to show context menu (F401)
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: FkFlowEdge) => {
      event.preventDefault();
      if (edge.data) {
        openEdgeContextMenu(event.clientX, event.clientY, edge.data);
      }
    },
    [openEdgeContextMenu],
  );

  // Close context menu on pane click
  const handlePaneClick = useCallback(() => {
    closeContextMenu();
    onPaneClick();
  }, [closeContextMenu, onPaneClick]);

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
        onPaneClick={handlePaneClick}
        onSelectionChange={onSelectionChange}
        onMoveEnd={onMoveEnd}
        onEdgeContextMenu={onEdgeContextMenu}
        fitView={!shouldSkipFitView}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <MiniMap
          position="bottom-right"
          nodeColor={(node) => {
            const status = node.data?.status;
            const colors = getPaletteColors(paletteId);
            if (status === 'built') return colors.modelBuilt;
            if (status === 'design') return colors.modelDesign;
            if (status === 'missing') return colors.modelMissing;
            return colors.modelMissing;
          }}
          maskColor="rgba(0, 0, 0, 0.2)"
          style={{
            background: 'var(--panel-bg)',
            border: '1px solid var(--panel-border)',
            borderRadius: '4px',
          }}
        />
        <Toolbar
          nodes={nodes}
          edges={edges}
          allExpanded={allExpanded}
          onExpandAll={() => expandAll(nodes.map((n) => n.id))}
          onCollapseAll={collapseAll}
        />
        <StatusBar />
        <DetailPanel />
        <NewModelDialog />
        <NewFkDialog />
        <AddExistingModelDialog />
      </ReactFlow>

      {toastMessage && (
        <Toast message={toastMessage} variant="warning" onDismiss={dismissToast} />
      )}

      {/* Drag line for column relationship creation */}
      <DragLine />

      {/* Edge context menu (F401) */}
      {contextMenu && <ContextMenu />}

      {/* Legend panel (bottom-left) */}
      <Legend />

      {/* Welcome modal (first-time users) */}
      <WelcomeModal />
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
