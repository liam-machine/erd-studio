// @vitest-environment jsdom
/**
 * FkEdge and the relationship model of issue #133: the ⇄ button says what it
 * does and sends the stored ends; an amber "?" flags a link that is stored
 * twice (REL001), on its "one" side (REL002) or against its keys (REL006) —
 * but only where the canvas can edit: never on a read-only stage and never in
 * the viewer.
 *
 * EdgeLabelRenderer portals into a React Flow viewport that a lone edge does
 * not have, so it is rendered inline here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, EdgeLabelRenderer: ({ children }: { children: ReactNode }) => <>{children}</> };
});

import { Position, ReactFlowProvider } from '@xyflow/react';
import { FkEdge } from '../../src/components/Graph/FkEdge';
import { CanvasEnvironmentProvider, type CanvasHost } from '../../src/host/canvasEnvironment';
import type { FkEdgeData } from '../../src/types/graph';

afterEach(cleanup);

const STORED = { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key' };

function edgeData(overrides: Partial<FkEdgeData> = {}): FkEdgeData {
  return {
    fromModel: 'fct_order',
    fromColumn: 'customer_key',
    toModel: 'dim_customer',
    toColumn: 'customer_key',
    cardinality: 'many-to-one',
    stage: 'logical',
    stored: STORED,
    ...overrides,
  };
}

function renderEdge(data: FkEdgeData, opts: { viewer?: boolean } = {}) {
  const host: CanvasHost = { postMessage: vi.fn() };
  const view = render(
    <CanvasEnvironmentProvider host={host} viewer={opts.viewer ?? false}>
      <ReactFlowProvider>
        <svg>
          <FkEdge
            id="fk-1"
            source="fct_order"
            target="dim_customer"
            sourceX={0}
            sourceY={0}
            targetX={300}
            targetY={0}
            sourcePosition={Position.Right}
            targetPosition={Position.Left}
            data={data}
            {...({} as Record<string, never>)}
          />
        </svg>
      </ReactFlowProvider>
    </CanvasEnvironmentProvider>,
  );
  return { ...view, host };
}

function swapButton(container: HTMLElement): HTMLButtonElement {
  fireEvent.mouseEnter(container.querySelector('.fk-edge__swap-zone')!);
  const button = container.querySelector<HTMLButtonElement>('.fk-edge__swap-btn');
  if (!button) throw new Error('no swap button');
  return button;
}

describe('FkEdge ⇄ (#133)', () => {
  it('says which model becomes the many side, and sends the stored ends', () => {
    const { container, host } = renderEdge(edgeData());
    const button = swapButton(container);
    expect(button.getAttribute('title')).toBe('Make dim_customer the many side');
    fireEvent.click(button);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'updateRelationship',
      payload: {
        fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key',
        stored: STORED,
        cardinality: 'one-to-many',
      },
    });
  });

  it('swaps the ends of a one-to-one through editRelationship, keeping the role', () => {
    const { container, host } = renderEdge(edgeData({ cardinality: 'one-to-one', role: 'billing' }));
    const button = swapButton(container);
    expect(button.getAttribute('title')).toBe('Make dim_customer the side that holds the foreign key');
    fireEvent.click(button);
    expect(host.postMessage).toHaveBeenCalledWith({
      type: 'editRelationship',
      payload: {
        originalFromModel: 'fct_order', originalFromColumn: 'customer_key',
        originalToModel: 'dim_customer', originalToColumn: 'customer_key',
        fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key',
        cardinality: 'one-to-one',
        role: 'billing',
        stored: STORED,
      },
    });
  });
});

describe('FkEdge "?" issue badge (#133)', () => {
  it('shows on an editable edge whose issues include REL001 / REL002 / REL006, listing them', () => {
    const { container } = renderEdge(edgeData({ issues: ['REL009', 'REL001', 'REL006'] }));
    const badge = container.querySelector<HTMLElement>('.fk-edge__issue-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('?');
    expect(badge!.getAttribute('data-issues')).toBe('REL001 REL006');
    const title = badge!.getAttribute('title')!;
    expect(title).toContain('REL001');
    expect(title).toContain('REL006');
    expect(title).not.toContain('REL009');
  });

  it('is absent when the edge has no badge-worthy issue', () => {
    expect(renderEdge(edgeData({ issues: ['REL009'] })).container.querySelector('.fk-edge__issue-badge')).toBeNull();
    cleanup();
    expect(renderEdge(edgeData()).container.querySelector('.fk-edge__issue-badge')).toBeNull();
  });

  it('is never shown on a read-only edge (physical stage)', () => {
    const { container } = renderEdge(edgeData({ readOnly: true, stage: 'physical', issues: ['REL001'] }));
    expect(container.querySelector('.fk-edge__issue-badge')).toBeNull();
    expect(container.querySelector('.fk-edge__swap-zone')).toBeNull();
  });

  it('is never shown in the viewer, whatever the edge says', () => {
    for (const readOnly of [true, false]) {
      const { container } = renderEdge(edgeData({ readOnly, issues: ['REL001', 'REL002'] }), { viewer: true });
      expect(container.querySelector('.fk-edge__issue-badge')).toBeNull();
      cleanup();
    }
  });
});
