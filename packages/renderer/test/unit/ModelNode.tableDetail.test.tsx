// @vitest-environment jsdom
/**
 * TableNode at each table detail level: the header only at `name`, the key
 * columns at `keys`, every column at `all`; the per-table button that opens
 * one table and the way back; a clean card when there is nothing to list; a
 * stub's own rule; the comparison rows; and the reorder handles, which show
 * only when the rows are the whole column list.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import type { TableDiscrepancy } from '@erd-studio/core';
import { TableNode } from '../../src/components/Graph/ModelNode';
import { CanvasEnvironmentProvider } from '../../src/host/canvasEnvironment';
import { countVisibleColumnRows, isBareTableBody } from '../../src/lib/nodeSizing';
import type { ColumnDisplay, TableFlowNode } from '../../src/types/graph';

afterEach(cleanup);

const col = (name: string, key: '' | 'pk' | 'fk' | 'nk' = ''): ColumnDisplay => ({
  name,
  dataType: 'string',
  isPrimaryKey: key === 'pk',
  isForeignKey: key === 'fk',
  isNaturalKey: key === 'nk',
});

const columns = [col('order_id', 'pk'), col('placed_at'), col('customer_id', 'fk'), col('amount'), col('order_number', 'nk'), col('notes')];

function renderNode(extra: Partial<TableFlowNode['data']> = {}, { selected = false, viewer = false } = {}) {
  const data: TableFlowNode['data'] = {
    modelName: 'fct_order',
    stage: 'logical',
    layer: 'gold',
    columns,
    isStub: false,
    ...extra,
  };
  const Node = TableNode as unknown as React.ComponentType<{ data: TableFlowNode['data']; selected: boolean }>;
  const utils = render(
    <CanvasEnvironmentProvider host={{ postMessage: noop }} viewer={viewer}>
      <Node data={data} selected={selected} />
    </CanvasEnvironmentProvider>,
  );
  const rows = () => [...utils.container.querySelectorAll('.model-node__column .model-node__col-name')].map((e) => e.textContent);
  // The rows the component draws are the rows the size estimate counts (the
  // comparison's "only in" rows aside, which the estimate has never counted).
  const bodyRows = utils.container.querySelectorAll('.model-node__columns > .model-node__column:not(.model-node__column--disc-missing), .model-node__columns > .model-node__expand-button').length;
  expect(bodyRows).toBe(countVisibleColumnRows(data));
  expect(utils.container.querySelector('.model-node__columns') === null).toBe(isBareTableBody(data));
  return { ...utils, rows, footer: () => utils.container.querySelector('.model-node__footer')!.textContent };
}

describe('TableNode table detail levels', () => {
  it('all: every column, no button', () => {
    const { rows, footer, container } = renderNode({ tableDetail: 'all' });
    expect(rows()).toEqual(columns.map((c) => c.name));
    expect(container.querySelector('.model-node__expand-button')).toBeNull();
    expect(footer()).toBe('6 columns');
  });

  it('keys: only the key columns in file order, the count of the rest, and a button to this table', () => {
    const onToggleExpansion = vi.fn();
    const { rows, footer } = renderNode({ tableDetail: 'keys', onToggleExpansion });
    expect(rows()).toEqual(['order_id', 'customer_id', 'order_number']);
    expect(footer()).toBe('3 of 6 columns');
    fireEvent.click(screen.getByRole('button', { name: 'Show all 6 columns' }));
    expect(onToggleExpansion).toHaveBeenCalledWith('fct_order');
  });

  it('name: two bands, the header and a footer that is the button to this table', () => {
    const onToggleExpansion = vi.fn();
    const { rows, footer, container } = renderNode({ tableDetail: 'name', grain: 'One row per order', onToggleExpansion });
    expect(rows()).toEqual([]);
    expect(container.querySelector('.model-node__header')!.textContent).toContain('fct_order');
    expect(container.querySelector('.model-node__grain')).not.toBeNull();
    expect(container.querySelector('.model-node__empty')).toBeNull();
    expect(container.querySelector('.model-node__columns')).toBeNull();
    expect(container.querySelector('.model-node__expand-button')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Show all 6 columns' });
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.className).toContain('model-node__footer--toggle');
    expect(toggle.getAttribute('title')).toBe('Show all 6 columns');
    expect(footer()).toContain('6 columns');
    expect(toggle.querySelector('.model-node__footer-chevron')!.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(toggle);
    expect(onToggleExpansion).toHaveBeenCalledWith('fct_order');
  });

  it.each([['keys', 'Show keys only'], ['name', 'Show name only']] as const)(
    '%s: an opened table shows every column and offers the way back',
    (tableDetail, label) => {
      const onToggleExpansion = vi.fn();
      const { rows, container } = renderNode({ tableDetail, isExpanded: true, onToggleExpansion });
      expect(rows()).toEqual(columns.map((c) => c.name));
      expect(container.querySelector('.model-node__columns--closed')).toBeNull();
      expect(container.querySelector('.model-node__footer')!.tagName).toBe('DIV');
      fireEvent.click(screen.getByRole('button', { name: label }));
      expect(onToggleExpansion).toHaveBeenCalledWith('fct_order');
    },
  );

  it('keys: a table with no key columns is a clean card that still says how many columns it has', () => {
    const { rows, footer, container } = renderNode({ tableDetail: 'keys', columns: [col('a'), col('b')] });
    expect(rows()).toEqual([]);
    expect(container.querySelector('.model-node__empty')).toBeNull();
    expect(container.querySelector('.model-node__columns--closed')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Show all 2 columns' })).toBeTruthy();
    expect(footer()).toBe('0 of 2 columns');
  });

  it('a table with no columns: "No columns" at keys, header and footer only at name', () => {
    const keys = renderNode({ tableDetail: 'keys', columns: [] });
    expect(keys.container.querySelector('.model-node__empty')!.textContent).toBe('No columns');
    keys.unmount();
    const name = renderNode({ tableDetail: 'name', columns: [] });
    expect(name.container.querySelector('.model-node__columns')).toBeNull();
    expect(name.footer()).toBe('0 columns');
    expect(name.container.querySelector('.model-node__footer')!.tagName).toBe('DIV');
    expect(name.container.querySelector('button')).toBeNull();
  });

  it('name: a file that cannot be read still shows its error', () => {
    renderNode({ tableDetail: 'name', columns: [], loadError: { kind: 'read' } });
    expect(screen.getByText("ERD Studio can't read this file.")).toBeTruthy();
  });

  it('a stub keeps its PK / NK rows at keys and all, and is header only at name', () => {
    for (const tableDetail of ['keys', 'all'] as const) {
      const { rows, footer, container, unmount } = renderNode({ tableDetail, isStub: true });
      expect(rows()).toEqual(['order_id', 'order_number']);
      expect(container.querySelector('.model-node__expand-button')).toBeNull();
      expect(footer()).toBe('2 key cols of 6');
      unmount();
    }
    const { rows, footer } = renderNode({ tableDetail: 'name', isStub: true });
    expect(rows()).toEqual([]);
    const toggle = screen.getByRole('button', { name: 'Show all 2 key columns' });
    expect(toggle.className).toContain('model-node__footer--toggle');
    expect(footer()).toContain('2 key cols of 6');
  });
});

describe('TableNode comparison rows at a level', () => {
  const discrepancy = {
    name: 'fct_order',
    status: 'matched',
    columns: [
      { name: 'order_id', status: 'matched' },
      { name: 'amount', status: 'type-mismatch', sourceDataType: 'string', targetDataType: 'number' },
      { name: 'shipped_at', status: 'missing', targetDataType: 'date' },
    ],
  } as unknown as TableDiscrepancy;
  const extra = { discrepancy, discrepancySourceStage: 'logical', discrepancyTargetStage: 'physical' } as const;

  it('all: the "only in" rows show; the footer counts the differences', () => {
    const { container, footer } = renderNode({ tableDetail: 'all', ...extra });
    expect(container.querySelector('.model-node__column--disc-missing')!.textContent).toContain('shipped_at');
    expect(footer()).toContain('2 diffs');
  });

  it.each(['keys', 'name'] as const)('%s: no "only in" rows until the table is opened; the footer still counts', (tableDetail) => {
    const closed = renderNode({ tableDetail, ...extra });
    expect(closed.container.querySelector('.model-node__column--disc-missing')).toBeNull();
    expect(closed.container.querySelector('.model-node__separator--disc')).toBeNull();
    expect(closed.footer()).toContain('2 diffs');
    // At name the footer is the button, and the count is still in it.
    expect(closed.container.querySelector('.model-node__footer')!.tagName).toBe(tableDetail === 'name' ? 'BUTTON' : 'DIV');
    closed.unmount();
    const opened = renderNode({ tableDetail, isExpanded: true, ...extra });
    expect(opened.container.querySelector('.model-node__column--disc-missing')).not.toBeNull();
  });
});

describe('TableNode reorder handles', () => {
  const handles = (c: HTMLElement) => c.querySelectorAll('.model-node__col-reorder-handle').length;

  it('show on a selected, editable table whose rows are every column', () => {
    expect(handles(renderNode({ tableDetail: 'all' }, { selected: true }).container)).toBe(6);
    cleanup();
    expect(handles(renderNode({ tableDetail: 'keys', isExpanded: true }, { selected: true }).container)).toBe(6);
    cleanup();
    // A table whose columns are all keys draws them all at the keys level.
    expect(handles(renderNode({ tableDetail: 'keys', columns: [col('a', 'pk'), col('b', 'fk')] }, { selected: true }).container)).toBe(2);
  });

  it('never show on a subset of the columns, where a row index is not a file index', () => {
    expect(handles(renderNode({ tableDetail: 'keys' }, { selected: true }).container)).toBe(0);
    cleanup();
    expect(handles(renderNode({ tableDetail: 'all', isStub: true }, { selected: true }).container)).toBe(0);
    cleanup();
    // The older bug: a stub with few keys and no level hid nothing, so it got handles with the wrong indexes.
    expect(handles(renderNode({ isStub: true }, { selected: true }).container)).toBe(0);
    cleanup();
    expect(handles(renderNode({ columns: Array.from({ length: 9 }, (_, i) => col(`c${i}`)) }, { selected: true }).container)).toBe(0);
  });
});

describe('TableNode with no level (as before the levels)', () => {
  const nine = Array.from({ length: 9 }, (_, i) => col(`c${i}`, i === 0 ? 'pk' : ''));

  it('shows the first five columns and "...and N more"', () => {
    const { rows, footer, container } = renderNode({ columns: nine });
    expect(container.querySelector('.model-node__footer')!.tagName).toBe('DIV');
    expect(rows()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
    expect(screen.getByRole('button', { name: '...and 4 more' }).getAttribute('title')).toBe('Show 4 more columns');
    expect(footer()).toBe('9 columns');
  });

  it('shows everything and "Show less" when expanded', () => {
    const { rows } = renderNode({ columns: nine, isExpanded: true });
    expect(rows()).toHaveLength(9);
    expect(screen.getByRole('button', { name: 'Show less' })).toBeTruthy();
  });
});
