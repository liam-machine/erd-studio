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
 * The name is matched ignoring case, as a diagram's table names are unique that way
 * (`findRevealNode`: a diagram's name for the table first).
 *
 * A gentle reveal (`RevealTableMessage.gentle`: a sidebar row's click) only
 * selects the table: no detail panel is opened (one already open stays as
 * it is), the zoom is kept, and the view pans only when the table is not
 * wholly in sight, as little as brings it in (`revealGently`). It waits
 * while the canvas is behind another tab (`canvasOnScreen`, and
 * `isBehindAnotherTab` for the moment before the host says so): the first
 * click of a double-click asks for it just as the second opens the file over
 * the canvas, whose stand-in size would read the table as out of sight.
 */
import { useEffect, useRef, useState } from 'react';
import { useNodesInitialized, useReactFlow } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { REVEAL_SETTLE_MS } from './useRevealRelationship';
import { isBehindAnotherTab, revealGently, type GentleFlow } from '../lib/gentleReveal';
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
  const gentle = useEditorStore((s) => s.pendingTableRevealGentle);
  const onScreen = useEditorStore((s) => s.canvasOnScreen);
  const domain = useEditorStore((s) => s.domain);
  const nodes = useEditorStore((s) => s.nodes);
  const pendingAutoLayout = useEditorStore((s) => s.pendingAutoLayout);
  const nodesInitialized = useNodesInitialized();
  const flow = useReactFlow();
  const { fitView } = flow;
  // The instance at the time the reveal runs (a ref: a new object each render must not restart the wait).
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // Bumped to look again while a gentle reveal waits for its tab to come back (`isBehindAnotherTab`).
  const [retry, setRetry] = useState(0);

  // Only looked at while a reveal waits: the common case costs nothing.
  const settled = !!pending
    && !!domain
    && domain.stage === 'logical'
    && !pendingAutoLayout
    && !isLayouting
    && nodesInitialized
    && hasNodeForEveryTable(domain, nodes)
    // A gentle reveal measures what is in sight: never while the tab is behind another (a stand-in size).
    && (!gentle || onScreen);
  const nodeId = pending && settled ? findRevealNode(nodes, pending) : undefined;

  useEffect(() => {
    if (!pending || !settled || !nodeId) return;
    const timer = setTimeout(() => {
      // Behind another tab before the host could say so: kept, and looked at again shortly.
      if (gentle && isBehindAnotherTab()) {
        setRetry((n) => n + 1);
        return;
      }
      const state = useEditorStore.getState();
      state.setPendingTableReveal(null);
      // As a click on the table does (useCanvasGraph's onNodeClick).
      state.selectNode(nodeId);
      state.setHighlightedColumns(new Set());
      state.setSelectedEdge(null);
      if (gentle) {
        // Selected where it is: no panel opened, the zoom kept, panned only into sight.
        // With no panel, the table's own selection outline is what shows the user which
        // one it is (as a click on it marks it): exactly this node, any earlier selection
        // (a drop's tables, a rubber band) cleared.
        state.setNodes(state.nodes.map((n) => {
          const want = n.id === nodeId;
          return !!n.selected === want ? n : { ...n, selected: want };
        }));
        revealGently(flowRef.current as unknown as GentleFlow, [nodeId], 'start');
        return;
      }
      state.setDetailPanelOpen(true);
      void fitView({ nodes: [{ id: nodeId }], duration: 300, padding: 0.3 });
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pending, gentle, settled, nodeId, fitView, retry]);

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
