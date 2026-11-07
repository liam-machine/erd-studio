// @vitest-environment jsdom
/**
 * useCanvasGraph keeps the store's node and edge objects for everything a
 * domain update left as it was: the optimistic update after a drag hands
 * React Flow new objects for the moved table (and edges whose sides moved)
 * only, so the rest of a large canvas does not re-render.
 */
import { describe, it, expect } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import type { DisplaySubjectArea, DisplayTable } from '@erd-studio/core';

import { useCanvasGraph } from '../../src/canvas/useCanvasGraph';
import { CanvasStoreProvider, createCanvasStore } from '../../src/store/editorStore';

function table(name: string, fk?: string): DisplayTable {
  return {
    name, schema: 's', description: '',
    columns: [
      { name: `${name}_id`, dataType: 'bigint', description: '', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
      ...(fk ? [{ name: `${fk}_id`, dataType: 'bigint', description: '', isPrimaryKey: false, isForeignKey: true, isNaturalKey: false }] : []),
    ],
  };
}

function domain(moved?: { x: number; y: number }): DisplaySubjectArea {
  const models = Array.from({ length: 40 }, (_, i) => table(`t${i}`, i > 0 ? `t${i - 1}` : undefined));
  const positions: Record<string, { x: number; y: number }> = {};
  models.forEach((m, i) => { positions[m.name] = { x: (i % 8) * 400, y: Math.floor(i / 8) * 300 }; });
  if (moved) positions.t20 = moved;
  return {
    schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '',
    models,
    relationships: models.slice(1).map((m, i) => ({ fromModel: m.name, fromColumn: `t${i}_id`, toModel: `t${i}`, toColumn: `t${i}_id`, cardinality: 'many-to-one' as const })),
    viewConfig: { positions },
    readOnly: false, positionDraggable: true,
  } as DisplaySubjectArea;
}

describe('useCanvasGraph: a positions-only domain update', () => {
  it('re-uses every node and edge that did not move', () => {
    const store = createCanvasStore();
    const wrapper = ({ children }: { children: ReactNode }) => createElement(CanvasStoreProvider, { store, children });
    renderHook(() => useCanvasGraph(), { wrapper });
    act(() => { store.getState().setDomain(domain()); });
    const before = store.getState();
    expect(before.nodes).toHaveLength(40);

    // What usePositionPersistence does after a drag: the same domain with one position changed.
    act(() => { store.getState().setDomain(domain({ x: 5000, y: 5000 })); });
    const after = store.getState();
    const newNodes = after.nodes.filter((n) => !before.nodes.includes(n)).map((n) => n.id);
    expect(newNodes).toEqual(['t20']);
    const newEdges = after.edges.filter((e) => !before.edges.includes(e));
    for (const e of newEdges) expect([e.source, e.target]).toContain('t20');
    expect(after.nodes.find((n) => n.id === 't20')!.position).toEqual({ x: 5000, y: 5000 });

    // A payload equal to what is shown changes nothing at all.
    act(() => { store.getState().setDomain(domain({ x: 5000, y: 5000 })); });
    expect(store.getState().nodes).toBe(after.nodes);
    expect(store.getState().edges).toBe(after.edges);
  });
});
