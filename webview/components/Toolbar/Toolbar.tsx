/**
 * Toolbar — main control bar for the graph editor.
 *
 * Renders at top-center of the canvas with:
 * - Domain info (name + layer badge)
 * - Zoom controls (in/out/level/fit)
 * - Auto Layout button
 * - New Model button (Phase 2)
 *
 * Uses React Flow's zoom/pan APIs and the editor store for domain data.
 */

import { useState, useCallback, useEffect } from 'react';
import { Panel, useReactFlow, useStore } from '@xyflow/react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { useEditorStore } from '../../store/editorStore';
import { runElkLayout } from '../../lib/elkLayout';
import type { ModelFlowNode, FkFlowEdge } from '../../types/graph';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './Toolbar.css';

// ---------------------------------------------------------------------------
// Layer badge display
// ---------------------------------------------------------------------------

const LAYER_ABBREV: Record<string, string> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ToolbarProps {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Toolbar({ nodes, edges }: ToolbarProps) {
  const vscode = useVsCodeApi();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);

  // Get current zoom level from React Flow store
  const zoom = useStore((s) => s.transform[2]);
  const [zoomPercent, setZoomPercent] = useState(100);

  // Auto layout state
  const [isLayouting, setIsLayouting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Update zoom percentage display
  useEffect(() => {
    setZoomPercent(Math.round(zoom * 100));
  }, [zoom]);

  // --- Zoom handlers -------------------------------------------------------

  const handleZoomIn = useCallback(() => {
    zoomIn({ duration: 200 });
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    zoomOut({ duration: 200 });
  }, [zoomOut]);

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.1, duration: 200 });
  }, [fitView]);

  // --- New Model handler ---------------------------------------------------

  const handleNewModel = useCallback(() => {
    setNewModelDialogOpen(true);
  }, [setNewModelDialogOpen]);

  // --- Auto Layout handlers ------------------------------------------------

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
      const updatedDomain = {
        ...domain,
        viewConfig: {
          ...domain.viewConfig,
          positions,
        },
      };
      setDomain(updatedDomain);

      // Wait one frame for React to flush, then fit viewport
      requestAnimationFrame(() => {
        fitView({ padding: 0.1 });
      });

      // Persist to extension host
      const message: WebviewMessage = {
        type: 'updatePositions',
        payload: { positions },
      };
      vscode.postMessage(message);
    } catch (err) {
      console.error('[Toolbar] Auto layout failed:', err);
    } finally {
      setIsLayouting(false);
    }
  }, [domain, nodes, edges, isLayouting, setDomain, fitView, vscode]);

  const handleAutoLayout = useCallback(() => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }

    // Show confirmation if positions already exist
    const existingPositions = domain.viewConfig.positions ?? {};
    const hasPositions = Object.keys(existingPositions).length > 0;

    if (hasPositions) {
      setConfirming(true);
    } else {
      runLayout();
    }
  }, [domain, nodes, isLayouting, runLayout]);

  // --- Early return if no domain -------------------------------------------

  if (!domain) {
    return null;
  }

  const layerAbbrev = LAYER_ABBREV[domain.layer] ?? domain.layer.toUpperCase();

  // --- Render --------------------------------------------------------------

  return (
    <Panel position="top-center" className="toolbar">
      {/* Domain info */}
      <div className="toolbar__section toolbar__domain">
        <span className="toolbar__domain-name">{domain.domain}</span>
        <span className={`toolbar__layer-badge toolbar__layer-badge--${domain.layer}`}>
          {layerAbbrev}
        </span>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Zoom controls */}
      <div className="toolbar__section toolbar__zoom">
        <button
          className="toolbar__button"
          onClick={handleZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="toolbar__zoom-level">{zoomPercent}%</span>
        <button
          className="toolbar__button"
          onClick={handleZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="toolbar__button toolbar__button--text"
          onClick={handleFitView}
          title="Fit view to show all nodes"
          aria-label="Fit view to show all nodes"
        >
          Fit
        </button>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Auto Layout */}
      <div className="toolbar__section">
        {confirming ? (
          <>
            <span className="toolbar__confirm-label">Rearrange all?</span>
            <button
              className="toolbar__button toolbar__button--confirm"
              onClick={runLayout}
              aria-label="Confirm rearrange all nodes"
            >
              Yes
            </button>
            <button
              className="toolbar__button"
              onClick={() => setConfirming(false)}
              aria-label="Cancel rearrange"
            >
              No
            </button>
          </>
        ) : (
          <button
            className="toolbar__button toolbar__button--text"
            onClick={handleAutoLayout}
            disabled={isLayouting || nodes.length === 0}
            title="Auto-layout nodes using ELK algorithm"
            aria-label="Auto-layout nodes using ELK algorithm"
          >
            {isLayouting && <span className="toolbar__spinner" />}
            {isLayouting ? 'Layouting…' : 'Auto Layout'}
          </button>
        )}
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* New Model */}
      <div className="toolbar__section">
        <button
          className="toolbar__button toolbar__button--text toolbar__button--primary"
          onClick={handleNewModel}
          title="Add new model to domain"
          aria-label="Add new model to domain"
        >
          + Model
        </button>
      </div>
    </Panel>
  );
}
