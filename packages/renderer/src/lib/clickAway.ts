/**
 * Click-away in two steps, shared by the editor and the viewer.
 *
 * With a table selected and its detail panel open, a click on the empty
 * canvas (or Escape) first closes the panel only: the table stays selected,
 * its relationship lines lit and flowing, and every table React Flow marks
 * selected (a multi-selection) stays so. The next click, or Escape, clears
 * the selection. Anything selected without an open panel (a relationship
 * line, a note, a rubber-band or a host's `selectTables` selection, a gentle
 * reveal, a table whose panel its close button shut) clears on the first
 * click: there is no panel to close first.
 *
 * Pure: {@link clickAwayStep} decides, {@link clickAwayPatch} is the store
 * update, {@link applyClickAway} does both on a store. Nothing here is
 * posted or persisted.
 */

import type { CanvasState } from '../store/editorStore';

/** What a click on the empty canvas does now. */
export type ClickAwayStep = 'close-panel' | 'clear' | 'none';

/** The state the decision reads. */
export type ClickAwayState = Pick<
  CanvasState,
  'detailPanelOpen' | 'selectedNode' | 'selectedEdge' | 'selectedEdges' | 'selectedAnnotation' | 'highlightedColumns' | 'nodes'
>;

/** Decide the step: close an open panel first, else clear whatever is selected. */
export function clickAwayStep(s: ClickAwayState): ClickAwayStep {
  if (s.detailPanelOpen && s.selectedNode) return 'close-panel';
  const anything =
    s.selectedNode !== null ||
    s.selectedEdge !== null ||
    s.selectedAnnotation !== null ||
    s.selectedEdges.length > 0 ||
    s.highlightedColumns.size > 0 ||
    s.detailPanelOpen ||
    s.nodes.some((n) => n.selected);
  return anything ? 'clear' : 'none';
}

/**
 * The panel closed, the selection kept: what the first click away and the
 * panel's own close button both leave. Column rows selected in the panel go
 * with it (they are no longer on screen, so Delete must not remove them).
 */
export const CLOSE_PANEL_PATCH: Readonly<Partial<CanvasState>> = Object.freeze({
  detailPanelOpen: false,
  pendingDeleteConfirmation: false,
  selectedColumns: [],
  lastSelectedColumn: null,
  editingColumn: null,
});

/** The store update for a step (an empty object for `none`). */
export function clickAwayPatch(s: Pick<CanvasState, 'nodes'>, step: ClickAwayStep): Partial<CanvasState> {
  if (step === 'none') return {};
  if (step === 'close-panel') return { ...CLOSE_PANEL_PATCH };
  const anySelected = s.nodes.some((n) => n.selected);
  return {
    ...CLOSE_PANEL_PATCH,
    selectedNode: null,
    selectedAnnotation: null,
    selectedEdge: null,
    selectedEdges: [],
    highlightedColumns: new Set<string>(),
    // React Flow's own selection marks (the ring, a multi-selection) go too.
    ...(anySelected ? { nodes: s.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)) } : {}),
  };
}

/** A store the click-away can read and write (the canvas store, or a host's composed one). */
export interface ClickAwayStore {
  getState(): ClickAwayState;
  setState(patch: Partial<CanvasState>): void;
}

/** Take the next click-away step on a store; returns the step taken. */
export function applyClickAway(store: ClickAwayStore): ClickAwayStep {
  const state = store.getState();
  const step = clickAwayStep(state);
  if (step !== 'none') store.setState(clickAwayPatch(state, step));
  return step;
}
