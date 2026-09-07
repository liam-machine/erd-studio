// @vitest-environment jsdom
/**
 * ModelNode inline column editing — scdType / additiveType forwarding.
 *
 * Regression for H13: double-clicking a column name or data type on the canvas
 * and committing an edit must post an `updateColumn` payload that still carries
 * the column's SCD type and additive type, otherwise the host would treat them
 * as removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type React from 'react';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any import that transitively loads them
// ---------------------------------------------------------------------------

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));

vi.mock('../../webview/hooks/useMessageBus', () => ({
  useMessageBus: () => ({ send: mockSend }),
  useSend: () => mockSend,
}));

// React Flow handles need a provider; the node only needs them to render as nothing.
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Right: 'right', Bottom: 'bottom', Left: 'left' },
}));

// Replace the portal-based type picker with a button that picks a fixed type.
vi.mock('../../webview/components/common/DataTypeSelect', () => ({
  DataTypeSelect: ({ onChange }: { onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange('bigint')}>pick-bigint</button>
  ),
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

import { ModelNode } from '../../webview/components/Graph/ModelNode';
import type { ModelFlowNode, ColumnDisplay } from '../../webview/types/graph';

const scdColumn: ColumnDisplay = {
  name: 'customer_name',
  dataType: 'string',
  description: 'Customer display name',
  isPrimaryKey: false,
  isForeignKey: false,
  isNaturalKey: true,
  scdType: 2,
  additiveType: 'non-additive',
};

const plainColumn: ColumnDisplay = {
  name: 'created_at',
  dataType: 'timestamp',
  isPrimaryKey: false,
  isForeignKey: false,
  isNaturalKey: false,
};

function renderNode(columns: ColumnDisplay[]) {
  const data: ModelFlowNode['data'] = {
    modelName: 'dim_customer',
    stage: 'logical',
    layer: 'silver',
    columns,
    readOnly: false,
  };
  const Node = ModelNode as unknown as React.ComponentType<{ data: ModelFlowNode['data']; selected: boolean }>;
  return render(<Node data={data} selected={false} />);
}

function lastUpdateColumnPayload() {
  const calls = mockSend.mock.calls.filter((c) => c[0]?.type === 'updateColumn');
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0].payload as {
    modelName: string;
    oldColumnName: string;
    column: Record<string, unknown>;
  };
}

beforeEach(() => {
  mockSend.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelNode inline edit forwards scdType / additiveType', () => {
  it('inline rename keeps scdType and additiveType in the updateColumn payload', () => {
    renderNode([scdColumn]);

    fireEvent.doubleClick(screen.getByTitle('customer_name'));
    const input = screen.getByPlaceholderText('column_name');
    fireEvent.change(input, { target: { value: 'customer_display_name' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const payload = lastUpdateColumnPayload();
    expect(payload.modelName).toBe('dim_customer');
    expect(payload.oldColumnName).toBe('customer_name');
    expect(payload.column).toMatchObject({
      name: 'customer_display_name',
      dataType: 'string',
      isNaturalKey: true,
      scdType: 2,
      additiveType: 'non-additive',
    });
  });

  it('inline data-type change keeps scdType and additiveType in the updateColumn payload', () => {
    renderNode([scdColumn]);

    fireEvent.doubleClick(screen.getByText('string', { selector: '.model-node__col-type' }));
    fireEvent.click(screen.getByText('pick-bigint'));

    const payload = lastUpdateColumnPayload();
    expect(payload.column).toMatchObject({
      name: 'customer_name',
      dataType: 'bigint',
      scdType: 2,
      additiveType: 'non-additive',
    });
  });

  it('omits scdType and additiveType (rather than sending null) when the column has none', () => {
    renderNode([plainColumn]);

    fireEvent.doubleClick(screen.getByTitle('created_at'));
    const input = screen.getByPlaceholderText('column_name');
    fireEvent.change(input, { target: { value: 'created_ts' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const { column } = lastUpdateColumnPayload();
    expect(column.name).toBe('created_ts');
    // Omitted means "keep whatever is on disk"; null would mean "clear".
    expect(column).not.toHaveProperty('scdType');
    expect(column).not.toHaveProperty('additiveType');
  });
});
