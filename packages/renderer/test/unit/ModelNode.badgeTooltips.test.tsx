// @vitest-environment jsdom
/**
 * TableNode badge tooltips — what hovering a canvas badge actually says.
 *
 * Every abbreviation on a node is a word the user has not been told. The chips
 * are too small to hold the explanation, so the explanation lives in `title`,
 * and a `title` nobody asserts is a `title` that silently becomes `undefined`
 * — which is exactly what the schema badge was doing.
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

import { TableNode } from '../../src/components/Graph/ModelNode';
import type { ColumnDisplay, TableFlowNode } from '../../src/types/graph';
import { SCD_TITLE, ADDITIVE_TITLE } from '../../src/lib/badgeLabels';

function renderNode(extra: Partial<TableFlowNode['data']> = {}, columns?: ColumnDisplay[]) {
  const data: TableFlowNode['data'] = {
    modelName: 'dim_customer',
    stage: 'logical',
    layer: 'silver',
    columns: columns ?? [
      { name: 'customer_key', dataType: 'int', isPrimaryKey: true, isForeignKey: false, isNaturalKey: false },
    ],
    isStub: false,
    readOnly: false,
    ...extra,
  };
  const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
  return render(<Node data={data} selected={false} />);
}

describe('TableNode layer badge tooltip', () => {
  it('names the layer the table lives in, then its schema', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, schema: 'silver' });
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.textContent).toBe('SLV');
    expect(badge.getAttribute('aria-label')).toBe('Layer: silver\nSchema: silver');
  });

  it('says on the physical stage that dbt has resolved no schema', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true });
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.textContent).toBe('SLV');
    expect(badge.getAttribute('aria-label')).toBe(
      'Layer: silver\nNo dbt schema resolved (run dbt compile or dbt docs generate).',
    );
  });

  it('does not talk about dbt on the logical stage', () => {
    const { container } = renderNode();
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.getAttribute('aria-label')).toBe('Layer: silver');
    expect(badge.className).toBe('model-node__badge');
  });

  it('uses the layer config\'s abbreviation and label', () => {
    const { container } = renderNode({
      schema: 'sales',
      layerConfig: { id: 'silver', label: 'Silver', abbreviation: 'S', color: '#a0a0a0', order: 1, creatable: true },
    });
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.textContent).toBe('S');
    expect(badge.getAttribute('aria-label')).toBe('Layer: Silver\nSchema: sales');
  });
});

describe('TableNode column symbol tooltips', () => {
  const col = (extra: Partial<ColumnDisplay>): ColumnDisplay => ({
    name: 'status',
    dataType: 'string',
    isPrimaryKey: false,
    isForeignKey: false,
    isNaturalKey: false,
    ...extra,
  });

  it('spells out each SCD type rather than restating the number', () => {
    for (const scdType of [0, 1, 2] as const) {
      const { container, unmount } = renderNode({}, [col({ scdType })]);
      const badge = container.querySelector('.model-node__col-badge--scd')!;

      expect(badge.getAttribute('title')).toBe(SCD_TITLE[scdType]);
      expect(badge.getAttribute('title')).not.toBe(`SCD Type ${scdType}`);
      unmount();
    }
  });

  it('spells out each additivity symbol', () => {
    for (const additiveType of ['additive', 'semi-additive', 'non-additive'] as const) {
      const { container, unmount } = renderNode({}, [col({ additiveType })]);
      const badge = container.querySelector('.model-node__col-badge--additive')!;

      expect(badge.getAttribute('title')).toBe(ADDITIVE_TITLE[additiveType]);
      // The old title was the raw enum value, which taught nobody anything.
      expect(badge.getAttribute('title')).not.toBe(additiveType);
      unmount();
    }
  });
});

describe('TableNode comparison markers', () => {
  const missing = {
    name: 'churn_flag',
    status: 'missing' as const,
    targetDataType: 'boolean',
  };

  it('says what a struck-through ghost row means, naming both stages', () => {
    const { container } = renderNode({
      stage: 'logical',
      isExpanded: true,
      discrepancySourceStage: 'logical',
      discrepancyTargetStage: 'physical',
      discrepancy: { name: 'dim_customer', status: 'matched', columns: [missing] },
    });

    const row = container.querySelector('.model-node__column--disc-missing')!;
    expect(row.getAttribute('title')).toBe(
      'churn_flag is in physical but not in logical',
    );
  });

  it('labels the separator above those rows', () => {
    const { container } = renderNode({
      stage: 'logical',
      isExpanded: true,
      discrepancySourceStage: 'logical',
      discrepancyTargetStage: 'physical',
      discrepancy: { name: 'dim_customer', status: 'matched', columns: [missing] },
    });

    const sep = container.querySelector('.model-node__separator--disc')!;
    expect(sep.getAttribute('title')).toContain('physical has and logical does not');
  });

  it('explains the amber ring, which previously said nothing on hover', () => {
    const { container } = renderNode({
      stage: 'logical',
      discrepancySourceStage: 'logical',
      discrepancyTargetStage: 'physical',
      discrepancy: { name: 'dim_customer', status: 'extra', columns: [] },
    });

    expect(container.querySelector('.model-node')!.className).toContain('model-node--disc-extra');
    expect(container.querySelector('.model-node__name')!.getAttribute('aria-label')).toBe(
      'dim_customer \u2014 only in logical, not in physical',
    );
  });

  it('leaves an ordinary node showing just its name', () => {
    const { container } = renderNode();
    expect(container.querySelector('.model-node__name')!.getAttribute('aria-label')).toBe('dim_customer');
  });
});

describe('TableNode header hover card', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Hover an element and let the 450ms open delay elapse. */
  function hover(el: Element) {
    fireEvent.mouseEnter(el);
    act(() => { vi.advanceTimersByTime(500); });
  }

  const tip = () => document.querySelector('.hover-tip');

  it('shows the provenance chip explanation on hover, not via title', () => {
    const { container } = renderNode({
      stage: 'physical', readOnly: true, schema: 'silver',
      provenance: { columns: ['catalog'], types: 'catalog' },
    });
    const chip = container.querySelector('.model-node__source')!;

    // The mechanism the user found broken: a bare title on a drag surface.
    expect(chip.getAttribute('title')).toBeNull();
    expect(tip()).toBeNull();

    hover(chip);
    expect(tip()!.textContent).toContain('types from the warehouse catalog');
  });

  it('shows and hides as the pointer comes and goes', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, schema: 'silver' });
    const badge = container.querySelector('.model-node__badge')!;

    hover(badge);
    expect(tip()!.textContent).toBe('Layer: silver\nSchema: silver');

    fireEvent.mouseLeave(badge);
    expect(tip()).toBeNull();
  });

  it('does not open if the pointer leaves before the delay elapses', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, schema: 'silver' });
    const badge = container.querySelector('.model-node__badge')!;

    fireEvent.mouseEnter(badge);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.mouseLeave(badge);
    act(() => { vi.advanceTimersByTime(500); });

    expect(tip()).toBeNull();
  });

  it('renders no card for a node with no provenance chip', () => {
    const { container } = renderNode();
    expect(container.querySelector('.model-node__source')).toBeNull();
  });
});

