// @vitest-environment jsdom
/**
 * A relationship drawn backwards (#163, `keysContradict`) carries an amber ⚠
 * whose hover text is the sentence the exports write, and Turn round posts ⇄
 * — the host stores the link the right way round. Readers see neither.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type React from 'react';

// Labels render in place (the real component portals into the canvas's label layer).
vi.mock('../../src/components/Graph/EdgeLabels', () => ({
  EdgeLabels: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@xyflow/react', () => ({
  getSmoothStepPath: () => ['M 0,0 L 100,100'],
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
  useStore: (selector: (s: { edges: unknown[]; nodeLookup: Map<string, unknown> }) => unknown) => selector({ edges: [], nodeLookup: new Map() }),
  useStoreApi: () => ({ getState: () => ({ nodeLookup: new Map() }) }),
  useInternalNode: () => undefined,
}));

import { FkEdge } from '../../src/components/Graph/FkEdge';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import type { FkEdgeData } from '../../src/types/graph';

afterEach(cleanup);

const BACKWARDS: FkEdgeData = {
  fromModel: 'dim_product', fromColumn: 'product_key', toModel: 'fct_order', toColumn: 'product_key',
  cardinality: 'many-to-one', stage: 'logical', keysContradict: true,
};

function renderEdge(data: FkEdgeData, viewer = false) {
  const postMessage = vi.fn();
  const Edge = FkEdge as unknown as React.ComponentType<Record<string, unknown>>;
  const { container } = render(
    <CanvasEnvironmentProvider host={{ postMessage }} viewer={viewer}>
      <svg>
        <Edge id="e" sourceX={0} sourceY={0} targetX={100} targetY={100} sourcePosition="right" targetPosition="left"
          sourceHandleId="node-right-src" targetHandleId="node-left-tgt" data={data} />
      </svg>
    </CanvasEnvironmentProvider>,
  );
  return { container, postMessage };
}

describe('FkEdge — drawn backwards (#163)', () => {
  it('shows a ⚠ whose hover text says why', () => {
    const icon = renderEdge(BACKWARDS).container.querySelector('.fk-edge__backwards-icon');
    expect(icon?.getAttribute('title')).toBe("This starts at dim_product's key (product_key), so it was probably drawn backwards.");
  });

  it('Turn round posts ⇄ on the stored ends', () => {
    const { container, postMessage } = renderEdge(BACKWARDS);
    fireEvent.mouseEnter(container.querySelector('.fk-edge__backwards')!);
    fireEvent.click(container.querySelector('.fk-edge__backwards-btn')!);
    expect(postMessage).toHaveBeenCalledWith({
      type: 'updateRelationship',
      payload: { fromModel: 'dim_product', fromColumn: 'product_key', toModel: 'fct_order', toColumn: 'product_key', cardinality: 'one-to-many' },
    });
  });

  it('takes the place of the ⇄ zone, which Turn round already is', () => {
    expect(renderEdge(BACKWARDS).container.querySelector('.fk-edge__swap-zone')).toBeNull();
    cleanup();
    const { keysContradict: _k, ...plain } = BACKWARDS;
    expect(renderEdge(plain).container.querySelector('.fk-edge__swap-zone')).not.toBeNull();
  });

  it('draws no ⚠ without the flag, on the read-only stage, or for a reader', () => {
    const { keysContradict: _k, ...plain } = BACKWARDS;
    expect(renderEdge(plain).container.querySelector('.fk-edge__backwards')).toBeNull();
    cleanup();
    expect(renderEdge({ ...BACKWARDS, readOnly: true }).container.querySelector('.fk-edge__backwards')).toBeNull();
    cleanup();
    expect(renderEdge(BACKWARDS, true).container.querySelector('.fk-edge__backwards')).toBeNull();
  });
});
