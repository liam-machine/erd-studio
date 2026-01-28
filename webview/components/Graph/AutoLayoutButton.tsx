/**
 * AutoLayoutButton — triggers ELK auto-layout on the graph canvas.
 *
 * Renders as a floating button inside a React Flow `<Panel>` overlay.
 * On click, runs the ELK layered layout algorithm in a Web Worker,
 * then updates node positions optimistically in the store and sends
 * the new positions to the extension host for JSON persistence.
 *
 * Shows an inline confirmation prompt before replacing existing positions.
 * (VS Code webviews block `window.confirm()`, so we use in-panel UI.)
 */

import { useState, useCallback } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { useEditorStore } from '../../store/editorStore';
import { runElkLayout } from '../../lib/elkLayout';
import type { ModelFlowNode, FkFlowEdge } from '../../types/graph';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './AutoLayoutButton.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AutoLayoutButtonProps {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AutoLayoutButton({ nodes, edges }: AutoLayoutButtonProps) {
  const vscode = useVsCodeApi();
  const { fitView } = useReactFlow();
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);
  const [isLayouting, setIsLayouting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const runLayout = useCallback(async () => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }

    setConfirming(false);
    setIsLayouting(true);

    try {
      const positions = await runElkLayout(
        nodes,
        edges,
        domain.viewConfig.layoutOptions,
      );

      // Optimistic update: update domain in store so React Flow re-renders
      // with the new positions via transformDomain().
      const updatedDomain = {
        ...domain,
        viewConfig: {
          ...domain.viewConfig,
          positions,
        },
      };
      setDomain(updatedDomain);

      // Wait one frame for React to flush the new positions, then fit the
      // viewport so the re-laid-out graph is fully visible.
      requestAnimationFrame(() => {
        fitView({ padding: 0.1 });
      });

      // Persist to the extension host (writes to JSON via WorkspaceEdit).
      const message: WebviewMessage = {
        type: 'updatePositions',
        payload: { positions },
      };
      vscode.postMessage(message);
    } catch (err) {
      console.error('[AutoLayoutButton] Layout failed:', err);
    } finally {
      setIsLayouting(false);
    }
  }, [domain, nodes, edges, isLayouting, setDomain, fitView, vscode]);

  const handleClick = useCallback(() => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }

    // If positions already exist, show inline confirmation first.
    const existingPositions = domain.viewConfig.positions ?? {};
    const hasPositions = Object.keys(existingPositions).length > 0;

    if (hasPositions) {
      setConfirming(true);
    } else {
      runLayout();
    }
  }, [domain, nodes, isLayouting, runLayout]);

  // --- Inline confirmation prompt -------------------------------------------

  if (confirming) {
    return (
      <Panel position="top-right" className="auto-layout-panel">
        <span className="auto-layout-confirm__label">Rearrange all nodes?</span>
        <button
          className="auto-layout-button auto-layout-button--confirm"
          onClick={runLayout}
        >
          Continue
        </button>
        <button
          className="auto-layout-button auto-layout-button--cancel"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
      </Panel>
    );
  }

  // --- Default button -------------------------------------------------------

  return (
    <Panel position="top-right" className="auto-layout-panel">
      <button
        className="auto-layout-button"
        onClick={handleClick}
        disabled={isLayouting || nodes.length === 0}
        title="Auto-layout nodes using ELK algorithm"
      >
        {isLayouting && <span className="auto-layout-button__spinner" />}
        {isLayouting ? 'Layouting\u2026' : 'Auto Layout'}
      </button>
    </Panel>
  );
}
