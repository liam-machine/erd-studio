/**
 * Root application component for the semantic domain editor webview.
 *
 * Renders a React Flow canvas inside the custom editor. Communicates with the
 * extension host via the message bus to receive domain data and send user
 * actions. UI state (mode, selection, viewport) is managed by the Zustand
 * editor store.
 */

import { useCallback } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  type Viewport,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useMessageBus, type ExtensionMessage } from './hooks/useMessageBus';
import { useEditorStore } from './store/editorStore';
import { ModelNode } from './components/Graph/ModelNode';
import { FkEdge } from './components/Graph/FkEdge';

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
  const setDomain = useEditorStore((s) => s.setDomain);
  const setError = useEditorStore((s) => s.setError);
  const setViewport = useEditorStore((s) => s.setViewport);

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

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      setViewport(viewport);
    },
    [setViewport],
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

  // DEV MOCK DATA — renders test nodes and edges for visual development.
  // Remove once the graph transformer (F108) is implemented.
  const mockNodes = [
    {
      id: 'dim_work_lot',
      type: 'model' as const,
      position: { x: 350, y: 100 },
      data: {
        modelName: 'dim_work_lot',
        status: 'built' as const,
        layer: 'silver' as const,
        columns: [
          { name: 'work_lot_id', dataType: 'INT', isPrimaryKey: true, isForeignKey: false },
          { name: 'project_id', dataType: 'INT', isPrimaryKey: false, isForeignKey: true },
          { name: 'name', dataType: 'VARCHAR', isPrimaryKey: false, isForeignKey: false },
        ],
      },
    },
    {
      id: 'dim_project',
      type: 'model' as const,
      position: { x: 50, y: 100 },
      data: {
        modelName: 'dim_project',
        status: 'built' as const,
        layer: 'silver' as const,
        columns: [
          { name: 'project_id', dataType: 'INT', isPrimaryKey: true, isForeignKey: false },
          { name: 'name', dataType: 'VARCHAR', isPrimaryKey: false, isForeignKey: false },
        ],
      },
    },
    {
      id: 'dim_work_lot_status',
      type: 'model' as const,
      position: { x: 350, y: 400 },
      data: {
        modelName: 'dim_work_lot_status',
        status: 'design' as const,
        layer: 'silver' as const,
        columns: [
          { name: 'work_lot_status_id', dataType: 'INT', isPrimaryKey: true, isForeignKey: false },
          { name: 'work_lot_id', dataType: 'INT', isPrimaryKey: false, isForeignKey: true },
        ],
      },
    },
    {
      id: 'brg_lot_contractor',
      type: 'model' as const,
      position: { x: 700, y: 250 },
      data: {
        modelName: 'brg_lot_contractor',
        status: 'design' as const,
        layer: 'silver' as const,
        columns: [
          { name: 'bridge_id', dataType: 'INT', isPrimaryKey: true, isForeignKey: false },
          { name: 'work_lot_id', dataType: 'INT', isPrimaryKey: false, isForeignKey: true },
        ],
      },
    },
  ];

  // Edges use node-level handles (node-{side}-src / node-{side}-tgt) and
  // pick the side that creates the least bends based on relative positions.
  const mockEdges = [
    {
      id: 'edge-1',
      type: 'fk' as const,
      source: 'dim_work_lot',
      target: 'dim_project',
      sourceHandle: 'node-left-src',
      targetHandle: 'node-right-tgt',
      data: {
        fromModel: 'dim_work_lot',
        fromColumn: 'project_id',
        toModel: 'dim_project',
        toColumn: 'project_id',
        cardinality: 'many-to-one' as const,
        status: 'built' as const,
      },
    },
    {
      id: 'edge-2',
      type: 'fk' as const,
      source: 'dim_work_lot_status',
      target: 'dim_work_lot',
      sourceHandle: 'node-top-src',
      targetHandle: 'node-bottom-tgt',
      data: {
        fromModel: 'dim_work_lot_status',
        fromColumn: 'work_lot_id',
        toModel: 'dim_work_lot',
        toColumn: 'work_lot_id',
        cardinality: 'many-to-one' as const,
        status: 'design' as const,
      },
    },
    {
      id: 'edge-3',
      type: 'fk' as const,
      source: 'brg_lot_contractor',
      target: 'dim_work_lot',
      sourceHandle: 'node-left-src',
      targetHandle: 'node-right-tgt',
      data: {
        fromModel: 'brg_lot_contractor',
        fromColumn: 'work_lot_id',
        toModel: 'dim_work_lot',
        toColumn: 'work_lot_id',
        cardinality: 'one-to-one' as const,
        status: 'design' as const,
      },
    },
  ];

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={mockNodes}
        edges={mockEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onMoveEnd={onMoveEnd}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
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
