// @vitest-environment jsdom
/**
 * A hover preview re-renders only the tables whose part in it changed: the
 * hovered table and its related tables, never the rest of the canvas.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Profiler } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

import { TableNode } from '../../src/components/Graph/ModelNode';
import { CanvasStoreProvider, createCanvasStore } from '../../src/store/editorStore';
import { computeCanvasFocus } from '../../src/lib/canvasFocus';
import type { TableFlowNode, FkFlowEdge } from '../../src/types/graph';
import type { GraphEdge } from '../../src/lib/nodeOverlays';

afterEach(cleanup);

function data(name: string): TableFlowNode['data'] {
  return {
    modelName: name, stage: 'logical', layer: 'silver', isStub: false, readOnly: false,
    columns: [{ name: `${name}_id`, dataType: 'int', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false }],
  };
}

const EDGES: GraphEdge[] = [{
  id: 'a-b', type: 'fk', source: 'a', target: 'b',
  data: { fromModel: 'a', fromColumn: 'b_id', toModel: 'b', toColumn: 'b_id', cardinality: 'many-to-one' },
} as FkFlowEdge];

describe('TableNode — hover focus', () => {
  it('marks the origin and related tables, and never re-renders the rest', () => {
    const store = createCanvasStore();
    const renders: Record<string, number> = { a: 0, b: 0, c: 0 };
    const Node = TableNode as unknown as React.ComponentType<{ id: string; data: TableFlowNode['data']; selected: boolean }>;
    const items = ['a', 'b', 'c'].map((id) => ({ id, data: data(id) }));
    const { container } = render(
      <CanvasStoreProvider store={store}>
        {items.map(({ id, data: d }) => (
          <Profiler key={id} id={id} onRender={() => { renders[id] += 1; }}>
            <Node id={id} data={d} selected={false} />
          </Profiler>
        ))}
      </CanvasStoreProvider>,
    );
    const card = (id: string) => container.querySelector(`[data-model-name="${id}"]`)!;
    const initial = { ...renders };

    act(() => { store.getState().setHoverFocus(computeCanvasFocus(EDGES, { node: 'a' })); });
    expect(card('a').className).toContain('model-node--focus-origin');
    expect(card('b').className).toContain('model-node--focus-related');
    expect(card('c').className).not.toContain('model-node--focus');
    expect(renders.c).toBe(initial.c);
    expect(renders.a).toBeGreaterThan(initial.a);
    expect(renders.b).toBeGreaterThan(initial.b);

    const during = { ...renders };
    act(() => { store.getState().setHoverFocus(null); });
    expect(card('a').className).not.toContain('model-node--focus');
    expect(card('b').className).not.toContain('model-node--focus');
    expect(renders.a).toBeGreaterThan(during.a);
    expect(renders.b).toBeGreaterThan(during.b);
    expect(renders.c).toBe(initial.c);
  });
});
