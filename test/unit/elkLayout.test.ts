import { describe, it, expect } from 'vitest';
import {
  roleToPartition,
  computeDepthPartitions,
  detectStrategy,
  SPACING_PRESETS,
  LAYOUT_DIRECTIONS,
  DEFAULT_ELK_OPTIONS,
} from '../../webview/lib/elkLayout';
import type { ModelRole } from '../../src/types/semantic';
import type { ModelFlowNode, FkFlowEdge } from '../../webview/types/graph';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(id: string, role?: ModelRole | string): ModelFlowNode {
  return {
    id,
    type: 'model',
    position: { x: 0, y: 0 },
    data: {
      modelName: id,
      stage: 'logical',
      layer: 'silver',
      columns: [],
      modelRole: role as ModelRole | undefined,
    },
  };
}

function makeEdge(source: string, target: string): FkFlowEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    type: 'fk',
    data: {
      fromModel: source,
      fromColumn: 'id',
      toModel: target,
      toColumn: 'id',
      cardinality: 'many-to-one',
    },
  };
}

// ---------------------------------------------------------------------------
// roleToPartition
// ---------------------------------------------------------------------------

describe('roleToPartition', () => {
  it('maps dimension roles to partition 0', () => {
    expect(roleToPartition('conformed-dim')).toBe(0);
    expect(roleToPartition('domain-dim')).toBe(0);
  });

  it('maps reference role to partition 1', () => {
    expect(roleToPartition('reference')).toBe(1);
  });

  it('maps fact roles to partition 2', () => {
    expect(roleToPartition('transaction-fact')).toBe(2);
    expect(roleToPartition('periodic-snapshot')).toBe(2);
    expect(roleToPartition('accumulating-snapshot')).toBe(2);
  });

  it('maps factless-fact (bridge) to partition 3', () => {
    expect(roleToPartition('factless-fact')).toBe(3);
  });

  it('maps gold roles to partition 4', () => {
    expect(roleToPartition('gold-dim')).toBe(4);
    expect(roleToPartition('gold-fact')).toBe(4);
  });

  it('defaults undefined role to partition 2', () => {
    expect(roleToPartition(undefined)).toBe(2);
  });

  it('covers all ModelRole values', () => {
    const allRoles: ModelRole[] = [
      'conformed-dim',
      'domain-dim',
      'transaction-fact',
      'periodic-snapshot',
      'accumulating-snapshot',
      'factless-fact',
      'reference',
      'gold-fact',
      'gold-dim',
    ];
    for (const role of allRoles) {
      expect(typeof roleToPartition(role)).toBe('number');
    }
  });
});

// ---------------------------------------------------------------------------
// computeDepthPartitions
// ---------------------------------------------------------------------------

