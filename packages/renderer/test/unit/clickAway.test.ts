/**
 * The two-step click-away (lib/clickAway.ts), shared by the viewer and the
 * editor: an open detail panel closes first, keeping the selection; the
 * next click (or Escape) clears it. Anything selected with no panel open
 * clears at once.
 */
import { describe, it, expect } from 'vitest';
import { applyClickAway, clickAwayPatch, clickAwayStep, CLOSE_PANEL_PATCH } from '../../src/lib/clickAway';
import { createCanvasStore } from '../../src/store/editorStore';
import type { TableFlowNode } from '../../src/types/graph';

const node = (id: string, selected = false) => ({ id, type: 'model', position: { x: 0, y: 0 }, data: {}, selected }) as unknown as TableFlowNode;

function store(state: Parameters<typeof createCanvasStore>[0]) {
  return createCanvasStore(state);
}

describe('clickAwayStep', () => {
  it('a table with its panel open: close the panel first', () => {
    expect(clickAwayStep(store({ selectedNode: 'a', detailPanelOpen: true }).getState())).toBe('close-panel');
  });

  it('a table selected with its panel closed (its close button, a gentle reveal): clear', () => {
    expect(clickAwayStep(store({ selectedNode: 'a', detailPanelOpen: false }).getState())).toBe('clear');
  });

  it('a relationship line, a note, a rubber band or a host\'s selectTables selection: no panel, so clear at once', () => {
    expect(clickAwayStep(store({ selectedEdge: 'e1', highlightedColumns: new Set(['a:x']) }).getState())).toBe('clear');
    expect(clickAwayStep(store({ selectedAnnotation: 'n1' }).getState())).toBe('clear');
    expect(clickAwayStep(store({ nodes: [node('a', true), node('b', true)] }).getState())).toBe('clear');
    expect(clickAwayStep(store({ selectedEdges: ['e1'] }).getState())).toBe('clear');
  });

  it('nothing selected: nothing to do', () => {
    expect(clickAwayStep(store({}).getState())).toBe('none');
  });
});

describe('clickAwayPatch / applyClickAway', () => {
  it('step one keeps the table, its lit lines and React Flow\'s marks; closes the panel and its column rows', () => {
    const s = store({
      selectedNode: 'a', detailPanelOpen: true, nodes: [node('a', true), node('b', true)],
      selectedColumns: ['x'], lastSelectedColumn: 'x', editingColumn: 'x', pendingDeleteConfirmation: true,
    });
    expect(applyClickAway(s)).toBe('close-panel');
    const after = s.getState();
    expect(after.detailPanelOpen).toBe(false);
    expect(after.selectedNode).toBe('a');
    expect(after.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['a', 'b']);
    expect(after.selectedColumns).toEqual([]);
    expect(after.editingColumn).toBeNull();
    expect(after.pendingDeleteConfirmation).toBe(false);
  });

  it('step two clears everything, React Flow\'s marks included', () => {
    const s = store({ selectedNode: 'a', detailPanelOpen: true, nodes: [node('a', true), node('b')], selectedEdge: null });
    applyClickAway(s);
    expect(applyClickAway(s)).toBe('clear');
    const after = s.getState();
    expect(after.selectedNode).toBeNull();
    expect(after.nodes.some((n) => n.selected)).toBe(false);
    expect(after.highlightedColumns.size).toBe(0);
    expect(applyClickAway(s)).toBe('none');
  });

  it('leaves unselected node objects as they are (no needless re-render)', () => {
    const b = node('b');
    const s = store({ selectedEdge: 'e', nodes: [node('a', true), b] });
    applyClickAway(s);
    expect(s.getState().nodes[1]).toBe(b);
    expect(clickAwayPatch({ nodes: [b] }, 'clear').nodes).toBeUndefined();
  });

  it('the panel\'s close button leaves exactly the first step\'s state', () => {
    expect(clickAwayPatch({ nodes: [] }, 'close-panel')).toEqual(CLOSE_PANEL_PATCH);
  });
});
