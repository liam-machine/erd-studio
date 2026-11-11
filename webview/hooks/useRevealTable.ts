/**
 * useRevealTable — show the table the host asked for (`revealTable`: Open in
 * Diagram or Go to Table on a table, Add to Diagram…) as clicking it would:
 * the table selected with its detail panel open, and the view centred on it.
 *
 * It waits for the canvas to settle first, exactly as
 * {@link useRevealRelationship} does, so its fit is not overwritten by the
 * first-open layout or the restored viewport. A table the settled diagram
 * does not show yet gets {@link REVEAL_TABLE_WAIT_MS} more — Add to Diagram…
 * asks for the reveal right after its add, and the refreshed diagram may
 * arrive just after — and then a toast says so.
 *
 * The name is matched ignoring case, as table names are unique that way
 * (`findRevealNode`: a diagram's name for the table first).
 */
import { useEffect } from 'react';
import { useNodesInitialized, useReactFlow } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { REVEAL_SETTLE_MS } from './useRevealRelationship';
import type { DisplaySubjectArea } from '../../src/types/display';

/** How long a reveal waits for a settled diagram to show its table before saying it does not. */
export const REVEAL_TABLE_WAIT_MS = 2500;

/**
 * The id of the table node named `name` (ignoring case), if the canvas draws
 * one: the node whose id it is (what the diagram calls the table), else the
 * one node whose own name (`tableName`: a table named `<schema>.<name>`
 * because another of its name is on the diagram) it is. A name two nodes
 * share names neither.
 */
export function findRevealNode(nodes: readonly { id: string; type?: string; data?: unknown }[] | undefined, name: string): string | undefined {
  const wanted = name.trim().toLowerCase();
  const tables = (nodes ?? []).filter((n) => n.type === 'model');
  const byId = tables.find((n) => n.id.toLowerCase() === wanted);
  if (byId) return byId.id;
  const byOwnName = tables.filter((n) => {
    const own = (n.data as { tableName?: unknown } | undefined)?.tableName;
    return typeof own === 'string' && own.toLowerCase() === wanted;
  });
  return byOwnName.length === 1 ? byOwnName[0].id : undefined;
}

function hasNodeForEveryTable(domain: DisplaySubjectArea, nodes: readonly { id: string; type?: string }[] | undefined): boolean {
  const tableIds = new Set((nodes ?? []).filter((n) => n.type === 'model').map((n) => n.id));
  return (domain.models ?? []).every((m) => tableIds.has(m.name));
}

export function useRevealTable(isLayouting: boolean): void {
  const pending = useEditorStore((s) => s.pendingTableReveal);
  const domain = useEditorStore((s) => s.domain);
  const nodes = useEditorStore((s) => s.nodes);
  const pendingAutoLayout = useEditorStore((s) => s.pendingAutoLayout);
  const nodesInitialized = useNodesInitialized();
  const { fitView } = useReactFlow();

  // Only looked at while a reveal waits: the common case costs nothing.
  const settled = !!pending
    && !!domain
    && domain.stage === 'logical'
    && !pendingAutoLayout
    && !isLayouting
    && nodesInitialized
    && hasNodeForEveryTable(domain, nodes);
  const nodeId = pending && settled ? findRevealNode(nodes, pending) : undefined;

  useEffect(() => {
    if (!pending || !settled || !nodeId) return;
    const timer = setTimeout(() => {
      const state = useEditorStore.getState();
      state.setPendingTableReveal(null);
      // As a click on the table does (useCanvasGraph's onNodeClick).
      state.selectNode(nodeId);
      state.setDetailPanelOpen(true);
      state.setHighlightedColumns(new Set());
      state.setSelectedEdge(null);
      void fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.3 });
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pending, settled, nodeId, fitView]);

  useEffect(() => {
    if (!pending || !settled || nodeId) return;
    const timer = setTimeout(() => {
      const state = useEditorStore.getState();
      if (state.pendingTableReveal !== pending) return;
      state.setPendingTableReveal(null);
      state.setToastMessage(`This diagram doesn't show the table ${pending}.`);
    }, REVEAL_TABLE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending, settled, nodeId]);
}
