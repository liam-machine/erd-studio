/**
 * useCanvasChrome — the canvas chrome's layout (`lib/canvasChrome.ts`) for
 * this canvas's measured size and state: the minimap's size, the counts
 * pill's room, the legend's height and the viewer's detail panel reserve.
 *
 * Reads React Flow's pane size, so it must run under a `ReactFlowProvider`
 * (every chrome component does), and the canvas store. Each value is a
 * primitive or a stable object per size, so a pan or a hover re-renders
 * nothing.
 */

import { useMemo } from 'react';
import { useStore } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { useIsViewer } from '../host/canvasEnvironment';
import { canvasChrome, type CanvasChrome } from '../lib/canvasChrome';

export function useCanvasChrome(): CanvasChrome {
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const viewer = useIsViewer();
  const legendOpen = useEditorStore((s) => s.legendOpen);
  // The editor's panel is on screen when it is open on a table the diagram draws (DetailPanel's own test).
  const editorPanelShown = useEditorStore(
    (s) => !viewer && s.detailPanelOpen && !!s.selectedNode && !!s.domain?.models.some((m) => m.name === s.selectedNode),
  );
  return useMemo(
    () => canvasChrome({ width, height }, { viewer, editorPanelShown, legendOpen }),
    [width, height, viewer, editorPanelShown, legendOpen],
  );
}
