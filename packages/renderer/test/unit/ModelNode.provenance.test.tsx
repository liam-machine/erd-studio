// @vitest-environment jsdom
/**
 * ModelNode provenance chip — the header badge naming where a physical model's
 * shape came from.
 *
 * `ModelNodeData` carries an index signature (React Flow's Node generic needs
 * one), so a field written by graphTransformer but never destructured in
 * ModelNode type-checks perfectly and ships doing nothing — which is exactly
 * how `hasRationale` and `modelRole` gained matching dead CSS. Only a render
 * assertion catches that, so this file is not optional.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively loads them
// ---------------------------------------------------------------------------

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

const noop = vi.fn();
const mockStoreState: Record<string, unknown> = {
  highlightedColumns: new Set<string>(),
  startDragLine: noop,
  updateDragLineMouse: noop,
  endDragLine: noop,
  dragLineState: null,
  openNodeContextMenu: noop,
};

vi.mock('../../src/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { ModelNode } from '../../src/components/Graph/ModelNode';
import type { ColumnDisplay, ModelFlowNode } from '../../src/types/graph';

function cols(...types: string[]): ColumnDisplay[] {
  return types.map((dataType, i) => ({
    name: `c${i}`,
    dataType,
    isPrimaryKey: i === 0,
    isForeignKey: false,
    isNaturalKey: false,
  }));
}

function renderNode(extra: Partial<ModelFlowNode['data']> = {}) {
  const data: ModelFlowNode['data'] = {
    modelName: 'dim_customer',
    stage: 'physical',
    layer: 'silver',
    columns: cols('string'),
    isStub: false,
    readOnly: true,
    ...extra,
  };
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  return render(<Node data={data} selected={false} />);
}

const chip = (container: HTMLElement) => container.querySelector('.model-node__source');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelNode provenance chip', () => {
  it('renders the chip for a catalog-typed model, with the verified modifier', () => {
    const { container } = renderNode({ provenance: { columns: ['catalog', 'yml'], types: 'catalog' } });

    const el = chip(container)!;
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('WH');
    expect(el.className).toContain('model-node__source--catalog');
    expect(el.getAttribute('aria-label')).toBe(
      'WH — types from the warehouse catalog; columns from the warehouse catalog and your dbt .yml',
    );
  });

  it('names the other three sources without the verified modifier', () => {
    for (const [types, label] of [['yml', 'YML'], ['manifest', 'DBT'], ['file', 'SQL']] as const) {
      const { container, unmount } = renderNode({ provenance: { columns: [types], types } });
      const el = chip(container)!;
      expect(el.textContent).toBe(label);
      expect(el.className).not.toContain('model-node__source--catalog');
      unmount();
    }
  });

  it('counts untyped columns locally — the count is not on the wire', () => {
    const { container } = renderNode({
      columns: cols('string', '', ''),
      provenance: { columns: ['yml'], types: 'yml' },
    });

    expect(chip(container)!.getAttribute('aria-label')).toBe(
      'YML — types from your dbt .yml; columns from your dbt .yml · 2 columns have no type',
    );
  });

  it('says "1 column has no type" in the singular', () => {
    const { container } = renderNode({
      columns: cols('string', ''),
      provenance: { columns: ['yml'], types: 'yml' },
    });

    expect(chip(container)!.getAttribute('aria-label')).toContain('· 1 column has no type');
  });

  it('renders no chip on a logical node, which carries no provenance', () => {
    const { container } = renderNode({ stage: 'logical', readOnly: false });
    expect(chip(container)).toBeNull();
    // The schema badge is still there — the chip is an addition, not a swap.
    expect(container.querySelector('.model-node__badge')).not.toBeNull();
  });

  it('sits between the model name and the schema badge', () => {
    const { container } = renderNode({
      schema: 'analytics',
      provenance: { columns: ['catalog'], types: 'catalog' },
    });

    const header = container.querySelector('.model-node__header')!;
    expect(Array.from(header.children).map((c) => c.className.split(' ')[0])).toEqual([
      'model-node__name',
      'model-node__source',
      'model-node__badge',
    ]);
    expect(screen.getByText('dim_customer')).toBeTruthy();
  });
});
