/**
 * reuseUnchanged — a rebuilt graph keeps the store's objects for every node
 * and edge that came out the same, so a drag re-renders only what moved.
 */
import { describe, expect, it } from 'vitest';

import { transformSubjectArea } from '../../src/lib/graphTransformer';
import { reuseUnchanged, sameData } from '../../src/lib/reuseUnchanged';
import type { DisplayColumn, DisplaySubjectArea, DisplayTable, DisplayRelationship } from '@erd-studio/core';

function column(name: string, overrides: Partial<DisplayColumn> = {}): DisplayColumn {
  return { name, dataType: 'string', description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...overrides };
}

function table(name: string, extra: DisplayColumn[] = []): DisplayTable {
  return { name, schema: 'silver', description: '', columns: [column(`${name}_id`, { isPrimaryKey: true }), ...extra] };
}

function rel(fromModel: string, toModel: string): DisplayRelationship {
  return { fromModel, fromColumn: `${toModel}_id`, toModel, toColumn: `${toModel}_id`, cardinality: 'many-to-one' };
}

/** A grid of `n` tables, each pointing at its left neighbour. */
function grid(n: number, positions: Record<string, { x: number; y: number }> = {}): DisplaySubjectArea {
  const models = Array.from({ length: n }, (_, i) => table(`t${i}`, i > 0 ? [column(`t${i - 1}_id`, { isForeignKey: true })] : []));
  const base: Record<string, { x: number; y: number }> = {};
  models.forEach((m, i) => { base[m.name] = { x: (i % 10) * 400, y: Math.floor(i / 10) * 300 }; });
  return {
    schemaVersion: 5, domain: 'g', layer: 'silver', stage: 'logical', description: '',
    models,
    relationships: models.slice(1).map((m, i) => rel(m.name, `t${i}`)),
    viewConfig: { positions: { ...base, ...positions } },
    readOnly: false, positionDraggable: true,
  } as DisplaySubjectArea;
}

describe('sameData', () => {
  it('compares plain data structurally, and functions and class instances by identity', () => {
    const fn = (): void => {};
    expect(sameData({ a: [1, { b: 'x' }], c: fn }, { c: fn, a: [1, { b: 'x' }] })).toBe(true);
    expect(sameData({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameData({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameData({ c: fn }, { c: () => {} })).toBe(false);
    expect(sameData(new Set([1]), new Set([1]))).toBe(false);
    expect(sameData(NaN, NaN)).toBe(true);
    expect(sameData(null, {})).toBe(false);
  });
});

describe('reuseUnchanged', () => {
  it('keeps every node and edge of an unchanged rebuild, returning the very arrays', () => {
    const first = transformSubjectArea(grid(30));
    const again = transformSubjectArea(grid(30));
    expect(reuseUnchanged(first.nodes, again.nodes)).toBe(first.nodes);
    expect(reuseUnchanged(first.edges, again.edges)).toBe(first.edges);
  });

  it('after a drag, only the moved table and the edges whose geometry changed are new objects', () => {
    const before = transformSubjectArea(grid(100));
    const after = transformSubjectArea(grid(100, { t55: { x: 9000, y: 9000 } }));
    const nodes = reuseUnchanged(before.nodes, after.nodes);
    const edges = reuseUnchanged(before.edges, after.edges);
    const newNodes = nodes.filter((n, i) => n !== before.nodes[i]).map((n) => n.id);
    expect(newNodes).toEqual(['t55']);
    // The moved table's edges (to t54 and from t56) may change sides; every other edge is kept.
    const newEdges = edges.filter((e) => !before.edges.includes(e));
    expect(newEdges.length).toBeLessThanOrEqual(2);
    for (const e of newEdges) expect([e.source, e.target]).toContain('t55');
    // Equal, field for field, to the full rebuild.
    expect(nodes).toEqual(after.nodes);
    expect(edges).toEqual(after.edges);
  });

  it('ignores React Flow\'s transient fields and treats an absent `selected` as false', () => {
    type El = { id: string; position: { x: number; y: number }; dragging?: boolean; selected?: boolean };
    const prev: El[] = [{ id: 'a', position: { x: 1, y: 2 }, dragging: false, selected: false }];
    const next: El[] = [{ id: 'a', position: { x: 1, y: 2 } }];
    expect(reuseUnchanged(prev, next)).toBe(prev);
    expect(reuseUnchanged(prev, [{ id: 'a', position: { x: 1, y: 2 }, selected: true }])[0]).not.toBe(prev[0]);
  });

  it('a removed or added element, or a new order, gives a new array of the right elements', () => {
    const a = { id: 'a', v: 1 };
    const b = { id: 'b', v: 2 };
    expect(reuseUnchanged([a, b], [{ id: 'b', v: 2 }, { id: 'a', v: 1 }])).toEqual([b, a]);
    const out = reuseUnchanged([a, b], [{ id: 'a', v: 1 }]);
    expect(out).toEqual([a]);
    expect(out[0]).toBe(a);
    expect(reuseUnchanged([], [a])).toEqual([a]);
  });
});
