/**
 * useRevealRelationship — show the relationship the host asked for
 * (`revealRelationship`: the sidebar's Relationships view → Open in Diagram)
 * as clicking its line would: the line selected with its columns lit, the
 * rest of the diagram dimmed, and the view centred on its two tables.
 *
 * It waits for the canvas to settle first, or its fit would be overwritten:
 * the diagram on the logical stage with a node for every table, React Flow's
 * measurements taken, no first-open layout pending or running (each ends with
 * its own fitView), then {@link REVEAL_SETTLE_MS} more, so the viewport
 * restored a tick after the nodes appear lands before it, not after.
 *
 * The line is matched on core's `linkKey` for each column pair, so case and
 * the order of its two ends do not matter. With no such line on the diagram,
 * a toast says so.
 *
 * A gentle reveal (`gentle`: a sidebar row's click) keeps the zoom and pans
 * only when the two tables are not wholly in sight, as little as brings them
 * in (`revealGently`), instead of fitting the view to them. It waits while
 * the canvas is behind another tab (`canvasOnScreen`), as `useRevealTable` does.
 */
import { useEffect, useRef, useState } from 'react';
import { useNodesInitialized, useReactFlow } from '@xyflow/react';
import { linkKey } from '@erd-studio/core';
import { columnPairs, type FkFlowEdge } from '@erd-studio/renderer/editor';
import { useEditorStore } from '../store/editorStore';
import type { RevealRelationshipMessage } from '../../src/types/messages';
import type { DisplaySubjectArea } from '../../src/types/display';
import { isBehindAnotherTab, revealGently, type GentleFlow } from '../lib/gentleReveal';

/** The pause after the canvas settles before the reveal's own fit. */
export const REVEAL_SETTLE_MS = 150;

type RevealTarget = RevealRelationshipMessage['payload'];

interface EdgeLike {
  id: string;
  type?: string;
  data?: unknown;
}

/** The line drawing `target`: the relationship line sharing the most column pairs with it (ghost lines never). */
export function findRevealEdge(edges: readonly EdgeLike[], target: RevealTarget): FkFlowEdge | undefined {
  const wanted = new Set(target.pairs.map((pair) =>
    linkKey({ fromModel: target.fromModel, fromColumn: pair.fromColumn, toModel: target.toModel, toColumn: pair.toColumn })));
  let best: FkFlowEdge | undefined;
  let bestShared = 0;
  for (const edge of edges) {
    if (edge.type !== 'fk' || edge.id.startsWith('ghost-') || !edge.data) continue;
    const fk = edge as FkFlowEdge;
    const data = fk.data!;
    const shared = columnPairs(data).filter((pair) =>
      wanted.has(linkKey({ fromModel: data.fromModel, fromColumn: pair.fromColumn, toModel: data.toModel, toColumn: pair.toColumn }))).length;
    if (shared > bestShared) {
      best = fk;
      bestShared = shared;
    }
  }
  return best;
}

function hasNodeForEveryTable(domain: DisplaySubjectArea, nodes: readonly { id: string; type?: string }[] | undefined): boolean {
  const tableIds = new Set((nodes ?? []).filter((n) => n.type === 'model').map((n) => n.id));
  return (domain.models ?? []).every((m) => tableIds.has(m.name));
}

export function useRevealRelationship(isLayouting: boolean): void {
  const pending = useEditorStore((s) => s.pendingReveal);
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
    && (!pending.gentle || onScreen);

  useEffect(() => {
    if (!pending || !settled) return;
    const timer = setTimeout(() => {
      // Behind another tab before the host could say so: kept, and looked at again shortly.
      if (pending.gentle && isBehindAnotherTab()) {
        setRetry((n) => n + 1);
        return;
      }
      const state = useEditorStore.getState();
      state.setPendingReveal(null);
      const edge = findRevealEdge(state.edges, pending);
      if (!edge?.data) {
        state.setToastMessage(`This diagram doesn't show the relationship ${pending.fromModel} → ${pending.toModel}.`);
        return;
      }
      // As a click on the line does (useCanvasGraph's onEdgeClick).
      const columns = new Set<string>();
      for (const pair of columnPairs(edge.data)) {
        columns.add(`${edge.data.fromModel}:${pair.fromColumn}`);
        columns.add(`${edge.data.toModel}:${pair.toColumn}`);
      }
      state.setHighlightedColumns(columns);
      state.selectNode(null);
      state.setDetailPanelOpen(false);
      state.setSelectedEdge(edge.id);
      if (pending.gentle) {
        // The zoom kept; panned only as far as brings both tables into sight.
        revealGently(flowRef.current as unknown as GentleFlow, [edge.source, edge.target], 'center');
        return;
      }
      void fitView({ nodes: [{ id: edge.source }, { id: edge.target }], duration: 300, padding: 0.3 });
    }, REVEAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pending, settled, fitView, retry]);
}
