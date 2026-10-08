// @vitest-environment jsdom
/**
 * A composite foreign key is one line (#133 L2): a "⧉ N" chip says how many
 * column pairs it joins, the hover text lists them, and ⇄ posts the first
 * pair — the host turns the whole group round.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type React from 'react';

vi.mock('@xyflow/react', () => ({
  getSmoothStepPath: () => ['M 0,0 L 100,100'],
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useStore: (selector: (s: { edges: unknown[]; nodeLookup: Map<string, unknown> }) => unknown) => selector({ edges: [], nodeLookup: new Map() }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }) }),
  useInternalNode: () => undefined,
}));

import { FkEdge } from '../../src/components/Graph/FkEdge';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import type { FkEdgeData } from '../../src/types/graph';

afterEach(cleanup);

const PIT: FkEdgeData = {
  fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk',
  cardinality: 'many-to-one', role: 'as of', stage: 'logical', compositeKey: 'fk_sat_customer',
  pairs: [{ fromColumn: 'customer_hk', toColumn: 'customer_hk' }, { fromColumn: 'as_of_date', toColumn: 'load_date' }],
};

function renderEdge(data: FkEdgeData) {
  const postMessage = vi.fn();
  const Edge = FkEdge as unknown as React.ComponentType<Record<string, unknown>>;
  const { container } = render(
    <CanvasEnvironmentProvider host={{ postMessage }}>
      <svg>
        <Edge id="e" sourceX={0} sourceY={0} targetX={100} targetY={100} sourcePosition="right" targetPosition="left"
          sourceHandleId="node-right-src" targetHandleId="node-left-tgt" data={data} />
      </svg>
    </CanvasEnvironmentProvider>,
  );
  return { container, postMessage };
}

describe('FkEdge — composite foreign key (#133 L2)', () => {
  it('shows a ⧉ N chip and lists every pair in the hover text', () => {
    const { container } = renderEdge(PIT);
    expect(container.querySelector('.fk-edge__composite')?.textContent).toBe('⧉ 2');
    expect(container.querySelector('title')?.textContent)
      .toBe('pit_customer (customer_hk, as_of_date) → sat_customer (customer_hk, load_date) · many to one · role: as of');
  });

  it('a single-column link has no chip', () => {
    const { pairs: _p, compositeKey: _k, ...single } = PIT;
    expect(renderEdge(single).container.querySelector('.fk-edge__composite')).toBeNull();
  });

  it('⇄ posts the first pair, with the swapped cardinality', () => {
    const { container, postMessage } = renderEdge(PIT);
    fireEvent.mouseEnter(container.querySelector('.fk-edge__swap-zone')!);
    fireEvent.click(container.querySelector('.fk-edge__swap-btn')!);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updateRelationship',
      payload: { fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'one-to-many' },
    });
  });
});
