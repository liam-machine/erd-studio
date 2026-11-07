// @vitest-environment jsdom
/**
 * The New Relationship dialog's defaults when a relationship is drawn by hand:
 * picking the target table preselects its single primary-key column, and an
 * empty source column takes the source table's column of the same name (any
 * case). A composite key gets no default; a drag prefill, edit mode and a
 * column the user already picked are never overwritten.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';

const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({ Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { useEditorStore } from '../../webview/store/editorStore';

const col = (name: string, isPrimaryKey = false) =>
  ({ name, dataType: 'string', description: '', isPrimaryKey, isForeignKey: false, isNaturalKey: false });

const MODELS = [
  { name: 'dim_customer', columns: [col('customer_id', true), col('name')] },
  { name: 'fct_order', columns: [col('order_id', true), col('Customer_ID'), col('order_date')] },
  { name: 'dim_date', columns: [col('date_id', true), col('order_date')] },
  { name: 'bridge', columns: [col('left_id', true), col('right_id', true)] },
];

const initial = useEditorStore.getState();

function setDiagram(relationships: unknown[] = []) {
  useEditorStore.setState({
    domain: {
      schemaVersion: 5, domain: 'd', layer: 'silver', stage: 'logical', description: '', readOnly: false, viewConfig: {},
      models: MODELS, relationships,
    } as never,
  });
}

const select = (id: string) => document.getElementById(id) as HTMLSelectElement;
const pick = (id: string, value: string) => fireEvent.change(select(id), { target: { value } });

beforeEach(() => {
  postMessage.mockClear();
  useEditorStore.setState(initial, true);
  setDiagram();
});
afterEach(cleanup);

describe('NewFkDialog defaults (create mode, opened from the toolbar)', () => {
  beforeEach(() => {
    useEditorStore.getState().setNewFkDialogOpen(true);
    render(<NewFkDialog />);
  });

  it('preselects the target table\'s single primary-key column', () => {
    pick('toModel', 'dim_customer');
    expect(select('toColumn').value).toBe('customer_id');
  });

  it('leaves the target column empty for a composite primary key', () => {
    pick('toModel', 'bridge');
    expect(select('toColumn').value).toBe('');
  });

  it('preselects the source column named like the target column, in the source table\'s spelling', () => {
    pick('fromModel', 'fct_order');
    pick('toModel', 'dim_customer');
    expect(select('toColumn').value).toBe('customer_id');
    expect(select('fromColumn').value).toBe('Customer_ID');
  });

  it('fills the source column when the source table is picked after the target', () => {
    pick('toModel', 'dim_customer');
    pick('fromModel', 'fct_order');
    expect(select('fromColumn').value).toBe('Customer_ID');
  });

  it('fills the source column from a target column picked by hand', () => {
    pick('fromModel', 'fct_order');
    pick('toModel', 'dim_date');
    // fct_order has no date_id: nothing to match yet.
    expect(select('fromColumn').value).toBe('');
    pick('toColumn', 'order_date');
    expect(select('fromColumn').value).toBe('order_date');
  });

  it('leaves the source column empty when the source table has no column of that name', () => {
    pick('fromModel', 'fct_order');
    pick('toModel', 'dim_date');
    expect(select('toColumn').value).toBe('date_id');
    expect(select('fromColumn').value).toBe('');
  });

  it('never overwrites a source column the user already picked', () => {
    pick('fromModel', 'fct_order');
    pick('fromColumn', 'order_date');
    pick('toModel', 'dim_customer');
    expect(select('toColumn').value).toBe('customer_id');
    expect(select('fromColumn').value).toBe('order_date');
  });

  it('gives a self-reference no source default (it would be the target column itself)', () => {
    pick('fromModel', 'dim_customer');
    pick('toModel', 'dim_customer');
    expect(select('toColumn').value).toBe('customer_id');
    expect(select('fromColumn').value).toBe('');
  });
});

describe('NewFkDialog defaults never override a prefill or an edit', () => {
  it('keeps a drag prefill exactly as dragged', () => {
    useEditorStore.getState().openFkDialogWithPrefill({
      fromModel: 'fct_order', fromColumn: 'order_date', toModel: 'dim_customer', toColumn: 'name',
    });
    render(<NewFkDialog />);
    expect(select('fromColumn').value).toBe('order_date');
    expect(select('toColumn').value).toBe('name');
  });

  it('keeps a prefill dropped on a table header (no target column) without filling one in', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_order', fromColumn: 'order_date', toModel: 'dim_customer' });
    render(<NewFkDialog />);
    expect(select('fromColumn').value).toBe('order_date');
    expect(select('toColumn').value).toBe('');
  });

  it('keeps the prefilled source column when the user changes the target table', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'fct_order', fromColumn: 'order_date', toModel: 'dim_date' });
    render(<NewFkDialog />);
    pick('toModel', 'dim_customer');
    expect(select('toColumn').value).toBe('customer_id');
    expect(select('fromColumn').value).toBe('order_date');
  });

  it('applies no default in edit mode', () => {
    setDiagram([{ fromModel: 'fct_order', fromColumn: 'Customer_ID', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }]);
    useEditorStore.getState().openFkDialogForEdit({
      fromModel: 'fct_order', fromColumn: 'Customer_ID', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one',
    });
    render(<NewFkDialog />);
    expect(select('fromColumn').value).toBe('Customer_ID');
    expect(select('toColumn').value).toBe('customer_id');
    act(() => { pick('toModel', 'dim_date'); });
    expect(select('toColumn').value).toBe('');
    expect(select('fromColumn').value).toBe('Customer_ID');
    act(() => { pick('fromModel', 'dim_customer'); });
    expect(select('fromColumn').value).toBe('');
  });
});
