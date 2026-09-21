// @vitest-environment jsdom
/**
 * ModelNode badge tooltips — what hovering a canvas badge actually says.
 *
 * Every abbreviation on a node is a word the user has not been told. The chips
 * are too small to hold the explanation, so the explanation lives in `title`,
 * and a `title` nobody asserts is a `title` that silently becomes `undefined`
 * — which is exactly what the schema badge was doing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import type React from 'react';

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));

vi.mock('../../webview/hooks/useMessageBus', () => ({
  useMessageBus: () => ({ send: vi.fn() }),
  useSend: () => vi.fn(),
}));

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

vi.mock('../../webview/store/editorStore', () => ({
  useEditorStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

import { ModelNode } from '../../webview/components/Graph/ModelNode';
import type { ColumnDisplay, ModelFlowNode } from '../../webview/types/graph';
import { SCD_TITLE, ADDITIVE_TITLE } from '../../webview/lib/badgeLabels';

function renderNode(extra: Partial<ModelFlowNode['data']> = {}, columns?: ColumnDisplay[]) {
  const data: ModelFlowNode['data'] = {
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
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  return render(<Node data={data} selected={false} />);
}

describe('ModelNode schema badge tooltip', () => {
  it('names the database schema the abbreviation stands for', () => {
    const { container } = renderNode({ stage: 'physical', readOnly: true, schema: 'silver' });
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.textContent).toBe('SLV');
    expect(badge.getAttribute('aria-label')).toBe('Database schema: silver');
  });

  it('still explains itself when dbt has resolved no schema', () => {
    const { container } = renderNode();
    const badge = container.querySelector('.model-node__badge')!;

    expect(badge.className).toContain('model-node__badge--layer');
    expect(badge.getAttribute('aria-label')).toContain('no dbt schema resolved');
  });
});

describe('ModelNode column symbol tooltips', () => {
  const col = (extra: Partial<ColumnDisplay>): ColumnDisplay => ({
    name: 'status',
    dataType: 'string',
    isPrimaryKey: false,
    isForeignKey: false,
    isNaturalKey: false,
    ...extra,
  });

  it('spells out each SCD type rather than restating the number', () => {
    for (const scdType of [0, 1, 2]) {
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

describe('ModelNode comparison markers', () => {
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

describe('ModelNode header hover card', () => {
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
    expect(tip()!.textContent).toBe('Database schema: silver');

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