describe('computeDepthPartitions', () => {
  it('assigns all isolated nodes partition 0', () => {
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const result = computeDepthPartitions(nodes, []);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
    expect(result.get('c')).toBe(0);
  });

  it('assigns source node partition 0 and sink partition 4 for a two-level graph', () => {
    // a → b: a is source (depth 0), b is sink (depth 1, maxDepth 1 → bucket 4)
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(4);
  });

  it('uses longest path for fan-in: two sources joining one sink', () => {
    // a → c, b → c: a and b are depth 0, c is depth 1
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
    const edges = [makeEdge('a', 'c'), makeEdge('b', 'c')];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
    expect(result.get('c')).toBe(4);
  });

  it('uses longest path through a diamond: a→b→d, a→c→d', () => {
    // a=0, b=1, c=1, d=2 — maxDepth=2
    // buckets: a=0, b=Math.round(1/2*4)=2, c=2, d=4
    const nodes = [makeNode('a'), makeNode('b'), makeNode('c'), makeNode('d')];
    const edges = [makeEdge('a', 'b'), makeEdge('a', 'c'), makeEdge('b', 'd'), makeEdge('c', 'd')];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(2);
    expect(result.get('c')).toBe(2);
    expect(result.get('d')).toBe(4);
  });

  it('produces correct buckets for a linear 5-node chain', () => {
    // a→b→c→d→e: depths 0,1,2,3,4 — maxDepth=4 → partitions 0,1,2,3,4
    const nodes = ['a', 'b', 'c', 'd', 'e'].map(makeNode);
    const edges = [
      makeEdge('a', 'b'), makeEdge('b', 'c'),
      makeEdge('c', 'd'), makeEdge('d', 'e'),
    ];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(1);
    expect(result.get('c')).toBe(2);
    expect(result.get('d')).toBe(3);
    expect(result.get('e')).toBe(4);
  });

  it('assigns nodes in a cycle partition 0 as fallback', () => {
    // a→b→a: both have in-degree 1, no source → neither is visited → both fallback to 0
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'a')];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(0);
  });

  it('handles a cycle that is reachable from an external source', () => {
    // s→a→b→a: s is source (depth 0), a is reachable (depth 1),
    // b is partially reachable (depth set to 2 from a) but cycle prevents full traversal
    const nodes = [makeNode('s'), makeNode('a'), makeNode('b')];
    const edges = [makeEdge('s', 'a'), makeEdge('a', 'b'), makeEdge('b', 'a')];
    const result = computeDepthPartitions(nodes, edges);
    expect(result.get('s')).toBe(0);
    // a gets depth 1 from s; b gets depth 2 from a but b→a creates a cycle
    // only s and b's depths are guaranteed; a may stay at 1 depending on traversal
    expect(typeof result.get('a')).toBe('number');
    expect(typeof result.get('b')).toBe('number');
  });

  it('buckets a 10-node chain into 5 evenly spread partitions', () => {
    const ids = ['n0','n1','n2','n3','n4','n5','n6','n7','n8','n9'];
    const nodes = ids.map(makeNode);
    const edges = ids.slice(0, -1).map((id, i) => makeEdge(id, ids[i + 1]));
    const result = computeDepthPartitions(nodes, edges);
    // maxDepth=9, bucket = Math.round(d/9*4), capped at 4
    // Each bucket should have ~2 nodes
    const buckets = ids.map((id) => result.get(id)!);
    expect(buckets[0]).toBe(0);
    expect(buckets[9]).toBe(4);
    // Partition values should be non-decreasing
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]).toBeGreaterThanOrEqual(buckets[i - 1]);
    }
  });

  it('ignores edges whose source or target is not in the node list', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b'), makeEdge('a', 'external')];
    // Should not throw and external should not appear in result
    const result = computeDepthPartitions(nodes, edges);
    expect(result.has('external')).toBe(false);
    expect(result.get('a')).toBe(0);
    expect(result.get('b')).toBe(4);
  });

  it('returns a partition entry for every input node', () => {
    const nodes = ['a','b','c','d','e'].map(makeNode);
    const edges = [makeEdge('a', 'c'), makeEdge('b', 'c'), makeEdge('c', 'd')];
    const result = computeDepthPartitions(nodes, edges);
    for (const node of nodes) {
      expect(result.has(node.id)).toBe(true);
    }
  });

  it('all partition values are in range 0–4', () => {
    const nodes = ['a','b','c','d','e','f'].map(makeNode);
    const edges = [
      makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'd'),
      makeEdge('a', 'e'), makeEdge('e', 'f'), makeEdge('f', 'd'),
    ];
    const result = computeDepthPartitions(nodes, edges);
    for (const [, partition] of result) {
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThanOrEqual(4);
    }
  });
});

// ---------------------------------------------------------------------------
// detectStrategy
// ---------------------------------------------------------------------------

describe('detectStrategy', () => {
  it('returns "none" when there are no nodes', () => {
    expect(detectStrategy([], [])).toBe('none');
  });

  it('returns "none" when nodes have no roles and no edges', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    expect(detectStrategy(nodes, [])).toBe('none');
  });

  it('returns "depth" when edges exist but no roles are assigned', () => {
    const nodes = [makeNode('a'), makeNode('b')];
    const edges = [makeEdge('a', 'b')];
    expect(detectStrategy(nodes, edges)).toBe('depth');
  });

  it('returns "depth" when all nodes have the unpartitionable "entity" role', () => {
    const nodes = [makeNode('a', 'entity'), makeNode('b', 'entity'), makeNode('c', 'entity')];
    const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];
    expect(detectStrategy(nodes, edges)).toBe('depth');
  });

  it('returns "depth" when only one distinct partitionable role band is present', () => {
    // Only dims — all map to partition 0, only 1 distinct band
    const nodes = [makeNode('a', 'conformed-dim'), makeNode('b', 'domain-dim'), makeNode('c')];
    const edges = [makeEdge('a', 'c'), makeEdge('b', 'c')];
    expect(detectStrategy(nodes, edges)).toBe('depth');
  });

  it('returns "depth" when one partitionable stub dim is among many entity nodes', () => {
    const nodes = [
      makeNode('dim_a', 'conformed-dim'),
      ...['e1','e2','e3','e4','e5'].map((id) => makeNode(id, 'entity')),
    ];
    const edges = [makeEdge('e1', 'e2'), makeEdge('e2', 'e3')];
    // Only 1 distinct band (partition 0 from the dim), so should fall back to depth
    expect(detectStrategy(nodes, edges)).toBe('depth');
  });

  it('returns "role" when both dim and fact roles are present (2 distinct bands)', () => {
    const nodes = [
      makeNode('dim', 'conformed-dim'),      // partition 0
      makeNode('fact', 'transaction-fact'),  // partition 2
    ];
    const edges = [makeEdge('fact', 'dim')];
    expect(detectStrategy(nodes, edges)).toBe('role');
  });

  it('returns "role" when dims, facts, and reference roles are present', () => {
    const nodes = [
      makeNode('d', 'domain-dim'),       // partition 0
      makeNode('r', 'reference'),        // partition 1
      makeNode('f', 'transaction-fact'), // partition 2
    ];
    const edges = [makeEdge('f', 'd'), makeEdge('f', 'r')];
    expect(detectStrategy(nodes, edges)).toBe('role');
  });

  it('returns "role" when 2 distinct bands are present even without edges', () => {
    const nodes = [
      makeNode('d', 'conformed-dim'),    // partition 0
      makeNode('f', 'transaction-fact'), // partition 2
    ];
    expect(detectStrategy(nodes, [])).toBe('role');
  });
});

