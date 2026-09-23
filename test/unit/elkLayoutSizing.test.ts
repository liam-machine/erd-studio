// The node sizing tests moved with the sizing code to
// packages/renderer/test/unit/nodeSizing.test.ts; the ELK child-building that
// uses those sizes stays here with the runner.
import { describe, it, expect } from 'vitest';
import { estimateNodeHeight, toElkChildren } from '../../webview/lib/elkLayout';
import { COLLAPSED_COLUMN_LIMIT } from '@erd-studio/renderer/editor';
import type { ModelFlowNode, ColumnDisplay } from '@erd-studio/renderer/editor';

function cols(n: number, keyEvery = 0): ColumnDisplay[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `c${i}`,
    dataType: 'string',
    isPrimaryKey: i === 0,
    isForeignKey: false,
    isNaturalKey: keyEvery > 0 && i > 0 && i % keyEvery === 0,
  }));
}

function node(columns: ColumnDisplay[], extra: Partial<ModelFlowNode['data']> = {}, measured?: { width: number; height: number }): ModelFlowNode {
  return {
    id: 'n',
    type: 'model',
    position: { x: 0, y: 0 },
    ...(measured ? { measured } : {}),
    data: { modelName: 'n', stage: 'logical', layer: 'silver', columns, isStub: false, ...extra },
  };
}

describe('toElkChildren', () => {
  it('uses measured size when present and the collapse-aware estimate otherwise', () => {
    const measured = { ...node(cols(60), {}, { width: 300, height: 180 }), id: 'measured' };
    const unmeasured = { ...node(cols(60)), id: 'unmeasured' };
    const children = toElkChildren([measured, unmeasured], null);
    expect(children[0]).toMatchObject({ id: 'measured', width: 300, height: 180 });
    expect(children[1].height).toBe(estimateNodeHeight(COLLAPSED_COLUMN_LIMIT + 1, false));
    expect(children[1].layoutOptions).toBeUndefined();
  });

  it('adds partition layout options when partitions are provided', () => {
    const children = toElkChildren([{ ...node(cols(1)), id: 'a' }], new Map([['a', 3]]));
    expect(children[0].layoutOptions).toEqual({ 'elk.partitioning.partition': '3' });
  });
});
