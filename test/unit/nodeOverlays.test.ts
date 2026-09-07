import { describe, it, expect } from 'vitest';
import { applyNodeOverlays, type OverlayState } from '../../webview/lib/nodeOverlays';
import type { ModelFlowNode, FkFlowEdge, AnnotationFlowNode } from '../../webview/types/graph';

function makeNode(id: string, extra: Partial<ModelFlowNode['data']> = {}): ModelFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    measured: { width: 280, height: 120 },
    data: {
      modelName: id,
      stage: 'logical',
      layer: 'silver',
      columns: [],
      isStub: false,
      ...extra,
    },
  };
}

function makeEdge(from: string, to: string): FkFlowEdge {
  return {
    id: `fk-${from}-${to}`,
    type: 'fk',
    source: from,
    target: to,
    sourceHandle: 'node-right-src',
    targetHandle: 'node-left-tgt',
    data: { fromModel: from, fromColumn: 'id', toModel: to, toColumn: 'id', cardinality: 'many-to-one' },
  };
}

const toggle = () => {};
const baseState: OverlayState = {
  selectedNode: null,
  selectedEdge: null,
  searchQuery: '',
  isExpanded: () => false,
  toggleExpansion: toggle,
};

describe('applyNodeOverlays', () => {
  it('returns the same arrays when nothing changes', () => {
    const nodes = [makeNode('a', { dimmed: false, isExpanded: false, onToggleExpansion: toggle })];
    const edges = [makeEdge('a', 'a')];
    edges[0].data!.dimmed = false;
    const result = applyNodeOverlays(nodes, edges, baseState);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it('treats undefined dimmed/isExpanded as false (no spurious rebuild)', () => {
    const nodes = [makeNode('a', { onToggleExpansion: toggle })];
    const edges = [makeEdge('a', 'a')];
    const result = applyNodeOverlays(nodes, edges, baseState);
    expect(result.nodes).toBe(nodes);
    expect(result.edges).toBe(edges);
  });

  it('dims nodes not connected to the selected node and keeps identity for unchanged nodes', () => {
    const a = makeNode('a', { onToggleExpansion: toggle });
    const b = makeNode('b', { onToggleExpansion: toggle });
    const c = makeNode('c', { onToggleExpansion: toggle });
    const nodes = [a, b, c];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];

    const result = applyNodeOverlays(nodes, edges, { ...baseState, selectedNode: 'a' });

    expect(result.nodes).not.toBe(nodes);
    // a and b are connected → unchanged (dimmed stays false) → same object
    expect(result.nodes[0]).toBe(a);
    expect(result.nodes[1]).toBe(b);
    // c is not connected → new object with dimmed true
    expect(result.nodes[2]).not.toBe(c);
    expect((result.nodes[2] as ModelFlowNode).data.dimmed).toBe(true);
    // measured is preserved on the rebuilt node
    expect(result.nodes[2].measured).toEqual({ width: 280, height: 120 });

    // Edge a→b bright, b→c dimmed
    expect((result.edges[0] as FkFlowEdge).data?.dimmed ?? false).toBe(false);
    expect(result.edges[0]).toBe(edges[0]);
    expect((result.edges[1] as FkFlowEdge).data?.dimmed).toBe(true);
  });

  it('with an edge selected, only its endpoints and itself stay bright', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    const result = applyNodeOverlays(nodes, edges, {
      ...baseState,
      selectedEdge: 'fk-a-b',
    });
    const dimmedNodes = result.nodes.map((n) => (n as ModelFlowNode).data.dimmed ?? false);
    expect(dimmedNodes).toEqual([false, false, true]);
    expect((result.edges[0] as FkFlowEdge).data?.dimmed ?? false).toBe(false);
    expect((result.edges[1] as FkFlowEdge).data?.dimmed).toBe(true);
  });

  it('applies search dimming case-insensitively and does not touch annotations', () => {
    const ann: AnnotationFlowNode = {
      id: 'annotation-1',
      type: 'annotation',
      position: { x: 0, y: 0 },
      data: { annotationId: '1', text: 'note', color: 'yellow' },
    };
    const nodes = [makeNode('dim_customer'), makeNode('fct_orders'), ann];
    const result = applyNodeOverlays(nodes, [], { ...baseState, searchQuery: 'CUST' });
    expect((result.nodes[0] as ModelFlowNode).data.dimmed).toBe(false);
    expect((result.nodes[1] as ModelFlowNode).data.dimmed).toBe(true);
    expect(result.nodes[2]).toBe(ann);
  });

  it('injects expansion state and the toggle callback', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const result = applyNodeOverlays(nodes, [], {
      ...baseState,
      isExpanded: (id) => id === 'b',
    });
    expect((result.nodes[0] as ModelFlowNode).data.isExpanded).toBe(false);
    expect((result.nodes[1] as ModelFlowNode).data.isExpanded).toBe(true);
    expect((result.nodes[1] as ModelFlowNode).data.onToggleExpansion).toBe(toggle);
  });

  it('clears dimming again when selection is removed', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const selected = applyNodeOverlays(nodes, [], { ...baseState, selectedNode: 'a' });
    expect((selected.nodes[1] as ModelFlowNode).data.dimmed).toBe(true);
    const cleared = applyNodeOverlays(selected.nodes, [], baseState);
    expect((cleared.nodes[1] as ModelFlowNode).data.dimmed).toBe(false);
  });
});