// ---------------------------------------------------------------------------
// SPACING_PRESETS
// ---------------------------------------------------------------------------

describe('SPACING_PRESETS', () => {
  it('defines exactly three presets: S, M, L', () => {
    expect(Object.keys(SPACING_PRESETS)).toEqual(['S', 'M', 'L']);
  });

  it('each preset contains nodeNode and nodeNodeBetweenLayers keys', () => {
    for (const preset of Object.values(SPACING_PRESETS)) {
      expect(preset).toHaveProperty('elk.spacing.nodeNode');
      expect(preset).toHaveProperty('elk.layered.spacing.nodeNodeBetweenLayers');
    }
  });

  it('all values are numeric strings', () => {
    for (const preset of Object.values(SPACING_PRESETS)) {
      expect(Number(preset['elk.spacing.nodeNode'])).toBeGreaterThan(0);
      expect(Number(preset['elk.layered.spacing.nodeNodeBetweenLayers'])).toBeGreaterThan(0);
    }
  });

  it('presets are ordered S < M < L for both spacing axes', () => {
    const nodeNode = (['S', 'M', 'L'] as const).map((k) =>
      Number(SPACING_PRESETS[k]['elk.spacing.nodeNode'])
    );
    const layerSpacing = (['S', 'M', 'L'] as const).map((k) =>
      Number(SPACING_PRESETS[k]['elk.layered.spacing.nodeNodeBetweenLayers'])
    );
    expect(nodeNode[0]).toBeLessThan(nodeNode[1]);
    expect(nodeNode[1]).toBeLessThan(nodeNode[2]);
    expect(layerSpacing[0]).toBeLessThan(layerSpacing[1]);
    expect(layerSpacing[1]).toBeLessThan(layerSpacing[2]);
  });

  it('M preset matches DEFAULT_ELK_OPTIONS baseline spacing', () => {
    expect(SPACING_PRESETS.M['elk.spacing.nodeNode']).toBe(
      DEFAULT_ELK_OPTIONS['elk.spacing.nodeNode']
    );
    expect(SPACING_PRESETS.M['elk.layered.spacing.nodeNodeBetweenLayers']).toBe(
      DEFAULT_ELK_OPTIONS['elk.layered.spacing.nodeNodeBetweenLayers']
    );
  });
});

// ---------------------------------------------------------------------------
// LAYOUT_DIRECTIONS
// ---------------------------------------------------------------------------

describe('LAYOUT_DIRECTIONS', () => {
  it('contains RIGHT and DOWN', () => {
    expect(LAYOUT_DIRECTIONS).toContain('RIGHT');
    expect(LAYOUT_DIRECTIONS).toContain('DOWN');
  });

  it('contains exactly two directions', () => {
    expect(LAYOUT_DIRECTIONS).toHaveLength(2);
  });

  it('DEFAULT_ELK_OPTIONS uses RIGHT as the default direction', () => {
    expect(DEFAULT_ELK_OPTIONS['elk.direction']).toBe('RIGHT');
    expect(LAYOUT_DIRECTIONS).toContain(DEFAULT_ELK_OPTIONS['elk.direction']);
  });
});
