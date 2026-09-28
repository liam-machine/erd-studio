// @vitest-environment jsdom
/**
 * `meta:` on the canvas hover cards (#95 follow-up): hovering a model's name
 * or one of its columns shows the metadata next to the description, the way
 * the Detail panel does — so owner / source system / lineage can be read
 * without opening the panel.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
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

import { ModelNode } from '../../src/components/Graph/ModelNode';
import { hasTooltipContent } from '../../src/components/Graph/ColumnTooltip';
import { metaRows } from '../../src/lib/metaFormat';
import type { ColumnDisplay, ModelFlowNode } from '../../src/types/graph';

const col = (extra: Partial<ColumnDisplay> = {}): ColumnDisplay => ({
  name: 'status',
  dataType: 'string',
  isPrimaryKey: false,
  isForeignKey: false,
  isNaturalKey: false,
  ...extra,
});

function renderNode(extra: Partial<ModelFlowNode['data']> = {}, columns: ColumnDisplay[] = [col()]) {
  const data: ModelFlowNode['data'] = {
    modelName: 'dim_customer',
    stage: 'logical',
    layer: 'silver',
    columns,
    isStub: false,
    readOnly: false,
    ...extra,
  };
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  return render(<Node data={data} selected={false} />);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

/** Hover an element and let the 450ms open delay elapse. */
function hover(el: Element) {
  fireEvent.mouseEnter(el);
  act(() => { vi.advanceTimersByTime(500); });
}

describe('metaRows', () => {
  it('lists entries in file order with nested values flattened to one line', () => {
    expect(metaRows({ owner: 'crm-team', lineage: { upstream: ['stg_a', 'stg_b'] }, pii: true })).toEqual([
      ['owner', 'crm-team'],
      ['lineage', '{ upstream: [stg_a, stg_b] }'],
      ['pii', 'true'],
    ]);
    expect(metaRows(undefined)).toEqual([]);
  });
});

describe('model name hover card', () => {
  it('lists the model meta under the name', () => {
    const { container } = renderNode({ meta: { owner: 'crm-team', source_system: 'Salesforce' } });
    hover(container.querySelector('.model-node__name')!);

    const tip = document.querySelector('.hover-tip')!;
    expect(tip.textContent).toContain('dim_customer');
    const rows = [...tip.querySelectorAll('.hover-tip__row')].map((r) => [
      r.querySelector('.hover-tip__label')!.textContent,
      r.querySelector('.hover-tip__value')!.textContent,
    ]);
    expect(rows).toEqual([['owner', 'crm-team'], ['source_system', 'Salesforce']]);
  });

  it('reads the meta to a screen reader too', () => {
    const { container } = renderNode({ meta: { owner: 'crm-team' } });
    expect(container.querySelector('.model-node__name')!.getAttribute('aria-label')).toBe('dim_customer; owner: crm-team');
  });

  it('shows no rows section for a model without meta', () => {
    const { container } = renderNode();
    hover(container.querySelector('.model-node__name')!);
    expect(document.querySelector('.hover-tip')!.textContent).toBe('dim_customer');
    expect(document.querySelector('.hover-tip__rows')).toBeNull();
  });
});

describe('column hover card', () => {
  it('counts meta alone as something worth a tooltip', () => {
    expect(hasTooltipContent(col())).toBe(false);
    expect(hasTooltipContent(col({ meta: { owner: 'x' } }))).toBe(true);
    expect(hasTooltipContent(col({ meta: {} }))).toBe(false);
  });

  it('shows the column meta next to its description', () => {
    const { container } = renderNode({}, [col({ description: 'Account status', meta: { source: 'CRM', tags: ['pii'] } })]);
    hover(container.querySelector('.model-node__column')!);

    const tip = document.querySelector('.column-tooltip')!;
    expect(tip.querySelector('.column-tooltip__description')!.textContent).toBe('Account status');
    const meta = tip.querySelector('.column-tooltip__meta')!;
    expect(meta.textContent).toContain('Metadata');
    const keys = [...meta.querySelectorAll('.column-tooltip__meta-key')].map((k) => k.textContent);
    expect(keys).toEqual(['source', 'tags']);
    expect(meta.textContent).toContain('[pii]');
  });
});
