// @vitest-environment jsdom
/**
 * useHoverFocus: resting on a table previews its neighbourhood without ever
 * rewriting the nodes or edges arrays (the performance contract), clears on
 * leave, gives way to drags and menus, and keeps the focus true to the graph.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { ReactFlowProvider, useStoreApi } from '@xyflow/react';
import type { DisplaySubjectArea, DisplayTable } from '@erd-studio/core';

import { useCanvasGraph } from '../../src/canvas/useCanvasGraph';
import { useHoverFocus, SELECTION_FLOW_SETTLE_MS } from '../../src/canvas/useHoverFocus';
import { CanvasStoreProvider, createCanvasStore, type CanvasStoreApi } from '../../src/store/editorStore';
import { computeCanvasFocus, sameFocus } from '../../src/lib/canvasFocus';
import type { GraphNode } from '../../src/lib/nodeOverlays';

function table(name: string, fk?: string): DisplayTable {
  return {
    name, schema: 's', description: '',
    columns: [
      { name: `${name}_id`, dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
      ...(fk ? [{ name: `${fk}_id`, dataType: 'bigint', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false }] : []),
    ],
  };
}

/** 40 tables in a chain: t{i} → t{i-1}. */
function domain(opts: { moved?: { x: number; y: number }; without?: string; extra?: DisplaySubjectArea['relationships'] } = {}): DisplaySubjectArea {
  let models = Array.from({ length: 40 }, (_, i) => table(`t${i}`, i > 0 ? `t${i - 1}` : undefined));
  const positions: Record<string, { x: number; y: number }> = {};
  models.forEach((m, i) => { positions[m.name] = { x: (i % 8) * 400, y: Math.floor(i / 8) * 300 }; });
  if (opts.moved) positions.t20 = opts.moved;
  let relationships: DisplaySubjectArea['relationships'] = models.slice(1).map((m, i) => ({
    fromModel: m.name, fromColumn: `t${i}_id`, toModel: `t${i}`, toColumn: `t${i}_id`, cardinality: 'many-to-one' as const,
  }));
  if (opts.without) {
    models = models.filter((m) => m.name !== opts.without);
    relationships = relationships.filter((r) => r.fromModel !== opts.without && r.toModel !== opts.without);
  }
  return {
    schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '',
    models,
    relationships: [...relationships, ...(opts.extra ?? [])],
    viewConfig: { positions, annotations: [{ id: 'n1', text: 'note', x: 0, y: 2000 }] },
    readOnly: false, positionDraggable: true,
  } as DisplaySubjectArea;
}

const MOVE = { buttons: 0 } as unknown as React.MouseEvent;

function setup() {
  const store: CanvasStoreApi = createCanvasStore();
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(CanvasStoreProvider, { store, children: createElement(ReactFlowProvider, null, children) });
  const hook = renderHook(() => {
    const { onPaneClick } = useCanvasGraph();
    return { ...useHoverFocus(), onPaneClick, flowApi: useStoreApi() };
  }, { wrapper });
  act(() => { store.getState().setDomain(domain()); });
  const node = (id: string) => store.getState().nodes.find((n) => n.id === id) as GraphNode;
  const enter = (id: string, buttons = 0) =>
    act(() => { hook.result.current.hoverHandlers.onNodeMouseEnter({ buttons } as unknown as React.MouseEvent, node(id)); });
  const leave = (id: string) =>
    act(() => { hook.result.current.hoverHandlers.onNodeMouseLeave(MOVE, node(id)); });
  const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
  return { store, hook, node, enter, leave, wait };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useHoverFocus — performance contract', () => {
  it('previews a hovered table without touching the nodes or edges arrays', () => {
    const { store, hook, enter, wait } = setup();
    const { nodes, edges } = store.getState();
    expect(nodes.length).toBeGreaterThanOrEqual(40);

    enter('t5');
    wait(120);

    const s = store.getState();
    expect(s.nodes).toBe(nodes);
    expect(s.edges).toBe(edges);
    expect(s.hoverFocus?.node).toBe('t5');
    expect([...s.hoverFocus!.nodes].sort()).toEqual(['t4', 't5', 't6']);
    expect(s.flowFocus).toBe(s.hoverFocus);
    expect(hook.result.current.flowClassName).toContain('erd-flow--hover-focus');
  });
});

