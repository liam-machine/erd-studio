import { describe, it, expect } from 'vitest';
import { transformDomain, pickHandleSides } from '../../webview/lib/graphTransformer';
import type { DisplayDomain, DisplayModel } from '../../src/types/display';
import type { FkFlowEdge } from '../../webview/types/graph';

function col(name: string, isPrimaryKey = false) {
  return { name, dataType: 'string', isPrimaryKey, isForeignKey: false, isNaturalKey: false };
}

function model(name: string, columnCount: number): DisplayModel {
  return {
    name,
    columns: Array.from({ length: columnCount }, (_, i) => col(i === 0 ? `${name}_id` : `c${i}`, i === 0)),
  } as DisplayModel;
}

function domain(models: DisplayModel[], positions: Record<string, { x: number; y: number }>, rels: Array<[string, string]>): DisplayDomain {
  return {
    domain: 'test',
    layer: 'silver',
    stage: 'logical',
    models,
    relationships: rels.map(([from, to]) => ({
      fromModel: from,
      fromColumn: `${to}_id`,
      toModel: to,
      toColumn: `${to}_id`,
      cardinality: 'many-to-one' as const,
    })),
    viewConfig: { positions },
    readOnly: false,
  } as unknown as DisplayDomain;
}

describe('pickHandleSides', () => {
  it('uses node centres, not top-left corners', () => {
    // Tall source whose centre is well below the short target's centre, even
    // though the top-left corners are nearly level and the target is to the right.
    const tall = { x: 0, y: 0, width: 200, height: 1200 };
    const short = { x: 300, y: 0, width: 200, height: 100 };
    // Corner delta: dx=300, dy=0 → old logic said right/left.
    // Centre delta: dx=300, dy=-550 → vertical wins → top/bottom.
    expect(pickHandleSides(tall, short)).toEqual({ sourceSide: 'top', targetSide: 'bottom' });
  });

  it('routes horizontally when the horizontal centre distance dominates', () => {
    const a = { x: 0, y: 0, width: 200, height: 100 };
    const b = { x: 600, y: 50, width: 200, height: 100 };
    expect(pickHandleSides(a, b)).toEqual({ sourceSide: 'right', targetSide: 'left' });
    expect(pickHandleSides(b, a)).toEqual({ sourceSide: 'left', targetSide: 'right' });
  });

  it('routes vertically when the vertical centre distance dominates', () => {
    const a = { x: 0, y: 0, width: 200, height: 100 };
    const b = { x: 20, y: 500, width: 200, height: 100 };
    expect(pickHandleSides(a, b)).toEqual({ sourceSide: 'bottom', targetSide: 'top' });
  });
});

describe('transformDomain handle sides', () => {
  it('uses measured dimensions from options.nodeDimensions when available', () => {
    const d = domain(
      [model('fct_wide', 2), model('dim_small', 2)],
      { fct_wide: { x: 0, y: 0 }, dim_small: { x: 300, y: 0 } },
      [['fct_wide', 'dim_small']],
    );
    // Without measurements both are ~equal height → horizontal
    const plain = transformDomain(d);
    const plainEdge = plain.edges[0] as FkFlowEdge;
    expect(plainEdge.sourceHandle).toBe('node-right-src');

    // With a measured very tall source → centre is far below → vertical
    const measured = transformDomain(d, {
      nodeDimensions: new Map([
        ['fct_wide', { width: 280, height: 1400 }],
        ['dim_small', { width: 280, height: 100 }],
      ]),
    });
    const measuredEdge = measured.edges[0] as FkFlowEdge;
    expect(measuredEdge.sourceHandle).toBe('node-top-src');
    expect(measuredEdge.targetHandle).toBe('node-bottom-tgt');
  });

  it('falls back to a collapse-aware estimate when a node is unmeasured', () => {
    // 60-column fact, collapsed: estimate is ~6 rows tall, so it should still
    // route horizontally to a neighbour on the right.
    const d = domain(
      [model('fct_wide', 60), model('dim_small', 2)],
      { fct_wide: { x: 0, y: 0 }, dim_small: { x: 400, y: 0 } },
      [['fct_wide', 'dim_small']],
    );
    const collapsed = transformDomain(d, { isExpanded: () => false });
    expect((collapsed.edges[0] as FkFlowEdge).sourceHandle).toBe('node-right-src');

    // Expanded: 60 rows (~1500px) → centre far below → vertical
    const expanded = transformDomain(d, { isExpanded: () => true });
    expect((expanded.edges[0] as FkFlowEdge).sourceHandle).toBe('node-top-src');
  });
});
