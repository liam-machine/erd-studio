// @vitest-environment jsdom
/**
 * The node header's muted "+n" chip: relationships to tables not on this
 * diagram, from the editing host's canvas context. No context (the viewer,
 * an older host) or the physical stage: no chip.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type React from 'react';
import type { CanvasContext, DisplaySubjectArea } from '@erd-studio/core';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

import { TableNode } from '../../src/components/Graph/ModelNode';
import { CanvasStoreProvider, createCanvasStore } from '../../src/store/editorStore';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import type { TableFlowNode } from '../../src/types/graph';

afterEach(cleanup);

const col = { name: 'sale_key', dataType: 'int', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false };

function domain(stage: 'logical' | 'physical' = 'logical', extra: string[] = []): DisplaySubjectArea {
  return {
    schemaVersion: 7, domain: 'sales', layer: 'gold', stage, description: '', viewConfig: {}, readOnly: stage === 'physical', positionDraggable: true,
    models: ['fct_sale', ...extra].map((name) => ({ name, schema: 'gold', description: '', columns: [] })),
    relationships: [],
  } as DisplaySubjectArea;
}

const CONTEXT: CanvasContext = {
  tableFiles: { fct_sale: '.erd-studio/gold/tables/gold/fct_sale.dbml' },
  offDiagram: {
    fct_sale: [
      { otherTable: 'dim_store', otherLayer: 'Silver', columns: 'store_key', cardinality: 'many-to-one', direction: 'out' },
      { otherTable: 'dim_date', columns: 'date_key', cardinality: 'many-to-one', direction: 'out' },
      { otherTable: 'fct_return', columns: 'sale_key', cardinality: 'many-to-one', direction: 'in' },
    ],
  },
};

function renderNode(options: { context?: CanvasContext | null; stage?: 'logical' | 'physical'; viewer?: boolean; extra?: string[] } = {}) {
  const store = createCanvasStore({
    domain: domain(options.stage, options.extra),
    canvasContext: options.context === undefined ? CONTEXT : options.context,
  });
  const data: TableFlowNode['data'] = {
    modelName: 'fct_sale', stage: options.stage ?? 'logical', layer: 'gold', isStub: false, readOnly: options.stage === 'physical', columns: [col],
  };
  const Node = TableNode as unknown as React.ComponentType<{ id: string; data: TableFlowNode['data']; selected: boolean }>;
  const utils = render(
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider viewer={options.viewer ?? false}>
        <Node id="fct_sale" data={data} selected={false} />
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>,
  );
  return { ...utils, store, chip: () => utils.container.querySelector('.model-node__off-diagram') };
}

describe('TableNode — relationships off this diagram', () => {
  it('shows "+3" with a tip saying what it counts', () => {
    const { chip } = renderNode();
    expect(chip()?.textContent).toBe('+3');
    expect(chip()?.getAttribute('aria-label')).toBe('3 relationships to tables not on this diagram');
  });

  it('counts down as the other tables are added to the diagram', () => {
    const { chip, store } = renderNode();
    act(() => { store.getState().setDomain(domain('logical', ['dim_store', 'dim_date'])); });
    expect(chip()?.textContent).toBe('+1');
    expect(chip()?.getAttribute('aria-label')).toBe('1 relationship to a table not on this diagram');
    act(() => { store.getState().setDomain(domain('logical', ['dim_store', 'dim_date', 'fct_return'])); });
    expect(chip()).toBeNull();
  });

  it('shows nothing without the host\'s context (an older host)', () => {
    expect(renderNode({ context: null }).chip()).toBeNull();
  });

  it('shows nothing in the viewer, even given a context', () => {
    expect(renderNode({ viewer: true }).chip()).toBeNull();
  });

  it('shows nothing on the physical stage', () => {
    expect(renderNode({ stage: 'physical' }).chip()).toBeNull();
  });
});
