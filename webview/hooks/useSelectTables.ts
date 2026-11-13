/**
 * useSelectTables — after a drop on the canvas, select the tables it added
 * (or found already there): the host's `selectTables`. Unlike
 * {@link useRevealTable} nothing moves: no pan, no zoom, no detail panel.
 * The tables appear where they were dropped, at the zoom the user had, and
 * show as selected (as a rubber-band selection marks them), so the user sees
 * what was added.
 *
 * The tables are usually not drawn yet when the message arrives (the refresh
 * that adds them follows the edit), so it waits until the canvas draws every
 * one of them, or {@link REVEAL_TABLE_WAIT_MS} at most, then selects those
 * it draws. Names are matched as `findRevealNode` matches them (ignoring
 * case, a diagram's own name for the table first).
 */
import { useEffect } from 'react';
import { useEditorStore } from '../store/editorStore';
import { REVEAL_TABLE_WAIT_MS, findRevealNode } from './useRevealTable';

/** Mark exactly these nodes selected; nothing picked out on its own, no panel, the view untouched. */
function selectOnly(ids: ReadonlySet<string>): void {
  const state = useEditorStore.getState();
  state.setPendingTableSelection(null);
  if (ids.size === 0) return;
  state.selectNode(null);
  state.setDetailPanelOpen(false);
  state.setSelectedEdge(null);
  state.setHighlightedColumns(new Set());
  state.setNodes(state.nodes.map((n) => {
    const want = ids.has(n.id);
    return !!n.selected === want ? n : { ...n, selected: want };
  }));
}

export function useSelectTables(): void {
  const pending = useEditorStore((s) => s.pendingTableSelection);
  const nodes = useEditorStore((s) => s.nodes);
  const ids = pending ? pending.map((name) => findRevealNode(nodes, name)) : [];
  const allDrawn = !!pending && ids.every((id) => id !== undefined);
  const drawnKey = allDrawn ? ids.join('\u0000') : '';

  useEffect(() => {
    if (!pending || !allDrawn) return;
    selectOnly(new Set(drawnKey.split('\u0000')));
  }, [pending, allDrawn, drawnKey]);

  // A table the canvas never draws (refused, or not on this stage): select the rest after a while.
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setTimeout(() => {
      const state = useEditorStore.getState();
      if (state.pendingTableSelection !== pending) return;
      const drawn = pending.map((name) => findRevealNode(state.nodes, name)).filter((id): id is string => id !== undefined);
      selectOnly(new Set(drawn));
    }, REVEAL_TABLE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [pending]);
}