describe('TableNode header: the table\'s own layer, its schema and its warehouse name', () => {
  const RAW = { id: 'raw_vault', label: 'Raw Vault', abbreviation: 'RV', color: '#64748b', order: 0, creatable: true };
  const BUSINESS = { id: 'business_vault', label: 'Business Vault', abbreviation: 'BV', color: '#8b5cf6', order: 1, creatable: true };

  it('badges a table with its own layer and colour, not the diagram\'s, and says it is borrowed', () => {
    const { container } = renderNode({
      modelName: 'hub_customer', layer: 'business_vault', layerConfig: BUSINESS, schema: 'raw_vault',
      tableLayer: 'raw_vault', tableLayerConfig: RAW, otherLayer: true,
    });
    const badge = container.querySelector('.model-node__badge')!;
    expect(badge.textContent).toBe('RV');
    expect(badge.getAttribute('aria-label')).toBe('Layer: Raw Vault\nSchema: raw_vault\nFrom another layer: this diagram is in Business Vault.');
    const node = container.querySelector('.model-node') as HTMLElement;
    expect(node.className).toContain('model-node--layered');
    expect(node.className).toContain('model-node--other-layer');
    expect(node.style.getPropertyValue('--model-node-layer-color')).toBe('#64748b');
  });

  it('reads the name as the sidebar does: the schema as a prefix when it is not the layer\'s name, then the name, then the alias', () => {
    const { container } = renderNode({
      modelName: 'zuora_account', schema: 'zuora', tableLayer: 'raw', shownSchema: 'zuora', alias: 'account', label: 'zuora.account',
    });
    const name = container.querySelector('.model-node__name')!;
    expect(container.querySelector('.model-node__schema')!.textContent).toBe('zuora.');
    expect(container.querySelector('.model-node__model-id')!.textContent).toBe('as account');
    expect(name.textContent).toBe('zuora.zuora_accountas account');
  });

  it('badges a table whose own layer is not known (YAML, physical) with the diagram\'s layer, and prefixes its schema', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, schema: 'analytics', shownSchema: 'analytics', alias: undefined });
    const badge = container.querySelector('.model-node__badge')!;
    expect(badge.textContent).toBe('SLV');
    expect(badge.getAttribute('aria-label')).toBe('Layer: silver\nSchema: analytics');
    expect(container.querySelector('.model-node__schema')!.textContent).toBe('analytics.');
    expect(container.querySelector('.model-node')!.className).not.toContain('model-node--layered');
  });
});

describe('TableNode in a single-layer project', () => {
  const ONLY = { id: 'silver', label: 'Silver', abbreviation: 'SLV', color: '#a0a0a0', order: 0, creatable: true };

  it('draws no layer badge and no strip, but keeps the schema prefix', () => {
    const { container } = renderNode({
      schema: 'sales', shownSchema: 'sales', tableLayer: 'silver', tableLayerConfig: ONLY, layerConfig: ONLY, singleLayer: true,
    });
    expect(container.querySelector('.model-node__badge')).toBeNull();
    expect(container.querySelector('.model-node')!.className).not.toContain('model-node--layered');
    expect(container.querySelector('.model-node__schema')!.textContent).toBe('sales.');
  });

  it('draws both in a project with more than one layer', () => {
    const { container } = renderNode({ tableLayer: 'silver', tableLayerConfig: ONLY, layerConfig: ONLY });
    expect(container.querySelector('.model-node__badge')!.textContent).toBe('SLV');
    expect(container.querySelector('.model-node')!.className).toContain('model-node--layered');
  });
});

describe('TableNode selection ring colour', () => {
  it('marks the stage being viewed, a ghost on the Physical tab included', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, isGhost: true, ghostReason: 'not-in-project' });
    const node = container.querySelector('.model-node')!;
    expect(node.className).toContain('model-node--ghost');
    expect(node.className).toContain('model-node--stage-physical');
  });
});
