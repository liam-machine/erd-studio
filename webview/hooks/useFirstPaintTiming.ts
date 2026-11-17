/**
 * useFirstPaintTiming — says when the page's first diagram is drawn (#333,
 * `webview/lib/paintTiming.ts`). Inside `ReactFlowProvider`, in the editor
 * only: the Confluence viewer renders `ErdCanvas` from `packages/renderer`,
 * which has no sender, so it posts nothing.
 *
 * "Drawn": React Flow has measured every table (`useNodesInitialized`), or
 * the diagram has nothing to draw. The nodes follow the diagram one render
 * later (useCanvasGraph builds them in an effect), so an empty node list on
 * its own does not mean an empty diagram: the diagram's own tables and notes
 * say that.
 */

import { useEffect } from 'react';
import { useNodesInitialized } from '@xyflow/react';

import { useSend } from './useMessageBus';
import { useEditorStore } from '../store/editorStore';
import { answerFirstPaint, notePageHidden } from '../lib/paintTiming';

export function useFirstPaintTiming(): void {
  const send = useSend();
  const domain = useEditorStore((s) => s.domain);
  const nodeCount = useEditorStore((s) => s.nodes.length);
  const onScreen = useEditorStore((s) => s.canvasOnScreen);
  const nodesInitialized = useNodesInitialized();

  // Behind another tab (the host's canvasVisibility) or a hidden window: not timed.
  useEffect(() => {
    if (!onScreen) notePageHidden();
  }, [onScreen]);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === 'hidden') notePageHidden();
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  const empty = !!domain && domain.models.length === 0 && (domain.viewConfig.annotations ?? []).length === 0;
  const drawn = !!domain && (empty || (nodeCount > 0 && nodesInitialized));
  useEffect(() => {
    if (drawn) answerFirstPaint(send);
  }, [drawn, send]);
}
