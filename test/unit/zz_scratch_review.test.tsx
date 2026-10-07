// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';

const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));
const postMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({ useVsCodeApi: () => ({ postMessage }) }));

import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { ContextMenu } from '../../webview/components/ContextMenu/ContextMenu';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayColumn, DisplayDomain } from '../../src/types/display';

const col = (name: string, keys: { pk?: boolean } = {}): DisplayColumn => ({
  name, dataType: 'string', description: '', isPrimaryKey: keys.pk ?? false, isNaturalKey: false, isForeignKey: false,
});
const dom = {
  schemaVersion: 5, domain: 'sales', layer: 'gold', stage: 'logical', description: '',
  models: [
    { name: 'dim_customer', description: '', columns: [col('customer_key', { pk: true })] },
    { name: 'fct_order', description: '', columns: [col('order_key', { pk: true }), col('customer_key')] },
    { name: 'emp', description: '', columns: [col('emp_id', { pk: true }), col('manager_id')] },
    { name: 'a', description: '', columns: [col('x'), col('x2')] },
    { name: 'b', description: '', columns: [col('y')] },
  ],
  relationships: [], viewConfig: {}, readOnly: false, positionDraggable: true, relationshipHome: 'library',
} as unknown as DisplayDomain;
const primary = () => document.querySelector<HTMLButtonElement>('.new-fk-dialog__button--primary')!;
const text = () => document.querySelector('.new-fk-dialog')?.textContent ?? '';

beforeEach(() => {
  useEditorStore.getState().setDomain(dom);
  useEditorStore.setState({ newFkDialogOpen: false, fkDialogPrefill: null, fkDialogEditData: null });
});
afterEach(() => { cleanup(); send.mockClear(); postMessage.mockClear(); useEditorStore.getState().closeContextMenu(); });

describe('scratch', () => {
  it('m2m dim->fct changed to many->one via menu: dialog saves dim as many side in one click', () => {
    useEditorStore.getState().openEdgeContextMenu(10, 10, { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-many' } as never);
    render(<ReactFlowProvider><ContextMenu /><NewFkDialog /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Many → Many/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Many → One' }));
    console.log('DIALOG', text());
    console.log('disabled', primary().disabled, primary().textContent);
    fireEvent.click(primary());
    console.log(JSON.stringify(send.mock.calls));
  });

  it('self-ref m2m: menu change opens dialog which refuses', () => {
    useEditorStore.getState().openEdgeContextMenu(10, 10, { fromModel: 'emp', fromColumn: 'emp_id', toModel: 'emp', toColumn: 'manager_id', cardinality: 'many-to-many' } as never);
    render(<ReactFlowProvider><ContextMenu /><NewFkDialog /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: /Many → Many/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Many → One' }));
    console.log('SELF', useEditorStore.getState().newFkDialogOpen, text(), primary()?.disabled, postMessage.mock.calls.length);
  });

  it('markKey tick carries over to a different target column', () => {
    useEditorStore.getState().openFkDialogWithPrefill({ fromModel: 'b', fromColumn: 'y', toModel: 'a', toColumn: 'x' });
    render(<ReactFlowProvider><NewFkDialog /></ReactFlowProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'b has many rows per a' }));
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(document.querySelector('#toColumn')!, { target: { value: 'x2' } });
    console.log('AFTER COL CHANGE', text());
    fireEvent.click(screen.getByRole('button', { name: 'b has many rows per a' }));
    const cb = screen.getByRole('checkbox') as HTMLInputElement;
    console.log('checked', cb.checked, cb.parentElement?.textContent);
    fireEvent.click(primary());
    console.log(JSON.stringify(send.mock.calls));
  });
});
