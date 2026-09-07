import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';
import {
  getEdgesOnSide,
  getAllEdgesForSide,
  sortEdgesForSide,
  calculateEdgeOffset,
  calculateEdgeOffsetInGroup,
  buildPositionsKey,
  type NodePositionMap,
} from '../../webview/lib/edgeDistribution';

function edge(id: string, source: string, target: string, sourceSide = 'right', targetSide = 'left'): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: `node-${sourceSide}-src`,
    targetHandle: `node-${targetSide}-tgt`,
  };
}

describe('getEdgesOnSide', () => {
  it('groups edges by node side in either direction', () => {
    const edges = [
      edge('a-hub', 'a', 'hub'),          // hub left (target)
      edge('hub-b', 'hub', 'b', 'left'),  // hub left (source)
      edge('hub-c', 'hub', 'c', 'right'), // hub right
    ];
    expect(getEdgesOnSide(edges, 'hub', 'left').map((e) => e.id)).toEqual(['a-hub', 'hub-b']);
    expect(getEdgesOnSide(edges, 'hub', 'right').map((e) => e.id)).toEqual(['hub-c']);
    expect(getEdgesOnSide(edges, 'hub', 'top')).toHaveLength(0);
  });

  it('returns identical group references for the same edges array (cached index)', () => {
    const edges = [edge('a-hub', 'a', 'hub'), edge('b-hub', 'b', 'hub')];
    const first = getEdgesOnSide(edges, 'hub', 'left');
    const second = getEdgesOnSide(edges, 'hub', 'left');
    expect(first).toBe(second);
    // A different array identity builds a new index
    const copy = [...edges];
    expect(getEdgesOnSide(copy, 'hub', 'left')).not.toBe(first);
    expect(getEdgesOnSide(copy, 'hub', 'left')).toEqual(first);
  });

  it('ignores edges with malformed handle ids', () => {
    const edges: Edge[] = [{ id: 'x', source: 'a', target: 'hub', sourceHandle: 'weird', targetHandle: 'also-weird' }];
    expect(getEdgesOnSide(edges, 'hub', 'left')).toHaveLength(0);
  });

  it('matches the legacy getAllEdgesForSide filtering', () => {
    const edges = [
      edge('a-hub', 'a', 'hub'),
      edge('hub-b', 'hub', 'b', 'left'),
      edge('hub-c', 'hub', 'c', 'right'),
    ];
    expect(getAllEdgesForSide(edges, 'hub', 'left')).toEqual(['a-hub', 'hub-b']);
  });
});

describe('sortEdgesForSide', () => {
  const edges = [edge('a-hub', 'a', 'hub'), edge('b-hub', 'b', 'hub'), edge('c-hub', 'c', 'hub')];
  const group = getEdgesOnSide(edges, 'hub', 'left');

  it('orders left/right sides by the neighbour Y position', () => {
    const positions: NodePositionMap = new Map([
      ['a', { x: 0, y: 300 }],
      ['b', { x: 0, y: 100 }],
      ['c', { x: 0, y: 200 }],
    ]);
    expect(sortEdgesForSide(group, 'hub', 'left', positions)).toEqual(['b-hub', 'c-hub', 'a-hub']);
  });

  it('orders top/bottom sides by the neighbour X position', () => {
    const topEdges = [edge('a-hub', 'a', 'hub', 'bottom', 'top'), edge('b-hub', 'b', 'hub', 'bottom', 'top')];
    const topGroup = getEdgesOnSide(topEdges, 'hub', 'top');
    const positions: NodePositionMap = new Map([
      ['a', { x: 500, y: 0 }],
      ['b', { x: 10, y: 0 }],
    ]);
    expect(sortEdgesForSide(topGroup, 'hub', 'top', positions)).toEqual(['b-hub', 'a-hub']);
  });

  it('re-sorts when neighbour positions change (not frozen at first call)', () => {
    const before: NodePositionMap = new Map([['a', { x: 0, y: 0 }], ['b', { x: 0, y: 100 }], ['c', { x: 0, y: 200 }]]);
    const after: NodePositionMap = new Map([['a', { x: 0, y: 250 }], ['b', { x: 0, y: 100 }], ['c', { x: 0, y: 200 }]]);
    expect(sortEdgesForSide(group, 'hub', 'left', before)).toEqual(['a-hub', 'b-hub', 'c-hub']);
    expect(sortEdgesForSide(group, 'hub', 'left', after)).toEqual(['b-hub', 'c-hub', 'a-hub']);
  });

  it('does not mutate the cached group', () => {
    const positions: NodePositionMap = new Map([['a', { x: 0, y: 300 }], ['b', { x: 0, y: 100 }], ['c', { x: 0, y: 200 }]]);
    sortEdgesForSide(group, 'hub', 'left', positions);
    expect(group.map((e) => e.id)).toEqual(['a-hub', 'b-hub', 'c-hub']);
  });

  it('falls back to alphabetical order without positions', () => {
    expect(sortEdgesForSide(group, 'hub', 'left')).toEqual(['a-hub', 'b-hub', 'c-hub']);
  });
});

describe('calculateEdgeOffsetInGroup', () => {
  it('matches calculateEdgeOffset for the same inputs', () => {
    const edges = [edge('a-hub', 'a', 'hub'), edge('b-hub', 'b', 'hub'), edge('c-hub', 'c', 'hub')];
    const positions: NodePositionMap = new Map([['a', { x: 0, y: 300 }], ['b', { x: 0, y: 100 }], ['c', { x: 0, y: 200 }]]);
    const group = getEdgesOnSide(edges, 'hub', 'left');
    for (const id of ['a-hub', 'b-hub', 'c-hub']) {
      expect(calculateEdgeOffsetInGroup(id, 'hub', 'left', group, 200, positions))
        .toEqual(calculateEdgeOffset(id, 'hub', 'left', false, edges, 200, positions));
    }
    // Three edges on a 200px side: slots at 50/100/150 → offsets -50/0/+50 in sorted order b,c,a
    expect(calculateEdgeOffsetInGroup('b-hub', 'hub', 'left', group, 200, positions)).toEqual({ x: 0, y: -50 });
    expect(calculateEdgeOffsetInGroup('a-hub', 'hub', 'left', group, 200, positions)).toEqual({ x: 0, y: 50 });
  });

  it('returns zero offset when the edge is not in the group', () => {
    expect(calculateEdgeOffsetInGroup('missing', 'hub', 'left', [], 200)).toEqual({ x: 0, y: 0 });
  });
});

describe('buildPositionsKey', () => {
  it('produces a stable key for unchanged positions and a new key when a node moves', () => {
    const lookup = new Map<string, { position: { x: number; y: number }; internals?: { positionAbsolute?: { x: number; y: number } } }>([
      ['a', { position: { x: 0, y: 0 }, internals: { positionAbsolute: { x: 10, y: 20 } } }],
      ['b', { position: { x: 5, y: 5 } }],
    ]);
    const k1 = buildPositionsKey(lookup, ['a', 'b']);
    const k2 = buildPositionsKey(lookup, ['a', 'b']);
    expect(k1).toBe(k2);
    expect(k1).toBe('10,20;5,5;');

    // In-place mutation (as React Flow does) changes the key value
    lookup.get('a')!.internals!.positionAbsolute = { x: 300, y: 20 };
    expect(buildPositionsKey(lookup, ['a', 'b'])).not.toBe(k1);
  });

  it('tolerates unknown node ids', () => {
    expect(buildPositionsKey(new Map(), ['ghost'])).toBe(';');
  });
});
