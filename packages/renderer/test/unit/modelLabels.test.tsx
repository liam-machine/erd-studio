// @vitest-environment jsdom
/**
 * Model labels: a model's name is its identity, its alias is the table name
 * it builds as — and the table name is what the canvas headline reads.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import type React from 'react';

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

import { computeModelLabels, matchesModelSearch } from '../../src/lib/modelLabels';
import { transformDomain } from '../../src/lib/graphTransformer';
import { estimateNodeWidth } from '../../src/lib/nodeSizing';
import { ModelNode } from '../../src/components/Graph/ModelNode';
import type { DisplayDomain, DisplayModel } from '@erd-studio/core';
import type { ModelFlowNode } from '../../src/types/graph';

describe('computeModelLabels', () => {
  it('labels an aliased model with its table name, and leaves the rest alone', () => {
    const labels = computeModelLabels([
      { name: 'gold_date', schema: 'gold', alias: 'date' },
      { name: 'fct_sale', schema: 'gold' },
    ]);
    expect([...labels]).toEqual([['gold_date', 'date']]);
  });

  it('qualifies labels two models share by schema', () => {
    const labels = computeModelLabels([
      { name: 'silver_date', schema: 'silver', alias: 'date' },
      { name: 'gold_date', schema: 'gold', alias: 'Date' },
    ]);
    expect(labels.get('silver_date')).toBe('silver.date');
    expect(labels.get('gold_date')).toBe('gold.Date');
  });

  it('also qualifies a plain model whose name another model uses as its alias', () => {
    const labels = computeModelLabels([
      { name: 'date', schema: 'silver' },
      { name: 'gold_date', schema: 'gold', alias: 'date' },
    ]);
    expect(labels.get('date')).toBe('silver.date');
    expect(labels.get('gold_date')).toBe('gold.date');
  });

  it('cannot qualify a clash without a schema, so the label stays the alias', () => {
    const labels = computeModelLabels([
      { name: 'a_date', alias: 'date' },
      { name: 'b_date', alias: 'date' },
    ]);
    expect(labels.get('a_date')).toBe('date');
  });

  it('search matches the name or the label', () => {
    expect(matchesModelSearch({ modelName: 'gold_date', label: 'date' }, 'gold')).toBe(true);
    expect(matchesModelSearch({ modelName: 'gold_date', label: 'calendar' }, 'calen')).toBe(true);
    expect(matchesModelSearch({ modelName: 'fct_sale' }, 'calen')).toBe(false);
  });
});

describe('transformDomain: node labels', () => {
  const model = (name: string, extra: Partial<DisplayModel> = {}): DisplayModel =>
    ({ name, schema: 'gold', description: '', columns: [], ...extra });
  const domain = (models: DisplayModel[]): DisplayDomain => ({
    schemaVersion: 5, domain: 'finance', layer: 'gold', stage: 'logical', description: '',
    models, relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true,
  });

  it('sets label only on the aliased node; the id stays the model name', () => {
    const { nodes } = transformDomain(domain([model('gold_date', { alias: 'date' }), model('fct_sale')]));
    const byId = new Map(nodes.map((n) => [n.id, n as ModelFlowNode]));
    expect(byId.get('gold_date')!.data.label).toBe('date');
    expect(byId.get('gold_date')!.data.modelName).toBe('gold_date');
    expect(byId.get('fct_sale')!.data).not.toHaveProperty('label');
  });

  it('reserves width for the label and the model name beside it', () => {
    const plain = estimateNodeWidth({ modelName: 'a_really_long_model_name_for_the_gold_layer_date', columns: [] });
    const labelled = estimateNodeWidth({ modelName: 'a_really_long_model_name_for_the_gold_layer_date', label: 'date', columns: [] });
    const longLabel = estimateNodeWidth({ modelName: 'a_really_long_model_name_for_the_gold_layer_date', label: 'a_really_long_table_name_for_dates', columns: [] });
    expect(labelled).toBeLessThan(plain); // the name is set smaller beside a short label
    expect(longLabel).toBeGreaterThan(plain);
  });
});

describe('ModelNode header', () => {
  function renderNode(extra: Partial<ModelFlowNode['data']>) {
    const data: ModelFlowNode['data'] = {
      modelName: 'gold_date', stage: 'logical', layer: 'gold', columns: [], isStub: false, ...extra,
    };
    const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
    return render(<Node data={data} selected={false} />);
  }

  it('reads as the table name, with the model name beside it', () => {
    const { container } = renderNode({ label: 'date' });
    const name = container.querySelector('.model-node__name')!;
    expect(name.firstChild?.textContent).toBe('date');
    expect(container.querySelector('.model-node__model-id')!.textContent).toBe('gold_date');
    expect(name.getAttribute('aria-label')).toBe('date (model gold_date)');
  });

  it('is unchanged for a model without a label', () => {
    const { container } = renderNode({});
    expect(container.querySelector('.model-node__name')!.textContent).toBe('gold_date');
    expect(container.querySelector('.model-node__model-id')).toBeNull();
  });
});

describe('AliasEditor (detail panel "Table name")', () => {
  async function setup(alias?: string, readOnly = false) {
    const { fireEvent } = await import('@testing-library/react');
    const { AliasEditor } = await import('../../src/components/DetailPanel/AliasEditor');
    const { CanvasEnvironmentProvider } = await import('../../src/host/canvasEnvironment');
    const posted: unknown[] = [];
    const utils = render(
      <CanvasEnvironmentProvider host={{ postMessage: (m) => posted.push(m) }}>
        <AliasEditor modelName="gold_date" alias={alias} readOnly={readOnly} />
      </CanvasEnvironmentProvider>,
    );
    return { ...utils, posted, fireEvent };
  }

  it('shows the model name, dimmed, when there is no alias', async () => {
    const { container } = await setup();
    const value = container.querySelector('.detail-panel__value')!;
    expect(value.textContent).toBe('gold_date');
    expect(value.className).toContain('detail-panel__value--muted');
  });

  it('posts one updateModelAlias for Enter, even when blur follows', async () => {
    const { container, posted, fireEvent } = await setup();
    fireEvent.click(container.querySelector('.detail-panel__alias-edit-btn')!);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'date' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(posted).toEqual([{ type: 'updateModelAlias', payload: { modelName: 'gold_date', alias: 'date' } }]);
  });

  it('refuses a table name that is not an identifier and posts nothing', async () => {
    const { container, posted, fireEvent } = await setup('date');
    fireEvent.click(container.querySelector('.detail-panel__alias-edit-btn')!);
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'gold.date' } });
    expect(container.querySelector('.detail-panel__alias-hint--error')).not.toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(posted).toEqual([]);
  });

  it('offers no edit when read-only', async () => {
    const { container } = await setup('date', true);
    expect(container.querySelector('.detail-panel__alias-edit-btn')).toBeNull();
    expect(container.querySelector('.detail-panel__value')!.textContent).toBe('date');
  });
});