describe('useHoverFocus — leaving', () => {
  it('clears both focuses 150ms after leaving', () => {
    const { store, hook, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    leave('t5');
    wait(150);
    expect(store.getState().hoverFocus).toBeNull();
    expect(store.getState().flowFocus).toBeNull();
    expect(hook.result.current.flowClassName).toBe('erd-flow');
  });

  it('a viewport gesture inside the leave grace still clears the hover', () => {
    // Click a table, move straight off it and press on the canvas (or start a
    // pan): the press starts a viewport gesture before the 150ms grace runs out.
    const { store, hook, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    leave('t5');
    wait(50);
    act(() => { hook.result.current.flowApi.getState().onViewportChangeStart?.({ x: 0, y: 0, zoom: 1 }); });
    wait(100);
    expect(store.getState().hoverFocus).toBeNull();
    expect(store.getState().flowFocus).toBeNull();
    expect(hook.result.current.flowClassName).toBe('erd-flow');
  });

  it('a click on the blank canvas stops the arrows at once', () => {
    const { store, hook, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    act(() => { store.getState().selectNode('t5'); });
    leave('t5');
    act(() => { hook.result.current.onPaneClick(); });
    expect(store.getState().selectedNode).toBeNull();
    expect(store.getState().hoverFocus).toBeNull();
    expect(store.getState().flowFocus).toBeNull();
  });

  it('falls back to the clicked table, which flows again', () => {
    const { store, enter, leave, wait } = setup();
    act(() => { store.getState().selectNode('t10'); });
    const selection = computeCanvasFocus(store.getState().edges, { node: 't10' });
    expect(sameFocus(store.getState().flowFocus, selection)).toBe(true);

    enter('t5');
    wait(120);
    expect(store.getState().flowFocus?.node).toBe('t5');

    leave('t5');
    wait(150);
    expect(store.getState().hoverFocus).toBeNull();
    expect(sameFocus(store.getState().flowFocus, selection)).toBe(true);
  });

  it('a clicked table\'s arrows settle after a few seconds; a hover moves them again', () => {
    const { store, enter, leave, wait } = setup();
    act(() => { store.getState().selectNode('t10'); });
    expect(store.getState().flowFocus?.animate).toBe(true);
    wait(SELECTION_FLOW_SETTLE_MS - 1);
    expect(store.getState().flowFocus?.animate).toBe(true);
    wait(1);
    const settled = store.getState().flowFocus!;
    expect(settled.animate).toBe(false);
    expect(settled.node).toBe('t10');
    expect([...settled.flowEdges].sort()).toEqual([...computeCanvasFocus(store.getState().edges, { node: 't10' })!.flowEdges].sort());

    // A positions-only update keeps it settled.
    act(() => { store.getState().setDomain(domain({ moved: { x: 5000, y: 5000 } })); });
    expect(store.getState().flowFocus).toBe(settled);

    enter('t5');
    wait(120);
    expect(store.getState().flowFocus?.animate).toBe(true);
    leave('t5');
    wait(150);
    expect(store.getState().flowFocus?.node).toBe('t10');
    expect(store.getState().flowFocus?.animate).toBe(true);
    wait(SELECTION_FLOW_SETTLE_MS);
    expect(store.getState().flowFocus?.animate).toBe(false);

    // Selecting it again after clearing moves the arrows again.
    act(() => { store.getState().selectNode(null); });
    act(() => { store.getState().selectNode('t10'); });
    expect(store.getState().flowFocus?.animate).toBe(true);
  });

  it('a hover\'s arrows keep moving while it lasts', () => {
    const { store, enter, wait } = setup();
    enter('t5');
    wait(120);
    wait(SELECTION_FLOW_SETTLE_MS * 3);
    expect(store.getState().flowFocus?.animate).toBe(true);
  });

  it('flows the clicked line when a line is selected', () => {
    const { store } = setup();
    const id = store.getState().edges.find((e) => e.type === 'fk')!.id;
    act(() => { store.getState().setSelectedEdge(id); });
    expect([...store.getState().flowFocus!.flowEdges]).toEqual([id]);
  });
});

describe('useHoverFocus — suppression', () => {
  it('a column drag clears the hover at once and blocks enters', () => {
    const { store, enter, wait } = setup();
    enter('t5');
    wait(120);
    act(() => { store.getState().startDragLine('t5', 't5_id', 0, 0); });
    expect(store.getState().hoverFocus).toBeNull();
    enter('t9');
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
    act(() => { store.getState().endDragLine(); });
    enter('t9');
    wait(120);
    expect(store.getState().hoverFocus?.node).toBe('t9');
  });

  it('an annotation link drag and an open context menu do the same', () => {
    const { store, enter, wait } = setup();
    enter('t5');
    wait(120);
    act(() => { store.getState().startAnnotationLinkDrag('n1', 0, 0); });
    expect(store.getState().hoverFocus).toBeNull();
    enter('t7');
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
    act(() => { store.getState().endAnnotationLinkDrag(); });

    enter('t7');
    wait(120);
    expect(store.getState().hoverFocus?.node).toBe('t7');
    act(() => { store.getState().openNodeContextMenu(0, 0, 't7'); });
    expect(store.getState().hoverFocus).toBeNull();
    enter('t8');
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
  });

  it('a pending enter is dropped when a drag line starts', () => {
    const { store, enter, wait } = setup();
    enter('t5');
    wait(60);
    act(() => { store.getState().startDragLine('t5', 't5_id', 0, 0); });
    act(() => { store.getState().endDragLine(); });
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
  });

  it('a node drag freezes the focus until it stops', () => {
    const { store, hook, node, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    const frozen = store.getState().hoverFocus;
    act(() => { hook.result.current.hoverHandlers.onNodeDragStart(MOVE, node('t5'), [node('t5')]); });
    leave('t5');
    enter('t9');
    wait(1000);
    expect(store.getState().hoverFocus).toBe(frozen);
    act(() => { hook.result.current.hoverHandlers.onNodeDragStop(MOVE, node('t5'), [node('t5')]); });
    enter('t9');
    wait(60);
    expect(store.getState().hoverFocus?.node).toBe('t9');
  });

  it('grabbing another table inside the switch delay moves the focus to it before freezing', () => {
    const { store, hook, node, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    leave('t5');
    enter('t20'); // switch pending (60ms)
    wait(30);
    act(() => { hook.result.current.hoverHandlers.onNodeDragStart(MOVE, node('t20'), [node('t20')]); });
    expect(store.getState().hoverFocus?.node).toBe('t20');
    wait(1000);
    expect(store.getState().hoverFocus?.node).toBe('t20');
    act(() => { hook.result.current.hoverHandlers.onNodeDragStop(MOVE, node('t20'), [node('t20')]); });
    wait(1000);
    expect(store.getState().hoverFocus?.node).toBe('t20');
  });

  it('dropping a table the focus is not on previews it (the pointer is resting there)', () => {
    const { store, hook, node, enter, wait } = setup();
    enter('t20');
    wait(50); // enter still pending
    act(() => { hook.result.current.hoverHandlers.onNodeDragStart(MOVE, node('t20'), [node('t20')]); });
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
    act(() => { hook.result.current.hoverHandlers.onNodeDragStop(MOVE, node('t20'), [node('t20')]); });
    wait(120);
    expect(store.getState().hoverFocus?.node).toBe('t20');
  });

  it('the preview lights only the hovered table\'s own lines', () => {
    const { store, enter, wait } = setup();
    act(() => {
      store.getState().setDomain(domain({
        extra: [{ fromModel: 't6', fromColumn: 't5_id', toModel: 't4', toColumn: 't4_id', cardinality: 'many-to-one' }],
      }));
    });
    enter('t5');
    wait(120);
    const s = store.getState();
    const ends = (id: string) => {
      const e = s.edges.find((x) => x.id === id)!;
      return [e.source, e.target];
    };
    expect(s.hoverFocus!.nodes.has('t4') && s.hoverFocus!.nodes.has('t6')).toBe(true);
    expect(s.hoverFocus!.edges.size).toBe(2);
    for (const id of s.hoverFocus!.edges) expect(ends(id)).toContain('t5');
  });

  it('a held mouse button starts nothing', () => {
    const { store, enter, wait } = setup();
    enter('t5', 1);
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
  });

  it('an annotation never starts a focus', () => {
    const { store, enter, wait } = setup();
    expect(store.getState().nodes.some((n) => n.id === 'annotation-n1' && n.type === 'annotation')).toBe(true);
    enter('annotation-n1');
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
  });

  it('a device without a fine hover pointer gets no pointer preview', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
    const { store, enter, wait } = setup();
    enter('t5');
    wait(500);
    expect(store.getState().hoverFocus).toBeNull();
    // Tap and click still focus.
    act(() => { store.getState().selectNode('t5'); });
    expect(store.getState().flowFocus?.node).toBe('t5');
  });

  it('following a bright line off the table keeps the focus', () => {
    const { store, hook, enter, leave, wait } = setup();
    enter('t5');
    wait(120);
    const line = store.getState().edges.find((e) => store.getState().hoverFocus!.edges.has(e.id))!;
    leave('t5');
    wait(100);
    act(() => { hook.result.current.hoverHandlers.onEdgeMouseEnter(MOVE, line); });
    wait(1000);
    expect(store.getState().hoverFocus?.node).toBe('t5');
    act(() => { hook.result.current.hoverHandlers.onEdgeMouseLeave(MOVE, line); });
    wait(150);
    expect(store.getState().hoverFocus).toBeNull();
  });
});

describe('useHoverFocus — keeping the focus true to the graph', () => {
  it('a domain update that removes the hovered table clears it', () => {
    const { store, enter, wait } = setup();
    enter('t39');
    wait(120);
    expect(store.getState().hoverFocus?.node).toBe('t39');
    act(() => { store.getState().setDomain(domain({ without: 't39' })); });
    expect(store.getState().hoverFocus).toBeNull();
    expect(store.getState().flowFocus).toBeNull();
  });

  it('a new relationship on the hovered table is picked up', () => {
    const { store, enter, wait } = setup();
    enter('t0');
    wait(120);
    expect(store.getState().hoverFocus!.nodes.has('t30')).toBe(false);
    act(() => {
      store.getState().setDomain(domain({
        extra: [{ fromModel: 't30', fromColumn: 't29_id', toModel: 't0', toColumn: 't0_id', cardinality: 'many-to-one' }],
      }));
    });
    expect(store.getState().hoverFocus!.nodes.has('t30')).toBe(true);
    expect(store.getState().flowFocus).toBe(store.getState().hoverFocus);
  });

  it('a positions-only update keeps the very same focus object', () => {
    const { store, enter, wait } = setup();
    enter('t5');
    wait(120);
    const before = store.getState().hoverFocus;
    const flowBefore = store.getState().flowFocus;
    act(() => { store.getState().setDomain(domain({ moved: { x: 5000, y: 5000 } })); });
    expect(store.getState().hoverFocus).toBe(before);
    expect(store.getState().flowFocus).toBe(flowBefore);
  });
});

describe('useHoverFocus — unmount', () => {
  it('clears both focuses and leaves no timer to fire', () => {
    const { store, hook, enter, wait } = setup();
    enter('t5');
    wait(120);
    enter('t9');
    hook.unmount();
    expect(store.getState().hoverFocus).toBeNull();
    expect(store.getState().flowFocus).toBeNull();
    wait(1000);
    expect(store.getState().hoverFocus).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
