// @vitest-environment jsdom
/**
 * The New Table and Add Existing Table dialogs hand over to each other:
 *  - New Table refuses a name the Table Library already has and offers to add
 *    that table instead, opening Add Existing Table with its search filled in;
 *  - Add Existing Table with nothing to add, and no dbt project, offers
 *    "New table".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const mockPostMessage = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
  getVsCodeApi: () => ({ postMessage: mockPostMessage, getState: vi.fn(), setState: vi.fn() }),
}));
vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { NewTableDialog } from '../../webview/components/NewModelDialog/NewModelDialog';
import { AddExistingTableDialog } from '../../webview/components/AddExistingModelDialog/AddExistingModelDialog';
import { useEditorStore } from '../../webview/store/editorStore';

const initial = useEditorStore.getState();
const BLANK = { id: 'blank', label: 'Blank', prefix: '', description: '', columns: [] };
const libraryRow = (name: string) => ({
  name, schema: '', description: '', columnCount: 3, source: 'logical' as const, sourcePath: `.erd-studio/tables/${name}.dbml`,
});

function renderBoth() {
  return render(<><NewTableDialog /><AddExistingTableDialog /></>);
}

beforeEach(() => {
  mockPostMessage.mockClear();
  useEditorStore.setState(initial, true);
  useEditorStore.setState({
    domain: {
      domain: 'd', layer: 'silver', stage: 'logical', readOnly: false, viewConfig: { positions: {} },
      models: [{ name: 'fct_order', columns: [] }], relationships: [],
    } as never,
    templates: [BLANK] as never,
  });
});
afterEach(cleanup);

describe('New Table → Add Existing Table', () => {
  const nameInput = () => document.getElementById('modelName') as HTMLInputElement;
  const offer = () => screen.queryByRole('button', { name: 'Add "dim_customer" from the Table Library' });

  it('offers the library table when the name is refused, and opens Add Existing Table searching for it', () => {
    useEditorStore.getState().setExistingModels([libraryRow('dim_customer'), libraryRow('dim_date')]);
    act(() => { useEditorStore.getState().setNewModelDialogOpen(true); });
    renderBoth();

    fireEvent.change(nameInput(), { target: { value: 'DIM_CUSTOMER' } });
    fireEvent.blur(nameInput());
    expect(screen.getByText(/already exists in the Table Library/)).toBeTruthy();
    fireEvent.click(offer()!);

    const s = useEditorStore.getState();
    expect(s.newModelDialogOpen).toBe(false);
    expect(s.addExistingModelDialogOpen).toBe(true);
    expect(s.addExistingModelDialogSearch).toBe('dim_customer');
    expect((screen.getByPlaceholderText('Search tables...') as HTMLInputElement).value).toBe('dim_customer');
    expect(screen.getByText('1 of 2')).toBeTruthy();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('makes no offer for a name that is free, or one already in this diagram', () => {
    useEditorStore.getState().setExistingModels([libraryRow('dim_customer')]);
    act(() => { useEditorStore.getState().setNewModelDialogOpen(true); });
    renderBoth();
    fireEvent.change(nameInput(), { target: { value: 'dim_new' } });
    expect(offer()).toBeNull();
    fireEvent.change(nameInput(), { target: { value: 'fct_order' } });
    fireEvent.blur(nameInput());
    expect(screen.getByText(/already exists in this diagram/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /from the Table Library/ })).toBeNull();
  });

  it('opens Add Existing Table with an empty search from anywhere else, and clears a search on close', () => {
    useEditorStore.getState().setExistingModels([libraryRow('dim_customer'), libraryRow('dim_date')]);
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true, 'dim_date'); });
    renderBoth();
    expect(screen.getByText('1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useEditorStore.getState().addExistingModelDialogSearch).toBe('');
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    expect((screen.getByPlaceholderText('Search tables...') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('2 of 2')).toBeTruthy();
  });
});

describe('Add Existing Table with nothing to add', () => {
  it('offers "New table" without a dbt project, swapping to the New Table dialog', () => {
    useEditorStore.setState({ logicalOnly: true });
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    renderBoth();
    expect(screen.getByText('No tables available to add.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New table' }));
    const s = useEditorStore.getState();
    expect(s.addExistingModelDialogOpen).toBe(false);
    expect(s.newModelDialogOpen).toBe(true);
    expect(screen.getByRole('heading', { name: 'New Table' })).toBeTruthy();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('keeps the dbt advice, and no button, in a dbt project', () => {
    act(() => { useEditorStore.getState().setAddExistingModelDialogOpen(true); });
    render(<AddExistingTableDialog />);
    expect(screen.getByText(/dbt compile/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New table' })).toBeNull();
  });
});
