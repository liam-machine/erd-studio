// @vitest-environment jsdom
/**
 * ErdCanvas with draggable nodes: moves stay local, edges re-pick their sides
 * as nodes move, the layout-modified flag follows the positions, and
 * resetLayout() restores the domain's layout.
 *
 * React Flow's <ReactFlow> is replaced by a stub that records its props, so a
 * test can drive `onNodesChange` the way React Flow does during a drag and
 * read back the nodes and edges the canvas hands it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRef, type ComponentProps } from 'react';
import { render, act } from '@testing-library/react';
import type { NodeChange } from '@xyflow/react';
import type { DisplayDomain, DisplayModel } from '@erd-studio/core';
import type { GraphEdge, GraphNode } from '../../src/lib/nodeOverlays';

type FlowProps = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodesChange: (changes: NodeChange<GraphNode>[]) => void;
  [prop: string]: unknown;
};

const flow = vi.hoisted(() => ({ props: null as FlowProps | null }));
const setDomainSpies = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlow: (props: FlowProps) => {
      flow.props = props;
      const positions = props.nodes.map((n) => `${n.id}@${n.position.x},${n.position.y}`).join(' ');
      return <div className="flow-stub" data-positions={positions} />;
    },
  };
});

// Wrap every store ErdCanvas creates so its setDomain calls can be counted.
vi.mock('../../src/store/editorStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/editorStore')>();
  return {
    ...actual,
    createCanvasStore: (...args: Parameters<typeof actual.createCanvasStore>) => {
      const store = actual.createCanvasStore(...args);
      const setDomain = vi.fn(store.getState().setDomain);
      store.setState({ setDomain });
      setDomainSpies.push(setDomain);
      return store;
    },
  };
});

import { ErdCanvas, type ErdCanvasHandle } from '../../src/ErdCanvas';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function model(name: string): DisplayModel {
  return {
    name,
    schema: 'sales',
    description: '',
    columns: [
      { name: 'id', dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
      { name: 'ref_id', dataType: 'bigint', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false },
    ],
  };
}

function makeDomain(customersX = 800): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'sales',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models: [model('orders'), model('customers')],
    relationships: [
      { fromModel: 'orders', fromColumn: 'ref_id', toModel: 'customers', toColumn: 'id', cardinality: 'many-to-one' },
    ],
    viewConfig: { positions: { orders: { x: 0, y: 0 }, customers: { x: customersX, y: 0 } } },
    readOnly: false,
    positionDraggable: true,
  };
}

const EDGE_ID = 'fk-orders-ref_id-customers-id';

function props(): FlowProps {
  if (!flow.props) throw new Error('ReactFlow was not rendered');
  return flow.props;
}
const position = (id: string) => props().nodes.find((n) => n.id === id)!.position;
const edgeHandles = () => {
  const edge = props().edges.find((e) => e.id === EDGE_ID)!;
  return [edge.sourceHandle, edge.targetHandle];
};

function drag(id: string, to: { x: number; y: number }, dragging = true) {
  act(() => {
    props().onNodesChange([{ type: 'position', id, position: to, dragging }]);
  });
}

function mount(overrides: Partial<ComponentProps<typeof ErdCanvas>> = {}) {
  const onLayoutModifiedChange = vi.fn();
  const ref = createRef<ErdCanvasHandle>();
  const domain = makeDomain();
  const view = render(
    <ErdCanvas ref={ref} domain={domain} nodesDraggable onLayoutModifiedChange={onLayoutModifiedChange} {...overrides} />,
  );
  return { ...view, ref, domain, onLayoutModifiedChange };
}

beforeEach(() => {
  flow.props = null;
  setDomainSpies.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErdCanvas drag', () => {
  it('passes nodesDraggable through, off by default', () => {
    const { rerender, domain } = mount();
    expect(props().nodesDraggable).toBe(true);
    rerender(<ErdCanvas domain={domain} />);
    expect(props().nodesDraggable).toBe(false);
  });

  it('re-picks the sides of the edges on a moved node while it is dragged', () => {
    mount();
    expect(edgeHandles()).toEqual(['node-right-src', 'node-left-tgt']);

    drag('customers', { x: -900, y: 0 });
    expect(position('customers')).toEqual({ x: -900, y: 0 });
    expect(edgeHandles()).toEqual(['node-left-src', 'node-right-tgt']);

    drag('customers', { x: 0, y: 900 }, false);
    expect(edgeHandles()).toEqual(['node-bottom-src', 'node-top-tgt']);
  });

  it('reports the layout as modified once, and unmodified when the node goes back', () => {
    const { onLayoutModifiedChange } = mount();
    expect(onLayoutModifiedChange).not.toHaveBeenCalled();

    drag('customers', { x: 820, y: 0 });
    drag('customers', { x: 840, y: 30 });
    expect(onLayoutModifiedChange.mock.calls).toEqual([[true]]);

    // Back within half a pixel of where the domain has it.
    drag('customers', { x: 800.2, y: 0.3 }, false);
    expect(onLayoutModifiedChange.mock.calls).toEqual([[true], [false]]);
  });

  it('does not count selection or measurement changes as a move', () => {
    const { onLayoutModifiedChange } = mount();
    act(() => {
      props().onNodesChange([
        { type: 'select', id: 'orders', selected: true },
        { type: 'dimensions', id: 'orders', dimensions: { width: 280, height: 120 } },
      ]);
    });
    expect(onLayoutModifiedChange).not.toHaveBeenCalled();
    expect(position('orders')).toEqual({ x: 0, y: 0 });
    expect(props().nodes.find((n) => n.id === 'orders')!.selected).toBe(true);
  });

  it('resetLayout() restores positions and edge sides', () => {
    const { ref, onLayoutModifiedChange } = mount();
    drag('customers', { x: -900, y: 0 }, false);
    drag('orders', { x: 50, y: 700 }, false);

    act(() => ref.current!.resetLayout());

    expect(position('customers')).toEqual({ x: 800, y: 0 });
    expect(position('orders')).toEqual({ x: 0, y: 0 });
    expect(edgeHandles()).toEqual(['node-right-src', 'node-left-tgt']);
    expect(onLayoutModifiedChange.mock.calls).toEqual([[true], [false]]);
  });

  it('resetLayout() on an unmoved layout changes nothing', () => {
    const { ref, onLayoutModifiedChange } = mount();
    const { nodes, edges } = props();
    act(() => ref.current!.resetLayout());
    expect(props().nodes).toBe(nodes);
    expect(props().edges).toBe(edges);
    expect(onLayoutModifiedChange).not.toHaveBeenCalled();
  });

  it('keeps a dragged position when the parent re-renders with the same domain', () => {
    const { rerender, domain, onLayoutModifiedChange } = mount();
    drag('customers', { x: -900, y: 0 }, false);

    rerender(<ErdCanvas domain={domain} nodesDraggable onLayoutModifiedChange={onLayoutModifiedChange} />);
    // New callback closures do not reset anything either.
    rerender(<ErdCanvas domain={domain} nodesDraggable onLayoutModifiedChange={(m) => onLayoutModifiedChange(m)} />);

    expect(position('customers')).toEqual({ x: -900, y: 0 });
    expect(edgeHandles()).toEqual(['node-left-src', 'node-right-tgt']);
    expect(onLayoutModifiedChange.mock.calls).toEqual([[true]]);
  });

  it('a new domain replaces the moved layout and clears the modified flag', () => {
    const { rerender, onLayoutModifiedChange } = mount();
    drag('customers', { x: -900, y: 0 }, false);

    rerender(<ErdCanvas domain={makeDomain(1200)} nodesDraggable onLayoutModifiedChange={onLayoutModifiedChange} />);

    expect(position('customers')).toEqual({ x: 1200, y: 0 });
    expect(edgeHandles()).toEqual(['node-right-src', 'node-left-tgt']);
    expect(onLayoutModifiedChange.mock.calls).toEqual([[true], [false]]);
  });

  it('mounts without setting the domain a second time', () => {
    const { rerender, domain } = mount();
    expect(setDomainSpies).toHaveLength(1);
    expect(setDomainSpies[0]).not.toHaveBeenCalled();

    rerender(<ErdCanvas domain={domain} />);
    expect(setDomainSpies[0]).not.toHaveBeenCalled();

    rerender(<ErdCanvas domain={makeDomain(1200)} />);
    expect(setDomainSpies[0]).toHaveBeenCalledTimes(1);
  });

  it('gives each canvas its own store', () => {
    const domain = makeDomain();
    const { container } = render(
      <>
        <ErdCanvas domain={domain} nodesDraggable />
        <ErdCanvas domain={domain} nodesDraggable />
      </>,
    );
    expect(setDomainSpies).toHaveLength(2);
    // The stub's recorded props are the second canvas's (rendered last).
    drag('customers', { x: -900, y: 0 });
    const [first, second] = [...container.querySelectorAll('.flow-stub')].map((el) => el.getAttribute('data-positions'));
    expect(first).toBe('orders@0,0 customers@800,0');
    expect(second).toBe('orders@0,0 customers@-900,0');
  });
});
